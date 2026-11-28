package adapters

import (
	"net/http"
	"strings"
	"time"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/metrics"
	"codebuddy-gateway/internal/core/scheduler"
	"codebuddy-gateway/internal/upstream"
)

// ─── POST /v1/messages 与 /messages（anthropic.mjs:36-831）────────────────────────
// Anthropic 协议适配，供 Claude Code 使用。

const defaultAnthropicModel = "deepseek-v4.1-flash"

// HandleMessages Anthropic Messages API。
func (d *Deps) HandleMessages(w http.ResponseWriter, r *http.Request, rawBody []byte) {
	startMs := time.Now().UnixMilli()
	sse := NewSSEWriter(w)
	if err := d.anthropicMessages(sse, r, rawBody, startMs); err != nil {
		d.Lg.Error("ANTHROPIC", "处理请求异常: "+err.Error())
		if !sse.Sent() {
			writeJSON(w, http.StatusInternalServerError, upstream.NewObj().Set("type", "error").
				Set("error", upstream.NewObj().Set("type", "api_error").Set("message", err.Error())))
		}
	}
}

// anthropicEvent `event: <name>\ndata: <json>\n\n`。
func anthropicEvent(name string, payload *upstream.Obj) string {
	return "event: " + name + "\ndata: " + jsonStringify(payload) + "\n\n"
}

func contentBlockStart(idx int, block *upstream.Obj) string {
	return anthropicEvent("content_block_start", upstream.NewObj().Set("type", "content_block_start").Set("index", idx).Set("content_block", block))
}

func contentBlockStop(idx int) string {
	return anthropicEvent("content_block_stop", upstream.NewObj().Set("type", "content_block_stop").Set("index", idx))
}

func (d *Deps) anthropicMessages(sse *SSEWriter, r *http.Request, rawBody []byte, startMs int64) error {
	payload, err := parsePayload(rawBody)
	if err != nil {
		return err
	}
	isClientStream := upstream.Truthy(payload.Get("stream"))

	// 模型名可带区域前缀（cn: / intl:），剥掉后作为上游真实模型名，前缀用于锁定账号区域
	modelName := upstream.GetString(payload, "model")
	if modelName == "" {
		modelName = defaultAnthropicModel
	}
	bare, forcedRegion := upstream.ParseModelRegion(modelName)
	targetModel := bare
	if targetModel == "" {
		targetModel = defaultAnthropicModel
	}
	if strings.Contains(targetModel, "claude") || strings.Contains(targetModel, "sonnet") || strings.Contains(targetModel, "opus") {
		targetModel = defaultAnthropicModel
	}
	if forcedRegion != "" {
		d.Lg.Info("ANTHROPIC", "模型名带区域前缀，已锁定区域 ["+forcedRegion+"]，实际上游模型: "+targetModel)
	}

	// 黑名单拦截：与 /v1/models 保持一致，禁用的模型不允许被硬编码调用
	blacklistName := modelName
	if blacklistName == "" {
		blacklistName = targetModel
	}
	if d.Store.IsModelBlacklisted(blacklistName, targetModel, forcedRegion) {
		d.Lg.Warn("ANTHROPIC", "模型 ["+blacklistName+"] 命中黑名单，已拒绝请求")
		writeJSON(sse.w, http.StatusForbidden, upstream.NewObj().Set("type", "error").
			Set("error", upstream.NewObj().Set("type", "permission_error").
				Set("message", "Model \""+blacklistName+"\" is disabled by the gateway administrator (blacklisted).")))
		return nil
	}

	logPolicy := d.Store.GetLoggingPolicy()
	ci := resolveClientInfo(r, logPolicy.RequestClientInfo)
	var archiveCtx *upstream.Obj
	if logPolicy.RequestArchiveContext {
		archiveCtx = upstream.ExtractArchiveContext(payload)
	}
	logMeta := buildLogMeta(arrLen(payload, "tools"), arrLen(payload, "messages"), ci, logPolicy.RequestClientInfo, archiveCtx, logPolicy.RequestArchiveContext)
	d.Lg.Info("ANTHROPIC", "收到 Claude Code 协议请求 ["+targetModel+"]"+ci.Desc+" (流式: "+boolStr(isClientStream)+")", logMeta)

	// 流式稳定性：首字节超时 + 客户端断开感知 + 静默看门狗
	lc := upstream.NewLifecycle(r.Context(), "anthropic:"+targetModel, d.Lg)
	defer lc.Dispose()

	// ─── Anthropic → OpenAI 消息格式转换 ───────────────────────────────────
	openAiMessages := convertAnthropicMessages(payload)
	openAiTools := make([]any, 0)
	for _, t := range objArr(payload.Get("tools")) {
		desc := t.Get("description")
		if !upstream.Truthy(desc) {
			desc = ""
		}
		params := t.Get("input_schema")
		if !upstream.Truthy(params) {
			params = upstream.NewObj().Set("type", "object").Set("properties", upstream.NewObj())
		}
		openAiTools = append(openAiTools, upstream.NewObj().Set("type", "function").
			Set("function", upstream.NewObj().Set("name", t.Get("name")).Set("description", desc).Set("parameters", params)))
	}

	msgs := upstream.FormatMessagesForUpstream(openAiMessages)
	upstreamPayload := upstream.NewObj().
		Set("model", targetModel).
		Set("messages", msgs).
		Set("stream", true).
		Set("temperature", nullishOr(payload, "temperature", 1.0)).
		Set("max_tokens", nullishOr(payload, "max_tokens", upstream.DefaultMaxTokens)).
		Set("stream_options", upstream.NewObj().Set("include_usage", true)).
		Set("cache_retention", "long").
		Set("extra_vars", upstream.NewObj().Set("initiator", "user").Set("interactionType", "prompt"))
	if len(openAiTools) > 0 {
		upstreamPayload.Set("tools", openAiTools)
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

	// 推理参数规整：把 Anthropic 的 thinking / budget_tokens 映射成官方上游的平铺字段
	reasoningPayload := upstream.NewObj()
	effort := payload.Get("reasoning_effort")
	if !upstream.Truthy(effort) {
		effort = anthropicEffort(payload.Get("thinking"))
	}
	if upstream.Truthy(effort) {
		reasoningPayload.Set("reasoning_effort", effort)
	}
	if v := payload.Get("verbosity"); v != nil {
		reasoningPayload.Set("verbosity", v)
	}
	if v := payload.Get("reasoning_summary"); v != nil {
		reasoningPayload.Set("reasoning_summary", v)
	}
	upstreamPayload = upstream.ApplyReasoningParams(upstreamPayload, reasoningPayload, modelMeta, d.Store.GetThinkingPolicy())

	sessionKey := scheduler.ExtractSessionKey(r.Header, payload)
	policy := d.Store.GetPromptPolicy()
	promptText := ""
	if policy.Mode != "passthrough" {
		promptText = d.Store.LoadSystemPromptContent(policy.File)
	}

	call := d.executeRequestChain(lc, protoAnthropic, sessionKey, targetModel, forcedRegion, upstreamPayload, msgs, policy.Mode, promptText)
	if !call.OK {
		_ = d.Metrics.RecordApiCall(metrics.Call{Model: targetModel, IsSuccess: false})
		writeJSON(sse.w, call.Status, upstream.NewObj().Set("type", "error").
			Set("error", upstream.NewObj().Set("type", "api_error").Set("message", call.ErrText)))
		return nil
	}

	res, activeAcc, actualModel, release := call.Res, call.Acc, call.Model, call.Release
	logName := config.AccountLogName(activeAcc)
	msgId := "msg_" + string([]byte(upstream.UUIDv4Hex())[:24])

	if isClientStream {
		sse.SetHeader("Content-Type", "text/event-stream")
		sse.SetHeader("Cache-Control", "no-cache")
		sse.SetHeader("Connection", "keep-alive")
		sse.WriteHead(http.StatusOK)
		sse.Write(anthropicEvent("message_start", upstream.NewObj().Set("type", "message_start").Set("message", upstream.NewObj().
			Set("id", msgId).Set("type", "message").Set("role", "assistant").Set("content", []any{}).
			Set("model", actualModel).Set("stop_reason", nil).Set("stop_sequence", nil).
			Set("usage", upstream.NewObj().Set("input_tokens", upstream.Num(0)).Set("output_tokens", upstream.Num(0))))))

		// Anthropic 协议发 `event: ping` 保活帧；模型长思考时上游可能几十秒不吐 reasoning/content
		heartbeat := upstream.StartHeartbeat(sse, "anthropic:"+actualModel, "anthropic", func() (string, string) { return msgId, actualModel })
		thinkingBlockStarted, thinkingBlockStopped := false, false
		textBlockStarted, textBlockStopped := false, false
		activeToolIndices := map[int]bool{}
		toolOrder := []int{}
		var streamUsage *upstream.Obj
		buffer := ""
		sawFinish, sawError := false, false
		// 与官方 CLI 同源的 delta 分类器（正文/思考/工具/拒答）
		classifier := upstream.NewDeltaClassifier()

		result := upstream.ReadUpstreamStream(res.Body, lc, upstream.ReadOpts{
			Label: "anthropic:" + actualModel,
			OnChunk: func(str string) {
				if sse.Ended() || lc.IsClientGone() {
					return
				}
				// 注意：这里不能调 heartbeat.touch()。思考型模型在上游持续吐 reasoning chunk，
				// 但只在映射出可见事件时才真正写给客户端；若在此处刷新计时器，保活帧将永远不会发出。
				buffer += str
				lines := strings.Split(buffer, "\n")
				buffer = lines[len(lines)-1]
				for _, line := range lines[:len(lines)-1] {
					trimmed := strings.TrimSpace(line)
					if !strings.HasPrefix(trimmed, "data:") {
						continue
					}
					dataStr := strings.TrimSpace(trimmed[5:])
					if dataStr == "[DONE]" {
						lc.MarkUpstreamEnded()
						continue
					}
					chunk, err := upstream.ParseObj([]byte(dataStr))
					if err != nil {
						continue
					}
					if u := upstream.GetObj(chunk, "usage"); u != nil {
						streamUsage = u
						classifier.ObserveUsage(u)
					}
					if upstream.Truthy(chunk.Get("error")) {
						sawError = true
					}
					choice := firstChoice(chunk)
					classifier.ObserveDelta(upstream.GetObj(choice, "delta"), choice.Get("finish_reason"))
					if fr := upstream.GetString(choice, "finish_reason"); fr != "" {
						sawFinish = true
						lc.MarkUpstreamEnded()
					}
					delta := upstream.GetObj(choice, "delta")
					wroteVisible := false // 本轮是否真的向客户端写了可见事件

					// 思考流原生映射（兼容 reasoning_content 与 reasoning）
					reasoningText := upstream.GetString(delta, "reasoning_content")
					if reasoningText == "" {
						reasoningText = upstream.GetString(delta, "reasoning")
					}
					if reasoningText != "" {
						if !thinkingBlockStarted && !textBlockStarted {
							thinkingBlockStarted = true
							sse.Write(contentBlockStart(0, upstream.NewObj().Set("type", "thinking").Set("thinking", "")))
							wroteVisible = true
						}
						if thinkingBlockStarted && !thinkingBlockStopped {
							sse.Write(anthropicEvent("content_block_delta", upstream.NewObj().Set("type", "content_block_delta").Set("index", 0).
								Set("delta", upstream.NewObj().Set("type", "thinking_delta").Set("thinking", reasoningText))))
							wroteVisible = true
						}
					}

					if content := upstream.GetString(delta, "content"); content != "" {
						if thinkingBlockStarted && !thinkingBlockStopped {
							thinkingBlockStopped = true
							sse.Write(contentBlockStop(0))
						}
						textIdx := 0
						if thinkingBlockStarted {
							textIdx = 1
						}
						if !textBlockStarted {
							textBlockStarted = true
							sse.Write(contentBlockStart(textIdx, upstream.NewObj().Set("type", "text").Set("text", "")))
							wroteVisible = true
						}
						sse.Write(anthropicEvent("content_block_delta", upstream.NewObj().Set("type", "content_block_delta").Set("index", textIdx).
							Set("delta", upstream.NewObj().Set("type", "text_delta").Set("text", content))))
						wroteVisible = true
					}

					if toolCalls := upstream.GetArr(delta, "tool_calls"); len(toolCalls) > 0 {
						if thinkingBlockStarted && !thinkingBlockStopped {
							thinkingBlockStopped = true
							sse.Write(contentBlockStop(0))
						}
						if textBlockStarted && !textBlockStopped {
							textBlockStopped = true
							textIdx := 0
							if thinkingBlockStarted {
								textIdx = 1
							}
							sse.Write(contentBlockStop(textIdx))
						}
						baseIndex := 0
						if thinkingBlockStarted {
							baseIndex++
						}
						if textBlockStarted {
							baseIndex++
						}
						for _, v := range toolCalls {
							tc, ok := v.(*upstream.Obj)
							if !ok {
								continue
							}
							idx := baseIndex
							if f, ok := upstream.GetNum(tc.Get("index")); ok {
								idx += int(f)
							}
							if !activeToolIndices[idx] {
								activeToolIndices[idx] = true
								toolOrder = append(toolOrder, idx)
								id := upstream.GetString(tc, "id")
								if id == "" {
									id = "call_" + upstream.UUIDv4Hex()
								}
								sse.Write(contentBlockStart(idx, upstream.NewObj().Set("type", "tool_use").
									Set("id", id).Set("name", upstream.GetString(upstream.GetObj(tc, "function"), "name")).
									Set("input", upstream.NewObj())))
								wroteVisible = true
							}
							if args := upstream.GetString(upstream.GetObj(tc, "function"), "arguments"); args != "" {
								sse.Write(anthropicEvent("content_block_delta", upstream.NewObj().Set("type", "content_block_delta").Set("index", idx).
									Set("delta", upstream.NewObj().Set("type", "input_json_delta").Set("partial_json", args))))
								wroteVisible = true
							}
						}
					}

					// 只有真正写出可见事件时才重置保活计时器
					if wroteVisible {
						heartbeat.Touch()
					}
				}
			},
		})

		// ─── 收尾判定（对齐官方 CLI 的 emptyStreamKind 语义）──────────────────
		// 有实质产出（正文/工具）但上游没给 finish_reason → 按截断补终态；
		// 完全没有实质产出 → 按空流补终态，并区分 reasoning-only / no-token。
		truncationEmitted := false
		emptyKind := classifier.EmptyStreamKind()
		needsClosing := !result.AbortedByClient && !sawFinish && !sawError && upstream.IsTruncatedWithoutFinish(result.SawDone, sawFinish, sawError)
		if needsClosing {
			if emptyKind != "" {
				fr := classifier.FinishReason()
				if fr == "" {
					fr = "unknown"
				}
				d.Lg.Warn("STREAM", "[anthropic:"+actualModel+"] 空流 "+emptyKind+"（无实质产出）: finish_reason="+fr+", 有思考="+boolStr(classifier.HasReasoning()))
			} else {
				d.Lg.Warn("STREAM", "[anthropic:"+actualModel+"] 上游断流无 finish_reason，补截断终态")
			}
			if thinkingBlockStarted || textBlockStarted || len(toolOrder) > 0 || emptyKind != "" {
				if thinkingBlockStarted && !thinkingBlockStopped {
					thinkingBlockStopped = true
					sse.Write(contentBlockStop(0))
				}
				if textBlockStarted && !textBlockStopped {
					textBlockStopped = true
					textIdx := 0
					if thinkingBlockStarted {
						textIdx = 1
					}
					sse.Write(contentBlockStop(textIdx))
				}
				for _, idx := range toolOrder {
					sse.Write(contentBlockStop(idx))
				}
				// 官方把空流归一为 error/length；有实质内容被截断用 max_tokens，空流用 error
				stopReason := "max_tokens"
				if emptyKind != "" {
					stopReason = "error"
				}
				sse.Write(anthropicEvent("message_delta", upstream.NewObj().Set("type", "message_delta").
					Set("delta", upstream.NewObj().Set("stop_reason", stopReason).Set("stop_sequence", nil)).
					Set("usage", upstream.NewObj().Set("output_tokens", upstream.Num(usageIntTruthy(streamUsage, "completion_tokens"))))))
				sse.Write(anthropicEvent("message_stop", upstream.NewObj().Set("type", "message_stop")))
				// 已补齐终态帧，正常收尾路径不要再发一遍
				truncationEmitted = true
			}
		}
		upstream.LogStreamOutcome(d.Lg, "anthropic:"+actualModel, result, "model", actualModel)

		// 无论成功/异常/客户端断开，都必须释放名额
		lc.MarkFinished()
		release()
		d.Sched.RecordApiUsage(activeAcc.UID)
		keepalivePings := heartbeat.Stop()
		lc.Dispose()
		_ = res.Body.Close()

		if truncationEmitted || sse.Ended() || lc.IsClientGone() {
			return nil
		}
		closeOpenBlocks(sse, thinkingBlockStarted, thinkingBlockStopped, textBlockStarted, textBlockStopped, toolOrder)

		latency := time.Now().UnixMilli() - startMs
		stopReason := "end_turn"
		if len(toolOrder) > 0 {
			stopReason = "tool_use"
		}
		outTokens := usageIntTruthy(streamUsage, "completion_tokens")
		if outTokens == 0 {
			outTokens = maxInt64(1, jsRound(float64(latency)/15))
		}
		inTokens := usageIntTruthy(streamUsage, "prompt_tokens")
		if inTokens == 0 {
			inTokens = maxInt64(10, jsRound(float64(len(rawBody))/4))
		}
		cachedTok := usageIntTruthy(streamUsage, "cache_read_input_tokens", "prompt_cache_hit_tokens", "prompt_tokens_details.cached_tokens", "cached_tokens")
		sse.Write(anthropicEvent("message_delta", upstream.NewObj().Set("type", "message_delta").
			Set("delta", upstream.NewObj().Set("stop_reason", stopReason).Set("stop_sequence", nil)).
			Set("usage", upstream.NewObj().Set("output_tokens", upstream.Num(outTokens)).Set("cache_read_input_tokens", upstream.Num(cachedTok)))))
		sse.Write(anthropicEvent("message_stop", upstream.NewObj().Set("type", "message_stop")))
		lc.MarkUpstreamEnded()
		_ = d.Metrics.RecordApiCall(metrics.Call{AccountUID: activeAcc.UID, AccountName: logName, Model: actualModel, IsSuccess: true, InputTokens: inTokens, OutputTokens: outTokens, CachedTokens: cachedTok})
		pingPart := ""
		if keepalivePings > 0 {
			pingPart = ", 思考保活: " + upstream.Itoa(keepalivePings) + " 帧"
		}
		d.Lg.Info("ANTHROPIC", "流式回复完成 ["+actualModel+"] 耗时 "+upstream.Itoa(int(latency))+"ms (账号: ["+logName+"], 缓存命中: "+upstream.Itoa(int(cachedTok))+" tok, 结束原因: "+stopReason+pingPart+")")
		sse.End()
		return nil
	}

	// ─── 非流式：读全量 SSE 后拼装成 Anthropic message ─────────────────────
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
	accum := &toolCallAccum{by: map[int]*toolCallItem{}, newID: func() string { return "call_" + upstream.UUIDv4Hex() }}
	var streamUsage *upstream.Obj
	scanSSELines(all, func(dataStr string) {
		if dataStr == "[DONE]" {
			return
		}
		chunk, err := upstream.ParseObj([]byte(dataStr))
		if err != nil {
			return
		}
		if u := upstream.GetObj(chunk, "usage"); u != nil {
			streamUsage = u
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
	})

	contentBlocks := make([]any, 0)
	if fullReasoning != "" {
		contentBlocks = append(contentBlocks, upstream.NewObj().Set("type", "thinking").Set("thinking", fullReasoning))
	}
	if fullContent != "" {
		contentBlocks = append(contentBlocks, upstream.NewObj().Set("type", "text").Set("text", fullContent))
	}
	for _, it := range accum.items() {
		var inputArgs any = upstream.NewObj()
		if v, err := upstream.ParseAny([]byte(it.Args)); err == nil {
			inputArgs = v
		}
		contentBlocks = append(contentBlocks, upstream.NewObj().Set("type", "tool_use").Set("id", it.ID).Set("name", it.Name).Set("input", inputArgs))
	}

	latency := time.Now().UnixMilli() - startMs
	stopReason := "end_turn"
	if len(accum.order) > 0 {
		stopReason = "tool_use"
	}
	inTokens := usageIntTruthy(streamUsage, "prompt_tokens")
	if inTokens == 0 {
		inTokens = maxInt64(10, jsRound(float64(len(rawBody))/4))
	}
	outTokens := usageIntTruthy(streamUsage, "completion_tokens")
	if outTokens == 0 {
		outTokens = maxInt64(1, jsRound(float64(upstream.JSLength(fullContent)+upstream.JSLength(fullReasoning))/4))
	}
	cachedTok := usageIntTruthy(streamUsage, "cache_read_input_tokens", "prompt_cache_hit_tokens", "prompt_tokens_details.cached_tokens", "cached_tokens")
	_ = d.Metrics.RecordApiCall(metrics.Call{AccountUID: activeAcc.UID, AccountName: logName, Model: actualModel, IsSuccess: true, InputTokens: inTokens, OutputTokens: outTokens, CachedTokens: cachedTok})
	d.Lg.Info("ANTHROPIC", "非流式完成 ["+actualModel+"] 耗时 "+upstream.Itoa(int(latency))+"ms (账号: ["+logName+"], 缓存命中: "+upstream.Itoa(int(cachedTok))+" tok, 结束原因: "+stopReason+")")

	lc.MarkFinished()
	writeJSON(sse.w, http.StatusOK, upstream.NewObj().
		Set("id", msgId).
		Set("type", "message").
		Set("role", "assistant").
		Set("content", contentBlocks).
		Set("model", actualModel).
		Set("stop_reason", stopReason).
		Set("stop_sequence", nil).
		Set("usage", upstream.NewObj().Set("input_tokens", upstream.Num(inTokens)).Set("output_tokens", upstream.Num(outTokens)).Set("cache_read_input_tokens", upstream.Num(cachedTok))))
	return nil
}

// closeOpenBlocks 正常收尾时关闭仍打开的 thinking / text / tool_use 块。
func closeOpenBlocks(sse *SSEWriter, thinkingStarted, thinkingStopped, textStarted, textStopped bool, toolOrder []int) {
	if thinkingStarted && !thinkingStopped {
		sse.Write(contentBlockStop(0))
	}
	if textStarted && !textStopped {
		textIdx := 0
		if thinkingStarted {
			textIdx = 1
		}
		sse.Write(contentBlockStop(textIdx))
	}
	for _, idx := range toolOrder {
		sse.Write(contentBlockStop(idx))
	}
}

// anthropicEffort thinking → effort 档位（anthropic.mjs:182-199，对齐官方 EXTENDED_THINKING_LEVELS）。
func anthropicEffort(thinking any) any {
	switch t := thinking.(type) {
	case *upstream.Obj:
		switch upstream.GetString(t, "type") {
		case "disabled":
			return "none"
		case "enabled":
			budget := 0.0
			if f, ok := upstream.GetNum(t.Get("budget_tokens")); ok {
				budget = f
			}
			switch {
			case budget <= 0:
				return "high"
			case budget < 2048:
				return "minimal"
			case budget < 8192:
				return "low"
			case budget < 16384:
				return "medium"
			case budget < 32768:
				return "high"
			}
			return "xhigh"
		}
	case bool:
		if t {
			return "high"
		}
		return "none"
	}
	return nil
}

// convertAnthropicMessages Anthropic system + messages → OpenAI messages（anthropic.mjs:92-142）。
func convertAnthropicMessages(payload *upstream.Obj) []*upstream.Obj {
	out := make([]*upstream.Obj, 0)
	if sys := payload.Get("system"); sys != nil {
		var sysContent string
		switch t := sys.(type) {
		case string:
			sysContent = t
		case []any:
			parts := make([]string, 0, len(t))
			for _, v := range t {
				if o, ok := v.(*upstream.Obj); ok {
					parts = append(parts, upstream.GetString(o, "text"))
				} else {
					parts = append(parts, "") // Array.prototype.join 对 undefined/null 输出空串
				}
			}
			sysContent = strings.Join(parts, "\n")
		}
		if sysContent != "" {
			out = append(out, upstream.NewObj().Set("role", "system").Set("content", sysContent))
		}
	}
	for _, m := range objArr(payload.Get("messages")) {
		switch c := m.Get("content").(type) {
		case string:
			out = append(out, upstream.NewObj().Set("role", m.Get("role")).Set("content", c))
		case []any:
			textParts := make([]any, 0)
			toolCalls := make([]any, 0)
			toolResults := make([]*upstream.Obj, 0)
			for _, bv := range c {
				b, ok := bv.(*upstream.Obj)
				if !ok {
					continue
				}
				switch upstream.GetString(b, "type") {
				case "text":
					textParts = append(textParts, b.Get("text"))
				case "image":
					src := upstream.GetObj(b, "source")
					data := upstream.GetString(src, "data")
					if data == "" {
						continue
					}
					mediaType := upstream.GetString(src, "media_type")
					if mediaType == "" {
						mediaType = "image/png"
					}
					textParts = append(textParts, upstream.NewObj().Set("type", "image_url").
						Set("image_url", upstream.NewObj().Set("url", "data:"+mediaType+";base64,"+data)))
				case "tool_use":
					input := b.Get("input")
					if !upstream.Truthy(input) {
						input = upstream.NewObj()
					}
					toolCalls = append(toolCalls, upstream.NewObj().Set("id", b.Get("id")).Set("type", "function").
						Set("function", upstream.NewObj().Set("name", b.Get("name")).Set("arguments", jsonStringify(input))))
				case "tool_result":
					var content string
					if s, ok := b.Get("content").(string); ok {
						content = s
					} else if cv := b.Get("content"); upstream.Truthy(cv) {
						content = jsonStringify(cv)
					} else {
						content = `""`
					}
					toolResults = append(toolResults, upstream.NewObj().Set("role", "tool").Set("tool_call_id", b.Get("tool_use_id")).Set("content", content))
				}
			}
			if len(textParts) > 0 || len(toolCalls) > 0 {
				var content any = textParts
				if len(textParts) == 1 {
					if s, ok := textParts[0].(string); ok {
						content = s
					}
				}
				msgObj := upstream.NewObj().Set("role", m.Get("role")).Set("content", content)
				if len(toolCalls) > 0 {
					msgObj.Set("tool_calls", toolCalls)
				}
				out = append(out, msgObj)
			}
			out = append(out, toolResults...)
		}
	}
	return out
}
