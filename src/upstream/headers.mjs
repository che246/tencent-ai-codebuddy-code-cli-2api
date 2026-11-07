import crypto from 'node:crypto';
import { CURRENT_VERSION, USER_AGENT } from '../config.mjs';

// ─── 构造官方全量会话与安全请求头 ───────────────────────────────────────────
// 对齐实测抓包（CLI 2.177.1 / 2.179.0 → POST /v2/chat/completions）：
//   官方仅发送 38 个应用层头，不发送 X-Session-ID / X-Wb-Uid / X-Model-ID /
//   X-Client-Platform / X-Client-Version / X-Product-Version，此处保持一致。
export function buildOfficialUpstreamHeaders(accessToken, targetModel, sessionKey, uid, isGzip = false) {
  // 对齐官方算法：UUID 去掉短横线，生成标准 32 位无符号 Hex 字符串
  const reqId = crypto.randomUUID().replace(/-/g, '');
  const convReqId = crypto.randomUUID().replace(/-/g, '');
  const sessionId = (sessionKey || crypto.randomUUID()).replace(/-/g, '');
  // 官方实测：X-Conversation-Message-ID 与 X-Request-ID 为同一个值
  const messageId = reqId;

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
    // 官方实测：即使 stream:true，Accept 也是 application/json（流式靠 body 的 stream 参数协商）
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Request-ID': reqId,
    'X-Conversation-Request-ID': convReqId,
    'X-Conversation-Message-ID': messageId,
    'X-Conversation-ID': sessionId,
    'X-Root-Request-Id': convReqId,
    'X-Agent-Intent': 'craft',
    'X-Agent-Runtime': 'other',
    'X-Agent-Purpose': 'conversation',
    'X-Agent-Type': 'main',
    'X-CodeBuddy-Request': '1',
    'X-Product': 'SaaS',
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'X-IDE-Version': CURRENT_VERSION,
    'X-Private-Data': 'false'
  };

  if (uid) {
    headers['X-User-Id'] = String(uid);
  }

  if (isGzip) {
    headers['Content-Encoding'] = 'gzip';
  }

  return headers;
}
