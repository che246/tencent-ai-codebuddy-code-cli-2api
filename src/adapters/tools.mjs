import { endpointsFor, USER_AGENT, formatAccountFullDesc } from '../config.mjs';
import { AccountScheduler } from '../core/scheduler.mjs';
import { Logger } from '../core/logger.mjs';

// ─── 官方服务端联网检索端点: POST /v1/search & POST /search ─────────────────
export async function handleSearch(req, res, rawBody) {
  const startTime = Date.now();
  try {
    const bodyObj = JSON.parse(rawBody || '{}');
    // 优先选择国内健康账号（因 agenttool/v1/search 部署于国内）
    const acc = AccountScheduler.selectAccount(null, null, { region: 'cn' }) || AccountScheduler.selectAccount();
    if (!acc) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'No available account for search' }));
    }

    const queryStr = bodyObj.query || '';
    Logger.info('SEARCH', `发起联网检索 [${queryStr}]`, { account: formatAccountFullDesc(acc) });

    const searchRes = await fetch(endpointsFor(acc).search, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${acc.accessToken}`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: queryStr,
        max_results: bodyObj.max_results || bodyObj.count || 5
      }),
      signal: AbortSignal.timeout(15000)
    });

    const searchData = await searchRes.text();
    const latency = Date.now() - startTime;
    Logger.info('SEARCH', `检索完成 [${queryStr}] 耗时 ${latency}ms (HTTP ${searchRes.status})`);
    res.writeHead(searchRes.status, { 'Content-Type': 'application/json' });
    return res.end(searchData);
  } catch (e) {
    Logger.error('SEARCH', `检索异常: ${e.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: e.message }));
  }
}

// ─── 官方服务端网页抓取端点: POST /v1/fetch & POST /fetch ───────────────────
export async function handleWebFetch(req, res, rawBody) {
  const startTime = Date.now();
  try {
    const bodyObj = JSON.parse(rawBody || '{}');
    // 优先选择国内健康账号（因 agenttool/v1/webfetch 部署于国内）
    const acc = AccountScheduler.selectAccount(null, null, { region: 'cn' }) || AccountScheduler.selectAccount();
    if (!acc) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'No available account for webfetch' }));
    }

    const targetUrl = bodyObj.url || '';
    Logger.info('FETCH', `发起网页内容抓取 [${targetUrl}]`, { account: formatAccountFullDesc(acc) });

    const fetchRes = await fetch(endpointsFor(acc).webfetch, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${acc.accessToken}`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: targetUrl }),
      signal: AbortSignal.timeout(15000)
    });

    const fetchData = await fetchRes.text();
    const latency = Date.now() - startTime;
    Logger.info('FETCH', `抓取完成 [${targetUrl}] 耗时 ${latency}ms (HTTP ${fetchRes.status})`);
    res.writeHead(fetchRes.status, { 'Content-Type': 'application/json' });
    return res.end(fetchData);
  } catch (e) {
    Logger.error('FETCH', `网页抓取异常: ${e.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: e.message }));
  }
}
