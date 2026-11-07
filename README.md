# Tencent CodeBuddy CLI 2API Gateway

基于腾讯云 **CodeBuddy Code (CLI 2.179.0)** 官方协议打造的纯模型层、多账号高并发代理网关。

支持将腾讯 CodeBuddy **国内版（copilot.tencent.com）与国际版（www.codebuddy.ai）** 账号统一转换为标准的 **OpenAI** 与 **Anthropic** 兼容 API，提供 100 万大上下文模型（如 `deepseek-v4.1-flash`、`hy4-preview` 等），并将 **Agent 工具调用执行权 100% 交还给下游客户端**（如 Cursor、Claude Code、Cline、Roo Code、NextChat 等）。

两版账号与模型互不相通：token 按签发域校验（国内 token 打国际版 chat 一律 401），模型集合也不同（国际版额外含 `gpt-6-astra`、`grok-4.7`、`gemini-3.8-flash` 等）。网关按账号 `region` 自动选择上游域名，并通过模型名前缀 `cn:` / `intl:` 显式区分两区模型，支持同一降级链内跨区编排。

---

## 🌟 核心特性

- **0 依赖轻量运行**：纯原生 Node.js 实现（需 Node.js 22+，使用内置 `node:sqlite` 持久化日志），剔除官方 CLI 中 200MB+ 的臃肿系统沙箱和本地执行文件，常驻内存仅 ~25MB，秒级启动。
- **双协议无缝兼容**：
  - **OpenAI 兼容**：`POST /v1/chat/completions`、`GET /v1/models`
  - **Anthropic 兼容**：`POST /v1/messages`、`POST /messages`（完美直连 Claude Code 官方命令行）
- **客户端 Agent 工具调用透传**：
  - 彻底关闭服务端的自动 Agent 工具执行；
  - 完整透传客户端声明的 `tools` 和 `tool_choice`；
  - 接收模型生成的 `tool_calls` 后立即单回合结单回传给客户端，由客户端在其本地环境执行后回传 `role: "tool"` 结果，形成标准闭环。
- **全套官方会话请求头族注入**：严格对齐官方 CLI 2.179.0 规范，生成 32 位无连字符 Hex 标识，补齐 `X-Request-ID`、`X-Conversation-Request-ID`、`X-Conversation-Message-ID`、`X-Conversation-ID`、`X-Session-ID`、`X-Agent-Intent: craft`、`X-Agent-Runtime: cli`、`X-IDE-*` 及 `X-Private-Data: false`，指纹 100% 吻合。
- **1 小时长效 Prompt 缓存 (`cache_retention: "long"`)**：完全对齐官方 Issue #53191 规范，默认下发 `'long'` 档位，将 Claude / DeepSeek 上游 Prompt 缓存拉长至 1 小时，显著节省计费积分。
- **请求体 Gzip 压缩传输 (`RequestBodyGzip`)**：当上下文文本较大时，自动以 Gzip 压缩并携带 `Content-Encoding: gzip` 发送至官方网关，上行流量骤减 70%~90%，大幅缩短长上下文 TTFB。
- **模型能力前置守卫与思考流映射**：自动剥离不支持工具/视觉模型的参数；在 Anthropic `/v1/messages` 协议中原生流式输出 `thinking_delta`，让 Claude Code / Cline 在终端实时展示思考过程。
- **网关侧支持指定全局账号与账号池轮转**：支持在网关控制台一键「设为指定」或在策略设置中选择全局优先账号；未指定时自动按 `least-inflight`（最小并发削峰，默认）、`round-robin`（严格顺序轮流）与 `credits`（最多积分优先）策略进行账号池负载均衡。
- **双区域账号池（国内版 + 国际版混跑）**：
  - 同一进程内可同时持有国内版与国际版账号，按账号 `region` 字段自动选择上游域名（`copilot.tencent.com` / `codebuddy.ai`），端点路径完全同构、逻辑零分叉；
  - token 按签发域隔离，跨区调用会被上游判 401，网关按区域锁定选号规避；
  - 国际版强制首条消息为 `system`（缺失返回 `400/11128`），由网关自动补齐，客户端无需感知；
  - 国际版账号体系无每日签到功能，签到巡检自动跳过并在日志中标注，不视为异常；
  - 模型矩阵按区域合并去重，`/v1/models` 为每个可用区域各输出一条带前缀条目（`cn:` / `intl:`），带前缀调用即锁定区域。
- **模型黑名单（Model Blacklist）**：
  - 支持精确名、区域前缀（`intl:gpt-6-astra`）、通配符（`intl:*`、`gpt-6-*`）三类规则；
  - 命中规则的模型**不会出现在 `/v1/models`**，客户端看不到也选不到；
  - 硬编码模型名直接调用 `/v1/chat/completions` 或 `/v1/messages` 会被 `403 model_blacklisted` 拒绝；
  - **自动降级链构建时同样剔除**——被屏蔽的模型不会被静默轮换调用；
  - 控制台提供复选框多选面板（支持筛选 / 全选 / 批量加入）、表格行内一键屏蔽/恢复、以及降级链中失效步骤的置灰标记。
- **流式稳定性加固 (`Stream Guard`)**：
  - 首字节超时（默认 30s）+ 静默看门狗（默认 90s）：只按**数据静默时长**判定断流，绝不按总耗时掐线，长回复不会被误杀；
  - SSE 心跳注释帧：定期向客户端补 `: keepalive`，防止中间层因空闲断开；
  - 客户端断开归因：区分「客户端主动取消」与「上游故障」，日志不再误报；
  - 上游断流且已有产出时，自动补一条 `finish_reason: length` 终态帧，让客户端知道是被截断而非卡死。
- **多级备用模型降级链编排与面板热调 (`Multi-tier Model Fallback Chains`)**：
  - 支持为任意主请求模型配置自定义多级备用降级链（如 `模型A ➔ 模型B ➔ 模型C ➔ 模型D`）；
  - 全池账号在模型 A 限流后，无感切到模型 B，模型 B 若再次限流则自动继续下探到模型 C；
  - 控制台提供可视化的降级链编辑器，支持一键追加备用模型、`↑ 上移` / `↓ 下移` 调优降级优先级。
- **SQLite 数据库日志持久化与按日期精准检索 (`Database Log Storage`)**：
  - 日志底层采用 SQLite 嵌入式数据库（`logs.db`）结构化持久存储并构建日期与分类索引，不再单纯依赖易丢失的零散文本；
  - Web 控制台支持一键按历史日期（今天、昨天或任意具体日期）精准拉取与过滤查看日志，支持按日导出下载。
- **多层嵌套业务错误码解析 (`extractStructuredBizCode`)**：递归下钻扫透 SDK 与 JSON-RPC 包装，精准识别 `11115` (上下文超限) 与 `14001..14023` (额度耗尽)。
- **官方服务端联网工具透出**：
  - `POST /v1/search`：免费透传官方聚合联网搜索
  - `POST /v1/fetch`：免费透传官方网页抓取与 Markdown 清洗
- **单页 Web 控制台**：
  - **访问密码授权保护 (`Web Auth Guard`)**：支持为 Web 控制台设置独立访问密码（或默认复用 `apiKey`），未授权人员严禁查看账号信息与系统配置，模板源码零泄露，一键支持安全退出与会话锁定。
  - 账号池负载、积分状态一览（含今日签到标记与快捷单号签到）
  - 一键扫码添加账号（微信 / 腾讯云官方 OAuth 设备码授权）
  - 一键全员每日签到打卡并弹出结构化通知横幅
  - 全量上游模型矩阵看板（国内版 + 国际版双区展示、区域分页与计数）、分类搜索、实时繁忙度探针（🟢畅通 / 🟡局部限流 / 🔴冷却）及 100% 原始 JSON 审查与导出。

---

## 🚀 部署与运行说明

本项目为 **0 第三方依赖（Zero-Dependency）** 架构，仅依赖 Node.js 原生标准库，**不需要执行 `npm install`**，下载即跑。

### 1. 环境准备

- **操作系统**：Linux / macOS / Windows
- **Node.js 运行时**：>= 22.0.0（项目使用内置 `node:sqlite` 持久化日志，22 以下无此模块）
- **网络要求**：国内版需可访问 `copilot.tencent.com` 与 `codebuddy.cn`；国际版需可访问 `codebuddy.ai`。只用一个版本时，仅需放通对应域名。

```bash
# 检查 Node.js 版本（确保 >= 22）
node -v
```

---

### 2. 获取代码与初始化配置

```bash
# 克隆仓库
git clone https://github.com/che246/tencent-ai-codebuddy-code-cli-2api.git
cd tencent-ai-codebuddy-code-cli-2api

# 复制默认配置文件（config.json / accounts.json 含凭据，不入库，需自行创建）
cp config.example.json config.json
cp accounts.example.json accounts.json
```

> `config.json`、`accounts.json`、`product.json` 均已在 `.gitignore` 中排除：
> 前两者含 API Key / 访问密码 / 账号令牌，第三个是上游模型矩阵快照，
> 会在首次启动时由 `/v3/config` 自动拉取生成，无需手工准备。

#### `config.json` 核心配置项解析：
```json
{
  "port": 8317,                              // 网关监听端口（默认 8317）
  "apiKey": "sk-codebuddy-gateway-token",    // 客户端调用的 Bearer API Key，请根据需要修改
  "webAuthEnabled": true,                    // 是否开启 Web 控制台密码访问保护
  "webPassword": "",                         // 控制台独立密码（留空则默认使用 apiKey 登录）
  "autoCheckin": true,                       // 是否开启每日全员智能签到 (每小时巡检，当天已签则次日再签)
  "tokenRefreshAdvanceDays": 7,              // 官方 Token 提前自动换发天数 (剩余不足该天数时无感续签)
  "maxLogDbSizeMb": 30,                      // 日志数据库 (logs.db) 物理大小上限 MB (超标自动清理最久记录收缩至 50%)
  "pinnedAccount": "",                       // 网关全局指定账号 UID（置空表示全池自动负载轮换）
  "routingStrategy": "least-inflight",       // 选号算法：least-inflight(最小并发优先) / round-robin(轮询) / credits(积分优先)
  "accountFailoverEnabled": true,            // 单账号模型限流时是否自动跨账号换号续跑
  "concurrencyLimitEnabled": true,           // 是否启用单账号并发削峰限流保护
  "maxInFlightPerAccount": 3,                // 单账号最大同时处理在途请求数（防止触发风控）
  "modelFallbackEnabled": true,              // 全池耗尽时是否自动降级至备用模型
  "modelFallback": {
    // 键与值都支持 cn: / intl: 区域前缀；不带前缀时按主请求模型的区域继承
    "deepseek-v4.1-flash": ["intl:deepseek-v4.1-flash-sg"],   // 国内版主模型降级到国际版同名/近亲模型
    "gpt-6-astra": ["deepseek-v4.1-flash", "hy4-preview"]     // 多级链：A ➔ B ➔ C
  }
}
```

> **区域前缀 `cn:` / `intl:`**：`/v1/models` 会为每个可用区域各返回一条带前缀的模型 ID。
> 带前缀时网关会锁定账号区域（避免跨区选号导致 401）；不带前缀则按账号池自动路由。
> 国际版要求首条消息为 `system`，网关会自动补齐；国际版账号无签到功能，签到巡检会自动跳过。

---

### 3. 多种部署运行方式

#### 方式 A：前台直接运行（开发 / 快速测试）

```bash
# 直接启动
node gateway.mjs

# 或使用 npm 命令
npm start
```

#### 方式 B：PM2 进程守护（生产环境首选推荐）

适合 Linux / Windows / macOS，支持崩溃自愈重启、开机自启与进程状态监控：

```bash
# 全局安装 PM2（如未安装）
npm install -g pm2

# 启动网关守护进程
pm2 start gateway.mjs --name codebuddy-gateway

# 查看运行状态与资源占用
pm2 status

# 查看实时日志流
pm2 logs codebuddy-gateway

# 设置开机自启
pm2 save
pm2 startup
```

#### 方式 C：Linux Systemd 系统服务（VPS / 云服务器标准驻留）

创建服务单元文件 `/etc/systemd/system/codebuddy-gateway.service`：

```ini
[Unit]
Description=Tencent CodeBuddy CLI 2API Gateway
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/tencent-ai-codebuddy-code-cli-2api
ExecStart=/usr/bin/node gateway.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

启动并启用开机启动：
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codebuddy-gateway

# 检查服务运行状态
sudo systemctl status codebuddy-gateway

# 实时查看日志
sudo journalctl -u codebuddy-gateway -f
```

#### 方式 D：Linux nohup 后台静默运行

```bash
nohup node gateway.mjs > /dev/null 2>&1 &

# 检查进程
ps aux | grep gateway.mjs
```

#### 方式 E：Docker 容器化部署

项目中提供极简容器化方案，无需构建笨重环境：

```dockerfile
# Dockerfile
FROM node:18-alpine
WORKDIR /app
COPY . .
EXPOSE 8317
CMD ["node", "gateway.mjs"]
```

运行命令：
```bash
# 构建镜像
docker build -t codebuddy-gateway .

# 启动容器（映射持久化配置文件）
docker run -d \
  --name codebuddy-gateway \
  -p 8317:8317 \
  -v $(pwd)/config.json:/app/config.json \
  -v $(pwd)/accounts.json:/app/accounts.json \
  -v $(pwd)/stats.json:/app/stats.json \
  --restart unless-stopped \
  codebuddy-gateway
```

---

### 4. 账号录入与 Web 控制台使用

1. 启动服务后，浏览器打开管理页面：**`http://<服务器IP或127.0.0.1>:8317`**
2. **添加账号**：点击右上角 **「➕ 扫码添加账号」**，微信或腾讯云扫码授权，完成后账号自动同步入池。
3. **指定账号与轮转**：
   - 在「👥 账号运维」页面，点击任意账号的 **「⭐ 设为指定」**，网关将优先锁定该账号处理所有请求。
   - 点击 **「⭐ 已指定」** 即可取消锁定，无缝切换为全池自动负载轮询。
4. **账号备注与积分明细**：
   - 点击 **「➕ 添加备注」** 可直接输入自定义标识（如“开发主号”、“备用VIP”）。
   - 点击积分数字或 **「明细」** 按钮，实时调取官方 `plans-usage` 三级积分账本（基础积分 / 购买积分 / 平台奖励积分及扣减进度条）。
5. **打卡打标**：点击 **「📅 全员打卡签到」**，一键为池内所有账号领取每日积分。

---

## 💻 客户端接入示例

### 1. OpenAI 兼容客户端 (Cursor / NextChat / Chatbox)

- **API Base URL**: `http://127.0.0.1:8317/v1`
- **API Key**: `sk-codebuddy-gateway-token` (在 `config.json` 中配置)
- **推荐模型**（模型名支持 `cn:` / `intl:` 区域前缀，不带前缀则按账号池自动路由）:
  - `cn:deepseek-v4.1-flash`（100万大上下文 / 原生思考模式）
  - `cn:hy4-preview`（腾讯混元 4 代思维模型，96万上下文）
  - `cn:hy3`（免费免扣积分）
  - `intl:deepseek-v4.1-flash-sg`（国际版，需国际版账号）
  - `intl:gpt-6-astra`（国际版专属，需非免费等级账号）
- **完整列表**: `GET http://127.0.0.1:8317/v1/models`（已被黑名单屏蔽的模型不会出现）

### 2. Claude Code 命令行接入

直接将环境变量指向本网关即可直接启动：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8317
export ANTHROPIC_API_KEY=sk-codebuddy-gateway-token
export ANTHROPIC_MODEL=cn:deepseek-v4.1-flash
# 国际版账号可改为: intl:deepseek-v4.1-flash-sg

claude
```

### 3. 官方服务端联网检索接口

```bash
# 联网搜索
curl http://127.0.0.1:8317/v1/search \
  -H "Authorization: Bearer sk-codebuddy-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{"query": "腾讯云 CodeBuddy", "max_results": 3}'

# 网页抓取为 Markdown
curl http://127.0.0.1:8317/v1/fetch \
  -H "Authorization: Bearer sk-codebuddy-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://cloud.tencent.com"}'
```

---

## 📝 更新记录 (Changelog)

### v2.5.0 — 双区域支持 / 流式加固 / 模型黑名单

> 破坏性变更：`config.json`、`product.json` 不再纳入版本控制，见「升级注意」。

#### ✨ 新增

**双区域（国内版 + 国际版）**
- `config.mjs` 新增 `REGION_CN` / `REGION_INTL`、`REGION_BASE` 端点表，以及 `normalizeRegion()` / `resolveAccountRegion()` / `baseForAccount()` / `endpointsFor()`；
- 账号新增 `region` 字段（`cn` | `intl`），缺省时按 `endpoint` 是否含 `codebuddy.ai` 自动推断，兼容手工录入的老账号；
- 国际版上游 `www.codebuddy.ai` 与国内版 `copilot.tencent.com` 路径完全同构，接入仅需切换 base 域名；
- `ensureLeadingSystemMessage()`：国际版强制首条 `system` 消息（缺失上游返回 `400/11128`），客户端无感；
- 签到巡检对非国内版账号返回 `unsupported` 并跳过，日志标注「N 个国际版账号无签到功能已跳过」；
- 模型按区域标记 `regions[]`，两区同名模型合并为一条但保留双区域信息；
- 控制台：账号列表区域徽章（可点击切换）、模型页区域分页（全部 / 国内 / 国际 / 两区皆有）、降级链下拉按区域分组、OAuth 弹窗区域单选。

**模型黑名单**
- `config.json` 新增 `modelBlacklist` 数组，支持精确名 / 区域前缀 / `*` 通配三类规则；
- `isModelBlacklisted()` 判定，`isStepUnavailableByBlacklist()` 用于降级链剔除（无区域前缀的步骤需两区都被屏蔽才失效）；
- `GET/POST /api/models/blacklist`：读取（含命中预览）/ 整体替换保存，热生效并落盘；
- 控制台：多选面板、行内屏蔽按钮、生效提示条、降级链失效步骤置灰。

**流式稳定性**
- 新增 `src/upstream/stream-guard.mjs`：`createUpstreamLifecycle()`、`readUpstreamStream()`、`startHeartbeat()`、`isTruncatedWithoutFinish()`、`buildTruncationChunk()`、`logStreamOutcome()`；
- 超时阈值可用环境变量覆盖：`GW_FIRST_BYTE_TIMEOUT_MS` / `GW_STREAM_IDLE_TIMEOUT_MS` / `GW_HEARTBEAT_INTERVAL_MS`。

**打包**
- 新增 `pack.ps1`：一键生成含账号的可运行发布包（自动生成 `start.ps1` / `start.sh` / `部署说明.md` 并校验语法与模型数）。

#### 🛠️ 修复

| 问题 | 原因 | 处理 |
|---|---|---|
| 每个正常完成的流式请求都被记为「客户端先断开」 | 上游发完 `data: [DONE]` 后不主动关连接（keep-alive 挂着），网关死等 `reader.done`，客户端先挂断 socket | 收到 `[DONE]` 即收工并 `reader.cancel()` 释放上游；新增 `upstreamEnded` 标记短路断开判定 |
| `[DONE]` 被 TCP 分片切断时识别失败 | 只对单个 chunk 做 `includes('[DONE]')` | 保留 12 字符尾巴做跨 chunk 拼接判断 |
| 引入 stream-guard 后所有请求返回 499 | `req.on('close')` 在请求体读完后即触发（Node 正常行为），被误当客户端断开 | 只监听 `res` 的 `close` / `error`，并校验 `writableEnded` / `finished` |
| Anthropic 非流式分支 `streamUsage is not defined` | 变量作用域遗漏 | 补 `let streamUsage = null` |
| 11158 业务码触发 500 | `ServerErrorCode` 未在适配器导入 | 补 import，并映射为 `403 model_not_allowed` + 1 小时模型冷却 |
| 降级链编辑器显示裸模型名，看不出区域 | 用 `/api/models-detail` 的裸 ID 直接填充 | 统一走 `buildRegionPrefixedOptions()` 加区域前缀 |
| 主模型选择仍用 `prompt()` 输入框 | 交互原始、易输错 | 改为可视化弹窗（区域标签 + 搜索 + 点击选中） |

#### 🔄 变更

- **报表 KPI 第二张卡**：「官网折算总价」改为「**缓存命中率**」（含进度条）；折算价降为卡片副行与「模型用量」卡片标题栏徽章，信息未丢失；
- **启动横幅**：改为按实际账号池推导区域构成（只有国内版账号显示「国内版」，只有国际版显示「国际版」，两者都有显示「国内版 + 国际版 双区域」），并新增账号池构成、上游区域、模型区隔三行；
- **上游请求头**：对齐官方 CLI 2.179.0，`Accept` 改为 `application/json`，补齐 `X-Product: SaaS`、`X-IDE-Type/Name: CLI`、`X-Agent-Runtime: other`、`X-Requested-With`、`X-Agent-Purpose`、`X-Agent-Type`、`X-CodeBuddy-Request`、`X-Root-Request-Id`，移除 `X-Session-ID` / `X-Wb-Uid` / `X-Model-ID` / `X-Client-Platform` / `X-Client-Version` / `X-Product-Version`；
- **无缓存命中的折算公式**：由固定按 80% 命中估算，改为按上游实际回传的 `prompt_cache_hit_tokens` 精确计算；
- **模型矩阵数据源**：不再引用 `package/` 目录，统一从上游 `/v3/config` 拉取并写入根目录 `product.json`，离线时只读该文件兜底；
- **Node.js 要求**：`>= 18` 更正为 `>= 22`（`node:sqlite` 于 22 引入）。

#### ⚠️ 升级注意

1. **`config.json` 不再入库**：拉取新版本后，若本地无 `config.json`，执行 `cp config.example.json config.json` 并填写 `apiKey` / `webPassword`；
2. **`product.json` 不再入库**：首次启动时由 `/v3/config` 自动生成，离线环境需从旧版本目录拷入；
3. **老账号自动兼容**：`region` 字段缺失时按 `endpoint` 推断，无需手工补；
4. **`config.json` 结构变更**：新增 `modelBlacklist`（数组，默认空）；`modelFallback` 的值统一为**数组**（旧版单字符串仍兼容，会被规范化为单元素数组）；
5. **重启生效**：本版本改动涉及配置结构，升级后需重启网关进程。

---

## 🏗️ 项目架构与模块划分 (团队协作指南)

项目已全面完成工程化解耦重构，采用零第三方依赖的现代原生 ES 模块标准（Node.js >= 22，`node:sqlite` 为内置依赖），各个分层职责清晰，极大降低多人协作冲突：

```
├── src/
│   ├── config.mjs              # 集中配置、跨模块常量、双区域端点表(REGION_BASE)与账号持久化
│   ├── server.mjs              # HTTP 网关入口、全局路由分发与定时任务调度
│   ├── core/                   # 核心基础设施层
│   │   ├── logger.mjs          # 统一环形缓冲日志系统 (内存缓冲 + 文件落盘)
│   │   ├── tls-certs.mjs       # Windows / OS 原生系统根证书自动提取与 TLS 栈注入
│   │   └── scheduler.mjs       # 账号池调度引擎 (区域过滤、粘性会话、并发削峰、局部冷却、打卡)
│   ├── upstream/               # 腾讯云官方客户端协议层 (对齐 package/ 权威规范)
│   │   ├── headers.mjs         # 32 位 Hex 官方会话审计头构建 (X-Request-ID, X-IDE-*, X-Private-Data)
│   │   ├── errors.mjs          # 递归业务码探测 (extractStructuredBizCode) 与错误映射
│   │   ├── models.mjs          # 双区域模型矩阵合并去重、regions 标记、探针状态与离线兜底
│   │   ├── stream-guard.mjs    # 首字节超时 / 静默看门狗 / SSE 心跳 / 客户端断开归因
│   │   └── payload.mjs         # Gzip 压缩、Channel 指纹清洗、区域前缀解析、模型能力守卫
│   ├── adapters/               # 下游客户端协议转译层
│   │   ├── openai.mjs          # OpenAI 规范适配 (/v1/chat/completions, SSE 流, 模型降级)
│   │   ├── anthropic.mjs       # Anthropic 规范适配 (/v1/messages, 原生 Thinking 思考流)
│   │   └── tools.mjs           # 官方免费联网搜索与网页抓取透传 (/v1/search, /v1/fetch)
│   └── web/                    # 控制台可视化与管理层
│       ├── routes.mjs          # /api/* 运维接口 (账号增删、区域切换、扫码授权轮询、设置热更)
│       └── public/
│           └── index.html      # 独立的单页 Web 控制台 (支持原生高亮编辑与免转义维护)
├── gateway.mjs                 # 根目录启动垫片 (兼容既有 node gateway.mjs 启动命令)
├── pack.ps1                    # 一键打包脚本 (生成含账号的可运行发布包)
├── product.json                # 模型矩阵快照 (首次启动时从上游 /v3/config 自动生成，不入库)
├── config.example.json         # 配置模板 (config.json 含凭据，不入库)
├── accounts.example.json       # 账号模板 (accounts.json 含令牌，不入库)
├── config.json                 # 运行配置文件 (含 apiKey / webPassword，本地生成)
└── accounts.json               # 本地账号凭证存储 (含 region: cn | intl)
```

---

## 📄 License

[MIT License](LICENSE)
