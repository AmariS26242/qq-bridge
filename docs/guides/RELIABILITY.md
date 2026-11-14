# 可靠性：限流排队补发 + 断线补拉

本文对应两个生产事故性缺陷的修复：

1. **功能 ② 限流静默丢消息（P0）**：OneBot / SnowLuma 触发发送频率上限后，普通回复、表情只打一行日志就被丢弃，用户完全不知道；真实事故是一小时 60 条上限触发后，连定时提醒都发不出去。
2. **功能 ③ 断线期间消息永久丢失（P1）**：SnowLuma WS 平均每 3–8 分钟断一次（code=1006），DSH 重启也会掐断事件流；旧实现重连后只清理「僵尸回合」，断线期间用户发的消息不会补拉。

两个功能都**不需要修改 `config.json`**：不配置时全部走代码默认值。需要调整时在 `config.json` 增加 `reliability` 段即可。

---

## 功能 ②：限流时按优先级排队 + 补发

### 问题

- `sendToQQ` / `sendBurstToQQ` 的 catch 只写 `QQ 发送失败 (...)` 日志并吞掉异常；`sendMessagesV2` 抛错、`sendStickerV2` 抛错后，调用方也没有重投路径。
- 结果是限流窗口内的回复、表情直接消失；提醒链路虽有 `retryAfterMs` 顺延，但最终仍可能 `failFire` 放弃。
- 现有发送都串在 `sendChain` 上，但补发必须复用同一条链，否则补发本身会和实时回复并发撞限频。

### 规则与默认值

| 规则 | 值 |
| --- | --- |
| 优先级 | `owner`=100（私聊主人）、`directReply`=90（回复我/@我）、`groupReply`=60、`sticker`=40、`proactive`=30、`reminder`=20 |
| 补发轮询 | 30s，`timer.unref()`；一轮最多 5 条；条间至少 200ms（默认跟随 `cfg.sendDelayMs`） |
| 退避 | 1s → 2s → 4s → … 封顶 5 分钟 |
| 丢弃条件 | 尝试次数 > 8，或首次入队超过 30 分钟 |
| 队列上限 | 200 条；满时挤掉「优先级最低、firstAt 最老」的一条 |
| 合并 | 同 `key` + 同 payload 的重复入队合并，保留更高优先级与更早 `firstAt` |
| 重投前复查 | 会话不在当前模式白名单 → 丢弃（`session`）；静默模式 → 丢弃（`silent`） |
| 重投失败 | 再次限流只退避、不再自我入队，避免同一条目无限复制 |

### 配置键（`config.json`，全部可选）

```json
{
  "reliability": {
    "rateLimit": {
      "enabled": true,
      "drainIntervalMs": 30000,
      "ttlMs": 1800000,
      "maxAttempts": 8,
      "maxSize": 200,
      "baseBackoffMs": 1000,
      "maxBackoffMs": 300000
    }
  }
}
```

`enabled: false` 可整体关闭排队（失败恢复为只记日志）。`drainIntervalMs` 最小夹到 5000。

### 状态文件

- `state/rate-limit-queue.json`：`{ version, savedAt, stats, items[] }`。每次变更同步落盘，写入失败不影响内存补发；文件损坏按空队列启动。
- **重启行为**：未过 TTL（30 分钟）且未超次数的条目会继续补发；已过期条目在加载时直接丢弃并计入 `totalDropped`，避免把半小时前的旧回复突然发出去。
- `stats` 字段：`totalEnqueued` / `totalSent` / `totalDropped`，另有运行时 `depth`（`RateLimitQueue#stats()`）。

### Hook 位置（`src/bridge.js`）

| 位置 | 作用 |
| --- | --- |
| `src/bridge.js:31-33` | 引入 `rate-limit.mjs` / `catch-up.mjs` |
| `src/bridge.js:1340-1353` | 读取 `cfg.reliability.*`、创建 `RateLimitQueue`、启动 30s 补发定时器 |
| `src/bridge.js:3041-3065` | `drainRateLimitQueue()` / `startRateLimitDrain()`（并发保护、`try/catch` + `unref`，异常只记日志） |
| `src/bridge.js:7706-7714` | `sendToQQ` 失败且为限流 → `enqueueRateLimited` |
| `src/bridge.js:7725-7739` | `enqueueRateLimited()`：分类优先级、合并、入队/挤出日志 |
| `src/bridge.js:7925-7927` | `sendBurstToQQ` 失败且为限流 → 入队 |
| `src/bridge.js:7981-8017` | `queuedItemBlockReason()` / `reportQueuedFailure()` / `attemptQueuedItem()`：复查白名单/静默、文本走 `sendChain` 串行（失败不污染发送链）、表情走 `sendStickerV2({__fromQueue:true})`、成功 `markDone` / 失败 `markFailed` |
| `src/bridge.js:8422-8434` | `sendMessagesV2` 单条失败且为限流 → 入队（保留 reply/at 参数） |
| `src/bridge.js:1903-1912` | `sendStickerV2` 失败且为限流 → 入队；`__fromQueue` 重投不再入队 |
| `src/bridge.js:9538-9542` | `fireReminder`：文本提醒已入队时不消耗重试次数、直接 `completeFire`，避免和队列补发撞车重复发 |

日志前缀统一 `[limit]`：

```text
[limit] 限流排队 group:123 groupReply(p=60) id=... 深度=1
[limit] 补发成功 group:123 groupReply(text) 深度=0
[limit] 丢弃 private:9（max-attempts，已尝试 9 次）：...
[limit] 丢弃 group:1（队列已满，挤出最低优先级 p=20）
```

### 验证

```powershell
# 单测（不连 QQ / DSH，临时目录落盘）
& "%USERPROFILE%\Documents\deepseek-harness\default-workspace\SnowLuma\node.exe" scripts/test-rate-limit.mjs

# 语法
& "%USERPROFILE%\Documents\deepseek-harness\default-workspace\SnowLuma\node.exe" --check src/bridge.js
```

生产验证：

1. 触发一次限流（或临时把 `reliability.rateLimit.maxAttempts` 调小），观察日志出现 `[limit] 限流排队`。
2. 限流窗口结束后，应看到 `[limit] 补发成功`，且 QQ 侧实际收到消息。
3. 查看 `state/rate-limit-queue.json` 的 `items` 与 `stats`，确认深度回落到 0。
4. 重启桥接后队列未过期条目应继续补发；过期条目应被丢弃并记 `totalDropped`。

### 回滚

- 最快：`config.json` 设 `reliability.rateLimit.enabled=false`，重启桥接；行为回到「失败只记日志」。
- 彻底：删除 `src/rate-limit.mjs` 与上表 hook，队列文件 `state/rate-limit-queue.json` 可直接删除（不影响其他状态）。

---

## 功能 ③：断线补拉

### 问题

- `bot.on('open')` 只记录「SnowLuma 已连接」、刷新 token；`checkDsh` 的 DSH 就绪分支只清僵尸 turn、恢复定时器、`flushQueue()`、补黑话提取，**都不补拉断线期间用户发的消息**。
- 1006 每次断 3–8 分钟，期间群友/主人的消息既没进 `social-v2.json`，也不会触发唤醒，等于永久丢失。

### 规则与默认值

| 规则 | 值 |
| --- | --- |
| 触发点 | ① DSH 重新就绪（`DSH 已就绪` 分支）；② SnowLuma WS `open`（1006 重连） |
| 补拉对象 | 当前模式允许的 `socialV2.conversations`，按 `lastIncomingAt` 取最近活跃的前 5 个 |
| 单会话条数 | 请求历史 50 条，最终最多补 50 条 |
| 过滤 | 自己发的、已见过的 `message_id`、`at <= lastSeenAt`、时钟超前 5 分钟、重复 id 一律丢弃 |
| 排序 | 按消息时间升序；超过 `maxCount` 只保留最新 |
| 防抖 | 同会话 60s 冷却；补拉进行中不并发 |
| 超时 | 单次 OneBot 请求 4s，总耗时 ≤10s（剩余时间不足即停） |
| 前置条件 | `dshReady === true` 且 `currentMode === 'reserved2'` 且 `socialV2.enabled !== false`；失败只记日志，不阻塞重连 |
| 入账 | 复用 `appendSocialV2Message`，再 `feedSlangWindow` / `feedProfileWindow`，最后 `scheduleWakeV2(key, '断线补拉(n条)')` |

### 配置键（全部可选）

```json
{
  "reliability": {
    "catchUp": {
      "enabled": true,
      "maxCount": 50,
      "maxConversations": 5,
      "totalTimeoutMs": 10000,
      "perCallTimeoutMs": 4000,
      "cooldownMs": 60000,
      "historyCount": 50
    }
  }
}
```

### 状态文件

- 无新增状态文件。已见消息、活跃会话、`lastIncomingAt` 都复用 `state/social-v2.json` 的 `recentMessages` / `lastIncomingAt`。
- 补拉去重的「最后一条」取自该会话 `recentMessages` 中最后一条非自己的 `messageId`。
- 自己 QQ 号来源：优先 `getLoginInfo().user_id`（连接成功后写入内存），其次 profile 链路记录的 `self_id`。

### Hook 位置

| 位置 | 作用 |
| --- | --- |
| `src/bridge.js:3012-3013` | DSH 重新就绪后触发 `runCatchUp('DSH 已就绪')`（不 await，失败只记日志） |
| `src/bridge.js:10630-10671` | `fetchOneBotHistory()`（POST `get_group_msg_history` / `get_friend_msg_history`）+ `applyCatchUpMessages()`（走既有入账/唤醒链路） |
| `src/bridge.js:11272-11303` | `catchUpTargets()` / `catchUpOneConversation()`：冷却、拉取、`planCatchUp`、入账 |
| `src/bridge.js:11305-11328` | `runCatchUp(trigger)`：模式/就绪检查、总超时 10s、异常兜底 |
| `src/bridge.js:12542` | `bot.getLoginInfo()` 记录自身 QQ 号，供补拉过滤自己发的消息 |
| `src/bridge.js:12549-12550` | SnowLuma WS `open` 后最多等登录信息 2s，再触发 `runCatchUp('SnowLuma 重连')` |

日志前缀统一 `[catch-up]`：

```text
[catch-up] group:123 过滤 8 条（已见/自己/超窗）
[catch-up] DSH 已就绪 补拉完成：3 条
[catch-up] 补拉 group:123 失败（SnowLuma 重连）：OneBot get_group_msg_history 失败: ...
```

### 验证

```powershell
& "%USERPROFILE%\Documents\deepseek-harness\default-workspace\SnowLuma\node.exe" scripts/test-catch-up.mjs
& "%USERPROFILE%\Documents\deepseek-harness\default-workspace\SnowLuma\node.exe" --check src/catch-up.mjs
```

生产验证：

1. 断开 SnowLuma（或杀掉 DSH）几分钟，期间在群里发 2–3 条消息。
2. 恢复后观察日志出现 `[catch-up] ... 补拉完成：n 条`，且 `state/social-v2.json` 对应会话 `recentMessages` 出现这些消息。
3. 后端应出现 wake 且原因为 `断线补拉(n条)`；AI 可能据此回复，也可能只入账不回复（取决于唤醒策略）。
4. 重复重连不应重复入账：同一批消息第二次补拉会被 `message_id` 去重。
5. 若 SnowLuma 的历史接口不可用，只应看到 `[catch-up] ... 失败` 日志，重连本身不受影响。

### 回滚

- 最快：`config.json` 设 `reliability.catchUp.enabled=false`，重启桥接。
- 彻底：删除 `src/catch-up.mjs` 与上表 hook；`social-v2.json` 无需迁移（补拉消息与正常消息结构一致）。

---

## 已知风险

1. **补拉可能重复入账**：去重依赖 `message_id` 与 `lastSeenAt`。若 OneBot 历史返回的消息 id 不稳定/缺失，或桥接在补拉入账后、写入 `social-v2.json` 前崩溃，重连后可能重复记一次；表现为 AI 看到重复消息，通常无严重后果。另一个边界：断线前最后一条与本秒内新消息时间相同，可能被 `lastSeenAt` 误过滤（概率低）。
2. **限流队列重启行为**：队列持久化，未过 TTL 的条目重启后会继续补发——如果桥接停机很久后重启，最多可能补发 30 分钟内的旧回复。已过期条目在加载时丢弃。若同一会话在此期间已重置，重投前只按「模式白名单 + 静默模式」复查，不校验会话代际，理论上可能把旧回复发进已重置的会话。
3. **补发与实时发送共用 `sendChain`**：补发会排队在实时消息之后，深度大时补发会变慢（每轮 5 条、30s 一轮），但不会并发撞限频。表情补发内部有 0.8–2s 的拟人停顿。
4. **历史接口依赖 SnowLuma 实现**：若 SnowLuma 未实现 `get_*_msg_history` 或返回形状不同，补拉只失败记日志，不影响主链路；需按上游实际返回再调 `parseOneBotHistory`。
5. **提醒文本的「已入队」语义**：`sendReminderTextV2` 本地分钟/小时配额超限时仍走 `retryAfterMs` 顺延（未改成入队），这是为保持既有提醒语义；只有真正发到 OneBot 被限流才入队。

---

## 附：入站去重（2026-10-19 追加）

SnowLuma 在重连/重放时会把同一条消息用同一个 `messageId` 再投一次。实测（2026-10-19 22:12:30）同一条「好了」进了 3 次（seq 348/349/350，messageId 相同），表现为 AI 以为对方连说了三遍。

- 入口：`appendSocialV2Message()` 开头按 `messageId` 查 `recentMessages`（只看对方消息），命中即 `return`，日志 `[reserved2] 跳过重复入站 <key>（messageId=...）`。
- 只影响入站：机器人自己的发送走 `sendMessagesV2`，不经过该函数。
- 与补拉共用同一套判据：补拉用 `lastSeenMessageId`，实时入站用 `recentMessages` 里的 `messageId`，两边都命中就都不会重复入账。
- 边界：`messageId` 为空的入站（拍一拍等）不去重；历史里已有 100 条上限，超出窗口后同一条若再重放仍会入账（概率极低）。
