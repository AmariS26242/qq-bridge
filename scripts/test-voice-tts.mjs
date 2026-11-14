// voice-tts.mjs 的离线+在线自测（P1 验收用）。
//
// 用法（在 qq-bridge 下）：
//   node scripts/test-voice-tts.mjs
//
// 只读 config.json，**不会**改它；通过临时注入 voiceTts.enabled=true 来测试合成，
// 所以即使生产配置里语音还关着也能跑。会真实调用 edge-tts（联网）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tts = await import(new URL('../src/voice-tts.mjs', import.meta.url).href);

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

function loadCfg() {
  let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

// ── 纯函数：配置归一化 ───────────────────────────────────────────────────────
console.log('## 配置归一化');
{
  const c = tts.voiceTtsConfig({});
  ok(c.enabled === false, '缺 voiceTts 段时默认关闭');
  ok(c.minSeconds === 2 && c.maxSeconds === 60, '默认 2–60 秒');
  ok(c.moods.calm.voice === 'zh-CN-XiaoxiaoNeural', 'calm 默认声线');
  ok(c.moods.annoyed.voice === 'zh-CN-YunxiNeural', 'annoyed 默认男声（玩梗档）');

  const c2 = tts.voiceTtsConfig({ voiceTts: { enabled: true, moods: { happy: { rate: '+30%' } } } });
  ok(c2.moods.happy.rate === '+30%', 'moods 单项覆盖生效');
  ok(c2.moods.happy.voice === 'zh-CN-XiaoyiNeural', '未覆盖的字段仍用默认');
  ok(c2.moods.shy.voice === 'zh-CN-XiaoyiNeural', '其它 mood 不受影响');

  const c3 = tts.voiceTtsConfig({ socialV2: { voice: { dir: 'audio' } } });
  ok(c3.libraryDir === path.join(ROOT, 'audio'), '语音库目录与 bridge 同口径解析');

  // edge-tts 只认带符号的 rate/pitch，手写 "0%" 必须被补签
  const c4 = tts.voiceTtsConfig({ voiceTts: { moods: { calm: { rate: '0%', pitch: '0Hz' } } } });
  ok(c4.moods.calm.rate === '+0%' && c4.moods.calm.pitch === '+0Hz', '无符号 rate/pitch 自动补 "+"');
  ok(tts.voiceTtsConfig({}).moods.calm.rate === '+0%', '默认 calm 也是 +0%');
}

// ── 纯函数：文本归一化 ───────────────────────────────────────────────────────
console.log('## 文本归一化');
{
  ok(tts.normalizeSpeechText('  a   b  ') === 'a b', '压掉多余空格');
  ok(tts.normalizeSpeechText('a\u0007b') === 'ab', '剔掉控制字符');
  ok(tts.normalizeSpeechText('') === '', '空串还是空串');
  const long = '这是一句话。'.repeat(200);
  const cut = tts.normalizeSpeechText(long, 100);
  ok(cut.length <= 100, '超长文本被截断到上限内', `len=${cut.length}`);
  ok(cut.endsWith('。'), '截断尽量落在句号上');
  // 2026-10-26：句首语气词自动摘掉（用户反馈「嗯」开场像敷衍），但单字不能削成空串。
  ok(tts.normalizeSpeechText('嗯，我在。') === '我在。', '句首「嗯，」被摘掉');
  ok(tts.normalizeSpeechText('嗯嗯，好的。') === '好的。', '叠字「嗯嗯」同样摘掉');
  ok(tts.normalizeSpeechText('嗯') === '嗯', '只有一个「嗯」时保留（否则合成失败）');
  ok(tts.normalizeSpeechText('今晚嗯，早点睡。') === '今晚嗯，早点睡。', '句子中间的「嗯」不动');
}

// ── 纯函数：MP3 时长解析 ─────────────────────────────────────────────────────
console.log('## MP3 解析');
{
  ok(tts.mp3Duration(Buffer.from('not-an-mp3')) === null, '非 MP3 返回 null 不抛');
  // 构造两帧 MPEG2 Layer III 48kbps/24kHz 单声道，帧长 144 字节 → 2×576/24000 = 0.048s
  const frame = Buffer.alloc(144);
  frame[0] = 0xff; frame[1] = 0xf3; frame[2] = 0x64; frame[3] = 0xc4;
  const d = tts.mp3Duration(Buffer.concat([frame, frame]));
  ok(d && d.frames === 2, '两帧能解析', JSON.stringify(d));
  ok(d && Math.abs(d.seconds - 0.048) < 0.002, '帧时长算对', `${d?.seconds}s`);
}

// ── 在线：真实合成 ───────────────────────────────────────────────────────────
console.log('## 合成（需要网络）');
const cfg = loadCfg();
cfg.voiceTts = { ...(cfg.voiceTts ?? {}), enabled: true };
const tmpDir = tts.voiceTtsConfig(cfg).tmpDir;
const created = [];

try {
  const r1 = await tts.synthesize('测试一下语音', 'calm', cfg);
  created.push(r1.filePath);
  ok(fs.existsSync(r1.filePath), '产出文件存在', r1.filePath);
  ok(r1.bytes > 10 * 1024, '文件 > 10 KB', `${r1.bytes} B`);
  // 下限以当前 config 为准（2026-10-26 从 2 秒降到 1.2 秒：短句硬凑 2 秒会留一截死气尾巴）
  const minSec = cfg.voiceTts.minSeconds ?? 2;
  ok(r1.seconds >= minSec && r1.seconds <= 60, `时长在 ${minSec}–60 秒内`, `${r1.seconds}s`);
  ok(r1.mood === 'calm' && r1.voice === tts.voiceTtsConfig(cfg).moods.calm.voice, '按 mood 选声线', r1.voice);

  // 极短文本（1 个字）必须靠补静音过下限，且不能靠垫「嗯」
  const r2 = await tts.synthesize('嗯', 'happy', cfg);
  created.push(r2.filePath);
  ok(r2.seconds >= minSec, `单字也能补到 ${minSec} 秒以上`, `${r2.seconds}s / ${r2.attempts} 次`);
  ok(r2.voice === tts.voiceTtsConfig(cfg).moods.happy.voice, 'happy 用 happy 档声线', r2.voice);

  // 超长文本：必须截断到 60 秒以内
  const longText = '今天天气很好，我们去公园散步吧。'.repeat(40);
  const r3 = await tts.synthesize(longText, 'sad', cfg);
  created.push(r3.filePath);
  ok(r3.seconds <= 60, '超长文本被夹到 60 秒内', `${r3.seconds}s`);
  ok(r3.spokenText.length < longText.length, '确实截断了文本', `${longText.length} → ${r3.spokenText.length}`);

  // 未知 mood 回落 calm
  const r4 = await tts.synthesize('试试未知情绪', 'excited', cfg);
  created.push(r4.filePath);
  ok(r4.mood === 'calm' && r4.warnings.length > 0, '未知 mood 回落 calm 且给 warning', r4.warnings.join('；'));

  // 置入语音库隐藏目录
  const staged = tts.stageIntoLibrary(r4.filePath, cfg);
  ok(fs.existsSync(staged.absPath), '入语音库成功', staged.relPath);
  ok(staged.relPath.startsWith('.tts/'), '落在 .tts 隐藏目录（不污染语音库列表）');
  const core = await import(new URL('../src/voice-core.js', import.meta.url).href);
  const visible = core.listAudioFiles(tts.voiceTtsConfig(cfg).libraryDir);
  ok(!visible.some((f) => f.includes(`${path.sep}.tts${path.sep}`)), 'listAudioFiles 跳过 .tts');
  tts.removeQuietly(staged.absPath);
} catch (error) {
  fail += 1;
  console.error(`  ❌ 合成异常：${error?.message ?? error}`);
} finally {
  for (const f of created) tts.removeQuietly(f);
}

// ── 关闭态必须明确报错 ───────────────────────────────────────────────────────
console.log('## 关闭态');
{
  const off = loadCfg();
  off.voiceTts = { ...(off.voiceTts ?? {}), enabled: false };
  let msg = '';
  try {
    await tts.synthesize('关掉之后不该合', 'calm', off);
  } catch (error) {
    msg = String(error?.message ?? error);
  }
  ok(msg.includes('voiceTts.enabled'), '关闭时错误信息点名 voiceTts.enabled', msg.slice(0, 80));
}

// 临时目录不应残留本次产物
try {
  const left = fs.readdirSync(tmpDir).filter((f) => f.startsWith('tts-'));
  ok(left.length === 0, 'state/tmp/voice 没有残留 tts-* 文件', left.join(', '));
} catch {
  ok(true, '临时目录不存在（等价于无残留）');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
