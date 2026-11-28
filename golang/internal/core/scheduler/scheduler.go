// Package scheduler 对应 Node 版 src/core/scheduler.mjs（AccountScheduler 静态类 → Scheduler 实例）：
// 会话粘性、账号池调度、冷却、积分刷新、Token 续期、每日签到、官方积分明细/消耗流水。
// 模块级状态（sessionStickyMap / rrIndex / lastApiCallTimestamp / postCallRefreshTimers）全部收敛到结构体字段。
package scheduler

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"codebuddy-gateway/internal/config"
	"codebuddy-gateway/internal/core/database"
	"codebuddy-gateway/internal/core/logger"
	"codebuddy-gateway/internal/upstream"
)

// ─── 官方 CLI 常量与时间基准（scheduler.mjs:23-45） ─────────────────────────────
// 以下三个常量保留为"CLI 原始基准值"，仅作为语义参考与回退兜底；网关粘性实际时长由
// config.stickySessionTtlMs / stickySessionMaxLifetimeMs 决定（默认 7 天，网关自有策略）。
const (
	// CLI: COMPLETED_TASK_TTL_MS=3e5 会话空闲保活 TTL（兜底，实际死分支）
	CLICompletedTaskTtlMs int64 = 300_000
	// CLI: CLEANUP_INTERVAL_MS=6e4 清理扫描周期
	CLICleanupIntervalMs int64 = 60_000
	// CLI: PROMPT_TIMEOUT_MS=18e5 会话绝对最大存活期（兜底）
	CLIPromptTimeoutMs int64 = 1_800_000
	// GatewayIdleThresholdMs 闲置感知阈值【网关自有策略】：15 分钟无请求则认定闲置。
	GatewayIdleThresholdMs int64 = 15 * 60 * 1000
	// staggerIntervalMs 活跃账号错峰刷新间隔【网关自有策略】。
	staggerIntervalMs = 300 * time.Millisecond
)

// postCallRefreshDelay 调用后防抖刷新延迟【网关自有策略】：等待上游计费出账 3.5 秒（测试可覆盖）。
var postCallRefreshDelay = 3500 * time.Millisecond

type stickyEntry struct {
	UID        string
	CreatedAt  int64
	LastActive int64
}

// SelectOpts 对应 selectAccount 的 options。
type SelectOpts struct {
	ExcludeUids []string
	Region      string
	Strategy    string
}

// Scheduler 账号池调度引擎。
type Scheduler struct {
	store  *config.Store
	db     *database.Engine
	lg     *logger.Logger
	client *upstream.Client
	now    func() time.Time
	epFn   func(*config.Account) config.Endpoints

	ctx     context.Context
	cancel  context.CancelFunc
	stopped chan struct{}
	once    sync.Once

	mu        sync.Mutex
	sticky    map[string]*stickyEntry
	rrIndex   int
	lastUID   string
	lastAt    int64
	postCall  map[string]*time.Timer
	timers    map[*time.Timer]struct{}
	lastApiAt atomic.Int64
	bg        sync.WaitGroup
}

// New 创建调度器；client 为上游 HTTP 客户端（nil 则不可刷新/签到）。
func New(store *config.Store, db *database.Engine, lg *logger.Logger, client *upstream.Client) *Scheduler {
	return &Scheduler{
		store: store, db: db, lg: lg, client: client, now: time.Now, epFn: config.EndpointsFor,
		stopped:  make(chan struct{}),
		sticky:   map[string]*stickyEntry{},
		postCall: map[string]*time.Timer{},
		timers:   map[*time.Timer]struct{}{},
	}
}

// SetClock 注入时钟（测试用）。
func (s *Scheduler) SetClock(fn func() time.Time) { s.now = fn }

// Start 绑定后台任务根 ctx。
func (s *Scheduler) Start(ctx context.Context) {
	s.ctx, s.cancel = context.WithCancel(ctx)
}

// Stop 停止所有定时器与后台刷新；未启动时直接返回。
func (s *Scheduler) Stop() {
	s.once.Do(func() {
		close(s.stopped)
		if s.cancel != nil {
			s.cancel()
		}
		s.mu.Lock()
		for _, t := range s.postCall {
			t.Stop()
		}
		s.postCall = map[string]*time.Timer{}
		for t := range s.timers {
			t.Stop()
		}
		s.timers = map[*time.Timer]struct{}{}
		s.mu.Unlock()
		s.bg.Wait()
	})
}

func (s *Scheduler) nowMs() int64 { return s.now().UnixMilli() }

func (s *Scheduler) accounts() *config.AccountStore { return s.store.Accounts() }

// after 注册受 Stop 管理的一次性定时器。
func (s *Scheduler) after(d time.Duration, fn func()) {
	t := time.AfterFunc(d, func() {
		select {
		case <-s.stopped:
			return
		default:
		}
		fn()
	})
	s.mu.Lock()
	s.timers[t] = struct{}{}
	s.mu.Unlock()
	time.AfterFunc(d+time.Second, func() {
		s.mu.Lock()
		delete(s.timers, t)
		s.mu.Unlock()
	})
}

// spawn 后台 goroutine（受 Stop 等待）。
func (s *Scheduler) spawn(fn func()) {
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		fn()
	}()
}

// ─── 会话粘性 ──────────────────────────────────────────────────────────────────

func (s *Scheduler) idleTtlMs(c *config.Config) int64 {
	if c.StickySessionTtlMs != nil && *c.StickySessionTtlMs > 0 {
		return *c.StickySessionTtlMs
	}
	return CLICompletedTaskTtlMs
}

func (s *Scheduler) maxLifetimeMs(c *config.Config) int64 {
	if c.StickySessionMaxLifetimeMs != nil && *c.StickySessionMaxLifetimeMs > 0 {
		return *c.StickySessionMaxLifetimeMs
	}
	return CLIPromptTimeoutMs
}

// SessionAffinityStats 会话粘性状态指标（scheduler.mjs:180-204）。
type SessionAffinityStats struct {
	Enabled           bool  `json:"enabled"`
	ActiveSessions    int   `json:"activeSessions"`
	TotalSessions     int   `json:"totalSessions"`
	IdleTtlMs         int64 `json:"idleTtlMs"`
	MaxLifetimeMs     int64 `json:"maxLifetimeMs"`
	CleanupIntervalMs int64 `json:"cleanupIntervalMs"`
}

// GetSessionAffinityStats 返回粘性统计。
func (s *Scheduler) GetSessionAffinityStats() SessionAffinityStats {
	now := s.nowMs()
	c := s.store.Config()
	idleTtl := s.idleTtlMs(c)
	maxLifetime := s.maxLifetimeMs(c)
	s.mu.Lock()
	defer s.mu.Unlock()
	active := 0
	for _, v := range s.sticky {
		if now-v.LastActive <= idleTtl && (v.CreatedAt == 0 || now-v.CreatedAt <= maxLifetime) {
			active++
		}
	}
	return SessionAffinityStats{
		Enabled: c.IsStickySessionEnabled(), ActiveSessions: active, TotalSessions: len(s.sticky),
		IdleTtlMs: idleTtl, MaxLifetimeMs: maxLifetime, CleanupIntervalMs: CLICleanupIntervalMs,
	}
}

// CleanExpiredSessions 清理过期的会话粘性记录（scheduler.mjs:150-169）；返回清理数。
func (s *Scheduler) CleanExpiredSessions() int {
	now := s.nowMs()
	c := s.store.Config()
	idleTtl := s.idleTtlMs(c)
	maxLifetime := s.maxLifetimeMs(c)
	s.mu.Lock()
	defer s.mu.Unlock()
	cleaned := 0
	for k, v := range s.sticky {
		if now-v.LastActive > idleTtl || (v.CreatedAt != 0 && now-v.CreatedAt > maxLifetime) {
			delete(s.sticky, k)
			cleaned++
		}
	}
	return cleaned
}

// ClearSticky 手动清空所有会话粘性记录；返回清理数。
func (s *Scheduler) ClearSticky() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.sticky)
	s.sticky = map[string]*stickyEntry{}
	return n
}

// UnbindSticky 对应 adapters 中的 `sessionStickyMap.get(key)?.uid === acc.uid → delete`：
// 仅当该会话当前粘住的正是 uid 时才解绑；返回是否解绑。
func (s *Scheduler) UnbindSticky(sessionKey, uid string) bool {
	if sessionKey == "" || uid == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.sticky[sessionKey]; ok && e.UID == uid {
		delete(s.sticky, sessionKey)
		return true
	}
	return false
}

// ─── 账号池调度引擎（scheduler.mjs:221-378） ───────────────────────────────────

func (s *Scheduler) matchesPinned(a *config.Account, target string) bool {
	if a.UID != "" && strings.ToLower(a.UID) == target {
		return true
	}
	if a.Uin != "" && strings.ToLower(a.Uin) == target {
		return true
	}
	if a.Email != "" && strings.ToLower(a.Email) == target {
		return true
	}
	return a.Note != "" && strings.Contains(strings.ToLower(a.Note), target)
}

func ceilDivMs(ms int64) int64 {
	if ms <= 0 {
		return 0
	}
	return (ms + 999) / 1000
}

// SelectAccount 选号：全局指定账号 → 粘性复用 → 候选池过滤 → 按策略选号。
// 返回账号快照（调用方通过 Accounts().Acquire/Release 维护并发计数）；无可用账号返回 nil。
func (s *Scheduler) SelectAccount(requestedModel, sessionKey string, opt SelectOpts) *config.Account {
	now := s.nowMs()
	c := s.store.Config()
	maxLimit := 9999
	if c.IsConcurrencyLimitEnabled() {
		maxLimit = c.MaxInFlight()
	}
	exclude := opt.ExcludeUids
	strategy := opt.Strategy
	if strategy == "" {
		strategy = c.RoutingStrategy
	}
	if strategy == "" {
		strategy = "least-inflight"
	}
	// 区域限制：显式 region 最高优先级；否则按全局 routingRegionScope
	var forcedRegion, globalScope string
	if opt.Region != "" {
		forcedRegion = config.NormalizeRegion(opt.Region)
	}
	if c.RoutingRegionScope != "" && c.RoutingRegionScope != "all" {
		globalScope = config.NormalizeRegion(c.RoutingRegionScope)
	}
	effectiveRegion := forcedRegion
	if effectiveRegion == "" {
		effectiveRegion = globalScope
	}
	regionAllowed := func(a *config.Account) bool {
		return effectiveRegion == "" || config.ResolveAccountRegion(a) == effectiveRegion
	}
	excluded := func(uid string) bool {
		for _, u := range exclude {
			if u == uid {
				return true
			}
		}
		return false
	}

	// 1. 全局指定账号
	if c.PinnedAccount != "" {
		target := strings.ToLower(strings.TrimSpace(c.PinnedAccount))
		matched := s.accounts().Find(func(a *config.Account) bool { return s.matchesPinned(a, target) })
		if matched != nil {
			restrictedReason := ""
			switch {
			case !regionAllowed(matched):
				restrictedReason = fmt.Sprintf("区域不符 (需要 %s)", effectiveRegion)
			case excluded(matched.UID):
				restrictedReason = "本轮重试已尝试过"
			case matched.Status != "healthy":
				restrictedReason = fmt.Sprintf("状态异常 (%s)", matched.Status)
			case now < matched.CooldownUntil:
				restrictedReason = fmt.Sprintf("处于全局冷却期 (剩 %d秒)", ceilDivMs(matched.CooldownUntil-now))
			case requestedModel != "" && matched.ModelCooldowns[requestedModel] > now:
				restrictedReason = fmt.Sprintf("模型 [%s] 处于限流冷却中 (剩 %d秒)", requestedModel, ceilDivMs(matched.ModelCooldowns[requestedModel]-now))
			case c.IsConcurrencyLimitEnabled() && matched.InFlight >= maxLimit:
				restrictedReason = fmt.Sprintf("并发达到上限 (%d/%d)", matched.InFlight, maxLimit)
			}
			if restrictedReason != "" {
				s.lg.Warn("DISPATCH", fmt.Sprintf("全局指定账号 [%s] 受到限制 (%s)，已自动切换回账号池动态轮换", config.AccountLogName(matched), restrictedReason))
			} else {
				s.lg.Info("DISPATCH", fmt.Sprintf("精准路由至网关全局指定账号 [%s]", config.AccountFullDesc(matched)))
				s.mu.Lock()
				s.lastUID, s.lastAt = matched.UID, now
				s.mu.Unlock()
				return matched
			}
		} else {
			s.lg.Warn("DISPATCH", fmt.Sprintf("未找到全局指定账号 [%s]，自动切换至账号池调度", target))
		}
	}

	// 2. 会话粘性复用
	stickyEnabled := c.IsStickySessionEnabled()
	if stickyEnabled && sessionKey != "" {
		s.mu.Lock()
		sticky := s.sticky[sessionKey]
		s.mu.Unlock()
		if sticky != nil {
			idleTtl := s.idleTtlMs(c)
			maxLifetime := s.maxLifetimeMs(c)
			isIdleExpired := now-sticky.LastActive > idleTtl
			isLifetimeExpired := sticky.CreatedAt != 0 && now-sticky.CreatedAt > maxLifetime
			if isIdleExpired || isLifetimeExpired {
				s.mu.Lock()
				delete(s.sticky, sessionKey)
				s.mu.Unlock()
			} else if !excluded(sticky.UID) {
				acc := s.accounts().Get(sticky.UID)
				if acc != nil && regionAllowed(acc) && acc.Status == "healthy" && now > acc.CooldownUntil && acc.InFlight < maxLimit {
					isModelCooling := requestedModel != "" && acc.ModelCooldowns[requestedModel] > now
					if !isModelCooling {
						s.mu.Lock()
						sticky.LastActive = now
						remainingSec := int64(math.Round(float64(idleTtl-(now-sticky.LastActive)) / 1000))
						if remainingSec < 0 {
							remainingSec = 0
						}
						s.lastUID, s.lastAt = acc.UID, now
						s.mu.Unlock()
						// 【D1 照搬】先更新 lastActive 再算剩余保活 → 恒为满 TTL
						s.lg.Info("DISPATCH", fmt.Sprintf("粘性会话复用账号 [%s] (会话: %s, 剩余保活: %ds)", config.AccountFullDesc(acc), jsSlice(sessionKey, 8), remainingSec),
							"sessionKey", jsSlice(sessionKey, 8), "model", requestedModel)
						return acc
					}
				} else {
					s.mu.Lock()
					delete(s.sticky, sessionKey)
					s.mu.Unlock()
					s.lg.Info("DISPATCH", fmt.Sprintf("粘性会话绑定的账号 [%s] 当前受限或并发饱和，已自动解绑并平滑回落至账号池选号", sticky.UID))
				}
			}
		}
	}

	// 3. 候选池过滤（含副作用：清理过期冷却）
	var candidates []*config.Account
	for _, a := range s.accounts().List() {
		if a.Status != "healthy" {
			continue
		}
		if a.CooldownUntil != 0 && now >= a.CooldownUntil {
			s.accounts().Mutate(a.UID, func(x *config.Account) { x.CooldownUntil = 0 })
			a.CooldownUntil = 0
		}
		if a.CooldownUntil != 0 && now < a.CooldownUntil {
			continue
		}
		if excluded(a.UID) {
			continue
		}
		if !regionAllowed(a) {
			continue
		}
		if requestedModel != "" && a.ModelCooldowns != nil {
			if exp := a.ModelCooldowns[requestedModel]; exp != 0 {
				if now >= exp {
					s.accounts().Mutate(a.UID, func(x *config.Account) { delete(x.ModelCooldowns, requestedModel) })
					delete(a.ModelCooldowns, requestedModel)
				} else {
					continue
				}
			}
		}
		if c.IsConcurrencyLimitEnabled() && a.InFlight >= maxLimit {
			continue
		}
		candidates = append(candidates, a)
	}
	if len(candidates) == 0 {
		return nil
	}

	// 4. 按策略选号
	var chosen *config.Account
	switch strategy {
	case "round-robin":
		s.mu.Lock()
		idx := s.rrIndex % len(candidates)
		chosen = candidates[idx]
		s.rrIndex = (idx + 1) % len(candidates)
		s.mu.Unlock()
	case "credits":
		sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].CreditsRemain > candidates[j].CreditsRemain })
		chosen = candidates[0]
	default:
		sort.SliceStable(candidates, func(i, j int) bool {
			if candidates[i].InFlight != candidates[j].InFlight {
				return candidates[i].InFlight < candidates[j].InFlight
			}
			return candidates[i].CreditsRemain > candidates[j].CreditsRemain
		})
		chosen = candidates[0]
	}

	if sessionKey != "" && stickyEnabled {
		s.mu.Lock()
		s.sticky[sessionKey] = &stickyEntry{UID: chosen.UID, CreatedAt: now, LastActive: now}
		s.mu.Unlock()
	}
	s.lg.Info("DISPATCH", fmt.Sprintf("调度选中账号 [%s] (策略: %s, 并发: %d, 剩余积分: %s)", config.AccountFullDesc(chosen), strategy, chosen.InFlight, num(chosen.CreditsRemain)), "model", requestedModel)
	s.mu.Lock()
	s.lastUID, s.lastAt = chosen.UID, now
	s.mu.Unlock()
	return chosen
}

// ─── 当前活跃账号信息（scheduler.mjs:381-481） ─────────────────────────────────

// CurrentActiveAccountInfo 供控制台概览；返回与 Node 字段一致的有序对象。
func (s *Scheduler) CurrentActiveAccountInfo() *upstream.Obj {
	now := s.nowMs()
	c := s.store.Config()
	isPinned := c.PinnedAccount != ""
	target := strings.ToLower(strings.TrimSpace(c.PinnedAccount))
	var pinnedAcc *config.Account
	if isPinned {
		pinnedAcc = s.accounts().Find(func(a *config.Account) bool { return s.matchesPinned(a, target) })
	}
	var activeAcc *config.Account
	mode := "pool"
	modeLabel := "账号池自动轮换"
	pinnedRestricted := false
	restrictedReason := ""
	if pinnedAcc != nil {
		if pinnedAcc.Status != "healthy" {
			pinnedRestricted = true
			restrictedReason = fmt.Sprintf("状态异常 (%s)", pinnedAcc.Status)
		} else if pinnedAcc.CooldownUntil != 0 && now < pinnedAcc.CooldownUntil {
			pinnedRestricted = true
			restrictedReason = fmt.Sprintf("全局冷却期 (剩 %d秒)", ceilDivMs(pinnedAcc.CooldownUntil-now))
		} else {
			for _, exp := range pinnedAcc.ModelCooldowns {
				if now < exp {
					pinnedRestricted = true
					restrictedReason = "部分模型限流冷却中"
					break
				}
			}
		}
		if !pinnedRestricted {
			activeAcc = pinnedAcc
			mode = "pinned"
			modeLabel = "全局指定账号 (服务中)"
		} else {
			mode = "pool"
			modeLabel = fmt.Sprintf("账号池动态轮换 (指定账号受限: %s)", restrictedReason)
		}
	}
	var globalScope string
	if c.RoutingRegionScope != "" && c.RoutingRegionScope != "all" {
		globalScope = config.NormalizeRegion(c.RoutingRegionScope)
	}
	scopeDesc := "全量池"
	switch globalScope {
	case "cn":
		scopeDesc = "国内版"
	case "intl":
		scopeDesc = "国外/国际版"
	}
	if activeAcc == nil {
		s.mu.Lock()
		lastUID := s.lastUID
		s.mu.Unlock()
		if lastUID != "" {
			activeAcc = s.accounts().Find(func(a *config.Account) bool {
				return a.UID == lastUID && a.Status == "healthy" && (globalScope == "" || config.ResolveAccountRegion(a) == globalScope)
			})
			if activeAcc != nil && !strings.Contains(modeLabel, "指定账号受限") {
				modeLabel = fmt.Sprintf("账号池轮换 [%s] (最近执行)", scopeDesc)
			}
		}
	}
	if activeAcc == nil && s.accounts().Len() > 0 {
		list := s.accounts().List()
		for _, a := range list {
			if a.Status == "healthy" && now > a.CooldownUntil && (globalScope == "" || config.ResolveAccountRegion(a) == globalScope) {
				activeAcc = a
				break
			}
		}
		if activeAcc == nil {
			for _, a := range list {
				if globalScope == "" || config.ResolveAccountRegion(a) == globalScope {
					activeAcc = a
					break
				}
			}
		}
		if activeAcc == nil {
			activeAcc = list[0]
		}
		if !strings.Contains(modeLabel, "指定账号受限") {
			modeLabel = fmt.Sprintf("账号池轮换 [%s] (当前就绪)", scopeDesc)
		}
	}
	if activeAcc == nil {
		return upstream.NewObj().
			Set("hasAccount", false).Set("isPinned", false).Set("pinnedRestricted", false).
			Set("mode", "none").Set("modeLabel", "暂无可用账号").Set("displayName", "暂无账号").
			Set("name", "暂无账号").Set("note", "").Set("uid", "").Set("creditsRemain", numJSON(0)).
			Set("inFlight", upstream.Num(0)).Set("status", "none")
	}
	noteStr := strings.TrimSpace(activeAcc.Note)
	nameStr := orElse(activeAcc.Email, activeAcc.UID)
	fullDisplayName := nameStr
	if noteStr != "" {
		fullDisplayName = nameStr + " [" + noteStr + "]"
	}
	pinnedName := ""
	if pinnedAcc != nil {
		if pinnedAcc.Note != "" {
			pinnedName = orElse(pinnedAcc.Email, pinnedAcc.UID) + " [" + pinnedAcc.Note + "]"
		} else {
			pinnedName = orElse(pinnedAcc.Email, pinnedAcc.UID)
		}
	}
	strategy := c.RoutingStrategy
	if strategy == "" {
		strategy = "least-inflight"
	}
	scope := c.RoutingRegionScope
	if scope == "" {
		scope = "all"
	}
	return upstream.NewObj().
		Set("hasAccount", true).Set("isPinned", isPinned).Set("pinnedRestricted", pinnedRestricted).
		Set("restrictedReason", restrictedReason).Set("pinnedAccountName", pinnedName).
		Set("mode", mode).Set("modeLabel", modeLabel).Set("uid", activeAcc.UID).
		Set("name", nameStr).Set("note", noteStr).Set("displayName", fullDisplayName).
		Set("creditsRemain", numJSON(activeAcc.CreditsRemain)).
		Set("inFlight", upstream.Num(int64(activeAcc.InFlight))).Set("status", orElse(activeAcc.Status, "healthy")).
		Set("isCooldown", now < activeAcc.CooldownUntil).Set("strategy", strategy).Set("routingRegionScope", scope)
}

// ─── 冷却（scheduler.mjs:483-502） ─────────────────────────────────────────────

// Cooldown 账号全局冷却。
func (s *Scheduler) Cooldown(uid string, seconds int, reason string) {
	acc := s.accounts().Get(uid)
	if acc == nil {
		return
	}
	until := s.nowMs() + int64(seconds)*1000
	s.accounts().Mutate(uid, func(x *config.Account) { x.CooldownUntil = until })
	s.lg.Warn("COOLDOWN", fmt.Sprintf("账号 [%s] 全局冷却 %d秒", config.AccountFullDesc(acc), seconds), "reason", reason)
	_ = s.store.SaveAccounts()
}

// CooldownModel 账号单模型局部冷却（默认 600 秒）。
func (s *Scheduler) CooldownModel(uid, modelID string, seconds int, reason string) {
	acc := s.accounts().Get(uid)
	if acc == nil {
		return
	}
	storedReason := orElse(reason, "上游模型限频冷却")
	until := s.nowMs() + int64(seconds)*1000
	s.accounts().Mutate(uid, func(x *config.Account) {
		if x.ModelCooldowns == nil {
			x.ModelCooldowns = map[string]int64{}
		}
		if x.ModelCooldownReasons == nil {
			x.ModelCooldownReasons = map[string]string{}
		}
		x.ModelCooldowns[modelID] = until
		x.ModelCooldownReasons[modelID] = storedReason
	})
	s.lg.Warn("COOLDOWN", fmt.Sprintf("账号 [%s] 模型 [%s] 局部冷却 %d秒", config.AccountFullDesc(acc), modelID, seconds), "reason", reason)
	_ = s.store.SaveAccounts()
}

// ─── 调用记录与闲置感知（scheduler.mjs:599-628） ──────────────────────────────

// RecordApiUsage 记录业务 API 调用：刷新全局活跃时间戳、标记账号待刷新、3.5s 防抖后刷新积分。
func (s *Scheduler) RecordApiUsage(uid string) {
	now := s.nowMs()
	s.lastApiAt.Store(now)
	if uid == "" {
		return
	}
	if s.accounts().Get(uid) == nil {
		return
	}
	s.accounts().Mutate(uid, func(x *config.Account) {
		x.LastUsedAt = now
		x.NeedsCreditRefresh = true
	})
	s.mu.Lock()
	if t, ok := s.postCall[uid]; ok {
		t.Stop()
	}
	s.postCall[uid] = time.AfterFunc(postCallRefreshDelay, func() {
		s.mu.Lock()
		delete(s.postCall, uid)
		s.mu.Unlock()
		s.spawn(func() {
			s.RefreshCredits(uid)
			s.accounts().Mutate(uid, func(x *config.Account) { x.NeedsCreditRefresh = false })
		})
	})
	s.mu.Unlock()
}

// IsGatewayIdle 距上次业务 API 调用是否超过阈值。
func (s *Scheduler) IsGatewayIdle(thresholdMs int64) bool {
	if thresholdMs <= 0 {
		thresholdMs = GatewayIdleThresholdMs
	}
	last := s.lastApiAt.Load()
	if last == 0 {
		return true
	}
	return s.nowMs()-last > thresholdMs
}

// LastApiCallTime 最近一次业务调用时间戳。
func (s *Scheduler) LastApiCallTime() int64 { return s.lastApiAt.Load() }

// ─── 会话标识提取（scheduler.mjs:67-145） ─────────────────────────────────────

var sessionHeaderKeys = []string{"x-session-id", "x-conversation-id", "session-id", "conversation-id", "x-chat-id", "anthropic-conversation-id"}

// ExtractSessionKey 提取会话粘性标识：Header → Payload → 上下文指纹(MD5) → 随机 UUID。
// headers 为下游请求头（Node 版 req.headers 已小写化；多值以 ", " 连接）。
func ExtractSessionKey(headers http.Header, payload *upstream.Obj) string {
	for _, hk := range sessionHeaderKeys {
		if vals := headers.Values(hk); len(vals) > 0 {
			val := strings.TrimSpace(strings.Join(vals, ", "))
			if val != "" {
				return val
			}
		}
	}
	if payload != nil {
		for _, k := range []string{"user", "session_id", "conversation_id", "chat_id"} {
			if v := strings.TrimSpace(upstream.GetString(payload, k)); v != "" {
				return v
			}
		}
		if meta := upstream.GetObj(payload, "metadata"); meta != nil {
			for _, k := range []string{"user_id", "session_id", "conversation_id"} {
				if v := strings.TrimSpace(upstream.GetString(meta, k)); v != "" {
					return v
				}
			}
		}
	}
	sysText, firstUser := "", ""
	if payload != nil {
		if sys := payload.Get("system"); sys != nil {
			switch sv := sys.(type) {
			case string:
				sysText = sv
			case []any:
				var parts []string
				for _, b := range sv {
					if bo, ok := b.(*upstream.Obj); ok {
						if t := upstream.GetString(bo, "text"); t != "" {
							parts = append(parts, t)
						}
					}
				}
				sysText = strings.Join(parts, "\n")
			}
		}
		if msgs, ok := payload.Get("messages").([]any); ok {
			for _, mv := range msgs {
				m, ok := mv.(*upstream.Obj)
				if !ok {
					continue
				}
				role := upstream.GetString(m, "role")
				if role == "system" && sysText == "" {
					sysText = contentToText(m)
				} else if role == "user" && firstUser == "" {
					firstUser = contentToText(m)
				}
				if sysText != "" && firstUser != "" {
					break
				}
			}
		}
	}
	if sysText != "" || firstUser != "" {
		seed := ""
		if sysText != "" {
			seed += "sys:" + jsSlice(sysText, 500) + "|"
		}
		if firstUser != "" {
			seed += "user:" + jsSlice(firstUser, 500)
		}
		sum := md5.Sum([]byte(seed))
		return hex.EncodeToString(sum[:])
	}
	return upstream.UUIDv4()
}

func contentToText(m *upstream.Obj) string {
	switch cv := m.Get("content").(type) {
	case string:
		return cv
	case nil:
		if _, ok := m.GetOK("content"); !ok {
			return "undefined"
		}
		return "null"
	default:
		b, _ := upstream.MarshalJSON(cv)
		return string(b)
	}
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────

func jsSlice(s string, n int) string {
	if upstream.JSLength(s) <= n {
		return s
	}
	r := []rune(s)
	out := ""
	for _, c := range r {
		if upstream.JSLength(out)+utf8Len(c) > n {
			break
		}
		out += string(c)
	}
	return out
}

func utf8Len(r rune) int {
	if r > 0xFFFF {
		return 2
	}
	return 1
}

func orElse(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

// num JS Number → string（整数无小数点，最多保留必要小数；|x|≥1e21 走指数记法，与 JS 一致）。
func num(v float64) string {
	if v == 0 {
		return "0"
	}
	if a := math.Abs(v); a >= 1e21 || a < 1e-6 {
		return strconv.FormatFloat(v, 'e', -1, 64)
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}

func round2(v float64) float64 { return Round2(v) }

// numJSON 输出与 JS 一致的数字字面量。
func numJSON(v float64) json.Number { return json.Number(num(v)) }

// formatEnUS 等价 toLocaleString('en-US', {maximumFractionDigits: 2})。
func formatEnUS(v float64) string {
	r := round2(v)
	s := strconv.FormatFloat(r, 'f', -1, 64)
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	intPart, frac := s, ""
	if i := strings.IndexByte(s, '.'); i >= 0 {
		intPart, frac = s[:i], s[i:]
	}
	var b strings.Builder
	for i, c := range intPart {
		if i > 0 && (len(intPart)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	out := b.String() + frac
	if neg {
		out = "-" + out
	}
	return out
}

// jsonNumZero 仅数值 0（JS `=== 0`）。
func jsonNumZero(v any) bool {
	if n, ok := v.(json.Number); ok {
		return n.String() == "0"
	}
	f, ok := v.(float64)
	return ok && f == 0
}

// numOr parseFloat(v || def)：v 为假值时取 def；否则解析数字。
func numOr(v any, def float64) float64 {
	if !upstream.Truthy(v) {
		return def
	}
	if f, ok := upstream.GetNum(v); ok {
		return f
	}
	return 0
}

// firstTruthy 返回首个真值（可能为 nil）。
func firstTruthy(vals ...any) any {
	for _, v := range vals {
		if upstream.Truthy(v) {
			return v
		}
	}
	return nil
}

// strOr `a || b` 字符串版。
func strOr(a, b string) string { return orElse(a, b) }
