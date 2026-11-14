// 日记本模块的离线单测：不碰桥接、不碰网络，全部用临时目录与固定时钟。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DIARY_DEFAULTS, DiaryError, safeKeyName, notebookFile, todayString, isDateString,
  emptyNotebook, loadNotebook, saveNotebook, writePage, removePage, hasPage,
  selectPages, notebookStats, formatPages, toMarkdown, listNotebooks, diaryCfg, autoWriteClock,
} from '../src/diary.js';

// 2026-10-23 19:06 Asia/Shanghai
const T0 = Date.parse('2026-10-23T11:06:44Z');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diary-test-'));
}

function cfgPatch(patch = {}) {
  return diaryCfg({ socialV2: { diary: patch } });
}

function seed(key = 'private:100000001', file = path.join(tmpDir(), 'book.json')) {
  const book = emptyNotebook(key, { nowMs: T0 });
  return { key, file, book };
}

test('会话 key → 文件名安全片段', () => {
  assert.equal(safeKeyName('group:1122334455'), 'group_1122334455');
  assert.equal(safeKeyName('private:100000001'), 'private_100000001');
  assert.equal(safeKeyName('private:0100000001'), 'private_0100000001');
  assert.throws(() => safeKeyName('group:abc'), DiaryError);
  assert.throws(() => safeKeyName(''), DiaryError);
  assert.equal(path.basename(notebookFile(path.join('state', 'diary'), 'private:1')), 'private_1.json');
});

test('日期工具：上海墙上日期与真日期校验', () => {
  assert.equal(todayString(T0), '2026-10-23');
  assert.equal(todayString(Date.parse('2026-10-23T16:30:00Z')), '2026-10-24', 'UTC 16:30 已是上海次日 00:30');
  assert.equal(isDateString('2026-10-23'), true);
  assert.equal(isDateString('2026-02-30'), false);
  assert.equal(isDateString('2026-1-1'), false);
  assert.equal(isDateString(''), false);
});

test('写页：新建 → 追加 → 整页替换', () => {
  const cfg = cfgPatch();
  const { key, book } = seed();
  const first = writePage(book, { text: '今天群里聊到日记', mood: '平静', tags: ['#日常', '日常'] }, { cfg, nowMs: T0 });
  assert.equal(first.created, true);
  assert.equal(first.appended, false);
  assert.equal(first.page.date, '2026-10-23');
  assert.deepEqual(first.page.tags, ['日常'], '标签去重并去掉 #');
  assert.equal(first.page.source, 'ai');

  const second = writePage(book, { text: '晚上又想起一句' }, { cfg, nowMs: T0 + 60_000 });
  assert.equal(second.created, false);
  assert.equal(second.appended, true);
  assert.match(second.page.text, /今天群里聊到日记\n\n晚上又想起一句/);
  assert.equal(book.pages.length, 1, '一天一页');

  const third = writePage(book, { text: '重写今天', replace: true }, { cfg, nowMs: T0 + 120_000 });
  assert.equal(third.page.text, '重写今天');
  assert.equal(book.pages.length, 1);

  const older = writePage(book, { text: '补昨天', date: '2026-10-22' }, { cfg, nowMs: T0 });
  assert.equal(older.created, true);
  assert.deepEqual(book.pages.map((p) => p.date), ['2026-10-22', '2026-10-23'], '按日期升序');
  assert.equal(key, 'private:100000001');
});

test('写页：非法输入与长度边界', () => {
  const cfg = cfgPatch({ maxTextChars: 60, maxTitleChars: 5, maxMoodChars: 4, maxTags: 2, maxTagChars: 4 });
  const { book } = seed();
  assert.throws(() => writePage(book, { text: '   ' }, { cfg, nowMs: T0 }), /不能为空/);
  assert.throws(() => writePage(book, { text: 'x', date: '2026-02-30' }, { cfg, nowMs: T0 }), /日期格式不对/);
  const long = writePage(book, { text: '字'.repeat(200), title: '标题超长了', mood: '很难过的样子', tags: ['一二三', '一二三', '四五六', '七八九'] }, { cfg, nowMs: T0 });
  assert.ok(long.page.text.length <= 60);
  assert.equal(long.page.text.startsWith('…'), true, '超长保留结尾');
  assert.ok(long.page.title.length <= 5);
  assert.ok(long.page.mood.length <= 4);
  assert.deepEqual(long.page.tags, ['一二三', '四五六']);
});

test('落盘：原子写入 → 读回；坏文件拒绝覆盖；缺文件返回空本子', () => {
  const { key, file, book } = seed();
  writePage(book, { text: '第一页' }, { cfg: cfgPatch(), nowMs: T0 });
  saveNotebook(file, book, { nowMs: T0 });
  assert.ok(fs.existsSync(file));

  const loaded = loadNotebook(file, key, { nowMs: T0 });
  assert.equal(loaded.pages.length, 1);
  assert.equal(loaded.pages[0].text, '第一页');
  assert.equal(loaded.version, 1);

  const missing = loadNotebook(path.join(tmpDir(), 'nope.json'), key, { nowMs: T0 });
  assert.equal(missing.pages.length, 0);
  assert.equal(missing.key, key);

  fs.writeFileSync(file, '{not json', 'utf8');
  assert.throws(() => loadNotebook(file, key, { nowMs: T0 }), /不是合法 JSON/);
  fs.writeFileSync(file, JSON.stringify({ version: 1 }), 'utf8');
  assert.throws(() => loadNotebook(file, key, { nowMs: T0 }), /缺少 pages/);
});

test('选择/统计/格式化：只取需要的页', () => {
  const cfg = cfgPatch();
  const { book } = seed();
  for (const d of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']) {
    writePage(book, { text: `${d} 的事`, date: d, weather: d === '2026-10-23' ? '阴' : '', mood: '还行' }, { cfg, nowMs: T0 });
  }
  assert.equal(selectPages(book, { limit: 2 }).map((p) => p.date).join(','), '2026-10-23,2026-10-22');
  assert.equal(selectPages(book, { from: '2026-10-21', to: '2026-10-22', limit: 10 }).length, 2);
  assert.equal(selectPages(book, { date: '2026-10-22' }).length, 1);
  assert.equal(selectPages(book, { date: '2026-10', limit: 10 }).length, 4, '月份前缀匹配');
  assert.equal(hasPage(book, '2026-10-22'), true);
  assert.equal(hasPage(book, '2026-10-19'), false);

  const stats = notebookStats(book, { nowMs: T0 });
  assert.equal(stats.pages, 4);
  assert.equal(stats.writtenToday, true);
  assert.equal(stats.firstDate, '2026-10-20');
  assert.equal(stats.lastDate, '2026-10-23');
  assert.ok(stats.chars > 0);

  const text = formatPages(selectPages(book, { date: '2026-10-23' }));
  assert.match(text, /【无题】 2026-10-23 · 阴 · 还行/);
  assert.match(text, /2026-10-23 的事/);
  assert.equal(formatPages([]), '（本子还是空的）');

  const md = toMarkdown(book);
  assert.match(md, /^# 私聊本子 100000001/);
  assert.match(md, /## 2026-10-22/);
});

test('删除页与容量上限', () => {
  const cfg = cfgPatch({ maxPagesPerNotebook: 3 });
  const { book } = seed();
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) {
    writePage(book, { text: `${d}`, date: d }, { cfg, nowMs: T0 });
  }
  assert.deepEqual(book.pages.map((p) => p.date), ['2026-10-02', '2026-10-03', '2026-10-04'], '超出上限裁掉最旧页');
  const removed = removePage(book, { date: '2026-10-03' });
  assert.equal(removed.date, '2026-10-03');
  assert.throws(() => removePage(book, { date: '2026-10-03' }), /没有找到/);
});

test('长页追加截断到 maxPageChars', () => {
  const cfg = cfgPatch({ maxTextChars: 200, maxPageChars: 260 });
  const { book } = seed();
  writePage(book, { text: 'a'.repeat(200) }, { cfg, nowMs: T0 });
  const res = writePage(book, { text: 'b'.repeat(200) }, { cfg, nowMs: T0 + 1000 });
  assert.equal(res.truncated, true);
  assert.ok(res.page.text.length <= 260);
});

test('残缺 cfg 不会把整段文字当超长（不加省略号前缀）', () => {
  const { book } = seed();
  // 只给 maxPageChars/maxTextChars，title/mood 上限缺失 —— 旧实现会算出 NaN 并加「…」前缀。
  const res = writePage(book, { text: '今天没干什么。', title: '被问住', mood: '闷' }, { cfg: { maxTextChars: 1200, maxPageChars: 4000 }, nowMs: T0 });
  assert.equal(res.page.title, '被问住');
  assert.equal(res.page.mood, '闷');
  assert.equal(res.page.text, '今天没干什么。');
});

test('配置：默认值与边界收敛', () => {
  const c = diaryCfg({});
  assert.equal(c.enabled, true);
  assert.equal(c.autoWrite.enabled, true);
  assert.equal(c.autoWrite.clock, '23:30');
  assert.equal(c.autoWrite.minMessages, 1);
  assert.equal(c.maxTextChars, DIARY_DEFAULTS.maxTextChars);
  assert.deepEqual(autoWriteClock('25:00'), { h: 23, mi: 30 }, '非法时钟回退默认');

  const c2 = diaryCfg({ socialV2: { diary: { enabled: false, autoWrite: { enabled: true, tickMs: 1, clock: '8:05' }, maxTextChars: 999999 } } });
  assert.equal(c2.enabled, false);
  assert.equal(c2.autoWrite.enabled, false, '总开关关掉时自动写也关');
  assert.equal(c2.autoWrite.tickMs, 30_000);
  assert.equal(c2.maxTextChars, c2.maxPageChars, 'maxTextChars 不超过 maxPageChars');
  assert.deepEqual(autoWriteClock(c2.autoWrite.clock), { h: 8, mi: 5 });
});

test('配置：文风样本清洗（去空、限量、限长）', () => {
  const c = diaryCfg({ socialV2: { diary: { styleSamples: ['  第一句。 ', '', '   ', 123, 'x'.repeat(300)] } } });
  assert.deepEqual(c.styleSamples.slice(0, 2), ['第一句。', '123']);
  assert.equal(c.styleSamples.length, 3, '空串被过滤');
  assert.equal(c.styleSamples[2].length, 200, '单条截到 200 字');
  assert.deepEqual(diaryCfg({}).styleSamples, [], '缺省为空数组');
  const many = diaryCfg({ socialV2: { diary: { styleSamples: Array.from({ length: 9 }, (_, i) => `样本${i}`) } } });
  assert.equal(many.styleSamples.length, 5, '最多 5 条');
});

test('目录扫描：列出本子并跳过坏文件', () => {
  const dir = tmpDir();
  const cfg = cfgPatch();
  const a = seed('private:1', path.join(dir, 'private_1.json'));
  const b = seed('group:2', path.join(dir, 'group_2.json'));
  writePage(a.book, { text: '私聊' }, { cfg, nowMs: T0 });
  saveNotebook(a.file, a.book, { nowMs: T0 });
  writePage(b.book, { text: '群聊', date: '2026-10-22' }, { cfg, nowMs: T0 });
  saveNotebook(b.file, b.book, { nowMs: T0 });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{{{', 'utf8');

  const list = listNotebooks(dir, { nowMs: T0 });
  assert.equal(list.length, 2);
  const priv = list.find((n) => n.key === 'private:1');
  assert.equal(priv.pages, 1);
  assert.equal(priv.writtenToday, true);
  const grp = list.find((n) => n.key === 'group:2');
  assert.equal(grp.writtenToday, false);
  assert.equal(listNotebooks(path.join(dir, 'missing'), { nowMs: T0 }).length, 0);
});
