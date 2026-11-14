// 每日简报的离线单测：只测纯函数，不碰网络/文件/QQ。
//   node scripts/test-daily-brief.mjs
// 期望最后一行：PASS：16 项通过，0 项失败
import { renderBrief, normalizeDailyBriefConfig, normalizeWeatherConfig, serviceState, formatWeather, weatherCodeText, DAILY_BRIEF_DEFAULTS } from '../src/daily-brief.mjs';

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

function assertIncludes(hay, needle, msg) {
  assert(String(hay).includes(needle), msg || `缺少「${needle}」：\n${hay}`);
}

function assertNotIncludes(hay, needle, msg) {
  assert(!String(hay).includes(needle), msg || `不该出现「${needle}」：\n${hay}`);
}

function snapshot(overrides = {}) {
  return {
    ok: true,
    at: AT.getTime(),
    services: {
      qqbridge: { alive: true, port: 3100 },
      qqbot: { alive: true, httpPort: 3000 },
      phoneBridge: { alive: true, port: 8899 },
      campusNet: { alive: true, logAgeMs: 62_000, task: { ok: true, lastResult: '0x0' } },
    },
    today: {
      tokens: null,
      qq: { available: true, messages: 2, sent: 2, sentOk: 2, stickers: 1, voices: 8 },
      reminders: {
        available: true,
        pending: 2,
        total: 17,
        items: [
          { id: 'a', at: new Date(2026, 9, 24, 9, 0).getTime(), text: '吃药' },
          { id: 'b', at: new Date(2026, 9, 24, 14, 30).getTime(), text: '开会' },
        ],
      },
    },
    ...overrides,
  };
}

const usage = { input: 75_700_000, cacheHit: 75_300_000, cacheMiss: 400_000, output: 35_100 };
const toolStats = { messages: 70, voices: 2, stickers: 17, failed: 1 };

check('1 全绿 + 有提醒 + 有失败', () => {
  const text = renderBrief({ at: AT, snapshot: snapshot(), usage, toolStats, config: { at: '08:00' } });
  assertIncludes(text, '早，10/24 08:00');
  assertIncludes(text, '服务：全部正常');
  assertIncludes(text, '提醒：今天 2 条');
  assertIncludes(text, '09:00 吃药');
  assertIncludes(text, '14:30 开会');
  assertIncludes(text, '消息 70 条');
  assertIncludes(text, '语音 2');
  assertIncludes(text, '表情 17');
  assertIncludes(text, '失败 1');
  assertIncludes(text, 'token：输入 75.7M');
  assertIncludes(text, '缓存 99.5%');
  assertIncludes(text, '输出 35.1k');
});

check('2 全绿 0 提醒：说「今天没有」且省略失败字段', () => {
  const snap = snapshot({ today: { ...snapshot().today, reminders: { available: true, pending: 0, total: 0, items: [] } } });
  const text = renderBrief({ at: AT, snapshot: snap, usage, toolStats: { messages: 10, voices: 0, stickers: 0, failed: 0 } });
  assertIncludes(text, '提醒：今天没有');
  assertNotIncludes(text, '失败');
});

check('3 bridge 红：文案点名 QQ桥 且带端口', () => {
  const snap = snapshot({ services: { ...snapshot().services, qqbridge: { alive: false, port: 3100 } } });
  const text = renderBrief({ at: AT, snapshot: snap });
  assertIncludes(text, '❌ 服务：');
  assertIncludes(text, 'QQ桥 挂了');
  assertIncludes(text, '3100');
  assertNotIncludes(text, '全部正常');
});

check('4 校园网：alive=false 才红；task.ok=false 但日志新鲜不算红', () => {
  const red = snapshot({ services: { ...snapshot().services, campusNet: { alive: false, logAgeMs: 12 * 60_000, task: { ok: false, error: 'schtasks 不可用' } } } });
  const redText = renderBrief({ at: AT, snapshot: red });
  assertIncludes(redText, '校园网 挂了');
  assertIncludes(redText, '12 分钟没更新');
  // 低完整性 node 下 schtasks 永远查不到任务：只要日志在更新就不许报红
  const green = snapshot({ services: { ...snapshot().services, campusNet: { alive: true, logAgeMs: 60_000, task: { ok: false, error: 'S-1-16-4096' } } } });
  const greenText = renderBrief({ at: AT, snapshot: green });
  assertIncludes(greenText, '全部正常');
  assertNotIncludes(greenText, '校园网 挂了');
});

check('5 恢复行：prevRed 非空且今天全绿', () => {
  const text = renderBrief({ at: AT, snapshot: snapshot(), prev: { red: ['qqbridge'] } });
  assertIncludes(text, '昨日红项已恢复：QQ桥');
});

check('6 恢复行：prevRed 空 / 今天仍有红时都不出现', () => {
  assertNotIncludes(renderBrief({ at: AT, snapshot: snapshot(), prev: { red: [] } }), '已恢复');
  assertNotIncludes(renderBrief({ at: AT, snapshot: snapshot(), prev: null }), '已恢复');
  const stillRed = snapshot({ services: { ...snapshot().services, qqbot: { alive: false } } });
  assertNotIncludes(renderBrief({ at: AT, snapshot: stillRed, prev: { red: ['qqbridge'] } }), '已恢复');
});

check('7 提醒 >3 条：只列 3 条 + 等 N 条', () => {
  const items = [9, 10, 11, 12, 13].map((h, i) => ({ id: `r${i}`, at: new Date(2026, 9, 24, h, 0).getTime(), text: `事${i + 1}` }));
  const snap = snapshot({ today: { ...snapshot().today, reminders: { available: true, pending: 5, total: 9, items } } });
  const text = renderBrief({ at: AT, snapshot: snap });
  assertIncludes(text, '今天 5 条');
  assertIncludes(text, '09:00 事1');
  assertIncludes(text, '11:00 事3');
  assertNotIncludes(text, '事4');
  assertIncludes(text, '等 2 条');
});

check('8 token 为 null 时整行省略', () => {
  const text = renderBrief({ at: AT, snapshot: snapshot(), usage: null });
  assertNotIncludes(text, 'token');
  assertNotIncludes(text, '—');
});

check('9 长度与行数：≤ maxChars 且 ≤ maxLines 行', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, at: new Date(2026, 9, 24, 9 + i, 0).getTime(), text: '很长很长的提醒文本'.repeat(3) }));
  const snap = snapshot({ today: { ...snapshot().today, reminders: { available: true, pending: 5, total: 5, items } } });
  const text = renderBrief({ at: AT, snapshot: snap, usage, toolStats, prev: { red: ['qqbridge'] } });
  assert(text.length <= DAILY_BRIEF_DEFAULTS.maxChars, `超长：${text.length}`);
  assert(text.split('\n').length <= 6, `行数 ${text.split('\n').length}`);
  // 硬预算：把 maxChars 压到 120 也必须守住
  const tiny = renderBrief({ at: AT, snapshot: snap, usage, toolStats, prev: { red: ['qqbridge'] }, config: { maxChars: 130 } });
  assert(tiny.length <= 130, `超长：${tiny.length}`);
});

check('10 不含 ** / # / ```', () => {
  const snap = snapshot({ today: { ...snapshot().today, reminders: { available: true, pending: 1, items: [{ id: 'x', at: new Date(2026, 9, 24, 9, 0).getTime(), text: '**吃药** #标签 ```code```' }] } } });
  const text = renderBrief({ at: AT, snapshot: snap, usage, toolStats });
  assertNotIncludes(text, '**');
  assertNotIncludes(text, '#');
  assertNotIncludes(text, '```');
  assertIncludes(text, '吃药');
});

check('11 空统计不炸（snapshot/toolStats/usage 全空）', () => {
  for (const bad of [null, undefined, {}, { services: null, today: null }]) {
    const text = renderBrief({ at: AT, snapshot: bad, toolStats: null, usage: null, prev: null });
    assert(typeof text === 'string' && text.length > 0, '空快照没出文本');
    assert(text.split('\n').length <= DAILY_BRIEF_DEFAULTS.maxLines, '行数超限');
  }
  const broken = snapshot({ services: { qqbridge: {}, qqbot: { alive: null }, phoneBridge: null, campusNet: { alive: 'yes' } } });
  const text = renderBrief({ at: AT, snapshot: broken });
  assertIncludes(text, '服务：');
  assert(!serviceState(broken).red.length, '未知状态被误判成红');
});

check('12 配置容错：at 写错 / maxChars 写 0 / enabled 字符串', () => {
  const cfg = normalizeDailyBriefConfig({ at: '8:0', maxChars: 0, windowHours: -3, key: '', enabled: 'false' });
  assert(cfg.at === DAILY_BRIEF_DEFAULTS.at, `at 未回落：${cfg.at}`);
  assert(cfg.maxChars === DAILY_BRIEF_DEFAULTS.maxChars, `maxChars 未回落：${cfg.maxChars}`);
  assert(cfg.windowHours === DAILY_BRIEF_DEFAULTS.windowHours, `windowHours 未回落：${cfg.windowHours}`);
  assert(cfg.key === DAILY_BRIEF_DEFAULTS.key, `key 未回落：${cfg.key}`);
  assert(cfg.enabled === false, '字符串 false 应当算禁用');
  assert(normalizeDailyBriefConfig(null).at === DAILY_BRIEF_DEFAULTS.at, 'null 应回落默认');
  const text = renderBrief({ at: AT, snapshot: snapshot(), config: { at: '99:99', maxChars: 0 } });
  assertIncludes(text, '服务：全部正常');
});

check('13 天气行：格式正确且紧跟问候语（第 2 行）', () => {
  const wx = { label: '洛阳', code: 3, temp: 17.1, min: 10.3, max: 17.6, precip: 24 };
  const text = renderBrief({ at: AT, snapshot: snapshot(), weather: wx, config: { at: '08:00' } });
  const lines = text.split('\n');
  assert(lines[1] === '🌤 天气：洛阳 阴 · 10.3~17.6°C · 现在 17.1°C · 降水 24%', `第 2 行不对：${lines[1]}`);
  assert(lines[0].startsWith('早，'), '问候语应在第 1 行');
  assert(lines[2].includes('服务：'), `服务行应紧随天气：${lines[2]}`);
  // 无 label 时不留双空格
  const noLabel = formatWeather({ code: 0, temp: 19 });
  assert(noLabel === '🌤 天气：晴 · 现在 19°C', `无 label 格式不对：${noLabel}`);
  assert(weatherCodeText(9999) === null, '未知码应返回 null');
});

check('14 天气缺数据降级：缺区间省略区间、全空不占行、禁用不出现', () => {
  const onlyNow = formatWeather({ label: '洛阳', code: 61, temp: 12.34 });
  assert(onlyNow === '🌤 天气：洛阳 小雨 · 现在 12.3°C', `只有温度时格式不对：${onlyNow}`);
  assert(formatWeather({}) === null, '空天气对象应返回 null');
  assert(formatWeather(null) === null, 'null 应返回 null');
  const text = renderBrief({ at: AT, snapshot: snapshot(), weather: {} });
  assertNotIncludes(text, '天气', '没有天气数据时不该出现「天气」');
  const off = renderBrief({ at: AT, snapshot: snapshot(), weather: { code: 3, temp: 17 }, config: { weather: { enabled: false } } });
  assertNotIncludes(off, '天气', 'enabled=false 时不该出现天气行');
});

check('15 weather 配置容错：坏坐标当没配、label 截断、enabled 字符串', () => {
  const bad = normalizeWeatherConfig({ label: '  洛   阳  ', latitude: 999, longitude: 'x', enabled: 'off' });
  assert(bad.latitude === null && bad.longitude === null, '坏坐标未丢弃');
  assert(bad.label === '洛 阳', `label 未折叠：${bad.label}`);
  assert(bad.enabled === false, 'off 应算禁用');
  const long = normalizeWeatherConfig({ label: '一二三四五六七八九十十一十二十三' });
  assert(long.label.length === 12, `label 未截断：${long.label.length}`);
  const ok = normalizeWeatherConfig({ latitude: 34.61994, longitude: 112.46699 });
  assert(ok.latitude === 34.61994 && ok.longitude === 112.46699, '合法坐标被丢弃');
  assert(normalizeDailyBriefConfig({ weather: { enabled: false } }).weather.enabled === false, 'weather 未接进主配置');
  assert(normalizeDailyBriefConfig({}).weather.enabled === true, 'weather 默认应开启');
});

check('16 天气行也过 sanitize：不含 ** / # / ```', () => {
  const text = renderBrief({ at: AT, snapshot: snapshot(), weather: { label: '#洛阳#', code: 3, temp: 17 } });
  assertNotIncludes(text, '#');
  assertIncludes(text, '＃洛阳＃');
  assertNotIncludes(text, '**');
});

check('17 备份行：成功时带份数与体积', () => {
  const text = renderBrief({
    at: AT,
    snapshot: snapshot(),
    backup: { lastRunAt: new Date(2026, 9, 24, 3, 10).toISOString(), lastOk: true, fileCount: 237, totalBytes: 1545259 },
  });
  assertIncludes(text, '💾 备份：今天 03:10 成功（237 份 / 1.5 MB）');
});

check('18 自检行：全绿只说 N/N，红项点名并带时刻', () => {
  const green = renderBrief({
    at: AT,
    snapshot: snapshot(),
    doctor: { lastRunAt: new Date(2026, 9, 24, 7, 50).toISOString(), lastOk: true, passed: 8, total: 8 },
  });
  assertIncludes(green, '🩺 自检：8/8 通过');
  const red = renderBrief({
    at: AT,
    snapshot: snapshot(),
    doctor: {
      lastRunAt: new Date(2026, 9, 24, 7, 50).toISOString(),
      lastOk: false,
      passed: 7,
      total: 8,
      failed: [{ key: 'config', name: '配置', detail: 'voiceTts.enabled=false' }],
    },
  });
  assertIncludes(red, '🩺 自检：7/8 通过 07:50（配置 voiceTts.enabled=false）');
});

// 磁盘卫生行按项目计划 ② 只在周日出现：AT 是周六，隔天才是周日。
check('19 清理行只在周日出现', () => {
  const clean = { stateBytes: 5 * 1024 * 1024, lastApplyAt: new Date(2026, 9, 24, 14, 20).toISOString(), lastFreedBytes: 674847 };
  assertNotIncludes(renderBrief({ at: AT, snapshot: snapshot(), clean }), '🗑 清理：');
  const sunday = new Date(2026, 9, 25, 8, 0);
  assertIncludes(renderBrief({ at: sunday, snapshot: snapshot(), clean }), '🗑 清理：state 5.0 MB（10/24 清出 659 KB）');
});

check('20 运维三行同时在场也不超 maxLines', () => {
  const text = renderBrief({
    at: new Date(2026, 9, 25, 8, 0),
    snapshot: snapshot(),
    usage: { input: 24435520, cacheHit: 24291584, output: 23419, turns: 189 },
    toolStats: { messages: 43, voices: 0, stickers: 10, failed: 15, calls: 152 },
    weather: { label: '洛阳', code: 3, temp: 17.3, min: 10.3, max: 17.6, precip: 24 },
    backup: { lastRunAt: new Date(2026, 9, 25, 3, 10).toISOString(), lastOk: true, fileCount: 237, totalBytes: 1545259 },
    doctor: { lastRunAt: new Date(2026, 9, 25, 7, 50).toISOString(), lastOk: true, passed: 8, total: 8 },
    clean: { stateBytes: 5 * 1024 * 1024, lastApplyAt: new Date(2026, 9, 24, 14, 20).toISOString(), lastFreedBytes: 674847 },
  });
  const lines = text.split('\n');
  assert(lines.length <= DAILY_BRIEF_DEFAULTS.maxLines, `行数 ${lines.length} 超过 ${DAILY_BRIEF_DEFAULTS.maxLines}`);
  assert(text.length <= DAILY_BRIEF_DEFAULTS.maxChars, `字数 ${text.length} 超过 ${DAILY_BRIEF_DEFAULTS.maxChars}`);
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
