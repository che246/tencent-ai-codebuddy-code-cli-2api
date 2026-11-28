# CodeBuddy 网关 · Go 版（`golang/`）

Node.js 版（`src/`）的等价 Go 实现，包结构按依赖方向分层：

```
cmd/gateway            启动装配（gateway.mjs + server.mjs 的启动段）
internal/config        config.json / accounts.json / 多密钥 / 黑名单 / 策略
internal/core/database SQLite 日志与积分流水（modernc.org/sqlite，纯 Go，无 CGO）
internal/core/logger   日志器（SQLite + 环形缓冲 + gateway.log）
internal/core/tlscerts 官方同款 TLS 根证书栈
internal/upstream      官方协议：请求头 / gzip / 错误码 / 模型矩阵 / 流守卫 / CLI 常量
internal/core/scheduler 账号调度、粘性会话、积分刷新、每日打卡
internal/core/metrics  用量统计与报表
internal/core/pricing  模型定价与联网检索官网价格
internal/adapters      OpenAI / Anthropic 协议转译 + 联网检索/抓取
internal/web           HTTP 路由总线、API Key 鉴权、控制台鉴权、/api/*、前端 embed
```

所有超时 / 重试 / 阈值常量都在注释里标注 `// CLI: <变量名>=<值>` 或「网关自有策略，无 CLI 对应实现」，与根目录 `AGENTS.md` 第 0/2 条一致。

## 构建与运行

```powershell
cd golang
go build -o gateway.exe ./cmd/gateway
.\gateway.exe                      # 默认监听 config.port || 8317，数据目录 = 可执行文件所在目录
```

- 数据目录可通过环境变量 `GW_DATA_DIR` 指定；`config.json` / `accounts.json` / `logs.db` / `stats.json` / `pricing.json` 均放在该目录，与 Node 版**同格式、可直接共用**。
- 依赖：Go ≥ 1.22，唯一第三方依赖 `modernc.org/sqlite`（纯 Go，无需 CGO / gcc）。
- 前端：`internal/web/public/` 是 `src/web/public/` 的原样拷贝，通过 `go:embed` 打进二进制；修改前端后需同步拷贝并重新编译。

## 测试

```powershell
go vet ./...
go test -race -timeout 300s ./...
gofmt -l .
```

覆盖：upstream（请求头 / 错误码 / 载荷 / 流守卫）、scheduler（选号 / 粘性 / 冷却 / 打卡 / 刷新）、metrics、pricing、database、logger、adapters（JS 语义工具 / SSE 扫描 / 工具调用合并 / Anthropic 转译）、web（鉴权 / 设置 / 密钥 / 账号 / 日志 / 统计 / 模板渲染 / 请求体限额）。测试不出网。

## 与 Node 版的已知差异

| 项 | Node | Go | 说明 |
|---|---|---|---|
| `config.json` 键序 | 插入序 | 字母序 | `Config.MarshalJSON` 经 map 输出，语义等价 |
| `expiresAtFmt` | `toLocaleDateString()` 随系统区域 | 固定 `YYYY/M/D` | 对应 zh-CN 区域输出 |
| 进程级异常兜底 | `unhandledRejection` 钩子 | HTTP 总线 `recover` + 后台任务 `safeGo` | 单请求异常不打挂进程 |
| 前端静态文件 | 运行时读盘 + `@include` 拼装 | 编译期 `go:embed` + 首次请求拼装 | 改前端需重新编译 |
