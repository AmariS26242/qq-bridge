// 服务健康时序的离线单测：只测纯逻辑，不碰网络/文件/QQ。
//   node scripts/test-health.mjs
// 期望最后一行：PASS：N 项通过，0 项失败
import { renderBrief, normalizeDailyBriefConfig } from '../src/daily-brief.mjs';
import { renderWeeklyReport } from '../src/weekly-report.mjs';
import {
  HEALTH_SERVICES,
  serializeProbe,
  parseProbe,
  countSamples,
  summarizeHealth,
  renderHealthBriefSuffix,
  renderUptimeLine,
  formatDownWindows,
  linkState,
} from '../src/health.mjs';

const AT = new Date(2026, 9, 24, 8, 0, 0);
const MIN = 60_000;
const T0 = AT.getTime() - 24 * 60 * MIN;
const results = [];

function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error?.message ?? error) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(actual, expected, msg) {
  assert(actual === expected, `${msg || '值不相等'}：实际「${actual}」期望「${expected}」`);
}
function assertIncludes(hay, needle, msg) {
  assert(String(hay).includes(needle), msg || `缺少「${needle}」：\n${hay}`);
}
function assertNotIncludes(hay, needle, msg) {
  assert(!String(hay).includes(needle), msg || `不该出现「${needle}」：\n${hay}`);
}

/** 第 n 个采样点（间隔 5 分钟，从 T0 起）。 */
const at = (n) => T0 + n * 5 * MIN;
const probe = (n, states) => ({ t: at(n), states });

/** 一根典型的「掉了 15 分钟」曲线：3 up → 3 down → 2 up。 */
function typicalEntries() {
  return [
    probe(0, { q: 1, b: 1, p: -1, c: 0 }),
    probe(1, { q: 1, b: 1, p: -1, c: 0 }),
    probe(2, { q: 1, b: 1, p: 1, c: 1 }),
    probe(3, { q: 0, b: 1, p: 1, c: 1 }),
    probe(4, { q: 0, b: 1, p: 1, c: 1 }),
    probe(5, { q: 0, b: 1, p: 1, c: 1 }),
    probe(6, { q: 1, b: 1, p: 1, c: 1 }),
    probe(7, { q: 1, b: 1, p: 1, c: 1 }),
  ];
}

check('1 行格式：单行 <100 B，键固定、值三态', () => {
  const line = serializeProbe({ q: 1, b: false, p: true, c: undefined }, 1_792_824_937_902);
  assertEqual(line, '{"t":1792824937902,"q":1,"b":0,"p":1,"c":-1}', '序列化结果');
  assert(Buffer.byteLength(line) < 100, `行太长：${Buffer.byteLength(line)} B`);
});

check('2 解析：字符串与对象都吃，坏行返回 null', () => {
  const s = parseProbe('{"t":1000,"q":1,"b":0,"p":-1,"c":1}');
  assertEqual(s.t, 1000, 't');
  assertEqual(s.states.q, 1, 'q');
  assertEqual(s.states.b, 0, 'b');
  assertEqual(s.states.c, 1, 'c');
  const o = parseProbe({ t: 2000, q: '1', b: '0', c: null });
  assertEqual(o.states.q, 1, '字符串 1');
  assertEqual(o.states.b, 0, '字符串 0');
  assertEqual(o.states.c, -1, 'null → unknown');
  assertEqual(o.states.p, -1, '缺键 → unknown');
  for (const bad of ['', '{', 'null', '[]', '{"t":0,"q":1}', { t: 'x' }]) {
    assertEqual(parseProbe(bad), null, `坏行应 null：${JSON.stringify(bad)}`);
  }
});

check('3 汇总：抖动只数下降沿、区间按时长算、unknown 不进分母', () => {
  const s = summarizeHealth(typicalEntries());
  const q = s.services.find((x) => x.key === 'q');
  assertEqual(q.samples, 8, 'q 采样数（unknown 不算）');
  assertEqual(q.up, 5, 'q up');
  assertEqual(q.down, 3, 'q down');
  assertEqual(q.flaps, 1, 'q 只算 1 次抖动，不是 3 次');
  assertEqual(q.uptime, 5 / 8, 'q 可用率');
  assertEqual(s.flaps, 1, '总抖动次数');
  assertEqual(s.windows.length, 2, '掉线区间数（q 一段 + c 开局那段）');
  const qw = s.windows.find((w) => w.key === 'q');
  assertEqual(qw.minutes, 15, 'q 区间时长（3 个 5 分钟间隔）');

  const c = s.services.find((x) => x.key === 'c');
  assertEqual(c.flaps, 0, '开局就在挂：没有下降沿，不算抖动');
  assertEqual(c.down, 2, 'c down');
  assertEqual(c.uptime, 6 / 8, 'c 可用率');

  const p = s.services.find((x) => x.key === 'p');
  assertEqual(p.samples, 6, 'p unknown 不进分母');
  assertEqual(p.unknown, 2, 'p unknown 计数');
  assertEqual(p.uptime, 1, 'p 可用率 100%');
});

check('4 汇总：窗口外样本被剔除、空数据不炸', () => {
  const entries = [...typicalEntries(), probe(99, { q: 0, b: 1, p: 1, c: 1 })];
  const s = summarizeHealth(entries, { from: T0, to: at(7) });
  assertEqual(s.samples, 8, '窗口外样本应剔除');
  assertEqual(s.flaps, 1, '窗外那次 down 不该算进抖动');
  for (const bad of [undefined, null, [], [null, 3], [{ t: 'x' }]]) {
    const e = summarizeHealth(bad);
    assertEqual(e.samples, 0, '空数据 samples=0');
    assertEqual(e.flaps, 0, '空数据 flaps=0');
    assertEqual(renderHealthBriefSuffix(e), null, '空数据不出后缀');
    assertEqual(renderUptimeLine(e), null, '空数据不出可用率行');
  }
});

check('5 窗口末尾仍挂着：openNow=true，区间截止到最后一个 down', () => {
  const s = summarizeHealth([
    probe(0, { q: 1, b: 1, p: 1, c: 1 }),
    probe(1, { q: 0, b: 1, p: 1, c: 1 }),
    probe(2, { q: 0, b: 1, p: 1, c: 1 }),
  ]);
  const q = s.services.find((x) => x.key === 'q');
  assertEqual(q.flaps, 1, '抖动 1 次');
  assertEqual(q.openNow, true, '仍在挂着');
  assertEqual(s.windows.length, 1, '区间数');
  assertEqual(s.windows[0].minutes, 5, '起止两个采样点之间 5 分钟');
});

check('6 简报后缀：0 次/多次/无采样三种', () => {
  assertEqual(renderHealthBriefSuffix(summarizeHealth(typicalEntries())), '（24h 抖动 1 次）', '抖动后缀');
  const calm = summarizeHealth([probe(0, { q: 1, b: 1, p: 1, c: 1 }), probe(1, { q: 1, b: 1, p: 1, c: 1 })]);
  assertEqual(renderHealthBriefSuffix(calm), '（24h 无抖动）', '无抖动后缀');
  assertEqual(renderHealthBriefSuffix(calm, { windowHours: 12 }), '（12h 无抖动）', '窗口可配');
});

check('7 周报可用率行：格式、跳过零采样服务、截断', () => {
  const s = summarizeHealth(typicalEntries());
  const line = renderUptimeLine(s);
  assertEqual(line, '📈 可用率：QQ桥 62.5% · bot 100% · 手机桥 100% · 校园网 75.0%（抖动 1 次）', '可用率行');
  const one = summarizeHealth([probe(0, { q: 1, b: -1, p: -1, c: -1 }), probe(1, { q: 1, b: -1, p: -1, c: -1 })]);
  assertEqual(renderUptimeLine(one), '📈 可用率：QQ桥 100%（无抖动）', '零采样服务不出现');
  const long = renderUptimeLine(s, { maxChars: 10 });
  assert(long.length <= 10 && long.endsWith('…'), `截断不对：${long}`);
});

check('8 掉线区间 → 人读文本', () => {
  const s = summarizeHealth(typicalEntries());
  const lines = formatDownWindows(s);
  assertEqual(lines.length, 2, 'q 与 c 各一段');
  assert(lines.some((l) => /^QQ桥 \d{2}:\d{2} 起 约 15 分钟$/.test(l)), `区间文本不对：${lines.join(' | ')}`);
  assertEqual(formatDownWindows(summarizeHealth([])).length, 0, '无数据不出行');
});

check('9 countSamples 按窗口数采样', () => {
  const e = typicalEntries();
  assertEqual(countSamples(e, { from: T0, to: at(3) }), 4, '含两端');
  assertEqual(countSamples(e, { from: at(10) }), 0, '全在窗外');
  assertEqual(countSamples(null), 0, '空输入');
});

check('10 简报接线：服务行后缀、无 health 时不加', () => {
  const snap = {
    ok: true,
    at: AT.getTime(),
    services: { qqbridge: { alive: true }, qqbot: { alive: true }, phoneBridge: { alive: true }, campusNet: { alive: true } },
    today: { reminders: { available: true, pending: 0, items: [] } },
  };
  const withHealth = renderBrief({ at: AT, snapshot: snap, health: summarizeHealth(typicalEntries()), config: { at: '08:00' } });
  assertIncludes(withHealth, '✅ 服务：全部正常（24h 抖动 1 次）');
  const without = renderBrief({ at: AT, snapshot: snap, config: { at: '08:00' } });
  assertIncludes(without, '✅ 服务：全部正常\n', '没有 health 时服务行保持原样');
  assertNotIncludes(without, '抖动', '没有 health 时不该出现抖动字样');
  const calendar = normalizeDailyBriefConfig({});
  assertEqual(calendar.maxLines, 9, 'maxLines 默认不变');
});

check('11 周报接线：可用率行在收尾之前、超行数不被吃掉', () => {
  const health = summarizeHealth(typicalEntries());
  const text = renderWeeklyReport({
    at: AT,
    turns: { turns: 10, input: 1e6, output: 1000, cacheRate: 0.99, sessionCount: 2 },
    doctor: { runs: 3, redRuns: 0, topRed: [] },
    health,
    items: [
      { heading: '二、第二梯队', text: '服务健康时序', done: false, file: 'x.md' },
      { heading: '二、第二梯队', text: '成本守门', done: true, file: 'x.md' },
    ],
    prevChecked: ['其他.md|旧条目'],
    config: { at: '20:00' },
  });
  assertIncludes(text, '📈 可用率：QQ桥 62.5%');
  assertIncludes(text, '✅ 收尾：本周完成 1 项');
  assert(text.indexOf('📈 可用率') < text.indexOf('✅ 收尾'), '可用率应在收尾之前');
  const noHealth = renderWeeklyReport({ at: AT, turns: { turns: 1, input: 10, output: 1, cacheRate: 1, sessionCount: 1 }, config: { at: '20:00' } });
  assertNotIncludes(noHealth, '📈 可用率', '没有 health 时周报不该凭空多一行');
});

check('12 服务清单与端口：4 项固定、3 个端口 + 校园网走日志', () => {
  assertEqual(HEALTH_SERVICES.length, 4, '服务数');
  assertEqual(HEALTH_SERVICES.map((s) => s.key).join(''), 'qbpc', '键顺序');
  assertEqual(HEALTH_SERVICES.find((s) => s.key === 'q').port, 3100, 'QQ桥端口');
  assertEqual(HEALTH_SERVICES.find((s) => s.key === 'c').port, null, '校园网无端口');
});

// ── linkState：端口通 ≠ 消息通（2026-10-24 事故的教训） ──────────────────────
check('linkState：拿不到 status 记 unknown', () => {
  assertEqual(linkState(null).state, 'unknown');
  assertEqual(linkState({}).state, 'unknown');
});

check('linkState：connected=false 记 down', () => {
  const r = linkState({ snowluma: { connected: false, accountOnline: true, good: true } });
  assertEqual(r.state, 'down');
  assertIncludes(r.reason, 'WS 未连接');
});

check('linkState：连上且有心跳记 up', () => {
  const r = linkState({ snowluma: { connected: true, good: true, goodSource: 'heartbeat', lastPacketAgoMs: 17_000 } });
  assertEqual(r.state, 'up');
  assertIncludes(r.reason, 'heartbeat');
});

check('linkState：连上但长期没事件也记 down', () => {
  const r = linkState({ snowluma: { connected: true, good: true, lastPacketAgoMs: 10 * 60_000 } });
  assertEqual(r.state, 'down');
  assertIncludes(r.reason, '600s');
});

check('linkState：good=false 记 down', () => {
  const r = linkState({ snowluma: { connected: true, good: false, lastPacketAgoMs: 1_000 } });
  assertEqual(r.state, 'down');
  assertIncludes(r.reason, 'good=false');
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
