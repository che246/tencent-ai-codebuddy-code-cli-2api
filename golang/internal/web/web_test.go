package web

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"codebuddy-gateway/internal/adapters"
	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/database"
	"codebuddy-gateway/internal/core/logger"
	"codebuddy-gateway/internal/core/metrics"
	"codebuddy-gateway/internal/core/pricing"
	"codebuddy-gateway/internal/core/scheduler"
	"codebuddy-gateway/internal/upstream"
)

func mustURL(s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		panic(err)
	}
	return u
}

func newTestHandler(t *testing.T) (*Handler, *config.Store) {
	t.Helper()
	dir := t.TempDir()
	store, err := config.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	paths := store.Paths()
	db := database.Open(paths.LogDBPath, func() int { return store.Config().MaxLogDbSizeMbOr() })
	lg := logger.New(db, paths.LogFilePath)
	lg.SetWriters(&strings.Builder{}, &strings.Builder{})
	client := upstream.NewClient(nil, false, lg)
	// 测试禁止真实出网：把传输层代理指向必然拒绝的本地端口，使上游调用快速失败
	client.HTTPClient().Transport = &http.Transport{Proxy: http.ProxyURL(mustURL("http://127.0.0.1:9"))}
	models := upstream.NewModelCatalog(client, store.Accounts(), lg, dir)
	sched := scheduler.New(store, db, lg, client)
	mt := metrics.New(paths, paths.LogFilePath)
	pr := pricing.NewStore(paths)
	deps := &adapters.Deps{Store: store, Sched: sched, Models: models, Metrics: mt, Client: client, Lg: lg}
	h := New(store, sched, deps, db, pr, mt, nil, lg)
	t.Cleanup(func() { sched.Stop(); lg.Close(); _ = db.Close() })
	return h, store
}

func do(h *Handler, method, target, body string, hdr map[string]string) *httptest.ResponseRecorder {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func jsonBody(t *testing.T, w *httptest.ResponseRecorder) *upstream.Obj {
	t.Helper()
	o, err := upstream.ParseObj(w.Body.Bytes())
	if err != nil {
		t.Fatalf("响应不是 JSON 对象: %v -> %s", err, w.Body.String())
	}
	return o
}

func authHdr(key string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + key}
}

func idxOf(keys []string, k string) int {
	for i, s := range keys {
		if s == k {
			return i
		}
	}
	return -1
}

func TestCORSPreflightAndHealthz(t *testing.T) {
	h, _ := newTestHandler(t)
	w := do(h, http.MethodOptions, "/v1/chat/completions", "", nil)
	if w.Code != http.StatusOK || w.Header().Get("Access-Control-Allow-Origin") != "*" || w.Header().Get("Access-Control-Allow-Methods") != "GET, POST, OPTIONS" || w.Header().Get("Access-Control-Allow-Headers") != "*" {
		t.Fatalf("CORS 预检错误: %d %v", w.Code, w.Header())
	}
	w = do(h, http.MethodGet, "/healthz", "", nil)
	o := jsonBody(t, w)
	if w.Code != 200 || upstream.GetString(o, "status") != "ok" || !o.Has("activeAccounts") || !o.Has("uptimeMs") || !o.Has("uptime") || !o.Has("startedAt") {
		t.Fatalf("healthz 错误: %s", w.Body.String())
	}
}

func TestAPIKeyGuard(t *testing.T) {
	h, store := newTestHandler(t)
	w := do(h, http.MethodGet, "/v1/models", "", nil)
	o := jsonBody(t, w)
	if w.Code != 401 || upstream.GetString(upstream.GetObj(o, "error"), "message") != "Invalid API Key" || upstream.GetString(upstream.GetObj(o, "error"), "type") != "auth_error" {
		t.Fatalf("无 Key 应 401: %d %s", w.Code, w.Body.String())
	}
	// 错误 Bearer / x-api-key 同样拒绝
	w = do(h, http.MethodGet, "/v1/models", "", map[string]string{"x-api-key": "wrong"})
	if w.Code != 401 {
		t.Fatalf("错误 x-api-key 应 401: %d", w.Code)
	}
	// 正确 x-api-key 放行（无账号 → 空模型列表）
	w = do(h, http.MethodGet, "/v1/models", "", map[string]string{"x-api-key": store.Config().APIKey})
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"object":"list"`) {
		t.Fatalf("正确 Key 应放行: %d %s", w.Code, w.Body.String())
	}
	// 非 API 路径不需要 Key
	w = do(h, http.MethodGet, "/definitely-missing", "", nil)
	if w.Code != 404 || upstream.GetString(jsonBody(t, w), "error") != "Endpoint not found" {
		t.Fatalf("未知路径应 404: %d %s", w.Code, w.Body.String())
	}
}

func TestWebAuthLoginAndGuard(t *testing.T) {
	h, store := newTestHandler(t)
	apiKey := store.Config().APIKey

	// 未鉴权访问受保护 API → 401 UNAUTHORIZED
	w := do(h, http.MethodGet, "/api/settings", "", nil)
	o := jsonBody(t, w)
	if w.Code != 401 || upstream.GetString(o, "code") != "UNAUTHORIZED" {
		t.Fatalf("未鉴权应 401: %d %s", w.Code, w.Body.String())
	}
	// 错误口令 → 403
	w = do(h, http.MethodPost, "/api/auth/login", `{"password":"nope"}`, nil)
	o = jsonBody(t, w)
	if w.Code != 403 || o.Get("ok") != false || upstream.GetString(o, "error") != "控制台密码或 API Key 不正确，请重新输入" {
		t.Fatalf("错误口令应 403: %d %s", w.Code, w.Body.String())
	}
	// 非字符串 password → 400
	w = do(h, http.MethodPost, "/api/auth/login", `{"password":123}`, nil)
	if w.Code != 400 {
		t.Fatalf("非字符串口令应 400: %d", w.Code)
	}
	// 主控密钥登录（无独立口令时回显输入值）
	w = do(h, http.MethodPost, "/api/auth/login", `{"token":"  `+apiKey+`  "}`, nil)
	o = jsonBody(t, w)
	if w.Code != 200 || o.Get("ok") != true || upstream.GetString(o, "token") != apiKey || o.Get("webAuthEnabled") != true || o.Get("hasDedicatedPassword") != false {
		t.Fatalf("主控密钥登录失败: %d %s", w.Code, w.Body.String())
	}
	// 状态查询
	w = do(h, http.MethodGet, "/api/auth/status?token="+apiKey, "", nil)
	o = jsonBody(t, w)
	if o.Get("authenticated") != true || o.Get("webAuthEnabled") != true {
		t.Fatalf("状态查询错误: %s", w.Body.String())
	}
	w = do(h, http.MethodGet, "/api/auth/status", "", nil)
	if jsonBody(t, w).Get("authenticated") != false {
		t.Fatal("无 token 应未授权")
	}

	// 设置独立口令后：旧 API Key 不再能登录控制台，只能用口令
	w = do(h, http.MethodPost, "/api/settings", `{"webPassword":"  secret-pw  "}`, authHdr(apiKey))
	if w.Code != 200 {
		t.Fatalf("更新设置失败: %d %s", w.Code, w.Body.String())
	}
	w = do(h, http.MethodPost, "/api/auth/login", `{"password":"`+apiKey+`"}`, nil)
	if w.Code != 403 {
		t.Fatalf("配置独立口令后主控密钥不应再登录: %d %s", w.Code, w.Body.String())
	}
	w = do(h, http.MethodPost, "/api/auth/login", `{"password":"secret-pw"}`, nil)
	o = jsonBody(t, w)
	if w.Code != 200 || upstream.GetString(o, "token") != "secret-pw" || o.Get("hasDedicatedPassword") != true {
		t.Fatalf("独立口令登录失败: %d %s", w.Code, w.Body.String())
	}
	// 关闭控制台鉴权：任何人都可直接访问
	_ = do(h, http.MethodPost, "/api/settings", `{"webAuthEnabled":false}`, map[string]string{"x-web-token": "secret-pw"})
	w = do(h, http.MethodGet, "/api/settings", "", nil)
	if w.Code != 200 {
		t.Fatalf("关闭鉴权后应放行: %d", w.Code)
	}
	w = do(h, http.MethodPost, "/api/auth/login", `{"password":""}`, nil)
	o = jsonBody(t, w)
	if o.Get("ok") != true || upstream.GetString(o, "token") != "" || o.Get("webAuthEnabled") != false {
		t.Fatalf("关闭鉴权登录应直接通过且 token 为空: %s", w.Body.String())
	}
}

func TestSettingsViewAndClamps(t *testing.T) {
	h, store := newTestHandler(t)
	apiKey := store.Config().APIKey
	w := do(h, http.MethodGet, "/api/settings", "", authHdr(apiKey))
	o := jsonBody(t, w)
	if w.Code != 200 {
		t.Fatalf("settings GET 失败: %d", w.Code)
	}
	for _, k := range []string{"apiKeyPreview", "hasApiKey", "apiKeys", "webAuthEnabled", "hasWebPassword", "webPassword", "concurrencyLimitEnabled", "maxInFlightPerAccount", "routingStrategy", "routingRegionScope", "accountFailoverEnabled", "pinnedAccount", "stickySessionEnabled", "stickySessionTtlMs", "stickySessionMaxLifetimeMs", "sessionStats", "modelFallbackEnabled", "modelFallback", "tokenRefreshAdvanceDays", "maxLogDbSizeMb", "logDbSizeMb", "autoCheckin", "modelBlacklist", "thinkingPolicy", "promptPolicy", "loggingPolicy", "requestClientInfo", "requestArchiveContext", "privateDataPolicy"} {
		if !o.Has(k) {
			t.Fatalf("settings 缺少字段 %q: %s", k, w.Body.String())
		}
	}
	if o.Has("apiKey") || o.Has("rootDir") {
		t.Fatal("settings GET 不得回传明文 apiKey/rootDir")
	}
	if o.Get("maxInFlightPerAccount") != upstream.Num(3) || upstream.GetString(o, "routingStrategy") != "least-inflight" || upstream.GetString(o, "routingRegionScope") != "all" || o.Get("tokenRefreshAdvanceDays") != upstream.Num(7) || o.Get("maxLogDbSizeMb") != upstream.Num(30) {
		t.Fatalf("默认值错误: %s", w.Body.String())
	}
	// 自动生成的 Key 脱敏预览
	if !strings.HasPrefix(upstream.GetString(o, "apiKeyPreview"), apiKey[:8]) || !strings.HasSuffix(upstream.GetString(o, "apiKeyPreview"), "****"+apiKey[len(apiKey)-4:]) {
		t.Fatalf("apiKeyPreview 脱敏错误: %s", upstream.GetString(o, "apiKeyPreview"))
	}
	// 键序：apiKeyPreview 紧跟 port/首位，最后一项为 privateDataPolicy（与 Node 对象字面量顺序一致）
	if keys := o.Keys(); (keys[0] != "port" && keys[0] != "apiKeyPreview") || keys[len(keys)-1] != "privateDataPolicy" {
		t.Fatalf("settings 键序错误: %v", keys)
	}
	if idxOf(o.Keys(), "apiKeyPreview") > idxOf(o.Keys(), "apiKeys") {
		t.Fatalf("apiKeyPreview 应先于 apiKeys: %v", o.Keys())
	}

	// 边界夹取
	body := `{"stickySessionTtlMs":5000,"stickySessionMaxLifetimeMs":999999999999,"tokenRefreshAdvanceDays":50,"maxLogDbSizeMb":0,"maxInFlightPerAccount":-3,"routingRegionScope":" INTL ","pinnedAccount":"  u1  ","requestClientInfo":false,"concurrencyLimitEnabled":false,"modelFallbackEnabled":false,"autoCheckin":true}`
	w = do(h, http.MethodPost, "/api/settings", body, authHdr(apiKey))
	if w.Code != 200 {
		t.Fatalf("settings POST 失败: %d %s", w.Code, w.Body.String())
	}
	o = jsonBody(t, w)
	if o.Get("ok") != true || !o.Has("config") || !o.Has("apiKeys") || !o.Has("webAuthToken") || !o.Has("promptPolicy") || !o.Has("logDbSizeMb") {
		t.Fatalf("settings POST 响应字段缺失: %s", w.Body.String())
	}
	c := store.Config()
	if *c.StickySessionTtlMs != 10000 || *c.StickySessionMaxLifetimeMs != 365*86400000 {
		t.Fatalf("粘性 TTL 夹取错误: %d %d", *c.StickySessionTtlMs, *c.StickySessionMaxLifetimeMs)
	}
	if *c.TokenRefreshAdvanceDays != 30 || *c.MaxLogDbSizeMb != 1 || *c.MaxInFlightPerAccount != 1 {
		t.Fatalf("数值夹取错误: %+v", c)
	}
	if c.RoutingRegionScope != "intl" || c.PinnedAccount != "u1" {
		t.Fatalf("区域/锁定账号错误: %q %q", c.RoutingRegionScope, c.PinnedAccount)
	}
	// 注意：autoCheckin 不在 Node 的 settings POST 处理清单内（routes.mjs:281-420），网关同样不在此处写入
	if *c.RequestClientInfo != false || *c.ConcurrencyLimitEnabled != false || *c.ModelFallbackEnabled != false || c.AutoCheckin != nil {
		t.Fatalf("布尔字段错误: %+v", c)
	}
	// maxLifetime < ttl 时抬到 ttl
	_ = do(h, http.MethodPost, "/api/settings", `{"stickySessionTtlMs":20000,"stickySessionMaxLifetimeMs":10000}`, authHdr(apiKey))
	c = store.Config()
	if *c.StickySessionMaxLifetimeMs != 20000 {
		t.Fatalf("maxLifetime 应抬到 ttl: %d", *c.StickySessionMaxLifetimeMs)
	}
	// 已落盘
	disk, err := config.Open(store.Paths().DataDir)
	if err != nil {
		t.Fatal(err)
	}
	if *disk.Config().StickySessionTtlMs != 20000 || disk.Config().PinnedAccount != "u1" {
		t.Fatalf("设置未落盘: %+v", disk.Config())
	}
}

func TestSettingsAPIKeysAndPolicy(t *testing.T) {
	h, store := newTestHandler(t)
	apiKey := store.Config().APIKey
	// 替换多密钥列表：首个 enabled 的成为主密钥
	w := do(h, http.MethodPost, "/api/settings", `{"apiKeys":[{"id":"k_b","key":"sk-bbbbbbbbbbbb","note":"b","enabled":true},{"id":"k_a","key":"sk-aaaaaaaaaaaa","note":"a","enabled":true}]}`, authHdr(apiKey))
	if w.Code != 200 {
		t.Fatalf("更新多密钥失败: %d %s", w.Code, w.Body.String())
	}
	if store.Config().APIKey != "sk-bbbbbbbbbbbb" {
		t.Fatalf("首个启用密钥应成为主密钥: %q", store.Config().APIKey)
	}
	// enabled 缺省视为启用
	_ = do(h, http.MethodPost, "/api/settings", `{"apiKeys":[{"id":"k_c","key":"sk-cccccccccccc"}]}`, authHdr("sk-bbbbbbbbbbbb"))
	if store.Config().APIKey != "sk-cccccccccccc" || len(store.GetAPIKeys()) != 1 || !store.GetAPIKeys()[0].Enabled {
		t.Fatalf("enabled 缺省处理错误: %+v", store.GetAPIKeys())
	}
	// 新 Key 生效，旧 Key 失效
	if w = do(h, http.MethodGet, "/v1/models", "", authHdr("sk-bbbbbbbbbbbb")); w.Code != 401 {
		t.Fatalf("旧 Key 应失效: %d", w.Code)
	}
	if w = do(h, http.MethodGet, "/v1/models", "", authHdr("sk-cccccccccccc")); w.Code != 200 {
		t.Fatalf("新 Key 应生效: %d", w.Code)
	}
	// generateNewApiKey
	before := store.Config().APIKey
	w = do(h, http.MethodPost, "/api/settings", `{"generateNewApiKey":true}`, authHdr(before))
	if w.Code != 200 || store.Config().APIKey == before || !strings.HasPrefix(store.Config().APIKey, "sk-") {
		t.Fatalf("重新生成 Key 失败: %d %q", w.Code, store.Config().APIKey)
	}
	if store.GetAPIKeys()[0].Key != store.Config().APIKey {
		t.Fatal("重新生成后首个密钥条目应同步")
	}
	// apiKey 字符串为空 → 生成随机
	prev := store.Config().APIKey
	_ = do(h, http.MethodPost, "/api/settings", `{"apiKey":"   "}`, authHdr(prev))
	if store.Config().APIKey == prev || !strings.HasPrefix(store.Config().APIKey, "sk-") {
		t.Fatalf("空 apiKey 应生成随机 Key: %q", store.Config().APIKey)
	}
	// 策略对象
	w = do(h, http.MethodPost, "/api/settings", `{"thinkingPolicy":{"enabled":true,"defaultLevel":"low","modelLevels":{"gpt-x":"minimal"}},"promptPolicy":{"mode":"custom","file":"p.txt"},"loggingPolicy":{"requestClientInfo":false},"privateDataPolicy":false,"modelFallback":{"gpt-x":"gpt-y"}}`, authHdr(store.Config().APIKey))
	if w.Code != 200 {
		t.Fatalf("策略更新失败: %d %s", w.Code, w.Body.String())
	}
	tp := store.GetThinkingPolicy()
	if !tp.Enabled || tp.DefaultLevel != "low" || tp.ModelLevels["gpt-x"] != "minimal" {
		t.Fatalf("thinkingPolicy 错误: %+v", tp)
	}
	if pp := store.GetPromptPolicy(); pp.Mode != "custom" || pp.File != "p.txt" {
		t.Fatalf("promptPolicy 错误: %+v", pp)
	}
	if lp := store.GetLoggingPolicy(); lp.RequestClientInfo {
		t.Fatalf("loggingPolicy 错误: %+v", lp)
	}
	if store.GetPrivateDataPolicy() != "false" {
		t.Fatalf("privateDataPolicy 错误: %q", store.GetPrivateDataPolicy())
	}
	if store.Config().ModelFallback["gpt-x"] != "gpt-y" {
		t.Fatalf("modelFallback 错误: %v", store.Config().ModelFallback)
	}
	// promptMode/promptFile 顶层字段
	_ = do(h, http.MethodPost, "/api/settings", `{"promptMode":"append","promptFile":"q.txt"}`, authHdr(store.Config().APIKey))
	if pp := store.GetPromptPolicy(); pp.Mode != "append" || pp.File != "q.txt" {
		t.Fatalf("promptMode 顶层字段错误: %+v", pp)
	}
	// 非法 JSON → 400
	w = do(h, http.MethodPost, "/api/settings", `{bad`, authHdr(store.Config().APIKey))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "error") {
		t.Fatalf("非法 JSON 应 400: %d %s", w.Code, w.Body.String())
	}
}

func TestAPIKeysRoutes(t *testing.T) {
	h, store := newTestHandler(t)
	apiKey := store.Config().APIKey
	w := do(h, http.MethodPost, "/api/keys", `{"key":"  sk-second-key-123456  ","note":" 备用 "}`, authHdr(apiKey))
	o := jsonBody(t, w)
	entry := upstream.GetObj(o, "entry")
	if w.Code != 200 || o.Get("ok") != true || upstream.GetString(entry, "key") != "sk-second-key-123456" || upstream.GetString(entry, "note") != "备用" {
		t.Fatalf("新增密钥失败: %d %s", w.Code, w.Body.String())
	}
	if store.Config().APIKey != apiKey {
		t.Fatal("新增密钥不应改变主密钥")
	}
	// 默认脱敏
	w = do(h, http.MethodGet, "/api/keys", "", authHdr(apiKey))
	o = jsonBody(t, w)
	keys := upstream.GetArr(o, "keys")
	if o.Get("revealed") != false || len(keys) != 2 {
		t.Fatalf("密钥列表错误: %s", w.Body.String())
	}
	masked := upstream.GetString(keys[1].(*upstream.Obj), "key")
	if masked != "sk-secon****3456" {
		t.Fatalf("脱敏格式错误: %q", masked)
	}
	if upstream.GetString(o, "apiKey") == apiKey {
		t.Fatal("默认不得回传明文主密钥")
	}
	// reveal=1 回明文
	w = do(h, http.MethodGet, "/api/keys?reveal=1", "", authHdr(apiKey))
	o = jsonBody(t, w)
	if upstream.GetString(o, "apiKey") != apiKey || upstream.GetString(upstream.GetArr(o, "keys")[1].(*upstream.Obj), "key") != "sk-second-key-123456" {
		t.Fatalf("reveal 应回明文: %s", w.Body.String())
	}
	// update / delete
	id := upstream.GetString(keys[1].(*upstream.Obj), "id")
	w = do(h, http.MethodPost, "/api/keys/update", `{"id":"`+id+`","note":"renamed","enabled":false}`, authHdr(apiKey))
	o = jsonBody(t, w)
	if w.Code != 200 || upstream.GetString(upstream.GetObj(o, "entry"), "note") != "renamed" || upstream.GetObj(o, "entry").Get("enabled") != false {
		t.Fatalf("更新密钥失败: %d %s", w.Code, w.Body.String())
	}
	if w = do(h, http.MethodGet, "/v1/models", "", authHdr("sk-second-key-123456")); w.Code != 401 {
		t.Fatal("禁用后的密钥不应放行")
	}
	w = do(h, http.MethodPost, "/api/keys/update", `{"id":"missing"}`, authHdr(apiKey))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "未找到指定密钥") {
		t.Fatalf("更新不存在密钥应 400: %d %s", w.Code, w.Body.String())
	}
	w = do(h, http.MethodPost, "/api/keys/delete", `{"id":"`+id+`"}`, authHdr(apiKey))
	o = jsonBody(t, w)
	if w.Code != 200 || o.Get("ok") != true || len(upstream.GetArr(o, "keys")) != 1 {
		t.Fatalf("删除密钥失败: %d %s", w.Code, w.Body.String())
	}
	// 最后一个不能删
	last := upstream.GetString(upstream.GetArr(o, "keys")[0].(*upstream.Obj), "id")
	w = do(h, http.MethodPost, "/api/keys/delete", `{"id":"`+last+`"}`, authHdr(apiKey))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "至少需要保留一个") {
		t.Fatalf("删除最后一个密钥应 400: %d %s", w.Code, w.Body.String())
	}
	w = do(h, http.MethodPost, "/api/keys/delete", `{"id":""}`, authHdr(apiKey))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "缺少密钥 ID") {
		t.Fatalf("缺少 ID 应 400: %d %s", w.Code, w.Body.String())
	}
}

func TestDashboardRender(t *testing.T) {
	h, store := newTestHandler(t)
	w := do(h, http.MethodGet, "/", "", nil)
	if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") || w.Header().Get("Cache-Control") != "no-cache, no-store, must-revalidate" || w.Header().Get("Pragma") != "no-cache" || w.Header().Get("Expires") != "0" {
		t.Fatalf("dashboard 响应头错误: %d %v", w.Code, w.Header())
	}
	html := w.Body.String()
	if strings.Contains(html, "{{") || strings.Contains(html, "@include") || strings.Contains(html, "Missing include") {
		t.Fatal("模板占位符/子模块未展开")
	}
	if !strings.Contains(html, config.CurrentVersion) || !strings.Contains(html, "sk-****************") {
		t.Fatal("模板替换不完整")
	}
	// 鉴权关闭后回传明文 Key
	_ = do(h, http.MethodPost, "/api/settings", `{"webAuthEnabled":false}`, authHdr(store.Config().APIKey))
	w = do(h, http.MethodGet, "/index.html", "", nil)
	if !strings.Contains(w.Body.String(), store.Config().APIKey) {
		t.Fatal("关闭鉴权后应回传明文 Key")
	}
}

func TestAccountRoutes(t *testing.T) {
	h, store := newTestHandler(t)
	apiKey := store.Config().APIKey
	// 空列表
	w := do(h, http.MethodGet, "/api/accounts?stale=0", "", authHdr(apiKey))
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("空账号列表应为 []: %s", w.Body.String())
	}
	// credit-details 无账号 404
	if w = do(h, http.MethodGet, "/api/accounts/credit-details", "", authHdr(apiKey)); w.Code != 404 {
		t.Fatalf("无账号应 404: %d", w.Code)
	}
	// usage-records 缺 uid
	if w = do(h, http.MethodGet, "/api/accounts/usage-records", "", authHdr(apiKey)); w.Code != 400 {
		t.Fatalf("缺 uid 应 400: %d", w.Code)
	}
	// 导入：非法结构 → 400
	w = do(h, http.MethodPost, "/api/accounts/import", `{"foo":1}`, authHdr(apiKey))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "未识别到有效的账号数据") {
		t.Fatalf("无效导入应 400: %d %s", w.Code, w.Body.String())
	}
	// 导入单个账号（payload.account + payload.auth 合并；normalizeAccount 缺 email 时取 nickname）
	payload := `{"account":{"uid":"u1","nickname":"tester@example.com","region":"intl","phoneNumber":"13800000000","note":"主号"},"auth":{"accessToken":"a.b.c","refreshToken":"r1"}}`
	w = do(h, http.MethodPost, "/api/accounts/import", payload, authHdr(apiKey))
	o := jsonBody(t, w)
	if w.Code != 200 || o.Get("ok") != true || o.Get("count") != upstream.Num(1) {
		t.Fatalf("导入失败: %d %s", w.Code, w.Body.String())
	}
	row := upstream.GetArr(o, "imported")[0].(*upstream.Obj)
	if upstream.GetString(row, "uid") != "u1" || upstream.GetString(row, "email") != "tester@example.com" || upstream.GetString(row, "region") != "intl" || upstream.GetString(row, "note") != "主号" {
		t.Fatalf("导入结果错误: %s", w.Body.String())
	}
	acc := store.Accounts().Get("u1")
	if acc == nil || acc.AccessToken != "a.b.c" || acc.RefreshToken != "r1" || acc.Status != "healthy" || acc.PhoneNumber != "13800000000" {
		t.Fatalf("导入账号字段错误: %+v", acc)
	}
	// 重复导入：合并 token，备注不覆盖
	w = do(h, http.MethodPost, "/api/accounts/import", `[{"uid":"u1","accessToken":"new.token","note":"改名"}]`, authHdr(apiKey))
	o = jsonBody(t, w)
	if o.Get("count") != upstream.Num(1) {
		t.Fatalf("重复导入 count 错误: %s", w.Body.String())
	}
	acc = store.Accounts().Get("u1")
	if acc.AccessToken != "new.token" || acc.RefreshToken != "r1" || acc.Note != "主号" {
		t.Fatalf("重复导入合并错误: %+v", acc)
	}
	// 账号列表
	w = do(h, http.MethodGet, "/api/accounts?stale=0&range=all", "", authHdr(apiKey))
	arr, _ := upstream.ParseAny(w.Body.Bytes())
	list, _ := arr.([]any)
	if len(list) != 1 {
		t.Fatalf("账号列表长度错误: %s", w.Body.String())
	}
	item := list[0].(*upstream.Obj)
	// 第二次导入未带 region：normalizeAccount 兜底为 cn 并覆盖（与 Node `norm.region || existing.region` 一致）
	if upstream.GetString(item, "uid") != "u1" || upstream.GetString(item, "region") != "cn" || upstream.GetString(item, "tokenRange") != "all" || upstream.GetString(item, "lastCheckinMsg") != "今日未签到" || upstream.GetString(item, "expiresAtFmt") != "未知" || item.Get("hasRefreshToken") != true || item.Get("isCooldown") != false || item.Get("lockedCount") != upstream.Num(0) || item.Get("daysRemaining") != nil {
		t.Fatalf("账号列表字段错误: %s", w.Body.String())
	}
	if keys := item.Keys(); keys[0] != "uid" || keys[1] != "email" || keys[2] != "note" || keys[3] != "region" || keys[len(keys)-1] != "lastCheckinMsg" {
		t.Fatalf("账号列表键序错误: %v", keys)
	}
	// 备注
	w = do(h, http.MethodPost, "/api/accounts/note", `{"uid":"u1","note":"  新备注 "}`, authHdr(apiKey))
	o = jsonBody(t, w)
	if w.Code != 200 || upstream.GetString(o, "note") != "新备注" || store.Accounts().Get("u1").Note != "新备注" {
		t.Fatalf("备注更新失败: %d %s", w.Code, w.Body.String())
	}
	if w = do(h, http.MethodPost, "/api/accounts/note", `{"uid":"nope"}`, authHdr(apiKey)); w.Code != 404 {
		t.Fatalf("未知账号备注应 404: %d", w.Code)
	}
	// 区域切换
	w = do(h, http.MethodPost, "/api/accounts/region", `{"uid":"u1","region":"international"}`, authHdr(apiKey))
	o = jsonBody(t, w)
	if w.Code != 200 || upstream.GetString(o, "region") != "intl" || upstream.GetString(o, "label") != "国际版" {
		t.Fatalf("区域切换失败: %d %s", w.Code, w.Body.String())
	}
	// 锁定 / 取消锁定
	w = do(h, http.MethodPost, "/api/accounts/pin", `{"uid":" u1 "}`, authHdr(apiKey))
	if w.Code != 200 || store.Config().PinnedAccount != "u1" {
		t.Fatalf("锁定账号失败: %d %s", w.Code, w.Body.String())
	}
	w = do(h, http.MethodPost, "/api/accounts/pin", `{"uid":""}`, authHdr(apiKey))
	if store.Config().PinnedAccount != "" {
		t.Fatal("取消锁定失败")
	}
	// 解锁模型：单模型
	store.Accounts().Mutate("u1", func(a *config.Account) {
		a.ModelCooldowns = map[string]int64{"m1": 1, "m2": 9999999999999}
		a.ModelCooldownReasons = map[string]string{"m2": "x"}
	})
	w = do(h, http.MethodGet, "/api/accounts?stale=0", "", authHdr(apiKey))
	list, _ = func() ([]any, bool) { a, _ := upstream.ParseAny(w.Body.Bytes()); l, ok := a.([]any); return l, ok }()
	item = list[0].(*upstream.Obj)
	if item.Get("lockedCount") != upstream.Num(1) || len(upstream.GetArr(item, "lockedModels")) != 1 || upstream.GetString(upstream.GetArr(item, "lockedModels")[0].(*upstream.Obj), "modelId") != "m2" {
		t.Fatalf("锁池状态错误: %s", w.Body.String())
	}
	if cd := store.Accounts().Get("u1").ModelCooldowns; len(cd) != 1 || cd["m1"] != 0 {
		t.Fatalf("过期冷却应被清理: %v", cd)
	}
	w = do(h, http.MethodPost, "/api/accounts/unlock-models", `{"uid":"u1","modelId":"m2"}`, authHdr(apiKey))
	if w.Code != 200 || len(store.Accounts().Get("u1").ModelCooldowns) != 0 {
		t.Fatalf("单模型解锁失败: %d %v", w.Code, store.Accounts().Get("u1").ModelCooldowns)
	}
	// 解锁全部 + 受限恢复
	store.Accounts().Mutate("u1", func(a *config.Account) {
		a.Status = "restricted"
		a.RestrictedAt = 1
		a.RestrictedReason = "r"
		a.CooldownUntil = 9999999999999
	})
	w = do(h, http.MethodPost, "/api/accounts/unlock-models", `{"uid":"u1"}`, authHdr(apiKey))
	o = jsonBody(t, w)
	acc = store.Accounts().Get("u1")
	if w.Code != 200 || upstream.GetString(o, "msg") != "锁池与受限状态已成功解除" || acc.Status != "healthy" || acc.RestrictedAt != 0 || acc.CooldownUntil != 0 {
		t.Fatalf("一键解锁失败: %d %+v", w.Code, acc)
	}
	// credit-details 指定 uid（无上游客户端 → 返回对象壳）
	w = do(h, http.MethodGet, "/api/accounts/credit-details?uid=u1", "", authHdr(apiKey))
	o = jsonBody(t, w)
	if w.Code != 200 || upstream.GetString(o, "uid") != "u1" || upstream.GetString(o, "region") != "intl" {
		t.Fatalf("credit-details 失败: %d %s", w.Code, w.Body.String())
	}
	// 删除
	w = do(h, http.MethodPost, "/api/accounts/delete", `{"uid":"u1"}`, authHdr(apiKey))
	if w.Code != 200 || store.Accounts().Len() != 0 {
		t.Fatalf("删除账号失败: %d", w.Code)
	}
	w = do(h, http.MethodPost, "/api/accounts/delete", `{bad`, authHdr(apiKey))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "请求体不是合法 JSON") {
		t.Fatalf("删除非法 JSON 应 400: %d %s", w.Code, w.Body.String())
	}
}

func TestMetricsSessionsLogsRoutes(t *testing.T) {
	h, store := newTestHandler(t)
	apiKey := store.Config().APIKey
	w := do(h, http.MethodGet, "/api/metrics?range=7d", "", authHdr(apiKey))
	o := jsonBody(t, w)
	keys := o.Keys()
	if w.Code != 200 || upstream.GetString(o, "range") != "7d" || !o.Has("currentAccount") || !o.Has("sessionAffinity") || !o.Has("uptimeMs") || !o.Has("uptime") || !o.Has("startedAt") {
		t.Fatalf("metrics 错误: %d %s", w.Code, w.Body.String())
	}
	if keys[len(keys)-5] != "currentAccount" || keys[len(keys)-1] != "startedAt" {
		t.Fatalf("metrics 追加键序错误: %v", keys[len(keys)-6:])
	}
	w = do(h, http.MethodPost, "/api/sessions/clear", "", authHdr(apiKey))
	o = jsonBody(t, w)
	if w.Code != 200 || o.Get("ok") != true || o.Get("cleared") != upstream.Num(0) {
		t.Fatalf("sessions/clear 错误: %s", w.Body.String())
	}
	w = do(h, http.MethodGet, "/api/logs/dates", "", authHdr(apiKey))
	o = jsonBody(t, w)
	if w.Code != 200 || !o.Has("dates") {
		t.Fatalf("logs/dates 错误: %s", w.Body.String())
	}
	w = do(h, http.MethodGet, "/api/logs?limit=5&date=2020-01-01", "", authHdr(apiKey))
	o = jsonBody(t, w)
	if w.Code != 200 || o.Get("total") != upstream.Num(0) || len(upstream.GetArr(o, "logs")) != 0 {
		t.Fatalf("logs 查询错误: %s", w.Body.String())
	}
	w = do(h, http.MethodGet, "/api/logs/export?date=2020-01-01", "", authHdr(apiKey))
	if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/plain") || w.Header().Get("Content-Disposition") != `attachment; filename="gateway-2020-01-01.log"` {
		t.Fatalf("logs export 错误: %d %v", w.Code, w.Header())
	}
	w = do(h, http.MethodPost, "/api/logs/prune-size", `not json`, authHdr(apiKey))
	if w.Code != 200 || !jsonBody(t, w).Has("ok") {
		t.Fatalf("logs/prune-size 容错错误: %d %s", w.Code, w.Body.String())
	}
	w = do(h, http.MethodPost, "/api/logs/prune", `{"mode":"today_only"}`, authHdr(apiKey))
	if w.Code != 200 {
		t.Fatalf("logs/prune 错误: %d", w.Code)
	}
	w = do(h, http.MethodPost, "/api/metrics/prune", `{"mode":"days","keepDays":7}`, authHdr(apiKey))
	if w.Code != 200 || jsonBody(t, w).Get("ok") != true {
		t.Fatalf("metrics/prune 错误: %d %s", w.Code, w.Body.String())
	}
	w = do(h, http.MethodGet, "/api/credits/history?limit=5000&refresh=0", "", authHdr(apiKey))
	o = jsonBody(t, w)
	if w.Code != 200 || o.Get("total") != upstream.Num(0) || len(upstream.GetArr(o, "records")) != 0 || upstream.GetString(o, "range") != "today" || o.Get("date") != nil {
		t.Fatalf("credits/history 错误: %s", w.Body.String())
	}
	w = do(h, http.MethodPost, "/api/credits/history/clear", "", authHdr(apiKey))
	if w.Code != 200 {
		t.Fatalf("credits/history/clear 错误: %d", w.Code)
	}
	w = do(h, http.MethodGet, "/api/pricing", "", authHdr(apiKey))
	o = jsonBody(t, w)
	if w.Code != 200 || o.Get("ok") != true || !o.Has("prices") {
		t.Fatalf("pricing 错误: %s", w.Body.String())
	}
	w = do(h, http.MethodPost, "/api/pricing/update", `{"prices":{"gpt-x":{"input":1,"output":2,"currency":"CNY"}}}`, authHdr(apiKey))
	o = jsonBody(t, w)
	if w.Code != 200 || !upstream.GetObj(o, "prices").Has("gpt-x") {
		t.Fatalf("pricing/update 错误: %s", w.Body.String())
	}
	w = do(h, http.MethodPost, "/api/pricing/search", `{"query":"x"}`, authHdr(apiKey))
	if w.Code != 500 || jsonBody(t, w).Get("ok") != false {
		t.Fatalf("无账号时 pricing/search 应 500: %d %s", w.Code, w.Body.String())
	}
	w = do(h, http.MethodGet, "/api/models-detail", "", authHdr(apiKey))
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("无账号时 models-detail 应为 []: %s", w.Body.String())
	}
	w = do(h, http.MethodGet, "/api/models/blacklist", "", authHdr(apiKey))
	o = jsonBody(t, w)
	if w.Code != 200 || o.Get("blockedCount") != upstream.Num(0) {
		t.Fatalf("blacklist GET 错误: %s", w.Body.String())
	}
	w = do(h, http.MethodPost, "/api/models/blacklist", `{"blacklist":["cn:gpt-x","bad"]}`, authHdr(apiKey))
	o = jsonBody(t, w)
	if w.Code != 200 || o.Get("success") != true || o.Get("count") != upstream.Num(2) || !store.IsModelBlacklisted("cn:gpt-x", "gpt-x", "cn") {
		t.Fatalf("blacklist POST 错误: %d %s", w.Code, w.Body.String())
	}
	w = do(h, http.MethodPost, "/api/models/thinking-level", `{"modelId":"gpt-x","level":"low"}`, authHdr(apiKey))
	o = jsonBody(t, w)
	if w.Code != 200 || upstream.GetString(o, "modelId") != "gpt-x" || upstream.GetString(o, "level") != "low" || store.GetThinkingPolicy().ModelLevels["gpt-x"] != "low" {
		t.Fatalf("thinking-level 错误: %d %s", w.Code, w.Body.String())
	}
	w = do(h, http.MethodPost, "/api/models/thinking-level", `{"level":"low"}`, authHdr(apiKey))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "缺少 modelId") {
		t.Fatalf("thinking-level 缺 modelId 应 400: %d", w.Code)
	}
	w = do(h, http.MethodGet, "/api/unknown", "", authHdr(apiKey))
	if w.Code != 404 || upstream.GetString(jsonBody(t, w), "error") != "API route not found" {
		t.Fatalf("未知 API 路由应 404: %d %s", w.Code, w.Body.String())
	}
}

func TestCheckinRoutesWithoutUpstream(t *testing.T) {
	h, store := newTestHandler(t)
	apiKey := store.Config().APIKey
	_ = do(h, http.MethodPost, "/api/accounts/import", `{"uid":"u1","accessToken":"t"}`, authHdr(apiKey))
	w := do(h, http.MethodPost, "/api/checkin", "", authHdr(apiKey))
	o := jsonBody(t, w)
	results := upstream.GetArr(o, "results")
	if w.Code != 200 || o.Get("total") != upstream.Num(1) || len(results) != 1 || upstream.GetString(results[0].(*upstream.Obj), "uid") != "u1" {
		t.Fatalf("全员打卡错误: %d %s", w.Code, w.Body.String())
	}
	w = do(h, http.MethodPost, "/api/checkin-single", `{"uid":"u1"}`, authHdr(apiKey))
	if w.Code != 200 {
		t.Fatalf("单号打卡错误: %d %s", w.Code, w.Body.String())
	}
	if w = do(h, http.MethodPost, "/api/checkin-single", `{"uid":"nope"}`, authHdr(apiKey)); w.Code != 404 {
		t.Fatalf("单号打卡未知账号应 404: %d", w.Code)
	}
	w = do(h, http.MethodPost, "/api/accounts/refresh-token", `{"uid":"u1"}`, authHdr(apiKey))
	o = jsonBody(t, w)
	if w.Code != 200 || o.Get("ok") != false {
		t.Fatalf("无上游客户端时 refresh-token 应 ok:false: %d %s", w.Code, w.Body.String())
	}
	w = do(h, http.MethodPost, "/api/oauth/start", `{"region":"intl"}`, authHdr(apiKey))
	if w.Code != 500 {
		t.Fatalf("无网络时 oauth/start 应 500: %d %s", w.Code, w.Body.String())
	}
	w = do(h, http.MethodPost, "/api/oauth/poll", `{bad`, authHdr(apiKey))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "请求体不是合法 JSON") {
		t.Fatalf("oauth/poll 非法 JSON 应 400: %d", w.Code)
	}
}

func TestRequestBodyLimit(t *testing.T) {
	h, _ := newTestHandler(t)
	// 直接调 readRequestBody：Content-Length 预检
	var r *http.Request
	r = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader("x"))
	r.ContentLength = MaxRequestBodyBytes + 1
	w := httptest.NewRecorder()
	h.readRequestBody(w, r, func(http.ResponseWriter, *http.Request, []byte) { t.Fatal("超限不应进入 handler") })
	o := jsonBody(t, w)
	if w.Code != 413 || upstream.GetString(upstream.GetObj(o, "error"), "type") != "payload_too_large" || !strings.Contains(upstream.GetString(upstream.GetObj(o, "error"), "message"), "max 50MB") {
		t.Fatalf("Content-Length 预检错误: %d %s", w.Code, w.Body.String())
	}
	// 流式超限
	r = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", ioLimitReader{})
	r.ContentLength = -1
	w = httptest.NewRecorder()
	h.readRequestBody(w, r, func(http.ResponseWriter, *http.Request, []byte) { t.Fatal("超限不应进入 handler") })
	o = jsonBody(t, w)
	if w.Code != 413 || !strings.Contains(upstream.GetString(upstream.GetObj(o, "error"), "message"), "exceeded 50MB") {
		t.Fatalf("流式超限错误: %d %s", w.Code, w.Body.String())
	}
}

// ioLimitReader 永远可读，模拟超过上限的流。
type ioLimitReader struct{}

func (ioLimitReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'a'
	}
	return len(p), nil
}
