# 唤醒前历史预取（醒来时补一段窗口外的上下文）

## 问题

模型每次被唤醒，能看到的只有「内存里的 `recentMessages` + 未读队列」。以下情况这个窗口是短甚至空的：

- bridge 刚重启（`social-v2.json` 里的窗口还在，但进程内状态可能是冷的）；
- 潜水很久之后第一次被叫醒；
- 断线补拉只补回断线期间那几条，更早的对话根本不在窗口里。

结果就是：醒来第一句话接不上前面的上下文，像失忆。而 OneBot 的 `get_friend_msg_history` / `get_group_msg_history` 明明能拿到最近约 100 条（`count>100` 会**静默返回空数组**，不是报错）。

## 方案

唤醒前（`sendWakePromptV2` 真正投递之前）预取一次历史，把「窗口之外的最近 N 条」拼成一小段，插进唤醒提示词的状态行之后：

```
【醒来前最近对话】以下是内存窗口之外的旧消息，只是补上下文，不是新未读，不用逐条回应：
17:07 我：所以这是给我用的，不是给你自己换的
17:22 26242：换好了，那头像现在是我了
```

关键约束：

| 约束 | 原因 |
| --- | --- |
| 只改提示词，**不动** `st.recentMessages` / `st.unread` | 否则历史消息会被当成「刚发生的事」影响沉睡前观察、replyCheck、断线补拉去重；也会被当成待回复的未读 |
| 保留自己说过的话（不做 `isSelf` 过滤） | 补上下文需要双方；断线补拉才要过滤自己 |
| 自己的消息靠 `lastInboundSelfId` 判定 | OneBot 历史返回里**没有** `self_id`，`parseOneBotHistory` 只能靠入参 |
| 失败只记日志 | OneBot 超时/接口异常不能拖住唤醒 |
| 同一段旧消息只贴一次 | `wakeHistorySeenIds` 记住注入过的 messageId，避免每次唤醒重贴同 12 条 |
| 冷却 + 并发闸门 | 冷却避免连环唤醒反复打 OneBot；`wakePrepKeys` 让「正在预取」的会话把新唤醒原因暂存，不会插队投递 |

## 代码位置

| 文件 | 作用 |
| --- | --- |
| `src/wake-history.mjs` | 纯函数：`normalizeWakeHistoryConfig` / `selectWakeHistory` / `formatWakeHistoryBlock`、`WAKE_HISTORY_DEFAULTS` |
| `src/bridge.js` `prefetchWakeHistoryBlockV2()` | 读配置 → `fetchOneBotHistory` → 选行 → 拼段；失败/禁用返回空串 |
| `src/bridge.js` `sendWakePromptV2()` | 先 await 预取，再 `buildWakePromptV2(key, reason, { history })` |
| `src/bridge.js` `buildWakePromptV2(key, reason, { preview, history })` | `history` 非空时插在 `statusLine` 之后 |
| `GET /api/socialV2/wake-prompt?key=..&history=1` | 只读预览：内容与真实唤醒一致，不写状态、不占冷却 |
| `scripts/test-wake-history.mjs` | 单测（配置归一化 / 去重与自己的判定 / 渲染 / 截断） |

## 配置（`config.json` 的 `socialV2.context.wakeHistory`，全部可选）

```json
{
  "socialV2": {
    "context": {
      "wakeHistory": {
        "enabled": true,
        "count": 12,
        "timeoutMs": 2500,
        "maxChars": 1600,
        "cooldownMs": 60000
      }
    }
  }
}
```

| 键 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `true` | — | `false` 完全不预取（也不发 OneBot 请求） |
| `count` | `12` | 1–50 | 注入多少条 |
| `timeoutMs` | `2500` | 300–8000 | 单次 OneBot 请求超时 |
| `maxChars` | `1600` | 200–6000 | 这段文本上限，超了从最旧的开始丢 |
| `cooldownMs` | `60000` | 0–1800000 | 同会话两次预取的最小间隔 |

也可以走控制台接口改（会归一化后写进 `config.json`）：

```powershell
POST /api/socialV2/config   {"context":{"wakeHistory":{"enabled":false}}}
```

## 日志

前缀 `[wake-history]`：

```
[wake-history] private:100000001 注入 12 条历史上下文（340 字符）
[wake-history] private:100000001（预览） 注入 6 条历史上下文（186 字符）
[wake-history] private:100000001 预取 99 条，无窗口外可用历史
[wake-history] private:100000001 预取失败（继续正常唤醒）：This operation was aborted
```

- `（预览）` = 来自 `wake-prompt?history=1` 的只读预览，不会写冷却、不写已注入集合。
- 没有这行日志 = 命中了冷却，或 `enabled:false`。

## 验证

```powershell
# 单测
& "C:\...\SnowLuma\node.exe" --test scripts/test-wake-history.mjs
& "C:\...\SnowLuma\node.exe" --check src/bridge.js

# 预览（token 在 state/console-token）
$t=(Get-Content state\console-token -RAW).Trim()
Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/socialV2/wake-prompt?key=private:100000001&reason=admin&history=1" -Headers @{'x-console-token'=$t} |
  Select-Object historyChars, historyIncluded

# 真实唤醒后看日志
Select-String -Path state\bridge.log -Pattern '\[wake-history\]' | Select-Object -Last 5
```

## 边界与已知风险

1. **历史接口依赖 SnowLuma**：`get_*_msg_history` 不可用时只有失败日志，唤醒照常；会话无群时（当前机器人不在任何群）群历史恒为空。
2. **`count>100` 静默空**：OneBot 侧超过 100 会返回空数组且 `status=ok`，所以预取内部封顶 100；调大 `count` 不会报错但拿不到更早的消息。
3. **自己的消息可能漏判**：`lastInboundSelfId` 只在收到 login 事件后才有值；极早期（刚启动、还没 login）预取时自己的消息会显示成昵称。
4. **去重表在内存里**：bridge 重启后 `wakeHistorySeenIds` 清空，重启后的第一次唤醒可能重贴一次最近 12 条——只是多几行上下文，无副作用。
5. **不解决群历史的缺失**：机器人当前不在群里，群会话历史拿不到；这条只对私聊和「已在群里的会话」有意义。

## 回滚

- 只想关掉：`socialV2.context.wakeHistory.enabled=false`（下一次唤醒即生效，无需重启）。
- 彻底移除：删掉 `src/wake-history.mjs`、`scripts/test-wake-history.mjs`，以及 `bridge.js` 里的 import、默认值、`wakeHistoryLastAt` / `wakeHistorySeenIds` / `wakePrepKeys`、`prefetchWakeHistoryBlockV2`、`buildWakePromptV2` 的 `history` 参数与 `historyLine`、`sendWakePromptV2` 里的预取块、wake-prompt 路由的 `history=1` 分支。
