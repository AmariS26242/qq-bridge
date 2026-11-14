// 唤醒前历史预取（src/wake-history.mjs）的离线单测。
// 保证：配置归一化不炸、去重/排除/取尾部条数正确、自己说的话保留（不能被当成对方）、
// 字数超限时从最旧开始丢、没有可用消息时返回空串（唤醒提示词不加空段落）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WAKE_HISTORY_DEFAULTS, formatWakeHistoryBlock, normalizeWakeHistoryConfig, selectWakeHistory } from '../src/wake-history.mjs';

const row = (id, at, text, extra = {}) => ({ messageId: String(id), at, senderId: '100000001', senderName: '26242', text, ...extra });

test('配置归一化：默认值、关闭、越界夹紧、脏值回落', () => {
  assert.deepEqual(normalizeWakeHistoryConfig(undefined), { ...WAKE_HISTORY_DEFAULTS });
  assert.equal(normalizeWakeHistoryConfig(false).enabled, false);
  assert.equal(normalizeWakeHistoryConfig({ enabled: false }).enabled, false);
  const clamped = normalizeWakeHistoryConfig({ count: 999, timeoutMs: 1, maxChars: 99999, cooldownMs: -5 });
  assert.equal(clamped.count, 50);
  assert.equal(clamped.timeoutMs, 300);
  assert.equal(clamped.maxChars, 6000);
  assert.equal(clamped.cooldownMs, 0);
  const dirty = normalizeWakeHistoryConfig({ count: 'abc', timeoutMs: null });
  assert.equal(dirty.count, WAKE_HISTORY_DEFAULTS.count);
  assert.equal(dirty.timeoutMs, WAKE_HISTORY_DEFAULTS.timeoutMs);
});

test('历史筛选：丢已见/重复/空文本，保留自己说的，按时间取最新 count 条', () => {
  const messages = [
    row(1, 1000, '最早的'),
    row(2, 2000, '  '),                       // 空文本
    row(3, 3000, '已见过的'),                   // knownIds
    { messageId: '', at: 3500, text: '没 id' }, // 无法去重
    row(4, 4000, '重复的'),
    row(4, 4000, '重复的'),
    row(5, 5000, '我上次说的话', { senderId: '1817346375', isSelf: true }),
    row(6, 6000, '最新一条'),
  ];
  const out = selectWakeHistory(messages, { knownIds: ['3'], count: 3, selfId: '1817346375' });
  assert.deepEqual(out.map((m) => m.text), ['重复的', '我上次说的话', '最新一条']);
  assert.deepEqual(out.map((m) => m.messageId), ['4', '5', '6']);
  assert.equal(out[1].isSelf, true, '自己发的话要保留并标记 isSelf');

  // selfId 兜底：senderId 命中即算自己，即使 isSelf 没标
  const fallback = selectWakeHistory([row(9, 1000, 'hi', { senderId: '999' })], { selfId: '999' });
  assert.equal(fallback[0].isSelf, true);

  // 时间缺失的排最前，且仍受 count 截断
  const noTime = selectWakeHistory([{ messageId: 'a', text: '无时间' }, row('b', 1000, '有时间')], { count: 1 });
  assert.deepEqual(noTime.map((m) => m.messageId), ['b']);
});

test('渲染：带抬头、自己写成“我”、当天只显示时分、跨天带月日', () => {
  const now = new Date(2026, 9, 25, 18, 0, 0).getTime();
  const today = new Date(2026, 9, 25, 17, 24, 0).getTime();
  const earlier = new Date(2026, 9, 24, 9, 5, 0).getTime();
  const block = formatWakeHistoryBlock([
    { at: earlier, senderName: '26242', text: '昨天的' },
    { at: today, senderName: '小鲸鱼', isSelf: true, text: '我发的' },
  ], { now });
  assert.match(block, /【醒来前最近对话】/);
  assert.match(block, /10-24 09:05 26242：昨天的/);
  assert.match(block, /17:24 我：我发的/);
  assert.equal(formatWakeHistoryBlock([], {}), '');
  assert.equal(formatWakeHistoryBlock([{ at: 1, text: '   ' }], {}), '');
});

test('渲染：超出字数上限时从最旧的开始丢，只留最新的', () => {
  const now = new Date(2026, 9, 25, 18, 0, 0).getTime();
  const rows = Array.from({ length: 12 }, (_, i) => ({ at: now - (12 - i) * 60000, senderName: 'A', text: `第${i + 1}条消息` }));
  const block = formatWakeHistoryBlock(rows, { maxChars: 200, now });
  assert.ok(block.length <= 200, `实际 ${block.length}`);
  assert.match(block, /第12条消息/);
  assert.doesNotMatch(block, /第1条消息/);
});
