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

  // 1. 尝试从现有持久化文件 stats.json 读取
  if (fs.existsSync(STATS_PATH)) {
    try {
      const raw = fs.readFileSync(STATS_PATH, 'utf8');
      if (raw && raw.trim().length > 5) {
        const parsed = JSON.parse(raw);
        if (parsed.summary && typeof parsed.summary.totalRequests === 'number') {
          statsData = parsed;
          if (!statsData.models) statsData.models = {};
          if (!statsData.accounts) statsData.accounts = {};
          if (!statsData.daily) statsData.daily = {};
          return statsData;
        }
      }
    } catch (_) {}
  }

  // 2. 尝试从容灾备份 stats.json.bak 自动恢复
  const bakPath = STATS_PATH + '.bak';
  if (fs.existsSync(bakPath)) {
    try {
      const rawBak = fs.readFileSync(bakPath, 'utf8');
      if (rawBak && rawBak.trim().length > 5) {
        const parsedBak = JSON.parse(rawBak);
        if (parsedBak.summary && typeof parsedBak.summary.totalRequests === 'number') {
          statsData = parsedBak;
          if (!statsData.models) statsData.models = {};
          if (!statsData.accounts) statsData.accounts = {};
          if (!statsData.daily) statsData.daily = {};
          saveStatsSync();
          return statsData;
        }
      }
    } catch (_) {}
  }

  // 3. 仅当文件完全不存在且无备份时，首次从日志动态重构初始化
  statsData = getInitialStats();
  saveStatsSync();
  return statsData;
}

export function saveStatsSync() {
  if (!statsData) return;
  try {
    const content = JSON.stringify(statsData, null, 2);
    fs.writeFileSync(STATS_PATH, content, 'utf8');
    try { fs.writeFileSync(STATS_PATH + '.bak', content, 'utf8'); } catch (_) {}
  } catch (_) {}
}

export function saveStats() {
  saveStatsSync();
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
      totalTokens: 0,
      models: {},
      accounts: {}
    };
  }
  const d = stats.daily[today];
  d.requests += 1;
  if (isSuccess) d.successRequests += 1;
  d.inputTokens += inputTokens;
  d.outputTokens += outputTokens;
  d.totalTokens += totalTokens;

  if (!d.models) d.models = {};
  if (!d.models[model]) {
    d.models[model] = { name: model, requests: 0, successRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  d.models[model].requests += 1;
  if (isSuccess) d.models[model].successRequests += 1;
  d.models[model].inputTokens += inputTokens;
  d.models[model].outputTokens += outputTokens;
  d.models[model].totalTokens += totalTokens;

  if (accountUid) {
    if (!d.accounts) d.accounts = {};
    if (!d.accounts[accountUid]) {
      d.accounts[accountUid] = { uid: accountUid, name: accountName || accountUid, requests: 0, successRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    }
    d.accounts[accountUid].requests += 1;
    if (isSuccess) d.accounts[accountUid].successRequests += 1;
    d.accounts[accountUid].inputTokens += inputTokens;
    d.accounts[accountUid].outputTokens += outputTokens;
    d.accounts[accountUid].totalTokens += totalTokens;
  }

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

export function getShiftedDateString(baseDateStr, daysShift) {
  const [y, m, d] = baseDateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + daysShift);
  const ry = dt.getFullYear();
  const rm = String(dt.getMonth() + 1).padStart(2, '0');
  const rd = String(dt.getDate()).padStart(2, '0');
  return `${ry}-${rm}-${rd}`;
}

export function getMetricsReport(range = 'all') {
  const stats = loadStats();
  const today = getTodayString();
  const yesterday = getShiftedDateString(today, -1);
  const validRanges = ['today', 'yesterday', '7d', '30d', 'all'];
  if (!validRanges.includes(range)) range = 'all';

  let targetDates = null;
  let totalDaysRange = 1;
  let rangeLabel = '全部';

  if (range === 'today') {
    targetDates = [today];
    totalDaysRange = 1;
    rangeLabel = '今天';
  } else if (range === 'yesterday') {
    targetDates = [yesterday];
    totalDaysRange = 1;
    rangeLabel = '昨天';
  } else if (range === '7d') {
    targetDates = [];
    for (let i = 0; i < 7; i++) targetDates.push(getShiftedDateString(today, -i));
    totalDaysRange = 7;
    rangeLabel = '7天';
  } else if (range === '30d') {
    targetDates = [];
    for (let i = 0; i < 30; i++) targetDates.push(getShiftedDateString(today, -i));
    totalDaysRange = 30;
    rangeLabel = '30天';
  } else {
    // all
    targetDates = Object.keys(stats.daily || {});
    rangeLabel = '全部';
    const sortedDates = [...targetDates].sort();
    if (sortedDates.length > 0) {
      const firstDate = new Date(sortedDates[0] + 'T00:00:00');
      const todayDate = new Date(today + 'T00:00:00');
      const diffTime = Math.abs(todayDate - firstDate);
      totalDaysRange = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1);
    }
  }

  // 连续活跃天数 (含今天在内往前数)
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

  let totalTokens = 0, inputTokens = 0, outputTokens = 0;
  let totalRequests = 0, successRequests = 0, failedRequests = 0;
  let activeDays = 0;
  const modelsMap = {};
  const accountsMap = {};
  const dailyRows = {};

  for (const date of targetDates) {
    const d = stats.daily[date];
    if (d) {
      if (d.requests > 0) activeDays++;
      totalRequests += (d.requests || 0);
      successRequests += (d.successRequests || 0);
      failedRequests += (d.failedRequests || 0);
      inputTokens += (d.inputTokens || 0);
      outputTokens += (d.outputTokens || 0);
      totalTokens += (d.totalTokens || 0);

      dailyRows[date] = d;

      for (const [mName, mObj] of Object.entries(d.models || {})) {
        if (!modelsMap[mName]) {
          modelsMap[mName] = { name: mName, requests: 0, successRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        }
        modelsMap[mName].requests += (mObj.requests || 0);
        modelsMap[mName].successRequests += (mObj.successRequests || 0);
        modelsMap[mName].inputTokens += (mObj.inputTokens || 0);
        modelsMap[mName].outputTokens += (mObj.outputTokens || 0);
        modelsMap[mName].totalTokens += (mObj.totalTokens || 0);
      }

      for (const [accId, accObj] of Object.entries(d.accounts || {})) {
        if (!accountsMap[accId]) {
          accountsMap[accId] = { uid: accId, name: accObj.name || accId, requests: 0, successRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        }
        accountsMap[accId].requests += (accObj.requests || 0);
        accountsMap[accId].successRequests += (accObj.successRequests || 0);
        accountsMap[accId].inputTokens += (accObj.inputTokens || 0);
        accountsMap[accId].outputTokens += (accObj.outputTokens || 0);
        accountsMap[accId].totalTokens += (accObj.totalTokens || 0);
      }
    }
  }

  // 兜底：如果 range === 'all' 且 daily 没有 models/accounts 细分，使用根对象
  if (range === 'all') {
    if (Object.keys(modelsMap).length === 0 && stats.models) {
      Object.assign(modelsMap, stats.models);
    }
    if (Object.keys(accountsMap).length === 0 && stats.accounts) {
      Object.assign(accountsMap, stats.accounts);
    }
  }

  // 成功率
  const successRate = totalRequests > 0
    ? ((successRequests / totalRequests) * 100).toFixed(1) + '%'
    : '100%';

  // 今天请求数 (用于指标卡片中附注)
  const todayStats = stats.daily[today] || { requests: 0 };
  const todayRequests = todayStats.requests || 0;

  // Top 模型
  let topModelId = '-';
  let topModelTokens = 0;
  for (const [id, m] of Object.entries(modelsMap)) {
    if ((m.totalTokens || 0) >= topModelTokens) {
      topModelTokens = m.totalTokens;
      topModelId = id;
    }
  }
  const topModelPercent = totalTokens > 0
    ? ((topModelTokens / totalTokens) * 100).toFixed(1) + '%'
    : '100%';

  // 模型排行列表
  const modelsList = Object.entries(modelsMap)
    .map(([id, m]) => ({
      id,
      name: m.name || id,
      requests: m.requests || 0,
      successRequests: m.successRequests || 0,
      totalTokens: m.totalTokens || 0,
      totalTokensDisplay: formatTokenNumber(m.totalTokens || 0),
      percentage: totalTokens > 0 ? (((m.totalTokens || 0) / totalTokens) * 100).toFixed(1) + '%' : '100%',
      percentNum: totalTokens > 0 ? Number((((m.totalTokens || 0) / totalTokens) * 100).toFixed(1)) : 0
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  // 账号排行列表
  const accountsList = Object.entries(accountsMap)
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

  // 每日全量历史趋势流水列表 (全部显示所有历史天数记录，不受上方区间切片影响)
  const allDailyEntries = Object.entries(stats.daily || {});
  const dailyTrend = allDailyEntries
    .filter(([_, d]) => d && ((d.requests || 0) > 0 || (d.totalTokens || 0) > 0))
    .map(([date, d]) => {
      let topModelForDay = '-';
      const modelsEntries = Object.entries(d.models || {});
      if (modelsEntries.length > 0) {
        modelsEntries.sort((a, b) => (b[1].totalTokens || 0) - (a[1].totalTokens || 0));
        topModelForDay = modelsEntries[0][0];
      }
      const successRate = d.requests > 0
        ? (((d.successRequests || 0) / d.requests) * 100).toFixed(1) + '%'
        : '100%';

      return {
        date,
        isToday: date === today,
        isYesterday: date === yesterday,
        isInRange: targetDates.includes(date),
        requests: d.requests || 0,
        successRequests: d.successRequests || 0,
        failedRequests: d.failedRequests || 0,
        successRate,
        topModel: topModelForDay,
        inputTokens: d.inputTokens || 0,
        inputTokensDisplay: formatTokenNumber(d.inputTokens || 0),
        outputTokens: d.outputTokens || 0,
        outputTokensDisplay: formatTokenNumber(d.outputTokens || 0),
        totalTokens: d.totalTokens || 0,
        totalTokensDisplay: formatTokenNumber(d.totalTokens || 0)
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    range,
    rangeLabel,
    totalTokens,
    totalTokensDisplay: formatTokenNumber(totalTokens),
    inputTokens,
    inputTokensDisplay: formatTokenNumber(inputTokens),
    outputTokens,
    outputTokensDisplay: formatTokenNumber(outputTokens),

    totalRequests,
    successRequests,
    failedRequests,
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
