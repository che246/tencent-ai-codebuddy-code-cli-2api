# P0 0.3 · 2.181.0 抓包验证报告

> 状态：**P0 0.3 已完成**。用项目 `.capture/` 现有工具链对 2.181.0 复抓，并对 2.179.0 做**同条件对照复抓**（同一假上游、同一环境变量、同一 product 配置副本）。
> 本轮只新增文档与 `2.181.0/analysis/`、`2.181.0/capture-work*/` 下的证据文件，未改动项目任何业务代码、配置、凭据，未 commit / push。
> 关联：`docs/UPSTREAM-VERSION-DIFF.md`（P0 0.1/0.2）。

## 0. 隔离与诚实声明

- 主链路全部指向本地假上游 `http://127.0.0.1:18099`，使用 `CODEBUDDY_AUTH_TOKEN=fake-capture-token-123`（**假令牌**），未使用真实账号。
- **唯一例外（如实记录）**：2.181.0 有一条 `POST https://copilot.tencent.com/v1/traces`（OTLP exporter，UA `OTel-OTLP-Exporter-JavaScript/0.52.1`）**未受 `CODEBUDDY_BASE_URL` 控制，直连了真实域名**；`OTEL_SDK_DISABLED=true` 未能阻止它。请求携带的是假令牌，无真实凭据外泄。同条件下 2.179.0 的 `/v1/traces` 走的是本地 `127.0.0.1:18099`。这是本次发现的**真实版本差异**，后续复抓建议额外设置 `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:18099` 或在网络层阻断。
- 其余出站（含 `/internal/agent`）均为 `127.0.0.1` 回环。
- CLI 两次均以 `CAPTURE_DONE` 正常结束，`exit=0`。

---

## 1. 复现命令

```bash
# 假上游（后台常驻，项目自带）
cd D:/AI/1codebuddy_cli_agent_interface_analysis_prompt/2.181.0/capture-work
CAP_PORT=18099 node D:/AI/tencent-ai-codebuddy-code/.capture/fake-upstream2.mjs

# 2.181.0 抓包
cd D:/AI/1codebuddy_cli_agent_interface_analysis_prompt/2.181.0/capture-work
NODE_OPTIONS="--require D:/AI/tencent-ai-codebuddy-code/.capture/capture-preload.cjs" \
ACC_PRODUCT_CONFIG_PATH="D:/AI/tencent-ai-codebuddy-code/.capture/product.capture.json" \
CODEBUDDY_BASE_URL="http://127.0.0.1:18099" \
CODEBUDDY_AUTH_TOKEN="fake-capture-token-123" \
DISABLE_AUTOUPDATER=1 OTEL_SDK_DISABLED=true CODEBUDDY_SANDBOX_CLOUD_AUDIT_DISABLED=1 \
node "D:/AI/1codebuddy_cli_agent_interface_analysis_prompt/2.181.0/extracted/bin/codebuddy" \
  -p "hi" --model deepseek-v4.1-flash --output-format text

# 2.179.0 同条件对照（仅换 bin 路径与 cwd）
cd D:/AI/1codebuddy_cli_agent_interface_analysis_prompt/2.181.0/capture-work-179
<同上环境变量> node "D:/AI/tencent-ai-codebuddy-code/package/bin/codebuddy" \
  -p "hi" --model deepseek-v4.1-flash --output-format text
```

工具：`fake-upstream2.mjs`（服务端实收，写 `.capture/requests.log`）、`capture-preload.cjs`（客户端出站全量头，写 `.capture/outbound.log`，自动脱敏 `authorization`）、`product.capture.json`（把 endpoint 指向本地）。解析脚本 `2.181.0/tools/parse-capture.cjs`。

---

## 2. 2.181.0 出站全景

**客户端视角（`outbound.log`，8 条）**

| # | via | URL | UA |
| :--- | :--- | :--- | :--- |
| 1 | `http.request` | `http://127.0.0.1:18099/v3/config` | `CLI/2.181.0 CodeBuddy/2.177.1` |
| 2 | `http.request` | `http://127.0.0.1:20388/internal/agent` | `axios/0.26.1` |
| 3 | `http.request` | `http://127.0.0.1:18099/chat/completions` | `CLI/2.181.0 CodeBuddy/2.177.1` |
| 4 | `fetch` | `http://127.0.0.1:18099/agenttool/v1/webfetch` | `CLI/2.181.0` |
| 5 | `http.request` | `http://127.0.0.1:18099/v2/report` | `CLI/2.181.0 CodeBuddy/2.177.1` |
| 6 | `http.request` | `http://127.0.0.1:18099/chat/completions` | 同 #3 |
| 7 | `http.request` | `http://127.0.0.1:18099/chat/completions` | 同 #3 |
| 8 | `https.request` | `https://copilot.tencent.com/v1/traces` | `OTel-OTLP-Exporter-JavaScript/0.52.1` |

**服务端实收（`requests.log`，6 条）**：`POST /chat/completions` ×3、`GET /v3/config` ×1、`POST /agenttool/v1/webfetch` ×1、`POST /v2/report` ×1。

---

## 3. 双版本严格对照（同条件）

| 项 | 2.179.0 | 2.181.0 | 判定 |
| :--- | :--- | :--- | :--- |
| `bin/codebuddy --version` | `2.179.0` | `2.181.0` | 基线正确 |
| 主对话路径 | `POST /chat/completions` ×3 | `POST /chat/completions` ×3 | **一致** |
| 配置拉取 | `GET /v3/config` ×1 | `GET /v3/config` ×1 | 一致 |
| agenttool | `POST /agenttool/v1/webfetch` ×1 | 同 | 一致 |
| `/v2/report` | 未触发 | `POST` ×1（5 个事件） | **运行时差异**（见 §5.4） |
| `/v1/traces` | `127.0.0.1:18099/v1/traces`（本地） | `copilot.tencent.com/v1/traces`（真实域名） | **版本差异**（见 §0） |
| 主链路 UA | `CLI/2.179.0 CodeBuddy/2.177.1` | `CLI/2.181.0 CodeBuddy/2.177.1` | 仅 `CLI/` 段随包版本变；`CodeBuddy/` 段**两版相同** |
| agenttool UA | `CLI/2.179.0` | `CLI/2.181.0` | 一致（无 `CodeBuddy/` 段） |
| `x-product` | `SaaS` | `SaaS` | 一致 |
| `x-agent-intent/purpose/runtime/type` | `craft / conversation / other / main` | 同 | 一致 |
| `x-ide-type/name/version` | `CLI / CLI / 2.179.0` | `CLI / CLI / 2.181.0` | 仅 ide-version 随包版本变 |
| `x-codebuddy-request` / `x-private-data` / `x-user-id` / `x-requested-with` | `1 / false / anonymous / XMLHttpRequest` | 同 | 一致 |
| `x-stainless-package-version` | `7.39.0` | `7.39.0` | 一致 |
| W3C + B3 双追踪链 | `traceparent` / `baggage` / `b3` / `x-b3-*` / `x-trace-id` 全有 | 同 | 一致 |
| body 键集 | `model,messages,tools,temperature,max_tokens,stream,stream_options,reasoning_effort,verbosity,extra_vars,cache_retention,reasoning_summary` | 同 | 一致 |
| `cache_retention` | `long` | `long` | 一致 |
| `tools` 数量 | 25 | 25 | 一致 |

**ID 关系（两版本完全相同，均为 2+2 分组）**：

```
X-Request-ID              = <32hex A>
X-Conversation-Message-ID = <32hex A>        ← 与 X-Request-ID 同值
X-Conversation-Request-ID = <32hex B>
X-Root-Request-ID         = <32hex B>        ← 与 X-Conversation-Request-ID 同值
X-Conversation-ID         = <36 字符 UUIDv7，带横线，跨轮不变>
```

---

## 4. 与静态分析的交叉验证

| 静态分析结论（2.181.0） | 运行时验证 | 结果 |
| :--- | :--- | :--- |
| `/v3/config` = `CloudProductProvider` 配置拉取 | 抓到 `GET /v3/config`，头精简（无会话头） | ✅ 证实 |
| `/chat/completions` = Chat Completions 主协议 | 抓到 3 次 `POST /chat/completions`（含 tool result 回传轮） | ✅ 证实 |
| `cache_retention` 默认 `long`、会话锁定 | body 每轮均为 `cache_retention: long` | ✅ 证实 |
| `X-No-*`、`X-Refresh-Token` 等认证头 | 本次用 `CODEBUDDY_AUTH_TOKEN` 直连，未走登录流程，认证接口未触发 | ⚪ 未覆盖（预期） |
| 完整 `X-*` 头常量表 | 服务端实收 40 个头，与常量表逐项对应 | ✅ 证实 |
| `reasoning.encrypted_content` / `x-ms-region` / `x-account-id` | 本次模型非 `openai-responses` 协议，未触发 | ⚪ 未覆盖 |
| `/v2/chat/decisions`、企业 `user-check`、图片/视频生成 | 单次 `-p "hi"` 未触发 | ⚪ 未覆盖 |
| `/v2/report` | 抓到一次批量 flush | ✅ 证实存在（见 §5.4） |
| `/v2/geoblock` | 两版本均未触发（bundle 中均存在，属条件触发） | ⚪ 未覆盖 |

---

## 5. 关键发现（逐条带证据）

### 5.1 主对话路径：抓包值 `/chat/completions`，网关配置 `/v2/chat/completions`

两版本**运行时都打 `POST /chat/completions`**；两版本 bundle 中 `/chat/completions` 字面量 16 命中、`/v2/chat/completions` 字面量 **0**（只出现在 `classifyWbApiSource()` 的正则 `\/v2\/chat\/completions` 里，3 命中）。

但网关 `src/config.mjs:63`、`:108` 硬编码 `{api}/v2/chat/completions`，`.capture/REPORT.md` 的文字也记为 `/v2/chat/completions`。三者不一致的合理解释是：`CODEBUDDY_BASE_URL` 覆盖时 CLI 把本地地址当作 API 根直接拼 `/chat/completions`；连真实 `copilot.tencent.com` 时网关按上游路由加 `/v2` 前缀。**这是 BASE_URL 语义差异，不是版本差异**；网关路径在真实上游一直可用，但建议单独确认上游是否同时接受两种路径，避免把抓包结论直接套到网关配置上。

> 修正 `UPSTREAM-VERSION-DIFF.md` §2 第 1 点的依据来源：从「静态推断」升级为「双版本运行时实证」。

### 5.2 UA 的 `CodeBuddy/` 段与包版本解耦

严格同条件下：2.179.0 = `CLI/2.179.0 CodeBuddy/2.177.1`，2.181.0 = `CLI/2.181.0 CodeBuddy/2.177.1`。`2.177.1` 在两版本 bundle 中均 **0 命中**，只在 `dist/web-ui/docs/*` 的文档索引里出现，属运行时 UA 构造的产品版本段（受 `CLIENT_INFO_*` / product 配置影响）。

网关 `src/config.mjs:96-97` 为 `CURRENT_VERSION='2.179.0'`、`USER_AGENT=CLI/2.179.0 CodeBuddy/2.179.0`；`REPORT.md` 记录过 `CodeBuddy/2.179.0`（另一批抓包，曾设置 `CLIENT_INFO_*`）。**三处取值不一致，是明确的风险点**：UA 是 `headers.mjs` 风控清洗的输入，建议确认目标上游实际期望值后再决定是否调整，不要凭单一批次改动。

### 5.3 ID 关系是 2+2 分组，不是四者同值

两版本实测均为：`X-Request-ID` = `X-Conversation-Message-ID`（每次新生成），`X-Conversation-Request-ID` = `X-Root-Request-ID`（会话根，跨轮不变）。而网关 `src/upstream/headers.mjs` 与 Go `internal/upstream/headers.go` 的注释写「四者完全同值」。`.capture/REPORT.md` 记录的首轮抓包确实是四者同值，说明该语义依赖请求轮次。**网关按「四者同值」实现是否影响真实上游需复核**，但不能直接判为 Bug——网关每次请求是独立一轮，二者可能等价。建议列入 P3 一致性测试的断言项。

### 5.4 `/v2/report` 不是 2.181.0 新增接口

两版本 bundle 中 `this.path="/v2/report"` 各 1 命中，均带 `FIRE_DELAY=2e3`（2000ms 批量延迟）。本次 2.181.0 触发了 flush，请求体是 5 个事件的数组：`plugin_status`、`chat_request_send`、`chat_message_send`、`chat_message_response`、`chat_message_status`（含 `extVersion=2.181.0`、`machineId`、`sessionId`、`clientIp`、`product=SaaS` 等字段）。2.179.0 本次未触发，属**时序/触发条件差异，不是接口新增**。同理 `/v2/geoblock`（IP 探测，两版本均存在）本次两版都未触发。

### 5.5 OTLP traces 的 BASE_URL 行为差异

2.179.0：`POST http://127.0.0.1:18099/v1/traces`（受 `CODEBUDDY_BASE_URL` 控制）。
2.181.0：`POST https://copilot.tencent.com/v1/traces`（**绕过** `CODEBUDDY_BASE_URL`，直连真实域名）。
这是本次唯一需要写入「版本差异」的运行时行为变化，且涉及沙箱隔离。复抓时应显式设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 或在防火墙层阻断。

### 5.6 请求头与网关现有实现高度对齐

`x-product: SaaS`、`x-agent-purpose: conversation`、`x-agent-runtime: other`、`x-agent-type: main`、`x-codebuddy-request: 1`、`x-private-data: false`、`x-user-id: anonymous`、`x-requested-with: XMLHttpRequest`、6 个 `x-stainless-*`、W3C+B3 双追踪链、UUIDv7 会话 ID——与 `headers.mjs` 的抓包注释逐项吻合。**上一轮 P1/P2 中「补请求头」的优先级应下调**：现有实现已对齐，真正待办是 5.2（UA 产品段）、5.3（ID 分组）两处复核，以及 `retry_policy` / 401 / `passthrough` 这类**协议逻辑**缺口，而非头字段缺失。

---

## 6. 对差异表与方案的修正

| 文档/条目 | 原结论 | 抓包后修正 |
| :--- | :--- | :--- |
| `UPSTREAM-VERSION-DIFF.md` §7 第 1 条 | 「2.181.0 仅做静态分析，未做动态抓包」 | **P0 0.3 已完成**，本报告即为动态验证；该边界解除 |
| 同上 §2 第 1 点 | 依据静态锚点判定「两条路径并存」 | 升级为**双版本运行时实证**（均 `/chat/completions`）；补注网关 `/v2/chat/completions` 属 BASE_URL 语义差异 |
| 差异表 §3/§4 | 常量与类型树静态一致 | 运行时证实 `cache_retention: long`、完整头表、body 键集一致 |
| 上一轮方案 P1 1.1 | 「补证据源」 | 不变；另建议把「原始日志 > 报告文字」写入证据优先级（本次 `REPORT.md` 文字与 `requests.log` 原始记录不一致） |
| 上一轮方案 P2 2.3 | 「补 `CODEBUDDY_CUSTOM_HEADERS` / `passthrough` 头」 | 头字段本身已对齐，改为**补策略逻辑**（前缀白名单、absent-only、唯一 ID 重断言） |
| 新增待办 | — | 5.2 UA 产品段、5.3 ID 分组、5.5 OTLP 外连三项复核，建议进 P3 一致性测试 |

---

## 7. 未验证项

- 认证全链路（`/v2/plugin/auth/state`、`auth/token?state`、refresh、logout、handoff）本次用 `CODEBUDDY_AUTH_TOKEN` 直连跳过，未抓到；需另一套带登录流程的复抓。
- `openai-responses` 协议的 `x-ms-region` / `x-account-id` / `encrypted_content` 回放，本次模型未走该协议。
- `/v2/chat/decisions`、4 个企业 `user-check`、`/v2/images|videos/generations` 未被本次单次 `-p "hi"` 触发。
- `CodeBuddy/2.177.1` 的确切来源（运行时 UA 构造）未在产物中定位，只确认两版本一致。
- 网关 `/v2/chat/completions` 在真实上游的可用性、以及上游是否同时接受 `/chat/completions`，未做真实域名验证（本轮刻意不碰）。

---

## 8. 证据索引

| 文件 | 内容 |
| :--- | :--- |
| `2.181.0/analysis/capture-2181-requests.log` | 2.181.0 服务端实收原始日志 |
| `2.181.0/analysis/capture-2181-outbound.log` | 2.181.0 客户端出站全量头（脱敏） |
| `2.181.0/analysis/capture-2181-summary.txt` | 2.181.0 逐请求头/body 摘要 |
| `2.181.0/analysis/capture-2181-requests.json` / `capture-179-requests.json` | 按 UA 拆分后的双版本结构化记录 |
| `2.181.0/analysis/report-endpoint.txt` | `/v2/report`、`/v2/geoblock`、UA 版本串的双版本 bundle 切片 |
| `2.181.0/tools/{parse-capture,report-endpoint}.cjs` | 可重放解析脚本 |
| `2.181.0/capture-work/.capture/requests.log` | 假上游混合日志（按 UA 拆分） |
| `2.181.0/capture-work-179/.capture/outbound.log` | 2.179.0 客户端出站日志 |
