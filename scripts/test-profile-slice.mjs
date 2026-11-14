// 档案分片推进的离线单测：只测纯函数，不碰文件/网络/QQ。
//   node scripts/test-profile-slice.mjs
// 期望最后一行：PASS：N 项通过，0 项失败
import {
  PROFILE_SLICE_DEFAULTS,
  normalizeSliceCursor,
  planSlice,
  describeBacklog,
  commitSlice,
} from '../src/profile-slice.mjs';

const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
  assert(actual === expected, `${msg || '值不相等'}：实际「${actual}」期望「${expected}」`);
}

function assertIncludes(hay, needle, msg) {
  assert(String(hay).includes(needle), msg || `缺少「${needle}」：\n${hay}`);
}

/** 造 n 条 { seq, text }，seq 从 from 开始连续递增。 */
function msgs(n, from = 1) {
  return Array.from({ length: n }, (_, i) => ({ seq: from + i, text: `m${from + i}` }));
}

function seqs(items) {
  return items.map((m) => m.seq).join(',');
}

check('1 空消息：no-new，items 为空且游标不动', () => {
  const plan = planSlice({ messages: [], cursor: { lastSeq: 0 } });
  assertEqual(plan.ok, false, 'ok 应为 false');
  assertEqual(plan.reason, 'no-new');
  assertEqual(plan.items.length, 0, 'items 应为空');
  assertEqual(plan.pending, 0);
  assertEqual(plan.backlog, 0);
  assertEqual(plan.nextCursor.lastSeq, 0, '无 items 时 nextCursor 等于入参游标');
  assertEqual(plan.gap, null);
  assertEqual(plan.overflow, null);
});

check('2 无新增（游标已在最后）：no-new 且游标保持 5', () => {
  const plan = planSlice({ messages: msgs(5), cursor: { lastSeq: 5 } });
  assertEqual(plan.reason, 'no-new');
  assertEqual(plan.items.length, 0);
  assertEqual(plan.backlog, 0);
  assertEqual(plan.nextCursor.lastSeq, 5, 'nextCursor 必须原样返回入参游标');
});

check('3 恰好等于 maxMessages：整批 ok 且 pending 清零', () => {
  const plan = planSlice({ messages: msgs(40), cursor: { lastSeq: 0 } });
  assertEqual(plan.ok, true);
  assertEqual(plan.reason, 'ok');
  assertEqual(plan.items.length, 40);
  assertEqual(plan.backlog, 40);
  assertEqual(plan.pending, 0, '一片吃完，无剩余');
  assertEqual(plan.nextCursor.lastSeq, 40);
});

check('4 超过 maxMessages：只取最旧 40 条，pending/backlog 正确', () => {
  const plan = planSlice({ messages: msgs(100), cursor: { lastSeq: 0 } });
  assertEqual(plan.items.length, 40, '每片最多 40 条');
  assertEqual(seqs(plan.items), seqs(msgs(40)), '必须取最旧的 1..40，绝不跳最旧');
  assertEqual(plan.backlog, 100);
  assertEqual(plan.pending, 60, '本片之后还剩 60 条');
  assertEqual(plan.nextCursor.lastSeq, 40);
  assertEqual(plan.ok, true);
});

check('5 items 是原始对象引用（不是拷贝）', () => {
  const input = msgs(10);
  const plan = planSlice({ messages: input, cursor: { lastSeq: 0 }, minMessages: 1 });
  assert(plan.items[0] === input[0], 'items[0] 必须是原对象引用');
  assert(plan.items[9] === input[9], 'items 末项必须是原对象引用');
});

check('6 below-min：items 仍返回，nextCursor 不前进，下次重试同一批', () => {
  const first = planSlice({ messages: msgs(3), cursor: { lastSeq: 0 } });
  assertEqual(first.ok, false);
  assertEqual(first.reason, 'below-min');
  assertEqual(first.items.length, 3, '不足 min 也要把这几条返回');
  assertEqual(first.nextCursor.lastSeq, 0, 'below-min 时游标必须原地不动');
  const committed = commitSlice({ lastSeq: 0 }, first);
  assertEqual(committed.lastSeq, 0, 'commit 也不该推进');
  const retry = planSlice({ messages: msgs(3), cursor: committed });
  assertEqual(seqs(retry.items), '1,2,3', '重试必须还是同一批');
  assertEqual(retry.reason, 'below-min');
});

check('7 乱序输入：按 seq 升序重新排列', () => {
  const plan = planSlice({ messages: [{ seq: 3 }, { seq: 1 }, { seq: 2 }], cursor: { lastSeq: 0 }, minMessages: 1 });
  assertEqual(seqs(plan.items), '1,2,3');
  assertEqual(plan.nextCursor.lastSeq, 3);
});

check('8 重复 seq：去重且保留首次出现的那条', () => {
  const plan = planSlice({
    messages: [{ seq: 1, text: 'a' }, { seq: 1, text: 'b' }, { seq: 2, text: 'c' }],
    cursor: { lastSeq: 0 },
    minMessages: 1,
  });
  assertEqual(plan.items.length, 2, '同 seq 只能留一条');
  assertEqual(plan.items[0].text, 'a', '保留首次出现的那条');
  assertEqual(plan.backlog, 2);
  assertEqual(plan.nextCursor.lastSeq, 2);
});

check('9 非法 seq（0/负数/小数/字符串/缺失/null 项）被丢弃', () => {
  const plan = planSlice({
    messages: [{ seq: 0 }, { seq: -1 }, { seq: 1.5 }, { seq: 'x' }, { seq: null }, {}, null, { seq: 2 }],
    cursor: { lastSeq: 0 },
    minMessages: 1,
  });
  assertEqual(plan.items.length, 1, '只有 seq 2 是合法的');
  assertEqual(plan.items[0].seq, 2);
  assertEqual(plan.backlog, 1);
});

check('10 gap：游标与首条之间被截断时要报告', () => {
  const plan = planSlice({ messages: msgs(2, 15), cursor: { lastSeq: 10 } });
  assert(plan.gap, '应报告 gap');
  assertEqual(plan.gap.expectedSeq, 11);
  assertEqual(plan.gap.firstSeq, 15);
  assertEqual(plan.backlog, 2);
});

check('11 gap：连续有货 / 游标为 0 时不报告', () => {
  const continuous = planSlice({ messages: msgs(4, 11), cursor: { lastSeq: 10 } });
  assertEqual(continuous.gap, null, '首条正好是 lastSeq+1，不该报 gap');
  const fresh = planSlice({ messages: msgs(3, 100), cursor: { lastSeq: 0 } });
  assertEqual(fresh.gap, null, '游标为 0（还没学过）没有"中间"可言');
});

check('12 overflow：报区间/条数/中文原因', () => {
  const plan = planSlice({ messages: msgs(512), cursor: { lastSeq: 0 } });
  assert(plan.overflow, '应报告 overflow');
  assertEqual(plan.overflow.reason, 'backlog-hard-cap');
  assertEqual(plan.overflow.count, 112, '512-400=112');
  assertEqual(plan.overflow.droppedRange.fromSeq, 401, '超出部分从第 401 条开始');
  assertEqual(plan.overflow.droppedRange.toSeq, 512);
  assertIncludes(plan.overflow.message, '积压 512 条超上限 400');
  assertIncludes(plan.overflow.message, '401-512');
  assertIncludes(plan.overflow.message, '共 112 条未处理');
  assertEqual(plan.backlog, 512);
});

check('13 overflow 只报告，不改变切片（仍取最旧 40 条）', () => {
  const plan = planSlice({ messages: msgs(512), cursor: { lastSeq: 0 } });
  assertEqual(plan.ok, true);
  assertEqual(plan.items.length, 40);
  assertEqual(seqs(plan.items), seqs(msgs(40)), '仍是最旧的 1..40');
  assertEqual(plan.nextCursor.lastSeq, 40);
  assertEqual(plan.pending, 472, '512-40=472');
});

check('14 commitSlice：仅 ok 时前进', () => {
  const okPlan = planSlice({ messages: msgs(10), cursor: { lastSeq: 0 } });
  assertEqual(okPlan.ok, true);
  assertEqual(commitSlice({ lastSeq: 0 }, okPlan).lastSeq, 10, 'ok 应推进到本片末条');
  const belowMin = planSlice({ messages: msgs(2), cursor: { lastSeq: 0 } });
  assertEqual(commitSlice({ lastSeq: 0 }, belowMin).lastSeq, 0, 'below-min 不推进');
  const noNew = planSlice({ messages: [], cursor: { lastSeq: 0 } });
  assertEqual(commitSlice({ lastSeq: 7 }, noNew).lastSeq, 7, 'no-new 保持原游标');
  assertEqual(commitSlice({ lastSeq: 7 }, null).lastSeq, 7, 'planned 为 null 也不抛');
});

check('15 commitSlice：不修改入参（冻结对象也不炸）', () => {
  const cursor = Object.freeze({ lastSeq: 10 });
  const planned = Object.freeze({ ok: true, nextCursor: Object.freeze({ lastSeq: 20 }) });
  const next = commitSlice(cursor, planned);
  assertEqual(next.lastSeq, 20);
  assert(next !== cursor, '必须返回新对象');
  assertEqual(cursor.lastSeq, 10, '入参游标不能被改');
  assertEqual(planned.nextCursor.lastSeq, 20, 'planned 不能被改');
});

check('16 normalizeSliceCursor：四种脏输入都回落 0', () => {
  assertEqual(normalizeSliceCursor(null).lastSeq, 0, 'null');
  assertEqual(normalizeSliceCursor({}).lastSeq, 0, '缺 lastSeq');
  assertEqual(normalizeSliceCursor({ lastSeq: -5 }).lastSeq, 0, '负数');
  assertEqual(normalizeSliceCursor({ lastSeq: 'abc' }).lastSeq, 0, '非数字字符串');
  assertEqual(normalizeSliceCursor({ lastSeq: NaN }).lastSeq, 0, 'NaN');
  assertEqual(normalizeSliceCursor({ lastSeq: 1e30 }).lastSeq, 0, '超出安全整数');
});

check('17 normalizeSliceCursor：正常值与小数取整', () => {
  assertEqual(normalizeSliceCursor({ lastSeq: 12 }).lastSeq, 12);
  assertEqual(normalizeSliceCursor({ lastSeq: 0 }).lastSeq, 0);
  assertEqual(normalizeSliceCursor({ lastSeq: 3.9 }).lastSeq, 3, '闭区间向下取整');
});

check('18 describeBacklog：无数据返回 0 / null 且不抛', () => {
  const empty = describeBacklog({ messages: [], cursor: { lastSeq: 0 } });
  assertEqual(empty.pending, 0);
  assertEqual(empty.firstSeq, null);
  assertEqual(empty.lastSeq, null);
  assertEqual(empty.oldestUnprocessedSeq, null);
  const dirty = describeBacklog(null);
  assertEqual(dirty.pending, 0, '脏输入也不能抛');
});

check('19 describeBacklog：待处理的区间与最旧 seq', () => {
  const info = describeBacklog({ messages: msgs(10), cursor: { lastSeq: 4 } });
  assertEqual(info.pending, 6, '5..10 共 6 条');
  assertEqual(info.firstSeq, 5);
  assertEqual(info.lastSeq, 10);
  assertEqual(info.oldestUnprocessedSeq, 5);
  const drained = describeBacklog({ messages: msgs(10), cursor: { lastSeq: 10 } });
  assertEqual(drained.pending, 0);
  assertEqual(drained.firstSeq, null);
});

check('20 连续推进：循环 5 次刚好把 200 条吃完，总数正好 200', () => {
  const messages = msgs(200);
  let cursor = { lastSeq: 0 };
  const eaten = [];
  for (let i = 0; i < 5; i += 1) {
    const plan = planSlice({ messages, cursor });
    assertEqual(plan.ok, true, `第 ${i + 1} 片应该 ok`);
    assertEqual(plan.items.length, 40, `第 ${i + 1} 片应为 40 条`);
    assertEqual(plan.pending, 200 - 40 * (i + 1), `第 ${i + 1} 片后剩余`);
    eaten.push(...plan.items);
    cursor = commitSlice(cursor, plan);
  }
  assertEqual(eaten.length, 200, '总条数必须正好 200');
  assertEqual(seqs(eaten), seqs(msgs(200)), '顺序必须是 1..200，不重不漏');
  assertEqual(cursor.lastSeq, 200, '游标应推到 200');
  assertEqual(planSlice({ messages, cursor }).reason, 'no-new', '吃完之后应为 no-new');
  const info = describeBacklog({ messages, cursor });
  assertEqual(info.pending, 0);
  assertEqual(info.oldestUnprocessedSeq, null);
});

check('21 全脏入参：一律按默认值降级，不抛异常', () => {
  const nullPlan = planSlice(null);
  assertEqual(nullPlan.reason, 'no-new');
  assertEqual(nullPlan.nextCursor.lastSeq, 0);
  const badMessages = planSlice({ messages: 'nope', cursor: null, maxMessages: 'abc' });
  assertEqual(badMessages.reason, 'no-new', 'messages 非数组按空处理');
  const badMax = planSlice({ messages: msgs(100), cursor: { lastSeq: 0 }, maxMessages: 'abc' });
  assertEqual(badMax.items.length, 40, 'maxMessages 非数字应回落默认 40');
  const badMin = planSlice({ messages: msgs(3), cursor: { lastSeq: 0 }, minMessages: 'x' });
  assertEqual(badMin.reason, 'below-min', 'minMessages 非数字应回落默认 6');
  assertEqual(PROFILE_SLICE_DEFAULTS.maxMessages, 40);
  assertEqual(PROFILE_SLICE_DEFAULTS.minMessages, 6);
  assertEqual(PROFILE_SLICE_DEFAULTS.maxBacklog, 400);
});

check('22 重启：游标经 JSON 落盘/回读后继续推进，不重复、不跳条', () => {
  const window = msgs(120);
  const first = planSlice({ messages: window, cursor: { lastSeq: 0 }, maxMessages: 40, minMessages: 6 });
  assertEqual(first.items.length, 40);
  const committed = commitSlice({ lastSeq: 0 }, first);
  // 落盘再回读：profiles.meta.sliceCursors 里存的就是这么一坨 JSON。
  const restored = normalizeSliceCursor(JSON.parse(JSON.stringify(committed)));
  assertEqual(restored.lastSeq, committed.lastSeq, '回读后游标不变');
  const second = planSlice({ messages: window, cursor: restored, maxMessages: 40, minMessages: 6 });
  assertEqual(second.items[0].seq, committed.lastSeq + 1, '重启后从游标之后第一条接着切');
  assertEqual(second.items.length, 40, '第二片仍是满片');
  const overlap = second.items.filter((m) => m.seq <= committed.lastSeq);
  assertEqual(overlap.length, 0, '重启后不会重复处理已提交的消息');
});

check('23 待处理统计：积压与最老 seq 能对上窗口里真实的消息', () => {
  const window = msgs(30);
  const info = describeBacklog({ cursor: { lastSeq: 10 }, messages: window });
  assertEqual(info.pending, 20);
  assertEqual(info.firstSeq, 11);
  assertEqual(info.lastSeq, 30);
  assertEqual(info.oldestUnprocessedSeq, 11, '最老未处理 = 游标后第一条');
});


const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
for (const r of results) {
  if (r.ok) console.log(`ok   ${r.name}`);
  else console.log(`FAIL ${r.name}\n     ${r.error}`);
}
if (failed) {
  console.log(`FAIL：${passed} 项通过，${failed} 项失败`);
  process.exit(1);
}
console.log(`PASS：${passed} 项通过，0 项失败`);
