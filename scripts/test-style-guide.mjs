// 风格手册（persona-lib/style/*.md + qq_style_guide 工具）的离线单测。
// 保证：场景覆盖齐全、每份手册有摘要且不过长、MCP 里确实注册了工具、目录读不到时不崩。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SCENE_NAMES } from '../src/scene-router.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'persona-lib', 'style');

test('每个路由场景都有对应的风格手册', () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  for (const name of SCENE_NAMES) {
    assert.ok(files.includes(`${name}.md`), `缺少 ${name}.md，现有：${files.join('、')}`);
  }
});

test('每份手册都有摘要、内容不过长、不是空文件', () => {
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.match(raw, /^#\s+.+$/m, `${file} 缺少一级标题`);
    assert.match(raw, /^摘要[:：]\s*\S+/m, `${file} 缺少「摘要：」行`);
    assert.ok(raw.trim().length >= 120, `${file} 内容太短`);
    assert.ok(raw.length <= 2500, `${file} 太长（${raw.length} 字符），工具里会被截断`);
  }
});

test('MCP 服务里注册了 qq_style_guide 并挂进 core 组', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  assert.match(src, /server\.tool\(\s*\n\s*'qq_style_guide'/);
  assert.match(src, /'qq_style_guide'\]/);
});

test('目录缺失时工具返回空目录而不是抛错（守卫逻辑可读）', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const fn = src.slice(src.indexOf('function listStyleGuides'));
  assert.match(fn, /catch\s*\{\s*return \[\];/);
});
