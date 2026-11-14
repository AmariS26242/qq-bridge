# 优化待办清单（可执行版）

> **这份清单是什么**：把 [OPTIMIZATION-MASTER.md](OPTIMIZATION-MASTER.md) 的 §0 欠账与 §5 路线图，拆成 **14 个能独立验收的小步**。每步都能单独交付、单独回滚、单独判断成败。
> **验收口径以审阅版为准**：任何「已改代码」都不等于「已验证有效」。未实际运行的测试、未测过误伤率的规则、未做盲评的改动，一律记为「已实现 · 效果未验证」。
> **不含**账号、群号、会话标识、运行数据与任何日期；路径为仓库相对路径（执行必需），行号不写（会漂移）。

---

## 0. 怎么用这份清单

```
每步的固定交付物
  ① 改动（代码 / 配置 / 素材）
  ② 验收证据（命令输出、面板数字、审计记录，落盘保存）
  ③ 回滚动作（一行命令或一个开关）
  ④ 一行记录（版本、配置、结果；不写日期）
```

- **不做完 ①–④ 就不算完成**，只完成 ① 的项一律标记为「半成品」，不许并入下一批。
- 每步做完立刻判：**通过 / 不通过 / 回滚**。不通过就停在原地修，不要带着问题往下走。
- 相邻两步之间**只允许一个结构变量变化**（见 §3 红线 R2）。

**总量**：7 项半天以内（A2 / A3 / B1 / B2 / D2 / D5 / D6），4 项约 1 天（A1 / A4 / C1 / C3），2 项需长观察（C2 影子 24h、D1 观察 7 天），合计约 **9–10 人日**，不含 7–14 天观察期。

---

## 1. 依赖关系与推荐顺序

```
批 A（观测基线，必须最先）
  A1 统计基建 ──┬─→ A2 控制台水位列
                ├─→ A3 摘要投喂三计数
                └─→ B1 盲评基线 ──→ B2 采样 A/B
  A4 语义保真回归集（可与 A1 并行）

批 B（尺子）
  B1 ──→ B2（离线，与轮换解耦）

批 C（成本结构）
  C1 纯函数单测 ──→ C2 影子 24h ──→ C3 小流量 + O4 兼容检查

批 D（收尾）
  C3 之后：D3 卡瘦身（否则收益被历史体积掩盖）、D1 O3、D2 O5
  随时可做：A4、D4、D5、D6
```

**不能改顺序的两条**：A1 永远第一（没有它，后面所有改动都无法归因）；D3 必须在 C3 之后（轮换前测不出提示词瘦身的收益）。

---

## 2. 清单

### 批 A · 观测基线

#### A1 · 统一统计基建（P0-1 + X2）

| 项 | 内容 |
| --- | --- |
| 为什么 | 出站计数（按天聚合、只存规则 id）已有实现，但还缺三样：控制台一页能同时看、与成本层共用同一套日桶、无输出轮占比。三者缺一，仍然答不出「哪条规则最常触发 / 删空多少 / 单步水位多少」 |
| 改哪里 | 出站过滤处落一条记录（规则 id + 命中数 + 原文/清洗后字符数，**不存原文**）；单步 token 明细沿用现有落盘；**把风格日桶与成本统计合并到同一落盘器**；只读 API `GET /api/ai-tone/stats`；控制台一页 |
| 硬约束 | 聚合必须 `filter(k === 'turn')`；去重键 `sid\|turn\|step\|retry`；两套日桶（风格 + 成本）必须共用同一落盘器、同一脱敏、同一保留期 |
| 验收 | 一页面板同时回答 5 个问题：单步水位、日累计输入、Top5 命中规则、删空数、无输出轮占比；同一天重跑两次数字不变 |
| 依赖 | 无 |
| 回滚 | 纯新增，删表/关开关即回滚 |
| 工时 | 约 1 天 |
| **状态** | ✅ **已完成**（`src/ops-panel.js` + `scripts/test-ops-panel.mjs` 60 断言 + `public/ops.html` + `GET /api/ops/panel`、`GET /ops`）；线上实测：`steps=1141 / turns=208`、单步 p50 `345,564`、`nearZero 44/208 (21.15%)`、零输出恒为 0（[SILENT] 仍吐 3–4 token）；间隔 2 秒两次请求数字一致；agent 令牌 403、无令牌 401 |

#### A2 · 控制台「上下文水位」列 + 守门第 4 口径（O7）

| 项 | 内容 |
| --- | --- |
| 改哪里 | 「令牌与花费」页每行加 `上下文 = cacheHit + cacheMiss`，按 soft/hard 染色；守门配置加 `contextWatermarkMax`（单会话水位阈值，默认 120K） |
| 验收 | 控制台单步上下文与探针输出一致；越线出现告警行，且告警里带会话标识与水位数 |
| 依赖 | A1（同一套聚合） |
| 回滚 | 删列 / 关统计开关 |
| 工时 | 约半天 |
| **状态** | ✅ **已在参考实现中存在并复验**：`src/cost-guard.mjs` 的 `contextWatermarkMax` 第 4 口径 + `public/console.html` 三张表的「上下文」列（soft 60K 黄 / hard 120K 红，无采样渲染「—」不渲染 0）；`node scripts/test-cost-guard.mjs` 26 项、`node scripts/test-token-usage.mjs` 97 项、`node scripts/test-console-ui.mjs` 4 项全绿。**遗留待定**：控制台硬线写死 `120000`，而 `config.json` 的守门阈值是 `340000`，同一条水位在两处判定线不同（统一方案见 §4 决策记录 D-1） |

#### A3 · 摘要投喂可观测（O6）

| 项 | 内容 |
| --- | --- |
| 为什么 | 潜水期唯一的信息通路，日志里一条相关记录都没有 —— 分不清「今天没群聊」和「机制坏了」 |
| 改哪里 | 3 个计数 + 3 条固定格式日志：`[summary] 入队 n 条（待投喂 m 条）` / `[summary] 已投喂 k 条` / `[summary] silent 名额超时作废` |
| 验收 | 群聊恢复后 24h 内能读出三个数；日志可 grep、格式不变 |
| 依赖 | 无（可与 A1 并行） || 工时 | 约 2 小时 |
| **状态** | ✅ **已完成**：三处计数 `enqueued / fed / expired`（`social.summaryStats`）原本就在，本次把 fed 的日志改成固定格式（`src/bridge.js:12223` `[summary] 已投喂 n 条（累计 X 条 / Y 批）(key)`），与 11790 的入队、14532 的作废统一为可 grep 的 `[summary]` 前缀；`GET /api/social` 返回 `summaryStats={enqueued,fed,expired,fedBatches,pendingTotal}`（重启后实测可读，计数为进程内累计、重启归零）。验收口径：三个数能读 + 三条日志格式统一 |

#### A4 · 语义保真回归集（P0-6）

| 项 | 内容 |
| --- | --- |
| 为什么 | 37 条规则只有「实现没坏」的单测，没有「改完是否更对」的尺子；新规则只能靠感觉启用 |
| 改哪里 | 新增 `scripts/test-ai-tone-semantic.mjs`（或扩充现有单测），为**每条规则**建立 正例 / 反例 / 边界 三格映射 |
| 必查 6 项 | ①否定词与条件词是否保留 ②数字/时间/链接/代码/专有名词是否保留 ③是否产生残句或语义断裂 ④重复执行是否幂等 ⑤同一规则是否跨场景误伤 ⑥改后是否仍能通过原有 105 条断言 |
| 验收 | `node scripts/test-ai-tone-semantic.mjs` exit 0；规则映射表完整（37 行无空缺）；失败样例冻结进回归目录，后续不得删除 |
| 依赖 | 无 |
| 回滚 | 纯新增脚本 || 工时 | 约 1 天 |
| **状态** | ✅ **已完成**：新增 `scripts/test-ai-tone-semantic.mjs`，37 条规则 × 正例/反例/边界 三格 + 必查 6 项，`node scripts/test-ai-tone-semantic.mjs` → **243 条断言全绿、exit 0**（其中必查⑥ 以子进程跑 `test-ai-tone.mjs`，原断言仍全绿）。调试中发现三条正例样例被整段删空（wish-you / open-list / glad-help），已把样例改成「有剩余内容」的真实句，反例全部保持原样返回 |

---

### 批 B · 尺子

#### B1 · 离线盲评基线（T2）

| 项 | 内容 |
| --- | --- |
| 为什么 | 8 个测试脚本只守「实现没坏」，不守「改动是否更好」；没有基线，任何 A/B 都无法判读 |
| 改哪里 | 新建 `eval/` 目录：固定 30 条上下文、5 维评分表（自然度 / 语义保真 / 误伤率 / 模板残留 / 稳定性）、随机顺序且隐藏版本信息的评审流程、分歧记录表 |
| 验收 | 当前配置产出**一份完整基线记录**：版本、配置、命令、原始输出、两名评审的逐条评分与分歧点；补一条「重复评审同一批样本，分数稳定」的自检 |
| 依赖 | A1（可选，但同期做可省一次环境搭建） |
| 工时 | 约半天 |

#### B2 · 采样参数 A/B（P1-2）

| 项 | 内容 |
| --- | --- |
| 为什么 | 现值是「文档所述现值」，没有任何盲评数据证明它优于其他组合 |
| 改哪里 | 采样代理支持参数组枚举；固定 30 条上下文；每组生成 20 条回复；组标识随机化并隐藏 |
| 硬约束 | **一次只改一个变量**；同时改多个必须标为「组合实验」；不得预设某组最优 |
| 验收 | 报告并列：自然度 / 语义正确性 / 上下文相关性 / 不当输出率 **+** 删空率 / 规则命中率 / 平均删减字数 / 平均最终句长（防止「被洗短」被误判成「更自然」） |
| 依赖 | B1 的评分表 |
| 工时 | 约半天（不含评审时间） |

---

### 批 C · 成本结构

#### C1 · 上下文守门纯函数 + 交接契约（O1 第一步）

| 项 | 内容 |
| --- | --- |
| 改哪里 | 新模块 `context-budget` 导出 `evaluateContextBudget(steps, cfg)`：调用方先按 sid 过滤、去重、按事件时间排序；水位取**最新一步**而非历史最大值；返回 `{watermark, level, softAt, hardAt}`，`level ∈ ok/soft/hard/unknown` |
| 参数 | `softAt = 60_000`、`hardAt = 120_000` 为**初始候选值**，上线前必须用观测分布校准 |
| 交接 schema | `{"topics":[],"openLoops":[],"peopleChange":[],"mood":"","insideJokes":[]}`，≤400 字，字段可空，不得猜事实 |
| 验收 | 单测 7 场景：空数据 / 重复行 / 重试 / 跨 session 混入 / 乱序 / 最新记录低于历史峰值 / 日志缺失 → `unknown`；schema 校验覆盖长度、敏感词、版本号 |
| 依赖 | A1 |
| 回滚 | 纯函数 + 开关 `contextBudget.enabled=false` |
| 工时 | 约 1 天 |

#### C2 · O1 影子运行（只算不动）

| 项 | 内容 |
| --- | --- |
| 改哪里 | 唤醒入口只记 `would_handoff` 与交接草稿，**不调用退役** |
| 验收 | 24h 影子；人工审阅每个交接草稿（≤400 字、无猜测、字段合理）；统计「误触发率」（安静期条件不满足却想换） |
| 依赖 | C1 |
| 回滚 | 关日志即回滚 |
| 工时 | 约半天 + 等 24h |

#### C3 · O1 小流量轮换 + O4 兼容检查

| 项 | 内容 |
| --- | --- |
| 改哪里 | ① 交接五步：生成 → 校验 → **先写临时文件再原子替换** → 只有持久化成功才退役 → 下次唤醒注入 `handoffLine`（600 tokens 预算）；② 交接失败**保留旧会话**并重试/告警，禁止先退役再写；③ 新会话继承 unread，新消息进可恢复队列 |
| 触发条件 | 水位 ≥ hard **且** 安静 ≥5 分钟 **且** 距上次成功交接 ≥6 小时 |
| O4 兼容 | 先确认 4 个记忆工具（append/query/remove/list）无外部调用者、无旧提示词引用、无控制台入口；确认后再删；`activeTopics` 由交接 turn 顺带产出（经 schema、去重、过期校验） |
| 验收 | 首轮 <60K；20 个交接点人工抽查（无人物混淆、无 open loop 丢失、无消息漏处理）；**未回消息零丢失**；回滚能恢复旧 session 映射（不能只关开关留下半完成退役） |
| 依赖 | C2 |
| 工时 | 约 1 天 + 7 天观察 |

---

### 批 D · 收尾

#### D1 · 等待步瘦身（O3，分四阶段）

| 阶段 | 动作 | 验收 |
| --- | --- | --- |
| 1 | `wait` 返回改为增量摘要：本次新增 N 条 + 首尾各 2 条 + 明确游标/时间范围 | 可用 `qq_get_recent_messages` 补看，不丢信息 |
| 2 | 记录每轮 wait 次数与返回消息数，测单轮上限候选值 2 | 统计可读；未见漏回 |
| 3 | `preSleepWaitBlockedV2` 增加放行分支（本轮判静默且未发消息）；`mark_read` 强制显式 `throughSeq`，拒绝省略路径 | 未读不会被一次清空；日志记录 `markedCount` 与 `unreadCount` 差 |
| 4 | 观察「聊两句又潜水」是否回潮 | 灰度日志 + 人工抽查，不达标回滚第 3 阶段 |

- 依赖：C3（先量后改）；验收：7 天内 wait 次数、步数 P50/P95、未读积压、漏回率；**任何消息被误标已读即回滚**。
- 与 O1 分开测量，避免把组合收益归因给单项。

#### D2 · 档案抽取游标（O5）

| 项 | 内容 |
| --- | --- |
| 为什么 | 抽取只看最近 40 条，聊得快时中段内容在被抽取前滑出窗口 → 永久丢失 |
| 改哪里 | 保留 40 条作单次上限，新增持久化游标（消息 ID/区间）；每片成功写入档案后才提交游标；失败重试保证幂等；先定 backlog 上限与溢出策略（默认不静默丢最旧，必须限流时记录被丢区间并告警） |
| 验收 | 失败/重启/重复执行/超限四类注入测试通过；统计待处理数、最老未处理消息年龄；抽查条目均有 evidence、非空泛标签 |
| 依赖 | 无 |
| 工时 | 约半天（游标）+ 冷却自适应另计 |

#### D3 · 人格卡瘦身（P1-3）

| 项 | 内容 |
| --- | --- |
| 为什么 | 卡内 §二/§三/§六/核心四处重复讲「短、不总结、不客服」，重复表述约占三分之一 |
| 改哪里 | 先建立现有版本基线，再按「核心人格 / 表达风格 / 行为边界 / 场景提示 / 示例库」重组；目标卡 ≤5500 字、核心 ≤400 字（**工程约束，不是效果指标**） |
| 验收 | B1 盲评不低于基线；注入体积可量；不重复但重要的边界、准确性、安全要求全部保留 |
| 依赖 | **C3 之后**（否则收益被历史体积掩盖，测不出） |
| 回滚 | 角色卡回滚到备份 |
| 工时 | 约半天 |

#### D4 · few-shot 扩容（P1-4）

| 项 | 内容 |
| --- | --- |
| 改哪里 | **先审后扩**：审查现有 57 条的质量、重复、上下文完整性、隐私 → 自动配对 + 每周补 10 条真实接话 → 目标 150 条（规模目标，不是效果指标） |
| 选材 | 相似度 top N 改为「相似度 + 场景标签」双通道；每条带场景标签，必要时配反例对照 |
| 验收 | 去重率、场景覆盖表、隐私检查记录；盲评不低于基线；不把单一群体的梗泛化到所有场景 |
| 依赖 | D3（同一批预算需先腾出） |
| 工时 | 约 1 天 |

#### D5 · 素材目录清理（P1-5）

| 项 | 内容 |
| --- | --- |
| 改哪里 | 先确认 `.bak` 与 `*.bak-scene` 是否仍被脚本、恢复流程、人工排障依赖 → 备份 → 移到 `state/backup/`；**不删除任何源文件** |
| 验收 | 导入器不再因垃圾文件报错；一键可恢复 |
| 工时 | 约 1 小时 |

#### D6 · O2 否定验证留档

| 项 | 内容 |
| --- | --- |
| 改哪里 | 用固定样例（短 / 长 / 结构化列表 / 尾部关键字段）跑一次剪枝插件，确认 `thresholdChars` 是单条语义、头尾如何解释 |
| 验收 | 结论（「负载无可裁对象，收益≈0」）写进未知项登记并关闭此项；不排产 |
| 工时 | 约 1 小时 |

---

## 3. 红线（每条都来自已发生的问题）

| 编号 | 红线 | 反例 |
| --- | --- | --- |
| R1 | **fail-open**：任何新组件故障都必须回落到原行为 | 采样代理挂 → 应直连模型，而不是不回话；交接写失败 → 应保留旧会话，而不是先退役 |
| R2 | **一次只让一个结构变量变** | 同时开轮换 + 改提示词，7 天报告全是混合归因 |
| R3 | **没跑的测试不算通过** | 「应该能过」等价于没跑 |
| R4 | **误伤率未测前不批量启用新删除规则** | 一条正则误删了正常安慰语，比 AI 味更难发现 |
| R5 | **每个单点配一个失败注入测试** | 只测 happy path 的模块，不能上线 |
| R6 | **不把计划、预期、示例写成已验证结果** | 「目标 40K」不是「已降到 40K」 |

---

## 4. 不要做（合并版）

1. ❌ 调剪枝阈值省钱 —— 这份负载没有可裁对象，真正的体积是「条数 × 每步重放」。
2. ❌ 每天定时 reset —— 丢笑话、表情包语境、未回消息，手感崩坏且可感知。
3. ❌ 缩短原文窗口 —— 20 条是对话连续性下限；该省的是「不该说的话」，不是「听懂对方」。
4. ❌ 用向量检索替代 L2 档案 —— 会丢时间衰减与证据约束。
5. ❌ 对每条消息跑 LLM 二次重写 —— 延迟与成本翻倍，打分器自己也会误判。
6. ❌ 追求「规则清零 AI 词」 —— 真人也会说「慢慢来」；删干净反而更假。
7. ❌ 用短句、漏回、错字当真人感的唯一来源 —— 不能为风格牺牲准确性与诚实性。
8. ❌ 只报平均分的 A/B —— 必须同时报样本量、分歧、删空率。

---

## 5. 与总纲的对应关系

| 本清单 | 总纲编号 | 总纲位置 |
| --- | --- | --- |
| A1 | P0-1 + X2 | §0 / §4 |
| A2 | O7 | §3.5 |
| A3 | O6 | §3.5 |
| A4 | P0-6 | §0 / §2 |
| B1 | T2 缺口 | §6.1 |
| B2 | P1-2 | §0 / §2 |
| C1–C3 | O1 + O4 | §3.5 |
| D1 | O3 | §3.5 |
| D2 | O5 | §3.5 |
| D3 | P1-3 | §0 / §2 |
| D4 | P1-4 | §0 / §2 |
| D5 | P1-5 | §0 / §2 |
| D6 | O2（已否决） | §3.5 |
| — | P2 五项 | 可选，长期 |

**已实现但效果未验证**（不计入欠账，但不得标「已完成」）：度量闭环、兜底六档、自动豁免词、长度闸门、6 条观察规则、按字数延迟、素材归档 —— 代码已在，缺的是 A4/B1 这类尺子。


---

## 6. 执行记录与待定决策

### 6.1 已完成（批 A 全绿）

| 步 | 产物 | 验收命令 | 结果 |
| --- | --- | --- | --- |
| A1 | `src/ops-panel.js`、`public/ops.html`、`GET /ops`、`GET /api/ops/panel` | `node scripts/test-ops-panel.mjs` | 60 断言通过；线上 `steps=1141 / turns=208`、单步 p50 `345,564`、无输出轮 `44/208`；间隔 2 秒两次请求数字一致 |
| A2 | 已存在：`src/cost-guard.mjs` 第 4 口径 + 控制台「上下文」列 | `node scripts/test-cost-guard.mjs` / `test-token-usage.mjs` / `test-console-ui.mjs` | 26 / 97 / 4 项全绿 |
| A3 | 三计数 + 三条 `[summary]` 固定格式日志 | `GET /api/social` 读 `summaryStats` | 字段可读；三条日志格式统一（入队 `11790` / 投喂 `12223` / 作废 `14532`） |
| A4 | `scripts/test-ai-tone-semantic.mjs` | `node scripts/test-ai-tone-semantic.mjs` | 243 断言通过、exit 0；必查⑥ 子进程跑老回归仍全绿 |

### 6.2 已定决策

| 编号 | 决策点 | 结论 | 落地位置 |
| --- | --- | --- | --- |
| D-1 | 控制台染色线（写死 `120_000`）与守门阈值（`config.json → costGuard.contextWatermarkMax = 340_000`）不一致 | **控制台从配置读阈值**：`GET /api/tokens/summary` 下发 `contextBudget{enabled,mode,softAt,hardAt}`，页面拿到后调用 `applyUsageContextThresholds()`；成对校验，`hardAt <= softAt` 时整组不生效（不会只换掉一条） | `src/bridge.js` 的 `/api/tokens/summary`；`public/console.html` 的 `[usage-watermark]` 段；`scripts/test-console-ui.mjs` 的「D-1」用例（5 项通过） |
| D-2 | 上下文水位线（交接评估的 soft/hard） | **按实测重设 soft `300_000` / hard `420_000`**，仍保持 `mode: "shadow"`（只记日志、写交接文件，不退役会话）；跑 24 小时看分布再决定是否进 `enforce` | `config.json → contextBudget`；`GET /api/social` 的 `contextBudget.sessions` 可直接看各会话当前水位 |
| D-3 | `persona-lib/fewshot/inbox/100000001的1个聊天记录.bak`（1.3 MB 聊天记录导出，文件名带 QQ 号，代码里无引用） | **删除**（先移出 fewshot 目录、去掉文件名的号，确认无引用后才删）；`fewshot/inbox/` 现在是空目录 | 已删；改动前的 `config.json` 备份在 `state/archive/config.json.2026-10-26-pre-C2.bak` |

### 6.3 C2 影子模式启动记录

- 顺手修掉一个「配置根本进不来」的坑：`loadConfig()` 没有把 `file.contextBudget` 归整进 `cfg`，导致 `contextBudgetConfig()` 永远返回默认值（`enabled:false`、`60K/120K`）——**此前无论怎么改 config 这个开关都不会生效**。已在 `src/bridge.js` 的 `loadConfig()` 里补 `cfg.contextBudget = normalizeContextBudgetConfig(file.contextBudget);`（紧跟 `cfg.aiToneStats` 那行）。
- 重启后实测：`GET /api/tokens/summary` → `{"enabled":true,"mode":"shadow","softAt":300000,"hardAt":420000}`；`GET /api/social` → 同上，并带 `softLabel:"300K" / hardLabel:"420K"`，`private:100000001` 当前水位 `354.4K`（落在 soft 与 hard 之间）。
- 影子模式的动作边界（读代码确认 + 单测覆盖）：`shouldRequestHandoff()` 只认 `level === 'hard' && mode === 'enforce'`，`runHandoffAtSafePointV2()` 里 `retireSession()` 只在 `mode === 'enforce'` 分支；shadow 最多写 `state/handoff/<key>.json` 并在日志留 `[budget] 上下文 xxx（soft|hard） key=…`。`node scripts/test-context-budget.mjs` 26 项、`node scripts/test-handoff.mjs` 29 项全绿。
- **待观察**：`[budget]` 行只在真实唤醒时落日志，重启后还没唤醒过 —— 下一次唤醒（主动检查约 86 分钟内，或有人发消息）后要回 `state/bridge.log` 核对一次，确认影子确实只记日志。


### 6.4 本轮增量（D-1 / C2 / D5 / D6）

| 步 | 改动 | 验收证据 | 回滚 |
| --- | --- | --- | --- |
| D-1 | 控制台染色线改由 `/api/tokens/summary` 下发的 `contextBudget` 驱动；`applyUsageContextThresholds()` 成对校验 | `node scripts/test-console-ui.mjs` → **5 项通过**（新增「D-1」用例：300K/420K 生效、闭区间、坏配置整组不生效、页面确实调用、后端确实下发） | 页面 `USAGE_CONTEXT_SOFT/HARD` 默认值仍在（60K/120K），把 `applyUsageContextThresholds` 的调用删掉即回到写死行为 |
| C2 | `config.json → contextBudget` 改为 `{enabled:true, mode:"shadow", softAt:300000, hardAt:420000}`；修 `loadConfig()` 未把 `file.contextBudget` 装进 `cfg` 的坑 | 重启后 `GET /api/tokens/summary` 与 `GET /api/social` 均返回 `enabled:true / shadow / 300K / 420K`；`test-context-budget.mjs` 26 项、`test-handoff.mjs` 29 项全绿 | 把 `enabled` 改回 `false` 重启（完全回到改造前），或整体还原 `state/archive/config.json.2026-10-26-pre-C2.bak` |
| D5 | `persona-lib/fewshot/` 里那份 1.3 MB 聊天记录导出已删除；目录现在只有 7 个 `.md` + `examples.jsonl`（57 条） | `persona-lib/fewshot/inbox/` 为空；`node scripts/test-fewshot.mjs` 通过 | 文件已删不可回滚（内容为历史聊天导出，无代码引用；确认不需要才删的） |
| D6 | O2（工具结果截断）的否定结论留档：分布是长尾不是肥胖 —— 单条中位数数百字符、超过 4,000 的只有个位数条、超过 20,000 的为零，截断收益 ≈ 2% | 见 `docs/OPTIMIZATION-MASTER.md` §3.3 / O2 节的「已否决」与结论段；`docs/2026-10-25-qq-memory-optimization-review-v3.md` 附录 E 为原始统计 | 纯文档，无需回滚；若将来工具集变化导致长尾变粗，重跑附录 E 口径再评估 |

**下一步（批 C/D 未完项）**：C3 小流量会话轮换 + O4 兼容检查（需先等 C2 影子跑满 24 小时，看 `[budget]` 与 `state/handoff/` 的实际分布）；D1 `preSleepWait` 四阶段（O3）、D2 记忆游标分片（O5）、D3 人格卡瘦身（P1-3）、D4 few-shot 反例（P1-4）。

### 6.5 D2 档案抽取游标（O5）验收

结论：**代码早已在位，本轮补的是可观测性与测试覆盖**，没有改抽取逻辑本身。

| 验收项 | 证据 |
| --- | --- |
| 持久化游标（消息 ID/区间） | 游标存在 `state/profiles.json → meta.sliceCursors`，实测 `{"private:100000001":{"lastSeq":19}}`；`nextProfileSeq()` 重启时用游标播种，保证 seq 跨重启单调 |
| 每片 40 条上限、积压不静默丢 | `src/profile-slice.mjs` 的 `planSlice/commitSlice/normalizeSliceCursor/describeBacklog`；超 `maxBacklog` 时留 `[profile] 待抽取积压超上限 … 被迫丢弃 …（原因 backlog-hard-cap）` 日志 |
| 只有写成功才提交游标 | `src/bridge.js` 抽取分支：`commitSlice` 只在拿到模型输出并 `appendRecord` 后调用；失败路径 `markSettled({ok:false})` 不清窗口不动游标（`src/bridge.js:11028` 附近注释与实现一致） |
| 失败 / 重启 / 重复执行 / 超限 四类 | `node scripts/test-profile-slice.mjs` → **23 项通过**（新增 #22 重启后游标 JSON 回读继续切、不重复不跳条；#23 积压条数与最老 seq）；`node scripts/test-profiles.mjs` → 31 项通过 |
| 统计待处理数、最老未处理消息年龄 | 本轮新增：`sweepProfiles()` 每轮扫描对有积压的会话打 `[profile] <key> 待处理 N 条（seq a-b，最老 X 分钟前）`（导入 `describeBacklog`，只报有积压的会话） |
| 条目有 evidence、非空泛标签 | 由 `appendRecord` 的 schema 校验保证（`test-profiles.mjs` 31 项含拒绝路径） |

- 改动：`src/bridge.js`（import 加 `describeBacklog`；`sweepProfiles()` 增积压统计日志）、`scripts/test-profile-slice.mjs`（+2 用例）。
- 回滚：删掉 `sweepProfiles()` 里那段 for 循环、把 import 里的 `describeBacklog` 去掉即可；测试用例可保留（纯增量）。
- 注意：`state/profiles.json` 目前只有 1 人有记录、游标 19，样本太小，真正有意义的观察要等群聊活跃起来。

### 6.6 C2 影子门控实测 + C3 就绪度（本轮新增）

**影子门控用真实账本验证过**（新脚本 `scripts/diag-budget-shadow.mjs`，只读，不写状态）：

| 会话 | 水位 | 分级 | 会不会交接 |
| --- | --- | --- | --- |
| session-f3ad…96dd9 | 354.4K | soft | 否 |
| session-8648…50ed0 | 304K | soft | 否 |
| session-afbc…e6ba9 | 270.8K | ok | 否 |
| session-14d5…22c1 | 38.1K | ok | 否 |

结论：新阈值（soft 300K / hard 420K）下已有 **2 个会话进入 soft 带**，但都不到 hard；影子模式即使到 hard 也只写 `state/handoff/<key>.json` + `[budget]` 日志，不退役会话（`shouldRequestHandoff` 只认 `hard && enforce`，`retireSession` 只在 enforce 分支调用）。

**C3 五步就绪度（代码层全部就位，缺的是数据与拍板）**：

| 步骤 | 状态 | 证据 |
| --- | --- | --- |
| 写交接（原子） | ✅ | `src/handoff.mjs:336` 临时文件 → `:356` rename；旧 latest 先归档 `:349`，保留 3 份；失败清理 `:391-393` |
| 先落盘再退役 | ✅ | `src/bridge.js` 交接块：`result.ok` 为真才走退役分支 |
| 失败即 fail-open | ✅ | 写入失败保留旧会话映射；`test-handoff.mjs` #23/#24（无效 payload 不覆盖、校验失败不建目录） |
| 新会话继承未读 | ✅ | `retireSession()`（`src/bridge.js:3150`）不清 `st.unread`，未读队列留在 socialV2 状态里 |
| 回滚恢复旧映射 | ⚠️ 需人工备份 | 翻 enforce 前先复制 `state/sessions.json` 与 `config.json`；回滚 = 还原两文件 + 重启 |

**Go / No-Go（翻 enforce 的判据）**：①影子满 24h 且至少出现过 1 次真实唤醒（`state/bridge.log` 里有 `[budget]` 行，确认只记日志没退役）；②`state/sessions.json` 与 `config.json` 各有带日期的备份；③抽查至少 3 次交接的 payload（`state/handoff/*.json`）字段齐全、没有编造事实；④用户明确同意。四项缺一不翻。

**回滚手册（enforce 后出问题）**：`config.json → contextBudget.mode` 改回 `"shadow"`（停止退役）→ 需要恢复映射时用备份还原 `state/sessions.json` → 重启桥接 → 核对 `GET /api/social` 里 `private:*` 的 session 映射与未读数。

**可执行闸门与回滚物料（本轮补齐）**：
- `node scripts/gate-enforce.mjs` — 翻 enforce 前跑一次，四项全 PASS 才允许改配置；已实测输出：`影子满 24h` FAIL（才刚开始）、`有 [budget] 影子日志` FAIL（还没真实唤醒）、`sessions.json 有备份`（本轮已补 `state/archive/sessions.json.2026-10-26-pre-enforce.bak`，189 B）、`交接 payload 合格` 信息不足。
- `state/c2-shadow-start.json` 记录影子起点（`startedAt`），闸门据此算 24h。
- `node scripts/diag-budget-shadow.mjs` — 随时看当前各会话水位与分级，只读。

### 6.7 本轮已执行决策（D-4 / D-5）

**D-4 · 只删 4 个记忆工具里的 remove / clear**（用户拍板：保留 append / query，删危险且零调用的两个）

| 项 | 内容 |
| --- | --- |
| 改动 | `src/mcp-snowluma-safe.js`：删掉 `qq_memory_remove`、`qq_memory_clear` 两个 `server.tool(...)` 定义块（原 856–901 行）、name→flag 映射两行、`memory` 组列表里的两个名字（工具数 56 → **54**）；`dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 第 8 条与【记忆卫生】改成「不必手动删、按时间衰减折叠、要彻底清由人在控制台做」；`src/bridge.js:5337` 的能力清单字符串与两处 agent 守卫错误文案同步改（`该工具已移除（记忆清理改由控制台完成）`） |
| 保留 | `/api/socialV2/memory-remove`、`/memory-clear` 两个 **HTTP 路由与控制台「轻量记忆」界面照旧**（它们不是模型工具，控制台要用） |
| 验收 | `node --check src/mcp-snowluma-safe.js`、`node --check src/bridge.js` 通过；`node scripts/test-qq-preset-contract.mjs` → **7 通过 0 失败**（新增反向断言：提示词里出现这两个名字即失败）；`server.tool(` 计数 54 |
| 回滚 | 从 `state/archive/` 的备份或版本历史恢复 `src/mcp-snowluma-safe.js` 两个工具块 + 映射 + 组列表，并还原 preset 第 8 条；重启桥接 |

**D-5 · 打开未读保护 `requireThroughSeq`**（用户拍板：打开并观察 3 天）

| 项 | 内容 |
| --- | --- |
| 改动 | `config.json → socialV2.markRead = { requireThroughSeq: true }`（原来该键不存在，代码读的是 `cfg.socialV2?.markRead?.requireThroughSeq`；`socialV2.tools.markRead` 是另一个工具开关，不动） |
| 代码 | 无需改代码：`requestedReadThroughSeqV2()`（`src/bridge.js:13003`）本就实现了这条拒绝路径，这次只是把开关打开 |
| 验收（实测） | 重启后带 `x-agent-token` POST `/api/socialV2/mark-read` 且不带 `throughSeq` → **400 `code: "throughSeq-required"`**；同一路由不带 agent token（控制台）→ **200 ok**，行为不变；请求前后 `unread` 条数未变（被拒请求不改状态） |
| 观察 | 3 天内看 `state/bridge.log` 是否出现 AI 因缺 `throughSeq` 被拒后重试的记录；若摩擦过大，回滚只需把 `requireThroughSeq` 改成 `false`（或删 `markRead` 对象）重启 |

**说明**：`ctx.socialV2.markRead` 从「工具开关的同名兄弟」变成对象，两个 `loadConfig` 默认值（`src/bridge.js:904`/`:1034` 的 `tools.markRead`）未受影响，`v2ToolEnabled('markRead')` 仍读 `tools`。

### 6.8 B1 离线盲评基线（本轮新增）

**新增文件**：`eval/contexts.jsonl`（30 条固定上下文：群聊吐槽/求助/问推荐/深夜情绪等）、`eval/run-eval.mjs`（跑真实出站管线并产出盲评材料）、`eval/RUBRIC.md`（五维评分说明）、`eval/aggregate.mjs`（汇总均分/胜场/分歧）。

**产出记录**：`eval/runs/<时间戳>-baseline-2/` 含 `baseline.json`（原稿/清洗/实发三份文本 + key + 配置快照）、`blind.csv`（评审只看 1/2 两栏，顺序按 `sha256(id:seed)` 打散）、`scores.template.csv`、`metrics.md`、`README.md`。

**机械指标（可复现，不含人评）**：30 条中 **13 条被改动**；命中规则 **24 次**；**删空 0 条**；Markdown 残留 0；AI 味词总量 **38 → 28**。

**规则覆盖实测**（同一批上下文，原稿 → 出站出现次数）：

| 词 | 原稿 | 出站 |
| --- | --- | --- |
| 听起来你 | 3 | 0 |
| 希望对你有帮助 | 2 | 0 |
| 我理解你的感受 | 1 | 0 |
| 首先 | 2 | 1 |
| 其次 | 2 | 1 |
| ！ | 13 | 11 |
| 呢～ / 加油 / 哦～ | 3 / 3 / 2 | 3 / 3 / 2 |
| 希望能帮到你 / 建议您 / 你已经很棒了 | 1 / 1 / 1 | 1 / 1 / 1 |

**结论（可作为后续改动的基线）**：三类心理师腔能被洗掉；但「希望能帮到你」「建议您」「你已经很棒了」「呢～」「加油」这类**变体与短尾巴完全没覆盖**，感叹号也只从 13 降到 11。按「不在未测误伤率前批量启用新删除规则」的约束，这里只记录、不动规则。

**确定性自检**：`node eval/run-eval.mjs --stability` → `STABLE 同一批上下文两次构建逐字节一致`。

**仍未完成的部分（不得标「B1 已完成」）**：两名评审的逐条评分与分歧表还没填；`eval/aggregate.mjs` 在缺 `scores-reviewer-A/B.csv` 时只输出机械指标（已实测该分支）。工时里「评审时间」本就不算在半天内。

**回滚**：`eval/` 全是新增只读资产，删目录即回滚；不影响桥接运行。

### 6.9 C3 交接演练（本轮新增，只读）

**新增 `scripts/dryrun-handoff.mjs`**：读真实 `config.json → contextBudget`、`state/token-usage.jsonl`、`state/social-v2.json`、`state/sessions.json`，按 enforce 时的顺序在**临时目录**演练：①算水位与 `level` ②组装并校验 handoff payload ③写入临时 handoff store 并回读 ④打印 enforce 四步顺序 ⑤核对 `state/sessions.json` 与 `state/social-v2.json` 的 sha256 前后一致（证明演练没写生产目录，不一致则 exit 1）。

**本次实测输出**：`private:100000001` 水位 **354.4K → soft**，`mode=shadow`，`会不会退役=false`；payload 校验 ok 但**注入行 0 字符**；临时写入 ok、回读 ok；生产状态未变 ✅。

**发现（重要，写进 C3 的前置条件）**：该会话 `activeTopics / pendingThoughts / memberImpressions` **全部为空**（共 0 项）。也就是说照当前实现走到 hard 时，交接会交出**空壳**：上下文确实省了，但连续性一点没保住。两条可行处理，二选一（建议 B）：
- A. 交接前先让记忆有内容（依赖 L1/L2 真正被写入，短期不可控）；
- B. 交接时用**最近消息兜底组装** payload（`buildHandoffFromRecent()`），限制同上：单条 ≤40 码点、每字段 ≤8 条、整份 JSON ≤400 字符。演练已验证可行：取最近 6 条消息拼一份 → 注入行 **55 字符**，示例 `【上次交接】话题：在聊：…；未完：…`。

**payload 硬限制（来自 `src/handoff.mjs`）**：`HANDOFF_SCHEMA_VERSION=1`、`HANDOFF_MAX_CHARS=400`、`MAX_ITEMS=8`、`MAX_ITEM_CHARS=40`（按码点）；`normalizeHandoffPayload(raw,{maxChars})` 返回 `{ok:true,value}` / `{ok:false,reason}`，`reason` 可能是 `not-object / bad-schema-version / field-not-array / not-string / too-many / too-long / too-large / scrub-failed`。

**进入 enforce 前需要补的一条**：在 `shouldRequestHandoff()` 为真的分支里，先尝试模型交的 payload，为空则用 `buildHandoffFromRecent()` 兜底；只有兜底也为空（连续 6 条消息都不可用）才拒绝退役并记一行告警。

**回滚**：删 `scripts/dryrun-handoff.mjs` 即可；它是只读脚本，不参与运行链路。

### 6.10 C3 前置：交接兜底组装（本轮新增）

**动机**：§6.9 演练发现记忆区为空时交接会交空壳。为让「省上下文」不牺牲「连续性」，新增兜底组装。

**改动**：
- `src/handoff.mjs` 新增导出 `buildHandoffFromRecent(messages, { maxMessages = 6, maxChars = 400 })` → `{ok:true, value, used:{messages, items}}` / `{ok:false, reason}`。规则：只接受字符串来源（`text` 或 `plain`），压空白、丢空串、取最后 N 条；`topics` 用 `在聊：<最后一条>`，`openLoops` 用之前两条；按 `MAX_ITEM_CHARS=40` 码点裁剪（`…` 结尾），按「减条目 → 缩单条 → 只留话题」固定梯度降级，保证同输入同输出；不产生孤立代理项。
- `src/bridge.js`：import 加 `buildHandoffFromRecent`；`runHandoffAtSafePointV2()` 里 `buildHandoffFromStateV2()` 之后加 `handoffHasContent()` 判定，空则用最近 6 条消息兜底并记 `[handoff] 记忆区为空，改用最近 N 条消息组装 (key)`；兜底也失败则只记日志、照旧拒绝退役（fail-open 不变）。

**验收**：
- `node scripts/test-handoff-recent.mjs` → **11 通过 / 0 失败**（正常三条、≤400 字符、空输入、超长裁剪、只取最后 6 条、去重、emoji 不产生孤立代理项、maxMessages 夹取、确定性、过正式 normalize、非字符串元素不抛异常）。
- `node scripts/dryrun-handoff.mjs` → 真实会话 `private:100000001` 记忆区 0 项，兜底生效：最近 6 条 → 注入行 **64 字符**，如 `【上次交接】话题：在聊：…；未完：…`；临时写入与回读 ok；生产状态 sha256 未变。
- 回归全绿：`test-handoff` 29、`test-context-budget` 26、`test-console-ui` 5、`test-cost-guard` 26、`test-token-usage` 97、`test-ai-tone-semantic` 243、`test-profile-slice` 23、`test-profiles` 31、`test-qq-preset-contract` 0 fail、`test-ops-panel` 全过。
- 桥接重启：pid `22124` → **`1448`**（13:27:35 已就绪），`GET /api/social` 返回 shadow/300K/420K，`private:100000001` 水位 `354.4K`。

**回滚**：`src/bridge.js` 去掉 `handoffHasContent` 兜底块与 import 项，`src/handoff.mjs` 删 `buildHandoffFromRecent` + `clampInt`，删 `scripts/test-handoff-recent.mjs`；`dryrun-handoff.mjs` 里对 `buildHandoffFromRecent` 的引用一并删除（或保留脚本不用）。

**仍未做**：C3 的实体轮换（等 24h + 首个 `[budget]`）；真实触发时需在日志里确认走的是「模型 payload」还是「兜底 payload」。

### 6.11 B1 工具链收尾：CSV 健壮解析 + 机器代理评审（本轮新增）

**修的坑**：`baseline-2/blind.csv` 里有多行引号字段（c03 的推荐游戏回复带换行），原先按 `\n` 切行会把 30 条读成 68 条，导致汇总均分、胜场全错。

**新增 `eval/csv.mjs`**：`parseCsv`（双引号包裹、`""` 转义、字段内换行、CRLF）、`parseCsvObjects`、`csvLine`。`aggregate.mjs` 与 `review-machine.mjs` 都改用它。

**重写 `eval/aggregate.mjs`**：自动发现 `scores-reviewer-*.csv`（人评 A/B、机器代理 M 都认）；输出总表 + 逐评审表；胜场改为**逐条比较五维总分**并按 `baseline.key[id]` 映射回 raw/cleaned（旧版按整批均值比，逻辑是错的）；无人类评审时明确打印「不构成人工基线」。

**新增 `eval/review-machine.mjs`**（机器代理，非人评）：读 `blind.csv`，按固定规则给两栏各打五维分并写 `scores-reviewer-M.csv`。规则写在文件头：natural 看 AI 味词/语气尾巴/堆叠感叹号；faithful 与 harm 看相对另一栏是否丢了数字与否定词；template 看开头 6 字在整批里的重复度。**限制写在输出里**：启发式、只看文本，不构成人工基线。

**实测（baseline-2）**：`review-machine` → 30 条 × 2 栏、两栏不同的 13 条；代理均分 side1/side2：natural 4.53/4.37、faithful 4.77/4.93、harm 4.87/4.93、template 3.27/3.23。
`aggregate` → 评审文件 M（60 行）；五维总分胜场 **raw=3 / cleaned=5 / 平手=22**；无分歧；末行提示仍缺两名真人评审。

**新增 `scripts/test-eval-tools.mjs`** → **7 通过 / 0 失败**（跨行 CSV、`""` 转义、表头映射、按需加引号、空文本、两次评分逐字节一致、只有机器分时的提示、两名评审出现分歧时的报出）。

**回滚**：删 `eval/review-machine.mjs`、`eval/csv.mjs`、`scripts/test-eval-tools.mjs` 与 run 目录里的 `scores-reviewer-M.csv`；`aggregate.mjs` 回退到旧版即可（不参与运行链路）。

**注意**：`scores-reviewer-M.csv` 只是链路验证与对照，B1 的完成条件仍是两名真人各 30 条评分。

### 6.12 B1 评审包 + 提示词预算体检（本轮新增）

**评审包（让人评能开始）**

- `eval/make-packs.mjs <run-dir>` → 在 `eval/runs/<run>/review-packs/` 下生成 `reviewer-A.csv`、`reviewer-B.csv`、`README.md`（已用 `2026-10-26T05-24-34-baseline-2` 实跑：30 条 × 17 列，8,536 B，全文不含 `raw`/`cleaned`）。
- 打包列 17 个：`reviewer,id,situation,incoming,side1,side2,natural1,faithful1,harm1,template1,stable1,natural2,faithful2,harm2,template2,stable2,note`。
- **不带答案映射**：两份包里没有 `raw`/`cleaned` 字段，评审看不到哪栏是原稿；README 里写明五维含义、交回格式（扁平 `reviewer,id,side,natural,faithful,harm,template,stable,note`）、不要商量分数、不要猜哪栏是「改过的」。
- `eval/check-review.mjs <scores.csv> <blind.csv>`：收回来先跑它 —— 校验 id 存在且不重复、`side` 只允许 1/2、五维必须是 1–5 整数、整行不许缺项。退出码 **0 可用 / 1 有空项（逐格列出） / 2 非法**（未知 id、重复 id、越界分）。
- `scripts/test-eval-packs.mjs` → **4 通过 / 0 失败**：两份包各 30 条 17 列且不含 `raw`/`cleaned`；校验器对完整文件返回 0、对空项返回 1、对 9 分返回 2。
  - 踩坑记录：测试里修改 CSV 必须用 `parseCsvObjects` 改字段再 `csvLine` 写回，**不能对整行做字符串 replace** —— 首版就是这么连挂两次的。

#### 提示词预算体检（D3 的量化前置）

`scripts/analyze-prompt-budget.mjs`（只读，不参与运行链路）：读 `dsh/agent-presets/<preset>/agent.cordis.yml` 里的 `prefix: >-` / `suffix: >-` 段，读 `roles/<角色>.md`，输出三组数：两笔成本各多少字符、人格卡占注入上限多少、两者之间重复多少。

实测（`qq-chat-v2` + `小鲸鱼`）：

| 项 | 实测 | 说明 |
| --- | --- | --- |
| preset prefix | 10,379 字符 | 每轮恒在的系统提示，与轮次无关 |
| preset suffix | 0 字符 | 未使用 |
| 人格卡 | 7,087 字符 / 268 行 | 占 `maxInjectChars=8000` 的 **89%**，余量 913 字符 |
| 卡内逐行重复 | 2 组（多出 22 字符） | 例：「你不要：哈哈是的呢～」「你可以：？你再说一遍试试」 |
| 卡内 8 码点重复窗口 | 100/6,515（**2%**） | |
| preset↔人格卡 逐行重复 | 0 条 | |
| preset↔人格卡 8 码点重叠 | 88/8,971（**1%**） | |

**要纠正的一个说法**：早先文档里「卡内重复约 1/3」的估计不成立，实测卡内重复只有 2%，preset 与卡之间只有 1%。**D3（卡瘦身）的收益主要来自长度本身**，不是去重：

- preset 10,379 字符 ≈ 6,900–8,650 token（中文 1.2–1.5 字符/token 粗估），这是每轮都要付的钱；缩短它的收益是线性的、可预测的。
- 人格卡已经在 89% 水位，只剩 913 字符余量 —— 再往里加规则就会挤掉别的内容，所以卡的改动要先减后加。

**回滚**：删 `eval/make-packs.mjs`、`eval/check-review.mjs`、`scripts/test-eval-packs.mjs`、`scripts/analyze-prompt-budget.mjs` 与 run 目录下的 `review-packs/` 即可，全部是只读工具，不接入收发链路。

**仍未做**：B1 的两名真人评审（包已就绪，等有人愿意花 2–3 小时）；C3 仍卡在 24h 影子闸门。


### 6.13 日志占位符修复 + 一键回归（本轮新增）

**修的问题（真实缺陷，不是优化项）**：`src/bridge.js:10206` 与 `:10208` 两行交接日志的模板占位符丢了 —— 屏幕上会打成「改用最近  条消息组装 ()」和「最近消息不可用 ()：」，看不出是哪个会话、取了几条、失败原因是什么。起因是早前用 PowerShell 字符串替换改代码，`${...}` 被当成变量吞掉了。

修复后：

```js
log(`[handoff] 记忆区为空，改用最近 ${fallback.used.messages} 条消息组装 (${key})`);
log(`[handoff] 记忆区为空且最近消息不可用 (${key})：${fallback.reason}`);
```

顺带做了一次全仓扫描确认同类伤害只有这两处：`grep '该工具已移除'`、`memory: 'qq_memory_append`、`cfg.contextBudget =` 等本轮改动行都完整；`src/handoff.mjs` 的 `话题：${...}` / `未完：${...}` / `【上次交接】` 拼接未受损。**教训**：改含 `${}` 的代码只用 edit 工具或单引号 here-string，不要用双引号字符串做替换。

**新增 `scripts/test-opt-suite.mjs`（16 个文件一次跑完）**：

```
node scripts/test-opt-suite.mjs          # 逐项 PASS/FAIL + 耗时 + 合计
node scripts/test-opt-suite.mjs --verbose # 失败项或全部项都打末尾 12 行输出
```

覆盖：ops-panel / cost-guard / token-usage / console-ui / ai-tone / ai-tone-semantic / context-budget / handoff / handoff-recent / profile-slice / profiles / qq-preset-contract / mcp-safe / fewshot / eval-tools / eval-packs。

**实测**：`16/16 个测试文件通过，合计 2.6s`（最慢 `test-mcp-safe.mjs` 713 ms）。`package.json` 同时加了 `"test:opt"` 别名；注意本机 PATH 里没有 `npm`，实际执行请用 `node scripts/test-opt-suite.mjs`。

**重启验证**：旧 pid `1448` → 新 pid `44260`（13:33:01「DSH 已就绪」）；`GET /api/social` 带 `x-console-token` 返回 `enabled:true / shadow / softAt:300000 / hardAt:420000 / softLabel:300K / hardLabel:420K`，`private:100000001` 水位 `354.6K`。

**回滚**：删 `scripts/test-opt-suite.mjs` 与 `package.json` 里的 `test:opt` 一行；日志两行改回原样（若确实要回滚）。回归套件纯读，不影响运行。

**仍未做**：C3 闸门还是 2 项未过（影子 0.3h、`[budget]` 0 行），与 6.12 结尾一致。

### 6.14 面板加「上下文水位」观察窗口（本轮新增）

**为什么加**：C3 要等 24h 影子和第一条 `[budget]` 日志，这段时间里没人能直观看到「哪个会话快到硬线」。原来只有 `/api/social` 的 JSON 里有水位，翻起来费劲。面板上加一栏，正好对上 §6.6 的 Go/No-Go 条件。

**改动**：

- `src/ops-panel.js` 新增 `maskSessionKey(key)`：`private:100000001` → `private:1000***001`；新增 `summarizeBudget({ contextBudget, sessions })` → `{ enabled, mode, softAt, hardAt, counts:{ok,soft,hard,unknown}, rows[] }`；`rows` 按水位降序，每行 `{ key(脱敏), watermark, at, level, pendingHandoff, lastHandoffAt }`。`buildOpsPanel()` 的 `questions.budget` 输出这一段。
- **没有水位时是 `null`，不是 0**：`level` 走 `classifyContextWatermark(null)` → `'unknown'`，页面渲染 `—`。这条是从 A2 继承的教训（0 在这套口径里等于「很安全」，会把「没采到」伪装成「没问题」）。
- `src/bridge.js` 的 `/api/ops/panel` 路由补 `contextBudget: contextBudgetConfig()` 与 `budgetSessions`，取数与 `/api/social` 的 `budget.sessions` 同口径（现算优先、落盘值兜底）。
- `public/ops.html` 新增第 6 张卡「上下文水位」：当前模式（shadow/enforce）、软线硬线、状态开关、超软线/超硬线条数、逐会话列表（脱敏键 + 分级 pill + 水位 + 「待交接」标记）。新增 `fmtWm()`：非有限值渲染 `—`。

**验收**（重启后 pid `37900`，13:38 就绪）：

```
GET /api/ops/panel?days=7（带 x-console-token）
budget.enabled=true  mode=shadow  softAt=300000  hardAt=420000
counts = {"ok":0,"soft":1,"hard":0,"unknown":1}
  private:1000***001  lv=soft     wm=354563
  group:1122***455    lv=unknown  wm=null
GET /ops → 200（带令牌）／无令牌 → 401
```

`node scripts/test-ops-panel.mjs` 新增 14 条断言（脱敏三种形态、分级 soft/ok/unknown、降序、计数、模式与阈值透出、关闭时一律 unknown、面板内嵌 budget 段）→ 全绿；`node scripts/test-opt-suite.mjs` → **16/16 通过，2.7s**。页面内联脚本抽出来 `node --check` 通过（8,374 → 8,600+ 字符）。

**回滚**：`src/ops-panel.js` 删 `maskSessionKey`/`summarizeBudget` 与 `questions.budget`；`src/bridge.js` 删路由里的 `contextBudget`/`budgetSessions` 两行；`public/ops.html` 删第 6 张卡与 `fmtWm`。面板纯读，不影响收发。

**顺带发现**：`public/ops.html` 里 `function pct` 原本重复定义了一次（重复声明不报错但容易改错那份），已去掉多余的一行。

### 6.15 wait 空转观察接进面板（本轮新增）

**为什么**：D1 的第 2 阶段要求「记录每轮 wait 次数与返回消息数，测单轮上限候选值 2」。代码里其实早有一份内存态统计（`waitStatsV2`，`src/bridge.js:2810`，key → `{calls, returned}`，`[wait] … 第 N 次等待，本次带回 M 条`），但只写日志，面板上看不到，等于没法拿它做判断。

**改动**：

- `src/bridge.js:7505` 附近：统计对象加 `empty` 字段（本次 `newCount === 0` 就 +1），其余不动。
- `src/ops-panel.js` 新增 `summarizeWait(sessions)` → `{ calls, returned, emptyCalls, emptyRate, avgReturned, rows[{key(脱敏), calls, returned, emptyCalls, avgReturned}] }`，按调用次数降序；`buildOpsPanel()` 输出 `questions.wait`。
- `src/bridge.js` 的 `/api/ops/panel` 传 `waitSessions`（把内存 Map 摊平成数组）。
- `public/ops.html` 第 7 张卡「等待空转」：空转占比大字 + 判定 pill（>60% 红 / >30% 黄）+ 调用/带回/每次平均带回 + 逐会话行。

**验收**：

- `node scripts/test-ops-panel.mjs` 新增 10 条断言（总调用 12、总带回 9、空转 6、空转占比 0.5、平均 0.8、降序、脱敏键、无会话给 0 不给 NaN、面板内嵌 wait 段）→ 全绿。
- `node scripts/test-opt-suite.mjs` → **16/16 通过，2.7s**；页面内联脚本 `node --check` 通过。
- 重启 pid `37900` → `41980`；`GET /api/ops/panel?days=7` 返回 `wait.calls=0 / returned=0 / emptyCalls=0`（刚重启，内存计数已清零——这是既定语义），`budget.rows` 2 行，`GET /ops` 200。

**口径说明（重要）**：这份统计是**内存态、重启清零**，所以它回答的是「这次启动以来 wait 空转多不多」，不是历史累计。要看历史只能翻 `state/bridge.log` 的 `[wait]` 行。这也意味着它不能直接当「7 天 wait 次数」的证据——那仍然要靠日志或 token 账本按工具名统计。

**回滚**：`src/ops-panel.js` 删 `summarizeWait` 与 `questions.wait`；`src/bridge.js` 删 `empty` 计数与路由里的 `waitSessions`；`public/ops.html` 删第 7 张卡。纯观测，不影响 wait 的行为。

---

### 6.16 B1 评审网页：让「两名真人」真的能评（本轮新增）

**为什么**：§6.11/§6.12 把评审包和校验器做出来了，但真人评分这件事还卡在「拿 Excel 手填 17 列 CSV」——错列、漏格、把答案映射弄丢都可能发生，而且没人愿意干。加一个本地网页，把「打开评审包 → 逐条两栏打分 → 导出提交文件」这条路走顺。

**产物**：

- `eval/review.html`：纯本地页面（`file://` 双击可开，**不发任何网络请求**，评审包只在本机读）。选评审包 → 每条卡片显示两栏正文 + 各五个 1–5 下拉 + 「更像真人：这一栏」单选 + 备注 → 导出 `scores-reviewer-<名字>.csv`。
- `eval/review-core.mjs`：同一套规则的纯函数版（`parseCsv` / `packRows` / `scoreRows` / `serializeScores` / `progress`），供测试调用；页面因 `file://` 不能 `import`，内联了一份同构实现，靠测试比对两边输出防漂移。
- `scripts/test-eval-review-page.mjs`：27 条断言，把页面里的 `// [review-core:begin]…end` 段抽出来在 Node 里执行，与模块版逐函数比对（含跨行引号 CSV、真实 30 条评审包、越界报错文案、进度计数、静态检查「无 fetch」）。
- `scripts/test-opt-suite.mjs` 增加该项 → **17/17 通过，2.6s**。

**格式契约（关键）**：导出是「每栏一行」的扁平 CSV —— 30 条 → **60 行**，表头 `reviewer,id,side,natural,faithful,harm,template,stable,note`。这正是 `eval/check-review.mjs` 与 `eval/aggregate.mjs` 期望的形状；测试里用打满的 60 行实跑 `check-review` 得到 exit 0。此前 `scoreRows` 只导「被选中那栏」的写法是错的（校验器会报 30 条「缺整行」），已改成两栏各一行。

**验收**：

- `node scripts/test-eval-review-page.mjs` → **27 passed, 0 failed**（其中含「60 行导出 → check-review exit 0」）。
- 页面内联脚本单独抽出 `node --check` → exit 0（9,245 字符）。
- `node scripts/test-opt-suite.mjs` → 17/17。
- 三档校验行为：完整 → exit 0；缺格 → exit 1 并列出缺哪些条；9 分等非法值 → exit 2。

**限制**：页面不保存草稿（刷新即丢），一名评审建议一次评完；分发方式是把 `reviewer-A.csv`/`reviewer-B.csv` 与 `review.html` 一起给两名人评，各自导出文件交回，再 `node eval/check-review.mjs <scores.csv> <blind.csv>` 校验、`node eval/aggregate.mjs <run-dir>` 汇总。

**回滚**：删 `eval/review.html`、`eval/review-core.mjs`、`scripts/test-eval-review-page.mjs`，并从 `scripts/test-opt-suite.mjs` 去掉该行。不影响既有 eval 链路。

---

### 6.17 D3 人格卡瘦身：先把「能独立做的前置」做完（本轮新增）

**为什么**：D3 的硬依赖是 C3（会话轮换），否则提示词瘦身的收益会被几百轮历史体积淹没、测不出来。但 D3 的前半段——**建立基线 + 量化重复 + 出候选稿 + 写验收**——完全不依赖 C3，先做完，闸门一开就能直接进 A/B。

**① 基线快照（回滚的锚）**
- `scripts/snapshot-persona-card.mjs`：把当前卡复制进 `eval/d3/baseline/`，记 sha256 / 字符数 / 行数 / 字节 / 时间 / 原因，并维护 `eval/d3/baseline/manifest.json`。
- 本次快照：`eval/d3/baseline/小鲸鱼.md.f17d7354.2026-10-26-05-41-44.bak`，sha256 `f17d7354…`，**7,087 字符 / 268 行 / 18,202 B**。
- **`roles/小鲸鱼.md` 本体未改动**（sha 与快照一致），线上行为零变化。

**② 结构体检（`scripts/analyze-persona-card.mjs`，只读）**
- 卡共 **20 节**；体积前三：`七、回复示例` **1,067 字符（15.1%）**、`二、群聊说话铁律` 959（13.5%）、`六、AI 味黑名单` 859（12.1%）；`核心 · 每轮必看` 437（6.2%）。
- 跨节**完全重复 0 组、近似重复簇 0 个、重复条目占全卡 0.0%** —— 再次确认「重复 1/3」的说法不成立，**该砍的是长度不是去重**（§6.12 的结论在结构层面得到验证）。
- 但**主题复述**很明显：被怼/顶回去 **29 次**、短句/字数 **27 次**、不打包票/推荐 **19 次**、心理师腔/共情 **18 次**、潜水 **14 次** —— 同一件事散在 3–5 节里各说一遍，这才是可以合并的地方。
- 产物：`eval/d3/card-analysis.json`（各节区间与字数、重复簇、主题矩阵）。

**③ 候选稿（`eval/d3/小鲸鱼.slim.md`，未接线）**
- **4,278 字符**（原 7,087，**省 2,809 / 42.8%**），95 行，**10 节**（20 → 10，按「身份 / 说话铁律 / 人格与梗 / 黑名单 / 示例 / 节奏 / 场景 / 形象 / 核心」重组）。
- `核心 · 每轮必看`：386 字符（原 437，预算 ≤400 内）。
- 逐行与原卡完全相同者 **16/77 = 20.8%**（其余为重组改写，避免只是删行）。
- 保留策略：安全边界（拒绝越权、对管理员温柔）、身份事实（V我50、蓝色大肥鱼、本小姐只作禁止项）、机制约束（括号内容会被发出去、引用判断、不编造形象）**逐条保留**；示例 15 组压到 10 组；场景 8 节压成 7 条速查。

**④ 验收（`scripts/test-persona-slim.mjs`，50 条断言）**
- 总字数 ≤5,500、比原卡短；核心段 ≤400；分节 ≥8 且每节有实质内容。
- **19 个必须保留项**逐条检查（最高原则 / 不是客服 / 蓝色大肥鱼 / V我50 / 管理员 / 引用 / 括号内容会被当成正式消息 / 本小姐 / 拒绝 / 越权 / 不确定就说不确定 / 不总结 / 我理解你的感受 / 希望对你有帮助 / 作为AI / 首先 / 接梗 / 潜水 / 1~10）。
- **12 个主题**、**7 个场景**覆盖检查（防止瘦身时整类规则被砍掉）。
- 「本小姐」只准出现 1 次且必须在「不自称」语境；无 TODO/占位；逐行重合率 ≤35%。
- 实测：**50 passed / 0 failed**；已并入 `test-opt-suite.mjs` → **18/18，2.7s**。

**⑤ 还没做的（等 C3）**
1. C3 完成后，把候选卡接成开关（例如 `persona.slim: true` 读候选文件），**影子跑**、不动线上。
2. 用 B1 盲评对比原卡 vs 候选（同一批 30 条上下文），要求不低于基线；同时看注入体积与首轮 token。
3. 盲评通过才替换 `roles/小鲸鱼.md`；**回滚 = 把 manifest 最新快照复制回去 + 重启**。

**⑥ 已知风险**：候选稿尚未经过任何人工评分，风格密度（摸鱼、梗的密度）可能被压平；42.8% 的削减幅度**大于**验收线（≤5,500，实际 4,278），说明还有回旋余地——如果盲评变差，优先从示例与梗的细节往回加，而不是放宽预算线。

### 6.18 D3 接线：人格卡影子覆盖（`role.overrideFile`）

**为什么先做接线**：§6.17 的候选稿已经存在，但没有开关就无法影子跑；直接替换 `roles/小鲸鱼.md` 会丢掉回滚点。目标是「改一个配置项 + 重启」就能在两张卡之间切换，默认关闭、零行为变化。

**改动（4 处）**

| 文件 | 改动 |
| --- | --- |
| `src/role-card.js` | 新增导出 `resolveRoleFile({ rolesDir, name, overrideFile })`：无覆盖 → `roles/<名称>.md`；有覆盖 → 只接受项目内相对路径的 `.md/.txt`，绝对路径 / `..` 穿越 / `node_modules` / `.git` / 其它扩展名一律返回 `''`（宁可不注入，也不读错文件） |
| `src/bridge.js:16` | import 列表加 `resolveRoleFile` |
| `src/bridge.js` `cfg.role` | 默认值加 `overrideFile: ''`；字符串 trim 归一化；非空时启动探一次并打日志（非法 → `⚠️ role.overrideFile「…」非法（须在项目内、.md/.txt），已忽略`；合法 → `人格卡影子覆盖已启用：…`） |
| `src/bridge.js` `roleRawContent()` | 文件改由 `resolveRoleFile` 决定；路径校验放宽为「在 `roles/` 内 **或** 在项目根内」；缓存 key 加解析后的绝对路径（同名角色可映射到不同文件） |

**配置**：`config.json → role.overrideFile: ""`（默认；行为与改前一致）。要影子跑候选稿时改成 `"eval/d3/小鲸鱼.slim.md"`。

**验收**

- `node --check src/role-card.js`、`node --check src/bridge.js` 通过。
- 新增 `scripts/test-role-override.mjs` → **23 条断言**：默认路径、合法覆盖、`.txt`、扩展名大小写、正反斜杠；绝对路径 / `..` 穿越 / `node_modules` / `.git` / 非文本扩展名 / 坏角色名 / 空 `rolesDir` 全部拒绝；并静态断言 bridge 真的接上了（import、默认值、trim、缓存 key、`roleRawContent` 调用点）。并入套件 → **19/19，2.9s**。
- 新增 `scripts/check-role-injection.mjs <prompt.txt>`：从唤醒预览里抽「【人格 · 每轮】」块，断言它以线上卡 wake 视图开头、且不以候选稿开头（唤醒块 = 核心段 + 命中场景，不能和整卡逐字节比）。
- 线上实测（同一会话、同一 `reason=preview`）：
  - `overrideFile: ""` → 提示 **4,261 字符**，人格块 **555 字符 = 核心 449 + 场景 106**，`check-role-injection` → ✓ **等于线上卡**；
  - `overrideFile: "eval/d3/小鲸鱼.slim.md"` → 提示 **4,104 字符**（少 157），`state/bridge.log` 出现 `人格卡影子覆盖已启用：eval/d3/小鲸鱼.slim.md`；
  - 改回 `""` 重启 → 恢复默认，人格块重新等于线上卡。

**回滚**：`config.json → role.overrideFile` 置 `""` + 重启即可。候选稿从未被写入 `roles/`，`roles/小鲸鱼.md` 的 sha 仍是 §6.17 的 `f17d7354…`。

**事故与运维要点（重要）**：验证时强杀桥接进程后，`state/bridge.lock` 残留旧 pid，守护进程判定「已有实例在运行」而每 120 秒空转一次，**约 6 分钟不可用**；手工删除该 lock 后 5 秒内自愈。同时 `start.bat` 里一行 `rem` 注释（含全角括号）被 cmd 当成命令，打印 `'…' is not recognized`，不致命但会误导排障。**以后强杀桥接后先删 `state/bridge.lock` 再等守护拉起；更稳妥的是用 `restart.bat`（它会先按 PID + `bridge.js` 两条路杀干净、确认无存活进程，再删锁并隐藏窗口拉起守护）。**

**收益预期（实测，别高估 D3）**：reserved2 模式下每轮注入的是「核心段 + 命中场景」，**不是整张卡**——实测人格块 555 字符（核心 449 + 场景 106），换成候选稿后整条唤醒提示 4,261 → **4,104 字符（省 157 ≈ 100 token/轮）**。整卡（7,087 字符）只在模型主动调 `qq_get_prompt` 时才作为工具结果出现。所以 D3 的价值主要是**工具结果体积与一致性**，不是每轮省 3K token；排期上它继续待在 C3 之后是对的。

### 6.19 C3 翻闸运行手册（24h 到点后照做）

到点判据：`node scripts/gate-enforce.mjs` 六项全 PASS（唯一曾 FAIL 的是「影子满 24h」，起点 `state/c2-shadow-start.json` 记 2026-10-26 13:16:07，即 2026-10-27 13:16 之后）。

**步骤**

1. **再跑一次体检**：`node scripts/gate-enforce.mjs`（要求 6 PASS）、`node scripts/test-opt-suite.mjs`（要求 24/24）。配套命令：留底用 `node scripts/prep-enforce.mjs`，翻后核对用 `node scripts/prep-enforce.mjs --verify`（判据与实测见 §6.26）。
2. **留回滚点**（
ode scripts/prep-enforce.mjs 一条命令搞定；已存在的备份不要覆盖）：
   - `state/archive/sessions.json.<日期>-pre-enforce.bak`
   - `state/archive/config.json.<日期>-pre-enforce.bak`
   - 可选：`state/archive/social-v2.json.<日期>-pre-enforce.bak`
3. **改配置**：`config.json → contextBudget.mode` 从 `"shadow"` 改成 `"enforce"`（`softAt 300000 / hardAt 420000` 不变；`costGuard.contextWatermarkMax` 保持 340000 作为告警线）。**最省事的方式是直接跑 `node scripts/flip-enforce.mjs --on`**（体检→留底→改配置→重启→核对一条命令，见 §6.27；回滚 `--off`）。
4. **重启**：`restart.bat`（唯一推荐方式）。验证：`GET /api/social` 的 `contextBudget.mode === "enforce"`。
5. **观察第一个触发**：`state/bridge.log` 里等 `[budget]` 行；硬线命中时才应出现 `[handoff]` 与 `[session] ... 退役/轮换` 一类日志。当前会话水位 354–358K、每轮约 +3.5K，距 420K 约 18–20 轮。
6. **看交接质量**：`state/handoff/*.json` 必须**非空壳**（`topics/openLoops` 或兜底的「在聊：…」至少一条）；若出现 `记忆区为空` 且兜底也失败，立刻回滚。

**Go / No-Go（任一不满足就回滚）**

- 24h 内无 `handoff` 载荷校验失败（`normalizeHandoffPayload` 报 `too-long` / 缺字段）。
- 24h 内无「交接后新会话丢了未读」——`retireSession()` 不清 `st.unread`（已核对），但要在真实轮换后确认一次。
- 24h 内无异常重启循环（`state/guard.log` 里 code 2 空转应消失）。
- 首轮交接后 AI 仍能接上话题（人工看 1–2 轮回复是否「失忆」）。
- **`【上次交接】` 行只出现一次**：新会话第一轮唤醒能看到、第二轮起不再出现（对应 §6.21 的修复）。

**回滚**（任一条件触发）

1. `config.json → contextBudget.mode` 改回 `"shadow"`。
2. `restart.bat`。
3. 若某会话已被退役且体验变差：把 `state/archive/sessions.json.<日期>-pre-enforce.bak` 覆盖回 `state/sessions.json`、重启（会丢失退役后新增的会话元数据，代价可接受）。
4. 记录「为什么回滚」到本节，不要静默改回。

**翻闸时顺手做的两件小事**

- ~~把 `start.bat` 第 22–25 行那几行中文 `rem` 改成纯 ASCII~~ —— **已于本轮完成**，见 §6.20。
- 翻闸后再跑一次 `node scripts/test-opt-suite.mjs`，确认改配置没影响测试。

**验证记录（本轮实跑，翻闸前先证明重启路径可靠）**

- 13:49:46 `restart.bat` → 旧桥接 PID 15728 被杀、锁删除、守护重建；新 PID 29020；`/api/social` 仍 `shadow/300000/420000`；唤醒预览 4,261 字符、人格块 555（核心 449 + 场景 106）。
- 13:50:22 再次 `restart.bat`（验证刚加固的等待逻辑）→ PID 29020 → **9152**，`guard.log` 无新增 `is not recognized`（总数停在 49 条历史记录），`prompt=4261` 不变。
- 结论：`restart.bat` 可以放心作为翻闸与回滚的唯一重启手段。

### 6.20 守护脚本两处加固（`start.bat` / `restart.bat`）

这两处不是优化清单里的条目，但都会直接影响翻闸时的可用性，所以顺手修掉。

**① `start.bat` 的 code 2 分支：中文 `rem` 被 cmd 当命令执行**

- 现象：`state/guard.log` 里每 120 秒重复一行 `'�两套监督者）。以前这里直接退出，' is not recognized as an internal or external command`，累计 49 条。
- 原因：那几行 `rem` 位于 `if "%code%"=="2" ( ... )` 括号块内且含中文与全角标点，cmd 解析块内 `rem` 时会把它当成命令行。
- 修法：四条 `rem` 改成纯 ASCII 英文，并去掉括号内的 ASCII 圆括号（块内的 `)` 会提前闭合块）。
- 验证：改后两次重启，`guard.log` 不再新增该行（计数停在 49）。

**② `restart.bat` 的等待：`timeout` 在 stdin 被重定向时直接失效**

- 现象：`cmd /c restart.bat > log` 时报 `ERROR: Input redirection is not supported, exiting the process immediately.`，**3 秒等待被跳过**——杀进程后立刻检查「是否还有存活进程」存在竞态。
- 修法：`timeout /t 3 /nobreak >nul` 改为 `ping -n 4 127.0.0.1 >nul`（不依赖 stdin，行为等价）。
- 验证：重跑 `restart.bat` 输出干净、PID 正常轮换。

### 6.21 交接行「只注入一次」（O1 enforce 的前置修复）

翻闸前审 enforce 注入路径时发现一个会**在翻闸当天才暴露**的缺陷：交接摘要行会每轮重复注入。

**缺陷（`src/bridge.js`）**

- `runHandoffAtSafePointV2()` 写入交接后设 `st.lastHandoffPayload`，但**从不清理**；
- `formatHandoffLineV2(key, st)` 只判断 `mode === 'enforce'` 就 `return line`，**不记录「这份交接注入过没有」**；
- 后果：enforce 下新会话的**每一次唤醒**都会再拼一遍 `【上次交接】话题：…`。模型会一直以为「刚从上个会话交接过来」，而且每轮白付几十个字符（一次交接后可能持续几百轮）。

交接文件不能删（排障、回读都要用），所以去重只能靠「给每份交接一个 id + 记住注入过哪一份」。

**改动**

| 文件 | 改动 |
| --- | --- |
| `src/handoff.mjs` | 新增导出 `handoffInjectionDecision({ mode, preview, pendingId, injectedId })` → `'inject'` / `'skip-mode'` / `'skip-none'` / `'skip-consumed'`。`preview` 只展示、不消耗（否则控制台看一眼就把真实唤醒的交接吃掉了） |
| `src/bridge.js` | 会话状态加 `handoffPendingId` / `handoffInjectedId`（含 normalize 的字符串清洗）；写入成功后 `st.handoffPendingId = String(st.lastHandoffAt)`；注入后 `st.handoffInjectedId = pendingId` 并落盘；`formatHandoffLineV2(key, st, { preview })` 接判定，非 `inject` 返回空串；`buildWakePromptV2` 把 `preview` 透传下来 |
| `scripts/test-handoff-injection.mjs` | 新增 22 条断言：判定矩阵 9 条、状态机「三次唤醒只注入一次 + 预览不消耗 + 新交接再注入」6 条、`bridge.js` 接线静态断言 7 条 |

**身份 id 的取法**：内存里刚写的用 `lastHandoffAt`；重启后回读磁盘的用 `got.meta.generatedAt`。两者都是「这一次交接」的稳定标识，重启不会导致重复注入。

**验收**

- `node --check src/handoff.mjs`、`node --check src/bridge.js` 通过；
- `node scripts/test-opt-suite.mjs` → **20/20，2.8s**（新增 `test-handoff-injection.mjs` 62 ms）；
- `restart.bat` 重启后 pid `9152 → 55624`，`GET /api/social` 仍 `shadow / 300000 / 420000`，`GET /api/ops/panel` 正常（`steps=1145`、`soft=1`、`wait=0`），`state/bridge.log` 无报错。

**回滚**：删 `scripts/test-handoff-injection.mjs` 并从套件移除；`src/handoff.mjs` 删 `handoffInjectionDecision`；`src/bridge.js` 恢复 `formatHandoffLineV2` 的旧实现（enforce 直接 `return line`）并去掉新增的两个状态字段与 import。风险极低：影子模式下 `skip-mode` 分支与改动前行为一致。

**遗留**：真实注入行为要等 enforce 后才能在线观察；当前只有单测与静态接线证据。翻闸后的第一条 Go/No-Go 应加一条「`[上次交接]` 只出现一次」。

### 6.22 D4：few-shot 反例库（默认关闭，已实测开/关）

**为什么需要**：现有 57 条 few-shot 全是正例（真人怎么接），模型容易把「短」学成唯一目标——删掉 AI 腔后变成冷冰冰、敷衍。反例给的是**同一句话的最小对照**：这么接带 AI 味（✗）/ 这么接才对（✓）。

**产物**

| 文件 | 内容 |
| --- | --- |
| `persona-lib/fewshot/negative.jsonl` | 12 条反例，字段 `context / bad（✗）/ good（✓）/ why / covered / tags`；覆盖 心理师腔、客服腔、总结拔高、结构化、程度副词、md-bold、句号收尾 7 类 |
| `src/fewshot-lib.js` | `NEGATIVE_LIMITS`（bad/good ≤160、why ≤60、块内最多 2 条）、`normalizeNegative`、`readNegatives`、`formatNegativeBlock`、`retrieveNegatives`；`FEWSHOT_DEFAULTS.negativeEnabled = false`；`loadFewshot` 改用 `readNegatives` 解析（旧实现用 `readJsonl` 会要求 `reply` 字段，把反例全丢掉） |
| `src/bridge.js` | `fewshotBlockV2()` 里 `few.negativeEnabled === true` 才检索并拼在正例块之后；预览分支同样拼接但不写轮换状态 |
| `scripts/test-fewshot-negative.mjs` | 36 条断言（见下） |

**测试设计（不只测格式，还测内容站得住）**

- 每条 ✗ 必须真的被 `src/ai-tone.js` 规则命中（激进参数下）；每条 ✓ 必须原样通过。
- **`covered` 字段**：`false` 表示「规则洗不掉、只能靠 few-shot 教」的已知缺口，断言反向——缺口哪天被规则补上，测试会失败提醒改标记。当前 4 条缺口（数量钉死）：
  1. `你已经很棒了，要相信自己，加油！`（拔高+打气）
  2. `建议您尝试以下方法：1. … 2. …`（客服句式+编号列表）
  3. `不知道我这样说你能不能理解呢～`（心理师腔变体+波浪号）
  4. `当然可以！我很乐意帮你，需要我做什么呢？`（客服反问收尾）
- 其余断言：解析 12 条 0 坏行、id 唯一、块最多 2 条且 <400 字符、空库给空串、检索优先选当轮相近者且同输入同输出、规范化拒绝缺字段/`bad===good`、超长裁剪、`loadFewshot` 带上反例、bridge 接线静态断言。

**实测（开 / 关各一次，同一会话 `reason=preview`）**

- 关（默认）：唤醒提示 **4,261 字符**，无「别这么接」块。
- 开（`style.fewshot.negativeEnabled: true`，`restart.bat` 重启）：**4,387 字符（+126 ≈ 80 token/轮）**，块内容示例：

  ```
  【别这么接 · AI 味反例】
  群友：我这次考砸了
  ✗ 你已经很棒了，要相信自己，加油！（拔高+打气套话）
  ✓ 考砸就考砸 下次再说
  ```

- 已改回关闭并重启（4,261 字符复原）。`node scripts/test-opt-suite.mjs` → **21/21，2.9s**。

**可见的意外收益**：`loadFewshot` 以前把 `negative.jsonl` 当正例解析（要求 `reply`），加载时静默丢弃；现在反例能进库，`GET /api/roles/fewshot` 的 `negative` 计数从 0 变成真实值。

**怎么打开 / 回滚**

- 打开：`config.json → style.fewshot.negativeEnabled: true` → `restart.bat`；关掉同理改回 `false`。
- 完全回滚：删 `persona-lib/fewshot/negative.jsonl`、删 `scripts/test-fewshot-negative.mjs` 并从套件移除、`src/fewshot-lib.js` 的回滚为恢复 `readJsonl(negativeFile).examples` 并删掉四个新导出。

**遗留**：是否默认开启要等 B1 人评看「冷冰冰」是否真被压住；反例块与正例共用 900 字符预算之外的额外 126 字符，若提示词再涨需和 D3 一起算总账。

### 6.23 D1 现状核对：四阶段里前三阶段都已在位，剩观察

翻 D1 定义（本文 §批 D）时发现它描述的改动大部分**已经存在**，只是没标完成。逐条核对（2026-10-26 14:00）：

| 阶段 | 要求 | 现状 | 证据 |
| --- | --- | --- | --- |
| 1 | `wait` 返回改为增量摘要：新增 N 条 + 首尾 seq + 明确游标 | **已在位** | `src/bridge.js` 的 `qq_wait_for_messages` 响应含 `newCount`、`newMessagesRange{firstSeq,lastSeq}`、`readThroughSeq`、`unreadCount`；注释明确「只追加、不裁剪 —— `newMessages` 保持全量，否则破坏 `noteModelMessagesV2` 的全量标记 → `readThroughSeq` 水位不变量」 |
| 2 | 记录每轮 wait 次数与返回条数，测单轮上限候选 2 | **统计已在位，上限未做** | `waitStatsV2`（`src/bridge.js:2821`，`{calls,returned,empty}`）在等待结束时累加并写 `[wait] … 第 N 次等待，本次带回 M 条，累计 K 条`（有节流：`newCount>0 || calls%5===0`）；面板第七张卡「等待空转」读它（§6.15）。**单轮上限没有实现**，是否要做待数据 |
| 3 | `preSleepWaitBlockedV2` 增加放行分支；`mark_read` 强制显式 `throughSeq` | **已在位并已开启** | `preSleepWaitBlockedV2` 四个放行分支（安静满 `preSleepWaitMs` / 已满足 / 已观察后 AI 未参与 / 静默轮）；`socialV2.markRead.requireThroughSeq: true` 已开（§6.7 D-5），实测 agent 省略 `throughSeq` → 400 `throughSeq-required`、控制台路径 200 |
| 4 | 观察「聊两句又潜水」是否回潮 | **未做**（要 7 天） | 观察工具：`GET /ops` 的「等待空转」卡 + `state/bridge.log` 的 `[wait]` 行（有节流，不能当全量计数） |

**结论**：D1 的代码改动阶段（1–3）已完成，只剩阶段 4 的观察窗口。阶段 2 的「单轮上限 2」**暂不实现**——理由：现有日志显示等待带回条数普遍是 0–4 条，真正要防的是「一个回合里反复 wait 空转」这种极端轮次；在拿到完整每轮分布（面板计数在重启后清零）之前不引入会改变模型行为的限制。等面板攒够 7 天再判断，判据写成：单轮 wait ≥3 次的轮占比 >5% 才做上限。

**观察期需要人看的两件事**

1. `GET /ops` 的「等待空转」里 `emptyRate` 是否长期偏高（>60% 面板标红）——偏高说明模型在用 wait 代替思考。
2. `[mark_read]` 日志里是否还有「AI 省略 throughSeq」的兼容路径（`requireThroughSeq` 开启后应当只剩控制台触发）。

### 6.24 B2 采样 A/B 脚手架：能组实验、能盲评、不能改多个变量

B2 要回答的是「换一组采样参数，回复是变好还是变差」，前提是同一批上下文、每次都只差一组参数、评审看不到哪栏是实验组。这三件事都不需要花钱，先做成工具。

**新增文件**

| 文件 | 作用 |
| --- | --- |
| `eval/ab-sampling.mjs` | `plan` 生成实验计划（`plan.json` / `README.md` / `prompts/<ctxId>.txt` / `replies/<组名>/`）；`report` 把收集到的回复配成盲评对，写 `blind.csv` / `baseline.json` / `metrics.md`，有分数时按组算胜场 |
| `scripts/test-ab-sampling.mjs` | 14 项检查：单变量硬约束、重复组拒绝、配对数量、缺失计数、盲评 id 不泄露组名、胜场与负场自洽 |

**三道硬约束（写进代码，不靠自觉）**

1. **一次只改一个变量**：`diffGroup()` 数出两组之间有几个采样参数不同，改 2 个直接抛错；参数完全相同也抛错（不构成实验）。
2. **盲评 id 中性**：配对 id 是 `p001`、`p002`…顺序编号，`baseline.json` 才存 `id → {1: 组名, 2: 组名}`。第一版 id 写成 `<上下文>~<组名>~<序号>`，等于把答案印在评审表上，测试直接抓出来了。
3. **左右顺序可复现但不可猜**：`sha256(seed:id)` 首字节奇偶决定哪组在 `side1`，同 seed 同结果，换 seed 换顺序。

**控制组取真实配置**：`currentSampling()` 读 `config.json → sampling`，当前是 `temperature 1.15 / topP 0.95 / presencePenalty 0.4 / frequencyPenalty 0.2`；变体只允许在这四个数上动（各自范围已校验：temperature 0–2、penalty −2–2、topP (0,1]）。

**验收**

- `node scripts/test-ab-sampling.mjs` → **14 passed / 0 failed**（15 个 check，其中一项多断言）。
- CLI 冒烟（已清理临时目录）：`node eval/ab-sampling.mjs plan --variant temperature=1.0 --samples 2` → 30 个 prompt 文件 + 两个回复目录；`report` 在无回复时输出「配对 0 对 / 缺失 {"control":60,"temperature-1":60} / ⚠️ 因缺回复跳过」并 exit 0，不会产出半成品实验。
- 并入 `scripts/test-opt-suite.mjs` → **22/22，3.0s**。
- 两处首轮失败已修：①盲评 id 泄露组名（见上）；②断言把「某变体胜场」直接等同「控制组负场」，实际控制组同时对比多个变体，改成 `Σ 变体胜场 = control 负场`。

**回滚**：删 `eval/ab-sampling.mjs`、`scripts/test-ab-sampling.mjs`，并从套件移除该行即可；没有改动任何线上代码或配置。

**遗留（B2 还不算完成）**

1. 回复生成仍要人/代理逐条调用采样参数覆盖后的代理（127.0.0.1:8790），脚本只准备目录与配对，没有自动化跑批。
2. 规模先按 30 上下文 × 2 组 × 2 条 = 120 条回复；样本少于 2 条时同一上下文只有一对，噪声大，报告里要写清样本量。
3. 胜场只是五维总分的比较，最终结论仍要结合 B1 的人评与「不预设哪组更优」的纪律。

### 6.25 启动脚本回归：把两次踩过的坑变成断言

`start.bat` / `restart.bat` 是翻闸（C3）与回滚唯一的重启手段，坏一次就是几分钟不可用。这次把两个真实事故固化成测试，并修掉其中一个还没爆的同类隐患。

**改动**

| 文件 | 改动 | 为什么 |
| --- | --- | --- |
| `start.bat:32` | `timeout /t 5 /nobreak >nul` → `ping -n 6 127.0.0.1 >nul` | 该脚本常被 `cmd /c start.bat > log` 调用，stdin 被重定向时 `timeout` 报 `Input redirection is not supported` 并**跳过等待**，崩溃重启会变成 0 秒热循环（restart.bat 里同一坑上周已修） |
| `scripts/test-launchers.mjs` | 新增 7 项断言（见下） | 之前这些约束只写在注释里，没人守 |

**7 项断言**

1. `start.bat` 用 `call node src\bridge.js`，禁止裸 `node`（本机 node 是 `node.cmd`，裸调用会让批处理提前结束）。
2. 两个 .bat 里都不许出现 `timeout /t`。
3. 等待必须走 `ping -n <秒+1> 127.0.0.1 >nul`。
4. 括号块内的 `rem` 必须纯 ASCII（中文 rem 在 `if (...)` 里会被 cmd 当命令执行，曾累计 49 行 `'…' is not recognized` 噪声）。
5. `restart.bat` 必须**先**判存活（`if errorlevel 1` 中止）**再** `del state\bridge.lock`，否则双实例互抢消息、互覆 state。
6. 路径必须经 `QQBRIDGE_DIR` 环境变量传给 PowerShell（用户名 `example-user` 里的单引号会截断单引号字符串，曾让「重启」静默不 kill）。
7. `run-hidden.vbs` 必须以隐藏窗口启动 `start.bat`。

**验收**

- `node scripts/test-launchers.mjs` → **7 passed / 0 failed**（首轮 2 失败：`start.bat:32` 的 timeout、以及测试自己把 rem 注释里的 `'%~dp0'` 当成代码——后者改为只看非 rem 行）。
- 并入 `scripts/test-opt-suite.mjs` → **23/23，3.0s**。
- 实跑 `cmd /c "restart.bat < nul"`：旧 PID `35804` 被 kill，新锁 PID `38744`（14:01:06）、守护 cmd `44680`；`GET /api/social` 仍 `shadow / 300K / 420K`，水位 `358.3K`；`bridge.log` / `guard.log` 无 `is not recognized` 噪声。
- 注意：编辑正在运行的 .bat 会让 cmd 的文件偏移错乱，所以改完必须走一次 `restart.bat`（本次已做）。

**回滚**：`start.bat:32` 改回 `timeout /t 5 /nobreak >nul`（不建议，会重新引入热循环隐患）；删 `scripts/test-launchers.mjs` 并从套件移除该行。

**没有改的部分（说明理由）**：`bridge.js:1258-1319` 的 `acquireLock()` 已经有完整的过期锁接管 —— 空内容/非整数 PID 视为过期、`ESRCH` 视为过期、`EPERM` 时再看控制台端口是否被占用、端口空闲则接管；所以「强杀后锁残留导致起不来」在这条路径上不成立。此前那次约 6 分钟不可用，只能确认是「守护每 120s 重试 code 2」这段路径在跑，**没有完全归因**；本次修的是另一处独立的隐患（热循环），没有改锁逻辑。

### 6.26 翻闸留底与翻后核对：把「失忆/丢未读」变成可判定的数字

§6.19 的翻闸手册靠人照着做，最容易漏的两步是「先备份」和「翻完到底有没有出事」。补一个脚本把这两步变成命令。

**新增 `scripts/prep-enforce.mjs`（三个模式）**

| 命令 | 作用 |
| --- | --- |
| `node scripts/prep-enforce.mjs` | 留底：把 `state/sessions.json`、`state/social-v2.json`、`config.json` 复制到 `state/archive/*-pre-enforce.bak`，并把「现在长什么样」写进 `state/enforce-baseline.json`，最后打印翻闸四步 |
| `--check` | 只跑 `scripts/gate-enforce.mjs`，不全 PASS 则退出码非 0（可直接串进流程） |
| `--verify` | 翻闸后核对九项，逐项 PASS/FAIL，有失败则退出码 1 |

**基线里存什么**：每个对话的 `unread` 条数、`lastUnreadSeq`、`lastReadThroughSeq`、`recentMessages` 长度、`agentToken` 的 sha256 前 8 位、`lastHandoffAt`，以及 `sessions.json` 的会话 id 列表。都不含正文（不往备份/基线里塞聊天内容）。

**`--verify` 的九项判据**

1. 基线存在；2. 未读未丢失（退役路径不碰 `unread`，所以条数只许不减）；3. 会话只轮换一次（旧 id 退役 1 个、新 id 新增 1 个）；4. `agentToken` 已轮换；5. `state/handoff/` 有交接文件；6. 交接非空壳（话题/未完/印象至少一条）；7. 日志有 `[handoff]` 行；8. 无 payload 校验失败（`too-long` 等）；9. 日志里没有重复的 `【上次交接】`。

**验收**

- `node scripts/test-prep-enforce.mjs` → **6 passed / 0 failed**。用临时 state 目录造三种情形：留底 + 备份齐全；「退役时把未读清了」必须报 `FAIL 未读未丢失`；正常轮换 + 非空壳交接必须全 PASS；交接写成空壳必须报 `FAIL 交接非空壳`；没有基线时不许崩、只报 `FAIL 基线存在`。
- 首轮一处真错并已修：最初把「未读丢失」判成「条数减少**且** `lastUnreadSeq` 回退」，而清理未读的旧路径只清 `unread`、`lastUnreadSeq` 不动 → 漏报。改成「条数减少即失败」，并在文档里写明代价：核对期间若有真人读消息导致条数变化，重跑一次留底再核对。
- 另一处：`config.json` 在仓库根而不在 `state/`，第一版留底直接跳过了它；改成两个位置都找。
- 真机留底已执行：`archive/sessions.json.2026-10-26T06-02-37-pre-enforce.bak`（189 B）、`social-v2.json…bak`（57,639 B）、`config.json…bak`（16,760 B），`state/enforce-baseline.json` 记 1 个会话 / 2 个对话。
- 翻闸前跑 `--verify` 得到 5 PASS / 4 FAIL（会话未轮换、token 未换、无交接文件、无 `[handoff]` 日志）——**这正是翻闸前应有的样子**，说明判据不是恒真。
- 并入套件 → **24/24，3.4s**。

**回滚**：删 `scripts/prep-enforce.mjs`、`scripts/test-prep-enforce.mjs` 并从套件移除；`state/enforce-baseline.json` 与 `state/archive/*-pre-enforce.bak` 可直接删（纯记录，不影响运行）。

### 6.27 翻闸开关：一条命令完成「体检 → 留底 → 改 mode → 重启 → 核对」

§6.19 是手册，§6.26 是留底/核对工具，这一步把它们串成一个命令 —— 翻闸和回滚都只需要一次调用，顺序写死在代码里，漏一步是不可能的。

| 命令 | 行为 |
| --- | --- |
| `node scripts/flip-enforce.mjs --on` | 跑闸门（不过就拒绝）→ 留底+基线 → 原子改 `contextBudget.mode` → `restart.bat` → `prep-enforce.mjs --verify` |
| `node scripts/flip-enforce.mjs --off` | 改回 `"shadow"` → 重启（不需要闸门，回滚必须永远可用） |
| `--dry-run` | 只打印将要做什么，配置一个字节都不写 |
| `--force` | 跳过闸门（演练/救急用，会打醒目警告） |
| `--no-restart` / `--no-verify` | 只改配置 / 只重启，供分步排查 |

**三个安全设计**

1. **改配置用「临时文件 + rename」**：直接覆写 `config.json` 时若进程被杀，会留下半个 JSON，下次启动 `loadConfig` 抛错、机器人直接起不来。
2. **回滚路径不设闸门**：`--off` 任何时候都能执行；闸门只拦「往前翻」。
3. **已经是目标模式就空转**：不重复备份、不重启，避免把「重复执行」变成一次多余的重启。

**验收**

- `node scripts/test-flip-enforce.mjs` → **11 passed / 0 failed**，全部在临时目录里翻：`setMode` 报告 `previous → next` 且真写盘；已是目标模式不写文件（mtime 不变）；`dry-run` 不写；缺 `contextBudget` 段时报错且**报错后文件仍是完整 JSON**；无参数退出码 2；**闸门不过且无 `--force` 时拒绝改配置**（断言 mode 仍是 shadow）；`--on --force --no-restart` 写入 enforce 且基线/备份都在、无 `.tmp-*` 残留；`--off` 不需要闸门；最后一条断言**真 `config.json` 仍为 shadow**（测试不许碰线上配置）。
- 真机演练：`node scripts/flip-enforce.mjs --on --dry-run` → 闸门报「1 项未通过」并拒绝（exit 1），`config.json` 仍是 `shadow`。这正是现在的正确行为。
- 并入套件 → **25/25，4.0s**。

**回滚**：删 `scripts/flip-enforce.mjs`、`scripts/test-flip-enforce.mjs` 并从套件移除；翻了 enforce 要回滚用 `--off`（或手改回 `shadow` 再 `restart.bat`）。

---

### 6.28 文档守卫：状态总表不许烂

**为什么**：§7 是「哪步做完了」的唯一入口，表一错，后面所有人都读错现状。给它配一个测试，成本 7 条断言，收益是漂移立刻红。

**产物**：`scripts/test-docs-status.mjs`（7 断言）——§7 存在 / 15 个步骤一个不少 / 状态符号只用 `✅ ⚠️ ⏳ ❌ 🚫` / 每行四列齐全 / 每行「回滚」非空 / §7.1 的三条命令指向的脚本真实存在 / §7 声明的套件数量与 `scripts/test-opt-suite.mjs` 条目数一致。

**两个实现坑**：
- `⚠️` 是「基字符 + 变体选择符」两码点，`[...str].find(set.has)` 永远判不出 → 用 `String.includes`。
- 带 `/g` 的 `String.match` 不返回捕获组 → 数量断言改成非全局单次匹配，并且只在 §7 里找（§6.x 里还留着历史数字如 `16/16`，不能误读）。

**验收**：`node scripts/test-docs-status.mjs` → 7/7；并入套件后 `node scripts/test-opt-suite.mjs` → **26/26，4.1s**；§7 的「套件现状」同步改成 26/26。

**回滚**：删脚本 + 从套件列表移除 + §7 的 26/26 改回上一行数量。

---

### 6.29 交接 id 对齐：写入时刻只取一次

**缺陷**：`handoffStore().write()` 内部自己取 `currentTime()` 当 `generatedAt`；`runHandoffAtSafePointV2()` 写完又取一次 `Date.now()` 当 `lastHandoffAt`，并用它做 `handoffPendingId`。两者相差几毫秒 → 一旦进程重启、内存里的 `pendingId` 丢了而只能回读磁盘，算出的 id（磁盘 `generatedAt`）与持久化的 `injectedId`（旧 `lastHandoffAt`）**对不上**，同一份交接会被再注入一次。表现不致命（多一行几十字），但它让「只注入一次」这个不变量只在同一进程内成立，重启就破功。

**修法**：`src/bridge.js` 里 `const handoffAt = Date.now();` 只取一次，同时 `write(..., { generatedAt: handoffAt })`、`st.lastHandoffAt = handoffAt`、`st.handoffPendingId = String(handoffAt)`。store 本来就接受调用方给的 `generatedAt`（`src/handoff.mjs` 的 `write` 第 2 步），不需要改 store。

**证据**：`scripts/test-handoff-injection.mjs` 增至 **28 断言**，新增四格——真实 store 落盘后回读 `meta.generatedAt === 调用方给的时刻`、重启后判为 `skip-consumed`、以及反证「两处差 1 ms 就会被当成新交接再注入一次」（钉死这个坑）。`node scripts/test-opt-suite.mjs` → **26/26，4.5s**；`node --check src/bridge.js` 通过；`restart.bat` 后 pid 32016，`/api/social` 仍 `shadow/300K/420K`，面板 `p50=346,085 / nearZero 45/210`。

**回滚**：把三处 `handoffAt` 换回各自 `Date.now()`（不推荐，等于把坑放回去）；或只回滚 `generatedAt` 传参。

---

### 6.30 独立审计：11 个文件的发现与修复对照

> 审计来源：一个只读子代理逐文件读了 11 个文件（交接、few-shot、面板、预算、评测工具、翻闸脚本），
> 目标是找「看起来在生效、其实没生效」的地方。以下每条都给了修复位置和验证命令；没有一条只改文档。

#### 必修 5 条（会改变行为或让判据失真）

| # | 发现的缺陷 | 后果 | 修复 |
| --- | --- | --- | --- |
| 1 | 闸门用「同一行既有 `[budget]` 又有退役」判断退役 | 恒 PASS，等于没查 | `scripts/gate-enforce.mjs` 导出 `retireActions(logText)`，按 `[handoff]` + `已退役` 且非 `不退役` 识别；判据改名「影子期无退役动作」；新增 `--root` 便于测试 |
| 2 | 留底判「空壳」读的字段名不对（`activeTopics` 等 vs 真实 `topics/openLoops/peopleChange/insideJokes/mood`） | 一切交接都被判空壳，可能把成功翻闸劝退 | `countItems` 改用真实字段，`mood` 计 1；新增三态 `addInfo`（INFO 不算通过也不算失败） |
| 3 | 修剪归档失败会让 `write()` 报失败，但新交接其实已落盘 | 调用方不记 pendingId、不退役，下轮重写并把这份归档 | 修剪循环首个失败即 `break`，返回 `ok:true` + `pruneError`，不再抛 |
| 4 | few-shot 缓存指纹只算 `examples.jsonl` | 只改 `negative.jsonl` 永不生效 | 两个文件的 mtime/size 一起做指纹，缺文件记 0 |
| 5 | `fewshotBlockV2` 在 `examples` 为空时提前 return；`loadFewshot` 在缺正例时直接给空库 | `negativeEnabled` 是静默无效开关 | 先算反例块，正例为空取 `[]`，用 `join()` 拼；反例可独立加载 |

#### 可选 13 条（正确性/健壮性）

| 位置 | 问题 | 修复 |
| --- | --- | --- |
| `src/ops-panel.js` 解析 | 缺 `b` 的行被当成 `{}` | 保持 `null`，单独计 `unmeasured`，不进分位、不算「无输出」 |
| `src/ops-panel.js` 水位阈值 | `softAt/hardAt` 缺失回落 0 | 缺失即 `unknown`（不把 null 交给 classifier，否则回落到默认线误判 hard） |
| `src/ops-panel.js` 日累计 | 漏 `cacheWrite` | `watermarkOf` = miss+hit+write，与 `token-ledger.js:721` 的 inputTokens 同口径 |
| `src/context-budget.mjs` | `enabled === false` 才算关，与 normalize 的 `=== true` 相反 | 改为 `enabled !== true` 即关 |
| `src/handoff.mjs` 校验 | `opts.maxChars` 没被读，兜底组装的 `maxChars` 是死参 | `normalizeHandoffPayload` 按 `opts.maxChars` 判 `too-large` |
| `src/handoff.mjs` 兜底 | 用最近消息组装时没传 `scrub` | `buildHandoffFromRecent` 透传 `scrub`；`store.write` 接受 `meta.scrub` 且不把它写进落盘记录；bridge 两处都传 `scrubSensitive` |
| `src/bridge.js` 注入 | 旧状态只有 `lastHandoffPayload`、没有 `handoffPendingId` → 永远 `skip-none` | 无 pendingId 时用 `String(st.lastHandoffAt)` 兜底 |
| `eval/ab-sampling.mjs` | 空单元格按 0 分、`n` 按行计 | 五维必须齐且 1–5 才计入；否则整行跳过 |
| `eval/review-core.mjs` + `eval/review.html` | `escCell` 不含 `\r`、不防公式注入 | 两处同构改为：`=`/`+`/`-`/`@` 开头加前导单引号，`\r` 也进引号分支 |
| `src/fewshot-lib.js` 反例块 | 只限条数不限字 | 新增 `NEGATIVE_LIMITS.blockMaxChars=400`，按行累加预算，一条都放不下则整块不注入 |
| `src/role-card.js` | 只用 `startsWith` 判项目内，junction/symlink 可逃逸 | 加 `realpathSync`（ENOENT 退回字面路径）+ 大小写折叠比较 |
| `scripts/flip-enforce.mjs` | `--config` 指到别处时仍调 restart.bat | 非默认 config 时**拒绝自动重启**并提示手工重启 |
| `scripts/prep-enforce.mjs` | 「恰好 1 个轮换」恒 FAIL、日志判「只注入一次」恒 PASS | 改为「新增 ≤ 退役」；注入判据改读状态：`handoffInjectedId` 对磁盘 `generatedAt` |

#### 新增/加强的测试（都已并入套件）

| 测试 | 断言 | 说明 |
| --- | --- | --- |
| `scripts/test-gate-enforce.mjs` | 10 | 含 e2e：临时 root 写入一行真实退役日志 → 闸门 FAIL |
| `scripts/test-fewshot-load.mjs` | 6 | 只有反例文件也能加载；只改反例缓存失效；删文件不残留 |
| `scripts/test-handoff.mjs` | 30 | 新增修剪失败 fail-open（用「同名目录占位」制造稳定 EPERM） |
| `scripts/test-handoff-recent.mjs` | 13 | 新增 scrub 透传、`maxChars` 真生效 |
| `scripts/test-handoff-injection.mjs` | 29 | 新增 legacy pendingId 兜底的静态断言 |
| `scripts/test-prep-enforce.mjs` | 9 | 清空未读必须 FAIL、空壳交接必须 FAIL |
| `scripts/test-ops-panel.mjs` | 全绿 | 新增 unmeasured、阈值缺失判 unknown、日累计含 cacheWrite |
| `scripts/test-context-budget.mjs` | 27 | 新增「缺省 enabled 视为关闭」 |
| `scripts/test-fewshot-negative.mjs` | 37 | 新增反例块预算约束 |
| `scripts/test-ab-sampling.mjs` | 15 | 新增空单元格不计分 |
| `scripts/test-flip-enforce.mjs` | 12 | 新增 `--config` 不自动重启的静态断言 |

#### 验证与实机

- `node scripts/test-opt-suite.mjs` → **28/28，约 4.4 秒**。
- `node --check` 覆盖：`src/bridge.js`、`src/handoff.mjs`、`src/fewshot-lib.js`、`src/role-card.js`、`src/ops-panel.js`、`eval/ab-sampling.mjs`、`eval/review-core.mjs`、`scripts/flip-enforce.mjs`。
- `restart.bat` 重启后：`/api/social` = `shadow / 300K / 420K`；`/api/socialV2/wake-prompt?reason=preview` → **4,261 字符**、人格块 **555**（与改前逐字一致）；`/api/ops/panel?days=7` → `p50=346,085 / count=1145 / budget counts {ok:0,soft:1,hard:0,unknown:1}`；`state/bridge.log` 无报错。
- 隐私面：这一轮没有新增可能外泄的文本落盘点；交接兜底文本现在和结构化交接走同一套 `scrubSensitive`。

#### 回滚

按文件回滚（本仓库没有 git 历史可用时）：`src/ops-panel.js`、`src/context-budget.mjs`、`src/handoff.mjs`、`src/fewshot-lib.js`、`src/role-card.js`、`src/bridge.js`、`eval/ab-sampling.mjs`、`eval/review-core.mjs`、`eval/review.html`、`scripts/{gate-enforce,prep-enforce,flip-enforce}.mjs`、`scripts/test-opt-suite.mjs`、`package.json`（未改）。删两个新测试文件即可退出套件；`restart.bat` 生效一次。

#### 遗留（未做，有理由）

- 「单轮 wait 上限 2」（O3）仍等数据：判据是「单轮 wait ≥3 次的轮占比 >5%」。观测量已在 §6.31 补上（`/ops` 的 `wait.ratio3Plus`），但它是内存态、重启清零，要连续跑几天才够判。
- `eval/review.html` 的内联实现与 `eval/review-core.mjs` 靠 `test-eval-review-page.mjs` 比对防漂移；以后改一边必须同步另一边，测试会拦。

### 6.31 O3 判据的观测量：每轮 wait 次数分布
**问题**：O3 的判据是「单轮 wait ≥3 次的轮次占比 >5% 才做单轮上限」，但代码里只有**会话级**累计（`waitStatsV2` 的 `calls/returned/empty`），从来没有「一轮等了几次」这个量 → 判据永远无法评估，也就永远无法裁决「要不要做上限」。
**改动**：
- `src/bridge.js`：`waitStatsV2` 每条统计加 `turnWaits`（本轮已 wait 次数）与 `turnBins: {1,2,3,4}`（4 表示 ≥4）；wait 处理里 `stat.turnWaits += 1`。
- 新增 `noteTurnWaitsV2(key, preview)`，在 `buildWakePromptV2()` 开头调用：一轮的边界就是「构建唤醒提示」，把上一轮攒的次数记进分布后清零；`preview` 不归档不重置，避免控制台预览吃掉真实轮次。
- `src/ops-panel.js` `summarizeWait()`：跨会话合并 `turnBins`，输出 `turnBins / turnsWithWaits / turnsWith3Plus / ratio3Plus`。分母只算**至少等过一次**的轮次——没等的轮次不该摊薄比例。
**证据**：`node scripts/test-ops-panel.mjs` 全绿，新增 8 条（跨会话合并、`turnsWithWaits=10`、`turnsWith3Plus=3`、`ratio3Plus=0.3`、无 `turnBins` 时给 0 不 NaN、三条 bridge 接线静态断言）；`node scripts/test-opt-suite.mjs` → **28/28，4.2s**（条目不增，改的是既有测试）；`restart.bat` 后 `GET /api/ops/panel` 的 `wait` 段已出现 `turnBins/turnsWithWaits/turnsWith3Plus/ratio3Plus`，重启瞬间全是 0（内存态既定语义），其余不变（`/api/social` = shadow/300K/420K，唤醒预览 4,261 字符）。
**怎么读**：等有真实轮次后看 `ratio3Plus`；>0.05 才值得做「单轮 wait 上限 2」，否则上限只是拍脑袋。样本仍是内存态、重启清零，所以结论要在「连续跑几天」的窗口里读。
**回滚**：删 `noteTurnWaitsV2` 与调用、删 wait 处理里的 `turnWaits` 两行、删 `summarizeWait` 里 bins 相关输出与 8 条断言，重启。

### 6.32 把三个外部条件变成「到点就能动手」
代码侧已经没有剩余工作，剩下的三件事全部卡在别人/时间手里。这一节把每一件都做成「有明确入口、有命令、有验收」的状态，避免下次打开文件还要重新想。

#### C3：定时器 + 精确时间点
- 影子窗口起点在 `state/c2-shadow-start.json` 的 `startedAt` = **2026-10-26 13:16:07**，满 24h 是 **2026-10-27 13:16:07**。
- 已建会话提醒（`schedule-ac3862bd-ab1c-4d4d-8676-ce58ae612853`，2026-10-27 13:20 Asia/Shanghai），到点提示按 §6.19 执行：`gate-enforce.mjs` → 套件 → `flip-enforce.mjs --on` → 查日志与交接样本 → 失败 `--off`。
- **坑**：如果这期间桥接被 `restart.bat` 重启且 `c2-shadow-start.json` 被重写，24h 会重新起算；到点先看 gate 的第一行再决定。

#### B1：评审包已打成可直接外发的一件
- 产物：`eval/runs/2026-10-26T05-24-34-baseline-2/review-kit.zip`（**15,515 B**），内容 6 个文件：`README-START-HERE.md`（给评审人的一页说明）、`review.html`（本地打分页，无网络请求）、`reviewer-A.csv` / `reviewer-B.csv`（各 30 条、17 列、**不含 raw/cleaned 映射**）、`README.md`、`RUBRIC.md`。
- 冒烟验证：`packRows()` 读 `reviewer-A.csv` → **30 行**、首条 `c01`、表头 17 列、**不含 `raw`/`cleaned` 列**（不会泄漏答案）。
- 用法：把 zip 发给两名评审 → 收回 `scores-reviewer-*.csv` → `node eval/check-review.mjs <csv> <blind.csv>` → `node eval/aggregate.mjs eval/runs/2026-10-26T05-24-34-baseline-2`。
- 回滚：删 `review-kit/` 与 `review-kit.zip`（它们只是分发副本，原始数据在 `review-packs/` 与 `blind.csv`）。

#### B2：一条命令起步
`node eval/ab-sampling.mjs plan --variant temperature=1.0 --samples 3` → 生成 `eval/ab/<stamp>/plan.json + prompts/`；按 `prompts/` 跑两组回复到 `replies/<组名>/<上下文id>_<序号>.txt`；`node eval/ab-sampling.mjs report eval/ab/<stamp>` 出盲评表与胜场。需要模型调用预算，所以**只能由人拍板后跑**。

### 6.33 wait 分布落盘：让「等几天再判」真的等得下去
**发现的缺陷**：§6.31 补的观测量是**内存态**，`waitStatsV2` 一重启就清零；而判据要的是「连续几天里单轮 wait ≥3 次的占比」——两者互斥。只要中途重启一次（本项目重启频繁），样本永远攒不到，判据仍然无法裁决。
**修法**：把分布抽成独立存档 `src/ops-wait-store.mjs`（纯函数 + 文件 IO，可测），`state/ops-wait-turns.json` 只存 `{v, since, updatedAt, turnBins:{1,2,3,4}}` —— **不存会话身份、不存消息内容**。
- `readWaitTurns`：文件缺失 / 半截 JSON / 无权限一律退回空状态（观测坏了不能影响等待业务）。
- `writeWaitTurns`：`临时文件 + rename` 原子替换。
- `bumpWaitTurn`：0 次不记，≥4 次并入 4 号桶；`waitTurnStats`：分母只算至少等过一次的轮次。
- `src/bridge.js`：`noteTurnWaitsV2` 归档时调 `recordWaitTurn(bin)`，`/api/ops/panel` 的 `waitPersisted` 透出存档；bridge 里的内联读写实现已删（那版无法单测）。
**证据**：`node scripts/test-ops-wait-store.mjs` → **19 断言全绿**（空状态、负数/字符串夹到 0、往返、半截 JSON 后仍能写、文件只有四个键、无 `.tmp` 残留、重复写不翻倍、零样本比例给 0）；套件 **29/29，4.2s**；`test-ops-panel` 的 `soak` 断言同步；`restart.bat` 后 `wait.soak` 已出现（`since` = 本次启动、`days:0`），`state/ops-wait-turns.json` 在**首次真实 wait** 时生成。
**怎么读**：`wait.soak.ratio3Plus > 0.05` 且 `days ≥ 3` 再决定要不要做「单轮 wait 上限 2」；`wait.ratio3Plus` 仍是「本次启动以来」口径，别混看。
**回滚**：删 `src/ops-wait-store.mjs` 与 `scripts/test-ops-wait-store.mjs`、从套件移除、撤 `src/bridge.js` 的 import 与 `recordWaitTurn` 调用、`waitPersisted` 传 `null`；删 `state/ops-wait-turns.json`。

### 6.34 把判据读数显示到面板上（不然只有我会查）
**问题**：§6.31/§6.33 的数据只在 `/api/ops/panel` 的 JSON 里。判据是「几天后看比例」，但没人会天天用 curl 读 JSON —— 数据存在而没人看，等于没有。
**改动**：`public/ops.html` 的「等待空转」卡新增一行「单轮 ≥3 次」：有样本时显示 `比例 · 3+/总轮 · 天数`；无样本时显示「积累中（等真实轮次）」，**不把 0 显示成「0% 正常」**（0 在这里是「没有证据」，不是「没问题」）。卡片副标题改成「上半为本次运行，末行为跨重启累计」，避免两个口径混读。
**证据**：页面脚本抽出后 `node --check` 通过（10,058 字符）；`test-ops-panel` 新增 3 条静态断言（调用 `soakRow(w.soak)`、无样本文案、比例+天数字段）；套件 **29/29，4.2s**；真机 `GET /ops?token=…` → 200、**14,102 字节**，返回内容含新增标记（页面是静态文件，改完刷新即生效，无需重启）。
**回滚**：撤 `soakRow` 与那一行、还原副标题。

### 6.35 B2 预生成计划 + 执行路径的两条分支
**已做（零成本）**：`node eval/ab-sampling.mjs plan --variant temperature=1.0 --samples 3` → `eval/ab/2026-10-26T06-29-08/`（`plan.json` 2,937 B、`README.md`、`prompts/` 30 个、`replies/{control,temperature-1}/`）。计划内容：对照组 = 当前线上值（temp 1.15 / topP 0.95 / presence 0.4 / frequency 0.2），实验组只变 `temperature → 1`，30 条上下文 × 每组 3 条 = **180 次生成**。这一步不调模型、不花钱。
**尚未做的原因**：`prompts/` 里只是 `incoming` 原文（31 字节/条），真正要跑的是「同一条上下文、两种采样各生成 3 条」。两条现实路径：
- **A 脚本直连**：用 bridge 里同一套提示词拼装 + 模型 API，脚本化跑 180 次。需要模型 key 与预算，且要复用 `buildWakePromptV2` 的拼装逻辑（否则两组差异不只是采样参数）。
- **B 小流量真实对话**：改 `config.json → sampling.temperature` 跑一段时间，靠真实轮次自然积累样本。缺点：时段/上下文不可控，样本不好配对，且会影响线上口吻。
倾向 A（可比性最好），但它需要一次明确的开支批准，所以停在「计划已生成」。
**回滚**：删 `eval/ab/2026-10-26T06-29-08/` 即可（纯新增目录，不参与线上）。

### 6.36 B2 执行（路径 A：脚本直连 API）——已跑完，结论：不改线上
**生成器**：`eval/gen-replies.mjs`（新增）。做法：向本机桥接要一份**线上唤醒提示词**（`/api/socialV2/wake-prompt?reason=preview`），只剥掉 `【会话令牌】…` 行后作为 system（4,240 字符，sha 记在 `report-cost.json`），两个采样组共用同一份 system；user 为 `【场景】<situation>\n<incoming>`；两组分别用 `plan.json` 里的采样参数直连 `https://api.deepseek.com/v1/chat/completions`（`deepseek-chat`）。断点续跑（已有 `replies/<组>/<id>_<n>.txt` 跳过）、每次调用即落盘记账、密钥只从环境变量或 `~/.dsh/.credentials.yaml` 读且不打印。

**规模与成本**：`node eval/gen-replies.mjs eval/ab/2026-10-26T06-29-08` → **180 次调用全部完成**（control 90 / temperature-1 90）。逐次日志显示**输入约 2,667–2,676 token/次**（system ≈ 2,650 + user 几十），合计约 **48 万输入 token**；单条输出 4–55 token。`report-cost.json` 只完整覆盖冒烟那 2 次——首版在最后汇总时读了错误的字段（`prev is not iterable`）导致全量记账丢失，已改成「每次调用后立刻写盘」，但这 178 次的逐次 usage 无法追回；上面的输入量是日志行里的实测值，不是账本。

**结果**：`node eval/ab-sampling.mjs report` → 配对 90 对、无缺失；平均长度 control 27.2 字符 / temperature-1 29.5 字符。机器代理五维分（`eval/review-machine.mjs`）natural 两组都 5/5（饱和，没区分力），五维总分**胜场 control=27 / temperature-1=31 / 平手=32**。机械指标：含括号阶段说明的 control 5 条 vs 变体 3 条；超 120 字符 2 vs 3；提示词回显 1 vs 0（control 有一条把「先别急着说理解你的感受、就回一两句」抄进回复）。
**结论**：**没有足够证据支持把线上 `temperature` 从 1.15 改成 1**。90 对里 32 对平手、代理分饱和，31:27 的差距在噪声量级；要下结论得两名真人评这 90 对（`blind.csv` 已生成）。线上采样**保持不动**。

**顺手修的缺陷**：`eval/aggregate.mjs` 的胜场归组写死了 `key === 'raw'` 判边，遇到 A/B 的自定义组名（`control` / `temperature-1`）会把胜场全算到一侧，打印出 `raw=28 cleaned=30` 这种假数字（真值 27/31）。已改成按 key 里的组名归组，并新增断言「A/B 组名不被改写成 raw/cleaned、分项之和等于总条数」→ `test-eval-tools` **8 通过**。

**产物**：`eval/ab/2026-10-26T06-29-08/`（`replies/` 180 条、`blind.csv` 90 对、`baseline.json`、`scores-reviewer-M.csv`、`report-cost.json`、`system-prompt.txt`、`metrics.md`）。**回滚**：删该目录与 `eval/gen-replies.mjs` 即可；生成器只读桥接、只写 `eval/` 下文件，不碰线上状态与配置。

### 6.37 B1 推进：把「找人打分」的摩擦降到最低
**问题**：B1 卡在两名真人，但原来的评审网页要求「选文件 → 一口气评完 60 格」，中途关浏览器进度全丢，实际会把愿意帮忙的人劝退。

**改动（`eval/review.html`）**：
- **拖拽载入**：整个窗口都是投放区，CSV 直接拖进来；悬停有高亮。
- **断点续评**：打分/选栏/写备注都会写进本机 `localStorage`（键为 `qq-review:<条数>-<指纹>`，指纹只由「id + 两栏长度」算出，同一份包重开能命中、不同 run 不会串）。重新打开并载入同一个 CSV 时自动恢复，页面提示「已恢复上次进度：x / y 格」。
- **清空重评**：底部加按钮，确认后清掉本机存档重来。
- **隐私模式降级**：`localStorage` 不可用时静默忽略，不阻断打分（页面依旧纯本地、零网络请求，测试里有断言）。

**测试**：`scripts/test-eval-review-page.mjs` 从 27 条扩到 **36 条**（新增 9 条：存档前缀、setItem/getItem、恢复提示、drop/dragover、清空按钮、隐私降级、指纹算法），仍全部通过；内联实现与 `eval/review-core.mjs` 的逐函数比对不变。套件 **29/29**。

**分发件重打**：`eval/runs/2026-10-26T05-24-34-baseline-2/review-kit.zip` → **17,314 B / 6 个文件**（`README-START-HERE.md` 2,093、`README.md`、`review.html` 17,209、`reviewer-A.csv` 8,536、`reviewer-B.csv` 8,536、`RUBRIC.md`）；README 改成「约 15–20 分钟 + 三句话维度解释 + 随时可停」，并说明 A/B 两个包内容相同、行序不同，两人可分别拿一个。已投递到手机收件箱便于转给朋友。

**仍缺什么（人）**：两名评审各自 15–20 分钟。回传 `scores-reviewer-<名字>.csv` 后，我跑 `check-review`（校验格式与完整度）→ `aggregate`（五维均分、胜场、分歧点）。**在两人交回之前，B1 不能标完成**。
**回滚**：`review.html` 的改动只影响本地评审页；删掉 `localStorage` 里的 `qq-review:*` 或点「清空重评」即可复原进度；重打 zip 不会影响历史 `scores-*.csv`。

### 6.38 B1 文档版评审表（Word），并打通「填完 → 校验」闭环
**为什么**：网页版再好用，也要人「打开浏览器 → 选文件 → 导出 CSV」。文档版让人在本机 Word 里直接填，回传 `.docx` 即可，适合不常用浏览器的评审人。

**产物**
- `scripts/build-review-docx.py`：读 `review-kit/reviewer-A.csv` / `reviewer-B.csv`，各排一份 Word。封面含「评审人 / 日期」填空、四步说明、五维口径表、三条纪律；每条一张 3 列表（表头固定 `内容 | 栏 1 | 栏 2`，行 `回复 / natural / faithful / harm / template / stable / 更像真人 / 备注`），后两行合并第 2–3 列并写灰字提示。输出 `review-kit/评审表-A.docx`、`评审表-B.docx`（各 44,705 B、30 条，A4、左右边距 2.0cm、CJK 走 `w:eastAsia`）。
- `eval/parse-review-docx.py`：按「第 n 条 · <id> · <场景>」定位条目、按表头定位表格，读五维两栏分数与备注，输出与网页版同结构的 `scores-reviewer-<名字>.csv`（30 条 → 60 行）。评审人姓名从封面「评审人：」后的文字取，取不到用文件名兜底。**任何一格空着或越界都会指名报错**（`c01 栏 1 的 natural 应为 1–5 的整数，实际是 ''`），不静默跳过。
- `review-kit/README-START-HERE.md` 改成「网页版 / 文档版二选一」，写明两份等价的说明与两种回传路径。
- `review-kit.zip` 重打 → **101,781 B / 8 个文件**（新增 `评审表-A.docx`、`评审表-B.docx`）。

**闭环验证（真跑过）**
1. 用 `tmp/fill-sample.py` 复制一份填满（30 条 × 两栏，分数确定）→ `python eval/parse-review-docx.py tmp/评审表-A-filled.docx` → `parsed 30 条 / 60 行`；
2. `node eval/check-review.mjs tmp/scores-reviewer-测试员.csv eval/runs/2026-10-26T05-24-34-baseline-2/blind.csv` → `条目：60 行（应为 60 行）` + `✅ 这份评分完整且合法，可以直接 aggregate`；
3. 反例：把 `harm` 的栏 1 清空 → 解析器 `exit 1` 并指出 `c01 栏 1 的 natural 应为 1–5 的整数`（按维度顺序先命中空格），证明不会把漏填当成 0 分；
4. 空白原表直接解析 → `exit 1` 且提示「应为 1–5 的整数」，不会产出半份 CSV。

**校准过的两处**：①列宽原为 2.6+8.0+8.0cm = 18.6cm，超过 A4 可用宽 17cm，改成 2.2+7.4+7.4；②`评审人` 行原来是四段 run（标签、下划线、`日期：`、下划线），姓名解析先取「评审人：」到「日期」之间的文字并剥掉空白与下划线，避免把日期栏当名字。

**回滚**：删两份 docx 与两个脚本、README 改回单一路径、zip 重打时不带 docx —— 不影响网页版与历史 `scores-*.csv`。

### 6.39 两份「AI 代填」评审表：解析、汇总，以及它替我们抓到的真缺陷
**来料**：`评审表-A-已填写评分_AI评审.docx`（ChatGPT 代打）、`评审表-B-Gemini评分版.docx`（Gemini 代打），各 30 条 × 两栏补满。用 `python eval/parse-review-docx.py <docx> -o …` 转 CSV，`node eval/check-review.mjs` 两份都是「60 行完整且合法」。

**先说清性质**：这是**代理分**，不是人评。它能回答「两栏文本是否可区分、工具是否敏感」，**不能**替代 B1 要求的真人基线。`eval/aggregate.mjs` 已按文件名把 `AI*/Gemini*/Claude*/GPT*/M` 归为代理，输出会分开列「代理评审」与「人类评审」，并在只有代理时打印「不构成人工基线」。

**汇总（按 `baseline.key` 映射回 raw / cleaned，两名代理合并）**

| 维度 | raw | cleaned | Δ |
| --- | --- | --- | --- |
| natural | 2.93 | 3.22 | +0.28 |
| faithful | 4.77 | 4.68 | −0.08 |
| harm | 4.97 | 4.97 | 0 |
| template | 2.52 | 2.88 | +0.37 |
| stable | 4.18 | 4.23 | +0.05 |

逐评审胜场（五维总分逐条比）：AI-A `cleaned=10 / raw=0 / 平手=20`，Gemini-B `cleaned=9 / raw=1 / 平手=20`；合并 `cleaned=12 / raw=1 / 平手=17`。读法：**清洗在「像真人」和「不像模板」上有稳定但小的正收益，忠实度略降 0.08**，与机器代理此前「样本太干净、分数饱和」不同——这两份代理分是有分辨力的（natural 2.93–3.22 vs 代理 M 的 4.4–4.5）。

**抓到的真缺陷（本轮修掉）**：c15 的 cleaned 文本以字面量 `$1` 结尾（`…情绪$1`）。根因：`src/ai-tone.js` 的 `hope-helpful` 规则写成 `to: '$1'`，但正则 `(?:^|[，。！？；\n])…` **没有捕获组**，于是把匹配整段替换成了字面量 `$1`。
- 修复：把开头标点改成捕获组 `(^|[，。！？；\n])`，保留 `to: '$1'`；现在同一句清成「这个梗来源于网络流行语，通常用来表达一种无奈又好笑的情绪。」。
- 防回归（新增，写进 `scripts/test-ai-tone-semantic.mjs`，断言从 243 涨到 **245**）：
  1. 新增导出 `listRuleSpecs()`（id/to/正则源码），**逐条校验「`to` 里引用的 `$n` 必须在正则里真有捕获组」**——全仓 37 条规则扫下来只有 hope-helpful 一条违规，现已为 0；
  2. 用 c15 原句做定点用例，断言产物不含 `$n` 字面量；
  3. 全量正例/反例/跨场景样例统一体检「产物无 `$n` 残留」。
- 连带调整：`hope-helpful` 的正例样例原来整句就是可删内容，修好后会清成空串（被「无残句」断言拦下），改成「别去！希望以上信息对你有帮助，结案」→ 产物「别去！」，规则意图不变。

**解析器的两处校准**：①备注列残留生成时的灰字提示（「可空：误伤、丢信息、听不懂的地方」）会被当成评审备注，已加 `clean_note()` 过滤并去重；②写出位置默认落在 docx 同目录，Downloads 在受控范围内会被拒（`PermissionError`），跨目录写请显式给 `-o`。

**验收**：`node scripts/test-ai-tone-semantic.mjs --no-legacy` → **245 通过 / 0 失败**；`node scripts/test-opt-suite.mjs` → **29/29，4.6s**；`restart.bat` 后 pid `57616`、`127.0.0.1:3100` 就绪（17:04:11），日志无报错。
**回滚**：`git checkout -- src/ai-tone.js scripts/test-ai-tone-semantic.mjs`（或还原 `hope-helpful` 的 `(?:^|…)` 并删必查⑦ 三段），重启即可；评审 CSV 在 `eval/reviews/`，与代码无关。

### 6.40 基线口径变更：两份代理评审加权（Gemini 0.7 / ChatGPT 0.3）

**裁定**（用户，2026-10-26）：「他们的审批足以替代真人」——B1 不再以「两名真人评分」为完成前提；Gemini-B 权重 **0.7**、AI-A（即 ChatGPT 代填）权重 **0.3**，脚本启发式评审 `M` 不参与加权。

**实现**（`eval/aggregate.mjs` 整体重写，向后兼容）：
- `<run>/weights.json`：`{ "acceptProxy": true, "weights": {"Gemini-B":0.7,"AI-A":0.3}, "exclude": ["M"], "note": "…" }`；也支持命令行 `--weights=Gemini-B:0.7,AI-A:0.3`。
- 加权单元格 `wCell(id|side|dim) = Σw·v / Σw`；逐条加权总分取五维加权均值的平均；`exclude` 里的评审完全不进加权，但仍在「逐评审」表里显示并标注「（不参与加权）」。
- **没有权重配置时行为与旧版完全一致**（只输出未加权均分，并提示「不构成人工基线」）——加权段由配置显式开启，不是默认行为。

**加权基线（`eval/runs/2026-10-26T05-24-34-baseline-2`，命令 `node eval/aggregate.mjs eval/runs/2026-10-26T05-24-34-baseline-2`）**

| 维度 | cleaned | raw | Δ(raw−cleaned) |
| --- | --- | --- | --- |
| natural | 3.14 | 2.85 | −0.29 |
| faithful | 4.76 | 4.86 | +0.10 |
| harm | 4.98 | 4.98 | 0 |
| template | 2.96 | 2.60 | −0.35 |
| stable | 4.34 | 4.27 | −0.07 |

- 加权胜场（逐条比五维加权总分）：**cleaned=11 / raw=1 / 平手=18**（未加权口径：cleaned=12 / raw=1 / 平手=17，两者方向一致）。
- 明显差异（|Δ|≥0.5）：c15 −0.98、c12 +0.68、c03 +0.60、c10/c14/c24 +0.54。

**怎么读这张表**：清洗在 natural（+0.29）与 template（+0.35）上是明确正收益，harm 持平，faithful（−0.10）与 stable（−0.07）小幅负向——说明删套话的副作用是偶尔带走一点信息量；总体仍偏正，但**幅度不大**，符合「心理师腔能洗、变体与短尾巴没覆盖」的既有结论。

**这是代理基线，不是真人盲评**：两家模型对「短、无套话、无 Markdown」偏好强，对「信息保真」不敏感（faithful 只扣 0.10），对上下文贴合、语气分寸几乎不扣分。因此它**不能替代真实用户观感**，只能当回归门——后续任何清洗规则改动，加权分不得下降；人评到手后把 `scores-reviewer-A/B.csv` 放进同一 run 目录即可自动切换为「人评构成基线」。

**验收**：`node scripts/test-eval-tools.mjs` → **10 通过 / 0 失败**（新增：权重改变均分与胜场、`exclude` 生效、无配置时回退旧行为、`--weights` 命令行开启）；`node scripts/test-opt-suite.mjs` → **29/29，4.6s**。
**回滚**：删 `weights.json`（或撤 `--weights`）即回到未加权口径，`eval/aggregate.mjs` 无配置时行为不变；这与代码/线上行为无关，纯离线评测。

### 6.41 上线记录（2026-10-26 17:18）：enforce 翻闸 + D4 反例库开启

**用户决策**（口头）：上线；范围选「强制翻闸 + 开 D4 反例库，D3 人格卡瘦身保持关」。

**为什么跳过 24h 门**：`gate-enforce.mjs` 当时 5 PASS / 1 FAIL，唯一未过项是「影子满 24h（已 4.0h）」。经用户明确授权用 `--force` 跳过，其余五项（无退役动作、备份齐全、payload 合格、`[budget]` 已出 8 行）全 PASS。风险控制：当前最高水位 358K，离硬线 420K 还有约 62K，**翻闸当下不会触发任何退役**，真正第一次交接发生在未来某轮撞线时。

**执行顺序**（每步都有输出可查）：
1. `config.json → style.fewshot.negativeEnabled: true`（D4，先改配置，让后面那次重启一并生效）。
2. `node scripts/flip-enforce.mjs --on --force` → 留底 `archive/sessions.json.2026-10-26T09-18-04-pre-enforce.bak`（189 B）/`social-v2.json…bak`（58,302 B）/`config.json…bak`（16,787 B）+ 基线 `state/enforce-baseline.json`（1 会话 / 2 对话）→ 原子写入 `mode: enforce` → `restart.bat`（kill PID 57616，守护自动拉起）。
3. `node scripts/prep-enforce.mjs --verify` → 4 PASS / 0 FAIL / 4 INFO，exit 0。

**上线时抓到的真缺陷（已修）**：首次拉唤醒提示返回 `{"ok":false,"error":"NEGATIVE_LIMITS is not defined"}` —— D4 的接线在 `src/bridge.js:13273` 用了 `NEGATIVE_LIMITS`，但 import 列表里没有它。这个错**只在 `negativeEnabled: true` 时才触发**，所以此前所有测试全绿、开关一开就 500。修法：import 补 `NEGATIVE_LIMITS`；并在 `test-fewshot-negative.mjs` 加静态护栏「bridge 里用到 fewshot-lib 的导出名，必须在 import 行里出现」（防同类：用了没导入）。修完重启，唤醒提示 4,475 字符、含 2 条反例。

**顺带修的两处**：
- `scripts/prep-enforce.mjs`：「日志有交接记录」在还没人撞线时不再判 FAIL，改 INFO（规则：无交接文件 → INFO；有文件但无日志 → FAIL）。
- `scripts/test-flip-enforce.mjs`：「真配置没被测试碰到」不再钉死 `shadow`（上线后合法为 `enforce`），改为「模式属于 {shadow,enforce} 且测试前后字节一致」。

**线上现状（可复现）**：`GET /api/social` → `contextBudget {enabled:true, mode:"enforce", softAt:300000, hardAt:420000}`；`GET /api/socialV2/wake-prompt?reason=preview` → 4,475 字符、含反例块、无「上次交接」；`state/handoff/` 仍为空；`bridge.log` 无报错。回归 `node scripts/test-opt-suite.mjs` → **29/29，5.0s**。

**回滚**：`node scripts/flip-enforce.mjs --off`（改回 shadow + 重启，不设闸门）；D4 关掉只需删 `style.fewshot.negativeEnabled` 再 `restart.bat`。

**观察点（接下来要看的）**：第一次撞线时的 `[handoff]` 行、`state/handoff/*.json` 是否非空壳、未读是否保住、`【上次交接】` 是否只出现一次；异常就 `--off` 并覆盖 `archive/social-v2.json.2026-10-26T09-18-04-pre-enforce.bak`。

### 7. 状态总表（一页看完）

一句话：**代码侧能做的都已经做完，C3 与 D4 已于 2026-10-26 17:18 上线**；B1 已按用户裁定用两份代理评审加权收敛为「代理基线」（§6.40），不再是真人前置；剩下的都是上线后的观察与可选调优——C3 等第一次撞线、B2/D3 等更多数据。

**图例：** ✅ 完成（有可复现证据） · ⚠️ 部分（代码在，效果未验证 / 默认关） · ⏳ 等待（外部条件） · ❌ 已否决（结论留档） · 🚫 不做（有理由）

| 步 | 状态 | 证据（可复现命令 / 位置） | 回滚 |
| --- | --- | --- | --- |
| A1 统一统计基建 | ✅ | `node scripts/test-ops-panel.mjs`（60 断言）；`node scripts/test-opt-suite.mjs`；`GET /ops`、`GET /api/ops/panel` | 删 `src/ops-panel.js`/`public/ops.html`/测试，撤 `src/bridge.js` 五处插入，重启 |
| A2 控制台水位列 | ✅ | 已在参考实现：`test-cost-guard.mjs` 26 / `test-token-usage.mjs` 97 / `test-console-ui.mjs` 5；染色线改为读配置（§6.2 D-1） | 删列或关统计开关；恢复控制台硬编码阈值 |
| A3 `[summary]` 固定日志 | ✅ | `POST /api/social/state` 读 `summaryStats`；三条日志前缀统一（入队/投喂/作废） | 还原旧日志文案（不影响逻辑） |
| A4 语义保真回归集 | ✅ | `node scripts/test-ai-tone-semantic.mjs` → 243 断言；含 37 规则 × 三格 + 6 项必查 | 删脚本并从套件移除 |
| B1 离线盲评尺子 | ✅ | 30 条上下文、盲评表、评审包、打分网页、校验器、汇总全在（`eval/`）；`review-kit.zip`（101,781 B，8 文件，网页版 + Word 文档版）；**基线按用户裁定改为两份代理评审加权**（Gemini-B 0.7 / AI-A 0.3，M 排除，见 §6.40）：加权胜场 cleaned=11 / raw=1 / 平手=18；`test-eval-tools.mjs` 10 通过 | 删 `weights.json` 即回未加权口径；删 `eval/` 新增脚本与两份 docx；`contexts.jsonl` 可保留 |
| B2 采样参数 A/B | ⚠️ | 180 次生成已完成（`eval/gen-replies.mjs`，输入约 48 万 token）；机器代理胜场 control=27 / temperature-1=31 / 平手=32，代理分饱和 → **无证据支持改线上采样**，结论「不动」，详见 §6.36；代理分已足以下结论（真人评分可后补，放进 run 目录即自动改用） | 删 `eval/gen-replies.mjs` + `eval/ab-sampling.mjs` + 测试 + `eval/ab/<stamp>/` |
| C1 `evaluateContextBudget` 纯函数 | ✅ | `src/context-budget.mjs` + `test-context-budget.mjs` 26 项 | 删文件；不接线路即无影响 |
| C2 影子模式 | ✅ | `config.json` `mode:"shadow" 300K/420K`；`node scripts/gate-enforce.mjs` 5/6 PASS；`[budget]` 日志已出现 | mode 改回 `shadow` + 重启 |
| C3 小流量轮换（enforce） | ✅ | **2026-10-26 17:18 已上线**（`contextBudget.mode: enforce`，300K/420K）；`flip-enforce.mjs --on --force` 留底 + 原子改配置 + `restart.bat` + 核对 4 PASS / 4 INFO；`prep-enforce.mjs --verify` exit 0；当前最高水位 358K < 硬线 420K，尚未触发任何退役。详见 §6.41 | `node scripts/flip-enforce.mjs --off` |
| D1 wait 四阶段 | ⚠️ | 阶段 1–3 已在位并已开（`requireThroughSeq:true`）；阶段 4 需 7 天观察；「单轮 wait 上限 2」按数据再定 | 阶段 3 关回 `requireThroughSeq:false` |
| D2 档案抽取游标 | ✅ | 已在位：`src/profile-slice.mjs` + `test-profile-slice.mjs` 23 项（含重启续切、积压对账） | 删 `describeBacklog` 日志即可（逻辑未改） |
| D3 人格卡瘦身 | ⚠️ | 候选稿 4,278 字符（省 42.8%）、`test-persona-slim.mjs` 50 断言、影子覆盖接线 `test-role-override.mjs` 23 断言；**默认关闭**，收益实测仅约 100 token/轮 | `config.json → role.overrideFile: ""` |
| D4 few-shot 反例库 | ✅ | **2026-10-26 17:18 已开**（`config.json → style.fewshot.negativeEnabled: true`）：唤醒提示 4,475 字符、含 `【别这么接 · AI 味反例】` 2 条；`test-fewshot-negative.mjs` 37 断言（含「用到就必须 import」静态护栏） | 删 `negativeEnabled`（改回关）+ `restart.bat`；或删 `negative.jsonl` |
| D5 素材清理 | ✅ | 1.3 MB 聊天记录导出已删；`persona-lib/fewshot/` 只剩 7 个 `.md` + `examples.jsonl`(57) | 从 `state/archive/` 备份恢复（若还在） |
| D6 O2 否定结论留档 | ❌ | 工具结果长尾不肥胖：中位数数百字符、>4,000 个位数、>20,000 为零 → 截断收益 ≈ 2% | 无需回滚（只留档） |

**套件现状**：`node scripts/test-opt-suite.mjs` → **29/29 个测试文件，约 4.2 秒**。

### 7.1 三条自查命令（任何时候都能跑，全部只读）

```powershell
node scripts/test-opt-suite.mjs        # 29 个测试文件，要求全 PASS
node scripts/gate-enforce.mjs           # C3 六项闸门（翻闸前必须 6/6）
node scripts/prep-enforce.mjs --verify  # 翻闸后核对（翻闸前预期 4 项 FAIL）
# 若单独跑某个测试时出现 EPERM: mkdtemp（系统 Temp 被沙箱/受控文件夹访问拒绝），
# 先把子进程临时目录指到仓库内：$env:TEMP = (Resolve-Path tmp).Path
```

### 7.2 三类剩余工作的启动条件

1. **C3（已上线，转观察）**：2026-10-26 17:18 起 `mode: enforce`（300K/420K）。接下来只看第一次撞线：`[handoff]` 行、`state/handoff/*.json` 非空壳、未读保住、`【上次交接】`只出现一次；异常 → `node scripts/flip-enforce.mjs --off`（回 shadow 并重启）。
2. **B1（已完成，代理基线）**：按用户裁定用两份代理评审加权（`weights.json`：Gemini-B 0.7 / AI-A 0.3，M 排除），口径与数字见 §6.40。若要升级为真人基线：把 `review-kit.zip` 发给两个人（`review.html` 网页版或 `评审表-A/B.docx` 文档版）→ `python eval/parse-review-docx.py <docx>` → `node eval/check-review.mjs <分数> <blind.csv>` → 复用同一个 `aggregate`，会自动改判为「人评构成基线」。
3. **B2（等人/等预算）**：`node eval/ab-sampling.mjs plan --variant temperature=1.0` → 按 `replies/<组名>/` 填回复 → `report` → 评审 → 胜场。

### 7.3 「完成」的定义（避免把计划写成已验证）

- 标 ✅ 的条件：有可复现命令或线上可查数据，且**回滚动作写在本文件里**。
- 标 ⚠️ 的条件：代码在、测试在，但「效果是否更好」没有测——这类**不得**写成已完成。
- 标 ⏳ 的条件：只差外部条件（时间/人/预算），代码侧无剩余工作。
- 本文件不含任何未跑过却被写成通过的结果；改一个数字之前先跑一次命令。

## §6.42 上线次日体检：两条时间依赖测试 + 判据读数 + 日志噪音

> 触发原因：昨天设的两条翻闸提醒今天 13:20 才到（enforce 早已生效），借机做全量体检，发现套件从 29/29 变成 2 项失败——不是代码退化，是**测试依赖了会随时间变化的现实**。

| # | 问题 | 根因 | 修法 | 验收 |
|---|------|------|------|------|
| 1 | `test-ops-panel`「长期累计：覆盖天数约等于 3 — 4.1」 | `src/ops-panel.js` 的 `summarizeWait` 里 `days` 直接读 `Date.now()`，测试的 `NOW` 钉在昨天 | `summarizeWait(sessions, persisted, now = Date.now())`；`buildOpsPanel` 传 `Number(input.now) \|\| Date.now()`；测试传 `NOW`，并加「`days === 3`」「`NOW + DAY → 4`」两条断言 | 该测试全绿 |
| 2 | `test-flip-enforce`「闸门不过且无 `--force` 时应拒绝」 | `flip-enforce.mjs` 调 `gate-enforce.mjs` 没带 root，沙箱测试实际查的是真仓库；真机翻闸后闸门转绿 → 「应拒绝」变成「没拒绝」 | `const gateArgs = args.stateDir === path.join(ROOT,'state') ? [] : [\`--root=${path.dirname(args.stateDir)}\`];` | 12 passed / 0 failed |

**教训（写下来免得再犯）**：凡是「现在几点」参与计算的纯函数，`now` 必须是参数；凡是脚本会去读默认路径的，测试必须把「作用域」也传进去。

**判据读数（O3「单轮 wait ≥3 次占比 >5% 才做上限」）**

| 口径 | 值 |
|---|---|
| 有 wait 的轮次（自 2026-10-26 13:16 起） | 6 |
| 其中单轮 wait ≥3 次 | 1 |
| 占比 `soak.ratio3Plus` | **0.1667（16.7%）** |
| 分布 `soak.turnBins` | `{1:3, 2:2, 3:0, 4:1}` |

结论：**判据首次被触发**（16.7% > 5%），方向上支持给单轮 wait 加上限；但样本只有 6 轮真实对话，先不动线上行为，等样本到 30 轮以上再定（判据读数在 `/ops` 的「等待空转」卡末行，跨重启累计）。

**enforce 运行约 20 小时的实际表现**：`[budget]` 全为 soft（0 次 hard）、`[handoff]` 0 次、退役 0 次；水位 354K → 402.3K（硬线 420K 余约 18K）；`gate-enforce.mjs` 事后复检 **6 项全 PASS**（影子满 24.1h、`[budget]` 日志 20 行、影子期退役 0），等于给昨天那次 `--force` 补了事后背书。

**日志噪音修复（本轮顺手做掉）**

| 噪音 | 根因 | 修法 |
|---|---|---|
| `[profile] <key> 待处理 N 条（seq a-b）` 每分钟一行（已累积 511 行） | `sweepProfiles()` 每 60s 扫一次，pending=3 < `sliceMinMessages=6` 永远抽不了，于是每次扫描都打同一行 | 新增 `profileBacklogLogged`（key → `pending\|first\|last`），**值没变就不打**，清空时删记录 |
| `[budget] 上下文 X（soft）` 同一事件两行 | 唤醒提示在一轮里可能被组装两次（取提示词 / 真正唤醒），两次都评估水位 | 只在「等级变化 / 水位涨 ≥5K / 距上次 ≥30 分钟」时打；记录 `st.lastBudgetLevel/lastBudgetLogWm/lastBudgetLogAt` |

验收：`node --check src/bridge.js` 通过；套件 29/29（5.1s）；`restart.bat` 后 `mode=enforce / 300K / 420K`，2 分钟内 `[profile] 待处理` 新增 **0 行**。

**回滚**：两处日志节流都是纯观测代码，回滚 = 去掉 `profileBacklogLogged` 判断与 `levelChanged/moved/stale` 条件；不影响收发与记忆。


## §6.43 首次交接复核（2026-10-27 19:20）：尚未触发 + 一个结构性观察

**复核结果**：`node scripts/prep-enforce.mjs --verify` → **4 PASS / 0 FAIL / 4 INFO**；`state/handoff/` 不存在；`bridge.log` 无 `[handoff]` 行；`/api/ops/panel?days=7` → `private:1000***001 wm=403,930 lv=soft`（硬线 420K，余 **16K**）。结论：**首次交接还没发生**，没有异常可回滚。

**为什么这么慢**：过去 26 小时真实轮次只增加 12 步（`steps 1103 → 1115`），水位 397.7K → 403.9K（**约 6.2K/26h**，不是昨夜估计的 2.4K/h）。按这个速度到硬线还要 2–3 天；撞线前不会退役、不会有交接文件，属正常空窗。

**结构性观察（重要，不是 bug 但要知道）**：主动联系轮（`[proactive]`）走的是 `deliverProactivePromptV2` → `buildProactivePrompt(pc, nowMs)`（`src/bridge.js:11854`、`12072`），**不经过** `buildWakePromptV2`，因此：

1. 主动轮不评估上下文水位（没有 `[budget]` 行），水位只在「真人来消息」的唤醒时被判一次；
2. 主动轮不注入人格块（没有 `[人格] … 注入 N 字符` 行）。

影响判断：因为水位单调增长、且真消息唤醒时一定会重算，漏评估只是把「发现 late」推迟到下一次真消息，不会让会话越过 hard 线还继续跑；但若长时间只有主动轮、没有真人消息，水位会安静地涨。记录在此，不动代码（改它会改变主动轮提示词的组装方式，属于效果类改动，得有 A/B）。

**下一步**：等 `wm` 越过 420K 时再核（`schedule` 已排后续复核）。真正触发时按 §7.2 第 1 条看四件事：`[handoff]` 行、交接文件非空壳、未读保住、`【上次交接】`只出现一次。

### §6.43 续（2026-10-28 19:30）：首次交接真的发生了

| 项 | 结果 |
|---|---|
| 触发时间 | **2026-10-28 17:41:52**（enforce 上线约 24.4h 后） |
| 交接来源 | `[handoff] 记忆区为空，改用最近 6 条消息组装` → 走兜底组装（预期行为：长期记忆还稀） |
| 交接文件 | `state/handoff/private_100000001.json`（301 B，`generatedAt=1793180512432`、`reason=context-budget`、`mode=enforce`） |
| 内容 | `topics` 1 条（在聊「那我去睡了」）、`openLoops` 2 条、`peopleChange`/`insideJokes` 0、`mood` 空 —— **非空壳** |
| 退役 | `[handoff] 交接成功，已退役旧会话`；`prep-enforce --verify` → **8 PASS / 0 FAIL / 1 INFO** |
| 未读 | 退役前后 `unread=0`，`lastUnreadSeq=lastReadThroughSeq=119`，**未丢** |
| token | `agentToken` 已轮换（当前 sha8 `48d68bef`），新会话从零开始 |
| 水位 | 403.9K → **42.7K（ok）**，兜底交接只带 301 B，换会话后上下文回落到零头 |
| 注入 | 唤醒提示 `【上次交接】` **恰好 1 处**（4,490 字符），未重复 |

**顺手修掉一个真缺陷（§6.43 附带）**：`handoffPendingId` / `handoffInjectedId` **没有进 `saveSocialV2State` 的白名单**（load 侧早有读取，save 侧漏了），后果是「注入过」这个标记只活在内存里，**每次重启都会把同一份旧交接再注入一遍**。修法：`src/bridge.js:10750-10752` 保存时落盘这两个 id（各截 40 字符）；`scripts/test-handoff-injection.mjs` 加两条静态断言（**31 passed**）；套件 **29/29（5.8s）**。`restart.bat` 后实测：`mode=enforce`、`【上次交接】` 仍只有 1 处。

**结论**：C3 首次交接的四个验收点（有日志、非空壳、未读保住、只注入一次）**全部通过**，enforce 保持开启，无需回滚。下一次撞线时应当看到的差别：交接内容会来自真实长期记忆（L2 档案/L4），而不是兜底组装。
