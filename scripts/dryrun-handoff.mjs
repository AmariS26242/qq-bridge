// C3 交接演练：用**真实状态**走一遍 enforce 时的判定与落盘流程，但写到临时目录，
// 并核对生产状态文件在演练前后逐字节未变。
//
// 用法：node scripts/dryrun-handoff.mjs [key]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createHandoffStore, normalizeHandoffPayload, buildHandoffLine, buildHandoffFromRecent } from '../src/handoff.mjs';
import { normalizeContextBudgetConfig, classifyContextWatermark, shouldRequestHandoff, formatContextWatermark } from '../src/context-budget.mjs';
import { parseTokenRows } from '../src/ops-panel.js';

const root = path.resolve(import.meta.dirname, '..');
const key = process.argv[2] || 'private:100000001';
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const budget = normalizeContextBudgetConfig(cfg.contextBudget);

const prodFiles = ['state/sessions.json', 'state/social-v2.json'].map((p) => path.join(root, p));
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16) : 'missing');
const before = Object.fromEntries(prodFiles.map((p) => [path.basename(p), sha(p)]));

// 1) 水位与判定
const rows = parseTokenRows(fs.readFileSync(path.join(root, 'state', 'token-usage.jsonl'), 'utf8'));
const latest = new Map();
for (const r of rows) { const prev = latest.get(r.sid); if (!prev || r.t >= prev.t) latest.set(r.sid, r); }
const social = JSON.parse(fs.readFileSync(path.join(root, 'state', 'social-v2.json'), 'utf8'));
const st = social.conversations?.[key] ?? {};
const sessionId = JSON.parse(fs.readFileSync(path.join(root, 'state', 'sessions.json'), 'utf8')).sessions?.[key];
const row = latest.get(sessionId);
const watermark = row ? (row.b?.cacheHit ?? 0) + (row.b?.cacheMiss ?? 0) : null;
const level = watermark === null ? 'unknown' : classifyContextWatermark(watermark, budget);
const wouldRetire = shouldRequestHandoff(level, budget);
console.log(`会话 ${key}  session=${String(sessionId ?? '无映射').slice(0, 20)}…`);
console.log(`水位 ${watermark === null ? 'unknown（无采样，按 unknown 处理，绝不当作 0）' : formatContextWatermark(watermark)}  level=${level}  mode=${budget.mode}  会不会退役=${wouldRetire}`);

// 2) 用真实记忆内容组装一份 payload（模拟模型该交什么）
const memoryItems = (st.activeTopics ?? []).length + (st.pendingThoughts ?? []).length + Object.keys(st.memberImpressions ?? {}).length;
const payloadRaw = {
  schemaVersion: 1,
  topics: (st.activeTopics ?? []).map((t) => String(t?.text ?? t)).filter(Boolean).slice(0, 3),
  openLoops: (st.pendingThoughts ?? []).map((t) => String(t?.text ?? t)).filter(Boolean).slice(0, 3),
  peopleChange: Object.entries(st.memberImpressions ?? {}).slice(0, 3).map(([name, v]) => `${name}：${String(v?.text ?? v)}`),
  mood: '',
  insideJokes: []
};
const normalized = normalizeHandoffPayload(payloadRaw, { maxChars: 400 });
console.log(`payload 校验：${normalized.ok ? 'ok' : '✗ ' + normalized.reason}；注入行长度 ${normalized.ok ? buildHandoffLine(normalized.value).length : '-'} 字符`);

// 2b) 记忆为空时照「记忆」交等于交空壳 —— 走 bridge 里同一条兜底：buildHandoffFromRecent。
let effective = normalized;
if (normalized.ok && buildHandoffLine(normalized.value).length === 0) {
  console.log(`⚠️  该会话的记忆区为空（activeTopics/pendingThoughts/memberImpressions 共 ${memoryItems} 项）→ 照记忆交接等于交空壳：省了上下文，丢了连续性。`);
  const fallback = buildHandoffFromRecent(st?.recentMessages, { maxMessages: 6 });
  if (fallback.ok) {
    effective = { ok: true, value: fallback.value };
    const line = buildHandoffLine(fallback.value);
    console.log(`   ✅ 兜底生效：取最近 ${fallback.used.messages} 条消息组装 → 校验 ok、注入行 ${line.length} 字符`);
    console.log(`   ${line}`);
  } else {
    console.log(`   ✗ 兜底也失败（${fallback.reason}）→ enforce 时应拒绝退役，保留旧会话`);
  }
}

// 3) 写到临时目录（不碰 state/handoff）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-dry-'));
const store = createHandoffStore({ dir: tmpDir });
const writeResult = effective.ok ? store.write(key, effective.value, { sessionId: sessionId ?? 'no-session' }) : { ok: false, reason: 'invalid-payload' };
const readBack = store.read(key);
console.log(`写入临时目录：${writeResult.ok ? 'ok' : '✗ ' + writeResult.reason}；回读 ${readBack ? '成功' : '失败'}；文件 ${fs.readdirSync(tmpDir).join(', ') || '无'}`);

// 4) 演练四步顺序的判定表（真实退役未执行）
console.log('\nenforce 时应当发生的顺序：');
console.log(`  1) ${writeResult.ok ? '写 handoff（ok）' : '写 handoff（失败 → 保留旧会话，fail-open）'}`);
console.log(`  2) ${writeResult.ok ? '确认 result.ok 后才允许退役' : '不退役'}`);
console.log(`  3) 退役时不清 unread（当前未读 ${st.unread?.length ?? 0} 条，迁移后应仍为 ${st.unread?.length ?? 0}）`);
console.log(`  4) 新会话沿用 ${key} 的社交状态，旧 session 映射删除`);

// 5) 生产文件必须逐字节未变
const after = Object.fromEntries(prodFiles.map((p) => [path.basename(p), sha(p)]));
const untouched = Object.keys(before).every((k) => before[k] === after[k]);
console.log(`\n生产状态未变：${untouched ? '✅ 是' : '❌ 否 —— 演练不该写生产目录'}`);
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exitCode = untouched ? 0 : 1;
