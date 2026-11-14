import test from 'node:test';
import assert from 'node:assert/strict';
import { INLINE_MEDIA_MAX_MESSAGES, commitInlineMediaRefs, pickInlineMedia } from '../src/inline-media.js';

const OWNER = '100000001';
const ownerKey = `private:${OWNER}`;
const cfg = { ownerQQ: OWNER, socialV2: { context: {} } };

const img = (n) => ({ kind: 'image', url: `https://example.com/${n}.png`, subType: '1' });
const msg = (id, media = []) => ({ messageId: id, seq: Number(id), media });

test('非主人私聊：群聊和别人的私聊都不内联', () => {
  const st = { unread: [msg('1', [img('a')])] };
  assert.deepEqual(pickInlineMedia({ key: 'group:123', st, cfg }), { media: [], refs: [] });
  assert.deepEqual(pickInlineMedia({ key: 'private:999999', st, cfg }), { media: [], refs: [] });
  assert.deepEqual(pickInlineMedia({ key: 'private:', st, cfg }), { media: [], refs: [] });
});

test('没配 ownerQQ 时不内联（防止误判成所有人）', () => {
  const st = { unread: [msg('1', [img('a')])] };
  assert.deepEqual(pickInlineMedia({ key: 'private:123', st, cfg: { socialV2: { context: {} } } }), { media: [], refs: [] });
});

test('主人私聊有图：媒体原样带出，ref 用 messageId', () => {
  const st = { unread: [msg('42', [img('a')])] };
  const out = pickInlineMedia({ key: ownerKey, st, cfg });
  assert.equal(out.media.length, 1);
  assert.equal(out.media[0].url, 'https://example.com/a.png');
  assert.deepEqual(out.refs, ['42']);
});

test('没有 messageId 时退化成 seq 作为 ref', () => {
  const st = { unread: [{ seq: 7, media: [img('a')] }] };
  assert.deepEqual(pickInlineMedia({ key: ownerKey, st, cfg }), { media: [img('a')], refs: ['7'] });
});

test('没图的未读不产生 ref', () => {
  const st = { unread: [msg('1', []), msg('2')] };
  assert.deepEqual(pickInlineMedia({ key: ownerKey, st, cfg }), { media: [], refs: [] });
});

test('inlineOwnerImages=false 时彻底关闭', () => {
  const st = { unread: [msg('1', [img('a')])] };
  const off = { ownerQQ: OWNER, socialV2: { context: { inlineOwnerImages: false } } };
  assert.deepEqual(pickInlineMedia({ key: ownerKey, st, cfg: off }), { media: [], refs: [] });
});

test('已经附过的消息不再重复附（inlinedMediaRefs 去重）', () => {
  const st = { unread: [msg('1', [img('a')])], inlinedMediaRefs: ['1'] };
  assert.deepEqual(pickInlineMedia({ key: ownerKey, st, cfg }), { media: [], refs: [] });
});

test('只取最后 N 条带媒体的未读，更早的带图消息不动', () => {
  const st = { unread: [msg('1', [img('a')]), msg('2', []), msg('3', [img('b')]), msg('4', [img('c')])] };
  const out = pickInlineMedia({ key: ownerKey, st, cfg, maxMessages: INLINE_MEDIA_MAX_MESSAGES });
  assert.equal(out.media.length, 2);
  assert.deepEqual(out.refs, ['3', '4']);
});

test('媒体总数受 maxMedia 上限约束，且至少附上一张的消息才记 ref', () => {
  const st = { unread: [msg('1', [img('a')]), msg('2', [img('b'), img('c'), img('d')])] };
  const out = pickInlineMedia({ key: ownerKey, st, cfg, maxMedia: 2 });
  assert.equal(out.media.length, 2);
  assert.deepEqual(out.refs, ['1', '2']);

  // 上限刚好在两条消息之间用尽时，后一条完全没附，不记 ref（下次还能补）
  const st2 = { unread: [msg('1', [img('a')]), msg('2', [img('b')])] };
  const out2 = pickInlineMedia({ key: ownerKey, st: st2, cfg, maxMedia: 1 });
  assert.equal(out2.media.length, 1);
  assert.deepEqual(out2.refs, ['1']);
});

test('表情（face）也能内联', () => {
  const st = { unread: [msg('9', [{ kind: 'face', faceId: '123' }])] };
  const out = pickInlineMedia({ key: ownerKey, st, cfg });
  assert.deepEqual(out.media, [{ kind: 'face', faceId: '123' }]);
});

test('commitInlineMediaRefs 去重、追加末尾、返回是否变化', () => {
  const st = { inlinedMediaRefs: ['1'] };
  assert.equal(commitInlineMediaRefs(st, ['1']), false);
  assert.deepEqual(st.inlinedMediaRefs, ['1']);
  assert.equal(commitInlineMediaRefs(st, ['2', '2']), true);
  assert.deepEqual(st.inlinedMediaRefs, ['1', '2']);
  assert.equal(commitInlineMediaRefs(st, []), false);
  assert.equal(commitInlineMediaRefs(st, null), false);
});

test('commitInlineMediaRefs 只保留最近 keepRefs 条', () => {
  const st = {};
  commitInlineMediaRefs(st, ['1', '2', '3'], { keepRefs: 2 });
  assert.deepEqual(st.inlinedMediaRefs, ['2', '3']);
});

test('非法 st 不抛错', () => {
  assert.deepEqual(pickInlineMedia({ key: ownerKey, st: null, cfg }), { media: [], refs: [] });
  assert.equal(commitInlineMediaRefs(null, ['1']), false);
});
