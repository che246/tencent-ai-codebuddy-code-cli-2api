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
  formatAccountFullDesc
} from '../config.mjs';
import { Logger } from '../core/logger.mjs';
import { LogDatabase } from '../core/database.mjs';
import { AccountScheduler } from '../core/scheduler.mjs';
import { TlsCertificateStack } from '../core/tls-certs.mjs';
import { fetchDetailedModels } from '../upstream/models.mjs';
import { getMetricsReport, loadStats, formatTokenNumber } from '../core/metrics.mjs';

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

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
      maxLogDbSizeMb: config.maxLogDbSizeMb || 30,
      logDbSizeMb: LogDatabase.getSizeMb(),
      autoCheckin: Boolean(config.autoCheckin)
    }));
  }

  // 2. 策略设置更新接口 (热更新生效并落盘)
  if (url.pathname === '/api/settings' && req.method === 'POST') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      try {
        const body = JSON.parse(b);
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
        if (typeof body.maxLogDbSizeMb === 'number') {
          config.maxLogDbSizeMb = Math.max(1, body.maxLogDbSizeMb);
          LogDatabase.checkAndPruneBySize(config.maxLogDbSizeMb);
        }
        if (typeof body.maxInFlightPerAccount === 'number') {
          config.maxInFlightPerAccount = Math.max(1, body.maxInFlightPerAccount);
        }
        saveConfig();
        Logger.info('CONFIG', `网关运行策略已更新 (热生效)`, {
          webAuthEnabled: config.webAuthEnabled,
          concurrencyLimitEnabled: config.concurrencyLimitEnabled,
          accountFailoverEnabled: config.accountFailoverEnabled,
          routingStrategy: config.routingStrategy,
          pinnedAccount: config.pinnedAccount,
          modelFallbackEnabled: config.modelFallbackEnabled,
          modelFallback: config.modelFallback,
          maxLogDbSizeMb: config.maxLogDbSizeMb,
          maxInFlightPerAccount: config.maxInFlightPerAccount
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, config, logDbSizeMb: LogDatabase.getSizeMb() }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 3. 日志查询接口 (支持 SQLite 数据库按日期、日志级别、分类、关键词检索)
  if (url.pathname === '/api/logs' && req.method === 'GET') {
    const date = url.searchParams.get('date') || null;
    const level = url.searchParams.get('level') || null;
    const category = url.searchParams.get('category') || null;
    const search = url.searchParams.get('search') || null;
    const limit = parseInt(url.searchParams.get('limit') || '250', 10);
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

  // 4. 日志全量下载导出
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

  // 5. 清空内存日志
  if (url.pathname === '/api/logs/clear' && req.method === 'POST') {
    Logger.clear();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // 6. 账号列表查询
  if (url.pathname === '/api/accounts' && req.method === 'GET') {
    const stats = loadStats();
    const accStatsMap = stats.accounts || {};

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(accounts.map(a => {
      const accStats = accStatsMap[a.uid] || accStatsMap[a.email] || {};
      const tokens = accStats.totalTokens || 0;
      return {
        uid: a.uid,
        email: a.email,
        note: a.note || '',
        creditsRemain: a.creditsRemain,
        totalTokens: tokens,
        totalTokensDisplay: formatTokenNumber(tokens),
        inputTokens: accStats.inputTokens || 0,
        outputTokens: accStats.outputTokens || 0,
        requests: accStats.requests || 0,
        inFlight: a.inFlight || 0,
        status: a.status,
        isCooldown: Date.now() < (a.cooldownUntil || 0),
        isCheckedInToday: a.lastCheckinDate === today,
        lastCheckinMsg: a.lastCheckinDate === today ? (a.lastCheckinMsg || '今天已签到') : '今日未签到'
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
      ...details
    }));
  }

  // 7. 模型全量看板数据
  if (url.pathname === '/api/models-detail' && req.method === 'GET') {
    const force = url.searchParams.get('refresh') === '1';
    const detailedModels = await fetchDetailedModels(force);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(detailedModels));
  }

  // 8. OAuth 扫码授权开始 (完全对齐 package: ExternalLinkAuthenticationProvider.fetchAuthState)
  if (url.pathname === '/api/oauth/start' && req.method === 'POST') {
    try {
      const oauthRes = await fetch('https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: '{}'
      });
      const oauthData = await oauthRes.json();
      const payload = oauthData.data || oauthData;
      const state = payload.state;
      const loginUrl = payload.authUrl || `https://copilot.tencent.com/login?platform=CLI&state=${state}`;

      Logger.info('OAUTH', `发起设备码授权, state: ${state}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ state, loginUrl }));
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
      const { state } = JSON.parse(b);
      try {
        // 官方原生使用 GET 方法轮询 token
        const pollRes = await fetch(`https://copilot.tencent.com/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
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
            const accRes = await fetch('https://copilot.tencent.com/v2/plugin/accounts', {
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
              const fallbackRes = await fetch(`https://copilot.tencent.com/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
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
            region: 'cn',
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

  // 11. 单号打卡签到
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
