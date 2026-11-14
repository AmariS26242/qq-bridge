// 统一优化面板（A1）纯函数回归测试：不依赖 SnowLuma / DSH / QQ，也不读 state/。
// 用法：node scripts/test-ops-panel.mjs
import fs from 'node:fs';
import {
  OPS_DEFAULTS,
  buildOpsPanel,
  clampWindowDays,
  parseTokenRows,
  percentile,
  startOfLocalDay,
  maskSessionKey,
  summarizeBudget,
  summarizeWait,
  summarizeStyle,
  summarizeTurns,
  watermarkOf
} from '../src/ops-panel.js';

let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};
const has = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
};

const NOW = new Date('2026-10-26T12:00:00+08:00').getTime();
const DAY = 86_400_000;

/** 构造一条 turn 采样行（默认落在「今天」中午）。 */
function row(o = {}) {
  const buckets = {
    cacheMiss: o.miss ?? 0,
    cacheHit: o.hit ?? 0,
    cacheWrite: o.write ?? 0,
    output: o.output ?? 0,
    reasoning: 0
  };
  return {
    k: 'turn',
    t: o.t ?? NOW,
    sid: o.sid ?? 'session-a',
    key: 'private:<uid>',
    seq: o.seq ?? 1,
    turn: o.turn ?? 1,
    step: o.step ?? 1,
    retry: o.retry ?? 0,
    model: 'deepseek-flash',
    provider: 'deepseek-official',
    b: buckets
  };
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

// ── A. 解析与去重 ─────────────────────────────────────────────────────────
eq('水位 = cacheMiss + cacheHit + cacheWrite（与账本 inputTokens 同口径）', watermarkOf({ cacheMiss: 241, cacheHit: 354_048, cacheWrite: 1_000 }), 355_289);
eq('没有 cacheWrite 字段时按 0 计', watermarkOf({ cacheMiss: 0, cacheHit: 10 }), 10);
eq('水位容忍空桶', watermarkOf(null), 0);

{
  const text = jsonl([
    { ...row({ turn: 1 }), k: 'base' },
    { ...row({ turn: 2 }), k: 'base' }
  ]);
  eq('base 行被全部忽略', parseTokenRows(text).length, 0);
}
{
  const text = [
    'not json',
    '',
    JSON.stringify(row({ turn: 1, output: 5, t: NOW - 1000 })),
    JSON.stringify(row({ turn: 2, output: 6 }))
  ].join('\n');
  eq('坏行被跳过、好行保留', parseTokenRows(text).length, 2);
}
eq('空文本 → 空数组', parseTokenRows(''), []);
eq('非字符串入参 → 空数组', parseTokenRows(null), []);
{
  // 同一 (sid|turn|step|retry) 后到覆盖先到：t 更大的那条胜出。
  const later = row({ turn: 3, step: 1, retry: 0, output: 99, t: NOW + 5, seq: 9 });
  const earlier = row({ turn: 3, step: 1, retry: 0, output: 1, t: NOW, seq: 2 });
  const parsed = parseTokenRows(jsonl([later, earlier]));
  eq('同键去重只留一条', parsed.length, 1);
  eq('同键取更晚的采样', parsed[0].b.output, 99);
}
{
  // retry 轴不同 → 两条都要留（重试的第二次请求另算一次）。
  const parsed = parseTokenRows(jsonl([
    row({ turn: 3, step: 2, retry: 0, output: 10 }),
    row({ turn: 3, step: 2, retry: 1, output: 20 })
  ]));
  eq('retry 不同不合并', parsed.length, 2);
  eq('解析结果按时间升序', parsed.map((r) => r.b.output).sort((a, b) => a - b), [10, 20]);
}

// ── B. 百分位 ─────────────────────────────────────────────────────────────
eq('空数组百分位为 0', percentile([], 0.5), 0);
eq('p50 最近秩（4 个样本取第 2 个）', percentile([10, 20, 30, 40], 0.5), 20);
eq('p90 夹到最大值', percentile([10, 20, 30, 40], 0.9), 40);
eq('单样本各档相同', percentile([7], 0.99), 7);
eq('非法 p 夹到 [0,1]', percentile([1, 2, 3], 2), 3);

// ── C. 窗口与日桶 ─────────────────────────────────────────────────────────
eq('非法窗口回落默认值', clampWindowDays('abc'), OPS_DEFAULTS.windowDays);
eq('窗口 0 回落默认值', clampWindowDays(0), OPS_DEFAULTS.windowDays);
eq('窗口夹到上限', clampWindowDays(999), OPS_DEFAULTS.maxWindowDays);
eq('今日零点稳定', startOfLocalDay(NOW), new Date('2026-10-26T00:00:00+08:00').getTime());

{
  const rows = [
    row({ t: NOW, turn: 1, miss: 100, hit: 900, output: 30 }),
    row({ t: NOW, turn: 2, miss: 200, hit: 800, output: 0 }),
    row({ t: NOW - 10 * DAY, turn: 3, miss: 500, hit: 500, output: 10 })
  ];
  const out = summarizeTurns(rows, { now: NOW, windowDays: 7 });
  eq('窗口外采样被排除', out.steps, 2);
  eq('单步水位合计', out.days.reduce((s, d) => s + d.input, 0), 2000);
  eq('步数合计', out.days.reduce((s, d) => s + d.steps, 0), 2);
  eq('输出 token 合计', out.days.reduce((s, d) => s + d.output, 0), 30);
  eq('轮数 = sid+turn 去重', out.turns, 2);
  eq('零输出轮计数', out.silent.zero, 1);
  eq('近零输出轮含 0', out.silent.nearZero, 1);
  eq('零输出轮占比', out.silent.zeroRatio, 0.5);
}
{
  // 一步吐 3 个 token（[SILENT]）算近零但不算零。
  const out = summarizeTurns([row({ output: 3 })], { now: NOW, nearZeroOutputTokens: 8 });
  eq('3 token 不算零输出', out.silent.zero, 0);
  eq('3 token 算近零输出', out.silent.nearZero, 1);
}
{
  // 同一轮两步都无输出 → 只算一轮。
  const out = summarizeTurns([
    row({ turn: 1, step: 1, output: 0 }),
    row({ turn: 1, step: 2, output: 0 })
  ], { now: NOW });
  eq('同一轮多步只算一轮', out.turns, 1);
  eq('同一轮多步输出求和', out.silent.zero, 1);
}
{
  const out = summarizeTurns([], { now: NOW });
  eq('无采样时步数为 0', out.step.count, 0);
  eq('无采样时百分比不除零', out.silent.zeroRatio, 0);
  eq('无采样时 p99 为 0', out.step.p99, 0);
}

// ── D. 风格侧窗口聚合 ─────────────────────────────────────────────────────
{
  const stats = {
    version: 1,
    updatedAt: NOW,
    days: {
      '2026-10-26': {
        date: '2026-10-26', turns: 10, changed: 4, heavy: 1, fallback: 2, keepRaw: 1, nudge: 1, skip: 0, off: 0,
        rawChars: 1000, cleanedChars: 800,
        rules: { 'hope-helpful-2': 3, 'agree-opener': 1 }
      },
      '2026-10-25': {
        date: '2026-10-25', turns: 5, changed: 1, heavy: 0, fallback: 0, keepRaw: 0, nudge: 0, skip: 1, off: 0,
        rawChars: 500, cleanedChars: 500,
        rules: { 'agree-opener': 5 }
      },
      '2026-09-01': {
        date: '2026-09-01', turns: 99, changed: 99, heavy: 0, fallback: 0, keepRaw: 0, nudge: 0, skip: 0, off: 0,
        rawChars: 1, cleanedChars: 1,
        rules: { 'old-rule': 50 }
      }
    }
  };
  const out = summarizeStyle(stats, { now: NOW, windowDays: 7 });
  eq('风格窗口排除过期日期桶', out.turns, 15);
  eq('风格窗口字符合计', out.rawChars, 1500);
  eq('规则命中合计', out.hitTotal, 9);
  eq('Top1 规则按命中次数排序', out.topRules[0], { id: 'agree-opener', count: 6, share: 0.6667 });
  eq('过期规则不进 Top', out.topRules.some((r) => r.id === 'old-rule'), false);
  eq('删空比例（(1500-1300)/1500）', out.removedRatio, 0.1333);
  eq('改写率（5/15）', out.changedRate, 0.3333);
  eq('兜底率（2/15）', out.fallbackRate, 0.1333);
}
{
  const out = summarizeStyle(null, { now: NOW });
  eq('空统计不崩', out.turns, 0);
  eq('空统计 Top 为空', out.topRules, []);
}

// ── E. 面板整体 ───────────────────────────────────────────────────────────
{
  const rows = [
    row({ turn: 1, miss: 241, hit: 354_048, output: 4 }),
    row({ turn: 2, miss: 300, hit: 400_000, output: 120 })
  ];
  const stats = {
    version: 1,
    days: { '2026-10-26': { date: '2026-10-26', turns: 3, changed: 1, heavy: 0, fallback: 1, keepRaw: 0, nudge: 1, skip: 0, off: 0, rawChars: 60, cleanedChars: 50, rules: { 'hope-helpful-2': 1, fallback: 1 } } }
  };
  const panel = buildOpsPanel({ aiToneStats: stats, rows, now: NOW, windowDays: 7 });
  has('面板返回 ok', panel.ok === true);
  eq('面板版本号', panel.version, 1);
  eq('窗口天数', panel.window.days, 7);
  eq('问题 1：单步水位中位数', panel.questions.stepWatermark.p50, 354_289);
  eq('问题 1：单步水位最大值', panel.questions.stepWatermark.max, 400_300);
  eq('问题 2：日累计输入', panel.questions.dailyInput.reduce((s, d) => s + d.input, 0), 754_589);
  // 并列时按 id 升序（fallback 在 hope-helpful-2 之前），所以断言「在 Top 里」而不是「排第一」。
  has('问题 3：Top 规则含 hope-helpful-2', panel.questions.topRules.some((r) => r.id === 'hope-helpful-2'));
  eq('问题 3：并列按 id 升序', panel.questions.topRules.map((r) => r.id), ['fallback', 'hope-helpful-2']);
  eq('问题 4：删空/兜底计数', panel.questions.deletions.fallback, 1);
  eq('问题 5：近零输出轮', panel.questions.silentRate.nearZero, 1);
  has('面板非空标记', panel.empty === false);

  // 同日重跑必须逐字节一致（面板上「今天」的数字不能每次刷新都变）。
  const again = buildOpsPanel({ aiToneStats: stats, rows, now: NOW, windowDays: 7 });
  eq('同日重跑结果稳定', JSON.stringify(again), JSON.stringify(panel));
}
{
  const panel = buildOpsPanel({ now: NOW });
  eq('全空面板标记 empty', panel.empty, true);
  eq('全空面板日累计为空数组', panel.questions.dailyInput, []);
  eq('全空面板删空计数为 0', panel.questions.deletions.turns, 0);
}

{
  // C3 观察窗口：会话键脱敏 + 水位分级
  eq('脱敏 private 键', maskSessionKey('private:100000001'), 'private:1000***001');
  eq('脱敏 group 键', maskSessionKey('group:1122334455'), 'group:1122***455');
  eq('短键原样', maskSessionKey('group:1122'), 'group:1122');
  eq('空键原样', maskSessionKey(null), '');

  const budget = summarizeBudget({
    contextBudget: { enabled: true, mode: 'shadow', softAt: 300000, hardAt: 420000 },
    sessions: [
      { key: 'private:100000001', watermark: 354600, pendingHandoff: false, lastHandoffAt: 0 },
      { key: 'group:1122334455', watermark: 1000, pendingHandoff: false, lastHandoffAt: 0 },
      { key: 'private:1111111111', watermark: null, pendingHandoff: true, lastHandoffAt: 42 }
    ]
  });
  eq('分级：超软线', budget.rows.find((r) => r.key === 'private:1000***001').level, 'soft');
  eq('分级：正常', budget.rows.find((r) => r.key === 'group:1122***455').level, 'ok');
  eq('分级：无水位算 unknown 不算 ok', budget.rows.find((r) => r.key === 'private:1111***111').level, 'unknown');
  eq('排序：水位降序', budget.rows[0].key, 'private:1000***001');
  eq('计数', budget.counts, { ok: 1, soft: 1, hard: 0, unknown: 1 });
  eq('模式透出', budget.mode, 'shadow');
  eq('阈值透出', [budget.softAt, budget.hardAt], [300000, 420000]);
  eq('待交接透出', budget.rows.find((r) => r.level === 'unknown').pendingHandoff, true);

  const off = summarizeBudget({ contextBudget: { enabled: false }, sessions: [{ key: 'private:100000001', watermark: 999999 }] });
  eq('未启用时一律 unknown', off.rows[0].level, 'unknown');
  eq('面板内嵌 budget 段', typeof buildOpsPanel({ now: NOW }).questions.budget, 'object');
}
{
  // D1/O3 观察窗口：wait 空转
  const w = summarizeWait([
    { key: 'private:100000001', calls: 10, returned: 4, empty: 6 },
    { key: 'group:1122334455', calls: 2, returned: 5, empty: 0 },
    { key: 'private:1111111111', calls: 0, returned: 0, empty: 0 }
  ]);
  eq('wait 总调用', w.calls, 12);
  eq('wait 总带回', w.returned, 9);
  eq('wait 空转次数', w.emptyCalls, 6);
  eq('wait 空转占比', w.emptyRate, 0.5);
  eq('wait 平均带回', w.avgReturned, 0.8);
  eq('wait 按调用次数降序', w.rows[0].key, 'private:1000***001');
  eq('wait 键脱敏', w.rows[1].key, 'group:1122***455');
  const none = summarizeWait();
  eq('无会话时计数为 0', [none.calls, none.returned, none.emptyRate], [0, 0, 0]);
  eq('面板内嵌 wait 段', typeof buildOpsPanel({ now: NOW }).questions.wait, 'object');
}
{
  // O3 判据的观测量：每轮 wait 次数分布（「单轮 ≥3 次占比 >5% 才做上限」）
  const b = summarizeWait([
    { key: 'private:100000001', calls: 9, returned: 2, empty: 7, turnBins: { 1: 4, 2: 2, 3: 2, 4: 1 } },
    { key: 'group:1122334455', calls: 1, returned: 1, empty: 0, turnBins: { 1: 1 } }
  ]);
  eq('每轮分布跨会话合并', b.turnBins, { 1: 5, 2: 2, 3: 2, 4: 1 });
  eq('有 wait 的轮次数', b.turnsWithWaits, 10);
  eq('≥3 次的轮次数', b.turnsWith3Plus, 3);
  eq('≥3 次占比', b.ratio3Plus, 0.3);
  const noBins = summarizeWait([{ key: 'private:100000001', calls: 3, returned: 0, empty: 3 }]);
  eq('没有 turnBins 时给 0 而不是 NaN', [noBins.turnsWithWaits, noBins.turnsWith3Plus, noBins.ratio3Plus], [0, 0, 0]);
  has('面板内嵌 wait.turnBins', typeof buildOpsPanel({ now: NOW }).questions.wait.turnBins, 'object');
}
{
  // 长期累计（跨重启）：内存态重启就清零，判据真正要读的是这一块
  const persisted = { since: NOW - 3 * DAY, updatedAt: NOW - 1000, turnBins: { 1: 30, 2: 8, 3: 2, 4: 2 } };
  const w = summarizeWait([], persisted, NOW);
  eq('长期累计：有 wait 的轮次', w.soak.turnsWithWaits, 42);
  eq('长期累计：≥3 次的轮次', w.soak.turnsWith3Plus, 4);
  eq('长期累计：≥3 次占比', w.soak.ratio3Plus, 0.0952);
  // 天数按传入的 now 算（不能读 Date.now：真机跑久了测试就会漂）
  eq('长期累计：覆盖天数按传入 now 算', w.soak.days, 3);
  eq('长期累计：天数会随 now 前进', summarizeWait([], persisted, NOW + DAY).soak.days, 4);
  has('长期累计：覆盖天数约等于 3', w.soak.days >= 3 && w.soak.days < 4, String(w.soak.days));
  eq('长期累计：since 原样透出', w.soak.since, NOW - 3 * DAY);
  const none = summarizeWait([], null);
  eq('没有长期文件时 soak 为 null', none.soak, null);
  const bad = summarizeWait([], { turnBins: { 1: 'x', 2: -5 } });
  eq('坏值当 0 而不是 NaN', [bad.soak.turnBins[1], bad.soak.turnBins[2], bad.soak.ratio3Plus], [0, 0, 0]);
}
{
  // 本轮修复：缺 buckets 的行不能伪装成 0（会污染分位、假装「无输出」）
  const r1 = { ...row({ turn: 1, step: 1, miss: 100, hit: 200 }), k: 'turn' };
  const r2 = { sid: 's1', turn: 1, step: 2, t: NOW, k: 'turn' }; // 没有 b
  const r3 = { ...row({ turn: 2, step: 1, miss: 0, hit: 0, write: 50 }), k: 'turn' };
  const text = [r1, r2, r3].map((r) => JSON.stringify(r)).join('\n') + '\n';
  const s = summarizeTurns(parseTokenRows(text), { now: NOW, windowDays: 7 });
  eq('缺 buckets 的行计为 unmeasured', s.unmeasured, 1);
  eq('缺 buckets 的行不进分位', s.step.count, 2);
  eq('缺 buckets 的行不让最大水位被 0 拉低', s.step.max, 300);
  has('按日累计包含 cacheWrite', s.days.some((d) => d.cacheWrite === 50 && d.input === 350), JSON.stringify(s.days));
}
{
  // 本轮修复：阈值缺失时不能当 0（否则每个会话都判 hard）
  const gap = summarizeBudget({ contextBudget: { enabled: true }, sessions: [{ key: 'private:100000001', watermark: 999999 }] });
  eq('缺 softAt/hardAt 时判 unknown', gap.rows[0].level, 'unknown');
  eq('缺阈值时 softAt 为 null 而不是 0', gap.softAt, null);
  const zero = summarizeBudget({ contextBudget: { enabled: true, softAt: 300000, hardAt: 420000 }, sessions: [{ key: 'group:1122334455', watermark: 0 }] });
  eq('水位 0 且阈值正常时判 ok', zero.rows[0].level, 'ok');
}
{
  // 接线静态断言：观测量必须真的被 bridge 调起来，否则面板永远读到 0 却「看起来正常」。
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  has('bridge 在 wait 里累加 turnWaits', bridge.includes('stat.turnWaits = (Number(stat.turnWaits) || 0) + 1;'));
  has('bridge 每轮归档 turnBins', bridge.includes('noteTurnWaitsV2(key, preview);'));
  has('bridge 把 turnBins 透出给面板', /waitSessions:\s*\[\.\.\.waitStatsV2\.entries\(\)\]/.test(bridge));
  has('bridge 把长期分布透出给面板', bridge.includes('waitPersisted: loadOpsWaitTurns()'));
  has('bridge 长期分布走独立存档模块', bridge.includes("from './ops-wait-store.mjs'") && bridge.includes('writeWaitTurns(OPS_WAIT_TURNS_FILE'));
  const store = fs.readFileSync(new URL('../src/ops-wait-store.mjs', import.meta.url), 'utf8');
  has('存档模块原子替换', store.includes('fs.renameSync(tmp, file)'));
  const opsHtml = fs.readFileSync(new URL('../public/ops.html', import.meta.url), 'utf8');
  has('ops 页展示单轮 wait 分布', opsHtml.includes('soakRow(w.soak)'));
  has('ops 页无样本时不把 0 当结论', opsHtml.includes('积累中（等真实轮次）'));
  has('ops 页 soak 行含比例与天数', opsHtml.includes('pct(soak.ratio3Plus)') && opsHtml.includes('soak.days'));
}
if (failed > 0) {
  console.error(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
