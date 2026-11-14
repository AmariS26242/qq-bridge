// 影子阶段诊断：用真实 token 账本算每个会话的上下文水位，按 config.json 的
// contextBudget 阈值判级，并打印 shouldRequestHandoff 的结论。
// 只读，不写任何状态文件；不接生产进程。
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeContextBudgetConfig,
  classifyContextWatermark,
  formatContextWatermark,
  shouldRequestHandoff,
} from '../src/context-budget.mjs';
import { parseTokenRows } from '../src/ops-panel.js';

const root = path.resolve(import.meta.dirname, '..');
const cfgPath = path.join(root, 'config.json');
const usagePath = path.join(root, 'state', 'token-usage.jsonl');

const file = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const budget = normalizeContextBudgetConfig(file?.contextBudget);
const text = fs.existsSync(usagePath) ? fs.readFileSync(usagePath, 'utf8') : '';
const rows = parseTokenRows(text);

// 每个会话：按 t→turn→step→retry→seq 取最近一条 turn 记录的 cacheHit+cacheMiss
const latest = new Map();
for (const r of rows) {
  // parseTokenRows 只返回 turn 行，且已按 sid|turn|step|retry 去重
  const prev = latest.get(r.sid);
  if (!prev || r.t > prev.t || (r.t === prev.t && (r.turn ?? 0) > (prev.turn ?? 0))) latest.set(r.sid, r);
}

const out = [];
for (const [sid, r] of latest) {
  const wm = (r.b?.cacheHit ?? 0) + (r.b?.cacheMiss ?? 0);
  const level = classifyContextWatermark(wm, budget);
  out.push({ sid, wm, level, handoff: shouldRequestHandoff(level, budget) });
}
out.sort((a, b) => b.wm - a.wm);

console.log(`contextBudget: enabled=${budget.enabled} mode=${budget.mode} soft=${formatContextWatermark(budget.softAt)} hard=${formatContextWatermark(budget.hardAt)}`);
console.log(`sessions with token rows: ${out.length}`);
for (const o of out.slice(0, 10)) {
  console.log(`  ${o.sid}  水位=${formatContextWatermark(o.wm)}  level=${o.level}  交接=${o.handoff}`);
}
const tally = { ok: 0, soft: 0, hard: 0 };
for (const o of out) tally[o.level] = (tally[o.level] ?? 0) + 1;
console.log(`分级: ok=${tally.ok} soft=${tally.soft} hard=${tally.hard}`);
console.log(`结论: ${budget.mode === 'shadow' ? 'shadow 模式 → 即使 level=hard 也不会退役会话（只写 handoff + [budget] 日志）' : 'enforce 模式 → level=hard 会触发交接'}`);
