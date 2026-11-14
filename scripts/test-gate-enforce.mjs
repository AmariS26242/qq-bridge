#!/usr/bin/env node
/**
 * gate-enforce.mjs 的测试。
 *
 * 为什么必须测它：这道闸门是翻 enforce 前唯一的安全网。它自己写错时的样子不是报错，
 * 而是「永远 PASS」——最危险的那种失败。这里既测判据函数，也用临时 state 目录把
 * 脚本整体跑一遍，确保「影子期真退役过」能被抓出来。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { retireActions } from './gate-enforce.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'gate-enforce.mjs');

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

console.log('retireActions 判据');
check('影子模式那行不算退役', () => {
  const log = '[handoff] 交接已写入 X\n[handoff] shadow 模式：只记录，不退役会话 (X)';
  assert.equal(retireActions(log).length, 0);
});
check('真实退役行能被挑出来', () => {
  const log = '[handoff] 交接成功，已退役旧会话 (private:1)';
  assert.equal(retireActions(log).length, 1);
});
check('影子行与退役行混在一起时只数退役', () => {
  const log = [
    '[handoff] shadow 模式：只记录，不退役会话 (a)',
    '[handoff] 交接成功，已退役旧会话 (b)',
    '[handoff] shadow 模式：只记录，不退役会话 (c)'
  ].join('\n');
  assert.equal(retireActions(log).length, 1);
});
check('只有 [budget] 行时不算退役（旧判据在这里恒 PASS）', () => {
  const log = '[budget] 上下文 354.6K（soft） key=private:1\n[budget] 交接已完成 key=private:1';
  assert.equal(retireActions(log).length, 0);
});
check('空输入不抛', () => {
  assert.equal(retireActions('').length, 0);
  assert.equal(retireActions(undefined).length, 0);
});

/** 造一个临时 root：state/ 下放标记、日志、备份，可选放交接样本。 */
function makeRoot({ hoursOld = 25, log = '', archive = true, handoff = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-enforce-'));
  const state = path.join(root, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(
    path.join(state, 'c2-shadow-start.json'),
    JSON.stringify({ startedAt: Date.now() - hoursOld * 3_600_000 }),
    'utf8'
  );
  fs.writeFileSync(path.join(state, 'bridge.log'), log, 'utf8');
  if (archive) {
    fs.mkdirSync(path.join(state, 'archive'), { recursive: true });
    fs.writeFileSync(path.join(state, 'archive', 'sessions.json.x.bak'), '{}', 'utf8');
    fs.writeFileSync(path.join(state, 'archive', 'config.json.x.bak'), '{}', 'utf8');
  }
  if (handoff) {
    fs.mkdirSync(path.join(state, 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(state, 'handoff', 'private_1.json'), JSON.stringify(handoff), 'utf8');
  }
  return root;
}

function runGate(root) {
  const res = spawnSync(process.execPath, [SCRIPT, `--root=${root}`], { encoding: 'utf8' });
  return { code: res.status, text: `${res.stdout}${res.stderr}` };
}

const GOOD_LOG = '12:00:00 [budget] 上下文 354.6K（soft） key=private:1\n';

console.log('整体行为（临时 state 目录）');
check('全绿时退出码 0', () => {
  const root = makeRoot({ log: GOOD_LOG });
  const { code, text } = runGate(root);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(code, 0, text);
  assert.match(text, /PASS\s+影子期无退役动作/);
});
check('影子期出现过退役 → 退出码 1（旧版会误判 PASS）', () => {
  const root = makeRoot({
    log: `${GOOD_LOG}12:01:00 [handoff] 交接成功，已退役旧会话 (private:1)\n`
  });
  const { code, text } = runGate(root);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(code, 1, text);
  assert.match(text, /FAIL\s+影子期无退役动作/);
});
check('影子时长不足 → 退出码 1', () => {
  const root = makeRoot({ hoursOld: 3, log: GOOD_LOG });
  const { code, text } = runGate(root);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(code, 1, text);
  assert.match(text, /FAIL\s+影子满 24h/);
});
check('缺备份 → 退出码 1', () => {
  const root = makeRoot({ log: GOOD_LOG, archive: false });
  const { code, text } = runGate(root);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(code, 1, text);
  assert.match(text, /FAIL\s+sessions\.json 有备份/);
});
check('交接样本不合格 → 退出码 1', () => {
  const root = makeRoot({
    log: GOOD_LOG,
    handoff: { schemaVersion: 1, generatedAt: 1, topics: ['x'.repeat(80)], openLoops: [], peopleChange: [], insideJokes: [], mood: '' }
  });
  const { code, text } = runGate(root);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(code, 1, text);
  assert.match(text, /FAIL\s+交接 payload 合格/);
});

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);
