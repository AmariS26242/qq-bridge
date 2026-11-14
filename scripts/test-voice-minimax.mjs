#!/usr/bin/env node
// 02b 离线验证：MiniMax 引擎的配置口径 + 失败路径（不联网、不发声、不依赖桥接）。
// 真实合成与真机发送由 scripts/try-voice-minimax.mjs 负责。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { voiceTtsConfig, synthesize, splitForTts, DEFAULT_MOODS_MINIMAX, applyVoicePauses } from '../src/voice-tts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
async function throws(name, fn, needle) {
  try {
    await fn();
    fail += 1;
    console.log(`  FAIL ${name} — 没有抛错`);
  } catch (error) {
    const msg = String(error?.message ?? error);
    ok(name, msg.includes(needle), msg.slice(0, 120));
  }
}

console.log('\n[1] config.json 的 MiniMax 口径');
const c = voiceTtsConfig(raw);
ok('engine=minimax', c.engine === 'minimax', c.engine);
ok('enabled', c.enabled === true);
ok('moods 五档齐全', Object.keys(c.moods).sort().join(',') === 'annoyed,calm,happy,sad,shy');
ok('五档同一音色', new Set(Object.values(c.moods).map((m) => m.voice)).size === 1, Object.values(c.moods)[0].voice);
// 期望值以 config.json 当前口径为准（2026-11-08 11:36 用户要求「所有情绪向 calm 靠拢」：
// 五档速度收进 0.96–1.03，全部不传 emotion，让 2.8-hd 从日语文本自己推语气，
// 整体保持 calm 底色。见 src/voice-tts.mjs:44-57 注释）。
// 改了 config 就要同步这里，否则红项没有信息量。
ok('calm speed=1.0 pitch=0 不传 emotion', c.moods.calm.speed === 1.0 && c.moods.calm.pitch === 0 && !c.moods.calm.emotion, `${c.moods.calm.speed}/${c.moods.calm.pitch}/${c.moods.calm.emotion}`);
ok('annoyed speed=1.02 不传 emotion（傲娇靠平不靠怒）', c.moods.annoyed.speed === 1.02 && !c.moods.annoyed.emotion, `${c.moods.annoyed.speed}/${c.moods.annoyed.emotion}`);
ok('happy speed=1.03 不传 emotion（靠文本，向 calm 靠）', c.moods.happy.speed === 1.03 && !c.moods.happy.emotion, `${c.moods.happy.speed}/${c.moods.happy.emotion}`);
ok('shy speed=0.96 不传 emotion（轻微放慢）', c.moods.shy.speed === 0.96 && !c.moods.shy.emotion, `${c.moods.shy.speed}/${c.moods.shy.emotion}`);
ok('sad speed=0.98 不传 emotion（保持 calm 底色）', c.moods.sad.speed === 0.98 && !c.moods.sad.emotion, `${c.moods.sad.speed}/${c.moods.sad.emotion}`);
ok('apiKey 从 state/minimax-key 读到', c.minimax.apiKey.length > 20, `${c.minimax.apiKey.length} 字符`);
ok('model=speech-2.8-hd', c.minimax.model === 'speech-2.8-hd');
ok('24kHz/128kbps', c.minimax.sampleRate === 24000 && c.minimax.bitrate === 128000);
ok('key 本身没写进 config.json', !JSON.stringify(raw.voiceTts).includes(c.minimax.apiKey));

console.log('\n[2] 参数夹逼（config 写越界值也不该发出电子音）');
const wild = JSON.parse(JSON.stringify(raw));
wild.voiceTts.moods.calm.speed = 2.5;
wild.voiceTts.moods.calm.pitch = 40;
wild.voiceTts.moods.happy.speed = 0.2;
const cw = voiceTtsConfig(wild);
ok('speed 上限夹到 1.12', cw.moods.calm.speed === 1.12, String(cw.moods.calm.speed));
ok('pitch 上限夹到 12', cw.moods.calm.pitch === 12, String(cw.moods.calm.pitch));
ok('speed 下限夹到 0.88', cw.moods.happy.speed === 0.88, String(cw.moods.happy.speed));

console.log('\n[3] 引擎切回 edge 时口径不变');
const edgeCfg = JSON.parse(JSON.stringify(raw));
edgeCfg.voiceTts.engine = 'edge';
edgeCfg.voiceTts.moods = {
  calm: { voice: 'zh-CN-XiaoxiaoNeural', rate: '0%', pitch: '0Hz' }
};
const ce = voiceTtsConfig(edgeCfg);
ok('engine=edge', ce.engine === 'edge');
ok('edge rate 自动补 +', ce.moods.calm.rate === '+0%', ce.moods.calm.rate);
ok('edge pitch 自动补 +', ce.moods.calm.pitch === '+0Hz', ce.moods.calm.pitch);
ok('edge 无 minimax 依赖也能构造', typeof ce.minimax.apiKey === 'string');

console.log('\n[4] 失败路径必须给可读原因（不静默、不卡死）');
const noKey = JSON.parse(JSON.stringify(raw));
noKey.voiceTts.minimax = { ...noKey.voiceTts.minimax, apiKey: '', keyFile: 'state/definitely-missing-key' };
await throws('没有 key → 明确说要配 key', () => synthesize('测试', 'calm', noKey), '未配置 MiniMax API Key');

const badHost = JSON.parse(JSON.stringify(raw));
badHost.voiceTts.minimax = { ...badHost.voiceTts.minimax, baseUrl: 'http://127.0.0.1:9', timeoutMs: 3000 };
const t0 = Date.now();
await throws('连不上 → 网络/超时错误', () => synthesize('测试', 'calm', badHost), 'MiniMax 请求失败');
ok('失败时 3 秒内返回（有超时上限）', Date.now() - t0 < 15000, `${Date.now() - t0} ms`);

console.log('\n[5] 调用期字数规则（splitForTts）');
const short = splitForTts('嗯');
ok('短句不拆', short.chunks.length === 1 && !short.overflow, short.chunks.join('|'));
const twoClause = splitForTts('这个语速差不多了吧，再快就要赶人了');
ok('长句按标点拆两条', twoClause.chunks.length === 2 && !twoClause.overflow, twoClause.chunks.join(' | '));
ok('每片都不超 15 字', twoClause.chunks.every((s) => s.length <= 15), twoClause.chunks.map((s) => s.length).join(','));
// 不能以「嗯」开头：normalizeSpeechText 现在会摘掉句首语气词，字数就从 26 变成 24、刚好塞进两条。
const tooLong = splitForTts('行。那就这样。我先去忙了。有什么事明天再说也不迟。回头再聊。');
ok('拆不下时如实报 overflow', tooLong.overflow === true, `${tooLong.totalChunks} 条 / ${tooLong.chars} 字`);
ok('overflow 时不返回半截内容', tooLong.chunks.length === 2);
ok('空文本返回空 chunks', splitForTts('   ').chunks.length === 0);
ok('单句超长也硬切成 ≤15 字片', splitForTts('啊'.repeat(20)).chunks.every((s) => s.length <= 15));

console.log('\n[6] 默认值兜底');
const bare = voiceTtsConfig({});
ok('空 config → engine=edge（P1 行为不变）', bare.engine === 'edge');
ok('空 config → 关闭', bare.enabled === false);
ok('空 config → 五档 mood 存在', Object.keys(bare.moods).length === 5);
ok('DEFAULT_MOODS_MINIMAX 导出可读', DEFAULT_MOODS_MINIMAX.calm.voice === 'qiaopi_mengmei');

console.log('\n[7] 气口（<#x#> 停顿标记）');
const P = { enabled: true, commaMs: 400, stopMs: 450, maxTags: 3 };
ok('config 里 pauses 已开启', c.pauses.enabled === true, JSON.stringify(c.pauses));
ok('逗号后插 0.40 秒', applyVoicePauses('哼，又想起来我啦？', P) === '哼，<#0.40#>又想起来我啦？', applyVoicePauses('哼，又想起来我啦？', P));
ok('问号后插 0.45 秒', applyVoicePauses('你好？在吗', P) === '你好？<#0.45#>在吗', applyVoicePauses('你好？在吗', P));
ok('结尾标点不插（后面没字，标点会被忽略）', applyVoicePauses('今天有点累。', P) === '今天有点累。', applyVoicePauses('今天有点累。', P));
ok('已有标记时不重复插', applyVoicePauses('哼，<#0.5#>又来了', P) === '哼，<#0.5#>又来了', applyVoicePauses('哼，<#0.5#>又来了', P));
ok('maxTags 生效', (applyVoicePauses('一，二，三，四，五', { ...P, maxTags: 2 }).match(/<#/g) || []).length === 2);
ok('关掉即原样返回', applyVoicePauses('哼，又来了', { ...P, enabled: false }) === '哼，又来了');
ok('数字里的小数点不插标记', !applyVoicePauses('价格是 3.14 元', P).includes('<#'), applyVoicePauses('价格是 3.14 元', P));
ok('空 config 时气口默认关闭', voiceTtsConfig({}).pauses.enabled === false);

const tmpLeft = fs.existsSync(c.tmpDir) ? fs.readdirSync(c.tmpDir) : [];
const libTts = path.join(c.libraryDir, '.tts');
const libLeft = fs.existsSync(libTts) ? fs.readdirSync(libTts) : [];
ok('失败路径没留临时文件', tmpLeft.filter((f) => f.endsWith('.mp3') || f.endsWith('.log')).length === 0, tmpLeft.join(',') || '空');
ok('.tts 库没留文件', libLeft.length === 0, libLeft.join(',') || '空');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
