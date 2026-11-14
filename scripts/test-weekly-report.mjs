#!/usr/bin/env node
// 周报纯逻辑单测：不碰网络、不读 state 文件（I/O 在 scripts/weekly-report.mjs）。
import {
  WEEKLY_DEFAULTS,
  normalizeWeeklyConfig,
  makeWindow,
  summarizeTurns,
  summarizeCalls,
  summarizeDoctor,
  parseChecklist,
  diffChecklist,
  formatTokens,
  renderWeeklyReport,
  isoWeekKey,
} from '../src/weekly-report.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`FAIL ${name}${extra ? ` → ${extra}` : ''}`);
  }
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const has = (name, text, needle) => ok(name, String(text).includes(needle), `missing ${JSON.stringify(needle)} in:\n${text}`);

// ── 配置 ────────────────────────────────────────────────────────────────────
eq('默认值', normalizeWeeklyConfig(null), { ...WEEKLY_DEFAULTS });
eq('enabled=false 保留', normalizeWeeklyConfig({ enabled: false }).enabled, false);
eq('坏 at 回落', normalizeWeeklyConfig({ at: '25:99' }).at, '20:00');
eq('at 空格裁剪', normalizeWeeklyConfig({ at: ' 19:30 ' }).at, '19:30');
eq('dayOfWeek 越界回落', normalizeWeeklyConfig({ dayOfWeek: 9 }).dayOfWeek, 0);
eq('windowDays 0 回落', normalizeWeeklyConfig({ windowDays: 0 }).windowDays, 7);
eq('maxLines 过小回落', normalizeWeeklyConfig({ maxLines: 1 }).maxLines, 14);
eq('maxChars 取整', normalizeWeeklyConfig({ maxChars: 800.7 }).maxChars, 801);

// ── 时间窗 ──────────────────────────────────────────────────────────────────
const w = makeWindow(new Date('2026-10-24T20:00:00+08:00'), 7);
eq('窗口跨度 7 天', (w.to - w.from) / 86400000, 7);
eq('窗口坏参回落 7 天', (makeWindow(0, 'x').to - makeWindow(0, 'x').from) / 86400000, 7);

// ── 轮次与 token ────────────────────────────────────────────────────────────
const t0 = new Date('2026-10-24T12:00:00+08:00').getTime();
const win = makeWindow(t0, 7);
const turns = summarizeTurns([
  { k: 'turn', t: t0 - 1000, sid: 's1', b: { cacheHit: 900, cacheMiss: 100, cacheWrite: 0, output: 50 } },
  { k: 'turn', t: t0 - 2000, sid: 's1', b: { cacheHit: 800, cacheMiss: 0, cacheWrite: 0, output: 30 } },
  { k: 'turn', t: t0 - 3000, sid: 's2', b: { cacheMiss: 200 } },
  { k: 'turn', t: t0 - 1000 * 86400 * 30, sid: 's3', b: { cacheHit: 999 } }, // 窗外
  { k: 'other', t: t0 - 1000, b: { cacheHit: 999 } }, // 非 turn
  { k: 'turn', t: 'bad', b: {} }, // 坏时间
  null,
], win);
eq('轮数', turns.turns, 3);
eq('会话数', turns.sessionCount, 2);
eq('输入合计', turns.input, 2000);
eq('缓存率', Math.round(turns.cacheRate * 1000) / 1000, 0.85);
eq('输出合计', turns.output, 80);
eq('空输入缓存率为 0', summarizeTurns([], win).cacheRate, 0);
eq('非数组不炸', summarizeTurns(undefined, win).turns, 0);

// ── 工具调用 ────────────────────────────────────────────────────────────────
const calls = summarizeCalls([
  { type: 'call', time: '2026-10-23T04:00:00.000Z', tool: 'mcp__snowluma__qq_reply', ok: true },
  { type: 'call', time: '2026-10-23T04:01:00.000Z', tool: 'mcp__snowluma__qq_send_voice', ok: false },
  { type: 'call', time: '2026-10-23T04:02:00.000Z', tool: 'mcp__snowluma__qq_send_sticker' },
  { type: 'result', time: '2026-10-23T04:02:30.000Z', tool: 'mcp__snowluma__qq_reply', ok: false },
  { type: 'call', time: '2026-09-01T04:02:30.000Z', tool: 'mcp__snowluma__qq_reply', ok: true },
], win);
eq('调用总数', calls.calls, 3);
eq('消息数', calls.messages, 1);
eq('语音数', calls.voices, 1);
eq('表情数', calls.stickers, 1);
eq('失败数', calls.failed, 1);

// ── 自检历史 ────────────────────────────────────────────────────────────────
const doc = summarizeDoctor([
  { at: '2026-10-24T03:50:00+08:00', ok: true, failed: [] },
  { at: '2026-10-24T04:50:00+08:00', ok: false, failed: ['config'] },
  { at: '2026-10-23T04:50:00+08:00', ok: false, failed: [{ key: 'config' }, { name: 'phoneBridge' }] },
  { at: '2026-08-01T04:50:00+08:00', ok: false, failed: ['tests'] }, // 窗外
  { at: '', ok: false },
], win);
eq('自检次数', doc.runs, 3);
eq('红次数', doc.redRuns, 2);
eq('最常见红项', doc.topRed[0], { key: 'config', count: 2 });
eq('空历史', summarizeDoctor(null, win), { runs: 0, redRuns: 0, topRed: [] });

// ── 复选框 ──────────────────────────────────────────────────────────────────
const items = parseChecklist(`# 文档
- [ ] 没有标题的项
## 三、阶段拆分
- [x] 索引跑完
- [X] 检索稳定
  - [ ] 缩进的子项
### 验收标准
- [ ] 五档 mood 各合成一条
- [x]
- 普通列表项
`, '01.md');
eq('条目数', items.length, 5);
eq('首条无标题', items[0].heading, '');
eq('首条未勾', items[0].done, false);
eq('大括号勾选视为已勾', items[2].done, true);
eq('缩进项也算', items[3].text, '缩进的子项');
eq('### 标题也带出来', items[4].heading, '验收标准');
eq('key 组成', items[4].key, '01.md::验收标准::五档 mood 各合成一条');
eq('空正文跳过', items.some((i) => i.text === ''), false);
eq('空文本不炸', parseChecklist(undefined).length, 0);

// ── 基线对比 ────────────────────────────────────────────────────────────────
const d1 = diffChecklist([], items);
eq('首次运行', d1.firstRun, true);
eq('首次不报新增', d1.newlyDone.length, 0);
eq('首次仍数已勾', d1.doneCount, 2);
const d2 = diffChecklist([items[1].key], items);
eq('非首次', d2.firstRun, false);
eq('新增已勾只有一条', d2.newlyDone.length, 1);
eq('新增已勾内容', d2.newlyDone[0].text, '检索稳定');
eq('坏基线当空', diffChecklist('x', items).firstRun, true);

// ── 数字格式 ────────────────────────────────────────────────────────────────
eq('formatTokens 小数', formatTokens(999), '999');
eq('formatTokens k', formatTokens(12_345), '12k');
eq('formatTokens k 小值', formatTokens(1_500), '1.5k');
eq('formatTokens M', formatTokens(1_500_000), '1.5M');
eq('formatTokens 大 M', formatTokens(50_077_074), '50M');
eq('formatTokens 坏值', formatTokens(-1), '0');
eq('formatTokens NaN', formatTokens('x'), '0');

// ── 正文 ────────────────────────────────────────────────────────────────────
const plan = [
  { file: '01.md', heading: '三、阶段拆分', text: '索引跑完', done: true, key: 'k1' },
  { file: '01.md', heading: '三、阶段拆分', text: '检索稳定', done: true, key: 'k2' },
  { file: '02b.md', heading: '六、验收标准', text: '五档 mood 各合成一条，`seconds` 均在 2–60 区间', done: false, key: 'k3' },
  { file: '02b.md', heading: '六、验收标准', text: '**音色一致**（不跳声）', done: false, key: 'k4' },
];
const text = renderWeeklyReport({
  at: new Date('2026-10-24T20:00:00+08:00'),
  turns: { turns: 42, sessionCount: 3, input: 1_500_000, cacheRate: 0.99, output: 12_345 },
  calls: { calls: 100, failed: 2, messages: 40, voices: 3, stickers: 9 },
  doctor: { runs: 7, redRuns: 1, topRed: [{ key: 'config', count: 1 }] },
  backup: { lastRunAt: '2026-10-24T03:10:00+08:00', lastOk: true, fileCount: 237, totalBytes: 9_271_554 },
  items: plan,
  prevChecked: ['k1'],
  config: { maxLines: 20, maxChars: 900 },
});
has('标题含日期区间', text, '📊 周报 10/17–10/24');
has('轮次行', text, '💬 对话：42 轮 · 3 个会话 · 消息 40 条 · 失败 2');
has('随手行', text, '🎁 随手：语音 3 · 表情 9');
has('token 行', text, '🔤 token：输入 1.5M（缓存 99.0%）· 输出 12k');
has('自检点名用中文标签', text, '🩺 服务：自检 7 次，红 1 次（配置×1）');
has('备份行', text, '💾 备份：最近一次成功（237 份 / 8.8 MB）');
has('收尾行', text, '✅ 收尾：本周完成 1 项');
has('收尾明细带标题', text, '   · 阶段拆分：检索稳定');
has('待办编号', text, '   1. 五档 mood 各合成一条，seconds 均在 2–60 区间');
has('待办剥掉 Markdown', text, '   2. 音色一致（不跳声）');
has('不含反引号', text.includes('`'), false);
has('不含星号', text.includes('*'), false);

const empty = renderWeeklyReport({ at: new Date('2026-10-24T20:00:00+08:00') });
eq('全空只有标题一行', empty.split('\n').length, 1);
has('全空标题', empty, '📊 周报');

const firstRun = renderWeeklyReport({ at: new Date('2026-10-24T20:00:00+08:00'), items: plan, prevChecked: [] });
has('首次运行提示', firstRun, '清单首次建立基线（已勾 2 项）');

const noNew = renderWeeklyReport({ at: new Date('2026-10-24T20:00:00+08:00'), items: plan, prevChecked: ['k1', 'k2'] });
has('无新增提示', noNew, '✅ 收尾：本周清单没有新增勾选');

const noTodo = renderWeeklyReport({ at: new Date('2026-10-24T20:00:00+08:00'), items: plan.filter((i) => i.done), prevChecked: ['k1'] });
has('无待办提示', noTodo, '📋 下周待办：清单里没有未勾选项');

const noRuns = renderWeeklyReport({ at: new Date('2026-10-24T20:00:00+08:00'), doctor: { runs: 0, redRuns: 0, topRed: [] } });
ok('没跑过自检就不出这行', !noRuns.includes('🩺'));

const allGreen = renderWeeklyReport({ at: new Date('2026-10-24T20:00:00+08:00'), doctor: { runs: 7, redRuns: 0, topRed: [] } });
has('全绿写法', allGreen, '🩺 服务：自检 7 次全绿');

const clamped = renderWeeklyReport({
  at: new Date('2026-10-24T20:00:00+08:00'),
  turns: { turns: 1, input: 10, cacheRate: 0, output: 1 },
  calls: { calls: 1, failed: 0, messages: 1, voices: 1, stickers: 1 },
  doctor: { runs: 1, redRuns: 0, topRed: [] },
  backup: { lastRunAt: '2026-10-24T03:10:00+08:00', lastOk: true, fileCount: 1, totalBytes: 1024 },
  items: plan,
  prevChecked: ['k1'],
  config: { maxLines: 5, maxChars: 900 },
});
eq('maxLines 生效', clamped.split('\n').length, 5);
const longPlan = [
  ...plan,
  { file: '03.md', heading: '三、拆解', text: '把仪表盘的时间窗从 24 小时改成 7 天并补上同比对比', done: false, key: 'k5' },
  { file: '03.md', heading: '三、拆解', text: '把语音合成失败的降级提示写进工具返回里，别静默吞掉异常', done: false, key: 'k6' },
  { file: '05.md', heading: '二、方案', text: '记忆索引增加文档切片器，支持 md 与 pdf 两种来源，按段落切', done: false, key: 'k7' },
];
const shortChars = renderWeeklyReport({
  at: new Date('2026-10-24T20:00:00+08:00'),
  turns: { turns: 42, sessionCount: 3, input: 1_500_000, cacheRate: 0.99, output: 12_345 },
  calls: { calls: 100, failed: 2, messages: 40, voices: 3, stickers: 9 },
  doctor: { runs: 7, redRuns: 1, topRed: [{ key: 'config', count: 1 }] },
  backup: { lastRunAt: '2026-10-24T03:10:00+08:00', lastOk: true, fileCount: 237, totalBytes: 9_271_554 },
  items: longPlan,
  prevChecked: ['k1'],
  config: { maxLines: 14, maxChars: 200 },
});
ok('maxChars 生效', shortChars.length <= 200, `len=${shortChars.length}`);
ok('截断补省略号', shortChars.endsWith('…'));
ok('长清单原本会超长', renderWeeklyReport({
  at: new Date('2026-10-24T20:00:00+08:00'),
  turns: { turns: 42, sessionCount: 3, input: 1_500_000, cacheRate: 0.99, output: 12_345 },
  calls: { calls: 100, failed: 2, messages: 40, voices: 3, stickers: 9 },
  doctor: { runs: 7, redRuns: 1, topRed: [{ key: 'config', count: 1 }] },
  items: longPlan,
  prevChecked: ['k1'],
  config: { maxLines: 14, maxChars: 900 },
}).length > 200);

// ── ISO 周 ──────────────────────────────────────────────────────────────────
eq('本周', isoWeekKey('2026-10-24'), '2026-W43');
eq('周日属于同一周', isoWeekKey('2026-10-25'), '2026-W43');
eq('前一周', isoWeekKey('2026-10-18'), '2026-W42');
eq('年初', isoWeekKey('2026-01-01'), '2026-W01');
eq('跨年归上周年', isoWeekKey('2027-01-01'), '2026-W53');
eq('坏日期', isoWeekKey('nope'), '');

console.log(`PASS：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
