#!/usr/bin/env node
/**
 * 端到端验证：DSH 的 LLM 请求是否真的走了本地采样代理，并且回合能正常产出回复。
 *
 * 做法：用桥接自己的 DSH 客户端建一个临时会话，发一句「只回好」，同时监听事件流，
 * 确认 ①采样代理日志里出现 `POST /v1/messages → 200 [T=… top_p=… thinking=off]`
 * ②这个回合拿到了正常的 assistant 文本（thinking 被关掉后没把回复弄坏）。
 * 临时会话结束后归档。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, discoverDshLaunchToken, createTurnCollector } from '../src/dsh-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const LOG = path.join(ROOT, '..', 'qqbot', 'logs', 'sampling-proxy.log');

function tokenFromDshLog() {
  const logFile = path.join(ROOT, '..', 'qqbot', 'logs', 'dsh.log');
  if (!fs.existsSync(logFile)) return '';
  const text = fs.readFileSync(logFile, 'utf8');
  const matches = [...text.matchAll(/[?&]token=([A-Za-z0-9_-]{20,})/g)];
  return matches.length ? matches[matches.length - 1][1] : '';
}

const base = cfg.dsh.baseUrl;
const token = cfg.dsh.authToken || (() => { try { return discoverDshLaunchToken(base); } catch { return ''; } })() || tokenFromDshLog();
if (!token) {
  console.error('拿不到 DSH launch token，放弃');
  process.exit(2);
}
const api = new NodeApiClient(base, undefined, {
  token,
  header: cfg.dsh.authHeader || 'authorization',
  prefix: cfg.dsh.authPrefix || 'Bearer',
});

// 用「匹配行数量」而不是字节偏移做基线：日志里有中文，按字节 slice 会切错位置
const hitLines = () => {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => /POST \/v1\/messages → 200/.test(l));
};
const before = hitLines().length;

const wsDir = path.join(ROOT, 'state', 'tmp-sampling-check');
fs.mkdirSync(wsDir, { recursive: true });
const ws = unwrap(await api.workspace.create({ path: wsDir }), 'workspace.create');
const session = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId }), 'session.create');
const sid = session.sessionId;
console.log(`临时会话 ${sid}`);

// 开一条事件流，收集本回合的 assistant 文本
const collector = createTurnCollector();
const abort = new AbortController();
let turnResult = null;
const pump = (async () => {
  try {
    for await (const envelope of api.events.mux({}, abort.signal)) {
      const frame = envelope?.payload;
      if (frame?.type !== 'session/event' || frame.sessionId !== sid) continue;
      const ended = collector.push(frame.event);
      if (ended) { turnResult = ended; break; }
    }
  } catch (error) {
    if (!abort.signal.aborted) console.log('事件流中断:', error?.message ?? error);
  }
})();
api.events.follow(sid);
// 等事件流真正订阅上再发 prompt，否则 turn/start 可能在订阅前就发出去了（本脚本踩过这个坑）
await new Promise((r) => setTimeout(r, 1500));

const accepted = await api.sessions.prompt({
  sessionId: sid,
  mode: 'queue',
  content: [{ type: 'text', text: '只回一个字：好。不要调用任何工具，不要解释。' }],
});
console.log('prompt accepted:', accepted?.ok ?? JSON.stringify(accepted ?? null));

const deadline = Date.now() + 90_000;
let proxyHit = '';
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  const lines = hitLines();
  if (lines.length > before) proxyHit = lines[lines.length - 1].trim();
  if (proxyHit && turnResult) break;
}

abort.abort();
await pump.catch(() => {});
try { await api.workspace.archiveSession({ sessionId: sid }); } catch (e) { console.log('归档临时会话失败（可忽略）:', e?.message ?? e); }

console.log('---');
console.log('代理日志:', proxyHit || '（没抓到 200 行）');
console.log('回合回复:', turnResult?.text ?? '（回合没有在 90 秒内结束）');

if (!proxyHit) {
  console.error('❌ DSH 的 LLM 请求没走代理（或上游失败），检查 sampling.enabled 与 DEEPSEEK_BASE_URL');
  process.exit(1);
}
if (!turnResult) {
  console.error('❌ 代理通了但回合没结束，可能 thinking 被关掉后 DSH 解析失败，看 qqbot/logs/dsh.log');
  process.exit(1);
}
console.log('✅ DSH 经代理请求成功，且回合正常产出文本');
