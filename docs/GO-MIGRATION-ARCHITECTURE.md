# Go 版架构方案（P2 产出）

> 输入：`docs/GO-MIGRATION-DIAGNOSIS.md`（P1）、`GOLANG_REFACTOR_PROMPT_KIT.md` P0 铁律与事实卡
> 本文档是所有模块迁移提示词（P3.0~P11）的公共上下文。每个会话开头除 P0 + 事实卡外，再贴本文的 §3（接口定义）与 §5（状态映射）。
> 文中标注【CLI】的项有 CLI 产物依据；标注【网关】的为网关自有策略；标注【决策】的是本次迁移新引入、需在 CHANGELOG 中声明的行为差异。

---

## 1. 设计原则（从 P0 铁律推导）

| 原则 | 落地方式 |
|---|---|
| 行为等价 | 每个 Node 导出符号 → 一个 Go 导出符号，签名与语义对照表随模块交付；分支级 golden test |
| CLI 为依据 | 所有超时/重试/请求头常量集中在 `internal/upstream/cliconsts.go`，每个常量带 `// CLI: <var>=<value> | bundle: <证据>` 注释 |
| 零 CGO | `modernc.org/sqlite`；Windows 证书提取继续用 `os/exec` 调 powershell（与 Node 一致） |
| 无全局可变状态 | 禁止包级 `var` 可变量；全部状态归 Store 结构体，由 `main` 注入 |
| goroutine 可证明退出 | 所有 goroutine 由 `context.Context` 或 `WaitGroup` 管理；`goleak` 进 CI |
| 日志即契约 | `gateway.log` 行格式、分类名、中文文案逐字保留（`log-parser.mjs` 与控制台依赖） |

---

## 2. 包依赖图（DAG，禁止反向/循环依赖）

```
cmd/gateway/main.go
 ├─ internal/web          ──────────────┐
 ├─ internal/adapters ────┤              │
 ├─ internal/server (bootstrap/mux)      │
 └─ (compose all)                        │
                                         ▼
internal/web ─────────► internal/adapters ─────► internal/upstream ──► internal/config
     │                        │                      │                  │
     │                        ▼                      ▼                  │
     │                 internal/core/scheduler ──► internal/core/logger│
     │                        │                       │  ▲             │
     ├─► internal/core/metrics┤                       │  └─ internal/core/database
     ├─► internal/core/pricing┤                       ▼
     ├─► internal/core/database                        └─ (database 不依赖任何 internal 包)
     └─► internal/core/tlscerts (叶子，无依赖)
```

依赖规则（`go vet`/`internal/tools/depcheck` 校验）：
1. `core/database`、`core/tlscerts`、`config` 为叶子或近叶子，禁止 import 任何 `core/*`、`upstream`、`adapters`、`web`。
2. `core/logger` 只能 import `config` 与 `core/database`。
3. `core/scheduler` 只能 import `config`、`core/logger`、`core/database`。
4. `core/metrics`、`core/pricing` 只能 import `config`、`core/logger`、`core/scheduler`（pricing 的联网检索需要账号）。
5. `upstream` 只能 import `config`、`core/logger`。
6. `adapters` 可 import `upstream`、`core/*`、`config`。
7. `web` 可 import 除 `cmd` 以外的全部。
8. `cmd/gateway` 只做组装：构造 Store、Scheduler、HTTP Client、Mux，启动后台任务，监听，等信号。

> 与事实卡目录的对应：`internal/config/`、`internal/core/{logger,tlscerts,scheduler,database,metrics,pricing}/`、`internal/upstream/`、`internal/adapters/`、`internal/web/`、`internal/server/`、`cmd/gateway/`。

---

## 3. 核心接口定义

> 以下为"契约"，各模块提示词中的实现必须满足；字段名以规格卡为准。

### 3.1 配置与账号（`internal/config`）

```go
// Config 与 config.json 字段一一对应（json tag 与 Node 版键名完全一致，含 omitempty 口径）
type Config struct { /* 规格卡 §1.1 */ }

// Store 是 config + accounts 的唯一持有者。读返回快照指针，写必须走 Update。
type Store struct {
    cfg      atomic.Pointer[Config]
    acc      *AccountStore
    dataDir  string
    keys     *KeyRing            // apiKeys 的内存态与持久化
    blacklist atomic.Pointer[Blacklist]
    mu       sync.Mutex          // 串行化落盘
    logger   *logger.Logger
}

func Open(dataDir string, lg *logger.Logger) (*Store, error)   // loadJsonWithBackup + migrateLegacyBackups + ensureApiKey + 归一化
func (s *Store) Config() *Config                               // 只读快照
func (s *Store) UpdateConfig(fn func(c *Config)) error         // 拷贝→改→原子替换→saveConfig
func (s *Store) Accounts() *AccountStore
func (s *Store) SaveNow() error                                // flush：accounts + config

// AccountStore 保持 accounts.json 的数组顺序（选号平局依赖该顺序）
type AccountStore struct {
    mu   sync.RWMutex
    ord  []string
    by   map[string]*Account
    max  func() int32           // maxInFlightPerAccount（从 Config 读）
}
func (a *AccountStore) List() []*Account                       // 按文件顺序
func (a *AccountStore) Get(uid string) *Account
func (a *AccountStore) Find(pred func(*Account) bool) *Account
func (a *AccountStore) Upsert(acc *Account) (replaced bool)
func (a *AccountStore) Remove(uid string) bool
func (a *AccountStore) Acquire(uid string) (release func())    // inFlight+1；返回的 release 幂等，必须 defer
func (a *AccountStore) Each(fn func(*Account) bool)            // 持读锁遍历；fn 内禁止写
func (a *AccountStore) Mutate(uid string, fn func(*Account))   // 持写锁原地改（cooldown/status/credits 等）
```

【决策】`inFlight` 放在 `Account.inFlight atomic.Int32`，`Acquire/Release` 无需锁；其余字段走 `Mutate`。
【决策】数据目录：`GW_DATA_DIR` env > 可执行文件所在目录 > cwd。Node 版 `ROOT_DIR` = 源码目录上级（`config.mjs:226`），现有部署把 `gateway.mjs` 与数据文件放同一目录，因此"可执行文件目录"与现网等价。

### 3.2 日志（`internal/core/logger`）

```go
type Logger struct { /* ring(1000) + file + sqlite sink + mutex */ }
func New(db *database.Engine, dataDir string) *Logger
func (l *Logger) Info(category, msg string, meta ...map[string]any)
func (l *Logger) Warn(category, msg string, meta ...map[string]any)
func (l *Logger) Error(category, msg string, meta ...map[string]any)
func (l *Logger) GetLogs(q LogQuery) LogQueryResult   // 规格卡 §2.1
func (l *Logger) GetDates() []string
func (l *Logger) Clear() int
func (l *Logger) PruneLogsByTime(mode string, keepDays int) PruneResult
func (l *Logger) PruneOldLogs(retentionDays int)
```

【决策】实现 `slog.Handler` 接口以便标准库生态可用，但 `Handle` 输出**精确复刻** Node 行格式：
`[YYYY-MM-DD HH:mm:ss] [LEVEL ] [CATEGORY] message | {"k":v}\n`（本地时区；`LEVEL` padEnd(5)；meta 为 JSON.stringify 紧凑格式）。
【网关】SQLite 插入保持同步（诊断 S4）。

### 3.3 数据库（`internal/core/database`）

```go
type Engine struct{ db *sql.DB; path string }
func Open(path string) (*Engine, error)          // WAL + synchronous=NORMAL + 建表 + 空库迁移
func (e *Engine) InsertLog(t time.Time, level, category, msg string, meta []byte) error
func (e *Engine) QueryLogs(q LogQuery) (logs []LogRow, total int)
func (e *Engine) Dates() []string
func (e *Engine) ClearLogs() error
func (e *Engine) PruneLogsByTime(mode string, keepDays int) PruneResult
func (e *Engine) PruneOldLogs(retentionDays int)
func (e *Engine) CheckAndPruneBySize(maxMb int) PruneResult
func (e *Engine) SizeMb() float64
func (e *Engine) InsertCreditHistory(r CreditRecord) error
func (e *Engine) QueryCreditHistory(q CreditQuery) (records []CreditRow, total int)
func (e *Engine) ClearCreditHistory() error
func (e *Engine) Close() error
```

【决策】`db.SetMaxOpenConns(1)`，保证写序与 Node `DatabaseSync` 等价；查询与写入共用一个连接（Node 亦如此）。
【验收】Go 版必须能直接打开 Node 版生成的 `logs.db`，反之亦然。

### 3.4 调度器（`internal/core/scheduler`）

```go
type Scheduler struct {
    mu        sync.Mutex
    sticky    map[string]*stickyEntry   // sessionStickyMap
    rrIndex   int
    lastUID   string; lastAt int64
    lastApiAt atomic.Int64
    postCall  map[string]*time.Timer
    store     *config.Store
    db        *database.Engine
    lg        *logger.Logger
    http      *upstream.Client
    tls       *tlscerts.Stack
    now       func() time.Time         // 可注入时钟
}
func (s *Scheduler) SelectAccount(model string, sessionKey string, opt SelectOpt) *config.Account
func (s *Scheduler) Cooldown(uid string, sec int, reason string)
func (s *Scheduler) CooldownModel(uid, model string, sec int, reason string)
func (s *Scheduler) RecordApiUsage(acc *config.Account)
func (s *Scheduler) CurrentActiveAccountInfo() ActiveAccountInfo
func (s *Scheduler) SessionAffinityStats() SessionAffinityStats
func (s *Scheduler) ClearSticky() int
func (s *Scheduler) CleanExpiredSessions() int
func (s *Scheduler) RefreshStaleCredits(minIntervalMs int64, force bool)
func (s *Scheduler) RefreshActiveAccountsIfStale()
func (s *Scheduler) RefreshCredits(acc *config.Account)
func (s *Scheduler) RefreshSessionToken(acc *config.Account) (RefreshResult, error)
func (s *Scheduler) DailyCheckin(acc *config.Account, force bool) CheckinResult
func (s *Scheduler) CheckAndRunHourlyCheckin(interactive bool)
func (s *Scheduler) GetAccountCreditDetails(acc *config.Account) (map[string]any, error)
func (s *Scheduler) GetAccountUsageRecords(acc *config.Account, p UsageQuery) (map[string]any, error)
func (s *Scheduler) Run(ctx context.Context)   // 启动 T1/T2/T4 等后台任务（含单飞）
```

【决策】Node 的静态方法（`AccountScheduler.xxx`）→ 实例方法；`sessionStickyMap` 等模块级状态 → 结构体字段。
【决策】所有后台任务通过 `RunPeriodic`（§6）启动，带 `TryLock` 单飞，解决诊断 R8。

### 3.5 上游客户端（`internal/upstream`）

```go
type Client struct {
    http    *http.Client           // Transport 见 §8
    tls     *tlscerts.Stack
    lg      *logger.Logger
}
func (c *Client) Do(ctx context.Context, method, url string, headers http.Header, body []byte) (*http.Response, error)
// 纯函数（与 Node 一一对应）
func BuildOfficialUpstreamHeaders(...) http.Header
func SanitizeUserAgent(ua string) string
func UUIDv7() string; func UUIDv7Hex() string
func ExtractStructuredBizCode(v any, depth int) any
func FormatOpenAIError(status int, errText string) map[string]any
func PrepareUpstreamBody(p map[string]any) (body []byte, isGzip bool)
func FormatMessagesForUpstream(msgs []json.RawMessage) []json.RawMessage
func ApplyReasoningParams(...); func ApplyModelCapabilityGuards(...); func EnsureLeadingSystemMessage(...)
func (m *ModelCatalog) FetchDetailedModels(force bool) ([]ModelMeta, error)
func (m *ModelCatalog) FetchBusyLevels() map[string]string
```

【CLI】常量集中在 `cliconsts.go`（§7）。
【决策】payload 用 `map[string]any` + `json.RawMessage`（保留未知字段，Node 版是对象透传）；Config/Account/Stats 用 struct（文件字段顺序固定）。

### 3.6 流守卫（`internal/upstream`）

```go
type Lifecycle struct { /* ctx, cancel, firstByte timer, idle timer, state(reason), flags */ }
func NewLifecycle(parent context.Context, label string, now func() time.Time) *Lifecycle
func (l *Lifecycle) Ctx() context.Context
func (l *Lifecycle) MarkFirstByte(); MarkUpstreamEnded(); MarkFinished(); Dispose()
func (l *Lifecycle) Reason() string           // "client-gone" | "first-byte-timeout" | "idle-timeout" | ""

type StreamResult struct { AbortedByClient bool; SawDone bool; Err error }
func ReadUpstreamStream(ctx context.Context, r io.Reader, lc *Lifecycle, onChunk func(string)) StreamResult

type Heartbeat struct { /* w *SSEWriter, protocol, interval, lastWrite, pingCount */ }
func StartHeartbeat(w *SSEWriter, protocol string, interval time.Duration, meta func() map[string]any) *Heartbeat
func (h *Heartbeat) Touch(); func (h *Heartbeat) Stop() int   // 返回 pingCount

type DeltaClassifier struct { /* hasContent/Reasoning/Tools/Refusal/Substantive */ }
func (c *DeltaClassifier) ObserveDelta(delta map[string]any, finish any)
func (c *DeltaClassifier) ObserveUsage(u map[string]any)
func (c *DeltaClassifier) EmptyStreamKind() string   // "" | "reasoning-only" | "no-token"
func IsTruncatedWithoutFinish(sawDone, sawFinish, sawError bool) bool
func BuildTruncationChunk(id, model string) string
func BuildEmptyStreamChunk(id, model, kind string) string
func LogStreamOutcome(lg *logger.Logger, label string, res StreamResult, meta map[string]any)
```

【决策】`Lifecycle` 用一个 `context.WithCancel` + 两个 `time.Timer`；任一触发 → `cancel(cause)` 并记录 `Reason`。Node 版 `AbortController` 的等价物。
【决策】心跳 goroutine 只在 `Touch()` 后重新计时；Node 语义：`setInterval` 每 interval 检查一次"距上次真实写入是否 ≥ interval"，是则发 ping（规格卡 §7.3）。

### 3.7 SSE 写出（`internal/adapters`）

```go
type SSEWriter struct {
    w    http.ResponseWriter
    f    http.Flusher
    mu   sync.Mutex       // 串行化 reader goroutine 与 heartbeat goroutine 的写
    dead atomic.Bool      // Write 返回 error 或 ctx.Done 后置位
}
func NewSSEWriter(w http.ResponseWriter) (*SSEWriter, error)   // 非 Flusher 返回 error
func (s *SSEWriter) Write(raw string) bool                    // 失败返回 false，不 panic
func (s *SSEWriter) Event(event, data string) bool            // "event: x\ndata: y\n\n"
func (s *SSEWriter) Ended() bool
```

【决策】Node 在客户端断开后 `res.write` 静默失败；Go 必须检查 `Write` 返回的 `error`，置 `dead`，由 reader 回调 `onChunk` 开头检查 `Ended()` 提前返回。

### 3.8 错误（`internal/upstream`）

```go
type AppError struct {
    Status  int
    Type    string   // OpenAI error.type / Anthropic error.type
    Code    string   // OpenAI error.code
    Message string
    BizCode any      // extractStructuredBizCode 原始结果（number 或 string）
}
```

映射规则与 Node `formatOpenAIError` 一致（规格卡 §5.2）；Anthropic 失败路径复刻 Node 现状：`{"type":"error","error":{"type":"api_error","message":<上游原始文本>}}`（疑点 D8，照搬）。

---

## 4. 请求处理链（Go 版）

```
http.Server (internal/server)
 └─ recover 中间件（每请求 goroutine 兜底，等价 process.on('uncaughtException') 但作用域更小）
     └─ CORS + OPTIONS 短路（server.mjs:162-168 逐头一致）
         └─ 路由分发（顺序与 server.mjs:173-236 一致）
             ├─ GET  /            → web.HandleDashboard
             ├─ GET  /healthz     → server.handleHealthz
             ├─ /v1/*、/messages、/search、/fetch → server.requireAPIKey → readBody(50MB) → adapters.*
             ├─ /api/*            → web.HandleAPIRoutes（内部鉴权）
             └─ 其余 → 404 {"error":"Endpoint not found"}
```

`readBody` 等价 `readRequestBody`（server.mjs:113-158）：`Content-Length > 50MB` → 413 文案 A；流式累计超限 → 413 文案 B；读错误 → 400 `Failed to read request stream`。
【决策】Go 版 `handleRequestFailure` 的两分支（未发头 → 500 `api_error`；已发头 → 直接结束）用 `w.Header()` 是否已写（`http.ResponseController` 或自定义 `written` 标志）判断。

---

## 5. 全局状态映射表（Node → Go）

| Node 状态 | Go 归属 | 并发原语 | 备注 |
|---|---|---|---|
| `config`（config.mjs:388） | `Store.cfg atomic.Pointer[Config]` | atomic + 写时复制 | `routes` 的原地改 → `UpdateConfig` |
| `accounts`（config.mjs:389） | `AccountStore` | RWMutex + `inFlight atomic` | 顺序保存在 `ord` |
| `sessionStickyMap` | `Scheduler.sticky` | Scheduler.mu | 清理任务与方法同锁 |
| `lastApiCallTimestamp` | `Scheduler.lastApiAt` | atomic.Int64 | |
| `postCallRefreshTimers` | `Scheduler.postCall` | Scheduler.mu | `time.Timer`，Stop 后删除 |
| `rrIndex/lastDispatched*` | `Scheduler` 字段 | Scheduler.mu | |
| `statsData`（metrics） | `metrics.Store` | RWMutex | 落盘走 `config` 的原子写 |
| `cachedCustomPrices` | `pricing.Cache` | atomic.Pointer | |
| 模型矩阵/busy 缓存（models） | `upstream.ModelCatalog` | RWMutex + inflight 去重 | |
| `ringBuffer`（logger） | `logger.Logger` | Mutex | |
| `unhandledCount/lastUnhandledWarnAt` | `server.anomalyCounter` | atomic | |

---

## 6. 后台任务框架

```go
// internal/server/periodic.go
func RunPeriodic(ctx context.Context, name string, interval time.Duration, fn func(ctx context.Context), singleflight bool)
```
- `singleflight=true`：用 `sync.Mutex.TryLock`，上一轮未结束则跳过本轮（诊断 R8）。
- 每个 tick 的 `fn` 包 `recover`，panic 记录 `PROCESS` 日志后继续。
- 任务清单（对应诊断 §3）：T1 60s session 清理【CLI 6e4】；T2 5min 刷新【网关】；T3 1h 日志轮转【网关】；T4 1h 签到【网关，autoCheckin!==false 时启动，启动时先跑一次】。

---

## 7. CLI 常量集中表（`internal/upstream/cliconsts.go`，已用 CLI 产物核实）

| Go 常量 | 值 | 注释必须包含 |
|---|---|---|
| `CLIFirstTokenTimeoutMs` | 1_200_000 | `// CLI: CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS 默认 mm=12e5（resolveRequestTimeoutMs）` |
| `CLIStreamTimeoutMs` | 1_200_000 | `// CLI: CODEBUDDY_STREAM_TIMEOUT_MS 默认 my=12e5` |
| `CLIReasoningKeepaliveIntervalMs` | 0 | `// CLI: CODEBUDDY_REASONING_KEEPALIVE_INTERVAL_MS 默认 0（关闭）` |
| `CLIStreamJsonKeepaliveIntervalMs` | 0 | `// CLI: CODEBUDDY_STREAM_KEEPALIVE_INTERVAL_MS 默认 0（关闭；网关未使用，仅供对照）` |
| `CLIEmptyStreamRetryMaxElapsedMs` | 300_000 | `// CLI: CODEBUDDY_EMPTY_STREAM_RETRY_MAX_ELAPSED_MS 默认 AK=mb=3e5` |
| `CLIRequestMaxRetries` / `CLIRequestMaxRetriesHardCap` | 8 / 15 | `// CLI: mC=8, mv=15（resolveRequestMaxRetries）；注意：网关未实现按次数重试，见规格卡 §8.3` |
| `CLIFinishReasonGraceMs` | 5_000 | `// CLI: tf=5e3（StreamedReasoningCollector 同作用域）` |
| `GWStreamIdleTimeoutMs` | 300_000 | `// 网关自有策略：借用 CLI mb=3e5 空流窗口作为静默看门狗` |
| `GWHeartbeatIntervalMs` | 5_000 | `// 网关自有策略：CLI 默认 0，网关因第三方客户端需要保活而开启` |
| `GWStickyTtlMs` | 604_800_000 | `// 网关自有策略：config.mjs:408 STICKY_DEFAULT_TTL_MS=7 天` |
| `GWModelCacheMs` | 300_000 | `// 网关自有策略：models.mjs 5 分钟；CLI 对照 48e4=8 分钟` |
| `GWBusyCacheMs` | 60_000 | `// 网关自有策略：models.mjs busy 探测缓存` |

CLI 证据片段（`package/dist/codebuddy-headless.js`，2026-11-29 核查）：
`let mm=12e5,my=12e5;function resolveTimeoutMs(eA,el){...}let mE=1e3,mw=32e3,mC=8,mv=15,mb=3e5,m_=1,mI=2e3,mB=500;function resolveRequestMaxRetries(eA){...return Math.min(el,mv)}return mC}`
`AK=3e5;function resolveEmptyStreamRetryMaxElapsedMs(){...}`
`tf=5e3,startStreamMonitor=()=>{...Stream idle monitor armed...}`
`ej=(()=>{let eA=parseInt(process.env.CODEBUDDY_REASONING_KEEPALIVE_INTERVAL_MS??"",10);return Number.isFinite(eA)&&eA>0?eA:0})()`

---

## 8. 上游 HTTP 客户端参数

| 项 | 值 | 依据 |
|---|---|---|
| 协议 | HTTP/1.1（`ForceAttemptHTTP2=false`，自定义 `TLSClientConfig` 时 Go 默认禁 h2） | Node `fetch`(undici) 默认 HTTP/1.1 |
| `TLSClientConfig.RootCAs` | `tlscerts.Stack.Pool()` | tls-certs.mjs 全局注入的等价物；所有上游请求共用 |
| `MaxIdleConnsPerHost` / `IdleConnTimeout` | 64 / 90s | 【网关】undici 默认连接池近似值；流式长连接不占 idle 池 |
| `DisableCompression` | false | Go 自动加 `Accept-Encoding: gzip` 并解压；Node 另支持 deflate/br（差异：上游对 SSE 一般不压缩） |
| `ResponseHeaderTimeout` | 0 | 首字节超时由 `Lifecycle` 统一控制（避免双计时器语义冲突） |
| 代理 | 遵循 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY`（`http.ProxyFromEnvironment`） | Node fetch 不读环境代理 → 【决策】默认 `nil`（不走代理）保持等价；提供 `GW_UPSTREAM_PROXY` 开关 |

---

## 9. 优雅停机时序（对齐 server.mjs flushAllOnShutdown）

```
SIGINT/SIGTERM/beforeExit
 → ctx cancel（停止后台任务与心跳）
 → http.Server.Shutdown(shutdownCtx 10s)      等待在途请求；流式请求由 ctx 取消收尾
 → scheduler.Stop()（Stop 所有 postCall timer）
 → metrics.SaveStatsSync()
 → store.SaveNow()（accounts.json + config.json，原子写 + 备份）
 → database.Close()
 → logger 关闭文件句柄
```

【决策】Node 版 `beforeExit` 触发的 flush 在 Go 中由 `main` 的 defer 覆盖；`SIGINT` 第二次按下直接 `os.Exit(130)`（网关自有策略，避免卡死）。

---

## 10. HTTP Server 参数

| 项 | 值 | 依据 |
|---|---|---|
| 监听 | `:config.port`（默认 8317） | server.mjs |
| `ReadHeaderTimeout` | 60s | 【网关】Node 无此限制，Go 为防 slowloris 设置 |
| `ReadTimeout` / `WriteTimeout` | 0 / 0 | 必须为 0，否则长流被截断（与 Node 一致） |
| `IdleTimeout` | 120s | 【网关】Node 默认 keep-alive 5s；差异不影响功能 |
| 请求体上限 | `/v1/*`、`/messages`、`/search`、`/fetch` 50MB | server.mjs:81 |
| `/api/*` 请求体上限 | 50MB | 【决策】Node 版 `/api` 路径无显式上限；Go 统一 50MB，防误传 |

---

## 11. 时间与时区

- 日志时间：`time.Now().In(time.Local)`，格式 `2006-01-02 15:04:05`（与 `getLocalTimeString` 一致）。
- 日期键（stats/logs）：`time.Now().Format("2006-01-02")` 本地时区（与 `getTodayString` 一致）。
- 裁剪 cutoff：`time.Now().UTC().Format("2006-01-02")`（照搬 D4，注释标注疑点）。
- `expiresAtFmt`：`time.UnixMilli(v).Local().Format("2006/1/2")`（等价 `toLocaleDateString()` 在 zh-CN 下的输出；需在测试中锁定）。

---

## 12. 测试策略

| 层 | 方法 |
|---|---|
| 纯函数 | 表驱动；每个 Node `if` 分支至少 1 例（规格卡各节列出分支） |
| 持久化 | 用现网 `config.json` / `accounts.json` / `stats.json` / `logs.db` 样本做 golden：读入→写回→字节级或字段级一致 |
| SSE | `httptest.Server` 回放录制的上游 chunk 序列；断言下游字节序列 |
| 并发 | `-race`；`goleak.VerifyNone` 在每个涉及 goroutine 的测试末尾 |
| 定时器 | 注入 `now`/fake clock，把 20 分钟缩到毫秒 |
| 端到端 | Node 版(:8317) 与 Go 版(:8318) 并行，P13 对比脚本 |

---

## 13. 构建与交付

- `CGO_ENABLED=0`，目标 `linux/amd64`、`linux/arm64`、`windows/amd64`，`-ldflags="-s -w"`。
- 前端：`//go:embed public/*`，运行时执行 `@include` 展开与 `{{PORT}}` 等占位替换（与 `renderDashboardTemplate` 同逻辑），结果可缓存但 `CA_COUNT` 等动态值每次替换。
- Dockerfile：多阶段，运行镜像 `alpine` + `ca-certificates`（诊断 R5），`VOLUME /data`，`GW_DATA_DIR=/data`。
- 敏感文件不入库：`accounts.json`、`config.json`、`backups/`、`logs.db`、`gateway.log`、`stats.json`、`pricing.json`（后两者视 AGENTS.md 口径补充到 `.gitignore` 检查项）。
