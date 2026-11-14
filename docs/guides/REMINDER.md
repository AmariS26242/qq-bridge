# 定时提醒（`qq_set_reminder` / `qq_list_reminders` / `qq_cancel_reminder`）

> 状态：✅ 2026-10-19 落地并端到端验证（QQ 桌面命令 #16）。
> 相关代码：`src/reminders.js`（时间算法 + 存储 + 上限）、`src/bridge.js`（tick 引擎、两条通道、发送回读）、`src/mcp-snowluma-safe.js`（三个 AI 工具）。
> 自测：`node scripts/test-reminders.mjs`（离线，不需要 SnowLuma/QQ/网络）。

## 一句话

机器人可以给自己**登记一条未来动作**：到点由桥自动发一句话，或者到点把机器人叫醒、由它自己组织措辞。
任务存在 `state/reminders.json`，重启不丢；发送照旧走白名单与频率限制。

## 两种内容类型

| 类型 | 字段 | 到点的行为 |
| --- | --- | --- |
| 文字型 | `text` | 原样把这句话发出去（不经过模型），走 `sendMessagesV2`，占发送额度 |
| 唤醒型 | `prompt` | 把这段任务描述投给 AI（`deliverPrompt`），由它决定说什么、发不发，占唤醒额度 |

两者**二选一**，同时给会 400。文字上限 `maxTextChars`（默认 500 字），描述上限 1000 字。

## AI 怎么用（MCP 工具）

```jsonc
// 一次性：40 分钟后原样发一句话
qq_set_reminder({ key, token, text: "该喝水了", delaySeconds: 2400 })

// 一次性：明天 09:00 叫醒自己组织措辞
qq_set_reminder({ key, token, prompt: "看看他昨晚问的那件事有结论没，有的话提一句", at: "2026-10-20 09:00" })

// 周期：每天 09:30 / 每周日 20:00
qq_set_reminder({ key, token, text: "打卡", repeat: "daily", clock: "09:30" })
qq_set_reminder({ key, token, text: "复盘", repeat: "weekly", clock: "20:00", weekday: 7 })

qq_list_reminders({ key, token })     // 看本会话已登记的（含已结束的）
qq_cancel_reminder({ id, token })     // 取消一条还没触发的
```

时间语义：`at` 传 `"2026-10-20 09:00"`（本地时间，`Asia/Shanghai`）或 `"09:30"`（今天/明天那个点）；
`delaySeconds` 是相对秒数；周期任务用 `clock="HH:MM"`，weekly 再给 `weekday`（1=周一…7=周日）。
桥内部一律把它折成 `nextRunAt`（epoch 毫秒）落盘。

## 上限（防刷屏，全部可配）

| 配置项（`socialV2.reminder`） | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | true | 总开关 |
| `maxActiveTotal` | 50 | 全局待触发条数上限 |
| `maxActivePerTarget` | 10 | 单会话待触发条数上限 |
| `minGapMs` | 120000 | 同会话两次提醒最小间隔（不够就**顺延**，不丢弃） |
| `minLeadMs` | 10000 | 最早触发时间，防「立刻触发」当绕过限频的后门 |
| `maxHorizonMs` | 100000001（90 天） | 最远触发时间 |
| `graceMs` | 1800000（30 分钟） | 停机错过多久之内还补发 |
| `maxAttempts` | 5 | 失败重试次数（指数退避 30s→10min） |
| `maxTextChars` | 500 | 单条提醒文字上限 |
| `tickMs` | 15000 | 扫一次到点任务的间隔 |

发送侧还有原有的 `socialV2.send.maxSendPerMinute` / `maxSendPerHour` 与 `allow.groups` / `allow.private` 白名单，
提醒**不绕过**任何一条：不在白名单就暂缓（10 分钟后重试，不消耗次数），限频就顺延。

## 操作者通道（CLI / 控制台，凭 console token）

```powershell
$tok = Get-Content qq-bridge\state\console-token -Raw
$h = @{ 'x-console-token' = $tok.Trim(); 'Content-Type' = 'application/json; charset=utf-8' }
$body = [Text.Encoding]::UTF8.GetBytes('{"key":"private:100000001","text":"该喝水了","delaySeconds":600}')
Invoke-RestMethod http://127.0.0.1:3100/api/reminder/create -Method Post -Headers $h -Body $body
```

- `POST /api/reminder/create` `{key, text|prompt, at|delaySeconds, repeat?, clock?, weekday?}`
- `POST /api/reminder/list` `{key?, includeInactive?}`
- `POST /api/reminder/cancel` `{id}`

AI 通道是 `/api/socialV2/reminder-create|list|cancel`，必须带 `x-agent-token`（会话令牌），只能操作自己那个会话。

## 实现要点

1. **tick 引擎**：`setInterval(tickMs)` 扫 `status==='pending' && nextRunAt<=now`，逐条 `fireReminder`。
   先 `beginFire`（状态改 `firing`，attempts+1）再发送，避免并发重复触发。
2. **重启不丢**：写盘走 `ReminderStore.save()`（临时文件 + rename），每次变更即落盘；
   启动时 `sweepStale` 把「进程死在 firing 状态」的任务判为 `missed`。停机超过 `graceMs` 的补发一次并标 `missed`。
3. **发送回读**：文字型发完立刻用 OneBot `get_msg` 回读，确认这条消息里确实有 text/image 段，
   日志写「回读确认落地」；`lastMessageId` 一并落盘。
4. **prompt 型**：投递前检查会话是否繁忙（`isConversationBusyV2`）、唤醒是否限频，忙就顺延 60s。
5. **重启安全**：SIGINT/SIGTERM 额外 `reminderStore.save()`。

## 排障

| 现象 | 先看 |
| --- | --- |
| 到点没发 | `state/bridge.log` 里的 `[reminder]` 行：`顺延`=间隔/限频，`暂缓`=白名单/静默/会话忙，`触发失败`=OneBot 报错 |
| 设不上 | 400 是参数（时间太近/太远、text 与 prompt 同时给、key 格式）；429 是条数上限；403 是白名单/模式/token |
| 重启后没了 | 看 `state/reminders.json` 是否还在、`status` 是否被 `sweepStale` 判成 `missed` |
| AI 说「设了」但查不到 | 让模型贴出 `qq_set_reminder` 的返回 id；工具失败时返回 `isError`，没报错才是真的登记上了 |
