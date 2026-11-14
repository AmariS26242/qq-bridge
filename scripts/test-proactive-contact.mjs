// 周期性主动联系的离线单测：不碰桥接、不碰网络，全部用假时钟与临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ProactiveContactStore,
  buildProactivePrompt,
  decideProactive,
  inWindow,
  nextAttemptMs,
  nextWindowOpenMs,
  proactiveContactCfg,
  startOfZoneDay,
  windowCloseMs,
} from '../src/proactive-contact.js';
import { formatInZone, zoneParts } from '../src/reminders.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const TZ = 'Asia/Shanghai';

// 2026-10-19 20:00:00 Asia/Shanghai（周一）
const T0 = Date.parse('2026-10-19T12:00:00Z');
const at = (iso) => Date.parse(iso);

function tmpFile(name = 'proactive-contact.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-test-'));
  return path.join(dir, name);
}

function makeCfg(patch = {}) {
  return {
    ownerQQ: '100000001',
    socialV2: { proactiveContact: { ...patch } },
  };
}

const pc = (patch = {}) => proactiveContactCfg(makeCfg(patch));

test('配置：默认值、owner 兜底目标、夹紧', () => {
  const c = pc();
  assert.equal(c.enabled, true);
  assert.equal(c.targetKey, 'private:100000001');
  assert.equal(c.windowStart, '10:00');
  assert.equal(c.windowEnd, '23:00');
  assert.equal(c.intervalMs, 3 * HOUR);
  assert.equal(c.jitterMs, 30 * MIN);
  assert.equal(c.quietAfterTalkMs, 2 * HOUR);
  assert.equal(c.tickMs, 60_000);
  assert.equal(c.maxPerDay, 6);
  assert.equal(c.dryRun, false);

  // 夹紧：间隔不能低于 5 分钟、抖动不超过间隔一半、maxPerDay 不为负
  const wild = pc({ intervalMs: 1000, jitterMs: 10 * HOUR, maxPerDay: -3, targetKey: 'group:123456' });
  assert.equal(wild.intervalMs, 5 * MIN);
  assert.equal(wild.jitterMs, 2.5 * MIN);
  assert.equal(wild.maxPerDay, 0);
  assert.equal(wild.targetKey, 'group:123456');

  // 非法 targetKey 一律退回 owner 私聊，避免投到任意会话
  assert.equal(pc({ targetKey: 'group:abc' }).targetKey, 'private:100000001');
  // 没有 ownerQQ 时宁可不发
  assert.equal(proactiveContactCfg({ socialV2: { proactiveContact: {} } }).targetKey, '');
});

test('窗口：白天在内、深夜在外、跨午夜也算', () => {
  assert.equal(inWindow(at('2026-10-19T02:00:00Z'), pc()), true, '10:00 开窗');
  assert.equal(inWindow(at('2026-10-19T01:59:00Z'), pc()), false, '09:59 还在窗外');
  assert.equal(inWindow(at('2026-10-19T14:59:00Z'), pc()), true, '22:59 仍在窗内');
  assert.equal(inWindow(at('2026-10-19T15:00:00Z'), pc()), false, '23:00 关窗');
  assert.equal(inWindow(at('2026-10-18T19:00:00Z'), pc()), false, '凌晨 3 点不发');

  const night = pc({ windowStart: '22:00', windowEnd: '02:00' });
  assert.equal(inWindow(at('2026-10-19T15:30:00Z'), night), true, '跨午夜窗口：23:30 在内');
  assert.equal(inWindow(at('2026-10-18T17:00:00Z'), night), true, '跨午夜窗口：01:00 仍在内');
  assert.equal(inWindow(at('2026-10-18T18:00:00Z'), night), false, '跨午夜窗口：02:00 关窗');
  assert.equal(inWindow(at('2026-10-18T19:00:00Z'), night), false, '跨午夜窗口：03:00 在外');
  assert.equal(inWindow(at('2026-10-19T04:00:00Z'), night), false, '跨午夜窗口：12:00 在外');

  const allDay = pc({ windowStart: '00:00', windowEnd: '00:00' });
  assert.equal(inWindow(at('2026-10-18T19:00:00Z'), allDay), true, 'start===end 视为全天');
});

test('窗口边界：下一个开窗时刻与关窗时刻', () => {
  // 凌晨 3 点 → 当天 10:00
  assert.equal(formatInZone(nextWindowOpenMs(at('2026-10-18T19:00:00Z'), pc())), '2026-10-19 10:00');
  // 23:30 → 次日 10:00
  assert.equal(formatInZone(nextWindowOpenMs(at('2026-10-19T15:30:00Z'), pc())), '2026-10-20 10:00');
  // 12:00 在窗内：关窗是今天 23:00
  assert.equal(formatInZone(windowCloseMs(at('2026-10-19T04:00:00Z'), pc())), '2026-10-19 23:00');
  // 全天窗没有关窗时刻
  assert.equal(windowCloseMs(T0, pc({ windowStart: '00:00', windowEnd: '00:00' })), Infinity);
});

test('排期：interval ± jitter，落窗外就推到下个开窗后随机一点', () => {
  const noon = at('2026-10-19T04:00:00Z'); // 12:00
  const mid = nextAttemptMs(noon, pc(), () => 0.5);
  assert.equal(formatInZone(mid), '2026-10-19 15:00', 'rng=0.5 时没有抖动');

  const late = nextAttemptMs(noon, pc(), () => 1);
  assert.ok(late > mid, '正向抖动应当更晚');
  assert.equal(inWindow(late, pc()), true);

  // 22:00 触发，下次落在 01:00 → 必须挪到明天 10:00 之后
  const night = nextAttemptMs(at('2026-10-19T14:00:00Z'), pc(), () => 0.5);
  assert.equal(formatInZone(night), '2026-10-20 10:15', '窗口外落点推到次日开窗 + 随机偏移');
  assert.equal(inWindow(night, pc()), true);

  // 22:20 触发：候选 01:20 也在窗外
  const lateNight = nextAttemptMs(at('2026-10-19T14:20:00Z'), pc(), () => 0.5);
  assert.equal(formatInZone(lateNight), '2026-10-20 10:15');
  // 开窗后要带一点随机，不要每天整点 10:00:00
  const jittered = nextAttemptMs(at('2026-10-19T14:20:00Z'), pc(), () => 0.9);
  assert.ok(formatInZone(jittered) > '2026-10-20 10:15', '开窗后应带偏移');
  assert.equal(inWindow(jittered, pc()), true);
});

test('决策：未启用/模式/暂停/静默/忙/窗外/聊过/超额', () => {
  const noon = at('2026-10-19T04:00:00Z');
  const p = pc();

  assert.equal(decideProactive({ nowMs: noon, pc: p, mode: 'reserved2' }).action, 'fire');
  assert.equal(decideProactive({ nowMs: noon, pc: { ...p, enabled: false } }).action, 'skip');
  assert.equal(decideProactive({ nowMs: noon, pc: p, mode: 'reserved' }).action, 'wait');
  assert.equal(decideProactive({ nowMs: noon, pc: p, paused: true }).action, 'wait');
  assert.equal(decideProactive({ nowMs: noon, pc: p, silent: true }).action, 'wait');

  const busy = decideProactive({ nowMs: noon, pc: p, busy: true });
  assert.equal(busy.action, 'wait');
  assert.equal(busy.nextRunAt, noon + 5 * MIN, '忙只顺延 5 分钟，不丢机会');

  // 凌晨 3 点：wait 到当天 10:00
  const night = decideProactive({ nowMs: at('2026-10-18T19:00:00Z'), pc: p });
  assert.equal(night.action, 'wait');
  assert.equal(formatInZone(night.nextRunAt), '2026-10-19 10:00');

  // 半小时前刚聊过：skip，并排下一次（3 小时后）
  const talked = decideProactive({ nowMs: noon, pc: p, lastTalkAt: noon - 30 * MIN, rng: () => 0.5 });
  assert.equal(talked.action, 'skip');
  assert.equal(formatInZone(talked.nextRunAt), '2026-10-19 15:00');

  // 2 小时整也算「刚聊过」（< quietAfterTalkMs 才跳过，边界外放行）
  assert.equal(decideProactive({ nowMs: noon, pc: p, lastTalkAt: noon - 2 * HOUR }).action, 'fire');
  assert.equal(decideProactive({ nowMs: noon, pc: p, lastTalkAt: noon - 2 * HOUR + 1 }).action, 'skip');

  // 当天已发满：skip 到明天开窗
  const full = decideProactive({ nowMs: noon, pc: p, firedToday: 6 });
  assert.equal(full.action, 'skip');
  assert.equal(formatInZone(full.nextRunAt), '2026-10-20 10:00');

  // maxPerDay=0 视为不限
  assert.equal(decideProactive({ nowMs: noon, pc: pc({ maxPerDay: 0 }), firedToday: 99 }).action, 'fire');
});

test('提示：轻提示只给由头，不暴露「定时/系统」', () => {
  const text = buildProactivePrompt(pc(), at('2026-10-19T04:00:00Z'));
  assert.ok(text.includes('2026-10-19 12:00'), '应带上当前时间');
  assert.ok(text.includes('随意找他说句话'), '应包含可配置的由头');
  assert.ok(!/定时任务|系统提醒|被叫醒/.test(text), '不应让 AI 说出定时/系统');
  const custom = buildProactivePrompt(pc({ prompt: '问问他午饭吃了什么' }));
  assert.ok(custom.includes('问问他午饭吃了什么'));
});

test('窗口：08:00–24:00 写法（24:00 = 当天结束，不是 00:00 起点）', () => {
  const p = pc({ windowStart: '08:00', windowEnd: '24:00', intervalMs: 30 * MIN, jitterMs: 3 * MIN, maxPerDay: 40 });
  assert.equal(p.windowStart, '08:00');
  assert.equal(p.windowEnd, '24:00', '配置要原样回显 24:00');
  assert.equal(p.intervalMs, 30 * MIN);
  assert.equal(p.jitterMs, 3 * MIN);
  assert.equal(p.maxPerDay, 40);

  assert.equal(inWindow(at('2026-10-19T00:00:00Z'), p), true, '08:00 开窗');
  assert.equal(inWindow(at('2026-10-18T23:59:00Z'), p), false, '07:59 还在窗外');
  assert.equal(inWindow(at('2026-10-19T15:59:00Z'), p), true, '23:59 仍在窗内');
  assert.equal(inWindow(at('2026-10-19T16:00:00Z'), p), false, '24:00 关窗，别滑到次日 0 点');
  assert.equal(inWindow(at('2026-10-18T16:30:00Z'), p), false, '凌晨 0:30 不发');

  // 关窗时刻正好是当晚 24:00（次日 00:00），开窗是每天 08:00
  assert.equal(formatInZone(windowCloseMs(at('2026-10-19T04:00:00Z'), p)), '2026-10-20 00:00');
  assert.equal(formatInZone(nextWindowOpenMs(at('2026-10-19T16:30:00Z'), p)), '2026-10-20 08:00');

  // 23:45 + 30 分钟 = 次日 00:15 → 窗外，推到次日开窗 + 5 分钟内的随机偏移
  assert.equal(formatInZone(nextAttemptMs(at('2026-10-19T15:45:00Z'), p, () => 0.5)), '2026-10-20 08:01');
  // 23:20 + 30 分钟 = 23:50，离关窗还有 10 分钟 → 照常允许
  assert.equal(inWindow(nextAttemptMs(at('2026-10-19T15:20:00Z'), p, () => 0.5), p), true);
  // 23:58 + 30 分钟 = 次日 00:28 → 窗外
  assert.equal(formatInZone(nextAttemptMs(at('2026-10-19T15:58:00Z'), p, () => 0.5)), '2026-10-20 08:01');

  // 写错的时钟不能悄悄变成全天：24:00 以外仍按 HH:MM 校验，非法值退回默认
  assert.equal(pc({ windowEnd: '25:00' }).windowEnd, '23:00');
  // 08:00–24:00 与 08:00–00:00 语义不同：后者是跨午夜到 0 点，也不该被当成全天
  assert.equal(inWindow(at('2026-10-19T00:00:00Z'), pc({ windowStart: '08:00', windowEnd: '00:00' })), true);
});

test('状态：落盘往返、目标变更重置、过期排期不补发、当天计数', () => {
  const file = tmpFile();
  let now = T0;
  const store = new ProactiveContactStore({ file, cfg: makeCfg(), now: () => now });

  const first = store.load();
  assert.equal(first.reset, true, '首次加载视为需要重排');

  store.ensureTarget('private:100000001');
  store.setNext(T0 + HOUR);
  store.recordFire(T0, { result: 'sent' });
  assert.equal(store.save(), true);

  const reloaded = new ProactiveContactStore({ file, cfg: makeCfg(), now: () => now });
  const info = reloaded.load();
  assert.equal(info.loaded, true);
  assert.equal(info.stale, false);
  assert.equal(reloaded.state.nextRunAt, T0 + HOUR);
  assert.equal(reloaded.state.lastFireAt, T0);

  // 停机太久（超过 30 分钟宽限）：排期清空，交给调用方重排，绝不半夜补发
  const staleFile = tmpFile();
  const staleStore = new ProactiveContactStore({ file: staleFile, cfg: makeCfg(), now: () => T0 });
  staleStore.ensureTarget('private:100000001');
  staleStore.setNext(T0 - 3 * HOUR);
  staleStore.save();
  const staleReload = new ProactiveContactStore({ file: staleFile, cfg: makeCfg(), now: () => T0 });
  const staleInfo = staleReload.load();
  assert.equal(staleInfo.stale, true);
  assert.equal(staleReload.state.nextRunAt, 0);

  // 目标变了：整份重来，不带旧排期
  assert.equal(reloaded.ensureTarget('group:999'), true);
  assert.equal(reloaded.state.nextRunAt, 0);
  assert.deepEqual(reloaded.state.history, []);
  assert.equal(reloaded.ensureTarget('group:999'), false, '同一目标不重置');

  // 当天计数只算「今天成功发出的」
  const counted = new ProactiveContactStore({ file: tmpFile(), cfg: makeCfg(), now: () => T0 });
  counted.ensureTarget('private:100000001');
  counted.recordFire(T0, { result: 'sent' });
  counted.recordFire(T0 - 24 * HOUR, { result: 'sent' }); // 昨天
  counted.recordSkip(T0 - MIN, '测试跳过');
  assert.equal(counted.firedToday(T0), 1);
  assert.equal(formatInZone(startOfZoneDay(T0)), '2026-10-19 00:00');
  assert.deepEqual(zoneParts(startOfZoneDay(T0)), { y: 2026, mo: 10, d: 19, h: 0, mi: 0, s: 0 });

  // 历史有上限，不能无限长
  for (let i = 0; i < 80; i += 1) counted.pushHistory({ at: T0 + i, action: 'fire', reason: 'x' });
  assert.ok(counted.state.history.length <= 50);
});

test('状态：损坏文件备份后重来', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const store = new ProactiveContactStore({ file, cfg: makeCfg(), now: () => T0 });
  const info = store.load();
  assert.equal(info.loaded, false);
  assert.equal(info.reset, true);
  assert.ok(info.error.includes('损坏'));
  const dir = path.dirname(file);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('proactive-contact.json.corrupt-')), '坏文件应留备份');
});
