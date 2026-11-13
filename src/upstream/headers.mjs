import crypto from 'node:crypto';
import { CURRENT_VERSION, USER_AGENT, resolveAccountRegion, REGION_BASE, REGION_CN, REGION_INTL, getPrivateDataPolicy } from '../config.mjs';
import { Logger } from '../core/logger.mjs';

// ─── 上游风控防护（实测得出，非猜测）────────────────────────────────────────
//
// 实测方法：拿真实 token 直连 copilot.tencent.com/v2/chat/completions，
// 逐个剥离请求头观察上游反应。结论：
//
// 1. ✅ 唯一强制项：Authorization
//    缺失或伪造 → HTTP 401（返回 HTML 页面，非 JSON）
//
// 2. ✅ 唯一风控项：User-Agent 含 "python-requests"（大小写不敏感的子串）
//    命中 → HTTP 400 {"code":11128,"msg":"request illegal"}
//    注意：即使混在官方 UA 里也会被拦，如
//      "CLI/2.179.0 CodeBuddy/2.179.0 python-requests/2.31.0" → 拦截
//    探测结果（22 个 UA 样本）：
//      拦截：python-requests/2.31.0、Python-Requests/2.31.0、python-requests、
//            python-requestsx/1.0、Xpython-requests/1.0、
//            my-python-requests-client/1.0、Mozilla/5.0 python-requests/...、
//            CLI/2.179.0 CodeBuddy/... python-requests/...
//      通过：python、requests、python_requests（下划线）、pythonrequests（无横线）、
//            curl、wget、axios、node-fetch、undici、Go-http-client、okhttp、
//            Java、Apache-HttpClient、reqwest、Postman、Insomnia、Chrome、
//            python-urllib、python-httpx、aiohttp、
//            空串、单空格、纯数字、完全不传 UA
//
// 3. ⚪ 其余应用层头均非强制
//    分组剥离测试（链路追踪 / 产品IDE / Agent / 会话ID / 隐私域名 /
//    安全头 / 身份 / 基础 共 8 组）全部返回 200 SSE 正常。
//    但这些头是**指纹一致性**的一部分，上游若将来加校验它们是第一批目标，
//    因此本模块仍完整发送（见下方注释中的抓包依据）。
//
// 维护建议：新增/修改任何请求头前，先跑一遍剥离测试确认是否触发 11128 或 401。

/** 上游明确拦截的 UA 子串（实测，大小写不敏感） */
export const BLOCKED_UA_SUBSTRINGS = ['python-requests'];

/**
 * 校验并修正 User-Agent，避免触发上游风控。
 * 返回安全的 UA 值；若原值命中黑名单则回落到官方 UA 并打警告。
 */
export function sanitizeUserAgent(ua) {
  const value = String(ua ?? '');
  const lower = value.toLowerCase();
  const hit = BLOCKED_UA_SUBSTRINGS.find(s => lower.includes(s));
  if (hit) {
    Logger.warn('UPSTREAM', `User-Agent 命中上游风控黑名单 (含 "${hit}")，已替换为官方 UA 以避免 400/11128. 原值: ${JSON.stringify(value.slice(0, 80))}`);
    return USER_AGENT;
  }
  return value || USER_AGENT;
}

/** 上游风控要求的 3 项基础头，缺失即失败，做一次兜底断言 */
function assertCriticalHeaders(headers) {
  const has = (k) => Object.keys(headers).some(x => x.toLowerCase() === k.toLowerCase());
  if (!has('Authorization')) {
    Logger.error('UPSTREAM', '请求头缺少 Authorization，上游必然返回 401');
  }
  if (!has('Content-Type')) {
    headers['Content-Type'] = 'application/json';
  }
  if (!has('User-Agent')) {
    headers['User-Agent'] = USER_AGENT;
  }
  return headers;
}


// ─── 构造官方全量会话与安全请求头 ───────────────────────────────────────────
//
// 全部依据来自**真实 CLI 2.179.0 抓包**（CLI 2.179.0 → POST /v2/chat/completions），
// 抓包文件：.capture/cmp/cli_2.179.0.log，完整覆盖 38 个应用层头。
//
// 抓包实测的 ID 关系（CLI 2.179.0 实测规律）：
//   X-Request-ID              = 01a1c0d2f5ed7f77aba16ff3a55d1f5a (messageId)
//   X-Conversation-Message-ID = 01a1c0d2f5ed7f77aba16ff3a55d1f5a (同 messageId)
//   X-Conversation-Request-ID = 01a1c0d2f332756aa0db51966f8f4636 (conversationRequestId)
//   X-Root-Request-ID         = 01a1c0d2f332756aa0db51966f8f4636 (同 conversationRequestId)
//   X-Conversation-ID         = 01a1c0d2-f29b-715e-8c54-6824ec76cfe9 (UUID 带横线)
//   X-Trace-ID                = traceId (与 X-B3-TraceId 同值，32 hex)
//   traceparent / baggage     = W3C 标准链路追踪
//   b3 / X-B3-*               = Zipkin B3 标准链路追踪
//   x-stainless-*             = OpenAI SDK 7.39.0 指纹
//
// UUID 版本：CLI 用 uuidv7（见 package/dist/codebuddy-headless.js 模块 34506）。

/**
 * 生成 UUID v7（带横线，36 字符）——对齐 CLI 的 uuidv7().toString()。
 * v7 结构：48 位毫秒时间戳 | 4 位版本(7) | 12 位 rand_a | 2 位变体(10) | 62 位 rand_b
 */
export function uuidv7() {
  const bytes = crypto.randomBytes(16);
  const ms = Date.now();

  // 前 6 字节 = 毫秒时间戳（大端）
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;

  // 版本位：高 4 位 = 7
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // 变体位：高 2 位 = 10
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** UUID v7 去掉横线，32 位 hex（CLI 的 toHex()） */
export function uuidv7Hex() {
  return uuidv7().replace(/-/g, '');
}

/**
 * 解析 X-Domain 取值。
 *
 * CLI 来源（package/dist/codebuddy-headless.js）：
 *   enterpriseHeaders(eA) {
 *     let el = eA?.domain || URI.parse(this.endpoint).authority;
 *     return el ? { [HTTP_HEADER_DOMAIN]: el } : {};
 *   }
 * 即：优先用 auth.domain，否则用当前 endpoint 的 host。
 * 实测国内版账号发出的是 www.codebuddy.cn（auth.domain 来自登录域）。
 */
function resolveDomainHeader(acc) {
  // 账号若显式带了 domain（登录域），优先用它
  if (acc && typeof acc.domain === 'string' && acc.domain.trim()) {
    return acc.domain.trim();
  }
  const region = resolveAccountRegion(acc);
  // 国内版实测为 web 域 www.codebuddy.cn（不是 api 域 copilot.tencent.com）
  const base = REGION_BASE[region] || REGION_BASE[REGION_CN];
  try {
    return new URL(base.web).hostname;
  } catch (_) {
    return region === REGION_INTL ? 'www.codebuddy.ai' : 'www.codebuddy.cn';
  }
}

/**
 * 解析出站 X-Private-Data 请求头取值。
 *
 * 依据官方 CLI（package/dist/codebuddy-headless.js 源码）：
 *   isEnterpriseEditionAccount(acc) = !!acc?.enterpriseId || acc?.type === 'ultimate' || acc?.type === 'exclusive'
 *   resolveModelOptimizationEnabled({ explicitEnabled, productDefaultEnabled, isEnterpriseEdition })
 *   ep[PRIVATE_DATA_HEADER] = resolveModelOptimizationEnabled(...) ? "false" : "true"
 *
 * 三套出站身份各自的官方默认（auto）：
 *   1. 国内个人号：发行版默认允许优化 (productDefaultEnabled=true) -> 发送 "false"
 *   2. 国际版账号：国际发行版默认关闭优化 (DefaultModelOptimizationOff=true) -> 发送 "true"
 *   3. 企业版账号：企业数据默认私有隔离保护 (isEnterprise=true) -> 发送 "true"
 *
 * 若网关配置为 'true' 或 'false' 则无条件覆盖。
 */
export function resolvePrivateDataHeader(acc) {
  const policy = getPrivateDataPolicy();
  if (policy === 'true') return 'true';
  if (policy === 'false') return 'false';

  // auto: 保持三套出站身份各自的官方默认
  if (!acc) return 'false';

  // 1. 企业版账号
  const isEnterprise = Boolean(acc.enterpriseId || acc.type === 'ultimate' || acc.type === 'exclusive');
  if (isEnterprise) return 'true';

  // 2. 国际版账号
  const region = resolveAccountRegion(acc);
  if (region === REGION_INTL) return 'true';

  // 3. 国内个人号
  return 'false';
}

/**
 * 构造发往上游 /v2/chat/completions 的请求头。
 *
 * @param {string} accessToken 账号 accessToken
 * @param {string} targetModel 实际上游模型名（裸名）
 * @param {string} sessionKey  会话标识，用作 X-Conversation-ID
 * @param {string} uid         账号 uid
 * @param {boolean} isGzip     是否 gzip 压缩请求体
 * @param {object} acc         账号对象（用于取 domain / region），可选
 */
export function buildOfficialUpstreamHeaders(accessToken, targetModel, sessionKey, uid, isGzip = false, acc = null) {
  // ── 一次请求内的时间戳与 ID ──────────────────────────────
  // 抓包实测（CLI 2.179.0）：
  //   X-Request-ID              = messageId
  //   X-Conversation-Message-ID = messageId (与 Request-ID 相同)
  //   X-Conversation-Request-ID = conversationRequestId
  //   X-Root-Request-ID         = conversationRequestId (与 Conversation-Request-ID 相同)
  //   X-Conversation-ID         = conversationId (UUID v7 带横线)
  const messageId = uuidv7Hex();
  const conversationRequestId = uuidv7Hex();

  // Conversation-ID：会话标识。CLI 侧是 session.id（UUID v7 带横线）。
  // 网关的 sessionKey 可能是 md5 或客户端 X-Session-ID：
  //   · 若已是 36 字符 UUID 形式 → 原样保留横线
  //   · 若是 32 位 hex（例如被我们去过横线）→ 按 UUID 格式重新加回横线
  //   · 其他（md5 / 任意串）→ 用其前 32 位 hex 拼成合法 UUID 形态，或直接生成新 v7
  let conversationId;
  const rawSession = String(sessionKey || '').trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawSession)) {
    // 已是合法 UUID v7 → 原样使用
    conversationId = rawSession;
  } else if (/^[0-9a-f]{32}$/i.test(rawSession)) {
    // 任意 32 位 hex（md5 / 去横线 UUID）→ 强制改写为合法 UUID v7：
    const h = rawSession.toLowerCase();
    const g4 = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);   // 变体位 10xx
    conversationId = [
      h.slice(0, 8),
      h.slice(8, 12),
      '7' + h.slice(13, 16),                                      // 版本位 7
      g4 + h.slice(17, 20),
      h.slice(20, 32),
    ].join('-');
  } else {
    conversationId = uuidv7();                                     // 无法识别 → 新 v7
  }

  // 链路追踪 ID：W3C 与 B3 双链支持（CLI 2.179.0 实测）
  const traceId = uuidv7Hex();
  const spanId = crypto.randomBytes(8).toString('hex');
  const parentSpanId = crypto.randomBytes(8).toString('hex');

  // OS 与平台架构（对齐 Stainless SDK）
  const osName = process.platform === 'win32' ? 'Windows'
    : (process.platform === 'darwin' ? 'MacOS' : 'Linux');
  const archName = process.arch === 'x64' ? 'x64'
    : (process.arch === 'arm64' ? 'arm64' : process.arch);

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    // 经风控校验：命中 "python-requests" 会被上游 400/11128 拦截
    'User-Agent': sanitizeUserAgent(USER_AGENT),
    'Content-Type': 'application/json',
    // 实测：即使 stream:true，Accept 仍是 application/json（流式靠 body 的 stream 参数协商）
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-CodeBuddy-Request': '1',

    // ── 链路 ID（CLI 2.179.0 实测两两对齐）────────────────
    'X-Request-ID': messageId,
    'X-Conversation-Message-ID': messageId,
    'X-Conversation-Request-ID': conversationRequestId,
    'X-Root-Request-ID': conversationRequestId,
    'X-Conversation-ID': conversationId,

    // ── Stainless SDK 指纹头（CLI 2.179.0 实测升级为 7.39.0）─
    'x-stainless-arch': archName,
    'x-stainless-lang': 'js',
    'x-stainless-os': osName,
    'x-stainless-package-version': '7.39.0',
    'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version,

    // ── 链路追踪双协议（W3C + B3，CLI 2.179.0 实测）───────
    'traceparent': `00-${traceId}-${spanId}-01`,
    'baggage': `codebuddy.session_id=${conversationId},codebuddy.conversation_request_id=${conversationRequestId}`,
    'b3': `${traceId}-${spanId}-1-${parentSpanId}`,
    'X-B3-TraceId': traceId,
    'X-B3-SpanId': spanId,
    'X-B3-ParentSpanId': parentSpanId,
    'X-B3-Sampled': '1',
    'X-Trace-ID': traceId,

    // ── 身份与产品 ─────────────────────────────────────
    'X-Domain': resolveDomainHeader(acc),
    'X-Product': 'SaaS',
    'X-Private-Data': resolvePrivateDataHeader(acc),
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'X-IDE-Version': CURRENT_VERSION,

    // ── Agent 元信息 ───────────────────────────────────
    'X-Agent-Intent': 'craft',
    'X-Agent-Runtime': 'other',
    'X-Agent-Purpose': 'conversation',
    'X-Agent-Type': 'main'
  };

  if (uid) {
    headers['X-User-Id'] = String(uid);
  }

  if (isGzip) {
    headers['Content-Encoding'] = 'gzip';
  }

  return assertCriticalHeaders(headers);
}
