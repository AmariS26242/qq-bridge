// 周期性主动联系（proactiveContact）：让机器人按自己的节奏，时不时给管理员递一个
// 「随便找他说句话」的轻提示——说什么由 AI 现场组织，这里只负责「什么时候该递、要不要跳过」。
//
// 与 reminder 的分工：
//   reminder     = 用户/AI 明确设过的待办，到点必须提醒，有正文；
//   proactiveContact = 没有具体待办，只是「隔一段时间给点由头」，宁可跳过也不打扰。
//
// 设计要点：
// 1. **默认全在白天**：窗口内才发（默认 10:00–23:00），窗口外一律顺延到下一个开窗时刻，
//    绝不在深夜补发——这比「准时」重要。
// 2. **最近有正常对话就跳过**：quietAfterTalkMs（默认 2 小时）内有真人/AI 往来，
//    说明对话本来就热，不需要主动插入；跳过并排下一次，不堆积。
// 3. **只递提示不递正文**：投递的是 prompt 型唤醒，AI 自己决定说什么、甚至说不说。
// 4. **可随时调参/暂停**：全部参数在 config.json 的 socialV2.proactiveContact，
//    enabled=false 立即停；bridge 每个 tick 按 mtime 重读配置。
// 5. **状态独立成文件**（state/proactive-contact.json）：下次触发时间、当天已发次数、
//    最近几条历史；文件坏了只备份重来，不影响 social-v2 主状态。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { REMINDER_TZ, zoneParts, epochFromZone, formatInZone, parseClock } from './reminders.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GRACE_MS = 30 * MINUTE; // 停机错过超过这么久就不再补发（避免半夜爬起来发一条）
const HISTORY_KEEP = 50;
const TAIL_MARGIN_MS = 5 * MINUTE; // 距离关窗不足 5 分钟就别再开口了

const KEY_RE = /^(group|private):(\d{1,12})$/;

/** 解析并夹紧 socialV2.proactiveContact 配置。 */
export function proactiveContactCfg(cfg) {
  const c = cfg?.socialV2?.proactiveContact ?? {};
  const num = (v, def, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(hi, Math.max(lo, Math.floor(n)));
  };
  const ownerQQ = String(cfg?.ownerQQ ?? '').trim();
  const rawKey = String(c.targetKey ?? '').trim();
  const targetKey = KEY_RE.test(rawKey) ? rawKey : ownerQQ ? `private:${ownerQQ}` : '';
  const start = parseClock(c.windowStart ?? '10:00') ?? parseClock('10:00');
  const end = parseWindowClock(c.windowEnd ?? '23:00', parseClock('23:00'));
  const intervalMs = num(c.intervalMs, 3 * HOUR, 5 * MINUTE, 24 * HOUR);
  return {
    enabled: c.enabled !== false,
    targetKey,
    windowStart: clockText(start),
    windowEnd: clockText(end),
    intervalMs,
    // 抖动默认半个钟头，避免每天掐着整点发、一看就是定时任务
    jitterMs: num(c.jitterMs, 30 * MINUTE, 0, intervalMs / 2),
    quietAfterTalkMs: num(c.quietAfterTalkMs, 2 * HOUR, 0, 24 * HOUR),
    tickMs: num(c.tickMs, 60_000, 10_000, 600_000),
    // 0 = 不限；窗口 13h + 3h 间隔自然就是 5 条/天，这个上限只是兜底
    maxPerDay: num(c.maxPerDay, 6, 0, 48),
    prompt: String(c.prompt ?? '随意找他说句话').slice(0, 200),
    dryRun: c.dryRun === true,
  };
}

function clockText({ h, mi }) {
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/**
 * 关窗时钟解析：在 HH:MM 之外额外接受 24:00，表示「当天结束」（等价于次日 00:00）。
 * 这样「08:00–24:00」可以直接写，不用为了表示午夜改成 start > end 的跨午夜写法。
 */
function parseWindowClock(text, def) {
  const raw = String(text ?? '').trim();
  if (raw === '24:00') return { h: 24, mi: 0 };
  return parseClock(raw) ?? def;
}

// ── 窗口计算（全部按 Asia/Shanghai 的墙上时间） ─────────────────────────────

function clockMinutes(clock) {
  return clock.h * 60 + clock.mi;
}

function minutesOfDay(ms, tz = REMINDER_TZ) {
  const p = zoneParts(ms, tz);
  return p.h * 60 + p.mi;
}

/** 时间窗是闭开区间 [start, end)；start === end 视为全天；start > end 表示跨午夜。 */
function windowShape(pc) {
  const start = parseClock(pc.windowStart) ?? { h: 10, mi: 0 };
  const end = parseWindowClock(pc.windowEnd, { h: 23, mi: 0 });
  const s = clockMinutes(start);
  const e = clockMinutes(end);
  return { start, end, s, e, allDay: s === e, crossMidnight: s > e };
}

export function inWindow(nowMs, pc, tz = REMINDER_TZ) {
  const w = windowShape(pc);
  if (w.allDay) return true;
  const m = minutesOfDay(nowMs, tz);
  return w.crossMidnight ? m >= w.s || m < w.e : m >= w.s && m < w.e;
}

function dayCandidates(nowMs, clock, tz) {
  const p = zoneParts(nowMs, tz);
  const out = [];
  for (let i = 0; i <= 3; i += 1) {
    out.push(epochFromZone({ y: p.y, mo: p.mo, d: p.d + i, h: clock.h, mi: clock.mi, s: 0 }, tz));
  }
  return out;
}

/** 下一个开窗时刻（严格晚于 nowMs；已在窗内时返回窗口结束后最近的那个开点）。 */
export function nextWindowOpenMs(nowMs, pc, tz = REMINDER_TZ) {
  const w = windowShape(pc);
  if (w.allDay) return nowMs;
  return dayCandidates(nowMs, w.start, tz).find((t) => t > nowMs) ?? nowMs + 24 * HOUR;
}

/** nowMs 所在（或最近）的关窗时刻；全天窗返回 Infinity。 */
export function windowCloseMs(nowMs, pc, tz = REMINDER_TZ) {
  const w = windowShape(pc);
  if (w.allDay) return Infinity;
  return dayCandidates(nowMs, w.end, tz).find((t) => t > nowMs) ?? Infinity;
}

/** 窗口第一次尝试的时间：开窗后 0~min(interval/6, jitter) 的随机偏移，避免整点打卡。 */
function spreadAfterOpen(nowMs, pc, rng, tz) {
  const open = nextWindowOpenMs(nowMs, pc, tz);
  const spread = Math.max(0, Math.min(pc.intervalMs / 6, pc.jitterMs || 0));
  return open + Math.round(rng() * spread);
}

/**
 * 下一次尝试的绝对时间：now + interval ± jitter。
 * 落点出了窗口（或贴着关窗），就改到下一个开窗后的一点随机偏移——既保证不深夜发，
 * 又不让每天第一条永远卡在 10:00:00。
 */
export function nextAttemptMs(nowMs, pc, rng = Math.random, tz = REMINDER_TZ) {
  const jitter = Math.min(pc.jitterMs, pc.intervalMs / 2);
  const at = nowMs + pc.intervalMs + Math.round((rng() * 2 - 1) * jitter);
  if (!inWindow(at, pc, tz)) return spreadAfterOpen(at, pc, rng, tz);
  const close = windowCloseMs(at, pc, tz);
  if (Number.isFinite(close) && close - at < TAIL_MARGIN_MS) return spreadAfterOpen(at, pc, rng, tz);
  return at;
}

/** 当天（按 Asia/Shanghai 的日历日）已过期的尝试，用于排期兜底。 */
export function startOfZoneDay(ms, tz = REMINDER_TZ) {
  const p = zoneParts(ms, tz);
  return epochFromZone({ y: p.y, mo: p.mo, d: p.d, h: 0, mi: 0, s: 0 }, tz);
}

/**
 * 纯决策函数：给定当前时刻与外部状态，返回这一 tick 该做什么。
 * @returns {{action:'fire'|'wait'|'skip', reason:string, nextRunAt:number}}
 *   fire = 该递提示了；wait = 现在不合适，往后挪一会儿再看；skip = 本次作废，直接排下一次。
 */
export function decideProactive({
  nowMs,
  pc,
  lastTalkAt = 0,
  busy = false,
  silent = false,
  paused = false,
  mode = 'reserved2',
  firedToday = 0,
  rng = Math.random,
  tz = REMINDER_TZ,
} = {}) {
  const fire = (nextRunAt) => ({ action: 'fire', reason: '到点了', nextRunAt });
  const wait = (reason, nextRunAt) => ({ action: 'wait', reason, nextRunAt });
  const skip = (reason, nextRunAt) => ({ action: 'skip', reason, nextRunAt });

  if (!pc?.enabled) return skip('未启用（socialV2.proactiveContact.enabled=false）', 0);
  if (!pc.targetKey) return wait('没有可用的 targetKey（ownerQQ 未配置）', nowMs + 10 * MINUTE);
  if (mode !== 'reserved2') return wait(`当前模式 ${mode} 不是 reserved2`, nowMs + 10 * MINUTE);
  if (paused) return wait('二代社交已暂停', nowMs + 10 * MINUTE);
  if (silent) return wait('目标处于静默模式', nowMs + 10 * MINUTE);

  // 先看窗口：窗外的一切理由都不用算，直接等开窗。
  if (!inWindow(nowMs, pc, tz)) {
    return wait(`窗口外（${pc.windowStart}–${pc.windowEnd}）`, nextWindowOpenMs(nowMs, pc, tz));
  }

  if (pc.maxPerDay > 0 && firedToday >= pc.maxPerDay) {
    return skip(`今天已发满 ${pc.maxPerDay} 条`, nextWindowOpenMs(nowMs + 1, pc, tz));
  }

  if (lastTalkAt > 0 && nowMs - lastTalkAt < pc.quietAfterTalkMs) {
    const mins = Math.ceil((nowMs - lastTalkAt) / MINUTE);
    return skip(`最近 ${mins} 分钟内有正常对话，不打断`, nextAttemptMs(nowMs, pc, rng, tz));
  }

  // 忙/静默属于「一会儿就好」，不要丢掉这次机会。
  if (busy) return wait('会话正忙', nowMs + 5 * MINUTE);

  return fire(nextAttemptMs(nowMs, pc, rng, tz));
}

/** 递给 AI 的轻提示：只说清「不是别人找你，是你自己想开口」，正文由它现场组织。 */
export function buildProactivePrompt(pc, nowMs = Date.now(), tz = REMINDER_TZ) {
  const when = formatInZone(nowMs, tz);
  return [
    '【随口一句】',
    '不是有人找你，也没有谁在等你回复——就是你自己这会儿想冒个泡。',
    `现在是 ${when}（${tz}）。${pc.prompt || '随意找他说句话'}`,
    '自然点：接个之前没聊完的话头，或者分享个刚看到的小东西，一两句就够；别解释你为什么突然开口，也别说「主动联系」「定时」「提醒」这类词。',
    '不想说也可以不说，扫一眼最近的消息就够了。',
  ].join('\n');
}

// ── 状态存储 ────────────────────────────────────────────────────────────────

export class ProactiveContactStore {
  constructor({ file, cfg, now = () => Date.now() }) {
    this.file = file;
    this.cfg = cfg;
    this.now = now;
    this.state = {
      version: 1,
      targetKey: '',
      nextRunAt: 0,
      lastFireAt: 0,
      lastResult: null,
      lastSkip: null,
      history: [],
    };
    this.lastError = null;
  }

  get pcfg() {
    return proactiveContactCfg(this.cfg);
  }

  load() {
    this.lastError = null;
    let raw = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') this.lastError = `读取 proactive-contact.json 失败：${error?.message ?? error}`;
      return { loaded: false, reset: true, stale: false, error: this.lastError };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const bak = `${this.file}.corrupt-${Date.now()}`;
      try { fs.renameSync(this.file, bak); } catch {}
      this.lastError = `proactive-contact.json 损坏，已备份到 ${path.basename(bak)}：${error?.message ?? error}`;
      return { loaded: false, reset: true, stale: false, error: this.lastError };
    }
    if (!parsed || typeof parsed !== 'object') return { loaded: false, reset: true, stale: false, error: null };

    const next = Number(parsed.nextRunAt);
    this.state = {
      version: 1,
      targetKey: String(parsed.targetKey ?? ''),
      nextRunAt: Number.isFinite(next) && next > 0 ? next : 0,
      lastFireAt: Number(parsed.lastFireAt) || 0,
      lastResult: typeof parsed.lastResult === 'string' ? parsed.lastResult : null,
      lastSkip: parsed.lastSkip && typeof parsed.lastSkip === 'object' ? parsed.lastSkip : null,
      history: Array.isArray(parsed.history) ? parsed.history.filter((h) => h && typeof h === 'object').slice(-HISTORY_KEEP) : [],
    };
    // 停机太久：这条排期已经过时。置 0 让调用方按「现在」重排，避免一启动就补发。
    let stale = false;
    if (this.state.nextRunAt && this.state.nextRunAt < this.now() - GRACE_MS) {
      this.state.nextRunAt = 0;
      stale = true;
    }
    return { loaded: true, reset: false, stale, error: null };
  }

  save() {
    const payload = { ...this.state, version: 1, updatedAt: new Date(this.now()).toISOString() };
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return true;
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      this.lastError = `写 proactive-contact.json 失败：${error?.message ?? error}`;
      return false;
    }
  }

  /** 目标变了（换号/换群）就整份重来，别把旧排期带过去。 */
  ensureTarget(targetKey) {
    if (this.state.targetKey === targetKey) return false;
    this.state.targetKey = targetKey;
    this.state.nextRunAt = 0;
    this.state.lastFireAt = 0;
    this.state.lastResult = null;
    this.state.lastSkip = null;
    this.state.history = [];
    return true;
  }

  setNext(ms) {
    this.state.nextRunAt = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : 0;
  }

  /** 当天（日历日）已成功递出的条数。 */
  firedToday(nowMs, tz = REMINDER_TZ) {
    const dayStart = startOfZoneDay(nowMs, tz);
    const dayEnd = startOfZoneDay(nowMs + 24 * HOUR + HOUR, tz);
    return this.state.history.filter((h) => {
      if (h.action !== 'fire') return false;
      const at = Number(h.at) || 0;
      return at >= dayStart && at < dayEnd;
    }).length;
  }

  recordFire(nowMs, { result = 'sent' } = {}) {
    this.state.lastFireAt = nowMs;
    this.state.lastResult = result;
    this.pushHistory({ at: nowMs, action: 'fire', reason: result });
  }

  recordSkip(nowMs, reason) {
    this.state.lastSkip = { at: nowMs, reason: String(reason ?? '') };
    this.pushHistory({ at: nowMs, action: 'skip', reason: String(reason ?? '') });
  }

  pushHistory(entry) {
    this.state.history.push(entry);
    if (this.state.history.length > HISTORY_KEEP) this.state.history = this.state.history.slice(-HISTORY_KEEP);
  }
}
