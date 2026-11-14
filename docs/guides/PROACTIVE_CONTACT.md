# 周期性主动联系（proactiveContact）

> 状态：✅ 2026-10-19 落地（QQ 桌面命令 #21），2026-10-20 按管理员参数调整频率（命令 #22）。
> 相关代码：`src/proactive-contact.js`（窗口/排期/决策/状态）、`src/bridge.js`（`initProactiveContact` / `proactiveTick` / `deliverProactivePromptV2`）、配置 `socialV2.proactiveContact`。
> 自测：`node scripts/test-proactive-contact.mjs`（离线，不需要 SnowLuma/QQ/网络）。

## 一句话

每天 `08:00–24:00` 之间每约 30 分钟（±3 分钟）递一句「随口找他聊一句」的轻提示，由 AI 现场决定说什么、说不说，
一天约 30–32 条；`00:00–08:00` 完全停。参数全在 `config.json`，改完**不用重启**。

## 它和「定时提醒」的区别

| | 定时提醒 `reminder` | 周期性主动联系 `proactiveContact` |
| --- | --- | --- |
| 由谁发起 | 管理员/AI 明确登记的一条待办 | 没有待办，只是想冒个泡 |
| 到点必须发吗 | 是（有正文就发正文） | 否，AI 可以不说；有对话就不打扰 |
| 内容 | 固定文字，或给 AI 的任务描述 | 只给「由头」，措辞现场组织 |
| 时段 | 任意（含深夜） | 只在白天窗口内 |
| 配额 | 条数上限 + 同会话最小间隔 | 每天最多 N 条 + 最近对话静默期 |

## 默认节奏（当前部署值）

- 窗口 `08:00–24:00`（`Asia/Shanghai`；`24:00` 就是当天结束，不会滑到次日 0 点），窗外一律顺延到次日 08:00 开窗，**绝不半夜补发**。
- 间隔 `30min ± 3min` 随机：16 小时窗口自然落在 08:00–24:00 之间约 30–32 条/天；`maxPerDay: 40` 只是兜底。
- 落点若贴着关窗（<5 分钟）或出了窗口，就推到下个开窗后再加 0–5 分钟随机，避免每天整点打卡。
- 到点时若最近 `2h` 内有正常对话（`lastIncomingAt` / `lastAiReplyAt` 任一在静默期内），本次**跳过**，排下一次——
  也就是你在跟它聊天的那两小时里它不会硬插一条。
- 会话正忙 → 顺延 5 分钟（不算跳过，不消耗当天额度）；DSH 未就绪/唤醒限频 → 顺延 5 分钟。
- 每次先落盘下一次排期再投递：崩溃重启最多少发一条，不会同一条发两遍。
- 代码里的**兜底默认**是 `10:00–23:00` / 3h / 6 条（配置缺项时才用），实际以 `config.json` 为准。

## 这个频率要花多少 token / 钱

主动联系本质上是「往同一个会话里塞一条 prompt」，每条都要模型重新读一遍整段会话上下文，
所以**频率翻 10 倍，token 大致也翻 10 倍**。按本机 `state/token-usage.jsonl` 实测（2026-10-16 ~ 10-19）：

- 本会话每步输入中位数约 **23 万 tokens**（其中 99% 是缓存命中），输出中位数约 240 tokens；
- 一条主动联系通常 **1–2 步**，按 1.5 步、30 万 tokens/步估：约 **45 万输入 tokens/条**；
- 32 条/天 → 约 **1400 万输入 tokens/天**，输出合计约 1–2 万 tokens/天。

DeepSeek 官方价（`deepseek-flash`，2026-10-17 版价目，高峰=工作日 9:00–12:00、14:00–18:00，其余为空闲时段半价）：

| 项目 | 空闲时段 | 高峰时段 |
| --- | --- | --- |
| 输入（缓存命中） | 0.02 元/百万 | 0.04 元/百万 |
| 输入（缓存未命中） | 1 元/百万 | 2 元/百万 |
| 输出 | 4 元/百万 | 8 元/百万 |

- **常态（缓存大多命中）**：1400 万 × 0.02~0.04 ≈ **0.3–0.6 元/天**；
- **混合估计（约 10% 未命中，白天高峰占一半）**：≈ **2–4 元/天**，即 **60–120 元/月**；
- **最坏情况（会话很长、间隔 30 分钟导致缓存频繁过期，几乎全按未命中计）**：≈ **14–28 元/天**。

省钱的三个旋钮：调大 `intervalMs`（最有效）、调大 `quietAfterTalkMs`（聊天时自动少发）、用 `dryRun: true` 先空跑。
输出和联网检索可以忽略，大头永远是「重读整个会话上下文」。

## 怎么改参数

编辑 `qq-bridge/config.json` → `socialV2.proactiveContact`，**保存即生效**（桥每 60 秒按 mtime 重读一次，解析失败时沿用上一次成功的值）。

| 配置项 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 立即停（正在跑的那次不受影响） |
| `targetKey` | `""` | 发给谁；空 = `private:<ownerQQ>`；只接受 `private:数字` / `group:数字` |
| `windowStart` / `windowEnd` | `"08:00"` / `"24:00"` | 允许发言的时段；`windowEnd` 可以写 `24:00`（= 当天结束，等价次日 00:00），也可以写 `00:00` 表示跨午夜到 0 点；`start === end` 视为全天；`start > end` 表示跨午夜 |
| `intervalMs` | `1800000`（30min） | 两次尝试的基准间隔，夹紧到 5 分钟–24 小时 |
| `jitterMs` | `180000`（3min） | 间隔随机抖动量，自动夹到 ≤ interval/2 |
| `quietAfterTalkMs` | `7200000`（2h） | 最近这么久内有对话就跳过本次 |
| `maxPerDay` | `40` | 每天（日历日）最多成功递出几条；`0` = 不限。30 分钟一档自然约 32 条，40 只是兜底 |
| `tickMs` | `60000` | 检查间隔（改这个需要重启桥才生效，其余项不用） |
| `prompt` | `"随意找他说句话"` | 递给 AI 的由头；换成任何一句话都行 |
| `dryRun` | `false` | 只走排期和日志、不真投递（试跑/排障用） |

常见改法：

```jsonc
// 想安静点：3 小时一次（2026-10-19 之前的节奏）
"intervalMs": 10800000,
"jitterMs": 1800000,
"maxPerDay": 10

// 再密一点：20 分钟一次，晚上 11:30 就收工
"intervalMs": 1200000,
"jitterMs": 120000,
"windowEnd": "23:30"

// 只在某个群冒泡
"targetKey": "group:100000001"

// 先空跑：只写日志「本应递给 …」，不发真消息
"dryRun": true
```

## 怎么暂停

三种粒度，任选：

1. **临时停（推荐）**：`"enabled": false` 保存即可，不重启。
2. **暂停整个二代社交**：控制台/`state/mode.json` 切到非 `reserved2` 模式，或 `socialV2.paused = true`——主动联系一并停。
3. **只停这一条排期**：删掉 `state/proactive-contact.json`；下次启动会按当前配置重排（不会补发错过的那次）。

恢复：把 `enabled` 改回 `true` 保存，若排期已被清空，最多等一个 `tickMs`（60 秒）就会重排。

## 怎么看它在干什么

```powershell
# 最近的主动联系日志（跳过/顺延/已递出/失败都有原因和下一次时间）
Select-String -Path qq-bridge\state\bridge.log -Pattern '\[proactive\]' | Select-Object -Last 20
```

日志形态：

- `[proactive] 已启用：目标 …, 窗口 …, 下一次 2026-10-20 10:17` —— 启动时打印排期
- `[proactive] 跳到/顺延：最近 37 分钟内有正常对话，不打断，下次 …`
- `[proactive] 已递出轻提示 -> private:…，下次 …`
- `[proactive] 暂缓 300s：会话正忙` —— 会重试，不消耗当天额度
- `[proactive] 递出失败（本次作废，等下个周期）：…`

状态文件 `state/proactive-contact.json` 里能看到 `nextRunAt`、`lastFireAt`、`lastSkip` 和最近 50 条历史。
注意它是「运行态」文件，手改只建议改 `nextRunAt`（epoch 毫秒）。

## 实现要点

1. **纯决策 + 薄接线**：`decideProactive()` 是纯函数（窗口/最近对话/忙/暂停/额度 → `fire|wait|skip` + 下一次），
   方便离线单测；`src/bridge.js` 只负责取状态、投递、记账。
2. **投递的是 prompt 型唤醒**：`deliverPrompt(key, 轻提示, { silent: true })`，和群聊唤醒共用
   `wakeTimes` 限频（`socialV2.wake.maxWakePerMinute/Hour`）；AI 自己用 `qq_send_message` 发。
3. **先排期后发送**：`setNext()` 先落盘，发送失败也不会卡在同一条上反复触发。
4. **热读配置**：按 `config.json` 的 mtime+size 缓存，解析失败保留上次好值（改配置改到一半不会停摆）。
5. **夜间安全**：所有排期计算都会把落点夹回窗口内；停机超过 30 分钟的旧排期直接作废重排，
   避免「半夜开机补发一条」。

## 排障

| 现象 | 先看 |
| --- | --- |
| 一直没动静 | `state/bridge.log` 的 `[proactive]` 行：`跳到`=刚聊过/额度满，`顺延`=忙或窗外，`已启用` 行里的「下一次」是否在预期时段 |
| 太频繁 / 太吵 | 调大 `intervalMs`/`quietAfterTalkMs`，或调小 `maxPerDay`；`enabled:false` 先停 |
| 月底账单偏高 | 间隔越短越贵（每次都重读整段会话上下文）；先按上面的开销表估，必要时调到 1–3 小时一档或 `dryRun:true` |
| 夜里收到消息 | 检查 `windowStart/windowEnd` 是否被改成全天，或 `targetKey` 被别的实例同时写入 |
| 想先看效果不打扰 | 设 `dryRun: true`，日志里出现「本应递给 …（未真发）」即说明调度正常 |
| 改了配置没反应 | 确认改的是 `qq-bridge/config.json` 的 `socialV2.proactiveContact`；`tickMs` 需重启桥 |
