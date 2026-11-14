#!/usr/bin/env node
// 音色/参数试听探针：对同一句话跑多组「音色 + speed + pitch + 采样率/码率」，
// 只合成到 state/tmp/voice（不发送、不落语音库），打印时长/体积/错误。
// 用法：node scripts/probe-voices.mjs [文本]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesize, removeQuietly } from '../src/voice-tts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const text = process.argv.slice(2).join(' ') || '今天有点累，想安静一会儿';

const VARIANTS = [
  { name: 'A 萌妹-24k-降调', voice: 'qiaopi_mengmei', speed: 0.98, pitch: -3, sampleRate: 24000, bitrate: 64000 },
  { name: 'B 少女-24k', voice: 'female-shaonv', speed: 1.0, pitch: -2, sampleRate: 24000, bitrate: 64000 },
  { name: 'C 御姐-24k', voice: 'female-yujie', speed: 1.0, pitch: -1, sampleRate: 24000, bitrate: 64000 },
  { name: 'D 成熟-24k', voice: 'female-chengshu', speed: 1.0, pitch: -2, sampleRate: 24000, bitrate: 64000 },
  { name: 'E 萌妹-32k-原调', voice: 'qiaopi_mengmei', speed: 1.0, pitch: 0, sampleRate: 32000, bitrate: 128000, control: true }
];

const made = [];
for (const v of VARIANTS) {
  const cfg = JSON.parse(JSON.stringify(base));
  cfg.voiceTts.moods.calm = { voice: v.voice, speed: v.speed, pitch: v.pitch };
  cfg.voiceTts.minimax = { ...cfg.voiceTts.minimax, sampleRate: v.sampleRate, bitrate: v.bitrate };
  const t0 = Date.now();
  try {
    const r = await synthesize(text, 'calm', cfg);
    made.push({ name: v.name, file: r.filePath });
    console.log(`ok   ${v.name.padEnd(18)} ${String(r.seconds).padStart(5)}s ${String(r.bytes).padStart(6)}B ${String(Date.now() - t0).padStart(5)}ms  ${r.voice}`);
  } catch (error) {
    console.log(`FAIL ${v.name.padEnd(18)} ${Date.now() - t0}ms — ${error?.message ?? error}`);
  }
}

console.log(`\n试听文件（${made.length} 个，留在 state/tmp/voice）：`);
for (const m of made) console.log(`  ${m.name} → ${path.basename(m.file)}`);
if (process.env.KEEP !== '1') for (const m of made) removeQuietly(m.file);
