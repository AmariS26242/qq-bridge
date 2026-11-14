// D3 前置：人格卡结构与冗余度体检（只读）。输出卡内各节字数、跨节重复句、主题复述密度，
// 用于「重组 + 瘦身」时知道该砍哪、哪句是唯一表述不能动。
// 用法：node scripts/analyze-persona-card.mjs [roles/小鲸鱼.md] [--json out.json]

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) || 'roles/小鲸鱼.md';
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

const text = fs.readFileSync(file, 'utf8');
const lines = text.split('\n');
const charsAll = [...text].length;
const charsNoSpace = [...text.replace(/\s/g, '')].length;

// ---- 分节 ----
const sections = [];
let cur = { name: '（前言）', start: 0, lines: [] };
for (let i = 0; i < lines.length; i += 1) {
  const m = lines[i].match(/^##\s+(.*?)\s*$/);
  if (m) {
    sections.push(cur);
    cur = { name: m[1], start: i + 1, lines: [] };
  } else cur.lines.push({ no: i + 1, text: lines[i] });
}
sections.push(cur);

// 去掉空节（连续标题）
const secs = sections.filter((s) => s.lines.some((l) => l.text.trim()));

const secInfo = secs.map((s) => {
  const body = s.lines.map((l) => l.text).join('\n');
  return {
    name: s.name,
    startLine: s.start + 1,
    endLine: s.start + s.lines.length,
    chars: [...body].length,
    charsNoSpace: [...body.replace(/\s/g, '')].length,
    bullets: s.lines.filter((l) => /^\s*([-*]|\d+\.)\s/.test(l.text)).length,
    nonEmptyLines: s.lines.filter((l) => l.text.trim()).length,
  };
});

// ---- 句子/条目归一化 & 聚类 ----
const norm = (s) =>
  s
    .replace(/^[\s>#*\-+]+/, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/[`*_~]/g, '')
    .replace(/[，。；：！？、""''（）()《》「」…—\-,.;:!?"'/\\|]/g, '')
    .replace(/\s+/g, '');

const items = [];
for (const s of secs) {
  for (const l of s.lines) {
    const t = l.text.trim();
    if (!t || t.startsWith('#')) continue;
    const n = norm(t);
    if ([...n].length < 8) continue;
    items.push({ section: s.name, line: l.no, text: t, norm: n });
  }
}

const bigrams = (s) => {
  const arr = [...s];
  const out = new Set();
  for (let i = 0; i < arr.length - 1; i += 1) out.add(arr[i] + arr[i + 1]);
  return out;
};
const jaccard = (a, b) => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter || 1);
};

// 完全相同（归一化后）跨节重复
const byNorm = new Map();
for (const it of items) {
  const key = it.norm;
  if (!byNorm.has(key)) byNorm.set(key, []);
  byNorm.get(key).push(it);
}
const exactDupes = [...byNorm.values()]
  .filter((g) => new Set(g.map((x) => x.section)).size > 1)
  .map((g) => ({ norm: g[0].norm, hits: g.map((x) => ({ section: x.section, line: x.line, text: x.text })) }));

// 近似重复（双字集合 Jaccard ≥ 0.55，且不同节）
const sets = items.map((it) => bigrams(it.norm));
const clusters = [];
const used = new Set();
for (let i = 0; i < items.length; i += 1) {
  if (used.has(i)) continue;
  const group = [i];
  for (let j = i + 1; j < items.length; j += 1) {
    if (used.has(j)) continue;
    if (items[j].section === items[i].section) continue;
    if (jaccard(sets[i], sets[j]) >= 0.55) { group.push(j); used.add(j); }
  }
  if (group.length > 1) { used.add(i); clusters.push(group.map((k) => items[k])); }
}

// ---- 主题复述密度 ----
const TOPICS = [
  { key: '短句/字数', re: /(一字|一个字|1~10|短句|小作文|一行|一条)/ },
  { key: '不总结升华', re: /(总结|升华|人生建议|道理)/ },
  { key: '非客服/非助手', re: /(客服|助手|咨询师|百科)/ },
  { key: '心理师腔/共情', re: /(我理解|共情|情绪价值|慢慢来|允许自己|感受)/ },
  { key: '不打包票/推荐', re: /(保证|绝对|一绝|管用|推荐)/ },
  { key: '括号', re: /括号/ },
  { key: '句号/Markdown', re: /(句号|Markdown|markdown|加粗|列表)/ },
  { key: '潜水', re: /潜水/ },
  { key: '被怼/顶回去', re: /(顶回去|被怼|嘴硬|认输|摆烂)/ },
  { key: '管理员/分寸', re: /(管理员|分寸)/ },
  { key: '拒绝坏事', re: /(拒绝|不帮|底线|越权)/ },
  { key: '引用判断', re: /(引用|回复\[|引用信息)/ },
];
const topicMatrix = secs.map((s) => {
  const body = s.lines.map((l) => l.text).join('\n');
  const row = { section: s.name };
  for (const t of TOPICS) {
    const hits = (body.match(new RegExp(t.re.source, 'g')) || []).length;
    if (hits) row[t.key] = hits;
  }
  return row;
});
const topicTotals = {};
for (const row of topicMatrix) {
  for (const [k, v] of Object.entries(row)) if (k !== 'section') topicTotals[k] = (topicTotals[k] || 0) + v;
}

// ---- 核心段 ----
const coreSec = secInfo.find((s) => s.name.includes('核心'));
const coreChars = coreSec ? coreSec.chars : null;

const report = {
  file,
  generatedAt: new Date().toISOString(),
  totals: { chars: charsAll, charsNoSpace, lines: lines.length, sections: secInfo.length },
  sections: secInfo,
  core: coreSec || null,
  redundancy: {
    exactDupes: exactDupes.length,
    exactDupeGroups: exactDupes,
    nearDupClusters: clusters.length,
    nearDupExamples: clusters
      .sort((a, b) => b.length - a.length)
      .slice(0, 10)
      .map((g) => g.map((x) => ({ section: x.section, line: x.line, text: x.text }))),
    dupeCharsShare: null,
  },
  topics: { totals: topicTotals, perSection: topicMatrix },
};

// 重复条目占卡内字符的比例（粗算：被归进重复簇的条目字符数 / 全卡字符）
const dupeLines = new Set();
for (const g of [...exactDupes.map((d) => d.hits), ...clusters]) for (const x of g) dupeLines.add(x.line);
let dupeChars = 0;
for (const no of dupeLines) dupeChars += [...(lines[no - 1] || '')].length;
report.redundancy.dupeCharsShare = Number((dupeChars / charsAll).toFixed(4));

if (jsonOut) {
  fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
  fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
}

// ---- 人类可读输出 ----
const pct = (a, b) => `${((a / b) * 100).toFixed(1)}%`;
console.log(`文件：${file}`);
console.log(`总计：${charsAll} 字符（去空白 ${charsNoSpace}）· ${lines.length} 行 · ${secInfo.length} 节`);
if (coreSec) console.log(`核心段：第 ${coreSec.startLine}–${coreSec.endLine} 行 · ${coreSec.chars} 字符（占全卡 ${pct(coreSec.chars, charsAll)}）`);
console.log('');
console.log('各节体积（按字符降序）：');
for (const s of [...secInfo].sort((a, b) => b.chars - a.chars)) {
  console.log(`  ${String(s.chars).padStart(4)}  ${pct(s.chars, charsAll).padStart(5)}  ${s.name}  (L${s.startLine}-${s.endLine}, ${s.bullets} 条)`);
}
console.log('');
console.log(`跨节完全重复：${exactDupes.length} 组 · 近似重复簇：${clusters.length} 个 · 重复条目约占全卡 ${pct(dupeChars, charsAll)}`);
for (const g of exactDupes.slice(0, 5)) {
  console.log(`  =「${g.norm.slice(0, 24)}…」出现在 ${g.hits.map((h) => `${h.section}@L${h.line}`).join(' / ')}`);
}
for (const g of clusters.sort((a, b) => b.length - a.length).slice(0, 5)) {
  console.log(`  ≈ ${g.map((x) => `${x.section}@L${x.line}`).join(' / ')}`);
  console.log(`     ${g.map((x) => x.text.slice(0, 34)).join(' ⟷ ')}`);
}
console.log('');
console.log('主题复述次数（越高说明越可能重复讲同一件事）：');
for (const [k, v] of Object.entries(topicTotals).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
if (jsonOut) console.log(`\nJSON 已写入 ${jsonOut}`);
