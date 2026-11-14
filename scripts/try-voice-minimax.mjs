#!/usr/bin/env node
// 02b 真机合成演练（只合成、不发送）：五档 mood 各出一条，报时长/字节/耗时/参数。
// 用法：node scripts/try-voice-minimax.mjs            → 五档全跑
//       node scripts/try-voice-minimax.mjs calm 文本  → 单条
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { voiceTtsConfig, synthesize, removeQuietly } from '../src/voice-tts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const c = voiceTtsConfig(cfg);

const CASES = [
  ['calm', '今天有点累，想安静一会儿'],
  ['happy', '你终于回来啦，我等你好久了'],
  ['shy', '别、别盯着我看啦'],
  ['annoyed', '哼，又想起来我啦？'],
  ['sad', '有点难过，不过没事']
];

const argv = process.argv.slice(2);
const cases = argv.length >= 2 ? [[argv[0], argv.slice(1).join(' ')]] : CASES;

console.log(`引擎 ${c.engine} · 模型 ${c.minimax.model} · 音色 ${c.moods.calm.voice} · 夹逼 ${c.minSeconds}–${c.maxSeconds}s\n`);

const made = [];
let bad = 0;
for (const [mood, text] of cases) {
  const t0 = Date.now();
  try {
    const r = await synthesize(text, mood, cfg);
    made.push(r.filePath);
    const okLen = r.seconds >= c.minSeconds && r.seconds <= c.maxSeconds;
    if (!okLen) bad += 1;
    console.log(`${okLen ? 'ok  ' : 'BAD '} ${mood.padEnd(7)} ${String(r.seconds).padStart(6)}s ${String(r.bytes).padStart(7)}B ${String(Date.now() - t0).padStart(5)}ms  speed=${r.speed} pitch=${r.pitch} emotion=${r.emotion ?? '-'} 说出口：${r.spokenText}${r.attempts > 1 ? `（${r.attempts} 次尝试）` : ''}`);
  } catch (error) {
    bad += 1;
    console.log(`FAIL ${mood.padEnd(7)} ${Date.now() - t0}ms — ${error?.message ?? error}`);
  }
}

// 试听文件保留在 state/tmp/voice 下（不放到语音库），跑完打印路径方便手工听。
console.log(`\n文件：${made.map((f) => path.basename(f)).join('  ') || '（无）'}`);
console.log(bad === 0 ? '结果：全部落在 2–60 秒' : `结果：${bad} 条不合格`);
if (process.env.KEEP !== '1') {
  // 默认清理，避免临时目录堆积；KEEP=1 时留给人工试听
  for (const f of made) removeQuietly(f);
}
process.exit(bad === 0 ? 0 : 1);
