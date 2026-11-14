// 文字 → 语音（edge-tts / MiniMax 双引擎）→ mp3（或降调后的 wav）临时文件。
//
// 引擎由 config.json 的 voiceTts.engine 决定：
//   - "edge"（默认）：本地 .venv-tts 里的 edge-tts，免费、24 kHz/48 kbps，机械感强
//   - "minimax"：MiniMax speech-2.8-hd 云端接口，32 kHz/128 kbps，音质好、按字符计费
// 切换引擎只影响「怎么合成」，mood 语义、2–60 秒夹逼、临时文件清理、失败回落全部共用。
//
// 职责只有三件（与项目计划 02-QQ语音情绪化.md 的 P1 对齐）：
//   1) synthesize(text, mood, cfg) → 合成 mp3，返回临时路径
//   2) 长度夹逼：minSeconds(默认 2) ≤ 时长 ≤ maxSeconds(默认 60)，超长截断文本重合成
//   3) 临时文件落在 cfg.voiceTts.tmpDir（默认 state/tmp/voice/），由调用方发完清理
//
// 设计要点：
// - **不依赖 ffprobe**：本机没有 ffprobe/ffmpeg，桥接的 inspectAudio 在探测失败时只告警。
//   这里自己解析 MP3 帧头算时长（edge-tts 输出是 MPEG2 Layer III 48 kbps / 24 kHz 单声道，
//   无 ID3 头，但解析器同时兼容 ID3v2 与 MPEG1/2/2.5）。
// - 子进程 stdio 不用 pipe：受限沙箱（DSH workspace-write）里 spawn 带 pipe 的子进程会 EPERM。
//   这里 stdout/stderr 都重定向到日志文件，失败时读日志拼错误信息。
// - 声线/语速/音高**表驱动**：默认值内置一份，config.json 的 voiceTts.moods 覆盖（按 mood 合并）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BRIDGE_ROOT = path.resolve(__dirname, '..');
export const WORKSPACE_ROOT = path.resolve(BRIDGE_ROOT, '..');

/** 五档情绪的默认声线（项目计划里的映射表；config.json 可按 mood 覆盖单项）。 */
// 注意 rate/pitch 的符号：edge-tts 只接受带符号的形式（`^[+-]\d+%$` / `^[+-]\d+Hz$`），
// 写 "0%" / "0Hz" 会直接 ValueError，所以零值也要带 "+"。
export const DEFAULT_MOODS = {
  calm: { voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', pitch: '+0Hz' },
  happy: { voice: 'zh-CN-XiaoyiNeural', rate: '+12%', pitch: '+6Hz' },
  shy: { voice: 'zh-CN-XiaoyiNeural', rate: '-6%', pitch: '+2Hz' },
  annoyed: { voice: 'zh-CN-YunxiNeural', rate: '+8%', pitch: '-4Hz' },
  sad: { voice: 'zh-CN-XiaoxiaoNeural', rate: '-15%', pitch: '-8Hz' }
};

const MOOD_LABELS = { calm: '平静', happy: '开心', shy: '害羞', annoyed: '恼火', sad: '失落' };

/**
 * MiniMax 的五档参数（02b 方案 4.4 节，2026-10-23 按听感收敛过）。
 * 关键：五档全部同一个音色 qiaopi_mengmei —— 音色跳变会拆掉「同一个人的声音」这个人设底层认知。
 * 音高一律 0：QQ 语音条落盘是 .amr（服务端必过 SILK/AMR 窄带转码），转码会把抬高的音高
 * 放大成一耳朵的「尖」（实测 pitch +2 就被吐槽），所以情绪只靠语速与少量 emotion 做，
 * 不再靠抬音高。语速 1.08 是用户盲听后选定的基准，其余四档在它上下 ±0.06 内微调。
 * emotion 只在真正开心的 happy 与真正低落的 sad 上显式传：speech-2.8-hd 自带情绪推理，
 * 不传反而更自然；而 annoyed 的傲娇气质靠「平」不靠「怒」，硬加 emotion 会变甜腻。
 */
export const DEFAULT_MOODS_MINIMAX = {
  calm: { voice: 'qiaopi_mengmei', speed: 1.08, pitch: 0 },
  happy: { voice: 'qiaopi_mengmei', speed: 1.1, pitch: 0, emotion: 'happy' },
  shy: { voice: 'qiaopi_mengmei', speed: 1.06, pitch: 0 },
  annoyed: { voice: 'qiaopi_mengmei', speed: 1.1, pitch: 0 },
  sad: { voice: 'qiaopi_mengmei', speed: 1.02, pitch: -2, emotion: 'sad' }
};

// MiniMax 的 speed/pitch 是线性拉伸：1.12 以上开始出电子感，±3 以上开始不像本人。
const SPEED_MIN = 0.88;
const SPEED_MAX = 1.12;
const PITCH_MIN = -12;
const PITCH_MAX = 12;

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampSpeed(value, fallback = 1) {
  return Math.round(clampNumber(value, fallback, SPEED_MIN, SPEED_MAX) * 100) / 100;
}

function clampPitch(value, fallback = 0) {
  return Math.round(clampNumber(value, fallback, PITCH_MIN, PITCH_MAX));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1002 = rate limit（RPM）。2026-10-24 实测连发 7 条被限流，拆两条语音时第二条有概率撞上。
const MINIMAX_RETRY_ATTEMPTS = 3;

/** MiniMax 允许 apiKey 直接写在 config，但默认走 keyFile（state/minimax-key），避免 key 随 config 备份扩散。 */
function resolveApiKey(mm = {}) {
  const direct = String(mm.apiKey ?? '').trim();
  if (direct) return direct;
  const file = mm.keyFile ? resolveFromBridge(String(mm.keyFile)) : path.join(BRIDGE_ROOT, 'state', 'minimax-key');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function normalizeMinimaxMood(override, base = DEFAULT_MOODS_MINIMAX.calm) {
  const o = override && typeof override === 'object' ? override : {};
  const hasEmotion = Object.prototype.hasOwnProperty.call(o, 'emotion');
  const emotion = hasEmotion ? (o.emotion ? String(o.emotion) : null) : (base.emotion ?? null);
  return {
    // 音色认不出是 MiniMax 的（比如还留着 zh-CN-XiaoxiaoNeural）就回落默认，不然接口报 voice_id 无效
    voice: isMinimaxVoice(o.voice) ? String(o.voice) : base.voice,
    speed: clampSpeed(o.speed ?? base.speed ?? 1),
    pitch: clampPitch(o.pitch ?? base.pitch ?? 0),
    emotion
  };
}

// edge 的 voice 形如 zh-CN-XiaoxiaoNeural（带大写语言区段），MiniMax 的形如 qiaopi_mengmei（小写下划线）。
// 两个引擎的 moods 是各自一套参数，切引擎时 config 里混着对方的字段很常见，
// 认不出就回落该引擎的默认值，绝不把 qiaopi_mengmei 递给 edge-tts（它会直接 traceback）。
const EDGE_VOICE_RE = /^[a-z]{2,3}-[A-Z]{2,3}-/;

function isEdgeVoice(value) {
  return EDGE_VOICE_RE.test(String(value ?? ''));
}

function isMinimaxVoice(value) {
  const v = String(value ?? '');
  return Boolean(v) && !isEdgeVoice(v) && /^[A-Za-z0-9_-]+$/.test(v);
}

function normalizeEdgeMood(override, base = DEFAULT_MOODS.calm) {
  const o = override && typeof override === 'object' ? override : {};
  const rateRaw = String(o.rate ?? '');
  const pitchRaw = String(o.pitch ?? '');
  return {
    voice: isEdgeVoice(o.voice) ? String(o.voice) : base.voice,
    // edge 的 rate/pitch 必须带单位，数值型（MiniMax 的 1.04 / 2）一律视为不适用
    rate: /%$/.test(rateRaw) ? signedParam(rateRaw, '%', base.rate) : base.rate,
    pitch: /Hz$/i.test(pitchRaw) ? signedParam(pitchRaw, 'Hz', base.pitch) : base.pitch
  };
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** edge-tts 只认带符号的 rate/pitch；把 "0%"、"5%" 这类手写值补上 "+"。 */
function signedParam(value, unit, fallback) {
  const s = String(value ?? '').trim();
  if (!s) return fallback;
  const m = /^([+-]?)(\d+(?:\.\d+)?)$/.exec(s.replace(new RegExp(`${unit}$`, 'i'), ''));
  if (!m) return s;
  const sign = m[1] === '-' ? '-' : '+';
  return `${sign}${m[2]}${unit}`;
}

function resolveFromBridge(p) {
  return path.isAbsolute(p) ? p : path.resolve(BRIDGE_ROOT, p);
}

/**
 * 归一化配置：缺失项一律回落默认值，绝不因为 config 里少写一个字段就抛错。
 * @param {object} cfg 整份 config.json 对象
 */
/** 降调后处理（默认关）。QQ 端 SILK 转码对 ≤6 kHz 几乎无损，后处理里只有「整体降调」有效。 */
export const DEFAULT_PITCH_SHIFT = { enabled: false, semitones: -2, formantAlpha: 1 };

function normalizePitchShift(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: r.enabled === true,
    // 范围收窄到 ±6 半音：再深就会明显不像本人（共振峰下移过头）
    semitones: Math.round(clampNumber(r.semitones, DEFAULT_PITCH_SHIFT.semitones, -6, 6) * 10) / 10,
    // 保共振峰强度：0 = 纯重采样（闷、电子），1 = 共振峰完全回到原位
    formantAlpha: Math.round(clampNumber(r.formantAlpha, DEFAULT_PITCH_SHIFT.formantAlpha, 0, 1.5) * 100) / 100
  };
}

export function voiceTtsConfig(cfg = {}) {
  const t = cfg.voiceTts && typeof cfg.voiceTts === 'object' ? cfg.voiceTts : {};
  const engine = t.engine === 'minimax' ? 'minimax' : 'edge';
  const mm = t.minimax && typeof t.minimax === 'object' ? t.minimax : {};
  const exeDefault = path.join(WORKSPACE_ROOT, '.venv-tts', 'Scripts', process.platform === 'win32' ? 'edge-tts.exe' : 'edge-tts');
  // 全局默认音色（voiceTts.minimax.voice）：克隆音色只在这里写一次，五档 mood 全部继承，
  // 免得某个 mood 漏写 voice 时回落到 DEFAULT_MOODS_MINIMAX 里的平台角色音色——
  // 那种音色自带「御姐/萌妹」人设，会跟角色卡打架（2026-11-08 用户：不要让音色来源的人设反向污染角色卡）。
  const globalVoice = isMinimaxVoice(mm.voice) ? String(mm.voice) : null;
  const defaults = engine === 'minimax'
    ? Object.fromEntries(Object.entries(DEFAULT_MOODS_MINIMAX).map(([name, m]) => [name, globalVoice ? { ...m, voice: globalVoice } : m]))
    : DEFAULT_MOODS;
  const moods = {};
  for (const [name, base] of Object.entries(defaults)) {
    const override = t.moods && typeof t.moods === 'object' ? t.moods[name] : null;
    moods[name] = engine === 'minimax'
      ? normalizeMinimaxMood(override, base)
      : normalizeEdgeMood(override, base);
  }
  // config 里额外自定义的 mood 也收进来（模型可以传自定义名），默认项不受影响。
  if (t.moods && typeof t.moods === 'object') {
    for (const [name, m] of Object.entries(t.moods)) {
      if (moods[name] || !m || typeof m !== 'object') continue;
      const base = engine === 'minimax'
        ? (globalVoice ? { ...DEFAULT_MOODS_MINIMAX.calm, voice: globalVoice } : DEFAULT_MOODS_MINIMAX.calm)
        : DEFAULT_MOODS.calm;
      const normalized = engine === 'minimax' ? normalizeMinimaxMood(m, base) : normalizeEdgeMood(m, base);
      // 自定义 mood 至少得有一个引擎认得出的音色，否则当作手滑忽略掉
      if (normalized.voice) moods[name] = normalized;
    }
  }
  return {
    enabled: t.enabled === true,
    engine,
    exe: t.exe ? resolveFromBridge(String(t.exe)) : exeDefault,
    tmpDir: t.tmpDir ? resolveFromBridge(String(t.tmpDir)) : path.join(BRIDGE_ROOT, 'state', 'tmp', 'voice'),
    // 语音库目录与 bridge.js 的 voiceCfg() 保持同一口径：相对 qq-bridge 解析
    libraryDir: path.resolve(BRIDGE_ROOT, String(cfg.socialV2?.voice?.dir ?? 'audio')),
    minSeconds: positiveNumber(t.minSeconds, 2),
    maxSeconds: positiveNumber(t.maxSeconds, 60),
    timeoutMs: positiveNumber(t.timeoutMs, 90000),
    maxChars: Math.round(positiveNumber(t.maxChars, 400)),
    // 单条语音条的字数上限（send_tts_voice 拆条用）。中文 15 字≈3 秒；日语假名视觉占位宽、
    // 信息密度低，15 字常常只够半句，所以由 config 调到 24（2026-11-08 改日语语音条）。
    splitChars: Math.max(4, Math.min(60, Math.round(positiveNumber(t.splitChars, 15)))),
    pauses: normalizePauses(t.pauses),
    pitchShift: normalizePitchShift(t.pitchShift),
    moods,
    minimax: {
      baseUrl: String(mm.baseUrl ?? 'https://api.minimax.chat').replace(/\/+$/, ''),
      model: String(mm.model ?? 'speech-2.8-hd'),
      apiKey: resolveApiKey(mm),
      // 全局音色与语言：voice 为空时退回 DEFAULT_MOODS_MINIMAX 的 voice。
      // language 直传 MiniMax 的 language_boost（"Japanese" / "Chinese" / "auto" ...），
      // 留空则不传，交给模型自己判断（混合语种文本会因此读错，日语专用音色建议显式写死）。
      voice: globalVoice ?? DEFAULT_MOODS_MINIMAX.calm.voice,
      language: String(mm.language ?? '').trim(),
      // 24k 是 2026-10-23 盲听定档（16k 闷、32k 与 24k 几乎听不出差别，见 02b 9.5）
      sampleRate: positiveNumber(mm.sampleRate, 24000),
      bitrate: positiveNumber(mm.bitrate, 128000),
      timeoutMs: positiveNumber(mm.timeoutMs, 30000)
    }
  };
}

export function moodLabel(mood) {
  return MOOD_LABELS[mood] ?? String(mood ?? 'calm');
}

// ── MP3 帧解析算时长（不依赖 ffprobe/ffmpeg） ─────────────────────────────────

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

/**
 * 解析 MP3 的时长。
 * @returns {{seconds:number, frames:number, sampleRate:number, bitrateKbps:number, layer:number}|null}
 *   解析不出任何完整帧时返回 null（调用方据此报错，而不是把 0 秒当成功）。
 */
export function mp3Duration(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  let i = 0;
  // 跳过 ID3v2 头（syncsafe 长度）
  if (buffer.length >= 10 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    i = 10 + size;
  }
  let seconds = 0;
  let frames = 0;
  let sampleRate = 0;
  let bitrateKbps = 0;
  let layer = 0;
  while (i + 4 <= buffer.length) {
    if (buffer[i] !== 0xff || (buffer[i + 1] & 0xe0) !== 0xe0) break;
    const verBits = (buffer[i + 1] >> 3) & 0x03;
    const layerBits = (buffer[i + 1] >> 1) & 0x03;
    const version = verBits === 3 ? 1 : verBits === 2 ? 2 : verBits === 0 ? 2.5 : null;
    const layerNum = layerBits === 3 ? 1 : layerBits === 2 ? 2 : layerBits === 1 ? 3 : null;
    if (!version || !layerNum) break;
    const brIndex = (buffer[i + 2] >> 4) & 0x0f;
    const srIndex = (buffer[i + 2] >> 2) & 0x03;
    const padding = (buffer[i + 2] >> 1) & 0x01;
    const br = (version === 1 ? BITRATES_V1 : BITRATES_V2)[brIndex];
    const sr = SAMPLE_RATES[version][srIndex];
    if (!br || !sr) break;
    const samplesPerFrame = layerNum === 1 ? 384 : version === 1 ? 1152 : 576;
    const coef = layerNum === 1 ? 144 : version === 1 ? 144 : 72;
    const frameBytes = Math.floor((coef * br * 1000) / sr) + padding;
    if (frameBytes <= 0) break;
    seconds += samplesPerFrame / sr;
    frames += 1;
    sampleRate = sr;
    bitrateKbps = br;
    layer = layerNum;
    i += frameBytes;
  }
  if (!frames) return null;
  return { seconds: Math.round(seconds * 1000) / 1000, frames, sampleRate, bitrateKbps, layer };
}

export function mp3DurationOfFile(file) {
  try {
    return mp3Duration(fs.readFileSync(file));
  } catch {
    return null;
  }
}

// ── WAV 读写 + 重采样降调 ─────────────────────────────────────────────────────
//
// 为什么自己写：本机没有 ffmpeg/ffprobe，桥接的 inspectAudio 只能告警；而 MiniMax 的
// `voice_setting.pitch` 在本音色上实测无效（见报告 §9.7），`qiaopi_mengmei` 又偏薄亮
// （F0 中位 300–312 Hz），用户听感是「有尖、往上顶」。唯一能真降调的路径是音频后处理。
//
// 选「重采样」不选「相位声码器 / WSOLA」：相位声码器纯 numpy/JS 实现在 24 kHz 语音上
// 一致性差（实测掉 30% 能量、谱糊），WSOLA 会在帧间拼接产生梳状伪影（200 Hz 单音试
// 验里 178.16 Hz 被抬到 196.8 Hz）。重采样是唯一数学上干净的做法：音高与共振峰一起
// 下移 ⇒ 音色变暖变暗，正是要消掉的「尖」。
//
// 代价是时长变长 ×1/p。为了时长不变，合成阶段先让引擎快 p 倍（÷p），再重采样 ×1/p 补回。

/** 解析 24 kHz/16 bit PCM WAV（MiniMax 返回的就是这个格式）。 */
export function wavInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt = null;
  while (off + 8 <= buffer.length) {
    const id = buffer.toString('latin1', off, off + 4);
    const size = buffer.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14)
      };
    } else if (id === 'data') {
      const end = Math.min(buffer.length, body + size);
      const bytes = end - body;
      if (!fmt || !fmt.sampleRate) return null;
      const frameBytes = Math.max(1, (fmt.bitsPerSample / 8) * Math.max(1, fmt.channels));
      const frames = Math.floor(bytes / frameBytes);
      return {
        ...fmt,
        dataOffset: body,
        dataBytes: bytes,
        frames,
        seconds: Math.round((frames / fmt.sampleRate) * 1000) / 1000
      };
    }
    off = body + size + (size % 2); // RIFF 块按偶数对齐
  }
  return null;
}

export function wavDurationOfFile(file) {
  try {
    return wavInfo(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/**
 * 重采样降调：音高 ×p（p=2^(semitones/12)），时长 ×1/p。
 * 用 Catmull-Rom 三次插值（线性插值会在 6 kHz 以上明显损失亮度，而 QQ 的 SILK 链路
 * 本来就把 6 kHz 以上丢光，所以两者在 QQ 上的差别很小；三次插值只是让本地试听不失真）。
 *
 * 第 2 步可选的保共振峰：重采样会把共振峰一起压低 p 倍，听感就是「闷、空、电子」。
 * 用原信号的谱包络把共振峰按回原位（增益 G(f)=包络原声(f)/包络降调后(f)），
 * 基频仍然是降调后的位置。formantAlpha=0 退回旧行为，1 为完全校正。
 */
export function pitchShiftWav(buffer, semitones, options = {}) {
  const info = wavInfo(buffer);
  if (!info) throw new Error('不是可解析的 WAV（需要 RIFF/WAVE PCM）');
  if (!Number.isFinite(semitones) || Math.abs(semitones) < 0.01) return { buffer, info, semitones: 0 };
  const p = 2 ** (semitones / 12);
  const stretch = 1 / p; // >1 表示拉长（降调）
  const channels = Math.max(1, info.channels);
  const bits = info.bitsPerSample || 16;
  if (bits !== 16) throw new Error(`只支持 16 bit PCM WAV（收到 ${bits} bit）`);
  const frames = info.frames;
  const nOut = Math.max(1, Math.round(frames * stretch));
  const src = buffer.subarray(info.dataOffset, info.dataOffset + info.dataBytes);
  const out = Buffer.alloc(nOut * channels * 2);
  const step = frames / nOut; // 采样位置步长（<1 表示降调拉伸时从更密的源位置取点）
  const clampIdx = (i) => (i < 0 ? 0 : i >= frames ? frames - 1 : i);
  const srcCh = [];
  for (let ch = 0; ch < channels; ch += 1) {
    srcCh.push((i) => src.readInt16LE((clampIdx(i) * channels + ch) * 2) / 32768);
  }
  const alpha = Number.isFinite(options.formantAlpha) ? Math.max(0, Math.min(1.5, options.formantAlpha)) : 0;
  for (let ch = 0; ch < channels; ch += 1) {
    const read = srcCh[ch];
    const resampled = new Float32Array(nOut);
    let rmsIn = 0;
    let rmsOut = 0;
    for (let i = 0; i < nOut; i += 1) {
      const pos = i * step;
      const i1 = Math.floor(pos);
      const t = pos - i1;
      const p0 = read(i1 - 1);
      const p1 = read(i1);
      const p2 = read(i1 + 1);
      const p3 = read(i1 + 2);
      // Catmull-Rom
      const v = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
      resampled[i] = Math.max(-1, Math.min(1, v));
      rmsOut += v * v;
    }
    for (let i = 0; i < frames; i += 1) {
      const v = read(i);
      rmsIn += v * v;
    }
    const shifted = alpha > 0 ? formantPreserve(resampled, p, alpha, read, frames) : resampled;
    const rIn = Math.sqrt(rmsIn / Math.max(1, frames));
    const rOut = Math.sqrt(rmsOut / Math.max(1, nOut));
    const scale = rOut > 1e-9 && alpha > 0 ? rIn / rOut : 1;
    for (let i = 0; i < nOut; i += 1) {
      const v = Math.max(-1, Math.min(1, shifted[i] * (alpha > 0 ? scale : 1)));
      out.writeInt16LE(Math.round(v * 32767), (i * channels + ch) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + out.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(info.sampleRate, 24);
  header.writeUInt32LE(info.sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(out.length, 40);
  const shifted = Buffer.concat([header, out]);
  return { buffer: shifted, info: wavInfo(shifted), sourceInfo: info, semitones, ratio: p, formantAlpha: alpha };
}

// ── 保共振峰的谱包络校正（纯 JS，无依赖）────────────────────────────────────────
const FP_NFFT = 1024;
const FP_HOP = 256;
const FP_LIFTER = 48;
const FP_CLIP_DB = 9;

function fpFft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** 帧化：返回 [起始帧数组]，窗口为汉宁窗，75% 重叠，两端补零。 */
function fpFrameOffsets(len) {
  const starts = [];
  for (let s = 0; s + FP_NFFT <= len; s += FP_HOP) starts.push(s);
  return starts;
}

const FP_WIN = (() => {
  const w = new Float64Array(FP_NFFT);
  for (let i = 0; i < FP_NFFT; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FP_NFFT);
  return w;
})();

/** 一帧的倒谱包络（线性幅度），入参是实信号帧。 */
function fpEnvelope(frame, re, im) {
  for (let i = 0; i < FP_NFFT; i += 1) {
    re[i] = frame[i] * FP_WIN[i];
    im[i] = 0;
  }
  fpFft(re, im);
  for (let i = 0; i < FP_NFFT; i += 1) {
    re[i] = Math.log(Math.max(Math.hypot(re[i], im[i]), 1e-9));
    im[i] = 0;
  }
  // 逆变换得到倒谱
  for (let i = 0; i < FP_NFFT; i += 1) im[i] = -im[i];
  fpFft(re, im);
  const ce = new Float64Array(FP_NFFT);
  for (let i = 0; i < FP_NFFT; i += 1) ce[i] = re[i] / FP_NFFT;
  // 低通 lifter
  for (let i = FP_LIFTER; i < FP_NFFT - FP_LIFTER + 1; i += 1) ce[i] = 0;
  const ere = new Float64Array(FP_NFFT);
  const eim = new Float64Array(FP_NFFT);
  for (let i = 0; i < FP_NFFT; i += 1) { ere[i] = ce[i]; eim[i] = 0; }
  fpFft(ere, eim);
  const env = new Float64Array(FP_NFFT);
  for (let i = 0; i < FP_NFFT; i += 1) env[i] = Math.exp(ere[i]);
  return env;
}

function formantPreserve(signal, p, alpha, srcRead, srcFrames) {
  const n = signal.length;
  const starts = fpFrameOffsets(n);
  if (!starts.length) return signal;
  const pad = FP_NFFT;
  const y = new Float64Array(n + 2 * pad);
  y.set(signal, pad);
  const acc = new Float64Array(n + 2 * pad);
  const re = new Float64Array(FP_NFFT);
  const im = new Float64Array(FP_NFFT);
  const gre = new Float64Array(FP_NFFT);
  const gim = new Float64Array(FP_NFFT);
  const frame = new Float64Array(FP_NFFT);
  const clipHi = 10 ** (FP_CLIP_DB / 20);
  const clipLo = 1 / clipHi;
  const ratio = n / Math.max(1, srcFrames);
  const srcWin = new Float64Array(FP_NFFT);
  const prevGain = new Float64Array(FP_NFFT).fill(1);

  for (let fi = 0; fi < starts.length; fi += 1) {
    const s = starts[fi] + pad;
    for (let i = 0; i < FP_NFFT; i += 1) frame[i] = y[s + i];
    const envNow = fpEnvelope(frame, re, im);
    // 对应原信号的帧（原时间轴 = y 时间轴 × 1/ratio 的倒数，即 t_x = t_y / ratio）
    const tSrc = (starts[fi] / ratio);
    const j = Math.round(tSrc / FP_HOP) * FP_HOP;
    for (let i = 0; i < FP_NFFT; i += 1) {
      const k = Math.max(0, Math.min(srcFrames - 1, j + i - FP_NFFT / 2));
      srcWin[i] = srcRead(k);
    }
    const envTarget = fpEnvelope(srcWin, gre, gim);
    const gain = new Float64Array(FP_NFFT);
    for (let i = 0; i < FP_NFFT; i += 1) {
      let g = (envTarget[i] / Math.max(envNow[i], 1e-9)) ** alpha;
      if (g > clipHi) g = clipHi;
      if (g < clipLo) g = clipLo;
      // 帧间平滑，避免逐帧跳变产生金属感
      g = 0.35 * prevGain[i] + 0.65 * g;
      prevGain[i] = g;
      gain[i] = g;
    }
    // 在频率轴上再平滑一次
    for (let i = 1; i < FP_NFFT - 1; i += 1) {
      gain[i] = (gain[i - 1] + gain[i] + gain[i + 1]) / 3;
    }
    // 乘到该帧的短时频谱上（窗已在 fpEnvelope 里做过，这里重算一次）
    for (let i = 0; i < FP_NFFT; i += 1) { re[i] = frame[i] * FP_WIN[i]; im[i] = 0; }
    fpFft(re, im);
    for (let i = 0; i < FP_NFFT; i += 1) {
      re[i] *= gain[i];
      im[i] *= gain[i];
    }
    for (let i = 0; i < FP_NFFT; i += 1) im[i] = -im[i];
    fpFft(re, im);
    for (let i = 0; i < FP_NFFT; i += 1) {
      acc[s + i] += (re[i] / FP_NFFT) * FP_WIN[i];
    }
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = acc[pad + i];
  return out;
}

// ── 文本归一化 ────────────────────────────────────────────────────────────────

/** 清掉会让命令行/SSML 出问题的字符，压掉多余空白；空文本返回 ''。 */
export function normalizeSpeechText(text, maxChars = 400) {
  const raw = String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // 句首语气词（嗯/呃/额/诶/哦/喔）连后面的标点一起去掉：模型爱拿它开场，语音里连着几条
  // 都以「嗯，」起头会显得敷衍（用户 2026-10-26 实测反馈）。后面至少还剩 2 个字才删，
  // 否则单字「嗯」会被削成空串、直接合成失败。
  const stripped = raw.replace(/^(?:嗯+|呃+|额+|诶+|哦+|喔+)[，,、：:。．.！!？?…\s]*/, '');
  const out = stripped.length >= 2 ? stripped.trim() : raw;
  if (out.length <= maxChars) return out;
  // 截断优先落在标点上，读起来不突兀
  const head = out.slice(0, maxChars);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('\n'));
  return (cut > maxChars * 0.6 ? head.slice(0, cut + 1) : head).trim();
}

// ── 气口：按标点插 MiniMax 的 <#x#> 停顿标记 ─────────────────────────────────

/**
 * 默认气口（2026-10-24 按试听包 02 定档）。
 * <#x#> 是「真停顿」：实测逗号后 0.8 秒 → 音频时长 +1.15 秒，<#2.0#> → +2.18 秒。
 * 它比压 speed 更像真人换气（speed 越 1.12 就出电子感），是当前唯一能直接削弱
 * 「念稿感」的参数。关掉只需 config.json 里 voiceTts.pauses.enabled = false。
 */
export const DEFAULT_PAUSES = { enabled: false, commaMs: 400, stopMs: 450, maxTags: 3 };

const PAUSE_COMMA_RE = /[，,、；;]/;
const PAUSE_STOP_RE = /[。！？!?…]/;

/** config 里的 pauses 一律夹到安全范围，写错值不会让语音碎成一字一顿。 */
function normalizePauses(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: p.enabled === true,
    commaMs: Math.round(clampNumber(p.commaMs, DEFAULT_PAUSES.commaMs, 0, 3000)),
    stopMs: Math.round(clampNumber(p.stopMs, DEFAULT_PAUSES.stopMs, 0, 3000)),
    maxTags: Math.round(clampNumber(p.maxTags, DEFAULT_PAUSES.maxTags, 0, 10))
  };
}

/**
 * 在标点后插入 <#x#> 停顿标记。
 * 三条硬约束（文档 + 实测）：结尾标点不插（后面没字，标记被忽略）；两个标记之间
 * 必须有字（连续的 <#x#> 会被丢掉，所以遇到已有标记就跳过）；单条最多 maxTags 个。
 * @param {string} text 已归一化的文本
 * @param {{enabled?:boolean, commaMs?:number, stopMs?:number, maxTags?:number}} pauses
 */
export function applyVoicePauses(text, pauses = {}) {
  const p = { ...DEFAULT_PAUSES, ...(pauses && typeof pauses === 'object' ? pauses : {}) };
  const src = String(text ?? '');
  if (p.enabled !== true || !src) return src;
  const maxTags = Math.max(0, Math.round(Number(p.maxTags) || 0));
  const out = [];
  let tags = 0;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    out.push(ch);
    if (tags >= maxTags) continue;
    const isStop = PAUSE_STOP_RE.test(ch);
    if (!isStop && !PAUSE_COMMA_RE.test(ch)) continue;
    let j = i + 1;
    while (j < src.length && /\s/.test(src[j])) { out.push(src[j]); j += 1; }
    if (j >= src.length) { i = j - 1; continue; }      // 结尾标点，不插
    if (src[j] === '<') { i = j - 1; continue; }        // 已经有标记，不重复插
    const ms = isStop ? Number(p.stopMs) : Number(p.commaMs);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    out.push(`<#${(ms / 1000).toFixed(2)}#>`);
    tags += 1;
    i = j - 1;
  }
  return out.join('');
}

// ── 拆条：一句话超过单条字数上限时按标点切成多条语音 ─────────────────────────

export const DEFAULT_MAX_CHARS_PER_VOICE = 15;
export const DEFAULT_MAX_CHUNKS = 2;

/**
 * 把要说的话切成适合当语音条的若干段。
 *
 * 规则（与 send_tts_voice 的描述一致）：单条 1–15 字最自然；超了就按标点切成
 * 最多 `maxChunks` 条，让模型一次调用发两小句，而不是念一段长稿。
 * 切不下（需要超过 maxChunks 条）时不截断内容，返回 overflow=true 由调用方决定
 * 是提醒改用文字还是只发前两段——这里只负责如实报告。
 *
 * @param {string} text 原始文本
 * @param {number} maxChars 单条字数上限（默认 15）
 * @param {number} maxChunks 最多几条（默认 2）
 * @returns {{chunks:string[], chars:number, overflow:boolean, totalChunks:number}}
 */
export function splitForTts(text, maxChars = DEFAULT_MAX_CHARS_PER_VOICE, maxChunks = DEFAULT_MAX_CHUNKS) {
  const norm = normalizeSpeechText(text, 1000);
  if (!norm) return { chunks: [], chars: 0, overflow: false, totalChunks: 0 };
  if (norm.length <= maxChars) return { chunks: [norm], chars: norm.length, overflow: false, totalChunks: 1 };
  // 先按标点/空白切句，超长句再硬切，保证每片都不超上限
  const pieces = [];
  for (const clause of norm.split(/(?<=[。！？!?；;，,、…~～\s])/).map((s) => s.trim()).filter(Boolean)) {
    if (clause.length <= maxChars) {
      pieces.push(clause);
      continue;
    }
    for (let i = 0; i < clause.length; i += maxChars) pieces.push(clause.slice(i, i + maxChars));
  }
  const chunks = [];
  let cur = '';
  for (const piece of pieces) {
    if (!cur) {
      cur = piece;
    } else if ((cur + piece).length <= maxChars) {
      cur += piece;
    } else {
      chunks.push(cur);
      cur = piece;
    }
  }
  if (cur) chunks.push(cur);
  return {
    chunks: chunks.slice(0, maxChunks),
    chars: norm.length,
    overflow: chunks.length > maxChunks,
    totalChunks: chunks.length
  };
}

/** edge-tts 的 rate 字符串 ↔ 百分数。 */
function parseRatePct(rate) {
  const m = /^([+-]?\d+(?:\.\d+)?)%$/.exec(String(rate ?? '').trim());
  return m ? Number(m[1]) : 0;
}

function formatRatePct(pct) {
  const v = Math.round(pct);
  return `${v >= 0 ? '+' : ''}${v}%`;
}

// ── 子进程：跑 edge-tts ───────────────────────────────────────────────────────

function runEdgeTts({ exe, args, timeoutMs, logFile }) {
  return new Promise((resolve, reject) => {
    let fd = null;
    try {
      fd = fs.openSync(logFile, 'w');
    } catch (error) {
      reject(new Error(`无法创建合成日志 ${logFile}：${error?.message ?? error}`));
      return;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(fd); } catch {}
      fn(value);
    };
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', fd, fd] });
    } catch (error) {
      finish(reject, new Error(`edge-tts 启动失败（${exe}）：${error?.message ?? error}`));
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(reject, new Error(`edge-tts 合成超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      finish(reject, new Error(`edge-tts 不可用（${exe}）：${error?.message ?? error}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(resolve, { code });
    });
  });
}

function readLogTail(logFile, maxChars = 600) {
  try {
    const text = fs.readFileSync(logFile, 'utf8').trim();
    if (!text) return '';
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return '';
  }
}

// ── MiniMax 合成（云端 HTTP，无子进程）────────────────────────────────────────

/**
 * 调 MiniMax t2a_v2 合成，返回 mp3 Buffer。
 * 失败一律 throw（带上可读原因），由 synthesize() 清文件、由工具层回落成文字。
 */
export async function synthMinimax(text, m, c, format = 'mp3') {
  const mm = c.minimax;
  if (!mm.apiKey) {
    throw new Error('未配置 MiniMax API Key（把 key 写到 qq-bridge/state/minimax-key，或配 config.json 的 voiceTts.minimax.keyFile）');
  }
  const voiceSetting = {
    voice_id: m.voice,
    speed: clampSpeed(m.speed ?? 1),
    vol: 1.0,
    pitch: clampPitch(m.pitch ?? 0)
  };
  // 不传 emotion 是有意为之：2.8-hd 会自己从文本推理语气，显式传是覆盖它。
  if (m.emotion) voiceSetting.emotion = String(m.emotion);
  const payload = {
    model: mm.model,
    text,
    stream: false,
    voice_setting: voiceSetting,
    audio_setting: { sample_rate: mm.sampleRate, bitrate: mm.bitrate, format, channel: 1 }
  };
  // 克隆音色「看名字认不出语言」，不指定 language_boost 时模型会按音色来源猜，
  // 中文回复 + 日语音色会读成奇怪的混读（实测「明日も」被读成「足も」）。
  // 由 voiceTts.minimax.language 统一指定，空值不传，保持原来交给模型自己判断的行为。
  if (mm.language) payload.language_boost = mm.language;
  let json = null;
  for (let attempt = 1; ; attempt += 1) {
    let res;
    try {
      res = await fetch(`${mm.baseUrl}/v1/t2a_v2`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${mm.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(mm.timeoutMs)
      });
    } catch (error) {
      throw new Error(`MiniMax 请求失败（网络或超时）：${error?.message ?? error}`);
    }
    if (!res.ok) throw new Error(`MiniMax HTTP ${res.status}${res.status === 401 ? '（API Key 无效）' : ''}`);
    try { json = await res.json(); } catch { json = null; }
    const code = json?.base_resp?.status_code;
    if (code === 0) break;
    // RPM 限流是可重试的：sendBurst / 拆两条连发时会撞上，直接回落成文字太亏。
    const msg = String(json?.base_resp?.status_msg ?? '');
    const retryable = code === 1002 || /rate limit|rpm|tpm|too many/i.test(msg);
    if (!retryable || attempt >= MINIMAX_RETRY_ATTEMPTS) {
      throw new Error(`MiniMax 合成失败 ${code ?? '?'}：${msg || '未返回 base_resp（检查 Key/模型名/额度）'}`);
    }
    await sleep(1000 * attempt);
  }
  const audio = String(json?.data?.audio ?? '');
  if (!audio) throw new Error('MiniMax 返回空音频（检查文本长度/字符）');
  // 官方返回十六进制；兼容个别网关给 base64 的情况。
  const buf = /^[0-9a-fA-F]+$/.test(audio) && audio.length % 2 === 0
    ? Buffer.from(audio, 'hex')
    : Buffer.from(audio, 'base64');
  if (!buf.length) throw new Error('MiniMax 音频解码为空');
  return buf;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

/**
 * 把文本合成为 mp3。
 *
 * @param {string} text 要说的内容
 * @param {string} mood 情绪档（默认 calm；未知值回落到 calm 并在返回值里标注）
 * @param {object} cfg 整份 config.json
 * @returns {Promise<{filePath:string, seconds:number, bytes:number, mood:string, voice:string,
 *   rate:string, pitch:string, spokenText:string, attempts:number, warnings:string[]}>}
 */
export async function synthesize(text, mood, cfg = {}) {
  const c = voiceTtsConfig(cfg);
  if (!c.enabled) throw new Error('语音合成未启用：config.json 的 voiceTts.enabled 为 false（改完需重启桥接）');
  const warnings = [];
  const moodIn = String(mood ?? 'calm').trim() || 'calm';
  const moodUsed = c.moods[moodIn] ? moodIn : 'calm';
  if (moodUsed !== moodIn) warnings.push(`未知情绪「${moodIn}」，已回落 calm`);
  const m = c.moods[moodUsed];
  let spoken = normalizeSpeechText(text, c.maxChars);
  if (!spoken) throw new Error('要合成的文字为空');
  if (c.engine !== 'minimax' && !fs.existsSync(c.exe)) {
    throw new Error(`找不到 edge-tts：${c.exe}（先在工作区根执行 .\\.venv-tts\\Scripts\\python.exe -m pip install edge-tts，或改 config.json 的 voiceTts.exe；也可以把 voiceTts.engine 改成 "minimax"）`);
  }
  fs.mkdirSync(c.tmpDir, { recursive: true });
  fs.mkdirSync(c.libraryDir, { recursive: true });

  // 降调后处理只在 minimax 引擎上生效（edge 的 pitch 参数本来就有效）。
  // 重采样会把时长拉长 ×1/p，所以合成时先让引擎快 p 倍，最终时长基本不变。
  const semis = c.engine === 'minimax' && c.pitchShift?.enabled ? c.pitchShift.semitones : 0;
  const pitchRatio = 2 ** (semis / 12);
  const speedMul = semis ? 1 / pitchRatio : 1;
  const outExt = semis ? '.wav' : '.mp3';

  const stamp = `${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const filePath = path.join(c.tmpDir, `tts-${stamp}${outExt}`);
  const logFile = path.join(c.tmpDir, `tts-${stamp}.log`);
  let attempts = 0;
  let parsed = null;
  let lastBody = spoken;

  // tune 的语义随引擎变：edge 是 rate 字符串（"+8%"），minimax 是 speed 数值（1.06）。
  const synthOnce = async (tune) => {
    attempts += 1;
    if (c.engine === 'minimax') {
      // 气口只加在发给引擎的文本上：spoken 保持干净，长度计算/截断/回显都按原文字数走。
      // 不预生成，是因为下面「太短/太长」的分支会改写 spoken，每次都按当前值重算。
      lastBody = applyVoicePauses(spoken, c.pauses);
      const raw = await synthMinimax(lastBody, { ...m, speed: tune }, c, semis ? 'wav' : 'mp3');
      // 原位做重采样：写盘前后 duration 都以最终音频为准，min/max 夹逼才不会算错
      const buf = semis ? pitchShiftWav(raw, semis, { formantAlpha: c.pitchShift.formantAlpha }).buffer : raw;
      fs.writeFileSync(filePath, buf);
    } else {
      // 必须用「--rate=-4%」等号写法：argparse 会把单独一个 `-4%` 当成选项名，
      // 报 "argument --rate: expected one argument"（降语速到负数时必踩）。
      const args = ['--voice', m.voice, `--rate=${tune}`, `--pitch=${m.pitch}`, `--text=${spoken}`, '--write-media', filePath];
      const { code } = await runEdgeTts({ exe: c.exe, args, timeoutMs: c.timeoutMs, logFile });
      if (code !== 0) {
        const tail = readLogTail(logFile);
        throw new Error(`edge-tts 退出码 ${code}${tail ? `：${tail}` : '（无输出）'}`);
      }
    }
    let bytes = 0;
    try { bytes = fs.statSync(filePath).size; } catch {}
    if (!bytes) throw new Error(`${c.engine === 'minimax' ? 'MiniMax' : 'edge-tts'} 没有产出文件`);
    parsed = semis ? wavDurationOfFile(filePath) : mp3DurationOfFile(filePath);
    if (!parsed) throw new Error(`产出的文件不是可解析的 ${semis ? 'WAV' : 'MP3'}（${bytes} 字节），拒绝发送`);
    return bytes;
  };

  // 太短时怎么凑时长：
  // - minimax（2026-10-26 改）：**不降速、不垫字**。降速会让同一个人时快时慢（人格一致的头号
  //   杀手），垫「，嗯」会让每句末尾多一个机器味语气词（用户实测反馈）。改成在尾部加一个静音
  //   停顿标记 <#x#>：实测「好」1.03 s → 「好<#1.20#>」2.28 s，时长够了但文本里不多一个字。
  // - edge：没有停顿标记，仍旧先降语速（时长与 (1+rate) 近似反比，解方程得刚好 minSeconds
  //   的 rate），压到 -40% 还不够才垫「，嗯」。
  // 两者都实测过「末尾加句号不产生停顿」，纯加「。」时长不变。
  const baseRatePct = c.engine === 'minimax' ? 0 : parseRatePct(m.rate);
  let ratePct = baseRatePct;
  let usedTune = c.engine === 'minimax' ? clampSpeed((m.speed ?? 1) * speedMul) : m.rate;
  // 静音垫尾巴：标记的实际停顿时长与标称有偏差（实测标称 1.12 s 可能只贡献约 1.0 s，也可能
  // 略超），所以每轮只多给 0.15 s 余量；垫完还短就再来一轮（最多 3 轮），在已有标记上累加，
  // 而不是叠出一串标记。余量给小一点是为了不让短句尾巴挂一串死气（0.4 s 余量下「我在。」这种
  // 不到 1 秒的句子会挂 0.6 秒静音）。
  let padRounds = 0;
  let padMs = 0;

  try {
    let bytes = 0;
    for (let i = 0; i < 4; i += 1) {
      usedTune = c.engine === 'minimax' ? clampSpeed(usedTune) : formatRatePct(ratePct);
      bytes = await synthOnce(usedTune);
      if (parsed.seconds >= c.minSeconds) break;
      if (c.engine === 'minimax') {
        if (padRounds >= 3) break;
        // 结尾标点先摘掉再挂标记：实测「句号 + 标记」里的标记可能被忽略，裸标记才生效。
        const deficit = Math.max(0.2, c.minSeconds - parsed.seconds);
        padMs = Math.min(2000, padMs + Math.round((deficit + 0.15) * 1000));
        spoken = `${spoken.replace(/(?:<#[\d.]+#>|[，,、。．.！!？?…\s])+$/u, '')}<#${(padMs / 1000).toFixed(2)}#>`;
        padRounds += 1;
        usedTune = clampSpeed((m.speed ?? 1) * speedMul);
      } else {
        const needPct = ((parsed.seconds * (1 + ratePct / 100)) / c.minSeconds - 1) * 100;
        if (needPct < -40) {
          spoken = `${spoken}，嗯`;
          ratePct = baseRatePct;
        } else {
          ratePct = Math.max(-45, Math.min(45, needPct));
        }
      }
    }
    // 太长：按字符比例截断重合成（最多 3 次）
    for (let i = 0; i < 3 && parsed.seconds > c.maxSeconds; i += 1) {
      const keep = Math.max(2, Math.floor((spoken.length * c.maxSeconds * 0.92) / parsed.seconds));
      if (keep >= spoken.length) break;
      spoken = normalizeSpeechText(spoken.slice(0, keep), c.maxChars);
      bytes = await synthOnce(usedTune);
    }

    if (parsed.seconds < c.minSeconds) {
      throw new Error(`合成只有 ${parsed.seconds} 秒，达不到最短 ${c.minSeconds} 秒（文字太短，补停顿也没救），已放弃`);
    }
    if (parsed.seconds > c.maxSeconds) {
      throw new Error(`合成 ${parsed.seconds} 秒，超过上限 ${c.maxSeconds} 秒，已放弃`);
    }
    removeQuietly(logFile);
    return {
      engine: c.engine,
      filePath,
      seconds: parsed.seconds,
      bytes,
      mood: moodUsed,
      voice: m.voice,
      rate: c.engine === 'minimax' ? undefined : usedTune,
      speed: c.engine === 'minimax' ? Number(usedTune) : undefined,
      pitch: m.pitch,
      pitchShift: semis ? { semitones: semis, engineSpeed: Number(usedTune), engineSpeedMul: Math.round(speedMul * 1000) / 1000 } : null,
      emotion: c.engine === 'minimax' ? (m.emotion ?? null) : undefined,
      spokenText: spoken,
      pausedText: c.engine === 'minimax' ? lastBody : undefined,
      attempts,
      warnings
    };
  } catch (error) {
    // 失败不把半成品/日志留在临时目录里（错误信息里已经带了日志尾部的关键行）。
    removeQuietly(filePath);
    removeQuietly(logFile);
    throw error;
  }
}

/** 删除失败不抛（复用 voice-core 的口径）。 */
export function removeQuietly(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch {}
}

/**
 * 把合成好的 mp3 放进语音库的隐藏子目录（bridge.js 的 listAudioFiles 会跳过点目录，
 * 因此不会污染 qq_list_voices 的列表），返回 send-voice 可用的相对路径。
 */
export function stageIntoLibrary(ttsFile, cfg = {}) {
  const c = voiceTtsConfig(cfg);
  const dir = path.join(c.libraryDir, '.tts');
  fs.mkdirSync(dir, { recursive: true });
  const name = `tts-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${path.extname(ttsFile) || '.mp3'}`;
  const dest = path.join(dir, name);
  try {
    fs.renameSync(ttsFile, dest);
  } catch {
    fs.copyFileSync(ttsFile, dest);
    removeQuietly(ttsFile);
  }
  return { absPath: dest, relPath: `.tts/${name}` };
}
