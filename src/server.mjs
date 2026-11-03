import http from 'node:http';
import { config, accounts, saveAccounts, saveConfig } from './config.mjs';
import { Logger } from './core/logger.mjs';
import { TlsCertificateStack } from './core/tls-certs.mjs';
import { AccountScheduler } from './core/scheduler.mjs';
import { handleOpenAiModels, handleOpenAiChatCompletions } from './adapters/openai.mjs';
import { handleAnthropicMessages } from './adapters/anthropic.mjs';
import { handleSearch, handleWebFetch } from './adapters/tools.mjs';
import { handleDashboard, handleApiRoutes } from './web/routes.mjs';
import { saveStatsSync } from './core/metrics.mjs';

// 0. 优雅停机与进程退出数据保护钩子 (杜绝重启/强制终止时丢失统计与配置数据)
function flushAllOnShutdown() {
  try {
    saveStatsSync();
    saveAccounts();
    saveConfig();
  } catch (_) {}
}
process.on('SIGINT', () => {
  flushAllOnShutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  flushAllOnShutdown();
  process.exit(0);
});
process.on('beforeExit', () => {
  flushAllOnShutdown();
});

// 1. 初始化官方同款 TLS 证书栈
TlsCertificateStack.init();

// 2. HTTP 服务与路由总线
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // 1. Web 控制台静态单页
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return handleDashboard(req, res);
  }

  // 2. 探活路由
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', activeAccounts: accounts.filter(a => a.status === 'healthy').length }));
  }

  // 3. API 鉴权 (同时支持 Authorization: Bearer 和 x-api-key)
  const isApiPath = url.pathname.startsWith('/v1/') || url.pathname === '/messages' || url.pathname === '/search' || url.pathname === '/fetch';
  if (isApiPath) {
    const authHeader = req.headers['authorization'] || '';
    const xApiKey = req.headers['x-api-key'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '') || xApiKey;
    if (config.apiKey && token !== config.apiKey) {
      Logger.warn('AUTH', `非法 API Key 访问: ${url.pathname}`, { ip: req.socket.remoteAddress });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid API Key', type: 'auth_error' } }));
    }
  }

  // 4. GET /v1/models (标准 OpenAI 模型列表)
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return handleOpenAiModels(req, res);
  }

  // 5. 官方免费服务端联网检索: POST /v1/search & POST /search
  if (req.method === 'POST' && (url.pathname === '/v1/search' || url.pathname === '/search')) {
    let rawBody = '';
    req.on('data', c => rawBody += c);
    req.on('end', () => handleSearch(req, res, rawBody));
    return;
  }

  // 6. 官方免费服务端网页抓取: POST /v1/fetch & POST /fetch
  if (req.method === 'POST' && (url.pathname === '/v1/fetch' || url.pathname === '/fetch')) {
    let rawBody = '';
    req.on('data', c => rawBody += c);
    req.on('end', () => handleWebFetch(req, res, rawBody));
    return;
  }

  // 7. Anthropic 协议适配: POST /v1/messages & POST /messages
  if (req.method === 'POST' && (url.pathname === '/v1/messages' || url.pathname === '/messages')) {
    let rawBody = '';
    req.on('data', c => rawBody += c);
    req.on('end', () => handleAnthropicMessages(req, res, rawBody));
    return;
  }

  // 8. OpenAI 协议适配: POST /v1/chat/completions
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let rawBody = '';
    req.on('data', c => rawBody += c);
    req.on('end', () => handleOpenAiChatCompletions(req, res, rawBody));
    return;
  }

  // 9. /api/* 运维与管理 REST API
  if (url.pathname.startsWith('/api/')) {
    return handleApiRoutes(req, res, url);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

// 3. 后台定时任务
setInterval(() => {
  for (const acc of accounts) {
    AccountScheduler.refreshCredits(acc);
  }
}, 5 * 60 * 1000);

// 每小时自动执行日志轮转：严格仅保留最近 3 天的日志
setInterval(() => {
  Logger.pruneOldLogs(3);
}, 60 * 60 * 1000);

// 每小时自动巡检签到状态：如果当天已签到则直接跳过，次日跨天或有未签到账号时自动补签
if (config.autoCheckin !== false) {
  AccountScheduler.checkAndRunHourlyCheckin(false);
  setInterval(() => {
    AccountScheduler.checkAndRunHourlyCheckin(false);
  }, 60 * 60 * 1000);
}

// 启动时初始化：清理过期日志并主动预热刷新所有账号积分
Logger.pruneOldLogs(3);
for (const acc of accounts) {
  AccountScheduler.refreshCredits(acc);
}

// 4. 监听端口
const PORT = config.port || 8317;
server.listen(PORT, () => {
  Logger.info('SYSTEM', `CodeBuddy 国内版生产级网关已启动，监听端口: ${PORT}`);
  console.log(`\n======================================================`);
  console.log(`🚀 CodeBuddy 国内版生产级多协议网关已启动!`);
  console.log(`📡 监听地址: http://127.0.0.1:${PORT}`);
  console.log(`🔑 网关 API Key: ${config.apiKey}`);
  console.log(`✨ 协议支持: OpenAI (/v1/chat/completions) + Anthropic (/v1/messages)`);
  console.log(`🌐 联网扩展: POST /v1/search & POST /v1/fetch`);
  console.log(`🔒 TLS 堆栈: 官方同款运行栈已激活 (${TlsCertificateStack.loadedCount} 张 CA 根证书已载入)`);
  console.log(`🛠️  已开启: 客户端自定义 tools 透传与 tool_calls 回传`);
  console.log(`🛡️  策略开关: 单账号限流保护与模型自动降级改道已激活`);
  console.log(`📜 日志系统: 内存环形缓冲 + gateway.log 自动持久化 + Web实时诊断看板`);
  console.log(`======================================================\n`);
});

export default server;
