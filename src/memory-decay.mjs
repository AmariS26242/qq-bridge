// 记忆过期降权（纯逻辑层）。
//
// 目标：QQ 会话里的轻量记忆（activeTopic / pendingThought / memberImpression）
// 不再全量拼进 prompt。按「最近活跃时间 + 被引用次数 + 是否过期」算一个 0..1 的
// 权重，注入时先排序，再把低分条目折叠成一条摘要，并对总字符数封顶。
//
// 约定：
// - 全部函数无副作用、不读磁盘、不读 config；`now` 由调用方传入（缺省 Date.now()）。
// - 输入条目是普通对象，常用字段：
//     text/category|kind、updatedAt|lastUsedAt|createdAt|lastMentionAt|lastSeenAt、
//     hits|hitCount|useCount|interactionCount、expiresAt、name|target。
// - 输出永远是新数组/新对象，不改入参（bridge.js 的状态对象不能被这里污染）。
//
// 接线由主智能体在 bridge.js 完成（见 docs/guides/MEMORY_DECAY.md），本模块不 import
// 任何东西，也不依赖 bridge.js。

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

/** 默认衰减配置。调用方可用 cfg 覆盖任意键。 */
export const DEFAULT_DECAY_CFG = Object.freeze({
  halfLifeDays: 7,
  pendingFloor: 0.35,
  foldThreshold: 0.15,
  foldMinCount: 3,
  maxChars: 1200,
  expiredGraceHours: 24
});

// 单条记忆渲染时的文本硬截断（与 bridge.js 里 memory 内容的 200 字上限一致）。
const MAX_LINE_TEXT = 200;

const KIND_LABELS = Object.freeze({
  activeTopic: '话题',
  pendingThought: '待说',
  memberImpression: '印象'
});

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 合并并夹紧配置；非法值回落到默认值，绝不让 NaN 漏进计算。 */
function resolveCfg(cfg) {
  const src = cfg && typeof cfg === 'object' ? cfg : {};
  const pick = (key, min, max, integer = false) => {
    const raw = finiteOr(src[key], DEFAULT_DECAY_CFG[key]);
    const clamped = Math.min(max, Math.max(min, raw));
    return integer ? Math.floor(clamped) : clamped;
  };
  return {
    halfLifeDays: pick('halfLifeDays', 0.01, 3650),
    pendingFloor: pick('pendingFloor', 0, 1),
    foldThreshold: pick('foldThreshold', 0, 1),
    foldMinCount: pick('foldMinCount', 1, 100000, true),
    maxChars: pick('maxChars', 1, 1000000, true),
    expiredGraceHours: pick('expiredGraceHours', 0, 876000)
  };
}

/**
 * 把时间字段转成毫秒时间戳。
 * 支持 Date / 毫秒数 / 秒数（10 位）/ 数字字符串 / ISO 字符串。
 * 缺失或非法一律返回 null（由调用方决定兜底口径）。
 */
function toMs(value) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (!Number.isSafeInteger(n) || n <= 0) return null;
      // 10 位按秒（Unix 秒）解释，其余按毫秒。
      return s.length === 10 ? n * 1000 : n;
    }
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** 最近一次活跃时间：取所有已知时间字段里的最大值。 */
function lastActivityAt(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const keys = ['updatedAt', 'lastUsedAt', 'createdAt', 'lastMentionAt', 'lastSeenAt'];
  let latest = null;
  for (const key of keys) {
    const t = toMs(entry[key]);
    if (t != null && (latest == null || t > latest)) latest = t;
  }
  return latest;
}

/** 记忆类别；显式 category/kind/type 优先，缺失时按字段特征兜底。 */
function memoryKind(entry) {
  if (!entry || typeof entry !== 'object') return 'unknown';
  const raw = String(entry.category ?? entry.kind ?? entry.type ?? '').trim();
  if (raw === 'activeTopic' || raw === 'topic') return 'activeTopic';
  if (raw === 'pendingThought' || raw === 'thought') return 'pendingThought';
  if (raw === 'memberImpression' || raw === 'impression') return 'memberImpression';
  if (entry.motivation != null || entry.expiresAt != null) return 'pendingThought';
  if (entry.traits != null || entry.interactionCount != null) return 'memberImpression';
  if (entry.participants != null || entry.pendingQuestion != null) return 'activeTopic';
  return 'unknown';
}

function hitCount(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  const raw = entry.hits ?? entry.hitCount ?? entry.useCount ?? entry.interactionCount ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isExpired(entry, nowMs) {
  if (!entry || typeof entry !== 'object') return false;
  const exp = toMs(entry.expiresAt);
  return exp != null && nowMs >= exp;
}

/**
 * 单条记忆权重，0..1。
 * - 以半衰期衰减（默认 7 天），14 天约剩 0.25；
 * - hits 提供温和加成（log2，最多 2 倍）；
 * - 已过 expiresAt 的条目再乘 0.1 并继续半衰，允许折叠/裁剪；
 * - 未过期的 pendingThought 有 pendingFloor 下限（待办不能被当成噪音清掉）。
 * - 时间字段缺失/非法按「已过一个半衰期」计 0.5：既不过度优待也不误杀。
 */
export function decayScore(entry, now, cfg) {
  if (!entry || typeof entry !== 'object') return 0;
  const c = resolveCfg(cfg);
  const nowMs = toMs(now) ?? Date.now();
  const kind = memoryKind(entry);
  const at = lastActivityAt(entry);
  const halfLifeMs = c.halfLifeDays * MS_PER_DAY;

  let score;
  if (at == null) {
    score = 0.5;
  } else {
    // 未来时间（时钟回拨/脏数据）按刚更新处理。
    const ageMs = Math.max(0, nowMs - at);
    score = Math.pow(0.5, ageMs / halfLifeMs);
  }

  const hits = hitCount(entry);
  if (hits > 0) {
    score *= Math.min(2, 1 + 0.15 * Math.log2(1 + hits));
  }

  if (isExpired(entry, nowMs)) {
    const overMs = Math.max(0, nowMs - (toMs(entry.expiresAt) ?? nowMs));
    score *= 0.1 * Math.pow(0.5, overMs / halfLifeMs);
  } else if (kind === 'pendingThought') {
    score = Math.max(score, c.pendingFloor);
  }

  return clamp01(score);
}

/**
 * 按分数降序排列，稳定（同分保持入参顺序）。
 * 返回新数组，元素为 `{...entry, _score}`，入参对象不被修改。
 */
export function rankMemories(list, now, cfg) {
  const arr = Array.isArray(list) ? list : [];
  const nowMs = toMs(now) ?? Date.now();
  return arr
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry && typeof entry === 'object')
    .map(({ entry, index }) => ({ entry, index, score: decayScore(entry, nowMs, cfg) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map(({ entry, score }) => ({ ...entry, _score: score }));
}

/**
 * 折叠低分条目：分数 < foldThreshold 的条目（未过期的 pendingThought 除外）
 * 数量达到 foldMinCount 时并成一条 `{folded:true, count, text}` 摘要，追加在末尾。
 * 返回新数组；不删除/不修改任何入参对象。未达 foldMinCount 时原样排序返回。
 */
export function foldMemories(list, now, cfg) {
  const c = resolveCfg(cfg);
  const nowMs = toMs(now) ?? Date.now();
  const ranked = rankMemories(list, nowMs, c);
  const keep = [];
  const stale = [];
  for (const entry of ranked) {
    const kind = memoryKind(entry);
    const neverFold = kind === 'pendingThought' && !isExpired(entry, nowMs);
    if (entry._score < c.foldThreshold && !neverFold) stale.push(entry);
    else keep.push(entry);
  }
  if (stale.length < c.foldMinCount) return ranked;

  const kinds = new Set(stale.map((entry) => memoryKind(entry)));
  const label = kinds.size === 1 && kinds.has('memberImpression') ? '印象' : '记忆';
  const folded = {
    folded: true,
    count: stale.length,
    text: `较早的 ${stale.length} 条${label}已被折叠`,
    _score: 0
  };
  return [...keep, folded];
}

function clipText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '（无内容）';
  return text.length > MAX_LINE_TEXT ? `${text.slice(0, MAX_LINE_TEXT - 1)}…` : text;
}

function renderLine(entry) {
  if (entry.folded) {
    return { text: `…${clipText(entry.text)}`, weight: Math.max(1, Math.floor(finiteOr(entry.count, 1))) };
  }
  const kind = memoryKind(entry);
  const label = KIND_LABELS[kind] || '记忆';
  const name = String(entry.name ?? entry.target ?? '').trim();
  const who = kind === 'memberImpression' && name ? `·${name}` : '';
  return { text: `- ${label}${who}：${clipText(entry.text)}`, weight: 1 };
}

/**
 * 生成注入 prompt 的中文文本块。
 * 顺序 = 分数降序；超过 maxChars（默认 1200 字符，硬上限）时从最低分开始丢，
 * 末尾补 `（已省略 N 条较早记忆）`，N 按被丢掉的真实记忆条数累计（折叠项按其 count 计）。
 * 内部先按 pruneExpired 裁掉超过宽限期的过期待办，过期记忆不会被注入。
 * 空输入返回 ''；任何情况下返回长度 ≤ maxChars。
 */
export function buildMemoryPromptBlock(list, now, cfg) {
  const c = resolveCfg(cfg);
  const nowMs = toMs(now) ?? Date.now();
  const items = foldMemories(pruneExpired(list, nowMs, c), nowMs, c);
  if (!items.length) return '';
  const lines = items.map(renderLine);

  const join = (keepCount, omittedCount) => {
    const body = lines.slice(0, keepCount).map((line) => line.text).join('\n');
    const tail = omittedCount > 0 ? `（已省略 ${omittedCount} 条较早记忆）` : '';
    if (!body) return tail;
    return tail ? `${body}\n${tail}` : body;
  };
  const omittedFrom = (keepCount) => lines.slice(keepCount).reduce((sum, line) => sum + line.weight, 0);

  let keepCount = lines.length;
  let out = join(keepCount, 0);
  while (keepCount > 0 && out.length > c.maxChars) {
    keepCount -= 1;
    out = join(keepCount, omittedFrom(keepCount));
  }
  // 极端情况：maxChars 比省略文案本身还短，只能硬切。
  if (out.length > c.maxChars) out = out.slice(0, c.maxChars);
  return out;
}

/**
 * 裁剪记忆：移除 expiresAt 已过且超过宽限期（默认 24h）的 pendingThought。
 * 返回新数组；未过期/宽限期内/非 pendingThought 条目原样保留（对象引用不变）。
 */
export function pruneExpired(list, now, cfg) {
  const c = resolveCfg(cfg);
  const nowMs = toMs(now) ?? Date.now();
  const graceMs = c.expiredGraceHours * MS_PER_HOUR;
  return (Array.isArray(list) ? list : []).filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (memoryKind(entry) !== 'pendingThought') return true;
    const exp = toMs(entry.expiresAt);
    if (exp == null) return true;
    return nowMs - exp <= graceMs;
  });
}
