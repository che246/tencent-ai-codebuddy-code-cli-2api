// Package metrics 对应 Node 版 src/core/metrics.mjs（stats.json 读写、调用计数、区间报表）
// 与 src/core/log-parser.mjs（从 gateway.log 重构历史统计，见 logparser.go）。
package metrics

import (
	"encoding/json"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/pricing"
	"codebuddy-gateway/internal/upstream"
)

// ─── 有序映射：保持 stats.json 中 models/accounts/daily 的键插入顺序 ────────────

type ordered[V any] struct {
	keys []string
	m    map[string]V
}

func newOrdered[V any]() *ordered[V] { return &ordered[V]{m: map[string]V{}} }

func (o *ordered[V]) Get(k string) (V, bool) {
	v, ok := o.m[k]
	return v, ok
}

// Ensure 取值或创建（创建时追加到末尾）。
func (o *ordered[V]) Ensure(k string, mk func() V) V {
	if v, ok := o.m[k]; ok {
		return v
	}
	v := mk()
	if o.m == nil {
		o.m = map[string]V{}
	}
	o.m[k] = v
	o.keys = append(o.keys, k)
	return v
}

func (o *ordered[V]) Set(k string, v V) {
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	if o.m == nil {
		o.m = map[string]V{}
	}
	o.m[k] = v
}

func (o *ordered[V]) Delete(k string) {
	if _, ok := o.m[k]; !ok {
		return
	}
	delete(o.m, k)
	for i, x := range o.keys {
		if x == k {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

// Keys 键序列（插入序）。
func (o *ordered[V]) Keys() []string { return append([]string(nil), o.keys...) }

// Len 条目数。
func (o *ordered[V]) Len() int { return len(o.keys) }

func (o *ordered[V]) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	b.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		vb, err := json.Marshal(o.m[k])
		if err != nil {
			return nil, err
		}
		b.Write(kb)
		b.WriteByte(':')
		b.Write(vb)
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}

func (o *ordered[V]) UnmarshalJSON(data []byte) error {
	raw := map[string]json.RawMessage{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	obj, err := upstream.ParseObj(data)
	if err != nil {
		return err
	}
	o.keys, o.m = nil, map[string]V{}
	for _, k := range obj.Keys() {
		var v V
		if err := json.Unmarshal(raw[k], &v); err != nil {
			return err
		}
		o.Set(k, v)
	}
	return nil
}

// ─── stats.json 结构 ───────────────────────────────────────────────────────────

// Counter 计数器集合（模型/账号维度共用字段集）。
type Counter struct {
	Name            string `json:"name"`
	Requests        int64  `json:"requests"`
	SuccessRequests int64  `json:"successRequests"`
	InputTokens     int64  `json:"inputTokens"`
	OutputTokens    int64  `json:"outputTokens"`
	CachedTokens    int64  `json:"cachedTokens"`
	TotalTokens     int64  `json:"totalTokens"`
}

// ModelStat 模型维度统计。
type ModelStat Counter

// AccountStat 账号维度统计。
type AccountStat struct {
	UID string `json:"uid"`
	Counter
}

// DailyStat 单日统计（含模型/账号细分）。
type DailyStat struct {
	Requests        int64                  `json:"requests"`
	SuccessRequests int64                  `json:"successRequests"`
	FailedRequests  int64                  `json:"failedRequests"`
	InputTokens     int64                  `json:"inputTokens"`
	OutputTokens    int64                  `json:"outputTokens"`
	CachedTokens    int64                  `json:"cachedTokens"`
	TotalTokens     int64                  `json:"totalTokens"`
	Models          *ordered[*ModelStat]   `json:"models"`
	Accounts        *ordered[*AccountStat] `json:"accounts"`
}

// Summary 总汇总。
type Summary struct {
	TotalRequests     int64 `json:"totalRequests"`
	SuccessRequests   int64 `json:"successRequests"`
	FailedRequests    int64 `json:"failedRequests"`
	TotalInputTokens  int64 `json:"totalInputTokens"`
	TotalOutputTokens int64 `json:"totalOutputTokens"`
	TotalCachedTokens int64 `json:"totalCachedTokens"`
	TotalTokens       int64 `json:"totalTokens"`
}

// Stats stats.json 根结构。
type Stats struct {
	Summary  Summary                `json:"summary"`
	Models   *ordered[*ModelStat]   `json:"models"`
	Accounts *ordered[*AccountStat] `json:"accounts"`
	Daily    *ordered[*DailyStat]   `json:"daily"`
}

func emptySummary() Summary { return Summary{} }

func newDefaultStats(today string) *Stats {
	d := newOrdered[*DailyStat]()
	d.Set(today, &DailyStat{Models: newOrdered[*ModelStat](), Accounts: newOrdered[*AccountStat]()})
	return &Stats{Summary: emptySummary(), Models: newOrdered[*ModelStat](), Accounts: newOrdered[*AccountStat](), Daily: d}
}

func normalizeStats(s *Stats) {
	if s.Models == nil {
		s.Models = newOrdered[*ModelStat]()
	}
	if s.Accounts == nil {
		s.Accounts = newOrdered[*AccountStat]()
	}
	if s.Daily == nil {
		s.Daily = newOrdered[*DailyStat]()
	}
	for _, k := range s.Daily.Keys() {
		d, _ := s.Daily.Get(k)
		if d.Models == nil {
			d.Models = newOrdered[*ModelStat]()
		}
		if d.Accounts == nil {
			d.Accounts = newOrdered[*AccountStat]()
		}
	}
}

// ─── Store：loadStats / saveStats / recordApiCall ──────────────────────────────

// Store 统计存储（stats.json + backups 容灾 + 日志重构）。
type Store struct {
	mu          sync.Mutex
	paths       config.Paths
	logFilePath string
	now         func() time.Time
	data        *Stats
}

// New 创建统计存储。
func New(p config.Paths, logFilePath string) *Store {
	return &Store{paths: p, logFilePath: logFilePath, now: time.Now}
}

// SetClock 注入时钟（测试用）。
func (s *Store) SetClock(fn func() time.Time) { s.now = fn }

func (s *Store) today() string { return config.TodayStringAt(s.now()) }

// Load 对应 loadStats：stats.json → backups 容灾 → 日志重构。
func (s *Store) Load(forceReload bool) *Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data != nil && !forceReload {
		return s.data
	}
	valid := func(raw []byte) (*Stats, bool) {
		if len(strings.TrimSpace(string(raw))) <= 5 {
			return nil, false
		}
		obj, err := upstream.ParseObj(raw)
		if err != nil {
			return nil, false
		}
		sum := upstream.GetObj(obj, "summary")
		if sum == nil {
			return nil, false
		}
		if _, ok := sum.Get("totalRequests").(json.Number); !ok {
			return nil, false
		}
		var st Stats
		if err := json.Unmarshal(raw, &st); err != nil {
			return nil, false
		}
		normalizeStats(&st)
		return &st, true
	}
	// 1. stats.json
	if raw, err := os.ReadFile(s.paths.StatsPath); err == nil {
		if st, ok := valid(raw); ok {
			s.data = st
			return st
		}
	}
	// 2. backups/ 独立备份目录或 legacy 备份自动容灾恢复
	bakPath := config.BackupPath(s.paths, s.paths.StatsPath)
	legacyBakPath := s.paths.StatsPath + ".bak"
	target := ""
	if _, err := os.Stat(bakPath); err == nil {
		target = bakPath
	} else if _, err := os.Stat(legacyBakPath); err == nil {
		target = legacyBakPath
	}
	if target != "" {
		if raw, err := os.ReadFile(target); err == nil {
			if st, ok := valid(raw); ok {
				s.data = st
				_ = config.WriteJSONWithBackup(s.paths, s.paths.StatsPath, st)
				if target == legacyBakPath {
					_ = os.Remove(legacyBakPath)
				}
				return st
			}
		}
	}
	// 3. 首次从日志动态重构初始化
	st := s.initialStats()
	s.data = st
	_ = config.WriteJSONWithBackup(s.paths, s.paths.StatsPath, st)
	return st
}

func (s *Store) initialStats() *Stats {
	if s.logFilePath != "" {
		if fromLog := RebuildRealStatsFromLog(s.logFilePath); fromLog != nil && fromLog.Summary.TotalRequests > 0 {
			normalizeStats(fromLog)
			return fromLog
		}
	}
	return newDefaultStats(s.today())
}

// Save 对应 saveStats/saveStatsSync：写 stats.json（含备份）。
func (s *Store) Save() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data == nil {
		return nil
	}
	return config.WriteJSONWithBackup(s.paths, s.paths.StatsPath, s.data)
}

// Call recordApiCall 入参。
type Call struct {
	AccountUID   string
	AccountName  string
	Model        string
	IsSuccess    bool
	InputTokens  int64
	OutputTokens int64
	CachedTokens int64
}

// RecordApiCall 记录一次 API 调用并同步落盘。
func (s *Store) RecordApiCall(c Call) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data == nil {
		s.data = newDefaultStats(s.today())
	}
	st := s.data
	today := s.today()
	model := c.Model
	if model == "" {
		model = "unknown"
	}
	totalTokens := c.InputTokens + c.OutputTokens

	// 1. 总汇总
	st.Summary.TotalRequests++
	if c.IsSuccess {
		st.Summary.SuccessRequests++
	} else {
		st.Summary.FailedRequests++
	}
	st.Summary.TotalInputTokens += c.InputTokens
	st.Summary.TotalOutputTokens += c.OutputTokens
	st.Summary.TotalCachedTokens += c.CachedTokens
	st.Summary.TotalTokens += totalTokens

	// 2. 按模型
	m := st.Models.Ensure(model, func() *ModelStat { return &ModelStat{Name: model} })
	m.Requests++
	if c.IsSuccess {
		m.SuccessRequests++
	}
	m.InputTokens += c.InputTokens
	m.OutputTokens += c.OutputTokens
	m.CachedTokens += c.CachedTokens
	m.TotalTokens += totalTokens

	// 3. 按账号
	if c.AccountUID != "" {
		a := st.Accounts.Ensure(c.AccountUID, func() *AccountStat {
			return &AccountStat{UID: c.AccountUID, Counter: Counter{Name: orElse(c.AccountName, c.AccountUID)}}
		})
		if c.AccountName != "" {
			a.Name = c.AccountName
		}
		a.Requests++
		if c.IsSuccess {
			a.SuccessRequests++
		}
		a.InputTokens += c.InputTokens
		a.OutputTokens += c.OutputTokens
		a.CachedTokens += c.CachedTokens
		a.TotalTokens += totalTokens
	}

	// 4. 按日
	d := st.Daily.Ensure(today, func() *DailyStat {
		return &DailyStat{Models: newOrdered[*ModelStat](), Accounts: newOrdered[*AccountStat]()}
	})
	d.Requests++
	if c.IsSuccess {
		d.SuccessRequests++
	}
	d.InputTokens += c.InputTokens
	d.OutputTokens += c.OutputTokens
	d.CachedTokens += c.CachedTokens
	d.TotalTokens += totalTokens
	dm := d.Models.Ensure(model, func() *ModelStat { return &ModelStat{Name: model} })
	dm.Requests++
	if c.IsSuccess {
		dm.SuccessRequests++
	}
	dm.InputTokens += c.InputTokens
	dm.OutputTokens += c.OutputTokens
	dm.CachedTokens += c.CachedTokens
	dm.TotalTokens += totalTokens
	if c.AccountUID != "" {
		da := d.Accounts.Ensure(c.AccountUID, func() *AccountStat {
			return &AccountStat{UID: c.AccountUID, Counter: Counter{Name: orElse(c.AccountName, c.AccountUID)}}
		})
		da.Requests++
		if c.IsSuccess {
			da.SuccessRequests++
		}
		da.InputTokens += c.InputTokens
		da.OutputTokens += c.OutputTokens
		da.CachedTokens += c.CachedTokens
		da.TotalTokens += totalTokens
	}
	return config.WriteJSONWithBackup(s.paths, s.paths.StatsPath, st)
}

// ─── 按时间清理（metrics.mjs:113-208） ────────────────────────────────────────

// PruneResult pruneStatsByTime 返回值。
type PruneResult struct {
	OK                 bool    `json:"ok"`
	Mode               string  `json:"mode"`
	DeletedDaysCount   int     `json:"deletedDaysCount"`
	RemainingDaysCount int     `json:"remainingDaysCount"`
	Summary            Summary `json:"summary"`
}

// PruneByTime mode: today_only | days | all。
func (s *Store) PruneByTime(mode string, keepDays int) PruneResult {
	st := s.Load(false)
	s.mu.Lock()
	defer s.mu.Unlock()
	today := s.today()
	deleted := 0
	if mode == "all" {
		st.Summary = Summary{}
		st.Models = newOrdered[*ModelStat]()
		st.Accounts = newOrdered[*AccountStat]()
		deleted = st.Daily.Len()
		st.Daily = newOrdered[*DailyStat]()
	} else {
		cutoff := today
		if mode == "days" {
			days := keepDays
			if days < 1 {
				days = 1
			}
			cutoff = ShiftedDateString(today, -(days - 1))
		}
		for _, d := range st.Daily.Keys() {
			if d < cutoff {
				st.Daily.Delete(d)
				deleted++
			}
		}
		newSummary := Summary{}
		newModels := newOrdered[*ModelStat]()
		newAccounts := newOrdered[*AccountStat]()
		for _, k := range st.Daily.Keys() {
			d, _ := st.Daily.Get(k)
			newSummary.TotalRequests += d.Requests
			newSummary.SuccessRequests += d.SuccessRequests
			newSummary.FailedRequests += d.FailedRequests
			newSummary.TotalInputTokens += d.InputTokens
			newSummary.TotalOutputTokens += d.OutputTokens
			newSummary.TotalCachedTokens += d.CachedTokens
			newSummary.TotalTokens += d.TotalTokens
			for _, mk := range d.Models.Keys() {
				mo, _ := d.Models.Get(mk)
				nm := newModels.Ensure(mk, func() *ModelStat { return &ModelStat{Name: mk} })
				nm.Requests += mo.Requests
				nm.SuccessRequests += mo.SuccessRequests
				nm.InputTokens += mo.InputTokens
				nm.OutputTokens += mo.OutputTokens
				nm.CachedTokens += mo.CachedTokens
				nm.TotalTokens += mo.TotalTokens
			}
			for _, ak := range d.Accounts.Keys() {
				ao, _ := d.Accounts.Get(ak)
				na := newAccounts.Ensure(ak, func() *AccountStat { return &AccountStat{UID: ak, Counter: Counter{Name: orElse(ao.Name, ak)}} })
				na.Requests += ao.Requests
				na.SuccessRequests += ao.SuccessRequests
				na.InputTokens += ao.InputTokens
				na.OutputTokens += ao.OutputTokens
				na.CachedTokens += ao.CachedTokens
				na.TotalTokens += ao.TotalTokens
			}
		}
		st.Summary, st.Models, st.Accounts = newSummary, newModels, newAccounts
	}
	_ = config.WriteJSONWithBackup(s.paths, s.paths.StatsPath, st)
	return PruneResult{OK: true, Mode: mode, DeletedDaysCount: deleted, RemainingDaysCount: st.Daily.Len(), Summary: st.Summary}
}

// ─── 展示工具 ─────────────────────────────────────────────────────────────────

// FormatTokenNumber tokens 数量的人性化展示（万/亿/k）。
func FormatTokenNumber(n int64) string {
	if n >= 100000000 {
		return toFixed1Trim(float64(n)/100000000) + "亿"
	}
	if n >= 10000 {
		return toFixed1Trim(float64(n)/10000) + "万"
	}
	if n >= 1000 {
		return toFixed1Trim(float64(n)/1000) + "k"
	}
	return formatEnUS(float64(n))
}

// toFixed1Trim `(x).toFixed(1).replace(/\.0$/, ”)`。
func toFixed1Trim(v float64) string {
	s := strconv.FormatFloat(v, 'f', 1, 64)
	return strings.TrimSuffix(s, ".0")
}

// ShiftedDateString 日期字符串按天偏移。
func ShiftedDateString(base string, daysShift int) string {
	t, err := time.ParseInLocation("2006-01-02", base, time.Local)
	if err != nil {
		return base
	}
	return t.AddDate(0, 0, daysShift).Format("2006-01-02")
}

// formatEnUS 整数/小数的 en-US 千分位展示。
func formatEnUS(v float64) string {
	s := strconv.FormatFloat(v, 'f', -1, 64)
	intPart, frac := s, ""
	if i := strings.IndexByte(s, '.'); i >= 0 {
		intPart, frac = s[:i], s[i:]
	}
	var b strings.Builder
	for i, c := range intPart {
		if i > 0 && (len(intPart)-i)%3 == 0 && c >= '0' && c <= '9' {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	return b.String() + frac
}

func num(v float64) string {
	if v == 0 {
		return "0"
	}
	if a := math.Abs(v); a >= 1e21 || a < 1e-6 {
		return strconv.FormatFloat(v, 'e', -1, 64)
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}

func numJSON(v float64) json.Number { return json.Number(num(v)) }

func pct1(x float64) string { return strconv.FormatFloat(x, 'f', 1, 64) + "%" }

func orElse(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

// ─── 账号区间统计映射（metrics.mjs:353-455） ───────────────────────────────────

func targetDateList(today, rng string) []string {
	switch rng {
	case "today":
		return []string{today}
	case "yesterday":
		return []string{ShiftedDateString(today, -1)}
	case "7d":
		return lastNDates(today, 7)
	case "30d":
		return lastNDates(today, 30)
	}
	return []string{today}
}

func lastNDates(today string, n int) []string {
	out := make([]string, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, ShiftedDateString(today, -i))
	}
	return out
}

// AccountStatsByRange 按区间聚合账号统计；返回映射同时包含 uid / 原键 / 名称 别名。
func (s *Store) AccountStatsByRange(rng string) map[string]*AccountStat {
	st := s.Load(false)
	s.mu.Lock()
	defer s.mu.Unlock()
	valid := map[string]bool{"today": true, "yesterday": true, "7d": true, "30d": true, "all": true}
	if !valid[rng] {
		rng = "today"
	}
	result := map[string]*AccountStat{}
	alias := func(key, id, name string, st *AccountStat) {
		if key != "" && key != id {
			if _, ok := result[key]; !ok {
				result[key] = st
			}
		}
		if name != "" && name != id {
			if _, ok := result[name]; !ok {
				result[name] = st
			}
		}
	}
	// 1. 全量历史
	if rng == "all" {
		for _, k := range st.Accounts.Keys() {
			acc, _ := st.Accounts.Get(k)
			id := orElse(acc.UID, k)
			if _, ok := result[id]; !ok {
				result[id] = &AccountStat{UID: id, Counter: Counter{Name: orElse(acc.Name, id), Requests: acc.Requests, SuccessRequests: acc.SuccessRequests, InputTokens: acc.InputTokens, OutputTokens: acc.OutputTokens, CachedTokens: acc.CachedTokens, TotalTokens: acc.TotalTokens}}
			}
			alias(k, id, acc.Name, result[id])
		}
		for _, dk := range st.Daily.Keys() {
			d, _ := st.Daily.Get(dk)
			for _, k := range d.Accounts.Keys() {
				acc, _ := d.Accounts.Get(k)
				id := orElse(acc.UID, k)
				if _, ok := result[id]; !ok {
					result[id] = &AccountStat{UID: id, Counter: Counter{Name: orElse(acc.Name, id)}}
				}
				alias(k, id, acc.Name, result[id])
			}
		}
		return result
	}
	// 2. 指定时间区间
	for _, date := range targetDateList(s.today(), rng) {
		d, ok := st.Daily.Get(date)
		if !ok {
			continue
		}
		for _, k := range d.Accounts.Keys() {
			acc, _ := d.Accounts.Get(k)
			id := orElse(acc.UID, k)
			if _, ok := result[id]; !ok {
				result[id] = &AccountStat{UID: id, Counter: Counter{Name: orElse(acc.Name, id)}}
			}
			r := result[id]
			r.Requests += acc.Requests
			r.SuccessRequests += acc.SuccessRequests
			r.InputTokens += acc.InputTokens
			r.OutputTokens += acc.OutputTokens
			r.CachedTokens += acc.CachedTokens
			r.TotalTokens += acc.TotalTokens
			alias(k, id, acc.Name, r)
		}
	}
	return result
}

// ─── 区间报表（metrics.mjs:457-753） ──────────────────────────────────────────

// Report getMetricsReport 返回值（JSON 键序与 Node 一致）。
type Report struct {
	Range                  string       `json:"range"`
	RangeLabel             string       `json:"rangeLabel"`
	TotalTokens            int64        `json:"totalTokens"`
	TotalTokensDisplay     string       `json:"totalTokensDisplay"`
	InputTokens            int64        `json:"inputTokens"`
	InputTokensDisplay     string       `json:"inputTokensDisplay"`
	OutputTokens           int64        `json:"outputTokens"`
	OutputTokensDisplay    string       `json:"outputTokensDisplay"`
	CachedTokens           int64        `json:"cachedTokens"`
	CachedTokensDisplay    string       `json:"cachedTokensDisplay"`
	OverallCacheHitRate    string       `json:"overallCacheHitRate"`
	TotalCost              float64      `json:"totalCost"`
	TotalCostDisplay       string       `json:"totalCostDisplay"`
	TotalCachedCost        float64      `json:"totalCachedCost"`
	TotalCachedCostDisplay string       `json:"totalCachedCostDisplay"`
	TotalSavedCost         float64      `json:"totalSavedCost"`
	TotalSavedCostDisplay  string       `json:"totalSavedCostDisplay"`
	TotalRequests          int64        `json:"totalRequests"`
	SuccessRequests        int64        `json:"successRequests"`
	FailedRequests         int64        `json:"failedRequests"`
	SuccessRate            string       `json:"successRate"`
	TodayRequests          int64        `json:"todayRequests"`
	ActiveDays             int          `json:"activeDays"`
	TotalDaysRange         int          `json:"totalDaysRange"`
	ConsecutiveDays        int          `json:"consecutiveDays"`
	TopModel               TopModel     `json:"topModel"`
	ModelsList             []ModelRow   `json:"modelsList"`
	AccountsList           []AccountRow `json:"accountsList"`
	DailyTrend             []DailyRow   `json:"dailyTrend"`
}

// TopModel 区间 Top 模型。
type TopModel struct {
	ID            string `json:"id"`
	Tokens        int64  `json:"tokens"`
	TokensDisplay string `json:"tokensDisplay"`
	Percentage    string `json:"percentage"`
}

// ModelRow 模型排行行。
type ModelRow struct {
	ID                  string  `json:"id"`
	Name                string  `json:"name"`
	Requests            int64   `json:"requests"`
	SuccessRequests     int64   `json:"successRequests"`
	InputTokens         int64   `json:"inputTokens"`
	OutputTokens        int64   `json:"outputTokens"`
	CachedTokens        int64   `json:"cachedTokens"`
	CachedTokensDisplay string  `json:"cachedTokensDisplay"`
	CacheHitRate        string  `json:"cacheHitRate"`
	IsRealCache         bool    `json:"isRealCache"`
	TotalTokens         int64   `json:"totalTokens"`
	TotalTokensDisplay  string  `json:"totalTokensDisplay"`
	Cost                float64 `json:"cost"`
	CostDisplay         string  `json:"costDisplay"`
	CachedCost          float64 `json:"cachedCost"`
	CachedCostDisplay   string  `json:"cachedCostDisplay"`
	SavedCost           float64 `json:"savedCost"`
	SavedCostDisplay    string  `json:"savedCostDisplay"`
	SavingsPercent      string  `json:"savingsPercent"`
	PriceNote           string  `json:"priceNote"`
	PriceVendor         string  `json:"priceVendor"`
	Percentage          string  `json:"percentage"`
	PercentNum          float64 `json:"percentNum"`
}

// AccountRow 账号排行行。
type AccountRow struct {
	UID                 string  `json:"uid"`
	Name                string  `json:"name"`
	Requests            int64   `json:"requests"`
	SuccessRequests     int64   `json:"successRequests"`
	InputTokens         int64   `json:"inputTokens"`
	InputTokensDisplay  string  `json:"inputTokensDisplay"`
	OutputTokens        int64   `json:"outputTokens"`
	OutputTokensDisplay string  `json:"outputTokensDisplay"`
	TotalTokens         int64   `json:"totalTokens"`
	TotalTokensDisplay  string  `json:"totalTokensDisplay"`
	Percentage          string  `json:"percentage"`
	PercentNum          float64 `json:"percentNum"`
}

// DailyRow 每日趋势行。
type DailyRow struct {
	Date                string  `json:"date"`
	IsToday             bool    `json:"isToday"`
	IsYesterday         bool    `json:"isYesterday"`
	IsInRange           bool    `json:"isInRange"`
	Requests            int64   `json:"requests"`
	SuccessRequests     int64   `json:"successRequests"`
	FailedRequests      int64   `json:"failedRequests"`
	SuccessRate         string  `json:"successRate"`
	TopModel            string  `json:"topModel"`
	InputTokens         int64   `json:"inputTokens"`
	InputTokensDisplay  string  `json:"inputTokensDisplay"`
	OutputTokens        int64   `json:"outputTokens"`
	OutputTokensDisplay string  `json:"outputTokensDisplay"`
	CachedTokens        int64   `json:"cachedTokens"`
	CachedTokensDisplay string  `json:"cachedTokensDisplay"`
	CacheHitRate        string  `json:"cacheHitRate"`
	TotalTokens         int64   `json:"totalTokens"`
	TotalTokensDisplay  string  `json:"totalTokensDisplay"`
	TotalCost           float64 `json:"totalCost"`
	TotalCostDisplay    string  `json:"totalCostDisplay"`
}

func percentStr(x float64) string { return pct1(x) }

func percentNum(x float64) float64 {
	f, _ := strconv.ParseFloat(strconv.FormatFloat(x, 'f', 1, 64), 64)
	return f
}

// GetReport 对应 getMetricsReport(range)；prices 为价格表（用于折算金额）。
func (s *Store) GetReport(prices *pricing.Table, rng string) Report {
	st := s.Load(false)
	s.mu.Lock()
	daily := st.Daily
	today := s.today()
	s.mu.Unlock()
	yesterday := ShiftedDateString(today, -1)
	valid := map[string]bool{"today": true, "yesterday": true, "7d": true, "30d": true, "all": true}
	if !valid[rng] {
		rng = "all"
	}
	var targetDates []string
	totalDaysRange := 1
	rangeLabel := "全部"
	switch rng {
	case "today":
		targetDates, rangeLabel = []string{today}, "今天"
	case "yesterday":
		targetDates, rangeLabel = []string{yesterday}, "昨天"
	case "7d":
		targetDates, totalDaysRange, rangeLabel = lastNDates(today, 7), 7, "7天"
	case "30d":
		targetDates, totalDaysRange, rangeLabel = lastNDates(today, 30), 30, "30天"
	default:
		targetDates = daily.Keys()
		sort.Strings(targetDates)
		if len(targetDates) > 0 {
			first, err1 := time.ParseInLocation("2006-01-02", targetDates[0], time.Local)
			todayD, err2 := time.ParseInLocation("2006-01-02", today, time.Local)
			if err1 == nil && err2 == nil {
				diff := todayD.Sub(first).Hours() / 24
				if diff < 0 {
					diff = -diff
				}
				totalDaysRange = int(math.Max(1, math.Ceil(diff)+1))
			}
		}
	}
	inRange := map[string]bool{}
	for _, d := range targetDates {
		inRange[d] = true
	}

	// 连续活跃天数 (含今天在内往前数)
	consecutiveDays := 0
	cursor := today
	for {
		d, ok := daily.Get(cursor)
		if !ok || d.Requests <= 0 {
			break
		}
		consecutiveDays++
		cursor = ShiftedDateString(cursor, -1)
	}

	var totalTokens, inputTokens, outputTokens, cachedTokens int64
	var totalRequests, successRequests, failedRequests int64
	activeDays := 0
	modelsMap := newOrdered[*ModelStat]()
	accountsMap := newOrdered[*AccountStat]()
	for _, date := range targetDates {
		d, ok := daily.Get(date)
		if !ok {
			continue
		}
		if d.Requests > 0 {
			activeDays++
		}
		totalRequests += d.Requests
		successRequests += d.SuccessRequests
		failedRequests += d.FailedRequests
		inputTokens += d.InputTokens
		outputTokens += d.OutputTokens
		cachedTokens += d.CachedTokens
		totalTokens += d.TotalTokens
		for _, mk := range d.Models.Keys() {
			mo, _ := d.Models.Get(mk)
			nm := modelsMap.Ensure(mk, func() *ModelStat { return &ModelStat{Name: mk} })
			nm.Requests += mo.Requests
			nm.SuccessRequests += mo.SuccessRequests
			nm.InputTokens += mo.InputTokens
			nm.OutputTokens += mo.OutputTokens
			nm.CachedTokens += mo.CachedTokens
			nm.TotalTokens += mo.TotalTokens
		}
		for _, ak := range d.Accounts.Keys() {
			ao, _ := d.Accounts.Get(ak)
			na := accountsMap.Ensure(ak, func() *AccountStat { return &AccountStat{UID: ak, Counter: Counter{Name: orElse(ao.Name, ak)}} })
			na.Requests += ao.Requests
			na.SuccessRequests += ao.SuccessRequests
			na.InputTokens += ao.InputTokens
			na.OutputTokens += ao.OutputTokens
			na.CachedTokens += ao.CachedTokens
			na.TotalTokens += ao.TotalTokens
		}
	}
	// 兜底：range === 'all' 且 daily 无细分时使用根对象
	if rng == "all" {
		if modelsMap.Len() == 0 {
			for _, k := range st.Models.Keys() {
				m, _ := st.Models.Get(k)
				modelsMap.Set(k, m)
			}
		}
		if accountsMap.Len() == 0 {
			for _, k := range st.Accounts.Keys() {
				a, _ := st.Accounts.Get(k)
				accountsMap.Set(k, a)
			}
		}
	}

	successRate := "100%"
	if totalRequests > 0 {
		successRate = percentStr(float64(successRequests) / float64(totalRequests) * 100)
	}
	todayRequests := int64(0)
	if td, ok := daily.Get(today); ok {
		todayRequests = td.Requests
	}

	// Top 模型
	topModelID, topModelTokens := "-", int64(0)
	for _, id := range modelsMap.Keys() {
		m, _ := modelsMap.Get(id)
		if m.TotalTokens >= topModelTokens {
			topModelTokens = m.TotalTokens
			topModelID = id
		}
	}
	topModelPercent := "100%"
	if totalTokens > 0 {
		topModelPercent = percentStr(float64(topModelTokens) / float64(totalTokens) * 100)
	}

	// 模型排行列表
	modelsList := make([]ModelRow, 0, modelsMap.Len())
	for _, id := range modelsMap.Keys() {
		m, _ := modelsMap.Get(id)
		modelCached := m.CachedTokens
		costInfo := pricing.CalculateModelUsageCost(prices, id, m.InputTokens, m.OutputTokens, &modelCached)
		hitRate := "0.0%"
		if m.InputTokens > 0 {
			hitRate = percentStr(float64(modelCached) / float64(m.InputTokens) * 100)
		}
		percentage, pn := "100%", 0.0
		if totalTokens > 0 {
			p := float64(m.TotalTokens) / float64(totalTokens) * 100
			percentage, pn = percentStr(p), percentNum(p)
		}
		modelsList = append(modelsList, ModelRow{
			ID: id, Name: orElse(m.Name, id), Requests: m.Requests, SuccessRequests: m.SuccessRequests,
			InputTokens: m.InputTokens, OutputTokens: m.OutputTokens, CachedTokens: modelCached,
			CachedTokensDisplay: FormatTokenNumber(modelCached), CacheHitRate: hitRate, IsRealCache: costInfo.IsRealCache,
			TotalTokens: m.TotalTokens, TotalTokensDisplay: FormatTokenNumber(m.TotalTokens),
			Cost: costInfo.StandardCost, CostDisplay: costInfo.CostDisplay, CachedCost: costInfo.CachedCost,
			CachedCostDisplay: costInfo.CachedCostDisplay, SavedCost: costInfo.SavedCost, SavedCostDisplay: costInfo.SavedCostDisplay,
			SavingsPercent: costInfo.SavingsPercent, PriceNote: costInfo.Note, PriceVendor: costInfo.Vendor,
			Percentage: percentage, PercentNum: pn,
		})
	}
	sort.SliceStable(modelsList, func(i, j int) bool { return modelsList[i].TotalTokens > modelsList[j].TotalTokens })

	totalCost, totalCachedCost := 0.0, 0.0
	for _, it := range modelsList {
		totalCost += it.Cost
		totalCachedCost += it.CachedCost
	}
	totalSavedCost := math.Max(0, totalCost-totalCachedCost)
	overallCacheHitRate := "0.0%"
	if inputTokens > 0 {
		overallCacheHitRate = percentStr(float64(cachedTokens) / float64(inputTokens) * 100)
	}

	// 账号排行列表
	accountsList := make([]AccountRow, 0, accountsMap.Len())
	for _, uid := range accountsMap.Keys() {
		a, _ := accountsMap.Get(uid)
		percentage, pn := "0%", 0.0
		if totalTokens > 0 {
			p := float64(a.TotalTokens) / float64(totalTokens) * 100
			percentage, pn = percentStr(p), percentNum(p)
		}
		accountsList = append(accountsList, AccountRow{
			UID: uid, Name: orElse(a.Name, uid), Requests: a.Requests, SuccessRequests: a.SuccessRequests,
			InputTokens: a.InputTokens, InputTokensDisplay: FormatTokenNumber(a.InputTokens),
			OutputTokens: a.OutputTokens, OutputTokensDisplay: FormatTokenNumber(a.OutputTokens),
			TotalTokens: a.TotalTokens, TotalTokensDisplay: FormatTokenNumber(a.TotalTokens),
			Percentage: percentage, PercentNum: pn,
		})
	}
	sort.SliceStable(accountsList, func(i, j int) bool { return accountsList[i].TotalTokens > accountsList[j].TotalTokens })

	// 每日全量历史趋势（不受区间切片影响）
	dailyTrend := make([]DailyRow, 0, daily.Len())
	for _, date := range daily.Keys() {
		d, _ := daily.Get(date)
		if !(d.Requests > 0 || d.TotalTokens > 0) {
			continue
		}
		topModelForDay := "-"
		dayModels := d.Models.Keys()
		if len(dayModels) > 0 {
			sort.SliceStable(dayModels, func(i, j int) bool {
				a, _ := d.Models.Get(dayModels[i])
				b, _ := d.Models.Get(dayModels[j])
				return a.TotalTokens > b.TotalTokens
			})
			topModelForDay = dayModels[0]
		}
		daySuccessRate := "100%"
		if d.Requests > 0 {
			daySuccessRate = percentStr(float64(d.SuccessRequests) / float64(d.Requests) * 100)
		}
		dayCostTotal, dayCachedCostTotal := 0.0, 0.0
		dayCachedTokens := d.CachedTokens
		for _, mk := range d.Models.Keys() {
			md, _ := d.Models.Get(mk)
			c := pricing.CalculateModelUsageCost(prices, mk, md.InputTokens, md.OutputTokens, &md.CachedTokens)
			dayCostTotal += c.StandardCost
			dayCachedCostTotal += c.CachedCost
		}
		dayHitRate := "0.0%"
		if d.InputTokens > 0 {
			dayHitRate = percentStr(float64(dayCachedTokens) / float64(d.InputTokens) * 100)
		}
		dailyTrend = append(dailyTrend, DailyRow{
			Date: date, IsToday: date == today, IsYesterday: date == yesterday, IsInRange: inRange[date],
			Requests: d.Requests, SuccessRequests: d.SuccessRequests, FailedRequests: d.FailedRequests, SuccessRate: daySuccessRate,
			TopModel: topModelForDay, InputTokens: d.InputTokens, InputTokensDisplay: FormatTokenNumber(d.InputTokens),
			OutputTokens: d.OutputTokens, OutputTokensDisplay: FormatTokenNumber(d.OutputTokens),
			CachedTokens: dayCachedTokens, CachedTokensDisplay: FormatTokenNumber(dayCachedTokens), CacheHitRate: dayHitRate,
			TotalTokens: d.TotalTokens, TotalTokensDisplay: FormatTokenNumber(d.TotalTokens),
			TotalCost: dayCostTotal, TotalCostDisplay: pricing.FormatCurrency(dayCostTotal),
		})
	}
	sort.SliceStable(dailyTrend, func(i, j int) bool { return dailyTrend[i].Date > dailyTrend[j].Date })

	return Report{
		Range: rng, RangeLabel: rangeLabel,
		TotalTokens: totalTokens, TotalTokensDisplay: FormatTokenNumber(totalTokens),
		InputTokens: inputTokens, InputTokensDisplay: FormatTokenNumber(inputTokens),
		OutputTokens: outputTokens, OutputTokensDisplay: FormatTokenNumber(outputTokens),
		CachedTokens: cachedTokens, CachedTokensDisplay: FormatTokenNumber(cachedTokens),
		OverallCacheHitRate: overallCacheHitRate,
		TotalCost:           totalCost, TotalCostDisplay: pricing.FormatCurrency(totalCost),
		TotalCachedCost: totalCachedCost, TotalCachedCostDisplay: pricing.FormatCurrency(totalCachedCost),
		TotalSavedCost: totalSavedCost, TotalSavedCostDisplay: pricing.FormatCurrency(totalSavedCost),
		TotalRequests: totalRequests, SuccessRequests: successRequests, FailedRequests: failedRequests, SuccessRate: successRate,
		TodayRequests: todayRequests, ActiveDays: activeDays, TotalDaysRange: totalDaysRange, ConsecutiveDays: consecutiveDays,
		TopModel:     TopModel{ID: topModelID, Tokens: topModelTokens, TokensDisplay: FormatTokenNumber(topModelTokens), Percentage: topModelPercent},
		ModelsList:   modelsList,
		AccountsList: accountsList,
		DailyTrend:   dailyTrend,
	}
}
