// 表情包语义检索 CLI —— 离线质检用。
//
// 用法：
//   node scripts/sticker-search.mjs "有点想哭"            # 默认 top 5
//   node scripts/sticker-search.mjs "在干活" -n 8 --json  # top 8 + JSON
//   node scripts/sticker-search.mjs --id 88               # 反向查：按 id/序号看条目全字段
//
// 存在的意义：Track 1（分词+同义词+加权）与 Track 2（向量精排）都要能被人工抽查，
// 没有这个命令就只能靠「发一条 QQ 消息看机器人抽到哪张」来验证，一天测不了 20 条。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStickerStore } from '../src/sticker-lib.js';
import { buildStickerIndex, searchStickers, formatSearchHit, tokenize, expandWithSynonyms, explainSearch } from '../src/sticker-index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.join(HERE, '..', 'state', 'stickers.json');

function parseArgs(argv) {
  const args = { query: '', limit: 5, json: false, file: DEFAULT_FILE, id: '', verbose: false, explain: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--explain') args.explain = true;
    else if (arg === '--verbose' || arg === '-v') args.verbose = true;
    else if (arg === '-n' || arg === '--limit') args.limit = Number(argv[++i]) || 5;
    else if (arg === '--file') args.file = argv[++i];
    else if (arg === '--id') args.id = argv[++i];
    else rest.push(arg);
  }
  args.query = rest.join(' ').trim();
  return args;
}

/** 反向查询：支持完整 id、id 内 md5、或表格序号（1-based，便于对着 tmp/sticker-table.txt 看）。 */
function findById(entries, needle) {
  const value = String(needle || '').trim();
  if (!value) return [];
  const asIndex = Number(value);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= entries.length) {
    return [{ index: asIndex, entry: entries[asIndex - 1] }];
  }
  const upper = value.toUpperCase();
  return entries
    .map((entry, index) => ({ index: index + 1, entry }))
    .filter(({ entry }) => entry.id === value || entry.id.toUpperCase().includes(upper));
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

  if (args.id) {
    const hits = findById(entries, args.id);
    if (!hits.length) {
      console.error(`❌ 没找到 id / 序号：${args.id}`);
      process.exitCode = 1;
      return;
    }
    for (const { index, entry } of hits) {
      console.log(`#${index} ${entry.id}`);
      console.log(`  配字: ${entry.desc || '(空)'}`);
      console.log(`  标签: ${(entry.tags || []).join(' / ') || '(空)'}`);
      console.log(`  理解: ${entry.localNote || '(空)'}`);
      console.log(`  用途: ${entry.usage || '(空)'}`);
      console.log(`  用量: ${entry.useCount}  来源: ${entry.source}`);
    }
    return;
  }

  if (!args.query) {
    console.error('用法: node scripts/sticker-search.mjs "查询" [-n 5] [--json] [--id <id|序号>]');
    process.exitCode = 1;
    return;
  }

  const index = buildStickerIndex(entries);
  const results = searchStickers(index, args.query, { limit: args.limit });

  if (args.explain) {
    const report = explainSearch(index, args.query, { limit: args.limit });
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`🔎 「${report.query}」 归一化「${report.normalized}」 / 库内 ${report.total} 条`);
    const synonymCount = report.terms.filter((t) => t.synonym).length;
    console.log(`   查询词 ${report.terms.length - synonymCount} 个 + 同义扩展 ${synonymCount} 个`);
    for (const hit of report.hits) {
      console.log(`\n[${hit.score}] ${hit.desc} ${(hit.tags || []).join('/')}`);
      console.log(`   BM25 逐词：`);
      for (const part of hit.terms) {
        const fields = part.fields.map((f) => `${f.field}×${f.tf}`).join(', ') || '无字段';
        console.log(`     ${part.term.padEnd(6)} q=${part.queryWeight} tf=${part.tf} idf=${part.idf} → +${part.contribution}  (${fields})`);
      }
      if (hit.bonuses.length) {
        console.log(`   加分项：${hit.bonuses.map((b) => `${b.label} +${b.points}`).join('；')}`);
      }
    }
    return;
  }

  if (args.json) {
    console.log(JSON.stringify({
      query: args.query,
      terms: expandWithSynonyms(tokenize(args.query)),
      results: results.map((hit) => ({
        id: hit.id,
        score: hit.score,
        desc: hit.entry.desc,
        tags: hit.tags,
        matchedTerms: hit.matchedTerms,
        reason: hit.reason
      }))
    }, null, 2));
    return;
  }

  console.log(`🔎 「${args.query}」 top ${results.length} / 库内 ${entries.length} 条`);
  if (args.verbose) {
    const terms = expandWithSynonyms(tokenize(args.query));
    console.log(`   分词→同义扩展: ${[...terms.entries()].map(([t, w]) => (w === 1 ? t : `${t}*`)).join(' ')}`);
  }
  if (!results.length) {
    console.log('   (无命中)');
    return;
  }
  results.forEach((hit, i) => console.log(formatSearchHit(hit, i)));
}

main();
