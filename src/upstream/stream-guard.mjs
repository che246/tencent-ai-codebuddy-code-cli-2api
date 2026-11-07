// ─── 流式稳定性保障 ─────────────────────────────────────────────────────────
// 六项防护，对齐真机实测过的生产实现（workbuddy2api-panel）：
//   1. 上游请求 AbortController + 静默看门狗（有数据就续命，不按总时长误杀）
//   2. inFlight 用 finally 保证释放（杜绝账号容量泄漏）
//   3. 客户端断开感知，中止上游并区分归因（客户端走了 vs 上游断流）
//   4. SSE 注释帧心跳，防中间设备/客户端 idle 超时掐线
//   5. 首字节（响应头）超时，与流中静默超时分离
//   6. 上游断流补截断终态帧（finish_reason=length），让客户端知悉是截断而非卡死
import { Logger } from '../core/logger.mjs';

// ─── 超时阈值 ───────────────────────────────────────────────────────────────
// 首字节：从发出请求到收到响应头。上游正常在 1~3s 内响应，30s 足够宽松。
export const FIRST_BYTE_TIMEOUT_MS = Number(process.env.GW_FIRST_BYTE_TIMEOUT_MS || 30000);

// 流中静默：收到响应头后，相邻两个数据块的间隔上限。
// 长回复可能持续数分钟，但**静默**不该超过这个值；有数据流动就自动续命。
//
// 注意：思考型模型（deepseek/hy4 的 reasoning）在"想"的时候上游可能长时间
// 一个字节都不吐，实测出现过 240s+ 的单轮思考。原来的 90s 会把这类请求
// 从网关侧掐断，客户端看到的就是"流结束了却没有 finish_reason"。
// 因此把默认值抬到 300s，并把主动保活（见 startHeartbeat）作为第一道防线：
// 只要保活帧在发，客户端就不会判空，网关也不会因为上游静默而误杀。
export const STREAM_IDLE_TIMEOUT_MS = Number(process.env.GW_STREAM_IDLE_TIMEOUT_MS || 300000);

// 心跳间隔：客户端能感知的保活帧间隔。
// 取 5s——比多数客户端（Claude Code / Cursor / NextChat）的空流容忍窗口
// 都要短。原来的 10s 注释帧在长思考场景下会被部分客户端忽略并判空。
export const HEARTBEAT_INTERVAL_MS = Number(process.env.GW_HEARTBEAT_INTERVAL_MS || 5000);

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
    if (res.writableEnded || res.destroyed) return;
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
 * 判断一段流是否“无正常收尾”（上游断流）：既没有 finish_reason，
 * 也没有收到 [DONE]，且不是显式 error 帧。
 */
export function isTruncatedWithoutFinish({ sawDone, sawFinish, sawError }) {
  return !sawDone && !sawFinish && !sawError;
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
