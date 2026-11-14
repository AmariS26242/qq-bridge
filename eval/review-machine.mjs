// 机器代理评审（**不是**人类基线）：按固定规则给盲评两栏打分，产出 scores-reviewer-M.csv。
//
// 用途：①验证 aggregate.mjs 的读分/汇总/胜场链路真的能跑通；②给后续 A/B 一个可比对照。
// 限制：规则是启发式，只看文本本身；它评不出「像不像真人」「有没有说到点子上」，
//       所以人类评审（A/B）仍然是 B1 的完成条件。
//
// 用法：node eval/review-machine.mjs eval/runs/<run-dir>
import fs from 'node:fs';
import path from 'node:path';
import { parseCsvObjects, csvLine } from './csv.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error('用法：node eval/review-machine.mjs eval/runs/<run-dir>');
  process.exit(2);
}

const AIISMS = ['希望能帮到你', '希望对你有帮助', '首先', '其次', '综上', '总之', '建议您', '呢～', '哦～', '～', '！', '我理解你的感受',
  '听起来你', '你已经很棒了', '加油', '记得照顾好自己', '说到底', '不得不说'];

const items = parseCsvObjects(fs.readFileSync(path.join(dir, 'blind.csv'), 'utf8'));
const clamp = (n) => Math.max(1, Math.min(5, Math.round(n)));
const countAiisms = (t) => AIISMS.reduce((n, w) => n + (t.split(w).length - 1), 0);
const digitsOf = (t) => new Set(t.match(/\d+(?:[.:]\d+)?/g) ?? []);
const NEG = ['不', '没', '别', '未', '无法', '不能', '不要'];
const negsOf = (t) => NEG.filter((w) => t.includes(w));

/** 开头六个字符做「模板」指纹（去掉标点与空白）。 */
const opener = (t) => t.replace(/[\s，。！？、,.!?…~～"'“”‘’]/g, '').slice(0, 6);
const openerFreq = new Map();
for (const it of items) {
  for (const side of ['side1', 'side2']) {
    const o = opener(it[side] ?? '');
    if (o) openerFreq.set(o, (openerFreq.get(o) ?? 0) + 1);
  }
}

function score(text, other) {
  const t = String(text ?? '').trim();
  if (!t) return { natural: 1, faithful: 1, harm: 1, template: 1, stable: 1, note: '空回复' };
  const ai = countAiisms(t);

  // 自然度：AI 味词成堆才明显扣分，再加语气尾巴与堆叠感叹号。
  let natural = 5;
  if (ai >= 2) natural -= 1;
  if (ai >= 5) natural -= 2;
  if (/～\s*$/.test(t)) natural -= 1;
  if ((t.match(/！/g) ?? []).length >= 2) natural -= 1;

  // 语义保真/误伤：相对「另一栏」少了数字或否定词（代理口径，不是人评）。
  const missingDigits = [...digitsOf(other)].filter((d) => !t.includes(d)).length;
  const missingNeg = negsOf(other).filter((w) => !t.includes(w)).length;
  const faithful = 5 - Math.min(2, missingDigits) - Math.min(2, missingNeg);
  let harm = 5;
  if (missingDigits) harm -= 1;
  if (missingNeg) harm -= 1;
  if (t.length < 6) harm -= 1;

  // 模板感：同一开头在整批里重复出现。
  const f = openerFreq.get(opener(t)) ?? 1;
  let template = f >= 3 ? 2 : f === 2 ? 3 : 5;
  if (ai >= 3) template -= 1;

  const stable = 5; // 同一规则重复评分必然一致；留作人工复核位。
  return { natural: clamp(natural), faithful: clamp(faithful), harm: clamp(harm), template: clamp(template), stable, note: ai ? `aiism=${ai}` : '' };
}

const lines = [csvLine(['reviewer', 'id', 'side', 'natural', 'faithful', 'harm', 'template', 'stable', 'note'])];
let changed = 0;
const sums = { 1: {}, 2: {} };
for (const it of items) {
  const a = score(it.side1, it.side2);
  const b = score(it.side2, it.side1);
  if (it.side1 !== it.side2) changed += 1;
  lines.push(csvLine(['M', it.id, '1', a.natural, a.faithful, a.harm, a.template, a.stable, a.note]));
  lines.push(csvLine(['M', it.id, '2', b.natural, b.faithful, b.harm, b.template, b.stable, b.note]));
  for (const [side, s] of [['1', a], ['2', b]]) {
    for (const d of ['natural', 'faithful', 'harm', 'template']) {
      sums[side][d] = (sums[side][d] ?? 0) + s[d];
    }
  }
}
const out = path.join(dir, 'scores-reviewer-M.csv');
fs.writeFileSync(out, `${lines.join('\n')}\n`, 'utf8');

const n = items.length || 1;
const avg = (d) => `${Math.round((sums[1][d] / n) * 100) / 100}/${Math.round((sums[2][d] / n) * 100) / 100}`;
console.log(`写入 ${out}（${items.length} 条 × 2 栏；两栏文本不同的 ${changed} 条）`);
console.log(`代理均分 side1/side2：natural ${avg('natural')} · faithful ${avg('faithful')} · harm ${avg('harm')} · template ${avg('template')}`);
console.log('提醒：这是启发式代理分，不构成人工基线。');
