import crypto from 'node:crypto';
import { UPSTREAM_URL, config } from '../config.mjs';
import { Logger } from '../core/logger.mjs';
import { AccountScheduler } from '../core/scheduler.mjs';
import { buildOfficialUpstreamHeaders } from '../upstream/headers.mjs';
import {
  extractStructuredBizCode,
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

// ─── POST /v1/messages 与 POST /messages (Anthropic 协议适配，供 Claude Code 使用) ─
export async function handleAnthropicMessages(req, res, rawBody) {
  const startTime = Date.now();
  try {
    const anthropicPayload = JSON.parse(rawBody);
    const isClientStream = Boolean(anthropicPayload.stream);

    let targetModel = anthropicPayload.model || 'deepseek-v4.1-flash';
    if (targetModel.includes('claude') || targetModel.includes('sonnet') || targetModel.includes('opus')) {
      targetModel = 'deepseek-v4.1-flash';
    }

    Logger.info('ANTHROPIC', `收到 Claude Code 协议请求 [${targetModel}] (流式: ${isClientStream})`, {
      clientIp: req.socket.remoteAddress,
      toolsCount: anthropicPayload.tools?.length || 0
    });

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

    const acc = AccountScheduler.selectAccount(targetModel);
    if (!acc) {
      Logger.warn('OVERLOAD', `无可用账号服务 [${targetModel}]`);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'All accounts busy or in cooldown' } }));
    }

    acc.inFlight = (acc.inFlight || 0) + 1;

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

    if (targetModel.includes('deepseek') || targetModel.includes('hy')) {
      upstreamPayload.thinking = { type: 'enabled' };
      upstreamPayload.reasoning_effort = 'high';
      upstreamPayload.reasoning = { effort: 'high', summary: 'auto' };
    }

    const sessionKey = req.headers['x-session-id'] || 
      crypto.createHash('md5').update(JSON.stringify(openAiMessages.slice(0, 2))).digest('hex');

    // 模型级限流与改道执行器 (对齐 package: 支持 Gzip 与 6003/6004/6007/6008 自动降级)
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

        Logger.error('ANTHROPIC', `上游报错 HTTP ${upstreamRes.status} (模型: ${curModel}, 业务码: ${bizCode || '无'})`, {
          code: bizCode,
          msg: parsedErr.msg || errText,
          account: acc.email
        });

        if (MODEL_FALLBACK_CODES.has(bizCode)) {
          AccountScheduler.cooldownModel(acc.uid, curModel, 600, `Upstream ${bizCode} Limit Exceeded`);
          const isFallbackEnabled = config.modelFallbackEnabled !== false;
          const fallback = isFallbackEnabled ? config.modelFallback?.[curModel] : null;

          if (fallback && fallback !== curModel && !isRetry) {
            Logger.warn('REROUTE', `Anthropic 协议: 账号 [${acc.email}] 模型 [${curModel}] 触发业务码 [${bizCode}]，自动改道至备用模型 [${fallback}]`);
            return await executeCall(fallback, true);
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
      return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: callResult.errText } }));
    }

    const upstreamRes = callResult.res;
    const actualModel = callResult.model;
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
      const decoder = new TextDecoder();
      let thinkingBlockStarted = false;
      let thinkingBlockStopped = false;
      let textBlockStarted = false;
      let textBlockStopped = false;
      let activeToolIndices = new Set();
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
            const delta = chunk.choices?.[0]?.delta;

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
              }
              if (thinkingBlockStarted && !thinkingBlockStopped) {
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'thinking_delta', thinking: reasoningText }
                })}\n\n`);
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
              }
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: textIdx,
                delta: { type: 'text_delta', text: delta.content }
              })}\n\n`);
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
                }
                if (tc.function?.arguments) {
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: idx,
                    delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
                  })}\n\n`);
                }
              }
            }
          } catch (_) {}
        }
      }

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

      const stopReason = activeToolIndices.size > 0 ? 'tool_use' : 'end_turn';
      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 20 }
      })}\n\n`);

      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      acc.inFlight = Math.max(0, acc.inFlight - 1);
      const latency = Date.now() - startTime;
      recordApiCall({
        model: actualModel,
        isSuccess: true,
        inputTokens: Math.max(10, Math.round(rawBody.length / 4)),
        outputTokens: Math.max(1, Math.round(latency / 15))
      });
      Logger.info('ANTHROPIC', `流式回复完成 [${actualModel}] 耗时 ${latency}ms (结束原因: ${stopReason})`);
      return res.end();

    } else {
      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let fullReasoning = '';
      let toolCallsMap = new Map();
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

      acc.inFlight = Math.max(0, acc.inFlight - 1);

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
      recordApiCall({
        model: actualModel,
        isSuccess: true,
        inputTokens: Math.max(10, Math.round(rawBody.length / 4)),
        outputTokens: Math.max(1, Math.round((fullContent.length + fullReasoning.length) / 4))
      });
      Logger.info('ANTHROPIC', `非流式完成 [${actualModel}] 耗时 ${latency}ms (结束原因: ${stopReason})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: contentBlocks,
        model: actualModel,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 50 }
      }));
    }

  } catch (err) {
    Logger.error('ANTHROPIC', `处理请求异常: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } }));
  }
}
