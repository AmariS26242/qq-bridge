// few-shot 正例库导入器。
//
//   node scripts/fewshot-import.mjs                 # 导入 raw/*.md + inbox/*.txt，合并进 examples.jsonl
//   node scripts/fewshot-import.mjs --dry           # 只报告会导入多少条，不写文件
//   node scripts/fewshot-import.mjs --stats         # 只看当前库统计
//   node scripts/fewshot-import.mjs --file x.txt    # 只导入指定文件（QQ 导出 txt 或手写 md）
//   node scripts/fewshot-import.mjs --me "昵称"     # 指定聊天记录里哪个名字是「我」
//   node scripts/fewshot-import.mjs --env-file      # 兼容旧参数，等同默认
//
// 支持三种来源：手写 md（raw/）、QQ 导出 txt（时间戳+昵称行）、粘贴式「名字：内容」（inbox/）。
// QQ 的 .bak 是加密备份，外部解不开，检测到会提示改用 txt 导出。
//
// 幂等：样本 id 由内容哈希得出，重复导入不会产生重复条目。
// 默认保留已有样本；`--replace` 才用新解析结果整体覆盖（旧 id 会消失）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  looksLikeQqBak,
  mergeExamples,
  parseChatPaste,
  parseQqExport,
  parseRawMarkdown,
  readJsonl,
  toJsonl,
} from '../src/fewshot-lib.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback = '') => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const dir = path.resolve(root, valueOf('--dir', 'persona-lib/fewshot'));
const examplesFile = path.join(dir, 'examples.jsonl');
const existing = readJsonl(examplesFile);

if (has('--stats')) {
  console.log(`库目录：${dir}`);
  console.log(`正例：${existing.examples.length} 条`);
  const bySource = {};
  for (const item of existing.examples) bySource[item.source] = (bySource[item.source] ?? 0) + 1;
  console.log(`来源分布：${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join('，') || '空'}`);
  const negative = readJsonl(path.join(dir, 'negative.jsonl')).examples.length;
  console.log(`反例：${negative} 条`);
  process.exit(0);
}

const parsed = [];
const errors = [...existing.errors];
const meNames = valueOf('--me') ? [valueOf('--me')] : [];
const selfNames = [...meNames, '我', '本人', '自己'];
const timestamped = (text) => /^\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}/m.test(text);

function importFile(filePath, kind) {
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    errors.push(`读取失败 ${filePath}: ${error?.message ?? error}`);
    return 0;
  }
  const bakKind = looksLikeQqBak(buffer);
  if (bakKind) {
    errors.push(
      `${path.basename(filePath)} 是 QQ 加密备份（${bakKind}），外部工具解不开明文：` +
        '请改用「消息管理器 → 导出消息记录 → 文本文件(.txt)」，或在聊天里选中消息复制成「我：… / 对方：…」再存成 txt',
    );
    return 0;
  }
  const raw = buffer.toString('utf8');
  const result =
    kind === 'qq'
      ? timestamped(raw)
        ? parseQqExport(raw, { source: 'qq', selfNames })
        : parseChatPaste(raw, { source: 'qq', selfNames })
      : parseRawMarkdown(raw, { source: 'raw' });
  errors.push(...result.errors.map((message) => `${path.basename(filePath)}: ${message}`));
  parsed.push(...result.examples);
  return result.examples.length;
}

const oneFile = valueOf('--file');
const report = [];
if (oneFile) {
  const target = path.resolve(root, oneFile);
  const kind = /\.txt$/i.test(target) ? 'qq' : 'raw';
  report.push(`${path.basename(target)}：${importFile(target, kind)} 条`);
} else {
  for (const sub of [['raw', 'raw'], ['inbox', 'qq']]) {
    const [folder, kind] = sub;
    const folderPath = path.join(dir, folder);
    let files = [];
    try {
      files = fs.readdirSync(folderPath).filter((file) => /\.(md|markdown|txt|log|bak)$/i.test(file));
    } catch {}
    for (const file of files) {
      const filePath = path.join(folderPath, file);
      const count = importFile(filePath, kind);
      report.push(`${folder}/${file}：${count} 条`);
    }
  }
}

const merged = has('--replace')
  ? mergeExamples(parsed)
  : mergeExamples(existing.examples, parsed);
const added = merged.length - existing.examples.length;

console.log(`库目录：${dir}`);
for (const line of report) console.log(`  ${line}`);
console.log(`解析出 ${parsed.length} 条，去重后新增 ${Math.max(0, added)} 条，库内共 ${merged.length} 条`);

if (errors.length) {
  console.log(`\n⚠️ ${errors.length} 处无法解析（已跳过）：`);
  for (const message of errors.slice(0, 20)) console.log(`  - ${message}`);
}

if (has('--dry')) {
  console.log('\n（--dry：不写文件）');
  process.exit(0);
}

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(examplesFile, toJsonl(merged));
console.log(`\n✓ 已写入 ${path.relative(root, examplesFile)}`);
