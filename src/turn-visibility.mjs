// 回合可见性（turn visibility）：失联安抚 + 自述状态。
//
// 这两个功能都只做「判断 + 文案」，不碰网络、不碰 bridge 的运行期对象，
// 因此可以脱离进程直接单测（scripts/test-turn-visibility.mjs）：
//   - 失联安抚（stuck notice）：会话卡住时给用户一句解释，带冷却与限流退避，
//     状态落在 state/stuck-notice.json，供控制台读取；
//   - 自述状态（self status）：在唤醒 prompt 里注入一小段运行期状态，
//     让 AI 被问「你在干嘛 / 怎么不回」时有事实可依。
//
// bridge.js 只做极薄的 hook（位置见 docs/guides/TURN_VISIBILITY.md）。
import fs from 'node:fs';
import path from 'node:path';

// ── 默认值 ────────────────────────────────────────────────────────────────
// 注意：不改 config.json，全部靠这里的代码默认值 + 用户配置覆盖。
export const STUCK_NOTICE_DEFAULTS = Object.freeze({
  enabled: true,
  afterMinutes: 8,        // 多久没有成功产出「回合/消息」算失联
  cooldownMinutes: 30,    // 同一会话两次安抚之间的最短间隔
  message: '我这边卡住了，等会儿回你',
  requireBusy: true,      // 只对「被判为繁忙」的会话安抚，避免潜水期间误报
  maxMessageChars: 60,
  rateLimitBackoffMs: 5 * 60_000,   // 被限流（429）后的退避起点
  failBackoffMs: 60_000,            // 普通发送失败的退避起点
  maxBackoffMs: 30 * 60_000,
  afterMsMin: 60_000,
  cooldownMsMin: 60_000
});

export const SELF_STATUS_DEFAULTS = Object.freeze({
  enabled: true,
  maxChars: 200
});

export const SELF_STATUS_PREFIX = '【桥接状态】';

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// 配置里的「分钟数」：非数字 / 0 / 负数一律回退默认，而不是被夹到最小值——
// 否则 cooldownMinutes:-3 会变成 1 分钟冷却，反而更容易刷屏。
function positiveOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ── 配置解析 ──────────────────────────────────────────────────────────────
// 入参是运行时配置的 socialV2 段（cfg.socialV2）。旧 config.json 里没有这两个
// 键时一律走默认值；非法值（负数、NaN、空串）静默回退，绝不抛错。
export function resolveStuckNoticeConfig(socialV2) {
  const section = isPlainObject(socialV2) ? socialV2 : {};
  const raw = isPlainObject(section.stuckNotice) ? section.stuckNotice : {};
  const afterMinutes = clamp(
    positiveOr(raw.afterMinutes, STUCK_NOTICE_DEFAULTS.afterMinutes),
    1,
    1440
  );
  const cooldownMinutes = clamp(
    positiveOr(raw.cooldownMinutes, STUCK_NOTICE_DEFAULTS.cooldownMinutes),
    1,
    1440
  );
  const rawMessage = typeof raw.message === 'string' ? raw.message : '';
  // 文案只允许单行短句：换行会在 QQ 里变成多条气泡，长文案会把安抚变成刷屏。
  const message = rawMessage.replace(/\s*\n+\s*/g, ' ').trim().slice(0, STUCK_NOTICE_DEFAULTS.maxMessageChars)
    || STUCK_NOTICE_DEFAULTS.message;
  return {
    enabled: raw.enabled !== false,
    requireBusy: raw.requireBusy !== false,
    message,
    afterMinutes,
    cooldownMinutes,
    afterMs: clamp(Math.round(positiveOr(raw.afterMs, afterMinutes * 60_000)), STUCK_NOTICE_DEFAULTS.afterMsMin, 24 * 3600_000),
    cooldownMs: clamp(Math.round(positiveOr(raw.cooldownMs, cooldownMinutes * 60_000)), STUCK_NOTICE_DEFAULTS.cooldownMsMin, 24 * 3600_000),
    rateLimitBackoffMs: Math.round(clamp(positiveOr(raw.rateLimitBackoffMs, STUCK_NOTICE_DEFAULTS.rateLimitBackoffMs), 30_000, 3600_000)),
    failBackoffMs: Math.round(clamp(positiveOr(raw.failBackoffMs, STUCK_NOTICE_DEFAULTS.failBackoffMs), 10_000, 3600_000)),
    maxBackoffMs: Math.round(clamp(positiveOr(raw.maxBackoffMs, STUCK_NOTICE_DEFAULTS.maxBackoffMs), 60_000, 24 * 3600_000))
  };
}

export function resolveSelfStatusConfig(socialV2) {
  const section = isPlainObject(socialV2) ? socialV2 : {};
  const raw = isPlainObject(section.selfStatus) ? section.selfStatus : {};
  return {
    enabled: raw.enabled !== false,
    maxChars: Math.trunc(clamp(toNumber(raw.maxChars, SELF_STATUS_DEFAULTS.maxChars), 20, SELF_STATUS_DEFAULTS.maxChars))
  };
}

// ── 状态文件：state/stuck-notice.json ──────────────────────────────────────
// 目录里只允许出现这一个文件；写入失败一律吞掉（安抚功能永远不能影响主链路）。
export function emptyNoticeState() {
  return {
    version: 1,
    totalSent: 0,
    totalFailed: 0,
    lastSentAt: 0,
    lastAttemptAt: 0,
    conversations: Object.create(null)
  };
}

function normalizeEntry(entry) {
  const e = isPlainObject(entry) ? entry : {};
  return {
    sentCount: Math.max(0, Math.trunc(toNumber(e.sentCount, 0))),
    failCount: Math.max(0, Math.trunc(toNumber(e.failCount, 0))),
    lastSentAt: Math.max(0, toNumber(e.lastSentAt, 0)),
    lastAttemptAt: Math.max(0, toNumber(e.lastAttemptAt, 0)),
    blockedUntil: Math.max(0, toNumber(e.blockedUntil, 0)),
    lastReason: typeof e.lastReason === 'string' ? e.lastReason.slice(0, 40) : '',
    lastError: typeof e.lastError === 'string' ? e.lastError.slice(0, 200) : '',
    lastUnread: Math.max(0, Math.trunc(toNumber(e.lastUnread, 0)))
  };
}

/** 文件不存在 / JSON 坏了 / 字段类型不对，全部当作空状态，绝不抛错。 */
export function loadNoticeState(file) {
  const empty = emptyNoticeState();
  if (!file) return empty;
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const raw = JSON.parse(text);
    if (!isPlainObject(raw)) return empty;
    const state = emptyNoticeState();
    state.version = Math.trunc(toNumber(raw.version, 1)) || 1;
    state.totalSent = Math.max(0, Math.trunc(toNumber(raw.totalSent, 0)));
    state.totalFailed = Math.max(0, Math.trunc(toNumber(raw.totalFailed, 0)));
    state.lastSentAt = Math.max(0, toNumber(raw.lastSentAt, 0));
    state.lastAttemptAt = Math.max(0, toNumber(raw.lastAttemptAt, 0));
    if (isPlainObject(raw.conversations)) {
      for (const [key, value] of Object.entries(raw.conversations)) {
        if (!/^(group|private):\d+$/.test(key)) continue; // 只认内部约定 key，避免脏数据回流
        state.conversations[key] = normalizeEntry(value);
      }
    }
    return state;
  } catch {
    return empty;
  }
}

/** 原子性不做额外要求（状态文件损坏可重建），但必须容错：返回 false 表示没写成。 */
export function saveNoticeState(file, state) {
  if (!file) return false;
  try {
    const src = isPlainObject(state) ? state : {};
    const out = {
      version: 1,
      updatedAt: Date.now(),
      totalSent: Math.max(0, Math.trunc(toNumber(src.totalSent, 0))),
      totalFailed: Math.max(0, Math.trunc(toNumber(src.totalFailed, 0))),
      lastSentAt: Math.max(0, toNumber(src.lastSentAt, 0)),
      lastAttemptAt: Math.max(0, toNumber(src.lastAttemptAt, 0)),
      conversations: {}
    };
    for (const [key, value] of Object.entries(isPlainObject(src.conversations) ? src.conversations : {})) {
      if (!/^(group|private):\d+$/.test(key)) continue;
      out.conversations[key] = normalizeEntry(value);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    return true;
  } catch {
    return false;
  }
}

// ── 失联安抚判定 ──────────────────────────────────────────────────────────
// input: { unread, busy, busySince, lastProductiveAt, paused, entry }
//   busySince        本会话从什么时候开始被判为繁忙（0=不忙/未知）
//   lastProductiveAt 最近一次「成功产出」的时间（AI 发言 / 回合动作）
//   entry            该会话在 stuck-notice.json 里的历史记录（可为 null）
// 返回 { send, reason, ... }：send=false 时 reason 说明为什么没发，便于日志排查。
export function decideStuckNotice(input, now, cfg) {
  const c = cfg ?? resolveStuckNoticeConfig(null);
  const t = toNumber(now, Date.now());
  const i = isPlainObject(input) ? input : {};
  if (c.enabled === false) return { send: false, reason: 'disabled' };
  if (i.paused === true) return { send: false, reason: 'paused' };
  const unread = Math.max(0, Math.trunc(toNumber(i.unread, 0)));
  if (unread <= 0) return { send: false, reason: 'no-unread' };
  const busy = i.busy === true;
  if (c.requireBusy && !busy) return { send: false, reason: 'not-busy' };

  const busySince = Math.max(0, toNumber(i.busySince, 0));
  // 刚被判繁忙、还没来得及记录起点时不要发：这一刻 AI 很可能正要开口。
  if (c.requireBusy && busy && busySince <= 0) return { send: false, reason: 'busy-unknown' };
  const lastProductiveAt = Math.max(0, toNumber(i.lastProductiveAt, 0));
  // 不知道上次成功产出的时间时，退回「繁忙起点」估算；两者都没有就不猜。
  const anchor = lastProductiveAt > 0 ? lastProductiveAt : busySince;
  if (anchor <= 0) return { send: false, reason: 'no-anchor' };
  const stalledMs = Math.max(0, t - anchor);
  if (stalledMs < c.afterMs) return { send: false, reason: 'not-stalled', stalledMs };
  // 「繁忙」必须也已经持续够久：AI 正常在 qq_wait_for_messages 里等 5 分钟不该被安抚。
  if (busySince > 0 && t - busySince < c.afterMs) {
    return { send: false, reason: 'busy-short', stalledMs, busyForMs: t - busySince };
  }

  const entry = normalizeEntry(i.entry);
  if (entry.blockedUntil > t) return { send: false, reason: 'backoff', retryInMs: entry.blockedUntil - t };
  if (entry.lastSentAt > 0 && t - entry.lastSentAt < c.cooldownMs) {
    return { send: false, reason: 'cooldown', retryInMs: c.cooldownMs - (t - entry.lastSentAt) };
  }
  return { send: true, reason: 'stalled', stalledMs, busyForMs: busySince > 0 ? t - busySince : 0, unread };
}

/** 发送前先记「尝试」：进程在发送途中被杀也不会以为没试过。 */
export function markNoticeAttempt(entry, now) {
  const e = normalizeEntry(entry);
  return { ...e, lastAttemptAt: Math.max(0, toNumber(now, Date.now())) };
}

export function markNoticeSent(entry, now, cfg, reason, unread) {
  const e = normalizeEntry(entry);
  const t = Math.max(0, toNumber(now, Date.now()));
  return {
    ...e,
    sentCount: e.sentCount + 1,
    failCount: 0,
    lastSentAt: t,
    lastAttemptAt: t,
    blockedUntil: 0,
    lastReason: String(reason || 'stalled').slice(0, 40),
    lastError: '',
    lastUnread: Math.max(0, Math.trunc(toNumber(unread, 0)))
  };
}

function describeError(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error.slice(0, 200);
  if (typeof error.message === 'string') return error.message.slice(0, 200);
  try {
    return String(error).slice(0, 200);
  } catch {
    return 'unknown error';
  }
}

/** 429 / OneBot 限流 / 风控都由这里识别，决定退避时长。 */
export function isRateLimitedError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.retcode ?? NaN);
  if (status === 429 || status === 1200) return true;
  const text = describeError(error);
  return /(^|\D)429(\D|$)|rate.?limit|too many requests|限流|频(繁|率)|retcode["':\s]*1200/i.test(text);
}

/** 发送失败：指数退避（限流时起点更长），期间 decideStuckNotice 只会回 backoff。 */
export function markNoticeFailed(entry, now, error, cfg) {
  const c = cfg ?? resolveStuckNoticeConfig(null);
  const e = normalizeEntry(entry);
  const t = Math.max(0, toNumber(now, Date.now()));
  const rateLimited = isRateLimitedError(error);
  const base = rateLimited ? c.rateLimitBackoffMs : c.failBackoffMs;
  const grown = base * Math.pow(2, Math.min(3, e.failCount));
  const backoff = Math.min(c.maxBackoffMs, Math.max(base, grown));
  return {
    ...e,
    failCount: e.failCount + 1,
    lastAttemptAt: t,
    blockedUntil: t + Math.round(backoff),
    lastReason: rateLimited ? 'rate-limited' : 'send-failed',
    lastError: describeError(error)
  };
}

/**
 * 编排一次安抚：判定 → 发送（由调用方注入）→ 记账。
 * store 是 loadNoticeState() 拿到的对象，本函数原地更新它，调用方负责落盘。
 */
export async function runStuckNotice(ctx) {
  const c = ctx?.cfg ?? resolveStuckNoticeConfig(null);
  const store = isPlainObject(ctx?.store) ? ctx.store : emptyNoticeState();
  if (!isPlainObject(store.conversations)) store.conversations = Object.create(null);
  const key = String(ctx?.key ?? '');
  const t = toNumber(ctx?.now, Date.now());
  const decision = decideStuckNotice({ ...ctx, entry: store.conversations[key] ?? null }, t, c);
  if (!decision.send) return { sent: false, reason: decision.reason, retryInMs: decision.retryInMs ?? 0 };

  store.conversations[key] = markNoticeAttempt(store.conversations[key], t);
  let sent = true;
  let errorText = '';
  try {
    if (typeof ctx.send !== 'function') throw new Error('no-sender');
    await ctx.send(c.message);
  } catch (error) {
    sent = false;
    errorText = describeError(error);
  }
  if (sent) {
    store.conversations[key] = markNoticeSent(store.conversations[key], t, c, decision.reason, ctx?.unread);
    store.totalSent = Math.max(0, Math.trunc(toNumber(store.totalSent, 0))) + 1;
    store.lastSentAt = t;
  } else {
    store.conversations[key] = markNoticeFailed(store.conversations[key], t, errorText, c);
    store.totalFailed = Math.max(0, Math.trunc(toNumber(store.totalFailed, 0))) + 1;
  }
  store.lastAttemptAt = t;
  return { sent, reason: sent ? decision.reason : 'send-failed', error: errorText, entry: store.conversations[key] };
}

/**
 * 定时巡检入口（bridge 的 setInterval 只调这一个函数）：
 * 配置解析、状态读写、逐会话 try/catch 都在这里，bridge 侧只提供数据与发送器。
 * options: { now, cfg: socialV2 段, file, keys, paused, resolve(key)->info|null,
 *            send(key,text)->Promise, log(text) }
 */
// 同一时刻只允许一轮巡检：上一轮若因发送超时跑过了 60s，下一轮直接复用它的结果，
// 避免两轮并发读到同一份冷却前状态而重复发送。
let sweepInFlight = null;

export function sweepStuckNotices(options) {
  if (sweepInFlight) return sweepInFlight;
  sweepInFlight = runSweep(options).finally(() => { sweepInFlight = null; });
  return sweepInFlight;
}

async function runSweep(options) {
  const o = isPlainObject(options) ? options : {};
  const cfg = resolveStuckNoticeConfig(o.cfg);
  const out = { checked: 0, sent: 0, failed: 0 };
  if (!cfg.enabled) return out;
  const keys = Array.isArray(o.keys) ? o.keys : [];
  if (keys.length === 0) return out;
  const store = loadNoticeState(o.file);
  const now = toNumber(o.now, Date.now());
  const send = typeof o.send === 'function' ? o.send : null;
  let dirty = false;
  for (const key of keys) {
    const k = String(key ?? '');
    if (!/^(group|private):\d+$/.test(k)) continue;
    try {
      const info = o.resolve?.(k);
      if (!info) continue;
      out.checked += 1;
      const result = await runStuckNotice({
        key: k,
        now,
        cfg,
        store,
        paused: o.paused === true,
        unread: info.unread,
        busy: info.busy,
        busySince: info.busySince,
        lastProductiveAt: info.lastProductiveAt,
        send: send ? (textMsg) => send(k, textMsg) : null
      });
      if (result.sent) {
        out.sent += 1;
        dirty = true;
        o.log?.(`${k}：已发送（未读 ${Math.max(0, Math.trunc(toNumber(info.unread, 0)))} 条）`);
      } else if (result.error) {
        out.failed += 1;
        dirty = true;
        o.log?.(`${k} 发送失败，退避至 ${new Date(Number(result.entry?.blockedUntil) || 0).toISOString()}：${result.error}`);
      }
    } catch (error) {
      // 单个会话出问题不影响其他会话，也绝不把异常抛回 setInterval 回调。
      o.log?.(`${k} 检查异常：${describeError(error)}`);
    }
  }
  if (dirty) saveNoticeState(o.file, store);
  return out;
}

// ── 自述状态行 ────────────────────────────────────────────────────────────
function formatDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时`;
  return `${Math.floor(hour / 24)}天`;
}

function formatAgo(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 5) return '刚刚';
  return `${formatDuration(ms)}前`;
}

/**
 * 生成「【桥接状态】…」这一行（不含尾部换行）。
 * 约束：
 *   - enabled=false 时返回 ''（调用方据此保持 prompt 逐字节不变）；
 *   - 总长绝不超过 maxChars（硬上限 200），超了按 keep 优先级丢字段；
 *   - 拿不到的字段直接省略，绝不写「未知」。
 */
export function buildStatusLine(input) {
  const i = isPlainObject(input) ? input : {};
  if (i.enabled === false) return '';
  const now = Math.max(0, toNumber(i.now, Date.now()));
  const maxChars = Math.trunc(clamp(toNumber(i.maxChars, SELF_STATUS_DEFAULTS.maxChars), 20, SELF_STATUS_DEFAULTS.maxChars));
  // 数组顺序 = 展示顺序；keep 越小越先被丢。
  const fields = [];
  const queueDepth = toNumber(i.queueDepth, NaN);
  if (Number.isFinite(queueDepth) && queueDepth >= 0) {
    fields.push({ keep: 4, text: `待发队列 ${Math.trunc(queueDepth)}` });
  }
  const busySince = toNumber(i.busySince, 0);
  if (busySince > 0 && now > busySince) {
    fields.push({ keep: 3, text: `本会话繁忙 ${formatDuration(now - busySince)}` });
  }
  const lastTurnEndedAt = toNumber(i.lastTurnEndedAt, 0);
  if (lastTurnEndedAt > 0 && now >= lastTurnEndedAt) {
    fields.push({ keep: 2, text: `上一回合结束 ${formatAgo(now - lastTurnEndedAt)}` });
  }
  if (typeof i.dshConnected === 'boolean') {
    fields.push({ keep: 1, text: i.dshConnected ? 'DSH 连接正常' : 'DSH 连接断开' });
  }
  if (fields.length === 0) return '';
  const render = (list) => SELF_STATUS_PREFIX + list.map((f) => f.text).join('；');
  const kept = fields.slice();
  while (kept.length > 0 && render(kept).length > maxChars) {
    let dropAt = 0;
    for (let idx = 1; idx < kept.length; idx += 1) {
      if (kept[idx].keep < kept[dropAt].keep) dropAt = idx;
    }
    kept.splice(dropAt, 1);
  }
  return kept.length > 0 ? render(kept) : '';
}
