#!/usr/bin/env node
// 02b 采样率对比：同一句话、同一音色/语速，只改 audio_setting.sample_rate，生成 16k/24k/32k 三份 mp3。
// 用法：
//   node scripts/probe-samplerate.mjs            只生成本地样本并打印对比表
//   node scripts/probe-samplerate.mjs --send     再经 QQ 各发一条（间隔 63s，避开 2 条/分钟频控）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mp3DurationOfFile, stageIntoLibrary, synthMinimax, voiceTtsConfig } from '../src/voice-tts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORKSPACE = path.resolve(ROOT, '..');
const OUT = path.join(WORKSPACE, 'voice-samples', 'samplerate');
const RATES = [16000, 24000, 32000];
const TEXT = '这个语速差不多了吧，再快就要赶人了';
const MOOD = 'calm';
const send = process.argv.includes('--send');

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

const rows = [];
const baseCfg = voiceTtsConfig(raw);

// 生成一份样本。单独成函数是为了「时长对齐」时能重合成同一条。
async function gen(rate) {
  const cfg = { ...baseCfg, minimax: { ...baseCfg.minimax, sampleRate: rate } };
  const t0 = Date.now();
  const buf = await synthMinimax(TEXT, cfg.moods[MOOD], cfg);
  const ms = Date.now() - t0;
  const dest = path.join(OUT, `sr-${rate}.mp3`);
  fs.writeFileSync(dest, buf);
  const info = mp3DurationOfFile(dest) || {};
  return {
    rate,
    file: dest,
    bytes: fs.statSync(dest).size,
    ms,
    seconds: info.seconds,
    headerRate: info.sampleRate,
    kbps: info.bitrateKbps
  };
}

for (const rate of RATES) rows.push(await gen(rate));

// MiniMax 每次断句不固定，同一句的时长会差 5–15%——横评时听者容易被「读得长的那条」带偏。
// 时长差超过 6% 就把离群项重合成（最多 2 次），保留时长最接近中位数的那份。
function spreadOf(list) {
  const secs = list.map((r) => r.seconds).filter((s) => typeof s === 'number');
  if (secs.length < 2) return 0;
  const sorted = [...secs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return (Math.max(...secs) - Math.min(...secs)) / median;
}

function medianOf(list) {
  const secs = list.map((r) => r.seconds).filter((s) => typeof s === 'number').sort((a, b) => a - b);
  return secs.length ? secs[Math.floor(secs.length / 2)] : 0;
}

let spread = spreadOf(rows);
if (spread > 0.06) {
  const median = medianOf(rows);
  console.log(`\n⚠ 三份样本时长差 ${(spread * 100).toFixed(1)}%（MiniMax 断句抖动），重合成离群项以对齐时长…`);
  for (let i = 0; i < rows.length; i++) {
    if (typeof rows[i].seconds !== 'number' || Math.abs(rows[i].seconds - median) / median <= 0.05) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = await gen(rows[i].rate);
      if (typeof next.seconds !== 'number') break;
      if (Math.abs(next.seconds - median) < Math.abs(rows[i].seconds - median)) rows[i] = next;
      if (Math.abs(rows[i].seconds - median) / median <= 0.05) break;
    }
  }
  spread = spreadOf(rows);
  console.log(`对齐后时长差 ${(spread * 100).toFixed(1)}%`);
}

console.log('\n采样率 | 请求 | mp3 头实际 | 码率 | 时长s | 大小KB | 合成ms');
console.log('---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`${r.rate} | ${r.rate} | ${r.headerRate ?? '?'} | ${r.kbps ?? '?'} kbps | ${r.seconds} | ${(r.bytes / 1024).toFixed(1)} | ${r.ms}`);
}
console.log(`\n本地样本目录：${OUT}`);
console.log(`时长差 ${(spreadOf(rows) * 100).toFixed(1)}% —— 横评只听音色和清晰度，别把「读得长」当成音质好。`);

if (!send) process.exit(0);

// 真机发送：token 每次现读（bridge 重启会换）
const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
const conv = state.conversations || {};
const key = Object.keys(conv).find((k) => k.startsWith('private:')) || Object.keys(conv)[0];
const token = conv[key]?.agentToken;
const consoleToken = (() => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  if (j.consoleToken) return j.consoleToken;
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
})();
if (!key || !token) {
  console.error('state/social-v2.json 里没有会话 token，跳过发送');
  process.exit(2);
}

const cfg = voiceTtsConfig(raw);

// 先发一条文字说明收听顺序，再逐条发语音
{
  const res = await fetch('http://127.0.0.1:3100/api/socialV2/send-message', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': consoleToken, 'x-agent-token': token },
    body: JSON.stringify({
      key,
      messages: '采样率对比：下面三条同一句话、同一音色语速，依次是 16k / 24k / 32k，听完说哪条最顺耳（或者听不出差别也行）'
    })
  });
  console.log('[notice]', res.status, JSON.stringify(await res.json().catch(() => ({}))).slice(0, 160));
  await new Promise((s) => setTimeout(s, 3000));
}

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const staged = stageIntoLibrary(r.file, cfg);
  try {
    const res = await fetch('http://127.0.0.1:3100/api/socialV2/send-voice', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': consoleToken, 'x-agent-token': token },
      body: JSON.stringify({ key, token, voice: staged.relPath, label: TEXT })
    });
    const body = await res.json().catch(() => ({}));
    console.log(`[${r.rate}] ${res.status}`, JSON.stringify({ ok: body.ok, messageId: body.messageId, seconds: body.seconds, voiceName: body.voiceName, detail: body.detail, error: body.error }));
  } finally {
    fs.rmSync(staged.absPath, { force: true });
  }
  if (i < rows.length - 1) {
    console.log('等待 63s 避开频控…');
    await new Promise((s) => setTimeout(s, 63000));
  }
}
