// 限流排队（src/rate-limit.mjs）的离线单测。
// 不连 QQ、不连 DSH；持久化写到临时目录，绝不碰生产 state/。
// 用法：node scripts/test-rate-limit.mjs   失败时 exit 1。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RATE_LIMIT_PRIORITIES,
  RateLimitQueue,
  classifyOutbound,
  isRateLimitError
} from '../src/rate-limit.mjs';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.error(`FAIL ${name}`);
    console.error(`     ${error?.message ?? error}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-rate-limit-'));
function tmpFile(name) {
  return path.join(tmpRoot, name);
}
function newQueue(options = {}) {
  return new RateLimitQueue({ filePath: tmpFile(`q-${Math.random().toString(36).slice(2)}.json`), ...options });
}

// ── 优先级分类 ──────────────────────────────────────────────────────────────
check('优先级表：owner > directReply > groupReply > sticker > proactive > reminder', () => {
  assert.equal(RATE_LIMIT_PRIORITIES.owner, 100);
  assert.equal(RATE_LIMIT_PRIORITIES.directReply, 90);
  assert.equal(RATE_LIMIT_PRIORITIES.groupReply, 60);
  assert.equal(RATE_LIMIT_PRIORITIES.sticker, 40);
  assert.equal(RATE_LIMIT_PRIORITIES.proactive, 30);
  assert.equal(RATE_LIMIT_PRIORITIES.reminder, 20);
});

check('classifyOutbound: 私聊主人 → owner(100)', () => {
  const r = classifyOutbound({ kind: 'private', isOwner: true });
  assert.deepEqual(r, { priority: 100, label: 'owner' });
});

check('classifyOutbound: 回复我/@我 → directReply(90)', () => {
  assert.equal(classifyOutbound({ kind: 'group', atMe: true }).priority, 90);
  assert.equal(classifyOutbound({ kind: 'group', mentionedMe: true }).priority, 90);
  assert.equal(classifyOutbound({ kind: 'group', purpose: 'directReply' }).priority, 90);
});

check('classifyOutbound: 普通群回复 → groupReply(60)', () => {
  assert.deepEqual(classifyOutbound({ kind: 'group' }), { priority: 60, label: 'groupReply' });
});

check('classifyOutbound: 表情 → sticker(40)，主动 → proactive(30)，提醒 → reminder(20)', () => {
  assert.equal(classifyOutbound({ kind: 'sticker' }).priority, 40);
  assert.equal(classifyOutbound({ kind: 'text', purpose: 'sticker' }).priority, 40);
  assert.equal(classifyOutbound({ kind: 'text', purpose: 'proactive' }).priority, 30);
  assert.equal(classifyOutbound({ kind: 'text', purpose: 'reminder', isOwner: true }).priority, 20);
});

check('classifyOutbound: 空输入不抛错', () => {
  assert.doesNotThrow(() => classifyOutbound());
  assert.equal(classifyOutbound().priority, 60);
});

// ── 限流错误识别 ────────────────────────────────────────────────────────────
check('isRateLimitError: 中文措辞 / HTTP 429 / retcode 1200 / 普通错误', () => {
  assert.equal(isRateLimitError('发送频率超限，稍后重试'), true);
  assert.equal(isRateLimitError(new Error('QQ 发送失败：发送频率超限')), true);
  assert.equal(isRateLimitError(new Error('频率限制')), true);
  assert.equal(isRateLimitError({ status: 429 }), true);
  assert.equal(isRateLimitError(new Error('HTTP 429 Too Many Requests')), true);
  assert.equal(isRateLimitError({ retcode: 1200, wording: '' }), true);
  assert.equal(isRateLimitError(new Error('OneBot send_private_msg 失败: 1200')), true);
  assert.equal(isRateLimitError('rate limit exceeded'), true);
  assert.equal(isRateLimitError(new Error('QQ 发送失败: server closing')), false);
  assert.equal(isRateLimitError(new Error('发送内容包含会话令牌，已阻止发送')), false);
  assert.equal(isRateLimitError(new Error('连接超时')), false);
  assert.equal(isRateLimitError(null), false);
});

// ── 队列基本行为 ────────────────────────────────────────────────────────────
check('enqueue/takeDue: 按 priority 降序、同优先级 firstAt 升序、一次最多 5 条', () => {
  const q = newQueue();
  const t = 1_000_000;
  q.enqueue({ key: 'group:1', priority: 60, firstAt: t + 3, payload: { type: 'text', text: 'g3' } });
  q.enqueue({ key: 'group:1', priority: 60, firstAt: t + 1, payload: { type: 'text', text: 'g1' } });
  q.enqueue({ key: 'private:9', priority: 100, firstAt: t + 5, payload: { type: 'text', text: 'owner' } });
  q.enqueue({ key: 'group:2', priority: 90, firstAt: t + 2, payload: { type: 'text', text: 'direct' } });
  q.enqueue({ key: 'group:3', priority: 40, firstAt: t, payload: { type: 'text', text: 'sticker' } });
  q.enqueue({ key: 'group:4', priority: 20, firstAt: t, payload: { type: 'text', text: 'reminder' } });
  const due = q.takeDue(t + 10);
  assert.equal(due.length, 5, '一次最多 5 条');
  assert.deepEqual(due.map((i) => i.payload.text), ['owner', 'direct', 'g1', 'g3', 'sticker']);
  assert.equal(q.size(), 6, '第 6 条留待下一轮');
});

check('takeDue: 未到 nextAttemptAt 的不返回', () => {
  const q = newQueue();
  const t = 2_000_000;
  q.enqueue({ key: 'group:1', priority: 60, firstAt: t, payload: { text: 'a' } });
  q.enqueue({ key: 'group:2', priority: 60, firstAt: t, nextAttemptAt: t + 30_000, payload: { text: 'b' } });
  assert.equal(q.takeDue(t).length, 1);
  assert.equal(q.takeDue(t + 30_000).length, 2);
});

check('enqueue: 同 key 同内容合并，不堆积；优先级取更高', () => {
  const q = newQueue();
  const t = 3_000_000;
  const a = q.enqueue({ key: 'group:1', priority: 60, firstAt: t, payload: { type: 'text', text: '同一句' } });
  const b = q.enqueue({ key: 'group:1', priority: 90, firstAt: t + 5000, payload: { type: 'text', text: '同一句' } });
  assert.equal(q.size(), 1, '重复内容只保留一条');
  assert.equal(b.merged, true);
  assert.equal(b.id, a.id);
  const [item] = q.takeDue(t + 6000);
  assert.equal(item.priority, 90, '合并后升级为更高优先级');
  assert.equal(item.firstAt, t, '保留更早的 firstAt');
});

check('enqueue: 同 key 不同内容不合并', () => {
  const q = newQueue();
  q.enqueue({ key: 'group:1', priority: 60, payload: { type: 'text', text: 'A' } });
  q.enqueue({ key: 'group:1', priority: 60, payload: { type: 'text', text: 'B' } });
  assert.equal(q.size(), 2);
});

check('enqueue: 空 key 抛错', () => {
  const q = newQueue();
  assert.throws(() => q.enqueue({ payload: { text: 'x' } }), /key/);
});

// ── 完成 / 失败 / 退避 ──────────────────────────────────────────────────────
check('markDone: 移除条目并累计 totalSent', () => {
  const q = newQueue();
  const { id } = q.enqueue({ key: 'group:1', priority: 60, payload: { text: 'x' } });
  assert.equal(q.markDone(id), true);
  assert.equal(q.size(), 0);
  assert.equal(q.stats().totalSent, 1);
  assert.equal(q.markDone(id), false, '重复完成返回 false');
});

check('markFailed: 退避 1s→2s→4s→…→上限 5 分钟', () => {
  const q = newQueue();
  const t = 4_000_000;
  const { id } = q.enqueue({ key: 'group:1', priority: 60, firstAt: t, payload: { text: 'x' } });
  const expected = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000];
  let now = t;
  for (let i = 0; i < 8; i++) {
    const res = q.markFailed(id, new Error('发送频率超限'), now);
    assert.equal(res.dropped, null, `第 ${i + 1} 次失败仍应重试`);
    assert.equal(res.attempts, i + 1);
    assert.equal(res.retryAt, now + expected[i]);
    now = res.retryAt;
  }
  // 第 9 次超过 maxAttempts=8 → 丢弃
  const last = q.markFailed(id, new Error('发送频率超限'), now);
  assert.equal(last.dropped, 'max-attempts');
  assert.equal(q.size(), 0);
  assert.equal(q.stats().totalDropped, 1);
});

check('markFailed: 退避上限 5 分钟', () => {
  const q = newQueue({ maxAttempts: 20 });
  const t = 5_000_000;
  const { id } = q.enqueue({ key: 'group:1', priority: 60, firstAt: t, payload: { text: 'x' } });
  let res;
  for (let i = 0; i < 12; i++) res = q.markFailed(id, 'x', t + i);
  assert.ok(res.backoffMs <= 300_000, `退避不得超过 5 分钟，实际 ${res.backoffMs}`);
});

check('markFailed: 超过 TTL 丢弃并返回 ttl', () => {
  const q = newQueue({ ttlMs: 30 * 60_000 });
  const t = 6_000_000;
  const { id } = q.enqueue({ key: 'group:1', priority: 60, firstAt: t, payload: { text: 'x' } });
  const res = q.markFailed(id, new Error('发送频率超限'), t + 30 * 60_000 + 1);
  assert.equal(res.dropped, 'ttl');
  assert.equal(q.size(), 0);
});

// ── 容量与持久化 ────────────────────────────────────────────────────────────
check('队列上限：满时丢弃最低优先级的最老条目', () => {
  const q = newQueue({ maxSize: 2 });
  const t = 7_000_000;
  q.enqueue({ key: 'group:1', priority: 60, firstAt: t, payload: { text: '普通' } });
  q.enqueue({ key: 'group:2', priority: 40, firstAt: t + 1, payload: { text: '表情' } });
  const res = q.enqueue({ key: 'private:9', priority: 100, firstAt: t + 2, payload: { text: '主人' } });
  assert.equal(res.dropped?.priority, 40, '应挤出优先级最低的条目');
  assert.equal(q.size(), 2);
  assert.deepEqual(q.takeDue(t + 10).map((i) => i.payload.text), ['主人', '普通']);
});

check('持久化：重新打开文件后条目与统计仍在', () => {
  const file = tmpFile('persist.json');
  const t = Date.now();
  const q1 = new RateLimitQueue({ filePath: file });
  q1.enqueue({ key: 'group:1', priority: 60, firstAt: t, payload: { type: 'text', text: '重启后还在' } });
  const q2 = new RateLimitQueue({ filePath: file });
  assert.equal(q2.size(), 1);
  assert.equal(q2.takeDue(t)[0].payload.text, '重启后还在');
  assert.equal(q2.stats().totalEnqueued, 1);
});

check('持久化：重启后已过 TTL 的条目不补发', () => {
  const file = tmpFile('expired.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    stats: { totalEnqueued: 1, totalSent: 0, totalDropped: 0 },
    items: [{
      id: 'old-1', key: 'group:1', kind: 'text', label: 'groupReply', priority: 60,
      payload: { type: 'text', text: '半小时前的旧回复' },
      attempts: 0, firstAt: Date.now() - 31 * 60_000, lastAttemptAt: 0,
      nextAttemptAt: Date.now() - 31 * 60_000
    }]
  }), 'utf8');
  const q = new RateLimitQueue({ filePath: file });
  assert.equal(q.size(), 0);
  assert.equal(q.stats().totalDropped, 1);
});

check('持久化：文件损坏时按空队列启动，不抛错', () => {
  const file = tmpFile('corrupt.json');
  fs.writeFileSync(file, '{not json', 'utf8');
  const q = new RateLimitQueue({ filePath: file });
  assert.equal(q.size(), 0);
  assert.doesNotThrow(() => q.enqueue({ key: 'group:1', priority: 60, payload: { text: 'x' } }));
});

check('drop: 主动丢弃累计 totalDropped', () => {
  const q = newQueue();
  const { id } = q.enqueue({ key: 'group:1', priority: 60, payload: { text: 'x' } });
  assert.equal(q.drop(id, 'session').reason, 'session');
  assert.equal(q.size(), 0);
  assert.equal(q.stats().totalDropped, 1);
});

check('stats: 总入队/成功补发/丢弃/当前深度', () => {
  const q = newQueue();
  const a = q.enqueue({ key: 'group:1', priority: 60, payload: { text: 'a' } });
  q.enqueue({ key: 'group:2', priority: 60, payload: { text: 'b' } });
  q.enqueue({ key: 'group:3', priority: 60, payload: { text: 'c' } });
  q.markDone(a.id);
  const stats = q.stats();
  assert.equal(stats.totalEnqueued, 3);
  assert.equal(stats.totalSent, 1);
  assert.equal(stats.depth, 2);
  assert.equal(q.size(), 2);
});

// list(): 只读视图给控制台用 —— 不含待发正文，按 nextAttemptAt 升序，受 limit 限制。
check('list: 不含 payload 正文、按下次重试时间升序、受 limit 限制', () => {
  const q = new RateLimitQueue({ filePath: tmpFile('list.json') });
  q.enqueue({ key: 'private:1', kind: 'text', label: 'privateReply', priority: 5, payload: { text: '机密正文 A' }, nextAttemptAt: 3000 });
  q.enqueue({ key: 'private:1', kind: 'text', label: 'privateReply', priority: 9, payload: { text: '机密正文 B' }, nextAttemptAt: 1000 });
  const all = q.list(10);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((x) => x.nextAttemptAt), [1000, 3000], '必须按 nextAttemptAt 升序');
  for (const item of all) {
    assert.equal('payload' in item, false, 'list() 不能带 payload');
    assert.equal(JSON.stringify(item).includes('机密正文'), false, '正文不能出现在视图里');
  }
  assert.equal(q.list(1).length, 1, 'limit 生效');
});

// ── 汇总 ──
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.error(`FAIL ${failed.length} 项`);
  process.exit(1);
}
