// D3 候选稿的验收：字数预算、核心段预算、关键约束未被砍、主题无遗漏、不是整段照搬。
// 用法：node scripts/test-persona-slim.mjs [候选文件] [原卡文件]

import fs from 'node:fs';
import path from 'node:path';

const slimFile = process.argv[2] || 'eval/d3/小鲸鱼.slim.md';
const origFile = process.argv[3] || 'roles/小鲸鱼.md';

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) pass += 1;
  else { fail += 1; console.log(`  FAIL  ${name}`); }
};

const slim = fs.readFileSync(slimFile, 'utf8');
const orig = fs.readFileSync(origFile, 'utf8');
const len = [...slim].length;
const origLen = [...orig].length;

// ---- 1. 预算 ----
ok(len <= 5500, `卡总字数 ≤5500（实际 ${len}）`);
ok(len < origLen, `比原卡短（${len} < ${origLen}，省 ${origLen - len}）`);

const sections = [];
let cur = null;
for (const line of slim.split('\n')) {
  const m = line.match(/^##\s+(.*?)\s*$/);
  if (m) { cur = { name: m[1], body: [] }; sections.push(cur); }
  else if (cur) cur.body.push(line);
}
ok(sections.length >= 8, `分节数 ≥8（实际 ${sections.length}）`);
ok(sections.every((s) => s.body.join('').trim().length > 20), '每节都有实质内容');

const core = sections.find((s) => s.name.includes('核心'));
ok(Boolean(core), '有「核心 · 每轮必看」段');
const coreLen = core ? [...core.body.join('\n')].length : 0;
ok(coreLen > 0 && coreLen <= 400, `核心段 ≤400 字符（实际 ${coreLen}）`);

// ---- 2. 必须保留的硬约束（安全/边界/身份） ----
const MUST = [
  '最高原则',
  '不是客服',
  '蓝色大肥鱼',
  'V我50',
  '管理员',
  '引用',
  '括号内容会被当成正式消息',
  '本小姐',
  '拒绝',
  '越权',
  '不确定就说不确定',
  '不总结',
  '我理解你的感受',
  '希望对你有帮助',
  '作为AI',
  '首先',
  '接梗',
  '潜水',
  '1~10',
];
for (const s of MUST) ok(slim.includes(s), `保留「${s}」`);

// 「本小姐」只应作为禁止项出现
const miss = [...slim.matchAll(/本小姐/g)];
ok(miss.length === 1, `「本小姐」仅出现 1 次（实际 ${miss.length}）`);
const missLine = slim.split('\n').find((l) => l.includes('本小姐')) || '';
ok(missLine.includes('不自称'), '「本小姐」出现在「不自称」语境');

// ---- 3. 主题无遗漏（原卡 12 个主题，每个至少还在候选稿里出现一次） ----
const TOPICS = [
  ['短句/字数', /(1~10|一字|短句|小作文|一行)/],
  ['不总结升华', /(总结|升华|人生建议)/],
  ['非客服/非助手', /(客服|助手|咨询师)/],
  ['心理师腔/共情', /(我理解|共情|情绪价值|慢慢来|允许自己)/],
  ['不打包票', /(保证|绝对|一绝|管用)/],
  ['括号', /括号/],
  ['句号/Markdown', /(句号|Markdown)/],
  ['潜水', /潜水/],
  ['被怼/顶回去', /(顶回去|被怼|嘴硬|认输|摆烂)/],
  ['管理员/分寸', /(管理员|分寸)/],
  ['拒绝坏事', /(拒绝|不帮|越权)/],
  ['引用判断', /(引用)/],
];
for (const [name, re] of TOPICS) ok(re.test(slim), `主题未丢：${name}`);

// ---- 4. 场景覆盖 ----
for (const s of ['情绪倾诉', '是不是 AI', '冷场', '求推荐', '被怼', '深夜', '正经问题']) {
  ok(slim.includes(s), `场景保留：${s}`);
}

// ---- 5. 不是整段照搬：逐行归一化后与原卡的重合率要低 ----
const norm = (s) =>
  s.replace(/^[\s>#*\-+]+/, '').replace(/^\d+\.\s*/, '')
    .replace(/[`*_~]/g, '')
    .replace(/[，。；：！？、""''（）()《》「」…—\-,.;:!?"'/\\|]/g, '')
    .replace(/\s+/g, '');
const origLines = new Set(
  orig.split('\n').map(norm).filter((x) => [...x].length >= 12),
);
const slimLines = slim.split('\n').map(norm).filter((x) => [...x].length >= 12);
const same = slimLines.filter((x) => origLines.has(x)).length;
const ratio = same / (slimLines.length || 1);
ok(ratio <= 0.35, `与原卡逐行完全相同的比例 ≤35%（实际 ${(ratio * 100).toFixed(1)}%，${same}/${slimLines.length}）`);

// ---- 6. 无占位/无残留 ----
ok(!/TODO|TBD|待补|XXX/.test(slim), '无 TODO/占位符');
ok(!/\{\{|\}\}/.test(slim), '无模板占位');
ok(slim.split('\n').length >= 60, '不是被截断的残稿');

console.log(`\n候选：${len} 字符（原卡 ${origLen}，省 ${origLen - len} / ${(((origLen - len) / origLen) * 100).toFixed(1)}%）· 核心段 ${coreLen} 字符`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
