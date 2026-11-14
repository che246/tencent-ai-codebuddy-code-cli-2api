# 更新日志 (Changelog)

本项目所有重要更新、协议对齐改动与修复均记录于此文件。

> **规范准则**：
> - 格式遵循 [Keep a Changelog](https://keepachangelog.com/) 规范。
> - 所有改动严格遵循《[AGENTS.md](file:///d:/AI/tencent-ai-codebuddy-code/AGENTS.md)》：**以官方 CodeBuddy CLI 端实现为唯一依据**，数值与行为可追溯。

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
