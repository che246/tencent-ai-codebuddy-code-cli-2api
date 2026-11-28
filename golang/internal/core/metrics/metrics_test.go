package metrics

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/pricing"
)

func fixedClock(y int, m time.Month, d int) func() time.Time {
	return func() time.Time { return time.Date(y, m, d, 12, 0, 0, 0, time.Local) }
}

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(dir, "gateway.log")
	s := New(config.PathsFor(dir), logPath)
	s.SetClock(fixedClock(2026, 11, 29))
	return s
}

func TestRecordApiCallPersists(t *testing.T) {
	s := newTestStore(t)
	st := s.Load(false)
	if st.Summary.TotalRequests != 0 || st.Daily.Len() != 1 {
		t.Fatalf("initial %+v", st)
	}
	if _, ok := st.Daily.Get("2026-11-29"); !ok {
		t.Fatalf("initial daily keys %v", st.Daily.Keys())
	}
	if err := s.RecordApiCall(Call{AccountUID: "u1", AccountName: "A", Model: "m1", IsSuccess: true, InputTokens: 100, OutputTokens: 50, CachedTokens: 10}); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordApiCall(Call{AccountUID: "u1", AccountName: "A2", Model: "m2", IsSuccess: false, InputTokens: 7, OutputTokens: 3}); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordApiCall(Call{}); err != nil { // model 默认 unknown，无账号
		t.Fatal(err)
	}
	st = s.Load(false)
	if st.Summary.TotalRequests != 3 || st.Summary.SuccessRequests != 1 || st.Summary.FailedRequests != 2 ||
		st.Summary.TotalInputTokens != 107 || st.Summary.TotalOutputTokens != 53 || st.Summary.TotalCachedTokens != 10 || st.Summary.TotalTokens != 160 {
		t.Fatalf("summary %+v", st.Summary)
	}
	m1, _ := st.Models.Get("m1")
	if m1 == nil || m1.Name != "m1" || m1.Requests != 1 || m1.SuccessRequests != 1 || m1.InputTokens != 100 || m1.OutputTokens != 50 || m1.CachedTokens != 10 || m1.TotalTokens != 150 {
		t.Fatalf("m1 %+v", m1)
	}
	if strings.Join(st.Models.Keys(), ",") != "m1,m2,unknown" {
		t.Fatalf("models order %v", st.Models.Keys())
	}
	a1, _ := st.Accounts.Get("u1")
	if a1 == nil || a1.Name != "A2" || a1.Requests != 2 || a1.SuccessRequests != 1 || a1.TotalTokens != 160 {
		t.Fatalf("a1 %+v", a1)
	}
	if st.Accounts.Len() != 1 {
		t.Fatalf("accounts %v", st.Accounts.Keys())
	}
	d, _ := st.Daily.Get("2026-11-29")
	// 与 Node 一致：按日统计不累加 failedRequests
	if d.Requests != 3 || d.SuccessRequests != 1 || d.FailedRequests != 0 || d.InputTokens != 107 || d.OutputTokens != 53 || d.CachedTokens != 10 || d.TotalTokens != 160 {
		t.Fatalf("daily %+v", d)
	}
	dm, _ := d.Models.Get("m2")
	if dm == nil || dm.Requests != 1 || dm.SuccessRequests != 0 || dm.TotalTokens != 10 {
		t.Fatalf("dm %+v", dm)
	}
	da, _ := d.Accounts.Get("u1")
	// 与 Node 一致：按日账号名只在首次创建时写入（summary 级账号名才会被后续调用覆盖）
	if da == nil || da.Requests != 2 || da.Name != "A" {
		t.Fatalf("da %+v", da)
	}
	// 落盘并 reload
	raw, err := os.ReadFile(s.paths.StatsPath)
	if err != nil {
		t.Fatal(err)
	}
	// Node saveStats → writeJsonWithBackup → JSON.stringify(stats, null, 2)：2 空格缩进、键序固定
	want := "{\n  \"summary\": {\n    \"totalRequests\": 3,\n    \"successRequests\": 1,\n    \"failedRequests\": 2,\n    \"totalInputTokens\": 107,\n    \"totalOutputTokens\": 53,\n    \"totalCachedTokens\": 10,\n    \"totalTokens\": 160\n  },\n  \"models\": {\n    \"m1\": {\n      \"name\": \"m1\",\n      \"requests\": 1,\n      \"successRequests\": 1,\n      \"inputTokens\": 100,\n      \"outputTokens\": 50,\n      \"cachedTokens\": 10,\n      \"totalTokens\": 150\n    },"
	if !strings.HasPrefix(string(raw), want) {
		t.Fatalf("stats.json %s", raw)
	}
	s2 := New(s.paths, "")
	s2.SetClock(fixedClock(2026, 11, 29))
	st2 := s2.Load(false)
	if st2.Summary.TotalRequests != 3 || st2.Models.Len() != 3 {
		t.Fatalf("reload %+v", st2)
	}
	if dm, _ := st2.Daily.Get("2026-11-29"); dm == nil || dm.Models == nil || dm.Models.Len() != 3 {
		t.Fatalf("reload daily %+v", dm)
	}
	// 强制重载
	if st3 := s2.Load(true); st3 == st2 || st3.Summary.TotalRequests != 3 {
		t.Fatalf("force reload %+v", st3)
	}
}

func TestLoadRecoversFromBackup(t *testing.T) {
	s := newTestStore(t)
	_ = s.RecordApiCall(Call{Model: "m", InputTokens: 1, OutputTokens: 1})
	// 破坏主文件 → 从 backups 恢复
	if err := os.WriteFile(s.paths.StatsPath, []byte("{broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	s2 := New(s.paths, "")
	s2.SetClock(fixedClock(2026, 11, 29))
	st := s2.Load(false)
	if st.Summary.TotalRequests != 1 {
		t.Fatalf("expected recovery, got %+v", st.Summary)
	}
	// legacy .bak 恢复后被清理
	s3 := newTestStore(t)
	_ = s3.RecordApiCall(Call{Model: "m", InputTokens: 5})
	legacy := s3.paths.StatsPath + ".bak"
	if err := copyFile(legacy, s3.paths.StatsPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s3.paths.StatsPath, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(config.BackupPath(s3.paths, s3.paths.StatsPath)); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	s4 := New(s3.paths, "")
	s4.SetClock(fixedClock(2026, 11, 29))
	st4 := s4.Load(false)
	if st4.Summary.TotalInputTokens != 5 {
		t.Fatalf("legacy recovery %+v", st4.Summary)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy bak should be removed")
	}
	// 无效 summary → 忽略文件
	s5 := newTestStore(t)
	if err := os.WriteFile(s5.paths.StatsPath, []byte(`{"summary":{"x":1},"models":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	st5 := s5.Load(false)
	if st5.Summary.TotalRequests != 0 {
		t.Fatalf("invalid file should be ignored %+v", st5)
	}
}

func TestInitialFromLog(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "gateway.log")
	logText := strings.Join([]string{
		`[2026-11-28 10:00:00] [INFO ] [DISPATCH] 调度选中账号 [a@x.com (u1)] (策略: least-inflight, 并发: 0, 剩余积分: 0) | {"model":"gpt-5"}`,
		`[2026-11-28 10:00:01] [INFO ] [CHAT] 收到 OpenAI 对话请求 [gpt-5] (流式: true) | {"messagesCount":4}`,
		`[2026-11-28 10:00:02] [INFO ] [CHAT] 流式输出完成 [gpt-5] 耗时 3000ms (账号: [a@x.com], 缓存命中: 120 tok, 是否含工具调用: false)`,
		`[2026-11-28 10:00:03] [INFO ] [DISPATCH] 粘性会话复用账号 [b@x.com (u2)] (会话: abc, 剩余保活: 60s) | {"sessionKey":"abc","model":"gpt-5"}`,
		`[2026-11-28 10:00:04] [INFO ] [ANTHROPIC] 收到 Claude Code 协议请求 [claude-x] (流式: true) | {"messagesCount":2}`,
		`[2026-11-28 10:00:05] [ERROR] [CHAT] 处理对话请求异常: boom`,
		`[2026-11-29 09:00:00] [INFO ] [CHAT] 收到 OpenAI 对话请求 [gpt-5] (流式: false) | {"messagesCount":1}`,
		`[2026-11-29 09:00:05] [INFO ] [CHAT] 非流式回复完成 [gpt-5] 耗时 100ms (账号: [a@x.com], 缓存命中: 0 tok, 结束原因: stop)`,
		"",
	}, "\n")
	if err := os.WriteFile(logPath, []byte(logText), 0o644); err != nil {
		t.Fatal(err)
	}
	st := RebuildRealStatsFromLog(logPath)
	if st.Summary.TotalRequests != 3 || st.Summary.SuccessRequests != 2 || st.Summary.FailedRequests != 1 {
		t.Fatalf("summary %+v", st.Summary)
	}
	// 4*150=600 + 2*150=300 + max(20,150)=150 → 1050；输出 round(3000/15)=200 + max(15, round(100/15)=7)=15 → 215
	if st.Summary.TotalInputTokens != 1050 || st.Summary.TotalOutputTokens != 215 || st.Summary.TotalCachedTokens != 120 || st.Summary.TotalTokens != 1265 {
		t.Fatalf("tokens %+v", st.Summary)
	}
	if strings.Join(st.Daily.Keys(), ",") != "2026-11-28,2026-11-29" {
		t.Fatalf("daily keys %v", st.Daily.Keys())
	}
	d28, _ := st.Daily.Get("2026-11-28")
	if d28.Requests != 2 || d28.FailedRequests != 1 || d28.OutputTokens != 200 {
		t.Fatalf("d28 %+v", d28)
	}
	// 账号：u1 (a@x.com) 收到 1 次请求 + 1 次完成；u2 (b@x.com) 收到 1 次
	if strings.Join(st.Accounts.Keys(), ",") != "u1,u2" {
		t.Fatalf("accounts %v", st.Accounts.Keys())
	}
	a1, _ := st.Accounts.Get("u1")
	if a1.Name != "a@x.com" || a1.Requests != 1 || a1.SuccessRequests != 2 || a1.OutputTokens != 215 || a1.CachedTokens != 120 {
		t.Fatalf("a1 %+v", a1)
	}
	// u2 在粘性复用后成为"当前账号"，其后的 Claude 请求与次日请求均归到 u2
	a2, _ := st.Accounts.Get("u2")
	if a2.Requests != 2 || a2.SuccessRequests != 0 || a2.InputTokens != 450 {
		t.Fatalf("a2 %+v", a2)
	}
	m, _ := st.Models.Get("gpt-5")
	if m.Requests != 2 || m.SuccessRequests != 2 || m.InputTokens != 750 || m.OutputTokens != 215 {
		t.Fatalf("gpt-5 %+v", m)
	}
	mc, _ := st.Models.Get("claude-x")
	if mc.Requests != 1 || mc.SuccessRequests != 0 || mc.TotalTokens != 300 {
		t.Fatalf("claude %+v", mc)
	}
	// Store 初始化时采用日志重构
	s := New(config.PathsFor(dir), logPath)
	s.SetClock(fixedClock(2026, 11, 29))
	if got := s.Load(false); got.Summary.TotalRequests != 3 {
		t.Fatalf("store init %+v", got.Summary)
	}
	// 文件不存在 → nil
	if RebuildRealStatsFromLog(filepath.Join(dir, "nope.log")) != nil {
		t.Fatal("expected nil")
	}
}

func TestPruneByTime(t *testing.T) {
	s := newTestStore(t)
	// 构造 3 天数据
	s.SetClock(fixedClock(2026, 11, 27))
	_ = s.RecordApiCall(Call{AccountUID: "u1", Model: "m1", InputTokens: 10, OutputTokens: 5})
	s.SetClock(fixedClock(2026, 11, 28))
	_ = s.RecordApiCall(Call{AccountUID: "u1", Model: "m1", IsSuccess: false, InputTokens: 20})
	_ = s.RecordApiCall(Call{AccountUID: "u2", Model: "m2", InputTokens: 30, CachedTokens: 3})
	s.SetClock(fixedClock(2026, 11, 29))
	_ = s.RecordApiCall(Call{AccountUID: "u2", Model: "m2", InputTokens: 40})
	// today_only
	r := s.PruneByTime("today_only", 1)
	if r.DeletedDaysCount != 2 || r.RemainingDaysCount != 1 || r.Summary.TotalRequests != 1 || r.Summary.TotalInputTokens != 40 {
		t.Fatalf("%+v", r)
	}
	st := s.Load(false)
	if st.Models.Len() != 1 || st.Accounts.Len() != 1 {
		t.Fatalf("models=%v accounts=%v", st.Models.Keys(), st.Accounts.Keys())
	}
	// 重建后 days 模式（保留 11-28、11-29 两天）
	s.SetClock(fixedClock(2026, 11, 27))
	_ = s.RecordApiCall(Call{AccountUID: "u1", Model: "m1", InputTokens: 10})
	s.SetClock(fixedClock(2026, 11, 28))
	_ = s.RecordApiCall(Call{AccountUID: "u3", Model: "m3", InputTokens: 10, OutputTokens: 1})
	s.SetClock(fixedClock(2026, 11, 29))
	r = s.PruneByTime("days", 2)
	if r.DeletedDaysCount != 1 || r.RemainingDaysCount != 2 || r.Summary.TotalRequests != 2 || r.Summary.TotalInputTokens != 50 {
		t.Fatalf("%+v", r)
	}
	// all
	r = s.PruneByTime("all", 1)
	if r.DeletedDaysCount != 2 || r.RemainingDaysCount != 0 || r.Summary.TotalRequests != 0 {
		t.Fatalf("%+v", r)
	}
	if s.Load(false).Daily.Len() != 0 {
		t.Fatal("daily should be empty")
	}
}

func TestFormatTokenNumberAndShift(t *testing.T) {
	cases := map[int64]string{0: "0", 999: "999", 1000: "1k", 1500: "1.5k", 9999: "10k", 12345: "1.2万", 99999999: "10000万", 100000000: "1亿", 150000000: "1.5亿"}
	for in, want := range cases {
		if got := FormatTokenNumber(in); got != want {
			t.Errorf("FormatTokenNumber(%d)=%s want %s", in, got, want)
		}
	}
	if ShiftedDateString("2026-11-29", -1) != "2026-11-28" || ShiftedDateString("2026-03-01", -1) != "2026-02-28" || ShiftedDateString("2026-12-31", 1) != "2027-01-01" {
		t.Fatal("shift")
	}
}

func TestAccountStatsByRange(t *testing.T) {
	s := newTestStore(t)
	s.SetClock(fixedClock(2026, 11, 28))
	_ = s.RecordApiCall(Call{AccountUID: "u1", AccountName: "Alice", Model: "m", InputTokens: 10})
	s.SetClock(fixedClock(2026, 11, 29))
	_ = s.RecordApiCall(Call{AccountUID: "u1", AccountName: "Alice", Model: "m", InputTokens: 5})
	_ = s.RecordApiCall(Call{AccountUID: "u2", AccountName: "Bob", Model: "m", InputTokens: 7})
	today := s.AccountStatsByRange("today")
	if len(today) != 4 { // u1, Alice, u2, Bob
		t.Fatalf("today keys=%v", keysOf(today))
	}
	if today["Alice"] != today["u1"] || today["u1"].InputTokens != 5 {
		t.Fatalf("today %+v", today["u1"])
	}
	y := s.AccountStatsByRange("yesterday")
	if y["u1"].InputTokens != 10 || y["u2"] != nil {
		t.Fatalf("yesterday %+v", y)
	}
	w := s.AccountStatsByRange("7d")
	if w["u1"].InputTokens != 15 || w["u2"].InputTokens != 7 {
		t.Fatalf("7d %+v", w)
	}
	all := s.AccountStatsByRange("all")
	if all["u1"].InputTokens != 15 || all["Bob"] != all["u2"] {
		t.Fatalf("all %+v", all)
	}
	if inv := s.AccountStatsByRange("bogus"); inv["u1"].InputTokens != 5 {
		t.Fatalf("invalid range should fall back to today: %+v", inv["u1"])
	}
}

func keysOf(m map[string]*AccountStat) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestGetReport(t *testing.T) {
	s := newTestStore(t)
	prices := pricing.NewStore(config.PathsFor(t.TempDir())).LoadModelPrices()
	s.SetClock(fixedClock(2026, 11, 28))
	_ = s.RecordApiCall(Call{AccountUID: "u1", AccountName: "Alice", Model: "small", IsSuccess: true, InputTokens: 1000, OutputTokens: 100})
	_ = s.RecordApiCall(Call{AccountUID: "u2", AccountName: "Bob", Model: "big", IsSuccess: false, InputTokens: 5000, OutputTokens: 500, CachedTokens: 1000})
	s.SetClock(fixedClock(2026, 11, 29))
	_ = s.RecordApiCall(Call{AccountUID: "u1", AccountName: "Alice", Model: "big", IsSuccess: true, InputTokens: 2000, OutputTokens: 200, CachedTokens: 1000})
	// prices 默认规则 2/0.5/4 → big: 2000*2/1M + 200*4/1M = 0.004+0.0008 = 0.0048
	r := s.GetReport(prices, "today")
	if r.Range != "today" || r.RangeLabel != "今天" || r.TotalTokens != 2200 || r.InputTokens != 2000 || r.OutputTokens != 200 || r.CachedTokens != 1000 {
		t.Fatalf("%+v", r)
	}
	if r.SuccessRate != "100.0%" || r.TodayRequests != 1 || r.ActiveDays != 1 || r.TotalDaysRange != 1 || r.ConsecutiveDays != 2 {
		t.Fatalf("%+v", r)
	}
	if r.OverallCacheHitRate != "50.0%" {
		t.Fatalf("hit rate %s", r.OverallCacheHitRate)
	}
	if len(r.ModelsList) != 1 || r.ModelsList[0].ID != "big" || r.ModelsList[0].Percentage != "100.0%" || r.ModelsList[0].PercentNum != 100 || !r.ModelsList[0].IsRealCache || r.ModelsList[0].CacheHitRate != "50.0%" {
		t.Fatalf("models %+v", r.ModelsList)
	}
	if abs(r.ModelsList[0].Cost-0.0048) > 1e-12 || r.TotalCostDisplay != "¥0.0048" {
		t.Fatalf("cost %+v / %s", r.ModelsList[0], r.TotalCostDisplay)
	}
	if r.TopModel.ID != "big" || r.TopModel.Tokens != 2200 || r.TopModel.Percentage != "100.0%" {
		t.Fatalf("top %+v", r.TopModel)
	}
	if len(r.AccountsList) != 1 || r.AccountsList[0].UID != "u1" || r.AccountsList[0].Percentage != "100.0%" {
		t.Fatalf("accounts %+v", r.AccountsList)
	}
	if len(r.DailyTrend) != 2 || r.DailyTrend[0].Date != "2026-11-29" || !r.DailyTrend[0].IsToday || !r.DailyTrend[1].IsYesterday || r.DailyTrend[1].IsInRange || !r.DailyTrend[0].IsInRange {
		t.Fatalf("trend %+v", r.DailyTrend)
	}
	if r.DailyTrend[1].TopModel != "big" || r.DailyTrend[1].SuccessRate != "50.0%" || r.DailyTrend[1].CacheHitRate != "16.7%" {
		t.Fatalf("trend[1] %+v", r.DailyTrend[1])
	}
	// 7d：big 5500+2200=7700 / small 1100 → 总 8800
	r = s.GetReport(prices, "7d")
	if r.TotalTokens != 8800 || r.TotalRequests != 3 || r.SuccessRate != "66.7%" || r.TotalDaysRange != 7 || r.ActiveDays != 2 || r.ModelsList[0].ID != "big" || r.ModelsList[1].ID != "small" {
		t.Fatalf("7d %+v", r)
	}
	if r.ModelsList[0].Percentage != "87.5%" || r.ModelsList[0].PercentNum != 87.5 || r.ModelsList[1].Percentage != "12.5%" {
		t.Fatalf("7d models %+v", r.ModelsList)
	}
	// all
	r = s.GetReport(prices, "all")
	if r.Range != "all" || r.RangeLabel != "全部" || r.TotalDaysRange != 2 || r.TotalTokens != 8800 {
		t.Fatalf("all %+v", r)
	}
	// 无效区间 → all
	if r2 := s.GetReport(prices, "xx"); r2.Range != "all" {
		t.Fatalf("invalid range %+v", r2)
	}
	// 昨天仅 big(5500) + small(1100) = 6600
	r = s.GetReport(prices, "yesterday")
	if r.TotalTokens != 6600 || len(r.AccountsList) != 2 || r.AccountsList[0].UID != "u2" || r.AccountsList[0].Percentage != "83.3%" || r.AccountsList[1].Percentage != "16.7%" {
		t.Fatalf("yesterday %+v / %+v", r, r.AccountsList)
	}
	// JSON 键序
	b, _ := json.Marshal(r)
	if !strings.HasPrefix(string(b), `{"range":"yesterday","rangeLabel":"昨天","totalTokens":6600,"totalTokensDisplay":"6.6k","inputTokens":6000,"inputTokensDisplay":"6k","outputTokens":600,"outputTokensDisplay":"600","cachedTokens":1000,"cachedTokensDisplay":"1k","overallCacheHitRate":"16.7%","totalCost":`) {
		t.Fatalf("json %s", b)
	}
	// 空库
	empty := newTestStore(t)
	re := empty.GetReport(prices, "all")
	if re.SuccessRate != "100%" || re.TopModel.ID != "-" || re.TopModel.Percentage != "100%" || re.ModelsList == nil || len(re.ModelsList) != 0 || re.TotalDaysRange != 1 {
		t.Fatalf("empty %+v", re)
	}
}

func abs(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

func copyFile(dst, src string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func TestOrderedMapRoundTrip(t *testing.T) {
	o := newOrdered[*ModelStat]()
	o.Set("z", &ModelStat{Name: "z"})
	o.Set("a", &ModelStat{Name: "a"})
	o.Set("m", &ModelStat{Name: "m"})
	o.Set("a", &ModelStat{Name: "a2"})
	b, _ := json.Marshal(o)
	if string(b) != `{"z":{"name":"z","requests":0,"successRequests":0,"inputTokens":0,"outputTokens":0,"cachedTokens":0,"totalTokens":0},"a":{"name":"a2","requests":0,"successRequests":0,"inputTokens":0,"outputTokens":0,"cachedTokens":0,"totalTokens":0},"m":{"name":"m","requests":0,"successRequests":0,"inputTokens":0,"outputTokens":0,"cachedTokens":0,"totalTokens":0}}` {
		t.Fatalf("marshal %s", b)
	}
	o.Delete("a")
	o.Delete("nope")
	if strings.Join(o.Keys(), ",") != "z,m" {
		t.Fatalf("keys %v", o.Keys())
	}
	var o2 ordered[*ModelStat]
	if err := json.Unmarshal([]byte(`{"b":{"name":"b"},"a":{"name":"a"},"c":{"requests":3}}`), &o2); err != nil {
		t.Fatal(err)
	}
	if strings.Join(o2.Keys(), ",") != "b,a,c" {
		t.Fatalf("unmarshal keys %v", o2.Keys())
	}
	c, _ := o2.Get("c")
	if c.Requests != 3 {
		t.Fatalf("c %+v", c)
	}
}
