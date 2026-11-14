// 连接质量模块单测：node scripts/test-conn-quality.mjs
//
// 覆盖：断线/重连统计、最长中断、跨来源隔离、窗口过滤、持久化、损坏文件与写盘失败容错、
// 日志回填解析（含跨午夜）、回填幂等、告警阈值与文案、JSON handler 正常/异常。
// 全部使用系统临时目录，绝不碰真实 state/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ALERT,
  backfillFromLog,
  buildAlertText,
  configureConnQuality,
  createConnQualityHandler,
  formatDuration,
  getStats,
  ingestEvents,
  parseBridgeLog,
  recordDisconnect,
  recordReconnect,
  shouldAlert,
  stateFilePath,
} from '../src/conn-quality.mjs';

const HOUR = 3_600_000;
const MIN = 60_000;
const T0 = Date.parse('2026-05-10T12:00:00+08:00');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-quality-test-'));
let seq = 0;

/** 每个用例一份独立 state 文件，顺带验证 configureConnQuality 会重置内存缓存。
 * 保留期放宽到 10 年：用例里的时间锚点固定在 2026-05，用生产默认 7 天会被裁剪掉。 */
const TEST_RETENTION_MS = 3650 * 24 * HOUR;
function freshState(name) {
  const file = path.join(tmpRoot, `state-${++seq}-${name || 'case'}.json`);
  configureConnQuality({ stateFile: file, retentionMs: TEST_RETENTION_MS });
  return file;
}

function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
      this.headersSent = true;
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk);
      this.writableEnded = true;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
  return res;
}

function makeStats({ generatedAt = T0, outages = [], longestOutageMs, bySource } = {}) {
  const series = outages.map((item) => ({
    at: new Date(item.at).toISOString(),
    downMs: item.downMs ?? 0,
    source: item.source ?? 'snowluma',
  }));
  return {
    generatedAt: new Date(generatedAt).toISOString(),
    disconnects: series.length,
    reconnects: series.length,
    longestOutageMs: longestOutageMs ?? series.reduce((max, item) => Math.max(max, item.downMs), 0),
    avgReconnectMs: 1000,
    lastOutageAt: series.length ? series[series.length - 1].at : null,
    bySource: bySource ?? {
      snowluma: { disconnects: series.length },
      dsh: { disconnects: 0 },
    },
    series,
  };
}

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

// ── 统计 ────────────────────────────────────────────────────────────────────
test('断线/重连统计：次数、平均重连、最长中断、最近一次', () => {
  freshState('basic');
  const now = T0 + 24 * HOUR;
  recordDisconnect({ source: 'snowluma', code: 1006, at: now - 3 * HOUR });
  recordReconnect({ source: 'snowluma', at: now - 3 * HOUR + 2000 });
  recordDisconnect({ source: 'snowluma', code: 1006, at: now - 2 * HOUR });
  recordReconnect({ source: 'snowluma', at: now - 2 * HOUR + 4000 });
  const stats = getStats({ hours: 24, now });
  assert.equal(stats.disconnects, 2);
  assert.equal(stats.reconnects, 2);
  assert.equal(stats.avgReconnectMs, 3000);
  assert.equal(stats.longestOutageMs, 4000);
  assert.equal(stats.lastOutageAt, new Date(now - 2 * HOUR).toISOString());
  assert.equal(stats.ongoing, null);
  assert.equal(stats.bySource.snowluma.disconnects, 2);
  assert.equal(stats.bySource.dsh.disconnects, 0);
  assert.equal(stats.series.length, 2);
  assert.deepEqual(stats.series.map((item) => item.downMs), [2000, 4000]);
  assert.equal(stats.series[0].source, 'snowluma');
});

test('进行中的中断：按 now 截断为最长中断，且不计入平均重连', () => {
  freshState('ongoing');
  const now = T0;
  recordDisconnect({ source: 'dsh', at: now - 11 * MIN });
  const stats = getStats({ hours: 24, now });
  assert.equal(stats.ongoing.source, 'dsh');
  assert.equal(stats.ongoing.since, new Date(now - 11 * MIN).toISOString());
  assert.equal(stats.ongoing.downMs, 11 * MIN);
  assert.equal(stats.longestOutageMs, 11 * MIN);
  assert.equal(stats.reconnects, 0);
  assert.equal(stats.avgReconnectMs, 0);
  assert.equal(stats.series.at(-1).ongoing, true);
});

test('跨来源隔离：孤立 up 不造中断，两个来源各配各的', () => {
  freshState('cross');
  recordReconnect({ source: 'snowluma', at: T0 });
  recordDisconnect({ source: 'dsh', at: T0 });
  recordReconnect({ source: 'snowluma', at: T0 + 1000 });
  recordReconnect({ source: 'dsh', at: T0 + 5000 });
  const stats = getStats({ hours: 24, now: T0 + HOUR });
  assert.equal(stats.disconnects, 1);
  assert.equal(stats.bySource.snowluma.disconnects, 0);
  assert.equal(stats.bySource.dsh.disconnects, 1);
  assert.equal(stats.bySource.dsh.avgReconnectMs, 5000);
  assert.equal(stats.series[0].source, 'dsh');
});

test('窗口过滤：30 小时前的断线不进 24h 统计，但 48h 能看到', () => {
  freshState('window');
  const now = T0 + 24 * HOUR;
  recordDisconnect({ source: 'snowluma', at: now - 30 * HOUR });
  recordReconnect({ source: 'snowluma', at: now - 30 * HOUR + 1000 });
  recordDisconnect({ source: 'snowluma', at: now - 1 * HOUR });
  recordReconnect({ source: 'snowluma', at: now - 1 * HOUR + 1000 });
  assert.equal(getStats({ hours: 24, now }).disconnects, 1);
  assert.equal(getStats({ hours: 48, now }).disconnects, 2);
});

test('非法来源被忽略，且不污染统计', () => {
  freshState('invalid');
  assert.equal(recordDisconnect({ source: 'qq', at: T0 }), null);
  assert.equal(recordReconnect({ source: '', at: T0 }), null);
  const stats = getStats({ hours: 24, now: T0 + HOUR });
  assert.equal(stats.disconnects, 0);
  assert.equal(stats.bySource.snowluma.disconnects, 0);
  assert.equal(stats.bySource.dsh.disconnects, 0);
});

// ── 持久化与容错 ────────────────────────────────────────────────────────────
test('持久化：落盘格式可读，重建缓存后统计一致', () => {
  const file = freshState('persist');
  recordDisconnect({ source: 'snowluma', code: 1006, at: T0 - 2000 });
  recordReconnect({ source: 'snowluma', at: T0 });
  const text = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(text);
  assert.equal(doc.version, 1);
  assert.equal(doc.retentionDays, 3650);
  assert.equal(doc.events.length, 2);
  assert.equal(doc.events[0].type, 'down');
  assert.equal(doc.events[0].code, 1006);
  assert.match(doc.events[0].at, /^\d{4}-\d{2}-\d{2}T/);
  configureConnQuality({ stateFile: file }); // 清缓存，强制从磁盘读
  const stats = getStats({ hours: 24, now: T0 + HOUR });
  assert.equal(stats.disconnects, 1);
  assert.equal(stats.avgReconnectMs, 2000);
});

test('损坏文件：不抛错、自动隔离并重建；旧证据保留为 .corrupt-*', () => {
  const file = freshState('corrupt');
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  assert.doesNotThrow(() => recordDisconnect({ source: 'snowluma', at: T0 }));
  const stats = getStats({ hours: 24, now: T0 + MIN });
  assert.equal(stats.disconnects, 1);
  const rebuilt = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rebuilt.events.length, 1);
  const quarantined = fs.readdirSync(tmpRoot).filter((name) => name.includes('.corrupt-'));
  assert.ok(quarantined.length >= 1, '损坏文件应被改名隔离');
});

test('写盘失败（目标是目录）：调用方不抛错，内存统计仍然可用', () => {
  const target = path.join(tmpRoot, `as-directory-${++seq}`);
  fs.mkdirSync(target);
  configureConnQuality({ stateFile: target, retentionMs: TEST_RETENTION_MS });
  assert.doesNotThrow(() => recordDisconnect({ source: 'dsh', at: T0 }));
  const stats = getStats({ hours: 24, now: T0 + MIN });
  assert.equal(stats.disconnects, 1);
  assert.equal(stats.bySource.dsh.disconnects, 1);
  assert.ok(stateFilePath() === target);
});

// ── 日志回填 ────────────────────────────────────────────────────────────────
const ANCHOR = new Date(2026, 4, 10, 21, 0, 0).getTime(); // 本地 2026-05-10 21:00
const LOG_TEXT = [
  '20:00:00 [bridge] 桥接已启动。按 Ctrl+C 退出。',
  '20:01:00 [bridge] SnowLuma 已连接：ws://127.0.0.1:3001',
  '20:10:00 [bridge] SnowLuma 连接断开（code=1006），重连中…',
  '20:10:01 [bridge] 连接 DSH 事件流…',
  '20:10:03 [bridge] SnowLuma 已连接：ws://127.0.0.1:3001',
  '20:20:00 [bridge] ⚠️ DSH 不可用（重启中？），QQ 消息将入队等待',
  '20:21:30 [bridge] DSH 已就绪（模式: reserved2）',
].join('\n');

test('日志回填解析：四类行都识别，retry 单列，时间锚定到日志当天', () => {
  const events = parseBridgeLog(LOG_TEXT, { now: ANCHOR });
  assert.equal(events.length, 6);
  assert.deepEqual(events.map((event) => `${event.source}/${event.type}`), [
    'snowluma/up', 'snowluma/down', 'dsh/retry', 'snowluma/up', 'dsh/down', 'dsh/up',
  ]);
  assert.equal(events[1].code, 1006);
  assert.equal(events[0].at, new Date(2026, 4, 10, 20, 1, 0).getTime());
  assert.equal(events[1].at, new Date(2026, 4, 10, 20, 10, 0).getTime());
  assert.equal(events[4].at, new Date(2026, 4, 10, 20, 20, 0).getTime());
});

test('日志回填解析：跨午夜倒推日期，跨天中断时长正确', () => {
  const text = [
    '23:59:00 [bridge] SnowLuma 连接断开（code=1006），重连中…',
    '00:00:30 [bridge] SnowLuma 已连接：ws://127.0.0.1:3001',
  ].join('\n');
  const anchor = new Date(2026, 4, 11, 0, 1, 0).getTime();
  const events = parseBridgeLog(text, { now: anchor });
  const down = new Date(2026, 4, 10, 23, 59, 0).getTime();
  const up = new Date(2026, 4, 11, 0, 0, 30).getTime();
  assert.equal(events[0].at, down);
  assert.equal(events[1].at, up);
  assert.equal(events[1].at - events[0].at, 90_000);
});

test('日志回填解析：多天日志按时间回绕逐日回退', () => {
  const text = [
    '23:00:00 [bridge] ⚠️ DSH 不可用（重启中？），QQ 消息将入队等待',
    '01:00:00 [bridge] DSH 已就绪（模式: reserved2）',
  ].join('\n');
  const anchor = new Date(2026, 4, 12, 1, 1, 0).getTime();
  const events = parseBridgeLog(text, { now: anchor });
  assert.equal(events[0].at, new Date(2026, 4, 11, 23, 0, 0).getTime());
  assert.equal(events[1].at, new Date(2026, 4, 12, 1, 0, 0).getTime());
});

test('回填合并：只收 down/up，重复回填幂等', () => {
  freshState('ingest');
  const parsed = parseBridgeLog(LOG_TEXT, { now: ANCHOR });
  assert.equal(ingestEvents(parsed), 5); // retry 不入库
  assert.equal(ingestEvents(parsed), 0); // 再灌一遍不翻倍
  const stats = getStats({ hours: 24, now: ANCHOR });
  assert.equal(stats.disconnects, 2);
  assert.equal(stats.bySource.snowluma.disconnects, 1);
  assert.equal(stats.bySource.dsh.disconnects, 1);
  assert.equal(stats.bySource.snowluma.avgReconnectMs, 3000);
  assert.equal(stats.bySource.dsh.avgReconnectMs, 90_000);
  assert.equal(stats.longestOutageMs, 90_000);
});

test('backfillFromLog：以日志 mtime 为锚点，重复调用幂等，缺文件返回 0', () => {
  freshState('backfill');
  const logFile = path.join(tmpRoot, 'bridge.log');
  fs.writeFileSync(logFile, LOG_TEXT, 'utf8');
  const anchorSec = Math.floor(ANCHOR / 1000);
  fs.utimesSync(logFile, anchorSec, anchorSec);
  assert.equal(backfillFromLog({ logFile }), 5);
  assert.equal(backfillFromLog({ logFile }), 0);
  const stats = getStats({ hours: 24, now: ANCHOR });
  assert.equal(stats.disconnects, 2);
  assert.equal(backfillFromLog({ logFile: path.join(tmpRoot, 'missing.log') }), 0);
});

// ── 告警 ────────────────────────────────────────────────────────────────────
test('告警阈值：1 小时内 ≥5 次断线触发，4 次不触发', () => {
  const four = makeStats({ generatedAt: T0 + 10 * MIN, outages: [0, 1, 2, 3].map((i) => ({ at: T0 - i * MIN, downMs: 2000 })) });
  const five = makeStats({ generatedAt: T0 + 10 * MIN, outages: [0, 1, 2, 3, 4].map((i) => ({ at: T0 - i * MIN, downMs: 2000 })) });
  assert.equal(shouldAlert(four), false);
  assert.equal(shouldAlert(five), true);
  assert.equal(buildAlertText(four), '');
  const text = buildAlertText(five);
  assert.match(text, /连接质量告警/);
  assert.match(text, /断线 5 次/);
  assert.match(text, /阈值 5 次/);
  assert.match(text, /SnowLuma 5 次 \/ DSH 0 次/);
});

test('告警阈值：单次中断 >10 分钟触发，≤10 分钟不触发；支持自定义 cfg', () => {
  const short = makeStats({ generatedAt: T0, outages: [{ at: T0 - 5 * MIN, downMs: 10 * MIN }] });
  const long = makeStats({ generatedAt: T0, outages: [{ at: T0 - 5 * MIN, downMs: 11 * MIN }] });
  assert.equal(shouldAlert(short), false);
  assert.equal(shouldAlert(long), true);
  assert.match(buildAlertText(long), /单次最长中断 11\.0 分钟/);
  assert.equal(shouldAlert(long, { outageMinutes: 30 }), false);
  assert.equal(shouldAlert(short, { outageMinutes: 5 }), true);
  assert.equal(shouldAlert(long, { count: 99, outageMinutes: 30 }), false);
  assert.deepEqual(DEFAULT_ALERT, { count: 5, windowMinutes: 60, outageMinutes: 10 });
});

test('告警文案：进行中的中断会写明当前仍在中断', () => {
  const stats = makeStats({ generatedAt: T0, longestOutageMs: 20 * MIN, outages: [] });
  stats.ongoing = { source: 'snowluma', since: new Date(T0 - 20 * MIN).toISOString(), downMs: 20 * MIN };
  const text = buildAlertText(stats);
  assert.match(text, /当前仍在中断中/);
  assert.match(text, /SnowLuma/);
});

test('formatDuration：秒 / 分钟 / 小时', () => {
  assert.equal(formatDuration(45_000), '45 秒');
  assert.equal(formatDuration(90_000), '1.5 分钟');
  assert.equal(formatDuration(90 * MIN), '1.5 小时');
  assert.equal(formatDuration(0), '0 秒');
});

// ── HTTP handler ────────────────────────────────────────────────────────────
test('JSON handler 正常：200 { ok:true, stats }，hours 透传并夹取', () => {
  const seen = [];
  const handler = createConnQualityHandler({
    getStats: ({ hours }) => {
      seen.push(hours);
      return { hours, disconnects: 2 };
    },
  });

  const res = fakeRes();
  handler({ method: 'GET', url: '/api/conn-quality?hours=6' }, res);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.stats.hours, 6);
  assert.equal(body.stats.disconnects, 2);

  const clamped = fakeRes();
  handler({ method: 'GET', url: '/api/conn-quality?hours=999' }, clamped);
  assert.equal(clamped.json().stats.hours, 168);

  const fallback = fakeRes();
  handler({ method: 'GET', url: '/api/conn-quality' }, fallback);
  assert.equal(fallback.json().stats.hours, 24);
  assert.deepEqual(seen, [6, 168, 24]);
});

test('JSON handler 异常：500 { ok:false, error }；非 GET 405', () => {
  const handler = createConnQualityHandler({
    getStats: () => {
      throw new Error('读取状态文件失败');
    },
  });
  const res = fakeRes();
  handler({ method: 'GET', url: '/api/conn-quality' }, res);
  assert.equal(res.status, 500);
  assert.deepEqual(res.json(), { ok: false, error: '读取状态文件失败' });

  const post = fakeRes();
  handler({ method: 'POST', url: '/api/conn-quality' }, post);
  assert.equal(post.status, 405);
  assert.equal(post.json().ok, false);
});

test('JSON handler 端到端：真实 getStats + 临时 state，输出可 JSON 序列化', () => {
  freshState('handler');
  // handler 内部用真实 Date.now() 作统计终点，所以这里也用真实时间。
  const live = Date.now();
  recordDisconnect({ source: 'snowluma', code: 1006, at: live - 5000 });
  recordReconnect({ source: 'snowluma', at: live });
  const handler = createConnQualityHandler({ getStats });
  const res = fakeRes();
  handler({ method: 'GET', url: '/api/conn-quality?hours=24' }, res);
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.stats.disconnects, 1);
  assert.equal(body.stats.avgReconnectMs, 5000);
  assert.equal(body.stats.series.length, 1);
});

// ── 收尾 ────────────────────────────────────────────────────────────────────
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {}

console.log('');
console.log(`结果：${passed} 通过 / ${failures.length} 失败`);
if (failures.length) {
  for (const item of failures) console.error(`失败用例：${item.name}`);
  process.exit(1);
}
