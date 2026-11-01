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
    for (const acc of accounts) {
      if (acc.modelCooldowns?.[m.id] && now < acc.modelCooldowns[m.id]) {
        coolingCount++;
      }
    }
    const isCooling = coolingCount > 0 && coolingCount >= accounts.length;
    const isPartialCooling = coolingCount > 0 && coolingCount < accounts.length;

    let probeStatus = 'idle';
    let probeLabel = '🟢 畅通';
    if (isCooling) {
      probeStatus = 'cooldown';
      probeLabel = '🔴 限流冷却';
    } else if (isPartialCooling) {
      probeStatus = 'busy';
      probeLabel = '🟡 局部限流';
    }

    return {
      ...m,
      probeStatus,
      probeLabel
    };
  });
}
