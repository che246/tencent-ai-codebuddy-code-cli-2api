# 更新日志 (Changelog)

本项目所有重要更新、协议对齐改动与修复均记录于此文件。

> **规范准则**：
> - 格式遵循 [Keep a Changelog](https://keepachangelog.com/) 规范。
> - 所有改动严格遵循《[AGENTS.md](file:///d:/AI/tencent-ai-codebuddy-code/AGENTS.md)》：**以官方 CodeBuddy CLI 端实现为唯一依据**，数值与行为可追溯。

---

## [2.179.0-gw.31] - 2026-11-23

### 国际版每日打卡超参数严格对齐官方 CLI 对话规范 (Checkin Hyperparameters Strict Alignment with Official CLI)
- **官方 CLI 超参数与请求体规范严格对齐 (Rule 0 & Rule 2)**：
  - **背景与逆向依据**：此前网关在国际版打卡对话中尝试使用动态浮动超参数（`temperature: 0.45 ~ 0.85`, `max_tokens: 28 ~ 56`）。深入逆向官方 CLI 核心执行体 `package/dist/codebuddy-headless.js` 与模型清单 `package/product.json` 确认：
    1. 官方 CLI 核心定义 `DEFAULT_TEMPERATURE = 1`，且在 `product.json` 中 `deepseek-v4.1-flash` 的标准温度恒为 `"temperature": 1`；
    2. 官方 CLI 构造对话请求体时，`max_tokens` 在未被用户显式限制时缺省不传（交由上游服务端按模型规格默认上限 `maxOutputTokens: 128000` 自动处理），不传随机小整数；
    3. 请求体标准结构恒为 `{ model, messages, stream: true, temperature: 1, stream_options: { include_usage: true }, extra_vars: { initiator: 'user', interactionType: 'prompt' } }`。
  - **修改实施 (`AccountScheduler.generateDynamicCheckinDialogue` & `dailyCheckinIntl` in `src/core/scheduler.mjs`)**：
    - 移除一切人工随机扰动的非官方超参数（移除浮点温度扰动与随机 `max_tokens`）；
    - 超参数严格收敛对齐官方 CLI：设置 `temperature: 1`，缺省 `max_tokens`；
    - 保持 300+ 种技术领域自然提示词与账号间 8~20s 随机时序打散，在杜绝报文内容重复指纹的同时，保证报文协议与官方 CLI 终端发出的请求体 100% 字节级对齐。

---

## [2.179.0-gw.30] - 2026-11-23

### 国际版每日活跃打卡拟真随机对话引擎与时序防抖对齐 (International Realistic Dynamic Dialogue Engine & Jitter Delay Anti-Pattern)
- **国际版动态拟真打卡对话生成引擎 (`AccountScheduler.generateDynamicCheckinDialogue` in `src/core/scheduler.mjs`)**：
  - **背景与风控规避**：此前国际版打卡仅依靠 7 句固化静态问答（如 `Hi, please reply with "pong"`）且采用固定超参数（`temperature: 0.7`, `max_tokens: 32`）。同一出口 IP 在多个国际版账号上高频执行完全相同的机械性对话，极易被腾讯上游风控判定为批量自动化异常行为并导致 11140 限制；
  - **四大多元化拟真技术库与 300+ 动态组合**：
    1. **编程语言与工程实战**：覆盖 10 种主流编程语言（Python, TypeScript, Go, Rust, Java, C++, Shell, SQL...）与 10 种核心关键字（`async/await`, `defer`, `match`...）的动态组合提问；
    2. **DevOps、Git 与 Linux 命令行运维**：涵盖 Git 提交、Linux 内存/磁盘查询、Docker 容器监控、curl 请求头与 jq 处理等高频开发场景；
    3. **计算机科学与系统架构**：覆盖常见算法平均时间复杂度、REST 幂等性、连接池设计、分布式 CAP 原理等技术探讨；
    4. **动态趣味计算与日常技术生活**：包含随机算式动态生成、工位健康贴士、HTTP 状态码速答与 Pull Request 礼貌感谢语；
  - **超参数动态扰动 (Parameter Jitter)**：每次调用动态计算浮动的 `temperature` (0.45 ~ 0.85) 与 `max_tokens` (28 ~ 56)，使每次打卡请求无论在报文内容还是在请求参数上均全局唯一、零机械指纹。
- **账号间时序打散与随机防抖休眠 (`AccountScheduler.checkAndRunHourlyCheckin`)**：
  - 在每小时定时巡检多账号执行打卡时，针对国际版账号自动注入 `8s ~ 20s` 的随机动态休眠抖动（Jitter Delay），杜绝同一分钟内并发突发连续请求，彻底消除自动化批处理规律。

---

## [2.179.0-gw.29] - 2026-11-23

### 官方上游 11140/11142 风控受限协议对齐、智能标记隔离与自动故障转移接力 (Official Risk-Control 11140/11142 Alignment, Auto-Isolation & Seamless Failover)
- **官方上游 11140/11142 业务错误码与状态机对齐 (Rule 0 & Rule 2)**：
  - **背景与逆向依据**：当账号触发腾讯上游安全风控策略时，上游返回 HTTP 403 `{"code":11140,"msg":"request illegal","displayMsg":{"zh":"账号存在异常行为，已被限制使用"}}`。逆向 `package/dist/codebuddy-headless.js` 确认，官方 CLI 将 `11140` 与 `11142` 严格归类为 `{ category: "auth", subcategory: "auth_forbidden" }`，并在 `rf = new Set([11140, 11141, 11142, 17271...])` 集合中将其排除在普通 Token 过期（`auth_expired`）之外，明确判定为账号级风控拦截（不可通过刷新 Token 恢复）；
  - **枚举与映射体系 (`src/upstream/errors.mjs`)**：
    - 新增 `ServerErrorCode.AccountRestricted = 11140` 与 `ServerErrorCode.AccountForbidden = 11142` 枚举；
    - 建立 `ACCOUNT_RESTRICTED_CODES` 集合，统一判定账号风控拦截；
    - 在 `formatOpenAIError` 中映射为 `type: "permission_error"`, `code: "account_restricted"`。
- **协议适配层自愈熔断与平滑故障转移 (`src/adapters/openai.mjs` & `src/adapters/anthropic.mjs`)**：
  - **智能识别与状态沉降**：当推理调用命中 `ACCOUNT_RESTRICTED_CODES` (11140/11142) 时，自动将该账号标记为 `acc.status = 'restricted'`，记录受限原因与时间戳并立即持久化落盘（`saveAccounts()`）；
  - **无感故障转移 (Failover)**：自动清理受限账号的粘性会话绑定（Sticky Session），立即调度池中其他可用健康账号（如国内版主力账号）无缝接力续跑当前模型，终端用户调用完全无感知、不报错；
  - **模型降级闭环**：若全池账号均受限，自动触发模型降级链切换备选模型，杜绝死锁与空等。
- **巡检打卡任务风控感知与日志降噪 (`src/core/scheduler.mjs`)**：
  - **打卡接口感知**：`dailyCheckinIntl` 请求上游若捕获 HTTP 403 / 11140，自动将账号沉降为 `restricted` 状态，免除后续无谓重试；
  - **定时巡检抑制**：`checkAndRunHourlyCheckin` 与 `dailyCheckin` 自动跳过 `restricted` 账号，彻底消除每小时定时任务对受限账号的无效重试与日志刷屏。
- **启动状态初始化与自适应修复 (`src/server.mjs`)**：
  - 网关服务启动时自动巡检全量账号，若账号最近一次打卡已确认为 HTTP 403 风控限制，直接将其初始化为 `restricted` 并移出活跃调度池，保障国内正常流量 100% 命中健康账号。
- **Web 控制台全链路可视化与一键解锁 (`src/web/public/scripts/accounts.js` & `src/web/routes.mjs`)**：
  - **状态徽章直观呈现**：账号列表中受限账号显示醒目的 `🚫 风控受限` 红色徽章，鼠标悬停浮窗呈现上游官方原因（“账号存在异常行为，已被限制使用 (11140)”）；
  - **调度锁池呈现**：模型可用性列展示 `🚫 全局不可用`；
  - **一键重置与申诉复原**：操作列与一键解锁逻辑中支持管理员在申诉成功或需人工复查时，点击 `🔓 解锁` 即可一键清除受限状态并恢复为 `🟢 健康活跃`。

---

## [2.179.0-gw.28] - 2026-11-20

### 积分历史变动监控支持按日期筛选且默认显示今日 (Credit History Date Filtering & Default Today View)
- **数据库查询引擎时间区间与日期索引扩展 (`src/core/database.mjs`)**：
  - **背景与需求**：满足用户聚焦查看今日积分充盈、打卡奖励与扣减明细，同时支持灵活追溯昨日、近7天、近30天与全部历史变动；
  - **按日索引与区间查询优化 (`LogDatabase.queryCreditHistory`)**：
    - 引入 `idx_credit_history_date` 索引，确保大规模流水下按日与按时间范围毫秒级检索；
    - 支持 `range` 参数：`today`（今天，默认）、`yesterday`（昨天）、`7d`（近7天）、`30d`（近30天）、`all`（全量历史）及特定日期精确过滤。
- **接口扩展 (`GET /api/credits/history` in `src/web/routes.mjs`)**：
  - 支持 `range` 与 `date` 参数透传，缺省默认返回 `today`；
  - 响应报文透传当前生效的 `range` 与 `date` 字段，保障前后端状态一致性。
- **Web 控制台积分历史看板工具栏日期筛选组件 (`src/web/public/index.html` & `src/web/public/scripts/accounts.js`)**：
  - **变动日期快捷药丸**：在筛选账号旁新增「变动日期」筛选器（`[今天 (默认)]`、`[昨天]`、`[近7天]`、`[近30天]`、`[全部历史]`）；
  - **表头动态标签**：表头时间列智能挂载 `[今日]`、`[昨日]` 等当前区间微标；
  - **空态友好提示与快捷切换**：当所选日期内暂无记录时，智能提示并在空态区域提供一键切换至全部历史的引导链接。

---

## [2.179.0-gw.27] - 2026-11-20

### 积分历史变动监控支持按账号筛选与联动定位 (Credit History Account Filtering & Interactive Jump)
- **数据库查询引擎双向匹配扩展 (`src/core/database.mjs`)**：
  - **背景与需求**：当账号池拥有多个国内外账号且运行时间较长时，运维人员需精准追溯特定账号的积分变动、充盈与扣减轨迹；
  - **精准与别名查询优化 (`LogDatabase.queryCreditHistory`)**：
    - 在过滤条件中升级为 `(account_uid = ? OR account_name = ?)` 双向自适应匹配；
    - 无论是传递账号真实 UID、手机邮箱标识还是自定义备注名称，均能精准锁定并返回该账号的历史流水。
- **Web 控制台积分历史工具栏账号筛选器与交互联动 (`src/web/public/index.html` & `src/web/public/scripts/accounts.js`)**：
  - **账号筛选下拉菜单**：
    - 在「积分历史」看板工具栏新增「筛选账号」下拉组件；
    - 自动根据账号池数据分组动态填充（分组展示 `🇨🇳 国内版账号` 与 `🌐 国际版账号`，包含昵称、备注与 UID 后四位）；
    - 支持一键切换「全部账号 (全部显示)」与任一指定账号。
  - **账号列表一键联动定位**：
    - 在账号池表格的「可用积分」操作列新增 `变动` 按钮；
    - 点击任意账号的 `变动` 按钮（或点击积分历史列表中展示的账号名称），自动将筛选器锁定为该账号、平滑滚动至积分历史看板并刷新数据；
  - **即时筛选状态胶囊反馈**：
    - 处于筛选状态时，顶部醒目展示 `👤 已按账号筛选: [账号] ✕` 药丸标签，点击即可一键重置为全量历史。

---

## [2.179.0-gw.26] - 2026-11-19

### 账号池运维状态与配额监控已消耗 Token 按日期筛选支持与默认今日显示 (Account Token Usage Filtering by Date & Default Today View)
- **多维度时间区间 Token 用量聚合引擎 (`src/core/metrics.mjs`)**：
  - **背景与需求**：满足用户实时监控今日（当天）各账号实际产生的 Token 消耗，同时支持灵活查看昨日、近7天、近30天及全部历史累计用量；
  - **按时间区间统计引擎 (`getAccountStatsByRange`)**：
    - 精确解构并聚合 `stats.daily[date].accounts` 按日日志与按账号统计结构；
    - 支持标准时间区间筛选：`today`（今天，默认）、`yesterday`（昨天）、`7d`（近7天）、`30d`（近30天）、`all`（全量历史）；
    - 内置账号 UID、邮箱与昵称双向别名快速匹配，确保即使多端点异名调用也能精准关联到目标账号。
- **账号列表接口扩展 (`GET /api/accounts` in `src/web/routes.mjs`)**：
  - 新增 `?range=today|yesterday|7d|30d|all` 查询参数，默认缺省值为 `today`（遵循用户首选习惯）；
  - 返回对象补充 `tokenRange`、`totalTokens`、`totalTokensDisplay`、`requests` 以及全量累计 `allTimeTokens` 与 `allTimeTokensDisplay`。
- **Web 控制台账号池工具栏与表格呈现升级 (`src/web/public/index.html` & `src/web/public/scripts/accounts.js`)**：
  - **消耗日期筛选栏**：在区域筛选旁新增「消耗 Token 日期」快捷药丸组件（`今天 (默认)`、`昨天`、`近7天`、`近30天`、`全部历史`）；
  - **表头动态标识**：表头「已消耗 Token」智能同步呈现当前时间区间标签（如 `今日`、`昨日`、`近7天` 等）；
  - **用量与请求数明细展示**：
    - 主数值显示所选日期范围内的消耗 Token 与请求频次；
    - 鼠标悬停 Tooltip 呈现详细的区间输入/输出构成及历史累计总消耗；
    - 非「全部」模式下直观标注历史累计用量提示，让当天消耗与历史用量一目了然。

---

## [2.179.0-gw.25] - 2026-11-18

### 账号池负载均衡轮换区域范围策略支持 (Routing Region Scope: Domestic / International / All)
- **网关账号调度引擎区域范围感知与轮换策略 (`src/core/scheduler.mjs` & `src/config.mjs`)**：
  - **背景与需求**：满足用户灵活指定全局轮换策略所作用的账号池范围（全部账号、仅国内版、或仅国外版）；
  - **核心选号调度分流机制 (`AccountScheduler.selectAccount`)**：
    - 支持配置全局轮换范围 `config.routingRegionScope`（`all` 全部轮换 / `cn` 仅国内版 / `intl` 仅国外版）；
    - **最高优先级保证**：若请求模型显式指定了区域前缀（如 `cn:deepseek-v4.1-flash` 或 `intl:claude-3-5-sonnet`）或降级链强制约束，严格以模型前缀区域为准；
    - **普通/通用模型智能匹配**：对于无前缀通用模型调用，严格按照设定的区域范围锁定参与轮换的候选账号池（如设为 `cn` 则只在 4 个国内账号间轮换，设为 `intl` 则只在 8 个国际账号间轮换）；
  - **调度状态联动 (`getCurrentActiveAccountInfo`)**：
    - 活跃账号快照与概览卡片智能呈现当前轮换范围标签（如 `国内·最多积分`、`国外·最小并发` 等）。
- **Web 控制台运行策略设置面板交互升级 (`src/web/public/index.html` & `src/web/public/scripts/settings.js`)**：
  - 在「账号池负载均衡轮换策略」配置项中新增「轮换区域范围」下拉选择器（`🌍 全部轮换 (国内 + 国外)`、`🇨🇳 仅国内版轮换`、`🌐 仅国外/国际版轮换`）；
  - 配套实时状态角标 `badgeRoutingScope`（全部轮换 / 仅国内版 / 仅国外版），修改后即刻热生效并持久化至 `config.json`。

---

## [2.179.0-gw.24] - 2026-11-18

### 账号池运维状态与配额监控全景区域筛选 (Account Pool Regional Filtering & Search)
- **Web 控制台账号池区域筛选工具栏 (`src/web/public/index.html` & `src/web/public/scripts/accounts.js`)**：
  - **背景与需求**：在账号池（国内版与国际版共存）规模增大后，运维人员需按区域（国内 / 国外 / 全部）快速查看各账号的运行状态、额度消耗与可用积分；
  - **三态无感切换药丸筛选组件**：
    - `全部显示 (共 X 个)`：展现全量账号池运行与配额全景；
    - `🇨🇳 国内版 (共 Y 个)`：仅过滤展示绑定腾讯云/国内端点的账号；
    - `🌐 国际版 (国外) (共 Z 个)`：仅过滤展示绑定海外端点（`codebuddy.ai` / `workbuddy.ai`）的账号；
  - **动态数量自适应与即时搜索**：
    - 各筛选按钮实时联动统计各区域账号数；
    - 新增多字段即时搜索框（支持实时模糊匹配 UID、邮箱/手机、昵称与备注信息）；
    - 状态表格空态友好提示（区分无账号与当前区域未筛选到账号）。

---

## [2.179.0-gw.23] - 2026-11-18

### 账号导入复合结构增强与 WorkBuddy 国内版自动识别 (Account Import Enhancement & WorkBuddy CN Recognition)
- **账号导入结构兼容性扩展 (`src/web/routes.mjs`)**：
  - **背景与逆向依据**：官方客户端及部分外部工具在导出或复制账号认证信息时，采用 `{ account: {...}, auth: {...} }` 分离结构（`account` 承载昵称与 uid，`auth` 承载 accessToken/refreshToken/domain/realm 等）；
  - **自动合并与属性透传**：在 `/api/accounts/import` 接口中，支持自动识别并解构合并 `account` 与 `auth` 对象，无缝对接标准规范化流程。
- **WorkBuddy 国内版属性与备注精准推断 (`src/config.mjs`)**：
  - 修复 WorkBuddy 在国内域（`domain: www.workbuddy.cn` / `realm: cn`）下备注被单一判定为国际版的偏差，依据账号区域精准映射为 `WorkBuddy 国内版`，保持与腾讯云国内计费节点及端点完全对齐。

---

## [2.179.0-gw.22] - 2026-11-17

### 闲置感知按需积分刷新策略与官方模型卡片文案/档位语义精准对齐 (Idle-Aware Credit Refresh & Upstream Model Semantics)
- **网关闲置感知与按需账单刷新 (Activity-Driven Credit Refresh)**：
  - **背景与痛点**：原后台定时器每 5 分钟无条件遍历全量账号轮询腾讯云计费接口 `/billing/meter/get-user-resource-summary`，在无客户端调用（闲置态）下每天产生数千次无意义的盲目轮询，增加被风控或限流的风险；
  - **全链路调用感知引擎 (`src/core/scheduler.mjs`)**：
    - 引入全局业务调用时间戳 `lastApiCallTimestamp` 与闲置判定窗口 `GATEWAY_IDLE_THRESHOLD_MS`（默认 15 分钟）；
    - 在双协议适配器（[src/adapters/openai.mjs](file:///d:/AI/tencent-ai-codebuddy-code/src/adapters/openai.mjs) 与 [src/adapters/anthropic.mjs](file:///d:/AI/tencent-ai-codebuddy-code/src/adapters/anthropic.mjs)）请求终态及流结束处精准打点 `AccountScheduler.recordApiUsage(activeAcc)`；
  - **后置防抖即时刷新与闲置停更 (`refreshActiveAccountsIfStale`)**：
    - 单账号调用结束后，自动排队 3.5 秒后置防抖刷新，精准拉取本次消耗结算后的真实最新余额；
    - 后台 5 分钟轮询检测到网关处于闲置期时，完全停止向上游发起任何计费请求；仅在活跃期且存在待刷新账单的账号上执行错峰同步。
- **官方上游模型卡片文案与语义精准对齐 (Rule 0 & Rule 2)**：
  - **拥堵状态文案对齐 (`src/web/public/scripts/models.js`)**：
    - 针对 `congested` 状态，对齐官方 CodeBuddy 桌面端精准渲染为醒目的红标 **`极度拥堵`**（原简写为“拥堵”）；`busy` 对应 **`拥堵`**，`normal` 对应 **`畅通`**，`idle` 对应 **`空闲`**；
  - **思考强度档位中文对齐**：
    - 思考档位全面对照官方展示：`max (极致)`、`xhigh (极高)`、`high (深度)`、`medium (标准)`、`low (浅思)`、`off (关闭)`；
  - **上下文与输出窗口单位对齐**：
    - 上下文/输出长度达百万级别（如 1000K / 1048576 tokens）时，对齐官方标准格式化展示为 **`1M`**。

---

## [2.179.0-gw.21] - 2026-11-17

### 官方上游模型实时繁忙度探测对齐 (POST /v2/chat/busy) 与 Web 面板拥堵状态徽章 (Official Model Realtime Busy Probing & Congestion Badges)
- **官方上游实时繁忙度接口对齐 (Rule 0 & Rule 2)**：
  - **背景与逆向依据**：官方客户端（WorkBuddy / CodeBuddy RPC 层）在查询模型状态时通过 `POST /v2/chat/busy` 实时探测模型繁忙度（`idle` | `normal` | `busy` | `congested` | `unavailable` | `unknown`）。仅国内版部署该接口（国际版返回 404），属于纯只读观测数据；
  - **实时繁忙度探针引擎 (`fetchUpstreamModelBusyLevels` in `src/upstream/models.mjs`)**：批量分批（每批 50 款模型）携带官方同款轻量头族（`Accept`, `Content-Type`, `X-User-Id`, `X-Product: SaaS`, `X-Domain`, `X-Request-ID`）请求上游，为模型自动挂载最新实测 `busy` 状态；
- **Web 控制台模型列表拥堵/繁忙徽章与筛选**：
  - **模型特性徽章集成 (`src/web/public/scripts/models.js`)**：在「工具」、「视觉」等能力标签旁智能呈现官方同款 `拥堵` (红色 `congested`/`unavailable`) 与 `繁忙` (黄色 `busy`) 徽章（`idle`/`normal` 保持安静不打扰）；
  - **悬停浮窗 Tooltip**：鼠标悬停清晰提示“上游繁忙度 congested（/v2/chat/busy 实时；服务端偶发无数据，同一批重查可能变）”，与官方桌面端行为严格一致；
  - **筛选工具栏全能力扩展 (`src/web/public/index.html`)**：支持一键筛选「上游繁忙 / 拥堵」模型。

---

## [2.179.0-gw.20] - 2026-11-17

### 官方上游模型促销活动协议对齐与 Web 面板活动角标全景展示 (Official Model Promotions & Web UI Activity Badges)
- **官方上游促销活动协议对齐与动态捕获 (Rule 0 & Rule 2)**：
  - **背景与痛点**：官方上游在 `/v3/config` 的 `data.modelPromotions` 下发了完整的促销规则对象（包含活动标签 `badge.label`、背景色 `badge.color`、官方矢量图标 `badge.icon`、悬浮提示文案 `hover.textZh`、折扣折算系数 `discount.factor` 及生效周期 `schedule`）。网关原本仅在模型列做硬编码判断，未完整对齐并透传官方丰富的促销元数据；
  - **动态促销活动提取与持久化 (`src/upstream/models.mjs`)**：在 `fetchDetailedModels` 中支持从 `/v3/config` 动态解析 `data.data.modelPromotions`，并将全量促销矩阵与模型矩阵一同合并持久化至 [product.json](file:///d:/AI/tencent-ai-codebuddy-code/product.json)（`loadPromotionsFromProductJson` / `persistModelsToProductJson`）；
  - **模型促销规则匹配引擎 (`resolveModelPromotion`)**：按模型 ID、全名及关联别名精准关联上游活动（如当前官方正生效的 `hy4flash-free` 限时免费赠送额度活动）；同时针对官方常态非高峰优惠策略进行兜底对齐（如 `DeepSeek-V4.1-Flash` 与 `GLM-5.2` 在非高峰期享受 5 折夜间折扣、0 积分模型自动标记限时免费）。
- **网关 Web 控制台模型列表促销角标与交互增强**：
  - **促销活动角标与悬停气泡卡片 (`src/web/public/scripts/models.js` & `components.css`)**：
    - 模型名称旁直观展示官方同款样式活动角标（如 🌙 `夜间折扣`、🎁 `限时免费`、⚡ `限时特惠`），支持渲染官方动态矢量图标或主题图标；
    - 鼠标悬停（Hover）即弹出高质感 Tooltip 气泡卡片，呈现完整活动规则（如“周一至周五 09:00-12:00、14:00-18:00 属高峰原价，非高峰期积分5折 去使用”）、折算优惠比例、活动有效截止时间（`schedule.validUntil`）及官方操作指引；
    - 在「积分倍率」列智能展示折后参考倍率（例如 `x0.11` 标明 `5折` 并计算出 `特惠折后 ≈ x0.05`，免费模型标明 `0x (免积分)`）；
  - **综合筛选工具栏价格分类升级 (`src/web/public/index.html`)**：
    - 下拉筛选器扩展为：`🔥 有活动 / 限时免费`、`🎁 限时免费`、`🌙 夜间折扣`、`⚡ 打折特惠 (非免费)`，支持一键精准过滤出所有享用优惠力度的模型。

---

## [2.179.0-gw.19] - 2026-11-16

### 全工程深度代码审计与双协议降级链路区域隔离加固 (Codebase Audit & Routing Hardening)
- **多模型降级链故障转移 (Failover) 区域隔离加固 (Rule 0 & Rule 2)**：
  - **背景与痛点**：在 OpenAI 与 Anthropic 双协议适配器处理模型降级链（`modelFallback`）时，若首选模型限流触发同模型异号重试或下一个候选模型接力时，原故障转移选号分支未严格传递当前候选步骤所锁定的 `curRegion`，极端场景下跨区备选模型（如 `cn:deepseek-v4.1-flash` -> `intl:deepseek-v4.1-flash-sg`）重试时可能误匹配到非目标区域账号导致上游 401 鉴权失败；
  - **加固实现**：在 [src/adapters/openai.mjs](file:///d:/AI/tencent-ai-codebuddy-code/src/adapters/openai.mjs) 及 [src/adapters/anthropic.mjs](file:///d:/AI/tencent-ai-codebuddy-code/src/adapters/anthropic.mjs) 中统一将选号约束 `region` 绑定为当前候选步骤所属的 `curRegion`，实现全链路严格的区域隔离闭环。
- **账号池冷启动自愈与规范化防护 (`src/config.mjs`)**：
  - 加载持久化文件 `accounts.json` 时全量管道式接入 `normalizeAccount` 过滤器，确保即使外部环境或运维人员手工更新/追加非标准 CLI 格式账号，网关启动与运行时均自动完成字段兜底补齐（`inFlight=0`、`modelCooldowns={}`、区域推断等），杜绝空字段引发的未定义异常。
- **全工程语法与依赖纯净度审计**：
  - 经全量静态扫描与语法测试验证：全工程 29 个核心源码模块均保持 Node.js >= 22 原生零依赖纯血架构，无语法与类型隐患，服务端模板动态拼装渲染（`renderDashboardTemplate`）解析零缺失。

---

## [2.179.0-gw.18] - 2026-11-16

### 国际版每日随机活跃对话打卡 · 自动激活每日 Bonus Pack 奖励 (Intl Daily Dialogue Check-in)
- **国际版账号活跃任务机制对齐与落地 (Rule 0 & Rule 2)**：
  - **背景与痛点**：官方国际版（`www.codebuddy.ai` / `www.workbuddy.ai`）未提供国内版同款的 `/v2/billing/meter/daily-checkin` 签到 API；旧版网关将其判定为无签到能力并直接略过，导致国际版账号无法自动领取官方每日活跃奖励包（Bonus Pack 每日 +30 Credits）；
  - **活跃对话打卡引擎 (`dailyCheckinIntl`)**：在 `src/core/scheduler.mjs` 中为国际版建立专属活跃打卡机制。当检测到当天尚未打卡时，自动从预置的安全轻量提示词池（`INTL_CHECKIN_PROMPTS`）中随机挑选一条指令（如询问简短问候、数学计算或 pong 响应），通过官方同款流式规范（携带前置引导 System 提示词、官方追踪头与 `stream: true`）向上游发起极简对话（限制 `max_tokens: 32`，消耗极微小）；
  - **实测数据与即时入账验证**：实测调用完成后，上游即时判定账号当日活跃并下发每日 Bonus Pack（+30 积分，如 `caicai5201314@gmail.com` 余额从 401.43 自动刷新至 641.43，`che246` 从 372.57 增加至 523.54，`fuvkyc` 从 308.53 增加至 545.45）。打卡完成后自动触发 `AccountScheduler.refreshCredits`，将最新积分与流水实时持久化入库；
  - **每小时全池巡检无感保活 (`checkAndRunHourlyCheckin`)**：解除旧逻辑中对国际版账号的跳过限制。网关启动时及每小时定时巡检时，自动前置过滤当天已完成签到/打卡的账号；对于新跨天或新增未打卡账号，国内版自动走签到接口，国际版自动走对话打卡，实现全自动领奖。
- **Web 控制台状态感知与交互优化**：
  - **前端状态徽章与快捷打卡 (`src/web/public/scripts/accounts.js`)**：移除国际版表格中原本固化的“🚫 无签到”禁用标签，变更为语义明确的「⏳ 未打卡 [对话打卡]」与「✅ 已打卡」，鼠标悬浮可查看当日打卡详情与提示；
  - **全员一键打卡兼容**：顶栏「⚡ 全员打卡签到」支持同时调度国内版签到与国际版对话打卡，并在反馈弹窗中清晰展示各账号打卡执行结果。

---

## [2.179.0-gw.17] - 2026-11-16

### 官方 CLI / WorkBuddy 账号凭据导入与领域自适应 (CLI & WorkBuddy Account Ingestion)
- **官方 CLI / IDE 导出结构兼容与领域解析对齐 (Rule 0 & Rule 2)**：
  - 深度兼容官方 CLI 及 WorkBuddy 导出结构 `{"accounts": [...]}`（含 `uid`, `nickname`, `domain`, `realm`, `product`, `platform`, `accessToken`, `refreshToken`）；
  - **区域推断增强 (`resolveAccountRegion`)**：在 `src/config.mjs` 中扩展识别逻辑，支持根据 `realm`（如 `realm: "intl"`）及 `domain` / `endpoint`（如 `workbuddy.ai`, `codebuddy.ai`）自动识别并归类为国际版（`REGION_INTL`），彻底解决旧逻辑中因缺少 `region` 字段误判为国内版导致上游 401 的痛点；
  - **账号规范化解析引擎 (`normalizeAccount`)**：自动从 `accessToken` JWT Payload 解析 `email`、`preferred_username` 与 `exp` 有效期，自动设置状态为健康并推断清晰的备注信息（如“WorkBuddy 国际版”）。
- **账号批量与单凭据导入 REST API (`POST /api/accounts/import`)**：
  - 在 `src/web/routes.mjs` 中新增账号导入端点，支持解析标准 JSON 数组、`{ accounts: [...] }` 结构或单个账号对象；
  - 采用 UID 自动去重策略：已存在则平滑更新凭据与字段，新账号则自动入池；
  - 导入完成后自动异步触发 `AccountScheduler.refreshCredits(acc)`，即时拉取上游可用积分并记录变动流水。
- **Web 控制台导入模态框与快捷操作**：
  - 在顶栏快捷操作区与账号管理卡片标题栏均新增「📥 导入账号」按钮；
  - 新增 `#importAccountModal` 导入弹窗，支持直接粘贴原始 JSON 文本，提供自定义备注输入与即时状态反馈；
  - **智能括号补全与健壮 JSON 容错解析 (`robustParseJson`)**：前后端双层集成基于括号栈的容错解析算法，自动识别并补全用户复制粘贴时遗漏的外层花括号或结尾中括号（如仅复制到 `"accounts": [{...` 缺少 `}]`），彻底杜绝 `JSON.parse: end of data when ',' or ']' was expected` 的格式解析报错。

---

## [2.179.0-gw.16] - 2026-11-14

### 会话粘性账号复用 (Sticky Session) · 严格对齐官方 CLI 时间常数与上游 Prompt Cache 保活
- **官方 CLI 常量与时间基准严格溯源 (Rule 0 & Rule 2)**：
  - 依据官方 CLI `package/dist/codebuddy-headless.js` 真实实现引入三个核心常数：
    - `CLI_COMPLETED_TASK_TTL_MS = 3e5` (300,000 ms = 5 分钟)：会话空闲保活超时时间（Idle TTL）。官方 CLI 任务及会话闲置的 TTL 常量，同时完美对齐 Anthropic Claude 3.5/3.7 Sonnet 与 OpenAI 官方 Prompt Caching 的 5 分钟保留窗口。在 5 分钟内同一会话的连续调用优先调度至同一账号，极大提升 Prompt Cache 命中率并大幅降低首字延迟与计算开销；
    - `CLI_CLEANUP_INTERVAL_MS = 6e4` (60,000 ms = 1 分钟)：垃圾回收与过期会话定期扫描周期。启动时调用 `.unref()`，对齐官方 CLI 避免定时器阻塞进程退出；
    - `CLI_PROMPT_TIMEOUT_MS = 18e5` (1,800,000 ms = 30 分钟)：会话绝对最大存活期（Max Lifetime）。对齐官方 CLI `DEFAULT_RUN_TIMEOUT_MS` 与 `ACCUMULATOR_TTL_MS`，防止长期僵尸连接或超长会话无限期锁定单一账号，到期自动释放以便账号池负载均衡。
- **全方位会话特征提取引擎 (`extractSessionKey`)**：
  - 统一并重构 `src/core/scheduler.mjs` 中的会话提取引擎，供 OpenAI 及 Anthropic 双协议适配器复用：
    1. **显式请求头优先**：支持 `x-session-id`, `x-conversation-id`, `session-id`, `conversation-id`, `x-chat-id`, `anthropic-conversation-id`；
    2. **显式载荷字段**：支持 OpenAI 官方规范 `payload.user`、`payload.session_id`、`payload.conversation_id` 与 Anthropic 官方规范 `payload.metadata.user_id` / `payload.metadata.session_id`；
    3. **稳定多轮对话特征指纹 (Conversation Fingerprint)**：针对未传显式 ID 的客户端（如 Cursor、Cline、Continue、NextChat、LibreChat 等），基于 System Prompt 与首条 User Message 计算稳定 MD5 哈希，彻底解决旧实现因后续轮次消息增长导致指纹突变的问题，确保多轮对话全程稳定路由至同一账号；
    4. **单次无状态调用兜底**：生成随机 UUID v7，保障一次性调用独立参与负载均衡。
- **智能调度与故障自愈重绑**：
  - 在复用账号前增加全流程健康检查（状态健康、未处于全局或单模型冷却期、未超在途并发上限、区域允许）；
  - 若绑定账号受限，自动解绑并平滑回落至账号池选号，并在请求重试或故障转移时自动为会话绑定新的可用账号；
  - 适配器在遇到上游限流或额度耗尽（429 / 6003 / 402）时，自动触发会话解绑与重选。
- **Web 控制台配置与可视化监控**：
  - 在「调度与路由策略」中新增「会话粘性账号复用 (Sticky Session)」卡片，支持开关即时热切换与保活超时配置（默认 300 秒，标注官方 CLI 依据）；
  - 提供「🧹 清空会话绑定」一键清理操作与 `POST /api/sessions/clear` 运维接口；
  - 在控制台概览顶栏与设置面板实时呈现当前活跃会话数量（`活跃会话: N`），与首页 KPI 看板的「缓存命中率」形成闭环联动。

---

## [2.179.0-gw.15] - 2026-11-14

### Web 控制台架构重构 · 服务端零构建组件化拆分 (Zero-Build Modular Architecture)
- **架构方案 B 正式落地（服务端自动拼装组件化）**：
  - 将原先近 5,000 行的臃肿单文件 `src/web/public/index.html` 彻底解耦，按功能职责模块化拆分为 HTML 纯骨架、3 个独立 CSS 样式文件与 7 个核心业务 JS 模块；
  - **CSS 模块切分**（`src/web/public/styles/`）：
    - `theme.css`：色彩变量、明暗主题与全局重置；
    - `layout.css`：App Shell、响应式侧边栏与内容视口网格；
    - `components.css`：Buttons、Cards、KPI 统计看板、Table、Badges、Switch 及各类模态弹窗。
  - **JavaScript 模块解耦**（`src/web/public/scripts/`）：
    - `core.js`：全局状态、安全剪贴板复制、客户端鉴权拦截器、登录弹窗与基础转义工具；
    - `navigation.js`：路由切换、多客户端接入指南 Tab 切换与主题切换；
    - `overview.js`：看板指标轮询加载与统计容量裁剪；
    - `accounts.js`：多账号池管理、OAuth 授权、全员签到、积分流水监控留痕与模型解密锁定；
    - `models.js`：模型矩阵展示、搜索筛选、黑名单规则编排与官方在线单价校验；
    - `settings.js`：核心策略、多 API Key 管理、降级链编排与思考/提示词/数据用途声明策略；
    - `logs.js`：SQLite 数据库多维检索、分页、日期筛选与请求上下文明文展开。
- **样式与暗黑主题异常修复**：
  - 修复骨架文件中重复嵌套的 <style> 与 </head> 标记，剔除 components.css 尾部冗余 </style>，恢复浏览器标准 CSS 解析流；
  - 全面精简主题架构，移除冗余亮色模式与切换按钮，全站锁定纯正沉浸式暗黑科技主题；
  - 启动时自动清理历史浏览器 localStorage 中残留的 light 键值，html/body 默认底色固定为 #090d16，消除任何闪烁与对比度错位。
- **服务端零构建自动内联拼装 (Zero-Build Inlining)**：
  - 在 `src/web/routes.mjs` 中实现 `renderDashboardTemplate()` 引擎，在运行时利用正则解析 `<!-- @include "..." -->` 自动合成单页响应；
  - **兼具两大架构优势**：源码保持高度解耦、职责单一与极高可读性（每个文件在 50KB 以内），同时运行时 100% 保持「零 npm 依赖、零前端构建工具链、单请求极速加载、天然免疫浏览器缓存版本错位」的轻量特性。

---

## [2.179.0-gw.14] - 2026-11-14

### 多 API Key 独立密钥池管理与独占单行卡片展示 (Multi-Key Management & Standalone UI Card)
- **多 API Key 独立密钥池与权限管控**：
  - 在 src/config.mjs 中新增 getApiKeys()、isValidApiKey(token)、addApiKey({ key, note })、updateApiKey(id, { note, enabled, key }) 与 removeApiKey(id)；
  - 采用结构化数组存储密钥实体 Array<{ id, key, note, createdAt, enabled }>，支持对每个 Key 单独设定备注用途与启停状态；
  - **向后完全兼容**：自动将既有 config.apiKey 平滑纳管为默认主密钥，并在密钥更新时始终保持 config.apiKey 同步至首个有效密钥，旧有调用与引导文档完全无缝衔接；
  - **工业级常量时间比对**：在 src/server.mjs 中全面切换为 isValidApiKey(token)，防御 Timing Side-Channel 时序侧信道反推攻击；
  - **REST API 端点**：在 src/web/routes.mjs 中新增 GET /api/keys、POST /api/keys、POST /api/keys/update 与 POST /api/keys/delete 完整接口。
- **Web 控制台 API Key 单独一行独立卡片展示**：
  - 对齐「日志」与「数据用途声明」独立宽卡片视觉风格，将 API Key 密钥管理从双列网格中移出，改设为全宽单行卡片 (card 单独一行显示)；
  - 动态渲染多密钥列表表格：展示「备注/用途」、「API Key（脱敏掩码 + 👁️ 明文切换 + 📋 一键复制）」、「创建时间」、「状态（点击即时切换启用/禁用）」与「操作（✏️ 修改备注 / 🗑️ 删除）」；
  - 设有保底防护逻辑，禁止删除系统最后一个有效密钥，防止误操作导致网关鉴权锁死；
  - 提供「➕ 添加新密钥」弹窗与「🔄 快速生成并添加」功能；
- **全局剪贴板复制兼容性修复 (局域网 HTTP 安全上下文适配)**：
  - 针对在内网非 HTTPS 环境（如 http://192.168.1.201:8317）下浏览器 navigator.clipboard 缺失导致点击复制无响应的痛点；
  - 实现通用 copyToClipboard() 工具函数，引入 isSecureContext 判断、动态 textarea + document.execCommand('copy') 优雅降级回退以及系统级弹窗兜底机制；
  - 全面覆盖 API Key、控制台生效密码、接入配置代码、原始 JSON、模型 ID、请求上下文及 OAuth 链接等全部复制按钮。
- **Web 控制台访问密码当前生效口令明文回显与一键复制**：
  - 在「Web 控制台访问密码保护」卡片中展示当前生效密码，支持 👁️ 切换明文/掩码，并支持 📋 一键复制，提示当前为专属密码或回落主密钥。

---

## [2.179.0-gw.13] - 2026-11-14

### Web 控制台 API Key 管理与访问密码明文回显 (Console Key Management & Password Reveal)
- **Web 控制台 API Key 可视化管理卡片**：
  - 在 src/web/public/index.html 设置页增加「网关 API Key 密钥管理」卡片；
  - 支持查看当前 API Key、明密文一键切换（👁️）、一键复制到剪贴板（📋）；
  - 支持直接修改并保存自定义 Key，或点击「🔄 随机生成」一键换发高强度 sk-cb-<48位随机hex> 密钥；
  - 密钥变更后自动更新 localStorage 鉴权上下文，防止管理会话意外中断；
- **Web 控制台访问密码当前口令明文回显**：
  - 在「Web 控制台访问密码保护」卡片中增加「当前生效密码」展示模块；
  - 支持明文/掩码一键切换查看，并展示生效状态（专属独立密码 或 默认回落使用 apiKey），支持一键快速复制；
- **REST API 端点联动升级**：
  - 在 src/web/routes.mjs 的 POST /api/settings 中增加 generateNewApiKey 支持并回传最新的 webAuthToken。

---

## [2.179.0-gw.12] - 2026-11-14

### 公网安全加固与 API Key 自动生成机制 (Security Hardening)
- **API Key 未配置时自动生成与落盘自愈**：
  - 在 src/config.mjs 增加 ensureApiKey() 与 generateRandomApiKey()；
  - 若 config.json 中缺失 apiKey 或配置为空字符串，网关启动或保存时自动生成符合 OpenAI 工业标准的高强度密钥（sk-cb-<48位随机hex>）并立即持久化写入配置文件；
- **API 强制鉴权与常量时间比对 (Anti-Timing Attack)**：
  - 在 src/server.mjs 修复 API 鉴权拦截判断：由原先 if (config.apiKey && token !== config.apiKey) 彻底升级为 if (!config.apiKey || !safeCompareTokens(token, config.apiKey))，杜绝公网未配 Key 时的全网裸奔调用漏洞；
  - 引入 safeCompareTokens()，采用 crypto.timingSafeEqual 进行严格常量时间安全比对，彻底消除 Timing Side-Channel 攻击隐患；
- **Web 控制台登录凭据回传防护**：
  - 在 src/web/routes.mjs 中修复 POST /api/auth/login：在 webAuthEnabled === false 时不再向客户端泄露服务器底层的 apiKey 或内部密码。

---

## [2.179.0-gw.11] - 2026-11-14

### 官方协议与环境指纹对齐 (Fingerprint Alignment)
- **出站 Stainless SDK 指纹环境固定为 Windows x64**：
  - 将出站请求头 x-stainless-os 统一固定为 'Windows'，x-stainless-arch 统一固定为 'x64'；
  - **背景与原因**：官方 CLI 抓包（.capture/cmp/cli_2.179.0.log）在桌面端标准开发环境即为 Windows x64。当网关部署在 Linux 局域网服务器（如 192.168.1.201）或容器环境时，统一模拟桌面端开发者环境指纹，避免出站暴露 Linux 服务器环境特征；
  - **涉及文件**：src/upstream/headers.mjs。

---

## [2.179.0-gw.10] - 2026-11-14

### 数据用途声明与出站 X-Private-Data 动态策略 (Private Data Declaration)
- **三套出站身份官方默认自动判定 (`auto`)**：
  - 基于官方 CLI `package/dist/codebuddy-headless.js`（`resolveModelOptimizationEnabled` 与 `isEnterpriseEditionAccount`）源码逻辑全面对齐：
    1. **国内个人号**：发行版默认允许参与模型优化 (`productDefaultEnabled=true`)，发送 `'X-Private-Data': 'false'`；
    2. **国际版账号**：国际发行版默认关闭模型优化 (`DefaultModelOptimizationOff=true`)，发送 `'X-Private-Data': 'true'`；
    3. **企业版账号**：企业数据默认私有隔离 (`isEnterprise=true`)，发送 `'X-Private-Data': 'true'`。
- **无条件覆盖支持 (`true` / `false`)**：
  - 允许管理员在 Web 控制台或 API 无条件覆盖：设置为 `true` 时恒定声明私有数据；设置为 `false` 时声明允许参与模型优化。
  - 明确仅影响出站 `X-Private-Data` 请求头，不影响请求体上下文与对话内容。
- **Web 控制台卡片与 API 闭环支持**：
  - 在 [`src/web/public/index.html`](file:///d:/AI/tencent-ai-codebuddy-code/src/web/public/index.html) 设置页增加「数据用途声明」配置卡片，完美还原复刻控制台布局、黄色警示文案与副标题动态联动；
  - 在 [`src/upstream/headers.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/upstream/headers.mjs) 实现 `resolvePrivateDataHeader(acc)` 动态注入；
  - 在 [`src/web/routes.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/web/routes.mjs) 的 `GET /api/settings` 与 `POST /api/settings` 补充 `privateDataPolicy` 读写与落盘。

---

## [2.179.0-gw.9] - 2026-11-14

### 日志采集策略与请求上下文排查归档 (Logging Policy & Context Tracing)
- **调用来源采集开关 (`requestClientInfo`)**：
  - 支持配置是否在运行日志中采集并记录客户端 IP (`x-forwarded-for` / `remoteAddress`) 与 `User-Agent`，默认开启。
  - 关闭时，日志元数据与看板完全剔除客户端来源信息，保护调用方隐私；改动即时生效，无需重启。
- **请求上下文明文归档开关 (`requestArchiveContext`)**：
  - 支持临时开启请求上下文（`system` / `messages` 原文）归档，默认关闭（保护用户提示词与敏感数据）。
  - 在 [`src/upstream/payload.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/upstream/payload.mjs) 实现 `extractArchiveContext()`，自动针对大图 Base64 进行安全摘要，防止日志与数据库体积膨胀。
  - 开启后，在「运行日志」页面可点击任意带有上下文的请求行（或通过「🔍 查看请求上下文」徽章）一键展开/收起查看本轮请求的完整提示词与多轮消息，并支持一键复制 JSON 原文，便于排查上游拒绝与报错原因。
- **Web 控制台与 API 闭环支持**：
  - 在 [`src/web/public/index.html`](file:///d:/AI/tencent-ai-codebuddy-code/src/web/public/index.html) 设置页增加「日志」配置卡片，对齐官方控制台布局与交互体验。
  - 在 [`src/web/routes.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/web/routes.mjs) 的 `GET /api/settings` 与 `POST /api/settings` 补充 `loggingPolicy`（`requestClientInfo` / `requestArchiveContext`）读写与落盘。

---

## [2.179.0-gw.8] - 2026-11-12

### 系统提示词模式重写引擎与自定义提示词挂载 (System Prompt Policy & Custom Persona)
- **网关系统提示词重写策略引擎 (passthrough / custom / append)**：
  - **默认策略对齐**：系统提示词模式默认设为 `passthrough`（完全透传客户端原始 system），保证冷启动开箱即用时不干涉客户端自定义行为；用户可随时在 Web 控制台切换为 `custom` 或 `append`。
  - **custom 模式 (网关自有提示词，避免指纹误报)**：网关剔除客户端原始上下文中的所有 `system` / `developer` 提示词，将网关自有配置的提示词作为首条 `system` 消息注入头部，防止官方端点对客户端指纹产生误报。
  - **append 模式 (客户端与网关并用)**：保留客户端前置的 `system` / `developer` 消息，并在紧随其后追加网关提示词。
  - **passthrough 模式 (透传)**：严格透传客户端传入的原始上下文消息列表，不做重写。
  - 核心逻辑实现在 [`src/upstream/payload.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/upstream/payload.mjs) 的 `applySystemPromptPolicy()`，并在 OpenAI（[`src/adapters/openai.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/adapters/openai.mjs)）与 Claude（[`src/adapters/anthropic.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/adapters/anthropic.mjs)）适配器中统一生效。
- **自定义提示词文件挂载与跨平台路径兜底**：
  - 在 [`src/config.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/config.mjs) 实现 `loadSystemPromptContent(filePath)`，支持挂载指定外部提示词文件（如 `D:\AI\dsh-purge\v1.1.40_prompt.txt`）。
  - 支持跨平台部署自适应回退：在 Linux 宿主机上无法访问 Windows 绝对路径盘符时，自动以文件名（`path.basename`）回退检测项目根目录同名文件（`./v1.1.40_prompt.txt`）；文件不存在时优雅回退至官方默认小码酱内置设定。
- **Web 控制台配置卡片与 REST API 支持**：
  - 在 [`src/web/public/index.html`](file:///d:/AI/tencent-ai-codebuddy-code/src/web/public/index.html) 新增「系统提示词策略」卡片，提供模式下拉框（`custom` / `append` / `passthrough`）与提示词文件路径输入框，支持一键保存热更新并在前端徽章联动展示。
  - **提示词文件路径联动显示与多端路径提示优化**：仅在选择 `custom`（网关自有提示词）或 `append`（并用）模式时才动态展开显示「提示词文件路径」选项；说明文案明确展示 Windows 路径示例（如 `D:\AI\dsh-purge\v1.1.40_prompt.txt`）、Linux 部署路径示例（如 `/home/node_code/codebuddy-code/v1.1.40_prompt.txt`，同时前端结合 `rootDir` 动态自适应）及相对路径写法（`v1.1.40_prompt.txt`），指引清晰明了。
  - 在 [`src/web/routes.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/web/routes.mjs) 的 `GET /api/settings` 与 `POST /api/settings` 增加 `promptPolicy` 读写接口并即时持久化到 `config.json`。

---

## [2.179.0-gw.7] - 2026-11-12

### 架构健壮性与高并发全方位优化 (Robustness, Concurrency & Performance Hardening)
- **非流式请求并发计数泄漏兜底 (高危修复)**：
  - 在 [`src/adapters/openai.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/adapters/openai.mjs) 与 [`src/adapters/anthropic.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/adapters/anthropic.mjs) 的非流式处理分支中引入 `try ... finally` 闭环。
  - 彻底解决若非流式请求读取期间发生网络中断、下游取消或 JSON 解析异常导致 `activeAcc.inFlight` 未能扣减与 `lifecycle` 未能释放的严重漏洞，杜绝账号并发数虚高被调度器永久锁死的隐患。
- **HTTP 请求体防 OOM 保护与流错误防御**：
  - 在 [`src/server.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/server.mjs) 封装统一的 `readRequestBody` 流读取器，施加 50MB 保护上限，提供 `Content-Length` 前置预检与动态接收字节流上限拦截，防止超大 Prompt 或大量 base64 图片导致 V8 堆内存溢出崩溃。
  - 增加底层的 `req.on('error')` 监听，防客户端 Socket 异常引发未捕获错误。
- **SQLite 开启 WAL 模式与同步优化 (I/O 吞吐提升 10x+)**：
  - 在 [`src/core/database.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/core/database.mjs) 初始化时执行 `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`，实现读写并发完全不互斥，消除高并发日志写入时的磁盘锁阻塞。
  - 在 `LogDatabaseEngine` 增加 `close()` 方法，并在优雅停机钩子（`flushAllOnShutdown`）中执行 WAL checkpoint 截断合并与安全关库。
- **上游网络调用全局超时控制 (AbortSignal 注入)**：
  - 为 [`src/adapters/tools.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/adapters/tools.mjs)（联网检索与网页抓取 15s）及 [`src/core/scheduler.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/core/scheduler.mjs)（积分查询、Token 换发、每日签到、配额明细 10s）注入 `signal: AbortSignal.timeout(...)`，杜绝异常网络下协程无限挂死。
  - 服务端检索工具接口优选国内健康账号（`region: 'cn'`），降低跨域延迟。
- **模型矩阵按区域去重拉取与日志校准**：
  - 在 [`src/upstream/models.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/upstream/models.mjs) 增加 `fetchedRegions` 跟踪，同区域由首个可用账号成功拉取后直接跳过后续同区账号，消除启动与定时同步时的冗余网络往返，真实反映区域模型数量。
- **定时任务错峰平滑化 (Jitter 调度)**：
  - 在 [`src/server.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/server.mjs) 的 5 分钟积分刷新任务中引入 300ms 错峰间隔，杜绝所有账号瞬间并发向上游计费接口发送请求。
- **SSE 看门狗心跳定时器自销毁加固**：
  - 在 [`src/upstream/stream-guard.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/upstream/stream-guard.mjs) 的保活心跳定时器中，当检测到客户端连接已结束或销毁时立即执行 `clearInterval(timer)` 自行清理。

---

## [2.179.0-gw.6] - 2026-11-11

### 体验优化与日志统计细化 (UI & Logging Clarity)
- **优化上游模型同步日志展示与统计口径**：
  - 修复以往在日志中统计多账号累加总次数（如国内版 3 账号合计 102、国际版 3 账号合计 84）容易让人误解为单个区域存在百款模型的问题。
  - 重构为按区域去重后的真实可用模型数与账号池维度输出：`全局去重共 54 款；国内版: 34 款 [3 账号]，国际版: 28 款 [3 账号]，两区通用: 8 款`，统计口径透明精准。
  - 涉及文件：[`src/upstream/models.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/upstream/models.mjs)

---

## [2.179.0-gw.5] - 2026-11-11

### 缺陷修复与跨区域容灾保持 (Fixes & Multi-Region Resilience)
- **修复跨区域模型同步导致国际版模型丢失与同步超时卡死问题**：
  - **跨区域快照按需增量保留**：在 `fetchDetailedModels()` 中增加区域级模型快照合并机制。当单区域因网络/DNS/凭据原因未能成功拉取时，自动保留本地已有快照或官方内置（`package/product.json`）中该区域的模型，杜绝以往「只要一个区域未返回，全量 `product.json` 覆盖即丢失国际版模型」的逻辑漏洞。
  - **官方内置快照多级兜底**：`loadModelsFromProductJson()` 增加多级回退，根目录无模型时自动读取 `package/product.json` 官方模型基准（含 22 款国际模型），保证冷启动零配置即具备完整模型列表。
  - **网络请求超时保护**：上游端点 `/v3/config` 拉取增加 `AbortSignal.timeout(5000)`，防止异常网络环境下长时间挂起导致前端控制台「正在同步...」卡死。
  - **局域网 DNS / 域名解析加固**：排查并解决局域网内因 DNS 阻断导致的 `www.codebuddy.ai` 解析异常，确保双区域全池账号秒级并发通信。
  - 涉及文件：[`src/upstream/models.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/upstream/models.mjs)

---

## [2.179.0-gw.4] - 2026-11-11

### 模型能力与档位界面全面重构与视觉规范对齐 (UI Redesign & Visual Standards)
- **5 维紧凑型筛选工具栏与指示器**：
  - 搜索栏支持模型 ID、名称、中文/英文描述、厂商综合检索。
  - 筛选下拉框完备支持：
    - `全区域`（全区域、国内版 CN、国际版 Global）。
    - `全能力`（全能力、支持工具调用、支持视觉、支持思考、默认模型）。
    - `全部档位`（全部档位、可关闭思考、low、medium、high、xhigh、max）。
    - `全部价格`（全部价格、有折扣 / 限时免费、限时免费、打折 (非免费)）。
    - `排序方案`（上游默认顺序、积分倍率 低 → 高、上下文长度 大 → 小、最大输出 大 → 小、模型 ID A → Z）。
  - 工具栏右侧集成实时筛选模型计数与一键「重置」按钮。
- **8 列表格视觉规范对齐**：
  1. `模型`：完整带区域标识的模型 ID（如 `cn:fast-model`）、中文名称，特性徽章（`默认` 翠绿、`订阅优先` 暖黄、`工具` 灰暗、`视觉` 灰暗、`思考常开` 暖黄）。
  2. `积分倍率`：格式化倍率数字，限时免费胶囊（`0x 限时免费 x0.00`），夜间折扣胶囊（`x0.11 夜间折扣`、`0.50x 夜间折扣 x0.99`）。
  3. `网关档位`：轻量下拉框，动态映射该模型所支持的全部思考档位（含 `off`），点击变更即时调用 `POST /api/models/thinking-level` 并本地生效。
  4. `上游默认`：绿色圆角药丸标签，清晰展示官方声明的基准思考档位（如 `medium`、`high`、`max`）。
  5. `支持的思考档位`：固定档说明（`固定档 · 默认 medium`）与支持档位徽章组合（`low`、`high`、`max`、`off (可关)`）。
  6. `上下文长度`：格式化为 `K` 单位（如 `300K`、`960K`、`1000K`）。
  7. `最大输出`：格式化为 `K` 单位（如 `48K`、`64K`、`128K`、`131K`）。
  8. `下游可见`：`[✓] 可见` 复选框，勾选直接与黑名单联动（未勾选时行透明度降低至 0.45，下游 `/v1/models` 即时剔除）。
- 涉及文件：[`src/web/public/index.html`](file:///d:/AI/tencent-ai-codebuddy-code/src/web/public/index.html)

---

## [2.179.0-gw.3] - 2026-11-10

### 功能增强与思考档位策略 (Features & Thinking Policy Alignment)
- **严格遵循「客户端 > 上游默认 > 网关默认」档位决议链路**：
  - 对齐官方 CLI 实测源码（`codebuddy-headless.js`）：`normalizeReasoningEffort(ep) ?? normalizeReasoningEffort(el.reasoning?.defaultEffort) ?? normalizeReasoningEffort(el.reasoning?.effort)`。
  - 客户端显式指定的档位最优先；客户端未指定档位时，优先采用各模型在 `product.json` 官方声明的 `defaultEffort` / `effort` 上游默认档（如 `glm-5.3` 默认 `max`、`minimax-m2.7` 默认 `medium`、`deepseek-v4.1-flash` 默认 `high`）；仅在上游未标明默认档时才回落到网关配置的全局默认档兜底。
  - 控制台「模型与档位」表格下拉列表动态标注各模型的上游基准（如 `默认 (上游: max)`），清晰展示决议基准。
  - 涉及文件：[`src/upstream/payload.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/upstream/payload.mjs)、[`src/web/public/index.html`](file:///d:/AI/tencent-ai-codebuddy-code/src/web/public/index.html)
- **网关思考档位策略配置 (Thinking Policy)**：
  - 在网关核心配置与内存状态中引入 `thinkingPolicy`（含 `enabled` 开关、`defaultLevel` 默认网关档位、`overrideMode` 覆盖策略模式以及 `modelLevels` 逐模型覆盖矩阵）。
  - 支持三种档位改写优先级模式：
    - `client_first`（客户端优先）：客户端没传档位时才补「网关档位」，客户端指定的值优先保留。
    - `gateway_level_only`（网关优先 · 只覆盖档位）：客户端传的档位一律改写为「网关档位」，但尊重客户端「关闭思考」指令。
    - `gateway_override_all`（网关优先 · 档位与开关一起覆盖）：连客户端「关闭思考」也改写成开启 + 「网关档位」。
  - 涉及文件：[`src/config.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/config.mjs)、[`src/upstream/payload.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/upstream/payload.mjs)
- **多模型思考档位平滑自适应 (Clamping & Fallback)**：
  - 建立官方 EXTENDED_THINKING_LEVELS 档位梯队权重：`minimal (1) < low (2) < medium (3) < high (4) < xhigh (5) < max (6)`。
  - 实现 `clampThinkingLevel` 规整函数：当指定档位超出模型支持能力时，自动平滑落到不高于它的最高支持档；若低于模型最低支持档，自动使用模型最低支持档兜底。
  - 遵循模型 `canDisableThinking` 与 `onlyReasoning` 元数据，可关思考的模型支持 `off`（上游映射为 `none`）；强制思考的模型不可关闭，平滑回退至最低档。
  - 不支持推理的模型严格按官方 `ReasoningEffortSupportRule` 剥离全部推理参数（`reasoning_effort` / `reasoning_summary` / `verbosity`），杜绝上游 400 异常。
  - 涉及文件：[`src/upstream/payload.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/upstream/payload.mjs)
- **Web 控制台「思考档位」策略卡片与「模型与档位」管理**：
  - 在「策略设置」页面新增「思考档位」策略卡片，支持开启/关闭总开关、选择默认网关档位以及单选切换 3 种改写优先级模式，UI 样式与说明文字 100% 像素级对齐。
  - 侧边栏原「模型管理」导航升级为「模型与档位」。
  - 在模型矩阵表格新增「网关档位」列，根据每个模型在 `product.json` 中声明的 `supportedEfforts` 与可关闭属性动态生成下拉选择框（`默认 (跟随网关)`、`off (关闭思考)` 与具体支持档位），用户切换即时热生效并自动持久化。
  - 涉及文件：[`src/web/public/index.html`](file:///d:/AI/tencent-ai-codebuddy-code/src/web/public/index.html)、[`src/web/routes.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/web/routes.mjs)
- **REST 运维接口扩展**：
  - `GET /api/settings` 与 `POST /api/settings` 扩展支持 `thinkingPolicy` 的获取与热更新持久化。
  - 新增 `POST /api/models/thinking-level` 接口，支持轻量级单模型网关档位原子设置。
  - 涉及文件：[`src/web/routes.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/web/routes.mjs)
- **验证与测试 (Verification)**：
  - 编写并执行自动化测试套件：验证 7 大典型场景（未启用策略默认行为、`client_first`、`gateway_level_only`、`gateway_override_all`、跨档向下 Clamp、强制思考模型兜底、不支持推理模型整体剥离），全部断言 100% 通过。
  - 回归测试：官方 CLI 2.179.0 流式守卫（Stream Guard）7 种空流及超时场景 100% 保持通过。

---

## [2.179.0-gw.2] - 2026-11-10

### 缺陷修复与体验优化 (Fixes & UI Enhancement)
- **运行日志中 [CREDIT_MONITOR] 标签截断修复**：
  - 修复运行日志看板中 `.log-cat` 标签列固定宽度 80px 导致长度为 16 字符的 `[CREDIT_MONITOR]` 显示为 `[CREDIT_MONITO` 缺失右括号与末字符的问题。
  - 将 `.log-cat` 宽度调整为 `min-width: 130px; flex-shrink: 0;`，确保所有分类标签完整展示，文字列对齐且杜绝内容重叠。
- **运行日志类别快捷筛选与色彩高亮**：
  - 在「实时运行日志与诊断」筛选栏中新增 `CREDIT 监控` 快捷筛选按钮，支持在日志看板上一键过滤只看积分变动流水。
  - 改进类别/级别切换逻辑，重构按钮状态机；切换分类时实时向后端拉取目标分类全量匹配日志。
  - 为各类分类标签配置专属主题色高亮，其中 `[CREDIT_MONITOR]` 赋予翡翠绿高亮（`#34d399`），并在日志消息体中自动对正负积分变动值进行高亮着色（`+` 绿 / `-` 红）。
  - 涉及文件：[`src/web/public/index.html`](file:///d:/AI/tencent-ai-codebuddy-code/src/web/public/index.html)

---

## [2.179.0-gw.1] - 2026-11-10

### 官方协议对齐 (Protocol Alignment)
- **Stainless SDK 指纹升级**：
  - 依据官方 CLI 2.179.0 抓包实测，`x-stainless-package-version` 由旧版的 `6.25.0` 全面升级至 **`7.39.0`**。
  - 补齐官方运行环境指纹头：`x-stainless-arch`、`x-stainless-os`、`x-stainless-lang: js`、`x-stainless-runtime: node`、`x-stainless-runtime-version` 及 `x-stainless-retry-count: 0`。
  - 涉及文件：[`src/upstream/headers.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/upstream/headers.mjs)
- **四联 ID 生成拓扑两两解耦**：
  - 严格对齐 CLI 2.179.0 实测规律：`X-Request-ID` 与 `X-Conversation-Message-ID` 同值取单次消息 ID；`X-Conversation-Request-ID` 与 `X-Root-Request-ID` 同值取整轮交互根会话请求 ID。
  - 两组 ID 时间戳前缀一致（同属毫秒级生成），后半段随机数独立，完全对齐官方链路行为。
  - 涉及文件：[`src/upstream/headers.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/upstream/headers.mjs)
- **全链路追踪双协议补全**：
  - 补全 W3C 分布式链路追踪头：`traceparent`（`00-<traceId>-<spanId>-01`）与 `baggage`（绑定 `session_id` 与 `conversation_request_id`）。
  - 补全 Zipkin B3 链路追踪头：`b3`、`X-B3-TraceId`、`X-B3-SpanId`、`X-B3-ParentSpanId`、`X-B3-Sampled: 1` 与 `X-Trace-ID`。
  - 涉及文件：[`src/upstream/headers.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/upstream/headers.mjs)
- **请求体默认参数与上下文注入**：
  - 导出并应用官方实测输出上限常量 `DEFAULT_MAX_TOKENS = 128000`，客户端未显式传递时自动兜底。
  - 注入官方上下文元数据 `extra_vars: { initiator: "user", interactionType: "prompt" }`，支持客户端自定义透传。
  - 涉及文件：[`src/upstream/payload.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/upstream/payload.mjs)、[`src/adapters/openai.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/adapters/openai.mjs)、[`src/adapters/anthropic.mjs`](file:///d:/AI/tencent-ai-codebuddy-code/src/adapters/anthropic.mjs)

### 验证与测试 (Verification)
- 抓包比对（`.capture/cmp/compare_2.179.0.cjs`）：应用层 38 个请求头实现 37 个共有头 100% 对齐（唯一差异为大包 gzip），0 冗余多余头。
- 回归测试（`.capture/test-cli-alignment.mjs`）：Stream Guard 7 种场景分类与超时常量 100% 校验通过。

---

## [2.177.1-gw.3] - 2026-11-08

### 功能增强 (Features)
- **账号积分变动实时监控与历史留痕审计**：
  - 在账号积分刷新（`refreshCredits`）逻辑中引入差值比对引擎，从官方上游获取真实余额时自动比对，有增减即刻留痕并生成轨迹（`余额 A → B`）。
  - 在内置 SQLite 引擎（`logs.db`）中创建 `credit_history` 结构化数据表及索引，持久化记录变动时间、账号备注名、增减差值、变动后余额及流转说明。
  - 提供 `/api/credits/history` 与 `/api/credits/history/clear` 运维接口，支持按条数分页过滤及触发与上游实时同步。
  - 控制台「账号运维」页无缝对齐增加「积分历史」可视化卡片，支持最近条数筛选、正负变动高亮及变动说明展示。
  - 涉及文件：`src/core/database.mjs`、`src/core/scheduler.mjs`、`src/web/public/index.html`、`src/web/routes.mjs`

### 基础设施与安全 (Infrastructure & Security)
- **全链路数据安全持久化与 backups/ 独立备份隔离**：
  - 建立独立 `backups/` 目录，统一存放 `accounts.json`、`config.json`、`stats.json` 和 `pricing.json` 的镜像副本，启动时自动归档历史根目录遗留文件。
  - 在 `writeJsonWithBackup` 中引入“写临时文件 + renameSync”原子替换逻辑，杜绝断电或强杀导致主文件损坏。
  - 重写 `loadJsonWithBackup` 支持“主文件 -> backups/ 独立备份 -> legacy 根目录备份”三级容灾恢复，保障数据自愈。
  - 在 `.gitignore` 与 `AGENTS.md` 中强制排除 `backups/`，杜绝含明文凭据备份入库。
  - 涉及文件：`src/config.mjs`、`src/core/metrics.mjs`、`src/core/pricing.mjs`

---

## [2.177.1-gw.2] - 2026-11-08

### 部署与工具 (Tooling & Deployment)
- **局域网一键打包与 SFTP 安全部署发布流水线**：
  - `pack.ps1` 打包工具改用 POSIX 正斜杠相对路径，彻底解决 Windows 打包后在 Linux/Armbian 解压路径扁平化的兼容性问题。
  - 编写 `tools/deploy_lan.py` 自动化部署脚本，支持远程目录快照备份、SFTP 上传、独立暂存区解压、保留既有凭据与数据库、systemctl 重启与探活校验。
  - 依据《AGENTS.md》将 `pack.ps1` 与 `tools/` 设为仅本地保留，安全移出公开 Git 跟踪。

---

## [2.177.1-gw.1] - 2026-11-07

### 官方协议与多区域 (Multi-Region & Upstream Protocol)
- **多区域上游路由支持（国内版 + 国际版）**：
  - 支持国内版（`copilot.tencent.com`）与国际版（`codebuddy.ai`）双区域端点，支持模型前缀区隔（`cn:<model>` / `intl:<model>`）与跨区自动隔离。
  - 国际版端点硬性校验 `messages[0].role === 'system'` 自动补齐空 system 占位。
  - 模型黑名单网关级硬拦截，防止禁用模型被直接调用或自动降级调用。
- **流式空流判定与看门狗状态机 (Stream Guard)**：
  - 实现官方 `createDeltaClassifier`：思考内容仅算存活（`hasContent`），正文/工具/拒答才算实质产出（`hasSubstantiveContent`）。
  - 空流细分为 `reasoning-only` 与 `no-token`，不将缺少 `finish_reason` 判为断流。
  - 超时参数严格对齐官方常量：首 Token 1200000ms、空流窗口 300000ms、finish 宽限 5000ms。
  - 客户端主动断连感知与账号 `inFlight` 计数自愈。
