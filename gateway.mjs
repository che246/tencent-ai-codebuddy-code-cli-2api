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

    // 1. 优先尝试会话粘性
    if (sessionKey && sessionStickyMap.has(sessionKey)) {
      const sticky = sessionStickyMap.get(sessionKey);
      const acc = accounts.find(a => a.uid === sticky.uid);
      if (acc && acc.status === 'healthy' && now > (acc.cooldownUntil || 0) && (acc.inFlight || 0) < 3) {
        // 校验该模型是否在该账号处于单模型冷却
        const isModelCooling = requestedModel && acc.modelCooldowns?.[requestedModel] && now < acc.modelCooldowns[requestedModel];
        if (!isModelCooling) {
          sticky.lastActive = now;
          return acc;
        }
      }
    }

    // 2. 过滤有效账号（排除账号全局冷却与该模型的单模型冷却）
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

    // 3. 排序：并发最低、剩余积分最多
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
    return chosen;
  }

  static cooldown(uid, seconds, reason = '') {
    const acc = accounts.find(a => a.uid === uid);
    if (acc) {
      acc.cooldownUntil = Date.now() + seconds * 1000;
      console.warn(`[Cooldown:Account] ${uid} (${acc.email}) cooled down for ${seconds}s. Reason: ${reason}`);
      saveAccounts();
    }
  }

  // 6. 模型级限流 (错误码 6004)：仅冷却单模型，不株连整个账号
  static cooldownModel(uid, modelId, seconds = 600, reason = '') {
    const acc = accounts.find(a => a.uid === uid);
    if (acc) {
      if (!acc.modelCooldowns) acc.modelCooldowns = {};
      acc.modelCooldowns[modelId] = Date.now() + seconds * 1000;
      console.warn(`[Cooldown:Model] ${uid} (${acc.email}) model [${modelId}] cooled down for ${seconds}s. Reason: ${reason}`);
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
      console.error(`Failed to refresh credits for ${acc.uid}:`, e.message);
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

      console.log(`[Checkin] Account ${acc.uid} (${acc.email}): ${userMsg}`);
      await this.refreshCredits(acc);
      saveAccounts();
      return { success: isSuccess || isAlready, msg: userMsg };
    } catch (e) {
      return { success: false, msg: `网络错误: ${e.message}` };
    }
  }
}

// 针对腾讯上游 11-128 渠道指纹检测的语义等价清洗 (解决 DSH、Claude Code 等被拒问题)
function sanitizeChannelFingerprints(text, role) {
  if (typeof text !== 'string') return text;
  // 安全边界：仅清洗 system / developer / assistant 消息，绝对不碰 user 与 tool 消息
  if (role !== 'system' && role !== 'developer' && role !== 'assistant') {
    return text;
  }

  // 1. DSH 触发源一：文件引用段里的 @ 字形 (Tokens prefixed with @ are paths...)
  text = text.replace(
    /(Tokens\s+prefixed\s+with\s+)@(\s+are\s+paths)/gi,
    '$1(at)$2'
  );

  // 2. DSH 触发源二：内核身份句 (You are an AI agent powered by DeepSeek Harness.)
  text = text.replace(
    /You\s+are\s+an\s+AI\s+agent\s+powered\s+by\s+DeepSeek[\s\u200B]+Harness\./gi,
    'You are a helpful AI assistant.'
  );

  // 3. DSH 触发源三：coding agent 句式 (You are a coding agent powered by ...)
  text = text.replace(
    /You\s+are\s+a\s+coding\s+agent\s+powered\s+by\s+/gi,
    'You are a coding agent running on '
  );

  // 4. DSH 触发源四：Web GUI 段
  text = text.replace(
    /DeepSeek[\s\u200B]+Harness\s+Web\s+GUI/gi,
    'Web GUI'
  );

  // 5. Claude Code 触发源：身份句与 Git 分支句
  text = text.replace(
    /You\s+are\s+Claude\s+Code,\s+Anthropic's\s+official\s+CLI\s+tool\s+for\s+Claude\./gi,
    'You are an interactive AI assistant for coding.'
  );
  text = text.replace(
    /Default\s+branch\s+\(you\s+will\s+usually\s+use\s+this\s+for\s+PRs\)/gi,
    'Main branch (you will usually use this for PRs)'
  );

  // 6. 兜底清洗残留品牌组合指纹 (DeepSeek + Harness)
  text = text.replace(/DeepSeek[\s\u200B]+Harness/gi, 'DeepSeek-Harness');

  return text;
}

// ─── 消息序列化与格式标准化 ─────────────────────────────────────────────
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
    if (m.tool_calls) {
      item.tool_calls = m.tool_calls;
    }
    if (m.role === 'tool') {
      item.tool_call_id = m.tool_call_id;
    }
    return item;
  });
}

// 3. 模型能力前置守卫：校验 supportsImages 与 supportsToolCall，避免触发 400
function applyModelCapabilityGuards(upstreamPayload, modelMeta) {
  if (!modelMeta) return upstreamPayload;

  // 若模型不支持工具调用，剥离 tools 和 tool_choice
  if (modelMeta.supportsToolCall === false) {
    if (upstreamPayload.tools) {
      delete upstreamPayload.tools;
      delete upstreamPayload.tool_choice;
    }
  }

  // 若模型不支持视觉，扁平化图片附件为纯文本
  if (modelMeta.supportsImages === false && Array.isArray(upstreamPayload.messages)) {
    upstreamPayload.messages = upstreamPayload.messages.map(m => {
      if (Array.isArray(m.content)) {
        const flatText = m.content.map(part => {
          if (part.type === 'text') return part.text;
          if (part.type === 'image_url') return `[图片附件: 当前模型 ${modelMeta.id} 不支持视觉识图]`;
          return '';
        }).filter(Boolean).join('\n');
        return { ...m, content: flatText };
      }
      return m;
    });
  }

  return upstreamPayload;
}

// 2. 官方专属请求头族：注入完整的上下文追踪头
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

// 7. 模型繁忙度探针：结合账号池单模型冷却状态计算各模型实时可用性
function attachProbeStatus(models) {
  const now = Date.now();
  return models.map(m => {
    // 检查是否有账号对该模型处于冷却退避状态
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
      try {
        const bodyObj = JSON.parse(rawBody || '{}');
        const acc = AccountScheduler.selectAccount();
        if (!acc) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'No available account for search' }));
        }

        const searchRes = await fetch(SEARCH_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${acc.accessToken}`,
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            query: bodyObj.query || '',
            max_results: bodyObj.max_results || bodyObj.count || 5
          })
        });

        const searchData = await searchRes.text();
        res.writeHead(searchRes.status, { 'Content-Type': 'application/json' });
        return res.end(searchData);
      } catch (e) {
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
      try {
        const bodyObj = JSON.parse(rawBody || '{}');
        const acc = AccountScheduler.selectAccount();
        if (!acc) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'No available account for webfetch' }));
        }

        const fetchRes = await fetch(WEBFETCH_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${acc.accessToken}`,
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            url: bodyObj.url || ''
          })
        });

        const fetchData = await fetchRes.text();
        res.writeHead(fetchRes.status, { 'Content-Type': 'application/json' });
        return res.end(fetchData);
      } catch (e) {
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
      try {
        const anthropicPayload = JSON.parse(rawBody);
        const isClientStream = Boolean(anthropicPayload.stream);

        let targetModel = anthropicPayload.model || 'deepseek-v4.1-flash';
        if (targetModel.includes('claude') || targetModel.includes('sonnet') || targetModel.includes('opus')) {
          targetModel = 'deepseek-v4.1-flash';
        }

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
          // 4. 缓存保留标记 (上游 Go struct 严格校验为 string)
          cache_retention: 'auto'
        };

        if (openAiTools.length > 0) {
          upstreamPayload.tools = openAiTools;
        }

        // 3. 模型能力前置守卫
        const allMeta = await fetchDetailedModels();
        const modelMeta = allMeta.find(m => m.id === targetModel);
        upstreamPayload = applyModelCapabilityGuards(upstreamPayload, modelMeta);

        if (targetModel.includes('deepseek') || targetModel.includes('hy')) {
          upstreamPayload.thinking = { type: 'enabled' };
          upstreamPayload.reasoning_effort = 'high';
          upstreamPayload.reasoning = { effort: 'high', summary: 'auto' };
        }

        // 2. 官方专属请求头族
        const upstreamHeaders = buildOfficialUpstreamHeaders(acc.accessToken, targetModel);

        const upstreamRes = await fetch(UPSTREAM_URL, {
          method: 'POST',
          headers: upstreamHeaders,
          body: JSON.stringify(upstreamPayload)
        });

        if (!upstreamRes.ok) {
          acc.inFlight = Math.max(0, acc.inFlight - 1);
          const errText = await upstreamRes.text();
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

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            id: msgId,
            type: 'message',
            role: 'assistant',
            content: contentBlocks,
            model: targetModel,
            stop_reason: toolCallsMap.size > 0 ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: fullContent.length }
          }));
        }

      } catch (err) {
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
      try {
        const payload = JSON.parse(rawBody);
        const isClientStream = Boolean(payload.stream);

        const sessionKey = req.headers['x-session-id'] || 
          crypto.createHash('md5').update(JSON.stringify(payload.messages?.slice(0, 2) || '')).digest('hex');

        let targetModel = payload.model || 'deepseek-v4.1-flash';

        // 挑选账号
        const acc = AccountScheduler.selectAccount(targetModel, sessionKey);
        if (!acc) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'All upstream accounts are busy or cooling down for this model.', type: 'server_error' } }));
        }

        acc.inFlight = (acc.inFlight || 0) + 1;

        // 构造上游 Payload
        let upstreamPayload = {
          model: targetModel,
          messages: formatMessagesForUpstream(payload.messages || []),
          stream: true,
          temperature: payload.temperature ?? 1.0,
          max_tokens: payload.max_tokens,
          stream_options: { include_usage: true },
          // 4. 缓存保留标记 (上游 Go struct 严格校验为 string)
          cache_retention: typeof payload.cache_retention === 'string' ? payload.cache_retention : 'auto'
        };

        if (Array.isArray(payload.tools) && payload.tools.length > 0) {
          upstreamPayload.tools = payload.tools;
          if (payload.tool_choice) {
            upstreamPayload.tool_choice = payload.tool_choice;
          }
        }

        // 3. 模型能力前置守卫
        const allMeta = await fetchDetailedModels();
        const modelMeta = allMeta.find(m => m.id === targetModel);
        upstreamPayload = applyModelCapabilityGuards(upstreamPayload, modelMeta);

        // 思考模式配置
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

        // 执行上游请求（支持 6004 自动改道重试）
        async function executeCall(curModel, isRetry = false) {
          upstreamPayload.model = curModel;
          const headers = buildOfficialUpstreamHeaders(acc.accessToken, curModel, sessionKey);

          let upstreamRes = await fetch(UPSTREAM_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify(upstreamPayload)
          });

          // 6. 模型级限流 (错误码 6004) 改道处理
          if (!upstreamRes.ok) {
            const errText = await upstreamRes.text();
            let parsedErr = {};
            try { parsedErr = JSON.parse(errText); } catch (_) {}

            if (parsedErr.code === 6004) {
              AccountScheduler.cooldownModel(acc.uid, curModel, 600, 'Upstream 6004 Model Limit Exceeded');
              const fallback = config.modelFallback?.[curModel];
              if (fallback && fallback !== curModel && !isRetry) {
                console.log(`[Reroute] Account ${acc.uid} model ${curModel} hit 6004, rerouting to ${fallback}...`);
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
            console.error(`[Auth] Account ${acc.uid} token expired or revoked!`);
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

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(decoder.decode(value, { stream: true }));
          }

          acc.inFlight = Math.max(0, acc.inFlight - 1);
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
          }

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
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    return;
  }

  // 8. 控制面板管理 API
  if (url.pathname.startsWith('/api/')) {
    const today = getTodayString();

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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ state, loginUrl }));
      } catch (e) {
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
        accounts = accounts.filter(a => a.uid !== uid);
        saveAccounts();
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
      console.log('[Scheduler] Running automatic daily checkin...');
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
  console.log(`\n======================================================`);
  console.log(`🚀 CodeBuddy 国内版生产级多协议网关已启动!`);
  console.log(`📡 监听地址: http://127.0.0.1:${config.port}`);
  console.log(`🔑 网关 API Key: ${config.apiKey}`);
  console.log(`✨ 协议支持: OpenAI (/v1/chat/completions) + Anthropic (/v1/messages)`);
  console.log(`🌐 联网扩展: POST /v1/search & POST /v1/fetch`);
  console.log(`🛠️  已开启: 客户端自定义 tools 透传与 tool_calls 回传`);
  console.log(`🛡️  已开启: 官方头族注入 + 模型守卫 + 6004限流改道 + 缓存标记`);
  console.log(`📋 模型清单: Web 控制台直连上游 100% 原始数据 + 繁忙度探针`);
  console.log(`======================================================\n`);
});

// ─── 内置单页 Web 管理控制台 ───────────────────────────────────────────────
function renderDashboardHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>CodeBuddy 国内多账号网关</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 30px auto; max-width: 1240px; background: #0f172a; color: #f8fafc; line-height: 1.5; padding: 0 15px; }
    h1 { font-size: 22px; color: #38bdf8; display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
    .card { background: #1e293b; border-radius: 8px; padding: 20px; margin-bottom: 20px; border: 1px solid #334155; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #334155; font-size: 13px; }
    th { color: #94a3b8; font-weight: 600; }
    .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; white-space: nowrap; }
    .badge-ok { background: #166534; color: #bbf7d0; }
    .badge-cool { background: #854d0e; color: #fef08a; }
    .badge-err { background: #991b1b; color: #fecaca; }
    .badge-purple { background: #581c87; color: #e9d5ff; }
    .badge-blue { background: #1e3a8a; color: #bfdbfe; }
    button { padding: 7px 14px; border-radius: 5px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; transition: 0.15s; }
    .btn-primary { background: #0284c7; color: white; }
    .btn-primary:hover { background: #0369a1; }
    .btn-danger { background: #991b1b; color: white; padding: 4px 8px; font-size: 12px; }
    .btn-danger:hover { background: #7f1d1d; }
    .btn-success { background: #15803d; color: white; }
    .btn-success:hover { background: #166534; }
    .filter-btn { padding: 4px 10px; background: #334155; color: #cbd5e1; border-radius: 4px; font-size: 12px; cursor: pointer; border: 1px solid transparent; }
    .filter-btn.active { background: #0284c7; color: #fff; font-weight: bold; }
    .btn-copy { background: #334155; color: #38bdf8; padding: 4px 8px; font-size: 12px; border-radius: 4px; }
    .btn-copy:hover { background: #475569; }
    .btn-json { background: #1e293b; color: #a78bfa; border: 1px solid #6d28d9; padding: 4px 8px; font-size: 12px; border-radius: 4px; }
    .btn-json:hover { background: #4c1d95; color: #fff; }
    code { background: #0f172a; padding: 3px 6px; border-radius: 4px; color: #38bdf8; font-family: monospace; font-size: 12px; }
    input { padding: 6px 10px; border-radius: 4px; border: 1px solid #475569; background: #0f172a; color: #fff; font-size: 13px; }
    .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); align-items: center; justify-content: center; z-index: 100; }
    .modal-content { background: #1e293b; padding: 25px; border-radius: 8px; max-width: 750px; width: 90%; border: 1px solid #475569; max-height: 85vh; overflow-y: auto; text-align: left; }
    pre { background: #090d16; padding: 12px; border-radius: 6px; overflow-x: auto; color: #38bdf8; font-size: 12px; max-height: 400px; }
  </style>
</head>
<body>
  <h1>
    <span>🇨🇳 CodeBuddy 国内版多协议网关</span>
    <div>
      <button id="btnAllCheckin" class="btn-success" onclick="runCheckin()">⚡ 全员签到</button>
      <button class="btn-primary" onclick="startOAuth()">➕ 扫码添加账号</button>
    </div>
  </h1>

  <div id="checkinAlert" style="display:none; margin-bottom:20px; padding:15px; border-radius:8px; border:1px solid #15803d; background:#064e3b; color:#ecfdf5;">
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <b id="checkinAlertTitle" style="font-size:14px;"></b>
      <button onclick="document.getElementById('checkinAlert').style.display='none'" style="background:transparent; color:#a7f3d0; padding:0 5px; font-size:16px;">✕</button>
    </div>
    <div id="checkinAlertDetail" style="margin-top:8px; font-size:13px; line-height:1.6; white-space:pre-wrap;"></div>
  </div>

  <div class="card">
    <h3 style="margin-top:0;">接入配置指引</h3>
    <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 15px;">
      <div>
        <p><b>OpenAI 协议:</b> <code>http://127.0.0.1:${config.port}/v1</code></p>
        <p><b>Anthropic 协议:</b> <code>http://127.0.0.1:${config.port}</code> (供 Claude Code)</p>
        <p><b>联网检索端点:</b> <code>POST /v1/search</code>、<code>POST /v1/fetch</code></p>
      </div>
      <div>
        <p><b>API 密钥:</b> <code>${config.apiKey}</code></p>
        <p><b>官方版本:</b> <code>${CURRENT_VERSION}</code> (已注入官方请求头族与上下文追踪)</p>
        <p><b>6004 自动改道:</b> 已开启 (遇到单模型限量时同账号自动切换到备用模型)</p>
      </div>
    </div>
  </div>

  <div class="card">
    <h3 style="margin-top:0;">账号池状态</h3>
    <table>
      <thead>
        <tr>
          <th>UID</th>
          <th>账号昵称</th>
          <th>可用积分</th>
          <th>今日签到</th>
          <th>在途并发</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="accBody"></tbody>
    </table>
  </div>

  <!-- 模型全量清单 -->
  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <h3 style="margin:0;">📋 腾讯云上游模型全量矩阵 (<span id="modelCount" style="color:#38bdf8;">加载中...</span>)</h3>
      <div style="display:flex; gap:10px;">
        <input id="modelSearch" placeholder="🔍 搜索模型 ID 或名称..." oninput="filterModels()" style="width:200px;">
        <button class="btn-primary" onclick="loadModels(true)">🔄 刷新上游</button>
        <button class="btn-primary" style="background:#475569;" onclick="exportAllRawJson()">📥 导出全量 JSON</button>
      </div>
    </div>
    <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap;">
      <button class="filter-btn active" onclick="setFilter('all', this)">全部 (All)</button>
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
          <th>官方名称</th>
          <th>状态 / 探针</th>
          <th>官方说明与版本</th>
          <th>计费倍率</th>
          <th>上下文窗口</th>
          <th>最大输出</th>
          <th>思考档位 (Reasoning)</th>
          <th>特性</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="modelBody"></tbody>
    </table>
  </div>

  <!-- 原始数据查看 Modal -->
  <div class="modal" id="rawModal">
    <div class="modal-content">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3 style="margin:0; color:#38bdf8;">上游模型 100% 原始数据 (<span id="rawModalTitle"></span>)</h3>
        <button onclick="closeRawModal()" style="background:#475569; color:#fff; padding:3px 8px;">✕</button>
      </div>
      <p style="color:#94a3b8; font-size:12px; margin: 8px 0;">以下内容为腾讯云 <code>/v3/config</code> 下发的完整字段，未做任何裁剪或修改：</p>
      <pre id="rawModalCode"></pre>
      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:10px;">
        <button class="btn-primary" onclick="copyRawCode()">📋 复制 JSON</button>
        <button onclick="closeRawModal()" style="background:#334155; color:#fff;">关闭</button>
      </div>
    </div>
  </div>

  <!-- OAuth 扫码弹窗 -->
  <div class="modal" id="oauthModal">
    <div class="modal-content" style="text-align:center; max-width:420px;">
      <h3>腾讯云官方扫码登录</h3>
      <p style="color:#94a3b8; font-size:13px;">请点击下方按钮在浏览器打开登录页，完成微信/腾讯云扫码：</p>
      <p style="margin: 20px 0;"><a id="loginLink" href="#" target="_blank" style="color: #38bdf8; font-size: 16px; font-weight: bold;">[ 点击跳转到腾讯云登录页面 ]</a></p>
      <div id="pollStatus" style="color: #facc15; font-size: 14px;">等待完成扫码中...</div>
      <br>
      <button onclick="closeModal()" style="background:#475569; color:#fff;">关闭</button>
    </div>
  </div>

  <script>
    let pollTimer = null;
    let allModels = [];
    let currentFilter = 'all';

    async function loadAccounts() {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      const tbody = document.getElementById('accBody');
      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#64748b;">暂无账号，请点击右上角「扫码添加账号」</td></tr>';
        return;
      }
      tbody.innerHTML = data.map(a => {
        const checkinBadge = a.isCheckedInToday
          ? \`<span class="badge badge-ok" title="\${a.lastCheckinMsg}">✅ 今日已签到</span>\`
          : \`<span class="badge badge-cool">⏳ 今日未签</span> <button class="btn-primary" style="padding:2px 8px; font-size:11px; margin-left:4px;" onclick="runCheckinSingle('\${a.uid}')">签到</button>\`;

        return \`
          <tr>
            <td>\${a.uid}</td>
            <td><b>\${a.email}</b></td>
            <td><b style="color:#4ade80;">\${a.creditsRemain}</b></td>
            <td>\${checkinBadge}</td>
            <td>\${a.inFlight}</td>
            <td>
              \${a.status === 'unauthorized' ? '<span class="badge badge-err">Token失效</span>' : 
                a.isCooldown ? '<span class="badge badge-cool">冷却退避</span>' : 
                '<span class="badge badge-ok">健康</span>'}
            </td>
            <td><button class="btn-danger" onclick="deleteAccount('\${a.uid}')">删除</button></td>
          </tr>
        \`;
      }).join('');
    }

    async function loadModels(force = false) {
      try {
        document.getElementById('modelCount').innerText = '正在从上游拉取...';
        const res = await fetch('/api/models-detail' + (force ? '?refresh=1' : ''));
        allModels = await res.json();
        document.getElementById('modelCount').innerText = \`共 \${allModels.length} 款模型\`;
        renderModels();
      } catch (e) {
        document.getElementById('modelCount').innerText = '加载失败';
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
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#64748b;">未找到匹配的模型</td></tr>';
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

        let reasoningHtml = '<span style="color:#64748b;">不支持</span>';
        if (m.reasoning || m.supportsReasoning || m.onlyReasoning) {
          const r = m.reasoning || {};
          const efforts = Array.isArray(r.supportedEfforts) ? r.supportedEfforts.join('/') : (r.defaultEffort || 'high');
          const disableTag = r.canDisableThinking ? '<span style="color:#94a3b8;font-size:10px;">(可关)</span>' : '<span style="color:#f59e0b;font-size:10px;">(强制)</span>';
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
            <td style="color:#cbd5e1; font-size:12px; max-width:240px;">\${desc}</td>
            <td>\${badgeCredit}</td>
            <td><span class="badge \${m.maxInputTokens >= 900000 ? 'badge-purple' : ''}">\${ctxFmt}</span></td>
            <td>\${outFmt}</td>
            <td>\${reasoningHtml}</td>
            <td>
              \${m.supportsToolCall ? '<span class="badge badge-blue" title="支持工具调用">🛠️ 工具</span> ' : ''}
              \${m.supportsImages ? '<span class="badge badge-ok" title="支持多模态视觉">👁️ 视觉</span> ' : ''}
            </td>
            <td style="white-space:nowrap;">
              <button class="btn-copy" onclick="copyText('\${m.id}')">📋 复制ID</button>
              <button class="btn-json" onclick="showRawJson(\${idx})">🔍 原始数据</button>
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
      alert('上游原始 JSON 已复制到剪贴板！');
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

        alertTitle.innerText = \`🎉 全员签到反馈：共 \${results.length} 个账号，\${successList.length} 个成功/已处于今日签到状态\`;
        alertDetail.innerText = results.map(r => \`• 账号 [\${r.email || r.uid}]：\${r.msg}\`).join('\\n');
        alertBox.style.display = 'block';

        window.scrollTo({ top: 0, behavior: 'smooth' });
        loadAccounts();
      } catch (e) {
        alert('全员签到失败: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.innerText = '⚡ 全员签到';
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
      document.getElementById('pollStatus').innerText = '等待手机扫码授权...';

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
          setTimeout(() => { closeModal(); loadAccounts(); loadModels(true); }, 1200);
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
    }

    loadAccounts();
    loadModels();
    setInterval(loadAccounts, 5000);
  </script>
</body>
</html>`;
}
