// 记忆过期降权（src/memory-decay.mjs）的离线单测。
// 不连 QQ、不连 DSH、不写任何生产文件；只验证纯函数的评分/排序/折叠/截断/裁剪行为。
// 用法：node scripts/test-memory-decay.mjs   失败时 exit 1。
import assert from 'node:assert/strict';
import {
  DEFAULT_DECAY_CFG,
  buildMemoryPromptBlock,
  decayScore,
  foldMemories,
  pruneExpired,
  rankMemories
} from '../src/memory-decay.mjs';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0); // 固定 now，避免跑测试时的时间抖动

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
function near(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}（期望 ${expected}±${tolerance}，实际 ${actual}）`);
}
function oldImpression(days, index = 0) {
  return {
    kind: 'memberImpression',
    name: `群友${index}`,
    text: `旧印象${index}`,
    updatedAt: NOW - days * DAY,
    traits: [`旧印象${index}`],
    interactionCount: 1
  };
}

// ── 评分口径 ────────────────────────────────────────────────────────────────

check('新条目分高（刚更新 ≈ 1.0）', () => {
  const score = decayScore({ kind: 'activeTopic', text: '刚聊的话题', updatedAt: NOW }, NOW);
  near(score, 1, 0.001, '刚更新的条目应接近满分');
});

check('14 天后分低（两个半衰期 ≈ 0.25）', () => {
  const score = decayScore({ kind: 'memberImpression', text: 'x', updatedAt: NOW - 14 * DAY }, NOW);
  near(score, 0.25, 0.01, '7 天半衰期下 14 天应剩约 0.25');
  assert.ok(score < 0.3, '14 天后必须明显低于新条目');
});

check('半衰期可由 cfg 覆盖（1 天 → 约 0.5）', () => {
  const score = decayScore({ kind: 'activeTopic', text: 'x', updatedAt: NOW - DAY }, NOW, { halfLifeDays: 1 });
  near(score, 0.5, 0.01, '自定义 1 天半衰期');
});

check('hits 提供加成（同年龄，引用多的分更高）', () => {
  const base = { kind: 'activeTopic', text: 'x', updatedAt: NOW - 7 * DAY };
  const plain = decayScore(base, NOW);
  const hot = decayScore({ ...base, hits: 8 }, NOW);
  near(plain, 0.5, 0.01, '7 天 = 一个半衰期');
  assert.ok(hot > plain, `hits=8 应高于 hits=0（实际 ${hot} vs ${plain}）`);
  assert.ok(hot <= 1, '权重不得超过 1');
});

check('未过期 pendingThought 有下限（不会被压到 0）', () => {
  const score = decayScore(
    { kind: 'pendingThought', text: '待办', createdAt: NOW - 100 * DAY, expiresAt: NOW + HOUR },
    NOW
  );
  assert.equal(score, DEFAULT_DECAY_CFG.pendingFloor, '100 天未过期的待办应被抬到下限');
  const custom = decayScore(
    { kind: 'pendingThought', text: '待办', createdAt: NOW - 100 * DAY, expiresAt: NOW + HOUR },
    NOW,
    { pendingFloor: 0.6 }
  );
  assert.equal(custom, 0.6, 'cfg.pendingFloor 应生效');
});

check('已过期 pendingThought 失去下限并明显降权', () => {
  const score = decayScore(
    { kind: 'pendingThought', text: '过期待办', createdAt: NOW - 10 * DAY, expiresAt: NOW - 3 * DAY },
    NOW
  );
  assert.ok(score < 0.05, `过期 3 天应接近 0（实际 ${score}）`);
});

// ── 排序 ────────────────────────────────────────────────────────────────────

check('rankMemories 按分数降序且稳定', () => {
  const list = [
    { kind: 'activeTopic', text: 'A', updatedAt: NOW - 30 * DAY },
    { kind: 'activeTopic', text: 'B', updatedAt: NOW },
    { kind: 'activeTopic', text: 'C', updatedAt: NOW },
    { kind: 'activeTopic', text: 'D', updatedAt: NOW - 14 * DAY }
  ];
  const ranked = rankMemories(list, NOW);
  assert.deepEqual(ranked.map((entry) => entry.text), ['B', 'C', 'D', 'A'], '同分应保持原顺序');
  assert.ok(ranked[0]._score >= ranked[1]._score && ranked[1]._score >= ranked[2]._score, '分数单调不增');
  assert.ok(ranked.every((entry) => typeof entry._score === 'number'), '每条都带 _score');
  assert.equal(list[0]._score, undefined, '不得给入参对象写 _score');
});

// ── 折叠 ────────────────────────────────────────────────────────────────────

check('foldMemories 折叠低分条目并给出准确摘要', () => {
  const list = [oldImpression(60, 1), oldImpression(61, 2), oldImpression(62, 3), oldImpression(63, 4), oldImpression(64, 5), {
    kind: 'activeTopic',
    text: '新话题',
    updatedAt: NOW
  }];
  const snapshot = JSON.stringify(list);
  const folded = foldMemories(list, NOW);
  assert.ok(Array.isArray(folded), '应返回数组');
  assert.equal(folded.length, 2, '5 条旧印象应折成 1 条，加上新话题共 2 条');
  assert.equal(folded[0].text, '新话题', '新话题应排在前面');
  assert.equal(folded[1].folded, true);
  assert.equal(folded[1].count, 5);
  assert.equal(folded[1].text, '较早的 5 条印象已被折叠');
  assert.equal(JSON.stringify(list), snapshot, '不得修改原数组/原对象');
});

check('foldMemories 未达 foldMinCount 时不折叠', () => {
  const list = [oldImpression(60, 1), oldImpression(61, 2)];
  const folded = foldMemories(list, NOW);
  assert.equal(folded.length, 2, '2 条少于默认 3 条，不折叠');
  assert.ok(folded.every((entry) => entry.folded !== true), '不应出现折叠摘要');
});

check('未过期 pendingThought 永不折叠', () => {
  const list = [1, 2, 3, 4].map((i) => ({
    kind: 'pendingThought',
    text: `待说${i}`,
    createdAt: NOW - (100 + i) * DAY,
    expiresAt: NOW + HOUR
  }));
  const folded = foldMemories(list, NOW);
  assert.equal(folded.length, 4, '待办不能被折叠吃掉');
  assert.ok(folded.every((entry) => entry.folded !== true));
  assert.ok(folded.every((entry) => entry._score >= DEFAULT_DECAY_CFG.pendingFloor), '待办分数应保留下限');
});

check('foldMinCount / foldThreshold 可由 cfg 覆盖', () => {
  const list = [oldImpression(60, 1), oldImpression(61, 2)];
  const folded = foldMemories(list, NOW, { foldMinCount: 2, foldThreshold: 0.5 });
  assert.equal(folded.length, 1, 'cfg 降低门槛后 2 条就折叠');
  assert.equal(folded[0].count, 2);
});

// ── 文本块 ──────────────────────────────────────────────────────────────────

check('buildMemoryPromptBlock 空输入返回空串', () => {
  assert.equal(buildMemoryPromptBlock([], NOW), '');
  assert.equal(buildMemoryPromptBlock(null, NOW), '');
  assert.equal(buildMemoryPromptBlock(undefined, NOW), '');
});

check('buildMemoryPromptBlock 默认上限 1200 且不修改入参', () => {
  const list = Object.freeze(
    Array.from({ length: 12 }, (_, i) =>
      Object.freeze({ kind: 'activeTopic', text: `话题${i}`, updatedAt: NOW - i * DAY })
    )
  );
  assert.ok(Object.isFrozen(list), '数组应保持冻结（未被替换）');
  const block = buildMemoryPromptBlock(list, NOW);
  assert.equal(typeof block, 'string');
  assert.ok(block.length <= DEFAULT_DECAY_CFG.maxChars, `长度 ${block.length} 不得超过 1200`);
  assert.ok(block.includes('话题0'), '最高分条目应保留');
  assert.ok(!block.includes('（已省略'), '默认 1200 字符下 12 条短记忆不该被截断');
  assert.equal(list[0]._score, undefined, '入参对象不得被写 _score');
});

check('buildMemoryPromptBlock 超限时按低分截断并统计省略数', () => {
  const total = 30;
  const list = Array.from({ length: total }, (_, i) => ({
    kind: 'activeTopic',
    text: `话题${i}-${'内容'.repeat(6)}`,
    updatedAt: NOW - i * DAY
  }));
  const block = buildMemoryPromptBlock(list, NOW, { maxChars: 200, foldMinCount: 999 });
  assert.ok(block.length <= 200, `长度 ${block.length} 不得超过配置上限 200`);
  const match = block.match(/（已省略 (\d+) 条较早记忆）$/);
  assert.ok(match, `截断后应以省略提示结尾，实际：${JSON.stringify(block.slice(-40))}`);
  const omitted = Number(match[1]);
  assert.ok(omitted >= 1 && omitted < total, `省略数应在 1..${total - 1} 之间，实际 ${omitted}`);
  assert.ok(block.startsWith('- 话题：话题0'), '最高分条目不能先被丢');
  assert.ok(!block.includes('话题29'), '最低分条目应被截断');
});

check('折叠项被截断时省略计数按真实条数累计', () => {
  const list = [
    { kind: 'activeTopic', text: '新话题'.repeat(20), updatedAt: NOW },
    oldImpression(60, 1),
    oldImpression(61, 2),
    oldImpression(62, 3)
  ];
  const block = buildMemoryPromptBlock(list, NOW, { maxChars: 40 });
  assert.ok(block.length <= 40, `长度 ${block.length} 不得超过 40`);
  assert.equal(block, '（已省略 4 条较早记忆）', `应把 1 条新话题 + 折叠的 3 条一起计入，实际 ${JSON.stringify(block)}`);
});

check('buildMemoryPromptBlock 对非法 cfg 稳健（maxChars 极小）', () => {
  const list = [{ kind: 'activeTopic', text: '内容', updatedAt: NOW }];
  const block = buildMemoryPromptBlock(list, NOW, { maxChars: -5, halfLifeDays: 'abc' });
  assert.ok(block.length <= 1, 'maxChars 应被夹到 ≥1');
});

check('buildMemoryPromptBlock 内部裁掉超过宽限期的过期待办', () => {
  const expired = { kind: 'pendingThought', text: '两天前的过期待办', createdAt: NOW - 3 * DAY, expiresAt: NOW - 25 * HOUR };
  const grace = { kind: 'pendingThought', text: '刚过期的待办', createdAt: NOW - 2 * DAY, expiresAt: NOW - HOUR };
  const block = buildMemoryPromptBlock([expired, grace], NOW);
  assert.ok(!block.includes('两天前的过期待办'), '超宽限期的待办不应进入 prompt 文本块');
  assert.ok(block.includes('刚过期的待办'), '宽限期内的待办仍保留');
});

// ── 裁剪 ────────────────────────────────────────────────────────────────────

check('pruneExpired 只裁掉超过宽限期的 pendingThought', () => {
  const withinGrace = { kind: 'pendingThought', text: '刚过期', expiresAt: NOW - 1 * HOUR };
  const beyondGrace = { kind: 'pendingThought', text: '过期两天', expiresAt: NOW - 25 * HOUR };
  const alive = { kind: 'pendingThought', text: '还有效', expiresAt: NOW + HOUR };
  const topic = { kind: 'activeTopic', text: '话题', expiresAt: NOW - 30 * DAY };
  const list = [withinGrace, beyondGrace, alive, topic];
  const snapshot = JSON.stringify(list);
  const pruned = pruneExpired(list, NOW);
  assert.deepEqual(pruned.map((entry) => entry.text), ['刚过期', '还有效', '话题'], '宽限期内保留，非待办不裁');
  assert.equal(pruned[1], alive, '未过期条目应保持同一对象引用');
  assert.equal(JSON.stringify(list), snapshot, '不得修改原数组');
});

check('pruneExpired 宽限期可由 cfg 覆盖（0h 立即裁）', () => {
  const list = [{ kind: 'pendingThought', text: '刚过期', expiresAt: NOW - HOUR }];
  assert.equal(pruneExpired(list, NOW, { expiredGraceHours: 0 }).length, 0);
  assert.equal(pruneExpired(list, NOW).length, 1);
});

check('pruneExpired 兼容 bridge 的 pendingThought 特征（无 category）', () => {
  const list = [
    { text: '无类别但带 expiry', expiresAt: NOW - 25 * HOUR },
    { text: '无类别无 expiry', createdAt: NOW - DAY }
  ];
  const pruned = pruneExpired(list, NOW);
  assert.deepEqual(pruned.map((entry) => entry.text), ['无类别无 expiry'], '靠 expiresAt 识别为待办');
});

// ── 脏数据 ──────────────────────────────────────────────────────────────────

check('脏数据：缺时间/非法时间不抛错且分数在 0..1', () => {
  const dirty = [
    { kind: 'activeTopic', text: '缺时间' },
    { kind: 'activeTopic', text: '非法时间', updatedAt: 'not-a-date' },
    { kind: 'memberImpression', text: '空字符串时间', updatedAt: '' },
    { kind: 'activeTopic', text: 'NaN 时间', updatedAt: Number.NaN },
    { kind: 'pendingThought', text: '非法 expiresAt', expiresAt: 'tomorrow-ish', createdAt: NOW - 3 * DAY },
    null,
    undefined,
    '字符串条目'
  ];
  for (const entry of dirty) {
    const score = decayScore(entry, NOW);
    assert.ok(Number.isFinite(score) && score >= 0 && score <= 1, `分数越界：${score}（entry=${JSON.stringify(entry)}）`);
  }
  assert.equal(decayScore(null, NOW), 0);
  assert.equal(decayScore({ text: '缺时间' }, NOW), 0.5, '缺失时间按一个半衰期兜底');
  assert.equal(decayScore({ text: '非法', updatedAt: 'not-a-date' }, NOW), 0.5);

  const ranked = rankMemories(dirty, NOW);
  assert.ok(ranked.every((entry) => entry && typeof entry === 'object'), '非对象条目应被过滤');
  const folded = foldMemories(dirty, NOW);
  assert.ok(Array.isArray(folded));
  const block = buildMemoryPromptBlock(dirty, NOW);
  assert.equal(typeof block, 'string');
  assert.ok(block.length <= DEFAULT_DECAY_CFG.maxChars);
  const pruned = pruneExpired(dirty, NOW);
  assert.ok(Array.isArray(pruned), '脏数据也不应让裁剪抛错');
  assert.ok(pruned.every((entry) => entry && typeof entry === 'object'));
});

check('未来时间（时钟回拨）按刚更新处理，不产生 >1 的权重', () => {
  const score = decayScore({ kind: 'activeTopic', text: 'x', updatedAt: NOW + 3 * DAY }, NOW);
  assert.equal(score, 1);
});

// ── 默认配置 ────────────────────────────────────────────────────────────────

check('DEFAULT_DECAY_CFG 默认值与冻结状态', () => {
  assert.deepEqual({ ...DEFAULT_DECAY_CFG }, {
    halfLifeDays: 7,
    pendingFloor: 0.35,
    foldThreshold: 0.15,
    foldMinCount: 3,
    maxChars: 1200,
    expiredGraceHours: 24
  });
  assert.ok(Object.isFrozen(DEFAULT_DECAY_CFG), '默认配置应冻结，避免被就地改写');
});

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  process.exitCode = 1;
}
