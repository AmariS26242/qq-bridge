#!/usr/bin/env node
/**
 * 文档守卫：`docs/ACTION-CHECKLIST.md` §7 状态总表必须与清单本身对得上。
 *
 * 为什么值得为一张表写测试：这张表是「哪些做完了、哪些还欠着」的唯一入口，
 * 一旦某步改了状态却忘记改表，后面所有人（包括我下一轮）都会读到错的现状。
 * 所以这里只守三件成本极低、但错了很贵的事：
 *   1. 14 个步骤一个不少、状态符号只用约定集合；
 *   2. 每行都有非空「回滚」列 —— 没写回滚的动作不允许算完成；
 *   3. §7.1 里让人跑的命令，脚本文件真的存在。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs', 'ACTION-CHECKLIST.md');
const STEPS = ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'C1', 'C2', 'C3', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
const MARKS = new Set(['✅', '⚠️', '⏳', '❌', '🚫']);
let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name} — ${error.message}`);
  }
}

const text = fs.readFileSync(DOC, 'utf8');
const sec7 = text.slice(text.indexOf('### 7. 状态总表'));

/** 解析状态表：以 `| A1 ` 这类开头的行。 */
function tableRows() {
  return sec7
    .split(/\r?\n/)
    .filter((line) => /^\|\s*(A\d|B\d|C\d|D\d)\s/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

check('§7 状态总表存在', () => assert.ok(text.includes('### 7. 状态总表')));
check(`${STEPS.length} 个步骤都在表里`, () => {
  const ids = tableRows().map((cells) => cells[0].split(/\s/)[0]);
  assert.deepEqual([...ids].sort(), [...STEPS].sort(), `实际：${ids.join(',')}`);
});
check('状态符号只用约定集合', () => {
  for (const cells of tableRows()) {
    // ⚠️ 这类符号是「基字符 + 变体选择符」两个码点，只能按字符串包含判断。
    const hit = [...MARKS].some((mark) => cells[1].includes(mark));
    assert.ok(hit, `${cells[0]} 的状态列缺少合法符号：${cells[1]}`);
  }
});
check('每行四列齐全（步/状态/证据/回滚）', () => {
  for (const cells of tableRows()) assert.equal(cells.length, 4, `${cells[0]} 列数 ${cells.length}`);
});
check('每行都有非空回滚动作', () => {
  for (const cells of tableRows()) {
    const rollback = cells[3];
    assert.ok(rollback && rollback !== '—' && rollback.length >= 4, `${cells[0]} 没有写回滚`);
  }
});
check('§7.1 自查命令指向的脚本都存在', () => {
  const sec71 = sec7.slice(sec7.indexOf('### 7.1'), sec7.indexOf('### 7.2'));
  const scripts = [...sec71.matchAll(/node (scripts\/[\w.-]+\.mjs)/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 3, `只找到 ${scripts.length} 条命令`);
  for (const rel of scripts) assert.ok(fs.existsSync(path.join(ROOT, rel)), `缺文件 ${rel}`);
});
check('§7 声明的套件数量与套件实际条目一致', () => {
  const suite = fs.readFileSync(path.join(ROOT, 'scripts', 'test-opt-suite.mjs'), 'utf8');
  const count = (suite.match(/^\s*\['test-[^\]]+\.mjs'/gm) ?? []).length;
  const claim = sec7.match(/\*\*(\d+)\/(\d+) 个测试文件/);
  assert.ok(claim, '§7 里没写「N/N 个测试文件」');
  assert.equal(Number(claim[1]), Number(claim[2]), `声明本身不自洽：${claim[0]}`);
  assert.equal(Number(claim[1]), count, `文档写 ${claim[1]} 个，套件实际 ${count} 个`);
});

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);
