// 盲评汇总：读一份 run 目录里的 baseline.json + 若干份 scores-reviewer-*.csv，
// 算出各维度均分、胜场、分歧点，并按 run 目录里的 weights.json 做加权基线。
//
// 用法：node eval/aggregate.mjs eval/runs/<run-dir> [--weights=Gemini-B:0.7,AI-A:0.3]
//
// 说明：
// - 评审文件名约定 `scores-reviewer-<代号>.csv`（人评用 A/B，代理用 M / AI-A / Gemini-B）。
// - `weights.json`（可选）：
//     { "acceptProxy": true, "weights": { "Gemini-B": 0.7, "AI-A": 0.3 }, "exclude": ["M"], "note": "…" }
//   acceptProxy=true 表示「按裁定用代理分构成基线」；exclude 里的评审不计入加权口径。
// - 没有 weights.json 时，行为与旧版一致：只输出未加权均分，且提示代理分不构成人工基线。
import fs from 'node:fs';
import path from 'node:path';
import { parseCsvObjects } from './csv.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error('用法：node eval/aggregate.mjs eval/runs/<run-dir> [--weights=label:w,label:w]');
  process.exit(2);
}
const base = JSON.parse(fs.readFileSync(path.join(dir, 'baseline.json'), 'utf8'));
const key = base.key;
const DIMS = ['natural', 'faithful', 'harm', 'template', 'stable'];

function readScores(file) {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return null;
  const rows = parseCsvObjects(fs.readFileSync(p, 'utf8'));
  return { label: file.replace(/^scores-reviewer-/, '').replace(/\.csv$/, ''), rows };
}

const files = fs.readdirSync(dir).filter((f) => /^scores-reviewer-.+\.csv$/.test(f)).sort();
const reviewers = files.map(readScores).filter(Boolean);
if (reviewers.length === 0) {
  console.log('尚无评审分数（缺 scores-reviewer-*.csv）：只有机械指标。');
  console.log(fs.readFileSync(path.join(dir, 'metrics.md'), 'utf8').split('\n').slice(0, 3).join('\n'));
  process.exit(0);
}

// ── 加权配置：weights.json 优先，其次命令行 --weights=…；都没有就不加权 ──
function loadWeights() {
  const cfg = { acceptProxy: false, weights: {}, exclude: [], note: '' };
  const file = path.join(dir, 'weights.json');
  if (fs.existsSync(file)) {
    Object.assign(cfg, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  const arg = process.argv.find((a) => a.startsWith('--weights='));
  if (arg) {
    for (const part of arg.slice('--weights='.length).split(',')) {
      const [label, w] = part.split(':');
      if (label && Number.isFinite(Number(w))) cfg.weights[label.trim()] = Number(w);
    }
    if (Object.keys(cfg.weights).length) cfg.acceptProxy = true;
  }
  return cfg;
}
const wcfg = loadWeights();
const weightOf = (label) => {
  const w = Number(wcfg.weights?.[label]);
  return Number.isFinite(w) && w > 0 ? w : 1;
};
const isExcluded = (label) => (wcfg.exclude ?? []).includes(label);

const mean = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100 : null);
const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const bySide = { 1: {}, 2: {} };
for (const d of DIMS) { bySide[1][d] = []; bySide[2][d] = []; }
const perItem = new Map(); // `${id}|${side}` → 未加权总分累计
const perReviewer = {};

for (const { label, rows } of reviewers) {
  const cell = { 1: {}, 2: {} };
  for (const d of DIMS) { cell[1][d] = []; cell[2][d] = []; }
  for (const r of rows) {
    const side = String(r.side);
    for (const d of DIMS) {
      const v = Number(r[d]);
      if (!Number.isFinite(v) || v < 1 || v > 5) continue;
      bySide[side]?.[d]?.push(v);
      cell[side]?.[d]?.push(v);
      const k = `${r.id}|${side}`;
      const prev = perItem.get(k) ?? { sum: 0, n: 0 };
      perItem.set(k, { sum: prev.sum + v, n: prev.n + 1 });
    }
  }
  perReviewer[label] = {
    n: rows.length,
    side1: Object.fromEntries(DIMS.map((d) => [d, mean(cell[1][d])])),
    side2: Object.fromEntries(DIMS.map((d) => [d, mean(cell[2][d])]))
  };
}

// ── 加权单元格：`${id}|${side}|${dim}` → { sum, w }（sum 已按评审权重放大）──
const wCell = new Map();
for (const { label, rows } of reviewers) {
  if (isExcluded(label)) continue;
  const w = weightOf(label);
  for (const r of rows) {
    const side = String(r.side);
    for (const d of DIMS) {
      const v = Number(r[d]);
      if (!Number.isFinite(v) || v < 1 || v > 5) continue;
      const k = `${r.id}|${side}|${d}`;
      const prev = wCell.get(k) ?? { sum: 0, w: 0 };
      wCell.set(k, { sum: prev.sum + w * v, w: prev.w + w });
    }
  }
}
const wDim = (id, side, d) => {
  const c = wCell.get(`${id}|${side}|${d}`);
  return c && c.w ? c.sum / c.w : null;
};
const wItemScore = (id, side) => {
  const vals = DIMS.map((d) => wDim(id, side, d)).filter((v) => v !== null);
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
};
const weighted = wCell.size > 0 && (Object.keys(wcfg.weights ?? {}).length > 0 || wcfg.acceptProxy === true);
const wUsed = reviewers.filter((r) => !isExcluded(r.label));
const wDesc = wUsed.map((r) => `${r.label} ${weightOf(r.label)}`).join(' · ');

// 分歧：两两评审、同 id 同侧、某维度相差 ≥2。
const disagreements = [];
if (reviewers.length === 2) {
  const idx = new Map();
  reviewers.forEach(({ rows }, ri) => rows.forEach((r) => idx.set(`${r.id}|${r.side}|${ri}`, r)));
  for (const r of reviewers[0].rows) {
    const other = idx.get(`${r.id}|${r.side}|1`);
    if (!other) continue;
    for (const d of DIMS) {
      const a = Number(r[d]);
      const b = Number(other[d]);
      if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) >= 2) {
        disagreements.push(`${r.id} side${r.side} ${d}: ${a} vs ${b}`);
      }
    }
  }
}

console.log(`# 盲评汇总 · ${base.tag}\n`);
console.log(`评审文件：${reviewers.map((r) => r.label).join('、')}（条数 ${reviewers.map((r) => `${r.label}:${r.rows.length}`).join(' / ')}）\n`);
console.log('| 维度 | side1 均分 | side2 均分 |\n| --- | --- | --- |');
for (const d of DIMS) {
  console.log(`| ${d} | ${mean(bySide[1][d]) ?? '—'} | ${mean(bySide[2][d]) ?? '—'} |`);
}

if (reviewers.length > 1) {
  console.log('\n## 逐评审\n');
  console.log('| 评审 | natural 1/2 | faithful 1/2 | harm 1/2 | template 1/2 | stable 1/2 |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const [label, v] of Object.entries(perReviewer)) {
    const tag = isExcluded(label) ? '（不参与加权）' : weighted ? `（权重 ${weightOf(label)}）` : '';
    console.log(`| ${label}${tag} | ${v.side1.natural}/${v.side2.natural} | ${v.side1.faithful}/${v.side2.faithful} | ${v.side1.harm}/${v.side2.harm} | ${v.side1.template}/${v.side2.template} | ${v.side1.stable}/${v.side2.stable} |`);
  }
}

const keyMap = key ?? {};
const labelOf = (item, side) => {
  const raw = keyMap[item.id]?.[side];
  return typeof raw === 'string' && raw ? raw : `side${side}`;
};
const groupOrder = (() => {
  const seen = [];
  for (const item of base.items) {
    for (const side of ['1', '2']) {
      const g = labelOf(item, side);
      if (!seen.includes(g)) seen.push(g);
    }
  }
  return seen;
})();

// ── 未加权胜场（保持旧口径，便于和以前对比）──
const wins = {};
for (const item of base.items) {
  const a = perItem.get(`${item.id}|1`);
  const b = perItem.get(`${item.id}|2`);
  if (!a || !b || !a.n || !b.n) continue;
  const diff = a.sum / a.n - b.sum / b.n;
  if (diff === 0) wins.tie = (wins.tie || 0) + 1;
  else wins[labelOf(item, diff > 0 ? '1' : '2')] = (wins[labelOf(item, diff > 0 ? '1' : '2')] || 0) + 1;
}
const gs = Object.keys(wins).filter((k) => k !== 'tie');
const total = gs.reduce((n, k) => n + wins[k], 0) + (wins.tie || 0);
console.log(`\n五维总分胜场（未加权）：${gs.map((g) => `${g}=${wins[g]}`).join(' ')} 平手=${wins.tie || 0}（共 ${total} 条）`);
console.log(disagreements.length ? `\n分歧（|Δ|≥2）：\n- ${disagreements.join('\n- ')}` : '\n分歧（|Δ|≥2）：无');

// ── 加权口径：按组别算五维均分 + 逐条胜场（这是「基线」读数）──
if (weighted) {
  const perGroup = {};
  for (const g of groupOrder) {
    perGroup[g] = {};
    for (const d of DIMS) {
      const vals = [];
      for (const item of base.items) {
        for (const side of ['1', '2']) {
          if (labelOf(item, side) !== g) continue;
          const v = wDim(item.id, side, d);
          if (v !== null) vals.push(v);
        }
      }
      perGroup[g][d] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    }
  }
  const [gA, gB] = groupOrder;
  console.log(`\n## 加权基线（${wDesc}${(wcfg.exclude ?? []).length ? `；排除 ${wcfg.exclude.join('、')}` : ''}）\n`);
  if (gA && gB) {
    console.log(`| 维度 | ${gA} | ${gB} | Δ(${gB}−${gA}) |\n| --- | --- | --- | --- |`);
    for (const d of DIMS) {
      const a = perGroup[gA][d];
      const b = perGroup[gB][d];
      const diff = a !== null && b !== null ? round2(b - a) : null;
      console.log(`| ${d} | ${a === null ? '—' : round2(a)} | ${b === null ? '—' : round2(b)} | ${diff === null ? '—' : diff > 0 ? `+${diff}` : diff} |`);
    }
  }
  const wWins = {};
  const itemDiffs = [];
  for (const item of base.items) {
    const a = wItemScore(item.id, '1');
    const b = wItemScore(item.id, '2');
    if (a === null || b === null) continue;
    const diff = a - b;
    itemDiffs.push({ id: item.id, diff });
    if (Math.abs(diff) < 1e-9) wWins.tie = (wWins.tie || 0) + 1;
    else {
      const g = labelOf(item, diff > 0 ? '1' : '2');
      wWins[g] = (wWins[g] || 0) + 1;
    }
  }
  const wg = Object.keys(wWins).filter((k) => k !== 'tie');
  const wTotal = wg.reduce((n, k) => n + wWins[k], 0) + (wWins.tie || 0);
  console.log(`\n加权胜场（逐条比五维加权总分）：${wg.map((g) => `${g}=${wWins[g]}`).join(' ')} 平手=${wWins.tie || 0}（共 ${wTotal} 条）`);
  const top = itemDiffs
    .filter((x) => Math.abs(x.diff) >= 0.5)
    .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff))
    .slice(0, 6)
    .map((x) => `${x.id} ${x.diff > 0 ? '+' : ''}${round2(x.diff)}`);
  if (top.length) console.log(`明显差异（|Δ|≥0.5）：${top.join('  ')}`);
  if (wcfg.note) console.log(`\n> ${wcfg.note}`);
}

// ── 基线性质说明 ──
const agentLabelRe = /^(M|AI|Gemini|Claude|GPT|Grok|Copilot|机器|代理)/i;
const agents = reviewers.filter((r) => agentLabelRe.test(r.label));
const human = reviewers.filter((r) => !agentLabelRe.test(r.label));
if (agents.length) console.log(`\n代理评审：${agents.map((r) => r.label).join('、')}`);
if (human.length) {
  console.log(`人类评审：${human.map((r) => r.label).join('、')}（构成基线）`);
} else if (wcfg.acceptProxy) {
  console.log(`\n基线口径：按裁定用代理评审加权重构（${wDesc}）。这是「代理基线」，不是真人盲评；两者的差别记在清单 §6.40。`);
} else {
  console.log('\n⚠️ 目前没有真人评审分，**不构成人工基线**；仍缺两名真人评审。');
}
