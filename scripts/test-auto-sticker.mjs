/**
 * 自动表情联动（B-P3）离线单测：不联网、不发消息，只验纯逻辑。
 *   node scripts/test-auto-sticker.mjs
 */
import { AUTO_STICKER_DEFAULTS, MOOD_QUERIES, normalizeAutoStickerConfig, normalizeHits, pickAutoSticker } from '../src/auto-sticker.mjs';

let pass = 0;
let fail = 0;
function ok(cond, name, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const hits = (pairs) => pairs.map(([id, score]) => ({ entry: { id, desc: `d-${id}` }, score }));

console.log('mood → 检索词');
ok(Object.keys(MOOD_QUERIES).length === 5, '五档 mood 都有映射');
ok(Object.values(MOOD_QUERIES).every((q) => q.trim().length > 0), '映射词非空');
ok(MOOD_QUERIES.happy.includes('开心') && MOOD_QUERIES.calm.includes('晚安'), 'happy/calm 词表正确');

console.log('配置归一');
ok(normalizeAutoStickerConfig(undefined).enabled === AUTO_STICKER_DEFAULTS.enabled, '缺省 enabled=true');
ok(normalizeAutoStickerConfig({ enabled: false }).enabled === false, 'enabled=false 生效');
ok(normalizeAutoStickerConfig({ minScore: '9' }).minScore === 9, '字符串分数转数字');
ok(normalizeAutoStickerConfig({ recentWindow: -5 }).recentWindow === 0, '负数窗口夹到 0');
ok(normalizeAutoStickerConfig({ minScore: 'abc' }).minScore === AUTO_STICKER_DEFAULTS.minScore, '非法分数回默认');

console.log('候选归一');
ok(normalizeHits([{ entry: { id: 1 }, score: 3 }])[0].id === '1', '数字 id 转字符串');
ok(normalizeHits([{ id: 'x' }])[0].score === 0, '裸 entry 补 score=0');
ok(normalizeHits([null, {}, { entry: {} }]).length === 0, '脏数据被过滤');
ok(normalizeHits('nope').length === 0, '非数组返回空');

console.log('挑选逻辑');
const h1 = hits([['a', 20], ['b', 15], ['c', 9]]);
ok(pickAutoSticker(h1, { mood: 'happy' }).picked.id === 'a', '选最高分');
ok(pickAutoSticker(h1, { mood: 'unknown' }).reason === 'no-mood', '未知 mood 拒绝');
ok(pickAutoSticker(h1, { mood: 'happy', config: { enabled: false } }).reason === 'disabled', '禁用时拒绝');
ok(pickAutoSticker([], { mood: 'happy' }).reason === 'no-hit', '无候选');
ok(pickAutoSticker(hits([['a', 3]]), { mood: 'happy' }).reason === 'low-score', '低于阈值不发');
ok(pickAutoSticker(h1, { mood: 'happy', recent: ['a'] }).picked.id === 'b', '跳过最近发过的那张');
ok(pickAutoSticker(h1, { mood: 'happy', recent: ['a', 'b', 'c'] }).reason === 'all-recent', '全发过则不发');
ok(pickAutoSticker(h1, { mood: 'happy', recent: ['z', 'y'], config: { recentWindow: 1 } }).picked.id === 'a', '窗口只看最近 N 条');
ok(
  pickAutoSticker(h1, { mood: 'happy', recent: ['a'], config: { limit: 1 } }).reason === 'all-recent',
  'limit=1 时只有一张候选且已发过 → 不发'
);

console.log('连续 5 次不重复（模拟发送后把 id 推进 recent）');
let recent = [];
const pool = hits([['s1', 30], ['s2', 25], ['s3', 20], ['s4', 18], ['s5', 16], ['s6', 12]]);
const pickedIds = [];
for (let i = 0; i < 5; i += 1) {
  const r = pickAutoSticker(pool, { mood: 'shy', recent });
  if (!r.picked) break;
  pickedIds.push(r.picked.id);
  recent = [...recent, r.picked.id].slice(-12);
}
ok(pickedIds.length === 5, '连发 5 次都有可选项', JSON.stringify(pickedIds));
ok(new Set(pickedIds).size === 5, '连发 5 次互不重复', JSON.stringify(pickedIds));
const sixth = pickAutoSticker(pool, { mood: 'shy', recent });
ok(sixth.picked && sixth.picked.id === 's6', '第 6 次才轮到下一张');

console.log('确定性');
const a = JSON.stringify(pickAutoSticker(h1, { mood: 'sad', recent: ['b'] }));
const b = JSON.stringify(pickAutoSticker(h1, { mood: 'sad', recent: ['b'] }));
ok(a === b, '同输入同输出');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
