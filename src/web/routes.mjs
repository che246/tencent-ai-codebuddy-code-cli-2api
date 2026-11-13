import fs from 'node:fs';
import path from 'node:path';
import {
  config,
  accounts,
  saveAccounts,
  saveConfig,
  getTodayString,
  LOG_FILE_PATH,
  USER_AGENT,
  CURRENT_VERSION,
  ROOT_DIR,
  formatAccountFullDesc,
  endpointsFor,
  normalizeRegion,
  REGION_BASE,
  getModelBlacklist,
  setModelBlacklist,
  isModelBlacklisted,
  getThinkingPolicy,
  setThinkingPolicy,
  setModelThinkingLevel,
  getPromptPolicy,
  setPromptPolicy
} from '../config.mjs';
import { Logger } from '../core/logger.mjs';
import { LogDatabase } from '../core/database.mjs';
import { AccountScheduler } from '../core/scheduler.mjs';
import { TlsCertificateStack } from '../core/tls-certs.mjs';
import { fetchDetailedModels } from '../upstream/models.mjs';
import { getMetricsReport, loadStats, formatTokenNumber, pruneStatsByTime } from '../core/metrics.mjs';
import { loadModelPrices, saveModelPrices, searchOfficialPricingOnline } from '../core/pricing.mjs';

const HTML_FILE_PATH = path.resolve(ROOT_DIR, 'src/web/public/index.html');

// ─── Web 控制台鉴权校验工具函数 ─────────────────────────────────────────────
export function getWebAuthPassword() {
  if (config.webPassword && typeof config.webPassword === 'string' && config.webPassword.trim()) {
    return config.webPassword.trim();
  }
  return (config.apiKey && typeof config.apiKey === 'string') ? config.apiKey.trim() : '';
}

export function verifyWebAuthToken(token) {
  if (config.webAuthEnabled === false) return true;
  const expected = getWebAuthPassword();
  if (!expected) return true;
  if (!token || typeof token !== 'string') return false;
  return token.trim() === expected;
}

// ─── Web 控制台静态页渲染 ───────────────────────────────────────────────────
export function handleDashboard(req, res) {
  try {
    let html = fs.readFileSync(HTML_FILE_PATH, 'utf8');
    const isAuthEnabled = config.webAuthEnabled !== false;
    html = html
      .replace(/{{PORT}}/g, String(config.port || 8317))
      .replace(/{{API_KEY}}/g, isAuthEnabled ? 'sk-****************' : String(config.apiKey || ''))
      .replace(/{{VERSION}}/g, CURRENT_VERSION)
      .replace(/{{CA_COUNT}}/g, String(TlsCertificateStack.loadedCount))
      .replace(/{{WEB_AUTH_ENABLED}}/g, String(isAuthEnabled));

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    return res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`Failed to load Web UI template: ${err.message}`);
  }
}

// ─── /api/* 运维与管理 API 路由 ─────────────────────────────────────────────
export async function handleApiRoutes(req, res, url) {
  const today = getTodayString();

  // A. Web 控制台登录验证接口 (公开)
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      try {
        const body = JSON.parse(b);
        const inputPass = (body.password || body.token || '').trim();
        const expected = getWebAuthPassword();
        if (config.webAuthEnabled === false || (expected && inputPass === expected)) {
          Logger.info('AUTH', `Web 控制台授权成功通过 (IP: ${req.socket.remoteAddress})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            ok: true,
            token: expected,
            webAuthEnabled: config.webAuthEnabled !== false
          }));
        } else {
          Logger.warn('AUTH', `Web 控制台授权凭据错误 (IP: ${req.socket.remoteAddress})`);
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: '控制台密码或 API Key 不正确，请重新输入' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // B. Web 控制台授权状态查询接口 (公开)
  if (url.pathname === '/api/auth/status' && req.method === 'GET') {
    const authHeader = req.headers['authorization'] || '';
    let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.headers['x-web-token'] || '');
    if (!token && url.searchParams.get('token')) {
      token = url.searchParams.get('token').trim();
    }
    const isAuth = verifyWebAuthToken(token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      webAuthEnabled: config.webAuthEnabled !== false,
      authenticated: isAuth
    }));
  }

  // ─── Web 控制台 API 安全守卫拦截 ─────────────────────────────────────────
  if (config.webAuthEnabled !== false) {
    const authHeader = req.headers['authorization'] || '';
    let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.headers['x-web-token'] || '');
    if (!token && url.searchParams.get('token')) {
      token = url.searchParams.get('token').trim();
    }
    if (!verifyWebAuthToken(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'Unauthorized: Web console authentication required',
        code: 'UNAUTHORIZED'
      }));
    }
  }

  // 0. 报表统计概览接口 (支持 ?range=today|yesterday|7d|30d|all)
  if (url.pathname === '/api/metrics' && req.method === 'GET') {
    const range = url.searchParams.get('range') || 'all';
    const report = getMetricsReport(range);
    report.currentAccount = AccountScheduler.getCurrentActiveAccountInfo();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(report));
  }

  // 1. 策略设置读取接口
  if (url.pathname === '/api/settings' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      port: config.port,
      apiKey: config.apiKey,
      webAuthEnabled: config.webAuthEnabled !== false,
      webPassword: config.webPassword || '',
      concurrencyLimitEnabled: config.concurrencyLimitEnabled !== false,
      maxInFlightPerAccount: config.maxInFlightPerAccount || 3,
      routingStrategy: config.routingStrategy || 'least-inflight',
      accountFailoverEnabled: config.accountFailoverEnabled !== false,
      pinnedAccount: config.pinnedAccount || '',
      modelFallbackEnabled: config.modelFallbackEnabled !== false,
      modelFallback: config.modelFallback || {},
      tokenRefreshAdvanceDays: config.tokenRefreshAdvanceDays || 7,
      maxLogDbSizeMb: config.maxLogDbSizeMb || 30,
      logDbSizeMb: LogDatabase.getSizeMb(),
      autoCheckin: Boolean(config.autoCheckin),
      modelBlacklist: getModelBlacklist(),
      thinkingPolicy: getThinkingPolicy(),
      promptPolicy: getPromptPolicy(),
      rootDir: ROOT_DIR
    }));
  }

  // 2. 策略设置更新接口 (热更新生效并落盘)
  if (url.pathname === '/api/settings' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      try {
        const body = JSON.parse(b);
        if (body.thinkingPolicy && typeof body.thinkingPolicy === 'object') {
          setThinkingPolicy(body.thinkingPolicy);
        }
        if (body.promptPolicy && typeof body.promptPolicy === 'object') {
          setPromptPolicy(body.promptPolicy);
        } else if (body.promptMode !== undefined || body.promptFile !== undefined) {
          setPromptPolicy({ mode: body.promptMode, file: body.promptFile });
        }
        if (typeof body.concurrencyLimitEnabled === 'boolean') {
          config.concurrencyLimitEnabled = body.concurrencyLimitEnabled;
        }
        if (typeof body.accountFailoverEnabled === 'boolean') {
          config.accountFailoverEnabled = body.accountFailoverEnabled;
        }
        if (typeof body.webAuthEnabled === 'boolean') {
          config.webAuthEnabled = body.webAuthEnabled;
        }
        if (typeof body.webPassword === 'string') {
          config.webPassword = body.webPassword.trim();
        }
        if (typeof body.routingStrategy === 'string') {
          config.routingStrategy = body.routingStrategy;
        }
        if (typeof body.pinnedAccount === 'string') {
          config.pinnedAccount = body.pinnedAccount.trim();
        }
        if (typeof body.modelFallbackEnabled === 'boolean') {
          config.modelFallbackEnabled = body.modelFallbackEnabled;
        }
        if (body.modelFallback && typeof body.modelFallback === 'object') {
          config.modelFallback = body.modelFallback;
        }
        if (typeof body.tokenRefreshAdvanceDays === 'number') {
          config.tokenRefreshAdvanceDays = Math.max(1, Math.min(30, body.tokenRefreshAdvanceDays));
        }
        if (typeof body.maxLogDbSizeMb === 'number') {
          config.maxLogDbSizeMb = Math.max(1, body.maxLogDbSizeMb);
          LogDatabase.checkAndPruneBySize(config.maxLogDbSizeMb);
        }
        if (typeof body.maxInFlightPerAccount === 'number') {
          config.maxInFlightPerAccount = Math.max(1, body.maxInFlightPerAccount);
        }
        saveConfig();
        Logger.info('CONFIG', `网关运行策略已更新 (热生效)`, {
          promptPolicy: getPromptPolicy(),
          webAuthEnabled: config.webAuthEnabled,
          concurrencyLimitEnabled: config.concurrencyLimitEnabled,
          accountFailoverEnabled: config.accountFailoverEnabled,
          routingStrategy: config.routingStrategy,
          pinnedAccount: config.pinnedAccount,
          modelFallbackEnabled: config.modelFallbackEnabled,
          modelFallback: config.modelFallback,
          tokenRefreshAdvanceDays: config.tokenRefreshAdvanceDays,
          maxLogDbSizeMb: config.maxLogDbSizeMb,
          maxInFlightPerAccount: config.maxInFlightPerAccount
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, config, promptPolicy: getPromptPolicy(), logDbSizeMb: LogDatabase.getSizeMb() }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 3. 日志查询接口 (支持 SQLite 数据库按日期、日志级别、分类、关键词检索，默认单天最新 200 条)
  if (url.pathname === '/api/logs' && req.method === 'GET') {
    const date = url.searchParams.get('date') || null;
    const level = url.searchParams.get('level') || null;
    const category = url.searchParams.get('category') || null;
    const search = url.searchParams.get('search') || null;
    const limit = parseInt(url.searchParams.get('limit') || '200', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const result = Logger.getLogs({ date, level, category, search, limit, offset });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  // 3.5. 日志可用历史日期列表接口 (供前端按日期筛选)
  if (url.pathname === '/api/logs/dates' && req.method === 'GET') {
    const dates = Logger.getDates();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ dates }));
  }

  // 3.6. 手动触发根据 MB 阈值裁剪日志数据库
  if (url.pathname === '/api/logs/prune-size' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      let reqMb = null;
      try {
        const body = JSON.parse(b || '{}');
        if (typeof body.maxSizeMb === 'number') reqMb = body.maxSizeMb;
      } catch (_) {}
      const pruneRes = LogDatabase.checkAndPruneBySize(reqMb);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(pruneRes));
    });
    return;
  }

  // 4. 日志全量/单天下单导出
  if (url.pathname === '/api/logs/export' && req.method === 'GET') {
    const exportDate = url.searchParams.get('date');
    if (exportDate && exportDate !== 'ALL') {
      const resLogs = LogDatabase.queryLogs({ date: exportDate, limit: 10000 });
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="gateway-${exportDate}.log"`
      });
      const lines = (resLogs.logs || []).map(l => `[${l.time}] [${l.level.padEnd(5)}] [${l.category}] ${l.message}${l.meta ? ' | ' + JSON.stringify(l.meta) : ''}`);
      return res.end(lines.join('\n') + '\n');
    }
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

  // 5. 清空内存日志
  if (url.pathname === '/api/logs/clear' && req.method === 'POST') {
    Logger.clear();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // 5.5. 官网模型定价查询与配置接口
  if (url.pathname === '/api/pricing' && req.method === 'GET') {
    const prices = loadModelPrices();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, prices }));
  }

  // 5.6. 基于网关联网检索功能在线检索最新官网价格
  if (url.pathname === '/api/pricing/search' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', async () => {
      try {
        const body = JSON.parse(b || '{}');
        const q = body.query || '大模型 API 官方价格';
        const searchReport = await searchOfficialPricingOnline(q);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...searchReport }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 5.7. 自定义更新模型定价标准
  if (url.pathname === '/api/pricing/update' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      try {
        const body = JSON.parse(b || '{}');
        const updated = saveModelPrices(body.prices || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, prices: updated }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 6. 账号列表查询 (包含模型锁池状态、锁定剩余时间及原因)
  //    支持 ?refresh=1 强制刷新积分（忽略最小间隔）；
  //    默认行为：若某账号积分已超过 30s 未刷新则顺带拉一次上游，
  //    这样用户切到账号页看到的就是较新数据，不必等 5 分钟定时任务。
  if (url.pathname === '/api/accounts' && req.method === 'GET') {
    const forceRefresh = url.searchParams.get('refresh') === '1';
    const staleDisabled = url.searchParams.get('stale') === '0';
    if (forceRefresh || !staleDisabled) {
      try {
        await AccountScheduler.refreshStaleCredits(forceRefresh ? 0 : 30000, { force: forceRefresh });
      } catch (_) { /* 刷新失败不影响列表返回 */ }
    }

    const stats = loadStats();
    const accStatsMap = stats.accounts || {};
    const advanceDays = (typeof config.tokenRefreshAdvanceDays === 'number' && config.tokenRefreshAdvanceDays > 0) ? config.tokenRefreshAdvanceDays : 7;
    const advanceMs = advanceDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(accounts.map(a => {
      const accStats = accStatsMap[a.uid] || accStatsMap[a.email] || {};
      const tokens = accStats.totalTokens || 0;
      const daysRemaining = a.expiresAt ? Math.max(0, Number(((a.expiresAt - now) / (24 * 3600 * 1000)).toFixed(1))) : null;
      const canAutoRefresh = Boolean(a.refreshToken);
      const isRefreshEligible = canAutoRefresh && (!a.expiresAt || now > (a.expiresAt - advanceMs));

      // 提取该账号当前所有活跃被锁的模型、剩余解锁秒数与限流原因
      const activeLockedModels = [];
      if (a.modelCooldowns) {
        for (const [mId, expireAt] of Object.entries(a.modelCooldowns)) {
          if (now < expireAt) {
            const remainingSec = Math.ceil((expireAt - now) / 1000);
            const reason = a.modelCooldownReasons?.[mId] || '上游限频退避';
            activeLockedModels.push({
              modelId: mId,
              remainingSec,
              expireAt,
              reason
            });
          } else {
            delete a.modelCooldowns[mId];
            if (a.modelCooldownReasons) delete a.modelCooldownReasons[mId];
          }
        }
      }

      const isGlobalCooldown = now < (a.cooldownUntil || 0);
      const globalCooldownRemainingSec = isGlobalCooldown ? Math.ceil((a.cooldownUntil - now) / 1000) : 0;

      return {
        uid: a.uid,
        email: a.email,
        note: a.note || '',
        // 所属区域：前后端都用它决定上游 base 域名
        region: normalizeRegion(a.region),
        creditsRemain: a.creditsRemain,
        // 积分最后一次成功从上游刷新的时间戳（毫秒），前端据此展示「X 前刷新」，
        // 并在超过阈值时主动带 ?refresh=1 重新拉取。
        creditsUpdatedAt: a.creditsUpdatedAt || 0,
        totalTokens: tokens,
        totalTokensDisplay: formatTokenNumber(tokens),
        inputTokens: accStats.inputTokens || 0,
        outputTokens: accStats.outputTokens || 0,
        requests: accStats.requests || 0,
        inFlight: a.inFlight || 0,
        status: a.status,
        expiresAt: a.expiresAt || 0,
        expiresAtFmt: a.expiresAt ? new Date(a.expiresAt).toLocaleDateString() : '未知',
        hasRefreshToken: canAutoRefresh,
        daysRemaining,
        advanceDays,
        isRefreshEligible,
        isCooldown: isGlobalCooldown,
        cooldownRemainingSec: globalCooldownRemainingSec,
        lockedModels: activeLockedModels,
        lockedCount: activeLockedModels.length,
        isCheckedInToday: a.lastCheckinDate === today && (a.lastCheckinSuccess || a.lastCheckinMsg?.includes('已签到') || a.lastCheckinMsg?.includes('成功')),
        lastCheckinMsg: (a.lastCheckinDate === today && (a.lastCheckinSuccess || a.lastCheckinMsg?.includes('已签到') || a.lastCheckinMsg?.includes('成功'))) ? (a.lastCheckinMsg || '今天已签到') : '今日未签到'
      };
    })));
  }

  // 6.5. 官方 plans-usage 积分构成明细查询接口
  if (url.pathname === '/api/accounts/credit-details' && req.method === 'GET') {
    const uid = url.searchParams.get('uid');
    const acc = uid ? accounts.find(a => a.uid === uid) : (accounts.find(a => a.status === 'healthy') || accounts[0]);
    if (!acc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Account not found' }));
    }
    const details = await AccountScheduler.getAccountCreditDetails(acc);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      uid: acc.uid,
      email: acc.email,
      note: acc.note || '',
      // 区域：前端据此生成对应版本的官方 plans-usage 链接
      //   国内版 → https://www.codebuddy.cn/profile/plans-usage
      //   国际版 → https://www.codebuddy.ai/profile/plans-usage
      region: normalizeRegion(acc.region),
      ...details
    }));
  }

  // 6.6. 账号积分消耗明细流水（按账号维度，对应官方 plans-usage 页面「积分消耗明细」）
  // 上游接口：POST /billing/meter/get-user-request-usage
  //   参数 { startTime, endTime, pageNum, pageSize }
  //   返回 { total, data: [{ requestId, credit, model, client, requestTime, input, ... }] }
  if (url.pathname === '/api/accounts/usage-records' && req.method === 'GET') {
    const uid = url.searchParams.get('uid');
    if (!uid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: '缺少 uid 参数' }));
    }
    const acc = accounts.find(a => a.uid === uid);
    if (!acc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: '账号不存在' }));
    }

    const days = parseInt(url.searchParams.get('days') || '7', 10);
    const pageNum = parseInt(url.searchParams.get('page') || '1', 10);
    const pageSize = parseInt(url.searchParams.get('pageSize') || '20', 10);

    const result = await AccountScheduler.getAccountUsageRecords(acc, { days, pageNum, pageSize });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ...result,
      uid: acc.uid,
      email: acc.email,
      note: acc.note || '',
      region: normalizeRegion(acc.region),
    }));
  }

  // ─── [网关自有策略] 6.7. 积分监控与历史变动留痕接口 ───────────────────────
  // GET /api/credits/history?limit=100&offset=0&refresh=1&uid=xxx
  if (url.pathname === '/api/credits/history' && req.method === 'GET') {
    const shouldRefresh = url.searchParams.get('refresh') === '1';
    if (shouldRefresh) {
      try {
        await AccountScheduler.refreshStaleCredits(0, { force: true });
      } catch (_) {}
    }
    const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
    const uid = url.searchParams.get('uid') || null;
    const historyData = LogDatabase.queryCreditHistory({ accountUid: uid, limit, offset });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, total: historyData.total, records: historyData.records }));
  }

  // POST /api/credits/history/clear 清空变动历史记录
  if (url.pathname === '/api/credits/history/clear' && req.method === 'POST') {
    LogDatabase.clearCreditHistory();
    Logger.info('CREDIT_MONITOR', '管理员已清空积分历史变动记录');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // 7. 模型全量看板数据
  if (url.pathname === '/api/models-detail' && req.method === 'GET') {
    const force = url.searchParams.get('refresh') === '1';
    const detailedModels = await fetchDetailedModels(force);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(detailedModels));
  }

  // 7.1 模型黑名单：读取（附带命中预览，便于确认规则生效范围）
  if (url.pathname === '/api/models/blacklist' && req.method === 'GET') {
    const list = getModelBlacklist();
    // 预览：对当前模型矩阵逐条判定，给出每个区域的命中结果
    let preview = [];
    try {
      const detailed = await fetchDetailedModels();
      for (const m of detailed) {
        const regions = Array.isArray(m.regions) && m.regions.length ? m.regions : ['cn'];
        for (const r of regions) {
          const prefixed = `${r === 'intl' ? 'intl:' : 'cn:'}${m.id}`;
          if (isModelBlacklisted(prefixed, m.id, r)) {
            preview.push({ id: prefixed, bare: m.id, region: r });
          }
        }
      }
    } catch (_) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ blacklist: list, blockedPreview: preview, blockedCount: preview.length }));
  }

  // 7.2 模型黑名单：保存（整体替换，热生效并落盘）
  if (url.pathname === '/api/models/blacklist' && req.method === 'POST') {
    let b = '';
    await new Promise((resolve) => {
      req.on('data', (c) => { b += c; });
      req.on('end', resolve);
    });
    try {
      const body = JSON.parse(b || '{}');
      const input = Array.isArray(body.blacklist) ? body.blacklist : [];
      const clean = setModelBlacklist(input);
      saveConfig();
      Logger.info('CONFIG', `模型黑名单已更新 (共 ${clean.length} 条规则，已热生效)`, {
        blacklist: clean
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, blacklist: clean, count: clean.length }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: e.message }));
    }
  }

  // 7.3 单个模型网关思考档位配置更新
  if (url.pathname === '/api/models/thinking-level' && req.method === 'POST') {
    let b = '';
    await new Promise((resolve) => {
      req.on('data', (c) => { b += c; });
      req.on('end', resolve);
    });
    try {
      const body = JSON.parse(b || '{}');
      const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
      if (!modelId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: '缺少 modelId' }));
      }
      const level = typeof body.level === 'string' ? body.level.trim() : 'default';
      const updated = setModelThinkingLevel(modelId, level);
      Logger.info('CONFIG', `已更新模型 [${modelId}] 网关思考档位为: ${level}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, modelId, level, thinkingPolicy: updated }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: e.message }));
    }
  }

  // 8. OAuth 扫码授权开始 (完全对齐 package: ExternalLinkAuthenticationProvider.fetchAuthState)
  // region 由请求体或查询参数指定，默认国内版；国际版端点结构完全一致。
  if (url.pathname === '/api/oauth/start' && req.method === 'POST') {
    let bodyRaw = '';
    await new Promise((resolve) => {
      req.on('data', (c) => { bodyRaw += c; });
      req.on('end', resolve);
    });
    let reqRegion = url.searchParams.get('region');
    if (!reqRegion && bodyRaw) {
      try { reqRegion = JSON.parse(bodyRaw).region; } catch (_) {}
    }
    const region = normalizeRegion(reqRegion);
    const ep = endpointsFor({ region });

    try {
      const oauthRes = await fetch(ep.authState, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: '{}'
      });
      const oauthData = await oauthRes.json();
      const payload = oauthData.data || oauthData;
      const state = payload.state;

      // 登录页 URL 的取舍（实测依据）：
      //   服务端下发的 authUrl 形如
      //     cn:   https://copilot.tencent.com/login?platform=CLI&state=...
      //     intl: https://www.codebuddy.ai/login?platform=CLI&state=...
      //   —— 是 **api 域**、无尾斜杠、无 version 参数。
      //
      //   而官方 CLI 实际在浏览器里打开的是
      //     https://www.codebuddy.cn/login/?platform=CLI&state=...&version=v2.179.0
      //   —— **web 域**、带尾斜杠、带 version。
      //
      //   说明 CLI 拿到 authUrl 后会重写一次。用户点「复制链接」是在浏览器打开，
      //   必须用重写后的形态，否则会落到 api 域（页面不存在）。
      //   因此这里**优先用 ep.login(state)**（已按官方最终形态拼接），
      //   仅当本地拼接失败时才回落到服务端下发的 authUrl 兜底。
      const loginUrl = ep.login(state) || payload.authUrl;

      Logger.info('OAUTH', `发起设备码授权 [${REGION_BASE[region].label}], state: ${state}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ state, loginUrl, region }));
    } catch (e) {
      Logger.error('OAUTH', `生成登录链接失败: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // 9. OAuth 扫码授权轮询 (完全对齐 package: ExternalLinkAuthenticationProvider.loopGetToken & loopGetAccount)
  if (url.pathname === '/api/oauth/poll' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', async () => {
      const { state, region: bodyRegion } = JSON.parse(b || '{}');
      const pollRegion = normalizeRegion(bodyRegion || url.searchParams.get('region'));
      const ep = endpointsFor({ region: pollRegion });
      try {
        // 官方原生使用 GET 方法轮询 token
        const pollRes = await fetch(ep.authToken(state), {
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT }
        });
        const tokenEnvelope = await pollRes.json();
        const tokenData = tokenEnvelope.data || tokenEnvelope;

        // 官方等待码 11217 (LOGIN_TOKEN_PENDING_CODE)
        if (tokenEnvelope.code === 11217 || (!tokenData.access_token && !tokenData.accessToken)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, msg: '等待手机扫码授权中...' }));
        }

        const accessToken = tokenData.access_token || tokenData.accessToken;
        const refreshToken = tokenData.refresh_token || tokenData.refreshToken || '';
        const expiresIn = tokenData.expires_in || tokenData.expiresIn || 7200;

        if (accessToken) {
          // 调用官方账号快照接口 GET /v2/plugin/accounts (对齐 getAccountSnapshot)
          let accountInfo = null;
          try {
            const accRes = await fetch(ep.accounts, {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'User-Agent': USER_AGENT
              }
            });
            if (accRes.ok) {
              const accData = await accRes.json();
              const list = accData.data?.accounts || [];
              accountInfo = list.find(a => a.lastLogin) || list[0];
            }
          } catch (_) {}

          // 兜底备用：GET /v2/plugin/login/account?state=
          if (!accountInfo) {
            try {
              const fallbackRes = await fetch(ep.loginAccount(state), {
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                  'User-Agent': USER_AGENT
                }
              });
              if (fallbackRes.ok) {
                const fbData = await fallbackRes.json();
                accountInfo = fbData.data || fbData;
              }
            } catch (_) {}
          }

          const rawUid = accountInfo?.uid || accountInfo?.uin || ('uid_' + Date.now());
          const nickname = accountInfo?.nickname || accountInfo?.nick_name || accountInfo?.phoneNumber || '已授权账号';

          const newAcc = {
            uid: String(rawUid),
            uin: String(accountInfo?.uin || ''),
            email: nickname,
            phoneNumber: accountInfo?.phoneNumber || '',
            type: accountInfo?.type || 'personal',
            // 区域由授权时选择决定，后续所有上游调用都按此字段选 base 域名
            region: pollRegion,
            accessToken: accessToken,
            refreshToken: refreshToken,
            expiresAt: Date.now() + expiresIn * 1000,
            creditsRemain: 0,
            status: 'healthy',
            inFlight: 0
          };

          // 如果已有相同 uid/uin，则替换更新
          const existingIdx = accounts.findIndex(a => a.uid === newAcc.uid || (newAcc.uin && a.uin === newAcc.uin));
          if (existingIdx !== -1) {
            accounts[existingIdx] = { ...accounts[existingIdx], ...newAcc };
          } else {
            accounts.push(newAcc);
          }
          saveAccounts();
          Logger.info('OAUTH', `新账号授权成功录入: [${newAcc.email} (UID: ${newAcc.uid})]`);
          AccountScheduler.refreshCredits(newAcc);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, account: newAcc }));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, msg: tokenEnvelope.msg || '等待扫码中...' }));

      } catch (e) {
        Logger.error('OAUTH', `轮询授权异常: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 10. 全员打卡签到
  if (url.pathname === '/api/checkin' && req.method === 'POST') {
    const results = [];
    for (const acc of accounts) {
      const resObj = await AccountScheduler.dailyCheckin(acc, true);
      results.push({
        uid: acc.uid,
        email: acc.email,
        success: resObj.success,
        alreadyCheckedIn: Boolean(resObj.alreadyCheckedIn),
        msg: resObj.msg
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      total: accounts.length,
      results
    }));
  }

  // 11. 单号打卡签到
  if (url.pathname === '/api/checkin-single' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', async () => {
      const { uid, force } = JSON.parse(b);
      const acc = accounts.find(a => a.uid === uid);
      if (!acc) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Account not found' }));
      }
      const resObj = await AccountScheduler.dailyCheckin(acc, force !== false);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(resObj));
    });
    return;
  }

  // 12. 账号备注更新接口
  if (url.pathname === '/api/accounts/note' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      try {
        const { uid, note } = JSON.parse(b);
        const acc = accounts.find(a => a.uid === uid);
        if (!acc) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Account not found' }));
        }
        acc.note = (note || '').trim();
        saveAccounts();
        Logger.info('ACCOUNTS', `已更新账号 [${formatAccountFullDesc(acc)}] 备注为: "${acc.note}"`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, note: acc.note }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 12.5b. 修改账号所属区域（国内版 / 国际版）
  // 两个区域的上游路径完全同构，仅 base 域名不同；token 按签发域隔离，
  // 因此切换 region 后必须确保该 token 确实属于目标区域，否则 chat 会 401。
  if (url.pathname === '/api/accounts/region' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      try {
        const { uid, region } = JSON.parse(b);
        const acc = accounts.find(a => a.uid === uid);
        if (!acc) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Account not found' }));
        }
        const next = normalizeRegion(region);
        acc.region = next;
        saveAccounts();
        Logger.info('ACCOUNTS', `已将账号 [${formatAccountFullDesc(acc)}] 区域设为 ${REGION_BASE[next].label}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, region: next, label: REGION_BASE[next].label }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 12.6. 网关指定/锁定全局优先账号接口
  if (url.pathname === '/api/accounts/pin' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      try {
        const { uid } = JSON.parse(b);
        config.pinnedAccount = (uid || '').trim();
        saveConfig();
        const acc = accounts.find(a => a.uid === config.pinnedAccount);
        if (config.pinnedAccount && acc) {
          Logger.info('CONFIG', `网关已锁定全局优先指定账号: [${formatAccountFullDesc(acc)}]`);
        } else {
          Logger.info('CONFIG', `网关已取消全局指定账号，恢复全池自动负载轮换`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, pinnedAccount: config.pinnedAccount }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 12.8. 手动触发指定账号换发新令牌接口
  if (url.pathname === '/api/accounts/refresh-token' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', async () => {
      try {
        const { uid } = JSON.parse(b);
        const acc = accounts.find(a => a.uid === uid);
        if (!acc) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Account not found' }));
        }
        const refreshResult = await AccountScheduler.refreshSessionToken(acc);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(refreshResult));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 12.9. 一键解除账号模型锁池/冷却状态
  if (url.pathname === '/api/accounts/unlock-models' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      try {
        const { uid, modelId } = JSON.parse(b || '{}');
        const acc = accounts.find(a => a.uid === uid);
        if (!acc) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Account not found' }));
        }
        if (modelId) {
          if (acc.modelCooldowns) delete acc.modelCooldowns[modelId];
          if (acc.modelCooldownReasons) delete acc.modelCooldownReasons[modelId];
          Logger.info('COOLDOWN', `已手动解除账号 [${formatAccountFullDesc(acc)}] 对模型 [${modelId}] 的锁池冷却`);
        } else {
          acc.modelCooldowns = {};
          acc.modelCooldownReasons = {};
          acc.cooldownUntil = 0;
          Logger.info('COOLDOWN', `已手动一键解除账号 [${formatAccountFullDesc(acc)}] 的所有模型锁池与冷却状态`);
        }
        saveAccounts();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, msg: '锁池状态已成功解除' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 12.10. 报表统计按时间清理接口 (保留今天 / 保留N天 / 一键清空全部)
  if (url.pathname === '/api/metrics/prune' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      try {
        const { mode, keepDays } = JSON.parse(b || '{}');
        const pruneRes = pruneStatsByTime({ mode, keepDays });
        Logger.info('STATS', `统计报表按时间清理完成 (模式: ${mode}, 保留天数: ${keepDays || 1}, 删除历史天数: ${pruneRes.deletedDaysCount})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(pruneRes));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 12.11. 运行日记按时间清理接口 (保留今天 / 保留N天 / 一键清空全部)
  if (url.pathname === '/api/logs/prune' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      try {
        const { mode, keepDays } = JSON.parse(b || '{}');
        const pruneRes = Logger.pruneLogsByTime({ mode, keepDays });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(pruneRes));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 13. 账号删除
  if (url.pathname === '/api/accounts/delete' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      const { uid } = JSON.parse(b);
      const idx = accounts.findIndex(a => a.uid === uid);
      if (idx !== -1) {
        const removed = accounts.splice(idx, 1)[0];
        saveAccounts();
        Logger.warn('ACCOUNTS', `已从账号池移除账号: [${removed?.email || uid}]`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ error: 'API route not found' }));
}
