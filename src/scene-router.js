// 场景路由：决定「这一轮该注入哪几段人格场景」。
//
// 人格卡里带 `## 场景：xxx` 的小节不会每轮全量注入，只在命中时插入唤醒提示词。
// 这里只看「最近几条消息的文本 + 时间 + 群聊/私聊」这类确定性信号，
// 全部同步、无 IO、可单测；路由错的代价也只是多/少几百字，不阻塞发送。
//
// 场景名必须和 roles/小鲸鱼.md 里的 `## 场景：xxx` 完全一致，否则该片段不会被选中。

export const SCENE_NAMES = [
  '情绪倾诉',
  '被问是不是AI',
  '求推荐',
  '被怼',
  '冷场',
  '深夜',
  '群聊接梗',
  '正经问题',
];

// 命中权重：文本规则 > 时间规则 > 兜底规则。同一场景多条命中只取最高分。
const TEXT_RULES = [
  {
    scene: '被问是不是AI',
    re: /(?:你|它|这)\s*(?:是|是不是|到底是不是)?\s*(?:ai|ＡＩ|人工智能|机器人|大模型|gpt|deepseek|claude)|ai\s*味|机器人吧|你真人|你是男是女|你几岁/i,
  },
  {
    scene: '情绪倾诉',
    re: /分手|失恋|被甩|想哭|哭了|难受|难过|好累|累死|烦死|崩溃|emo|破防|抑郁|焦虑|失眠|睡不着|孤独|委屈|撑不住|心累|压力大|不想活|没意思|吵架了|冷战/,
  },
  {
    scene: '求推荐',
    re: /推荐|安利|求个|有啥(?:好|能)|看什么|玩什么|听什么|吃点什么|有什么(?:好|安利)/,
  },
  {
    scene: '被怼',
    re: /傻逼|沙比|滾|滚|闭嘴|废物|垃圾|你算(?:什么|个)|就这|你行你上|什么玩意|别\s*bb|菜就|急了|破防了吧/i,
  },
  {
    scene: '正经问题',
    re: /怎么回事|怎么办|怎么弄|怎么解决|如何|为什么|报错|error|配置|部署|安装|命令|代码|原理|定义|区别|是多少|几个|能不能用|如何实现/i,
  },
];

const DEFAULTS = {
  maxScenes: 2,
  // 群聊里连续一段时间没人说话（分钟）→ 冷场
  silenceMinutes: 20,
  // 深夜时段（本地时区）
  nightStartHour: 0,
  nightEndHour: 5,
  // 「正经问题」要够长才算，避免「咋了」这种短句误判
  seriousMinLen: 10,
  // 群聊最近 N 条里至少有这么多条才算「聊得热闹」
  busyMinMessages: 3,
  busyWindowMinutes: 10,
};

/**
 * @param {Array<{text?:string, content?:string, time?:string|number}>} recent 最近消息（旧→新）
 * @param {{isGroup?:boolean, hour?:number, silenceMinutes?:number, now?:number, maxScenes?:number, options?:object}} meta
 * @returns {{scenes: string[], scores: Record<string,number>, reason: string}}
 */
export function routeScenes(recent = [], meta = {}) {
  const opt = { ...DEFAULTS, ...(meta.options ?? {}) };
  const now = Number.isFinite(meta.now) ? meta.now : Date.now();
  const isGroup = meta.isGroup !== false;
  const messages = (Array.isArray(recent) ? recent : [])
    .map((m) => ({
      text: String(m?.text ?? m?.content ?? '').trim(),
      at: toMs(m?.time),
    }))
    .filter((m) => m.text);

  const scores = {};
  const bump = (scene, weight) => {
    scores[scene] = Math.max(scores[scene] ?? 0, weight);
  };
  const reasons = [];

  // 1) 文本规则：只看最近 8 条，越新权重越高（3 / 2 / 1）
  const tail = messages.slice(-8);
  for (let i = 0; i < tail.length; i++) {
    const recencyWeight = i >= tail.length - 2 ? 3 : i >= tail.length - 5 ? 2 : 1;
    for (const rule of TEXT_RULES) {
      if (!rule.re.test(tail[i].text)) continue;
      // 「正经问题」要求句子够长，短句多半是玩笑
      if (rule.scene === '正经问题' && tail[i].text.length < opt.seriousMinLen) continue;
      bump(rule.scene, recencyWeight);
    }
  }
  if (scores['正经问题']) reasons.push('最近在问具体问题');

  // 2) 时间规则
  const hour = Number.isFinite(meta.hour) ? meta.hour : new Date(now).getHours();
  if (hour >= opt.nightStartHour && hour < opt.nightEndHour) {
    bump('深夜', 2);
    reasons.push('深夜时段');
  }

  // 3) 冷场：群聊 + 已经安静了一会儿
  const silence = Number.isFinite(meta.silenceMinutes)
    ? meta.silenceMinutes
    : lastMessageAgeMinutes(messages, now);
  if (isGroup && silence !== null && silence >= opt.silenceMinutes) {
    bump('冷场', 2);
    reasons.push(`群里安静了 ${Math.round(silence)} 分钟`);
  }

  // 4) 兜底：群聊有来有回 → 接梗；私聊没有明显信号 → 也给接梗
  if (isGroup) {
    const busy = messages.filter((m) => m.at && now - m.at <= opt.busyWindowMinutes * 60000).length;
    if (busy >= opt.busyMinMessages) bump('群聊接梗', 1);
    else if (!reasons.length) bump('群聊接梗', 1);
  } else if (!reasons.length) {
    bump('情绪倾诉', 1); // 私聊里没有信号时，默认按「可能想聊两句」处理
  }

  const limit = Math.max(1, Number(meta.maxScenes) || opt.maxScenes || DEFAULTS.maxScenes);
  const scenes = SCENE_NAMES
    .filter((name) => (scores[name] ?? 0) > 0)
    .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))
    .slice(0, limit);

  return {
    scenes,
    scores,
    reason: reasons.length ? reasons.join('；') : scenes.length ? '常规接话' : '无信号',
  };
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function lastMessageAgeMinutes(messages, now) {
  const last = [...messages].reverse().find((m) => m.at);
  if (!last) return null;
  return Math.max(0, (now - last.at) / 60000);
}
