# CodeBuddy 协议网关公网暴露安全审计与加固方案

> **状态**：方案已评审归档（待按需实施）  
> **归档日期**：2026-11-22  
> **适用场景**：将本项目从局域网/内网环境开放至公网（如云服务器、公网 IP 映射、内网穿透或 Cloudflare 隧道）

---

## 一、审计背景与架构特点

本项目为**腾讯 CodeBuddy CLI 的生产级协议复刻网关**，向下游客户端（OpenAI / Anthropic 协议、Chatbox、NextChat、Claude Code 等）提供兼容接口，向上游腾讯 AI 服务集群进行多账号轮换调度与协议转换。

在内网/局域网环境下运行时，网络边界相对可控；但在**开放至公网**时，攻击面显著扩大，包括：
1. **直接暴露 HTTP 服务**：恶意网络扫描、中间人嗅探、慢速 DoS 攻击。
2. **账号资产与额度风险**：上游绑定的多账号积分与配额极易被恶意下游调用刷空或触发封禁。
3. **管理控制台暴露**：未加严格防御的管理接口（`/api/*`）可能面临爆破、大包 OOM 攻击或权限提升。

---

## 二、核心风险评级矩阵 (P0 ~ P3)

| 风险等级 | 风险分类 | 涉及代码位置 | 核心风险与危害说明 | 修复优先级 |
|---|---|---|---|---|
| **P0 严重** | 权限控制 / 越权风险 | `src/web/routes.mjs:50-65` | 若未独立配置 `webPassword`，网关自动降级允许任意有效 `apiKey` 登录 Web 控制台。下游普通调用方可接管后台，窃取全部密钥、导出他人聊天日志、删除上游账号。 | 最高 (紧急) |
| **P0 严重** | 配额防护 / DoS 风险 | `src/server.mjs:120-156` | 缺少针对下游客户端的限流器 (Rate Limiter)。单 Key 或未授权 IP 可高频爆刷，瞬间耗尽账号池全部账号积分配额，或触发腾讯官方频控封禁。 | 最高 (紧急) |
| **P1 高危** | 资源耗尽 / 内存溢出 | `src/web/routes.mjs:110, 219, 405...` | `/v1/*` 具备 50MB 保护，但 `/api/auth/login`、`/api/settings` 等管理接口采用原生流拼接且无体积上限。攻击者发送巨量请求体可触发 Node.js 堆内存溢出 (OOM) 导致服务崩溃。 | 高 |
| **P1 高危** | 身份认证 / 弱防线 | `src/web/routes.mjs:109-138` | `/api/auth/login` 接口无防爆破机制，无单 IP 连续失败锁定或节流，攻击者可通过自动化字典持续暴力枚举密码。 | 高 |
| **P1 高危** | 传输安全 / 暴露面 | `src/server.mjs:228` | 网关默认绑定监听 `0.0.0.0:8317`（明文 HTTP）。公网传输未加密，API Key、聊天上下文及 Token 易被中间人截获嗅探。 | 高 |
| **P1 高危** | 跨域与浏览器安全 | `src/server.mjs:98-100` | 全局无条件返回 `Access-Control-Allow-Origin: *`，且缺失 `X-Frame-Options`（点击劫持）、`Content-Security-Policy`、`HSTS` 等现代安全标头。 | 高 |
| **P2 中危** | 敏感信息泄露 | `src/web/routes.mjs:184-214` | `GET /api/settings` 回显明文 `webPassword`、全量 API 密钥列表以及服务器绝对路径 `rootDir`，便于攻击者侦察系统结构。 | 中 |
| **P2 中危** | 凭据传递不当 | `src/web/routes.mjs:159` | 允许在 URL Query 参数中携带 Token（`?token=xxx`）。敏感凭据极易遗留在反代访问日志、浏览器历史与 Referer 标头中。 | 中 |
| **P2 中危** | 进程特权与沙箱 | `codebuddy-gateway.service` | Linux 守护进程未显式指定运行用户，默认以 `root` 特权身份运行，缺乏文件系统与特权隔离保护。 | 中 |
| **P3 低危** | 侧信道时序泄露 | `src/config.mjs:416` | `safeCompareTokens` 在 `crypto.timingSafeEqual` 前先比对字符串长度，存在理论上的长度时序泄露。 | 低 |

---

## 三、代码级安全加固改造方案

### 1. 访问控制与角色绝对隔离
- **禁止 API Key 登录后台**：
  - 重构 `verifyWebAuthToken(token)`：Web 控制台必须使用独立的 `webPassword`，若未配置，默认拒绝所有外部登录，或仅允许 `127.0.0.1` 访问。
  - 普通业务 `apiKey` 仅能调用 `/v1/*` 接口，无权访问任何 `/api/*` 管理路由。
- **管理路由分离与外网屏蔽开关**：
  - 新增配置项 `disablePublicWebConsole: true`（若开启，非本机请求 `/` 和 `/api/*` 直接返回 404 或 403）。

### 2. 下游限流保护与防暴力破解系统 (Rate Limiting)
- **登录防爆破 (Anti-Brute-Force)**：
  - 内存记录 IP 维度的登录失败计数器；
  - 10 分钟内连续失败 5 次，锁定该 IP 15 分钟并记录安全审计日志。
- **下游双重令牌桶限流器**：
  - **未鉴权 IP 限流**：限制每分钟最多 30 次未鉴权探测请求，防止高频嗅探与 CPU 耗尽。
  - **API Key 级限流**：针对 `/v1/chat/completions`、`/v1/messages` 接口，按 Key 限制默认每分钟 60 次请求、突发并发 5，防止单客户端刷爆所有上游账号。
  - **高开销接口独立阈值**：对 `/v1/search` 和 `/v1/fetch` 接口单独配置严格速率（如 20 次/分钟）。

### 3. 统一请求体容量守卫 (抗 DoS / 抗 OOM)
- 将 `src/server.mjs` 中的 `readRequestBody` 守卫覆盖到所有管理路由：
  - 通用管理接口（登录、改密、更新配置）：限制最大 Body 为 **2 MB**。
  - 账号导入接口（`/api/accounts/import`）：限制最大 Body 为 **10 MB**。
  - 超出限制直接 `req.destroy()` 终止连接，杜绝内存堆溢出。

### 4. 敏感数据脱敏与凭据规范
- **配置接口回显脱敏**：
  - `GET /api/settings` 中，`webPassword` 无论是否配置均仅回显 `******` 或布尔标志；
  - 掩码展示非当前活跃的 API Keys；
  - 移除 `rootDir` 宿主机绝对路径。
- **彻底废除 Query 传参 Token**：
  - 移除 `url.searchParams.get('token')` 逻辑；
  - 日志导出改为前端以 `fetch` 携带 `Authorization: Bearer` 方式下载，或颁发有效期 30 秒的一次性短随机 Ticket。

### 5. CORS 收敛与现代安全标头体系
- 仅对 `/v1/*` 开放必要的跨域能力；
- 控制台页面及 `/api/*` 限制为同源访问；
- 全局注入浏览器防护标头：
  - `X-Frame-Options: DENY`（防御点击劫持）
  - `X-Content-Type-Options: nosniff`（防御 MIME 嗅探）
  - `Referrer-Policy: strict-origin-when-cross-origin`（防止外链泄漏请求上下文）
  - 生产环境下启用 `Strict-Transport-Security: max-age=31536000; includeSubDomains`（强制 HSTS）

---

## 四、基础设施与运维层加固规范

### 1. 网络监听与隔离
- **禁止网关直接绑定 `0.0.0.0`**：
  - 修改 `src/server.mjs` 或 `config.json`，设置监听地址为 `127.0.0.1`（仅允许宿主机本地回环访问）。
  - 外部所有流量必须通过前置反向代理（Nginx / Caddy）接入。

### 2. Nginx 反向代理配置最佳实践 (强制 HTTPS + 流式无缓冲)

```nginx
# /etc/nginx/conf.d/codebuddy.conf
server {
    listen 80;
    server_name api.yourdomain.com;
    return 301 https://$host$request_uri; # 强制全站 HTTPS
}

server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    # SSL 证书
    ssl_certificate /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # 安全响应头
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # 1. 对外开放的标准推理 API 路由 (开启 SSE 流式无缓冲)
    location ~ ^/(v1/|messages|search|fetch) {
        proxy_pass http://127.0.0.1:8317;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE / 流式输出核心参数（防止 Nginx 缓冲导致卡字）
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1200s;
        proxy_send_timeout 1200s;
        chunked_transfer_encoding on;
    }

    # 2. Web 控制台与管理接口 (建议加 IP 白名单或 HTTP Basic Auth 二次防护)
    location / {
        # 若需要限制仅管理员可访问控制台，取消下方注释：
        # allow 1.2.3.4;  # 管理员公网 IP
        # deny all;

        proxy_pass http://127.0.0.1:8317;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 3. Linux Systemd 守护进程安全沙箱 (非 root 降权)

修改 `/etc/systemd/system/codebuddy-gateway.service`：

```ini
[Unit]
Description=CodeBuddy 2API Gateway (Hardened)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# 降低特权运行身份（创建专用的无特权服务用户）
User=node_code
Group=node_code
WorkingDirectory=/home/node_code/codebuddy-code
ExecStart=/usr/local/bin/node /home/node_code/codebuddy-code/gateway.mjs
Restart=always
RestartSec=5
StandardOutput=append:/home/node_code/codebuddy-code/gateway.out
StandardError=append:/home/node_code/codebuddy-code/gateway.err
Environment=NODE_ENV=production

# 资源上限防护
LimitNOFILE=65535

# Systemd 安全沙箱指令
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

---

## 五、后续实施路线与阶段划分

当需要启动公网暴露加固时，按以下两阶段落地：

1. **阶段一（代码层安全防护）**：
   - 权限解耦：强制 `webPassword` 独立校验，剔除 API Key 接管后台漏洞；
   - 接口守卫：实现登录失败惩罚锁定（防爆破）与 `/api/*` 请求体体积限制；
   - 接口脱敏：脱敏 settings 数据并废弃 URL Query 传 Token；
   - 下游限流：实现基于 IP 与 API Key 的内存令牌桶限流。
2. **阶段二（网络与运维落地）**：
   - 本地绑定：将网关改绑为 `127.0.0.1`；
   - 配置反代：在远程主机部署 Nginx / Caddy 并申请 Let's Encrypt SSL 证书；
   - 进程降权：更新远程 Systemd 服务配置为安全沙箱模式并重载。
