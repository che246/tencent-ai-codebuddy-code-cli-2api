// Command gateway 对应 gateway.mjs + server.mjs 的启动装配：
// 初始化配置/数据库/日志/TLS/上游客户端/调度器/统计，注册路由总线，拉起后台定时任务并监听端口。
package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
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
	"codebuddy-gateway/internal/web"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "[FATAL]", err)
		os.Exit(1)
	}
}

func run() error {
	// ─── 1. 配置与账号池（config.mjs 模块初始化 + ensureApiKey）───
	dataDir := config.ResolveDataDir()
	if v := strings.TrimSpace(os.Getenv("GW_DATA_DIR")); v != "" {
		dataDir = v
	}
	store, err := config.Open(dataDir)
	if err != nil {
		return fmt.Errorf("配置加载失败: %w", err)
	}
	paths := store.Paths()

	// ─── 2. 日志数据库 + 日志器 ───
	db := database.Open(paths.LogDBPath, func() int { return store.Config().MaxLogDbSizeMbOr() })
	lg := logger.New(db, paths.LogFilePath)

	// ─── 3. 官方同款 TLS 证书栈与上游客户端（server.mjs:78）───
	tlsStack := tlscerts.Load(lg)
	client := upstream.NewClient(tlsStack.Pool(), tlsStack.InsecureSkipVerify(), lg)

	// ─── 4. 统计 / 定价 / 模型目录 / 调度器 ───
	mt := metrics.New(paths, paths.LogFilePath)
	pr := pricing.NewStore(paths)
	models := upstream.NewModelCatalog(client, store.Accounts(), lg, paths.DataDir)
	sched := scheduler.New(store, db, lg, client)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sched.Start(ctx)

	deps := &adapters.Deps{Store: store, Sched: sched, Models: models, Metrics: mt, Client: client, Lg: lg}
	handler := web.New(store, sched, deps, db, pr, mt, tlsStack, lg)

	// ─── 3. 后台定时任务 (server.mjs:240-256) ───
	// 按需闲置感知：若长时间无业务调用，停止空转轮询；非闲置时仅同步近期活跃账号
	go every(ctx, 5*time.Minute, func() { sched.RefreshActiveAccountsIfStale() })
	// 每小时自动执行日志轮转：严格仅保留最近 3 天的日志
	go every(ctx, time.Hour, func() { lg.PruneOldLogs(3) })
	// 每小时自动巡检签到状态：如果当天已签到则直接跳过，次日跨天或有未签到账号时自动补签
	autoCheckin := store.Config().AutoCheckin == nil || *store.Config().AutoCheckin
	if autoCheckin {
		go func() {
			sched.CheckAndRunHourlyCheckin(false)
			every(ctx, time.Hour, func() { sched.CheckAndRunHourlyCheckin(false) })
		}()
	}

	// ─── 启动时初始化：清理过期日志并主动预热刷新所有账号积分 (server.mjs:258-297) ───
	lg.PruneOldLogs(3)
	// 模型列表已改为只以上游 /v3/config 为准（不再使用磁盘快照）；残留 product.json 时提示运维删除
	models.WarnLegacyProductSnapshot()

	// inFlight 是「当前进行中的请求数」，属于进程内瞬态状态；上次进程异常退出会把非零值留在
	// accounts.json 里，重启后永久占用并发名额。启动时统一归零。
	staleInFlight := 0
	store.Accounts().Each(func(a *config.Account) bool {
		if a.InFlight > 0 {
			staleInFlight += a.InFlight
		}
		return true
	})
	if staleInFlight > 0 {
		store.Accounts().ResetInFlight()
		_ = store.SaveAccounts()
		lg.Info("SYSTEM", fmt.Sprintf("已重置历史残留的并发计数 (共 %d 个)，避免占用账号名额", staleInFlight))
	}

	// 启动时初始化：检测历史已记录的风控受限账号 (HTTP 403 / 11140)，确保状态标记为 restricted 并移出调度池
	restrictedCount := 0
	now := time.Now().UnixMilli()
	for _, a := range store.Accounts().List() {
		if a.Status == "healthy" && strings.Contains(a.LastCheckinMsg, "HTTP 403") {
			uid := a.UID
			store.Accounts().Mutate(uid, func(x *config.Account) {
				x.Status = "restricted"
				if x.RestrictedAt == 0 {
					x.RestrictedAt = now
				}
				x.RestrictedReason = "账号存在异常行为，已被限制使用 (11140)"
			})
			restrictedCount++
		}
	}
	if restrictedCount > 0 {
		_ = store.SaveAccounts()
		lg.Warn("AUTH", fmt.Sprintf("启动初始化：已自动识别并标记 %d 个上游风控受限账号 (HTTP 403 / 11140)，已移出可用调度池", restrictedCount))
	}

	for _, a := range store.Accounts().List() {
		uid := a.UID
		go sched.RefreshCredits(uid)
	}

	// ─── 4. 监听端口 (server.mjs:299-346) ───
	port := store.Config().EffectivePort()
	srv := &http.Server{Addr: fmt.Sprintf(":%d", port), Handler: handler}
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		return fmt.Errorf("监听端口失败: %w", err)
	}
	printBanner(lg, store, tlsStack, port)

	// 优雅停机：flush 统计/账号/配置，关闭数据库（server.mjs:26-33）
	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()
	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			lg.Error("SYSTEM", "HTTP 服务异常退出: "+err.Error())
		}
	case s := <-sigCh:
		lg.Info("SYSTEM", "收到退出信号 "+s.String()+"，开始优雅停机")
		shutdownCtx, c2 := context.WithTimeout(context.Background(), 10*time.Second)
		defer c2()
		_ = srv.Shutdown(shutdownCtx)
	}
	cancel()
	sched.Stop()
	flushAllOnShutdown(mt, store, db, lg)
	return nil
}

// flushAllOnShutdown 杜绝重启/强制终止时丢失统计、配置与数据库 WAL 缓存（server.mjs:27-34）。
func flushAllOnShutdown(mt *metrics.Store, store *config.Store, db *database.Engine, lg *logger.Logger) {
	if err := mt.Save(); err != nil {
		lg.Error("SYSTEM", "停机保存统计失败: "+err.Error())
	}
	if err := store.SaveNow(); err != nil {
		lg.Error("SYSTEM", "停机保存配置失败: "+err.Error())
	}
	if err := db.Close(); err != nil {
		lg.Error("SYSTEM", "关闭日志数据库失败: "+err.Error())
	}
	lg.Close()
}

// every 固定间隔后台任务（setInterval 等价）；ctx 结束即退出。
func every(ctx context.Context, interval time.Duration, fn func()) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			safeGo(fn)
		}
	}
}

// safeGo 带兜底的后台执行：单次异常只记日志，不打挂进程（server.mjs:36-63 的进程级异常兜底）。
func safeGo(fn func()) {
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				fmt.Fprintf(os.Stderr, "[ERROR] [SYSTEM] 后台任务异常已捕获并忽略: %v\n", rec)
			}
		}()
		fn()
	}()
}

// printBanner 启动横幅（server.mjs:302-346）。
func printBanner(lg *logger.Logger, store *config.Store, tlsStack *tlscerts.Stack, port int) {
	cn, intl := 0, 0
	for _, a := range store.Accounts().List() {
		switch config.ResolveAccountRegion(a) {
		case config.RegionIntl:
			intl++
		default:
			cn++
		}
	}
	edition := "国内版"
	hasCn, hasIntl := cn > 0, intl > 0
	switch {
	case hasCn && hasIntl:
		edition = "国内版 + 国际版 双区域"
	case hasIntl:
		edition = "国际版"
	}
	var parts []string
	if cn > 0 {
		parts = append(parts, fmt.Sprintf("%s %d 个", config.BaseForRegion(config.RegionCn).Label, cn))
	}
	if intl > 0 {
		parts = append(parts, fmt.Sprintf("%s %d 个", config.BaseForRegion(config.RegionIntl).Label, intl))
	}
	accountDesc := strings.Join(parts, " / ")

	cfg := store.Config()
	autoGen := store.APIKeyAutoGenerated()
	if autoGen {
		lg.Warn("AUTH", fmt.Sprintf("未检测到有效 API Key，已自动生成高安全随机 Key: %s (已写入 config.json)", cfg.APIKey))
	}
	lg.Info("SYSTEM", fmt.Sprintf("CodeBuddy %s生产级网关已启动，监听端口: %d", edition, port))
	fmt.Printf("\n======================================================\n")
	fmt.Printf("🚀 CodeBuddy %s生产级多协议网关已启动!\n", edition)
	fmt.Printf("📡 监听地址: http://127.0.0.1:%d\n", port)
	autoTag := ""
	if autoGen {
		autoTag = " [自动生成]"
	}
	fmt.Printf("🔑 网关 API Key: %s (共 %d 个配置密钥)%s\n", cfg.APIKey, len(store.GetAPIKeys()), autoTag)
	if accountDesc != "" {
		fmt.Printf("👥 账号池: 共 %d 个（%s）\n", store.Accounts().Len(), accountDesc)
	} else {
		fmt.Printf("👥 账号池: 共 %d 个\n", store.Accounts().Len())
	}
	if intl > 0 {
		fmt.Printf("🌍 上游区域: 国内版 %s | 国际版 %s\n", config.BaseForRegion(config.RegionCn).API, config.BaseForRegion(config.RegionIntl).API)
	} else {
		fmt.Printf("🌍 上游区域: 国内版 %s（未启用国际版）\n", config.BaseForRegion(config.RegionCn).API)
	}
	fmt.Printf("🏷️  模型区隔: cn:<模型> 走国内版，intl:<模型> 走国际版\n")
	fmt.Printf("✨ 协议支持: OpenAI (/v1/chat/completions) + Anthropic (/v1/messages)\n")
	fmt.Printf("🌐 联网扩展: POST /v1/search & POST /v1/fetch\n")
	fmt.Printf("🔒 TLS 堆栈: 官方同款运行栈已激活 (%d 张 CA 根证书已载入)\n", tlsStack.LoadedCount())
	fmt.Printf("🛠️  已开启: 客户端自定义 tools 透传与 tool_calls 回传\n")
	fmt.Printf("🛡️  策略开关: 单账号限流保护与模型自动降级改道已激活\n")
	fmt.Printf("📜 日志系统: 内存环形缓冲 + gateway.log 自动持久化 + Web实时诊断看板\n")
	fmt.Printf("======================================================\n\n")
}
