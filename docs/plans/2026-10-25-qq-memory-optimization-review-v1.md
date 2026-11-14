# QQ 机器人对话记忆层：优化方案（外部审阅版）

> ⚠️ **已归档，请勿据本文件决策**。当前版本是 `2026-10-25-qq-memory-optimization-review.md`（v3）。本 v1 里的 O2「5 分钟、零风险、纯收益」结论已实测否决（工具结果最长仅 14,791 字符，>4,000 的只有 2 条，调阈值裁不到东西），O3 的「静默轮直接 mark_read」也忽略了 `preSleepWaitBlockedV2` 的代码级拦截。保留本文件仅为追溯推理过程。

版本：v1 · 2026-10-25
用途：**供不具备本机访问权限的审阅者阅读**。全部关键代码、数据结构、观测数据均已内联，阅读本文件即可完整判断，无需访问仓库或运行环境。
请重点看第 8 节「待决问题」——那里是真正需要外部意见的选择题。

---

## 0. 需要你审什么

| 项 | 说明 |
|---|---|
| 审阅对象 | 一个 QQ 群/私聊机器人的「对话记忆层」成本与质量优化方案 |
| 你的输入 | 本文档（自包含） |
| 你的输出 | ① 诊断是否成立（第 5 节）② 方案是否值得做、有无更优替代（第 6 节）③ 优先级与阈值是否合理 ④ 第 8 节选择题的明确意见 |
| 证据等级 | 第 4 节标注了「实测 / 推算 / 未知」。**未知项不要当成已知** |
| 数据局限 | 单用户、单机器人、2 天窗口、n=1；没有 A/B 对照。所有收益预测都是基于成本公式的外推 |

---

## 1. 系统是什么

### 1.1 拓扑

```
QQ 客户端
   │  （OneBot 协议）
   ▼
qq-bridge（Node 常驻进程，本项目）
   │  （把一个"会话 key"映射到一个 DSH session）
   ▼
DSH（DeepSeek Harness：agent 运行时 + 模型网关）
   │
   ▼
deepseek-flash（1,048,576 token 上下文窗口）
```

- **一个 QQ 会话（私聊或群）= 一个 DSH 会话**，映射存在 `state/sessions.json`：
  `{"sessions":{"private:<uid>":"session-<uuid>"}}`。
- 机器人自称"小鲸鱼"，人格由角色卡驱动；不聊天时"潜水"，由定时唤醒 + 触发条件（被 @、关键词、提问、随机概率）叫醒。
- AI 的文本输出**不会**自动发到 QQ，必须调用工具（`qq_send_message` 等）显式发送。这保证它可以"醒来看一眼再决定不说话"。

### 1.2 一轮对话的生命周期

```
消息到达
  → 触发唤醒（reason: message / proactive / timeout / replyCheck ...）
  → buildWakePromptV2() 组装一条提示词（第 2.6 节给出完整拼装顺序）
  → deliverPrompt() 送进 DSH 会话；DSH 把「系统提示词 + 该会话全部历史 + 本次输入」整块发给模型
  → 模型输出：① 调用工具（发消息 / 等待 / 查档案 ...）→ 回到上一步，这是"第 2 步"
              ② 结束本轮，设置下次唤醒条件
```

关键事实（整个方案的根源）：

> **DSH 不在服务端保存跨轮对话状态。每一"步"都是一次完整的 LLM 请求，输入 = 系统提示词 + 该会话截至目前的全部历史 + 本次新增。**

一次唤醒如果模型调用了 3 次工具，就是 3 次请求，每次都重放同样体积的历史。对话越长，每一步越贵。

### 1.3 会话生命周期（关键代码，`src/bridge.js:9372`）

```js
async function ensureSession(key) {
  const policy = sessionPolicy(key);
  if (!isSessionAllowedInCurrentMode(key)) throw new Error(...);
  const existing = state.sessions[key];
  if (existing) {
    if (!isCurrentSession(key, existing)) {
      retireSession(key);                       // 产物代际不匹配：丢弃
    } else {
      const applied = await ensureChatModel(existing);
      if (applied === 'not-found') retireSession(key);   // DSH 侧会话已不存在
      else return existing;                     // ★ 正常路径：永远复用同一个 session
    }
  }
  ... // 新建会话
}
```

`retireSession()` 只在四种情况被调用：用户 `/reset`、控制台"清上下文"、模式/权限变更、DSH 侧会话丢失。**没有任何按轮数/时间/体积的自动轮换。**

---

## 2. 记忆的五层 + 两条补历史腿

| 层 | 载体 | 目的 | 注入方式 | 实测状态 |
|---|---|---|---|---|
| **L0 会话原文** | DSH session（磁盘快照 `session.v4.jsonl.zstd`） | 具体对话连贯性 | 全量重放（无裁剪） | **85 轮 / 2555 条记录 / 2.6M 字符** |
| **L1 短记忆** | `state/social-v2.json` | 正在聊的话题、想说没说的话、对人的即时印象 | 拼进唤醒提示词的 `memoryLine` | **空**（85 轮 0 次写入） |
| **L2 长档案** | `state/profiles.json` | 长期人设/关系：具体事例 + 证据 + 时间衰减 | 拼进 `profileLine`（≤3 人 / ≤900 字） | **在用：1 人 52 条** |
| **L3 摘要投喂** | `social.pendingSummaries`（内存） | AI 潜水期间群里发生了什么 | 一次性 "silent turn" 灌进同一会话 | 今日 0 次 |
| **L4 跨会话语义记忆** | 独立向量索引（`memory-index/`，bge-small-zh + SQLite） | 回忆"以前某次会话" | 模型主动调用 `memory_search` 工具 | 4 次/85 轮 |
| 补腿 A 掉线补拉 | `src/catch-up.mjs` | 重连后补回错过的消息 | 最多 5 会话 × 50 条，10s 总预算 | 正常 |
| 补腿 B 唤醒前预取 | `src/wake-history.mjs` | 补上"醒来前"的最近对话 | 12 条 / ≤1600 字 / 2.5s 超时 | 正常 |
| 日记 | `state/diary/*.json` | 一天一页的自我叙事 | **不进提示词**，只影响行为摘要 | 1 页 |

### 2.1 L1 短记忆的衰减参数（`src/memory-decay.mjs:21`）

```js
export const DEFAULT_DECAY_CFG = Object.freeze({
  halfLifeDays: 7,       // 权重半衰期
  pendingFloor: 0.35,    // 待办类记忆的权重下限
  foldThreshold: 0.15,   // 低于此权重且同类 ≥3 条 → 折叠成一行
  foldMinCount: 3,
  maxChars: 1200,        // 注入总字符预算
  expiredGraceHours: 24
});
```

三类结构与上限：`activeTopics` ≤20 条且 24h 未再提即删；`pendingThoughts` 默认 2h 过期；`memberImpressions` ≤50 人。写入完全依赖模型主动调用 `qq_memory_append`。

### 2.2 L2 长档案的规则（`src/profiles.js:28`）

```js
export const PROFILE_DEFAULTS = Object.freeze({
  enabled: true,
  settleIdleMs: 6 * 60 * 1000,      // 安静 6 分钟才算"告一段落"
  sliceMaxMessages: 40,             // ★ 每次抽取最多看最近 40 条
  sliceMinMessages: 6,              // 少于 6 条不抽
  extractCooldownMs: 30 * 60 * 1000,// 同一会话两次抽取间隔
  extractPerHour: 20,
  maxPeople: 200,
  maxRecordsPerPerson: 80,
  maxTermsPerGroup: 120,
  halfLifeDays: 30,                 // 权重半衰期
  pruneWeight: 0.12,                // 低于此权重且超过 120 天 → 清理
  pruneAfterDays: 120,
  injectMaxPersons: 3,              // 注入 ≤3 人
  injectMaxChars: 900               // 注入总预算 900 字符
});
```

关键质量约束：只接受具体事例 —— 文本 6–160 字、必须带 ≤80 字 `evidence`、`looksLikeBareLabel()` 会拦掉"他很友善"这类空泛标签、`scrubSensitive()` 脱敏。抽取由**独立的"学习会话"**执行（工具集只含档案读写），不污染主对话。

### 2.3 L3 摘要投喂（`src/bridge.js:11439`）

AI 潜水/观望期间消息不丢弃，进 `pendingSummaries`（每会话 ≤60 条）。随后用一次 silent turn 灌进**同一个 DSH 会话**：

```
【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：
<若干行 sender：text>
【最近对话】
<最近 20 条>
你不需要回复，只需记住这些内容，后续聊天会更自然。
```

silent 名额 5 分钟未消费即作废（`SILENT_TURN_TIMEOUT_MS = 300000`）。这是"潜水也知道群里发生了什么"的唯一通路。

### 2.4 L4 跨会话检索

外部 MCP 服务 `memory-index/mcp-server.mjs`：把 **DSH 全部会话**（含工具调用记录）+ 项目文档 + 夜间摘要向量化（bge-small-zh-v1.5，512 维，SQLite + vectors.npy），检索 = 余弦相似度 + 关键词加分（每命中 +0.02，上限 +0.12）+ 同会话最多返回 2 条。模型侧工具名 `memory_search`。

### 2.5 上下文压缩能力（存在但从未生效）

预设 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 末尾，原文：

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'   # 参数未知（见 4.4）

    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'

    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 50000    # ★ 单条工具结果超 5 万字符才裁剪
        headChars: 45000
        tailChars: 2000
```

同时，`src/` 目录里 **没有任何代码主动触发压缩**（全仓 grep `compact` 只命中一个无关的"模型视野裁剪"函数），也没有 `/compact` 控制台入口。

### 2.6 唤醒提示词的拼装顺序（`src/bridge.js:12452`，原文一行）

```js
const base = roleLine + personaLine + fewshotLine + tokenLine + antiAiLine + proactiveLine
  + stickerLine + stickerNudgeLine + replyLine + statusLine + historyLine
  + (selfStatusLine ? `${selfStatusLine}\n\n` : '') + wakeLine + memoryLine + profileLine
  + participationLine + preSleepLine;
```

各段预算（实测/配置）：`personaLine` 每轮人格 1–2KB；`fewshotLine` 少样本 1–3KB；`historyLine` 预取历史 ≤1600 字符；`memoryLine` ≤1200 字符；`profileLine` ≤900 字符；`participationLine` 参与度摘要。**系统提示词的固定部分约 5–8K 字符**（≈4–6K tokens）。

---

## 3. 成本模型

### 3.1 计价（元 / 百万 token，非高峰；高峰时段（工作日 9:00–12:00、14:00–18:00）单价 ×2）

| 项 | deepseek-flash |
|---|---|
| 输入（缓存命中） | ¥0.02 |
| 输入（缓存未命中） | ¥1.00 |
| 输出 | ¥4.00 |

### 3.2 单步成本公式（这是全篇最重要的等式）

```
cost(step) = (cacheHit × 0.02 + cacheMiss × 1.00 + output × 4.00) / 1e6
input(step) = cacheHit + cacheMiss          // = 系统提示词 + 全部历史 + 新输入
```

含义：**每一步的输入都等于"整个上下文"。** 因此
```
cost(一轮) ≈ 该轮步数 × 上下文体积 × 命中单价
```
只要"消息工具 + 等待工具 + 收尾"是 3 步，一次对话的成本就是 3 份上下文。上下文翻倍，成本翻倍，**与聊天内容多少无关**。

### 3.3 实测：上下文已经很大

| 指标 | 值 |
|---|---|
| 当前主会话单步平均输入 | **264,274 tokens**（今日 155 次调用均值） |
| 上一代主会话（已退役）单步平均输入 | **402,908 tokens**（1227 次调用，累计 ¥17.39） |
| 当前会话历史长度 | 85 轮 / 2555 条记录 / 2.6M 字符 |
| 增长速率 | 第 1 轮 18K → 第 85 轮 314K，**≈3.5K tokens/轮** |
| 模型窗口 | 1,048,576 tokens |

推算（按 3.5K/轮、日均 ~42 轮）：从 314K 到 80% 窗口（840K）约需 **150 轮 ≈ 3–4 天**。届时 DSH 的内建压缩会介入，但其策略与阈值未知（见 4.4），因此无法预测届时成本与记忆保真度。

### 3.4 实测：静默轮是最贵的浪费

| 轮次区间 | 每轮步数 | 单步输入 | 输出 |
|---|---|---|---|
| turn 81–85（模型判定 `[SILENT]`，不说话） | **1** | **314,112 tokens** | **3–4 tokens** |

五轮静默合计消耗约 1.57M 输入 token，换回不到 20 个字符的输出（约 ¥0.031）。原因是：**"被叫醒 → 看一眼 → 判定不该说话"这个动作本身就要重放全部 314K 上下文。**

### 3.5 实测：步数是成本乘数

今日 289 次工具调用 / 85 轮（每轮步数中位 3，最长 25）：

| 工具 | 次数 | 说明 |
|---|---|---|
| `qq_wait_for_messages` | 99 | 累计结果文本 50,695 字符，最大消耗源 |
| `qq_send_message` | 96 | 必要 |
| `qq_mark_read` | 31 | |
| `qq_send_sticker` | 10 | |
| `qq_get_recent_messages` | 8 | |
| `qq_diary_write` | 8 | |
| `qq_get_unread_messages` | 6 | |
| **`qq_memory_append`** | **0** | 短记忆层从未被写入 |
| `qq_memory_query` / `qq_slang_query` | 1 / 1 | |
| `memory_search` | 4 | 跨会话检索，使用克制 |

极端案例：turn 77 一轮跑满 **18 步**，每步约 301K 输入 → 单轮约 **5.4M tokens**。

### 3.6 日花费与"守门"现状

| 日期 | 花费（元） |
|---|---|
| 10-16 … 10-18 | 1.22 / 0.64 / 0.49 |
| 10-19 … 10-22 | 3.59 / 2.05 / 3.46 / **4.97（峰）** |
| 10-23 … 10-25 | 2.43 / 0.64 / 1.01 |

累计 ¥20.51，其中已退役的旧主会话独占 ¥17.39（85%）。

已有一套成本守门（`src/cost-guard.mjs`），配置已启用：

```json
"costGuard": { "enabled": true, "cacheRateMin": 0.95, "dailyInputMax": 100000001, "topShareMin": 0.5 }
```

但它只有三个口径：**缓存命中率**、**单日输入总量**、**单会话占比**，且输出只是一行日报/告警文字。今日实测输入约 41M，距 150M 红线还有 3.7 倍 —— **它无法在上下文增长期给出任何早期信号**，也不做任何拦截。

---

## 4. 观测方法与证据等级

### 4.1 实测（可复现，代码与数据均在本机）

- 数据源 1：`state/token-usage.jsonl` —— 每步一行，样本：

  ```json
  {"k":"turn","t":1792936391072,"sid":"session-f3ade17a-...","key":"private:<uid>",
   "seq":2551,"turn":85,"step":1,"retry":0,"model":"deepseek-flash",
   "b":{"cacheMiss":179,"cacheHit":314112,"cacheWrite":0,"output":4,"reasoning":0}}
  ```

- 数据源 2：DSH 会话快照 —— 全量事件流（`user/message`、`assistant/message`、`tool/call`、`tool/result`、`agent/inbox/spliced`、`request/context`、`request/header`）。解压后 2555 条记录、85 轮。

  > 解压坑（供复现者参考）：该文件是 **1504 个连续 zstd 帧拼接**。Node 的 `zstdDecompressSync` 只解第一帧（得到 258 字节头），流式 `createZstdDecompress` 抛 `ZSTD_error_prefix_unknown`。正确做法是扫 magic `28 b5 2f fd` 得到各帧偏移，逐帧解压后拼接。

### 4.2 已知的统计口径陷阱（**重要**）

`state/token-usage.jsonl` 里除了 `k:"turn"` 的逐步明细，还有一批 `k:"base"` 的**累计值**行（103 条，其中一条 `cacheHit: 490,144,768`）。任何聚合都**必须** `filter(r => r.k === 'turn')`，否则数字虚高约 100 倍（实测：不过滤算出 ¥11.35，过滤后 ¥1.01）。另外存在 4 组重复行，需按 `sid|turn|step|retry` 去重。

### 4.3 推算（明确标注，不是实测）

| 结论 | 依据 |
|---|---|
| 成本与上下文体积成正比 | 计价表 + 单步输入实测 |
| 上下文约 3.5K tokens/轮增长 | 首末轮单步输入差 ÷ 轮数 |
| 轮换后单步 ≤40K | 各注入段预算之和（见 6.1 预期） |
| 日花费可降至 ¥0.3 以下 | 单步降幅 × 今日步数 |

### 4.4 未知（不要假设）

1. `@deepseek-ai/dsh-compaction-basic` 的**触发阈值与压缩策略**（是按比例、按条数，还是摘要重写？）。尝试从打包产物 `app.asar` 里读取其 schema 失败：asar header 超过 4MB，读出的 JSON 被截断（`Unterminated string in JSON at position 4194287`）。
2. `tool-result-pruner` 的具体裁剪语义（推测为"超阈值时保留头 headChars + 尾 tailChars，中间丢弃"，但未验证）。
3. 是否存在"缓存失效"惩罚：轮换会话后，前缀缓存必然重建，首轮全部按未命中计价（本方案已把这笔一次性的钱算进去）。
4. 单用户样本，无法区分"上下文大"与"机器人的聊天风格啰嗦"哪个对花费贡献更大。

---

## 5. 诊断（请逐条判断是否成立）

### Q1 · 上下文无上界，单步成本线性增长

- **现象**：单步输入 264K（当前）→ 403K（上一代会话）。会话一旦建立就永不轮换。
- **证据**：`ensureSession` 仅在 /reset、模式变更、DSH 侧丢失时退役（1.3）；2555 条记录里**没有任何 compaction 事件**。
- **代价**：¥20.51 中的 ¥17.39 花在"一个已经超大的会话"上。
- **根因**：系统把"记忆连续性"完全外包给了 L0 全量历史，而 L0 没有容量管理。

### Q2 · 静默轮为 4 个字符的决策支付 314K 输入

- **现象**：turn 81–85 每轮 1 步、输入 314,112、输出 3–4 token。
- **代价**：5 轮 ≈ ¥0.031；按日均比例外推，约占总花费的 3–5%（静默轮量大时更高）。
- **根因**：所有唤醒都走同一套"重放全部历史"的路径，没有"廉价前置判断"（第 8.6 节讨论是否可加）。

### Q3 · 步数被等待类工具放大

- **现象**：`wait` 99 次（占工具调用 34%）；单轮步数最长 25（turn 77 一轮 5.4M tokens）。
- **代价**：每多一步 = 多一份完整上下文请求。步数是纯乘法。
- **根因**：① 提示词强制"沉睡前必须做一次完整观察"，静默轮也要走；② `wait` 没有单轮次数上限；③ `wait` 返回全量列表（最长 50K 字符）而不是增量。

### Q4 · 剪枝器从未生效过一次

- **现象**：`thresholdChars: 50000`，而实测最长的工具结果 14,853 字符（`qq_get_prompt`），绝大多数 1–3K。
- **结论**：`tool-result-pruner` 自上线起**零次生效**；`compaction-basic` 因 1M 窗口同样未触发（日志无事件）。
- **根因**：阈值是按"长上下文模型"直觉配的，没有对照真实工具输出分布标定。

### Q5 · L1 短记忆层空转，但成本照付

- **现象**：`qq_memory_append` 85 轮 0 次；`activeTopics`、`memberImpressions` 实测为空。
- **代价**：① 4 个工具定义常驻提示词（schema 约 600–800 tokens/步）；② 衰减逻辑（`memory-decay.mjs`）每轮空跑；③ 提示词里仍在教模型"记得写短记忆"，而它从不写 —— 这部分指令是纯 token 噪音。
- **根因**：把"记忆写入"设计成模型的自律行为，而模型在被唤醒的有限步数里优先做别的事。

### Q6 · 现有守门管不到这个失效模式

- **现象**：`dailyInputMax: 150M`，今日 41M；三条口径里没有"单会话上下文水位"。
- **结论**：成本在 3–4 天内会翻倍（第 3.3 节推算），而守门要到 3.7 倍才报警，且不拦截。

---

## 6. 方案

排序原则：**省下的钱 ÷ (改动风险 × 工作量)**。每一项给出：动机、具体改动、参数依据、预期、风险与缓解、回滚、验收、工作量。

### O1 · 上下文守门 + 会话交接轮换（核心，收益最大）

**动机**：Q1 / Q2。把"历史长度"从无上界改成有上界，且切换时保留必要的连续性。

**改动**：

1. 新增纯函数模块 `src/context-budget.mjs`：

```js
// 输入 = 本会话最近若干步的 { cacheHit, cacheMiss }（数据已在 token-usage，零额外请求）
// 输出 = 水位与动作建议
export function evaluateContextBudget(steps, cfg) {
  const watermark = Math.max(...steps.map(s => s.cacheHit + s.cacheMiss));  // 最近一步 = 当前上下文
  const level = watermark >= cfg.hardAt ? 'hard'
              : watermark >= cfg.softAt ? 'soft' : 'ok';
  return { watermark, level, softAt: cfg.softAt, hardAt: cfg.hardAt };
}
// 默认 softAt = 60_000, hardAt = 120_000
```

2. 唤醒入口（`buildWakePromptV2` 之前）读水位：
   - `soft` → 日志一行 `[budget] 上下文 62K（soft）`，并在提示词尾部追加"本轮尽量少调用工具，能一次说完就不要分步"。**不动会话**。
   - `hard` → 置 `pendingHandoff = true`，**不立即换会话**，等安静期。

3. **交接轮换**（安静期 = 距最后一条群消息 ≥5 分钟 且 距上次交接 ≥6 小时）：

```
① 在当前会话里跑一次"不发送"的 turn，要求严格输出 JSON：
   {"topics":[...], "openLoops":[...], "peopleChange":[...], "mood":"..."}
   约束：≤400 字，只写"新会话接着聊必须知道的"
② 写入 state/handoff/{key}.json（保留最近 3 份）
③ retireSession(key)  →  下一次唤醒 ensureSession() 自动新建
④ buildWakePromptV2 增加 handoffLine（预算 600 tokens），插在 memoryLine 之后
```

**参数依据**：
- 60K soft：稳态注入量 = 系统提示词 ~6K + 窗口 20 条原文 ~4K + 预取历史 1600 字 + 短记忆 1200 字 + 档案 900 字 + 工具结果累积 ≈ 15–25K。取 2.5–4 倍余量。
- 120K hard：超过它，单步成本已是稳态的 5 倍以上，收益开始碾压切换成本。
- 交接 ≤400 字：新会话首轮就要用，太长变成新的负担。

**预期**：单步输入 264K → **≤40K**；今日等效花费 ¥1.01 → **约 ¥0.15–0.25**；静默轮 314K → 约 25K。

**风险与缓解**：

| 风险 | 缓解 |
|---|---|
| 交接丢细节，手感断裂 | 交接 JSON 只放"必须知道的"；原文层由 `wake-history`（12 条）+ L2 档案兜底；轮换后 24h 人工抽查 3 个切换点的连贯性 |
| 交接 turn 本身要一次全量请求 | 只在水位超 hard + 安静期 + 6h 冷却时触发，按当前增速约每 2–3 天一次 |
| 前缀缓存重建，首轮全额未命中 | 已计入预期（新会话首轮约 18K 未命中 ≈ ¥0.018，远小于每次换来的节省） |
| 轮换期间丢消息 | 交接在安静期执行，期间新消息进队列，新会话继承 unread |

**回滚**：`contextBudget.enabled: false` 一键关闭（水位只记日志、不交接）。

**验收**：轮换后新会话首轮 `cacheHit+cacheMiss < 60K`；7 天内日均花费 < ¥0.35；抽查对话无"你是谁/在聊什么"式断裂。

**工作量**：1–2 天（含 `scripts/test-context-budget.mjs` 离线单测）。

---

### O2 · 让剪枝器真正生效（5 分钟，零风险，建议先做）

**改动**（配置级）：

```yaml
tool-result-pruner:
  config:
    thresholdChars: 50000 → 4000
    headChars: 45000 → 3000
    tailChars: 2000 → 600
```

**依据**：工具结果字符分布 —— 50,695 累计（99 次 wait，均值 512）、单条最大 14,853。4000 字符足以保留一次等待的正文，超出部分模型本来也不读。

**性质**：只改"进模型视野的内容"，**不动磁盘存储、不影响补历史原文**。纯收益。

**验收**：连续 5 步的输入量相比同轮次基线下降 ≥3K。

---

### O3 · 等待步瘦身

**改动**（三处）：
1. `wait` 只在"本轮已发过言"时允许进入完整沉睡前观察；纯静默轮直接 `mark_read` 收尾。
2. 单轮 `wait` 调用封顶 2 次，超出返回明确错误（"本轮等待次数已达上限，请结束本轮"）。
3. `wait` 返回改为增量摘要：`本次新增 N 条` + 首尾各 2 条，不再回全量列表。

**预期**：每轮步数中位 3 → 2；总调用量 −20~30%；配合 O1，静默轮从 314K 降到 ~25K。

**风险**：封顶后可能"少听几句" → 仍可用 `qq_get_recent_messages` 主动拉取，不丢信息。

**验收**：7 天内单轮步数中位 ≤2；未出现"漏回消息"投诉（人工抽查 20 轮）。

---

### O4 · 短记忆要么自动化，要么删掉

**动机**：Q5。85 轮 0 次写入 = 该层当前是纯成本。

**方案 A（推荐）**：`activeTopics` 由 O1 的交接 turn 顺带产出（交接 JSON 的 `topics` 直接写入 `social-v2.json`），并**删除** `qq_memory_append/query/remove/list` 四个工具，保留 `qq_diary_*`；`memberImpressions` 并入 L2 档案（后者已有 30 天半衰期 + 证据要求 + 注入排序，不维护两套"对人的印象"）。

**方案 B**：桥接侧规则抽取 —— 投喂摘要时，从最近 30 条里取"被重复提及的名词 / 被 @ 的人"upsert `activeTopics`。模型不再写。

**取舍**：A 更省（少 4 个工具 schema + 一段提示词），但把"记忆写入"完全绑定在轮换上（若关闭 O1，L1 就没有写入者 → 接受，因为 L1 本来空转）。B 不依赖 O1，但规则抽取质量差。

**验收**：轮换后 `activeTopics` 非空且与最近话题相关；提示词 token 数下降。

---

### O5 · 档案抽取 backlog

**动机**：Q6 之外的记忆质量问题 —— `sliceMaxMessages: 40` 意味着抽取只看最近 40 条。聊得快时，中段内容会在被抽取之前滑出窗口，**永久丢失**。而 `extractCooldownMs: 30min` 在积压时反而拖慢。

**改动**：
1. 抽取输入从"最近 40 条"改为"**未抽取的 ≤200 条**"（按 `pendingMessages` 指针切片）；超 200 条时丢弃最旧并记日志。
2. 冷却自适应：`pending < 30` → 30 分钟；`pending ≥ 30` → 10 分钟。
3. 质量门槛不变（`looksLikeBareLabel` / `scrubSensitive` / 6–160 字 / 必须带 evidence）。

**风险**：单次抽取成本尖峰（200 条 vs 40 条，约 5 倍），但抽取走独立学习会话、频率低（今日 3 次），可接受。`extractPerHour: 20` 保持不动作为硬闸。

**验收**：`profiles.json` 条目增长率提升；积压时日志中抽取间隔缩短；抽查新条目有 evidence、非空泛标签。

---

### O6 · 摘要投喂可观测（2 小时）

**动机**：L3 是"潜水也知道发生了什么"的唯一通路，但今日日志里**一条相关记录都没有** —— 无法区分"今天没有群聊所以没触发"与"机制坏了"。

**改动**：加 3 个计数 + 3 条日志：入队（`[summary] 入队 n 条（待投喂 m 条）`）、投喂（`已投喂 k 条`）、作废（`silent 名额超时作废`）。

**验收**：群聊恢复后 24h 内能量出这三个数。

---

### O7 · 控制台补"上下文水位"一列（半天）

**改动**：「令牌与花费」页每行加一列 `上下文` = `b.cacheHit + b.cacheMiss`，按 O1 的 soft/hard 染色；并在"守门"里新增第 4 个口径 `contextWatermarkMax`（单会话水位阈值，默认 120K），与现有三条并列。

**必须注意**：聚合必须 `filter(k === 'turn')`（第 4.2 节），否则虚高 100 倍。

**验收**：控制台单步上下文与探针算出的一致；水位越线时出现告警行。

---

## 7. 落地顺序与总验收

| 批次 | 内容 | 工作量 | 预期 |
|---|---|---|---|
| 1 | O2 阈值 + O7 口径 | 半天 | 立刻见效，零风险 |
| 2 | O1 守门 + 交接轮换（含 O4-A） | 1–2 天 | 主体收益：单步 264K → ≤40K |
| 3 | O3 等待瘦身 + O5 档案 backlog | 1 天 | 步数 −20~30%，档案更完整 |
| 4 | O6 可观测 | 2 小时 | 可验证性 |

**总验收（批次 2 上线后 7 天）**：

- 单步平均输入 < 60,000 tokens（基线 264,274）
- 日花费 < ¥0.35（基线 ¥1.01）
- 静默轮单次输入 < 25,000 tokens（基线 314,112）
- 档案条目增长率 ≥ 现状，且每条带 evidence
- 人工抽查 20 轮：无"忘记刚才聊什么"式断裂

---

## 8. 明确不考虑的方案（及理由）

1. **用向量检索替代 L2 档案**。现有档案是"具体事例 + evidence + 30 天半衰期 + 按类取 1 条"，比 top-k 片段召回的质量更高、且无额外延迟。跨会话语义回忆已由 L4 覆盖。若引入检索，会同时丢掉"时间衰减"与"证据约束"。
2. **每天定时 `/reset`**。会丢掉正在进行的玩笑、表情包语境、未回应的消息 —— 手感崩坏，且用户可感知。必须用"安静期 + 交接"。
3. **缩短 `contextWindow`（现有 20 条原文）**。20 条是对话连续性的下限；该省的地方是"不该说的话"（O1/O3），不是"听懂对方"。

---

## 9. 待决问题（请给出明确意见）

1. **顺序**：是否应该先只做 O2 并观测 3 天（看单步是否止涨），再决定 O1 的紧急度？我的倾向：O1 仍要做 —— 因为 O2 救不了静默轮（314K 的主因是历史而非工具结果）。
2. **阈值**：60K / 120K 是否合理？是否应改成"相对窗口比例"（如 12% / 25%）以便换模型时不用调参？
3. **交接内容**：`{topics, openLoops, peopleChange, mood}` 四字段是否够？是否应额外保留"最近 3 个内部梗/玩笑"（这类内容最容易被判定为不影响任务、从而被丢弃，但最影响手感）？
4. **O4 取舍**：直接删 4 个 memory 工具（A）还是保留但改成自动化（B）？删工具会不会破坏既有用户/文档习惯？
5. **O1 的替代**：能否让 DSH 侧的 `compaction-basic` 承担这件事（把阈值调到 60K 之类），而不是在桥接层自建交接？**这是本方案最大的架构分歧点**。我的判断：桥接层更可控（能决定"什么时候"、能写交接摘要、能在轮换后立刻注入），但如果你能确认 `compaction-basic` 的语义与阈值可控，它更省事。当前无法读取其 schema（第 4.4 节）。
6. **静默轮能否不调模型**：是否引入"廉价前置判断"（规则或小模型）来决定"这轮值不值得唤醒主模型"？风险是判断错了漏聊。我的倾向：proactive 唤醒需要模型判断（要说啥得靠它想），但可以先用规则过滤明显不该醒的场景（如连续 N 次静默后降频）。
7. **O5 的 backlog 上限 200 条**是否过大（单次抽取成本 ≈5×40 条）？是否应改为"每次 40 条但不再限制只看最新 40 条"（即分片抽取，游标推进）？
8. **是否需要"预算感知的提示词"**：按剩余预算动态裁剪低价值段（如表情包推荐、少样本），而不是固定注入全部？这会增加提示词的不可预测性。

---

## 附录 A · 关键代码摘录

**A1 记忆注入的裁剪（`src/bridge.js:9980` `formatMemoryV2`，节选）**

```js
const topics = rankMemories(...);          // 按衰减权重排序
if (topics.length) { lines.push('【进行中的话题】'); for (const t of topics.slice(0,10)) { ... } }
// ...
// 总长上限：超限时从末尾逐条丢弃（保留较新的），并注明省略条数
while (lines.length && lines.join('\n').length + noteOf().length > maxChars) { ... }
```

**A2 摘要投喂（`src/bridge.js:11439`）** —— 见 2.3 节，完整字符串已内联。

**A3 成本守门（`src/cost-guard.mjs:22`）**

```js
export const COST_GUARD_DEFAULTS = Object.freeze({
  enabled: true,
  cacheRateMin: 0.95,      // 缓存命中率红线
  dailyInputMax: 40_000_000, // 单窗口输入 token 上限（本机配置已调高到 150M）
  topShareMin: 0.5,        // 最大会话占比低于此值不点名
});
```

## 附录 B · 数据结构样例

**B1 `state/sessions.json`**

```json
{"sessions":{"private:<uid>":"session-<uuid>"},
 "sessionPolicies":{"private:<uid>":"[\"reserved2\",\"qq-chat-v2\",null]"}}
```

**B2 L2 档案条目（字段形状；内容为合成示例）**

```json
{"kind":"event","text":"周五要去医院复查","evidence":"他说 周五还得去趟医院",
 "weightBase":0.9,"createdAt":1792919739267,"lastUsedAt":1792919739267}
```

**B3 `token-usage.jsonl` 两种行** —— 见 4.1 / 4.2。

## 附录 C · 指标定义

| 术语 | 定义 |
|---|---|
| **步（step）** | 一次 LLM 请求。一轮对话 = 1..k 步 |
| **上下文水位（watermark）** | 最近一步的 `cacheHit + cacheMiss`，等于"这次请求看到的全部 token" |
| **静默轮** | 模型判定 `[SILENT]`、不发送任何消息的唤醒轮 |
| **交接（handoff）** | 轮换会话前，让旧会话产出一段结构化摘要，供新会话首轮继承 |
| **silent turn** | 不发送、只用于"让模型记住"的注入轮 |

## 附录 D · 测算假设

| 假设 | 若假设不成立的后果 |
|---|---|
| 缓存命中单价 ¥0.02/M（非高峰） | 高峰时段成本 ×2，收益绝对值同比放大 |
| 上下文体积 ≈ 单步输入 | 若 DSH 另有裁剪，实测增长会更平缓 |
| 交接后稳态 ≤40K | 若提示词比预期大，需把 soft 阈值上调或裁剪少样本段落 |
| 日均 ~42 轮 | 活跃度上升会缩短"见顶"时间，但收益比例不变 |
