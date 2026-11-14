/**
 * 统一优化面板（docs/ACTION-CHECKLIST.md 的 A1）。
 *
 * 为什么要有这个文件：风格侧（src/ai-tone-stats.js）和成本侧（src/token-ledger.js）
 * 各自都在落盘，但**没有一处能同时回答**下面五个问题，于是每次调参都只能分开看两页、
 * 自己心算：
 *   1. 单步上下文水位多少（一次请求送进去多少 token）；
 *   2. 每天累计输入多少（成本的大头在哪）；
 *   3. 哪几条风格规则最常触发（Top5）；
 *   4. 被删空/兜底/跳过的比例多少；
 *   5. 有多少轮模型判了「不说话」（无输出轮占比）；
 *   6. 每个会话离上下文硬线还有多远（C3 翻 enforce 前的观察窗口）。
 *
 * 设计约束：
 * - **纯函数、无 IO**：读文件由调用方做，这里只吃字符串/对象，方便单测与离线 fixture。
 * - **两个来源各自保留自己的口径**：风格按本地日期桶，成本按采样行（sid|turn|step|retry
 *   后到覆盖先到）。这里只做「同一时间窗内的对齐」，不改任何一侧语义。
 * - **隐私**：入参只有规则 id、字符数、token 数，出参也只到这些粒度，永远不含原文；
 *   会话键一律脱敏（private:1000***001），面板不需要知道完整 QQ 号。
 */
import { dayKey } from './ai-tone-stats.js';
import { classifyContextWatermark } from './context-budget.mjs';

export const OPS_PANEL_VERSION = 1;

export const OPS_DEFAULTS = Object.freeze({
  windowDays: 7,
  // 「无输出轮」的判定阈值：整轮 output token 小于等于它就当没说话。
  // 不能写死 0——模型判 [SILENT] 时仍会吐几个 token（实测 3–4 个）。
  nearZeroOutputTokens: 8,
  maxWindowDays: 30
});

const DAY_MS = 86_400_000;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** 采样先后顺序：t → turn → step → retry → seq，与 token-ledger 的 compareSampleOrder 同义。 */
function orderOf(row) {
  return [num(row.t), num(row.turn), num(row.step), num(row.retry), num(row.seq)];
}

function compareOrder(a, b) {
  const oa = orderOf(a);
  const ob = orderOf(b);
  for (let i = 0; i < oa.length; i += 1) {
    if (oa[i] !== ob[i]) return oa[i] - ob[i];
  }
  return 0;
}

/** 单条采样的上下文水位：该步送入模型的总输入量（命中 + 未命中），与 token-ledger 口径一致。 */
export function watermarkOf(buckets) {
  // 与 token-ledger 的 inputTokens 同口径：miss + hit + write。
  return num(buckets?.cacheMiss) + num(buckets?.cacheHit) + num(buckets?.cacheWrite);
}

/** 本地零点（按机器时区，和 ai-tone-stats 的日桶对齐）。 */
export function startOfLocalDay(atMs) {
  const d = new Date(Number(atMs) || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function clampWindowDays(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return OPS_DEFAULTS.windowDays;
  return Math.min(OPS_DEFAULTS.maxWindowDays, Math.floor(n));
}

/**
 * 解析 token-usage.jsonl 文本 → 去重后的 turn 采样数组（按时间升序）。
 * 只认 `k:"turn"` 行；同 (sid|turn|step|retry) 后到覆盖先到（重连会重发 snapshot）。
 */
export function parseTokenRows(text) {
  if (typeof text !== 'string' || !text) return [];
  const byKey = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try { row = JSON.parse(trimmed); } catch { continue; }
    if (!row || row.k !== 'turn') continue;
    const sid = String(row.sid ?? '');
    if (!sid) continue;
    const candidate = {
      sid,
      turn: num(row.turn),
      step: num(row.step),
      retry: num(row.retry),
      seq: num(row.seq),
      t: num(row.t),
      key: String(row.key ?? ''),
      model: String(row.model ?? ''),
      provider: String(row.provider ?? ''),
      // 缺 buckets 的账本行（早期版本/异常写入）保持 null：不确定就是不确定，不按 0 算。
      b: row.b && typeof row.b === 'object' ? row.b : null
    };
    const dedupeKey = `${sid}|${candidate.turn}|${candidate.step}|${candidate.retry}`;
    const prev = byKey.get(dedupeKey);
    if (!prev || compareOrder(prev, candidate) <= 0) byKey.set(dedupeKey, candidate);
  }
  return [...byKey.values()].sort(compareOrder);
}

/** 最近秩百分位（不做插值：样本少时插值会给出不存在的「平滑」值）。 */
export function percentile(sortedValues, p) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return 0;
  const q = Math.min(1, Math.max(0, Number(p) || 0));
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(q * sortedValues.length) - 1));
  return sortedValues[idx];
}

function ratio(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 10_000) / 10_000;
}

/**
 * 成本侧聚合：单步水位分布 + 按日累计 + 无输出轮占比。
 * @param {Array<object>} rows parseTokenRows() 的产物
 * @param {{now?:number, windowDays?:number, nearZeroOutputTokens?:number}} [options]
 */
export function summarizeTurns(rows, options = {}) {
  const now = num(options.now) || Date.now();
  const windowDays = clampWindowDays(options.windowDays);
  const threshold = Number.isFinite(Number(options.nearZeroOutputTokens))
    ? Math.max(0, Math.floor(Number(options.nearZeroOutputTokens)))
    : OPS_DEFAULTS.nearZeroOutputTokens;
  const fromMs = startOfLocalDay(now) - (windowDays - 1) * DAY_MS;

  const steps = [];
  const days = new Map();
  const turns = new Map();

  let unmeasured = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.t < fromMs) continue;
    const buckets = row.b;
    if (!buckets) {
      // 没有 token 分桶的行不猜测：既不算进分位，也不算进「无输出」。
      unmeasured += 1;
      continue;
    }
    const wm = watermarkOf(buckets);
    const output = num(buckets.output);
    const date = dayKey(row.t);
    steps.push(wm);

    let day = days.get(date);
    if (!day) {
      day = { date, steps: 0, input: 0, output: 0, cacheHit: 0, cacheMiss: 0, cacheWrite: 0 };
      days.set(date, day);
    }
    day.steps += 1;
    // 与账本 inputTokens 同口径：miss + hit + write。
    day.input += wm;
    day.output += output;
    day.cacheHit += num(buckets.cacheHit);
    day.cacheMiss += num(buckets.cacheMiss);
    day.cacheWrite += num(buckets.cacheWrite);

    // 一轮 = sid + turn：output 跨步求和，才能判断「整轮有没有说话」。
    const turnKey = `${row.sid}|${row.turn}`;
    let t = turns.get(turnKey);
    if (!t) {
      t = { steps: 0, output: 0, t: row.t };
      turns.set(turnKey, t);
    }
    t.steps += 1;
    t.output += output;
    if (row.t < t.t) t.t = row.t;
  }

  const sortedWm = [...steps].sort((a, b) => a - b);
  let zeroOutputTurns = 0;
  let nearZeroOutputTurns = 0;
  for (const t of turns.values()) {
    if (t.output === 0) zeroOutputTurns += 1;
    if (t.output <= threshold) nearZeroOutputTurns += 1;
  }

  return {
    windowDays,
    from: dayKey(fromMs),
    to: dayKey(now),
    nearZeroOutputTokens: threshold,
    steps: steps.length,
    turns: turns.size,
    unmeasured,
    step: {
      count: sortedWm.length,
      avg: sortedWm.length ? Math.round(sortedWm.reduce((s, v) => s + v, 0) / sortedWm.length) : 0,
      p50: percentile(sortedWm, 0.5),
      p90: percentile(sortedWm, 0.9),
      p99: percentile(sortedWm, 0.99),
      max: sortedWm.length ? sortedWm[sortedWm.length - 1] : 0
    },
    silent: {
      turns: turns.size,
      zero: zeroOutputTurns,
      nearZero: nearZeroOutputTurns,
      zeroRatio: ratio(zeroOutputTurns, turns.size),
      nearZeroRatio: ratio(nearZeroOutputTurns, turns.size)
    },
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
  };
}

/**
 * 风格侧聚合：时间窗内的命中次数、删空/兜底分支、Top 规则。
 * 入参是 normalizeStats() 的产物（结构见 ai-tone-stats.js）。
 */
export function summarizeStyle(stats, options = {}) {
  const now = num(options.now) || Date.now();
  const windowDays = clampWindowDays(options.windowDays);
  const fromMs = startOfLocalDay(now) - (windowDays - 1) * DAY_MS;
  const from = dayKey(fromMs);
  const to = dayKey(now);
  const counters = { turns: 0, changed: 0, heavy: 0, fallback: 0, keepRaw: 0, nudge: 0, skip: 0, off: 0, rawChars: 0, cleanedChars: 0 };
  const rules = {};
  const daysSource = stats && typeof stats === 'object' && stats.days && typeof stats.days === 'object' ? stats.days : {};
  for (const [date, day] of Object.entries(daysSource)) {
    if (date < from || date > to) continue;
    if (!day || typeof day !== 'object') continue;
    for (const key of Object.keys(counters)) counters[key] += num(day[key]);
    for (const [id, count] of Object.entries(day.rules ?? {})) {
      const c = num(count);
      if (c > 0) rules[id] = (rules[id] || 0) + c;
    }
  }
  const hits = Object.values(rules).reduce((s, v) => s + v, 0);
  const top = Object.entries(rules)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([id, count]) => ({ id, count, share: ratio(count, hits) }));
  return {
    from,
    to,
    ...counters,
    hitTotal: hits,
    changedRate: ratio(counters.changed, counters.turns),
    removedRatio: counters.rawChars ? ratio(counters.rawChars - counters.cleanedChars, counters.rawChars) : 0,
    fallbackRate: ratio(counters.fallback, counters.turns),
    skipRate: ratio(counters.skip, counters.turns),
    topRules: top,
    ruleCount: Object.keys(rules).length
  };
}

/**
 * 面板数据：五个问题各给一段，另外附带原始明细供图表用。
 * @param {{aiToneStats?:object, rows?:Array<object>, now?:number, windowDays?:number}} input
 */
// 会话键脱敏：面板只看「哪个会话水位高」，不需要看到完整 QQ 号。
// private:100000001 → private:1000***001；group:100000002 → group:1000***002。
export function maskSessionKey(key) {
  const s = String(key ?? '');
  if (!s) return '';
  const idx = s.indexOf(':');
  const head = idx >= 0 ? s.slice(0, idx + 1) : '';
  const tail = idx >= 0 ? s.slice(idx + 1) : s;
  if ([...tail].length <= 6) return `${head}${tail}`;
  const chars = [...tail];
  return `${head}${chars.slice(0, 4).join('')}***${chars.slice(-3).join('')}`;
}

/**
 * C3 观察窗口：每个会话现在离硬线还有多远。
 * 水位缺失时给 'unknown'（不按 0 算，避免「看起来都很安全」的错觉）。
 */
export function summarizeBudget({ contextBudget, sessions = [] } = {}) {
  const cfg = contextBudget ?? {};
  const positive = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // 阈值缺失就是「不知道线在哪」，不能当 0：否则每个会话都会被判成 hard。
  const softAt = positive(cfg.softAt);
  const hardAt = positive(cfg.hardAt);
  const rows = (Array.isArray(sessions) ? sessions : []).map((s) => {
    // 没有水位时保持 null：既不能当 0（会显示成「很安全」），也不能当 unknown 的数值。
    const raw = s?.watermark;
    const watermark = Number.isFinite(raw) && raw >= 0 ? Number(raw) : null;
    // 阈值缺失时不能把 null 交给 classifier（它会回落到默认线，把大水位判成 hard）：
    // 「不知道线在哪」就是 unknown。
    const level = cfg.enabled === true && softAt !== null && hardAt !== null
      ? classifyContextWatermark(watermark, { enabled: true, softAt, hardAt })
      : 'unknown';
    return {
      key: maskSessionKey(s?.key),
      watermark,
      at: num(s?.at) || 0,
      level,
      pendingHandoff: s?.pendingHandoff === true,
      lastHandoffAt: num(s?.lastHandoffAt) || 0
    };
  });
  // 水位高的排前面：先看最危险的会话。
  rows.sort((a, b) => (b.watermark || 0) - (a.watermark || 0));
  const counts = { ok: 0, soft: 0, hard: 0, unknown: 0 };
  for (const r of rows) counts[r.level] = (counts[r.level] ?? 0) + 1;
  return {
    enabled: cfg.enabled === true,
    mode: cfg.mode === 'enforce' ? 'enforce' : 'shadow',
    softAt,
    hardAt,
    counts,
    rows
  };
}

/**
 * D1/O3 的观察窗口：wait 到底在不在空转吃步数。
 * 输入是 bridge 里那份内存态统计（key -> { calls, returned }），重启清零是它的既定语义。
 */
export function summarizeWait(sessions = [], persisted = null, now = Date.now()) {
  const list = Array.isArray(sessions) ? sessions : [];
  // 每轮 wait 次数分布：判「单轮 wait ≥3 次占比 >5% 才做上限」用的就是这几格。
  const turnBins = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let turnsWithWaits = 0;
  const rows = list.map((s) => {
    for (const bin of [1, 2, 3, 4]) {
      const n = Number(s?.turnBins?.[bin]) || 0;
      if (n > 0) {
        turnBins[bin] += n;
        turnsWithWaits += n;
      }
    }
    const calls = num(s?.calls) || 0;
    const returned = num(s?.returned) || 0;
    const empty = Math.min(num(s?.empty) || 0, calls);
    return {
      key: maskSessionKey(s?.key),
      calls,
      returned,
      // 「空转」= 等了一次但一条也没带回来；这类调用在成本上最亏。
      emptyCalls: empty,
      avgReturned: calls > 0 ? Math.round((returned / calls) * 10) / 10 : 0
    };
  });
  rows.sort((a, b) => b.calls - a.calls);
  const calls = rows.reduce((n, r) => n + r.calls, 0);
  const returned = rows.reduce((n, r) => n + r.returned, 0);
  const emptyCalls = rows.reduce((n, r) => n + r.emptyCalls, 0);
  const turnsWith3Plus = turnBins[3] + turnBins[4];
  // 长期累计（跨重启）：判据要读的是这一块 —— 内存态 daily 只回答「本次启动以来」。
  let soak = null;
  if (persisted && typeof persisted === 'object') {
    const pb = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const bin of [1, 2, 3, 4]) pb[bin] = Math.max(0, Math.floor(Number(persisted.turnBins?.[bin]) || 0));
    const pTurns = pb[1] + pb[2] + pb[3] + pb[4];
    const p3 = pb[3] + pb[4];
    const since = Number(persisted.since) || 0;
    soak = {
      since,
      updatedAt: Number(persisted.updatedAt) || 0,
      days: since > 0 ? Math.round(((now - since) / 86400000) * 10) / 10 : 0,
      turnBins: pb,
      turnsWithWaits: pTurns,
      turnsWith3Plus: p3,
      ratio3Plus: pTurns > 0 ? Math.round((p3 / pTurns) * 10000) / 10000 : 0
    };
  }
  return {
    calls,
    returned,
    emptyCalls,
    // 空转占比；没有调用时给 0 而不是 NaN。
    emptyRate: calls > 0 ? Math.round((emptyCalls / calls) * 10000) / 10000 : 0,
    avgReturned: calls > 0 ? Math.round((returned / calls) * 10) / 10 : 0,
    // O3 判据的分子/分母：分母只算「至少 wait 过一次」的轮次，没 wait 的轮次不该摊薄比例。
    turnBins,
    turnsWithWaits,
    turnsWith3Plus,
    ratio3Plus: turnsWithWaits > 0 ? Math.round((turnsWith3Plus / turnsWithWaits) * 10000) / 10000 : 0,
    soak,
    rows
  };
}

export function buildOpsPanel(input = {}) {
  const now = num(input.now) || Date.now();
  const windowDays = clampWindowDays(input.windowDays);
  const cost = summarizeTurns(input.rows ?? [], { now, windowDays });
  const style = summarizeStyle(input.aiToneStats ?? null, { now, windowDays });
  const budget = summarizeBudget({ contextBudget: input.contextBudget, sessions: input.budgetSessions });
  const wait = summarizeWait(input.waitSessions, input.waitPersisted ?? null, Number(input.now) || Date.now());
  const empty = cost.steps === 0 && style.turns === 0;
  return {
    ok: true,
    version: OPS_PANEL_VERSION,
    generatedAt: now,
    window: { days: windowDays, from: cost.from, to: cost.to },
    empty,
    questions: {
      // 1. 单步上下文水位
      stepWatermark: cost.step,
      // 2. 每日累计输入
      dailyInput: cost.days.map((d) => ({ date: d.date, input: d.input, output: d.output, steps: d.steps })),
      // 3. Top5 规则
      topRules: style.topRules,
      // 4. 删空 / 兜底 / 跳过
      deletions: {
        turns: style.turns,
        changed: style.changed,
        changedRate: style.changedRate,
        removedRatio: style.removedRatio,
        fallback: style.fallback,
        fallbackRate: style.fallbackRate,
        keepRaw: style.keepRaw,
        nudge: style.nudge,
        skip: style.skip,
        skipRate: style.skipRate,
        off: style.off,
        rawChars: style.rawChars,
        cleanedChars: style.cleanedChars
      },
      // 5. 无输出轮占比
      silentRate: cost.silent,
      // 6. 上下文水位（C3 观察窗口：谁快到硬线了）
      budget,
      // 7. 等待是否空转（D1/O3 观察窗口；wait.soak 是跨重启的长期分布）
      wait
    },
    details: {
      costDays: cost.days,
      styleWindow: style,
      ruleCount: style.ruleCount,
      hitTotal: style.hitTotal,
      steps: cost.steps,
      turns: cost.turns
    }
  };
}
