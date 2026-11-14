#!/usr/bin/env node
// 一键自检入口：跑核心单测 + 探四个常驻服务 + 查关键配置 + 查计划任务 + 报备份新鲜度。
//
// 设计要点（见 项目计划/07-候选项目清单.md ③）：
//   1. 所有 I/O 都在这里，判定/渲染在 ../src/doctor.mjs（那边有单测钉住口径与简报行格式）。
//   2. 任何一项探不到都算红 —— 自检宁可误报，不可漏报（与简报的 services 行相反）。
//   3. 只跑「核心单测」（src/doctor.mjs 的 CORE_TESTS）：全仓 77 个测试里有 20 个历史遗留的
//      红（要活的 SnowLuma / 已删模块），全跑会让自检永远红、进而没人看。要全仓扫描加
//      --all-tests，再加 --strict 才把它们算成红。
//   4. 状态写 state/doctor-report.json（留最近 10 次），简报读它渲染「🩺 自检：8/8 通过」。
//
// 用法：
//   node scripts/doctor.mjs                 人看的报告，红项退出码 1
//   node scripts/doctor.mjs --json          机器可读（含每次 check 的细节与历史）
//   node scripts/doctor.mjs --no-tests      跳过单测（只探服务/配置，秒级）
//   node scripts/doctor.mjs --all-tests     额外扫描全仓测试，只报数不判红
//   node scripts/doctor.mjs --strict        --all-tests 的历史红升格为红
//   node scripts/doctor.mjs --quiet         只打最后一行摘要
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dashboardSnapshot } from '../src/dashboard.js';
import { serviceState } from '../src/daily-brief.mjs';
import { parseProbe, summarizeHealth, linkState } from '../src/health.mjs';
import {
  CORE_TESTS,
  EXPECTED_TASKS,
  formatReportLines,
  makeCheck,
  normalizeDoctorConfig,
  pruneHistory,
  summarizeChecks,
} from '../src/doctor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const STATE = path.join(ROOT, 'state');
const SCRIPTS = HERE;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const REPORT_FILE = path.join(STATE, 'doctor-report.json');
const BACKUP_STATE = path.join(STATE, 'backup.json');
// 健康探针每 5 分钟一行；20 分钟（漏 4 拍）没新行就算探针本身挂了。
const HEALTH_FILE = path.join(STATE, 'health.jsonl');
const HEALTH_STALE_MS = 20 * 60 * 1000;
// 夜间记忆整理（memory-index/nightly.py）每天 04:00 跑一次，正常每天都会写日志；
// 36 小时没动 = 漏了一整次（比如任务被禁用或 python 环境坏了）。
const MEM_DATA = path.join(ROOT, '..', 'memory-index', 'data');
const NIGHTLY_LOG = path.join(MEM_DATA, 'nightly.log');
const SUMMARIES_FILE = path.join(MEM_DATA, 'summaries.jsonl');
const NIGHTLY_STALE_MS = 36 * 3600_000;
const LOG_FILE = path.join(STATE, 'doctor.log');

const QQBRIDGE_PORT = 3100;
const SNOWLUMA_PORT = 3000;
const PHONE_BRIDGE_PORT = 8899;
const BACKUP_STALE_MS = 48 * 3600_000; // 日备留 7 份，48 小时没成功就是真出事了
const DEFAULT_TEST_TIMEOUT_MS = 120_000;

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { json: false, tests: true, allTests: false, strict: false, quiet: false, timeout: DEFAULT_TEST_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--no-tests') out.tests = false;
    else if (a === '--all-tests') out.allTests = true;
    else if (a === '--strict') out.strict = true;
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--timeout') out.timeout = Number(argv[++i]) || out.timeout;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node scripts/doctor.mjs [--json] [--no-tests] [--all-tests] [--strict] [--quiet] [--timeout ms]');
      process.exit(0);
    }
  }
  return out;
}

// ── 小工具 ──────────────────────────────────────────────────────────────────
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  // 报告写不进去也不能把「已经算出来的自检结论」变成一次 crash。
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 见上 */ }
}

function appendLog(line) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch { /* 见上 */ }
}

function clockOf(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 「有没有东西在听」：800ms 超时，失败不抛错。 */
function probeTcp(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, '127.0.0.1'); } catch { finish(false); }
  });
}

function tailLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 120) : '';
}

// ── check: 单测 ─────────────────────────────────────────────────────────────
function listTestFiles() {
  try {
    return fs.readdirSync(SCRIPTS).filter((f) => /^test-.*\.mjs$/.test(f)).sort();
  } catch {
    return [];
  }
}

function runOneTest(file, timeout) {
  const abs = path.join(SCRIPTS, file);
  if (!fs.existsSync(abs)) return { file, ok: false, summary: '缺文件' };
  const r = spawnSync(process.execPath, [abs], {
    cwd: ROOT,
    timeout,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, DOCTOR_CHILD: '1' },
  });
  const ok = r.status === 0;
  const summary = tailLine(r.stdout) || tailLine(r.stderr) || (ok ? '通过' : `退出码 ${r.status}`);
  return { file, ok, summary };
}

function checkTests(args) {
  if (!args.tests) return null;
  const todo = CORE_TESTS.filter((f) => fs.existsSync(path.join(SCRIPTS, f)));
  const missing = CORE_TESTS.filter((f) => !fs.existsSync(path.join(SCRIPTS, f)));
  const results = todo.map((f) => runOneTest(f, args.timeout));
  const bad = results.filter((r) => !r.ok);
  const extra = { core: results.map((r) => ({ file: r.file, ok: r.ok, summary: r.summary })), missing };

  let legacy = null;
  if (args.allTests) {
    const all = listTestFiles();
    const others = all.filter((f) => !CORE_TESTS.includes(f));
    const lr = others.map((f) => runOneTest(f, args.timeout));
    legacy = { total: all.length, red: lr.filter((r) => !r.ok).map((r) => ({ file: r.file, summary: r.summary })) };
    extra.legacy = legacy;
  }

  const ok = bad.length === 0 && missing.length === 0 && !(args.strict && legacy && legacy.red.length);
  const bits = [`${results.length - bad.length}/${todo.length} 通过`];
  if (missing.length) bits.push(`缺 ${missing.join('、')}`);
  if (bad.length) bits.push(bad.map((r) => `${r.file.replace(/^test-|\.mjs$/g, '')} ${r.summary}`).join('；'));
  if (legacy) bits.push(`全仓 ${legacy.total - legacy.red.length}/${legacy.total}（历史红 ${legacy.red.length}）`);
  return makeCheck('tests', ok, { detail: bits.join(' · '), extra });
}

// ── check: 四个常驻服务 ──────────────────────────────────────────────────────
async function checkServices() {
  let snapshot = null;
  try {
    snapshot = await dashboardSnapshot({ port: QQBRIDGE_PORT });
  } catch (error) {
    appendLog(`snapshot failed: ${error?.message ?? error}`);
  }
  const alive = await probeTcp(QQBRIDGE_PORT);
  const base = snapshot && typeof snapshot === 'object' ? snapshot : { services: {} };
  const services = base.services && typeof base.services === 'object' ? base.services : {};
  const merged = { ...base, services: { ...services, qqbridge: { ...(services.qqbridge || {}), alive, port: QQBRIDGE_PORT } } };
  const { states } = serviceState(merged);

  const okDetail = {
    qqbridge: `${QQBRIDGE_PORT} 在听`,
    qqbot: `${SNOWLUMA_PORT} 在听`,
    phoneBridge: `${PHONE_BRIDGE_PORT} 在听`,
    campusNet: '日志在更新',
  };
  return states.map((s) => {
    const ok = s.state === 'ok';
    const detail = ok ? okDetail[s.key] ?? null : s.note || (s.state === 'unknown' ? '没探到' : '挂了');
    return makeCheck(s.key, ok, { name: s.label, detail, extra: { state: s.state } });
  });
}

// ── check: 关键配置 ─────────────────────────────────────────────────────────
/** 控制台令牌的真实来源：config.consoleToken 为空时读 state/console-token（本机就是这么配的）。 */
function resolveConsoleToken(config) {
  const fromCfg = typeof config?.consoleToken === 'string' ? config.consoleToken.trim() : '';
  if (fromCfg) return { token: fromCfg, src: 'config.json' };
  try {
    const fromFile = fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
    if (fromFile) return { token: fromFile, src: 'state/console-token' };
  } catch { /* 文件不存在就是没配 */ }
  return { token: '', src: '缺失' };
}

function checkConfig(config, consoleToken) {
  const c = config && typeof config === 'object' ? config : {};
  const truthy = (v) => v === true || v === 'true' || v === 1;
  const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

  const rules = [
    ['voiceTts.enabled', truthy(c.voiceTts?.enabled), `voiceTts.enabled=${c.voiceTts?.enabled}`],
    ['socialV2.autoVoice.enabled', truthy(c.socialV2?.autoVoice?.enabled), `socialV2.autoVoice.enabled=${c.socialV2?.autoVoice?.enabled}`],
    ['mcp', c.mcp && typeof c.mcp === 'object' && Object.keys(c.mcp).length > 0, 'mcp 为空'],
    ['allow.private', Array.isArray(c.allow?.private) && c.allow.private.length > 0, 'allow.private 为空（谁都进不来）'],
    ['ownerQQ', /^\d{5,15}$/.test(String(c.ownerQQ ?? '')), `ownerQQ=${c.ownerQQ ?? '缺失'}`],
    ['snowluma.httpUrl', /^https?:\/\//.test(String(c.snowluma?.httpUrl ?? '').trim()), 'snowluma.httpUrl 无效'],
    ['snowluma.accessToken', nonEmpty(c.snowluma?.accessToken), 'snowluma.accessToken 为空'],
    ['consoleToken', nonEmpty(consoleToken.token), 'consoleToken 为空（config.json 与 state/console-token 都没有）'],
    ['dailyBrief.at', /^([01]\d|2[0-3]):[0-5]\d$/.test(String(c.dailyBrief?.at ?? '').trim()), `dailyBrief.at=${c.dailyBrief?.at ?? '缺失'}`],
  ];
  const bad = rules.filter(([, ok]) => !ok);
  const detail = bad.length
    ? bad.map(([, , why]) => why).join('、')
    : `${rules.length} 项关键配置正常（令牌取自 ${consoleToken.src}）`;
  return makeCheck('config', bad.length === 0, { detail, extra: { rules: rules.map(([key, ok]) => ({ key, ok })), consoleTokenSrc: consoleToken.src } });
}

// ── check: 备份新鲜度 ───────────────────────────────────────────────────────
function checkBackup(now) {
  const st = readJson(BACKUP_STATE);
  if (!st || !st.lastRunAt) return makeCheck('backup', false, { detail: '还没跑过（state/backup.json 缺失）' });
  const at = Date.parse(st.lastRunAt);
  const ageMs = Number.isFinite(at) ? now - at : Infinity;
  const fresh = Number.isFinite(ageMs) && ageMs <= BACKUP_STALE_MS;
  if (st.lastOk !== true) {
    return makeCheck('backup', false, {
      detail: `上次失败 ${clockOf(at)}${st.lastError ? `：${String(st.lastError).slice(0, 60)}` : ''}`,
      extra: st,
    });
  }
  const hours = Math.round(ageMs / 3600_000);
  const ok = fresh && Number(st.fileCount) > 0;
  const bits = [`${clockOf(at)} 成功（${st.fileCount ?? '?'} 份 / ${st.snapshotCount ?? '?'} 快照）`];
  if (hours >= 1) bits.push(`${hours} 小时前`);
  if (!ok) bits.push(fresh ? '文件数为 0' : '超过 48 小时没成功');
  return makeCheck('backup', ok, { detail: bits.join(' · '), extra: { lastRunAt: st.lastRunAt, lastOk: st.lastOk, fileCount: st.fileCount } });
}

// ── check: 健康时序新鲜度 ───────────────────────────────────────────────────
function checkHealth(now) {
  let text = '';
  try { text = fs.readFileSync(HEALTH_FILE, 'utf8'); } catch { text = ''; }
  const entries = text.split(/\r?\n/).map(parseProbe).filter(Boolean);
  if (!entries.length) return makeCheck('health', false, { detail: '还没有采样（state/health.jsonl 缺失或为空）' });
  const last = entries[entries.length - 1];
  const ageMs = Math.max(0, now - last.t);
  const fresh = ageMs <= HEALTH_STALE_MS;
  const day = summarizeHealth(entries, { from: now - 24 * 3600_000, to: now });
  const bits = [
    `最近 ${clockOf(last.t)}（${Math.round(ageMs / 60000)} 分钟前）`,
    `24h ${day.samples} 点`,
    day.flaps > 0 ? `抖动 ${day.flaps} 次` : '无抖动',
  ];
  if (!fresh) bits.push('超过 20 分钟没采样');
  return makeCheck('health', fresh, {
    detail: bits.join(' · '),
    extra: { lastAt: last.t, total: entries.length, samples24h: day.samples, flaps24h: day.flaps },
  });
}

// ── check: 夜间记忆整理新鲜度 ───────────────────────────────────────────────
function checkMemory(now) {
  let mtime = 0;
  try { mtime = fs.statSync(NIGHTLY_LOG).mtimeMs; } catch { mtime = 0; }
  let lines = 0;
  let lastDay = '';
  try {
    for (const row of fs.readFileSync(SUMMARIES_FILE, 'utf8').split(/\r?\n/)) {
      if (!row.trim()) continue;
      lines += 1;
      try {
        const r = JSON.parse(row);
        if (r.day) lastDay = r.day;
      } catch { /* 坏行不影响计数结论 */ }
    }
  } catch { /* 文件还没生成 */ }
  if (!mtime) {
    return makeCheck('memory', false, { detail: '还没跑过夜间整理（memory-index/data/nightly.log 缺失）' });
  }
  const ageMs = Math.max(0, now - mtime);
  const fresh = ageMs <= NIGHTLY_STALE_MS;
  const bits = [`最近 ${clockOf(mtime)}（${ageMs < 3600_000 ? `${Math.round(ageMs / 60000)} 分钟前` : `${Math.round(ageMs / 3600_000)} 小时前`}）`];
  bits.push(`摘要 ${lines} 条`);
  if (lastDay) bits.push(`覆盖到 ${lastDay}`);
  if (!fresh) bits.push('超过 36 小时没整理');
  return makeCheck('memory', fresh, {
    detail: bits.join(' · '),
    extra: { lastAt: mtime, summaryLines: lines, lastDay },
  });
}

// ── check: QQ 链路（端口活着 ≠ 消息通） ──────────────────────────────────────
// 2026-10-24 事故：3100 在听、get_status 报在线，但 WS 没连上，收发全废一小时而全绿。
// 所以单独查桥接的 /api/status：connected + 最近事件时间。
async function checkLink() {
  let token = '';
  try { token = fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim(); } catch { token = ''; }
  let status = null;
  let error = '';
  try {
    const res = await fetch(`http://127.0.0.1:${QQBRIDGE_PORT}/api/status`, {
      headers: token ? { 'x-console-token': token } : {},
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status = await res.json();
  } catch (e) {
    error = e?.message ?? String(e);
  }
  if (!status) {
    return makeCheck('link', false, { detail: `读不到 /api/status（${error}）` });
  }
  const link = linkState(status);
  const s = status.snowluma ?? {};
  const bits = [link.reason];
  if (typeof s.lastPacketAgoMs === 'number') bits.push(`最后事件 ${Math.round(s.lastPacketAgoMs / 1000)}s 前（${s.lastPacketKind ?? '?'}）`);
  if (typeof s.accountOnline === 'boolean') bits.push(s.accountOnline ? '账号在线' : '账号离线');
  return makeCheck('link', link.state === 'up', {
    detail: bits.join(' · '),
    extra: { state: link.state, reason: link.reason, snowluma: s },
  });
}

// ── check: 计划任务 ─────────────────────────────────────────────────────────
function readScheduledTasks() {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cmd = "Get-ScheduledTask | Where-Object { $_.TaskName -like 'DSH *' } | ForEach-Object { $_.TaskName + '|' + $_.State }";
  try {
    const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    });
    if (r.status !== 0) return null;
    const map = new Map();
    for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
      const [name, state] = line.split('|').map((s) => s.trim());
      if (name && state) map.set(name, state);
    }
    return map;
  } catch {
    return null;
  }
}

function checkTasks() {
  const map = readScheduledTasks();
  // 目录是预期的一部分：DSH Weekly Report 在 ④ 上线前不存在，所以缺了要如实点名。
  const required = EXPECTED_TASKS.filter((n) => n !== 'DSH Weekly Report');
  if (!map || map.size === 0) return makeCheck('tasks', false, { detail: '查不到计划任务（Get-ScheduledTask 失败）' });
  const missing = required.filter((n) => !map.has(n));
  const disabled = required.filter((n) => map.has(n) && /disabled/i.test(String(map.get(n))));
  const bad = [...missing.map((n) => `缺 ${n}`), ...disabled.map((n) => `${n} 已禁用`)];
  const okNames = required.filter((n) => map.has(n) && !missing.includes(n) && !disabled.includes(n));
  return makeCheck('tasks', bad.length === 0, {
    detail: bad.length ? bad.join('、') : `${okNames.length}/${required.length} 个必需任务就绪`,
    extra: { missing, disabled, present: [...map.keys()] },
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now();
  const config = readJson(CONFIG_FILE) || {};
  const cfg = normalizeDoctorConfig(config.doctor);

  const checks = [];
  const tests = checkTests(args);
  if (tests) checks.push(tests);
  for (const c of await checkServices()) checks.push(c);
  checks.push(checkConfig(config, resolveConsoleToken(config)));
  checks.push(checkBackup(now));
  checks.push(checkHealth(now));
  checks.push(checkMemory(now));
  checks.push(await checkLink());
  checks.push(checkTasks());

  const report = summarizeChecks(checks, now);
  const prev = readJson(REPORT_FILE) || {};
  const history = pruneHistory(
    [...(Array.isArray(prev.history) ? prev.history : []), { at: report.lastRunAt, ok: report.lastOk, passed: report.passed, total: report.total, failed: report.failed.map((f) => f.key) }],
    cfg.historyLimit,
  );
  const full = { ...report, history };
  writeJson(REPORT_FILE, full);
  appendLog(`${report.lastOk ? 'ok' : 'fail'} ${report.passed}/${report.total}${report.failed.length ? ` red=${report.failed.map((f) => f.key).join(',')}` : ''}`);

  if (args.json) {
    console.log(JSON.stringify(full, null, 2));
  } else if (args.quiet) {
    console.log(`${report.lastOk ? 'ok' : 'fail'} ${report.passed}/${report.total}${report.failed.length ? ` ${report.failed.map((f) => f.name).join('、')}` : ''}`);
  } else {
    for (const line of formatReportLines(report)) console.log(line);
  }

  return report.lastOk ? 0 : 1;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    appendLog(`crash: ${error?.stack ?? error}`);
    console.error(`crash: ${error?.message ?? error}`);
    process.exit(2);
  });
