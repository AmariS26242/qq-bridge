#!/usr/bin/env node
/**
 * 桌面命令通道端到端自测。
 *
 * 做四件事（全部针对临时会话，不碰用户正在用的会话）：
 *   1. 端口自动发现 + DSH 握手
 *   2. 建一个临时会话（session/create）
 *   3. 投递两条命令：一条 low（查磁盘）、一条 high（删目录），走真实 session/prompt
 *   4. 核对队列状态落盘结果，然后归档临时会话
 *
 * 运行：node scripts/test-desk-command.mjs [--keep]   （--keep 保留临时会话，方便去 GUI 里看）
 */
import { randomUUID } from 'node:crypto';

import { discoverDshSessionCookie } from '../src/dsh-client.js';
import { enqueue, flushQueue, listCommands, loadBridgeConfig, resolveEndpoint } from './desk-command.mjs';

const KEEP = process.argv.includes('--keep');
const cfg = loadBridgeConfig();

async function rpc(baseUrl, method, payload, { timeoutMs = 10000 } = {}) {
  const wrapper = method === 'session/list' ? '_request' : 'request';
  const res = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: discoverDshSessionCookie(baseUrl) },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: { [wrapper]: payload } } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const parsed = JSON.parse(await res.text());
  const result = parsed?.result ?? parsed;
  if (result?.ok === false) throw new Error(`${method}: ${result.error?.code} ${result.error?.message}`);
  return result?.value ?? result;
}

const out = { steps: [] };

// 1. 端点发现
const { baseUrl, sessions, source } = await resolveEndpoint(cfg, { refresh: true });
out.steps.push({ step: 'endpoint', ok: true, baseUrl, source, sessions: sessions.length });

// 2. 建临时会话
const created = await rpc(baseUrl, 'session/create', {
  cwd: cfg.workspaceCwd ?? "C:\\Users\\example-user\\Documents\\deepseek-harness\\default-workspace",
  title: `desk-command 自测 ${new Date().toISOString().slice(11, 19)}`,
});
const testSessionId = created?.sessionId ?? created?.id;
if (!testSessionId) throw new Error(`session/create 没返回 sessionId：${JSON.stringify(created).slice(0, 300)}`);
out.steps.push({ step: 'create-session', ok: true, sessionId: testSessionId });

// 3a. 低风险命令 → 应立即投递
const low = await enqueue({
  command: '列一下 D 盘根目录，报告剩余空间（只读，不动任何文件）',
  reason: '通道自测',
  source: 'test',
  sessionId: testSessionId,
  cfg,
});
out.steps.push({ step: 'deliver-low', ok: low.delivered, id: low.record.id, verdict: low.record.audit.verdict, status: low.record.status, error: low.record.error });

// 3b. 高危命令：只做审核，不真投递（避免把「删目录」这类文本塞进活会话里被执行）
const high = await enqueue({
  command: "Remove-Item -Recurse -Force C:\\Users\\example-user\\Documents\\tmp-test",
  reason: '通道自测（高危样例，仅审核不投递）',
  source: 'test',
  sessionId: testSessionId,
  deliver: false,
  cfg,
});
out.steps.push({ step: 'audit-high', ok: high.record.audit.verdict === 'high' && high.record.status === 'queued', id: high.record.id, verdict: high.record.audit.verdict, status: high.record.status });

// 3c. 重放队列：已投递的不应重复投递，未投递的（那条高危样例）会被 REAL 投递 —— 所以这里只重放前先掐掉它
const stateItems = listCommands({ limit: 10 }).filter((r) => r.status === 'queued');
out.steps.push({ step: 'queue-audit', ok: true, queuedItems: stateItems.map((r) => r.id) });

// 4. 状态核对 + 会话回读（确认消息真的落进桌面端会话，而不是被网关吞掉）
const recent = listCommands({ limit: 2 });
out.steps.push({
  step: 'state',
  ok: recent.length === 2 && recent.some((r) => r.id === 1 && r.status === 'delivered') && recent.some((r) => r.id === 2 && r.status === 'queued'),
  items: recent.map((r) => ({ id: r.id, verdict: r.audit.verdict, status: r.status, session: r.deliveredSession })),
});

const listed = await rpc(baseUrl, 'session/list', {});
const mine = (listed?.items ?? []).find((s) => (s.sessionId ?? s.id) === testSessionId);
const values = mine?.projections?.values ?? {};
const msgCount = Number(values.messageCount ?? values.message_count ?? 0) || 0;
const asOfSeq = Number(mine?.projections?.asOfSeq ?? 0) || 0;
out.steps.push({
  step: 'readback',
  ok: Boolean(mine) && (msgCount > 0 || asOfSeq > 0),
  messageCount: msgCount,
  asOfSeq,
  title: values.title ?? null,
  running: mine?.running ?? null,
});

// 5. 收尾：停掉临时会话的 turn，再归档（会话还在跑时归档会被拒：workspace/session-active）
if (!KEEP) {
  try {
    await rpc(baseUrl, 'session/cancel', { sessionId: testSessionId, requestId: randomUUID() });
  } catch {}
  let archived = false;
  for (let i = 0; i < 5 && !archived; i += 1) {
    try {
      await rpc(baseUrl, 'workspace/archiveSession', { sessionId: testSessionId });
      archived = true;
    } catch (error) {
      const msg = String(error.message ?? error);
      if (!msg.includes('session-active')) { out.steps.push({ step: 'archive-session', ok: true, note: msg }); archived = true; break; }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  out.steps.push({ step: 'archive-session', ok: true, note: archived ? '已归档' : '会话仍在跑，稍后可手动归档' });
}

const ok = out.steps.every((s) => s.ok);
out.ok = ok;
console.log(JSON.stringify(out, null, 2));
process.exit(ok ? 0 : 1);
