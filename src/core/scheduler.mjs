import crypto from 'node:crypto';
import {
  config,
  accounts,
  saveAccounts,
  getTodayString,
  getLocalTimeString,
  endpointsFor,
  resolveAccountRegion,
  normalizeRegion,
  REGION_CN,
  USER_AGENT,
  formatAccountLogName,
  formatAccountFullDesc
} from '../config.mjs';
import { Logger } from './logger.mjs';
import { LogDatabase } from './database.mjs';

// ─── 官方 CLI 常量与时间基准（严格溯源 package/dist/codebuddy-headless.js）───────────
//
// 1. 会话空闲保活 TTL: 3e5 = 300,000 ms (5 分钟)
//    - CLI 源码变量: COMPLETED_TASK_TTL_MS (3e5), DEFAULT_PROMPT_TIMEOUT (3e5), STREAM_SAFE_TIMEOUT_MS (3e5)
//    - 依据与语义: 任务/会话空闲保活超时窗口；同时严格对齐 Anthropic Claude 3.5/3.7 与 OpenAI
//      官方 Prompt Cache 5 分钟保留期，确保同一会话连续调用命中 Prompt 缓存，首字延迟与计算开销大幅降低。
export const CLI_COMPLETED_TASK_TTL_MS = 3e5; // 300,000 ms (5分钟)

// 2. 清理扫描周期: 6e4 = 60,000 ms (1 分钟)
//    - CLI 源码变量: CLEANUP_INTERVAL_MS (6e4), BG_TASK_CLEANUP_INTERVAL_MS (6e4)
//    - 依据与语义: 官方 CLI 定时垃圾回收与过期任务扫描周期。
export const CLI_CLEANUP_INTERVAL_MS = 6e4; // 60,000 ms (1分钟)

// 3. 会话绝对最大存活期: 18e5 = 1,800,000 ms (30 分钟)
//    - CLI 源码变量: PROMPT_TIMEOUT_MS (18e5), DEFAULT_RUN_TIMEOUT_MS (18e5), ACCUMULATOR_TTL_MS (18e5)
//    - 依据与语义: 单一会话/任务全生命周期上限，防止单一会话无限期锁定某个账号，保障账号池均衡。
export const CLI_PROMPT_TIMEOUT_MS = 18e5; // 1,800,000 ms (30分钟)

// ─── 会话粘性映射 (Sticky Session Affinity) ──────────────────────────────────
// 数据结构: sessionKey -> { uid, createdAt, lastActive }
export const sessionStickyMap = new Map();

/**
 * 提取请求对应的会话粘性标识 (Session Key)
 * 优先级：
 *   1. 显式客户端 HTTP 请求头 (x-session-id / x-conversation-id / session-id / conversation-id / x-chat-id / anthropic-conversation-id)
 *   2. 客户端请求体参数 (payload.user / payload.session_id / payload.conversation_id / payload.metadata?.user_id / payload.metadata?.session_id)
 *   3. 会话上下文特征指纹 (基于 System Prompt 与首条 User Message 哈希，确保多轮对话全程指纹稳定且一致)
 *   4. 全新独立会话回落 (随机 UUID v7)
 */
export function extractSessionKey(req, payload) {
  // 1. 显式 Header 判定 (忽略大小写)
  const headers = req?.headers || {};
  const headerKeys = [
    'x-session-id',
    'x-conversation-id',
    'session-id',
    'conversation-id',
    'x-chat-id',
    'anthropic-conversation-id'
  ];
  for (const hk of headerKeys) {
    const val = headers[hk];
    if (val && typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  }

  // 2. 显式 Payload 字段判定
  if (payload && typeof payload === 'object') {
    if (typeof payload.user === 'string' && payload.user.trim()) {
      return payload.user.trim();
    }
    if (typeof payload.session_id === 'string' && payload.session_id.trim()) {
      return payload.session_id.trim();
    }
    if (typeof payload.conversation_id === 'string' && payload.conversation_id.trim()) {
      return payload.conversation_id.trim();
    }
    if (typeof payload.chat_id === 'string' && payload.chat_id.trim()) {
      return payload.chat_id.trim();
    }
    if (payload.metadata && typeof payload.metadata === 'object') {
      const meta = payload.metadata;
      if (typeof meta.user_id === 'string' && meta.user_id.trim()) {
        return meta.user_id.trim();
      }
      if (typeof meta.session_id === 'string' && meta.session_id.trim()) {
        return meta.session_id.trim();
      }
      if (typeof meta.conversation_id === 'string' && meta.conversation_id.trim()) {
        return meta.conversation_id.trim();
      }
    }
  }

  // 3. 上下文首轮消息指纹 (稳定识别多轮对话，避免轮次增长导致哈希突变)
  let sysText = '';
  let firstUser = '';

  // Anthropic 格式的 top-level system
  if (payload?.system) {
    if (typeof payload.system === 'string') {
      sysText = payload.system;
    } else if (Array.isArray(payload.system)) {
      sysText = payload.system.map(s => s.text || '').filter(Boolean).join('\n');
    }
  }

  // 提取消息列表中的 system (若未在上层找到) 与首条 user message
  const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' && !sysText) {
      sysText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    } else if (m.role === 'user' && !firstUser) {
      firstUser = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    }
    if (sysText && firstUser) break;
  }

  if (sysText || firstUser) {
    const seed = (sysText ? 'sys:' + sysText.slice(0, 500) + '|' : '') + (firstUser ? 'user:' + firstUser.slice(0, 500) : '');
    return crypto.createHash('md5').update(seed).digest('hex');
  }

  // 4. 无法提取会话特征的独立请求：回落为随机 UUID
  return crypto.randomUUID();
}

/**
 * 清理过期的会话粘性记录 (按官方 CLI CLEANUP_INTERVAL_MS 周期调度)
 */
export function cleanExpiredSessions() {
  const now = Date.now();
  const idleTtl = (typeof config.stickySessionTtlMs === 'number' && config.stickySessionTtlMs > 0)
    ? config.stickySessionTtlMs
    : CLI_COMPLETED_TASK_TTL_MS;
  const maxLifetime = (typeof config.stickySessionMaxLifetimeMs === 'number' && config.stickySessionMaxLifetimeMs > 0)
    ? config.stickySessionMaxLifetimeMs
    : CLI_PROMPT_TIMEOUT_MS;

  let cleaned = 0;
  for (const [key, val] of sessionStickyMap.entries()) {
    const isIdleExpired = (now - val.lastActive > idleTtl);
    const isLifetimeExpired = val.createdAt && (now - val.createdAt > maxLifetime);
    if (isIdleExpired || isLifetimeExpired) {
      sessionStickyMap.delete(key);
      cleaned++;
    }
  }
  return cleaned;
}

// 启动定时清理扫描器，对齐 CLI 做法调用 unref() 避免挂住进程
const sessionCleanupTimer = setInterval(cleanExpiredSessions, CLI_CLEANUP_INTERVAL_MS);
if (sessionCleanupTimer && typeof sessionCleanupTimer.unref === 'function') {
  sessionCleanupTimer.unref();
}

/**
 * 获取当前会话粘性状态指标
 */
export function getSessionAffinityStats() {
  const now = Date.now();
  const idleTtl = (typeof config.stickySessionTtlMs === 'number' && config.stickySessionTtlMs > 0)
    ? config.stickySessionTtlMs
    : CLI_COMPLETED_TASK_TTL_MS;
  const maxLifetime = (typeof config.stickySessionMaxLifetimeMs === 'number' && config.stickySessionMaxLifetimeMs > 0)
    ? config.stickySessionMaxLifetimeMs
    : CLI_PROMPT_TIMEOUT_MS;

  let activeCount = 0;
  for (const val of sessionStickyMap.values()) {
    if (now - val.lastActive <= idleTtl && (!val.createdAt || (now - val.createdAt <= maxLifetime))) {
      activeCount++;
    }
  }

  return {
    enabled: config.stickySessionEnabled !== false,
    activeSessions: activeCount,
    totalSessions: sessionStickyMap.size,
    idleTtlMs: idleTtl,
    maxLifetimeMs: maxLifetime,
    cleanupIntervalMs: CLI_CLEANUP_INTERVAL_MS,
  };
}

/**
 * 手动清空当前所有会话粘性记录
 */
export function clearSessionStickyMap() {
  const size = sessionStickyMap.size;
  sessionStickyMap.clear();
  return size;
}

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
    // 区域限制：模型名带 cn:/intl: 前缀时，只允许调度该区域的账号
    const forcedRegion = options.region ? normalizeRegion(options.region) : null;
    const regionAllowed = (a) => !forcedRegion || resolveAccountRegion(a) === forcedRegion;

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
        if (!regionAllowed(matched)) {
          restrictedReason = `区域不符 (需要 ${forcedRegion})`;
        } else if (excludeUids.includes(matched.uid)) {
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

    // 2. 会话粘性复用 (Sticky Session，优先复用同账号以最大化命中上游 Prompt Cache)
    const stickyEnabled = config.stickySessionEnabled !== false;
    if (stickyEnabled && sessionKey && sessionStickyMap.has(sessionKey)) {
      const sticky = sessionStickyMap.get(sessionKey);
      const idleTtl = (typeof config.stickySessionTtlMs === 'number' && config.stickySessionTtlMs > 0)
        ? config.stickySessionTtlMs
        : CLI_COMPLETED_TASK_TTL_MS;
      const maxLifetime = (typeof config.stickySessionMaxLifetimeMs === 'number' && config.stickySessionMaxLifetimeMs > 0)
        ? config.stickySessionMaxLifetimeMs
        : CLI_PROMPT_TIMEOUT_MS;

      const isIdleExpired = (now - sticky.lastActive > idleTtl);
      const isLifetimeExpired = sticky.createdAt && (now - sticky.createdAt > maxLifetime);

      if (isIdleExpired || isLifetimeExpired) {
        sessionStickyMap.delete(sessionKey);
      } else if (!excludeUids.includes(sticky.uid)) {
        const acc = accounts.find(a => a.uid === sticky.uid);
        if (acc && regionAllowed(acc) && acc.status === 'healthy' && now > (acc.cooldownUntil || 0) && (acc.inFlight || 0) < maxLimit) {
          const isModelCooling = requestedModel && acc.modelCooldowns?.[requestedModel] && now < acc.modelCooldowns[requestedModel];
          if (!isModelCooling) {
            sticky.lastActive = now;
            const remainingSec = Math.max(0, Math.round((idleTtl - (now - sticky.lastActive)) / 1000));
            Logger.info('DISPATCH', `粘性会话复用账号 [${formatAccountFullDesc(acc)}] (会话: ${sessionKey.slice(0, 8)}, 剩余保活: ${remainingSec}s)`, {
              sessionKey: sessionKey.slice(0, 8),
              model: requestedModel
            });
            this.lastDispatchedUid = acc.uid;
            this.lastDispatchedTime = now;
            return acc;
          }
        } else {
          // 绑定的账号当前受限（例如限流、并发打满、状态异常等），自动解绑以便进行池内选号和重绑
          sessionStickyMap.delete(sessionKey);
          Logger.info('DISPATCH', `粘性会话绑定的账号 [${sticky.uid}] 当前受限或并发饱和，已自动解绑并平滑回落至账号池选号`);
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

      // 区域限制：模型带 cn:/intl: 前缀时只允许对应区域账号
      if (!regionAllowed(a)) return false;

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

    if (sessionKey && stickyEnabled) {
      sessionStickyMap.set(sessionKey, {
        uid: chosen.uid,
        createdAt: now,
        lastActive: now
      });
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
      if (!acc.modelCooldownReasons) acc.modelCooldownReasons = {};
      acc.modelCooldowns[modelId] = Date.now() + seconds * 1000;
      acc.modelCooldownReasons[modelId] = reason || '上游模型限频冷却';
      Logger.warn('COOLDOWN', `账号 [${formatAccountFullDesc(acc)}] 模型 [${modelId}] 局部冷却 ${seconds}秒`, { reason });
      saveAccounts();
    }
  }

  static async refreshCredits(acc) {
    if (!acc.accessToken) return;
    // 检查是否需要根据官方 /v2/plugin/auth/token/refresh 提前换发新令牌 (默认提前 7 天)
    const advanceDays = (typeof config.tokenRefreshAdvanceDays === 'number' && config.tokenRefreshAdvanceDays > 0) ? config.tokenRefreshAdvanceDays : 7;
    const advanceMs = advanceDays * 24 * 60 * 60 * 1000;
    const needsRefresh = acc.refreshToken && (!acc.expiresAt || Date.now() > (acc.expiresAt - advanceMs));

    if (needsRefresh) {
      Logger.info('AUTH', `账号 [${formatAccountFullDesc(acc)}] 满足提前 ${advanceDays} 天换发条件，正在换发新令牌...`);
      await this.refreshSessionToken(acc);
    }
    try {
      // 计费接口按账号所属区域路由：国内版 copilot.tencent.com，
      // 国际版 www.codebuddy.ai。两者路径完全一致，仅域名不同。
      // 原来用的是模块级 SUMMARY_URL 常量（写死国内版），
      // 导致国际版账号的积分请求打错域，一直刷新不到 → 界面显示 0。
      const ep = endpointsFor(acc);
      const res = await fetch(ep.summary, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${acc.accessToken}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json'
        },
        body: '{}',
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) {
        const data = await res.json();
        const payload = data.data || data;
        let newCredits = null;
        if (payload.TotalCredits) {
          newCredits = Math.round((parseFloat(payload.TotalCredits) || 0) * 100) / 100;
        } else if (Array.isArray(payload.Packages)) {
          let total = 0;
          for (const pkg of payload.Packages) {
            total += parseFloat(pkg.CycleRemainCapacity || 0);
          }
          newCredits = Math.round(total * 100) / 100;
        }

        if (newCredits !== null) {
          const prevCredits = typeof acc.creditsRemain === 'number' ? acc.creditsRemain : null;
          acc.creditsRemain = newCredits;
          acc.creditsUpdatedAt = Date.now();

          // [网关自有策略] 积分变动监控留痕：真实查到余额与上次比对，变动即留痕
          if (prevCredits !== null && prevCredits !== newCredits) {
            const delta = Math.round((newCredits - prevCredits) * 100) / 100;
            const fmtPrev = prevCredits.toLocaleString('en-US', { maximumFractionDigits: 2 });
            const fmtNew = newCredits.toLocaleString('en-US', { maximumFractionDigits: 2 });
            const displayName = (acc.note && typeof acc.note === 'string' && acc.note.trim())
              ? acc.note.trim()
              : (acc.email || acc.uid || '未知账号');
            const desc = `余额 ${fmtPrev} → ${fmtNew}`;

            LogDatabase.recordCreditChange({
              accountUid: acc.uid,
              accountName: displayName,
              delta,
              balance: newCredits,
              description: desc
            });

            Logger.info('CREDIT_MONITOR', `账号 [${displayName}] 积分变动: ${delta > 0 ? '+' : ''}${delta} (${desc})`);
          }
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

  /**
   * 按需刷新积分（页面切换 / 手动点刷新时调用）。
   *
   * 目的：定时任务 5 分钟一轮，用户切到账号页看到的是最多 5 分钟前的缓存。
   * 若某账号距上次成功刷新已超过 minAgeMs，就主动拉一次上游。
   *
   * @param {number} minAgeMs 最小间隔，默认 30 秒。
   *   设这个门槛是为了避免用户频繁切页时把上游计费接口打爆。
   * @param {object} opts { force: boolean } force=true 时忽略 minAgeMs 强制刷新
   * @returns {Promise<{refreshed:number, skipped:number}>}
   */
  static async refreshStaleCredits(minAgeMs = 30000, opts = {}) {
    const now = Date.now();
    const force = opts.force === true;
    let refreshed = 0;
    let skipped = 0;
    const tasks = [];

    for (const acc of accounts) {
      if (!acc.accessToken) { skipped++; continue; }
      const last = acc.creditsUpdatedAt || 0;
      if (!force && last > 0 && (now - last) < minAgeMs) { skipped++; continue; }
      tasks.push(
        this.refreshCredits(acc)
          .then(() => { refreshed++; })
          .catch(() => { /* refreshCredits 内部已记录日志 */ })
      );
    }

    if (tasks.length > 0) {
      // 并发拉取（各账号独立，互不影响）
      await Promise.all(tasks);
      Logger.info('BILLING', `按需刷新积分：实际刷新 ${refreshed} 个，跳过 ${skipped} 个（间隔未到或无 token）`);
    }
    return { refreshed, skipped };
  }

  // 官方同款 Token 续期换发 (对齐 package: ExternalLinkAuthenticationProvider.refreshSession)
  static async refreshSessionToken(acc) {
    if (!acc.refreshToken) return { ok: false, msg: '该账号缺少 refreshToken，需重新扫码授权' };
    try {
      // refresh token 按签发域校验，必须打回账号所属区域
      const ep = endpointsFor(acc);
      const res = await fetch(ep.authRefresh, {
        method: 'POST',
        headers: {
          'X-Refresh-Token': acc.refreshToken,
          'X-Auth-Refresh-Source': 'plugin',
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json'
        },
        body: '{}',
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) {
        const data = await res.json();
        const payload = data.data || data;
        const newAccess = payload.access_token || payload.accessToken;
        if (newAccess) {
          acc.accessToken = newAccess;
          const newRefresh = payload.refresh_token || payload.refreshToken;
          if (newRefresh) acc.refreshToken = newRefresh;
          const expIn = payload.expires_in || payload.expiresIn || 2592000;
          acc.expiresAt = Date.now() + expIn * 1000;
          acc.status = 'healthy';
          Logger.info('AUTH', `账号 [${formatAccountFullDesc(acc)}] 官方 Token 提前换发成功！(新有效时间: ${(expIn / 86400).toFixed(1)}天, 有效期至: ${new Date(acc.expiresAt).toLocaleString()})`);
          saveAccounts();
          return {
            ok: true,
            expiresAt: acc.expiresAt,
            expiresIn: expIn,
            msg: `新令牌换发成功，有效期至 ${new Date(acc.expiresAt).toLocaleDateString()}`
          };
        } else {
          return { ok: false, msg: data.msg || '上游返回数据未包含有效 Token' };
        }
      } else {
        const errText = await res.text();
        return { ok: false, msg: `上游返回 HTTP ${res.status}: ${errText}` };
      }
    } catch (e) {
      Logger.warn('AUTH', `账号 [${formatAccountFullDesc(acc)}] 官方 Token 续期异常: ${e.message}`);
      return { ok: false, msg: e.message };
    }
  }

  static async dailyCheckin(acc, force = false) {
    if (!acc.accessToken) return { success: false, msg: '无有效 Token' };

    // 国际版没有签到功能：上游不提供该接口，直接跳过，不打请求也不报错。
    // （实测 www.codebuddy.ai 的 /v2/billing/meter/daily-checkin 返回 401，
    //   且国际版账号体系中本就没有「每日签到领积分」这一机制。）
    if (resolveAccountRegion(acc) !== REGION_CN) {
      return { success: false, skipped: true, unsupported: true, msg: '国际版账号无签到功能' };
    }

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
      const res = await fetch(endpointsFor(acc).checkin, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${acc.accessToken}`,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json'
        },
        body: '{}',
        signal: AbortSignal.timeout(10000)
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
    let unsupportedCount = 0;

    for (const acc of accounts) {
      if (!acc.accessToken || acc.status !== 'healthy') continue;

      // 国际版没有签到机制，轮巡时直接跳过，不产生请求也不写日志噪音
      if (resolveAccountRegion(acc) !== REGION_CN) {
        unsupportedCount++;
        continue;
      }

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

    if (checkedCount > 0 || unsupportedCount > 0) {
      const parts = [];
      if (checkedCount > 0) parts.push(`成功为 ${checkedCount} 个未签到账号完成签到`);
      if (skippedCount > 0) parts.push(`${skippedCount} 个账号今日已签自动跳过`);
      if (unsupportedCount > 0) parts.push(`${unsupportedCount} 个国际版账号无签到功能已跳过`);
      Logger.info('SCHEDULER', `每小时签到巡检：${parts.join('，')}`);
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
      // 计费接口按账号区域选择 base（国际版与国内版路径一致）
      const ep = endpointsFor(acc);
      // 1. 套餐总览
      const resSummary = await fetch(ep.summary, {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(10000)
      });
      const summaryData = (await resSummary.json()).data || {};

      // 2. 免费/活动赠送包明细
      const resFree = await fetch(`${ep.apiBase}/billing/meter/get-user-resource-free-packages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          PageNumber: 1,
          PageSize: 200,
          Status: [0, 2, 3],
          PackageCodes: allPackageCodes
        }),
        signal: AbortSignal.timeout(10000)
      });
      const freeData = (await resFree.json()).data || {};
      const allPackages = freeData.Accounts || [];

      // 3. 购买加量包明细
      let paidPackages = [];
      try {
        const resPaid = await fetch(`${ep.apiBase}/billing/meter/get-user-resource-paid-packages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            PageNumber: 1,
            PageSize: 200,
            Status: [0, 2, 3],
            PackageCodes: allPackageCodes
          }),
          signal: AbortSignal.timeout(10000)
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

  /**
   * 拉取某账号的「积分消耗明细」流水。
   *
   * 接口来源（实测，从官方 Web 前端 config chunk 中提取）：
   *   POST {apiBase}/billing/meter/get-user-request-usage
   *   body: { startTime: 'YYYY-MM-DD HH:mm:ss', endTime: '...', pageNum, pageSize }
   *   头部: Authorization: Bearer <accessToken>
   *   若为企业账号，另需 X-Enterprise-Id
   *
   * 返回结构（实测 data 内层）：
   *   { total: number, data: [{ requestId, credit, model, client,
   *                             requestTime, input, inputTrunc,
   *                             agentPurpose, appType, subscribeType }] }
   *
   * 注意：这是 Web 站点专用接口，CLI 源码里没有（CLI 只上报用量，不查询流水）。
   * 依据是官方 plans-usage 页面实际发出的请求，与 CLI 无关。
   *
   * @param {object} acc   账号
   * @param {object} opts  { days: 时间跨度天数，默认 7；pageNum；pageSize }
   */
  static async getAccountUsageRecords(acc, opts = {}) {
    const days = Number.isFinite(opts.days) ? Math.max(1, Math.min(90, opts.days)) : 7;
    const pageNum = Number.isFinite(opts.pageNum) ? Math.max(1, opts.pageNum) : 1;
    const pageSize = Number.isFinite(opts.pageSize) ? Math.max(1, Math.min(200, opts.pageSize)) : 20;

    const pad = (n) => String(n).padStart(2, '0');
    const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    const now = new Date();
    const from = new Date(now.getTime() - (days - 1) * 86400000);

    const ep = endpointsFor(acc);
    const headers = {
      'Authorization': `Bearer ${acc.accessToken}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    // 企业账号需要带企业 ID 才能查到完整数据
    const entId = acc.enterpriseId?.trim && acc.enterpriseId.trim();
    if (entId) headers['X-Enterprise-Id'] = entId;

    const body = JSON.stringify({
      startTime: `${fmtDate(from)} 00:00:00`,
      endTime: `${fmtDate(now)} 23:59:59`,
      pageNum,
      pageSize,
    });

    try {
      const res = await fetch(`${ep.apiBase}/billing/meter/get-user-request-usage`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(20000),
      });

      const txt = await res.text();
      let payload = null;
      try { payload = JSON.parse(txt); } catch (_) {}

      if (!payload) {
        Logger.warn('BILLING', `账号 [${formatAccountLogName(acc)}] 消耗明细返回非 JSON (HTTP ${res.status})`);
        return { ok: false, error: `返回非 JSON (HTTP ${res.status})`, records: [], total: 0 };
      }
      if (payload.code !== 0) {
        Logger.warn('BILLING', `账号 [${formatAccountLogName(acc)}] 消耗明细查询失败: code=${payload.code} ${payload.msg || ''}`);
        return { ok: false, error: payload.msg || `code ${payload.code}`, records: [], total: 0 };
      }

      const d = payload.data || {};
      const rows = Array.isArray(d.data) ? d.data : (Array.isArray(d) ? d : []);

      const records = rows.map((r) => ({
        requestId: r.requestId || '',
        credit: Number(r.credit) || 0,
        model: r.model || '',
        client: r.client || '',
        // 官方字段名是 requestTime（不是 time/timestamp）
        time: r.requestTime || '',
        // input 是全量提示词，inputTrunc 是截断版；两者都可能缺
        inputFull: r.input || '',
        inputTrunc: r.inputTrunc || r.input || '',
        agentPurpose: r.agentPurpose || '',
        appType: r.appType || '',
        subscribeType: r.subscribeType || '',
      }));

      const totalCredit = Math.round(records.reduce((s, x) => s + x.credit, 0) * 100) / 100;

      return {
        ok: true,
        range: { from: fmtDate(from), to: fmtDate(now), days },
        pageNum,
        pageSize,
        total: Number(d.total) || records.length,
        pageCredit: totalCredit,
        records,
      };
    } catch (e) {
      Logger.error('BILLING', `账号 [${formatAccountLogName(acc)}] 消耗明细请求异常: ${e.message}`);
      return { ok: false, error: e.message, records: [], total: 0 };
    }
  }
}
