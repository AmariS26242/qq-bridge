// 表情包语义检索（Track 1）单元自检：分词 / 同义扩展 / 打分排序 / 边界。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeQuery,
  tokenize,
  expandWithSynonyms,
  buildStickerIndex,
  searchStickers,
  formatSearchHit,
  explainSearch
} from '../src/sticker-index.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

const CORPUS = [
  {
    id: 'a',
    desc: '摸鱼',
    tags: ['摸鱼', '偷懒'],
    localNote: '配字「摸鱼」，偷懒划水时用',
    usage: '',
    useCount: 3
  },
  {
    id: 'b',
    desc: '爆哭求饶，眼泪鼻涕流一脸',
    tags: ['委屈', '哭'],
    localNote: '趴桌沿大哭，委屈求饶时用',
    usage: '',
    useCount: 0
  },
  {
    id: 'c',
    desc: '接口 500 服务器嗝屁',
    tags: ['报错', '技术'],
    localNote: '报错梗 500 服务器嗝屁，聊技术出糗时用',
    usage: '',
    useCount: 1
  }
];

// 1. normalizeQuery：全角转半角、大小写、空白压缩
{
  assert.equal(normalizeQuery('  ＨＥＬＬＯ　 世界 '), 'hello 世界');
  ok('normalizeQuery 归一化全角/大小写/空白');
}

// 2. tokenize：CJK bigram + 单字，ASCII 小写词
{
  const terms = tokenize('摸鱼 500');
  assert.ok(terms.includes('摸鱼'));
  assert.ok(terms.includes('摸'));
  assert.ok(terms.includes('鱼'));
  assert.ok(terms.includes('500'));
  ok('tokenize 产出 bigram/单字/ASCII 词');
}

// 3. 停用单字不进入词表（避免「的了我」污染）
{
  const terms = tokenize('我的鱼');
  assert.ok(!terms.includes('的'));
  assert.ok(terms.includes('鱼'));
  ok('tokenize 过滤停用单字');
}

// 4. 同义扩展：查询「爆哭」→ 委屈/难过族，原始二元组权重 1，扩展词打 0.6 折扣
{
  const expanded = expandWithSynonyms(tokenize('爆哭'));
  assert.ok(expanded.has('委屈'), '「爆哭」应扩展到「委屈」');
  assert.equal(expanded.get('爆哭'), 1, '原始二元组权重保持 1');
  assert.ok(expanded.get('委屈') <= 0.6, '扩展词权重 <= 0.6');
  ok('expandWithSynonyms 语义扩展并降权');
}

// 5. 检索：字面对齐的查询排第一
{
  const index = buildStickerIndex(CORPUS);
  const hits = searchStickers(index, '摸鱼', { limit: 3 });
  assert.equal(hits[0].id, 'a');
  assert.ok(hits[0].score > 0);
  assert.ok(hits[0].reason.includes('标签') || hits[0].reason.includes('语义'));
  ok('searchStickers 精确标签命中排第一');
}

// 6. 检索：口语化查询在语料里没有字面词也能召回
{
  const index = buildStickerIndex(CORPUS);
  const hits = searchStickers(index, '有点难过想掉眼泪', { limit: 2 });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].id, 'b');
  ok('searchStickers 同义召回（难过/眼泪 → 委屈/哭）');
}

// 7. IDF：稀有词（500）优先于泛词
{
  const index = buildStickerIndex(CORPUS);
  const hits = searchStickers(index, '报错 500', { limit: 3 });
  assert.equal(hits[0].id, 'c');
  ok('searchStickers IDF 让稀有词主导');
}

// 8. 使用频次只作微调，不能把不相关的热门表情顶上来
{
  const corpus = [
    { id: 'hot', desc: '热门表情', tags: ['热门'], localNote: '', usage: '', useCount: 999 },
    { id: 'hit', desc: '在干活', tags: ['干活'], localNote: '算力跑满时用', usage: '', useCount: 0 }
  ];
  const hits = searchStickers(buildStickerIndex(corpus), '在干活', { limit: 2 });
  assert.equal(hits[0].id, 'hit');
  ok('searchStickers 使用频次不压过语义相关');
}

// 9. 空查询 / 空语料返回空数组，不抛错
{
  assert.deepEqual(searchStickers(buildStickerIndex(CORPUS), '   '), []);
  assert.deepEqual(searchStickers([], '摸鱼'), []);
  ok('searchStickers 空输入安全');
}

// 10. limit / minScore 生效
{
  const hits = searchStickers(buildStickerIndex(CORPUS), '报错', { limit: 1, minScore: 0 });
  assert.equal(hits.length, 1);
  const none = searchStickers(buildStickerIndex(CORPUS), '报错', { minScore: 999 });
  assert.equal(none.length, 0);
  ok('searchStickers limit/minScore 生效');
}

// 11. formatSearchHit 输出单行摘要，带分数与理由
{
  const hits = searchStickers(buildStickerIndex(CORPUS), '摸鱼', { limit: 1 });
  const line = formatSearchHit(hits[0], 0);
  assert.match(line, /^\s*1\. \[\d/);
  assert.ok(line.includes('摸鱼'));
  ok('formatSearchHit 输出可读摘要');
}

// 12. explainSearch：与 searchStickers 同序同分，且拆解能对上总分
{
  const index = buildStickerIndex(CORPUS);
  const hits = searchStickers(index, '有点难过想掉眼泪', { limit: 3 });
  const report = explainSearch(index, '有点难过想掉眼泪', { limit: 3 });
  assert.equal(report.hits.length, hits.length, '解释结果条数应与检索一致');
  assert.deepEqual(report.hits.map((h) => h.id), hits.map((h) => h.id), '解释结果顺序应与检索一致');
  for (let i = 0; i < hits.length; i += 1) {
    assert.equal(report.hits[i].score, hits[i].score, `第 ${i + 1} 名分数应一致`);
  }
  const first = report.hits[0];
  const termSum = first.terms.reduce((sum, part) => sum + part.contribution, 0);
  const bonusSum = first.bonuses.reduce((sum, bonus) => sum + bonus.points, 0);
  // 拆解项各自四舍五入过，允许与总分有 0.05 级误差
  assert.ok(Math.abs(termSum + bonusSum - first.score) < 0.05, `拆解和 ${termSum + bonusSum} 应约等于总分 ${first.score}`);
  assert.ok(first.terms.every((part) => Array.isArray(part.fields)), '每个词条都应带命中字段');
  assert.ok(first.terms.some((part) => part.fields.length > 0), '至少一个词条应命中字段');
  assert.ok(report.terms.some((t) => t.synonym), '同义扩展词应被标记');
  ok('explainSearch 与检索同分且拆解自洽');
}

// 13. bridge / MCP 契约：检索接口与工具已接入（源码级断言，与 test-stickers.mjs 的做法一致）
{
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.ok(bridge.includes("from './sticker-index.js'"), 'bridge 应导入 sticker-index');
  assert.ok(bridge.includes("url.pathname === '/api/stickers/search'"), 'bridge 应暴露 /api/stickers/search');
  assert.ok(bridge.includes("url.pathname === '/api/stickers/explain'"), 'bridge 应暴露 /api/stickers/explain');
  assert.ok(bridge.includes("url.pathname === '/stickers-debug'"), 'bridge 应暴露 /stickers-debug 调试页');
  assert.ok(bridge.includes("url.pathname === '/api/socialV2/sticker-search'"), 'bridge 应暴露会话语义检索接口');
  assert.ok(bridge.includes('function getStickerIndex('), 'bridge 应有索引缓存 helper');
  assert.ok(bridge.includes("findSticker: 'qq_find_sticker'"), '工具开关表应包含 findSticker');
  const mcp = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
  assert.ok(mcp.includes("'qq_find_sticker'"), 'MCP 应注册 qq_find_sticker');
  assert.ok(mcp.includes('qq_find_sticker: \'findSticker\''), 'MCP 工具开关应映射 findSticker');
  ok('bridge/MCP 已接入语义检索与解释页');
}

console.log(`\n${passed} 项通过`);
