// 交接兜底组装（buildHandoffFromRecent）的单元测试。
//
// 背景：交接的价值是「省上下文但保住连续性」。记忆区为空时，照记忆交出来是空壳，
// 所以要能用最近几条消息兜底拼一份；本文件把边界（长度/条数/emoji/确定性）全钉住。
import assert from 'node:assert/strict';
import { buildHandoffFromRecent, buildHandoffLine, HANDOFF_MAX_CHARS, normalizeHandoffPayload } from '../src/handoff.mjs';

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}\n     ${error?.message ?? error}`);
  }
}
const cpLen = (s) => [...s].length;
const hasLoneSurrogate = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
const msg = (text) => ({ text });

ok('正常三条消息 → ok，且有话题和未完', () => {
  const r = buildHandoffFromRecent([msg('明天要交报告'), msg('你帮我看看结构'), msg('好我看看先说结论')]);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.value.topics.length, 1);
  assert.equal(r.value.openLoops.length, 2);
  assert.match(r.value.topics[0], /^在聊：/);
  assert.ok(buildHandoffLine(r.value).length > 0);
});

ok('整份 payload 序列化不超过 400 字符', () => {
  const many = Array.from({ length: 6 }, (_, i) => msg(`第${i}条消息内容比较长一些用来撑长度`));
  const r = buildHandoffFromRecent(many);
  assert.equal(r.ok, true, r.reason);
  assert.ok(JSON.stringify(r.value).length <= HANDOFF_MAX_CHARS);
});

ok('空数组 / 空白消息 → no-messages', () => {
  assert.equal(buildHandoffFromRecent([]).reason, 'no-messages');
  assert.equal(buildHandoffFromRecent([msg('   '), msg('\n\t')]).reason, 'no-messages');
  assert.equal(buildHandoffFromRecent(null).reason, 'no-messages');
});

ok('单条超长消息被裁到 ≤40 码点', () => {
  const r = buildHandoffFromRecent([msg('唉'.repeat(200))]);
  assert.equal(r.ok, true, r.reason);
  for (const item of [...r.value.topics, ...r.value.openLoops]) {
    assert.ok(cpLen(item) <= 40, `item 长度 ${cpLen(item)} 超限`);
  }
});

ok('只取最后 6 条（新的在尾部）', () => {
  const list = Array.from({ length: 12 }, (_, i) => msg(`消息${i}`));
  const r = buildHandoffFromRecent(list);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.used.messages, 6);
  assert.ok(r.value.topics[0].includes('消息11'));
  assert.ok(!r.value.topics[0].includes('消息0'));
});

ok('重复消息去重后不算多条', () => {
  const r = buildHandoffFromRecent([msg('一样的话'), msg('一样的话'), msg('一样的话')]);
  assert.equal(r.ok, true, r.reason);
  const all = [...r.value.topics, ...r.value.openLoops];
  assert.equal(new Set(all).size, all.length);
});

ok('emoji 按码点裁剪，不产生孤立代理项', () => {
  const r = buildHandoffFromRecent([msg('🐳'.repeat(60))]);
  assert.equal(r.ok, true, r.reason);
  for (const item of [...r.value.topics, ...r.value.openLoops]) {
    assert.equal(hasLoneSurrogate(item), false, '出现孤立代理项');
    assert.ok(cpLen(item) <= 40);
  }
});

ok('maxMessages 生效且被夹到合法区间', () => {
  const list = Array.from({ length: 10 }, (_, i) => msg(`m${i}`));
  assert.equal(buildHandoffFromRecent(list, { maxMessages: 2 }).used.messages, 2);
  assert.equal(buildHandoffFromRecent(list, { maxMessages: 999 }).used.messages, 8);
  assert.equal(buildHandoffFromRecent(list, { maxMessages: 0 }).used.messages, 1);
});

ok('同一输入两次调用结果逐字段一致（确定性）', () => {
  const list = [msg('今天加班到十点'), msg('那明天别早起'), msg('嗯你也早点睡')];
  const a = buildHandoffFromRecent(list);
  const b = buildHandoffFromRecent(list);
  assert.deepEqual(a, b);
});

ok('产物能通过正式 normalize 校验，注入行 ≤600', () => {
  const r = buildHandoffFromRecent([msg('帮我看下这个报错'), msg('第一个是端口占用')]);
  assert.equal(r.ok, true, r.reason);
  const norm = normalizeHandoffPayload(r.value);
  assert.equal(norm.ok, true, norm.reason);
  const line = buildHandoffLine(r.value);
  assert.ok(line.startsWith('【上次交接】'));
  assert.ok(cpLen(line) <= 600);
});

ok('非对象元素与缺失字段不抛异常', () => {
  const r = buildHandoffFromRecent([null, undefined, 42, { plain: '普通兜底文本' }, { text: 123 }]);
  assert.equal(r.ok, true, r.reason);
  // 只接受字符串来源：null/undefined/数字/非字符串 text 一律丢弃，只剩 plain 那一条。
  assert.equal(r.used.messages, 1);
  assert.match(r.value.topics[0], /普通兜底文本/);
});

ok('兜底组装会走 scrub（原始聊天文本不能裸奔落盘）', () => {
  const scrub = (text) => String(text).replace(/\d{5,}/g, '[数字]');
  const r = buildHandoffFromRecent([msg('我的手机号 13800001111 你记一下')], { maxMessages: 3, scrub });
  assert.equal(r.ok, true, r.reason);
  assert.ok(!/13800001111/.test(JSON.stringify(r.value)), '长数字串必须被清洗');
  assert.match(r.value.topics[0], /\[数字\]/);
});

ok('maxChars 是真参数：传小预算时拒绝装不下的大摘要', () => {
  const long = msg('这是一段很长的最近消息'.repeat(6));
  const loose = buildHandoffFromRecent([long], { maxMessages: 2, maxChars: HANDOFF_MAX_CHARS });
  assert.equal(loose.ok, true, loose.reason);
  const tight = buildHandoffFromRecent([long], { maxMessages: 2, maxChars: 30 });
  // 30 字符预算装不下 topics + openLoops：要么成功且总长 ≤30，要么明确失败，不能超发。
  if (tight.ok) {
    assert.ok(JSON.stringify(tight.value).length <= 30, '超预算仍然成功');
  } else {
    assert.equal(tight.reason, 'too-large');
  }
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
