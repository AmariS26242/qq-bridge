// 夜间语音时段（纯逻辑模块，无副作用、可离线测试）。
//
// 规则（2026-11-14 用户要求）：每天 22:00–06:00 期间，QQ 端默认用语音对话——
// 模型每条回复优先调 send_tts_voice 说一句短日语并给中文翻译，文字能省就省。
// 窗口外维持原状（语音靠模型自愿 + 场景白名单自动语音）。
//
// 边界约定：
// - 左闭右开：22:00 生效，06:00 已失效；跨零点（start > end）自动按「晚段+早段」两段判断。
// - start === end 视为**永不生效**（写错成同一时刻会导致 24 小时语音，宁可关掉）。
// - 时间一律用本机本地时区（这台机器是 Asia/Shanghai），不做 UTC 换算。
// - 本模块只判定「现在是不是窗口内、窗口内该对模型说什么」，不改任何配置、不发消息。

export const VOICE_WINDOW_DEFAULTS = Object.freeze({
  enabled: true,
  start: '22:00',
  end: '06:00',
  mood: 'calm',
  maxChars: 16,
  // 默认只对私聊生效：群里半夜发语音条会打扰别人，需要时把 'group' 加进来。
  scopes: ['private']
});

const SCOPE_KINDS = new Set(['private', 'group']);

const MOODS = new Set(['calm', 'happy', 'shy', 'annoyed', 'sad', '']);
const CLOCK_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "22:00" → 1320；非法值返回 null。 */
export function parseClock(value) {
  const m = CLOCK_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 1320 → "22:00" */
export function formatClock(minutes) {
  const m = Math.max(0, Math.min(1439, Math.round(Number(minutes) || 0)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 某一时刻在当天的分钟数（本地时区）。 */
export function minutesOfDay(now = Date.now()) {
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 把 config.json 的 socialV2.voiceWindow 收敛成可用配置。
 * 写错的字段一律回默认值，保证窗口判定永远不会因为配置手抖而 24 小时生效。
 */
export function normalizeVoiceWindowConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const startMin = parseClock(src.start);
  const endMin = parseClock(src.end);
  const moodRaw = String(src.mood ?? VOICE_WINDOW_DEFAULTS.mood).trim();
  const maxChars = Math.max(4, Math.min(60, Math.round(Number(src.maxChars) || VOICE_WINDOW_DEFAULTS.maxChars)));
  // scopes 写错（拼错/空数组）一律回默认的私聊，宁可少发也不要半夜在群里刷语音。
  const rawScopes = Array.isArray(src.scopes) ? src.scopes : (typeof src.scopes === 'string' ? [src.scopes] : null);
  const scopes = rawScopes
    ? [...new Set(rawScopes.map((s) => String(s ?? '').trim().toLowerCase()).filter((s) => SCOPE_KINDS.has(s)))]
    : [...VOICE_WINDOW_DEFAULTS.scopes];
  if (!scopes.length) scopes.push(...VOICE_WINDOW_DEFAULTS.scopes);
  return {
    enabled: src.enabled !== false,
    start: startMin === null ? VOICE_WINDOW_DEFAULTS.start : formatClock(startMin),
    end: endMin === null ? VOICE_WINDOW_DEFAULTS.end : formatClock(endMin),
    startMin: startMin === null ? parseClock(VOICE_WINDOW_DEFAULTS.start) : startMin,
    endMin: endMin === null ? parseClock(VOICE_WINDOW_DEFAULTS.end) : endMin,
    mood: MOODS.has(moodRaw) ? moodRaw : VOICE_WINDOW_DEFAULTS.mood,
    maxChars,
    scopes
  };
}

/** 会话 key 的类型：private / group；其它返回空串。 */
export function parseSessionKind(key) {
  const m = /^(private|group):/.exec(String(key ?? '').trim());
  return m ? m[1] : '';
}

/**
 * 某个会话现在是否该走夜间语音：既要在时间窗口内，会话类型也要在 scopes 白名单里。
 * 群聊默认不在白名单（夜间集体语音太扰人），要开就把 "group" 写进 socialV2.voice.window.scopes。
 */
export function isVoiceWindowActiveFor(key, now = Date.now(), cfg = VOICE_WINDOW_DEFAULTS) {
  const conf = cfg && Array.isArray(cfg.scopes) ? cfg : normalizeVoiceWindowConfig(cfg);
  if (!isInVoiceWindow(now, conf)) return false;
  const kind = parseSessionKind(key);
  return !!kind && conf.scopes.includes(kind);
}

/** 现在是否在语音窗口内。跨零点时按「>= start 或 < end」两段判断。 */
export function isInVoiceWindow(now = Date.now(), cfg = VOICE_WINDOW_DEFAULTS) {
  const conf = cfg && Number.isFinite(cfg.startMin) ? cfg : normalizeVoiceWindowConfig(cfg);
  if (!conf.enabled) return false;
  // start === end：长度为零的窗口，按约定视为永不生效。
  if (conf.startMin === conf.endMin) return false;
  const t = minutesOfDay(now);
  if (conf.startMin < conf.endMin) return t >= conf.startMin && t < conf.endMin;
  return t >= conf.startMin || t < conf.endMin;
}

/** 窗口状态快照：给 HTTP 接口 / 控制台看，不参与发送判定。 */
export function describeVoiceWindow(now = Date.now(), cfg = VOICE_WINDOW_DEFAULTS) {
  const conf = normalizeVoiceWindowConfig(cfg);
  const t = minutesOfDay(now);
  const active = isInVoiceWindow(now, conf);
  // 下一次状态翻转的时间：窗口内算结束点，窗口外算开始点。
  let untilMin = null;
  if (conf.enabled && conf.startMin !== conf.endMin) {
    if (active) {
      const remain = conf.startMin < conf.endMin
        ? conf.endMin - t
        : (t < conf.endMin ? conf.endMin - t : 1440 - t + conf.endMin);
      untilMin = Math.max(1, remain);
    } else {
      const remain = conf.startMin > t ? conf.startMin - t : 1440 - t + conf.startMin;
      untilMin = Math.max(1, remain);
    }
  }
  return {
    enabled: conf.enabled,
    active,
    start: conf.start,
    end: conf.end,
    mood: conf.mood,
    maxChars: conf.maxChars,
    now: formatClock(t),
    nextChangeMinutes: untilMin,
    nextChangeAt: untilMin === null ? null : now + untilMin * 60000
  };
}

/**
 * 窗口内注入给模型的提示块；窗口外返回空串（提示词与改造前逐字节一致）。
 * 语义：语音就是这条回复本身，别再发一条同义文字；只有必须打成字的内容才补文字。
 */
export function buildVoiceWindowPrompt(now = Date.now(), cfg = VOICE_WINDOW_DEFAULTS) {
  const conf = normalizeVoiceWindowConfig(cfg);
  if (!isInVoiceWindow(now, conf)) return '';
  const t = formatClock(minutesOfDay(now));
  const moodHint = conf.mood ? `mood=${conf.mood}，` : '';
  return [
    `【夜间语音时段 · ${conf.start}–${conf.end}】现在 ${t}，默认用语音说话：`,
    `- 这条回复直接用 send_tts_voice 说 ${Math.max(8, conf.maxChars - 8)}–${conf.maxChars} 字日语（${moodHint}结尾不带「。」），并在 translation 里给中文翻译；桥接会自动补「日语原文 + 中文翻译」字幕，你**不用再发一遍同义文字**。`,
    '- 只有必须打成字的东西（链接、数字、长说明、要对方照着做的步骤）才用文字补一句，能省就省。',
    '- 语音说的就是你这条回复本身，别一边语音一边另发一条同义文字。'
  ].join('\n') + '\n\n';
}
