// 定时提醒库的离线单测：不碰桥接、不碰网络，全部用假时钟与临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ReminderStore, ReminderError, normalizeCreate, reminderCfg, computeNextRun,
  zoneParts, epochFromZone, isoWeekday, nextDailyMs, nextWeeklyMs, parseClock, formatInZone,
} from '../src/reminders.js';

const MIN = 60_000;

function tmpFile(name = 'reminders.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-test-'));
  return path.join(dir, name);
}

// 2026-10-19 20:00:00 Asia/Shanghai
const T0 = Date.parse('2026-10-19T12:00:00Z');

function makeStore(cfgPatch = {}, file = tmpFile()) {
  const cfg = { socialV2: { reminder: { ...cfgPatch } } };
  let now = T0;
  const store = new ReminderStore({ file, cfg, now: () => now });
  store.load();
  store._setNow = (ms) => { now = ms; };
  store._cfg = cfg;
  return store;
}

test('时区换算：上海墙上时间 ↔ 绝对毫秒', () => {
  const p = zoneParts(T0);
  assert.deepEqual({ y: p.y, mo: p.mo, d: p.d, h: p.h, mi: p.mi }, { y: 2026, mo: 10, d: 19, h: 20, mi: 0 });
  const ms = epochFromZone({ y: 2026, mo: 10, d: 20, h: 8, mi: 30 });
  assert.equal(new Date(ms).toISOString(), '2026-10-20T00:30:00.000Z');
  assert.equal(formatInZone(ms), '2026-10-20 08:30');
  assert.equal(isoWeekday(T0), 1, '2026-10-19 是周一');
});

test('每天/每周的下一次时间点', () => {
  assert.equal(parseClock('8:05').h, 8);
  assert.equal(parseClock('24:00'), null);
  const daily = nextDailyMs({ h: 8, mi: 30 }, T0);
  assert.equal(formatInZone(daily), '2026-10-20 08:30');
  const sameDayLater = nextDailyMs({ h: 23, mi: 0 }, T0);
  assert.equal(formatInZone(sameDayLater), '2026-10-19 23:00');
  const weekly = nextWeeklyMs(5, { h: 9, mi: 0 }, T0); // 周五
  assert.equal(formatInZone(weekly), '2026-10-23 09:00');
  assert.equal(isoWeekday(weekly), 5);
});

test('校验：key / 内容二选一 / 长度', () => {
  const cfg = {};
  assert.throws(() => normalizeCreate({ key: 'bad', text: 'x', delaySeconds: 60 }, { cfg, nowMs: T0 }), ReminderError);
  assert.throws(() => normalizeCreate({ key: 'private:1' }, { cfg, nowMs: T0 }), /text.*prompt|prompt.*text/);
  assert.throws(() => normalizeCreate({ key: 'private:1', text: 'a', prompt: 'b', delaySeconds: 60 }, { cfg, nowMs: T0 }), /只能选一个/);
  assert.throws(
    () => normalizeCreate({ key: 'private:1', text: 'x'.repeat(501), delaySeconds: 60 }, { cfg, nowMs: T0 }),
    /不能超过 500 字/,
  );
  assert.throws(
    () => normalizeCreate({ key: 'private:1', text: 'a', messages: ['a', 'b'], delaySeconds: 60 }, { cfg, nowMs: T0 }),
    /只发一条/,
  );
  const ok = normalizeCreate({ key: 'private:100000001', text: '喝水', delaySeconds: 300 }, { cfg, nowMs: T0 });
  assert.equal(ok.key, 'private:100000001');
  assert.equal(ok.type, 'text');
  assert.equal(ok.repeat, 'none');
  assert.equal(ok.firstRunAt, T0 + 300_000);
});

test('校验：时间太近 / 太远 / 无法解析', () => {
  const cfg = {};
  assert.throws(() => normalizeCreate({ key: 'private:1', text: 'a', delaySeconds: -5 }, { cfg, nowMs: T0 }), /太近/);
  assert.throws(() => normalizeCreate({ key: 'private:1', text: 'a', delaySeconds: 400 * 24 * 3600 }, { cfg, nowMs: T0 }), /太远/);
  assert.throws(() => normalizeCreate({ key: 'private:1', text: 'a', at: '明天早上' }, { cfg, nowMs: T0 }), /无法解析/);
  assert.throws(() => normalizeCreate({ key: 'private:1', text: 'a' }, { cfg, nowMs: T0 }), /at（绝对时间）/);
  // 只给 HH:MM：已过点则落到明天
  const r = normalizeCreate({ key: 'private:1', text: 'a', at: '08:00' }, { cfg, nowMs: T0 });
  assert.equal(formatInZone(r.firstRunAt), '2026-10-20 08:00');
});

test('校验：周期任务', () => {
  const cfg = {};
  const d = normalizeCreate({ key: 'group:123', text: '打卡', repeat: 'daily', clock: '09:00' }, { cfg, nowMs: T0 });
  assert.equal(d.repeat, 'daily');
  assert.equal(formatInZone(d.firstRunAt), '2026-10-20 09:00');
  const w = normalizeCreate({ key: 'group:123', text: '周会', repeat: 'weekly', weekday: 3, clock: '14:00' }, { cfg, nowMs: T0 });
  assert.equal(isoWeekday(w.firstRunAt), 3);
  assert.throws(() => normalizeCreate({ key: 'group:123', text: 'x', repeat: 'weekly', clock: '14:00' }, { cfg, nowMs: T0 }), /weekday/);
  assert.throws(() => normalizeCreate({ key: 'group:123', text: 'x', repeat: 'daily' }, { cfg, nowMs: T0 }), /clock/);
});

test('存储：创建 / 上限 / 取消 / 落盘重载', () => {
  const file = tmpFile();
  const store = makeStore({}, file);
  const a = store.add({ key: 'private:100000001', text: '一', delaySeconds: 120 });
  const b = store.add({ key: 'private:100000001', text: '二', delaySeconds: 240 });
  assert.equal(store.list({ key: 'private:100000001' }).length, 2);
  // 单会话上限
  for (let i = 0; i < 8; i += 1) store.add({ key: 'private:100000001', text: `x${i}`, delaySeconds: 300 + i });
  assert.throws(() => store.add({ key: 'private:100000001', text: 'overflow', delaySeconds: 999 }), /上限 10 条/);
  // 取消
  const res = store.cancel(a.id);
  assert.equal(res.changed, true);
  assert.equal(store.cancel(a.id).changed, false);
  assert.throws(() => store.cancel('rm-nope'), /没有 id/);
  // 重载：10 条全部保留（取消的也留历史，方便排查）
  const store2 = makeStore({}, file);
  const reloaded = store2.load();
  assert.equal(reloaded.loaded, 10);
  assert.equal(reloaded.recovered, 0);
  assert.ok(store2.find(b.id), '重载后任务 id 仍在');
  assert.equal(store2.find(b.id).text, '二');
  assert.equal(store2.find(a.id).status, 'cancelled');
});

test('存储：总上限与按会话上限', () => {
  const store = makeStore({ maxActiveTotal: 3, maxActivePerTarget: 2 });
  store.add({ key: 'private:1', text: 'a', delaySeconds: 60 });
  store.add({ key: 'private:1', text: 'b', delaySeconds: 60 });
  assert.throws(() => store.add({ key: 'private:1', text: 'c', delaySeconds: 60 }), /上限 2 条/);
  store.add({ key: 'private:2', text: 'c', delaySeconds: 60 });
  assert.throws(() => store.add({ key: 'private:3', text: 'd', delaySeconds: 60 }), /已达上限 3 条/);
});

test('存储：到期 / 触发记账 / 周期任务算下一次', () => {
  const store = makeStore();
  const one = store.add({ key: 'private:1', text: '一次性', delaySeconds: 60 });
  const daily = store.add({ key: 'private:1', text: '每天', repeat: 'daily', clock: '21:00' });
  store._setNow(T0 + 30_000);
  assert.equal(store.due().length, 0, '还没到点');
  store._setNow(T0 + 61_000);
  const due = store.due();
  assert.equal(due.length, 1);
  assert.equal(due[0].id, one.id);

  store.beginFire(due[0]);
  assert.equal(store.find(one.id).status, 'firing');
  store.completeFire(store.find(one.id));
  assert.equal(store.find(one.id).status, 'done');
  assert.equal(store.find(one.id).nextRunAt, 0);
  assert.equal(store.lastFireByKey['private:1'], T0 + 61_000);

  const next = computeNextRun(store.find(daily.id), T0 + 61_000);
  assert.equal(formatInZone(next), '2026-10-19 21:00');
});

test('存储：失败退避 + 超过次数置 error', () => {
  const store = makeStore({ maxAttempts: 3 });
  const rem = store.add({ key: 'private:1', text: 'x', delaySeconds: 60 });
  let t = T0 + 61_000;
  for (let i = 1; i <= 2; i += 1) {
    store._setNow(t);
    store.beginFire(rem);
    store.failFire(rem, new Error('boom'));
    assert.equal(rem.status, 'pending');
    assert.ok(rem.nextRunAt > t, '退避后下一次时间往后推');
    t = rem.nextRunAt;
  }
  store._setNow(t);
  store.beginFire(rem);
  store.failFire(rem, new Error('boom'));
  assert.equal(rem.status, 'error');
  assert.equal(rem.nextRunAt, 0);
});

test('存储：重启时 firing 不重发、过期超窗口记 missed', () => {
  const file = tmpFile();
  const store = makeStore({}, file);
  const rem = store.add({ key: 'private:1', text: 'x', delaySeconds: 60 });
  const stale = store.add({ key: 'private:1', text: 'y', delaySeconds: 3600 });
  store.beginFire(rem);
  // 模拟崩溃：直接落盘后重新加载
  const store2 = makeStore({}, file);
  const info = store2.load();
  assert.equal(info.recovered, 1);
  const revived = store2.find(rem.id);
  assert.equal(revived.status, 'error');
  assert.match(revived.lastError, /结果未知/);

  // 停机 2 小时后重启：超过 30 分钟补发窗口 → missed
  store2._setNow(T0 + 2 * 3600_000);
  assert.equal(store2.sweepStale(), 1);
  assert.equal(store2.find(stale.id).status, 'missed');
  assert.match(store2.find(stale.id).lastError, /补发窗口/);
});

test('存储：同会话最小间隔', () => {
  const store = makeStore({ minGapMs: 120_000 });
  store.markFiredAt('private:1', T0);
  assert.equal(store.gapRemainingMs('private:1', T0 + 30_000), 90_000);
  assert.equal(store.gapRemainingMs('private:1', T0 + 121_000), 0);
  assert.equal(store.gapRemainingMs('private:2', T0 + 1_000), 0);
  // 间隔会随状态一起持久化（markFiredAt 只管内存，落盘由 save/completeFire 负责）
  const store2 = makeStore({ minGapMs: 120_000 }, store.file);
  store2.load();
  store2.lastFireByKey['private:1'] = T0;
  store2.save();
  const store3 = makeStore({ minGapMs: 120_000 }, store.file);
  store3.load();
  assert.equal(store3.gapRemainingMs('private:1', T0 + 30_000), 90_000);
});

test('配置默认值与边界收敛', () => {
  const c = reminderCfg({});
  assert.equal(c.enabled, true);
  assert.equal(c.maxActivePerTarget, 10);
  assert.equal(c.minGapMs, 120_000);
  assert.equal(c.maxAttempts, 5);
  assert.equal(c.maxTextChars, 500);
  const c2 = reminderCfg({ socialV2: { reminder: { tickMs: 1, maxActiveTotal: 99999, minGapMs: -5 } } });
  assert.equal(c2.tickMs, 5_000);
  assert.equal(c2.maxActiveTotal, 500);
  assert.equal(c2.minGapMs, 0);
  const c3 = reminderCfg({ socialV2: { reminder: { enabled: false } } });
  assert.equal(c3.enabled, false);
  assert.throws(() => normalizeCreate({ key: 'private:1', text: 'a', delaySeconds: 60 }, { cfg: { socialV2: { reminder: { enabled: false } } }, nowMs: T0 }), /已关闭/);
});
