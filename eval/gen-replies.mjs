#!/usr/bin/env node
// B2 采样 A/B 的回复生成器（路径 A：脚本直连模型 API）
//
// 设计要点
// 1) 提示词不自己拼：直接取桥接「唤醒预览」返回的线上提示词（同一套人格卡 / 规则 / few-shot），
//    只剥掉【会话令牌】这类一次性内容。两个采样组用同一份 system，差异只在采样参数。
// 2) 断点续跑：已有 replies/<组>/<id>_<n>.txt 就跳过，中断后重跑不会重复花钱。
// 3) 每次调用记 usage（输入/输出 token 与耗时），汇总写 report-cost.json，方便核对开支。
// 4) 密钥只从环境变量或 ~/.dsh/.credentials.yaml 读，任何输出都不打印密钥。
//
// 用法：
//   node eval/gen-replies.mjs eval/ab/<stamp> --dry-run
//   node eval/gen-replies.mjs eval/ab/<stamp> --limit 2
//   node eval/gen-replies.mjs eval/ab/<stamp>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const BRIDGE = process.env.QQBRIDGE_BASE || 'http://127.0.0.1:3100';
const API = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1/chat/completions';
const MODEL = process.env.GEN_MODEL || 'deepseek-chat';
const MAX_TOKENS = Number(process.env.GEN_MAX_TOKENS || 200);
const GAP_MS = Number(process.env.GEN_GAP_MS || 400);
const RETRIES = 3;

function parseArgs(argv) {
  const args = { dir: '', limit: 0, dry: false, keepSystem: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dry = true;
    else if (a === '--limit') args.limit = Number(argv[++i] || 0);
    else if (a === '--system-file') args.systemFile = argv[++i];
    else if (!a.startsWith('--') && !args.dir) args.dir = a;
  }
  return args;
}

function readKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (fromEnv) return fromEnv.trim();
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  if (!fs.existsSync(file)) throw new Error('找不到 DEEPSEEK_API_KEY（环境变量与 ~/.dsh/.credentials.yaml 都没有）');
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/DEEPSEEK_API_KEY:\s*([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('~/.dsh/.credentials.yaml 里没有 DEEPSEEK_API_KEY');
  return m[1];
}

function consoleToken() {
  for (const p of ['state/console-token', path.join(os.tmpdir(), 'qq-console-token')]) {
    try {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t) return t;
    } catch {}
  }
  return '';
}

function stripVolatile(prompt) {
  return prompt
    .split('\n')
    .filter((line) => !/^【会话令牌】/.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchSystemPrompt() {
  const token = consoleToken();
  const url = `${BRIDGE}/api/socialV2/wake-prompt?key=private:100000001&reason=preview`;
  const res = await fetch(url, { headers: token ? { 'x-console-token': token } : {} });
  if (!res.ok) throw new Error(`取线上提示词失败：HTTP ${res.status}`);
  const body = await res.json();
  const prompt = String(body.prompt || '');
  if (!prompt) throw new Error('线上提示词为空');
  return stripVolatile(prompt);
}

function groupParams(group, base) {
  // plan.json 里是 camelCase（与 config.json 一致），API 要 snake_case
  const p = { ...base, ...(group.params || {}) };
  const map = [
    ['temperature', 'temperature'],
    ['topP', 'top_p'],
    ['presencePenalty', 'presence_penalty'],
    ['frequencyPenalty', 'frequency_penalty'],
  ];
  const out = {};
  for (const [from, to] of map) {
    if (typeof p[from] === 'number') out[to] = p[from];
  }
  return out;
}

function userMessage(ctx) {
  const situation = String(ctx.situation || '').trim();
  const incoming = String(ctx.incoming || '').trim();
  return situation ? `【场景】${situation}\n${incoming}` : incoming;
}

async function callModel({ key, system, user, params }) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    ...params,
  };
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    const started = Date.now();
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        const brief = text.slice(0, 200);
        lastErr = new Error(`HTTP ${res.status}: ${brief}`);
        if (res.status >= 500 || res.status === 429) {
          await sleep(800 * attempt);
          continue;
        }
        throw lastErr;
      }
      const data = JSON.parse(text);
      const reply = String(data.choices?.[0]?.message?.content || '').trim();
      if (!reply) throw new Error('模型返回空回复');
      return {
        reply,
        ms: Date.now() - started,
        usage: data.usage || {},
      };
    } catch (error) {
      lastErr = error;
      if (attempt < RETRIES) await sleep(600 * attempt);
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('用法：node eval/gen-replies.mjs eval/ab/<stamp> [--limit N] [--dry-run]');
    process.exit(2);
  }
  const dir = path.resolve(args.dir);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  const contexts = fs
    .readFileSync('eval/contexts.jsonl', 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const byId = new Map(contexts.map((c) => [c.id, c]));
  const groups = plan.groups || [];
  if (groups.length < 2) throw new Error('计划里没有对照组与实验组');
  const base = groups[0].params || {};
  const samples = Number(plan.samples || 3);

  let system = '';
  const sysFile = args.systemFile || path.join(dir, 'system-prompt.txt');
  if (fs.existsSync(sysFile)) {
    system = fs.readFileSync(sysFile, 'utf8');
  } else {
    system = await fetchSystemPrompt();
    atomicWrite(sysFile, system);
  }

  const todo = [];
  for (const group of groups) {
    const params = groupParams(group, base);
    for (const ctx of plan.contexts || []) {
      const full = byId.get(ctx.id);
      if (!full) throw new Error(`上下文 ${ctx.id} 在 eval/contexts.jsonl 里找不到`);
      for (let i = 1; i <= samples; i += 1) {
        const out = path.join(dir, 'replies', group.name, `${ctx.id}_${i}.txt`);
        if (fs.existsSync(out)) continue;
        todo.push({ group: group.name, params, ctxId: ctx.id, i, out, user: userMessage(full) });
      }
    }
  }

  console.log(`计划：${groups.map((g) => g.name).join(' / ')} × ${plan.contexts.length} 条上下文 × ${samples} 条`);
  console.log(`已存在：${groups.length * plan.contexts.length * samples - todo.length} 个；待生成：${todo.length} 个`);
  console.log(`system 提示词：${system.length} 字符（sha 见 cost 报告）`);

  if (args.dry) {
    const sample = todo.slice(0, Math.max(1, args.limit || 1));
    for (const t of sample) {
      console.log(`\n[${t.group}] ${t.ctxId}_${t.i}  params=${JSON.stringify(t.params)}`);
      console.log(`  user: ${t.user.replace(/\n/g, ' / ')}`);
      console.log(`  → ${path.relative(process.cwd(), t.out)}`);
    }
    console.log(`\n（dry-run：未调用模型）`);
    return;
  }

  const key = readKey();
  const list = args.limit ? todo.slice(0, args.limit) : todo;

  const costFile = path.join(dir, 'report-cost.json');
  const readCost = () => {
    try {
      const prev = JSON.parse(fs.readFileSync(costFile, 'utf8'));
      return Array.isArray(prev.detail) ? prev.detail : [];
    } catch {
      return [];
    }
  };
  const writeCost = (detail) => {
    const sum = (k) => detail.reduce((n, c) => n + (Number(c.usage?.[k]) || 0), 0);
    const totalIn = sum('prompt_tokens') || sum('input_tokens');
    const totalOut = sum('completion_tokens') || sum('output_tokens');
    atomicWrite(
      costFile,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          model: MODEL,
          api: API,
          systemChars: system.length,
          systemSha256: sha256(system),
          calls: detail.length,
          promptTokens: totalIn,
          completionTokens: totalOut,
          totalMs: detail.reduce((n, c) => n + (Number(c.ms) || 0), 0),
          detail,
        },
        null,
        2,
      ),
    );
    return { totalIn, totalOut, count: detail.length };
  };

  const detail = readCost();
  let done = 0;
  for (const t of list) {
    const { reply, ms, usage } = await callModel({ key, system, user: t.user, params: t.params });
    atomicWrite(t.out, reply);
    detail.push({ group: t.group, ctxId: t.ctxId, i: t.i, ms, usage });
    writeCost(detail); // 每调一次就落盘，进程被杀也不丢账
    done += 1;
    const inTok = usage.prompt_tokens ?? usage.input_tokens ?? '?';
    const outTok = usage.completion_tokens ?? usage.output_tokens ?? '?';
    console.log(`[${done}/${list.length}] ${t.group} ${t.ctxId}_${t.i} ${ms}ms in=${inTok} out=${outTok} :: ${reply.slice(0, 40).replace(/\n/g, ' ')}`);
    if (GAP_MS) await sleep(GAP_MS);
  }

  const total = writeCost(detail);
  console.log(`\n本次 ${list.length} 次调用；累计 ${total.count} 次，输入 ${total.totalIn} token，输出 ${total.totalOut} token。成本报告：${path.relative(process.cwd(), costFile)}`);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exit(1);
});
