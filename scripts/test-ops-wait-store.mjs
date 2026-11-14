// 「每轮 wait 次数分布」长期存档的测试：坏文件、坏值、原子替换、判据读数。
// 用法：node scripts/test-ops-wait-store.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WAIT_TURNS_VERSION,
  bumpWaitTurn,
  emptyWaitTurns,
  normalizeWaitTurns,
  readWaitTurns,
  waitTurnStats,
  writeWaitTurns
} from '../src/ops-wait-store.mjs';

let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};
const has = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + extra}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-wait-'));
const file = path.join(dir, 'ops-wait-turns.json');
const NOW = 1_793_000_000_000;
const DAY = 86_400_000;

// 归一化：坏值一律 0，绝不出现负数/NaN
eq('空状态结构', emptyWaitTurns(NOW), { v: WAIT_TURNS_VERSION, since: NOW, updatedAt: 0, turnBins: { 1: 0, 2: 0, 3: 0, 4: 0 } });
eq('负数夹到 0', normalizeWaitTurns({ turnBins: { 1: -3, 2: 'x', 3: 2.9, 4: 1 } }).turnBins, { 1: 0, 2: 0, 3: 2, 4: 1 });
eq('坏入参不抛', normalizeWaitTurns(null).turnBins, { 1: 0, 2: 0, 3: 0, 4: 0 });
eq('since 保留', normalizeWaitTurns({ since: NOW - DAY }).since, NOW - DAY);

// 空文件路径：读不到就给空状态（不是 undefined、不抛）
eq('文件不存在给空状态', readWaitTurns(file).turnBins, { 1: 0, 2: 0, 3: 0, 4: 0 });

// 写→读往返
let s = emptyWaitTurns(NOW);
s = bumpWaitTurn(s, 1, NOW);
s = bumpWaitTurn(s, 3, NOW + 1000);
s = bumpWaitTurn(s, 5, NOW + 2000); // 5 次算进 4 号桶（≥4）
eq('记三轮', s.turnBins, { 1: 1, 2: 0, 3: 1, 4: 1 });
const written = writeWaitTurns(file, s, NOW + 3000);
eq('写入带回 updatedAt', written.updatedAt, NOW + 3000);
eq('落盘可回读', readWaitTurns(file).turnBins, { 1: 1, 2: 0, 3: 1, 4: 1 });
has('没有残留 .tmp', !fs.existsSync(file + '.tmp'));
eq('文件里不含会话身份字段', Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['since', 'turnBins', 'updatedAt', 'v']);

// 坏文件：半截 JSON 也不能让调用方崩
fs.writeFileSync(file, '{"turnBins": {"1": 2', 'utf8');
eq('坏 JSON 退回空状态', readWaitTurns(file).turnBins, { 1: 0, 2: 0, 3: 0, 4: 0 });
eq('坏 JSON 后仍能写', writeWaitTurns(file, bumpWaitTurn(emptyWaitTurns(NOW), 2), NOW).turnBins, { 1: 0, 2: 1, 3: 0, 4: 0 });

// 判据读数：分母只算至少等过一次的轮次
const stats = waitTurnStats({ turnBins: { 1: 30, 2: 8, 3: 2, 4: 2 } });
eq('判据分子/分母', [stats.turnsWith3Plus, stats.turnsWithWaits], [4, 42]);
eq('判据比例', stats.ratio3Plus, 0.0952);
eq('零样本时比例给 0', waitTurnStats(emptyWaitTurns()).ratio3Plus, 0);

// 幂等：同一份数据重复写不改变计数
const once = writeWaitTurns(file, { turnBins: { 1: 1, 2: 0, 3: 0, 4: 0 } }, NOW);
const twice = writeWaitTurns(file, once, NOW + 5);
eq('重复写入不翻倍', twice.turnBins, { 1: 1, 2: 0, 3: 0, 4: 0 });

fs.rmSync(dir, { recursive: true, force: true });
if (failed > 0) {
  console.error(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
