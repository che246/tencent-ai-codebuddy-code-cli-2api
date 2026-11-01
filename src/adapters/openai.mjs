import crypto from 'node:crypto';
import { UPSTREAM_URL, config } from '../config.mjs';
import { Logger } from '../core/logger.mjs';
import { AccountScheduler } from '../core/scheduler.mjs';
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

    const acc = AccountScheduler.selectAccount(targetModel, sessionKey);
    if (!acc) {
      Logger.warn('OVERLOAD', `无可用账号服务模型 [${targetModel}]`);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'All upstream accounts are busy or cooling down for this model.', type: 'server_error' } }));
    }

    acc.inFlight = (acc.inFlight || 0) + 1;

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

    // 模型级限流改道与重试执行器 (对齐 package: 支持 Gzip 与 6003/6004/6007/6008 自动降级)
    async function executeCall(curModel, isRetry = false) {
      upstreamPayload.model = curModel;
      const { body, isGzip } = prepareUpstreamBody(upstreamPayload);
      const headers = buildOfficialUpstreamHeaders(acc.accessToken, curModel, sessionKey, acc.uid, isGzip);

      let upstreamRes = await fetch(UPSTREAM_URL, {
        method: 'POST',
        headers,
        body
      });

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text();
        let parsedErr = {};
        try { parsedErr = JSON.parse(errText); } catch (_) {}
        const bizCode = extractStructuredBizCode(parsedErr) || parsedErr.code;

        Logger.error('UPSTREAM', `上游报错 HTTP ${upstreamRes.status} (模型: ${curModel}, 业务码: ${bizCode || '无'})`, {
          code: bizCode,
          msg: parsedErr.msg || errText,
          account: acc.email
        });

        // 判断长窗口模型限流 (6003:TPH, 6004:TPD, 6007:RPH, 6008:RPD)
        if (MODEL_FALLBACK_CODES.has(bizCode)) {
          AccountScheduler.cooldownModel(acc.uid, curModel, 600, `Upstream ${bizCode} Limit Exceeded`);
          
          // 检查自动改道开关
          const isFallbackEnabled = config.modelFallbackEnabled !== false;
          const fallback = isFallbackEnabled ? config.modelFallback?.[curModel] : null;

          if (fallback && fallback !== curModel && !isRetry) {
            Logger.warn('REROUTE', `账号 [${acc.email}] 模型 [${curModel}] 触发业务码 [${bizCode}] 限量，自动无感改道至备用模型 [${fallback}]`);
            return await executeCall(fallback, true);
          } else if (!isFallbackEnabled) {
            Logger.warn('REROUTE', `账号 [${acc.email}] 模型 [${curModel}] 触发业务码 [${bizCode}] 限量 (改道开关已关闭，直接返回错误)`);
          }
        } else if (QUOTA_EXHAUSTED_CODES.has(bizCode)) {
          AccountScheduler.cooldown(acc.uid, 86400, `Upstream Quota Exhausted (${bizCode})`);
        }

        return { ok: false, status: upstreamRes.status, errText, bizCode };
      }
      return { ok: true, res: upstreamRes, model: curModel };
    }

    const callResult = await executeCall(targetModel);

    if (!callResult.ok) {
      acc.inFlight = Math.max(0, acc.inFlight - 1);
      recordApiCall({ model: targetModel, isSuccess: false });
      if (callResult.status === 429) {
        AccountScheduler.cooldown(acc.uid, 600, 'Upstream 429 Rate Limit');
      } else if (callResult.status === 402 || QUOTA_EXHAUSTED_CODES.has(callResult.bizCode)) {
        AccountScheduler.cooldown(acc.uid, 86400, 'Credits Exhausted');
      } else if (callResult.status === 401) {
        acc.status = 'unauthorized';
        Logger.error('AUTH', `账号 [${acc.email}] Token 已失效或被收回 (HTTP 401)`);
      }
      res.writeHead(callResult.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(formatOpenAIError(callResult.status, callResult.errText)));
    }

    const upstreamRes = callResult.res;

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

      acc.inFlight = Math.max(0, acc.inFlight - 1);
      const latency = Date.now() - startTime;
      recordApiCall({
        model: upstreamPayload.model,
        isSuccess: true,
        inputTokens: Math.max(10, Math.round(rawBody.length / 4)),
        outputTokens: Math.max(1, Math.round(latency / 15))
      });
      Logger.info('CHAT', `流式输出完成 [${upstreamPayload.model}] 耗时 ${latency}ms (是否含工具调用: ${toolCallObserved})`);
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

      acc.inFlight = Math.max(0, acc.inFlight - 1);

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
        model: upstreamPayload.model,
        isSuccess: true,
        inputTokens: Math.max(10, Math.round(rawBody.length / 4)),
        outputTokens: Math.max(1, Math.round(fullContent.length / 4))
      });
      Logger.info('CHAT', `非流式回复完成 [${upstreamPayload.model}] 耗时 ${latency}ms (结束原因: ${finishReason})`);

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
