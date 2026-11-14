#!/usr/bin/env node
/**
 * C3 翻闸的「留底 + 翻后核对」小工具。
 *
 * 翻 enforce 只改一个开关，但一旦翻错，代价是模型失忆或未读消息被清空。所以翻之前
 * 先把「现在长什么样」写成基线（state/enforce-baseline.json），翻之后用同一份基线
 * 核对：未读还在不在、会话是不是真的只轮换了一次、交接文件是不是非空壳。
 *
 * 用法：
 *   node scripts/prep-enforce.mjs             # 留底：备份三个 state 文件 + 写基线 + 打印翻闸步骤
 *   node scripts/prep-enforce.mjs --check     # 只跑闸门（gate-enforce.mjs），不全通过则退出码非 0
 *   node scripts/prep-enforce.mjs --verify    # 翻闸之后核对（只读）
 *
 * 可选 `--state <dir>` / `--log <file>` 便于测试；默认读仓库的 state/。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BACKUP_FILES = ['sessions.json', 'social-v2.json', 'config.json'];
/** config.json 在仓库根，其余在 state/；两边都找一遍，谁在就备份谁。 */
function locate(name, stateDir) {
  const candidates = [path.join(stateDir, name), path.join(ROOT, name)];
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

function parseArgs(argv) {
  const args = { mode: 'prep', stateDir: path.join(ROOT, 'state'), log: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.mode = 'check';
    else if (a === '--verify') args.mode = 'verify';
    else if (a === '--state') args.stateDir = path.resolve(argv[++i]);
    else if (a === '--log') args.log = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') args.mode = 'help';
  }
  args.log = args.log ?? path.join(args.stateDir, 'bridge.log');
  return args;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const sha8 = (text) => crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 8);

/** 从 state 里抽出「翻闸前后必须守恒/必须变化」的事实。 */
export function snapshot(stateDir) {
  const sessions = readJson(path.join(stateDir, 'sessions.json'), {});
  const v2 = readJson(path.join(stateDir, 'social-v2.json'), {});
  const conversations = v2.conversations ?? {};
  const perConversation = {};
  for (const [key, conv] of Object.entries(conversations)) {
    perConversation[key] = {
      unread: Array.isArray(conv.unread) ? conv.unread.length : 0,
      lastUnreadSeq: Number(conv.lastUnreadSeq ?? 0),
      lastReadThroughSeq: Number(conv.lastReadThroughSeq ?? 0),
      recent: Array.isArray(conv.recentMessages) ? conv.recentMessages.length : 0,
      agentToken: sha8(conv.agentToken),
      lastHandoffAt: Number(conv.lastHandoffAt ?? 0)
    };
  }
  return {
    sessionIds: Object.keys(sessions.sessions ?? {}).sort(),
    conversations: perConversation
  };
}

function backupsIn(stateDir) {
  const archive = path.join(stateDir, 'archive');
  if (!fs.existsSync(archive)) return [];
  return fs.readdirSync(archive).filter((f) => f.endsWith('-pre-enforce.bak'));
}

function handoffFiles(stateDir) {
  const dir = path.join(stateDir, 'handoff');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const file = path.join(dir, f);
      const payload = readJson(file, null);
      return { file: f, ok: Boolean(payload), items: countItems(payload), bytes: fs.statSync(file).size };
    });
}

/**
 * 交接 payload 的「有内容」计数。
 *
 * 字段名必须是 payload 的真实字段（见 src/handoff.mjs 的 LIST_FIELDS）：
 * `topics / openLoops / peopleChange / insideJokes`，外加 `mood`。
 * 早先这里写的是 `activeTopics / pendingThoughts / memberImpressions`（那是 bridge 内部
 * 中途变量的名字），永远读不到 → 除 openLoops 外一切交接都被判成「空壳」，
 * 进而可能把一次成功的翻闸劝退。
 */
function countItems(payload) {
  if (!payload || typeof payload !== 'object') return 0;
  let n = 0;
  for (const field of ['topics', 'openLoops', 'peopleChange', 'insideJokes']) {
    if (Array.isArray(payload[field])) n += payload[field].length;
  }
  if (typeof payload.mood === 'string' && payload.mood.trim()) n += 1;
  return n;
}

function logLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

/** 与 `src/handoff.mjs` 的 safeKeyOf 保持同一规则：不落在 [A-Za-z0-9_.-] 的字符换成 `_`。 */
function safeKeyOf(key) {
  const text = key === null || key === undefined ? '' : String(key);
  return (text.replace(/[^A-Za-z0-9_.-]/gu, '_') || '_');
}

/** 把 `state/handoff/*.json` 里的 `generatedAt` 按对话 key 索引起来。 */
function handoffIds(stateDir) {
  const dir = path.join(stateDir, 'handoff');
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || name.includes('.tmp-')) continue;
    const record = readJson(path.join(dir, name), null);
    if (!record || !Number.isFinite(Number(record.generatedAt))) continue;
    const safeKey = name.slice(0, -'.json'.length);
    out.set(safeKey, Number(record.generatedAt));
  }
  return out;
}

function runPrep(args) {
  const stateDir = args.stateDir;
  const archive = path.join(stateDir, 'archive');
  fs.mkdirSync(archive, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const made = [];
  for (const name of BACKUP_FILES) {
    const src = locate(name, stateDir);
    if (!src) {
      console.log(`  · 跳过 ${name}（不存在）`);
      continue;
    }
    const dst = path.join(archive, `${name}.${stamp}-pre-enforce.bak`);
    fs.copyFileSync(src, dst);
    made.push({ name, file: path.basename(dst), bytes: fs.statSync(dst).size });
  }
  const snap = snapshot(stateDir);
  const baseline = { at: new Date().toISOString(), ...snap };
  fs.writeFileSync(path.join(stateDir, 'enforce-baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  console.log('留底完成：');
  for (const m of made) console.log(`  ✓ ${m.name} → archive/${m.file}（${m.bytes} B）`);
  console.log(`  ✓ 基线 state/enforce-baseline.json：${snap.sessionIds.length} 个会话，${Object.keys(snap.conversations).length} 个对话`);
  console.log('');
  console.log('翻闸步骤（详见 docs/ACTION-CHECKLIST.md §6.19）：');
  console.log('  1. node scripts/gate-enforce.mjs            # 六项全 PASS');
  console.log('  2. config.json → contextBudget.mode = "enforce"');
  console.log('  3. cmd /c "restart.bat < nul"               # 不要用 taskkill 直接杀');
  console.log('  4. node scripts/prep-enforce.mjs --verify   # 翻后核对');
  return 0;
}

function runCheck() {
  const res = spawnSync(process.execPath, [path.join(HERE, 'gate-enforce.mjs')], { stdio: 'inherit' });
  return res.status ?? 1;
}

/** 翻闸后核对：未读不丢、会话轮换、交接非空壳、日志无校验失败。 */
export function verify(stateDir, logFile) {
  const baselineFile = path.join(stateDir, 'enforce-baseline.json');
  const baseline = readJson(baselineFile, null);
  const results = [];
  const add = (ok, label, detail) => results.push({ ok, label, detail });
  // 「信息不足」既不是通过也不是失败：条件还没发生（翻闸后尚未触发交接）时必须显式区分，
  // 否则又变成「恒 PASS」那种自欺。
  const addInfo = (label, detail) => results.push({ ok: 'info', label, detail });

  add(Boolean(baseline), '基线存在', baseline ? `记录于 ${baseline.at}` : `缺少 ${baselineFile}，先跑一次不带参数的本脚本`);

  const now = snapshot(stateDir);
  if (baseline) {
    const lost = [];
    for (const [key, before] of Object.entries(baseline.conversations ?? {})) {
      const after = now.conversations[key];
      if (!after) { lost.push(`${key}（对话整个消失）`); continue; }
      // 退役路径不碰 unread（retireSession 只清会话/缓存），所以翻闸前后未读条数
      // 必须**不减少**。真实的读消息也会让条数减少，所以核对要贴身跑：若期间有人
      // 回了消息导致数字变了，重新跑一次不带参数的留底再核对即可。
      if (after.unread < before.unread) {
        lost.push(`${key}（未读 ${before.unread} → ${after.unread}）`);
      }
    }
    add(lost.length === 0, '未读未丢失', lost.length ? lost.join('；') : '所有对话的未读/水位都没有回退');

    const retired = baseline.sessionIds.filter((id) => !now.sessionIds.includes(id));
    const added = now.sessionIds.filter((id) => !baseline.sessionIds.includes(id));
    // 翻闸后可能 0 次轮换（没有会话真撞到硬线），也可能同时轮换 2 个；不能要求恰好 1。
    // 真正要防的是「凭空多出会话」——那说明轮换之外还有别的路径在造会话。
    add(
      added.length <= retired.length,
      '会话轮换守恒',
      `退役 ${retired.length} 个（${retired.join(',') || '—'}），新增 ${added.length} 个（${added.join(',') || '—'}）${retired.length === 0 ? '（翻闸后尚未触发交接）' : ''}`
    );

    if ((baseline.conversations ?? {}) && Object.keys(baseline.conversations ?? {}).length === 0) {
      addInfo('agentToken 已轮换', '基线里没有对话，无从对照');
    } else {
      const tokenChanged = Object.entries(baseline.conversations ?? {})
        .filter(([key]) => now.conversations[key])
        .map(([key, before]) => ({ key, changed: before.agentToken !== now.conversations[key].agentToken }));
      if (retired.length === 0) {
        addInfo('agentToken 已轮换', '翻闸后尚未触发交接，token 还没换（不是失败，是还没发生）');
      } else {
        add(
          tokenChanged.length > 0 && tokenChanged.every((t) => t.changed),
          'agentToken 已轮换',
          tokenChanged.map((t) => `${t.key}:${t.changed ? '已换' : '未换'}`).join(' ') || '没有可比对的对话'
        );
      }
    }
  }

  const files = handoffFiles(stateDir);
  if (files.length === 0) {
    addInfo('有交接文件', 'state/handoff/ 仍为空（翻闸后还没有会话撞到硬线；不是失败）');
  } else {
    add(true, '有交接文件', files.map((f) => `${f.file}（${f.items} 条，${f.bytes} B）`).join(' '));
    const empty = files.filter((f) => f.items === 0);
    add(empty.length === 0, '交接非空壳', empty.length ? `空壳：${empty.map((f) => f.file).join(', ')}` : '至少各有一条话题/未完');
  }

  const lines = logLines(logFile);
  const handoffLines = lines.filter((l) => l.includes('[handoff]'));
  // 翻闸后还没人撞硬线时，「日志里有 [handoff]」必然为空——这是「还没发生」，不是失败，
  // 否则每次刚翻完闸核对都会红一条，把人逼去忽略核对结果。
  if (handoffLines.length > 0) {
    add(true, '日志有交接记录', handoffLines.slice(-2).join(' | '));
  } else if (files.length === 0) {
    addInfo('日志有交接记录', '还没有会话触发交接，日志里自然没有 [handoff] 行（不是失败）');
  } else {
    add(false, '日志有交接记录', '已有交接文件但日志里没有 [handoff] 行');
  }
  const bad = lines.filter((l) => /\[handoff\].*(校验失败|too-long|payload)/.test(l));
  add(bad.length === 0, '交接 payload 无校验失败', bad.slice(-2).join(' | ') || '无失败记录');

  // 「只注入一次」不能靠日志判：注入行只出现在 prompt 里，永远不进日志（旧判据因此恒 PASS）。
  // 能从状态里验的是**注入 id 与磁盘 id 是否同源**：不同源就意味着「同一份交接被当成新交接
  // 又注入了一次」（正是 §6.29 修的那个坑），这才是可观测的破口。
  const ids = handoffIds(stateDir);
  const convs = readJson(path.join(stateDir, 'social-v2.json'), {})?.conversations ?? {};
  const drifted = [];
  let consumed = 0;
  let waiting = [];
  for (const [key, conv] of Object.entries(convs)) {
    const fileId = ids.get(safeKeyOf(key));
    if (fileId === undefined) continue;
    const injected = typeof conv?.handoffInjectedId === 'string' ? conv.handoffInjectedId : '';
    const pending = typeof conv?.handoffPendingId === 'string' ? conv.handoffPendingId : '';
    if (injected && injected !== String(fileId)) drifted.push(`${key}（注入 ${injected} / 磁盘 ${fileId}）`);
    if (injected && pending && injected === pending) consumed += 1;
    if (pending && !injected) waiting.push(key);
  }
  if (ids.size === 0) {
    addInfo('交接注入未重复', '还没有交接文件，无从核对注入 id');
  } else {
    add(
      drifted.length === 0,
      '交接注入未重复',
      drifted.length
        ? `注入 id 与磁盘 generatedAt 不同源：${drifted.join('；')}`
        : `已消费 ${consumed} 份；待注入 ${waiting.length} 份（${waiting.join(',') || '—'}）`
    );
  }

  for (const r of results) console.log(`${r.ok === 'info' ? 'INFO' : r.ok ? 'PASS' : 'FAIL'}  ${r.label}  ${r.detail}`);
  const failed = results.filter((r) => r.ok === false).length;
  const infos = results.filter((r) => r.ok === 'info').length;
  console.log(`\n结论：${results.length - failed - infos} 项通过，${failed} 项未通过${infos ? `，${infos} 项信息不足` : ''}`);
  return failed === 0 ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'help') {
    console.log('用法：node scripts/prep-enforce.mjs [--check | --verify] [--state <dir>] [--log <file>]');
    process.exit(0);
  }
  const code = args.mode === 'check' ? runCheck() : args.mode === 'verify' ? verify(args.stateDir, args.log) : runPrep(args);
  process.exit(code);
}
