# 表情包语义检索（Track 1）

让机器人按「想表达的意思」挑收藏表情，而不是靠 id 或关键词碰运气。

## 能力与入口

| 入口 | 用法 |
| --- | --- |
| MCP 工具 | `qq_find_sticker { key, token, query, limit? }` —— 机器人聊天时自动可调 |
| CLI | `node qq-bridge/scripts/sticker-search.mjs "想表达的意思" [-n 5] [--json] [--explain]` |
| 解释 API | `GET /api/stickers/explain?q=...&limit=..`（需 `x-console-token`） |
| 调试页 | `http://127.0.0.1:3100/stickers-debug?token=<console token>` |

调试页每张卡片可展开「哪些词命中了、权重多少、贡献多少分」，用来回答「为什么选中这张」。

## 打分（`src/sticker-index.js`）

- 稀疏向量索引：BM25，`K1=1.2`、`B=0.6`；字段权重 `tags 2.6 / localNote 1.6 / desc 1.2 / usage 1.0`。
- 分词：中文 bigram + 单字兜底（文档侧 0.45、查询侧 0.8）+ 3~4 字整段；英文小写词。
- 同义词：约 29 组（哭/笑/生气/无语/摸鱼/摆烂/破防…），扩展权重 0.6，每组最多补 8 个。
- 短语与标签加分：整串命中 tags +5、desc/localNote +3、usage +2；标签精确 +6、互相包含 +2。
- 使用频次只做微调：`0.15 * log1p(useCount)`。

## 质量

- 人工评测集 20 条（`scripts/sticker-eval.mjs`）：语义 **top1 17/20 (85%)、top3 20/20 (100%)**；旧子串对照 12/20、12/20。
- 单测 13 项（`scripts/test-sticker-index.mjs`）：分词、同义降权、精确标签优先、IDF、截断、解释与检索同分自洽、接线检查。

## 上线状态

- `config.json` → `socialV2.tools.findSticker: true`（备份 `config.json.bak-sticker`）。
- `src/sticker-lib.js` 的注入文本已改为优先推荐 `qq_find_sticker`（表情清单用法 + 表情策略「选择」条）。
- 改完 `sticker-index.js` / `sticker-lib.js` / MCP 工具后需要两步才生效：
  1. 重启桥：`GET /api/local-token` → `POST /api/restart`（带 `Content-Type: application/json` 和 `x-console-token`）。
  2. **清掉旧 DSH 会话**：`POST /api/session/reset {"key":"private:<QQ号>"}` —— 会话的工具表在创建时固化，只重启桥会复用老会话，新工具进不去。
- 真实对话验证（2026-10-23 19:04）：群里/私聊发「发个表情表示你很悲伤」→ 新会话 `session-f3ade17a-…` 调 `qq_find_sticker {"query":"悲伤 想哭 委屈","limit":6}` → 发「委屈：眼泪汪汪」。

## 待办

- D2 稠密向量精排（可选，Track 1 的 top3 已 100%）。
- 群聊场景补一次实测（本次闭环发生在私聊）。
