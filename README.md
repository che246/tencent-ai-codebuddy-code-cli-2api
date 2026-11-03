# Tencent CodeBuddy CLI 2API Gateway

基于腾讯云 **CodeBuddy Code (CLI 2.179.0)** 官方协议打造的纯模型层、多账号高并发代理网关。

支持将腾讯 CodeBuddy 国内版账号转换为标准的 **OpenAI** 与 **Anthropic** 兼容 API，提供 100 万大上下文模型（如 `deepseek-v4.1-flash`、`hy4-preview` 等），并将 **Agent 工具调用执行权 100% 交还给下游客户端**（如 Cursor、Claude Code、Cline、Roo Code、NextChat 等）。

---

## 🌟 核心特性

- **0 依赖轻量运行**：纯原生 Node.js 实现（仅需 Node.js 18+），剔除官方 CLI 中 200MB+ 的臃肿系统沙箱和本地执行文件，常驻内存仅 ~25MB，秒级启动。
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
  - 全量 33 款上游模型矩阵看板、分类搜索、实时繁忙度探针（🟢畅通 / 🟡局部限流 / 🔴冷却）及 100% 原始 JSON 审查与导出。

---

## 🚀 部署与运行说明

本项目为 **0 第三方依赖（Zero-Dependency）** 架构，仅依赖 Node.js 原生标准库，**不需要执行 `npm install`**，下载即跑。

### 1. 环境准备

- **操作系统**：Linux / macOS / Windows
- **Node.js 运行时**：>= 18.0.0（支持原生 `fetch` 与 ES 模块）
- **网络要求**：服务器或本机能够正常访问 `copilot.tencent.com` 与 `codebuddy.cn`

```bash
# 检查 Node.js 版本（确保 >= 18）
node -v
```

---

### 2. 获取代码与初始化配置

```bash
# 克隆仓库
git clone https://github.com/che246/tencent-ai-codebuddy-code-cli-2api.git
cd tencent-ai-codebuddy-code-cli-2api

# 复制默认配置文件
cp config.example.json config.json
cp accounts.example.json accounts.json
```

#### `config.json` 核心配置项解析：
```json
{
  "port": 8317,                              // 网关监听端口（默认 8317）
  "apiKey": "sk-codebuddy-gateway-token",    // 客户端调用的 Bearer API Key，请根据需要修改
  "webAuthEnabled": true,                    // 是否开启 Web 控制台密码访问保护
  "webPassword": "",                         // 控制台独立密码（留空则默认使用 apiKey 登录）
  "autoCheckin": true,                       // 是否开启每日 09:00 与 21:00 全员自动签到
  "maxLogDbSizeMb": 30,                      // 日志数据库 (logs.db) 物理大小上限 MB (超标自动清理最久记录收缩至 50%)
  "pinnedAccount": "",                       // 网关全局指定账号 UID（置空表示全池自动负载轮换）
  "routingStrategy": "least-inflight",       // 选号算法：least-inflight(最小并发优先) / round-robin(轮询) / credits(积分优先)
  "accountFailoverEnabled": true,            // 单账号模型限流时是否自动跨账号换号续跑
  "concurrencyLimitEnabled": true,           // 是否启用单账号并发削峰限流保护
  "maxInFlightPerAccount": 3,                // 单账号最大同时处理在途请求数（防止触发风控）
  "modelFallbackEnabled": true,              // 全池耗尽时是否自动降级至备用模型
  "modelFallback": {
    "deepseek-v4.1-flash": "deepseek-v4-flash",
    "hy4-preview": "hy3"
  }
}
```

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
- **推荐模型**:
  - `deepseek-v4.1-flash`（100万大上下文 / 原生思考模式）
  - `hy4-preview`（腾讯混元 4 代思维模型，96万上下文）
  - `hy3`（免费免扣积分）
  - `glm-5.3-flash`（100万大上下文）

### 2. Claude Code 命令行接入

直接将环境变量指向本网关即可直接启动：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8317
export ANTHROPIC_API_KEY=sk-codebuddy-gateway-token
export ANTHROPIC_MODEL=deepseek-v4.1-flash

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

## 🏗️ 项目架构与模块划分 (团队协作指南)

项目已全面完成工程化解耦重构，采用零第三方依赖的现代原生 ES 模块标准（Node.js >= 18），各个分层职责清晰，极大降低多人协作冲突：

```
├── src/
│   ├── config.mjs              # 集中配置、环境变量、跨模块常量与账号持久化
│   ├── server.mjs              # HTTP 网关入口、全局路由分发与定时任务调度
│   ├── core/                   # 核心基础设施层
│   │   ├── logger.mjs          # 统一环形缓冲日志系统 (内存缓冲 + 文件落盘)
│   │   ├── tls-certs.mjs       # Windows / OS 原生系统根证书自动提取与 TLS 栈注入
│   │   └── scheduler.mjs       # 账号池调度引擎 (粘性会话、并发削峰、局部冷却、打卡打标)
│   ├── upstream/               # 腾讯云官方客户端协议层 (对齐 package/ 权威规范)
│   │   ├── headers.mjs         # 32 位 Hex 官方会话审计头构建 (X-Request-ID, X-IDE-*, X-Private-Data)
│   │   ├── errors.mjs          # 递归业务码探测 (extractStructuredBizCode) 与错误映射
│   │   ├── models.mjs          # 模型矩阵同步、探针状态绑定与离线产品配置兜底
│   │   └── payload.mjs         # Gzip 压缩处理器、Channel 指纹清洗与模型能力守卫
│   ├── adapters/               # 下游客户端协议转译层
│   │   ├── openai.mjs          # OpenAI 规范适配 (/v1/chat/completions, SSE 流, 模型降级)
│   │   ├── anthropic.mjs       # Anthropic 规范适配 (/v1/messages, 原生 Thinking 思考流)
│   │   └── tools.mjs           # 官方免费联网搜索与网页抓取透传 (/v1/search, /v1/fetch)
│   └── web/                    # 控制台可视化与管理层
│       ├── routes.mjs          # /api/* 运维接口 (账号增删, 扫码授权轮询, 设置热更)
│       └── public/
│           └── index.html      # 独立的单页 Web 控制台 (支持原生高亮编辑与免转义维护)
├── gateway.mjs                 # 根目录启动垫片 (兼容既有 node gateway.mjs 启动命令)
├── config.json                 # 运行配置文件
└── accounts.json               # 本地账号凭证存储
```

---

## 📄 License

[MIT License](LICENSE)
