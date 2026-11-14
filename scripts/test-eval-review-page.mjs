// 校验 eval/review.html 里的内联评审逻辑与 eval/review-core.mjs 行为一致（防止改一边忘另一边）。
// 用法：node scripts/test-eval-review-page.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../eval/review-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(HERE, '..', 'eval', 'review.html');
const RUN = path.join(HERE, '..', 'eval', 'runs', '2026-10-26T05-24-34-baseline-2');
const PACK = path.join(RUN, 'review-packs', 'reviewer-A.csv');
const BLIND = path.join(RUN, 'blind.csv');

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) pass += 1;
  else { fail += 1; console.log(`  FAIL  ${name}`); }
};
const eq = (a, b, name) => {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  ok(ja === jb, `${name}${ja === jb ? '' : `\n    left : ${ja}\n    right: ${jb}`}`);
};

// ---- 从 HTML 里抠出内联实现 ----
const html = fs.readFileSync(HTML, 'utf8');
const begin = html.indexOf('// [review-core:begin]');
const end = html.indexOf('// [review-core:end]');
ok(begin > 0 && end > begin, 'review.html 含 review-core 标记段');
const inlineSrc = html.slice(begin, end);
const inline = new Function(`${inlineSrc}
return { DIMS, PACK_REQUIRED, parseCsv, parseCsvObjects, packRows, scoreRows, serializeScores, progress };`)();

// ---- 1. 两侧导出同一组常量 ----
eq(inline.DIMS, core.DIMS, 'DIMS 一致');
eq(inline.PACK_REQUIRED, core.PACK_REQUIRED, 'PACK_REQUIRED 一致');

// ---- 2. 跨行引号字段 ----
const tricky = [
  'id,situation,incoming,side1,side2',
  'c01,"有人问""在吗""","刚下班","第一栏\n第二行","另一栏, 带逗号"',
  'c02,简单,嗯,"只有一栏",""',
].join('\n');
eq(inline.parseCsv(tricky), core.parseCsv(tricky), '跨行 + 转义 CSV 解析一致');
eq(inline.parseCsvObjects(tricky), core.parseCsvObjects(tricky), 'CSV 对象映射一致');

// ---- 3. 真实评审包：30 条、两栏、无答案列 ----
let packIds = [];
if (fs.existsSync(PACK)) {
  const text = fs.readFileSync(PACK, 'utf8');
  const a = inline.packRows(text);
  const b = core.packRows(text);
  packIds = b.map((r) => r.id);
  eq(a.length, 30, '评审包 30 条（inline）');
  eq(a.map((r) => r.id), packIds, '评审包 id 序列一致');
  eq(a.map((r) => r.side1.length), b.map((r) => r.side2.length ? r.side1.length : r.side1.length), '评审包 side1 解析一致');
  const keys = Object.keys(a[0]);
  ok(!keys.includes('raw') && !keys.includes('cleaned'), '评审包不含 raw/cleaned 答案列');
  ok(!/"(raw|cleaned)"/.test(text), '评审包文件里没有答案列字样');
} else {
  console.log(`  SKIP  未找到评审包样例：${PACK}`);
}

// ---- 4. 两栏 → 每栏一行；序列化逐字节一致 ----
const pack = [
  { id: 'c01', situation: 's1', incoming: 'i1', side1: 'a1', side2: 'b1' },
  { id: 'c02', situation: 's2', incoming: 'i2', side1: 'a2', side2: 'b2' },
  { id: 'c03', situation: 's3', incoming: 'i3', side1: 'a3', side2: 'b3' },
];
const F = { natural: 4, faithful: 5, harm: 5, template: 3, stable: 4 };
const answers = {
  c01: { pick: 2, s1: { ...F }, s2: { natural: 5, faithful: 4, harm: 5, template: 4, stable: 5 }, note: '含,逗号与"引号"' },
  c02: { pick: 1, s1: { natural: 3, faithful: 4, harm: 5, template: 4, stable: 3 }, s2: {} }, // 第二栏没打
  // c03 完全没打
};
const norm = (rows) => rows.map((r) => Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]])));
const inRows = inline.scoreRows(pack, answers, 'A');
const coRows = core.scoreRows(pack, answers, 'A');
eq(norm(inRows), norm(coRows), 'scoreRows 字段值一致（键序无关）');
eq(inRows.length, 3, '只导出打满的栏（c01×2 + c02×1）');
eq(core.serializeScores(inRows), core.serializeScores(coRows), 'serializeScores 逐字节一致');
ok(core.serializeScores(coRows).split('\n')[0] === 'reviewer,id,side,natural,faithful,harm,template,stable,note', '导出表头符合 check-review 期望');
ok(core.serializeScores(coRows).includes('"含,逗号与""引号"""'), '含逗号引号的备注被正确转义');

// ---- 5. 错误路径一致 ----
const throwOf = (fn) => {
  try { fn(); return null; } catch (e) { return String(e && e.message ? e.message : e); }
};
eq(throwOf(() => inline.packRows('id,side1,side2\nc01,a,b')), throwOf(() => core.packRows('id,side1,side2\nc01,a,b')), '缺列报错一致');
const bad = { c01: { pick: 1, s1: { natural: 9, faithful: 5, harm: 5, template: 3, stable: 4 }, s2: {} } };
eq(throwOf(() => inline.scoreRows(pack, bad, 'A')), throwOf(() => core.scoreRows(pack, bad, 'A')), '越界报错一致');

// ---- 6. 进度按 60 格 ----
eq(inline.progress(pack, answers), core.progress(pack, answers), 'progress 一致');
const p = core.progress(pack, answers);
eq(p.total, 6, '总数 = 条数 × 2');
eq(p.done, 3, '已评格数正确');
eq(p.missing, ['c02', 'c03'], '缺哪些条能列出来');

// ---- 7. 与 check-review 的格式契约 ----
if (fs.existsSync(BLIND)) {
  const all = [];
  for (const id of packIds) all.push({ pick: 1, s1: { ...F }, s2: { ...F }, note: '' });
  const full = core.scoreRows(core.packRows(fs.readFileSync(PACK, 'utf8')), Object.fromEntries(packIds.map((id, i) => [id, all[i]])), 'E2E');
  eq(full.length, 60, '打满后导出 60 行（30 条 × 2 栏）');
  const tmp = path.join(HERE, '..', 'tmp', 'scores-full.csv');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, core.serializeScores(full));
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(HERE, '..', 'eval', 'check-review.mjs'), tmp, BLIND], { encoding: 'utf8' });
  ok(r.status === 0, `打满的导出文件通过 check-review（exit ${r.status}）`);
  if (r.status !== 0) console.log(r.stdout || r.stderr);
}

// ---- 8. 页面静态要求 ----
ok(html.includes('更像真人'), '页面有「更像真人」单选说明');
ok(html.includes('两栏都要打分'), '页面要求两栏都打分');
ok(!/\bfetch\s*\(/.test(html), '页面不发任何网络请求（本地文件可开、无隐私外发）');
ok(html.includes('text/csv'), '导出为 CSV');

// ---- 9. 断点评审：拖拽 + 本机自动保存/恢复 ----
ok(html.includes('STORE_PREFIX'), '有本机存储前缀（进度自动保存）');
ok(/localStorage\.setItem/.test(html), '打分时写入 localStorage');
ok(/localStorage\.getItem/.test(html), '打开评审包时尝试恢复');
ok(/已恢复上次进度/.test(html), '恢复后给出提示');
ok(/addEventListener\('drop'/.test(html), '支持把 CSV 拖进窗口');
ok(/'dragover'/.test(html) && /classList\.add\('hot'\)/.test(html), '拖拽悬停有反馈');
ok(/id="reset"/.test(html) && /清空重评/.test(html), '有「清空重评」按钮');
ok(/catch \(e\) \{\s*\/\* 隐私模式/.test(html), 'localStorage 不可用时静默降级（隐私模式不炸）');
// 指纹只依赖 id 与两栏长度：同一份包的 A/B 副本共享进度，但不同 run 不串
ok(/packFingerprint/.test(html) && /r\.id \+ ':' \+ String\(r\.side1/.test(html), '进度指纹按包内容计算');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
