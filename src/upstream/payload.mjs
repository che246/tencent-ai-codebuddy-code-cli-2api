import zlib from 'node:zlib';
import { Logger } from '../core/logger.mjs';
import { normalizeRegion, resolveAccountRegion, REGION_INTL, getThinkingPolicy, getPromptPolicy, loadSystemPromptContent } from '../config.mjs';

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

// ─── 模型名区域前缀（cn: / intl:）──────────────────────────────────────────
// 用于 /v1/models 中区分同一模型的可调用区域，并在 chat 侧锁定账号区域。
export const REGION_PREFIX = { cn: 'cn:', intl: 'intl:' };

/** 剥掉模型名上的区域前缀，返回 { bare, region } */
export function parseModelRegion(modelId) {
  const s = String(modelId || '');
  if (s.startsWith(REGION_PREFIX.cn)) return { bare: s.slice(REGION_PREFIX.cn.length), region: 'cn' };
  if (s.startsWith(REGION_PREFIX.intl)) return { bare: s.slice(REGION_PREFIX.intl.length), region: 'intl' };
  return { bare: s, region: null };
}

// ─── 国际版 system prompt 兜底 ──────────────────────────────────────────────
// 实测（2026-11，www.codebuddy.ai）：国际版对 messages[0].role 有硬性校验，
// 首条不是 system 时直接 400 code=11128 "first message is not system prompt"。
// 国内版无此限制。为让同一条客户端请求在两端都能跑，国际版缺 system 时补一条空串。
export const DEFAULT_INTL_SYSTEM = '';

/**
 * 确保 messages 首条为 system（仅国际版需要）。
 * @param {Array} messages 已 formatMessagesForUpstream 处理过的消息数组
 * @param {string|object} regionOrAcc 区域字符串，或账号对象（自动推断）
 */
export function ensureLeadingSystemMessage(messages, regionOrAcc) {
  const region = typeof regionOrAcc === 'object' && regionOrAcc !== null
    ? resolveAccountRegion(regionOrAcc)
    : normalizeRegion(regionOrAcc);
  if (region !== REGION_INTL) return messages;
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const first = messages[0];
  if (first && first.role === 'system') return messages;
  // 首条已是非 system：国际版会拒绝，补一条占位 system 在最前
  return [{ role: 'system', content: DEFAULT_INTL_SYSTEM }, ...messages];
}

// ─── 系统提示词策略重写 ─────────────────────────────────────────────────────
/**
 * [网关自有策略] 应用系统提示词策略 (passthrough / custom / append)
 * @param {Array} messages 已 formatMessagesForUpstream 处理过的消息数组
 * @returns {Array} 重写后的消息数组
 */
export function applySystemPromptPolicy(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const { mode, file } = getPromptPolicy();
  if (mode === 'passthrough') {
    return messages;
  }

  const promptText = loadSystemPromptContent(file);
  if (!promptText || !promptText.trim()) {
    return messages;
  }

  if (mode === 'custom') {
    // 过滤掉原消息中所有的 system / developer 消息
    const nonSystem = messages.filter(m => m && m.role !== 'system' && m.role !== 'developer');
    // 在开头插入网关定制的系统提示词
    return [
      { role: 'system', content: promptText },
      ...nonSystem
    ];
  }

  if (mode === 'append') {
    // 扫描开头连续的 system / developer 消息块
    let insertAt = 0;
    for (const m of messages) {
      if (!m || (m.role !== 'system' && m.role !== 'developer')) {
        break;
      }
      insertAt++;
    }
    const customMsg = { role: 'system', content: promptText };
    return [
      ...messages.slice(0, insertAt),
      customMsg,
      ...messages.slice(insertAt)
    ];
  }

  return messages;
}

// ─── 推理参数规整 ───────────────────────────────────────────────────────────
// 对齐官方 CLI 实测行为（2.177.1 / 2.179.0）：
//   1. 官方只发平铺的 reasoning_effort / reasoning_summary / verbosity，
//      从不发 thinking / reasoning 这两个嵌套对象。
//   2. 客户端显式传入的值必须优先保留，不得被网关默认值覆盖。
//   3. 模型不支持推理（supportsReasoningEffort === false）时，按官方
//      ReasoningEffortSupportRule 剥离 reasoning_effort。
//   4. 网关思考档位策略（thinkingPolicy）：支持 client_first / gateway_level_only / gateway_override_all
//      以及逐模型覆盖与不高于所选档的最高支持档平滑 clamp。
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const EFFORT_RANK = {
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6
};

// 官方默认值（仅在客户端未指定时兜底，依据 CLI 2.179.0 实测）
export const DEFAULT_MAX_TOKENS = 128000;
const DEFAULT_EFFORT = 'high';
const DEFAULT_VERBOSITY = 'high';
const DEFAULT_SUMMARY = 'auto';

function pickClientEffort(payload) {
  const raw = payload.reasoning_effort
    ?? payload.reasoning?.effort
    ?? payload.thinkingLevel
    ?? payload.effort;
  return typeof raw === 'string' && raw ? raw : undefined;
}

function normalizeEffort(effort) {
  if (typeof effort !== 'string') return undefined;
  const v = effort.trim().toLowerCase();
  if (!v) return undefined;
  // off / none 都表示关闭思考，统一成官方能识别的 none
  if (v === 'off' || v === 'none' || v === 'disabled') return 'none';
  // 官方 EXTENDED_THINKING_LEVELS 之外的档位丢弃，交回默认值
  if (!THINKING_LEVELS.includes(v)) return undefined;
  return v;
}

function isThinkingDisabled(payload) {
  return payload.thinking?.type === 'disabled' || payload.enable_thinking === false;
}

function getModelSupportedEfforts(modelMeta) {
  if (!modelMeta) return null;
  const r = modelMeta.reasoning;
  if (Array.isArray(r?.supportedEfforts) && r.supportedEfforts.length > 0) {
    return r.supportedEfforts;
  }
  if (typeof r?.effort === 'string' && r.effort) {
    return [r.effort];
  }
  return null;
}

function getLowestEffort(supported) {
  if (!supported || supported.length === 0) return null;
  const sorted = [...supported].sort((a, b) => (EFFORT_RANK[a] || 99) - (EFFORT_RANK[b] || 99));
  return sorted[0];
}

/**
 * 将目标思考档位规范化并映射到模型支持的档位（不高于目标档位的最高支持档）。
 * @param {string} targetLevel 目标档位（如 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'）
 * @param {object|undefined} modelMeta 模型元数据
 * @returns {string} 适配模型后的 effort：'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
 */
export function clampThinkingLevel(targetLevel, modelMeta) {
  const norm = normalizeEffort(targetLevel) || 'high';

  // 1. 关闭思考 (off / none)
  if (norm === 'none') {
    const canDisable = modelMeta?.reasoning?.canDisableThinking !== false && !modelMeta?.onlyReasoning;
    if (canDisable) {
      return 'none';
    }
    // 强制思考的模型无法关闭思考，按规则"落到不高于它的最高支持档" -> 降到最低支持档
    const supported = getModelSupportedEfforts(modelMeta);
    return getLowestEffort(supported) || modelMeta?.reasoning?.defaultEffort || 'low';
  }

  // 2. 具体档位 (minimal ~ max)
  const supported = getModelSupportedEfforts(modelMeta);
  if (!supported || supported.length === 0) {
    return norm;
  }

  const targetRank = EFFORT_RANK[norm] || 4;
  // 找出所有 rank <= targetRank 的支持档
  const candidates = supported.filter(e => EFFORT_RANK[e] && EFFORT_RANK[e] <= targetRank);
  if (candidates.length > 0) {
    candidates.sort((a, b) => (EFFORT_RANK[b] || 0) - (EFFORT_RANK[a] || 0));
    return candidates[0];
  }

  // 若没有不高于 targetRank 的档位，落到最低支持档
  return getLowestEffort(supported) || norm;
}

/**
 * 获取模型的官方上游默认档位（对齐 CLI: normalizeReasoningEffort(el.reasoning?.defaultEffort) ?? normalizeReasoningEffort(el.reasoning?.effort)）
 * @param {object|undefined} modelMeta 模型能力元数据
 * @returns {string|undefined} 归一化后的上游默认档位（如 'high', 'medium', 'max' 等）
 */
export function getUpstreamDefaultEffort(modelMeta) {
  if (!modelMeta) return undefined;
  const raw = modelMeta.reasoning?.defaultEffort ?? modelMeta.reasoning?.effort;
  return normalizeEffort(raw);
}

/**
 * 把客户端推理参数规整成官方上游格式（客户端优先，缺省用官方默认值；或按网关思考策略改写）。
 * 档位解析核心优先级：客户端 > 上游默认 > 网关默认。
 * @param {object} upstreamPayload 待发送的上游请求体（会被就地修改）
 * @param {object} payload 客户端原始请求体
 * @param {object|undefined} modelMeta 模型能力元数据
 * @returns {object} upstreamPayload
 */
export function applyReasoningParams(upstreamPayload, payload, modelMeta) {
  // 官方规则 1：永远不发这两个嵌套对象
  delete upstreamPayload.thinking;
  delete upstreamPayload.reasoning;

  const supportsEffort = modelMeta ? modelMeta.supportsReasoningEffort !== false : true;

  // 模型明确不支持推理时，官方 ReasoningEffortSupportRule 会整体剥离
  if (!supportsEffort) {
    delete upstreamPayload.reasoning_effort;
    delete upstreamPayload.reasoning_summary;
    delete upstreamPayload.verbosity;
    return upstreamPayload;
  }

  const clientEffort = pickClientEffort(payload);
  const normalizedClient = normalizeEffort(clientEffort);
  const clientDisabled = isThinkingDisabled(payload) || normalizedClient === 'none';

  // 优先级体系：客户端 > 上游默认 > 网关默认（严格对齐 CodeBuddy CLI 源码）
  const upstreamDefault = getUpstreamDefaultEffort(modelMeta);
  const policy = getThinkingPolicy();
  const gatewayDefault = policy.defaultLevel || DEFAULT_EFFORT;

  let finalEffort;

  if (!policy.enabled) {
    // 未启用网关策略：遵循「客户端 > 上游默认 > 网关默认」
    if (clientDisabled) {
      finalEffort = 'none';
    } else if (normalizedClient) {
      finalEffort = clampThinkingLevel(normalizedClient, modelMeta);
    } else if (upstreamDefault) {
      finalEffort = clampThinkingLevel(upstreamDefault, modelMeta);
    } else {
      finalEffort = clampThinkingLevel(gatewayDefault, modelMeta);
    }
  } else {
    // 启用了网关思考档位策略
    const modelId = modelMeta?.id || payload?.model || upstreamPayload?.model;
    const modelOverride = modelId && policy.modelLevels?.[modelId];

    // 该模型的网关基准档位：若逐模型单独指定（非 default），使用单独指定档；
    // 否则遵循「上游默认 > 网关默认」
    const hasExplicitModelOverride = modelOverride && modelOverride !== 'default';
    const effectiveGatewayLevel = hasExplicitModelOverride
      ? modelOverride
      : (upstreamDefault || gatewayDefault);

    const mode = policy.overrideMode || 'client_first';

    if (mode === 'gateway_override_all') {
      // 模式 3：网关优先 · 档位与开关一起覆盖：连客户端「关闭思考」也改写成开启 + 「网关档位」
      finalEffort = clampThinkingLevel(effectiveGatewayLevel, modelMeta);
    } else if (mode === 'gateway_level_only') {
      // 模式 2：网关优先 · 只覆盖档位：客户端传的档位一律改写为「网关档位」，但尊重客户端「关闭思考」
      if (clientDisabled) {
        finalEffort = 'none';
      } else {
        finalEffort = clampThinkingLevel(effectiveGatewayLevel, modelMeta);
      }
    } else {
      // 模式 1：客户端优先（客户端 > 上游默认 > 网关默认）
      if (clientDisabled) {
        finalEffort = 'none';
      } else if (normalizedClient) {
        // 客户端显式指定档位优先
        finalEffort = clampThinkingLevel(normalizedClient, modelMeta);
      } else {
        // 客户端未传档位：单独配置优先，否则「上游默认 > 网关默认」
        finalEffort = clampThinkingLevel(effectiveGatewayLevel, modelMeta);
      }
    }
  }

  if (finalEffort === 'none') {
    upstreamPayload.reasoning_effort = 'none';
  } else if (finalEffort) {
    upstreamPayload.reasoning_effort = finalEffort;
  } else {
    upstreamPayload.reasoning_effort = DEFAULT_EFFORT;
  }

  // verbosity / reasoning_summary：客户端优先，缺省用官方默认值
  const clientVerbosity = typeof payload.verbosity === 'string' && payload.verbosity.trim()
    ? payload.verbosity.trim()
    : typeof payload.text?.verbosity === 'string' && payload.text.verbosity.trim()
      ? payload.text.verbosity.trim()
      : undefined;
  upstreamPayload.verbosity = clientVerbosity || DEFAULT_VERBOSITY;

  const clientSummary = typeof payload.reasoning_summary === 'string' && payload.reasoning_summary.trim()
    ? payload.reasoning_summary.trim()
    : typeof payload.reasoning?.summary === 'string' && payload.reasoning.summary.trim()
      ? payload.reasoning.summary.trim()
      : undefined;
  upstreamPayload.reasoning_summary = clientSummary || DEFAULT_SUMMARY;

  return upstreamPayload;
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
