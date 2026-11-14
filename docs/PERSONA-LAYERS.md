# 人格分层注入（核心 / 场景 / 手册）

## 为什么

以前的链路有两个问题：

1. **二代模式下人格卡不常驻。** 唤醒提示词只写「【当前角色】小鲸鱼（完整角色卡请调用 qq_get_prompt 查看）」（`src/bridge.js` 的 `buildWakePromptV2`）。模型这一轮可能压根没去拉卡，卡写得再好也没用。
2. **拉全文又很贵。** `qq_get_prompt` 返回整张卡，被 `role.maxInjectChars` 截断（历史默认 6000）。卡一长，后面的示例和细则就被切掉。

现在改成三层，各管各的预算：

| 层 | 内容 | 什么时候进提示词 | 预算 |
| --- | --- | --- | --- |
| 核心 | `## 核心 · 每轮必看` | **每次唤醒**都注入 | `role.wakeInjectMaxChars`（默认 2600，实际核心约 400） |
| 场景 | `## 场景：情绪倾诉` 等 | 命中该场景时才注入（每次最多 `role.maxScenes` 个，默认 2） | 上面同一个上限 |
| 手册 | `persona-lib/style/<场景>.md` | 模型主动调 `qq_style_guide(topic)` 才读 | 单篇 2000 字符 |

完整角色卡仍在 `qq_get_prompt` 里按需拉，不再承担「每轮都说一遍」的职责。

## 怎么写人格卡

在 `roles/<角色>.md` 里用标题标记：

```markdown
## 核心 · 每轮必看
（每轮都要看到的十几条：身份、长度、接话顺序、黑名单、2~3 个示范）

## 场景：情绪倾诉
（只在监测到对方在倾诉时注入的几句）

## 场景：冷场
...
```

- 没打标记的小节 = 普通小节：只在 `qq_get_prompt` 拉全文时出现，不进每轮注入。
- 场景名必须和 `src/scene-router.js` 的 `SCENE_NAMES` 完全一致，否则那段永远不会被选中（`scripts/test-scene-router.mjs` 会检查）。
- 模式标记 `〔一代〕/〔二代〕` 仍然有效，可以和场景标记同时用。

## 场景怎么路由

`src/scene-router.js` 的 `routeScenes(recentMessages, meta)` 只看确定性信号：

- 最近 8 条消息的文本（越新权重越高）：分手/难受 → 情绪倾诉；你是AI吧 → 被问是不是AI；推荐/安利 → 求推荐；骂人 → 被怼；怎么解决/报错 → 正经问题（短句不算）。
- 时间：0~5 点 → 深夜。
- 群聊安静超过 `silenceMinutes`（默认 20）→ 冷场。
- 兜底：群聊有来有回 → 群聊接梗；私聊没信号 → 情绪倾诉。

日志会打印命中结果，方便观察误判：

```
[人格] private:100000001 场景=[情绪倾诉]（常规接话）注入 601 字符
```

## 配置（config.json）

```json
"role": {
  "maxInjectChars": 8000,   // qq_get_prompt 拉全文的上限
  "wakeInject": true,       // 每轮注入核心+场景；false 退回旧行为
  "wakeInjectMaxChars": 2600,
  "maxScenes": 2,
  "logInject": true
}
```

调参建议：觉得「每轮话太多」→ 降 `wakeInjectMaxChars`；觉得某个场景该生效没生效 → 看日志里的 `场景=[...]`，再去 `scene-router.js` 补关键词；觉得场景串了 → 降 `maxScenes` 到 1。

## 风格手册（qq_style_guide）

`persona-lib/style/*.md` 每篇一个场景，格式：一级标题 + `摘要：` 一行 + 好例子/反例。

- 模型调用 `qq_style_guide()` → 返回目录（场景名 + 摘要）。
- `qq_style_guide(topic="情绪倾诉")` → 返回该篇正文（>2000 字符截断）。
- 支持模糊匹配（`topic="情绪"` 可命中「情绪倾诉」）。
- 改文件即生效，**不用重启**；工具描述里不会背这些细则，省 token。

## 相关测试

```bash
node scripts/test-role-scenes.mjs   # 核心/场景选择、真实卡片预算
node scripts/test-scene-router.mjs  # 路由规则与误报
node scripts/test-style-guide.mjs   # 手册完整性 + 工具注册
node scripts/test-role-card.mjs     # 旧的分模式注入行为不变
```
