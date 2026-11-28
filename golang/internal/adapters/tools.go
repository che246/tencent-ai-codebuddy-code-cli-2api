package adapters

import (
	"context"
	"net/http"
	"time"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/logger"
	"codebuddy-gateway/internal/core/scheduler"
	"codebuddy-gateway/internal/upstream"
)

// ─── 官方服务端联网检索 / 网页抓取端点（tools.mjs）────────────────────────────

// toolsTimeoutMs tools.mjs:31 `AbortSignal.timeout(15000)`。
// [网关自有策略，无 CLI 对应实现] 联网工具端点为网关扩展能力，官方 CLI 产物中无对应调用。
const toolsTimeoutMs = 15000

// selectToolAccount 优先选择国内健康账号（因 agenttool/v1/search 部署于国内），否则不限区域。
func (d *Deps) selectToolAccount() *config.Account {
	if acc := d.Sched.SelectAccount("", "", scheduler.SelectOpts{Region: config.RegionCn}); acc != nil {
		return acc
	}
	return d.Sched.SelectAccount("", "", scheduler.SelectOpts{})
}

// toolHeaders Authorization / User-Agent / Content-Type（tools.mjs:22-26）。
func toolHeaders(acc *config.Account) http.Header {
	h := http.Header{}
	h.Set("Authorization", "Bearer "+acc.AccessToken)
	h.Set("User-Agent", config.UserAgent)
	h.Set("Content-Type", "application/json")
	return h
}

// relay 带上游状态码透传文本响应。
func relay(w http.ResponseWriter, status int, data []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

// HandleSearch POST /v1/search & /search（tools.mjs:6-44）。
func (d *Deps) HandleSearch(w http.ResponseWriter, r *http.Request, rawBody []byte) {
	startMs := time.Now().UnixMilli()
	bodyObj, err := parsePayload(rawBodyOrDefault(rawBody))
	if err != nil {
		d.Lg.Error("SEARCH", "检索异常: "+err.Error())
		writeJSON(w, http.StatusInternalServerError, upstream.NewObj().Set("error", err.Error()))
		return
	}
	acc := d.selectToolAccount()
	if acc == nil {
		writeJSON(w, http.StatusServiceUnavailable, upstream.NewObj().Set("error", "No available account for search"))
		return
	}
	query := bodyObj.Get("query")
	if !upstream.Truthy(query) {
		query = ""
	}
	queryStr := upstream.ToStr(query)
	d.Lg.Info("SEARCH", "发起联网检索 ["+queryStr+"]", logger.NewMeta("account", config.AccountFullDesc(acc)))

	maxResults := firstTruthy(bodyObj.Get("max_results"), bodyObj.Get("count"))
	if maxResults == nil {
		maxResults = 5
	}
	ctx, cancel := context.WithTimeout(r.Context(), toolsTimeoutMs*time.Millisecond)
	defer cancel()
	status, data, err := d.Client.DoJSON(ctx, http.MethodPost, config.EndpointsFor(acc).Search, toolHeaders(acc),
		[]byte(jsonStringify(upstream.NewObj().Set("query", query).Set("max_results", maxResults))))
	if err != nil {
		d.Lg.Error("SEARCH", "检索异常: "+err.Error())
		writeJSON(w, http.StatusInternalServerError, upstream.NewObj().Set("error", err.Error()))
		return
	}
	d.Lg.Info("SEARCH", "检索完成 ["+queryStr+"] 耗时 "+upstream.Itoa(int(time.Now().UnixMilli()-startMs))+"ms (HTTP "+upstream.Itoa(status)+")")
	relay(w, status, data)
}

// HandleWebFetch POST /v1/fetch & /fetch（tools.mjs:47-82）。
func (d *Deps) HandleWebFetch(w http.ResponseWriter, r *http.Request, rawBody []byte) {
	startMs := time.Now().UnixMilli()
	bodyObj, err := parsePayload(rawBodyOrDefault(rawBody))
	if err != nil {
		d.Lg.Error("FETCH", "网页抓取异常: "+err.Error())
		writeJSON(w, http.StatusInternalServerError, upstream.NewObj().Set("error", err.Error()))
		return
	}
	acc := d.selectToolAccount()
	if acc == nil {
		writeJSON(w, http.StatusServiceUnavailable, upstream.NewObj().Set("error", "No available account for webfetch"))
		return
	}
	targetUrl := bodyObj.Get("url")
	if !upstream.Truthy(targetUrl) {
		targetUrl = ""
	}
	urlStr := upstream.ToStr(targetUrl)
	d.Lg.Info("FETCH", "发起网页内容抓取 ["+urlStr+"]", logger.NewMeta("account", config.AccountFullDesc(acc)))

	ctx, cancel := context.WithTimeout(r.Context(), toolsTimeoutMs*time.Millisecond)
	defer cancel()
	status, data, err := d.Client.DoJSON(ctx, http.MethodPost, config.EndpointsFor(acc).WebFetch, toolHeaders(acc),
		[]byte(jsonStringify(upstream.NewObj().Set("url", targetUrl))))
	if err != nil {
		d.Lg.Error("FETCH", "网页抓取异常: "+err.Error())
		writeJSON(w, http.StatusInternalServerError, upstream.NewObj().Set("error", err.Error()))
		return
	}
	d.Lg.Info("FETCH", "抓取完成 ["+urlStr+"] 耗时 "+upstream.Itoa(int(time.Now().UnixMilli()-startMs))+"ms (HTTP "+upstream.Itoa(status)+")")
	relay(w, status, data)
}

// rawBodyOrDefault `rawBody || '{}'`。
func rawBodyOrDefault(rawBody []byte) []byte {
	if len(rawBody) == 0 {
		return []byte("{}")
	}
	return rawBody
}

// firstTruthy JS `a || b`。
func firstTruthy(a, b any) any {
	if upstream.Truthy(a) {
		return a
	}
	if upstream.Truthy(b) {
		return b
	}
	return nil
}
