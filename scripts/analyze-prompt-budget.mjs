// 提示词预算体检（只读，用于 D3「人格卡瘦身」前的量化）：
// 1) 核心段（preset 的 prefix/suffix）与人格卡（roles/<角色>.md）各占多少字符；
// 2) 两者之间有多少重复——逐行重复 + 8 码点 n-gram 重叠；
// 3) 给出「按 maxInjectChars 上限算」的占用比例。
//
// 用法：node scripts/analyze-prompt-budget.mjs [preset] [角色名]
// 默认：preset=qq-chat-v2 角色=小鲸鱼
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
/** 归一化：压空白，用于「同一句话」的判定。 */
const norm = (s) => s.replace(/\s+/g, '').trim();
const presetName = process.argv[2] || 'qq-chat-v2';
const roleName = process.argv[3] || '小鲸鱼';
const presetPath = path.join(root, 'dsh', 'agent-presets', presetName, 'agent.cordis.yml');
const cardPath = path.join(root, 'roles', `${roleName}.md`);

const cpLen = (s) => [...s].length;

/** 从 YAML 里粗略取出 prefix: >- / suffix: >- 段落（只依赖缩进，不引第三方库）。 */
function extractPromptBlocks(yaml) {
  const lines = yaml.split('\n');
  const blocks = {};
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s{4,}(prefix|suffix):\s*>-?\s*$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    const indent = lines[i].length - lines[i].trimStart().length;
    const out = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') { out.push(''); continue; }
      const cur = line.length - line.trimStart().length;
      if (cur <= indent - 2) break;
      out.push(line.slice(Math.min(cur, indent + 2)));
    }
    blocks[key] = out.join('\n').trim();
    i = j - 1;
  }
  return blocks;
}

if (!fs.existsSync(presetPath)) { console.error(`找不到 preset：${presetPath}`); process.exit(2); }
if (!fs.existsSync(cardPath)) { console.error(`找不到人格卡：${cardPath}`); process.exit(2); }

const yaml = fs.readFileSync(presetPath, 'utf8');
const blocks = extractPromptBlocks(yaml);
const core = [blocks.prefix, blocks.suffix].filter(Boolean).join('\n\n');
const card = fs.readFileSync(cardPath, 'utf8');

console.log(`preset：${path.relative(root, presetPath)}（${yaml.split('\n').length} 行）`);
console.log(`人格卡：${path.relative(root, cardPath)}（${card.split('\n').length} 行，${cpLen(card)} 字符）`);
console.log(`preset prefix：${cpLen(blocks.prefix ?? '')} 字符  suffix：${cpLen(blocks.suffix ?? '')} 字符`);
console.log(`\n两笔成本要分开看：`);
console.log(`  · preset（每轮恒在的系统提示）：${cpLen(core)} 字符`);
console.log(`  · 人格卡（按轮注入，受 maxInjectChars=8000 约束）：${cpLen(card)} 字符 → 占上限 ${Math.round((cpLen(card) / 8000) * 100)}%，余量 ${8000 - cpLen(card)} 字符`);

// 人格卡内部重复（文档里说「卡内重复约 1/3」指的就是这个）
const cardLinesAll = card.split('\n').map((l) => l.trim()).filter((l) => cpLen(norm(l)) >= 8);
const seenLine = new Map();
for (const l of cardLinesAll) seenLine.set(norm(l), (seenLine.get(norm(l)) ?? 0) + 1);
const dupCardLines = [...seenLine.entries()].filter(([, n]) => n > 1);
const dupCardChars = dupCardLines.reduce((sum, [l, n]) => sum + cpLen(l) * (n - 1), 0);
console.log(`\n人格卡内部重复：${cardLinesAll.length} 条有效行里 ${dupCardLines.length} 组重复（多出 ${dupCardChars} 字符，占卡内 ${Math.round((dupCardChars / Math.max(1, cpLen(card))) * 100)}%）`);
dupCardLines.slice(0, 5).forEach(([l, n]) => console.log(`  - ×${n} ${l.length > 50 ? l.slice(0, 50) + '…' : l}`));

function selfOverlap(text, n = 8) {
  const chars = [...text.replace(/\s+/g, '')];
  const seen = new Map();
  for (let i = 0; i + n <= chars.length; i += 1) {
    const w = chars.slice(i, i + n).join('');
    seen.set(w, (seen.get(w) ?? 0) + 1);
  }
  let dup = 0;
  for (const [, c] of seen) if (c > 1) dup += c - 1;
  const total = Math.max(1, chars.length - n + 1);
  return { dup, total, pct: Math.round((dup / total) * 100) };
}
const cardSelf = selfOverlap(card);
console.log(`人格卡 ${8} 码点重复窗口：${cardSelf.dup}/${cardSelf.total}（${cardSelf.pct}%）`);

// 逐行重复（去空行、去首尾空白、忽略太短的行）
const cardLines = new Set(card.split('\n').map(norm).filter((l) => cpLen(l) >= 8));
const coreLines = core.split('\n').map((l) => l.trim()).filter((l) => cpLen(norm(l)) >= 8);
const dupLines = coreLines.filter((l) => cardLines.has(norm(l)));
const dupChars = dupLines.reduce((n, l) => n + cpLen(norm(l)), 0);
console.log(`\n逐行重复：核心段 ${coreLines.length} 条有效行中 ${dupLines.length} 条在人格卡里也有（约 ${dupChars} 字符，占核心段 ${Math.round((dupChars / Math.max(1, cpLen(core))) * 100)}%）`);
if (dupLines.length) {
  console.log('重复行示例：');
  dupLines.slice(0, 5).forEach((l) => console.log(`  - ${l.length > 60 ? l.slice(0, 60) + '…' : l}`));
}

// n-gram 重叠：8 码点切窗，看核心段有多少窗口在人格卡里出现
const N = 8;
function windows(text) {
  const chars = [...text.replace(/\s+/g, '')];
  const set = new Set();
  for (let i = 0; i + N <= chars.length; i += 1) set.add(chars.slice(i, i + N).join(''));
  return set;
}
const coreW = windows(core);
const cardW = windows(card);
let overlap = 0;
for (const w of coreW) if (cardW.has(w)) overlap += 1;
const pct = coreW.size ? Math.round((overlap / coreW.size) * 100) : 0;
console.log(`\n${N} 码点重叠：核心段 ${coreW.size} 个窗口里 ${overlap} 个也出现在人格卡（${pct}%）`);

const budget = 8000;
const suggestion = pct >= 25
  ? `核心段与人格卡重复 ${pct}%，D3 可以直接从这里下手：把重复表述只留在人格卡，核心段改写成「短规则 + 指路」。`
  : `重复只有 ${pct}%，D3 的收益主要在长度本身（核心段 ${cpLen(core)} 字符），不在去重。`;
console.log(`\n判断：${suggestion}`);
console.log(`参考：核心段 ${cpLen(core)} 字符 ≈ ${Math.round(cpLen(core) / 1.5)}–${Math.round(cpLen(core) / 1.2)} token（中文粗估，1.2–1.5 字符/token）。`);
