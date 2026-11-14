#!/usr/bin/env node
/**
 * prep-enforce.mjs 测试：留底 → 翻闸 → 核对，用临时 state 目录造一次「翻对了」和「翻错了」。
 *
 * 这个脚本只在翻闸那一刻用一次，正因如此它必须是对的 —— 验证它最便宜的办法是
 * 造假 state：先跑 prep 留底，再改文件模拟轮换，然后看 --verify 是否按预期通过/报警。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { snapshot, verify } from './prep-enforce.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'prep-enforce.mjs');
const runPrep = (dir) => spawnSync(process.execPath, [SCRIPT, '--state', dir], { encoding: 'utf8' });

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

function makeState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-enforce-'));
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ sessions: { 'private:1': {} }, sessionPolicies: {} }), 'utf8');
  const v2 = {
    conversations: {
      'private:1': {
        unread: [{ seq: 1 }, { seq: 2 }],
        lastUnreadSeq: 2,
        lastReadThroughSeq: 0,
        recentMessages: [{ text: 'a' }],
        agentToken: 'token-old'
      }
    }
  };
  fs.writeFileSync(path.join(dir, 'social-v2.json'), JSON.stringify(v2, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ contextBudget: { mode: 'shadow' } }), 'utf8');
  fs.writeFileSync(path.join(dir, 'bridge.log'), '14:00:00 [bridge] hello\n', 'utf8');
  return dir;
}

function captureVerify(dir) {
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const code = verify(dir, path.join(dir, 'bridge.log'));
    return { code, text: logs.join('\n') };
  } finally {
    console.log = orig;
  }
}

console.log('快照');
const dir = makeState();
check('snapshot 抽出未读/水位/token 摘要', () => {
  const s = snapshot(dir);
  assert.deepEqual(s.sessionIds, ['private:1']);
  assert.equal(s.conversations['private:1'].unread, 2);
  assert.equal(s.conversations['private:1'].lastUnreadSeq, 2);
  assert.notEqual(s.conversations['private:1'].agentToken, 'token-old');
});

console.log('留底');
check('prep 写基线 + 三个备份', () => {
  const res = runPrep(dir);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const baseline = JSON.parse(fs.readFileSync(path.join(dir, 'enforce-baseline.json'), 'utf8'));
  assert.equal(baseline.sessionIds.length, 1);
  const archive = fs.readdirSync(path.join(dir, 'archive'));
  assert.ok(archive.filter((f) => f.endsWith('-pre-enforce.bak')).length >= 2, `备份不足：${archive.join(',')}`);
});

console.log('翻错了：未读被清空');
const dir2 = makeState();
// 先留底，再模拟「退役时把未读清了」这种事故。
{
  runPrep(dir2);
  const v2 = JSON.parse(fs.readFileSync(path.join(dir2, 'social-v2.json'), 'utf8'));
  v2.conversations['private:1'].unread = [];
  v2.conversations['private:1'].agentToken = 'token-new';
  fs.writeFileSync(path.join(dir2, 'social-v2.json'), JSON.stringify(v2), 'utf8');
  fs.writeFileSync(path.join(dir2, 'sessions.json'), JSON.stringify({ sessions: { 'private:2': {} }, sessionPolicies: {} }), 'utf8');
  fs.mkdirSync(path.join(dir2, 'handoff'), { recursive: true });
  fs.writeFileSync(path.join(dir2, 'handoff', 'private_1.json'), JSON.stringify({ schemaVersion: 1, generatedAt: 1750000000000, topics: ['话题'], openLoops: [], peopleChange: [], insideJokes: [], mood: '' }), 'utf8');
  fs.writeFileSync(path.join(dir2, 'bridge.log'), '14:10:00 [handoff] 交接已写入\n', 'utf8');
}
check('未读丢失会被报 FAIL', () => {
  const out = captureVerify(dir2);
  assert.equal(out.code, 1);
  assert.match(out.text, /FAIL\s+未读未丢失/);
  assert.match(out.text, /PASS\s+交接非空壳/);
});

console.log('翻对了：未读保留、会话轮换一次、交接非空壳');
const dir3 = makeState();
{
  runPrep(dir3);
  const v2 = JSON.parse(fs.readFileSync(path.join(dir3, 'social-v2.json'), 'utf8'));
  v2.conversations['private:1'].agentToken = 'token-new';
  fs.writeFileSync(path.join(dir3, 'social-v2.json'), JSON.stringify(v2), 'utf8');
  fs.writeFileSync(path.join(dir3, 'sessions.json'), JSON.stringify({ sessions: { 'private:2': {} }, sessionPolicies: {} }), 'utf8');
  fs.mkdirSync(path.join(dir3, 'handoff'), { recursive: true });
  fs.writeFileSync(
    path.join(dir3, 'handoff', 'private_1.json'),
    JSON.stringify({ schemaVersion: 1, generatedAt: 1750000000123, topics: ['在聊：周末爬山'], openLoops: ['还没回他照片的事'], peopleChange: [], insideJokes: [], mood: '放松' }),
    'utf8'
  );
  fs.writeFileSync(path.join(dir3, 'bridge.log'), '14:20:00 [handoff] 交接已写入 private:1\n', 'utf8');
}
check('全部核对项 PASS，退出码 0', () => {
  const out = captureVerify(dir3);
  assert.equal(out.code, 0, out.text);
  assert.match(out.text, /PASS\s+未读未丢失/);
  assert.match(out.text, /PASS\s+会话轮换守恒/);
  assert.match(out.text, /PASS\s+agentToken 已轮换/);
  assert.match(out.text, /PASS\s+日志有交接记录/);
  assert.match(out.text, /5 项|6 项|7 项|8 项|9 项/);
});

check('交接空壳会被报 FAIL', () => {
  fs.writeFileSync(path.join(dir3, 'handoff', 'private_1.json'), JSON.stringify({ schemaVersion: 1, generatedAt: 1750000000123, topics: [], openLoops: [], peopleChange: [], insideJokes: [], mood: '' }), 'utf8');
  const out = captureVerify(dir3);
  assert.equal(out.code, 1);
  assert.match(out.text, /FAIL\s+交接非空壳/);
});

check('没有基线时先报「基线存在」FAIL 而不是崩', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-bare-'));
  const out = captureVerify(bare);
  assert.equal(out.code, 1);
  assert.match(out.text, /FAIL\s+基线存在/);
});


console.log('注入 id 与磁盘不同源 / 零轮换');
const dir4 = makeState();
{
  runPrep(dir4);
  const v2 = JSON.parse(fs.readFileSync(path.join(dir4, 'social-v2.json'), 'utf8'));
  v2.conversations['private:1'].handoffInjectedId = '111';
  v2.conversations['private:1'].handoffPendingId = '111';
  v2.conversations['private:1'].agentToken = 'token-new';
  fs.writeFileSync(path.join(dir4, 'social-v2.json'), JSON.stringify(v2), 'utf8');
  // 故意不碰 sessions.json：模拟「翻闸后还没有任何会话撞到硬线」的零轮换状态。
  fs.mkdirSync(path.join(dir4, 'handoff'), { recursive: true });
  fs.writeFileSync(
    path.join(dir4, 'handoff', 'private_1.json'),
    JSON.stringify({ schemaVersion: 1, generatedAt: 222, topics: ['在聊：吃饭'], openLoops: [], peopleChange: [], insideJokes: [], mood: '' }),
    'utf8'
  );
  fs.writeFileSync(path.join(dir4, 'bridge.log'), '14:30:00 [handoff] 交接已写入 private:1\n', 'utf8');
}
check('注入 id 与磁盘 generatedAt 不一致会被报 FAIL', () => {
  const out = captureVerify(dir4);
  assert.equal(out.code, 1, out.text);
  assert.match(out.text, /FAIL\s+交接注入未重复/);
  assert.match(out.text, /不同源/);
});
check('零轮换不再被判 FAIL（旧判据要求恰好 1 个）', () => {
  const out = captureVerify(dir4);
  assert.match(out.text, /PASS\s+会话轮换守恒/);
  assert.match(out.text, /INFO\s+agentToken 已轮换/);
});
check('注入 id 对齐后整表通过，且说明已消费 1 份', () => {
  const v2 = JSON.parse(fs.readFileSync(path.join(dir4, 'social-v2.json'), 'utf8'));
  v2.conversations['private:1'].handoffInjectedId = '222';
  v2.conversations['private:1'].handoffPendingId = '222';
  fs.writeFileSync(path.join(dir4, 'social-v2.json'), JSON.stringify(v2), 'utf8');
  const out = captureVerify(dir4);
  assert.equal(out.code, 0, out.text);
  assert.match(out.text, /PASS\s+交接注入未重复/);
  assert.match(out.text, /已消费 1 份/);
});

for (const d of [dir, dir2, dir3, dir4]) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);
