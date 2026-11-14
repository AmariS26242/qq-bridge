// 断线补拉（src/catch-up.mjs）的离线单测。
// 只测纯函数：历史消息解析 + 补拉筛选，不连 OneBot、不写任何文件。
// 用法：node scripts/test-catch-up.mjs   失败时 exit 1。
import assert from 'node:assert/strict';
import { CATCH_UP_DEFAULTS, oneBotTimeToMs, parseOneBotHistory, planCatchUp } from '../src/catch-up.mjs';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.error(`FAIL ${name}`);
    console.error(`     ${error?.message ?? error}`);
  }
}

// ── 时间与解析 ──────────────────────────────────────────────────────────────
check('oneBotTimeToMs: 秒转毫秒，毫秒保持不变，非法值归零', () => {
  assert.equal(oneBotTimeToMs(1690000000), 1690000000000);
  assert.equal(oneBotTimeToMs(1690000000123), 1690000000123);
  assert.equal(oneBotTimeToMs(0), 0);
  assert.equal(oneBotTimeToMs('-1'), 0);
  assert.equal(oneBotTimeToMs(undefined), 0);
});

check('parseOneBotHistory: 解析 data.messages，段数组只拼 text 段，raw_message 兜底', () => {
  const payload = {
    status: 'ok',
    retcode: 0,
    data: {
      messages: [
        {
          message_id: 101,
          time: 1690000000,
          sender: { user_id: 2001, card: '群名片', nickname: '昵称' },
          message: [
            { type: 'text', data: { text: '你好 ' } },
            { type: 'image', data: { file: 'x.jpg' } },
            { type: 'at', data: { qq: '3001' } },
            { type: 'text', data: { text: '世界' } }
          ]
        },
        {
          message_id: 102,
          time: 1690000001,
          sender: { user_id: 2002, nickname: '无名片' },
          message: [{ type: 'image', data: { file: 'y.jpg' } }],
          raw_message: '兜底[CQ:face,id=1]文本'
        }
      ]
    }
  };
  const parsed = parseOneBotHistory(payload);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    messageId: '101',
    at: 1690000000000,
    senderId: '2001',
    senderName: '群名片',
    text: '你好 世界',
    isSelf: false,
    raw: payload.data.messages[0]
  });
  assert.equal(parsed[1].senderName, '无名片');
  assert.equal(parsed[1].text, '兜底文本', 'raw_message 去掉 CQ 码');
});

check('parseOneBotHistory: 兼容裸数组与 messages 顶层字段', () => {
  const rows = [
    { messageId: 1, at: 1690000000000, sender_id: 9, sender_name: '甲', message: '纯文本' },
    { message_id: 2, time: 1690000001, sender: { user_id: 10, card: '乙' }, message: '第二条' }
  ];
  assert.equal(parseOneBotHistory(rows).length, 2);
  assert.equal(parseOneBotHistory({ messages: rows }).length, 2);
  assert.equal(parseOneBotHistory(null).length, 0);
  assert.equal(parseOneBotHistory([]).length, 0);
});

check('parseOneBotHistory: selfId 命中时 isSelf=true', () => {
  const parsed = parseOneBotHistory({
    data: { messages: [{ message_id: 5, time: 1690000000, sender: { user_id: 999 }, message: '我自己' }] }
  }, { selfId: 999 });
  assert.equal(parsed[0].isSelf, true);
});

check('parseOneBotHistory: 未显式给 selfId 时读取 payload.self_id', () => {
  const parsed = parseOneBotHistory({
    self_id: 999,
    data: { messages: [{ message_id: 6, time: 1690000000, sender: { user_id: 999 }, message: '我自己' }] }
  });
  assert.equal(parsed[0].isSelf, true);
});

check('parseOneBotHistory: 无 id 且无文本的条目丢弃', () => {
  const parsed = parseOneBotHistory({
    data: { messages: [{ time: 1690000000, sender: { user_id: 1 }, message: [] }] }
  });
  assert.equal(parsed.length, 0);
});

// ── 补拉筛选 ────────────────────────────────────────────────────────────────
function msg(id, at, senderId = '2001', text = `m${id}`, extra = {}) {
  return { messageId: String(id), at, senderId, senderName: `用户${senderId}`, text, ...extra };
}

check('planCatchUp: 过滤自己发的、已见过的、断线前的、重复的', () => {
  const now = 1690001000000;
  const lastSeenAt = 1690000000000; // 断线时刻
  const messages = [
    msg(1, lastSeenAt - 10_000),            // 断线前，丢
    msg(2, lastSeenAt + 1_000),             // fresh
    msg(3, lastSeenAt + 2_000, '999'),      // 自己，丢
    msg(4, lastSeenAt + 3_000, '2001', 'm4', { isSelf: true }), // 自己，丢
    msg(5, lastSeenAt + 4_000),             // fresh
    msg(5, lastSeenAt + 4_500),             // 重复 id，丢
    msg(7, lastSeenAt + 5_000),             // 已见 id，丢
    msg(8, lastSeenAt + 6_000),             // fresh
    null,                                    // 非法，丢
    { messageId: '', at: lastSeenAt + 7_000 } // 无 id，丢
  ];
  const { fresh, dropped } = planCatchUp({
    key: 'group:1',
    lastSeenMessageId: 7,
    lastSeenAt,
    messages,
    now,
    selfId: '999',
    seenIds: ['3']
  });
  assert.deepEqual(fresh.map((m) => m.messageId), ['2', '5', '8']);
  assert.equal(dropped, 7);
});

check('planCatchUp: 按时间升序返回，超过 maxCount 只取最新', () => {
  const now = 1690001000000;
  const messages = [
    msg(30, now - 1000),
    msg(10, now - 5000),
    msg(20, now - 3000)
  ];
  const { fresh, dropped } = planCatchUp({ messages, now, maxCount: 2 });
  assert.deepEqual(fresh.map((m) => m.messageId), ['20', '30']);
  assert.equal(dropped, 1);
});

check('planCatchUp: 默认 maxCount=50', () => {
  assert.equal(CATCH_UP_DEFAULTS.maxCount, 50);
  const now = 1690001000000;
  const messages = [];
  for (let i = 1; i <= 60; i++) messages.push(msg(i, now - (60 - i) * 1000));
  const { fresh, dropped } = planCatchUp({ messages, now });
  assert.equal(fresh.length, 50);
  assert.equal(fresh[0].messageId, '11');
  assert.equal(fresh[49].messageId, '60');
  assert.equal(dropped, 10);
});

check('planCatchUp: 空输入与无 lastSeenAt 时不误杀', () => {
  assert.deepEqual(planCatchUp({}), { fresh: [], dropped: 0 });
  const now = 1690001000000;
  const { fresh } = planCatchUp({ messages: [msg(1, now - 60_000)], now });
  assert.equal(fresh.length, 1);
});

check('planCatchUp: 时间明显超前（时钟异常）的丢弃', () => {
  const now = 1690001000000;
  const { fresh, dropped } = planCatchUp({
    messages: [msg(1, now + 6 * 60_000), msg(2, now - 1000)],
    now
  });
  assert.deepEqual(fresh.map((m) => m.messageId), ['2']);
  assert.equal(dropped, 1);
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.error(`FAIL ${failed.length} 项`);
  process.exit(1);
}
