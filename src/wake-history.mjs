// 唤醒前历史预取（方案 A）：模型每次被唤醒时，只看得到「未读窗口 + 内存里的 recentMessages」。
// 断线、长时间潜水、bridge 重启之后，内存窗口是空/很短的，模型接上话就等于失忆。
// 这里把 OneBot 的历史接口当成一次性的「补上下文」，把最近 N 条（含自己说过的话）拼成一小段
// 注入唤醒提示词。刻意不改 st.recentMessages / st.unread：
//   - 不改 recentMessages：避免历史消息被当成刚发生的事，影响沉睡前观察、replyCheck、补拉去重；
//   - 不改 unread：历史不是新未读，不能让模型把它们当待回复消息处理。
// 纯函数，方便单测（scripts/test-wake-history.mjs）。

export const WAKE_HISTORY_DEFAULTS = Object.freeze({
  enabled: true,     // 关掉就完全不预取（不发 OneBot 请求）
  count: 12,         // 注入多少条（1~50）
  timeoutMs: 2500,   // 单次 OneBot 请求超时；失败只记日志，唤醒照常继续
  maxChars: 1600,    // 这段文本的字数上限，超了从最旧的开始丢
  cooldownMs: 60000  // 同一会话两次预取的最小间隔，避免连环唤醒反复打 OneBot
});

const HEADER = '【醒来前最近对话】以下是内存窗口之外的旧消息，只是补上下文，不是新未读，不用逐条回应：';

const pad2 = (n) => String(n).padStart(2, '0');

function clampInt(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 配置归一化：非法值回落到默认值，范围外夹紧；`false` 视作整体关闭。 */
export function normalizeWakeHistoryConfig(raw) {
  const base = { ...WAKE_HISTORY_DEFAULTS };
  if (raw === false) return { ...base, enabled: false };
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled !== false,
    count: clampInt(src.count, WAKE_HISTORY_DEFAULTS.count, 1, 50),
    timeoutMs: clampInt(src.timeoutMs, WAKE_HISTORY_DEFAULTS.timeoutMs, 300, 8000),
    maxChars: clampInt(src.maxChars, WAKE_HISTORY_DEFAULTS.maxChars, 200, 6000),
    cooldownMs: clampInt(src.cooldownMs, WAKE_HISTORY_DEFAULTS.cooldownMs, 0, 30 * 60000)
  };
}

/**
 * 从 OneBot 历史里挑出「模型还没看过」的尾部若干条。
 * - 丢没有 message_id 的（无法去重）、空文本、重复 id、knownIds 里已有的（未读/最近窗口）；
 * - 保留双方消息：自己说过的话也是上下文，不能像断线补拉那样把 isSelf 全过滤掉；
 * - 按时间升序，只保留最新 count 条；时间缺失的按入参顺序排在前面。
 *
 * @param {Array<{messageId?:string,at?:number,senderId?:string,senderName?:string,text?:string,isSelf?:boolean}>} messages
 * @param {{knownIds?:Iterable<string>, count?:number, selfId?:string}} [options]
 */
export function selectWakeHistory(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const count = clampInt(options.count, WAKE_HISTORY_DEFAULTS.count, 1, 50);
  const known = new Set();
  if (options.knownIds && typeof options.knownIds[Symbol.iterator] === 'function') {
    for (const id of options.knownIds) {
      if (id != null && String(id) !== '') known.add(String(id));
    }
  }
  const selfId = options.selfId != null ? String(options.selfId) : '';
  const seen = new Set();
  const rows = [];
  let order = 0;
  for (const raw of list) {
    order += 1;
    if (!raw || typeof raw !== 'object') continue;
    const messageId = raw.messageId != null ? String(raw.messageId) : '';
    const text = String(raw.text ?? '').replace(/\s+/g, ' ').trim();
    if (!messageId || !text) continue;
    if (known.has(messageId) || seen.has(messageId)) continue;
    seen.add(messageId);
    const senderId = raw.senderId != null ? String(raw.senderId) : '';
    const isSelf = raw.isSelf === true || (selfId !== '' && senderId === selfId);
    const at = Number(raw.at);
    rows.push({
      messageId,
      at: Number.isFinite(at) && at > 0 ? at : 0,
      senderId,
      senderName: String(raw.senderName ?? '').trim(),
      text: text.slice(0, 200),
      isSelf,
      _order: order
    });
  }
  rows.sort((a, b) => (a.at - b.at) || (a._order - b._order));
  const tail = rows.length > count ? rows.slice(rows.length - count) : rows;
  return tail.map(({ _order, ...rest }) => rest);
}

function formatStamp(at, now) {
  if (!Number.isFinite(at) || at <= 0) return '';
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return '';
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return sameDay ? hhmm : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmm}`;
}

/** 渲染成唤醒提示词里的一段；没有可用行时返回空串（调用方据此不加空段落）。 */
export function formatWakeHistoryBlock(rows, options = {}) {
  const maxChars = clampInt(options.maxChars, WAKE_HISTORY_DEFAULTS.maxChars, 200, 6000);
  const now = Number(options.now) || Date.now();
  const maxLineChars = Math.max(60, maxChars - HEADER.length - 4);
  const lines = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = String(row?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const who = row.isSelf ? '我' : (String(row.senderName || row.senderId || '').trim() || '未知');
    const stamp = formatStamp(Number(row.at), now);
    let line = `${stamp ? `${stamp} ` : ''}${who}：${text}`;
    if (line.length > maxLineChars) line = `${line.slice(0, maxLineChars - 1)}…`;
    lines.push(line);
  }
  if (!lines.length) return '';
  const render = (arr) => `${HEADER}\n${arr.join('\n')}`;
  while (lines.length > 1 && render(lines).length > maxChars) lines.shift();
  return render(lines);
}
