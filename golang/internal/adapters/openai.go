package adapters

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/logger"
	"codebuddy-gateway/internal/core/metrics"
	"codebuddy-gateway/internal/core/scheduler"
	"codebuddy-gateway/internal/upstream"
)

// ─── GET /v1/models（openai.mjs:46-82）────────────────────────────────────────
// 区域区分：直接在模型 ID 前加前缀 cn:<id> / intl:<id>；两区都有的模型会以两个条目分别给出。
// 兼容：不带前缀的裸 ID 仍可正常调用（按账号池自动路由）。

// HandleModels 标准 OpenAI 模型列表。
func (d *Deps) HandleModels(w http.ResponseWriter, r *http.Request) {
	detailed := d.Models.FetchDetailedModels(false)
	list := make([]any, 0)
	seen := map[string]bool{}
	now := time.Now().UnixMilli() / 1000

	for _, m := range detailed {
		regions := upstream.GetArr(m, "regions")
		if len(regions) == 0 {
			regions = []any{"cn"}
		}
		bareID := upstream.GetString(m, "id")
		for _, rv := range regions {
			rr, _ := rv.(string)
			id := upstream.RegionPrefix[rr] + bareID
			if seen[id] {
				continue
			}
			// 黑名单：命中则完全不出现在列表中，客户端看不到也选不到
			if d.Store.IsModelBlacklisted(id, bareID, rr) {
				continue
			}
			seen[id] = true
			ownedBy := upstream.GetString(m, "vendor")
			if ownedBy == "" {
				ownedBy = "tencent-codebuddy"
			}
			// `m.contextWindow?.defaultLength || m.maxInputTokens || 200000`
			var cw float64
			if f, ok := upstream.GetNum(upstream.GetObj(m, "contextWindow").Get("defaultLength")); ok && f != 0 {
				cw = f
			} else if f, ok := upstream.GetNum(m.Get("maxInputTokens")); ok && f != 0 {
				cw = f
			} else {
				cw = 200000
			}
			mot, ok := upstream.GetNum(m.Get("maxOutputTokens"))
			if !ok || mot == 0 {
				mot = 8192
			}
			regionLabel := "国内版"
			if rr == "intl" {
				regionLabel = "国际版"
			}
			list = append(list, upstream.NewObj().
				Set("id", id).
				Set("object", "model").
				Set("created", upstream.Num(now)).
				Set("owned_by", ownedBy).
				Set("context_window", numAsAny(cw)).
				Set("max_output_tokens", numAsAny(mot)).
				Set("model", bareID). // 裸模型名，便于客户端对照上游真实 ID
				Set("region", rr).
				Set("region_label", regionLabel))
		}
	}
	writeJSON(w, http.StatusOK, upstream.NewObj().Set("object", "list").Set("total", len(list)).Set("data", list))
}

// ─── POST /v1/chat/completions（openai.mjs:85-684）─────────────────────────────

// HandleChatCompletions OpenAI 协议核心对话网关。rawBody 已由 server 层读取（含大小限制）。
func (d *Deps) HandleChatCompletions(w http.ResponseWriter, r *http.Request, rawBody []byte) {
	startMs := time.Now().UnixMilli()
	sse := NewSSEWriter(w)
	if err := d.chatCompletions(sse, r, rawBody, startMs); err != nil {
		d.Lg.Error("CHAT", "处理对话请求异常: "+err.Error())
		if !sse.Sent() {
			writeJSON(w, http.StatusInternalServerError, upstream.NewObj().Set("error", upstream.NewObj().Set("message", err.Error()).Set("type", "api_error")))
		}
	}
}

// lastID 流式过程中最后一块 chunk.id（保活帧要用，需跨 goroutine读取）。
type lastID struct {
	mu sync.Mutex
	v  string
}

func (l *lastID) set(v string) { l.mu.Lock(); l.v = v; l.mu.Unlock() }
func (l *lastID) get() string  { l.mu.Lock(); defer l.mu.Unlock(); return l.v }

func (d *Deps) chatCompletions(sse *SSEWriter, r *http.Request, rawBody []byte, startMs int64) error {
	payload, err := parsePayload(rawBody)
	if err != nil {
		return err
	}
	isClientStream := upstream.Truthy(payload.Get("stream"))
	sessionKey := scheduler.ExtractSessionKey(r.Header, payload)

	// 模型名可能带区域前缀（cn: / intl:），剥掉后作为实际上游模型名，前缀同时用于锁定账号区域
	modelName := upstream.GetString(payload, "model")
	if modelName == "" {
		modelName = "deepseek-v4.1-flash"
	}
	bare, forcedRegion := upstream.ParseModelRegion(modelName)
	targetModel := bare
	if targetModel == "" {
		targetModel = "deepseek-v4.1-flash"
	}
	if forcedRegion != "" {
		d.Lg.Info("CHAT", "模型名带区域前缀，已锁定区域 ["+forcedRegion+"]，实际上游模型: "+targetModel)
	}

	// 黑名单拦截：/v1/models 里看不到的模型，也不能被硬编码模型名直接调用
	if d.Store.IsModelBlacklisted(modelName, targetModel, forcedRegion) {
		d.Lg.Warn("CHAT", "模型 ["+modelName+"] 命中黑名单，已拒绝请求")
		writeJSON(sse.w, http.StatusForbidden, upstream.NewObj().Set("error", upstream.NewObj().
			Set("message", "Model \""+modelName+"\" is disabled by the gateway administrator (blacklisted).").
			Set("type", "permission_error").Set("code", "model_blacklisted")))
		return nil
	}

	logPolicy := d.Store.GetLoggingPolicy()
	ci := resolveClientInfo(r, logPolicy.RequestClientInfo)
	var archiveCtx *upstream.Obj
	if logPolicy.RequestArchiveContext {
		archiveCtx = upstream.ExtractArchiveContext(payload)
	}
	logMeta := buildLogMeta(arrLen(payload, "tools"), arrLen(payload, "messages"), ci, logPolicy.RequestClientInfo, archiveCtx, logPolicy.RequestArchiveContext)
	d.Lg.Info("CHAT", "收到 OpenAI 对话请求 ["+targetModel+"]"+ci.Desc+" (流式: "+boolStr(isClientStream)+")", logMeta)

	// 流式稳定性：首字节超时 + 客户端断开感知 + 静默看门狗
	lc := upstream.NewLifecycle(r.Context(), "openai:"+targetModel, d.Lg)
	defer lc.Dispose()

	extraVars := payload.Get("extra_vars")
	if !upstream.Truthy(extraVars) {
		extraVars = upstream.NewObj().Set("initiator", "user").Set("interactionType", "prompt")
	}
	cacheRetention := "long"
	if s, ok := payload.Get("cache_retention").(string); ok {
		cacheRetention = s
	}
	msgs := upstream.FormatMessagesForUpstream(objArr(payload.Get("messages")))
	upstreamPayload := upstream.NewObj().
		Set("model", targetModel).
		Set("messages", msgs).
		Set("stream", true).
		Set("temperature", nullishOr(payload, "temperature", 1.0)).
		Set("max_tokens", nullishOr(payload, "max_tokens", upstream.DefaultMaxTokens)).
		Set("stream_options", upstream.NewObj().Set("include_usage", true)).
		Set("cache_retention", cacheRetention).
		Set("extra_vars", extraVars)
	if tools := upstream.GetArr(payload, "tools"); len(tools) > 0 {
		upstreamPayload.Set("tools", tools)
		if tc := payload.Get("tool_choice"); upstream.Truthy(tc) {
			upstreamPayload.Set("tool_choice", tc)
		}
	}

	allMeta := d.Models.FetchDetailedModels(false)
	var modelMeta *upstream.Obj
	for _, m := range allMeta {
		if upstream.GetString(m, "id") == targetModel {
			modelMeta = m
			break
		}
	}
	upstreamPayload = upstream.ApplyModelCapabilityGuards(d.Lg, upstreamPayload, modelMeta)
	// 推理参数规整：客户端显式值优先，缺省才用官方默认；不发 thinking / reasoning 嵌套对象
	upstreamPayload = upstream.ApplyReasoningParams(upstreamPayload, payload, modelMeta, d.Store.GetThinkingPolicy())

	policy := d.Store.GetPromptPolicy()
	promptText := ""
	if policy.Mode != "passthrough" {
		promptText = d.Store.LoadSystemPromptContent(policy.File)
	}

	call := d.executeRequestChain(lc, protoOpenAI, sessionKey, targetModel, forcedRegion, upstreamPayload, msgs, policy.Mode, promptText)
	if !call.OK {
		_ = d.Metrics.RecordApiCall(metrics.Call{Model: targetModel, IsSuccess: false})
		lc.MarkFinished()
		writeJSON(sse.w, call.Status, upstream.FormatOpenAIError(call.Status, call.ErrText))
		return nil
	}

	res, activeAcc, model, release := call.Res, call.Acc, call.Model, call.Release
	logName := config.AccountLogName(activeAcc)

	if isClientStream {
		sse.SetHeader("Content-Type", "text/event-stream")
		sse.SetHeader("Cache-Control", "no-cache")
		sse.SetHeader("Connection", "keep-alive")
		sse.SetHeader("X-Accel-Buffering", "no")
		sse.WriteHead(http.StatusOK)

		toolCallObserved := false
		var streamUsage *upstream.Obj
		sseBuffer := ""
		sawFinish, sawError := false, false
		chunkID := &lastID{}
		// 与官方 CLI 同源的 delta 分类器（正文/思考/工具/拒答）
		classifier := upstream.NewDeltaClassifier()
		// OpenAI 协议发空 delta chunk 保活；模型长思考期间上游可能长时间无输出
		heartbeat := upstream.StartHeartbeat(sse, "openai:"+model, "openai", func() (string, string) {
			return chunkID.get(), model
		})

		result := upstream.ReadUpstreamStream(res.Body, lc, upstream.ReadOpts{
			Label: "openai:" + model,
			OnChunk: func(str string) {
				if sse.Ended() || lc.IsClientGone() {
					return
				}
				sse.Write(str)
				heartbeat.Touch()
				if strings.Contains(str, `"tool_calls"`) {
					toolCallObserved = true
				}
				sseBuffer += str
				lines := strings.Split(sseBuffer, "\n")
				sseBuffer = lines[len(lines)-1] // 保留尚未结束的行片段
				for _, line := range lines[:len(lines)-1] {
					trimmed := strings.TrimSpace(line)
					if !strings.HasPrefix(trimmed, "data:") {
						continue
					}
					dataStr := strings.TrimSpace(trimmed[5:])
					if dataStr == "[DONE]" {
						// 上游话已说完：此后客户端挂断属正常收尾，不算「客户端断开」
						lc.MarkUpstreamEnded()
						continue
					}
					chunk, err := upstream.ParseObj([]byte(dataStr))
					if err != nil {
						continue
					}
					if id := upstream.GetString(chunk, "id"); id != "" {
						chunkID.set(id)
					}
					if u := upstream.GetObj(chunk, "usage"); u != nil {
						streamUsage = u
						classifier.ObserveUsage(u)
					}
					if upstream.Truthy(chunk.Get("error")) {
						sawError = true
					}
					choice := firstChoice(chunk)
					// 与官方 CLI 同源的三标志分类（正文/思考/工具/拒答）
					classifier.ObserveDelta(upstream.GetObj(choice, "delta"), choice.Get("finish_reason"))
					if fr := upstream.GetString(choice, "finish_reason"); fr != "" {
						sawFinish = true
						lc.MarkUpstreamEnded()
					}
				}
			},
		})

		// ─── 收尾判定（对齐官方 CLI 的 emptyStreamKind 语义）──────────────────
		// 官方不把"没有 finish_reason"当错误，只区分有没有实质产出：
		//   reasoning-only → 思考过但无正文/工具；no-token → 连思考都没有
		// 有实质产出但被截断 → 补 length；完全无产出 → 补 error
		emptyKind := classifier.EmptyStreamKind()
		if !result.AbortedByClient && !sawFinish && !sawError {
			if emptyKind != "" {
				fr := classifier.FinishReason()
				if fr == "" {
					fr = "unknown"
				}
				d.Lg.Warn("STREAM", "[openai:"+model+"] 空流 "+emptyKind+"（无实质产出）: finish_reason="+fr+", 有思考="+boolStr(classifier.HasReasoning()))
				sse.Write("data: " + upstream.BuildEmptyStreamChunk(chunkID.get(), model, emptyKind) + "\n\n")
				sse.Write("data: [DONE]\n\n")
			} else if upstream.IsTruncatedWithoutFinish(result.SawDone, sawFinish, sawError) {
				// 有实质产出但上游没给 finish_reason → 按截断处理
				d.Lg.Warn("STREAM", "[openai:"+model+"] 上游断流无 finish_reason，补截断终态")
				sse.Write("data: " + upstream.BuildTruncationChunk(chunkID.get(), model) + "\n\n")
				sse.Write("data: [DONE]\n\n")
			}
		}
		upstream.LogStreamOutcome(d.Lg, "openai:"+model, result, "model", model, "toolCalls", toolCallObserved, "substantive", classifier.HasSubstantiveContent())

		// 无论成功/异常/客户端断开，都必须释放名额，杜绝 inFlight 泄漏
		lc.MarkFinished()
		release()
		d.Sched.RecordApiUsage(activeAcc.UID)
		keepalivePings := heartbeat.Stop()
		lc.Dispose()
		_ = res.Body.Close()

		latency := time.Now().UnixMilli() - startMs
		inTokens := usageInt(streamUsage, "prompt_tokens", maxInt64(10, jsRound(float64(len(rawBody))/4)))
		outTokens := usageInt(streamUsage, "completion_tokens", maxInt64(1, jsRound(float64(latency)/15)))
		cachedTok := usageFirstNonNull(streamUsage, "prompt_cache_hit_tokens", "prompt_tokens_details.cached_tokens", "cache_read_input_tokens")
		_ = d.Metrics.RecordApiCall(metrics.Call{AccountUID: activeAcc.UID, AccountName: logName, Model: model, IsSuccess: true, InputTokens: inTokens, OutputTokens: outTokens, CachedTokens: cachedTok})
		pingPart := ""
		if keepalivePings > 0 {
			pingPart = ", 思考保活: " + upstream.Itoa(keepalivePings) + " 帧"
		}
		d.Lg.Info("CHAT", "流式输出完成 ["+model+"] 耗时 "+upstream.Itoa(int(latency))+"ms (账号: ["+logName+"], 缓存命中: "+upstream.Itoa(int(cachedTok))+" tok, 是否含工具调用: "+boolStr(toolCallObserved)+pingPart+")")
		sse.End()
		return nil
	}

	// ─── 非流式：读全量 SSE 后拼装成单条 message ─────────────────────────────
	decremented := false
	defer func() {
		if !decremented {
			release()
		}
	}()
	all := readAllAndClose(res.Body)
	release()
	d.Sched.RecordApiUsage(activeAcc.UID)
	decremented = true

	fullContent, fullReasoning := "", ""
	accum := &toolCallAccum{by: map[int]*toolCallItem{}, newID: func() string { return "call_" + upstream.UUIDv4() }}
	finishReason := "stop"
	responseID := "chatcmpl-" + upstream.UUIDv4()
	var nonStreamUsage *upstream.Obj
	scanSSELines(all, func(dataStr string) {
		if dataStr == "[DONE]" {
			return
		}
		chunk, err := upstream.ParseObj([]byte(dataStr))
		if err != nil {
			return
		}
		if u := upstream.GetObj(chunk, "usage"); u != nil {
			nonStreamUsage = u
		}
		if id := upstream.GetString(chunk, "id"); id != "" {
			responseID = id
		}
		choice := firstChoice(chunk)
		if choice == nil {
			return
		}
		delta := upstream.GetObj(choice, "delta")
		if c := upstream.GetString(delta, "content"); c != "" {
			fullContent += c
		}
		if rc := upstream.GetString(delta, "reasoning_content"); rc != "" {
			fullReasoning += rc
		} else if rr := upstream.GetString(delta, "reasoning"); rr != "" {
			fullReasoning += rr
		}
		accum.observe(delta)
		if fr := upstream.GetString(choice, "finish_reason"); fr != "" {
			finishReason = fr
		}
	})

	assembled := upstream.NewObj().Set("role", "assistant")
	if fullContent != "" {
		assembled.Set("content", fullContent)
	} else {
		assembled.Set("content", nil)
	}
	if fullReasoning != "" {
		assembled.Set("reasoning_content", fullReasoning)
	}
	if len(accum.order) > 0 {
		assembled.Set("tool_calls", accum.openAIToolCalls())
		finishReason = "tool_calls"
		d.Lg.Info("TOOLS", "模型决定下发工具调用 (共 "+upstream.Itoa(len(accum.order))+" 个)", logger.NewMeta("tools", accum.names()))
	}

	latency := time.Now().UnixMilli() - startMs
	inTokens := usageInt(nonStreamUsage, "prompt_tokens", maxInt64(10, jsRound(float64(len(rawBody))/4)))
	outTokens := usageInt(nonStreamUsage, "completion_tokens", maxInt64(1, jsRound(float64(upstream.JSLength(fullContent))/4)))
	cachedTok := usageFirstNonNull(nonStreamUsage, "prompt_cache_hit_tokens", "prompt_tokens_details.cached_tokens", "cache_read_input_tokens")
	_ = d.Metrics.RecordApiCall(metrics.Call{AccountUID: activeAcc.UID, AccountName: logName, Model: model, IsSuccess: true, InputTokens: inTokens, OutputTokens: outTokens, CachedTokens: cachedTok})
	d.Lg.Info("CHAT", "非流式回复完成 ["+model+"] 耗时 "+upstream.Itoa(int(latency))+"ms (账号: ["+logName+"], 缓存命中: "+upstream.Itoa(int(cachedTok))+" tok, 结束原因: "+finishReason+")")

	lc.MarkFinished()
	writeJSON(sse.w, http.StatusOK, upstream.NewObj().
		Set("id", responseID).
		Set("object", "chat.completion").
		Set("created", upstream.Num(time.Now().UnixMilli()/1000)).
		Set("model", upstreamPayload.Get("model")).
		Set("choices", []any{upstream.NewObj().Set("index", 0).Set("message", assembled).Set("finish_reason", finishReason)}).
		Set("usage", upstream.NewObj().
			Set("prompt_tokens", upstream.Num(inTokens)).
			Set("completion_tokens", upstream.Num(outTokens)).
			Set("total_tokens", upstream.Num(inTokens+outTokens)).
			Set("prompt_tokens_details", upstream.NewObj().Set("cached_tokens", upstream.Num(cachedTok))).
			Set("prompt_cache_hit_tokens", upstream.Num(cachedTok))))
	return nil
}
