# 协作约定（给 AI 助手 / 协作者）

本文件记录本项目**必须遵守的协作规则**。修改代码前请先读这里。

> ## ⚠️ 最优先约束
>
> **本项目网关一定是需要基于 CLI 端实现的。**
>
> 任何网关侧行为——无论新增功能、修改逻辑还是修 Bug——都必须先在官方 CLI
> 产物中找到对应的实现、常量或语义，然后照着它来做。**没有 CLI 依据的实现
> 视为不合格，不得交付。**
>
> 细则见下方「第 0 条」与「第 2 条」。

---

## 0. 一切以实现 CLI 端为唯一依据（最高优先级）

**本项目 = 腾讯 CodeBuddy CLI 的协议复刻。网关不是独立产品，是 CLI 行为的等价投影。**

### 强制要求

1. **动手前先查 CLI**：任何改动开始前，必须先在 `package/` 中找到对应实现。
2. **以源码为准，不以文档/猜测/经验为准**：注释、变量名、默认值、分支条件，
   一律从 CLI 源码读出来，不得凭印象填写。
3. **找不到依据 → 停下来问**，或明确标注为「网关自有策略」并说明理由，
   不得默默按自己的想法实现。
4. **数值必须可追溯**：每个超时/间隔/重试次数/阈值，都必须在注释里写清
   对应的 CLI 变量名或代码位置。
5. **语义必须对齐**：不仅是数值，判定条件、状态机、错误分类也要与 CLI 一致。
   例：CLI 不把「缺少 finish_reason」当错误，网关也不得那样判。

### 权威文件（按优先级）

| 优先级 | 文件 | 说明 |
|---|---|---|
| 1 | `package/dist/codebuddy-headless.js` | CLI 实际执行体（26.9 MB），流式/重试/超时的真实实现 |
| 2 | `package/dist/codebuddy.js` | CLI 交互入口 |
| 3 | `package/dist-server/codebuddy.js` | 服务端版本（与 headless 同源） |
| 4 | `package/product.json` | 模型矩阵与产品配置 |
| 5 | `package/CHANGELOG.md` | 行为变更记录，可佐证实现意图 |

### 已实测的 CLI 常量与语义

见下方「第 2 条」，其中常量表和空流判定语义**可直接引用**。

### 违反示例（禁止）

- ❌ 「上游一般 1~3 秒响应，30 秒超时应该够了」 → 凭经验
- ❌ 「用 90 秒静默超时比较常见」 → 抄别的项目
- ❌ 「缺少 finish_reason 肯定是断流」 → 未核对 CLI 语义
- ✅ 「CLI `CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS` 默认 `12e5`，网关同步为 1200000ms」

---

## 1. 严禁自主提交 / 推送 GitHub

**只有用户明确说「提交」「推送」「push」「同步到 GitHub」时才执行 `git commit` / `git push`。**

- 改完代码 → 停在「工作区已修改」状态，向用户汇报改动内容，等待指示。
- 不得因为「改动做完了」「看起来完整了」「顺手提交一下」就自行 commit。
- 不得自行 `git add` 后直接 commit；`git add` 只作为 commit 前的准备动作，
  且同样需要用户先给出提交指令。
- 用户没说提交，就不要碰 `git commit`、`git push`、`git tag`、`git reset` 等
  改写历史或同步远端的操作。

**允许的操作**：`git status`、`git diff`、`git log` 等只读查看命令，随时可用。

---

## 2. 网关行为必须以 CLI 端为依据

本项目网关是 **腾讯 CodeBuddy CLI 的协议复刻**，不是凭想象实现的产品。

- 依据来源：`package/` 目录下的官方 CLI 产物，重点文件
  `package/dist/codebuddy-headless.js`（CLI 实际执行体）。
- 涉及**流式处理、超时、重试、错误判定、请求头、协议字段**的改动，
  必须先在 CLI 源码里找到对应实现与常量，再据此实现网关侧逻辑。
- **禁止凭经验拍脑袋取值**。若确实需要网关自有策略，必须在代码注释与
  汇报中明确标注「网关自有策略，无 CLI 对应实现」并说明理由。
- 已知 CLI 常量（源码实测）：

  | 项 | 值 | 来源 |
  |---|---|---|
  | 首 token 超时 | `12e5` = 1,200,000 ms | `CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS` |
  | 流总时长 | `12e5` = 1,200,000 ms | `CODEBUDDY_STREAM_TIMEOUT_MS` |
  | 空流重试窗口 | `3e5` = 300,000 ms | `mb` |
  | finish_reason 宽限 | `5e3` = 5,000 ms | `tf` |
  | 请求最大重试 | 8（硬上限 15） | `mC` / `mv` |
  | 思考期保活 | 默认 `0`（关闭） | `CODEBUDDY_REASONING_KEEPALIVE_INTERVAL_MS` |

- CLI 的空流判定语义（`hasSubstantiveContent`）：

  ```
  hasContent            = 正文 || 思考 || 工具 || 拒答    // 思考也算"活着"
  hasSubstantiveContent = 正文 || 工具 || 拒答            // 思考不算"实质产出"
  emptyStreamKind       = hasSubstantiveContent ? null
                        : hasReasoning ? 'reasoning-only' : 'no-token'
  ```

  **CLI 不把「缺少 finish_reason」当错误**，只判定有没有实质产出。
  网关侧同一逻辑实现在 `src/upstream/stream-guard.mjs` 的
  `createDeltaClassifier()`。

---

## 3. 敏感文件与本地工具不入库

以下内容已在 `.gitignore` 中排除，**任何情况下都不要提交**：

### 含明文凭据

- `accounts.json`（含 accessToken / refreshToken）
- `config.json`（含 apiKey / webPassword）
- `accounts*.json` 变体
- `backups/`（备份目录，内部含 accounts/config 镜像，严禁入库）

### 打包与部署产物

- `_dist/`（打包产物，内部含账号备份）
- `pack.ps1`（**本地打包工具，不上传 GitHub**）
- `tools/`（**本地打包辅助脚本，不上传 GitHub**）
- `DEPLOY.md`（局域网部署记录，含内网 IP 与主机信息）

### 调试与运行期

- `.capture/`（抓包与调试日志）
- `product.json`（上游模型快照，启动时自动生成）
- `_run.out` / `_run.err`

提交前用 `git status` 复核暂存清单，确认没有上述文件。

> **打包工具规则**：`pack.ps1` 与 `tools/` 属于本地发布流程的一部分，
> 只在当前开发机使用，不进入公开仓库。修改它们无需提交；
> 若已在历史中被跟踪，用 `git rm --cached` 移出但保留本地文件。

---

## 4. 改动验证要求

- 修改网关代码后需重启进程才能生效（用户自己跑着的实例不要随意 kill）。
- 涉及流式/超时的改动，需给出可复现的验证结果（日志计数、抓流数据），
  而不是只说「已修复」。
- 回归检查项：客户端断开误报、静默超时、补截断终态、异常数、
  账号 `inFlight` 是否归零。
