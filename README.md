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
- **模型级长窗口限流 (6003/6004/6007/6008) 自动改道**：单模型超限时仅局部冷却该模型，支持同账号内自动无感切换至配置的等价备用模型（如 `deepseek-v4.1-flash -> deepseek-v4-flash`）。
- **多层嵌套业务错误码解析 (`extractStructuredBizCode`)**：递归下钻扫透 SDK 与 JSON-RPC 包装，精准识别 `11115` (上下文超限) 与 `14001..14023` (额度耗尽)。
- **官方服务端联网工具透出**：
  - `POST /v1/search`：免费透传官方聚合联网搜索
  - `POST /v1/fetch`：免费透传官方网页抓取与 Markdown 清洗
- **单页 Web 控制台**：
  - 账号池负载、积分状态一览（含今日签到标记与快捷单号签到）
  - 一键扫码添加账号（微信 / 腾讯云官方 OAuth 设备码授权）
  - 一键全员每日签到打卡并弹出结构化通知横幅
  - 全量 33 款上游模型矩阵看板、分类搜索、实时繁忙度探针（🟢畅通 / 🟡局部限流 / 🔴冷却）及 100% 原始 JSON 审查与导出。

---

## 🚀 快速开始

### 1. 克隆与配置

```bash
git clone https://github.com/che246/tencent-ai-codebuddy-code-cli-2api.git
cd tencent-ai-codebuddy-code-cli-2api
cp config.example.json config.json
cp accounts.example.json accounts.json
```

### 2. 启动网关

```bash
# 启动服务（默认监听端口 8317）
node gateway.mjs
# 或者使用 npm
npm start
```

### 3. 添加账号

打开浏览器访问 **`http://localhost:8317`**，点击右上角 **「➕ 扫码添加账号」**，使用微信或腾讯云扫码授权即可自动将账号加入账号池并同步积分。

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
