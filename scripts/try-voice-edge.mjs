#!/usr/bin/env node
// S6 回退演练：把 engine 临时改成 edge 合成一条（不动 config.json），确认旧引擎仍然可用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesize, removeQuietly } from '../src/voice-tts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
cfg.voiceTts.engine = 'edge';
const text = process.argv.slice(2).join(' ') || '回退测试，听得见吗';

const t0 = Date.now();
const r = await synthesize(text, 'calm', cfg);
console.log(JSON.stringify({ engine: r.engine, seconds: r.seconds, bytes: r.bytes, rate: r.rate, voice: r.voice, ms: Date.now() - t0 }, null, 0));
removeQuietly(r.filePath);
process.exit(r.engine === 'edge' && r.seconds >= 2 ? 0 : 1);
