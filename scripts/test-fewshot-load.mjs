#!/usr/bin/env node
/**
 * 反例库「加载与缓存」的独立测试。
 *
 * 单独一个文件的原因：这些断言要用临时目录造「只有 negative.jsonl」「只改反例文件」
 * 这类状态，和主反例测试（对着真实素材库跑）关注点不同。
 *
 * 覆盖的是被审计抓到的两个真缺陷：
 *   1. 缓存指纹只算 examples.jsonl 的 mtime/size → 只改 negative.jsonl 永不生效；
 *   2. examples.jsonl 不存在时直接返回空库 → 反例文件根本没被打开。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearFewshotCache, formatNegativeBlock, loadFewshot } from '../src/fewshot-lib.js';

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

const line = (id, bad, good) => `${JSON.stringify({
  id,
  context: [{ role: 'me', text: '我：今天加班' }],
  bad,
  good,
  why: '客服腔'
})}\n`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fewshot-load-'));
try {
  // 1) 只有反例文件
  fs.writeFileSync(path.join(dir, 'negative.jsonl'), line('n1', '我理解你的感受', '听着就烦'), 'utf8');
  const a = loadFewshot(dir);
  check('只有 negative.jsonl 时也能读到反例', () => {
    assert.equal(a.negative.length, 1);
    assert.equal(a.examples.length, 0);
    assert.equal(a.file, null, '没有正例文件时 file 应为 null');
  });
  check('反例块把我方发言标成「我：」', () => {
    const block = formatNegativeBlock(a.negative);
    assert.match(block, /我：今天加班/);
    assert.doesNotMatch(block, /群友：今天加班/);
  });

  // 2) 只改反例（正例仍不存在）→ 缓存必须失效
  fs.writeFileSync(
    path.join(dir, 'negative.jsonl'),
    line('n1', '我理解你的感受', '听着就烦') + line('n2', '希望对你有帮助', '那就这样'),
    'utf8'
  );
  const b = loadFewshot(dir);
  check('只改 negative.jsonl 也能让缓存失效', () => {
    assert.equal(b.negative.length, 2);
  });

  // 3) 补上正例文件
  fs.writeFileSync(
    path.join(dir, 'examples.jsonl'),
    `${JSON.stringify({ id: 'e1', context: [{ role: 'user', text: '在吗' }], reply: '在' })}\n`,
    'utf8'
  );
  const c = loadFewshot(dir);
  check('补上正例后两者同时可用', () => {
    assert.ok(c.examples.length >= 1);
    assert.equal(c.negative.length, 2);
    assert.ok(c.file && c.file.endsWith('examples.jsonl'));
  });

  // 4) 删掉反例文件后不应该继续吐出旧反例
  clearFewshotCache();
  fs.rmSync(path.join(dir, 'negative.jsonl'));
  const d = loadFewshot(dir);
  check('删掉 negative.jsonl 后不再返回反例（不残留缓存）', () => {
    assert.equal(d.negative.length, 0);
    assert.ok(d.examples.length >= 1, '正例仍在');
  });

  // 5) 两个文件都不存在 → 空库且不抛
  clearFewshotCache();
  fs.rmSync(path.join(dir, 'examples.jsonl'));
  const e = loadFewshot(dir);
  check('两个文件都没有时返回空库', () => {
    assert.equal(e.examples.length, 0);
    assert.equal(e.negative.length, 0);
    assert.equal(e.mtimeMs, 0);
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);
