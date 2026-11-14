#!/usr/bin/env node
/**
 * C3 翻闸开关：一条命令完成「体检 → 留底 → 改 mode → 重启 → 核对」，回滚同样一条。
 *
 * 为什么不用手改 config.json：翻闸是这套优化里唯一「一步走错就丢上下文/丢未读」的动作，
 * 而它的步骤有四个（体检、备份、改键、重启），少做一步都不会立刻报错。把它做成命令，
 * 顺序固定、每一步都会说结果，回滚就是 `--off`。
 *
 * 用法：
 *   node scripts/flip-enforce.mjs --on              # 翻到 enforce（先过闸门，否则拒绝）
 *   node scripts/flip-enforce.mjs --on --dry-run    # 只打印将要做什么
 *   node scripts/flip-enforce.mjs --off             # 回滚到 shadow 并重启
 *   node scripts/flip-enforce.mjs --on --force      # 跳过闸门（仅用于演练/救急，会大声警告）
 *
 * 可选：`--config <file>`、`--state <dir>`、`--no-restart`（只改配置不重启）、`--no-verify`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const args = { mode: null, config: path.join(ROOT, 'config.json'), stateDir: path.join(ROOT, 'state'), restart: true, verify: true, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--on') args.mode = 'enforce';
    else if (a === '--off') args.mode = 'shadow';
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--no-restart') args.restart = false;
    else if (a === '--no-verify') args.verify = false;
    else if (a === '--config') args.config = path.resolve(argv[++i]);
    else if (a === '--state') args.stateDir = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') args.mode = 'help';
  }
  return args;
}

/** 读配置，先把「现在是什么模式」说清楚；没有 contextBudget 也不崩。 */
export function readMode(configFile) {
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  return { mode: cfg?.contextBudget?.mode ?? null, hasBudget: Boolean(cfg?.contextBudget) };
}

/**
 * 原子改 mode：先写临时文件再 rename。直接写原文件时如果进程被杀，
 * 会留下半个 JSON —— 下次启动 loadConfig 抛错，机器人起不来。
 */
export function setMode(configFile, mode, { dryRun = false } = {}) {
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (!cfg.contextBudget || typeof cfg.contextBudget !== 'object') {
    throw new Error('config.json 里没有 contextBudget 段，先按 §6.2 D-2 补上再翻闸');
  }
  if (cfg.contextBudget.mode === mode) return { changed: false, previous: mode };
  const previous = cfg.contextBudget.mode ?? null;
  if (dryRun) return { changed: true, previous, next: mode, wrote: false };
  const next = { ...cfg, contextBudget: { ...cfg.contextBudget, mode } };
  const tmp = `${configFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, configFile);
  return { changed: true, previous, next: mode, wrote: true };
}

function run(script, args = []) {
  const res = spawnSync(process.execPath, [path.join(HERE, script), ...args], { stdio: 'inherit' });
  return res.status ?? 1;
}

function restartBridge(configFile) {
  // restart.bat 拉起的 bridge 只会读 ROOT/config.json。用 --config 指到别处时重启
  // 会看起来成功、实际还是旧配置（翻闸静默不生效），所以直接拒绝自动重启。
  const defaultConfig = path.join(ROOT, 'config.json');
  if (path.resolve(configFile ?? defaultConfig) !== defaultConfig) {
    console.error('⚠️  --config 指向非默认配置文件，restart.bat 只会加载默认 config.json。');
    console.error('    已跳过自动重启：请改完配置后，用默认 config.json 手工重启一次。');
    return null;
  }
  // 一律走 restart.bat：它会先杀旧进程、确认真的退出了才删锁，再用隐藏窗口拉起守护。
  const res = spawnSync('cmd', ['/c', 'restart.bat < nul'], { cwd: ROOT, stdio: 'inherit' });
  return res.status ?? 1;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.mode || args.mode === 'help') {
    console.log('用法：node scripts/flip-enforce.mjs --on|--off [--dry-run] [--force] [--no-restart] [--no-verify]');
    return args.mode === 'help' ? 0 : 2;
  }
  const target = args.mode;
  const { mode: current } = readMode(args.config);
  console.log(`当前模式：${current ?? '（无 contextBudget.mode）'} → 目标：${target}${args.dryRun ? '（dry-run）' : ''}`);

  if (current === target) {
    console.log(`已经是 ${target}，不需要动作。`);
    return 0;
  }

  // 1) 翻到 enforce 前必须过闸门：六项里包含「影子满 24h」，这是唯一防「刚开影子就翻」的闸。
  if (target === 'enforce') {
    if (args.force) {
      console.log('⚠️  --force：跳过闸门检查（只在演练或救急时用，不要用在正式翻闸上）');
    } else {
      console.log('闸门检查（scripts/gate-enforce.mjs）：');
      // --state 指到别处时（测试/演练），闸门必须看同一个 state；否则会拿真仓库的
      // 健康状态给沙箱盖章：测试里「闸门不过应拒绝」会随真机转绿而失效。
      const gateArgs = args.stateDir === path.join(ROOT, 'state') ? [] : [`--root=${path.dirname(args.stateDir)}`];
      const gate = run('gate-enforce.mjs', gateArgs);
      if (gate !== 0) {
        console.error('\n闸门未通过，拒绝翻闸。确认要跳过请加 --force。');
        return 1;
      }
    }
    // 2) 留底：备份三个文件 + 写基线，翻后核对要用它。
    console.log('\n留底（scripts/prep-enforce.mjs）：');
    if (!args.dryRun && run('prep-enforce.mjs', ['--state', args.stateDir]) !== 0) {
      console.error('留底失败，拒绝继续。');
      return 1;
    }
  }

  // 3) 改配置
  const edit = setMode(args.config, target, { dryRun: args.dryRun });
  if (!edit.changed) {
    console.log('配置里已经是目标模式。');
  } else if (args.dryRun) {
    console.log(`[dry-run] 会把 contextBudget.mode: ${edit.previous} → ${edit.next}`);
  } else {
    console.log(`已写入 contextBudget.mode: ${edit.previous} → ${edit.next}（原子替换）`);
  }

  if (args.dryRun) {
    console.log('[dry-run] 之后会：restart.bat 重启守护' + (target === 'enforce' && args.verify ? '，再跑 prep-enforce.mjs --verify 核对' : ''));
    return 0;
  }

  // 4) 重启
  if (args.restart) {
    console.log('\n重启（restart.bat）：');
    const code = restartBridge(args.config);
    if (code === null) {
      console.log('跳过重启（--config 非默认路径）：配置已改，需手工重启生效。');
      return 0;
    }
    if (code !== 0) {
      console.error('重启失败。若刚翻到 enforce，请立刻用 `node scripts/flip-enforce.mjs --off` 回滚。');
      return 1;
    }
  } else {
    console.log('跳过重启（--no-restart）：配置已改，下次重启生效。');
  }

  // 5) 翻后核对（只在翻到 enforce 时有意义）
  if (target === 'enforce' && args.verify) {
    console.log('\n翻后核对（prep-enforce.mjs --verify）：');
    const code = run('prep-enforce.mjs', ['--verify', '--state', args.stateDir]);
    if (code !== 0) {
      console.error('\n核对未全过。若属真问题，立即回滚：node scripts/flip-enforce.mjs --off');
      return 1;
    }
  }
  console.log(`\n完成：contextBudget.mode = ${target}`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) process.exit(main(process.argv.slice(2)));
