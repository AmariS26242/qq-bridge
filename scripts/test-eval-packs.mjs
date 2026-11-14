import fs from 'node:fs';
import { parseCsvObjects } from '../eval/csv.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass += 1; console.log(`ok   ${name}`); } catch (e) { fail += 1; console.log(`FAIL ${name}\n     ${e?.message ?? e}`); } }
const root = path.join(import.meta.dirname, '..');
const runDir = path.join(root, 'eval', 'runs', '2026-10-26T05-24-34-baseline-2');
const node = (args) => spawnSync(process.execPath, args, { encoding: 'utf8' });

ok('make-packs 产出 30 条且不含答案映射', () => {
  const r = node([path.join(root, 'eval', 'make-packs.mjs'), runDir]);
  assert.equal(r.status, 0, r.stderr);
  const pack = fs.readFileSync(path.join(runDir, 'review-packs', 'reviewer-A.csv'), 'utf8');
  const rows = parseCsvObjects(pack);
  assert.equal(rows.length, 30);
  assert.equal(Object.keys(rows[0]).length, 17);
  assert.ok(!/"(raw|cleaned)"/.test(pack), '评审包里出现了答案列');
  assert.ok(fs.existsSync(path.join(runDir, 'review-packs', 'reviewer-B.csv')));
});

ok('check-review：完整文件 exit 0', () => {
  const r = node([path.join(root, 'eval', 'check-review.mjs'), path.join(runDir, 'scores-reviewer-M.csv'), path.join(runDir, 'blind.csv')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

const DIMS = ['natural', 'faithful', 'harm', 'template', 'stable'];
function mutate(mut, label) {
  const rows = parseCsvObjects(fs.readFileSync(path.join(runDir, 'scores-reviewer-M.csv'), 'utf8'));
  mut(rows[0]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-'));
  const f = path.join(tmp, `scores-reviewer-${label}.csv`);
  fs.writeFileSync(f, [['reviewer', 'id', 'side', ...DIMS, 'note'].join(','), ...rows.map((r) => [label, r.id, r.side, ...DIMS.map((d) => r[d]), r.note ?? ''].join(','))].join('\n') + '\n');
  return f;
}

ok('check-review：空项 → exit 1 并列出数量', () => {
  const f = mutate((r) => { r.natural = ''; }, 'A');
  const res = node([path.join(root, 'eval', 'check-review.mjs'), f, path.join(runDir, 'blind.csv')]);
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /空着的格子/);
});

ok('check-review：非法分数 → exit 2', () => {
  const f = mutate((r) => { r.natural = '9'; }, 'C');
  const res = node([path.join(root, 'eval', 'check-review.mjs'), f, path.join(runDir, 'blind.csv')]);
  assert.equal(res.status, 2, res.stdout);
  assert.match(res.stdout, /分数不合法/);
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
