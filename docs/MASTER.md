# QQ 端总纲（MASTER）

> **这份文件解决什么问题**：仓库里有 42 篇 docs、73 个 src 文件、184 个 scripts、一个 840KB 的主程序，但没有一篇从「整体」讲到「局部」的入口。本文就是那篇入口：先给骨架（系统是什么、怎么跑、谁管谁），再给地图（哪个文件负责哪件事），最后给索引（深挖时该读哪篇）。
>
> **不重复的内容**：实现细节不在这里展开，只在需要时给出指向。数字与路径核对时间：**2026-11-07**。
>
> **三种读法**：①只想起服务 → 第 2、8 节；②想改行为/人设 → 第 3、4.3、6 节 + [OPTIMIZATION-MASTER.md](OPTIMIZATION-MASTER.md)；③想省钱/查账 → 第 1.3、4.6、8 节 + [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md)。

---

## 0. 三分钟读懂

**是什么**：一个常驻桥接程序（`qq-bridge`，v0.2.0-r3，Node ESM），把 QQ 的 OneBot 事件转成 DSH 会话输入，再把模型的决定通过 MCP 工具（发消息/发语音/发表情/定时提醒）落回 QQ。人格由角色卡驱动，不聊天时潜水，靠定时唤醒 + 触发条件被叫醒。

**不是什么**（避免误判，这几条界定了整个设计）：

| 不是 | 原因 / 出处 |
| --- | --- |
| 不是 QQ 机器人框架 | 不内嵌 OneBot 实现，只当客户端连 SnowLuma（`@snowluma/sdk` 的 WS 客户端） |
| 不负责启动/停止 SnowLuma | v0.1.5 起从 MCP 工具面移除，遵守 SnowLuma EULA §5.4；启动由外部编排器 `qqbot/` 负责 |
| 不是群管理机器人 | 无禁言/踢人/撤回/文件收发；工具面是人为收窄的安全子集 |
| 模型不会「自动回复」 | AI 的文本输出不会自动发 QQ，**必须显式调用发送工具**；不调用就等于这句没说 |
| 不是无状态转发 | 每个 QQ 会话绑定一个持久 DSH 会话，历史在 DSH 侧累积（这也是成本根源，见 1.3） |

**一条消息的极简链路**：QQ → SnowLuma（OneBot WS 3001） → 桥接（3100 控制台） → DSH（3080） → 模型。

---

## 1. 拓扑与数据流

### 1.1 五层链路

```
QQ 客户端
   │  OneBot v11 协议
   ▼
SnowLuma（QQ 侧 hook + OneBot 实现）      WS :3001 / HTTP :3000
   │  事件推送 / 动作 API
   ▼
qq-bridge（Node 常驻，src/bridge.js）      控制台 :3100
   │  DSH 客户端协议（Cookie 鉴权 + 斜杠 RPC + remote.mux 事件流）
   ▼
DSH（agent 运行时 + 模型网关）             Web :3080
   │  session.selectModel 逐会话固定模型
   ▼
deepseek-flash（DeepSeek-V41-Flash，多模态，1,048,576 token 窗口）
```

桥接对 DSH 的调用形态：`/api/<namespace>/<method>` 斜杠 RPC；事件流走 `/api/remote.mux` + session/follow；读会话用 `session/control` 队列的 `value.projections[id].values.inbox`。鉴权靠本机持久化签名密钥铸造的会话 Cookie（不需要 DSH token）。

### 1.2 一个 QQ 会话 = 一个 DSH 会话

- 会话 key 形如 `private:<QQ号>` / `group:<群号>`，映射持久化在 `state/sessions.json`：
  `{"sessions":{"private:100000001":"session-69f0d692-…"},"sessionPolicies":{"private:100000001":"[\"reserved2\",\"qq-chat-v2\",null]"}}`
- 所有 QQ 会话归入同一个 DSH 工作区「QQ 聊天」。
- 会话**在创建时**固化当时的模式 + preset + 管理员边界（`sessionPolicies`）。权限变了不迁移老会话，而是撤销映射、下次消息重建——这是「改模式后要重新开口」的原因。
- preset 决定工具面：`qq-chat`（一代）／`qq-chat-v2`（二代仿真，默认）。preset 由 `plugins/qq-agent-presets` 以 bundle patch 注入 DSH profile，**改完必须重装并重启 DSH**。

### 1.3 一轮的生命周期（成本结构从这里来）

```
消息到达 → 触发唤醒（reason: message / proactive / timeout / replyCheck…）
        → buildWakePromptV2() 组装提示词（17 段，顺序固定）
        → deliverPrompt() 送进该会话
        → 模型输出 ┬ ① 调工具（发消息/等待/查档案…）→ 回到「模型输出」，进入下一步
                   └ ② 结束本轮 + 设置下次唤醒条件
```

关键事实：**DSH 不保存跨轮状态，每一步都是一次完整 LLM 请求**，输入 = 系统提示词 + 该会话截至目前的全部历史 + 本次新增。所以「一次唤醒里调 3 次工具」= 3 次请求，且每次重放同体积历史。这个乘积（历史体积 × 步数）就是成本曲线的主体，也是 [OPTIMIZATION-MASTER.md](OPTIMIZATION-MASTER.md) 第 3 节的出发点。

### 1.4 会话只有四种退役方式

`ensureSession()`：既有 session 且代际匹配 → 直接复用。只有 ①用户 `/reset` ②控制台「清上下文」③模式/权限变更 ④DSH 侧会话丢失 才 `retireSession()`。**没有**按轮数/时间/体积的自动轮换——所以水位只会单调上涨，直到人工干预。

---

## 2. 运行形态（本机部署实况）

| 组件 | 位置 | 端口 / 产物 | 谁启动 |
| --- | --- | --- | --- |
| QQ 客户端 + hook | 外部 | — | 人手动登录（扫码） |
| SnowLuma | 外部安装 | WS :3001，HTTP :3000 | `qqbot/` 编排器 `ensureSnowLuma` |
| qqbridge（桥） | `qq-bridge/src/bridge.js` | :3100 控制台 | `qqbot/` 编排器 `ensureBridge`；另有独立看门狗 |
| DSH | 本机 | :3080 | `qqbot/` 编排器 `ensureDsh` |
| 采样代理 | `src/sampling-proxy.js` | 由编排器按需拉起 | `ensureSamplingProxy` |
| 手机桥 | `../bridge/dsh-mobile-bridge.cjs` | :8899 / :8443(HTTPS) | 独立 watchdog（与 QQ 链路解耦） |
| 夜间记忆索引 | `../memory-index/nightly.py` | 计划任务 nightly.vbs | 计划任务 |

**一键编排 `qqbot/`**（工作区内，不在本仓库）：`node qqbot.mjs up|down|status|console`，up 按序做八件事——SnowLuma 在线 → QQ 进程 → hook 注入 → OneBot → 采样代理 → DSH → 桥 → 控制台；每步都有 `ensure*` 幂等检查和 `waitFor` 超时。`up` 结束后拉起隐藏窗口（`run-hidden.vbs`），计划任务 + `watchdog.ps1` 负责自愈。启动脚本族：`start-qqbot.bat`、`stop-qqbot.bat`、`start-qqbot-diag.bat`、`autostart*.vbs`、`install-watchdog.ps1`。

**静态资源**：`public/` 下 9 个正式文件 + 2 个 `.bak`——`console.html`（252KB 主控制台）、`dashboard.html`（看板）、`mobile.html`（手机版）、`ops.html`（运维面板）、`stickers-debug.html`、PWA 清单 `manifest.webmanifest` 与 `sw.js`、`icon-192/512.png`。

---

## 3. 四种运行模式与权限

### 3.1 模式表

| 模式 | 谁的消息会进来 | preset | 用途 |
| --- | --- | --- | --- |
| `chat` | `allow.groups` / `allow.private` 白名单 | `qq-chat` | 日常聊天（默认安全档） |
| `closed-agent` | 仅 owner 私聊 | DSH 默认 preset（通常 standard，**完整工具**） | 用 QQ 私聊遥控本机 DSH |
| `reserved` | 暂同 chat | `qq-chat` | 一代仿真：观望/活跃/试探/退场状态机，空格分句 |
| `reserved2` | 暂同 chat | `qq-chat-v2` | 二代仿真：AI 用 `qq_get_unread_messages` / `qq_send_message` 自主收发（当前实际运行档） |

模式切换：控制台顶部按钮，或改 DSH 设置 `qq-mode` 命名空间；控制台同时写穿 DSH 设置与 `state/mode.json`，桥接每 5 秒读一次。**DSH 设置页没有 qq-mode 卡片**（插件只实现了 host 半），不要在那里找。

当前实测：`state/mode.json` = `reserved2`；`state/current-role.json` = `{"role":"小鲸鱼","mode":"active"}`。

### 3.2 权限分层（高 → 低）

| 层 | 身份 | 能做什么 |
| --- | --- | --- |
| L0 控制台 | 本机浏览器 + `state/console-token` | 切模式、改角色/静默、看活动日志、开 QQ 会话、完整 DSH 工具 |
| L1 管理员 | `ownerQQ` | 正常聊天；管理命令由**桥接硬执行、不经模型**：`/role <名>`、`/role off`、`/silent`、`/active`、`/reset`、`/status`；消息带【管理员】标记 |
| L2 群友 | 白名单内其他 QQ | 仅正常聊天；控制词与 `/` 命令被拦截；静默模式下不投递（只记日志） |
| L3 QQ 会话 agent | 模型自身 | 最低权限面，见下 |

### 3.3 QQ agent 的九条硬边界

1. **无本地工具**：`qq-chat` / `qq-chat-v2` 不挂 bash/pwsh/文件读写/子代理/工作流。
2. **QQ 动作安全子集**：只允许 `mcp__snowluma__*`、`mcp__snowluma-host__*`、`mcp__web-search-safe__*`，外加 `ask_user_question`、`todo_write`；其余由 `qq-tool-restrict.mjs` 拒绝。
3. **只读联网**：内置 tool-web 的 search/fetch 已关；走 `web-search-safe`，带 SSRF 加固（仅 http/https、禁 localhost/私有 IP/链路本地/CGNAT/带凭据 URL、DNS 全量校验、每跳重定向复核、响应体限量）。
4. **发送强制白名单**：所有发送类工具目标必须命中 `allow.groups` / `allow.private`。
5. **语音额外收紧**：`qq_send_voice` 只能发 `socialV2.voice.dir`（默认 `qq-bridge/audio/`）内的文件，不能任意路径/URL/base64；有独立时长/体积/频率上限。
6. **发送禁令（模型层）**：只有管理端明确指示或【管理员】标记要求时才可用发送工具；禁止「我已回复」类汇报。
7. **回复审计**：内容含本机路径（`C:\`、`/home/`）或凭据特征 → 整条拦截并告知「被安全策略拦截」。
8. **人格由桥接注入**：`state/current-role.json` + `roles/<角色>.md`；群友口头改角色无效。
9. **静默模式**：`current-role.json` 的 `mode:"silent"` 时，群友消息不投递，仅记日志。

---

## 4. 代码地图

`src/` 73 个文件（仅 `core/` 一个子目录，2 文件）。`bridge.js` 是约 840KB 的单体主程序，承担编排、会话、唤醒、发送、控制台路由；其余是按职责拆出的共享库。下表按「你改什么会碰到谁」分组，只列有份量的文件。

### 4.1 桥接内核与协议

| 文件 | 职责 |
| --- | --- |
| `src/bridge.js`（840KB） | 主程序：消息路由、模式判定、唤醒调度、prompt 组装、控制台 HTTP 路由、管理员命令 |
| `src/dsh-client.js`（44.5KB） | DSH 客户端：Cookie 铸造、斜杠 RPC、mux 事件流、inbox 读取、会话选择 |
| `src/snowluma-conn.js`（9.6KB） | SnowLuma 连接封装（事件/动作 API，独立工具也复用） |
| `src/mcp-snowluma-safe.js`（113KB） | 主 MCP server：QQ 动作安全子集（约 55 个工具）+ 发送白名单校验 |
| `src/mcp-host-server.js`（4.5KB） | 第二 MCP server：只暴露 `snowluma_status` |
| `src/mcp-web-search-safe.js`（4.1KB） | 第三 MCP server：只读 web_search / web_fetch + SSRF 防护 |
| `src/safe-fetch.js`（12.4KB） | SSRF 校验与限量抓取实现 |
| `src/sampling-proxy.js`（6.7KB） | 模型采样参数代理（温度等按会话注入） |
| `src/v2-wait.js` / `src/ops-wait-store.mjs` | 二代「等待新消息」的挂起/恢复状态 |

### 4.2 发送、媒体与外设

`send-image-lib.js`、`send-voice-lib.js`、`inline-media.js`、`media-note.js`、`media-index.js`、`forward.js`、`zip.mjs`、`md-to-plain.js`（QQ 不吃 Markdown）、`sensitive.js`、`sticker-lib.js` + `sticker-index.js` + `auto-sticker.mjs`。

### 4.3 表达层（「像不像人」）

`ai-tone.js`（AI 味检测/改写）、`ai-tone-stats.js`、`length-gate.js`（长度硬闸）、`fewshot-lib.js`（少样本素材）、`scene-router.js`（场景路由）、`role-card.js` + `persona-lib/`（人格卡与素材）、`preset-prompt.js`（提示词片段拼装）、`slang-learner.js`（黑话学习）。
理论、参数与 37 条发送层硬过滤见 [OPTIMIZATION-MASTER.md](OPTIMIZATION-MASTER.md)、[AI-TONE-SOLUTION.md](AI-TONE-SOLUTION.md)、[SAMPLING.md](SAMPLING.md)、[PERSONA-LAYERS.md](PERSONA-LAYERS.md)、[FEWSHOT.md](FEWSHOT.md)。

### 4.4 记忆与上下文

`profiles.js` + `profile-slice.mjs`（群友档案，五层记忆）、`memory-decay.mjs`（衰减）、`handoff.mjs`（会话交接摘要）、`context-budget.mjs`（预算）、`wake-history.mjs`（唤醒历史）、`turn-visibility.mjs`（轮可见性）、`catch-up.mjs`（补历史）、`diary.js`（日记）。

### 4.5 主动性与时间

`reminders.js` + `reminder-nudge.js`（提醒与催促）、`proactive-contact.js`（主动联系）、`daily-brief.mjs`（每日简报）、`weekly-report.mjs`（周报）。

### 4.6 成本与计量

`token-ledger.js`（41.4KB 账单）、`model-prices.js`、`cost-guard.mjs`、`rate-limit.mjs`、`conn-quality.mjs`（连接质量）。

### 4.7 运维与面板

`health.mjs`（健康时序）、`doctor.mjs`（体检）、`self-test.js`、`backup.mjs`、`clean-state.mjs`、`dashboard.js`、`ops-panel.js`、`state-acl.mjs`。

### 4.8 DSH 侧与插件

| 位置 | 作用 |
| --- | --- |
| `dsh/agent-presets/qq-chat/`（`agent.cordis.yml` 7.8KB） | 一代 preset 权威源 |
| `dsh/agent-presets/qq-chat-v2/`（26.9KB） | 二代 preset 权威源 |
| `plugins/qq-agent-presets/` | 打包两个 preset 行 + 唯一权威的 `qq-tool-restrict.mjs` |
| `plugins/qq-mode-console/` | 暴露 `qq-mode` 设置命名空间（仅 host 半，无 UI 卡片） |

改 preset 的正确姿势：改 `dsh/` 源 → `scripts/build-agent-preset-patches.mjs` 生成 `plugins/qq-agent-presets/presets/*.patch.yml` → 重装/重启 DSH。直接改 `plugins/` 里的 patch 会被下次生成覆盖。

---

## 5. 能力清单（从使用者视角）

| 能做什么 | 入口 / 文档 |
| --- | --- |
| 日常聊天、群聊潜水+被叫醒 | 模式 `chat`/`reserved2`，见 [RULES.md](../RULES.md) |
| 发语音（只有 audio/ 内文件） | [guides/TTS-VOICE.md](guides/TTS-VOICE.md) |
| 发图片、发表情包（索引+收藏） | [guides/SEND_IMAGE.md](guides/SEND_IMAGE.md)、[guides/STICKER-SEARCH.md](guides/STICKER-SEARCH.md) |
| 定时提醒「过会自己冒出来」 | [guides/REMINDER.md](guides/REMINDER.md)、[guides/REMINDER_NUDGE.md](guides/REMINDER_NUDGE.md) |
| 主动找人说话 | [guides/PROACTIVE_CONTACT.md](guides/PROACTIVE_CONTACT.md) |
| 记得住人（群友档案/长记忆） | [guides/PROFILE.md](guides/PROFILE.md) |
| 写日记 / 每日简报 / 周报 | [guides/DIARY.md](guides/DIARY.md)、[docs/DAILY_BRIEF.md](DAILY_BRIEF.md) |
| 手机上看控制台 / 装 PWA | [guides/MOBILE_CONSOLE.md](guides/MOBILE_CONSOLE.md) |
| 用 QQ 私聊遥控本机 DSH | 模式 `closed-agent` |
| 机器人自己改资料 / 给桌面端发命令 | [README](../README.md) 第 245 行起 |
| 黑话学习与注入 | [RULES.md](../RULES.md) 第 65 行起 |

---

## 6. 配置与开关

真实配置在 `config.json`（**不入库**），模板 `config.example.json`。所有键的完整默认值见模板；下面只列「不知道就会踩坑」的。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dsh.baseUrl` / `model` | `http://127.0.0.1:3080` / `deepseek-flash` | 模型逐会话固定，改这里影响新会话 |
| `dsh.reasoningEffort` | `max` | 影响思考长度与成本 |
| `ownerQQ` | 无 | 管理员号；决定 L1 权限与 `closed-agent` 唯一入口 |
| `allow.groups` / `allow.private` | `[]` | 空且 `allowAllWhenEmpty=false`（默认）时**不响应任何人**（owner 除外）；发送白名单同源 |
| `consolePort` / `consoleToken` | `3100` / 随机 | 控制台访问令牌在 `state/console-token` |
| `socialV2.tools` | 33 个命名空间 | 二代工具面；删项即缩小权限 |
| `socialV2.wake.*` | — | 唤醒频率/概率/关键词/@/点名/提问等触发条件与上限（`maxWakePerMinute/Hour`） |
| `socialV2.send.*` | — | 分句、间隔、突发连发、长间隔、每分钟/小时上限、单条字数上限 |
| `socialV2.voice.*` | `enabled` | 目录、时长/体积/频率上限、ffmpeg 路径、autoReadback |
| `socialV2.reminder.*` | `enabled` | 上限、最小间隔、最长提前量、重试次数、文本长度 |
| `socialV2.context.*` | — | 最近/未读条数、上下文窗口、唤醒消息条数与字符上限 |
| `socialV2.profile.*` | `enabled` | 归档触发阈值、注入人数/字符上限（`role.maxInjectChars` 6000 是总闸） |
| `slang.*` | `enabled` | 抽取最小消息数 10、冷却 5 分钟、注入上限 8、自动调研 |
| `security.interceptNotify` | `true` | 拦截时是否告知模型/用户 |

调参前先读 [OPTIMIZATION-MASTER.md](OPTIMIZATION-MASTER.md) 附录 A（A1 表达层生效值 / A2 成本层 / A3 记忆参数）——那里标注了哪些值「已生效」、哪些只是设计。

---

## 7. 文档地图

全部 42 篇在 `docs/`。下面按「你要解决什么」组织，★= 必读，⚠= 已过期或与现状不符。

### 7.1 顶层（11）

| 文档 | 用途 |
| --- | --- |
| ★ [OPTIMIZATION-MASTER.md](OPTIMIZATION-MASTER.md)（76KB/1071 行） | **总设计**：表达层 + 记忆/成本层，含拓扑、口径、方案、路线图、参数速查 |
| ★ [ACTION-CHECKLIST.md](ACTION-CHECKLIST.md)（133KB） | 执行台账：批 A 观测基线 / B 尺子 / C 成本结构 / D 收尾 + §6.1–§6.42 记录 |
| [AI-TONE-SOLUTION.md](AI-TONE-SOLUTION.md)（55KB） | AI 味问题拆解与四层夹击方案 |
| [SAMPLING.md](SAMPLING.md) | 采样参数 |
| [PERSONA-LAYERS.md](PERSONA-LAYERS.md) | 人格分层 |
| [FEWSHOT.md](FEWSHOT.md) | 少样本素材 |
| [DAILY_BRIEF.md](DAILY_BRIEF.md) | 每日简报 |
| [DASHBOARD_API.md](DASHBOARD_API.md) | 看板 API |
| [OPS.md](OPS.md) | 运维六件套 + 夜间记忆整理 + 排障速查 |
| [FOLDER_MAP.md](FOLDER_MAP.md) | ⚠ 目录地图（说 `public/` 只有 console.html、src 只有 .js，均已漂移） |
| [README.md](README.md) | 索引，**⚠ 有 5 个指向不存在目标的链接**（见 9.2） |

### 7.2 guides/（26）

- **上手与迁移**：`DSH_SETUP.md`、`DSH_020_ADAPTATION.md`、`CONSOLE_ENTRY.md`、`MOBILE_CONSOLE.md`、`SECURITY_BASELINE.md`、`PRIVACY.md`
- **行为与表达**：`AI-TONE.md`、`PERSONA-LAYERS` 相关、`TOOL_SURFACE.md`（工具面清单）、`self-profile-and-desk-command.md`、`TURN_VISIBILITY.md`、`WAKE-HISTORY.md`
- **能力**：`TTS-VOICE.md`、`SEND_IMAGE.md`、`STICKER-SEARCH.md`、`REMINDER.md`、`REMINDER_NUDGE.md`、`PROACTIVE_CONTACT.md`、`DIARY.md`、`PROFILE.md`、`MEDIA_INDEX.md`、`MEMORY_DECAY.md`、`CONN_QUALITY.md`、`RELIABILITY.md`
- **变更与排障**：`QQ_CHANGES_VS_UPSTREAM.md`（71KB，L1–L5 分层改动记录：新增 39 模块/改 7 模块/工具面 39→55/HTTP 端点 100→149）、`CONSOLE_UI_TESTING.md`、`TOKEN_USAGE_CONSOLE.md`

### 7.3 其他

- `docs/plans/` 4 篇：2026-10-25 对话记忆优化系列（设计过程，结论已并入 OPTIMIZATION 第 3 节）。
- `docs/archive/` 1 篇：历史归档，不作为依据。
- 仓库根：`README.md`（33.7KB）、`README.en.md`、`RULES.md`（权限与红线，★）。
- `qq-research/`：第三方生态调研（SnowLuma/qqbridge/tomoyo/groupmate/tulpa + EULA/隐私/路线图 + awesome 清单），选型依据。
- `eval/RUBRIC.md`：30 鞭 + 五维评分 + 盲评工具链；`repro/REPRODUCE.md`：复现步骤。
- 散落在仓库外：`../项目计划/02-QQ语音情绪化.md`、`02b-MiniMax语音引擎方案.md`、`QQ人设卡_小鲸鱼.md`、`work/tts-research/`（活人感与语音自然度研究）。

---

## 8. 观测、运维与排障

| 想知道 | 去哪看 |
| --- | --- |
| 现在什么模式 / 什么角色 | `state/mode.json`、`state/current-role.json`；或控制台顶部 |
| 会话是否绑定 / 用的哪个 preset | `state/sessions.json` 的 `sessionPolicies` |
| 最近说过什么 | `state/qq-activity.log`（滚动 `.1`） |
| 健康与延迟时序 | `state/health.jsonl`、`state/health-probe.log` |
| 花了多少 token | `state/token-usage.jsonl`（**必须 `filter(k==='turn')`**，`k:"base"` 是累计值，会把总量放大约 10 倍） |
| 提醒队列 | `state/reminders.json`、`state/reminder-nudge.json` |
| 群友档案 | `state/profiles.json` |
| 一键体检 | `npm run doctor` / `node src/doctor.mjs` |
| 自测（不需 QQ/SnowLuma） | `npm run self-test`、`npm test`（约 60 个 scripts，见 package.json） |
| 控制台 | http://127.0.0.1:3100 （令牌：`state/console-token`） |
| 看板 / 运维面板 / 手机版 | `/dashboard.html`、`/ops.html`、`/mobile.html` |
| 进程起不来 | `qqbot.mjs status`；分步 `start-qqbot-diag.bat`；看 `qqbot/_*.txt` 诊断残留 |
| 「连上了但收不到消息」 | [README](../README.md) 第 333 行「SnowLuma 版本与上游健康」 |

---

## 9. 当前状态与欠账

### 9.1 设计状态（截至 2026-11-07）

- **表达层**（说得像不像人）：方案已定稿，3 项待定；实施以 `qq-chat-v2` + 发送层硬过滤为主。
- **记忆/成本层**（记得住但别烧钱）：设计定稿，**核心结构性改动尚未实施**（O1–O7 见 OPTIMIZATION 3.5）。
- 两层的共同结论：头号问题不是策略不够，而是**没有度量**；头号病根是**无上界累积**；顺序只能是 先统一观测口径 → 结构性改动 → 质量打磨。
- 已被数据推翻的三条：调 `tool-result-pruner` 阈值省钱（真正体积是数百条累积的十几万字符每步重放，不是单条超大结果）；靠提示词解决「静默轮跳过沉睡前观察」（代码层 `preSleepWaitBlockedV2` 会拦截）；用 15 条固定样本证明「采样更自然」（那 15 条直接喂了过滤器，与温度无关）。

### 9.2 已知文档缺陷

1. `docs/README.md` 索引引用了 5 个本地不存在的目标：`guides/PROJECT_GUIDE.md`（自称「唯一权威 113KB 项目说明书」）、`design/`、`research/`、`audits/`、`legacy/`——均为 `.gitignore` 排除或从未落地。**新读者按索引找会扑空**。
2. `FOLDER_MAP.md` 的内容已落后于仓库（`public/` 文件数、`src/` 下的 `.mjs`、`bridge.js` 行数）。
3. `src/` 根目录残留 5 个 `bridge.js.bak-*`（最大 835.8KB），会污染全局搜索。

### 9.3 结构性风险

- `bridge.js` 840KB 单体，任何整体检索都被它淹没；拆分计划（QSH）长期挂起。
- 会话不会自动轮换，水位单调上涨，成本随对话历史线性放大。
- `state/`、`work/`、`eval/` 体量大（文件数 156 / 2920 / 264），全仓列举必须排除 `node_modules|eval|tmp|replies`。

---

## 10. 变更红线

1. **不改 SnowLuma 的启动/停止职责**（EULA §5.4）——桥接只当客户端。
2. **不放宽 QQ agent 工具面**：`qq-chat*` 永不挂本地执行类工具；新增工具先进 `qq-tool-restrict.mjs` 白名单再进 preset。
3. **不绕过发送白名单**：任何发送类工具的落点必须过 `allow.*` 校验。
4. **不动用户数据**：`state/`、`audio/`、`roles/` 是用户内容，不删不移。
5. **不改真实 `config.json` 的值**（属于用户）；改模板可以。
6. **先立尺子再优化**：没有统一口径的「提升」不接受，见 [ACTION-CHECKLIST.md](ACTION-CHECKLIST.md) 批 A/B。

---

## 11. 术语表

| 词 | 定义 |
| --- | --- |
| 步（step） | 一次 LLM 请求 |
| 轮（turn） | 一次唤醒 |
| 上下文水位 | 同一 session 最近一条有效 `k:"turn"` 记录的 `cacheHit+cacheMiss`（不是历史最大值） |
| 静默轮 | 模型判定 `[SILENT]` 且不发送 |
| 无输出轮 | 静默轮 + 群聊被兜底丢弃的发送 |
| 交接（handoff） | 轮换会话前旧会话产出结构化摘要，供新会话首轮继承 |
| silent turn | 只用于「让模型记住」、不发送的注入轮 |
| 会话代际 | 模式/preset 组合的摘要标记，用于判定既有 session 能否复用 |
| 唤醒原因 | `message` / `proactive` / `timeout` / `replyCheck` 等，决定 prompt 的形态 |

---

## 附：本文件与其他文档的关系

```
README.md（仓库介绍 + 安装）    RULES.md（权限/红线，规范性）
        └──────────────┬──────────────┘
                 docs/MASTER.md（本文：骨架 + 地图 + 索引）
                        │
        ┌───────────────┼────────────────┐
   OPTIMIZATION-MASTER（为什么这么设计）  ACTION-CHECKLIST（做到哪了）
        │
   guides/*（每个子系统怎么用/怎么改）
```
