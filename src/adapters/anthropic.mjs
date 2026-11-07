import crypto from 'node:crypto';
import { endpointsFor, config, formatAccountLogName, formatAccountFullDesc, isModelBlacklisted, isStepUnavailableByBlacklist } from '../config.mjs';
import { Logger } from '../core/logger.mjs';
import { AccountScheduler, sessionStickyMap } from '../core/scheduler.mjs';
import { buildOfficialUpstreamHeaders } from '../upstream/headers.mjs';
import {
  extractStructuredBizCode,
  MODEL_FALLBACK_CODES,
  QUOTA_EXHAUSTED_CODES,
  ServerErrorCode
} from '../upstream/errors.mjs';
import {
  formatMessagesForUpstream,
  applyModelCapabilityGuards,
  applyReasoningParams,
  ensureLeadingSystemMessage,
  parseModelRegion,
  prepareUpstreamBody
} from '../upstream/payload.mjs';
import { fetchDetailedModels } from '../upstream/models.mjs';
import { recordApiCall } from '../core/metrics.mjs';
import {
  createUpstreamLifecycle,
  readUpstreamStream,
  startHeartbeat,
  isTruncatedWithoutFinish,
  createDeltaClassifier,
  logStreamOutcome
} from '../upstream/stream-guard.mjs';

// ─── POST /v1/messages 与 POST /messages (Anthropic 协议适配，供 Claude Code 使用) ─
export async function handleAnthropicMessages(req, res, rawBody) {
  const startTime = Date.now();
  try {
    const anthropicPayload = JSON.parse(rawBody);
    const isClientStream = Boolean(anthropicPayload.stream);

    // 模型名可带区域前缀（cn: / intl:），剥掉后作为上游真实模型名，前缀用于锁定账号区域
    const parsedModel = parseModelRegion(anthropicPayload.model || 'deepseek-v4.1-flash');
    let targetModel = parsedModel.bare || 'deepseek-v4.1-flash';
    const forcedRegion = parsedModel.region;

    if (targetModel.includes('claude') || targetModel.includes('sonnet') || targetModel.includes('opus')) {
      targetModel = 'deepseek-v4.1-flash';
    }

    if (forcedRegion) {
      Logger.info('ANTHROPIC', `模型名带区域前缀，已锁定区域 [${forcedRegion}]，实际上游模型: ${targetModel}`);
    }

    // 黑名单拦截：与 /v1/models 保持一致，禁用的模型不允许被硬编码调用
    if (isModelBlacklisted(anthropicPayload.model || targetModel, targetModel, forcedRegion)) {
      Logger.warn('ANTHROPIC', `模型 [${anthropicPayload.model || targetModel}] 命中黑名单，已拒绝请求`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'permission_error',
          message: `Model "${anthropicPayload.model || targetModel}" is disabled by the gateway administrator (blacklisted).`
        }
      }));
    }

    Logger.info('ANTHROPIC', `收到 Claude Code 协议请求 [${targetModel}] (流式: ${isClientStream})`, {
      clientIp: req.socket.remoteAddress,
      toolsCount: anthropicPayload.tools?.length || 0
    });

    // 流式稳定性：首字节超时 + 客户端断开感知 + 静默看门狗
    const lifecycle = createUpstreamLifecycle(req, res, `anthropic:${targetModel}`);

    const openAiMessages = [];
    if (anthropicPayload.system) {
      const sysContent = typeof anthropicPayload.system === 'string'
        ? anthropicPayload.system
        : Array.isArray(anthropicPayload.system) ? anthropicPayload.system.map(s => s.text).join('\n') : '';
      if (sysContent) {
        openAiMessages.push({ role: 'system', content: sysContent });
      }
    }

    for (const m of (anthropicPayload.messages || [])) {
      if (typeof m.content === 'string') {
        openAiMessages.push({ role: m.role, content: m.content });
      } else if (Array.isArray(m.content)) {
        let textParts = [];
        let toolCalls = [];
        let toolResults = [];

        for (const b of m.content) {
          if (b.type === 'text') {
            textParts.push(b.text);
          } else if (b.type === 'image' && b.source?.data) {
            textParts.push({
              type: 'image_url',
              image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` }
            });
          } else if (b.type === 'tool_use') {
            toolCalls.push({
              id: b.id,
              type: 'function',
              function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
            });
          } else if (b.type === 'tool_result') {
            toolResults.push({
              role: 'tool',
              tool_call_id: b.tool_use_id,
              content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '')
            });
          }
        }

        if (textParts.length > 0 || toolCalls.length > 0) {
          const msgObj = { role: m.role, content: textParts.length === 1 && typeof textParts[0] === 'string' ? textParts[0] : textParts };
          if (toolCalls.length > 0) msgObj.tool_calls = toolCalls;
          openAiMessages.push(msgObj);
        }
        if (toolResults.length > 0) {
          openAiMessages.push(...toolResults);
        }
      }
    }

    const openAiTools = [];
    if (Array.isArray(anthropicPayload.tools)) {
      for (const t of anthropicPayload.tools) {
        openAiTools.push({
          type: 'function',
          function: {
            name: t.name,
            description: t.description || '',
            parameters: t.input_schema || { type: 'object', properties: {} }
          }
        });
      }
    }

    let upstreamPayload = {
      model: targetModel,
      messages: formatMessagesForUpstream(openAiMessages),
      stream: true,
      temperature: anthropicPayload.temperature ?? 1.0,
      max_tokens: anthropicPayload.max_tokens,
      stream_options: { include_usage: true },
      cache_retention: 'long'
    };

    if (openAiTools.length > 0) {
      upstreamPayload.tools = openAiTools;
    }

    const allMeta = await fetchDetailedModels();
    const modelMeta = allMeta.find(m => m.id === targetModel);
    upstreamPayload = applyModelCapabilityGuards(upstreamPayload, modelMeta);

    // 推理参数规整：把 Anthropic 的 thinking / budget_tokens 映射成官方上游的平铺字段，
    // 客户端显式值优先，缺省才用官方默认；不发 thinking / reasoning 嵌套对象。
    const anthThinking = anthropicPayload.thinking;
    let anthEffort;
    if (anthThinking && typeof anthThinking === 'object') {
      if (anthThinking.type === 'disabled') {
        anthEffort = 'none';
      } else if (anthThinking.type === 'enabled') {
        // budget_tokens → effort 档位映射（对齐官方 EXTENDED_THINKING_LEVELS）
        const budget = Number(anthThinking.budget_tokens) || 0;
        if (budget <= 0) anthEffort = 'high';
        else if (budget < 2048) anthEffort = 'minimal';
        else if (budget < 8192) anthEffort = 'low';
        else if (budget < 16384) anthEffort = 'medium';
        else if (budget < 32768) anthEffort = 'high';
        else anthEffort = 'xhigh';
      }
    } else if (typeof anthThinking === 'boolean') {
      anthEffort = anthThinking ? 'high' : 'none';
    }

    upstreamPayload = applyReasoningParams(
      upstreamPayload,
      {
        reasoning_effort: anthropicPayload.reasoning_effort || anthEffort,
        verbosity: anthropicPayload.verbosity,
        reasoning_summary: anthropicPayload.reasoning_summary
      },
      modelMeta
    );

    const sessionKey = req.headers['x-session-id'] || 
      crypto.createHash('md5').update(JSON.stringify(openAiMessages.slice(0, 2))).digest('hex');

    // 核心执行链路：支持多级备用模型降级链 (A -> B -> C -> ...) + 账号池多账号自愈轮换
    // 降级链中的每个模型都可以带区域前缀（cn: / intl:），未带前缀时继承主模型区域
    async function executeRequestChain(initialModel) {
      const isFallbackEnabled = config.modelFallbackEnabled !== false;
      const candidateSteps = [{ model: initialModel, region: forcedRegion }];
      const chainKeySeen = new Set([`${forcedRegion || ''}:${initialModel}`]);

      if (isFallbackEnabled && config.modelFallback) {
        const lookupKeys = [
          forcedRegion ? `${forcedRegion}:${initialModel}` : null,
          initialModel,
        ].filter(Boolean);

        let raw = null;
        for (const k of lookupKeys) {
          const v = config.modelFallback[k];
          if (v) { raw = v; break; }
        }

        const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
        for (const item of list) {
          if (!item || typeof item !== 'string') continue;
          const parsed = parseModelRegion(item.trim());
          if (!parsed.bare) continue;
          const stepRegion = parsed.region || forcedRegion || null;
          const sig = `${stepRegion || ''}:${parsed.bare}`;
          if (chainKeySeen.has(sig)) continue;
          chainKeySeen.add(sig);
          // 黑名单：禁用模型不参与自动降级轮换
          if (isStepUnavailableByBlacklist(parsed.bare, stepRegion)) {
            Logger.warn('REROUTE', `Anthropic 协议: 备用模型 [${item.trim()}] 命中黑名单，已从降级链中剔除`);
            continue;
          }
          candidateSteps.push({ model: parsed.bare, region: stepRegion });
        }
      }

      let modelIndex = 0;

      while (modelIndex < candidateSteps.length) {
        const step = candidateSteps[modelIndex];
        const curModel = step.model;
        const curRegion = step.region;
        const curLabel = curRegion ? `${curRegion}:${curModel}` : curModel;
        let attemptedUids = new Set();

        while (true) {
          // 1. 账号调度：在当前模型 curModel 下选择未在该模型尝试过的账号
          const acc = AccountScheduler.selectAccount(curModel, sessionKey, {
            excludeUids: Array.from(attemptedUids),
            region: curRegion
          });

          if (!acc) {
            // 账号池所有账号在当前模型 curModel 下均已受限
            if (modelIndex + 1 < candidateSteps.length) {
              const nextStep = candidateSteps[modelIndex + 1];
              const nextModel = nextStep.region ? `${nextStep.region}:${nextStep.model}` : nextStep.model;
              Logger.warn('REROUTE', `Anthropic 协议: 账号池所有账号对模型 [${curLabel}] 均已限流，自动降级切换至下一个备用模型 [${nextModel}] (${modelIndex + 1}/${candidateSteps.length - 1})`);
              modelIndex++;
              break; // 跳出账号内循环，进入下一个备选模型
            }

            // 整个降级链所有模型均已尝试且全池账号均已耗尽受限
            return {
              ok: false,
              status: 429,
              errText: JSON.stringify({ error: { message: `All upstream accounts and fallback models in the chain ([${candidateSteps.map(s => s.region ? `${s.region}:${s.model}` : s.model).join(' -> ')}]) are rate-limited or busy.`, type: 'rate_limit_error', code: 'rate_limit_exceeded' } }),
              bizCode: ServerErrorCode.CraftRateLimit
            };
          }

          acc.inFlight = (acc.inFlight || 0) + 1;
          attemptedUids.add(acc.uid);

          try {
            upstreamPayload.model = curModel;
            // 国际版要求首条消息必须是 system，缺则补一条（国内版不受影响）
            upstreamPayload.messages = ensureLeadingSystemMessage(upstreamPayload.messages, acc.region);
            const { body, isGzip } = prepareUpstreamBody(upstreamPayload);
            const headers = buildOfficialUpstreamHeaders(acc.accessToken, curModel, sessionKey, acc.uid, isGzip);

            // 按账号所属区域选择上游（国内 / 国际），端点结构完全一致
            const ep = endpointsFor(acc);
            let upstreamRes = await fetch(ep.upstream, {
              method: 'POST',
              headers,
              body,
              // 首字节超时 + 客户端断开由 lifecycle 的 AbortController 兜住
              signal: lifecycle.signal
            });
            lifecycle.markFirstByte();

            if (!upstreamRes.ok) {
              acc.inFlight = Math.max(0, acc.inFlight - 1);
              const errText = await upstreamRes.text();
              let parsedErr = {};
              try { parsedErr = JSON.parse(errText); } catch (_) {}
              const bizCode = extractStructuredBizCode(parsedErr) || parsedErr.code;

              Logger.error('ANTHROPIC', `上游报错 HTTP ${upstreamRes.status} (账号: [${formatAccountLogName(acc)}], 模型: [${curModel}], 业务码: ${bizCode || '无'})`, {
                code: bizCode,
                msg: parsedErr.msg || errText,
                account: formatAccountLogName(acc)
              });

              // 判断是否为模型限流 (6003:TPH, 6004:TPD, 6007:RPH, 6008:RPD, 429)
              const isModelLimit = MODEL_FALLBACK_CODES.has(bizCode) || upstreamRes.status === 429 || bizCode === ServerErrorCode.RateLimitError;

              if (isModelLimit) {
                AccountScheduler.cooldownModel(acc.uid, curModel, 600, `Upstream Rate Limit (${bizCode || 429})`);
                if (sessionKey && sessionStickyMap.get(sessionKey)?.uid === acc.uid) {
                  sessionStickyMap.delete(sessionKey);
                }

                // 1) 优先：检查账号池中是否有其他可用账号继续执行相同模型
                const canFailoverAccount = config.accountFailoverEnabled !== false;
                const otherAcc = canFailoverAccount ? AccountScheduler.selectAccount(curModel, sessionKey, { excludeUids: Array.from(attemptedUids) }) : null;

                if (otherAcc) {
                  const wasPinned = config.pinnedAccount && (
                    config.pinnedAccount === acc.uid ||
                    config.pinnedAccount === acc.email ||
                    (acc.note && config.pinnedAccount.toLowerCase() === acc.note.toLowerCase())
                  );
                  const failoverMsg = wasPinned
                    ? `Anthropic 协议: 全局指定账号 [${formatAccountLogName(acc)}] 遇到限制 (模型 [${curModel}] 限流)，已自动切换回账号池动态轮换，由账号 [${formatAccountLogName(otherAcc)}] 接力服务！`
                    : `Anthropic 协议: 账号 [${formatAccountLogName(acc)}] 模型 [${curModel}] 触发限流，自动切换至账号池中可用账号 [${formatAccountLogName(otherAcc)}] 续跑该模型！`;
                  Logger.warn('FAILOVER', failoverMsg);
                  continue; // 换账号重试当前模型
                }

                // 2) 账号池所有账号在当前模型下均受限：检查是否还有下一个备用模型
                if (modelIndex + 1 < candidateSteps.length) {
                  const nextStep = candidateSteps[modelIndex + 1];
                  const nextModel = nextStep.region ? `${nextStep.region}:${nextStep.model}` : nextStep.model;
                  Logger.warn('REROUTE', `Anthropic 协议: 账号池所有账号对模型 [${curLabel}] 均已限流，自动降级切换至下一个备用模型 [${nextModel}] (${modelIndex + 1}/${candidateSteps.length - 1})`);
                  modelIndex++;
                  break; // 跳出账号内循环，进入下一个备选模型
                }
              } else if (QUOTA_EXHAUSTED_CODES.has(bizCode) || upstreamRes.status === 402) {
                AccountScheduler.cooldown(acc.uid, 86400, `Upstream Quota Exhausted (${bizCode})`);
                if (sessionKey && sessionStickyMap.get(sessionKey)?.uid === acc.uid) {
                  sessionStickyMap.delete(sessionKey);
                }
                const wasPinned = config.pinnedAccount && (config.pinnedAccount === acc.uid || config.pinnedAccount === acc.email);
                if (wasPinned) {
                  Logger.warn('FAILOVER', `Anthropic 协议: 全局指定账号 [${formatAccountLogName(acc)}] 额度耗尽 (HTTP 402)，已自动切换回账号池动态轮换！`);
                }
                continue; // 切换其他账号
              } else if (upstreamRes.status === 401) {
                acc.status = 'unauthorized';
                Logger.error('AUTH', `账号 [${formatAccountLogName(acc)}] Token 已失效或被收回 (HTTP 401)`);
                const wasPinned = config.pinnedAccount && (config.pinnedAccount === acc.uid || config.pinnedAccount === acc.email);
                if (wasPinned) {
                  Logger.warn('FAILOVER', `Anthropic 协议: 全局指定账号 [${formatAccountLogName(acc)}] Token 失效 (HTTP 401)，已自动切换回账号池动态轮换！`);
                }
                continue; // 切换其他账号
              }

              return { ok: false, status: upstreamRes.status, errText, bizCode, acc };
            }

            return { ok: true, res: upstreamRes, model: curModel, acc };

          } catch (networkErr) {
            acc.inFlight = Math.max(0, acc.inFlight - 1);
            if (lifecycle.state.reason === 'client-gone') {
              Logger.info('STREAM', `[anthropic] 客户端已断开，停止重试`);
              return { ok: false, status: 499, errText: 'Client closed request', bizCode: 'CLIENT_GONE' };
            }
            if (lifecycle.state.reason === 'first-byte-timeout') {
              Logger.warn('NETWORK', `账号 [${formatAccountLogName(acc)}] 首字节超时，切换下一个账号`);
              continue;
            }
            Logger.error('NETWORK', `请求账号 [${formatAccountLogName(acc)}] 网络异常: ${networkErr.message}`);
            continue; // 网络抖动，尝试下一个账号
          }
        }
      }
    }

    const callResult = await executeRequestChain(targetModel);

    if (!callResult.ok) {
      recordApiCall({ model: targetModel, isSuccess: false });
      res.writeHead(callResult.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: callResult.errText } }));
    }

    const upstreamRes = callResult.res;
    const actualModel = callResult.model;
    const activeAcc = callResult.acc;
    const msgId = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);

    if (isClientStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: actualModel,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      })}\n\n`);

      const reader = upstreamRes.body.getReader();
      // Anthropic 协议发 `event: ping` 保活帧。模型长思考时上游可能几十秒
      // 不吐 reasoning/content，只发注释帧会被 Claude Code 判成流异常结束。
      const heartbeat = startHeartbeat(res, `anthropic:${actualModel}`, {
        protocol: 'anthropic',
        getMeta: () => ({ id: msgId, model: actualModel })
      });
      let thinkingBlockStarted = false;
      let thinkingBlockStopped = false;
      let textBlockStarted = false;
      let textBlockStopped = false;
      let activeToolIndices = new Set();
      let streamUsage = null;
      let buffer = '';
      let sawFinish = false;
      let sawError = false;
      let truncationEmitted = false;
      let keapalivePings = 0;
      // 与官方 CLI 同源的 delta 分类器（正文/思考/工具/拒答）
      const classifier = createDeltaClassifier();

      try {
        const result = await readUpstreamStream(reader, lifecycle, {
          label: `anthropic:${actualModel}`,
          onChunk: (str) => {
            if (res.writableEnded || res.destroyed) return;
            // 注意：这里不能调 heartbeat.touch()。思考型模型在上游持续吐
            // reasoning chunk，但只在映射出可见事件时才真正写给客户端；
            // 若在此处刷新计时器，保活帧将永远不会发出。
            buffer += str;
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const dataStr = trimmed.slice(5).trim();
              if (dataStr === '[DONE]') {
                // 上游话已说完：此后客户端挂断属正常收尾，不算「客户端断开」
                lifecycle.markUpstreamEnded();
                continue;
              }

              try {
                const chunk = JSON.parse(dataStr);
                if (chunk.usage) { streamUsage = chunk.usage; classifier.observeUsage(chunk.usage); }
                if (chunk.error) sawError = true;
                const choice = chunk.choices?.[0];
                // 与官方 CLI 同源的三标志分类
                classifier.observeDelta(choice?.delta, choice?.finish_reason);
                if (choice?.finish_reason) {
                  sawFinish = true;
                  lifecycle.markUpstreamEnded();
                }
                const delta = chunk.choices?.[0]?.delta;
                let wroteVisible = false;   // 本轮是否真的向客户端写了可见事件

            // 思考流原生映射 (对齐 package streamed-reasoning-collector: 兼容 reasoning_content 与 reasoning)
            const reasoningText = delta?.reasoning_content || delta?.reasoning;
            if (reasoningText) {
              if (!thinkingBlockStarted && !textBlockStarted) {
                thinkingBlockStarted = true;
                res.write(`event: content_block_start\ndata: ${JSON.stringify({
                  type: 'content_block_start',
                  index: 0,
                  content_block: { type: 'thinking', thinking: '' }
                })}\n\n`);
                wroteVisible = true;
              }
              if (thinkingBlockStarted && !thinkingBlockStopped) {
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'thinking_delta', thinking: reasoningText }
                })}\n\n`);
                wroteVisible = true;
              }
            }

            if (delta?.content) {
              if (thinkingBlockStarted && !thinkingBlockStopped) {
                thinkingBlockStopped = true;
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
              }
              const textIdx = thinkingBlockStarted ? 1 : 0;
              if (!textBlockStarted) {
                textBlockStarted = true;
                res.write(`event: content_block_start\ndata: ${JSON.stringify({
                  type: 'content_block_start',
                  index: textIdx,
                  content_block: { type: 'text', text: '' }
                })}\n\n`);
                wroteVisible = true;
              }
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: textIdx,
                delta: { type: 'text_delta', text: delta.content }
              })}\n\n`);
              wroteVisible = true;
            }

            if (Array.isArray(delta?.tool_calls)) {
              if (thinkingBlockStarted && !thinkingBlockStopped) {
                thinkingBlockStopped = true;
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
              }
              if (textBlockStarted && !textBlockStopped) {
                textBlockStopped = true;
                const textIdx = thinkingBlockStarted ? 1 : 0;
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: textIdx })}\n\n`);
              }
              const baseIndex = (thinkingBlockStarted ? 1 : 0) + (textBlockStarted ? 1 : 0);
              for (const tc of delta.tool_calls) {
                const idx = baseIndex + (tc.index ?? 0);
                if (!activeToolIndices.has(idx)) {
                  activeToolIndices.add(idx);
                  res.write(`event: content_block_start\ndata: ${JSON.stringify({
                    type: 'content_block_start',
                    index: idx,
                    content_block: {
                      type: 'tool_use',
                      id: tc.id || 'call_' + crypto.randomUUID().replace(/-/g, ''),
                      name: tc.function?.name || '',
                      input: {}
                    }
                  })}\n\n`);
                  wroteVisible = true;
                }
                if (tc.function?.arguments) {
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: idx,
                    delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
                  })}\n\n`);
                  wroteVisible = true;
                }
              }
            }

            // 只有真正写出可见事件时才重置保活计时器；
            // 纯 reasoning 但被丢弃的 chunk 不应阻止 ping 帧发出。
            if (wroteVisible) heartbeat.touch();
              } catch (_) {}
            }
          }
        });

        // ─── 收尾判定（对齐官方 CLI 的 emptyStreamKind 语义）──────────────
        // 有实质产出（正文/工具）但上游没给 finish_reason → 按截断补终态；
        // 完全没有实质产出 → 按空流补终态，并区分 reasoning-only / no-token。
        const emptyKind = classifier.emptyStreamKind;
        const needsClosing =
          !result.abortedByClient && !sawFinish && !sawError &&
          isTruncatedWithoutFinish({ sawDone: result.sawDone, sawFinish, sawError });
        if (needsClosing) {
          if (emptyKind) {
            Logger.warn('STREAM', `[anthropic:${actualModel}] 空流 ${emptyKind}（无实质产出）: finish_reason=${classifier.finishReason || 'unknown'}, 有思考=${classifier.hasReasoning}`);
          } else {
            Logger.warn('STREAM', `[anthropic:${actualModel}] 上游断流无 finish_reason，补截断终态`);
          }
          if (thinkingBlockStarted || textBlockStarted || activeToolIndices.size > 0 || emptyKind) {
            if (thinkingBlockStarted && !thinkingBlockStopped) {
              thinkingBlockStopped = true;
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
            }
            if (textBlockStarted && !textBlockStopped) {
              textBlockStopped = true;
              const textIdx = thinkingBlockStarted ? 1 : 0;
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: textIdx })}\n\n`);
            }
            for (const idx of activeToolIndices) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`);
            }
            // 官方把空流归一为 error/length；有实质内容被截断用 max_tokens，空流用 error
            const stopReason = emptyKind ? 'error' : 'max_tokens';
            res.write(`event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { output_tokens: streamUsage?.completion_tokens || 0 }
            })}\n\n`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
            // 已补齐终态帧，正常收尾路径不要再发一遍
            truncationEmitted = true;
          }
        }

        logStreamOutcome(`anthropic:${actualModel}`, result, { model: actualModel });
      } finally {
        // 无论成功/异常/客户端断开，都必须释放名额
        lifecycle.markFinished();
        activeAcc.inFlight = Math.max(0, activeAcc.inFlight - 1);
        heartbeat.stop();
        keapalivePings = heartbeat.pingCount || 0;
        lifecycle.dispose();
        try { reader.releaseLock?.(); } catch (_) {}
      }
      if (truncationEmitted) return;
      if (res.writableEnded || res.destroyed) return;

      if (thinkingBlockStarted && !thinkingBlockStopped) {
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
      }
      if (textBlockStarted && !textBlockStopped) {
        const textIdx = thinkingBlockStarted ? 1 : 0;
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: textIdx })}\n\n`);
      }
      for (const idx of activeToolIndices) {
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`);
      }

      const latency = Date.now() - startTime;
      const stopReason = activeToolIndices.size > 0 ? 'tool_use' : 'end_turn';
      const outTokens = streamUsage?.completion_tokens || Math.max(1, Math.round(latency / 15));
      const inTokens = streamUsage?.prompt_tokens || Math.max(10, Math.round(rawBody.length / 4));
      const cachedTok = streamUsage?.cache_read_input_tokens ||
                        streamUsage?.prompt_cache_hit_tokens ||
                        streamUsage?.prompt_tokens_details?.cached_tokens ||
                        streamUsage?.cached_tokens || 0;

      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outTokens, cache_read_input_tokens: cachedTok }
      })}\n\n`);

      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      lifecycle.markUpstreamEnded();
      recordApiCall({
        accountUid: activeAcc?.uid,
        accountName: formatAccountLogName(activeAcc),
        model: actualModel,
        isSuccess: true,
        inputTokens: inTokens,
        outputTokens: outTokens,
        cachedTokens: cachedTok
      });
      Logger.info('ANTHROPIC', `流式回复完成 [${actualModel}] 耗时 ${latency}ms (账号: [${formatAccountLogName(activeAcc)}], 缓存命中: ${cachedTok} tok, 结束原因: ${stopReason}${keapalivePings > 0 ? `, 思考保活: ${keapalivePings} 帧` : ''})`);
      if (!res.writableEnded) return res.end();
      return;

    } else {
      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let fullReasoning = '';
      let toolCallsMap = new Map();
      let streamUsage = null;
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(dataStr);
            if (chunk.usage) streamUsage = chunk.usage;
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) fullContent += delta.content;
            if (delta?.reasoning_content || delta?.reasoning) {
              fullReasoning += (delta.reasoning_content || delta.reasoning);
            }
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallsMap.has(idx)) {
                  toolCallsMap.set(idx, {
                    id: tc.id || 'call_' + crypto.randomUUID().replace(/-/g, ''),
                    name: tc.function?.name || '',
                    arguments: ''
                  });
                }
                const item = toolCallsMap.get(idx);
                if (tc.id) item.id = tc.id;
                if (tc.function?.name) item.name = tc.function.name;
                if (tc.function?.arguments) item.arguments += tc.function.arguments;
              }
            }
          } catch (_) {}
        }
      }

      activeAcc.inFlight = Math.max(0, activeAcc.inFlight - 1);

      const contentBlocks = [];
      if (fullReasoning) {
        contentBlocks.push({ type: 'thinking', thinking: fullReasoning });
      }
      if (fullContent) {
        contentBlocks.push({ type: 'text', text: fullContent });
      }
      for (const tc of toolCallsMap.values()) {
        let inputArgs = {};
        try { inputArgs = JSON.parse(tc.arguments || '{}'); } catch (_) {}
        contentBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: inputArgs
        });
      }

      const latency = Date.now() - startTime;
      const stopReason = toolCallsMap.size > 0 ? 'tool_use' : 'end_turn';
      const inTokens = streamUsage?.prompt_tokens || Math.max(10, Math.round(rawBody.length / 4));
      const outTokens = streamUsage?.completion_tokens || Math.max(1, Math.round((fullContent.length + fullReasoning.length) / 4));
      const cachedTok = streamUsage?.cache_read_input_tokens ||
                        streamUsage?.prompt_cache_hit_tokens ||
                        streamUsage?.prompt_tokens_details?.cached_tokens ||
                        streamUsage?.cached_tokens || 0;

      recordApiCall({
        accountUid: activeAcc?.uid,
        accountName: formatAccountLogName(activeAcc),
        model: actualModel,
        isSuccess: true,
        inputTokens: inTokens,
        outputTokens: outTokens,
        cachedTokens: cachedTok
      });
      Logger.info('ANTHROPIC', `非流式完成 [${actualModel}] 耗时 ${latency}ms (账号: [${formatAccountLogName(activeAcc)}], 缓存命中: ${cachedTok} tok, 结束原因: ${stopReason})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      lifecycle.markFinished();
      lifecycle.dispose();
      return res.end(JSON.stringify({
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: contentBlocks,
        model: actualModel,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: inTokens,
          output_tokens: outTokens,
          cache_read_input_tokens: cachedTok
        }
      }));
    }

  } catch (err) {
    Logger.error('ANTHROPIC', `处理请求异常: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } }));
  }
}
