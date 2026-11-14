// 日记本：每个 QQ 会话（群 / 私聊）一个独立的本子，一天一页。
//
// 设计取舍：
//  1) 本子按会话 key 落盘成独立文件（state/diary/<safeKey>.json），而不是并进 social-v2.json。
//     日记是低频写、长期留存的数据；social-v2.json 每轮对话都在写，混在一起既容易丢页，
//     也让「导出 / 备份 / 手动修」变得麻烦。
//  2) 一天一页（同一日期重复写入默认是**追加**，不是覆盖）。这是「日记」而不是「记忆」：
//     记忆条目短、会衰减、用于对话；日记页长、留档、用于回看。两者不能互相替代。
//  3) 时间一律按 Asia/Shanghai 的墙上日期切页：凌晨 0 点前的对话算当天，不会因为 UTC 偏移
//     把「昨晚写的」算成今天。
//  4) 模块本身不碰网络、不碰 config 加载：桥接传 cfg 进来，单测可以完全离线跑。
import fs from 'node:fs';
import path from 'node:path';
import { parseClock, zoneParts } from './reminders.js';

export const DIARY_TZ = 'Asia/Shanghai';
export const DIARY_VERSION = 1;

/** 默认配置（对应 config.json 的 socialV2.diary，可整段缺省）。 */
export const DIARY_DEFAULTS = Object.freeze({
  enabled: true,
  dir: 'state/diary',
  autoWrite: {
    enabled: true,
    clock: '23:30',
    tickMs: 120000,
    // 当天至少有过这么多条来信才值得写；1 = 有人说话就写（机器人自己的回复不算）。
    minMessages: 1,
    // 自动写只写一页/天（幂等）：当天已有页就跳过，不重复打扰模型。
    maxPagesPerDay: 1,
  },
  maxPagesPerNotebook: 2000,
  maxPageChars: 4000,
  maxTextChars: 1200,
  maxTitleChars: 40,
  maxMoodChars: 12,
  maxWeatherChars: 12,
  maxTags: 5,
  maxTagChars: 12,
  // 操作者手写的真日记样本（few-shot），由 diaryCfg 清洗成 string[]；空则唤醒提示用内置兜底。
  styleSamples: [],
});

export class DiaryError extends Error {
  constructor(message, code = 'diary_error') {
    super(message);
    this.name = 'DiaryError';
    this.code = code;
  }
}

/** 会话 key → 文件名安全片段：group:123 → group_123；未知格式直接拒绝。 */
export function safeKeyName(key) {
  const m = /^(group|private):(\d{1,20})$/.exec(String(key ?? '').trim());
  if (!m) throw new DiaryError(`无效的会话 key：${String(key ?? '')}（应为 group:群号 或 private:QQ号）`, 'bad_key');
  return `${m[1]}_${m[2]}`;
}

export function notebookFile(dir, key) {
  return path.join(dir, `${safeKeyName(key)}.json`);
}

function clampText(text, max) {
  const s = String(text ?? '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
  const limit = Number(max);
  // 调用方传了残缺 cfg 时不要把整段文字当成「超长」——NaN 比较恒为 false，会误加省略号前缀。
  if (!Number.isFinite(limit) || limit <= 0) return s;
  if (s.length <= limit) return s;
  // 超长时保留尾巴：日记的结尾通常才是情绪落点，截断开头比截断结尾更不伤语义。
  return `…${s.slice(s.length - limit + 1)}`;
}

export function todayString(nowMs = Date.now(), tz = DIARY_TZ) {
  const p = zoneParts(nowMs, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** 校验 YYYY-MM-DD（真日期，不接受 2026-02-30）。 */
export function isDateString(text) {
  const s = String(text ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function normalizeTags(tags, cfg) {
  const list = Array.isArray(tags) ? tags : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const t = String(raw ?? '').replace(/^#/, '').trim().slice(0, cfg.maxTagChars);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= cfg.maxTags) break;
  }
  return out;
}

export function emptyNotebook(key, { nowMs = Date.now() } = {}) {
  const m = /^(group|private):(\d{1,20})$/.exec(String(key ?? '').trim());
  const iso = new Date(nowMs).toISOString();
  return {
    version: DIARY_VERSION,
    key: `${m[1]}:${m[2]}`,
    kind: m[1],
    targetId: m[2],
    createdAt: iso,
    updatedAt: iso,
    pages: [],
  };
}

/**
 * 读出本子；文件不存在返回空本子（不落盘），损坏则抛 DiaryError（宁可报错也别把旧页覆盖掉）。
 */
export function loadNotebook(file, key, { nowMs = Date.now() } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyNotebook(key, { nowMs });
    if (error?.code === 'ENOTDIR') return emptyNotebook(key, { nowMs });
    throw new DiaryError(`读取日记本失败：${error?.message ?? error}`, 'read_failed');
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new DiaryError('日记本文件不是合法 JSON，已拒绝覆盖（请先人工修复或备份后删除）', 'corrupt');
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.pages)) {
    throw new DiaryError('日记本文件结构异常（缺少 pages），已拒绝覆盖', 'corrupt');
  }
  const base = emptyNotebook(key, { nowMs });
  return {
    ...base,
    ...data,
    key: base.key,
    kind: base.kind,
    targetId: base.targetId,
    pages: data.pages.filter((p) => p && typeof p === 'object' && typeof p.date === 'string'),
  };
}

/** 原子落盘：先写 .tmp 再 rename，避免进程被杀时留下半截 JSON。 */
export function saveNotebook(file, book, { nowMs = Date.now() } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const payload = { ...book, version: DIARY_VERSION, updatedAt: new Date(nowMs).toISOString() };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return payload;
}

function findPageIndex(book, { date, id } = {}) {
  const d = String(date ?? '').trim();
  const pid = String(id ?? '').trim();
  if (pid) return book.pages.findIndex((p) => String(p.id) === pid);
  if (d) return book.pages.findIndex((p) => p.date === d);
  return -1;
}

function newPageId(nowMs) {
  return `dy_${nowMs.toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
}

/**
 * 写一页。
 * - 同一日期已有页：默认追加到正文（日记是「今天的流水」，不是覆盖），`replace: true` 才整页替换。
 * - 没传 date 用今天。
 * 返回 { book, page, created, appended, truncated }。
 */
export function writePage(book, input = {}, { cfg = DIARY_DEFAULTS, nowMs = Date.now() } = {}) {
  const text = clampText(input.text, cfg.maxTextChars);
  if (!text) throw new DiaryError('日记正文不能为空', 'empty_text');
  const date = input.date ? String(input.date).trim() : todayString(nowMs);
  if (!isDateString(date)) throw new DiaryError(`日期格式不对：${date}（应为 YYYY-MM-DD）`, 'bad_date');
  const title = clampText(input.title, cfg.maxTitleChars);
  const mood = clampText(input.mood, cfg.maxMoodChars);
  const weather = clampText(input.weather, cfg.maxWeatherChars);
  const tags = normalizeTags(input.tags, cfg);
  const source = input.source === 'auto' ? 'auto' : input.source === 'operator' ? 'operator' : 'ai';
  const iso = new Date(nowMs).toISOString();

  let idx = findPageIndex(book, { date });
  let created = false;
  let appended = false;
  let truncated = false;
  if (idx < 0) {
    const page = {
      id: newPageId(nowMs),
      date,
      text,
      title,
      mood,
      weather,
      tags,
      source,
      createdAt: iso,
      updatedAt: iso,
    };
    book.pages.push(page);
    book.pages.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    idx = book.pages.findIndex((p) => p.id === page.id);
    created = true;
  } else {
    const page = book.pages[idx];
    if (input.replace === true) {
      page.text = text;
    } else {
      const merged = `${page.text}\n\n${text}`;
      if (merged.length > cfg.maxPageChars) {
        page.text = clampText(merged, cfg.maxPageChars);
        truncated = true;
      } else {
        page.text = merged;
      }
      appended = true;
    }
    if (title) page.title = title;
    if (mood) page.mood = mood;
    if (weather) page.weather = weather;
    if (tags.length) page.tags = normalizeTags([...(page.tags ?? []), ...tags], cfg);
    page.source = source === 'operator' ? 'operator' : page.source === 'operator' ? 'operator' : source;
    page.updatedAt = iso;
  }
  // 本子太长时裁剪最旧的页（保留 autoWrite 需要的最近记录）。
  const max = Math.max(1, Number(cfg.maxPagesPerNotebook) || DIARY_DEFAULTS.maxPagesPerNotebook);
  let removed = 0;
  while (book.pages.length > max) {
    book.pages.shift();
    removed += 1;
  }
  return { book, page: book.pages[idx], created, appended, truncated, removed };
}

export function removePage(book, { date, id } = {}) {
  const idx = findPageIndex(book, { date, id });
  if (idx < 0) throw new DiaryError('没有找到对应的日记页', 'not_found');
  const [page] = book.pages.splice(idx, 1);
  return page;
}

export function hasPage(book, date) {
  return findPageIndex(book, { date }) >= 0;
}

/** 倒序（新页在前），可按日期区间、条数截取。 */
export function selectPages(book, { date, from, to, limit = 1 } = {}) {
  let pages = [...book.pages];
  if (date) {
    const d = String(date).trim();
    pages = pages.filter((p) => p.date === d || p.date.startsWith(d));
  }
  if (from) pages = pages.filter((p) => p.date >= String(from).trim());
  if (to) pages = pages.filter((p) => p.date <= String(to).trim());
  pages.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const n = Math.max(1, Math.min(200, Number(limit) || 1));
  return pages.slice(0, n);
}

export function notebookStats(book, { nowMs = Date.now() } = {}) {
  const pages = Array.isArray(book?.pages) ? book.pages : [];
  const chars = pages.reduce((sum, p) => sum + String(p.text ?? '').length, 0);
  const today = todayString(nowMs);
  return {
    pages: pages.length,
    chars,
    today,
    writtenToday: pages.some((p) => p.date === today),
    firstDate: pages[0]?.date ?? null,
    lastDate: pages[pages.length - 1]?.date ?? null,
  };
}

function pageHeading(page) {
  const bits = [page.date];
  if (page.weather) bits.push(page.weather);
  if (page.mood) bits.push(page.mood);
  const head = `【${page.title || '无题'}】`;
  return `${head} ${bits.join(' · ')}${page.tags?.length ? `  #${page.tags.join(' #')}` : ''}`;
}

/** 给模型看的格式：页标题 + 正文。 */
export function formatPages(pages) {
  if (!pages?.length) return '（本子还是空的）';
  return pages.map((p) => `${pageHeading(p)}\n${p.text}`).join('\n\n');
}

/** Markdown 导出：控制台下载用。 */
export function toMarkdown(book) {
  const head = `# ${book.kind === 'group' ? '群' : '私聊'}本子 ${book.targetId}\n\n`;
  const body = [...book.pages]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((p) => {
      const meta = [p.weather, p.mood].filter(Boolean).join(' · ');
      const tags = p.tags?.length ? ` ${p.tags.map((t) => `#${t}`).join(' ')}` : '';
      return `## ${p.date}${p.title ? ` ${p.title}` : ''}\n\n${meta ? `${meta}${tags}\n\n` : tags ? `${tags.trim()}\n\n` : ''}${p.text}`;
    })
    .join('\n\n');
  return `${head}${body}\n`;
}

/**
 * 扫描日记目录，给控制台列本子用。坏文件跳过而不是整体失败。
 */
export function listNotebooks(dir, { nowMs = Date.now() } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new DiaryError(`读取日记目录失败：${error?.message ?? error}`, 'read_failed');
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!data || !Array.isArray(data.pages)) continue;
    const pages = data.pages;
    const chars = pages.reduce((sum, p) => sum + String(p.text ?? '').length, 0);
    const today = todayString(nowMs);
    out.push({
      key: data.key ?? name.replace(/\.json$/, ''),
      kind: data.kind ?? null,
      targetId: data.targetId ?? null,
      pages: pages.length,
      chars,
      writtenToday: pages.some((p) => p.date === today),
      firstDate: pages[0]?.date ?? null,
      lastDate: pages[pages.length - 1]?.date ?? null,
      updatedAt: data.updatedAt ?? null,
    });
  }
  out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return out;
}

/** 每日自动写的时钟校验（供桥接热读配置时用）。 */
export function autoWriteClock(text) {
  const clock = parseClock(text);
  return clock ?? parseClock(DIARY_DEFAULTS.autoWrite.clock);
}

/** 把 config 里的 socialV2.diary 与默认值合并（浅合并 + autoWrite 深合并）。 */
export function diaryCfg(cfg) {
  const raw = cfg?.socialV2?.diary ?? {};
  const auto = raw.autoWrite && typeof raw.autoWrite === 'object' ? raw.autoWrite : {};
  const merged = { ...DIARY_DEFAULTS, ...raw, autoWrite: { ...DIARY_DEFAULTS.autoWrite, ...auto } };
  merged.enabled = raw.enabled !== false;
  merged.autoWrite.enabled = merged.enabled && auto.enabled !== false;
  merged.autoWrite.clock = String(merged.autoWrite.clock || DIARY_DEFAULTS.autoWrite.clock);
  merged.autoWrite.tickMs = Math.max(30_000, Number(merged.autoWrite.tickMs) || DIARY_DEFAULTS.autoWrite.tickMs);
  merged.autoWrite.minMessages = Math.max(0, Number(merged.autoWrite.minMessages) || 0);
  merged.maxPagesPerNotebook = Math.max(1, Number(merged.maxPagesPerNotebook) || DIARY_DEFAULTS.maxPagesPerNotebook);
  merged.maxPageChars = Math.max(200, Number(merged.maxPageChars) || DIARY_DEFAULTS.maxPageChars);
  merged.maxTextChars = Math.max(50, Math.min(merged.maxPageChars, Number(merged.maxTextChars) || DIARY_DEFAULTS.maxTextChars));
  // 文风示范样本：操作者手写的真日记，最多 5 条、每条 200 字以内（走唤醒提示，不进人格）
  const samplesRaw = Array.isArray(raw.styleSamples) ? raw.styleSamples : [];
  merged.styleSamples = samplesRaw
    .map((t) => String(t ?? '').trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((t) => t.slice(0, 200));
  return merged;
}
