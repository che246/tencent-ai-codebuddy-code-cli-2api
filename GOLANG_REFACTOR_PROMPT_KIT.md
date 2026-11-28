# CodeBuddy 网关 → Go 重构提示词包（整套 · 分阶段投喂版 v2）

> 配套文档（同一仓库）：
> - `GOLANG_REFACTOR_PROMPT.md` — 项目总览（背景阅读；2026-11-29 已就地勘误三处：粘性 TTL 7 天、链路 ID 两对、网关无 8 次重试计数器；仍以本包事实卡与规格卡为准）
> - `docs/GO-MIGRATION-DIAGNOSIS.md` — P1 诊断（已完成）
> - `docs/GO-MIGRATION-ARCHITECTURE.md` — P2 架构（已完成）
> - `docs/GO-MIGRATION-SPEC-CARDS.md` — 逐模块行为规格卡（**每个模块提示词引用其对应 §**）
>
> **使用方法**
> 1. 新会话 → 依次贴 **P0** + **事实卡** + **架构文档 §3/§5/§7**。
> 2. 按附录 A 顺序投 P3.0 → P3 → … → P11。**一个模块一个会话**；每次先贴 P0 + 事实卡 + 本模块规格卡 §N + 该模块 .mjs 全文。
> 3. 每个模块产出后立刻跑 **P12 评审** → **P13 验证** → 通过后才进下一个模块。
> 4. 涉及 CLI 常量的模块（P4/P6/P9/P10），先让 AI 执行 **P0 附带的 CLI 核查步骤**并贴出证据，再写代码。
> 5. 超过 40KB 的源码（scheduler / anthropic / routes）按附录 C 分两次投喂。

---

# P0 · 全局铁律（每个会话开头必贴）

```
你是资深 Go 架构师，负责把一个 Node.js 22 (ESM, 零框架, 零 npm 依赖, 仅 node 内置模块) 写的网关等价迁移为 Go。
本项目 = 腾讯 CodeBuddy CLI v2.179.0 的协议复刻网关。以下原则任何一条违反都视为不合格交付：

【铁律 1：行为等价 > 代码优美】
这是"迁移"不是"重设计"。每个函数的输入输出、每个分支条件、每个默认值、每条日志文案（含中文与空格）、每个 HTTP 状态码与 JSON 键名，都必须与 Node 版一致。不得"顺手优化"业务逻辑；若你认为原逻辑有 bug，只在回复末尾「发现的疑点」里列出，不要改。已知疑点见规格卡 §12（D1~D10），这些全部"照搬"。

【铁律 2：CLI 是唯一依据】
涉及超时、重试、错误分类、请求头、协议字段的数值/语义：
- 有 CLI 依据的：注释写 `// CLI: <变量名>=<值> | bundle: <证据片段>`
- 网关自有策略：注释写 `// 网关自有策略，无 CLI 对应实现：(<理由>)`
- 两者都没有：禁止出现，停下来问我。
- 涉及 CLI 常量的模块，写代码前先在 package/dist/codebuddy-headless.js 中 grep 对应符号并贴出 ±150 字符上下文作为证据（见附录 D 命令）。找不到证据不得凭记忆写数值。

【铁律 3：技术硬约束】
- Go 1.22+，module `codebuddy-gateway`，目录结构按架构文档 §2
- CGO_ENABLED=0；SQLite 用 modernc.org/sqlite；Windows 证书提取用 os/exec 调 powershell
- HTTP 只用标准库 net/http（路由可用 chi）；前端 //go:embed
- 日志用自定义 slog.Handler 精确复刻 Node 行格式（架构 §3.2）；禁止 JSON 行格式
- 禁止：包级可变 var、init() 副作用、panic 作控制流、map 遍历顺序依赖、sort.Slice（非稳定）
- 每个 goroutine 必须有 ctx 或 WaitGroup 管理的退出路径；每个 handler 必须有 recover
- inFlight 释放必须通过 Acquire() 返回的 defer release()

【铁律 4：包依赖】
严格遵守架构文档 §2 的 DAG；database/tlscerts/config 为叶子；不得出现循环 import。

【铁律 5：输出格式】
1. 迁移思路（≤10 行：Node 概念 → Go 概念映射）
2. 完整可编译 Go 代码（带包声明与 import；不省略、不用 "...省略..."）
3. 符号对照表：Node 导出符号（含文件:行）→ Go 符号，一行一个；源码中的内部函数若承载分支逻辑也要列
4. _test.go：表驱动，覆盖源码中每个 if 分支；涉及 goroutine 的附 goleak 校验
5. 发现的疑点（新增的，D1~D10 之外）
6. 网关自有策略清单（本模块中无 CLI 依据的数值/逻辑）
7. CLI 证据（若本模块涉及）：grep 命令 + 片段
```

---

# 项目事实卡（每个会话与 P0 一起贴；已按源码与 CLI 产物核实）

```
【项目事实卡 · CodeBuddy Gateway v2.5.0 → Go】

## 1. 项目是什么
把腾讯 CodeBuddy CLI 的上游协议（国内 copilot.tencent.com / 国际 www.codebuddy.ai）多账号池化后，
对外暴露 OpenAI /v1/chat/completions、Anthropic /v1/messages、/v1/models、/v1/search、/v1/fetch，
并提供单页 Web 控制台（:8317，40 个 /api/* 路由）。Agent 工具调用全部交还下游客户端执行。

## 2. 源码模块（src/，15 个 .mjs，零 npm 依赖）
config.mjs(35KB) core/{logger,tls-certs,scheduler,database,metrics,pricing,log-parser}.mjs
upstream/{headers,errors,payload,stream-guard,models}.mjs adapters/{openai,anthropic,tools}.mjs web/routes.mjs
入口 gateway.mjs → src/server.mjs；前端 src/web/public（原样 embed，不改）

## 3. 常量表（迁移时原样照搬）
| 项 | 值 | 依据 |
|---|---|---|
| CLI 版本 / 首 token 超时 / 流总时长 | 2.179.0 / 1,200,000ms / 1,200,000ms | CLI FIRST_TOKEN_TIMEOUT_MS 默认 mm=12e5；STREAM_TIMEOUT_MS 默认 my=12e5 |
| 空流重试窗口 | 300,000ms | CLI EMPTY_STREAM_RETRY_MAX_ELAPSED_MS 默认 AK=mb=3e5 |
| finish_reason 宽限 | 5,000ms | CLI tf=5e3 |
| CLI 请求重试 | 默认 8，硬上限 15 | CLI mC/mv（resolveRequestMaxRetries）。注意：网关未实现按次数重试，重试边界 = 账号集合 × 降级链 |
| 思考保活 / JSON 保活 | CLI 默认均为 0（关闭） | CLI REASONING_KEEPALIVE_INTERVAL_MS / STREAM_KEEPALIVE_INTERVAL_MS |
| 网关流静默看门狗 | 300,000ms | 网关自有策略：借用 CLI mb=3e5 |
| 网关心跳 | 5,000ms | 网关自有策略（CLI 默认 0） |
| 会话粘性 TTL / maxLifetime | 7 天（config 默认写入；routes 可改 [10s,365d]） | config.mjs:408,413-417；CLI 3e5/18e5 仅为死分支兜底 |
| session 清理间隔 | 60,000ms | CLI CLEANUP_INTERVAL_MS=6e4（scheduler.mjs:172） |
| 网关空闲阈值 / 刷新 / 日志轮转 / 签到 | 15min / 5min / 1h / 1h | 网关自有策略 |
| 模型矩阵缓存 / busy 缓存 | 5min / 60s | 网关自有策略（CLI 对照 48e4=8min） |
| 请求体上限 | 50MB | server.mjs:81 |
| tools 超时 | 15,000ms | 网关自有策略（tools.mjs） |
| DEFAULT_MAX_TOKENS | 128000 | payload.mjs:150 |
| 思考等级 | off minimal low medium high xhigh max | payload.mjs:138 |
| 默认模型 | deepseek-v4.1-flash（Claude 系名称会被强制改写为此） | openai.mjs:95, anthropic.mjs:47-49 |
| 区域前缀 | cn: / intl: | payload.mjs:47 |
| 被封 UA 子串 | python-requests（不区分大小写） | headers.mjs:37（网关风控规则） |
| 空流判定 | hasSubstantiveContent=正文||工具||拒答；emptyStreamKind= reasoning-only | no-token | stream-guard.mjs；CLI hasSubstantiveContent 已核实 |

## 4. 链路 ID（勘误后）
X-Request-ID = X-Conversation-Message-ID = messageId(32hex)
X-Conversation-Request-ID = X-Root-Request-ID = conversationRequestId(32hex，与 messageId 不同)
X-Conversation-ID = UUIDv7(36)；X-Trace-ID 独立 32hex；另有 traceparent/baggage/X-B3-*/X-Stainless-*/X-Private-Data
完整 38 头见规格卡 §5.1

## 5. 目标目录（架构文档 §2）
cmd/gateway/main.go · internal/server · internal/web · internal/adapters · internal/upstream
internal/config · internal/core/{logger,tlscerts,scheduler,database,metrics,pricing} · public/(embed)

## 6. 数据目录
GW_DATA_DIR env > 可执行文件目录 > cwd（架构 §3.1【决策】，等价 Node 的 ROOT_DIR=源码上级）
```

---

# P1 · 项目诊断 —— 已完成
产出：`docs/GO-MIGRATION-DIAGNOSIS.md`。后续会话贴其 §2（状态表）、§3（定时器）、§6（疑点）。

# P2 · 架构落地方案 —— 已完成
产出：`docs/GO-MIGRATION-ARCHITECTURE.md`。后续会话贴其 §3（接口）、§5（状态映射）、§7（CLI 常量表）、§9（停机）。

---

# P3.0 · 模块迁移：logger + database(logs) + tls-certs

```
【任务】迁移 src/core/logger.mjs、src/core/database.mjs（本阶段只迁 logs 表，credit_history 留到 P8）、src/core/tls-certs.mjs
到 internal/core/{logger,database,tlscerts}。这是所有模块的依赖底座。先贴 P0 + 事实卡 + 规格卡 §2 + 架构 §3.2/§3.3/§3.5(tls)/§11。

【源码】
<粘贴 src/core/logger.mjs 全文>
<粘贴 src/core/database.mjs 全文>
<粘贴 src/core/tls-certs.mjs 全文>
<粘贴 src/config.mjs 中 getLocalTimeString / getTodayString / formatUptime 片段>

【必须等价迁移的符号】
logger:   Logger.write/info/warn/error, getLogs, getDates, clear, pruneLogsByTime, pruneOldLogs, ringBuffer(1000)
database: DB_PATH, LogDatabaseEngine.init / migrateFromGatewayLogIfEmpty / insertLog / queryLogs / getDates / clearLogs /
          pruneLogsByTime / pruneOldLogs / checkAndPruneBySize / getSizeMb / close，export LogDatabase 单例
tls-certs: TlsCertificateStack.extractOsCertificates / init / loadedCount

【行为红线】
1. 日志行逐字节一致：`[YYYY-MM-DD HH:mm:ss] [LEVEL ] [CATEGORY] message | {"meta":...}\n`；LEVEL padEnd(5)；meta 为 JSON.stringify 紧凑格式（键顺序 = 插入顺序 → Go 用有序 map 或 []kv，不要用 map 序列化）
2. info/warn → stdout，error → stderr；同时 appendFile(gateway.log) + 同步插入 SQLite + 环形缓冲（unshift，上限 1000）
3. 【网关】SQLite 插入保持同步（诊断 S4）；注释写明"异步化属行为差异，未采用"
4. 【D4 照搬】日志时间 time.Local；prune 的 cutoffDate 用 UTC。注释标注"与 Node 一致，疑点 D4"
5. 【D5】SQLite 打开失败 → 降级 useSqlite=false；【决策】Go 版额外 Logger.Error 一条
6. getLogs 在 DB 无结果时用环形缓冲兜底，过滤/分页逐项照搬
7. pruneOldLogs(3)：DB 按天 + DB 按体积 + gateway.log 按行 + 环形缓冲，四路都照搬
8. tls-certs：三级来源（内置根证书 → 本地 pem → OS 自提取 → env 附加）。【决策】Go 无内置根证书，第 1 级改为 embed Mozilla bundle 或依赖系统 ca-certificates，注释标明差异
9. OS 自提取：Windows powershell / macOS security / Linux 读 crt；超时 4000ms；去重计数口径一致
10. NODE_TLS_REJECT_UNAUTHORIZED=0 → InsecureSkipVerify + 同样 warn（注释：安全风险，保持兼容）
11. DDL 与 Node 一字不差；WAL + synchronous=NORMAL；MaxOpenConns=1
12. migrateFromGatewayLogIfEmpty 的正则逐字抄进测试

【Go 化要求】
- Logger 实现 slog.Handler 接口，但 Handle 输出上述精确格式
- database.Engine 不 import 任何 internal 包
- 测试：每级别 × 有/无 meta 的 golden；TZ=Asia/Shanghai 固定；环形 999/1000/1001；UTC/本地跨日裁剪用例（锁定 D4）；用现网 logs.db 样本做打开/查询 golden

【输出】按 P0 铁律 5。
```

---

# P3 · 模块迁移：config + storage + accountStore

```
【任务】迁移 src/config.mjs 到 internal/config/（config.go account.go storage.go keys.go blacklist.go policy.go）。
先贴 P0 + 事实卡 + 规格卡 §1 + 架构 §3.1/§5。

【源码】
<粘贴 src/config.mjs 全文>

【必须等价迁移的符号】
常量/路径：CURRENT_VERSION, CLI_VERSION, CLI_USER_AGENT, USER_AGENT, ROOT_DIR→dataDir, CONFIG_PATH, ACCOUNTS_PATH, BACKUP_DIR,
  LOG_FILE_PATH, LOG_DB_PATH, STATS_PATH, PRICING_FILE_PATH, REGION_CN/INTL, REGION_BASE（含 endpointsFor 的全部端点函数）,
  STICKY_DEFAULT_TTL_MS, MODEL_BLACKLIST_KEY, VALID_THINKING_LEVELS, VALID_OVERRIDE_MODES, VALID_PROMPT_MODES, DEFAULT_*
加载：ensureBackupDir, migrateLegacyBackups, writeJsonWithBackup, loadJsonWithBackup, ensureApiKey, 模块初始化顺序（规格卡 §1.2）
账号：normalizeAccount, resolveAccountRegion, normalizeRegion, baseForAccount, endpointsFor, formatAccountLogName, formatAccountFullDesc
解析：robustParseJson（规格卡 §1.4 全部分支）
Key：generateRandomApiKey, getApiKeys, isValidApiKey, safeCompareTokens, addApiKey, updateApiKey, removeApiKey
黑名单：getModelBlacklist, setModelBlacklist, isModelBlacklisted, isStepUnavailableByBlacklist
策略：get/setThinkingPolicy, setModelThinkingLevel, get/setPromptPolicy, loadSystemPromptContent,
      get/setLoggingPolicy, get/setPrivateDataPolicy
持久化：saveAccounts, saveConfig, updateAccounts
工具：getTodayString, getLocalTimeString, formatUptime

【行为红线】
- JSON 字段名与 Node 完全一致（前端、控制台、log-parser 依赖）；struct 字段顺序 = Node 插入顺序，用现网 config.json/accounts.json 做"读入→写回"golden
- robustParseJson 的每个容错分支各有测试；Go 先预处理再 json.Unmarshal，禁止第三方容错库
- 原子写：tmp → fsync → rename；Windows 下目标被占用时的处理要实测并写注释；三级恢复成功后回写主文件并 warn
- generateRandomApiKey 格式/长度/字符集逐字符一致
- normalizeAccount 的 JWT 解析（base64url，无填充）、uid 兜底 `uid_<ts>`、region 解析顺序、默认字段
- 黑名单匹配：精确带前缀 / 精确裸名 / `*` 通配 / 区域级规则，每种至少 1 个用例
- setModelBlacklist：trim、小写、去重、落盘
- 【决策】数据目录：GW_DATA_DIR > 可执行文件目录 > cwd；日志一条 CONFIG 记录最终路径
- 列出本模块读取的所有 process.env（预计无；若有时用同名 env）

【Go 化要求】
- Store 持 atomic.Pointer[Config]；UpdateConfig 为"拷贝→改→原子替换→saveConfig"；AccountStore 见架构 §3.1
- Acquire/Release 幂等；Release 二次调用无副作用
- 所有落盘经同一把 mu 串行化

【输出】按 P0 铁律 5。
```

---

# P4 · 模块迁移：upstream/headers + errors + cliconsts

```
【任务】迁移 src/upstream/headers.mjs、src/upstream/errors.mjs 到 internal/upstream/，并创建 cliconsts.go。
先贴 P0 + 事实卡 + 规格卡 §5 + 架构 §3.5/§3.8/§7。

【CLI 核查步骤（写代码前必须执行）】
在 package/dist/codebuddy-headless.js 中执行附录 D 的命令，贴出以下符号的上下文：
CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS / STREAM_TIMEOUT_MS / REASONING_KEEPALIVE_INTERVAL_MS / STREAM_KEEPALIVE_INTERVAL_MS /
EMPTY_STREAM_RETRY_MAX_ELAPSED_MS / MAX_RETRIES / `mm=12e5,my=12e5` / `mC=8,mv=15,mb=3e5` / `tf=5e3` /
X-Conversation-Message-ID / X-Conversation-Request-ID / X-Root-Request-ID / X-Stainless- / X-Private-Data / hasSubstantiveContent
把核实结果写入 cliconsts.go 注释。

【源码】
<粘贴 src/upstream/headers.mjs 全文>
<粘贴 src/upstream/errors.mjs 全文>

【必须等价迁移的符号】
headers: BLOCKED_UA_SUBSTRINGS, sanitizeUserAgent, uuidv7, uuidv7Hex, resolvePrivateDataHeader, buildOfficialUpstreamHeaders（38 个头）
errors:  ServerErrorCode, MODEL_FALLBACK_CODES, QUOTA_EXHAUSTED_CODES, ACCOUNT_RESTRICTED_CODES, TRANSIENT_RATE_LIMIT_CODES,
         PTL_SUBSTRINGS, isInputLengthError, extractStructuredBizCode(depth=6), formatOpenAIError
cliconsts: 架构 §7 全表

【风控红线（逐行对齐）】
- 链路 ID 两对：X-Request-ID = X-Conversation-Message-ID = messageId；X-Conversation-Request-ID = X-Root-Request-ID = conversationRequestId；X-Trace-ID 独立；X-Conversation-ID 为 UUIDv7
- UUIDv7：48 位毫秒大端 ‖ ver7 ‖ 12 rand ‖ var=10 ‖ 62 rand；36 字符小写与 32 字符 hex
- UA 含 python-requests（不区分大小写）→ 回退官方 UA
- X-Stainless-OS/Arch 固定 Windows/x64；X-Stainless-Runtime-Version 取 process.version →【决策】Go 固定常量（如 "v22.14.0"），注释标注差异
- X-Domain：acc.domain 优先，否则区域 web 主机
- X-Private-Data 由 resolvePrivateDataHeader 决定取值或省略
- 38 个头的名称、取值、是否省略条件全部照搬；Go http.Header 无序，若源码无顺序依赖则在注释说明
- extractStructuredBizCode 6 层递归：number 与 string 均可，返回原始类型
- formatOpenAIError 的状态码/业务码 → {message,type,code} 映射逐条 golden

【Go 化要求】
- uuidv7 用 crypto/rand 自实现；测试断言时间戳前缀、版本位、变体位
- 错误码集合用 map 或 switch，注释标明每个码触发的动作（降级 / 冷却换号 / 直通 / 403）
- 构建头用 http.Header，并提供 HeadersToString(h) 便于 golden 测试

【输出】按 P0 铁律 5（含 CLI 证据）。
```

---

# P5 · 模块迁移：upstream/payload + models

```
【任务】迁移 src/upstream/payload.mjs、src/upstream/models.mjs 到 internal/upstream/。
先贴 P0 + 事实卡 + 规格卡 §6 + 架构 §3.5/§8。

【源码】
<粘贴 src/upstream/payload.mjs 全文>
<粘贴 src/upstream/models.mjs 全文>

【必须等价迁移的符号】
payload: sanitizeChannelFingerprints, formatMessagesForUpstream, REGION_PREFIX, parseModelRegion, DEFAULT_INTL_SYSTEM,
          ensureLeadingSystemMessage, applySystemPromptPolicy, THINKING_LEVELS, EFFORT_RANK, DEFAULT_MAX_TOKENS=128000,
          clampThinkingLevel, getUpstreamDefaultEffort, applyReasoningParams, applyModelCapabilityGuards,
          prepareUpstreamBody, extractArchiveContext
models:  warnLegacyProductSnapshot, resolveModelPromotion, fetchUpstreamModelBusyLevels, fetchDetailedModels, attachProbeStatus

【协议红线】
- 上游只接受平铺 reasoning_effort / reasoning_summary / verbosity；严禁 thinking:{} / reasoning:{} 嵌套对象出现在上行 body
- intl 缺 system 时在 messages[0] 补 {role:"system", content:DEFAULT_INTL_SYSTEM}；幂等
- applySystemPromptPolicy 三模式逐分支复刻；【D7】append 模式非幂等是已知疑点，本模块照搬，不要改
- clampThinkingLevel 的 rank 表、三种 overrideMode（client_first / gateway_level_only / gateway_override_all）逐分支复刻
- Gzip 触发阈值、Content-Encoding 以源码为准；Go compress/gzip 默认级别与 Node zlib 默认一致（注释说明）
- 模型矩阵：双区 /v3/config，5s 超时，缓存 5min【网关】，失败用 product.json 快照兜底 + warnLegacyProductSnapshot；并发去重
- busy：仅国内版，X-Domain: copilot.tencent.com，每批 50，4s 超时，缓存 60s【网关】
- 输出字段（id, vendor, regions, contextWindow, maxInputTokens, maxOutputTokens, capabilities, busyLevel, probeStatus…）以源码为准，/v1/models 与控制台依赖

【Go 化要求】
- body 用 map[string]any + json.RawMessage（保留未知字段、content 双形态）
- messages 的 content 支持 string 与 []content_block
- 模型缓存用 RWMutex + inflight 去重（singleflight 模式，手写即可）
- 测试：payload 每个 if 一个 case；models 用 httptest 回放两区 /v3/config 固件；缓存命中/过期/并发去重各一例

【输出】按 P0 铁律 5。
```

---

# P6 · 模块迁移：upstream/stream-guard + SSEWriter

```
【任务】迁移 src/upstream/stream-guard.mjs 到 internal/upstream/streamguard.go，并在 internal/adapters 新建 sse.go（SSEWriter）。
这是全项目最关键模块，必须逐函数对照。先贴 P0 + 事实卡 + 规格卡 §7 + 架构 §3.6/§3.7。

【CLI 核查步骤】
附录 D 命令核实：FIRST_TOKEN_TIMEOUT_MS（mm=12e5）、STREAM_TIMEOUT_MS（my=12e5）、EMPTY_STREAM_RETRY_MAX_ELAPSED_MS（AK=3e5）、
tf=5e3、hasSubstantiveContent / emptyStreamKind / 'reasoning-only' / 'no-token'。贴出片段后再写代码。

【源码】
<粘贴 src/upstream/stream-guard.mjs 全文>
<粘贴 src/adapters/openai.mjs 第 426-527 行（流式分支，用于对照 touch/markUpstreamEnded 调用点）>
<粘贴 src/adapters/anthropic.mjs 第 445-663 行（流式分支，用于对照"只在可见事件后 touch"）>

【必须等价迁移的符号】
FIRST_BYTE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS, FINISH_REASON_GRACE_MS,
createUpstreamLifecycle, readUpstreamStream, startHeartbeat, createDeltaClassifier,
isTruncatedWithoutFinish, buildEmptyStreamChunk, buildTruncationChunk, logStreamOutcome, TERMINAL_RE

【语义红线（任何一条偏差都是 P0 缺陷）】
1. 首字节 1200000ms【CLI mm】同时覆盖"响应头到达"与"首 token 到达"：Node 只有一个 firstByteTimer，在 fetch 返回后 markFirstByte 清除；
   首次 onChunk 是否再计一个？以源码为准，不要发明第二个计时器
2. 静默看门狗 300000ms【网关，借用 mb】每 chunk 重置；超时 reason='idle-timeout'
3. 心跳 5000ms【网关】：setInterval 每 tick 检查 now-lastWrite>=interval 才发；touch() 置 lastWrite=now。
   OpenAI 路径每 chunk touch；Anthropic 路径只在写出可见事件后 touch（规格卡 §7.3）
4. [DONE] 跨 chunk 拼接用 12 字符尾巴；sawDone 后 stopOnDone → cancel reader
5. finish_reason 后 5000ms【CLI tf】宽限接收 usage 帧，然后关流（具体实现以源码为准）
6. 分类器三条公式原样实现；finish_reason 记录
7. 截断补偿：有实质产出且 !sawDone && !sawFinish && !sawError → length chunk；否则 empty chunk(kind) → error
8. 客户端断开（req close 且上游未结束）→ reason='client-gone'；markUpstreamEnded 后断开不算 client-gone
9. logStreamOutcome 的分类/文案逐字一致（log-parser 依赖）

【Go 实现要求】
- Lifecycle：context.WithCancelCause + 两个 time.Timer；Reason() 返回 cause 字符串；Dispose 幂等
- ReadUpstreamStream：bufio.Reader 逐行（SSE 规范：event:/data:/空行/CRLF/多行 data 拼接）；onChunk 收到的是原始 chunk 字符串（与 Node 一致，适配层自己解析）还是行？——以 Node 语义为准：传原始 chunk
- SSEWriter：mutex 串行化 reader goroutine 与 heartbeat goroutine；Write 失败置 dead；Ended() 供 onChunk 早退
- 所有 goroutine ctx 驱动；提供可注入 now/timer；goleak 校验
- 测试至少：正常完成 / 首 token 超时 / 中途静默 / 只有 reasoning / 完全无 token / finish 后 usage 尾帧 / 客户端中途断开 / 上游 5xx / 心跳期间收到 chunk 停止心跳 / [DONE] 被拆成两个 chunk

【输出】按 P0 铁律 5（含 CLI 证据）。
```

---

# P7 · 模块迁移：core/scheduler

```
【任务】迁移 src/core/scheduler.mjs（57KB）到 internal/core/scheduler/（scheduler.go sticky.go token.go checkin.go）。
分两次投喂：第一次只要"符号清单 + 每个方法的分支摘要 + 日志分类"；确认后再要代码。
先贴 P0 + 事实卡 + 规格卡 §3 + 架构 §3.4/§6。

【源码】
<粘贴 src/core/scheduler.mjs 全文>

【必须等价迁移的符号】
CLI_COMPLETED_TASK_TTL_MS=3e5, CLI_CLEANUP_INTERVAL_MS=6e4, CLI_PROMPT_TIMEOUT_MS=18e5, GATEWAY_IDLE_THRESHOLD_MS,
sessionStickyMap→Scheduler.sticky, extractSessionKey, cleanExpiredSessions, getSessionAffinityStats, clearSessionStickyMap,
class AccountScheduler 全部方法（先逐个列名，再逐个迁移）

【并发红线】
- 对外方法全部并发安全；内部一把 mu；inFlight 走 AccountStore.Acquire/Release
- 选号用 sort.SliceStable；候选顺序 = accounts.json 顺序
- filter 内的副作用（清过期 cooldownUntil / modelCooldowns）必须保留并在写锁内
- 粘性复用分支：excludeUids 命中 → 不删不用于池；模型冷却 → 不删；账号受限 → 删并 info「已自动解绑」
- pinnedAccount 匹配：uid/uin/email 精确小写、note 包含小写；受限判定顺序见规格卡 §3.4
- extractSessionKey 四级优先级逐项复刻（header 6 个键顺序、payload 7 个字段顺序、指纹 seed 切片 500、MD5）
- 冷却：cooldown(uid, sec, reason) / cooldownModel(uid, model, sec, reason) 的字段名 modelCooldowns / modelCooldownReasons 与 routes 依赖一致

【后台任务（每个独立 goroutine，ctx 驱动，RunPeriodic 单飞）】
- T1 60s session 清理【CLI 6e4】
- Token 提前 N 天续签（tokenRefreshAdvanceDays 默认 7，[1,30]）；失败重试退避以源码为准
- 每日签到 checkAndRunHourlyCheckin：国内/国际端点与文案、1200ms 固定间隔、随机 jitter、单账号失败隔离
- refreshActiveAccountsIfStale 5min；refreshStaleCredits(minIntervalMs,{force})；refreshCredits 写 credit_history（阈值与文案以源码为准）
- recordApiUsage 的 postCall 防抖 timer（时长以源码为准）；Stop 后从 map 删除
- GATEWAY_IDLE_THRESHOLD_MS 的用途照搬

【Go 化要求】
- sleep 用 select { case <-ctx.Done(): return; case <-timer.C: }；禁止裸 time.Sleep 不可取消
- 可注入 now / http client；测试用 httptest 模拟积分/签到/续签端点
- 并发方法附 -race 测试：并发 selectAccount + cooldown + cleanExpiredSessions 各 1000 次，无 panic、无死锁

【输出】按 P0 铁律 5。
```

---

# P8 · 模块迁移：core/metrics + pricing + log-parser + database(credits)

```
【任务】迁移 src/core/metrics.mjs、pricing.mjs、log-parser.mjs 到 internal/core/{metrics,pricing,logparser}，并把 credit_history 表补进 internal/core/database。
先贴 P0 + 事实卡 + 规格卡 §4 + 架构 §3.3。

【源码】
<粘贴 src/core/metrics.mjs 全文>
<粘贴 src/core/pricing.mjs 全文>
<粘贴 src/core/log-parser.mjs 全文>
<粘贴 src/core/database.mjs 中 credit_history 相关方法>

【必须等价迁移的符号】
metrics:   STATS_PATH, loadStats, saveStatsSync, saveStats, pruneStatsByTime, recordApiCall, formatTokenNumber,
           getShiftedDateString, getAccountStatsByRange, getMetricsReport
pricing:   PRICING_FILE_PATH, DEFAULT_OFFICIAL_PRICES, loadModelPrices, saveModelPrices, calculateModelUsageCost,
           formatCurrency, searchOfficialPricingOnline
log-parser: rebuildRealStatsFromLog
database:  credit_history 的 insert/query/clear

【行为红线】
- stats.json 结构与字段名完全一致（accounts.<uid|email>.<date>.{...}），用现网 stats.json 做 golden
- loadStats 不存在时调用 rebuildRealStatsFromLog；【D6】默认账号硬编码照搬，但把 uid/name 提为常量并注释"疑点 D6"
- recordApiCall 聚合维度与失败计数口径照搬；saveStats 防抖间隔以源码为准
- pruneStatsByTime 的 mode 枚举与返回结构照搬
- 浮点计算顺序照搬；formatCurrency 小数位与符号一致
- searchOfficialPricingOnline 的检索端点（走网关自身 search 等价逻辑）、超时、返回结构照搬
- log-parser 的每条正则逐字抄进测试；正则依赖的日志文案见规格卡 §13

【Go 化要求】
- metrics.Store 持 RWMutex；落盘复用 config 的原子写（通过接口注入，避免 import config 内部细节）
- pricing → scheduler 依赖走接口（避免循环）
- 测试：固定时钟；stats golden；pricing 表驱动；log-parser 用录制的 gateway.log 片段

【输出】按 P0 铁律 5。
```

---

# P9 · 模块迁移：adapters/openai

```
【任务】迁移 src/adapters/openai.mjs 到 internal/adapters/openai.go，并完成 adapters/common.go（鉴权、选号、错误转换、Acquire 封装）。
先贴 P0 + 事实卡 + 规格卡 §8 + 架构 §3.7/§3.8 + P6/P7 的符号对照表。

【源码】
<粘贴 src/adapters/openai.mjs 全文>

【必须等价迁移的符号】
handleOpenAiModels, handleOpenAiChatCompletions, 以及内部 executeRequestChain（闭包 → 独立函数 ExecuteRequestChain）

【行为红线】
- /v1/models：regions 缺省 ['cn']；id 前缀；去重；黑名单隐藏；输出字段与默认值（owned_by 'tencent-codebuddy'、context_window 回退 200000、max_output_tokens 回退 8192、region_label）
- 入口：默认模型 deepseek-v4.1-flash；黑名单 403 文案逐字；日志 `收到 OpenAI 对话请求 [...] (来源: ..) (流式: ..)` meta 字段
- 上游 body 默认：temperature 1.0、max_tokens 128000、stream_options.include_usage、cache_retention 'long'、extra_vars 默认
- 执行链（规格卡 §8.3 逐分支）：candidateSteps 构造（modelFallback 键查找顺序、单字符串、去重 sig、黑名单剔除）；
  每次迭代 applySystemPromptPolicy【D7 照搬】→ ensureLeadingSystem → prepareUpstreamBody → headers → fetch → markFirstByte
- 非 2xx 分类顺序：11158 → isModelLimit(6003/6004/6007/6008/429/RateLimitError) → QUOTA(或 402) → 401 → ACCOUNT_RESTRICTED → 直通
- 冷却值：模型限流 600s、11158 3600s、额度耗尽 86400s
- sticky 删除条件：sessionKey 存在且 map 指向该账号
- failover 文案两套（pinned / 非 pinned）；REROUTE 文案含 (i/n)
- 429 兜底文案 'All upstream accounts and fallback models in the chain ([..]) are rate-limited or busy.'
- 网络异常：client-gone → 499 不重试；first-byte-timeout → 换号；其他 → 换号
- 流式：原样透传 chunk + touch；解析 data 行；收尾 empty/truncation 两套；finally 释放；统计与日志文案
- 非流式：tool_calls 按 index 拼接；finish_reason 覆盖为 tool_calls；响应结构与 usage 字段
- 【网关无 8 次计数器】重试边界 = attemptedUids × candidateSteps；不要引入计数上限

【Go 化要求】
- handler 依赖 struct 注入；SSEWriter 复用 P6；Acquire→defer release
- 错误返回用 upstream.AppError + FormatOpenAIError；JSON 键顺序用有序构造（map 会导致键排序，OpenAI 客户端不敏感，但 golden 测试需按字段比较而非字节）
- 测试：httptest 回放上游 SSE 固件（正常/空流/限流/断流/PTL/401/402/11140/11158）；断言下游字节序列与日志行

【输出】按 P0 铁律 5。
```

---

# P10 · 模块迁移：adapters/anthropic + tools

```
【任务】迁移 src/adapters/anthropic.mjs、tools.mjs 到 internal/adapters/，复用 P9 的 common.go。
先贴 P0 + 事实卡 + 规格卡 §9 + P9 符号对照表。

【源码】
<粘贴 src/adapters/anthropic.mjs 全文>
<粘贴 src/adapters/tools.mjs 全文>

【必须等价迁移的符号】
handleAnthropicMessages, handleSearch, handleWebFetch

【行为红线】
- claude/sonnet/opus 模型名 → deepseek-v4.1-flash（黑名单检查在改写之后）
- 请求转换（规格卡 §9.1）：system 双形态、blocks 四类型、tools input_schema、thinking budget 六档映射、布尔 thinking
- 执行链与 OpenAI 相同但：日志分类 ANTHROPIC、文案前缀 'Anthropic 协议: '、失败路径不 dispose【D9 照搬】、
  响应 {type:'error',error:{type:'api_error',message:<上游原始文本>}}【D8 照搬】
- 流式事件序列（规格卡 §9.3）：message_start（usage 全 0）→ thinking 块 idx0 → text 块 idx(1|0) → tool_use 块 idx=base+tc.index；
  只在可见事件后 touch；收尾 truncationEmitted 后直接 return；正常收尾 stop_reason tool_use|end_turn
- message_delta 的 usage 含 cache_read_input_tokens（非标准位置，Claude Code 依赖，照搬）
- 非流式 content blocks 顺序 thinking→text→tool_use；input 解析失败为 {}
- tools：cn 优先选号；503 文案；15000ms 超时【网关】；透传状态码与文本；SEARCH/FETCH 日志

【Go 化要求】
- 与 openai.go 共享 ExecuteRequestChain（抽成泛型/回调：日志分类、失败响应格式化、协议特定 payload 构造作为参数）
- 测试：用 Claude Code 实际请求体样本做 golden；事件顺序快照断言；thinking→text→tool 混合流；空流两种 kind

【输出】按 P0 铁律 5。
```

---

# P11 · 模块迁移：web/routes + server + main

```
【任务】迁移 src/web/routes.mjs、src/server.mjs、gateway.mjs 到 internal/web/ 与 internal/server/ 与 cmd/gateway/main.go。
建议拆两次：第一次 auth + 不依赖 Scheduler 的路由（1-18, 22-28, 37-40）；第二次 accounts/oauth/checkin/metrics/models（19-21, 23, 29-36）。
先贴 P0 + 事实卡 + 规格卡 §10/§11 + 架构 §4/§6/§9/§10/§13。

【源码】
<粘贴 src/web/routes.mjs 全文>
<粘贴 src/server.mjs 全文>

【必须等价迁移】
- Web 鉴权三函数与守卫（规格卡 §10.1）；login/status 两个公开路由
- 40 个路由（规格卡 §10.2 表）：方法、路径、query/body 字段、状态码、JSON 键名、错误文案、日志分类与文案
- POST /api/settings 的字段守卫与钳制（规格卡 §10.3）；【D10 照搬】但注释标注"回传明文，疑点 D10"
- 控制台渲染：@include 展开 + 5 个占位符 + 响应头（规格卡 §10.4）；//go:embed public
- server：路由分发顺序、50MB 限制与两套 413 文案、handleRequestFailure 两分支、CORS、/healthz、404 文案、启动横幅、启动修正
- main：信号 → 停机时序（架构 §9）；process.on 兜底 → recover 中间件 + anomalyCounter
- HTTP Server 参数按架构 §10

【Go 化要求】
- chi 或 net/http 1.22 Pattern 路由；一组 handlers_*.go；统一 decodeJSON（错误返回与源码一致）
- 前端字段名是契约，禁止 camel/snake 转换
- 每个路由至少 1 个 httptest；鉴权中间件单独测；settings 钳制每个边界一个用例
- 横幅输出到 stdout，不进 Logger（与 Node 一致）

【输出】按 P0 铁律 5。
```

---

# P12 · 代码评审（每个模块完成后立即执行）

```
【任务】评审下面刚写的 Go 代码。只输出问题清单与修正后的完整代码，不要夸奖。

【评审维度（按优先级）】
1. 与 Node 源码等价性：逐函数对照规格卡对应 §，列出任何分支/默认值/文案/状态码/JSON 键名不一致
2. CLI 依据：每个超时/次数/阈值是否带 `// CLI:` 或 `// 网关自有策略` 注释；缺的列出
3. goroutine 泄漏：每个 go 语句的退出路径；ctx 取消后是否残留；ticker.Stop
4. 资源泄漏：resp.Body.Close、rows.Close、文件句柄、timer.Stop
5. 并发竞争：共享 map/slice/count 是否在锁内；-race 能否过；sort.Slice 稳定性
6. panic 路径：handler recover；切片越界/类型断言是否带 ok
7. 锁误用：持锁做 IO/网络调用；锁粒度过大阻塞流式
8. JSON 保真：map vs struct 的键顺序/omitempty 差异是否影响前端或 golden
9. 错误处理：err 被吞、errors.Is 用错、fmt.Errorf 缺 %w
10. inFlight：是否全部经 Acquire/defer release；任何手写 inFlight-- 都是 P0

【Node 源码】
<粘贴对应 .mjs 全文>
【Go 代码】
<粘贴刚生成的 Go 代码>

【输出】
A. 问题清单：编号 | 严重度(P0/P1/P2) | 文件:行 | 问题 | 与源码差异
B. 修正后的完整代码（全量）
C. 仍需人工确认的事项
```

---

# P13 · 对比验证与测试脚本

```
【任务】为模块【<模块名>】生成新旧版本对比验证方案。

【要求】
1. 步骤：同一请求分别打 Node 版(:8317) 与 Go 版(:8318)，比对响应
2. curl 脚本（PowerShell 与 bash），覆盖该模块全部分支：
   正常 / 鉴权失败 / 黑名单 / 上游 400/401/402/403(11140)/429/5xx/11158 / 流式：首 token 超时、静默超时、只有 reasoning、空流、finish 后 usage 尾帧、[DONE] 跨 chunk / 客户端中途断开
3. 对比脚本（Python 或 Go）：录制两边响应（状态码、headers、SSE 事件序列归一化）并 diff，忽略 request id / 时间戳 / 随机 id
4. 日志比对点：规格卡 §13 中该模块应有的日志行格式
5. 回归检查项：异常计数、账号 inFlight 归零、stats.json 字段、logs.db 新增行、sticky map 大小
6. 命令：go test -race ./...；go test -run TestX -count=1（含 goleak.VerifyNone）
```

---

# P14 · 收尾：CHANGELOG + 构建 + 部署

```
【任务】为本次 Go 重构阶段【<阶段名>】生成：

1. CHANGELOG.md 条目（遵循项目 AGENTS.md 第 5 条）：
   ## [x.y.z] - <日期>
   ### 官方协议对齐 (Protocol Alignment) / 功能增强 (Features) / 缺陷修复 (Fixes)
   - 背景、改动清单（Go 文件与函数）、CLI 依据（变量名 + bundle 证据片段）、验证结果、行为差异清单（架构文档标注【决策】的项）
2. 依赖清单与理由（仅允许：modernc.org/sqlite、go-chi/chi(可选)、golang.org/x/sys、go.uber.org/goleak(测试)）
3. 构建命令：
   go build -o bin/gateway ./cmd/gateway
   CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o bin/gateway-linux-amd64 ./cmd/gateway
   CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o bin/gateway-linux-arm64 ./cmd/gateway
   CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o bin/gateway-windows-amd64.exe ./cmd/gateway
4. Dockerfile（多阶段，alpine + ca-certificates，VOLUME /data，GW_DATA_DIR=/data）与 docker-compose.yml
5. 与 Node 版并行灰度清单：1 个客户端 → 观察 gateway.log 24h（对照 §13 文案）→ 切流 → 保留 Node 版 1 周可回滚
6. 敏感文件提醒：accounts.json / config.json / backups/ / logs.db / gateway.log / stats.json / pricing.json 不入库
```

---

# 附录 A · 投喂顺序与依赖关系

```
P0 + 事实卡 + 架构 §3/§5/§7
 └─ P1 诊断（已完成）→ P2 架构（已完成）
     ├─ P3.0 logger+database(logs)+tlscerts（底座，最先）
     ├─ P3 config/storage/accountStore ──┐
     ├─ P4 headers/errors/cliconsts ─────┤
     │   └─ P5 payload/models            │
     │       └─ P6 stream-guard + SSEWriter
     ├─ P7 scheduler (依赖 P3, P3.0) ────┤
     ├─ P8 metrics/pricing/log-parser/db(credits) (依赖 P3, P7 接口)
     │         ┌─────────────────────────┘
     ├─ P9 openai + common (依赖 P4-P8)
     │   └─ P10 anthropic + tools (依赖 P9)
     └─ P11 web routes + server + main（依赖全部；可拆两次）
每个 P3.0~P11 之后：P12 评审 → P13 验证 → P14 收尾
```

# 附录 B · 常见翻车点（投喂前提醒 AI）

```
1. 把 300000 静默超时注释成 "CLI CODEBUDDY_STREAM_TIMEOUT_MS" —— 错，那是总时长 12e5；300000 是网关借用 mb=3e5
2. 把粘性 TTL 写成 1 小时或 5 分钟 —— 错，config 默认 7 天；3e5/18e5 是死分支
3. 把链路 ID 写成 4 个同值 —— 错，是两对：messageId 对 + conversationRequestId 对
4. 引入"最多重试 8 次" —— 错，网关无此计数器；边界是账号集合 × 降级链
5. 在 handler 里起 goroutine 不挂 ctx —— 泄漏
6. 把 stats.json / /api/accounts 字段改成 snake_case 或改名 —— 前端会炸
7. inFlight 释放放在 return 前 —— 提前 return/panic 时漏；必须 defer release()
8. 用 sort.Slice —— 平局与 Node 不一致；必须 SliceStable
9. 把 extractStructuredBizCode 简化成只看 data.error.code —— 丢失 6 层下钻
10. SSE 写出并发化 —— 必须 SSEWriter 串行
11. Anthropic 路径每个 chunk 都 touch 心跳 —— 错，只在可见事件后 touch（否则 ping 永不发出）
12. 忘记 Windows 下 rename 覆盖语义 —— 实测并注释
13. 用 slog 默认 JSON 行 —— 必须精确复刻 Node 文本格式
14. 用 map 序列化日志 meta —— 键顺序会变；用有序 kv
15. 把 python-requests 黑名单当"经验" —— 它是网关风控规则常量，必须保留
```

# 附录 C · 单会话上下文管理

```
每开一个新会话做某个模块时，按此顺序贴：
1. P0 全局铁律（全文）
2. 项目事实卡（全文）
3. 架构文档 §3（接口）+ §5（状态映射）+ §7（CLI 常量表）
4. 该模块的规格卡 §N（全文）
5. 当前模块的 P{n} 提示词 + 该模块 .mjs 全文
6. 上一模块的「符号对照表」（只要表）
超过 40KB（scheduler / anthropic / routes）：第一次只输出"符号清单 + 分支摘要 + 日志分类"，确认后再输出代码
```

# 附录 D · CLI 核查命令（PowerShell，在项目根目录执行）

```powershell
$c = [IO.File]::ReadAllText('package\dist\codebuddy-headless.js')
# 1) 列出所有相关 env / header / 标识符是否存在
$pats = 'CODEBUDDY_[A-Z_]*(TIMEOUT|KEEPALIVE|RETR)[A-Z_]*','X-Conversation-[A-Za-z-]+','X-Root-Request-ID','X-Request-ID',
        'X-Trace-ID','X-Agent-[A-Za-z-]+','X-IDE-[A-Za-z]+','X-Private-Data','X-Stainless-[A-Za-z-]+','X-B3-[A-Za-z]+',
        'traceparent','baggage','X-Domain','hasSubstantiveContent','emptyStreamKind','reasoning-only','no-token','LOGIN_TOKEN_PENDING_CODE'
foreach ($p in $pats) { "[$p] => " + (([regex]::Matches($c,$p) | % Value | Sort-Object -Unique) -join ', ') }
# 2) 看某个符号的默认值上下文（±120 字符）
foreach ($p in 'CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS','CODEBUDDY_STREAM_TIMEOUT_MS','CODEBUDDY_REASONING_KEEPALIVE_INTERVAL_MS',
               'CODEBUDDY_STREAM_KEEPALIVE_INTERVAL_MS','CODEBUDDY_EMPTY_STREAM_RETRY_MAX_ELAPSED_MS','CODEBUDDY_MAX_RETRIES',
               'function resolveRequestMaxRetries','my=12e5','tf=5e3') {
  $ms = [regex]::Matches($c,[regex]::Escape($p)); $n=0
  foreach ($m in $ms) { if ($n -ge 2) { break }; $s=[Math]::Max(0,$m.Index-120); $len=[Math]::Min(300,$c.Length-$s)
    "[$p] #$n => " + (($c.Substring($s,$len)) -replace "[\r\n]+",' '); $n++ }
}
```

> 2026-11-29 核查结果（已写入架构 §7）：`mm=12e5,my=12e5`；`mC=8,mv=15,mb=3e5`；`AK=3e5`；`tf=5e3`；REASONING/STREAM KEEPALIVE 默认 0；全部请求头名与 `hasSubstantiveContent`/`emptyStreamKind`/`reasoning-only`/`no-token` 存在。
