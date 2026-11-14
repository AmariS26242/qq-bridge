// few-shot 正例库（src/fewshot-lib.js + scripts/fewshot-import.mjs）的离线单测。
// 保证：三种素材格式都能解析、坏行不炸、相似度检索不乱序、去重/排除/上限都生效。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  formatFewshotBlock,
  loadFewshot,
  looksLikeQqBak,
  mergeExamples,
  normalizeExample,
  parseChatPaste,
  parseQqExport,
  parseRawMarkdown,
  retrieveFewshot,
  toJsonl,
} from '../src/fewshot-lib.js';

const RAW = [
  '# 分手 情绪',
  '群友：我分手了',
  '我：？ 谁提的',
  '',
  '群友：来点推荐',
  '我：？ 你要啥推荐',
  '',
  '# 没标签的一组',
  '对方：在吗',
  '我：说事',
].join('\n');

test('raw 手写格式：标签+对话能解析，最后一行为回复', () => {
  const { examples, errors } = parseRawMarkdown(RAW);
  assert.equal(errors.length, 0, errors.join(';'));
  assert.equal(examples.length, 3);
  assert.equal(examples[0].reply, '？ 谁提的');
  assert.deepEqual(examples[0].tags, ['分手', '情绪']);
  assert.equal(examples[0].context[0].text, '我分手了');
  assert.equal(examples[2].reply, '说事');
});

test('raw 手写格式：没有「我：」的行只报错不崩', () => {
  const { examples, errors } = parseRawMarkdown('群友：只有对方说话\n');
  assert.equal(examples.length, 0);
  assert.equal(errors.length, 1);
});

test('QQ 导出格式：相邻不同人消息自动配对', () => {
  const txt = [
    '消息记录（此消息记录为文本格式，不支持重新导入）',
    '================================================================',
    '消息分组:我的好友',
    '================================================================',
    '消息对象:群友A',
    '================================================================',
    '2024-05-01 12:00:00 群友A(10001)',
    '最近好累啊',
    '',
    '2024-05-01 12:00:05 我(20002)',
    '多大了 还累',
    '',
    '2024-05-01 12:00:10 群友A(10001)',
    '[表情]',
    '',
    '2024-05-01 12:00:20 群友A(10001)',
    '哈哈哈哈',
    '',
    '2024-05-01 12:00:25 我(20002)',
    '笑点在哪',
  ].join('\n');
  const { examples } = parseQqExport(txt);
  const replies = examples.map((item) => item.reply);
  assert.ok(replies.includes('多大了 还累'), replies.join('|'));
  assert.ok(replies.includes('笑点在哪'));
  // 同一个人连发两条（含表情）不应被配对成回复
  assert.ok(!replies.includes('哈哈哈哈'));
});

test('QQ 导出格式：长回复/链接被跳过', () => {
  const long = '太长'.repeat(80);
  const txt = [
    '2024-05-01 12:00:00 A(1)',
    '在吗',
    '2024-05-01 12:00:05 B(2)',
    long,
    '2024-05-01 12:00:10 A(1)',
    '看这个',
    '2024-05-01 12:00:15 B(2)',
    'https://example.com/x',
  ].join('\n');
  const { examples } = parseQqExport(txt, { selfNames: ['B'] });
  assert.equal(examples.length, 0);
});

test('QQ 导出格式：认不出「我」时明确报错，不瞎配对', () => {
  const txt = ['2024-05-01 12:00:00 A(1)', '在吗', '2024-05-01 12:00:05 B(2)', '说事'].join('\n');
  const { examples, errors } = parseQqExport(txt, { selfNames: ['不存在的昵称'] });
  assert.equal(examples.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /--me/);
});

test('同一内容重复导入不会重复（id 稳定）', () => {
  const a = normalizeExample({ context: [{ role: 'other', text: '在吗' }], reply: '说事' });
  const b = normalizeExample({ context: [{ role: 'other', text: '在吗' }], reply: '说事' });
  assert.equal(a.id, b.id);
  assert.equal(mergeExamples([a], [b]).length, 1);
});

test('相似度检索：把最像的那条排在前面', () => {
  const { examples } = parseRawMarkdown(RAW);
  const picked = retrieveFewshot(examples, ['我分手了 好难受'], { max: 1, maxChars: 200 });
  assert.equal(picked[0].reply, '？ 谁提的');
});

test('相似度检索：排除最近用过的 id', () => {
  const { examples } = parseRawMarkdown(RAW);
  const first = retrieveFewshot(examples, ['我分手了'], { max: 1, maxChars: 200 });
  const second = retrieveFewshot(examples, ['我分手了'], { max: 1, maxChars: 200, excludeIds: [first[0].id] });
  assert.notEqual(first[0].id, second[0].id);
});

test('相似度检索：maxChars 生效，块不会超长', () => {
  const { examples } = parseRawMarkdown(RAW);
  const picked = retrieveFewshot(examples, ['在吗'], { max: 8, maxChars: 40 });
  const block = formatFewshotBlock(picked);
  assert.ok(block.length <= 40 + 30, `块长度 ${block.length}`);
});

test('无匹配时给一条兜底样本，空库返回空串', () => {
  const { examples } = parseRawMarkdown(RAW);
  const fallback = retrieveFewshot(examples, ['完全无关的一句话'], { max: 3, maxChars: 300 });
  assert.equal(fallback.length, 1);
  assert.equal(formatFewshotBlock([]), '');
});

test('loadFewshot：目录不存在时静默降级', () => {
  const dir = path.join(os.tmpdir(), `fewshot-missing-${Date.now()}`);
  const lib = loadFewshot(dir);
  assert.equal(lib.examples.length, 0);
  assert.equal(lib.errors.length, 0);
});

test('loadFewshot：读 JSONL 并统计坏行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fewshot-'));
  const good = normalizeExample({ context: [{ role: 'other', text: '在吗' }], reply: '说事' });
  fs.writeFileSync(path.join(dir, 'examples.jsonl'), `${toJsonl([good])}{bad json}\n`);
  const lib = loadFewshot(dir);
  assert.equal(lib.examples.length, 1);
  assert.equal(lib.errors.length, 1);
});

test('parseChatPaste：名字：内容 直接配对', () => {
  const text = [
    '我：在干嘛',
    '对方：刚下班 累死',
    '我：要不要一起吃面',
    '对方：算了 不想动',
  ].join('\n');
  const { examples } = parseChatPaste(text);
  assert.equal(examples.length, 1);
  assert.equal(examples[0].reply, '要不要一起吃面');
  assert.equal(examples[0].context[0].text, '刚下班 累死');
});

test('parseChatPaste：多行消息拼到上一个说话人', () => {
  const text = ['对方：跟你说个事', '特别长的一段', '我：说'].join('\n');
  const { examples } = parseChatPaste(text);
  assert.equal(examples.length, 1);
  assert.ok(examples[0].context[0].text.includes('特别长的一段'));
});

test('parseChatPaste：没有我说话的行就报错，不瞎猜', () => {
  const { examples, errors } = parseChatPaste('对方：在吗\n对方：人呢');
  assert.equal(examples.length, 0);
  assert.ok(errors[0].includes('没找到'));
});

test('parseChatPaste：--me 指定昵称后能识别自己', () => {
  const text = ['鲸鱼：在吗', '群友：那你说', '鲸鱼：没事'].join('\n');
  const { examples } = parseChatPaste(text, { selfNames: ['鲸鱼'] });
  assert.equal(examples.length, 1);
  assert.equal(examples[0].reply, '没事');
});

test('looksLikeQqBak：识别 QQ 加密备份，普通 txt 不误判', () => {
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('SQLite header 3\0....', 'latin1')]);
  assert.equal(looksLikeQqBak(zip), 'zip-sqlite-encrypted');
  assert.equal(looksLikeQqBak(Buffer.from('2026-10-21 14:32:10 张三(123)\n在吗\n', 'utf8')), '');
});
