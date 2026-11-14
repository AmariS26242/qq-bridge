// B1 离线盲评：把 30 条固定上下文跑一遍「实际出站管线」，产出一份可复现的基线记录。
// 评审看到的是 A/B 两版（顺序随机、不标身份），身份写在 key.json 里——评审前别打开。
//
// 用法：
//   node eval/run-eval.mjs --tag baseline-1
//   node eval/run-eval.mjs --tag baseline-1 --stability   # 只做确定性自检，不落盘
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deslopChatText } from '../src/ai-tone.js';
import { decideFallback } from '../src/ai-tone.js';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const tag = (args[args.indexOf('--tag') + 1] || 'baseline') .replace(/[^a-zA-Z0-9_-]/g, '') || 'baseline';
const stabilityOnly = args.includes('--stability');
const seed = 20261026;

const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const opts = cfg.aiTone ?? {};
const contexts = fs.readFileSync(path.join(root, 'eval', 'contexts.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

// 固定「AI 味」词表：只用来数残留，不参与清洗。改这张表要写进变更记录，否则基线不可比。
const AIISMS = ['希望能帮到你', '希望对你有帮助', '首先', '其次', '综上', '总之', '建议您', '呢～', '哦～', '～', '！', '我理解你的感受', '听起来你', '辛苦了呢'];

function countAiisms(text) {
  let n = 0;
  const hits = [];
  for (const w of AIISMS) {
    const c = text.split(w).length - 1;
    if (c > 0) { n += c; hits.push(`${w}×${c}`); }
  }
  return { n, hits };
}

function metrics(raw, sent, hits) {
  const mdResidue = (sent.match(/\*\*|^#{1,6} |`|^> |^\s*[-*] |^\s*\d+\. /gm) || []).length;
  const sentences = sent.split(/[。！？!?\n]/).map((s) => s.trim()).filter(Boolean);
  return {
    rawLen: [...raw].length,
    sentLen: [...sent].length,
    removedRatio: raw.length ? Math.round((1 - sent.length / raw.length) * 1000) / 1000 : 0,
    hits: hits.length,
    changed: sent !== raw,
    mdResidue,
    avgSentenceLen: sentences.length ? Math.round(sent.length / sentences.length) : 0,
    emptyOut: sent.trim().length === 0,
    fallback: sent.trim() === String(opts.fallbackPolicy?.fallbackText ?? '嗯'),
    aiism: countAiisms(sent).n,
    aiismRaw: countAiisms(raw).n
  };
}

function build() {
  const items = [];
  const blind = [];
  const key = {};
  for (const c of contexts) {
    const { text: cleaned, hits } = deslopChatText(c.draft, opts);
    const decision = decideFallback({
      raw: c.draft,
      cleaned,
      hits,
      isPrivate: true,
      policy: opts.fallbackPolicy
    });
    const sent = decision.text;
    const flip = crypto.createHash('sha256').update(`${c.id}:${seed}`).digest()[0] % 2 === 1;
    const side1 = flip ? sent : c.draft;
    const side2 = flip ? c.draft : sent;
    key[c.id] = flip ? { 1: 'cleaned', 2: 'raw' } : { 1: 'raw', 2: 'cleaned' };
    items.push({ id: c.id, situation: c.situation, incoming: c.incoming, raw: c.draft, cleaned, sent, decision: decision.kind ?? decision.action ?? '', hits, metrics: metrics(c.draft, sent, hits) });
    blind.push({ id: c.id, situation: c.situation, incoming: c.incoming, side1, side2 });
  }
  return { items, blind, key };
}

const first = build();
if (stabilityOnly) {
  const second = build();
  const same = JSON.stringify(first) === JSON.stringify(second);
  console.log(same ? 'STABLE 同一批上下文两次构建逐字节一致' : 'UNSTABLE 两次构建结果不同');
  process.exitCode = same ? 0 : 1;
  process.exit();
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = path.join(root, 'eval', 'runs', `${stamp}-${tag}`);
fs.mkdirSync(dir, { recursive: true });

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n');

fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify({
  tag,
  generatedAt: new Date().toISOString(),
  pipeline: { module: 'src/ai-tone.js', opts, fallbackPolicy: opts.fallbackPolicy },
  items: first.items,
  key: first.key
}, null, 2));

// 评审表：评审只看 1/2 两栏，不告诉他哪栏是原稿
fs.writeFileSync(path.join(dir, 'blind.csv'), csv([
  ['id', 'situation', 'incoming', 'side1', 'side2'],
  ...first.blind.map((b) => [b.id, b.situation, b.incoming, b.side1, b.side2])
]));

// 评分表：5 维 1-5 分（1 明显更差 / 3 差不多 / 5 明显更好），评审按 side 填
fs.writeFileSync(path.join(dir, 'scores.template.csv'), csv([
  ['reviewer', 'id', 'side', 'natural', 'faithful', 'harm', 'template', 'stable', 'note'],
  ...first.blind.flatMap((b) => ['1', '2'].map((s) => ['', b.id, s, '', '', '', '', '', '']))
]));

// 机械指标表（不需要人评就能看的部分）
fs.writeFileSync(path.join(dir, 'metrics.md'), [
  `# 机械指标 · ${tag}`,
  '',
  '| id | 原长 | 出站长 | 删减率 | 命中规则 | md 残留 | AI味词(原/出) | 均句长 | 删空 | 兜底 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...first.items.map((i) => `| ${i.id} | ${i.metrics.rawLen} | ${i.metrics.sentLen} | ${(i.metrics.removedRatio * 100).toFixed(1)}% | ${i.metrics.hits} | ${i.metrics.mdResidue} | ${i.metrics.aiismRaw}/${i.metrics.aiism} | ${i.metrics.avgSentenceLen} | ${i.metrics.emptyOut ? '是' : ''} | ${i.metrics.fallback ? '是' : ''} |`),
  '',
  `合计：${first.items.length} 条；有改动 ${first.items.filter((i) => i.metrics.changed).length} 条；命中规则 ${first.items.reduce((s, i) => s + i.metrics.hits, 0)} 次；删空 ${first.items.filter((i) => i.metrics.emptyOut).length} 条；AI 味词 ${first.items.reduce((s, i) => s + i.metrics.aiismRaw, 0)} → ${first.items.reduce((s, i) => s + i.metrics.aiism, 0)}（原稿 → 出站）。`
].join('\n'));

fs.writeFileSync(path.join(dir, 'README.md'), [
  `# 盲评记录 · ${tag}`,
  '',
  '- 生成：`node eval/run-eval.mjs --tag ' + tag + '`',
  '- 上下文：`eval/contexts.jsonl`（30 条固定）',
  '- 管线：`src/ai-tone.js` + `config.json → aiTone`（原样快照见 `baseline.json.pipeline`）',
  '',
  '## 怎么评',
  '1. 打开 `blind.csv`，逐行比较 side1 / side2：哪一边更像真人在 QQ 上说话。',
  '2. 在 `scores.template.csv` 里给**两边各自**打分（1–5，5 最好），五列分别是：自然度 / 语义保真 / 误伤（有没有被删坏） / 模板残留 / 稳定性。',
  '3. 两名评审各存一份（`scores-reviewer-A.csv`、`scores-reviewer-B.csv`），互不通气。',
  '4. 评完再打开 `baseline.json.key` 才知道哪边是清洗后的。',
  '',
  '## 稳定性自检',
  '`node eval/run-eval.mjs --stability` —— 同一批上下文重复构建必须逐字节一致。',
  '',
  '## 汇总',
  '`node eval/aggregate.mjs eval/runs/' + `${stamp}-${tag}` + '` 生成分数汇总与分歧表。'
].join('\n'));

console.log(`写入 ${path.relative(root, dir)}：${first.items.length} 条，有改动 ${first.items.filter((i) => i.metrics.changed).length} 条`);
