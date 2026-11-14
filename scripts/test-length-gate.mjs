// length-gate 长度门控回归测试（纯函数，不依赖 SnowLuma / DSH / QQ）。
// 用法：node scripts/test-length-gate.mjs
import {
  LENGTH_GATE_DEFAULTS,
  normalizeLengthGateConfig,
  planLengthSplit
} from '../src/length-gate.js';

let failed = 0;
let total = 0;
const eq = (name, got, want) => {
  total += 1;
  const ok = got === want;
  if (!ok) failed += 1;
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};
const has = (name, cond, extra = '') => {
  total += 1;
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
};

// 按码点计数（和实现保持一致，emoji 算 1 个字）。
const cp = (s) => [...s].length;
// 测试用的「无标点中文填充料」：78 个字，够拼各种长度，且不含任何标点/URL/反引号。
const FILLER =
  '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光';
const pad = (s, n) => (cp(s) >= n ? s : s + FILLER.slice(0, n - cp(s)));
const plan = (s, o) => planLengthSplit(s, o);

// 信息不丢失检查：两段拼接后必须等于原文（允许拆点处被吃掉一个逗号类字符）。
const stripWs = (s) => s.replace(/\s+/gu, '');
const lostNothing = (s, parts) => {
  const joined = stripWs(parts.join(''));
  const orig = stripWs(s);
  if (joined === orig) return true;
  const at = stripWs(parts[0]).length;
  return (
    '，,；;、'.includes(orig[at]) &&
    orig.slice(0, at) === joined.slice(0, at) &&
    orig.slice(at + 1) === joined.slice(at)
  );
};

// ── A. 长度判定（按码点）────────────────────────────────────────────────
const short = '明天见';
eq('短句不动', plan(short).action, 'none');
eq('短句 parts 保持原文', plan(short).parts.join(''), short);

const exact40 = pad('今天下午三点在图书馆门口集合大家记得带上学生证', 40);
has('构造前提：样本正好 40 码点', cp(exact40) === 40, `实际 ${cp(exact40)}`);
eq('正好 40 字不动', plan(exact40).action, 'none');

const left41 = '今天我们还是按原计划行动吧';
const s41 = left41 + '，' + FILLER.slice(0, 41 - cp(left41) - 1);
has('构造前提：样本正好 41 码点', cp(s41) === 41, `实际 ${cp(s41)}`);
const r41 = plan(s41);
eq('41 字有逗号 → split', r41.action, 'split');
has('split 恰好两段', r41.parts.length === 2, `实际 ${r41.parts.length}`);
has(
  '两段都 ≥ minPartChars(6)',
  cp(r41.parts[0]) >= 6 && cp(r41.parts[1]) >= 6,
  `${cp(r41.parts[0])} / ${cp(r41.parts[1])}`
);

eq('41 字无标点（≤60）→ none', plan(FILLER.slice(0, 41)).action, 'none');

const r61 = plan(FILLER.slice(0, 61));
has('构造前提：样本 61 码点', cp(FILLER.slice(0, 61)) === 61);
eq('61 字无标点长句 → warn', r61.action, 'warn');
eq('warn 时 parts=原文', r61.parts.join(''), FILLER.slice(0, 61));

// 码点计数：41 个 emoji 的 .length 是 82，只有按码点算才会落在 none 区间。
eq('按码点计数：41 个 emoji 不算 82 字', plan('😀'.repeat(41)).action, 'none');

// ── B. 不该拆的类型 → skip ──────────────────────────────────────────────
const urlText = '这个链接你看一下 https://example.com/a/b/c?x=1 里面有说明还要注意看第三段';
const urlPlan = plan(urlText);
eq('含 URL → skip', urlPlan.action, 'skip');
has('URL 的 reason 提到 URL', urlPlan.reason.includes('URL'), urlPlan.reason);
eq('skip 时 parts 保持原文', urlPlan.parts[0], urlText);

const fence = '```js\nconsole.log(1)\n```';
eq('含 Markdown 代码围栏 → skip', plan(fence).action, 'skip');
has('围栏的 reason 提到围栏', plan(fence).reason.includes('围栏'), plan(fence).reason);

eq('含行内反引号 → skip', plan('用 `pnpm` 装依赖，然后重启一下服务就好').action, 'skip');

const prefixWarn = '⚠ 上游超时，已经自动重试三次还是失败，请人工看一眼';
eq('以 ⚠ 开头 → skip', plan(prefixWarn).action, 'skip');
eq('以「系统」开头 → skip', plan('系统提示：当前处于维护模式，请稍后再试').action, 'skip');
eq('以 agent 开头 → skip', plan('agent 已断开，等待重连中，请不要关闭窗口').action, 'skip');
eq('以 ✅ 开头 → skip', plan('✅ 部署成功，可以访问了').action, 'skip');

eq('多行编号清单 → skip', plan('1. 先备份数据库\n2. 再停掉服务\n3. 最后才是升级').action, 'skip');
eq('多行引用块 → skip', plan('> 第一行引用\n> 第二行引用').action, 'skip');
eq('多行但无空行分段 → skip', plan('第一行内容比较长\n第二行内容也比较长').action, 'skip');
eq('清单即使带空行分段也 skip', plan('1. 甲\n\n2. 乙').action, 'skip');

// ── C. 第一段太短 → 不拆 ────────────────────────────────────────────────
const tooShortFirst = '好，' + FILLER.slice(0, 40);
has('构造前提：样本 42 码点', cp(tooShortFirst) === 42, `实际 ${cp(tooShortFirst)}`);
eq('第一段只有「好」→ 不拆', plan(tooShortFirst).action, 'none');
eq('不拆时 parts=原文', plan(tooShortFirst).parts[0], tooShortFirst);

const customMin = '嗯嗯，' + FILLER.slice(0, 40);
eq('minPartChars=2 时同款文本会拆', plan(customMin, { minPartChars: 2 }).action, 'split');
eq('minPartChars 默认值仍不拆', plan(customMin).action, 'none');

// ── D. 拆在逗号处：不留「，」结尾 / 不丢内容 ─────────────────────────────
has('第一段不以逗号结尾', !/[，,；;、]$/u.test(r41.parts[0]), r41.parts[0]);
eq('第一段正好是逗号前的内容', r41.parts[0], left41);
has('s41 拼接还原（补回被吃掉的逗号）', r41.parts[0] + '，' + r41.parts[1] === s41);

// ── E. 括号/引号里不断句 ────────────────────────────────────────────────
const bracket = pad('我们先把手头的活干完再说吧，别急着（其实，也没那么急）反正时间还够', 46);
has('构造前提：括号样本 >40 码点', cp(bracket) > 40, `实际 ${cp(bracket)}`);
const rb = plan(bracket);
eq('括号样本 → split', rb.action, 'split');
eq('在括号外那个逗号处拆', rb.parts[0], '我们先把手头的活干完再说吧');
has('括号内的「，」没被当拆点', rb.parts[1].includes('（其实，也没那么急）'), rb.parts.join(' | '));

const onlyInner = pad('他说（这个方案其实还行，就是有点贵）我们再想想别的办法', 45);
eq('只有括号内有逗号 → 不拆', plan(onlyInner).action, 'none');

// ── F. 拆点优先级：段落 > 句子 > 逗号 ───────────────────────────────────
const para = pad('第一段内容在这里，还有一点补充\n\n第二段内容在这里，也有补充', 45);
const rPara = plan(para);
eq('段落样本 → split', rPara.action, 'split');
eq('优先在段落边界拆（第一段不含换行）', rPara.parts[0], '第一段内容在这里，还有一点补充');
has('第二段从「第二段」开始', rPara.parts[1].startsWith('第二段'), rPara.parts[1].slice(0, 8));

const sent = pad('我们先去吃饭吧。然后回来看电影，顺便买点水果', 44);
const rSent = plan(sent);
eq('句子样本 → split', rSent.action, 'split');
has('句子边界优先于逗号（第一段以「。」结尾）', rSent.parts[0].endsWith('。'), rSent.parts[0]);
eq('句子拆点后第一段', rSent.parts[0], '我们先去吃饭吧。');

// ── G. 信息不丢失（两段拼回去 == 原文）──────────────────────────────────
for (const s of [s41, sent, para, bracket]) {
  const r = plan(s);
  has(
    `拼接不丢内容：${s.slice(0, 10)}…（${cp(s)} 字 → ${r.parts.map(cp).join('+')}）`,
    r.action === 'split' && lostNothing(s, r.parts),
    JSON.stringify(r.parts)
  );
}

// ── H. 配置规范化：非法值回落默认、越界夹紧 ──────────────────────────────
const d = normalizeLengthGateConfig();
eq('默认 splitAbove', d.splitAbove, 40);
eq('默认 warnAbove', d.warnAbove, 60);
eq('默认 minPartChars', d.minPartChars, 6);
eq('默认 maxParts', d.maxParts, 2);
eq('默认 enabled', d.enabled, true);
eq('undefined 输入走默认', normalizeLengthGateConfig(undefined).splitAbove, 40);
eq('null 输入走默认', normalizeLengthGateConfig(null).maxParts, 2);
eq('非对象输入走默认', normalizeLengthGateConfig('oops').warnAbove, 60);
eq('未知字段被忽略', 'foo' in normalizeLengthGateConfig({ foo: 1 }), false);

eq('非法字符串回落默认', normalizeLengthGateConfig({ splitAbove: 'abc' }).splitAbove, 40);
eq('NaN 回落默认', normalizeLengthGateConfig({ splitAbove: NaN }).splitAbove, 40);
eq('Infinity 回落默认', normalizeLengthGateConfig({ splitAbove: Infinity }).splitAbove, 40);
eq('splitAbove 下界夹紧到 10', normalizeLengthGateConfig({ splitAbove: 5 }).splitAbove, 10);
eq('splitAbove 上界夹紧到 500', normalizeLengthGateConfig({ splitAbove: 9999 }).splitAbove, 500);
eq('splitAbove 小数四舍五入', normalizeLengthGateConfig({ splitAbove: 40.6 }).splitAbove, 41);
eq('warnAbove 不得低于 splitAbove', normalizeLengthGateConfig({ splitAbove: 120, warnAbove: 30 }).warnAbove, 120);
eq('warnAbove 非法值回落默认后再抬到 ≥splitAbove', normalizeLengthGateConfig({ splitAbove: 80, warnAbove: 'x' }).warnAbove, 80);
eq('minPartChars 下界夹紧到 2', normalizeLengthGateConfig({ minPartChars: -5 }).minPartChars, 2);
eq('minPartChars 上界夹紧到 50', normalizeLengthGateConfig({ minPartChars: 999 }).minPartChars, 50);
eq('maxParts 下界夹紧到 2', normalizeLengthGateConfig({ maxParts: 1 }).maxParts, 2);
eq('maxParts 上界夹紧到 3', normalizeLengthGateConfig({ maxParts: 10 }).maxParts, 3);
eq('enabled=false 保留', normalizeLengthGateConfig({ enabled: false }).enabled, false);
eq('enabled 非法值回落 true', normalizeLengthGateConfig({ enabled: 'yes' }).enabled, true);
has('返回值被冻结（防止调用方顺手改配置）', Object.isFrozen(normalizeLengthGateConfig()));

// ── I. 配置对行为的影响 ─────────────────────────────────────────────────
eq('enabled=false → none', plan(FILLER.slice(0, 80), { enabled: false }).action, 'none');
has(
  'enabled=false 的 reason 说明已关闭',
  plan(FILLER.slice(0, 80), { enabled: false }).reason.includes('关闭'),
  plan(FILLER.slice(0, 80), { enabled: false }).reason
);
eq('自定义 warnAbove=43 时 45 字无标点 → warn', plan(FILLER.slice(0, 45), { warnAbove: 43 }).action, 'warn');
eq('自定义 splitAbove=100 时 80 字 → none', plan(FILLER.slice(0, 80), { splitAbove: 100 }).action, 'none');
eq('未知配置键不影响判定', plan(s41, { somethingElse: 1 }).action, 'split');
has('拆分结果不超过 maxParts', r41.parts.length <= LENGTH_GATE_DEFAULTS.maxParts);
has('LENGTH_GATE_DEFAULTS 被冻结', Object.isFrozen(LENGTH_GATE_DEFAULTS));
has(
  'action 只会是四种之一',
  ['none', 'split', 'warn', 'skip'].includes(plan(s41).action) &&
    ['none', 'split', 'warn', 'skip'].includes(plan(FILLER.slice(0, 61)).action)
);

console.log(`\n共 ${total} 项断言`);
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
