// 成本守门的离线单测：只测纯函数，不碰文件/网络/QQ。
//   node scripts/test-cost-guard.mjs
// 期望最后一行：PASS：N 项通过，0 项失败
import {
  COST_GUARD_DEFAULTS,
  normalizeCostGuardConfig,
  summarizeUsageBySession,
  evaluateCostGuard,
  renderCostBriefLine,
  sessionLabel,
  sessionTag,
  formatTokenCount,
} from '../src/cost-guard.mjs';
import { renderBrief, normalizeDailyBriefConfig } from '../src/daily-brief.mjs';

const AT = new Date(2026, 9, 24, 8, 0, 0); // 本地时间 10/24 08:00
const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
  assert(actual === expected, `${msg || '值不相等'}：实际「${actual}」期望「${expected}」`);
}

function assertIncludes(hay, needle, msg) {
  assert(String(hay).includes(needle), msg || `缺少「${needle}」：\n${hay}`);
}

function assertNotIncludes(hay, needle, msg) {
  assert(!String(hay).includes(needle), msg || `不该出现「${needle}」：\n${hay}`);
}

const HOUR = 3600_000;
const W = { from: AT.getTime() - 24 * HOUR, to: AT.getTime() };

const BIG = 'session-8648c1d2-486e-4a2f-84eb-04a1b6b50ed0';

function turn(overrides = {}) {
  return {
    k: 'turn',
    t: AT.getTime() - HOUR,
    sid: BIG,
    key: 'private:100000001',
    b: { cacheHit: 99_000, cacheMiss: 1_000, cacheWrite: 0, output: 100 },
    ...overrides,
  };
}

/** 造 n 条同会话的采样，每条 input = hit+miss。 */
function turns(n, { hit = 99_000, miss = 1_000, sid = BIG, key = 'private:100000001', t = AT.getTime() - HOUR } = {}) {
  return Array.from({ length: n }, (_, i) => turn({
    sid,
    key,
    t: t + i,
    b: { cacheHit: hit, cacheMiss: miss, cacheWrite: 0, output: 100 },
  }));
}

check('1 只认 turn 行：base 行与窗外采样都不进汇总', () => {
  const entries = [
    turn({ k: 'base' }),
    turn({ t: W.from - 1 }),
    turn({ t: W.to + 1 }),
    ...turns(3),
  ].filter(Boolean);
  const s = summarizeUsageBySession(entries, W);
  assertEqual(s.turns, 3, '轮次数');
  assertEqual(s.input, 3 * 100_000, '输入合计');
  assertEqual(s.output, 300, '输出合计');
  assert(Math.abs(s.cacheRate - 0.99) < 1e-9, `缓存率应 99%：${s.cacheRate}`);
});

check('2 按会话拆分：占比、排序、最大会话', () => {
  const big = 'session-8648c1d2-486e-4a2f-84eb-04a1b6b50ed0';
  const small = 'session-afbc3e0d-5508-4b75-8661-11db478e6ba9';
  const entries = [
    ...turns(3, { sid: big, hit: 99_000, miss: 1_000 }),
    ...turns(1, { sid: small, hit: 9_000, miss: 1_000, key: 'internal:黑话学习' }),
  ];
  const s = summarizeUsageBySession(entries, W);
  assertEqual(s.sessions.length, 2, '会话数');
  assertEqual(s.sessions[0].sid, big, '最大会话应排第一');
  assertEqual(s.sessions[0].input, 300_000, '最大会话输入');
  assert(Math.abs(s.sessions[0].share - 0.9677) < 0.001, `占比不对：${s.sessions[0].share}`);
  assertEqual(s.top.sid, big, 'top 指向最大会话');
});

check('3 空数据不炸：不传、空数组、坏行', () => {
  for (const bad of [undefined, null, [], [null, 42, {}, { k: 'turn' }]]) {
    const s = summarizeUsageBySession(bad, W);
    assertEqual(s.input, 0, '输入应为 0');
    assertEqual(s.sessions.length, 0, '不应有会话');
    assertEqual(s.top, null, 'top 应为 null');
    assertEqual(renderCostBriefLine(evaluateCostGuard(s)), null, '无数据不该出成本行');
  }
});

check('4 判定：默认阈值下 40M 硬上限会红（计划原值）', () => {
  const s = summarizeUsageBySession(turns(500, { hit: 99_000, miss: 1_000 }), W); // 50M 输入
  const r = evaluateCostGuard(s);
  assertEqual(r.ok, false, '50M 应超默认 40M');
  assert(r.reds.some((x) => x.code === 'input-cap'), '缺 input-cap 红项');
  assertEqual(r.config.dailyInputMax, COST_GUARD_DEFAULTS.dailyInputMax, '默认阈值');
});

check('5 判定：缓存率低于 95% 是红项', () => {
  const s = summarizeUsageBySession(turns(10, { hit: 90_000, miss: 10_000 }), W);
  const r = evaluateCostGuard(s);
  assertEqual(r.ok, false, '90% 缓存应红');
  assert(r.reds.some((x) => x.code === 'cache-rate'), '缺 cache-rate 红项');
});

check('6 判定：缓存率正好 95% 算绿（阈值是「低于才红」）', () => {
  const s = summarizeUsageBySession(turns(10, { hit: 95_000, miss: 5_000 }), W);
  const r = evaluateCostGuard(s, { dailyInputMax: 1e9 });
  assertEqual(r.ok, true, '95% 不应红');
  assertEqual(r.reds.length, 0, '不该有红项');
});

check('7 判定：调高上限后 137M 不再红（本机口径）', () => {
  const s = summarizeUsageBySession(turns(1400, { hit: 99_000, miss: 1_000 }), W);
  const r = evaluateCostGuard(s, { dailyInputMax: 150_000_000 });
  assertEqual(r.ok, true, '137M 在 150M 上限内应绿');
});

check('8 行格式（绿）：缓存 + 输入 + 输出 + 水位 + 大头会话', () => {
  const big = 'session-8648c1d2-486e-4a2f-84eb-04a1b6b50ed0';
  const s = summarizeUsageBySession(turns(3, { sid: big, hit: 99_000, miss: 1_000 }), W);
  const line = renderCostBriefLine(evaluateCostGuard(s, { dailyInputMax: 1e9 }));
  assertEqual(line, '💰 成本：缓存 99.0% · 输入 300.0k · 输出 300 · 水位 100.0k · 大头 私聊 8648c1d2 100%', '绿行格式');
});

check('9 行格式（红）：缓存 <95% 与输入超限都用比较符，位置稳定', () => {
  const s = summarizeUsageBySession(turns(10, { hit: 90_000, miss: 10_000 }), W);
  const r = evaluateCostGuard(s, { dailyInputMax: 500_000 });
  const line = renderCostBriefLine(r);
  assertIncludes(line, '缓存 90.0%<95%');
  assertIncludes(line, '输入 1.0M>500.0k');
  assert(line.startsWith('❌ 成本：'), `红行前缀不对：${line}`);
});

check('10 大头会话：三家平分（各 ~33%）时不点名', () => {
  const entries = [
    ...turns(34, { sid: 'session-aaaaaaaa-1111-2222-3333-444444444444' }),
    ...turns(33, { sid: 'session-bbbbbbbb-1111-2222-3333-444444444444' }),
    ...turns(33, { sid: 'session-cccccccc-1111-2222-3333-444444444444', key: 'group:1' }),
  ];
  const s = summarizeUsageBySession(entries, W);
  const line = renderCostBriefLine(evaluateCostGuard(s, { dailyInputMax: 1e9 }));
  assertNotIncludes(line, '大头', '34% 不足 50% 阈值，不该点名');
});

check('11 大头会话：一家独大时点名，标签来自会话 key', () => {
  const entries = [
    ...turns(24),
    ...turns(1, { sid: 'session-14d5c245-dd13-44ec-abed-c0c24ed822c1', key: 'internal:黑话学习', hit: 4_000, miss: 0 }),
  ];
  const s = summarizeUsageBySession(entries, W);
  const line = renderCostBriefLine(evaluateCostGuard(s, { dailyInputMax: 1e9 }));
  assertIncludes(line, '大头 私聊 8648c1d2 100%');
});

check('12 配置容错：坏值回落默认，字符串 off 算关', () => {
  const bad = normalizeCostGuardConfig({ cacheRateMin: 2, dailyInputMax: 'x', topShareMin: -1, enabled: 'off' });
  assertEqual(bad.cacheRateMin, COST_GUARD_DEFAULTS.cacheRateMin, 'cacheRateMin 未回落');
  assertEqual(bad.dailyInputMax, COST_GUARD_DEFAULTS.dailyInputMax, 'dailyInputMax 未回落');
  assertEqual(bad.topShareMin, COST_GUARD_DEFAULTS.topShareMin, 'topShareMin 未回落');
  assertEqual(bad.enabled, false, 'off 应算关');
  assertEqual(normalizeCostGuardConfig(null).enabled, true, 'null 应默认开');
  assertEqual(normalizeCostGuardConfig({ cacheRateMin: 0.5 }).cacheRateMin, 0.5, '合法值应生效');
});

check('13 长行截断：超过 maxChars 时补省略号', () => {
  const s = summarizeUsageBySession(turns(3), W);
  const line = renderCostBriefLine(evaluateCostGuard(s, { dailyInputMax: 1e9 }), { maxChars: 12 });
  assert(line.length <= 12, `未截断：${line.length}`);
  assert(line.endsWith('…'), `缺省略号：${line}`);
});

check('14 数字与会话标识：compact 三档 + sid 后 8 位 + key 标签', () => {
  assertEqual(formatTokenCount(812), '812');
  assertEqual(formatTokenCount(35_100), '35.1k');
  assertEqual(formatTokenCount(75_700_000), '75.7M');
  assertEqual(sessionTag('session-8648c1d2-486e-4a2f-84eb-04a1b6b50ed0'), '8648c1d2');
  assertEqual(sessionTag(''), '');
  assertEqual(sessionLabel({ key: 'private:1' }), '私聊');
  assertEqual(sessionLabel({ key: 'internal:黑话学习' }), '内部');
  assertEqual(sessionLabel({}), '会话');
});

check('15 简报接线：有 cost 时用成本行替换 token 行，行数不增', () => {
  const entries = turns(3);
  const s = summarizeUsageBySession(entries, W);
  const cost = evaluateCostGuard(s, { dailyInputMax: 1e9 });
  const snap = {
    ok: true,
    at: AT.getTime(),
    services: {
      qqbridge: { alive: true, port: 3100 },
      qqbot: { alive: true },
      phoneBridge: { alive: true, port: 8899 },
      campusNet: { alive: true, logAgeMs: 60_000 },
    },
    today: { qq: { sentOk: 1 }, reminders: { available: true, pending: 0, items: [] } },
  };
  const withCost = renderBrief({ at: AT, snapshot: snap, usage: s, cost, config: { at: '08:00' } });
  assertIncludes(withCost, '💰 成本：');
  assertNotIncludes(withCost, '🔤 token', '有了成本行就不该再出现旧 token 行');
  const legacy = renderBrief({ at: AT, snapshot: snap, usage: s, config: { at: '08:00' } });
  assertIncludes(legacy, '🔤 token：', '没有 cost 时保留旧 token 行（向后兼容）');
  assertEqual(withCost.split('\n').length, legacy.split('\n').length, '替换而非新增行');
});

check('16 简报接线：红色成本项出现在正文里', () => {
  const s = summarizeUsageBySession(turns(10, { hit: 90_000, miss: 10_000 }), W);
  const cost = evaluateCostGuard(s, { dailyInputMax: 1e9 });
  const snap = { ok: true, at: AT.getTime(), services: { qqbridge: { alive: true }, qqbot: { alive: true }, phoneBridge: { alive: true }, campusNet: { alive: true } }, today: { reminders: { available: true, pending: 0, items: [] } } };
  const text = renderBrief({ at: AT, snapshot: snap, cost, config: { at: '08:00' } });
  assertIncludes(text, '❌ 成本：缓存 90.0%<95%');
  assertNotIncludes(text, '#', '成本行也要过 sanitize');
});

check('17 config 接线：normalizeDailyBriefConfig 带出 costGuard', () => {
  const cfg = normalizeDailyBriefConfig({ costGuard: { dailyInputMax: 150_000_000, cacheRateMin: 0.97 } });
  assertEqual(cfg.costGuard.dailyInputMax, 150_000_000, 'dailyInputMax 未接进主配置');
  assertEqual(cfg.costGuard.cacheRateMin, 0.97, 'cacheRateMin 未接进主配置');
  assertEqual(normalizeDailyBriefConfig({}).costGuard.enabled, true, 'costGuard 默认应开');
});

// ── 第 4 条口径：单会话上下文水位（最近一条 turn 采样，不是日累计/历史峰值）──────

/** 造一条「水位 = hit+miss」的采样：cacheHit 直接给水位，miss 0，缓存率恒 100% 免得串味。 */
function sample(watermark, overrides = {}) {
  return turn({ b: { cacheHit: watermark, cacheMiss: 0, cacheWrite: 0, output: 100 }, ...overrides });
}

check('18 默认阈值包含 contextWatermarkMax=120000', () => {
  assertEqual(COST_GUARD_DEFAULTS.contextWatermarkMax, 120_000, '默认水位阈值');
  assertEqual(normalizeCostGuardConfig(undefined).contextWatermarkMax, 120_000, '缺失应回落默认');
  assert(Object.isFrozen(COST_GUARD_DEFAULTS), '默认值应冻结');
});

check('19 水位阈值归一化：合法 / 非法 / 越界 / 缺失', () => {
  assertEqual(normalizeCostGuardConfig({ contextWatermarkMax: 200_000 }).contextWatermarkMax, 200_000, '合法值应生效');
  assertEqual(normalizeCostGuardConfig({ contextWatermarkMax: 180_000.7 }).contextWatermarkMax, 180_001, '应取整');
  assertEqual(normalizeCostGuardConfig({ contextWatermarkMax: 'x' }).contextWatermarkMax, 120_000, '非法应回落');
  assertEqual(normalizeCostGuardConfig({ contextWatermarkMax: 999 }).contextWatermarkMax, 120_000, '低于 1000 应回落');
  assertEqual(normalizeCostGuardConfig({ contextWatermarkMax: 5_000_001 }).contextWatermarkMax, 120_000, '超 5M 应回落');
  assertEqual(normalizeCostGuardConfig({}).contextWatermarkMax, 120_000, '缺失应回落');
});

check('20 水位取最近一条采样，不取历史最大值', () => {
  const early = sample(150_000, { t: AT.getTime() - 3 * HOUR, turn: 1, step: 1, retry: 0 });
  const late = sample(50_000, { t: AT.getTime() - HOUR, turn: 2, step: 1, retry: 0 });
  const s = summarizeUsageBySession([late, early], W); // 故意倒序传入：排序不能靠输入顺序
  assertEqual(s.sessions.length, 1, '会话数');
  assertEqual(s.sessions[0].contextWatermark, 50_000, '应取最近一条 50000，不是最大值 150000');
  assertEqual(s.sessions[0].input, 200_000, '日累计输入仍是两条之和（口径别串）');
  assertEqual(s.maxContextWatermark, 50_000, '顶层水位');
  assertEqual(s.maxContextWatermarkSession, 'private:100000001', '顶层会话 key');
});

check('21 同 sid|turn|step|retry 重复行去重，不重复计数', () => {
  const dup = () => sample(40_000, { turn: 7, step: 2, retry: 0 });
  const s = summarizeUsageBySession([dup(), dup(), dup()], W);
  assertEqual(s.sessions[0].contextWatermark, 40_000, '重复行不该把水位累加');
  assertEqual(s.maxContextWatermark, 40_000, '顶层水位不该累加');
  // 同键重复但 seq 不同：只认排序最靠后的那条（seq 2 覆盖 seq 1）
  const s2 = summarizeUsageBySession([
    sample(90_000, { turn: 8, step: 1, retry: 0, seq: 1 }),
    sample(20_000, { turn: 8, step: 1, retry: 0, seq: 2 }),
  ], W);
  assertEqual(s2.sessions[0].contextWatermark, 20_000, '同键重复应认 seq 更大的那条');
});

check('22 非 turn 记录（base/restart）不影响水位', () => {
  const s = summarizeUsageBySession([
    turn({ k: 'base', b: { cacheHit: 9_000_000, cacheMiss: 1_000_000, cacheWrite: 0, output: 0 } }),
    turn({ k: 'restart', b: { cacheHit: 8_000_000, cacheMiss: 2_000_000, cacheWrite: 0, output: 0 } }),
    sample(30_000),
  ], W);
  assertEqual(s.maxContextWatermark, 30_000, '只看 turn 采样');
  assertEqual(s.sessions[0].contextWatermark, 30_000, '会话水位');
});

check('23 没有任何 turn 记录：水位为 null 且不新增告警', () => {
  const s = summarizeUsageBySession([turn({ k: 'base' }), turn({ k: 'restart' })], W);
  assertEqual(s.sessions.length, 0, '不该有会话');
  assertEqual(s.maxContextWatermark, null, '水位应 null 而不是 0');
  assertEqual(s.maxContextWatermarkSession, null, '会话 key 应 null');
  const r = evaluateCostGuard(s, { contextWatermarkMax: 1_000 });
  assert(!r.reds.some((x) => x.code === 'context-watermark'), '没数据不该报水位红项');
  assertEqual(r.reds.length, 0, '不该有任何红项');
  assertEqual(evaluateCostGuard({}, { contextWatermarkMax: 1_000 }).reds.length, 0, '空 summary 也不该报');
});

check('24 恰好等于阈值必须告警（边界含等号）', () => {
  const s = summarizeUsageBySession([sample(120_000, { turn: 1, step: 1, retry: 0 })], W);
  assertEqual(s.maxContextWatermark, 120_000, '水位');
  const r = evaluateCostGuard(s);
  assertEqual(r.ok, false, '等于阈值应红');
  const red = r.reds.find((x) => x.code === 'context-watermark');
  assert(red, '缺 context-watermark 红项');
  assertEqual(red.value, 120_000, '红项 value');
  assertEqual(red.limit, 120_000, '红项 limit');
  assertIncludes(red.message, '单会话上下文 120.0k', '消息应带人类可读水位');
  assertIncludes(red.message, '（会话 private:100000001）', '消息应带会话 key');
});

check('25 小于阈值不告警，且简报行含人类可读水位', () => {
  const s = summarizeUsageBySession([sample(119_000, { turn: 1, step: 1, retry: 0 })], W);
  const r = evaluateCostGuard(s);
  assertEqual(r.ok, true, '低于阈值不该红');
  assert(!r.reds.some((x) => x.code === 'context-watermark'), '不该有水位红项');
  const line = renderCostBriefLine(r);
  assertIncludes(line, '水位 119.0k', '简报行应带人类可读水位');
  assertNotIncludes(line, '>120.0k', '没红就不该带比较符');
  assert(line.length <= 78, `行太长：${line.length}`);
});

check('26 跨会话：取水位最大的会话（不一定是输入最大的）', () => {
  const chatty = 'session-aaaaaaaa-1111-2222-3333-444444444444';
  const heavy = 'session-bbbbbbbb-1111-2222-3333-444444444444';
  const s = summarizeUsageBySession([
    ...turns(5, { sid: chatty, hit: 50_000, miss: 0 }), // 累计 250k，水位 50k
    sample(200_000, { sid: heavy, key: 'group:123', turn: 1, step: 1, retry: 0 }), // 累计 200k，水位 200k
  ], W);
  assertEqual(s.top.sid, chatty, '输入最大仍是 chatty');
  assertEqual(s.maxContextWatermark, 200_000, '水位最大来自 heavy');
  assertEqual(s.maxContextWatermarkSession, 'group:123', '水位会话 key 应是 group:123');
  const red = evaluateCostGuard(s, { dailyInputMax: 1e9 }).reds.find((x) => x.code === 'context-watermark');
  assert(red, '缺水位红项');
  assertIncludes(red.message, '（会话 group:123）', '消息里的会话标签');
});

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
for (const r of results) {
  if (r.ok) console.log(`ok   ${r.name}`);
  else console.log(`FAIL ${r.name}\n     ${r.error}`);
}
if (failed) {
  console.log(`FAIL：${passed} 项通过，${failed} 项失败`);
  process.exit(1);
}
console.log(`PASS：${passed} 项通过，0 项失败`);
