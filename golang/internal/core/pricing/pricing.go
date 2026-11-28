// Package pricing 对应 Node 版 src/core/pricing.mjs：官网标准单价基准库、用量折算、联网检索定价。
package pricing

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/logger"
	"codebuddy-gateway/internal/upstream"
)

// PriceRule 单个模型单价规则（单位：人民币元 / 1M Tokens）。JSON 键序与 Node 版一致。
type PriceRule struct {
	Input    float64                    `json:"input"`
	CacheHit *float64                   `json:"cacheHit,omitempty"`
	Output   float64                    `json:"output"`
	Name     string                     `json:"name"`
	Vendor   string                     `json:"vendor"`
	Note     string                     `json:"note"`
	Extra    map[string]json.RawMessage `json:"-"`
}

// MarshalJSON 输出 input, cacheHit, output, name, vendor, note（+ 额外键）。
func (r PriceRule) MarshalJSON() ([]byte, error) {
	o := upstream.NewObj().Set("input", json.Number(num(r.Input)))
	if r.CacheHit != nil {
		o.Set("cacheHit", json.Number(num(*r.CacheHit)))
	}
	o.Set("output", json.Number(num(r.Output))).Set("name", r.Name).Set("vendor", r.Vendor).Set("note", r.Note)
	for k, v := range r.Extra {
		if !o.Has(k) {
			o.Set(k, v)
		}
	}
	return o.MarshalJSON()
}

// UnmarshalJSON 解析已知字段并保留额外键。
func (r *PriceRule) UnmarshalJSON(data []byte) error {
	type alias struct {
		Input    float64  `json:"input"`
		CacheHit *float64 `json:"cacheHit"`
		Output   float64  `json:"output"`
		Name     string   `json:"name"`
		Vendor   string   `json:"vendor"`
		Note     string   `json:"note"`
	}
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	r.Input, r.CacheHit, r.Output, r.Name, r.Vendor, r.Note = a.Input, a.CacheHit, a.Output, a.Name, a.Vendor, a.Note
	raw := map[string]json.RawMessage{}
	_ = json.Unmarshal(data, &raw)
	r.Extra = map[string]json.RawMessage{}
	for k, v := range raw {
		switch k {
		case "input", "cacheHit", "output", "name", "vendor", "note":
		default:
			r.Extra[k] = v
		}
	}
	return nil
}

// CacheHitOr 返回缓存命中单价；未定义时取输入价一半（Node: `rule.cacheHit !== undefined ? : inputPrice*0.5`）。
func (r *PriceRule) CacheHitOr() float64 {
	if r.CacheHit != nil {
		return *r.CacheHit
	}
	return r.Input * 0.5
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

func f64(v float64) *float64 { return &v }

// ─── 各大模型官网真实标准单价基准库（pricing.mjs:12-55） ────────────────────────

func defaultRules() *Table {
	t := NewTable()
	add := func(id string, input, cacheHit, output float64, name, vendor, note string) {
		t.Set(id, &PriceRule{Input: input, CacheHit: f64(cacheHit), Output: output, Name: name, Vendor: vendor, Note: note})
	}
	// DeepSeek 官方系列 (官方缓存命中享受 75% 优惠，仅需 ¥0.50/M)
	add("deepseek-v4.1-flash", 1.00, 0.50, 2.00, "DeepSeek-V4.1-Flash", "DeepSeek官网", "官网定价: 输入 ¥1.00/M (缓存命中 ¥0.50/M), 输出 ¥2.00/M")
	add("deepseek-v4-flash", 1.00, 0.50, 2.00, "DeepSeek-V4-Flash", "DeepSeek官网", "官网定价: 输入 ¥1.00/M (缓存命中 ¥0.50/M), 输出 ¥2.00/M")
	add("deepseek-v4-pro", 4.00, 1.00, 16.00, "DeepSeek-V4-Pro", "DeepSeek官网", "官网定价: 输入 ¥4.00/M (缓存命中 ¥1.00/M), 输出 ¥16.00/M")
	add("deepseek-v3-2-volc", 2.00, 0.50, 8.00, "DeepSeek-V3.2", "火山/深度求索", "标准价: 输入 ¥2.00/M (缓存命中 ¥0.50/M), 输出 ¥8.00/M")
	// 智谱 GLM 官方系列 (bigmodel.cn，官方公布缓存命中单价低至 ¥0.57/M)
	add("glm-5.3-flash", 0.80, 0.57, 2.80, "GLM-5.3-Flash", "智谱AI开放平台", "官方开放平台: 输入 ¥0.80/M (缓存命中 ¥0.57/M), 输出 ¥2.80/M")
	add("glm-5.3", 5.00, 2.00, 5.00, "GLM-5.3", "智谱AI开放平台", "旗舰级: 输入 ¥5.00/M (缓存命中 ¥2.00/M), 输出 ¥5.00/M")
	add("glm-5.2", 8.00, 2.00, 28.00, "GLM-5.2", "智谱AI开放平台", "旗舰超长: 输入 ¥8.00/M (缓存命中 ¥2.00/M), 输出 ¥28.00/M")
	add("glm-5.0", 6.00, 1.50, 24.00, "GLM-5.0", "智谱AI开放平台", "标准价: 输入 ¥6.00/M (缓存命中 ¥1.50/M), 输出 ¥24.00/M")
	add("glm-5.0-turbo", 5.00, 2.00, 5.00, "GLM-5.0-Turbo", "智谱AI开放平台", "极速旗舰: 输入 ¥5.00/M (缓存命中 ¥2.00/M), 输出 ¥5.00/M")
	add("glm-4.7", 1.00, 0.50, 2.00, "GLM-4.7", "智谱AI开放平台", "轻量经济: 输入 ¥1.00/M (缓存命中 ¥0.50/M), 输出 ¥2.00/M")
	add("glm-4.6", 1.00, 0.50, 2.00, "GLM-4.6", "智谱AI开放平台", "轻量经济: 输入 ¥1.00/M (缓存命中 ¥0.50/M), 输出 ¥2.00/M")
	add("glm-4.6v", 0.80, 0.50, 2.80, "GLM-4.6V (视觉)", "智谱AI开放平台", "多模态视觉: 输入 ¥0.80/M (缓存命中 ¥0.50/M), 输出 ¥2.80/M")
	// 月之暗面 Kimi 官方系列 (moonshot.cn，前缀缓存命中低至 1~2折)
	add("kimi-k3-1", 12.00, 2.40, 12.00, "Kimi-K3", "月之暗面开放平台", "K3 旗舰1M: 输入 ¥12.00/M (缓存命中 ¥2.40/M), 输出 ¥12.00/M")
	add("kimi-k3.1-pro", 12.00, 2.40, 12.00, "Kimi-K3.1-Pro", "月之暗面开放平台", "K3.1 Pro: 输入 ¥12.00/M (缓存命中 ¥2.40/M), 输出 ¥12.00/M")
	add("kimi-k2.8-preview", 8.00, 1.60, 8.00, "Kimi-K2.8", "月之暗面开放平台", "K2.8 预览: 输入 ¥8.00/M (缓存命中 ¥1.60/M), 输出 ¥8.00/M")
	add("kimi-k2.5", 3.00, 0.70, 9.00, "Kimi-K2.5", "月之暗面开放平台", "K2.5 均衡: 输入 ¥3.00/M (缓存命中 ¥0.70/M), 输出 ¥9.00/M")
	add("kimi-k2-thinking", 4.00, 1.00, 16.00, "Kimi-K2-Thinking", "月之暗面开放平台", "深度思考版: 输入 ¥4.00/M (缓存命中 ¥1.00/M), 输出 ¥16.00/M")
	// MiniMax 官方系列 (minimax.io)
	add("minimax-m2.5", 1.00, 0.50, 2.00, "MiniMax-M2.5", "MiniMax开放平台", "标准价: 输入 ¥1.00/M (缓存命中 ¥0.50/M), 输出 ¥2.00/M")
	add("minimax-m2.7", 1.00, 0.50, 2.00, "MiniMax-M2.7", "MiniMax开放平台", "标准价: 输入 ¥1.00/M (缓存命中 ¥0.50/M), 输出 ¥2.00/M")
	add("minimax-m3.1-flash", 0.80, 0.40, 2.00, "MiniMax-M3.1-Flash", "MiniMax开放平台", "极速版: 输入 ¥0.80/M (缓存命中 ¥0.40/M), 输出 ¥2.00/M")
	// 腾讯混元与自研系列 (cloud.tencent.com)
	add("hy3", 0.00, 0.00, 0.00, "混元大模型3 (hy3)", "腾讯云官方", "官方限免: ¥0.00 / 1M tokens")
	add("hy4free", 0.00, 0.00, 0.00, "混元4试用 (hy4free)", "腾讯云官方", "官方试用: ¥0.00 / 1M tokens")
	add("hy3-x", 0.50, 0.25, 1.00, "混元3增强 (hy3-x)", "腾讯云官方", "低倍率自研: 输入 ¥0.50/M (缓存命中 ¥0.25/M), 输出 ¥1.00/M")
	add("hy4std", 2.00, 1.00, 4.00, "混元4标准 (hy4std)", "腾讯云官方", "混元4旗舰: 输入 ¥2.00/M (缓存命中 ¥1.00/M), 输出 ¥4.00/M")
	add("hy4-preview-x", 2.00, 1.00, 4.00, "混元4预览 (hy4-preview)", "腾讯云官方", "混元4旗舰: 输入 ¥2.00/M (缓存命中 ¥1.00/M), 输出 ¥4.00/M")
	add("hunyuan-chat", 2.00, 1.00, 4.00, "腾讯混元对话", "腾讯云官方", "腾讯云标准: 输入 ¥2.00/M (缓存命中 ¥1.00/M), 输出 ¥4.00/M")
	// 阶跃星辰与其它
	add("step-5-preview", 4.00, 1.00, 12.00, "阶跃星辰 Step-5", "阶跃星辰开放平台", "Step-5: 输入 ¥4.00/M (缓存命中 ¥1.00/M), 输出 ¥12.00/M")
	add("mimo-v2.6-pro", 2.00, 0.50, 8.00, "MIMO-V2.6-Pro", "MIMO智能平台", "标准价: 输入 ¥2.00/M (缓存命中 ¥0.50/M), 输出 ¥8.00/M")
	// 通用/缺省模型
	add("default", 2.00, 0.50, 4.00, "Default 官方通用", "官方参考基准", "基准价: 输入 ¥2.00/M (缓存命中 ¥0.50/M), 输出 ¥4.00/M")
	return t
}

// Table 保序价格表。
type Table struct {
	keys []string
	m    map[string]*PriceRule
}

// NewTable 创建空表。
func NewTable() *Table { return &Table{m: map[string]*PriceRule{}} }

// Set 插入/覆盖（覆盖保持原位置）。
func (t *Table) Set(id string, r *PriceRule) {
	if _, ok := t.m[id]; !ok {
		t.keys = append(t.keys, id)
	}
	t.m[id] = r
}

// Get 查找。
func (t *Table) Get(id string) (*PriceRule, bool) { r, ok := t.m[id]; return r, ok }

// Keys 键序列。
func (t *Table) Keys() []string { return append([]string(nil), t.keys...) }

// Len 条目数。
func (t *Table) Len() int { return len(t.keys) }

// Clone 深拷贝。
func (t *Table) Clone() *Table {
	c := NewTable()
	for _, k := range t.keys {
		r := *t.m[k]
		c.Set(k, &r)
	}
	return c
}

// MarshalJSON 按插入顺序输出。
func (t *Table) MarshalJSON() ([]byte, error) {
	o := upstream.NewObj()
	for _, k := range t.keys {
		o.Set(k, t.m[k])
	}
	return o.MarshalJSON()
}

// UnmarshalJSON 解析对象（保持文件键序）。
func (t *Table) UnmarshalJSON(data []byte) error {
	o, err := upstream.ParseObj(data)
	if err != nil {
		return err
	}
	t.keys, t.m = nil, map[string]*PriceRule{}
	for _, k := range o.Keys() {
		var r PriceRule
		b, _ := upstream.MarshalJSON(o.Get(k))
		if err := json.Unmarshal(b, &r); err != nil {
			return err
		}
		t.Set(k, &r)
	}
	return nil
}

// TableOf 把对象转为保序表。
func TableOf(o *upstream.Obj) *Table {
	t := NewTable()
	if o == nil {
		return t
	}
	for _, k := range o.Keys() {
		var r PriceRule
		b, _ := upstream.MarshalJSON(o.Get(k))
		if err := json.Unmarshal(b, &r); err != nil {
			continue
		}
		t.Set(k, &r)
	}
	return t
}

// ─── 持久化（pricing.json） ────────────────────────────────────────────────────

// Store 价格库（默认基准 + pricing.json 自定义覆盖）。
type Store struct {
	mu    sync.Mutex
	paths config.Paths
	table *Table
}

// NewStore 创建价格库。
func NewStore(p config.Paths) *Store { return &Store{paths: p} }

// LoadModelPrices 返回合并后的价格表（默认 + 自定义）。
func (s *Store) LoadModelPrices() *Table {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

// loadLocked 持锁加载（首次读取 pricing.json 并与默认规则合并，之后走缓存）。
func (s *Store) loadLocked() *Table {
	if s.table != nil {
		return s.table
	}
	var raw json.RawMessage
	custom := upstream.NewObj()
	if err := config.LoadJSONWithBackup(s.paths, s.paths.PricingPath, &raw); err == nil && len(raw) > 0 {
		if o, err := upstream.ParseObj(raw); err == nil {
			custom = o
		}
	}
	merged := defaultRules()
	for _, k := range custom.Keys() {
		var r PriceRule
		b, _ := upstream.MarshalJSON(custom.Get(k))
		if err := json.Unmarshal(b, &r); err != nil {
			continue
		}
		merged.Set(k, &r)
	}
	s.table = merged
	return merged
}

// SaveModelPrices 合并写入自定义价格并持久化；返回合并后的表（pricing.mjs:66-70）。
func (s *Store) SaveModelPrices(newPrices *upstream.Obj) *Table {
	s.mu.Lock()
	defer s.mu.Unlock()
	merged := s.loadLocked().Clone()
	for _, k := range newPrices.Keys() {
		var r PriceRule
		b, _ := upstream.MarshalJSON(newPrices.Get(k))
		if err := json.Unmarshal(b, &r); err != nil {
			continue
		}
		merged.Set(k, &r)
	}
	s.table = merged
	_ = config.WriteJSONWithBackup(s.paths, s.paths.PricingPath, merged)
	return merged
}

// ─── 用量折算（pricing.mjs:76-143） ────────────────────────────────────────────

// CostInfo 单模型用量估算结果；JSON 键序与 Node 一致。
type CostInfo struct {
	ModelID           string  `json:"modelId"`
	StandardCost      float64 `json:"standardCost"`
	TotalCost         float64 `json:"totalCost"`
	InputCost         float64 `json:"inputCost"`
	OutputCost        float64 `json:"outputCost"`
	CostDisplay       string  `json:"costDisplay"`
	CachedCost        float64 `json:"cachedCost"`
	CachedCostDisplay string  `json:"cachedCostDisplay"`
	SavedCost         float64 `json:"savedCost"`
	SavedCostDisplay  string  `json:"savedCostDisplay"`
	SavingsPercent    string  `json:"savingsPercent"`
	HitTokens         float64 `json:"hitTokens"`
	RealHitRate       string  `json:"realHitRate"`
	IsRealCache       bool    `json:"isRealCache"`
	InputPricePerM    float64 `json:"inputPricePerM"`
	CacheHitPricePerM float64 `json:"cacheHitPricePerM"`
	OutputPricePerM   float64 `json:"outputPricePerM"`
	Vendor            string  `json:"vendor"`
	Note              string  `json:"note"`
}

// CalculateModelUsageCost 计算单个模型的真实用量估算价值（人民币元）。
// actualCachedTokens 非 nil 且 > 0 时采用上游真实缓存命中；否则按长效 Prompt 缓存典型 80% 测算。
func CalculateModelUsageCost(prices *Table, modelID string, inputTokens, outputTokens int64, actualCachedTokens *int64) CostInfo {
	var rule *PriceRule
	if prices != nil {
		rule, _ = prices.Get(modelID)
		if rule == nil {
			rule, _ = prices.Get("default")
		}
	}
	if rule == nil {
		rule = &PriceRule{Input: 1.5, Output: 3.0, Vendor: "官方基准估算", Note: "参考公网大模型标准计费"}
	}
	inputMillion := float64(inputTokens) / 1000000
	outputMillion := float64(outputTokens) / 1000000
	inputPrice := rule.Input
	cacheHitPrice := rule.CacheHitOr()
	outputPrice := rule.Output

	// 1. 全量无缓存标准价值
	standardInputCost := inputMillion * inputPrice
	outputCost := outputMillion * outputPrice
	standardTotalCost := standardInputCost + outputCost

	// 2. 考虑 Prompt 缓存命中
	cachedTotalCost := 0.0
	isRealCache := false
	hitTokens := 0.0
	if actualCachedTokens != nil && *actualCachedTokens > 0 {
		isRealCache = true
		hitTokens = math.Min(float64(inputTokens), float64(*actualCachedTokens))
		missTokens := math.Max(0, float64(inputTokens)-hitTokens)
		cachedTotalCost = (hitTokens/1000000)*cacheHitPrice + (missTokens/1000000)*inputPrice + outputCost
	} else {
		// 默认按照长效 Prompt 缓存基准 (典型 80% 命中) 估算
		const defaultCacheRate = 0.8
		hitTokens = math.Round(float64(inputTokens) * defaultCacheRate)
		cachedTotalCost = (inputMillion*defaultCacheRate)*cacheHitPrice + (inputMillion*(1-defaultCacheRate))*inputPrice + outputCost
	}

	// 3. 提示词缓存所产生的节省价值
	savedCost := math.Max(0, standardTotalCost-cachedTotalCost)
	realHitRate := "0%"
	if inputTokens > 0 {
		realHitRate = pct1(hitTokens / float64(inputTokens) * 100)
	}
	savingsPercent := "0%"
	if standardTotalCost > 0 {
		savingsPercent = pct1(savedCost / standardTotalCost * 100)
	}
	note := rule.Note
	if note == "" {
		note = fmt.Sprintf("输入 ¥%s/M (缓存 ¥%s/M), 输出 ¥%s/M", num(inputPrice), num(cacheHitPrice), num(outputPrice))
	}
	return CostInfo{
		ModelID: modelID, StandardCost: standardTotalCost, TotalCost: standardTotalCost,
		InputCost: standardInputCost, OutputCost: outputCost, CostDisplay: FormatCurrency(standardTotalCost),
		CachedCost: cachedTotalCost, CachedCostDisplay: FormatCurrency(cachedTotalCost),
		SavedCost: savedCost, SavedCostDisplay: FormatCurrency(savedCost), SavingsPercent: savingsPercent,
		HitTokens: hitTokens, RealHitRate: realHitRate, IsRealCache: isRealCache,
		InputPricePerM: inputPrice, CacheHitPricePerM: cacheHitPrice, OutputPricePerM: outputPrice,
		Vendor: orElse(rule.Vendor, "官方"), Note: note,
	}
}

func orElse(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

// pct1 `(x).toFixed(1) + '%'`。
func pct1(x float64) string { return strconv.FormatFloat(x, 'f', 1, 64) + "%" }

// FormatCurrency 格式化货币展示金额（pricing.mjs:148-160）。
func FormatCurrency(amount float64) string {
	if math.IsNaN(amount) || amount == 0 {
		return "¥0.00"
	}
	switch {
	case amount >= 10000:
		return "¥" + strconv.FormatFloat(amount/10000, 'f', 2, 64) + "万"
	case amount >= 1:
		return "¥" + strconv.FormatFloat(amount, 'f', 2, 64)
	case amount >= 0.01:
		return "¥" + strconv.FormatFloat(amount, 'f', 3, 64)
	}
	return "¥" + strconv.FormatFloat(amount, 'f', 4, 64)
}

// ─── 联网检索定价（pricing.mjs:165-208） ───────────────────────────────────────

// SearchOfficialPricingOnline 基于官方联网检索 (/v1/search) 检索各模型最新官网定价。
// acc 为调度器选出的可用账号；无账号时返回错误。
func SearchOfficialPricingOnline(ctx context.Context, client *upstream.Client, lg *logger.Logger, acc *config.Account, keyword string, prices *Table) (*upstream.Obj, error) {
	if acc == nil || acc.AccessToken == "" {
		return nil, fmt.Errorf("当前账号池暂无可用健康账号执行联网检索")
	}
	if keyword == "" {
		keyword = "大模型 API 官方价格"
	}
	queries := []string{
		fmt.Sprintf("%s DeepSeek 官方 API 价格 1M tokens", keyword),
		fmt.Sprintf("%s 智谱 GLM-5 GLM-4 API 定价 百万tokens", keyword),
		fmt.Sprintf("%s Kimi 月之暗面 API 价格 1M tokens", keyword),
	}
	searchURL := config.EndpointsFor(acc).Search
	h := http.Header{}
	h.Set("Authorization", "Bearer "+acc.AccessToken)
	h.Set("User-Agent", config.UserAgent)
	h.Set("Content-Type", "application/json")
	results := []any{}
	for _, q := range queries {
		body, _ := upstream.MarshalJSON(upstream.NewObj().Set("query", q).Set("max_results", json.Number("3")))
		reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		status, resp, err := client.DoJSON(reqCtx, http.MethodPost, searchURL, h, body)
		cancel()
		if err != nil {
			lg.Warn("SEARCH", fmt.Sprintf("联网检索模型定价异常 [%s]: %s", q, err.Error()))
			continue
		}
		if status >= 200 && status < 300 {
			data, perr := upstream.ParseObj(resp)
			if perr != nil {
				lg.Warn("SEARCH", fmt.Sprintf("联网检索模型定价异常 [%s]: %s", q, perr.Error()))
				continue
			}
			rs := upstream.GetArr(data, "results")
			if rs == nil {
				rs = []any{}
			}
			results = append(results, upstream.NewObj().Set("query", q).Set("results", rs))
		}
	}
	now := time.Now()
	return upstream.NewObj().
		Set("searchedAt", now.UTC().Format("2006-01-02T15:04:05.000Z")). // JS toISOString 带毫秒 Z
		Set("account", config.AccountFullDesc(acc)).
		Set("results", results).
		Set("currentRules", prices), nil
}
