import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── 腾讯云 CodeBuddy 国内版专属端点 ─────────────────────────────────────────
export const UPSTREAM_URL = 'https://copilot.tencent.com/v2/chat/completions';
export const CONFIG_URL = 'https://copilot.tencent.com/v3/config';
export const SUMMARY_URL = 'https://copilot.tencent.com/billing/meter/get-user-resource-summary';
export const CHECKIN_URL = 'https://www.codebuddy.cn/v2/billing/meter/daily-checkin';
export const SEARCH_URL = 'https://copilot.tencent.com/agenttool/v1/search';
export const WEBFETCH_URL = 'https://copilot.tencent.com/agenttool/v1/webfetch';

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
