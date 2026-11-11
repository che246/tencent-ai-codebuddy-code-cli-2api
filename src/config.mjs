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
export function endpointsFor(acc) {  const b = baseForAccount(acc);
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
    /**
     * 登录页 URL。
     *
     * 官方 CLI 实际打开的页面（实测）：
     *   https://www.codebuddy.cn/login/?platform=CLI&state=<uuid>&version=v2.179.0
     * 三个要点与网关原实现不同：
     *   1. 路径带尾斜杠：/login/ 而非 /login
     *   2. 带 version 参数，值为 v<CURRENT_VERSION>（注意前缀是 "v"）
     *   3. state 与 version 的顺序不敏感，但都必须在
     *
     * 注意：服务端 /v2/plugin/auth/state 下发的 authUrl 是
     *   cn:   https://copilot.tencent.com/login?platform=CLI&state=...
     *   intl: https://www.codebuddy.ai/login?platform=CLI&state=...
     * 即**不带**尾斜杠、**不带** version，且 host 是 api 域。
     * 这说明 CLI 打开页面前会做一次重写（换成 web 域 + 补 version + 补斜杠），
     * 网关按官方最终打开的形态拼接，与浏览器实际访问的 URL 一致。
     */
    login: (state) => `${b.web}/login/?platform=CLI&state=${encodeURIComponent(state)}&version=v${CURRENT_VERSION}`,
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

// ─── [网关自有策略] 全链路数据安全与独立备份目录 (backups/) ──────────────────
// 理由：
//   1. 避免根目录散落多份 .bak 文件，保持项目根目录清晰纯粹；
//   2. 集中化安全纳管凭据备份，便于运维统一备份或权限隔离（.gitignore 强制排除）；
//   3. 实施“原子写入（写 .tmp -> rename）+ 独立镜像备份”双重保险，
//      即使遇到系统掉电、进程强制终止或磁盘中断，主文件绝不会变成 0 字节半截损坏；
//   4. 容灾三级自愈：主文件 -> backups/ 目录备份 -> 根目录遗留 legacy 备份，并自动修复。
export const BACKUP_DIR = path.resolve(ROOT_DIR, 'backups');

/** 确保备份目录存在 */
export function ensureBackupDir() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
  } catch (_) {}
}

/** 获取指定持久化文件在 backups/ 目录中的备份文件绝对路径 */
export function getBackupPath(mainPath) {
  const filename = path.basename(mainPath);
  return path.resolve(BACKUP_DIR, filename + '.bak');
}

/**
 * 迁移根目录下遗留的旧版 .bak 文件到 backups/ 目录
 * 确保平滑向后兼容，且不留散落的冗余文件在项目根目录
 */
export function migrateLegacyBackups() {
  ensureBackupDir();
  try {
    const legacyNames = [
      'accounts.json.bak',
      'accounts.json.bak-credits',
      'config.json.bak',
      'stats.json.bak',
      'pricing.json.bak'
    ];
    for (const name of legacyNames) {
      const oldPath = path.resolve(ROOT_DIR, name);
      const newPath = path.resolve(BACKUP_DIR, name);
      if (fs.existsSync(oldPath)) {
        try {
          if (!fs.existsSync(newPath)) {
            fs.copyFileSync(oldPath, newPath);
          }
          fs.unlinkSync(oldPath);
        } catch (_) {}
      }
    }
  } catch (_) {}
}

// 模块初始化时执行一次遗留备份平滑归档迁移
migrateLegacyBackups();

/**
 * [网关自有策略] 全链路安全写入 JSON 数据文件与独立备份
 * @param {string} mainPath 主文件物理路径
 * @param {any} data 要持久化的数据对象或 JSON 字符串
 */
export function writeJsonWithBackup(mainPath, data) {
  try {
    ensureBackupDir();
    const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

    // 1. 原子写入主文件（先写临时文件再 rename，防止并发/强杀导致主文件截断清空）
    const tmpPath = `${mainPath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    try {
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, mainPath);
    } catch (_) {
      // 容错：若 rename 异常（跨盘符或被极端进程锁定时），退回直接写入
      fs.writeFileSync(mainPath, content, 'utf8');
    } finally {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
    }

    // 2. 独立镜像备份写入 backups/ 目录
    const bakPath = getBackupPath(mainPath);
    fs.writeFileSync(bakPath, content, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * [网关自有策略] 健壮的数据加载与三级容灾自愈
 * 优先级 1: 主文件 mainPath
 * 优先级 2: backups/ 目录下的独立备份文件 getBackupPath(mainPath)
 * 优先级 3: 根目录 legacy 备份文件 (mainPath + '.bak')
 * 无论从哪一级恢复，均会自动回写修复主文件，并保证 backups/ 目录有一份最新备份。
 */
export function loadJsonWithBackup(mainPath, defaultValue) {
  ensureBackupDir();
  const bakPath = getBackupPath(mainPath);
  const legacyBakPath = mainPath + '.bak';

  // 1. 尝试从主文件读取
  if (fs.existsSync(mainPath)) {
    try {
      const raw = fs.readFileSync(mainPath, 'utf8');
      if (raw && raw.trim().length > 1) {
        const parsed = JSON.parse(raw);
        // 主文件健康，顺便确保 backups/ 中有一份最新镜像备份
        try {
          if (!fs.existsSync(bakPath)) {
            fs.writeFileSync(bakPath, JSON.stringify(parsed, null, 2), 'utf8');
          }
        } catch (_) {}
        return parsed;
      }
    } catch (_) {}
  }

  // 2. 主文件损坏或不存在：优先从 backups/ 目录自动容灾恢复
  if (fs.existsSync(bakPath)) {
    try {
      const raw = fs.readFileSync(bakPath, 'utf8');
      if (raw && raw.trim().length > 1) {
        const data = JSON.parse(raw);
        try { fs.writeFileSync(mainPath, JSON.stringify(data, null, 2), 'utf8'); } catch (_) {}
        return data;
      }
    } catch (_) {}
  }

  // 3. 向后兼容：尝试从根目录下遗留的旧版 legacy 备份文件恢复，并自动纳管进 backups/
  if (fs.existsSync(legacyBakPath)) {
    try {
      const raw = fs.readFileSync(legacyBakPath, 'utf8');
      if (raw && raw.trim().length > 1) {
        const data = JSON.parse(raw);
        try {
          fs.writeFileSync(mainPath, JSON.stringify(data, null, 2), 'utf8');
          fs.writeFileSync(bakPath, JSON.stringify(data, null, 2), 'utf8');
          fs.unlinkSync(legacyBakPath);
        } catch (_) {}
        return data;
      }
    } catch (_) {}
  }

  return defaultValue;
}

export let config = loadJsonWithBackup(CONFIG_PATH, {});
export let accounts = loadJsonWithBackup(ACCOUNTS_PATH, []);

export function saveAccounts() {
  writeJsonWithBackup(ACCOUNTS_PATH, accounts);
}

export function saveConfig() {
  writeJsonWithBackup(CONFIG_PATH, config);
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

// ─── 思考档位策略 ───────────────────────────────────────────────────────────
// 网关级思考策略（默认关闭）：
//   enabled: 是否开启档位策略
//   defaultLevel: 默认网关档位 (minimal | low | medium | high | xhigh | max)
//   overrideMode:
//     - 'client_first': 客户端优先（客户端没传档位时才补「网关档位」）
//     - 'gateway_level_only': 网关优先 · 只覆盖档位（客户端传的档位一律改写为「网关档位」，但尊重客户端「关闭思考」）
//     - 'gateway_override_all': 网关优先 · 档位与开关一起覆盖（连客户端「关闭思考」也改写成开启 + 「网关档位」）
//   modelLevels: 逐模型独立覆盖目标档位（{ [modelId]: 'off' | 'minimal' | ... }）
export const VALID_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const VALID_OVERRIDE_MODES = ['client_first', 'gateway_level_only', 'gateway_override_all'];

export const DEFAULT_THINKING_POLICY = {
  enabled: false,
  defaultLevel: 'high',
  overrideMode: 'client_first',
  modelLevels: {}
};

export function getThinkingPolicy() {
  const p = config.thinkingPolicy;
  if (!p || typeof p !== 'object') {
    return { ...DEFAULT_THINKING_POLICY, modelLevels: {} };
  }
  return {
    enabled: Boolean(p.enabled),
    defaultLevel: VALID_THINKING_LEVELS.includes(p.defaultLevel) ? p.defaultLevel : 'high',
    overrideMode: VALID_OVERRIDE_MODES.includes(p.overrideMode) ? p.overrideMode : 'client_first',
    modelLevels: (p.modelLevels && typeof p.modelLevels === 'object') ? { ...p.modelLevels } : {}
  };
}

export function setThinkingPolicy(newPolicy) {
  if (!newPolicy || typeof newPolicy !== 'object') return getThinkingPolicy();
  const current = getThinkingPolicy();
  config.thinkingPolicy = {
    enabled: typeof newPolicy.enabled === 'boolean' ? newPolicy.enabled : current.enabled,
    defaultLevel: VALID_THINKING_LEVELS.includes(newPolicy.defaultLevel) ? newPolicy.defaultLevel : current.defaultLevel,
    overrideMode: VALID_OVERRIDE_MODES.includes(newPolicy.overrideMode) ? newPolicy.overrideMode : current.overrideMode,
    modelLevels: (newPolicy.modelLevels && typeof newPolicy.modelLevels === 'object') ? { ...newPolicy.modelLevels } : current.modelLevels
  };
  saveConfig();
  return config.thinkingPolicy;
}

export function setModelThinkingLevel(modelId, level) {
  if (!modelId || typeof modelId !== 'string') return getThinkingPolicy();
  const current = getThinkingPolicy();
  const modelLevels = { ...current.modelLevels };
  if (!level || level === 'default') {
    delete modelLevels[modelId];
  } else {
    modelLevels[modelId] = level;
  }
  config.thinkingPolicy = {
    ...current,
    modelLevels
  };
  saveConfig();
  return config.thinkingPolicy;
}

// ─── 系统提示词策略 (System Prompt Policy) ────────────────────────────────────
// [网关自有策略] 系统提示词重写引擎：
//   promptMode:
//     - 'passthrough': 透传客户端原始 system（默认）
//     - 'custom': 网关自有提示词（全量替换客户端 system/developer，规避上游指纹与定制人设）
//     - 'append': 客户端 system 后插网关提示词（并用）
//   promptFile: 提示词文件物理路径（如 D:\AI\dsh-purge\v1.1.40_prompt.txt）
//               留空则使用内置默认中性提示词
export const VALID_PROMPT_MODES = ['passthrough', 'custom', 'append'];
export const DEFAULT_PROMPT_TEXT = 'You are a helpful AI assistant.';

/**
 * 安全解析并读取系统提示词文件文本：
 * 1. 优先尝试直接读取 promptFile 指定路径
 * 2. 若跨系统部署（如 Windows 物理路径部署至 Linux 服务器），自动按文件名回落至项目根目录同名文件
 * 3. 文件不存在或读取异常时回落至内置默认中性提示词
 */
export function loadSystemPromptContent(filePath) {
  if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
    return DEFAULT_PROMPT_TEXT;
  }
  const target = filePath.trim();
  if (fs.existsSync(target)) {
    try {
      const content = fs.readFileSync(target, 'utf8');
      if (content && content.trim()) return content;
    } catch (_) {}
  }
  // 跨操作系统路径容灾回落：提取 basename 到项目根目录查找
  const fallback = path.resolve(ROOT_DIR, path.basename(target));
  if (fs.existsSync(fallback)) {
    try {
      const content = fs.readFileSync(fallback, 'utf8');
      if (content && content.trim()) return content;
    } catch (_) {}
  }
  return DEFAULT_PROMPT_TEXT;
}

export function getPromptPolicy() {
  const mode = config.promptMode;
  const file = config.promptFile;
  return {
    mode: VALID_PROMPT_MODES.includes(mode) ? mode : 'passthrough',
    file: typeof file === 'string' ? file.trim() : ''
  };
}

export function setPromptPolicy({ mode, file } = {}) {
  if (mode !== undefined && VALID_PROMPT_MODES.includes(mode)) {
    config.promptMode = mode;
  }
  if (file !== undefined && typeof file === 'string') {
    config.promptFile = file.trim();
  }
  saveConfig();
  return getPromptPolicy();
}


