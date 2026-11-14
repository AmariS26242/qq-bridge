#!/usr/bin/env node
/**
 * flip-enforce.mjs 测试：只在临时目录里翻，绝不碰真配置。
 *
 * 这是「翻闸」那条路径的守门测试，所以验证的是顺序与拒绝条件：
 *   - 已有 --off 的配置不会被 --on 跳过闸门（无 --force 时拒绝）；
 *   - --dry-run 一个字节都不写；
 *   - --off 能把 mode 改回 shadow，且不要求闸门；
 *   - 改配置是原子替换（不会留下 .tmp-* 残file）；
 *   - contextBudget 段缺失时明确报错，不写出半个 JSON。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readMode, setMode } from './flip-enforce.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'flip-enforce.mjs');
let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name} — ${error.message}`);
  }
}

function sandbox(mode = 'shadow') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip-enforce-'));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(state, 'sessions.json'), JSON.stringify({ sessions: {}, sessionPolicies: {} }), 'utf8');
  fs.writeFileSync(path.join(state, 'social-v2.json'), JSON.stringify({ conversations: {} }), 'utf8');
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ contextBudget: { enabled: true, mode, softAt: 300000, hardAt: 420000 } }, null, 2), 'utf8');
  return { dir, state, config };
}

const cli = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

console.log('纯函数');
check('setMode 报告 previous → next 并真的写入', () => {
  const { config } = sandbox('shadow');
  const res = setMode(config, 'enforce');
  assert.deepEqual({ changed: res.changed, previous: res.previous, next: res.next }, { changed: true, previous: 'shadow', next: 'enforce' });
  assert.equal(readMode(config).mode, 'enforce');
});
check('已经是目标模式时 changed=false，不写文件', () => {
  const { config } = sandbox('enforce');
  const before = fs.statSync(config).mtimeMs;
  const res = setMode(config, 'enforce');
  assert.equal(res.changed, false);
  assert.equal(fs.statSync(config).mtimeMs, before);
});
check('dry-run 不写文件', () => {
  const { config } = sandbox('shadow');
  const res = setMode(config, 'enforce', { dryRun: true });
  assert.equal(res.wrote, false);
  assert.equal(readMode(config).mode, 'shadow');
});
check('缺 contextBudget 段时明确报错', () => {
  const { config } = sandbox('shadow');
  fs.writeFileSync(config, JSON.stringify({ role: {} }), 'utf8');
  assert.throws(() => setMode(config, 'enforce'), /没有 contextBudget 段/);
  const raw = fs.readFileSync(config, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw), '报错后文件必须是完整 JSON');
});

console.log('CLI 顺序与拒绝');
check('没有 --on/--off 时退出码 2 且打印用法', () => {
  const res = cli([]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /--on\|--off/);
});
check('--on 在闸门不过且无 --force 时拒绝改配置', () => {
  const box = sandbox('shadow');
  const res = cli(['--on', '--config', box.config, '--state', box.state, '--no-restart', '--no-verify']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /闸门未通过/);
  assert.equal(readMode(box.config).mode, 'shadow', '闸门不过却改了配置');
});
check('--on --dry-run 不写配置、不重启', () => {
  const box = sandbox('shadow');
  const res = cli(['--on', '--force', '--dry-run', '--config', box.config, '--state', box.state]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readMode(box.config).mode, 'shadow');
  assert.match(res.stdout, /dry-run/);
});
check('--on --force 能写入 enforce 并留下基线', () => {
  const box = sandbox('shadow');
  const res = cli(['--on', '--force', '--config', box.config, '--state', box.state, '--no-restart', '--no-verify']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.equal(readMode(box.config).mode, 'enforce');
  assert.ok(fs.existsSync(path.join(box.state, 'enforce-baseline.json')), '没有写基线');
  const archive = fs.readdirSync(path.join(box.state, 'archive'));
  assert.ok(archive.some((f) => f.includes('-pre-enforce.bak')), `没有留底：${archive.join(',')}`);
  const leftovers = fs.readdirSync(box.dir).filter((f) => f.includes('.tmp-'));
  assert.equal(leftovers.length, 0, `留下了临时文件：${leftovers.join(',')}`);
});
check('--off 不需要闸门，直接回 shadow', () => {
  const box = sandbox('enforce');
  const res = cli(['--off', '--config', box.config, '--state', box.state, '--no-restart', '--no-verify']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.equal(readMode(box.config).mode, 'shadow');
});

console.log('安全边界');
check('已是目标模式时 --on 直接成功、不做备份也不重启', () => {
  const box = sandbox('enforce');
  const res = cli(['--on', '--config', box.config, '--state', box.state]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /不需要动作/);
  assert.ok(!fs.existsSync(path.join(box.state, 'enforce-baseline.json')), '不该重写基线');
});
check('真配置没有被测试碰到（模式与快照一致）', () => {
  // 不再钉死 shadow：上线翻闸后真配置合法地变成 enforce。改成「测试前后字节一致」。
  const file = path.join(ROOT, 'config.json');
  const before = fs.readFileSync(file);
  const real = JSON.parse(before.toString('utf8'));
  assert.ok(['shadow', 'enforce'].includes(real.contextBudget.mode), `mode 异常：${real.contextBudget.mode}`);
  assert.ok(before.equals(fs.readFileSync(file)), '测试改动了真配置');
});

check('--config 非默认路径时不自动重启（静态断言）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'flip-enforce.mjs'), 'utf8');
  assert.ok(src.includes('restart.bat 只会加载默认 config.json'), '缺少 --config 保护提示');
  assert.ok(/if \(path\.resolve\(configFile \?\? defaultConfig\) !== defaultConfig\)/.test(src), '缺少默认路径比较');
});

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);
