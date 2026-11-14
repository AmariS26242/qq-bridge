// O2 否定验证：统计 DSH 会话里「工具结果」的字符数分布，用实测数据回答
// 「tool-result-pruner 没触发，是配置错了还是本来就没有大结果」。
//
// DSH 的 session.v4.jsonl.zstd 是多帧 zstd 拼接（一行一帧），Node 的
// zstdDecompressSync 只解第一帧，所以这里先按 zstd magic（0x28 B5 2F FD）切帧再逐帧解压。
// 事件形状（v4）：{ type:'tool/result', seq, time, data:{ turn, step, message:{ content:[{type:'text',text}] } } }
// 工具名来自配对的 { type:'tool/call', data:{ message:{ content:[{type:'tool_use',id,name}] } } }。
// 只读，不改任何文件。
//   node scripts/tool-result-sizes.mjs [--dir <会话目录>] [--json]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function splitZstdFrames(buf) {
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i);
  }
  const frames = [];
  for (let n = 0; n < starts.length; n += 1) {
    frames.push(buf.subarray(starts[n], n + 1 < starts.length ? starts[n + 1] : buf.length));
  }
  return frames;
}

function decodeSessionFile(file) {
  const out = [];
  for (const frame of splitZstdFrames(fs.readFileSync(file))) {
    try {
      const text = zlib.zstdDecompressSync(frame).toString('utf8');
      for (const line of text.split('\n')) if (line.trim()) out.push(line);
    } catch { /* 坏帧/尾帧跳过 */ }
  }
  return out;
}

function listSessionFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl.zstd')) out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function textChars(message) {
  if (!message) return 0;
  if (Array.isArray(message.content)) {
    let n = 0;
    for (const part of message.content) if (typeof part?.text === 'string') n += part.text.length;
    return n;
  }
  return typeof message.content === 'string' ? message.content.length : 0;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const args = process.argv.slice(2);
const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null;
const asJson = args.includes('--json');
const root = dirArg || path.join(os.homedir(), '.dsh', 'sessions');

const onlyTool = args.includes('--only-session-tool') ? String(args[args.indexOf('--only-session-tool') + 1] ?? '') : '';
const files = listSessionFiles(root);
const perFile = [];
let events = 0;
let pruneEvents = 0;
for (const file of files) {
  const lines = decodeSessionFile(file);
  const callNames = new Map();
  const results = [];
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    events += 1;
    const data = obj?.data ?? {};
    if (obj.type === 'tool/call') {
      if (data.callId) callNames.set(data.callId, data.name ?? 'unknown');
      for (const part of data?.message?.content ?? []) {
        if (part?.type === 'tool_use' && part.id) callNames.set(part.id, part.name ?? 'unknown');
      }
      continue;
    }
    if (obj.type === 'compaction/prune') { pruneEvents += 1; continue; }
    if (obj.type !== 'tool/result') continue;
    const message = data?.message ?? null;
    const chars = textChars(message);
    if (chars <= 0) continue;
    const id = message?.toolCallId ?? message?.source?.callId ?? null;
    const name = (id && callNames.get(id)) || 'unknown';
    results.push({ chars, name });
  }
  perFile.push({ file, results });
}
// --only-session-tool：只统计「用过某个工具（子串匹配）」的会话 —— 用来把机器人真实
// QQ 对话从同目录下的人工开发会话里切出来。
let selected = perFile;
if (onlyTool) {
  selected = perFile.filter((entry) => entry.results.some((r) => r.name.includes(onlyTool)));
}
const sizes = [];
const byTool = new Map();
for (const entry of selected) {
  for (const r of entry.results) {
    sizes.push(r.chars);
    const prev = byTool.get(r.name) ?? { n: 0, max: 0, sum: 0 };
    prev.n += 1; prev.sum += r.chars; prev.max = Math.max(prev.max, r.chars);
    byTool.set(r.name, prev);
  }
}
sizes.sort((a, b) => a - b);
const over = (n) => sizes.filter((v) => v > n).length;
const summary = {
  scannedSessions: files.length,
  countedSessions: selected.length,
  onlySessionTool: onlyTool || null,
  scannedEvents: events,
  toolResults: sizes.length,
  p50: percentile(sizes, 50),
  p90: percentile(sizes, 90),
  p95: percentile(sizes, 95),
  max: sizes.length ? sizes[sizes.length - 1] : null,
  totalChars: sizes.reduce((a, b) => a + b, 0),
  over4000: over(4000),
  over20000: over(20000),
  over50000: over(50000),
  pruneEvents,
  topTools: [...byTool.entries()].sort((a, b) => b[1].sum - a[1].sum).slice(0, 5)
    .map(([tool, v]) => ({ tool, n: v.n, max: v.max, avg: Math.round(v.sum / v.n) }))
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`扫描 ${summary.scannedSessions} 个会话文件、${summary.scannedEvents} 条事件，统计 ${summary.countedSessions} 个会话里的 ${summary.toolResults} 条工具结果${summary.onlySessionTool ? `（仅含用过 ${summary.onlySessionTool} 的会话）` : ''}`);
  console.log(`字符数分布：p50=${summary.p50} p90=${summary.p90} p95=${summary.p95} max=${summary.max} 合计=${summary.totalChars}`);
  console.log(`>4000=${summary.over4000} 条，>20000=${summary.over20000} 条，>50000=${summary.over50000} 条；compaction/prune 事件=${summary.pruneEvents}`);
  for (const t of summary.topTools) console.log(`  ${t.tool}: ${t.n} 次，max=${t.max}，均值=${t.avg}`);
}
