#!/usr/bin/env node
// 代码保险箱：把「改坏了就回不去」的那部分文件打成一个 zip，落到三处盘。
//
// 为什么不是 git：qq-bridge 不是仓库，src/bridge.js 766 KB / 13 938 行是唯一副本。
// 为什么自己写 zip：换行/编码/中文名三个坑都实测过，详见 src/zip.mjs 顶部注释。
//
// 用法：
//   node scripts/backup.mjs               正常备份 + 清理旧包 + 到期就做恢复演练
//   node scripts/backup.mjs --dry         只统计将要打包什么，不写任何文件
//   node scripts/backup.mjs --no-prune    本次不删旧包
//   node scripts/backup.mjs --drill       强制做一次恢复演练
//   node scripts/backup.mjs --list        列出各目标的现有快照与占用
//   node scripts/backup.mjs --targets a,b 只写到指定目标（调试用）
//   node scripts/backup.mjs --note X      备注写进日志（人工手跑时用）
//
// 约定：
//   * 任一目标写失败不影响其它目标；全部失败才退出码 2。
//   * 打包失败（权限/磁盘满）不会留下半个 zip：先写 .part 再改名。
//   * 状态一律落 state/backup.json，简报只读这个文件，不去扫盘。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeBackupConfig,
  makeExcluder,
  makeIncluder,
  planPrune,
  parseSnapshotName,
  snapshotName,
  formatBytes,
  renderBackupBriefLine,
} from '../src/backup.mjs';
import { zipCreate, zipRead } from '../src/zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');                 // ...\qq-bridge
const WORKSPACE = path.join(ROOT, '..');            // ...\default-workspace
const STATE = path.join(ROOT, 'state');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const STATE_FILE = path.join(STATE, 'backup.json');
const LOG_FILE = path.join(STATE, 'backup.log');
const DRILL_LOG = path.join(STATE, 'backup-drill.log');
const LOG_MAX_BYTES = 512 * 1024;

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { dry: false, prune: true, drill: false, list: false, note: '', targets: null, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry') out.dry = true;
    else if (a === '--no-prune') out.prune = false;
    else if (a === '--drill') out.drill = true;
    else if (a === '--list') out.list = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--note') out.note = argv[++i] ?? '';
    else if (a === '--targets') {
      const raw = argv[++i] ?? '';
      out.targets = raw.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--help' || a === '-h') {
      console.log('用法: node scripts/backup.mjs [--dry] [--no-prune] [--drill] [--list] [--note X] [--targets a,b] [--verbose]');
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function appendLog(line) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* 日志写不进去不该让备份失败 */
  }
}

function appendDrillLog(line) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(DRILL_LOG, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* 同上 */
  }
}

/** 展开 `~` 与 `%VAR%`。任务计划里的环境变量不一定全，解析不了就原样保留。 */
function expandPath(input) {
  let p = String(input ?? '').trim();
  if (!p) return '';
  if (p === '~' || p.startsWith(`~${path.sep}`) || p.startsWith('~/')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  p = p.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole);
  return path.resolve(WORKSPACE, p);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function dirBytes(dir) {
  let total = 0;
  let count = 0;
  let names = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.zip$/i.test(name)) continue;
      try {
        total += fs.statSync(path.join(dir, name)).size;
        count += 1;
        names.push(name);
      } catch {
        /* 读不到就跳过 */
      }
    }
  } catch {
    return { total: 0, count: 0, names };
  }
  names = names.sort((a, b) => (parseSnapshotName(b)?.getTime() ?? 0) - (parseSnapshotName(a)?.getTime() ?? 0));
  return { total, count, names };
}

// ── 收集文件 ────────────────────────────────────────────────────────────────
/**
 * 按策略遍历全部源，返回要入包的文件清单。
 * 同一个 zip 内条目名必须唯一：用 source.label 做顶层前缀，冲突时补 -2。
 */
function collectFiles(cfg, log) {
  const exclude = makeExcluder(cfg.exclude);
  const files = [];
  const usedLabels = new Map();
  const seenNames = new Set();

  for (const source of cfg.sources) {
    const rootAbs = expandPath(source.root);
    if (!fs.existsSync(rootAbs)) {
      log(`跳过缺失的源 ${source.root}（${rootAbs}）`);
      continue;
    }
    let label = source.label || 'root';
    const bump = usedLabels.get(label) ?? 0;
    usedLabels.set(label, bump + 1);
    if (bump > 0) label = `${label}-${bump + 1}`;

    const include = makeIncluder(source.paths);
    const stack = ['.'];
    let added = 0;
    while (stack.length) {
      const rel = stack.pop();
      const abs = rel === '.' ? rootAbs : path.join(rootAbs, rel);
      let stat;
      try {
        stat = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;             // 不跟随软链，免得出循环
      const relPosix = rel === '.' ? '' : rel.split(path.sep).join('/');
      if (relPosix && exclude(relPosix)) continue;

      if (stat.isDirectory()) {
        let children = [];
        try {
          children = fs.readdirSync(abs);
        } catch {
          log(`读不了目录 ${abs}`);
          continue;
        }
        // include 的目录型模式（如 `src`）要让子项继续往下走；`*.py` 这种文件型模式不致于把目录判死。
        for (const child of children) stack.push(rel === '.' ? child : `${rel}${path.sep}${child}`);
        continue;
      }
      if (!stat.isFile()) continue;
      if (!include(relPosix || path.basename(abs))) continue;

      const entryName = `${label}/${relPosix || path.basename(abs)}`;
      if (seenNames.has(entryName)) continue;
      seenNames.add(entryName);
      files.push({ name: entryName, absPath: abs, rel: relPosix, size: stat.size, mtime: stat.mtime });
      added += 1;
    }
    log(`源 ${label}: ${added} 个文件 ← ${rootAbs}`);
  }
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ── 恢复演练 ────────────────────────────────────────────────────────────────
/**
 * 取最新一份快照，用 src/zip.mjs 解出来，跟当前文件逐字节比 hash。
 * 不用 Expand-Archive：演练要能在没有外部工具的环境里跑，且 zipRead 自带 CRC 校验。
 * 判据：所有条目都能解出来（CRC 全过）= 包没坏；抽样哈希一致数 > 0 = 内容对得上。
 */
function runDrill(cfg, snapshotDir, liveIndex, log) {
  const { names } = dirBytes(snapshotDir);
  if (!names.length) return { ok: false, detail: '没有可演练的快照', samples: 0, same: 0 };
  const target = names[0];
  const abs = path.join(snapshotDir, target);

  let entries;
  try {
    entries = zipRead(fs.readFileSync(abs));
  } catch (error) {
    const detail = `解包失败 ${target}: ${error?.message ?? error}`;
    appendDrillLog(`FAIL ${detail}`);
    return { ok: false, detail, samples: 0, same: 0 };
  }

  const sampleSize = Math.min(cfg.drill.sampleFiles, entries.length);
  const step = Math.max(1, Math.floor(entries.length / sampleSize));
  const sampled = entries.filter((_, i) => i % step === 0).slice(0, sampleSize);

  let same = 0;
  let changed = 0;
  let missing = 0;
  const changedNames = [];
  for (const entry of sampled) {
    const live = liveIndex.get(entry.name);
    if (!live) {
      missing += 1;
      continue;
    }
    let liveBuf;
    try {
      liveBuf = fs.readFileSync(live);
    } catch {
      missing += 1;
      continue;
    }
    if (sha256(liveBuf) === sha256(entry.data)) same += 1;
    else {
      changed += 1;
      if (changedNames.length < 5) changedNames.push(entry.name);
    }
  }

  const ok = same > 0;
  const detail = `${target} 条目 ${entries.length}（全部 CRC 通过）· 抽样 ${sampled.length}：一致 ${same} / 已改 ${changed} / 已不存在 ${missing}`;
  appendDrillLog(`${ok ? 'PASS' : 'FAIL'} ${detail}${changedNames.length ? ` · 变化示例 ${changedNames.join(', ')}` : ''}`);
  return { ok, detail, samples: sampled.length, same, changed, missing };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const config = readJson(CONFIG_FILE) || {};
  const cfg = normalizeBackupConfig(config.backup);
  const previous = readJson(STATE_FILE) || {};
  const log = (msg) => {
    if (args.verbose) console.log(`  · ${msg}`);
  };

  const targets = (args.targets ?? cfg.targets).map(expandPath).filter(Boolean);

  if (args.list) {
    for (const dir of targets) {
      const { total, count, names } = dirBytes(dir);
      console.log(`${dir}  ${count} 份 / ${formatBytes(total)}`);
      for (const name of names.slice(0, 12)) {
        const d = parseSnapshotName(name);
        console.log(`    ${name}  ${d ? d.toISOString().slice(0, 16).replace('T', ' ') : '?'}`);
      }
    }
    return 0;
  }

  if (!cfg.enabled) {
    console.log('skip: backup disabled');
    appendLog('skip: disabled');
    return 0;
  }

  const files = collectFiles(cfg, (m) => log(m));
  if (!files.length) {
    const msg = '没有任何文件被收录，检查 backup.sources / exclude';
    appendLog(`fail: ${msg}`);
    console.error(`fail: ${msg}`);
    return 2;
  }
  const sourceBytes = files.reduce((n, f) => n + f.size, 0);
  log(`共 ${files.length} 个文件 / ${formatBytes(sourceBytes)}`);

  const entries = files.map((f) => ({ name: f.name, data: fs.readFileSync(f.absPath), mtime: f.mtime }));
  const zipBuf = zipCreate(entries);
  const name = snapshotName(startedAt);
  log(`打好的包 ${name}：${formatBytes(zipBuf.length)}（源 ${formatBytes(sourceBytes)}）`);

  if (args.dry) {
    console.log('--- dry run ---');
    console.log(`将打包 ${files.length} 个文件，源 ${formatBytes(sourceBytes)} → zip ${formatBytes(zipBuf.length)}`);
    console.log(`文件名 ${name}`);
    for (const dir of targets) {
      const { count, total, names } = dirBytes(dir);
      const prune = planPrune([name, ...names], cfg.retention);
      console.log(`目标 ${dir}：现有 ${count} 份 / ${formatBytes(total)}${prune.length ? `，将删 ${prune.join(', ')}` : ''}`);
    }
    if (args.verbose) {
      const sample = files.slice(0, 12).map((f) => `${f.name} (${formatBytes(f.size)})`);
      console.log(`抽样：\n  ${sample.join('\n  ')}`);
    }
    appendLog(`dry files=${files.length} zip=${zipBuf.length} name=${name}`);
    return 0;
  }

  // 落盘：先写 .part 再改名，避免半截 zip 被当成可用备份。
  const results = [];
  for (const dir of targets) {
    const result = { path: dir, ok: false, error: null, written: false, bytes: 0, count: 0 };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const finalPath = path.join(dir, name);
      const partPath = `${finalPath}.part`;
      fs.writeFileSync(partPath, zipBuf);
      fs.renameSync(partPath, finalPath);
      result.written = true;
      result.ok = true;
    } catch (error) {
      result.error = `${error?.code ?? ''} ${error?.message ?? error}`.trim();
      appendLog(`目标失败 ${dir}: ${result.error}`);
    }
    results.push(result);
  }

  // 清理旧包（每个目标独立算，因为有的盘可能一开始就只有几份）。
  const pruned = [];
  for (const result of results) {
    if (!result.ok) continue;
    const { count, total, names } = dirBytes(result.path);
    result.count = count;
    result.bytes = total;
    if (!args.prune) continue;
    for (const victim of planPrune(names, cfg.retention)) {
      try {
        fs.unlinkSync(path.join(result.path, victim));
        pruned.push(`${result.path}\\${victim}`);
      } catch (error) {
        appendLog(`删不掉 ${victim}: ${error?.message ?? error}`);
      }
    }
  }

  const okTargets = results.filter((r) => r.ok);
  const totalBytes = results.reduce((n, r) => n + (r.ok ? r.bytes : 0), 0);
  const snapshotCount = results.reduce((n, r) => n + (r.ok ? r.count : 0), 0);
  const allFailed = okTargets.length === 0;

  // 恢复演练：到期或强制。用第一个成功目标的目录。
  let drill = previous.lastDrill ?? null;
  const drillDir = okTargets[0]?.path ?? null;
  const dueByAge = !previous.lastDrill?.at
    || (startedAt.getTime() - new Date(previous.lastDrill.at).getTime()) / 864e5 >= cfg.drill.everyDays;
  if (cfg.drill.enabled && drillDir && (args.drill || dueByAge)) {
    const liveIndex = new Map(files.map((f) => [f.name, f.absPath]));
    drill = { at: startedAt.toISOString(), ...runDrill(cfg, drillDir, liveIndex, log) };
    console.log(`drill: ${drill.ok ? 'PASS' : 'FAIL'} ${drill.detail}`);
  }

  const state = {
    lastRunAt: startedAt.toISOString(),
    lastOk: !allFailed && (!drill || drill.ok !== false),
    lastError: allFailed ? results.map((r) => `${r.path}: ${r.error}`).join(' | ') : null,
    zipName: name,
    fileCount: files.length,
    sourceBytes,
    zipBytes: zipBuf.length,
    snapshotCount,
    totalBytes,
    targets: results,
    prunedCount: pruned.length,
    note: args.note || null,
    lastDrill: drill,
  };
  writeJson(STATE_FILE, state);

  const summary = `files=${files.length} zip=${formatBytes(zipBuf.length)} targets=${okTargets.length}/${results.length} pruned=${pruned.length} total=${formatBytes(totalBytes)}`;
  appendLog(`${state.lastOk ? 'ok' : 'fail'} ${summary}${args.note ? ` note=${args.note}` : ''}`);
  console.log(`${state.lastOk ? 'ok' : 'fail'}: ${summary}`);
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.path} ${r.ok ? `${r.count} 份 / ${formatBytes(r.bytes)}` : r.error}`);
  }
  const briefLine = renderBackupBriefLine(state, { now: startedAt });
  if (briefLine) console.log(`简报行: ${briefLine}`);

  return state.lastOk ? 0 : 2;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    appendLog(`crash: ${error?.stack ?? error}`);
    console.error(`crash: ${error?.message ?? error}`);
    process.exit(2);
  });
