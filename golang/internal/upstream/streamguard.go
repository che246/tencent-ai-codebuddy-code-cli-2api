package upstream

import (
	"context"
	"errors"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"codebuddy-gateway/internal/core/logger"
)

// ─── 流式稳定性保障（stream-guard.mjs） ─────────────────────────────────────────
// 超时与保活参数以官方 CLI 端实现为准（见 cliconsts.go），不做主观取值。
// CLI 端不会因为"流里没有 finish_reason"就判错，只判定"有没有实质内容"（hasSubstantiveContent），
// 首 token 超时给到 20 分钟；网关侧放宽到同等量级，避免"官方能跑、网关先掐断"。

// 请求终止原因（stream-guard.mjs:57）。
const (
	ReasonClientGone       = "client-gone"
	ReasonFirstByteTimeout = "first-byte-timeout"
	ReasonIdleTimeout      = "idle-timeout"
	ReasonError            = "error"
)

// Lifecycle 一次上游请求的生命周期控制器（stream-guard.mjs:53-149）。
// 组合了：可取消 ctx（AbortController）、首字节超时、客户端断开监听（parent ctx Done）。
type Lifecycle struct {
	label   string
	lg      *logger.Logger
	ctx     context.Context
	cancel  context.CancelCauseFunc
	watchOK chan struct{} // watcher 退出后关闭

	mu             sync.Mutex
	aborted        bool
	reason         string
	clientGone     bool
	upstreamEnded  bool
	finished       bool
	firstByteTimer *time.Timer
}

// NewLifecycle 创建生命周期；parent 应为下游请求 ctx（客户端断开时 Done）。
func NewLifecycle(parent context.Context, label string, lg *logger.Logger) *Lifecycle {
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancelCause(parent)
	lc := &Lifecycle{label: label, lg: lg, ctx: ctx, cancel: cancel, watchOK: make(chan struct{})}
	if FirstByteTimeoutMs > 0 {
		t := time.AfterFunc(time.Duration(FirstByteTimeoutMs)*time.Millisecond, func() {
			logWarn(lg, "STREAM", "["+label+"] 上游首字节超时 ("+Itoa(FirstByteTimeoutMs)+"ms)，已中止请求")
			lc.Abort(ReasonFirstByteTimeout)
		})
		// 回调可能在赋值前就已触发，因此赋值必须与 Abort 的读取同锁
		lc.mu.Lock()
		lc.firstByteTimer = t
		lc.mu.Unlock()
	}
	go lc.watchParent(parent)
	return lc
}

// watchParent 客户端断开检测：只看下游请求 ctx（Node 版只监听 res 的 close，不用 req 的 close）。
func (lc *Lifecycle) watchParent(parent context.Context) {
	defer close(lc.watchOK)
	select {
	case <-parent.Done():
		lc.onClientGone()
	case <-lc.ctx.Done():
	}
}

func (lc *Lifecycle) onClientGone() {
	lc.mu.Lock()
	if lc.clientGone || lc.finished || lc.upstreamEnded {
		lc.mu.Unlock()
		return
	}
	lc.clientGone = true
	lc.mu.Unlock()
	logInfo(lc.lg, "STREAM", "["+lc.label+"] 客户端已断开，中止上游请求")
	lc.Abort(ReasonClientGone)
}

// Abort 中止（幂等）；reason 记录首次原因。
func (lc *Lifecycle) Abort(reason string) {
	lc.mu.Lock()
	if lc.aborted {
		lc.mu.Unlock()
		return
	}
	lc.aborted = true
	lc.reason = reason
	if lc.firstByteTimer != nil {
		lc.firstByteTimer.Stop()
		lc.firstByteTimer = nil
	}
	lc.mu.Unlock()
	lc.cancel(errors.New(reason))
}

func (lc *Lifecycle) setReasonIfEmpty(reason string) {
	lc.mu.Lock()
	if lc.reason == "" {
		lc.reason = reason
	}
	lc.mu.Unlock()
}

func (lc *Lifecycle) stopFirstByteTimer() {
	lc.mu.Lock()
	if lc.firstByteTimer != nil {
		lc.firstByteTimer.Stop()
		lc.firstByteTimer = nil
	}
	lc.mu.Unlock()
}

// Ctx 用于上游 fetch 的 ctx（等价 controller.signal）。
func (lc *Lifecycle) Ctx() context.Context { return lc.ctx }

// MarkFirstByte 收到响应头时调用：清首字节定时器。
func (lc *Lifecycle) MarkFirstByte() { lc.stopFirstByteTimer() }

// MarkFinished 正常结束：标记完成，后续客户端 close 不再算断开。
func (lc *Lifecycle) MarkFinished() {
	lc.mu.Lock()
	lc.finished = true
	lc.mu.Unlock()
	lc.stopFirstByteTimer()
}

// MarkUpstreamEnded 上游已经把话说完（[DONE] / finish_reason / 流尾）；此后客户端挂断属正常收尾。
func (lc *Lifecycle) MarkUpstreamEnded() {
	lc.mu.Lock()
	lc.upstreamEnded = true
	lc.mu.Unlock()
}

// IsUpstreamEnded 上游是否已收尾。
func (lc *Lifecycle) IsUpstreamEnded() bool {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	return lc.upstreamEnded
}

// IsClientGone 是否因客户端断开而中止。
func (lc *Lifecycle) IsClientGone() bool { return lc.Reason() == ReasonClientGone }

// Reason 首次中止原因（"" 表示未中止）。
func (lc *Lifecycle) Reason() string {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	return lc.reason
}

// Aborted 是否已中止。
func (lc *Lifecycle) Aborted() bool {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	return lc.aborted
}

// Dispose 请求彻底结束时调用：清理定时器与监听 goroutine。
func (lc *Lifecycle) Dispose() {
	lc.stopFirstByteTimer()
	lc.cancel(errors.New("disposed"))
	<-lc.watchOK
}

// ReadOpts 读取选项（stream-guard.mjs:159）。
type ReadOpts struct {
	OnChunk     func(string)
	OnKeepalive func()
	Label       string
	// NoStopOnDone 对应 opts.stopOnDone === false；默认（false）收到 [DONE] 即停止读取。
	NoStopOnDone bool
}

// StreamResult 读取结果（stream-guard.mjs:231-240）。
type StreamResult struct {
	SawDone            bool
	Err                error
	UpstreamEnded      bool
	Aborted            bool
	AbortedByClient    bool
	AbortedByIdle      bool
	AbortedByFirstByte bool
}

// TERMINAL_RE（stream-guard.mjs:182）：`"finish_reason"\s*:\s*"(?!null)|"type"\s*:\s*"message_stop"`
// Go RE2 不支持 (?!...) 前瞻，拆成两个子表达式并在代码里排除 null。
var (
	doneRe           = regexp.MustCompile(`\[DONE\]`)
	terminalFinishRe = regexp.MustCompile(`"finish_reason"\s*:\s*"([a-zA-Z_]+)"`)
	messageStopRe    = regexp.MustCompile(`"type"\s*:\s*"message_stop"`)
)

func sawTerminal(str string) bool {
	if messageStopRe.MatchString(str) {
		return true
	}
	for _, m := range terminalFinishRe.FindAllStringSubmatch(str, -1) {
		if m[1] != "null" {
			return true
		}
	}
	return false
}

// ReadUpstreamStream 带静默看门狗的 SSE 流读取器（stream-guard.mjs:159-241）。
// 每读到数据刷新计时；静默超过 StreamIdleTimeoutMs 就中止上游。
// 收到 [DONE] 即视为读完（提前 break 时由调用方 Body.Close() 释放上游连接）。
func ReadUpstreamStream(r io.Reader, lc *Lifecycle, opts ReadOpts) StreamResult {
	label := opts.Label
	var idleMu sync.Mutex
	var idleTimer *time.Timer
	resetIdle := func() {
		idleMu.Lock()
		defer idleMu.Unlock()
		if idleTimer != nil {
			idleTimer.Stop()
		}
		if StreamIdleTimeoutMs > 0 {
			idleTimer = time.AfterFunc(time.Duration(StreamIdleTimeoutMs)*time.Millisecond, func() {
				logWarn(lc.lg, "STREAM", "["+label+"] 上游流静默超过 "+Itoa(StreamIdleTimeoutMs)+"ms，判定断流")
				lc.setReasonIfEmpty(ReasonIdleTimeout)
				lc.Abort(ReasonIdleTimeout)
				if opts.OnKeepalive != nil {
					opts.OnKeepalive()
				}
			})
		}
	}
	stopIdle := func() {
		idleMu.Lock()
		if idleTimer != nil {
			idleTimer.Stop()
			idleTimer = nil
		}
		idleMu.Unlock()
	}
	resetIdle()
	sawDone := false
	var lastError error
	tail := ""
	dec := &utf8StreamDecoder{}
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			resetIdle()
			str := dec.Decode(buf[:n])
			if str != "" {
				probe := tail + str
				tail = jsTail(probe, 12)
				if doneRe.MatchString(probe) || sawTerminal(str) {
					lc.MarkUpstreamEnded()
				}
				if opts.OnChunk != nil {
					opts.OnChunk(str)
				}
				// 关键：上游发完 [DONE] 后常常不主动关连接；客户端拿到终态帧就自己挂断了，
				// 继续等 reader.done 会把每次正常完成都拖成「客户端先断开」。收到 [DONE] 即视为读完。
				if !opts.NoStopOnDone && doneRe.MatchString(probe) {
					sawDone = true
					break
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				sawDone = true
				lc.MarkUpstreamEnded()
			} else {
				lastError = err
			}
			break
		}
	}
	stopIdle()
	return StreamResult{
		SawDone:            sawDone,
		Err:                lastError,
		UpstreamEnded:      lc.IsUpstreamEnded(),
		Aborted:            lc.Aborted(),
		AbortedByClient:    lc.Reason() == ReasonClientGone,
		AbortedByIdle:      lc.Reason() == ReasonIdleTimeout,
		AbortedByFirstByte: lc.Reason() == ReasonFirstByteTimeout,
	}
}

// jsTail 等价 s.slice(-n)（按 rune 近似 UTF-16 码元）。
func jsTail(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[len(r)-n:])
}

// utf8StreamDecoder 等价 TextDecoder 的 stream:true 模式：跨 chunk 的不完整 UTF-8 序列留到下次拼接。
type utf8StreamDecoder struct{ pending []byte }

func (d *utf8StreamDecoder) Decode(b []byte) string {
	data := append(d.pending, b...)
	d.pending = nil
	cut := len(data)
	// 末尾最多回看 3 个字节找到序列起始字节；不足一个完整 rune 的尾巴留到下次
	for i := len(data) - 1; i >= 0 && i >= len(data)-3; i-- {
		if utf8.RuneStart(data[i]) {
			if !utf8.FullRune(data[i:]) {
				cut = i
			}
			break
		}
	}
	if cut < len(data) {
		d.pending = append([]byte(nil), data[cut:]...)
	}
	return string(data[:cut])
}

// ─── SSE 保活（stream-guard.mjs:260-319） ──────────────────────────────────────

// FrameWriter 下游 SSE 写出抽象（adapters.SSEWriter 实现）；Write 失败返回 false。
type FrameWriter interface {
	Write(raw string) bool
	Ended() bool
}

// Heartbeat 在长静默期向客户端补发语义合法且内容为空的真实事件。
type Heartbeat struct {
	w        FrameWriter
	label    string
	protocol string
	getMeta  func() (id, model string)
	interval time.Duration

	mu        sync.Mutex
	lastWrite int64
	pingCount int

	ticker   *time.Ticker
	done     chan struct{}
	finished chan struct{}
	noop     bool
}

// StartHeartbeat 启动保活；protocol 为 "openai" | "anthropic"；HeartbeatIntervalMs<=0 时为空操作。
func StartHeartbeat(w FrameWriter, label, protocol string, getMeta func() (string, string)) *Heartbeat {
	if HeartbeatIntervalMs <= 0 {
		return &Heartbeat{noop: true}
	}
	if protocol != "anthropic" {
		protocol = "openai"
	}
	if getMeta == nil {
		getMeta = func() (string, string) { return "", "" }
	}
	h := &Heartbeat{
		w: w, label: label, protocol: protocol, getMeta: getMeta,
		interval:  time.Duration(HeartbeatIntervalMs) * time.Millisecond,
		lastWrite: time.Now().UnixMilli(),
		ticker:    time.NewTicker(time.Duration(HeartbeatIntervalMs) * time.Millisecond),
		done:      make(chan struct{}),
		finished:  make(chan struct{}),
	}
	go h.loop()
	return h
}

func (h *Heartbeat) loop() {
	defer close(h.finished)
	for {
		select {
		case <-h.done:
			return
		case <-h.ticker.C:
			if h.w.Ended() {
				return
			}
			h.mu.Lock()
			idle := time.Now().UnixMilli() - h.lastWrite
			h.mu.Unlock()
			if idle < h.interval.Milliseconds() {
				continue
			}
			if h.w.Write(h.buildFrame()) {
				h.mu.Lock()
				h.lastWrite = time.Now().UnixMilli()
				h.pingCount++
				h.mu.Unlock()
			}
		}
	}
}

// buildKeepaliveFrame 构造一个客户端可识别、但不产生任何内容的保活帧。
func (h *Heartbeat) buildFrame() string {
	if h.protocol == "anthropic" {
		return "event: ping\ndata: {\"type\": \"ping\"}\n\n"
	}
	id, model := h.getMeta()
	if id == "" {
		id = "chatcmpl-keepalive-" + Itoa(int(time.Now().UnixMilli()))
	}
	if model == "" {
		model = "unknown"
	}
	idJ, _ := MarshalJSON(id)
	modelJ, _ := MarshalJSON(model)
	var b strings.Builder
	b.WriteString("data: {\"id\":")
	b.Write(idJ)
	b.WriteString(",\"object\":\"chat.completion.chunk\",\"created\":")
	b.WriteString(Itoa(int(time.Now().Unix())))
	b.WriteString(",\"model\":")
	b.Write(modelJ)
	b.WriteString(",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":null}]}\n\n")
	return b.String()
}

// Touch 告知「刚有内容真正写给了客户端」；只能在真的写入语义内容后调用。
func (h *Heartbeat) Touch() {
	if h.noop {
		return
	}
	h.mu.Lock()
	h.lastWrite = time.Now().UnixMilli()
	h.mu.Unlock()
}

// PingCount 已发送的保活帧数量。
func (h *Heartbeat) PingCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.pingCount
}

// IdleMs 距上次真实写入的毫秒数。
func (h *Heartbeat) IdleMs() int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return time.Now().UnixMilli() - h.lastWrite
}

// Stop 停止保活并返回已发送帧数（等待 goroutine 退出）。
func (h *Heartbeat) Stop() int {
	if h.noop {
		return 0
	}
	h.ticker.Stop()
	close(h.done)
	<-h.finished
	return h.PingCount()
}

// ─── 空流判定（完全移植自官方 CLI 端）（stream-guard.mjs:322-383） ─────────────

// DeltaClassifier 官方 ModelProvider 的三标志分类累积器：
//
//	hasContent            = 正文 || 思考 || 工具 || 拒答    // 思考也算"活着"
//	hasSubstantiveContent = 正文 || 工具 || 拒答            // 思考不算"实质产出"
//	emptyStreamKind       = hasSubstantiveContent ? null : (hasReasoning ? 'reasoning-only' : 'no-token')
type DeltaClassifier struct {
	hasContent     bool
	hasReasoning   bool
	hasSubstantive bool
	finishReason   string
	hasUsage       bool
}

// NewDeltaClassifier 创建分类器。
func NewDeltaClassifier() *DeltaClassifier { return &DeltaClassifier{} }

// ObserveDelta 传入上游 SSE 解析后的 chunk.choices[0].delta 与 finish_reason。
func (c *DeltaClassifier) ObserveDelta(delta *Obj, finishReason any) {
	if s, ok := finishReason.(string); ok && s != "" {
		c.finishReason = s
	}
	if delta == nil {
		return
	}
	hasText := GetString(delta, "content") != ""
	rc := GetString(delta, "reasoning_content") != ""
	rs := GetString(delta, "reasoning") != ""
	hasThink := rc || rs
	hasTool := len(GetArr(delta, "tool_calls")) > 0
	hasRefusal := GetString(delta, "refusal") != ""

	if hasThink {
		c.hasReasoning = true
	}
	if hasText || hasThink || hasTool || hasRefusal {
		c.hasContent = true
	}
	if hasText || hasTool || hasRefusal {
		c.hasSubstantive = true
	}
}

// ObserveUsage 记录 usage 出现。
func (c *DeltaClassifier) ObserveUsage(usage any) {
	if usage != nil {
		c.hasUsage = true
	}
}

// HasContent 任何产出（含 reasoning）。
func (c *DeltaClassifier) HasContent() bool { return c.hasContent }

// HasReasoning 仅思考。
func (c *DeltaClassifier) HasReasoning() bool { return c.hasReasoning }

// HasSubstantiveContent 正文 / 工具 / 拒答。
func (c *DeltaClassifier) HasSubstantiveContent() bool { return c.hasSubstantive }

// FinishReason 最后一次非空 finish_reason。
func (c *DeltaClassifier) FinishReason() string { return c.finishReason }

// HasUsage 是否出现 usage。
func (c *DeltaClassifier) HasUsage() bool { return c.hasUsage }

// EmptyStreamKind 按官方语义给出空流子类型：'reasoning-only' | 'no-token' | ”（有实质产出，不算空流）。
func (c *DeltaClassifier) EmptyStreamKind() string {
	if c.hasSubstantive {
		return ""
	}
	if c.hasReasoning {
		return "reasoning-only"
	}
	return "no-token"
}

// IsTruncatedWithoutFinish 判断一段流是否"无正常收尾"（stream-guard.mjs:393-395）。
func IsTruncatedWithoutFinish(sawDone, sawFinish, sawError bool) bool {
	return !sawDone && !sawFinish && !sawError
}

func chunkID(id string) string {
	if id != "" {
		return id
	}
	return "chatcmpl-" + Itoa(int(time.Now().UnixMilli()))
}

// BuildEmptyStreamChunk 空流终态（finish_reason:'error'），对齐官方 failEmptyStream（stream-guard.mjs:403-412）。
func BuildEmptyStreamChunk(id, model, kind string) string {
	if model == "" {
		model = "unknown"
	}
	if kind == "" {
		kind = "no-token"
	}
	idJ, _ := MarshalJSON(chunkID(id))
	modelJ, _ := MarshalJSON(model)
	kindJ, _ := MarshalJSON(kind)
	return `{"id":` + string(idJ) + `,"object":"chat.completion.chunk","model":` + string(modelJ) +
		`,"choices":[{"index":0,"delta":{},"finish_reason":"error"}],"x_empty_stream_kind":` + string(kindJ) + `}`
}

// BuildTruncationChunk 截断终态帧（finish_reason:'length'），仅在"有真实产出"时补（stream-guard.mjs:418-425）。
func BuildTruncationChunk(id, model string) string {
	if model == "" {
		model = "unknown"
	}
	idJ, _ := MarshalJSON(chunkID(id))
	modelJ, _ := MarshalJSON(model)
	return `{"id":` + string(idJ) + `,"object":"chat.completion.chunk","model":` + string(modelJ) +
		`,"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}`
}

// LogStreamOutcome 统一日志：把流结束的归因写清楚（stream-guard.mjs:430-452）。
// extra 为 (key, value) 交替的有序 kv。
func LogStreamOutcome(lg *logger.Logger, label string, res StreamResult, extra ...any) {
	if res.UpstreamEnded && !res.AbortedByIdle && !res.AbortedByFirstByte {
		return
	}
	suffix := fmtExtra(extra)
	switch {
	case res.AbortedByClient:
		logInfo(lg, "STREAM", "["+label+"] 客户端先断开，上游随之取消（非上游故障）"+suffix)
	case res.AbortedByFirstByte:
		logWarn(lg, "STREAM", "["+label+"] 首字节超时终止"+suffix)
	case res.AbortedByIdle:
		logWarn(lg, "STREAM", "["+label+"] 流静默超时终止（疑似上游断流）"+suffix)
	case !res.SawDone && res.Err != nil:
		logWarn(lg, "STREAM", "["+label+"] 上游断流: "+res.Err.Error()+suffix)
	}
}

func fmtExtra(extra []any) string {
	if len(extra) == 0 {
		return ""
	}
	var parts []string
	for i := 0; i+1 < len(extra); i += 2 {
		if extra[i+1] == nil {
			continue
		}
		parts = append(parts, ToStr(extra[i])+"="+ToStr(extra[i+1]))
	}
	if len(parts) == 0 {
		return ""
	}
	return " (" + strings.Join(parts, ", ") + ")"
}
