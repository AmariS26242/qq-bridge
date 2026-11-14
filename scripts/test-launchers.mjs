#!/usr/bin/env node
/**
 * 启动脚本回归（start.bat / restart.bat / run-hidden.vbs）。
 *
 * 这两个 .bat 是「翻闸、回滚、自愈」唯一的重启手段，坏一次就是几分钟到半小时的
 * 不可用。所以把踩过的坑固化成断言，而不是写在注释里等下次再踩：
 *
 *   1. 批量脚本里不许用 `timeout /t`：`cmd /c start.bat > log` 会把 stdin 重定向，
 *      timeout 直接报 "Input redirection is not supported" 并跳过等待 → 崩溃重启热循环。
 *   2. 括号块里的 `rem` 必须是纯 ASCII：中文 rem 在 `if (...)` 块里会被 cmd 当命令执行，
 *      每轮刷一行 `'…' is not recognized`（曾累计 49 行噪声）。
 *   3. node 必须用 `call` 调用：本机 node 解析到 node.cmd，裸调用会让批处理提前结束。
 *   4. restart.bat 必须先确认没有存活桥接进程，再删锁（否则双实例互抢消息/互覆 state）。
 *   5. 路径必须经环境变量传给 PowerShell：用户名里的单引号会截断单引号字符串。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasNonAscii = (s) => /[^\x00-\x7F]/.test(s);
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

function read(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8').split(/\r?\n/);
}

check('start.bat 使用经过兼容性检查的 Node，并用 call 启动', () => {
  const lines = read('start.bat');
  assert.ok(lines.some((l) => /^\s*call "%QQBRIDGE_NODE%" src\\bridge\.js\s*$/.test(l)), '桥接必须使用已验证的 QQBRIDGE_NODE');
  assert.ok(lines.some((l) => /call node scripts\\bridge-node\.mjs/.test(l)), '缺少 Node 兼容性选择器');
  assert.ok(lines.some((l) => /if not defined QQBRIDGE_NODE/.test(l)), '没有兼容运行时时必须中止');
  assert.ok(!lines.some((l) => /^\s*node src\\bridge\.js\s*$/.test(l)), '出现裸 `node src\\bridge.js`（会让批处理提前结束）');
});

check('不许用 timeout 等待（stdin 重定向时会跳过等待）', () => {
  for (const name of ['start.bat', 'restart.bat']) {
    const bad = read(name)
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => /^\s*timeout\s/i.test(line) || /\btimeout\s+\/t\s+\d+/i.test(line));
    assert.equal(bad.length, 0, `${name}:${bad.map((b) => b.no).join(',')} 仍在用 timeout，改用 ping -n`);
  }
});

check('等待都走 ping -n', () => {
  const lines = read('start.bat');
  assert.ok(lines.some((l) => /ping -n \d+ 127\.0\.0\.1 >nul/.test(l)), 'start.bat 没有 ping 等待');
  const rlines = read('restart.bat');
  assert.ok(rlines.some((l) => /ping -n \d+ 127\.0\.0\.1 >nul/.test(l)), 'restart.bat 没有 ping 等待');
});

check('括号块里的 rem 全是纯 ASCII', () => {
  // 极简括号深度跟踪：只统计行尾未转义的 ( 与 )。够用于这两个脚本。
  for (const name of ['start.bat', 'restart.bat']) {
    let depth = 0;
    const offenders = [];
    read(name).forEach((line, i) => {
      const opens = (line.match(/\(/g) ?? []).length;
      const closes = (line.match(/\)/g) ?? []).length;
      const atStart = depth;
      depth = Math.max(0, depth + opens - closes);
      if (atStart > 0 && /^\s*rem\b/i.test(line) && hasNonAscii(line)) {
        offenders.push(`${name}:${i + 1}`);
      }
    });
    assert.equal(offenders.length, 0, `括号块内出现非 ASCII rem：${offenders.join(', ')}`);
  }
});

check('restart.bat 先判存活再删锁', () => {
  const text = read('restart.bat').join('\n');
  const delAt = text.indexOf('del state\\bridge.lock');
  assert.ok(delAt > 0, '没有删除锁文件的语句');
  const before = text.slice(0, delAt);
  assert.ok(/if errorlevel 1/.test(before), '删除锁之前没有 `if errorlevel 1` 中止分支');
  assert.ok(/仍有桥接/ .test(before) || /存活/.test(before), '删除锁之前没有存活检查的提示');
  assert.ok(/state\\bridge\.lock/.test(before), '删除锁之前没有读取锁文件 PID 的逻辑');
});

check('用户名含单引号：路径经环境变量传给 PowerShell', () => {
  // 只看可执行行：rem 注释里本来就会引用 '%~dp0' 这个错误写法作为说明。
  const code = read('restart.bat').filter((line) => !/^\s*rem\b/i.test(line)).join('\n');
  assert.ok(/set "QQBRIDGE_DIR=%~dp0"/.test(code), '没有把 %~dp0 塞进环境变量');
  assert.ok(!/'%~dp0/.test(code), '仍把 %~dp0 直接拼进单引号 PowerShell 字符串');
});

check('run-hidden.vbs 无窗口启动 start.bat', () => {
  const vbs = fs.readFileSync(path.join(ROOT, 'run-hidden.vbs'), 'utf8');
  assert.ok(/SW_HIDE|WindowStyle 0|windowstyle 0/i.test(vbs), 'run-hidden.vbs 没有隐藏窗口');
  assert.ok(/start\.bat/i.test(vbs), 'run-hidden.vbs 没有启动 start.bat');
});

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);
