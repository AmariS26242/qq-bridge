// 每日简报的**纯逻辑**：配置容错 + 一条 ≤6 行纯文本的渲染。
//
// 为什么单独一个模块：计划的验收要求「停掉 bridge 后简报仍能说话」，所以渲染必须能
// 脱离 bridge 进程单独跑、单独测。这里刻意不碰 fs/net/child_process —— 任何 I/O 都在
// scripts/daily-brief.mjs 里，方便离线单测（scripts/test-daily-brief.mjs）。
//
// 消息形态硬约束（见 项目计划/06-每日简报.md §3.1）：
//   纯文本、≤ 6 行、≤ maxChars（默认 480）、不含 ** / # / ```（QQ 会把它们显示成乱码）。

import { renderBackupBriefLine } from './backup.mjs';
import { renderDoctorBriefLine } from './doctor.mjs';
import { renderCleanBriefLine } from './clean-state.mjs';
import { normalizeCostGuardConfig, renderCostBriefLine } from './cost-guard.mjs';
import { renderHealthBriefSuffix } from './health.mjs';

export const DAILY_BRIEF_DEFAULTS = Object.freeze({
  enabled: true,
  at: '08:00',
  key: 'private:100000001',
  windowHours: 24,
  maxChars: 560,
  maxLines: 9, // 问候 / 天气 / 服务 / 提醒 / 活动 / 备份 / 自检 / token / 恢复
  weather: Object.freeze({ enabled: true, label: '', latitude: null, longitude: null }),
});

/** WMO weather code → 中文（Open-Meteo 用的就是 WMO 4677 码表）。 */
const WMO_TEXT = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '有雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '小阵雨', 81: '阵雨', 82: '强阵雨',
  85: '小阵雪', 86: '大阵雪',
  95: '雷阵雨', 96: '雷阵雨伴小冰雹', 99: '雷阵雨伴大冰雹',
};

/** 「今天」的边界与展示都用本地时间：UTC 会在跨零点时把日期算错一天。 */
const AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const SERVICE_LABELS = {
  qqbridge: 'QQ桥',
  qqbot: 'bot',
  phoneBridge: '手机桥',
  campusNet: '校园网',
};

const DEFAULT_PORTS = { qqbridge: 3100, phoneBridge: 8899 };

function pad2(n) {
  return String(n).padStart(2, '0');
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 天气配置容错：坐标必须在合法范围，否则当没配（宁可退回 IP 定位也不发疯）。 */
export function normalizeWeatherConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DAILY_BRIEF_DEFAULTS.weather };
  if (src.enabled !== undefined) {
    const v = src.enabled;
    out.enabled = !(v === false || v === 0 || /^(false|0|no|off)$/i.test(String(v).trim()));
  }
  const label = typeof src.label === 'string' ? src.label.replace(/\s+/g, ' ').trim() : '';
  if (label) out.label = label.slice(0, 12);
  const lat = Number(src.latitude);
  const lon = Number(src.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    out.latitude = lat;
    out.longitude = lon;
  }
  return out;
}

/** 配置容错：任何坏值都回落默认，绝不抛错（配置文件是手改的，写错很常见）。 */
export function normalizeDailyBriefConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DAILY_BRIEF_DEFAULTS };

  if (src.enabled !== undefined) {
    const v = src.enabled;
    out.enabled = !(v === false || v === 0 || /^(false|0|no|off)$/i.test(String(v).trim()));
  }

  const at = typeof src.at === 'string' ? src.at.trim() : '';
  if (AT_RE.test(at)) out.at = at;

  const key = typeof src.key === 'string' ? src.key.trim() : '';
  if (key) out.key = key;

  const hours = Number(src.windowHours);
  if (Number.isFinite(hours) && hours >= 1 && hours <= 168) out.windowHours = Math.round(hours);

  const maxChars = Number(src.maxChars);
  if (Number.isFinite(maxChars) && maxChars >= 120 && maxChars <= 2000) out.maxChars = Math.round(maxChars);

  const maxLines = Number(src.maxLines);
  if (Number.isFinite(maxLines) && maxLines >= 2 && maxLines <= 10) out.maxLines = Math.round(maxLines);

  out.weather = normalizeWeatherConfig(src.weather);
  // 成本守门的阈值与天气一样走「配置容错」：写错了回落默认，不让简报因为一个数字炸掉。
  out.costGuard = normalizeCostGuardConfig(src.costGuard);

  return out;
}

/** 紧凑数字：75.7M / 35.1k / 812。token 是千万级，完整数字会把一行撑爆。 */
export function compactNumber(n) {
  const v = num(n);
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

function clockOf(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return null;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** WMO 码 → 中文；未知码返回 null（宁可少说一个词，也不要出现「未知(1234)」）。 */
export function weatherCodeText(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return null;
  return WMO_TEXT[n] ?? null;
}

/** 18.8 → "18.8"，19 → "19"：QQ 里「19.0°C」很碍眼。 */
function tempText(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return String(Math.round(n * 10) / 10);
}

/**
 * 天气行：`🌤 天气：洛阳 阴 · 12.9~19°C · 现在 18.8°C · 降水 2%`
 *
 * 任何一段数据缺失就只省略那一段：没有今日最低/最高就写「现在」，一个数都没有
 * 就整行返回 null（宁可不占一行，也不要发「天气：洛阳」这种废话）。
 */
export function formatWeather(weather) {
  if (!weather || typeof weather !== 'object') return null;
  const label = String(weather.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 12);
  const cond = weatherCodeText(weather.code);
  const now = tempText(weather.temp);
  const lo = tempText(weather.min);
  const hi = tempText(weather.max);
  const range = lo !== null && hi !== null ? `${lo}~${hi}°C` : null;
  const precip = Number(weather.precip);

  const bits = [];
  if (cond) bits.push(cond);
  if (range) bits.push(range);
  if (now !== null) bits.push(`现在 ${now}°C`);
  if (Number.isFinite(precip) && precip >= 0) bits.push(`降水 ${Math.round(precip)}%`);
  if (!bits.length) return null;
  return `🌤 天气：${label ? `${label} ` : ''}${bits.join(' · ')}`;
}

/**
 * 逐项判定四个常驻服务的红绿。
 *
 * 关键取舍：**只看 alive**。校园网的 `task.ok === false` 在「node 被 DSH 以低完整性
 * 拉起」时必然出现（schtasks 报「系统找不到指定的路径」），但日志 mtime 明明还在更新
 * —— 拿 task.ok 当红项会让简报天天误报。alive 为 false 才是真挂；alive 为 null/缺失
 * 表示没探到，不算红（与仪表盘「—」的口径一致）。
 */
export function serviceState(snapshot) {
  const services = snapshot && typeof snapshot.services === 'object' && snapshot.services ? snapshot.services : {};
  const states = [];
  for (const key of Object.keys(SERVICE_LABELS)) {
    const svc = services[key];
    const label = SERVICE_LABELS[key];
    const alive = svc && typeof svc === 'object' ? svc.alive : undefined;
    if (alive === true) {
      states.push({ key, label, state: 'ok', note: null });
      continue;
    }
    if (alive !== false) {
      states.push({ key, label, state: 'unknown', note: null });
      continue;
    }
    let note = null;
    if (key === 'qqbot') {
      note = '离线';
    } else if (key === 'campusNet') {
      const task = svc.task && typeof svc.task === 'object' ? svc.task : null;
      const taskResult = task && task.ok ? String(task.lastResult ?? '').trim() : '';
      const age = Number(svc.logAgeMs);
      if (task && task.ok && taskResult && taskResult !== '0' && taskResult !== '0x0') note = `任务结果 ${taskResult}`;
      else if (Number.isFinite(age)) note = `日志 ${Math.max(1, Math.round(age / 60000))} 分钟没更新`;
      else note = '日志缺失';
    } else {
      const port = Number(svc.port) || DEFAULT_PORTS[key];
      note = `${port} 无响应`;
    }
    states.push({ key, label, state: 'red', note });
  }
  return {
    states,
    red: states.filter((s) => s.state === 'red'),
    unknown: states.filter((s) => s.state === 'unknown'),
  };
}

/**
 * 服务行。health 是最近 windowHours 的健康时序汇总（src/health.mjs），有采样时在行尾补
 * 「24h 抖动 N 次」—— 「此刻正常」和「这一整天没掉过」是两个不同的问题，后者只能靠时序回答。
 * 没采样就不补，服务行维持原样（不写「无抖动」冒充有数据）。
 */
function servicesLine(snapshot, health) {
  const { red, unknown } = serviceState(snapshot);
  const suffix = renderHealthBriefSuffix(health);
  if (!red.length) {
    const base = unknown.length ? '✅ 服务：全部正常（部分项未探到）' : '✅ 服务：全部正常';
    return `${base}${suffix || ''}`;
  }
  const parts = red.map((s) => (s.key === 'qqbot' ? `bot ${s.note}` : `${s.label} 挂了${s.note ? `（${s.note}）` : ''}`));
  return `❌ 服务：${parts.join(' · ')}${suffix || ''}`;
}

function remindersLine(snapshot) {
  const rem = snapshot && snapshot.today && snapshot.today.reminders;
  if (!rem || typeof rem !== 'object') return '📅 提醒：今天没有';
  const items = Array.isArray(rem.items) ? rem.items.filter((i) => i && clockOf(i.at)) : [];
  const pending = Number.isFinite(Number(rem.pending)) ? Number(rem.pending) : items.length;
  if (rem.available === false || pending <= 0) return '📅 提醒：今天没有';
  const head = items.slice(0, 3).map((i) => {
    const text = String(i.text ?? '').replace(/\s+/g, ' ').trim();
    return `${clockOf(i.at)}${text ? ` ${text}` : ''}`;
  });
  const shown = head.join(' · ');
  const rest = pending - head.length;
  const suffix = rest > 0 ? `${shown ? ' · ' : ''}等 ${rest} 条` : '';
  return `📅 提醒：今天 ${pending} 条${shown || suffix ? `（${shown}${suffix}）` : ''}`;
}

function pickStat(primary, fallback) {
  if (primary !== undefined && primary !== null && Number.isFinite(Number(primary))) return Number(primary);
  if (fallback !== undefined && fallback !== null && Number.isFinite(Number(fallback))) return Number(fallback);
  return 0;
}

function activityLine(snapshot, toolStats) {
  const qq = (snapshot && snapshot.today && snapshot.today.qq) || {};
  const st = toolStats && typeof toolStats === 'object' ? toolStats : {};
  // 有 tool-calls.jsonl 的精确计数就用它，否则退回 qq-activity.log 的粗计。
  const messages = pickStat(st.messages, qq.sentOk ?? qq.sent);
  const voices = pickStat(st.voices, qq.voices);
  const stickers = pickStat(st.stickers, qq.stickers);
  const failed = pickStat(st.failed, 0);
  if (!messages && !voices && !stickers && !failed) return '💬 近 24h：没有动静';
  const parts = [`消息 ${messages} 条`];
  if (voices || messages) parts.push(`语音 ${voices}`);
  if (stickers || messages) parts.push(`表情 ${stickers}`);
  if (failed > 0) parts.push(`失败 ${failed}`);
  return `💬 近 24h：${parts.join(' · ')}`;
}

function tokenLine(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const cacheHit = num(usage.cacheHit);
  const cacheMiss = num(usage.cacheMiss);
  const output = num(usage.output);
  const input = Number.isFinite(Number(usage.input)) ? Number(usage.input) : cacheHit + cacheMiss;
  if (!input && !output) return null;
  const rate = input > 0 ? cacheHit / input : null;
  const cache = rate === null ? '' : `（缓存 ${(rate * 100).toFixed(1)}%）`;
  return `🔤 token：输入 ${compactNumber(input)}${cache} · 输出 ${compactNumber(output)}`;
}

function recoveryLine(prev, red) {
  const prevRed = prev && Array.isArray(prev.red) ? prev.red.filter((k) => typeof k === 'string' && k) : [];
  if (!prevRed.length || red.length) return null;
  const names = prevRed.map((k) => SERVICE_LABELS[k] || k);
  return `⚠️ 昨日红项已恢复：${names.join('、')}`;
}

/**
 * 备份行。格式与状态判定都在 src/backup.mjs（那边有单测钉住「今天 03:10 成功（N 份 / X）」），
 * 这里只做「有就加一行」的接线，免得两处各写一套格式慢慢分叉。
 */
function backupLine(backup, when) {
  if (!backup) return null;
  return renderBackupBriefLine(backup, { now: when });
}

/**
 * 自检行：`🩺 自检：8/8 通过`；有红项时点名前两个（简报只留一行，细节在 state/doctor-report.json）。
 * 格式与判定都在 src/doctor.mjs（那边有单测钉住），这里只做接线，免得两处各写一套慢慢分叉。
 */
function doctorLine(doctor) {
  if (!doctor) return null;
  return renderDoctorBriefLine(doctor);
}

/**
 * 磁盘卫生行：`🗑 清理：state 5.0 MB（10/24 清出 327 MB）`。
 * 只在周日出现 —— 项目计划 ② 要的是「每周由简报附带一行」，天天念体积没人看。
 * 格式与状态在 src/clean-state.mjs（有单测），这里只管接线。
 */
function cleanLine(clean, when) {
  if (!clean) return null;
  if (when.getDay() !== 0) return null;
  return renderCleanBriefLine(clean, { now: when.getTime() });
}
/** QQ 侧把 Markdown 当乱码显示：清掉 ** 与 ``` ，把 # 换成全角（保留语义、不触发乱码）。 */
export function sanitizeBriefText(text) {
  return String(text ?? '')
    .replace(/```/g, '')
    .replace(/\*\*/g, '')
    .replace(/#/g, '＃');
}

/**
 * 快照 + 统计 + 上次状态 → 一条纯文本简报（无 I/O，可离线单测）。
 * @param {{ at?: number|Date|string, snapshot?: object, usage?: object|null,
 *           toolStats?: object|null, prev?: object|null, config?: object|null,
 *           cost?: object|null }} input
 * @returns {string}
 */
export function renderBrief({ at = Date.now(), snapshot = null, usage = null, toolStats = null, prev = null, weather = null, config = null, backup = null, doctor = null, clean = null, cost = null, health = null } = {}) {
  const cfg = normalizeDailyBriefConfig(config);
  const raw = at instanceof Date ? at : new Date(at);
  const when = Number.isFinite(raw.getTime()) ? raw : new Date();

  const { red } = serviceState(snapshot);
  const weatherLine = cfg.weather.enabled ? formatWeather(weather) : null;
  const body = [
    servicesLine(snapshot, health),
    remindersLine(snapshot),
    activityLine(snapshot, toolStats),
  ];
  const optional = [];
  // 成本行：有 cost 判定（evaluateCostGuard 的结果）就用它 —— 同一行同时承载
  // 「缓存率是否达标」「单窗口输入是否超限」「最大开销来自哪个会话」，不额外占行。
  const token = cost ? renderCostBriefLine(cost) : tokenLine(usage);
  if (token) optional.push(token);
  const recovery = recoveryLine(prev, red);
  // 运维三行（备份 / 自检 / 清理）放在 token 之前：它们比 token 数字更可能促成一次动作。
  const ops = [backupLine(backup, when), doctorLine(doctor), cleanLine(clean, when)].filter(Boolean);

  let lines = [`早，${pad2(when.getMonth() + 1)}/${pad2(when.getDate())} ${pad2(when.getHours())}:${pad2(when.getMinutes())}`];
  // 天气紧跟问候语：早上第一眼想知道的就是「今天穿什么、带不带伞」。
  if (weatherLine) lines.push(weatherLine);
  lines = [...lines, ...body, ...ops, ...optional];
  if (recovery && lines.length < cfg.maxLines) lines.push(recovery);

  lines = lines.map((l) => sanitizeBriefText(l));
  // 超长先砍 token 行（信息密度最低），再砍清理、自检、备份、恢复行，天气最后才动，最后才硬截断。
  const trimToBudget = (arr) => {
    const out = arr.slice(0, cfg.maxLines);
    const dropOrder = [
      optional[0] ? sanitizeBriefText(optional[0]) : null,
      ops[2] ? sanitizeBriefText(ops[2]) : null,
      ops[1] ? sanitizeBriefText(ops[1]) : null,
      ops[0] ? sanitizeBriefText(ops[0]) : null,
      recovery ? sanitizeBriefText(recovery) : null,
      weatherLine ? sanitizeBriefText(weatherLine) : null,
    ].filter(Boolean);
    for (const victim of dropOrder) {
      if (out.join('\n').length <= cfg.maxChars) break;
      const idx = out.lastIndexOf(victim);
      if (idx > 0) out.splice(idx, 1);
    }
    let text = out.join('\n');
    if (text.length > cfg.maxChars) text = `${text.slice(0, Math.max(1, cfg.maxChars - 1))}…`;
    return text;
  };
  return trimToBudget(lines);
}
