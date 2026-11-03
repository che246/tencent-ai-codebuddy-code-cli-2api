import {
  config,
  accounts,
  saveAccounts,
  getTodayString,
  getLocalTimeString,
  SUMMARY_URL,
  CHECKIN_URL,
  USER_AGENT,
  formatAccountLogName,
  formatAccountFullDesc
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
  static rrIndex = 0;
  static lastDispatchedUid = null;
  static lastDispatchedTime = 0;

  static selectAccount(requestedModel, sessionKey, options = {}) {
    const now = Date.now();
    const maxLimit = config.concurrencyLimitEnabled !== false ? (config.maxInFlightPerAccount || 3) : 9999;
    const excludeUids = Array.isArray(options.excludeUids) ? options.excludeUids : [];
    const strategy = options.strategy || config.routingStrategy || 'least-inflight';

    // 1. 优先检查：网关侧全局指定账号 (config.pinnedAccount)
    if (config.pinnedAccount) {
      const target = String(config.pinnedAccount).trim().toLowerCase();
      const matched = accounts.find(a => 
        (a.uid && a.uid.toLowerCase() === target) ||
        (a.uin && String(a.uin).toLowerCase() === target) ||
        (a.email && a.email.toLowerCase() === target) ||
        (a.note && a.note.toLowerCase().includes(target))
      );

      if (matched) {
        let restrictedReason = null;
        if (excludeUids.includes(matched.uid)) {
          restrictedReason = '本轮重试已尝试过';
        } else if (matched.status !== 'healthy') {
          restrictedReason = `状态异常 (${matched.status})`;
        } else if (now < (matched.cooldownUntil || 0)) {
          restrictedReason = `处于全局冷却期 (剩 ${Math.ceil((matched.cooldownUntil - now) / 1000)}秒)`;
        } else if (requestedModel && matched.modelCooldowns?.[requestedModel] && now < matched.modelCooldowns[requestedModel]) {
          restrictedReason = `模型 [${requestedModel}] 处于限流冷却中 (剩 ${Math.ceil((matched.modelCooldowns[requestedModel] - now) / 1000)}秒)`;
        } else if (config.concurrencyLimitEnabled !== false && (matched.inFlight || 0) >= maxLimit) {
          restrictedReason = `并发达到上限 (${matched.inFlight}/${maxLimit})`;
        }

        if (restrictedReason) {
          Logger.warn('DISPATCH', `全局指定账号 [${formatAccountLogName(matched)}] 受到限制 (${restrictedReason})，已自动切换回账号池动态轮换`);
        } else {
          Logger.info('DISPATCH', `精准路由至网关全局指定账号 [${formatAccountFullDesc(matched)}]`);
          this.lastDispatchedUid = matched.uid;
          this.lastDispatchedTime = now;
          return matched;
        }
      } else {
        Logger.warn('DISPATCH', `未找到全局指定账号 [${target}]，自动切换至账号池调度`);
      }
    }

    // 2. 会话粘性复用 (Sticky Session)
    if (sessionKey && sessionStickyMap.has(sessionKey)) {
      const sticky = sessionStickyMap.get(sessionKey);
      if (!excludeUids.includes(sticky.uid)) {
        const acc = accounts.find(a => a.uid === sticky.uid);
        if (acc && acc.status === 'healthy' && now > (acc.cooldownUntil || 0) && (acc.inFlight || 0) < maxLimit) {
          const isModelCooling = requestedModel && acc.modelCooldowns?.[requestedModel] && now < acc.modelCooldowns[requestedModel];
          if (!isModelCooling) {
            sticky.lastActive = now;
            Logger.info('DISPATCH', `粘性会话复用账号 [${formatAccountFullDesc(acc)}]`, { sessionKey: sessionKey.slice(0, 8), model: requestedModel });
            this.lastDispatchedUid = acc.uid;
            this.lastDispatchedTime = now;
            return acc;
          }
        }
      }
    }

    // 3. 候选池过滤
    const candidates = accounts.filter(a => {
      if (a.status !== 'healthy') return false;

      // 自动清理已过期的全局冷却时间戳
      if (a.cooldownUntil && now >= a.cooldownUntil) {
        a.cooldownUntil = 0;
      }
      if (a.cooldownUntil && now < a.cooldownUntil) return false;

      if (excludeUids.includes(a.uid)) return false;

      // 自动清理已过期的单模型局部冷却时间戳
      if (requestedModel && a.modelCooldowns) {
        if (a.modelCooldowns[requestedModel] && now >= a.modelCooldowns[requestedModel]) {
          delete a.modelCooldowns[requestedModel];
        } else if (a.modelCooldowns[requestedModel] && now < a.modelCooldowns[requestedModel]) {
          return false;
        }
      }

      // 单账号限流保护开关：开启时限制并发，关闭时不设上限
      if (config.concurrencyLimitEnabled !== false) {
        if ((a.inFlight || 0) >= maxLimit) return false;
      }
      return true;
    });

    if (candidates.length === 0) return null;

    // 4. 按策略选号 (支持 round-robin 顺序轮换 / least-inflight 最小并发 / credits 积分最多)
    let chosen = null;
    if (strategy === 'round-robin') {
      AccountScheduler.rrIndex = (AccountScheduler.rrIndex || 0) % candidates.length;
      chosen = candidates[AccountScheduler.rrIndex];
      AccountScheduler.rrIndex = (AccountScheduler.rrIndex + 1) % candidates.length;
    } else if (strategy === 'credits') {
      candidates.sort((a, b) => (b.creditsRemain || 0) - (a.creditsRemain || 0));
      chosen = candidates[0];
    } else {
      // 默认 least-inflight: 最小并发优先，相同时按积分从高到低
      candidates.sort((a, b) => {
        if ((a.inFlight || 0) !== (b.inFlight || 0)) {
          return (a.inFlight || 0) - (b.inFlight || 0);
        }
        return (b.creditsRemain || 0) - (a.creditsRemain || 0);
      });
      chosen = candidates[0];
    }

    if (sessionKey) {
      sessionStickyMap.set(sessionKey, { uid: chosen.uid, lastActive: now });
    }
    Logger.info('DISPATCH', `调度选中账号 [${formatAccountFullDesc(chosen)}] (策略: ${strategy}, 并发: ${chosen.inFlight || 0}, 剩余积分: ${chosen.creditsRemain || 0})`, { model: requestedModel });
    this.lastDispatchedUid = chosen.uid;
    this.lastDispatchedTime = now;
    return chosen;
  }

  // 获取当前正在/默认使用的账号实体快照 (供控制台报表统计概览展示)
  static getCurrentActiveAccountInfo() {
    const now = Date.now();
    const isPinned = Boolean(config.pinnedAccount);
    const target = isPinned ? String(config.pinnedAccount).trim().toLowerCase() : '';
    const pinnedAcc = isPinned ? accounts.find(a => 
      (a.uid && a.uid.toLowerCase() === target) ||
      (a.uin && String(a.uin).toLowerCase() === target) ||
      (a.email && a.email.toLowerCase() === target) ||
      (a.note && a.note.toLowerCase().includes(target))
    ) : null;

    let activeAcc = null;
    let mode = 'pool';
    let modeLabel = '账号池自动轮换';
    let pinnedRestricted = false;
    let restrictedReason = '';

    if (pinnedAcc) {
      if (pinnedAcc.status !== 'healthy') {
        pinnedRestricted = true;
        restrictedReason = `状态异常 (${pinnedAcc.status})`;
      } else if (pinnedAcc.cooldownUntil && now < pinnedAcc.cooldownUntil) {
        pinnedRestricted = true;
        restrictedReason = `全局冷却期 (剩 ${Math.ceil((pinnedAcc.cooldownUntil - now) / 1000)}秒)`;
      } else if (pinnedAcc.modelCooldowns && Object.values(pinnedAcc.modelCooldowns).some(exp => now < exp)) {
        pinnedRestricted = true;
        restrictedReason = `部分模型限流冷却中`;
      }

      if (!pinnedRestricted) {
        activeAcc = pinnedAcc;
        mode = 'pinned';
        modeLabel = '全局指定账号 (服务中)';
      } else {
        // 全局指定账号遇到限制，自动切换回池动态轮换！
        mode = 'pool';
        modeLabel = `账号池动态轮换 (指定账号受限: ${restrictedReason})`;
      }
    }

    if (!activeAcc && this.lastDispatchedUid) {
      activeAcc = accounts.find(a => a.uid === this.lastDispatchedUid && a.status === 'healthy');
      if (activeAcc && !modeLabel.includes('指定账号受限')) {
        modeLabel = '账号池调度 (最近执行)';
      }
    }

    if (!activeAcc && accounts.length > 0) {
      const candidates = accounts.filter(a => a.status === 'healthy' && now > (a.cooldownUntil || 0));
      activeAcc = candidates[0] || accounts[0];
      if (!modeLabel.includes('指定账号受限')) {
        modeLabel = '账号池调度 (当前就绪)';
      }
    }

    if (!activeAcc) {
      return {
        hasAccount: false,
        isPinned: false,
        pinnedRestricted: false,
        mode: 'none',
        modeLabel: '暂无可用账号',
        displayName: '暂无账号',
        name: '暂无账号',
        note: '',
        uid: '',
        creditsRemain: 0,
        inFlight: 0,
        status: 'none'
      };
    }

    const noteStr = activeAcc.note ? activeAcc.note.trim() : '';
    const nameStr = activeAcc.email || activeAcc.uid;
    const fullDisplayName = noteStr ? `${nameStr} [${noteStr}]` : nameStr;

    return {
      hasAccount: true,
      isPinned,
      pinnedRestricted,
      restrictedReason,
      pinnedAccountName: pinnedAcc ? (pinnedAcc.note ? `${pinnedAcc.email || pinnedAcc.uid} [${pinnedAcc.note}]` : (pinnedAcc.email || pinnedAcc.uid)) : '',
      mode,
      modeLabel,
      uid: activeAcc.uid,
      name: nameStr,
      note: noteStr,
      displayName: fullDisplayName,
      creditsRemain: activeAcc.creditsRemain || 0,
      inFlight: activeAcc.inFlight || 0,
      status: activeAcc.status || 'healthy',
      isCooldown: now < (activeAcc.cooldownUntil || 0),
      strategy: config.routingStrategy || 'least-inflight'
    };
  }

  static cooldown(uid, seconds, reason = '') {
    const acc = accounts.find(a => a.uid === uid);
    if (acc) {
      acc.cooldownUntil = Date.now() + seconds * 1000;
      Logger.warn('COOLDOWN', `账号 [${formatAccountFullDesc(acc)}] 全局冷却 ${seconds}秒`, { reason });
      saveAccounts();
    }
  }

  static cooldownModel(uid, modelId, seconds = 600, reason = '') {
    const acc = accounts.find(a => a.uid === uid);
    if (acc) {
      if (!acc.modelCooldowns) acc.modelCooldowns = {};
      acc.modelCooldowns[modelId] = Date.now() + seconds * 1000;
      Logger.warn('COOLDOWN', `账号 [${formatAccountFullDesc(acc)}] 模型 [${modelId}] 局部冷却 ${seconds}秒`, { reason });
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

        // 积分已刷新充盈时，自动提前解除因 402/额度耗尽进入的全局冷却状态
        if (acc.creditsRemain > 0 && acc.cooldownUntil && acc.cooldownUntil > Date.now()) {
          acc.cooldownUntil = 0;
          Logger.info('COOLDOWN', `账号 [${formatAccountFullDesc(acc)}] 积分已刷新充盈 (${acc.creditsRemain})，提前解除冷却状态`);
        }

        // 清理已过期的单模型局部冷却记录
        if (acc.modelCooldowns) {
          const nowTime = Date.now();
          for (const [mId, expireAt] of Object.entries(acc.modelCooldowns)) {
            if (nowTime >= expireAt) delete acc.modelCooldowns[mId];
          }
        }

        saveAccounts();
      }
    } catch (e) {
      Logger.error('BILLING', `账号 [${formatAccountFullDesc(acc)}] 刷新积分失败: ${e.message}`);
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
          Logger.info('AUTH', `账号 [${formatAccountFullDesc(acc)}] 官方 Token 自动续期成功 (有效期至: ${new Date(acc.expiresAt).toLocaleTimeString()})`);
          saveAccounts();
        }
      }
    } catch (e) {
      Logger.warn('AUTH', `账号 [${formatAccountFullDesc(acc)}] 官方 Token 续期异常: ${e.message}`);
    }
  }

  static async dailyCheckin(acc, force = false) {
    if (!acc.accessToken) return { success: false, msg: '无有效 Token' };
    const today = getTodayString();

    // 1. 前置状态判断：当天若已成功签到且非强制，则直接返回已签到状态，避免频繁重复调用上游
    const isAlreadyDoneToday = acc.lastCheckinDate === today && (acc.lastCheckinSuccess || acc.lastCheckinMsg?.includes('已签到') || acc.lastCheckinMsg?.includes('成功'));
    if (!force && isAlreadyDoneToday) {
      return {
        success: true,
        alreadyCheckedIn: true,
        msg: acc.lastCheckinMsg || '今天已签到，请明天再来'
      };
    }

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
        acc.lastCheckinSuccess = true;
        acc.lastCheckinTime = getLocalTimeString();
        acc.lastCheckinMsg = userMsg;
      } else if (isAlready) {
        userMsg = '今天已签到，请明天再来';
        acc.lastCheckinDate = today;
        acc.lastCheckinSuccess = true;
        acc.lastCheckinTime = getLocalTimeString();
        acc.lastCheckinMsg = userMsg;
      } else if (rawMsg.includes('企业账号')) {
        userMsg = '企业账号不支持签到';
        acc.lastCheckinDate = today;
        acc.lastCheckinSuccess = false;
        acc.lastCheckinTime = getLocalTimeString();
        acc.lastCheckinMsg = userMsg;
      } else {
        userMsg = rawMsg || '签到失败';
        acc.lastCheckinSuccess = false;
      }

      Logger.info('CHECKIN', `账号 [${formatAccountFullDesc(acc)}] 签到: ${userMsg}`);
      await this.refreshCredits(acc);
      saveAccounts();
      return { success: isSuccess || isAlready, msg: userMsg };
    } catch (e) {
      Logger.error('CHECKIN', `账号 [${formatAccountFullDesc(acc)}] 签到网络异常: ${e.message}`);
      return { success: false, msg: `网络错误: ${e.message}` };
    }
  }

  // 每小时定时轮巡检测：前置过滤当天已签到的账号，未签到的账号或进入新一天时自动补签
  static async checkAndRunHourlyCheckin(force = false) {
    const today = getTodayString();
    let checkedCount = 0;
    let skippedCount = 0;

    for (const acc of accounts) {
      if (!acc.accessToken || acc.status !== 'healthy') continue;

      // 检查当天签到状态：如果当天已完成，则跳过，直至次日零点跨天后再检测
      const isAlreadyDoneToday = acc.lastCheckinDate === today && (acc.lastCheckinSuccess || acc.lastCheckinMsg?.includes('已签到') || acc.lastCheckinMsg?.includes('成功'));
      if (!force && isAlreadyDoneToday) {
        skippedCount++;
        continue;
      }

      // 未签到或已跨入新的一天，进行签到
      const res = await this.dailyCheckin(acc, force);
      if (res.success) checkedCount++;
    }

    if (checkedCount > 0) {
      Logger.info('SCHEDULER', `每小时签到巡检：成功为 ${checkedCount} 个未签到账号完成签到，${skippedCount} 个账号今日已签自动跳过`);
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
