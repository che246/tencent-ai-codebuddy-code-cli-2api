package web

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/database"
	"codebuddy-gateway/internal/core/logger"
	"codebuddy-gateway/internal/core/metrics"
	"codebuddy-gateway/internal/core/scheduler"
	"codebuddy-gateway/internal/upstream"
)

// handleAPIAccounts 账号 / 积分 / 模型 / OAuth / 打卡 / 导入等路由（routes.mjs:641-1427）。
// 返回 true 表示已处理。
func (h *Handler) handleAPIAccounts(w http.ResponseWriter, r *http.Request, u *url.URL, path, method string) bool {
	switch {
	// 6. 账号列表查询 (包含模型锁池状态、锁定剩余时间及原因)
	case path == "/api/accounts" && method == http.MethodGet:
		h.listAccounts(w, u)
		return true

	// 6.5 官方 plans-usage 积分构成明细查询接口
	case path == "/api/accounts/credit-details" && method == http.MethodGet:
		acc := h.pickAccount(qs(u, "uid"))
		if acc == nil {
			writeJSON(w, http.StatusNotFound, upstream.NewObj().Set("error", "Account not found"))
			return true
		}
		details := h.Sched.GetAccountCreditDetails(acc)
		out := upstream.NewObj().Set("uid", acc.UID).Set("email", acc.Email).Set("note", acc.Note).
			Set("region", config.NormalizeRegion(acc.Region))
		mergeObj(out, details)
		writeJSON(w, http.StatusOK, out)
		return true

	// 6.6 账号积分消耗明细流水（POST /billing/meter/get-user-request-usage）
	case path == "/api/accounts/usage-records" && method == http.MethodGet:
		uid := qs(u, "uid")
		if uid == "" {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("ok", false).Set("error", "缺少 uid 参数"))
			return true
		}
		acc := h.Store.Accounts().Get(uid)
		if acc == nil {
			writeJSON(w, http.StatusNotFound, upstream.NewObj().Set("ok", false).Set("error", "账号不存在"))
			return true
		}
		days, page, size := numOr(qs(u, "days"), 7), numOr(qs(u, "page"), 1), numOr(qs(u, "pageSize"), 20)
		result := h.Sched.GetAccountUsageRecords(acc, scheduler.UsageRecordOptions{Days: &days, PageNum: &page, PageSize: &size})
		out := upstream.NewObj()
		mergeObj(out, result)
		out.Set("uid", acc.UID).Set("email", acc.Email).Set("note", acc.Note).Set("region", config.NormalizeRegion(acc.Region))
		writeJSON(w, http.StatusOK, out)
		return true

	// [网关自有策略] 6.7 积分监控与历史变动留痕接口
	case path == "/api/credits/history" && method == http.MethodGet:
		if qs(u, "refresh") == "1" {
			h.Sched.RefreshStaleCredits(0, true)
		}
		limit := clampInt(atoiOr(qs(u, "limit"), 100), 1, 1000)
		offset := atoiOr(qs(u, "offset"), 0)
		if offset < 0 {
			offset = 0
		}
		uid, rng, date := qs(u, "uid"), qs(u, "range"), qs(u, "date")
		if rng == "" {
			rng = "today"
		}
		hist := h.DB.QueryCreditHistory(database.CreditQuery{AccountUID: uid, Range: rng, Date: date, Limit: limit, Offset: offset})
		records := hist.Records
		if records == nil {
			records = []database.CreditRow{}
		}
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true).Set("total", hist.Total).
			Set("records", records).Set("range", rng).Set("date", nilIfEmpty(date)))
		return true

	// POST /api/credits/history/clear 清空变动历史记录
	case path == "/api/credits/history/clear" && method == http.MethodPost:
		h.DB.ClearCreditHistory()
		h.Lg.Info("CREDIT_MONITOR", "管理员已清空积分历史变动记录")
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true))
		return true

	// 7. 模型全量看板数据
	case path == "/api/models-detail" && method == http.MethodGet:
		writeJSON(w, http.StatusOK, h.Adapters.Models.FetchDetailedModels(qs(u, "refresh") == "1"))
		return true

	// 7.1 模型黑名单：读取（附带命中预览）
	case path == "/api/models/blacklist" && method == http.MethodGet:
		preview := []any{}
		for _, m := range h.Adapters.Models.FetchDetailedModels(false) {
			regions := upstream.GetArr(m, "regions")
			if len(regions) == 0 {
				regions = []any{"cn"}
			}
			id := upstream.GetString(m, "id")
			for _, rv := range regions {
				region := upstream.ToStr(rv)
				prefixed := "cn:" + id
				if region == "intl" {
					prefixed = "intl:" + id
				}
				if h.Store.IsModelBlacklisted(prefixed, id, region) {
					preview = append(preview, upstream.NewObj().Set("id", prefixed).Set("bare", id).Set("region", region))
				}
			}
		}
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("blacklist", h.Store.GetModelBlacklist()).
			Set("blockedPreview", preview).Set("blockedCount", len(preview)))
		return true

	// 7.2 模型黑名单：保存（整体替换，热生效并落盘）
	case path == "/api/models/blacklist" && method == http.MethodPost:
		body, ok := readBody(w, r, false)
		if !ok {
			return true
		}
		input := []string{}
		if arr, isArr := body.Get("blacklist").([]any); isArr {
			for _, it := range arr {
				input = append(input, upstream.ToStr(it))
			}
		}
		clean := h.Store.SetModelBlacklist(input)
		_ = h.Store.SaveConfig()
		h.Lg.Info("CONFIG", fmt.Sprintf("模型黑名单已更新 (共 %d 条规则，已热生效)", len(clean)), logger.NewMeta("blacklist", clean))
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("success", true).Set("blacklist", clean).Set("count", len(clean)))
		return true

	// 7.3 单个模型网关思考档位配置更新
	case path == "/api/models/thinking-level" && method == http.MethodPost:
		body, ok := readBody(w, r, false)
		if !ok {
			return true
		}
		modelID := ""
		if s, isStr := rawStr(body, "modelId"); isStr {
			modelID = strings.TrimSpace(s)
		}
		if modelID == "" {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("success", false).Set("error", "缺少 modelId"))
			return true
		}
		level := "default"
		if s, isStr := rawStr(body, "level"); isStr {
			level = strings.TrimSpace(s)
		}
		updated, err := h.Store.SetModelThinkingLevel(modelID, level)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("success", false).Set("error", err.Error()))
			return true
		}
		h.Lg.Info("CONFIG", fmt.Sprintf("已更新模型 [%s] 网关思考档位为: %s", modelID, level))
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("success", true).Set("modelId", modelID).Set("level", level).Set("thinkingPolicy", updated))
		return true

	// 8. OAuth 扫码授权开始 (对齐 ExternalLinkAuthenticationProvider.fetchAuthState)
	case path == "/api/oauth/start" && method == http.MethodPost:
		h.oauthStart(w, r, u)
		return true

	// 9. OAuth 扫码授权轮询 (对齐 loopGetToken & loopGetAccount)
	case path == "/api/oauth/poll" && method == http.MethodPost:
		h.oauthPoll(w, r, u)
		return true

	// 10. 全员打卡签到
	case path == "/api/checkin" && method == http.MethodPost:
		accounts := h.Store.Accounts().List()
		results := make([]any, 0, len(accounts))
		for _, a := range accounts {
			res := h.Sched.DailyCheckin(a.UID, true)
			results = append(results, upstream.NewObj().Set("uid", a.UID).Set("email", a.Email).Set("success", res.Success).
				Set("alreadyCheckedIn", res.AlreadyCheckedIn).Set("msg", res.Msg))
		}
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("total", len(accounts)).Set("results", results))
		return true

	// 11. 单号打卡签到
	case path == "/api/checkin-single" && method == http.MethodPost:
		body, err := readJSONBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("error", "请求体不是合法 JSON"))
			return true
		}
		uid, _ := rawStr(body, "uid")
		if h.Store.Accounts().Get(uid) == nil {
			writeJSON(w, http.StatusNotFound, upstream.NewObj().Set("error", "Account not found"))
			return true
		}
		force := true
		if b, ok := rawBool(body, "force"); ok && !b {
			force = false
		}
		writeJSON(w, http.StatusOK, h.Sched.DailyCheckin(uid, force))
		return true

	// 12. 账号备注更新接口
	case path == "/api/accounts/note" && method == http.MethodPost:
		body, err := readJSONBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("error", jsErrorMessage(err)))
			return true
		}
		uid, _ := rawStr(body, "uid")
		if h.Store.Accounts().Get(uid) == nil {
			writeJSON(w, http.StatusNotFound, upstream.NewObj().Set("error", "Account not found"))
			return true
		}
		note, _ := rawStr(body, "note")
		note = strings.TrimSpace(note)
		h.Store.Accounts().Mutate(uid, func(a *config.Account) { a.Note = note })
		_ = h.Store.SaveAccounts()
		h.Lg.Info("ACCOUNTS", fmt.Sprintf("已更新账号 [%s] 备注为: \"%s\"", config.AccountFullDesc(h.Store.Accounts().Get(uid)), note))
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true).Set("note", note))
		return true

	// 12.5b 修改账号所属区域（国内版 / 国际版）
	case path == "/api/accounts/region" && method == http.MethodPost:
		body, err := readJSONBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("error", jsErrorMessage(err)))
			return true
		}
		uid, _ := rawStr(body, "uid")
		if h.Store.Accounts().Get(uid) == nil {
			writeJSON(w, http.StatusNotFound, upstream.NewObj().Set("error", "Account not found"))
			return true
		}
		region, _ := rawStr(body, "region")
		next := config.NormalizeRegion(region)
		h.Store.Accounts().Mutate(uid, func(a *config.Account) { a.Region = next })
		_ = h.Store.SaveAccounts()
		h.Lg.Info("ACCOUNTS", fmt.Sprintf("已将账号 [%s] 区域设为 %s", config.AccountFullDesc(h.Store.Accounts().Get(uid)), config.BaseForRegion(next).Label))
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true).Set("region", next).Set("label", config.BaseForRegion(next).Label))
		return true

	// 12.6 网关指定/锁定全局优先账号接口
	case path == "/api/accounts/pin" && method == http.MethodPost:
		body, err := readJSONBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("error", jsErrorMessage(err)))
			return true
		}
		uid, _ := rawStr(body, "uid")
		pinned := strings.TrimSpace(uid)
		_ = h.Store.UpdateConfig(func(c *config.Config) { c.PinnedAccount = pinned })
		if acc := h.Store.Accounts().Get(pinned); pinned != "" && acc != nil {
			h.Lg.Info("CONFIG", fmt.Sprintf("网关已锁定全局优先指定账号: [%s]", config.AccountFullDesc(acc)))
		} else {
			h.Lg.Info("CONFIG", "网关已取消全局指定账号，恢复全池自动负载轮换")
		}
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true).Set("pinnedAccount", pinned))
		return true

	// 12.8 手动触发指定账号换发新令牌接口
	case path == "/api/accounts/refresh-token" && method == http.MethodPost:
		body, err := readJSONBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("error", jsErrorMessage(err)))
			return true
		}
		uid, _ := rawStr(body, "uid")
		if h.Store.Accounts().Get(uid) == nil {
			writeJSON(w, http.StatusNotFound, upstream.NewObj().Set("error", "Account not found"))
			return true
		}
		writeJSON(w, http.StatusOK, h.Sched.RefreshSessionToken(uid))
		return true

	// 12.9 一键解除账号模型锁池/冷却状态
	case path == "/api/accounts/unlock-models" && method == http.MethodPost:
		body, err := readJSONBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("error", jsErrorMessage(err)))
			return true
		}
		uid, _ := rawStr(body, "uid")
		acc := h.Store.Accounts().Get(uid)
		if acc == nil {
			writeJSON(w, http.StatusNotFound, upstream.NewObj().Set("error", "Account not found"))
			return true
		}
		if upstream.Truthy(body.Get("modelId")) {
			m := upstream.ToStr(body.Get("modelId"))
			h.Store.Accounts().Mutate(uid, func(a *config.Account) {
				delete(a.ModelCooldowns, m)
				delete(a.ModelCooldownReasons, m)
			})
			h.Lg.Info("COOLDOWN", fmt.Sprintf("已手动解除账号 [%s] 对模型 [%s] 的锁池冷却", config.AccountFullDesc(acc), m))
		} else {
			restricted := acc.Status == "restricted"
			h.Store.Accounts().Mutate(uid, func(a *config.Account) {
				a.ModelCooldowns = map[string]int64{}
				a.ModelCooldownReasons = map[string]string{}
				a.CooldownUntil = 0
				if a.Status == "restricted" {
					a.Status = "healthy"
					a.RestrictedAt = 0
					a.RestrictedReason = ""
				}
			})
			if restricted {
				h.Lg.Info("COOLDOWN", fmt.Sprintf("已手动解除账号 [%s] 的风控受限状态，已恢复健康活跃", config.AccountFullDesc(acc)))
			}
			h.Lg.Info("COOLDOWN", fmt.Sprintf("已手动一键解除账号 [%s] 的所有模型锁池与冷却状态", config.AccountFullDesc(acc)))
		}
		_ = h.Store.SaveAccounts()
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true).Set("msg", "锁池与受限状态已成功解除"))
		return true

	// 12.10 报表统计按时间清理接口 (保留今天 / 保留N天 / 一键清空全部)
	case path == "/api/metrics/prune" && method == http.MethodPost:
		body, ok := readBody(w, r, false)
		if !ok {
			return true
		}
		mode, _ := rawStr(body, "mode")
		keepDays := 0
		if v, ok := rawNum(body, "keepDays"); ok {
			keepDays = int(v)
		}
		pr := h.Metrics.PruneByTime(mode, keepDays)
		h.Lg.Info("STATS", fmt.Sprintf("统计报表按时间清理完成 (模式: %s, 保留天数: %d, 删除历史天数: %d)", mode, orInt(keepDays, 1), pr.DeletedDaysCount))
		writeJSON(w, http.StatusOK, pr)
		return true

	// 12.11 运行日记按时间清理接口
	case path == "/api/logs/prune" && method == http.MethodPost:
		body, ok := readBody(w, r, false)
		if !ok {
			return true
		}
		mode, _ := rawStr(body, "mode")
		keepDays := 0
		if v, ok := rawNum(body, "keepDays"); ok {
			keepDays = int(v)
		}
		writeJSON(w, http.StatusOK, h.Lg.PruneLogsByTime(mode, keepDays))
		return true

	// 12.95 批量/单个导入官方 CLI 或外部导出的账号凭据
	case path == "/api/accounts/import" && method == http.MethodPost:
		h.importAccounts(w, r)
		return true

	// 13. 账号删除
	case path == "/api/accounts/delete" && method == http.MethodPost:
		body, err := readJSONBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("error", "请求体不是合法 JSON"))
			return true
		}
		uid, _ := rawStr(body, "uid")
		if acc := h.Store.Accounts().Get(uid); acc != nil {
			name := acc.Email
			if name == "" {
				name = uid
			}
			if h.Store.Accounts().Remove(uid) {
				_ = h.Store.SaveAccounts()
				h.Lg.Warn("ACCOUNTS", "已从账号池移除账号: ["+name+"]")
			}
		}
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true))
		return true
	}
	return false
}

// pickAccount 按 uid 查找；未指定则取首个 healthy，否则首个。
func (h *Handler) pickAccount(uid string) *config.Account {
	if uid != "" {
		return h.Store.Accounts().Get(uid)
	}
	if acc := h.Store.Accounts().Find(func(a *config.Account) bool { return a.Status == "healthy" }); acc != nil {
		return acc
	}
	return h.Store.Accounts().Find(func(*config.Account) bool { return true })
}

// listAccounts GET /api/accounts。
func (h *Handler) listAccounts(w http.ResponseWriter, u *url.URL) {
	forceRefresh := qs(u, "refresh") == "1"
	staleDisabled := qs(u, "stale") == "0"
	rng := qs(u, "range")
	if rng == "" {
		rng = "today"
	}
	if forceRefresh || !staleDisabled {
		// 默认行为：若某账号积分已超过 30s 未刷新则顺带拉一次上游
		minAge := int64(30000)
		if forceRefresh {
			minAge = 0
		}
		h.Sched.RefreshStaleCredits(minAge, forceRefresh)
	}
	accStats := h.Metrics.AccountStatsByRange(rng)
	allStats := accStats
	if rng != "all" {
		allStats = h.Metrics.AccountStatsByRange("all")
	}
	c := h.Store.Config()
	advanceDays := c.TokenRefreshAdvanceDaysOr()
	advanceMs := int64(advanceDays) * 24 * 60 * 60 * 1000
	now := time.Now().UnixMilli()
	today := config.TodayString()

	accounts := h.Store.Accounts().List()
	out := make([]any, 0, len(accounts))
	for _, a := range accounts {
		// 提取该账号当前所有活跃被锁的模型、剩余解锁秒数与限流原因（过期的顺手清掉）
		locked := []any{}
		var expired []string
		if len(a.ModelCooldowns) > 0 {
			ids := make([]string, 0, len(a.ModelCooldowns))
			for mID := range a.ModelCooldowns {
				ids = append(ids, mID)
			}
			sort.Strings(ids)
			for _, mID := range ids {
				expireAt := a.ModelCooldowns[mID]
				if now < expireAt {
					reason := a.ModelCooldownReasons[mID]
					if reason == "" {
						reason = "上游限频退避"
					}
					locked = append(locked, upstream.NewObj().Set("modelId", mID).
						Set("remainingSec", int64(math.Ceil(float64(expireAt-now)/1000))).Set("expireAt", expireAt).Set("reason", reason))
				} else {
					expired = append(expired, mID)
				}
			}
		}
		if len(expired) > 0 {
			uid := a.UID
			h.Store.Accounts().Mutate(uid, func(x *config.Account) {
				for _, mID := range expired {
					delete(x.ModelCooldowns, mID)
					delete(x.ModelCooldownReasons, mID)
				}
			})
		}
		var tokens, inputTokens, outputTokens, requests int64
		if s := lookupStat(accStats, a); s != nil {
			tokens, inputTokens, outputTokens, requests = s.TotalTokens, s.InputTokens, s.OutputTokens, s.Requests
		}
		var allTokens int64
		if s := lookupStat(allStats, a); s != nil {
			allTokens = s.TotalTokens
		}
		var daysRemaining any
		if a.ExpiresAt != 0 {
			daysRemaining = round1(math.Max(0, float64(a.ExpiresAt-now)/86400000))
		}
		canAutoRefresh := a.RefreshToken != ""
		isRefreshEligible := canAutoRefresh && (a.ExpiresAt == 0 || now > a.ExpiresAt-advanceMs)
		isGlobalCooldown := now < a.CooldownUntil
		cooldownRemaining := int64(0)
		if isGlobalCooldown {
			cooldownRemaining = int64(math.Ceil(float64(a.CooldownUntil-now) / 1000))
		}
		checkedIn := a.LastCheckinDate == today && (a.LastCheckinSuccess || checkinDoneMsg(a.LastCheckinMsg))
		var lastCheckinMsg string
		if checkedIn {
			lastCheckinMsg = a.LastCheckinMsg
			if lastCheckinMsg == "" {
				lastCheckinMsg = "今天已签到"
				if a.Region == "intl" {
					lastCheckinMsg = "今日活跃打卡已完成"
				}
			}
		} else {
			lastCheckinMsg = "今日未签到"
			if a.Region == "intl" {
				lastCheckinMsg = "今日未打卡"
			}
		}
		expiresAtFmt := "未知"
		if a.ExpiresAt != 0 {
			// Node: new Date(expiresAt).toLocaleDateString()，zh-CN 区域默认输出 YYYY/M/D
			expiresAtFmt = time.UnixMilli(a.ExpiresAt).Format("2006/1/2")
		}
		out = append(out, upstream.NewObj().Set("uid", a.UID).Set("email", a.Email).Set("note", a.Note).
			// 所属区域：前后端都用它决定上游 base 域名
			Set("region", config.NormalizeRegion(a.Region)).
			Set("creditsRemain", a.CreditsRemain).
			// 积分最后一次成功从上游刷新的时间戳（毫秒）
			Set("creditsUpdatedAt", a.CreditsUpdatedAt).
			Set("totalTokens", tokens).Set("totalTokensDisplay", metrics.FormatTokenNumber(tokens)).
			Set("inputTokens", inputTokens).Set("outputTokens", outputTokens).Set("requests", requests).
			Set("tokenRange", rng).
			Set("allTimeTokens", allTokens).Set("allTimeTokensDisplay", metrics.FormatTokenNumber(allTokens)).
			Set("inFlight", a.InFlight).
			Set("status", a.Status).
			Set("restrictedReason", a.RestrictedReason).Set("restrictedAt", a.RestrictedAt).
			Set("expiresAt", a.ExpiresAt).Set("expiresAtFmt", expiresAtFmt).
			Set("hasRefreshToken", canAutoRefresh).
			Set("daysRemaining", daysRemaining).
			Set("advanceDays", advanceDays).
			Set("isRefreshEligible", isRefreshEligible).
			Set("isCooldown", isGlobalCooldown).Set("cooldownRemainingSec", cooldownRemaining).
			Set("lockedModels", locked).Set("lockedCount", len(locked)).
			Set("isCheckedInToday", checkedIn).
			Set("lastCheckinMsg", lastCheckinMsg))
	}
	writeJSON(w, http.StatusOK, out)
}

// oauthStart 发起设备码授权。
func (h *Handler) oauthStart(w http.ResponseWriter, r *http.Request, u *url.URL) {
	raw, _ := io.ReadAll(r.Body)
	reqRegion := qs(u, "region")
	if reqRegion == "" && len(raw) > 0 {
		if o, err := upstream.ParseObj(raw); err == nil {
			reqRegion = strTruthy(o.Get("region"))
		}
	}
	region := config.NormalizeRegion(reqRegion)
	ep := config.EndpointsForRegion(region)
	hdr := http.Header{}
	hdr.Set("Content-Type", "application/json")
	hdr.Set("User-Agent", config.UserAgent)
	_, resp, err := h.Adapters.Client.DoJSON(r.Context(), http.MethodPost, ep.AuthState, hdr, []byte("{}"))
	if err != nil {
		h.Lg.Error("OAUTH", "生成登录链接失败: "+err.Error())
		writeJSON(w, http.StatusInternalServerError, upstream.NewObj().Set("error", err.Error()))
		return
	}
	oauthData, perr := upstream.ParseObj(resp)
	if perr != nil {
		h.Lg.Error("OAUTH", "生成登录链接失败: "+perr.Error())
		writeJSON(w, http.StatusInternalServerError, upstream.NewObj().Set("error", perr.Error()))
		return
	}
	payload := oauthData
	if d := upstream.GetObj(oauthData, "data"); upstream.Truthy(d) {
		payload = d
	}
	state := strTruthy(payload.Get("state"))
	// 登录页 URL：官方 CLI 实际打开的是 web 域 + 尾斜杠 + version（见 routes.mjs:929-942），
	// 优先 ep.LoginURL(state)，仅当为空时回落服务端下发的 authUrl。
	loginURL := ep.LoginURL(state)
	if loginURL == "" {
		loginURL = upstream.GetString(payload, "authUrl")
	}
	h.Lg.Info("OAUTH", fmt.Sprintf("发起设备码授权 [%s], state: %s", config.BaseForRegion(region).Label, state))
	writeJSON(w, http.StatusOK, upstream.NewObj().Set("state", state).Set("loginUrl", loginURL).Set("region", region))
}

// oauthPoll 轮询授权结果并录入账号。
func (h *Handler) oauthPoll(w http.ResponseWriter, r *http.Request, u *url.URL) {
	raw, _ := io.ReadAll(r.Body)
	parsed, err := upstream.ParseObj(raw)
	if err != nil || parsed == nil {
		writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("ok", false).Set("error", "请求体不是合法 JSON"))
		return
	}
	state := strTruthy(parsed.Get("state"))
	bodyRegion := strTruthy(parsed.Get("region"))
	if bodyRegion == "" {
		bodyRegion = qs(u, "region")
	}
	pollRegion := config.NormalizeRegion(bodyRegion)
	ep := config.EndpointsForRegion(pollRegion)

	// 官方原生使用 GET 方法轮询 token
	hdr := http.Header{}
	hdr.Set("User-Agent", config.UserAgent)
	_, resp, derr := h.Adapters.Client.DoJSON(r.Context(), http.MethodGet, ep.AuthTokenURL(state), hdr, nil)
	if derr != nil {
		h.Lg.Error("OAUTH", "轮询授权异常: "+derr.Error())
		writeJSON(w, http.StatusInternalServerError, upstream.NewObj().Set("error", derr.Error()))
		return
	}
	envelope, perr := upstream.ParseObj(resp)
	if perr != nil {
		h.Lg.Error("OAUTH", "轮询授权异常: "+perr.Error())
		writeJSON(w, http.StatusInternalServerError, upstream.NewObj().Set("error", perr.Error()))
		return
	}
	tokenData := envelope
	if d := upstream.GetObj(envelope, "data"); upstream.Truthy(d) {
		tokenData = d
	}
	accessToken := upstream.GetString(tokenData, "access_token")
	if accessToken == "" {
		accessToken = upstream.GetString(tokenData, "accessToken")
	}
	// 官方等待码 11217 (LOGIN_TOKEN_PENDING_CODE)
	if codeNum, ok := upstream.GetNum(envelope.Get("code")); (ok && codeNum == 11217) || accessToken == "" {
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", false).Set("msg", "等待手机扫码授权中..."))
		return
	}
	refreshToken := upstream.GetString(tokenData, "refresh_token")
	if refreshToken == "" {
		refreshToken = upstream.GetString(tokenData, "refreshToken")
	}
	expiresIn, ok := upstream.GetNum(tokenData.Get("expires_in"))
	if !ok || expiresIn == 0 {
		expiresIn, ok = upstream.GetNum(tokenData.Get("expiresIn"))
	}
	if !ok || expiresIn == 0 {
		expiresIn = 7200
	}

	// 调用官方账号快照接口 GET /v2/plugin/accounts (对齐 getAccountSnapshot)
	var accountInfo *upstream.Obj
	if status, body, err := h.Adapters.Client.DoJSON(r.Context(), http.MethodGet, ep.Accounts, bearer(hdr, accessToken), nil); err == nil && status >= 200 && status < 300 {
		if o, perr := upstream.ParseObj(body); perr == nil {
			list := upstream.GetArr(upstream.GetObj(o, "data"), "accounts")
			for _, it := range list {
				if a, isObj := it.(*upstream.Obj); isObj && upstream.Truthy(a.Get("lastLogin")) {
					accountInfo = a
					break
				}
			}
			if accountInfo == nil && len(list) > 0 {
				accountInfo, _ = list[0].(*upstream.Obj)
			}
		}
	}
	// 兜底备用：GET /v2/plugin/login/account?state=
	if accountInfo == nil {
		if status, body, err := h.Adapters.Client.DoJSON(r.Context(), http.MethodGet, ep.LoginAccountURL(state), bearer(hdr, accessToken), nil); err == nil && status >= 200 && status < 300 {
			if o, perr := upstream.ParseObj(body); perr == nil {
				accountInfo = o
				if d := upstream.GetObj(o, "data"); upstream.Truthy(d) {
					accountInfo = d
				}
			}
		}
	}

	rawUID := strTruthy(accountInfo.Get("uid"))
	if rawUID == "" {
		rawUID = strTruthy(accountInfo.Get("uin"))
	}
	if rawUID == "" {
		rawUID = fmt.Sprintf("uid_%d", time.Now().UnixMilli())
	}
	nickname := upstream.GetString(accountInfo, "nickname")
	if nickname == "" {
		nickname = upstream.GetString(accountInfo, "nick_name")
	}
	if nickname == "" {
		nickname = upstream.GetString(accountInfo, "phoneNumber")
	}
	if nickname == "" {
		nickname = "已授权账号"
	}
	accType := upstream.GetString(accountInfo, "type")
	if accType == "" {
		accType = "personal"
	}
	newAcc := &config.Account{
		UID:         rawUID,
		Uin:         upstream.GetString(accountInfo, "uin"),
		Email:       nickname,
		PhoneNumber: upstream.GetString(accountInfo, "phoneNumber"),
		Type:        accType,
		// 区域由授权时选择决定，后续所有上游调用都按此字段选 base 域名
		Region:        pollRegion,
		AccessToken:   accessToken,
		RefreshToken:  refreshToken,
		ExpiresAt:     time.Now().UnixMilli() + int64(expiresIn*1000),
		CreditsRemain: 0,
		Status:        "healthy",
		InFlight:      0,
	}

	// 如果已有相同 uid/uin，则替换更新
	existing := h.Store.Accounts().Find(func(a *config.Account) bool {
		return a.UID == newAcc.UID || (newAcc.Uin != "" && a.Uin == newAcc.Uin)
	})
	if existing != nil {
		if existing.UID == newAcc.UID {
			h.Store.Accounts().Mutate(newAcc.UID, func(a *config.Account) { *a = *newAcc })
		} else {
			h.Store.Accounts().Remove(existing.UID)
			h.Store.Accounts().Upsert(newAcc)
		}
	} else {
		h.Store.Accounts().Upsert(newAcc)
	}
	_ = h.Store.SaveAccounts()
	h.Lg.Info("OAUTH", fmt.Sprintf("新账号授权成功录入: [%s (UID: %s)]", newAcc.Email, newAcc.UID))
	go h.Sched.RefreshCredits(newAcc.UID)

	// [P0] 不回传 accessToken / refreshToken。
	writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true).Set("account", upstream.NewObj().
		Set("uid", newAcc.UID).Set("uin", newAcc.Uin).Set("email", newAcc.Email).Set("phoneNumber", newAcc.PhoneNumber).
		Set("type", newAcc.Type).Set("region", newAcc.Region).Set("expiresAt", newAcc.ExpiresAt).
		Set("creditsRemain", newAcc.CreditsRemain).Set("status", newAcc.Status).Set("inFlight", newAcc.InFlight).
		Set("hasRefreshToken", refreshToken != "")))
}

// importAccounts 批量/单个导入账号凭据。
func (h *Handler) importAccounts(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	payloadAny, err := upstream.ParseAny(raw)
	if err != nil {
		if robust, rerr := config.RobustParseJSON(string(raw)); rerr == nil {
			payloadAny, err = upstream.ParseAny(robust)
		}
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("error", "解析或导入失败: "+jsErrorMessage(err)))
		return
	}
	if o, isObj := payloadAny.(*upstream.Obj); isObj {
		if rj, ok := rawStr(o, "rawJson"); ok {
			if robust, rerr := config.RobustParseJSON(rj); rerr == nil {
				if p2, perr := upstream.ParseAny(robust); perr == nil {
					payloadAny = p2
				}
			}
		}
	}
	list := []any{}
	switch t := payloadAny.(type) {
	case []any:
		list = t
	case *upstream.Obj:
		if arr := upstream.GetArr(t, "accounts"); arr != nil {
			list = arr
		} else if acc := upstream.GetObj(t, "account"); upstream.Truthy(acc) {
			if auth := upstream.GetObj(t, "auth"); upstream.Truthy(auth) {
				merged := acc.Clone()
				for _, k := range auth.Keys() {
					merged.Set(k, auth.Get(k))
				}
				list = []any{merged}
			} else {
				list = []any{acc}
			}
		} else if upstream.Truthy(t.Get("accessToken")) || upstream.Truthy(t.Get("refreshToken")) || upstream.Truthy(t.Get("uid")) {
			list = []any{t}
		}
	}
	if len(list) == 0 {
		writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("error", "未识别到有效的账号数据，请检查 JSON 结构"))
		return
	}
	imported := make([]*config.Account, 0, len(list))
	for _, item := range list {
		o, isObj := item.(*upstream.Obj)
		if !isObj {
			continue
		}
		b, _ := upstream.MarshalJSON(o)
		var acc config.Account
		if err := json.Unmarshal(b, &acc); err != nil {
			continue
		}
		norm := config.NormalizeAccount(&acc)
		if norm == nil || (norm.AccessToken == "" && norm.RefreshToken == "") {
			continue
		}
		if h.Store.Accounts().Get(norm.UID) != nil {
			h.Store.Accounts().Mutate(norm.UID, func(a *config.Account) {
				if norm.AccessToken != "" {
					a.AccessToken = norm.AccessToken
				}
				if norm.RefreshToken != "" {
					a.RefreshToken = norm.RefreshToken
				}
				if norm.ExpiresAt != 0 {
					a.ExpiresAt = norm.ExpiresAt
				}
				if norm.Domain != "" {
					a.Domain = norm.Domain
				}
				if norm.Realm != "" {
					a.Realm = norm.Realm
				}
				if norm.Product != "" {
					a.Product = norm.Product
				}
				if norm.Region != "" {
					a.Region = norm.Region
				}
				if norm.Endpoint != "" {
					a.Endpoint = norm.Endpoint
				}
				a.Status = "healthy"
				if norm.Email != "" && norm.Email != "unnamed-account" {
					a.Email = norm.Email
				}
				if norm.Note != "" && (a.Note == "" || a.Note == "默认账号") {
					a.Note = norm.Note
				}
			})
			imported = append(imported, h.Store.Accounts().Get(norm.UID))
		} else {
			h.Store.Accounts().Upsert(norm)
			imported = append(imported, norm)
		}
		go h.Sched.RefreshCredits(norm.UID)
	}
	_ = h.Store.SaveAccounts()
	h.Lg.Info("AUTH", fmt.Sprintf("成功导入/更新 %d 个账号凭据", len(imported)))
	rows := make([]any, 0, len(imported))
	for _, a := range imported {
		rows = append(rows, upstream.NewObj().Set("uid", a.UID).Set("email", a.Email).Set("region", a.Region).
			Set("domain", a.Domain).Set("product", a.Product).Set("note", a.Note).Set("creditsRemain", a.CreditsRemain))
	}
	writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true).Set("count", len(imported)).Set("imported", rows))
}

// ─── 小工具 ───

func lookupStat(m map[string]*metrics.AccountStat, a *config.Account) *metrics.AccountStat {
	if s, ok := m[a.UID]; ok {
		return s
	}
	return m[a.Email]
}

func checkinDoneMsg(msg string) bool {
	for _, k := range []string{"已签到", "已打卡", "成功", "完成"} {
		if strings.Contains(msg, k) {
			return true
		}
	}
	return false
}

// round1 JS Number(x.toFixed(1))。
func round1(v float64) float64 {
	f, _ := strconv.ParseFloat(fmt.Sprintf("%.1f", v), 64)
	return f
}

func orInt(v, def int) int {
	if v == 0 {
		return def
	}
	return v
}

func numOr(s string, def float64) float64 {
	return float64(atoiOr(s, int(def)))
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// strTruthy JS `v || ”` 再 String(v)。
func strTruthy(v any) string {
	if !upstream.Truthy(v) {
		return ""
	}
	return upstream.ToStr(v)
}

func bearer(h http.Header, token string) http.Header {
	out := h.Clone()
	out.Set("Authorization", "Bearer "+token)
	return out
}

func mergeObj(dst, src *upstream.Obj) {
	if src == nil {
		return
	}
	for _, k := range src.Keys() {
		dst.Set(k, src.Get(k))
	}
}
