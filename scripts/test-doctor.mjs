#!/usr/bin/env node
// src/doctor.mjs 的离线单测：判定口径、简报行、历史裁剪、控制台格式。
// 不碰 fs/net —— 只测纯逻辑，跑完只要 0.1s。
import {
  CHECK_LABELS,
  CORE_TESTS,
  DOCTOR_DEFAULTS,
  EXPECTED_TASKS,
  formatReportLines,
  makeCheck,
  normalizeDoctorConfig,
  pruneHistory,
  renderDoctorBriefLine,
  summarizeChecks,
} from '../src/doctor.mjs';

let pass = 0;
let fail = 0;

function ok(name, cond) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}`); }
}

console.log('— 常量与配置 —');
ok('核心测试集非空且都是 .mjs', CORE_TESTS.length > 0 && CORE_TESTS.every((f) => /^test-.*\.mjs$/.test(f)));
ok('计划任务清单含四个必要任务', ['DSH QQ Bot Start', 'DSH Mobile Bridge', 'DSH Daily Brief', 'DSH Daily Backup'].every((n) => EXPECTED_TASKS.includes(n)));
ok('CHECK_LABELS 覆盖所有 check key', ['tests', 'qqbridge', 'qqbot', 'phoneBridge', 'campusNet', 'config', 'backup', 'health', 'memory', 'link', 'tasks'].every((k) => typeof CHECK_LABELS[k] === 'string'));
ok('第二梯队新增任务在清单里', EXPECTED_TASKS.includes('DSH Health Probe') && EXPECTED_TASKS.includes('DSH Nightly Memory'));
ok('第二梯队新增单测在核心集里', CORE_TESTS.includes('test-cost-guard.mjs') && CORE_TESTS.includes('test-health.mjs'));
ok('默认历史条数 10', DOCTOR_DEFAULTS.historyLimit === 10 && normalizeDoctorConfig(null).historyLimit === 10);
ok('historyLimit 坏值回落', normalizeDoctorConfig({ historyLimit: 0 }).historyLimit === 10 && normalizeDoctorConfig({ historyLimit: 'x' }).historyLimit === 10);
ok('historyLimit 合法值生效', normalizeDoctorConfig({ historyLimit: 3 }).historyLimit === 3);

console.log('— makeCheck 口径：只认 true —');
ok('ok=true 是绿', makeCheck('a', true).ok === true);
ok('ok=undefined 是红', makeCheck('a', undefined).ok === false);
ok('ok=null 是红', makeCheck('a', null).ok === false);
ok('ok="true" 字符串也是红（只认布尔 true）', makeCheck('a', 'true').ok === false);
ok('中文名取自 CHECK_LABELS', makeCheck('config', true).name === '配置');
ok('detail 被转成字符串', makeCheck('a', false, { detail: 42 }).detail === '42');

console.log('— summarizeChecks —');
{
  const r = summarizeChecks([makeCheck('tests', true), makeCheck('config', false, { detail: 'voiceTts.enabled=false' }), makeCheck('backup', true)]);
  ok('总数/通过数正确', r.total === 3 && r.passed === 2);
  ok('有红项则 lastOk=false', r.lastOk === false);
  ok('failed 带 key/name/detail', r.failed.length === 1 && r.failed[0].key === 'config' && r.failed[0].name === '配置' && r.failed[0].detail.includes('voiceTts'));
  ok('lastRunAt 是 ISO 时间', /^\d{4}-\d{2}-\d{2}T/.test(r.lastRunAt));
  ok('checks 原样保留顺序', r.checks.map((c) => c.key).join(',') === 'tests,config,backup');
}
{
  const r = summarizeChecks([makeCheck('a', true), makeCheck('b', true)]);
  ok('全绿 lastOk=true 且 failed 为空', r.lastOk === true && r.failed.length === 0 && r.passed === 2);
}
{
  const r = summarizeChecks([]);
  ok('空清单算红（没跑就等于没通过）', r.lastOk === false && r.total === 0);
}

console.log('— 简报行 —');
{
  const r = summarizeChecks([makeCheck('a', true), makeCheck('b', true)], Date.now());
  ok('全绿格式：自检 N/N 通过', renderDoctorBriefLine(r) === '🩺 自检：2/2 通过');
}
{
  const when = new Date(2026, 9, 24, 14, 5).getTime();
  const r = summarizeChecks([makeCheck('tests', true), makeCheck('config', false, { detail: 'voiceTts.enabled=false' }), makeCheck('phoneBridge', false, { detail: '8899 无响应' })], when);
  const line = renderDoctorBriefLine(r);
  ok('有红项带时间与点名', line.startsWith('🩺 自检：1/3 通过 14:05（配置 voiceTts.enabled=false、手机桥 8899 无响应）'));
  ok('最多点名 2 个', renderDoctorBriefLine(r, { maxNames: 1 }).includes('（配置') && !renderDoctorBriefLine(r, { maxNames: 1 }).includes('手机桥'));
  ok('行里没有换行（简报一行）', !line.includes('\n'));
}
{
  ok('没有报告返回 null', renderDoctorBriefLine(null) === null);
  ok('报告但没有 lastRunAt 返回 null', renderDoctorBriefLine({ total: 3, passed: 3 }) === null);
  ok('total=0 返回 null', renderDoctorBriefLine({ lastRunAt: new Date().toISOString(), total: 0 }) === null);
}

console.log('— 历史裁剪 —');
{
  const many = Array.from({ length: 15 }, (_, i) => ({ at: new Date(2026, 0, i + 1).toISOString(), passed: i, total: 8 }));
  const cut = pruneHistory(many, 10);
  ok('留最近 10 条', cut.length === 10);
  ok('留的是最新的（尾部）', cut[cut.length - 1].passed === 14);
  ok('坏条目被丢掉', pruneHistory([null, { at: 'x' }, 'nope', { noAt: 1 }], 5).length === 1);
  ok('空/非数组返回空数组', pruneHistory(null, 5).length === 0 && pruneHistory('x', 5).length === 0);
  ok('limit 坏值回落 10', pruneHistory(many, 0).length === 10);
}

console.log('— 控制台格式 —');
{
  const r = summarizeChecks([makeCheck('tests', true, { detail: '10/10 通过' }), makeCheck('config', false, { detail: 'voiceTts.enabled=false' })], new Date(2026, 9, 24, 14, 5).getTime());
  const lines = formatReportLines(r);
  ok('首行是摘要', lines[0].startsWith('自检 2026-10-24 14:05 · 1/2 通过'));
  ok('绿项带 ✓', lines[1].includes('✓ 单测'));
  ok('红项带 ✗ 与原因', lines[2].includes('✗ 配置') && lines[2].includes('voiceTts.enabled=false'));
  ok('空报告有兜底文案', formatReportLines(null)[0].includes('没有可跑的项目'));
}

console.log('');
console.log(`PASS：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
