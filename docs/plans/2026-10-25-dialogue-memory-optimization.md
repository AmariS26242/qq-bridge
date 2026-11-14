# QQ 端对话记忆优化方案

日期：2026-10-25
状态：待评审 · 未落地
范围：qq-bridge 的对话记忆与上下文成本（不改 DSH 本体，不改 QQ 协议层）

---

## 一、基线：现在到底花在哪

数据来源：`state/token-usage.jsonl`（只取 `k === "turn"` 行）、DSH 会话快照 `session.v4.jsonl.zstd`、`state/profiles.json`、`state/bridge.log`。复现脚本见文末「附录：探针」。

### 1. 成本与上下文水位

| 指标 | 实测值 |
|---|---|
| 2026-10-25 总花费 | ¥1.01（主会话 ¥0.97，占 96%） |
| 主会话单步平均输入 | **264,274 tokens**（155 次调用） |
| 已退役旧主会话单步平均输入 | **402,908 tokens**（1227 次调用，累计 ¥17.39） |
| 累计花费 | ¥20.51（旧会话独吞 ¥17.39） |
| 主会话历史长度 | 85 轮 / 2555 条记录 / 2.6M 字符 |
| 上下文增长速率 | turn1 18K → turn85 314K，约 **3.5K tokens/轮** |
| 模型窗口 | `contextWindow: 1048576`，`maxTokens: 256000` |

推算：按 3.5K/轮，约 280 轮后撞到 1M 窗口；而按当前日均 40 轮，**约两周**就得被迫换会话，届时单步成本约 ¥0.31。

### 2. 静默轮是最贵的浪费

```
turn 81–85（[SILENT]，没有回复）
每轮：1 次调用 · 输入 314,112 tokens · 输出 3–4 tokens
```

五轮静默烧掉约 1.57M 输入 token，产出合计不到 20 个字符。因为「被唤醒 → 判断不该说话 → [SILENT]」这个动作本身就要全量重放 314K 历史。

### 3. 步数是成本乘数

每多一步 = 一次全量上下文请求。今日工具调用分布（289 次调用 / 85 轮，每轮步数中位 3、最长 25）：

| 工具 | 次数 | 说明 |
|---|---|---|
| qq_wait_for_messages | 99 | 结果文本 50,695 字符，最大消耗源 |
| qq_send_message | 96 | 必要 |
| qq_mark_read | 31 | |
| qq_send_sticker | 10 | |
| qq_get_recent_messages | 8 | |
| qq_diary_write | 8 | |
| qq_get_unread_messages | 6 | |
| **qq_memory_append** | **0** | 短记忆层整轮没用过 |
| qq_memory_query / qq_slang_query | 1 / 1 | |
| memory_search | 4 | 跨会话检索，用得克制 |

### 4. 三层记忆的实际状态

| 层 | 设计上限 | 线上实况 | 判断 |
|---|---|---|---|
| 短记忆 `social-v2.json` | topics 20 / thoughts 2h / 印象 50 人 | **topics、印象全空**，85 轮 0 次写入 | 存在但闲置 |
| 长档案 `profiles.json` | 无限（权重衰减 120 天） | 1 人 52 条，抽取管线在跑 | **真正在承担记忆** |
| 摘要投喂 `pendingSummaries` | 每会话 60 条 | 今日日志无一条「进入摘要」 | 只有私聊，机制未被验证 |
| 日记 `state/diary/` | 一天一页 | 1 本 1 页（10-24） | 低频正常 |

### 5. 压缩能力其实有，但没人扣扳机

`dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 末尾已挂：

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate: { compaction: true, toolResultPruner: true }
```

包含 `compaction-basic`、`command-compact`、`tool-result-pruner`（`thresholdChars: 50000` / `headChars: 45000` / `tailChars: 2000`）。

问题有两个：
1. **阈值太松**：单条 tool result 要超 50,000 字符才裁，而实测最长的一条才 14,853 字符 —— 意味着**这个剪枝器从来没生效过**。
2. **桥接侧从不触发**：`src/` 里 grep `compact` 只命中 `qq-model-view.js` 的 `compactModelMessage`（那是模型视野裁剪，不是上下文压缩），也没有 `/compact` 控制台入口。全部指望 DSH 的自动阈值，而 1M 窗口下远未触发。

结果就是日志里 2555 条记录**没有任何 compaction 事件**，每步都是全量重放。

### 6. 已有的成本守门只管日报

`src/cost-guard.mjs` 已实现 `evaluateCostGuard` / `summarizeUsageBySession`，`config.json:537` 已启用：

```json
"costGuard": { "enabled": true, "cacheRateMin": 0.95, "dailyInputMax": 100000001, "topShareMin": 0.5 }
```

但它只有三个口径：缓存命中率、**日**输入总量、单会话占比。缺的正是最重要的那一维 —— **单会话当前的上下文水位**。而且 `dailyInputMax: 100000001`（1.5 亿/天）按今日实测（约 41M）几乎不可能触发。

---

## 二、优化项

排序依据：省下的钱 ÷ 改动风险。每项都给了验收指标。

### O1 · 上下文守门 + 会话交接轮换（核心）

**问题**：会话永不轮换，历史只增不减，每步成本随轮次线性上升；静默轮为 4 个字符的 `[SILENT]` 付 314K 输入。

**改法**：

1. 新增 `src/context-budget.mjs`（纯函数，可离线测）：
   - 输入：本会话最近 N 步的 `b.cacheHit + b.cacheMiss`（数据已在 `state/token-usage.jsonl`，**零额外请求**）。
   - 输出：`{ level: 'ok'|'soft'|'hard', watermark, softAt, hardAt }`。
   - 默认 `softAt: 60000`、`hardAt: 120000`，可通过 `config.json` 的 `contextBudget` 覆盖。
2. 在 `src/bridge.js` 的唤醒流程入口（`buildWakePromptV2` 之前）读取水位：
   - `soft`：往 `bridge.log` 写一行 `[budget] 上下文水位 62K（soft）`，并在唤醒提示词尾部追加一句「本轮请尽量少调用工具」。不动会话。
   - `hard`：**不立即轮换**，置 `pendingHandoff = true`，等安静期执行。
3. 安静期（`hard` 标记已置 + 距最后一条群消息 ≥5 分钟）执行交接：
   - 在**当前会话**里跑一次不发送的 turn，提示词固定要求输出 JSON：
     ```json
     {"topics":[...],"openLoops":[...],"peopleChange":[...],"mood":"..."}
     ```
     要求 ≤400 字，只写「新会话接着聊必须知道的」。
   - 结果写 `state/handoff/{key}.json`（保留最近 3 份）。
   - 然后 `retireSession(key)` → 下次唤醒 `ensureSession()` 自动新建。
4. `buildWakePromptV2` 增加 `handoffLine` 小节（预算 600 tokens），位置在 `memoryLine` 之后、`profileLine` 之前。

**预期**：单步输入 264K → ≤40K（交接 600 + 档案 900 + 短记忆 1200 + 历史预取 1600 + 窗口 20 条原文）。日花费按当前量级估从 ¥1.0 降到 ¥0.2 以下。

**风险与对策**：
- 丢细节 → 交接 JSON 只放「必须知道的」，原文由 `wake-history` 的 12 条 + 档案兜底；轮换后 24h 内人工抽查 3 个轮换点的连贯性。
- 交接 turn 本身花一次全量请求 → 用安静期 + 至少 6 小时冷却（`handoffCooldownMs`），避免频繁触发。

**验收**：轮换后新会话首个 turn 的 `cacheHit+cacheMiss` < 60K；24h 内 `bridge.log` 出现 ≥1 次 `[budget] 已交接 ...`；抽查对话无「你是谁/在聊什么」式断裂。

**工作量**：1–2 天（含单测 `scripts/test-context-budget.mjs`）。

---

### O2 · 剪枝阈值调参 —— 实测否决，不排产

**结论**：调 `tool-result-pruner` 的 `thresholdChars` **几乎裁不到东西**。289 条工具结果逐条实测（`state/tmp/tool-size-probe.mjs`）：p50 449 / p90 787 / 最大 14,791 字符，**>4000 只有 2 条**（`memory_search` 4018、`qq_get_prompt` 14791），>20000 为 0。50000→4000 至多裁掉这 2 条（<19K 字符 ≈ 6K tokens），相对单步 314K 是 2% 噪声，且 `qq_get_prompt` 裁掉等于自伤。

**为什么原来判错**：`qq_wait_for_messages` 的 50,695 字符是 99 次**累计**，不是单条；单条最大只有 842。真正的体积是 138,373 字符的**累积**被每步重放 —— 那是 O1 的活，pruner 按单条阈值工作，结构上管不了。

**留档动作（1 小时）**：固定样例跑一次插件确认 `thresholdChars` 是单条语义、`headChars+tailChars` 的解释方式，写进审阅版 10.2 未知项表，然后关闭本项。**不要改 agent.cordis.yml。**

---

### O3 · 等待步瘦身

**问题**：`qq_wait_for_messages` 99 次是步数最大来源，而静默轮（不说话）也要付全量上下文。

**改法**（三处，都在 `src/bridge.js`；前置事实见审阅版 6.3.0）：
1. **睡前观察条件化**：只有「本轮已经发过消息」才允许进入沉睡前观察。注意：纯静默轮想直接 `mark_read` 收尾，**必须先改 `preSleepWaitBlockedV2`（`:9601-9615`）的判定口径** —— 现在 `mark-read` 路由（`:5324-5334`）会 400 拒绝并提示去做 `qq_wait_for_messages(timeoutMs=300000)`。同时 `mark_read` 要求显式 `throughSeq`（省略会清空整队 unread，`:12218-12221`）。
2. **单轮等待次数封顶**：同一轮最多 2 次 `qq_wait_for_messages`，超出的调用返回明确错误（`等待次数已达本轮上限，请结束本轮`），避免 turn 77 那种 18 步连等。
3. **等待结果增量化**：`wait` 返回只给「本次新增 N 条 + 首尾各 2 条」，不再回全量快照（单条最大其实只有 842 字符，但每次调用都要重放整份 314K 上下文，增量是为了省步骤而非省字符）。

**预期**：每轮步数中位 3 → 2，总调用量 −20~30%，且静默轮从「1 次 314K 请求」变成「1 次 ~40K 请求」（配合 O1）。

**风险**：封顶可能让 AI 少听几句 → 但 2 次等待后仍可用 `qq_get_recent_messages` 主动取，不丢信息。

---

### O4 · 短记忆自动化（并在 O1 里顺带完成）

**问题**：`qq_memory_append` 85 轮 **0 次调用** —— 系统提示词让模型「自己记」，实际上它从不记。这一层现在纯占位：4 个工具定义进提示词、衰减逻辑天天跑、桶永远空。

**改法**（二选一，推荐 A）：

- **A（推荐，改造成本最低）**：`activeTopics` 交给 O1 的交接 turn 顺带产出（交接 JSON 的 `topics` 字段直接写进 `social-v2.json` 的 `activeTopics`）。同时**删掉** `qq_memory_append` / `qq_memory_query` / `qq_memory_remove` / `qq_memory_list` 四个工具（`config.json` 的 `mcp.toolGroups` 去掉 memory 组里的写入类，保留 `qq_diary_*`），少 4 个工具 schema、短记忆不再靠模型自律。
- **B**：桥接侧规则抽取 —— `flushSummaries` 时用「最近 30 条里被重复提及的名词 / 被 @ 的人」upsert `activeTopics`。

`memberImpressions` 建议**并入 profiles**（后者已有 30 天半衰期 + 证据要求 + 注入排序），不要在短记忆里维护两套「对人的印象」。

**验收**：轮换后 `social-v2.json` 的 `activeTopics` 非空且与最近话题相关；提示词 token 数下降（少 4 个工具定义）。

---

### O5 · 档案抽取 backlog

**问题**：`src/profiles.js:31` `sliceMaxMessages: 40` —— 抽取只看「最近 40 条」。聊得快的长会话中段内容会先滑出窗口再被抽，永久丢失。而冷却 `extractCooldownMs: 30 * 60 * 1000`（`profiles.js:33`）在 pending 积压时反而拖慢。

**改法**：
1. 抽取上下文从「最近 40 条」改成「**未抽取的 ≤200 条**」（按 `pendingMessages` 指针切片），超 200 条时丢弃最旧的并记日志。
2. 冷却自适应：`pending < 30` 用 30 分钟；`pending ≥ 30` 降到 10 分钟。
3. 抽取结果仍走 `looksLikeBareLabel()` / `scrubSensitive()` 校验，不改质量门槛。

**验收**：`state/profiles.json` 记录数增长率提升；`bridge.log` 中抽取间隔在积压时缩短；抽查新档案条目有 evidence 且非空泛标签。

---

### O6 · 摘要投喂可观测

**问题**：`flushSummaries`（`bridge.js:11425-11465`）是「AI 潜水也知道群里发生了什么」的唯一入口，但今日日志里**连一条「进入摘要」都没有** —— 无法判断是「没有群聊所以没触发」还是「机制坏了」。

**改法**：加 3 个计数与 1 条 info 日志：
- 进队时 `[summary] 入队 n 条（待投喂 m 条）`
- 投喂时 `[summary] 已投喂 k 条到 <sid>`
- silent turn 超时作废时 `[summary] silent 名额超时作废`

**验收**：群聊恢复后 24h 内日志里能量出「入队 / 投喂 / 作废」三个数。

---

### O7 · 控制台补「上下文水位」一列

**改法**：`docs/guides/TOKEN_USAGE_CONSOLE.md` 对应的「令牌与花费」页，每行加一列 `上下文`（= `b.cacheHit + b.cacheMiss`），并按 O1 的 soft/hard 阈值染色。

**坑（务必注意）**：`state/token-usage.jsonl` 里除了 `k:"turn"` 明细，还有 103 条 `k:"base"` 累计行。聚合时必须 `filter(r => r.k === 'turn')`，否则数字虚高约 100 倍（实测：含 base 算出 ¥11.35，过滤后 ¥1.01）。

**验收**：控制台显示的单步上下文与 `session-probe` 算出的值一致。

---

## 三、落地顺序

| 批次 | 内容 | 工作量 | 预期效果 |
|---|---|---|---|
| 第零批 | O7 统计口径修正（水位列 + 过滤 `k==="turn"` 的去重聚合） | 半天 | 先有可测量的水位，否则后面全是盲改 |
| 第二批 | O1 上下文守门 + 交接轮换（含 O4-A 短记忆改接） | 1–2 天 | 主体收益，单步 264K 推算 → ≤40K（待验证） |
| 第三批 | O3 等待步瘦身（先改 `preSleepWaitBlockedV2` 口径）+ O5 档案 backlog | 1 天 | 步数 −20~30%（待验证），档案更完整 |
| 第四批 | O6 摘要观测 + O2 否定验证留档（1 小时） | 2 小时 | 可观测性；O2 关闭归档 |

> O2 已实测否决（见二、O2 与审阅版附录 E）：调剪枝阈值裁不到东西，不进批次。原「第一批 O2 立刻见效、零风险」作废。

**验收总指标**（第二批上线后 7 天；以下目标均为推算，需按上线数据重新标定，不作为单一通过条件）：
- 单步平均输入 < 60,000 tokens（现 264,274）
- 日花费 < ¥0.30（现 ¥1.01）
- 静默轮单次输入 < 25,000 tokens（现 314,112；静默轮已是 1 步，省的是那一步的上下文）
- 档案条目增长率 ≥ 现状，且每条带 evidence

---

## 四、明确不做

1. **不把 profiles 换成向量检索**。现有档案是「具体事例 + evidence + 30 天半衰期 + 注入时按类取 1 条」，质量高于 top-k 片段召回；换检索会引入噪音和额外延迟，且丢失时间衰减。跨会话语义回忆已有 `memory_search`（`memory-index/`）覆盖。
2. **不做每天机械 `/reset`**。会丢掉正在进行的玩笑、表情包语境、未回应的消息，手感崩坏。必须用「安静期 + 交接」。
3. **不缩短 `contextWindow`**（`config.json` social.context）。20 条是对话连续性的下限，要省应该省在「不该说的话」上（O1/O3），不是省在「听懂」上。

---

## 五、待确认

1. `dsh-compaction-basic` 的可配置阈值 —— `app.asar` 的 asar header 超过 4MB，latin1 探测被截断（`SyntaxError: Unterminated string in JSON at position 4194287`），未能读出 schema。若它支持「按比例压缩历史而非按条数」，O1 可以更省事。
2. `retireSession()` 是否有「保留旧会话以便回查」的副作用（`bridge.js:3084/3122/3138` 是现有调用点），交接轮换要复用同一条路径，需要确认退役后旧 sid 是否还可在控制台查到。
3. 夜间 `internal:黑话学习` 会话（¥0.04/日）是否也该纳入同一套水位守门。

---

## 附录：探针

现有临时脚本在 `state/tmp/`（可清，建议把 2、3 提升进 `scripts/`）：

| 脚本 | 作用 |
|---|---|
| `session-probe2.mjs` | 解开多帧 zstd 会话快照，输出记录类型直方图 |
| `session-probe4.mjs` | 打印 `request/context`、`request/header`、唤醒提示词字符分位 |
| `tool-probe.mjs` | 工具调用次数与结果字符数排行 |
| `cost-probe2.mjs` | 按会话/按日聚合成本与单步平均输入（已过滤 `k:"base"`） |
| `scripts/tmp-usage-report.mjs` | 同口径的日/sid 聚合，已正确过滤 base 行 |

会话快照解压要点（血泪）：`session.v4.jsonl.zstd` 是 1504 个**连续 zstd 帧**拼接。Node 24 的 `zstdDecompressSync` 只解第一帧（得 258 字节头），流式 `createZstdDecompress` 直接抛 `ZSTD_error_prefix_unknown`。正确做法是扫 magic `28 b5 2f fd` 得帧偏移，逐帧解压再拼接。
