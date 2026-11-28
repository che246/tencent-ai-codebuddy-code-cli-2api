package adapters

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/logger"
	"codebuddy-gateway/internal/core/scheduler"
	"codebuddy-gateway/internal/upstream"
)

// ─── 请求执行链（openai.mjs:172-411 / anthropic.mjs:215-430） ─────────────────────
// 两种协议的执行链逐行同构，仅文案类别/前缀与 11158 处理不同，这里用 chainProto 参数化。

// chainProto 协议差异参数。
type chainProto struct {
	Name            string // "openai" | "anthropic"：[xxx] 客户端已断开 日志前缀
	ErrCat          string // 上游报错日志类别：openai → UPSTREAM；anthropic → ANTHROPIC
	Prefix          string // FAILOVER / REROUTE 文案前缀：openai → ""；anthropic → "Anthropic 协议: "
	ModelNotAllowed bool   // openai.mjs:285-302 独有：11158 直接 403，不换号不换模型
	GoneJSON        bool   // 客户端断开时 errText：openai 为错误 JSON；anthropic 为纯文本
}

var (
	protoOpenAI    = chainProto{Name: "openai", ErrCat: "UPSTREAM", ModelNotAllowed: true, GoneJSON: true}
	protoAnthropic = chainProto{Name: "anthropic", ErrCat: "ANTHROPIC", Prefix: "Anthropic 协议: "}
)

// chainStep `{ model: 裸模型名, region: 'cn'|'intl'|null }`。
type chainStep struct{ Model, Region string }

// bizCode 对应 `extractStructuredBizCode(err) || err.code`：可能是数字或字符串。
type bizCode struct {
	Num    int
	HasNum bool
	Str    string
	Has    bool
}

// Display 模板 `${bizCode || or}`：缺失时回落 or。
func (b bizCode) Display(or string) string {
	if !b.Has {
		return or
	}
	if b.HasNum {
		return upstream.Itoa(b.Num)
	}
	return b.Str
}

// JS 模板 `${bizCode}`：缺失时 JS 会输出字符串 "undefined"。
func (b bizCode) JS() string {
	if !b.Has {
		return "undefined"
	}
	return b.Display("")
}

// metaValue 日志 meta 中的 code 值（undefined 在 JSON.stringify 中被省略 → nil）。
func (b bizCode) metaValue() any {
	if !b.Has {
		return nil
	}
	if b.HasNum {
		return upstream.Num(int64(b.Num))
	}
	return b.Str
}

func bizFromFloat(f float64) bizCode {
	return bizCode{Num: int(f), HasNum: true, Has: true}
}

// extractBizCode `extractStructuredBizCode(parsedErr) || parsedErr.code`。
func extractBizCode(parsedErr *upstream.Obj) bizCode {
	if c, ok := upstream.ExtractStructuredBizCode(parsedErr, 6); ok {
		return bizCode{Num: c, HasNum: true, Has: true}
	}
	switch v := parsedErr.Get("code").(type) {
	case json.Number:
		if f, err := v.Float64(); err == nil && f != 0 {
			return bizFromFloat(f)
		}
	case float64:
		if v != 0 {
			return bizFromFloat(v)
		}
	case string:
		if v != "" {
			return bizCode{Str: v, Has: true}
		}
	}
	return bizCode{}
}

// chainResult 执行链结果。
type chainResult struct {
	OK      bool
	Status  int
	ErrText string
	Biz     bizCode
	BizText string // 'CLIENT_GONE'
	Acc     *config.Account
	Release func() // 成功时持有 inFlight 名额，调用方在流结束后释放
	Model   string // 实际使用的模型
	Res     *http.Response
}

// isPinnedUIDEmail `pinned === uid || pinned === email`。
func isPinnedUIDEmail(pinned string, acc *config.Account) bool {
	return pinned != "" && (pinned == acc.UID || pinned == acc.Email)
}

// isPinnedAny 额外匹配 note（忽略大小写）。
func isPinnedAny(pinned string, acc *config.Account) bool {
	if isPinnedUIDEmail(pinned, acc) {
		return true
	}
	return pinned != "" && acc.Note != "" && strings.ToLower(pinned) == strings.ToLower(acc.Note)
}

// executeRequestChain 核心执行链路：多级备用模型降级链 (A -> B -> C) + 账号池多账号自愈轮换。
// msgs 会在每次尝试时重新套用系统提示词策略（与 Node 版一致：基于上一轮结果继续套用）。
func (d *Deps) executeRequestChain(lc *upstream.Lifecycle, p chainProto, sessionKey, initialModel, forcedRegion string, payload *upstream.Obj, msgs []*upstream.Obj, promptMode, promptText string) chainResult {
	cfg := d.Store.Config()
	steps := []chainStep{{Model: initialModel, Region: forcedRegion}}
	seen := map[string]bool{forcedRegion + ":" + initialModel: true}

	if cfg.IsModelFallbackEnabled() && len(cfg.ModelFallback) > 0 {
		// 主模型可能带前缀，配置里也要同时查「带前缀」和「裸名」两种 key
		var raw any
		if forcedRegion != "" {
			if v, ok := cfg.ModelFallback[forcedRegion+":"+initialModel]; ok && upstream.Truthy(v) {
				raw = v
			}
		}
		if raw == nil {
			if v, ok := cfg.ModelFallback[initialModel]; ok && upstream.Truthy(v) {
				raw = v
			}
		}
		var list []any
		switch t := raw.(type) {
		case []any:
			list = t
		case string:
			list = []any{t}
		}
		for _, item := range list {
			s, isStr := item.(string)
			if !isStr || s == "" {
				continue
			}
			trimmed := strings.TrimSpace(s)
			bare, region := upstream.ParseModelRegion(trimmed)
			if bare == "" {
				continue
			}
			// 备用模型没写区域时，跟随主模型区域，避免跨区降级导致 401
			stepRegion := region
			if stepRegion == "" {
				stepRegion = forcedRegion
			}
			sig := stepRegion + ":" + bare
			if seen[sig] {
				continue
			}
			seen[sig] = true
			// 黑名单：被禁用的模型不允许出现在自动轮换链里
			if d.Store.IsStepUnavailableByBlacklist(bare, stepRegion) {
				d.Lg.Warn("REROUTE", p.Prefix+"备用模型 ["+trimmed+"] 命中黑名单，已从降级链中剔除")
				continue
			}
			steps = append(steps, chainStep{Model: bare, Region: stepRegion})
		}
	}

	modelIndex := 0
	for modelIndex < len(steps) {
		step := steps[modelIndex]
		curModel, curRegion := step.Model, step.Region
		curLabel := stepLabel(curModel, curRegion)
		attempted := map[string]bool{}

		for {
			// 1. 账号调度：在当前模型下选择未在该模型尝试过的账号
			acc := d.Sched.SelectAccount(curModel, sessionKey, scheduler.SelectOpts{ExcludeUids: setMapKeys(attempted), Region: curRegion})
			if acc == nil {
				// 账号池所有账号在当前模型下均已受限：检查是否还有下一个备用模型
				if modelIndex+1 < len(steps) {
					next := steps[modelIndex+1]
					d.Lg.Warn("REROUTE", fmt.Sprintf("%s账号池所有账号对模型 [%s] 均已限流，自动降级切换至下一个备用模型 [%s] (%d/%d)",
						p.Prefix, curLabel, stepLabel(next.Model, next.Region), modelIndex+1, len(steps)-1))
					modelIndex++
					break
				}
				// 整个降级链所有模型均已尝试且全池账号均已耗尽受限
				msg := fmt.Sprintf("All upstream accounts and fallback models in the chain (%s) are rate-limited or busy.", fmtChainSteps(steps))
				errText := jsonStringify(upstream.NewObj().Set("error", upstream.NewObj().
					Set("message", msg).Set("type", "rate_limit_error").Set("code", "rate_limit_exceeded")))
				return chainResult{Status: 429, ErrText: errText, Biz: bizCode{Num: upstream.CodeCraftRateLimit, HasNum: true, Has: true}}
			}

			release := d.Store.Accounts().Acquire(acc.UID)
			attempted[acc.UID] = true
			logName := config.AccountLogName(acc)

			payload.Set("model", curModel)
			// 应用系统提示词策略 (passthrough / custom / append)；国际版要求首条为 system，缺则补一条
			msgs = upstream.EnsureLeadingSystemMessage(upstream.ApplySystemPromptPolicy(msgs, promptMode, promptText), config.ResolveAccountRegion(acc))
			payload.Set("messages", msgs)
			body, isGzip, _ := upstream.PrepareUpstreamBody(payload)
			headers := upstream.BuildOfficialUpstreamHeaders(d.Lg, acc.AccessToken, curModel, sessionKey, acc.UID, isGzip, acc, d.Store.GetPrivateDataPolicy())
			// 按账号所属区域选择上游（国内 / 国际），端点结构完全一致；首字节超时 + 客户端断开由 lifecycle 兜住
			ep := config.EndpointsFor(acc)
			res, err := d.Client.Do(lc.Ctx(), http.MethodPost, ep.Upstream, headers, body)
			lc.MarkFirstByte()

			if err != nil {
				release()
				// 客户端主动断开 / 首字节超时：不是账号问题，不该换号重试，直接收敛
				switch lc.Reason() {
				case upstream.ReasonClientGone:
					d.Lg.Info("STREAM", "["+p.Name+"] 客户端已断开，停止重试")
					errText := "Client closed request"
					if p.GoneJSON {
						errText = jsonStringify(upstream.NewObj().Set("error", upstream.NewObj().Set("message", "Client closed request").Set("type", "client_closed")))
					}
					return chainResult{Status: 499, ErrText: errText, BizText: "CLIENT_GONE"}
				case upstream.ReasonFirstByteTimeout:
					d.Lg.Warn("NETWORK", "账号 ["+logName+"] 首字节超时，切换下一个账号")
					continue
				}
				d.Lg.Error("NETWORK", "请求账号 ["+logName+"] 网络异常: "+err.Error())
				continue // 网络抖动，尝试下一个账号
			}

			if res.StatusCode >= 200 && res.StatusCode < 300 {
				return chainResult{OK: true, Res: res, Model: curModel, Acc: acc, Release: release}
			}

			release()
			status := res.StatusCode
			errText := readAllAndClose(res.Body)
			parsedErr, perr := upstream.ParseObj([]byte(errText))
			if perr != nil {
				parsedErr = upstream.NewObj()
			}
			biz := extractBizCode(parsedErr)
			msg := upstream.GetString(parsedErr, "msg")
			if msg == "" {
				msg = errText
			}
			meta := logger.NewMeta()
			if v := biz.metaValue(); v != nil {
				meta.Set("code", v)
			}
			meta.Set("msg", msg).Set("account", logName)
			d.Lg.Error(p.ErrCat, fmt.Sprintf("上游报错 HTTP %d (账号: [%s], 模型: [%s], 业务码: %s)", status, logName, curModel, biz.Display("无")), meta)

			// 判断是否为模型限流 (6003:TPH, 6004:TPD, 6007:RPH, 6008:RPD, 429)
			isModelLimit := (biz.HasNum && upstream.ModelFallbackCodes[biz.Num]) || status == 429 || (biz.HasNum && biz.Num == upstream.CodeRateLimitError)
			cfgNow := d.Store.Config()

			// 11158：当前用户类型无权使用该模型。换账号或换模型都无用，直接如实告知，并冷却该模型避免反复白试。
			if p.ModelNotAllowed && biz.HasNum && biz.Num == upstream.CodeModelNotAllowed {
				d.Sched.CooldownModel(acc.UID, curModel, 3600, "Model not allowed for user type (11158)")
				d.Lg.Warn("UPSTREAM", fmt.Sprintf("账号 [%s] 无权使用模型 [%s]（用户等级不足），已冷却 1 小时", logName, curModel))
				errText2 := jsonStringify(upstream.NewObj().Set("error", upstream.NewObj().
					Set("message", fmt.Sprintf("Model \"%s\" is not available for this account's plan (upstream code 11158: %s).", curModel, msgOr(parsedErr, "not allowed for user type"))).
					Set("type", "permission_error").Set("code", "model_not_allowed")))
				return chainResult{Status: 403, ErrText: errText2, Biz: biz}
			}

			if isModelLimit {
				d.Sched.CooldownModel(acc.UID, curModel, 600, "Upstream Rate Limit ("+biz.Display("429")+")")
				d.Sched.UnbindSticky(sessionKey, acc.UID)

				// 1) 优先：检查账号池中是否有其他可用账号继续执行相同模型
				var other *config.Account
				if cfgNow.IsAccountFailoverEnabled() {
					other = d.Sched.SelectAccount(curModel, sessionKey, scheduler.SelectOpts{ExcludeUids: setMapKeys(attempted), Region: curRegion})
				}
				if other != nil {
					var m string
					if isPinnedAny(cfgNow.PinnedAccount, acc) {
						m = fmt.Sprintf("%s全局指定账号 [%s] 遇到限制 (模型 [%s] 限流)，已自动切换回账号池动态轮换，由账号 [%s] 接力服务！", p.Prefix, logName, curModel, config.AccountLogName(other))
					} else {
						m = fmt.Sprintf("%s账号 [%s] 模型 [%s] 触发限流，自动切换至账号池中可用账号 [%s] 续跑该模型！", p.Prefix, logName, curModel, config.AccountLogName(other))
					}
					d.Lg.Warn("FAILOVER", m)
					continue // 换账号重试当前模型
				}

				// 2) 账号池所有账号在当前模型下均受限：检查是否还有下一个备用模型
				if modelIndex+1 < len(steps) {
					next := steps[modelIndex+1]
					d.Lg.Warn("REROUTE", fmt.Sprintf("%s账号池所有账号对模型 [%s] 均已限流，自动降级切换至下一个备用模型 [%s] (%d/%d)",
						p.Prefix, curLabel, stepLabel(next.Model, next.Region), modelIndex+1, len(steps)-1))
					modelIndex++
					break
				}
			} else if (biz.HasNum && upstream.QuotaExhaustedCodes[biz.Num]) || status == 402 {
				d.Sched.Cooldown(acc.UID, 86400, "Upstream Quota Exhausted ("+biz.JS()+")")
				d.Sched.UnbindSticky(sessionKey, acc.UID)
				if isPinnedUIDEmail(cfgNow.PinnedAccount, acc) {
					d.Lg.Warn("FAILOVER", fmt.Sprintf("%s全局指定账号 [%s] 额度耗尽 (HTTP 402)，已自动切换回账号池动态轮换！", p.Prefix, logName))
				}
				continue // 切换其他账号
			} else if status == 401 {
				d.Store.Accounts().Mutate(acc.UID, func(a *config.Account) { a.Status = "unauthorized" })
				d.Lg.Error("AUTH", fmt.Sprintf("账号 [%s] Token 已失效或被收回 (HTTP 401)", logName))
				if isPinnedUIDEmail(cfgNow.PinnedAccount, acc) {
					d.Lg.Warn("FAILOVER", fmt.Sprintf("%s全局指定账号 [%s] Token 失效 (HTTP 401)，已自动切换回账号池动态轮换！", p.Prefix, logName))
				}
				_ = d.Store.SaveAccounts()
				continue // 切换其他账号
			} else if biz.HasNum && upstream.AccountRestrictedCodes[biz.Num] {
				reason := upstream.GetString(upstream.GetObj(parsedErr, "displayMsg"), "zh")
				if reason == "" {
					reason = upstream.GetString(parsedErr, "msg")
				}
				if reason == "" {
					reason = "账号存在异常行为，已被限制使用 (11140)"
				}
				restrictedAt := time.Now().UnixMilli()
				d.Store.Accounts().Mutate(acc.UID, func(a *config.Account) {
					a.Status = "restricted"
					a.RestrictedAt = restrictedAt
					a.RestrictedReason = reason
				})
				d.Lg.Error("AUTH", fmt.Sprintf("账号 [%s] 触发上游风控限制 (HTTP 403 / 业务码: %s): %s，已自动标记为受限并移出调度池", logName, biz.Display("11140"), reason))
				_ = d.Store.SaveAccounts()
				d.Sched.UnbindSticky(sessionKey, acc.UID)

				// 触发账号自动故障转移 (Failover)
				var other *config.Account
				if cfgNow.IsAccountFailoverEnabled() {
					other = d.Sched.SelectAccount(curModel, sessionKey, scheduler.SelectOpts{ExcludeUids: setMapKeys(attempted), Region: curRegion})
				}
				if other != nil {
					var m string
					if isPinnedAny(cfgNow.PinnedAccount, acc) {
						m = fmt.Sprintf("%s全局指定账号 [%s] 触发上游风控受限 (11140)，已自动切换回账号池动态轮换，由账号 [%s] 接力服务！", p.Prefix, logName, config.AccountLogName(other))
					} else {
						m = fmt.Sprintf("%s账号 [%s] 触发上游风控受限 (11140)，自动切换至账号池中可用账号 [%s] 续跑该模型！", p.Prefix, logName, config.AccountLogName(other))
					}
					d.Lg.Warn("FAILOVER", m)
					continue // 换账号重试当前模型
				}

				// 若池中无其他可用账号，检查是否还有下一个备选降级模型
				if modelIndex+1 < len(steps) {
					next := steps[modelIndex+1]
					d.Lg.Warn("REROUTE", fmt.Sprintf("%s账号池当前账号均受限，自动降级切换至备用模型 [%s] (%d/%d)",
						p.Prefix, stepLabel(next.Model, next.Region), modelIndex+1, len(steps)-1))
					modelIndex++
					break
				}
			}

			return chainResult{Status: status, ErrText: errText, Biz: biz, Acc: acc}
		}
	}
	// 不可达：内层循环每条路径要么 return，要么 modelIndex++ 后仍 < len(steps)
	return chainResult{Status: 429, ErrText: `{"error":{"message":"unreachable","type":"api_error"}}`}
}

// msgOr `parsedErr.msg || def`。
func msgOr(parsedErr *upstream.Obj, def string) string {
	if s := upstream.GetString(parsedErr, "msg"); s != "" {
		return s
	}
	return def
}
