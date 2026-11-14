// D3 接线的一次性人工核对：默认配置下，唤醒提示里的人格块必须与线上人格卡逐字节一致，
// 且与候选稿不同（否则说明覆盖开关或缓存串了）。
//
// 用法：node scripts/check-role-injection.mjs <唤醒提示文本文件>
// 这里不联网络：先 curl 唤醒预览写到文件，再比对。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectRoleText } from '../src/role-card.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/check-role-injection.mjs <prompt.txt>');
  process.exit(2);
}

const prompt = fs.readFileSync(file, 'utf8');
const start = prompt.indexOf('【人格 · 每轮】');
if (start < 0) {
  console.log('✗ 提示里没有【人格 · 每轮】段');
  process.exit(1);
}
const rest = prompt.slice(start + '【人格 · 每轮】'.length);
// 人格块后面紧跟空行分隔的下一段；取到下一个「【」标题或文末。
const nextHeading = rest.search(/\n\s*【[^】]+】/);
const block = (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest).replace(/^\n+|\n+$/g, '');

const full = fs.readFileSync(path.join(ROOT, 'roles', '小鲸鱼.md'), 'utf8');
const slim = fs.readFileSync(path.join(ROOT, 'eval', 'd3', '小鲸鱼.slim.md'), 'utf8');
const wantFull = selectRoleText(full, 'v2', { only: 'wake' });
const wantSlim = selectRoleText(slim, 'v2', { only: 'wake' });

const trim = (text) => text.replace(/\r/g, '').replace(/^\n+|\n+$/g, '');
const blockNorm = trim(block);
// 唤醒块 = 核心段（wake 视图） + 命中的场景片段（每轮最多 role.maxScenes 个），
// 所以这里比「以核心段开头」而不是全等；场景内容每次可能不同。
const matchesFull = blockNorm.startsWith(trim(wantFull));
const matchesSlim = blockNorm.startsWith(trim(wantSlim));

console.log(`人格块 ${blockNorm.length} 字符`);
console.log(`与线上卡（roles/小鲸鱼.md, wake 视图 ${trim(wantFull).length} 字符）一致: ${matchesFull}`);
console.log(`与候选稿（eval/d3/小鲸鱼.slim.md, wake 视图 ${trim(wantSlim).length} 字符）一致: ${matchesSlim}`);
if (!matchesFull || matchesSlim) {
  console.log('✗ 期望「等于线上卡、且不等于候选稿」');
  process.exit(1);
}
console.log('✓ 默认路径注入的就是线上人格卡');
