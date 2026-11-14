import fs from 'node:fs';
import { searchStickers } from '../src/sticker-index.js';
import { MOOD_QUERIES, pickAutoSticker } from '../src/auto-sticker.mjs';

const entries = JSON.parse(fs.readFileSync('state/stickers.json', 'utf8'));
let recent = [];
const rows = [];
for (const mood of ['happy', 'shy', 'annoyed', 'sad', 'calm']) {
  for (let i = 0; i < 3; i += 1) {
    const hits = searchStickers(entries, MOOD_QUERIES[mood], { limit: 8 });
    const r = pickAutoSticker(hits, { mood, recent });
    rows.push({ mood, round: i + 1, id: r.picked ? r.picked.id.slice(-8) : null, score: r.picked ? +r.picked.score.toFixed(1) : null, reason: r.reason, desc: r.picked ? r.picked.desc : '' });
    if (r.picked) recent = [...recent, r.picked.id].slice(-12);
  }
}
console.log(JSON.stringify(rows, null, 1));
const perMood = {};
for (const r of rows) (perMood[r.mood] ||= []).push(r.id);
for (const [m, ids] of Object.entries(perMood)) console.log(m, '3 次 →', ids.join(' | '), ids.filter(Boolean).length === 3 && new Set(ids).size === 3 ? '不重复 ✓' : '有重复 ✗');
