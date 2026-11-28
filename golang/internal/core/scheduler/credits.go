// 积分刷新 / Token 续期 / 闲置感知刷新（scheduler.mjs:504-749）。
package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/database"
	"codebuddy-gateway/internal/upstream"
)

// Round2 等价 JS `Math.round(x*100)/100`（.5 向正无穷取整）。
func Round2(v float64) float64 { return math.Floor(v*100+0.5) / 100 }

const (
	billingTimeout = 10 * time.Second
	// defaultTokenExpiresInSec 上游未返回 expires_in 时的默认有效期（30 天）。
	defaultTokenExpiresInSec = 2592000
)

func (s *Scheduler) rootCtx() context.Context {
	if s.ctx != nil {
		return s.ctx
	}
	return context.Background()
}

// billingHeaders 计费/鉴权接口公共请求头。
func billingHeaders(accessToken string) http.Header {
	h := http.Header{}
	h.Set("Authorization", "Bearer "+accessToken)
	h.Set("User-Agent", config.UserAgent)
	h.Set("Content-Type", "application/json")
	return h
}

func isOK(status int) bool { return status >= 200 && status < 300 }

// RefreshCredits 拉取官方 plans-usage 汇总刷新账号积分；必要时先换发新令牌。
func (s *Scheduler) RefreshCredits(uid string) {
	if s.client == nil {
		return
	}
	acc := s.accounts().Get(uid)
	if acc == nil || acc.AccessToken == "" {
		return
	}
	// 检查是否需要根据官方 /v2/plugin/auth/token/refresh 提前换发新令牌 (默认提前 7 天)
	advanceDays := s.store.Config().TokenRefreshAdvanceDaysOr()
	advanceMs := int64(advanceDays) * 24 * 60 * 60 * 1000
	nowMs := s.nowMs()
	needsRefresh := acc.RefreshToken != "" && (acc.ExpiresAt == 0 || nowMs > acc.ExpiresAt-advanceMs)
	if needsRefresh {
		s.lg.Info("AUTH", fmt.Sprintf("账号 [%s] 满足提前 %d 天换发条件，正在换发新令牌...", config.AccountFullDesc(acc), advanceDays))
		s.RefreshSessionToken(uid)
		acc = s.accounts().Get(uid)
		if acc == nil {
			return
		}
	}
	ep := s.epFn(acc)
	ctx, cancel := context.WithTimeout(s.rootCtx(), billingTimeout)
	defer cancel()
	status, body, err := s.client.DoJSON(ctx, http.MethodPost, ep.Summary, billingHeaders(acc.AccessToken), []byte("{}"))
	if err != nil {
		s.lg.Error("BILLING", fmt.Sprintf("账号 [%s] 刷新积分失败: %s", config.AccountFullDesc(acc), err.Error()))
		return
	}
	if !isOK(status) {
		// Node 版 res.ok=false 时静默跳过（无日志、不抛错）
		return
	}
	data, err := upstream.ParseObj(body)
	if err != nil {
		s.lg.Error("BILLING", fmt.Sprintf("账号 [%s] 刷新积分失败: %s", config.AccountFullDesc(acc), err.Error()))
		return
	}
	payload := upstream.GetObj(data, "data")
	if payload == nil {
		payload = data
	}
	newCredits := -1.0
	hasNew := false
	if upstream.Truthy(payload.Get("TotalCredits")) {
		newCredits = round2(numOr(payload.Get("TotalCredits"), 0))
		hasNew = true
	} else if pkgs := upstream.GetArr(payload, "Packages"); pkgs != nil {
		total := 0.0
		for _, pv := range pkgs {
			pkg, ok := pv.(*upstream.Obj)
			if !ok {
				continue
			}
			total += numOr(pkg.Get("CycleRemainCapacity"), 0)
		}
		newCredits = round2(total)
		hasNew = true
	}

	if hasNew {
		var prevCredits float64
		var displayName string
		changed := false
		s.accounts().Mutate(uid, func(x *config.Account) {
			prevCredits = x.CreditsRemain
			x.CreditsRemain = newCredits
			x.CreditsUpdatedAt = s.nowMs()
			changed = prevCredits != newCredits
			displayName = ""
			if strings.TrimSpace(x.Note) != "" {
				displayName = strings.TrimSpace(x.Note)
			} else {
				displayName = x.Email
				if displayName == "" {
					displayName = x.UID
				}
				if displayName == "" {
					displayName = "未知账号"
				}
			}
		})
		// [网关自有策略] 积分变动监控留痕：真实查到余额与上次比对，变动即留痕
		if changed && s.db != nil {
			delta := round2(newCredits - prevCredits)
			fmtPrev := formatEnUS(prevCredits)
			fmtNew := formatEnUS(newCredits)
			desc := fmt.Sprintf("余额 %s → %s", fmtPrev, fmtNew)
			s.db.RecordCreditChange(database.CreditRecord{
				AccountUID: uid, AccountName: displayName, Delta: delta, Balance: newCredits, Description: desc,
			})
			sign := ""
			if delta > 0 {
				sign = "+"
			}
			s.lg.Info("CREDIT_MONITOR", fmt.Sprintf("账号 [%s] 积分变动: %s%s (%s)", displayName, sign, num(delta), desc))
		}
	}

	// 积分已刷新充盈时，自动提前解除因 402/额度耗尽进入的全局冷却状态
	released := false
	var fullDesc string
	var creditsAfter float64
	s.accounts().Mutate(uid, func(x *config.Account) {
		if x.CreditsRemain > 0 && x.CooldownUntil != 0 && x.CooldownUntil > s.nowMs() {
			x.CooldownUntil = 0
			released = true
			fullDesc = config.AccountFullDesc(x)
			creditsAfter = x.CreditsRemain
		}
	})
	if released {
		s.lg.Info("COOLDOWN", fmt.Sprintf("账号 [%s] 积分已刷新充盈 (%s)，提前解除冷却状态", fullDesc, num(creditsAfter)))
	}
	// 清理已过期的单模型局部冷却记录
	s.accounts().Mutate(uid, func(x *config.Account) {
		nowTime := s.nowMs()
		for mID, expireAt := range x.ModelCooldowns {
			if nowTime >= expireAt {
				delete(x.ModelCooldowns, mID)
			}
		}
	})
	_ = s.store.SaveAccounts()
}

// StaleRefreshResult 对应 refreshStaleCredits 返回值。
type StaleRefreshResult struct {
	Refreshed int `json:"refreshed"`
	Skipped   int `json:"skipped"`
}

// ActiveRefreshResult 对应 refreshActiveAccountsIfStale 返回值。
type ActiveRefreshResult struct {
	SkippedAll bool   `json:"skippedAll,omitempty"`
	Refreshed  int    `json:"refreshed"`
	Skipped    int    `json:"skipped,omitempty"`
	Total      int    `json:"total,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

// RefreshActiveAccountsIfStale 闲置感知按需刷新：闲置则完全跳过；否则仅对近期活跃账号错峰刷新。
func (s *Scheduler) RefreshActiveAccountsIfStale() ActiveRefreshResult {
	if s.IsGatewayIdle(0) {
		return ActiveRefreshResult{SkippedAll: true, Reason: "idle"}
	}
	all := s.accounts().List()
	var active []*config.Account
	for _, a := range all {
		if a.AccessToken == "" {
			continue
		}
		if a.NeedsCreditRefresh || (a.LastUsedAt != 0 && a.LastUsedAt > a.CreditsUpdatedAt) {
			active = append(active, a)
		}
	}
	if len(active) == 0 {
		return ActiveRefreshResult{Refreshed: 0, Skipped: len(all), Reason: "no-active-changes"}
	}
	for i, a := range active {
		uid := a.UID
		s.after(time.Duration(i)*staggerIntervalMs, func() {
			s.spawn(func() {
				s.RefreshCredits(uid)
				s.accounts().Mutate(uid, func(x *config.Account) { x.NeedsCreditRefresh = false })
			})
		})
	}
	s.lg.Info("BILLING", fmt.Sprintf("闲置感知调度：针对 %d 个近期活跃账号执行积分账单同步", len(active)))
	return ActiveRefreshResult{Refreshed: len(active), Total: len(active)}
}

// RefreshStaleCredits 按需刷新积分（页面切换 / 手动刷新）：距上次成功刷新超过 minAgeMs 的账号并发拉取。
func (s *Scheduler) RefreshStaleCredits(minAgeMs int64, force bool) StaleRefreshResult {
	now := s.nowMs()
	refreshed, skipped := 0, 0
	var wg sync.WaitGroup
	for _, a := range s.accounts().List() {
		if a.AccessToken == "" {
			skipped++
			continue
		}
		if !force && a.CreditsUpdatedAt > 0 && now-a.CreditsUpdatedAt < minAgeMs {
			skipped++
			continue
		}
		wg.Add(1)
		go func(uid string) {
			defer wg.Done()
			s.RefreshCredits(uid)
			// refreshCredits 内部已记录日志
		}(a.UID)
		refreshed++
	}
	if refreshed > 0 {
		wg.Wait()
		s.lg.Info("BILLING", fmt.Sprintf("按需刷新积分：实际刷新 %d 个，跳过 %d 个（间隔未到或无 token）", refreshed, skipped))
	}
	return StaleRefreshResult{Refreshed: refreshed, Skipped: skipped}
}

// RefreshTokenResult 对应 refreshSessionToken 返回值。
type RefreshTokenResult struct {
	OK        bool    `json:"ok"`
	ExpiresAt int64   `json:"expiresAt,omitempty"`
	ExpiresIn float64 `json:"expiresIn,omitempty"`
	Msg       string  `json:"msg"`
}

// RefreshSessionToken 官方同款 Token 续期换发（对齐 ExternalLinkAuthenticationProvider.refreshSession）。
func (s *Scheduler) RefreshSessionToken(uid string) RefreshTokenResult {
	if s.client == nil {
		return RefreshTokenResult{OK: false, Msg: "上游客户端未初始化"}
	}
	acc := s.accounts().Get(uid)
	if acc == nil {
		return RefreshTokenResult{OK: false, Msg: "账号不存在"}
	}
	if acc.RefreshToken == "" {
		return RefreshTokenResult{OK: false, Msg: "该账号缺少 refreshToken，需重新扫码授权"}
	}
	// refresh token 按签发域校验，必须打回账号所属区域
	ep := s.epFn(acc)
	h := http.Header{}
	h.Set("X-Refresh-Token", acc.RefreshToken)
	h.Set("X-Auth-Refresh-Source", "plugin")
	h.Set("User-Agent", config.UserAgent)
	h.Set("Content-Type", "application/json")
	ctx, cancel := context.WithTimeout(s.rootCtx(), billingTimeout)
	defer cancel()
	status, body, err := s.client.DoJSON(ctx, http.MethodPost, ep.AuthRefresh, h, []byte("{}"))
	if err != nil {
		s.lg.Warn("AUTH", fmt.Sprintf("账号 [%s] 官方 Token 续期异常: %s", config.AccountFullDesc(acc), err.Error()))
		return RefreshTokenResult{OK: false, Msg: err.Error()}
	}
	if !isOK(status) {
		return RefreshTokenResult{OK: false, Msg: fmt.Sprintf("上游返回 HTTP %d: %s", status, string(body))}
	}
	data, err := upstream.ParseObj(body)
	if err != nil {
		s.lg.Warn("AUTH", fmt.Sprintf("账号 [%s] 官方 Token 续期异常: %s", config.AccountFullDesc(acc), err.Error()))
		return RefreshTokenResult{OK: false, Msg: err.Error()}
	}
	payload := upstream.GetObj(data, "data")
	if payload == nil {
		payload = data
	}
	newAccess := orElse(upstream.GetString(payload, "access_token"), upstream.GetString(payload, "accessToken"))
	if newAccess == "" {
		return RefreshTokenResult{OK: false, Msg: orElse(upstream.GetString(data, "msg"), "上游返回数据未包含有效 Token")}
	}
	newRefresh := orElse(upstream.GetString(payload, "refresh_token"), upstream.GetString(payload, "refreshToken"))
	expIn := float64(defaultTokenExpiresInSec)
	if v := firstTruthy(payload.Get("expires_in"), payload.Get("expiresIn")); v != nil {
		expIn = numOr(v, float64(defaultTokenExpiresInSec))
	}
	expiresAt := s.nowMs() + int64(expIn*1000)
	s.accounts().Mutate(uid, func(x *config.Account) {
		x.AccessToken = newAccess
		if newRefresh != "" {
			x.RefreshToken = newRefresh
		}
		x.ExpiresAt = expiresAt
		x.Status = "healthy"
	})
	s.lg.Info("AUTH", fmt.Sprintf("账号 [%s] 官方 Token 提前换发成功！(新有效时间: %s天, 有效期至: %s)",
		config.AccountFullDesc(acc), strconv.FormatFloat(expIn/86400, 'f', 1, 64), time.UnixMilli(expiresAt).Local().Format("2006/1/2 15:04:05")))
	_ = s.store.SaveAccounts()
	return RefreshTokenResult{
		OK: true, ExpiresAt: expiresAt, ExpiresIn: expIn,
		Msg: "新令牌换发成功，有效期至 " + time.UnixMilli(expiresAt).Local().Format("2006/1/2"),
	}
}

// ─── 官方 plans-usage 积分构成明细（scheduler.mjs:1063-1192） ─────────────────

var allPackageCodes = []string{
	"TCACA_code_002_AkiJS3ZHF5",
	"TCACA_code_007_nzdH5h4Nl0",
	"TCACA_code_008_cfWoLwvjU4",
	"TCACA_code_009_0XmEQc2xOf",
	"TCACA_code_023_4xbGhMrE6q",
	"TCACA_code_026_BaESVICNoi",
	"TCACA_code_027_0FCGVA6vSa",
	"TCACA_code_028_NtpWi0jzXs",
	"TCACA_code_029_6wCGEWquYy",
	"TCACA_code_030_BjSt89qTvr",
	"TCACA_code_038_OhvqZtiPKr",
	"TCACA_code_043_6oIkxT7Z0S",
	"TCACA_code_044_JRZ9sYCgua",
	"TCACA_code_045_JuyAXGlovx",
	"TCACA_code_046_LfNpbzEa5X",
}

const basePackageCode = "TCACA_code_008_cfWoLwvjU4"

func pkgAttr(p *upstream.Obj, key string) string {
	attrs := upstream.GetArr(p, "AccountAttributes")
	for _, av := range attrs {
		a, ok := av.(*upstream.Obj)
		if !ok {
			continue
		}
		if upstream.GetString(a, "Key") == key {
			return upstream.GetString(a, "Value")
		}
	}
	return ""
}

// GetAccountCreditDetails 拉取官方 plans-usage 积分构成明细；失败返回 {error}。
func (s *Scheduler) GetAccountCreditDetails(acc *config.Account) *upstream.Obj {
	if acc == nil || acc.AccessToken == "" {
		return upstream.NewObj().Set("error", "No active token")
	}
	if s.client == nil {
		return upstream.NewObj().Set("error", "上游客户端未初始化")
	}
	h := billingHeaders(acc.AccessToken)
	ep := s.epFn(acc)
	// 计费接口按账号区域选择 base（国际版与国内版路径一致）
	post := func(url string, reqBody []byte) (*upstream.Obj, error) {
		ctx, cancel := context.WithTimeout(s.rootCtx(), billingTimeout)
		defer cancel()
		status, body, err := s.client.DoJSON(ctx, http.MethodPost, url, h, reqBody)
		if err != nil {
			return nil, err
		}
		if !isOK(status) {
			return nil, fmt.Errorf("HTTP %d", status)
		}
		return upstream.ParseObj(body)
	}
	listBody, _ := upstream.MarshalJSON(upstream.NewObj().
		Set("PageNumber", upstream.Num(1)).Set("PageSize", upstream.Num(200)).
		Set("Status", []any{json.Number("0"), json.Number("2"), json.Number("3")}).Set("PackageCodes", allPackageCodes))

	summaryData := upstream.NewObj()
	freeAccounts := []any{}
	paidAccounts := []any{}
	fail := func(err error) *upstream.Obj {
		s.lg.Error("BILLING", fmt.Sprintf("获取账号 [%s] 官方积分明细失败: %s", acc.UID, err.Error()))
		return upstream.NewObj().Set("error", err.Error())
	}
	// 1. 套餐总览
	summary, err := post(ep.Summary, []byte("{}"))
	if err != nil {
		return fail(err)
	}
	if d := upstream.GetObj(summary, "data"); d != nil {
		summaryData = d
	}
	// 2. 免费/活动赠送包明细
	free, err := post(ep.APIBase+"/billing/meter/get-user-resource-free-packages", listBody)
	if err != nil {
		return fail(err)
	}
	freeData := upstream.GetObj(free, "data")
	if freeData == nil {
		freeData = upstream.NewObj()
	}
	if arr := upstream.GetArr(freeData, "Accounts"); arr != nil {
		freeAccounts = arr
	}
	// 3. 购买加量包明细（失败忽略）
	if paid, err := post(ep.APIBase+"/billing/meter/get-user-resource-paid-packages", listBody); err == nil {
		paidData := upstream.GetObj(paid, "data")
		if paidData == nil {
			paidData = upstream.NewObj()
		}
		if arr := upstream.GetArr(paidData, "Accounts"); arr != nil {
			paidAccounts = arr
		}
	}
	merged := append(append([]any{}, freeAccounts...), paidAccounts...)
	var active, usedUp []*upstream.Obj
	for _, pv := range merged {
		p, ok := pv.(*upstream.Obj)
		if !ok {
			continue
		}
		switch {
		case jsonNumZero(p.Get("Status")):
			active = append(active, p)
		case statusIs(p, 3):
			usedUp = append(usedUp, p)
		}
	}
	isPaid := func(id string) bool {
		for _, pv := range paidAccounts {
			pp, ok := pv.(*upstream.Obj)
			if ok && upstream.GetString(pp, "ResourceId") == id && id != "" {
				return true
			}
		}
		return false
	}
	baseCredits, rewardCredits, paidCredits := 0.0, 0.0, 0.0
	for _, p := range active {
		remain := numOr(firstTruthy(p.Get("CycleCapacityRemainPrecise"), p.Get("CapacityRemainPrecise")), 0)
		name := upstream.GetString(p, "PackageName")
		code := upstream.GetString(p, "PackageCode")
		switch {
		case code == basePackageCode || strings.Contains(name, "体验版") || strings.Contains(name, "基础"):
			baseCredits += remain
		case strings.Contains(code, "extra") || isPaid(upstream.GetString(p, "ResourceId")):
			paidCredits += remain
		default:
			rewardCredits += remain
		}
	}
	// 正在优先扣减中的包 (已消耗过但未耗尽)
	var inUsage *upstream.Obj
	for _, p := range active {
		if numOr(p.Get("CycleCapacityUsedPrecise"), 0) > 0 {
			inUsage = p
			break
		}
	}
	if inUsage == nil && len(active) > 0 {
		inUsage = active[0]
	}
	total := numOr(summaryData.Get("TotalCredits"), baseCredits+rewardCredits+paidCredits)
	res := upstream.NewObj().
		Set("totalCredits", numJSON(total)).
		Set("breakdown", upstream.NewObj().
			Set("baseCredits", numJSON(round2(baseCredits))).
			Set("paidCredits", numJSON(round2(paidCredits))).
			Set("rewardCredits", numJSON(round2(rewardCredits))))
	if inUsage != nil {
		size := numOr(inUsage.Get("CycleCapacitySizePrecise"), 0)
		used := numOr(inUsage.Get("CycleCapacityUsedPrecise"), 0)
		percent := 0.0
		if upstream.Truthy(inUsage.Get("CycleCapacitySizePrecise")) {
			percent = math.Round(used / size * 100)
		}
		res.Set("inUsagePackage", upstream.NewObj().
			Set("id", inUsage.Get("ResourceId")).
			Set("name", inUsage.Get("PackageName")).
			Set("grantReason", orElse(pkgAttr(inUsage, "grantReason"), upstream.GetString(inUsage, "PackageName"))).
			Set("total", numJSON(size)).Set("remain", numJSON(numOr(inUsage.Get("CycleCapacityRemainPrecise"), 0))).
			Set("used", numJSON(used)).Set("percent", numJSON(percent)))
	} else {
		res.Set("inUsagePackage", nil)
	}
	packagesList := []any{}
	for _, p := range active {
		packagesList = append(packagesList, upstream.NewObj().
			Set("id", p.Get("ResourceId")).
			Set("name", p.Get("PackageName")).
			Set("grantReason", orElse(pkgAttr(p, "grantReason"), upstream.GetString(p, "PackageName"))).
			Set("grantSource", orElse(pkgAttr(p, "grantSource"), "-")).
			Set("total", numJSON(numOr(firstTruthy(p.Get("CycleCapacitySizePrecise"), p.Get("CapacitySizePrecise")), 0))).
			Set("remain", numJSON(numOr(firstTruthy(p.Get("CycleCapacityRemainPrecise"), p.Get("CapacityRemainPrecise")), 0))).
			Set("used", numJSON(numOr(firstTruthy(p.Get("CycleCapacityUsedPrecise"), p.Get("CapacityUsedPrecise")), 0))).
			Set("startTime", strJS(p.Get("CycleStartTime"), "-")).
			Set("expireTime", strJS(p.Get("ExpiredTime"), "随月度周期重置")))
	}
	res.Set("activePackagesCount", upstream.Num(int64(len(active)))).
		Set("usedUpPackagesCount", upstream.Num(int64(len(usedUp)))).
		Set("totalPackagesCount", upstream.Num(int64(len(merged)))).
		Set("packagesList", packagesList)
	return res
}

func statusIs(p *upstream.Obj, want int) bool {
	if n, ok := p.Get("Status").(json.Number); ok {
		f, _ := n.Float64()
		return f == float64(want)
	}
	return false
}

// strJS `v || def`：真值原样输出（字符串），否则 def。
func strJS(v any, def string) any {
	if !upstream.Truthy(v) {
		return def
	}
	if s, ok := v.(string); ok {
		return s
	}
	return v
}

// ─── 积分消耗明细流水（scheduler.mjs:1214-1297） ────────────────────────────────

// UsageRecordOptions 查询参数：days 1–90（默认 7）、pageNum ≥1、pageSize 1–200（默认 20）。
type UsageRecordOptions struct {
	Days     *float64
	PageNum  *float64
	PageSize *float64
}

func clampNum(v *float64, def, min, max float64) float64 {
	if v == nil {
		return def
	}
	if math.IsNaN(*v) || math.IsInf(*v, 0) {
		return def
	}
	if *v < min {
		return min
	}
	if *v > max {
		return max
	}
	return *v
}

// GetAccountUsageRecords 拉取「积分消耗明细」流水（Web 站点专用接口，CLI 无对应实现）。
// 返回结构与 Node 一致：ok / error / records / total，成功时含 range/pageNum/pageSize/pageCredit。
func (s *Scheduler) GetAccountUsageRecords(acc *config.Account, opts UsageRecordOptions) *upstream.Obj {
	days := clampNum(opts.Days, 7, 1, 90)
	pageNum := clampNum(opts.PageNum, 1, 1, math.MaxFloat64)
	pageSize := clampNum(opts.PageSize, 20, 1, 200)
	nowT := s.now().Local()
	fromT := nowT.Add(-time.Duration(int64(days)-1) * 24 * time.Hour)
	fmtDate := func(t time.Time) string { return t.Format("2006-01-02") }
	ep := s.epFn(acc)
	h := billingHeaders(acc.AccessToken)
	h.Set("Accept", "application/json")
	// 企业账号需要带企业 ID 才能查到完整数据
	if entID := strings.TrimSpace(acc.EnterpriseID); entID != "" {
		h.Set("X-Enterprise-Id", entID)
	}
	body, _ := upstream.MarshalJSON(upstream.NewObj().
		Set("startTime", fmtDate(fromT)+" 00:00:00").
		Set("endTime", fmtDate(nowT)+" 23:59:59").
		Set("pageNum", numJSON(pageNum)).
		Set("pageSize", numJSON(pageSize)))
	if s.client == nil {
		return usageFail("上游客户端未初始化")
	}
	ctx, cancel := context.WithTimeout(s.rootCtx(), 20*time.Second)
	defer cancel()
	status, respBody, err := s.client.DoJSON(ctx, http.MethodPost, ep.APIBase+"/billing/meter/get-user-request-usage", h, body)
	if err != nil {
		s.lg.Error("BILLING", fmt.Sprintf("账号 [%s] 消耗明细请求异常: %s", config.AccountLogName(acc), err.Error()))
		return usageFail(err.Error())
	}
	payload, perr := upstream.ParseObj(respBody)
	if perr != nil {
		s.lg.Warn("BILLING", fmt.Sprintf("账号 [%s] 消耗明细返回非 JSON (HTTP %d)", config.AccountLogName(acc), status))
		return usageFail(fmt.Sprintf("返回非 JSON (HTTP %d)", status))
	}
	if !jsonNumZero(payload.Get("code")) {
		msg := upstream.GetString(payload, "msg")
		s.lg.Warn("BILLING", fmt.Sprintf("账号 [%s] 消耗明细查询失败: code=%s %s", config.AccountLogName(acc), upstream.ToStr(payload.Get("code")), msg))
		return usageFail(orElse(msg, "code "+upstream.ToStr(payload.Get("code"))))
	}
	d := upstream.GetObj(payload, "data")
	var rows []any
	if d != nil {
		if arr := upstream.GetArr(d, "data"); arr != nil {
			rows = arr
		}
	} else if arr, ok := payload.Get("data").([]any); ok {
		rows = arr
	}
	records := make([]any, 0, len(rows))
	totalCredit := 0.0
	for _, rv := range rows {
		r, ok := rv.(*upstream.Obj)
		if !ok {
			continue
		}
		credit := numOr(r.Get("credit"), 0)
		totalCredit += credit
		records = append(records, upstream.NewObj().
			Set("requestId", upstream.GetString(r, "requestId")).
			Set("credit", numJSON(credit)).
			Set("model", upstream.GetString(r, "model")).
			Set("client", upstream.GetString(r, "client")).
			// 官方字段名是 requestTime（不是 time/timestamp）
			Set("time", upstream.GetString(r, "requestTime")).
			// input 是全量提示词，inputTrunc 是截断版；两者都可能缺
			Set("inputFull", upstream.GetString(r, "input")).
			Set("inputTrunc", orElse(upstream.GetString(r, "inputTrunc"), upstream.GetString(r, "input"))).
			Set("agentPurpose", upstream.GetString(r, "agentPurpose")).
			Set("appType", upstream.GetString(r, "appType")).
			Set("subscribeType", upstream.GetString(r, "subscribeType")))
	}
	total := float64(len(records))
	if d != nil {
		if tv := numOr(d.Get("total"), 0); tv != 0 {
			total = tv
		}
	}
	return upstream.NewObj().
		Set("ok", true).
		Set("range", upstream.NewObj().Set("from", fmtDate(fromT)).Set("to", fmtDate(nowT)).Set("days", numJSON(days))).
		Set("pageNum", numJSON(pageNum)).
		Set("pageSize", numJSON(pageSize)).
		Set("total", numJSON(total)).
		Set("pageCredit", numJSON(round2(totalCredit))).
		Set("records", records)
}

func usageFail(errMsg string) *upstream.Obj {
	return upstream.NewObj().Set("ok", false).Set("error", errMsg).Set("records", []any{}).Set("total", upstream.Num(0))
}
