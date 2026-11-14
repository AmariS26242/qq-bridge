// 断线补拉（纯函数，不依赖 bridge）。
//
// 背景：SnowLuma WS 平均每 3–8 分钟断一次（code=1006）；DSH 重启也会掐断事件流。
// 重连后旧实现只清理「僵尸回合」，断线期间用户发的消息不会补拉，等于永久丢失。
//
// 这里只负责两件事：
//   1. 把 OneBot `get_group_msg_history` / `get_friend_msg_history` 的返回解析成统一结构；
//   2. 根据「最后见到的消息 / 时间 / 已见 id」筛出真正需要补记的消息。
// 真正的 OneBot 请求与入账/唤醒由 bridge.js 调用既有路径完成。
export const CATCH_UP_DEFAULTS = Object.freeze({
  maxCount: 50,           // 每次最多补 50 条
  maxConversations: 5,    // 重连后最多补 5 个最近活跃会话
  totalTimeoutMs: 10_000, // 补拉总耗时上限
  perCallTimeoutMs: 4_000,// 单次 OneBot 历史请求上限
  cooldownMs: 60_000,     // 同一会话两次补拉的最小间隔
  historyCount: 50        // 请求历史时的 count
});

/** OneBot 的 time 是秒；某些实现会给毫秒。统一成毫秒。 */
export function oneBotTimeToMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

function stripCqCodes(input) {
  return String(input ?? '').replace(/\[CQ:[^\]]*\]/g, '').trim();
}

function textFromSegments(message) {
  if (typeof message === 'string') {
    const raw = stripCqCodes(message);
    return raw || String(message).trim();
  }
  if (!Array.isArray(message)) return '';
  const parts = [];
  for (const seg of message) {
    if (seg && seg.type === 'text' && seg.data && typeof seg.data.text === 'string') {
      parts.push(seg.data.text);
    }
  }
  return parts.join('').trim();
}

/**
 * 解析 OneBot 历史消息返回。
 * 兼容 `{status,retcode,data:{messages:[...]}}`、`{messages:[...]}` 与裸数组；
 * 字段兼容 message_id/messageId、time/at、sender.user_id/sender_id、sender.card/nickname/sender_name。
 *
 * @param {any} payload
 * @param {{selfId?:string|number}} [options]
 * @returns {Array<{messageId:string,at:number,senderId:string,senderName:string,text:string,isSelf:boolean,raw:any}>}
 */
export function parseOneBotHistory(payload, options = {}) {
  const rows = Array.isArray(payload?.data?.messages)
    ? payload.data.messages
    : Array.isArray(payload?.messages)
      ? payload.messages
      : Array.isArray(payload)
        ? payload
        : [];
  // 未显式给 selfId 时，兼容 OneBot 信封自带的 self_id，避免第一轮补拉把自己的消息当用户消息。
  const selfId = options.selfId != null
    ? String(options.selfId)
    : String(payload?.self_id ?? payload?.data?.self_id ?? '');
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const messageId = row.message_id ?? row.messageId ?? row.id ?? null;
    const at = oneBotTimeToMs(row.time ?? row.at ?? 0);
    const senderId = row.sender?.user_id ?? row.sender_id ?? row.user_id ?? row.senderId ?? null;
    const senderName = row.sender?.card
      || row.sender?.nickname
      || row.sender_name
      || row.senderName
      || (senderId != null ? String(senderId) : '');
    const segmentText = textFromSegments(row.message);
    const text = segmentText || stripCqCodes(row.raw_message ?? row.rawMessage ?? '');
    const idText = messageId != null ? String(messageId) : '';
    const isSelf = selfId !== '' && senderId != null && String(senderId) === selfId;
    if (!idText && !text) continue;
    out.push({
      messageId: idText,
      at,
      senderId: senderId != null ? String(senderId) : '',
      senderName: String(senderName || ''),
      text: text.slice(0, 200),
      isSelf,
      raw: row
    });
  }
  return out;
}

/**
 * 从历史消息里筛出需要补记的部分。
 *
 * 过滤规则：
 *   - 没有 message_id 的条目（无法去重）丢弃；
 *   - 自己发的、`seenIds` / `lastSeenMessageId` 已见过的丢弃；
 *   - 时间早于等于 `lastSeenAt` 的丢弃（断线前已入账）；
 *   - 时间比 now 还超前 5 分钟以上的丢弃（时钟异常）；
 *   - 同一 message_id 只保留一条；
 *   - 按时间升序，只保留最新 `maxCount` 条。
 *
 * @returns {{fresh:Array<object>,dropped:number}}
 */
export function planCatchUp(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const rawMax = Number(input.maxCount);
  const maxCount = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : CATCH_UP_DEFAULTS.maxCount;
  const now = Number(input.now) || Date.now();
  const cutoff = Number(input.lastSeenAt) || 0;
  const selfId = input.selfId != null ? String(input.selfId) : '';
  const seen = new Set();
  if (input.lastSeenMessageId != null && String(input.lastSeenMessageId) !== '') {
    seen.add(String(input.lastSeenMessageId));
  }
  if (input.seenIds && typeof input.seenIds[Symbol.iterator] === 'function') {
    for (const id of input.seenIds) {
      if (id != null && String(id) !== '') seen.add(String(id));
    }
  }

  let dropped = 0;
  const byId = new Map();
  let index = 0;
  for (const message of messages) {
    index += 1;
    if (!message || typeof message !== 'object') { dropped += 1; continue; }
    const messageId = message.messageId != null ? String(message.messageId) : '';
    if (!messageId) { dropped += 1; continue; }
    if (byId.has(messageId) || seen.has(messageId)) { dropped += 1; continue; }
    if (message.isSelf === true) { dropped += 1; continue; }
    if (selfId && message.senderId != null && String(message.senderId) === selfId) { dropped += 1; continue; }
    const at = oneBotTimeToMs(message.at);
    if (cutoff > 0 && at > 0 && at <= cutoff) { dropped += 1; continue; }
    if (at > 0 && at > now + 5 * 60_000) { dropped += 1; continue; }
    byId.set(messageId, { ...message, messageId, at, _index: index });
  }

  const all = [...byId.values()].sort((a, b) => (a.at - b.at) || (a._index - b._index));
  const fresh = all.length > maxCount ? all.slice(all.length - maxCount) : all;
  dropped += all.length - fresh.length;
  return {
    fresh: fresh.map(({ _index, ...rest }) => rest),
    dropped
  };
}
