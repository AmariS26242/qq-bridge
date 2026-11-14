// 自动语音判定逻辑的离线断言（不发 QQ、不合成、不联网）。
// 跑法：node scripts/test-auto-voice.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUTO_VOICE_DEFAULTS,
  cleanVoiceText,
  decideAutoVoice,
  loadUsage,
  matchScene,
  normalizeAutoVoiceConfig,
  recordVoiceUsage,
  saveUsage,
  todayKey
} from '../src/auto-voice.mjs';

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

const NOW = Date.parse('2026-10-23T23:30:00+08:00');
const cfg = normalizeAutoVoiceConfig({});

t('默认配置：开启、30 条、20 分钟冷却、20 字', () => {
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.maxPerDay, 30);
  assert.equal(cfg.cooldownMinutes, 20);
  assert.equal(cfg.maxChars, 20);
  assert.equal(cfg.scenes.length, AUTO_VOICE_DEFAULTS.scenes.length);
});

t('五档 mood 都能被场景命中', () => {
  assert.equal(decideAutoVoice({ text: '晚安，早点睡', cfg, usage: null, now: NOW }).mood, 'calm');
  assert.equal(decideAutoVoice({ text: '生日快乐呀', cfg, usage: null, now: NOW }).mood, 'happy');
  assert.equal(decideAutoVoice({ text: '想你了', cfg, usage: null, now: NOW }).mood, 'shy');
  assert.equal(decideAutoVoice({ text: '哼，不理你', cfg, usage: null, now: NOW }).mood, 'annoyed');
  assert.equal(decideAutoVoice({ text: '那我先走了，再见', cfg, usage: null, now: NOW }).mood, 'sad');
});

t('优先级：生日快乐压过好开心，想你也压过再见', () => {
  assert.equal(decideAutoVoice({ text: '好开心，生日快乐', cfg, usage: null, now: NOW }).mood, 'happy');
  assert.equal(decideAutoVoice({ text: '想你了，再见', cfg, usage: null, now: NOW }).mood, 'shy');
});

t('普通闲聊不发（只有白名单，不随机）', () => {
  const d = decideAutoVoice({ text: '今天吃了番茄炒蛋', cfg, usage: null, now: NOW });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'nomatch');
});

t('确定性：同一输入连判 50 次结果完全一致', () => {
  const first = JSON.stringify(decideAutoVoice({ text: '晚安啦', cfg, usage: null, now: NOW }));
  for (let i = 0; i < 50; i++) {
    assert.equal(JSON.stringify(decideAutoVoice({ text: '晚安啦', cfg, usage: null, now: NOW })), first);
  }
});

t('超出字数上限降级文字', () => {
  const d = decideAutoVoice({ text: '晚安，今天真的辛苦你了，明天也要好好吃饭，记得早点睡，做个好梦哦', cfg, usage: null, now: NOW });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'toolong');
  assert.equal(d.mood, 'calm');
});

t('空文本 / 单字不发', () => {
  assert.equal(decideAutoVoice({ text: '', cfg, usage: null, now: NOW }).reason, 'empty');
  assert.equal(decideAutoVoice({ text: '嗯', cfg, usage: { date: todayKey(NOW), auto: 0, lastAutoAt: 0 }, now: NOW }).reason, 'empty');
});

t('每日上限：第 30 条可发，第 31 条降级', () => {
  const usage = { date: todayKey(NOW), auto: 29, manual: 0, byMood: {}, lastAutoAt: 0, history: [] };
  assert.equal(decideAutoVoice({ text: '晚安啦', cfg, usage, now: NOW }).ok, true);
  const capped = decideAutoVoice({ text: '晚安啦', cfg, usage: { ...usage, auto: 30 }, now: NOW });
  assert.equal(capped.ok, false);
  assert.equal(capped.reason, 'cap');
});

t('冷却：20 分钟内第二条不发，21 分钟后可发', () => {
  const usage = { date: todayKey(NOW), auto: 1, manual: 0, byMood: {}, lastAutoAt: NOW - 5 * 60 * 1000, history: [] };
  const soon = decideAutoVoice({ text: '晚安啦', cfg, usage, now: NOW });
  assert.equal(soon.ok, false);
  assert.equal(soon.reason, 'cooldown');
  assert.ok(soon.waitMs > 0);
  const later = decideAutoVoice({ text: '晚安啦', cfg, usage, now: NOW + 21 * 60 * 1000 });
  assert.equal(later.ok, true);
});

t('跨天：昨天的 lastAutoAt 与计数不生效', () => {
  const usage = { date: '2026-10-22', auto: 30, manual: 0, byMood: {}, lastAutoAt: NOW - 1000, history: [] };
  assert.equal(decideAutoVoice({ text: '晚安啦', cfg, usage, now: NOW }).ok, true);
});

t('enabled=false 直接不发', () => {
  const off = normalizeAutoVoiceConfig({ enabled: false });
  assert.equal(decideAutoVoice({ text: '晚安啦', cfg: off, usage: null, now: NOW }).reason, 'disabled');
});

t('maxPerDay=0 视为不限（只靠场景）', () => {
  const unlimited = normalizeAutoVoiceConfig({ maxPerDay: 0, cooldownMinutes: 0 });
  const usage = { date: todayKey(NOW), auto: 999, manual: 0, byMood: {}, lastAutoAt: NOW, history: [] };
  assert.equal(decideAutoVoice({ text: '晚安啦', cfg: unlimited, usage, now: NOW }).ok, true);
});

t('念白清洗：去 CQ 码、URL、Markdown、尾标点', () => {
  const cleaned = cleanVoiceText('**晚安**啦 [CQ:face,id=14] https://x.com/a ～');
  assert.equal(cleaned.spoken, '晚安啦');
  const punct = cleanVoiceText('想你了！！！');
  assert.equal(punct.spoken, '想你了');
  const long = cleanVoiceText('晚'.repeat(25));
  assert.equal(long.tooLong, true);
});

t('配置容错：坏 scene 被丢掉、缺字段走默认', () => {
  const bad = normalizeAutoVoiceConfig({
    maxPerDay: '15',
    scenes: [{ mood: 'nope', keywords: ['x'] }, { mood: 'happy', keywords: [] }, { mood: 'shy', keywords: ['想你'] }]
  });
  assert.equal(bad.maxPerDay, 15);
  assert.equal(bad.scenes.length, 1);
  assert.equal(bad.scenes[0].mood, 'shy');
  assert.equal(normalizeAutoVoiceConfig(null).maxPerDay, 30);
});

t('用量记账：auto 计上限、manual 不计，history 截到 60 条', () => {
  let usage = { date: todayKey(NOW), auto: 0, manual: 0, byMood: {}, lastAutoAt: 0, history: [] };
  usage = recordVoiceUsage(usage, { mode: 'auto', mood: 'calm', now: NOW });
  usage = recordVoiceUsage(usage, { mode: 'manual', mood: 'happy', now: NOW });
  assert.equal(usage.auto, 1);
  assert.equal(usage.manual, 1);
  assert.equal(usage.byMood.calm, 1);
  assert.equal(usage.byMood.happy, 1);
  assert.equal(usage.lastAutoAt, NOW);
  for (let i = 0; i < 80; i++) usage = recordVoiceUsage(usage, { mode: 'auto', mood: 'calm', now: NOW });
  assert.equal(usage.history.length, 60);
});

t('用量文件读写：落盘→读回一致，坏文件回退空账，跨天自动清零', () => {
  // 临时目录放 state/tmp（系统 temp 在沙箱里可能 EPERM），用完即删。
  const tmpRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', 'state', 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'voice-usage-'));
  const file = path.join(dir, 'state', 'voice-usage.json');
  const usage = recordVoiceUsage(null, { mode: 'auto', mood: 'shy', now: NOW });
  assert.equal(saveUsage(file, usage), true);
  const back = loadUsage(file, NOW);
  assert.equal(back.auto, 1);
  assert.equal(back.byMood.shy, 1);
  assert.equal(loadUsage(path.join(dir, 'missing.json'), NOW).auto, 0);
  fs.writeFileSync(file, '{not json', 'utf8');
  assert.equal(loadUsage(file, NOW).auto, 0);
  saveUsage(file, usage);
  assert.equal(loadUsage(file, NOW + 26 * 60 * 60 * 1000).auto, 0);
  assert.equal(loadUsage(file, NOW + 26 * 60 * 60 * 1000).history.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

t('matchScene 对空文本/空场景安全', () => {
  assert.equal(matchScene('', cfg.scenes), null);
  assert.equal(matchScene('晚安', []), null);
});

t('自动语音念日语台词，并带中文翻译字幕', () => {
  const d = decideAutoVoice({ text: '晚安啦', cfg, usage: null, now: NOW });
  assert.equal(d.ok, true);
  assert.match(d.spoken, /[\u3040-\u30ff]/u);
  assert.ok(d.translation.length > 0);
  assert.match(d.sourceText, /晚安啦/);
});

t('台词按 mood 当天已用次数轮换（同输入不同用法轮换，不每晚同一句）', () => {
  const first = decideAutoVoice({ text: '晚安啦', cfg, usage: null, now: NOW });
  const second = decideAutoVoice({
    text: '晚安啦',
    cfg,
    usage: { date: todayKey(NOW), auto: 1, manual: 0, byMood: { calm: 1 }, lastAutoAt: 0, history: [] },
    now: NOW
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.spoken, second.spoken);
  assert.notEqual(first.translation, second.translation);
});

t('早安和晚安同属 calm，但台词不同', () => {
  const night = decideAutoVoice({ text: '晚安', cfg, usage: null, now: NOW });
  const morning = decideAutoVoice({ text: '早安', cfg, usage: null, now: NOW });
  assert.equal(night.mood, 'calm');
  assert.equal(morning.mood, 'calm');
  assert.notEqual(night.spoken, morning.spoken);
});

t('自定义场景没写台词时回落到同关键词默认台词', () => {
  const custom = normalizeAutoVoiceConfig({ scenes: [{ mood: 'calm', keywords: ['晚安'] }] });
  const d = decideAutoVoice({ text: '晚安啦', cfg: custom, usage: null, now: NOW });
  assert.equal(d.ok, true);
  assert.match(d.spoken, /[\u3040-\u30ff]/u);
});

console.log(cases.join('\n'));
console.log(`\n${pass}/${cases.length} 项通过`);
