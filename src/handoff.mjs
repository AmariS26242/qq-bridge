// 会话交接（handoff）：校验结构化交接摘要、生成注入行、判断是否该交接，
// 以及把摘要原子落盘并只保留最近 N 份。
// 只依赖 node:fs / node:path；敏感词清洗由调用方通过 opts.scrub 注入，不耦合仓库内其他模块。
import fs from 'node:fs';
import path from 'node:path';

/** 交接摘要的结构版本号。 */
export const HANDOFF_SCHEMA_VERSION = 1;
/** 交接摘要 JSON 序列化后的字符上限（按 JS 字符串长度计）。 */
export const HANDOFF_MAX_CHARS = 400;

/** 四个字符串数组字段。 */
const LIST_FIELDS = ['topics', 'openLoops', 'peopleChange', 'insideJokes'];
/** 摘要里所有属于 payload 的字段（read 时用来把 meta 和 payload 拆开）。 */
const PAYLOAD_FIELDS = ['schemaVersion', ...LIST_FIELDS, 'mood'];
/** 单个数组最多条目数。 */
const MAX_ITEMS = 8;
/** 单条文本最多码点数。 */
const MAX_ITEM_CHARS = 40;
/** 控制字符：统一替换为空格。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** scrub 抛出的专用错误，便于和其他内部异常区分。 */
class ScrubError extends Error {}

/** 判断是否是「普通对象」：排除 null / 数组 / 字符串 / 数字等。 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 按码点取长度，避免把 emoji 的代理对算成两个字符。 */
function codePointLength(text) {
  return [...text].length;
}

/** 空摘要：所有字段都在，数组为空、mood 为空串。 */
export function emptyHandoffPayload() {
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    topics: [],
    openLoops: [],
    peopleChange: [],
    insideJokes: [],
    mood: '',
  };
}

/**
 * 校验并归一化交接摘要。从不抛异常。
 * 成功：{ok:true, value}；失败：{ok:false, reason}。
 */
export function normalizeHandoffPayload(raw, opts = {}) {
  try {
    if (!isPlainObject(raw)) return { ok: false, reason: 'not-object' };

    // 版本号：只有显式写了且不等于 1 才拒绝（缺省视为当前版本）。
    if (
      Object.prototype.hasOwnProperty.call(raw, 'schemaVersion') &&
      raw.schemaVersion !== HANDOFF_SCHEMA_VERSION
    ) {
      return { ok: false, reason: `bad-schema-version:${String(raw.schemaVersion)}` };
    }

    // 字段类型：四个数组字段 + mood 字符串字段。
    for (const field of LIST_FIELDS) {
      if (raw[field] === undefined) continue;
      if (!Array.isArray(raw[field])) return { ok: false, reason: `field-not-array:${field}` };
    }
    if (raw.mood !== undefined && typeof raw.mood !== 'string') {
      return { ok: false, reason: 'field-not-string:mood' };
    }

    // 数组长度与元素类型先校验，避免把非字符串塞进 scrub。
    for (const field of LIST_FIELDS) {
      const list = raw[field];
      if (!Array.isArray(list)) continue;
      if (list.length > MAX_ITEMS) return { ok: false, reason: `too-many:${field}` };
      for (const item of list) {
        if (typeof item !== 'string') return { ok: false, reason: `not-string:${field}` };
      }
    }

    const scrub = typeof opts.scrub === 'function' ? opts.scrub : null;
    /** 先过注入的清洗函数；清洗函数抛异常时转成 ScrubError。 */
    const cleanText = (text) => {
      if (!scrub) return text;
      let scrubbed;
      try {
        scrubbed = scrub(text);
      } catch {
        throw new ScrubError('scrub');
      }
      // 清洗函数返回空值视为删除该项。
      return scrubbed === null || scrubbed === undefined ? '' : String(scrubbed);
    };

    const value = emptyHandoffPayload();
    try {
      for (const field of LIST_FIELDS) {
        const seen = new Set();
        for (const item of raw[field] ?? []) {
          const text = cleanText(item).replace(CONTROL_CHARS, ' ').trim();
          if (!text) continue; // 丢掉空串
          if (codePointLength(text) > MAX_ITEM_CHARS) {
            return { ok: false, reason: `too-long:${field}` };
          }
          if (seen.has(text)) continue; // 去重，保留首次出现顺序
          seen.add(text);
          value[field].push(text);
        }
      }
      if (typeof raw.mood === 'string') {
        value.mood = cleanText(raw.mood).replace(CONTROL_CHARS, ' ').trim();
      }
    } catch (error) {
      if (error instanceof ScrubError) return { ok: false, reason: 'scrub-failed' };
      return { ok: false, reason: 'normalize-failed' };
    }

    // 整份摘要序列化后的总长度上限。调用方可传更小的 opts.maxChars（兜底组装只用一段短文本）。
    const totalMax = Number.isFinite(Number(opts.maxChars))
      ? Math.min(HANDOFF_MAX_CHARS, Math.max(1, Math.floor(Number(opts.maxChars))))
      : HANDOFF_MAX_CHARS;
    if (JSON.stringify(value).length > totalMax) {
      return { ok: false, reason: 'too-large' };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, reason: 'internal-error' };
  }
}

/** 读取字符串数组字段：防御式过滤，避免坏 payload 让注入行构造函数抛异常。 */
function readStringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * 交接摘要「只注入一次」的判定（O1 enforce 阶段）。
 *
 * 为什么要单独抽出来：交接行如果每轮都注入，新会话会一直以为「刚从上个会话交接过来」，
 * 并且每轮白付几十个字符。而交接文件本身必须留着（排障、回读），所以不能靠删文件来去重，
 * 只能给每份交接一个 id，注入一次后记住「已经注入过哪一份」。
 *
 * id 的取法（调用方负责）：优先用写入时的 `lastHandoffAt`，回读磁盘时用文件的 `generatedAt`。
 *
 * @param {{mode?:string, preview?:boolean, pendingId?:string, injectedId?:string}} opts
 * @returns {'inject'|'skip-mode'|'skip-none'|'skip-consumed'}
 */
export function handoffInjectionDecision({ mode, preview = false, pendingId, injectedId } = {}) {
  if (mode !== 'enforce') return 'skip-mode';
  const pending = typeof pendingId === 'string' ? pendingId.trim() : '';
  if (!pending) return 'skip-none';
  // 预览（控制台/工具）只展示、不消耗：否则看一眼就把真实唤醒的交接吃掉了。
  if (preview) return 'inject';
  const done = typeof injectedId === 'string' ? injectedId.trim() : '';
  if (pending === done) return 'skip-consumed';
  return 'inject';
}

/**
 * 生成注入行；全空返回空串。
 * 中文标签顺序固定：话题 / 未完 / 人物变化 / 氛围 / 梗。
 */
export function buildHandoffLine(payload, { maxChars = 600 } = {}) {
  try {
    const segments = [];
    const topics = readStringList(payload?.topics);
    const openLoops = readStringList(payload?.openLoops);
    const peopleChange = readStringList(payload?.peopleChange);
    const insideJokes = readStringList(payload?.insideJokes);
    const mood = typeof payload?.mood === 'string' ? payload.mood.trim() : '';

    if (topics.length) segments.push(`话题：${topics.join('、')}`);
    if (openLoops.length) segments.push(`未完：${openLoops.join('、')}`);
    if (peopleChange.length) segments.push(`人物变化：${peopleChange.join('、')}`);
    if (mood) segments.push(`氛围：${mood}`);
    if (insideJokes.length) segments.push(`梗：${insideJokes.join('、')}`);
    if (!segments.length) return '';

    const line = `【上次交接】${segments.join('；')}`;
    const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 600;
    const chars = [...line];
    if (chars.length <= limit) return line;
    if (limit <= 0) return '';
    // 按码点截断，留一个位置给省略号，保证总长度不超过 maxChars。
    return `${chars.slice(0, limit - 1).join('')}…`;
  } catch {
    return '';
  }
}

/**
 * 记忆区为空时的兜底：用最近几条消息拼一份交接摘要。
 *
 * 为什么需要：交接的价值是「省上下文但保住连续性」。如果 activeTopics /
 * pendingThoughts / memberImpressions 都是空的，照记忆交出来的就是空壳——
 * 上下文是省了，新会话却什么都不记得。这时退而用最近的对话内容兜底。
 *
 * 全部按 src/handoff.mjs 的硬限制裁剪：单条 ≤ MAX_ITEM_CHARS 码点、
 * 每字段 ≤ MAX_ITEMS 条、整份 JSON ≤ HANDOFF_MAX_CHARS；超限时按
 * 「先减条目、再缩单条」的固定顺序降级，保证同一输入永远得到同一结果。
 *
 * @param {Array<{text?:string, plain?:string}>} messages 最近消息（新的在尾部）
 * @param {{maxMessages?:number, maxChars?:number}} [opts]
 * @returns {{ok:true, value:object, used:{messages:number, items:number}} | {ok:false, reason:string}}
 */
export function buildHandoffFromRecent(messages, opts = {}) {
  try {
    const maxMessages = clampInt(opts.maxMessages ?? 6, 1, MAX_ITEMS);
    const maxChars = clampInt(opts.maxChars ?? HANDOFF_MAX_CHARS, 1, HANDOFF_MAX_CHARS);
    const list = Array.isArray(messages) ? messages : [];
    const texts = list
      .map((m) => {
        if (m === null || m === undefined) return '';
        if (typeof m === 'string') return m;
        const raw = typeof m.text === 'string' ? m.text : typeof m.plain === 'string' ? m.plain : '';
        return raw;
      })
      .map((t) => String(t).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(-maxMessages);
    if (!texts.length) return { ok: false, reason: 'no-messages' };

    const clip = (text, n) => {
      const chars = [...text];
      return chars.length <= n ? text : `${chars.slice(0, Math.max(0, n - 1)).join('')}…`;
    };

    // 降级梯度：先保话题 + 两条未完，失败则只留话题，最后只留最短话题。
    const last = texts[texts.length - 1];
    const earlier = texts.slice(0, -1).slice(-2).reverse();
    const attempts = [
      { topics: [`在聊：${last}`], openLoops: earlier },
      { topics: [`在聊：${last}`], openLoops: [] },
      { topics: [last], openLoops: [] }
    ];
    for (const attempt of attempts) {
      const raw = {
        schemaVersion: HANDOFF_SCHEMA_VERSION,
        topics: attempt.topics.map((t) => clip(t, MAX_ITEM_CHARS)),
        openLoops: attempt.openLoops.map((t) => clip(t, MAX_ITEM_CHARS)),
        peopleChange: [],
        insideJokes: [],
        mood: ''
      };
      const normalized = normalizeHandoffPayload(raw, {
        maxChars,
        scrub: typeof opts.scrub === 'function' ? opts.scrub : undefined
      });
      if (normalized.ok) {
        const items = normalized.value.topics.length + normalized.value.openLoops.length;
        return { ok: true, value: normalized.value, used: { messages: texts.length, items } };
      }
      if (normalized.reason !== 'too-long:topics' && normalized.reason !== 'too-large') {
        return { ok: false, reason: normalized.reason };
      }
    }
    return { ok: false, reason: 'too-large' };
  } catch {
    return { ok: false, reason: 'internal-error' };
  }
}

/** 把数值夹到 [lo, hi] 的整数区间；非法值退回 lo。 */
function clampInt(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/**
 * 判断当前是不是安全交接点。只有上游已置 pending、且空闲够久、且离上次交接够久才放行。
 * 返回 {ok:boolean, reason:string}。
 */
export function shouldRunHandoff({
  now,
  lastRelevantAt,
  lastHandoffAt,
  pending = false,
  idleMs = 300000,
  minIntervalMs = 21600000,
} = {}) {
  try {
    if (pending !== true) return { ok: false, reason: 'not-pending' };
    const current = Number.isFinite(now) ? now : Date.now();
    const idle = Number.isFinite(idleMs) ? idleMs : 300000;
    const gap = Number.isFinite(minIntervalMs) ? minIntervalMs : 21600000;
    // 没有观测到任何相关活动，无法确认是安全点。
    if (!Number.isFinite(lastRelevantAt)) return { ok: false, reason: 'no-activity' };
    if (current - lastRelevantAt < idle) return { ok: false, reason: 'no-activity' };
    // 从未交接（lastHandoffAt 缺失）视为满足最小间隔。
    if (Number.isFinite(lastHandoffAt) && current - lastHandoffAt < gap) {
      return { ok: false, reason: 'too-soon' };
    }
    return { ok: true, reason: 'ready' };
  } catch {
    return { ok: false, reason: 'invalid-input' };
  }
}

/** 把正则元字符转义，供按 safeKey 匹配归档文件名。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 创建交接持久化存储。
 * 目录布局：`${safeKey}.json` 是最新交接；`${safeKey}.${generatedAt}.json` 是归档。
 * 所有方法都不抛异常。
 */
export function createHandoffStore({ dir, log = () => {}, now = Date.now, maxKeep = 3 } = {}) {
  // 目录非法时所有方法都返回失败，而不是抛异常。
  const rootDir = typeof dir === 'string' && dir.trim() ? path.resolve(dir) : '';
  const keep = Number.isFinite(maxKeep) && maxKeep >= 1 ? Math.floor(maxKeep) : 3;
  const logger = typeof log === 'function' ? log : () => {};

  /** 日志本身失败不能影响主流程。 */
  const safeLog = (message) => {
    try {
      logger(String(message));
    } catch {
      /* 忽略日志异常 */
    }
  };

  /** safeKey 只保留 [A-Za-z0-9_.-]，其他字符（含 :、emoji、空格）逐个替换为 _。 */
  const safeKeyOf = (key) => {
    const text = key === null || key === undefined ? '' : String(key);
    const safe = text.replace(/[^A-Za-z0-9_.-]/gu, '_');
    return safe || '_';
  };

  const latestPathOf = (safeKey) => path.join(rootDir, `${safeKey}.json`);
  const archivePathOf = (safeKey, generatedAt) => path.join(rootDir, `${safeKey}.${generatedAt}.json`);

  /** 当前时间：now() 抛异常或返回非法值时退回 Date.now()。 */
  const currentTime = () => {
    try {
      const value = Number(now());
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  };

  /** 列出某个 key 的归档文件，按 generatedAt 从新到旧。 */
  const listArchives = (safeKey) => {
    const pattern = new RegExp(`^${escapeRegExp(safeKey)}\\.(-?\\d+)\\.json$`);
    const found = [];
    for (const name of fs.readdirSync(rootDir)) {
      const match = pattern.exec(name);
      if (!match) continue;
      found.push({ name, generatedAt: Number(match[1]) });
    }
    // 时间戳相同时按文件名倒序，保证结果稳定。
    found.sort((a, b) => b.generatedAt - a.generatedAt || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    return found;
  };

  /** 读最新交接。坏 JSON 返回 corrupt，绝不抛。 */
  const read = (key) => {
    try {
      if (!rootDir) return { ok: false, reason: 'no-dir' };
      const safeKey = safeKeyOf(key);
      const file = latestPathOf(safeKey);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return { ok: false, reason: 'missing' };
        return { ok: false, reason: `read-failed:${error?.code || 'io'}` };
      }
      let record;
      try {
        record = JSON.parse(text);
      } catch {
        return { ok: false, reason: 'corrupt' };
      }
      if (!isPlainObject(record)) return { ok: false, reason: 'corrupt' };
      const rawPayload = {};
      for (const field of PAYLOAD_FIELDS) rawPayload[field] = record[field];
      const normalized = normalizeHandoffPayload(rawPayload);
      if (!normalized.ok) return { ok: false, reason: 'corrupt' };
      const meta = {};
      for (const [name, value] of Object.entries(record)) {
        if (PAYLOAD_FIELDS.includes(name)) continue;
        meta[name] = value;
      }
      return { ok: true, payload: normalized.value, meta };
    } catch (error) {
      return { ok: false, reason: `read-failed:${error?.code || 'unknown'}` };
    }
  };

  /**
   * 原子写入：校验 → 写临时文件 → 旧 latest 改名归档 → 临时文件改名 latest → 修剪归档。
   * 校验不过时一个字节都不写。返回 {ok:true, file, archived, pruned} | {ok:false, reason}。
   */
  const write = (key, payload, meta = {}) => {
    let tmpPath = '';
    let committed = false;
    let rollback = null;
    try {
      if (!rootDir) return { ok: false, reason: 'no-dir' };
      const safeKey = safeKeyOf(key);

      // 1) 先校验：无效摘要绝不覆盖上一份有效交接。meta.scrub 用于落盘前清洗敏感词。
      const normalized = normalizeHandoffPayload(payload, {
        scrub: typeof meta?.scrub === 'function' ? meta.scrub : undefined
      });
      if (!normalized.ok) {
        safeLog(`[handoff] 摘要校验失败，拒绝写盘 key=${safeKey} reason=${normalized.reason}`);
        return { ok: false, reason: normalized.reason };
      }

      // 2) 组装落盘记录：schemaVersion/generatedAt 固定，meta 里其余键合并进顶层。
      const metaObject = isPlainObject(meta) ? meta : {};
      const generatedAt = Number.isFinite(metaObject.generatedAt)
        ? Number(metaObject.generatedAt)
        : currentTime();
      const record = { schemaVersion: HANDOFF_SCHEMA_VERSION, generatedAt };
      for (const [name, value] of Object.entries(metaObject)) {
        if (name === 'payload' || name === 'meta' || name === 'generatedAt' || name === 'scrub') continue;
        if (name === 'schemaVersion' || PAYLOAD_FIELDS.includes(name)) continue;
        record[name] = value;
      }
      for (const field of PAYLOAD_FIELDS) record[field] = normalized.value[field];
      const json = JSON.stringify(record);

      // 3) 建目录并写同目录临时文件。
      fs.mkdirSync(rootDir, { recursive: true });
      const latest = latestPathOf(safeKey);
      tmpPath = `${latest}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmpPath, json, 'utf8');

      // 4) Windows 的 renameSync 不能覆盖已存在文件：旧 latest 先改名归档。
      let archived = null;
      if (fs.existsSync(latest)) {
        const prevGeneratedAt = readGeneratedAt(latest, currentTime);
        const archive = archivePathOf(safeKey, prevGeneratedAt);
        if (fs.existsSync(archive)) {
          // 同名归档（同一毫秒重复交接）先清掉，避免 rename 失败。
          fs.unlinkSync(archive);
          safeLog(`[handoff] 清理同名归档：${path.basename(archive)}`);
        }
        fs.renameSync(latest, archive);
        archived = path.basename(archive);
        rollback = { latest, archive };
        safeLog(`[handoff] 旧交接归档：${archived}`);
      }

      // 5) 临时文件原子就位。
      fs.renameSync(tmpPath, latest);
      committed = true;
      tmpPath = '';

      // 6) 修剪归档：最新 1 份 + 归档，总数不超过 maxKeep。
      // 注意：走到这里新交接已经原子就位（committed=true）。修剪只是清理旧归档，
      // 失败绝不能把整次写入报成失败 —— 否则调用方不会记 pendingId/不退役，下一轮
      // 再写一份、把这份刚写好的归档掉，交接内容与注入行就对不上了。
      const archives = listArchives(safeKey);
      const keepArchives = Math.max(0, keep - 1);
      const pruned = [];
      let pruneError = '';
      for (const item of archives.slice(keepArchives)) {
        try {
          fs.unlinkSync(path.join(rootDir, item.name));
          pruned.push(item.name);
        } catch (error) {
          // 首个失败就停：剩下的留到下次写盘时继续清（归档超出 maxKeep 不影响正确性）。
          pruneError = `${item.name}:${error?.code || 'io'}`;
          break;
        }
      }
      if (pruned.length) safeLog(`[handoff] 修剪归档：${pruned.join(', ')}`);
      if (pruneError) safeLog(`[handoff] 归档修剪失败（不影响本次写入）：${pruneError}`);

      return { ok: true, file: latest, archived, pruned, ...(pruneError ? { pruneError } : {}) };
    } catch (error) {
      // 旧交接已归档但新文件未就位时，尽量把旧交接还原，避免丢数据。
      if (!committed && rollback) {
        try {
          if (!fs.existsSync(rollback.latest) && fs.existsSync(rollback.archive)) {
            fs.renameSync(rollback.archive, rollback.latest);
            safeLog('[handoff] 写入失败，已还原上一份交接');
          }
        } catch {
          /* 回滚失败只记录在返回值之外，不覆盖原始错误 */
        }
      }
      safeLog(`[handoff] 写盘失败 key=${safeKeyOf(key)}：${error?.message || error}`);
      return { ok: false, reason: `write-failed:${error?.code || error?.message || 'unknown'}` };
    } finally {
      // 无论成功失败都清掉临时文件。
      if (tmpPath) {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          /* 清理失败不掩盖主流程结果 */
        }
      }
    }
  };

  /** 从旧交接文件里取 generatedAt；读坏或没有就用当前时间。 */
  const readGeneratedAt = (file, fallback) => {
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (record && Number.isFinite(record.generatedAt)) return Number(record.generatedAt);
    } catch {
      /* 读到坏文件也要能继续归档 */
    }
    return fallback();
  };

  /** 历史归档文件名，从新到旧。目录不存在或读失败时返回空数组。 */
  const history = (key) => {
    try {
      if (!rootDir) return [];
      if (!fs.existsSync(rootDir)) return [];
      return listArchives(safeKeyOf(key)).map((item) => item.name);
    } catch {
      return [];
    }
  };

  return { read, write, history };
}
