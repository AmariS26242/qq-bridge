// 唤醒时「主人私聊自动内联图片」的纯决策逻辑。
// 拆出来的原因：bridge.js 是单文件大脚本、没法 import 测试，而这段逻辑
// 又要保证「只对主人私聊、跳过已附过的、总数不超过上限」。放这里可以单测。
//
// 语义边界（cc 07-候选项目清单 ⑪-2）：
//   - 只有私聊 key === `private:${cfg.ownerQQ}` 才内联；群聊一律按需调 qq_get_message_images。
//   - 一次唤醒最多取最后 INLINE_MEDIA_MAX_MESSAGES 条带媒体的未读。
//   - 同一条消息的图只在真正附上之后才记 ref（写进 st.inlinedMediaRefs），
//     避免「上限截断了图却把消息标记成已附」导致下次补不上。

export const INLINE_MEDIA_MAX_MESSAGES = 2;
export const INLINE_MEDIA_KEEP_REFS = 50;

/**
 * 选出本次唤醒要内联的媒体。
 * @param {{key: string, st: object, cfg: object, maxMessages?: number, maxMedia?: number}} args
 * @returns {{media: Array<object>, refs: string[]}}
 */
export function pickInlineMedia({ key, st, cfg, maxMessages = INLINE_MEDIA_MAX_MESSAGES, maxMedia = 5 } = {}) {
  const context = cfg?.socialV2?.context ?? {};
  if (context.inlineOwnerImages === false) return { media: [], refs: [] };
  const ownerQQ = cfg?.ownerQQ;
  if (!ownerQQ || key !== `private:${ownerQQ}`) return { media: [], refs: [] };
  const unread = Array.isArray(st?.unread) ? st.unread : [];
  if (!unread.length) return { media: [], refs: [] };
  const inlined = Array.isArray(st?.inlinedMediaRefs) ? st.inlinedMediaRefs : [];
  const media = [];
  const refs = [];
  const carriers = unread
    .filter((m) => m && Array.isArray(m.media) && m.media.length > 0)
    .slice(-Math.max(1, maxMessages));
  for (const msg of carriers) {
    if (media.length >= maxMedia) break;
    const ref = String(msg.messageId ?? msg.seq ?? '');
    if (ref && inlined.includes(ref)) continue;
    let added = 0;
    for (const item of msg.media) {
      if (media.length >= maxMedia) break;
      media.push(item);
      added += 1;
    }
    // 只有真的把这张图附上了才记 ref。
    if (ref && added > 0) refs.push(ref);
  }
  return { media, refs };
}

/**
 * 把「已附过」的 ref 记进会话状态。返回是否有变化（调用方据此决定要不要落盘）。
 * @param {object} st
 * @param {string[]} refs
 * @param {{keepRefs?: number}} [opts]
 * @returns {boolean}
 */
export function commitInlineMediaRefs(st, refs, { keepRefs = INLINE_MEDIA_KEEP_REFS } = {}) {
  if (!st || !Array.isArray(refs) || refs.length === 0) return false;
  const list = Array.isArray(st.inlinedMediaRefs) ? st.inlinedMediaRefs : [];
  let changed = false;
  for (const ref of refs) {
    if (!ref) continue;
    if (!list.includes(ref)) {
      list.push(ref);
      changed = true;
    }
  }
  if (!changed) return false;
  st.inlinedMediaRefs = list.slice(-Math.max(1, keepRefs));
  return true;
}
