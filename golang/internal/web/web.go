// Package web 对应 src/server.mjs + src/web/routes.mjs：
// HTTP 路由总线、API Key 鉴权、Web 控制台鉴权、静态单页渲染与 /api/* 运维管理接口。
package web

import (
	"embed"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"codebuddy-gateway/internal/adapters"
	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/database"
	"codebuddy-gateway/internal/core/logger"
	"codebuddy-gateway/internal/core/metrics"
	"codebuddy-gateway/internal/core/pricing"
	"codebuddy-gateway/internal/core/scheduler"
	"codebuddy-gateway/internal/core/tlscerts"
	"codebuddy-gateway/internal/upstream"
)

//go:embed public
var publicFS embed.FS

// MaxRequestBodyBytes 请求体 50MB 保护上限（server.mjs:81），防止超大 Prompt 或大量 base64 图片引发 OOM。
const MaxRequestBodyBytes = 50 * 1024 * 1024

// DefaultPort 默认监听端口（server.mjs:300 `config.port || 8317`）。
const DefaultPort = 8317

// Handler HTTP 路由总线。
type Handler struct {
	Store    *config.Store
	Sched    *scheduler.Scheduler
	Adapters *adapters.Deps
	DB       *database.Engine
	Pricing  *pricing.Store
	Metrics  *metrics.Store
	TLS      *tlscerts.Stack
	Lg       *logger.Logger

	startedAt time.Time
	tmplOnce  sync.Once
	tmpl      string
}

// New 创建路由总线。
func New(store *config.Store, sched *scheduler.Scheduler, ad *adapters.Deps, db *database.Engine, pr *pricing.Store, mt *metrics.Store, tls *tlscerts.Stack, lg *logger.Logger) *Handler {
	return &Handler{Store: store, Sched: sched, Adapters: ad, DB: db, Pricing: pr, Metrics: mt, TLS: tls, Lg: lg, startedAt: time.Now()}
}

// UptimeMs 进程连续运行时长（process.uptime() * 1000 四舍五入）。
func (h *Handler) UptimeMs() int64 {
	return int64(time.Since(h.startedAt).Round(time.Millisecond) / time.Millisecond)
}

// ─── 请求体读取（server.mjs:113-158）────────────────────────────────────────

// readRequestBody Content-Length 预检 + 实时字节限额 + 读取异常保护。
func (h *Handler) readRequestBody(w http.ResponseWriter, r *http.Request, handler func(http.ResponseWriter, *http.Request, []byte)) {
	if r.ContentLength > MaxRequestBodyBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, upstream.NewObj().Set("error", upstream.NewObj().
			Set("message", fmt.Sprintf("Payload too large (max %dMB)", MaxRequestBodyBytes/1024/1024)).Set("type", "payload_too_large")))
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxRequestBodyBytes+1))
	if err != nil {
		h.Lg.Error("SERVER", "读取客户端请求流异常: "+err.Error())
		writeJSON(w, http.StatusBadRequest, upstream.NewObj().Set("error", upstream.NewObj().
			Set("message", "Failed to read request stream").Set("type", "bad_request")))
		return
	}
	if len(body) > MaxRequestBodyBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, upstream.NewObj().Set("error", upstream.NewObj().
			Set("message", fmt.Sprintf("Payload too large (exceeded %dMB limit)", MaxRequestBodyBytes/1024/1024)).Set("type", "payload_too_large")))
		return
	}
	handler(w, r, body)
}

// handleRequestFailure 统一处理处理器 panic（server.mjs:91-108）：
// 响应头未发送 → 500 JSON；已发送（SSE 流中）→ 只能尽力收尾。
func (h *Handler) handleRequestFailure(w *trackedWriter, err any) {
	msg := fmt.Sprint(err)
	h.Lg.Error("SERVER", "请求处理器异常: "+msg)
	if w.ended() {
		return
	}
	if w.wroteHeader {
		// 已经在流式输出中途，无法再改状态码；尽力收尾，避免连接悬挂
		return
	}
	writeJSON(w, http.StatusInternalServerError, upstream.NewObj().Set("error", upstream.NewObj().
		Set("message", "Internal gateway error").Set("type", "api_error")))
}

// trackedWriter 记录响应头是否已发送 / 响应是否已结束。
type trackedWriter struct {
	http.ResponseWriter
	wroteHeader bool
	finished    bool
}

func (t *trackedWriter) WriteHeader(code int) {
	if !t.wroteHeader {
		t.wroteHeader = true
	}
	t.ResponseWriter.WriteHeader(code)
}

func (t *trackedWriter) Write(b []byte) (int, error) {
	if !t.wroteHeader {
		t.wroteHeader = true
	}
	return t.ResponseWriter.Write(b)
}

func (t *trackedWriter) ended() bool { return t.finished }

// ─── 路由总线（server.mjs:161-238）──────────────────────────────────────────

// ServeHTTP 实现总路由。
func (h *Handler) ServeHTTP(w0 http.ResponseWriter, r *http.Request) {
	w := &trackedWriter{ResponseWriter: w0}
	defer func() {
		if rec := recover(); rec != nil {
			h.handleRequestFailure(w, rec)
		}
	}()
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	u := r.URL
	path := u.Path

	// 1. Web 控制台静态单页
	if path == "/" || path == "/index.html" {
		h.handleDashboard(w, r)
		return
	}

	// 2. 探活路由
	if path == "/healthz" {
		uptimeMs := h.UptimeMs()
		healthy := 0
		h.Store.Accounts().Each(func(a *config.Account) bool {
			if a.Status == "healthy" {
				healthy++
			}
			return true
		})
		writeJSON(w, http.StatusOK, upstream.NewObj().Set("status", "ok").Set("activeAccounts", healthy).
			Set("uptimeMs", upstream.Num(uptimeMs)).Set("uptime", config.FormatUptime(uptimeMs)).
			Set("startedAt", time.Now().Add(-time.Duration(uptimeMs)*time.Millisecond).UTC().Format("2006-01-02T15:04:05.000Z07:00")))
		return
	}

	// 3. API 鉴权（多 Key 校验，同时支持 Authorization: Bearer 和 x-api-key，常量时间安全比对）
	isAPIPath := strings.HasPrefix(path, "/v1/") || path == "/messages" || path == "/search" || path == "/fetch"
	if isAPIPath {
		token := strings.TrimSpace(regexp.MustCompile(`(?i)^Bearer\s+`).ReplaceAllString(r.Header.Get("Authorization"), ""))
		if token == "" {
			token = r.Header.Get("x-api-key")
		}
		if !h.Store.IsValidAPIKey(token) {
			h.Lg.Warn("AUTH", "非法 API Key 访问: "+path, logger.NewMeta("ip", remoteIP(r)))
			writeJSON(w, http.StatusUnauthorized, upstream.NewObj().Set("error", upstream.NewObj().
				Set("message", "Invalid API Key").Set("type", "auth_error")))
			return
		}
	}

	// 4. GET /v1/models
	if r.Method == http.MethodGet && path == "/v1/models" {
		h.Adapters.HandleModels(w, r)
		return
	}
	// 5. 联网检索
	if r.Method == http.MethodPost && (path == "/v1/search" || path == "/search") {
		h.readRequestBody(w, r, h.Adapters.HandleSearch)
		return
	}
	// 6. 网页抓取
	if r.Method == http.MethodPost && (path == "/v1/fetch" || path == "/fetch") {
		h.readRequestBody(w, r, h.Adapters.HandleWebFetch)
		return
	}
	// 7. Anthropic 协议
	if r.Method == http.MethodPost && (path == "/v1/messages" || path == "/messages") {
		h.readRequestBody(w, r, h.Adapters.HandleMessages)
		return
	}
	// 8. OpenAI 协议
	if r.Method == http.MethodPost && path == "/v1/chat/completions" {
		h.readRequestBody(w, r, h.Adapters.HandleChatCompletions)
		return
	}
	// 9. /api/* 运维与管理 REST API
	if strings.HasPrefix(path, "/api/") {
		h.handleAPI(w, r, u)
		return
	}
	writeJSON(w, http.StatusNotFound, upstream.NewObj().Set("error", "Endpoint not found"))
}

// remoteIP 等价 req.socket.remoteAddress（去掉端口与 ::ffff: 前缀）。
func remoteIP(r *http.Request) string {
	host := r.RemoteAddr
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	} else if i := strings.LastIndex(host, ":"); i > strings.LastIndex(host, "]") && i > 0 {
		host = host[:i]
	}
	return strings.TrimPrefix(host, "::ffff:")
}

// ─── Web 控制台鉴权（routes.mjs:71-101）────────────────────────────────────
// [P0 安全修复] 控制台身份必须与 API 消费者身份解耦：
//   · webPassword 显式配置时 → 只认 webPassword；
//   · 未配置 webPassword 时 → 只认 config.apiKey 这一枚“主控密钥”，不再遍历 apiKeys；
//   · 两条路径都用常量时间比对。

// WebAuthPassword 独立控制台口令（未配置返回空串）。
func (h *Handler) WebAuthPassword() string {
	return strings.TrimSpace(h.Store.Config().WebPassword)
}

// HasDedicatedWebPassword 是否已配置独立控制台口令。
func (h *Handler) HasDedicatedWebPassword() bool { return h.WebAuthPassword() != "" }

// VerifyWebAuthToken 校验控制台令牌。
func (h *Handler) VerifyWebAuthToken(token string) bool {
	c := h.Store.Config()
	if !c.IsWebAuthEnabled() {
		return true
	}
	if token == "" {
		return false
	}
	if h.HasDedicatedWebPassword() {
		return config.SafeCompareTokens(token, h.WebAuthPassword())
	}
	if k := strings.TrimSpace(c.APIKey); k != "" {
		return config.SafeCompareTokens(token, k)
	}
	return false
}

// extractWebToken 从 Authorization: Bearer / x-web-token / ?token 取令牌。
func extractWebToken(r *http.Request, u *url.URL) string {
	token := ""
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		token = strings.TrimSpace(auth[7:])
	} else {
		token = r.Header.Get("x-web-token")
	}
	if token == "" {
		token = strings.TrimSpace(u.Query().Get("token"))
	}
	return token
}

// ─── 静态页渲染（routes.mjs:104-139）────────────────────────────────────────

var includeRe = regexp.MustCompile(`<!--\s*@include\s+["']([^"']+)["']\s*-->`)

// renderTemplate 服务端零构建组件化拼装：展开 <!-- @include "..." -->。
func (h *Handler) renderTemplate() string {
	h.tmplOnce.Do(func() {
		root, err := publicFS.ReadFile("public/index.html")
		if err != nil {
			h.Lg.Warn("WEB", "读取控制台模板失败: "+err.Error())
			h.tmpl = ""
			return
		}
		h.tmpl = includeRe.ReplaceAllStringFunc(string(root), func(match string) string {
			rel := includeRe.FindStringSubmatch(match)[1]
			data, err := publicFS.ReadFile("public/" + rel)
			if err != nil {
				h.Lg.Warn("WEB", "模板拼装缺失子模块: "+rel)
				return "/* Missing include: " + rel + " */"
			}
			return "\n" + string(data) + "\n"
		})
	})
	return h.tmpl
}

func (h *Handler) handleDashboard(w http.ResponseWriter, r *http.Request) {
	tmpl := h.renderTemplate()
	c := h.Store.Config()
	isAuthEnabled := c.IsWebAuthEnabled()
	apiKey := "sk-****************"
	if !isAuthEnabled {
		apiKey = c.APIKey
	}
	html := tmpl
	for _, kv := range [][2]string{
		{"{{PORT}}", upstream.Itoa(c.EffectivePort())},
		{"{{API_KEY}}", apiKey},
		{"{{VERSION}}", config.CurrentVersion},
		{"{{CA_COUNT}}", upstream.Itoa(h.TLS.LoadedCount())},
		{"{{WEB_AUTH_ENABLED}}", boolStr(isAuthEnabled)},
	} {
		html = strings.ReplaceAll(html, kv[0], kv[1])
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(html))
}

// ─── 小工具 ─────────────────────────────────────────────────────────────────

// writeJSON JSON 响应（不转义 HTML，与 JSON.stringify 一致）。
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	b, err := upstream.MarshalJSON(v)
	if err != nil {
		b = []byte(`{"error":{"message":"internal serialization error","type":"api_error"}}`)
	}
	_, _ = w.Write(b)
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// readJSONBody 读取并解析 JSON 请求体；非对象按空对象处理（JS 属性访问语义）。
func readJSONBody(r *http.Request) (*upstream.Obj, error) {
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	v, err := upstream.ParseAny(data)
	if err != nil {
		return nil, err
	}
	switch t := v.(type) {
	case *upstream.Obj:
		return t, nil
	case nil:
		return upstream.NewObj(), nil
	}
	return upstream.NewObj(), nil
}

// rawNum JS number 判断（typeof === 'number'）。
func rawNum(o *upstream.Obj, k string) (float64, bool) {
	v, ok := o.GetOK(k)
	if !ok {
		return 0, false
	}
	f, isNum := upstream.GetNum(v)
	if !isNum {
		return 0, false
	}
	// GetNum 接受数字字符串；JS typeof 对字符串为 false
	if _, isStr := v.(string); isStr {
		return 0, false
	}
	return f, true
}

// rawBool JS boolean 判断。
func rawBool(o *upstream.Obj, k string) (bool, bool) {
	v, ok := o.GetOK(k)
	if !ok {
		return false, false
	}
	b, isBool := v.(bool)
	return b, isBool
}

// rawStr JS string 判断。
func rawStr(o *upstream.Obj, k string) (string, bool) {
	s, ok := o.GetOK(k)
	if !ok {
		return "", false
	}
	str, isStr := s.(string)
	return str, isStr
}

// qs 查询参数（空串视为未设置）。
func qs(u *url.URL, k string) string { return u.Query().Get(k) }
