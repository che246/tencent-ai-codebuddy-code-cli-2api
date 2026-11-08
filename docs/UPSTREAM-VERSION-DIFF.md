# P0 · 2.179.0 ↔ 2.181.0 上游版本差异表

> 状态：**只读核对完成**。本轮只新增本文件，未改动项目任何业务代码、配置、凭据或运行时数据，未执行 `git commit` / `git push`（`AGENTS.md` 第 1、3 条）。
> 对应上一轮方案的 **P0 0.1（版本/产物差异）** 与 **P0 0.2（六个分歧点判定）**。

## 结论（先看这个）

**2.179.0 → 2.181.0 在网关关心的协议契约上没有破坏性变更。** 46 个关键锚点中 38 个命中数完全相同，`product.json` 全部关键字段逐项相同，9 个关键数值常量逐项相同；差异集中在「新增功能」与「引用次数增加」，不是「行为改写」。

由此修正上一轮方案里的三处判断：

1. **不存在需要迁移的版本冲突**。上一轮担心的「抓包 `/v2/chat/completions` vs 静态 `/chat/completions`」不是版本差异——两条路径在**两个版本里都同时存在**，前者是官方网关运行时路径（`classifyWbApiSource()` 正则，两版本各 3 命中），后者是自定义模型 URL 归一化路径（`withEndpointPath()`，两版本各 16 命中）。网关继续用抓包值即可，无需改。
2. **`AGENTS.md` 的问题是「权威文件表没列」，不是「产物里没有」**。`package/dist-server/types/` 与 `package/dist/web-ui/docs/` 在 2.179.0 里就存在，只是没被写入权威源清单。
3. **项目真实缺口不需要等升级**。`retry_policy`、`CODEBUDDY_MODEL_401_*`、`cache_retention` 锁档、`passthrough` 前缀策略在 **2.179.0 自身产物里就有完整实现与常量**——完全符合 `AGENTS.md` 第 0 条「先查 `package/`」的要求，P2 可以直接做。

**建议决策：继续锁定 2.179.0 作为实现基线**，把 2.181.0 作为交叉校验与前瞻参考，不做基线升级。

---

## 1. 0.1 · 版本与产物差异

| 项 | 2.179.0（项目 `package/`） | 2.181.0（本轮解包） | 判定 |
| :--- | :--- | :--- | :--- |
| `version` | `2.179.0` | `2.181.0` | 版本递增 2 个小版本 |
| `dist.shasum` | `3c63654e9f33d743d508067df24e5c3317ebfb10` | `33f44ef311102a1785853ae4711e9ef761a0afd7` | 不同；本地 `codebuddy-code-2.179.0.tgz` 的 sha1 与 registry 值一致，产物可信 |
| tarball | `codebuddy-code-2.179.0.tgz`（65.7 MB） | `tencent-ai-codebuddy-code-2.181.0.tgz`（67.6 MB） | +1.9 MB |
| `package.json` `main` / `bin` | `lib/node/index.js` / `bin/codebuddy` | 同 | 一致 |
| `dist/codebuddy.js` | 32,673,659 B | 34,832,889 B | +2,159,230 B |
| `dist/codebuddy-headless.js` | 28,227,431 B | 30,365,044 B | +2,137,613 B |
| `dist-server/codebuddy.js` | 11,499,733 B | 12,274,392 B | +774,659 B |
| `product.json` | 370,893 B | 360,286 B | -10,607 B（内容瘦身，关键字段全同，见 §3） |
| `dist-server/types/` | **存在**，1681 个 `.d.ts` basename | **存在**，1836 个 | +158 新增 / -3 移除，见 §4 |
| `dist/web-ui/docs/` | **存在** | **存在** | 两版本都自带官方文档副本 |
| `product.*.json` | 5 个环境文件齐全 | 5 个环境文件齐全 | 一致 |

**证据**：`npm view @tencent-ai/codebuddy-code@2.179.0|2.181.0 dist.shasum --json`、`sha1sum` 本地 tgz、`ls -l` 双版本产物、`2.181.0/analysis/{version-anchors,version-product,version-types}.txt`。

---

## 2. 0.2 · 六个分歧点逐条判定

| # | 分歧点 | 2.179.0 抓包 / 项目值 | 2.179.0 静态实证 | 2.181.0 静态实证 | 判定 | 处置 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **主对话路径** | `.capture/REPORT.md`：`POST /v2/chat/completions`，UA `CLI/2.179.0 CodeBuddy/2.179.0` | 正则 `\/v2\/chat\/completions` **3** 命中；字面 `/chat/completions` **16** 命中 | **3 / 16**，完全相同 | **非版本差异**：两条路径并存。官方网关走 `/v2/chat/completions`；自定义模型 URL 经 `normalizeChatCompletionsUrl()` 归一到 `/chat/completions` | 网关**不改**；修正我上一轮出站清单 C1 的路径表述，补注「两条路径，场景不同」 |
| 2 | **`hasSubstantiveContent`** | `AGENTS.md` 语义表：正文‖工具‖拒答，思考不算 | 3 命中；源码 `(eA||ed||ep)&&(ef=!0)`，`eh` 含思考 | 4 命中，逻辑相同（+1 处调用） | 语义一致 | `src/upstream/stream-guard.mjs` / Go `stream_guard.go` **无需改** |
| 3 | **`CODEBUDDY_STREAM_TIMEOUT_MS`** | `AGENTS.md`：`12e5` = 1,200,000 ms | `resolveTimeoutMs(process.env.CODEBUDDY_STREAM_TIMEOUT_MS, fs)`，`fs=12e5` | `mM=12e5, mP=12e5`，同一函数 | 数值与逻辑一致 | 无需改 |
| 4 | **`CODEBUDDY_REASONING_KEEPALIVE_INTERVAL_MS`** | CLI 默认 `0`（关闭）；网关侧 5s 已在 `stream-guard.mjs` 注释标注「网关自有策略」 | `parseInt(...)>0 ? x : 0`，1 命中 | 同一实现，1 命中 | 一致；网关 5s 标注合规 | 无需改 |
| 5 | **`authRefresh` 路径** | `src/config.mjs:71`：`{api}/v2/plugin/auth/token/refresh` | `POST /v2${prefixPath}/auth/token/refresh`，3 命中，带 `X-Refresh-Token`、`X-Auth-Refresh-Source: plugin` | 3 命中，头部完全相同（`X-Refresh-Token` 7→8 仅引用增加） | 完全一致 | 无需改；`prefixPath=/plugin` 两版本相同 |
| 6 | **错误码映射** | `src/upstream/errors.mjs` 已覆盖 `insufficient_quota`、`context_length_exceeded` | `rate_limit_exceeded→429`、`insufficient_quota→429`、`context_length_exceeded→400`、`server_error→500`（两张 Map） | 逐项相同（4/3/1/… 命中一致） | 一致 | 无需改 |

> **运行时补充（P0 0.3，见 `docs/UPSTREAM-CAPTURE-2.181.0.md`）**：对 2.181.0 与 2.179.0 做了同条件双版本抓包。两版本主对话**均为 `POST /chat/completions`**（各 3 次），完整请求头、`cache_retention: long`、body 键集逐项相同；UA 仅 `CLI/` 段随包版本变化，`CodeBuddy/2.177.1` 段两版一致。第 1 点的「两条路径并存」由静态推断升级为运行时实证；网关 `src/config.mjs` 的 `/v2/chat/completions` 属 `CODEBUDDY_BASE_URL` 覆盖语义差异，需单独确认，不是版本差异。另发现 2.181.0 的 `/v1/traces` 绕过 BASE_URL 直连真实域名，详见抓包报告 §0。

**补核 3 项**（用于判定「P2 缺口是否受版本影响」）：

| # | 项 | 2.179.0 静态 | 2.181.0 静态 | 判定 |
| :--- | :--- | :--- | :--- | :--- |
| 7 | `retry_policy` 三态 / `retry-after` | 7 命中，`forbid-retry` 阻断 Chat replay 的逻辑已存在 | 7 命中，逻辑相同 | **2.179.0 自身即有依据**，项目 `errors.mjs` 缺失是真实缺口，与版本无关 |
| 8 | `CODEBUDDY_MODEL_401_MAX_RETRIES` / `_RETRY_DELAY_MS` | `resolveModel401MaxRetries` 默认 `0`、延迟 `2e3`、上限 `32e3` | 逐项相同 | 同上，P2 2.2 可直接做 |
| 9 | `cache_retention` 会话锁档 | `BooleanUtils.isTruthy(...) ? "short" : "long"` + `latched to '...' for session` 日志 | 完全相同 | 项目 `adapters/*.mjs` 硬编码 `'long'`，缺「会话首请求锁定」语义，与版本无关 |

---

## 3. 值级常量对比（`dist/codebuddy.js` 常量段）

`version-values.txt` 中 `identical=false` 的条目**全部源于 minifier 变量名重命名**（`m7→mM`、`fA→mN`、`fc→mF`、`fh→mH`、`fd→mj`、`fp→m$`），数值逐项相同：

| 常量 | 2.179.0 | 2.181.0 | 判定 |
| :--- | :--- | :--- | :--- |
| 首 token / 流间静默超时默认 | `12e5` = 1,200,000 | `12e5` | 同 |
| 指数退避基准 / 封顶 | `1e3` = 1,000 / `32e3` = 32,000 | `1e3` / `32e3` | 同 |
| `CODEBUDDY_MAX_RETRIES` 默认 / 硬上限 | `8` / `15` | `8` / `15` | 同 |
| 自动恢复轮首 token 超时 | `3e5` = 300,000 | `3e5` | 同 |
| 401 重试延迟 / 上限 | `2e3` = 2,000 / `32e3` | `2e3` / `32e3` | 同 |
| 401 最大重试默认 | `0`（关闭） | `0` | 同 |
| `finish_reason` 宽限 / 抖动相关 | `5e3` = 5,000 / `500` | `5e3` / `500` | 同（`500` 语义未逐一确认） |
| `cache_retention` 档位 | truthy→`"short"`，否则 `"long"`，会话锁定 | 同 | 同 |
| `retry-after` / `retry_policy.retry_after` | 取更晚者、`forbid-retry` 阻断 | 同 | 同 |
| **AutoReview 停滞超时** | 无 | `resolveAutoReviewStallTimeoutMs`，`6e4` = 60,000 | **2.181.0 新增功能** |

---

## 4. 类型声明树与引用次数差异

| 项 | 2.179.0 | 2.181.0 | 说明 |
| :--- | :--- | :--- | :--- |
| `dist-server/types/` 唯一 basename 数 | 1681 | 1836 | 净 +155 |
| 新增声明 | — | 158 个 | 绝大多数是 `agent-home-*`（渠道/同事协作/任务治理）新模块；含 `handed-over-credential.d.ts`（凭据进程内移交） |
| 移除声明 | — | 3 个 | `continuation-owner.d.ts`、`harness.d.ts`、`memory-tool.d.ts` |
| 关键协议声明存在性 | 10 项中 9 项存在 | 10 项全存在 | `retry-policy`、`passthrough-header-policy`、`responses-wire`、`chat-address-layer`、`custom-headers-provider`、`sse-stream-monitor-protocol`、`query-product`、`raw-api-bodies`、`endpoint-url`、`model-provider` 两版本**都在**；仅 `handed-over-credential` 为新增 |

**引用次数增加**（非行为改写，指向 2.181.0 的增强点，供 P2 选做参考）：`CODEBUDDY_CUSTOM_HEADERS` 6→9、`apiKeyHelper` 18→19、`CODEBUDDY_CODE_API_KEY_HELPER_TTL_MS` 4→5、`CODEBUDDY_SESSION_ID` 12→14、`hasSubstantiveContent` 3→4、`X-Refresh-Token` 7→8、`X-Auth-Refresh-Source` 4→5。

**46 项完整锚点计数表**：`2.181.0/analysis/version-anchors.txt`（含 `codebuddy.js` 与 `codebuddy-headless.js` 双列）。命中数完全一致的有 38 项。

---

## 5. `product.json` 关键字段（逐项相同）

| 字段 | 两版本值 |
| :--- | :--- |
| `endpoint` / `stagingEndpoint` | `https://www.codebuddy.ai` / `https://staging-codebuddy.tencent.com` |
| `officialEndpoints` | 4 个域名白名单，完全一致 |
| `deploymentType` / `platform` | `SaaS` / `CLI` |
| `authentication.type` | `cli-external-link` |
| `authentication.attributes.prefixPath` | `/plugin` |
| `usernameHeader` / `tokenHeader` / `tokenType` | `X-User-Id` / `Authorization` / `bearerToken` |
| `iOADomain` / `cloudHostedDomain` | 4 项 / 6 项，逐项相同 |
| `models` 数量 / `relatedModels` 样例 | 22 / `{lite:"default-model", reasoning:"default-model"}` |
| `productFeatures` 数量 | 78 |
| `productConfigEnv` | `["ACC_PRODUCT_CONFIG_V3","ACC_PRODUCT_CONFIG_V2","ACC_PRODUCT_CONFIG"]` |

结论：**端点、认证域名字典、模型矩阵、特性开关全部未变**，网关的区域路由与账号域解析逻辑不需要随版本调整。

---

## 6. 对后续方案的影响（修正项）

| 上一轮方案条目 | 原表述 | 核对后修正 |
| :--- | :--- | :--- |
| P0 前提一 | 「版本基线差，可能需迁移，须先核对」 | 核对完成：**协议契约稳定，不迁移**，继续锁 2.179.0 |
| P0 前提二 | 「权威文件表漏了 types/docs（暗示产物缺失）」 | 产物两版本都有，问题是**权威表未列入**；P1 1.1 改为「补入清单」 |
| P1 1.2 | 「把常量表补齐为 2.181.0 实测值」 | 改为「以 `package/`（2.179.0）自身产物为准补齐，2.181.0 作交叉校验」——更贴合 `AGENTS.md` 第 0 条，且不引入版本依赖 |
| P2 2.1/2.2 | 隐含「等 2.181.0 依据」 | **2.179.0 自身即有完整依据**，可直接实施，优先级不变 |
| 我的出站清单 C1 | `{chatUrl}/chat/completions` | 补注：官方网关运行时为 `/v2/chat/completions`（抓包实证），`/chat/completions` 为自定义模型 URL 归一化路径，两者并存 |

**P1/P2/P3 的其余条目不受影响，按原方案执行即可。**

---

## 7. 未验证项与边界

- **P0 0.3 已完成**：见 `docs/UPSTREAM-CAPTURE-2.181.0.md`（2.181.0 与 2.179.0 同条件双版本抓包）。运行时证据强化了 0.2 的「一致」判定（两版本主对话均为 `POST /chat/completions`、头表与 `cache_retention: long` 逐项相同），并补充 `/v2/report` 触发、UA 产品段、OTLP 外连三处新发现；运行时结论以该报告为准。
- `CODEBUDDY_CUSTOM_HEADERS` 等 7 项「引用次数增加」未逐个展开新增调用点的语义，仅记录计数差异。
- 2.181.0 新增的 158 个类型声明未逐个审阅，只确认了 10 个关键协议声明的存在性。
- `500`、`1` 等辅助常量的精确语义未在切片中确认，仅记录数值相同。
- `.capture/` 的 2.181.0 复抓（P0 0.3）**已完成**，双版本运行时基线见抓包报告；认证链路、`openai-responses` 协议、企业策略端点、图片/视频生成等本次仍未触发，未覆盖项见抓包报告 §7。

---

## 8. 复现

```bash
# 在分析工作区执行（只读，不触碰目标项目）
cd D:/AI/1codebuddy_cli_agent_interface_analysis_prompt
node 2.181.0/tools/version-diff.cjs     # -> analysis/version-{anchors,product,types,179-context}.txt
node 2.181.0/tools/version-values.cjs   # -> analysis/version-values.txt
```

脚本内路径使用 `D:/AI/...` 正斜杠形式（Node on Windows 不认 `/d/AI/...`，会误解析为 `D:\d\AI\...`）。
