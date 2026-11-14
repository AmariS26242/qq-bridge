/**
 * 自动表情联动（B-P3）：语音发出后，按 mood 挑一张匹配的表情跟着发。
 *
 * 纯逻辑模块：不读文件、不发请求，方便离线单测。
 * 真正的「检索 + 去重 + 发送」在 bridge.js 的 tryAutoStickerV2 里编排：
 *   mood → 检索 query → searchStickers 取候选 → 排除最近发过的 N 张 → sendStickerV2。
 */

/** mood → 检索词。检索走 sticker-index 的中文分词 + 同义词扩展，所以给少量高质量词就够。 */
export const MOOD_QUERIES = Object.freeze({
  happy: '开心 笑',
  shy: '害羞 脸红',
  annoyed: '嫌弃 白眼',
  sad: '难过 哭',
  calm: '晚安 睡'
});

export const AUTO_STICKER_DEFAULTS = Object.freeze({
  enabled: true,
  minScore: 6, // 低于这个分数说明只是蹭到一两个虚词，发出去会很莫名
  recentWindow: 10, // 最近 10 张不再发（验收要求：连续 5 次不重复）
  limit: 8 // 从 top 8 里挑第一张没发过的
});

export function normalizeAutoStickerConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled: r.enabled !== false,
    minScore: num(r.minScore, AUTO_STICKER_DEFAULTS.minScore),
    recentWindow: Math.max(0, num(r.recentWindow, AUTO_STICKER_DEFAULTS.recentWindow)),
    limit: Math.max(1, num(r.limit, AUTO_STICKER_DEFAULTS.limit))
  };
}

/**
 * 把 searchStickers 的返回值（{entry, score} 或裸 entry）归一成 {id, score, desc}。
 */
export function normalizeHits(hits) {
  if (!Array.isArray(hits)) return [];
  return hits
    .map((h) => {
      const entry = h && h.entry ? h.entry : h;
      if (!entry || entry.id == null) return null;
      return {
        id: String(entry.id),
        score: Number(h && typeof h.score === 'number' ? h.score : 0),
        desc: String(entry.desc || entry.localNote || '').slice(0, 40)
      };
    })
    .filter(Boolean);
}

/**
 * 从候选里挑第一张「分数够、最近没发过」的表情。
 * @returns {{picked: object|null, reason: string, skippedRecent: string[]}}
 */
export function pickAutoSticker(hits, { mood, recent = [], config } = {}) {
  const cfg = normalizeAutoStickerConfig(config);
  if (!cfg.enabled) return { picked: null, reason: 'disabled', skippedRecent: [] };
  const query = MOOD_QUERIES[mood];
  if (!query) return { picked: null, reason: 'no-mood', skippedRecent: [] };
  const recentIds = new Set((Array.isArray(recent) ? recent : []).slice(-cfg.recentWindow).map(String));
  const list = normalizeHits(hits).slice(0, cfg.limit);
  if (!list.length) return { picked: null, reason: 'no-hit', skippedRecent: [] };
  const skippedRecent = [];
  for (const h of list) {
    if (recentIds.has(h.id)) {
      skippedRecent.push(h.id);
      continue;
    }
    if (h.score < cfg.minScore) break; // 候选按分数降序，后面只会更差
    return { picked: h, reason: 'ok', skippedRecent };
  }
  const why = skippedRecent.length && skippedRecent.length === list.length ? 'all-recent' : 'low-score';
  return { picked: null, reason: why, skippedRecent };
}

export function moodQuery(mood) {
  return MOOD_QUERIES[mood] || '';
}
