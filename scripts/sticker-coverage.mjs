// 表情库覆盖率体检（只读，不改任何 state）。
//
// 为什么需要这个脚本：P1 的目标是「两周内被用过的表情 ≥ 40 张，观感上不再老发同几张」。
// 光看代码改没改不够，得能随时量出来。默认读真实库并给出达标判断；
// 加 --simulate N 则在内存里模拟 N 次唤醒的推荐轮转，看「能推到的表情」够不够铺开。
//
// 用法：
//   node qq-bridge/scripts/sticker-coverage.mjs
//   node qq-bridge/scripts/sticker-coverage.mjs --simulate 20
//   node qq-bridge/scripts/sticker-coverage.mjs --days 14 --target 40
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { normalizeStickerEntry, buildStickerContextDetailed, markStickersShown } from '../src/sticker-lib.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return fallback;
  const raw = args[idx + 1];
  const num = Number(raw);
  return Number.isFinite(num) ? num : fallback;
};
const DAYS = flag('days', 14);
const TARGET = flag('target', 40);
const SIMULATE = flag('simulate', 0);
const DAY = 86400000;

const file = resolve(here, '../state/stickers.json');
const raw = JSON.parse(readFileSync(file, 'utf8'));
const list = (Array.isArray(raw) ? raw : (raw.entries || raw.stickers || [])).map(normalizeStickerEntry).filter(Boolean);
const now = Date.now();
const used = list.filter((e) => (Number(e.useCount) || 0) > 0);
const recentWindow = used.filter((e) => Number(e.lastUsedAt) > 0 && now - Number(e.lastUsedAt) <= DAYS * DAY);
const totalSends = list.reduce((sum, e) => sum + (Number(e.useCount) || 0), 0);

const pct = (part, whole) => (whole ? ((part / whole) * 100).toFixed(1) : '0.0');
const summary = {
  file,
  total: list.length,
  usedEver: used.length,
  usedInWindow: `${recentWindow.length}（近 ${DAYS} 天）`,
  neverUsed: list.length - used.length,
  coverPct: `${pct(used.length, list.length)}%（历史累计）`,
  windowPct: `${pct(recentWindow.length, list.length)}%（近 ${DAYS} 天）`,
  target: `近 ${DAYS} 天 ≥ ${TARGET} 张`,
  verdict: recentWindow.length >= TARGET ? '✅ 达标' : `⏳ 还差 ${TARGET - recentWindow.length} 张`,
  totalSends,
  stickerRotateState: '每轮唤醒 lastShownAt 前移，见 --simulate'
};

// 历史累计覆盖看着还行但不代表现在；真正要盯的是窗口内。
const topRepeat = [...used]
  .sort((a, b) => (b.useCount || 0) - (a.useCount || 0))
  .slice(0, 5)
  .map((e) => ({ desc: e.desc || e.localNote || '(无备注)', useCount: e.useCount || 0 }));

console.log(JSON.stringify({ ...summary, topRepeat }, null, 2));

if (SIMULATE > 0) {
  // 纯内存模拟：每轮按真实逻辑选 cap 张并记 lastShownAt，看多少轮能把库铺满。
  const cap = 10;
  let lib = list;
  const seen = new Set();
  let roundsToFull = null;
  for (let round = 1; round <= SIMULATE; round += 1) {
    const built = buildStickerContextDetailed(lib, cap, { seed: `sim:${round}` });
    built.pickedIds.forEach((id) => seen.add(String(id)));
    lib = markStickersShown(lib, built.pickedIds);
    if (roundsToFull === null && seen.size >= list.length) roundsToFull = round;
  }
  console.log(JSON.stringify({
    simulate: {
      wakes: SIMULATE,
      cap,
      distinctOffered: seen.size,
      total: list.length,
      roundsToFull: roundsToFull ?? `> ${SIMULATE}`,
      note: '纯内存模拟，未写盘。真实覆盖率取决于模型每轮是否真的选一张。'
    }
  }, null, 2));
}
