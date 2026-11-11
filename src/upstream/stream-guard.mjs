// ─── 流式稳定性保障 ─────────────────────────────────────────────────────────
// 本模块的超时与保活参数**以官方 CLI 端实现为准**（package/dist/codebuddy-headless.js），
// 不做主观拍脑袋取值。对齐依据（源码实测）：
//
//   let mm = 12e5, my = 12e5;
//   let tn = resolveTimeoutMs(process.env.CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS, mm)   // 首 token 20 分钟
//   let eF = resolveTimeoutMs(process.env.CODEBUDDY_STREAM_TIMEOUT_MS, my)        // 流总时长 20 分钟
//   let mb = 3e5                                                                  // 空流重试窗口 5 分钟
//   let tf = 5e3                                                                  // finish_reason 后宽限期 5 秒
//   CODEBUDDY_REASONING_KEEPALIVE_INTERVAL_MS 默认 0（思考期保活默认关闭）
//
// 结论：CLI 端**不会**因为"流里没有 finish_reason"就判错，它只判定
// "有没有实质内容"（hasSubstantiveContent），并且把首 token 超时给到 20 分钟。
// 因此网关侧也必须放宽到同等量级，否则会出现"官方能跑、网关先掐断"的错位。
import { Logger } from '../core/logger.mjs';

// ─── 超时阈值（全部对齐官方 CLI 默认值）─────────────────────────────────────

// 首字节 / 首 token：官方 CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS = 12e5 = 20 分钟。
// 该截止时间在官方实现里同时覆盖"响应头到达"和"首个 token 到达"。
// 环境变量沿用官方命名，便于两边用同一套调参方式。
export const FIRST_BYTE_TIMEOUT_MS = Number(
  process.env.CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS || process.env.GW_FIRST_BYTE_TIMEOUT_MS || 1200000
);

// 流总时长：官方 CODEBUDDY_STREAM_TIMEOUT_MS = 12e5 = 20 分钟。
// 官方是"总时长"上限而非"静默"上限——这与我们原先的静默看门狗语义不同。
// 这里保留静默看门狗（能更早发现真断流），但把阈值对齐到官方的空流重试窗口 5 分钟，
// 超过该窗口官方自己也不再重试，说明可以认为这条流已经废了。
export const STREAM_IDLE_TIMEOUT_MS = Number(
  process.env.GW_STREAM_IDLE_TIMEOUT_MS || process.env.CODEBUDDY_STREAM_TIMEOUT_MS || 300000
);

// 思考期保活：官方 CODEBUDDY_REASONING_KEEPALIVE_INTERVAL_MS **默认 0 = 关闭**。
// 网关侧保留该开关语义，但默认值给 5s —— 因为我们下面还有一层差异：
// 官方 CLI 自己就是 SSE 消费端，它靠 hasSubstantiveContent 判活，不依赖保活帧；
// 而网关的下游可能是 Cursor / Claude Code 等第三方客户端，它们会按"多久没收到事件"判空。
// 若要与官方完全一致，把该环境变量设为 0 即可关闭。
export const HEARTBEAT_INTERVAL_MS = Number(
  process.env.CODEBUDDY_REASONING_KEEPALIVE_INTERVAL_MS || process.env.GW_HEARTBEAT_INTERVAL_MS || 5000
);

// finish_reason 后的宽限期：官方 tf = 5e3。
// 收到 finish_reason 后不立刻关流，留出时间接收 usage 尾帧，避免客户端拿不到 token 统计。
export const FINISH_REASON_GRACE_MS = Number(process.env.GW_FINISH_REASON_GRACE_MS || 5000);

// ─── 请求生命周期 ───────────────────────────────────────────────────────────

/**
 * 创建一次上游请求的生命周期控制器。
 * 组合了：AbortController、首字节超时、客户端断开监听。
 */
export function createUpstreamLifecycle(req, res, label = '') {
  const controller = new AbortController();
  const state = {
    aborted: false,
    reason: null,          // 'client-gone' | 'first-byte-timeout' | 'idle-timeout' | 'error'
    firstByteTimer: null,
    clientGone: false,
    // 上游已把话说完（收到 [DONE] / finish_reason / 读到流尾）：
    // 之后客户端挂断属于正常收尾，不能再算「客户端断开」。
    upstreamEnded: false,
    signal: controller.signal,
  };

  function abort(reason) {
    if (state.aborted) return;
    state.aborted = true;
    state.reason = reason;
    try { controller.abort(); } catch (_) {}
    clearFirstByteTimer();
  }

  function clearFirstByteTimer() {
    if (state.firstByteTimer) {
      clearTimeout(state.firstByteTimer);
      state.firstByteTimer = null;
    }
  }

  // 首字节超时：收到响应头后由 markFirstByte() 清除
  if (FIRST_BYTE_TIMEOUT_MS > 0) {
    state.firstByteTimer = setTimeout(() => {
      Logger.warn('STREAM', `[${label}] 上游首字节超时 (${FIRST_BYTE_TIMEOUT_MS}ms)，已中止请求`);
      abort('first-byte-timeout');
    }, FIRST_BYTE_TIMEOUT_MS);
    state.firstByteTimer.unref?.();
  }

  // 客户端断开检测：只监听 res 的 close。
  // 注意：req 的 'close' 在请求体读完后就会触发（Node 的正常行为），
  // 不能用来判断客户端断开——用它会把每个正常请求都误判为客户端走了。
  const onClientClose = () => {
    if (state.clientGone) return;
    // 正常结束时 close 必然发生，此时不算断开
    if (res.writableEnded || state.finished || state.upstreamEnded) return;
    state.clientGone = true;
    Logger.info('STREAM', `[${label}] 客户端已断开，中止上游请求`);
    abort('client-gone');
  };
  res.on('close', onClientClose);
  const onClientError = (e) => {
    // 客户端写失败（EPIPE / ECONNRESET）：同样视为断开，避免未处理 error 崩进程
    if (!res.writableEnded && !state.finished && !state.upstreamEnded) {
      state.clientGone = true;
      Logger.info('STREAM', `[${label}] 客户端连接异常(${e.code || e.message})，中止上游请求`);
      abort('client-gone');
    }
  };
  res.on('error', onClientError);

  return {
    signal: controller.signal,
    state,
    abort,
    /** 收到响应头时调用：清首字节定时器 */
    markFirstByte() {
      clearFirstByteTimer();
    },
    /** 正常结束：标记完成，后续 res close 不再算客户端断开 */
    markFinished() {
      state.finished = true;
      clearFirstByteTimer();
    },
    /**
     * 上游已经把话说完了（收到 [DONE] / finish_reason / 读到流尾）。
     * 此后客户端挂断属于正常收尾：OpenAI/Anthropic 客户端拿到终态帧就会立刻
     * 关 socket，而我们还可能在等 reader 的 done——不标记这里就会把每次
     * 正常完成都误报成「客户端先断开」。
     */
    markUpstreamEnded() {
      state.upstreamEnded = true;
    },
    /** 上游是否已收尾 */
    isUpstreamEnded() {
      return state.upstreamEnded;
    },
    /** 请求彻底结束时调用：清理所有监听与定时器 */
    dispose() {
      clearFirstByteTimer();
      res.off?.('close', onClientClose);
      res.off?.('error', onClientError);
    },
    /** 是否因客户端断开而中止 */
    isClientGone() {
      return state.reason === 'client-gone';
    },
  };
}

/**
 * 带静默看门狗的 SSE 流读取器。
 * 每读到数据刷新计时；静默超过 STREAM_IDLE_TIMEOUT_MS 就中止上游并抛错。
 *
 * @param {ReadableStreamDefaultReader} reader 上游 body reader
 * @param {object} lifecycle createUpstreamLifecycle 的返回值
 * @param {object} opts { onChunk(str), label, onKeepalive() }
 */
export async function readUpstreamStream(reader, lifecycle, opts = {}) {
  const { onChunk, label = '', onKeepalive } = opts;
  const decoder = new TextDecoder();
  let idleTimer = null;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (STREAM_IDLE_TIMEOUT_MS > 0) {
      idleTimer = setTimeout(() => {
        Logger.warn('STREAM', `[${label}] 上游流静默超过 ${STREAM_IDLE_TIMEOUT_MS}ms，判定断流`);
        lifecycle.state.reason = lifecycle.state.reason || 'idle-timeout';
        lifecycle.abort('idle-timeout');
        if (onKeepalive) { try { onKeepalive(); } catch (_) {} }
      }, STREAM_IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    }
  };

  resetIdle();
  let sawDone = false;
  let lastError = null;

  // 上游「话已说完」的三种标志：SSE [DONE]、非空 finish_reason、message_stop(Anthropic)
  const TERMINAL_RE = /"finish_reason"\s*:\s*"(?!null)|"type"\s*:\s*"message_stop"/;
  const stopOnDone = opts.stopOnDone !== false;
  // [DONE] 可能被切在两个 chunk 之间（"data: [DO" + "NE]"），留一小段尾巴做拼接判断
  let tail = '';
  const DONE_RE = /\[DONE\]/;

  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        lastError = e;
        break;
      }
      if (chunk.done) {
        sawDone = true;
        lifecycle.markUpstreamEnded?.();
        break;
      }
      resetIdle();
      if (chunk.value && chunk.value.length) {
        const str = decoder.decode(chunk.value, { stream: true });
        if (str) {
          const probe = tail + str;
          tail = probe.slice(-12);
          if (DONE_RE.test(probe) || TERMINAL_RE.test(str)) {
            lifecycle.markUpstreamEnded?.();
          }
          onChunk?.(str);
          // 关键：上游发完 [DONE] 后常常不主动关连接（keep-alive 挂着），
          // 客户端拿到终态帧就自己挂断了。继续等 reader.done 会把每次正常
          // 完成都拖成「客户端先断开」。收到 [DONE] 即视为读完。
          if (stopOnDone && DONE_RE.test(probe)) {
            sawDone = true;
            break;
          }
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }

  // 提前收工（收到 [DONE] 主动 break）时，主动释放上游连接，避免 keep-alive 泄漏
  if (sawDone && !lifecycle.state.aborted) {
    try { await reader.cancel(); } catch (_) {}
  }

  return {
    sawDone,
    error: lastError,
    // 上游是否“正常收尾”：读到 done 或收到过 [DONE]
    upstreamEnded: Boolean(lifecycle.state.upstreamEnded),
    aborted: lifecycle.state.aborted,
    abortedByClient: lifecycle.state.reason === 'client-gone',
    abortedByIdle: lifecycle.state.reason === 'idle-timeout',
    abortedByFirstByte: lifecycle.state.reason === 'first-byte-timeout',
  };
}

/**
 * SSE 保活控制器：在长静默期（典型场景是模型长时间思考）向客户端补帧，
 * 防止客户端因为「迟迟收不到内容事件」而判定流异常结束。
 *
 * 为什么不能只发注释帧：`": keepalive"` 是 SSE 传输层的 no-op，多数客户端
 * 解析器会在事件层直接丢弃它，不计入「本流仍然活着」的证据。思考 60s+
 * 时 Claude Code 就会抛 `Stream ended without finish_reason`。
 *
 * 因此这里按协议发**语义合法且内容为空**的真实事件：
 *   · anthropic → `event: ping`（官方心跳事件，所有 Anthropic 客户端都认）
 *   · openai    → `data: {choices:[{delta:{},finish_reason:null}]}` 空 delta chunk
 * 两者都不会污染正文，也不会让客户端误以为收到了内容。
 *
 * @param {object} res        下游响应对象
 * @param {string} label      日志标签
 * @param {object} opts       { protocol: 'openai'|'anthropic', getMeta(): {id, model} }
 */
export function startHeartbeat(res, label = '', opts = {}) {
  if (HEARTBEAT_INTERVAL_MS <= 0) {
    return { stop() {}, touch() {} };
  }
  const protocol = opts.protocol === 'anthropic' ? 'anthropic' : 'openai';
  const getMeta = typeof opts.getMeta === 'function' ? opts.getMeta : () => ({});
  let lastWrite = Date.now();
  let pingCount = 0;

  /** 构造一个客户端可识别、但不产生任何内容的保活帧 */
  const buildKeepaliveFrame = () => {
    if (protocol === 'anthropic') {
      // Anthropic 官方心跳事件；客户端收到后只更新活跃时间，不产出内容块
      return 'event: ping\ndata: {"type": "ping"}\n\n';
    }
    // OpenAI：空 delta + finish_reason:null，等价于「流仍在继续，暂无内容」
    const meta = getMeta() || {};
    const id = meta.id || `chatcmpl-keepalive-${Date.now()}`;
    const model = meta.model || 'unknown';
    return `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: null }],
    })}\n\n`;
  };

  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    // 距上次真实写入不足间隔就不补，避免与数据帧叠加
    if (Date.now() - lastWrite < HEARTBEAT_INTERVAL_MS) return;
    try {
      res.write(buildKeepaliveFrame());
      lastWrite = Date.now();
      pingCount++;
    } catch (_) {}
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return {
    /**
     * 告知「刚有内容真正写给了客户端」。
     * 注意：调用方只能在**真的向 res 写入语义内容**后调用它，
     * 不能在上游 chunk 到达时就调——思考型模型在上游持续吐 reasoning
     * 但被适配层丢弃时，会把计时器一直刷掉，导致保活帧永远不发出。
     */
    touch() { lastWrite = Date.now(); },
    /** 已发送的保活帧数量（用于诊断长思考请求） */
    get pingCount() { return pingCount; },
    /** 距上次真实写入的毫秒数（诊断用） */
    get idleMs() { return Date.now() - lastWrite; },
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * ─── 空流判定（完全移植自官方 CLI 端）───────────────────────────────────────
 *
 * 官方 CLI 在 ModelProvider 里对每个 delta 做三标志分类：
 *
 *   let eA = typeof ec.content === "string" && ec.content.length > 0;              // 正文
 *   let ed = reason_content 非空 || reasoning 非空;                                // 思考
 *   let eu = Array.isArray(ec.tool_calls) && ec.tool_calls.length > 0;             // 工具
 *   let ep = typeof ec.refusal === "string" && ec.refusal.length > 0;              // 拒答
 *   ed && (ef = !0);                    // hasReasoning            —— 仅思考
 *   (eA || ed || eu || ep) && (eg = !0); // hasContent              —— 思考也算"有内容"
 *   (eA || eu || ep) && (em = !0);       // hasSubstantiveContent   —— 思考**不算**实质内容
 *
 * 随后按 hasReasoning 把空流分成两类：
 *   let el = eg ? "reasoning-only" : "no-token";
 *
 * 这里用同样的语义累积统计，供适配层判断"这次流到底有没有实质产出"。
 */
export function createDeltaClassifier() {
  let hasContent = false;             // 任何产出（含 reasoning）
  let hasReasoning = false;           // 仅有 reasoning
  let hasSubstantiveContent = false;  // 正文 / 工具 / 拒答
  let sawFinishReason = null;         // 最后一次非空 finish_reason
  let hasUsage = false;

  return {
    /** 传入上游 SSE 解析后的 chunk.choices[0].delta */
    observeDelta(delta, finishReason) {
      if (typeof finishReason === 'string' && finishReason !== '') {
        sawFinishReason = finishReason;
      }
      if (!delta) return;
      const hasText = typeof delta.content === 'string' && delta.content.length > 0;
      const hasThink = (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0)
        || (typeof delta.reasoning === 'string' && delta.reasoning.length > 0);
      const hasTool = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
      const hasRefusal = typeof delta.refusal === 'string' && delta.refusal.length > 0;

      if (hasThink) hasReasoning = true;
      if (hasText || hasThink || hasTool || hasRefusal) hasContent = true;
      if (hasText || hasTool || hasRefusal) hasSubstantiveContent = true;
    },
    observeUsage(usage) {
      if (usage) hasUsage = true;
    },
    get hasContent() { return hasContent; },
    get hasReasoning() { return hasReasoning; },
    get hasSubstantiveContent() { return hasSubstantiveContent; },
    get finishReason() { return sawFinishReason; },
    get hasUsage() { return hasUsage; },

    /**
     * 按官方语义给出空流子类型：
     *   · 'reasoning-only' —— 思考过但没正文/工具
     *   · 'no-token'       —— 连思考都没有
     *   · null             —— 有实质产出，不算空流
     */
    get emptyStreamKind() {
      if (hasSubstantiveContent) return null;
      return hasReasoning ? 'reasoning-only' : 'no-token';
    },
  };
}

/**
 * 判断一段流是否"无正常收尾"。
 *
 * 与官方 CLI 对齐后：官方**不把"缺少 finish_reason"本身当错误**，
 * 它只关心有没有实质内容。因此这里保留原有签名（供适配层兜底补终态），
 * 但增加实质内容判定——只要出过正文/工具/拒答，就属于"正常有产出但被截断"，
 * 应补 finish_reason=length；完全没产出才是真正的空流。
 */
export function isTruncatedWithoutFinish({ sawDone, sawFinish, sawError }) {
  return !sawDone && !sawFinish && !sawError;
}

/**
 * 空流终态：对齐官方 `finish_reason=${ec} with no model output` 的语义。
 * 官方在 failEmptyStream 里把 finish_reason 归一为 'length' 或 'error'：
 *   let ec = "length" === e8 ? "length" : "error";
 * 这里保持一致，让客户端能区分"被截断"与"模型没输出"。
 */
export function buildEmptyStreamChunk(id, model, kind = 'no-token') {
  return JSON.stringify({
    id: id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    model: model || 'unknown',
    choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
    // 非标准字段，供排查；主流客户端会忽略未知字段
    x_empty_stream_kind: kind,
  });
}

/**
 * 生成截断终态帧（finish_reason=length），让客户端知道是截断而非卡死。
 * 仅在“有真实产出”时补——零输出段补终态会把空流伪装成有内容的 200。
 */
export function buildTruncationChunk(id, model) {
  return JSON.stringify({
    id: id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    model: model || 'unknown',
    choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
  });
}

/**
 * 统一日志：把流结束的归因写清楚，避免把客户端断开误报成上游故障。
 */
export function logStreamOutcome(label, result, extra = {}) {
  const { abortedByClient, abortedByIdle, abortedByFirstByte, sawDone, error, upstreamEnded } = result;
  // 上游已收尾（[DONE] / finish_reason / 流尾）后客户端挂断是正常收尾，静默处理
  if (upstreamEnded && !abortedByIdle && !abortedByFirstByte) {
    return;
  }
  if (abortedByClient) {
    Logger.info('STREAM', `[${label}] 客户端先断开，上游随之取消（非上游故障）${fmtExtra(extra)}`);
  } else if (abortedByFirstByte) {
    Logger.warn('STREAM', `[${label}] 首字节超时终止${fmtExtra(extra)}`);
  } else if (abortedByIdle) {
    Logger.warn('STREAM', `[${label}] 流静默超时终止（疑似上游断流）${fmtExtra(extra)}`);
  } else if (!sawDone && error) {
    Logger.warn('STREAM', `[${label}] 上游断流: ${error.message}${fmtExtra(extra)}`);
  }
}

function fmtExtra(extra) {
  const parts = Object.entries(extra)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}
