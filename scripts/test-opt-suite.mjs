// 优化改造的常跑回归：一次跑完与本项目「表达层收紧 + 成本结构」相关的测试，
// 逐项打印结论，最后汇总。任何一项失败 → 退出码 1。
//
// 用法：node scripts/test-opt-suite.mjs [--verbose]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const verbose = process.argv.includes('--verbose');

// 子测试都在 os.tmpdir() 下建临时目录。某些运行环境（DSH 文件沙箱/受控文件夹访问）
// 会把对系统 Temp 的写入拒成 EPERM，导致整片测试假失败。这里把子进程的 TEMP/TMP/TMPDIR
// 指到仓库内的 tmp/suite-tmp（同一文件系统、可写），测试逻辑不变。
const suiteTmp = path.join(root, 'tmp', 'suite-tmp');
fs.rmSync(suiteTmp, { recursive: true, force: true });
fs.mkdirSync(suiteTmp, { recursive: true });
const childEnv = { ...process.env, TEMP: suiteTmp, TMP: suiteTmp, TMPDIR: suiteTmp };

// 只放「本话题直接相关」的测试；其它历史测试仍按原脚本单独跑。
const SUITE = [
  ['test-ops-panel.mjs', 'A1 面板聚合纯函数'],
  ['test-ops-wait-store.mjs', 'O3 wait 长期分布存档'],
  ['test-cost-guard.mjs', 'A2 守门四口径（含上下文水位）'],
  ['test-token-usage.mjs', 'A2 账本与 watermarks()'],
  ['test-console-ui.mjs', 'A2/D-1 控制台上下文列与阈值同源'],
  ['test-ai-tone.mjs', '表达层清洗主回归'],
  ['test-ai-tone-semantic.mjs', 'A4 37 条规则语义保真'],
  ['test-context-budget.mjs', 'C1 预算判定纯函数'],
  ['test-handoff.mjs', 'C1/C3 交接载荷与存储'],
  ['test-handoff-recent.mjs', 'C3 兜底组装（最近消息）'],
  ['test-handoff-injection.mjs', 'C3 交接行只注入一次'],
  ['test-profile-slice.mjs', 'D2 档案抽取游标'],
  ['test-profiles.mjs', 'D2 档案衰减与注入'],
  ['test-qq-preset-contract.mjs', 'D-4 工具清单与预设一致'],
  ['test-mcp-safe.mjs', 'D-4 MCP 工具面'],
  ['test-fewshot.mjs', 'D5/D6 素材与 few-shot 索引'],
  ['test-fewshot-negative.mjs', 'D4 反例库（✗ 命中 / ✓ 原样）'],
  ['test-fewshot-load.mjs', 'D4 反例库加载与缓存指纹'],
  ['test-eval-tools.mjs', 'B1 CSV 与汇总'],
  ['test-eval-packs.mjs', 'B1 评审包与校验器'],
  ['test-eval-review-page.mjs', 'B1 评审网页与核心逻辑一致'],
  ['test-persona-slim.mjs', 'D3 人格卡候选稿预算与保留项'],
  ['test-role-override.mjs', 'D3 人格卡影子覆盖路径裁决'],
  ['test-ab-sampling.mjs', 'B2 采样 A/B 单变量与盲评配对'],
  ['test-launchers.mjs', '启动脚本回归（timeout/call/锁顺序）'],
  ['test-gate-enforce.mjs', 'C3 闸门判据（含退役动作识别）'],
  ['test-prep-enforce.mjs', 'C3 留底与翻后核对'],
  ['test-flip-enforce.mjs', 'C3 翻闸开关顺序与拒绝'],
  ['test-docs-status.mjs', '文档 §7 状态表与清单一致'],
];

const results = [];
for (const [file, label] of SUITE) {
  const target = path.join(root, 'scripts', file);
  const started = Date.now();
  const run = spawnSync(process.execPath, [target], { cwd: root, encoding: 'utf8', env: childEnv });
  const ms = Date.now() - started;
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`.trimEnd();
  const lines = out.split('\n');
  const ok = run.status === 0;
  // 各脚本最后的汇总行格式不一，取末尾非空 1–2 行作为结论摘要。
  const tail = lines.filter((l) => l.trim() !== '').slice(-2).join(' | ');
  results.push({ file, label, ok, ms, tail, out });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file.padEnd(30)} ${String(ms).padStart(6)} ms  ${label}`);
  if (!ok || verbose) {
    for (const line of lines.slice(-12)) console.log(`      ${line}`);
  }
}

const failed = results.filter((r) => !r.ok);
const total = results.reduce((n, r) => n + r.ms, 0);
console.log(`\n${results.length - failed.length}/${results.length} 个测试文件通过，合计 ${(total / 1000).toFixed(1)}s`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.file}（${f.label}）`);
  process.exit(1);
}
console.log('优化相关回归全绿。');
