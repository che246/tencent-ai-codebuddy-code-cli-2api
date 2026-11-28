package upstream

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// 本文件集中所有"以官方 CLI 为依据"的超时/重试/间隔常量。
// 依据：package/dist/codebuddy-headless.js（2026-11-29 实测）：
//
//	let mm=12e5,my=12e5;                 // 首 token / 流总时长默认
//	let mE=1e3,mw=32e3,mC=8,mv=15,mb=3e5,m_=1,mI=2e3,mB=500;
//	AK=3e5;                               // EMPTY_STREAM_RETRY_MAX_ELAPSED_MS 默认
//	tf=5e3;                               // finish_reason 后宽限
//	ej=(parseInt(env.CODEBUDDY_REASONING_KEEPALIVE_INTERVAL_MS)>0)?:0
//
// 网关自有策略一律以 GW_ 前缀标注，并在注释中说明无 CLI 对应实现。

const (
	// CLI: CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS 默认 mm=12e5（resolveTimeoutMs）
	CLIFirstTokenTimeoutMs = 1_200_000
	// CLI: CODEBUDDY_STREAM_TIMEOUT_MS 默认 my=12e5（流总时长，非静默）
	CLIStreamTimeoutMs = 1_200_000
	// CLI: CODEBUDDY_REASONING_KEEPALIVE_INTERVAL_MS 默认 0（关闭）
	CLIReasoningKeepaliveIntervalMs = 0
	// CLI: CODEBUDDY_STREAM_KEEPALIVE_INTERVAL_MS 默认 0（网关未使用，仅供对照）
	CLIStreamJsonKeepaliveIntervalMs = 0
	// CLI: CODEBUDDY_EMPTY_STREAM_RETRY_MAX_ELAPSED_MS 默认 AK=mb=3e5
	CLIEmptyStreamRetryMaxElapsedMs = 300_000
	// CLI: mC=8 请求最大重试次数（resolveRequestMaxRetries）；网关未实现按次数重试，边界=账号集合×降级链
	CLIRequestMaxRetries = 8
	// CLI: mv=15 重试硬上限
	CLIRequestMaxRetriesHardCap = 15
	// CLI: tf=5e3 finish_reason 后宽限（等待 usage 尾帧）
	CLIFinishReasonGraceMs = 5_000
	// CLI: cleanExpiredSessions 定时器 6e4
	CLICleanupIntervalMs = 60_000
	// CLI: CLI_COMPLETED_TASK_TTL_MS 3e5（网关粘性 TTL 未配置时的兜底，实际死分支）
	CLICompletedTaskTtlMs = 300_000
	// CLI: CLI_PROMPT_TIMEOUT_MS 18e5（网关粘性最大生命周期兜底，实际死分支）
	CLIPromptTimeoutMs = 1_800_000
	// CLI: ProductManager 模型矩阵 TTL 48e4=8 分钟（网关取 5 分钟，见 GWModelCacheMs）
	CLIProductCacheMs = 480_000
)

// 以下为网关自有策略（无 CLI 对应实现或刻意偏离），均可用环境变量覆盖（与 Node 版 stream-guard.mjs:22-45 一致）。
var (
	// FirstByteTimeoutMs 首 token 超时：CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS > GW_FIRST_BYTE_TIMEOUT_MS > 12e5。
	FirstByteTimeoutMs = envInt("CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS", envInt("GW_FIRST_BYTE_TIMEOUT_MS", CLIFirstTokenTimeoutMs))
	// StreamIdleTimeoutMs 静默看门狗【网关自有策略】：借用 CLI mb=3e5 空流重试窗口作为阈值；
	// 覆盖顺序 GW_STREAM_IDLE_TIMEOUT_MS > CODEBUDDY_STREAM_TIMEOUT_MS > 300000。
	StreamIdleTimeoutMs = envInt("GW_STREAM_IDLE_TIMEOUT_MS", envInt("CODEBUDDY_STREAM_TIMEOUT_MS", 300_000))
	// HeartbeatIntervalMs 下游保活间隔【网关自有策略】：CLI 默认 0，网关面向第三方客户端默认 5s；
	// 覆盖顺序 CODEBUDDY_REASONING_KEEPALIVE_INTERVAL_MS > GW_HEARTBEAT_INTERVAL_MS > 5000（设 0 即关闭）。
	HeartbeatIntervalMs = envInt("CODEBUDDY_REASONING_KEEPALIVE_INTERVAL_MS", envInt("GW_HEARTBEAT_INTERVAL_MS", 5_000))
	// FinishReasonGraceMs finish_reason 后宽限：GW_FINISH_REASON_GRACE_MS > CLI tf=5e3。
	FinishReasonGraceMs = envInt("GW_FINISH_REASON_GRACE_MS", CLIFinishReasonGraceMs)
	// GWModelCacheMs 模型矩阵内存缓存【网关自有策略】：models.mjs 5 分钟（CLI 对照 48e4=8 分钟）。
	GWModelCacheMs int64 = 5 * 60 * 1000
	// GWBusyCacheMs 模型繁忙度缓存【网关自有策略】：models.mjs 60 秒。
	GWBusyCacheMs int64 = 60 * 1000
	// GWBusyTimeoutMs 繁忙度探测超时【网关自有策略】：models.mjs 4000ms。
	GWBusyTimeoutMs time.Duration = 4 * time.Second
	// GWModelConfigTimeoutMs /v3/config 拉取超时【网关自有策略】：models.mjs 5000ms。
	GWModelConfigTimeoutMs time.Duration = 5 * time.Second
)

// envInt 读取环境变量整数；未设置/非法时返回 fallback（Node `Number(env || def)` 对非法值得 NaN，
// Go 版回落默认值——差异仅在非法配置时体现）。
func envInt(key string, fallback int) int {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return fallback
	}
	if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
		return n
	}
	return fallback
}
