import zlib from 'node:zlib';
import { Logger } from '../core/logger.mjs';

// ─── 针对腾讯上游 11-128 渠道指纹检测的语义等价清洗 ─────────────────────────
export function sanitizeChannelFingerprints(text, role) {
  if (typeof text !== 'string') return text;
  if (role !== 'system' && role !== 'developer' && role !== 'assistant') {
    return text;
  }

  text = text.replace(/(Tokens\s+prefixed\s+with\s+)@(\s+are\s+paths)/gi, '$1(at)$2');
  text = text.replace(/You\s+are\s+an\s+AI\s+agent\s+powered\s+by\s+DeepSeek[\s\u200B]+Harness\./gi, 'You are a helpful AI assistant.');
  text = text.replace(/You\s+are\s+a\s+coding\s+agent\s+powered\s+by\s+/gi, 'You are a coding agent running on ');
  text = text.replace(/DeepSeek[\s\u200B]+Harness\s+Web\s+GUI/gi, 'Web GUI');
  text = text.replace(/You\s+are\s+Claude\s+Code,\s+Anthropic's\s+official\s+CLI\s+tool\s+for\s+Claude\./gi, 'You are an interactive AI assistant for coding.');
  text = text.replace(/Default\s+branch\s+\(you\s+will\s+usually\s+use\s+this\s+for\s+PRs\)/gi, 'Default branch (you will usually use this for PRs)');
  text = text.replace(/DeepSeek[\s\u200B]+Harness/gi, 'DeepSeek-Harness');

  return text;
}

// 格式化消息体发往腾讯云上游
export function formatMessagesForUpstream(messages) {
  return messages.map(m => {
    let content = m.content ?? '';
    if (typeof content === 'string') {
      content = sanitizeChannelFingerprints(content, m.role);
    } else if (Array.isArray(content)) {
      content = content.map(part => {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          return { ...part, text: sanitizeChannelFingerprints(part.text, m.role) };
        }
        return part;
      });
    }

    const item = { role: m.role, content };
    if (m.tool_calls) item.tool_calls = m.tool_calls;
    if (m.role === 'tool') item.tool_call_id = m.tool_call_id;
    return item;
  });
}

// 官方模型能力前置守卫：自动剥离不支持工具/视觉模型的参数
export function applyModelCapabilityGuards(upstreamPayload, modelMeta) {
  if (!modelMeta) return upstreamPayload;

  if (modelMeta.supportsToolCall === false) {
    if (upstreamPayload.tools) {
      delete upstreamPayload.tools;
      delete upstreamPayload.tool_choice;
      Logger.info('GUARD', `模型 [${modelMeta.id}] 声明不支持工具调用，已前置剥离 tools 参数避免 400`);
    }
  }

  if (modelMeta.supportsImages === false && Array.isArray(upstreamPayload.messages)) {
    let flattened = false;
    upstreamPayload.messages = upstreamPayload.messages.map(m => {
      if (Array.isArray(m.content)) {
        flattened = true;
        const flatText = m.content.map(part => {
          if (part.type === 'text') return part.text;
          if (part.type === 'image_url') return `[图片附件: 当前模型 ${modelMeta.id} 不支持视觉识图]`;
          return '';
        }).filter(Boolean).join('\n');
        return { ...m, content: flatText };
      }
      return m;
    });
    if (flattened) {
      Logger.info('GUARD', `模型 [${modelMeta.id}] 声明不支持多模态视觉，已将图片附件安全扁平化为说明文本`);
    }
  }

  return upstreamPayload;
}

// 请求体 Gzip 压缩处理器 (对齐 package/dist-server GzipRequestProcessor 策略)
export function prepareUpstreamBody(payload) {
  const jsonStr = JSON.stringify(payload);
  if (jsonStr.length > 2048) {
    return {
      body: zlib.gzipSync(Buffer.from(jsonStr, 'utf8')),
      isGzip: true,
      originalLength: jsonStr.length
    };
  }
  return {
    body: jsonStr,
    isGzip: false,
    originalLength: jsonStr.length
  };
}
