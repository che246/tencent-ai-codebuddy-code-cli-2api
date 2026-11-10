import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_URL, endpointsFor, resolveAccountRegion, REGION_CN, REGION_INTL, REGION_BASE, USER_AGENT, accounts, ROOT_DIR } from '../config.mjs';
import { Logger } from '../core/logger.mjs';

// ─── 动态获取可用模型矩阵 ───────────────────────────────────────────────────
// 策略：在线时从上游 /v3/config 拉取，并把结果写入 product.json；
//       离线/冷启动时只读 product.json 一个文件，不依赖 package/ 目录。
export const PRODUCT_JSON_PATH = path.resolve(ROOT_DIR, 'product.json');

let cachedRawUpstreamModels = null;
let lastModelFetchTimestamp = 0;

/**
 * 把上游返回的模型矩阵持久化到 product.json（保留原有其他字段）。
 * 上游只提供 models / agents / productFeatures，prompts/tools 等由官方文件自带；
 * 这里采用"合并"而非"覆盖"，避免丢失本地已有的非模型字段。
 */
function persistModelsToProductJson(models) {
  if (!Array.isArray(models) || models.length === 0) return false;
  try {
    let base = {};
    if (fs.existsSync(PRODUCT_JSON_PATH)) {
      try { base = JSON.parse(fs.readFileSync(PRODUCT_JSON_PATH, 'utf8')); } catch (_) { base = {}; }
    }
    const prevIds = new Set((base.models || []).map(m => m.id));
    base.models = models;
    base.modelsSyncedAt = new Date().toISOString();
    fs.writeFileSync(PRODUCT_JSON_PATH, JSON.stringify(base, null, 2), 'utf8');

    const added = models.map(m => m.id).filter(id => !prevIds.has(id));
    if (added.length > 0) {
      Logger.info('CONFIG', `product.json 已更新模型矩阵 (${models.length} 款，新增: ${added.join(', ')})`);
    } else {
      Logger.info('CONFIG', `product.json 已同步模型矩阵 (${models.length} 款)`);
    }
    return true;
  } catch (e) {
    Logger.warn('CONFIG', `写入 product.json 失败: ${e.message}`);
    return false;
  }
}

/** 从 product.json 读取模型矩阵（优先根目录快照，缺失时回落至 package/ 官方内置快照） */
function loadModelsFromProductJson() {
  if (fs.existsSync(PRODUCT_JSON_PATH)) {
    try {
      const p = JSON.parse(fs.readFileSync(PRODUCT_JSON_PATH, 'utf8'));
      if (Array.isArray(p.models) && p.models.length > 0) return p.models;
    } catch (_) {}
  }
  // 官方 CLI 内置 product.json 兜底
  const builtinPath = path.resolve(ROOT_DIR, 'package', 'product.json');
  if (fs.existsSync(builtinPath)) {
    try {
      const p = JSON.parse(fs.readFileSync(builtinPath, 'utf8'));
      if (Array.isArray(p.models) && p.models.length > 0) return p.models;
    } catch (_) {}
  }
  return [];
}

export async function fetchDetailedModels(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedRawUpstreamModels && (now - lastModelFetchTimestamp < 5 * 60 * 1000)) {
    return attachProbeStatus(cachedRawUpstreamModels);
  }

  // 1) 在线优先：按账号所属区域分别拉取，合并去重
  //    国内版与国际版的模型集合不同（国际版有 gpt-6-astra/grok-4.7 等），
  //    两个区域都拉到才能让客户端看到完整可用列表。
  //    每个模型额外打上 regions 标记（可能同时存在于两区），供前端分区展示。
  const merged = new Map();
  const regionStat = {};
  for (const acc of accounts) {
    if (acc.status !== 'healthy' || !acc.accessToken) continue;
    const ep = endpointsFor(acc);
    const region = resolveAccountRegion(acc);
    try {
      const res = await fetch(ep.config, {
        headers: {
          'Authorization': `Bearer ${acc.accessToken}`,
          'User-Agent': USER_AGENT
        },
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        const data = await res.json();
        const models = data.data?.models || [];
        if (models.length > 0) {
          regionStat[region] = (regionStat[region] || 0) + models.length;
          for (const m of models) {
            if (!m || !m.id) continue;
            const exist = merged.get(m.id);
            if (exist) {
              // 两区都有的模型：合并 regions 标记
              if (!exist.regions.includes(region)) exist.regions.push(region);
            } else {
              merged.set(m.id, { ...m, regions: [region] });
            }
          }
        }
      }
    } catch (_) {}
  }

  // 2) 跨区域容灾保持：若某区域在此次拉取中未响应，保留本地快照中该区域已有模型，杜绝单区超时抹除全量数据
  const existingSnapshot = loadModelsFromProductJson();
  if (existingSnapshot.length > 0) {
    const knownRegions = [REGION_CN, REGION_INTL];
    for (const r of knownRegions) {
      if (!regionStat[r]) {
        // 当前区域拉取失败或无可用账号，从既有快照补充该区域的模型
        for (const m of existingSnapshot) {
          if (!m || !m.id) continue;
          const mRegions = Array.isArray(m.regions) ? m.regions : (m.region ? [m.region] : [REGION_CN]);
          if (mRegions.includes(r)) {
            const exist = merged.get(m.id);
            if (exist) {
              if (!exist.regions.includes(r)) exist.regions.push(r);
            } else {
              merged.set(m.id, { ...m, regions: [r] });
            }
          }
        }
      }
    }
  }

  if (merged.size > 0) {
    const models = [...merged.values()];
    cachedRawUpstreamModels = models;
    lastModelFetchTimestamp = now;
    const regionDesc = Object.entries(regionStat)
      .map(([r, n]) => `${REGION_BASE[r]?.label || r}:${n}`)
      .join(' ') || '本地快照兜底';
    Logger.info('CONFIG', `成功从上游拉取模型矩阵 (合并去重后共 ${models.length} 款；${regionDesc})`);
    persistModelsToProductJson(models);
    return attachProbeStatus(models);
  }

  // 3) 离线兜底：只读 product.json 或内置快照
  const fallbackModels = existingSnapshot.map(m => (
    Array.isArray(m?.regions) && m.regions.length ? m : { ...m, regions: [REGION_CN] }
  ));
  if (fallbackModels.length > 0) {
    cachedRawUpstreamModels = fallbackModels;
    Logger.info('CONFIG', `上游不可达，已从 product.json 加载离线模型矩阵 (共 ${fallbackModels.length} 款)`);
    return attachProbeStatus(fallbackModels);
  }

  Logger.warn('CONFIG', '上游不可达且 product.json 无模型数据，模型列表为空');
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
