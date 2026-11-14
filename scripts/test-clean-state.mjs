#!/usr/bin/env node
// src/clean-state.mjs 的离线单测：三档判定、天数门槛、清单与简报行。
// 纯逻辑，不碰 fs —— 删文件那一侧在 scripts/clean-state.mjs，靠 --dry 人工验。
import {
  CLEAN_DEFAULTS,
  classifyFile,
  formatBytes,
  formatDryList,
  globToRegExp,
  isExpired,
  normalizeCleanConfig,
  planClean,
  renderCleanBriefLine,
} from '../src/clean-state.mjs';

let pass = 0;
let fail = 0;

function ok(name, cond) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}`); }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 24, 15, 0).getTime();
const daysAgo = (d) => NOW - d * DAY;

console.log('— glob 语义 —');
ok('* 不跨目录', globToRegExp('state/*.json').test('state/a.json') && !globToRegExp('state/*.json').test('state/tmp/a.json'));
ok('** 跨目录', globToRegExp('state/tmp/**').test('state/tmp/a/b.mp3'));
ok('**/ 匹配零层', globToRegExp('state/**/x.png').test('state/x.png'));
ok('[0-9] 字符类', globToRegExp('state/*.log.[0-9]*').test('state/bridge.log.1') && !globToRegExp('state/*.log.[0-9]*').test('state/bridge.log'));
ok('? 单字符', globToRegExp('a?.txt').test('ab.txt') && !globToRegExp('a?.txt').test('abc.txt'));
ok('点是字面量', !globToRegExp('a.txt').test('axtxt'));
ok('反斜杠当分隔符', globToRegExp('state\\*.json').test('state/a.json'));

console.log('— 常量与配置 —');
ok('默认值：垃圾 3 天 / 缓存 7 天', CLEAN_DEFAULTS.junkDays === 3 && CLEAN_DEFAULTS.cacheDays === 7);
ok('默认是冻结对象', Object.isFrozen(CLEAN_DEFAULTS) && Object.isFrozen(CLEAN_DEFAULTS.keep));
ok('null 配置回落默认', normalizeCleanConfig(null).junkDays === 3);
ok('天数坏值回落', normalizeCleanConfig({ junkDays: -1, cacheDays: 'x' }).junkDays === 3 && normalizeCleanConfig({ cacheDays: 'x' }).cacheDays === 7);
ok('天数 0 是合法值（立刻过期）', normalizeCleanConfig({ junkDays: 0 }).junkDays === 0);
ok('规则数组为空回落默认', normalizeCleanConfig({ junk: [] }).junk.length === CLEAN_DEFAULTS.junk.length);
ok('规则里的空串被过滤', normalizeCleanConfig({ junk: ['  ', 'a'] }).junk.length === 1);
ok('enabled=false 保留', normalizeCleanConfig({ enabled: false }).enabled === false);

console.log('— 三档判定 —');
const P = normalizeCleanConfig(CLEAN_DEFAULTS);
ok('state 根 json 是必需', classifyFile('state/stickers.json', P, { now: NOW }).tier === 'keep');
ok('diary 是必需（子目录也要中）', classifyFile('state/diary/moods/2026-10-24.md', P, { now: NOW }).tier === 'keep');
ok('截图是垃圾', classifyFile('state/dashboard-now.png', P, { now: NOW }).tier === 'junk');
ok('轮转日志是垃圾', classifyFile('state/bridge.log.1', P, { now: NOW }).tier === 'junk');
ok('pip 空壳是垃圾', classifyFile('state/desk-inbox/pip-unpack-ab12', P, { now: NOW }).tier === 'junk');
ok('当前日志不是垃圾（只清轮转）', classifyFile('state/bridge.log', P, { now: NOW }).tier === 'other');
ok('state/tmp 是缓存', classifyFile('state/tmp/voice/tts-1.mp3', P, { now: NOW }).tier === 'cache');
ok('audio 下的合成语音是缓存', classifyFile('audio/say-1.wav', P, { now: NOW }).tier === 'cache');
ok('没规则的保守不动', classifyFile('state/unknown.bin', P, { now: NOW }).tier === 'other');
ok('backslash 路径也能判', classifyFile('state\\dashboard-now.png', P, { now: NOW }).tier === 'junk');
ok('前导斜杠被吃掉', classifyFile('/state/dashboard-now.png', P, { now: NOW }).tier === 'junk');
{
  const tricky = normalizeCleanConfig({ keep: ['x/**'], junk: ['x/**'], cache: [] });
  ok('keep 优先于 junk', classifyFile('x/a.txt', tricky, { now: NOW }).tier === 'keep');
}
ok('mtime=0 视为无限旧', classifyFile('state/a.png', P, { now: NOW, mtime: 0 }).ageDays === Infinity);

console.log('— 天数门槛 —');
ok('垃圾 2 天不算过期', isExpired(classifyFile('state/a.png', P, { now: NOW, mtime: daysAgo(2) }), P) === false);
ok('垃圾 3 天算过期', isExpired(classifyFile('state/a.png', P, { now: NOW, mtime: daysAgo(3) }), P) === true);
ok('缓存 6 天不算过期', isExpired(classifyFile('state/tmp/a.mp3', P, { now: NOW, mtime: daysAgo(6) }), P) === false);
ok('缓存 8 天算过期', isExpired(classifyFile('state/tmp/a.mp3', P, { now: NOW, mtime: daysAgo(8) }), P) === true);
ok('必需的永不过期', isExpired(classifyFile('state/stickers.json', P, { now: NOW, mtime: daysAgo(999) }), P) === false);

console.log('— planClean —');
const files = [
  { path: 'state/stickers.json', size: 1000, mtime: daysAgo(999) },
  { path: 'state/dashboard-now.png', size: 300, mtime: daysAgo(10) },
  { path: 'state/mobile-shot.png', size: 200, mtime: daysAgo(1) },
  { path: 'state/tmp/tts-1.mp3', size: 500, mtime: daysAgo(30) },
  { path: 'state/tmp/fresh.mp3', size: 50, mtime: daysAgo(1) },
  { path: 'state/bridge.log', size: 400, mtime: daysAgo(30) },
];
{
  const plan = planClean(files, P, { now: NOW });
  ok('stateBytes 是全部之和', plan.stateBytes === 2450);
  ok('要删的是过期垃圾 + 过期缓存', plan.actionCount === 2 && plan.freedBytes === 800);
  ok('按体积降序排', plan.actions[0].size >= plan.actions[1].size);
  ok('未到天数的垃圾进 skipped', plan.skipped.some((s) => s.path === 'state/mobile-shot.png' && s.reason.includes('未满 3 天')));
  ok('必需文件不进 skipped（只是不动）', !plan.skipped.some((s) => s.path === 'state/stickers.json'));
  ok('没规则的进 skipped 并说明', plan.skipped.some((s) => s.path === 'state/bridge.log' && s.reason.includes('没有规则命中')));
  ok('byTier 分别计数', plan.byTier.keep.count === 1 && plan.byTier.junk.count === 2 && plan.byTier.cache.count === 2);
  ok('keptBytes 不含待删', plan.keptBytes === 2450 - 800);
  ok('action 带 tier 与天数', plan.actions.every((a) => ['junk', 'cache'].includes(a.tier) && a.ageDays > 0));
}
ok('空输入不炸', planClean(null, P, { now: NOW }).fileCount === 0);
ok('没有 path 的条目被跳过', planClean([{ size: 10 }], P, { now: NOW }).fileCount === 0);

console.log('— formatBytes —');
ok('512 B', formatBytes(512) === '512 B');
ok('1.5 KB', formatBytes(1536) === '1.5 KB');
ok('10 KB（不带小数）', formatBytes(10240) === '10 KB');
ok('1.5 MB', formatBytes(1.5 * 1024 * 1024) === '1.5 MB');
ok('12 MB（不带小数）', formatBytes(12 * 1024 * 1024) === '12 MB');
ok('1.2 GB', formatBytes(1.2 * 1024 * 1024 * 1024) === '1.2 GB');
ok('负数是 —', formatBytes(-1) === '—' && formatBytes('x') === '—');

console.log('— dry 清单 —');
{
  const plan = planClean(files, P, { now: NOW });
  const lines = formatDryList(plan, { maxPerTier: 8 });
  ok('首行有 state 体积', lines[0].includes('state 2.4 KB'));
  ok('有垃圾分组', lines.some((l) => l.startsWith('🗑 垃圾：1 个')));
  ok('有缓存分组', lines.some((l) => l.startsWith('♻️ 缓存：1 个')));
  ok('有合计可清', lines.some((l) => l.includes('合计可清 800 B')));
  ok('有必需合计', lines.some((l) => l.startsWith('🔒 必需 1 个')));
  ok('有未到天数的计数', lines.some((l) => l.includes('未到天数 3 个')));
}
{
  const many = Array.from({ length: 12 }, (_, i) => ({ path: `state/shot-${i}.png`, size: 100, mtime: daysAgo(9) }));
  const lines = formatDryList(planClean(many, P, { now: NOW }), { maxPerTier: 3 });
  ok('超过 maxPerTier 折叠成「还有 N 个」', lines.some((l) => l.includes('还有 9 个')));
  const empty = formatDryList(planClean([], P, { now: NOW }));
  ok('没东西可清有兜底文案', empty.some((l) => l.includes('没有该清的东西')));
}

console.log('— 简报行 —');
ok('null 返回 null', renderCleanBriefLine(null) === null);
ok('缺 stateBytes 返回 null', renderCleanBriefLine({}) === null);
ok('没清理过就说没清理过', renderCleanBriefLine({ stateBytes: 5 * 1024 * 1024 }, { now: NOW }) === '🗑 清理：state 5.0 MB（还没清理过）');
ok('清理过带日期与释放量', renderCleanBriefLine({ stateBytes: 5 * 1024 * 1024, lastApplyAt: new Date(2026, 9, 24).toISOString(), lastFreedBytes: 327 * 1024 * 1024 }, { now: NOW }) === '🗑 清理：state 5.0 MB（10/24 清出 327 MB）');
ok('释放 0 有单独文案', renderCleanBriefLine({ stateBytes: 2048, lastApplyAt: new Date(2026, 9, 24).toISOString(), lastFreedBytes: 0 }, { now: NOW }).includes('没东西可删'));
ok('一行里不含换行', !renderCleanBriefLine({ stateBytes: 1024, lastApplyAt: new Date(2026, 9, 24).toISOString(), lastFreedBytes: 1024 }, { now: NOW }).includes('\n'));

console.log('');
console.log(`PASS：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
