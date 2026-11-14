#!/usr/bin/env node
/**
 * 磁盘卫生：`node scripts/clean-state.mjs` 只看，`--apply` 才真删。
 *
 * 默认干的活永远是「出清单」，真删必须显式带 --apply —— 这条规矩写在这里，也写在
 * 项目计划 ② 里。删之前再做一次判定（拿 action.tier 和现行规则对一遍），避免
 * 「计划时是垃圾、执行时被改成必需」这种自摆乌龙。
 *
 * 输出：人看的清单（stderr/stdout 合并即可）+ `--json` 给机器；
 * 状态写 `state/clean-state.json`（简报读它），日志追加 `state/clean-state.log`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLEAN_DEFAULTS,
  normalizeCleanConfig,
  classifyFile,
  isExpired,
  planClean,
  formatBytes,
  formatDryList,
} from '../src/clean-state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_DIR = path.join(ROOT, 'state');
const REPORT_PATH = path.join(STATE_DIR, 'clean-state.json');
const LOG_PATH = path.join(STATE_DIR, 'clean-state.log');

/** 每次清理都绝不碰的：报告本身、备份/自检状态、令牌、记忆库元数据。 */
const NEVER = new Set([
  'clean-state.json',
  'backup.json',
  'doctor-report.json',
  'console-token',
  'minimax-key',
  'stickers.json',
  'social-v2.json',
  'social.json',
  'voice-usage.json',
  'daily-brief.json',
]);

function readJson(p, dflt) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return dflt;
  }
}

function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
}

function appendLog(line) {
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size > 512 * 1024) fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
  } catch {
    /* 文件还不存在 */
  }
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* 日志写不进去不该让清理失败 */
  }
}

/**
 * 递归列出 state 下的文件，路径统一成「相对项目根、正斜杠」的形式（`state/tmp/a.mp3`）。
 * 规则里写的就是这个形态（`state/*.json`），所以这里必须带上 `state/` 前缀 ——
 * 早一版漏了前缀，结果所有必需文件都被判成「没有规则命中」。
 */
function collectFiles(dir, { rel = '', out = [], prefix = '' } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const relPath = rel ? `${rel}/${e.name}` : `${prefix}${e.name}`;
    if (e.isDirectory()) {
      collectFiles(abs, { rel: relPath, out, prefix });
      continue;
    }
    if (!e.isFile()) continue;
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    out.push({ path: relPath, size: st.size, mtime: st.mtimeMs, abs });
  }
  return out;
}

function parseArgs(argv) {
  const args = { apply: false, json: false, verbose: false };
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a === '--dry') args.apply = false;
    else if (a === '--json') args.json = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function stateBytesOf(files) {
  return files.reduce((s, f) => s + (Number(f.size) || 0), 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/clean-state.mjs [--dry] [--apply] [--json] [--verbose]');
    console.log('  --dry    只出清单（默认）');
    console.log('  --apply  真删：垃圾看 cleanState.junkDays、缓存看 cleanState.cacheDays');
    return 0;
  }

  const rawConfig = readJson(CONFIG_PATH, {});
  const policy = normalizeCleanConfig(rawConfig.cleanState ?? CLEAN_DEFAULTS);
  if (!policy.enabled) {
    console.log('cleanState.enabled=false，跳过。');
    return 0;
  }

  const files = collectFiles(STATE_DIR, { prefix: 'state/' });
  const plan = planClean(files, policy, { now: Date.now() });

  // 兜底：config 里写坏成 `**` 这种也不许碰 NEVER 名单
  const guard = plan.actions.filter((a) => NEVER.has(path.posix.basename(a.path)));
  if (guard.length) {
    plan.actions = plan.actions.filter((a) => !NEVER.has(path.posix.basename(a.path)));
    plan.freedBytes = plan.actions.reduce((s, a) => s + a.size, 0);
    plan.actionCount = plan.actions.length;
    plan.guarded = guard.map((a) => a.path);
  }

  if (!args.apply) {
    if (args.json) {
      console.log(JSON.stringify({ mode: 'dry', policy: { junkDays: policy.junkDays, cacheDays: policy.cacheDays }, ...plan }, null, 2));
    } else {
      for (const line of formatDryList(plan)) console.log(line);
      console.log('（这是 dry run，什么都没删；确认后加 --apply）');
    }
    return 0;
  }

  // ---- apply：删之前按现行规则再判一次 ----
  const removed = [];
  const failed = [];
  for (const a of plan.actions) {
    const rel = String(a.path);
    const abs = path.resolve(ROOT, rel);
    const inside = abs.startsWith(STATE_DIR + path.sep);
    if (!inside || NEVER.has(path.posix.basename(rel))) {
      failed.push({ path: rel, error: 'out of scope' });
      continue;
    }
    const cls = classifyFile(rel, policy, { now: Date.now(), mtime: fs.existsSync(abs) ? fs.statSync(abs).mtimeMs : 0 });
    if (!isExpired(cls, policy)) {
      failed.push({ path: rel, error: 're-checked: no longer expired' });
      continue;
    }
    try {
      fs.unlinkSync(abs);
      removed.push({ path: rel, size: a.size, tier: a.tier });
    } catch (err) {
      failed.push({ path: rel, error: err?.code || err?.message || 'unknown' });
    }
  }
  // 顺手收掉被清空的目录（只收 state 内部、且深的先收）
  const prunedDirs = [];
  const dirs = [...new Set(removed.map((r) => path.dirname(path.resolve(ROOT, r.path))))]
    .filter((d) => d.startsWith(STATE_DIR + path.sep))
    .sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    try {
      if (fs.readdirSync(d).length === 0) {
        fs.rmdirSync(d);
        prunedDirs.push(path.relative(ROOT, d).replace(/\\/g, '/'));
      }
    } catch {
      /* 非空或没权限，留着无妨 */
    }
  }

  const freed = removed.reduce((s, r) => s + r.size, 0);
  const after = collectFiles(STATE_DIR, { prefix: 'state/' });
  const stateBytes = stateBytesOf(after);
  const report = {
    lastApplyAt: new Date().toISOString(),
    lastFreedBytes: freed,
    removedCount: removed.length,
    failedCount: failed.length,
    removed: removed.slice(0, 200),
    failed: failed.slice(0, 50),
    prunedDirs,
    stateBytes,
    fileCount: after.length,
    junkDays: policy.junkDays,
    cacheDays: policy.cacheDays,
  };
  writeJsonAtomic(REPORT_PATH, report);
  appendLog(
    `apply removed=${removed.length} freed=${formatBytes(freed)} failed=${failed.length} state=${formatBytes(stateBytes)}`
  );

  if (args.json) {
    console.log(JSON.stringify({ mode: 'apply', ...report }, null, 2));
  } else {
    console.log(`🗑 已清理 ${removed.length} 个文件 / ${formatBytes(freed)}（失败 ${failed.length}）`);
    if (args.verbose) {
      for (const r of removed) console.log(`   ${formatBytes(r.size).padStart(9)}  ${r.tier.padEnd(5)}  ${r.path}`);
      for (const f of failed) console.log(`   ✗ ${f.path}  ${f.error}`);
    }
    console.log(`state 现在 ${formatBytes(stateBytes)} / ${after.length} 个文件`);
  }
  return failed.length && !removed.length ? 2 : 0;
}

process.exit(main());
