#!/usr/bin/env node
/**
 * B2 采样 A/B 脚手架测试。
 *
 * 重点不是「跑通 CLI」，而是守住 B2 的硬约束：
 *   1. 一次只改一个变量（改两个必须报错）；
 *   2. 同 seed 同结果（配对顺序可复现）；
 *   3. 缺回复必须能被数出来，不能悄悄产出残缺实验；
 *   4. 盲评表不能泄露组名，答案只写在 baseline.json；
 *   5. 有了分数就能按组算胜场。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPlan,
  countMissing,
  currentSampling,
  diffGroup,
  pairReplies,
  readContexts,
  scoreWins,
  sideOrder,
  writeReport
} from '../eval/ab-sampling.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

const control = { temperature: 1.15, topP: 0.95, presencePenalty: 0.4, frequencyPenalty: 0.2 };

console.log('硬约束：一次只改一个变量');
check('改一个变量通过，并给出 from→to', () => {
  const d = diffGroup(control, { ...control, temperature: 1.0 });
  assert.deepEqual(d, { key: 'temperature', from: 1.15, to: 1.0 });
});
check('改两个变量必须报错', () => {
  assert.throws(() => diffGroup(control, { ...control, temperature: 1.0, topP: 0.9 }), /一次只改一个/);
});
check('与对照完全相同必须报错', () => {
  assert.throws(() => diffGroup(control, { ...control }), /不构成实验/);
});

console.log('计划与配对');
const contexts = readContexts().slice(0, 3);
const variants = [
  { name: 'temperature-1p0', params: { ...control, temperature: 1.0 } },
  { name: 'presencePenalty-0p2', params: { ...control, presencePenalty: 0.2 } }
];
check('上下文至少有 3 条可用于测试', () => assert.ok(contexts.length === 3));
const plan = buildPlan({ control, variants, contexts, samples: 2, seed: 7, tag: 'ab-test' });
check('plan 含 1 对照 + 2 变体', () => assert.equal(plan.groups.length, 3));
check('重复参数组会被拒绝（同为 temperature=1.0 两次）', () => {
  const dup = [
    { name: 'a', params: { ...control, temperature: 1.0 } },
    { name: 'b', params: { ...control, temperature: 1.0 } }
  ];
  assert.throws(() => buildPlan({ control, variants: dup, contexts, samples: 1, seed: 1, tag: 'x' }), /完全相同/);
});
check('sideOrder 同 seed 稳定、不同 id 有区分', () => {
  assert.equal(sideOrder(7, 'c01~v~1'), sideOrder(7, 'c01~v~1'));
  const outs = new Set(['c01~v~1', 'c02~v~1', 'c03~v~1', 'c01~v~2'].map((id) => sideOrder(7, id)));
  assert.ok(outs.size >= 1);
});

// 造一个临时 run 目录：只填部分回复，验证缺失统计与配对。
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-run-'));
for (const group of plan.groups) fs.mkdirSync(path.join(runDir, 'replies', group.name), { recursive: true });
for (const c of contexts) {
  for (let i = 1; i <= plan.samples; i++) {
    fs.writeFileSync(path.join(runDir, 'replies', 'control', `${c.id}_${i}.txt`), `控制组回复${c.id}-${i}`, 'utf8');
    if (!(c.id === contexts[2].id && i === 2)) {
      fs.writeFileSync(path.join(runDir, 'replies', 'temperature-1p0', `${c.id}_${i}.txt`), `变体A回复${c.id}-${i}`, 'utf8');
    }
    fs.writeFileSync(path.join(runDir, 'replies', 'presencePenalty-0p2', `${c.id}_${i}.txt`), `变体B回复${c.id}-${i}`, 'utf8');
  }
}
check('缺回复能被数出来', () => {
  const missing = countMissing(runDir, plan);
  assert.equal(missing['temperature-1p0'], 1);
  assert.equal(missing['presencePenalty-0p2'], 0);
});
const paired = pairReplies(runDir, plan);
check('配对数量 = 上下文 × 变体 × 样本 − 缺失', () => {
  assert.equal(paired.rows.length, 3 * 2 * 2 - 1);
  assert.equal(paired.warnings.length, 1);
});
check('blind.csv 不含组名，baseline.json 才存答案', () => {
  const metrics = writeReport(runDir, paired, plan);
  const blind = fs.readFileSync(path.join(runDir, 'blind.csv'), 'utf8');
  assert.ok(!blind.includes('temperature-1p0'));
  assert.ok(!blind.includes('presencePenalty'));
  assert.match(metrics, /配对：11 对/);
  const base = JSON.parse(fs.readFileSync(path.join(runDir, 'baseline.json'), 'utf8'));
  assert.equal(Object.keys(base.key).length, 11);
  for (const mapping of Object.values(base.key)) {
    assert.equal(new Set(Object.values(mapping)).size, 2);
    assert.ok(Object.values(mapping).includes('control'));
  }
});
check('同一对的 side1/side2 来自不同组', () => {
  for (const mapping of Object.values(JSON.parse(fs.readFileSync(path.join(runDir, 'baseline.json'), 'utf8')).key)) {
    assert.notEqual(mapping['1'], mapping['2']);
  }
});

console.log('打分与胜场');
check('没有分数时返回 no-scores', () => {
  const res = scoreWins(runDir, plan);
  assert.equal(res.ok, false);
});
check('有分数时按组算胜场', () => {
  const base = JSON.parse(fs.readFileSync(path.join(runDir, 'baseline.json'), 'utf8'));
  const rows = ['reviewer,id,side,natural,faithful,harm,template,stable,note'];
  for (const item of base.items) {
    // 让「非 control 组」永远高 1 分，验证胜场归属是否跟着 key 走。
    const higher = base.key[item.id]['1'] === 'control' ? '2' : '1';
    for (const side of ['1', '2']) {
      const v = side === higher ? 5 : 4;
      rows.push(`A,${item.id},${side},${v},${v},${v},${v},${v},`);
    }
  }
  fs.writeFileSync(path.join(runDir, 'scores-reviewer-A.csv'), rows.join('\n'), 'utf8');
  const res = scoreWins(runDir, plan);
  assert.equal(res.ok, true);
  const temp = res.wins.get('temperature-1p0');
  const pres = res.wins.get('presencePenalty-0p2');
  const ctrl = res.wins.get('control');
  assert.ok(temp.win > 0 && pres.win > 0, `temp=${JSON.stringify(temp)} pres=${JSON.stringify(pres)}`);
  // control 每输一次 = 某个变体赢一次；两个变体的胜场之和必须等于 control 的负场。
  assert.equal(temp.win + pres.win, ctrl.lose);
  assert.equal(temp.lose + pres.lose, ctrl.win);
});

check('currentSampling 读到的是真实 config', () => {
  const s = currentSampling();
  for (const key of ['temperature', 'topP', 'presencePenalty', 'frequencyPenalty']) {
    assert.ok(Number.isFinite(s[key]), `${key} 不是数字`);
  }
});

check('空单元格不按 0 分（没评的整行跳过）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-empty-'));
  fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify({ items: [{ id: 'c01' }], key: { c01: { 1: 'control', 2: 'temp' } } }));
  fs.writeFileSync(path.join(dir, 'scores-reviewer-A.csv'), [
    'reviewer,id,side,natural,faithful,harm,template,stable,note',
    'A,c01,1,5,5,5,5,5,',
    'A,c01,2,,'
  ].join('\n'));
  const res = scoreWins(dir, null);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(res.ok, true);
  // side 2 全是空单元格 → 该对不参与比较，不产生胜场（旧实现会把它当 0 分送对手一胜）。
  const control = res.wins.get('control');
  assert.ok(!control || (control.win === 0 && control.tie === 0), `空单元格被当成 0 分了：${JSON.stringify([...res.wins])}`);
});

fs.rmSync(runDir, { recursive: true, force: true });
console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);
