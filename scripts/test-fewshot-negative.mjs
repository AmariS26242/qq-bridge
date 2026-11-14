#!/usr/bin/env node
/**
 * 反例库测试（D4）。
 *
 * 反例的价值在于「同一句话，这么接就 AI 味了 / 这么接才对」的对照，
 * 所以这里不只测格式，还测**内容本身站得住**：
 *   1. 每条 ✗ 都必须真的被 ai-tone 规则命中（否则它不算反例，只是随便一句）；
 *   2. 每条 ✓ 在同样的激进参数下必须原样通过（否则教出来的还是 AI 味）；
 *   3. 反例块默认不注入（negativeEnabled=false），且注入块有长度上限。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deslopChatText } from '../src/ai-tone.js';
import {
  FEWSHOT_DEFAULTS,
  NEGATIVE_LIMITS,
  formatNegativeBlock,
  loadFewshot,
  normalizeNegative,
  readNegatives,
  retrieveNegatives
} from '../src/fewshot-lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(ROOT, 'persona-lib', 'fewshot');
// 激进参数：把「默认关着」的规则也打开，确保反例是靠真规则判出来的。
const STRICT = { stripTrailingPeriod: true, stripAgreeOpener: true, normalizeDash: true, fallback: '嗯', keepPhrases: [], extraPhrases: [] };

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name} — ${error.message}`);
  }
}

console.log('反例库文件');
const { negatives, errors } = readNegatives(path.join(LIB, 'negative.jsonl'));
check('解析出 12 条反例、0 行坏行', () => {
  assert.equal(errors.length, 0, errors.join('; '));
  assert.equal(negatives.length, 12);
});
check('id 唯一', () => {
  assert.equal(new Set(negatives.map((item) => item.id)).size, negatives.length);
});
check('每条都有 bad/good/why 和标签', () => {
  for (const item of negatives) {
    assert.ok(item.bad && item.good && item.why, `缺字段：${item.id}`);
    assert.ok(item.tags.length > 0, `缺标签：${item.id}`);
    assert.ok(item.bad !== item.good);
  }
});

console.log('内容站得住：✗ 必须被规则命中，✓ 必须原样通过');
// `covered:false` 的条目是「规则洗不掉、只能靠 few-shot 教」的已知缺口（见 why 字段与 §6.22），
// 它们不参与「必须命中」断言；数量刻意钉死，加一条缺口就必须同时改这里，避免缺口悄悄变多。
const uncovered = negatives.filter((item) => item.covered === false);
check('已知缺口正好 4 条（规则覆盖不到的类型）', () => {
  assert.equal(uncovered.length, 4, uncovered.map((item) => item.why).join(' / '));
});
for (const item of negatives) {
  if (item.covered === false) {
    check(`[${item.id}] 已知缺口：${item.why}`, () => {
      const out = deslopChatText(item.bad, STRICT);
      assert.equal(out.changed || out.hits.length > 0, false, '缺口被规则补上了：请把 covered 改成 true');
    });
  } else {
    check(`[${item.id}] ✗ 命中规则：${item.why}`, () => {
      const out = deslopChatText(item.bad, STRICT);
      assert.ok(out.changed || out.hits.length > 0, `未被任何规则命中：${JSON.stringify(item.bad)}`);
    });
  }
  check(`[${item.id}] ✓ 原样通过`, () => {
    const out = deslopChatText(item.good, STRICT);
    assert.equal(out.text, item.good, `被改写成 ${JSON.stringify(out.text)}（hits=${JSON.stringify(out.hits)}）`);
  });
}

console.log('渲染与检索');
check('块最多 2 条、含 ✗/✓、总长 < 400 字符', () => {
  const block = formatNegativeBlock(negatives);
  assert.ok(block.startsWith('【别这么接 · AI 味反例】'));
  assert.equal((block.match(/✗/g) ?? []).length, NEGATIVE_LIMITS.maxInBlock);
  assert.equal((block.match(/✓/g) ?? []).length, NEGATIVE_LIMITS.maxInBlock);
  assert.ok(block.length < 400, `实际 ${block.length}`);
});
check('空库渲染空串', () => {
  assert.equal(formatNegativeBlock([]), '');
  assert.equal(formatNegativeBlock(null), '');
});
check('检索优先选当轮消息相近的那条', () => {
  const picked = retrieveNegatives(negatives, ['明天考试完全没复习'], { max: 2 });
  assert.equal(picked.length, 2);
  assert.ok(picked[0].tags.includes('结构化'), `第一条是 ${picked[0].tags.join('/')}`);
});
check('检索结果稳定（同输入同输出）', () => {
  const a = retrieveNegatives(negatives, ['今天加班'], { max: 2 }).map((item) => item.id).join(',');
  const b = retrieveNegatives(negatives, ['今天加班'], { max: 2 }).map((item) => item.id).join(',');
  assert.equal(a, b);
});

console.log('规范化与默认值');
check('缺 good / bad=good 时拒绝', () => {
  assert.equal(normalizeNegative({ bad: '听起来你最近挺累的' }), null);
  assert.equal(normalizeNegative({ bad: '嗯', good: '嗯' }), null);
  assert.equal(normalizeNegative({ bad: '', good: '好' }), null);
});
check('超长裁剪到上限', () => {
  const item = normalizeNegative({ bad: 'x'.repeat(500), good: '好' });
  assert.equal([...item.bad].length, NEGATIVE_LIMITS.badMax);
});
check('loadFewshot 会带上反例，默认不注入', () => {
  const lib = loadFewshot(LIB);
  assert.equal(lib.negative.length, 12);
  assert.equal(FEWSHOT_DEFAULTS.negativeEnabled, false);
});

console.log('接线：默认不注入，开关打开才拼');
check('bridge.js 只在 negativeEnabled === true 时拼反例块', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.ok(bridge.includes('few.negativeEnabled === true && Array.isArray(lib.negative)'));
  assert.ok(bridge.includes('formatNegativeBlock(retrieveNegatives(lib.negative'));
  assert.ok(bridge.includes('2 条反例'), '日志里说明注入了反例');
  // 反例不能依赖正例：旧版 `if (!examples.length) return '';` 会让开关静默失效。
  assert.ok(bridge.includes('const picked = examples.length'), '正例为空时仍继续走反例分支');
  // 线上真出过一次 ReferenceError：bridge 用了 fewshot-lib 的 NEGATIVE_LIMITS 却没 import，
  // 只在「开关打开」时才触发，测试全绿而唤醒接口 500。这里把「用到就必须 import」钉死。
  for (const name of ['FEWSHOT_DEFAULTS', 'NEGATIVE_LIMITS', 'formatNegativeBlock', 'retrieveNegatives']) {
    if (!bridge.includes(name)) continue;
    const importLine = bridge.split('\n').find((l) => l.startsWith('import') && l.includes("'./fewshot-lib.js'"));
    assert.ok(importLine && importLine.includes(name), `bridge.js 用了 ${name} 就必须从 fewshot-lib.js import`);
  }
});

check('反例块受 maxChars 预算约束（塞不下就整块不注入）', () => {
  const block = formatNegativeBlock(negatives, { max: 2, maxChars: 12 });
  assert.equal(block, '', '12 字符连标题都放不下，应返回空串而不是半截标记');
  const wide = formatNegativeBlock(negatives, { max: 2, maxChars: 400 });
  assert.ok(wide.length <= 400, `反例块 ${wide.length} 超预算`);
});

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);
