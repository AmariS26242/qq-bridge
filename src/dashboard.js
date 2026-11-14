// 生活仪表盘的**只读**快照聚合：给 GET /api/dashboard/services 用。
//
// 为什么需要这个模块（见 docs/DASHBOARD_API.md §5）：
//   现有 /api/* 覆盖了 qqbot 的心跳与 token 用量，但**手机桥**（bridge/，8899/8443）
//   和**校园网守护**（campus-net，跑在计划任务 CampusNet-Guard 里）在浏览器侧拿不到：
//   前者要配对令牌（无令牌 401）、后者压根没有 HTTP 面。所以这里在服务端做最朴素的
//   「TCP 连一下 + 看文件 mtime + 问一句 schtasks」，只读、无副作用。
//
// 硬约束：
//   1. 不写任何文件、不改任何状态、不发任何 QQ 消息。
//   2. 不新增端口、不新增常驻服务：全部探测都在本进程内完成。
//   3. 结果缓存 12 秒 —— 页面 30 秒轮询、用户多开标签页时不会反复 spawn schtasks。
//   4. 任何一项拿不到都返回 alive:null（页面显示「—」），绝不抛错连累整个响应。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');                 // qq-bridge/
const WORKSPACE = path.join(ROOT, '..');            // default-workspace/
const ACTIVITY_LOG = path.join(ROOT, 'state', 'qq-activity.log');
const REMINDERS_FILE = path.join(ROOT, 'state', 'reminders.json');
const CAMPUS_LOG = path.join(WORKSPACE, 'campus-net', 'log', 'net-guard.log');
const PHONE_UPSTREAM_FILE = path.join(WORKSPACE, 'bridge', '.upstream');
const PHONE_WATCHDOG_FILE = path.join(WORKSPACE, 'bridge', '.watchdog-fails');

const SNOWLUMA_HTTP_PORT = 3000;   // config.snowluma.httpUrl 的端口
const PHONE_BRIDGE_PORT = 8899;    // bridge/ 的 HTTP 端口（无令牌返回 401，能连上即在听）
const CAMPUS_TASK = 'CampusNet-Guard';
// 不要只写 'schtasks'：桥接由 start.bat 在隐藏 console 里拉起，PATH 里不一定有 System32，
// 实测 execFileSync('schtasks') 会抛 ENOENT（系统找不到指定的路径）。用绝对路径最稳。
const SCHTASKS_EXE = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'schtasks.exe');
const CAMPUS_STALE_MS = 8 * 60 * 1000;   // 任务每 5 分钟跑一次，超 8 分钟没更新日志就算坏
const CACHE_MS = 5000;

function readTextSafe(file, maxBytes = 400_000) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const text = fs.readFileSync(file, 'utf8');
    return { text: text.length > maxBytes ? text.slice(-maxBytes) : text, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** TCP 探测：只判断「有没有东西在听」。800ms 超时，失败不抛错。
 *  导出给 scripts/health-probe.mjs 复用（同一套探测口径，别在两处各写一遍）。 */
export function probeTcp(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, host); } catch { finish(false); }
  });
}

const _CLOCK_RE = /^\[(\d{2}):(\d{2}):(\d{2})\]/;

/** 时钟秒数（HH:MM:SS → 当天第几秒），不是这个格式返回 null。 */
function _clockSeconds(line) {
  const m = _CLOCK_RE.exec(line || '');
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** 一个日志文件里「今天」那一段：时间只到秒、没有日期，所以用「时钟回拨」判断跨零点。
 *  文件是顺序追加的，23:59 → 00:00 这一跳就是新的一天；最后一段才是今天的。
 *  容 60 秒回拨（NTP 校时/手动调整）避免误判。 */
function _splitToday(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  let startIdx = 0;
  let prev = -1;
  for (let i = 0; i < lines.length; i++) {
    const sec = _clockSeconds(lines[i]);
    if (sec === null) continue;
    if (prev >= 0 && sec < prev - 60) startIdx = i;
    prev = sec;
  }
  return { lines: lines.slice(startIdx), wrapped: startIdx > 0 };
}

/** 今日 QQ 活跃数：从 qq-activity.log 里数。
 *  日志被 createCappedLogger 按 500 行轮转（当前文件改成 .1，新文件从零写），
 *  时间戳又只有 [HH:MM:SS] 没有日期 —— 所以：
 *   1) 今天写过的 .1 要一并算（否则一天里轮转一次，当天较早的记录就漏了）；
 *   2) 每个文件只取最后一个「00:00 之后」的片段（否则会把昨天晚上的记录算进今天）。
 */
function countActivityToday() {
  const main = readTextSafe(ACTIVITY_LOG);
  const prev = readTextSafe(`${ACTIVITY_LOG}.1`);
  const todayKey = new Date().toDateString();
  const isToday = (f) => !!f && new Date(f.mtimeMs).toDateString() === todayKey;
  if (!isToday(main) && !isToday(prev)) {
    return { available: false, messages: 0, sent: 0, stickers: 0, voices: 0, lastLine: null };
  }
  const parts = [];
  let merged = false;
  if (isToday(prev)) {
    const p = _splitToday(prev.text);
    if (p.lines.length) { parts.push(p.lines); merged = true; }
  }
  if (isToday(main)) parts.push(_splitToday(main.text).lines);
  const lines = parts.flat();
  const firstClock = (() => {
    const m = _CLOCK_RE.exec(lines[0] || '');
    return m ? `${m[1]}:${m[2]}:${m[3]}` : null;
  })();
  let messages = 0;
  let sentLines = 0;
  let sentOk = 0;
  let sentTotal = 0;
  let stickers = 0;
  let voices = 0;
  for (const line of lines) {
    if (line.includes('消息已入未读')) messages += 1;
    if (line.includes('工具统一发送')) {
      sentLines += 1;
      const m = /工具统一发送[：:]\s*成功\s*(\d+)\s*\/\s*(\d+)/.exec(line);
      if (m) { sentOk += Number(m[1]); sentTotal += Number(m[2]); }
    }
    if (line.includes('[sticker]')) stickers += 1;
    if (line.includes('[voice]') || line.includes('发送语音')) voices += 1;
  }
  return {
    available: true,
    bytes: lines.reduce((n, l) => n + Buffer.byteLength(l, 'utf8') + 1, 0),
    lines: lines.length,
    merged,
    firstClock,
    messages,
    sent: sentLines,
    sentOk,
    sentTotal,
    stickers,
    voices,
    lastLine: lines.length ? lines[lines.length - 1].slice(0, 200) : null,
  };
}

/** 待触发提醒：只读 state/reminders.json（/api/socialV2/reminder-list 要 agent token，控制台用不了）。 */
function readReminders() {
  const f = readTextSafe(REMINDERS_FILE, 2_000_000);
  if (!f) return { available: false, pending: 0, total: 0, items: [] };
  let data;
  try { data = JSON.parse(f.text); } catch { return { available: false, pending: 0, total: 0, items: [] }; }
  const all = Array.isArray(data?.reminders) ? data.reminders : [];
  const pending = all
    .filter((r) => r && r.status === 'pending' && Number(r.nextRunAt) > 0)
    .sort((a, b) => a.nextRunAt - b.nextRunAt)
    .slice(0, 5)
    .map((r) => ({
      id: r.id,
      key: r.key,
      at: Number(r.nextRunAt),
      repeat: r.repeat ?? 'none',
      text: String(r.text ?? r.prompt ?? '').slice(0, 120),
    }));
  return { available: true, pending: pending.length, total: all.length, items: pending };
}

/**
 * schtasks.exe 输出的编码跟着控制台代码页走（本机中文系统 = GBK 936），而 Node 的
 * execFileSync 拿 Buffer 后按 UTF-8 解会变成乱码、英文键也匹配不到。这里先按 UTF-8
 * 严格解码试探，不行再按 GBK 解；两边都认「英文键」与「中文键」。
 */
function decodeTaskOutput(buf) {
  const probe = /^\s*(Status|Scheduled Task State|状态|模式|计划任务状态)\s*[:：]/mi;
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    if (probe.test(utf8)) return utf8;
  } catch {}
  try {
    const gbk = new TextDecoder('gbk').decode(buf);
    if (probe.test(gbk)) return gbk;
  } catch {}
  return buf.toString('utf8');
}

/**
 * 把 Windows 控制台工具（schtasks/cmd/whoami）的输出 Buffer 解成可读文本。
 *
 * 它们的输出编码跟着控制台代码页走（中文系统 = GBK 936），而 Node 在 execFileSync 失败时
 * 把 stderr 按 UTF-8 拼进 error.message，页面上就成了「错误: 系统找不到指定的路径」的乱码版。
 * 所以先严格解 UTF-8（解不出会抛），失败再按 GBK 解，最后兜底宽松 utf8。
 */
function decodeConsoleText(buf) {
  if (!buf) return '';
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {}
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {}
  return bytes.toString('utf8');
}

/** execFileSync 的失败原话：优先用 stderr Buffer 自己解，绕开 Node 拼出来的乱码。 */
function describeExecError(error) {
  const stderr = error?.stderr ? decodeConsoleText(error.stderr).trim() : '';
  return (stderr || String(error?.message ?? error)).replace(/\s+/g, ' ').trim();
}

/**
 * 本进程的完整性级别（Windows Mandatory Integrity Control）。
 *
 * 只在查询失败时探一次并缓存：`whoami /groups` 本身不受限制，Low 进程也能跑。
 * level 是强制标签 SID 的末段 RID：4096=Low、8192=Medium、12288=High。
 */
let integrityCache;
function detectIntegrity() {
  if (integrityCache !== undefined) return integrityCache;
  integrityCache = null;
  try {
    const whoami = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'whoami.exe');
    const out = String(execFileSync(whoami, ['/groups'], { timeout: 1500, windowsHide: true }));
    const m = /S-1-16-(\d+)/.exec(out);
    if (m) {
      const level = Number(m[1]);
      integrityCache = {
        level,
        rid: `S-1-16-${m[1]}`,
        name: level >= 16384 ? 'high' : level >= 8192 ? 'medium' : level >= 4096 ? 'low' : 'untrusted',
      };
    }
  } catch {}
  return integrityCache;
}

/**
 * 问一句计划任务（只读；schtasks /query 不改任何状态）。
 *
 * 为什么要「多试几种起法」：同一个 schtasks 调用在**由 start.bat 守护拉起的桥接进程**里
 * 正常返回，但在**被 DSH 应用直接 spawn 起来的桥接进程**里会退化成
 * `错误: 系统找不到指定的路径。`。根因（2026-10-23 实测）：DSH 运行时那个 node.exe 即使从
 * Medium 控制台启动，fork 出的子进程也是 **Low 完整性（S-1-16-4096）**，访问不到任务计划程序
 * （schtasks 报路径不存在、Get-ScheduledTask 报 0x80070003）；换成 Medium 的 node
 * （SnowLuma\node.exe）即正常。根治办法是让桥接跑在 Medium 的 node 上；这里的多策略 +
 * detectIntegrity() 是兜底与自证：三种起法依次试（直呼绝对路径 → 显式指定 cwd → 交给
 * cmd.exe），任一种成功即可，`via` 记录生效的那一种，`attempts` 保留每次失败原因供排查。
 */
function queryCampusTask() {
  const args = ['/query', '/tn', CAMPUS_TASK, '/fo', 'list', '/v'];
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const system32 = path.join(systemRoot, 'System32');
  const strategies = [
    ['direct', () => execFileSync(SCHTASKS_EXE, args, { timeout: 2500, windowsHide: true })],
    ['cwd', () => execFileSync(SCHTASKS_EXE, args, { timeout: 2500, windowsHide: true, cwd: system32 })],
    // 交给 cmd.exe 时有两个坑，缺一就永远失败（报 `'"C:\...\schtasks.exe"' 不是内部或外部命令`）：
    //   1. Node 默认会再给参数里的引号转义一层，cmd 收到的是 \" 开头的怪串 —— 必须
    //      windowsVerbatimArguments:true，把命令行原样交给 cmd；
    //   2. cmd /s /c 只剥掉最外层的**一对**引号，所以命令行要写成 ""exe" args"（首尾再各加
    //      一个引号包住整条），剥完正好留下 "exe" args。
    ['cmd', () => execFileSync('cmd.exe', ['/d', '/s', '/c', `""${SCHTASKS_EXE}" /query /tn ${CAMPUS_TASK} /fo list /v"`], {
      timeout: 3000,
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: { ...process.env, SystemRoot: systemRoot, windir: systemRoot, PATH: `${system32};${systemRoot}` },
    })],
  ];
  const attempts = [];
  let buf = null;
  let via = null;
  for (const [name, run] of strategies) {
    try {
      buf = run();
      via = name;
      break;
    } catch (error) {
      attempts.push({ name, error: describeExecError(error).slice(0, 160) });
    }
  }
  if (!buf) {
    const lastError = attempts.at(-1)?.error ?? 'schtasks failed';
    // 先自证权限：Low 完整性下这三种起法都不可能成功，报「系统找不到指定的路径」纯属误导
    // （这句曾让人去查 PATH 和编码，实际是低完整性进程被任务计划程序拒在门外）。
    const integrity = detectIntegrity();
    const restricted = !!integrity && integrity.level > 0 && integrity.level < 8192;
    return {
      ok: false,
      error: restricted ? `桥接进程权限受限（${integrity.rid}），查不到任务计划程序｜${lastError}` : lastError,
      detail: lastError,
      integrity: integrity ? integrity.rid : null,
      attempts,
    };
  }
  try {
    const out = decodeTaskOutput(buf);
    const pick = (labels) => {
      for (const label of labels) {
        const m = new RegExp(`^\\s*${label}\\s*[:：]\\s*(.+)$`, 'mi').exec(out);
        if (m && m[1].trim() && m[1].trim() !== 'N/A') return m[1].trim();
      }
      return null;
    };
    return {
      ok: true,
      via,
      attempts: attempts.length ? attempts : undefined,
      // 「模式 / Status」= Ready|Running|Disabled
      state: pick(['Status', '模式']),
      // 「计划任务状态 / Scheduled Task State」= Enabled|Disabled —— 禁用任务时这里会先变
      taskState: pick(['Scheduled Task State', '计划任务状态']),
      lastRun: pick(['Last Run Time', '上次运行时间']),
      nextRun: pick(['Next Run Time', '下次运行时间']),
      lastResult: pick(['Last Result', '上次结果']),
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 200), via, attempts };
  }
}

/** 校园网：日志新鲜度 + 计划任务状态。导出给 scripts/health-probe.mjs 复用。 */
export function campusSnapshot() {
  const log = readTextSafe(CAMPUS_LOG, 300_000);
  const task = queryCampusTask();
  const now = Date.now();
  const logAgeMs = log ? Math.max(0, Math.round(now - log.mtimeMs)) : null;
  const lines = log ? log.text.split(/\r?\n/).filter(Boolean) : [];
  const lastLine = lines.length ? lines[lines.length - 1].slice(0, 200) : null;
  const fresh = logAgeMs !== null && logAgeMs <= CAMPUS_STALE_MS;
  const disabled = task.ok && task.taskState ? /^(disabled|已禁用)$/i.test(task.taskState) : false;
  return {
    alive: fresh && !disabled,
    logAgeMs,
    staleMs: CAMPUS_STALE_MS,
    lastLine,
    task,
  };
}

function phoneBridgeSnapshot(alive) {
  const up = readTextSafe(PHONE_UPSTREAM_FILE, 4096);
  const wd = readTextSafe(PHONE_WATCHDOG_FILE, 4096);
  const upstream = up ? String(up.text).trim().split(/\r?\n/)[0] : null;
  let watchdogFails = null;
  let watchdogAt = null;
  if (wd) {
    const parts = String(wd.text).trim().split('|');
    const n = Number(parts[0]);
    if (Number.isFinite(n)) watchdogFails = n;
    if (parts[1]) watchdogAt = parts[1].trim();
  }
  return { alive, port: PHONE_BRIDGE_PORT, upstream, watchdogFails, watchdogAt };
}

/** 「今日」token：把 24h 的 30 分钟桶按本地零点切开求和（summary 的 totals 是累计值，不能用）。 */
function todayTokens(tokenLedger) {
  if (!tokenLedger || typeof tokenLedger.series !== 'function') return null;
  let series;
  try { series = tokenLedger.series({ hours: 24, maxBuckets: 48 }); } catch { return null; }
  const buckets = Array.isArray(series?.buckets) ? series.buckets : [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const from = start.getTime();
  const sum = { cacheMiss: 0, cacheHit: 0, output: 0, cost: 0, turns: 0, steps: 0, buckets: 0 };
  for (const b of buckets) {
    if (!b || Number(b.t) < from) continue;
    sum.buckets += 1;
    sum.cacheMiss += Number(b.cacheMiss) || 0;
    sum.cacheHit += Number(b.cacheHit) || 0;
    sum.output += Number(b.output) || 0;
    sum.cost += Number(b.cost) || 0;
    sum.turns += Number(b.turns) || 0;
    sum.steps += Number(b.steps) || 0;
  }
  const hitDenom = sum.cacheHit + sum.cacheMiss;
  return {
    ...sum,
    input: sum.cacheHit + sum.cacheMiss,
    cacheHitRate: hitDenom > 0 ? sum.cacheHit / hitDenom : null,
    since: from,
    ledgerCovered: series?.countedSamples ?? null,
  };
}

async function build({ port = 0, tokenLedger = null } = {}) {
  const [snowlumaTcp, phoneTcp] = await Promise.all([
    probeTcp(SNOWLUMA_HTTP_PORT),
    probeTcp(PHONE_BRIDGE_PORT),
  ]);
  const mem = process.memoryUsage();
  return {
    ok: true,
    at: Date.now(),
    services: {
      qqbridge: {
        alive: true,
        pid: process.pid,
        port: port || null,
        uptimeMs: Math.round(process.uptime() * 1000),
        rssMb: Math.round((mem.rss / 1048576) * 10) / 10,
        node: process.version,
      },
      qqbot: {
        alive: snowlumaTcp,
        httpPort: SNOWLUMA_HTTP_PORT,
        wsPort: 3001,
      },
      phoneBridge: phoneBridgeSnapshot(phoneTcp),
      campusNet: campusSnapshot(),
    },
    today: {
      tokens: todayTokens(tokenLedger),
      qq: countActivityToday(),
      reminders: readReminders(),
    },
  };
}

let cacheAt = 0;
let cacheValue = null;
let inflight = null;

/**
 * 返回只读快照（12 秒缓存 + 并发合并）。
 * @param {{ port?: number, tokenLedger?: any }} options
 */
export async function dashboardSnapshot(options = {}) {
  const now = Date.now();
  if (cacheValue && now - cacheAt < CACHE_MS) {
    return { ...cacheValue, cachedMs: now - cacheAt };
  }
  if (inflight) {
    await inflight.catch(() => null);
    if (cacheValue) return { ...cacheValue, cachedMs: Math.max(0, Date.now() - cacheAt) };
  }
  const p = build(options).then((value) => {
    cacheValue = value;
    cacheAt = Date.now();
    return value;
  });
  inflight = p;
  try {
    return await p;
  } finally {
    inflight = null;
  }
}
