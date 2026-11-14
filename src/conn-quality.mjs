// 连接质量观测：断线 / 重连事件、统计、日志回填、告警文案与 HTTP handler。
//
// 为什么要这个模块：SnowLuma 的 OneBot WebSocket 每 3–8 分钟静默断一次（code=1006），
// SDK 自己会重连，控制台此前完全看不出来 —— 只有翻 state/bridge.log 才知道。
// 这里把「断线 / 重连」变成可查询的事件序列：桥接侧在事件回调里各调一行，
// 控制台通过 /api/conn-quality 读统计。
//
// 设计约束：
//   · 纯逻辑、零依赖、不 import bridge.js（bridge.js 由主智能体接线，这里只被它 import）；
//   · 只读写 state/conn-quality.json，任何读写盘异常都吞掉，绝不抛给调用方；
//   · 事件环形缓冲：保留 7 天 + 最多 5000 条；文件损坏自动隔离并重建。
//
// 事件模型（内部与落盘一致）：
//   { source: 'snowluma'|'dsh', type: 'down'|'up', at: <epoch ms 落盘为 ISO>, code?: number }
// 一次「中断」= 同一来源的一次 down → 下一次 up；down 之后没有 up 就是进行中（ongoing）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCES = Object.freeze(['snowluma', 'dsh']);
export const SOURCE_LABEL = Object.freeze({ snowluma: 'SnowLuma', dsh: 'DSH' });
/** 默认告警阈值：1 小时内 ≥5 次断线，或单次中断 >10 分钟。 */
export const DEFAULT_ALERT = Object.freeze({ count: 5, windowMinutes: 60, outageMinutes: 10 });

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * DAY_MS;
const MAX_EVENTS = 5000;
/** 回填去重窗口：日志只有秒级精度，实时事件带毫秒，2 秒内同来源同类型视为同一条。 */
const DEDUPE_MS = 2000;

let overrides = { stateFile: null, retentionMs: RETENTION_MS, maxEvents: MAX_EVENTS };
/** @type {{ file: string, events: Array<object> } | null} */
let cache = null;

/**
 * 覆盖默认落盘位置 / 保留策略。供测试注入临时目录，生产代码不需要调用。
 * 调用后清空内存缓存，下一次读写以新配置为准。
 */
export function configureConnQuality(options = {}) {
  overrides = {
    stateFile: options.stateFile ? path.resolve(String(options.stateFile)) : null,
    retentionMs: Number.isFinite(options.retentionMs) && options.retentionMs > 0 ? options.retentionMs : RETENTION_MS,
    maxEvents: Number.isFinite(options.maxEvents) && options.maxEvents > 0 ? Math.trunc(options.maxEvents) : MAX_EVENTS,
  };
  cache = null;
}

export function stateFilePath() {
  return overrides.stateFile || fileURLToPath(new URL('../state/conn-quality.json', import.meta.url));
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (value instanceof Date) {
    const t = value.getTime();
    if (Number.isFinite(t)) return t;
  }
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function isValidSource(source) {
  return SOURCES.includes(source);
}

function eventKey(event) {
  return `${event.source}|${event.type}|${event.at}`;
}

function normalizeCode(code) {
  const n = Number(code);
  return Number.isFinite(n) ? n : null;
}

/** 落盘格式：at 写成 ISO，方便运维直接 cat 文件；读回时转 epoch ms。 */
function eventToFile(event) {
  return {
    source: event.source,
    type: event.type,
    at: iso(event.at),
    ...(Number.isFinite(event.code) ? { code: event.code } : {}),
    ...(event.inferred === true ? { inferred: true } : {}),
  };
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = String(raw.source || '');
  const type = String(raw.type || '');
  if (!isValidSource(source) || (type !== 'down' && type !== 'up')) return null;
  const at = toMs(raw.at);
  const code = normalizeCode(raw.code);
  return {
    source,
    type,
    at,
    ...(code !== null ? { code } : {}),
    ...(raw.inferred === true ? { inferred: true } : {}),
  };
}

function normalizeEvents(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    const event = normalizeEvent(raw);
    if (event) out.push(event);
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/** 损坏文件改名隔离（不删除，留证据）；失败也无声。 */
function quarantine(file) {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {}
}

function readEventsFromDisk(file) {
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  if (!raw || !raw.trim()) return [];
  let doc = null;
  try {
    doc = JSON.parse(raw);
  } catch {
    quarantine(file);
    return [];
  }
  if (!Array.isArray(doc?.events)) {
    quarantine(file);
    return [];
  }
  return normalizeEvents(doc.events);
}

function loadEvents() {
  const file = stateFilePath();
  if (cache && cache.file === file) return cache.events;
  cache = { file, events: readEventsFromDisk(file) };
  return cache.events;
}

/**
 * 持久化：先按保留期 / 环形上限裁剪，再原子写（tmp + rename）。
 * 失败只回退内存状态，不抛错。
 */
function persist(events) {
  const file = stateFilePath();
  const cutoff = Date.now() - overrides.retentionMs;
  let kept = events.filter((event) => event.at >= cutoff);
  if (kept.length > overrides.maxEvents) kept = kept.slice(kept.length - overrides.maxEvents);
  const doc = {
    version: 1,
    updatedAt: iso(Date.now()),
    retentionDays: Math.round(overrides.retentionMs / DAY_MS),
    events: kept.map(eventToFile),
  };
  cache = { file, events: kept };
  let tmp = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    if (tmp) {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
  return kept;
}

function pushEvent(event) {
  const events = loadEvents().slice();
  // 同一来源同一类型 2 秒内的重复（重连抖动 / 回填与实时撞车）只记一条。
  const duplicate = events.some((other) => other.source === event.source
    && other.type === event.type
    && Math.abs(other.at - event.at) <= DEDUPE_MS);
  if (!duplicate) {
    events.push(event);
    events.sort((a, b) => a.at - b.at);
    persist(events);
  }
  return event;
}

/**
 * 记录一次断线。无效 source 或写盘异常都静默忽略，返回 null。
 * @param {{ source: 'snowluma'|'dsh', code?: number|string, at?: number|string|Date }} input
 */
export function recordDisconnect({ source, code, at } = {}) {
  try {
    if (!isValidSource(source)) return null;
    const event = { source, type: 'down', at: toMs(at), ...(normalizeCode(code) !== null ? { code: normalizeCode(code) } : {}) };
    pushEvent(event);
    return { source, type: 'down', at: iso(event.at), ...(event.code !== undefined ? { code: event.code } : {}) };
  } catch {
    return null;
  }
}

/**
 * 记录一次重连成功（SnowLuma `bot.on('open')` / DSH 检查恢复）。
 * 没有对应 down 的孤立 up 不会凭空造出中断，只在统计里被忽略。
 * @param {{ source: 'snowluma'|'dsh', at?: number|string|Date, inferred?: boolean }} input
 */
export function recordReconnect({ source, at, inferred } = {}) {
  try {
    if (!isValidSource(source)) return null;
    const event = { source, type: 'up', at: toMs(at), ...(inferred === true ? { inferred: true } : {}) };
    pushEvent(event);
    return { source, type: 'up', at: iso(event.at), ...(inferred === true ? { inferred: true } : {}) };
  } catch {
    return null;
  }
}

/**
 * 把 down/up 事件序列折叠成中断列表（含进行中与「结束时间不可知」的回填中断）。
 * 这里按来源独立配对：SnowLuma 断线不会吃掉 DSH 的 down。
 */
function buildOutages(events, nowMs) {
  const outages = [];
  const open = new Map();
  for (const event of events) {
    if (event.type === 'down') {
      if (!open.has(event.source)) open.set(event.source, { at: event.at, code: event.code });
    } else {
      const start = open.get(event.source);
      if (!start) continue; // 启动时的首次连接：没有对应中断
      open.delete(event.source);
      outages.push({
        source: event.source,
        at: start.at,
        endAt: event.at,
        downMs: Math.max(0, event.at - start.at),
        ...(start.code !== undefined ? { code: start.code } : {}),
        ...(event.inferred === true ? { inferred: true } : {}),
      });
    }
  }
  for (const [source, start] of open) {
    outages.push({
      source,
      at: start.at,
      endAt: null,
      downMs: Math.max(0, nowMs - start.at),
      ...(start.code !== undefined ? { code: start.code } : {}),
      ongoing: true,
    });
  }
  outages.sort((a, b) => a.at - b.at);
  return outages;
}

function summarize(outages) {
  const completed = outages.filter((o) => o.ongoing !== true && o.inferred !== true);
  const total = completed.reduce((sum, o) => sum + o.downMs, 0);
  return {
    disconnects: outages.length,
    reconnects: completed.length,
    longestOutageMs: outages.reduce((max, o) => Math.max(max, o.downMs), 0),
    avgReconnectMs: completed.length ? Math.round(total / completed.length) : 0,
    lastOutageAt: outages.length ? iso(outages[outages.length - 1].at) : null,
    lastCode: [...outages].reverse().find((o) => Number.isFinite(o.code))?.code ?? null,
  };
}

function clampHours(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(24 * RETENTION_DAYS, Math.max(1, Math.round(n)));
}

/**
 * 统计窗口内的连接质量。
 * 口径：以「中断」为单位（down→up 为一次），series 每项一次中断；
 * 平均重连耗时只算已闭合、且结束时间可观测的中断（ongoing / inferred 不计入）。
 * @param {{ hours?: number, now?: number|string|Date }} options
 */
export function getStats({ hours = 24, now } = {}) {
  const nowMs = toMs(now);
  const windowHours = clampHours(hours);
  const windowStart = nowMs - windowHours * HOUR_MS;
  const events = loadEvents();
  const outages = buildOutages(events, nowMs);
  // 进行中的中断即使开始于窗口之前也要上报：它是「此刻还在断」的事实。
  const inWindow = outages.filter((o) => o.at >= windowStart || o.ongoing === true);
  const overall = summarize(inWindow);
  const bySource = {};
  for (const source of SOURCES) {
    bySource[source] = summarize(inWindow.filter((o) => o.source === source));
  }
  // 进行中取「最近开始的那条」，而不是窗口内最后一条：后者可能是一次已恢复的中断。
  const live = [...inWindow].reverse().find((o) => o.ongoing === true) ?? null;
  return {
    hours: windowHours,
    generatedAt: iso(nowMs),
    disconnects: overall.disconnects,
    reconnects: overall.reconnects,
    longestOutageMs: overall.longestOutageMs,
    avgReconnectMs: overall.avgReconnectMs,
    lastOutageAt: overall.lastOutageAt,
    ongoing: live
      ? { source: live.source, since: iso(live.at), downMs: live.downMs }
      : null,
    bySource,
    series: inWindow.map((o) => ({
      at: iso(o.at),
      downMs: o.downMs,
      source: o.source,
      ...(o.ongoing === true ? { ongoing: true } : {}),
      ...(o.inferred === true ? { inferred: true } : {}),
    })),
  };
}

function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function localTimeOfDay(hours, minutes, seconds) {
  return hours * HOUR_MS + minutes * 60_000 + seconds * 1000;
}

/**
 * 从 bridge.log 文本回填历史事件。
 *
 * 日志每行是 `HH:MM:SS [bridge] ...`（本地时间、无日期），所以这里从最后一行开始
 * 以 now（默认 Date.now()；回填时应传日志文件 mtime）为锚点倒推日期，遇到时间回绕
 * （前一天 → 后一天）就减一天。返回事件里 at 是 epoch ms。
 *
 * 识别：
 *   · `连接断开（code=1006）`（可带 SnowLuma 前缀） → snowluma/down
 *   · `SnowLuma 已连接：...`                        → snowluma/up
 *   · `⚠️ DSH 不可用（重启中？）...`                 → dsh/down
 *   · `DSH 已就绪（模式: ...）`                      → dsh/up
 *   · `连接 DSH 事件流…`（每次重试都打）             → dsh/retry（只作解析产物，不入库）
 * @param {string} text
 * @param {{ now?: number|string|Date }} options
 */
export function parseBridgeLog(text, { now } = {}) {
  const nowMs = toMs(now);
  const raw = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*(\d{1,2}):(\d{2}):(\d{2})\s+(?:\[bridge\]\s*)?(.*)$/.exec(line);
    if (!match) continue;
    const body = match[4];
    let event = null;
    const disconnect = /连接断开\s*[（(]\s*code\s*=\s*(\d+)\s*[)）]/.exec(body);
    if (disconnect) {
      event = { source: 'snowluma', type: 'down', code: Number(disconnect[1]) };
    } else if (/SnowLuma\s*已连接/.test(body)) {
      event = { source: 'snowluma', type: 'up' };
    } else if (/DSH\s*不可用\s*[（(]重启中/.test(body)) {
      event = { source: 'dsh', type: 'down' };
    } else if (/DSH\s*已就绪/.test(body)) {
      event = { source: 'dsh', type: 'up' };
    } else if (/连接\s*DSH\s*事件流/.test(body)) {
      event = { source: 'dsh', type: 'retry' };
    }
    if (!event) continue;
    raw.push({
      ...event,
      hours: Number(match[1]),
      minutes: Number(match[2]),
      seconds: Number(match[3]),
    });
  }
  if (!raw.length) return [];
  let dayStart = startOfLocalDay(nowMs);
  const last = raw[raw.length - 1];
  if (dayStart + localTimeOfDay(last.hours, last.minutes, last.seconds) > nowMs + 2000) dayStart -= DAY_MS;
  let nextAt = dayStart + localTimeOfDay(last.hours, last.minutes, last.seconds);
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const item = raw[i];
    let at = dayStart + localTimeOfDay(item.hours, item.minutes, item.seconds);
    if (i !== raw.length - 1 && at > nextAt) {
      dayStart -= DAY_MS;
      at = dayStart + localTimeOfDay(item.hours, item.minutes, item.seconds);
    }
    item.at = at;
    nextAt = at;
  }
  return raw.map(({ hours, minutes, seconds, ...event }) => event);
}

/**
 * 把解析结果合并进存储（只收 down/up，retry 丢弃）。
 * 回填是幂等的：同来源同类型 2 秒内视为同一条，重复启动不会翻倍。
 * @returns {number} 新增条数
 */
export function ingestEvents(events, options = {}) {
  try {
    const list = Array.isArray(events) ? events : [];
    const stored = loadEvents().slice();
    let added = 0;
    for (const raw of list) {
      if (!raw || !isValidSource(raw.source)) continue;
      if (raw.type !== 'down' && raw.type !== 'up') continue;
      const at = toMs(raw.at);
      const duplicate = stored.some((other) => other.source === raw.source
        && other.type === raw.type
        && Math.abs(other.at - at) <= DEDUPE_MS);
      if (duplicate) continue;
      const event = {
        source: raw.source,
        type: raw.type,
        at,
        ...(normalizeCode(raw.code) !== null ? { code: normalizeCode(raw.code) } : {}),
      };
      stored.push(event);
      added += 1;
    }
    if (added > 0) {
      stored.sort((a, b) => a.at - b.at);
      persist(stored);
    }
    return added;
  } catch {
    return 0;
  }
}

/**
 * 首次启动补历史：读 state/bridge.log（可用 logFile 覆盖），以文件 mtime 为时间锚点。
 * 同步、永不抛错；日志不存在返回 0。
 */
export function backfillFromLog({ logFile, now } = {}) {
  try {
    const file = logFile || fileURLToPath(new URL('../state/bridge.log', import.meta.url));
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return 0;
    }
    let anchor = now;
    if (anchor === undefined) {
      try { anchor = fs.statSync(file).mtimeMs; } catch { anchor = Date.now(); }
    }
    return ingestEvents(parseBridgeLog(text, { now: anchor }));
  } catch {
    return 0;
  }
}

function alertConfig(cfg = {}) {
  const count = Number(cfg.count ?? cfg.disconnectCount ?? cfg.countThreshold);
  const windowMinutes = Number(cfg.windowMinutes ?? cfg.window);
  const outageMinutes = Number(cfg.outageMinutes ?? cfg.outage);
  return {
    count: Number.isFinite(count) && count > 0 ? count : DEFAULT_ALERT.count,
    windowMinutes: Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes : DEFAULT_ALERT.windowMinutes,
    outageMinutes: Number.isFinite(outageMinutes) && outageMinutes > 0 ? outageMinutes : DEFAULT_ALERT.outageMinutes,
  };
}

function statsNow(stats) {
  const parsed = Date.parse(String(stats?.generatedAt ?? ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function recentOutages(stats, windowMinutes) {
  const series = Array.isArray(stats?.series) ? stats.series : [];
  const now = statsNow(stats);
  const from = now - windowMinutes * 60_000;
  return series.filter((item) => {
    const at = Date.parse(String(item?.at ?? ''));
    return Number.isFinite(at) && at >= from && at <= now;
  });
}

export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0 秒';
  if (n < 60_000) return `${Math.max(1, Math.round(n / 1000))} 秒`;
  if (n < HOUR_MS) return `${(n / 60_000).toFixed(1)} 分钟`;
  return `${(n / HOUR_MS).toFixed(1)} 小时`;
}

/**
 * 是否应该告警：窗口内断线次数 ≥ count，或单次中断 > outageMinutes。
 * @returns {boolean}
 */
export function shouldAlert(stats, cfg = {}) {
  const { count, windowMinutes, outageMinutes } = alertConfig(cfg);
  if (recentOutages(stats, windowMinutes).length >= count) return true;
  return Number(stats?.longestOutageMs ?? 0) > outageMinutes * 60_000;
}

/**
 * 生成一条中文告警文案；不需要告警时返回空串（调用方据此决定是否发送）。
 */
export function buildAlertText(stats, cfg = {}) {
  const { count, windowMinutes, outageMinutes } = alertConfig(cfg);
  const recent = recentOutages(stats, windowMinutes);
  const longest = Number(stats?.longestOutageMs ?? 0);
  const reasons = [];
  if (recent.length >= count) {
    reasons.push(`过去 ${windowMinutes} 分钟断线 ${recent.length} 次（阈值 ${count} 次）`);
  }
  if (longest > outageMinutes * 60_000) {
    reasons.push(`单次最长中断 ${formatDuration(longest)}（阈值 ${outageMinutes} 分钟）`);
  }
  if (!reasons.length) return '';
  const bySource = stats?.bySource ?? {};
  const snowlumaCount = Number(bySource.snowluma?.disconnects ?? 0);
  const dshCount = Number(bySource.dsh?.disconnects ?? 0);
  const lastOutage = stats?.lastOutageAt ? new Date(String(stats.lastOutageAt)) : null;
  const lastText = lastOutage && Number.isFinite(lastOutage.getTime())
    ? `最近一次中断 ${lastOutage.toLocaleString('zh-CN', { hour12: false })}`
    : '';
  const ongoing = stats?.ongoing
    ? `当前仍在中断中（${SOURCE_LABEL[stats.ongoing.source] ?? stats.ongoing.source}，已 ${formatDuration(stats.ongoing.downMs)}）`
    : '';
  return [
    '⚠️ 连接质量告警：',
    reasons.join('；'),
    `。来源拆分：SnowLuma ${snowlumaCount} 次 / DSH ${dshCount} 次`,
    lastText ? `，${lastText}` : '',
    ongoing ? `；${ongoing}` : '',
    '。',
  ].join('');
}

/**
 * 固定形状的只读 HTTP handler：
 *   成功 200 { ok: true, stats }
 *   失败 500 { ok: false, error }
 *   非 GET 405 { ok: false, error }
 * 该 handler 自己写响应头，调用方只需在路由分发处 `return handler(req, res)`。
 * @param {{ getStats?: (options: { hours: number }) => object }} options
 */
export function createConnQualityHandler({ getStats: getStatsFn = getStats } = {}) {
  return function connQualityHandler(req, res) {
    const send = (status, payload) => {
      try {
        if (res.writableEnded) return;
        if (!res.headersSent) {
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
        }
        res.end(JSON.stringify(payload));
      } catch {}
    };
    try {
      if ((req?.method || 'GET') !== 'GET') {
        send(405, { ok: false, error: 'method not allowed' });
        return;
      }
      let hours = 24;
      try {
        const url = new URL(req?.url || '/', 'http://127.0.0.1');
        const value = Number(url.searchParams.get('hours'));
        if (Number.isFinite(value) && value > 0) hours = Math.min(RETENTION_DAYS * 24, Math.max(1, Math.round(value)));
      } catch {}
      const stats = getStatsFn({ hours });
      send(200, { ok: true, stats });
    } catch (error) {
      send(500, { ok: false, error: String(error?.message ?? error ?? 'unknown error') });
    }
  };
}
