// 出站长消息的「长度门控」：只回答一个问题——这条消息该不该拆、在哪儿拆。
//
// 为什么要有这一层：
//   QQ 单条消息太长读起来累，连发多条又吵。但「按字数硬切」是最差的做法：切在句子中间、
//   切在代码块里、切在链接里，两条气泡都不通顺，还得让用户自己脑补拼回去。所以这里只做
//   **确定性的判定**——给出「拆 / 不拆 / 只告警」和切分结果，一个字都不改写正文。
//
// 设计约束：
//   1. 纯函数、零依赖：输入文本 + 配置，输出计划；怎么发（几条、间隔多久）由调用方决定。
//   2. 宁可不拆：找不到「左右两段都够长」的安全边界时只告警，绝不硬切。
//   3. 只拆一次：QQ 连发多条很吵，最多 2 条（maxParts 允许配到 3，上限预留给以后）。
//   4. 不丢内容：除拆点处的逗号（「……，」结尾读起来冗余）之外，两段拼回去必须等于原文。
//   5. 长度按**码点**算：emoji / 代理对在 UTF-16 里占 2 个 .length，用 .length 判断会把
//      一条 20 个表情的消息当成 40 字，所以统一用 [...text].length。
//
// 边界说明：拆点判定是启发式的（括号栈只认全角「」『』（）和半角 ()），
// 目标是「大部分聊天文本别切错」，不是语法分析器；拿不准时选择不拆。

// 调用方（src/bridge.js）用这份默认值拼 cfg.lengthGate，config.json 里只写要覆盖的键。
export const LENGTH_GATE_DEFAULTS = Object.freeze({
  enabled: true,
  splitAbove: 40, // 超过这个长度才考虑拆
  warnAbove: 60, // 超过这个长度但没有安全边界 → 只告警
  minPartChars: 6, // 拆出来的每段至少这么多字，否则不拆
  maxParts: 2 // 单条最多拆成几条（当前实现只拆一次）
});

// 允许的取值区间。为什么要有下界：splitAbove 配成 5 会把每条短句都拆开；
// 为什么要有上界：QQ 气泡本身显示不了太长的文本，配到几千等于关闭功能，容易是笔误。
const LIMITS = Object.freeze({
  splitAbove: Object.freeze([10, 500]),
  minPartChars: Object.freeze([2, 50]),
  maxParts: Object.freeze([2, 3])
});

// 拆点候选的三个层级，从高到低。段落优先于句子、句子优先于逗号：
// 越靠前的位置越接近「作者本来就想分段/断句」的地方，读起来最自然。
const SENTENCE_MARKS = '。！？!?';
const COMMA_MARKS = '，,；;、';

// 括号配对表。为什么只认这几种：中文聊天里的成对符号就这些，剩下的（【】《》[]）出现频率低，
// 且常用来装饰而不是包裹一句话，硬认反而容易把整条消息判成「在括号里」。
const OPEN_TO_CLOSE = Object.freeze({
  '「': '」',
  '『': '』',
  '（': '）',
  '(': ')'
});
const CLOSERS = new Set(['」', '』', '）', ')']);

// 告警 / 系统类消息：首行前缀承担了「这条是什么」的信息，拆开之后后半段会像凭空冒出来的。
// 词表与 bridge 里现有的前缀保持一致（agent / 系统 / 常见状态 emoji）。
// 必须带 u 标志：字符类里的 🔐 是星芒平面字符，没有 u 时会被拆成两个代理项，
// 于是任何以 D83D 开头 emoji（😀…）都会被误判成告警前缀。
const WARN_PREFIX_RE = /^\s*(?:[⚠⏳⏹🔐❓✅❌⏰]|agent|系统)/u;

// 结构行：清单符 / 编号 / 引用 / 标题。这类多行文本的换行本身就是结构，
// 机械拆会把「第 2 步」劈到另一条气泡里。
const STRUCTURAL_LINE_RE = /^\s*(?:[-*+>#]|\d+[.、)])/;

/** 按码点计数（emoji / 代理对算 1 个字）。 */
function countChars(text) {
  return [...text].length;
}

/** 数字配置：非法值（非有限数）回落默认，越界则夹紧到区间；小数四舍五入成整数。 */
function clampInt(value, fallback, min, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** 去掉段尾的逗号类字符（拆在逗号处时用，避免出现「……，」这种半截标点结尾）。 */
function dropTrailingCommas(text) {
  return text.replace(/[，,；;、]+$/u, '');
}

/**
 * 规范化 lengthGate 配置。
 * 非法值回落默认、范围夹紧：配置是手写的 JSON，写错（"40"、5、9999）不该让门控行为失控。
 * @param {object|null|undefined} raw config.json 里的 lengthGate 段（或缺省）
 * @returns {{ enabled: boolean, splitAbove: number, warnAbove: number, minPartChars: number, maxParts: number }}
 */
export function normalizeLengthGateConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};

  const splitAbove = clampInt(src.splitAbove, LENGTH_GATE_DEFAULTS.splitAbove, ...LIMITS.splitAbove);

  // warnAbove 只约束下界（必须 ≥ splitAbove）：配得比 splitAbove 还小，
  // 「超过阈值但拆不了才告警」这条规则就永远走不到，等于把功能悄悄关掉。
  const warnAbove = Math.max(
    splitAbove,
    typeof src.warnAbove === 'number' && Number.isFinite(src.warnAbove)
      ? Math.round(src.warnAbove)
      : LENGTH_GATE_DEFAULTS.warnAbove
  );

  const minPartChars = clampInt(src.minPartChars, LENGTH_GATE_DEFAULTS.minPartChars, ...LIMITS.minPartChars);
  const maxParts = clampInt(src.maxParts, LENGTH_GATE_DEFAULTS.maxParts, ...LIMITS.maxParts);
  const enabled = typeof src.enabled === 'boolean' ? src.enabled : LENGTH_GATE_DEFAULTS.enabled;

  return Object.freeze({ enabled, splitAbove, warnAbove, minPartChars, maxParts });
}

/**
 * 这个类型根本不该拆？返回原因（空串 = 可以拆）。
 * 顺序无所谓，但要把「最明显的原因」放在前面，日志里好认。
 */
function detectSkip(text) {
  if (text.includes('```')) return '含 Markdown 代码围栏 ```（拆开就破坏了代码块）';
  if (text.includes('`')) return '含行内反引号 `（代码/命令不能跨气泡）';
  if (/https?:\/\/\S+/.test(text)) return '含 URL（链接拆开就点不开了）';
  if (WARN_PREFIX_RE.test(text)) return '以告警/系统前缀开头（前缀是这条消息的身份，拆开就断了）';

  // 步骤清单、编号列表、引用块：结构本身就是信息，机械拆会散架，直接不拆。
  //
  // 这里对「多行即 skip」做了一处收窄：只有**带结构行**（清单/编号/引用/标题）的多行文本，
  // 或者没有空行分段的多行文本才跳过；纯空行分段的普通长回复不跳过，交给拆点优先级 1 的
  // 段落边界。否则 `\n\n` 一定产生 ≥2 非空行，段落边界这条永不可达，规格自相矛盾。
  const nonEmptyLines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (nonEmptyLines.length >= 2) {
    if (nonEmptyLines.some((line) => STRUCTURAL_LINE_RE.test(line))) {
      return `多行结构（非空行 ${nonEmptyLines.length} 行，清单/引用拆开会散架）`;
    }
    if (!/\n[ \t]*\n/u.test(text)) {
      return `多行结构（非空行 ${nonEmptyLines.length} 行且没有空行分段，机械拆会破坏行结构）`;
    }
  }

  return '';
}

/**
 * 扫 [0, index) 的括号深度（0 = 不在括号里）。
 * 只用简单栈：遇到开括号压栈，遇到同类型的闭括号弹栈，不匹配的闭括号直接忽略
 * （聊天文本里常有孤立的「（」或全半角混用，严格配对会把整条消息判成括号内）。
 * 结论：这是启发式，只保证「明显在括号里的拆点」会被跳过。
 */
function bracketDepthAt(text, index) {
  const stack = [];
  for (let i = 0; i < index; i += 1) {
    const ch = text[i];
    if (OPEN_TO_CLOSE[ch]) stack.push(OPEN_TO_CLOSE[ch]);
    else if (CLOSERS.has(ch) && stack.length > 0 && stack[stack.length - 1] === ch) stack.pop();
  }
  return stack.length;
}

/** 段落边界：连续空行之后（\r\n\r\n 也认，Windows 上写的东西很常见）。 */
function paragraphPoints(text) {
  const points = [];
  const re = /\r?\n\r?\n/g;
  let match;
  while ((match = re.exec(text)) !== null) points.push(match.index + match[0].length);
  return points;
}

/** 标点边界：拆点在该字符**之后**，字符本身留在前段。 */
function markPoints(text, marks) {
  const points = [];
  for (let i = 0; i < text.length; i += 1) {
    if (marks.includes(text[i])) points.push(i + 1);
  }
  return points;
}

/**
 * 找拆点：按优先级尝试三层，每层内取**最后一个**有效拆点（尽量让第一段完整，
 * 减少把一句话切成「头重脚轻」的概率）。任一层命中立即返回，不再看更低层级。
 * @returns {{ kind: string, left: string, right: string } | null}
 */
function findSplitPoint(text, cfg) {
  const levels = [
    { kind: '段落', points: paragraphPoints(text) },
    { kind: '句子', points: markPoints(text, SENTENCE_MARKS) },
    { kind: '逗号', points: markPoints(text, COMMA_MARKS) }
  ];

  for (const level of levels) {
    let best = null;
    for (const index of level.points) {
      // 括号/引号里不断：先把结论想清楚，比拆完再回退便宜得多。
      if (bracketDepthAt(text, index) > 0) continue;

      const rawLeft = text.slice(0, index).trim();
      // 只对「逗号层」去掉段尾逗号：其他层末尾的标点是原文的一部分，删了就是丢内容。
      const left = level.kind === '逗号' ? dropTrailingCommas(rawLeft) : rawLeft;
      const right = text.slice(index).trim();

      // 两段都必须够长，否则就是「好，」+ 400 字这种假拆分。
      if (!left || !right) continue;
      if (countChars(left) < cfg.minPartChars || countChars(right) < cfg.minPartChars) continue;

      best = { kind: level.kind, left, right };
    }
    if (best) return best;
  }

  return null;
}

/**
 * 规划一条长消息要不要拆、怎么拆。
 *
 * 返回的 action：
 *   none  → 不拆（没超长 / 空文本 / 没安全拆点但也没到告警阈值 / 已关闭）
 *   split → parts=[前段, 后段]，调用方按顺序发两条
 *   warn  → 超过 warnAbove 但找不到安全边界，parts=[原文]，调用方只记日志、照原样发
 *   skip  → 不该拆的消息类型（代码/链接/告警前缀/多行结构），parts=[原文]
 *
 * @param {string} text
 * @param {object} [options] 同 normalizeLengthGateConfig 的字段，缺省走 LENGTH_GATE_DEFAULTS
 * @returns {{ parts: string[], action: 'none'|'split'|'warn'|'skip', reason: string }}
 */
export function planLengthSplit(text, options = {}) {
  const original = String(text ?? '');
  const cfg = normalizeLengthGateConfig(options);

  // 关闭时连类型判断都不做：调用方拿到的 reason 要能解释「为什么没动」。
  if (!cfg.enabled) return { parts: [original], action: 'none', reason: '已关闭（lengthGate.enabled=false），直接放行' };
  if (!original) return { parts: [original], action: 'none', reason: '空文本，无需处理' };

  // 先判类型再判长度：代码/链接/多行清单即使没超长也不归长度门控管，
  // 让返回值稳定（同一类文本不会被长度变化影响），日志统计也好做。
  const skip = detectSkip(original);
  if (skip) return { parts: [original], action: 'skip', reason: skip };

  const len = countChars(original);
  if (len <= cfg.splitAbove) {
    return { parts: [original], action: 'none', reason: `长度 ${len} ≤ splitAbove ${cfg.splitAbove}，不拆` };
  }

  const split = findSplitPoint(original, cfg);
  if (split) {
    const leftLen = countChars(split.left);
    const rightLen = countChars(split.right);
    return {
      parts: [split.left, split.right],
      action: 'split',
      reason: `在${split.kind}边界拆分（${leftLen} + ${rightLen} 字）`
    };
  }

  // 拆不了：超过 warnAbove 只告警，否则当作正常长句放行。
  if (len > cfg.warnAbove) {
    return { parts: [original], action: 'warn', reason: `长度 ${len} > warnAbove ${cfg.warnAbove}，但没有安全拆点（宁可不拆）` };
  }
  return { parts: [original], action: 'none', reason: `长度 ${len} 在 warnAbove ${cfg.warnAbove} 内，无安全拆点，保持一条` };
}
