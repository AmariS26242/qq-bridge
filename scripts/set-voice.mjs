#!/usr/bin/env node
// 安全改音色：node scripts/set-voice.mjs <voice> [--mood=calm] [--pitch=n] [--speed=n]
// 不带 --mood 时改全部五档（保持「同一个人」），并把指定音色作为唯一 voice。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const file = path.join(ROOT, 'config.json');

const argv = process.argv.slice(2);
const voice = argv.find((a) => !a.startsWith('--'));
if (!voice) {
  console.error('用法：node scripts/set-voice.mjs <voice> [--mood=calm] [--pitch=n] [--speed=n]');
  process.exit(2);
}
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const onlyMood = opt('mood', '');
const pitch = opt('pitch', '');
const speed = opt('speed', '');

const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
const moods = cfg.voiceTts?.moods || {};
const targets = onlyMood ? [onlyMood] : Object.keys(moods);
for (const name of targets) {
  if (!moods[name]) continue;
  moods[name].voice = voice;
  if (pitch !== '') moods[name].pitch = Number(pitch);
  if (speed !== '') moods[name].speed = Number(speed);
}
fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
console.log(`已改：${targets.join(',')} → ${voice}${pitch !== '' ? ` pitch=${pitch}` : ''}${speed !== '' ? ` speed=${speed}` : ''}`);
for (const name of targets) if (moods[name]) console.log(`  ${name}: ${JSON.stringify(moods[name])}`);
