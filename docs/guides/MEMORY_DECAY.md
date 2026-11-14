# 记忆过期降权（MEMORY_DECAY）

给 QQ 会话的轻量记忆加「时间衰减 + 折叠 + 长度封顶」。纯逻辑模块已落地并通过单测；把
`src/memory-decay.mjs` 接进 `src/bridge.js` 的 `formatMemoryV2` 即生效（接线由主智能体执行，
本分支不改 bridge.js）。

## 解决什么问题

现状：`qq_memory_append/query/update/remove/clear` 写入 `social-v2.json` 的
`activeTopics` / `pendingThoughts` / `memberImpressions`，注入 prompt 时
`formatMemoryV2` 把三类记忆全量拼进去（每类最多 10 条，无时间权重）。后果：

1. 上下文被挤占：老印象和新话题同权，唤醒 prompt 越聊越长；
2. 误导：两个月前的印象和昨天的印象看起来一样可信，新对话容易被旧结论带跑。

目标不是删记忆，而是**按新鲜度排序、低分折叠、总量封顶**，重要信息靠重新 append 刷新时间。

## 评分口径（`decayScore`）

- 基础分：`0.5 ^ (距最近活跃小时数 / (halfLifeDays*24))`，默认半衰期 7 天。
  最近活跃时间取 `updatedAt`、`lastUsedAt`、`createdAt`、`lastMentionAt`、`lastSeenAt`
  中最大的合法值；**全部缺失或非法时按 0.5 兜底**（等于已过一个半衰期，不优待也不误杀）。
- `hits` 加成（兼容 `hitCount` / `useCount` / `interactionCount`）：
  `base * min(2, 1 + 0.15*log2(1+hits))`，即 hits=0→1×，hits=8→约 1.48×。
- 过期：`expiresAt` 已过时不再享受待办下限，分数再乘
  `0.1 * 0.5^(过期小时数 / (halfLifeDays*24))`，快速跌到可折叠区。
- 待办下限：**未过期**的 `pendingThought` 至少 `pendingFloor`（默认 0.35），
  保证「待说但还没说」不会被当成噪音清掉。
- 结果永远夹到 `[0, 1]`；未来时间（时钟回拨）按刚更新处理。

## 默认配置（`DEFAULT_DECAY_CFG`，已冻结）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `halfLifeDays` | `7` | 半衰期（天） |
| `pendingFloor` | `0.35` | 未过期待办的分数下限 |
| `foldThreshold` | `0.15` | 低于此分才可折叠 |
| `foldMinCount` | `3` | 至少几条低分记忆才折叠成一条 |
| `maxChars` | `1200` | 注入文本块字符硬上限 |
| `expiredGraceHours` | `24` | 过期待办的宽限期（小时） |

调用方传 `cfg` 覆盖任意键；非法值（`NaN`、负数、字符串）回落默认值并夹紧，
不会把 `NaN` 带进计算。配置来源建议 `cfg.memoryDecay`（不传就用默认，无需改 config.json）。

## 排序、折叠、裁剪规则

- `rankMemories(list, now, cfg)`：分数降序；同分保持入参顺序（稳定排序）；
  返回新数组 `[{...entry, _score}]`，**不写入参对象**。
- `foldMemories(list, now, cfg)`：分数 `< foldThreshold` 的条目里，
  未过期的 `pendingThought` 除外；数量 `>= foldMinCount` 时抽出来并成一条
  `{ folded: true, count, text: '较早的 N 条印象已被折叠' }` 追加在末尾
  （全是 `memberImpression` 时用「印象」，否则用「记忆」）。不够条数就只排序不折叠。
  返回新数组，原数组/原对象不动。
- `buildMemoryPromptBlock(list, now, cfg)`：先 `pruneExpired`（超 24h 宽限期的待办不注入），
  再排序/折叠，渲染成中文行（`- 话题：…` / `- 待说：…` / `- 印象·名字：…`，
  `pendingQuestion` 由调用方拼进 text）。超过 `maxChars` 时从最低分开始丢，
  末尾追加 `（已省略 N 条较早记忆）`；N 按被丢掉的**真实条数**累计
  （折叠摘要被丢时按其 `count` 计）。空输入返回 `''`，任何情况长度 ≤ `maxChars`。
- `pruneExpired(list, now, cfg)`：移除 `expiresAt` 已过且超过宽限期的 `pendingThought`；
  其余条目原样保留（引用不变）。非法/缺失 `expiresAt` 不裁。

## bridge.js 接线（主智能体执行）

`formatMemoryV2` 是唯一出口：唤醒 prompt（`src/bridge.js:10731`，
`buildWakePromptV2` 里 `const memoryText = formatMemoryV2(st);`）和
`qq_get_prompt` 返回体（`src/bridge.js:4740`，`memory: formatMemoryV2(st)`）都走它。
所以**只改 `formatMemoryV2`（`src/bridge.js:8930`，当前 `return lines.join('\n')` 在 8959）一处**，
两条注入点同时生效。

> 行号是 2026-10-19 21:55 的 `bridge.js` 快照；该文件正被并行改动，接线时以函数名
> `formatMemoryV2` / `buildWakePromptV2` 用 grep 定位为准。

文件顶部加 import：

```js
import { buildMemoryPromptBlock, pruneExpired } from './memory-decay.mjs';
```

把 `formatMemoryV2` 整体替换为（≤10 行核心；保留原字段映射，含待追问）：

```js
function formatMemoryV2(st) {
  if (!st) return '';
  const list = [
    ...(st.activeTopics || []).map((e) => ({ kind: 'activeTopic', text: e?.text, updatedAt: e?.lastMentionAt, pendingQuestion: e?.pendingQuestion })),
    ...pruneExpired((st.pendingThoughts || []).map((e) => ({ kind: 'pendingThought', ...e }))),
    ...Object.entries(st.memberImpressions || {}).map(([name, im]) => ({ kind: 'memberImpression', name, text: (im?.traits || []).join('、'), updatedAt: im?.lastSeenAt, hits: im?.interactionCount }))
  ].map((e) => ({ ...e, text: e.pendingQuestion ? `${e.text}（待追问：${e.pendingQuestion}）` : e.text })).filter((e) => e.text);
  return buildMemoryPromptBlock(list, Date.now(), cfg?.memoryDecay);
}
```

注意：

- 这里 `pruneExpired` 与模块内部的裁剪重复一次是有意的：进块前先裁，便于调试日志/断言；
  若嫌重复，可去掉外层，`buildMemoryPromptBlock` 内部已经裁。
- 现有 `formatMemoryV2` 里的「X分钟前 / （已搁置）」提示不再输出；要保留就在映射 `text`
  时自行拼上，不要改模块。
- 原 `src/bridge.js:8942` 的即时过期过滤和 `:7142` 查询过滤不用动：宽限期只在直接调用
  `pruneExpired` 的地方体现；prompt 侧由 `buildMemoryPromptBlock` 内部裁剪兜底。
- 不要动 `appendMemoryV2`（`src/bridge.js:8962`）的写入逻辑：本次只改注入侧，零迁移。

## 如何验证

```powershell
$node = "%USERPROFILE%\Documents\deepseek-harness\default-workspace\SnowLuma\node.exe"
cd <repo>
& $node --check src/memory-decay.mjs
& $node scripts/test-memory-decay.mjs        # 期望 23 passed, 0 failed，exit 0
& $node scripts/test-preset-prompt.mjs       # 回归：期望 12/12 pass
```

接线后（需重启 bridge 才生效，由管理员决定时机）：

1. 用 `qq_memory_append` 写一条 `memberImpression`，正常发起一次唤醒，看 prompt 中
   记忆段是否按权重排序、条数是否收敛；
2. 构造多条旧记忆（可直接改测试用临时会话，勿改生产 `state/`），确认出现
   `较早的 N 条印象已被折叠` 与 `（已省略 N 条较早记忆）`；
3. `qq_memory_query` 仍返回全量原始数据（本次不改查询/写入语义），用于回查；
4. 观察连续多轮唤醒的 prompt 体积不再随天数线性增长。

## 回滚

- 只回滚 `formatMemoryV2` 一处：恢复原实现（`return lines.join('\n')`），重启 bridge；
- `src/memory-decay.mjs`、`scripts/test-memory-decay.mjs`、本文件保留不影响运行；
- 无配置迁移、无 `state/` 数据结构变更、无新依赖，回滚不需要清数据。

## 已知限制 / 风险

- `hits` 目前没有真实写入方：`activeTopics` / `pendingThoughts` 不带 `hits`，默认 0；
  只有 `memberImpressions.interactionCount` 可复用。想要「常用记忆更抗衰减」，需主智能体
  在 append/query 路径补计数（本次未做）。
- `activeTopics` 在写入侧已有「超过 24h 未提起就移除」的清理（`src/bridge.js:8971`），
  所以话题类衰减的实际空间有限；主要收益在 `memberImpressions` 和过期待办。
- 折叠只保留条数，不保留旧原文；重要旧信息需重新 append 刷新时间。
- 文本块不保留「几分钟前」时间提示，语气/格式与原注入略有差异。
- 极端 `maxChars`（小于省略文案本身，约 13 字）会硬切，可能截出半个括号；默认 1200 不会遇到。
