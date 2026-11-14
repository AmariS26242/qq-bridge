// 服务健康时序的**纯逻辑**：把「每 5 分钟一行」的探测记录压成可用率与抖动次数。
//
// 为什么要有这个东西（见 项目计划/07-候选项目清单.md ⑧）：
//   简报里的服务行只回答「此刻活着吗」。真正的运维问题是**过去一周掉过几次、掉了多久** ——
//   一次 3 秒的重启和一次 40 分钟的掉线，在「现在正常」面前长得一模一样。所以要有一条
//   自己的时间序列，而不是只靠巡检当时的快照。
//
// 行格式（单行 < 100 B，一天 288 行）：
//   {"t":1750000000000,"q":1,"b":1,"p":0,"c":1}
//   q=QQ桥(3100) b=bot(3000) p=手机桥(8899) c=校园网；1=在听 0=挂了 -1=没探到
// 用短键是刻意的：写 288 行/天、按周汇总，字段名重复 288 次纯属浪费。
//
// 三条口径：
// 1. **unknown(-1) 不进分母。** bot 的 HTTP 端口偶发超时不等于 bot 挂了，把它算成 down
//    会把可用率压出一个假窟窿；只统计「确定在听」与「确定没在听」。
// 2. **抖动(flap)只数 up→down 的下降沿。** 一次掉线后连续 8 个 down 采样算 1 次抖动
//    （不是 8 次），否则断电一小时能刷出十几条「抖动」。
// 3. **掉线区间按采样间隔估算。** 5 分钟一采，只能给出「起于某采样点、止于某采样点」的
//    区间；时长说「约 N 分钟」，不做秒级精度承诺。

export const HEALTH_SERVICES = Object.freeze([
  { key: 'q', label: 'QQ桥', port: 3100 },
  { key: 'b', label: 'bot', port: 3000 },
  { key: 'p', label: '手机桥', port: 8899 },
  { key: 'c', label: '校园网', port: null },
]);

export const HEALTH_SERVICE_KEYS = Object.freeze(HEALTH_SERVICES.map((s) => s.key));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 三态归一：true/1 → 1，false/0 → 0，其余（含 null/undefined/超时）→ -1。 */
function tri(v) {
  if (v === true || v === 1 || v === '1') return 1;
  if (v === false || v === 0 || v === '0') return 0;
  return -1;
}

/** 一行探测记录：`{"t":...,"q":1,"b":1,"p":-1,"c":1}`。states 里缺的键写 -1。 */
export function serializeProbe(states, t) {
  const out = { t: Math.round(num(t)) };
  for (const { key } of HEALTH_SERVICES) out[key] = tri(states?.[key]);
  return JSON.stringify(out);
}

/** 解析一行（也接受已 parse 的对象，方便 readJsonl 复用）；坏行返回 null。 */
export function parseProbe(line) {
  let rec;
  if (line && typeof line === 'object') rec = line;
  else {
    try { rec = JSON.parse(String(line)); } catch { return null; }
  }
  if (!rec || typeof rec !== 'object') return null;
  const t = Number(rec.t);
  if (!Number.isFinite(t) || t <= 0) return null;
  const states = {};
  for (const { key } of HEALTH_SERVICES) states[key] = tri(rec[key]);
  return { t, states };
}

/** 统计区间内的采样数（用于判断「探针是否还活着」）。 */
export function countSamples(entries, { from = 0, to = Infinity } = {}) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && Number.isFinite(e.t) && e.t >= from && e.t <= to).length;
}

/**
 * 按服务汇总：可用率、抖动次数、掉线区间。
 * @param {{t:number,states:object}[]} entries parseProbe 的结果（顺序无关，内部排序）
 * @param {{from?:number,to?:number}} window
 * @returns {{samples:number,from:number,to:number,services:object[],flaps:number,windows:object[]}}
 */
export function summarizeHealth(entries, window = {}) {
  const from = Number.isFinite(Number(window.from)) ? Number(window.from) : 0;
  const to = Number.isFinite(Number(window.to)) ? Number(window.to) : Infinity;
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && Number.isFinite(e.t) && e.t >= from && e.t <= to)
    .sort((a, b) => a.t - b.t);

  const windows = [];
  const services = HEALTH_SERVICES.map(({ key, label, port }) => {
    let up = 0;
    let down = 0;
    let unknown = 0;
    let flaps = 0;
    let prev = null;
    let openAt = null;
    let lastDownAt = null;
    for (const e of list) {
      const v = tri(e.states?.[key]);
      if (v === -1) { unknown += 1; continue; }
      if (v === 0) {
        down += 1;
        lastDownAt = e.t;
        if (prev === 1) {
          flaps += 1;
          openAt = e.t;
        } else if (prev === null) {
          openAt = e.t; // 窗口一开始就是挂的：也算一段掉线，但不计抖动（没有下降沿）
        }
      } else if (v === 1) {
        up += 1;
        if (openAt !== null) {
          windows.push({ key, label, from: openAt, to: e.t, minutes: Math.max(1, Math.round((e.t - openAt) / MINUTE)) });
          openAt = null;
        }
      }
      prev = v;
    }
    // 窗口末尾仍挂着：区间截止到最后一个 down 采样（不假装它「已恢复」）
    if (openAt !== null) windows.push({ key, label, from: openAt, to: lastDownAt ?? openAt, minutes: Math.max(1, Math.round(((lastDownAt ?? openAt) - openAt) / MINUTE)) });
    const denom = up + down;
    return {
      key,
      label,
      port,
      up,
      down,
      unknown,
      samples: denom,
      uptime: denom > 0 ? up / denom : null,
      flaps,
      openNow: openAt !== null,
      lastDownAt,
    };
  });

  return {
    samples: list.length,
    from: list.length ? list[0].t : from,
    to: list.length ? list[list.length - 1].t : to,
    services,
    flaps: services.reduce((s, x) => s + x.flaps, 0),
    windows: windows.sort((a, b) => a.from - b.from),
  };
}

/** 百分比：99.23 → "99.2%"，100 → "100%"。 */
function uptimeText(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const pct = Number(v) * 100;
  if (pct >= 99.95) return '100%';
  return `${pct.toFixed(1)}%`;
}

/**
 * 简报服务行的后缀：只报「最近 windowHours 抖过几次」。
 * 没采样（探针还没跑起来/文件读不到）返回 null —— 服务行保持原样，不写「0 次」冒充有数据。
 */
export function renderHealthBriefSuffix(summary, { windowHours = 24 } = {}) {
  if (!summary || !num(summary.samples)) return null;
  const hours = Math.round(num(windowHours)) || 24;
  return summary.flaps > 0 ? `（${hours}h 抖动 ${summary.flaps} 次）` : `（${hours}h 无抖动）`;
}

/**
 * 周报的可用率行。
 *   📈 可用率：QQ桥 99.2% · bot 100% · 手机桥 98.6% · 校园网 99.9%（抖动 3 次）
 * 无采样返回 null（周报少一行，不写假数据）。
 */
export function renderUptimeLine(summary, { maxChars = 200 } = {}) {
  if (!summary || !num(summary.samples) || !Array.isArray(summary.services)) return null;
  const bits = summary.services
    .filter((s) => s && s.samples > 0)
    .map((s) => `${s.label} ${uptimeText(s.uptime)}`);
  if (!bits.length) return null;
  const flapText = summary.flaps > 0 ? `（抖动 ${summary.flaps} 次）` : '（无抖动）';
  const text = `📈 可用率：${bits.join(' · ')}${flapText}`;
  return text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
}

/**
 * QQ 链路（SnowLuma WS ↔ 桥接）是否真的通。
 *
 * 为什么不能只看端口：2026-10-24 15:01 的事故里，桥接进程活着、3100 在听、
 * `get_status` 还报 accountOnline=true，但 WS 从未连上（SnowLuma 拒了 upgrade），
 * 于是「收不到也发不出」持续了一小时，而所有只探 TCP 的检查全是绿的。
 * 真正的可用信号是桥接自己的 `/api/status`：`snowluma.connected` + 最近事件时间。
 *
 * 输入是 `/api/status` 的 JSON（拿不到就传 null）。
 * 返回 `{ state: 'up' | 'down' | 'unknown', reason }`。
 */
export function linkState(status, { maxSilenceMs = 120_000 } = {}) {
  const s = status?.snowluma;
  if (!s || typeof s !== 'object') return { state: 'unknown', reason: '没有链路状态' };
  if (s.connected !== true) return { state: 'down', reason: 'WS 未连接' };
  const age = typeof s.lastPacketAgoMs === 'number' ? s.lastPacketAgoMs : null;
  if (age !== null && age > maxSilenceMs) {
    return { state: 'down', reason: `上游已 ${Math.round(age / 1000)}s 没有事件` };
  }
  if (s.good === false) return { state: 'down', reason: 'SnowLuma 自评接收链路不健康（good=false）' };
  const via = s.goodSource ? `（${s.goodSource}）` : '';
  return { state: 'up', reason: `WS 已连接${via}` };
}

/** 掉线区间 → 人读一行（诊断用，不进简报）。 */
export function formatDownWindows(summary, { limit = 5 } = {}) {
  const wins = Array.isArray(summary?.windows) ? summary.windows : [];
  if (!wins.length) return [];
  return wins.slice(-limit).map((w) => {
    const at = new Date(w.from);
    const hh = String(at.getHours()).padStart(2, '0');
    const mm = String(at.getMinutes()).padStart(2, '0');
    return `${w.label} ${hh}:${mm} 起 约 ${w.minutes} 分钟`;
  });
}
