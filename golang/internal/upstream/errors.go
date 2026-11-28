package upstream

import (
	"encoding/json"
	"regexp"
	"strings"
)

// ─── 官方业务错误码枚举（对齐 package/dist-server/types/vendor/cbc-core/node/utils/error-utils.d.ts）──
// 来源：src/upstream/errors.mjs:1-37
const (
	CodeCraftRateLimit                   = 6000
	CodeCraftRateTPSLimit                = 6001 // Token/秒（瞬时限流）
	CodeCraftRateTPMLimit                = 6002 // Token/分（瞬时限流）
	CodeCraftRateTPHLimit                = 6003 // Token/时（长窗口限流，切模型降级）
	CodeCraftRateTPDLimit                = 6004 // Token/天（长窗口限流，切模型降级）
	CodeCraftRateRPSLimit                = 6005 // 请求/秒（瞬时限流）
	CodeCraftRateRPMLimit                = 6006 // 请求/分（瞬时限流）
	CodeCraftRateRPHLimit                = 6007 // 请求/时（长窗口限流，切模型降级）
	CodeCraftRateRPDLimit                = 6008 // 请求/天（长窗口限流，切模型降级）
	CodeConversationLimitExceeded        = 10105
	CodeModelNotFound                    = 11102
	CodeContextTooLong                   = 11115 // 输入 token 超出模型上下文窗口 (PTL)
	CodeRequestIllegal                   = 11128 // 请求非法：国际版首条非 system / UA 命中风控
	CodeInvalidParams                    = 11133
	CodeAccountRestricted                = 11140 // 账号存在异常行为已被限制使用 (auth_forbidden，对齐 CLI rf 集合)
	CodeAccountForbidden                 = 11142 // 账号被禁止使用 (auth_forbidden)
	CodeModelNotAllowed                  = 11158 // 模型不被当前用户类型允许
	CodeUsageLimitExceeded               = 14001
	CodeConversationChatTooMany          = 14002
	CodeRateLimitError                   = 14003 // 模型接口调用频率限制
	CodeUsageLimitExceededEnterprise     = 14012
	CodeUsageLimitExceededTencent        = 14013
	CodeUsageLimitEnterpriseExhausted    = 14014
	CodeUsageLimitLicenseExpired         = 14015
	CodeUsageLimitEnterpriseNotActivated = 14016
	CodeUsageLimitUserNotActivated       = 14017
	CodeUsageLimitUserExhausted          = 14018
	CodeUsageLimitNoTokenBudget          = 14019
	CodeUsageLimitExceededDepartment     = 14022
	CodeUsageLimitEnterprisePackageExh   = 14023
	CodeWebSearchRateLimit               = 15001
)

// ModelFallbackCodes 触发模型降级改道的长窗口限流集合（errors.mjs:40-45）。
var ModelFallbackCodes = map[int]bool{6003: true, 6004: true, 6007: true, 6008: true}

// QuotaExhaustedCodes 触发账号冷却切换的额度用尽集合（errors.mjs:48-57）。
var QuotaExhaustedCodes = map[int]bool{
	14001: true, 14012: true, 14013: true, 14014: true, 14018: true,
	14019: true, 14022: true, 14023: true,
}

// AccountRestrictedCodes 触发账号状态置为 restricted 的上游风控封禁错误码集合（errors.mjs:60-63）。
var AccountRestrictedCodes = map[int]bool{11140: true, 11142: true}

// TransientRateLimitCodes 瞬时抖动限流（短窗口）（errors.mjs:66-72）。
var TransientRateLimitCodes = map[int]bool{6001: true, 6002: true, 6005: true, 6006: true, 14003: true}

// PTLSubstrings 官方上下文超限特征文本（对齐 package/dist-server/codebuddy.js tB 列表）（errors.mjs:75-87）。
var PTLSubstrings = []string{
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
	"context_length_exceeded",
}

// IsInputLengthError 按特征子串判断是否上下文超限（errors.mjs:89-93）。
func IsInputLengthError(msg string) bool {
	if msg == "" {
		return false
	}
	lower := strings.ToLower(msg)
	for _, sub := range PTLSubstrings {
		if strings.Contains(lower, sub) {
			return true
		}
	}
	return false
}

var digitsOnlyRe = regexp.MustCompile(`^\d+$`)

// bizCodeFromValue 等价 `typeof obj.code === 'number' && obj.code >= 1000` / 字符串数字分支。
func bizCodeFromValue(v any) (int, bool) {
	switch t := v.(type) {
	case json.Number:
		if f, err := t.Float64(); err == nil && f >= 1000 {
			return int(f), true
		}
	case float64:
		if t >= 1000 {
			return int(t), true
		}
	case int:
		if t >= 1000 {
			return t, true
		}
	case string:
		if digitsOnlyRe.MatchString(t) {
			if f, err := json.Number(t).Float64(); err == nil && f >= 1000 {
				return int(f), true
			}
		}
	}
	return 0, false
}

// ExtractStructuredBizCode 递归下钻扫描后端结构化业务码（errors.mjs:96-117）。
// 顺序：obj.code(number>=1000) → obj.code(数字字符串>=1000) → obj.error → obj.data → 解析 obj.message/obj.details 中的 JSON。
func ExtractStructuredBizCode(obj any, depth int) (int, bool) {
	if depth <= 0 {
		return 0, false
	}
	o, ok := obj.(*Obj)
	if !ok {
		return 0, false
	}
	if code, ok := bizCodeFromValue(o.Get("code")); ok {
		return code, true
	}
	if c, ok := ExtractStructuredBizCode(o.Get("error"), depth-1); ok {
		return c, true
	}
	if c, ok := ExtractStructuredBizCode(o.Get("data"), depth-1); ok {
		return c, true
	}
	for _, field := range []string{"message", "details"} {
		if s, ok := GetStringOK(o, field); ok {
			if parsed, err := ParseAny([]byte(s)); err == nil {
				if c, ok := ExtractStructuredBizCode(parsed, depth-1); ok {
					return c, true
				}
			}
		}
	}
	return 0, false
}

// OpenAIErrorBody `{"error":{message,type,code,param}}`，字段顺序与 Node 一致。
type OpenAIErrorBody struct {
	Error OpenAIError `json:"error"`
}

// OpenAIError OpenAI 风格错误对象。
type OpenAIError struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    string `json:"code"`
	Param   any    `json:"param"`
}

// FormatOpenAIError 把上游错误文本映射为 OpenAI 风格错误（errors.mjs:119-157）。
func FormatOpenAIError(status int, upstreamText string) OpenAIErrorBody {
	parsed, err := ParseAny([]byte(upstreamText))
	if err != nil {
		return fallbackOpenAIError(upstreamText)
	}
	errObj, ok := parsed.(*Obj)
	if !ok {
		// JS 中 JSON.parse 得到非对象（数组/数字）时 err.code 为 undefined，其余分支与兜底一致
		return fallbackOpenAIError(upstreamText)
	}
	bizCode, hasBiz := ExtractStructuredBizCode(errObj, 6)
	if !hasBiz {
		// `extractStructuredBizCode(err) || err.code`：提取失败则取 err.code（可能为非数字/字符串，下面所有集合判断均不命中）
		if c, ok := bizCodeFromValue(errObj.Get("code")); ok {
			bizCode, hasBiz = c, true
		}
	}
	msg := firstNonEmpty(
		getNestedString(errObj, "displayTips", "zh"),
		getNestedString(errObj, "displayMsg", "zh"),
		GetString(errObj, "msg"),
		GetString(errObj, "message"),
		upstreamText,
	)
	code := "upstream_error"
	typ := "api_error"
	switch {
	case hasBiz && bizCode == CodeModelNotFound:
		code, typ = "model_not_found", "invalid_request_error"
	case hasBiz && bizCode == CodeRequestIllegal:
		code, typ = "request_illegal", "invalid_request_error"
	case hasBiz && bizCode == CodeInvalidParams:
		code, typ = "invalid_request_parameters", "invalid_request_error"
	case (hasBiz && bizCode == CodeContextTooLong) || IsInputLengthError(msg):
		code, typ = "context_length_exceeded", "invalid_request_error"
	case status == 429 || (hasBiz && (ModelFallbackCodes[bizCode] || TransientRateLimitCodes[bizCode] || bizCode == 6021)):
		code, typ = "rate_limit_exceeded", "rate_limit_error"
	case status == 402 || (hasBiz && QuotaExhaustedCodes[bizCode]):
		code, typ = "insufficient_quota", "insufficient_quota"
	case hasBiz && AccountRestrictedCodes[bizCode]:
		code, typ = "account_restricted", "permission_error"
	}
	return OpenAIErrorBody{Error: OpenAIError{Message: msg, Type: typ, Code: code, Param: nil}}
}

func fallbackOpenAIError(text string) OpenAIErrorBody {
	return OpenAIErrorBody{Error: OpenAIError{Message: text, Type: "api_error", Code: "upstream_error", Param: nil}}
}

func getNestedString(o *Obj, key, sub string) string {
	inner := GetObj(o, key)
	if inner == nil {
		return ""
	}
	return GetString(inner, sub)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
