import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── 上游端点（多区域）────────────────────────────────────────────────────────
// 实测结论（2026-11）：
//   · 国际版与国内版的 API 路径**完全同构**，仅 base 域名不同
//     /v2/plugin/auth/state、/v2/plugin/auth/token、/v2/chat/completions、
//     /v3/config、/billing/meter/*、/agenttool/v1/* 全部一致，连业务错误码都相同。
//   · token 按签发域隔离：国内 token 打国际版 chat 一律 401，
//     iss 字段为 https://www.codebuddy.cn/auth/realms/copilot。
//   · 国际版 /v3/config 无需鉴权即可读取模型列表（28 款，含 gpt-6-astra/grok-4.7 等）。
// 因此接入国际版只需按账号 region 选择 base 域名，其余逻辑零改动。

export const REGION_CN = 'cn';
export const REGION_INTL = 'intl';

export const REGION_BASE = {
  // 国内版（腾讯云）
  [REGION_CN]: {
    label: '国内版',
    api: 'https://copilot.tencent.com',   // chat / config / billing / agenttool
    web: 'https://www.codebuddy.cn',      // 签到等 Web 侧接口
  },
  // 国际版
  [REGION_INTL]: {
    label: '国际版',
    api: 'https://www.codebuddy.ai',
    web: 'https://www.codebuddy.ai',
  },
};

/** 规范化 region 值，未知值回落到国内版（保持向后兼容） */
export function normalizeRegion(region) {
  const v = String(region || '').trim().toLowerCase();
  if (v === REGION_INTL || v === 'international' || v === 'global' || v === 'ai') return REGION_INTL;
  return REGION_CN;
}

/**
 * 从账号推断区域。
 * 优先用显式 region 字段；没有则看 endpoint 域名：
 * 含 codebuddy.ai 的为国际版。这样手工录入的官方账号（只带 endpoint）也能正确路由。
 */
export function resolveAccountRegion(acc) {
  if (!acc) return REGION_CN;
  if (acc.region) return normalizeRegion(acc.region);
  const ep = String(acc.endpoint || '').toLowerCase();
  if (ep.includes('codebuddy.ai')) return REGION_INTL;
  return REGION_CN;
}

/** 取某账号的上游 base 配置 */
export function baseForAccount(acc) {
  return REGION_BASE[resolveAccountRegion(acc)];
}

/** 拼出某账号的完整端点 URL */
export function endpointsFor(acc) {
  const b = baseForAccount(acc);
  return {
    apiBase: b.api,
    webBase: b.web,
    upstream: `${b.api}/v2/chat/completions`,
    config: `${b.api}/v3/config`,
    summary: `${b.api}/billing/meter/get-user-resource-summary`,
    checkin: `${b.web}/v2/billing/meter/daily-checkin`,
    search: `${b.api}/agenttool/v1/search`,
    webfetch: `${b.api}/agenttool/v1/webfetch`,
    authState: `${b.api}/v2/plugin/auth/state?platform=CLI`,
    authToken: (state) => `${b.api}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
    authRefresh: `${b.api}/v2/plugin/auth/token/refresh`,
    accounts: `${b.api}/v2/plugin/accounts`,
    loginAccount: (state) => `${b.api}/v2/plugin/login/account?state=${encodeURIComponent(state)}`,
    login: (state) => `${b.web}/login?platform=CLI&state=${state}`,
  };
}

// 1. 客户端版本标识：严格对齐 package/package.json 官方最新 2.179.0
export const CURRENT_VERSION = '2.179.0';
export const USER_AGENT = `CLI/${CURRENT_VERSION} CodeBuddy/${CURRENT_VERSION}`;

// 2. 本地持久化文件绝对路径锁定 (基于当前模块物理位置，不受运行环境 cwd 漂移影响)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, '..');
export const CONFIG_PATH = path.resolve(ROOT_DIR, 'config.json');
export const ACCOUNTS_PATH = path.resolve(ROOT_DIR, 'accounts.json');
export const LOG_FILE_PATH = path.resolve(ROOT_DIR, 'gateway.log');

// 3. 向后兼容：默认区域（国内版）的常量
export const UPSTREAM_URL = REGION_BASE[REGION_CN].api + '/v2/chat/completions';
export const CONFIG_URL = REGION_BASE[REGION_CN].api + '/v3/config';
export const SUMMARY_URL = REGION_BASE[REGION_CN].api + '/billing/meter/get-user-resource-summary';
export const CHECKIN_URL = REGION_BASE[REGION_CN].web + '/v2/billing/meter/daily-checkin';
export const SEARCH_URL = REGION_BASE[REGION_CN].api + '/agenttool/v1/search';
export const WEBFETCH_URL = REGION_BASE[REGION_CN].api + '/agenttool/v1/webfetch';

// 3. 配置与账号加载 (含双重 .bak 备份自动容灾恢复)
function loadJsonWithBackup(mainPath, defaultValue) {
  if (fs.existsSync(mainPath)) {
    try {
      const raw = fs.readFileSync(mainPath, 'utf8');
      if (raw && raw.trim().length > 1) {
        return JSON.parse(raw);
      }
    } catch (_) {}
  }
  const bakPath = mainPath + '.bak';
  if (fs.existsSync(bakPath)) {
    try {
      const raw = fs.readFileSync(bakPath, 'utf8');
      if (raw && raw.trim().length > 1) {
        const data = JSON.parse(raw);
        fs.writeFileSync(mainPath, JSON.stringify(data, null, 2), 'utf8');
        return data;
      }
    } catch (_) {}
  }
  return defaultValue;
}

export let config = loadJsonWithBackup(CONFIG_PATH, {});
export let accounts = loadJsonWithBackup(ACCOUNTS_PATH, []);

export function saveAccounts() {
  const content = JSON.stringify(accounts, null, 2);
  fs.writeFileSync(ACCOUNTS_PATH, content, 'utf8');
  try { fs.writeFileSync(ACCOUNTS_PATH + '.bak', content, 'utf8'); } catch (_) {}
}

export function saveConfig() {
  const content = JSON.stringify(config, null, 2);
  fs.writeFileSync(CONFIG_PATH, content, 'utf8');
  try { fs.writeFileSync(CONFIG_PATH + '.bak', content, 'utf8'); } catch (_) {}
}

export function updateAccounts(newAccounts) {
  accounts = newAccounts;
  saveAccounts();
}

export function getTodayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getLocalTimeString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// ─── 统一账号展示标识工具函数 (强制附带备注，防止同昵称混淆) ───────────────
export function formatAccountLogName(acc) {
  if (!acc) return '未知账号';
  const name = acc.email || acc.uid || '未知账号';
  const note = (acc.note && typeof acc.note === 'string') ? acc.note.trim() : '';
  if (note) {
    return `${name} (备注: ${note})`;
  }
  return name;
}

export function formatAccountFullDesc(acc) {
  if (!acc) return '未知账号';
  const name = acc.email || acc.uid || '未知账号';
  const note = (acc.note && typeof acc.note === 'string') ? acc.note.trim() : '';
  const uid = acc.uid ? String(acc.uid) : '';
  const parts = [];
  if (note) parts.push(`备注: ${note}`);
  if (uid) parts.push(uid);
  if (parts.length > 0) {
    return `${name} (${parts.join(', ')})`;
  }
  return name;
}

// ─── 模型黑名单 ─────────────────────────────────────────────────────────────
// 命中黑名单的模型不会出现在 /v1/models 输出里（客户端根本看不到、也选不到），
// 同时 /v1/chat/completions 直接拒绝，避免客户端绕过列表用硬编码模型名调用。
//
// 匹配规则（任一命中即视为在黑名单）：
//   1. 精确匹配裸模型名      例: gpt-6-astra
//   2. 精确匹配带区域前缀名   例: intl:gpt-6-astra
//   3. 通配符 *              例: intl:* 屏蔽整个国际版；gpt-6-* 屏蔽整个系列
// 黑名单条目自身带区域前缀时只作用于该区域（intl:xxx 不影响 cn:xxx）。
export const MODEL_BLACKLIST_KEY = 'modelBlacklist';

/** 读取当前黑名单数组（容错：非数组视为空） */
export function getModelBlacklist() {
  const v = config[MODEL_BLACKLIST_KEY];
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x || '').trim()).filter(Boolean);
}

/** 写入黑名单（去重 + 去空 + 保持原始顺序） */
export function setModelBlacklist(list) {
  const arr = Array.isArray(list) ? list : [];
  const seen = new Set();
  const clean = [];
  for (const raw of arr) {
    const item = String(raw || '').trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    clean.push(item);
  }
  config[MODEL_BLACKLIST_KEY] = clean;
  return clean;
}

/**
 * 判断某个「带前缀的模型 ID」是否被黑名单屏蔽。
 * @param {string} prefixedId  如 cn:deepseek-v4.1-flash / intl:gpt-6-astra
 * @param {string} bareId      裸模型名，如 deepseek-v4.1-flash
 * @param {string} region      'cn' | 'intl'
 */
export function isModelBlacklisted(prefixedId, bareId, region) {
  const list = getModelBlacklist();
  if (list.length === 0) return false;

  const pid = String(prefixedId || '');
  const bare = String(bareId || '');
  const reg = String(region || '');

  for (const rule of list) {
    // 规则自身带区域前缀时，区域必须一致才生效
    const ruleHasRegion = rule.startsWith('cn:') || rule.startsWith('intl:');
    if (ruleHasRegion) {
      const ruleRegion = rule.slice(0, rule.indexOf(':'));
      if (ruleRegion !== reg) continue;
      if (matchModelPattern(rule, pid)) return true;
      // 也允许规则写成 intl:xxx 而调用方传的是裸名（保守不匹配，避免误伤另一区）
      continue;
    }
    // 规则不带前缀：只按裸模型名匹配，避免 cn:x 的规则误伤 intl:x
    if (matchModelPattern(rule, bare)) return true;
    // 兼容用户把带前缀的完整 ID 当裸名写进黑名单
    if (matchModelPattern(rule, pid)) return true;
  }
  return false;
}

/** 支持 * 通配符的模式匹配（大小写不敏感） */
function matchModelPattern(pattern, value) {
  const p = String(pattern || '');
  if (!p) return false;
  const v = String(value || '');
  if (!v) return false;
  if (!p.includes('*')) return p.toLowerCase() === v.toLowerCase();
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try {
    return new RegExp(`^${escaped}$`, 'i').test(v);
  } catch (_) {
    return false;
  }
}

/**
 * 判断一个「降级链步骤」是否已彻底不可用（用于把黑名单模型从轮换链里摘掉）。
 *
 * 与 isModelBlacklisted 的区别：
 *   · 步骤显式指定区域时，该区域被屏蔽即视为不可用；
 *   · 步骤未指定区域时，模型会按账号池自动路由到任一区域，
 *     因此必须「两个区域都被屏蔽」才算彻底不可用——只屏蔽一区时仍可作为备用。
 *
 * @param {string} bareId  裸模型名
 * @param {string|null} region  'cn' | 'intl' | null
 */
export function isStepUnavailableByBlacklist(bareId, region) {
  const bare = String(bareId || '').trim();
  if (!bare) return true;
  if (region) {
    const reg = String(region);
    return isModelBlacklisted(`${reg}:${bare}`, bare, reg);
  }
  const cnBlocked = isModelBlacklisted(`${REGION_CN}:${bare}`, bare, REGION_CN);
  const intlBlocked = isModelBlacklisted(`${REGION_INTL}:${bare}`, bare, REGION_INTL);
  return cnBlocked && intlBlocked;
}
