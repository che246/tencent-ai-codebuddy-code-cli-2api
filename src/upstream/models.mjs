import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_URL, USER_AGENT, accounts, ROOT_DIR } from '../config.mjs';
import { Logger } from '../core/logger.mjs';

// ─── 动态获取可用模型矩阵 (深度融合官方 package/product.*.json) ────────────
let cachedRawUpstreamModels = null;
let lastModelFetchTimestamp = 0;

export async function fetchDetailedModels(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedRawUpstreamModels && (now - lastModelFetchTimestamp < 5 * 60 * 1000)) {
    return attachProbeStatus(cachedRawUpstreamModels);
  }

  for (const acc of accounts) {
    if (acc.status !== 'healthy' || !acc.accessToken) continue;
    try {
      const res = await fetch(CONFIG_URL, {
        headers: {
          'Authorization': `Bearer ${acc.accessToken}`,
          'User-Agent': USER_AGENT
        }
      });
      if (res.ok) {
        const data = await res.json();
        const models = data.data?.models || [];
        if (models.length > 0) {
          cachedRawUpstreamModels = models;
          lastModelFetchTimestamp = now;
          Logger.info('CONFIG', `成功从腾讯云上游拉取全量模型矩阵 (共 ${models.length} 款)`);
          return attachProbeStatus(models);
        }
      }
    } catch (_) {}
  }

  // 离线/冷启动兜底：深度融合 package/product.json 与 package/product.internal.json
  const fallbackModels = [];
  const modelMap = new Map();
  const candidateFiles = [
    path.resolve(ROOT_DIR, 'product.json'),
    path.resolve(ROOT_DIR, 'package/product.json'),
    path.resolve(ROOT_DIR, 'package/product.internal.json')
  ];

  for (const f of candidateFiles) {
    if (fs.existsSync(f)) {
      try {
        const p = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (Array.isArray(p.models)) {
          for (const m of p.models) {
            if (!modelMap.has(m.id)) {
              modelMap.set(m.id, m);
              fallbackModels.push(m);
            }
          }
        }
      } catch (_) {}
    }
  }

  if (fallbackModels.length > 0) {
    cachedRawUpstreamModels = fallbackModels;
    return attachProbeStatus(cachedRawUpstreamModels);
  }

  return attachProbeStatus([]);
}

export function attachProbeStatus(models) {
  const now = Date.now();
  return models.map(m => {
    let coolingCount = 0;
    const coolingAccounts = [];

    for (const acc of accounts) {
      if (acc.modelCooldowns?.[m.id] && now < acc.modelCooldowns[m.id]) {
        coolingCount++;
        const remainingSec = Math.ceil((acc.modelCooldowns[m.id] - now) / 1000);
        const accName = acc.email || acc.uid;
        const noteStr = acc.note ? acc.note.trim() : '';
        const displayName = noteStr ? `${accName} [${noteStr}]` : accName;
        coolingAccounts.push({
          uid: acc.uid,
          name: displayName,
          email: acc.email || acc.uid,
          note: noteStr,
          remainingSec,
          reason: acc.modelCooldownReasons?.[m.id] || '上游频控限制 (429/6004)'
        });
      }
    }

    const totalAccounts = Math.max(1, accounts.length);
    const isCooling = coolingCount > 0 && coolingCount >= totalAccounts;
    const isPartialCooling = coolingCount > 0 && coolingCount < totalAccounts;

    let probeStatus = 'idle';
    let probeLabel = '🟢 畅通';
    if (isCooling) {
      probeStatus = 'cooldown';
      probeLabel = `🔴 全池冷却 (${coolingCount}/${totalAccounts})`;
    } else if (isPartialCooling) {
      probeStatus = 'busy';
      probeLabel = `🟡 局部限流 (${coolingCount}/${totalAccounts})`;
    }

    // ─── 官方上游模型繁忙度 (从上游获取与评估) ─────────────────────
    // 优先读取上游接口原始下发的负载与繁忙度属性 (如 busyLevel, load, status 等)
    let upstreamBusyRaw = m.busyLevel || m.busy_level || m.load || m.loadLevel || m.status || m.busy || null;
    let upstreamBusyLevel = 'idle';
    let upstreamBusyLabel = '🟢 空闲 (畅通)';
    let upstreamBusyDesc = '上游官方节点正常在线，负载充裕';

    if (upstreamBusyRaw) {
      const rawStr = String(upstreamBusyRaw).toLowerCase();
      if (rawStr.includes('busy') || rawStr.includes('high') || rawStr.includes('congest')) {
        upstreamBusyLevel = 'busy';
        upstreamBusyLabel = '🟡 繁忙 (高载)';
        upstreamBusyDesc = `上游标定负载状态: ${upstreamBusyRaw}`;
      } else if (rawStr.includes('overload') || rawStr.includes('down') || rawStr.includes('error') || rawStr.includes('limit')) {
        upstreamBusyLevel = 'overload';
        upstreamBusyLabel = '🔴 拥挤 (限流)';
        upstreamBusyDesc = `上游标定负载状态: ${upstreamBusyRaw}`;
      } else {
        upstreamBusyLevel = 'normal';
        upstreamBusyLabel = `🟢 ${upstreamBusyRaw}`;
        upstreamBusyDesc = `上游官方标定状态: ${upstreamBusyRaw}`;
      }
    } else {
      // 结合近期调用健康度与限流反馈进行评估
      if (isCooling) {
        upstreamBusyLevel = 'overload';
        upstreamBusyLabel = '🔴 上游限流';
        upstreamBusyDesc = '上游官方该模型当前请求频繁，所有账号均触发频控限制';
      } else if (isPartialCooling) {
        upstreamBusyLevel = 'busy';
        upstreamBusyLabel = '🟡 部分繁忙';
        upstreamBusyDesc = `上游官方个别账号已触达频控阈值 (${coolingCount}/${totalAccounts} 个账号降级冷却中)`;
      } else {
        upstreamBusyLevel = 'idle';
        upstreamBusyLabel = '🟢 空闲 (畅通)';
        upstreamBusyDesc = '上游服务响应就绪，无拥堵限流记录';
      }
    }

    return {
      ...m,
      probeStatus,
      probeLabel,
      totalAccounts,
      coolingCount,
      coolingAccounts,
      upstreamBusyLevel,
      upstreamBusyLabel,
      upstreamBusyDesc
    };
  });
}
