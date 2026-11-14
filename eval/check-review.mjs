// 检查交回的评审文件是否可用：字段齐全、分数是 1–5 的整数、条目对得上 blind.csv。
//
// 用法：node eval/check-review.mjs <scores-reviewer-X.csv> <blind.csv>
// 退出码：0 可用；1 有缺项（仍可汇总，但会提示缺多少）；2 用法/文件错误。
import fs from 'node:fs';
import { parseCsvObjects } from './csv.mjs';

const [file, blindFile] = process.argv.slice(2);
if (!file || !blindFile) {
  console.error('用法：node eval/check-review.mjs <scores-reviewer-X.csv> <blind.csv>');
  process.exit(2);
}
if (!fs.existsSync(file) || !fs.existsSync(blindFile)) {
  console.error('文件不存在。');
  process.exit(2);
}

const DIMS = ['natural', 'faithful', 'harm', 'template', 'stable'];
const blind = parseCsvObjects(fs.readFileSync(blindFile, 'utf8'));
const rows = parseCsvObjects(fs.readFileSync(file, 'utf8'));
const need = new Set(blind.map((b) => b.id));

const errors = [];
const missing = [];
const badScore = [];
const seen = new Set();

for (const r of rows) {
  const id = String(r.id ?? '').trim();
  const side = String(r.side ?? '').trim();
  if (!need.has(id)) { errors.push(`未知题目 id：${id}`); continue; }
  if (side !== '1' && side !== '2') { errors.push(`${id} 的 side 只能是 1 或 2，实际「${side}」`); continue; }
  const k = `${id}|${side}`;
  if (seen.has(k)) errors.push(`${id} side${side} 重复出现`);
  seen.add(k);
  for (const d of DIMS) {
    const raw = String(r[d] ?? '').trim();
    if (raw === '') { missing.push(`${id} side${side} ${d}`); continue; }
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 1 || v > 5) badScore.push(`${id} side${side} ${d}=${raw}`);
  }
}
for (const b of blind) {
  for (const side of ['1', '2']) {
    if (!seen.has(`${b.id}|${side}`)) errors.push(`缺整行：${b.id} side${side}`);
  }
}

console.log(`文件：${file}`);
console.log(`条目：${rows.length} 行（应为 ${blind.length * 2} 行）`);
if (errors.length) { console.log(`\n必须修的问题（${errors.length}）：`); errors.slice(0, 20).forEach((e) => console.log(`  - ${e}`)); }
if (badScore.length) { console.log(`\n分数不合法（${badScore.length}）：`); badScore.slice(0, 20).forEach((e) => console.log(`  - ${e}`)); }
if (missing.length) { console.log(`\n空着的格子（${missing.length}）：`); missing.slice(0, 10).forEach((e) => console.log(`  - ${e}`)); if (missing.length > 10) console.log(`  … 还有 ${missing.length - 10} 个`); }
if (!errors.length && !badScore.length && !missing.length) {
  console.log('\n✅ 这份评分完整且合法，可以直接 aggregate。');
  process.exit(0);
}
console.log(`\n${errors.length || badScore.length ? '❌ 不可用' : '⚠️ 可用但有空项'}：先修完再汇总更稳。`);
process.exit(errors.length || badScore.length ? 2 : 1);
