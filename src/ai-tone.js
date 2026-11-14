// 出站文本「去 AI 味」后处理。
//
// 为什么必须有这一层：人格卡/预设提示词只能降低概率，管不住“已经生成出来”的句子。
// 用户实测最刺眼的是心理师腔（「这话听着挺沉」）——它不是一个坏词，而是
// 「把对方的话总结成一个情绪形容词，再评论一句」的句式模板，提示词写“禁止”也会漏。
// 所以这里做**确定性的删/换**，不重写句子：规则命中就删掉或换掉，剩下的话保持原样。
//
// 设计约束：
//   1. 只做删除与 1:1 替换，不做 paraphrase——后处理不该替模型重新组织语言。
//   2. 每条规则带 why，命中可解释；日志只报规则 id，便于回头调整。
//   3. 全部可关：config.json 的 aiTone.enabled=false 直接短路。
//   4. 不碰代码块之外的“技术内容”？——不，QQ 端不发技术内容，统一处理。
//
// 词表来源（见 docs/ai-tone-research.md）：
//   - 中国社科院语言所转载《智能写作的“AI味”问题》：高频中性词、句长均匀、总分总模板
//   - 0xtresser/cn-humanizer：18 类中文 AI 写作模式（意义拔高/空洞归纳/排比/机器人开场…）
//   - VincentOld/stop-slop-zh：中文 AI 套话黑名单（八股连接词、强调虚壳、鸡汤收尾…）
//   - DavidLam-oss/wechat-writing-team ai_smell_guide：L1 极刑词汇（“稳稳地接住”“情绪价值”…）
//   - LiveKit《Prompting voice agents to sound more realistic》：用正反例 + 多角度重复规则

const CLAUSE_END = '[，。！？；\\n]';

/**
 * @typedef {Object} ToneRule
 * @property {string} id    规则 id（进日志）
 * @property {string} why   为什么要删（进文档 / 排错）
 * @property {RegExp} re    匹配（必须带 g）
 * @property {string} to    替换串（''=删除；可用 $1 保留捕获）
 */

/** @type {ToneRule[]} */
const RULES = [
  // ── A. 心理师腔 / 伪共情 ──────────────────────────────────────────────
  {
    id: 'empathy-label',
    why: '把对方的话总结成一个情绪形容词再评论（「这话听着挺沉」「听着就心累」），最典型的 AI 心理师腔',
    re: /(^|[，。！？；\n])[ \t]*(?:这|那)(?:话|句话|段话|事儿|事)(?:听|说|看)(?:着|起来)(?:挺|很|真|蛮|怪|有点|太|那么|够)(?:沉|重|累|苦|难|憋|压抑|揪心|心酸|不是滋味|不容易|难受)[^，。！？；\n]{0,6}?(?:的|了|啊|吧)?(?:[，。！？；、]|$)/g,
    to: '$1'
  },
  {
    id: 'say-out-loud',
    why: '「我听出来/我能感觉到你…」= 客服式倾听痕迹：先声明自己在听，再接情绪',
    re: /(^|[，。！？；\n])[ \t]*(?:我)?(?:也)?(?:能|可以)?(?:听得?出(?:来)?|看得?出(?:来)?|感觉(?:得)?到|察觉到)[，,]?[ \t]*/g,
    to: '$1'
  },
  {
    id: 'sounds-like-you',
    why: '「听起来你…」是把观察包装成关心，真人一般直接接话',
    re: /(^|[，。！？；\n])[ \t]*(?:听起来|听上去)[，,]?[ \t]*(?=你|您)/g,
    to: '$1'
  },
  {
    id: 'i-understand-you',
    why: '「我理解你的感受」是教科书级客服句，中文聊天里没有这个说法',
    re: /我(?:完全|非常|特别|很|也)?理解你(?:的)?(?:感受|心情|难处|处境|不容易)/g,
    to: '懂'
  },
  {
    id: 'feelings-valid',
    why: '「你的感受是合理的/正常的」= 心理量表式肯定，QQ 闲聊不会这样说',
    re: /(?:你(?:的)?|你这些)(?:感受|情绪|想法)(?:都|也)?(?:是)?(?:完全)?(?:合理|正常|可以理解|值得被看见)(?:的)?/g,
    to: ''
  },
  {
    id: 'allow-yourself',
    why: '「允许自己…」是 AI 鸡汤固定开头',
    re: /允许自己/g,
    to: ''
  },
  {
    id: 'give-time',
    why: '「给自己一点时间/空间」鸡汤句',
    re: /给自己(?:一点|一些|点)(?:时间|空间)(?:和|与)?(?:耐心)?/g,
    to: ''
  },
  {
    id: 'steady-catch',
    why: '「稳稳地接住你的情绪」是 AI 共情模板的重灾区（ai_smell_guide 列为极刑词）',
    re: /稳稳(?:地|的)?(?:接住|托住|接好)(?:你(?:的)?)?(?:情绪)?/g,
    to: ''
  },
  {
    id: 'emo-value',
    why: '「情绪价值」是流行语滥用，列为极刑词',
    re: /(?:提供|给出|满满的?)?情绪价值/g,
    to: ''
  },
  {
    id: 'catch-emotion',
    why: '「接住你的情绪」同上',
    re: /(?:接住|接好)(?:了)?你的?情绪/g,
    to: ''
  },
  {
    id: 'hen-empathy',
    why: '「狠狠共情」「狠狠懂了」是网络流行语滥用，语气过猛',
    re: /狠狠(?:地|的)?(?:共情|懂了?|get|Get|拿捏)/g,
    to: ''
  },

  // ── B. 总结 / 拔高 / 收尾金句 ─────────────────────────────────────────
  {
    id: 'summary-opener',
    why: '「综上所述/总而言之/总之/由此可见」是总分总八股的骨架',
    re: /(^|[，。！？；\n])[ \t]*(?:综上所述|总而言之|总的来说|总之|概括(?:起来|来说)|由此可见|不难看出|不难发现|归根结底)(?:[，、,：:]|呢|吧|啊)?/g,
    to: '$1'
  },
  {
    id: 'emphasis-shell',
    why: '「值得注意的是/不得不说/毫无疑问/说白了」是强调虚壳，删掉后句子照样成立',
    re: /(^|[，。！？；\n])[ \t]*(?:值得注意的是|值得一提的是|值得关注的是|不得不说|不可否认|毫无疑问|毋庸置疑|不容忽视|不言而喻|说白了|换句话说|换言之|本质上)(?:[，、,：:]|吧|啊)?/g,
    to: '$1'
  },
  {
    id: 'connectors',
    why: '「首先/其次/最后/此外」开头的骨架连接词（真人也说“另外”，但成串出现就是 AI）',
    re: /(^|[，。！？；\n])[ \t]*(?:首先|其次|再次|最后|再者|此外|另外|与此同时|不仅如此|更重要的是|除此之外|一方面)[，、,]/g,
    to: '$1'
  },
  {
    id: 'meta-comment',
    why: '「接下来我们来看/让我们来看看」是元评论：预告自己要讲什么。必须锚定动词，否则「让我们去吃饭」会被误删',
    re: /(^|[，。！？；\n])[ \t]*(?:接下来(?:我|我们)?|下面(?:我们)?|让我们)(?:来|就)?(?:看看|看一下|看|说说|说|聊聊|聊|讲讲|讲|探讨|分析)(?:一下|下)?[，、,]?/g,
    to: '$1'
  },
  {
    id: 'chicken-soup',
    why: '「未来可期/大有可为/拭目以待」鸡汤收尾',
    re: /(?:未来可期|前景广阔|大有可为|值得期待|充满无限可能|拭目以待|砥砺前行|向阳而生|奔赴山海|心之所向)[。！，,]?/g,
    to: ''
  },
  {
    id: 'wish-you',
    why: '「愿你…」抒情扩散句',
    re: /愿(?:你|我们|每一个)[^。！？\n]{0,20}[。！？]?/g,
    to: ''
  },

  // ── C. 客服腔 ─────────────────────────────────────────────────────────
  {
    id: 'open-list',
    why: '「以下是关于…的介绍」是机器人开场',
    re: /(^|[，。！？；\n])[ \t]*(?:以下是|下面是)[^。！？；\n]{0,20}[：:，。！？]?/g,
    to: '$1'
  },
  {
    id: 'for-your',
    why: '「针对你的问题/关于你提到的」客服味儿',
    re: /(?:针对你(?:的)?(?:问题|需求|情况)|关于你(?:提到|说)的|按照你的要求)/g,
    to: ''
  },
  {
    id: 'hope-helpful',
    why: '「希望以上信息对你有所帮助」是客服收尾',
    re: /(^|[，。！？；\n])[ \t]*希望(?:这|以上|这些|我|这个)[^。！？；\n]{0,20}?(?:有帮助|帮到你|对你有用)[^。！？；\n]{0,4}[。！？]?/g,
    to: '$1'
  },
  {
    id: 'hope-helpful-2',
    why: '同上，短句式',
    re: /希望对你有(?:所)?帮助[。！？]?/g,
    to: ''
  },
  {
    id: 'ask-anytime',
    why: '「有问题随时问我」售后话术',
    re: /(?:如(?:果)?你?(?:还|有)?[^。！？\n]{0,6}?(?:问题|疑问|需要)[，,]?[^。！？\n]{0,8}?(?:随时|可以|尽管)[^。！？\n]{0,8}?(?:问我|找我|联系我|说|告诉我|咨询))[。！？]?/g,
    to: ''
  },
  {
    id: 'ask-anytime-2',
    why: '「有问题随时问我」售后话术（动词锚定的短变体）',
    re: /(?:如果|要是)?有(?:什么|任何)?(?:问题|疑问|需要)[，,]?(?:随时|可以|尽管|就)?(?:问我|找我|联系我|告诉我|说一声|喊我)[。！？]?/g,
    to: ''
  },
  {
    id: 'wish-day',
    why: '「祝你生活愉快」客服收尾',
    re: /祝你(?:生活愉快|工作顺利|天天开心|有个好心情|周末愉快|一天愉快|学习愉快)[！!。]?/g,
    to: ''
  },
  {
    id: 'thanks-question',
    why: '「感谢你的提问」是 AI 客服口径',
    re: /(?:非常|很|十分)?感谢(?:你|您)(?:的)?(?:提问|关注|信任|支持)[！!。，,]?/g,
    to: ''
  },
  {
    id: 'glad-help',
    why: '「很高兴能为你解答」客服措辞',
    re: /很高兴(?:能|能够)?(?:为你|为您)?(?:解答|帮你|帮到你|提供帮助)[^。！？\n]{0,8}[。！？]?/g,
    to: ''
  },
  {
    id: 'other-questions',
    why: '「还有其他问题吗」客服收尾',
    re: /还有其他问题(?:吗|么)?[？?]?/g,
    to: ''
  },

  // ── D. Markdown 残留（QQ 是纯文本，星号井号本身就是 AI 痕迹）──────────
  {
    id: 'md-bold',
    why: 'QQ 里 **粗体** 不渲染，只剩星号，一眼 AI',
    re: /\*\*([^*\n]+)\*\*/g,
    to: '$1'
  },
  {
    id: 'md-italic',
    why: '同上，*斜体*',
    re: /(?<!\*)\*([^*\n]+)\*(?!\*)/g,
    to: '$1'
  },
  {
    id: 'md-code',
    why: '行内反引号',
    re: /`([^`\n]+)`/g,
    to: '$1'
  },
  {
    id: 'md-strike',
    why: '~~删除线~~',
    re: /~~([^~\n]+)~~/g,
    to: '$1'
  },
  {
    id: 'md-underline',
    why: '__下划线__',
    re: /__([^_\n]+)__/g,
    to: '$1'
  },
  {
    id: 'md-heading',
    why: '行首 # 标题',
    re: /^#{1,6}[ \t]+/gm,
    to: ''
  },
  {
    id: 'md-quote',
    why: '行首 > 引用',
    re: /^[ \t]*>[ \t]?/gm,
    to: ''
  },
  {
    id: 'md-bullet',
    why: '行首 - / * 列表符：聊天里列点就是 AI 味',
    re: /^[ \t]*[-*+][ \t]+/gm,
    to: ''
  },
  {
    id: 'md-number',
    why: '行首 1. 编号列表',
    re: /^[ \t]*\d+[.、)][ \t]+/gm,
    to: ''
  },

  // ── E. 程度副词（真的/特别/确实 有真人感，保留；只删最塑料的两个）──────
  {
    id: 'degree-adverb',
    why: '「非常/极其」是刷量词，删掉不损失信息（“非常规”除外）',
    re: /(?:非常(?!规)|极其)/g,
    to: ''
  }
];

/**
 * 1:1 替换的黑话表（不能删，删了句子不通；换成人话）。
 * 只收「换掉之后语法仍然成立」的词，模棱两可的放 FLAG_ONLY。
 * @type {Array<[string, string]>}
 */
const WORD_MAP = [
  ['赋能', '帮'],
  ['助力', '帮'],
  ['打造', '做'],
  ['深耕', '做'],
  ['引领', '带'],
  ['全方位', '各方面'],
  ['多维度', '几个方面'],
  ['底层逻辑', '根本原因'],
  ['顶层设计', '大方向'],
  ['抓手', '办法'],
  ['降本增效', '省钱'],
  ['提质增效', '提速'],
  ['颗粒度', '粗细'],
  ['护城河', '优势'],
  ['生态位', '位置'],
  ['撬动', '带动'],
  ['数智化', '数字化'],
  ['沉浸式', ''],
  ['一站式', ''],
  ['闭环', '完整流程'],
  ['心智', '印象']
];

/**
 * 书面腔 → 口语腔。中文 AI 味最稳定的特征不是某个热词，而是整句书面语化：
 * 「因此/例如/以及/是否/进行了/进一步」这类词真人打字不会用，但模型默认就用。
 * 长词在前，避免「但是」被「但」先吃掉。
 */
const FORMAL_MAP = [
  ['进行了', ''],
  ['需要注意的是', '注意'],
  ['除此之外', '另外'],
  ['与此同时', '同时'],
  ['总的来说', ''],
  ['总体而言', '整体上'],
  ['进一步', '再'],
  ['以及', '和'],
  ['此外', '另外'],
  ['例如', '比如'],
  ['因此', '所以'],
  ['然而', '但'],
  ['并且', '还'],
  ['但是', '但'],
  ['似乎', '好像'],
  ['或许', '可能'],
  ['目前', '现在'],
  ['立即', '马上'],
  ['立刻', '马上'],
  ['仍然', '还'],
  ['依然', '还'],
  ['曾经', '以前'],
  ['如何', '咋'],
  ['为何', '为啥'],
  ['是否', '是不是'],
  ['何时', '啥时候'],
  ['许多', '好多'],
  ['无论', '不管'],
  ['对于', '对'],
  ['十分', '挺'],
  ['尤其', '特别'],
  ['渐渐', '慢慢'],
  ['大约', '差不多']
];

/** 只统计不修改的黑话（换成什么都会别扭，交给提示词和人看日志）。 */
const FLAG_ONLY = ['聚焦', '链路', '沉淀', '复盘', '对齐', '拉齐', '打通', '跑通', '引爆', '势能', '第一性原理', '增长飞轮', '信息差', '认知差'];

/**
 * P0-5：观察期规则 —— 只记命中、绝不改写（docs/AI-TONE-SOLUTION.md §11 六条）。
 *
 * 为什么不直接删：这几条句式看着像 AI，但真人也会说（「说真的，我也有点烦」是正常接话）。
 * 没有命中数据就上删除，就是把「AI 腔」换成「莫名其妙少半句」。先把它们挂进 hits（flag:xxx），
 * 等 state/ai-tone-stats.json 里能看到「命中多、且在群里被误伤的样本」，再决定收不收。
 */
const OBSERVE_RULES = [
  // 感知 + 就 + 负向形容词（句首的心理师开场）
  ['empathy-label-2', /(?:^|\n)[ \t]*(?:我)?(?:能)?(?:感觉到|感受到|看得出|看出来)[^\n。！？]{0,8}(?:很|挺|有点|有些|特别)?[ \t]*(?:累|难过|难受|委屈|焦虑|疲惫|不容易|辛苦|压力大)/],
  // 强调式共情（我也经历过 / 我太懂了）
  ['emphatic-understand', /(?:我也经历过|我太懂了|我完全理解|我特别理解|我太理解|我懂那种)/],
  // 句首「说真的，/说实话，」
  ['real-talk-opener', /(?:^|\n)[ \t]*(?:说真的|说实话|其实吧|讲真)[，,]/],
  // 成长框架（换个角度…成长/经历/财富/必经之路）
  ['growth-frame', /(?:(?:换个角度|往好处想|换个方向看|换个思路)[^\n。！？]{0,20}(?:成长|经历|财富|必经之路)|(?:这也是|这都是|那都是)[^\n。！？]{0,6}(?:成长|经历|财富|必经之路))/],
  // 收尾劝人往前看
  ['move-on-close', /(?:反正都过去了|往前看|日子还得过|会好起来的|时间会治愈)/],
  // 整条只有一句安慰套话
  ['comma-split-cliche', /^[ \t]*(?:你先别急|慢慢来|别想太多|先别着急)[。！？!?，,～~ ]*$/]
];

/** 观察期命中 id 列表（供 deslopChatText 并入 hits、供控制台展示）。 */
export function observeHits(text) {
  const s = String(text ?? '');
  if (!s) return [];
  const out = [];
  for (const [id, re] of OBSERVE_RULES) {
    re.lastIndex = 0;
    if (re.test(s)) out.push(`flag:${id}`);
  }
  return out;
}

/** 规则命中后的标点修补顺序（删除会把「，」留在句首、留下连续标点）。 */
const PUNCT_FIXES = [
  [/[ \t]+([，。！？；：])/g, '$1'],
  [/（\s*）/g, ''],
  [/([，、；：])[ \t]*[，、；：]+/g, '$1'],
  [/([。！？])[，、；：]+/g, '$1'],
  [/([。！？])\1+/g, '$1'],
  [/[ \t]{2,}/g, ' '],
  [/^[ \t，、；：。！？!?,]+/gm, ''],
  [/[ \t]+$/gm, ''],
  [/\n{3,}/g, '\n\n']
];

// 句首确认式开场：「行，那就这样」「好的，我看一下」。
// 单看每个词都正常，连在一起就是客服接单的口气；真人一句里要么直接答，要么只说个「行」。
// 注意只吃「词 + 逗号」这种跟随后文的形态，光一个「行」不碰。
const AGREE_OPENER_RE = /^(?:[ \t]*(?:行|好|好的|可以的|没问题|明白了|收到|懂了|了解)[，,]\s*)+/;

const DEFAULT_OPTIONS = {
  enabled: true,
  // 整条消息被删空时的兜底（比把 AI 味原样发出去强）
  fallback: '嗯',
  // 短句去掉句号：真人在 QQ 里很少给一句话加句号
  stripTrailingPeriod: true,
  trailingPeriodMaxLen: 28,
  // 「——」→「，」（AI 爱用破折号，但真人也会用，默认关）
  normalizeDash: false,
  // 删掉句首的确认式开场（「行，」「好的，」「没问题，」）：真人接话直接说内容
  stripAgreeOpener: true,
  // 追加屏蔽词：字符串数组，支持 "原词=>替换" 语法
  extraPhrases: [],
  // 豁免词：先占位保护再还原，避免误伤群名/梗/人名
  keepPhrases: [],
  // 命中日志
  logHits: true
};

// 桥接层（src/bridge.js）用这份默认值拼 cfg.aiTone，config.json 里只写要覆盖的键。
export const AI_TONE_DEFAULTS = { ...DEFAULT_OPTIONS };

// 执行顺序：Markdown 残留清洗必须先跑，否则 **希望** 这类被星号包住的段落
// 会让文体规则（要求前面是标点）漏看，一次过滤不干净、要跑第二遍才生效。
const APPLY_ORDER = [
  ...RULES.filter((r) => r.id.startsWith('md-')),
  ...RULES.filter((r) => !r.id.startsWith('md-'))
];

/** extraPhrases 里的 "a=>b" 解析成 [a, b]；没有 => 视为删除。 */
function parseExtraPhrase(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const i = s.indexOf('=>');
  if (i < 0) return [s, ''];
  const from = s.slice(0, i).trim();
  if (!from) return null;
  return [from, s.slice(i + 2)];
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 文本去 AI 味。
 * @param {string} text
 * @param {object} [options] 覆盖 DEFAULT_OPTIONS 的任意字段
 * @returns {{ text: string, hits: string[], changed: boolean }}
 */
export function deslopChatText(text, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...(options && typeof options === 'object' ? options : {}) };
  const original = String(text ?? '');
  if (opts.enabled === false || !original) return { text: original, hits: [], changed: false };

  /** @type {string[]} */
  const hits = [];
  let out = original;

  // 豁免词：占用一个不太可能出现在中文聊天里的私用区字符。
  // P0-3 要求**最长词优先**：如果同时有「小鲸鱼」和「鲸鱼」，先保护长的那条，
  // 否则「小鲸鱼」会被拆成「小」+占位符，还原后长短都对不上（短词先占位会把长词切碎）。
  const keepers = (Array.isArray(opts.keepPhrases) ? opts.keepPhrases : [])
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .sort((a, b) => [...b].length - [...a].length || a.localeCompare(b));
  const restore = [];
  keepers.forEach((phrase, idx) => {
    if (!out.includes(phrase)) return;
    const token = `\uE000${idx}\uE001`;
    out = out.split(phrase).join(token);
    restore.push([token, phrase]);
  });

  for (const rule of APPLY_ORDER) {
    rule.re.lastIndex = 0;
    const before = out;
    out = out.replace(rule.re, rule.to);
    if (out !== before) hits.push(rule.id);
  }

  if (opts.stripAgreeOpener) {
    const before = out;
    out = out.replace(AGREE_OPENER_RE, '');
    if (out !== before) hits.push('agree-opener');
  }

  for (const [from, to] of WORD_MAP) {
    if (!out.includes(from)) continue;
    out = out.split(from).join(to);
    hits.push(`word:${from}`);
  }

  for (const [from, to] of FORMAL_MAP) {
    if (!out.includes(from)) continue;
    out = out.split(from).join(to);
    hits.push(`formal:${from}`);
  }

  for (const word of FLAG_ONLY) {
    if (out.includes(word)) hits.push(`flag:${word}`);
  }

  // 观察期规则：只记账、不改写（见 OBSERVE_RULES 注释）。
  // 判断用 original：清洗已经把句式改掉的样本，事后看不出来它原本长什么样。
  for (const hitId of observeHits(original)) {
    if (!hits.includes(hitId)) hits.push(hitId);
  }

  const extras = (Array.isArray(opts.extraPhrases) ? opts.extraPhrases : [])
    .map(parseExtraPhrase)
    .filter(Boolean);
  for (const [from, to] of extras) {
    if (!out.includes(from)) continue;
    out = out.split(from).join(to);
    hits.push(`extra:${from}`);
  }

  if (opts.normalizeDash) {
    const before = out;
    out = out.replace(/——+/g, '，');
    if (out !== before) hits.push('dash');
  }

  for (const [re, to] of PUNCT_FIXES) {
    out = out.replace(re, to);
  }

  // 短句去句号：只在「单行 + 短 + 唯一一个句号在尾部」时做
  const maxLen = Number(opts.trailingPeriodMaxLen) || DEFAULT_OPTIONS.trailingPeriodMaxLen;
  if (opts.stripTrailingPeriod && !out.includes('\n') && out.length <= maxLen && out.endsWith('。')) {
    const body = out.slice(0, -1);
    if (!/[。！？]/.test(body)) {
      out = body;
      hits.push('trailing-period');
    }
  }

  out = out.trim();

  for (const [token, phrase] of restore) {
    out = out.split(token).join(phrase);
  }

  // 全被删空：宁可发一个「嗯」，也不要把 AI 味原样吐回去
  if (!out && original.trim()) {
    out = String(opts.fallback ?? DEFAULT_OPTIONS.fallback);
    hits.push('fallback');
  }

  return { text: out, hits, changed: out !== original };
}

/**
 * 兜底策略（P0-2）：整条被删空时到底发什么。默认「不发」。
 *
 * 为什么不能一刀切：旧实现把删空一律换成「嗯」。这条在私聊里还算自然，
 * 在群里对一句「希望对你有帮助」回一个「嗯」，比原句更像机器人 —— 而且它把
 * 「其实有话要说」和「确实没内容」两种情况压成了同一种表现。
 */
export const FALLBACK_POLICY_DEFAULTS = Object.freeze({
  // skip = 群聊删空不发（默认）；nudge = 删空发 fallbackText；off = 返回空串交给上层决定
  mode: 'skip',
  // 原文有实质信息（数字/链接/否定/代码/够长）时，宁可发原文也不发「嗯」
  keepRawIfSubstantive: true,
  // 私聊删空仍发一句：私聊里对方盯着对话框，一句话不回比「嗯」更怪
  nudgeInPrivate: true,
  fallbackText: '嗯'
});

export function normalizeFallbackPolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = ['skip', 'nudge', 'off'].includes(src.mode) ? src.mode : FALLBACK_POLICY_DEFAULTS.mode;
  const text = String(src.fallbackText ?? '').trim();
  return {
    mode,
    keepRawIfSubstantive: src.keepRawIfSubstantive !== false,
    nudgeInPrivate: src.nudgeInPrivate !== false,
    fallbackText: text || FALLBACK_POLICY_DEFAULTS.fallbackText
  };
}

/**
 * 原文是否「有实质信息」（P0-2 判据，任一命中即真）。
 * 数字 / 链接或 @ / 反引号 / 否定词 / 长度 ≥ 12 字。
 * 否定词单列，是因为删掉否定等于把意思说反了（「别去」→「去」）。
 */
export function isSubstantive(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  if (/\d/.test(s)) return true;
  if (/https?:\/\//i.test(s) || s.includes('@')) return true;
  if (s.includes('`')) return true;
  if (hasNegation(s)) return true;
  return [...s].length >= 12;
}

// 「不/没/别/未/勿/甭」在常见**非否定**词里也会出现（未来、特别、别人、区别…）。
// 不先挖掉就会把「未来可期」判成否定 → 删空后又把整句发回去，等于兜底策略失灵。
const NEGATION_FALSE_FRIENDS = /未来|未必|未免|特别|区别|别人|别的|告别|级别|分类|分别|类别/g;

function hasNegation(s) {
  const masked = String(s ?? '').replace(NEGATION_FALSE_FRIENDS, '　');
  return /[不没别未勿甭]/.test(masked);
}

/**
 * 三档出站决策（P0-2）。纯函数，不碰配置/日志，方便单测。
 * @param {{raw?:string, cleaned?:string, hits?:string[], isPrivate?:boolean, policy?:object}} input
 * @returns {{action:'normal'|'heavy'|'keep-raw'|'nudge'|'skip'|'off', text:string, removedRatio:number}}
 */
export function decideFallback(input = {}) {
  const policy = normalizeFallbackPolicy(input.policy);
  const raw = String(input.raw ?? '');
  const cleaned = String(input.cleaned ?? '');
  const hits = Array.isArray(input.hits) ? input.hits : [];
  const isPrivate = input.isPrivate === true;
  const removedRatio = raw ? Math.round((1 - cleaned.length / raw.length) * 1000) / 1000 : 0;

  // 还有内容：删得多也只是「heavy」，照发清洗后的文本 ——
  // 回退原文等于把刚删掉的 AI 腔又吐回去，比删狠了更糟（§9 实测结论）。
  const emptied = hits.includes('fallback') || !cleaned.trim();
  if (!emptied) {
    // 短句按比例算会失真：「我理解你的感受」→「懂」只有 7 个字，
    // 比例 85%，但读者感受到的只是换了个说法。所以 heavy 只在够长的句子上记。
    const longEnough = [...raw.trim()].length >= 12;
    return { action: removedRatio > 0.6 && longEnough ? 'heavy' : 'normal', text: cleaned, removedRatio };
  }

  if (policy.keepRawIfSubstantive && isSubstantive(raw)) {
    return { action: 'keep-raw', text: raw.trim(), removedRatio };
  }
  if (policy.mode === 'off') return { action: 'off', text: '', removedRatio };
  if (policy.mode === 'nudge' || (isPrivate && policy.nudgeInPrivate)) {
    return { action: 'nudge', text: policy.fallbackText, removedRatio };
  }
  return { action: 'skip', text: '', removedRatio };
}

/** 规则表快照（给诊断脚本/文档用，别改它）。 */
export function listRules() {
  return RULES.map(({ id, why }) => ({ id, why }));
}

/**
 * 规则实现细节快照：只给测试用，用来校验「替换串引用的 $n 必须在正则里真有捕获组」。
 * 之前 hope-helpful 写成 to:'$1' 但正则没有组，线上会出现字面量 "$1" 落进回复里。
 */
export function listRuleSpecs() {
  return RULES.map(({ id, to, re }) => ({ id, to: to ?? '', source: re.source, flags: re.flags }));
}

/** 内置屏蔽词（给控制台/文档展示用）。 */
export function listBannedWords() {
  return {
    rules: listRules(),
    words: WORD_MAP.map(([from, to]) => ({ from, to })),
    formal: FORMAL_MAP.map(([from, to]) => ({ from, to })),
    flagOnly: FLAG_ONLY.slice(),
    observe: OBSERVE_RULES.map(([id]) => id)
  };
}
