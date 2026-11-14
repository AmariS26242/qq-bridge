// 群友档案（长记忆）离线自测：不连 QQ、不连 DSH，纯跑 src/profiles.js。
// 用法：node scripts/test-profiles.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as m from '../src/profiles.js';

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass += 1; console.log(`✅ ${name}`); } catch (error) { console.log(`❌ ${name} — ${error?.message ?? error}`); process.exitCode = 1; }
};
const bad = (input, re, cfg = m.PROFILE_DEFAULTS) => {
  const store = m.emptyStore();
  const r = m.appendRecord(store, input, cfg);
  assert.equal(r.ok, false, `应被拒绝：${JSON.stringify(input)}`);
  assert.match(r.error, re);
  assert.equal(Object.keys(store.people).length, 0, '被拒绝时不能留下空档案');
};
const good = (input, cfg = m.PROFILE_DEFAULTS) => {
  const store = m.emptyStore();
  const r = m.appendRecord(store, input, cfg);
  assert.equal(r.ok, true, r.error);
  return { store, r };
};

console.log('--- 存储与归一化 ---');
ok('空 store 结构完整', () => {
  const s = m.emptyStore();
  assert.deepEqual(Object.keys(s).sort(), ['groups', 'meta', 'people', 'settle', 'version']);
});
ok('normalizeStore 清掉原型污染键', () => {
  const s = m.normalizeStore({ people: { __proto__: {}, constructor: {}, '123456': { personId: '123456', records: [] } } });
  assert.deepEqual(Object.keys(s.people), ['123456']);
});
ok('loadProfiles 文件损坏时重置且不抛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  const file = path.join(dir, 'profiles.json');
  fs.writeFileSync(file, '{坏掉的 json');
  let warned = '';
  const s = m.loadProfiles(file, { onCorrupt: (x) => { warned = x; } });
  assert.equal(Object.keys(s.people).length, 0);
  assert.match(warned, /读取失败/);
});
ok('saveProfiles 落盘后可完整读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  const file = path.join(dir, 'profiles.json');
  const s = m.emptyStore();
  m.appendRecord(s, { personId: '100000001', kind: 'event', text: '2026-10-19 测试落盘读回' });
  m.saveProfiles(file, s);
  const back = m.loadProfiles(file);
  assert.equal(Object.keys(back.people).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).meta.updatedAt.length > 0, true);
});

console.log('--- 输入校验（该拒绝的必须拒绝）---');
bad({ personId: 'abc', kind: 'event', text: '这是六个字以上的具体事例' }, /4-12/);
bad({ personId: '123', kind: 'event', text: '这是六个字以上的具体事例' }, /4-12/);
bad({ personId: '100000001', kind: 'bogus', text: '这是六个字以上的具体事例' }, /kind/);
bad({ personId: '100000001', kind: 'event', text: '太短' }, /太短/);
bad({ personId: '100000001', kind: 'event', text: '他' }, /空泛评价/);
bad({ personId: '100000001', kind: 'event', text: '他去了医院' }, /太短/);
bad({ personId: '100000001', kind: 'note', text: '他很温柔' }, /空泛/);
bad({ personId: '100000001', kind: 'note', text: '挺可爱的' }, /空泛/);
bad({ personId: '100000001', kind: 'note', text: '这人有点高冷' }, /空泛/);
bad({ personId: '100000001', kind: 'note', text: '手机号 13800138000' }, /敏感信息/);
bad({ personId: '100000001', kind: 'event', text: 'a'.repeat(200) }, /太长/);

console.log('--- 具体事例要能写进去 ---');
ok('带日期的具体事件', () => {
  const { r } = good({ personId: '100000001', kind: 'event', text: '2026-10-19 说要给机器人加定时提醒', at: '2026-10-19' });
  assert.equal(r.record.at, '2026-10-19');
  assert.equal(r.created, true);
});
ok('不贴标签的具体观察可以写', () => {
  good({ personId: '100000001', kind: 'style', text: '爱用括号补刀，例如「行吧（你开心就好）」' });
});
ok('重复内容合并并加权', () => {
  const { store, r } = good({ personId: '100000001', kind: 'event', text: '2026-10-19 说要加定时提醒' });
  const before = r.record.weightBase;
  const again = m.appendRecord(store, { personId: '100000001', kind: 'event', text: '2026-10-19 说要加定时提醒' }, m.PROFILE_DEFAULTS);
  assert.equal(again.created, false);
  assert.equal(again.record.id, r.record.id);
  assert.equal(again.record.seenCount, 2);
  assert.equal(again.record.weightBase > before, true);
});
ok('QQ 号以数字字符串也能识别', () => {
  const store = m.emptyStore();
  const r = m.appendRecord(store, { qq: 100000001, kind: 'note', text: '用数字类型的 qq 字段也能写入' }, m.PROFILE_DEFAULTS);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(Object.keys(store.people), ['100000001']);
});

console.log('--- 隐私脱敏 ---');
ok('手机号/身份证/邮箱/密码都脱敏', () => {
  const s = m.scrubSensitive('手机 13800138000 身份证 110101199001011234 邮箱 a.b@c.com 密码: hunter2');
  assert.match(s, /已隐去/);
  assert.equal(/13800138000|110101199001011234|a\.b@c\.com|hunter2/.test(s), false);
});
ok('住址与快递单号脱敏', () => {
  const s = m.scrubSensitive('住址：洛阳市涧西区某街道某小区 3 号楼 快递单号 SF1234567890');
  assert.equal(/涧西区|SF1234567890/.test(s), false);
});
ok('全是敏感信息的整条被拒（不留空壳记录）', () => {
  const store = m.emptyStore();
  const r = m.appendRecord(store, { personId: '100000001', kind: 'note', text: '13800138000' }, m.PROFILE_DEFAULTS);
  assert.equal(r.ok, false);
});

console.log('--- 查询 / 卡片 / 提示词 ---');
ok('queryPerson 按权重排序并带 weight', () => {
  const { store } = good({ personId: '100000001', kind: 'avoid', text: '明确说对猫毛过敏，别老提猫' });
  m.appendRecord(store, { personId: '100000001', kind: 'topic', text: '在准备软考高项，11 月 8 号考试' }, m.PROFILE_DEFAULTS);
  const q = m.queryPerson(store, '100000001', { cfg: m.PROFILE_DEFAULTS });
  assert.equal(q.ok, true);
  assert.equal(q.records.length, 2);
  assert.equal(q.records[0].kind, 'avoid', '雷点权重高于话题');
  assert.equal(typeof q.records[0].weight, 'number');
});
ok('queryPerson 非法 id 返回错误而不是空', () => {
  assert.equal(m.queryPerson(m.emptyStore(), 'abc').ok, false);
});
ok('listPeople 统计条数', () => {
  const { store } = good({ personId: '100000001', kind: 'event', text: '2026-10-19 第一条可写的事例' });
  m.appendRecord(store, { personId: '999000111', kind: 'event', text: '2026-10-19 第二条可写的事例' }, m.PROFILE_DEFAULTS);
  const list = m.listPeople(store);
  assert.equal(list.length, 2);
  assert.equal(list.reduce((n, p) => n + p.records, 0), 2);
});
ok('formatProfileCard 输出中文类别', () => {
  const { store } = good({ personId: '100000001', kind: 'avoid', text: '明确说对猫毛过敏，别老提猫' });
  const card = m.formatProfileCard(store, '100000001');
  assert.match(card, /【档案 · 100000001】/);
  assert.match(card, /雷点：/);
});
ok('formatProfilesForPrompt 严格限量', () => {
  const store = m.emptyStore();
  for (let i = 0; i < 12; i += 1) {
    m.appendRecord(store, { personId: String(2028765700 + i), kind: 'event', text: `2026-10-19 第 ${i} 条具体事例内容` }, m.PROFILE_DEFAULTS);
  }
  const block = m.formatProfilesForPrompt(store, Object.keys(store.people), { cfg: m.PROFILE_DEFAULTS });
  assert.ok(block.length <= m.PROFILE_DEFAULTS.injectMaxChars);
  const persons = (block.match(/【档案 · /g) ?? []).length;
  assert.ok(persons <= m.PROFILE_DEFAULTS.injectMaxPersons, `注入人数 ${persons} 超过上限`);
});
ok('legacy 记录不注入提示词但可查', () => {
  const store = m.emptyStore();
  m.migrateImpressions(store, { 100000001: { traits: ['很温柔', '爱猫'], interactionCount: 3 } });
  assert.equal(m.formatProfilesForPrompt(store, ['100000001'], { cfg: m.PROFILE_DEFAULTS }), '');
  assert.ok(m.queryPerson(store, '100000001', { cfg: m.PROFILE_DEFAULTS }).records.some((r) => r.kind === 'legacy'));
});

console.log('--- 群文化 ---');
ok('术语写入与计数', () => {
  const store = m.emptyStore();
  const a = m.appendGroupTerm(store, '123456789', { term: '小鲸鱼', meaning: '指机器人自己', kind: '称呼' });
  const b = m.appendGroupTerm(store, '123456789', { term: '小鲸鱼', kind: '称呼' });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.term.count, 2);
  assert.equal(m.storeStats(store).terms, 1);
});

console.log('--- 衰减 / 清理 / settle ---');
ok('半衰期后权重下降', () => {
  const store = m.emptyStore();
  const r = m.appendRecord(store, { personId: '100000001', kind: 'event', text: '2026-10-19 会被衰减的事例' });
  const rec = store.people['100000001'].records[0];
  const w0 = m.effectiveWeight(rec, Date.now(), m.PROFILE_DEFAULTS);
  const w1 = m.effectiveWeight(rec, Date.now() + 30 * 86400000, m.PROFILE_DEFAULTS);
  const w2 = m.effectiveWeight(rec, Date.now() + 60 * 86400000, m.PROFILE_DEFAULTS);
  assert.ok(w1 < w0 && w2 < w1, `${w0} > ${w1} > ${w2}`);
  assert.ok(r.ok);
});
ok('过期且权重低的记录被清理，人走空即删', () => {
  const store = m.emptyStore();
  m.appendRecord(store, { personId: '100000001', kind: 'note', text: '2026-10-19 会过期的事例', at: '2026-10-01' });
  const far = Date.now() + 400 * 86400000;
  const out = m.pruneStore(store, m.PROFILE_DEFAULTS, far);
  assert.ok(out.prunedRecords >= 1, '应清理至少一条');
  assert.equal(Object.keys(store.people).length, 0, '人走空后应删除该人');
});
ok('settle：安静够久且够条数才进候选', () => {
  const store = m.emptyStore();
  const t0 = Date.now() - 60 * 60000;
  m.touchSettle(store, 'private:100000001', { messageCount: 6, now: t0 });
  assert.equal(m.collectSettleCandidates(store, m.PROFILE_DEFAULTS, Date.now()).length, 1);
  m.touchSettle(store, 'group:123456789', { messageCount: 2, now: t0 });
  assert.equal(m.collectSettleCandidates(store, m.PROFILE_DEFAULTS, Date.now()).length, 1, '条数不够不该进候选');
  m.touchSettle(store, 'private:100000001', { messageCount: 1, now: Date.now() });
  assert.equal(m.collectSettleCandidates(store, m.PROFILE_DEFAULTS, Date.now()).length, 0, '刚说过话不该抽');
});
ok('settle：抽取后进入冷却', () => {
  const store = m.emptyStore();
  const t0 = Date.now() - 60 * 60000;
  m.touchSettle(store, 'private:100000001', { messageCount: 6, now: t0 });
  m.markSettled(store, 'private:100000001', { extracted: 3, ok: true });
  assert.equal(m.collectSettleCandidates(store, m.PROFILE_DEFAULTS, Date.now()).length, 0);
  assert.equal(store.settle['private:100000001'].pendingMessages, 0);
});
ok('settle：失败不清零待抽条数、累计失败次数', () => {
  const store = m.emptyStore();
  const t0 = Date.now() - 60 * 60000;
  m.touchSettle(store, 'private:100000001', { messageCount: 6, now: t0 });
  m.markSettled(store, 'private:100000001', { ok: false });
  assert.equal(store.settle['private:100000001'].pendingMessages, 6);
  assert.equal(store.settle['private:100000001'].extractFailures, 1);
});

console.log('--- 抽取提示词与解析 ---');
ok('提示词包含规则与人名/QQ', () => {
  const p = m.buildProfileExtractionPrompt([
    { sender: '管理员', qq: '100000001', text: '我周三去复查膝盖', time: Date.parse('2026-10-19T12:00:00') }
  ], { scope: '私聊', selfQq: '1817346375' });
  assert.match(p, /只提取\*\*具体事例\*\*/);
  assert.match(p, /100000001/);
  assert.match(p, /1817346375/);
  assert.match(p, /手机号、身份证/);
});
ok('parseProfileJson 容忍代码块/前后废话', () => {
  const out = m.parseProfileJson('好的，结果如下：\n```json\n[{"qq":"100000001","kind":"event","text":"2026-10-19 说了要做群友档案","at":"2026-10-19"}]\n```');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'event');
});
ok('parseProfileJson 丢弃非法 QQ 与越界 kind', () => {
  const out = m.parseProfileJson('[{"qq":"abc","kind":"event","text":"非法QQ"},{"qq":"100000001","kind":"bogus","text":"越界kind"}]');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'note');
});
ok('parseProfileJson 坏 JSON 返回空数组而不是抛', () => {
  assert.deepEqual(m.parseProfileJson('[{'), []);
  assert.deepEqual(m.parseProfileJson('没有 json'), []);
});

console.log('--- 删除 / 清空 ---');
ok('removeRecord 精确删一条', () => {
  const { store, r } = good({ personId: '100000001', kind: 'event', text: '2026-10-19 要被删掉的事例' });
  assert.equal(m.removeRecord(store, '100000001', r.record.id).removed, 1);
  assert.equal(m.removeRecord(store, '100000001', r.record.id).ok, false);
});
ok('removePerson 删整人并报条数', () => {
  const { store } = good({ personId: '100000001', kind: 'event', text: '2026-10-19 整人删除的事例' });
  assert.equal(m.removePerson(store, '100000001').removedRecords, 1);
  assert.equal(Object.keys(store.people).length, 0);
});
ok('clearAll 清空人与群并报数', () => {
  const store = m.emptyStore();
  m.appendRecord(store, { personId: '100000001', kind: 'event', text: '2026-10-19 清空前的事例' }, m.PROFILE_DEFAULTS);
  m.appendGroupTerm(store, '123456789', { term: '开盒', kind: '黑话' });
  m.touchSettle(store, 'private:100000001');
  const out = m.clearAll(store);
  assert.deepEqual(out, { ok: true, clearedPeople: 1, clearedGroups: 1 });
  assert.deepEqual(store.settle, {});
});

console.log('--- 配置合并 ---');
ok('profileCfg 只认允许的键并夹最小值', () => {
  const c = m.profileCfg({ socialV2: { profile: { settleIdleMs: 5000, injectMaxPersons: 9, enabled: false } } });
  assert.equal(c.settleIdleMs >= 1, true);
  assert.equal(c.injectMaxPersons, 9);
  assert.equal(c.enabled, false);
  assert.equal(c.halfLifeDays, m.PROFILE_DEFAULTS.halfLifeDays, '未覆盖的键用默认值');
});

console.log(`\n=== ${pass} 项通过${process.exitCode ? '，有失败' : '，全部通过'} ===`);
