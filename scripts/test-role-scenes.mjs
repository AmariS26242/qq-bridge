// 人格卡「核心 / 场景」拆分（方案 A）的离线单测。
// 保证：wake 选择只取核心 + 命中场景、场景名可枚举、真实卡片拆分后仍可用、token 预算可控。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { listRoleScenes, selectRoleText } from '../src/role-card.js';

const CARD = [
  '# 角色卡：测试',
  '',
  '## 一、你是谁',
  '- 你是群里的测试角色。',
  '',
  '## 核心 · 每轮必看',
  '- 短、口语化、别装客服。',
  '',
  '## 场景：情绪倾诉',
  '- 别宣布共情，问具体的事。',
  '',
  '## 场景：求推荐',
  '- 先反问。',
  '',
  '## 场景：冷场',
  '- 别喊有人吗。',
].join('\n');

test('wake 选择：未给场景时只取核心小节', () => {
  const wake = selectRoleText(CARD, 'v2', { only: 'wake' });
  assert.match(wake, /短、口语化/);
  assert.doesNotMatch(wake, /别宣布共情/);
  assert.doesNotMatch(wake, /先反问/);
  assert.doesNotMatch(wake, /你是群里的测试角色/); // 未标记的普通小节不进每轮注入
});

test('wake 选择：命中场景才插入对应片段', () => {
  const wake = selectRoleText(CARD, 'v2', { only: 'wake', scenes: ['情绪倾诉'] });
  assert.match(wake, /短、口语化/);
  assert.match(wake, /别宣布共情/);
  assert.doesNotMatch(wake, /先反问/);
});

test('wake 选择：多个场景按给定集合全部插入', () => {
  const wake = selectRoleText(CARD, 'v2', { only: 'wake', scenes: ['求推荐', '冷场'] });
  assert.match(wake, /先反问/);
  assert.match(wake, /别喊有人吗/);
  assert.doesNotMatch(wake, /别宣布共情/);
});

test('includeCore=false 时只取场景片段', () => {
  const only = selectRoleText(CARD, 'v2', { only: 'wake', scenes: ['求推荐'], includeCore: false });
  assert.match(only, /先反问/);
  assert.doesNotMatch(only, /短、口语化/);
});

test('不带 options 时行为与改造前一致（整卡注入）', () => {
  const all = selectRoleText(CARD, 'v2');
  for (const needle of ['你是群里的测试角色', '短、口语化', '别宣布共情', '先反问', '别喊有人吗']) {
    assert.ok(all.includes(needle), `整卡应包含：${needle}`);
  }
});

test('listRoleScenes 能枚举场景名并去重', () => {
  assert.deepEqual(listRoleScenes(CARD), ['情绪倾诉', '求推荐', '冷场']);
});

test('真实人格卡：核心 + 场景存在，wake 文本远小于整卡', () => {
  const raw = fs.readFileSync(new URL('../roles/小鲸鱼.md', import.meta.url), 'utf8');
  const scenes = listRoleScenes(raw, 'v2');
  assert.ok(scenes.length >= 6, `场景太少：${scenes.join(',')}`);
  const full = selectRoleText(raw, 'v2');
  const wake = selectRoleText(raw, 'v2', { only: 'wake', scenes: ['情绪倾诉', '群聊接梗'] });
  assert.ok(wake.length > 200, 'wake 文本不能为空');
  assert.ok(wake.length < 2600, `wake 文本应控制在 2600 字符内，实际 ${wake.length}`);
  assert.ok(wake.length < full.length * 0.45, `wake 应明显短于整卡：${wake.length} vs ${full.length}`);
  // 完整卡里不能有残留的模式标记
  assert.doesNotMatch(full, /〔一代〕|〔二代〕/);
});
