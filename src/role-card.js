// 人格卡（roles/<名称>.md）的解析与「按仿真模式取用」。
//
// 为什么要分模式：
//   一代仿真（reserved）用空格分条、用 [SILENT] 表示沉默；
//   二代仿真（reserved2）必须用工具发言（qq_send_message 的数组分条），没有 [SILENT]。
//   同一张人格卡被两种模式共用时，一代专属指令会与二代工具协议冲突。
// 以前靠 currentRoleHintV2() 对正文做「逐行猜测 + 正则过滤」，既容易误伤又说不清边界。
//
// 现在改为显式标记：在标题里写模式，桥接只取当前模式适用的小节。
//   ## 表情包体系 〔二代〕      → 只在 reserved2 注入
//   ## 分条方式 〔一代〕        → 只在 reserved/chat 注入
//   ## 你是谁                   → 两种模式都注入
// 标记会在注入前从标题里去掉，模型看到的始终是干净的小节标题。
import fs from 'node:fs';
import path from 'node:path';

export const ROLE_INJECT_MODES = ['v1', 'v2'];

// 模式标记：`〔二代〕` / `[v2]` / `（reserved2）` 等写法都认。
const MODE_TAGS = [
  { mode: 'v2', re: /[\[〔（(]\s*(?:二代|2\s*代|v2|reserved2)\s*[\]〕）)]/gi },
  { mode: 'v1', re: /[\[〔（(]\s*(?:一代|1\s*代|v1|reserved)\s*[\]〕）)]/gi },
];

function detectMode(heading) {
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    if (tag.re.test(heading)) return tag.mode;
  }
  return 'all';
}

// 场景标记：标题里写 `## 场景：情绪倾诉` 即成为可按需注入的片段；
// 写 `## 核心 · 每轮必看` 的小节则每轮唤醒都注入（用于「人格常驻」）。
// 未标记的小节只在 qq_get_prompt 拉全文时出现，不占每轮 token。
const CORE_HEADING_RE = /^核心(?:\s|·|·|:|：|$)/;
const SCENE_HEADING_RE = /^场景\s*[:：]\s*(.+)$/;

function detectSceneKind(heading) {
  const title = String(heading ?? '').trim();
  if (CORE_HEADING_RE.test(title)) return { kind: 'core', scene: null };
  const scene = SCENE_HEADING_RE.exec(title);
  if (scene) return { kind: 'scene', scene: scene[1].trim() };
  return { kind: 'plain', scene: null };
}

function stripModeTags(heading) {
  let out = String(heading);
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    out = out.replace(tag.re, '');
  }
  return out.replace(/[ \t]+$/, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 按标题把人格卡拆成小节。
 * @returns {{mode: 'all'|'v1'|'v2', heading: string|null, lines: string[]}[]}
 */
export function parseRoleSections(text) {
  const sections = [];
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) {
      if (!current) {
        current = { mode: 'all', heading: null, lines: [], kind: 'plain', scene: null };
        sections.push(current);
      }
      current.lines.push(line);
      continue;
    }
    const title = stripModeTags(heading[2]);
    current = {
      mode: detectMode(heading[2]),
      heading: title,
      lines: [`${heading[1]} ${title}`],
      ...detectSceneKind(title),
    };
    sections.push(current);
  }
  return sections;
}

/**
 * 取出某次仿真真正要注入的人格文本（已去掉模式标记）。
 *
 * options:
 *   only: 'all'（默认，整张卡）| 'wake'（只取 `核心` 小节 + 命中场景）
 *   scenes: string[]      本次会话命中的场景名（配合 only:'wake'）
 *   includeCore: boolean  默认 true；false 时只取场景片段
 *
 * @param {'v1'|'v2'} mode
 */
export function selectRoleText(text, mode, options = {}) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  const only = options?.only === 'wake' ? 'wake' : 'all';
  const includeCore = options?.includeCore !== false;
  const scenes = new Set(
    (Array.isArray(options?.scenes) ? options.scenes : [])
      .map((name) => String(name ?? '').trim())
      .filter(Boolean),
  );
  return parseRoleSections(text)
    .filter((section) => section.mode === 'all' || section.mode === want)
    .filter((section) => {
      if (only !== 'wake') return true;
      if (section.kind === 'core') return includeCore;
      if (section.kind === 'scene') return scenes.size === 0 ? false : scenes.has(section.scene);
      return false;
    })
    .map((section) => section.lines.join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 列出卡片里定义的全部场景名（按出现顺序去重），用于配置校验与控制台展示。 */
export function listRoleScenes(text, mode = 'v2') {
  const want = mode === 'v1' ? 'v1' : 'v2';
  const names = [];
  for (const section of parseRoleSections(text)) {
    if (section.kind !== 'scene') continue;
    if (section.mode !== 'all' && section.mode !== want) continue;
    if (section.scene && !names.includes(section.scene)) names.push(section.scene);
  }
  return names;
}

/**
 * 报告每个小节在当前模式下是否会被注入，供控制台预览。
 * @param {'v1'|'v2'} mode
 */
export function roleSectionReport(text, mode) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text).map((section) => ({
    heading: section.heading ?? '(开头部分)',
    mode: section.mode,
    kind: section.kind,
    scene: section.scene,
    injected: section.mode === 'all' || section.mode === want,
    chars: section.lines.join('\n').trim().length,
  }));
}

/** 统计各模式的字符数，用于控制台提示「去掉另一模式的专属小节后还剩多少」。 */
export function roleCharStats(text) {
  const source = String(text ?? '');
  const sections = parseRoleSections(source);
  const sum = (list) => list.reduce((total, section) => total + section.lines.join('\n').trim().length, 0);
  return {
    total: source.length,
    common: sum(sections.filter((section) => section.mode === 'all')),
    v1Only: sum(sections.filter((section) => section.mode === 'v1')),
    v2Only: sum(sections.filter((section) => section.mode === 'v2')),
    v1: selectRoleText(source, 'v1').length,
    v2: selectRoleText(source, 'v2').length,
  };
}

// 一代仿真遗留指令：未加模式标记时，这些行在二代下会被兜底过滤。
// 正确做法是给所在小节加上 〔一代〕 标记。
export const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;

/**
 * 决定这次注入读哪份人格卡文件（D3 的接线点）。
 *
 * 默认读 `roles/<名称>.md`。配置里给了 `role.overrideFile`（相对项目根）时改读那份，
 * 用于「候选稿影子跑」：不动线上卡文件，只切一个配置项就能对比两种卡的表现。
 *
 * 安全约束（与原来 roles/ 路径校验同源）：
 *   - 名称不能为空、不能带路径分隔符或 `..`（防 `../../Users/Public/x` 这类穿越）；
 *   - overrideFile 只接受相对路径，解析后必须仍在项目根内，且不能落进 node_modules / .git；
 *   - overrideFile 非法时返回 ''，调用方按「没有人格卡」处理（宁可不注入，也不读错文件）。
 *
 * @param {{ rolesDir: string, name: string, overrideFile?: string }} opts
 * @returns {string} 绝对路径；不合法返回 ''
 */
export function resolveRoleFile({ rolesDir, name, overrideFile } = {}) {
  const cleanName = String(name ?? '').trim();
  if (!cleanName || cleanName.includes('..') || /[\\/]/.test(cleanName)) return '';
  const base = String(rolesDir ?? '').trim();
  if (!base) return '';

  const override = String(overrideFile ?? '').trim();
  if (!override) return path.join(base, `${cleanName}.md`);

  const projectRoot = path.resolve(base, '..');
  // 只接受相对路径：绝对路径（C:\... 或 /etc/...）直接拒绝，避免配置被改成读任意文件。
  if (path.isAbsolute(override)) return '';
  const resolved = path.resolve(projectRoot, override);
  // startsWith 只挡字面路径：junction/symlink 能让「字面在项目内」的路径实际指向外面。
  // realpath 尽力解析（文件可能还没建，ENOENT 时退回字面路径），再用解析后的根做前缀判断。
  const realOf = (target) => {
    try { return fs.realpathSync(target); } catch { return target; }
  };
  const fsReal = realOf(resolved);
  const rootReal = realOf(projectRoot);
  const foldCase = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (!foldCase(fsReal).startsWith(foldCase(rootReal) + path.sep)) return '';
  const rel = path.relative(projectRoot, resolved).split(path.sep);
  if (rel.includes('node_modules') || rel.includes('.git')) return '';
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== '.md' && ext !== '.txt') return '';
  return resolved;
}
