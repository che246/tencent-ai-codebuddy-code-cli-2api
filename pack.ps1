# ─────────────────────────────────────────────────────────────────────────────
# CodeBuddy 网关打包脚本
#   .\pack.ps1            生成发布包（含账号与配置）
#   .\pack.ps1 -NoSecrets 生成发布包（不含账号，仅模板）
# ─────────────────────────────────────────────────────────────────────────────
param(
  [switch]$NoSecrets
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Name = "codebuddy-gateway-$Stamp"
$Stage = Join-Path $Root "_dist\$Name"
$OutZip = Join-Path $Root "_dist\$Name.zip"

Write-Host "`n=== CodeBuddy 网关打包 ===" -ForegroundColor Cyan
Write-Host "  源目录 : $Root"
Write-Host "  输出   : $OutZip"
Write-Host ""

# ─── 1. 清理并创建暂存目录 ──────────────────────────────────────────────────
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

# ─── 2. 复制运行必需的源码 ──────────────────────────────────────────────────
Write-Host "[1/6] 复制源码..." -ForegroundColor Yellow
$dirs = @('src')
foreach ($d in $dirs) {
  $src = Join-Path $Root $d
  if (-not (Test-Path $src)) { throw "缺少目录: $d" }
  Copy-Item $src -Destination (Join-Path $Stage $d) -Recurse -Force
}

$files = @('gateway.mjs', 'package.json', 'product.json', 'README.md', 'LICENSE')
foreach ($f in $files) {
  $src = Join-Path $Root $f
  if (Test-Path $src) {
    Copy-Item $src -Destination (Join-Path $Stage $f) -Force
  } else {
    Write-Host "      跳过（不存在）: $f" -ForegroundColor DarkGray
  }
}

# 模型矩阵：仅依赖根目录 product.json
# 该文件在网关运行时由上游 /v3/config 自动同步写入，不再引用 package/ 目录。
if (-not (Test-Path (Join-Path $Root 'product.json'))) {
  throw "缺少 product.json，请先启动一次网关让其从上游同步模型矩阵"
}

# Docker 支持（可选）
foreach ($f in @('Dockerfile', 'docker-compose.yml')) {
  $src = Join-Path $Root $f
  if (Test-Path $src) { Copy-Item $src -Destination (Join-Path $Stage $f) -Force }
}

# ─── 3. 账号与配置 ───────────────────────────────────────────────────────────
Write-Host "[2/6] 处理账号与配置..." -ForegroundColor Yellow

if ($NoSecrets) {
  # 只放模板，强制目标机器自行填写
  Copy-Item (Join-Path $Root 'accounts.example.json') -Destination (Join-Path $Stage 'accounts.json') -Force
  Copy-Item (Join-Path $Root 'config.example.json')   -Destination (Join-Path $Stage 'config.json') -Force
  Write-Host "      模式: 不含凭据（使用 example 模板）" -ForegroundColor Green
} else {
  if (-not (Test-Path (Join-Path $Root 'accounts.json'))) { throw "缺少 accounts.json" }
  Copy-Item (Join-Path $Root 'accounts.json') -Destination (Join-Path $Stage 'accounts.json') -Force
  if (Test-Path (Join-Path $Root 'config.json')) {
    Copy-Item (Join-Path $Root 'config.json') -Destination (Join-Path $Stage 'config.json') -Force
  }
  # 账号数统计（用 node 解析，避免 PowerShell 的 GBK 默认编码破坏 UTF-8 JSON；
  # 且只统计数量，绝不打印任何凭据内容）
  $cnt = & node -e "const fs=require('fs');const a=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log(Array.isArray(a)?a.length:(a.accounts||[]).length)" (Join-Path $Root 'accounts.json')
  if ($LASTEXITCODE -ne 0) { throw "accounts.json 解析失败，请检查 JSON 格式" }
  Write-Host "      模式: 含账号凭据（$cnt 个账号）" -ForegroundColor Green
}

# ─── 4. 生成目标机器的一键启动脚本 ───────────────────────────────────────────
Write-Host "[3/6] 生成启动脚本..." -ForegroundColor Yellow

$startPs1 = @'
# CodeBuddy 网关一键启动（Windows）
# 用法: .\start.ps1
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

# Node 版本检查
try {
    $v = (node -v) -replace '^v',''
    $major = [int]($v.Split('.')[0])
    if ($major -lt 22) {
        Write-Host "Node.js 版本过低: v$v （需要 >= 22，推荐 24）" -ForegroundColor Red
        Write-Host "下载: https://nodejs.org/" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "Node.js v$v" -ForegroundColor Green
} catch {
    Write-Host "未找到 node 命令，请先安装 Node.js >= 22" -ForegroundColor Red
    Write-Host "下载: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# 首次运行提示
if (-not (Test-Path (Join-Path $here 'accounts.json'))) {
    Write-Host "缺少 accounts.json，请先填写账号信息" -ForegroundColor Red
    exit 1
}

Write-Host "启动 CodeBuddy 网关..." -ForegroundColor Cyan
Set-Location $here
node gateway.mjs
'@

$startSh = @'
#!/usr/bin/env bash
# CodeBuddy 网关一键启动（Linux / macOS）
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node，请先安装 Node.js >= 22（推荐 24）"
  echo "下载: https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 版本过低: $(node -v)（需要 >= 22）"
  exit 1
fi

if [ ! -f accounts.json ]; then
  echo "缺少 accounts.json，请先填写账号信息"
  exit 1
fi

echo "Node.js $(node -v)"
echo "启动 CodeBuddy 网关..."
exec node gateway.mjs
'@

# UTF-8 BOM 保证 Windows PowerShell 正确解析中文
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText((Join-Path $Stage 'start.ps1'), $startPs1, $utf8Bom)

# sh 不能带 BOM
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $Stage 'start.sh'), ($startSh -replace "`r`n", "`n"), $utf8NoBom)

# ─── 5. 生成部署说明 ─────────────────────────────────────────────────────────
Write-Host "[4/6] 生成部署说明..." -ForegroundColor Yellow

$readme = @"
# CodeBuddy 网关 · 部署包

本包自带账号凭据与配置，拷贝到目标机器即可运行。
支持 **国内版（copilot.tencent.com）** 与 **国际版（www.codebuddy.ai）** 账号混跑，
按账号 ``region`` 字段自动选择上游，模型名以 ``cn:`` / ``intl:`` 前缀区分。

## 环境要求

- **Node.js >= 22**（推荐 24.x）
  - 依赖 ``node:sqlite``（Node 22+ 才内置）
  - 下载: https://nodejs.org/
- 无需 ``npm install``：项目零外部依赖，全部使用 Node 内置模块
- **网络**：国内版需可访问 ``copilot.tencent.com`` / ``codebuddy.cn``；
  国际版需可访问 ``codebuddy.ai``。只用其中一版时，仅需放通对应域名。

## 启动后先看横幅

启动会在控制台打印实际生效的区域与账号构成，例如：

```
🚀 CodeBuddy 国内版 + 国际版 双区域生产级多协议网关已启动!
👥 账号池: 共 4 个（国内版 3 个 / 国际版 1 个）
🌍 上游区域: 国内版 https://copilot.tencent.com | 国际版 https://www.codebuddy.ai
🏷️  模型区隔: cn:<模型> 走国内版，intl:<模型> 走国际版
```

横幅内容由 ``accounts.json`` 里各账号的 ``region`` 实时推导，不是写死的文案：
只放国内版账号就显示「国内版」，只放国际版就显示「国际版」。

## 快速启动

### Windows

``````powershell
.\start.ps1
``````

如遇执行策略拦截：

``````powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
``````

### Linux / macOS

``````bash
chmod +x start.sh
./start.sh
``````

### 直接运行（任意平台）

``````bash
node gateway.mjs
``````

## 访问

- 控制台: http://127.0.0.1:8317
- API 基址: http://127.0.0.1:8317/v1

默认 API Key 与 Web 密码见 ``config.json``（``apiKey`` / ``webPassword``）。
**建议首次启动后立即修改。**

## 验证

``````bash
curl http://127.0.0.1:8317/v1/models -H "Authorization: Bearer <你的 apiKey>"
``````

返回的每条模型都带区域前缀与 ``region`` / ``region_label`` 字段：

- ``cn:deepseek-v4.1-flash`` → 走国内版
- ``intl:gpt-6-astra`` → 走国际版

带前缀调用会锁定账号区域，避免跨区选号导致 401。

## 目录说明

| 路径 | 作用 | 是否可删 |
|---|---|---|
| ``gateway.mjs`` | 入口 | 否 |
| ``src/`` | 全部业务代码 | 否 |
| ``product.json`` | 模型矩阵（启动时自动从上游同步，含 regions 标记） | 否 |
| ``accounts.json`` | 账号与令牌（含 ``region`` 字段） | 否（敏感） |
| ``config.json`` | 运行配置 | 否 |
| ``gateway.log`` | 运行日志 | 可删（自动重建） |
| ``logs.db`` | 日志数据库 | 可删（自动重建） |
| ``stats.json`` | 统计计数 | 可删（自动重建） |

### 双区域要点

- **token 不通用**：国内 token 打国际版 chat 一律 401，反之亦然。账号的 ``region``
  必须与 token 签发域一致；也可由 ``endpoint`` 含 ``codebuddy.ai`` 自动推断为国际版。
- **国际版需要首条 system 消息**：缺失会返回 ``400 code=11128``。网关已自动补齐，无需干预。
- **国际版无签到功能**：签到巡检会自动跳过，日志中会显示跳过数量，不是错误。
- **模型集合不同**：国际版额外含 ``gpt-6-astra`` / ``grok-4.7`` / ``gemini-3.8-flash`` 等；
  免费账号（``personal_free_user``）调用这些模型会返回 ``403 model_not_allowed`` 并冷却 1 小时。

### 降级链跨区编排

``config.json`` 的 ``modelFallback`` 键值都支持 ``cn:`` / ``intl:`` 前缀，可实现
「国内版主模型限流 → 自动切到国际版备用模型」：

``````json
{
  "modelFallback": {
    "deepseek-v4.1-flash": ["intl:deepseek-v4.1-flash-sg"]
  }
}
``````

### 模型矩阵如何更新

``product.json`` 里的 ``models`` 字段会在网关启动、且上游可达时**自动覆盖写入**，
无需手工维护。若目标机器完全离线，则沿用打包时的快照。

想强制立即刷新（会同时写回 product.json）：

``````bash
curl "http://127.0.0.1:8317/api/models-detail?refresh=1"
``````

## 端口冲突

改 ``config.json`` 里的 ``port`` 即可。

## 常见问题

**Q: 启动报 ``SQLite is an experimental feature``**
A: 正常提示，不影响运行。

**Q: 报 ``Cannot find module 'node:sqlite'``**
A: Node 版本低于 22，升级 Node。

**Q: token 过期**
A: 网关会自动刷新（``config.json`` 的 ``autoCheckin`` / ``tokenRefreshAdvanceDays``）。
   若 refreshToken 也失效，需在源机器重新登录后重新打包 accounts.json。

**Q: 想换机器迁移**
A: 整个目录拷走即可。``logs.db`` / ``stats.json`` / ``gateway.log`` 可选择性不拷。

## 安全提示

本包含明文 ``accounts.json``（accessToken + refreshToken）。
- 不要上传到公开仓库
- 不要通过不安全的渠道传输
- 用完及时删除中间副本
"@

[System.IO.File]::WriteAllText((Join-Path $Stage '部署说明.md'), $readme, $utf8Bom)

# ─── 6. 校验并压缩 ──────────────────────────────────────────────────────────
Write-Host "[5/6] 校验打包完整性..." -ForegroundColor Yellow

# 关键文件存在性
$required = @('gateway.mjs', 'package.json', 'accounts.json', 'config.json', 'product.json',
              'src\server.mjs', 'src\config.mjs', 'src\web\public\index.html')
foreach ($r in $required) {
  $p = Join-Path $Stage $r
  if (-not (Test-Path $p)) { throw "打包缺少关键文件: $r" }
}

# 统计
$srcFiles = (Get-ChildItem (Join-Path $Stage 'src') -Recurse -File).Count
Write-Host "      src 文件数: $srcFiles"

# 模型矩阵校验（来自 product.json，由上游自动同步）
$modelCount = & node -e @"
const fs=require('fs'),path=require('path');
const p=path.join(process.argv[1],'product.json');
if(!fs.existsSync(p)){console.log(0);process.exit(0)}
try{const j=JSON.parse(fs.readFileSync(p,'utf8'));console.log((j.models||[]).length);}catch(e){console.log(0)}
"@ $Stage
Write-Host "      模型矩阵: $modelCount 款" -ForegroundColor $(if ([int]$modelCount -ge 20) { 'Green' } else { 'Red' })
if ([int]$modelCount -lt 20) {
  throw "product.json 模型数异常（$modelCount 款），请在源机器先启动网关完成上游同步"
}

# 语法自检（在暂存目录里实际跑一次导入）
$checkScript = Join-Path $Stage '_selfcheck.mjs'
@'
try {
  await import('./src/server.mjs');
  console.log('IMPORT_FAILED_SHOULD_NOT_REACH_SERVER');
} catch (e) {
  // 走到这里说明模块能加载（server.mjs 会 listen，正常不会返回）
  console.log('SELFCHECK_ERROR: ' + e.message);
}
'@ | Set-Content -Path $checkScript -Encoding utf8

$checkOut = & node --check (Join-Path $Stage 'gateway.mjs') 2>&1
if ($LASTEXITCODE -ne 0) {
  Remove-Item $checkScript -Force -ErrorAction SilentlyContinue
  throw "gateway.mjs 语法检查失败: $checkOut"
}
Remove-Item $checkScript -Force -ErrorAction SilentlyContinue

# 逐个检查 src 语法
Get-ChildItem (Join-Path $Stage 'src') -Recurse -File -Include *.mjs | ForEach-Object {
  $o = & node --check $_.FullName 2>&1
  if ($LASTEXITCODE -ne 0) { throw ("语法错误: " + $_.Name + " -> " + $o) }
}
Write-Host "      语法检查通过" -ForegroundColor Green

Write-Host "[6/6] 压缩..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path (Split-Path $OutZip) | Out-Null
if (Test-Path $OutZip) { Remove-Item $OutZip -Force }
Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $OutZip -CompressionLevel Optimal

$sizeKB = [math]::Round((Get-Item $OutZip).Length / 1KB, 1)

Write-Host ""
Write-Host "=== 打包完成 ===" -ForegroundColor Green
Write-Host "  文件: $OutZip"
Write-Host "  大小: $sizeKB KB"
Write-Host "  模式: $(if ($NoSecrets) { '不含凭据' } else { '含账号凭据' })"
Write-Host ""
Write-Host "部署到新机器:" -ForegroundColor Cyan
Write-Host "  1. 解压 zip"
Write-Host "  2. 确认已安装 Node.js >= 22"
Write-Host "  3. 运行 start.ps1 (Windows) 或 ./start.sh (Linux/macOS)"
Write-Host ""
