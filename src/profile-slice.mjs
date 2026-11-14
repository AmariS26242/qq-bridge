// 人群档案分片推进：持久化游标 + 分片 + 积压报告的纯函数内核。
//
// 背景（2026-10-25，管理员需求）：档案学习原先每轮只取"最近 40 条"（sliceMaxMessages），
// 群聊刷得快时 40 条之外的中间消息就永久丢失了。改为「持久化游标 + 分片推进」：
//   1. 游标记住"已经学到哪条 seq"（lastSeq），每轮从游标之后**最旧**的一批开始，
//      绝不为了追新鲜而丢掉中间的消息；
//   2. 只有档案真正写成功才 commitSlice 提交游标，失败就重试同一批（靠消息 seq 幂等）；
//   3. 积压不静默丢弃：gap 报告"游标与首条之间被截断"，overflow 报告"超过硬上限的真丢失"，
//      都带区间/条数/原因，交给上层写日志或告警。
//
// 本文件不依赖桥接，全部是纯函数，便于离线单测（scripts/test-profile-slice.mjs）。

export const PROFILE_SLICE_DEFAULTS = Object.freeze({
  maxMessages: 40,      // 每片最多条数
  minMessages: 6,       // 少于这个数不值得跑一次提取
  maxBacklog: 400,      // 积压硬上限，超过才算真丢
});

/** 取非负安全整数；脏值返回 null（不抛）。 */
function safeNonNegInt(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const floored = Math.floor(num);
  if (!Number.isSafeInteger(floored) || floored < 0) return null;
  return floored;
}

/** 取 >=1 的整数；脏值回落到 fallback（不抛）。 */
function positiveInt(value, fallback) {
  const n = safeNonNegInt(value);
  if (n === null || n < 1) return fallback;
  return n;
}

/** 一条消息的正整数 seq；非正整数/缺失/非法一律 null。 */
function seqOf(item) {
  if (item === null || typeof item !== 'object') return null;
  const raw = item.seq;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1 || !Number.isSafeInteger(num)) return null;
  return num;
}

/** 归一化消息：丢弃非法 seq、同 seq 保留首次出现，然后按 seq 升序。 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const seen = new Set();
  const rows = [];
  for (const item of messages) {
    const seq = seqOf(item);
    if (seq === null || seen.has(seq)) continue;
    seen.add(seq);
    rows.push({ seq, item });
  }
  // Array.prototype.sort 在 V8 里是稳定排序，但同 seq 已在上面去重，稳定与否都不影响结果。
  rows.sort((a, b) => a.seq - b.seq);
  return rows;
}

/**
 * 归一化游标：{ lastSeq: 非负安全整数 }；脏输入（null / 缺字段 / 负数 / NaN / 小数外溢）回落 { lastSeq: 0 }。
 * 小数按闭区间向下取整（3.9 → 3），方便容忍上游把 seq 存成浮点。
 */
export function normalizeSliceCursor(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw.lastSeq : raw;
  const lastSeq = safeNonNegInt(value);
  return { lastSeq: lastSeq === null ? 0 : lastSeq };
}

/**
 * 规划下一次分片。
 *   messages  数组，每项至少 { seq }（正整数）；会先排序去重
 *   cursor    { lastSeq } 已经学到哪条
 * 返回 { ok, reason, items, nextCursor, pending, backlog, gap, overflow }，详见文件头注释。
 * 所有脏输入都按默认值降级，绝不抛异常。
 */
export function planSlice(input) {
  const args = input !== null && typeof input === 'object' ? input : {};
  const cur = normalizeSliceCursor(args.cursor);
  const max = positiveInt(args.maxMessages, PROFILE_SLICE_DEFAULTS.maxMessages);
  const min = positiveInt(args.minMessages, PROFILE_SLICE_DEFAULTS.minMessages);
  const cap = positiveInt(args.maxBacklog, PROFILE_SLICE_DEFAULTS.maxBacklog);

  const rows = normalizeMessages(args.messages);
  const pendingRows = rows.filter((row) => row.seq > cur.lastSeq);
  const backlog = pendingRows.length;

  // gap：游标之后**第一条待处理**消息不是 lastSeq+1，说明中间有条目被截断。
  // 只在 lastSeq > 0 时才有"中间"可言；游标为 0（还没学过）时首条之前没有已知基线，不报。
  // 判据用 pendingRows[0] 而不是整个数组的首条：游标之前的老消息与本片无关，不该影响告警。
  let gap = null;
  if (backlog > 0 && cur.lastSeq > 0 && pendingRows[0].seq > cur.lastSeq + 1) {
    gap = { expectedSeq: cur.lastSeq + 1, firstSeq: pendingRows[0].seq };
  }

  // 切片：永远从最旧的待处理消息开始，绝不先丢旧的。overflow 只报告，不改变本片取哪几条。
  const take = pendingRows.slice(0, max);
  const items = take.map((row) => row.item);

  // overflow：超出 maxBacklog 的部分是真丢失，报区间/条数/原因（中文串可直接进日志）。
  let overflow = null;
  if (backlog > cap) {
    const dropped = pendingRows.slice(cap);
    const fromSeq = dropped[0].seq;
    const toSeq = dropped[dropped.length - 1].seq;
    overflow = {
      reason: 'backlog-hard-cap',
      droppedRange: { fromSeq, toSeq },
      count: dropped.length,
      message: `积压 ${backlog} 条超上限 ${cap}，区间 ${fromSeq}-${toSeq} 共 ${dropped.length} 条未处理`,
    };
  }

  // reason 判定顺序：no-new（没积压）→ below-min（够不上一次提取）→ ok。
  // gap / overflow 都是独立旁路报告，不参与 reason 判定。
  const ok = items.length >= min;
  const reason = backlog === 0 ? 'no-new' : ok ? 'ok' : 'below-min';

  // below-min 时游标必须原地不动，否则这几条会被永久跳过；下次还会重试同一批。
  const nextCursor = ok && take.length > 0
    ? { lastSeq: take[take.length - 1].seq }
    : { lastSeq: cur.lastSeq };

  return {
    ok,
    reason,
    items,
    nextCursor,
    pending: backlog - items.length,
    backlog,
    gap,
    overflow,
  };
}

/**
 * 积压概况：{ pending, firstSeq, lastSeq, oldestUnprocessedSeq }。
 *   pending             游标之后还有多少条没学（与 planSlice().backlog 同义）
 *   firstSeq/lastSeq    这批待处理消息的 seq 区间（无积压时 null）
 *   oldestUnprocessedSeq 最旧的那条（= firstSeq，名字更直白）
 * 脏输入一律降级为 0 / null，不抛异常。
 */
export function describeBacklog(input) {
  const args = input !== null && typeof input === 'object' ? input : {};
  const cur = normalizeSliceCursor(args.cursor);
  const rows = normalizeMessages(args.messages);
  const pendingRows = rows.filter((row) => row.seq > cur.lastSeq);
  const pending = pendingRows.length;
  const firstSeq = pending > 0 ? pendingRows[0].seq : null;
  const lastSeq = pending > 0 ? pendingRows[pendingRows.length - 1].seq : null;
  return { pending, firstSeq, lastSeq, oldestUnprocessedSeq: firstSeq };
}

/**
 * 提交游标：只有 planned.ok === true 才前进，失败/没数据保持原样（可重试）。
 * 返回新对象，不修改入参。
 */
export function commitSlice(cursor, planned) {
  const cur = normalizeSliceCursor(cursor);
  if (!planned || planned.ok !== true || !planned.nextCursor) {
    return { lastSeq: cur.lastSeq };
  }
  return { lastSeq: normalizeSliceCursor(planned.nextCursor).lastSeq };
}
