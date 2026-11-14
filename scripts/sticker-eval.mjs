// 表情包检索基线评测（20 条人工评测集）。
//
// 目的：给「语义检索」一个可量化的起点，防止把「感觉好像变好了」当成果。
// 评测口径：
// - top-1 / top-3 命中率：期望表情出现在第 1 位 / 前 3 位即算命中；
// - 期望用 tag 或 desc 表达（tag 更稳：表情库重排、备注改写都不会让用例失效）；
// - 对照组：旧版子串匹配（formatStickerList 的口径：把查询原串 lowercase 后
//   在 desc/tags/localNote 里 includes，命中字段越多分越高）。
//
// 用法：node scripts/sticker-eval.mjs [--file <stickers.json>] [--verbose] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStickerStore } from '../src/sticker-lib.js';
import { buildStickerIndex, searchStickers } from '../src/sticker-index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.join(HERE, '..', 'state', 'stickers.json');

/**
 * 20 条评测集。
 * want: 命中条件，{ tag } 表示条目 tags 含该值；{ desc } 表示配字包含该串。
 * 前 14 条偏「字面可对齐」，后 6 条是口语转写，专门检验同义词/语义能力。
 */
const CASES = [
  { query: '有点想哭', want: { tag: '委屈' } },
  { query: '笑死我了哈哈哈', want: { tag: '大笑' } },
  { query: '在摸鱼划水呢', want: { tag: '摸鱼' } },
  { query: '困了要睡了', want: { tag: '睡觉' } },
  { query: '好想吃小蛋糕', want: { tag: '甜食' } },
  { query: '气到炸毛', want: { tag: '生气' } },
  { query: '震惊到说不出话', want: { tag: '震惊' } },
  { query: '没听懂你在说什么', want: { tag: '疑惑' } },
  { query: '被夸了有点害羞', want: { tag: '害羞' } },
  { query: '吃饱了很满足', want: { tag: '吃饱' } },
  { query: '在干活算力跑满', want: { tag: '干活' } },
  { query: '白嫖到赠金', want: { tag: '白嫖' } },
  { query: '接口 429 报错太多', want: { tag: '报错' } },
  { query: '吃瓜看戏', want: { tag: '吃瓜' } },
  // —— 以下 6 条是口语化转写，字面几乎对不上，考同义扩展 ——
  { query: 'emo 了有点难过', want: { tag: '委屈' } },
  { query: '被老板催着干活', want: { tag: '催活' } },
  { query: '刚睡醒回个血', want: { tag: '睡醒' } },
  { query: '被叫大肥鱼好气', want: { tag: '大肥鱼' } },
  { query: '破防了想骂回去', want: { tag: '怼人' } },
  { query: '想撒娇要点额度', want: { tag: '耍赖' } }
];

function parseArgs(argv) {
  const args = { file: DEFAULT_FILE, verbose: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') args.file = argv[++i];
    else if (arg === '--verbose' || arg === '-v') args.verbose = true;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function matchesWant(entry, want) {
  if (want.tag) return (entry.tags || []).includes(want.tag);
  if (want.desc) return String(entry.desc || '').includes(want.desc);
  return false;
}

/** 旧口径：查询原串在字段里 includes，命中字段越多分越高。tags 权重按 3 计（旧实现其实只做「有/没有」）。 */
function legacySearch(entries, query, limit = 3) {
  const needle = String(query || '').toLowerCase().trim();
  if (!needle) return [];
  return entries
    .map((entry) => {
      const fields = [entry.desc, entry.localNote, entry.usage].map((v) => String(v || '').toLowerCase());
      const tags = (entry.tags || []).map((t) => String(t).toLowerCase());
      let score = 0;
      for (const field of fields) if (field.includes(needle)) score += 1;
      for (const tag of tags) if (tag.includes(needle) || needle.includes(tag)) score += 3;
      return { entry, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((hit) => hit.entry);
}

function evaluate(entries, searchFn) {
  const rows = [];
  let top1 = 0;
  let top3 = 0;
  for (const testCase of CASES) {
    const results = searchFn(entries, testCase.query, 3);
    const index = results.findIndex((entry) => matchesWant(entry, testCase.want));
    if (index === 0) top1 += 1;
    if (index >= 0 && index < 3) top3 += 1;
    rows.push({
      query: testCase.query,
      want: testCase.want.tag ? `#${testCase.want.tag}` : `~${testCase.want.desc}`,
      rank: index >= 0 ? index + 1 : null,
      top: results.map((entry) => entry.desc || entry.id).slice(0, 3)
    });
  }
  return { rows, top1, top3, total: CASES.length };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let entries;
  try {
    entries = loadStickerStore(args.file);
  } catch (error) {
    console.error(`❌ 表情库读取失败：${error?.message ?? error}`);
    process.exitCode = 1;
    return;
  }
  if (!entries.length) {
    console.error(`❌ 表情库为空：${args.file}`);
    process.exitCode = 1;
    return;
  }

  const index = buildStickerIndex(entries);
  const semantic = evaluate(entries, (list, query, limit) => searchStickers(index, query, { limit }));
  const legacy = evaluate(entries, legacySearch);

  const pct = (n, total) => `${((n / total) * 100).toFixed(0)}%`;

  if (args.json) {
    console.log(JSON.stringify({
      corpusSize: entries.length,
      semantic: { top1: semantic.top1, top3: semantic.top3, total: semantic.total, rows: semantic.rows },
      legacy: { top1: legacy.top1, top3: legacy.top3, total: legacy.total }
    }, null, 2));
    return;
  }

  console.log(`语料 ${entries.length} 条 / 评测 ${CASES.length} 条`);
  console.log(`语义检索(Track1)  top1 ${semantic.top1}/${semantic.total} (${pct(semantic.top1, semantic.total)})  top3 ${semantic.top3}/${semantic.total} (${pct(semantic.top3, semantic.total)})`);
  console.log(`旧子串匹配(对照)  top1 ${legacy.top1}/${legacy.total} (${pct(legacy.top1, legacy.total)})  top3 ${legacy.top3}/${legacy.total} (${pct(legacy.top3, legacy.total)})`);

  if (args.verbose) {
    console.log('\n未命中/低排名明细：');
    let shown = 0;
    for (const row of semantic.rows) {
      if (row.rank === 1) continue;
      shown += 1;
      console.log(`- 「${row.query}」 期望 ${row.want} → ${row.rank ? `第 ${row.rank} 位` : '未进前 3'}`);
      row.top.forEach((desc, i) => console.log(`    ${i + 1}. ${desc}`));
    }
    if (!shown) console.log('  (全部 top1 命中)');
  }

  // top3 低于 70% 视为基线不达标，给 CI 一个非 0 退出码（当前门槛，可随语料扩张上调）
  const threshold = 0.7;
  if (semantic.top3 / semantic.total < threshold) {
    console.error(`❌ top3 命中率低于门槛 ${pct(threshold, 1)}（需继续调同义词/权重）`);
    process.exitCode = 1;
  } else {
    console.log(`✅ top3 命中率达标（门槛 ${pct(threshold, 1)}）`);
  }
}

main();
