import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ─── 国内版专属常量 ───────────────────────────────────────────────────────
const UPSTREAM_URL = 'https://copilot.tencent.com/v2/chat/completions';
const CONFIG_URL = 'https://copilot.tencent.com/v3/config';
const SUMMARY_URL = 'https://copilot.tencent.com/billing/meter/get-user-resource-summary';
const CHECKIN_URL = 'https://www.codebuddy.cn/v2/billing/meter/daily-checkin';
const SEARCH_URL = 'https://copilot.tencent.com/agenttool/v1/search';
const WEBFETCH_URL = 'https://copilot.tencent.com/agenttool/v1/webfetch';

// 1. 客户端版本标识：对齐官方最新 2.179.0
const CURRENT_VERSION = '2.179.0';
const USER_AGENT = `CLI/${CURRENT_VERSION} CodeBuddy/${CURRENT_VERSION}`;

const CONFIG_PATH = path.resolve('config.json');
const ACCOUNTS_PATH = path.resolve('accounts.json');
const LOG_FILE_PATH = path.resolve('gateway.log');

let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
let accounts = fs.existsSync(ACCOUNTS_PATH) ? JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8')) : [];

function saveAccounts() {
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2), 'utf8');
}

function getTodayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ─── 统一诊断日志系统 (Logger & Ring Buffer) ─────────────────────────────
class Logger {
  static ringBuffer = [];
  static maxBufferSize = 1000;

  static write(level, category, message, meta = null) {
    const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const id = crypto.randomUUID().slice(0, 8);
    const logItem = {
      id,
      time,
      level: level.toUpperCase(),
      category: category.toUpperCase(),
      message,
      meta
    };

    this.ringBuffer.unshift(logItem);
    if (this.ringBuffer.length > this.maxBufferSize) {
      this.ringBuffer.pop();
    }

    const metaStr = meta ? ` | ${JSON.stringify(meta)}` : '';
    const line = `[${time}] [${logItem.level.padEnd(5)}] [${logItem.category}] ${message}${metaStr}\n`;

    if (level === 'error') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }

    fs.appendFile(LOG_FILE_PATH, line, () => {});
  }

  static info(category, message, meta) { this.write('info', category, message, meta); }
  static warn(category, message, meta) { this.write('warn', category, message, meta); }
  static error(category, message, meta) { this.write('error', category, message, meta); }
}

// 会话粘性映射: sessionKey -> { uid, lastActive } (带 1 小时 TTL 自动清理)
const sessionStickyMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of sessionStickyMap.entries()) {
    if (now - val.lastActive > 3600 * 1000) {
      sessionStickyMap.delete(key);
    }
  }
}, 10 * 60 * 1000);

// ─── 账号池调度引擎 ─────────────────────────────────────────────────────
class AccountScheduler {
  static selectAccount(requestedModel, sessionKey) {
    const now = Date.now();

    if (sessionKey && sessionStickyMap.has(sessionKey)) {
      const sticky = sessionStickyMap.get(sessionKey);
      const acc = accounts.find(a => a.uid === sticky.uid);
      if (acc && acc.status === 'healthy' && now > (acc.cooldownUntil || 0) && (acc.inFlight || 0) < 3) {
        const isModelCooling = requestedModel && acc.modelCooldowns?.[requestedModel] && now < acc.modelCooldowns[requestedModel];
        if (!isModelCooling) {
          sticky.lastActive = now;
          Logger.info('DISPATCH', `粘性会话复用账号 [${acc.email} (${acc.uid})]`, { sessionKey: sessionKey.slice(0, 8), model: requestedModel });
          return acc;
        }
      }
    }

    const candidates = accounts.filter(a => {
      if (a.status !== 'healthy') return false;
      if (now < (a.cooldownUntil || 0)) return false;
      if (requestedModel && a.modelCooldowns?.[requestedModel] && now < a.modelCooldowns[requestedModel]) {
        return false;
      }
      if ((a.inFlight || 0) >= 3) return false;
      return true;
    });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      if ((a.inFlight || 0) !== (b.inFlight || 0)) {
        return (a.inFlight || 0) - (b.inFlight || 0);
      }
      return (b.creditsRemain || 0) - (a.creditsRemain || 0);
    });

    const chosen = candidates[0];
    if (sessionKey) {
      sessionStickyMap.set(sessionKey, { uid: chosen.uid, lastActive: now });
    }
    Logger.info('DISPATCH', `调度选中账号 [${chosen.email} (${chosen.uid})] (在途并发: ${chosen.inFlight || 0}, 剩余积分: ${chosen.creditsRemain || 0})`, { model: requestedModel });
    return chosen;
  }

  static cooldown(uid, seconds, reason = '') {
    const acc = accounts.find(a => a.uid === uid);
    if (acc) {
      acc.cooldownUntil = Date.now() + seconds * 1000;
      Logger.warn('COOLDOWN', `账号 [${acc.email} (${uid})] 全局冷却 ${seconds}秒`, { reason });
      saveAccounts();
    }
  }

  static cooldownModel(uid, modelId, seconds = 600, reason = '') {
    const acc = accounts.find(a => a.uid === uid);
    if (acc) {
      if (!acc.modelCooldowns) acc.modelCooldowns = {};
      acc.modelCooldowns[modelId] = Date.now() + seconds * 1000;
      Logger.warn('COOLDOWN', `账号 [${acc.email} (${uid})] 模型 [${modelId}] 局部冷却 ${seconds}秒`, { reason });
      saveAccounts();
    }
  }

  static async refreshCredits(acc) {
    if (!acc.accessToken) return;
    try {
      const res = await fetch(SUMMARY_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${acc.accessToken}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
      if (res.ok) {
        const data = await res.json();
        const payload = data.data || data;
        if (payload.TotalCredits) {
          acc.creditsRemain = Math.round((parseFloat(payload.TotalCredits) || 0) * 100) / 100;
        } else if (Array.isArray(payload.Packages)) {
          let total = 0;
          for (const pkg of payload.Packages) {
            total += parseFloat(pkg.CycleRemainCapacity || 0);
          }
          acc.creditsRemain = Math.round(total * 100) / 100;
        }
        saveAccounts();
      }
    } catch (e) {
      Logger.error('BILLING', `账号 [${acc.uid}] 刷新积分失败: ${e.message}`);
    }
  }

  static async dailyCheckin(acc) {
    if (!acc.accessToken) return { success: false, msg: '无有效 Token' };
    const today = getTodayString();
    try {
      const res = await fetch(CHECKIN_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${acc.accessToken}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
      const data = await res.json();
      const rawMsg = data.msg || '';
      const isSuccess = data.code === 0 || rawMsg.includes('成功');
      const isAlready = rawMsg.includes('已签到') || rawMsg.includes('明天再来');

      let userMsg = rawMsg;
      if (isSuccess) {
        userMsg = '签到成功，已领积分';
        acc.lastCheckinDate = today;
        acc.lastCheckinMsg = userMsg;
      } else if (isAlready) {
        userMsg = '今天已签到，请明天再来';
        acc.lastCheckinDate = today;
        acc.lastCheckinMsg = userMsg;
      } else if (rawMsg.includes('企业账号')) {
        userMsg = '企业账号不支持签到';
        acc.lastCheckinDate = today;
        acc.lastCheckinMsg = userMsg;
      } else {
        userMsg = rawMsg || '签到失败';
      }

      Logger.info('CHECKIN', `账号 [${acc.email} (${acc.uid})] 签到: ${userMsg}`);
      await this.refreshCredits(acc);
      saveAccounts();
      return { success: isSuccess || isAlready, msg: userMsg };
    } catch (e) {
      Logger.error('CHECKIN', `账号 [${acc.uid}] 签到网络异常: ${e.message}`);
      return { success: false, msg: `网络错误: ${e.message}` };
    }
  }
}

// 针对腾讯上游 11-128 渠道指纹检测的语义等价清洗
function sanitizeChannelFingerprints(text, role) {
  if (typeof text !== 'string') return text;
  if (role !== 'system' && role !== 'developer' && role !== 'assistant') {
    return text;
  }

  text = text.replace(/(Tokens\s+prefixed\s+with\s+)@(\s+are\s+paths)/gi, '$1(at)$2');
  text = text.replace(/You\s+are\s+an\s+AI\s+agent\s+powered\s+by\s+DeepSeek[\s\u200B]+Harness\./gi, 'You are a helpful AI assistant.');
  text = text.replace(/You\s+are\s+a\s+coding\s+agent\s+powered\s+by\s+/gi, 'You are a coding agent running on ');
  text = text.replace(/DeepSeek[\s\u200B]+Harness\s+Web\s+GUI/gi, 'Web GUI');
  text = text.replace(/You\s+are\s+Claude\s+Code,\s+Anthropic's\s+official\s+CLI\s+tool\s+for\s+Claude\./gi, 'You are an interactive AI assistant for coding.');
  text = text.replace(/Default\s+branch\s+\(you\s+will\s+usually\s+use\s+this\s+for\s+PRs\)/gi, 'Default branch (you will usually use this for PRs)');
  text = text.replace(/DeepSeek[\s\u200B]+Harness/gi, 'DeepSeek-Harness');

  return text;
}

function formatMessagesForUpstream(messages) {
  return messages.map(m => {
    let content = m.content ?? '';
    if (typeof content === 'string') {
      content = sanitizeChannelFingerprints(content, m.role);
    } else if (Array.isArray(content)) {
      content = content.map(part => {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          return { ...part, text: sanitizeChannelFingerprints(part.text, m.role) };
        }
        return part;
      });
    }

    const item = { role: m.role, content };
    if (m.tool_calls) item.tool_calls = m.tool_calls;
    if (m.role === 'tool') item.tool_call_id = m.tool_call_id;
    return item;
  });
}

function applyModelCapabilityGuards(upstreamPayload, modelMeta) {
  if (!modelMeta) return upstreamPayload;

  if (modelMeta.supportsToolCall === false) {
    if (upstreamPayload.tools) {
      delete upstreamPayload.tools;
      delete upstreamPayload.tool_choice;
      Logger.info('GUARD', `模型 [${modelMeta.id}] 声明不支持工具调用，已前置剥离 tools 参数避免 400`);
    }
  }

  if (modelMeta.supportsImages === false && Array.isArray(upstreamPayload.messages)) {
    let flattened = false;
    upstreamPayload.messages = upstreamPayload.messages.map(m => {
      if (Array.isArray(m.content)) {
        flattened = true;
        const flatText = m.content.map(part => {
          if (part.type === 'text') return part.text;
          if (part.type === 'image_url') return `[图片附件: 当前模型 ${modelMeta.id} 不支持视觉识图]`;
          return '';
        }).filter(Boolean).join('\n');
        return { ...m, content: flatText };
      }
      return m;
    });
    if (flattened) {
      Logger.info('GUARD', `模型 [${modelMeta.id}] 声明不支持多模态视觉，已将图片附件安全扁平化为说明文本`);
    }
  }

  return upstreamPayload;
}

function buildOfficialUpstreamHeaders(accessToken, targetModel, sessionKey) {
  const reqId = crypto.randomUUID();
  const convReqId = crypto.randomUUID();
  const sessionId = sessionKey || reqId;

  return {
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'X-Request-ID': reqId,
    'X-Conversation-Request-ID': convReqId,
    'X-Session-ID': sessionId,
    'X-Agent-Intent': 'craft',
    'X-Agent-Runtime': 'cli',
    'X-Client-Platform': 'cli',
    'X-Client-Version': CURRENT_VERSION,
    'X-Product': 'CodeBuddy',
    'X-Product-Version': CURRENT_VERSION,
    'X-Model-ID': targetModel
  };
}

function formatOpenAIError(status, upstreamText) {
  try {
    const err = JSON.parse(upstreamText);
    const msg = err.displayTips?.zh || err.displayMsg?.zh || err.msg || err.message || upstreamText;
    let code = "upstream_error";
    let type = "api_error";
    if (err.code === 11102) { code = "model_not_found"; type = "invalid_request_error"; }
    else if (err.code === 11133) { code = "invalid_request_parameters"; type = "invalid_request_error"; }
    else if (status === 429 || err.code === 6004 || err.code === 6021) { code = "rate_limit_exceeded"; type = "rate_limit_error"; }
    else if (status === 402) { code = "insufficient_quota"; type = "insufficient_quota"; }
    return { error: { message: msg, type, code, param: null } };
  } catch (_) {
    return { error: { message: upstreamText, type: "api_error", code: "upstream_error", param: null } };
  }
}

// ─── 动态获取可用模型 ───────────────────────────────────────────────────
let cachedRawUpstreamModels = null;
let lastModelFetchTimestamp = 0;

async function fetchDetailedModels(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedRawUpstreamModels && (now - lastModelFetchTimestamp < 5 * 60 * 1000)) {
    return attachProbeStatus(cachedRawUpstreamModels);
  }

  for (const acc of accounts) {
    if (acc.status !== 'healthy' || !acc.accessToken) continue;
    try {
      const res = await fetch(CONFIG_URL, {
        headers: {
          'Authorization': `Bearer ${acc.accessToken}`,
          'User-Agent': USER_AGENT
        }
      });
      if (res.ok) {
        const data = await res.json();
        const models = data.data?.models || [];
        if (models.length > 0) {
          cachedRawUpstreamModels = models;
          lastModelFetchTimestamp = now;
          Logger.info('CONFIG', `成功从腾讯云上游拉取全量模型矩阵 (共 ${models.length} 款)`);
          return attachProbeStatus(models);
        }
      }
    } catch (_) {}
  }

  if (fs.existsSync(path.resolve('product.json'))) {
    try {
      const p = JSON.parse(fs.readFileSync(path.resolve('product.json'), 'utf8'));
      cachedRawUpstreamModels = p.models || [];
      return attachProbeStatus(cachedRawUpstreamModels);
    } catch (_) {}
  }

  return attachProbeStatus([]);
}

function attachProbeStatus(models) {
  const now = Date.now();
  return models.map(m => {
    let coolingCount = 0;
    for (const acc of accounts) {
      if (acc.modelCooldowns?.[m.id] && now < acc.modelCooldowns[m.id]) {
        coolingCount++;
      }
    }
    const isCooling = coolingCount > 0 && coolingCount >= accounts.length;
    const isPartialCooling = coolingCount > 0 && coolingCount < accounts.length;

    let probeStatus = 'idle';
    let probeLabel = '🟢 畅通';
    if (isCooling) {
      probeStatus = 'cooldown';
      probeLabel = '🔴 限流冷却';
    } else if (isPartialCooling) {
      probeStatus = 'busy';
      probeLabel = '🟡 局部限流';
    }

    return {
      ...m,
      probeStatus,
      probeLabel
    };
  });
}

async function fetchModels() {
  const detailed = await fetchDetailedModels();
  return detailed.map(m => ({
    id: m.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: m.vendor || 'tencent-codebuddy',
    context_window: m.contextWindow?.defaultLength || m.maxInputTokens || 200000,
    max_output_tokens: m.maxOutputTokens || 8192
  }));
}

// ─── HTTP 服务与路由 ───────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // 1. Web 控制台
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderDashboardHTML());
  }

  // 2. 探活
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
    const list = await fetchModels();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: list }));
  }

  // 5. 官方服务端联网检索端点: POST /v1/search & POST /search
  if (req.method === 'POST' && (url.pathname === '/v1/search' || url.pathname === '/search')) {
    let rawBody = '';
    req.on('data', c => rawBody += c);
    req.on('end', async () => {
      const startTime = Date.now();
      try {
        const bodyObj = JSON.parse(rawBody || '{}');
        const acc = AccountScheduler.selectAccount();
        if (!acc) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'No available account for search' }));
        }

        const queryStr = bodyObj.query || '';
        Logger.info('SEARCH', `发起联网检索 [${queryStr}]`, { account: acc.email });

        const searchRes = await fetch(SEARCH_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${acc.accessToken}`,
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            query: queryStr,
            max_results: bodyObj.max_results || bodyObj.count || 5
          })
        });

        const searchData = await searchRes.text();
        const latency = Date.now() - startTime;
        Logger.info('SEARCH', `检索完成 [${queryStr}] 耗时 ${latency}ms (HTTP ${searchRes.status})`);
        res.writeHead(searchRes.status, { 'Content-Type': 'application/json' });
        return res.end(searchData);
      } catch (e) {
        Logger.error('SEARCH', `检索异常: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 5. 官方服务端网页抓取端点: POST /v1/fetch & POST /fetch
  if (req.method === 'POST' && (url.pathname === '/v1/fetch' || url.pathname === '/fetch')) {
    let rawBody = '';
    req.on('data', c => rawBody += c);
    req.on('end', async () => {
      const startTime = Date.now();
      try {
        const bodyObj = JSON.parse(rawBody || '{}');
        const acc = AccountScheduler.selectAccount();
        if (!acc) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'No available account for webfetch' }));
        }

        const targetUrl = bodyObj.url || '';
        Logger.info('FETCH', `发起网页内容抓取 [${targetUrl}]`, { account: acc.email });

        const fetchRes = await fetch(WEBFETCH_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${acc.accessToken}`,
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ url: targetUrl })
        });

        const fetchData = await fetchRes.text();
        const latency = Date.now() - startTime;
        Logger.info('FETCH', `抓取完成 [${targetUrl}] 耗时 ${latency}ms (HTTP ${fetchRes.status})`);
        res.writeHead(fetchRes.status, { 'Content-Type': 'application/json' });
        return res.end(fetchData);
      } catch (e) {
        Logger.error('FETCH', `网页抓取异常: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 6. POST /v1/messages 与 POST /messages (Anthropic 协议适配，供 Claude Code 使用)
  if (req.method === 'POST' && (url.pathname === '/v1/messages' || url.pathname === '/messages')) {
    let rawBody = '';
    req.on('data', chunk => rawBody += chunk);
    req.on('end', async () => {
      const startTime = Date.now();
      try {
        const anthropicPayload = JSON.parse(rawBody);
        const isClientStream = Boolean(anthropicPayload.stream);

        let targetModel = anthropicPayload.model || 'deepseek-v4.1-flash';
        if (targetModel.includes('claude') || targetModel.includes('sonnet') || targetModel.includes('opus')) {
          targetModel = 'deepseek-v4.1-flash';
        }

        Logger.info('ANTHROPIC', `收到 Claude Code 协议请求 [${targetModel}] (流式: ${isClientStream})`, {
          clientIp: req.socket.remoteAddress,
          toolsCount: anthropicPayload.tools?.length || 0
        });

        const openAiMessages = [];
        if (anthropicPayload.system) {
          const sysContent = typeof anthropicPayload.system === 'string'
            ? anthropicPayload.system
            : Array.isArray(anthropicPayload.system) ? anthropicPayload.system.map(s => s.text).join('\n') : '';
          if (sysContent) {
            openAiMessages.push({ role: 'system', content: sysContent });
          }
        }

        for (const m of (anthropicPayload.messages || [])) {
          if (typeof m.content === 'string') {
            openAiMessages.push({ role: m.role, content: m.content });
          } else if (Array.isArray(m.content)) {
            let textParts = [];
            let toolCalls = [];
            let toolResults = [];

            for (const b of m.content) {
              if (b.type === 'text') {
                textParts.push(b.text);
              } else if (b.type === 'image' && b.source?.data) {
                textParts.push({
                  type: 'image_url',
                  image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` }
                });
              } else if (b.type === 'tool_use') {
                toolCalls.push({
                  id: b.id,
                  type: 'function',
                  function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
                });
              } else if (b.type === 'tool_result') {
                toolResults.push({
                  role: 'tool',
                  tool_call_id: b.tool_use_id,
                  content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '')
                });
              }
            }

            if (textParts.length > 0 || toolCalls.length > 0) {
              const msgObj = { role: m.role, content: textParts.length === 1 && typeof textParts[0] === 'string' ? textParts[0] : textParts };
              if (toolCalls.length > 0) msgObj.tool_calls = toolCalls;
              openAiMessages.push(msgObj);
            }
            if (toolResults.length > 0) {
              openAiMessages.push(...toolResults);
            }
          }
        }

        const openAiTools = [];
        if (Array.isArray(anthropicPayload.tools)) {
          for (const t of anthropicPayload.tools) {
            openAiTools.push({
              type: 'function',
              function: {
                name: t.name,
                description: t.description || '',
                parameters: t.input_schema || { type: 'object', properties: {} }
              }
            });
          }
        }

        const acc = AccountScheduler.selectAccount(targetModel);
        if (!acc) {
          Logger.warn('OVERLOAD', `无可用账号服务 [${targetModel}]`);
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'All accounts busy or in cooldown' } }));
        }

        acc.inFlight = (acc.inFlight || 0) + 1;

        let upstreamPayload = {
          model: targetModel,
          messages: formatMessagesForUpstream(openAiMessages),
          stream: true,
          temperature: anthropicPayload.temperature ?? 1.0,
          max_tokens: anthropicPayload.max_tokens,
          stream_options: { include_usage: true },
          cache_retention: 'auto'
        };

        if (openAiTools.length > 0) {
          upstreamPayload.tools = openAiTools;
        }

        const allMeta = await fetchDetailedModels();
        const modelMeta = allMeta.find(m => m.id === targetModel);
        upstreamPayload = applyModelCapabilityGuards(upstreamPayload, modelMeta);

        if (targetModel.includes('deepseek') || targetModel.includes('hy')) {
          upstreamPayload.thinking = { type: 'enabled' };
          upstreamPayload.reasoning_effort = 'high';
          upstreamPayload.reasoning = { effort: 'high', summary: 'auto' };
        }

        const upstreamHeaders = buildOfficialUpstreamHeaders(acc.accessToken, targetModel);

        const upstreamRes = await fetch(UPSTREAM_URL, {
          method: 'POST',
          headers: upstreamHeaders,
          body: JSON.stringify(upstreamPayload)
        });

        if (!upstreamRes.ok) {
          acc.inFlight = Math.max(0, acc.inFlight - 1);
          const errText = await upstreamRes.text();
          Logger.error('ANTHROPIC', `上游报错 HTTP ${upstreamRes.status}: ${errText}`);
          res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: errText } }));
        }

        const msgId = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);

        if (isClientStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });

          res.write(`event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: msgId,
              type: 'message',
              role: 'assistant',
              content: [],
              model: targetModel,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 }
            }
          })}\n\n`);

          const reader = upstreamRes.body.getReader();
          const decoder = new TextDecoder();
          let textBlockStarted = false;
          let activeToolIndices = new Set();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const dataStr = trimmed.slice(5).trim();
              if (dataStr === '[DONE]') continue;

              try {
                const chunk = JSON.parse(dataStr);
                const delta = chunk.choices?.[0]?.delta;

                if (delta?.content) {
                  if (!textBlockStarted) {
                    textBlockStarted = true;
                    res.write(`event: content_block_start\ndata: ${JSON.stringify({
                      type: 'content_block_start',
                      index: 0,
                      content_block: { type: 'text', text: '' }
                    })}\n\n`);
                  }
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: delta.content }
                  })}\n\n`);
                }

                if (Array.isArray(delta?.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = (tc.index ?? 0) + 1;
                    if (!activeToolIndices.has(idx)) {
                      activeToolIndices.add(idx);
                      res.write(`event: content_block_start\ndata: ${JSON.stringify({
                        type: 'content_block_start',
                        index: idx,
                        content_block: {
                          type: 'tool_use',
                          id: tc.id || 'call_' + crypto.randomUUID(),
                          name: tc.function?.name || '',
                          input: {}
                        }
                      })}\n\n`);
                    }
                    if (tc.function?.arguments) {
                      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                        type: 'content_block_delta',
                        index: idx,
                        delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
                      })}\n\n`);
                    }
                  }
                }
              } catch (_) {}
            }
          }

          if (textBlockStarted) {
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
          }
          for (const idx of activeToolIndices) {
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`);
          }

          const stopReason = activeToolIndices.size > 0 ? 'tool_use' : 'end_turn';
          res.write(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: 20 }
          })}\n\n`);

          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
          acc.inFlight = Math.max(0, acc.inFlight - 1);
          const latency = Date.now() - startTime;
          Logger.info('ANTHROPIC', `流式回复完成 [${targetModel}] 耗时 ${latency}ms (结束原因: ${stopReason})`);
          return res.end();

        } else {
          const reader = upstreamRes.body.getReader();
          const decoder = new TextDecoder();
          let fullContent = '';
          let toolCallsMap = new Map();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const dataStr = trimmed.slice(5).trim();
              if (dataStr === '[DONE]') continue;

              try {
                const chunk = JSON.parse(dataStr);
                const delta = chunk.choices?.[0]?.delta;
                if (delta?.content) fullContent += delta.content;
                if (Array.isArray(delta?.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallsMap.has(idx)) {
                      toolCallsMap.set(idx, {
                        id: tc.id || 'call_' + crypto.randomUUID(),
                        name: tc.function?.name || '',
                        arguments: ''
                      });
                    }
                    const item = toolCallsMap.get(idx);
                    if (tc.id) item.id = tc.id;
                    if (tc.function?.name) item.name = tc.function.name;
                    if (tc.function?.arguments) item.arguments += tc.function.arguments;
                  }
                }
              } catch (_) {}
            }
          }

          acc.inFlight = Math.max(0, acc.inFlight - 1);

          const contentBlocks = [];
          if (fullContent) {
            contentBlocks.push({ type: 'text', text: fullContent });
          }
          for (const tc of toolCallsMap.values()) {
            let inputArgs = {};
            try { inputArgs = JSON.parse(tc.arguments || '{}'); } catch (_) {}
            contentBlocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: inputArgs
            });
          }

          const latency = Date.now() - startTime;
          const stopReason = toolCallsMap.size > 0 ? 'tool_use' : 'end_turn';
          Logger.info('ANTHROPIC', `非流式完成 [${targetModel}] 耗时 ${latency}ms (结束原因: ${stopReason})`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            id: msgId,
            type: 'message',
            role: 'assistant',
            content: contentBlocks,
            model: targetModel,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: fullContent.length }
          }));
        }

      } catch (err) {
        Logger.error('ANTHROPIC', `处理异常: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } }));
      }
    });
    return;
  }

  // 7. POST /v1/chat/completions (OpenAI 协议核心网关)
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let rawBody = '';
    req.on('data', chunk => rawBody += chunk);
    req.on('end', async () => {
      const startTime = Date.now();
      try {
        const payload = JSON.parse(rawBody);
        const isClientStream = Boolean(payload.stream);

        const sessionKey = req.headers['x-session-id'] || 
          crypto.createHash('md5').update(JSON.stringify(payload.messages?.slice(0, 2) || '')).digest('hex');

        let targetModel = payload.model || 'deepseek-v4.1-flash';

        Logger.info('CHAT', `收到 OpenAI 对话请求 [${targetModel}] (流式: ${isClientStream})`, {
          clientIp: req.socket.remoteAddress,
          toolsCount: payload.tools?.length || 0,
          messagesCount: payload.messages?.length || 0
        });

        const acc = AccountScheduler.selectAccount(targetModel, sessionKey);
        if (!acc) {
          Logger.warn('OVERLOAD', `无可用账号服务模型 [${targetModel}]`);
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'All upstream accounts are busy or cooling down for this model.', type: 'server_error' } }));
        }

        acc.inFlight = (acc.inFlight || 0) + 1;

        let upstreamPayload = {
          model: targetModel,
          messages: formatMessagesForUpstream(payload.messages || []),
          stream: true,
          temperature: payload.temperature ?? 1.0,
          max_tokens: payload.max_tokens,
          stream_options: { include_usage: true },
          cache_retention: typeof payload.cache_retention === 'string' ? payload.cache_retention : 'auto'
        };

        if (Array.isArray(payload.tools) && payload.tools.length > 0) {
          upstreamPayload.tools = payload.tools;
          if (payload.tool_choice) {
            upstreamPayload.tool_choice = payload.tool_choice;
          }
        }

        const allMeta = await fetchDetailedModels();
        const modelMeta = allMeta.find(m => m.id === targetModel);
        upstreamPayload = applyModelCapabilityGuards(upstreamPayload, modelMeta);

        const effort = payload.reasoning_effort || payload.reasoning?.effort;
        const isReasoningOff = effort === 'none' || effort === 'off' || payload.thinking?.type === 'disabled';

        if (upstreamPayload.model.includes('deepseek') || upstreamPayload.model.includes('hy')) {
          if (isReasoningOff) {
            upstreamPayload.thinking = { type: 'disabled' };
            upstreamPayload.reasoning_effort = 'none';
          } else {
            upstreamPayload.thinking = { type: 'enabled' };
            upstreamPayload.reasoning_effort = effort || 'high';
            upstreamPayload.reasoning = { effort: effort || 'high', summary: 'auto' };
          }
        }

        async function executeCall(curModel, isRetry = false) {
          upstreamPayload.model = curModel;
          const headers = buildOfficialUpstreamHeaders(acc.accessToken, curModel, sessionKey);

          let upstreamRes = await fetch(UPSTREAM_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify(upstreamPayload)
          });

          if (!upstreamRes.ok) {
            const errText = await upstreamRes.text();
            let parsedErr = {};
            try { parsedErr = JSON.parse(errText); } catch (_) {}

            Logger.error('UPSTREAM', `上游报错 HTTP ${upstreamRes.status} (模型: ${curModel})`, {
              code: parsedErr.code,
              msg: parsedErr.msg,
              account: acc.email
            });

            if (parsedErr.code === 6004) {
              AccountScheduler.cooldownModel(acc.uid, curModel, 600, 'Upstream 6004 Model Limit Exceeded');
              const fallback = config.modelFallback?.[curModel];
              if (fallback && fallback !== curModel && !isRetry) {
                Logger.warn('REROUTE', `账号 [${acc.email}] 模型 [${curModel}] 触发 6004 限量，自动无感改道至备用模型 [${fallback}]`);
                return await executeCall(fallback, true);
              }
            }
            return { ok: false, status: upstreamRes.status, errText };
          }
          return { ok: true, res: upstreamRes };
        }

        const callResult = await executeCall(targetModel);

        if (!callResult.ok) {
          acc.inFlight = Math.max(0, acc.inFlight - 1);
          if (callResult.status === 429) {
            AccountScheduler.cooldown(acc.uid, 600, 'Upstream 429 Rate Limit');
          } else if (callResult.status === 402) {
            AccountScheduler.cooldown(acc.uid, 86400, 'Credits Exhausted');
          } else if (callResult.status === 401) {
            acc.status = 'unauthorized';
            Logger.error('AUTH', `账号 [${acc.email}] Token 已失效或被收回 (HTTP 401)`);
          }
          res.writeHead(callResult.status, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(formatOpenAIError(callResult.status, callResult.errText)));
        }

        const upstreamRes = callResult.res;

        if (isClientStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
          });

          const reader = upstreamRes.body.getReader();
          const decoder = new TextDecoder();
          let toolCallObserved = false;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const str = decoder.decode(value, { stream: true });
            if (str.includes('"tool_calls"')) toolCallObserved = true;
            res.write(str);
          }

          acc.inFlight = Math.max(0, acc.inFlight - 1);
          const latency = Date.now() - startTime;
          Logger.info('CHAT', `流式输出完成 [${upstreamPayload.model}] 耗时 ${latency}ms (是否含工具调用: ${toolCallObserved})`);
          return res.end();

        } else {
          const reader = upstreamRes.body.getReader();
          const decoder = new TextDecoder();

          let fullContent = '';
          let fullReasoning = '';
          let toolCallsMap = new Map();
          let finishReason = 'stop';
          let responseId = 'chatcmpl-' + crypto.randomUUID();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const dataStr = trimmed.slice(5).trim();
              if (dataStr === '[DONE]') continue;

              try {
                const chunk = JSON.parse(dataStr);
                responseId = chunk.id || responseId;
                const choice = chunk.choices?.[0];
                if (!choice) continue;

                const delta = choice.delta;
                if (delta?.content) fullContent += delta.content;
                if (delta?.reasoning_content) fullReasoning += delta.reasoning_content;

                if (Array.isArray(delta?.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallsMap.has(idx)) {
                      toolCallsMap.set(idx, {
                        id: tc.id || 'call_' + crypto.randomUUID(),
                        type: 'function',
                        function: { name: tc.function?.name || '', arguments: '' }
                      });
                    }
                    const existing = toolCallsMap.get(idx);
                    if (tc.id) existing.id = tc.id;
                    if (tc.function?.name) existing.function.name = tc.function.name;
                    if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                  }
                }

                if (choice.finish_reason) {
                  finishReason = choice.finish_reason;
                }
              } catch (_) {}
            }
          }

          acc.inFlight = Math.max(0, acc.inFlight - 1);

          const assembledMessage = {
            role: 'assistant',
            content: fullContent || null
          };

          if (fullReasoning) {
            assembledMessage.reasoning_content = fullReasoning;
          }

          if (toolCallsMap.size > 0) {
            assembledMessage.tool_calls = Array.from(toolCallsMap.values());
            finishReason = 'tool_calls';
            Logger.info('TOOLS', `模型决定下发工具调用 (共 ${toolCallsMap.size} 个)`, {
              tools: Array.from(toolCallsMap.values()).map(t => t.function.name)
            });
          }

          const latency = Date.now() - startTime;
          Logger.info('CHAT', `非流式回复完成 [${upstreamPayload.model}] 耗时 ${latency}ms (结束原因: ${finishReason})`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            id: responseId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: upstreamPayload.model,
            choices: [{
              index: 0,
              message: assembledMessage,
              finish_reason: finishReason
            }],
            usage: {
              prompt_tokens: 0,
              completion_tokens: fullContent.length,
              total_tokens: fullContent.length
            }
          }));
        }

      } catch (err) {
        Logger.error('CHAT', `请求处理异常: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    return;
  }

  // 8. 控制面板管理 API
  if (url.pathname.startsWith('/api/')) {
    const today = getTodayString();

    // 日志查询接口
    if (url.pathname === '/api/logs' && req.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        total: Logger.ringBuffer.length,
        logs: Logger.ringBuffer.slice(0, limit)
      }));
    }

    // 日志全量下载导出
    if (url.pathname === '/api/logs/export' && req.method === 'GET') {
      if (fs.existsSync(LOG_FILE_PATH)) {
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="gateway.log"'
        });
        return fs.createReadStream(LOG_FILE_PATH).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('# 日志文件暂为空');
      }
    }

    // 清空内存日志
    if (url.pathname === '/api/logs/clear' && req.method === 'POST') {
      Logger.ringBuffer = [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (url.pathname === '/api/accounts' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(accounts.map(a => ({
        uid: a.uid,
        email: a.email,
        creditsRemain: a.creditsRemain,
        inFlight: a.inFlight || 0,
        status: a.status,
        isCooldown: Date.now() < (a.cooldownUntil || 0),
        isCheckedInToday: a.lastCheckinDate === today,
        lastCheckinMsg: a.lastCheckinDate === today ? (a.lastCheckinMsg || '今天已签到') : '今日未签到'
      }))));
    }

    if (url.pathname === '/api/models-detail' && req.method === 'GET') {
      const force = url.searchParams.get('refresh') === '1';
      const detailedModels = await fetchDetailedModels(force);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(detailedModels));
    }

    if (url.pathname === '/api/oauth/start' && req.method === 'POST') {
      try {
        const oauthRes = await fetch('https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
          body: '{}'
        });
        const oauthData = await oauthRes.json();
        const state = oauthData.state || oauthData.data?.state;
        const loginUrl = oauthData.login_url || oauthData.data?.login_url || `https://copilot.tencent.com/login?state=${state}`;

        Logger.info('OAUTH', `发起设备码授权, state: ${state}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ state, loginUrl }));
      } catch (e) {
        Logger.error('OAUTH', `生成登录链接失败: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    if (url.pathname === '/api/oauth/poll' && req.method === 'POST') {
      let b = '';
      req.on('data', c => b += c);
      req.on('end', async () => {
        const { state } = JSON.parse(b);
        try {
          const pollRes = await fetch('https://copilot.tencent.com/v2/plugin/auth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
            body: JSON.stringify({ state })
          });
          const tokenData = await pollRes.json();
          if (tokenData.access_token) {
            let accountInfo = { nick_name: 'CodeBuddy用户', uid: 'uid_' + Date.now() };
            try {
              const accRes = await fetch('https://copilot.tencent.com/v2/plugin/login/account', {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'User-Agent': USER_AGENT }
              });
              if (accRes.ok) accountInfo = await accRes.json();
            } catch (_) {}

            const newAcc = {
              uid: String(accountInfo.uid || accountInfo.data?.uid || Date.now()),
              email: accountInfo.nick_name || accountInfo.data?.nick_name || '已授权账号',
              region: 'cn',
              accessToken: tokenData.access_token,
              refreshToken: tokenData.refresh_token || '',
              expiresAt: Date.now() + (tokenData.expires_in || 7200) * 1000,
              creditsRemain: 0,
              status: 'healthy',
              inFlight: 0
            };
            accounts.push(newAcc);
            saveAccounts();
            Logger.info('OAUTH', `新账号授权成功录入: [${newAcc.email} (${newAcc.uid})]`);
            AccountScheduler.refreshCredits(newAcc);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, account: newAcc }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, msg: '等待扫码中...' }));
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (url.pathname === '/api/checkin' && req.method === 'POST') {
      const results = [];
      for (const acc of accounts) {
        const resObj = await AccountScheduler.dailyCheckin(acc);
        results.push({
          uid: acc.uid,
          email: acc.email,
          success: resObj.success,
          msg: resObj.msg
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        total: accounts.length,
        results
      }));
    }

    if (url.pathname === '/api/checkin-single' && req.method === 'POST') {
      let b = '';
      req.on('data', c => b += c);
      req.on('end', async () => {
        const { uid } = JSON.parse(b);
        const acc = accounts.find(a => a.uid === uid);
        if (!acc) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Account not found' }));
        }
        const resObj = await AccountScheduler.dailyCheckin(acc);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(resObj));
      });
      return;
    }

    if (url.pathname === '/api/accounts/delete' && req.method === 'POST') {
      let b = '';
      req.on('data', c => b += c);
      req.on('end', () => {
        const { uid } = JSON.parse(b);
        const removed = accounts.find(a => a.uid === uid);
        accounts = accounts.filter(a => a.uid !== uid);
        saveAccounts();
        Logger.warn('ACCOUNTS', `已从账号池移除账号: [${removed?.email || uid}]`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
  }

  res.writeHead(404);
  res.end();
});

// ─── 后台定时器 ─────────────────────────────────────────────────────────
setInterval(() => {
  for (const acc of accounts) {
    AccountScheduler.refreshCredits(acc);
  }
}, 5 * 60 * 1000);

if (config.autoCheckin) {
  setInterval(() => {
    const hour = new Date().getHours();
    const minute = new Date().getMinutes();
    if ((hour === 9 || hour === 21) && minute === 0) {
      Logger.info('SCHEDULER', '定时打卡排程触发，开始全员每日签到...');
      for (const acc of accounts) {
        AccountScheduler.dailyCheckin(acc);
      }
    }
  }, 60 * 1000);
}

for (const acc of accounts) {
  AccountScheduler.refreshCredits(acc);
}

server.listen(config.port, () => {
  Logger.info('SYSTEM', `CodeBuddy 国内版生产级网关已启动，监听端口: ${config.port}`);
  console.log(`\n======================================================`);
  console.log(`🚀 CodeBuddy 国内版生产级多协议网关已启动!`);
  console.log(`📡 监听地址: http://127.0.0.1:${config.port}`);
  console.log(`🔑 网关 API Key: ${config.apiKey}`);
  console.log(`✨ 协议支持: OpenAI (/v1/chat/completions) + Anthropic (/v1/messages)`);
  console.log(`🌐 联网扩展: POST /v1/search & POST /v1/fetch`);
  console.log(`🛠️  已开启: 客户端自定义 tools 透传与 tool_calls 回传`);
  console.log(`📜 日志系统: 内存环形缓冲 + gateway.log 自动持久化 + Web实时诊断看板`);
  console.log(`======================================================\n`);
});

// ─── 极致现代化单页 Web 管理控制台 ───────────────────────────────────────────────
function renderDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodeBuddy 2API 控制台 · 官方模型网关</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --card-border: #1f2937;
      --card-hover: #1e293b;
      --text-main: #f9fafb;
      --text-muted: #9ca3af;
      --primary: #0284c7;
      --primary-hover: #0369a1;
      --accent: #38bdf8;
      --code-bg: #030712;
      --table-border: #1f2937;
    }
    html.light {
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --card-border: #e2e8f0;
      --card-hover: #f1f5f9;
      --text-main: #0f172a;
      --text-muted: #64748b;
      --primary: #0284c7;
      --primary-hover: #0369a1;
      --accent: #0284c7;
      --code-bg: #f1f5f9;
      --table-border: #e2e8f0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; background: var(--bg); color: var(--text-main); line-height: 1.5; padding: 24px; transition: background 0.2s, color 0.2s; }
    .container { max-width: 1280px; margin: 0 auto; }
    
    /* Header */
    header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 24px; border-bottom: 1px solid var(--card-border); margin-bottom: 24px; }
    .logo-area { display: flex; align-items: center; gap: 12px; }
    .logo-icon { width: 36px; height: 36px; border-radius: 8px; background: linear-gradient(135deg, #0284c7, #38bdf8); display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: bold; color: #fff; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.3); }
    .brand-title { font-size: 20px; font-weight: 700; color: var(--text-main); letter-spacing: -0.02em; }
    .brand-sub { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; display: inline-block; box-shadow: 0 0 8px #22c55e; }
    
    /* Top Actions */
    .top-actions { display: flex; gap: 10px; align-items: center; }
    button { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 6px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; transition: 0.15s; }
    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-success { background: #16a34a; color: white; }
    .btn-success:hover { background: #15803d; }
    .btn-outline { background: transparent; border: 1px solid var(--card-border); color: var(--text-muted); }
    .btn-outline:hover { background: var(--card-hover); color: var(--text-main); }
    .btn-danger { background: #dc2626; color: white; padding: 4px 8px; font-size: 12px; }
    .btn-danger:hover { background: #b91c1c; }
    .btn-copy { background: var(--code-bg); color: var(--accent); border: 1px solid var(--card-border); padding: 4px 8px; font-size: 11px; border-radius: 4px; }
    .btn-copy:hover { border-color: var(--accent); }
    .btn-json { background: transparent; color: #a855f7; border: 1px solid #7e22ce; padding: 4px 8px; font-size: 11px; border-radius: 4px; }
    .btn-json:hover { background: #581c87; color: #fff; }

    /* KPI Cards */
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .kpi-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; padding: 18px 20px; transition: transform 0.15s, border-color 0.15s; }
    .kpi-card:hover { transform: translateY(-2px); border-color: var(--accent); }
    .kpi-label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 6px; }
    .kpi-value { font-size: 26px; font-weight: 700; color: var(--text-main); display: flex; align-items: baseline; gap: 8px; }
    .kpi-hint { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
    
    /* Card Standard */
    .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; padding: 22px; margin-bottom: 24px; }
    .card-title { font-size: 16px; font-weight: 700; color: var(--text-main); margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; }

    /* Quick Guide Tabs */
    .guide-tabs { display: flex; gap: 8px; border-bottom: 1px solid var(--card-border); padding-bottom: 10px; margin-bottom: 16px; }
    .guide-tab-btn { background: transparent; color: var(--text-muted); padding: 6px 12px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid transparent; }
    .guide-tab-btn.active { background: var(--card-hover); color: var(--accent); border-color: var(--card-border); }
    .guide-content { background: var(--code-bg); padding: 14px 18px; border-radius: 8px; border: 1px solid var(--card-border); position: relative; font-family: monospace; font-size: 13px; line-height: 1.6; color: #e2e8f0; }
    .guide-copy-btn { position: absolute; top: 10px; right: 10px; }

    /* Tables */
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--table-border); font-size: 13px; }
    th { color: var(--text-muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; }
    tr:hover td { background: var(--card-hover); }
    code { background: var(--code-bg); padding: 2px 6px; border-radius: 4px; color: var(--accent); font-family: monospace; font-size: 12px; border: 1px solid var(--card-border); }

    /* Badges */
    .badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
    .badge-ok { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
    .badge-cool { background: rgba(234, 179, 8, 0.15); color: #facc15; border: 1px solid rgba(234, 179, 8, 0.3); }
    .badge-err { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
    .badge-purple { background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); }
    .badge-blue { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }

    /* Filter Bar */
    .filter-bar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; align-items: center; }
    .filter-btn { padding: 4px 12px; background: var(--card-bg); color: var(--text-muted); border-radius: 6px; font-size: 12px; cursor: pointer; border: 1px solid var(--card-border); }
    .filter-btn:hover { background: var(--card-hover); color: var(--text-main); }
    .filter-btn.active { background: var(--primary); color: #fff; font-weight: bold; border-color: var(--primary); }
    .search-input { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--card-border); background: var(--code-bg); color: var(--text-main); font-size: 13px; width: 220px; outline: none; }
    .search-input:focus { border-color: var(--accent); }

    /* Log Viewer Terminal Styles */
    .log-container { background: var(--code-bg); border: 1px solid var(--card-border); border-radius: 8px; padding: 12px; max-height: 420px; overflow-y: auto; font-family: "JetBrains Mono", Consolas, Menlo, monospace; font-size: 12px; line-height: 1.6; }
    .log-row { display: flex; gap: 10px; padding: 3px 6px; border-radius: 4px; border-bottom: 1px solid rgba(255,255,255,0.03); align-items: baseline; word-break: break-all; }
    .log-row:hover { background: rgba(255,255,255,0.04); }
    .log-time { color: #64748b; font-size: 11px; white-space: nowrap; }
    .log-badge-info { color: #38bdf8; font-weight: bold; width: 44px; text-align: center; }
    .log-badge-warn { color: #facc15; font-weight: bold; width: 44px; text-align: center; }
    .log-badge-error { color: #f87171; font-weight: bold; width: 44px; text-align: center; }
    .log-cat { color: #a78bfa; font-weight: 600; width: 80px; white-space: nowrap; }
    .log-msg { color: #e2e8f0; flex: 1; }
    .log-meta { color: #94a3b8; font-size: 11px; background: rgba(255,255,255,0.05); padding: 1px 4px; border-radius: 3px; margin-left: 6px; }

    /* Modals & Alerts */
    .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); align-items: center; justify-content: center; z-index: 100; }
    .modal-content { background: var(--card-bg); padding: 26px; border-radius: 12px; border: 1px solid var(--card-border); max-width: 760px; width: 90%; max-height: 85vh; overflow-y: auto; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
    pre { background: var(--code-bg); padding: 14px; border-radius: 8px; overflow-x: auto; color: var(--accent); font-size: 12px; line-height: 1.5; border: 1px solid var(--card-border); margin: 12px 0; }
    #checkinAlert { display: none; margin-bottom: 20px; padding: 14px 18px; border-radius: 8px; border: 1px solid rgba(34, 197, 94, 0.4); background: rgba(34, 197, 94, 0.1); color: #86efac; animation: fadeIn 0.2s ease-in-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body>
  <div class="container">
    <!-- Top Header -->
    <header>
      <div class="logo-area">
        <div class="logo-icon">⚡</div>
        <div>
          <div class="brand-title">CodeBuddy 2API 网关</div>
          <div class="brand-sub"><span class="status-dot"></span> 官方链路直连 · 客户端 Agent 纯模型通道 · v${CURRENT_VERSION}</div>
        </div>
      </div>
      <div class="top-actions">
        <button id="btnAllCheckin" class="btn-success" onclick="runCheckin()">⚡ 全员打卡签到</button>
        <button class="btn-primary" onclick="startOAuth()">➕ 扫码添加账号</button>
        <button class="btn-outline" onclick="toggleTheme()" title="切换明暗主题">🌓 主题</button>
      </div>
    </header>

    <!-- 全员签到反馈横幅 -->
    <div id="checkinAlert">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <b id="checkinAlertTitle" style="font-size:14px;"></b>
        <button onclick="document.getElementById('checkinAlert').style.display='none'" style="background:transparent; color:#86efac; padding:0 4px; font-size:16px;">✕</button>
      </div>
      <div id="checkinAlertDetail" style="margin-top:8px; font-size:12px; line-height:1.6; white-space:pre-wrap;"></div>
    </div>

    <!-- KPI 指标概览卡片 -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">健康账号总数</div>
        <div class="kpi-value"><span id="kpiActiveAcc">-</span> <span style="font-size:13px; font-weight:normal; color:var(--text-muted);">/ <span id="kpiTotalAcc">-</span> 总计</span></div>
        <div class="kpi-hint">多账号智能加权轮换与并发削峰</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">账号池可用积分合计</div>
        <div class="kpi-value" style="color:#4ade80;"><span id="kpiTotalCredits">-</span> <span style="font-size:13px; font-weight:normal; color:var(--text-muted);">credits</span></div>
        <div class="kpi-hint">已自动同步腾讯云官方套餐与免费包</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">实时在途请求并发</div>
        <div class="kpi-value" style="color:var(--accent);"><span id="kpiInFlight">-</span> <span style="font-size:13px; font-weight:normal; color:var(--text-muted);">活跃线程</span></div>
        <div class="kpi-hint">单账号限流保护与 6004 自动改道</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">已同步上游官方模型</div>
        <div class="kpi-value" style="color:#c084fc;"><span id="kpiModelsCount">-</span> <span style="font-size:13px; font-weight:normal; color:var(--text-muted);">款可用</span></div>
        <div class="kpi-hint">100% 官方原始元数据 · 支持 1M 上下文</div>
      </div>
    </div>

    <!-- 客户端接入指引 (Interactive Guide) -->
    <div class="card">
      <div class="card-title">
        <span>🔌 客户端接入配置指引</span>
        <span style="font-size:12px; font-weight:normal; color:var(--text-muted);">点击 Tab 查看不同工具的配置方法</span>
      </div>
      <div class="guide-tabs">
        <button class="guide-tab-btn active" onclick="switchGuide('openai', this)">OpenAI 标准 (Cursor / NextChat)</button>
        <button class="guide-tab-btn" onclick="switchGuide('claude', this)">Claude Code 命令行</button>
        <button class="guide-tab-btn" onclick="switchGuide('search', this)">官方免费联网检索</button>
        <button class="guide-tab-btn" onclick="switchGuide('curl', this)">cURL 冒烟测试</button>
      </div>
      <div class="guide-content" id="guideContent">
        <button class="btn-copy guide-copy-btn" onclick="copyCurrentGuide()">📋 复制代码</button>
        <pre style="margin:0; background:transparent; border:none; padding:0;" id="guideCodeText"></pre>
      </div>
    </div>

    <!-- 账号池可视化运维表 -->
    <div class="card">
      <div class="card-title">
        <span>👥 账号池运维状态</span>
        <button class="btn-outline" style="font-size:12px; padding:4px 10px;" onclick="loadAccounts()">🔄 刷新状态</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>UID / 标识</th>
            <th>账号昵称</th>
            <th>可用积分 (Credits)</th>
            <th>今日签到</th>
            <th>实时并发</th>
            <th>健康状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="accBody"></tbody>
      </table>
    </div>

    <!-- 实时运行日志 / 问题排查诊断面板 (New Live Logging Diagnostic Panel) -->
    <div class="card">
      <div class="card-title">
        <div style="display:flex; align-items:center; gap:10px;">
          <span>📜 实时运行日志与问题诊断 (Live Diagnostics)</span>
          <span class="badge badge-blue" id="logCountBadge">0 条记录</span>
        </div>
        <div style="display:flex; gap:10px;">
          <input id="logSearch" class="search-input" placeholder="🔍 检索日志关键字 / 状态码..." oninput="filterLogs()" style="width:200px;">
          <button class="btn-outline" onclick="toggleAutoScroll()" id="btnAutoScroll">⏸ 滚动锁定: 开</button>
          <button class="btn-outline" onclick="clearLiveLogs()">🧹 清屏</button>
          <button class="btn-primary" onclick="exportLogFile()">📥 导出完整日志</button>
        </div>
      </div>
      
      <!-- 日志分类筛选器 -->
      <div class="filter-bar">
        <button class="filter-btn active" onclick="setLogCategory('ALL', this)">全部类别</button>
        <button class="filter-btn" onclick="setLogCategory('CHAT', this)">CHAT 对话</button>
        <button class="filter-btn" onclick="setLogCategory('ANTHROPIC', this)">ANTHROPIC 协议</button>
        <button class="filter-btn" onclick="setLogCategory('UPSTREAM', this)">UPSTREAM 上游</button>
        <button class="filter-btn" onclick="setLogCategory('TOOLS', this)">TOOLS 工具</button>
        <button class="filter-btn" onclick="setLogCategory('DISPATCH', this)">DISPATCH 调度</button>
        <button class="filter-btn" onclick="setLogCategory('CHECKIN', this)">CHECKIN 签到</button>
        <span style="color:var(--card-border); margin: 0 4px;">|</span>
        <button class="filter-btn" onclick="setLogLevel('ALL', this)">所有级别</button>
        <button class="filter-btn" onclick="setLogLevel('ERROR', this)">仅看错误 🔴</button>
        <button class="filter-btn" onclick="setLogLevel('WARN', this)">仅看警告 🟡</button>
      </div>

      <!-- 终端级代码日志视窗 -->
      <div class="log-container" id="logBox">
        <div style="color:var(--text-muted); text-align:center; padding:20px;">正在连接日志引擎...</div>
      </div>
    </div>

    <!-- 上游模型全量矩阵看板 -->
    <div class="card">
      <div class="card-title">
        <div style="display:flex; align-items:center; gap:10px;">
          <span>📋 腾讯云上游模型矩阵</span>
          <span class="badge badge-purple" id="modelTotalBadge">加载中...</span>
        </div>
        <div style="display:flex; gap:10px;">
          <input id="modelSearch" class="search-input" placeholder="🔍 搜索模型 ID 或名称..." oninput="filterModels()">
          <button class="btn-primary" onclick="loadModels(true)">🔄 刷新上游</button>
          <button class="btn-outline" onclick="exportAllRawJson()">📥 导出全量 JSON</button>
        </div>
      </div>
      
      <!-- 快捷分类筛选 -->
      <div class="filter-bar">
        <button class="filter-btn active" onclick="setFilter('all', this)">全部</button>
        <button class="filter-btn" onclick="setFilter('1m', this)">1M 上下文</button>
        <button class="filter-btn" onclick="setFilter('free', this)">免费 / 低倍率</button>
        <button class="filter-btn" onclick="setFilter('tool', this)">支持工具 🛠️</button>
        <button class="filter-btn" onclick="setFilter('vision', this)">支持视觉 👁️</button>
        <button class="filter-btn" onclick="setFilter('reasoning', this)">支持思考 🧠</button>
        <button class="filter-btn" onclick="setFilter('idle', this)">🟢 畅通可用</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>模型 ID</th>
            <th>显示名称</th>
            <th>实时探针</th>
            <th>官方修订说明</th>
            <th>计费倍率</th>
            <th>上下文窗口</th>
            <th>最大输出</th>
            <th>思考档位 (Reasoning)</th>
            <th>特性标签</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="modelBody"></tbody>
      </table>
    </div>

    <!-- 原始数据查看 Modal -->
    <div class="modal" id="rawModal">
      <div class="modal-content">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <h3 style="margin:0; font-size:16px; color:var(--accent);">腾讯云官方原始数据 · <span id="rawModalTitle"></span></h3>
          <button onclick="closeRawModal()" style="background:transparent; color:var(--text-muted); font-size:18px;">✕</button>
        </div>
        <p style="color:var(--text-muted); font-size:12px; margin-bottom:10px;">以下为上游 <code>copilot.tencent.com/v3/config</code> 下发的 100% 原始未裁剪键值对：</p>
        <pre id="rawModalCode"></pre>
        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:14px;">
          <button class="btn-primary" onclick="copyRawCode()">📋 复制 JSON</button>
          <button class="btn-outline" onclick="closeRawModal()">关闭</button>
        </div>
      </div>
    </div>

    <!-- OAuth 扫码登录 Modal -->
    <div class="modal" id="oauthModal">
      <div class="modal-content" style="text-align:center; max-width:440px;">
        <h3 style="margin-bottom:8px; font-size:18px;">腾讯云官方扫码登录</h3>
        <p style="color:var(--text-muted); font-size:13px; margin-bottom:20px;">点击下方按钮在浏览器打开官方登录页，使用微信或腾讯云扫码授权：</p>
        <p style="margin: 20px 0;">
          <a id="loginLink" href="#" target="_blank" style="display:inline-block; padding:10px 20px; background:var(--primary); color:#fff; border-radius:8px; text-decoration:none; font-weight:bold; box-shadow:0 4px 12px rgba(2, 132, 199, 0.3);">
            👉 点击跳转至腾讯云授权登录页
          </a>
        </p>
        <div id="pollStatus" style="color:#facc15; font-size:13px; margin: 12px 0;">等待手机扫码授权中...</div>
        <button class="btn-outline" onclick="closeModal()">取消</button>
      </div>
    </div>

  </div>

  <script>
    let pollTimer = null;
    let allModels = [];
    let currentFilter = 'all';

    // 日志系统前端状态
    let allLogs = [];
    let logCatFilter = 'ALL';
    let logLevelFilter = 'ALL';
    let autoScrollEnabled = true;

    const guides = {
      openai: \`# OpenAI 兼容客户端配置 (如 Cursor / NextChat / Chatbox / LobeChat)
Base URL: http://127.0.0.1:${config.port}/v1
API Key : ${config.apiKey}
常用模型: deepseek-v4.1-flash (100万上下文/思考模式), hy4-preview, hy3 (免费)\`,
      claude: \`# Claude Code 官方命令行原生适配 (零配置直连)
export ANTHROPIC_BASE_URL=http://127.0.0.1:${config.port}
export ANTHROPIC_API_KEY=${config.apiKey}
export ANTHROPIC_MODEL=deepseek-v4.1-flash

claude\`,
      search: \`# 官方免费服务端联网检索与抓取
curl http://127.0.0.1:${config.port}/v1/search \\\\
  -H "Authorization: Bearer ${config.apiKey}" \\\\
  -H "Content-Type: application/json" \\\\
  -d '{"query": "腾讯云 CodeBuddy", "max_results": 3}'\`,
      curl: \`# 终端 cURL 快速测试 (带思维链与客户端工具)
curl http://127.0.0.1:${config.port}/v1/chat/completions \\\\
  -H "Authorization: Bearer ${config.apiKey}" \\\\
  -H "Content-Type: application/json" \\\\
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}],"stream":false}'\`
    };

    function switchGuide(type, el) {
      document.querySelectorAll('.guide-tab-btn').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
      document.getElementById('guideCodeText').innerText = guides[type];
    }
    document.getElementById('guideCodeText').innerText = guides.openai;

    function copyCurrentGuide() {
      const txt = document.getElementById('guideCodeText').innerText;
      navigator.clipboard.writeText(txt);
      alert('接入配置代码已复制到剪贴板！');
    }

    function toggleTheme() {
      const html = document.documentElement;
      if (html.classList.contains('dark')) {
        html.classList.remove('dark');
        html.classList.add('light');
        localStorage.setItem('theme', 'light');
      } else {
        html.classList.remove('light');
        html.classList.add('dark');
        localStorage.setItem('theme', 'dark');
      }
    }
    if (localStorage.getItem('theme') === 'light') {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
    }

    async function loadAccounts() {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      
      let totalCredits = 0;
      let inFlightTotal = 0;
      let activeAccCount = 0;

      data.forEach(a => {
        totalCredits += (a.creditsRemain || 0);
        inFlightTotal += (a.inFlight || 0);
        if (a.status === 'healthy' && !a.isCooldown) activeAccCount++;
      });

      document.getElementById('kpiTotalAcc').innerText = data.length;
      document.getElementById('kpiActiveAcc').innerText = activeAccCount;
      document.getElementById('kpiTotalCredits').innerText = totalCredits.toLocaleString('en-US', { minimumFractionDigits: 2 });
      document.getElementById('kpiInFlight').innerText = inFlightTotal;

      const tbody = document.getElementById('accBody');
      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:30px;">暂无可用账号，请点击右上角「➕ 扫码添加账号」</td></tr>';
        return;
      }

      tbody.innerHTML = data.map(a => {
        const checkinBadge = a.isCheckedInToday
          ? \`<span class="badge badge-ok" title="\${a.lastCheckinMsg}">✅ 已签到</span>\`
          : \`<span class="badge badge-cool">⏳ 未签到</span> <button class="btn-primary" style="padding:2px 8px; font-size:11px; margin-left:6px;" onclick="runCheckinSingle('\${a.uid}')">打卡</button>\`;

        return \`
          <tr>
            <td><code>\${a.uid}</code></td>
            <td><b>\${a.email}</b></td>
            <td><b style="color:#4ade80; font-size:14px;">\${(a.creditsRemain || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</b></td>
            <td>\${checkinBadge}</td>
            <td><span class="badge \${a.inFlight > 0 ? 'badge-blue' : ''}">\${a.inFlight || 0} / 3</span></td>
            <td>
              \${a.status === 'unauthorized' ? '<span class="badge badge-err">Token失效</span>' : 
                a.isCooldown ? '<span class="badge badge-cool">冷却退避</span>' : 
                '<span class="badge badge-ok">健康活跃</span>'}
            </td>
            <td>
              <button class="btn-outline" style="padding:3px 8px; font-size:11px;" onclick="runCheckinSingle('\${a.uid}')" title="同步积分">🔄 刷新</button>
              <button class="btn-danger" onclick="deleteAccount('\${a.uid}')">删除</button>
            </td>
          </tr>
        \`;
      }).join('');
    }

    // ── 日志系统前端逻辑 ────────────────────────────────────────────────
    async function fetchLogs() {
      try {
        const res = await fetch('/api/logs?limit=250');
        const data = await res.json();
        allLogs = data.logs || [];
        document.getElementById('logCountBadge').innerText = \`最近 \${allLogs.length} 条记录\`;
        renderLogs();
      } catch (_) {}
    }

    function renderLogs() {
      const query = document.getElementById('logSearch').value.toLowerCase().trim();
      const logBox = document.getElementById('logBox');

      const filtered = allLogs.filter(item => {
        if (logCatFilter !== 'ALL' && item.category !== logCatFilter) return false;
        if (logLevelFilter !== 'ALL' && item.level !== logLevelFilter) return false;
        if (query) {
          const matchMsg = (item.message || '').toLowerCase().includes(query);
          const matchCat = (item.category || '').toLowerCase().includes(query);
          const matchMeta = item.meta ? JSON.stringify(item.meta).toLowerCase().includes(query) : false;
          if (!matchMsg && !matchCat && !matchMeta) return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        logBox.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:30px;">暂无符合条件的日志记录</div>';
        return;
      }

      logBox.innerHTML = filtered.map(item => {
        const badgeClass = item.level === 'ERROR' ? 'log-badge-error' : item.level === 'WARN' ? 'log-badge-warn' : 'log-badge-info';
        const metaHtml = item.meta ? \`<span class="log-meta">\${escapeHtml(JSON.stringify(item.meta))}</span>\` : '';

        return \`
          <div class="log-row">
            <span class="log-time">\${item.time.slice(11)}</span>
            <span class="\${badgeClass}">\${item.level}</span>
            <span class="log-cat">[\${item.category}]</span>
            <span class="log-msg">\${escapeHtml(item.message)}\${metaHtml}</span>
          </div>
        \`;
      }).join('');

      if (autoScrollEnabled) {
        logBox.scrollTop = 0;
      }
    }

    function setLogCategory(cat, el) {
      logCatFilter = cat;
      el.parentElement.querySelectorAll('.filter-btn').forEach(b => {
        if (b.innerText.includes('类别') || b.innerText.includes('CHAT') || b.innerText.includes('ANTHROPIC') || b.innerText.includes('UPSTREAM') || b.innerText.includes('TOOLS') || b.innerText.includes('DISPATCH') || b.innerText.includes('CHECKIN')) {
          b.classList.remove('active');
        }
      });
      el.classList.add('active');
      renderLogs();
    }

    function setLogLevel(lvl, el) {
      logLevelFilter = lvl;
      el.parentElement.querySelectorAll('.filter-btn').forEach(b => {
        if (b.innerText.includes('级别') || b.innerText.includes('错误') || b.innerText.includes('警告')) {
          b.classList.remove('active');
        }
      });
      el.classList.add('active');
      renderLogs();
    }

    function filterLogs() {
      renderLogs();
    }

    function toggleAutoScroll() {
      autoScrollEnabled = !autoScrollEnabled;
      document.getElementById('btnAutoScroll').innerText = autoScrollEnabled ? '⏸ 滚动锁定: 开' : '▶ 滚动锁定: 关';
    }

    async function clearLiveLogs() {
      await fetch('/api/logs/clear', { method: 'POST' });
      allLogs = [];
      renderLogs();
    }

    function exportLogFile() {
      window.open('/api/logs/export', '_blank');
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    // ── 模型全景矩阵 ────────────────────────────────────────────────────
    async function loadModels(force = false) {
      try {
        document.getElementById('modelTotalBadge').innerText = '正在同步...';
        const res = await fetch('/api/models-detail' + (force ? '?refresh=1' : ''));
        allModels = await res.json();
        document.getElementById('kpiModelsCount').innerText = allModels.length;
        document.getElementById('modelTotalBadge').innerText = \`已同步 \${allModels.length} 款模型\`;
        renderModels();
      } catch (e) {
        document.getElementById('modelTotalBadge').innerText = '加载失败';
      }
    }

    function setFilter(filter, el) {
      currentFilter = filter;
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
      renderModels();
    }

    function filterModels() {
      renderModels();
    }

    function renderModels() {
      const query = document.getElementById('modelSearch').value.toLowerCase().trim();
      const tbody = document.getElementById('modelBody');

      const filtered = allModels.filter(m => {
        if (query && !m.id.toLowerCase().includes(query) && !(m.name||'').toLowerCase().includes(query)) {
          return false;
        }
        if (currentFilter === '1m') return m.maxInputTokens >= 900000;
        if (currentFilter === 'free') return (m.credits || '').includes('0.00') || (m.credits || '').includes('0.08') || (m.credits || '').includes('0.11');
        if (currentFilter === 'tool') return m.supportsToolCall;
        if (currentFilter === 'vision') return m.supportsImages;
        if (currentFilter === 'reasoning') return m.supportsReasoning || m.onlyReasoning || m.reasoning;
        if (currentFilter === 'idle') return m.probeStatus === 'idle';
        return true;
      });

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:30px;">未找到匹配的模型</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map((m, idx) => {
        const isFree = (m.credits || '').includes('0.00');
        const badgeCredit = isFree 
          ? '<span class="badge badge-ok">免费 x0.00</span>' 
          : \`<span class="badge badge-cool">\${m.credits || 'x1.00'}</span>\`;

        const ctxFmt = m.maxInputTokens >= 1000000 ? '1,000,000 (1M)' : 
          m.maxInputTokens >= 1000 ? \`\${(m.maxInputTokens/1000).toFixed(0)}K\` : (m.maxInputTokens || '-');
        const outFmt = m.maxOutputTokens >= 1000 ? \`\${(m.maxOutputTokens/1000).toFixed(0)}K\` : (m.maxOutputTokens || '-');

        let reasoningHtml = '<span style="color:var(--text-muted);">不支持</span>';
        if (m.reasoning || m.supportsReasoning || m.onlyReasoning) {
          const r = m.reasoning || {};
          const efforts = Array.isArray(r.supportedEfforts) ? r.supportedEfforts.join('/') : (r.defaultEffort || 'high');
          const disableTag = r.canDisableThinking ? '<span style="color:var(--text-muted);font-size:10px;">(可关)</span>' : '<span style="color:#f59e0b;font-size:10px;">(强制)</span>';
          reasoningHtml = \`<span class="badge badge-purple">🧠 \${efforts}</span> \${disableTag}\`;
        }

        const desc = m.descriptionZh || m.descriptionEn || '-';
        const probeHtml = m.probeStatus === 'cooldown' 
          ? '<span class="badge badge-err">🔴 冷却限流</span>' 
          : m.probeStatus === 'busy' 
          ? '<span class="badge badge-cool">🟡 局部限流</span>' 
          : '<span class="badge badge-ok">🟢 畅通</span>';

        return \`
          <tr>
            <td><code>\${m.id}</code></td>
            <td><b>\${m.name || m.id}</b></td>
            <td>\${probeHtml}</td>
            <td style="color:var(--text-muted); font-size:12px; max-width:240px;">\${desc}</td>
            <td>\${badgeCredit}</td>
            <td><span class="badge \${m.maxInputTokens >= 900000 ? 'badge-purple' : ''}">\${ctxFmt}</span></td>
            <td>\${outFmt}</td>
            <td>\${reasoningHtml}</td>
            <td>
              \${m.supportsToolCall ? '<span class="badge badge-blue" title="支持工具调用">🛠️ 工具</span> ' : ''}
              \${m.supportsImages ? '<span class="badge badge-ok" title="支持多模态视觉">👁️ 视觉</span> ' : ''}
            </td>
            <td style="white-space:nowrap;">
              <button class="btn-copy" onclick="copyText('\${m.id}')">📋 复制</button>
              <button class="btn-json" onclick="showRawJson(\${idx})">🔍 原始JSON</button>
            </td>
          </tr>
        \`;
      }).join('');
    }

    function showRawJson(idx) {
      const model = allModels[idx];
      document.getElementById('rawModalTitle').innerText = model.id;
      document.getElementById('rawModalCode').innerText = JSON.stringify(model, null, 2);
      document.getElementById('rawModal').style.display = 'flex';
    }

    function closeRawModal() {
      document.getElementById('rawModal').style.display = 'none';
    }

    function copyRawCode() {
      const code = document.getElementById('rawModalCode').innerText;
      navigator.clipboard.writeText(code);
      alert('上游原始 JSON 已成功复制到剪贴板！');
    }

    function exportAllRawJson() {
      const jsonStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(allModels, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute("href", jsonStr);
      downloadAnchor.setAttribute("download", "codebuddy-upstream-models.json");
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    }

    function copyText(txt) {
      navigator.clipboard.writeText(txt);
      alert(\`模型 ID 已复制: \${txt}\`);
    }

    async function runCheckin() {
      const btn = document.getElementById('btnAllCheckin');
      btn.disabled = true;
      btn.innerText = '⏳ 正在全员签到...';

      try {
        const res = await fetch('/api/checkin', { method: 'POST' });
        const data = await res.json();
        const results = data.results || [];
        const successList = results.filter(r => r.success);

        const alertBox = document.getElementById('checkinAlert');
        const alertTitle = document.getElementById('checkinAlertTitle');
        const alertDetail = document.getElementById('checkinAlertDetail');

        alertTitle.innerText = \`🎉 全员打卡完成：共 \${results.length} 个账号，\${successList.length} 个成功/已处于今日签到状态\`;
        alertDetail.innerText = results.map(r => \`• 账号 [\${r.email || r.uid}]：\${r.msg}\`).join('\\n');
        alertBox.style.display = 'block';

        window.scrollTo({ top: 0, behavior: 'smooth' });
        loadAccounts();
        fetchLogs();
      } catch (e) {
        alert('全员签到失败: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.innerText = '⚡ 全员打卡签到';
      }
    }

    async function runCheckinSingle(uid) {
      try {
        const res = await fetch('/api/checkin-single', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid })
        });
        const data = await res.json();
        alert(\`[单号签到反馈] \${data.msg}\`);
        loadAccounts();
        fetchLogs();
      } catch (e) {
        alert('签到失败: ' + e.message);
      }
    }

    async function startOAuth() {
      const res = await fetch('/api/oauth/start', { method: 'POST' });
      const data = await res.json();
      if (!data.state) return alert('获取登录链接失败');

      document.getElementById('loginLink').href = data.loginUrl;
      document.getElementById('oauthModal').style.display = 'flex';
      document.getElementById('pollStatus').innerText = '等待手机扫码授权中...';

      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        const pRes = await fetch('/api/oauth/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: data.state })
        });
        const pData = await pRes.json();
        if (pData.ok) {
          clearInterval(pollTimer);
          document.getElementById('pollStatus').innerText = '✅ 登录成功，账号已录入池！';
          setTimeout(() => { closeModal(); loadAccounts(); loadModels(true); fetchLogs(); }, 1200);
        }
      }, 2000);
    }

    function closeModal() {
      document.getElementById('oauthModal').style.display = 'none';
      if (pollTimer) clearInterval(pollTimer);
    }

    async function deleteAccount(uid) {
      if (!confirm('确定删除该账号吗？')) return;
      await fetch('/api/accounts/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid })
      });
      loadAccounts();
      fetchLogs();
    }

    loadAccounts();
    loadModels();
    fetchLogs();
    setInterval(loadAccounts, 5000);
    setInterval(fetchLogs, 2500);
  </script>
</body>
</html>`;
}
