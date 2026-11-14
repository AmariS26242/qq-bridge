// 上下文水位守门：影子模式优先的纯函数模块。
//
// 只做纯计算：不碰 fs / net / process / 定时器，也不 import 任何模块。
// 真正的“读水位”“触发交接”由 src/bridge.js 调用本模块完成，这里不产生副作用。
//
// 回滚方式：把配置里的 enabled 设为 false（默认就是 false），
// 分类与日志都会退化为无声的 'ok'，不会请求任何交接。

/** 默认配置。enabled:false 是总回滚开关，绝不默认开启。 */
export const CONTEXT_BUDGET_DEFAULTS = Object.freeze({
  enabled: false,          // 总开关，回滚用
  mode: 'shadow',          // 'shadow'（只记日志/标记）| 'enforce'（真的请求交接）
  softAt: 60000,           // 水位 >= 此值记 soft
  hardAt: 120000,          // 水位 >= 此值记 hard 并置 pendingHandoff
  handoffTokenBudget: 600, // 交接摘要注入预算（token 数）
});

/**
 * 把任意脏输入归一化成合法配置，永不抛异常。
 * @param {unknown} raw
 * @returns {{ enabled: boolean, mode: 'shadow'|'enforce', softAt: number, hardAt: number, handoffTokenBudget: number }}
 */
export function normalizeContextBudgetConfig(raw) {
  // 严格 === true 才算开启：'true'、1、{} 一律视为关闭。
  const enabled = raw?.enabled === true;
  // 只认 'enforce'，其余（大小写不同、布尔值、缺失）都回落到影子模式。
  const mode = raw?.mode === 'enforce' ? 'enforce' : 'shadow';

  const softAt = normalizeInt(raw?.softAt, 1000, 2000000, CONTEXT_BUDGET_DEFAULTS.softAt);
  let hardAt = normalizeInt(raw?.hardAt, 1000, 2000000, CONTEXT_BUDGET_DEFAULTS.hardAt);
  const handoffTokenBudget = normalizeInt(
    raw?.handoffTokenBudget,
    100,
    4000,
    CONTEXT_BUDGET_DEFAULTS.handoffTokenBudget,
  );

  // 硬阈值必须严格高于软阈值，否则顺延 1000。
  if (hardAt <= softAt) hardAt = softAt + 1000;

  return { enabled, mode, softAt, hardAt, handoffTokenBudget };
}

/**
 * 分类当前上下文水位。
 * 注意：缺失/非法水位返回 'unknown'，绝不按 0 处理。
 * @param {unknown} watermark
 * @param {unknown} config
 * @returns {'ok'|'soft'|'hard'|'unknown'}
 */
export function classifyContextWatermark(watermark, config) {
  // 与 normalizeContextBudgetConfig 同语义：只有严格 === true 才算开着。
  // 之前写的是 enabled === false，导致「没写 enabled」被当成开启，与配置层判断相反。
  if (config === null || config === undefined) return 'ok';
  if (config.enabled !== true) return 'ok';

  if (typeof watermark !== 'number' || !Number.isFinite(watermark) || watermark < 0) {
    return 'unknown';
  }

  const softAt = normalizeThreshold(config.softAt, CONTEXT_BUDGET_DEFAULTS.softAt);
  let hardAt = normalizeThreshold(config.hardAt, CONTEXT_BUDGET_DEFAULTS.hardAt);
  if (hardAt <= softAt) hardAt = softAt + 1000;

  if (watermark < softAt) return 'ok';
  if (watermark < hardAt) return 'soft';
  return 'hard';
}

/**
 * 把 token 数格式化成人类可读的 K/M 串；非法值返回长破折号。
 * @param {unknown} value
 * @returns {string}
 */
export function formatContextWatermark(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return String(Math.round(value));
  if (value < 1e6) return formatScaled(value / 1000, 'K');
  return formatScaled(value / 1e6, 'M');
}

/**
 * 渲染一行守卫日志。
 * @param {{ watermark?: unknown, level?: string, key?: string }} [entry]
 * @returns {string}
 */
export function renderBudgetLogLine({ watermark, level, key = '' } = {}) {
  const text = level === 'unknown'
    ? '上下文未知'
    : `上下文 ${formatContextWatermark(watermark)}`;
  let line = `[budget] ${text}（${level}）`;
  if (key) line += ` key=${key}`;
  return line;
}

/**
 * 只有 enforce 模式下的 hard 才请求交接；shadow 只记录不动作。
 * @param {unknown} level
 * @param {unknown} config
 * @returns {boolean}
 */
export function shouldRequestHandoff(level, config) {
  return level === 'hard' && config?.mode === 'enforce';
}

// ---------------------------------------------------------------------------
// 内部工具（不导出）

function normalizeInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

function normalizeThreshold(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(value);
}

function formatScaled(scaled, unit) {
  // 保留 1 位小数，并去掉多余的 .0：1500 -> 1.5K，62000 -> 62K。
  const rounded = Math.round(scaled * 10) / 10;
  return `${String(rounded).replace(/\.0$/, '')}${unit}`;
}
