// 出站限流排队（纯逻辑 + 轻量持久化，不依赖 bridge）。
//
// 背景：OneBot / SnowLuma 有每秒/每分钟/每小时发送上限。超限时消息会被 QQ 侧拒绝
// （「发送频率超限」/ retcode 1200 / HTTP 429）。旧实现只打一行日志就丢弃普通回复与
// 表情，用户完全不知道；真实事故是每小时 60 条上限触发后，连定时提醒都发不出去。
//
// 这里只做「该不该发、什么时候发」的账本：分类优先级、识别限流错误、内存队列 + state 落盘、
// 指数退避、TTL 与容量上限。真正的发送由 bridge.js 注入（重投时调用 onebotSend / 表情发送）。
import fs from 'node:fs';
import path from 'node:path';

/** 出站优先级：数值越大越先补发。 */
export const RATE_LIMIT_PRIORITIES = Object.freeze({
  owner: 100,
  directReply: 90,
  groupReply: 60,
  sticker: 40,
  proactive: 30,
  reminder: 20
});

export const RATE_LIMIT_DEFAULTS = Object.freeze({
  ttlMs: 30 * 60_000,      // 首次入队后最多保留 30 分钟
  maxAttempts: 8,          // 第 9 次失败丢弃
  maxSize: 200,            // 队列上限
  baseBackoffMs: 1000,     // 1s → 2s → 4s → …
  maxBackoffMs: 5 * 60_000,
  batchSize: 5,            // 每轮最多补发 5 条
  filePath: null
});

function clampPriority(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : RATE_LIMIT_PRIORITIES.groupReply;
}

function errorText(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error.slice(0, 500);
  if (typeof error.message === 'string') return error.message.slice(0, 500);
  if (typeof error.wording === 'string') return error.wording.slice(0, 500);
  try {
    return String(error).slice(0, 500);
  } catch {
    return 'unknown error';
  }
}

/**
 * 识别「限流」类失败，兼容字符串、Error、OneBot 信封对象。
 * 覆盖：中文措辞、HTTP 429、OneBot retcode 1200（SnowLuma 的发送频率超限）、
 * 以及 onebotSend 抛出的 `OneBot send_private_msg 失败: 1200` 这种只有数字的文本。
 */
export function isRateLimitError(error) {
  const status = Number(
    error?.status
    ?? error?.statusCode
    ?? error?.retcode
    ?? error?.body?.retcode
    ?? error?.response?.status
    ?? NaN
  );
  if (status === 429 || status === 1200) return true;
  const text = errorText(error);
  return /发送频率超限|发送过于频繁|频率限制|频率超限|限流|(^|\D)429(\D|$)|(^|\D)1200(\D|$)|rate.?limit|too many requests|retcode["':\s]*1200/i.test(text);
}

/**
 * 决定一条出站消息的优先级。
 *
 * 优先级判定顺序（先看消息用途，再看对象身份）：
 *   reminder(20) → sticker(40) → proactive(30) → owner(100) → directReply(90) → groupReply(60)
 * 也就是说：定时提醒即使发给 owner 也按 20 排，避免提醒挤占真人回复；表情按 40 排在正文之后。
 *
 * @param {{kind?:string,targetKind?:string,atMe?:boolean,mentionedMe?:boolean,isOwner?:boolean,purpose?:string}} input
 * @returns {{priority:number,label:string}}
 */
export function classifyOutbound(input = {}) {
  const kind = String(input.kind ?? input.targetKind ?? '').toLowerCase();
  const purpose = String(input.purpose ?? '').toLowerCase();
  if (purpose === 'reminder') return { priority: RATE_LIMIT_PRIORITIES.reminder, label: 'reminder' };
  if (purpose === 'sticker' || kind === 'sticker') return { priority: RATE_LIMIT_PRIORITIES.sticker, label: 'sticker' };
  if (purpose === 'proactive') return { priority: RATE_LIMIT_PRIORITIES.proactive, label: 'proactive' };
  if (input.isOwner || input.targetKind === 'owner') return { priority: RATE_LIMIT_PRIORITIES.owner, label: 'owner' };
  if (input.atMe || input.mentionedMe || purpose === 'directreply' || purpose === 'direct' || kind === 'private') {
    return { priority: RATE_LIMIT_PRIORITIES.directReply, label: 'directReply' };
  }
  return { priority: RATE_LIMIT_PRIORITIES.groupReply, label: 'groupReply' };
}

function fingerprint(key, payload) {
  let encoded;
  try {
    encoded = JSON.stringify(payload ?? null);
  } catch {
    encoded = String(payload);
  }
  return `${key}\u0000${encoded}`;
}

/**
 * 限流补发队列。
 *
 * - 同 key + 同 payload 重复入队会合并（保留更高优先级、更早的 firstAt），避免堆积。
 * - 容量满时丢弃「优先级最低、firstAt 最老」的条目。
 * - 每次变更同步落盘（文件很小），进程重启后未过 TTL 的条目仍会继续补发。
 * - 落盘失败/文件损坏只记在内存里继续工作；损坏文件按空队列处理。
 */
export class RateLimitQueue {
  constructor(options = {}) {
    this.filePath = options.filePath ?? RATE_LIMIT_DEFAULTS.filePath;
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : RATE_LIMIT_DEFAULTS.ttlMs;
    this.maxAttempts = Number(options.maxAttempts) > 0 ? Math.floor(Number(options.maxAttempts)) : RATE_LIMIT_DEFAULTS.maxAttempts;
    this.maxSize = Number(options.maxSize) > 0 ? Math.floor(Number(options.maxSize)) : RATE_LIMIT_DEFAULTS.maxSize;
    this.baseBackoffMs = Number(options.baseBackoffMs) > 0 ? Number(options.baseBackoffMs) : RATE_LIMIT_DEFAULTS.baseBackoffMs;
    this.maxBackoffMs = Number(options.maxBackoffMs) > 0 ? Number(options.maxBackoffMs) : RATE_LIMIT_DEFAULTS.maxBackoffMs;
    this.batchSize = Number(options.batchSize) > 0 ? Math.floor(Number(options.batchSize)) : RATE_LIMIT_DEFAULTS.batchSize;
    this.items = new Map();
    this.statsData = { totalEnqueued: 0, totalSent: 0, totalDropped: 0 };
    this.seq = 0;
    this._load();
  }

  _load() {
    if (!this.filePath) return;
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return;
    }
    try {
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
      if (data && !Array.isArray(data) && data.stats) {
        for (const k of Object.keys(this.statsData)) {
          const n = Number(data.stats[k]);
          if (Number.isFinite(n) && n >= 0) this.statsData[k] = n;
        }
      }
      const now = Date.now();
      let droppedOnLoad = 0;
      for (const row of list) {
        if (!row || typeof row.key !== 'string' || !row.key) continue;
        const firstAt = Number(row.firstAt) || now;
        const attempts = Math.max(0, Math.floor(Number(row.attempts) || 0));
        // 重启后已经过 TTL 或超次数的条目不补发：宁可少发，也不能把半小时前的旧回复突然捅出去。
        if (now - firstAt > this.ttlMs || attempts > this.maxAttempts) {
          this.statsData.totalDropped += 1;
          droppedOnLoad += 1;
          continue;
        }
        const id = String(row.id || this._nextId());
        this.items.set(id, {
          id,
          key: row.key,
          kind: String(row.kind ?? 'text'),
          label: String(row.label ?? 'groupReply'),
          priority: clampPriority(row.priority),
          payload: row.payload && typeof row.payload === 'object' ? row.payload : {},
          attempts,
          firstAt,
          lastAttemptAt: Number(row.lastAttemptAt) || 0,
          nextAttemptAt: Number(row.nextAttemptAt) || now,
          lastError: row.lastError ? String(row.lastError).slice(0, 200) : ''
        });
      }
      // 把过期条目从磁盘清掉，避免每次重启重复计数。
      if (droppedOnLoad > 0) this._save();
    } catch {
      // 文件坏当空队列：宁可丢历史，也不能让启动失败。
      this.items.clear();
    }
  }

  _nextId() {
    this.seq += 1;
    return `${Date.now().toString(36)}-${this.seq.toString(36)}`;
  }

  _save() {
    if (!this.filePath) return;
    const body = JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      stats: this.statsData,
      items: [...this.items.values()]
    }, null, 2);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, body, 'utf8');
      try {
        fs.renameSync(tmp, this.filePath);
      } catch {
        // Windows 上目标被占用时 rename 可能失败，退化为直接写。
        fs.writeFileSync(this.filePath, body, 'utf8');
        try { fs.unlinkSync(tmp); } catch {}
      }
    } catch {
      // 落盘失败不影响内存补发；下一次变更还会再试。
    }
  }

  /** 丢弃优先级最低、firstAt 最老的条目；返回被丢弃的条目。 */
  _evictOne() {
    let victim = null;
    for (const item of this.items.values()) {
      if (!victim
        || item.priority < victim.priority
        || (item.priority === victim.priority && item.firstAt < victim.firstAt)) {
        victim = item;
      }
    }
    if (!victim) return null;
    this.items.delete(victim.id);
    this.statsData.totalDropped += 1;
    return victim;
  }

  /**
   * @param {{key:string,kind?:string,label?:string,priority?:number,payload:object,firstAt?:number,nextAttemptAt?:number}} item
   * @returns {{id:string,merged:boolean,dropped:null|{id:string,key:string,reason:string,priority:number}}}
   */
  enqueue(item = {}) {
    const key = String(item.key ?? '');
    if (!key) throw new Error('enqueue: key 不能为空');
    const now = Number(item.firstAt) || Date.now();
    const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
    const fp = fingerprint(key, payload);
    for (const existing of this.items.values()) {
      if (fingerprint(existing.key, existing.payload) !== fp) continue;
      if (Number(item.priority) > existing.priority) {
        existing.priority = clampPriority(item.priority);
        existing.label = String(item.label ?? existing.label);
      }
      existing.firstAt = Math.min(existing.firstAt, now);
      existing.nextAttemptAt = Math.min(existing.nextAttemptAt, Number(item.nextAttemptAt) || now);
      existing.attempts = Math.min(existing.attempts, Math.max(0, Number(item.attempts) || 0));
      this._save();
      return { id: existing.id, merged: true, dropped: null };
    }

    let dropped = null;
    if (this.items.size >= this.maxSize) {
      const victim = this._evictOne();
      if (victim) {
        dropped = { id: victim.id, key: victim.key, reason: 'overflow', priority: victim.priority };
      }
    }
    const id = this._nextId();
    this.items.set(id, {
      id,
      key,
      kind: String(item.kind ?? 'text'),
      label: String(item.label ?? 'groupReply'),
      priority: clampPriority(item.priority),
      payload,
      attempts: Math.max(0, Math.floor(Number(item.attempts) || 0)),
      firstAt: now,
      lastAttemptAt: 0,
      nextAttemptAt: Number(item.nextAttemptAt) || now,
      lastError: ''
    });
    this.statsData.totalEnqueued += 1;
    this._save();
    return { id, merged: false, dropped };
  }

  /** 到期条目：priority 降序 → firstAt 升序，最多 batchSize 条。 */
  takeDue(now = Date.now()) {
    const due = [];
    for (const item of this.items.values()) {
      if (item.nextAttemptAt <= now) due.push(item);
    }
    due.sort((a, b) => (b.priority - a.priority) || (a.firstAt - b.firstAt));
    return due.slice(0, this.batchSize).map((item) => ({ ...item, payload: item.payload }));
  }

  markDone(id) {
    const item = this.items.get(String(id));
    if (!item) return false;
    this.items.delete(item.id);
    this.statsData.totalSent += 1;
    this._save();
    return true;
  }

  /** 主动丢弃（例如会话已不在白名单、重启后确认不需要补发）。 */
  drop(id, reason = 'manual') {
    const item = this.items.get(String(id));
    if (!item) return false;
    this.items.delete(item.id);
    this.statsData.totalDropped += 1;
    this._save();
    return { id: item.id, key: item.key, reason };
  }

  /**
   * 失败：指数退避。attempts > maxAttempts 或超过 TTL 则丢弃并返回 dropped 原因。
   * @returns {{id:string,dropped:null|string,attempts:number,retryAt?:number,backoffMs?:number}}
   */
  markFailed(id, error, now = Date.now()) {
    const item = this.items.get(String(id));
    if (!item) return { id: String(id), dropped: 'missing', attempts: 0 };
    item.attempts += 1;
    item.lastAttemptAt = now;
    item.lastError = errorText(error).slice(0, 200);
    if (item.attempts > this.maxAttempts) {
      this.items.delete(item.id);
      this.statsData.totalDropped += 1;
      this._save();
      return { id: item.id, dropped: 'max-attempts', attempts: item.attempts };
    }
    if (now - item.firstAt > this.ttlMs) {
      this.items.delete(item.id);
      this.statsData.totalDropped += 1;
      this._save();
      return { id: item.id, dropped: 'ttl', attempts: item.attempts };
    }
    const backoffMs = Math.min(this.maxBackoffMs, this.baseBackoffMs * (2 ** (item.attempts - 1)));
    item.nextAttemptAt = now + backoffMs;
    this._save();
    return { id: item.id, dropped: null, attempts: item.attempts, retryAt: item.nextAttemptAt, backoffMs };
  }

  size() {
    return this.items.size;
  }

  /**
   * 只读视图：给控制台看「队列里现在压着什么」。
   * 故意不返回 payload —— 里面是待发消息正文（可能含聊天内容），控制台没有理由看全文；
   * 只给重投所需的元信息，够判断「是不是卡住了、卡在谁身上、下次什么时候重试」。
   */
  list(limit = 20) {
    const out = [];
    for (const it of this.items.values()) {
      out.push({
        id: it.id,
        key: it.key,
        kind: it.kind,
        label: it.label,
        priority: it.priority,
        attempts: it.attempts,
        firstAt: it.firstAt,
        nextAttemptAt: it.nextAttemptAt,
        lastAttemptAt: it.lastAttemptAt,
        lastError: String(it.lastError ?? '').slice(0, 200)
      });
    }
    out.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
    return out.slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
  }

  stats() {
    return {
      totalEnqueued: this.statsData.totalEnqueued,
      totalSent: this.statsData.totalSent,
      totalDropped: this.statsData.totalDropped,
      depth: this.items.size
    };
  }
}
