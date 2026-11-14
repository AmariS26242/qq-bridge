# 提醒「提前说一句」（reminder.nudge，⑨）

> 状态：✅ 2026-10-24 落地。
> 相关代码：`src/reminder-nudge.js`（窗口/决策/去重状态/提示词）、`src/bridge.js`（`initReminderNudge` / `reminderNudgeTick` / `deliverReminderNudgeV2`，挂在 `reminderTick()` 末尾）、配置 `socialV2.reminder.nudge`。
> 自测：`node scripts/test-reminder-nudge.mjs`（离线，9 项）。

## 一句话

提醒到点前 10 分钟内，先给 AI 递一句「快到了，要不要顺口垫一句」，让它提前露个面；
准点那条提醒**不受影响**，照常触发。

## 它和准点提醒、周期性主动联系的区别

| | 准点提醒 `reminder` | 提前播报 `nudge` | 周期主动联系 `proactiveContact` |
| --- | --- | --- | --- |
| 触发 | `nextRunAt` 到点 | 到点前 `leadMs` 内 | 固定间隔（约 30 分钟） |
| 必发吗 | 是 | **不是**，AI 可不说；失败只记日志 | 不是 |
| 内容 | 固定文字 / 任务描述 | 「快到了」的软提示 | 「随口聊一句」 |
| 配额 | 条数上限 + 同会话间隔 | 每天最多 3 条 + 刚聊过 15 分钟不插话 | 每天 40 条 |
| 时段 | 任意 | 09:00–23:00 | 08:00–24:00 |

## 行为细节

- 候选：`status==='pending'`、`0 < nextRunAt-now <= leadMs`、且**这一场**没播过（按 `id@nextRunAt` 去重，周期提醒下一轮可再播）。
- 顺序：模式 → 暂停 → 时间段 → 每日上限 → 候选 → 刚聊过（等）→ 会话忙（等）→ 静默（跳）。
- 「刚聊过」= `lastIncomingAt` / `lastAiReplyAt` 任一在 `quietAfterTalkMs`（默认 15 分钟）内 → 记为 `wait`，下个 tick 再看，不消耗额度。
- 一次 tick 只播**最早**那一条；不同会话各自判断，但全局一次只发一条，避免群发式骚扰。
- 先 `markNudged` 落盘再投递：崩在中间最多丢一次，重启后不会把同一条反复播。投递失败（`ok===false` / `skipped` / `queued`）会 `unmark`，等下一 tick 重来。
- 唤醒限频沿用 `socialV2.wake.maxWakePerMinute/Hour`，与准点提醒、唤醒共用 `st.wakeTimes`。
- 提前播报**不消耗**提醒的重试次数、不改 `nextRunAt`、不写 `reminders.json`。

## 配置（`config.json`）

```jsonc
"socialV2": {
  "reminder": {
    "nudge": {
      "enabled": true,
      "leadMs": 600000,       // 到点前 10 分钟；夹在 1–60 分钟
      "maxPerDay": 3,         // 0 = 不限；最大 10
      "windowStart": "09:00",
      "windowEnd": "23:00",   // 支持 "24:00"
      "quietAfterTalkMs": 900000  // 刚聊过 15 分钟内不插话；0 = 不避让
    }
  }
}
```

改完需重启 bridge（提醒引擎在启动时读配置）。

## 状态文件 `state/reminder-nudge.json`

```jsonc
{ "version": 1, "updatedAt": 0,
  "nudged": [{ "id": "rm-…", "runAt": 1792824741938, "key": "private:123", "at": 0 }],  // 保留 7 天，上限 500
  "history": [{ "at": 0, "action": "fire", "id": "rm-…", "runAt": 0, "minutes": 8 }] }  // 上限 100，用于每日计数
```

坏了自动备份成 `reminder-nudge.json.corrupt-<ts>` 再重置——最多少播一次，不影响准点提醒。

## 验证

1. 建一条 15 分钟后的提醒（`POST /api/reminder/create`，带 `x-console-token`），等 tick：
   日志出现 `[reminder-nudge] private:… 提前 N 分钟播报（rm-…）`，QQ 里应收到一句轻的铺垫。
2. `state/reminder-nudge.json` 的 `history` 里多一条 `action:"fire"`；当天再触发会被 `maxPerDay` 拦住。
3. 在 23:30 手动触发一次 → 日志 `跳过提前播报：不在可开口时段（09:00-23:00）`（每 10 分钟最多记一次，不刷屏）。
4. 离线：`node scripts/test-reminder-nudge.mjs`。

> 2026-10-24 14:42 实测：`rm-mvm10xw2-402fb1`（14:52 到点）在 14:42:30 触发 `提前 10 分钟播报`，状态文件写入 `nudged` + `history[{action:"fire",minutes:10}]`；当轮 AI 判断「刚收尾 3 分钟，不必再说」，没有硬发 —— 这是预期的软提示行为。

## 关闭

`socialV2.reminder.nudge.enabled = false` 后重启；准点提醒完全不受影响。
