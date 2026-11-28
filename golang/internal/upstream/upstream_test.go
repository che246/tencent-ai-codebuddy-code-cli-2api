package upstream

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/logger"
)

func testLogger() *logger.Logger {
	l := logger.New(nil, "")
	l.SetWriters(io.Discard, io.Discard)
	return l
}

func mustObj(t *testing.T, s string) *Obj {
	t.Helper()
	o, err := ParseObj([]byte(s))
	if err != nil {
		t.Fatalf("ParseObj(%q): %v", s, err)
	}
	return o
}

// ─── Obj ──────────────────────────────────────────────────────────────────────

func TestObjPreservesKeyOrder(t *testing.T) {
	o, err := ParseObj([]byte(`{"z":1,"a":{"y":[1,{"k":"v","j":2}]},"m":"<x>&"}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(o.Keys(), ","); got != "z,a,m" {
		t.Fatalf("keys=%s", got)
	}
	out, _ := o.MarshalJSON()
	if string(out) != `{"z":1,"a":{"y":[1,{"k":"v","j":2}]},"m":"<x>&"}` {
		t.Fatalf("marshal=%s", out)
	}
	o.Delete("z")
	o.Set("a", 1) // 覆盖保持位置
	o.Set("n", true)
	if got := strings.Join(o.Keys(), ","); got != "a,m,n" {
		t.Fatalf("keys after=%s", got)
	}
	if s := o.String(); s != `{"a":1,"m":"<x>&","n":true}` {
		t.Fatalf("after=%s", s)
	}
	if _, ok := o.Get("a").(json.Number); ok {
		// Set 覆盖后为 int，不是 json.Number
		t.Fatal("unexpected")
	}
	num, ok := mustObj(t, `{"v":128000}`).Get("v").(json.Number)
	if !ok || num.String() != "128000" {
		t.Fatalf("number=%v", num)
	}
}

func TestTruthy(t *testing.T) {
	cases := []struct {
		v    any
		want bool
	}{
		{nil, false}, {"", false}, {"0", true}, {json.Number("0"), false}, {json.Number("1"), true},
		{false, false}, {true, true}, {[]any{}, true}, {NewObj(), true}, {float64(0), false},
	}
	for _, c := range cases {
		if got := Truthy(c.v); got != c.want {
			t.Errorf("Truthy(%v)=%v want %v", c.v, got, c.want)
		}
	}
	if JSLength("ab你😀") != 5 {
		t.Fatalf("JSLength=%d", JSLength("ab你😀"))
	}
}

// ─── UUID ─────────────────────────────────────────────────────────────────────

func TestUUIDv7(t *testing.T) {
	before := time.Now().UnixMilli()
	id := UUIDv7()
	after := time.Now().UnixMilli()
	if len(id) != 36 || strings.Count(id, "-") != 4 {
		t.Fatalf("format=%s", id)
	}
	if id[14] != '7' {
		t.Fatalf("version nibble=%q", id[14])
	}
	if !strings.ContainsRune("89ab", rune(id[19])) {
		t.Fatalf("variant=%q", id[19])
	}
	msHex := id[0:8] + id[9:13]
	var ms int64
	_, _ = fmt.Sscanf(msHex, "%x", &ms)
	if ms < before || ms > after {
		t.Fatalf("timestamp %d not in [%d,%d]", ms, before, after)
	}
	h := UUIDv7Hex()
	if len(h) != 32 || strings.Contains(h, "-") {
		t.Fatalf("hex=%s", h)
	}
	if len(RandomHex(8)) != 16 {
		t.Fatal("RandomHex")
	}
}

// ─── headers ──────────────────────────────────────────────────────────────────

func TestSanitizeUserAgent(t *testing.T) {
	if got := SanitizeUserAgent(testLogger(), "python-requests/2.31.0"); got != config.UserAgent {
		t.Fatalf("got %s", got)
	}
	if got := SanitizeUserAgent(testLogger(), "CLI/2.179.0 CodeBuddy/2.179.0 Python-Requests/2.31.0"); got != config.UserAgent {
		t.Fatalf("got %s", got)
	}
	if got := SanitizeUserAgent(testLogger(), "python_requests/2.0"); got != "python_requests/2.0" {
		t.Fatalf("underscore should pass: %s", got)
	}
	if got := SanitizeUserAgent(testLogger(), ""); got != config.UserAgent {
		t.Fatalf("empty should fallback: %s", got)
	}
}

func TestNormalizeConversationID(t *testing.T) {
	v7 := "01a1c0d2-f29b-715e-8c54-6824ec76cfe9"
	if got := normalizeConversationID("  " + v7 + " "); got != v7 {
		t.Fatalf("v7 kept: %s", got)
	}
	got := normalizeConversationID("0123456789abcdef0123456789abcdef")
	if got != "01234567-89ab-7def-8123-456789abcdef" {
		t.Fatalf("hex32 → %s", got)
	}
	if got := normalizeConversationID("ABCDEF01-..."); !uuidV7Re.MatchString(got) {
		t.Fatalf("other → %s", got)
	}
}

func TestResolvePrivateDataHeader(t *testing.T) {
	cn := &config.Account{Region: "cn"}
	intl := &config.Account{Region: "intl"}
	ent := &config.Account{Region: "cn", Type: "ultimate"}
	cases := []struct {
		policy string
		acc    *config.Account
		want   string
	}{
		{"true", cn, "true"}, {"false", intl, "false"}, {"auto", nil, "false"},
		{"auto", ent, "true"}, {"auto", intl, "true"}, {"auto", cn, "false"},
		{"", cn, "false"},
	}
	for _, c := range cases {
		if got := ResolvePrivateDataHeader(c.policy, c.acc); got != c.want {
			t.Errorf("policy=%q acc=%+v got %s want %s", c.policy, c.acc, got, c.want)
		}
	}
}

func TestResolveDomainHeader(t *testing.T) {
	if got := ResolveDomainHeader(&config.Account{Domain: " corp.example.com "}); got != "corp.example.com" {
		t.Fatalf("domain=%s", got)
	}
	if got := ResolveDomainHeader(&config.Account{Region: "intl"}); got != "www.codebuddy.ai" {
		t.Fatalf("intl=%s", got)
	}
	if got := ResolveDomainHeader(nil); got != "www.codebuddy.cn" {
		t.Fatalf("nil=%s", got)
	}
}

func TestBuildOfficialUpstreamHeaders(t *testing.T) {
	h := BuildOfficialUpstreamHeaders(testLogger(), "tok", "m", "sess", "uid123", true, &config.Account{Region: "cn"}, "auto")
	if len(h) != 38 {
		t.Fatalf("header count=%d want 38: %v", len(h), keysOf(h))
	}
	if h["X-Request-ID"][0] != h["X-Conversation-Message-ID"][0] {
		t.Fatal("A pair mismatch")
	}
	if h["X-Conversation-Request-ID"][0] != h["X-Root-Request-ID"][0] {
		t.Fatal("B pair mismatch")
	}
	if h["X-Request-ID"][0] == h["X-Conversation-Request-ID"][0] || h["X-Trace-ID"][0] != h["X-B3-TraceId"][0] {
		t.Fatal("ids should be independent / trace shared")
	}
	if h["Authorization"][0] != "Bearer tok" || h["Content-Encoding"][0] != "gzip" || h["X-User-Id"][0] != "uid123" {
		t.Fatalf("basic headers wrong: %v", h)
	}
	if h["x-stainless-os"][0] != "Windows" || h["x-stainless-package-version"][0] != "7.39.0" {
		t.Fatal("stainless")
	}
	if _, ok := h["X-Stainless-Os"]; ok {
		t.Fatal("stainless keys must stay lowercase")
	}
	if !strings.HasPrefix(h["traceparent"][0], "00-") || h["X-Private-Data"][0] != "false" || h["X-Domain"][0] != "www.codebuddy.cn" {
		t.Fatalf("trace/privacy/domain: %v", h)
	}
	if h["X-Conversation-ID"][0] == "" || len(h["X-Conversation-ID"][0]) != 36 {
		t.Fatalf("conversation id=%q", h["X-Conversation-ID"][0])
	}
	h2 := BuildOfficialUpstreamHeaders(testLogger(), "tok", "m", "", "", false, nil, "")
	if len(h2) != 36 {
		t.Fatalf("count without uid/gzip=%d", len(h2))
	}
}

func keysOf(h http.Header) []string {
	var ks []string
	for k := range h {
		ks = append(ks, k)
	}
	return ks
}

// ─── errors ───────────────────────────────────────────────────────────────────

func TestExtractStructuredBizCode(t *testing.T) {
	if c, ok := ExtractStructuredBizCode(mustObj(t, `{"code":6003}`), 6); !ok || c != 6003 {
		t.Fatalf("direct: %v %v", c, ok)
	}
	if c, ok := ExtractStructuredBizCode(mustObj(t, `{"code":"11158"}`), 6); !ok || c != 11158 {
		t.Fatalf("string code: %v %v", c, ok)
	}
	if _, ok := ExtractStructuredBizCode(mustObj(t, `{"code":999}`), 6); ok {
		t.Fatal("code<1000 should be ignored")
	}
	if c, ok := ExtractStructuredBizCode(mustObj(t, `{"error":{"data":{"code":14001}}}`), 6); !ok || c != 14001 {
		t.Fatalf("nested: %v %v", c, ok)
	}
	if c, ok := ExtractStructuredBizCode(mustObj(t, `{"message":"{\"code\":11140}"}`), 6); !ok || c != 11140 {
		t.Fatalf("message json: %v %v", c, ok)
	}
	if _, ok := ExtractStructuredBizCode(mustObj(t, `{"code":6003}`), 0); ok {
		t.Fatal("depth 0")
	}
	if _, ok := ExtractStructuredBizCode([]any{"x"}, 6); ok {
		t.Fatal("array should be ignored")
	}
}

func TestFormatOpenAIError(t *testing.T) {
	cases := []struct {
		name, text string
		status     int
		code, typ  string
		msg        string
	}{
		{"invalid json", "<html>401</html>", 401, "upstream_error", "api_error", "<html>401</html>"},
		{"model not found", `{"code":11102,"msg":"no model"}`, 404, "model_not_found", "invalid_request_error", "no model"},
		{"request illegal", `{"code":11128,"msg":"request illegal"}`, 400, "request_illegal", "invalid_request_error", "request illegal"},
		{"invalid params", `{"code":11133,"msg":"bad"}`, 400, "invalid_request_parameters", "invalid_request_error", "bad"},
		{"context too long", `{"code":11115,"msg":"x"}`, 400, "context_length_exceeded", "invalid_request_error", "x"},
		{"ptl text", `{"code":500,"msg":"Prompt is too long"}`, 400, "context_length_exceeded", "invalid_request_error", "Prompt is too long"},
		{"429", `{"code":1,"msg":"slow"}`, 429, "rate_limit_exceeded", "rate_limit_error", "slow"},
		{"fallback code", `{"code":6003,"msg":"tph"}`, 200, "rate_limit_exceeded", "rate_limit_error", "tph"},
		{"402", `{"code":1,"msg":"pay"}`, 402, "insufficient_quota", "insufficient_quota", "pay"},
		{"quota", `{"code":14001,"msg":"quota"}`, 200, "insufficient_quota", "insufficient_quota", "quota"},
		{"restricted", `{"code":11140,"msg":"banned"}`, 200, "account_restricted", "permission_error", "banned"},
		{"displayTips", `{"code":11102,"displayTips":{"zh":"模型不存在"},"msg":"raw"}`, 404, "model_not_found", "invalid_request_error", "模型不存在"},
		{"displayMsg", `{"code":11102,"displayMsg":{"zh":"提示"},"msg":"raw"}`, 404, "model_not_found", "invalid_request_error", "提示"},
		{"message field", `{"code":11102,"message":"from message"}`, 404, "model_not_found", "invalid_request_error", "from message"},
		{"string code", `{"code":"6004","msg":"tpd"}`, 200, "rate_limit_exceeded", "rate_limit_error", "tpd"},
		{"array body", `[1,2]`, 200, "upstream_error", "api_error", "[1,2]"},
	}
	for _, c := range cases {
		got := FormatOpenAIError(c.status, c.text)
		if got.Error.Code != c.code || got.Error.Type != c.typ || got.Error.Message != c.msg || got.Error.Param != nil {
			t.Errorf("%s: got %+v", c.name, got.Error)
		}
	}
	b, _ := MarshalJSON(FormatOpenAIError(429, `{"code":1,"msg":"x"}`))
	if string(b) != `{"error":{"message":"x","type":"rate_limit_error","code":"rate_limit_exceeded","param":null}}` {
		t.Fatalf("json=%s", b)
	}
}

func TestIsInputLengthError(t *testing.T) {
	if !IsInputLengthError("Input LENGTH too long") || IsInputLengthError("") || IsInputLengthError("hello") {
		t.Fatal("IsInputLengthError")
	}
}

// ─── payload ──────────────────────────────────────────────────────────────────

func TestParseModelRegion(t *testing.T) {
	if b, r := ParseModelRegion("cn:deepseek-v4.1-flash"); b != "deepseek-v4.1-flash" || r != "cn" {
		t.Fatal("cn")
	}
	if b, r := ParseModelRegion("intl:gpt-6-astra"); b != "gpt-6-astra" || r != "intl" {
		t.Fatal("intl")
	}
	if b, r := ParseModelRegion("cn:x:y"); b != "x:y" || r != "cn" {
		t.Fatal("only the first prefix is stripped")
	}
	if b, r := ParseModelRegion("xx:cn:y"); b != "xx:cn:y" || r != "" {
		t.Fatal("unknown prefix")
	}
}

func TestSanitizeChannelFingerprints(t *testing.T) {
	if got := SanitizeChannelFingerprints("You are Claude Code, Anthropic's official CLI tool for Claude.", "user"); got != "You are Claude Code, Anthropic's official CLI tool for Claude." {
		t.Fatal("user role must be untouched")
	}
	if got := SanitizeChannelFingerprints("You are Claude Code, Anthropic's official CLI tool for Claude.", "system"); got != "You are an interactive AI assistant for coding." {
		t.Fatalf("system: %s", got)
	}
	if got := SanitizeChannelFingerprints("Tokens prefixed with @ are paths", "developer"); got != "Tokens prefixed with (at) are paths" {
		t.Fatalf("tokens: %s", got)
	}
	if got := SanitizeChannelFingerprints("DeepSeek Harness Web GUI", "assistant"); got != "Web GUI" {
		t.Fatalf("gui: %s", got)
	}
	if got := SanitizeChannelFingerprints("DeepSeek\u200BHarness mode", "system"); got != "DeepSeek-Harness mode" {
		t.Fatalf("harness: %q", got)
	}
}

func TestFormatMessagesForUpstream(t *testing.T) {
	msgs := []*Obj{
		mustObj(t, `{"role":"user","content":"You are a coding agent powered by X","name":"ignored"}`),
		mustObj(t, `{"role":"system","content":[{"type":"text","text":"You are an AI agent powered by DeepSeek Harness."},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAA"}}]}`),
		mustObj(t, `{"role":"assistant","content":null,"tool_calls":[{"id":"c1"}]}`),
		mustObj(t, `{"role":"tool","tool_call_id":"c1","content":"42"}`),
	}
	out := FormatMessagesForUpstream(msgs)
	if s := out[0].String(); s != `{"role":"user","content":"You are a coding agent powered by X"}` {
		t.Fatalf("user: %s", s)
	}
	if s := out[1].String(); s != `{"role":"system","content":[{"type":"text","text":"You are a helpful AI assistant."},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAA"}}]}` {
		t.Fatalf("system: %s", s)
	}
	if s := out[2].String(); s != `{"role":"assistant","content":"","tool_calls":[{"id":"c1"}]}` {
		t.Fatalf("assistant: %s", s)
	}
	if s := out[3].String(); s != `{"role":"tool","content":"42","tool_call_id":"c1"}` {
		t.Fatalf("tool: %s", s)
	}
}

func TestEnsureLeadingSystemMessage(t *testing.T) {
	msgs := []*Obj{mustObj(t, `{"role":"user","content":"hi"}`)}
	if got := EnsureLeadingSystemMessage(msgs, "intl"); len(got) != 2 || got[0].String() != `{"role":"system","content":""}` {
		t.Fatalf("intl: %v", got)
	}
	if got := EnsureLeadingSystemMessage(msgs, "cn"); len(got) != 1 {
		t.Fatal("cn must be untouched")
	}
	sys := []*Obj{mustObj(t, `{"role":"system","content":"x"}`), mustObj(t, `{"role":"user","content":"hi"}`)}
	if got := EnsureLeadingSystemMessage(sys, "intl"); len(got) != 2 {
		t.Fatal("already system")
	}
}

func TestApplySystemPromptPolicy(t *testing.T) {
	msgs := []*Obj{
		mustObj(t, `{"role":"system","content":"s1"}`),
		mustObj(t, `{"role":"developer","content":"d1"}`),
		mustObj(t, `{"role":"user","content":"u1"}`),
		mustObj(t, `{"role":"system","content":"s2"}`),
	}
	if got := ApplySystemPromptPolicy(msgs, "passthrough", "P"); len(got) != 4 {
		t.Fatal("passthrough")
	}
	if got := ApplySystemPromptPolicy(msgs, "custom", "  "); len(got) != 4 {
		t.Fatal("empty prompt → untouched")
	}
	got := ApplySystemPromptPolicy(msgs, "custom", "P")
	if len(got) != 2 || got[0].String() != `{"role":"system","content":"P"}` || got[1].Get("content") != "u1" {
		t.Fatalf("custom: %v", got)
	}
	got = ApplySystemPromptPolicy(msgs, "append", "P")
	if len(got) != 5 || got[0].Get("content") != "s1" || got[1].Get("content") != "d1" || got[2].String() != `{"role":"system","content":"P"}` || got[3].Get("content") != "u1" {
		t.Fatalf("append: %v", got)
	}
}

func TestClampThinkingLevel(t *testing.T) {
	meta := mustObj(t, `{"id":"m","reasoning":{"supportedEfforts":["low","high","max"],"canDisableThinking":true}}`)
	if got := ClampThinkingLevel("off", meta); got != "none" {
		t.Fatalf("off: %s", got)
	}
	if got := ClampThinkingLevel("xhigh", meta); got != "high" {
		t.Fatalf("xhigh→high: %s", got)
	}
	if got := ClampThinkingLevel("medium", meta); got != "low" {
		t.Fatalf("medium→low: %s", got)
	}
	if got := ClampThinkingLevel("bogus", meta); got != "high" {
		t.Fatalf("bogus→high(rank4)→high: %s", got)
	}
	forced := mustObj(t, `{"id":"m","onlyReasoning":true,"reasoning":{"supportedEfforts":["high","max"],"canDisableThinking":false}}`)
	if got := ClampThinkingLevel("off", forced); got != "high" {
		t.Fatalf("forced off→lowest: %s", got)
	}
	noMeta := mustObj(t, `{"id":"m"}`)
	if got := ClampThinkingLevel("low", noMeta); got != "low" {
		t.Fatalf("no supported: %s", got)
	}
	if e := GetUpstreamDefaultEffort(mustObj(t, `{"reasoning":{"defaultEffort":"MAX"}}`)); e != "max" {
		t.Fatalf("default effort: %s", e)
	}
	if e := GetUpstreamDefaultEffort(mustObj(t, `{"reasoning":{"effort":"medium"}}`)); e != "medium" {
		t.Fatalf("effort fallback: %s", e)
	}
}

func TestApplyReasoningParams(t *testing.T) {
	meta := mustObj(t, `{"id":"m","supportsReasoningEffort":true,"reasoning":{"supportedEfforts":["low","high"],"defaultEffort":"high"}}`)
	// 1. 客户端显式档位优先，嵌套对象被剥离，默认 verbosity/summary
	body := mustObj(t, `{"model":"m","thinking":{"type":"enabled"},"reasoning":{"effort":"low"},"reasoning_effort":"low"}`)
	body.Delete("reasoning_effort")
	payload := mustObj(t, `{"model":"m","reasoning_effort":"low","thinking":{"type":"enabled"}}`)
	ApplyReasoningParams(body, payload, meta, config.DefaultThinkingPolicy())
	if body.Has("thinking") || body.Has("reasoning") {
		t.Fatal("nested objects must be removed")
	}
	if body.Get("reasoning_effort") != "low" || body.Get("verbosity") != "high" || body.Get("reasoning_summary") != "auto" {
		t.Fatalf("body=%s", body)
	}
	// 2. 客户端未传 → 上游默认
	body = mustObj(t, `{"model":"m"}`)
	ApplyReasoningParams(body, mustObj(t, `{"model":"m"}`), meta, config.DefaultThinkingPolicy())
	if body.Get("reasoning_effort") != "high" {
		t.Fatalf("upstream default: %s", body)
	}
	// 3. 客户端关闭思考 → none
	body = mustObj(t, `{"model":"m","reasoning_effort":"high"}`)
	ApplyReasoningParams(body, mustObj(t, `{"model":"m","thinking":{"type":"disabled"}}`), meta, config.DefaultThinkingPolicy())
	if body.Get("reasoning_effort") != "none" {
		t.Fatalf("disabled: %s", body)
	}
	// 4. 网关策略 gateway_override_all：连关闭也改写
	pol := config.ThinkingPolicy{Enabled: true, DefaultLevel: "max", OverrideMode: "gateway_override_all", ModelLevels: map[string]string{}}
	body = mustObj(t, `{"model":"m"}`)
	ApplyReasoningParams(body, mustObj(t, `{"model":"m","thinking":{"type":"disabled"},"verbosity":" low ","reasoning_summary":"concise"}`), meta, pol)
	if body.Get("reasoning_effort") != "high" || body.Get("verbosity") != "low" || body.Get("reasoning_summary") != "concise" {
		t.Fatalf("override_all: %s", body)
	}
	// 5. gateway_level_only 尊重客户端关闭
	pol.OverrideMode = "gateway_level_only"
	body = mustObj(t, `{"model":"m"}`)
	ApplyReasoningParams(body, mustObj(t, `{"model":"m","enable_thinking":false}`), meta, pol)
	if body.Get("reasoning_effort") != "none" {
		t.Fatalf("level_only: %s", body)
	}
	// 6. 逐模型覆盖 + client_first 未传档位
	pol.OverrideMode = "client_first"
	pol.ModelLevels = map[string]string{"m": "low"}
	body = mustObj(t, `{"model":"m"}`)
	ApplyReasoningParams(body, mustObj(t, `{"model":"m"}`), meta, pol)
	if body.Get("reasoning_effort") != "low" {
		t.Fatalf("model level: %s", body)
	}
	// 7. 不支持推理 → 整体剥离
	noReason := mustObj(t, `{"id":"m","supportsReasoningEffort":false}`)
	body = mustObj(t, `{"model":"m","reasoning_effort":"high","reasoning_summary":"auto","verbosity":"high"}`)
	ApplyReasoningParams(body, mustObj(t, `{"model":"m","reasoning_effort":"high"}`), noReason, config.DefaultThinkingPolicy())
	if body.Has("reasoning_effort") || body.Has("reasoning_summary") || body.Has("verbosity") {
		t.Fatalf("strip: %s", body)
	}
	// 8. 空 reasoning_effort 被 ?? 选中后判无效，不回落 reasoning.effort（照搬 Node 语义）
	body = mustObj(t, `{"model":"m"}`)
	ApplyReasoningParams(body, mustObj(t, `{"model":"m","reasoning_effort":"","reasoning":{"effort":"low"}}`), meta, config.DefaultThinkingPolicy())
	if body.Get("reasoning_effort") != "high" {
		t.Fatalf("empty effort: %s", body)
	}
}

func TestApplyModelCapabilityGuards(t *testing.T) {
	meta := mustObj(t, `{"id":"m","supportsToolCall":false,"supportsImages":false}`)
	body := mustObj(t, `{"tools":[{"type":"function"}],"tool_choice":"auto","messages":[{"role":"user","content":[{"type":"text","text":"hi"},{"type":"image_url","image_url":{"url":"data:"}},{"type":"other"}]},{"role":"user","content":"plain"}]}`)
	ApplyModelCapabilityGuards(testLogger(), body, meta)
	if body.Has("tools") || body.Has("tool_choice") {
		t.Fatal("tools must be stripped")
	}
	msgs := body.Get("messages").([]any)
	if msgs[0].(*Obj).Get("content") != "hi\n[图片附件: 当前模型 m 不支持视觉识图]" {
		t.Fatalf("flatten: %q", msgs[0].(*Obj).Get("content"))
	}
	if msgs[1].(*Obj).Get("content") != "plain" {
		t.Fatal("plain content changed")
	}
	emptyTools := mustObj(t, `{"tools":[]}`)
	ApplyModelCapabilityGuards(testLogger(), emptyTools, meta)
	if emptyTools.Has("tools") {
		t.Fatal("empty array is truthy in JS → should strip")
	}
}

func TestPrepareUpstreamBody(t *testing.T) {
	body, isGzip, n := PrepareUpstreamBody(mustObj(t, `{"a":"b"}`))
	if isGzip || string(body) != `{"a":"b"}` || n != 9 {
		t.Fatalf("small: %s %v %d", body, isGzip, n)
	}
	big := NewObj().Set("text", strings.Repeat("你", 3000)) // 9011 bytes / 3011 code units > 2048
	body, isGzip, n = PrepareUpstreamBody(big)
	if !isGzip || n != 3011 {
		t.Fatalf("big: gzip=%v n=%d", isGzip, n)
	}
	zr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(zr)
	want, _ := big.MarshalJSON()
	if !bytes.Equal(raw, want) {
		t.Fatal("gzip roundtrip mismatch")
	}
}

func TestExtractArchiveContext(t *testing.T) {
	ctx := ExtractArchiveContext(mustObj(t, `{"system":"`+strings.Repeat("s", 8001)+`","messages":[{"role":"user","content":"short"},{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]}]}`))
	sys := GetString(ctx, "system")
	if JSLength(sys) != 8000+JSLength("...[截断]") {
		t.Fatalf("system truncated len=%d", JSLength(sys))
	}
	msgs := ctx.Get("messages").([]any)
	if msgs[0].(*Obj).Get("content") != "short" {
		t.Fatal("short content")
	}
	if s := msgs[1].(*Obj).String(); s != `{"role":"user","content":[{"type":"image_url","image_url":{"url":"[base64 image (26 字节) 省略]"}}]}` {
		t.Fatalf("image summarized: %s", s)
	}
	if ExtractArchiveContext(nil).Len() != 0 {
		t.Fatal("nil payload")
	}
}

// ─── stream guard ─────────────────────────────────────────────────────────────

func TestDeltaClassifier(t *testing.T) {
	c := NewDeltaClassifier()
	c.ObserveDelta(mustObj(t, `{"reasoning_content":"thinking"}`), nil)
	if !c.HasContent() || !c.HasReasoning() || c.HasSubstantiveContent() || c.EmptyStreamKind() != "reasoning-only" {
		t.Fatalf("reasoning-only state wrong")
	}
	c.ObserveDelta(mustObj(t, `{"content":""}`), "stop")
	if c.FinishReason() != "stop" || c.EmptyStreamKind() != "reasoning-only" {
		t.Fatal("empty content must not count")
	}
	c.ObserveDelta(mustObj(t, `{"tool_calls":[{"index":0}]}`), nil)
	if !c.HasSubstantiveContent() || c.EmptyStreamKind() != "" {
		t.Fatal("tools are substantive")
	}
	c.ObserveUsage(nil)
	if c.HasUsage() {
		t.Fatal("nil usage")
	}
	c.ObserveUsage(NewObj())
	if !c.HasUsage() {
		t.Fatal("usage")
	}
	fresh := NewDeltaClassifier()
	if fresh.EmptyStreamKind() != "no-token" {
		t.Fatal("no-token")
	}
	fresh.ObserveDelta(mustObj(t, `{"refusal":"no"}`), nil)
	if !fresh.HasSubstantiveContent() {
		t.Fatal("refusal")
	}
}

func TestTerminalChunks(t *testing.T) {
	if got := BuildTruncationChunk("id1", "m1"); got != `{"id":"id1","object":"chat.completion.chunk","model":"m1","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}` {
		t.Fatalf("trunc: %s", got)
	}
	if got := BuildEmptyStreamChunk("", "", ""); !strings.HasPrefix(got, `{"id":"chatcmpl-`) || !strings.HasSuffix(got, `,"choices":[{"index":0,"delta":{},"finish_reason":"error"}],"x_empty_stream_kind":"no-token"}`) || !strings.Contains(got, `"model":"unknown"`) {
		t.Fatalf("empty: %s", got)
	}
	if IsTruncatedWithoutFinish(false, false, false) != true || IsTruncatedWithoutFinish(true, false, false) != false || IsTruncatedWithoutFinish(false, true, false) != false || IsTruncatedWithoutFinish(false, false, true) != false {
		t.Fatal("IsTruncatedWithoutFinish")
	}
}

func withVarInt(p *int, v int, fn func()) {
	old := *p
	*p = v
	defer func() { *p = old }()
	fn()
}

func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

func TestLifecycleFirstByteTimeout(t *testing.T) {
	withVarInt(&FirstByteTimeoutMs, 20, func() {
		lc := NewLifecycle(context.Background(), "t", testLogger())
		defer lc.Dispose()
		select {
		case <-lc.Ctx().Done():
		case <-time.After(2 * time.Second):
			t.Fatal("first byte timer did not fire")
		}
		if lc.Reason() != ReasonFirstByteTimeout || !lc.Aborted() || lc.Aborted() != true {
			t.Fatalf("reason=%s", lc.Reason())
		}
		if lc.IsClientGone() {
			t.Fatal("not client gone")
		}
	})
}

func TestLifecycleClientGoneAndMarkedEnd(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	lc := NewLifecycle(ctx, "t", testLogger())
	cancel()
	waitFor(t, time.Second, func() bool { return lc.Reason() == ReasonClientGone })
	if !lc.IsClientGone() {
		t.Fatalf("reason=%s", lc.Reason())
	}
	lc.Dispose()

	// upstreamEnded 后客户端挂断不算断开
	ctx2, cancel2 := context.WithCancel(context.Background())
	lc2 := NewLifecycle(ctx2, "t", testLogger())
	lc2.MarkUpstreamEnded()
	cancel2()
	time.Sleep(20 * time.Millisecond)
	if lc2.Reason() != "" {
		t.Fatalf("after upstreamEnded reason should be empty, got %s", lc2.Reason())
	}
	lc2.Dispose()

	// markFirstByte 清掉首字节定时器
	withVarInt(&FirstByteTimeoutMs, 30, func() {
		lc3 := NewLifecycle(context.Background(), "t", testLogger())
		lc3.MarkFirstByte()
		time.Sleep(60 * time.Millisecond)
		if lc3.Aborted() {
			t.Fatal("first byte timer should be cleared")
		}
		lc3.Dispose()
	})
}

type sliceReader struct {
	parts []string
	i     int
	delay time.Duration
}

func (r *sliceReader) Read(p []byte) (int, error) {
	if r.delay > 0 {
		time.Sleep(r.delay)
	}
	if r.i >= len(r.parts) {
		return 0, io.EOF
	}
	n := copy(p, r.parts[r.i])
	r.i++
	return n, nil
}

func TestReadUpstreamStreamDoneSplit(t *testing.T) {
	lc := NewLifecycle(context.Background(), "t", testLogger())
	defer lc.Dispose()
	var got strings.Builder
	res := ReadUpstreamStream(&sliceReader{parts: []string{"data: {\"choices\":[{\"delta\":{\"content\":\"hé\"}}]}\n\n", "data: [DO", "NE]\n\n", "data: more\n\n"}}, lc, ReadOpts{OnChunk: func(s string) { got.WriteString(s) }})
	if !res.SawDone || !res.UpstreamEnded || res.Aborted || res.Err != nil {
		t.Fatalf("res=%+v", res)
	}
	if strings.Contains(got.String(), "more") {
		t.Fatal("should stop after [DONE]")
	}
	if !strings.Contains(got.String(), "hé") {
		t.Fatalf("utf8 content: %q", got.String())
	}
	// stopOnDone=false 继续读完
	var got2 strings.Builder
	res2 := ReadUpstreamStream(&sliceReader{parts: []string{"data: [DONE]\n\n", "data: more\n\n"}}, lc, ReadOpts{NoStopOnDone: true, OnChunk: func(s string) { got2.WriteString(s) }})
	if !res2.SawDone || strings.Contains(got2.String(), "more") == false {
		t.Fatalf("res2=%+v got=%q", res2, got2.String())
	}
}

func TestReadUpstreamStreamUTF8AcrossChunks(t *testing.T) {
	lc := NewLifecycle(context.Background(), "t", testLogger())
	defer lc.Dispose()
	s := "data: 你好\n\n"
	b := []byte(s)
	cut := 9 // 切在“你”(3 字节) 中间：'d','a','t','a',':',' ' = 7 字节, 然后 2 字节
	var got strings.Builder
	res := ReadUpstreamStream(&sliceReader{parts: []string{string(b[:cut]), string(b[cut:])}}, lc, ReadOpts{OnChunk: func(x string) { got.WriteString(x) }})
	if res.Err != nil || got.String() != s {
		t.Fatalf("got=%q res=%+v", got.String(), res)
	}
}

type errReader struct{ err error }

func (e errReader) Read(p []byte) (int, error) { return 0, e.err }

func TestReadUpstreamStreamErrorAndIdle(t *testing.T) {
	lc := NewLifecycle(context.Background(), "t", testLogger())
	defer lc.Dispose()
	res := ReadUpstreamStream(errReader{io.ErrUnexpectedEOF}, lc, ReadOpts{})
	if res.Err != io.ErrUnexpectedEOF || res.SawDone {
		t.Fatalf("err res=%+v", res)
	}
	withVarInt(&StreamIdleTimeoutMs, 30, func() {
		lc2 := NewLifecycle(context.Background(), "idle", testLogger())
		defer lc2.Dispose()
		res := ReadUpstreamStream(&sliceReader{parts: []string{"data: a\n\n"}, delay: 80 * time.Millisecond}, lc2, ReadOpts{})
		if !res.AbortedByIdle || lc2.Reason() != ReasonIdleTimeout {
			t.Fatalf("idle res=%+v reason=%s", res, lc2.Reason())
		}
	})
	// finish_reason 终止行标记 upstreamEnded（此后读错也不算客户端断开）
	lc4 := NewLifecycle(context.Background(), "t", testLogger())
	defer lc4.Dispose()
	rr := &multiReader{parts: []string{`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}` + "\n\n"}, finalErr: io.ErrUnexpectedEOF}
	res5 := ReadUpstreamStream(rr, lc4, ReadOpts{})
	if !res5.UpstreamEnded || res5.Err == nil {
		t.Fatalf("finish_reason should mark upstreamEnded: %+v", res5)
	}
	// finish_reason:"null" 不算终止
	lc5 := NewLifecycle(context.Background(), "t", testLogger())
	defer lc5.Dispose()
	rr2 := &multiReader{parts: []string{`data: {"choices":[{"delta":{},"finish_reason":"null"}]}` + "\n\n"}, finalErr: io.ErrUnexpectedEOF}
	if res6 := ReadUpstreamStream(rr2, lc5, ReadOpts{}); res6.UpstreamEnded {
		t.Fatalf("null finish must not mark ended: %+v", res6)
	}
}

type multiReader struct {
	parts    []string
	i        int
	finalErr error
}

func (r *multiReader) Read(p []byte) (int, error) {
	if r.i >= len(r.parts) {
		return 0, r.finalErr
	}
	n := copy(p, r.parts[r.i])
	r.i++
	return n, nil
}

// ─── heartbeat ────────────────────────────────────────────────────────────────

type fakeWriter struct {
	mu     sync.Mutex
	frames []string
	ended  bool
}

func (f *fakeWriter) Write(raw string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.ended {
		return false
	}
	f.frames = append(f.frames, raw)
	return true
}
func (f *fakeWriter) Ended() bool { return f.ended }

func TestHeartbeat(t *testing.T) {
	withVarInt(&HeartbeatIntervalMs, 10, func() {
		w := &fakeWriter{}
		h := StartHeartbeat(w, "t", "openai", func() (string, string) { return "chatcmpl-1", "m1" })
		time.Sleep(60 * time.Millisecond)
		h.Touch()
		n1 := h.PingCount()
		if n1 < 1 {
			t.Fatalf("expected pings, got %d", n1)
		}
		w.mu.Lock()
		frame := w.frames[0]
		w.mu.Unlock()
		if !strings.HasPrefix(frame, "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"created\":") || !strings.HasSuffix(frame, `,"model":"m1","choices":[{"index":0,"delta":{},"finish_reason":null}]}`+"\n\n") {
			t.Fatalf("frame=%q", frame)
		}
		if h.IdleMs() > 50 {
			t.Fatalf("touch should reset idle: %d", h.IdleMs())
		}
		nStop := h.Stop()
		w.mu.Lock()
		frames := len(w.frames)
		w.mu.Unlock()
		if nStop < 1 || nStop != frames {
			t.Fatalf("stop returns %d, frames written %d", nStop, frames)
		}
		// anthropic 帧
		w2 := &fakeWriter{}
		h2 := StartHeartbeat(w2, "t", "anthropic", nil)
		time.Sleep(40 * time.Millisecond)
		h2.Stop()
		w2.mu.Lock()
		defer w2.mu.Unlock()
		if len(w2.frames) == 0 || w2.frames[0] != "event: ping\ndata: {\"type\": \"ping\"}\n\n" {
			t.Fatalf("anthropic frames=%q", w2.frames)
		}
		// 关闭保活
		withVarInt(&HeartbeatIntervalMs, 0, func() {
			h3 := StartHeartbeat(&fakeWriter{}, "t", "openai", nil)
			if h3.Stop() != 0 {
				t.Fatal("noop")
			}
		})
	})
}

func TestLogStreamOutcome(t *testing.T) {
	lg := logger.New(nil, "")
	var buf bytes.Buffer
	lg.SetWriters(&buf, &buf)
	LogStreamOutcome(lg, "x", StreamResult{UpstreamEnded: true}, "a", 1)
	if buf.Len() != 0 {
		t.Fatal("upstreamEnded should be silent")
	}
	LogStreamOutcome(lg, "x", StreamResult{AbortedByClient: true}, "k", nil, "j", 2)
	if !strings.Contains(buf.String(), "[x] 客户端先断开，上游随之取消（非上游故障） (j=2)") {
		t.Fatalf("log=%s", buf.String())
	}
	buf.Reset()
	LogStreamOutcome(lg, "x", StreamResult{AbortedByIdle: true})
	if !strings.Contains(buf.String(), "[WARN ] [STREAM] [x] 流静默超时终止（疑似上游断流）") {
		t.Fatalf("log=%s", buf.String())
	}
	buf.Reset()
	LogStreamOutcome(lg, "x", StreamResult{AbortedByFirstByte: true})
	if !strings.Contains(buf.String(), "首字节超时终止") {
		t.Fatalf("log=%s", buf.String())
	}
	buf.Reset()
	LogStreamOutcome(lg, "x", StreamResult{Err: io.ErrClosedPipe})
	if !strings.Contains(buf.String(), "上游断流: io: read/write on closed pipe") {
		t.Fatalf("log=%s", buf.String())
	}
}

// ─── models ───────────────────────────────────────────────────────────────────

func TestResolveModelPromotion(t *testing.T) {
	free := mustObj(t, `{"id":"m1","credits":"0x","multiplier":1}`)
	p := ResolveModelPromotion(free, nil)
	if GetString(p, "kind") != "free" || GetString(p, "id") != "free-m1" {
		t.Fatalf("free: %s", p)
	}
	free2 := mustObj(t, `{"id":"m2","credits":"1x","multiplier":0}`)
	if GetString(ResolveModelPromotion(free2, nil), "kind") != "free" {
		t.Fatal("multiplier 0")
	}
	ds := mustObj(t, `{"id":"DeepSeek-V4.1-Flash","name":"x"}`)
	if GetString(ResolveModelPromotion(ds, nil), "id") != "ds-v4.1-flash-night-discount" {
		t.Fatal("deepseek preset")
	}
	glm := mustObj(t, `{"id":"x","name":"GLM-5.2"}`)
	if GetString(ResolveModelPromotion(glm, nil), "id") != "glm-5.2-night-discount" {
		t.Fatal("glm preset")
	}
	if ResolveModelPromotion(mustObj(t, `{"id":"other"}`), nil) != nil {
		t.Fatal("no promotion")
	}
	promos := []*Obj{
		mustObj(t, `{"id":"p0","enabled":false,"modelIds":["m9"]}`),
		mustObj(t, `{"id":"p1","kind":"","modelIds":[" M9 "],"badge":{"label":"L"},"hover":{"textZh":"H"},"discount":{"factor":0.9}}`),
	}
	got := ResolveModelPromotion(mustObj(t, `{"id":"m9"}`), promos)
	if got == nil || GetString(got, "id") != "p1" || GetString(got, "kind") != "discount" || GetString(GetObj(got, "badge"), "color") != "#009273" || GetString(GetObj(got, "badge"), "label") != "L" || GetString(got, "source") != "upstream" {
		t.Fatalf("upstream promo: %s", got)
	}
	if b, _ := MarshalJSON(got); string(b) != `{"id":"p1","kind":"discount","badge":{"label":"L","color":"#009273","icon":null,"display":"activeOnly"},"hover":{"textZh":"H","textEn":"","action":null},"discount":{"factor":0.9},"schedule":null,"source":"upstream"}` {
		t.Fatalf("promo json=%s", b)
	}
	related := ResolveModelPromotion(mustObj(t, `{"id":"zz","relatedModels":{"a":"m9"}}`), promos)
	if related == nil {
		t.Fatal("relatedModels match")
	}
}

func newTestCatalog(t *testing.T, handler http.Handler) (*ModelCatalog, *config.AccountStore) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	c := NewClient(nil, false, testLogger())
	c.HTTPClient().Transport = &http.Transport{}
	// 让区域 API 域名指向测试服务器
	old := config.BaseForRegion
	_ = old
	accs := config.NewAccountStore()
	cat := NewModelCatalog(c, accs, testLogger(), t.TempDir())
	cat.client.HTTPClient().Transport = &hostRewriteTransport{base: srv.URL, rt: http.DefaultTransport}
	return cat, accs
}

type hostRewriteTransport struct {
	base string
	rt   http.RoundTripper
}

func (h *hostRewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	u := *req.URL
	u.Scheme = "http"
	u.Host = strings.TrimPrefix(h.base, "http://")
	clone.URL = &u
	clone.Host = u.Host
	return h.rt.RoundTrip(clone)
}

func TestFetchDetailedModels(t *testing.T) {
	var mu sync.Mutex
	calls := map[string]int{}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls[r.URL.Path]++
		mu.Unlock()
		auth := r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v3/config":
			if strings.Contains(auth, "cn-token") {
				_, _ = w.Write([]byte(`{"data":{"models":[{"id":"ds","name":"DS","vendor":"tencent"},{"id":"common"}],"modelPromotions":[{"id":"p1","modelIds":["ds"]}]}}`))
			} else if strings.Contains(auth, "intl-token") {
				_, _ = w.Write([]byte(`{"data":{"models":[{"id":"common"},{"id":"gpt"}]}}`))
			} else {
				w.WriteHeader(401)
			}
		case "/v2/chat/busy":
			if r.Method != http.MethodPost {
				w.WriteHeader(405)
				return
			}
			var body struct {
				Models []string `json:"models"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if r.Header.Get("X-Domain") != "copilot.tencent.com" || r.Header.Get("X-Product") != "SaaS" {
				w.WriteHeader(400)
				return
			}
			_, _ = w.Write([]byte(`{"code":0,"data":[{"model":"ds","busy_level":"Congested"},{"model":"common","busy_level":"idle"},{"model":"","busy_level":"busy"}]}`))
		default:
			w.WriteHeader(404)
		}
	})
	cat, accs := newTestCatalog(t, handler)
	accs.Upsert(&config.Account{UID: "a1", Status: "healthy", AccessToken: "cn-token", Region: "cn", Email: "cn@x"})
	accs.Upsert(&config.Account{UID: "a2", Status: "healthy", AccessToken: "intl-token", Region: "intl", Email: "intl@x"})
	accs.Upsert(&config.Account{UID: "a3", Status: "unauthorized", AccessToken: "bad", Region: "cn"})

	models := cat.FetchDetailedModels(false)
	if len(models) != 3 {
		t.Fatalf("models=%s", models)
	}
	byID := map[string]*Obj{}
	for _, m := range models {
		byID[GetString(m, "id")] = m
	}
	if regions := GetArr(byID["common"], "regions"); len(regions) != 2 || regions[0] != "cn" || regions[1] != "intl" {
		t.Fatalf("regions=%v", regions)
	}
	if byID["ds"].Get("busy") != "congested" || byID["ds"].Get("busy_level") != "congested" || GetString(byID["ds"], "upstreamBusyLevel") != "congested" || GetString(byID["ds"], "upstreamBusyLabel") != "🔴 拥堵" {
		t.Fatalf("busy: %s", byID["ds"])
	}
	if GetString(byID["gpt"], "upstreamBusyLevel") != "idle" || GetString(byID["gpt"], "probeStatus") != "idle" || GetString(byID["gpt"], "probeLabel") != "🟢 畅通" {
		t.Fatalf("gpt: %s", byID["gpt"])
	}
	if GetString(byID["ds"], "vendor") != "tencent" || GetString(byID["ds"], "name") != "DS" {
		t.Fatal("original fields must be preserved")
	}
	if p := GetObj(byID["ds"], "promotion"); p == nil || GetString(p, "id") != "p1" {
		t.Fatalf("promotion: %s", byID["ds"])
	}
	if byID["ds"].Get("totalAccounts") != json.Number("3") {
		t.Fatalf("totalAccounts=%v", byID["ds"].Get("totalAccounts"))
	}
	mu.Lock()
	if calls["/v3/config"] != 2 || calls["/v2/chat/busy"] != 1 {
		t.Fatalf("calls=%v", calls)
	}
	mu.Unlock()

	// 缓存命中：不再请求 /v3/config；busy 在 60s 内也走缓存
	_ = cat.FetchDetailedModels(false)
	mu.Lock()
	if calls["/v3/config"] != 2 || calls["/v2/chat/busy"] != 1 {
		t.Fatalf("cache calls=%v", calls)
	}
	mu.Unlock()

	// 冷却探测：唯一 cn 账号对 ds 冷却 → 局部限流 (1/3)
	accs.Mutate("a1", func(a *config.Account) {
		a.ModelCooldowns = map[string]int64{"ds": time.Now().Add(time.Hour).UnixMilli()}
	})
	models = cat.FetchDetailedModels(false)
	for _, m := range models {
		if GetString(m, "id") == "ds" {
			if GetString(m, "probeStatus") != "busy" || GetString(m, "probeLabel") != "🟡 局部限流 (1/3)" {
				t.Fatalf("probe: %s", m)
			}
			ca := GetArr(m, "coolingAccounts")
			if len(ca) != 1 || GetString(ca[0].(*Obj), "name") != "cn@x" || GetString(ca[0].(*Obj), "reason") != "上游频控限制 (429/6004)" {
				t.Fatalf("coolingAccounts=%v", ca)
			}
			break
		}
	}

	// 全部不可达 → 空列表并清缓存
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer srv2.Close()
	cat2 := NewModelCatalog(&Client{http: &http.Client{Transport: &hostRewriteTransport{base: srv2.URL, rt: http.DefaultTransport}}}, accs, testLogger(), t.TempDir())
	accs.Mutate("a1", func(a *config.Account) { a.Status = "healthy" })
	if got := cat2.FetchDetailedModels(true); len(got) != 0 {
		t.Fatalf("expect empty, got %d", len(got))
	}
	if cat2.cachedModels != nil || cat2.lastFetch != 0 {
		t.Fatal("cache must be cleared")
	}
}
