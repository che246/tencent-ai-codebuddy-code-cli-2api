package upstream

import (
	"bytes"
	"compress/gzip"
	"regexp"
	"strconv"
	"strings"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/logger"
)

// ─── 针对腾讯上游 11-128 渠道指纹检测的语义等价清洗（payload.mjs:6-21） ─────────

var (
	fpTokensAtRe   = regexp.MustCompile(`(?i)(Tokens\s+prefixed\s+with\s+)@(\s+are\s+paths)`)
	fpDeepSeekRe   = regexp.MustCompile(`(?i)You\s+are\s+an\s+AI\s+agent\s+powered\s+by\s+DeepSeek[\s\x{200B}]+Harness\.`)
	fpCodingAgent  = regexp.MustCompile(`(?i)You\s+are\s+a\s+coding\s+agent\s+powered\s+by\s+`)
	fpWebGUIRe     = regexp.MustCompile(`(?i)DeepSeek[\s\x{200B}]+Harness\s+Web\s+GUI`)
	fpClaudeCodeRe = regexp.MustCompile(`(?i)You\s+are\s+Claude\s+Code,\s+Anthropic's\s+official\s+CLI\s+tool\s+for\s+Claude\.`)
	fpDefaultBrRe  = regexp.MustCompile(`(?i)Default\s+branch\s+\(you\s+will\s+usually\s+use\s+this\s+for\s+PRs\)`)
	fpHarnessRe    = regexp.MustCompile(`(?i)DeepSeek[\s\x{200B}]+Harness`)
)

// SanitizeChannelFingerprints 仅对 system/developer/assistant 文本做清洗（payload.mjs:6-21）。
func SanitizeChannelFingerprints(text, role string) string {
	if role != "system" && role != "developer" && role != "assistant" {
		return text
	}
	text = fpTokensAtRe.ReplaceAllString(text, "${1}(at)${2}")
	text = fpDeepSeekRe.ReplaceAllString(text, "You are a helpful AI assistant.")
	text = fpCodingAgent.ReplaceAllString(text, "You are a coding agent running on ")
	text = fpWebGUIRe.ReplaceAllString(text, "Web GUI")
	text = fpClaudeCodeRe.ReplaceAllString(text, "You are an interactive AI assistant for coding.")
	text = fpDefaultBrRe.ReplaceAllString(text, "Default branch (you will usually use this for PRs)")
	text = fpHarnessRe.ReplaceAllString(text, "DeepSeek-Harness")
	return text
}

// FormatMessagesForUpstream 格式化消息体发往腾讯云上游（payload.mjs:24-43）。
//   - content 缺省 ”；字符串/文本块做指纹清洗；tool_calls 透传；role=tool 透传 tool_call_id。
func FormatMessagesForUpstream(messages []*Obj) []*Obj {
	out := make([]*Obj, 0, len(messages))
	for _, m := range messages {
		if m == nil {
			continue
		}
		var content any = ""
		if c, ok := m.GetOK("content"); ok && c != nil {
			content = c
		}
		switch cv := content.(type) {
		case string:
			content = SanitizeChannelFingerprints(cv, GetString(m, "role"))
		case []any:
			parts := make([]any, len(cv))
			for i, p := range cv {
				part, ok := p.(*Obj)
				if ok && GetString(part, "type") == "text" {
					if txt, isStr := GetStringOK(part, "text"); isStr {
						np := part.Clone()
						np.Set("text", SanitizeChannelFingerprints(txt, GetString(m, "role")))
						parts[i] = np
						continue
					}
				}
				parts[i] = p
			}
			content = parts
		}
		item := NewObj().Set("role", m.Get("role")).Set("content", content)
		if v, ok := m.GetOK("tool_calls"); ok && Truthy(v) {
			item.Set("tool_calls", v)
		}
		if GetString(m, "role") == "tool" {
			if v, ok := m.GetOK("tool_call_id"); ok && v != nil {
				item.Set("tool_call_id", v)
			}
		}
		out = append(out, item)
	}
	return out
}

// ─── 模型名区域前缀（cn: / intl:）（payload.mjs:45-55） ──────────────────────────

// RegionPrefix 区域前缀。
var RegionPrefix = map[string]string{config.RegionCn: "cn:", config.RegionIntl: "intl:"}

// ParseModelRegion 剥掉模型名上的区域前缀，返回 (bare, region)；无前缀 region=""。
func ParseModelRegion(modelID string) (bare, region string) {
	s := modelID
	if strings.HasPrefix(s, RegionPrefix[config.RegionCn]) {
		return s[len(RegionPrefix[config.RegionCn]):], config.RegionCn
	}
	if strings.HasPrefix(s, RegionPrefix[config.RegionIntl]) {
		return s[len(RegionPrefix[config.RegionIntl]):], config.RegionIntl
	}
	return s, ""
}

// DefaultIntlSystem 国际版 system prompt 兜底（payload.mjs:57-61）。
// 实测（2026-11，www.codebuddy.ai）：国际版对 messages[0].role 有硬性校验，首条不是 system 时 400 code=11128。
const DefaultIntlSystem = ""

// EnsureLeadingSystemMessage 确保 messages 首条为 system（仅国际版需要）（payload.mjs:68-78）。
// regionOrAcc：区域字符串或账号对象。
func EnsureLeadingSystemMessage(messages []*Obj, region string) []*Obj {
	if config.NormalizeRegion(region) != config.RegionIntl {
		return messages
	}
	if len(messages) == 0 {
		return messages
	}
	if messages[0] != nil && GetString(messages[0], "role") == "system" {
		return messages
	}
	out := make([]*Obj, 0, len(messages)+1)
	out = append(out, NewObj().Set("role", "system").Set("content", DefaultIntlSystem))
	return append(out, messages...)
}

// EnsureLeadingSystemMessageFor 按账号区域补 system。
func EnsureLeadingSystemMessageFor(messages []*Obj, acc *config.Account) []*Obj {
	return EnsureLeadingSystemMessage(messages, config.ResolveAccountRegion(acc))
}

// ApplySystemPromptPolicy [网关自有策略] 应用系统提示词策略 (passthrough / custom / append)（payload.mjs:86-127）。
// promptText 为 loadSystemPromptContent(file) 的结果。
func ApplySystemPromptPolicy(messages []*Obj, mode, promptText string) []*Obj {
	if len(messages) == 0 {
		return messages
	}
	if mode == "passthrough" {
		return messages
	}
	if strings.TrimSpace(promptText) == "" {
		return messages
	}
	if mode == "custom" {
		nonSystem := make([]*Obj, 0, len(messages))
		for _, m := range messages {
			if m != nil && GetString(m, "role") != "system" && GetString(m, "role") != "developer" {
				nonSystem = append(nonSystem, m)
			}
		}
		out := make([]*Obj, 0, len(nonSystem)+1)
		out = append(out, NewObj().Set("role", "system").Set("content", promptText))
		return append(out, nonSystem...)
	}
	if mode == "append" {
		insertAt := 0
		for _, m := range messages {
			if m == nil || (GetString(m, "role") != "system" && GetString(m, "role") != "developer") {
				break
			}
			insertAt++
		}
		out := make([]*Obj, 0, len(messages)+1)
		out = append(out, messages[:insertAt]...)
		out = append(out, NewObj().Set("role", "system").Set("content", promptText))
		return append(out, messages[insertAt:]...)
	}
	return messages
}

// ─── 推理参数规整（payload.mjs:129-352） ────────────────────────────────────────
// 对齐官方 CLI 实测行为（2.177.1 / 2.179.0）：
//   1. 官方只发平铺的 reasoning_effort / reasoning_summary / verbosity，从不发 thinking / reasoning 嵌套对象。
//   2. 客户端显式传入的值必须优先保留。
//   3. 模型不支持推理（supportsReasoningEffort === false）时整体剥离。

// ThinkingLevels 官方档位。
var ThinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

// EffortRank 档位序。
var EffortRank = map[string]int{"minimal": 1, "low": 2, "medium": 3, "high": 4, "xhigh": 5, "max": 6}

// DefaultMaxTokens 官方默认值（仅在客户端未指定时兜底，依据 CLI 2.179.0 实测）。
const DefaultMaxTokens = 128000

const (
	defaultEffort    = "high"
	defaultVerbosity = "high"
	defaultSummary   = "auto"
)

func rankOf(e string) int {
	if r, ok := EffortRank[e]; ok {
		return r
	}
	return 99
}

// pickClientEffort 客户端档位：reasoning_effort ?? reasoning.effort ?? thinkingLevel ?? effort（payload.mjs:155-161）。
// 注意 `??` 只跳过 null/undefined：空串会被选中并判为无效，而不会再向后回落。
func pickClientEffort(payload *Obj) string {
	var raw any
	if v, ok := payload.GetOK("reasoning_effort"); ok {
		raw = v
	}
	if raw == nil {
		if r := GetObj(payload, "reasoning"); r != nil {
			raw = r.Get("effort")
		}
	}
	if raw == nil {
		raw = payload.Get("thinkingLevel")
	}
	if raw == nil {
		raw = payload.Get("effort")
	}
	if s, isStr := raw.(string); isStr && s != "" {
		return s
	}
	return ""
}

// NormalizeEffort 归一化档位；返回 (档位, 有效)（payload.mjs:163-172）。
func NormalizeEffort(effort string) (string, bool) {
	v := strings.ToLower(strings.TrimSpace(effort))
	if v == "" {
		return "", false
	}
	if v == "off" || v == "none" || v == "disabled" {
		return "none", true
	}
	for _, l := range ThinkingLevels {
		if l == v {
			return v, true
		}
	}
	return "", false
}

// isThinkingDisabled payload.thinking?.type === 'disabled' || payload.enable_thinking === false。
func isThinkingDisabled(payload *Obj) bool {
	if t := GetObj(payload, "thinking"); t != nil && GetString(t, "type") == "disabled" {
		return true
	}
	if b, ok := GetBool(payload, "enable_thinking"); ok && !b {
		return true
	}
	return false
}

// getModelSupportedEfforts 模型支持档位：reasoning.supportedEfforts[] 或 reasoning.effort（payload.mjs:178-188）。
func getModelSupportedEfforts(modelMeta *Obj) []string {
	if modelMeta == nil {
		return nil
	}
	r := GetObj(modelMeta, "reasoning")
	if r == nil {
		return nil
	}
	if arr := GetArr(r, "supportedEfforts"); len(arr) > 0 {
		out := make([]string, 0, len(arr))
		for _, v := range arr {
			if s, ok := v.(string); ok {
				out = append(out, s)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	if e := GetString(r, "effort"); e != "" {
		return []string{e}
	}
	return nil
}

// getLowestEffort 最低支持档（payload.mjs:190-194）。
func getLowestEffort(supported []string) string {
	if len(supported) == 0 {
		return ""
	}
	sorted := append([]string(nil), supported...)
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && rankOf(sorted[j]) < rankOf(sorted[j-1]); j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	return sorted[0]
}

// ClampThinkingLevel 将目标思考档位规范化并映射到模型支持的档位（不高于目标档位的最高支持档）（payload.mjs:202-232）。
func ClampThinkingLevel(targetLevel string, modelMeta *Obj) string {
	norm, ok := NormalizeEffort(targetLevel)
	if !ok {
		norm = "high"
	}
	if norm == "none" {
		r := GetObj(modelMeta, "reasoning")
		canDisable := true
		if r != nil {
			if b, ok := GetBool(r, "canDisableThinking"); ok && !b {
				canDisable = false
			}
		}
		if b, ok := GetBool(modelMeta, "onlyReasoning"); ok && b {
			canDisable = false
		}
		if canDisable {
			return "none"
		}
		supported := getModelSupportedEfforts(modelMeta)
		if low := getLowestEffort(supported); low != "" {
			return low
		}
		if r != nil {
			if d := GetString(r, "defaultEffort"); d != "" {
				return d
			}
		}
		return "low"
	}
	supported := getModelSupportedEfforts(modelMeta)
	if len(supported) == 0 {
		return norm
	}
	targetRank := rankOf(norm)
	if _, ok := EffortRank[norm]; !ok {
		targetRank = 4
	}
	var candidates []string
	for _, e := range supported {
		if r, ok := EffortRank[e]; ok && r <= targetRank {
			candidates = append(candidates, e)
		}
	}
	if len(candidates) > 0 {
		// 按 rank 降序取首
		best := candidates[0]
		for _, c := range candidates[1:] {
			if rankOf(c) > rankOf(best) {
				best = c
			}
		}
		return best
	}
	if low := getLowestEffort(supported); low != "" {
		return low
	}
	return norm
}

// GetUpstreamDefaultEffort 模型的官方上游默认档位（payload.mjs:239-243）。
func GetUpstreamDefaultEffort(modelMeta *Obj) string {
	if modelMeta == nil {
		return ""
	}
	r := GetObj(modelMeta, "reasoning")
	if r == nil {
		return ""
	}
	raw, has := r.GetOK("defaultEffort")
	if !has || raw == nil {
		raw = r.Get("effort")
	}
	if s, ok := raw.(string); ok {
		if e, valid := NormalizeEffort(s); valid {
			return e
		}
	}
	return ""
}

// ApplyReasoningParams 把客户端推理参数规整成官方上游格式（就地修改 upstreamPayload）（payload.mjs:253-352）。
// 档位解析核心优先级：客户端 > 上游默认 > 网关默认；或按网关思考策略改写。
func ApplyReasoningParams(upstreamPayload *Obj, payload *Obj, modelMeta *Obj, policy config.ThinkingPolicy) *Obj {
	// 官方规则 1：永远不发这两个嵌套对象
	upstreamPayload.Delete("thinking")
	upstreamPayload.Delete("reasoning")

	supportsEffort := true
	if modelMeta != nil {
		if b, ok := GetBool(modelMeta, "supportsReasoningEffort"); ok && !b {
			supportsEffort = false
		}
	}
	if !supportsEffort {
		upstreamPayload.Delete("reasoning_effort")
		upstreamPayload.Delete("reasoning_summary")
		upstreamPayload.Delete("verbosity")
		return upstreamPayload
	}

	clientEffort := pickClientEffort(payload)
	normalizedClient, clientValid := NormalizeEffort(clientEffort)
	clientDisabled := isThinkingDisabled(payload) || (clientValid && normalizedClient == "none")

	upstreamDefault := GetUpstreamDefaultEffort(modelMeta)
	gatewayDefault := policy.DefaultLevel
	if gatewayDefault == "" {
		gatewayDefault = defaultEffort
	}

	var finalEffort string
	if !policy.Enabled {
		// 未启用网关策略：客户端 > 上游默认 > 网关默认
		switch {
		case clientDisabled:
			finalEffort = "none"
		case clientValid:
			finalEffort = ClampThinkingLevel(normalizedClient, modelMeta)
		case upstreamDefault != "":
			finalEffort = ClampThinkingLevel(upstreamDefault, modelMeta)
		default:
			finalEffort = ClampThinkingLevel(gatewayDefault, modelMeta)
		}
	} else {
		modelID := ""
		if modelMeta != nil {
			modelID = GetString(modelMeta, "id")
		}
		if modelID == "" {
			modelID = GetString(payload, "model")
		}
		if modelID == "" {
			modelID = GetString(upstreamPayload, "model")
		}
		modelOverride := policy.ModelLevels[modelID]
		hasExplicitModelOverride := modelOverride != "" && modelOverride != "default"
		effectiveGatewayLevel := gatewayDefault
		if hasExplicitModelOverride {
			effectiveGatewayLevel = modelOverride
		} else if upstreamDefault != "" {
			effectiveGatewayLevel = upstreamDefault
		}
		mode := policy.OverrideMode
		if mode == "" {
			mode = "client_first"
		}
		switch mode {
		case "gateway_override_all":
			finalEffort = ClampThinkingLevel(effectiveGatewayLevel, modelMeta)
		case "gateway_level_only":
			if clientDisabled {
				finalEffort = "none"
			} else {
				finalEffort = ClampThinkingLevel(effectiveGatewayLevel, modelMeta)
			}
		default:
			switch {
			case clientDisabled:
				finalEffort = "none"
			case clientValid:
				finalEffort = ClampThinkingLevel(normalizedClient, modelMeta)
			default:
				finalEffort = ClampThinkingLevel(effectiveGatewayLevel, modelMeta)
			}
		}
	}

	switch {
	case finalEffort == "none":
		upstreamPayload.Set("reasoning_effort", "none")
	case finalEffort != "":
		upstreamPayload.Set("reasoning_effort", finalEffort)
	default:
		upstreamPayload.Set("reasoning_effort", defaultEffort)
	}

	// verbosity / reasoning_summary：客户端优先，缺省用官方默认值
	clientVerbosity := trimmedString(payload, "verbosity")
	if clientVerbosity == "" {
		if t := GetObj(payload, "text"); t != nil {
			clientVerbosity = trimmedString(t, "verbosity")
		}
	}
	upstreamPayload.Set("verbosity", orElse(clientVerbosity, defaultVerbosity))

	clientSummary := trimmedString(payload, "reasoning_summary")
	if clientSummary == "" {
		if r := GetObj(payload, "reasoning"); r != nil {
			clientSummary = trimmedString(r, "summary")
		}
	}
	upstreamPayload.Set("reasoning_summary", orElse(clientSummary, defaultSummary))

	return upstreamPayload
}

func trimmedString(o *Obj, k string) string {
	s, ok := GetStringOK(o, k)
	if !ok {
		return ""
	}
	return strings.TrimSpace(s)
}

func orElse(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

// ApplyModelCapabilityGuards 官方模型能力前置守卫：自动剥离不支持工具/视觉模型的参数（payload.mjs:355-386）。
func ApplyModelCapabilityGuards(lg *logger.Logger, upstreamPayload *Obj, modelMeta *Obj) *Obj {
	if modelMeta == nil {
		return upstreamPayload
	}
	if b, ok := GetBool(modelMeta, "supportsToolCall"); ok && !b {
		if v, has := upstreamPayload.GetOK("tools"); has && Truthy(v) {
			upstreamPayload.Delete("tools")
			upstreamPayload.Delete("tool_choice")
			logInfo(lg, "GUARD", "模型 ["+GetString(modelMeta, "id")+"] 声明不支持工具调用，已前置剥离 tools 参数避免 400")
		}
	}
	if b, ok := GetBool(modelMeta, "supportsImages"); ok && !b {
		if msgs, isArr := upstreamPayload.Get("messages").([]any); isArr {
			flattened := false
			out := make([]any, len(msgs))
			for i, mv := range msgs {
				m, isObj := mv.(*Obj)
				if !isObj {
					out[i] = mv
					continue
				}
				parts, isPA := m.Get("content").([]any)
				if !isPA {
					out[i] = mv
					continue
				}
				flattened = true
				var lines []string
				for _, pv := range parts {
					p, isPO := pv.(*Obj)
					if !isPO {
						continue
					}
					switch GetString(p, "type") {
					case "text":
						if t := GetString(p, "text"); t != "" {
							lines = append(lines, t)
						}
					case "image_url":
						lines = append(lines, "[图片附件: 当前模型 "+GetString(modelMeta, "id")+" 不支持视觉识图]")
					}
				}
				nm := m.Clone()
				nm.Set("content", strings.Join(lines, "\n"))
				out[i] = nm
			}
			upstreamPayload.Set("messages", out)
			if flattened {
				logInfo(lg, "GUARD", "模型 ["+GetString(modelMeta, "id")+"] 声明不支持多模态视觉，已将图片附件安全扁平化为说明文本")
			}
		}
	}
	return upstreamPayload
}

// PrepareUpstreamBody 请求体 Gzip 压缩处理器（对齐 package/dist-server GzipRequestProcessor 策略）（payload.mjs:389-403）。
// JSON 文本长度（UTF-16 码元）> 2048 则 gzip。
func PrepareUpstreamBody(payload *Obj) (body []byte, isGzip bool, originalLength int) {
	jsonBytes, err := payload.MarshalJSON()
	if err != nil {
		return nil, false, 0
	}
	jsonStr := string(jsonBytes)
	if JSLength(jsonStr) > 2048 {
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		if _, err := zw.Write(jsonBytes); err != nil {
			return nil, false, len(jsonStr)
		}
		if err := zw.Close(); err != nil {
			return nil, false, len(jsonStr)
		}
		return buf.Bytes(), true, JSLength(jsonStr)
	}
	return jsonBytes, false, JSLength(jsonStr)
}

const archiveTruncateAt = 8000

// ExtractArchiveContext 提取请求上下文（system / messages 原文）用于排查；base64 图片安全摘要截断（payload.mjs:409-448）。
func ExtractArchiveContext(payload *Obj) *Obj {
	ctx := NewObj()
	if payload == nil {
		return ctx
	}
	if s, ok := payload.GetOK("system"); ok && s != nil {
		switch sv := s.(type) {
		case string:
			ctx.Set("system", truncateRunes(sv, archiveTruncateAt, "...[截断]"))
		case []any:
			out := make([]any, len(sv))
			for i, b := range sv {
				bo, isObj := b.(*Obj)
				if isObj {
					if t, isStr := GetStringOK(bo, "text"); isStr && JSLength(t) > archiveTruncateAt {
						nb := bo.Clone()
						nb.Set("text", truncateRunes(t, archiveTruncateAt, "...[截断]"))
						out[i] = nb
						continue
					}
				}
				out[i] = b
			}
			ctx.Set("system", out)
		default:
			ctx.Set("system", s)
		}
	}
	if msgs, ok := payload.Get("messages").([]any); ok {
		out := make([]any, len(msgs))
		for i, mv := range msgs {
			m, isObj := mv.(*Obj)
			if !isObj {
				out[i] = mv
				continue
			}
			switch cv := m.Get("content").(type) {
			case string:
				out[i] = NewObj().Set("role", m.Get("role")).Set("content", truncateRunes(cv, archiveTruncateAt, "...[截断]"))
			case []any:
				parts := make([]any, len(cv))
				for j, pv := range cv {
					p, isPO := pv.(*Obj)
					if !isPO {
						parts[j] = pv
						continue
					}
					if GetString(p, "type") == "image_url" {
						iu := GetObj(p, "image_url")
						if iu != nil && strings.HasPrefix(GetString(iu, "url"), "data:") {
							parts[j] = NewObj().Set("type", "image_url").Set("image_url", NewObj().Set("url", "[base64 image ("+strconv.Itoa(JSLength(GetString(iu, "url")))+" 字节) 省略]"))
							continue
						}
					}
					if GetString(p, "type") == "image" {
						src := GetObj(p, "source")
						if src != nil && GetString(src, "data") != "" {
							parts[j] = NewObj().Set("type", "image").Set("source", "[base64 image ("+strconv.Itoa(JSLength(GetString(src, "data")))+" 字节) 省略]")
							continue
						}
					}
					parts[j] = pv
				}
				out[i] = NewObj().Set("role", m.Get("role")).Set("content", parts)
			default:
				out[i] = mv
			}
		}
		ctx.Set("messages", out)
	}
	return ctx
}

// truncateRunes 等价 s.length > n ? s.slice(0, n) + suffix : s（按 UTF-16 码元）。
func truncateRunes(s string, n int, suffix string) string {
	if JSLength(s) <= n {
		return s
	}
	return jsSlice(s, n) + suffix
}
