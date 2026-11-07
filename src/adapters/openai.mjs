import crypto from 'node:crypto';
import { endpointsFor, config, formatAccountLogName, formatAccountFullDesc, isModelBlacklisted, isStepUnavailableByBlacklist } from '../config.mjs';
import { Logger } from '../core/logger.mjs';
import { AccountScheduler, sessionStickyMap } from '../core/scheduler.mjs';
import { buildOfficialUpstreamHeaders } from '../upstream/headers.mjs';
import {
  extractStructuredBizCode,
  formatOpenAIError,
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
  REGION_PREFIX,
  prepareUpstreamBody
} from '../upstream/payload.mjs';
import { fetchDetailedModels } from '../upstream/models.mjs';
import { recordApiCall } from '../core/metrics.mjs';
import {
  createUpstreamLifecycle,
  readUpstreamStream,
  startHeartbeat,
  isTruncatedWithoutFinish,
  buildTruncationChunk,
  logStreamOutcome
} from '../upstream/stream-guard.mjs';

// ─── GET /v1/models (标准 OpenAI 模型列表) ──────────────────────────────────
// 区域区分：直接在模型 ID 前加前缀
//   cn:<id>    仅国内版可用
//   intl:<id>  仅国际版可用
// 两区都有的模型会以两个条目分别给出（cn:xxx 与 intl:xxx），
// 调用方据此显式选择要走哪个区域，无需额外的筛选参数。
// 兼容：不带前缀的裸 ID 仍可正常调用（按账号池自动路由）。
export async function handleOpenAiModels(req, res) {
  const detailed = await fetchDetailedModels();

  const list = [];
  const seen = new Set();
  const now = Math.floor(Date.now() / 1000);
  let blockedCount = 0;

  for (const m of detailed) {
    const regions = Array.isArray(m.regions) && m.regions.length ? m.regions : ['cn'];
    // 每个可用区域各输出一条带前缀的条目
    for (const r of regions) {
      const id = `${REGION_PREFIX[r] || ''}${m.id}`;
      if (seen.has(id)) continue;
      // 黑名单：命中则完全不出现在列表中，客户端看不到也选不到
      if (isModelBlacklisted(id, m.id, r)) {
        blockedCount++;
        continue;
      }
      seen.add(id);
      list.push({
        id,
        object: 'model',
        created: now,
        owned_by: m.vendor || 'tencent-codebuddy',
        context_window: m.contextWindow?.defaultLength || m.maxInputTokens || 200000,
        max_output_tokens: m.maxOutputTokens || 8192,
        model: m.id,          // 裸模型名，便于客户端对照上游真实 ID
        region: r,
        region_label: r === 'intl' ? '国际版' : '国内版'
      });
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ object: 'list', total: list.length, data: list }));
}

// ─── POST /v1/chat/completions (OpenAI 协议核心对话网关) ─────────────────────
export async function handleOpenAiChatCompletions(req, res, rawBody) {
  const startTime = Date.now();
  try {
    const payload = JSON.parse(rawBody);
    const isClientStream = Boolean(payload.stream);

    const sessionKey = req.headers['x-session-id'] || 
      crypto.createHash('md5').update(JSON.stringify(payload.messages?.slice(0, 2) || '')).digest('hex');

    // 模型名可能带区域前缀（cn: / intl:），剥掉后作为实际上游模型名，
    // 前缀同时用于锁定账号区域，避免跨区选号导致 401。
    const parsedModel = parseModelRegion(payload.model || 'deepseek-v4.1-flash');
    let targetModel = parsedModel.bare || 'deepseek-v4.1-flash';
    const forcedRegion = parsedModel.region;

    if (forcedRegion) {
      Logger.info('CHAT', `模型名带区域前缀，已锁定区域 [${forcedRegion}]，实际上游模型: ${targetModel}`);
    }

    // 黑名单拦截：/v1/models 里看不到的模型，也不能被硬编码模型名直接调用。
    // 让黑名单成为真正的「网关级封禁」，而不只是列表隐藏。
    if (isModelBlacklisted(payload.model || targetModel, targetModel, forcedRegion)) {
      Logger.warn('CHAT', `模型 [${payload.model || targetModel}] 命中黑名单，已拒绝请求`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: {
          message: `Model "${payload.model || targetModel}" is disabled by the gateway administrator (blacklisted).`,
          type: 'permission_error',
          code: 'model_blacklisted'
        }
      }));
    }

    Logger.info('CHAT', `收到 OpenAI 对话请求 [${targetModel}] (流式: ${isClientStream})`, {
      clientIp: req.socket.remoteAddress,
      toolsCount: payload.tools?.length || 0,
      messagesCount: payload.messages?.length || 0
    });

    // 流式稳定性：首字节超时 + 客户端断开感知 + 静默看门狗
    const lifecycle = createUpstreamLifecycle(req, res, `openai:${targetModel}`);

    let upstreamPayload = {
      model: targetModel,
      messages: formatMessagesForUpstream(payload.messages || []),
      stream: true,
      temperature: payload.temperature ?? 1.0,
      max_tokens: payload.max_tokens,
      stream_options: { include_usage: true },
      cache_retention: typeof payload.cache_retention === 'string' ? payload.cache_retention : 'long'
    };

    if (Array.isArray(payload.tools) && payload.tools.length > 0) {
      upstreamPayload.tools = payload.tools;
      if (payload.tool_choice) {
        upstreamPayload.tool_choice = payload.tool_choice;
      }
    }

    const allMeta = await fetchDetailedModels();
    const modelMeta = allMeta.find(m => m.id === targetModel);
    upstreamPayload = applyModelCapabilityGuards(upstreamPayload, modelMeta);

    // 推理参数规整：客户端显式值优先，缺省才用官方默认；不发 thinking / reasoning 嵌套对象
    upstreamPayload = applyReasoningParams(upstreamPayload, payload, modelMeta);

    // 核心执行链路：支持多级备用模型降级链 (A -> B -> C -> ...) + 账号池多账号自愈轮换
    // 降级链中的每个模型都可以带区域前缀（cn: / intl:），
    // 未带前缀时继承主模型的区域（若有），否则按账号池自动路由。
    async function executeRequestChain(initialModel) {
      const isFallbackEnabled = config.modelFallbackEnabled !== false;
      // 链中每一项都是 { model: 裸模型名, region: 'cn'|'intl'|null }
      const candidateSteps = [{ model: initialModel, region: forcedRegion }];
      const chainKeySeen = new Set([`${forcedRegion || ''}:${initialModel}`]);

      if (isFallbackEnabled && config.modelFallback) {
        // 主模型可能带前缀，配置里也要同时查「带前缀」和「裸名」两种 key
        const lookupKeys = [
          parsedModel.region ? `${parsedModel.region}:${initialModel}` : null,
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
          // 备用模型没写区域时，跟随主模型区域，避免跨区降级导致 401
          const stepRegion = parsed.region || forcedRegion || null;
          const sig = `${stepRegion || ''}:${parsed.bare}`;
          if (chainKeySeen.has(sig)) continue;
          chainKeySeen.add(sig);
          // 黑名单：被禁用的模型不允许出现在自动轮换链里，
          // 否则用户屏蔽了某模型，降级时仍会被悄悄调用。
          if (isStepUnavailableByBlacklist(parsed.bare, stepRegion)) {
            Logger.warn('REROUTE', `备用模型 [${item.trim()}] 命中黑名单，已从降级链中剔除`);
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
              Logger.warn('REROUTE', `账号池所有账号对模型 [${curLabel}] 均已限流，自动降级切换至下一个备用模型 [${nextModel}] (${modelIndex + 1}/${candidateSteps.length - 1})`);
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

              Logger.error('UPSTREAM', `上游报错 HTTP ${upstreamRes.status} (账号: [${formatAccountLogName(acc)}], 模型: [${curModel}], 业务码: ${bizCode || '无'})`, {
                code: bizCode,
                msg: parsedErr.msg || errText,
                account: formatAccountLogName(acc)
              });

              // 判断是否为模型限流 (6003:TPH, 6004:TPD, 6007:RPH, 6008:RPD, 429)
              const isModelLimit = MODEL_FALLBACK_CODES.has(bizCode) || upstreamRes.status === 429 || bizCode === ServerErrorCode.RateLimitError;

              // 11158：当前用户类型无权使用该模型（如个人免费账号访问 GPT/Grok/Gemini）。
              // 换账号或换模型都无用，直接如实告知，并冷却该模型避免反复白试。
              if (bizCode === ServerErrorCode.ModelNotAllowed) {
                AccountScheduler.cooldownModel(acc.uid, curModel, 3600, `Model not allowed for user type (11158)`);
                Logger.warn('UPSTREAM', `账号 [${formatAccountLogName(acc)}] 无权使用模型 [${curModel}]（用户等级不足），已冷却 1 小时`);
                return {
                  ok: false,
                  status: 403,
                  errText: JSON.stringify({
                    error: {
                      message: `Model "${curModel}" is not available for this account's plan (upstream code 11158: ${parsedErr.msg || 'not allowed for user type'}).`,
                      type: 'permission_error',
                      code: 'model_not_allowed'
                    }
                  }),
                  bizCode
                };
              }

              if (isModelLimit) {
                AccountScheduler.cooldownModel(acc.uid, curModel, 600, `Upstream Rate Limit (${bizCode || 429})`);
                if (sessionKey && sessionStickyMap.get(sessionKey)?.uid === acc.uid) {
                  sessionStickyMap.delete(sessionKey);
                }

                // 1) 优先：检查账号池中是否有其他可用账号继续执行相同模型
                const canFailoverAccount = config.accountFailoverEnabled !== false;
                const otherAcc = canFailoverAccount ? AccountScheduler.selectAccount(curModel, sessionKey, { excludeUids: Array.from(attemptedUids), region: forcedRegion }) : null;

                if (otherAcc) {
                  const wasPinned = config.pinnedAccount && (
                    config.pinnedAccount === acc.uid ||
                    config.pinnedAccount === acc.email ||
                    (acc.note && config.pinnedAccount.toLowerCase() === acc.note.toLowerCase())
                  );
                  const failoverMsg = wasPinned
                    ? `全局指定账号 [${formatAccountLogName(acc)}] 遇到限制 (模型 [${curModel}] 限流)，已自动切换回账号池动态轮换，由账号 [${formatAccountLogName(otherAcc)}] 接力服务！`
                    : `账号 [${formatAccountLogName(acc)}] 模型 [${curModel}] 触发限流，自动切换至账号池中可用账号 [${formatAccountLogName(otherAcc)}] 续跑该模型！`;
                  Logger.warn('FAILOVER', failoverMsg);
                  continue; // 换账号重试当前模型
                }

                // 2) 账号池所有账号在当前模型下均受限：检查是否还有下一个备用模型
                if (modelIndex + 1 < candidateSteps.length) {
                  const nextStep = candidateSteps[modelIndex + 1];
                  const nextModel = nextStep.region ? `${nextStep.region}:${nextStep.model}` : nextStep.model;
                  Logger.warn('REROUTE', `账号池所有账号对模型 [${curLabel}] 均已限流，自动降级切换至下一个备用模型 [${nextModel}] (${modelIndex + 1}/${candidateSteps.length - 1})`);
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
                  Logger.warn('FAILOVER', `全局指定账号 [${formatAccountLogName(acc)}] 额度耗尽 (HTTP 402)，已自动切换回账号池动态轮换！`);
                }
                continue; // 切换其他账号
              } else if (upstreamRes.status === 401) {
                acc.status = 'unauthorized';
                Logger.error('AUTH', `账号 [${formatAccountLogName(acc)}] Token 已失效或被收回 (HTTP 401)`);
                const wasPinned = config.pinnedAccount && (config.pinnedAccount === acc.uid || config.pinnedAccount === acc.email);
                if (wasPinned) {
                  Logger.warn('FAILOVER', `全局指定账号 [${formatAccountLogName(acc)}] Token 失效 (HTTP 401)，已自动切换回账号池动态轮换！`);
                }
                continue; // 切换其他账号
              }

              return { ok: false, status: upstreamRes.status, errText, bizCode, acc };
            }

            return { ok: true, res: upstreamRes, model: curModel, acc };

          } catch (networkErr) {
            acc.inFlight = Math.max(0, acc.inFlight - 1);
            // 客户端主动断开 / 首字节超时：不是账号问题，不该换号重试，直接收敛
            if (lifecycle.state.reason === 'client-gone') {
              Logger.info('STREAM', `[openai] 客户端已断开，停止重试`);
              return { ok: false, status: 499, errText: JSON.stringify({ error: { message: 'Client closed request', type: 'client_closed' } }), bizCode: 'CLIENT_GONE' };
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
      lifecycle.markFinished();
      lifecycle.dispose();
      res.writeHead(callResult.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(formatOpenAIError(callResult.status, callResult.errText)));
    }

    const upstreamRes = callResult.res;
    const activeAcc = callResult.acc;

    if (isClientStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      const reader = upstreamRes.body.getReader();
      const heartbeat = startHeartbeat(res, `openai:${callResult.model}`);
      let toolCallObserved = false;
      let streamUsage = null;
      let sseBuffer = '';
      let sawFinish = false;
      let sawError = false;
      let lastChunkId = null;

      try {
        const result = await readUpstreamStream(reader, lifecycle, {
          label: `openai:${callResult.model}`,
          onChunk: (str) => {
            if (res.writableEnded || res.destroyed) return;
            res.write(str);
            heartbeat.touch();
            if (str.includes('"tool_calls"')) toolCallObserved = true;

            sseBuffer += str;
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop(); // 保留尚未结束的行片段

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
                if (chunk.id) lastChunkId = chunk.id;
                if (chunk.usage) streamUsage = chunk.usage;
                if (chunk.error) sawError = true;
                if (chunk.choices?.[0]?.finish_reason) {
                  sawFinish = true;
                  lifecycle.markUpstreamEnded();
                }
              } catch (_) {}
            }
          }
        });

        // 上游断流且已有产出：补一条截断终态，让客户端知道是被截断而非卡死
        if (!result.abortedByClient && !result.upstreamEnded && isTruncatedWithoutFinish({ sawDone: result.sawDone, sawFinish, sawError })) {
          if (toolCallObserved || sseBuffer.length > 0 || lastChunkId) {
            Logger.warn('STREAM', `[openai:${callResult.model}] 上游断流无 finish_reason，补截断终态`);
            try {
              res.write(`data: ${buildTruncationChunk(lastChunkId, callResult.model)}\n\n`);
              res.write('data: [DONE]\n\n');
            } catch (_) {}
          }
        }
        logStreamOutcome(`openai:${callResult.model}`, result, {
          model: callResult.model,
          toolCalls: toolCallObserved
        });
      } finally {
        // 无论成功/异常/客户端断开，都必须释放名额，杜绝 inFlight 泄漏
        lifecycle.markFinished();
        activeAcc.inFlight = Math.max(0, activeAcc.inFlight - 1);
        heartbeat.stop();
        lifecycle.dispose();
        try { reader.releaseLock?.(); } catch (_) {}
      }

      const latency = Date.now() - startTime;
      const inTokens = streamUsage?.prompt_tokens ?? Math.max(10, Math.round(rawBody.length / 4));
      const outTokens = streamUsage?.completion_tokens ?? Math.max(1, Math.round(latency / 15));
      const cachedTok = streamUsage?.prompt_cache_hit_tokens ??
                        streamUsage?.prompt_tokens_details?.cached_tokens ??
                        streamUsage?.cache_read_input_tokens ?? 0;

      recordApiCall({
        accountUid: activeAcc?.uid,
        accountName: formatAccountLogName(activeAcc),
        model: callResult.model,
        isSuccess: true,
        inputTokens: inTokens,
        outputTokens: outTokens,
        cachedTokens: cachedTok
      });
      Logger.info('CHAT', `流式输出完成 [${callResult.model}] 耗时 ${latency}ms (账号: [${formatAccountLogName(activeAcc)}], 缓存命中: ${cachedTok} tok, 是否含工具调用: ${toolCallObserved})`);
      if (!res.writableEnded) return res.end();
      return;

    } else {
      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();

      let fullContent = '';
      let fullReasoning = '';
      let toolCallsMap = new Map();
      let finishReason = 'stop';
      let responseId = 'chatcmpl-' + crypto.randomUUID();
      let nonStreamUsage = null;
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
            if (chunk.usage) nonStreamUsage = chunk.usage;
            responseId = chunk.id || responseId;
            const choice = chunk.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;
            if (delta?.content) fullContent += delta.content;
            if (delta?.reasoning_content || delta?.reasoning) fullReasoning += (delta.reasoning_content || delta.reasoning);

            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallsMap.has(idx)) {
                  toolCallsMap.set(idx, {
                    id: tc.id || 'call_' + crypto.randomUUID(),
                    type: 'function',
                    function: { name: tc.function?.name || '', arguments: '' }
                  });
                }
                const existing = toolCallsMap.get(idx);
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.function.name = tc.function.name;
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
              }
            }

            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }
          } catch (_) {}
        }
      }

      activeAcc.inFlight = Math.max(0, activeAcc.inFlight - 1);

      const assembledMessage = {
        role: 'assistant',
        content: fullContent || null
      };

      if (fullReasoning) {
        assembledMessage.reasoning_content = fullReasoning;
      }

      if (toolCallsMap.size > 0) {
        assembledMessage.tool_calls = Array.from(toolCallsMap.values());
        finishReason = 'tool_calls';
        Logger.info('TOOLS', `模型决定下发工具调用 (共 ${toolCallsMap.size} 个)`, {
          tools: Array.from(toolCallsMap.values()).map(t => t.function.name)
        });
      }

      const latency = Date.now() - startTime;
      const inTokens = nonStreamUsage?.prompt_tokens ?? Math.max(10, Math.round(rawBody.length / 4));
      const outTokens = nonStreamUsage?.completion_tokens ?? Math.max(1, Math.round(fullContent.length / 4));
      const cachedTok = nonStreamUsage?.prompt_cache_hit_tokens ??
                        nonStreamUsage?.prompt_tokens_details?.cached_tokens ??
                        nonStreamUsage?.cache_read_input_tokens ?? 0;

      recordApiCall({
        accountUid: activeAcc?.uid,
        accountName: formatAccountLogName(activeAcc),
        model: callResult.model,
        isSuccess: true,
        inputTokens: inTokens,
        outputTokens: outTokens,
        cachedTokens: cachedTok
      });
      Logger.info('CHAT', `非流式回复完成 [${callResult.model}] 耗时 ${latency}ms (账号: [${formatAccountLogName(activeAcc)}], 缓存命中: ${cachedTok} tok, 结束原因: ${finishReason})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      lifecycle.markFinished();
      lifecycle.dispose();
      return res.end(JSON.stringify({
        id: responseId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: upstreamPayload.model,
        choices: [{
          index: 0,
          message: assembledMessage,
          finish_reason: finishReason
        }],
        usage: {
          prompt_tokens: inTokens,
          completion_tokens: outTokens,
          total_tokens: inTokens + outTokens,
          prompt_tokens_details: {
            cached_tokens: cachedTok
          },
          prompt_cache_hit_tokens: cachedTok
        }
      }));
    }
  } catch (err) {
    Logger.error('CHAT', `处理对话请求异常: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: err.message, type: 'api_error' } }));
  }
}
