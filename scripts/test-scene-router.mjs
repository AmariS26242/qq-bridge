// 场景路由（src/scene-router.js）的离线单测。
// 保证：常见场景能被正确识别、误报可控、场景名与人格卡一致、上限生效。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SCENE_NAMES, routeScenes } from '../src/scene-router.js';
import { listRoleScenes } from '../src/role-card.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const at = (minutesAgo) => Date.now() - minutesAgo * 60000;

test('情绪倾诉：分手/难受能命中', () => {
  const out = routeScenes([{ text: '我分手了 好难受', time: at(1) }], { isGroup: true, hour: 15 });
  assert.ok(out.scenes.includes('情绪倾诉'), JSON.stringify(out));
});

test('被问是不是AI：命中且优先于其它', () => {
  const out = routeScenes([{ text: '你是机器人吧', time: at(1) }], { isGroup: true, hour: 15 });
  assert.equal(out.scenes[0], '被问是不是AI');
});

test('求推荐 与 被怼', () => {
  const a = routeScenes([{ text: '来点推荐 最近有啥好看', time: at(1) }], { isGroup: true, hour: 15 });
  assert.ok(a.scenes.includes('求推荐'), JSON.stringify(a));
  const b = routeScenes([{ text: '闭嘴吧你 垃圾', time: at(1) }], { isGroup: true, hour: 15 });
  assert.ok(b.scenes.includes('被怼'), JSON.stringify(b));
});

test('正经问题：长句命中，短句（咋了？）不命中', () => {
  const long = routeScenes([{ text: '这个部署一直报错 怎么解决', time: at(1) }], { isGroup: true, hour: 15 });
  assert.ok(long.scenes.includes('正经问题'), JSON.stringify(long));
  const short = routeScenes([{ text: '咋了？', time: at(1) }], { isGroup: true, hour: 15 });
  assert.ok(!short.scenes.includes('正经问题'), JSON.stringify(short));
});

test('冷场：群聊安静超过阈值才命中', () => {
  const quiet = routeScenes([{ text: '随便说说', time: at(40) }], { isGroup: true, hour: 15, silenceMinutes: 40 });
  assert.ok(quiet.scenes.includes('冷场'), JSON.stringify(quiet));
  const busy = routeScenes([{ text: '随便说说', time: at(1) }], { isGroup: true, hour: 15, silenceMinutes: 1 });
  assert.ok(!busy.scenes.includes('冷场'), JSON.stringify(busy));
});

test('深夜：凌晨命中', () => {
  const out = routeScenes([{ text: '还没睡', time: at(1) }], { isGroup: true, hour: 2 });
  assert.ok(out.scenes.includes('深夜'), JSON.stringify(out));
});

test('maxScenes 生效，最多返回配置的条数', () => {
  const out = routeScenes(
    [{ text: '我分手了 好难受', time: at(1) }, { text: '你是机器人吧', time: at(0) }],
    { isGroup: true, hour: 2, maxScenes: 1 },
  );
  assert.equal(out.scenes.length, 1);
});

test('空输入不崩，群里热闹时给接梗兜底', () => {
  assert.doesNotThrow(() => routeScenes([], {}));
  const busy = routeScenes(
    [
      { text: '哈哈哈', time: at(3) },
      { text: '草', time: at(2) },
      { text: '笑死', time: at(1) },
    ],
    { isGroup: true, hour: 15 },
  );
  assert.ok(busy.scenes.includes('群聊接梗'), JSON.stringify(busy));
});

test('私聊没有明显信号时按情绪倾诉兜底', () => {
  const out = routeScenes([{ text: '在吗', time: at(1) }], { isGroup: false, hour: 15 });
  assert.ok(out.scenes.includes('情绪倾诉'), JSON.stringify(out));
});

test('路由出的场景名必须都存在于人格卡（否则那段永远不会被选中）', () => {
  const card = fs.readFileSync(path.join(root, 'roles', '小鲸鱼.md'), 'utf8');
  const inCard = listRoleScenes(card, 'v2');
  for (const name of SCENE_NAMES) {
    assert.ok(inCard.includes(name), `人格卡缺少场景「${name}」，现有：${inCard.join('、')}`);
  }
});
