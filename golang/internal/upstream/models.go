package upstream

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/logger"
)

// ─── 动态获取可用模型矩阵（models.mjs） ─────────────────────────────────────────
// [网关自有策略，无 CLI 对应实现 · 决策由 VG 明确指定]
// 模型列表**只以上游 /v3/config 为准**，不做任何磁盘快照与离线回放：
//   · 不写/不读 product.json，也不回落 package/product.json；
//   · 进程内保留 5 分钟内存缓存（GWModelCacheMs），仅为降低对上游的请求频率，不构成第二数据源；
//   · 上游不可达时如实返回空列表，由调用方感知失败。
// CLI 侧对照：ProductManager 以 48e4(8 分钟) TTL 懒刷新，同样不依赖本地快照做业务回放。

// ModelCatalog 模型矩阵 + 繁忙度缓存（替代 models.mjs 模块级 cachedRawUpstreamModels 等）。
type ModelCatalog struct {
	mu       sync.Mutex // 串行化整表拉取（并发放行后重查缓存）
	client   *Client
	accounts *config.AccountStore
	lg       *logger.Logger
	now      func() time.Time
	dataDir  string

	cachedModels     []*Obj
	cachedPromotions []*Obj
	lastFetch        int64

	busyMu     sync.Mutex
	cachedBusy map[string]string
	lastBusy   int64
}

// NewModelCatalog 构造；dataDir 用于提示遗留 product.json。
func NewModelCatalog(client *Client, accounts *config.AccountStore, lg *logger.Logger, dataDir string) *ModelCatalog {
	return &ModelCatalog{client: client, accounts: accounts, lg: lg, now: time.Now, dataDir: dataDir, cachedBusy: map[string]string{}}
}

// SetClock 注入时钟（测试用）。
func (m *ModelCatalog) SetClock(fn func() time.Time) { m.now = fn }

// WarnLegacyProductSnapshot 一次性检查：若磁盘上仍残留历史 product.json 快照，提示运维删除（models.mjs:30-36）。
func (m *ModelCatalog) WarnLegacyProductSnapshot() {
	p := m.dataDir + string(os.PathSeparator) + "product.json"
	if _, err := os.Stat(p); err == nil {
		logWarn(m.lg, "CONFIG", "检测到历史遗留快照 product.json（"+p+"）。该文件已不再作为模型列表数据源，可安全删除。")
	}
}

// isOK 等价 fetch 的 res.ok（200-299）。
func isOK(status int) bool { return status >= 200 && status < 300 }

// FetchBusyLevels 官方上游模型实时繁忙度探测 POST /v2/chat/busy（models.mjs:159-209）。
// 仅国内版支持；每批 50 个；4s 超时；缓存 60s（GWBusyCacheMs）；输出 map[model→level]。
func (m *ModelCatalog) FetchBusyLevels(modelIDs []string, force bool) map[string]string {
	m.busyMu.Lock()
	defer m.busyMu.Unlock()
	now := m.now().UnixMilli()
	if !force && len(m.cachedBusy) > 0 && now-m.lastBusy < GWBusyCacheMs {
		return copyMap(m.cachedBusy)
	}
	if len(modelIDs) == 0 {
		return copyMap(m.cachedBusy)
	}
	cnAcc := m.accounts.Find(func(a *config.Account) bool {
		return a.Status == "healthy" && config.ResolveAccountRegion(a) == config.RegionCn && a.AccessToken != ""
	})
	if cnAcc == nil {
		return copyMap(m.cachedBusy)
	}
	ep := config.EndpointsFor(cnAcc)
	busyURL := ep.APIBase + "/v2/chat/busy"
	result := copyMap(m.cachedBusy)

	const batchSize = 50
	for i := 0; i < len(modelIDs); i += batchSize {
		end := i + batchSize
		if end > len(modelIDs) {
			end = len(modelIDs)
		}
		batch := modelIDs[i:end]
		traceId := RandomHex(16)
		h := http.Header{}
		h["Content-Type"] = []string{"application/json"}
		h["Accept"] = []string{"application/json, text/plain, */*"}
		h["User-Agent"] = []string{config.UserAgent}
		h["Authorization"] = []string{"Bearer " + cnAcc.AccessToken}
		h["X-User-Id"] = []string{cnAcc.UID}
		h["X-Product"] = []string{"SaaS"}
		h["X-Domain"] = []string{"copilot.tencent.com"}
		h["X-Request-ID"] = []string{traceId}
		bodyObj := NewObj().Set("models", toAnySlice(batch))
		body, _ := MarshalJSON(bodyObj)
		ctx, cancel := context.WithTimeout(context.Background(), GWBusyTimeoutMs)
		status, data, err := m.client.DoJSON(ctx, http.MethodPost, busyURL, h, body)
		cancel()
		if err != nil || !isOK(status) {
			continue
		}
		obj, err := ParseObj(data)
		if err != nil {
			continue
		}
		if code, ok := GetNum(obj.Get("code")); !ok || code != 0 {
			continue
		}
		items, ok := obj.Get("data").([]any)
		if !ok {
			continue
		}
		for _, iv := range items {
			item, ok := iv.(*Obj)
			if !ok {
				continue
			}
			mdl := GetString(item, "model")
			lvl := GetString(item, "busy_level")
			if mdl != "" && lvl != "" {
				result[strings.ToLower(mdl)] = strings.ToLower(lvl)
			}
		}
	}
	m.cachedBusy = result
	m.lastBusy = now
	return copyMap(result)
}

// FetchDetailedModels 拉取模型矩阵（models.mjs:211-326）。
func (m *ModelCatalog) FetchDetailedModels(forceRefresh bool) []*Obj {
	m.mu.Lock()
	defer m.mu.Unlock()
	nowMs := m.now().UnixMilli()
	accounts := m.accounts.List()

	if !forceRefresh && m.cachedModels != nil && nowMs-m.lastFetch < GWModelCacheMs {
		allIds := make([]string, 0, len(m.cachedModels))
		for _, mm := range m.cachedModels {
			allIds = append(allIds, GetString(mm, "id"))
		}
		busyMap := m.FetchBusyLevels(allIds, false)
		applyBusy(m.cachedModels, busyMap)
		// 缓存命中：促销活动同样只来自上次真实上游响应，不回落本地文件
		return m.attachProbeStatus(m.cachedModels, m.cachedPromotions, accounts, nowMs)
	}

	// 1) 只以上游为准：按账号所属区域分别拉取，合并去重；同区域首个可用账号成功即标记完成
	merged := map[string]*Obj{}
	var order []*Obj
	mergedPromotions := map[string]*Obj{}
	var promoOrder []*Obj
	regionStat := map[string]int{}
	fetchedRegions := map[string]bool{}
	var failedRegions []string
	regionErrors := map[string]string{}

	for _, acc := range accounts {
		if acc.Status != "healthy" || acc.AccessToken == "" {
			continue
		}
		region := config.ResolveAccountRegion(acc)
		if fetchedRegions[region] {
			continue
		}
		ep := config.EndpointsFor(acc)
		h := http.Header{}
		h["Authorization"] = []string{"Bearer " + acc.AccessToken}
		h["User-Agent"] = []string{config.UserAgent}
		ctx, cancel := context.WithTimeout(context.Background(), GWModelConfigTimeoutMs)
		status, data, err := m.client.DoJSON(ctx, http.MethodGet, ep.Config, h, nil)
		cancel()
		if err != nil {
			if _, exists := regionErrors[region]; !exists {
				regionErrors[region] = err.Error()
			}
			continue
		}
		if !isOK(status) {
			continue
		}
		obj, err := ParseObj(data)
		if err != nil {
			// 等价 Node：res.json() 抛错进入 catch
			if _, exists := regionErrors[region]; !exists {
				regionErrors[region] = err.Error()
			}
			continue
		}
		dd := GetObj(obj, "data")
		models := GetArr(dd, "models")
		for _, pv := range GetArr(dd, "modelPromotions") {
			po, ok := pv.(*Obj)
			if !ok || GetString(po, "id") == "" {
				continue
			}
			id := GetString(po, "id")
			if _, exists := mergedPromotions[id]; !exists {
				promoOrder = append(promoOrder, po)
			}
			mergedPromotions[id] = po
		}
		if len(models) == 0 {
			continue
		}
		fetchedRegions[region] = true
		regionStat[region] = len(models)
		for _, mv := range models {
			mo, ok := mv.(*Obj)
			if !ok || GetString(mo, "id") == "" {
				continue
			}
			id := GetString(mo, "id")
			if exist, ok := merged[id]; ok {
				regions := GetArr(exist, "regions")
				has := false
				for _, r := range regions {
					if s, _ := r.(string); s == region {
						has = true
						break
					}
				}
				if !has {
					regions = append(regions, region)
					exist.Set("regions", regions)
				}
			} else {
				nm := mo.Clone()
				nm.Set("regions", []any{region})
				merged[id] = nm
				order = append(order, nm)
			}
		}
	}

	for _, r := range []string{config.RegionCn, config.RegionIntl} {
		if regionStat[r] == 0 {
			failedRegions = append(failedRegions, r)
		}
	}

	// 2) 只有真正从上游拿到数据，才更新内存缓存并返回
	if len(order) > 0 {
		allIds := make([]string, 0, len(order))
		for _, mm := range order {
			allIds = append(allIds, GetString(mm, "id"))
		}
		busyMap := m.FetchBusyLevels(allIds, forceRefresh)
		applyBusy(order, busyMap)

		m.cachedModels = order
		m.cachedPromotions = promoOrder
		m.lastFetch = nowMs

		cnCount, intlCount, bothCount := 0, 0, 0
		for _, mm := range order {
			regions := GetArr(mm, "regions")
			hasCn, hasIntl := false, false
			for _, r := range regions {
				if s, _ := r.(string); s == config.RegionCn {
					hasCn = true
				} else if s == config.RegionIntl {
					hasIntl = true
				}
			}
			if hasCn {
				cnCount++
			}
			if hasIntl {
				intlCount++
			}
			if hasCn && hasIntl {
				bothCount++
			}
		}
		cnAccCount, intlAccCount := 0, 0
		for _, a := range accounts {
			if a.Status != "healthy" {
				continue
			}
			switch config.ResolveAccountRegion(a) {
			case config.RegionCn:
				cnAccCount++
			case config.RegionIntl:
				intlAccCount++
			}
		}
		msg := "成功从上游拉取模型矩阵 (全局去重共 " + Itoa(len(order)) + " 款；国内版: " + Itoa(cnCount) + " 款 [" + Itoa(cnAccCount) + " 账号]，国际版: " + Itoa(intlCount) + " 款 [" + Itoa(intlAccCount) + " 账号]，两区通用: " + Itoa(bothCount) + " 款，活动: " + Itoa(len(promoOrder)) + " 项"
		if len(failedRegions) > 0 {
			msg += "，本次未拉到: " + strings.Join(failedRegions, "/")
		}
		msg += ")"
		logInfo(m.lg, "CONFIG", msg)
		return m.attachProbeStatus(order, promoOrder, accounts, nowMs)
	}

	// 3) 上游完全拿不到数据：如实返回空列表，并清空内存缓存
	m.cachedModels = nil
	m.cachedPromotions = nil
	m.lastFetch = 0
	var errParts []string
	for _, r := range failedRegions {
		if e, ok := regionErrors[r]; ok {
			errParts = append(errParts, r+": "+e)
		}
	}
	failed := strings.Join(failedRegions, "/")
	if failed == "" {
		failed = "未知"
	}
	msg := "上游 /v3/config 全部不可达（未拉到: " + failed
	if len(errParts) > 0 {
		msg += "，原因: " + strings.Join(errParts, "；")
	}
	msg += "），模型列表返回空。请检查账号健康度与网络连通性。"
	logWarn(m.lg, "CONFIG", msg)
	return m.attachProbeStatus(nil, nil, accounts, nowMs)
}

func applyBusy(models []*Obj, busyMap map[string]string) {
	for _, mm := range models {
		if lvl, ok := busyMap[strings.ToLower(GetString(mm, "id"))]; ok {
			mm.Set("busy", lvl)
			mm.Set("busy_level", lvl)
		}
	}
}

// ResolveModelPromotion 解析并关联单个模型的活动角标与促销详情（models.mjs:43-144）。
func ResolveModelPromotion(mo *Obj, promotions []*Obj) *Obj {
	if mo == nil {
		return nil
	}
	mId := strings.ToLower(strings.TrimSpace(GetString(mo, "id")))
	mName := strings.ToLower(strings.TrimSpace(GetString(mo, "name")))

	for _, p := range promotions {
		if p == nil {
			continue
		}
		if b, ok := GetBool(p, "enabled"); ok && !b {
			continue
		}
		var modelIds []string
		for _, x := range GetArr(p, "modelIds") {
			modelIds = append(modelIds, strings.ToLower(strings.TrimSpace(ToStr(x))))
		}
		match := containsString(modelIds, mId) || containsString(modelIds, mName)
		if !match {
			if rm := GetObj(mo, "relatedModels"); rm != nil {
				for _, v := range rm.Map() {
					if containsString(modelIds, strings.ToLower(strings.TrimSpace(ToStr(v)))) {
						match = true
						break
					}
				}
			}
		}
		if match {
			badge := GetObj(p, "badge")
			hover := GetObj(p, "hover")
			badgeOut := NewObj()
			badgeOut.Set("label", orTruthy(GetString(badge, "label"), "限时优惠"))
			badgeOut.Set("color", orTruthy(GetString(badge, "color"), "#009273"))
			badgeOut.Set("icon", orNull(badge.Get("icon")))
			badgeOut.Set("display", orTruthy(GetString(badge, "display"), "activeOnly"))
			hoverOut := NewObj()
			hoverOut.Set("textZh", orTruthy(GetString(hover, "textZh"), ""))
			hoverOut.Set("textEn", orTruthy(GetString(hover, "textEn"), ""))
			hoverOut.Set("action", orNull(hover.Get("action")))
			out := NewObj()
			out.Set("id", p.Get("id"))
			out.Set("kind", orTruthy(GetString(p, "kind"), "discount"))
			out.Set("badge", badgeOut)
			out.Set("hover", hoverOut)
			out.Set("discount", orNull(p.Get("discount")))
			out.Set("schedule", orNull(p.Get("schedule")))
			out.Set("source", "upstream")
			return out
		}
	}

	// 官方上游常态/内置规则兜底
	creditsStr := strings.ToLower(GetString(mo, "credits"))
	isFree := strings.Contains(creditsStr, "0.00") || strings.Contains(creditsStr, "0x")
	if isZero, isNum := numericExactZero(mo.Get("multiplier")); isNum && isZero {
		isFree = true
	}
	if isFree {
		out := NewObj()
		out.Set("id", "free-"+mId)
		out.Set("kind", "free")
		badge := NewObj().Set("label", "限时免费").Set("color", "#009273").Set("icon", nil)
		out.Set("badge", badge)
		out.Set("hover", NewObj().Set("textZh", "当前模型处于官方限时免费阶段，调用消耗 0 积分。"))
		out.Set("discount", NewObj().Set("factor", json.Number("0")).Set("discountedCredits", "0x"))
		out.Set("source", "preset")
		return out
	}
	if strings.Contains(mId, "deepseek-v4.1-flash") || strings.Contains(mId, "v4.1-flash") || strings.Contains(mName, "deepseek-v4.1-flash") {
		out := NewObj()
		out.Set("id", "ds-v4.1-flash-night-discount")
		out.Set("kind", "discount")
		out.Set("badge", NewObj().Set("label", "夜间折扣").Set("color", "#009273").Set("icon", nil))
		out.Set("hover", NewObj().Set("textZh", "周一至周五 09:00-12:00、14:00-18:00 属高峰原价，非高峰期积分5折 去使用"))
		out.Set("discount", NewObj().Set("factor", json.Number("0.5")).Set("discountedCredits", "0.055x"))
		out.Set("source", "preset")
		return out
	}
	if strings.Contains(mId, "glm-5.2") || strings.Contains(mName, "glm-5.2") {
		out := NewObj()
		out.Set("id", "glm-5.2-night-discount")
		out.Set("kind", "discount")
		out.Set("badge", NewObj().Set("label", "夜间折扣").Set("color", "#009273").Set("icon", nil))
		out.Set("hover", NewObj().Set("textZh", "周一至周五 09:00-12:00、14:00-18:00 属高峰原价，非高峰期积分5折"))
		out.Set("discount", NewObj().Set("factor", json.Number("0.5")).Set("discountedCredits", "0.395x"))
		out.Set("source", "preset")
		return out
	}
	return nil
}

// attachProbeStatus 为模型附加冷却探测与上游繁忙度评估（models.mjs:328-430）。
func (m *ModelCatalog) attachProbeStatus(models []*Obj, promotions []*Obj, accounts []*config.Account, nowMs int64) []*Obj {
	activePromotions := promotions
	if len(activePromotions) == 0 {
		activePromotions = m.cachedPromotions
	}
	out := make([]*Obj, 0, len(models))
	for _, mo := range models {
		promotion := ResolveModelPromotion(mo, activePromotions)
		coolingCount := 0
		coolingAccounts := []any{}
		id := GetString(mo, "id")
		for _, acc := range accounts {
			cd := acc.ModelCooldowns[id]
			if cd != 0 && nowMs < cd {
				coolingCount++
				remainingSec := (cd - nowMs + 999) / 1000
				accName := orElse(acc.Email, acc.UID)
				noteStr := strings.TrimSpace(acc.Note)
				displayName := accName
				if noteStr != "" {
					displayName = accName + " [" + noteStr + "]"
				}
				reason := acc.ModelCooldownReasons[id]
				if reason == "" {
					reason = "上游频控限制 (429/6004)"
				}
				coolingAccounts = append(coolingAccounts, NewObj().
					Set("uid", acc.UID).
					Set("name", displayName).
					Set("email", orElse(acc.Email, acc.UID)).
					Set("note", noteStr).
					Set("remainingSec", Num(remainingSec)).
					Set("reason", reason))
			}
		}
		totalAccounts := len(accounts)
		if totalAccounts < 1 {
			totalAccounts = 1
		}
		isCooling := coolingCount > 0 && coolingCount >= totalAccounts
		isPartialCooling := coolingCount > 0 && coolingCount < totalAccounts

		probeStatus := "idle"
		probeLabel := "🟢 畅通"
		if isCooling {
			probeStatus = "cooldown"
			probeLabel = "🔴 全池冷却 (" + Itoa(coolingCount) + "/" + Itoa(totalAccounts) + ")"
		} else if isPartialCooling {
			probeStatus = "busy"
			probeLabel = "🟡 局部限流 (" + Itoa(coolingCount) + "/" + Itoa(totalAccounts) + ")"
		}

		var upstreamBusyRaw any
		for _, k := range []string{"busy", "busy_level", "busyLevel"} {
			if v, ok := mo.GetOK(k); ok && Truthy(v) {
				upstreamBusyRaw = v
				break
			}
		}
		upstreamBusyLevel := "idle"
		upstreamBusyLabel := "🟢 空闲 (畅通)"
		upstreamBusyDesc := "上游官方节点正常在线，负载充裕"
		if upstreamBusyRaw != nil {
			rawStr := strings.ToLower(strings.TrimSpace(ToStr(upstreamBusyRaw)))
			switch rawStr {
			case "congested":
				upstreamBusyLevel, upstreamBusyLabel, upstreamBusyDesc = "congested", "🔴 拥堵", "上游官方实时标定: 极度拥堵 (congested)，排队时延较高"
			case "unavailable":
				upstreamBusyLevel, upstreamBusyLabel, upstreamBusyDesc = "unavailable", "🔴 不可用", "上游官方实时标定: 节点不可用 (unavailable)"
			case "busy":
				upstreamBusyLevel, upstreamBusyLabel, upstreamBusyDesc = "busy", "🟡 繁忙", "上游官方实时标定: 高载繁忙 (busy)"
			case "idle", "normal":
				upstreamBusyLevel, upstreamBusyLabel, upstreamBusyDesc = "idle", "🟢 空闲 (畅通)", "上游官方实时标定: 负载充裕通畅 (idle)"
			default:
				upstreamBusyLevel, upstreamBusyLabel, upstreamBusyDesc = "normal", "🟢 "+ToStr(upstreamBusyRaw), "上游官方标定状态: "+ToStr(upstreamBusyRaw)
			}
		} else {
			switch {
			case isCooling:
				upstreamBusyLevel, upstreamBusyLabel, upstreamBusyDesc = "overload", "🔴 上游限流", "上游官方该模型当前请求频繁，所有账号均触发频控限制"
			case isPartialCooling:
				upstreamBusyLevel, upstreamBusyLabel = "busy", "🟡 部分繁忙"
				upstreamBusyDesc = "上游官方个别账号已触达频控阈值 (" + Itoa(coolingCount) + "/" + Itoa(totalAccounts) + " 个账号降级冷却中)"
			default:
				upstreamBusyLevel, upstreamBusyLabel, upstreamBusyDesc = "idle", "🟢 空闲 (畅通)", "上游服务响应就绪，无拥堵限流记录"
			}
		}

		r := mo.Clone()
		r.Set("busy", upstreamBusyRaw)
		r.Set("busy_level", upstreamBusyRaw)
		r.Set("promotion", promotion)
		r.Set("probeStatus", probeStatus)
		r.Set("probeLabel", probeLabel)
		r.Set("totalAccounts", Num(int64(totalAccounts)))
		r.Set("coolingCount", Num(int64(coolingCount)))
		r.Set("coolingAccounts", coolingAccounts)
		r.Set("upstreamBusyLevel", upstreamBusyLevel)
		r.Set("upstreamBusyLabel", upstreamBusyLabel)
		r.Set("upstreamBusyDesc", upstreamBusyDesc)
		out = append(out, r)
	}
	return out
}

// ─── 小工具 ───────────────────────────────────────────────────────────────────

func toAnySlice(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}

func copyMap(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func containsString(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

func orTruthy(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

func orNull(v any) any {
	if Truthy(v) {
		return v
	}
	return nil
}

// numericExactZero 仅数值 0（JS `=== 0`，字符串 "0" 不算）。
func numericExactZero(v any) (bool, bool) {
	switch t := v.(type) {
	case json.Number:
		f, err := t.Float64()
		return f == 0, err == nil
	case float64:
		return t == 0, true
	case int:
		return t == 0, true
	}
	return false, false
}
