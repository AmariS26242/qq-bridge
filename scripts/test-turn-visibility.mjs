// 回合可见性（src/turn-visibility.mjs）的离线单测。
// 覆盖：失联安抚的判定/冷却/限流退避/状态文件容错，以及自述状态行的长度上限与开关。
// 纯内存 + 系统临时目录，不连 DSH/QQ，不碰 state/ 下的生产文件。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SELF_STATUS_DEFAULTS,
  SELF_STATUS_PREFIX,
  STUCK_NOTICE_DEFAULTS,
  buildStatusLine,
  decideStuckNotice,
  emptyNoticeState,
  isRateLimitedError,
  loadNoticeState,
  resolveSelfStatusConfig,
  resolveStuckNoticeConfig,
  runStuckNotice,
  saveNoticeState,
  sweepStuckNotices
} from '../src/turn-visibility.mjs';

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error?.message ?? error}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error?.message ?? error}`);
  }
}

const now = 1_800_000_000_000; // 固定时钟，避免测试受真实时间影响
const MIN = 60_000;
const KEY = 'group:123456';

function baseCfg(overrides) {
  return resolveStuckNoticeConfig({ stuckNotice: overrides ?? {} });
}

// ── 配置默认值 ──────────────────────────────────────────────────────────────
check('默认配置：8 分钟判定 / 30 分钟冷却 / 默认文案 / 开启', () => {
  const cfg = resolveStuckNoticeConfig(undefined);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.afterMinutes, 8);
  assert.equal(cfg.afterMs, 8 * MIN);
  assert.equal(cfg.cooldownMinutes, 30);
  assert.equal(cfg.cooldownMs, 30 * MIN);
  assert.equal(cfg.message, STUCK_NOTICE_DEFAULTS.message);
});

check('配置容错：非法值回退默认，文案压成单行且限长', () => {
  const cfg = resolveStuckNoticeConfig({ stuckNotice: { afterMinutes: 'abc', cooldownMinutes: -3, message: '  第一行\n第二行  ' } });
  assert.equal(cfg.afterMinutes, 8);
  assert.equal(cfg.cooldownMinutes, 30);
  assert.equal(cfg.message, '第一行 第二行');
  const long = resolveStuckNoticeConfig({ stuckNotice: { message: '啊'.repeat(200) } });
  assert.ok(long.message.length <= STUCK_NOTICE_DEFAULTS.maxMessageChars);
});

check('功能可关：enabled=false 时判定直接放弃', () => {
  const d = decideStuckNotice({ unread: 5, busy: true, busySince: now - 60 * MIN, lastProductiveAt: now - 60 * MIN }, now, baseCfg({ enabled: false }));
  assert.deepEqual(d, { send: false, reason: 'disabled' });
});

// ── 判定：正常繁忙不告警 ────────────────────────────────────────────────────
check('正常繁忙不告警：只是短期繁忙（< afterMs）', () => {
  const d = decideStuckNotice({ unread: 3, busy: true, busySince: now - 2 * MIN, lastProductiveAt: now - 2 * MIN }, now, baseCfg());
  assert.equal(d.send, false);
  assert.equal(d.reason, 'not-stalled');
});

check('正常繁忙不告警：繁忙够久但 AI 刚产出过（等待期间有新消息）', () => {
  const d = decideStuckNotice({ unread: 3, busy: true, busySince: now - 30 * MIN, lastProductiveAt: now - 1 * MIN }, now, baseCfg());
  assert.equal(d.send, false);
  assert.equal(d.reason, 'not-stalled');
});

check('正常繁忙不告警：没有未读', () => {
  const d = decideStuckNotice({ unread: 0, busy: true, busySince: now - 30 * MIN, lastProductiveAt: now - 30 * MIN }, now, baseCfg());
  assert.equal(d.send, false);
  assert.equal(d.reason, 'no-unread');
});

check('正常繁忙不告警：会话不忙（requireBusy 默认开启，防潜水误报）', () => {
  const d = decideStuckNotice({ unread: 9, busy: false, busySince: 0, lastProductiveAt: now - 60 * MIN }, now, baseCfg());
  assert.equal(d.send, false);
  assert.equal(d.reason, 'not-busy');
});

check('正常繁忙不告警：繁忙只有 90 秒，即使上次产出在 20 分钟前也只是刚忙起来', () => {
  const d = decideStuckNotice({ unread: 2, busy: true, busySince: now - 90_000, lastProductiveAt: now - 20 * MIN }, now, baseCfg());
  assert.equal(d.send, false);
  assert.equal(d.reason, 'busy-short');
});

check('正常繁忙不告警：繁忙起点还没记录（刚唤醒）时不抢跑', () => {
  const d = decideStuckNotice({ unread: 2, busy: true, busySince: 0, lastProductiveAt: now - 20 * MIN }, now, baseCfg());
  assert.equal(d.send, false);
  assert.equal(d.reason, 'busy-unknown');
});

check('暂停/非 reserved2 模式不告警', () => {
  const d = decideStuckNotice({ unread: 9, busy: true, busySince: now - 60 * MIN, lastProductiveAt: now - 60 * MIN, paused: true }, now, baseCfg());
  assert.equal(d.send, false);
  assert.equal(d.reason, 'paused');
});

// ── 超时告警一次 + 冷却内不重复 ─────────────────────────────────────────────
await checkAsync('超时告警一次：超过 8 分钟静默后发送，且只发一条', async () => {
  let sent = 0;
  const sentTexts = [];
  const cfg = baseCfg();
  const store = emptyNoticeState();
  const ctx = {
    key: KEY,
    now,
    cfg,
    store,
    unread: 25,
    busy: true,
    busySince: now - 12 * MIN,
    lastProductiveAt: now - 10 * MIN,
    send: async (text) => { sent += 1; sentTexts.push(text); }
  };
  const first = await runStuckNotice(ctx);
  assert.equal(first.sent, true);
  assert.equal(first.reason, 'stalled');
  assert.equal(sent, 1);
  assert.deepEqual(sentTexts, [cfg.message]);
  assert.equal(store.totalSent, 1);
  assert.equal(store.conversations[KEY].sentCount, 1);
  assert.equal(store.lastSentAt, now);

  // 同一轮巡检里马上再审一次：冷却内绝不重复
  const again = await runStuckNotice({ ...ctx, now: now + 1 * MIN });
  assert.equal(again.sent, false);
  assert.equal(again.reason, 'cooldown');
  assert.equal(sent, 1);
});

check('冷却内不重复：对方又发新消息也不叠加', () => {
  const cfg = baseCfg();
  const store = emptyNoticeState();
  store.conversations[KEY] = { sentCount: 1, failCount: 0, lastSentAt: now - 5 * MIN, lastAttemptAt: now - 5 * MIN, blockedUntil: 0, lastReason: 'stalled', lastError: '', lastUnread: 5 };
  const d = decideStuckNotice({ unread: 40, busy: true, busySince: now - 40 * MIN, lastProductiveAt: now - 40 * MIN, entry: store.conversations[KEY] }, now, cfg);
  assert.equal(d.send, false);
  assert.equal(d.reason, 'cooldown');
  assert.ok(d.retryInMs > 0 && d.retryInMs <= 30 * MIN);
});

check('冷却结束后可以再发（但不是每轮都发）', () => {
  const cfg = baseCfg();
  const store = emptyNoticeState();
  store.conversations[KEY] = { sentCount: 1, failCount: 0, lastSentAt: now - 31 * MIN, lastAttemptAt: now - 31 * MIN, blockedUntil: 0, lastReason: 'stalled', lastError: '', lastUnread: 5 };
  const d = decideStuckNotice({ unread: 3, busy: true, busySince: now - 60 * MIN, lastProductiveAt: now - 60 * MIN, entry: store.conversations[KEY] }, now, cfg);
  assert.equal(d.send, true);
});

// ── 限流退避 ────────────────────────────────────────────────────────────────
check('识别限流错误：429 / retcode 1200 / 中文限流文案', () => {
  assert.equal(isRateLimitedError({ status: 429 }), true);
  assert.equal(isRateLimitedError(new Error('OneBot send_group_msg 失败: 429')), true);
  assert.equal(isRateLimitedError(new Error('发送过于频繁，请稍后再试')), true);
  assert.equal(isRateLimitedError({ retcode: 1200 }), true);
  assert.equal(isRateLimitedError(new Error('网络超时')), false);
});

await checkAsync('限流退避：发送失败后按 rateLimitBackoffMs 退避，期间不再重试', async () => {
  const cfg = baseCfg();
  const store = emptyNoticeState();
  let attempts = 0;
  const result = await runStuckNotice({
    key: KEY, now, cfg, store, unread: 6, busy: true,
    busySince: now - 12 * MIN, lastProductiveAt: now - 12 * MIN,
    send: async () => { attempts += 1; const err = new Error('OneBot send_group_msg 失败: 429'); err.statusCode = 429; throw err; }
  });
  assert.equal(result.sent, false);
  assert.equal(result.error.includes('429'), true);
  assert.equal(store.totalFailed, 1);
  const entry = store.conversations[KEY];
  assert.equal(entry.lastReason, 'rate-limited');
  assert.ok(entry.blockedUntil >= now + cfg.rateLimitBackoffMs, `退避应覆盖 ${cfg.rateLimitBackoffMs}ms，实际 ${entry.blockedUntil - now}ms`);

  // 退避期内：判定只说 backoff，不会再调 send
  const during = await runStuckNotice({
    key: KEY, now: now + 1 * MIN, cfg, store, unread: 6, busy: true,
    busySince: now - 13 * MIN, lastProductiveAt: now - 13 * MIN,
    send: async () => { attempts += 1; }
  });
  assert.equal(during.sent, false);
  assert.equal(during.reason, 'backoff');
  assert.equal(attempts, 1);

  // 退避结束后可以重试
  const after = decideStuckNotice({ unread: 6, busy: true, busySince: now - 30 * MIN, lastProductiveAt: now - 30 * MIN, entry: store.conversations[KEY] }, now + 6 * MIN, cfg);
  assert.equal(after.send, true);
});

await checkAsync('普通发送失败：退避 1 分钟后可重试，且不会抛异常', async () => {
  const cfg = baseCfg();
  const store = emptyNoticeState();
  const r1 = await runStuckNotice({
    key: KEY, now, cfg, store, unread: 2, busy: true, busySince: now - 12 * MIN, lastProductiveAt: now - 12 * MIN,
    send: async () => { throw new Error('网络超时'); }
  });
  assert.equal(r1.sent, false);
  assert.equal(store.conversations[KEY].lastReason, 'send-failed');
  const early = decideStuckNotice({ unread: 2, busy: true, busySince: now - 13 * MIN, lastProductiveAt: now - 13 * MIN, entry: store.conversations[KEY] }, now + 30_000, cfg);
  assert.equal(early.send, false);
  assert.equal(early.reason, 'backoff');
  const late = decideStuckNotice({ unread: 2, busy: true, busySince: now - 20 * MIN, lastProductiveAt: now - 20 * MIN, entry: store.conversations[KEY] }, now + 2 * MIN, cfg);
  assert.equal(late.send, true);
});

check('发送器缺失按失败处理（不虚报已发）', async () => {
  const store = emptyNoticeState();
  const r = await runStuckNotice({ key: KEY, now, cfg: baseCfg(), store, unread: 1, busy: true, busySince: now - 12 * MIN, lastProductiveAt: now - 12 * MIN, send: null });
  assert.equal(r.sent, false);
  assert.equal(store.totalSent, 0);
  assert.equal(store.conversations[KEY].lastReason, 'send-failed');
});

// ── 状态文件容错 ────────────────────────────────────────────────────────────
check('状态文件：坏了/不存在/非对象都当空，写入后可读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-vis-'));
  try {
    const file = path.join(dir, 'stuck-notice.json');
    assert.equal(loadNoticeState(file).totalSent, 0);
    fs.writeFileSync(file, '{ 坏 JSON');
    assert.equal(loadNoticeState(file).totalSent, 0);
    fs.writeFileSync(file, JSON.stringify({ totalSent: 'oops', conversations: { 'bad key': {}, [KEY]: { sentCount: 2, lastSentAt: 7, blockedUntil: 9 } } }));
    const loaded = loadNoticeState(file);
    assert.equal(loaded.totalSent, 0);
    assert.equal(loaded.conversations[KEY].sentCount, 2);
    assert.equal('bad key' in loaded.conversations, false);
    loaded.totalSent = 3;
    loaded.lastSentAt = 123;
    assert.equal(saveNoticeState(file, loaded), true);
    const back = loadNoticeState(file);
    assert.equal(back.totalSent, 3);
    assert.equal(back.lastSentAt, 123);
    assert.equal(back.conversations[KEY].sentCount, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await checkAsync('sweep：多个会话互不影响，坏 key 直接跳过', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-vis-'));
  try {
    const file = path.join(dir, 'stuck-notice.json');
    const calls = [];
    const out = await sweepStuckNotices({
      now,
      cfg: undefined,
      file,
      keys: ['group:1', 'bad:key', 'private:2'],
      paused: false,
      resolve: (key) => key === 'private:2' ? null : { unread: 4, busy: true, busySince: now - 20 * MIN, lastProductiveAt: now - 20 * MIN },
      send: async (key, text) => { calls.push([key, text]); },
      log: () => {}
    });
    assert.equal(out.checked, 1);
    assert.equal(out.sent, 1);
    assert.deepEqual(calls.map((c) => c[0]), ['group:1']);
    const saved = loadNoticeState(file);
    assert.equal(saved.totalSent, 1);
    assert.ok(saved.conversations['group:1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 自述状态行 ──────────────────────────────────────────────────────────────
check('状态行：关闭时为空串（prompt 保持逐字节一致）', () => {
  assert.equal(buildStatusLine({ enabled: false, now, queueDepth: 3, busySince: now - MIN, lastTurnEndedAt: now - 3 * MIN, dshConnected: true }), '');
  const cfg = resolveSelfStatusConfig({ selfStatus: { enabled: false } });
  assert.equal(cfg.enabled, false);
  assert.equal(buildStatusLine({ enabled: cfg.enabled, now, dshConnected: true }), '');
});

check('状态行：默认开启且字段齐全时包含必要事实', () => {
  const cfg = resolveSelfStatusConfig(undefined);
  assert.equal(cfg.enabled, true);
  const line = buildStatusLine({ enabled: cfg.enabled, maxChars: cfg.maxChars, now, queueDepth: 0, busySince: now - 12_000, lastTurnEndedAt: now - 3 * MIN, dshConnected: true });
  assert.ok(line.startsWith(SELF_STATUS_PREFIX), line);
  assert.ok(line.includes('待发队列 0'), line);
  assert.ok(line.includes('本会话繁忙'), line);
  assert.ok(line.includes('上一回合结束'), line);
  assert.ok(line.includes('DSH 连接正常'), line);
  assert.ok(line.length <= 200, `长度 ${line.length} 超限`);
});

check('状态行：拿不到的字段直接省略，不写「未知」', () => {
  const line = buildStatusLine({ enabled: true, now, queueDepth: 2, busySince: 0, lastTurnEndedAt: 0, dshConnected: false });
  assert.equal(line, `${SELF_STATUS_PREFIX}待发队列 2；DSH 连接断开`);
  assert.equal(line.includes('未知'), false);
  assert.equal(buildStatusLine({ enabled: true, now }), '');
});

check('状态行：超长时按优先级丢字段，总长仍 ≤ maxChars', () => {
  const full = buildStatusLine({ enabled: true, maxChars: 200, now, queueDepth: 99, busySince: now - 5 * 3600_000, lastTurnEndedAt: now - 9 * 86400_000, dshConnected: true });
  assert.ok(full.length <= 200, `长度 ${full.length} 超限`);
  const tight = buildStatusLine({ enabled: true, maxChars: 20, now, queueDepth: 99, busySince: now - 5 * 3600_000, lastTurnEndedAt: now - 9 * 86400_000, dshConnected: true });
  assert.ok(tight.length <= 20, `长度 ${tight.length} 超限`);
  // 硬上限：即使调用方传更大值也不能超过 SELF_STATUS_DEFAULTS.maxChars
  const huge = buildStatusLine({ enabled: true, maxChars: 9999, now, queueDepth: 1, busySince: now - 5 * 3600_000, lastTurnEndedAt: now - 9 * 86400_000, dshConnected: true });
  assert.ok(huge.length <= SELF_STATUS_DEFAULTS.maxChars, `长度 ${huge.length} 超限`);
});

check('状态行：解析配置时 maxChars 被夹到 200 以内', () => {
  assert.equal(resolveSelfStatusConfig({ selfStatus: { maxChars: 9999 } }).maxChars, 200);
  assert.equal(resolveSelfStatusConfig({ selfStatus: { maxChars: -1 } }).maxChars, 20);
});

if (failed > 0) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
