// 交接（handoff）模块的离线单测：只测纯函数与临时目录里的落盘，不碰仓库 state、不碰网络。
//   node scripts/test-handoff.mjs
// 期望最后一行：PASS：N 项通过，0 项失败
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_MAX_CHARS,
  emptyHandoffPayload,
  normalizeHandoffPayload,
  buildHandoffLine,
  shouldRunHandoff,
  createHandoffStore,
} from '../src/handoff.mjs';

const results = [];
// 所有落盘测试都在系统临时目录里做，结束时整体删除。
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
  assert(actual === expected, `${msg || '值不相等'}：实际「${actual}」期望「${expected}」`);
}

function assertIncludes(hay, needle, msg) {
  assert(String(hay).includes(needle), msg || `缺少「${needle}」：\n${hay}`);
}

function assertNotIncludes(hay, needle, msg) {
  assert(!String(hay).includes(needle), msg || `不该出现「${needle}」：\n${hay}`);
}

function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${msg || '结构不相等'}：实际 ${a} 期望 ${e}`);
}

/** 在临时根目录下开一个独立子目录，避免各用例互相污染。 */
let dirSeq = 0;
function freshDir() {
  const dir = path.join(TMP_ROOT, `case-${++dirSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const MINUTE = 60_000;
const HOUR = 3600_000;
const CLOCK = 1_760_000_000_000; // 固定基准时间，避免依赖真实时钟

// ---------- 1. 空摘要与生成行 ----------

check('1 emptyHandoffPayload 形状正确', () => {
  const payload = emptyHandoffPayload();
  assertEqual(payload.schemaVersion, HANDOFF_SCHEMA_VERSION, 'schemaVersion 不对');
  assertDeepEqual(payload.topics, [], 'topics 应为空数组');
  assertDeepEqual(payload.openLoops, [], 'openLoops 应为空数组');
  assertDeepEqual(payload.peopleChange, [], 'peopleChange 应为空数组');
  assertDeepEqual(payload.insideJokes, [], 'insideJokes 应为空数组');
  assertEqual(payload.mood, '', 'mood 应为空串');
});

check('2 空 payload 生成空行', () => {
  assertEqual(buildHandoffLine(emptyHandoffPayload()), '', '全空应返回空串');
  assertEqual(buildHandoffLine({ topics: [], openLoops: [], peopleChange: [], insideJokes: [], mood: '   ' }), '', '只有空白 mood 也应返回空串');
});

check('3 全字段生成行，标签顺序固定', () => {
  const line = buildHandoffLine({
    topics: ['显卡', '游戏'],
    openLoops: ['等对方回消息'],
    peopleChange: ['小A换了头像'],
    insideJokes: ['彩虹屁'],
    mood: '轻松',
  });
  assertEqual(
    line,
    '【上次交接】话题：显卡、游戏；未完：等对方回消息；人物变化：小A换了头像；氛围：轻松；梗：彩虹屁',
    '注入行文本或顺序不对',
  );
});

check('4 超长注入行按码点截断且总长不超过 maxChars', () => {
  const line = buildHandoffLine({ topics: ['很长的测试话题'.repeat(10)], insideJokes: ['梗'.repeat(30)] }, { maxChars: 20 });
  assert([...line].length <= 20, `截断后码点长度 ${[...line].length} 超过 20`);
  assert(line.endsWith('…'), '截断后应以 … 结尾');
  const tiny = buildHandoffLine({ topics: ['话题'] }, { maxChars: 1 });
  assertEqual([...tiny].length, 1, 'maxChars=1 时长度应为 1');
  assertEqual(tiny, '…', 'maxChars=1 时应只剩省略号');
});

// ---------- 2. 摘要校验 ----------

check('5 schema 版本错误被拒，reason 含 schema', () => {
  const r = normalizeHandoffPayload({ schemaVersion: 2, topics: [] });
  assertEqual(r.ok, false, '版本 2 不该通过');
  assertIncludes(r.reason, 'schema', 'reason 应含 schema');
});

check('6 字段类型错误被拒，reason 指明字段', () => {
  const r1 = normalizeHandoffPayload({ topics: '不是数组' });
  assertEqual(r1.ok, false, 'topics 类型错不该通过');
  assertIncludes(r1.reason, 'topics', 'reason 应指明 topics');
  const r2 = normalizeHandoffPayload({ openLoops: {} });
  assertIncludes(r2.reason, 'openLoops', 'reason 应指明 openLoops');
});

check('7 mood 类型错误被拒，reason 指明 mood', () => {
  const r = normalizeHandoffPayload({ mood: 123 });
  assertEqual(r.ok, false, 'mood 类型错不该通过');
  assertIncludes(r.reason, 'mood', 'reason 应指明 mood');
});

check('8 非普通对象被拒', () => {
  for (const raw of [null, [], 'x', 42, undefined]) {
    const r = normalizeHandoffPayload(raw);
    assertEqual(r.ok, false, `${String(raw)} 不该通过`);
    assertEqual(r.reason, 'not-object', `${String(raw)} 的 reason 应为 not-object`);
  }
});

check('9 单条超过 40 字被拒，reason 含 too-long', () => {
  const r = normalizeHandoffPayload({ topics: ['字'.repeat(41)] });
  assertEqual(r.ok, false, '41 字不该通过');
  assertIncludes(r.reason, 'too-long', 'reason 应含 too-long');
});

check('10 数组超过 8 条被拒，reason 含 too-many', () => {
  const r = normalizeHandoffPayload({ insideJokes: Array.from({ length: 9 }, (_, i) => `梗${i}`) });
  assertEqual(r.ok, false, '9 条不该通过');
  assertIncludes(r.reason, 'too-many', 'reason 应含 too-many');
});

check('11 总量超过 400 字被拒，reason 含 too-large', () => {
  const chunk = (prefix) => `${prefix}${'话'.repeat(38)}`; // 每条 40 字
  const raw = {
    topics: Array.from({ length: 8 }, (_, i) => chunk(`甲${i}`)),
    openLoops: Array.from({ length: 8 }, (_, i) => chunk(`乙${i}`)),
  };
  const r = normalizeHandoffPayload(raw);
  assertEqual(r.ok, false, '超总量不该通过');
  assertIncludes(r.reason, 'too-large', 'reason 应含 too-large');
  assert(HANDOFF_MAX_CHARS === 400, 'HANDOFF_MAX_CHARS 应为 400');
});

// ---------- 3. scrub / 归一化 ----------

check('12 scrub 注入：清洗后的文本进入结果', () => {
  const r = normalizeHandoffPayload(
    { topics: ['电话 13800000000'], mood: '有点 13800000000 担心' },
    { scrub: (text) => text.replace(/1\d{10}/g, '[手机号]') },
  );
  assertEqual(r.ok, true, '清洗后应通过');
  assertDeepEqual(r.value.topics, ['电话 [手机号]'], 'scrub 没作用到 topics');
  assertEqual(r.value.mood, '有点 [手机号] 担心', 'scrub 没作用到 mood');
});

check('13 scrub 抛异常返回 scrub-failed 且不抛', () => {
  const r = normalizeHandoffPayload(
    { topics: ['正常话题'] },
    {
      scrub: () => {
        throw new Error('清洗器炸了');
      },
    },
  );
  assertEqual(r.ok, false, 'scrub 抛异常应失败');
  assertEqual(r.reason, 'scrub-failed', 'reason 应为 scrub-failed');
});

check('14 去重、去空白、清控制字符并丢空串', () => {
  const r = normalizeHandoffPayload({
    topics: ['  苹果 ', '苹果', '   ', '\u0001香蕉\u0000', '苹果 '],
    openLoops: ['\u007f'],
    mood: '  开心 \u0007 ',
  });
  assertEqual(r.ok, true, '归一化应通过');
  assertDeepEqual(r.value.topics, ['苹果', '香蕉'], '去重/清理结果不对');
  assertDeepEqual(r.value.openLoops, [], '空串应被丢掉但保留数组');
  assertEqual(r.value.mood, '开心', 'mood 应清掉控制字符并 trim');
  assert(Array.isArray(r.value.openLoops), '空字段应保留为空数组');
});

check('15 缺省字段归一化为空数组/空串', () => {
  const r = normalizeHandoffPayload({});
  assertEqual(r.ok, true, '空对象应通过');
  assertDeepEqual(r.value, emptyHandoffPayload(), '缺省值应与空摘要一致');
});

// ---------- 4. 该不该交接 ----------

check('16 shouldRunHandoff 四个分支：ready', () => {
  const r = shouldRunHandoff({
    now: CLOCK,
    lastRelevantAt: CLOCK - 6 * MINUTE,
    lastHandoffAt: CLOCK - 7 * HOUR,
    pending: true,
  });
  assertDeepEqual(r, { ok: true, reason: 'ready' }, '应判定 ready');
});

check('17 shouldRunHandoff 四个分支：not-pending', () => {
  const r = shouldRunHandoff({
    now: CLOCK,
    lastRelevantAt: CLOCK - 6 * MINUTE,
    lastHandoffAt: CLOCK - 7 * HOUR,
    pending: false,
  });
  assertDeepEqual(r, { ok: false, reason: 'not-pending' }, '未置待交接标记应 not-pending');
});

check('18 shouldRunHandoff 四个分支：no-activity', () => {
  const missing = shouldRunHandoff({ now: CLOCK, pending: true });
  assertDeepEqual(missing, { ok: false, reason: 'no-activity' }, '缺 lastRelevantAt 应 no-activity');
  const busy = shouldRunHandoff({ now: CLOCK, lastRelevantAt: CLOCK - MINUTE, pending: true });
  assertDeepEqual(busy, { ok: false, reason: 'no-activity' }, '活动太近应 no-activity');
});

check('19 shouldRunHandoff 四个分支：too-soon', () => {
  const r = shouldRunHandoff({
    now: CLOCK,
    lastRelevantAt: CLOCK - 10 * MINUTE,
    lastHandoffAt: CLOCK - HOUR,
    pending: true,
  });
  assertDeepEqual(r, { ok: false, reason: 'too-soon' }, '离上次交接太近应 too-soon');
});

check('20 shouldRunHandoff：从未交接视为满足最小间隔', () => {
  const r = shouldRunHandoff({ now: CLOCK, lastRelevantAt: CLOCK - 6 * MINUTE, pending: true });
  assertDeepEqual(r, { ok: true, reason: 'ready' }, 'lastHandoffAt 缺失应放行');
});

// ---------- 5. 持久化 ----------

check('21 写入后 read 回读一致，meta 合并到顶层', () => {
  const dir = freshDir();
  const store = createHandoffStore({ dir, now: () => CLOCK });
  const payload = {
    schemaVersion: 1,
    topics: ['显卡', '游戏'],
    openLoops: ['等回复'],
    peopleChange: [],
    insideJokes: ['彩虹屁'],
    mood: '轻松',
  };
  const before = normalizeHandoffPayload(payload);
  assertEqual(before.ok, true, '测试 payload 本身应有效');
  const w = store.write('group:123', payload, { sourceSession: 'sess-1', reason: 'watermark' });
  assertEqual(w.ok, true, `写入应成功：${w.reason}`);
  assert(fs.existsSync(w.file), 'write 返回的 file 应存在');
  const r = store.read('group:123');
  assertEqual(r.ok, true, `回读应成功：${r.reason}`);
  assertDeepEqual(r.payload, before.value, '回读 payload 与归一化结果不一致');
  assertEqual(r.meta.sourceSession, 'sess-1', 'meta.sourceSession 未合并到顶层');
  assertEqual(r.meta.reason, 'watermark', 'meta.reason 未合并到顶层');
  assertEqual(r.meta.generatedAt, CLOCK, 'generatedAt 应取 now()');
});

check('22 覆盖写入产生归档且总数不超过 3', () => {
  const dir = freshDir();
  const store = createHandoffStore({ dir, now: () => CLOCK });
  for (let i = 1; i <= 4; i += 1) {
    const w = store.write('group:123', { topics: [`第${i}次`] }, { generatedAt: i * 1000, sourceSession: `s${i}` });
    assertEqual(w.ok, true, `第 ${i} 次写入应成功：${w.reason}`);
  }
  const names = fs.readdirSync(dir);
  assertEqual(names.length, 3, `目录里应只剩 3 个文件，实际 ${names.join(',')}`);
  const h = store.history('group:123');
  assertEqual(h.length, 2, `归档应留 2 份，实际 ${h.join(',')}`);
  assertIncludes(h[0], '.3000.json', '最新归档应是 3000');
  assertIncludes(h[1], '.2000.json', '次新归档应是 2000');
  const latest = store.read('group:123');
  assertDeepEqual(latest.payload.topics, ['第4次'], '最新交接应是最新一次写入');
  assertEqual(latest.meta.sourceSession, 's4', '最新交接的 meta 不对');
});

check('23 无效 payload 不覆盖已有有效交接且不留临时文件', () => {
  const dir = freshDir();
  const store = createHandoffStore({ dir, now: () => CLOCK });
  const good = store.write('group:123', { topics: ['有效话题'], mood: '平静' }, { sourceSession: 'sess-ok' });
  assertEqual(good.ok, true, '先写入一份有效交接');
  const file = path.join(dir, 'group_123.json');
  const textBefore = fs.readFileSync(file, 'utf8');
  const mtimeBefore = fs.statSync(file).mtimeMs;

  for (const bad of [
    { schemaVersion: 9 },
    { topics: '不是数组' },
    { topics: ['字'.repeat(41)] },
    { topics: Array.from({ length: 9 }, (_, i) => `梗${i}`) },
  ]) {
    const w = store.write('group:123', bad, { sourceSession: 'sess-bad' });
    assertEqual(w.ok, false, '坏 payload 应写入失败');
  }
  // 校验失败发生在建目录/写临时文件之前，磁盘内容必须一个字节都没变。
  assertEqual(fs.readFileSync(file, 'utf8'), textBefore, '坏 payload 改动了已有交接内容');
  assertEqual(fs.statSync(file).mtimeMs, mtimeBefore, '坏 payload 触碰了已有交接文件');
  const r = store.read('group:123');
  assertDeepEqual(r.payload.topics, ['有效话题'], '坏 payload 覆盖了上一份有效交接');
  assertEqual(r.meta.sourceSession, 'sess-ok', '坏 payload 覆盖了上一份 meta');
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
  assertDeepEqual(leftovers, [], '写入失败后不应残留临时文件');
});

check('24 校验失败时连目录都不创建', () => {
  const dir = path.join(freshDir(), 'never-created');
  const store = createHandoffStore({ dir, now: () => CLOCK });
  const w = store.write('group:123', { topics: '坏' });
  assertEqual(w.ok, false, '坏 payload 应失败');
  assertEqual(fs.existsSync(dir), false, '校验失败不应 mkdir');
});

check('25 safeKey 消毒：group:123', () => {
  const dir = freshDir();
  const store = createHandoffStore({ dir, now: () => CLOCK });
  const w = store.write('group:123', { topics: ['私聊'] });
  assertEqual(w.ok, true, `写入应成功：${w.reason}`);
  assert(fs.existsSync(path.join(dir, 'group_123.json')), '冒号应替换为下划线');
  assertEqual(fs.readdirSync(dir).filter((n) => n.includes(':')).length, 0, '文件名不应含冒号');
  const r = store.read('group:123');
  assertDeepEqual(r.payload.topics, ['私聊'], '消毒后仍应能按原 key 读回');
});

check('26 safeKey 消毒：含 emoji（emoji 只算一个下划线）', () => {
  const dir = freshDir();
  const store = createHandoffStore({ dir, now: () => CLOCK });
  const w = store.write('群🎉', { topics: ['表情'] });
  assertEqual(w.ok, true, `写入应成功：${w.reason}`);
  // 群 和 🎉 各是一个码点，因此各替换成一个下划线。
  assert(fs.existsSync(path.join(dir, '__.json')), `应生成 __.json，实际 ${fs.readdirSync(dir).join(',')}`);
  const r = store.read('群🎉');
  assertEqual(r.ok, true, '应能按原 key 读回');
});

check('27 坏 JSON 读取返回 corrupt，不抛', () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'broken.json'), '{这不是 JSON', 'utf8');
  const store = createHandoffStore({ dir, now: () => CLOCK });
  // check 会兜住抛异常，这里直接调用来证明 read 不抛。
  const r = store.read('broken');
  assertEqual(r.ok, false, '坏 JSON 应读取失败');
  assertEqual(r.reason, 'corrupt', 'reason 应为 corrupt');
  const missing = store.read('nobody');
  assertEqual(missing.ok, false, '缺失文件应失败');
  assertEqual(missing.reason, 'missing', 'reason 应为 missing');
});

check('28 dir 非法时所有方法安全失败', () => {
  const store = createHandoffStore({ dir: '' });
  assertEqual(store.read('k').ok, false, 'read 应失败');
  assertEqual(store.write('k', emptyHandoffPayload()).ok, false, 'write 应失败');
  assertDeepEqual(store.history('k'), [], 'history 应返回空数组');
});

check('29 history 对不存在的目录返回空数组', () => {
  const store = createHandoffStore({ dir: path.join(freshDir(), 'nope'), now: () => CLOCK });
  assertDeepEqual(store.history('group:123'), [], '不存在目录时 history 应为空');
});

// ---------- 错误路径：修剪失败不能把「已成功写入」报成失败 ----------

check('归档修剪失败不应把写入报成失败（fail-open）', () => {
  const dir = freshDir();
  let clock = CLOCK;
  const tick = () => (clock += 1000);
  // 先用大 maxKeep 攒出多份归档（每次写入时间戳不同，归档名不会撞车）。
  const seed = createHandoffStore({ dir, now: tick, maxKeep: 10 });
  for (let i = 0; i < 5; i++) {
    const res = seed.write('group:123', { topics: [`话题${i}`], openLoops: [], peopleChange: [], insideJokes: [], mood: '' });
    assert(res.ok === true, '攒归档的写入都应成功');
  }
  const archives = seed.history('group:123');
  assert(archives.length >= 3, `应攒下 >=3 份归档，实际 ${archives.length}`);
  // Windows 上 chmod 只读挡不住 unlink（实测），改用「同名目录占位」制造稳定失败：
  // 名字仍匹配归档正则，但 unlinkSync 对目录会 EPERM/EISDIR。
  const safeKey = archives[0].replace(/\.-?\d+\.json$/, '');
  const oldest = Math.min(...archives.map((name) => Number(name.match(/\.(-?\d+)\.json$/)[1])));
  fs.mkdirSync(path.join(dir, `${safeKey}.${oldest - 1000}.json`));
  // maxKeep=2 时写入后必须修剪，首个修剪目标就是这份「目录归档」。
  const store = createHandoffStore({ dir, now: tick, maxKeep: 2 });
  const res = store.write('group:123', { topics: ['新话题'], openLoops: [], peopleChange: [], insideJokes: [], mood: '' });
  assert(res.ok === true, `修剪失败时仍应返回 ok:true，实际 ${JSON.stringify(res)}`);
  assert(typeof res.pruneError === 'string' && res.pruneError.length > 0, '应把修剪失败写在 pruneError 里');
  const back = store.read('group:123');
  assert(back.ok === true, '新交接应可读回');
  assertDeepEqual(back.payload.topics, ['新话题'], '读回的应是刚写入的新交接');
});

// ---------- 汇总（与 test-cost-guard.mjs 同款输出） ----------

try {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
} catch {
  /* 清理失败不影响测试结论 */
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
for (const r of results) {
  if (r.ok) console.log(`ok   ${r.name}`);
  else console.log(`FAIL ${r.name}\n     ${r.error}`);
}
if (failed) {
  console.log(`FAIL：${passed} 项通过，${failed} 项失败`);
  process.exit(1);
}
console.log(`PASS：${passed} 项通过，0 项失败`);
