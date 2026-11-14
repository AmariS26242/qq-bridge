// 定时提醒（reminder）的存储与调度计算库：只管「记什么、什么时候该响、响了记什么」，
// 不负责真的发消息（发送仍走 bridge 的 sendMessagesV2 / deliverPrompt，复用限频与白名单）。
//
// 设计要点：
// 1. **持久化独立成文件**（state/reminders.json），不塞进 social-v2.json ——
//    后者是高频读写、且带「文件指纹」防覆盖逻辑的状态文件，往里加一坨会长久存活的数据
//    容易在两边实例/崩溃恢复时被整体回退。
// 2. **上限优先**：任务数、单会话任务数、同一会话最小触发间隔都有硬上限，
//    防止调用方无限堆任务把机器人刷爆（这是需求里的明确安全要求）。
// 3. **崩溃安全**：出发送前先把 status 改成 firing 落盘。重启时看到 firing 就认为
//    「可能已经发过」，**不重发**（宁可漏一条，也不重复刷屏），记成 error 并说明原因。
// 4. **错过补发有边界**：停机期间错过的任务，只有在 graceMs 内才补发，超过就记 missed。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const REMINDER_TZ = 'Asia/Shanghai';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** reminder 配置段（默认值写死在这里，bridge 与 MCP 共用一套）。 */
export function reminderCfg(cfg) {
  const c = cfg?.socialV2?.reminder ?? {};
  const num = (v, def, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(hi, Math.max(lo, Math.floor(n)));
  };
  return {
    enabled: c.enabled !== false,
    tickMs: num(c.tickMs, 15_000, 5_000, 300_000),
    maxActiveTotal: num(c.maxActiveTotal, 50, 1, 500),
    maxActivePerTarget: num(c.maxActivePerTarget, 10, 1, 100),
    // 同一个会话两次提醒的最小间隔：防「一堆任务同一分钟全炸出来」
    minGapMs: num(c.minGapMs, 120_000, 0, 6 * HOUR),
    // 最早触发时间：避免「立刻触发」被当成绕过限频的后门
    minLeadMs: num(c.minLeadMs, 10_000, 0, HOUR),
    // 最远触发时间：防止误传年份导致任务永远挂着
    maxHorizonMs: num(c.maxHorizonMs, 90 * DAY, HOUR, 365 * DAY),
    // 停机错过多久之内还补发
    graceMs: num(c.graceMs, 30 * MINUTE, 0, DAY),
    maxAttempts: num(c.maxAttempts, 5, 1, 20),
    // 与 send.maxMessageChars 对齐；单条提醒只发一条气泡
    maxTextChars: num(c.maxTextChars, 500, 1, 2000),
  };
}

export function newReminderId(nowMs = Date.now()) {
  return `rm-${nowMs.toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

// ── 时区工具（中国无夏令时，但仍按通用算法写，避免换 tz 时整体错一小时） ────────────

export function zoneParts(ms, tz = REMINDER_TZ) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const out = {};
  for (const p of dtf.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return {
    y: Number(out.year), mo: Number(out.month), d: Number(out.day),
    h: Number(out.hour) % 24, mi: Number(out.minute), s: Number(out.second),
  };
}

function zoneOffsetMs(ms, tz = REMINDER_TZ) {
  const p = zoneParts(ms, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** 把「某时区的墙上时间」换成绝对毫秒。 */
export function epochFromZone({ y, mo, d, h = 0, mi = 0, s = 0 }, tz = REMINDER_TZ) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let ms = guess - zoneOffsetMs(guess, tz);
  ms = guess - zoneOffsetMs(ms, tz); // 跨 DST 边界再校正一次
  return ms;
}

/** 1=周一 … 7=周日。 */
export function isoWeekday(ms, tz = REMINDER_TZ) {
  const p = zoneParts(ms, tz);
  const dow = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay(); // 0=周日
  return dow === 0 ? 7 : dow;
}

/** 解析 "HH:MM"，返回 {h, mi} 或 null。 */
export function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { h, mi };
}

/** 下一个「每天 HH:MM」（严格晚于 fromMs + minLeadMs）。 */
export function nextDailyMs(clock, fromMs, { minLeadMs = 0, tz = REMINDER_TZ } = {}) {
  const { h, mi } = clock;
  const floor = fromMs + minLeadMs;
  const p = zoneParts(floor, tz);
  let candidate = epochFromZone({ y: p.y, mo: p.mo, d: p.d, h, mi, s: 0 }, tz);
  if (candidate <= floor) {
    candidate = epochFromZone({ y: p.y, mo: p.mo, d: p.d + 1, h, mi, s: 0 }, tz);
  }
  return candidate;
}

/** 下一个「每周 weekday HH:MM」（weekday 1=周一…7=周日）。 */
export function nextWeeklyMs(weekday, clock, fromMs, { minLeadMs = 0, tz = REMINDER_TZ } = {}) {
  const { h, mi } = clock;
  const floor = fromMs + minLeadMs;
  let candidate = nextDailyMs(clock, floor - DAY, { minLeadMs: 0, tz });
  // 从「今天或明天」起步，最多向前找 8 天，一定能落在目标星期几上。
  for (let i = 0; i < 9; i += 1) {
    if (isoWeekday(candidate, tz) === weekday && candidate > floor) return candidate;
    const p = zoneParts(candidate, tz);
    candidate = epochFromZone({ y: p.y, mo: p.mo, d: p.d + 1, h, mi, s: 0 }, tz);
  }
  const p = zoneParts(floor, tz);
  return epochFromZone({ y: p.y, mo: p.mo, d: p.d + 7, h, mi, s: 0 }, tz);
}

/** 人类可读的墙上时间，例如 2026-10-20 08:30（Asia/Shanghai）。 */
export function formatInZone(ms, tz = REMINDER_TZ) {
  const p = zoneParts(ms, tz);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}

// ── 输入校验 ──────────────────────────────────────────────────────────────

const KEY_RE = /^(group|private):(\d{1,12})$/;

export class ReminderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ReminderError';
    this.status = status;
  }
}

/**
 * 把调用参数规范成待存任务。语义：
 * - text    ：到点原样发这段文字（一条气泡）
 * - prompt  ：到点叫醒 AI，给它这段描述，让它自己组织措辞
 * - 时间三选一：delaySeconds / at（绝对时间）/ daily|weekly（周期）
 * 返回不含 id/nextRunAt 的归一化对象，由 store.add 补。
 */
export function normalizeCreate(input = {}, { cfg, nowMs = Date.now() } = {}) {
  const rcfg = reminderCfg(cfg);
  if (!rcfg.enabled) throw new ReminderError('定时提醒功能已关闭（socialV2.reminder.enabled=false）', 403);

  const key = String(input.key ?? input.target ?? '').trim();
  const km = KEY_RE.exec(key);
  if (!km) throw new ReminderError('key 格式应为 group:群号 或 private:QQ号');
  const kind = km[1];
  const targetId = Number(km[2]);
  if (!Number.isFinite(targetId) || targetId <= 0) throw new ReminderError('key 里的号码不合法');

  const text = String(input.text ?? input.message ?? '').trim();
  const prompt = String(input.prompt ?? input.note ?? '').trim();
  if (text && prompt) throw new ReminderError('text 与 prompt 只能选一个：text 是到点原样发的文字，prompt 是让 AI 自己组织措辞的描述');
  if (!text && !prompt) throw new ReminderError('必须提供 text（原样发送）或 prompt（让 AI 自己组织措辞）之一');
  if (text && text.length > rcfg.maxTextChars) throw new ReminderError(`text 不能超过 ${rcfg.maxTextChars} 字`);
  if (prompt && prompt.length > 1000) throw new ReminderError('prompt 不能超过 1000 字');
  if (Array.isArray(input.messages)) throw new ReminderError('一次提醒只发一条消息，请把内容合并进 text');

  const mode = String(input.repeat ?? input.schedule ?? 'none').trim().toLowerCase();
  const repeat = mode === 'daily' || mode === 'weekly' ? mode : 'none';
  const clampRun = (ms, label) => {
    if (!Number.isFinite(ms)) throw new ReminderError(`${label}时间无法解析`);
    if (ms < nowMs + rcfg.minLeadMs) throw new ReminderError(`${label}时间太近：至少要在 ${Math.round(rcfg.minLeadMs / 1000)} 秒之后`);
    if (ms > nowMs + rcfg.maxHorizonMs) throw new ReminderError(`${label}时间太远：最多 ${Math.round(rcfg.maxHorizonMs / DAY)} 天以内`);
    return ms;
  };

  let firstRunAt;
  let clock = null;
  let weekday = null;

  if (repeat === 'none') {
    if (input.delaySeconds !== undefined && input.delaySeconds !== null && String(input.delaySeconds).trim() !== '') {
      const sec = Number(input.delaySeconds);
      if (!Number.isFinite(sec)) throw new ReminderError('delaySeconds 必须是数字');
      firstRunAt = clampRun(nowMs + Math.round(sec * 1000), '触发');
    } else {
      const atRaw = input.at ?? input.time ?? input.when;
      if (atRaw === undefined || atRaw === null || String(atRaw).trim() === '') {
        throw new ReminderError('一次性提醒需要 at（绝对时间）或 delaySeconds（相对秒数）之一');
      }
      const atText = String(atRaw).trim();
      const clockOnly = parseClock(atText);
      if (clockOnly) {
        // 只给 HH:MM：按今天/明天理解（都早于当前时间就落到明天）
        firstRunAt = clampRun(nextDailyMs(clockOnly, nowMs, { minLeadMs: 0 }), '触发');
      } else {
        const ms = Date.parse(atText);
        if (!Number.isFinite(ms)) throw new ReminderError('at 无法解析，请用 ISO 时间（带时区或 Z）或 HH:MM');
        firstRunAt = clampRun(ms, '触发');
      }
    }
  } else {
    clock = parseClock(input.clock ?? input.time ?? input.at);
    if (!clock) throw new ReminderError(`${repeat} 需要 clock（或 time/at）字段，格式 HH:MM`);
    if (repeat === 'weekly') {
      const wd = Number(input.weekday ?? input.dayOfWeek);
      if (!Number.isInteger(wd) || wd < 1 || wd > 7) throw new ReminderError('weekly 需要 weekday（1=周一 … 7=周日）');
      weekday = wd;
      firstRunAt = clampRun(nextWeeklyMs(weekday, clock, nowMs, { minLeadMs: rcfg.minLeadMs }), '首次触发');
    } else {
      firstRunAt = clampRun(nextDailyMs(clock, nowMs, { minLeadMs: rcfg.minLeadMs }), '首次触发');
    }
  }

  return {
    key: `${kind}:${targetId}`,
    kind,
    targetId,
    type: text ? 'text' : 'prompt',
    text: text || null,
    prompt: prompt || null,
    repeat,
    clock: clock ? `${String(clock.h).padStart(2, '0')}:${String(clock.mi).padStart(2, '0')}` : null,
    weekday,
    firstRunAt,
    createdBy: String(input.createdBy ?? '').trim().slice(0, 40) || null,
  };
}

/** 一次触发成功后，算下一次该响的时间（周期任务）；一次性任务返回 null。 */
export function computeNextRun(rem, afterMs, { tz = REMINDER_TZ } = {}) {
  if (rem.repeat !== 'daily' && rem.repeat !== 'weekly') return null;
  const clock = parseClock(rem.clock);
  if (!clock) return null;
  if (rem.repeat === 'daily') return nextDailyMs(clock, afterMs, { tz });
  return nextWeeklyMs(Number(rem.weekday) || 1, clock, afterMs, { tz });
}

export function describeReminder(rem, nowMs = Date.now()) {
  const when = rem.nextRunAt ? formatInZone(rem.nextRunAt) : '—';
  const how = rem.repeat === 'daily' ? `每天 ${rem.clock}` : rem.repeat === 'weekly' ? `每周${'一二三四五六日'[Number(rem.weekday) - 1]} ${rem.clock}` : '一次性';
  const what = rem.type === 'text' ? `文字「${String(rem.text).slice(0, 24)}${String(rem.text).length > 24 ? '…' : ''}」` : 'AI 自己组织措辞';
  return `${rem.id} | ${rem.key} | ${how} | 下次 ${when} | ${what} | ${rem.status}${rem.status === 'pending' && rem.nextRunAt && rem.nextRunAt < nowMs ? '（已逾期待触发）' : ''}`;
}

// ── 存储 ──────────────────────────────────────────────────────────────────

const STATUSES = new Set(['pending', 'firing', 'error', 'missed', 'cancelled', 'done']);
// 结束态记录的保留策略：最多 200 条、最多 30 天，超出即丢弃（只影响历史列表，不影响待触发任务）。
const FINISHED_KEEP = 200;
const FINISHED_TTL_MS = 30 * DAY;

export class ReminderStore {
  constructor({ file, cfg, now = () => Date.now() }) {
    this.file = file;
    this.cfg = cfg;
    this.now = now;
    this.reminders = [];
    // 每个会话最近一次提醒触发时间，用于 minGapMs 防刷屏（持久化，重启后仍然生效）
    this.lastFireByKey = {};
    this.dirty = false;
    this.lastError = null;
  }

  get rcfg() {
    return reminderCfg(this.cfg);
  }

  load() {
    this.reminders = [];
    this.lastFireByKey = {};
    let raw = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') this.lastError = `读取 reminders.json 失败：${error?.message ?? error}`;
      return { loaded: 0, recovered: 0, error: this.lastError };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // 文件坏了不能静默丢弃：备份一份，下次排查时还在。
      const bak = `${this.file}.corrupt-${Date.now()}`;
      try { fs.renameSync(this.file, bak); } catch {}
      this.lastError = `reminders.json 损坏，已备份到 ${path.basename(bak)}：${error?.message ?? error}`;
      return { loaded: 0, recovered: 0, error: this.lastError };
    }
    const list = Array.isArray(parsed?.reminders) ? parsed.reminders : [];
    let recovered = 0;
    const nowMs = this.now();
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const rem = {
        id: String(item.id ?? '').trim(),
        key: String(item.key ?? '').trim(),
        kind: item.kind === 'group' ? 'group' : 'private',
        targetId: Number(item.targetId) || 0,
        type: item.type === 'prompt' ? 'prompt' : 'text',
        text: item.text == null ? null : String(item.text),
        prompt: item.prompt == null ? null : String(item.prompt),
        repeat: item.repeat === 'daily' || item.repeat === 'weekly' ? item.repeat : 'none',
        clock: item.clock ? String(item.clock) : null,
        weekday: Number(item.weekday) || null,
        nextRunAt: Number(item.nextRunAt) || 0,
        createdAt: Number(item.createdAt) || nowMs,
        createdBy: item.createdBy ? String(item.createdBy) : null,
        status: STATUSES.has(item.status) ? item.status : 'pending',
        attempts: Number(item.attempts) || 0,
        lastAttemptAt: Number(item.lastAttemptAt) || 0,
        lastFiredAt: Number(item.lastFiredAt) || 0,
        lastError: item.lastError ? String(item.lastError) : null,
        fires: Number(item.fires) || 0,
      };
      if (!rem.id || !KEY_RE.test(rem.key)) continue;
      // 待触发的条目必须有合法的 nextRunAt，否则它永远不会响，留在列表里只会误导。
      if ((rem.status === 'pending' || rem.status === 'firing') && !rem.nextRunAt) {
        rem.status = 'error';
        rem.lastError = '记录缺少 nextRunAt，已标记为异常';
        recovered += 1;
      }
      // 崩溃恢复：正处在 firing 的条目=发送结果未知。不重发（避免重复刷屏），记 error。
      if (rem.status === 'firing') {
        rem.status = 'error';
        rem.lastError = '桥接在发送过程中重启，发送结果未知；为避免重复发送，本次不再补发（可取消后重建）';
        recovered += 1;
      }
      this.reminders.push(rem);
    }
    // 结束态（done/cancelled/error/missed）只保留最近的，避免文件无限增长。
    const finished = this.reminders
      .filter((r) => r.status !== 'pending' && r.status !== 'firing')
      .sort((a, b) => (b.lastFiredAt || b.createdAt) - (a.lastFiredAt || a.createdAt));
    const keepFinished = new Set(finished.slice(0, FINISHED_KEEP).map((r) => r.id));
    const pruned = this.reminders.length;
    this.reminders = this.reminders.filter((r) => {
      if (r.status === 'pending' || r.status === 'firing') return true;
      const at = r.lastFiredAt || r.createdAt || 0;
      return keepFinished.has(r.id) && nowMs - at <= FINISHED_TTL_MS;
    });
    if (this.reminders.length !== pruned) this.dirty = true;

    const fires = parsed?.lastFireByKey;
    if (fires && typeof fires === 'object') {
      for (const [k, v] of Object.entries(fires)) {
        const n = Number(v);
        if (KEY_RE.test(k) && Number.isFinite(n) && n > 0) this.lastFireByKey[k] = n;
      }
    }
    if (recovered) this.dirty = true;
    return { loaded: this.reminders.length, recovered, error: this.lastError };
  }

  save() {
    const payload = {
      version: 1,
      updatedAt: new Date(this.now()).toISOString(),
      lastFireByKey: this.lastFireByKey,
      reminders: this.reminders,
    };
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      throw error;
    }
  }

  active() {
    return this.reminders.filter((r) => r.status === 'pending' || r.status === 'firing');
  }

  add(input, { nowMs = this.now() } = {}) {
    const norm = normalizeCreate(input, { cfg: this.cfg, nowMs });
    const rcfg = this.rcfg;
    const active = this.active();
    if (active.length >= rcfg.maxActiveTotal) {
      throw new ReminderError(`待触发的提醒已达上限 ${rcfg.maxActiveTotal} 条，请先取消一些`, 429);
    }
    const mine = active.filter((r) => r.key === norm.key);
    if (mine.length >= rcfg.maxActivePerTarget) {
      throw new ReminderError(`${norm.key} 的待触发提醒已达上限 ${rcfg.maxActivePerTarget} 条`, 429);
    }
    const rem = {
      id: newReminderId(nowMs),
      ...norm,
      nextRunAt: norm.firstRunAt,
      createdAt: nowMs,
      status: 'pending',
      attempts: 0,
      lastAttemptAt: 0,
      lastFiredAt: 0,
      lastError: null,
      fires: 0,
    };
    this.reminders.push(rem);
    this.save();
    return rem;
  }

  find(id) {
    const s = String(id ?? '').trim();
    return this.reminders.find((r) => r.id === s) || null;
  }

  cancel(id) {
    const rem = this.find(id);
    if (!rem) throw new ReminderError(`没有 id=${id} 的提醒`, 404);
    if (rem.status !== 'pending' && rem.status !== 'firing') return { rem, changed: false };
    rem.status = 'cancelled';
    rem.nextRunAt = 0;
    this.save();
    return { rem, changed: true };
  }

  cancelByKey(key) {
    const k = String(key ?? '').trim();
    const hit = this.active().filter((r) => r.key === k);
    for (const r of hit) { r.status = 'cancelled'; r.nextRunAt = 0; }
    if (hit.length) this.save();
    return hit;
  }

  due(nowMs = this.now()) {
    return this.reminders
      .filter((r) => r.status === 'pending' && r.nextRunAt > 0 && r.nextRunAt <= nowMs)
      .sort((a, b) => a.nextRunAt - b.nextRunAt);
  }

  /** 触发记账：发送前落盘 firing，避免「发完就崩」导致下次重启重复发。 */
  beginFire(rem, nowMs = this.now()) {
    rem.status = 'firing';
    rem.lastAttemptAt = nowMs;
    rem.attempts += 1;
    this.save();
  }

  /** 触发成功：一次性置 done；周期任务算下一次并回到 pending。 */
  completeFire(rem, { nowMs = this.now(), messageId = null } = {}) {
    rem.fires += 1;
    rem.lastFiredAt = nowMs;
    rem.lastAttemptAt = nowMs;
    rem.lastError = null;
    this.lastFireByKey[rem.key] = nowMs;
    if (rem.repeat === 'none') {
      rem.status = 'done';
      rem.nextRunAt = 0;
    } else {
      const next = computeNextRun(rem, nowMs);
      rem.status = next ? 'pending' : 'done';
      rem.nextRunAt = next || 0;
      rem.attempts = 0;
    }
    if (messageId !== null && messageId !== undefined) rem.lastMessageId = messageId;
    this.save();
    return rem;
  }

  /** 触发失败：指数退避重试，超过 maxAttempts 记 error（不再自动重试）。 */
  failFire(rem, error, nowMs = this.now()) {    const rcfg = this.rcfg;
    rem.lastError = String(error?.message ?? error).slice(0, 300);
    if (rem.attempts >= rcfg.maxAttempts) {
      rem.status = 'error';
      rem.nextRunAt = 0;
    } else {
      rem.status = 'pending';
      const backoff = Math.min(10 * MINUTE, 30_000 * 2 ** Math.max(0, rem.attempts - 1));
      rem.nextRunAt = nowMs + backoff;
    }
    this.save();
    return rem;
  }

  /**
   * 暂缓触发（不算失败）：目标暂时不可发（模式不对/会话忙/限频/间隔未到）时用它，
   * 既不消耗重试次数，也不会把任务永久卡成 error。
   */
  postpone(rem, delayMs, reason, nowMs = this.now()) {
    rem.status = 'pending';
    rem.nextRunAt = nowMs + Math.max(1000, Math.floor(delayMs));
    if (rem.attempts > 0 && reason) rem.attempts = Math.max(0, rem.attempts - 1);
    if (reason) rem.lastError = String(reason).slice(0, 300);
    this.save();
    return rem;
  }

  /** 停机错过太久：不再补发，记 missed。 */
  markMissed(rem, reason, nowMs = this.now()) {
    rem.status = 'missed';
    rem.nextRunAt = 0;
    rem.lastError = String(reason).slice(0, 300);
    this.save();
    return rem;
  }

  /** 同一会话的最小间隔检查：返回还需等多少毫秒（0 表示可以发）。 */
  gapRemainingMs(key, nowMs = this.now()) {
    const last = Number(this.lastFireByKey[key]) || 0;
    const gap = this.rcfg.minGapMs;
    if (!last || gap <= 0) return 0;
    const elapsed = nowMs - last;
    return elapsed >= gap ? 0 : gap - elapsed;
  }

  markFiredAt(key, nowMs = this.now()) {
    this.lastFireByKey[key] = nowMs;
  }

  list({ key = null, includeInactive = false, limit = 50 } = {}) {
    const k = key ? String(key).trim() : null;
    let out = this.reminders;
    if (k) out = out.filter((r) => r.key === k);
    if (!includeInactive) out = out.filter((r) => r.status === 'pending' || r.status === 'firing');
    return out.slice().sort((a, b) => (a.nextRunAt || Infinity) - (b.nextRunAt || Infinity)).slice(0, limit);
  }

  /** 启动时清理：把早已过期的 pending 任务标成 missed（边界内由 due() 正常补发）。 */
  sweepStale(nowMs = this.now()) {
    const grace = this.rcfg.graceMs;
    let n = 0;
    for (const rem of this.reminders) {
      if (rem.status !== 'pending' || !rem.nextRunAt) continue;
      if (nowMs - rem.nextRunAt > grace) {
        rem.status = 'missed';
        rem.lastError = `错过触发时间 ${formatInZone(rem.nextRunAt)}（已超出 ${Math.round(grace / 60000)} 分钟补发窗口）`;
        rem.nextRunAt = 0;
        n += 1;
      }
    }
    if (n) this.save();
    return n;
  }
}

export { MINUTE, HOUR, DAY };
