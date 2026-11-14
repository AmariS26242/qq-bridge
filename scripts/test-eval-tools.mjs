// eval/ 工具链自测：CSV 解析（含跨行字段）、逐条评分确定性、汇总脚本的两条分支。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCsv, parseCsvObjects, csvLine } from '../eval/csv.mjs';

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log(`ok   ${name}`); }
  catch (e) { fail += 1; console.log(`FAIL ${name}\n     ${e?.message ?? e}`); }
}

ok('parseCsv 支持字段内换行与 "" 转义', () => {
  const text = '"id","text"\n"c1","第一行\n第二行"\n"c2","他说""好"""\n';
  const rows = parseCsv(text);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][1], '第一行\n第二行');
  assert.equal(rows[2][1], '他说"好"');
});

ok('parseCsvObjects 用表头映射字段', () => {
  const objs = parseCsvObjects('"a","b"\n"1","2"\n');
  assert.deepEqual(objs, [{ a: '1', b: '2' }]);
});

ok('csvLine 只在需要时加引号', () => {
  assert.equal(csvLine(['a', 'b,c', 'd"e', 'f\ng']), 'a,"b,c","d""e","f\ng"');
});

ok('空文本与只有表头时不产生空对象', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsvObjects('"a","b"\n'), []);
});

ok('review-machine 对同一 run 两次产出逐字节一致', () => {
  const runDir = path.join(import.meta.dirname, '..', 'eval', 'runs', '2026-10-26T05-24-34-baseline-2');
  const file = path.join(runDir, 'scores-reviewer-M.csv');
  const run = () => spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'eval', 'review-machine.mjs'), runDir], { encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const a = fs.readFileSync(file);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.ok(a.equals(fs.readFileSync(file)), '两次评分结果不同');
});

ok('aggregate：只有机器分时明确提示「不构成人工基线」', () => {
  // 用临时 run 目录、只放一份机器分：不受真实 run 目录里已有的代理/权重影响。
  const src = path.join(import.meta.dirname, '..', 'eval', 'runs', '2026-10-26T05-24-34-baseline-2');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aggm-'));
  for (const f of ['baseline.json', 'metrics.md', 'scores-reviewer-M.csv']) fs.copyFileSync(path.join(src, f), path.join(tmp, f));
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'eval', 'aggregate.mjs'), tmp], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /不构成人工基线/);
  assert.match(r.stdout, /五维总分胜场/);
  assert.ok(!/加权基线/.test(r.stdout), '没有权重配置时不应出现加权段');
});

ok('aggregate：两名评审且分歧 ≥2 时报出分歧点', () => {
  const src = path.join(import.meta.dirname, '..', 'eval', 'runs', '2026-10-26T05-24-34-baseline-2');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-'));
  for (const f of ['baseline.json', 'metrics.md', 'blind.csv']) fs.copyFileSync(path.join(src, f), path.join(tmp, f));
  // 评审 A 与 B 完全一致；评审 C 把 natural 整体抬高 2 分 → 应产生分歧。
  const rows = parseCsvObjects(fs.readFileSync(path.join(src, 'scores-reviewer-M.csv'), 'utf8')).slice(0, 4);
  const mk = (label, bump = 0) => [csvLine(['reviewer', 'id', 'side', 'natural', 'faithful', 'harm', 'template', 'stable', 'note'])]
    .concat(rows.map((r) => csvLine([label, r.id, r.side, Math.min(5, Number(r.natural) + bump), r.faithful, r.harm, r.template, r.stable, r.note])))
    .join('\n') + '\n';
  fs.writeFileSync(path.join(tmp, 'scores-reviewer-A.csv'), mk('A'));
  fs.writeFileSync(path.join(tmp, 'scores-reviewer-B.csv'), mk('B', 2));
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'eval', 'aggregate.mjs'), tmp], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /分歧（\|Δ\|≥2）：\n- /);
  assert.match(r.stdout, /人类评审：A、B/);
});

ok('aggregate：A/B 自定义组名（非 raw/cleaned）按 key 归组，不把胜场全算一侧', () => {
  const dir = path.join(import.meta.dirname, '..', 'eval', 'ab', '2026-10-26T06-29-08');
  if (!fs.existsSync(path.join(dir, 'baseline.json'))) return; // 该 run 是产物，不在仓库时跳过
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'eval', 'aggregate.mjs'), dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const line = (r.stdout.match(/五维总分胜场[^：]*：.*/) || [''])[0];
  assert.match(line, /control=\d+/);
  assert.match(line, /temperature-1=\d+/);
  assert.ok(!/raw=|cleaned=/.test(line), `组名应来自 key：${line}`);
  const parts = [...line.matchAll(/=(\d+)/g)].map((m) => Number(m[1]));
  const totalMatch = line.match(/共 (\d+) 条/);
  assert.ok(totalMatch, `胜场行应带总条数：${line}`);
  assert.equal(parts.reduce((a, b) => a + b, 0), Number(totalMatch[1]), `分项之和应等于总条数：${line}`);
});

ok('aggregate：按 weights.json 加权（权重影响均分与胜场、exclude 生效）', () => {
  const agg = path.join(import.meta.dirname, '..', 'eval', 'aggregate.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aggw-'));
  const d1 = { natural: [4, 2], faithful: [5, 5], harm: [5, 5], template: [4, 3], stable: [4, 4] }; // Gemini-Y 0.7
  const d2 = { natural: [5, 1], faithful: [4, 5], harm: [5, 5], template: [5, 4], stable: [5, 4] }; // AI-X 0.3
  fs.writeFileSync(path.join(tmp, 'baseline.json'), JSON.stringify({
    tag: 'weighted-fixture',
    items: [{ id: 'c1', situation: 's', incoming: 'i', raw: 'b', cleaned: 'a' }],
    key: { c1: { 1: 'cleaned', 2: 'raw' } }
  }));
  fs.writeFileSync(path.join(tmp, 'metrics.md'), '# m\n');
  const header = csvLine(['reviewer', 'id', 'side', 'natural', 'faithful', 'harm', 'template', 'stable', 'note']);
  const rows = (label, d) => ['1', '2'].map((side, i) => csvLine([
    label, 'c1', side, d.natural[i], d.faithful[i], d.harm[i], d.template[i], d.stable[i], ''
  ]));
  fs.writeFileSync(path.join(tmp, 'scores-reviewer-Gemini-Y.csv'), [header, ...rows('Gemini-Y', d1)].join('\n') + '\n');
  fs.writeFileSync(path.join(tmp, 'scores-reviewer-AI-X.csv'), [header, ...rows('AI-X', d2)].join('\n') + '\n');
  // M 的 side2 natural 给 5：若被计入加权，side2 natural 会从 1.7 变高，可据此证明 exclude 生效。
  fs.writeFileSync(path.join(tmp, 'scores-reviewer-M.csv'), [header, ...rows('M', {
    natural: [5, 5], faithful: [5, 5], harm: [5, 5], template: [5, 5], stable: [5, 5]
  })].join('\n') + '\n');
  fs.writeFileSync(path.join(tmp, 'weights.json'), JSON.stringify({
    acceptProxy: true, weights: { 'Gemini-Y': 0.7, 'AI-X': 0.3 }, exclude: ['M'], note: 'fixture'
  }));
  const r = spawnSync(process.execPath, [agg, tmp], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## 加权基线（AI-X 0\.3 · Gemini-Y 0\.7；排除 M）/);
  // natural：side1(cleaned) = 0.7*4 + 0.3*5 = 4.3；side2(raw) = 0.7*2 + 0.3*1 = 1.7；Δ = -2.6
  assert.match(r.stdout, /\| natural \| 4\.3 \| 1\.7 \| -2\.6 \|/);
  assert.match(r.stdout, /\| faithful \| 4\.7 \| 5 \| \+0\.3 \|/);
  assert.match(r.stdout, /加权胜场（逐条比五维加权总分）：cleaned=1 平手=0/);
  assert.match(r.stdout, /代理基线/);
  // 删掉 weights.json → 旧行为：没有加权段，并提示不构成人工基线。
  fs.unlinkSync(path.join(tmp, 'weights.json'));
  const r2 = spawnSync(process.execPath, [agg, tmp], { encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(!/加权基线/.test(r2.stdout), '无 weights.json 时不应出现加权段');
  assert.match(r2.stdout, /不构成人工基线/);
});

ok('aggregate：命令行 --weights 也能开启加权（无需 weights.json）', () => {
  const agg = path.join(import.meta.dirname, '..', 'eval', 'aggregate.mjs');
  const run = path.join(import.meta.dirname, '..', 'eval', 'runs', '2026-10-26T05-24-34-baseline-2');
  const r = spawnSync(process.execPath, [agg, run, '--weights=Gemini-B:0.7,AI-A:0.3'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## 加权基线（AI-A 0\.3 · Gemini-B 0\.7；排除 M）/);
  assert.match(r.stdout, /加权胜场（逐条比五维加权总分）：/);
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
