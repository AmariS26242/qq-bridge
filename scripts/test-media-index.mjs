// 媒体索引落盘的离线单测：不碰桥接、不碰网络，全部用临时目录。
//   node --test scripts/test-media-index.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MediaIndex } from '../src/media-index.js';
import { MEDIA_FAIL_SHORT, inlineMediaNote, mediaFailNote, mediaMissText, mediaPartialNote, mediaTooLargeNote } from '../src/media-note.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-index-test-'));
  return path.join(dir, 'media-index.jsonl');
}

const KEY = 'private:100000001';
const IMAGE = { kind: 'image', file: 'abc.image', url: 'https://example.com/a.png', subType: '0', summary: '一张图' };
const FACE = { kind: 'face', faceId: '178' };

test('首次启动：文件不存在也算正常', () => {
  const idx = new MediaIndex({ file: tmpFile() });
  const info = idx.load();
  assert.equal(info.loaded, 0);
  assert.equal(info.refs, 0);
  assert.equal(info.error, null);
  assert.equal(idx.find(KEY, '1'), null);
});

test('写入后可按 messageId 与 seq 取回', () => {
  const file = tmpFile();
  const idx = new MediaIndex({ file });
  idx.load();
  assert.equal(idx.record(KEY, ['1001', '42'], [IMAGE, FACE], 1_000), true);
  assert.deepEqual(idx.find(KEY, '1001'), [
    { kind: 'image', file: 'abc.image', url: 'https://example.com/a.png', subType: '0', summary: '一张图' },
    { kind: 'face', faceId: '178' },
  ]);
  assert.deepEqual(idx.find(KEY, '42'), idx.find(KEY, '1001'));
  assert.equal(idx.find('private:999', '1001'), null);
  assert.equal(idx.find(KEY, 'nope'), null);
  assert.equal(idx.size, 2);
});

test('重启后仍能取到（这正是 ⑪ 要修的 bug）', () => {
  const file = tmpFile();
  const first = new MediaIndex({ file });
  first.load();
  first.record(KEY, ['2002'], [IMAGE], 2_000);
  const second = new MediaIndex({ file });
  const info = second.load();
  assert.equal(info.loaded, 1);
  assert.equal(info.error, null);
  assert.equal(second.find(KEY, '2002')[0].file, 'abc.image');
});

test('同一条消息重投不会重复追加', () => {
  const file = tmpFile();
  const idx = new MediaIndex({ file });
  idx.load();
  idx.record(KEY, ['3003'], [IMAGE], 3_000);
  const before = fs.statSync(file).size;
  assert.equal(idx.record(KEY, ['3003'], [IMAGE], 3_001), false);
  assert.equal(fs.statSync(file).size, before);
  assert.equal(idx.size, 1);
});

test('坏行跳过、后写的行仍能读，并顺手重写干净文件', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ 半行坏数据\n{"t":1,"k":"private:1","refs":["9"],"media":[{"kind":"image","file":"x.png"}]}\n', 'utf8');
  const idx = new MediaIndex({ file });
  const info = idx.load();
  assert.equal(info.loaded, 1);
  assert.equal(info.rewritten, true);
  assert.equal(idx.find('private:1', '9')[0].file, 'x.png');
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.doesNotThrow(() => JSON.parse(lines[0]));
});

test('超过字节上限时自动滚动，保留最新的记录', () => {
  const file = tmpFile();
  const idx = new MediaIndex({ file, maxBytes: 16 * 1024 });
  idx.load();
  const big = { kind: 'image', file: 'f'.repeat(180), url: '', subType: '', summary: '' };
  for (let i = 0; i < 200; i += 1) idx.record(KEY, [String(5000 + i)], [big], 10_000 + i);
  const size = fs.statSync(file).size;
  assert.ok(size <= 16 * 1024 * 1.2, `文件应被压缩，实际 ${size}`);
  // 最新一条必须在
  assert.ok(idx.find(KEY, '5199'), '最新记录不能丢');
  // 重新加载后还能取到最新一条
  const reload = new MediaIndex({ file, maxBytes: 16 * 1024 });
  reload.load();
  assert.ok(reload.find(KEY, '5199'), '滚动后最新记录应已落盘');
});

test('内存索引有上限，最旧的句柄会被淘汰', () => {
  const file = tmpFile();
  const idx = new MediaIndex({ file, maxRefs: 50 });
  idx.load();
  for (let i = 0; i < 80; i += 1) idx.record(KEY, [`r${i}`], [IMAGE], 1_000 + i);
  assert.ok(idx.size <= 50, `内存里最多 50 个句柄，实际 ${idx.size}`);
  assert.equal(idx.find(KEY, 'r79')[0].kind, 'image', '最新的必须留着');
});

test('无效入参不落盘也不抛', () => {
  const file = tmpFile();
  const idx = new MediaIndex({ file });
  idx.load();
  assert.equal(idx.record(KEY, ['1'], []), false);
  assert.equal(idx.record(KEY, [], [IMAGE]), false);
  assert.equal(idx.record('bad-key', ['1'], [IMAGE]), false);
  assert.equal(idx.record(KEY, ['1'], [{ kind: 'video', file: 'x' }]), false);
  assert.equal(fs.existsSync(file), false);
});

test('只保留白名单字段，不把整段消息塞进索引', () => {
  const file = tmpFile();
  const idx = new MediaIndex({ file });
  idx.load();
  idx.record(KEY, ['4004'], [{ kind: 'image', file: 'a.png', url: 'u', subType: '0', summary: 's', raw: '不该出现', base64: 'xxx' }], 4_000);
  const row = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.deepEqual(row.media, [{ kind: 'image', file: 'a.png', url: 'u', subType: '0', summary: 's' }]);
  assert.equal(row.k, KEY);
  assert.deepEqual(row.refs, ['4004']);
});

test('文案：取不到就明说取不到，并禁止猜测', () => {
  assert.match(mediaFailNote(2, 'image'), /没取到/);
  assert.match(mediaFailNote(2, 'image'), /不要猜/);
  assert.match(mediaFailNote(1, 'face'), /表情1/);
  assert.match(mediaTooLargeNote(3, 'image'), /不要猜/);
  assert.match(MEDIA_FAIL_SHORT, /不要猜/);
  assert.match(mediaMissText('123', '该消息没有可读取的元数据'), /没有取到任何图片/);
  assert.match(mediaMissText('123'), /不要根据上下文猜/);
  assert.match(mediaPartialNote(2), /不要猜测/);
  assert.match(inlineMediaNote(3), /图片已随消息附上/);
  assert.match(inlineMediaNote(3), /3 张/);
  assert.match(inlineMediaNote(3), /不要按上下文猜/);
});
