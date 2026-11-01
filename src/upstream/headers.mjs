import crypto from 'node:crypto';
import { CURRENT_VERSION, USER_AGENT } from '../config.mjs';

// ─── 构造官方全量会话与安全请求头 (对齐 package/dist-server/codebuddy.js:77911 buildConversationHeaders) ─
export function buildOfficialUpstreamHeaders(accessToken, targetModel, sessionKey, uid, isGzip = false) {
  // 对齐官方算法：UUID 去掉短横线，生成标准 32 位无符号 Hex 字符串
  const reqId = crypto.randomUUID().replace(/-/g, '');
  const convReqId = crypto.randomUUID().replace(/-/g, '');
  const sessionId = (sessionKey || crypto.randomUUID()).replace(/-/g, '');
  const messageId = crypto.randomUUID().replace(/-/g, '');

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'X-Request-ID': reqId,
    'X-Conversation-Request-ID': convReqId,
    'X-Conversation-Message-ID': messageId,
    'X-Conversation-ID': sessionId,
    'X-Session-ID': sessionId,
    'X-Agent-Intent': 'craft',
    'X-Agent-Runtime': 'cli',
    'X-Client-Platform': 'cli',
    'X-Client-Version': CURRENT_VERSION,
    'X-Product': 'CodeBuddy',
    'X-Product-Version': CURRENT_VERSION,
    'X-Model-ID': targetModel,
    'X-IDE-Type': 'cli',
    'X-IDE-Name': 'cli',
    'X-IDE-Version': CURRENT_VERSION,
    'X-Private-Data': 'false'
  };

  if (uid) {
    headers['X-User-Id'] = String(uid);
    headers['X-Wb-Uid'] = String(uid);
  }

  if (isGzip) {
    headers['Content-Encoding'] = 'gzip';
  }

  return headers;
}
