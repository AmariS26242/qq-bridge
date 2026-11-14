// 人格卡版本快照：把当前卡复制进 eval/d3/baseline/，记 sha256/字数/行数/时间。
// D3 改卡前先跑一次，回滚时按 manifest 最后一条还原。
// 用法：node scripts/snapshot-persona-card.mjs [源文件] [--reason 说明]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const reasonIdx = args.indexOf('--reason');
const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : '';
const src = args.find((a, i) => !a.startsWith('--') && i !== reasonIdx + 1) || 'roles/小鲸鱼.md';

const DIR = 'eval/d3/baseline';
const MANIFEST = path.join(DIR, 'manifest.json');
const buf = fs.readFileSync(src);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
const base = path.basename(src);
const target = path.join(DIR, `${base}.${sha.slice(0, 8)}.${stamp}.bak`);

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(target, buf);

let manifest = { entries: [] };
if (fs.existsSync(MANIFEST)) {
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { manifest = { entries: [] }; }
}
const text = buf.toString('utf8');
const entry = {
  source: src,
  snapshot: target,
  sha256: sha,
  bytes: buf.length,
  chars: [...text].length,
  lines: text.split('\n').length,
  at: new Date().toISOString(),
  reason: reason || 'manual',
};
manifest.entries.push(entry);
manifest.latest = entry.snapshot;
fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`已快照：${target}`);
console.log(`sha256 ${sha.slice(0, 16)}… · ${entry.chars} 字符 · ${entry.lines} 行 · ${entry.bytes} B`);
console.log(`manifest 现有 ${manifest.entries.length} 条，最新指向 ${manifest.latest}`);
