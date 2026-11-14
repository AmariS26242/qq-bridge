// 夜间语音时段逻辑的离线断言（不发 QQ、不合成、不联网）。
// 跑法：node scripts/test-voice-window.mjs
import assert from 'node:assert/strict';
import {
  VOICE_WINDOW_DEFAULTS,
  buildVoiceWindowPrompt,
  describeVoiceWindow,
  formatClock,
  isInVoiceWindow,
  isVoiceWindowActiveFor,
  minutesOfDay,
  normalizeVoiceWindowConfig,
  parseClock
} from '../src/voice-window.mjs';

let pass = 0;
const cases = [];
function t(name, fn) {
  try {
    fn();
    pass += 1;
    cases.push(`PASS ${name}`);
  } catch (error) {
    cases.push(`FAIL ${name}\n     ${error?.message ?? error}`);
    throw error;
  }
}

// 机器本地时区是 Asia/Shanghai；显式带 +08:00 偏移，换机器也不会误判。
const at = (hhmm) => Date.parse(`2026-11-14T${hhmm}:00+08:00`);

t('时钟解析：合法/非法', () => {
  assert.equal(parseClock('22:00'), 1320);
  assert.equal(parseClock('6:05'), 365);
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('22:60'), null);
  assert.equal(parseClock(''), null);
  assert.equal(formatClock(1320), '22:00');
  assert.equal(formatClock(60), '01:00');
});

t('默认配置：22:00–06:00、calm、16 字、开启', () => {
  const cfg = normalizeVoiceWindowConfig({});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.start, '22:00');
  assert.equal(cfg.end, '06:00');
  assert.equal(cfg.mood, 'calm');
  assert.equal(cfg.maxChars, 16);
  assert.equal(cfg.startMin, 1320);
  assert.equal(cfg.endMin, 360);
});

t('写错的字段回默认，不会变成 24 小时', () => {
  const cfg = normalizeVoiceWindowConfig({ start: '25:00', end: 'nope', maxChars: 'x', mood: 'weird' });
  assert.equal(cfg.start, VOICE_WINDOW_DEFAULTS.start);
  assert.equal(cfg.end, VOICE_WINDOW_DEFAULTS.end);
  assert.equal(cfg.maxChars, VOICE_WINDOW_DEFAULTS.maxChars);
  assert.equal(cfg.mood, VOICE_WINDOW_DEFAULTS.mood);
});

t('默认窗口：22:00 进、06:00 出、白天不进', () => {
  const cfg = normalizeVoiceWindowConfig({});
  for (const [time, want] of [
    ['21:59', false], ['22:00', true], ['23:59', true],
    ['00:00', true], ['03:00', true], ['05:59', true],
    ['06:00', false], ['06:01', false], ['12:00', false]
  ]) {
    assert.equal(isInVoiceWindow(at(time), cfg), want, `${time} 期望 ${want}`);
  }
});

t('自定义窗口 20:00–04:00 同样跨零点', () => {
  const cfg = normalizeVoiceWindowConfig({ start: '20:00', end: '04:00' });
  for (const [time, want] of [
    ['19:59', false], ['20:00', true], ['23:00', true],
    ['00:30', true], ['03:59', true], ['04:00', false], ['10:00', false]
  ]) {
    assert.equal(isInVoiceWindow(at(time), cfg), want, `${time} 期望 ${want}`);
  }
});

t('start === end 视为永不生效', () => {
  const cfg = normalizeVoiceWindowConfig({ start: '22:00', end: '22:00' });
  for (const time of ['21:00', '22:00', '23:00', '03:00', '12:00']) {
    assert.equal(isInVoiceWindow(at(time), cfg), false, `${time} 应不生效`);
  }
});

t('enabled=false 一律不生效', () => {
  const cfg = normalizeVoiceWindowConfig({ enabled: false });
  assert.equal(isInVoiceWindow(at('23:30'), cfg), false);
  assert.equal(buildVoiceWindowPrompt(at('23:30'), cfg), '');
});

t('非跨零点窗口 09:00–18:00', () => {
  const cfg = normalizeVoiceWindowConfig({ start: '09:00', end: '18:00' });
  assert.equal(isInVoiceWindow(at('08:59'), cfg), false);
  assert.equal(isInVoiceWindow(at('09:00'), cfg), true);
  assert.equal(isInVoiceWindow(at('17:59'), cfg), true);
  assert.equal(isInVoiceWindow(at('18:00'), cfg), false);
});

t('提示块：窗口内有规则、窗口外为空串', () => {
  const cfg = normalizeVoiceWindowConfig({});
  const inside = buildVoiceWindowPrompt(at('23:30'), cfg);
  assert.ok(inside.includes('【夜间语音时段'), '窗口内应有提示块');
  assert.ok(inside.includes('22:00–06:00'), '应带窗口时间');
  assert.ok(inside.includes('send_tts_voice'), '应要求走语音工具');
  assert.equal(buildVoiceWindowPrompt(at('12:00'), cfg), '', '窗口外必须为空串');
});

t('提示块：自定义 mood/字数生效', () => {
  const cfg = normalizeVoiceWindowConfig({ mood: 'shy', maxChars: 12, start: '21:00', end: '07:00' });
  const text = buildVoiceWindowPrompt(at('22:00'), cfg);
  assert.ok(text.includes('mood=shy'));
  assert.ok(text.includes('0–12 字') || text.includes('–12 字'));
  assert.ok(text.includes('21:00–07:00'));
});

t('状态快照：窗口内/外都给出下一次翻转', () => {
  const cfg = normalizeVoiceWindowConfig({});
  const inside = describeVoiceWindow(at('23:30'), cfg);
  assert.equal(inside.active, true);
  assert.equal(inside.now, '23:30');
  assert.equal(inside.nextChangeMinutes, 390); // 到 06:00 还有 6.5 小时
  const outside = describeVoiceWindow(at('12:00'), cfg);
  assert.equal(outside.active, false);
  assert.equal(outside.nextChangeMinutes, 600); // 到 22:00 还有 10 小时
});

t('minutesOfDay 本地时区正确', () => {
  assert.equal(minutesOfDay(at('00:00')), 0);
  assert.equal(minutesOfDay(at('23:59')), 1439);
});

t('会话范围：默认只私聊，群里夜间不语音', () => {
  const cfg = normalizeVoiceWindowConfig({});
  assert.deepEqual(cfg.scopes, ['private']);
  assert.equal(isVoiceWindowActiveFor('private:100000001', at('23:30'), cfg), true);
  assert.equal(isVoiceWindowActiveFor('group:1122334455', at('23:30'), cfg), false);
  assert.equal(isVoiceWindowActiveFor('', at('23:30'), cfg), false);
});

t('会话范围：显式加 group 后群聊也生效；拼错的 scope 被丢弃并回默认', () => {
  const both = normalizeVoiceWindowConfig({ scopes: ['group', 'private', 'weird'] });
  assert.deepEqual(both.scopes.sort(), ['group', 'private']);
  assert.equal(isVoiceWindowActiveFor('group:1122334455', at('23:30'), both), true);
  const junk = normalizeVoiceWindowConfig({ scopes: ['weird'] });
  assert.deepEqual(junk.scopes, ['private']);
});

t('会话范围：窗口外不论私聊群聊都不生效', () => {
  const cfg = normalizeVoiceWindowConfig({ scopes: ['private', 'group'] });
  assert.equal(isVoiceWindowActiveFor('private:1', at('12:00'), cfg), false);
  assert.equal(isVoiceWindowActiveFor('group:1', at('12:00'), cfg), false);
});

for (const line of cases) console.log(line);
console.log(`\n${pass} 项全部通过`);
