package web

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/database"
	"codebuddy-gateway/internal/core/logger"
	"codebuddy-gateway/internal/core/pricing"
	"codebuddy-gateway/internal/upstream"
)

// handleAPI /api/* 运维与管理 API 路由总线（routes.mjs:142-1431）。
func (h *Handler) handleAPI(w http.ResponseWriter, r *http.Request, u *url.URL) {
	path, method := u.Path, r.Method

	// A. Web 控制台登录验证接口（公开）
	if path == "/api/auth/login" && method == http.MethodPost {
		body, err := readJSONBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("error", jsErrorMessage(err)))
			return
		}
		inputPass := ""
		v, _ := body.GetOK("password")
		if !upstream.Truthy(v) {
			v, _ = body.GetOK("token")
		}
		switch t := v.(type) {
		case nil:
		case string:
			inputPass = strings.TrimSpace(t)
		default:
			// JS: (body.password || body.token || '').trim 抛 TypeError
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("error", "(intermediate value).trim is not a function"))
			return
		}
		// [P0] 与 verifyWebAuthToken 保持同一判定口径，不再单独回落到 isValidApiKey
		c := h.Store.Config()
		if !c.IsWebAuthEnabled() || h.VerifyWebAuthToken(inputPass) {
			h.Lg.Info("AUTH", "Web 控制台授权成功通过 (IP: "+remoteIP(r)+")")
			token := ""
			if c.IsWebAuthEnabled() {
				if p := h.WebAuthPassword(); p != "" {
					token = p
				} else {
					token = inputPass
				}
			}
			writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true).Set("token", token).
				Set("webAuthEnabled", c.IsWebAuthEnabled()).Set("hasDedicatedPassword", h.HasDedicatedWebPassword()))
			return
		}
		h.Lg.Warn("AUTH", "Web 控制台授权凭据错误 (IP: "+remoteIP(r)+")")
		writeJSON(w, http.StatusForbidden, upstream.NewObj().Set("ok", false).Set("error", "控制台密码或 API Key 不正确，请重新输入"))
		return
	}

	// B. Web 控制台授权状态查询接口（公开）
	if path == "/api/auth/status" && method == http.MethodGet {
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("webAuthEnabled", h.Store.Config().IsWebAuthEnabled()).
			Set("authenticated", h.VerifyWebAuthToken(extractWebToken(r, u))))
		return
	}

	// ─── Web 控制台 API 安全守卫拦截 ───
	if h.Store.Config().IsWebAuthEnabled() && !h.VerifyWebAuthToken(extractWebToken(r, u)) {
		writeJSON(w, http.StatusUnauthorized, upstream.NewObj().
			Set("error", "Unauthorized: Web console authentication required").Set("code", "UNAUTHORIZED"))
		return
	}

	// 0. 报表统计概览接口 (支持 ?range=today|yesterday|7d|30d|all)
	if path == "/api/metrics" && method == http.MethodGet {
		rng := qs(u, "range")
		if rng == "" {
			rng = "all"
		}
		report := h.Metrics.GetReport(h.Pricing.LoadModelPrices(), rng)
		rb, _ := upstream.MarshalJSON(report)
		o, _ := upstream.ParseObj(rb)
		if o == nil {
			o = upstream.NewObj()
		}
		// 网关连续运行时长：取进程真实存活时间，供控制台顶部展示
		uptimeMs := h.UptimeMs()
		o.Set("currentAccount", h.Sched.CurrentActiveAccountInfo()).
			Set("sessionAffinity", h.Sched.GetSessionAffinityStats()).
			Set("uptimeMs", upstream.Num(uptimeMs)).
			Set("uptime", config.FormatUptime(uptimeMs)).
			Set("startedAt", time.Now().Add(-time.Duration(uptimeMs)*time.Millisecond).UTC().Format("2006-01-02T15:04:05.000Z07:00"))
		writeJSON(w, http.StatusOK, o)
		return
	}

	// 1. 策略设置读取接口
	if path == "/api/settings" && method == http.MethodGet {
		writeJSON(w, http.StatusOK, h.settingsView())
		return
	}

	// 2. 策略设置更新接口 (热更新生效并落盘)
	if path == "/api/settings" && method == http.MethodPost {
		body, err := readJSONBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("error", jsErrorMessage(err)))
			return
		}
		if err := h.updateSettings(body); err != nil {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("error", err.Error()))
			return
		}
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true).Set("config", h.Store.Config()).
			Set("apiKeys", h.Store.GetAPIKeys()).Set("webAuthToken", h.WebAuthPassword()).
			Set("promptPolicy", h.Store.GetPromptPolicy()).Set("logDbSizeMb", h.DB.SizeMb()))
		return
	}

	// 2.2 清空所有活跃的会话粘性绑定
	if path == "/api/sessions/clear" && method == http.MethodPost {
		cleared := h.Sched.ClearSticky()
		h.Lg.Info("CONFIG", fmt.Sprintf("管理员通过 Web 控制台清空了当前所有会话粘性绑定 (%d 条)", cleared))
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true).Set("cleared", cleared))
		return
	}

	// 2.5 API Key 独立多密钥管理接口
	// [P0 关联修复] 默认脱敏返回，只有显式传 ?reveal=1 才返回完整值。
	if path == "/api/keys" && method == http.MethodGet {
		reveal := qs(u, "reveal") == "1"
		keys := h.Store.GetAPIKeys()
		c := h.Store.Config()
		list := make([]any, 0, len(keys))
		for _, k := range keys {
			list = append(list, upstream.NewObj().Set("id", k.ID).Set("note", k.Note).Set("createdAt", upstream.Num(k.CreatedAt)).
				Set("enabled", k.Enabled).Set("isPrimary", k.Key == c.APIKey).Set("key", maskKeyOr(k.Key, reveal)))
		}
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true).Set("revealed", reveal).
			Set("apiKey", maskKeyOr(c.APIKey, reveal)).Set("keys", list))
		return
	}

	if path == "/api/keys" && method == http.MethodPost {
		body, ok := readBody(w, r, true)
		if !ok {
			return
		}
		key, _ := rawStr(body, "key")
		note, _ := rawStr(body, "note")
		entry, err := h.Store.AddAPIKey(key, note)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("ok", false).Set("error", err.Error()))
			return
		}
		h.Lg.Info("CONFIG", fmt.Sprintf("管理员通过 Web 控制台添加了 API Key [%s] (%s)", entry.ID, entry.Note))
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true).Set("entry", entry).
			Set("apiKey", h.Store.Config().APIKey).Set("keys", h.Store.GetAPIKeys()))
		return
	}

	if path == "/api/keys/update" && method == http.MethodPost {
		body, ok := readBody(w, r, true)
		if !ok {
			return
		}
		id, _ := rawStr(body, "id")
		if id == "" {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("ok", false).Set("error", "缺少密钥 ID"))
			return
		}
		updated, err := h.Store.UpdateAPIKey(id, optStr(body, "note"), optBool(body, "enabled"), optStr(body, "key"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("ok", false).Set("error", err.Error()))
			return
		}
		h.Lg.Info("CONFIG", fmt.Sprintf("管理员通过 Web 控制台更新了 API Key [%s] (%s)", id, updated.Note))
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true).Set("entry", updated).
			Set("apiKey", h.Store.Config().APIKey).Set("keys", h.Store.GetAPIKeys()))
		return
	}

	if path == "/api/keys/delete" && method == http.MethodPost {
		body, ok := readBody(w, r, true)
		if !ok {
			return
		}
		id, _ := rawStr(body, "id")
		if id == "" {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("ok", false).Set("error", "缺少密钥 ID"))
			return
		}
		if err := h.Store.RemoveAPIKey(id); err != nil {
			writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("ok", false).Set("error", err.Error()))
			return
		}
		h.Lg.Info("CONFIG", "管理员通过 Web 控制台删除了 API Key ["+id+"]")
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true).
			Set("apiKey", h.Store.Config().APIKey).Set("keys", h.Store.GetAPIKeys()))
		return
	}

	// 3. 日志查询接口 (SQLite 按日期/级别/分类/关键词检索，默认单天最新 200 条)
	if path == "/api/logs" && method == http.MethodGet {
		writeJSON(w, http.StatusOK, h.Lg.GetLogs(logger.LogQuery{
			Date: qs(u, "date"), Level: qs(u, "level"), Category: qs(u, "category"), Search: qs(u, "search"),
			Limit: atoiOr(qs(u, "limit"), 200), Offset: atoiOr(qs(u, "offset"), 0),
		}))
		return
	}

	// 3.5 日志可用历史日期列表接口
	if path == "/api/logs/dates" && method == http.MethodGet {
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("dates", h.Lg.GetDates()))
		return
	}

	// 3.6 手动触发根据 MB 阈值裁剪日志数据库
	if path == "/api/logs/prune-size" && method == http.MethodPost {
		reqMb := h.Store.Config().MaxLogDbSizeMbOr()
		if body, err := readJSONBody(r); err == nil {
			if v, ok := rawNum(body, "maxSizeMb"); ok {
				reqMb = int(v)
			}
		}
		writeJSON(w, http.StatusOK, h.DB.CheckAndPruneBySize(reqMb))
		return
	}

	// 4. 日志全量/单天下单导出
	if path == "/api/logs/export" && method == http.MethodGet {
		exportDate := qs(u, "date")
		if exportDate != "" && exportDate != "ALL" {
			res := h.DB.QueryLogs(database.LogQuery{Date: exportDate, Limit: 10000})
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="gateway-%s.log"`, exportDate))
			w.WriteHeader(http.StatusOK)
			var sb strings.Builder
			for _, l := range res.Logs {
				sb.WriteByte('[')
				sb.WriteString(l.Time)
				sb.WriteString("] [")
				sb.WriteString(padEnd(l.Level, 5))
				sb.WriteString("] [")
				sb.WriteString(l.Category)
				sb.WriteString("] ")
				sb.WriteString(l.Message)
				if upstream.Truthy(l.Meta) {
					mb, _ := upstream.MarshalJSON(l.Meta)
					sb.WriteString(" | ")
					sb.Write(mb)
				}
				sb.WriteByte('\n')
			}
			_, _ = w.Write([]byte(sb.String()))
			return
		}
		if data, err := os.ReadFile(h.Store.Paths().LogFilePath); err == nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Header().Set("Content-Disposition", `attachment; filename="gateway.log"`)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(data)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("# 日志文件暂为空"))
		return
	}

	// 5. 清空内存日志
	if path == "/api/logs/clear" && method == http.MethodPost {
		h.Lg.Clear()
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true))
		return
	}

	// 5.5 官网模型定价查询与配置接口
	if path == "/api/pricing" && method == http.MethodGet {
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true).Set("prices", h.Pricing.LoadModelPrices()))
		return
	}

	// 5.6 基于网关联网检索功能在线检索最新官网价格
	if path == "/api/pricing/search" && method == http.MethodPost {
		q := ""
		if body, err := readJSONBody(r); err == nil {
			if s, ok := rawStr(body, "query"); ok && s != "" {
				q = s
			}
		}
		if q == "" {
			q = "大模型 API 官方价格"
		}
		acc := h.Store.Accounts().Find(func(a *config.Account) bool { return a.Status == "healthy" && a.AccessToken != "" })
		if acc == nil {
			acc = h.Store.Accounts().Find(func(a *config.Account) bool { return a.AccessToken != "" })
		}
		report, err := pricing.SearchOfficialPricingOnline(r.Context(), h.Adapters.Client, h.Lg, acc, q, h.Pricing.LoadModelPrices())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, upstream.NewObj().Set("ok", false).Set("error", err.Error()))
			return
		}
		out := upstream.NewObj().Set("ok", true)
		for _, k := range report.Keys() {
			out.Set(k, report.Get(k))
		}
		writeJSON(w, http.StatusOK, out)
		return
	}

	// 5.7 自定义更新模型定价标准
	if path == "/api/pricing/update" && method == http.MethodPost {
		body, ok := readBody(w, r, false)
		if !ok {
			return
		}
		prices := upstream.NewObj()
		if v, _ := body.GetOK("prices"); v != nil {
			if o, isObj := v.(*upstream.Obj); isObj && o.Len() > 0 {
				prices = o
			}
		}
		updated := h.Pricing.SaveModelPrices(prices)
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("ok", true).Set("prices", updated))
		return
	}

	if h.handleAPIAccounts(w, r, u, path, method) {
		return
	}

	writeJSON(w, http.StatusNotFound, upstream.NewObj().Set("error", "API route not found"))
}

// readBody 读取 JSON 体；解析失败回 400（withOK 决定是否带 ok:false）。
func readBody(w http.ResponseWriter, r *http.Request, withOK bool) (*upstream.Obj, bool) {
	body, err := readJSONBody(r)
	if err != nil {
		o := upstream.NewObj()
		if withOK {
			o.Set("ok", false)
		}
		o.Set("error", jsErrorMessage(err))
		writeJSON(w, http.StatusBadRequest, o)
		return nil, false
	}
	return body, true
}

// jsErrorMessage 把 Go 解析错误近似为 V8 的 JSON.parse 报错文案。
func jsErrorMessage(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "unexpected end of JSON input"), strings.Contains(msg, "EOF"):
		return "Unexpected end of JSON input"
	case strings.HasPrefix(msg, "invalid character"):
		return "Unexpected token in JSON"
	}
	return msg
}

// settingsView GET /api/settings（凭据脱敏）。
func (h *Handler) settingsView() *upstream.Obj {
	// [P0] 凭据脱敏：不再明文回传 apiKey / apiKeys[].key / webPassword / rootDir。
	c := h.Store.Config()
	keys := h.Store.GetAPIKeys()
	masked := make([]any, 0, len(keys))
	for _, k := range keys {
		masked = append(masked, upstream.NewObj().Set("id", k.ID).Set("note", k.Note).Set("createdAt", upstream.Num(k.CreatedAt)).
			Set("enabled", k.Enabled).Set("keyPreview", maskKeyOr(k.Key, false)).Set("isPrimary", k.Key == c.APIKey))
	}
	ttl := int64(config.StickyDefaultTtlMs)
	if c.StickySessionTtlMs != nil && *c.StickySessionTtlMs != 0 {
		ttl = *c.StickySessionTtlMs
	}
	maxLife := int64(config.StickyDefaultTtlMs)
	if c.StickySessionMaxLifetimeMs != nil && *c.StickySessionMaxLifetimeMs != 0 {
		maxLife = *c.StickySessionMaxLifetimeMs
	}
	out := upstream.NewObj()
	if c.Port != 0 {
		out.Set("port", c.Port)
	}
	out.Set("apiKeyPreview", maskKeyOr(c.APIKey, false)).
		Set("hasApiKey", c.APIKey != "").
		Set("apiKeys", masked).
		Set("webAuthEnabled", c.IsWebAuthEnabled()).
		Set("hasWebPassword", h.HasDedicatedWebPassword()).
		Set("webPassword", "").
		Set("concurrencyLimitEnabled", c.IsConcurrencyLimitEnabled()).
		Set("maxInFlightPerAccount", c.MaxInFlight()).
		Set("routingStrategy", orStr(c.RoutingStrategy, "least-inflight")).
		Set("routingRegionScope", orStr(c.RoutingRegionScope, "all")).
		Set("accountFailoverEnabled", c.IsAccountFailoverEnabled()).
		Set("pinnedAccount", c.PinnedAccount).
		Set("stickySessionEnabled", c.IsStickySessionEnabled()).
		Set("stickySessionTtlMs", upstream.Num(ttl)).
		Set("stickySessionMaxLifetimeMs", upstream.Num(maxLife)).
		Set("sessionStats", h.Sched.GetSessionAffinityStats()).
		Set("modelFallbackEnabled", c.IsModelFallbackEnabled()).
		Set("modelFallback", orMap(c.ModelFallback)).
		Set("tokenRefreshAdvanceDays", c.TokenRefreshAdvanceDaysOr()).
		Set("maxLogDbSizeMb", c.MaxLogDbSizeMbOr()).
		Set("logDbSizeMb", h.DB.SizeMb()).
		Set("autoCheckin", c.AutoCheckin != nil && *c.AutoCheckin).
		Set("modelBlacklist", h.Store.GetModelBlacklist()).
		Set("thinkingPolicy", h.Store.GetThinkingPolicy()).
		Set("promptPolicy", h.Store.GetPromptPolicy()).
		Set("loggingPolicy", h.Store.GetLoggingPolicy()).
		Set("requestClientInfo", c.IsRequestClientInfo()).
		Set("requestArchiveContext", c.IsRequestArchiveContext()).
		Set("privateDataPolicy", h.Store.GetPrivateDataPolicy())
	return out
}

// updateSettings POST /api/settings（热更新生效并落盘）。
func (h *Handler) updateSettings(body *upstream.Obj) error {
	// ─── 策略对象 ───
	if tp, ok := body.GetOK("thinkingPolicy"); ok {
		if tpo, isObj := tp.(*upstream.Obj); isObj {
			enabled, _ := rawBool(tpo, "enabled")
			if _, err := h.Store.SetThinkingPolicy(&enabled, optStr(tpo, "defaultLevel"), optStr(tpo, "overrideMode"), strMap(tpo.Get("modelLevels"))); err != nil {
				return err
			}
		}
	}
	if pp, ok := body.GetOK("promptPolicy"); ok {
		if ppo, isObj := pp.(*upstream.Obj); isObj {
			if _, err := h.Store.SetPromptPolicy(optStr(ppo, "mode"), optStr(ppo, "file")); err != nil {
				return err
			}
		}
	} else if body.Has("promptMode") || body.Has("promptFile") {
		if _, err := h.Store.SetPromptPolicy(optStr(body, "promptMode"), optStr(body, "promptFile")); err != nil {
			return err
		}
	}
	loggingPolicyObject := false
	if lp, ok := body.GetOK("loggingPolicy"); ok {
		if lpo, isObj := lp.(*upstream.Obj); isObj {
			loggingPolicyObject = true
			if _, err := h.Store.SetLoggingPolicy(optBool(lpo, "requestClientInfo"), optBool(lpo, "requestArchiveContext")); err != nil {
				return err
			}
		}
	}
	if body.Has("privateDataPolicy") {
		if _, err := h.Store.SetPrivateDataPolicy(body.Get("privateDataPolicy")); err != nil {
			return err
		}
	}

	// ─── 多密钥列表 / 主密钥 ───
	if arr, ok := body.GetOK("apiKeys"); ok {
		if list, isArr := arr.([]any); isArr {
			keys := toAPIKeys(list)
			if err := h.Store.UpdateConfig(func(c *config.Config) {
				c.APIKeys = keys
				// firstActive：首个 enabled !== false，否则首个
				c.APIKey = ""
				for _, k := range keys {
					if k.Enabled {
						c.APIKey = k.Key
						break
					}
				}
				if c.APIKey == "" && len(keys) > 0 {
					c.APIKey = keys[0].Key
				}
			}); err != nil {
				return err
			}
			h.Lg.Info("CONFIG", fmt.Sprintf("管理员通过 Web 控制台更新了多 API Key 列表 (共 %d 个)", len(keys)))
			return h.finishSettings(body, loggingPolicyObject)
		}
	}
	if v, _ := body.GetOK("generateNewApiKey"); v == true {
		if err := h.Store.UpdateConfig(func(c *config.Config) {
			c.APIKey = config.GenerateRandomApiKey()
			if len(c.APIKeys) > 0 {
				c.APIKeys[0].Key = c.APIKey
			} else {
				c.APIKeys = []config.APIKey{{ID: fmt.Sprintf("key_%d", time.Now().UnixMilli()), Key: c.APIKey, Note: "默认主密钥", CreatedAt: time.Now().UnixMilli(), Enabled: true}}
			}
		}); err != nil {
			return err
		}
		h.Lg.Info("CONFIG", "管理员通过 Web 控制台重新生成随机 API Key: "+h.Store.Config().APIKey)
	} else if k, ok := rawStr(body, "apiKey"); ok {
		k = strings.TrimSpace(k)
		if err := h.Store.UpdateConfig(func(c *config.Config) {
			if k != "" {
				c.APIKey = k
			} else {
				c.APIKey = config.GenerateRandomApiKey()
			}
			if len(c.APIKeys) > 0 {
				c.APIKeys[0].Key = c.APIKey
			} else {
				c.APIKeys = []config.APIKey{{ID: fmt.Sprintf("key_%d", time.Now().UnixMilli()), Key: c.APIKey, Note: "默认主密钥", CreatedAt: time.Now().UnixMilli(), Enabled: true}}
			}
		}); err != nil {
			return err
		}
		h.Lg.Info("CONFIG", "管理员通过 Web 控制台更新 API Key")
	}

	// ─── 其余标量策略 ───
	if v, ok := rawBool(body, "concurrencyLimitEnabled"); ok {
		if err := h.Store.UpdateConfig(func(c *config.Config) { c.ConcurrencyLimitEnabled = &v }); err != nil {
			return err
		}
	}
	if v, ok := rawBool(body, "accountFailoverEnabled"); ok {
		if err := h.Store.UpdateConfig(func(c *config.Config) { c.AccountFailoverEnabled = &v }); err != nil {
			return err
		}
	}
	return h.finishSettings(body, loggingPolicyObject)
}

// finishSettings 应用其余策略字段、按需裁剪日志库并落盘记录。
func (h *Handler) finishSettings(body *upstream.Obj, loggingPolicyObject bool) error {
	err := h.Store.UpdateConfig(func(c *config.Config) {
		if !loggingPolicyObject {
			if v, ok := rawBool(body, "requestClientInfo"); ok {
				c.RequestClientInfo = &v
			}
			if v, ok := rawBool(body, "requestArchiveContext"); ok {
				c.RequestArchiveContext = &v
			}
		}
		if v, ok := rawBool(body, "webAuthEnabled"); ok {
			c.WebAuthEnabled = &v
		}
		if s, ok := rawStr(body, "webPassword"); ok {
			c.WebPassword = strings.TrimSpace(s)
		}
		if v, ok := rawBool(body, "stickySessionEnabled"); ok {
			c.StickySessionEnabled = &v
		}
		// 下限 10 秒；上限 365 天，防止误输入天文数字导致 Map 永不清理
		if v, ok := rawNum(body, "stickySessionTtlMs"); ok {
			n := clampI64(int64(v), 10000, 365*86400000)
			c.StickySessionTtlMs = &n
		}
		if v, ok := rawNum(body, "stickySessionMaxLifetimeMs"); ok {
			n := clampI64(int64(v), 10000, 365*86400000)
			c.StickySessionMaxLifetimeMs = &n
		}
		// 解绑条件是「空闲超时 OR 绝对存活超时」任一命中；防御性对齐：maxLifetime < ttl 时抬到 ttl
		if c.StickySessionTtlMs != nil && c.StickySessionMaxLifetimeMs != nil && *c.StickySessionMaxLifetimeMs > 0 && *c.StickySessionMaxLifetimeMs < *c.StickySessionTtlMs {
			n := *c.StickySessionTtlMs
			c.StickySessionMaxLifetimeMs = &n
		}
		if s, ok := rawStr(body, "routingStrategy"); ok {
			c.RoutingStrategy = s
		}
		if s, ok := rawStr(body, "routingRegionScope"); ok {
			sc := strings.ToLower(strings.TrimSpace(s))
			if sc == "cn" || sc == "intl" {
				c.RoutingRegionScope = sc
			} else {
				c.RoutingRegionScope = "all"
			}
		}
		if s, ok := rawStr(body, "pinnedAccount"); ok {
			c.PinnedAccount = strings.TrimSpace(s)
		}
		if v, ok := rawBool(body, "modelFallbackEnabled"); ok {
			c.ModelFallbackEnabled = &v
		}
		if mf, ok := body.GetOK("modelFallback"); ok {
			if mfo, isObj := mf.(*upstream.Obj); isObj {
				m := map[string]any{}
				for _, k := range mfo.Keys() {
					m[k] = mfo.Get(k)
				}
				c.ModelFallback = m
			}
		}
		if v, ok := rawNum(body, "tokenRefreshAdvanceDays"); ok {
			n := clampInt(int(v), 1, 30)
			c.TokenRefreshAdvanceDays = &n
		}
		if v, ok := rawNum(body, "maxLogDbSizeMb"); ok {
			n := int(v)
			if n < 1 {
				n = 1
			}
			c.MaxLogDbSizeMb = &n
		}
		if v, ok := rawNum(body, "maxInFlightPerAccount"); ok {
			n := int(v)
			if n < 1 {
				n = 1
			}
			c.MaxInFlightPerAccount = &n
		}
	})
	if err != nil {
		return err
	}
	c := h.Store.Config()
	if _, ok := rawNum(body, "maxLogDbSizeMb"); ok {
		h.DB.CheckAndPruneBySize(c.MaxLogDbSizeMbOr())
	}
	meta := logger.NewMeta("promptPolicy", h.Store.GetPromptPolicy())
	if c.WebAuthEnabled != nil {
		meta.Set("webAuthEnabled", *c.WebAuthEnabled)
	}
	meta.Set("concurrencyLimitEnabled", c.IsConcurrencyLimitEnabled()).
		Set("accountFailoverEnabled", c.IsAccountFailoverEnabled()).
		Set("routingStrategy", c.RoutingStrategy).
		Set("pinnedAccount", c.PinnedAccount).
		Set("modelFallbackEnabled", c.IsModelFallbackEnabled()).
		Set("modelFallback", orMap(c.ModelFallback)).
		Set("tokenRefreshAdvanceDays", c.TokenRefreshAdvanceDaysOr()).
		Set("maxLogDbSizeMb", c.MaxLogDbSizeMbOr()).
		Set("maxInFlightPerAccount", c.MaxInFlight())
	h.Lg.Info("CONFIG", "网关运行策略已更新 (热生效)", meta)
	return nil
}

// ─── 小工具 ───

func padEnd(s string, n int) string {
	for len(s) < n {
		s += " "
	}
	return s
}

func orStr(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func orMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func clampI64(v, lo, hi int64) int64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// atoiOr JS parseInt(s,10) 的宽松语义：解析失败回退默认值。
func atoiOr(s string, def int) int {
	s = strings.TrimSpace(s)
	if s == "" {
		return def
	}
	end := 0
	if s[end] == '+' || s[end] == '-' {
		end++
	}
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	if end == 0 || (end == 1 && (s[0] == '+' || s[0] == '-')) {
		return def
	}
	n, err := strconv.Atoi(s[:end])
	if err != nil {
		return def
	}
	return n
}

// maskKeyOr 密钥脱敏：首 8 + **** + 尾 4，过短则全打码；reveal 时回明文。
func maskKeyOr(key string, reveal bool) string {
	if reveal {
		return key
	}
	if len(key) > 12 {
		return key[:8] + "****" + key[len(key)-4:]
	}
	return "****"
}

func optStr(o *upstream.Obj, k string) *string {
	if s, ok := rawStr(o, k); ok {
		return &s
	}
	return nil
}

func optBool(o *upstream.Obj, k string) *bool {
	if b, ok := rawBool(o, k); ok {
		return &b
	}
	return nil
}

// strMap 把 JS 对象转为 map[string]string（仅取字符串值）。
func strMap(v any) map[string]string {
	o, isObj := v.(*upstream.Obj)
	if !isObj {
		return nil
	}
	m := map[string]string{}
	for _, k := range o.Keys() {
		if s, ok := o.Get(k).(string); ok {
			m[k] = s
		}
	}
	return m
}

// toAPIKeys 把前端提交的密钥数组转为 APIKey（enabled 缺省按 !== false 视为启用）。
func toAPIKeys(list []any) []config.APIKey {
	out := make([]config.APIKey, 0, len(list))
	for _, it := range list {
		o, isObj := it.(*upstream.Obj)
		if !isObj {
			continue
		}
		var k config.APIKey
		k.ID, _ = rawStr(o, "id")
		k.Key, _ = rawStr(o, "key")
		k.Note, _ = rawStr(o, "note")
		if n, ok := rawNum(o, "createdAt"); ok {
			k.CreatedAt = int64(n)
		}
		if b, ok := rawBool(o, "enabled"); ok {
			k.Enabled = b
		} else {
			k.Enabled = true
		}
		out = append(out, k)
	}
	return out
}
