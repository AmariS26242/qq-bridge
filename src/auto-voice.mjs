// QQ 语音自动触发（纯逻辑模块，无副作用、可离线测试）。
//
// 规则（用户 2026-10-23 拍板，2026-11-08 改造）：
// - **只有场景白名单，不随机**：机器人回复文本命中场景关键词才可能发语音；
//   因此同一段文本的判定结果是确定的（不掷骰子），可预测、可复现。
// - 2026-11-08 起语音条改说日语：命中场景后念的是**该场景的日语台词**，
//   不是把中文回复原样喂给日语音色（那会变成谁也听不懂的混读）；
//   台词可多套，按该 mood 当天已用次数轮换，避免每晚都是同一句。
// - 每日自动语音上限 30 条，超了降级成文字；显式调用 send_tts_voice 不受此限。
// - 同一条/相邻场景有冷却时间，避免一分钟内连发两条「晚安」。
//
// 设计边界：本模块只做「该不该发、发什么、什么声线」的判定 + 用量文件读写；
// 真正的合成与发送在 bridge.js（voiceTts.mjs 合成），保持播放链路单一入口。
import fs from 'node:fs';
import path from 'node:path';

// 场景 → 声线。顺序即优先级：越特殊越靠前（「生日快乐」先于「好开心」）。
// mood 取值必须落在 voice-tts.mjs 的五档里：calm / happy / shy / annoyed / sad。
// ja/zh 是同一句的两个版本：ja 是嘴里念的日语，zh 是补字幕时的中文翻译，索引一一对应。
export const AUTO_VOICE_DEFAULTS = Object.freeze({
  enabled: true,
  maxPerDay: 30,
  cooldownMinutes: 20,
  minChars: 2,
  maxChars: 20,
  scenes: Object.freeze([
    {
      mood: 'happy',
      keywords: Object.freeze(['生日快乐', '恭喜', '太好了', '好开心', '成功啦']),
      ja: Object.freeze(['おめでとう！やったね！', 'うれしい！すごくうれしい！', 'やったね、本当におめでとう！']),
      zh: Object.freeze(['恭喜！太棒了！', '好开心！真的替你高兴！', '太好了，真的恭喜你！'])
    },
    {
      mood: 'shy',
      keywords: Object.freeze(['想你', '喜欢你', '想我', '么么', '抱抱']),
      ja: Object.freeze(['ねえ、会いたいな…', '大好きだよ、本当だよ', 'ぎゅっとしてあげるね']),
      zh: Object.freeze(['呐，好想你…', '最喜欢你了，真的', '抱抱你哦'])
    },
    {
      mood: 'annoyed',
      keywords: Object.freeze(['哼', '讨厌', '不理你']),
      ja: Object.freeze(['もう、ひどいよ…', 'ふん、知らない！', 'もう、怒っちゃうよ']),
      zh: Object.freeze(['真是的，太过分了…', '哼，不理你了！', '再这样我要生气了哦'])
    },
    {
      mood: 'sad',
      keywords: Object.freeze(['再见', '拜拜', '舍不得', '保重']),
      ja: Object.freeze(['またね、元気でね', 'さよなら、忘れないでね', '寂しいけど、バイバイ']),
      zh: Object.freeze(['再见，要好好的', '再见了，别忘了我哦', '虽然舍不得，拜拜'])
    },
    {
      mood: 'calm',
      keywords: Object.freeze(['晚安', '好梦', '睡了']),
      ja: Object.freeze(['おやすみ、いい夢見てね', '今日もおつかれさま', 'ゆっくり休んでね']),
      zh: Object.freeze(['晚安，做个好梦', '今天也辛苦了', '好好休息哦'])
    },
    {
      mood: 'calm',
      keywords: Object.freeze(['早安', '起床啦']),
      ja: Object.freeze(['おはよう、いい朝だね', 'おはよう、今日も元気にね']),
      zh: Object.freeze(['早上好，今天天气不错呢', '早安，今天也要有精神哦'])
    }
  ])
});

const MOODS = new Set(['calm', 'happy', 'shy', 'annoyed', 'sad']);

export function isMood(value) {
  return MOODS.has(String(value ?? ''));
}

function asLines(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => String(v ?? '').trim()).filter(Boolean);
}

// 取某场景该念的台词：优先找「同关键词」的默认场景（「早安」和「晚安」同属 calm，台词不同），
// 其次同 mood 的默认场景，最后才用配置里自带的自定义台词。
export function sceneLines(scene, keyword = '') {
  const byKeyword = AUTO_VOICE_DEFAULTS.scenes.find((s) => s.keywords.includes(keyword));
  const byMood = AUTO_VOICE_DEFAULTS.scenes.find((s) => s.mood === scene?.mood);
  const src = byKeyword || byMood;
  const ja = asLines(scene?.ja).length ? asLines(scene.ja) : src ? [...src.ja] : [];
  const zh = asLines(scene?.zh).length ? asLines(scene.zh) : src ? [...src.zh] : [];
  return { ja, zh };
}

// 把 config.json 里的 socialV2.autoVoice（可能缺字段/写错类型）收敛成可用配置。
export function normalizeAutoVoiceConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pick = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const scenes = Array.isArray(src.scenes) && src.scenes.length
    ? src.scenes
      .map((scene) => {
        const mood = String(scene?.mood ?? '').trim();
        const keywords = (Array.isArray(scene?.keywords) ? scene.keywords : [])
          .map((k) => String(k ?? '').trim())
          .filter(Boolean);
        if (!isMood(mood) || !keywords.length) return null;
        const ja = asLines(scene?.ja);
        const zh = asLines(scene?.zh);
        return {
          mood,
          keywords,
          ...(ja.length ? { ja } : {}),
          ...(zh.length ? { zh } : {})
        };
      })
      .filter(Boolean)
    : AUTO_VOICE_DEFAULTS.scenes.map((scene) => ({ mood: scene.mood, keywords: [...scene.keywords] }));
  const maxPerDay = Math.max(0, Math.trunc(pick(src.maxPerDay, AUTO_VOICE_DEFAULTS.maxPerDay)));
  const maxChars = Math.max(1, Math.trunc(pick(src.maxChars, AUTO_VOICE_DEFAULTS.maxChars)));
  const minChars = Math.max(1, Math.trunc(pick(src.minChars, AUTO_VOICE_DEFAULTS.minChars)));
  return {
    enabled: src.enabled !== false,
    maxPerDay,
    cooldownMinutes: Math.max(0, pick(src.cooldownMinutes, AUTO_VOICE_DEFAULTS.cooldownMinutes)),
    minChars: Math.min(minChars, maxChars),
    maxChars,
    scenes: scenes.length ? scenes : AUTO_VOICE_DEFAULTS.scenes.map((scene) => ({ mood: scene.mood, keywords: [...scene.keywords] }))
  };
}

export function todayKey(now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyUsage(today) {
  return { date: today, auto: 0, manual: 0, byMood: {}, lastAutoAt: 0, history: [] };
}

// 用量文件默认落在 qq-bridge/state/voice-usage.json（与 dashboard 读取的 state 目录一致）。
export function loadUsage(file, now = Date.now()) {
  const today = todayKey(now);
  let parsed = null;
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    parsed = JSON.parse(text);
  } catch {
    return emptyUsage(today);
  }
  if (!parsed || typeof parsed !== 'object') return emptyUsage(today);
  const usage = {
    date: String(parsed.date ?? today),
    auto: Math.max(0, Math.trunc(Number(parsed.auto) || 0)),
    manual: Math.max(0, Math.trunc(Number(parsed.manual) || 0)),
    byMood: parsed.byMood && typeof parsed.byMood === 'object' ? { ...parsed.byMood } : {},
    lastAutoAt: Math.max(0, Number(parsed.lastAutoAt) || 0),
    history: Array.isArray(parsed.history) ? parsed.history.slice(-60) : []
  };
  // 跨天：计数清零，但保留历史（历史本身带日期，便于回看）。
  if (usage.date !== today) return { ...emptyUsage(today), history: usage.history };
  return usage;
}

export function saveUsage(file, usage) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(usage, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// 命中场景：返回第一个命中的场景（配置顺序即优先级）。
export function matchScene(text, scenes) {
  const said = String(text ?? '');
  if (!said) return null;
  for (const scene of scenes) {
    for (const keyword of scene.keywords) {
      if (keyword && said.includes(keyword)) return { mood: scene.mood, keyword };
    }
  }
  return null;
}

// 把回复文本收拾成"念得出来"的一句：去 CQ 码/URL/Markdown/换行，去尾部标点。
export function cleanVoiceText(text, maxChars = AUTO_VOICE_DEFAULTS.maxChars) {
  let s = String(text ?? '');
  s = s.replace(/\[CQ:[^\]]*\]/g, ' ');
  s = s.replace(/https?:\/\/\S+/gi, ' ');
  s = s.replace(/[*_`~>#|]+/g, '');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/[，,。.、；;：:！!？?…~～\u201c\u201d"']+$/g, '');
  s = s.trim();
  return { spoken: s, chars: [...s].length, tooLong: [...s].length > maxChars };
}

// 判定：该不该自动发语音。返回 { ok, reason, mood, keyword, spoken, translation, sourceText, chars }
// spoken 是**嘴里念的日语**（场景台词），translation 是它的中文翻译，sourceText 是触发它的中文回复。
// reason ∈ ok / disabled / empty / toolong / nomatch / cap / cooldown
export function decideAutoVoice({ text, cfg, usage, now = Date.now() }) {
  const conf = cfg && typeof cfg === 'object' && cfg.scenes ? cfg : normalizeAutoVoiceConfig(cfg);
  if (!conf.enabled) return { ok: false, reason: 'disabled' };
  const { spoken: sourceText, chars } = cleanVoiceText(text, conf.maxChars);
  if (!sourceText || chars < conf.minChars) return { ok: false, reason: 'empty', sourceText, chars };
  const hit = matchScene(sourceText, conf.scenes);
  if (!hit) return { ok: false, reason: 'nomatch', sourceText, chars };
  if (chars > conf.maxChars) return { ok: false, reason: 'toolong', sourceText, chars, mood: hit.mood, keyword: hit.keyword };
  const today = todayKey(now);
  const dailyAuto = usage?.date === today ? Math.max(0, Math.trunc(Number(usage.auto) || 0)) : 0;
  const moodCount = usage?.date === today ? Math.max(0, Math.trunc(Number(usage.byMood?.[hit.mood]) || 0)) : 0;
  const scene = conf.scenes.find((s) => s.mood === hit.mood && s.keywords.includes(hit.keyword)) ?? { mood: hit.mood };
  const lines = sceneLines(scene, hit.keyword);
  const variant = lines.ja.length ? moodCount % lines.ja.length : null;
  const spoken = variant === null ? sourceText : lines.ja[variant];
  const translation = lines.zh.length ? lines.zh[variant === null ? 0 : variant % lines.zh.length] : '';
  const plan = { spoken, translation, sourceText, chars, mood: hit.mood, keyword: hit.keyword, variant };
  if (conf.maxPerDay > 0 && dailyAuto >= conf.maxPerDay) {
    return { ok: false, reason: 'cap', dailyAuto, ...plan };
  }
  if (conf.cooldownMinutes > 0) {
    const last = usage?.date === today ? Number(usage.lastAutoAt) || 0 : 0;
    const gapMs = conf.cooldownMinutes * 60 * 1000;
    if (last > 0 && now - last < gapMs) {
      return { ok: false, reason: 'cooldown', dailyAuto, waitMs: gapMs - (now - last), ...plan };
    }
  }
  return { ok: true, reason: 'ok', dailyAuto, ...plan };
}

// 记账：mode='auto' 计进每日上限，mode='manual'（显式工具调用）只做统计。
export function recordVoiceUsage(usage, { mode = 'auto', mood = 'calm', now = Date.now(), meta = null } = {}) {
  const today = todayKey(now);
  const base = usage && usage.date === today ? usage : { ...emptyUsage(today), history: Array.isArray(usage?.history) ? usage.history : [] };
  const next = {
    ...base,
    date: today,
    byMood: { ...base.byMood }
  };
  next.byMood[mood] = Math.max(0, Math.trunc(Number(next.byMood[mood]) || 0)) + 1;
  if (mode === 'manual') next.manual += 1;
  else {
    next.auto += 1;
    next.lastAutoAt = now;
  }
  next.history = [...next.history, { at: new Date(now).toISOString(), mode, mood, ...(meta ? { meta } : {}) }].slice(-60);
  return next;
}
