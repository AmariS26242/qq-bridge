#!/usr/bin/env node
/**
 * 交接摘要「只注入一次」的测试（O1 enforce）。
 *
 * 背景：enforce 进入后，新会话每次唤醒都会调 formatHandoffLineV2()。
 * 如果它不看「这份交接注入过没有」，同一行 【上次交接】… 会在每一轮唤醒里重复出现，
 * 新会话就一直以为「刚被交接过来」，而且每轮白付几十个字符。
 *
 * 这里测两层：
 *  1. handoffInjectionDecision() 的判定矩阵；
 *  2. 用同一套判定模拟「唤醒三次」，确认只有第一次真的注入（状态机层面的行为）。
 *  3. 静态断言 bridge.js 真的接上了这套判定（防止以后重构时接线被冲掉）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandoffStore, handoffInjectionDecision } from '../src/handoff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;

function ok(cond, name, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('handoffInjectionDecision 判定矩阵');
ok(handoffInjectionDecision({ mode: 'shadow', pendingId: 'A', injectedId: '' }) === 'skip-mode',
  '影子模式不注入');
ok(handoffInjectionDecision({ mode: 'off', pendingId: 'A', injectedId: '' }) === 'skip-mode',
  '关闭时也不注入');
ok(handoffInjectionDecision({ mode: 'enforce', pendingId: '', injectedId: '' }) === 'skip-none',
  '没有待注入的交接 → skip-none');
ok(handoffInjectionDecision({ mode: 'enforce', pendingId: 'A', injectedId: '' }) === 'inject',
  '有待注入且没注入过 → inject');
ok(handoffInjectionDecision({ mode: 'enforce', pendingId: 'A', injectedId: 'A' }) === 'skip-consumed',
  '同一份已注入过 → skip-consumed');
ok(handoffInjectionDecision({ mode: 'enforce', pendingId: 'B', injectedId: 'A' }) === 'inject',
  '换了一份新交接 → 再注入一次');
ok(handoffInjectionDecision({ mode: 'enforce', preview: true, pendingId: 'A', injectedId: 'A' }) === 'inject',
  '预览不消耗：即使已注入也要能看见');
ok(handoffInjectionDecision({ mode: 'enforce', pendingId: '  A  ', injectedId: 'A' }) === 'skip-consumed',
  '两侧 id 都 trim 后比较');
ok(handoffInjectionDecision({}) === 'skip-mode', '空参数按关闭处理，不抛异常');

console.log('状态机：同一份交接只注入一次');
{
  // 模拟 bridge.js 里的状态：handoffPendingId 写入时设置，handoffInjectedId 注入后设置。
  const st = { handoffPendingId: '', handoffInjectedId: '' };
  const wake = (preview = false) => handoffInjectionDecision({
    mode: 'enforce',
    preview,
    pendingId: st.handoffPendingId,
    injectedId: st.handoffInjectedId
  });
  ok(wake() === 'skip-none', '交接发生前：不注入');
  st.handoffPendingId = '1750000000000';
  ok(wake() === 'inject', '交接后的第一次唤醒：注入');
  if (wake() === 'inject') st.handoffInjectedId = st.handoffPendingId; // 模拟 formatHandoffLineV2 的落账
  ok(wake() === 'skip-consumed', '第二次唤醒：不重复注入');
  ok(wake() === 'skip-consumed', '第三次唤醒：仍不重复注入');
  ok(wake(true) === 'inject', '中途预览一次：仍能看见（且不改变已注入状态）');
  st.handoffPendingId = '1750000009999';
  ok(wake() === 'inject', '下一份新交接到来：重新注入一次');
}

console.log('写入时刻与磁盘 id 必须一致（否则重启后会重复注入一次）');
{
  // 这是真实踩过的坑：store 内部自己取 Date.now() 当 generatedAt，
  // bridge 写完再取一次 Date.now() 当 lastHandoffAt —— 两者差几毫秒。
  // 进程重启后回读磁盘拿到的是前者、持久化的 injectedId 是后者，对不上 → 再注入一次。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-id-'));
  try {
    const store = createHandoffStore({ dir: tmpDir });
    const at = 1750000000123;
    const payload = {
      activeTopics: ['在聊：周末去爬山'],
      pendingThoughts: [],
      memberImpressions: [],
      mood: ''
    };
    const w = store.write('private:u1', payload, { reason: 'context-budget', mode: 'enforce', generatedAt: at });
    ok(w.ok === true, '写入成功', String(w.reason));
    const got = store.read('private:u1');
    ok(got.ok === true && Number(got.meta?.generatedAt) === at,
      '磁盘上的 generatedAt 等于调用方给的写入时刻', String(got.meta?.generatedAt));
    ok(handoffInjectionDecision({
      mode: 'enforce',
      pendingId: String(got.meta?.generatedAt),
      injectedId: String(at)
    }) === 'skip-consumed', '重启后回读磁盘：同一份交接判为已注入');
    ok(handoffInjectionDecision({
      mode: 'enforce',
      pendingId: String(at + 1),
      injectedId: String(at)
    }) === 'inject', '两处 id 差 1 毫秒（旧写法）：会被当成新交接再注入一次');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log('静态接线断言（bridge.js）');
{
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  ok(bridge.includes('handoffInjectionDecision,'), 'import 列表里有 handoffInjectionDecision');
  ok(bridge.includes('handoffPendingId: \'\','), '状态默认值有 handoffPendingId');
  ok(bridge.includes('handoffInjectedId: \'\','), '状态默认值有 handoffInjectedId');
  ok(bridge.includes('const handoffAt = Date.now();'), '写入时刻只取一次');
  ok(bridge.includes('generatedAt: handoffAt'), '把同一个时刻发给 store（磁盘 id）');
  ok(bridge.includes('st.handoffPendingId = String(handoffAt);'), '写入成功后记录 pendingId（与磁盘 id 同值）');
  ok(bridge.includes('st.handoffInjectedId = pendingId;'), '注入后记录 injectedId');
  ok(bridge.includes('formatHandoffLineV2(key, st, { preview })'), '唤醒提示把 preview 透传进来');
  ok(bridge.includes('if (decision !== \'inject\') return \'\';'), '判定不是 inject 时返回空串');
  ok(bridge.includes('if (payload && !pendingId && Number.isFinite(st?.lastHandoffAt))'), '旧状态只有 payload、没有 pendingId 时用 lastHandoffAt 兜底');
  // 落盘：这两个 id 不持久化的话，每次重启都会把「上次交接」再注入一遍。
  ok(bridge.includes('handoffPendingId: typeof st.handoffPendingId'), '保存 socialV2 时落盘 handoffPendingId');
  ok(bridge.includes('handoffInjectedId: typeof st.handoffInjectedId'), '保存 socialV2 时落盘 handoffInjectedId');
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);
