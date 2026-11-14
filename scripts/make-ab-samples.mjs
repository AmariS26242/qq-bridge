#!/usr/bin/env node
// 生成一组「本机试听」样本（mp3 原文件，不过 QQ 转码），用文件名区分配置，便于盲听定性。
// 输出目录：<工作区>/voice-samples/ab-<时间戳>/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesize, removeQuietly } from '../src/voice-tts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const text = process.argv.slice(2).join(' ') || '今天有点累，想安静一会儿';
const outDir = path.join(ROOT, '..', 'voice-samples', `ab-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`);
fs.mkdirSync(outDir, { recursive: true });

const VARIANTS = [
  { tag: '1-minimax-qiaopi-32k', voice: 'qiaopi_mengmei', speed: 1.0, pitch: 0, sampleRate: 32000, bitrate: 128000 },
  { tag: '2-minimax-qiaopi-24k', voice: 'qiaopi_mengmei', speed: 1.0, pitch: -2, sampleRate: 24000, bitrate: 64000 },
  { tag: '3-minimax-yujie', voice: 'female-yujie', speed: 1.0, pitch: 0, sampleRate: 32000, bitrate: 128000 },
  { tag: '4-minimax-chengshu', voice: 'female-chengshu', speed: 1.0, pitch: -1, sampleRate: 32000, bitrate: 128000 },
  { tag: '5-minimax-tianmei', voice: 'female-tianmei', speed: 1.0, pitch: 0, sampleRate: 32000, bitrate: 128000 },
  { tag: '6-edge-xiaoxiao', engine: 'edge', voice: 'zh-CN-XiaoxiaoNeural' }
];

for (const v of VARIANTS) {
  const cfg = JSON.parse(JSON.stringify(base));
  cfg.voiceTts.engine = v.engine || 'minimax';
  if (cfg.voiceTts.engine === 'minimax') {
    cfg.voiceTts.moods.calm = { voice: v.voice, speed: v.speed, pitch: v.pitch };
    cfg.voiceTts.minimax = { ...cfg.voiceTts.minimax, sampleRate: v.sampleRate, bitrate: v.bitrate };
  } else {
    cfg.voiceTts.moods.calm = { voice: v.voice, rate: '+0%', pitch: '+0Hz' };
  }
  try {
    const r = await synthesize(text, 'calm', cfg);
    const dest = path.join(outDir, `${v.tag}.mp3`);
    fs.copyFileSync(r.filePath, dest);
    removeQuietly(r.filePath);
    console.log(`ok   ${v.tag.padEnd(24)} ${String(r.seconds).padStart(5)}s ${String(r.bytes).padStart(6)}B → ${path.basename(dest)}`);
  } catch (error) {
    console.log(`FAIL ${v.tag.padEnd(24)} — ${error?.message ?? error}`);
  }
}
console.log(`\n目录：${outDir}`);
