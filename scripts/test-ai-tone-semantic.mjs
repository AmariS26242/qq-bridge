// 语义保真回归集（P0-6 / 清单 A4）。
//
// 为什么需要它：37 条规则原来只有「实现没坏」的断言（test-ai-tone.mjs），
// 没有「这条规则该不该在这个句子上动手」的尺子。新规则只能靠感觉启用，
// 误伤也只能等群里有人抱怨。这里给每条规则固定三格：
//   正例 —— 必须命中，且必须真的改动了文本
//   反例 —— 长相接近但属于正常说话，必须不命中、且原样返回
//   边界 —— 命中后的产物没有残句、没有孤立标点，且再跑一遍不再变化（幂等）
// 任何一格失败即 exit 1，样例随代码进仓库，删样例等于删证据。
//
// 用法：node scripts/test-ai-tone-semantic.mjs [--no-legacy]
//   --no-legacy  跳过额外执行的 test-ai-tone.mjs（默认会跑，保证老断言不被破坏）
import { deslopChatText, listRules, listRuleSpecs } from '../src/ai-tone.js';

let failed = 0;
let passed = 0;
const ok = (name) => { passed += 1; console.log(`✅ ${name}`); };
const bad = (name, extra = '') => {
  failed += 1;
  console.log(`❌ ${name}${extra ? `\n   ${extra}` : ''}`);
};
const check = (name, cond, extra = '') => (cond ? ok(name) : bad(name, extra));

// 只留规则本身的效果：关掉「短句去句号」「句首确认词」「删空兜底」，
// 否则断言会因为与规则无关的后处理而抖动。
const BASE = { stripTrailingPeriod: false, stripAgreeOpener: false, fallback: '', normalizeDash: false };
const run = (text, opts) => deslopChatText(text, { ...BASE, ...(opts || {}) });
const textOf = (s) => run(s).text;
const hitsOf = (s) => run(s).hits;

// ── 37 条规则 × 正例 / 反例 ────────────────────────────────────────────
// 注意：正例里避免同时触发别的规则，反例里避免触发任何规则（断言更硬）。
const CASES = [
  // A. 心理师腔
  { id: 'empathy-label', pos: '这话听着挺沉的，最近还好吗', neg: '这话听着有点道理' },
  { id: 'say-out-loud', pos: '我能感觉到你最近很累，早点睡', neg: '我感觉这个方案可行' },
  { id: 'sounds-like-you', pos: '听起来你最近挺忙的', neg: '听起来不错' },
  { id: 'i-understand-you', pos: '我理解你的感受', neg: '我理解你的意思' },
  { id: 'feelings-valid', pos: '你的感受是合理的，先睡吧', neg: '这个方案是合理的' },
  { id: 'allow-yourself', pos: '允许自己休息一下', neg: '请允许我介绍一下' },
  { id: 'give-time', pos: '给自己一点时间，早点睡', neg: '给自己买点东西' },
  { id: 'steady-catch', pos: '我会稳稳地接住你的情绪', neg: '稳稳地放在桌上' },
  { id: 'emo-value', pos: '给你提供情绪价值', neg: '这个产品的价值' },
  { id: 'catch-emotion', pos: '我会接住你的情绪的', neg: '接住这个球' },
  { id: 'hen-empathy', pos: '狠狠共情了，说得对', neg: '狠狠批评了一顿' },
  // B. 拔高 / 八股
  { id: 'summary-opener', pos: '综上所述，先这样', neg: '概括能力很重要' },
  { id: 'emphasis-shell', pos: '值得注意的是，他昨天没来', neg: '值得关注的人' },
  { id: 'connectors', pos: '首先，这个方案不行', neg: '首先我要说的是' },
  { id: 'meta-comment', pos: '接下来我们来看看这个方案', neg: '让我们去吃饭吧' },
  { id: 'chicken-soup', pos: '未来可期，加油干活', neg: '未来可能更好' },
  { id: 'wish-you', pos: '愿你被世界温柔以待。早点睡', neg: '愿意' },
  // C. 客服腔
  { id: 'open-list', pos: '以下是关于这个功能的介绍：核心就一条\n别的没了', neg: '以下三件事你得记住' },
  { id: 'for-your', pos: '针对你的问题，我建议先备份', neg: '针对这种情况' },
  { id: 'hope-helpful', pos: '别去！希望以上信息对你有帮助，结案', neg: '希望明天别下雨' },
  { id: 'hope-helpful-2', pos: '希望对你有帮助，先这样', neg: '希望对你有用' },
  { id: 'ask-anytime', pos: '如果还有问题可以随时问我，先忙', neg: '如果有问题我知道找谁' },
  { id: 'ask-anytime-2', pos: '有问题随时找我，别客气', neg: '有问题就解决' },
  { id: 'wish-day', pos: '祝你周末愉快，回头聊', neg: '祝你生日快乐' },
  { id: 'thanks-question', pos: '感谢你的提问，我确认下', neg: '感谢你的帮助' },
  { id: 'glad-help', pos: '很高兴能为你解答\n情况是这样', neg: '很高兴认识你' },
  { id: 'other-questions', pos: '还有其他问题吗？没有就散会', neg: '还有其他事' },
  // D. Markdown 残留
  { id: 'md-bold', pos: '**重点**在这', neg: '算式 3*4=12' },
  { id: 'md-italic', pos: '*斜体*在这', neg: '单星号 * 不构成斜体' },
  { id: 'md-code', pos: '用 `npm i` 装', neg: '没有反引号' },
  { id: 'md-strike', pos: '~~删掉~~这个', neg: '~单个波浪线' },
  { id: 'md-underline', pos: '__下划线__这个', neg: '_单个下划线' },
  { id: 'md-heading', pos: '# 标题党来了', neg: 'C# 语言' },
  { id: 'md-quote', pos: '> 引用一句', neg: 'a > b' },
  { id: 'md-bullet', pos: '- 第一条', neg: '单价 - 5 元' },
  { id: 'md-number', pos: '1. 第一条', neg: '2026.10.26 发布' },
  // E. 程度副词
  { id: 'degree-adverb', pos: '非常强大', neg: '非常规手段' }
];

// ── 0. 映射表完整性：规则数、id 集合必须与实现一致 ─────────────────────
const implIds = listRules().map((r) => r.id);
const caseIds = CASES.map((c) => c.id);
check('规则总数 = 37', implIds.length === 37, `实际 ${implIds.length}`);
const missing = implIds.filter((id) => !caseIds.includes(id));
const unknown = caseIds.filter((id) => !implIds.includes(id));
check('每条规则都有样例（无空缺）', missing.length === 0, `缺 ${missing.join(', ')}`);
check('样例里没有已删除的规则 id', unknown.length === 0, `多出 ${unknown.join(', ')}`);
check('样例表无重复 id', new Set(caseIds).size === caseIds.length);

// ── 1. 正例 / 反例 / 边界 ──────────────────────────────────────────────
for (const c of CASES) {
  const posOut = run(c.pos);
  check(`[${c.id}] 正例命中`, posOut.hits.includes(c.id), `hits=${JSON.stringify(posOut.hits)}`);
  check(`[${c.id}] 正例确有改动`, posOut.text !== c.pos, `text=${JSON.stringify(posOut.text)}`);

  const negOut = run(c.neg);
  check(`[${c.id}] 反例不命中`, !negOut.hits.includes(c.id), `hits=${JSON.stringify(negOut.hits)}`);
  check(`[${c.id}] 反例原样返回`, negOut.text === c.neg, `text=${JSON.stringify(negOut.text)}`);

  // 边界：产物不留残句 / 孤立标点
  const t = posOut.text;
  check(`[${c.id}] 产物无残句`, !/^[，。！？；、：\s]/.test(t) && !/[，、；：]{2}|[，。；：]$/.test(t) && t !== '', `text=${JSON.stringify(t)}`);
  // 边界：幂等（跑第二遍不再变化）
  check(`[${c.id}] 幂等`, run(t).text === t, `once=${JSON.stringify(t)} twice=${JSON.stringify(run(t).text)}`);
}

// ── 2. 必查 ①：否定词与条件词必须留住 ─────────────────────────────────
const negationCases = [
  { name: '否定词「不想」保留', input: '我不想给自己一点时间', must: ['不'] },
  { name: '否定词「没」保留', input: '我没说我理解你的感受', must: ['没'] },
  { name: '条件词「如果」保留', input: '如果你不想休息，那就继续', must: ['如果', '不想'] },
  { name: '转折「但」保留', input: '但是我真的不行', must: ['但'] }
];
for (const c of negationCases) {
  const out = textOf(c.input);
  const kept = c.must.every((w) => out.includes(w));
  check(`必查① ${c.name}`, kept, `input=${JSON.stringify(c.input)} out=${JSON.stringify(out)}`);
}

// ── 3. 必查 ②：数字 / 时间 / 链接 / 专名 / 代码原样保留 ────────────────
const fidelityCases = [
  {
    name: '数字与时间不被吞',
    input: '明天 10:30 在 3 号楼集合，别迟到',
    must: ['10:30', '3 号楼']
  },
  {
    name: '链接原样保留',
    input: '看这个 https://b23.tv/abc123 再说',
    must: ['https://b23.tv/abc123']
  },
  {
    name: '专名不被删改',
    input: '《三体》第二部拍得比第一部好',
    must: ['《三体》', '第二部', '第一部']
  },
  {
    name: '命令/路径不被改写',
    input: '跑 npm run test:ai-tone 看结果',
    must: ['npm run test:ai-tone']
  }
];
for (const c of fidelityCases) {
  const out = textOf(c.input);
  const kept = c.must.every((w) => out.includes(w));
  check(`必查② ${c.name}`, kept, `input=${JSON.stringify(c.input)} out=${JSON.stringify(out)}`);
}

// ── 4. 必查 ③：不产生残句 —— 全量正例产物统一体检 ─────────────────────
{
  const badOnes = [];
  for (const c of CASES) {
    const t = run(c.pos).text;
    if (/^[，。！？；、：]/.test(t)) badOnes.push({ id: c.id, why: '句首孤立标点', t });
    if (/[，。；：]{2}/.test(t)) badOnes.push({ id: c.id, why: '连续标点', t });
    if (/（\s*）/.test(t)) badOnes.push({ id: c.id, why: '空括号', t });
  }
  check('必查③ 全部正例无残句', badOnes.length === 0, JSON.stringify(badOnes));
}

// ── 5. 必查 ④：幂等（整段混合文本跑两遍结果一致）──────────────────────
{
  const mixed = '首先，我理解你的感受。希望对你有帮助。**重点**在这。';
  const once = textOf(mixed);
  check('必查④ 混合文本幂等', run(once).text === once, `once=${JSON.stringify(once)}`);
}

// ── 6. 必查 ⑤：跨场景误伤 —— 正常口语不能被规则吃掉 ───────────────────
const crossScene = [
  { name: '「让我们一起…」是正常邀约', input: '让我们一起为未来加油！' },
  { name: '「非常规」不是程度副词', input: '这是非常规操作' },
  { name: '「我理解你的意思」是正常接话', input: '我理解你的意思' },
  { name: '「未来可能」不是鸡汤', input: '未来可能更好' },
  { name: '「下面我们吃饭」不是列表开场', input: '下面我们吃饭' },
  { name: '「感谢你的帮助」不是客服口径', input: '感谢你的帮助' }
];
for (const c of crossScene) {
  const out = run(c.input);
  check(`必查⑤ ${c.name}`, out.text === c.input, `out=${JSON.stringify(out.text)} hits=${JSON.stringify(out.hits)}`);
}

// ── 7. 必查 ⑦：替换串的 $n 必须真的有捕获组，且产物里不许出现字面量 $n ────
// 真实事故：hope-helpful 写成 to:'$1' 但正则没有捕获组，线上把
// 「…情绪。希望这个解释对你有帮助！」清成「…情绪$1」——AI 评审一眼看出「$1」是坏的，
// 人类评审未必会为这种角落写备注，所以必须由测试兜住。
{
  const specs = listRuleSpecs();
  const offenders = [];
  for (const s of specs) {
    let groups = 0;
    for (let i = 0; i < s.source.length; i += 1) {
      if (s.source[i] === '\\') { i += 1; continue; }
      if (s.source[i] === '(' && s.source[i + 1] !== '?') groups += 1;
      else if (s.source[i] === '(' && s.source[i + 1] === '?' && s.source[i + 2] === '<' && s.source[i + 3] !== '=' && s.source[i + 3] !== '!') groups += 1;
    }
    const refs = [...String(s.to ?? '').matchAll(/\$(\d)/g)].map((m) => Number(m[1]));
    const maxRef = refs.length ? Math.max(...refs) : 0;
    if (maxRef > groups) offenders.push(`${s.id}(to=${JSON.stringify(s.to)},组数=${groups})`);
  }
  check('必查⑦ 所有规则的 $n 引用都有对应捕获组', offenders.length === 0, offenders.join(' / '));

  const c15 = run('这个梗来源于网络流行语，通常用来表达一种无奈又好笑的情绪。希望这个解释对你有帮助！');
  check(
    '必查⑦ 句子级删除不残留 $1 字面量',
    !/\$\d/.test(c15.text),
    `out=${JSON.stringify(c15.text)} hits=${JSON.stringify(c15.hits)}`
  );

  const leaks = [];
  for (const c of crossScene) {
    const out = run(c.input);
    if (/\$\d/.test(out.text)) leaks.push(`${c.name} → ${JSON.stringify(out.text)}`);
  }
  for (const c of CASES) {
    for (const [kind, input] of [['pos', c.pos], ['neg', c.neg]]) {
      const out = run(input);
      if (/\$\d/.test(out.text)) leaks.push(`${c.id}.${kind} → ${JSON.stringify(out.text)}`);
    }
  }
  check('必查⑦ 全量样例清洗产物无 $n 残留', leaks.length === 0, leaks.slice(0, 5).join(' / '));
}

// ── 8. 必查 ⑥：原有断言不被破坏（默认额外跑一次老回归）─────────────────
// 老脚本末尾会 process.exit()，所以不能在进程内 import —— 只能起子进程跑一遍。
if (!process.argv.includes('--no-legacy')) {
  let spawnSync = null;
  try {
    ({ spawnSync } = await import('node:child_process'));
  } catch { /* 受限环境拿不到子进程模块 */ }
  if (!spawnSync) {
    console.log('⚠️  必查⑥ 跳过：当前环境不允许起子进程，请单独运行 node scripts/test-ai-tone.mjs');
  } else {
    console.log('\n── 必查⑥ 原有回归 test-ai-tone.mjs ──');
    let res = null;
    try {
      res = spawnSync(process.execPath, ['scripts/test-ai-tone.mjs'], { stdio: 'inherit', timeout: 120000 });
    } catch (error) {
      console.log(`⚠️  必查⑥ 跳过：子进程启动失败（${error?.message ?? error}），请单独运行 node scripts/test-ai-tone.mjs`);
    }
    if (res) {
      check('必查⑥ 原有断言仍全绿', res.status === 0, `exit=${res.status}${res.signal ? ` signal=${res.signal}` : ''}`);
    }
  }
}

console.log(`\n${failed === 0 ? '全部通过' : '存在失败'}：${passed} 条通过，${failed} 条失败`);
process.exit(failed === 0 ? 0 : 1);
