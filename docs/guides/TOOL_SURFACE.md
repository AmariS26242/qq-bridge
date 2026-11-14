# 工具面（MCP tool surface）：分组、裁剪与人设耦合

> 落地日期：2026-10-19。相关代码：`src/mcp-snowluma-safe.js:233-265`（`TOOL_GROUPS` / `ROLE_GROUPS` / `enabledGroups`）、`config.json` 的 `mcp.toolGroups`。

## 为什么要有这层

`mcp-snowluma-safe.js` 用 `server.tool()` 注册的工具，**每一个的 name + description + JSON Schema 都会在该 profile 的每一回合进 system prompt**，与这个回合聊不聊天、用不用得上无关。

实测（2026-10-23 复测，加了日记三工具；2026-10-19 首测时是 47 个）：

| | 工具数 | schema 体积 | 约合 tokens |
| --- | --- | --- | --- |
| 全量 | 50 | 未重新测量 | ≈15,500 |
| 当前线上配置 | 41 | 41,404 B | ≈12,900（-17%） |

50 个工具里，`state/tool-calls.jsonl` 累计 1,185 次调用只覆盖 21 个；26 个工具**一次都没被调用过**（`qq_profile_*` 四个、`qq_set_reminder/list/cancel`、`qq_send_image`、`qq_list_groups`、`qq_report_feedback` 等）。所以裁剪的依据是"调用频次 + 人格是否会点名"，不是"功能是否有用"。

## 三档配置（后者优先）

1. **不配置** → `enabledGroups = null`，全量放行，行为与改造前完全一致。任何分组代码出问题，删掉配置就是最稳的回退。
2. `config.json` 的 `mcp.toolGroups`（推荐，随仓库走）：

   ```json
   "mcp": { "toolGroups": ["core", "group", "media", "stickers", "memory", "admin"] }
   ```

   线上 qqbridge 自 2026-10-25 起带 `admin`：QQ 端 agent 要能自己换头像/改昵称签名（人格第 19 条），那三个工具必须在 `tools/list` 里真实存在，否则模型只能说“我没有这个工具”。

3. 环境变量 `QQ_MCP_ROLE=core|admin`（给"一个 profile 挂两个 server"的玩法用，粗粒度）：

   | role | 展开成哪些组 |
   | --- | --- |
   | `core` | `core` + `group` + `media` + `stickers` + `memory` |
   | `admin` | `admin` + `profile` + `memory` + `stickers` + `group` |

`server.tool` 在注册期就被包装：命中未启用组的工具**根本不注册**，所以 `tools/list` 里看不到它们，省的是真 token。`TOOL_CONFIG_FLAGS` 那层（`socialV2.tools.*`，例如 `setStickerRemark` 默认关）与分组是叠乘关系。

## 分组表

| 组 | 工具 | 说明 |
| --- | --- | --- |
| `core` | `qq_status`、`qq_get_prompt`、`qq_get_unread_messages`、`qq_get_recent_messages`、`qq_social_state`、`qq_mark_read`、`qq_send_message`、`qq_send_burst`、`qq_send_private_message`、`qq_reply`、`qq_wait_for_messages`、`qq_set_wake_config`、`qq_desk_command`、`qq_send_poke`、`qq_slang_query`、`qq_slang_submit` | 每回合都可能有用的聊天主循环 |
| `group` | `qq_list_groups`、`qq_get_group_members`、`qq_get_active_members`、`qq_get_group_history`、`qq_send_group_message` | 群相关查询/发送 |
| `media` | `qq_get_message_images`、`qq_get_forward_msg`、`qq_get_message_detail`、`qq_send_image`、`qq_send_sticker`、`qq_get_self_image`、`qq_get_my_recent_messages` | 看图、转发、表情、发图 |
| `stickers` | `qq_list_stickers`、`qq_get_sticker_image`、`qq_collect_sticker`、`qq_sticker_note`、`qq_set_sticker_remark` | 表情包库维护 |
| `memory` | `qq_memory_append`、`qq_memory_query`、`qq_memory_remove`、`qq_memory_clear`、`qq_diary_write`、`qq_diary_read`、`qq_diary_list` | 轻量记忆（人格第 8 条）+ 日记本（第 17 条）；日记三工具**故意挂在 memory 组**，否则线上 `toolGroups` 不启用新组、工具静默消失 |
| `profile` | `qq_profile_query`、`qq_profile_write`、`qq_profile_remove`、`qq_profile_clear` | 群友档案，**零调用，默认不启用** |
| `admin` | `qq_set_avatar`、`qq_set_profile`、`qq_set_signature`、`qq_set_reminder`、`qq_list_reminders`、`qq_cancel_reminder`、`qq_report_feedback` | 低频管理动作，**默认不启用** |

> 未列入任何组的工具一律放行——漏写一个工具名不会导致功能消失，这是有意的 fail-open，方便后续加工具时不用同步改表。

## 硬规则：人格点名的工具必须常驻

`qq-chat-v2` 的人格正文（生成物：`~/.dsh/plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml`，源文件在其头部注释里）会**直接点名**要求模型调用某些工具。工具被裁掉，人设就成了"指挥模型调用不存在的工具"。

2026-10-19 就踩过一次：第一版把 `memory` 整组和 `qq_send_poke` / `qq_slang_*` 划进默认不启用，而人格第 8 条写"偶尔用 `qq_memory_append` 记…"、第 9 条写先 `qq_slang_query`、第 13 条写 `qq_send_poke`。修法是把这些并回 `core` / 常驻组，**人格不动**。

改分组时按这个顺序自查：

```powershell
# 1) 人格正文里出现的所有工具名
Select-String -Path "$env:USERPROFILE\.dsh\plugins\qq-agent-presets\presets\qq-chat-v2.patch.yml" -Pattern 'qq_[a-z_]+' -AllMatches | ForEach-Object { $_.Matches.Value } | Sort-Object -Unique

# 2) 当前配置下单 server 实际暴露的工具名（在 qq-bridge 目录下跑，见下节探针）
```

两边做差集，落到"人格点名但没暴露"的就是 bug；反之"暴露但零调用"才是可裁的。

人格里还提到 `qq_send_voice` / `qq_list_voices`（默认关闭，工具未注册）与 `qq_set_sticker_remark`（`socialV2.tools.setStickerRemark` 默认 false），这两类**故意**不在工具面里，人格也写明了"没开属正常，不要重试"，不要当成漏配。

## 怎么验证生效

MCP server 是子进程，由 DSH profile 启动时拉起：**改配置或改代码后必须重启承载它的 DSH 实例**，否则 `tools/list` 还是旧的。

```powershell
# 探针：直接以 stdio 拉起源码，打印工具数 / schema 体积 / 清单
cd <repo>
@'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = "<repo>";
const t = new StdioClientTransport({ command: process.execPath, args: [root + "/src/mcp-snowluma-safe.js"], stderr: 'ignore', cwd: root, env: { ...process.env, QQ_BRIDGE_MCP_NO_LOG: '1' } });
const c = new Client({ name: 'probe', version: '0' }, { capabilities: {} });
await c.connect(t);
const { tools } = await c.listTools();
await c.close();
const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
console.log(`工具数：${tools.length}  schema：${bytes} B  约 ${Math.round(bytes / 3.2)} tokens`);
console.log(tools.map(x => x.name.replace('qq_', '')).join(', '));
'@ | Set-Content -Encoding UTF8 _probe_tools.mjs
& ..\SnowLuma\node.exe _probe_tools.mjs
```

重启线上实例（会短暂断流 QQ 消息，bridge 会入队）：

```powershell
Disable-ScheduledTask -TaskName 'DSH QQ Bot Watchdog'   # 先别让看门狗抢着拉起
& ..\SnowLuma\node.exe ..\qqbot\qqbot.mjs up            # 检测到 19388 没起就会拉起 DSH qqbridge
Enable-ScheduledTask  -TaskName 'DSH QQ Bot Watchdog'
```

验证信号：`state/bridge.log` 出现 `DSH 已就绪（模式: reserved2）`；`qqbot/logs/dsh.log` 里应有 MCP server 自己打的启动行

```
[mcp-snowluma] 工具面：注册 N 个，裁剪 M 个；分组=core+group+media+stickers+memory+admin；被裁：...
```

（`QQ_BRIDGE_MCP_NO_LOG` 设了就不打）。再看真实一条 QQ 消息：`state/tool-calls.jsonl` 里应只有 `ok:true`，没有 `Unknown tool` / 参数缺失。

这行是排「配置看着开了、模型却看不到工具」的第一现场：`注册` 数不含被裁的，`被裁` 会写出 `工具名(组名)`。2026-10-25 的 `qq_set_avatar` 消失案（`toolGroups` 漏了 `admin`）就是靠它一眼定位的。

## 非 MCP 宿主插件工具：`qq_project_read`（Preset 隔离与裁剪口径说明）

上文讨论的 50 / 41 个工具均为 `src/mcp-snowluma-safe.js` 注册的 **MCP 工具**；第一阶段交付的 `qq_project_read`（受限只读项目浏览/读取/字面搜索）采用不同通道：

- **注册方式（非 MCP）**：通过 DSH Cordis 宿主插件 `plugins/qq-agent-presets/qq-project-read.mjs` 调用 `tools.register` 注入模型工具面，**不计入** `mcp-snowluma-safe.js` 的工具数统计，也**不受** `config.json` 中 `mcp.toolGroups` 裁剪影响。
- **Preset 隔离**：
  - `qq-chat`（`dsh/agent-presets/qq-chat/agent.cordis.yml` / `plugins/qq-agent-presets/presets/qq-chat.patch.yml`）：**不挂载** `qq-project-read`。
  - `qq-chat-v2`（`dsh/agent-presets/qq-chat-v2/agent.cordis.yml` / `plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml`）：挂载 `id: qq-project-read`（`config: {}` 零凭据）。
- **工具守卫与后端双门控**：`qq-chat` 与 `qq-chat-v2` 共用的 `plugins/qq-agent-presets/qq-tool-restrict.mjs` 在 `SAFE_EXACT` 中放行 `qq_project_read` 名称，但实际是否可执行由两道门控决定：
  1. DSH 宿主插件会拒绝一切 subagent，并需本机 `config.projectRead.enabled=true` 且存在 `state/project-read-host-token.json`；
  2. Bridge `ProjectReadAuthEngine`（`src/project-read-auth.mjs` Step 6）严格反查会话映射，仅放行 `reserved2` + `qq-chat-v2` + 管理员本人（`ownerQQ`）私聊，且当前白名单仅限 `qq-bridge` 项目。群聊或非管理员会话调用会返回 `403 UNAUTHORIZED_SESSION`。

详细安全架构、测试证据与回滚方法见 [PROJECT_READ.md](PROJECT_READ.md)。

## 回滚

| 想回滚 | 做法 |
| --- | --- |
| 只回工具分组 | 删掉 `config.json` 的 `mcp` 块（或把 `toolGroups` 设为 `null`），重启 DSH |
| 回整份代码 | `src/mcp-snowluma-safe.js.bak-20261019-214215`（同目录另有 `config.json.bak-20261019-214215`） |

## 已知残留

- `qq_set_wake_config` 是最大单项（2,409 B）：已把描述压过一轮（原 3,294 B），**schema 字段未动**，`triggers.speakerIds` / `poke` / `probability` 等仍全在。
- 现阶段靠 `mcp.toolGroups` 手写组名，没有控制台界面；改分组属于改 `config.json` + 重启。
- 动态 `tools/list_changed`（按会话热插拔工具面）已评估过：需要 DSH 客户端 `config.tools` 回调 + server `tools.listChanged` capability 双端配合，当前 SDK/server 都未接，**结论是不做**——用静态分组 + role 更简单，且工具表在会话内恒定对 prompt cache 更友好。
