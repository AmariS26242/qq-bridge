/**
 * 去 AI 味度量聚合（docs/AI-TONE-SOLUTION.md 的 P0-1）。
 *
 * 为什么要有这个文件：清洗层（src/ai-tone.js）以前只写一行滚动日志，谁也不知道
 * 命中率是多少、哪条规则在群里天天误伤、被删空的比例有多高。没有度量就只能靠
 * 「感觉最近怪怪的」来调规则。这里把每次出站决策压成**纯聚合数**：
 * 每天、每条规则 id 的命中次数 + 清洗前后字符数 + 兜底分支计数。
 *
 * 隐私红线：只落地规则 id 与字符数，**绝不落地原文**。这个文件在 state/ 下，
 * 控制台（包括手机）能读，存原文等于把群聊内容复制到第二个地方。
 */

export const AI_TONE_STATS_DEFAULTS = Object.freeze({
  enabled: true,
  // 保留多少天。超过就剪掉，避免一年后变成几十万行 JSON。
  keepDays: 30
});

export const AI_TONE_STATS_VERSION = 1;

/** 配置夹紧：非法值回落默认，别让一个字符串把统计写进奇怪的日期桶。 */
export function normalizeAiToneStatsConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const keepDays = Number(cfg.keepDays);
  return {
    enabled: cfg.enabled !== false,
    keepDays: Number.isFinite(keepDays) && keepDays >= 1
      ? Math.min(365, Math.floor(keepDays))
      : AI_TONE_STATS_DEFAULTS.keepDays
  };
}

/** 本地日期（按机器时区分桶，跟日志时间对齐；不用 UTC，否则「昨天」会错位）。 */
export function dayKey(atMs = Date.now()) {
  const d = new Date(Number(atMs) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function emptyStats() {
  return { version: AI_TONE_STATS_VERSION, updatedAt: 0, days: {} };
}

function emptyDay(date) {
  return {
    date,
    turns: 0,        // deslopOutgoing 决策次数
    changed: 0,      // 文本真的被改写
    heavy: 0,        // 删得太多（>60%），仍发清洗后文本
    fallback: 0,     // hits 里出现 fallback（被删空）
    keepRaw: 0,      // 删空但有实质信息 → 发原文
    nudge: 0,        // 删空 → 发兜底（「嗯」）
    skip: 0,         // 删空且没信息 → 不发
    off: 0,          // 兜底策略 off → 交上层
    rawChars: 0,
    cleanedChars: 0,
    rules: {}
  };
}

const COUNTER_KEYS = ['turns', 'changed', 'heavy', 'fallback', 'keepRaw', 'nudge', 'skip', 'off', 'rawChars', 'cleanedChars'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** 读回来时逐字段校验：state 文件可能被手改 / 被旧版本写过，坏字段直接丢掉而不是让统计崩。 */
export function normalizeStats(raw) {
  const src = raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object' ? raw : null;
  const stats = emptyStats();
  if (!src) return stats;
  stats.updatedAt = num(src.updatedAt);
  for (const [date, day] of Object.entries(src.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !day || typeof day !== 'object') continue;
    const clean = emptyDay(date);
    for (const key of COUNTER_KEYS) clean[key] = num(day[key]);
    if (day.rules && typeof day.rules === 'object') {
      for (const [id, count] of Object.entries(day.rules)) {
        const c = num(count);
        if (c > 0) clean.rules[id] = c;
      }
    }
    stats.days[date] = clean;
  }
  return stats;
}

/**
 * 记一次出站决策（就地修改传入的 stats，调用方负责落盘）。
 * @param {object} stats normalizeStats() 的产物
 * @param {{at?:number, rawLen?:number, cleanedLen?:number, hits?:string[], changed?:boolean,
 *          action?:string, hasFallback?:boolean}} entry
 */
export function recordOutgoing(stats, entry = {}) {
  const st = stats && typeof stats === 'object' ? stats : emptyStats();
  if (!st.days) st.days = {};
  const at = num(entry.at) || Date.now();
  const date = dayKey(at);
  const day = st.days[date] ?? (st.days[date] = emptyDay(date));

  day.turns += 1;
  if (entry.changed) day.changed += 1;
  const action = String(entry.action ?? 'normal');
  if (action === 'heavy') day.heavy += 1;
  else if (action === 'keep-raw') day.keepRaw += 1;
  else if (action === 'nudge') day.nudge += 1;
  else if (action === 'skip') day.skip += 1;
  else if (action === 'off') day.off += 1;

  const hits = Array.isArray(entry.hits) ? entry.hits : [];
  if (entry.hasFallback || hits.includes('fallback')) day.fallback += 1;
  day.rawChars += num(entry.rawLen);
  day.cleanedChars += num(entry.cleanedLen);
  for (const id of hits) {
    const key = String(id ?? '').trim();
    if (!key) continue;
    day.rules[key] = (day.rules[key] || 0) + 1;
  }
  st.updatedAt = at;
  return day;
}

/** 剪枝：只保留最近 keepDays 天（含今天）。返回被删掉的天数，方便日志里说一句。 */
export function pruneStats(stats, options = {}) {
  const st = stats && typeof stats === 'object' ? stats : emptyStats();
  const cfg = normalizeAiToneStatsConfig(options);
  const keep = new Set();
  const now = Date.now();
  for (let i = -1; i <= cfg.keepDays; i++) keep.add(dayKey(now - i * 86_400_000));
  let dropped = 0;
  for (const date of Object.keys(st.days ?? {})) {
    if (!keep.has(date)) {
      delete st.days[date];
      dropped += 1;
    }
  }
  return dropped;
}

function ratio(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 10_000) / 10_000;
}

/**
 * 汇总给 /api/ai-tone/stats 用。
 * days 按日期升序；rules 按命中次数降序（控制台直接按这个顺序渲染）。
 */
export function summarizeStats(stats, options = {}) {
  const st = stats && typeof stats === 'object' ? stats : emptyStats();
  const days = Object.keys(st.days ?? {}).sort().map((d) => st.days[d]);
  const totals = {
    turns: 0,
    changed: 0,
    heavy: 0,
    fallback: 0,
    keepRaw: 0,
    nudge: 0,
    skip: 0,
    off: 0,
    rawChars: 0,
    cleanedChars: 0
  };
  const rules = {};
  for (const day of days) {
    for (const key of COUNTER_KEYS) totals[key] += num(day[key]);
    for (const [id, count] of Object.entries(day.rules ?? {})) rules[id] = (rules[id] || 0) + num(count);
  }
  const topRules = Object.entries(rules)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, count]) => ({ id, count }));

  return {
    version: AI_TONE_STATS_VERSION,
    updatedAt: num(st.updatedAt),
    today: dayKey(options.atMs),
    days: days.length,
    totals: {
      ...totals,
      changedRate: ratio(totals.changed, totals.turns),
      fallbackRate: ratio(totals.fallback, totals.turns),
      skipRate: ratio(totals.skip, totals.turns),
      removedRatio: totals.rawChars ? ratio(totals.rawChars - totals.cleanedChars, totals.rawChars) : 0,
      avgRawChars: totals.turns ? Math.round((totals.rawChars / totals.turns) * 10) / 10 : 0,
      avgCleanedChars: totals.turns ? Math.round((totals.cleanedChars / totals.turns) * 10) / 10 : 0
    },
    rules: topRules,
    ruleCount: topRules.length,
    daily: days.map((d) => ({ ...d }))
  };
}
