#!/usr/bin/env node
// 周报入口：所有 I/O 都在这里，渲染逻辑在 ../src/weekly-report.mjs。
//
// 设计要点（见 项目计划/07-候选项目清单.md ④）：
//   1. 不 import ../scripts/daily-brief.mjs —— 那个脚本没有 export、main() 在文件末尾
//      直接执行，import 会把简报也发一遍。发送逻辑在下面自带一份（30 行，接口就那么点）。
//   2. 数据源全是别的任务已经写好的流水：token-usage.jsonl / tool-calls.jsonl /
//      doctor-report.json / backup.json / 项目计划/*.md。周报自己不探测服务、不跑测试。
//   3. 幂等：state/weekly-report.json 记 lastSentWeek（ISO 周），同一周重复触发直接 skip。
//   4. 失败不静默：发 3 次（5s 退避），仍失败写 lastSendError + 退出码 2。
//
//   用法：
//   node scripts/weekly-report.mjs            正常发（同一周第二次会 skip）
//   node scripts/weekly-report.mjs --dry      只打印不发送（不动状态文件）
//   node scripts/weekly-report.mjs --force    忽略 lastSentWeek 再发一次
//   node scripts/weekly-report.mjs --json     打印统计明细（配合 --dry 调试）
//   node scripts/weekly-report.mjs --send-test 只发一条联调短句（不占本周额度）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeWeeklyConfig,
  makeWindow,
  summarizeTurns,
  summarizeCalls,
  summarizeDoctor,
  parseChecklist,
  diffChecklist,
  renderWeeklyReport,
  isoWeekKey,
} from '../src/weekly-report.mjs';
import { parseProbe, summarizeHealth } from '../src/health.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const STATE = path.join(ROOT, 'state');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const TOKEN_USAGE = path.join(STATE, 'token-usage.jsonl');
const TOOL_CALLS = path.join(STATE, 'tool-calls.jsonl');
const DOCTOR_STATE = path.join(STATE, 'doctor-report.json');
const BACKUP_STATE = path.join(STATE, 'backup.json');
// 5 分钟一行的健康时序：周报按同一 window 切片算可用率与抖动次数。
const HEALTH_FILE = path.join(STATE, 'health.jsonl');
const STATE_FILE = path.join(STATE, 'weekly-report.json');
const LOG_FILE = path.join(STATE, 'weekly-report.log');
const PLAN_DIR = path.join(ROOT, '..', '项目计划');
const LOG_MAX_BYTES = 512 * 1024;

const SEND_TIMEOUT_MS = 15_000;
const RETRY_BACKOFF_MS = 5_000;

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { dry: false, force: false, json: false, verbose: false, sendTest: false };
  for (const a of argv) {
    if (a === '--dry') out.dry = true;
    else if (a === '--force') out.force = true;
    else if (a === '--json') out.json = true;
    else if (a === '--send-test') out.sendTest = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node scripts/weekly-report.mjs [--dry] [--force] [--json] [--send-test] [--verbose]');
      process.exit(0);
    }
  }
  return out;
}

// ── 小工具（与 daily-brief.mjs 同口径：坏数据降级，不抛错）─────────────────────
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* 状态丢了也比炸掉进程好；appendLog 里另有痕迹 */
  }
}

function appendLog(line) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8');
    const { size } = fs.statSync(LOG_FILE);
    if (size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    /* 日志写不进去也不能拖垮周报 */
  }
}

/** 逐行 JSON：坏行跳过，别让一行半截日志毁掉整周统计。 */
function readJsonl(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* 半截行：忽略 */
    }
  }
  return out;
}

/** 项目计划/*.md → 复选框条目。目录不存在就是空清单（不报错）。 */
function collectChecklist(dir = PLAN_DIR) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return [];
  }
  const items = [];
  for (const name of names) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    items.push(...parseChecklist(text, name));
  }
  return items;
}

// ── 发送 ────────────────────────────────────────────────────────────────────
function targetUserId(config, cfg) {
  const fromKey = /^private:(\d{5,15})$/.exec(String(cfg?.key ?? ''));
  if (fromKey) return fromKey[1];
  const owner = String(config?.ownerQQ ?? '').trim();
  return /^\d{5,15}$/.test(owner) ? owner : null;
}

function onebotEndpoint(config) {
  const httpUrl = String(config?.snowluma?.httpUrl ?? '').trim().replace(/\/+$/, '');
  const token = String(config?.snowluma?.accessToken ?? '').trim();
  if (!/^https?:\/\//.test(httpUrl)) return null;
  return { httpUrl, token };
}

async function sendOneBot({ httpUrl, token }, userId, message) {
  const res = await fetch(`${httpUrl}/send_private_msg`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ user_id: Number(userId), message }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON：原文进错误信息 */ }
  return { status: res.status, json, text: text.slice(0, 300) };
}

function describeSendFailure(r) {
  const code = r?.json?.retcode ?? r?.json?.code ?? null;
  const msg = r?.json?.message ?? r?.json?.msg ?? r?.text ?? '';
  return `http ${r?.status ?? '?'}${code !== null ? ` retcode ${code}` : ''}${msg ? ` ${String(msg).slice(0, 120)}` : ''}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 周报默认发给简报的同一个 owner：weeklyReport.key 可覆盖，否则沿用 dailyBrief.key。
 * 缺 url 或缺收件人时把原因放在 error 里，别让调用方自己拼两套错误文案。
 */
function resolveTarget(config) {
  const endpoint = onebotEndpoint(config);
  const userId = targetUserId(config, { key: config.weeklyReport?.key || config.dailyBrief?.key });
  if (!endpoint || !userId) {
    return { endpoint, userId, error: !endpoint ? 'snowluma.httpUrl 不合法' : '找不到收件人（ownerQQ 或 key）' };
  }
  return { endpoint, userId, error: null };
}

/** 3 次、5s 退避；返回 {ok, error, response}。 */
async function sendWithRetry({ endpoint, userId }, text) {
  let last = null;
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      last = await sendOneBot(endpoint, userId, text);
      const okCode = last?.json?.retcode === 0 || (last?.status === 200 && last?.json?.status === 'ok');
      if (okCode) return { ok: true, response: last };
      lastErr = describeSendFailure(last);
      appendLog(`retry ${attempt}/3: ${lastErr}`);
    } catch (e) {
      last = null;
      lastErr = e instanceof Error ? e.message : String(e);
      appendLog(`retry ${attempt}/3: ${lastErr}`);
    }
    if (attempt < 3) await sleep(RETRY_BACKOFF_MS);
  }
  return { ok: false, error: lastErr || '网络异常', response: last };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const config = readJson(CONFIG_FILE) || {};
  const cfg = normalizeWeeklyConfig(config.weeklyReport);
  const weekKey = isoWeekKey(now);
  const target = resolveTarget(config);

  // 联调分支：只验证 OneBot 通道能不能通，不写 lastSentWeek（不占本周额度）。
  if (args.sendTest) {
    if (target.error) {
      console.error(`fail: ${target.error}`);
      appendLog(`send-test fail: ${target.error}`);
      return 2;
    }
    const r = await sendWithRetry(target, '📊 周报联调：OneBot 通道正常（不占本周额度）');
    if (!r.ok) {
      console.error(`fail: ${r.error}`);
      appendLog(`send-test fail: ${r.error}`);
      return 2;
    }
    console.log('ok: send-test');
    appendLog('ok: send-test');
    return 0;
  }

  if (!cfg.enabled) {
    console.log('skip: disabled');
    appendLog('skip: disabled');
    return 0;
  }

  const state = readJson(STATE_FILE) || {};
  if (!args.force && !args.dry && state.lastSentWeek === weekKey) {
    console.log('skip: already sent');
    appendLog(`skip: already sent (${state.lastSentWeek})`);
    return 0;
  }

  const window = makeWindow(now, cfg.windowDays);
  const turns = summarizeTurns(readJsonl(TOKEN_USAGE), window);
  const calls = summarizeCalls(readJsonl(TOOL_CALLS), window);
  const doctorReport = readJson(DOCTOR_STATE);
  const doctor = summarizeDoctor(doctorReport?.history ?? [], window);
  const backup = readJson(BACKUP_STATE);
  const health = summarizeHealth(readJsonl(HEALTH_FILE).map(parseProbe).filter(Boolean), window);
  const items = collectChecklist();
  const prevChecked = Array.isArray(state.checkedKeys) ? state.checkedKeys : null;

  const text = renderWeeklyReport({
    at: now,
    turns,
    calls,
    doctor,
    backup,
    health,
    items,
    prevChecked,
    config: cfg,
  });

  if (args.json || args.verbose) {
    const diff = diffChecklist(prevChecked, items);
    console.log(JSON.stringify({
      at: now.toISOString(),
      weekKey,
      window: { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() },
      turns,
      calls,
      doctor,
      backup: backup ? { at: backup.lastRunAt, ok: backup.lastOk, files: backup.fileCount, bytes: backup.totalBytes } : null,
      health: { samples: health.samples, flaps: health.flaps, windows: health.windows.length, services: health.services.map((s) => ({ key: s.key, uptime: s.uptime, down: s.down, unknown: s.unknown })) },
      checklist: { total: items.length, done: items.filter((i) => i.done).length, todo: items.filter((i) => !i.done).length, newlyDone: diff.newlyDone.length, firstRun: diff.firstRun },
      chars: text.length,
      lines: text.split('\n').length,
    }, null, 2));
  }

  console.log(text);

  if (args.dry) {
    appendLog(`dry: ${text.split('\n').length} 行 / ${text.length} 字`);
    return 0;
  }

  if (target.error) {
    console.error(`fail: ${target.error}`);
    appendLog(`fail: ${target.error}`);
    writeJson(STATE_FILE, { ...state, lastRunAt: now.toISOString(), lastOk: false, lastError: target.error });
    return 2;
  }

  const sent = await sendWithRetry(target, text);
  if (sent.ok) {
    writeJson(STATE_FILE, {
      lastRunAt: now.toISOString(),
      lastOk: true,
      lastError: null,
      lastSentWeek: weekKey,
      lastSentAt: now.toISOString(),
      chars: text.length,
      checkedKeys: items.filter((i) => i.done).map((i) => i.key),
    });
    appendLog(`ok: sent ${weekKey} ${text.length} 字`);
    return 0;
  }

  console.error(`fail: ${sent.error}`);
  appendLog(`fail: ${sent.error}`);
  writeJson(STATE_FILE, { ...state, lastRunAt: now.toISOString(), lastOk: false, lastError: sent.error });
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`周报异常: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    try { appendLog(`crash: ${e instanceof Error ? e.message : String(e)}`); } catch { /* ignore */ }
    process.exit(1);
  });
