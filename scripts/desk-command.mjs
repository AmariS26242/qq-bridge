#!/usr/bin/env node
/**
 * 桌面命令通道：QQ 端 → 桌面端 DSH 会话。
 *
 * 流程：入队（落盘 + 静态审核）→ 作为一条排队消息投递进桌面端会话 → 桌面端 agent 按
 * 审核结论处理（high 先找用户确认）。投递失败就留在队列，下次 send/retry 会重投。
 *
 * 为什么不用 `src/dsh-client.js` 的 NodeApiClient：
 * 本脚本要同时在「bridge 进程内」和「沙箱里的 node 子进程」两种环境跑。实测后者
 * 看不到桌面端进程的 CommandLine/进程名（Get-CimInstance 只回同容器进程），但
 * `netstat -ano` 仍能列出全部监听端口，所以端口发现走 netstat + DSH 握手探测，
 * RPC 走原始 fetch（鉴权用现签浏览器 cookie）——两条路都不依赖进程枚举权限。
 *
 * CLI：
 *   node desk-command.mjs send --command "…" [--reason "…"] [--session <id>] [--dry-run]
 *   node desk-command.mjs list [--limit 20] | show <id> | retry | audit "…" | endpoint
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverDshSessionCookie } from '../src/dsh-client.js';
import { auditCommand } from './audit-desk-command.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'desk-commands.json');
const ENDPOINT_FILE = path.join(STATE_DIR, 'desk-endpoint.json');
const MAX_KEEP = 300;

/** RPC 参数包装名（见 src/dsh-client.js 的 METHOD_ARG_WRAPPERS）。 */
const ARG_WRAPPER = {
  'session/list': '_request',
  'session/prompt': 'request',
};

// ── 配置 / 状态 ─────────────────────────────────────────────────────────────

export function loadBridgeConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readState() {
  const parsed = readJson(STATE_FILE, null);
  return {
    nextId: Number(parsed?.nextId) || 1,
    items: Array.isArray(parsed?.items) ? parsed.items : [],
  };
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ nextId: state.nextId, items: state.items.slice(-MAX_KEEP) }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

// ── DSH RPC ─────────────────────────────────────────────────────────────────

async function rpc(baseUrl, method, payload, { timeoutMs = 4000, cookie } = {}) {
  const authCookie = cookie ?? discoverDshSessionCookie(baseUrl);
  // 线上协议（实测 desktop 0.1.x）：payload 必须恰好有一个 args 字段，
  // args 里再套该方法自己的参数包装名（session/list → _request，session/prompt → request）。
  // 直接把参数放 payload 顶层会拿到 "Remote payload must contain exactly one plain-object args field"。
  const wrapper = ARG_WRAPPER[method] ?? 'request';
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `qqdesk-${randomUUID()}`,
    method,
    payload: { args: { [wrapper]: payload } },
  });
  const res = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authCookie ? { cookie: authCookie } : {}) },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`不是 JSON：${text.slice(0, 160)}`); }
  if (parsed?.type === 'server-response-error') {
    throw new Error(`RPC 错误：${JSON.stringify(parsed.error ?? parsed.payload ?? {}).slice(0, 300)}`);
  }
  const result = parsed?.result ?? parsed?.payload?.result ?? parsed;
  if (result?.ok === false) throw new Error(`RPC 失败：${result.error?.code ?? ''} ${result.error?.message ?? ''}`.trim());
  return result?.value ?? result;
}

function normalizeSessions(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.sessions)) return value.sessions;
  if (Array.isArray(value?.items)) return value.items;
  return null;
}

// ── 端口发现 ────────────────────────────────────────────────────────────────

function listLoopbackListeningPorts(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const child = spawn('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve([]); }, timeoutMs);
    child.stdout.on('data', (c) => { out += String(c); });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.on('close', () => {
      clearTimeout(timer);
      const ports = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING/i);
        if (!m) continue;
        const addr = m[1];
        if (!/^(127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)$/.test(addr)) continue;
        const port = Number(m[2]);
        if (Number.isInteger(port) && port >= 1024) ports.add(port);
      }
      resolve([...ports]);
    });
  });
}

/** 对一个候选端口做 DSH 握手：能回 session/list 的值就是 DSH。 */
async function probeDsh(baseUrl) {
  try {
    const value = await rpc(baseUrl, 'session/list', {}, { timeoutMs: 1200 });
    const sessions = normalizeSessions(value);
    return sessions ? sessions : null;
  } catch {
    return null;
  }
}

/**
 * 找桌面端 DSH：
 * 1. config.desk.baseUrl（建议固定，最稳）
 * 2. state/desk-endpoint.json 缓存（上次探测成功且仍可用）
 * 3. netstat 扫回环监听端口 + DSH 握手（排除 config.dsh.baseUrl，那是 QQ 端自己的 DSH）
 */
export async function resolveEndpoint(cfg, { refresh = false } = {}) {
  const pinned = String(cfg?.desk?.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (pinned) {
    const sessions = await probeDsh(pinned);
    if (!sessions) throw new Error(`desk.baseUrl=${pinned} 连不上或不是 DSH（握手失败）`);
    return { baseUrl: pinned, sessions, source: 'config' };
  }

  const cached = readJson(ENDPOINT_FILE, null);
  if (!refresh && cached?.baseUrl) {
    const sessions = await probeDsh(cached.baseUrl);
    if (sessions) return { baseUrl: cached.baseUrl, sessions, source: 'cache' };
  }

  const ownPort = (() => {
    try { return new URL(String(cfg?.dsh?.baseUrl ?? '')).port; } catch { return ''; }
  })();
  const candidates = (await listLoopbackListeningPorts()).filter((p) => String(p) !== ownPort);
  for (const port of candidates) {
    const baseUrl = `http://127.0.0.1:${port}`;
    const sessions = await probeDsh(baseUrl);
    if (!sessions) continue;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(ENDPOINT_FILE, JSON.stringify({ baseUrl, at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
    return { baseUrl, sessions, source: 'scan' };
  }
  throw new Error('找不到桌面端 DSH（可在 qq-bridge/config.json 里固定 desk.baseUrl）');
}

// ── 目标会话 ────────────────────────────────────────────────────────────────

/**
 * 选目标会话：config.desk.sessionId 优先；否则取最近有活动的根会话。
 * 桌面端同时开着多个会话时，建议把 desk.sessionId 钉死，避免命令投错地方。
 */
export function pickSession(sessions, cfg) {
  const pinned = String(cfg?.desk?.sessionId ?? '').trim();
  const list = sessions ?? [];
  if (list.length === 0) throw new Error('桌面端没有任何会话，请先在 GUI 里开一个');
  if (pinned) {
    const hit = list.find((s) => (s.sessionId ?? s.id) === pinned);
    if (!hit) throw new Error(`desk.sessionId=${pinned} 不存在（现有 ${list.length} 个会话）`);
    return hit;
  }
  const roots = list.filter((s) => !s.parentSessionId && !s.parentSessionID);
  const pool = roots.length > 0 ? roots : list;
  const stamp = (s) => {
    const v = s.updatedAt ?? s.updated_at ?? s.createdAt ?? s.created_at ?? 0;
    if (typeof v === 'number') return v;
    return Date.parse(String(v)) || 0;
  };
  return pool.slice().sort((a, b) => stamp(b) - stamp(a))[0];
}

// ── 消息体 ──────────────────────────────────────────────────────────────────

function buildMessage(record) {
  const a = record.audit;
  const hitLines = a.hits.length === 0
    ? '  （无命中）'
    : a.hits.map((h) => `  - [${h.sev}] ${h.label}${h.match ? `：\`${h.match}\`` : ''}\n    ${h.note ?? ''}`).join('\n');
  const lines = [
    `【桌面命令 #${record.id} · 来自 ${record.source === 'qq' ? 'QQ 端' : record.source} · ${record.createdAt}】`,
    '',
    '命令原文：',
    record.command,
    '',
    `审核结论：${String(a.verdict).toUpperCase()}（风险分 ${a.score}）`,
    `命中要点：${a.summary}`,
    hitLines,
    '',
    `处置要求：${a.advice}`,
  ];
  if (record.reason) lines.push('', `附带说明：${record.reason}`);
  lines.push('', '（由 qq-bridge 的 desk-command 通道投递；审核是规则引擎自动跑的，只是闸门，不代替你的判断。）');
  return lines.join('\n');
}

// ── 入队 / 投递 ─────────────────────────────────────────────────────────────

export async function enqueue({ command, reason = '', source = 'qq', sessionId = '', deliver = true, cfg } = {}) {
  const config = cfg ?? loadBridgeConfig();
  const audit = auditCommand(command);
  const state = readState();
  const record = {
    id: state.nextId,
    createdAt: new Date().toISOString(),
    source,
    command: String(command ?? ''),
    reason: String(reason ?? ''),
    audit,
    status: 'queued',
    deliveredAt: null,
    deliveredSession: null,
    error: null,
  };
  state.nextId += 1;
  state.items.push(record);

  if (audit.verdict === 'high' && config?.desk?.blockHighRisk === true) {
    record.status = 'blocked';
    record.error = '审核结论 high，配置禁止自动投递高危命令';
  } else if (deliver) {
    Object.assign(record, await deliverRecord(record, { cfg: config, sessionId }));
  }
  writeState(state);
  return { record, delivered: record.status === 'delivered', blocked: record.status === 'blocked' };
}

async function deliverRecord(record, { cfg, sessionId = '' } = {}) {
  const config = cfg ?? loadBridgeConfig();
  try {
    if (config?.desk?.enabled === false) throw new Error('desk 通道已关闭（config.json desk.enabled=false）');
    const { baseUrl, sessions } = await resolveEndpoint(config, { refresh: true });
    const target = sessionId ? { sessionId } : pickSession(sessions, config);
    const targetId = target.sessionId ?? target.id;
    await rpc(baseUrl, 'session/prompt', {
      sessionId: targetId,
      mode: 'queue',
      // 新版 SessionPromptRequest 强制要求 requestId（缺了会报
      // `wire field "request" failed boundary validation`）。
      requestId: randomUUID(),
      content: [{ type: 'text', text: buildMessage(record) }],
    }, { timeoutMs: 8000 });
    return { status: 'delivered', deliveredAt: new Date().toISOString(), deliveredSession: targetId, error: null };
  } catch (error) {
    return { status: 'queued', error: String(error?.message ?? error) };
  }
}

export async function flushQueue({ cfg } = {}) {
  const config = cfg ?? loadBridgeConfig();
  const state = readState();
  const results = [];
  for (const item of state.items.filter((i) => i.status === 'queued')) {
    Object.assign(item, await deliverRecord(item, { cfg: config }));
    results.push({ id: item.id, status: item.status, error: item.error, session: item.deliveredSession });
  }
  if (results.length > 0) writeState(state);
  return results;
}

export function listCommands({ limit = 20 } = {}) {
  return readState().items.slice(-limit).reverse();
}

export function getCommand(id) {
  return readState().items.find((i) => i.id === Number(id)) ?? null;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd = 'list', ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const print = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');

  if (cmd === 'send') {
    const command = String(args.command ?? args._.join(' ') ?? '').trim();
    if (!command) { console.error('用法：node desk-command.mjs send --command "…"'); process.exit(2); }
    print(await enqueue({
      command,
      reason: String(args.reason ?? ''),
      source: String(args.source ?? 'qq'),
      sessionId: String(args.session ?? ''),
      deliver: args['dry-run'] !== true,
    }));
  } else if (cmd === 'list') {
    print(listCommands({ limit: Number(args.limit) || 20 }));
  } else if (cmd === 'show') {
    const hit = getCommand(args._[0]);
    if (!hit) { console.error(`没有 #${args._[0]}`); process.exit(1); }
    print(hit);
  } else if (cmd === 'retry') {
    print(await flushQueue());
  } else if (cmd === 'audit') {
    print(auditCommand(String(args.command ?? args._.join(' ')).trim()));
  } else if (cmd === 'endpoint') {
    const { baseUrl, sessions, source } = await resolveEndpoint(loadBridgeConfig(), { refresh: args.refresh === true });
    print({ baseUrl, source, sessions: sessions.length, newest: pickSession(sessions, loadBridgeConfig()) });
  } else {
    console.error('用法：node desk-command.mjs send|list|show|retry|audit|endpoint …');
    process.exit(2);
  }
}
