package adapters

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codebuddy-gateway/internal/upstream"
)

func TestResolveClientInfo(t *testing.T) {
	// X-Forwarded-For 首段优先
	r := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	r.Header.Set("X-Forwarded-For", " 1.2.3.4 , 5.6.7.8")
	r.Header.Set("User-Agent", "unit-test")
	ci := resolveClientInfo(r, true)
	if ci.IP != "1.2.3.4" || ci.UserAgent != "unit-test" || ci.Desc != " (来源: 1.2.3.4)" {
		t.Fatalf("xff 解析错误: %+v", ci)
	}
	// RemoteAddr 去端口、去 ::ffff: 前缀
	r = httptest.NewRequest(http.MethodPost, "/", nil)
	r.RemoteAddr = "::ffff:10.0.0.1:51234"
	if ci := resolveClientInfo(r, true); ci.IP != "10.0.0.1" {
		t.Fatalf("remoteAddr 解析错误: %q", ci.IP)
	}
	// IPv6 回环
	r = httptest.NewRequest(http.MethodPost, "/", nil)
	r.RemoteAddr = "[::1]:51234"
	if ci := resolveClientInfo(r, true); ci.IP != "::1" {
		t.Fatalf("ipv6 解析错误: %q", ci.IP)
	}
	// UA 截 150 个 UTF-16 码元
	r = httptest.NewRequest(http.MethodPost, "/", nil)
	r.Header.Set("User-Agent", strings.Repeat("中", 160))
	if ci := resolveClientInfo(r, true); upstream.JSLength(ci.UserAgent) != 150 {
		t.Fatalf("UA 截断长度错误: %d", upstream.JSLength(ci.UserAgent))
	}
	// 关闭客户端信息采集
	if ci := resolveClientInfo(r, false); ci.IP != "" || ci.UserAgent != "" || ci.Desc != "" {
		t.Fatalf("关闭后应为空: %+v", ci)
	}
}

func TestUsageSemantics(t *testing.T) {
	if got := usageInt(nil, "input_tokens", 7); got != 7 {
		t.Fatalf("nil usage 应回落默认值, got %d", got)
	}
	u, _ := upstream.ParseObj([]byte(`{"prompt_tokens":0,"prompt_tokens_details":{"cached_tokens":5},"cache_read_input_tokens":0}`))
	if got := usageInt(u, "prompt_tokens", 9); got != 0 {
		t.Fatalf("?? 语义应保留 0, got %d", got)
	}
	if got := usageIntTruthy(u, "cache_read_input_tokens", "prompt_tokens_details.cached_tokens"); got != 5 {
		t.Fatalf("|| 语义应跳过 0 取 5, got %d", got)
	}
	if got := usageFirstNonNull(u, "cache_read_input_tokens", "prompt_tokens_details.cached_tokens"); got != 0 {
		t.Fatalf("?? 链应保留首个非空 0, got %d", got)
	}
	if got := usageIntTruthy(nil, "x"); got != 0 {
		t.Fatalf("nil usage 应为 0, got %d", got)
	}
}

func TestScanSSELines(t *testing.T) {
	var got []string
	scanSSELines("data: {\"a\":1}\n\n: keepalive\ndata: [DONE]\ndata: partial", func(s string) { got = append(got, s) })
	if len(got) != 2 || got[0] != `{"a":1}` || got[1] != "[DONE]" {
		t.Fatalf("SSE 扫描错误（末尾未结束行应丢弃）: %v", got)
	}
}

func TestToolCallAccum(t *testing.T) {
	acc := &toolCallAccum{by: map[int]*toolCallItem{}, newID: func() string { return "call_gen" }}
	mk := func(s string) *upstream.Obj {
		o, err := upstream.ParseObj([]byte(s))
		if err != nil {
			t.Fatal(err)
		}
		return o
	}
	acc.observe(mk(`{"tool_calls":[{"index":1,"function":{"name":"b","arguments":"{"}}]}`))
	acc.observe(mk(`{"tool_calls":[{"index":0,"id":"call_0","function":{"name":"a"}}]}`))
	acc.observe(mk(`{"tool_calls":[{"index":1,"function":{"arguments":"}"}}]}`))
	if len(acc.order) != 2 || acc.order[0] != 1 || acc.order[1] != 0 {
		t.Fatalf("顺序应保持首次出现: %v", acc.order)
	}
	if acc.by[1].ID != "call_gen" || acc.by[1].Args != "{}" || acc.by[1].Name != "b" {
		t.Fatalf("index1 合并错误: %+v", acc.by[1])
	}
	if acc.by[0].ID != "call_0" || acc.by[0].Name != "a" {
		t.Fatalf("index0 合并错误: %+v", acc.by[0])
	}
	calls := acc.openAIToolCalls()
	if len(calls) != 2 {
		t.Fatalf("应输出 2 个 tool_calls, got %d", len(calls))
	}
	first := calls[0].(*upstream.Obj)
	if upstream.GetString(first, "id") != "call_gen" || upstream.GetString(upstream.GetObj(first, "function"), "arguments") != "{}" {
		t.Fatalf("openai tool_calls 输出错误: %s", jsonStringify(first))
	}
	if names := acc.names(); len(names) != 2 || names[0] != "b" || names[1] != "a" {
		t.Fatalf("names 顺序错误: %v", names)
	}
}

func TestExtractBizCode(t *testing.T) {
	mk := func(s string) *upstream.Obj {
		o, _ := upstream.ParseObj([]byte(s))
		return o
	}
	b := extractBizCode(mk(`{"error":{"code":11158,"msg":"x"}}`))
	if !b.HasNum || b.Num != 11158 {
		t.Fatalf("应提取数字码 11158: %+v", b)
	}
	b = extractBizCode(mk(`{"code":"rate_limited"}`))
	if !b.Has || b.Str != "rate_limited" || b.HasNum {
		t.Fatalf("应提取字符串码: %+v", b)
	}
	if extractBizCode(nil).Has {
		t.Fatal("nil 不应有业务码")
	}
}

func TestAnthropicEffort(t *testing.T) {
	mk := func(s string) any {
		o, _ := upstream.ParseObj([]byte(s))
		return o
	}
	cases := []struct {
		in   any
		want any
	}{
		{mk(`{"type":"enabled","budget_tokens":1024}`), "minimal"},
		{mk(`{"type":"enabled","budget_tokens":2048}`), "low"},
		{mk(`{"type":"enabled","budget_tokens":8192}`), "medium"},
		{mk(`{"type":"enabled","budget_tokens":16384}`), "high"},
		{mk(`{"type":"enabled","budget_tokens":32768}`), "xhigh"},
		{mk(`{"type":"enabled","budget_tokens":0}`), "high"},
		{mk(`{"type":"disabled"}`), "none"},
		{true, "high"},
		{false, "none"},
		{"enabled", nil},
	}
	for _, c := range cases {
		if got := anthropicEffort(c.in); got != c.want {
			t.Fatalf("anthropicEffort(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestConvertAnthropicMessages(t *testing.T) {
	payload, err := upstream.ParseObj([]byte(`{
		"system":[{"type":"text","text":"A"},{"type":"text","text":"B"}],
		"messages":[
			{"role":"user","content":[{"type":"text","text":"hi"},{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"QUJD"}}]},
			{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{"city":"深圳"}}]},
			{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"sunny"}]},
			{"role":"user","content":"plain"}
		]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	msgs := convertAnthropicMessages(payload)
	if len(msgs) != 5 {
		t.Fatalf("应产出 5 条消息, got %d", len(msgs))
	}
	if upstream.GetString(msgs[0], "role") != "system" || upstream.GetString(msgs[0], "content") != "A\nB" {
		t.Fatalf("system 拼接错误: %s", jsonStringify(msgs[0]))
	}
	m1 := jsonStringify(msgs[1])
	if !strings.Contains(m1, `"content":["hi",`) || !strings.Contains(m1, `"url":"data:image/jpeg;base64,QUJD"`) {
		t.Fatalf("文本/图片转换错误: %s", m1)
	}
	m2 := jsonStringify(msgs[2])
	if !strings.Contains(m2, `"role":"assistant"`) || !strings.Contains(m2, `"arguments":"{\"city\":\"深圳\"}"`) || !strings.Contains(m2, `"type":"function"`) {
		t.Fatalf("tool_use 转换错误: %s", m2)
	}
	m3 := jsonStringify(msgs[3])
	if !strings.Contains(m3, `"role":"tool"`) || !strings.Contains(m3, `"tool_call_id":"toolu_1"`) || !strings.Contains(m3, `"content":"sunny"`) {
		t.Fatalf("tool_result 转换错误: %s", m3)
	}
	if upstream.GetString(msgs[4], "content") != "plain" {
		t.Fatalf("纯文本消息错误: %s", jsonStringify(msgs[4]))
	}
	// 单元素文本数组应折叠为字符串
	p2, _ := upstream.ParseObj([]byte(`{"messages":[{"role":"user","content":[{"type":"text","text":"only"}]}]}`))
	m := convertAnthropicMessages(p2)
	if len(m) != 1 || upstream.GetString(m[0], "content") != "only" {
		t.Fatalf("单文本应折叠为字符串: %s", jsonStringify(m[0]))
	}
}

func TestJSUtilities(t *testing.T) {
	if got := jsonStringify(map[string]any{"a": "<b>"}); got != `{"a":"<b>"}` {
		t.Fatalf("jsonStringify 不应转义 HTML: %s", got)
	}
	if got := numAsAny(3.0); got != upstream.Num(3) {
		t.Fatalf("整数应无小数点: %v", got)
	}
	if jsRound(2.5) != 3 || jsRound(-2.5) != -2 || jsRound(1.4) != 1 {
		t.Fatal("jsRound 与 Math.round 不一致")
	}
	if got := nullishOr(nil, "k", "def"); got != "def" {
		t.Fatalf("nullishOr nil 错误: %v", got)
	}
	o, _ := upstream.ParseObj([]byte(`{"k":0}`))
	if got := nullishOr(o, "k", "def"); upstream.ToStr(got) != "0" {
		t.Fatalf("nullishOr 0 应保留: %v", got)
	}
	arr, _ := upstream.ParseAny([]byte(`[1,{"a":1},"x"]`))
	if got := objArr(arr); len(got) != 1 {
		t.Fatalf("objArr 应只保留对象: %d", len(got))
	}
	chunk, _ := upstream.ParseObj([]byte(`{"choices":[{"delta":{"content":"x"}}]}`))
	if fc := firstChoice(chunk); upstream.GetString(upstream.GetObj(fc, "delta"), "content") != "x" {
		t.Fatal("firstChoice 错误")
	}
	if _, err := parsePayload([]byte(`[1,2]`)); err != nil {
		t.Fatalf("数组载荷应视为空对象: %v", err)
	}
	if _, err := parsePayload([]byte(`null`)); err == nil {
		t.Fatal("null 载荷应报错")
	}
	if _, err := parsePayload([]byte(`{bad`)); err == nil {
		t.Fatal("非法 JSON 应报错")
	}
}
