import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, getTodayString } from '../config.mjs';
import { rebuildRealStatsFromLog } from './log-parser.mjs';

export const STATS_PATH = path.resolve(ROOT_DIR, 'stats.json');

// 从本地真实运行日志 (gateway.log) 动态提取重构真实历史数据
function getInitialStats() {
  const fromLog = rebuildRealStatsFromLog();
  if (fromLog && fromLog.summary.totalRequests > 0) {
    return {
      ...fromLog,
      accounts: fromLog.accounts || {}
    };
  }

  const today = getTodayString();
  return {
    summary: {
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0
    },
    models: {},
    accounts: {},
    daily: {
      [today]: {
        requests: 0,
        successRequests: 0,
        failedRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      }
    }
  };
}

let statsData = null;

export function loadStats(forceReload = false) {
  if (statsData && !forceReload) return statsData;
  if (fs.existsSync(STATS_PATH) && !forceReload) {
    try {
      statsData = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
      // 如果现有文件缺少 accounts 字段，从日志重构补充
      if (!statsData.accounts || Object.keys(statsData.accounts).length === 0) {
        const fromLog = rebuildRealStatsFromLog();
        if (fromLog?.accounts) {
          statsData.accounts = fromLog.accounts;
          saveStatsSync();
        } else {
          statsData.accounts = {};
        }
      }
      // 如果现有文件包含之前的参考 mock 假数据 (220000000)，自动重置为真实数据
      if (statsData.summary?.totalTokens === 220000000 && statsData.summary?.totalRequests === 579) {
        statsData = getInitialStats();
        saveStatsSync();
      }
      return statsData;
    } catch (_) {}
  }
  statsData = getInitialStats();
  saveStatsSync();
  return statsData;
}

export function saveStatsSync() {
  try {
    fs.writeFileSync(STATS_PATH, JSON.stringify(statsData, null, 2), 'utf8');
  } catch (_) {}
}

let saveTimer = null;
export function saveStats() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStatsSync();
  }, 1000);
}

export function recordApiCall({ accountUid = null, accountName = null, model = 'unknown', isSuccess = true, inputTokens = 0, outputTokens = 0 }) {
  const stats = loadStats();
  const today = getTodayString();
  const totalTokens = (inputTokens || 0) + (outputTokens || 0);

  // 1. 更新总汇总
  stats.summary.totalRequests = (stats.summary.totalRequests || 0) + 1;
  if (isSuccess) {
    stats.summary.successRequests = (stats.summary.successRequests || 0) + 1;
  } else {
    stats.summary.failedRequests = (stats.summary.failedRequests || 0) + 1;
  }
  stats.summary.totalInputTokens = (stats.summary.totalInputTokens || 0) + inputTokens;
  stats.summary.totalOutputTokens = (stats.summary.totalOutputTokens || 0) + outputTokens;
  stats.summary.totalTokens = (stats.summary.totalTokens || 0) + totalTokens;

  // 2. 更新按模型统计
  if (!stats.models[model]) {
    stats.models[model] = {
      name: model,
      requests: 0,
      successRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    };
  }
  const m = stats.models[model];
  m.requests += 1;
  if (isSuccess) m.successRequests += 1;
  m.inputTokens += inputTokens;
  m.outputTokens += outputTokens;
  m.totalTokens += totalTokens;

  // 3. 更新按账号统计
  if (accountUid) {
    if (!stats.accounts) stats.accounts = {};
    if (!stats.accounts[accountUid]) {
      stats.accounts[accountUid] = {
        uid: accountUid,
        name: accountName || accountUid,
        requests: 0,
        successRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      };
    }
    const accStat = stats.accounts[accountUid];
    if (accountName) accStat.name = accountName;
    accStat.requests += 1;
    if (isSuccess) accStat.successRequests += 1;
    accStat.inputTokens += inputTokens;
    accStat.outputTokens += outputTokens;
    accStat.totalTokens += totalTokens;
  }

  // 4. 更新按日统计
  if (!stats.daily[today]) {
    stats.daily[today] = {
      requests: 0,
      successRequests: 0,
      failedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    };
  }
  const d = stats.daily[today];
  d.requests += 1;
  if (isSuccess) d.successRequests += 1;
  d.inputTokens += inputTokens;
  d.outputTokens += outputTokens;
  d.totalTokens += totalTokens;

  saveStats();
}

export function formatTokenNumber(num) {
  if (typeof num !== 'number') num = Number(num) || 0;
  if (num >= 100000000) {
    const val = (num / 100000000).toFixed(1).replace(/\.0$/, '');
    return `${val}亿`;
  }
  if (num >= 10000) {
    const val = (num / 10000).toFixed(1).replace(/\.0$/, '');
    return `${val}万`;
  }
  if (num >= 1000) {
    const val = (num / 1000).toFixed(1).replace(/\.0$/, '');
    return `${val}k`;
  }
  return num.toLocaleString('en-US');
}

export function getMetricsReport() {
  const stats = loadStats();
  const today = getTodayString();

  // 1. 总 Token
  const totalTokens = stats.summary.totalTokens || 0;
  const inputTokens = stats.summary.totalInputTokens || 0;
  const outputTokens = stats.summary.totalOutputTokens || 0;

  // 2. 成功请求数 & 成功率
  const totalRequests = stats.summary.totalRequests || 0;
  const successRequests = stats.summary.successRequests || 0;
  const successRate = totalRequests > 0
    ? ((successRequests / totalRequests) * 100).toFixed(1) + '%'
    : '100%';

  // 3. 今天请求数
  const todayStats = stats.daily[today] || { requests: 0 };
  const todayRequests = todayStats.requests || 0;

  // 4. 活跃天数 (每日有请求的天数)
  const dailyDates = Object.keys(stats.daily || {}).sort();
  const activeDays = dailyDates.filter(d => (stats.daily[d]?.requests || 0) > 0).length || (totalRequests > 0 ? 1 : 0);
  
  // 区间总天数
  let totalDaysRange = 1;
  if (dailyDates.length > 0) {
    const firstDate = new Date(dailyDates[0] + 'T00:00:00');
    const todayDate = new Date(today + 'T00:00:00');
    const diffTime = Math.abs(todayDate - firstDate);
    totalDaysRange = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1);
  }

  // 5. 当前连续天数 (含今天在内往前数)
  let consecutiveDays = 0;
  let cursor = new Date(today + 'T00:00:00');
  while (true) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const d = String(cursor.getDate()).padStart(2, '0');
    const dateKey = `${y}-${m}-${d}`;
    if (stats.daily && stats.daily[dateKey] && stats.daily[dateKey].requests > 0) {
      consecutiveDays++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }

  // 6. Top 模型
  let topModelId = '-';
  let topModelTokens = 0;
  if (stats.models && Object.keys(stats.models).length > 0) {
    for (const [id, m] of Object.entries(stats.models)) {
      if ((m.totalTokens || 0) >= topModelTokens) {
        topModelTokens = m.totalTokens;
        topModelId = id;
      }
    }
  }
  const topModelPercent = totalTokens > 0
    ? ((topModelTokens / totalTokens) * 100).toFixed(1) + '%'
    : '100%';

  // 7. 模型分布列表 (按 tokens 降序)
  const modelsList = Object.entries(stats.models || {})
    .map(([id, m]) => ({
      id,
      name: m.name || id,
      requests: m.requests || 0,
      successRequests: m.successRequests || 0,
      totalTokens: m.totalTokens || 0,
      totalTokensDisplay: formatTokenNumber(m.totalTokens || 0),
      percentage: totalTokens > 0 ? (((m.totalTokens || 0) / totalTokens) * 100).toFixed(1) + '%' : '100%',
      percentNum: totalTokens > 0 ? (((m.totalTokens || 0) / totalTokens) * 100).toFixed(1) : '100'
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  // 8. 每日趋势列表 (按日期降序)
  const dailyTrend = Object.entries(stats.daily || {})
    .map(([date, d]) => ({
      date,
      requests: d.requests || 0,
      successRequests: d.successRequests || 0,
      failedRequests: d.failedRequests || 0,
      inputTokens: d.inputTokens || 0,
      inputTokensDisplay: formatTokenNumber(d.inputTokens || 0),
      outputTokens: d.outputTokens || 0,
      outputTokensDisplay: formatTokenNumber(d.outputTokens || 0),
      totalTokens: d.totalTokens || 0,
      totalTokensDisplay: formatTokenNumber(d.totalTokens || 0)
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  // 9. 账号 Token 消耗分布列表 (按 tokens 降序)
  const accountsList = Object.entries(stats.accounts || {})
    .map(([uid, a]) => ({
      uid,
      name: a.name || uid,
      requests: a.requests || 0,
      successRequests: a.successRequests || 0,
      inputTokens: a.inputTokens || 0,
      inputTokensDisplay: formatTokenNumber(a.inputTokens || 0),
      outputTokens: a.outputTokens || 0,
      outputTokensDisplay: formatTokenNumber(a.outputTokens || 0),
      totalTokens: a.totalTokens || 0,
      totalTokensDisplay: formatTokenNumber(a.totalTokens || 0),
      percentage: totalTokens > 0 ? (((a.totalTokens || 0) / totalTokens) * 100).toFixed(1) + '%' : '0%',
      percentNum: totalTokens > 0 ? Number((((a.totalTokens || 0) / totalTokens) * 100).toFixed(1)) : 0
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    totalTokens,
    totalTokensDisplay: formatTokenNumber(totalTokens),
    inputTokens,
    inputTokensDisplay: formatTokenNumber(inputTokens),
    outputTokens,
    outputTokensDisplay: formatTokenNumber(outputTokens),
    
    totalRequests,
    successRequests,
    failedRequests: stats.summary.failedRequests || 0,
    successRate,
    
    todayRequests,
    activeDays,
    totalDaysRange,
    consecutiveDays,
    
    topModel: {
      id: topModelId,
      tokens: topModelTokens,
      tokensDisplay: formatTokenNumber(topModelTokens),
      percentage: topModelPercent
    },
    modelsList,
    accountsList,
    dailyTrend
  };
}
