import {
  config,
  accounts,
  saveAccounts,
  getTodayString,
  SUMMARY_URL,
  CHECKIN_URL,
  USER_AGENT
} from '../config.mjs';
import { Logger } from './logger.mjs';

// 会话粘性映射: sessionKey -> { uid, lastActive } (带 1 小时 TTL 自动清理)
export const sessionStickyMap = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of sessionStickyMap.entries()) {
    if (now - val.lastActive > 3600 * 1000) {
      sessionStickyMap.delete(key);
    }
  }
}, 10 * 60 * 1000);

// ─── 账号池调度引擎 ─────────────────────────────────────────────────────
export class AccountScheduler {
  static selectAccount(requestedModel, sessionKey) {
    const now = Date.now();
    const maxLimit = config.concurrencyLimitEnabled !== false ? (config.maxInFlightPerAccount || 3) : 9999;

    if (sessionKey && sessionStickyMap.has(sessionKey)) {
      const sticky = sessionStickyMap.get(sessionKey);
      const acc = accounts.find(a => a.uid === sticky.uid);
      if (acc && acc.status === 'healthy' && now > (acc.cooldownUntil || 0) && (acc.inFlight || 0) < maxLimit) {
        const isModelCooling = requestedModel && acc.modelCooldowns?.[requestedModel] && now < acc.modelCooldowns[requestedModel];
        if (!isModelCooling) {
          sticky.lastActive = now;
          Logger.info('DISPATCH', `粘性会话复用账号 [${acc.email} (${acc.uid})]`, { sessionKey: sessionKey.slice(0, 8), model: requestedModel });
          return acc;
        }
      }
    }

    const candidates = accounts.filter(a => {
      if (a.status !== 'healthy') return false;
      if (now < (a.cooldownUntil || 0)) return false;
      if (requestedModel && a.modelCooldowns?.[requestedModel] && now < a.modelCooldowns[requestedModel]) {
        return false;
      }
      // 单账号限流保护开关：开启时限制并发，关闭时不设上限
      if (config.concurrencyLimitEnabled !== false) {
        if ((a.inFlight || 0) >= maxLimit) return false;
      }
      return true;
    });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      if ((a.inFlight || 0) !== (b.inFlight || 0)) {
        return (a.inFlight || 0) - (b.inFlight || 0);
      }
      return (b.creditsRemain || 0) - (a.creditsRemain || 0);
    });

    const chosen = candidates[0];
    if (sessionKey) {
      sessionStickyMap.set(sessionKey, { uid: chosen.uid, lastActive: now });
    }
    Logger.info('DISPATCH', `调度选中账号 [${chosen.email} (${chosen.uid})] (在途并发: ${chosen.inFlight || 0}, 剩余积分: ${chosen.creditsRemain || 0})`, { model: requestedModel });
    return chosen;
  }

  static cooldown(uid, seconds, reason = '') {
    const acc = accounts.find(a => a.uid === uid);
    if (acc) {
      acc.cooldownUntil = Date.now() + seconds * 1000;
      Logger.warn('COOLDOWN', `账号 [${acc.email} (${uid})] 全局冷却 ${seconds}秒`, { reason });
      saveAccounts();
    }
  }

  static cooldownModel(uid, modelId, seconds = 600, reason = '') {
    const acc = accounts.find(a => a.uid === uid);
    if (acc) {
      if (!acc.modelCooldowns) acc.modelCooldowns = {};
      acc.modelCooldowns[modelId] = Date.now() + seconds * 1000;
      Logger.warn('COOLDOWN', `账号 [${acc.email} (${uid})] 模型 [${modelId}] 局部冷却 ${seconds}秒`, { reason });
      saveAccounts();
    }
  }

  static async refreshCredits(acc) {
    if (!acc.accessToken) return;
    // 检查是否需要根据官方 /v2/plugin/auth/token/refresh 自动续期
    if (acc.refreshToken && acc.expiresAt && (Date.now() > acc.expiresAt - 15 * 60 * 1000)) {
      await this.refreshSessionToken(acc);
    }
    try {
      const res = await fetch(SUMMARY_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${acc.accessToken}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
      if (res.ok) {
        const data = await res.json();
        const payload = data.data || data;
        if (payload.TotalCredits) {
          acc.creditsRemain = Math.round((parseFloat(payload.TotalCredits) || 0) * 100) / 100;
        } else if (Array.isArray(payload.Packages)) {
          let total = 0;
          for (const pkg of payload.Packages) {
            total += parseFloat(pkg.CycleRemainCapacity || 0);
          }
          acc.creditsRemain = Math.round(total * 100) / 100;
        }
        saveAccounts();
      }
    } catch (e) {
      Logger.error('BILLING', `账号 [${acc.uid}] 刷新积分失败: ${e.message}`);
    }
  }

  // 官方同款 Token 续期 (对齐 package: ExternalLinkAuthenticationProvider.refreshSession)
  static async refreshSessionToken(acc) {
    if (!acc.refreshToken) return;
    try {
      const res = await fetch('https://copilot.tencent.com/v2/plugin/auth/token/refresh', {
        method: 'POST',
        headers: {
          'X-Refresh-Token': acc.refreshToken,
          'X-Auth-Refresh-Source': 'plugin',
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
      if (res.ok) {
        const data = await res.json();
        const payload = data.data || data;
        const newAccess = payload.access_token || payload.accessToken;
        if (newAccess) {
          acc.accessToken = newAccess;
          const newRefresh = payload.refresh_token || payload.refreshToken;
          if (newRefresh) acc.refreshToken = newRefresh;
          const expIn = payload.expires_in || payload.expiresIn || 7200;
          acc.expiresAt = Date.now() + expIn * 1000;
          Logger.info('AUTH', `账号 [${acc.email} (${acc.uid})] 官方 Token 自动续期成功 (有效期至: ${new Date(acc.expiresAt).toLocaleTimeString()})`);
          saveAccounts();
        }
      }
    } catch (e) {
      Logger.warn('AUTH', `账号 [${acc.uid}] 官方 Token 续期异常: ${e.message}`);
    }
  }

  static async dailyCheckin(acc) {
    if (!acc.accessToken) return { success: false, msg: '无有效 Token' };
    const today = getTodayString();
    try {
      const res = await fetch(CHECKIN_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${acc.accessToken}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
      const data = await res.json();
      const rawMsg = data.msg || '';
      const isSuccess = data.code === 0 || rawMsg.includes('成功');
      const isAlready = rawMsg.includes('已签到') || rawMsg.includes('明天再来');

      let userMsg = rawMsg;
      if (isSuccess) {
        userMsg = '签到成功，已领积分';
        acc.lastCheckinDate = today;
        acc.lastCheckinMsg = userMsg;
      } else if (isAlready) {
        userMsg = '今天已签到，请明天再来';
        acc.lastCheckinDate = today;
        acc.lastCheckinMsg = userMsg;
      } else if (rawMsg.includes('企业账号')) {
        userMsg = '企业账号不支持签到';
        acc.lastCheckinDate = today;
        acc.lastCheckinMsg = userMsg;
      } else {
        userMsg = rawMsg || '签到失败';
      }

      Logger.info('CHECKIN', `账号 [${acc.email} (${acc.uid})] 签到: ${userMsg}`);
      await this.refreshCredits(acc);
      saveAccounts();
      return { success: isSuccess || isAlready, msg: userMsg };
    } catch (e) {
      Logger.error('CHECKIN', `账号 [${acc.uid}] 签到网络异常: ${e.message}`);
      return { success: false, msg: `网络错误: ${e.message}` };
    }
  }

  // ─── 官方 plans-usage 积分构成明细分析器 ─────────────────────────
  static async getAccountCreditDetails(acc) {
    if (!acc.accessToken) return { error: 'No active token' };

    const headers = {
      'Authorization': `Bearer ${acc.accessToken}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json'
    };

    const allPackageCodes = [
      "TCACA_code_002_AkiJS3ZHF5",
      "TCACA_code_007_nzdH5h4Nl0",
      "TCACA_code_008_cfWoLwvjU4",
      "TCACA_code_009_0XmEQc2xOf",
      "TCACA_code_023_4xbGhMrE6q",
      "TCACA_code_026_BaESVICNoi",
      "TCACA_code_027_0FCGVA6vSa",
      "TCACA_code_028_NtpWi0jzXs",
      "TCACA_code_029_6wCGEWquYy",
      "TCACA_code_030_BjSt89qTvr",
      "TCACA_code_038_OhvqZtiPKr",
      "TCACA_code_043_6oIkxT7Z0S",
      "TCACA_code_044_JRZ9sYCgua",
      "TCACA_code_045_JuyAXGlovx",
      "TCACA_code_046_LfNpbzEa5X"
    ];

    try {
      // 1. 套餐总览
      const resSummary = await fetch(SUMMARY_URL, {
        method: 'POST',
        headers,
        body: '{}'
      });
      const summaryData = (await resSummary.json()).data || {};

      // 2. 免费/活动赠送包明细
      const resFree = await fetch('https://copilot.tencent.com/billing/meter/get-user-resource-free-packages', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          PageNumber: 1,
          PageSize: 200,
          Status: [0, 2, 3],
          PackageCodes: allPackageCodes
        })
      });
      const freeData = (await resFree.json()).data || {};
      const allPackages = freeData.Accounts || [];

      // 3. 购买加量包明细
      let paidPackages = [];
      try {
        const resPaid = await fetch('https://copilot.tencent.com/billing/meter/get-user-resource-paid-packages', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            PageNumber: 1,
            PageSize: 200,
            Status: [0, 2, 3],
            PackageCodes: allPackageCodes
          })
        });
        const paidData = (await resPaid.json()).data || {};
        paidPackages = paidData.Accounts || [];
      } catch (_) {}

      const mergedPackages = [...allPackages, ...paidPackages];
      const activePackages = mergedPackages.filter(p => p.Status === 0);
      const usedUpPackages = mergedPackages.filter(p => p.Status === 3);

      let baseCredits = 0;
      let rewardCredits = 0;
      let paidCredits = 0;

      for (const p of activePackages) {
        const remain = parseFloat(p.CycleCapacityRemainPrecise || p.CapacityRemainPrecise || 0);
        if (p.PackageCode === 'TCACA_code_008_cfWoLwvjU4' || p.PackageName?.includes('体验版') || p.PackageName?.includes('基础')) {
          baseCredits += remain;
        } else if (p.PackageCode?.includes('extra') || paidPackages.some(pp => pp.ResourceId === p.ResourceId)) {
          paidCredits += remain;
        } else {
          rewardCredits += remain;
        }
      }

      // 正在优先扣减中的包 (已消耗过但未耗尽)
      const inUsagePackage = activePackages.find(p => parseFloat(p.CycleCapacityUsedPrecise || 0) > 0) || activePackages[0];

      return {
        totalCredits: parseFloat(summaryData.TotalCredits || (baseCredits + rewardCredits + paidCredits)),
        breakdown: {
          baseCredits: Math.round(baseCredits * 100) / 100,
          paidCredits: Math.round(paidCredits * 100) / 100,
          rewardCredits: Math.round(rewardCredits * 100) / 100
        },
        inUsagePackage: inUsagePackage ? {
          id: inUsagePackage.ResourceId,
          name: inUsagePackage.PackageName,
          grantReason: inUsagePackage.AccountAttributes?.find(a => a.Key === 'grantReason')?.Value || inUsagePackage.PackageName,
          total: parseFloat(inUsagePackage.CycleCapacitySizePrecise || 0),
          remain: parseFloat(inUsagePackage.CycleCapacityRemainPrecise || 0),
          used: parseFloat(inUsagePackage.CycleCapacityUsedPrecise || 0),
          percent: inUsagePackage.CycleCapacitySizePrecise ? Math.round((parseFloat(inUsagePackage.CycleCapacityUsedPrecise || 0) / parseFloat(inUsagePackage.CycleCapacitySizePrecise)) * 100) : 0
        } : null,
        activePackagesCount: activePackages.length,
        usedUpPackagesCount: usedUpPackages.length,
        totalPackagesCount: mergedPackages.length,
        packagesList: activePackages.map(p => ({
          id: p.ResourceId,
          name: p.PackageName,
          grantReason: p.AccountAttributes?.find(a => a.Key === 'grantReason')?.Value || p.PackageName,
          grantSource: p.AccountAttributes?.find(a => a.Key === 'grantSource')?.Value || '-',
          total: parseFloat(p.CycleCapacitySizePrecise || p.CapacitySizePrecise || 0),
          remain: parseFloat(p.CycleCapacityRemainPrecise || p.CapacityRemainPrecise || 0),
          used: parseFloat(p.CycleCapacityUsedPrecise || p.CapacityUsedPrecise || 0),
          startTime: p.CycleStartTime || '-',
          expireTime: p.ExpiredTime || '随月度周期重置'
        }))
      };
    } catch (e) {
      Logger.error('BILLING', `获取账号 [${acc.uid}] 官方积分明细失败: ${e.message}`);
      return { error: e.message };
    }
  }
}
