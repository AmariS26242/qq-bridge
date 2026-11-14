// few-shot 正例库：把「真人怎么接话」存成结构化样本，按当轮消息相似度检索后注入。
//
// 为什么单独一层：人格卡写的是规则，模型学规则会背成条文；few-shot 给的是成品句子，
// 对语气/长度的迁移远强于规则（这也是 LiveKit 那篇提示词文章的核心建议）。
// 库不常驻提示词，每轮只抽 3~5 条（受 maxChars 限制），所以素材可以长期积累。
//
// 目录（persona-lib/fewshot/）：
//   examples.jsonl   规范化的正例，每行一条 JSON（由导入脚本生成，也可以手写）
//   negative.jsonl   反例（不注入，只给审查/测试用）
//   raw/*.md         手写素材，导入时解析
//   inbox/*.txt      QQ 导出的聊天记录，导入时自动配对
//
// 一条样本：
//   { id, context: [{role:'other'|'me', text}], reply, tags: [], scene: null, source: 'raw'|'qq'|'manual' }
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const FEWSHOT_DEFAULTS = {
  enabled: true,
  maxExamples: 4,
  maxChars: 900,
  // 会话里最近用过的样本不再重复用（避免连着两轮给同一句）
  avoidRecent: 12,
  // 反例块默认关：每轮多付约 120 字符，先人工看过再开（见 negative.jsonl）
  negativeEnabled: false,
};

const REPLY_MAX = 120;
const CONTEXT_MAX = 120;
const CONTEXT_ITEMS_MAX = 6;
const TAGS_MAX = 6;

/** 规范化一行样本；不合法返回 null。 */
export function normalizeExample(raw, { source = 'manual' } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const reply = collapse(String(raw.reply ?? '')).slice(0, REPLY_MAX).trim();
  if (!reply) return null;
  const context = (Array.isArray(raw.context) ? raw.context : [])
    .map((item) => {
      if (!item) return null;
      const text = collapse(String(item.text ?? '')).slice(0, CONTEXT_MAX).trim();
      if (!text) return null;
      const role = item.role === 'me' ? 'me' : item.role === 'note' ? 'note' : 'other';
      return { role, text };
    })
    .filter(Boolean)
    .slice(-CONTEXT_ITEMS_MAX);
  const tags = (Array.isArray(raw.tags) ? raw.tags : [])
    .map((tag) => collapse(String(tag ?? '')).trim())
    .filter(Boolean)
    .slice(0, TAGS_MAX);
  const scene = raw.scene ? collapse(String(raw.scene)).trim() : null;
  const example = { context, reply, tags, scene, source };
  example.id = hashExample(example);
  return example;
}

export function hashExample(example) {
  const key = JSON.stringify([example.context.map((c) => [c.role, c.text]), example.reply]);
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

function collapse(text) {
  return String(text).replace(/\s+/g, ' ');
}

/** 读 JSONL；坏行不炸，记进 errors。 */
export function readJsonl(filePath) {
  const examples = [];
  const errors = [];
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { examples, errors };
  }
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('//')) continue;
    try {
      const parsed = JSON.parse(line);
      const normalized = normalizeExample(parsed, { source: parsed.source || 'manual' });
      if (!normalized) {
        errors.push(`${path.basename(filePath)}:${i + 1} 缺少 reply`);
        continue;
      }
      examples.push(normalized);
    } catch (error) {
      errors.push(`${path.basename(filePath)}:${i + 1} JSON 解析失败（${error?.message ?? error}）`);
    }
  }
  return { examples, errors };
}

/**
 * 解析手写素材（raw/*.md）。
 * 格式：每组之间空一行或 ---；行首 `# 标签 标签` 可选；说话人前缀认「对方/群友/群友A/其他」= other，
 * 「我/你/自己」= me；最后一条 me 行是 reply，其余进 context。
 */
export function parseRawMarkdown(text, { source = 'raw' } = {}) {
  const examples = [];
  const errors = [];
  const blocks = String(text ?? '').split(/\r?\n\s*(?:-{3,}|={3,})\s*\r?\n|\r?\n\s*\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    let tags = [];
    const items = [];
    for (const line of lines) {
      if (line.startsWith('#')) {
        tags = line.replace(/^#+\s*/, '').split(/[\s,，]+/).filter(Boolean);
        continue;
      }
      const match = /^(对方|群友[\w一二三四五六七八九十]?|其他|注|场景|我|你|自己)\s*[:：]\s*(.+)$/.exec(line);
      if (!match) {
        errors.push(`无法识别的行：${line.slice(0, 40)}`);
        continue;
      }
      const role = ['我', '你', '自己'].includes(match[1]) ? 'me' : ['注', '场景'].includes(match[1]) ? 'note' : 'other';
      items.push({ role, text: match[2] });
    }
    const lastMe = [...items].reverse().findIndex((item) => item.role === 'me');
    if (lastMe < 0) {
      if (items.length) errors.push(`整组没有「我：」这一行，跳过：${items[0].text.slice(0, 30)}`);
      continue;
    }
    const replyIndex = items.length - 1 - lastMe;
    const reply = items[replyIndex].text;
    const context = items.slice(0, replyIndex);
    const normalized = normalizeExample({ context, reply, tags }, { source });
    if (normalized) examples.push(normalized);
  }
  return { examples, errors };
}

/**
 * 解析 QQ 导出的 txt 聊天记录（消息管理器 → 导出消息记录 → 文本）。
 * 相邻两条不同发送者的消息配成 上下文→回复；只收短回复，避免把长文/链接当范例。
 * 「谁是我」无法从文件本身可靠判断，必须由 selfNames 指名（默认「我」），否则只能报错，
 * 因为把对方的话当成「你」的回复会教出反向语气。
 */
export function parseQqExport(text, { source = 'qq', maxReplyChars = 40, selfNames = ['我', '本人', '自己'] } = {}) {
  const messages = [];
  const lines = String(text ?? '').split(/\r?\n/);
  const header = /^(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s+(.+?)(?:\((\d+)\))?\s*$/;
  let current = null;
  for (const line of lines) {
    const match = header.exec(line.trim());
    if (match) {
      if (current) messages.push(current);
      current = { time: match[1], sender: match[2].trim(), userId: match[3] ?? null, lines: [] };
      continue;
    }
    if (!current) continue; // 文件头（"消息记录"、分隔线、分组信息）
    if (/^={5,}$/.test(line.trim())) continue;
    current.lines.push(line);
  }
  if (current) messages.push(current);

  const examples = [];
  const errors = [];
  const selfSet = new Set((selfNames ?? []).filter(Boolean));
  const cleaned = messages
    .map((m) => ({
      ...m,
      text: m.lines.join('\n').replace(/\[图片\]|\[表情\]|\[文件\]|\[语音\]/g, '').trim(),
    }))
    .filter((m) => m.text && !/^\[.*\]$/.test(m.text));
  const selfCount = cleaned.filter((m) => selfSet.has(m.sender)).length;
  if (cleaned.length && !selfCount) {
    errors.push(`没找到「${[...selfSet].join('/')}」的消息，请用 --me 指定你的昵称（文件里的发送者：${[...new Set(cleaned.map((m) => m.sender))].slice(0, 6).join('、')}）`);
    return { examples, errors };
  }
  for (let i = 1; i < cleaned.length; i++) {
    const prev = cleaned[i - 1];
    const cur = cleaned[i];
    if (prev.sender === cur.sender) continue;
    if (!selfSet.has(cur.sender)) continue; // 回复必须出自「我」
    if (cur.text.length > maxReplyChars) continue;
    if (/^https?:\/\//.test(cur.text)) continue;
    const normalized = normalizeExample(
      { context: [{ role: 'other', text: prev.text }], reply: cur.text },
      { source },
    );
    if (normalized) examples.push(normalized);
    else errors.push(`配对失败：${cur.text.slice(0, 20)}`);
  }
  return { examples, errors };
}

/**
 * 解析「粘贴式」聊天记录。支持两种形状，脚本会自动认：
 *
 * ① 一行一条（手写/整理过的）：
 *      我：在干嘛
 *      对方：刚下班 累死
 *
 * ② QQ 多选复制出来的原文（名字和时间在同一行，正文在下面）：
 *      26242: 10-22 00:46:48
 *      不搞管理
 *      望希: 10-22 00:47:37
 *      我们群那个ai似了
 *
 * 多行消息会拼到上一个说话人身上；空行、分隔线忽略。
 */
export function parseChatPaste(text, { source = 'paste', maxReplyChars = 60, selfNames = ['我', '本人', '自己'] } = {}) {
  const examples = [];
  const errors = [];
  const selfSet = new Set((selfNames ?? []).filter(Boolean));
  const noteNames = new Set(['注', '场景', '旁白']);
  const placeholder = /\[(?:图片|表情|文件|语音|视频|动画表情|闪照|位置|链接|卡片消息|回复)\]/g;
  const messages = [];
  // 「名字: 10-22 00:46:48」= QQ 复制出来的消息头，时间在名字后面
  const stampedHeader = /^([^:：\n]{1,24}?)\s*[:：]\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}日)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/;
  const rawLines = String(text ?? '').split(/\r?\n/);
  // 出现「> 内容」就进入标记模式：带 > 的是我说的，其余行是别人说的
  const markedMode = rawLines.some((rawLine) => /^>\s*\S/.test(rawLine.trim()));
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^=+$/.test(line) || /^-{3,}$/.test(line)) continue;
    // 「> 内容」= 我说的话（QQ 复制不带名字时用这个标记）
    if (line.startsWith('>')) {
      const body = line.replace(/^>\s*/, '').trim();
      if (!body) continue;
      const previousMe = messages[messages.length - 1];
      if (previousMe && previousMe.role === 'me' && previousMe.marked) {
        previousMe.lines.push(body);
      } else {
        messages.push({ role: 'me', name: '我', marked: true, lines: [body] });
      }
      continue;
    }
    const stamped = stampedHeader.exec(line);
    if (stamped) {
      const name = stamped[1].trim();
      const rest = stamped[4].trim();
      messages.push({
        role: selfSet.has(name) ? 'me' : noteNames.has(name) ? 'note' : 'other',
        name,
        time: `${stamped[2]} ${stamped[3]}`,
        lines: rest ? [rest] : [],
      });
      continue;
    }
    const matched = /^([^:：\s][^:：]{0,19})\s*[:：]\s*(.*)$/.exec(line);
    if (matched) {
      const name = matched[1].trim();
      const body = matched[2].trim();
      // 「http：//」「14：32」这种不是人名，当作上一条消息的续行
      if (/\d{1,2}:\d{2}/.test(name) || /^https?$/i.test(name)) {
        const lastMessage = messages[messages.length - 1];
        if (lastMessage) lastMessage.lines.push(line);
        continue;
      }
      messages.push({
        role: selfSet.has(name) ? 'me' : noteNames.has(name) ? 'note' : 'other',
        name,
        lines: body ? [body] : [],
      });
      continue;
    }
    const lastMessage = messages[messages.length - 1];
    if (markedMode) {
      // 标记模式下，没带 > 的行 = 别人说的；连续几行算同一个人连着发
      if (lastMessage && lastMessage.role === 'other' && !lastMessage.stamped) lastMessage.lines.push(line);
      else messages.push({ role: 'other', name: '对方', lines: [line] });
      continue;
    }
    if (lastMessage) lastMessage.lines.push(line); // 没有「名字：」前缀的行 = 上一条消息的续行
  }

  const cleaned = messages
    .map((message) => ({ ...message, text: message.lines.join(' ').replace(placeholder, '').trim() }))
    .filter((message) => message.text);
  if (!cleaned.length) {
    errors.push('没有识别出「名字：内容」的行，格式示例：我：在干嘛 / 对方：刚下班');
    return { examples, errors };
  }
  // 同一个人连着发几句时合并成一条，否则上下文会被切碎（「封」+「一个算jb」这种）
  const merged = [];
  for (const message of cleaned) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role && previous.name === message.name) {
      previous.text = `${previous.text} ${message.text}`.trim();
      continue;
    }
    merged.push({ ...message });
  }
  if (!merged.some((message) => message.role === 'me')) {
    errors.push(`没找到「${[...selfSet].join('/')}」说话的行，把你自己发的消息写成「我：…」，或用 --me 指定昵称`);
    return { examples, errors };
  }

  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1];
    const cur = merged[i];
    if (cur.role !== 'me') continue;
    if (prev.role === 'me') continue;
    if (prev.text.length < 2) continue; // 「是」「封」这种一问一答没有语气可学
    if (cur.text.length > maxReplyChars) continue;
    if (/^https?:\/\//i.test(cur.text)) continue;
    const normalized = normalizeExample(
      { context: [{ role: prev.role, text: prev.text }], reply: cur.text },
      { source },
    );
    if (normalized) examples.push(normalized);
    else errors.push(`配对失败：${cur.text.slice(0, 20)}`);
  }
  return { examples, errors };
}

/**
 * 识别 QQ 的加密聊天记录备份（.bak）。
 * 这类文件是 zip 包，里面是头部改成「SQLite header 3」的加密库，只有 QQ 自己能导入还原，
 * 任何外部工具都读不出明文，所以这里只做识别 + 报错指引，不尝试解密。
 * 返回 '' / 'zip-sqlite-encrypted' / 'sqlite-encrypted'。
 */
export function looksLikeQqBak(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'latin1');
  if (!buffer.length) return '';
  const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  const head = buffer.subarray(0, 256).toString('latin1');
  if (head.includes('SQLite header 3')) return isZip ? 'zip-sqlite-encrypted' : 'sqlite-encrypted';
  return '';
}

/** 合并去重（id 相同视为同一条）。 */
export function mergeExamples(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const example of Array.isArray(list) ? list : []) {
      if (example?.id && !byId.has(example.id)) byId.set(example.id, example);
    }
  }
  return [...byId.values()];
}

export function toJsonl(examples) {
  return examples.map((example) => JSON.stringify(example)).join('\n') + (examples.length ? '\n' : '');
}

// ── 相似度检索 ──────────────────────────────────────────────────────────────

function bigrams(text) {
  const chars = Array.from(String(text ?? '').toLowerCase().replace(/[\s\p{P}]/gu, ''));
  const grams = new Set();
  for (let i = 0; i < chars.length - 1; i++) grams.add(chars[i] + chars[i + 1]);
  if (!grams.size && chars.length) grams.add(chars[0]);
  return grams;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * 从库里挑出与当轮消息最像的几条。
 * @param {object[]} examples 已规范化的样本
 * @param {string[]} recentTexts 最近几条消息（旧→新）
 * @param {{max?:number, maxChars?:number, excludeIds?:string[], scenes?:string[], seed?:number}} opts
 */
export function retrieveFewshot(examples, recentTexts = [], opts = {}) {
  const max = Math.max(1, Number(opts.max) || FEWSHOT_DEFAULTS.maxExamples);
  const maxChars = Math.max(120, Number(opts.maxChars) || FEWSHOT_DEFAULTS.maxChars);
  const excluded = new Set(opts.excludeIds ?? []);
  const scenes = new Set(opts.scenes ?? []);
  const texts = (recentTexts ?? []).map((text) => String(text ?? '')).filter(Boolean);
  const recentGrams = texts.map(bigrams);
  const joined = texts.join(' ');
  const seed = Number(opts.seed) || 0;

  const scored = [];
  for (const example of Array.isArray(examples) ? examples : []) {
    if (!example?.id || excluded.has(example.id)) continue;
    let score = 0;
    for (const item of example.context) {
      if (item.role === 'me') continue; // 「群友」和「注」都参与相似度，注里往往是场景线索
      const grams = bigrams(item.text);
      for (const rg of recentGrams) score = Math.max(score, jaccard(grams, rg));
    }
    for (const tag of example.tags ?? []) {
      if (tag && joined.includes(tag)) score = Math.max(score, 0.75);
    }
    if (example.scene && scenes.has(example.scene)) score = Math.max(score, 0.6);
    else if (scenes.size && (example.tags ?? []).some((tag) => scenes.has(tag))) score = Math.max(score, 0.6);
    // 抖动只用来打散同分/兜底抽样，不参与「够不够像」的判定
    const jitter = ((parseInt(example.id.slice(0, 6), 16) + seed) % 1000) / 1000;
    scored.push({ example, score, jitter });
  }

  scored.sort((a, b) => b.score - a.score || b.jitter - a.jitter || a.example.id.localeCompare(b.example.id));
  const minScore = Math.max(0, Number(opts.minScore) || 0.12);
  const fallbackCount = Math.max(0, Number(opts.fallbackCount ?? 1));
  const picked = [];
  let used = 0;
  const take = (item) => {
    const line = formatExampleLine(item.example);
    if (used + line.length > maxChars) return false;
    used += line.length;
    picked.push(item.example);
    return true;
  };
  // 第一轮：只要够像的
  for (const item of scored) {
    if (picked.length >= max) break;
    if (item.score >= minScore) take(item);
  }
  // 第二轮：一个都没抽中时用兜底样本（按抖动轮换），保证每轮都有语气样例可看
  if (picked.length < Math.min(fallbackCount, max)) {
    for (const item of scored) {
      if (picked.length >= Math.min(fallbackCount, max)) break;
      if (picked.some((existing) => existing.id === item.example.id)) continue;
      take(item);
    }
  }
  return picked;
}

/** 单条样本渲染成两行：「群友：…」/「你：…」。 */
export function formatExampleLine(example) {
  const ctx = (example.context ?? []).slice(-2)
    .map((item) => (item.role === 'note' ? `（${item.text}）` : `群友：${item.text}`))
    .join('\n');
  return `${ctx ? `${ctx}\n` : ''}你：${example.reply}\n`;
}

/** 渲染成注入块；空库返回空串。 */
export function formatFewshotBlock(examples) {
  const items = (examples ?? []).filter((example) => example?.reply);
  if (!items.length) return '';
  return `【接话参考 · 学语气和长度，别照抄内容】\n${items.map(formatExampleLine).join('')}`;
}

// ── 反例（negative.jsonl）────────────────────────────────────────────────
// 为什么要有：正例只说「该这么说」，模型很容易把「短」当成唯一目标，学出另一种模板。
// 反例给的是「同一句话，这么接就 AI 味了 / 这么接才对」的最小对照，
// 对「删了 AI 腔但变成冷冰冰」这一类副作用更有效。
//
// 反例**默认不注入**（`style.fewshot.negativeEnabled` 默认 false）：
// 每轮注入量要付 token，先让人看过再说。

export const NEGATIVE_LIMITS = {
  badMax: 160,
  goodMax: 160,
  whyMax: 60,
  maxInBlock: 2,
};

/** 规范化一条反例；缺 `bad` 或 `good`、两者相同、或与正例不可区分时返回 null。 */
export function normalizeNegative(raw, { source = 'manual' } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const bad = collapse(String(raw.bad ?? '')).slice(0, NEGATIVE_LIMITS.badMax).trim();
  const good = collapse(String(raw.good ?? '')).slice(0, NEGATIVE_LIMITS.goodMax).trim();
  if (!bad || !good) return null;
  if (bad === good) return null;
  const context = (Array.isArray(raw.context) ? raw.context : [])
    .map((item) => {
      if (!item) return null;
      const text = collapse(String(item.text ?? '')).slice(0, CONTEXT_MAX).trim();
      if (!text) return null;
      const role = item.role === 'me' ? 'me' : item.role === 'note' ? 'note' : 'other';
      return { role, text };
    })
    .filter(Boolean)
    .slice(-CONTEXT_ITEMS_MAX);
  const why = collapse(String(raw.why ?? '')).slice(0, NEGATIVE_LIMITS.whyMax).trim();
  const tags = (Array.isArray(raw.tags) ? raw.tags : [])
    .map((tag) => collapse(String(tag ?? '')).trim())
    .filter(Boolean)
    .slice(0, TAGS_MAX);
  const negative = { context, bad, good, why, tags, source, covered: raw.covered !== false };
  negative.id = crypto.createHash('sha1')
    .update(JSON.stringify([context.map((c) => [c.role, c.text]), bad, good]))
    .digest('hex').slice(0, 12);
  return negative;
}

/** 读反例 JSONL；坏行不炸，记进 errors。 */
export function readNegatives(filePath) {
  const negatives = [];
  const errors = [];
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { negatives, errors };
  }
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('//')) continue;
    try {
      const parsed = JSON.parse(line);
      const normalized = normalizeNegative(parsed, { source: parsed.source || 'manual' });
      if (!normalized) {
        errors.push(`${path.basename(filePath)}:${i + 1} 缺少 bad/good（或两者相同）`);
        continue;
      }
      negatives.push(normalized);
    } catch (error) {
      errors.push(`${path.basename(filePath)}:${i + 1} JSON 解析失败（${error?.message ?? error}）`);
    }
  }
  return { negatives, errors };
}

/** 反例块：每条给「上下文 → ✗ 反例（毛病）→ ✓ 正例」，最多 2 条，避免把预算吃光。 */
export function formatNegativeBlock(negatives, {
  max = NEGATIVE_LIMITS.maxInBlock,
  maxChars = NEGATIVE_LIMITS.blockMaxChars,
} = {}) {
  const limit = Math.max(1, Math.min(NEGATIVE_LIMITS.maxInBlock, Number(max) || NEGATIVE_LIMITS.maxInBlock));
  const budget = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Math.floor(Number(maxChars))
    : NEGATIVE_LIMITS.blockMaxChars;
  const items = (negatives ?? []).filter((item) => item?.bad && item?.good).slice(0, limit);
  if (!items.length) return '';
  const lines = items.map((item) => {
    const ctx = (item.context ?? []).slice(-1)
      .map((entry) => {
        // 归属必须对：把我方发言标成「群友」会让模型学到相反的说话人。
        if (entry.role === 'note') return `（${entry.text}）`;
        if (entry.role === 'me') return `我：${entry.text}`;
        return `群友：${entry.text}`;
      })
      .join('\n');
    const why = item.why ? `（${item.why}）` : '';
    return `${ctx ? `${ctx}\n` : ''}✗ ${item.bad}${why}\n✓ ${item.good}`;
  });
  // 反例块也要吃预算：先前只限条数，两条长反例能把提示词撑出几百字符。
  const header = '【别这么接 · AI 味反例】';
  const kept = [];
  let size = header.length + 2;
  for (const line of lines) {
    if (size + line.length + 1 > budget) break;
    kept.push(line);
    size += line.length + 1;
  }
  if (!kept.length) return ''; // 一条都塞不下就整块不注入，不交半截标记
  return `${header}\n${kept.join('\n')}\n`;
}

/** 按当轮消息挑最相关的反例；一个都不像时按 id 稳定取前几条（保证每轮都有对照）。 */
export function retrieveNegatives(negatives, recentTexts = [], { max = NEGATIVE_LIMITS.maxInBlock } = {}) {
  const limit = Math.max(1, Math.min(NEGATIVE_LIMITS.maxInBlock, Number(max) || NEGATIVE_LIMITS.maxInBlock));
  const texts = (recentTexts ?? []).map((text) => String(text ?? '')).filter(Boolean);
  const recentGrams = texts.map(bigrams);
  const scored = [];
  for (const item of Array.isArray(negatives) ? negatives : []) {
    if (!item?.bad || !item?.good) continue;
    let score = 0;
    for (const entry of item.context ?? []) {
      const grams = bigrams(entry.text);
      for (const rg of recentGrams) score = Math.max(score, jaccard(grams, rg));
    }
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  return scored.slice(0, limit).map((entry) => entry.item);
}

// ── 目录加载（带 mtime 缓存） ───────────────────────────────────────────────

const cache = new Map();

/**
 * 读取库（examples.jsonl + negative.jsonl）。
 *
 * 两类素材各自独立：没有正例也要能读反例、只改 negative.jsonl 也要立刻生效。
 * 两件事早先都错了 —— 缓存指纹只算了 examples.jsonl 的 mtime/size，且文件不存在时
 * 直接返回空库（反例文件根本没打开）。结果是「打开 negativeEnabled 却毫无变化」，
 * 很容易被误读成「反例没用」。
 */
export function loadFewshot(dirPath) {
  const file = path.join(dirPath, 'examples.jsonl');
  const negativeFile = path.join(dirPath, 'negative.jsonl');
  const statOf = (target) => {
    try {
      const st = fs.statSync(target);
      return { mtimeMs: st.mtimeMs, size: st.size, exists: true };
    } catch {
      // 缺文件按 0 记，两份指纹拼起来才完整（新建文件也会让指纹变化）。
      return { mtimeMs: 0, size: 0, exists: false };
    }
  };
  const exStat = statOf(file);
  const negStat = statOf(negativeFile);
  if (!exStat.exists && !negStat.exists) {
    return { examples: [], negative: [], errors: [], file: null, mtimeMs: 0 };
  }
  const cached = cache.get(file);
  if (
    cached &&
    cached.mtimeMs === exStat.mtimeMs &&
    cached.size === exStat.size &&
    cached.negativeMtimeMs === negStat.mtimeMs &&
    cached.negativeSize === negStat.size
  ) {
    return cached.data;
  }
  const { examples, errors } = exStat.exists ? readJsonl(file) : { examples: [], errors: [] };
  const negativeRead = negStat.exists ? readNegatives(negativeFile) : { negatives: [], errors: [] };
  const negative = negativeRead.negatives;
  const data = {
    examples: exStat.exists ? mergeExamples(examples) : [],
    negative,
    errors: [...errors, ...negativeRead.errors],
    file: exStat.exists ? file : null,
    mtimeMs: exStat.mtimeMs,
    size: exStat.size
  };
  cache.set(file, {
    mtimeMs: exStat.mtimeMs,
    size: exStat.size,
    negativeMtimeMs: negStat.mtimeMs,
    negativeSize: negStat.size,
    data
  });
  return data;
}

export function clearFewshotCache() {
  cache.clear();
}
