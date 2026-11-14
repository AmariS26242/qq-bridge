// 图片/表情链路的「说实话」文案：取不到就说取不到，别猜。
//
// 为什么单独成模块：同一句兜底要在三个地方出现（内联、MCP 工具、HTTP 端点），
// 文案统一 + 可单测，比散在 bridge.js / mcp-snowluma-safe.js 里各写一遍可靠。
// 背景见 07-候选项目清单 ⑪：bridge 重启后旧图取不到时，模型曾对着
// 「该消息没有可读取的图片/表情元数据」硬编内容。

const KIND_CN = { image: '图片', face: '表情' };

/** 内联失败（fetchOneBotImage / fetchFaceMedia 抛错）时的占位文字。 */
export function mediaFailNote(index, kind) {
  const n = Number.isFinite(Number(index)) ? Number(index) : '';
  const name = KIND_CN[kind] ?? '图片';
  return `[${name}${n}（没取到：${name}内容没有加载成功，看不到就是看不到，不要猜它是什么）]`;
}

/** 简短版：塞在工具返回的 `[图片N …]` 方括号里用。 */
export const MEDIA_FAIL_SHORT = '（没取到图像，不要猜内容）';
export const MEDIA_TOO_LARGE_SHORT = '（太大没取到，内容未知，不要猜）';

/** 单张媒体超过总字节上限时的占位文字。 */
export function mediaTooLargeNote(index, kind) {
  const n = Number.isFinite(Number(index)) ? Number(index) : '';
  const name = KIND_CN[kind] ?? '图片';
  return `[${name}${n}（太大没取：超出单条消息的图片总大小上限，内容未知，不要猜）]`;
}

/** 工具查不到任何图片时的整段说明（MCP 工具返回给模型的文本）。 */
export function mediaMissText(messageId, note) {
  const detail = String(note ?? '').trim();
  return `消息 ${messageId} 没有取到任何图片/表情${detail ? `（${detail}）` : ''}。`
    + '如果对方确实发过图，那就是这边没拿到——直接说「这张图我这边没取到/看不清」，不要根据上下文猜图片内容，也不要假装看过。';
}

/** 一部分图片取到、一部分没取到时，追加在工具结果末尾的提醒。 */
export function mediaPartialNote(failedCount) {
  const n = Math.max(1, Number(failedCount) || 1);
  return `其中 ${n} 项没取到图像（只有占位文字）：这几项对你来说是不可见的，不要猜测它们画的是什么，需要的话跟对方确认。`;
}

/** 主人私聊自动内联图片时，追加在唤醒 prompt 末尾的说明。 */
export function inlineMediaNote(count) {
  const n = Math.max(1, Number(count) || 1);
  return `\n\n【图片已随消息附上】最近的未读消息里有 ${n} 张图片/表情，已经按顺序作为图像内容附在这条消息后面（不需要再调 qq_get_message_images）。`
    + '先看清图里到底是什么再开口；如果图里确实看不清（糊了、只有局部、纯色），就照实说看不清，不要按上下文猜。';
}
