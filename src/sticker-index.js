// 表情包语义检索 —— Track 1：分词 + 同义词扩展 + 字段加权打分（纯函数，无外部依赖）。
//
// 为什么不直接把「关键词子串匹配」当检索（旧行为见 sticker-lib.js formatStickerList）：
// 1. 子串匹配只能命中查询里出现的字面词。用户说「有点想哭」，图注写的是「爆哭破防」「委屈眼泪汪汪」，
//    字面不同但语义相同，子串匹配直接 0 命中。
// 2. 语料里每个表情有四个字段（desc 配字 / tags 标签 / localNote 看图理解 / usage 用途），
//    子串匹配对四个字段一视同仁，而 tags 是人工精选的语义标签，命中它比命中配字更可信。
// 3. 没有 IDF：「好笑」这种词在 10 张图上都有，命中它不该和命中 only-one 的「白嫖」同分。
//
// 本模块做的事：
// - 分词：CJK 走二元组（bigram）+ 单字兜底，ASCII 走小写词；
// - 同义词：把口语/近义说法折叠到同一组，按 0.6 权重扩展（不喧宾夺主）；
// - 打分：BM25（字段加权 TF + IDF + 长度归一化）+ 短语命中和标签精确命中加分 + 使用频次微调。
//
// 只做检索，不做「选哪张发」的决策（那是 Track 2 精排 / 策略层的事）。

/** 字段权重：tags 是人工语义标签，最可信；localNote 是看图理解，语义密度最高。 */
const FIELD_WEIGHTS = {
  tags: 2.6,
  localNote: 1.6,
  desc: 1.2,
  usage: 1.0
};

/** BM25 参数。b 取 0.6 而不是 0.75：语料条目长度差异不大（都是几十字），过度长度归一会误伤长条目。 */
const BM25_K1 = 1.2;
const BM25_B = 0.6;

/** 同义词组：组内任意词被命中时，其余词以 0.6 权重补进来。 */
const SYNONYM_GROUPS = [
  ['笑', '搞笑', '好笑', '哈哈', '笑死', '爆笑', '狂笑', '坏笑', '咧嘴', '乐'],
  ['哭', '难过', '伤心', '委屈', '眼泪', '爆哭', '哭腔', '泪汪汪'],
  ['生气', '气', '火', '炸毛', '怒', '发火', '恼', '不爽', '较真'],
  ['无语', '尴尬', '死鱼眼', '汗', '沉默', '冷脸'],
  ['开心', '高兴', '狂喜', '满足', '美滋滋', '雀跃', '兴奋', '乐开花'],
  ['震惊', '惊讶', '意外', '吓', '呆', '愣', '懵', '吃惊'],
  ['疑惑', '疑问', '问号', '不懂', '没听懂', '困惑', '质疑'],
  ['害羞', '脸红', '不好意思', '羞', '被夸'],
  ['摸鱼', '偷懒', '划水', '摆烂', '躺平', '蔫', '不想动', '搁浅'],
  ['困', '睡觉', '睡', '犯困', '熬夜', '安睡', '打瞌睡'],
  ['吃', '干饭', '嘴馋', '甜食', '蛋糕', '吃饱', '吃饭', '蹭饭'],
  ['干活', '上班', 'harness', '算力', '跑满', '加班', '写东西', '赶活'],
  ['白嫖', '薅羊毛', '免费', '占便宜', '赠金'],
  ['报错', '错误', '异常', '崩溃', '500', '429', '414', '请求太多', '请求太长'],
  ['模型', 'claude', 'deepseek', '大模型', 'llm', 'agi'],
  ['炫耀', '凡尔赛', '装阔', '炫富', '排面', '抽卡', '专武'],
  ['吃醋', '争宠', '嫉妒', '酸'],
  ['赶人', '滚', '别处玩', '打发', '嫌弃', '不耐烦'],
  ['怼', '骂', '反击', '顶回去', '损人', '回怼', '骂回去'],
  ['破防', '崩溃', '绷不住', '麻了', '要疯了'],
  ['截图', '开会', '群聊', '紧急'],
  ['闯祸', '搞砸', '心虚', '完蛋', '事故', '犯错'],
  ['被摸头', '摸头', '顺毛', '乖'],
  ['撒娇', '耍赖', '卖萌', '要 token', 'token', '额度', '讨要'],
  ['哭穷', '要饭', '吃白饭', '讨饭'],
  ['催', '催更', '催活', '催进度', '预告', '大的要来'],
  ['吃瓜', '看戏', '围观', '凑热闹'],
  ['自嘲', '菜', '拖后腿', '不行'],
  ['可爱', '萌', '被捏']
];

/** 「笑」这类高频泛词在组内排序靠后，扩展时只补组内前若干项，避免一个泛词污染整条查询。 */
const SYNONYM_EXPANSION_LIMIT = 8;
const SYNONYM_WEIGHT = 0.6;

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const ASCII_WORD_RE = /[a-z0-9]+/g;

/** 单字停用集：这些字在条目里遍地都是，作为单字词条只会制造噪声（bigram 里仍保留它们）。 */
const STOP_CHARS = new Set('的了是我你他她它们在和就都不也很吗呢啊吧这那个上下有没要到会说着过把被给对让又再才只'.split(''));

/** 单字词条权重折扣：单字只做「兜底召回」（如「催」对不上 bigram「催活」时），不应主导排序。 */
const SINGLE_CHAR_WEIGHT = 0.45;
const QUERY_CHAR_WEIGHT = 0.8;

/** 词条的权重系数：单字打折，词/二元组全权重。 */
function termWeightFactor(term, isQuery = false) {
  if (term.length === 1 && CJK_RE.test(term)) return isQuery ? QUERY_CHAR_WEIGHT : SINGLE_CHAR_WEIGHT;
  return 1;
}

/** 统一大小写、全角转半角、把各种空白压成单空格。与 sticker-lib 的 sanitize 保持同向。 */
export function normalizeQuery(text) {
  return String(text ?? '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 分词：CJK 连续段切成二元组（单字段不足 2 时保留单字），ASCII 段切小写词。
 *
 * 为什么用 bigram 而不是词表：本模块要零依赖运行在 QQ 桥里，
 * 引入分词器（jieba 级）是几十 MB 的词典，且对「爆哭破防」这类梗词覆盖很差。
 * bigram 对中文短查询的召回足够，且天然支持未登录词。
 *
 * @param text - 原文
 * @returns 去重后的词条数组（保持首次出现顺序）
 */
export function tokenize(text) {
  const normalized = normalizeQuery(text);
  const terms = [];
  const seen = new Set();
  const push = (term) => {
    if (!term || seen.has(term)) return;
    seen.add(term);
    terms.push(term);
  };

  // ASCII 词先切出来，再把剩余部分按 CJK 连续段处理
  const asciiParts = normalized.match(ASCII_WORD_RE) || [];
  for (const part of asciiParts) push(part);

  const runs = normalized.split(/[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/).filter(Boolean);
  for (const run of runs) {
    if (run.length === 1) {
      push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) push(run.slice(i, i + 2));
    // 整段（长度 2-4）也作为一个词条：让「爆哭破防」这种固定搭配优先于拆开的 bigram
    if (run.length >= 3 && run.length <= 4) push(run);
    // 单字兜底：「被老板催着干活」里的「催」要对上标签「催活」，bigram 切不出来
    for (const ch of run) if (!STOP_CHARS.has(ch)) push(ch);
  }
  return terms;
}

/** 构建 term → 同义词组编号 的反查表（惰性，模块加载时构建一次）。 */
const SYNONYM_INDEX = (() => {
  const index = new Map();
  SYNONYM_GROUPS.forEach((group, groupId) => {
    for (const word of group) {
      if (!index.has(word)) index.set(word, new Set());
      index.get(word).add(groupId);
    }
  });
  return index;
})();

/**
 * 同义词扩展：查询词命中的组，补进组内其它词（带 0.6 权重）。
 *
 * @param terms - tokenize 的结果
 * @returns Map<term, weight>，原始词权重 1，扩展词 0.6
 */
export function expandWithSynonyms(terms) {
  const weighted = new Map();
  for (const term of terms) weighted.set(term, termWeightFactor(term, true));

  for (const term of terms) {
    // 只对长度 >= 1 的词做组匹配（bigram 也可能是组内词，如「摸鱼」）
    const groups = SYNONYM_INDEX.get(term);
    if (!groups) continue;
    for (const groupId of groups) {
      const group = SYNONYM_GROUPS[groupId];
      let added = 0;
      for (const word of group) {
        if (weighted.has(word)) continue;
        weighted.set(word, SYNONYM_WEIGHT * termWeightFactor(word, true));
        added += 1;
        if (added >= SYNONYM_EXPANSION_LIMIT) break;
      }
    }
  }
  return weighted;
}

/** 把一个表情条目的四个字段拼成「字段 → 分词后文本」的结构，供建索引与短语匹配复用。 */
function entryFieldTexts(entry) {
  const tags = Array.isArray(entry?.tags) ? entry.tags.filter(Boolean) : [];
  return {
    tags: tags.map((t) => normalizeQuery(t)),
    tagsJoined: tags.map((t) => normalizeQuery(t)).join(' '),
    desc: normalizeQuery(entry?.desc),
    localNote: normalizeQuery(entry?.localNote),
    usage: normalizeQuery(entry?.usage)
  };
}

/**
 * 建索引：逐条把字段分词成加权词频，并统计每条的词数。
 *
 * @param entries - 表情库条目（normalizeStickerEntry 之后的数组）
 * @returns {{entries, docs, df, avgLen, familySize}}
 */
export function buildStickerIndex(entries) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const docs = list.map((entry) => {
    const texts = entryFieldTexts(entry);
    const tf = new Map();
    // 逐字段词频：只给「为什么选中这张」解释页用（searchStickers 走聚合 tf，热路径不受影响）
    const fieldTf = new Map();
    const addTerm = (term, weight, field) => {
      if (!term) return;
      const scaled = weight * termWeightFactor(term);
      tf.set(term, (tf.get(term) || 0) + scaled);
      if (!field) return;
      if (!fieldTf.has(term)) fieldTf.set(term, { tags: 0, desc: 0, localNote: 0, usage: 0 });
      fieldTf.get(term)[field] += scaled;
    };

    // tags 逐项加分：一个 tag 命中相当于整条多次命中
    for (const tag of texts.tags) {
      for (const term of tokenize(tag)) addTerm(term, FIELD_WEIGHTS.tags, 'tags');
      addTerm(tag, FIELD_WEIGHTS.tags, 'tags'); // 标签整体作为一个词条，支持「被摸头」「大肥鱼」这类词
    }
    for (const term of tokenize(texts.desc)) addTerm(term, FIELD_WEIGHTS.desc, 'desc');
    for (const term of tokenize(texts.localNote)) addTerm(term, FIELD_WEIGHTS.localNote, 'localNote');
    for (const term of tokenize(texts.usage)) addTerm(term, FIELD_WEIGHTS.usage, 'usage');

    let len = 0;
    for (const value of tf.values()) len += value;

    return {
      entry,
      tf,
      fieldTf,
      len: len || 1,
      texts,
      tags: entry?.tags || [],
      // 语料里同一张表情可能存在多条（QQ 收藏 + 手工录入），按 desc + localNote 归一判断
      signature: `${texts.desc}||${texts.localNote}`
    };
  });

  const df = new Map();
  for (const doc of docs) {
    for (const term of doc.tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  }

  const signatureCount = new Map();
  for (const doc of docs) signatureCount.set(doc.signature, (signatureCount.get(doc.signature) || 0) + 1);

  const avgLen = docs.length ? docs.reduce((sum, doc) => sum + doc.len, 0) / docs.length : 1;

  return { entries: list, docs, df, avgLen, signatureCount };
}

/** BM25 的 IDF：出现越少越值钱，负值截断为 0（高频泛词不产生负贡献）。 */
function idf(df, total) {
  if (!total) return 0;
  const value = Math.log(1 + (total - df + 0.5) / (df + 0.5));
  return value > 0 ? value : 0;
}

/**
 * 检索主入口。
 *
 * @param entries - 表情库条目，或已建好的索引（传入 buildStickerIndex 的返回值可复用以省重建）
 * @param query - 用户口语化查询，如「有点想哭」「在干活」
 * @param options.limit - 返回条数，默认 5
 * @param options.minScore - 低于该分数的结果直接丢弃，默认 0
 * @returns {{id, score, entry, tags, matchedTerms, reason}[]} 按分数降序
 */
export function searchStickers(entries, query, { limit = 5, minScore = 0 } = {}) {
  const index = entries && Array.isArray(entries.docs) ? entries : buildStickerIndex(entries);
  const { docs } = index;
  const normalized = normalizeQuery(query);
  if (!normalized || !docs.length) return [];

  const ctx = buildScoringContext(index, normalized);

  const results = [];
  for (const doc of docs) {
    const scored = scoreDoc(doc, ctx, false);
    if (scored.score <= 0) continue;
    if (scored.score < minScore) continue;

    results.push({
      id: doc.entry.id,
      score: Number(scored.score.toFixed(4)),
      entry: doc.entry,
      tags: doc.tags,
      matchedTerms: scored.matched.slice(0, 8),
      reason: buildReason(doc, scored.matched, doc.tags)
    });
  }

  results.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  return results.slice(0, Math.max(1, Number(limit) || 5));
}

/** 打分上下文：查询词（含同义扩展）+ 语料统计，抽出来让检索与解释共用同一套数学。 */
function buildScoringContext(index, normalized) {
  const { df, avgLen, docs } = index;
  const weightedTerms = expandWithSynonyms(tokenize(normalized));
  // now 也放进上下文：时效加分必须和检索/解释在同一次调用里取同一个时间点，否则两边分数会对不上。
  return { weightedTerms, df, avgLen, total: docs.length, normalized, now: Date.now() };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * 时效微调：治「同几张表情反复被推荐」的第二处正反馈。
 *
 * 旧逻辑只有 usageBoost（log 压缩的常用度加分）——越常用越靠前，越靠前越常用；
 * 而 `qq_find_sticker` 是模型找表情的首选入口，同一类情绪查询永远返回同样的 top5，
 * 结果 123 张里 101 张一次没被选过。
 *
 * 现在按「多久没用过」给分（跨度比短语加分小得多，排序主体仍是语义相关性）：
 * 从没用过 +0.5 > ≥7 天 +0.35 > 3–7 天 +0.2 > 1–3 天 +0.05 > 6–24h −0.15
 * > 1–6h −0.35 > 1h 内 −0.6。
 * 关键在于负值：刚发过的那张这轮基本自动沉底，不用靠模型自觉。
 */
function recencyAdjust(entry, now) {
  const useCount = Number(entry?.useCount) || 0;
  const lastUsedAt = Number(entry?.lastUsedAt) || 0;
  if (!useCount || !lastUsedAt) return { points: 0.5, label: '从没用过 +0.5' };
  const idle = Math.max(0, now - lastUsedAt);
  if (idle >= 7 * DAY_MS) return { points: 0.35, label: '7 天以上没用过 +0.35' };
  if (idle >= 3 * DAY_MS) return { points: 0.2, label: '3 天以上没用过 +0.2' };
  if (idle >= DAY_MS) return { points: 0.05, label: '1 天以上没用过 +0.05' };
  if (idle >= 6 * HOUR_MS) return { points: -0.15, label: '6 小时内用过 -0.15' };
  if (idle >= HOUR_MS) return { points: -0.35, label: '1 小时内用过 -0.35' };
  return { points: -0.6, label: '刚用过 -0.6' };
}

const round = (value, digits = 3) => Number(Number(value).toFixed(digits));
const FIELD_ORDER = ['tags', 'desc', 'localNote', 'usage'];

/**
 * 单条打分。trace=true 时额外产出逐词 × 逐字段的得分拆解（解释页用），
 * 数学与 searchStickers 完全一致，避免「页面上算的和线上不一样」。
 */
function scoreDoc(doc, ctx, trace = false) {
  const { weightedTerms, df, avgLen, total, normalized, now } = ctx;
  const norm = 1 - BM25_B + (BM25_B * doc.len) / avgLen;
  let score = 0;
  const matched = [];
  const parts = trace ? [] : null;

  for (const [term, queryWeight] of weightedTerms) {
    const tf = doc.tf.get(term);
    if (!tf) continue;
    const weight = idf(df.get(term) || 1, total);
    const termScore = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm) * weight * queryWeight;
    score += termScore;
    matched.push(term);
    if (trace) {
      const byField = doc.fieldTf?.get(term);
      parts.push({
        term,
        queryWeight: round(queryWeight),
        tf: round(tf),
        idf: round(weight),
        contribution: round(termScore),
        fields: byField
          ? FIELD_ORDER.filter((field) => byField[field] > 0).map((field) => ({ field, tf: round(byField[field]) }))
          : []
      });
    }
  }

  // 允许负分：时效项是双向的（刚用过要扣分），否则「解释页总分 ≠ 各项之和」。
  const bonuses = trace ? [] : null;
  const addBonus = (label, points) => {
    if (!points) return;
    score += points;
    if (bonuses) bonuses.push({ label, points });
  };

  // 短语加分：整串查询出现在某字段里，比拆词命中更可信
  if (normalized.length >= 2) {
    if (doc.texts.tagsJoined.includes(normalized)) addBonus('短语命中标签', 5);
    if (doc.texts.desc.includes(normalized)) addBonus('短语命中配字', 3);
    if (doc.texts.localNote.includes(normalized)) addBonus('短语命中说明', 3);
    if (doc.texts.usage.includes(normalized)) addBonus('短语命中用途', 2);
  }

  // 标签精确命中：查询词与某个 tag 完全一致
  for (const tag of doc.texts.tags) {
    if (tag === normalized) addBonus(`标签精确命中「${tag}」`, 6);
    else if (normalized.length >= 2 && (tag.includes(normalized) || normalized.includes(tag))) addBonus(`标签包含「${tag}」`, 2);
  }

  // 时效 + 常用度微调。只在真的命中查询词（score > 0）时才给，
  // 否则「从没用过 +0.5」会把完全不相关的表情也推上来。
  if (score > 0) {
    const recency = recencyAdjust(doc.entry, now);
    addBonus(recency.label, recency.points);
    // 常用度只留一点点（封顶 0.15）：证明过好用的仍然略占优，但绝不能反过来压住语义相关性，
    // 更不能形成「越常用越被推、越被推越常用」的马太效应。
    const useCount = Number(doc.entry?.useCount) || 0;
    const usagePoints = Math.min(0.15, 0.05 * Math.log1p(useCount));
    if (usagePoints > 0) addBonus(`常用度 ×${useCount}`, round(usagePoints));
  }

  return { score, matched, parts, bonuses };
}

/**
 * 解释检索：返回和 searchStickers 同分的 top 结果，外加「每个查询词贡献多少、命中在哪个字段、加分项是什么」。
 * 只读、纯函数，给「为什么选中这张」调试页与排查用。
 */
export function explainSearch(entries, query, { limit = 5 } = {}) {
  const index = entries && Array.isArray(entries.docs) ? entries : buildStickerIndex(entries);
  const { docs, df } = index;
  const normalized = normalizeQuery(query);
  if (!normalized || !docs.length) {
    return { query: String(query ?? ''), normalized, total: docs.length, terms: [], hits: [] };
  }

  const ctx = buildScoringContext(index, normalized);
  const queryTerms = new Set(tokenize(normalized));
  const terms = [...ctx.weightedTerms.entries()].map(([term, weight]) => ({
    term,
    queryWeight: round(weight),
    synonym: !queryTerms.has(term),
    df: df.get(term) || 0,
    idf: round(idf(df.get(term) || 1, ctx.total))
  }));

  const hits = [];
  for (const doc of docs) {
    const scored = scoreDoc(doc, ctx, true);
    if (scored.score <= 0) continue;
    hits.push({
      id: doc.entry.id,
      score: Number(scored.score.toFixed(4)),
      desc: doc.entry?.desc ?? '',
      tags: doc.tags,
      localNote: doc.entry?.localNote ?? '',
      useCount: Number(doc.entry?.useCount) || 0,
      url: doc.entry?.url ?? '',
      reason: buildReason(doc, scored.matched, doc.tags),
      terms: scored.parts,
      bonuses: scored.bonuses
    });
  }

  hits.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  return { query: String(query ?? ''), normalized, total: docs.length, terms, hits: hits.slice(0, Math.max(1, Number(limit) || 5)) };
}

/** 生成人类可读的命中理由，方便人工评测与线上排查「为什么推了这张」。 */
function buildReason(doc, matched, tags) {
  const hitTags = (tags || []).filter((tag) => {
    const normalized = normalizeQuery(tag);
    return matched.some((term) => normalized.includes(term) || term.includes(normalized));
  });
  if (hitTags.length) return `命中标签 ${hitTags.slice(0, 3).map((t) => `「${t}」`).join('')}`;
  if (matched.length) return `命中语义词 ${matched.slice(0, 4).map((t) => `「${t}」`).join('')}`;
  return '相关度较低';
}

/** 给 CLI / 日志用的单行摘要：分数 + 配字 + 标签 + 理由。 */
export function formatSearchHit(hit, index = 0) {
  const entry = hit.entry || {};
  const tags = (hit.tags || []).join('/');
  return `${String(index + 1).padStart(2)}. [${hit.score}] ${entry.desc || '(无配字)'}${tags ? ` ${tags}` : ''} — ${hit.reason}`;
}
