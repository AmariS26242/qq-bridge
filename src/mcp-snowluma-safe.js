// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 出站文本的敏感信息拦截**统一由桥接负责**（bridge.js 的 auditAndSend / 各发送端点的
// SENSITIVE_RE 校验）：所有 QQ 发送都经由桥接 HTTP API，因此 MCP 侧不再重复实现一遍。
// 这里 import 只用于「出站审计口径一致」的说明，不在 MCP 内做拦截——
// 在 MCP 里拦会连「安全拒绝理由」都拿不到，反而让模型无法把话说清楚。
import { SENSITIVE_RE } from './sensitive.js';
import { MEDIA_FAIL_SHORT, MEDIA_TOO_LARGE_SHORT, mediaMissText, mediaPartialNote } from './media-note.js';
import { serializeModelData } from './qq-model-view.js';
import { splitForTts, stageIntoLibrary, synthesize, voiceTtsConfig } from './voice-tts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 说明：本文件曾经有一对 escapeCqText() / messageSegments()，用于在 MCP 侧构造消息段。
// 它们从来没有被任何工具调用（发送一律走桥接的 /api/send/*，由桥接统一构造文本段并做
// CQ 转义，见 bridge.js 的 onebotSend），属于"看起来在防护、实际是死代码"的假安全。
// 这里直接删除，避免以后有人以为 MCP 侧还有一道 CQ 转义而放松桥接那一层。

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  try {
    const c = getConfig();
    if (c.consoleToken) return String(c.consoleToken);
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(rest.headers ?? {})
  };
  // 声明「这是一次智能体调用」。桥接据此把「没带会话令牌」判定为**拒绝**，而不是
  // 退化成「管理端全权」——所以这个头绝不能随 token 一起被省略。历史上 331/355/379/877
  // 行用 `...(token ? {headers:{...}} : {})` 把整个头省掉了，于是「模型漏传 token」
  // 不是被拒绝，反而提权成控制台权限（confused deputy）。
  // 令牌本身仍然只在真有时才发：/api/status 的模式探测（legacyReadToolAllowed）本来就是
  // 无令牌调用，桥接对它单独放行并按最小对象返回。
  headers['x-agent-call'] = '1';
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(body?.error || `桥接 API HTTP ${res.status}`);
  }
  // 桥接的部分端点会用 200 + {ok:false,error} 表达业务失败（例如发送被审计拦截）。
  // 不检查 body.ok 会把「被拦截」当成「发送成功」上报给模型 —— 模型据此认为消息已发出，
  // 于是不再重试也不告诉用户，是典型的静默错误。
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(body.error || '桥接 API 返回 ok:false（未说明原因）');
  }
  return body;
}

async function authorizeRead(key) {
  // 会话令牌必须显式携带：桥接已把空令牌的请求一律拒绝（避免把该端点变成免鉴权入口）。
  // 旧只读工具没有令牌，因此它们改由 legacyReadToolAllowed() 做模式判定，不再调用本函数。
  throw new Error('旧只读工具没有会话令牌；请使用带会话令牌的 v2 读工具');
}

// 旧只读工具（qq_status 之外的 qq_list_groups / qq_get_group_members / qq_get_group_history）
// 没有会话令牌，因此**只能在封闭 agent（管理员私聊）里使用**。
//
// 这里用「确认是 closed-agent 才放行」的白名单写法，而不是「看到 reserved2 就拒绝」的黑名单写法：
// 桥接的 /api/status 在「带 agent 令牌」时返回的是最小状态对象（不含 mode 字段），
// 用 `status?.mode === 'reserved2'` 判断会得到 undefined ⇒ 黑名单判定为假 ⇒ 旧工具被放行，
// 等于在二代仿真模式下把白名单群名、群成员名单注入模型上下文。
async function legacyReadToolAllowed() {
  const status = await agentApi('/api/status');
  return String(status?.mode ?? '') === 'closed-agent';
}

const server = new McpServer({ name: 'snowluma-safe', version: '0.2.0-r3' });

// ── 工具开关必须在**注册期**生效，而不是只在校验期 ──────────────────────────
//
// 为什么：每个工具的描述 + 参数 schema 都会随 system prompt 在**每一次**请求里重发
// （实测 41 个工具约 8.8k token）。只在校验时 403 的话，被关掉的工具依然占着上下文、
// 依然会让模型看见并调用它（然后拿到一个错误），等于「关了个寂寞」。
//
// 这里用一个注册过滤器统一处理：开关关闭 ⇒ 该工具根本不注册 ⇒ 既省 token 又不给模型误调的机会。
// DSH 在启动时读取工具清单，所以关掉/打开后需要重启 DSH 才会刷新（控制台面板已注明）。
//
// 只列**各模式共用的工具不在其中**：qq_send_group_message / qq_send_private_message / qq_reply
// 同时服务 chat / reserved / closed-agent 模式，用 v2 的开关去决定它们是否注册会误伤其它模式，
// 所以这三个仍然只在调用时由桥接校验。
const TOOL_CONFIG_FLAGS = {
  qq_get_prompt: 'getPrompt',
  qq_get_unread_messages: 'getUnread',
  qq_get_recent_messages: 'getRecent',
  qq_social_state: 'socialState',
  qq_mark_read: 'markRead',
  qq_set_wake_config: 'setWakeConfig',
  qq_send_burst: 'sendBurst',
  qq_send_message: 'sendMessage',
  qq_wait_for_messages: 'waitMessages',
  qq_report_feedback: 'feedback',
  qq_get_my_recent_messages: 'getMyRecent',
  qq_get_message_detail: 'getMessageDetail',
  qq_get_active_members: 'getActiveMembers',
  qq_memory_append: 'memory',
  qq_memory_query: 'memory',
  qq_diary_write: 'diary',
  qq_diary_read: 'diary',
  qq_diary_list: 'diary',
  qq_profile_query: 'profile',
  qq_profile_write: 'profile',
  qq_profile_remove: 'profile',
  qq_profile_clear: 'profile',
  qq_slang_query: 'slangQuery',
  qq_slang_submit: 'slangSubmit',
  qq_send_voice: 'sendVoice',
  qq_list_voices: 'sendVoice',
  // 下面这些曾经漏登记。漏一个不是"多注册一个工具"那么轻：桥接那边按 `v2ToolEnabled(flag)`
  // 在**调用期**一律 403，而这里不登记就等于"控制台显示已关闭、模型每次请求仍收到它的完整
  // 描述与参数 schema，然后调用它、再拿到 403"——既白烧 token（本文件开头 176 行起就是为省这份
  // token 才改注册期过滤的），又诱导模型误调。`qq_set_sticker_remark` 默认就是 `false`
  // （见 bridge.js 的 socialV2.tools 默认表），所以此前它一直是"默认关闭却仍然可见"。
  qq_send_poke: 'sendPoke',
  qq_get_message_images: 'getImages',
  qq_get_forward_msg: 'getForwardMsg',
  qq_list_stickers: 'listStickers',
  qq_find_sticker: 'findSticker',
  qq_get_sticker_image: 'getStickerImage',
  qq_send_sticker: 'sendSticker',
  qq_collect_sticker: 'collectSticker',
  qq_get_self_image: 'getSelfImage',
  qq_sticker_note: 'stickerNote',
  qq_set_sticker_remark: 'setStickerRemark',
};
// 工具分组：用来把"日常聊天必备"和"低频管理能力"分开，避免 47 个工具全量常驻
// （全量 tools/list 约 48KB ≈ 15k tokens，每回合都进 system prompt）。
// 未列入下表的工具一律放行（漏列不会导致功能消失）。
const TOOL_GROUPS = {
  core: ['qq_status', 'qq_get_prompt', 'qq_get_unread_messages', 'qq_get_recent_messages',
    'qq_social_state', 'qq_mark_read', 'qq_send_message', 'qq_send_burst',
    'qq_send_private_message', 'qq_reply', 'qq_wait_for_messages', 'qq_set_wake_config',
    'qq_desk_command',
    // 人格 prompt 里明确点名要用的工具，必须常驻，否则人设会指挥模型调用不存在的工具
    'qq_send_poke', 'qq_slang_query', 'qq_slang_submit', 'qq_style_guide'],
  group: ['qq_list_groups', 'qq_get_group_members', 'qq_get_active_members',
    'qq_get_group_history', 'qq_send_group_message'],
  media: ['qq_get_message_images', 'qq_get_forward_msg', 'qq_get_message_detail',
    'qq_send_image', 'qq_send_sticker', 'qq_get_self_image', 'qq_get_my_recent_messages',
    'send_tts_voice'],
  stickers: ['qq_list_stickers', 'qq_find_sticker', 'qq_get_sticker_image', 'qq_collect_sticker',
    'qq_sticker_note', 'qq_set_sticker_remark'],
  // 日记挂在 memory 组：生产 config.json 的 mcp.toolGroups 只含 core/group/media/stickers/memory，
  // 单开 diary 组会被注册期过滤静默禁用（控制台却显示已启用，最难查的一类 bug）。
  memory: ['qq_memory_append', 'qq_memory_query',
    'qq_diary_write', 'qq_diary_read', 'qq_diary_list'],
  profile: ['qq_profile_query', 'qq_profile_write', 'qq_profile_remove', 'qq_profile_clear'],
  admin: ['qq_set_avatar', 'qq_set_profile', 'qq_set_signature', 'qq_set_reminder',
    'qq_list_reminders', 'qq_cancel_reminder', 'qq_report_feedback'],
};
const groupOf = new Map();
for (const [group, names] of Object.entries(TOOL_GROUPS)) {
  for (const name of names) groupOf.set(name, group);
}
// 角色预置（供 cordis.patch.yml 用环境变量挂两个 server 时使用）：core=聊天面，admin=管理面。
const ROLE_GROUPS = {
  core: new Set(['core', 'group', 'media', 'stickers', 'memory']),
  admin: new Set(['admin', 'profile', 'memory', 'stickers', 'group']),
};
// 未配置时 enabledGroups=null → 全量放行，行为与改造前完全一致。
const enabledGroups = (() => {
  const role = process.env.QQ_MCP_ROLE;
  if (role && ROLE_GROUPS[role]) return ROLE_GROUPS[role];
  const configured = cfg.mcp?.toolGroups;
  return Array.isArray(configured) ? new Set(configured) : null;
})();

const disabledTools = [];
let registeredCount = 0;
{
  const registerTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const group = groupOf.get(name);
    if (enabledGroups && group && !enabledGroups.has(group)) {
      disabledTools.push(`${name}(${group})`);
      return undefined;
    }
    const flag = TOOL_CONFIG_FLAGS[name];
    if (flag && cfg.socialV2?.tools?.[flag] === false) {
      disabledTools.push(`${name}(${flag})`);
      return undefined;
    }
    registeredCount += 1;
    return registerTool(name, ...rest);
  };
}

server.tool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: serializeModelData({ ...login, online: status.online, good: status.good }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  {},
  async () => {
    // 旧只读工具没有 agent token：只允许在封闭 agent（管理员私聊）里使用。
    // 判定失败一律拒绝（fail-closed），不依赖「看到某个模式才拒绝」的黑名单写法。
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_members',
  '列出指定群的成员列表（只读）：QQ 号、昵称、群名片。',
  { groupId: z.union([z.number(), z.string()]).describe('群号') },
  async ({ groupId }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const data = await onebot('get_group_member_list', { group_id: Number(g) });
      const list = (Array.isArray(data) ? data : (data?.data ?? [])).map((m) => ({ user_id: m.user_id, nickname: m.nickname, card: m.card }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_group_message',
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        // token 既放 body（兼容旧调用）又放 header：桥接的「agent 流量」判定基于 header，
        // 只带 body 会让这条请求在桥接眼里像控制台请求，绕过 agent 专用的闸门与审计。
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reply',
  '在指定 QQ 群里引用/回复某条消息，并发送一条文本。适合群消息很多、需要明确“我回的是哪条”时使用；replyToMessageId 是被引用消息的 id（非零整数，QQ 消息 id 可能为负数），可先用 qq_get_recent_messages / qq_get_unread_messages / qq_get_message_detail 查到具体消息内容和 id。发送前桥接会校验该 id 存在且属于当前会话。二代模式下这是你正常可用的引用工具，但不要每条都引用。只有以下情况才需要引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。reserved2 下调用时必须携带会话令牌 token。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '查看未读消息，不自动标记已读。大量积压或快照 partial=true 时，用 afterSeq=readThroughSeq 从水位后按时间顺序补读；从最早未读开始传 0。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 30，最大 100'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('读取本地 seq 大于此水位的最早一页；省略则沿用返回最新一页的旧行为')
  },
  async ({ key, token, limit, afterSeq }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}${afterSeq === undefined ? '' : `&afterSeq=${afterSeq}`}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话已查看的未读消息标记为已读。throughSeq 使用最近读取结果的 readThroughSeq，避免清除读取后才到达的新消息；省略 throughSeq 会按旧行为清空当前全部未读，因此推荐始终带上水位。注意：每次设置潜水/下一次唤醒前，桥接要求先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可 mark_read 收尾沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与也可直接 mark_read 收尾；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息')
  },
  async ({ key, token, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置指定会话的唤醒配置（mode/时长/触发条件）。潜水前必须先调用 qq_wait_for_messages(timeoutMs=300000) 观察 5 分钟：无人说话可直接沉睡；有人说话则先看 newMessages，判断不需要参与再沉睡；若你已参与回复，下次想睡需重新观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读：传 readThroughSeq，省去一次 qq_mark_read；不传则只设置配置'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号：任意一位发言即唤醒（最多 20，私聊不适用；可从 qq_get_active_members 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_burst',
  '在指定 QQ 群分多条发送消息（二代仿真模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_reply。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_wait_for_messages',
  '等待分两种用途。首答前已读消息、只想确认有没有补充：用 purpose="reply"，按最后来信时间补足 quietMs 静默，已安静足够就立即返回；读取/思考时新到的消息也会返回，新消息重算静默。timeoutMs 是最长预算，不要求等满；预算到但 quiet=false 不代表对方已说完。此用途绝不代替沉睡前观察。等对方继续说、等回复或睡前观察：用默认 purpose="messages"；先等新消息，收到后才按 quietMs 等静默，没有新消息会等到 timeoutMs，单传 quietMs 不会缩短总等待。静默下限由后台配置，默认 10000ms。直接看 newMessages、unreadCount 和 readThroughSeq，返回消息无需重复查询；仍有未展示未读才补读。决定潜水/收尾时才用默认用途加 timeoutMs=300000 完成沉睡前观察，不能把 5 分钟观察放在首答之前；短等待不能代替。全程无人说话返回 preSleepWaitSatisfied=true；观察期间来了新消息返回 preSleepWaitObserved=true，读后不需参与可收尾，参与回复则下次收尾重新观察。preSleepWaitRemainingMs 仅供准备收尾时参考。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/睡前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予睡前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 30000、最大 600000；reply 达到静默即返回，不必等满；沉睡前观察用 messages 并传 300000'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 10000~12000；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 10000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      const data = await agentApi('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id / 本地 seq 查看单条消息的发送者、引用信息与正文（只读）。注意：正文最多返回 200 字符，textTruncated=true 表示被截断，这里不是读取长消息全文的入口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。旧记忆会按时间衰减并在注入时折叠，重要信息应重新 append 刷新时间。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。旧记忆会按时间衰减并在注入时折叠，重要信息应重新 append 刷新时间。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_diary_write',
  '写日记：把今天值得留下的写进你在本会话的日记本（一个会话一本、一天一页，持久保存）。默认追加到今天的页；写今天没写过的内容就新建页。这是你的私人本子，不是聊天记录——写你真正经历/聊到/想到的事和当时的感觉，一两段即可。今天已经写过也可以用 replace=true 整页重写。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    text: z.string().min(1).describe('日记正文：今天的事和你的感受，一两段，建议 ≤1200 字'),
    date: z.string().optional().describe('可选：补写某一天，格式 YYYY-MM-DD；缺省写今天'),
    title: z.string().optional().describe('可选短标题（≤40 字），给这一天起个名字'),
    mood: z.string().optional().describe('可选心情，如 平静/烦/开心（≤12 字）'),
    weather: z.string().optional().describe('可选天气，如 晴/雨（≤12 字）'),
    tags: z.array(z.string()).optional().describe('可选标签，最多 5 个'),
    replace: z.boolean().optional().describe('可选：true 时整页替换当天正文，默认为追加')
  },
  async ({ key, token, text, date, title, mood, weather, tags, replace }) => {
    try {
      const data = await agentApi('/api/socialV2/diary-write', {
        method: 'POST',
        body: JSON.stringify({ key, text, date, title, mood, weather, tags, replace: replace === true }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `日记写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_diary_read',
  '读日记：回看你在本会话的日记本。可按某一天、或日期区间读，缺省读最近一页。用于回答“你还记得昨天吗”“翻翻你的日记”这类问题。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    date: z.string().optional().describe('可选：读某一天，YYYY-MM-DD（写 2026-10 也能按前缀读整月）'),
    from: z.string().optional().describe('可选：区间开始，YYYY-MM-DD'),
    to: z.string().optional().describe('可选：区间结束，YYYY-MM-DD'),
    limit: z.number().int().min(1).max(200).optional().describe('最多读几页，缺省 1（最新一页）')
  },
  async ({ key, token, date, from, to, limit }) => {
    try {
      const q = new URLSearchParams({ key });
      if (date) q.set('date', date);
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      if (limit) q.set('limit', String(limit));
      const data = await agentApi(`/api/socialV2/diary?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `日记读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_diary_list',
  '列日记目录：看你本会话的日记本里有哪些天、标题和篇幅，用来决定翻哪几页（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().int().min(1).max(200).optional().describe('最多列几页，缺省 30')
  },
  async ({ key, token, limit }) => {
    try {
      const q = new URLSearchParams({ key, mode: 'list' });
      if (limit) q.set('limit', String(limit));
      const data = await agentApi(`/api/socialV2/diary?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `日记目录读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交给管理员筛选。提交后进入候选库，管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// 风格手册：把「某种场景该怎么说话」的细则放本地文件，按需读取。
// 细则可以写长（几百到上千字）却不占常驻提示词；改文件即生效，不用重启。
// 场景名与 roles/<角色>.md 里的 `## 场景：xxx` 保持一致，方便对照。
const STYLE_GUIDE_DIR = path.join(__dirname, '..', 'persona-lib', 'style');
function listStyleGuides() {
  try {
    return fs.readdirSync(STYLE_GUIDE_DIR)
      .filter((file) => file.endsWith('.md'))
      .map((file) => {
        const topic = file.replace(/\.md$/i, '');
        let summary = '';
        try {
          const raw = fs.readFileSync(path.join(STYLE_GUIDE_DIR, file), 'utf8');
          summary = (raw.match(/^摘要[:：]\s*(.+)$/m) || [])[1]?.trim() ?? '';
        } catch {}
        return { topic, summary };
      })
      .sort((a, b) => a.topic.localeCompare(b.topic, 'zh'));
  } catch {
    return [];
  }
}

server.tool(
  'qq_style_guide',
  '查某个聊天场景的具体说话细则（好/坏对照 + 例子）。拿不准这类场合怎么开口时先查，比自己硬编更像真人。不传 topic 返回目录。',
  {
    topic: z.string().optional().describe('场景名，例如 情绪倾诉 / 被问是不是AI / 冷场 / 求推荐 / 被怼 / 深夜 / 群聊接梗 / 正经问题'),
  },
  async ({ topic }) => {
    const guides = listStyleGuides();
    if (!guides.length) {
      return { content: [{ type: 'text', text: '风格手册为空：persona-lib/style 下没有 .md 文件。' }], isError: true };
    }
    const wanted = String(topic ?? '').trim();
    if (!wanted) {
      const lines = guides.map((g) => `- ${g.topic}${g.summary ? `：${g.summary}` : ''}`);
      return { content: [{ type: 'text', text: `可用场景：\n${lines.join('\n')}` }] };
    }
    const hit = guides.find((g) => g.topic === wanted)
      ?? guides.find((g) => g.topic.includes(wanted) || wanted.includes(g.topic));
    if (!hit) {
      return { content: [{ type: 'text', text: `没有「${wanted}」这份细则。可用：${guides.map((g) => g.topic).join('、')}` }], isError: true };
    }
    const raw = fs.readFileSync(path.join(STYLE_GUIDE_DIR, `${hit.topic}.md`), 'utf8').trim();
    const text = raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw;
    return { content: [{ type: 'text', text }] };
  }
);

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[表情] 或 hasMedia=true 时调用。支持一条消息里的多张图片/表情；二代模式下必须携带会话令牌。注意：如果返回里明确说没取到，就照实告诉对方没取到/看不清，不要根据上下文编造图片内容。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: mediaMissText(messageId, data?.note || '未找到') }] };
        }
        const content = [];
        const textParts = [];
        let failed = 0;
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            const isTooLarge = /超.*大小|太大/.test(String(img?.text ?? ''));
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''} ${isTooLarge ? MEDIA_TOO_LARGE_SHORT : MEDIA_FAIL_SHORT}]`);
            failed += 1;
          }
        }
        if (textParts.length) {
          const tail = failed > 0 ? `\n${mediaPartialNote(failed)}` : '';
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}${tail}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
        // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
        // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
        const data = await agentApi('/api/socialV2/sticker-list', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.findSticker !== false) {
  server.tool(
    'qq_find_sticker',
    '按“想表达的意思”语义检索收藏表情包（推荐先用这个，而不是 qq_list_stickers 的 query）。'
      + '支持口语化描述，如「有点想哭」「在干活算力跑满」「白嫖到赠金」「被老板催着干活」，'
      + '返回按相关度排序的候选（含 desc/localNote/tags/score/reason）。找到合适的 id 后，用 qq_send_sticker 发送。'
      + '与 qq_list_stickers 的区别：后者是按字段子串过滤的清单，只适合「我知道备注里有什么字」的场景。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().describe('想表达的意思/场景，口语化即可，如「有点想哭」「在摸鱼」'),
      limit: z.number().optional().describe('返回候选条数，默认 5，上限 50')
    },
    async ({ key, token, query, limit }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-search', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: String(query || ''), limit, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `表情检索失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${data?.error || '未知'}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.image?.enabled !== false && cfg.socialV2?.tools?.sendImage !== false) {
  const allowedDirs = Array.isArray(cfg.socialV2?.image?.dirs) ? cfg.socialV2.image.dirs.map((d) => String(d)) : [];
  const dirHint = allowedDirs.length
    ? `本地文件只能放在这些目录里：${allowedDirs.join('、')}（传绝对路径，越界/软链/非图片文件都会被拒绝）。`
    : '当前没有开放任何本地目录，只能发 http(s) 直链图片。';
  server.tool(
    'qq_send_image',
    `在指定会话发送一张普通图片（截图、梗图、下载的图）。两种图片源二选一：url（公开可访问的 http/https 直链）或 path（本机图片绝对路径）。${dirHint}限制：单张不超过 4MB；只认 PNG/JPEG/GIF/WebP（按文件内容判断，改扩展名没用）；内网/本机地址一律拒绝。注意：一条消息要么文字要么图片，不能在同一气泡里附带文字——想说的话请先用 qq_send_message / qq_reply 作为单独气泡发出，再单独发图。note 只用于你自己的记忆，不会随图片发出去。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。`,
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      url: z.string().optional().describe('http/https 图片直链（与 path 二选一）'),
      path: z.string().optional().describe('本机图片绝对路径，必须位于允许目录内（与 url 二选一）'),
      note: z.string().optional().describe('可选的简短备注（最多 60 字），只写进你自己的本地记忆用于记住发过什么，不会随图片发送'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, url, path, note, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-image', {
          method: 'POST',
          body: JSON.stringify({ key, url, path, note, replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        const img = data?.image ?? {};
        const kb = Math.max(1, Math.round(Number(img.bytes ?? 0) / 1024));
        const via = data?.source === 'url' ? 'http 直链' : '本地文件';
        const parts = [`已发送一张图片（${via}，${img.format ?? '图片'} ${kb}KB）`];
        if (data?.verified === true) parts.push('已回读确认消息里确实有图片段');
        if (data?.quoted) parts.push('已引用指定消息');
        return { content: [{ type: 'text', text: parts.join('；') }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.reminder?.enabled !== false && cfg.socialV2?.tools?.reminder !== false) {
  server.tool(
    'qq_set_reminder',
    '给自己的会话设一条定时提醒：到点后桥会自动用现有的发送通道发出去。有两种内容：text（到点原样发出的一句话，最多 500 字）与 prompt（一句任务描述，到点叫醒你自己来组织措辞，比如「提醒他喝水」「看看群里在聊什么，接一句」）。时间给 at（"2026-10-20 09:00" 这种本地时间，或 "21:30" 表示今天/明天那个点）或 delaySeconds（相对秒数）之一；周期任务用 repeat=daily/weekly + clock="HH:MM"（weekly 再给 weekday，1=周一…7=周日）。限制：至少提前 10 秒、最远 90 天、每个会话最多 10 条、全局 50 条、同一会话两条提醒至少隔 2 分钟；到点发送仍受发送白名单与频率限制约束。设完把返回的 id 记下来，取消时要用。这只是「登记一条未来动作」，不是现在就说话。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      text: z.string().optional().describe('到点原样发出的文字（与 prompt 二选一）'),
      prompt: z.string().optional().describe('到点让 AI 自己组织措辞的任务描述（与 text 二选一）'),
      at: z.string().optional().describe('一次性提醒的绝对时间："2026-10-20 09:00" 或 "21:30"（今天/明天该点）'),
      delaySeconds: z.number().optional().describe('一次性提醒的相对秒数（与 at 二选一）'),
      repeat: z.enum(['none', 'daily', 'weekly']).optional().describe('重复方式，默认 none（一次性）'),
      clock: z.string().optional().describe('daily/weekly 的触发时刻，"HH:MM"'),
      weekday: z.number().optional().describe('weekly 的星期几：1=周一 … 7=周日')
    },
    async ({ key, token, text, prompt, at, delaySeconds, repeat, clock, weekday }) => {
      try {
        const data = await agentApi('/api/socialV2/reminder-create', {
          method: 'POST',
          body: JSON.stringify({ key, text, prompt, at, delaySeconds, repeat, clock, weekday }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: `已登记：${data.human}\n（id=${data.id}，下次 ${data.nextRunAtText}；到点由桥自动发送，届时再受白名单与频率限制）` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `设置定时提醒失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_reminders',
    '查看本会话已经登记的定时提醒（含还没有触发的与已经结束的）。不带 key 只看当前会话的。返回 limits 是数量与最小间隔上限。想确认「我刚才那条设上没有」「还剩几条」时用这个。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const data = await agentApi('/api/socialV2/reminder-list', {
          method: 'POST',
          body: JSON.stringify({ key }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `查询定时提醒失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_cancel_reminder',
    '取消一条还没触发的定时提醒。id 来自 qq_set_reminder 的返回或 qq_list_reminders。只能取消本会话的提醒；取消后不会再有那条消息。已经触发/已结束的任务取消会返回 changed=false。',
    {
      id: z.string().describe('提醒 id（rem_ 开头）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ id, token }) => {
      try {
        const data = await agentApi('/api/socialV2/reminder-cancel', {
          method: 'POST',
          body: JSON.stringify({ id }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: `${data.changed ? '已取消' : '该提醒已不在待触发状态'}：${data.reminder?.human ?? data.id}` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `取消定时提醒失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.profile?.enabled !== false && cfg.socialV2?.tools?.profile !== false) {
  server.tool(
    'qq_profile_query',
    '查群友档案（长记忆）：传 person 查某个人（QQ 号）的具体记录，不传则列出所有人的概览。档案里只有具体事例（带日期），没有“他很温柔”这类空泛标签。唤醒提示里已自动带上本会话最近出现的人的高权重记录，只有在需要更详细/更久以前的事例时才调用这个工具。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      person: z.string().optional().describe('要查的群友 QQ 号（4-12 位数字）；不传则返回所有人概览')
    },
    async ({ key, token, person }) => {
      try {
        const q = new URLSearchParams({ key });
        if (person) q.set('person', String(person));
        const data = await agentApi(`/api/socialV2/profile?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (data?.formatted) return { content: [{ type: 'text', text: serializeModelData({ formatted: data.formatted, count: data.count, person: data.person }) }] };
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `查询群友档案失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_profile_write',
    '往群友档案里写一条具体事例（长记忆）。要求：只记"以后还用得上"的具体事实，写清谁在哪天做了什么/说了什么原话，6-160 字；不要写空泛评价（"他很温柔""人很好"会被拒绝）。敏感信息（手机号/身份证/住址/密码/邮箱等）会自动隐去，全是敏感信息的整条会被拒。写入要克制：一段对话结束后最多补 1-3 条真正有价值的，别把每句闲聊都记下来；聊天中已经明显出现的事，桥接自己也会在对话告一段落后自动抽取，不需要你重复劳动。群文化（黑话/梗/群内称呼）用 groupId + term 写。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      personId: z.string().optional().describe('群友 QQ 号（4-12 位数字）；写群文化时可省略'),
      kind: z.enum(['event', 'care', 'avoid', 'topic', 'style', 'nickname', 'note']).optional().describe('记录类型：event=重要事件 / care=在意的事 / avoid=雷点 / topic=常聊话题 / style=说话风格 / nickname=称呼 / note=其它事例'),
      text: z.string().optional().describe('具体事例，6-160 字，写谁在哪天做了什么或原话'),
      at: z.string().optional().describe('事件日期，形如 2026-10-19；不确定就省略'),
      evidence: z.string().optional().describe('最能支撑这条的原话节选，≤80 字'),
      groupId: z.string().optional().describe('写群文化时要传的群号'),
      term: z.string().optional().describe('群文化术语/梗/称呼本身'),
      meaning: z.string().optional().describe('这个术语的意思'),
      termKind: z.enum(['梗', '称呼', '黑话', '其它']).optional().describe('群文化类别'),
      example: z.string().optional().describe('用法的例子')
    },
    async ({ key, token, personId, kind, text, at, evidence, groupId, term, meaning, termKind, example }) => {
      try {
        const data = await agentApi('/api/socialV2/profile-write', {
          method: 'POST',
          body: JSON.stringify({ key, personId, kind, text, at, evidence, groupId, term, meaning, termKind, example }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        if (data?.duplicate) return { content: [{ type: 'text', text: '这条档案已存在（已合并并加了一次"最近被提到"）' }] };
        if (data?.term) return { content: [{ type: 'text', text: `已记下群文化：${data.term.term}` }] };
        return { content: [{ type: 'text', text: `已记下：${data?.record?.text ?? '（已写入）'}` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `写入群友档案失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_profile_remove',
    '删除群友档案里的内容：给 id 删单条；给 text 删包含该文字的那条；给 all:true 删掉这个人的整份档案（不可恢复，谨慎）。群文化术语目前只能通过控制台删。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      personId: z.string().describe('要操作的群友 QQ 号（4-12 位数字）'),
      id: z.string().optional().describe('要删除的记录 id（rec_ 开头）'),
      text: z.string().optional().describe('按内容匹配：删掉包含这段文字的那条记录'),
      all: z.boolean().optional().describe('true = 删掉这个人的整份档案（不可恢复）')
    },
    async ({ key, token, personId, id, text, all }) => {
      try {
        const data = await agentApi('/api/socialV2/profile-remove', {
          method: 'POST',
          body: JSON.stringify({ key, personId, id, text, all: all === true }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: `已删除 ${data?.removed ?? 0} 条` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `删除群友档案失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_profile_clear',
    '清空全部群友档案与群文化（不可恢复）。管理员要求「忘掉这些」时才用；必须显式传 confirm:true。清空后无法找回，调用前先确认用户真的要清空。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      confirm: z.boolean().describe('必须为 true 才会执行（不可恢复）')
    },
    async ({ key, token, confirm }) => {
      try {
        const data = await agentApi('/api/socialV2/profile-clear', {
          method: 'POST',
          body: JSON.stringify({ key, confirm: confirm === true }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        const c = data?.cleared ?? {};
        return { content: [{ type: 'text', text: `已清空：${c.clearedPeople ?? 0} 人、${c.clearedGroups ?? 0} 个群文化` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `清空群友档案失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sendVoice !== false) {
  server.tool(
    'qq_send_voice',
    '在指定会话发一条 QQ 语音（把语音库里准备好的音频当语音条发出去）。voice 传 qq_list_voices 返回的 name（文件名，可带子目录），也可以直接传语音库里的文件名（不带扩展名也能匹配）。注意：① 只能发语音库（qq-bridge/audio/）里的文件，不能发任意本地路径，也不能发 URL/base64；② 受时长与频率上限约束（见 qq_list_voices 的 limits），超限会被拒绝；③ 语音是「开口说话」的强表达，别滥用，闲聊里偶尔发一条即可；④ 返回的 verified=true 表示已经用 get_msg 回读到这条消息的 record 段（语音确实落地了）—— 只有 verified=true 才能对用户说你发了语音；⑤ readback 只对「收到的」语音有意义（QQ 会转写别人的语音），自己发的语音一般拿不到转写文本，默认关闭，别依赖它。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      voice: z.string().describe('语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）'),
      label: z.string().optional().describe('可选：写进会话记录里的说明，如「说了句晚安」'),
      verify: z.boolean().optional().describe('是否回读校验语音已落地（默认 true，建议保持开启）'),
      readback: z.boolean().optional().describe('是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）')
    },
    async ({ key, token, voice, label, verify, readback }) => {
      try {
        const data = await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key,
            voice: String(voice),
            label: label || '',
            verify: verify !== false,
            readback: readback === true,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送语音失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_voices',
    '查看可用的语音库（qq-bridge 的 audio 目录里准备好的音频文件）：文件名、时长、大小。想发语音前先调用这个看有哪些能发（名字用返回的 name）。返回里 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      probe: z.boolean().optional().describe('是否逐个探测时长（默认 true；文件多时可传 false 加快）')
    },
    async ({ key, token, probe }) => {
      try {
        const q = new URLSearchParams({ key });
        if (probe === false) q.set('probe', '0');
        const data = await agentApi(`/api/socialV2/voices?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取语音库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 语音合成发送（edge-tts / MiniMax 双引擎）────────────────────────────────
// 为什么不挂 socialV2.tools 开关：它自己有一道 voiceTts.enabled 闸门，而且 P1 验收明确要求
// 「关掉后调用必须返回清晰错误，而不是整个工具消失/卡住」。工具常驻（归 media 组），
// 调用期再按 voiceTts.enabled 决定放不放行。
server.tool(
  'send_tts_voice',
  '把一句话现场合成成你自己的声音，再当成 QQ 语音条发出去（语音比文字更有情绪；想让人听见的时候就主动用，一天几条到十几条都自然，只是别每条都发）。mood 决定声线：calm 平静（默认）、happy 开心、shy 害羞、annoyed 嫌弃、sad 难过。按交流动作选 mood：接话/安慰→calm（对方确实低落才 sad），庆祝→happy，语境明确是玩笑才 annoyed，告别→calm（真不舍才 sad），别把普通「拜拜」渲染成伤感。表达意图优先于情绪强度：大部分日常回应克制点，别每条都在表演。语言：**语音条一律用日语说**，聊天正文照旧用中文；text 写的是「嘴里说出来的日语」——日常口语，不是把中文逐字翻过去，也不是动漫台词腔，不写罗马字、不混中文。场景短句（晚安/早安/恭喜/想你/哼/再见，20 字内）桥接会自动配一条日语语音加字幕，这条不用再调本工具重复发。音色只是借来的一副嗓子：说话的人始终是你自己（小鲸鱼），别因为音色来源换成别的角色、改名换称呼，或模仿来源作品的口癖与人设。文案规则（像即时私聊，不像朗读稿）：① 先回应对方刚说的具体内容，再表达态度，不要只发「うん」这类泛化短句；② 一句只做一个交流动作（确认、安慰、庆祝、调侃、告别别堆在同一句）；③ 常用 8–16 字（汉字假名混计），语义需要可到 24 字，超过会被拆成两条，结尾不写「。」；④ 语气词（ね、よ、さ、かな、って）只在口语自然处出现，不要每条都加，也不要用「えっと」凑时长；⑤ 不用书面连接词（したがって、つまり、综上所述）；⑥ 不要连续几条重复同一个开头、同一个句尾或同一套撒娇模板；⑦ 不编造现实经历——可以表达感受和回应，不能声称刚做了某事或听见了环境声；⑧ 复杂说明、数字、链接、列表改用文字，语音只给有情绪价值或适合口头说的人话。合成失败、被限流或桥接拒绝时，工具会返回 error，这时**必须改用文字把同样的话说出来**，不要假装发了语音、也不要重复硬试。**调用时请一并传 translation**：这句日语的中文翻译（口语短句、不写引号），只用于字幕、不参与发音；漏传就只剩日语字幕。**发成功后桥接会自动把这段日语原文补成一条文字（字幕）**，返回值里的 echo 就是它；如果这次带了 translation，字幕第二行直接就是这句中文（不加「中文：」标签）；你不需要再手动发一遍同样的内容，也别再说「我发了语音」——对方已经能同时看到语音和原文。时长会被夹到 2–60 秒：太短会降语速/垫语气词，太长会截断。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    text: z.string().describe('要说的话：**日语口语**（聊天正文仍用中文）；先回应对方具体内容，一句只做一个交流动作；8–16 字最自然，最多 24 字（超 24 字会拆两条）；结尾不写「。」、不塞 URL/代码/长列表/颜文字；语气词按语义用，别每条都加；不要引入音色来源角色的设定或口癖'),
    translation: z.string().optional().describe('text 的中文翻译（口语短句，不写「」、不写「日语」二字）。会直接作为字幕第二行发出；不传就只发日语字幕'),
    mood: z.string().optional().describe('情绪：calm / happy / shy / annoyed / sad，默认 calm'),
    target: z.string().optional().describe('可选：改发到另一个会话（同 key 格式）。默认就发 key 指的那个会话')
  },
  async ({ key, token, text, mood, target, translation }) => {
    const cfgNow = getConfig();
    const ttsCfg = voiceTtsConfig(cfgNow);
    if (!ttsCfg.enabled) {
      return {
        content: [{ type: 'text', text: '语音合成未启用：config.json 的 voiceTts.enabled 为 false（改完不用重启桥接，下次调用即生效）。请直接用文字说这句话。' }],
        isError: true
      };
    }
    const said = String(text ?? '').trim();
    if (!said) {
      return { content: [{ type: 'text', text: 'text 是空的，没东西可念。' }], isError: true };
    }
    // 中文翻译只用于字幕，不参与合成；超出两条被拆开时整句翻译跟在最后一条字幕后面。
    const zh = String(translation ?? '').trim();
    // 语言守门：音色是 Minmax 克隆音色 + language_boost=Japanese，文案里没假名等于让它用
    // 日语读音去念中文，会变成谁也听不懂的混读。这里只提醒不拦截（专有名词/拟声词仍可发）。
    const jaVoice = ttsCfg.engine === 'minimax' && /^japanese$/i.test(String(ttsCfg.minimax?.language ?? ''));
    const kanaHint = jaVoice && !/[\u3040-\u30ff]/u.test(said)
      ? '文案里没有假名：当前音色设了 Japanese，中文会被读成日语腔的混读。语音条请用日语说，中文字幕/解释放正文。'
      : '';
    // 调用期字数规则（不只靠描述提醒模型）：超过单条上限就按标点拆成最多两条语音；
    // 两条还装不下时明确拒绝并让模型改用文字，而不是截断内容或硬念一段长稿。
    const plan = splitForTts(said, ttsCfg.splitChars ?? 15, 2);
    if (!plan.chunks.length) {
      return { content: [{ type: 'text', text: 'text 是空的，没东西可念。' }], isError: true };
    }
    if (plan.overflow) {
      return {
        content: [{
          type: 'text',
          text: `这段话 ${plan.chars} 字，拆成语音条要 ${plan.totalChunks} 条（一次最多 2 条）。请压到 ${ttsCfg.splitChars ?? 15} 字以内，或分两次调用 send_tts_voice；也可以直接用文字说。`
        }],
        isError: true
      };
    }
    /** @type {{lib:string}[]} */
    const stagedFiles = [];
    const sent = [];
    const warnings = [];
    try {
      for (const [chunkIndex, chunk] of plan.chunks.entries()) {
        const synth = await synthesize(chunk, mood || 'calm', cfgNow);
        const staged = stageIntoLibrary(synth.filePath, ttsCfg);
        stagedFiles.push({ lib: staged.absPath });
        synth.filePath = null; // 已移入语音库，finally 只清库内那份
        const data = await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key: target || key,
            voice: staged.relPath,
            label: synth.spokenText,
            // 语音条发完后桥接会自动补一条「语音原文」文字（socialV2.voice.echoText），
            // 这里把合成用的原话交过去，保证字幕与嘴里说的逐字一致。
            echoText: synth.spokenText,
            // 中文翻译只跟最后一条字幕走：整句翻译放在前半句后面会读着错位。
            translation: chunkIndex === plan.chunks.length - 1 ? zh : '',
            verify: true,
            readback: false,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        sent.push({
          messageId: data?.messageId ?? null,
          file: data?.file ?? null,
          detail: data?.detail ?? null,
          verified: data?.verified ?? null,
          // 桥接补发的「语音原文」文字：ok=false 时只说明字幕没补上，语音本身已发出
          echo: data?.echo ?? null,
          // 中文翻译是否随字幕发出（桥接原样回报，方便模型确认自己没漏传）
          translation: data?.echo?.translation ?? null,
          mood: synth.mood,
          voiceName: synth.voice,
          seconds: synth.seconds,
          spokenText: synth.spokenText
        });
        if (synth.warnings?.length) warnings.push(...synth.warnings);
      }
      if (kanaHint) warnings.push(kanaHint);
      const first = sent[0] || {};
      const payload = sent.length === 1
        ? { ...first, warnings }
        : { ok: true, count: sent.length, chunks: plan.chunks, messages: sent, warnings };
      return { content: [{ type: 'text', text: serializeModelData(payload) }] };
    } catch (error) {
      const done = sent.length
        ? `已经发出 ${sent.length} 条（${sent.map((m) => m.spokenText).join(' / ')}），后面的没发出去：`
        : '';
      return {
        content: [{
          type: 'text',
          text: `发语音失败：${done}${error?.message ?? error}。剩下的请改用文字说出来，不要假装已发语音。`
        }],
        isError: true
      };
    } finally {
      // 语音库里的中间文件必须删掉（P1 验收④：发送后 state/tmp/voice 为空、audio/.tts 无残留）；
      // 临时 mp3 由 synthesize 自己负责清理（成功时只剩已移库的那份）。
      for (const item of stagedFiles) {
        try { fs.unlinkSync(item.lib); } catch {}
      }
    }
  }
);

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '查看你自己的默认 Q 版形象图片（DeepSeek 小鲸鱼形象）。当你被问“你长什么样/发张自拍/你是什么形象”时，可以调用这个工具看自己的样子；返回的图片会直接进入你的视觉上下文。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${data?.error || '未知'}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: serializeModelData(data) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 机器人自身资料管理：换头像 / 改昵称 / 改签名 ──────────────────────────────
//
// 为什么要加：管理员让机器人「换个头像」时，QQ 端 agent 手上没有任何改资料的
// 工具，只能回一句「我没有这个能力」，任务直接失败（2026-10-18 实测）。
//
// 安全边界：这三个动作改的是**机器人账号本身**。授权分两条路：
//   1. 封闭 agent 模式（管理员私聊）：直接放行——本来就只有管理员在跟它说话；
//   2. 其它模式（含 reserved2 仿真）：必须带 key + token，由桥接确认这个会话
//      就是管理员私聊（bridge.js 的 /api/socialV2/manage）。
// 不能只看「MCP 进程有没有控制台令牌」——那等于给每个群的 AI 发账号管理权。
async function currentBridgeMode() {
  // 先读落盘的 state/mode.json：它由桥接与控制台共同维护，比 /api/status 更稳
  // （/api/status 对「智能体调用」只返回最小对象，而且鉴权策略变动过几次）。
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'state', 'mode.json'), 'utf8');
    const mode = String(JSON.parse(raw)?.mode ?? '').trim();
    if (mode) return mode;
  } catch {}
  try {
    return String((await agentApi('/api/status'))?.mode ?? '');
  } catch {
    return '';
  }
}

async function authorizeManage({ key, token }) {
  const mode = await currentBridgeMode();
  if (mode === 'closed-agent') return { ok: true, mode };
  if (!key || !token) {
    return {
      ok: false,
      mode,
      error: `当前模式（${mode || '未知'}）下改机器人资料必须带 key（形如 private:管理员QQ）和 token（会话令牌）；封闭 agent 模式才可省略。`,
    };
  }
  try {
    const res = await agentApi('/api/socialV2/manage', {
      method: 'POST',
      body: JSON.stringify({ action: 'whoami', key }),
      headers: { 'x-agent-token': token },
    });
    if (!res?.owner) return { ok: false, mode, error: '只有管理员私聊可以改机器人资料。' };
    return { ok: true, mode, key, token };
  } catch (error) {
    return { ok: false, mode, error: `无法校验会话令牌：${error?.message ?? error}` };
  }
}

async function manageCall(auth, payload) {
  // key 必须一起带上：桥接用 key + x-agent-token 做「这个令牌能不能动这个会话」的绑定校验，
  // 少发 key 会被判成 agent token 无效（不是「没权限」，是「不知道你要动谁」）。
  const body = auth.key ? { ...payload, key: auth.key } : { ...payload };
  const init = { method: 'POST', body: JSON.stringify(body) };
  if (auth.token) init.headers = { 'x-agent-token': auth.token };
  return agentApi('/api/socialV2/manage', init);
}

function manageEnabled(flag) {
  const manage = getConfig().manage ?? {};
  if (manage.enabled === false) return false;
  if (flag && manage[flag] === false) return false;
  return true;
}

const MANAGE_REJECT = (auth) => ({ content: [{ type: 'text', text: `未授权：${auth.error}` }], isError: true });

if (manageEnabled('avatar')) {
  server.tool(
    'qq_set_avatar',
    `更换机器人自己的 QQ 头像（写操作，账号级）。两种给图方式，二选一：
- file：本机绝对路径（png/jpg，建议正方形、≥640×640）、http(s) 图片直链，或 base64:// 数据；
- messageId：直接用某条聊天消息里的第一张图（管理员刚在 QQ 里发了一张图说「换成这个」时用这个，配 key 一起传）。
换头像不需要先把图存到本机：只要图在聊天记录里能读到就行。封闭 agent 模式不用带 key/token；其它模式必须带。`,
    {
      file: z.string().optional().describe('头像来源：本机绝对路径 / http(s) 直链 / base64:// 数据；用 messageId 时不要传'),
      messageId: z.string().optional().describe('从这条消息里的第一张图取头像（需同时给 key）；与 file 二选一'),
      key: z.string().optional().describe('会话 key（private:QQ号），封闭 agent 模式可省；用 messageId 时必填'),
      token: z.string().optional().describe('会话令牌，封闭 agent 模式可省'),
    },
    async ({ file, messageId, key, token }) => {
      const source = String(file ?? '').trim();
      const ref = String(messageId ?? '').trim();
      if (!source && !ref) return { content: [{ type: 'text', text: 'file 和 messageId 至少给一个' }], isError: true };
      if (ref && !source && !String(key ?? '').trim()) {
        return { content: [{ type: 'text', text: '用 messageId 设头像时必须带 key（形如 private:QQ号），否则桥接不知道去哪条会话里找这张图' }], isError: true };
      }
      const auth = await authorizeManage({ key, token });
      if (!auth.ok) return MANAGE_REJECT(auth);
      try {
        const payload = { action: 'avatar' };
        if (source) payload.file = source;
        if (ref) payload.messageId = ref;
        const res = await manageCall(auth, payload);
        const label = ref ? `取自消息 ${ref} 的图片` : source;
        return { content: [{ type: 'text', text: `头像已提交更换：${label}\n（QQ 客户端缓存可能要几秒到几分钟才刷新）` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `更换头像失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (manageEnabled('profile')) {
  server.tool(
    'qq_set_profile',
    '修改机器人自己的 QQ 资料（写操作，账号级）：昵称 nickname、个性说明 personal_note。只传要改的字段，没传的保持原样。封闭 agent 模式不用带 key/token；其它模式必须带。',
    {
      nickname: z.string().min(1).max(36).optional().describe('新昵称（1–36 字符）；不改就别传'),
      personal_note: z.string().max(200).optional().describe('新的个性说明；不改就别传'),
      key: z.string().optional().describe('会话 key（private:QQ号），封闭 agent 模式可省'),
      token: z.string().optional().describe('会话令牌，封闭 agent 模式可省'),
    },
    async ({ nickname, personal_note, key, token }) => {
      if (nickname === undefined && personal_note === undefined) {
        return { content: [{ type: 'text', text: '至少要给 nickname 或 personal_note 之一' }], isError: true };
      }
      const auth = await authorizeManage({ key, token });
      if (!auth.ok) return MANAGE_REJECT(auth);
      const payload = { action: 'profile' };
      if (nickname !== undefined) payload.nickname = String(nickname);
      if (personal_note !== undefined) payload.personal_note = String(personal_note);
      try {
        await manageCall(auth, payload);
        const changed = Object.keys(payload).filter((k) => k !== 'action')
          .map((k) => (k === 'nickname' ? `昵称→${payload.nickname}` : `个性说明→${payload.personal_note}`)).join('；');
        return { content: [{ type: 'text', text: `资料已提交修改：${changed}` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改资料失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (manageEnabled('signature')) {
  server.tool(
    'qq_set_signature',
    '修改机器人自己的 QQ 个性签名（写操作，账号级；动的是 QQ 资料卡上的签名文本）。封闭 agent 模式不用带 key/token；其它模式必须带。',
    {
      text: z.string().max(300).describe('新的个性签名文本（≤300 字符），传空字符串表示清空'),
      key: z.string().optional().describe('会话 key（private:QQ号），封闭 agent 模式可省'),
      token: z.string().optional().describe('会话令牌，封闭 agent 模式可省'),
    },
    async ({ text, key, token }) => {
      const auth = await authorizeManage({ key, token });
      if (!auth.ok) return MANAGE_REJECT(auth);
      try {
        await manageCall(auth, { action: 'signature', text: String(text ?? '') });
        return { content: [{ type: 'text', text: `个性签名已提交修改：${String(text ?? '') || '（清空）'}` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改签名失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── QQ 端 → 桌面端 DSH 会话的命令通道 ────────────────────────────────────────
//
// 流程：入队落盘（state/desk-commands.json）→ 规则引擎审核 → 作为一条排队消息投递进
// 桌面端会话。审核结论 high 的命令**照样投递**，但消息体里明确要求桌面端先找用户确认，
// 这样高危命令不会因为「agent 判断错了」而悄悄执行。
if (manageEnabled('deskCommand')) {
  server.tool(
    'qq_desk_command',
    `把一条命令/请求转给桌面端（电脑上的 DeepSeek Harness）去执行。

投递前会跑一遍确定性规则审核，返回 verdict：
- low：低风险，桌面端可以直接做；
- review：可做，但桌面端必须把命中的风险点讲清楚；
- high：禁止自动执行，桌面端会先来问用户「是否允许」。

什么时候用：用户让你在**电脑上**做事（整理文件、跑脚本、查配置、看日志、开程序），
而 QQ 端自己做不了时。命令写成给桌面 agent 看的自然语言或 shell 都行，但要把
目标路径、期望结果写清楚。别用它来「聊天」——聊天直接回消息。`,
    {
      command: z.string().min(1).max(4000).describe('要桌面端执行的命令或请求原文'),
      reason: z.string().max(500).optional().describe('为什么发这条命令（会一起带给桌面端）'),
      deliver: z.boolean().optional().describe('是否立刻投递，默认 true；false 只入队+审核'),
      key: z.string().optional().describe('会话 key（private:QQ号），封闭 agent 模式可省'),
      token: z.string().optional().describe('会话令牌，封闭 agent 模式可省'),
    },
    async ({ command, reason, deliver, key, token }) => {
      const auth = await authorizeManage({ key, token });
      if (!auth.ok) return MANAGE_REJECT(auth);
      try {
        const { enqueue } = await import('../scripts/desk-command.mjs');
        const { record, delivered, blocked } = await enqueue({
          command: String(command),
          reason: String(reason ?? ''),
          source: 'qq',
          deliver: deliver !== false,
        });
        const a = record.audit;
        const lines = [
          `命令 #${record.id} 已${blocked ? '拦截' : delivered ? '投递到桌面端' : '入队（未投递）'}`,
          `审核：${String(a.verdict).toUpperCase()}（风险分 ${a.score}）`,
          `要点：${a.summary}`,
          a.hits.length ? `命中：\n${a.hits.map((h) => `- [${h.sev}] ${h.label}${h.match ? `（${h.match}）` : ''}`).join('\n')}` : '',
          `处置：${a.advice}`,
          record.error ? `错误：${record.error}` : '',
          delivered ? '桌面端收到后会按审核结论处理；结果要等它回你。' : '',
        ].filter(Boolean);
        return { content: [{ type: 'text', text: lines.join('\n') }], ...(a.verdict === 'high' ? {} : {}) };
      } catch (error) {
        return { content: [{ type: 'text', text: `投递失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// 启动时把真实工具面报到 stderr（DSH 会把它收进 dsh.log）。
// 存在的理由：分组裁剪是**注册期静默丢弃**，控制台/配置看着一切正常，模型却根本看不到
// 那个工具——2026-10-25 的 qq_set_avatar 就是这么消失的。排这类故障第一步就是确认
// 「这个进程到底注册了几个、裁掉了哪些」，而不是去猜模型为什么不调。
if (!process.env.QQ_BRIDGE_MCP_NO_LOG) {
  try {
    console.error(
      `[mcp-snowluma] 工具面：注册 ${registeredCount} 个，裁剪 ${disabledTools.length} 个`
      + `；分组=${enabledGroups ? [...enabledGroups].join('+') : '全量（未配置 mcp.toolGroups）'}`
      + (disabledTools.length ? `；被裁：${disabledTools.join(', ')}` : '')
    );
  } catch { /* 日志失败不许影响 MCP 启动 */ }
}

await server.connect(new StdioServerTransport());
