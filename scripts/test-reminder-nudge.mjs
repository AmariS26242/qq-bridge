// ⑨「提醒到点前提前说一句」的离线单测：纯函数 + 状态文件，不启动 bridge、不联网。
//   node --test scripts/test-reminder-nudge.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { epochFromZone } from '../src/reminders.js';
import {
  NUDGE_DEFAULTS,
  ReminderNudgeStore,
  buildReminderNudgePrompt,
  decideReminderNudge,
  inNudgeWindow,
  nextNudgeWindowOpenMs,
  nudgeKey,
  normalizeReminderNudge,
  reminderNudgeCfg,
  startOfZoneDay
} from '../src/reminder-nudge.js';

const MINUTE = 60 * 1000;
const T0 = epochFromZone({ y: 2026, mo: 10, d: 24, h: 10, mi: 0 }); // 2026-10-24 10:00 Asia/Shanghai

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-nudge-test-'));
  return path.join(dir, 'reminder-nudge.json');
}

function rem(over = {}) {
  return { id: 'rm-1', key: 'private:100000001', status: 'pending', type: 'text', text: '喝水', nextRunAt: T0 + 8 * MINUTE, repeat: 'none', ...over };
}

function decide(patch = {}) {
  return decideReminderNudge({
    nowMs: T0,
    nudge: NUDGE_DEFAULTS,
    mode: 'reserved2',
    reminders: [rem()],
    ...patch
  });
}

test('配置：默认值可用，坏值夹紧', () => {
  const d = normalizeReminderNudge(null);
  assert.equal(d.enabled, true);
  assert.equal(d.leadMs, 10 * MINUTE);
  assert.equal(d.maxPerDay, 3);
  assert.equal(d.windowStart, '09:00');
  assert.equal(d.windowEnd, '23:00');

  const clamp = normalizeReminderNudge({ enabled: false, leadMs: 1, maxPerDay: 99, windowStart: '25:00', windowEnd: '24:00', quietAfterTalkMs: -1 });
  assert.equal(clamp.enabled, false);
  assert.equal(clamp.leadMs, MINUTE, 'leadMs 最小 1 分钟');
  assert.equal(clamp.maxPerDay, 10, 'maxPerDay 最大 10');
  assert.equal(clamp.windowStart, '09:00', '坏时间退回默认');
  assert.equal(clamp.windowEnd, '24:00', '24:00 允许');
  assert.equal(clamp.quietAfterTalkMs, 0);

  assert.equal(normalizeReminderNudge({ leadMs: 99 * 60 * MINUTE }).leadMs, 60 * MINUTE, 'leadMs 最大 60 分钟');
  assert.equal(normalizeReminderNudge({ maxPerDay: -3 }).maxPerDay, 0);
  assert.equal(normalizeReminderNudge({ windowStart: '8:05' }).windowStart, '08:05', '补零');
  assert.equal(reminderNudgeCfg({ socialV2: { reminder: { nudge: { leadMs: 5 * MINUTE } } } }).leadMs, 5 * MINUTE);
  assert.equal(reminderNudgeCfg({}).leadMs, 10 * MINUTE);
});

test('时间窗：普通窗口 / 跨午夜 / 起止相同', () => {
  assert.equal(inNudgeWindow(T0, NUDGE_DEFAULTS), true);
  assert.equal(inNudgeWindow(epochFromZone({ y: 2026, mo: 10, d: 24, h: 8, mi: 30 }), NUDGE_DEFAULTS), false);
  assert.equal(inNudgeWindow(epochFromZone({ y: 2026, mo: 10, d: 24, h: 23, mi: 30 }), NUDGE_DEFAULTS), false);
  const cross = normalizeReminderNudge({ windowStart: '22:00', windowEnd: '02:00' });
  assert.equal(inNudgeWindow(epochFromZone({ y: 2026, mo: 10, d: 24, h: 23, mi: 0 }), cross), true);
  assert.equal(inNudgeWindow(epochFromZone({ y: 2026, mo: 10, d: 24, h: 1, mi: 0 }), cross), true);
  assert.equal(inNudgeWindow(epochFromZone({ y: 2026, mo: 10, d: 24, h: 12, mi: 0 }), cross), false);
  const allDay = normalizeReminderNudge({ windowStart: '00:00', windowEnd: '00:00' });
  assert.equal(inNudgeWindow(T0, allDay), true, '起止相同视为全天');

  const open = nextNudgeWindowOpenMs(epochFromZone({ y: 2026, mo: 10, d: 24, h: 8, mi: 0 }), NUDGE_DEFAULTS);
  assert.equal(open, epochFromZone({ y: 2026, mo: 10, d: 24, h: 9, mi: 0 }), '08:00 时应等到今天 09:00');
});

test('决策：开关 / 模式 / 暂停 优先于一切', () => {
  assert.equal(decide({ nudge: { ...NUDGE_DEFAULTS, enabled: false } }).action, 'skip');
  assert.match(decide({ nudge: { ...NUDGE_DEFAULTS, enabled: false } }).reason, /关闭/);
  assert.match(decide({ mode: 'reserved' }).reason, /reserved2/);
  assert.match(decide({ paused: true }).reason, /暂停/);
});

test('决策：窗口外与每日上限', () => {
  const night = decide({ nowMs: epochFromZone({ y: 2026, mo: 10, d: 24, h: 23, mi: 30 }), reminders: [rem({ nextRunAt: epochFromZone({ y: 2026, mo: 10, d: 24, h: 23, mi: 35 }) })] });
  assert.equal(night.action, 'skip');
  assert.match(night.reason, /时段/);
  assert.ok(night.nextCheckAt > 0, '应给出下一次可开口时间');

  const capped = decide({ firedToday: 3 });
  assert.equal(capped.action, 'skip');
  assert.match(capped.reason, /上限/);
  assert.equal(capped.nextCheckAt, startOfZoneDay(T0) + 24 * 60 * MINUTE);

  assert.equal(decide({ firedToday: 2 }).action, 'fire', '未到上限仍可播');
  assert.equal(decide({ nudge: { ...NUDGE_DEFAULTS, maxPerDay: 0 }, firedToday: 99 }).action, 'fire', '0 = 不限');
});

test('决策：lead 边界与候选选取', () => {
  assert.equal(decide({ reminders: [] }).action, 'skip');
  assert.match(decide({ reminders: [] }).reason, /没有即将到点/);

  // 刚好 10 分钟：算
  assert.equal(decide({ reminders: [rem({ nextRunAt: T0 + 10 * MINUTE })] }).action, 'fire');
  // 超过 10 分钟：不算
  assert.equal(decide({ reminders: [rem({ nextRunAt: T0 + 10 * MINUTE + 1000 })] }).action, 'skip');
  // 已经到点（<=0）：不算（准点那条归 reminders 自己发）
  assert.equal(decide({ reminders: [rem({ nextRunAt: T0 - MINUTE })] }).action, 'skip');
  // 非 pending：不算
  assert.equal(decide({ reminders: [rem({ status: 'firing' })] }).action, 'skip');
  // 已播过：不算
  const done = rem();
  assert.equal(decide({ seen: [nudgeKey(done)] }).action, 'skip');

  // 多条候选取最早，并且带上分钟数
  const late = rem({ id: 'rm-late', nextRunAt: T0 + 9 * MINUTE });
  const early = rem({ id: 'rm-early', nextRunAt: T0 + 3 * MINUTE });
  const picked = decide({ reminders: [late, early] });
  assert.equal(picked.action, 'fire');
  assert.equal(picked.reminder.id, 'rm-early');
  assert.equal(picked.minutes, 3);
});

test('决策：刚聊过 / 忙 / 静默', () => {
  const talk = decide({ lastTalkAt: T0 - 5 * MINUTE });
  assert.equal(talk.action, 'wait');
  assert.match(talk.reason, /刚聊过/);
  assert.equal(talk.nextCheckAt, T0 - 5 * MINUTE + NUDGE_DEFAULTS.quietAfterTalkMs);

  assert.equal(decide({ lastTalkAt: T0 - 30 * MINUTE }).action, 'fire', '过了静一静窗口就可以播');

  const busy = decide({ busy: true });
  assert.equal(busy.action, 'wait');
  assert.match(busy.reason, /忙/);
  assert.ok(busy.nextCheckAt > T0);

  const silent = decide({ silent: true });
  assert.equal(silent.action, 'skip');
  assert.match(silent.reason, /静默|安静/);

  // 顺序：静默与会话忙同时出现时，忙优先（下一 tick 再看），不白记一次 skip
  assert.equal(decide({ busy: true, silent: true }).action, 'wait');
});

test('提示词：像「自己设的提醒」，并明确可选', () => {
  const text = buildReminderNudgePrompt(rem(), { nowMs: T0, minutes: 8 });
  assert.match(text, /还有约 8 分钟/);
  assert.match(text, /喝水/);
  assert.match(text, /2026-10-24 10:08/);
  assert.match(text, /不是有人找你/);
  assert.match(text, /别.*系统|系统.*定时任务/);
  assert.match(text, /可选|可以什么都不说/);
  assert.match(buildReminderNudgePrompt(rem({ text: '', prompt: '给他打电话' }), { nowMs: T0, minutes: 2 }), /给他打电话/);
});

test('状态：去重、每日计数、坏文件、上限', () => {
  const file = tmpFile();
  const store = new ReminderNudgeStore({ file, now: () => T0 });
  assert.equal(store.load().loaded, false);

  const one = rem();
  assert.equal(store.seen(one), false);
  assert.equal(store.markNudged(one, T0), true);
  assert.equal(store.markNudged(one, T0 + 1000), false, '同一场提醒不重复记');
  assert.equal(store.seen(one), true);
  assert.deepEqual(store.seenKeys(), [nudgeKey(one)]);

  // 周期提醒下一轮（nextRunAt 变了）视为新的，可以再播
  const next = rem({ nextRunAt: T0 + 24 * 60 * MINUTE });
  assert.equal(store.seen(next), false);
  assert.equal(store.markNudged(next, T0 + MINUTE), true);
  assert.equal(store.state.nudged.length, 2);

  assert.equal(store.unmark(one), true);
  assert.equal(store.seen(one), false);
  assert.equal(store.unmark(one), false);

  store.recordFire(T0, next, { minutes: 8 });
  store.recordFire(T0 - 24 * 60 * MINUTE, one, { minutes: 5 });
  store.recordSkip(T0, one, '静默');
  assert.equal(store.firedToday(T0), 1, '只数当天成功的');
  assert.equal(fs.existsSync(file), true);
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(row.version, 1);
  assert.ok(row.history.length >= 3);

  // 重载后状态还在（重启不会把已播过的又播一遍）
  const reload = new ReminderNudgeStore({ file, now: () => T0 });
  reload.load();
  assert.equal(reload.seen(next), true);
  assert.equal(reload.firedToday(T0), 1);

  // 7 天前的去重记录会在加载时清掉
  const old = new ReminderNudgeStore({ file, now: () => T0 + 8 * 24 * 60 * MINUTE });
  old.load();
  assert.equal(old.seen(next), false);

  // 历史有上限
  for (let i = 0; i < 200; i += 1) store.recordSkip(T0 + i, one, `x${i}`);
  assert.ok(store.state.history.length <= 100, `history 应被截断，实际 ${store.state.history.length}`);
});

test('状态：损坏文件备份后重来，不抛异常', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ 这不是 json', 'utf8');
  const store = new ReminderNudgeStore({ file, now: () => T0 });
  const info = store.load();
  assert.equal(info.loaded, false);
  assert.equal(info.reset, true);
  assert.match(String(info.error), /损坏/);
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith('reminder-nudge.json.corrupt-')), '坏文件应留备份');
  assert.equal(store.seen(rem()), false, '重置后不应残留状态');
});
