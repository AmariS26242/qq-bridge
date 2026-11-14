// 服务健康探针：每 5 分钟追加一行到 state/health.jsonl（见 项目计划/07-候选项目清单.md ⑧）。
//
// 为什么是「每 5 分钟一行、单行 100 B 以内」：
//   * 288 行/天 ≈ 12 KB/天、一个季度 1 MB 出头，够便宜，不用数据库；
//   * 只记「在听/没在听」，不记延迟、不记 RSS —— 时序要的是可用率，不是监控大盘；
//   * 一行一个采样点，周报按区间切片就能算可用率，不依赖任何计数器状态。
//
// 和 daily-brief 的关系：简报读最近 24h 的抖动次数拼在服务行后缀上；探针本身不发送任何
// 消息、失败也不打扰任何人（它挂了由 doctor 的「健康」检查项和计划任务兜底）。
//
// 用法：
//   node scripts/health-probe.mjs            # 探一次并追加
//   node scripts/health-probe.mjs --dry      # 探一次只打印，不写文件
//   node scripts/health-probe.mjs --json     # 探完打印最近 24h 汇总（诊断用）
//   node scripts/health-probe.mjs --verbose  # 打印每次探测的明细
//   node scripts/health-probe.mjs --force    # 忽略 90 秒去抖（手工连跑调试用）
//
// 退出码：0 = 正常（含「刚探过、跳过」），2 = 探测或写文件失败。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeTcp, campusSnapshot } from '../src/dashboard.js';
import {
  serializeProbe,
  parseProbe,
  summarizeHealth,
  renderHealthBriefSuffix,
  formatDownWindows,
  linkState,
  HEALTH_SERVICES,
} from '../src/health.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const STATE_DIR = path.join(ROOT, 'state');
const HEALTH_FILE = path.join(STATE_DIR, 'health.jsonl');
const LOG_FILE = path.join(STATE_DIR, 'health-probe.log');
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB ≈ 170 天；超了轮转成 .1，只留一代
const DEDUPE_MS = 90 * 1000; // 计划任务每 5 分钟一次；手工连跑时别把同一分钟写两行
const HOUR = 3600_000;

function parseArgs(argv) {
  const out = { dry: false, json: false, verbose: false, force: false };
  for (const a of argv) {
    if (a === '--dry') out.dry = true;
    else if (a === '--json') out.json = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node scripts/health-probe.mjs [--dry] [--json] [--verbose] [--force]');
      process.exit(0);
    }
  }
  return out;
}

function appendLog(line) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
    const st = fs.statSync(LOG_FILE);
    if (st.size > 512 * 1024) fs.writeFileSync(LOG_FILE, `[${new Date().toISOString()}] log rotated\n`);
  } catch { /* 日志失败不影响探测结果 */ }
}

/** 读整个文件；坏行跳过。2 MB 以内同步读最省事。 */
function readEntries() {
  let text = '';
  try { text = fs.readFileSync(HEALTH_FILE, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const rec = parseProbe(line);
    if (rec) out.push(rec);
  }
  return out;
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(HEALTH_FILE);
    if (st.size <= MAX_FILE_BYTES) return false;
    const old = `${HEALTH_FILE}.1`;
    try { fs.rmSync(old, { force: true }); } catch {}
    fs.renameSync(HEALTH_FILE, old);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读桥接自己的 `/api/status`，判断 QQ 链路是不是真的通。
 *
 * 只探端口会把「进程活着但 WS 没连上」判成健康 —— 2026-10-24 的事故就是这样瞒了一小时。
 * 拿不到状态（令牌缺失/接口异常）时返回 null，调用方保持 TCP 结论，不伪造 down。
 */
async function fetchLinkStatus() {
  let token = '';
  try { token = fs.readFileSync(path.join(STATE_DIR, 'console-token'), 'utf8').trim(); } catch { return null; }
  try {
    const res = await fetch('http://127.0.0.1:3100/api/status', {
      headers: token ? { 'x-console-token': token } : {},
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** 三路 TCP + 校园网日志/任务 → 三态。校园网探不到时记 -1（unknown），不冒充 0。 */
async function probeAll() {
  const [q, b, p, status] = await Promise.all([
    probeTcp(3100).catch(() => null),
    probeTcp(3000).catch(() => null),
    probeTcp(8899).catch(() => null),
    fetchLinkStatus(),
  ]);
  let campus = -1;
  try {
    const snap = campusSnapshot();
    if (snap && typeof snap.alive === 'boolean') campus = snap.alive ? 1 : 0;
  } catch { campus = -1; }
  let qq = q === true ? 1 : q === false ? 0 : -1;
  // 端口通但 WS 没连上 = 收不到也发不出，按不可用记，别让简报继续报绿。
  const link = status ? linkState(status) : { state: 'unknown', reason: '读不到 /api/status' };
  if (qq === 1 && link.state === 'down') {
    qq = 0;
    appendLog(`link down: ${link.reason}`);
  }
  return {
    q: qq,
    b: b === true ? 1 : b === false ? 0 : -1,
    p: p === true ? 1 : p === false ? 0 : -1,
    c: campus,
    link,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now();
  const entries = readEntries();
  const last = entries[entries.length - 1] || null;

  if (!args.force && last && now - last.t < DEDUPE_MS) {
    appendLog(`skip dedupe last=${new Date(last.t).toISOString()} age=${Math.round((now - last.t) / 1000)}s`);
    if (args.json) console.log(JSON.stringify({ skipped: true, lastAt: last.t }, null, 2));
    return 0;
  }

  const states = await probeAll();
  const line = serializeProbe(states, now);
  const detail = HEALTH_SERVICES.map((s) => `${s.key}:${states[s.key]}`).join(' ')
    + (states.link.state !== 'up' ? ` link:${states.link.state}(${states.link.reason})` : ' link:up');

  if (args.verbose) console.log(`probe ${detail} bytes=${line.length}`);

  if (args.dry) {
    console.log(line);
    appendLog(`dry ${detail} bytes=${line.length}`);
    return 0;
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const rotated = rotateIfNeeded();
  fs.appendFileSync(HEALTH_FILE, `${line}\n`);

  const fresh = [...entries, parseProbe(line)].filter(Boolean);
  const day = summarizeHealth(fresh, { from: now - 24 * HOUR, to: now });
  const suffix = renderHealthBriefSuffix(day);
  appendLog(`probe ${detail} bytes=${line.length}${rotated ? ' rotated' : ''} 24h=${suffix || '无采样'}`);

  if (args.json) {
    console.log(JSON.stringify({
      at: new Date(now).toISOString(),
      line,
      bytes: line.length,
      rotated,
      link: states.link,
      day: {
        samples: day.samples,
        flaps: day.flaps,
        suffix,
        services: day.services.map((s) => ({ key: s.key, label: s.label, uptime: s.uptime, flaps: s.flaps, down: s.down, unknown: s.unknown, openNow: s.openNow })),
        windows: formatDownWindows(day, { limit: 10 }),
      },
    }, null, 2));
  }
  return 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  appendLog(`error ${String(error?.stack ?? error).slice(0, 500)}`);
  console.error(error);
  process.exitCode = 2;
});
