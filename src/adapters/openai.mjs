import crypto from 'node:crypto';
import { UPSTREAM_URL, config, formatAccountLogName, formatAccountFullDesc } from '../config.mjs';
import { Logger } from '../core/logger.mjs';
import { AccountScheduler, sessionStickyMap } from '../core/scheduler.mjs';
import { buildOfficialUpstreamHeaders } from '../upstream/headers.mjs';
import {
  extractStructuredBizCode,
  formatOpenAIError,
  MODEL_FALLBACK_CODES,
  QUOTA_EXHAUSTED_CODES
} from '../upstream/errors.mjs';
import {
  formatMessagesForUpstream,
  applyModelCapabilityGuards,
  prepareUpstreamBody
} from '../upstream/payload.mjs';
import { fetchDetailedModels } from '../upstream/models.mjs';
import { recordApiCall } from '../core/metrics.mjs';

// ─── GET /v1/models (标准 OpenAI 模型列表) ──────────────────────────────────
export async function handleOpenAiModels(req, res) {
  const detailed = await fetchDetailedModels();
  const list = detailed.map(m => ({
    id: m.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: m.vendor || 'tencent-codebuddy',
    context_window: m.contextWindow?.defaultLength || m.maxInputTokens || 200000,
    max_output_tokens: m.maxOutputTokens || 8192
  }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ object: 'list', data: list }));
}

// ─── POST /v1/chat/completions (OpenAI 协议核心对话网关) ─────────────────────
export async function handleOpenAiChatCompletions(req, res, rawBody) {
  const startTime = Date.now();
  try {
    const payload = JSON.parse(rawBody);
    const isClientStream = Boolean(payload.stream);

    const sessionKey = req.headers['x-session-id'] || 
      crypto.createHash('md5').update(JSON.stringify(payload.messages?.slice(0, 2) || '')).digest('hex');

    let targetModel = payload.model || 'deepseek-v4.1-flash';

    Logger.info('CHAT', `收到 OpenAI 对话请求 [${targetModel}] (流式: ${isClientStream})`, {
      clientIp: req.socket.remoteAddress,
      toolsCount: payload.tools?.length || 0,
      messagesCount: payload.messages?.length || 0
    });

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

    const effort = payload.reasoning_effort || payload.reasoning?.effort;
    const isReasoningOff = effort === 'none' || effort === 'off' || payload.thinking?.type === 'disabled';

    if (upstreamPayload.model.includes('deepseek') || upstreamPayload.model.includes('hy')) {
      if (isReasoningOff) {
        upstreamPayload.thinking = { type: 'disabled' };
        upstreamPayload.reasoning_effort = 'none';
      } else {
        upstreamPayload.thinking = { type: 'enabled' };
        upstreamPayload.reasoning_effort = effort || 'high';
        upstreamPayload.reasoning = { effort: effort || 'high', summary: 'auto' };
      }
    }

    // 核心执行链路：支持网关全局指定账号/账号池轮询、模型限流自动换号续跑以及备用模型改道
    async function executeRequestChain(initialModel) {
      let curModel = initialModel;
      let attemptedUids = new Set();
      let modelFallbackTriggered = false;

      while (true) {
        // 1. 账号调度：由网关全局配置或账号池轮转决定，排除已在该模型下遭遇限流的账号
        const acc = AccountScheduler.selectAccount(curModel, sessionKey, {
          excludeUids: Array.from(attemptedUids)
        });

        if (!acc) {
          // 账号池所有账号在当前模型下均已受限，进入备用模型判断
          const isFallbackEnabled = config.modelFallbackEnabled !== false;
          const fallbackModel = isFallbackEnabled ? config.modelFallback?.[curModel] : null;

          if (fallbackModel && fallbackModel !== curModel && !modelFallbackTriggered) {
            Logger.warn('REROUTE', `账号池所有账号对模型 [${curModel}] 均已限流受限，自动触发模型降级至 [${fallbackModel}]`);
            curModel = fallbackModel;
            attemptedUids.clear();
            modelFallbackTriggered = true;
            continue;
          }

          return {
            ok: false,
            status: 429,
            errText: JSON.stringify({ error: { message: `All upstream accounts in the pool are rate-limited or busy for model [${curModel}].`, type: 'rate_limit_error', code: 'rate_limit_exceeded' } }),
            bizCode: ServerErrorCode.CraftRateLimit
          };
        }

        acc.inFlight = (acc.inFlight || 0) + 1;
        attemptedUids.add(acc.uid);

        try {
          upstreamPayload.model = curModel;
          const { body, isGzip } = prepareUpstreamBody(upstreamPayload);
          const headers = buildOfficialUpstreamHeaders(acc.accessToken, curModel, sessionKey, acc.uid, isGzip);

          let upstreamRes = await fetch(UPSTREAM_URL, {
            method: 'POST',
            headers,
            body
          });

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

            if (isModelLimit) {
              AccountScheduler.cooldownModel(acc.uid, curModel, 600, `Upstream Rate Limit (${bizCode || 429})`);
              if (sessionKey && sessionStickyMap.get(sessionKey)?.uid === acc.uid) {
                sessionStickyMap.delete(sessionKey);
              }

              // 核心特性：自动检测账号池中是否有其他可用账号继续执行相同模型
              const canFailoverAccount = config.accountFailoverEnabled !== false;
              const otherAcc = canFailoverAccount ? AccountScheduler.selectAccount(curModel, sessionKey, { excludeUids: Array.from(attemptedUids) }) : null;

              if (otherAcc) {
                Logger.warn('FAILOVER', `账号 [${formatAccountLogName(acc)}] 模型 [${curModel}] 触发限流，自动切换至账号池中可用账号 [${formatAccountLogName(otherAcc)}] 续跑该模型！`);
                continue; // 自动在下一个账号重试相同模型
              }

              // 账号池所有账号在当前模型下均受限，触发备用模型改道
              const isFallbackEnabled = config.modelFallbackEnabled !== false;
              const fallbackModel = isFallbackEnabled ? config.modelFallback?.[curModel] : null;
              if (fallbackModel && fallbackModel !== curModel && !modelFallbackTriggered) {
                Logger.warn('REROUTE', `账号池所有账号对模型 [${curModel}] 均已限流，自动改道至备用模型 [${fallbackModel}]`);
                curModel = fallbackModel;
                attemptedUids.clear();
                modelFallbackTriggered = true;
                continue;
              }
            } else if (QUOTA_EXHAUSTED_CODES.has(bizCode) || upstreamRes.status === 402) {
              AccountScheduler.cooldown(acc.uid, 86400, `Upstream Quota Exhausted (${bizCode})`);
              if (sessionKey && sessionStickyMap.get(sessionKey)?.uid === acc.uid) {
                sessionStickyMap.delete(sessionKey);
              }
              continue; // 切换其他账号
            } else if (upstreamRes.status === 401) {
              acc.status = 'unauthorized';
              Logger.error('AUTH', `账号 [${formatAccountLogName(acc)}] Token 已失效或被收回 (HTTP 401)`);
              continue; // 切换其他账号
            }

            return { ok: false, status: upstreamRes.status, errText, bizCode, acc };
          }

          return { ok: true, res: upstreamRes, model: curModel, acc };

        } catch (networkErr) {
          acc.inFlight = Math.max(0, acc.inFlight - 1);
          Logger.error('NETWORK', `请求账号 [${formatAccountLogName(acc)}] 网络异常: ${networkErr.message}`);
          continue; // 网络抖动，尝试下一个账号
        }
      }
    }

    const callResult = await executeRequestChain(targetModel);

    if (!callResult.ok) {
      recordApiCall({ model: targetModel, isSuccess: false });
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
      const decoder = new TextDecoder();
      let toolCallObserved = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const str = decoder.decode(value, { stream: true });
        if (str.includes('"tool_calls"')) toolCallObserved = true;
        res.write(str);
      }

      activeAcc.inFlight = Math.max(0, activeAcc.inFlight - 1);
      const latency = Date.now() - startTime;
      recordApiCall({
        accountUid: activeAcc?.uid,
        accountName: formatAccountLogName(activeAcc),
        model: callResult.model,
        isSuccess: true,
        inputTokens: Math.max(10, Math.round(rawBody.length / 4)),
        outputTokens: Math.max(1, Math.round(latency / 15))
      });
      Logger.info('CHAT', `流式输出完成 [${callResult.model}] 耗时 ${latency}ms (账号: [${formatAccountLogName(activeAcc)}], 是否含工具调用: ${toolCallObserved})`);
      return res.end();

    } else {
      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();

      let fullContent = '';
      let fullReasoning = '';
      let toolCallsMap = new Map();
      let finishReason = 'stop';
      let responseId = 'chatcmpl-' + crypto.randomUUID();
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
      recordApiCall({
        accountUid: activeAcc?.uid,
        accountName: formatAccountLogName(activeAcc),
        model: callResult.model,
        isSuccess: true,
        inputTokens: Math.max(10, Math.round(rawBody.length / 4)),
        outputTokens: Math.max(1, Math.round(fullContent.length / 4))
      });
      Logger.info('CHAT', `非流式回复完成 [${callResult.model}] 耗时 ${latency}ms (账号: [${formatAccountLogName(activeAcc)}], 结束原因: ${finishReason})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
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
          prompt_tokens: 0,
          completion_tokens: fullContent.length,
          total_tokens: fullContent.length
        }
      }));
    }
  } catch (err) {
    Logger.error('CHAT', `处理对话请求异常: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: err.message, type: 'api_error' } }));
  }
}
