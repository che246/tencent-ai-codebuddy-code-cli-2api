package scheduler

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/database"
	"codebuddy-gateway/internal/core/logger"
	"codebuddy-gateway/internal/upstream"
)

func quietLogger() *logger.Logger {
	l := logger.New(nil, "")
	l.SetWriters(io.Discard, io.Discard)
	return l
}

func newTestScheduler(t *testing.T, accs ...*config.Account) *Scheduler {
	t.Helper()
	store, err := config.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range accs {
		store.Accounts().Upsert(a)
	}
	lg := quietLogger()
	s := New(store, nil, lg, upstream.NewClient(nil, false, lg))
	t.Cleanup(s.Stop)
	return s
}

func acc(uid, email string, region string) *config.Account {
	return &config.Account{UID: uid, Email: email, Status: "healthy", Region: region, AccessToken: "tok-" + uid}
}

// redirectEndpoints 把调度器所有上游端点指向测试服务器。
func (s *Scheduler) redirectEndpoints(srv *httptest.Server) {
	base := srv.URL
	s.epFn = func(*config.Account) config.Endpoints {
		return config.Endpoints{
			APIBase: base, Upstream: base + "/upstream", Config: base + "/config",
			Summary: base + "/summary", Checkin: base + "/checkin", AuthRefresh: base + "/auth/refresh",
		}
	}
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("condition not met within %s", timeout)
}

// ─── ExtractSessionKey ────────────────────────────────────────────────────────

func md5hex(s string) string { sum := md5.Sum([]byte(s)); return hex.EncodeToString(sum[:]) }

func TestExtractSessionKeyHeaderPrecedence(t *testing.T) {
	h := http.Header{}
	h.Set("X-Session-Id", " s1 ")
	h.Set("Session-Id", "s2")
	if got := ExtractSessionKey(h, nil); got != "s1" {
		t.Fatalf("got %q", got)
	}
	h = http.Header{}
	h.Set("conversation-id", "c1")
	h.Set("x-chat-id", "c2")
	if got := ExtractSessionKey(h, nil); got != "c1" {
		t.Fatalf("got %q", got)
	}
	// 多值以 ", " 连接
	h = http.Header{}
	h.Add("X-Session-Id", "a")
	h.Add("X-Session-Id", "b")
	if got := ExtractSessionKey(h, nil); got != "a, b" {
		t.Fatalf("got %q", got)
	}
	// 空白 header 被跳过
	h = http.Header{}
	h.Set("X-Session-Id", "   ")
	if got := ExtractSessionKey(h, upstream.NewObj().Set("session_id", "p1")); got != "p1" {
		t.Fatalf("got %q", got)
	}
}

func TestExtractSessionKeyPayloadAndFingerprint(t *testing.T) {
	// payload 顶层字段
	p, _ := upstream.ParseObj([]byte(`{"user":"u1"}`))
	if got := ExtractSessionKey(http.Header{}, p); got != "u1" {
		t.Fatalf("got %q", got)
	}
	// metadata 嵌套
	p, _ = upstream.ParseObj([]byte(`{"metadata":{"user_id":"m1"}}`))
	if got := ExtractSessionKey(http.Header{}, p); got != "m1" {
		t.Fatalf("got %q", got)
	}
	// 指纹：system 字符串 + 首个 user
	p, _ = upstream.ParseObj([]byte(`{"system":"S","messages":[{"role":"user","content":"U"},{"role":"user","content":"V"}]}`))
	if got := ExtractSessionKey(http.Header{}, p); got != md5hex("sys:S|user:U") {
		t.Fatalf("got %q want %q", got, md5hex("sys:S|user:U"))
	}
	// system 为 blocks 数组 → 以 \n 连接
	p, _ = upstream.ParseObj([]byte(`{"system":[{"text":"a"},{"text":"b"}],"messages":[{"role":"user","content":"U"}]}`))
	if got := ExtractSessionKey(http.Header{}, p); got != md5hex("sys:a\nb|user:U") {
		t.Fatalf("got %q", got)
	}
	// 无 payload.system → 取首个 role:system；content 为数组 → JSON
	p, _ = upstream.ParseObj([]byte(`{"messages":[{"role":"system","content":[{"type":"text","text":"x"}]},{"role":"user","content":"U"}]}`))
	if got := ExtractSessionKey(http.Header{}, p); got != md5hex(`sys:[{"type":"text","text":"x"}]|user:U`) {
		t.Fatalf("got %q", got)
	}
	// 仅 system 无 user
	p, _ = upstream.ParseObj([]byte(`{"messages":[{"role":"system","content":"S"}]}`))
	if got := ExtractSessionKey(http.Header{}, p); got != md5hex("sys:S|") {
		t.Fatalf("got %q", got)
	}
	// 截断 500
	p, _ = upstream.ParseObj([]byte(`{"system":"` + strings.Repeat("x", 600) + `"}`))
	if got := ExtractSessionKey(http.Header{}, p); got != md5hex("sys:"+strings.Repeat("x", 500)+"|") {
		t.Fatalf("long system not truncated")
	}
	// 兜底 UUIDv4
	if got := ExtractSessionKey(http.Header{}, upstream.NewObj()); !strings.Contains(got, "-") || len(got) != 36 {
		t.Fatalf("expected uuid, got %q", got)
	}
}

// ─── SelectAccount ────────────────────────────────────────────────────────────

func TestSelectAccountLeastInflightTieBreak(t *testing.T) {
	a, b, c := acc("a", "a@x.com", config.RegionCn), acc("b", "b@x.com", config.RegionCn), acc("c", "c@x.com", config.RegionCn)
	a.InFlight, a.CreditsRemain = 1, 10
	b.CreditsRemain = 5
	c.CreditsRemain = 20
	s := newTestScheduler(t, a, b, c)
	if got := s.SelectAccount("m", "", SelectOpts{}); got == nil || got.UID != "c" {
		t.Fatalf("want c, got %+v", got)
	}
	if got := s.SelectAccount("m", "", SelectOpts{ExcludeUids: []string{"c"}}); got == nil || got.UID != "b" {
		t.Fatalf("want b, got %+v", got)
	}
	// 排除 b、c → 剩 a（inFlight 1 < 3）
	if got := s.SelectAccount("m", "", SelectOpts{ExcludeUids: []string{"c", "b"}}); got == nil || got.UID != "a" {
		t.Fatalf("want a, got %+v", got)
	}
	if got := s.SelectAccount("m", "", SelectOpts{ExcludeUids: []string{"a", "b", "c"}}); got != nil {
		t.Fatalf("want nil, got %+v", got)
	}
}

func TestSelectAccountStrategies(t *testing.T) {
	a, b, c := acc("a", "a@x.com", config.RegionCn), acc("b", "b@x.com", config.RegionCn), acc("c", "c@x.com", config.RegionCn)
	a.CreditsRemain, b.CreditsRemain, c.CreditsRemain = 1, 30, 20
	s := newTestScheduler(t, a, b, c)
	// round-robin 顺序 a → b → c → a
	for _, want := range []string{"a", "b", "c", "a"} {
		if got := s.SelectAccount("m", "", SelectOpts{Strategy: "round-robin"}); got == nil || got.UID != want {
			t.Fatalf("rr want %s got %+v", want, got)
		}
	}
	if got := s.SelectAccount("m", "", SelectOpts{Strategy: "credits"}); got == nil || got.UID != "b" {
		t.Fatalf("credits want b got %+v", got)
	}
	// 全局 routingStrategy
	_ = s.store.UpdateConfig(func(cf *config.Config) { cf.RoutingStrategy = "credits" })
	if got := s.SelectAccount("m", "", SelectOpts{}); got == nil || got.UID != "b" {
		t.Fatalf("global strategy want b got %+v", got)
	}
}

func TestSelectAccountRegionScope(t *testing.T) {
	cn, intl := acc("cn", "cn@x.com", config.RegionCn), acc("intl", "intl@x.com", config.RegionIntl)
	s := newTestScheduler(t, cn, intl)
	_ = s.store.UpdateConfig(func(cf *config.Config) { cf.RoutingRegionScope = "cn" })
	if got := s.SelectAccount("m", "", SelectOpts{}); got == nil || got.UID != "cn" {
		t.Fatalf("scope cn want cn got %+v", got)
	}
	// 显式 region 优先于全局
	if got := s.SelectAccount("m", "", SelectOpts{Region: "intl"}); got == nil || got.UID != "intl" {
		t.Fatalf("forced intl got %+v", got)
	}
	if got := s.SelectAccount("m", "", SelectOpts{Region: "cn", ExcludeUids: []string{"cn"}}); got != nil {
		t.Fatalf("want nil got %+v", got)
	}
}

func TestSelectAccountPinned(t *testing.T) {
	a, b := acc("a", "a@x.com", config.RegionCn), acc("b", "b@x.com", config.RegionCn)
	b.Note = "prod"
	s := newTestScheduler(t, a, b)
	_ = s.store.UpdateConfig(func(cf *config.Config) { cf.PinnedAccount = "PROD" }) // note 包含匹配（大小写不敏感）
	if got := s.SelectAccount("m", "", SelectOpts{}); got == nil || got.UID != "b" {
		t.Fatalf("pinned want b got %+v", got)
	}
	// 指定账号冷却 → 回落账号池
	s.Cooldown("b", 60, "rate")
	if got := s.SelectAccount("m", "", SelectOpts{}); got == nil || got.UID != "a" {
		t.Fatalf("pinned restricted want a got %+v", got)
	}
	// 指定账号不在池中 → 警告并回落
	_ = s.store.UpdateConfig(func(cf *config.Config) { cf.PinnedAccount = "nobody" })
	if got := s.SelectAccount("m", "", SelectOpts{}); got == nil || got.UID != "a" {
		t.Fatalf("pinned missing want a got %+v", got)
	}
	// 指定账号并发达到上限 → 回落
	s.store.Accounts().Mutate("b", func(x *config.Account) { x.CooldownUntil = 0; x.InFlight = 3 })
	_ = s.store.UpdateConfig(func(cf *config.Config) { cf.PinnedAccount = "b" })
	if got := s.SelectAccount("m", "", SelectOpts{}); got == nil || got.UID != "a" {
		t.Fatalf("pinned busy want a got %+v", got)
	}
	// 关闭并发限制 → 指定账号可直接服务
	_ = s.store.UpdateConfig(func(cf *config.Config) { cf.ConcurrencyLimitEnabled = boolPtr(false) })
	if got := s.SelectAccount("m", "", SelectOpts{}); got == nil || got.UID != "b" {
		t.Fatalf("pinned no-limit want b got %+v", got)
	}
}

func boolPtr(v bool) *bool { return &v }

func TestSelectAccountSticky(t *testing.T) {
	a, b := acc("a", "a@x.com", config.RegionCn), acc("b", "b@x.com", config.RegionCn)
	a.CreditsRemain, b.CreditsRemain = 100, 1
	s := newTestScheduler(t, a, b)
	first := s.SelectAccount("m", "sess-1", SelectOpts{})
	if first == nil || first.UID != "a" {
		t.Fatalf("first want a got %+v", first)
	}
	// a 并发拉满后粘性仍复用 a（粘性优先于池）
	s.store.Accounts().Mutate("a", func(x *config.Account) { x.InFlight = 2 })
	if got := s.SelectAccount("m", "sess-1", SelectOpts{}); got == nil || got.UID != "a" {
		t.Fatalf("sticky want a got %+v", got)
	}
	if st := s.GetSessionAffinityStats(); !st.Enabled || st.TotalSessions != 1 || st.ActiveSessions != 1 {
		t.Fatalf("stats %+v", st)
	}
	// a 进入全局冷却 → 解绑并回落到 b
	s.Cooldown("a", 60, "x")
	if got := s.SelectAccount("m", "sess-1", SelectOpts{}); got == nil || got.UID != "b" {
		t.Fatalf("sticky unbind want b got %+v", got)
	}
	if st := s.GetSessionAffinityStats(); st.TotalSessions != 1 {
		t.Fatalf("stats after rebind %+v", st)
	}
	if s.accounts().Get("sess-1") != nil {
		// 不是账号，仅确认不会 panic
	}
	// 排除粘性账号 → 不解绑，直接池内选号
	s.Cooldown("b", 60, "x")
	if got := s.SelectAccount("m", "sess-1", SelectOpts{ExcludeUids: []string{"b"}}); got != nil {
		t.Fatalf("all cooling want nil got %+v", got)
	}
	if st := s.GetSessionAffinityStats(); st.TotalSessions != 1 {
		t.Fatalf("sticky should be kept when excluded, got %+v", st)
	}
	// 过期清理
	_ = s.store.UpdateConfig(func(cf *config.Config) { v := int64(1000); cf.StickySessionTtlMs = &v })
	base := time.Now()
	s.SetClock(func() time.Time { return base })
	s.CleanExpiredSessions()
	if st := s.GetSessionAffinityStats(); st.TotalSessions != 1 {
		t.Fatalf("not expired yet: %+v", st)
	}
	s.SetClock(func() time.Time { return base.Add(2 * time.Second) })
	if n := s.CleanExpiredSessions(); n != 1 {
		t.Fatalf("cleaned=%d", n)
	}
	if st := s.GetSessionAffinityStats(); st.TotalSessions != 0 || st.IdleTtlMs != 1000 {
		t.Fatalf("after clean %+v", st)
	}
	// 手动清空（先解除冷却以便重新绑定）
	s.accounts().Mutate("a", func(x *config.Account) { x.CooldownUntil = 0 })
	s.SelectAccount("m", "sess-2", SelectOpts{})
	if n := s.ClearSticky(); n != 1 {
		t.Fatalf("clear=%d", n)
	}
}

func TestSelectAccountCooldownExpirySideEffects(t *testing.T) {
	a := acc("a", "a@x.com", config.RegionCn)
	base := time.Now()
	s := newTestScheduler(t, a)
	s.SetClock(func() time.Time { return base })
	// 过期的全局冷却被自动清零
	s.store.Accounts().Mutate("a", func(x *config.Account) { x.CooldownUntil = base.Add(-time.Second).UnixMilli() })
	if got := s.SelectAccount("m", "", SelectOpts{}); got == nil || got.UID != "a" {
		t.Fatalf("want a got %+v", got)
	}
	if s.accounts().Get("a").CooldownUntil != 0 {
		t.Fatalf("expired cooldown not cleared")
	}
	// 过期的模型冷却被删除
	s.store.Accounts().Mutate("a", func(x *config.Account) { x.ModelCooldowns = map[string]int64{"m1": base.Add(-time.Second).UnixMilli()} })
	if got := s.SelectAccount("m1", "", SelectOpts{}); got == nil || got.UID != "a" {
		t.Fatalf("want a got %+v", got)
	}
	if _, ok := s.accounts().Get("a").ModelCooldowns["m1"]; ok {
		t.Fatalf("expired model cooldown not removed")
	}
	// 未过期的模型冷却 → 不可选
	s.CooldownModel("a", "m1", 600, "")
	if got := s.SelectAccount("m1", "", SelectOpts{}); got != nil {
		t.Fatalf("model cooling want nil got %+v", got)
	}
	if got := s.SelectAccount("m2", "", SelectOpts{}); got == nil || got.UID != "a" {
		t.Fatalf("other model want a got %+v", got)
	}
	mc := s.accounts().Get("a")
	if mc.ModelCooldownReasons["m1"] != "上游模型限频冷却" || mc.ModelCooldowns["m1"] != base.Add(600*time.Second).UnixMilli() {
		t.Fatalf("model cooldown %+v", mc)
	}
	// 状态非 healthy 不可选
	s.store.Accounts().Mutate("a", func(x *config.Account) { x.ModelCooldowns = nil; x.Status = "error" })
	if got := s.SelectAccount("m", "", SelectOpts{}); got != nil {
		t.Fatalf("unhealthy want nil got %+v", got)
	}
}

// ─── CurrentActiveAccountInfo ─────────────────────────────────────────────────

func TestCurrentActiveAccountInfo(t *testing.T) {
	s := newTestScheduler(t)
	o := s.CurrentActiveAccountInfo()
	if o.Get("hasAccount") != false || o.Get("modeLabel") != "暂无可用账号" || o.Get("displayName") != "暂无账号" {
		t.Fatalf("empty: %s", o.String())
	}
	a, b := acc("a", "a@x.com", config.RegionCn), acc("b", "b@x.com", config.RegionCn)
	b.Note = "prod"
	s = newTestScheduler(t, a, b)
	o = s.CurrentActiveAccountInfo()
	if o.Get("hasAccount") != true || o.Get("mode") != "pool" || !strings.Contains(o.Get("modeLabel").(string), "(当前就绪)") {
		t.Fatalf("pool: %s", o.String())
	}
	_ = s.store.UpdateConfig(func(cf *config.Config) { cf.PinnedAccount = "b@x.com" })
	o = s.CurrentActiveAccountInfo()
	if o.Get("mode") != "pinned" || o.Get("modeLabel") != "全局指定账号 (服务中)" || o.Get("pinnedAccountName") != "b@x.com [prod]" || o.Get("isPinned") != true {
		t.Fatalf("pinned: %s", o.String())
	}
	s.Cooldown("b", 30, "x")
	o = s.CurrentActiveAccountInfo()
	if o.Get("pinnedRestricted") != true || !strings.Contains(o.Get("modeLabel").(string), "指定账号受限: 全局冷却期") || o.Get("uid") != "a" {
		t.Fatalf("pinned restricted: %s", o.String())
	}
	// 最近执行（取消指定后按最近调度账号展示）
	s.store.Accounts().Mutate("b", func(x *config.Account) { x.CooldownUntil = 0 })
	_ = s.store.UpdateConfig(func(cf *config.Config) { cf.PinnedAccount = "" })
	s.SelectAccount("m", "", SelectOpts{})
	o = s.CurrentActiveAccountInfo()
	// 最小并发平局按积分降序，稳定排序取首个 → a
	if o.Get("uid") != "a" || o.Get("modeLabel") != "账号池轮换 [全量池] (最近执行)" {
		t.Fatalf("last: %s", o.String())
	}
	_ = s.store.UpdateConfig(func(cf *config.Config) { cf.PinnedAccount = "b@x.com" })
	o = s.CurrentActiveAccountInfo()
	if fmt.Sprint(o) != `{"hasAccount":true,"isPinned":true,"pinnedRestricted":false,"restrictedReason":"","pinnedAccountName":"b@x.com [prod]","mode":"pinned","modeLabel":"全局指定账号 (服务中)","uid":"b","name":"b@x.com","note":"prod","displayName":"b@x.com [prod]","creditsRemain":0,"inFlight":0,"status":"healthy","isCooldown":false,"strategy":"least-inflight","routingRegionScope":"all"}` {
		t.Fatalf("full json mismatch: %s", o.String())
	}
}

// ─── 积分刷新 / Token 续期 ───────────────────────────────────────────────────

func TestRefreshCreditsTotalAndReleaseCooldown(t *testing.T) {
	a := acc("a", "a@x.com", config.RegionCn)
	base := time.Now()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Header.Get("Authorization") != "Bearer tok-a" || r.Header.Get("User-Agent") != config.UserAgent {
			t.Errorf("headers: %v", r.Header)
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != "{}" {
			t.Errorf("body %q", body)
		}
		_, _ = w.Write([]byte(`{"code":0,"data":{"TotalCredits":"123.456"}}`))
	}))
	defer srv.Close()
	s := newTestScheduler(t, a)
	s.SetClock(func() time.Time { return base })
	s.redirectEndpoints(srv)
	s.store.Accounts().Mutate("a", func(x *config.Account) { x.CooldownUntil = base.Add(time.Hour).UnixMilli() })
	s.RefreshCredits("a")
	got := s.accounts().Get("a")
	if got.CreditsRemain != 123.46 || got.CreditsUpdatedAt != base.UnixMilli() {
		t.Fatalf("credits %+v", got)
	}
	if got.CooldownUntil != 0 {
		t.Fatalf("cooldown should be released")
	}
	if hits.Load() != 1 {
		t.Fatalf("hits=%d", hits.Load())
	}
	// 非 2xx 静默跳过
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv2.Close()
	s.redirectEndpoints(srv2)
	s.RefreshCredits("a")
	if s.accounts().Get("a").CreditsRemain != 123.46 {
		t.Fatalf("credits changed on non-ok")
	}
}

func TestRefreshCreditsPackagesFallbackAndModelCooldownCleanup(t *testing.T) {
	a := acc("a", "a@x.com", config.RegionCn)
	base := time.Now()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"Packages":[{"CycleRemainCapacity":"1.5"},{"CycleRemainCapacity":2}]}`))
	}))
	defer srv.Close()
	s := newTestScheduler(t, a)
	s.SetClock(func() time.Time { return base })
	s.redirectEndpoints(srv)
	s.store.Accounts().Mutate("a", func(x *config.Account) {
		x.ModelCooldowns = map[string]int64{"old": base.Add(-time.Second).UnixMilli(), "new": base.Add(time.Hour).UnixMilli()}
	})
	s.RefreshCredits("a")
	got := s.accounts().Get("a")
	if got.CreditsRemain != 3.5 {
		t.Fatalf("credits %+v", got)
	}
	if _, ok := got.ModelCooldowns["old"]; ok {
		t.Fatalf("expired model cooldown should be removed")
	}
	if _, ok := got.ModelCooldowns["new"]; !ok {
		t.Fatalf("valid model cooldown should be kept")
	}
	// 无 token 直接返回
	s.accounts().Mutate("a", func(x *config.Account) { x.AccessToken = "" })
	s.RefreshCredits("a")
}

func TestRefreshCreditsWithDatabaseRecordsDelta(t *testing.T) {
	a := acc("a", "a@x.com", config.RegionCn)
	a.Note = "team"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"TotalCredits":100}}`))
	}))
	defer srv.Close()
	s := newTestScheduler(t, a)
	s.redirectEndpoints(srv)
	// 首次刷新：0 → 100，记录变动
	s.RefreshCredits("a")
	if s.db != nil {
		t.Fatal("db should be nil in test scheduler")
	}
	// 用真实 db 验证记录
	db := database.Open(filepath.Join(t.TempDir(), "logs.db"), func() int { return 30 })
	t.Cleanup(func() { _ = db.Close() })
	s.db = db
	s.RefreshCredits("a") // 100 → 100 不记录
	rows := db.QueryCreditHistory(database.CreditQuery{Range: "7d", Limit: 50}).Records
	if len(rows) != 0 {
		t.Fatalf("no change should not record: %+v", rows)
	}
	s.accounts().Mutate("a", func(x *config.Account) { x.CreditsRemain = 90 })
	s.RefreshCredits("a")
	rows = db.QueryCreditHistory(database.CreditQuery{Range: "7d", Limit: 50}).Records
	if len(rows) != 1 || rows[0].Delta != 10 || rows[0].Balance != 100 || rows[0].AccountName != "team" || rows[0].Description != "余额 90 → 100" {
		t.Fatalf("rows %+v", rows)
	}
}

func TestRefreshSessionToken(t *testing.T) {
	a := acc("a", "a@x.com", config.RegionCn)
	a.RefreshToken = "rt-old"
	base := time.Now()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Refresh-Token") != "rt-old" || r.Header.Get("X-Auth-Refresh-Source") != "plugin" {
			t.Errorf("headers %v", r.Header)
		}
		_, _ = w.Write([]byte(`{"data":{"access_token":"NA","refresh_token":"NR","expires_in":3600}}`))
	}))
	defer srv.Close()
	s := newTestScheduler(t, a)
	s.SetClock(func() time.Time { return base })
	s.redirectEndpoints(srv)
	res := s.RefreshSessionToken("a")
	if !res.OK || res.ExpiresAt != base.UnixMilli()+3600*1000 || res.ExpiresIn != 3600 || !strings.HasPrefix(res.Msg, "新令牌换发成功，有效期至 ") {
		t.Fatalf("res %+v", res)
	}
	got := s.accounts().Get("a")
	if got.AccessToken != "NA" || got.RefreshToken != "NR" || got.ExpiresAt != base.UnixMilli()+3600*1000 || got.Status != "healthy" {
		t.Fatalf("acc %+v", got)
	}
	// 非 2xx
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`denied`))
	}))
	defer srv2.Close()
	s.redirectEndpoints(srv2)
	res = s.RefreshSessionToken("a")
	if res.OK || res.Msg != "上游返回 HTTP 401: denied" {
		t.Fatalf("res %+v", res)
	}
	// 缺少 refreshToken
	s.accounts().Mutate("a", func(x *config.Account) { x.RefreshToken = "" })
	if res = s.RefreshSessionToken("a"); res.OK || res.Msg != "该账号缺少 refreshToken，需重新扫码授权" {
		t.Fatalf("res %+v", res)
	}
}

func TestRefreshCreditsTriggersTokenRenewal(t *testing.T) {
	a := acc("a", "a@x.com", config.RegionCn)
	a.RefreshToken = "rt"
	base := time.Now()
	a.ExpiresAt = base.Add(24 * time.Hour).UnixMilli() // 1 天后过期 < 提前 7 天
	var summaryAuth atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/auth/refresh":
			_, _ = w.Write([]byte(`{"access_token":"NEW"}`))
		case "/summary":
			summaryAuth.Store(r.Header.Get("Authorization"))
			_, _ = w.Write([]byte(`{"data":{"TotalCredits":5}}`))
		}
	}))
	defer srv.Close()
	s := newTestScheduler(t, a)
	s.SetClock(func() time.Time { return base })
	s.redirectEndpoints(srv)
	s.RefreshCredits("a")
	if summaryAuth.Load() != "Bearer NEW" {
		t.Fatalf("summary should use renewed token, got %v", summaryAuth.Load())
	}
	if s.accounts().Get("a").ExpiresAt != base.UnixMilli()+2592000*1000 {
		t.Fatalf("default expires_in should be 30d")
	}
}

// ─── 闲置感知 / 按需刷新 ──────────────────────────────────────────────────────

func TestRecordApiUsageAndIdleAwareRefresh(t *testing.T) {
	old := postCallRefreshDelay
	postCallRefreshDelay = 10 * time.Millisecond
	t.Cleanup(func() { postCallRefreshDelay = old })
	a, b := acc("a", "a@x.com", config.RegionCn), acc("b", "b@x.com", config.RegionCn)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"data":{"TotalCredits":1}}`))
	}))
	defer srv.Close()
	s := newTestScheduler(t, a, b)
	s.redirectEndpoints(srv)
	if !s.IsGatewayIdle(0) || s.LastApiCallTime() != 0 {
		t.Fatal("fresh gateway should be idle")
	}
	s.RecordApiUsage("a")
	if s.IsGatewayIdle(0) {
		t.Fatal("should not be idle after api usage")
	}
	got := s.accounts().Get("a")
	if got.LastUsedAt != s.LastApiCallTime() || !got.NeedsCreditRefresh {
		t.Fatalf("acc after usage %+v", got)
	}
	waitFor(t, 2*time.Second, func() bool { return hits.Load() == 1 && !s.accounts().Get("a").NeedsCreditRefresh })
	// 闲置感知：b 无变化 → no-active-changes
	s.accounts().Mutate("a", func(x *config.Account) { x.NeedsCreditRefresh = false; x.LastUsedAt = 0 })
	r := s.RefreshActiveAccountsIfStale()
	if r.Refreshed != 0 || r.Reason != "no-active-changes" || r.Skipped != 2 {
		t.Fatalf("r %+v", r)
	}
	// 标记后 → 刷新 1 个
	s.accounts().Mutate("a", func(x *config.Account) { x.NeedsCreditRefresh = true })
	before := hits.Load()
	r = s.RefreshActiveAccountsIfStale()
	if r.Refreshed != 1 || r.Total != 1 {
		t.Fatalf("r %+v", r)
	}
	waitFor(t, 2*time.Second, func() bool { return hits.Load() == before+1 })
	waitFor(t, 2*time.Second, func() bool { return !s.accounts().Get("a").NeedsCreditRefresh })
	// 闲置时整体跳过
	s.lastApiAt.Store(time.Now().Add(-time.Hour).UnixMilli())
	r = s.RefreshActiveAccountsIfStale()
	if !r.SkippedAll || r.Reason != "idle" {
		t.Fatalf("r %+v", r)
	}
}

func TestRefreshStaleCredits(t *testing.T) {
	a, b := acc("a", "a@x.com", config.RegionCn), acc("b", "b@x.com", config.RegionCn)
	b.AccessToken = ""
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"data":{"TotalCredits":1}}`))
	}))
	defer srv.Close()
	s := newTestScheduler(t, a, b)
	s.redirectEndpoints(srv)
	r := s.RefreshStaleCredits(30000, false)
	if r.Refreshed != 1 || r.Skipped != 1 || hits.Load() != 1 {
		t.Fatalf("r %+v hits %d", r, hits.Load())
	}
	// 刚刷新过 → 跳过
	r = s.RefreshStaleCredits(30000, false)
	if r.Refreshed != 0 || r.Skipped != 2 || hits.Load() != 1 {
		t.Fatalf("r %+v hits %d", r, hits.Load())
	}
	// force → 刷新
	r = s.RefreshStaleCredits(30000, true)
	if r.Refreshed != 1 || r.Skipped != 1 || hits.Load() != 2 {
		t.Fatalf("r %+v hits %d", r, hits.Load())
	}
}

// ─── 签到 ─────────────────────────────────────────────────────────────────────

func TestDailyCheckinCn(t *testing.T) {
	a := acc("a", "a@x.com", config.RegionCn)
	var hits atomic.Int32
	msg := `{"code":0,"msg":"ok"}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/checkin" {
			// refreshCredits 的 summary 请求：返回非 JSON 不影响签到结果
			_, _ = w.Write([]byte(`<html>`))
			return
		}
		hits.Add(1)
		if r.Header.Get("Authorization") != "Bearer tok-a" {
			t.Errorf("auth")
		}
		_, _ = w.Write([]byte(msg))
	}))
	defer srv.Close()
	s := newTestScheduler(t, a)
	s.redirectEndpoints(srv)
	// summary 也打到同服务器（refreshCredits）；非 JSON 不影响
	res := s.DailyCheckin("a", false)
	if !res.Success || res.Msg != "签到成功，已领积分" || res.AlreadyCheckedIn {
		t.Fatalf("res %+v", res)
	}
	got := s.accounts().Get("a")
	if got.LastCheckinDate != config.TodayStringAt(time.Now()) || !got.LastCheckinSuccess || got.LastCheckinMsg != "签到成功，已领积分" || got.LastCheckinTime == "" {
		t.Fatalf("acc %+v", got)
	}
	// 再次调用（非 force）→ 直接返回已签到，不再请求上游
	hits.Store(0)
	res = s.DailyCheckin("a", false)
	if !res.Success || !res.AlreadyCheckedIn || hits.Load() != 0 {
		t.Fatalf("res %+v hits %d", res, hits.Load())
	}
	// force → 再请求；上游返回“已签到”
	msg = `{"code":1,"msg":"今天已签到，明天再来"}`
	res = s.DailyCheckin("a", true)
	if !res.Success || !res.AlreadyCheckedIn && res.Msg != "今天已签到，请明天再来" {
		t.Fatalf("res %+v", res)
	}
	if s.accounts().Get("a").LastCheckinMsg != "今天已签到，请明天再来" {
		t.Fatalf("acc %+v", s.accounts().Get("a"))
	}
	// 企业账号
	msg = `{"code":1,"msg":"企业账号不支持签到"}`
	res = s.DailyCheckin("a", true)
	if res.Success || res.Msg != "企业账号不支持签到" {
		t.Fatalf("res %+v", res)
	}
	// 其它失败 → 原样返回上游 msg
	msg = `{"code":1,"msg":"boom"}`
	res = s.DailyCheckin("a", true)
	if res.Success || res.Msg != "boom" {
		t.Fatalf("res %+v", res)
	}
	// 空消息 → 签到失败
	msg = `{"code":1}`
	res = s.DailyCheckin("a", true)
	if res.Success || res.Msg != "签到失败" {
		t.Fatalf("res %+v", res)
	}
	// 非 JSON → 网络错误
	msg = `<html>`
	res = s.DailyCheckin("a", true)
	if res.Success || !strings.HasPrefix(res.Msg, "网络错误: ") {
		t.Fatalf("res %+v", res)
	}
	// restricted 跳过
	s.accounts().Mutate("a", func(x *config.Account) { x.Status = "restricted" })
	res = s.DailyCheckin("a", true)
	if res.Success || !strings.Contains(res.Msg, "风控限制") {
		t.Fatalf("res %+v", res)
	}
	// 无 token
	s.accounts().Mutate("a", func(x *config.Account) { x.Status = "healthy"; x.AccessToken = "" })
	res = s.DailyCheckin("a", true)
	if res.Success || res.Msg != "无有效 Token" {
		t.Fatalf("res %+v", res)
	}
}

func TestDailyCheckinIntl(t *testing.T) {
	a := acc("a", "a@x.com", config.RegionIntl)
	var upstreamBody []byte
	var upstreamHeaders http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/upstream":
			upstreamHeaders = r.Header.Clone()
			upstreamBody, _ = io.ReadAll(r.Body)
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n"))
			_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\" there\"}}]}\n\n"))
			_, _ = w.Write([]byte("data: [DONE]\n\n"))
		case "/summary":
			_, _ = w.Write([]byte(`{"data":{"TotalCredits":1}}`))
		}
	}))
	defer srv.Close()
	s := newTestScheduler(t, a)
	s.redirectEndpoints(srv)
	res := s.DailyCheckin("a", false)
	if !res.Success || res.Msg != "活跃对话完成，已激活当日奖励" {
		t.Fatalf("res %+v", res)
	}
	// 请求体结构
	body, _ := upstream.ParseObj(upstreamBody)
	if upstream.GetString(body, "model") != "deepseek-v4.1-flash" || body.Get("stream") != true || body.Get("temperature") != json.Number("1") {
		t.Fatalf("body %s", body.String())
	}
	if keys := strings.Join(body.Keys(), ","); keys != "model,messages,stream,temperature,stream_options,extra_vars" {
		t.Fatalf("keys %s", keys)
	}
	msgs := upstream.GetArr(body, "messages")
	if len(msgs) != 2 {
		t.Fatalf("messages %v", msgs)
	}
	if upstream.GetString(msgs[0].(*upstream.Obj), "role") != "system" || upstream.GetString(msgs[1].(*upstream.Obj), "role") != "user" {
		t.Fatalf("roles %v", msgs)
	}
	if upstreamHeaders.Get("Content-Encoding") != "gzip" && len(upstreamBody) < 2048 {
		// 短请求体不压缩
	}
	if !strings.HasPrefix(upstreamHeaders.Get("X-Session-Id"), "checkin-") && !strings.HasPrefix(upstreamHeaders.Get("X-Conversation-Id"), "checkin-") {
		// sessionKey 由 BuildOfficialUpstreamHeaders 决定落点，此处仅记录
	}
	got := s.accounts().Get("a")
	if !got.LastCheckinSuccess || got.LastCheckinMsg != "活跃对话完成，已激活当日奖励" {
		t.Fatalf("acc %+v", got)
	}
	// 非强制再次调用 → 已打卡
	res = s.DailyCheckin("a", false)
	if !res.Success || !res.AlreadyCheckedIn {
		t.Fatalf("res %+v", res)
	}

	// 403 风控 → restricted
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"code":11140,"msg":"abnormal behavior"}`))
	}))
	defer srv2.Close()
	s.redirectEndpoints(srv2)
	res = s.DailyCheckin("a", true)
	if res.Success || res.Msg != "上游风控受限 (11140): abnormal behavior" {
		t.Fatalf("res %+v", res)
	}
	got = s.accounts().Get("a")
	if got.Status != "restricted" || got.RestrictedReason != "abnormal behavior" || got.RestrictedAt == 0 || got.LastCheckinMsg != res.Msg {
		t.Fatalf("acc %+v", got)
	}
	// 其它 HTTP 错误
	srv3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"code":500,"msg":"server error"}`))
	}))
	defer srv3.Close()
	s.redirectEndpoints(srv3)
	s.accounts().Mutate("a", func(x *config.Account) { x.Status = "healthy" })
	res = s.DailyCheckin("a", true)
	if res.Success || res.Msg != "对话打卡失败 (HTTP 500)" || s.accounts().Get("a").Status != "healthy" {
		t.Fatalf("res %+v acc %+v", res, s.accounts().Get("a"))
	}
}

func TestGenerateDynamicCheckinDialogue(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 300; i++ {
		p, temp := GenerateDynamicCheckinDialogue()
		if temp != 1 || p == "" {
			t.Fatalf("bad dialogue %q %v", p, temp)
		}
		seen[p] = true
	}
	if len(seen) < 10 {
		t.Fatalf("expected variety, got %d", len(seen))
	}
	if len(IntlCheckinPrompts) != 4 {
		t.Fatal("legacy prompts")
	}
}

func TestCheckAndRunHourlyCheckin(t *testing.T) {
	a, b := acc("a", "a@x.com", config.RegionCn), acc("b", "b@x.com", config.RegionCn)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"code":0,"msg":"ok"}`))
	}))
	defer srv.Close()
	s := newTestScheduler(t, a, b)
	s.redirectEndpoints(srv)
	checked, skipped := s.CheckAndRunHourlyCheckin(false)
	if checked != 2 || skipped != 0 {
		t.Fatalf("checked=%d skipped=%d", checked, skipped)
	}
	checked, skipped = s.CheckAndRunHourlyCheckin(false)
	if checked != 0 || skipped != 2 {
		t.Fatalf("second: checked=%d skipped=%d", checked, skipped)
	}
	// 不健康账号跳过
	s.accounts().Mutate("a", func(x *config.Account) { x.Status = "error"; x.LastCheckinDate = "" })
	checked, skipped = s.CheckAndRunHourlyCheckin(false)
	if checked != 0 || skipped != 1 {
		t.Fatalf("third: checked=%d skipped=%d", checked, skipped)
	}
}

// ─── 积分明细 / 消耗流水 ─────────────────────────────────────────────────────

func TestGetAccountCreditDetails(t *testing.T) {
	a := acc("a", "a@x.com", config.RegionCn)
	var freeBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/summary":
			_, _ = w.Write([]byte(`{"data":{"TotalCredits":99}}`))
		case "/billing/meter/get-user-resource-free-packages":
			freeBody, _ = io.ReadAll(r.Body)
			_, _ = w.Write([]byte(`{"data":{"Accounts":[
				{"ResourceId":"r1","PackageCode":"TCACA_code_008_cfWoLwvjU4","PackageName":"基础版","Status":0,"CycleCapacityRemainPrecise":"10.5","CycleCapacityUsedPrecise":"2","CycleCapacitySizePrecise":"12.5","AccountAttributes":[{"Key":"grantReason","Value":"monthly"},{"Key":"grantSource","Value":"web"}],"CycleStartTime":"2026-01-01","ExpiredTime":""},
				{"ResourceId":"r2","PackageCode":"TCACA_code_002_AkiJS3ZHF5","PackageName":"奖励包","Status":0,"CycleCapacityRemainPrecise":5,"CycleCapacityUsedPrecise":"0","CycleCapacitySizePrecise":"5"},
				{"ResourceId":"r3","PackageCode":"TCACA_code_x_extra","PackageName":"加量包","Status":0,"CycleCapacityRemainPrecise":3,"CycleCapacityUsedPrecise":"1","CycleCapacitySizePrecise":"4"}
			]}}`))
		case "/billing/meter/get-user-resource-paid-packages":
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer srv.Close()
	s := newTestScheduler(t, a)
	s.redirectEndpoints(srv)
	o := s.GetAccountCreditDetails(s.accounts().Get("a"))
	if o.Has("error") {
		t.Fatalf("error %s", o.String())
	}
	// 请求体字段顺序与取值
	fb, _ := upstream.ParseObj(freeBody)
	if fb.String() != `{"PageNumber":1,"PageSize":200,"Status":[0,2,3],"PackageCodes":[`+strings.Join(quoteAll(allPackageCodes), ",")+`]}` {
		t.Fatalf("free body %s", fb.String())
	}
	if o.Get("totalCredits") != json.Number("99") {
		t.Fatalf("total %s", o.String())
	}
	bd := upstream.GetObj(o, "breakdown")
	if bd.Get("baseCredits") != json.Number("10.5") || bd.Get("rewardCredits") != json.Number("5") || bd.Get("paidCredits") != json.Number("3") {
		t.Fatalf("breakdown %s", bd.String())
	}
	iu := upstream.GetObj(o, "inUsagePackage")
	if iu.Get("id") != "r1" || iu.Get("grantReason") != "monthly" || iu.Get("percent") != json.Number("16") || iu.Get("remain") != json.Number("10.5") {
		t.Fatalf("inUsage %s", iu.String())
	}
	if o.Get("activePackagesCount") != json.Number("3") || o.Get("usedUpPackagesCount") != json.Number("0") || o.Get("totalPackagesCount") != json.Number("3") {
		t.Fatalf("counts %s", o.String())
	}
	list := upstream.GetArr(o, "packagesList")
	if len(list) != 3 {
		t.Fatalf("list %v", list)
	}
	p0 := list[0].(*upstream.Obj)
	if p0.Get("grantSource") != "web" || p0.Get("startTime") != "2026-01-01" || p0.Get("expireTime") != "随月度周期重置" || p0.Get("total") != json.Number("12.5") {
		t.Fatalf("p0 %s", p0.String())
	}
	p1 := list[1].(*upstream.Obj)
	if p1.Get("grantReason") != "奖励包" || p1.Get("grantSource") != "-" || p1.Get("startTime") != "-" || p1.Get("total") != json.Number("5") || p1.Get("remain") != json.Number("5") {
		t.Fatalf("p1 %s", p1.String())
	}
	// 无 token
	if e := s.GetAccountCreditDetails(&config.Account{}); e.Get("error") != "No active token" {
		t.Fatalf("expected error, got %s", e.String())
	}
}

func quoteAll(xs []string) []string {
	out := make([]string, 0, len(xs))
	for _, x := range xs {
		out = append(out, `"`+x+`"`)
	}
	return out
}

func TestGetAccountUsageRecords(t *testing.T) {
	a := acc("a", "a@x.com", config.RegionCn)
	a.EnterpriseID = " ent-1 "
	var gotBody []byte
	var gotHeaders http.Header
	var reply = `{"code":0,"data":{"total":1,"data":[{"requestId":"r1","credit":"0.5","model":"gpt","client":"cli","requestTime":"2026-11-01 10:00:00","input":"full prompt","inputTrunc":"trunc","agentPurpose":"chat","appType":"cb","subscribeType":"pro"}]}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		gotHeaders = r.Header.Clone()
		_, _ = w.Write([]byte(reply))
	}))
	defer srv.Close()
	s := newTestScheduler(t, a)
	s.redirectEndpoints(srv)
	o := s.GetAccountUsageRecords(s.accounts().Get("a"), UsageRecordOptions{})
	if o.Get("ok") != true {
		t.Fatalf("o %s", o.String())
	}
	if gotHeaders.Get("X-Enterprise-Id") != "ent-1" || gotHeaders.Get("Accept") != "application/json" {
		t.Fatalf("headers %v", gotHeaders)
	}
	body, _ := upstream.ParseObj(gotBody)
	now := time.Now()
	from := now.Add(-6 * 24 * time.Hour).Format("2006-01-02")
	if body.String() != fmt.Sprintf(`{"startTime":"%s 00:00:00","endTime":"%s 23:59:59","pageNum":1,"pageSize":20}`, from, now.Format("2006-01-02")) {
		t.Fatalf("body %s", body.String())
	}
	recs := upstream.GetArr(o, "records")
	if len(recs) != 1 {
		t.Fatalf("records %v", recs)
	}
	r0 := recs[0].(*upstream.Obj)
	if r0.Get("credit") != json.Number("0.5") || r0.Get("time") != "2026-11-01 10:00:00" || r0.Get("inputFull") != "full prompt" || r0.Get("inputTrunc") != "trunc" {
		t.Fatalf("r0 %s", r0.String())
	}
	if o.Get("pageCredit") != json.Number("0.5") || o.Get("total") != json.Number("1") || upstream.GetObj(o, "range").Get("days") != json.Number("7") {
		t.Fatalf("o %s", o.String())
	}
	// 边界夹取
	o = s.GetAccountUsageRecords(s.accounts().Get("a"), UsageRecordOptions{Days: f64p(100), PageSize: f64p(500), PageNum: f64p(0)})
	body, _ = upstream.ParseObj(gotBody)
	if body.Get("pageNum") != json.Number("1") || body.Get("pageSize") != json.Number("200") || upstream.GetObj(o, "range").Get("days") != json.Number("90") {
		t.Fatalf("clamped body %s / %s", body.String(), o.String())
	}
	// 非 JSON
	reply = `<html>`
	o = s.GetAccountUsageRecords(s.accounts().Get("a"), UsageRecordOptions{})
	if o.Get("ok") != false || o.Get("error") != "返回非 JSON (HTTP 200)" || len(upstream.GetArr(o, "records")) != 0 || o.Get("total") != json.Number("0") {
		t.Fatalf("o %s", o.String())
	}
	// code != 0
	reply = `{"code":500,"msg":"denied"}`
	o = s.GetAccountUsageRecords(s.accounts().Get("a"), UsageRecordOptions{})
	if o.Get("ok") != false || o.Get("error") != "denied" {
		t.Fatalf("o %s", o.String())
	}
	// 缺 inputTrunc 回落 input；data 为数组
	reply = `{"code":0,"data":[{"requestId":"r2","credit":2,"input":"x"}]}`
	o = s.GetAccountUsageRecords(s.accounts().Get("a"), UsageRecordOptions{})
	recs = upstream.GetArr(o, "records")
	if len(recs) != 1 || recs[0].(*upstream.Obj).Get("inputTrunc") != "x" || o.Get("total") != json.Number("1") {
		t.Fatalf("o %s", o.String())
	}
}

func f64p(v float64) *float64 { return &v }

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

func TestHelpers(t *testing.T) {
	cases := map[float64]string{0: "0", 1234.5: "1,234.5", 1234567.891: "1,234,567.89", -5.5: "-5.5", 100: "100", 0.1: "0.1"}
	for in, want := range cases {
		if got := formatEnUS(in); got != want {
			t.Errorf("formatEnUS(%v)=%s want %s", in, got, want)
		}
	}
	// 与 Node 实测一致：Math.round(v*100)/100
	if round2(2.345) != 2.35 || round2(-1.235) != -1.24 || round2(1.125) != 1.13 || round2(1.115) != 1.12 || round2(0.145) != 0.14 || round2(-0.5) != -0.5 {
		t.Fatalf("round2")
	}
	if num(100) != "100" || num(0.1) != "0.1" || num(1e21) != "1e+21" {
		t.Fatalf("num")
	}
	if jsSlice("你好世界", 3) != "你好世" || jsSlice("abc", 5) != "abc" || jsSlice("a😀b", 3) != "a😀" {
		t.Fatalf("jsSlice")
	}
	if ceilDivMs(1001) != 2 || ceilDivMs(0) != 0 || ceilDivMs(-5) != 0 {
		t.Fatalf("ceilDivMs")
	}
}

func TestStopCancelsPendingTimers(t *testing.T) {
	old := postCallRefreshDelay
	postCallRefreshDelay = 50 * time.Millisecond
	t.Cleanup(func() { postCallRefreshDelay = old })
	a := acc("a", "a@x.com", config.RegionCn)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer srv.Close()
	s := newTestScheduler(t, a)
	s.redirectEndpoints(srv)
	s.RecordApiUsage("a")
	s.Stop()
	time.Sleep(100 * time.Millisecond)
	if hits.Load() != 0 {
		t.Fatalf("timer fired after Stop: %d", hits.Load())
	}
	// Stop 幂等
	s.Stop()
	_ = context.Background()
}
