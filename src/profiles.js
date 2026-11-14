// 群友档案 / 长记忆：存储、脱敏、降权与提示词拼装。
//
// 设计要点（来自管理员需求 2026-10-19）：
//   1. 分层：短期（当前话题，仍在 social-v2.json 的 activeTopics）→ 个人档案（本文件 people）
//      → 群文化（本文件 groups：黑话/梗/称呼；黑话正文仍以 state/slang.json 为准）；
//   2. 只记**具体事例**，不写空泛评价（looksLikeBareLabel 会拦掉"温柔""可爱"这类标签）；
//   3. 隐私：写入前必过 scrubSensitive（手机号/身份证/卡号/邮箱/密码/地址/验证码一律抹掉），
//      整条只剩掩码的直接拒绝；
//   4. 写入克制：由桥接的 settle 闸门控制（对话告一段落才允许抽取），过期按半衰期降权并清理。
//
// 本文件不依赖桥接，所有函数都是纯函数，便于离线单测（scripts/test-profiles.mjs）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PROFILE_RECORD_KINDS = Object.freeze([
  'event',    // 重要事件（带日期）
  'care',     // 在意的事（喜欢/重视/计划）
  'avoid',    // 雷点（明确讨厌、被冒犯过）
  'topic',    // 常聊话题（具体到"在准备考研数学"）
  'style',    // 说话风格（具体观察，如"爱用括号补刀"）
  'nickname', // 称呼（谁把他叫什么、他自己的自称）
  'note',     // 其它具体事例
  'legacy'    // 旧印象迁移进来，默认不注入提示词
]);

export const PROFILE_DEFAULTS = Object.freeze({
  enabled: true,
  settleIdleMs: 6 * 60 * 1000,      // 对话安静这么久才算"告一段落"
  sliceMaxMessages: 40,             // 每次抽取最多看这么多条
  sliceMinMessages: 6,              // 少于这么多条不抽
  extractCooldownMs: 30 * 60 * 1000, // 同一会话两次抽取间隔
  extractPerHour: 20,               // 全局每小时最多抽取次数
  maxPeople: 200,
  maxRecordsPerPerson: 80,
  maxTermsPerGroup: 120,
  halfLifeDays: 30,                 // 权重半衰期
  pruneWeight: 0.12,                // 低于此权重且过期会被清理
  pruneAfterDays: 120,
  injectMaxPersons: 3,
  injectMaxChars: 900
});

const KIND_WEIGHT = Object.freeze({
  event: 0.9,
  care: 0.8,
  avoid: 0.85,
  topic: 0.6,
  style: 0.55,
  nickname: 0.5,
  note: 0.5,
  legacy: 0.3
});

const TEXT_MIN = 6;
const TEXT_MAX = 160;
const EVIDENCE_MAX = 80;
const DAY_MS = 24 * 60 * 60 * 1000;

export function profileCfg(cfg) {
  const raw = cfg?.socialV2?.profile ?? {};
  const out = { ...PROFILE_DEFAULTS };
  for (const [k, def] of Object.entries(PROFILE_DEFAULTS)) {
    if (raw[k] === undefined || raw[k] === null) continue;
    out[k] = typeof def === 'boolean' ? raw[k] !== false : Math.max(1, Math.round(Number(raw[k]) || Number(def)));
  }
  out.enabled = raw.enabled !== false;
  return out;
}

export function emptyStore() {
  return {
    version: 1,
    people: {},
    groups: {},
    settle: {},
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastPruneAt: 0, migratedImpressions: false }
  };
}

export function normalizeStore(raw) {
  const store = raw && typeof raw === 'object' ? raw : {};
  const out = emptyStore();
  out.people = store.people && typeof store.people === 'object' && !Array.isArray(store.people) ? store.people : {};
  out.groups = store.groups && typeof store.groups === 'object' && !Array.isArray(store.groups) ? store.groups : {};
  out.settle = store.settle && typeof store.settle === 'object' && !Array.isArray(store.settle) ? store.settle : {};
  out.meta = { ...out.meta, ...(store.meta && typeof store.meta === 'object' ? store.meta : {}) };
  // 防御原型污染：只接受纯数字 QQ / 群号作为键。
  for (const bag of [out.people, out.groups, out.settle]) {
    for (const key of Object.keys(bag)) {
      if (!/^[0-9_a-zA-Z:.-]{1,64}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) delete bag[key];
    }
  }
  return out;
}

export function loadProfiles(file, { onCorrupt } = {}) {
  try {
    if (!fs.existsSync(file)) return emptyStore();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalizeStore(raw);
  } catch (error) {
    if (typeof onCorrupt === 'function') onCorrupt(`群友档案读取失败，已重置：${error?.message ?? error}`);
    return emptyStore();
  }
}

export function saveProfiles(file, store, { writer } = {}) {
  const next = normalizeStore(store);
  next.meta.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (typeof writer === 'function') {
    writer(file, next);
    return next;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

export function createId(prefix = 'p') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export function normalizePersonId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4,12}$/.test(text)) return null;
  if (['__proto__', 'constructor', 'prototype'].includes(text)) return null;
  return text;
}

// 敏感信息过滤：宁可少记，不可泄漏。命中即替换为 [已隐去]。
const SENSITIVE_PATTERNS = [
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[已隐去]'],                                  // 手机号
  [/(?<!\d)\d{17}[\dXx](?!\d)/g, '[已隐去]'],                                  // 身份证
  [/(?<!\d)\d{16,19}(?!\d)/g, '[已隐去]'],                                     // 银行卡/长数字
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[已隐去]'],                                    // 邮箱
  [/(密码|口令|验证码|动态码|校验码|token|密钥|秘钥|api[_-]?key)\s*[:：=是为]*\s*\S{2,}/gi, '$1[已隐去]'],
  [/(住址|家庭住址|详细地址|收货地址|住(?:在|址))\s*[:：]?\s*[^\s，。；,;]{2,}/g, '$1[已隐去]'],
  [/(快递单号|运单号|订单号)\s*[:：]?\s*[A-Za-z0-9]{6,}/g, '$1[已隐去]'],
  [/(?:学号|工号)\s*[:：]?\s*[A-Za-z0-9]{4,}/g, '[已隐去]'],
  [/(?<!\d)\d{4}\s?年\s?\d{1,2}\s?月\s?\d{1,2}\s?日\s?(?:出生|生)|出生于\s*\d{4}/g, '[已隐去]'],
  [/sk-[A-Za-z0-9_-]{16,}/g, '[已隐去]']
];

export function scrubSensitive(input) {
  let text = String(input ?? '');
  for (const [re, replacement] of SENSITIVE_PATTERNS) text = text.replace(re, replacement);
  return text.replace(/\s+/g, ' ').trim();
}

// 只有标签没有事实的写法要被拦：纯形容词 / "他很温柔" / "温柔可爱" 这类。
const LABEL_ADJECTIVES = [
  '温柔', '可爱', '傲娇', '贴心', '高冷', '沙雕', '搞笑', '善良', '聪明', '内向', '外向', '话痨',
  '沉默', '闷骚', '直男', '直女', '好人', '有趣', '无聊', '正常', '奇怪', '友好', '活泼', '安静',
  '成熟', '幼稚', '靠谱', '不靠谱', '情绪化', '理性', '感性', '社恐', '社牛', '乐子人', '二次元',
  '现充', '和气', '热心', '冷漠', '暴躁', '佛系', '卷', '摆烂'
];
const LABEL_ADJ_RE = new RegExp(LABEL_ADJECTIVES.join('|'), 'g');

export function looksLikeBareLabel(input) {
  const text = String(input ?? '').trim();
  if (!text) return true;
  const stripped = text
    .replace(/^(?:(?:他|她|ta|TA|这人|这货|群友)\s*)?(?:很|挺|特|超|蛮|有点|比较|非常|真的|确实)?\s*/, '')
    .replace(LABEL_ADJ_RE, '')
    .replace(/[\s、,，/。！!？?~～…]+/g, '')
    .replace(/[了哦呀啊吧嘛的呢]/g, '')
    .trim();
  return stripped.length === 0;
}

function normalizeDedupeKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s，。、！？!?,.~～…—\-:：;；"'“”‘’()（）\[\]【】]+/g, '')
    .slice(0, 120);
}

function normalizeAt(value) {
  if (!value) return '';
  const text = String(value).trim();
  const m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export function validateRecordInput(input = {}) {
  const personId = normalizePersonId(input.personId ?? input.qq);
  if (!personId) return { ok: false, error: 'personId 必须是 4-12 位 QQ 号' };
  const kind = String(input.kind ?? 'note').trim();
  if (!PROFILE_RECORD_KINDS.includes(kind)) return { ok: false, error: `kind 必须是 ${PROFILE_RECORD_KINDS.join('/')} 之一` };
  const scrubbed = scrubSensitive(input.text);
  if (!scrubbed) return { ok: false, error: 'text 为空（或全部内容是敏感信息，已拒绝落库）' };
  const effectiveLen = scrubbed.replace(/\[已隐去\]/g, '').replace(/[\s\p{P}]/gu, '').length;
  if (scrubbed.includes('[已隐去]') && effectiveLen < 4) {
    return { ok: false, error: 'text 有效内容太少（疑似敏感信息），已拒绝落库' };
  }
  if (looksLikeBareLabel(scrubbed)) return { ok: false, error: '这像空泛评价/标签，请改成具体事例（谁在哪天做了什么、原话是什么）' };
  if (scrubbed.length < TEXT_MIN) return { ok: false, error: `text 太短（至少 ${TEXT_MIN} 字），请写具体事例` };
  if (scrubbed.length > TEXT_MAX) return { ok: false, error: `text 太长（最多 ${TEXT_MAX} 字）` };
  const at = normalizeAt(input.at);
  const evidence = scrubSensitive(input.evidence).slice(0, EVIDENCE_MAX);
  return { ok: true, record: { personId, kind, text: scrubbed, at, evidence } };
}

export function effectiveWeight(record, now = Date.now(), cfg = PROFILE_DEFAULTS) {
  const base = Number(record?.weightBase) || KIND_WEIGHT[record?.kind] || 0.4;
  const touched = Number(record?.lastSeenAt) || Number(record?.createdAt) || now;
  const ageDays = Math.max(0, (now - touched) / DAY_MS);
  const halfLife = Math.max(1, Number(cfg.halfLifeDays) || 30);
  const decayed = base * Math.pow(0.5, ageDays / halfLife);
  // 重复被提到会加一点"新鲜度"，但不会因为反复说就无限升值。
  const seenBoost = Math.min(0.3, Math.log2(1 + (Number(record?.seenCount) || 1)) * 0.08);
  return Math.min(1, decayed + seenBoost * Math.pow(0.5, ageDays / halfLife));
}

function ensurePerson(store, personId, scope) {
  if (!store.people[personId]) {
    store.people[personId] = {
      personId,
      nicknames: [],
      scopes: [],
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      messageCount: 0,
      records: []
    };
  }
  const person = store.people[personId];
  if (!Array.isArray(person.records)) person.records = [];
  if (!Array.isArray(person.nicknames)) person.nicknames = [];
  if (!Array.isArray(person.scopes)) person.scopes = [];
  if (scope && !person.scopes.includes(scope)) person.scopes = [...person.scopes, scope].slice(0, 12);
  person.lastSeenAt = Date.now();
  return person;
}

export function appendRecord(store, input, cfg = PROFILE_DEFAULTS) {
  const checked = validateRecordInput(input);
  if (!checked.ok) return { ok: false, error: checked.error };
  const { personId, kind, text, at, evidence } = checked.record;
  const scope = String(input.scope ?? '').slice(0, 40);
  const person = ensurePerson(store, personId, scope);
  const dedupe = normalizeDedupeKey(text);
  const existing = person.records.find((r) => r.kind === kind && normalizeDedupeKey(r.text) === dedupe);
  if (existing) {
    existing.seenCount = (Number(existing.seenCount) || 1) + 1;
    existing.lastSeenAt = Date.now();
    existing.weightBase = Math.min(1, (Number(existing.weightBase) || KIND_WEIGHT[kind] || 0.4) + 0.08);
    if (at && !existing.at) existing.at = at;
    if (evidence && !existing.evidence) existing.evidence = evidence;
    prunePerson(person, cfg);
    return { ok: true, created: false, record: existing };
  }
  const record = {
    id: createId('rec'),
    kind,
    text,
    at,
    evidence: evidence || '',
    weightBase: KIND_WEIGHT[kind] || 0.4,
    seenCount: 1,
    createdAt: Date.now(),
    lastSeenAt: Date.now()
  };
  person.records.push(record);
  if (kind === 'nickname') {
    const nick = text.slice(0, 24);
    if (!person.nicknames.includes(nick)) person.nicknames = [...person.nicknames, nick].slice(0, 8);
  }
  prunePerson(person, cfg);
  return { ok: true, created: true, record };
}

function prunePerson(person, cfg) {
  const max = Math.max(5, Number(cfg.maxRecordsPerPerson) || 80);
  if (person.records.length <= max) return;
  const now = Date.now();
  person.records.sort((a, b) => effectiveWeight(b, now, cfg) - effectiveWeight(a, now, cfg));
  person.records = person.records.slice(0, max);
}

export function queryPerson(store, personId, { kinds, limit = 20, now = Date.now(), cfg = PROFILE_DEFAULTS } = {}) {
  const id = normalizePersonId(personId);
  if (!id) return { ok: false, error: 'personId 必须是 4-12 位 QQ 号' };
  const person = store.people?.[id];
  if (!person) return { ok: true, person: null, records: [] };
  const allow = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;
  const records = (person.records ?? [])
    .filter((r) => !allow || allow.has(r.kind))
    .map((r) => ({ ...r, weight: Number(effectiveWeight(r, now, cfg).toFixed(3)) }))
    .sort((a, b) => b.weight - a.weight || (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 20)));
  return { ok: true, person: { personId: person.personId, nicknames: person.nicknames ?? [], scopes: person.scopes ?? [], lastSeenAt: person.lastSeenAt }, records };
}

export function searchRecords(store, keyword, { limit = 20, now = Date.now(), cfg = PROFILE_DEFAULTS } = {}) {
  const needle = String(keyword ?? '').trim().toLowerCase();
  if (!needle) return [];
  const out = [];
  for (const person of Object.values(store.people ?? {})) {
    for (const r of person.records ?? []) {
      if (String(r.text).toLowerCase().includes(needle) || String(r.evidence).toLowerCase().includes(needle)) {
        out.push({ personId: person.personId, nicknames: person.nicknames ?? [], ...r, weight: Number(effectiveWeight(r, now, cfg).toFixed(3)) });
      }
    }
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
}

export function removeRecord(store, personId, recordId) {
  const id = normalizePersonId(personId);
  if (!id || !store.people?.[id]) return { ok: false, error: '没有这个人的档案' };
  const person = store.people[id];
  const before = person.records?.length ?? 0;
  person.records = (person.records ?? []).filter((r) => r.id !== String(recordId ?? ''));
  const removed = before - person.records.length;
  if (removed <= 0) return { ok: false, error: '没有这条记录' };
  return { ok: true, removed };
}

export function removePerson(store, personId) {
  const id = normalizePersonId(personId);
  if (!id || !store.people?.[id]) return { ok: false, error: '没有这个人的档案' };
  const records = store.people[id].records?.length ?? 0;
  delete store.people[id];
  return { ok: true, removedRecords: records };
}

export function clearAll(store) {
  const people = Object.keys(store.people ?? {}).length;
  const groups = Object.keys(store.groups ?? {}).length;
  store.people = {};
  store.groups = {};
  store.settle = {};
  return { ok: true, clearedPeople: people, clearedGroups: groups };
}

function ensureGroup(store, gid) {
  const id = String(gid ?? '').replace(/[^0-9]/g, '').slice(0, 20);
  if (!id) return null;
  if (!store.groups[id]) store.groups[id] = { gid: id, terms: [], updatedAt: Date.now() };
  const group = store.groups[id];
  if (!Array.isArray(group.terms)) group.terms = [];
  return group;
}

export function appendGroupTerm(store, gid, { term, meaning = '', kind = '梗', example = '' }, cfg = PROFILE_DEFAULTS) {
  const group = ensureGroup(store, gid);
  if (!group) return { ok: false, error: '群号无效' };
  const cleanTerm = scrubSensitive(term).slice(0, 30);
  if (!cleanTerm) return { ok: false, error: '术语为空' };
  const existing = group.terms.find((t) => String(t.term) === cleanTerm);
  if (existing) {
    existing.count = (Number(existing.count) || 1) + 1;
    existing.lastSeenAt = Date.now();
    if (meaning && !existing.meaning) existing.meaning = scrubSensitive(meaning).slice(0, 100);
    return { ok: true, created: false, term: existing };
  }
  const item = {
    term: cleanTerm,
    meaning: scrubSensitive(meaning).slice(0, 100),
    kind: ['梗', '称呼', '黑话', '其它'].includes(kind) ? kind : '其它',
    example: scrubSensitive(example).slice(0, 80),
    count: 1,
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now()
  };
  group.terms.push(item);
  const max = Math.max(10, Number(cfg.maxTermsPerGroup) || 120);
  if (group.terms.length > max) group.terms = group.terms.slice(-max);
  group.updatedAt = Date.now();
  return { ok: true, created: true, term: item };
}

export function pruneStore(store, cfg = PROFILE_DEFAULTS, now = Date.now()) {
  const maxPeople = Math.max(10, Number(cfg.maxPeople) || 200);
  let prunedRecords = 0;
  for (const [id, person] of Object.entries(store.people ?? {})) {
    const list = Array.isArray(person.records) ? person.records : [];
    const keep = [];
    for (const r of list) {
      const ageDays = (now - (Number(r.lastSeenAt) || Number(r.createdAt) || now)) / DAY_MS;
      const weight = effectiveWeight(r, now, cfg);
      if (weight < Number(cfg.pruneWeight) && ageDays > Number(cfg.pruneAfterDays)) { prunedRecords += 1; continue; }
      keep.push(r);
    }
    person.records = keep;
    if (keep.length === 0) {
      delete store.people[id];
      continue;
    }
  }
  const ids = Object.keys(store.people ?? {});
  if (ids.length > maxPeople) {
    ids.sort((a, b) => (Number(store.people[a].lastSeenAt) || 0) - (Number(store.people[b].lastSeenAt) || 0));
    for (const id of ids.slice(0, ids.length - maxPeople)) delete store.people[id];
  }
  store.meta = store.meta ?? {};
  store.meta.lastPruneAt = now;
  return { prunedRecords, people: Object.keys(store.people ?? {}).length, groups: Object.keys(store.groups ?? {}).length };
}

// ── settle：判断"对话告一段落" ────────────────────────────────────────────────
export function touchSettle(store, key, { messageCount = 1, now = Date.now() } = {}) {
  if (!key) return null;
  const cur = store.settle[key] ?? { lastMessageAt: 0, settledAt: 0, pendingSince: 0, pendingMessages: 0, lastExtractAt: 0, extractFailures: 0 };
  cur.lastMessageAt = now;
  cur.pendingMessages = (Number(cur.pendingMessages) || 0) + Math.max(1, Number(messageCount) || 1);
  if (!cur.pendingSince) cur.pendingSince = now;
  cur.settledAt = 0;
  store.settle[key] = cur;
  return cur;
}

// 返回需要抽取的会话（满足：>settleIdleMs 没新消息、待抽条数够、冷却已过）。
export function collectSettleCandidates(store, cfg = PROFILE_DEFAULTS, now = Date.now()) {
  const idle = Math.max(30 * 1000, Number(cfg.settleIdleMs) || 6 * 60 * 1000);
  const min = Math.max(1, Number(cfg.sliceMinMessages) || 6);
  const cooldown = Math.max(60 * 1000, Number(cfg.extractCooldownMs) || 30 * 60 * 1000);
  const out = [];
  for (const [key, st] of Object.entries(store.settle ?? {})) {
    if (!st) continue;
    if (now - (Number(st.lastMessageAt) || 0) < idle) continue;
    if ((Number(st.pendingMessages) || 0) < min) continue;
    if (now - (Number(st.lastExtractAt) || 0) < cooldown) continue;
    out.push({ key, pendingMessages: Number(st.pendingMessages) || 0, lastMessageAt: Number(st.lastMessageAt) || 0 });
  }
  return out.sort((a, b) => b.pendingMessages - a.pendingMessages);
}

export function markSettled(store, key, { extracted = 0, ok = true, now = Date.now() } = {}) {
  const cur = store.settle[key];
  if (!cur) return null;
  cur.lastExtractAt = now;
  if (ok) {
    cur.settledAt = now;
    cur.pendingMessages = 0;
    cur.pendingSince = 0;
    cur.extractFailures = 0;
  } else {
    cur.extractFailures = (Number(cur.extractFailures) || 0) + 1;
  }
  cur.lastExtracted = extracted;
  return cur;
}

// ── 提示词 ───────────────────────────────────────────────────────────────────
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 注入提示词：只带高权重的具体事例，且严格限量（避免把上下文撑爆）。
export function formatProfilesForPrompt(store, personIds, { cfg = PROFILE_DEFAULTS, now = Date.now(), maxChars } = {}) {
  const limitChars = Math.max(200, Number(maxChars) || Number(cfg.injectMaxChars) || 900);
  const ids = (Array.isArray(personIds) ? personIds : []).map((v) => String(v)).filter(Boolean).slice(0, Number(cfg.injectMaxPersons) || 3);
  if (!ids.length) return '';
  const blocks = [];
  let used = 0;
  for (const id of ids) {
    const person = store.people?.[id];
    if (!person) continue;
    const records = (person.records ?? [])
      .filter((r) => r.kind !== 'legacy')
      .map((r) => ({ r, w: effectiveWeight(r, now, cfg) }))
      .sort((a, b) => b.w - a.w)
      .slice(0, 6);
    if (!records.length) continue;
    const lines = records.map(({ r }) => {
      const when = r.at ? `${r.at} ` : '';
      return `  - ${kindLabel(r.kind)}：${when}${r.text}`;
    });
    const nick = person.nicknames?.length ? `（${person.nicknames.slice(0, 3).join('、')}）` : '';
    const block = `【档案 · ${id}${nick}】\n${lines.join('\n')}`;
    if (used + block.length > limitChars) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks.join('\n');
}

// 供接口/控制台使用的"整张卡"：不限字符，但每类最多 limit 条，按权重排序。
export function formatProfileCard(store, personId, { limit = 12, now = Date.now(), cfg = PROFILE_DEFAULTS } = {}) {
  const id = normalizePersonId(personId);
  if (!id) return '';
  const person = store.people?.[id];
  if (!person) return '';
  const max = Math.max(1, Math.min(100, Number(limit) || 12));
  const sorted = (person.records ?? [])
    .map((r) => ({ r, w: effectiveWeight(r, now, cfg) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, max);
  if (!sorted.length) return '';
  const nick = person.nicknames?.length ? `（${person.nicknames.slice(0, 3).join('、')}）` : '';
  const lines = sorted.map(({ r }) => {
    const when = r.at ? `${r.at} ` : '';
    return `  - ${kindLabel(r.kind)}：${when}${r.text}`;
  });
  return `【档案 · ${id}${nick}】\n${lines.join('\n')}`;
}

// 聚合统计（控制台/接口用）：谁有档案、各多少条、最后一次出现。
export function listPeople(store, { limit = 50, now = Date.now() } = {}) {
  const max = Math.max(1, Math.min(500, Number(limit) || 50));
  return Object.values(store.people ?? {})
    .map((p) => ({
      personId: p.personId,
      nicknames: (p.nicknames ?? []).slice(0, 3),
      scopes: (p.scopes ?? []).slice(0, 6),
      records: Array.isArray(p.records) ? p.records.length : 0,
      lastSeenAt: Number(p.lastSeenAt) || 0,
      lastSeenDays: p.lastSeenAt ? Math.floor((now - Number(p.lastSeenAt)) / DAY_MS) : null
    }))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, max);
}

export function kindLabel(kind) {  return ({
    event: '事件',
    care: '在意',
    avoid: '雷点',
    topic: '话题',
    style: '风格',
    nickname: '称呼',
    note: '事例',
    legacy: '旧印象'
  })[kind] ?? '事例';
}

export function buildProfileExtractionPrompt(messages = [], ctx = {}) {
  const scope = ctx.scope ?? '会话';
  const selfQq = ctx.selfQq ?? '';
  const lines = messages.map((m, i) => `${i + 1}. [${m.time ? fmtDate(m.time) : ''}] ${m.sender || '未知'}${m.qq ? `(${m.qq})` : ''}: ${String(m.text ?? '').slice(0, 200)}`);
  return [
    '你是聊天记录整理员。下面是 QQ ' + scope + ' 的一段已经结束的对话。',
    '请只提取**具体事例**，写成以后能查证的样子；不要写"人很好""挺可爱"这类空泛评价。',
    '',
    '输出要求：只输出 JSON 数组，不要任何解释、不要 markdown 代码块。每个元素：',
    '{"qq":"数字QQ号","kind":"event|care|avoid|topic|style|nickname","text":"具体事例，6-60字，写谁在哪天做了什么/说了什么原话","at":"2026-10-19（事件日期，不确定就留空字符串）","evidence":"最能支撑的原话节选，≤40字"}',
    '',
    '规则：',
    `1. 只记录 qq 号真实出现在上面的发言者${selfQq ? `（机器人自己是 ${selfQq}，不要记录它）` : ''}；`,
    '2. 手机号、身份证、银行卡、住址、密码、验证码、邮箱一律不要写进 text（会被过滤，但别让它污染记录）；',
    '3. 同一个人的琐碎寒暄不要记；只记"以后还用得上"的；',
    '4. 称呼（nickname）指别人怎么叫他、或他怎么自称；',
    '5. 最多 8 条，宁缺毋滥；实在没有值得记的就输出 []；',
    '6. at 只在 text 里出现了明确日期/节日/具体日子时才填。',
    '',
    '对话内容：',
    ...lines
  ].join('\n');
}

export function parseProfileJson(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const qq = normalizePersonId(item.qq ?? item.personId);
    if (!qq) continue;
    out.push({
      personId: qq,
      kind: PROFILE_RECORD_KINDS.includes(String(item.kind)) ? String(item.kind) : 'note',
      text: String(item.text ?? '').slice(0, TEXT_MAX),
      at: normalizeAt(item.at),
      evidence: String(item.evidence ?? '').slice(0, EVIDENCE_MAX)
    });
    if (out.length >= 30) break;
  }
  return out;
}

// 迁移旧的 memberImpressions（traits 数组）→ legacy 记录。旧数据保留在 social-v2.json 里不动。
export function migrateImpressions(store, impressions) {
  let migrated = 0;
  if (!impressions || typeof impressions !== 'object') return migrated;
  for (const [name, im] of Object.entries(impressions)) {
    const personId = normalizePersonId(String(name).replace(/[^0-9]/g, ''));
    if (!personId) continue;
    for (const trait of Array.isArray(im?.traits) ? im.traits.slice(0, 10) : []) {
      const text = scrubSensitive(trait);
      if (!text) continue;
      const person = ensurePerson(store, personId, 'legacy-impression');
      const dedupe = normalizeDedupeKey(text);
      const hasSame = person.records.some((r) => normalizeDedupeKey(String(r.text).replace(/^旧印象：/, '')) === dedupe);
      if (hasSame) continue;
      person.records.push({
        id: createId('rec'),
        kind: 'legacy',
        text: `旧印象：${text}`.slice(0, TEXT_MAX),
        at: '',
        evidence: '',
        weightBase: KIND_WEIGHT.legacy,
        seenCount: Math.max(1, Number(im?.interactionCount) || 1),
        createdAt: Date.now(),
        lastSeenAt: Date.now()
      });
      migrated += 1;
    }
  }
  return migrated;
}

export function storeStats(store) {
  const people = Object.values(store.people ?? {});
  const records = people.reduce((n, p) => n + (Array.isArray(p.records) ? p.records.length : 0), 0);
  const settled = Object.values(store.settle ?? {}).filter((s) => s && s.settledAt).length;
  const pending = Object.values(store.settle ?? {}).filter((s) => s && !s.settledAt && Number(s.pendingMessages) > 0).length;
  return {
    people: people.length,
    records,
    groups: Object.keys(store.groups ?? {}).length,
    terms: Object.values(store.groups ?? {}).reduce((n, g) => n + (Array.isArray(g.terms) ? g.terms.length : 0), 0),
    settled,
    pending,
    updatedAt: store.meta?.updatedAt ?? ''
  };
}
