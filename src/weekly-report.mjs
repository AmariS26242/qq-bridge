/**
 * 周报的「纯逻辑」部分：一周的统计怎么算、清单怎么摘、消息怎么排。
 *
 * 数据源都是已经落盘的流水，这里只认「已经 parse 好的数组」，不读文件（I/O 在
 * scripts/weekly-report.mjs）：
 *   - state/token-usage.jsonl  每轮一条 {k:'turn', t, b:{cacheMiss,cacheHit,cacheWrite,output}}
 *   - state/tool-calls.jsonl   每次工具调用 {type:'call'|'result', time, tool, ok}
 *   - state/doctor-report.json 的 history [{at, ok, passed, total, failed:[key]}]
 *   - 项目计划/*.md            的 `- [x]` / `- [ ]` 复选框
 *
 * 口径（跟每日简报保持一致，别两处各说一套）：
 *   - 「轮」= turn 条目的条数；「消息」= qq_reply 调用次数；失败 = 这些调用里 ok=false。
 *   - 「服务抖过几次」= 这一周 doctor 里红过的次数（自检是唯一有留痕的服务判据）；
 *     另有 📈 可用率行来自 state/health.jsonl 的 5 分钟采样，两者互不替代。
 *   - 「本周收尾」= 相对上周基线新增的 `- [x]` 条目；第一次跑没有基线，就说「首次运行」。
 */
import { formatBytes } from './clean-state.mjs';
import { CHECK_LABELS } from './doctor.mjs';
import { renderUptimeLine } from './health.mjs';

export const WEEKLY_DEFAULTS = Object.freeze({
  enabled: true,
  at: '20:00',
  dayOfWeek: 0, // 0 = 周日（JS getDay 口径）
  windowDays: 7,
  maxLines: 14,
  maxChars: 900,
  topTodos: 3,
  topDone: 3,
  topRed: 2,
});

const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeWeeklyConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const num = (v, dflt, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) return dflt;
    return Math.round(n);
  };
  const atRaw = typeof cfg.at === 'string' ? cfg.at.trim() : '';
  const atMatch = /^(\d{1,2}):(\d{2})$/.exec(atRaw);
  const atValid = atMatch && Number(atMatch[1]) <= 23 && Number(atMatch[2]) <= 59;
  const at = atValid ? `${String(Number(atMatch[1])).padStart(2, '0')}:${atMatch[2]}` : WEEKLY_DEFAULTS.at;
  return {
    enabled: cfg.enabled !== false,
    at,
    dayOfWeek: num(cfg.dayOfWeek, WEEKLY_DEFAULTS.dayOfWeek, { min: 0, max: 6 }),
    windowDays: num(cfg.windowDays, WEEKLY_DEFAULTS.windowDays, { min: 1, max: 31 }),
    maxLines: num(cfg.maxLines, WEEKLY_DEFAULTS.maxLines, { min: 4, max: 40 }),
    maxChars: num(cfg.maxChars, WEEKLY_DEFAULTS.maxChars, { min: 200, max: 4000 }),
    topTodos: num(cfg.topTodos, WEEKLY_DEFAULTS.topTodos, { min: 0, max: 10 }),
    topDone: num(cfg.topDone, WEEKLY_DEFAULTS.topDone, { min: 0, max: 10 }),
    topRed: num(cfg.topRed, WEEKLY_DEFAULTS.topRed, { min: 0, max: 10 }),
  };
}

/** 时间窗：默认「过去 7 天」，右端是这次跑的时刻。 */
export function makeWindow(now, windowDays = 7) {
  const end = Number(new Date(now));
  const days = Number.isFinite(Number(windowDays)) && Number(windowDays) >= 1 ? Number(windowDays) : 7;
  return { from: end - days * DAY_MS, to: end };
}

const inWindow = (ms, w) => Number.isFinite(ms) && ms > 0 && ms >= w.from && ms <= w.to;

/**
 * 轮次与 token。token-usage 里 t 是毫秒时间戳，b 是四类计数。
 * 缓存率 = cacheHit / 输入总量；输入为 0 时给 0（别给 NaN 让简报炸）。
 */
export function summarizeTurns(entries, window) {
  const out = { turns: 0, sessions: new Set(), input: 0, cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0 };
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.k !== 'turn') continue;
    if (!inWindow(Number(e.t), window)) continue;
    out.turns += 1;
    if (e.sid) out.sessions.add(String(e.sid));
    const b = e.b || {};
    out.cacheHit += Number(b.cacheHit) || 0;
    out.cacheMiss += Number(b.cacheMiss) || 0;
    out.cacheWrite += Number(b.cacheWrite) || 0;
    out.output += Number(b.output) || 0;
  }
  out.input = out.cacheHit + out.cacheMiss + out.cacheWrite;
  out.cacheRate = out.input > 0 ? out.cacheHit / out.input : 0;
  out.sessionCount = out.sessions.size;
  delete out.sessions;
  return out;
}

const REPLY_TOOL = /qq_reply|qq_send_message/;
const VOICE_TOOL = /qq_send_voice/;
const STICKER_TOOL = /qq_send_sticker/;

/** 工具调用：消息数、语音数、表情数、失败数。只数 type==='call'，result 不重复计。 */
export function summarizeCalls(entries, window) {
  const out = { calls: 0, failed: 0, messages: 0, voices: 0, stickers: 0 };
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.type !== 'call') continue;
    if (!inWindow(Number(new Date(e.time)), window)) continue;
    out.calls += 1;
    const tool = String(e.tool || '');
    if (REPLY_TOOL.test(tool)) out.messages += 1;
    else if (VOICE_TOOL.test(tool)) out.voices += 1;
    else if (STICKER_TOOL.test(tool)) out.stickers += 1;
    if (e.ok === false) out.failed += 1;
  }
  return out;
}

/** 自检历史：跑了几次、红了几次、最常红的是哪几项（按 key 归并）。 */
export function summarizeDoctor(history, window) {
  const out = { runs: 0, redRuns: 0, topRed: [] };
  const counter = new Map();
  for (const h of Array.isArray(history) ? history : []) {
    if (!h || !h.at) continue;
    if (!inWindow(Number(new Date(h.at)), window)) continue;
    out.runs += 1;
    if (h.ok === false || (Array.isArray(h.failed) && h.failed.length)) {
      out.redRuns += 1;
      for (const f of Array.isArray(h.failed) ? h.failed : []) {
        const key = typeof f === 'string' ? f : f?.key || f?.name;
        if (key) counter.set(key, (counter.get(key) || 0) + 1);
      }
    }
  }
  out.topRed = [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count }));
  return out;
}

/**
 * 从一份 Markdown 里摘复选框。只在 `##`/`###` 标题下摘，标题作为上下文带出来
 * ——「已勾 42 项」没有意义，「长期记忆索引 · 阶段拆分：xxx」才有意义。
 */
export function parseChecklist(text, file = '') {
  const items = [];
  let heading = '';
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^#{2,3}\s+(.*)$/);
    if (h) {
      heading = h[1].trim();
      continue;
    }
    const m = line.match(/^\s*- \[([ xX])\]\s+(.*)$/);
    if (!m) continue;
    const done = m[1].toLowerCase() === 'x';
    const body = m[2].trim();
    if (!body) continue;
    items.push({
      file,
      heading,
      text: body,
      done,
      key: `${file}::${heading}::${body}`,
    });
  }
  return items;
}

/** 相对上周基线新增的已勾项（= 本周收尾）；基线为空 = 首次运行。 */
export function diffChecklist(prevKeys, items) {
  const prev = new Set(Array.isArray(prevKeys) ? prevKeys : []);
  const done = (Array.isArray(items) ? items : []).filter((i) => i && i.done);
  if (!prev.size) return { firstRun: true, newlyDone: [], doneCount: done.length };
  const newlyDone = done.filter((i) => !prev.has(i.key));
  return { firstRun: false, newlyDone, doneCount: done.length };
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t;
};

const pad2 = (n) => String(n).padStart(2, '0');
const monthDay = (d) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;

/** 清单正文里的 Markdown 装饰（`**`、反引号、链接）在 QQ 里是噪音，先剥掉再截断。 */
const plain = (s) => String(s ?? '')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[*_`>]+/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/** 12.3M / 402k / 1.5k 这类紧凑写法（周报按行算钱，不按字节）。 */
export function formatTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '0';
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return `${(v / 1e3).toFixed(v < 1e4 ? 1 : 0)}k`;
  return `${(v / 1e6).toFixed(v < 1e7 ? 1 : 0)}M`;
}

/** 简报里的 `## 标题` 太粗，周报只留标题尾部两段，避免「一、二、三」占满一行。 */
const shortHeading = (h) => clip(String(h || '').replace(/^[一二三四五六七八九十]+、/, ''), 14);

/**
 * 出周报正文。没有数据的分支整行不出现（周报最怕「0 条 0 条 0 条」的空壳）。
 */
export function renderWeeklyReport({
  at = Date.now(),
  turns = null,
  calls = null,
  doctor = null,
  backup = null,
  health = null,
  items = null,
  prevChecked = null,
  config = null,
} = {}) {
  const cfg = normalizeWeeklyConfig(config);
  const end = new Date(at instanceof Date ? at : new Date(at));
  const when = Number.isFinite(end.getTime()) ? end : new Date();
  const start = new Date(when.getTime() - cfg.windowDays * DAY_MS);
  const lines = [`📊 周报 ${monthDay(start)}–${monthDay(when)}`];

  if (turns && turns.turns > 0) {
    const parts = [`💬 对话：${turns.turns} 轮`];
    if (turns.sessionCount) parts.push(`${turns.sessionCount} 个会话`);
    if (calls && calls.messages) parts.push(`消息 ${calls.messages} 条`);
    if (calls && calls.failed) parts.push(`失败 ${calls.failed}`);
    lines.push(parts.join(' · '));
  } else if (calls && calls.calls) {
    lines.push(`💬 对话：消息 ${calls.messages || 0} 条${calls.failed ? ` · 失败 ${calls.failed}` : ''}`);
  }

  if (calls && (calls.voices || calls.stickers)) {
    const parts = [];
    if (calls.voices) parts.push(`语音 ${calls.voices}`);
    if (calls.stickers) parts.push(`表情 ${calls.stickers}`);
    lines.push(`🎁 随手：${parts.join(' · ')}`);
  }

  if (turns && turns.input > 0) {
    lines.push(`🔤 token：输入 ${formatTokens(turns.input)}（缓存 ${(turns.cacheRate * 100).toFixed(1)}%）· 输出 ${formatTokens(turns.output)}`);
  }

  if (doctor && doctor.runs > 0) {
    if (doctor.redRuns === 0) {
      lines.push(`🩺 服务：自检 ${doctor.runs} 次全绿`);
    } else {
      const names = doctor.topRed
        .slice(0, cfg.topRed)
        .map((r) => `${CHECK_LABELS[r.key] || r.key}×${r.count}`)
        .join('、');
      lines.push(`🩺 服务：自检 ${doctor.runs} 次，红 ${doctor.redRuns} 次${names ? `（${names}）` : ''}`);
    }
  }

  if (backup && backup.lastRunAt) {
    const ok = backup.lastOk !== false;
    const files = Number(backup.fileCount) || 0;
    const size = Number(backup.totalBytes) || 0;
    lines.push(`💾 备份：${ok ? '最近一次成功' : '最近一次失败'}（${files} 份 / ${formatBytes(size)}）`);
  }

  // 可用率放在 ✅ 收尾之前：它是「这一周服务到底稳不稳」的结论，收尾/待办是清单状态，
  // 两者都不该被 maxLines 的 slice 吃掉；但若真要二选一，清单行比可用率更贴近用户的动作。
  const uptime = renderUptimeLine(health);
  if (uptime) lines.push(uptime);

  if (Array.isArray(items) && items.length) {
    const diff = diffChecklist(prevChecked, items);
    if (diff.firstRun) {
      lines.push(`✅ 收尾：清单首次建立基线（已勾 ${diff.doneCount} 项）`);
    } else if (diff.newlyDone.length) {
      const names = diff.newlyDone
        .slice(0, cfg.topDone)
        .map((i) => {
        const head = shortHeading(plain(i.heading));
        return `${head ? `${head}：` : ''}${clip(plain(i.text), 22)}`;
      });
      lines.push(`✅ 收尾：本周完成 ${diff.newlyDone.length} 项`);
      for (const n of names) lines.push(`   · ${n}`);
    } else {
      lines.push('✅ 收尾：本周清单没有新增勾选');
    }

    const todos = items.filter((i) => !i.done).slice(0, cfg.topTodos);
    if (todos.length) {
      lines.push('📋 下周待办：');
      todos.forEach((t, idx) => lines.push(`   ${idx + 1}. ${clip(plain(t.text), 34)}`));
    } else {
      lines.push('📋 下周待办：清单里没有未勾选项');
    }
  }

  let text = lines.join('\n');
  const out = text.split('\n').slice(0, cfg.maxLines).join('\n');
  text = out;
  if (text.length > cfg.maxChars) text = `${text.slice(0, Math.max(1, cfg.maxChars - 1))}…`;
  return text;
}

/** 当前 ISO 周（`2026-W43`），用来做「这周已经发过了」的幂等标记。 */
export function isoWeekKey(date) {
  const d = new Date(Number(new Date(date)));
  if (!Number.isFinite(d.getTime())) return '';
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
