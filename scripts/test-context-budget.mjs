// 上下文水位守门的离线单测：只测纯函数，不碰文件/网络/QQ。
//   node scripts/test-context-budget.mjs
// 期望最后一行：PASS：N 项通过，0 项失败
import {
  CONTEXT_BUDGET_DEFAULTS,
  normalizeContextBudgetConfig,
  classifyContextWatermark,
  formatContextWatermark,
  renderBudgetLogLine,
  shouldRequestHandoff,
} from '../src/context-budget.mjs';

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

const ON = { enabled: true, softAt: 60000, hardAt: 120000 };

check('1 默认值完整且被冻结', () => {
  assert(Object.isFrozen(CONTEXT_BUDGET_DEFAULTS), '默认配置必须 Object.freeze');
  assertEqual(CONTEXT_BUDGET_DEFAULTS.enabled, false, 'enabled 默认必须关闭（影子优先）');
  assertEqual(CONTEXT_BUDGET_DEFAULTS.mode, 'shadow', 'mode 默认 shadow');
  assertEqual(CONTEXT_BUDGET_DEFAULTS.softAt, 60000, 'softAt 默认 60000');
  assertEqual(CONTEXT_BUDGET_DEFAULTS.hardAt, 120000, 'hardAt 默认 120000');
  assertEqual(CONTEXT_BUDGET_DEFAULTS.handoffTokenBudget, 600, 'handoffTokenBudget 默认 600');
  let threw = false;
  try {
    CONTEXT_BUDGET_DEFAULTS.enabled = true;
  } catch {
    threw = true;
  }
  assert(threw || CONTEXT_BUDGET_DEFAULTS.enabled === false, '默认值必须不可被改写');
});

check('2 normalize：null/undefined/字符串/数组/数字都不抛异常并回落默认', () => {
  for (const raw of [null, undefined, 'nope', 42, true, [], [{ enabled: true }], () => {}]) {
    const cfg = normalizeContextBudgetConfig(raw);
    assertEqual(cfg.enabled, false, `脏输入 ${String(raw)} 的 enabled 应关闭`);
    assertEqual(cfg.mode, 'shadow', `脏输入 ${String(raw)} 的 mode 应 shadow`);
    assertEqual(cfg.softAt, 60000, `脏输入 ${String(raw)} 的 softAt 应默认`);
    assertEqual(cfg.hardAt, 120000, `脏输入 ${String(raw)} 的 hardAt 应默认`);
    assertEqual(cfg.handoffTokenBudget, 600, `脏输入 ${String(raw)} 的 handoffTokenBudget 应默认`);
  }
});

check('3 normalize：enabled 只有严格 true 才开启', () => {
  assertEqual(normalizeContextBudgetConfig({ enabled: true }).enabled, true, 'true 应开启');
  for (const value of ['true', 1, {}, [], 'yes', false, null]) {
    assertEqual(normalizeContextBudgetConfig({ enabled: value }).enabled, false, `enabled=${String(value)} 应关闭`);
  }
});

check('4 normalize：mode 只认字面量 enforce，其余一律 shadow', () => {
  assertEqual(normalizeContextBudgetConfig({ mode: 'enforce' }).mode, 'enforce', 'enforce 应保留');
  for (const value of ['ENFORCE', 'shadow', 'on', true, 1, null, undefined]) {
    assertEqual(normalizeContextBudgetConfig({ mode: value }).mode, 'shadow', `mode=${String(value)} 应 shadow`);
  }
});

check('5 normalize：softAt 四舍五入并在合法区间内保留', () => {
  assertEqual(normalizeContextBudgetConfig({ softAt: 60000.6 }).softAt, 60001, 'softAt 应 Math.round');
  assertEqual(normalizeContextBudgetConfig({ softAt: 60000.4 }).softAt, 60000, 'softAt 应向下取整到 60000');
  assertEqual(normalizeContextBudgetConfig({ softAt: 1000 }).softAt, 1000, '下边界 1000 应保留');
  assertEqual(normalizeContextBudgetConfig({ softAt: 2000000, hardAt: 2000000 }).softAt, 2000000, '上边界 2000000 应保留');
});

check('6 normalize：softAt 越界或非数字回落 60000', () => {
  for (const value of [999, 0, -1, 2000001, NaN, Infinity, '62000', null]) {
    assertEqual(normalizeContextBudgetConfig({ softAt: value }).softAt, 60000, `softAt=${String(value)} 应回落`);
  }
});

check('7 normalize：hardAt 默认 120000，越界回落', () => {
  assertEqual(normalizeContextBudgetConfig({}).hardAt, 120000, 'hardAt 默认 120000');
  for (const value of [999, 2000001, NaN, -5, '120000']) {
    assertEqual(normalizeContextBudgetConfig({ hardAt: value }).hardAt, 120000, `hardAt=${String(value)} 应回落`);
  }
  assertEqual(normalizeContextBudgetConfig({ hardAt: 120000.6 }).hardAt, 120001, 'hardAt 应 Math.round');
});

check('8 normalize：hardAt 不高于 softAt 时顺延 +1000', () => {
  const cfg = normalizeContextBudgetConfig({ softAt: 130000, hardAt: 120000 });
  assertEqual(cfg.softAt, 130000, 'softAt 不应被改动');
  assertEqual(cfg.hardAt, 131000, 'hardAt 应修正为 softAt + 1000');
});

check('9 normalize：hardAt 等于 softAt 时也要顺延', () => {
  const cfg = normalizeContextBudgetConfig({ softAt: 60000, hardAt: 60000 });
  assertEqual(cfg.hardAt, 61000, '相等时 hardAt 应修正为 61000');
  assert(cfg.hardAt > cfg.softAt, '归一化后必须 hardAt > softAt');
});

check('10 normalize：handoffTokenBudget 区间 100–4000 且取整', () => {
  assertEqual(normalizeContextBudgetConfig({}).handoffTokenBudget, 600, '默认 600');
  assertEqual(normalizeContextBudgetConfig({ handoffTokenBudget: 600.6 }).handoffTokenBudget, 601, '应 Math.round');
  assertEqual(normalizeContextBudgetConfig({ handoffTokenBudget: 100 }).handoffTokenBudget, 100, '下边界保留');
  assertEqual(normalizeContextBudgetConfig({ handoffTokenBudget: 4000 }).handoffTokenBudget, 4000, '上边界保留');
  for (const value of [99, 4001, 0, -100, NaN, '600']) {
    assertEqual(normalizeContextBudgetConfig({ handoffTokenBudget: value }).handoffTokenBudget, 600, `handoffTokenBudget=${String(value)} 应回落`);
  }
});

check('11 classify：config 为 null/undefined 或 enabled=false 时一律 ok', () => {
  assertEqual(classifyContextWatermark(999999, null), 'ok', 'null config 应 ok');
  assertEqual(classifyContextWatermark(999999, undefined), 'ok', 'undefined config 应 ok');
  assertEqual(classifyContextWatermark(999999, { enabled: false, softAt: 1000, hardAt: 2000 }), 'ok', '关闭后应 ok');
  assertEqual(classifyContextWatermark(null, { enabled: false }), 'ok', '关闭时缺失水位也不该报 unknown');
  assertEqual(classifyContextWatermark(0, { enabled: false }), 'ok', '关闭时 0 也应 ok');
});

check('12 classify：缺失/非法水位返回 unknown，绝不按 0 处理', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, '62000', {}, [], false]) {
    assertEqual(classifyContextWatermark(value, ON), 'unknown', `水位 ${String(value)} 应为 unknown`);
  }
});

check('13 classify：水位 < softAt 为 ok，等号边界为 soft', () => {
  assertEqual(classifyContextWatermark(59999, ON), 'ok', '59999 应 ok');
  assertEqual(classifyContextWatermark(0, ON), 'ok', '0 应 ok');
  assertEqual(classifyContextWatermark(60000, ON), 'soft', '硬等 softAt 应为 soft');
});

check('14 classify：hardAt-1 为 soft，硬等 hardAt 为 hard', () => {
  assertEqual(classifyContextWatermark(119999, ON), 'soft', 'hardAt-1 应为 soft');
  assertEqual(classifyContextWatermark(120000, ON), 'hard', '硬等 hardAt 应为 hard');
  assertEqual(classifyContextWatermark(301000, ON), 'hard', '301K 应为 hard');
});

check('15 classify：config 缺阈值时使用 60K/120K 默认水位', () => {
  assertEqual(classifyContextWatermark(59999, { enabled: true }), 'ok', '默认 softAt 生效');
  assertEqual(classifyContextWatermark(62000, { enabled: true }), 'soft', '默认 softAt 生效');
  assertEqual(classifyContextWatermark(120000, { enabled: true }), 'hard', '默认 hardAt 生效');
});

check('16 classify：阈值倒挂时按 softAt + 1000 兜底分类', () => {
  const cfg = { enabled: true, softAt: 130000, hardAt: 120000 };
  assertEqual(classifyContextWatermark(125000, cfg), 'ok', '低于修正后的 softAt 应 ok');
  assertEqual(classifyContextWatermark(130000, cfg), 'soft', '等 softAt 应 soft');
  assertEqual(classifyContextWatermark(131000, cfg), 'hard', '等修正后的 hardAt 应 hard');
});

check('17 format：< 1000 输出原样整数，非法值输出长破折号', () => {
  assertEqual(formatContextWatermark(999), '999', '999 应原样');
  assertEqual(formatContextWatermark(0), '0', '0 应原样');
  for (const value of [-1, NaN, Infinity, -Infinity, '62000', null, undefined]) {
    assertEqual(formatContextWatermark(value), '—', `${String(value)} 应输出长破折号`);
  }
});

check('18 format：K 分支保留 1 位小数并去掉 .0', () => {
  assertEqual(formatContextWatermark(1000), '1K', '1000 -> 1K');
  assertEqual(formatContextWatermark(1500), '1.5K', '1500 -> 1.5K');
  assertEqual(formatContextWatermark(62000), '62K', '62000 -> 62K');
  assertEqual(formatContextWatermark(999999), '1000K', '999999 走 K 分支');
});

check('19 format：M 分支保留 1 位小数并去掉 .0', () => {
  assertEqual(formatContextWatermark(1000000), '1M', '1e6 -> 1M');
  assertEqual(formatContextWatermark(1234567), '1.2M', '1234567 -> 1.2M');
  assertEqual(formatContextWatermark(1500000), '1.5M', '1.5e6 -> 1.5M');
});

check('20 render：基础软水位行', () => {
  assertEqual(
    renderBudgetLogLine({ watermark: 62000, level: 'soft' }),
    '[budget] 上下文 62K（soft）',
    '软水位日志行格式',
  );
});

check('21 render：key 非空时追加 key= 段', () => {
  assertEqual(
    renderBudgetLogLine({ watermark: 62000, level: 'soft', key: 'group:123' }),
    '[budget] 上下文 62K（soft） key=group:123',
    '带 key 的日志行格式',
  );
  assertNotIncludes(
    renderBudgetLogLine({ watermark: 62000, level: 'soft', key: '' }),
    'key=',
    '空 key 不应产生 key= 段',
  );
});

check('22 render：unknown 时不渲染数字', () => {
  assertEqual(
    renderBudgetLogLine({ watermark: undefined, level: 'unknown' }),
    '[budget] 上下文未知（unknown）',
    '未知水位日志行格式',
  );
  assertNotIncludes(
    renderBudgetLogLine({ watermark: 62000, level: 'unknown' }),
    '62K',
    'unknown 不应带出水位数字',
  );
});

check('23 shouldRequestHandoff：只有 hard + enforce 为 true', () => {
  assertEqual(shouldRequestHandoff('hard', { mode: 'enforce' }), true, 'hard + enforce 应请求交接');
  assertEqual(shouldRequestHandoff('hard', { mode: 'shadow' }), false, 'shadow 不应请求交接');
  assertEqual(shouldRequestHandoff('hard', { enabled: true }), false, '缺 mode 不应请求交接');
  assertEqual(shouldRequestHandoff('hard', null), false, 'null config 不应请求交接');
  assertEqual(shouldRequestHandoff('hard', undefined), false, 'undefined config 不应请求交接');
});

check('24 shouldRequestHandoff：soft/unknown/ok 一律不请求交接', () => {
  for (const level of ['soft', 'unknown', 'ok', '', null, undefined]) {
    assertEqual(shouldRequestHandoff(level, { mode: 'enforce' }), false, `${String(level)} 不应请求交接`);
  }
});

check('25 集成：normalize → classify → render 全链路', () => {
  const cfg = normalizeContextBudgetConfig({ enabled: true, mode: 'enforce', softAt: 60000, hardAt: 120000 });
  const level = classifyContextWatermark(121000, cfg);
  assertEqual(level, 'hard', '121K 应判 hard');
  assertEqual(renderBudgetLogLine({ watermark: 121000, level, key: 'private:100000001' }), '[budget] 上下文 121K（hard） key=private:100000001', 'hard 日志行');
  assertEqual(shouldRequestHandoff(level, cfg), true, 'enforce 下 hard 应请求交接');
});

check('26 回滚：默认配置下任何水位都不产生 soft/hard 噪音', () => {
  const cfg = normalizeContextBudgetConfig({});
  for (const value of [0, 59999, 62000, 120000, 301000]) {
    assertEqual(classifyContextWatermark(value, cfg), 'ok', `默认关闭时 ${value} 应 ok`);
  }
  assertEqual(shouldRequestHandoff('hard', cfg), false, '默认配置不应请求交接');
});

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
for (const r of results) {
  if (r.ok) console.log(`ok   ${r.name}`);
  else console.log(`FAIL ${r.name}\n     ${r.error}`);
}
check('缺省 enabled 视为关闭（与 normalize 同语义）', () => { assertEqual(classifyContextWatermark(500000, { softAt: 1000, hardAt: 2000 }), 'ok'); });
if (failed) {
  console.log(`FAIL：${passed} 项通过，${failed} 项失败`);
  process.exitCode = 1;
} else {
  console.log(`PASS：${passed} 项通过，0 项失败`);
}
