// ─── 官方业务错误码枚举 (对齐 package/dist-server/types/vendor/cbc-core/node/utils/error-utils.d.ts) ─
export const ServerErrorCode = {
  CraftRateLimit: 6000,
  CraftRateTPSLimit: 6001,      // Token/秒 (瞬时限流)
  CraftRateTPMLimit: 6002,      // Token/分 (瞬时限流)
  CraftRateTPHLimit: 6003,      // Token/时 (长窗口限流，切模型降级)
  CraftRateTPDLimit: 6004,      // Token/天 (长窗口限流，切模型降级)
  CraftRateRPSLimit: 6005,      // 请求/秒 (瞬时限流)
  CraftRateRPMLimit: 6006,      // 请求/分 (瞬时限流)
  CraftRateRPHLimit: 6007,      // 请求/时 (长窗口限流，切模型降级)
  CraftRateRPDLimit: 6008,      // 请求/天 (长窗口限流，切模型降级)
  ConversationLimitExceeded: 10105,
  ModelNotFound: 11102,
  ContextTooLong: 11115,        // 输入 token 超出模型上下文窗口 (PTL)
  RequestIllegal: 11128,        // 请求非法。实测两种触发场景：
                                //   1) 国际版首条消息不是 system prompt
                                //   2) User-Agent 命中风控（如含 "python-requests"）
                                //      返回 {"code":11128,"msg":"request illegal"}
  InvalidParams: 11133,
  ModelNotAllowed: 11158,       // 模型不被当前用户类型允许（如个人免费账号访问 GPT/Grok）
  UsageLimitExceeded: 14001,    // 个人额度用尽
  ConversationChatTooMany: 14002,
  RateLimitError: 14003,        // 模型接口调用频率限制
  UsageLimitExceededEnterprise: 14012,
  UsageLimitExceededTencent: 14013,
  UsageLimitEnterpriseExhausted: 14014,
  UsageLimitLicenseExpired: 14015,
  UsageLimitEnterpriseNotActivated: 14016,
  UsageLimitUserNotActivated: 14017,
  UsageLimitUserExhausted: 14018,
  UsageLimitNoTokenBudget: 14019,
  UsageLimitExceededDepartment: 14022,
  UsageLimitEnterprisePackageExhausted: 14023,
  WebSearchRateLimit: 15001
};

// 触发模型降级改道的长窗口限流集合
export const MODEL_FALLBACK_CODES = new Set([
  ServerErrorCode.CraftRateTPHLimit, // 6003
  ServerErrorCode.CraftRateTPDLimit, // 6004
  ServerErrorCode.CraftRateRPHLimit, // 6007
  ServerErrorCode.CraftRateRPDLimit  // 6008
]);

// 触发账号冷却切换的额度用尽集合
export const QUOTA_EXHAUSTED_CODES = new Set([
  ServerErrorCode.UsageLimitExceeded, // 14001
  ServerErrorCode.UsageLimitExceededEnterprise,
  ServerErrorCode.UsageLimitExceededTencent,
  ServerErrorCode.UsageLimitEnterpriseExhausted,
  ServerErrorCode.UsageLimitUserExhausted,
  ServerErrorCode.UsageLimitNoTokenBudget,
  ServerErrorCode.UsageLimitExceededDepartment,
  ServerErrorCode.UsageLimitEnterprisePackageExhausted
]);

// 瞬时抖动限流 (短窗口)
export const TRANSIENT_RATE_LIMIT_CODES = new Set([
  ServerErrorCode.CraftRateTPSLimit, // 6001
  ServerErrorCode.CraftRateTPMLimit, // 6002
  ServerErrorCode.CraftRateRPSLimit, // 6005
  ServerErrorCode.CraftRateRPMLimit, // 6006
  ServerErrorCode.RateLimitError     // 14003
]);

// 官方上下文超限特征文本 (对齐 package/dist-server/codebuddy.js tB 列表)
export const PTL_SUBSTRINGS = [
  "input length too long",
  "input is too long",
  "exceeds the maximum length",
  "input tokens exceed",
  "prompt is too long",
  "exceeds the maximum number of tokens allowed",
  "too many total text bytes",
  "requested token count exceeds",
  "maximum context length",
  "context window exceeds limit",
  "context_length_exceeded"
];

export function isInputLengthError(msg) {
  if (!msg || typeof msg !== 'string') return false;
  const lower = msg.toLowerCase();
  return PTL_SUBSTRINGS.some(sub => lower.includes(sub));
}

// 递归下钻扫描后端结构化业务码 (对齐 package 官方 extractStructuredBizCode 实现)
export function extractStructuredBizCode(obj, depth = 6) {
  if (!obj || typeof obj !== 'object' || depth <= 0) return undefined;
  if (typeof obj.code === 'number' && obj.code >= 1000) return obj.code;
  if (typeof obj.code === 'string' && /^\d+$/.test(obj.code) && Number(obj.code) >= 1000) return Number(obj.code);
  
  const fromError = extractStructuredBizCode(obj.error, depth - 1);
  if (fromError !== undefined) return fromError;
  
  const fromData = extractStructuredBizCode(obj.data, depth - 1);
  if (fromData !== undefined) return fromData;

  for (const field of [obj.message, obj.details]) {
    if (typeof field === 'string') {
      try {
        const parsed = JSON.parse(field);
        const sub = extractStructuredBizCode(parsed, depth - 1);
        if (sub !== undefined) return sub;
      } catch (_) {}
    }
  }
  return undefined;
}

export function formatOpenAIError(status, upstreamText) {
  try {
    const err = JSON.parse(upstreamText);
    const bizCode = extractStructuredBizCode(err) || err.code;
    const msg = err.displayTips?.zh || err.displayMsg?.zh || err.msg || err.message || upstreamText;
    let code = "upstream_error";
    let type = "api_error";

    if (bizCode === ServerErrorCode.ModelNotFound) {
      code = "model_not_found";
      type = "invalid_request_error";
    } else if (bizCode === ServerErrorCode.RequestIllegal) {
      // 11128: 上游"请求非法"。实测由两类原因触发——
      //   a) 国际版首条消息不是 system prompt（网关已自动补齐）
      //   b) User-Agent 命中风控黑名单（如含 python-requests）
      // 单独给一个 code，便于排查时一眼分辨是哪个原因。
      code = "request_illegal";
      type = "invalid_request_error";
    } else if (bizCode === ServerErrorCode.InvalidParams) {
      code = "invalid_request_parameters";
      type = "invalid_request_error";
    } else if (bizCode === ServerErrorCode.ContextTooLong || isInputLengthError(msg)) {
      code = "context_length_exceeded";
      type = "invalid_request_error";
    } else if (status === 429 || MODEL_FALLBACK_CODES.has(bizCode) || TRANSIENT_RATE_LIMIT_CODES.has(bizCode) || bizCode === 6021) {
      code = "rate_limit_exceeded";
      type = "rate_limit_error";
    } else if (status === 402 || QUOTA_EXHAUSTED_CODES.has(bizCode)) {
      code = "insufficient_quota";
      type = "insufficient_quota";
    }
    return { error: { message: msg, type, code, param: null } };
  } catch (_) {
    return { error: { message: upstreamText, type: "api_error", code: "upstream_error", param: null } };
  }
}
