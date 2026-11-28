import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { endpointsFor, resolveAccountRegion, REGION_CN, REGION_INTL, USER_AGENT, accounts, ROOT_DIR } from '../config.mjs';
import { Logger } from '../core/logger.mjs';

// ─── 动态获取可用模型矩阵 ───────────────────────────────────────────────────
// [网关自有策略，无 CLI 对应实现 · 决策由 VG 明确指定]
// 模型列表**只以上游 /v3/config 为准**，不做任何磁盘快照与离线回放：
//   · 不写 product.json，不读 product.json，也不回落 package/product.json；
//   · 进程内保留 5 分钟内存缓存，仅为降低对上游的请求频率，不构成第二数据源；
//   · 上游不可达时如实返回空列表，由调用方感知失败，而不是用陈旧快照掩盖问题。
// 理由：模型矩阵随上游随时漂移（上下架、改价、改能力位），陈旧的本地快照会让下游
// 客户端选到已下架或已无权限的模型，产生难以归因的 4xx，比"列表短暂为空"更糟。
// CLI 侧对应实现：ProductManager 以 48e4(8 分钟) TTL 懒刷新 + 事件强制刷新，
// 同样不依赖本地模型快照做业务回放（磁盘缓存仅为加速启动，非权威源）。
// TTL 取 5 分钟而非 CLI 的 8 分钟：网关面向多个下游客户端，需要更快跟上上游变更。

let cachedRawUpstreamModels = null;
let cachedRawPromotions = [];
let lastModelFetchTimestamp = 0;

// 上一个进程周期遗留的 product.json：仅用于启动时提示运维删除，不再作为数据源读取。
const LEGACY_PRODUCT_JSON_PATH = path.resolve(ROOT_DIR, 'product.json');

/**
 * 一次性检查：若磁盘上仍残留历史 product.json 快照，提示运维删除。
 * 该文件已不再被读取，留着只会让人误以为模型列表来自本地缓存。
 */
export function warnLegacyProductSnapshot() {
  try {
    if (fs.existsSync(LEGACY_PRODUCT_JSON_PATH)) {
      Logger.warn('CONFIG', `检测到历史遗留快照 product.json（${LEGACY_PRODUCT_JSON_PATH}）。该文件已不再作为模型列表数据源，可安全删除。`);
    }
  } catch (_) {}
}

/**
 * 解析并关联单个模型的活动角标与促销详情
 * 1. 优先对齐上游官方 /v3/config 下发的动态 modelPromotions 规则 (含 badge, hover, discount, schedule)
 * 2. 官方常态折扣策略与免费模型兜底 (如 DeepSeek-V4.1-Flash、GLM-5.2 的非高峰5折夜间折扣，以及 0 积分免费模型)
 */
export function resolveModelPromotion(m, promotions = []) {
  if (!m) return null;
  const mId = String(m.id || '').toLowerCase().trim();
  const mName = String(m.name || '').toLowerCase().trim();

  // 1. 优先匹配上游动态下发的 promotions
  if (Array.isArray(promotions) && promotions.length > 0) {
    for (const p of promotions) {
      if (!p || p.enabled === false) continue;
      const modelIds = Array.isArray(p.modelIds) ? p.modelIds.map(x => String(x).toLowerCase().trim()) : [];
      const match = modelIds.includes(mId)
        || modelIds.includes(mName)
        || (m.relatedModels && Object.values(m.relatedModels).some(rm => modelIds.includes(String(rm).toLowerCase().trim())));
      if (match) {
        return {
          id: p.id,
          kind: p.kind || 'discount',
          badge: {
            label: p.badge?.label || '限时优惠',
            color: p.badge?.color || '#009273',
            icon: p.badge?.icon || null,
            display: p.badge?.display || 'activeOnly'
          },
          hover: {
            textZh: p.hover?.textZh || '',
            textEn: p.hover?.textEn || '',
            action: p.hover?.action || null
          },
          discount: p.discount || null,
          schedule: p.schedule || null,
          source: 'upstream'
        };
      }
    }
  }

  // 2. 官方上游常态/内置规则兜底
  const creditsStr = String(m.credits || '').toLowerCase();
  const isFree = creditsStr.includes('0.00') || creditsStr.includes('0x') || m.multiplier === 0;

  if (isFree) {
    return {
      id: `free-${mId}`,
      kind: 'free',
      badge: {
        label: '限时免费',
        color: '#009273',
        icon: null
      },
      hover: {
        textZh: '当前模型处于官方限时免费阶段，调用消耗 0 积分。'
      },
      discount: {
        factor: 0,
        discountedCredits: '0x'
      },
      source: 'preset'
    };
  }

  if (mId.includes('deepseek-v4.1-flash') || mId.includes('v4.1-flash') || mName.includes('deepseek-v4.1-flash')) {
    return {
      id: 'ds-v4.1-flash-night-discount',
      kind: 'discount',
      badge: {
        label: '夜间折扣',
        color: '#009273',
        icon: null
      },
      hover: {
        textZh: '周一至周五 09:00-12:00、14:00-18:00 属高峰原价，非高峰期积分5折 去使用'
      },
      discount: {
        factor: 0.5,
        discountedCredits: '0.055x'
      },
      source: 'preset'
    };
  }

  if (mId.includes('glm-5.2') || mName.includes('glm-5.2')) {
    return {
      id: 'glm-5.2-night-discount',
      kind: 'discount',
      badge: {
        label: '夜间折扣',
        color: '#009273',
        icon: null
      },
      hover: {
        textZh: '周一至周五 09:00-12:00、14:00-18:00 属高峰原价，非高峰期积分5折'
      },
      discount: {
        factor: 0.5,
        discountedCredits: '0.395x'
      },
      source: 'preset'
    };
  }

  return null;
}

let cachedBusyMap = {};
let lastBusyFetchTimestamp = 0;

/**
 * 官方上游模型实时繁忙度探测 (POST /v2/chat/busy)
 * 来源：官方桌面端 / Web 端实时探针（见 WorkBuddy / CodeBuddy RPC 抓包）：
 *   POST {chatBase}/v2/chat/busy
 *   Header: Accept, Content-Type, User-Agent, Authorization, X-User-Id, X-Product: SaaS, X-Domain, X-Request-ID
 *   Body: {"models": ["deepseek-v4.1-flash", ...]} (单次上限 50 个)
 *   响应: {"code":0,"data":[{"model":"deepseek-v4.1-flash","busy_level":"congested"}, ...]}
 * busy_level ∈ idle | normal | busy | congested | unavailable | unknown
 * 仅国内版支持（国际版返回 404），纯观测数据，不影响路由选号。
 */
export async function fetchUpstreamModelBusyLevels(modelIds = [], force = false) {
  const now = Date.now();
  if (!force && Object.keys(cachedBusyMap).length > 0 && (now - lastBusyFetchTimestamp < 60 * 1000)) {
    return cachedBusyMap;
  }
  if (!Array.isArray(modelIds) || modelIds.length === 0) return cachedBusyMap;

  const cnAcc = accounts.find(a => a.status === 'healthy' && resolveAccountRegion(a) === REGION_CN && a.accessToken);
  if (!cnAcc) return cachedBusyMap;

  const ep = endpointsFor(cnAcc);
  const busyUrl = `${ep.apiBase}/v2/chat/busy`;
  const result = { ...cachedBusyMap };

  const BATCH_SIZE = 50;
  for (let i = 0; i < modelIds.length; i += BATCH_SIZE) {
    const batch = modelIds.slice(i, i + BATCH_SIZE);
    try {
      const traceId = crypto.randomBytes(16).toString('hex');
      const res = await fetch(busyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': USER_AGENT,
          'Authorization': `Bearer ${cnAcc.accessToken}`,
          'X-User-Id': cnAcc.uid || '',
          'X-Product': 'SaaS',
          'X-Domain': 'copilot.tencent.com',
          'X-Request-ID': traceId
        },
        body: JSON.stringify({ models: batch }),
        signal: AbortSignal.timeout(4000)
      });
      if (res.ok) {
        const json = await res.json();
        if (json.code === 0 && Array.isArray(json.data)) {
          for (const item of json.data) {
            if (item && item.model && item.busy_level) {
              result[item.model.toLowerCase()] = item.busy_level.toLowerCase();
            }
          }
        }
      }
    } catch (_) {}
  }

  cachedBusyMap = result;
  lastBusyFetchTimestamp = now;
  return result;
}

export async function fetchDetailedModels(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedRawUpstreamModels && (now - lastModelFetchTimestamp < 5 * 60 * 1000)) {
    const allIds = cachedRawUpstreamModels.map(m => m.id);
    const busyMap = await fetchUpstreamModelBusyLevels(allIds, false);
    for (const m of cachedRawUpstreamModels) {
      if (busyMap[m.id.toLowerCase()]) {
        m.busy = busyMap[m.id.toLowerCase()];
        m.busy_level = m.busy;
      }
    }
    // 缓存命中：促销活动同样只来自上次真实上游响应，不回落本地文件
    return attachProbeStatus(cachedRawUpstreamModels, cachedRawPromotions);
  }

  // 1) 只以上游为准：按账号所属区域分别拉取，合并去重
  //    国内版与国际版的模型集合不同（国际版有 gpt-6-astra/grok-4.7 等），
  //    两个区域都拉到才能让客户端看到完整可用列表。
  //    优化：同区域由首个可用账号成功拉取后即标记完成，无需对同区全池重复请求。
  //    注意：某区域本次未拉取成功时，**不会**用任何本地快照补齐——宁可少一个区域的模型，
  //    也不让下游看到上游已下架/已改能力的陈旧条目。
  const merged = new Map();
  const mergedPromotions = new Map();
  const regionStat = {};
  const fetchedRegions = new Set();
  const failedRegions = [];
  const regionErrors = new Map();   // region -> 首个失败原因（用于末尾汇总日志）

  for (const acc of accounts) {
    if (acc.status !== 'healthy' || !acc.accessToken) continue;
    const region = resolveAccountRegion(acc);
    if (fetchedRegions.has(region)) continue;

    const ep = endpointsFor(acc);
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
        const promos = Array.isArray(data.data?.modelPromotions) ? data.data.modelPromotions : [];
        for (const p of promos) {
          if (p && p.id) mergedPromotions.set(p.id, p);
        }

        if (models.length > 0) {
          fetchedRegions.add(region);
          regionStat[region] = models.length;
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
    } catch (e) {
      // 同一区域会有多个账号依次尝试，这里只记录首个失败原因，末尾统一汇总，
      // 避免一次拉取失败刷出十几条重复 warn。
      if (!regionErrors.has(region)) regionErrors.set(region, e.message);
    }
  }

  // 记录本次未拿到数据的区域，供日志与调用方判断"列表是否完整"
  for (const r of [REGION_CN, REGION_INTL]) {
    if (!regionStat[r]) failedRegions.push(r);
  }

  // 2) 只有真正从上游拿到数据，才更新内存缓存并返回。
  //    这里不再有任何"跨区域快照补齐"或"离线快照回放"——模型列表必须与上游同步。
  if (merged.size > 0) {
    const models = [...merged.values()];
    const allIds = models.map(m => m.id);
    const busyMap = await fetchUpstreamModelBusyLevels(allIds, forceRefresh);
    for (const m of models) {
      if (busyMap[m.id.toLowerCase()]) {
        m.busy = busyMap[m.id.toLowerCase()];
        m.busy_level = m.busy;
      }
    }

    // 促销活动同样只认本次上游下发的 modelPromotions，不再回落到本地文件
    const activePromotions = [...mergedPromotions.values()];
    cachedRawUpstreamModels = models;
    cachedRawPromotions = activePromotions;
    lastModelFetchTimestamp = now;
    const cnCount = models.filter(m => m.regions && m.regions.includes(REGION_CN)).length;
    const intlCount = models.filter(m => m.regions && m.regions.includes(REGION_INTL)).length;
    const bothCount = models.filter(m => m.regions && m.regions.includes(REGION_CN) && m.regions.includes(REGION_INTL)).length;
    const cnAccCount = accounts.filter(a => a.status === 'healthy' && resolveAccountRegion(a) === REGION_CN).length;
    const intlAccCount = accounts.filter(a => a.status === 'healthy' && resolveAccountRegion(a) === REGION_INTL).length;
    Logger.info('CONFIG', `成功从上游拉取模型矩阵 (全局去重共 ${models.length} 款；国内版: ${cnCount} 款 [${cnAccCount} 账号]，国际版: ${intlCount} 款 [${intlAccCount} 账号]，两区通用: ${bothCount} 款，活动: ${activePromotions.length} 项${failedRegions.length > 0 ? `，本次未拉到: ${failedRegions.join('/')}` : ''})`);
    return attachProbeStatus(models, activePromotions);
  }

  // 3) 上游完全拿不到数据：如实返回空列表，不做任何本地回放。
  //    同时清空内存缓存，避免上一次的陈旧结果在下一轮被当作"仍然有效"。
  cachedRawUpstreamModels = null;
  cachedRawPromotions = [];
  lastModelFetchTimestamp = 0;
  const errDetail = failedRegions
    .filter(r => regionErrors.has(r))
    .map(r => `${r}: ${regionErrors.get(r)}`)
    .join('；');
  Logger.warn('CONFIG', `上游 /v3/config 全部不可达（未拉到: ${failedRegions.join('/') || '未知'}${errDetail ? `，原因: ${errDetail}` : ''}），模型列表返回空。请检查账号健康度与网络连通性。`);
  return attachProbeStatus([], []);
}

export function attachProbeStatus(models, promotions = []) {
  const activePromotions = Array.isArray(promotions) && promotions.length > 0 ? promotions : (cachedRawPromotions || []);
  const now = Date.now();
  return models.map(m => {
    const promotion = resolveModelPromotion(m, activePromotions);
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
    // 优先读取上游接口 POST /v2/chat/busy 原始下发的繁忙度属性 (busy_level ∈ idle | normal | busy | congested | unavailable)
    let upstreamBusyRaw = m.busy || m.busy_level || m.busyLevel || null;
    let upstreamBusyLevel = 'idle';
    let upstreamBusyLabel = '🟢 空闲 (畅通)';
    let upstreamBusyDesc = '上游官方节点正常在线，负载充裕';

    if (upstreamBusyRaw) {
      const rawStr = String(upstreamBusyRaw).toLowerCase().trim();
      if (rawStr === 'congested') {
        upstreamBusyLevel = 'congested';
        upstreamBusyLabel = '🔴 拥堵';
        upstreamBusyDesc = '上游官方实时标定: 极度拥堵 (congested)，排队时延较高';
      } else if (rawStr === 'unavailable') {
        upstreamBusyLevel = 'unavailable';
        upstreamBusyLabel = '🔴 不可用';
        upstreamBusyDesc = '上游官方实时标定: 节点不可用 (unavailable)';
      } else if (rawStr === 'busy') {
        upstreamBusyLevel = 'busy';
        upstreamBusyLabel = '🟡 繁忙';
        upstreamBusyDesc = '上游官方实时标定: 高载繁忙 (busy)';
      } else if (rawStr === 'idle' || rawStr === 'normal') {
        upstreamBusyLevel = 'idle';
        upstreamBusyLabel = '🟢 空闲 (畅通)';
        upstreamBusyDesc = '上游官方实时标定: 负载充裕通畅 (idle)';
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
      busy: upstreamBusyRaw,
      busy_level: upstreamBusyRaw,
      promotion,
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
