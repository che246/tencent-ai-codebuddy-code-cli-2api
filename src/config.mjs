import fs from 'node:fs';
import path from 'node:path';

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

// 2. 本地持久化文件路径定义
export const ROOT_DIR = process.cwd();
export const CONFIG_PATH = path.resolve(ROOT_DIR, 'config.json');
export const ACCOUNTS_PATH = path.resolve(ROOT_DIR, 'accounts.json');
export const LOG_FILE_PATH = path.resolve(ROOT_DIR, 'gateway.log');

// 3. 配置与账号加载
export let config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
export let accounts = fs.existsSync(ACCOUNTS_PATH) ? JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8')) : [];

export function saveAccounts() {
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2), 'utf8');
}

export function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
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
