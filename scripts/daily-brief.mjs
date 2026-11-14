#!/usr/bin/env node
// 每日简报入口：所有 I/O 都在这里，渲染逻辑在 ../src/daily-brief.mjs。
//
// 设计要点（见 项目计划/06-每日简报.md §3.2）：
//   1. 跑在 bridge 之外 —— 服务状态自己探（TCP）、发送走 OneBot 直发，不经 bridge.js。
//   2. 任何数据源坏了都降级而不是抛错：探不到就标红/省略那行，简报本身必须发出去。
//   3. 幂等：state/daily-brief.json 记 lastSentDate，同一天重复触发直接 skip。
//   4. 失败不静默：发 3 次（5s 退避），仍失败写 lastSendError + 退出码 2（任务 lastResult 可见）。
//
// 用法：
//   node scripts/daily-brief.mjs            正常发（同一天第二次会 skip）
//   node scripts/daily-brief.mjs --dry      只打印不发送
//   node scripts/daily-brief.mjs --force    忽略 lastSentDate 再发一次
//   node scripts/daily-brief.mjs --at 08:00 覆盖展示时间（调试）
//   node scripts/daily-brief.mjs --port 3999 覆盖 QQ桥探测端口（验证独立性）
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardSnapshot } from '../src/dashboard.js';
import { renderBrief, normalizeDailyBriefConfig, serviceState } from '../src/daily-brief.mjs';
import { evaluateCostGuard, summarizeUsageBySession } from '../src/cost-guard.mjs';
import { parseProbe, summarizeHealth } from '../src/health.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const STATE = path.join(ROOT, 'state');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const TOKEN_USAGE = path.join(STATE, 'token-usage.jsonl');
const TOOL_CALLS = path.join(STATE, 'tool-calls.jsonl');
const STATE_FILE = path.join(STATE, 'daily-brief.json');
const LOG_FILE = path.join(STATE, 'daily-brief.log');
// 备份与自检各自有任务在跑，简报只读它们留下的状态文件（不在这里重跑一遍）。
const BACKUP_STATE = path.join(STATE, 'backup.json');
const DOCTOR_STATE = path.join(STATE, 'doctor-report.json');
const CLEAN_STATE = path.join(STATE, 'clean-state.json');
// 每 5 分钟一行的健康时序（scripts/health-probe.mjs 写，周报也读它）。
const HEALTH_FILE = path.join(STATE, 'health.jsonl');

const TAIL_BYTES = 2 * 1024 * 1024; // 24h 的量远小于 2 MB，尾部读够用且不随文件增长变慢
const SEND_TIMEOUT_MS = 15_000;
const RETRY_BACKOFF_MS = 5_000;

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { dry: false, force: false, at: null, port: 3100, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry') out.dry = true;
    else if (a === '--force') out.force = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--at') out.at = argv[++i] ?? null;
    else if (a === '--port') out.port = Number(argv[++i]) || out.port;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node scripts/daily-brief.mjs [--dry] [--force] [--at HH:MM] [--port N] [--verbose]');
      process.exit(0);
    }
  }
  return out;
}

// ── 小工具 ──────────────────────────────────────────────────────────────────
function localDateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  // 状态写失败（只读介质、沙箱、权限）绝不能把已经发出去的简报变成一次 crash。
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* 幂等/审计信息丢了也比炸掉进程好；appendLog 里另有痕迹 */
  }
}

function appendLog(line) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* 日志写不进去也不能拖垮简报 */
  }
}

/** 读文件尾部若干字节并按行切；第一行可能被截断，丢掉。 */
function readTailLines(file, maxBytes = TAIL_BYTES) {
  let fd;
  try {
    const { size } = fs.statSync(file);
    const len = Math.min(maxBytes, size);
    if (len <= 0) return [];
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
    return text.split('\n').filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 「有没有东西在听」的探测：800ms 超时，失败不抛错（可能被沙箱/防火墙拦）。 */
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

// ── 数据装配 ────────────────────────────────────────────────────────────────
/**
 * QQ桥 的 alive 必须自己探：dashboard.js 跑在 bridge 进程里时把它硬编码成 true，
 * 而简报恰恰要在 bridge 停掉时说出「QQ桥 挂了」。
 */
async function collectSnapshot(port) {
  let snapshot = null;
  try {
    snapshot = await dashboardSnapshot({ port });
  } catch (error) {
    appendLog(`snapshot failed: ${error?.message ?? error}`);
  }
  const alive = await probeTcp(port);
  const base = snapshot && typeof snapshot === 'object' ? snapshot : { ok: true, at: Date.now(), services: {}, today: {} };
  const services = base.services && typeof base.services === 'object' ? base.services : {};
  return {
    ...base,
    services: { ...services, qqbridge: { ...(services.qqbridge || {}), alive, port } },
  };
}

/** 读 token-usage 尾部并解析成数组。只读一次：简报与成本守门吃同一份数据，
 *  免得两处各读一遍 2 MB 尾部、还要各自再判一次 k==='turn'。 */
function readUsageEntries() {
  const out = [];
  for (const line of readTailLines(TOKEN_USAGE)) {
    try { out.push(JSON.parse(line)); } catch { /* 半截行：跳过 */ }
  }
  return out;
}

/** 近 windowHours 的 token：只算 k==='turn' 的逐轮采样。
 *  base 行是「整条会话在某个 seq 上的累计基线」，没有时间明细；把它和 turn 一起加会重复计费。 */
function collectUsage(entries, windowHours, now = Date.now()) {
  const from = now - windowHours * 3600_000;
  const sum = { input: 0, cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0, reasoning: 0, turns: 0 };
  for (const rec of Array.isArray(entries) ? entries : []) {
    if (!rec || rec.k !== 'turn') continue;
    const t = Number(rec.t);
    if (!Number.isFinite(t) || t < from) continue;
    const b = rec.b || {};
    sum.cacheHit += Number(b.cacheHit) || 0;
    sum.cacheMiss += Number(b.cacheMiss) || 0;
    sum.cacheWrite += Number(b.cacheWrite) || 0;
    sum.output += Number(b.output) || 0;
    sum.reasoning += Number(b.reasoning) || 0;
    sum.turns += 1;
  }
  sum.input = sum.cacheHit + sum.cacheMiss;
  return sum.input || sum.output ? sum : null;
}

// ── 天气 ────────────────────────────────────────────────────────────────────
// 来源：Open-Meteo（免密钥、无需注册，WMO 天气码）。
// 位置优先级：config.dailyBrief.weather 的坐标 > 位置缓存（30 天）> IP 定位。
// 为什么坐标优先：IP 定位按出口 IP 推，常把「河南洛阳」推成「郑州管城」几十公里外。
const GEO_CACHE = path.join(STATE, 'weather-place.json');
const GEO_TTL_MS = 30 * 24 * 3600_000;
const WX_TIMEOUT_MS = 8000;
const WX_HOST = 'api.open-meteo.com';

async function fetchJson(url, timeoutMs = WX_TIMEOUT_MS) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** IP 级定位：ip-api（http，免费版只允许 http）→ ipapi.co 兜底。失败返回 null。 */
async function ipLocate() {
  try {
    const j = await fetchJson('http://ip-api.com/json/?fields=status,city,district,regionName,lat,lon&lang=zh-CN', 6000);
    if (j?.status === 'success' && Number.isFinite(Number(j.lat))) {
      return { lat: Number(j.lat), lon: Number(j.lon), label: String(j.city || j.district || j.regionName || '').trim(), via: 'ip-api' };
    }
  } catch { /* 落到下一个 */ }
  try {
    const j = await fetchJson('https://ipapi.co/json/', 6000);
    if (Number.isFinite(Number(j?.latitude))) {
      return { lat: Number(j.latitude), lon: Number(j.longitude), label: String(j.city || j.region || '').trim(), via: 'ipapi.co' };
    }
  } catch { /* 无网就直接没有位置 */ }
  return null;
}

async function resolvePlace(weatherCfg) {
  if (Number.isFinite(weatherCfg.latitude) && Number.isFinite(weatherCfg.longitude)) {
    return { lat: weatherCfg.latitude, lon: weatherCfg.longitude, label: weatherCfg.label || '' };
  }
  const cached = readJson(GEO_CACHE);
  if (cached && Number.isFinite(Number(cached.lat)) && Date.now() - Number(cached.at || 0) < GEO_TTL_MS) {
    return { lat: Number(cached.lat), lon: Number(cached.lon), label: String(cached.label ?? '') };
  }
  const found = await ipLocate();
  if (!found) return null;
  writeJson(GEO_CACHE, { ...found, at: Date.now() });
  appendLog(`weather place: ${found.label || '?'} (${found.lat},${found.lon}) via ${found.via}`);
  return found;
}

/** 今日天气；任何失败都返回 null（简报少一行，不能整条不发）。 */
async function collectWeather(weatherCfg) {
  if (!weatherCfg.enabled) return null;
  try {
    const place = await resolvePlace(weatherCfg);
    if (!place) {
      appendLog('weather fail: no place (ip lookup failed)');
      return null;
    }
    const u = new URL('https://api.open-meteo.com/v1/forecast');
    u.searchParams.set('latitude', String(place.lat));
    u.searchParams.set('longitude', String(place.lon));
    u.searchParams.set('current', 'temperature_2m,apparent_temperature,weather_code,relative_humidity_2m');
    u.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
    u.searchParams.set('timezone', 'Asia/Shanghai'); // 简报永远按本地白天说话
    u.searchParams.set('forecast_days', '1');
    const j = await fetchJson(u.toString());
    const c = j?.current ?? {};
    const d = j?.daily ?? {};
    const weather = {
      label: weatherCfg.label || place.label || '',
      code: c.weather_code,
      temp: c.temperature_2m,
      feels: c.apparent_temperature,
      min: Array.isArray(d.temperature_2m_min) ? d.temperature_2m_min[0] : undefined,
      max: Array.isArray(d.temperature_2m_max) ? d.temperature_2m_max[0] : undefined,
      precip: Array.isArray(d.precipitation_probability_max) ? d.precipitation_probability_max[0] : undefined,
    };
    if (!Number.isFinite(Number(weather.code)) && !Number.isFinite(Number(weather.temp))) {
      appendLog('weather fail: empty payload');
      return null;
    }
    return weather;
  } catch (error) {
    const code = error?.cause?.code ? ` (${error.cause.code})` : '';
    appendLog(`weather fail: ${error?.message ?? error}${code} @ ${WX_HOST}`);
    return null;
  }
}

/** 近 windowHours 的工具调用统计：比 qq-activity.log 准（有 ISO 时间、有 ok 标记）。 */
function collectToolStats(windowHours, now = Date.now()) {
  const from = now - windowHours * 3600_000;
  const stats = { messages: 0, voices: 0, stickers: 0, failed: 0, calls: 0 };
  for (const line of readTailLines(TOOL_CALLS)) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec) continue;
    const t = Date.parse(rec.time);
    if (!Number.isFinite(t) || t < from) continue;
    if (rec.type === 'result') {
      if (rec.ok === false) stats.failed += 1;
      continue;
    }
    if (rec.type !== 'call') continue;
    stats.calls += 1;
    const tool = String(rec.tool ?? '');
    // 工具名带 MCP 前缀（mcp__snowluma__qq_send_message），所以只匹配动作名结尾。
    if (/qq_send_message$|qq_reply$|qq_send_private_message$/.test(tool)) stats.messages += 1;
    else if (/qq_send_sticker$/.test(tool)) stats.stickers += 1;
    else if (/voice|tts/i.test(tool)) stats.voices += 1;
  }
  return stats;
}

/** 发送目标只有 owner；key 形如 private:<uin> 时以 key 为准。 */
function targetUserId(config, cfg) {
  const fromKey = /^private:(\d{5,15})$/.exec(String(cfg.key ?? ''));
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

// ── 发送 ────────────────────────────────────────────────────────────────────
async function sendOneBot({ httpUrl, token }, userId, message) {
  const body = JSON.stringify({ user_id: Number(userId), message });
  const res = await fetch(`${httpUrl}/send_private_msg`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应：把原文带进错误信息 */ }
  return { status: res.status, json, text: text.slice(0, 300) };
}

function describeSendFailure(r) {
  const code = r?.json?.retcode ?? r?.json?.code ?? null;
  const msg = r?.json?.message ?? r?.json?.msg ?? r?.text ?? '';
  return `http ${r?.status ?? '?'}${code !== null ? ` retcode ${code}` : ''}${msg ? ` ${String(msg).slice(0, 120)}` : ''}`;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const config = readJson(CONFIG_FILE) || {};
  const cfg = normalizeDailyBriefConfig(config.dailyBrief);

  if (!cfg.enabled) {
    console.log('skip: disabled');
    appendLog('skip: disabled');
    return 0;
  }

  const state = readJson(STATE_FILE) || {};
  const todayKey = localDateKey(startedAt);
  // --dry 只用来「随时看看现在会发什么」，不该被今天的发送记录挡住。
  if (!args.force && !args.dry && state.lastSentDate === todayKey) {
    console.log('skip: already sent');
    appendLog(`skip: already sent (${state.lastSentDate})`);
    return 0;
  }

  const snapshot = await collectSnapshot(args.port);
  const weather = await collectWeather(cfg.weather);
  const now = startedAt.getTime();
  const usageEntries = readUsageEntries();
  const usage = collectUsage(usageEntries, cfg.windowHours, now);
  // 成本守门：与 token 行同源同窗。关掉时传 null，简报退回原来的 token 行（不撒谎也不多一行）。
  const cost = cfg.costGuard.enabled
    ? evaluateCostGuard(
      summarizeUsageBySession(usageEntries, { from: now - cfg.windowHours * 3600_000, to: now }),
      cfg.costGuard,
    )
    : null;
  const toolStats = collectToolStats(cfg.windowHours, now);
  // 健康时序：同样按 windowHours 切片，只取采样点算抖动次数（不读快照，不受探针挂没挂影响）。
  const health = summarizeHealth(
    readTailLines(HEALTH_FILE).map(parseProbe).filter(Boolean),
    { from: now - cfg.windowHours * 3600_000, to: now },
  );
  const prev = { red: Array.isArray(state.prevRed) ? state.prevRed : [] };
  // 缺文件就是「还没跑过」：renderBrief 会直接省略那两行，不占行数也不报错。
  const backup = readJson(BACKUP_STATE);
  const doctor = readJson(DOCTOR_STATE);
  const clean = readJson(CLEAN_STATE);

  // 展示时间 = 真实发送时间（补跑时不会谎称 08:00）；--at 只用于调试/单测。
  let at = startedAt;
  if (args.at) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(args.at);
    if (m) at = new Date(startedAt.getFullYear(), startedAt.getMonth(), startedAt.getDate(), Number(m[1]), Number(m[2]));
  }

  const text = renderBrief({ at, snapshot, usage, toolStats, prev, weather, config: cfg, backup, doctor, clean, cost, health });
  const { red } = serviceState(snapshot);
  const redKeys = red.map((s) => s.key);

  if (args.verbose || args.dry) {
    console.log('--- 简报正文 ---');
    console.log(text);
    console.log('--- 统计 ---');
    console.log(JSON.stringify({ at: at.toISOString(), len: text.length, lines: text.split('\n').length, red: redKeys, weather, usage, toolStats, cost: cost ? { ok: cost.ok, reds: cost.reds, cacheRate: cost.cacheRate, input: cost.input, top: cost.top } : null, health: { samples: health.samples, flaps: health.flaps, windows: health.windows.length }, prevRed: prev.red, backup: backup ? { ok: backup.lastOk, at: backup.lastRunAt, files: backup.fileCount } : null, doctor: doctor ? { ok: doctor.lastOk, passed: doctor.passed, total: doctor.total } : null }, null, 2));
  }

  if (args.dry) {
    appendLog(`dry len=${text.length} lines=${text.split('\n').length} red=${redKeys.join(',') || '-'} weather=${weather ? weather.label || '?' : '-'} cost=${cost ? (cost.ok ? 'ok' : cost.reds.map((r) => r.code).join('+')) : 'off'} top=${cost?.top ? `${cost.top.sid.slice(0, 20)} ${(cost.top.share * 100).toFixed(0)}%` : '-'}`);
    return 0;
  }

  const endpoint = onebotEndpoint(config);
  const userId = targetUserId(config, cfg);
  if (!endpoint || !userId) {
    const why = !endpoint ? 'onebot endpoint missing in config.snowluma' : 'no private target in config';
    appendLog(`fail: ${why}`);
    console.error(`fail: ${why}`);
    writeJson(STATE_FILE, { ...state, lastSendError: { at: new Date().toISOString(), error: why }, attempts: Number(state.attempts) || 0 });
    return 2;
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const r = await sendOneBot(endpoint, userId, text);
      const retcode = r?.json?.retcode;
      if (retcode === 0) {
        const id = r.json?.data?.message_id ?? null;
        const record = {
          lastSentDate: todayKey,
          lastSentAt: new Date().toISOString(),
          prevRed: redKeys,               // 供明天的「已恢复」判断
          lastSendError: null,
          attempts: attempt,
          lastLen: text.length,
          lastMessageId: id,
        };
        writeJson(STATE_FILE, record);
        appendLog(`sent len=${text.length} lines=${text.split('\n').length} retcode=0 message_id=${id} red=${redKeys.join(',') || '-'} attempts=${attempt}`);
        console.log(`sent: len=${text.length} message_id=${id}`);
        return 0;
      }
      lastError = describeSendFailure(r);
    } catch (error) {
      // fetch 的网络错误本身只有一句 "fetch failed"，真正的原因在 cause.code 里
      // （ECONNREFUSED / ENOTFOUND / 超时）。把目标地址也带上，排障时不用翻代码。
      const code = error?.cause?.code ?? error?.code ?? '';
      const detail = [error?.message ?? String(error), code].filter(Boolean).join(' ');
      lastError = `exception: ${detail} @ ${new URL(endpoint.httpUrl).host}`;
    }
    appendLog(`send attempt ${attempt}/3 failed: ${lastError}`);
    if (attempt < 3) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
  }

  writeJson(STATE_FILE, {
    ...state,
    lastSentDate: state.lastSentDate ?? null,
    lastSendError: { at: new Date().toISOString(), error: lastError, len: text.length },
    attempts: 3,
  });
  appendLog(`fail: ${lastError}`);
  console.error(`fail: ${lastError}`);
  return 2;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    appendLog(`crash: ${error?.stack ?? error}`);
    console.error(`crash: ${error?.message ?? error}`);
    process.exit(2);
  });
