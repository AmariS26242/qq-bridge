# 图片/表情的落盘索引与内联（⑪）

> 状态：✅ 2026-10-24 落地。
> 相关代码：`src/media-index.js`（落盘索引）、`src/media-note.js`（「取不到就明说」的统一文案）、
> `src/inline-media.js`（`pickInlineMedia` / `commitInlineMediaRefs`：谁内联、内联几张、哪些已附过的纯逻辑）、
> `src/bridge.js`（`initMediaIndex` / `handleIncoming` 写索引 / `findMessageMedia` 回读 / `pickInlineMediaForWakeV2` / `deliverPromptNow` 内联）、
> `src/mcp-snowluma-safe.js`（`qq_get_message_images` 的返回文案）、`/api/images/message` 端点。
> 自测：`node scripts/test-media-index.mjs`（离线，10 项）、`node scripts/test-inline-media.mjs`（离线，13 项）。

## 一句话

图片不再只活在内存里：每条带图消息落一行 `state/media-index.jsonl`，bridge 重启后按 messageId/seq 仍能取图；
**主人私聊**的新图会随唤醒直接附给模型（省一次工具往返），群聊仍靠 `qq_get_message_images` 按需调用；
凡是没取到，一律明说「没取到、别猜」。

## 三个部分

### 1. 落盘索引 `state/media-index.jsonl`

- 写入时机：`handleIncoming` 解析出媒体后，同一批 `messageId` / `seq` 句柄各记一条，行格式
  `{"t":时间戳,"k":"private:123","refs":["1001","42"],"media":[{"kind":"image","file":"…","url":"…","subType":"0","summary":"…"}]}`。
- 字段白名单：image 只存 `kind/file/url/subType/summary`，face 只存 `kind/faceId`；**不存 base64、不存整条消息**。
- 上限：文件 2 MB（超了保留最新约一半并原子重写）、内存 6000 个句柄（插入序淘汰最旧）；坏行跳过，坏行多则顺手重写干净文件。
- 读取：`findMessageMedia(key, ref)` 先查内存（`st.recentMessages` / `st.unread` / `messageMediaStore`），都没有再查索引 —— 这就是「重启后旧图还能取」的实现点。
- 换模式/重连会 `messageMediaStore.clear()`，但**不会**动索引文件，所以重启、切模式都不影响旧图。

### 2. 主人私聊自动内联

- 只在 `key === private:<ownerQQ>` 且 `cfg.socialV2.context.inlineOwnerImages !== false` 时生效。
- 取 `st.unread` 里最后 **2 条**带图消息、总张数 ≤ `MAX_MEDIA_COUNT`（5）；已经在 `st.inlinedMediaRefs` 里记过的句柄不重复附。
- 图片随 `deliverPrompt` 的 content 一起进模型，提示词尾部自动加一段「【图片已随消息附上】…不需要再调 qq_get_message_images」。
- 投递成功（含入队）后才把句柄记进 `st.inlinedMediaRefs`（保留 50 条）：失败不记，避免下次永久跳过；重投不重复附。
- 群聊**不内联**（控 token）：仍由 `mediaHintFor()` 提示模型按需调工具。

### 3. 取不到就说取不到

统一文案在 `src/media-note.js`，三处都用它：

| 位置 | 场景 | 文案要点 |
| --- | --- | --- |
| `qq_get_message_images` | 这条消息没有任何媒体元数据 | 「消息 N 没有取到任何图片/表情（…）。如果对方确实发过图，那就是这边没拿到——直接说『这张图我这边没取到/看不清』，不要根据上下文猜图片内容，也不要假装看过。」 |
| 同上 | 部分图取失败（下载失败/太大） | `[图片1（没取到图像，不要猜内容）]` + 「有 N 张没取到…不要猜测」 |
| `/api/images/message` | 无媒体记录 | `note` 说明「可能本来就没发图，或消息太旧、元数据没存下来」 |
| `resolveMediaList` / `fetchMediaData` | 内联时单张失败 | 同上短文案（不再只说「获取失败」） |

工具描述里也加了一句「返回里明确说没取到，就照实说，不要编造」。

## 配置

```jsonc
"socialV2": {
  "context": { "inlineOwnerImages": true },   // 设为 false 关掉主人私聊自动内联
  "tools":   { "getImages": true }            // 设为 false 关掉 qq_get_message_images
}
```

## 验证

1. **新图**：主人私聊发一张图 → 日志出现 `[reserved2] 唤醒 private:… （…），内联图片 1 张`，第一句回复应当直接说对图的内容。
   （2026-10-24 14:44 实测通过：`media-index.jsonl` 落行 + 日志「内联图片 1 张」，AI 随即认出是插画风的图并追问「这是画的还是真动画里截的」。）
2. **重启后旧图**：重启 bridge → `[media-index] 已载入 N 条媒体记录`，让 AI 调 `qq_get_message_images` 取几分钟前那张图，应能取到。
   （2026-10-24 14:45 实测通过：重启后 `已载入 1 条媒体记录 / 2 个消息句柄`，用 14:44 那张图的两种句柄 `-100000001` / `22367` 调 `/api/images/message` 仍返回 168 KB 的 jpeg。）
3. **取不到**：让 AI 对一条没有图的消息调工具，回复里应明确说没取到，不得描述图片内容。
4. 离线：`node scripts/test-media-index.mjs`（含重启回读、坏行、滚动、字段白名单、文案断言）、`node scripts/test-inline-media.mjs`（只对主人私聊内联、已附过去重、张数上限、face 也能内联）。

## 已知取舍

- 只存元数据（file/url 句柄），不存图本身：OneBot 的图有有效期，太旧的图 url 可能已失效——那时会走「取不到」分支并明说，不假装。
- 群聊没有自动内联，仍可能多一次工具往返；这是为控 token 的刻意选择。
