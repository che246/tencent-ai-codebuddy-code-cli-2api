# 角色与重构任务

你是一名资深的 **Go 语言系统架构师与协议逆向专家**。
你的任务是将现有的基于 Node.js 22+ 开发的 **Tencent CodeBuddy CLI 2API 网关项目** 完整重构成一个 **高性能、纯 Go 实现、零 CGO 依赖、单二进制交付** 的生产级网关系统。

---

## 一、 项目背景与重构核心目标

1. **项目定位**：
   本项目并非凭空设计的代理网关，而是 **腾讯云 CodeBuddy CLI (官方 v2.179.0)** 协议的精准逆向与复刻。它负责将腾讯云国内版（`copilot.tencent.com`）与国际版（`www.codebuddy.ai`）多账号统一转译为标准的 **OpenAI** (`/v1/chat/completions`) 与 **Anthropic** (`/v1/messages`) 协议，并将 Agent 工具调用的执行权 100% 交还给下游客户端（如 Cursor, Claude Code, Cline 等）。

2. **Go 重构的核心诉求**：
   - **单二进制交付**：前端静态资源通过 Go 1.16+ 的 `//go:embed` 直接打包进单一可执行文件，无任何运行时外部文件依赖。
   - **纯 Go 零 CGO 编译**：日志与数据存储使用纯 Go SQLite 驱动（推荐 `modernc.org/sqlite`），确保在开发机上即可直接跨平台交叉编译（如 `GOOS=linux GOARCH=arm64`）。
   - **极致轻量与高并发**：利用 Go Goroutine + Channel + Context 控制长连接生命周期，降低长文本 SSE 流式传输时的内存驻留（目标常驻内存 < 20MB）。
   - **100% 协议保真与风控对齐**：所有协议字段、超时判定、风控对抗规则与数据容灾策略必须与 Node.js 现有实现完全等价。

---

## 二、 推荐的标准 Go 目录结构

```text
codebuddy-gateway-go/
├── cmd/
│   └── gateway/
│       └── main.go                  # 启动入口、信号监听、优雅停机、后台协程调度
├── internal/
│   ├── config/                      # 配置加载、账号池定义、备份机制 (backups/)
│   │   ├── config.go
│   │   ├── account.go
│   │   └── storage.go               # 原子写入 (*.tmp -> rename) 与 backups/ 镜像
│   ├── core/
│   │   ├── scheduler/               # 选号引擎: least-inflight / round-robin / credits
│   │   │   ├── scheduler.go
│   │   │   └── sticky.go            # 1小时 TTL 会话粘性映射
│   │   ├── database/                # SQLite 日志表 (logs) 与 积分历史表 (credit_history)
│   │   │   └── sqlite.go            # 尺寸熔断、自动压缩、按日期精准检索
│   │   ├── metrics/                 # 报表统计计数 (stats.json) 与 Token 吞吐
│   │   ├── pricing/                 # 模型官网价格单价基准与实际成本估算
│   │   └── tlscerts/                # 跨平台 (Windows/Linux/macOS) 系统根证书自动提取注入
│   ├── upstream/                    # 腾讯官方协议族深度对齐 (关键模块)
│   │   ├── endpoints.go             # cn (国内) 与 intl (国际) 双区同构端点路由
│   │   ├── headers.go               # UUIDv7 毫秒时间戳生成、4 组同值链路 ID、UA 清洗
│   │   ├── stream_guard.go          # 20分钟看门狗、空流三标志分类、SSE 心跳保活
│   │   ├── payload.go               # 指纹清洗、国际版 System 兜底、平铺推理参数规整
│   │   ├── errors.go                # extractStructuredBizCode 6层下钻业务码递归解析
│   │   └── models.go                # 双区模型矩阵拉取与黑名单动态剔除
│   ├── adapters/                    # 下游协议转译
│   │   ├── openai.go                # /v1/chat/completions (流式/非流式、多级降级链)
│   │   ├── anthropic.go             # /v1/messages (Claude Code 协议、thinking_delta 流式转译)
│   │   └── tools.go                 # /v1/search (聚合联网检索) & /v1/fetch (网页 Markdown 清洗)
│   └── web/                         # 控制台静态页面与 REST API
│       ├── embed.go                 # //go:embed public/*
│       ├── handlers.go              # /api/accounts, /api/logs, /api/credits/history 等
│       └── auth.go                  # 控制台 Web 密码授权守卫
├── public/                          # 原单页控制台前端 (index.html)
├── go.mod
└── go.sum
```

---

## 三、 必须严格遵守的【最高优先级协议与风控规则】

这是本项目能够稳定运行的核心经验，请在 Go 重构中**逐行对齐，绝不可自行发挥**：

### 1. 请求头指纹与风控对抗（`headers.go`）
- **UUID v7 规范**：
  必须基于真实当前毫秒时间戳（大端编码前 6 字节）实现 UUID v7，输出 36 字符标准带连字符形式与 32 位无连字符 Hex。
- **4 组同值链路 ID**（抓包实测绝对一致）：
  同一次上游请求中，以下 4 个请求头必须**完全取同一个 32 位 Hex ID**：
  - `X-Request-ID`
  - `X-Conversation-Message-ID`
  - `X-Conversation-Request-ID`
  - `X-Root-Request-ID`
- **会话与跟踪 ID**：
  - `X-Conversation-ID`：必须为 36 字符的标准 UUID v7 结构（带连字符）；
  - `X-Trace-ID`：独立的 32 位 Hex UUID；
  - `X-Domain`：国内版严格固定为 `www.codebuddy.cn`，国际版严格为 `www.codebuddy.ai`；
  - `X-Agent-Intent: craft`、`X-Agent-Runtime: other`、`X-IDE-Type: CLI`、`X-IDE-Version: 2.179.0`。
- **User-Agent 强风控过滤**：
  上游对含有子串 `"python-requests"`（不区分大小写）的请求会直接返回 `400 {"code":11128,"msg":"request illegal"}`。网关必须提供 UA 清洗函数，命中时强制回退到官方 UA：`CLI/2.179.0 CodeBuddy/2.179.0`。

### 2. 流式稳定性与看门狗保障（`stream_guard.go`）
- **精确数值对齐**（来自 CLI 源码常量）：
  - 首 Token 超时：`1200000ms`（20分钟，对应 CLI `CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS`）；
  - 流静默空闲看门狗：`300000ms`（5分钟，超过该静默期未收到任何新 chunk 判定断流）；
  - 终态宽限期：`5000ms`（收到 `finish_reason` 后宽限接收 usage 帧）。
- **官方同款空流三标志分类器 (`createDeltaClassifier`)**：
  - `hasContent`: 正文 || 思考 (reasoning) || 工具 || 拒答（思考也算活着）；
  - `hasSubstantiveContent`: 正文 || 工具 || 拒答（思考**不算**实质产出）；
  - **空流截断补偿**：官方不把缺少 `finish_reason` 视为错误。只有在 `hasSubstantiveContent == true` 时异常断流，网关才给下游客户端补偿一条 `finish_reason: "length"` 终态帧；连思考都没有才补 `finish_reason: "error"`。
- **长思考期真实保活心跳**：
  长思考时若长时间无内容输出，第三方客户端（如 Claude Code / Cursor）会自行超时报错。网关需启动定时保活：
  - Anthropic 协议：下发真实心跳事件 `event: ping\ndata: {"type": "ping"}\n\n`；
  - OpenAI 协议：下发空增量帧 `data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n`。

### 3. 上游多区域与请求规整（`payload.go`, `endpoints.go`）
- **双区域端点同构与 Token 隔离**：
  国内版基址 `https://copilot.tencent.com`，国际版基址 `https://www.codebuddy.ai`。两端接口路径完全相同，但 Token 按签发域隔离，禁止跨区选号（跨区上游直接 401）。
- **国际版 Mandatory System Message**：
  国际版上游接口对消息数组首项有硬性校验，若 `messages[0].role != "system"`，直接报错 `400/11128`。网关在调用国际版且缺少 system 时，必须自动在数组最前面补一条 `{role: "system", content: ""}`。
- **推理参数平铺**：
  腾讯官方上游仅接收平铺的 `reasoning_effort`、`reasoning_summary` 等字段，**严禁发送**嵌套的 `thinking: {}` 或 `reasoning: {}` 对象。
- **Gzip 压缩上行**：
  长文本请求体较大时，自动使用 Gzip 压缩并通过 `Content-Encoding: gzip` 发送，缩短传输时间。

### 4. 结构化错误下钻与容灾降级（`errors.go`, `scheduler.go`）
- **递归 6 层下钻提取业务码 (`extractStructuredBizCode`)**：
  穿透 SDK 与 JSON-RPC 的嵌套包装，识别 `6003, 6004, 6007, 6008`（长窗口限流，触发多级备用模型降级）；识别 `14001..14023`（额度耗尽，触发账号冷却换号）；识别 `11115`（输入超限 PTL 报错）。
- **模型黑名单机制 (`modelBlacklist`)**：
  支持精确名、区域前缀（`intl:gpt-6-astra`）和通配符（`intl:*`, `gpt-6-*`）。黑名单模型必须：
  1. 不在 `/v1/models` 输出；
  2. 被直接硬编码调用时返回 `403 model_blacklisted`；
  3. 构建自动降级链时被静默剔除。

### 5. 全链路数据安全持久化与独立备份（`storage.go`）
- **备份目录集中隔离**：
  所有敏感文件镜像备份（`accounts.json.bak`, `config.json.bak`, `stats.json.bak` 等）统一存放于独立的 `backups/` 目录中，根目录严禁散落 `.bak` 文件。
- **原子写入机制**：
  保存数据时必须采用 `先写临时文件 (*.tmp) -> Sync 刷盘 -> 原子 Rename 覆盖`，杜绝掉电或进程被 Kill 产生 0 字节半截损坏。
- **三级容灾恢复**：
  读取配置与账号时按顺序自愈：`主文件 -> backups/ 目录镜像备份 -> legacy 根目录备份`。任何一级恢复成功自动修复主文件，并在初始化时将旧备份平滑归档入 `backups/`。

### 6. 积分监控与变动历史留痕（`database.go`）
- 在 SQLite 中维护 `credit_history` 表；
- 每次查到真实余额时，与上一次记录做严格比对；一旦发生变动（增或减），即刻记录：时间戳、账号名/备注、变动数值（$\Delta$）、变动后余额、变动说明（如 `余额 5,309 → 5,300`）；
- 提供 API 查询（支持 `?limit=100` 等）与一键清空功能。

---

## 四、 Go 重构实施步骤规划

请按以下顺序分阶段开展重构，每完成一步均需进行编译与单元测试验证：

1. **Phase 1: 基础设施与数据持久化**
   - 实现 `config`、`storage`（原子写与 `backups/` 归档）与数据模型；
   - 引入纯 Go SQLite 驱动，构建 `logs` 与 `credit_history` 表结构与查询方法；
   - 实现跨平台操作系统根证书注入 `tlscerts`（Windows 通过 `crypt32.dll` 或 `CertOpenSystemStore`，Linux 查 CA 证书文件）。

2. **Phase 2: 腾讯官方协议族复刻**
   - 实现 UUIDv7 生成器与请求头注入（`headers.go`）；
   - 实现 `stream_guard.go`（基于 `bufio.Reader` 逐行解析 SSE，包含空闲看门狗与保活心跳注入）；
   - 实现业务错误码递归解构 `extractStructuredBizCode` 与上游请求清洗。

3. **Phase 3: 账号调度与状态机**
   - 实现并发安全带读写锁的 `AccountScheduler`；
   - 实现选号算法（`least-inflight` / `round-robin` / `credits`）、会话粘性映射、单模型局部冷却；
   - 实现 Token 提前 7 天自动续签与每日签到协程；
   - 接入积分变动比对与留痕流水写入。

4. **Phase 4: 协议适配器与降级链**
   - 实现 `/v1/chat/completions`（OpenAI 协议，流式/非流式、多级备用模型降级链编排）；
   - 实现 `/v1/messages`（Anthropic 协议，Claude Code 原生兼容、`thinking_delta` 流式转译）；
   - 实现 `/v1/search` 与 `/v1/fetch` 原生透传。

5. **Phase 5: Web 控制台与单二进制集成**
   - 通过 `embed.FS` 嵌入 `public/index.html`；
   - 暴露 REST 管理接口（`/api/*`）并添加访问密码校验守卫；
   - 处理优雅停机（`SIGINT`, `SIGTERM`），退出前执行刷盘保存。

---

## 五、 交付与验收标准

1. **单文件编译**：
   ```bash
   # 本地验证
   go build -o bin/gateway ./cmd/gateway
   # 跨平台 ARM64 交叉编译 (无需任何 C 交叉编译器)
   CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o bin/gateway-linux-arm64 ./cmd/gateway
   ```
2. **兼容性验收**：
   - 使用 `curl` 测试 `/v1/chat/completions` 与 `/v1/messages`，返回格式与现网一致；
   - 官方 Claude Code 命令行直接连入，验证流式思考过程输出；
   - 浏览器打开 `:8317` 控制台，账号列表、模型黑名单、日志日期筛选、**积分历史留痕卡片**均能正常交互。
3. **高并发与内存稳定性**：
   - 压测并发长连接时，内存稳定，无 Goroutine 泄漏；
   - 进程强杀重启后，历史未完成的 `inFlight` 计数归零，数据与备份无损坏。
