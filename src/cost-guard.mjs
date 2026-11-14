// 成本守门的**纯逻辑**：把 token-usage.jsonl 的逐轮采样按会话聚合，判阈值，出简报行。
//
// 为什么单独一个模块（照 backup / doctor / clean-state 的同一套做法）：
//   简报要能在 bridge 停掉时单独跑，所以这里的判定与渲染必须不碰 fs/net，可离线单测
//   （scripts/test-cost-guard.mjs）。scripts/daily-brief.mjs 只负责把文件读成数组。
//
// 四条口径（每条都是踩过坑才定下来的）：
//
// 1. **只认 k==='turn'**。token-usage.jsonl 里还有 k:'base' 的累计基线行（整条会话在某
//    seq 上的总量）；把它和逐轮采样相加就是重复计费，数字会凭空翻倍。
//
// 2. **阈值必须按这台机器的真实分布校准，不能照抄计划里的 40M。**
//    实测 2026-10-16..24：单日输入 6.4M–137.5M、缓存命中 99.0%–99.7%。40M 的硬上限会
//    让简报天天报红 —— 天天红等于没有红项（doctor 里同样的教训：历史红的不算红）。
//    所以 40M 只作为**代码默认**保留，真正的阈值放 config.json 的 costGuard 段，
//    由使用者按自己的常态调；另外保留一条「缓存率」硬线（< 95% 就是真的在重算前缀）。
//
// 3. **「最大开销来自哪个会话」用 sid 后缀 + 会话 key 的中文标签。**
//    token-usage 里没有会话标题，硬编一个「第 N 个会话」既不可读也不能对账；
//    sid 后 8 位能在 `mem.py search --json` / 会话文件里直接搜到，够用。
//
// 4. **上下文水位（第 4 条红线）取「该会话最近一条 turn 采样」的 cacheHit+cacheMiss，
//    不是日累计、也不是历史最大值。** 日累计会把「昨天聊得多」和「现在这一轮快把窗口塞满」
//    混成一件事；历史最大值只会单调上涨，涨上去就永远报红（等于没有红项）。所以：
//    按 t→turn→step→retry→seq 排序取最后一条，同一 sid|turn|step|retry 的重复行只认排序
//    最靠后的那条，无采样就是 null（绝不当 0，0 会被当成「很安全」）。

export const COST_GUARD_DEFAULTS = Object.freeze({
  enabled: true,
  cacheRateMin: 0.95, // 缓存命中率红线（低于即红）
  dailyInputMax: 40_000_000, // 单窗口输入 token 上限（计划里的原值；本机 config 已按实测调高）
  // 单会话上下文水位上限：只看该会话**最近一条** turn 采样的 cacheHit+cacheMiss。
  // 注意这是「单会话水位」，不是日累计、也不是跨会话合计（口径 4）。
  contextWatermarkMax: 120_000,
  topShareMin: 0.5, // 最大会话占比低于这个就不点名（「大头」没占一半时是噪音）
});

/** 会话 key 前缀 → 中文标签；未知前缀用「会话」。 */
const KEY_LABELS = [
  [/^private:/, '私聊'],
  [/^group:/, '群聊'],
  [/^internal:/, '内部'],
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 紧凑数字：75.7M / 35.1k / 812（与简报同口径；token 是千万级，完整数字会撑爆一行）。 */
export function formatTokenCount(n) {
  const v = num(n);
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

/** 配置容错：坏值回落默认，绝不抛错（config.json 是手改的）。 */
export function normalizeCostGuardConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...COST_GUARD_DEFAULTS };

  if (src.enabled !== undefined) {
    const v = src.enabled;
    out.enabled = !(v === false || v === 0 || /^(false|0|no|off)$/i.test(String(v).trim()));
  }

  const rate = Number(src.cacheRateMin);
  if (Number.isFinite(rate) && rate > 0 && rate <= 1) out.cacheRateMin = rate;

  const cap = Number(src.dailyInputMax);
  if (Number.isFinite(cap) && cap >= 1e5) out.dailyInputMax = Math.round(cap);

  // 单会话水位上限：整数、[1e3, 5e6]，越界/非法/缺失一律回落默认（别让手改的值把红线调成 0 天天红）。
  const watermark = Number(src.contextWatermarkMax);
  if (Number.isFinite(watermark) && watermark >= 1_000 && watermark <= 5_000_000) {
    out.contextWatermarkMax = Math.round(watermark);
  }

  const share = Number(src.topShareMin);
  if (Number.isFinite(share) && share >= 0 && share <= 1) out.topShareMin = share;

  return out;
}

/** `private:100000001` → 「私聊」，`session-8648…` → 「会话」。 */
export function sessionLabel(rec) {
  const key = String(rec?.key ?? '').trim();
  for (const [re, label] of KEY_LABELS) if (re.test(key)) return label;
  return '会话';
}

/** sid → 后 8 位（`session-8648c1d2-…` 取 8648c1d2），搜索/对照都能直接命中。 */
export function sessionTag(sid) {
  const s = String(sid ?? '').replace(/^session-/, '');
  const first = s.split('-')[0];
  if (first && first.length >= 4) return first.slice(0, 8);
  return s.slice(0, 8);
}

/** 采样排序键：t → turn → step → retry → seq（缺失当 0 = 最小，排最前）。 */
function sampleOrder(rec) {
  return [num(rec.t), num(rec.turn), num(rec.step), num(rec.retry), num(rec.seq)];
}

/**
 * 逐轮采样 → 汇总 + 按会话拆分。
 * @param {object[]} entries token-usage.jsonl 解析后的行（含 base 行，这里会跳过）
 * @param {{from:number,to:number}} window
 */
export function summarizeUsageBySession(entries, window) {
  const from = num(window?.from);
  const to = Number.isFinite(Number(window?.to)) ? Number(window.to) : Infinity;
  const totals = { input: 0, cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0, turns: 0 };
  const bySid = new Map();
  // 每条 turn 采样各记一条「水位快照」，用来算每个会话**最近一条**采样（口径 4）。
  const samples = [];

  for (const rec of Array.isArray(entries) ? entries : []) {
    if (!rec || rec.k !== 'turn') continue;
    const t = num(rec.t);
    if (!Number.isFinite(t) || t < from || t > to) continue;
    const b = rec.b && typeof rec.b === 'object' ? rec.b : {};
    const hit = num(b.cacheHit);
    const miss = num(b.cacheMiss);
    const write = num(b.cacheWrite);
    const input = hit + miss;
    const output = num(b.output);

    totals.cacheHit += hit;
    totals.cacheMiss += miss;
    totals.cacheWrite += write;
    totals.output += output;
    totals.turns += 1;

    const sid = String(rec.sid ?? '');
    const cur = bySid.get(sid) || { sid, key: String(rec.key ?? ''), input: 0, cacheHit: 0, output: 0, turns: 0 };
    cur.input += input;
    cur.cacheHit += hit;
    cur.output += output;
    cur.turns += 1;
    if (!cur.key && rec.key) cur.key = String(rec.key);
    // 水位 = 这一条采样自己看到的上下文（hit+miss）：不是累计，也不是历史峰值。
    samples.push({
      sid,
      watermark: input,
      order: sampleOrder(rec),
      // 与 token-ledger 的 sampleKeyOf 同键：重复写入（重连/补写）只认排序最靠后的那条。
      dedupe: `${sid}|${num(rec.turn)}|${num(rec.step)}|${num(rec.retry)}`,
    });
    bySid.set(sid, cur);
  }

  totals.input = totals.cacheHit + totals.cacheMiss;

  // 最近一条采样：按 t→turn→step→retry→seq 升序排，末尾就是「最近」。
  // 再倒着走一遍：每个会话遇到的第一条（最新的）就是它的水位；重复行只认排序最靠后的那条。
  samples.sort((a, b) => {
    for (let i = 0; i < a.order.length; i += 1) {
      if (a.order[i] !== b.order[i]) return a.order[i] - b.order[i];
    }
    return 0;
  });
  const watermarkBySid = new Map();
  const seenSample = new Set();
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const s = samples[i];
    if (seenSample.has(s.dedupe)) continue;
    seenSample.add(s.dedupe);
    if (!watermarkBySid.has(s.sid)) watermarkBySid.set(s.sid, s.watermark);
  }

  const sessions = [...bySid.values()]
    .map((s) => ({
      ...s,
      // 没有有效采样就是 null —— 绝不写成 0（0 会被读成「窗口很空、很安全」）。
      contextWatermark: watermarkBySid.has(s.sid) ? watermarkBySid.get(s.sid) : null,
      share: totals.input > 0 ? s.input / totals.input : 0,
    }))
    .sort((a, b) => b.input - a.input || a.sid.localeCompare(b.sid));

  // 跨会话取最大值：只比「各自最近一条」，不是全天累计。
  let maxContextWatermark = null;
  let maxContextWatermarkSession = null;
  for (const s of sessions) {
    if (s.contextWatermark == null) continue;
    if (maxContextWatermark === null || s.contextWatermark > maxContextWatermark) {
      maxContextWatermark = s.contextWatermark;
      maxContextWatermarkSession = s.key || s.sid || null;
    }
  }

  return {
    ...totals,
    cacheRate: totals.input > 0 ? totals.cacheHit / totals.input : 0,
    maxContextWatermark,
    maxContextWatermarkSession,
    sessions,
    top: sessions[0] ?? null,
  };
}

/**
 * 判阈值。只认三条硬线（缓存率、单窗口输入、单会话上下文水位），返回可序列化的判定结果。
 * @returns {{ok:boolean, reds:object[], cacheRate:number, input:number, output:number, turns:number, top:object|null}}
 */
export function evaluateCostGuard(summary, config = null) {
  const cfg = normalizeCostGuardConfig(config);
  const input = num(summary?.input);
  const output = num(summary?.output);
  const cacheRate = input > 0 ? num(summary?.cacheHit) / input : 0;
  // 水位只有「有采样」才参与判定：null/undefined/NaN 一律不触发（没数据不等于安全，也不等于报警）。
  const rawWatermark = summary?.maxContextWatermark;
  const watermark = rawWatermark != null && Number.isFinite(Number(rawWatermark)) ? Number(rawWatermark) : null;
  const reds = [];

  if (input > 0 && cacheRate < cfg.cacheRateMin) {
    reds.push({ code: 'cache-rate', value: cacheRate, limit: cfg.cacheRateMin });
  }
  if (input > cfg.dailyInputMax) {
    reds.push({ code: 'input-cap', value: input, limit: cfg.dailyInputMax });
  }
  if (watermark !== null && watermark >= cfg.contextWatermarkMax) {
    const who = summary?.maxContextWatermarkSession ?? null;
    reds.push({
      code: 'context-watermark',
      value: watermark,
      limit: cfg.contextWatermarkMax,
      session: who,
      message: `单会话上下文 ${formatTokenCount(watermark)} 已超阈值 ${formatTokenCount(cfg.contextWatermarkMax)}${who ? `（会话 ${who}）` : ''}`,
    });
  }

  return {
    ok: reds.length === 0,
    reds,
    cacheRate,
    cacheHit: num(summary?.cacheHit),
    input,
    output,
    turns: num(summary?.turns),
    top: summary?.top ?? null,
    maxContextWatermark: watermark,
    maxContextWatermarkSession: summary?.maxContextWatermarkSession ?? null,
    config: cfg,
  };
}

/**
 * 简报里的一行（`💰`/`❌` 前缀 + 输入 + 缓存率 + 输出 + 单会话水位 + 最大会话）。
 * 没有数据返回 null —— 简报少一行，不占行数也不撒谎。
 */
export function renderCostBriefLine(result, { maxChars = 78 } = {}) {
  if (!result || typeof result !== 'object') return null;
  const input = num(result.input);
  const output = num(result.output);
  if (!input && !output) return null;

  const cfg = normalizeCostGuardConfig(result.config);
  const pct = (num(result.cacheRate) * 100).toFixed(1);
  const redCache = (result.reds || []).some((r) => r?.code === 'cache-rate');
  const redCap = (result.reds || []).some((r) => r?.code === 'input-cap');
  const redWatermark = (result.reds || []).some((r) => r?.code === 'context-watermark');
  // 水位没有数据就整段不出现（简报宁可少一段，也不写「0」骗人）。
  const watermark = result.maxContextWatermark != null && Number.isFinite(Number(result.maxContextWatermark))
    ? Number(result.maxContextWatermark)
    : null;

  const bits = [];
  // 红项只加「<95%」「>40M」这种比较符，不重排整行：简报里的数字位置天天一样才好扫。
  if (redCache) bits.push(`缓存 ${pct}%<${(cfg.cacheRateMin * 100).toFixed(1).replace(/\.0$/, '')}%`);
  else bits.push(`缓存 ${pct}%`);
  if (redCap) bits.push(`输入 ${formatTokenCount(input)}>${formatTokenCount(cfg.dailyInputMax)}`);
  else bits.push(`输入 ${formatTokenCount(input)}`);
  if (output) bits.push(`输出 ${formatTokenCount(output)}`);
  // 单会话上下文水位：一段短词（`水位 118.0k>120.0k`），不重排前面的数字位置。
  if (watermark !== null) {
    if (redWatermark) bits.push(`水位 ${formatTokenCount(watermark)}>${formatTokenCount(cfg.contextWatermarkMax)}`);
    else bits.push(`水位 ${formatTokenCount(watermark)}`);
  }

  const top = result.top;
  if (top && num(top.input) > 0 && num(top.share) >= cfg.topShareMin) {
    bits.push(`大头 ${sessionLabel(top)} ${sessionTag(top.sid)} ${Math.round(num(top.share) * 100)}%`);
  }

  const head = result.ok === false ? '❌ 成本：' : '💰 成本：';
  const text = `${head}${bits.join(' · ')}`;
  return text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
}
