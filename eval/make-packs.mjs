// 从 blind.csv 生成两份互不相见的评审包（A / B），只带题目与两栏文本，不带答案映射。
//
// 用法：node eval/make-packs.mjs eval/runs/<run-dir>
// 产出：<run-dir>/review-packs/reviewer-A.csv、reviewer-B.csv、README.md
// 说明：两份内容相同（同一批题），区别只在文件名；评审各自独立打分后交回。
import fs from 'node:fs';
import path from 'node:path';
import { parseCsvObjects, csvLine } from './csv.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error('用法：node eval/make-packs.mjs eval/runs/<run-dir>');
  process.exit(2);
}
const blindPath = path.join(dir, 'blind.csv');
if (!fs.existsSync(blindPath)) {
  console.error(`找不到 ${blindPath}`);
  process.exit(2);
}
const items = parseCsvObjects(fs.readFileSync(blindPath, 'utf8'));
if (!items.length) {
  console.error('blind.csv 是空的');
  process.exit(2);
}

const HEAD = ['reviewer', 'id', 'situation', 'incoming', 'side1', 'side2', 'natural1', 'faithful1', 'harm1', 'template1', 'stable1', 'natural2', 'faithful2', 'harm2', 'template2', 'stable2', 'note'];
const outDir = path.join(dir, 'review-packs');
fs.mkdirSync(outDir, { recursive: true });

function pack(label) {
  const lines = [csvLine(HEAD)];
  for (const it of items) {
    lines.push(csvLine([label, it.id, it.situation, it.incoming, it.side1, it.side2, '', '', '', '', '', '', '', '', '', '', '']));
  }
  return `${lines.join('\n')}\n`;
}

fs.writeFileSync(path.join(outDir, 'reviewer-A.csv'), pack('A'), 'utf8');
fs.writeFileSync(path.join(outDir, 'reviewer-B.csv'), pack('B'), 'utf8');

const readme = `# 盲评包（${path.basename(path.resolve(dir))}）

两份文件内容相同：\`reviewer-A.csv\` 交给评审 A，\`reviewer-B.csv\` 交给评审 B。
**不要互相对答案，也不要看 \`baseline.json\` / \`blind.csv\` 的其他列** —— 那里面有哪栏是原稿的映射。

## 怎么填

每条有两栏回复（\`side1\` / \`side2\`），分别按 1–5 分打五项：

| 列 | 含义 | 1 分 | 5 分 |
| --- | --- | --- | --- |
| \`natural1/2\` | 自然度 | 明显像客服/心理师模板 | 像真人在群聊里随口回 |
| \`faithful1/2\` | 语义保真 | 改坏或漏掉关键信息 | 意思、数字、条件全部保住 |
| \`harm1/2\` | 误伤（分越高越少误伤） | 删掉了不该删的内容 | 基本无误删 |
| \`template1/2\` | 模板感（分越高越不像模板） | 套话/结构固定 | 表达随场景变化 |
| \`stable1/2\` | 稳定性 | 同一意思前后矛盾 | 前后一致 |

\`note\` 列可选，写一句理由（尤其打 1–2 分时）。

## 交回

填完把文件放回本目录的上一级，命名为 \`scores-reviewer-A.csv\` / \`scores-reviewer-B.csv\`，
列结构改成扁平式：\`reviewer,id,side,natural,faithful,harm,template,stable,note\`，
其中每条的 1、2 两栏各占一行（\`side=1\` / \`side=2\`）。用下面的命令检查后再汇总：

\`\`\`
node eval/check-review.mjs <run-dir>/scores-reviewer-A.csv <run-dir>/blind.csv
node eval/aggregate.mjs <run-dir>
\`\`\`

## 纪律

- 先独立打完再讨论；讨论过的条目在 \`note\` 里标记。
- 打 1–5 的整数分，别写「3.5」。
- 没看的条目不要填 3 糊过去 —— 空着比假分好，\`check-review\` 会把空着的条数列出来。
`;
fs.writeFileSync(path.join(outDir, 'README.md'), readme, 'utf8');

console.log(`已生成 ${items.length} 条 × 2 栏的评审包：`);
console.log(`  ${path.join(outDir, 'reviewer-A.csv')}`);
console.log(`  ${path.join(outDir, 'reviewer-B.csv')}`);
console.log(`  ${path.join(outDir, 'README.md')}`);
