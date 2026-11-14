// 去 AI 味 P0 阶段回归测试：兜底三分 / 观察期规则 / 自动豁免词 / 度量聚合 / 语义保真。
// 与 scripts/test-ai-tone.mjs 分工：那边测「规则删得对不对」，这里测「删到什么程度可以发、以及怎么记账」。
// 用法：node scripts/test-ai-tone-v2.mjs
import {
  deslopChatText,
  decideFallback,
  isSubstantive,
  normalizeFallbackPolicy,
  observeHits,
  FALLBACK_POLICY_DEFAULTS
} from '../src/ai-tone.js';
import {
  emptyStats,
  recordOutgoing,
  pruneStats,
  summarizeStats,
  normalizeStats,
  dayKey,
  normalizeAiToneStatsConfig
} from '../src/ai-tone-stats.js';

let failed = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  if (!ok) failed += 1;
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};
const has = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
};

// ── A. isSubstantive：什么时候「宁可发原文」 ─────────────────────────────
has('含数字 → 实质', isSubstantive('明天3点对进度'));
has('含链接 → 实质', isSubstantive('看这个 https://example.com/x'));
has('含 @ → 实质', isSubstantive('问@张三 要'));
has('含反引号 → 实质', isSubstantive('跑 `npm test`'));
has('含否定词「别」→ 实质（删了会反义）', isSubstantive('别去'));
has('含否定词「没」→ 实质', isSubstantive('没电了'));
has('≥12 字 → 实质', isSubstantive('这事儿得等他们那边先确认一下'));
has('短套话不算实质', !isSubstantive('希望对你有帮助'));
has('空串不算实质', !isSubstantive(''));
has('纯空白不算实质', !isSubstantive('   '));

// ── B. decideFallback：文档 §11 P0-2 的五个验收用例 ──────────────────────
const clean = (raw, opts = {}) => {
  const { text, hits, changed } = deslopChatText(raw, opts);
  return { text, hits, changed };
};
const decide = (raw, { private: isPrivate = false, policy, opts } = {}) => {
  const r = clean(raw, opts);
  return decideFallback({ raw, cleaned: r.text, hits: r.hits, isPrivate, policy });
};

// 用例①「希望对你有帮助」：群聊不发，私聊发「嗯」
{
  const g = decide('希望对你有帮助。');
  eq('① 群聊删空 → skip', g.action, 'skip');
  eq('① 群聊删空 → 文本为空', g.text, '');
  const p = decide('希望对你有帮助。', { private: true });
  eq('① 私聊删空 → nudge', p.action, 'nudge');
  eq('① 私聊删空 → 发「嗯」', p.text, '嗯');
}
// 用例②「这事儿听着挺沉的，明天3点对进度」：保留信息
{
  const d = decide('这事儿听着挺沉的，明天3点对进度');
  eq('② 有信息 + 未被删空 → normal/heavy 都发清洗后文本', d.text.includes('明天3点对进度'), true);
  has('② 不会因为删得多就回退原文', d.action === 'normal' || d.action === 'heavy', d.action);
}
// 用例③「我理解你的感受」→「懂」，正常发
{
  const d = decide('我理解你的感受');
  eq('③ 清洗后是「懂」', d.text, '懂');
  eq('③ 走 normal', d.action, 'normal');
}
// 用例④ 总结句：删得少 → normal
{
  const d = decide('首先，这个方案不行，其次时间不够，所以先放着。');
  has('④ 总结句不是 heavy', d.action === 'normal', `${d.action} removed=${d.removedRatio}`);
}
// 用例⑤「好的，我看一下」→「我看一下」
{
  const d = decide('好的，我看一下');
  eq('⑤ 句首确认式被删', d.text, '我看一下');
  eq('⑤ 走 normal', d.action, 'normal');
}

// 删得多（>60%）但有内容 → heavy，仍然发清洗后的文本，不回退原文
{
  const raw = '总而言之呢，综上所述，先说这些吧';
  const d = decideFallback({ raw, cleaned: '嗯嗯', hits: [] });
  has('删得狠 → heavy', d.action === 'heavy', `${d.action} removed=${d.removedRatio}`);
  has('heavy 也发送清洗后文本（非空）', d.text.length > 0);
  const short = decideFallback({ raw: '我理解你的感受', cleaned: '懂', hits: [] });
  eq('短句按比例删得多也不记 heavy', short.action, 'normal');
}

// 兜底策略：
eq('默认策略 mode=skip', normalizeFallbackPolicy().mode, FALLBACK_POLICY_DEFAULTS.mode);
eq('非法 mode 回落 skip', normalizeFallbackPolicy({ mode: '乱写' }).mode, 'skip');
eq('off 模式 → 返回空串交上层', decideFallback({ raw: '未来可期', cleaned: '嗯', hits: ['fallback'], policy: { mode: 'off' } }).action, 'off');
eq('nudge 模式群聊也发兜底', decideFallback({ raw: '未来可期', cleaned: '嗯', hits: ['fallback'], policy: { mode: 'nudge' } }).text, '嗯');
eq('keepRawIfSubstantive=false 时实质信息也跳过', decideFallback({ raw: '别去', cleaned: '嗯', hits: ['fallback'], policy: { keepRawIfSubstantive: false } }).action, 'skip');
eq('nudgeInPrivate=false + skip → 私聊也不发', decideFallback({ raw: '未来可期', cleaned: '嗯', hits: ['fallback'], isPrivate: true, policy: { nudgeInPrivate: false } }).action, 'skip');
eq('实质信息 + 删空 → keep-raw 发原文', decideFallback({ raw: '明天3点对进度', cleaned: '嗯', hits: ['fallback'] }).action, 'keep-raw');

// ── C. 观察期规则：只记录，不改一个字 ────────────────────────────────────
const observeCases = [
  ['empathy-label-2', '我能感觉到你最近挺累的'],
  ['empathic 变体', null, '我也经历过这种事'],
  ['real-talk-opener', '说真的，这事我劝你别碰'],
  ['growth-frame', '换个角度看，这也是成长的机会'],
  ['move-on-close', '反正都过去了，往前看'],
  ['comma-split-cliche', '慢慢来']
];
for (const [id, sample, alt] of observeCases) {
  if (!sample) continue;
  const r = deslopChatText(sample);
  has(`观察期 ${id} 记进 hits`, r.hits.some((h) => h.startsWith('flag:')), JSON.stringify(r.hits));
}
{
  const r = deslopChatText('我能感觉到你最近挺累的');
  has('观察期规则不改写文本（只加 flag）', r.text.includes('累'), r.text);
}
eq('observeHits 直接调用也认 empathic', JSON.stringify(observeHits('我也经历过这种事')), JSON.stringify(['flag:emphatic-understand']));
eq('observeHits 空串返回空数组', JSON.stringify(observeHits('')), '[]');
eq('普通聊天不触发观察规则', JSON.stringify(observeHits('明天下午三点开会')), '[]');

// ── D. 自动豁免词：最长优先 + 占位不破坏内容 ─────────────────────────────
{
  const opts = { keepPhrases: ['鲸鱼', '小鲸鱼', '老张'] };
  const r = deslopChatText('小鲸鱼说老张挺好的', opts);
  eq('长词先保护，短词不切碎长词', r.text, '小鲸鱼说老张挺好的');
  const r2 = deslopChatText('鲸鱼来了', opts);
  eq('短词单独出现也保护', r2.text, '鲸鱼来了');
  const r3 = deslopChatText('希望对你有帮助，小鲸鱼', opts);
  eq('豁免词被保护后不参与清洗', r3.text, '小鲸鱼');
  const r4 = deslopChatText('小鲸鱼', { keepPhrases: ['小鲸鱼'] });
  eq('全是豁免词时不误判为空', r4.text, '小鲸鱼');
  has('豁免词命中不产生 fallback', !r4.hits.includes('fallback'));
}

// ── E. 度量聚合（不落原文） ──────────────────────────────────────────────
{
  const stats = emptyStats();
  recordOutgoing(stats, { at: Date.now(), rawLen: 20, cleanedLen: 10, hits: ['md-bold', 'fallback'], changed: true, action: 'nudge' });
  recordOutgoing(stats, { at: Date.now(), rawLen: 8, cleanedLen: 8, hits: ['flag:聚焦'], changed: false, action: 'normal' });
  const sum = summarizeStats(stats);
  eq('turns 累计', sum.totals.turns, 2);
  eq('changed 累计', sum.totals.changed, 1);
  eq('fallback 计数来自 hits', sum.totals.fallback, 1);
  eq('nudge 计数', sum.totals.nudge, 1);
  eq('规则按次数降序、次数相同按 id 排', sum.rules[0].count, 1);
  eq('avgRawChars', sum.totals.avgRawChars, 14);
  eq('removedRatio', sum.totals.removedRatio, 0.3571);
  eq('不存原文：summary 里没有 text 字段', JSON.stringify(sum).includes('希望对你有帮助'), false);
  has('stats 里没有任何原文字段', !('text' in sum.totals) && !('rawText' in sum));
}
// 剪枝
{
  const stats = emptyStats();
  stats.days['2020-01-01'] = { date: '2020-01-01', turns: 1, rules: {} };
  recordOutgoing(stats, { at: Date.now(), rawLen: 1, cleanedLen: 1, hits: [], action: 'normal' });
  const dropped = pruneStats(stats, { keepDays: 3 });
  eq('剪掉过期日期', dropped, 1);
  has('保留今天', Boolean(stats.days[dayKey()]));
}
// 坏数据兜底
{
  const norm = normalizeStats({ days: { '不是日期': { turns: 'x' }, '2026-01-02': { turns: '3', rules: { a: 'x', b: 2 } } } });
  eq('坏日期被丢掉', Object.keys(norm.days).length, 1);
  eq('坏计数归零', norm.days['2026-01-02'].turns, 3);
  eq('坏规则计数被丢', norm.days['2026-01-02'].rules.a, undefined);
  eq('好规则计数保留', norm.days['2026-01-02'].rules.b, 2);
}
eq('keepDays 默认 30', normalizeAiToneStatsConfig({}).keepDays, 30);
eq('keepDays 越界夹紧', normalizeAiToneStatsConfig({ keepDays: 9999 }).keepDays, 365);
eq('keepDays 非法回落', normalizeAiToneStatsConfig({ keepDays: 'abc' }).keepDays, 30);

// ── F. 语义保真：数字/时间/链接/代码/否定/专名不能被清洗吃掉 ─────────────
const fidelity = [
  ['数字与时间', '明天15:30在3楼会议室', '明天15:30在3楼会议室'],
  ['链接', '看 https://example.com/a?b=1', '看 https://example.com/a?b=1'],
  // 反引号本身会在 md-* 规则里去掉了（QQ 里显示难看），但**代码内容必须留着**
  ['代码内容', '跑 `npm run build` 就行', '跑 npm run build 就行'],
  ['否定', '别把名单发出去', '别把名单发出去'],
  ['专名', 'DeepSeek 的 R1 和 V3', 'DeepSeek 的 R1 和 V3'],
  ['条件', '如果不行就换方案B', '如果不行就换方案B']
];
for (const [name, src, want] of fidelity) {
  eq(`语义保真·${name}`, deslopChatText(src).text, want);
}

// 幂等：清洗两次等于一次（防止「第一次删一半、第二次再删一半」）
const idem = [
  '总而言之呢，这事儿得慢慢来，希望对你有帮助',
  '我能感觉到你最近挺累的，说实话，这也是成长的机会',
  '首先，这个方案不行，其次时间不够'
];
for (const src of idem) {
  const once = deslopChatText(src).text;
  const twice = deslopChatText(once).text;
  eq(`幂等：${src.slice(0, 12)}…`, twice, once);
}

// 不出现「半句残句」：清洗结果不能以逗号/顿号开头或以「，」结尾
const residue = ['首先，这个方案不行', '另外，明天可能下雨', '总的来说，先这样', '需要注意的是，他没来'];
for (const src of residue) {
  const out = deslopChatText(src).text;
  has(`无残句：${src.slice(0, 8)}…`, !/^[，、；：]/.test(out) && !/[，、；：]$/.test(out), out);
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
