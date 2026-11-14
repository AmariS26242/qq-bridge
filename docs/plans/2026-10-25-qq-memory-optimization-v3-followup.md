# QQ 机器人记忆/上下文优化 v3 —— 落实记录（2026-10-25）

对应审阅稿：`2026-10-25-qq-memory-optimization-review-v3.md`（用户 Downloads 目录）与本仓库
`docs/plans/2026-10-25-qq-memory-optimization-review.md`。

**总体原则（本次落实的硬约束）**：默认全部走影子/只观测，不改变现有生产行为；每项都有独立开关可一键回滚；
不把推测写成实测 —— 本文所有数字都标了来源与取得方式。

| 项 | 状态 | 生产行为变化 |
|---|---|---|
| O7 上下文列 + 第 4 条成本红线 | 已落地（只读观测） | 无（只多一列、多一条红线；红线按实测校准到 340K） |
| O1 context-budget + handoff | 已落地，默认 `enabled:false` | 无（关闭时不读水位、不写交接、不注入） |
| O6 摘要三计数 | 已落地（只读观测） | 无（只加计数与节流日志） |
| O3 wait 增量字段 / 静默轮放行 / mark_read 严格化 | 部分落地（见 §5） | 静默轮放行会改变"睡前要不要再观察"的判定；严格化默认关 |
| O5 档案游标分片 | 已落地 | 有：抽取改成游标推进、积压上限从 40 抬到 400 |
| O2 工具结果瘦身 | **不排产**，只做否定验证 | 无（没动任何 pruner 配置） |
| O4 记忆写入工具收敛 | 未做（不在批次 0） | — |

---

## 1. O7 控制台「上下文」列 + 第 4 条成本红线

**数据源**：token 台账里单条 `k:"turn"` 采样的 `cacheHit + cacheMiss`。
**口径**（写进 `src/token-ledger.js` 头注释第 4 条设计约束）：同一 session 取**最近一条**有效采样，
不是历史最大值；无数据必须 `null`，**绝不能当 0**。排序键 `t → turn → step → retry → seq`。

改动：

- `src/token-ledger.js`：新增 `compareSampleOrder(a,b)`、`watermarkOf(buckets)`；`buildIndex()` 按序去重取最靠后者
  写 `contextWatermark`；`sessionView()` 跨 sessionIds 取最大；`summary()` 每会话行带 `contextWatermark`，
  `totals.contextWatermarkMax` / `contextWatermarkMaxSession` 在 `slice(0,limit)` **之前**算；
  `recent()` 每条自带；新增公开方法 `watermarks()`（按水位降序，无数据 `[]`）。
- `public/console.html`：三张表都加「上下文」列（位置：命中输入之后、命中率/输出之前）。染色
  `.usage-ctx-hard` ≥120000 / `.usage-ctx-soft` ≥60000 / `null` → `—`，一律过 `esc()`。
  表头 `title` 与表尾补口径说明。
- `src/cost-guard.mjs`：`COST_GUARD_DEFAULTS.contextWatermarkMax = 120_000`；
  `normalizeCostGuardConfig` 只收 `[1e3,5e6]` 的整数；`evaluateCostGuard` 第 4 条红线 `code:'context-watermark'`
  （`!= null && >= 阈值` 才报）；`renderCostBriefLine` 输出形如「水位 314.4k>340.0k」。
- `config.json`：`"costGuard": { "contextWatermarkMax": 340000 }`。

**为什么阈值是 340000 而不是代码默认 120000**：本机实测单会话 24h 水位 314,428（会话
`private:100000001`，2026-10-25 22:49 通过 `/api/tokens/summary` 读到 `totals.contextWatermarkMax=314428`）。
用 120,000 会让日简报天天报红，等于没有红项；340,000 高于当前实测、仍能抓回归。

**实测（改动后，活的 bridge）**：
```
GET /api/tokens/summary?limit=2 →
conversations[0] = {"key":"private:100000001", … ,"contextWatermark":314428}
totals.contextWatermarkMax=314428  owner=private:100000001
GET /api/tokens/recent?limit=2 →
{"time":1792938132451,"turn":86,"step":1,"tokens":314432,"cacheMiss":188,"cacheHit":314240,
 "output":4,"contextWatermark":314428,…}
```
注意 `contextWatermark`(314428) = `cacheHit+cacheMiss`，比 `tokens`(314432) 少 4 —— 少的正是 `output`，
符合口径定义。

---

## 2. O1 context-budget 守门 + 交接（影子）

### 2.1 新模块

- `src/context-budget.mjs`：`CONTEXT_BUDGET_DEFAULTS`（`enabled:false, mode:'shadow', softAt:60000,
  hardAt:120000, handoffTokenBudget:600`）、`normalizeContextBudgetConfig`、`classifyContextWatermark`、
  `formatContextWatermark`、`renderBudgetLogLine`、`shouldRequestHandoff`。
  语义：`enabled` 严格 `=== true`；config 为 null 或未启用时一律 `'ok'`；水位非有限数/负数 → `'unknown'`；
  `shouldRequestHandoff` 仅 `hard` + `mode:'enforce'` 为真。
- `src/handoff.mjs`：`HANDOFF_SCHEMA_VERSION`、`createHandoffStore`（**先写临时文件再原子替换**，
  保留最近 3 份、记生成时间/来源 session/schema 版本/成功失败）、`normalizeHandoffPayload`（校验 schema 版本、
  字段类型、长度、字段白名单）、`buildHandoffLine`（注入用的纯文本行，带字符预算）、`shouldRunHandoff`
  （候选条件：距最后一条相关消息 ≥5 分钟 且 距上次成功交接 ≥6 小时 且 pending）。

### 2.2 接线（`src/bridge.js`）

- import 两个模块；`const HANDOFF_DIR = path.join(STATE_DIR, 'handoff')`。
- 函数族：`contextBudgetConfig()` / `handoffStore()` / `sessionIdForV2Key(key)` /
  `sessionContextWatermark(key)`（读 `tokenLedger.watermarks()`，不可用或查不到 → `null`）/
  `buildHandoffFromStateV2(st)` / `runHandoffAtSafePointV2(key, st)` / `evaluateContextBudgetV2(key, st, where)` /
  `formatHandoffLineV2(key, st)`。
- `buildWakePromptV2`：非 preview 时先 `evaluateContextBudgetV2(key, st, 'wake')`；交接行插在
  `memoryLine` **之后**（`wakeLine + memoryLine + handoffLine + profileLine + …`）。
- `GET /api/social` 新增 `contextBudget`：`enabled/mode/softAt/hardAt/softLabel/hardLabel/defaults/sessions`，
  每会话优先**现算**水位（拿不到才退回上次落盘值），否则重启后控制台会一直显示 `—`。

### 2.3 两处有意的设计偏离（必须知道的）

1. **交接 JSON 由本地状态确定性生成，不调模型**。审阅稿写的是「让当前会话生成一段不发送的交接 JSON」。
   实际做法是从 `st.activeTopics`（topics ≤4）、`st.pendingThoughts`（openLoops ≤3）、
   `st.memberImpressions` 里 24h 内出现过的（peopleChange ≤3）拼，`insideJokes:[]`、`mood:''`。
   理由：省一次模型调用；结构可控；不可能出现"模型猜内容"；影子阶段需要的只是 20 个可抽查的样本。
   代价：交接的信息量受本地状态丰富度限制，`mood`/`insideJokes` 恒空。
2. **影子模式不注入、不退役**。`formatHandoffLineV2` 只在 `mode === 'enforce'` 时返回内容，shadow 只打一条
   节流日志「shadow 模式不注入交接行（本应 N 字）」；`runHandoffAtSafePointV2` 只在 enforce 时
   `retireSession`。这是为了守住「影子不改生产 prompt」。
   `evaluateContextBudgetV2` 在 `hard` 时会置 `pendingHandoff=true` 并尝试交接（落盘成功才清标记），
   但落盘失败会保留旧会话与 pending 标记等重试，不会出现"先退役再写文件"。

### 2.4 回滚

`config.json` 里 `contextBudget.enabled = false`（当前就是 false）即可全停；代码路径自身还会判断
`enabled`，所以即使误删配置段也退化成关闭。

---

## 3. O6 摘要三计数 + 三条日志

目标：把「今天没群聊」和「机制坏了」区分开。

- `social.summaryStats = { enqueued, fed, expired, fedBatches }`（`src/bridge.js` `social` 初始化处）。
- 入队（`appendSummary`）：`enqueued += 1`，节流（60s 或每跨 20 条）打
  `[summary] 入队 1 条（待投喂 N 条）(key)`。
- 投喂（`flushSummaries` 成功分支）：`fed += items.length; fedBatches += 1`，沿用既有的
  `已投喂群聊摘要 (key) N 条`。
- 作废（静默名额超时循环）：逐条 `expired += 1` 并打 `[summary] silent 名额超时作废 N 个（累计）(key)`。
- `GET /api/social` 新增 `summaryStats`（含 `pendingTotal` 待投喂总条数）。

**实测**：`GET /api/social → summaryStats={"enqueued":0,"fed":0,"expired":0,"fedBatches":0,"pendingTotal":0}`
（重启后清零，属内存计数设计；要看跨天趋势应查日志行）。

---

## 4. O3 等待瘦身（部分落地）

### 4.1 已做

1. **wait 返回增量摘要字段**：`/api/socialV2/wait` 响应追加 `newCount` 与
   `newMessagesRange:{firstSeq,lastSeq}`。**没有截断 `newMessages`** —— 截断会破坏
   `noteModelMessagesV2` 的全量标记，进而破坏 `readThroughSeq` 水位不变量；且实测 wait 不是主要成本。
2. **wait 次数/返回条数观测**：内存态 `waitStatsV2`（key → `{calls, returned}`），日志
   `[wait] key 第 N 次等待，本次带回 X 条，累计 Y 条`（有新消息或每 5 次打一条）。用于后续决定"单轮 wait 上限"。
3. **静默轮不强制观察**：`preSleepWaitBlockedV2` 增加第 6 个放行分支 ——
   `wake.skipSilentTurn !== false` 且 `st.silentTurnAt > st.lastIncomingAt` 且本轮之后没发过消息
   （`!(lastAiReplyAt > silentTurnAt)`）→ 放行可睡。`silentTurnAt` 在 `deliverPromptNow` 里对
   `opts.silent && !opts.wakeReason` 的投递打时间戳。回滚：`wake.skipSilentTurn:false` 或
   `wake.preSleepWaitEnabled:false`。
4. **`mark_read` 严格化（默认关）**：AI（带 agent token）省略 `throughSeq` 时，只有
   `socialV2.markRead.requireThroughSeq === true` 才返回 400 `code:'throughSeq-required'`；
   默认走 legacy 兼容路径（清空全部未读），并节流打
   `[mark_read] AI 省略 throughSeq，走兼容路径清空全部未读（legacy；要强制请设 …requireThroughSeq=true）`。
5. **mark_read 日志补口径**：`（剩余未读 N 条，游标 X）`。
6. 错误响应体：全局 catch 改为 `failPayload`，仅当 `error.code` 存在时追加 `code` 字段，既有响应体不变。

### 4.2 没做（及原因）

- **单轮 wait 上限（候选 2）**：审阅稿要求先确认游标/未读不变量。已确认 `newMessages` 不能截断，
  但"超限安全结束当前 step 并保留未处理消息"涉及回合收尾语义，属**行为改动**，与本次"影子优先"冲突，
  故只加观测计数，等 O3 第 2 步的数据支撑后再做。
- **`throughSeq` 允许小于已展示水位**：现有实现已经允许 `seq <= readThroughSeqV2(st)`
  且日志记差异，未再放宽到"任意小"。

### 4.3 回归事故与修正（值得记住）

第一版把 `mark_read` 严格化做成**默认开启**，直接把 `scripts/test-token-economy.mjs` 的
「legacy mark-read still clears all unread」断言打挂（400 !== 200），也就是立刻改了生产语义。
改为默认关 + 显式开启后，`test-token-economy.mjs` 回到 36/36。教训：**影子阶段的严格化必须 opt-in**。

---

## 5. O5 档案抽取：游标 + 分片

问题：`sliceMaxMessages: 40` 意味着 `profileWindows` 只留最近 40 条，聊得快时中段消息**永久丢失**。

- 新模块 `src/profile-slice.mjs`：`PROFILE_SLICE_DEFAULTS`（`maxMessages:40, minMessages:6, maxBacklog:400`）、
  `normalizeSliceCursor`、`planSlice`、`describeBacklog`、`commitSlice`。
  判定顺序：规范化（丢非法 seq、同 seq 留首次、按 seq 升序）→ 算 `gap`/`overflow`（旁路，不影响切片）→
  `items` 取待处理最旧前 `maxMessages` 条 → `reason` 按 `no-new` → `below-min` → `ok`。
  `below-min` 与非 ok 时游标**不前进**（重试同批）。
- `src/bridge.js`：
  - `profileSeq` / `profileCursor(key)` / `setProfileCursor(key, cursor)`（落 `profiles.meta.sliceCursors`）/
    `nextProfileSeq(key)`（首次用游标播种，重启不会把新 seq 排到游标之前）。
  - `feedProfileWindow` 的 cap 从 `sliceMaxMessages`(40) 抬到 `Math.max(20, maxBacklog||400)`；
    溢出时打 `[profile] key 待抽取积压超上限 N，区间 A-B 共 M 条被迫丢弃（原因 backlog-hard-cap）` —— 不静默丢。
  - `runProfileExtraction` 改用 `planSlice`/`commitSlice`：成功才提交游标、只移除已提交区间；
    剩余 ≥ `sliceMinMessages` 且片数 < 3 时继续排下一片；失败不清窗口、不动游标（重试同批）。
  - gap 打 `消息不连续：游标 X 之后首条是 Y（期望 X+1）`。
- 质量门槛未变：`looksLikeBareLabel` / `scrubSensitive` / 6–160 字 / 必须带 evidence / 独立学习会话；
  `extractPerHour: 20` 仍是硬闸。

回滚：`config.json → socialV2.profile.enabled = false`（整块停用抽取）。

---

## 6. O2 否定验证（不排产，附实测）

**结论：`tool-result-pruner` 的 `thresholdChars: 50000` 从未触发，不是配置错误，而是工具结果分布本来就在阈值下面。**

方法（可复现）：`node scripts/tool-result-sizes.mjs [--dir <会话目录>] [--only-session-tool <子串>] [--json]`。
DSH 的 `session.v4.jsonl.zstd` 是**多帧 zstd 拼接**（一行一帧），Node 的 `zstdDecompressSync` 只解第一帧，
所以脚本先按 zstd magic `28 B5 2F FD` 切帧再逐帧解压；事件形状
`{type:'tool/result', data:{turn,step,message:{content:[{type:'text',text}]}}}`，工具名靠配对的
`{type:'tool/call', data:{callId,name}}` 还原。

### 6.1 机器人真实 QQ 会话（只统计用过 `mcp__snowluma__*` 的 3 个会话）

```
扫描 161 个会话文件、128273 条事件，统计 3 个会话里的 1577 条工具结果
字符数分布：p50=384 p90=707 p95=1081 max=49932 合计=1053564
>4000=29 条，>20000=6 条，>50000=0 条；compaction/prune 事件=31
  mcp__snowluma__qq_wait_for_messages: 538 次，max=20970，均值=547
  mcp__snowluma__qq_set_wake_config: 93 次，max=645，均值=593
  pwsh: 74 次，max=49930；read: 30 次，max=27876；web_fetch: 3 次，max=49932
```

### 6.2 全部 DSH 会话（含人工开发会话，作为上界参考）

```
18567 条工具结果：p50=454 p90=4185 p95=6791 max=53668 合计=31710359
>4000=1975，>20000=165，>50000=1
  pwsh 8338 次 max=49979；read 2579 次 max=53668；grep 771 次 max=42001；web_fetch 262 次 max=49931
```

### 6.3 与 v3 审阅稿的差异（如实记录）

v3 记的是「289 条，p50 449 / p90 787 / max 14,791，>20000 为 0」。本次用更大样本重测：机器人会话
1,577 条，p50 384 / p90 707 / max 49,932，**>20000 有 6 条**（不是 0），>50000 仍为 0。

两个数字要一起看：单条 p90 700 不算大，但 1,577 条合计 105 万字符，这些内容随 L0 全量重放才是成本来源
（实测会话水位 314K）。所以：
- **O2 的否定结论成立**（阈值 50,000 在实测最大值之上，pruner 该不触发）；
- 但"结果都不大所以不用管"的解释要修正为"**单条不大、累积很大**"，正解仍是 O1 轮换而不是调 pruner 阈值；
- 同时注意 max 49,932 距离阈值只有 68 字符 —— 阈值实际处于临界位置，将来加一条 `web_fetch` 大页面就会触发，
  届时 pruner 会**开始**裁剪，不要再把"从未触发"当基线。

**本次未改任何 pruner 配置**（`tool-result-pruner` 的阈值保持 50000），符合审阅稿"只留验证、不排产"。

---

## 7. 验证证据

### 7.1 单测（本机 `node scripts/test-*.mjs`）

| 脚本 | 结果 |
|---|---|
| `test-context-budget.mjs` | PASS 26 |
| `test-handoff.mjs` | PASS 29 |
| `test-profile-slice.mjs` | PASS 21 |
| `test-cost-guard.mjs` | PASS 26 |
| `test-doctor.mjs` | PASS 37 |
| `test-daily-brief.mjs` | PASS 20 |
| `test-profiles.mjs` | 31/31 |
| `test-token-usage.mjs` | PASS 97（新增 10 项覆盖水位口径） |
| `test-console-ui.mjs` | PASS 4（静态契约；本机无 playwright） |
| `test-console-static.mjs` | 全部通过 |
| `test-token-economy.mjs` | 36/36 |
| `test-v2-wait.mjs` / `test-reply-wait.mjs` | 通过 |

全量 87 个脚本中 14 个失败，**逐条归因后无一是本次改动引起**（详见 §8.2）。

### 7.2 活体接口（重启后 PID 见下）

```
GET /api/social → summaryStats={"enqueued":0,…,"pendingTotal":0}
contextBudget={"enabled":false,"mode":"shadow","softAt":60000,"hardAt":120000,
  "softLabel":"60K","hardLabel":"120K","defaults":{…},"sessions":{…}}
GET /api/tokens/summary → conversations[0].contextWatermark=314428，totals.contextWatermarkMax=314428
GET /api/tokens/recent  → 每行带 contextWatermark
```

### 7.3 服务状态（`qqbot.mjs status`，重启后）

```
SnowLuma (5099) : 运行中
DSH      (19388) : 运行中
采样代理  (8790) : 运行中
qq-bridge(3100) : 运行中 (PID 55568)
QQ 进程 : 21352 [已 hook 100000001]
小号 100000001 : 已接入
```
五项全绿。重启前 bridge PID 33960（旧代码），重启后加载新代码，`/api/social` 出现
`summaryStats`/`contextBudget` 即证明新代码在跑。

---

## 8. 遗留风险与未完成

### 8.1 功能面

1. **O1 从未在 enforce 下跑过**：交接生成、落盘、注入、退役这条链只有单测覆盖，没有一次真实轮换。
   要验，需要把 `contextBudget.enabled` 置 true 且 `mode: 'enforce'`，等一次跨 6 小时的实际交接。
   建议先 `enabled:true, mode:'shadow'` 跑几天，攒够 20 个交接文件人工抽查（审阅稿的验收项之一）
   再切 enforce。
2. **交接信息量偏薄**：`mood`/`insideJokes` 恒空，`topics` 受 `activeTopics` 长度限制。
3. **O3 单轮 wait 上限没做**：只有观测计数，没有强制上限（理由见 §4.2）。
4. **O6 计数是内存态**：重启清零，跨天趋势只能看日志。
5. **O4 未动**：`qq_memory_append` 的收敛（含删除 4 个工具）不在本批次。

### 8.2 环境导致的测试失败（非本次改动）

| 脚本 | 原因 |
|---|---|
| `test-dsh-auth` / `test-dsh-v2-wait` / `test-dsh-session-retire` / `test-desk-command` | 硬编码 `127.0.0.1:3080`，本机 `config.json` 的 `dsh.baseUrl` 是 `19388` → `ECONNREFUSED 3080` |
| `test-qq-model-view` | fixture 只复制 3 个文件，`src/mcp-snowluma-safe.js`（mtime 17:18，早于本次改动）已 `import './media-note.js'`、`'./voice-tts.mjs'` → 子进程启动即死（`MCP error -32000: Connection closed`） |
| `test-qq-mode-plugin` | 插件 `Config` schema 断言 2 项失败，与 bridge 无关 |
| `test-vision-media` | 断言 `config.dsh.reasoningEffort === 'max'`，实配 `high` |
| `test-voice-system` / `test-voice-tts` | 依赖 `voice-tool/` 目录，本机没有 |
| `test-onebot-connection` / `test-forward` | 需要特定连接/会话状态 |
| `test-audit*` | 聚合器，因上面几条连带失败 |

### 8.3 回滚清单

| 项 | 回滚动作 |
|---|---|
| O1 全部 | `contextBudget.enabled = false`（当前默认） |
| 交接注入（仅 enforce 生效） | `contextBudget.mode = 'shadow'` |
| O7 第 4 条红线 | `costGuard.contextWatermarkMax` 调大，或 `costGuard.enabled=false` |
| 静默轮放行 | `socialV2.wake.skipSilentTurn = false` |
| mark_read 严格化 | `socialV2.markRead.requireThroughSeq = false`（当前默认就是关） |
| O5 游标分片 | `socialV2.profile.enabled = false` |

---

## 9. 工具与脚本

- `scripts/tool-result-sizes.mjs`：§6 的统计脚本（只读）。`--dir <会话目录>` 限定范围，
  `--only-session-tool mcp__snowluma__` 只算机器人真实对话，`--json` 出机读结果。
- 新增/改动文件清单：
  `src/context-budget.mjs`、`src/handoff.mjs`、`src/profile-slice.mjs`、`src/cost-guard.mjs`、
  `src/token-ledger.js`、`src/bridge.js`、`public/console.html`、`config.json`、
  `scripts/test-context-budget.mjs`、`scripts/test-handoff.mjs`、`scripts/test-profile-slice.mjs`、
  `scripts/test-token-usage.mjs`、`scripts/test-console-ui.mjs`、`scripts/console-ui-contracts.json`、
  `scripts/console-ui-fixture.mjs`、`scripts/tool-result-sizes.mjs`、本文件。
