package pricing

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/upstream"
)

func i64(v int64) *int64 { return &v }

func TestDefaultTableOrderAndJSON(t *testing.T) {
	tbl := defaultRules()
	if tbl.Len() != 29 {
		t.Fatalf("len=%d", tbl.Len())
	}
	keys := tbl.Keys()
	if keys[0] != "deepseek-v4.1-flash" || keys[len(keys)-1] != "default" {
		t.Fatalf("keys %v", keys)
	}
	r, _ := tbl.Get("kimi-k2.5")
	rb, _ := json.Marshal(r)
	if string(rb) != `{"input":3,"cacheHit":0.7,"output":9,"name":"Kimi-K2.5","vendor":"月之暗面开放平台","note":"K2.5 均衡: 输入 ¥3.00/M (缓存命中 ¥0.70/M), 输出 ¥9.00/M"}` {
		t.Fatalf("rule json %s", rb)
	}
	full, _ := json.Marshal(tbl)
	if !strings.HasPrefix(string(full), `{"deepseek-v4.1-flash":{"input":1,"cacheHit":0.5,"output":2,`) || !strings.HasSuffix(string(full), `"default":{"input":2,"cacheHit":0.5,"output":4,"name":"Default 官方通用","vendor":"官方参考基准","note":"基准价: 输入 ¥2.00/M (缓存命中 ¥0.50/M), 输出 ¥4.00/M"}}`) {
		t.Fatalf("table json %s", full)
	}
	// 覆盖保持位置；Clone 深拷贝
	tbl.Set("glm-4.6", &PriceRule{Input: 9, Output: 9, Name: "x", Vendor: "y", Note: "z"})
	c := tbl.Clone()
	cr, _ := c.Get("glm-4.6")
	cr.Input = 100
	if got, _ := tbl.Get("glm-4.6"); got.Input != 9 {
		t.Fatalf("clone not deep: %+v", got)
	}
}

func TestCalculateModelUsageCost(t *testing.T) {
	tbl := defaultRules()
	// 真实缓存命中
	c := CalculateModelUsageCost(tbl, "deepseek-v4.1-flash", 1_000_000, 1_000_000, i64(500_000))
	if c.StandardCost != 3 || c.CachedCost != 2.75 || c.SavedCost != 0.25 || c.SavingsPercent != "8.3%" || c.RealHitRate != "50.0%" || !c.IsRealCache || c.HitTokens != 500_000 {
		t.Fatalf("%+v", c)
	}
	if c.CostDisplay != "¥3.00" || c.Vendor != "DeepSeek官网" || c.InputPricePerM != 1 || c.CacheHitPricePerM != 0.5 || c.OutputPricePerM != 2 {
		t.Fatalf("%+v", c)
	}
	// 无真实缓存 → 80% 估算
	c = CalculateModelUsageCost(tbl, "deepseek-v4.1-flash", 1_000_000, 1_000_000, nil)
	if c.IsRealCache || c.HitTokens != 800_000 || c.CachedCost != 2.6 || math.Abs(c.SavedCost-0.4) > 1e-9 || c.SavingsPercent != "13.3%" || c.RealHitRate != "80.0%" {
		t.Fatalf("%+v", c)
	}
	// actualCached=0 → 走估算
	z := i64(0)
	c = CalculateModelUsageCost(tbl, "deepseek-v4.1-flash", 1_000_000, 0, z)
	if c.IsRealCache || math.Abs(c.CachedCost-0.6) > 1e-9 || c.RealHitRate != "80.0%" || c.SavingsPercent != "40.0%" {
		t.Fatalf("%+v", c)
	}
	// 命中超过输入 → 截断
	c = CalculateModelUsageCost(tbl, "deepseek-v4.1-flash", 100, 0, i64(500))
	if c.HitTokens != 100 || c.RealHitRate != "100.0%" {
		t.Fatalf("%+v", c)
	}
	// 未知模型 → default 规则
	c = CalculateModelUsageCost(tbl, "unknown-model", 1_000_000, 1_000_000, nil)
	if c.StandardCost != 6 || c.Vendor != "官方参考基准" {
		t.Fatalf("%+v", c)
	}
	// 自定义规则缺省 cacheHit → input/2；缺省 note 自动拼接
	tbl.Set("custom", &PriceRule{Input: 4, Output: 8, Vendor: "自定义"})
	c = CalculateModelUsageCost(tbl, "custom", 1_000_000, 1_000_000, nil)
	if c.CacheHitPricePerM != 2 || c.Note != "输入 ¥4/M (缓存 ¥2/M), 输出 ¥8/M" {
		t.Fatalf("%+v", c)
	}
	// 空表 → 兜底 1.5/3
	c = CalculateModelUsageCost(NewTable(), "m", 1_000_000, 1_000_000, nil)
	if c.StandardCost != 4.5 || c.Vendor != "官方基准估算" {
		t.Fatalf("%+v", c)
	}
	// 零用量
	c = CalculateModelUsageCost(tbl, "hy3", 0, 0, nil)
	if c.SavingsPercent != "0%" || c.RealHitRate != "0%" || c.StandardCost != 0 {
		t.Fatalf("%+v", c)
	}
	// JSON 键序
	b, _ := json.Marshal(c)
	if !strings.HasPrefix(string(b), `{"modelId":"hy3","standardCost":0,"totalCost":0,"inputCost":0,"outputCost":0,"costDisplay":"¥0.00","cachedCost":0,"cachedCostDisplay":"¥0.00","savedCost":0,"savedCostDisplay":"¥0.00","savingsPercent":"0%","hitTokens":0,"realHitRate":"0%","isRealCache":false,"inputPricePerM":0,"cacheHitPricePerM":0,"outputPricePerM":0,"vendor":"腾讯云官方"`) {
		t.Fatalf("json %s", b)
	}
}

func TestFormatCurrency(t *testing.T) {
	cases := map[float64]string{0: "¥0.00", 12345.678: "¥1.23万", 12.5: "¥12.50", 1: "¥1.00", 0.5: "¥0.500", 0.01: "¥0.010", 0.001: "¥0.0010"}
	for in, want := range cases {
		if got := FormatCurrency(in); got != want {
			t.Errorf("FormatCurrency(%v)=%s want %s", in, got, want)
		}
	}
}

func TestStoreLoadSaveMerge(t *testing.T) {
	dir := t.TempDir()
	p := config.PathsFor(dir)
	s := NewStore(p)
	tbl := s.LoadModelPrices()
	if tbl.Len() != 29 {
		t.Fatalf("len=%d", tbl.Len())
	}
	// 写入自定义：覆盖 default + 新增 custom-x
	custom := mustObj(`{"default":{"input":9,"cacheHit":1,"output":18,"name":"D","vendor":"V","note":"N","extraKey":1},"custom-x":{"input":0.1,"cacheHit":0.01,"output":0.2,"name":"CX","vendor":"CXV","note":"CXN"}}`)
	merged := s.SaveModelPrices(custom)
	if merged.Len() != 30 {
		t.Fatalf("merged len=%d", merged.Len())
	}
	if d, _ := merged.Get("default"); d.Input != 9 || d.Extra["extraKey"] == nil {
		t.Fatalf("default %+v", d)
	}
	if cx, _ := merged.Get("custom-x"); cx.Input != 0.1 {
		t.Fatalf("custom-x %+v", cx)
	}
	raw, err := os.ReadFile(p.PricingPath)
	if err != nil {
		t.Fatal(err)
	}
	// Node writeJsonWithBackup 使用 JSON.stringify(data, null, 2)：2 空格缩进 + 保序
	if !strings.HasPrefix(string(raw), "{\n  \"") {
		t.Fatalf("pricing.json should be indented: %s", raw)
	}
	saved, err := upstream.ParseObj(raw)
	if err != nil {
		t.Fatal(err)
	}
	cxSaved, _ := saved.GetOK("custom-x")
	if cxSaved == nil {
		t.Fatalf("pricing.json missing custom-x: %s", raw)
	}
	if cxRule := upstream.GetObj(saved, "custom-x"); upstream.GetString(cxRule, "name") != "CX" || upstream.GetString(cxRule, "note") != "CXN" {
		t.Fatalf("custom-x %+v", cxRule)
	}
	savedKeys := saved.Keys()
	if savedKeys[len(savedKeys)-1] != "custom-x" || savedKeys[len(savedKeys)-2] != "default" || len(savedKeys) != 30 {
		t.Fatalf("saved keys %v", savedKeys)
	}
	// 新 Store 读取：默认 + 自定义覆盖，顺序保持（default 保持在原位）
	s2 := NewStore(p)
	t2 := s2.LoadModelPrices()
	if t2.Len() != 30 {
		t.Fatalf("reload len=%d", t2.Len())
	}
	keys := t2.Keys()
	if keys[len(keys)-1] != "custom-x" || keys[len(keys)-2] != "default" {
		t.Fatalf("keys %v", keys)
	}
	if d, _ := t2.Get("default"); d.Input != 9 || string(d.Extra["extraKey"]) != "1" {
		t.Fatalf("reload default %+v", d)
	}
	// 容灾：主文件损坏 → 从 backups 恢复
	if err := os.WriteFile(p.PricingPath, []byte("{broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	s3 := NewStore(p)
	t3 := s3.LoadModelPrices()
	if cx, _ := t3.Get("custom-x"); cx == nil {
		t.Fatalf("expected recovery from backup; keys=%v", t3.Keys())
	}
	_ = filepath.Join
	_ = upstream.NewObj
}

func mustObj(s string) *upstream.Obj {
	o, err := upstream.ParseObj([]byte(s))
	if err != nil {
		panic(err)
	}
	return o
}
