// 提醒「提前说一句」：在提醒到点前 N 分钟，主动开口铺垫一句。
//
// 为什么要单独一层：定时提醒本身（reminders.js）是「到点了必须发」的硬承诺，
// 而这一层是「到点前先露个面」的软提示，两者的失败语义完全不同 ——
// 软提示没发出去不算事故，所以它有自己的每日上限、静默时段、去重记录，
// 且任何失败都只记日志、绝不影响到点那一条。
//
// 设计约束（见 项目计划/07-候选项目清单.md 的 ⑨）：
//   - 只在「提醒属于主人私聊/白名单会话」时播报（由调用方先过滤）；
//   - 同一场提醒只播一次（按 id + nextRunAt 去重，周期提醒每轮到点前可再播）；
//   - 最多同时提醒最近的一条，避免一次报一串；
//   - 刚聊过（quietAfterTalkMs 内）就等一等，别在正聊着的时候插话；
//   - 静默、睡眠、暂停、非 reserved2 模式一律不开口。
import fs from 'node:fs';
import path from 'node:path';

import { REMINDER_TZ, epochFromZone, formatInZone, parseClock, zoneParts } from './reminders.js';

const MINUTE = 60 * 1000;

export const NUDGE_DEFAULTS = Object.freeze({
  enabled: true,
  leadMs: 10 * MINUTE, // 到点前多少分钟播报
  maxPerDay: 3, // 0 = 不限
  windowStart: '09:00',
  windowEnd: '23:00',
  quietAfterTalkMs: 15 * MINUTE
});

const NUDGE_HISTORY_KEEP = 100;
const NUDGE_RECORDS_KEEP = 500;
const NUDGE_RECORD_TTL_MS = 7 * 24 * 60 * MINUTE;

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clock(v, fallback) {
  const s = String(v ?? '').trim();
  if (s === '24:00') return '24:00';
  const p = parseClock(s);
  return p ? `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}` : fallback;
}

/** 把 config.socialV2.reminder.nudge 规整成安全值（坏值一律退回默认）。 */
export function normalizeReminderNudge(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const maxPerDay = Math.trunc(num(src.maxPerDay, NUDGE_DEFAULTS.maxPerDay));
  return {
    enabled: src.enabled !== false,
    leadMs: clamp(num(src.leadMs, NUDGE_DEFAULTS.leadMs), MINUTE, 60 * MINUTE),
    maxPerDay: clamp(maxPerDay, 0, 10),
    windowStart: clock(src.windowStart, NUDGE_DEFAULTS.windowStart),
    windowEnd: clock(src.windowEnd, NUDGE_DEFAULTS.windowEnd),
    quietAfterTalkMs: clamp(num(src.quietAfterTalkMs, NUDGE_DEFAULTS.quietAfterTalkMs), 0, 6 * 60 * MINUTE)
  };
}

export function reminderNudgeCfg(cfg) {
  return normalizeReminderNudge(cfg?.socialV2?.reminder?.nudge);
}

function clockMinutes(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) return null;
  return h * 60 + mi;
}

function nowMinutes(ms, tz) {
  const p = zoneParts(ms, tz);
  return p.h * 60 + p.mi;
}

/** 当前是否在允许开口的时间窗内。支持 windowEnd='24:00'。 */
export function inNudgeWindow(nowMs, nudge, tz = REMINDER_TZ) {
  const start = clockMinutes(nudge.windowStart);
  const end = clockMinutes(nudge.windowEnd);
  if (start == null || end == null) return true;
  const cur = nowMinutes(nowMs, tz);
  if (start === end) return true;
  if (start < end) return cur >= start && cur < end;
  // 跨午夜
  return cur >= start || cur < end;
}

export function startOfZoneDay(ms, tz = REMINDER_TZ) {
  const p = zoneParts(ms, tz);
  return epochFromZone({ y: p.y, mo: p.mo, d: p.d }, tz);
}

/** 下一次窗口开启的时间点（用于告诉调用方「什么时候再来看看」）。 */
export function nextNudgeWindowOpenMs(nowMs, nudge, tz = REMINDER_TZ) {
  const start = clockMinutes(nudge.windowStart);
  if (start == null) return nowMs + MINUTE;
  const p = zoneParts(nowMs, tz);
  const candidates = [0, 1, 2].map((d) => epochFromZone({ y: p.y, mo: p.mo, d: p.d + d, h: Math.floor(start / 60), mi: start % 60 }, tz));
  return candidates.find((ms) => ms > nowMs) ?? nowMs + 24 * 60 * MINUTE;
}

/** 一条提醒「这一次触发」的唯一标识：周期提醒换了 nextRunAt 就能再播一次。 */
export function nudgeKey(rem) {
  if (!rem) return '';
  return `${rem.id ?? ''}@${rem.nextRunAt ?? 0}`;
}

/**
 * 决定这一 tick 要不要提前开口。
 * 纯函数：不读文件、不看时钟（nowMs 由调用方给），方便单测。
 *
 * @returns {{action:'fire'|'wait'|'skip', reason:string, reminder?:object, minutes?:number, nextCheckAt?:number}}
 */
export function decideReminderNudge({
  nowMs = Date.now(),
  nudge,
  reminders = [],
  lastTalkAt = 0,
  busy = false,
  silent = false,
  paused = false,
  mode = '',
  firedToday = 0,
  seen = [],
  tz = REMINDER_TZ
} = {}) {
  const cfgN = normalizeReminderNudge(nudge);
  if (!cfgN.enabled) return { action: 'skip', reason: '提前播报已关闭' };
  if (mode !== 'reserved2') return { action: 'skip', reason: '非 reserved2 模式' };
  if (paused) return { action: 'skip', reason: '已暂停' };
  if (!inNudgeWindow(nowMs, cfgN, tz)) {
    return { action: 'skip', reason: `不在可开口时段（${cfgN.windowStart}-${cfgN.windowEnd}）`, nextCheckAt: nextNudgeWindowOpenMs(nowMs, cfgN, tz) };
  }
  if (cfgN.maxPerDay > 0 && firedToday >= cfgN.maxPerDay) {
    return { action: 'skip', reason: `已达每日上限 ${cfgN.maxPerDay} 条`, nextCheckAt: startOfZoneDay(nowMs, tz) + 24 * 60 * MINUTE };
  }

  const seenSet = new Set(Array.isArray(seen) ? seen.map(String) : []);
  const candidates = reminders
    .filter((rem) => rem && rem.status === 'pending' && Number(rem.nextRunAt) > 0)
    .filter((rem) => {
      const delta = Number(rem.nextRunAt) - nowMs;
      return delta > 0 && delta <= cfgN.leadMs;
    })
    .filter((rem) => !seenSet.has(nudgeKey(rem)))
    .sort((a, b) => Number(a.nextRunAt) - Number(b.nextRunAt));

  if (!candidates.length) return { action: 'skip', reason: '没有即将到点的提醒' };

  const reminder = candidates[0];
  const minutes = Math.max(1, Math.ceil((Number(reminder.nextRunAt) - nowMs) / MINUTE));

  if (lastTalkAt > 0 && nowMs - lastTalkAt < cfgN.quietAfterTalkMs) {
    return { action: 'wait', reason: '刚聊过，缓一缓', reminder, minutes, nextCheckAt: lastTalkAt + cfgN.quietAfterTalkMs };
  }
  if (busy) return { action: 'wait', reason: '会话正忙', reminder, minutes, nextCheckAt: nowMs + MINUTE };
  if (silent) return { action: 'skip', reason: '当前安静时段/被静默', reminder, minutes, nextCheckAt: nowMs + 5 * MINUTE };

  return { action: 'fire', reason: '提醒快到了，提前垫一句', reminder, minutes, nextCheckAt: Number(reminder.nextRunAt) };
}

/** 提前播报的提示词：语气对齐 buildReminderPromptV2（「你自己设的提醒」）。 */
export function buildReminderNudgePrompt(rem, { nowMs = Date.now(), minutes = 10, tz = REMINDER_TZ } = {}) {
  const lines = [];
  lines.push(`【提醒快到了 · 还有约 ${minutes} 分钟】`);
  lines.push(`- 提醒：${rem?.title ? `「${rem.title}」` : ''}${rem?.text ? `内容「${rem.text}」` : rem?.prompt ? `要做的「${rem.prompt}」` : '（无内容）'}`);
  lines.push(`- 到点时间：${rem?.nextRunAt ? formatInZone(Number(rem.nextRunAt), tz) : '（未知）'}（现在 ${formatInZone(nowMs, tz)}）`);
  lines.push('- 这是你自己设的提醒，不是有人找你，也不要提「系统/定时任务」这类词。');
  lines.push('- 现在可以顺口垫一句，比如「过一会儿该 X 了，别忘」这种轻的量；不用把提醒内容全说完，也别还没到点就催得很急。');
  lines.push('- 如果觉得此刻不适合开口（对方在忙、刚聊过别的、没必要），可以什么都不说，等到点那条再说 —— 提前这句是可选的。');
  lines.push('- 说完记得收尾（qq_mark_read 或按需调整唤醒配置），到点那条提醒会照常触发。');
  return lines.join('\n');
}

/** 提前播报的持久状态（去重 + 每日计数 + 最近记录）。 */
export class ReminderNudgeStore {
  constructor({ file, now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.state = { version: 1, updatedAt: 0, nudged: [], history: [] };
  }

  _empty() {
    return { version: 1, updatedAt: 0, nudged: [], history: [] };
  }

  _prune() {
    const nowMs = this.now();
    const nudged = Array.isArray(this.state.nudged) ? this.state.nudged : [];
    this.state.nudged = nudged
      .filter((r) => r && nowMs - Number(r.at ?? 0) < NUDGE_RECORD_TTL_MS)
      .slice(-NUDGE_RECORDS_KEEP);
    const history = Array.isArray(this.state.history) ? this.state.history : [];
    this.state.history = history.slice(-NUDGE_HISTORY_KEEP);
  }

  load() {
    this._prune();
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') throw new Error('状态文件结构不对');
      this.state = {
        version: 1,
        updatedAt: Number(data.updatedAt ?? 0),
        nudged: Array.isArray(data.nudged) ? data.nudged : [],
        history: Array.isArray(data.history) ? data.history : []
      };
      this._prune();
      return { loaded: true, error: null, nudged: this.state.nudged.length, history: this.state.history.length };
    } catch (error) {
      if (error?.code === 'ENOENT') return { loaded: false, error: null, nudged: 0, history: 0 };
      // 坏了就备份再重来：宁可少播一次，也不能让 bridge 起不来
      let backup = null;
      try {
        backup = `${this.file}.corrupt-${Date.now()}`;
        fs.renameSync(this.file, backup);
      } catch {
        backup = null;
      }
      this.state = this._empty();
      return { loaded: false, reset: true, backup, error: `状态文件损坏，已重置：${error?.message ?? error}` };
    }
  }

  save() {
    this._prune();
    this.state.updatedAt = this.now();
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return true;
  }

  seen(rem) {
    const k = nudgeKey(rem);
    if (!k) return false;
    return (this.state.nudged ?? []).some((r) => r && nudgeKey({ id: r.id, nextRunAt: r.runAt }) === k);
  }

  seenKeys() {
    return (this.state.nudged ?? []).map((r) => nudgeKey({ id: r.id, nextRunAt: r.runAt })).filter(Boolean);
  }

  markNudged(rem, nowMs = this.now()) {
    const k = nudgeKey(rem);
    if (!k) return false;
    if (this.seen(rem)) return false;
    this.state.nudged.push({ id: String(rem.id ?? ''), runAt: Number(rem.nextRunAt ?? 0), key: String(rem.key ?? ''), at: Number(nowMs) });
    this._prune();
    this.save();
    return true;
  }

  unmark(rem) {
    const k = nudgeKey(rem);
    const before = this.state.nudged.length;
    this.state.nudged = (this.state.nudged ?? []).filter((r) => nudgeKey({ id: r.id, nextRunAt: r.runAt }) !== k);
    if (this.state.nudged.length === before) return false;
    this.save();
    return true;
  }

  _push(entry) {
    this.state.history.push(entry);
    this._prune();
    this.save();
  }

  recordFire(nowMs, rem, extra = {}) {
    this._push({ at: Number(nowMs), action: 'fire', id: String(rem?.id ?? ''), runAt: Number(rem?.nextRunAt ?? 0), minutes: extra.minutes ?? null });
  }

  recordSkip(nowMs, rem, reason) {
    this._push({ at: Number(nowMs), action: 'skip', id: String(rem?.id ?? ''), runAt: Number(rem?.nextRunAt ?? 0), reason: String(reason ?? '') });
  }

  /** 当天（Asia/Shanghai 日历日）成功播报了几次。 */
  firedToday(nowMs = this.now(), tz = REMINDER_TZ) {
    const dayStart = startOfZoneDay(nowMs, tz);
    return (this.state.history ?? []).filter((h) => h && h.action === 'fire' && Number(h.at ?? 0) >= dayStart).length;
  }
}
