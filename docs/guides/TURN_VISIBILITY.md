# 回合可见性：失联安抚 + 自述状态

> 代码：`src/turn-visibility.mjs`（纯逻辑，可单测）＋ `src/bridge.js` 里的 6 处最小 hook。
> 单测：`scripts/test-turn-visibility.mjs`。

## 1. 解决什么问题

- **失联静默**。会话被判「繁忙」卡住时，旧的 `recoverStuckBusyV2()` 只会在日志里打
  `连续繁忙 600s，未读 25 条：清空标记` 并重发唤醒；用户侧什么都收不到，QQ 端完全静默，
  只能自己猜「是不是它没看见」。
- **自述只能靠猜**。被问「你在干嘛 / 怎么不回」时，唤醒 prompt 里只有角色、未读、唤醒条件，
  没有运行期状态（队列、繁忙时长、上一回合时间、DSH 是否连上），AI 只能编。

本模块做两件事：卡住时给用户**一句**安抚；唤醒时给 AI**一行**事实。

## 2. 失联安抚（功能 A）

### 判定规则

每 60 秒巡检一次，对每个已登记会话依次判断，任一条件不满足就**不发**：

| 顺序 | 条件 | 不满足时的 reason |
| --- | --- | --- |
| 1 | `socialV2.stuckNotice.enabled` 为 true | `disabled` |
| 2 | 桥接未暂停且处于 `reserved2` 模式 | `paused` |
| 3 | 该会话有未读（`unread > 0`） | `no-unread` |
| 4 | 会话当前被判为繁忙（`requireBusy` 默认 true） | `not-busy` |
| 5 | 繁忙起点已知（不会在刚唤醒、还没记录起点时抢跑） | `busy-unknown` |
| 6 | 能算出「上次成功产出」时间（取 `lastAiReplyAt` / `lastActionAt` / 自己最近一条消息的最大值；都没有则退回繁忙起点） | `no-anchor` |
| 7 | 距上次成功产出 ≥ `afterMs`（默认 8 分钟） | `not-stalled` |
| 8 | 「繁忙」本身也持续 ≥ `afterMs`（防止 AI 正常 `qq_wait_for_messages` 等 5 分钟被误报） | `busy-short` |
| 9 | 不在退避窗口内（`blockedUntil`） | `backoff` |
| 10 | 距上次成功安抚 ≥ `cooldownMs`（默认 30 分钟） | `cooldown` |

全部满足 → 发**一条** `stuckNotice.message`（默认「我这边卡住了，等会儿回你」），
然后写冷却。冷却期内对方再发新消息也不会叠加（判定仍停在 `cooldown`）。

### 发送与失败处理

- 发送走 `onebotSend()`（OneBot HTTP），**绕开** `sendToQQ` 的 `sendChain`：
  `sendToQQ` 内部吞错、拿不到 429，而且排队会拖住正常消息。
- 失败后按 `blockedUntil` 退避，期间判定直接返回 `backoff`，不再重试：
  - 429 / 限流 / retcode 1200：起点 `rateLimitBackoffMs`（默认 5 分钟）；
  - 其他失败：起点 `failBackoffMs`（默认 1 分钟）；
  - 连续失败按 `×2^min(3, failCount)` 增长，封顶 `maxBackoffMs`（默认 30 分钟）。
- 安抚有**独立定时器**，不塞进 `recoverStuckBusyV2`：发送失败/退避绝不阻塞原有繁忙自愈，
  也不影响正常消息链。单个会话异常只记日志，不影响其他会话。

### 配置键（全部可选，代码默认值；**不改 config.json**）

```json
{
  "socialV2": {
    "stuckNotice": {
      "enabled": true,
      "afterMinutes": 8,
      "cooldownMinutes": 30,
      "message": "我这边卡住了，等会儿回你",
      "requireBusy": true,
      "rateLimitBackoffMs": 300000,
      "failBackoffMs": 60000,
      "maxBackoffMs": 1800000
    }
  }
}
```

- 非数字 / 0 / 负数的分钟数一律回退默认（不会被夹成 1 分钟）；`afterMs`/`cooldownMs` 最小 60 秒。
- `message` 会被压成单行并截到 60 字符，换行（多条气泡）和刷屏长文都不会出现。

### 状态文件 `state/stuck-notice.json`

```json
{
  "version": 1,
  "updatedAt": 0,
  "totalSent": 0,
  "totalFailed": 0,
  "lastSentAt": 0,
  "lastAttemptAt": 0,
  "conversations": {
    "group:123456": {
      "sentCount": 0,
      "failCount": 0,
      "lastSentAt": 0,
      "lastAttemptAt": 0,
      "blockedUntil": 0,
      "lastReason": "stalled | cooldown | backoff | rate-limited | send-failed",
      "lastError": "",
      "lastUnread": 0
    }
  }
}
```

- 文件不存在 / JSON 坏了 / 字段类型不对 → 一律当空状态，不抛错。
- 只在「真的发了」或「发送失败」时落盘；目录里只会新增这一个文件（不写临时文件）。
- 控制台只需读这个 json 的 `totalSent` / `lastSentAt` 即可展示次数与最近时间。

## 3. 自述状态（功能 B）

`buildStatusLine()` 生成一行 `【桥接状态】…`，插在唤醒 prompt 的【此刻状态】之后、【当前唤醒】之前：

```
【桥接状态】待发队列 0；本会话繁忙 12s；上一回合结束 3分钟前；DSH 连接正常
```

- 字段来源：待发队列 = `promptQueues` 队列长度 + `pendingWakeReasons` 数量；
  本会话繁忙 = `v2TurnStartAt`（按 sessionId）；上一回合结束 = turn/end 时写入的 `st.lastTurnEndedAt`；
  DSH 连接 = `dshReady`。
- 拿不到的字段直接省略，**不写「未知」**；一个字段都没有时整行为空。
- 总长硬上限 200 字符（`maxChars` 解析时夹在 20–200）；超长按优先级丢字段：
  队列（最不易丢）→ 繁忙 → 上一回合 → DSH 连接（最先丢）。
- `socialV2.selfStatus.enabled === false` 时 `buildStatusLine()` 返回空串，
  prompt 与改造前**逐字节一致**（`base` 里只有 `(selfStatusLine ? ... : '')`）。

```json
{ "socialV2": { "selfStatus": { "enabled": true, "maxChars": 200 } } }
```

## 4. hook 位置（`src/bridge.js`，每处 ≤15 行）

| 位置 | 作用 |
| --- | --- |
| `src/bridge.js:24` | 引入 `buildStatusLine / resolveSelfStatusConfig / sweepStuckNotices` |
| `src/bridge.js:102-104` | `STUCK_NOTICE_FILE = state/stuck-notice.json` |
| `src/bridge.js:3018-3022` | `startDshWatch()` 里注册独立巡检定时器（60s，unref，异常只记日志） |
| `src/bridge.js:10770-10781` | `buildWakePromptV2()` 生成自述状态行并插进 `base` |
| `src/bridge.js:11024-11038` | `stuckNoticeInfoV2()` / `runStuckNoticeSweepV2()`：只提供运行期数据与发送器 |
| `src/bridge.js:11865-11866` | turn/end 时写 `st.lastTurnEndedAt`（运行期字段，不落 social-v2.json） |

判定、冷却、退避、状态读写、长度裁剪全部在 `src/turn-visibility.mjs`；
`bridge.js` 不做业务判断，方便单测和回滚。

## 5. 如何验证

```powershell
# 纯逻辑单测（24 项，PASS/FAIL，失败 exit 1）
& "%USERPROFILE%\Documents\deepseek-harness\default-workspace\SnowLuma\node.exe" scripts\test-turn-visibility.mjs

# 语法检查
node --check src\turn-visibility.mjs
node --check src\bridge.js

# 既有回归（不应被影响）
node scripts\test-preset-prompt.mjs
node scripts\test-v2-wait.mjs
```

> 本机请用 SnowLuma 的 Node v22（`...\SnowLuma\node.exe`）；PATH 里的 `node` 不一定是 v22。

线上观察：

- `state/bridge.log` 出现 `[reserved2] 失联安抚 group:xxx：已发送…` 说明安抚生效；
  出现 `…发送失败，退避至 …` 说明被限流/网络失败，按退避处理中。
- 读 `state/stuck-notice.json` 的 `totalSent` / `lastSentAt` 确认次数与最近一次时间。
- 想临时关闭：在配置对象里加 `socialV2.stuckNotice.enabled=false`（自述状态同理
  `socialV2.selfStatus.enabled=false`），无需改代码。

### 手动复现（不重启服务时只能在测试里覆盖）

1. 用单测覆盖「超时告警一次 / 冷却内不重复 / 429 退避」；
2. 线上等一次真实卡死（未读堆积且繁忙 > 8 分钟），看日志与 `stuck-notice.json`；
3. 想立刻验证发送通道，可在 `sweepStuckNotices` 的 `send` 上打日志观察，但**不要**
   为了测试去改生产 `state/` 或重启进程。

## 6. 回滚

按顺序任选其一，均不需要动 `config.json`：

1. **只关功能（推荐）**：配置里把 `socialV2.stuckNotice.enabled` / `socialV2.selfStatus.enabled`
   设为 `false` → 判定直接 `disabled`，prompt 恢复逐字节一致，`stuck-notice.json` 不再写入。
2. **撤代码**：删掉 `src/bridge.js` 上表 6 处 hook（每处都是独立小块），删除
   `src/turn-visibility.mjs`、`scripts/test-turn-visibility.mjs`、本文件；
   `state/stuck-notice.json` 可直接删除（不影响任何其他状态）。
3. 回滚后重启 bridge 由主智能体执行（本功能不涉及进程配置，无需迁移数据）。
