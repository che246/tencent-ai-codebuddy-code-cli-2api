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
- **全套官方请求头族注入**：对齐官方 CLI 2.179.0 请求指纹（`X-Request-ID`、`X-Conversation-Request-ID`、`X-Session-ID`、`X-Agent-Intent: craft`、`X-Agent-Runtime: cli`、`X-Client-Version` 等），保证链路安全。
- **官方云端 Prompt 缓存**：自动注入 `cache_retention: "auto"`，激活腾讯云端对 Prompt 前缀的 KV Cache 缓存，降低首字延迟并节省额度。
- **模型能力前置守卫**：根据官方模型定义自动审查，对不支持工具调用的模型自动剥离 `tools`，对不支持多模态视觉的模型自动扁平化图片为文本，彻底避免 400 报错。
- **模型级限流 (6004) 自动改道**：单模型超限时仅冷却该模型不株连账号，支持同账号内自动无感切换至配置的等价备用模型（如 `deepseek-v4.1-flash -> deepseek-v4-flash`）。
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

## 📄 License

[MIT License](LICENSE)
