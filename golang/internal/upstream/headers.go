// Package upstream 对应 Node 版 src/upstream/*.mjs：
// 官方请求头复刻（headers）、业务错误码与 OpenAI 错误映射（errors）、请求体规整（payload）、
// 模型矩阵（models）、流守卫（streamguard），以及以 CLI 为依据的常量表（cliconsts）。
package upstream

import (
	"net/http"
	"net/url"
	"os"
	"strings"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/logger"
)

// ─── 日志辅助（Logger 在 Node 为静态模块；Go 版由调用方注入实例，nil 安全） ─────

func logInfo(lg *logger.Logger, category, msg string, meta ...any) {
	if lg != nil {
		lg.Info(category, msg, meta...)
	}
}
func logWarn(lg *logger.Logger, category, msg string, meta ...any) {
	if lg != nil {
		lg.Warn(category, msg, meta...)
	}
}
func logError(lg *logger.Logger, category, msg string, meta ...any) {
	if lg != nil {
		lg.Error(category, msg, meta...)
	}
}

// ─── 上游风控防护（实测得出，非猜测；headers.mjs:5-34） ──────────────────────────
//
// 1. 唯一强制项：Authorization（缺失/伪造 → 401 HTML）
// 2. 唯一风控项：User-Agent 含 "python-requests"（大小写不敏感子串）→ 400 {"code":11128,"msg":"request illegal"}
// 3. 其余应用层头均非强制，但属指纹一致性的一部分，仍完整发送。

// BlockedUASubstrings 上游明确拦截的 UA 子串（实测，大小写不敏感）。
var BlockedUASubstrings = []string{"python-requests"}

// SanitizeUserAgent 校验并修正 User-Agent：命中黑名单回落官方 UA 并打警告（headers.mjs:43-52）。
func SanitizeUserAgent(lg *logger.Logger, ua string) string {
	value := ua
	lower := strings.ToLower(value)
	for _, s := range BlockedUASubstrings {
		if strings.Contains(lower, s) {
			logWarn(lg, "UPSTREAM", "User-Agent 命中上游风控黑名单 (含 \""+s+"\")，已替换为官方 UA 以避免 400/11128. 原值: "+mustJSON(jsSlice(value, 80)))
			return config.UserAgent
		}
	}
	if value == "" {
		return config.UserAgent
	}
	return value
}

// jsSlice 等价 value.slice(0, n)（按 UTF-16 码元）。
func jsSlice(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}

func mustJSON(v any) string {
	b, err := MarshalJSON(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

// assertCriticalHeaders 上游风控要求的 3 项基础头兜底断言（headers.mjs:55-67）。
func assertCriticalHeaders(lg *logger.Logger, h http.Header) http.Header {
	has := func(k string) bool {
		for kk := range h {
			if strings.EqualFold(kk, k) {
				return true
			}
		}
		return false
	}
	if !has("Authorization") {
		logError(lg, "UPSTREAM", "请求头缺少 Authorization，上游必然返回 401")
	}
	if !has("Content-Type") {
		h["Content-Type"] = []string{"application/json"}
	}
	if !has("User-Agent") {
		h["User-Agent"] = []string{config.UserAgent}
	}
	return h
}

// resolveDomainHeader 解析 X-Domain 取值（headers.mjs:129-142）。
// CLI 来源：enterpriseHeaders(eA) { let el = eA?.domain || URI.parse(this.endpoint).authority; return el ? {[DOMAIN]: el} : {} }
func ResolveDomainHeader(acc *config.Account) string {
	if acc != nil && strings.TrimSpace(acc.Domain) != "" {
		return strings.TrimSpace(acc.Domain)
	}
	region := config.RegionCn
	if acc != nil {
		region = config.ResolveAccountRegion(acc)
	}
	base := config.BaseForRegion(region)
	if u, err := url.Parse(base.Web); err == nil && u.Hostname() != "" {
		return u.Hostname()
	}
	if region == config.RegionIntl {
		return "www.codebuddy.ai"
	}
	return "www.codebuddy.cn"
}

// ResolvePrivateDataHeader 解析出站 X-Private-Data（headers.mjs:159-177）。
// 依据官方 CLI：
//
//	isEnterpriseEditionAccount(acc) = !!acc?.enterpriseId || acc?.type==='ultimate' || acc?.type==='exclusive'
//	ep[PRIVATE_DATA_HEADER] = resolveModelOptimizationEnabled(...) ? "false" : "true"
//
// auto 模式保持三套出站身份各自官方默认：企业版 "true"、国际版 "true"、国内个人号 "false"。
func ResolvePrivateDataHeader(policy string, acc *config.Account) string {
	if policy == "true" {
		return "true"
	}
	if policy == "false" {
		return "false"
	}
	if acc == nil {
		return "false"
	}
	isEnterprise := acc.Type == "ultimate" || acc.Type == "exclusive" || acc.EnterpriseID != ""
	if !isEnterprise {
		if raw, ok := acc.Extra["enterpriseId"]; ok && TruthyJSON(raw) {
			isEnterprise = true
		}
	}
	if isEnterprise {
		return "true"
	}
	if config.ResolveAccountRegion(acc) == config.RegionIntl {
		return "true"
	}
	return "false"
}

// TruthyJSON 判断一段 JSON 原文是否为 JS 真值（非 null/false/0/""）。
func TruthyJSON(raw []byte) bool {
	v, err := ParseAny(raw)
	if err != nil {
		return len(raw) > 0
	}
	return Truthy(v)
}

// StainlessRuntimeVersion x-stainless-runtime-version 取值。
// Node 版为 process.version；【决策】Go 版固定为 Node 22 LTS 版本串以保持指纹一致，可用 GW_STAINLESS_RUNTIME_VERSION 覆盖。
var StainlessRuntimeVersion = func() string {
	if v := os.Getenv("GW_STAINLESS_RUNTIME_VERSION"); v != "" {
		return v
	}
	return "v22.14.0"
}()

// Stainless 常量（headers.mjs:253-260，CLI 2.179.0 实测 OpenAI SDK 指纹）。
const (
	StainlessPackageVersion = "7.39.0"
	StainlessOS             = "Windows"
	StainlessArch           = "x64"
)

// normalizeConversationId 把 sessionKey 规整为合法 UUID v7 形态（headers.mjs:205-223）。
func normalizeConversationID(sessionKey string) string {
	raw := strings.TrimSpace(sessionKey)
	if uuidV7Re.MatchString(raw) {
		return raw
	}
	if hex32Re.MatchString(raw) {
		h := strings.ToLower(raw)
		g4 := byte('8')
		if len(h) > 16 {
			v := hexDigit(h[16])
			g4 = "0123456789abcdef"[(v&0x3)|0x8]
		}
		return h[0:8] + "-" + h[8:12] + "-7" + h[13:16] + "-" + string(g4) + h[17:20] + "-" + h[20:32]
	}
	return UUIDv7()
}

func hexDigit(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return 0
}

// BuildOfficialUpstreamHeaders 构造发往上游 /v2/chat/completions 的请求头（headers.mjs:189-296）。
// 全部依据来自真实 CLI 2.179.0 抓包（.capture/cmp/cli_2.179.0.log），共 38 个应用层头。
// 注意：直接以字面键写入 http.Header（不走 Set），保持与抓包一致的大小写。
func BuildOfficialUpstreamHeaders(lg *logger.Logger, accessToken, targetModel, sessionKey, uid string, isGzip bool, acc *config.Account, privateDataPolicy string) http.Header {
	messageId := UUIDv7Hex()
	conversationRequestId := UUIDv7Hex()
	conversationId := normalizeConversationID(sessionKey)
	traceId := UUIDv7Hex()
	spanId := RandomHex(8)
	parentSpanId := RandomHex(8)

	osName := StainlessOS
	archName := StainlessArch

	h := http.Header{}
	h["Authorization"] = []string{"Bearer " + accessToken}
	h["User-Agent"] = []string{SanitizeUserAgent(lg, config.UserAgent)}
	h["Content-Type"] = []string{"application/json"}
	h["Accept"] = []string{"application/json"}
	h["X-Requested-With"] = []string{"XMLHttpRequest"}
	h["X-CodeBuddy-Request"] = []string{"1"}

	// 链路 ID（CLI 2.179.0 实测两两对齐）
	h["X-Request-ID"] = []string{messageId}
	h["X-Conversation-Message-ID"] = []string{messageId}
	h["X-Conversation-Request-ID"] = []string{conversationRequestId}
	h["X-Root-Request-ID"] = []string{conversationRequestId}
	h["X-Conversation-ID"] = []string{conversationId}

	// Stainless SDK 指纹头
	h["x-stainless-arch"] = []string{archName}
	h["x-stainless-lang"] = []string{"js"}
	h["x-stainless-os"] = []string{osName}
	h["x-stainless-package-version"] = []string{StainlessPackageVersion}
	h["x-stainless-retry-count"] = []string{"0"}
	h["x-stainless-runtime"] = []string{"node"}
	h["x-stainless-runtime-version"] = []string{StainlessRuntimeVersion}

	// 链路追踪双协议（W3C + B3）
	h["traceparent"] = []string{"00-" + traceId + "-" + spanId + "-01"}
	h["baggage"] = []string{"codebuddy.session_id=" + conversationId + ",codebuddy.conversation_request_id=" + conversationRequestId}
	h["b3"] = []string{traceId + "-" + spanId + "-1-" + parentSpanId}
	h["X-B3-TraceId"] = []string{traceId}
	h["X-B3-SpanId"] = []string{spanId}
	h["X-B3-ParentSpanId"] = []string{parentSpanId}
	h["X-B3-Sampled"] = []string{"1"}
	h["X-Trace-ID"] = []string{traceId}

	// 身份与产品
	h["X-Domain"] = []string{ResolveDomainHeader(acc)}
	h["X-Product"] = []string{"SaaS"}
	h["X-Private-Data"] = []string{ResolvePrivateDataHeader(privateDataPolicy, acc)}
	h["X-IDE-Type"] = []string{"CLI"}
	h["X-IDE-Name"] = []string{"CLI"}
	h["X-IDE-Version"] = []string{config.CurrentVersion}

	// Agent 元信息
	h["X-Agent-Intent"] = []string{"craft"}
	h["X-Agent-Runtime"] = []string{"other"}
	h["X-Agent-Purpose"] = []string{"conversation"}
	h["X-Agent-Type"] = []string{"main"}

	if uid != "" {
		h["X-User-Id"] = []string{uid}
	}
	if isGzip {
		h["Content-Encoding"] = []string{"gzip"}
	}
	return assertCriticalHeaders(lg, h)
}
