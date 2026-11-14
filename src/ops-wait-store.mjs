// 「每轮 wait 次数分布」的长期存档：跨重启保留，供 O3 判据（单轮 wait ≥3 次占比）使用。
//
// 为什么单独一个模块：bridge.js 有 15,000 行，把「读/写/归一化」放在里面就只能靠肉眼检查；
// 抽出来之后可以用临时目录直接测，坏文件、坏值、原子替换都有断言。
//
// 只存聚合计数，不存会话身份、不存消息内容——这份文件即使被看到也说不清是谁在等什么。
import fs from 'node:fs';

export const WAIT_TURNS_VERSION = 1;

export function emptyWaitTurns(now = Date.now()) {
  return {
    v: WAIT_TURNS_VERSION,
    since: Number.isFinite(now) ? now : Date.now(),
    updatedAt: 0,
    turnBins: { 1: 0, 2: 0, 3: 0, 4: 0 }
  };
}

export function normalizeWaitTurns(raw) {
  const out = emptyWaitTurns();
  if (!raw || typeof raw !== 'object') return out;
  if (Number.isFinite(raw.since) && raw.since > 0) out.since = raw.since;
  if (Number.isFinite(raw.updatedAt) && raw.updatedAt > 0) out.updatedAt = raw.updatedAt;
  for (const bin of [1, 2, 3, 4]) {
    const n = Number(raw.turnBins && raw.turnBins[bin]);
    // 负数/字符串/NaN 一律当 0：这是一份观测数据，宁可少记也不能让比例算成负数。
    out.turnBins[bin] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  return out;
}

/** 读存档；不存在/坏掉/权限问题都退回空状态（观测数据坏了不能影响等待业务）。 */
export function readWaitTurns(file, now = Date.now()) {
  try {
    return normalizeWaitTurns(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return emptyWaitTurns(now);
  }
}

/** 原子写入：先写 `.tmp` 再 rename，避免半个 JSON 让下次读取拿到残缺数据。 */
export function writeWaitTurns(file, data, now = Date.now()) {
  const out = normalizeWaitTurns(data);
  out.since = out.since || now;
  out.updatedAt = now;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
  fs.renameSync(tmp, file);
  return out;
}

/** 记一轮：`waits` 是这一轮里 wait 的次数（0 不记，调用方先判）。4 表示 ≥4。 */
export function bumpWaitTurn(data, waits, now = Date.now()) {
  const out = normalizeWaitTurns(data);
  const n = Math.floor(Number(waits) || 0);
  if (n <= 0) return out;
  out.turnBins[Math.min(4, n)] += 1;
  out.updatedAt = now;
  return out;
}

/** 判据用的读数：分母只算至少等过一次的轮次。 */
export function waitTurnStats(data) {
  const bins = normalizeWaitTurns(data).turnBins;
  const turnsWithWaits = bins[1] + bins[2] + bins[3] + bins[4];
  const turnsWith3Plus = bins[3] + bins[4];
  return {
    turnBins: bins,
    turnsWithWaits,
    turnsWith3Plus,
    ratio3Plus: turnsWithWaits > 0 ? Math.round((turnsWith3Plus / turnsWithWaits) * 10000) / 10000 : 0
  };
}
