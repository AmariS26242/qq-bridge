// C3 翻 enforce 前的闸门检查：全绿才允许把 contextBudget.mode 从 shadow 改成 enforce。
// 只读；不修改任何状态。用法：node scripts/gate-enforce.mjs [--root <目录>]
// --root 只给测试用：把 state/ 换成临时目录，验证判据本身会翻红。
import fs from 'node:fs';
import path from 'node:path';
import { normalizeHandoffPayload } from '../src/handoff.mjs';

const rootArg = process.argv.find((a) => a.startsWith('--root='));
const root = rootArg ? path.resolve(rootArg.slice('--root='.length)) : path.resolve(import.meta.dirname, '..');

/**
 * 从日志里挑出「真的退役过会话」的行。
 *
 * 为什么不能只看 `[budget]`：退役日志的真实形状是
 * `[handoff] 交接成功，已退役旧会话 (key)`，影子模式那行是 `…不退役会话`。
 * 早先的判据要求同一行既有 `[budget]` 又有「退役」，两者永不同行 → 这项恒 PASS，
 * 等于影子期真退役了也查不出来。
 */
export function retireActions(logText) {
  return String(logText ?? '')
    .split(/\r?\n/)
    .filter((line) => line.includes('[handoff]') && /已退役/.test(line) && !/不退役/.test(line));
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

// 1) 影子已跑满 24 小时
const markerPath = path.join(root, 'state', 'c2-shadow-start.json');
let startedAt = 0;
try {
  startedAt = Number(JSON.parse(fs.readFileSync(markerPath, 'utf8')).startedAt) || 0;
} catch { /* 缺标记即视为未开始 */ }
const elapsedH = startedAt ? (Date.now() - startedAt) / 3_600_000 : 0;
check('影子满 24h', elapsedH >= 24, startedAt ? `已 ${elapsedH.toFixed(1)}h（起点标记 state/c2-shadow-start.json）` : '缺 state/c2-shadow-start.json，无法证明时长');

// 2) 影子期间出现过真实 [budget] 日志，且没有退役动作
const logPath = path.join(root, 'state', 'bridge.log');
let logText = '';
try { logText = fs.readFileSync(logPath, 'utf8'); } catch { /* 无日志 */ }
const budgetLines = logText.split('\n').filter((l) => l.includes('[budget]'));
const retireLines = retireActions(logText);
check('有 [budget] 影子日志', budgetLines.length > 0, `${budgetLines.length} 行`);
check('影子期无退役动作', retireLines.length === 0, retireLines.length ? `${retireLines.length} 行：${retireLines[retireLines.length - 1].slice(0, 120)}` : '0 行 `[handoff] …已退役`');

// 3) 两份关键状态有备份
const archiveDir = path.join(root, 'state', 'archive');
let archiveFiles = [];
try { archiveFiles = fs.readdirSync(archiveDir); } catch { /* 无目录 */ }
const hasSessionsBak = archiveFiles.some((f) => /^sessions\.json\./.test(f) && f.endsWith('.bak'));
const hasConfigBak = archiveFiles.some((f) => /^config\.json\./.test(f) && f.endsWith('.bak'));
check('sessions.json 有备份', hasSessionsBak, hasSessionsBak ? 'state/archive/sessions.json.*.bak' : '缺，翻 enforce 前必须 `Copy-Item state/sessions.json state/archive/sessions.json.<日期>.bak`');
check('config.json 有备份', hasConfigBak, hasConfigBak ? 'state/archive/config.json.*.bak' : '缺备份');

// 4) 交接 payload 全部通过 schema 校验
const handoffDir = path.join(root, 'state', 'handoff');
let payloads = [];
try {
  payloads = fs.readdirSync(handoffDir).filter((f) => f.endsWith('.json') && !f.includes('.tmp-'));
} catch { /* 还没交接 */ }
let bad = 0;
for (const f of payloads) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(handoffDir, f), 'utf8'));
    const res = normalizeHandoffPayload(raw.payload ?? raw, { maxChars: 400 });
    if (!res.ok) bad += 1;
  } catch { bad += 1; }
}
check('交接 payload 合格', payloads.length === 0 ? true : bad === 0, `抽查 ${payloads.length} 份，失败 ${bad} 份${payloads.length === 0 ? '（尚无交接样本，属信息不足而非通过）' : ''}`);

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`);
}
console.log(failed === 0 ? '\n结论：闸门全绿，可以翻 enforce（仍需用户拍板）' : `\n结论：${failed} 项未通过，暂不可翻 enforce`);
process.exitCode = failed === 0 ? 0 : 1;
