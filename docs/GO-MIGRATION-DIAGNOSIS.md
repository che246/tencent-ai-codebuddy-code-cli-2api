# Go 迁移前项目诊断（P1 产出）

> 日期：2026-11-29
> 范围：`src/server.mjs`、`src/config.mjs`、`src/core/scheduler.mjs` 精读；`core/{logger,database,tls-certs}.mjs`、`upstream/stream-guard.mjs` 定向核查
> 输入：`GOLANG_REFACTOR_PROMPT_KIT.md` 的 P0 + 项目事实卡
> 性质：只诊断，不改代码。所有行号以当前工作区源码为准。

---

## 0. 诊断摘要（先看这里）

| # | 结论 | 影响 |
|---|---|---|
| S1 | 全项目 **零 npm 依赖**，仅用 `node:http / fs / crypto / zlib / tls / child_process / node:sqlite` | Go 版可零 CGO 对应；`node:sqlite` → `modernc.org/sqlite` |
| S2 | **16 处模块级可变状态**，全部靠事件循环单线程天然安全 | Go 版必须集中到带锁 Store，禁止包级 var |
| S3 | **9 处常驻定时器**，其中 1 处 `unref()`，其余挂住进程 | Go 版统一由 `signal.NotifyContext` 的 ctx 驱动 |
| S4 | `Logger.write()` **每条日志同步插入 SQLite** + 异步 `appendFile` | 在流式热路径上；Go 版需评估是否异步化（会改变日志顺序语义） |
| S5 | 会话粘性实际 TTL = **7 天**（config 默认写入），CLI 常量 `3e5/18e5` 是死分支 | 事实卡描述需修正（见 §8） |
| S6 | 选号用 `Array.prototype.sort`（V8 **稳定排序**） | Go `sort.Slice` 不稳定 → 平局结果与 Node 不一致，必须 `SliceStable` |
| S7 | 发现 **5 处源码疑点**（§6），迁移时"照搬 + 记录"，不修 | 列入 P12 评审对照 |

---

## 1. 请求全链路时序（文字版）

### 1.1 启动时序（`gateway.mjs` → `src/server.mjs`）

```
import './src/server.mjs'
 ├─ config.mjs 模块初始化（import 副作用）
 │    loadJsonWithBackup(config.json) / loadJsonWithBackup(accounts.json) → normalizeAccount
 │    ensureBackupDir → migrateLegacyBackups → ensureApiKey（可能自动生成并落盘）
 │    stickySessionTtlMs / stickySessionMaxLifetimeMs 默认 7 天（config.mjs:413-425）
 ├─ core/logger.mjs → core/database.mjs 模块初始化
 │    LogDatabase = new LogDatabaseEngine()  → 打开 logs.db、WAL、建表、空库时从 gateway.log 迁移
 ├─ core/scheduler.mjs 模块初始化
 │    setInterval(cleanExpiredSessions, 60_000).unref()   (scheduler.mjs:172)
 ├─ TlsCertificateStack.init()                             (server.mjs:78)
 ├─ process.on(unhandledRejection / uncaughtException / SIGINT / SIGTERM / beforeExit)
 ├─ 启动修正：inFlight 归零 → 403 受限账号标记 → 全量 refreshCredits   (server.mjs:268-297)
 ├─ 3 个 setInterval（5min 刷新 / 1h 日志轮转 / 1h 签到）              (server.mjs:241-256)
 └─ server.listen(PORT=config.port||8317) → 打印横幅
```

### 1.2 请求时序（`server.mjs:161-238` 路由总线）

```
http.createServer(req, res)
 ├─ CORS 头 + OPTIONS 短路                                          (162-168)
 ├─ new URL(req.url)
 ├─ [GET] / , /index.html        → handleDashboard                   (173-175)
 ├─ [GET] /healthz               → 直接 JSON（process.uptime）        (180-190)
 ├─ 鉴权：/v1/* 或 /messages /search /fetch
 │     Bearer 或 x-api-key → isValidApiKey（常量时间比对）→ 401       (193-203)
 ├─ [GET]  /v1/models                          → handleOpenAiModels(req,res,url)
 ├─ [POST] /v1/search | /search                → readRequestBody → handleSearch
 ├─ [POST] /v1/fetch  | /fetch                  → readRequestBody → handleWebFetch
 ├─ [POST] /v1/messages | /messages             → readRequestBody → handleAnthropicMessages
 ├─ [POST] /v1/chat/completions                 → readRequestBody → handleOpenAiChatCompletions
 ├─ /api/*                                     → handleApiRoutes(req,res,url)（内部自行鉴权）
 └─ 其余 → 404 {"error":"Endpoint not found"}

readRequestBody(req,res,handler)                                    (113-158)
 ├─ Content-Length > 50MB → 413 payload_too_large（文案 A）
 ├─ 流式累计 > 50MB        → req.destroy + 413（文案 B，与 A 不同！）
 ├─ req 'error'           → 400 bad_request "Failed to read request stream"
 └─ req 'end'             → Promise.resolve().then(handler).catch(handleRequestFailure)
                           handleRequestFailure：未发头 → 500 api_error；已发头 → res.end()
```

### 1.3 一次 `/v1/chat/completions` 的业务链路（adapters/openai.mjs，按 grep 定位）

```
handleOpenAiChatCompletions(req,res,rawBody)
 ├─ JSON.parse → 解析 model（cn:/intl: 前缀）→ 黑名单检查（403 model_blacklisted）
 ├─ extractSessionKey(req,payload)                           scheduler.mjs:67
 ├─ AccountScheduler.selectAccount(model, sessionKey, {region, excludeUids})   scheduler.mjs:221
 ├─ prepareUpstreamBody(payload) → formatMessages → ensureLeadingSystem → applyReasoningParams → Gzip
 ├─ buildOfficialUpstreamHeaders(token, model, sessionKey, uid, isGzip, acc)
 ├─ acc.inFlight += 1                                        openai.mjs:246
 ├─ createUpstreamLifecycle(req,res,label)                   stream-guard.mjs:53
 │     AbortController + firstByteTimer(1200000ms) + req 'close' 监听
 ├─ fetch(UPSTREAM_URL, {signal}) → 非 2xx：extractStructuredBizCode → 分类：
 │     MODEL_FALLBACK → 降级链下一模型；QUOTA_EXHAUSTED → cooldown 换号；其余 → formatOpenAIError 直通
 ├─ 2xx 流式：startHeartbeat(res,label) → readUpstreamStream(reader, lifecycle) → 转译写下游
 ├─ 结束：isTruncatedWithoutFinish → buildTruncationChunk / buildEmptyStreamChunk
 ├─ acc.inFlight = max(0, inFlight-1)（共 5 处释放点：270/396/521/611/674）
 ├─ AccountScheduler.recordApiUsage(acc) → lastApiCallTimestamp + postCallRefreshTimers 防抖
 └─ metrics.recordApiCall(...)  → stats.json 聚合 + saveStats
```

> Anthropic 链路结构相同（`anthropic.mjs:285` 加、`309/416/657/760/820` 五处释放），差异在 SSE 事件转译。

---

## 2. 全局可变状态清单（16 处）

| # | 位置 | 状态 | 读 | 写 | Go 方案 |
|---|---|---|---|---|---|
| 1 | `config.mjs:388 export let config` | 整个配置对象 | 全部模块 | routes `/api/settings`、ensureApiKey、sticky 默认值注入 | `config.Store` 持 `*Config` + `RWMutex`；读返回快照（值拷贝或 atomic.Pointer） |
| 2 | `config.mjs:389 export let accounts` | 账号数组（**元素可变**：inFlight/cooldownUntil/modelCooldowns/status/creditsRemain 被原地改） | 全部模块 | scheduler / adapters / routes / server 启动修正 | `AccountStore`：`map[uid]*Account` + 切片保序 + `RWMutex`；**inFlight 用 atomic.Int32**（热路径） |
| 3 | `scheduler.mjs:49 sessionStickyMap` | `Map<sessionKey,{uid,createdAt,lastActive}>` | selectAccount、stats | selectAccount、cleanExpiredSessions、clear | `sync.Map` 或 RWMutex+map；清理 goroutine 独占删除 |
| 4 | `scheduler.mjs:53 lastApiCallTimestamp` | 闲置感知时间戳 | isGatewayIdle | recordApiUsage | `atomic.Int64`（毫秒） |
| 5 | `scheduler.mjs:55 postCallRefreshTimers` | `Map<uid, Timeout>` | — | recordApiUsage、refreshActiveAccountsIfStale | `map[uid]*time.Timer` + mutex；或改为单 goroutine + channel 去抖 |
| 6 | `scheduler.mjs:217 rrIndex` | 轮询游标 | selectAccount | selectAccount | 并入 Scheduler 结构体，受同一把锁 |
| 7 | `scheduler.mjs:218 lastDispatchedUid` | 最近派发账号 | getCurrentActiveAccountInfo | selectAccount | 同上 |
| 8 | `scheduler.mjs:219 lastDispatchedTime` | 最近派发时间 | 同上 | 同上 | 同上 |
| 9 | `metrics.mjs:44 statsData` | stats.json 内存镜像 | 报表 API | recordApiCall、prune | `metrics.Store` + RWMutex；落盘走 storage 原子写 |
| 10 | `pricing.mjs:57 cachedCustomPrices` | pricing.json 缓存 | 成本计算 | /api/pricing/update | RWMutex 或 atomic.Pointer |
| 11 | `models.mjs:19 cachedRawUpstreamModels` | 模型矩阵缓存 | /v1/models、降级链 | fetchDetailedModels | RWMutex + lastFetch 时间戳 |
| 12 | `models.mjs:20 cachedRawPromotions` | 同上 | 同上 | 同上 | 同上 |
| 13 | `models.mjs:21 lastModelFetchTimestamp` | 缓存时间 | 同上 | 同上 | 同上 |
| 14 | `models.mjs:146 cachedBusyMap` | busy level 缓存 | 选号提示 | fetchUpstreamModelBusyLevels | 同上 |
| 15 | `models.mjs:21/147 lastBusyFetchTimestamp` | 同上 | 同上 | 同上 | 同上 |
| 16 | `logger.mjs:8 ringBuffer` | 最近 1000 条日志 | getLogs/getDates 兜底 | write/unshift/pop/clear/prune | 环形数组 + RWMutex；或 channel + 单 writer goroutine |
| + | `server.mjs:46-47 unhandledCount/lastUnhandledWarnAt` | 异常计数 | — | recordProcessAnomaly | Go 用 recover 中间件计数（atomic） |
| + | `server.mjs:268/281` 启动期局部变量 | 非持久 | — | — | 无需迁移 |

**Go 化原则**：
- `accounts` 是最大的坑：Node 版所有地方都直接改 `acc.inFlight`、`acc.cooldownUntil`，并在 `filter()` 回调里**顺手清理过期冷却**（`scheduler.mjs:319-336`，副作用藏在过滤里）。Go 版必须把"清理过期冷却"显式化，放在写锁内。
- `config` 的读远多于写，用 `atomic.Pointer[Config]` 做写时复制最省锁；但 `routes.mjs` 有多处原地改 `config.xxx` 再 `saveConfig()`，迁移时要改成"拷贝 → 改 → Store 替换"。

---

## 3. 定时器与后台任务清单（9 处）

| # | 位置 | 周期/触发 | 任务 | 可停条件 | Go 方案 |
|---|---|---|---|---|---|
| T1 | `scheduler.mjs:172` | 60s（`CLI_CLEANUP_INTERVAL_MS=6e4`） | `cleanExpiredSessions` | `unref()`，进程退出即停 | `time.NewTicker` + ctx |
| T2 | `server.mjs:241` | 5 min | `AccountScheduler.refreshActiveAccountsIfStale()` | 挂住进程 | 同上 |
| T3 | `server.mjs:246` | 1 h | `Logger.pruneOldLogs(3)` | 挂住进程 | 同上 |
| T4 | `server.mjs:253` | 1 h（`autoCheckin!==false` 时启动；启动时先跑一次） | `checkAndRunHourlyCheckin(false)` | 挂住进程 | 同上 |
| T5 | `scheduler.mjs:609` | `setTimeout`（recordApiUsage 内防抖，时长以源码为准） | 调用后延迟刷新积分 | 一次性 | `time.AfterFunc`，保存到 postCallRefreshTimers 便于 Stop |
| T6 | `scheduler.mjs:652` | `setTimeout`（refreshActiveAccountsIfStale 内） | 后置刷新 | 一次性 | 同上 |
| T7 | `scheduler.mjs:1013` | 固定 `1200ms` sleep | 签到间隔（国内版） | 一次性 | `time.Sleep` 在可取消 ctx 内 → `select { case <-ctx.Done() }` |
| T8 | `scheduler.mjs:1049` | 随机 jitter sleep | 签到间隔（小时巡检） | 一次性 | 同上 |
| T9 | `stream-guard.mjs:83/167/288` | 首字节 1200000ms / 静默 300000ms / 心跳 5000ms | 每请求生命周期 | 请求结束 | `context.WithTimeout` + 独立心跳 goroutine |

**注意**：
- T2~T4 没有并发保护。Node 下因为每个任务是 async 且内部有 `await`，实际可能**重叠执行**（上一次没跑完下一次又触发）。Go 版要用"单飞"模式（`sync.Mutex.TryLock` 或 inflight 标志），否则刷新会叠加。迁移时要先确认 Node 版是否依赖这种重叠行为（预计不依赖）。
- T1 的 `unref()` 语义在 Go 里不存在等价物，直接 ctx 驱动即可。

---

## 4. Node 运行时依赖点 → Go 映射

| Node 特性 | 用在哪 | Go 对应 | 备注 |
|---|---|---|---|
| `process.on('SIGINT'/'SIGTERM'/'beforeExit')` | `server.mjs:65-75` 优雅停机 flush | `signal.NotifyContext` + `http.Server.Shutdown(ctx)` | flush 顺序必须保持：stats → accounts → config → db.Close |
| `process.on('unhandledRejection'/'uncaughtException')` | 进程级兜底，**不退出** | 每请求 goroutine 天然隔离 + `recover` 中间件 | Go 无法"全局不退出"兜底，必须在每个 goroutine 入口 recover；后台任务 goroutine 也要包 recover |
| `AbortController` + `fetch(..., {signal})` | `stream-guard.mjs:54` | `context.Context` + `http.NewRequestWithContext` | 首字节计时器 + 客户端断开都汇入同一 ctx |
| `ReadableStream.getReader()` | `readUpstreamStream` | `bufio.Reader` + `http.Flusher` | SSE 解析需自实现（event/data/空行/CRLF） |
| `node:zlib` gzip | `payload.mjs:1` | `compress/gzip` | 默认压缩级别 Node=zlib.constants.Z_DEFAULT_COMPRESSION(-1≈6)，Go `gzip.NewWriter` 默认也是 -1→6，一致；若源码显式指定需对齐 |
| `node:tls` `setDefaultCACertificates` | `tls-certs.mjs:102` | `x509.CertPool` 注入 `http.Transport.TLSClientConfig.RootCAs` | Node 版是**全局**注入；Go 版必须确保**所有**上游 Transport 共用同一个 pool，否则部分请求不走系统证书 |
| `child_process.execSync` (PowerShell / security) | `tls-certs.mjs:16,36` | `os/exec`（可保留，不引入 cgo）或 `x/sys/windows` Crypt32 | 保留 execSync 方案最省事且行为等价；Windows 下 `powershell` 路径依赖需测试 |
| `tls.rootCertificates`（Mozilla 内置 ~144 张） | `tls-certs.mjs:49` | Go 没有内置根证书，只读系统 | **行为差异**：Go 版在 Linux 容器内若无 CA 包会为空；需在 Dockerfile 安装 `ca-certificates` 或 embed 一份 Mozilla bundle |
| `node:sqlite` `DatabaseSync` | `database.mjs:29` | `modernc.org/sqlite` | 纯 Go，CGO_ENABLED=0 可编译；**同步 API**，与 Node 版一致；WAL + synchronous=NORMAL 照搬 |
| `fs.renameSync(tmp, main)` | `config.mjs:309` 原子写 | `os.Rename` | **Windows 下 `os.Rename` 不能覆盖已存在文件**（Go 用 MoveFileEx 带 REPLACE_EXISTING 实际上可以——Go 1.x 在 Windows 用 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`，可覆盖；但**目标被其他进程打开时会失败**）。需实测 |
| `crypto.randomUUID()` | Logger id、会话 key 兜底 | `crypto/rand` UUIDv4 | — |
| `crypto.createHash('md5')` | 会话指纹 | `crypto/md5` | — |
| `crypto.timingSafeEqual` | `safeCompareTokens` | `crypto/subtle.ConstantTimeCompare` | 长度不同时 Node 直接 false；Go 需先比长度（否则 subtle 直接返回 0，语义一致但要显式） |
| `process.uptime()` | `/healthz` | `time.Since(startTime)` | Node 的 uptime 不受时钟回拨影响；Go 用单调时钟 `time.Since` 同样不受影响 |
| `new Date().toISOString().slice(0,10)` | `metrics.mjs`、`logger.mjs` 日期 | `time.Now().UTC().Format("2006-01-02")` | **疑点**：日志行用本地时间 `getLocalTimeString()`，但裁剪用 UTC 日期 → 北京时间 0:00-8:00 之间边界不一致（见 §6-D4） |
| `Array.prototype.sort` 稳定 | `selectAccount` | `sort.SliceStable` | 见 §6-D3 |
| `String.prototype.padEnd` / `localeCompare` 等 | 日志格式化 | 手写 | 日志行格式必须逐字节一致，`log-parser.mjs` 与 `database.mjs:103` 的正则依赖它 |
| `fetch` 全局（undici） | 所有上游请求 | `net/http.Client` | 连接池参数、HTTP/2、`Accept-Encoding` 默认行为不同；Node fetch 默认 `accept-encoding: gzip, deflate, br`，Go 默认 `gzip` 且自动解压；需显式对齐 |
| `JSON.stringify` 字段顺序 | 写 config/accounts/stats.json | `encoding/json` 按 struct 字段顺序 | map 序列化 Go 会按 key 排序 → 与 Node 插入顺序不同；若前端/外部工具 diff 文件会看到顺序变化，**功能无影响**但要知晓 |

---

## 5. 迁移风险清单

### 高
| # | 风险 | 说明 | 规避 |
|---|---|---|---|
| R1 | `accounts` 原地可变 + 隐式副作用 | 5+ 处直接改字段，`filter()` 内清冷却 | P3 先定义 `AccountStore`，所有变更走方法；P7 迁移 scheduler 时逐处对照 |
| R2 | `inFlight` 释放点分散（adapters 内各 5 处） | Go 版任何提前 `return`/`panic` 漏释放即永久占名额 | 封装 `Acquire() (release func())`，`defer release()`；启动时归零逻辑照搬（`server.mjs:268-278`） |
| R3 | SSE 流式 + 心跳并发写 | Node 单线程天然串行；Go 两个 goroutine 同时 `Write` 会 interleaving | `SSEWriter` 内部 mutex 或单 writer goroutine + channel |
| R4 | `Logger` 同步 SQLite 在热路径 | 每条日志阻塞；Go 下若改成异步会改变日志顺序 | P3.5 迁移 Logger 时**先保持同步**，性能不达标再讨论异步（标注为行为差异） |
| R5 | 根证书来源差异 | Go 无 Mozilla 内置 | 容器镜像装 `ca-certificates`；或 embed Mozilla bundle 并与系统证书合并 |
| R6 | `routes.mjs` 62KB、40 个路由、直接调用 `AccountScheduler` 静态方法 | 迁移时依赖面最大 | 放最后（P11），且依赖 P7 的 Scheduler 接口先稳定 |

### 中
| # | 风险 | 说明 | 规避 |
|---|---|---|---|
| R7 | `sort` 稳定性 | Go 不稳定排序导致选号平局与 Node 不同 | `sort.SliceStable`，并用固定账号顺序做输入 |
| R8 | 定时任务重叠 | T2~T4 无单飞保护 | TryLock 单飞；迁移时确认 Node 版不依赖重叠 |
| R9 | `JSON.stringify` 顺序 | Go map 序列化按 key 排序 | 用 struct 而非 map 写文件；或接受顺序差异并在 CHANGELOG 注明 |
| R10 | Windows `os.Rename` 覆盖 | 目标被占用时失败 | 实测；必要时 `MoveFileEx` via `golang.org/x/sys/windows` |
| R11 | `fetch` 默认头差异 | `Accept-Encoding`、`User-Agent` 默认值 | 上游 Transport 显式设置；`buildOfficialUpstreamHeaders` 已显式给 UA |
| R12 | `robustParseJson` 容错栈 | 手写解析器（未闭合引号/括号补全） | 用测试用例锁定每个分支后再实现；建议直接移植算法而非用 Go JSON 库"近似" |

### 低
| # | 风险 | 说明 | 规避 |
|---|---|---|---|
| R13 | `/healthz` 用 `process.uptime()` | 换 `time.Since(start)` | — |
| R14 | 控制台横幅 emoji/文案 | 控制台可能被运维脚本 grep | 照搬字符串 |
| R15 | `console.log` 与 `Logger` 双写 | 启动横幅走 stdout，其余走 Logger | 保持 |

---

## 6. 源码疑点（迁移时照搬，不修；留给 Node 版单独修）

| # | 位置 | 现象 | 影响 |
|---|---|---|---|
| D1 | `scheduler.mjs:296-297` | 先 `sticky.lastActive = now`，再算 `remainingSec = idleTtl - (now - sticky.lastActive)` → 恒等于 `idleTtl` | 日志"剩余保活"永远显示满 TTL（7 天），无功能影响 |
| D2 | `scheduler.mjs:144 + 367` | 无法提取会话特征时 key = 随机 UUID，但仍 `sessionStickyMap.set(key, ...)` | 每个无特征请求新增一条 7 天才过期的记录；高 QPS 下 map 持续增长（仅靠 60s 清理 + 7 天 TTL 兜底） |
| D3 | `scheduler.mjs:349-352` | `rrIndex` 对 `candidates.length` 取模，候选集变化时游标指向会漂移 | 与"严格轮询"语义不同，但这是现网行为，Go 版照搬 |
| D4 | `logger.mjs:88,142` vs `config.mjs getLocalTimeString` | 日志时间用本地时区，裁剪 `cutoffDate` 用 `toISOString()`（UTC） | 北京时间 00:00-08:00 期间 `pruneLogsByTime('today_only')` 的"今天"是 UTC 昨天，会多删/少删一天边界 |
| D5 | `database.mjs:84-87` | SQLite 打开失败静默降级为 `useSqlite=false`，仅内存环形缓冲 | 控制台日志查询只能看最近 1000 条，无任何告警；Go 版建议至少打一条 error 日志（标注为行为差异） |

---

## 7. 推荐迁移顺序（相对事实卡 Phase 的调整）

```
事实卡 Phase 1: config/storage + database + tlscerts
事实卡 Phase 2: headers/errors/payload/stream-guard
事实卡 Phase 3: scheduler
事实卡 Phase 4: adapters
事实卡 Phase 5: web + main
```

**调整建议**：

1. **Logger 提前到 Phase 1 首位**（P3 之前或并行）。它被所有模块 import，且依赖 `database.mjs` 与 `config.getLocalTimeString`。先定 `Logger` 接口（`Info/Warn/Error(category, msg, meta)` + `GetLogs/GetDates/Clear/Prune`），后续模块才能写日志。
   → 新增 **P3.0：logger + database（logs 表部分）**，`credit_history` 可留到 P8。
2. **`tls-certs` 并入 P3.0 或 main**：它无依赖、只在启动时跑一次，但 R5（根证书来源）要在 Dockerfile 阶段就决定。
3. **`stream-guard`（P6）提前到 scheduler（P7）之前**：事实卡已是这个顺序，保持。但 P6 的 `SSEWriter` 应与 P9 共享，所以 P6 产出里要包含 `internal/adapters/sse.go` 的雏形。
4. **`web/routes` 拆两半**：40 个路由里约一半（auth/settings/keys/logs/pricing/credits history）只依赖 config+store+database，可以在 P8 后就迁；另一半（accounts/oauth/checkin/metrics/models）依赖 Scheduler，留到 P11。
5. **`log-parser.mjs` 可延后或暂不迁**：它是"从 gateway.log 重建 stats"的兜底工具，仅在 stats.json 损坏时使用；Go 版若 database 稳定，可先提供等价函数但不接入主流程（标注）。

调整后的依赖图：

```
P3.0 logger+database(logs)+tlscerts ─┐
P3   config/storage/accountStore ────┤
P4   headers/errors ─────────────────┤
P5   payload/models ─────────────────┤
P6   stream-guard + SSEWriter ───────┤
P7   scheduler (依赖 P3) ────────────┤
P8   metrics/pricing/db(credits) ────┤
P9   openai adapter (依赖 P4-P8) ────┤
P10  anthropic + tools ──────────────┤
P11  web routes + main ──────────────┘
```

---

## 8. 对 `GOLANG_REFACTOR_PROMPT_KIT.md` 事实卡的修正

| 行 | 原文 | 修正为 |
|---|---|---|
| 会话粘性 TTL | `7 天 \| config.mjs:408 STICKY_DEFAULT_TTL_MS` | `7 天（idle 与 maxLifetime 均为 7 天）\| config.mjs:408,413-417 写入 config.stickySessionTtlMs/stickySessionMaxLifetimeMs；routes.mjs:349-363 可改，范围 [10s, 365d]` |
| 调度器 CLI 常量 | `任务 TTL 3e5 / 清理间隔 6e4 / Prompt 超时 18e5 \| scheduler.mjs:35-49 (CLI)` | `3e5 与 18e5 仅为 config 未设置时的兜底（实际被 7 天默认值覆盖，为死分支）；6e4 清理间隔为实际生效值 \| scheduler.mjs:35-49,152-157,172` |

> 其余事实卡条目经本次核查无误。

---

## 9. 下一步

1. 按本诊断修订 `GOLANG_REFACTOR_PROMPT_KIT.md`：新增 P3.0（logger + database）、拆分 P11、修正事实卡两行。
2. 进入 P2：基于本诊断输出 Go 包依赖图、核心接口（`AccountStore / Scheduler / UpstreamClient / LogStore / SSEWriter / AppError`）与 main 骨架。
