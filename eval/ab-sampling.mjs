// B2 采样参数 A/B 脚手架（P1-2）。
//
// 为什么单独一个脚本：B2 的结论必须是「同一批上下文、只差一组采样参数」的盲评对比。
// 生成回复要花钱（30 上下文 × 每组 N 条），所以这里只做**不花钱的部分**：
//   1. plan  —— 生成实验计划：校验「一次只改一个变量」，把组、上下文、抽样编号固定下来；
//   2. report —— 把收集到的回复配成盲评对，产出与 B1 同一套评分表兼容的 blind.csv，
//               并在有分数时按组算胜场。
//
// 用法：
//   node eval/ab-sampling.mjs plan --variant temperature=1.0 [--variant presencePenalty=0.2] [--samples 3]
//   node eval/ab-sampling.mjs report eval/ab/<stamp>
//
// 目录布局（plan 建好，生成由人/代理填）：
//   eval/ab/<stamp>/plan.json
//   eval/ab/<stamp>/prompts/<ctxId>.txt          —— 该上下文的输入（从 eval/contexts.jsonl）
//   eval/ab/<stamp>/replies/<group>/<ctxId>_<i>.txt —— 每组每上下文 i=1..samples 的回复正文
//   eval/ab/<stamp>/blind.csv                    —— report 产出：两栏盲评（匿名，不给组名）
//   eval/ab/<stamp>/baseline.json                —— report 产出：id → 两侧组名（评审看不到）
//   eval/ab/<stamp>/metrics.md
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { csvLine, parseCsvObjects } from './csv.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONTEXTS = path.join(HERE, 'contexts.jsonl');
const AB_DIR = path.join(HERE, 'ab');
const DIMS = ['natural', 'faithful', 'harm', 'template', 'stable'];
const NUMERIC = ['temperature', 'topP', 'presencePenalty', 'frequencyPenalty'];

/** 读当前线上采样参数（只读，用来当对照组）。 */
export function currentSampling(configPath = path.join(ROOT, 'config.json')) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const s = cfg.sampling ?? {};
  return {
    temperature: Number(s.temperature),
    topP: Number(s.topP),
    presencePenalty: Number(s.presencePenalty),
    frequencyPenalty: Number(s.frequencyPenalty),
  };
}

/** 解析 `key=value`；未知键或非数值直接抛错（宁可早失败，也别生成一版没法归因的实验）。 */
export function parseVariant(text) {
  const [key, raw] = String(text ?? '').split('=');
  const name = String(key ?? '').trim();
  if (!NUMERIC.includes(name)) {
    throw new Error(`不支持的采样参数「${name}」，可选：${NUMERIC.join(' / ')}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`参数 ${name} 的值不是数字：${raw}`);
  if (name === 'temperature' && (value < 0 || value > 2)) throw new Error('temperature 应在 0~2');
  if (name.endsWith('Penalty') && (value < -2 || value > 2)) throw new Error(`${name} 应在 -2~2`);
  if (name === 'topP' && (value <= 0 || value > 1)) throw new Error('topP 应在 (0,1]');
  return { key: name, value };
}

/** 一组参数必须恰好改一个变量，且不等于对照。返回改动说明。 */
export function diffGroup(control, group) {
  const changed = NUMERIC.filter((k) => Number(control[k]) !== Number(group[k]));
  if (changed.length === 0) throw new Error('该组与对照完全相同，不构成实验');
  if (changed.length > 1) {
    throw new Error(`该组改了 ${changed.length} 个变量（${changed.join('/')}）：一次只改一个；同时改多个必须单列为「组合实验」`);
  }
  return { key: changed[0], from: Number(control[changed[0]]), to: Number(group[changed[0]]) };
}

export function readContexts(file = CONTEXTS) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('//'));
  return lines.map((line, i) => {
    const item = JSON.parse(line);
    const id = String(item.id ?? `c${String(i + 1).padStart(2, '0')}`);
    const incoming = String(item.incoming ?? item.draft ?? '').trim();
    if (!incoming) throw new Error(`上下文 ${id} 没有 incoming 字段`);
    return { id, situation: String(item.situation ?? ''), incoming, draft: String(item.draft ?? '') };
  });
}

/** 固定随机化：同 seed 同顺序，保证「哪条在左、哪条在右」可复现但不被评审猜到。 */
export function sideOrder(seed, id) {
  const h = crypto.createHash('sha256').update(`${seed}:${id}`).digest();
  return h[0] % 2 === 0 ? 'control-first' : 'variant-first';
}

export function buildPlan({ control, variants, contexts, samples, seed, tag }) {
  const groups = [{ name: 'control', params: { ...control }, change: { key: null, from: null, to: null } }];
  for (const v of variants) {
    const change = diffGroup(control, v.params);
    groups.push({ name: v.name, params: { ...v.params }, change });
  }
  const keys = groups.map((g) => `${g.change.key ?? 'base'}=${g.params[g.change.key] ?? 'current'}`);
  if (new Set(keys).size !== keys.length) throw new Error('存在参数完全相同的两组，实验无法归因');
  const plan = {
    tag,
    seed,
    samples,
    createdAt: new Date().toISOString(),
    contexts: contexts.map((c) => ({ id: c.id, situation: c.situation })),
    groups,
    report: {
      dims: DIMS,
      samplesPerPair: samples,
      note: '两栏顺序按 sha256(seed:id) 奇偶决定；baseline.json 记录答案，评审只看 blind.csv'
    }
  };
  return plan;
}

function writePlan(runDir, plan, contexts) {
  fs.mkdirSync(path.join(runDir, 'prompts'), { recursive: true });
  for (const group of plan.groups) fs.mkdirSync(path.join(runDir, 'replies', group.name), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  for (const c of contexts) {
    fs.writeFileSync(path.join(runDir, 'prompts', `${c.id}.txt`), `${c.incoming}\n`, 'utf8');
  }
  const groupLines = plan.groups.map((g) => {
    const label = g.change.key ? `${g.change.key}: ${g.change.from} → ${g.change.to}` : `照当前线上值（${JSON.stringify(g.params)}）`;
    return `| ${g.name} | ${label} |`;
  });
  const readme = [
    `# 采样 A/B 计划 ${plan.tag}`,
    '',
    `- 上下文：${plan.contexts.length} 条（见 prompts/）`,
    `- 每组每上下文生成 ${plan.samples} 条，存 replies/<组名>/<上下文id>_<序号>.txt`,
    `- 盲评：两栏顺序由 sha256(seed:id) 决定（seed=${plan.seed}），报告时用 baseline.json 还原`,
    '',
    '| 组 | 改动 |',
    '| --- | --- |',
    ...groupLines,
    '',
    '填完回复后运行：`node eval/ab-sampling.mjs report <本目录>`',
    '',
    '纪律：一次只改一个变量；不要预设哪组更优；每组同一提示词、同一上下文顺序、同一样本条数。',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(runDir, 'README.md'), readme, 'utf8');
}

/** 统计某组缺哪些回复（返回缺的条数，0 表示齐全）。 */
export function countMissing(runDir, plan) {
  const missing = {};
  for (const group of plan.groups) {
    let miss = 0;
    for (const c of plan.contexts) {
      for (let i = 1; i <= plan.samples; i++) {
        const file = path.join(runDir, 'replies', group.name, `${c.id}_${i}.txt`);
        if (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').trim()) miss += 1;
      }
    }
    missing[group.name] = miss;
  }
  return missing;
}

function readReply(runDir, group, ctxId, i) {
  try {
    return fs.readFileSync(path.join(runDir, 'replies', group, `${ctxId}_${i}.txt`), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 把回复配成盲评对：只有「控制组 vs 某变体组」才配对；同一上下文同一序号一一对应，
 * 避免把不同的输入混进同一对里。返回 { rows, baseline, warnings }。
 */
export function pairReplies(runDir, plan) {
  const control = plan.groups.find((g) => g.name === 'control');
  if (!control) throw new Error('plan 里没有 control 组');
  const rows = [];
  const items = [];
  const keyMap = {};
  const warnings = [];
  let dropped = 0;
  for (const variant of plan.groups.filter((g) => g.name !== 'control')) {
    for (const c of plan.contexts) {
      for (let i = 1; i <= plan.samples; i++) {
        const a = readReply(runDir, 'control', c.id, i);
        const b = readReply(runDir, variant.name, c.id, i);
        if (!a || !b) { dropped += 1; continue; }
        // 盲评 id 必须是中性编号：带上下文/组名的 id 等于把答案写进评审表。
        const id = `p${String(rows.length + 1).padStart(3, '0')}`;
        const variantFirst = sideOrder(plan.seed, id) === 'variant-first';
        const side1 = variantFirst ? b : a;
        const side2 = variantFirst ? a : b;
        rows.push({ id, situation: c.situation, incoming: c.incoming, side1, side2 });
        keyMap[id] = { 1: variantFirst ? variant.name : 'control', 2: variantFirst ? 'control' : variant.name };
        items.push({ id, context: c.id, variant: variant.name, sample: i });
      }
    }
  }
  if (dropped) warnings.push(`有 ${dropped} 对因为缺回复被跳过（补齐后重跑 report）`);
  return { rows, items, keyMap, warnings };
}

export function writeReport(runDir, paired, plan) {
  const header = ['id', 'situation', 'incoming', 'side1', 'side2'];
  const csv = [header.join(','), ...paired.rows.map((r) => csvLine(header.map((h) => r[h] ?? '')))].join('\n') + '\n';
  fs.writeFileSync(path.join(runDir, 'blind.csv'), csv, 'utf8');
  const baseline = { tag: plan.tag, createdAt: plan.createdAt, items: paired.items, key: paired.keyMap, groups: plan.groups };
  fs.writeFileSync(path.join(runDir, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  const metrics = [
    `# 采样 A/B 机械指标 ${plan.tag}`,
    '',
    `- 配对：${paired.rows.length} 对（上下文 ${plan.contexts.length} × 变体 ${plan.groups.length - 1} × 每组 ${plan.samples} 条）`,
    `- 缺失：${JSON.stringify(countMissing(runDir, plan))}`,
    `- 平均长度：control ${avgLen(runDir, plan, 'control')} / 其它 ${plan.groups.filter((g) => g.name !== 'control').map((g) => `${g.name} ${avgLen(runDir, plan, g.name)}`).join(' / ')}`,
    ...(paired.warnings.length ? paired.warnings.map((w) => `- ⚠️ ${w}`) : []),
    ''
  ].join('\n');
  fs.writeFileSync(path.join(runDir, 'metrics.md'), metrics, 'utf8');
  return metrics;
}

function avgLen(runDir, plan, group) {
  let total = 0;
  let n = 0;
  for (const c of plan.contexts) {
    for (let i = 1; i <= plan.samples; i++) {
      const text = readReply(runDir, group, c.id, i);
      if (!text) continue;
      total += [...text].length;
      n += 1;
    }
  }
  return n ? `${Math.round(total / n)} 字符` : '—';
}

/** 读评审分数并按组算胜场（五维总分逐对比较）。 */
export function scoreWins(runDir, plan) {
  const scores = fs.readdirSync(runDir).filter((f) => /^scores-reviewer-.+\.csv$/.test(f));
  if (!scores.length) return { ok: false, reason: 'no-scores' };
  const baseline = JSON.parse(fs.readFileSync(path.join(runDir, 'baseline.json'), 'utf8'));
  const per = new Map();
  for (const file of scores) {
    for (const row of parseCsvObjects(fs.readFileSync(path.join(runDir, file), 'utf8'))) {
      // 空单元格不是 0 分：五维没填齐的整行跳过，否则「没评」会被算成「评得很差」。
      const values = DIMS.map((d) => Number(row[d]));
      if (values.some((v) => !Number.isFinite(v) || v < 1 || v > 5)) continue;
      const sum = values.reduce((acc, v) => acc + v, 0);
      const k = `${row.id}|${row.side}`;
      const prev = per.get(k) ?? { sum: 0, n: 0 };
      per.set(k, { sum: prev.sum + sum, n: prev.n + 1 });
    }
  }
  const wins = new Map();
  const bump = (name, kind) => {
    const v = wins.get(name) ?? { win: 0, lose: 0, tie: 0 };
    v[kind] += 1;
    wins.set(name, v);
  };
  for (const item of baseline.items) {
    const a = per.get(`${item.id}|1`);
    const b = per.get(`${item.id}|2`);
    if (!a?.n || !b?.n) continue;
    const diff = a.sum / a.n - b.sum / b.n;
    const side1Group = baseline.key[item.id]?.['1'];
    const side2Group = baseline.key[item.id]?.['2'];
    if (diff === 0) { bump(side1Group, 'tie'); bump(side2Group, 'tie'); continue; }
    bump(diff > 0 ? side1Group : side2Group, 'win');
    bump(diff > 0 ? side2Group : side1Group, 'lose');
  }
  return { ok: true, wins };
}

// ── CLI ────────────────────────────────────────────────────────────────────
function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'plan') {
    const variants = [];
    let samples = 3;
    let seed = 20261026;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--variant') {
        const { key, value } = parseVariant(rest[++i]);
        const params = { ...currentSampling(), [key]: value };
        variants.push({ name: `${key}-${value}`.replace(/\./g, 'p'), params });
      } else if (rest[i] === '--samples') samples = Math.max(1, Number(rest[++i]) || 3);
      else if (rest[i] === '--seed') seed = Number(rest[++i]) || seed;
    }
    if (!variants.length) {
      console.error('至少给一个 --variant，例如 --variant temperature=1.0');
      return 2;
    }
    const contexts = readContexts();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const tag = `ab-${stamp}`;
    const runDir = path.join(AB_DIR, stamp);
    const plan = buildPlan({ control: currentSampling(), variants, contexts, samples, seed, tag });
    fs.mkdirSync(runDir, { recursive: true });
    writePlan(runDir, plan, contexts);
    console.log(`计划已写入 ${path.relative(ROOT, runDir)}`);
    for (const g of plan.groups) {
      console.log(`  ${g.name}: ${g.change.key ? `${g.change.key} ${g.change.from} → ${g.change.to}` : '对照（当前线上值）'}`);
    }
    console.log(`  上下文 ${contexts.length} 条 × 每组 ${samples} 条；填完 replies/ 后运行 report`);
    return 0;
  }
  if (cmd === 'report') {
    const runDir = path.resolve(rest[0] ?? '');
    if (!rest[0] || !fs.existsSync(path.join(runDir, 'plan.json'))) {
      console.error('用法：node eval/ab-sampling.mjs report eval/ab/<stamp>');
      return 2;
    }
    const plan = JSON.parse(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf8'));
    const paired = pairReplies(runDir, plan);
    const metrics = writeReport(runDir, paired, plan);
    process.stdout.write(`${metrics}\n`);
    const res = scoreWins(runDir, plan);
    if (!res.ok) {
      console.log('尚无评审分数：先按 B1 流程评审 blind.csv（两栏、五维 1–5 分），再跑一次 report。');
      return 0;
    }
    console.log('胜场（五维总分，逐对比）：');
    for (const [name, v] of res.wins) console.log(`  ${name}: 胜 ${v.win} / 负 ${v.lose} / 平 ${v.tie}`);
    return 0;
  }
  console.error('用法：node eval/ab-sampling.mjs plan|report …');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
