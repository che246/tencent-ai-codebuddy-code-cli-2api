// Package adapters 对应 src/adapters/*.mjs：
// OpenAI 协议（/v1/models、/v1/chat/completions）、Anthropic 协议（/v1/messages）
// 与联网工具透传（/v1/search、/v1/webfetch）。
//
// 本包只做协议翻译与请求编排，所有超时/重试/空流判定均来自 internal/upstream（CLI 同源常量）。
package adapters

import (
	"encoding/json"
	"io"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/logger"
	"codebuddy-gateway/internal/core/metrics"
	"codebuddy-gateway/internal/core/scheduler"
	"codebuddy-gateway/internal/upstream"
)

// Deps 适配层依赖（由 cmd/gateway 组装后注入）。
type Deps struct {
	Store   *config.Store
	Sched   *scheduler.Scheduler
	Models  *upstream.ModelCatalog
	Metrics *metrics.Store
	Client  *upstream.Client
	Lg      *logger.Logger
}

// ─── 下游 SSE 写出 ─────────────────────────────────────────────────────────────

// SSEWriter 实现 upstream.FrameWriter：包一层 http.ResponseWriter，
// 写失败（客户端已断开）时置 ended，后续写入直接丢弃（对应 res.writableEnded || res.destroyed）。
type SSEWriter struct {
	w     http.ResponseWriter
	flush http.Flusher

	mu    sync.Mutex
	sent  bool
	ended bool
}

// NewSSEWriter 创建 SSE 写出器。
func NewSSEWriter(w http.ResponseWriter) *SSEWriter {
	s := &SSEWriter{w: w}
	if f, ok := w.(http.Flusher); ok {
		s.flush = f
	}
	return s
}

// SetHeader 设置响应头（必须在首次 Write 前调用）。
func (s *SSEWriter) SetHeader(k, v string) { s.w.Header().Set(k, v) }

// WriteHead 显式发送状态码（幂等；未发送过才写）。
func (s *SSEWriter) WriteHead(status int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sent || s.ended {
		return
	}
	s.sent = true
	s.w.WriteHeader(status)
}

// Write 写出一帧并 Flush；返回 false 表示客户端已断开。
func (s *SSEWriter) Write(raw string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended {
		return false
	}
	s.sent = true
	if _, err := s.w.Write([]byte(raw)); err != nil {
		s.ended = true
		return false
	}
	if s.flush != nil {
		s.flush.Flush()
	}
	return true
}

// Ended 下游是否已结束/断开。
func (s *SSEWriter) Ended() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ended
}

// Sent 是否已经发出过响应头/正文（已发出则不能再写 JSON 错误响应）。
func (s *SSEWriter) Sent() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sent
}

// End 标记下游已结束（handler 返回后 net/http 自动结束响应）。
func (s *SSEWriter) End() {
	s.mu.Lock()
	s.ended = true
	s.mu.Unlock()
}

// ─── JSON 响应 ─────────────────────────────────────────────────────────────────

// writeJSON 对应 res.writeHead(status, {'Content-Type': 'application/json'}) + res.end(JSON.stringify(v))；
// 使用不转义 HTML 的序列化以与 JSON.stringify 一致。
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	b, err := upstream.MarshalJSON(v)
	if err != nil {
		b = []byte(`{"error":{"message":"internal serialization error","type":"api_error"}}`)
	}
	_, _ = w.Write(b)
}

// jsonStringify JSON.stringify（不转义 HTML）；失败返回 "null"（JSON.stringify(undefined) 语义近似）。
func jsonStringify(v any) string {
	b, err := upstream.MarshalJSON(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

// ─── 请求侧信息 ─────────────────────────────────────────────────────────────────

// clientInfo 对应 openai.mjs:123-131 / anthropic.mjs:74-82 的 requestClientInfo 逻辑。
type clientInfo struct {
	IP        string
	UserAgent string
	Desc      string
}

// resolveClientInfo 解析客户端 IP / UA；enabled=false 时全部为空。
func resolveClientInfo(r *http.Request, enabled bool) clientInfo {
	if !enabled {
		return clientInfo{}
	}
	var ip string
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		ip = strings.TrimSpace(strings.Split(xff, ",")[0])
	} else {
		// Node 的 req.socket.remoteAddress 不含端口；Go 的 RemoteAddr 形如 host:port / [::ffff:a.b.c.d]:port
		remote := r.RemoteAddr
		if host, _, err := net.SplitHostPort(remote); err == nil {
			remote = host
		} else if i := strings.LastIndex(remote, ":"); i > strings.LastIndex(remote, "]") && i > 0 {
			// 无括号的 "10.0.0.1:port" / "::ffff:10.0.0.1:port" 形态：去掉最后一个冒号后的端口
			remote = remote[:i]
		}
		ip = strings.TrimPrefix(remote, "::ffff:")
	}
	ua := r.Header.Get("User-Agent")
	if len(ua) > 150 {
		// JS slice(0,150) 按 UTF-16 码元；这里按字节截断后修正到 rune 边界
		ua = jsSlice0(ua, 150)
	}
	ci := clientInfo{IP: ip, UserAgent: ua}
	if ip != "" {
		ci.Desc = " (来源: " + ip + ")"
	}
	return ci
}

// jsSlice0 等价 s.slice(0, n)（按 UTF-16 码元）。
func jsSlice0(s string, n int) string {
	var b strings.Builder
	count := 0
	for _, r := range s {
		units := 1
		if r > 0xFFFF {
			units = 2
		}
		if count+units > n {
			break
		}
		b.WriteRune(r)
		count += units
	}
	return b.String()
}

// buildLogMeta 构造 {toolsCount, messagesCount[, clientIp][, userAgent][, context]}（键序与 Node 一致）。
func buildLogMeta(toolsCount, messagesCount int, ci clientInfo, withClientInfo bool, archiveCtx *upstream.Obj, withCtx bool) *logger.Meta {
	m := logger.NewMeta("toolsCount", toolsCount, "messagesCount", messagesCount)
	if withClientInfo {
		if ci.IP != "" {
			m.Set("clientIp", ci.IP)
		}
		if ci.UserAgent != "" {
			m.Set("userAgent", ci.UserAgent)
		}
	}
	if withCtx && archiveCtx != nil {
		m.Set("context", archiveCtx)
	}
	return m
}

// arrLen JS `(arr)?.length || 0`。
func arrLen(o *upstream.Obj, k string) int {
	return len(upstream.GetArr(o, k))
}

// ─── JS 语义小工具 ──────────────────────────────────────────────────────────────

// nullishOr `obj[k] ?? def`：仅 null/undefined 回落。
func nullishOr(o *upstream.Obj, k string, def any) any {
	v, ok := o.GetOK(k)
	if !ok || v == nil {
		return def
	}
	return v
}

// numAsAny 把 float64 还原为 JSON 数字（整数不带小数点），与 JS Number 序列化一致。
func numAsAny(f float64) any {
	if f == math.Trunc(f) && math.Abs(f) < 1e15 {
		return upstream.Num(int64(f))
	}
	return json.Number(strconv.FormatFloat(f, 'f', -1, 64))
}

// jsRound Math.round：(.5 向正无穷取整)。
func jsRound(x float64) int64 {
	return int64(math.Floor(x + 0.5))
}

// maxInt64 两者取大。
func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// usageInt 读取 usage[k] 的整数值（`usage?.k ?? def`：缺失/null 回落，0 保留）。
func usageInt(usage *upstream.Obj, k string, def int64) int64 {
	if usage == nil {
		return def
	}
	v, ok := usage.GetOK(k)
	if !ok || v == nil {
		return def
	}
	f, ok := upstream.GetNum(v)
	if !ok {
		return def
	}
	return int64(f)
}

// getPath 读取可能带点的嵌套键（a.b.c）。
func getPath(o *upstream.Obj, k string) (any, bool) {
	cur := o
	parts := strings.Split(k, ".")
	for i, part := range parts {
		v, ok := cur.GetOK(part)
		if !ok || v == nil {
			return nil, false
		}
		if i == len(parts)-1 {
			return v, true
		}
		n, isObj := v.(*upstream.Obj)
		if !isObj {
			return nil, false
		}
		cur = n
	}
	return nil, false
}

// usageIntTruthy `usage?.a || usage?.b || ... || 0`（JS ||：0/缺失均继续回落）。
func usageIntTruthy(usage *upstream.Obj, keys ...string) int64 {
	if usage == nil {
		return 0
	}
	for _, k := range keys {
		if v, ok := getPath(usage, k); ok {
			if f, isNum := upstream.GetNum(v); isNum && f != 0 {
				return int64(f)
			}
		}
	}
	return 0
}

// readAllAndClose 读完并关闭响应体。
func readAllAndClose(rc io.ReadCloser) string {
	defer rc.Close()
	b, _ := io.ReadAll(rc)
	return string(b)
}

// setMapKeys 有序取出 map 的键（attemptedUids → Array.from）。
func setMapKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		if v {
			out = append(out, k)
		}
	}
	return out
}

// stepLabel `${region ? region+':' : ”}${model}`。
func stepLabel(model, region string) string {
	if region != "" {
		return region + ":" + model
	}
	return model
}

// fmtChainSteps `[a -> b -> c]`。
func fmtChainSteps(steps []chainStep) string {
	parts := make([]string, 0, len(steps))
	for _, s := range steps {
		parts = append(parts, stepLabel(s.Model, s.Region))
	}
	return "[" + strings.Join(parts, " -> ") + "]"
}

// toString 实现 fmt.Stringer，便于 %s 占位（与 Display("") 一致）。
func (b bizCode) toString() string { return b.Display("") }

// usageFirstNonNull `usage?.a ?? usage?.b ?? ... ?? 0`：仅 null/undefined 回落，0 保留。
func usageFirstNonNull(usage *upstream.Obj, keys ...string) int64 {
	if usage == nil {
		return 0
	}
	for _, k := range keys {
		v, ok := getPath(usage, k)
		if !ok {
			continue
		}
		if f, isNum := upstream.GetNum(v); isNum {
			return int64(f)
		}
		return 0
	}
	return 0
}

// ─── SSE / 载荷解析辅助 ─────────────────────────────────────────────────────────

// parsePayload JSON.parse(rawBody)：非对象（数组/数字等）按“无任何属性的对象”处理，与 JS 属性访问语义一致。
func parsePayload(rawBody []byte) (*upstream.Obj, error) {
	v, err := upstream.ParseAny(rawBody)
	if err != nil {
		return nil, err
	}
	switch t := v.(type) {
	case *upstream.Obj:
		return t, nil
	case nil:
		return nil, errNullPayload
	}
	return upstream.NewObj(), nil
}

// objArr 把 []any 中的对象元素过滤为 []*Obj（非对象元素跳过）。
func objArr(v any) []*upstream.Obj {
	arr, _ := v.([]any)
	out := make([]*upstream.Obj, 0, len(arr))
	for _, it := range arr {
		if o, ok := it.(*upstream.Obj); ok {
			out = append(out, o)
		}
	}
	return out
}

// firstChoice `chunk.choices?.[0]`（仅当为对象时返回）。
func firstChoice(chunk *upstream.Obj) *upstream.Obj {
	arr := upstream.GetArr(chunk, "choices")
	if len(arr) == 0 {
		return nil
	}
	c, _ := arr[0].(*upstream.Obj)
	return c
}

// boolStr JS 模板字符串中的布尔值。
func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// scanSSELines 按行扫描 SSE 文本（Node 版 buffer.split('\n') + lines.pop()：末尾未结束的行片不处理），
// 对每个 `data:` 行回调去前缀去空白后的内容。
func scanSSELines(all string, onData func(dataStr string)) {
	lines := strings.Split(all, "\n")
	if len(lines) == 0 {
		return
	}
	lines = lines[:len(lines)-1]
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "data:") {
			continue
		}
		onData(strings.TrimSpace(trimmed[5:]))
	}
}

// toolCallItem 非流式拼装中的单个工具调用。
type toolCallItem struct{ ID, Name, Args string }

// toolCallAccum 对应 `toolCallsMap = new Map()`：按 index 合并 id/name/arguments（保持首次出现顺序）。
type toolCallAccum struct {
	order []int
	by    map[int]*toolCallItem
	newID func() string
}

// observe 合并 delta.tool_calls。
func (t *toolCallAccum) observe(delta *upstream.Obj) {
	for _, v := range upstream.GetArr(delta, "tool_calls") {
		tc, ok := v.(*upstream.Obj)
		if !ok {
			continue
		}
		idx := 0
		if f, ok := upstream.GetNum(tc.Get("index")); ok {
			idx = int(f)
		}
		item := t.by[idx]
		if item == nil {
			id := upstream.GetString(tc, "id")
			if id == "" {
				id = t.newID()
			}
			item = &toolCallItem{ID: id}
			t.by[idx] = item
			t.order = append(t.order, idx)
		}
		if s := upstream.GetString(tc, "id"); s != "" {
			item.ID = s
		}
		fn := upstream.GetObj(tc, "function")
		if s := upstream.GetString(fn, "name"); s != "" {
			item.Name = s
		}
		if s := upstream.GetString(fn, "arguments"); s != "" {
			item.Args += s
		}
	}
}

// openAIToolCalls OpenAI 格式 [{id, type:'function', function:{name, arguments}}]。
func (t *toolCallAccum) openAIToolCalls() []any {
	out := make([]any, 0, len(t.order))
	for _, idx := range t.order {
		it := t.by[idx]
		out = append(out, upstream.NewObj().Set("id", it.ID).Set("type", "function").
			Set("function", upstream.NewObj().Set("name", it.Name).Set("arguments", it.Args)))
	}
	return out
}

// names 工具名列表（日志用）。
func (t *toolCallAccum) names() []string {
	out := make([]string, 0, len(t.order))
	for _, idx := range t.order {
		out = append(out, t.by[idx].Name)
	}
	return out
}

// items 按首次出现顺序返回合并后的工具调用。
func (t *toolCallAccum) items() []*toolCallItem {
	out := make([]*toolCallItem, 0, len(t.order))
	for _, idx := range t.order {
		out = append(out, t.by[idx])
	}
	return out
}

type strErr string

func (e strErr) Error() string { return string(e) }

const errNullPayload = strErr("Cannot read properties of null (reading 'stream')")
