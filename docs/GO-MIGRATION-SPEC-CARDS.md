# Go 迁移行为规格卡（Spec Cards）

> 用途：每个模块提示词（P3.0~P11）引用对应章节，AI 必须逐条核对后再写代码。
> 行号以 2026-11-29 工作区源码为准；标注【CLI】= 有 CLI 产物依据；【网关】= 网关自有策略；【D?】= 对应 §12 疑点。
> 本卡只记录"已核实"的事实；写"以源码为准"的条目表示本卡未展开，迁移时必须读源码对应行。

---

## §1 config.mjs

### 1.1 常量与路径
| 符号 | 值/语义 | 锚点 |
|---|---|---|
| `CURRENT_VERSION` | `2.5.0` | 顶部 |
| `CLI_VERSION` / `CLI_USER_AGENT` | `2.179.0` / `CodeBuddy/2.179.0 (...) CLI/2.179.0 ...`（完整串以源码为准） | 220-221 |
| `USER_AGENT` | 官方 IDE 风格 UA，以源码为准 | 222 |
| `ROOT_DIR` | 模块文件目录的上级 = 项目根 | 226 |
| `CONFIG_PATH` / `ACCOUNTS_PATH` / `BACKUP_DIR` / `LOG_FILE_PATH` / `LOG_DB_PATH` / `STATS_PATH` / `PRICING_FILE_PATH` | ROOT_DIR 下同名文件 | 以源码为准 |
| `REGION_CN='cn'` / `REGION_INTL='intl'` | | |
| `REGION_BASE` | 每区：label、web 主机（cn `www.codebuddy.cn` / intl `www.codebuddy.ai`）、api 主机（cn `copilot.tencent.com` / intl 以源码为准）、`endpointsFor()` 各端点（upstream / authState / authToken(state) / login(state) / accounts / loginAccount(state) / search / webfetch / credits / checkin / usage …） | 以源码为准 |
| `STICKY_DEFAULT_TTL_MS` | `7*24*60*60*1000`（7 天） | 408 |
| `MODEL_BLACKLIST_KEY` | config.json 中的键名 | 以源码为准 |
| `VALID_THINKING_LEVELS` | off, minimal, low, medium, high, xhigh, max | 以源码为准 |
| `VALID_OVERRIDE_MODES` | client_first / gateway_level_only / gateway_override_all | 以源码为准 |
| `VALID_PROMPT_MODES` | passthrough / custom / append | 以源码为准 |

### 1.2 模块加载副作用（import 时执行，Go 版放到 `store.Open`）
1. `ensureBackupDir()` → `migrateLegacyBackups()`（把 ROOT_DIR 下旧 `.bak` 迁入 backups/）。
2. `loadJsonWithBackup(CONFIG_PATH, DEFAULT_CONFIG)` → 合并默认值 → `config.stickySessionTtlMs/MaxLifetimeMs` 缺省 7 天（413-425）。
3. `loadJsonWithBackup(ACCOUNTS_PATH, [])` → 逐个 `normalizeAccount` → 过滤无效。
4. `ensureApiKey()`：无 apiKey 则生成并落盘。

### 1.3 账号归一化 `normalizeAccount(raw)`
- 必须有 `accessToken` 或 `refreshToken` 之一，否则返回 null。
- `uid`：优先 `uid`，否则尝试从 JWT payload 解出（`JSON.parse(base64url(token.split('.')[1]))`，失败则 `uid_<ts>`）；统一 `String()`。
- `region`：`resolveAccountRegion` 顺序以源码为准（显式 region → domain → product/realm → 默认 cn）。
- 默认字段：`status:'healthy'`、`inFlight:0`、`creditsRemain` 保留、`modelCooldowns:{}`、`note` 默认"默认账号"、`email` 默认 unnamed-account。
- `expiresAt` 缺省时按 token 有效期或现在+2h（以源码为准）。

### 1.4 容错解析 `robustParseJson(text)`
分支（全部要有测试）：BOM 去除 → 去尾逗号 → 单引号转双引号（保守）→ 去注释（`//` 与 `/* */`，需跳过字符串内）→ 补全未闭合的 `"`/`}`/`]` → 最后 `JSON.parse`。
【决策】Go 版先实现同样的预处理管线（手写扫描器），再 `json.Unmarshal`；禁止用第三方容错库替代。

### 1.5 原子写 `writeJsonWithBackup(path, obj)` 与三级恢复 `loadJsonWithBackup`
- 写：tmp 文件 → `fsync` → `rename` 覆盖主文件 → 同步拷贝到 `backups/<name>.bak`（保留策略以源码为准）。
- 读：主文件解析成功 → 返回；失败 → `backups/<name>.bak` → 成功则**回写主文件**并 warn；再失败 → ROOT_DIR 下 `<name>.json.bak`（legacy）；全失败 → 返回默认值。
- 日志分类 `CONFIG`，文案以源码为准。

### 1.6 API Key
| 函数 | 语义 |
|---|---|
| `generateRandomApiKey()` | `sk-` + 48 位 base62（长度/字符集以源码为准） |
| `getApiKeys()` | 返回 `config.apiKeys`（若空则以 `config.apiKey` 构造一条 `id:'key_<ts>', note:'默认主密钥'`） |
| `isValidApiKey(token)` | 常量时间比对 `config.apiKey`，再遍历 `enabled!==false` 的 apiKeys |
| `safeCompareTokens(a,b)` | `crypto.timingSafeEqual` 等价，长度不同直接 false |
| `addApiKey({key,note})` / `updateApiKey(id,{note,enabled,key})` / `removeApiKey(id)` | 以源码为准；变更后 `saveConfig()` |

### 1.7 模型黑名单
`getModelBlacklist()` / `setModelBlacklist(list)`（去重、trim、小写、落盘）/ `isModelBlacklisted(fullId, bareId, region)` / `isStepUnavailableByBlacklist(bare, region)`。
匹配规则（以源码为准，需逐条测试）：精确匹配带前缀 ID；精确匹配裸名；`*` 通配（如 `claude-*`）；区域级规则（如 `cn:*`）。

### 1.8 策略
- 思考策略 `getThinkingPolicy()/setThinkingPolicy()/setModelThinkingLevel(modelId, level)`：`defaultLevel` + `overrideMode` + 每模型 `modelLevels`；以源码为准。
- Prompt 策略 `getPromptPolicy()/setPromptPolicy({mode,file})`：`loadSystemPromptContent()` 读 `prompt.md`（路径以源码为准），读不到回退空串并 warn。
- 日志策略 `getLoggingPolicy()/setLoggingPolicy()`：`requestClientInfo`（默认 true）、`requestArchiveContext`（默认 false）。
- 私有数据策略 `getPrivateDataPolicy()/setPrivateDataPolicy()`：供 `X-Private-Data` 头使用（见 §5.1）。

### 1.9 工具函数
`getTodayString()`（本地日期）、`getLocalTimeString()`、`formatUptime(ms)`（中文"X天X小时X分钟X秒"格式以源码为准）、`formatAccountLogName(a)`（`[note|email]` 以源码为准）、`formatAccountFullDesc(a)`、`normalizeRegion()`、`resolveAccountRegion()`、`baseForAccount()`、`endpointsFor(acc)`。

---

## §2 core/logger.mjs · core/database.mjs · core/tls-certs.mjs

### 2.1 Logger
- 行格式：`[YYYY-MM-DD HH:mm:ss] [LEVEL ] [CATEGORY] message` + (meta ? ` | ` + JSON.stringify(meta) : '') + `\n`；`LEVEL` 为大写 padEnd(5)。
- 输出：info/warn → stdout；error → stderr；同时 append 到 `gateway.log`、同步插入 SQLite、写入环形缓冲（头部插入，上限 1000）。
- `getLogs({date, level, category, search, limit=200, offset=0})`：优先 DB；DB 不可用或无结果时用环形缓冲兜底（过滤与分页逻辑以源码为准）；返回结构以源码为准（含 `logs`、`total`、`useSqlite` 等）。
- `getDates()`、`clear()`（只清环形缓冲，返回条数）、`pruneLogsByTime({mode,keepDays})`、`pruneOldLogs(3)`、`checkAndPruneBySize` 在 database。
- 【D4】时间本地、裁剪 cutoff UTC，照搬。

### 2.2 LogDatabaseEngine
- 打开：`PRAGMA journal_mode=WAL; synchronous=NORMAL`；建表 `logs`（字段以 DDL 为准：id, time, date, level, category, message, meta…）与 `credit_history`。
- `migrateFromGatewayLogIfEmpty()`：空库时按 `gateway.log` 正则解析迁移（正则以源码为准，依赖 §2.1 行格式）。
- `insertLog` 同步；`queryLogs` 支持 date/level/category/search LIKE/limit/offset；`getDates()` 为 `SELECT DISTINCT date`；`pruneLogsByTime`/`pruneOldLogs` 按天删除；`checkAndPruneBySize(maxMb)` 先删最旧天直至低于阈值（策略以源码为准），必要时 `VACUUM`。
- `credit_history`：`insertCreditHistory`、`queryCreditHistory({accountUid,range,date,limit,offset})`、`clearCreditHistory`。
- 【D5】打开失败静默降级 `useSqlite=false`；【决策】Go 版额外 `Logger.Error` 一次。

### 2.3 TlsCertificateStack
- 来源顺序：Node 内置根证书（Go 无 → 【决策】embed Mozilla bundle 或依赖系统 `ca-certificates`）→ 本地 pem bundle（路径以源码为准）→ OS 自提取（Windows `powershell Get-ChildItem Cert:\LocalMachine\Root,CurrentUser\Root` 导出 PEM；macOS `security find-certificate -a -p /Library/Keychains/System.keychain`；Linux 读 `/etc/ssl/certs/ca-certificates.crt` 等；超时 4000ms）→ 环境变量附加证书（变量名以源码为准）。
- `loadedCount` = 去重后数量；`init()` 幂等；`NODE_TLS_REJECT_UNAUTHORIZED=0` → warn + `InsecureSkipVerify`。
- Go 版对外：`Stack.Pool() *x509.CertPool`、`Stack.LoadedCount() int`。

---

## §3 core/scheduler.mjs

### 3.1 常量
| 符号 | 值 | 依据 |
|---|---|---|
| `CLI_COMPLETED_TASK_TTL_MS` | 3e5 | 【CLI】仅为 config 未设置时兜底（实际死分支） |
| `CLI_CLEANUP_INTERVAL_MS` | 6e4 | 【CLI】实际生效：清理定时器 |
| `CLI_PROMPT_TIMEOUT_MS` | 18e5 | 【CLI】兜底 maxLifetime（死分支） |
| `GATEWAY_IDLE_THRESHOLD_MS` | 15*60*1000 | 【网关】 |
| 清理定时器 | `setInterval(cleanExpiredSessions, 60_000).unref()` | 172 |

### 3.2 `extractSessionKey(req, payload)` 优先级（67-145）
1. Header（小写键名顺序）：`x-session-id`、`x-conversation-id`、`session-id`、`conversation-id`、`x-chat-id`、`anthropic-conversation-id`。
2. Payload：`user` → `session_id` → `conversation_id` → `chat_id` → `metadata.user_id` → `metadata.session_id` → `metadata.conversation_id`（均需非空字符串，trim）。
3. 指纹：`sys = payload.system`（string 或 blocks[].text 拼接）；遍历 `messages` 取首个 `role:system`（若 sys 为空）与首个 `role:user`；seed = `'sys:'+sys.slice(0,500)+'|'` + `'user:'+firstUser.slice(0,500)`；**MD5 hex**。数组 content 用 `JSON.stringify`。
4. 兜底 `crypto.randomUUID()`（【D2】仍会写入 sticky map）。

### 3.3 `cleanExpiredSessions()`（150-169）
`idleTtl = config.stickySessionTtlMs>0 ? : 3e5`；`maxLifetime = config.stickySessionMaxLifetimeMs>0 ? : 18e5`；`now-lastActive>idleTtl || (createdAt && now-createdAt>maxLifetime)` → 删除。返回删除数。

### 3.4 `selectAccount(requestedModel, sessionKey, options)`（221-378）
```
maxLimit = concurrencyLimitEnabled!==false ? (maxInFlightPerAccount||3) : 9999
strategy = options.strategy || config.routingStrategy || 'least-inflight'
forcedRegion = options.region ? normalizeRegion : null
globalScope = routingRegionScope!=='all' ? normalizeRegion : null
effectiveRegion = forcedRegion || globalScope
regionAllowed(a) = !effectiveRegion || resolveAccountRegion(a)===effectiveRegion

1. pinnedAccount：uid/uin/email 精确（小写）、note 包含（小写 includes）
   受限判定顺序：区域不符 → 本轮已尝试 → status!=='healthy' → 全局冷却 → 模型冷却 → 并发≥maxLimit
   受限 → warn DISPATCH 并回落池；可用 → info DISPATCH「精准路由至网关全局指定账号」返回
   未匹配 → warn「未找到全局指定账号」
2. 粘性：stickyEnabled!==false && sessionKey && map.has
   过期 → 删除；excludeUids 含该 uid → 跳过（不删）
   账号存在 && regionAllowed && healthy && 无全局冷却 && inFlight<maxLimit：
       无模型冷却 → lastActive=now，info DISPATCH「粘性会话复用账号」返回 【D1 remainingSec 恒满】
       有模型冷却 → 落到池（不删 sticky）
   否则 → 删除 sticky，info「已自动解绑并平滑回落」
3. 候选过滤（顺序即源码顺序，含副作用）：
   status!=='healthy' → 出
   cooldownUntil && now>=cooldownUntil → 置 0（副作用）；仍冷却 → 出
   excludeUids 含 → 出
   !regionAllowed → 出
   modelCooldowns[model] 过期 → delete（副作用）；仍冷却 → 出
   concurrencyLimitEnabled && inFlight>=maxLimit → 出
4. 选号：
   round-robin：rrIndex = rrIndex % len；chosen = candidates[rrIndex]；rrIndex=(rrIndex+1)%len
   credits：按 creditsRemain 降序（稳定排序）取首
   least-inflight（默认）：inFlight 升序，平局 creditsRemain 降序（稳定排序）取首
5. sessionKey && stickyEnabled → map.set(key,{uid,createdAt:now,lastActive:now})
6. info DISPATCH「调度选中账号」(策略/并发/剩余积分)；更新 lastDispatchedUid/Time
```
【决策】Go 用 `sort.SliceStable`；候选切片顺序 = accounts.json 顺序（`AccountStore.List()`）。

### 3.5 其余方法（签名与日志分类以源码为准）
`getCurrentActiveAccountInfo`、`recordApiUsage(acc)`（lastApiCallTimestamp=now + postCall 防抖 timer）、`isGatewayIdle()`、`refreshActiveAccountsIfStale()`、`refreshStaleCredits(minIntervalMs,{force})`、`refreshCredits(acc)`（上游积分端点 → `creditsRemain/creditsUpdatedAt` → 变化写 `credit_history`）、`refreshSessionToken(acc)`（提前 N 天，`tokenRefreshAdvanceDays` 默认 7，范围 [1,30]）、`dailyCheckin(acc,force)`（国内/国际不同端点与文案；`lastCheckinDate/Success/Msg`）、`checkAndRunHourlyCheckin(interactive)`、`getAccountCreditDetails(acc)`（plans-usage 明细）、`getAccountUsageRecords(acc,{days,pageNum,pageSize})`（`POST /billing/meter/get-user-request-usage`）、`cooldown(uid,sec,reason)`、`cooldownModel(uid,model,sec,reason)`、`clearSessionStickyMap()`、`getSessionAffinityStats()`。
后台刷新中的 sleep（`1200ms` 固定、随机 jitter）需 ctx 可取消。

---

## §4 core/metrics.mjs · core/pricing.mjs · core/log-parser.mjs

### 4.1 metrics
- `stats.json` 结构：`{ createdAt, lastUpdated, accounts: { "<uid|email>": { "<YYYY-MM-DD>": { requests, inputTokens, outputTokens, cachedTokens, totalTokens, ... } } }, ... }`（**字段以源码为准**，前端直接消费）。
- `loadStats()`：读 stats.json → 不存在则 `rebuildRealStatsFromLog()` 建初值 → 合并 `currentAcc`（【D6】log-parser 硬编码账号）。
- `recordApiCall({accountUid, accountName, model, isSuccess, inputTokens, outputTokens, cachedTokens})`：按账号+日期聚合，失败计 `requests` 不计 token（以源码为准），随后 `saveStats()`（防抖写盘，间隔以源码为准）。
- `pruneStatsByTime({mode,keepDays})`：`keep_today` / `keep_days` / `clear_all`（枚举以源码为准）。
- `getAccountStatsByRange(range)`、`getMetricsReport(range)`（today|yesterday|7d|30d|all）、`formatTokenNumber`、`getShiftedDateString`。
- **日志依赖**：`rebuildRealStatsFromLog` 解析 `gateway.log` 中的中文短语（见 §13）。

### 4.2 pricing
- `pricing.json`：`{ "<model>": { input, output, currency, updatedAt, ... } }`（以源码为准）。
- `loadModelPrices()` 合并 `DEFAULT_OFFICIAL_PRICES`；`saveModelPrices(prices)` 落盘；`calculateModelUsageCost(model, in, out)`（每 1M token 单价，浮点顺序照搬）；`formatCurrency`。
- `searchOfficialPricingOnline(q)`：通过网关自身 `/v1/search` 等价逻辑联网检索并整理报告（返回结构以源码为准）。

### 4.3 log-parser
- `rebuildRealStatsFromLog()`：逐行匹配 §2.1 格式，按 `收到 OpenAI 对话请求` / `调度选中账号 [..]` / `流式输出完成 [..]` / `非流式回复完成` / `收到 Claude Code 协议请求` / `流式回复完成` / `非流式完成` 等短语重建；token 估算规则以源码为准。
- 【D6】默认账号硬编码 `uid:'18948117020', name:'小宝'`（log-parser.mjs:21）—— Go 版照搬但列入疑点，建议 Node 版修后再同步。

---

## §5 upstream/headers.mjs · upstream/errors.mjs

### 5.1 请求头（buildOfficialUpstreamHeaders，共 38 个，顺序与取值以源码为准）
| 组 | 头 | 取值 |
|---|---|---|
| 鉴权 | `Authorization` | `Bearer <accessToken>` |
| 内容 | `Content-Type` / `Content-Encoding`(gzip 时) / `Content-Length` | `application/json` |
| 会话 | `X-Conversation-ID` | UUIDv7（36 字符） |
| 链路 A | `X-Request-ID` = `X-Conversation-Message-ID` | `messageId`（32 位 hex，UUIDv7 去连字符） |
| 链路 B | `X-Conversation-Request-ID` = `X-Root-Request-ID` | `conversationRequestId`（独立 32 位 hex） |
| 链路 C | `X-Trace-ID` | 独立 32 位 hex |
| W3C | `traceparent` / `baggage` | `00-<traceId 32hex>-<spanId 16hex>-01` / `<key>=<value>,...`（以源码为准） |
| B3 | `X-B3-TraceId` / `X-B3-SpanId` / `X-B3-ParentSpanId` / `X-B3-Sampled` | 与 W3C 共享 id（以源码为准） |
| 客户端身份 | `User-Agent` | 官方 IDE 风格（含 `CLI/2.179.0 CodeBuddy/2.179.0`）；若下游 UA 含 `python-requests`（不区分大小写）→ 回退官方 UA（【网关】风控规则） |
| 运行环境伪装 | `X-Agent-Intent` / `X-Agent-Runtime` / `X-IDE-Type` / `X-IDE-Version` | 常量（以源码为准） |
| Stainless | `X-Stainless-Lang` / `-Package-Version` / `-OS` / `-Arch` / `-Runtime` / `-Runtime-Version` / `-Retry-Count` / `-Timeout` / `-Helper-Method` 等 | `os=Windows`、`arch=x64` 固定；`runtime-version` 取 `process.version`（【决策】Go 版固定为与 Node 22 等价的字符串常量，如 `v22.x`，在 CHANGELOG 声明） |
| 业务 | `X-Domain` | `acc.domain` 优先，否则区域 web 主机 |
| 隐私 | `X-Private-Data` | 由 `resolvePrivateDataHeader(policy, acc)` 决定取值/省略 |
| 其他 | `Accept` / `Accept-Encoding` / `X-Title` / `X-Version` / `X-Codemanager-*` 等 | 以源码为准 |

CLI 核查（2026-11-29）：`X-Conversation-ID`、`X-Conversation-Message-ID`、`X-Conversation-Request-ID`、`X-Root-Request-ID`、`X-Request-ID`、`X-Trace-ID`、`X-Agent-Intent/Runtime`、`X-IDE-Type/Version`、`X-Private-Data`、`X-Stainless-*`、`X-B3-*`、`traceparent`、`baggage`、`X-Domain` 均存在于 `codebuddy-headless.js`。
> 勘误：旧文档"4 组同值链路 ID"错误；正确为 **两对**（A/B）+ 独立 Trace。

### 5.2 UUIDv7（uuidv7 / uuidv7Hex）
48 位毫秒大端时间戳 ‖ ver=7 ‖ 12 位 rand ‖ var=10 ‖ 62 位 rand；`uuidv7()` 36 字符小写带连字符；`uuidv7Hex()` 32 字符。
【决策】Go 用 `crypto/rand` 自实现（避免第三方库）；测试断言：前 12 hex = 时间戳、版本位、变体位。

### 5.3 errors.mjs
- `ServerErrorCode` 枚举：`RateLimitError=429`、`CraftRateLimit`、`ModelNotAllowed=11158`、`AccountRestricted=11140`、`InputLengthExceeded=11115`…（以源码为准）。
- 集合：`MODEL_FALLBACK_CODES`（6003 TPH、6004 TPD、6007 RPH、6008 RPD…）、`QUOTA_EXHAUSTED_CODES`、`ACCOUNT_RESTRICTED_CODES`（11140…）、`TRANSIENT_RATE_LIMIT_CODES`、`PTL_SUBSTRINGS`（`prompt is too long` 等，大小写不敏感）。
- `extractStructuredBizCode(err, depth=6)`：递归查找 `code` / `bizCode` / `error.code` / `data.code` / `response.data.code` …（6 层），number 与 string 均可；返回原始类型。
- `formatOpenAIError(status, errText)`：按状态码/业务码映射为 `{"error":{message,type,code}}`（映射表以源码为准，需逐条 golden test）。

---

## §6 upstream/payload.mjs · upstream/models.mjs

### 6.1 payload
- `REGION_PREFIX = {cn:'cn:', intl:'intl:'}`；`parseModelRegion(id)` → `{region, bare}`（非法/未知前缀视为裸名）。
- `sanitizeChannelFingerprints(text)`：剥离 `x-anthropic-billing-header:cc_version=...` 等 CLI 注入指纹（规则以源码为准）。
- `formatMessagesForUpstream(msgs)`：system/user content 清洗 + 工具消息透传（以源码为准）。
- `ensureLeadingSystemMessage(msgs, region)`：intl 且首条非 system → 插入 `{role:'system',content:DEFAULT_INTL_SYSTEM}`；幂等。
- `applySystemPromptPolicy(msgs)`：`passthrough` 原样；`custom` 剔除所有前导 system 后插入网关提示词；`append` 在首个 system 块之后插入（【D7】重试循环中重复调用会累积）。
- `THINKING_LEVELS` 与 `EFFORT_RANK`（off<minimal<low<medium<high<xhigh<max）；`clampThinkingLevel`；`getUpstreamDefaultEffort(modelMeta)`。
- `applyReasoningParams(body, clientPayload, modelMeta)`：客户端 `reasoning_effort` 显式值优先；否则按策略 `overrideMode` 与模型 `modelLevels`；只输出平铺 `reasoning_effort` / `reasoning_summary` / `verbosity`；`thinking:{}`、`reasoning:{}` 一律不出现在上行 body。
- `applyModelCapabilityGuards(body, modelMeta)`：按 `capabilities` 剔除不支持字段（以源码为准）。
- `prepareUpstreamBody(obj)`：`JSON.stringify` → 超过阈值（以源码为准）则 gzip → `{body, isGzip}`。
- `extractArchiveContext(payload)`：取首条 user 文本前 N 字符（以源码为准）供日志归档。
- `DEFAULT_MAX_TOKENS = 128000`（150）。

### 6.2 models
- `fetchDetailedModels(force)`：双区 `GET /v3/config`（5s 超时）→ 解析 `models` 数组 → `attachProbeStatus`；缓存 5 分钟【网关】（CLI 对照 48e4=8 分钟）；失败时用 `product.json` 快照兜底并 `warnLegacyProductSnapshot`；并发去重。
- `fetchUpstreamModelBusyLevels()`：仅国内版；`X-Domain: copilot.tencent.com`；每批 50 个模型；4s 超时；缓存 60s【网关】；输出 `Map<model, level>`。
- `resolveModelPromotion`：官方 promoted 别名解析（以源码为准）。
- 输出字段：`id, vendor, regions, contextWindow{defaultLength,...}, maxInputTokens, maxOutputTokens, capabilities, busyLevel, probeStatus, promoted…`（以源码为准；`/v1/models` 与控制台看板依赖）。

---

## §7 upstream/stream-guard.mjs

### 7.1 生命周期 `createUpstreamLifecycle(req, res, label)`
- `AbortController`；`firstByteTimer`【CLI 12e5】（`.unref()`）；`req.on('close')` → 若上游未结束 → `state.reason='client-gone'` + abort。
- `markFirstByte()` 清首字节计时；`markUpstreamEnded()`（收到 `[DONE]` 或 `finish_reason` 后，此后断开不算 client-gone）；`markFinished()`、`dispose()`。
- `state.flags`：`sawFirstByte`、`upstreamEnded`、`finished`、`reason`。

### 7.2 读取 `readUpstreamStream(reader, lifecycle, {label, onChunk})`
- 每读到一个 chunk：重置静默计时器【网关 300000】→ `onChunk(str)`。
- `[DONE]` 检测：用 12 字符尾巴缓冲拼接跨 chunk 的 `data: [DONE]`；命中 → `sawDone=true`，`stopOnDone` 时 `reader.cancel()`。
- 终止行正则 `TERMINAL_RE`（以源码为准）。
- 返回 `{abortedByClient, sawDone, error?, idleTimedOut?}`。
- 静默超时 → abort(reason='idle-timeout')；首字节超时 → abort(reason='first-byte-timeout')；客户端断开 → abort(reason='client-gone')。

### 7.3 心跳 `startHeartbeat(res, label, {protocol, getMeta})`
- `setInterval(5000)`【网关】；每 tick：`now - lastWrite >= interval` → 发帧并 `pingCount++`；`touch()` 置 `lastWrite=now`。
- OpenAI 帧：`data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n`；Anthropic 帧：`event: ping\ndata: {"type":"ping"}\n\n`（以源码为准）。
- `stop()` 返回 `pingCount`。
- 【契约】Anthropic 路径只在写出可见事件后 `touch()`（`anthropic.mjs:606-608`）；OpenAI 路径每个 chunk 都 `touch()`（`openai.mjs:458`）。

### 7.4 分类器 `createDeltaClassifier()`
```
observeDelta(delta, finishReason):
  reasoning_content || reasoning        → hasReasoning=true, hasContent=true
  content (非空)                        → hasContent=true
  tool_calls (非空数组)                 → hasTools=true, hasContent=true
  refusal                               → hasRefusal=true, hasContent=true
  finish_reason                         → finishReason=值
observeUsage(u): 记录 usage
hasSubstantiveContent = hasContentText || hasTools || hasRefusal
emptyStreamKind = hasSubstantiveContent ? null : (hasReasoning ? 'reasoning-only' : 'no-token')
```
（【CLI】`hasSubstantiveContent` / `emptyStreamKind` / `'reasoning-only'` / `'no-token'` 均在 CLI 产物中核实存在）

### 7.5 终态
- `isTruncatedWithoutFinish({sawDone, sawFinish, sawError})` → `!sawDone && !sawFinish && !sawError`（以源码为准）。
- `buildTruncationChunk(id, model)` → `finish_reason:"length"`；`buildEmptyStreamChunk(id, model, kind)` → `finish_reason:"error"`（message 文案以源码为准）。
- `logStreamOutcome(label, result, meta)`：按 result 分支输出 info/warn/error（文案以源码为准；log-parser 依赖）。

---

## §8 adapters/openai.mjs

### 8.1 `GET /v1/models`
遍历 `fetchDetailedModels()`；`regions` 缺省 `['cn']`；`id = REGION_PREFIX[r] + m.id`；去重；黑名单完全隐藏；输出 `{object:'list', total, data:[{id, object:'model', created:now, owned_by: vendor||'tencent-codebuddy', context_window, max_output_tokens, model, region, region_label('国际版'|'国内版')}]}`。

### 8.2 `POST /v1/chat/completions` 入口
- 默认模型 `deepseek-v4.1-flash`；`parseModelRegion` 锁区；黑名单 → 403 `permission_error / model_blacklisted`，文案 `Model "<id>" is disabled by the gateway administrator (blacklisted).`
- 日志：`CHAT` `收到 OpenAI 对话请求 [<model>] (来源: <ip>) (流式: <bool>)` meta `{toolsCount, messagesCount, clientIp?, userAgent?, context?}`（**log-parser 契约**）。
- 上游 body：`{model, messages, stream:true, temperature: payload.temperature ?? 1.0, max_tokens: ?? 128000, stream_options:{include_usage:true}, cache_retention: payload.cache_retention ?? 'long', extra_vars: payload.extra_vars ?? {initiator:'user', interactionType:'prompt'}, tools?, tool_choice?}` → `applyModelCapabilityGuards` → `applyReasoningParams`。

### 8.3 执行链 `executeRequestChain`（重试边界 = 账号集合 × 降级链；**网关无 8 次计数器**）
```
candidateSteps = [{model, region: forcedRegion}] + config.modelFallback[`${region}:${model}`] || [model]（数组或单字符串；去重 sig=`${region}:${bare}`；黑名单剔除）
while modelIndex < steps:
  while true:
    acc = selectAccount(curModel, sessionKey, {excludeUids: attempted, region: curRegion})
    if !acc: 有下一步 → warn REROUTE「账号池所有账号对模型 [x] 均已限流，自动降级切换至下一个备用模型 [y] (i/n)」→ modelIndex++ 跳出内层
            否则 → 返回 429 {error:{message:'All upstream accounts and fallback models in the chain ([a -> b]) are rate-limited or busy.', type:'rate_limit_error', code:'rate_limit_exceeded'}}
    acc.inFlight++; attempted.add(uid)
    每次迭代：messages = applySystemPromptPolicy(messages)【D7】→ ensureLeadingSystemMessage(messages, acc.region) → prepareUpstreamBody → buildOfficialUpstreamHeaders → fetch(ep.upstream, signal=lifecycle) → markFirstByte
    非 2xx：inFlight--；errText=body；bizCode=extractStructuredBizCode(parsed)||parsed.code
      error UPSTREAM「上游报错 HTTP <status> (账号: [..], 模型: [..], 业务码: <code|无>)」
      11158 → cooldownModel(uid, model, 3600)；返回 403 {permission_error, model_not_allowed, message:'Model "<m>" is not available for this account's plan (upstream code 11158: <msg>).'}
      isModelLimit = MODEL_FALLBACK_CODES.has(code) || status===429 || code===RateLimitError：
         cooldownModel(uid, model, 600)；若 sticky 指向该账号 → delete
         accountFailoverEnabled!==false 且 otherAcc 存在 → warn FAILOVER（pinned 与否两套文案）→ continue
         有下一步 → warn REROUTE → modelIndex++ 跳出
      QUOTA_EXHAUSTED || 402 → cooldown(uid, 86400)；sticky delete；pinned 时 warn FAILOVER；continue
      401 → status='unauthorized'；error AUTH「Token 已失效或被收回 (HTTP 401)」；pinned 时 warn；saveAccounts；continue
      ACCOUNT_RESTRICTED（或 403 且命中集合）→ status='restricted', restrictedAt, restrictedReason=displayMsg.zh||msg||'账号存在异常行为，已被限制使用 (11140)'；error AUTH；saveAccounts；sticky delete；failover 同上
      其余 → 返回 {status, errText, bizCode}
    2xx → 返回 {res, model, acc}
    catch 网络异常：inFlight--；
      reason==='client-gone' → info STREAM「[openai] 客户端已断开，停止重试」→ 499 CLIENT_GONE
      reason==='first-byte-timeout' → warn NETWORK「首字节超时，切换下一个账号」→ continue
      其他 → error NETWORK「请求账号 [..] 网络异常: ..」→ continue
```
失败收尾：`recordApiCall({model, isSuccess:false})`；`markFinished; dispose`；`res.writeHead(status)` + `JSON.stringify(formatOpenAIError(status, errText))`。

### 8.4 流式分支
- 响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no`。
- 逐 chunk 原样透传（`res.write(str)`）；`heartbeat.touch()`；`'"tool_calls"'` 子串出现 → `toolCallObserved`。
- 解析 `data:` 行：`[DONE]` → `markUpstreamEnded`；JSON → 记 `id`、`usage`、`error`、`choices[0].delta` 分类、`finish_reason` → `sawFinish` + `markUpstreamEnded`。
- 收尾：`!abortedByClient && !sawFinish && !sawError`：`emptyKind` → warn STREAM「空流 <kind>（无实质产出）: finish_reason=.., 有思考=..」→ 写 empty chunk + `[DONE]`；否则 `isTruncatedWithoutFinish` → warn「上游断流无 finish_reason，补截断终态」→ 写 length chunk + `[DONE]`。
- `logStreamOutcome`；finally：`markFinished; inFlight--; recordApiUsage; heartbeat.stop; dispose`。
- 统计：`inTokens = usage.prompt_tokens ?? max(10, round(rawBody.length/4))`；`outTokens = usage.completion_tokens ?? max(1, round(latency/15))`；`cachedTok` 取 `prompt_cache_hit_tokens ?? prompt_tokens_details.cached_tokens ?? cache_read_input_tokens ?? 0`。
- 日志：`CHAT` `流式输出完成 [<model>] 耗时 <n>ms (账号: [..], 缓存命中: <n> tok, 是否含工具调用: <bool>[, 思考保活: <n> 帧])`。

### 8.5 非流式分支
聚合 `content` / `reasoning_content|reasoning` / `tool_calls`（按 `index` 拼接，id 缺省 `call_<uuid>`，name 取最后非空，arguments 追加）；有 tool_calls → `finish_reason='tool_calls'` 并 info TOOLS「模型决定下发工具调用 (共 n 个)」；`outTokens = usage.completion_tokens ?? max(1, round(fullContent.length/4))`；日志 `CHAT` `非流式回复完成 [..] 耗时 ..ms (账号: [..], 缓存命中: .. tok, 结束原因: ..)`；响应 `{id, object:'chat.completion', created, model, choices:[{index:0, message, finish_reason}], usage:{prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details:{cached_tokens}, prompt_cache_hit_tokens}}`。
- 异常兜底：`CHAT` `处理对话请求异常: ..` → 500 `{error:{message, type:'api_error'}}`。

---

## §9 adapters/anthropic.mjs · adapters/tools.mjs

### 9.1 请求转换
- 模型名含 `claude|sonnet|opus` → 强制 `deepseek-v4.1-flash`。
- `system`（string 或 blocks）→ 首条 system；`messages[].content` blocks：`text` → 文本/数组；`image.source.data` → `{type:'image_url', image_url:{url:'data:<media_type>;base64,<data>'}}`；`tool_use` → `tool_calls`；`tool_result` → `{role:'tool', tool_call_id, content}`；单文本时 content 为字符串。
- `tools[]` → `{type:'function', function:{name, description, parameters: input_schema||{type:'object',properties:{}}}}`。
- thinking 映射：`type:'disabled'` → `none`；`enabled` 时 `budget_tokens<=0 → high`，`<2048 → minimal`，`<8192 → low`，`<16384 → medium`，`<32768 → high`，否则 `xhigh`；布尔 `true→high / false→none`；再与 `reasoning_effort` / `verbosity` / `reasoning_summary` 一起喂给 `applyReasoningParams`。
- 上游 body 与 OpenAI 一致（`cache_retention:'long'` 固定，`extra_vars` 固定）。

### 9.2 执行链
与 §8.3 逻辑相同，日志分类为 `ANTHROPIC`，文案前缀 `Anthropic 协议: `（见 `anthropic.mjs:243,271,341-342,351,362,370,378,394-395,404`）。差异：
- 失败收尾**不调用** `markFinished/dispose`（【D9】）；响应 `{type:'error', error:{type:'api_error', message:<errText 原始上游文本>}}`（【D8】）。
- `msgId = 'msg_' + uuid4hex.slice(0,24)`。

### 9.3 流式转译（事件序列契约，Claude Code 依赖）
```
message_start {message:{id, type:'message', role:'assistant', content:[], model, stop_reason:null, stop_sequence:null, usage:{input_tokens:0, output_tokens:0}}}
reasoning 来且未开 text → content_block_start idx0 thinking '' → 每个 reasoning 片段 content_block_delta thinking_delta
content 来 → 若 thinking 未 stop → content_block_stop idx0；textIdx = thinking?1:0；未开则 content_block_start text '' → text_delta
tool_calls 来 → 先 stop 未关闭的 thinking/text；baseIndex = (thinking?1:0)+(text?1:0)；idx=baseIndex+tc.index；
            首见 → content_block_start tool_use {id, name, input:{}}；arguments 片段 → input_json_delta partial_json
只有写出可见事件才 heartbeat.touch()
```
- 收尾：`!abortedByClient && !sawFinish && !sawError && isTruncatedWithoutFinish` → warn（空流/截断两套文案）→ 关闭所有未关块 → `message_delta {delta:{stop_reason: emptyKind?'error':'max_tokens', stop_sequence:null}, usage:{output_tokens}}` → `message_stop`；`truncationEmitted=true` 后直接 return。
- 正常收尾：关闭未关块 → `stop_reason = tools>0 ? 'tool_use' : 'end_turn'`；`outTokens = usage.completion_tokens || max(1, round(latency/15))`；`inTokens = usage.prompt_tokens || max(10, round(rawBody.length/4))`；`cachedTok` 四级回退；`message_delta {delta:{stop_reason}, usage:{output_tokens, cache_read_input_tokens}}` → `message_stop` → `markUpstreamEnded` → `recordApiCall` → 日志 `ANTHROPIC` `流式回复完成 [..] 耗时 ..ms (账号: [..], 缓存命中: .. tok, 结束原因: ..[ , 思考保活: n 帧])`。
- 响应头：`text/event-stream`、`no-cache`、`keep-alive`（无 X-Accel-Buffering）。

### 9.4 非流式
content blocks：`thinking`（若有）→ `text`（若有）→ 每个 tool_use（`input = JSON.parse(arguments||'{}')`，失败则 `{}`）；响应 `{id: msgId, type:'message', role:'assistant', content, model, stop_reason, stop_sequence:null, usage:{input_tokens, output_tokens, cache_read_input_tokens}}`；日志 `ANTHROPIC` `非流式完成 [...]`。

### 9.5 tools.mjs
- `handleSearch`：选号 `region:'cn'` 优先，否则任意；无账号 → 503 `{error:'No available account for search'}`；`POST ep.search` 头 `Authorization/UA/Content-Type`，body `{query, max_results: max_results||count||5}`，超时 15000ms【网关】；透传上游状态码与文本；日志 `SEARCH` `发起联网检索 [..]` / `检索完成 [..] 耗时 ..ms (HTTP ..)` / `检索异常: ..`。
- `handleWebFetch`：同上，body `{url}`，503 文案 `...for webfetch`，日志分类 `FETCH`。

---

## §10 web/routes.mjs

### 10.1 鉴权
- `getWebAuthPassword()`：`config.webPassword` trim 非空否则 `''`；`hasDedicatedWebPassword()`。
- `verifyWebAuthToken(token)`：`webAuthEnabled===false` → true；无 token → false；有独立口令 → 常量时间比对；否则只认 `config.apiKey`（**不**遍历 apiKeys）；都无 → false。
- 守卫：除 `/api/auth/login`、`/api/auth/status` 外，`webAuthEnabled!==false` 时 token 取 `Authorization: Bearer` → `x-web-token` → `?token=`；失败 401 `{error:'Unauthorized: Web console authentication required', code:'UNAUTHORIZED'}`。

### 10.2 路由表（40 个；入参 → 出参；状态码）
| # | 方法 路径 | 入参 | 出参 / 状态 |
|---|---|---|---|
| 1 | POST /api/auth/login | `{password|token}` | 200 `{ok:true, token: webAuthEnabled===false?'':(webPassword||input), webAuthEnabled, hasDedicatedPassword}`；403 `{ok:false, error:'控制台密码或 API Key 不正确，请重新输入'}`；400 `{error}`；日志 AUTH「Web 控制台授权成功通过 (IP: ..)」/「..凭据错误..」 |
| 2 | GET /api/auth/status | header/`?token` | 200 `{webAuthEnabled, authenticated}` |
| 3 | GET /api/metrics | `?range` | `getMetricsReport(range)` + `currentAccount, sessionAffinity, uptimeMs, uptime, startedAt(ISO)` |
| 4 | GET /api/settings | — | 脱敏视图：`port, apiKeyPreview, hasApiKey, apiKeys[{id,note,createdAt,enabled,keyPreview,isPrimary}], webAuthEnabled, hasWebPassword, webPassword:'', concurrencyLimitEnabled, maxInFlightPerAccount(默认3), routingStrategy(默认 least-inflight), routingRegionScope(默认 all), accountFailoverEnabled, pinnedAccount, stickySessionEnabled, stickySessionTtlMs, stickySessionMaxLifetimeMs, sessionStats, modelFallbackEnabled, modelFallback, tokenRefreshAdvanceDays(默认7), maxLogDbSizeMb(默认30), logDbSizeMb, autoCheckin, modelBlacklist, thinkingPolicy, promptPolicy, loggingPolicy, requestClientInfo, requestArchiveContext, privateDataPolicy` |
| 5 | POST /api/settings | 见下 | 200 `{ok:true, config, apiKeys, webAuthToken, promptPolicy, logDbSizeMb}`【D10 含明文】；400 `{error}` |
| 6 | POST /api/sessions/clear | — | `{ok:true, cleared}` |
| 7 | GET /api/keys | `?reveal=1` | `{ok:true, revealed, apiKey(脱敏|明文), keys[{...,key(脱敏|明文)}]}` |
| 8 | POST /api/keys | `{key, note}` | `{ok:true, entry, apiKey, keys}` / 400 `{ok:false,error}` |
| 9 | POST /api/keys/update | `{id, note?, enabled?, key?}` | 同上；缺 id → '缺少密钥 ID'；无 → '未找到指定密钥' |
| 10 | POST /api/keys/delete | `{id}` | `{ok:true, apiKey, keys}` |
| 11 | GET /api/logs | `date, level, category, search, limit=200, offset=0` | `Logger.getLogs(...)` 原样 |
| 12 | GET /api/logs/dates | — | `{dates}` |
| 13 | POST /api/logs/prune-size | `{maxSizeMb?}` | `checkAndPruneBySize` 原样 |
| 14 | GET /api/logs/export | `?date` | 单日：text/plain attachment `gateway-<date>.log`（≤10000 行，行格式 `[time] [LEVEL ] [cat] msg | meta`）；ALL：流式 `gateway.log`；无文件 → `# 日志文件暂为空` |
| 15 | POST /api/logs/clear | — | `{ok:true}` |
| 16 | GET /api/pricing | — | `{ok:true, prices}` |
| 17 | POST /api/pricing/search | `{query}` | 200 `{ok:true, ...report}` / 500 `{ok:false,error}` |
| 18 | POST /api/pricing/update | `{prices}` | `{ok:true, prices}` / 400 |
| 19 | GET /api/accounts | `?range=today, refresh=1, stale=0` | 先 `refreshStaleCredits(force?0:30000)`（失败忽略）；数组元素字段：`uid,email,note,region,creditsRemain,creditsUpdatedAt,totalTokens,totalTokensDisplay,inputTokens,outputTokens,requests,tokenRange,allTimeTokens,allTimeTokensDisplay,inFlight,status,restrictedReason,restrictedAt,expiresAt,expiresAtFmt,hasRefreshToken,daysRemaining,advanceDays,isRefreshEligible,isCooldown,cooldownRemainingSec,lockedModels[{modelId,remainingSec,expireAt,reason}],lockedCount,isCheckedInToday,lastCheckinMsg`；副作用：清理过期 `modelCooldowns` |
| 20 | GET /api/accounts/credit-details | `?uid` | 200 `{uid,email,note,region, ...details}`；404 `{error:'Account not found'}` |
| 21 | GET /api/accounts/usage-records | `uid, days=7, page=1, pageSize=20` | 200 `{...result, uid,email,note,region}`；400 `{ok:false,error:'缺少 uid 参数'}`；404 `{ok:false,error:'账号不存在'}` |
| 22 | GET /api/credits/history | `limit≤1000, offset, uid, range=today, date, refresh=1` | `{ok:true, total, records, range, date}` |
| 23 | POST /api/credits/history/clear | — | `{ok:true}`；日志 CREDIT_MONITOR |
| 24 | GET /api/models-detail | `?refresh=1` | `fetchDetailedModels(force)` 原样数组 |
| 25 | GET /api/models/blacklist | — | `{blacklist, blockedPreview[{id,bare,region}], blockedCount}` |
| 26 | POST /api/models/blacklist | `{blacklist:[]}` | `{success:true, blacklist, count}` / 400 `{success:false,error}` |
| 27 | POST /api/models/thinking-level | `{modelId, level='default'}` | `{success:true, modelId, level, thinkingPolicy}` / 400 |
| 28 | POST /api/oauth/start | body/query `region` | 200 `{state, loginUrl: ep.login(state)||authUrl, region}` / 500 `{error}`；日志 OAUTH |
| 29 | POST /api/oauth/poll | `{state, region}` | GET `ep.authToken(state)`；`code===11217` 或无 token → 200 `{ok:false,msg:'等待手机扫码授权中...'}`；成功：取 `/v2/plugin/accounts`（`lastLogin` 优先）→ 兜底 `ep.loginAccount(state)`；upsert by uid/uin；200 `{ok:true, account:{uid,uin,email,phoneNumber,type,region,expiresAt,creditsRemain,status,inFlight,hasRefreshToken}}`（不含 token）；其他 → `{ok:false,msg}`；400 非法 JSON `{ok:false,error:'请求体不是合法 JSON'}`；500 |
| 30 | POST /api/checkin | — | 串行全员 `dailyCheckin(acc,true)` → `{total, results[{uid,email,success,alreadyCheckedIn,msg}]}` |
| 31 | POST /api/checkin-single | `{uid, force}` | `dailyCheckin` 结果原样；404 `{error:'Account not found'}`；400 |
| 32 | POST /api/accounts/note | `{uid, note}` | `{ok:true, note}`；404；400 |
| 33 | POST /api/accounts/region | `{uid, region}` | `{ok:true, region, label}`；404；400 |
| 34 | POST /api/accounts/pin | `{uid}` | `{ok:true, pinnedAccount}`；400 |
| 35 | POST /api/accounts/refresh-token | `{uid}` | `refreshSessionToken` 结果；404；400 |
| 36 | POST /api/accounts/unlock-models | `{uid, modelId?}` | `{ok:true, msg:'锁池与受限状态已成功解除'}`；404；400 |
| 37 | POST /api/metrics/prune | `{mode, keepDays}` | `pruneStatsByTime` 原样；400 |
| 38 | POST /api/logs/prune | `{mode, keepDays}` | `Logger.pruneLogsByTime` 原样；400 |
| 39 | POST /api/accounts/import | JSON / `{rawJson}` / 数组 / `{accounts}` / `{account, auth}` / 单账号 | 识别规则见 routes.mjs:1324-1341；逐个 `normalizeAccount`（无 token 跳过）；存在则合并字段并置 healthy；`{ok:true, count, imported[{uid,email,region,domain,product,note,creditsRemain}]}`；400 `'未识别到有效的账号数据，请检查 JSON 结构'` / `'解析或导入失败: ..'` |
| 40 | POST /api/accounts/delete | `{uid}` | `{ok:true}`（不存在也 200）；400 非法 JSON |
| — | 其余 /api/* | — | 404 `{error:'API route not found'}` |

### 10.3 POST /api/settings 可更新字段（逐项类型守卫与钳制）
`thinkingPolicy(obj)`、`promptPolicy(obj) | promptMode+promptFile`、`loggingPolicy(obj) | requestClientInfo(bool)+requestArchiveContext(bool)`、`privateDataPolicy`、`concurrencyLimitEnabled`、`accountFailoverEnabled`、`apiKeys([])`（apiKey 取首个启用项）| `generateNewApiKey:true` | `apiKey(string，空则随机)`、`webAuthEnabled`、`webPassword`、`stickySessionEnabled`、`stickySessionTtlMs`/`stickySessionMaxLifetimeMs`（钳制 [10s, 365d]；maxLifetime<ttl 时抬到 ttl）、`routingStrategy`、`routingRegionScope`（cn|intl|all）、`pinnedAccount`、`modelFallbackEnabled`、`modelFallback(obj)`、`tokenRefreshAdvanceDays`（[1,30]）、`maxLogDbSizeMb`（≥1，触发 `checkAndPruneBySize`）、`maxInFlightPerAccount`（≥1）。成功后 `saveConfig()` + `CONFIG` 日志「网关运行策略已更新 (热生效)」。

### 10.4 控制台渲染
`renderDashboardTemplate()`：读 `src/web/public/index.html`，展开 `<!-- @include "..." -->`（相对路径；缺失则 warn WEB「模板拼装缺失子模块」并嵌入 `/* Missing include: .. */`）。`handleDashboard`：替换 `{{PORT}}`、`{{API_KEY}}`（启用鉴权时 `sk-****************`）、`{{VERSION}}`、`{{CA_COUNT}}`、`{{WEB_AUTH_ENABLED}}`；响应头 `text/html; charset=utf-8` + `no-cache, no-store, must-revalidate` + `Pragma: no-cache` + `Expires: 0`。

---

## §11 server.mjs · gateway.mjs

- 启动横幅（console.log，含 emoji 与文案）照搬；`PORT` 取 `config.port||8317`。
- 启动修正（268-297）：全部账号 `inFlight=0`；403 受限账号标记；全量 `refreshCredits`。
- 信号：`SIGINT/SIGTERM` → `flushAllOnShutdown` → `process.exit`；`beforeExit` → flush；`unhandledRejection/uncaughtException` → `recordProcessAnomaly`（60s 内同类只 warn 一次，计数；不退出）。
- 路由与 50MB 限制见架构 §4；`/healthz` 返回 JSON（含 `process.uptime()`、账号数等，字段以源码为准）。
- CORS：允许头与方法以 162-168 为准；`OPTIONS` → 204。
- 404：`{"error":"Endpoint not found"}`。

---

## §12 疑点总表（迁移时照搬，不修；供 Node 版单独修）

| # | 位置 | 现象 | 建议 |
|---|---|---|---|
| D1 | scheduler.mjs:296-297 | 先 `lastActive=now` 再算剩余保活 → 恒满 TTL | 交换两行 |
| D2 | scheduler.mjs:144,367 | 随机 UUID 兜底 key 仍写入 sticky map，7 天才过期 | 无特征请求不入 map |
| D3 | scheduler.mjs:349-352 | rrIndex 对候选集长度取模，候选集变化时漂移 | 文档化即可 |
| D4 | logger.mjs:88,142 | 日志本地时间、裁剪 cutoff UTC | 统一时区 |
| D5 | database.mjs:84-87 | SQLite 打开失败静默降级 | 加 error 日志 |
| D6 | log-parser.mjs:21 | 硬编码默认账号 uid/name（含个人信息） | 从 accounts.json 读或删 |
| D7 | openai.mjs:252 / anthropic.mjs:291 | `applySystemPromptPolicy` 在重试循环内调用，`append` 模式重复插入 | 每次迭代从原始 messages 重建 |
| D8 | anthropic.mjs:437 | 失败路径 `error.message` 为上游原始文本，`type` 恒 `api_error` | 对齐 OpenAI 的 formatOpenAIError |
| D9 | anthropic.mjs:434-438 | 失败路径未 `markFinished/dispose` | 补齐 |
| D10 | routes.mjs:406-413 | POST /api/settings 响应回传完整 `config`（含 apiKey/webPassword）与 apiKeys 明文 | 与 GET 同口径脱敏 |

---

## §13 日志文案契约（log-parser / 控制台依赖，逐字保留）

| 分类 | 必含短语 |
|---|---|
| CHAT | `收到 OpenAI 对话请求 [`、`流式输出完成 [`、`非流式回复完成 [` |
| ANTHROPIC | `收到 Claude Code 协议请求 [`、`流式回复完成 [`、`非流式完成 [` |
| DISPATCH | `调度选中账号 [`、`粘性会话复用账号 [`、`精准路由至网关全局指定账号 [` |
| FAILOVER / REROUTE | 见 §8.3 文案 |
| UPSTREAM / AUTH / NETWORK | 见 §8.3 文案 |
| STREAM | `空流`、`补截断终态`、`客户端已断开，停止重试` |
| CONFIG / ACCOUNTS / COOLDOWN / OAUTH / CREDIT_MONITOR / STATS / SEARCH / FETCH | 见 §10 对应行 |
| WEB / PROCESS | 模板缺失、进程异常 |

> `log-parser.mjs` 的正则以源码为准；迁移 metrics 时必须把每条正则抄进测试。
