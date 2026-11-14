// 媒体元数据索引（media-index.jsonl）：让「重启后还能取旧图」成立。
//
// 背景：bridge 原来只把消息里的图片/表情元数据存进内存 Map（messageMediaStore），
// 进程一重启就全丢 —— 模型这时调 qq_get_message_images 会拿到「该消息没有可读取的
// 图片/表情元数据」，很容易开始硬编内容（见 07-候选项目清单 ⑪ 的 bug 记录）。
//
// 设计要点：
// 1. **只存元数据，不存图片字节**：file/url 是 OneBot 给的句柄，取图时照旧走
//    fetchOneBotImage / fetchFaceMedia，所以文件很小（一条消息几十到几百字节）。
// 2. **追加写、按字节上限滚动**：每来一条带媒体的消息追加一行；超过 maxBytes 时
//    读回来只保留最新一半重写（原子 tmp+rename），不需要日常维护脚本。
// 3. **读坏行不算错**：进程被杀时最后一行可能只写了一半，load() 跳过解析不了的行，
//    不因为一行坏数据把整个索引判死。
// 4. **内存索引兜底**：load() 后常驻一个 Map，find() 先查它；内存里的 messageMediaStore
//    被模式切换清空也不影响这里（这正是重启/换模式后还能取图的原因）。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB ≈ 上万条消息的元数据
const DEFAULT_MAX_REFS = 6000; // 内存索引最多留多少个 (key, ref) 句柄
const KEEP_RATIO = 0.5; // 滚动后保留的比例（按行数近似）
const MAX_MEDIA_PER_MESSAGE = 20; // 单条消息最多记多少个媒体句柄（防御异常数据）

/** 一条媒体记录是否需要落盘：必须有 kind，且 at 是可读时间。 */
function normalizeMediaList(mediaList) {
  if (!Array.isArray(mediaList)) return [];
  const out = [];
  for (const media of mediaList.slice(0, MAX_MEDIA_PER_MESSAGE)) {
    if (!media || typeof media !== 'object') continue;
    const kind = String(media.kind ?? '');
    if (kind !== 'image' && kind !== 'face') continue;
    const item = { kind };
    if (kind === 'image') {
      if (media.file) item.file = String(media.file);
      if (media.url) item.url = String(media.url);
      if (media.subType) item.subType = String(media.subType);
      if (media.summary) item.summary = String(media.summary);
    } else if (media.faceId) {
      item.faceId = String(media.faceId);
    }
    out.push(item);
  }
  return out;
}

function parseLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return null;
  let row;
  try {
    row = JSON.parse(text);
  } catch {
    return null;
  }
  if (!row || typeof row !== 'object') return null;
  const key = String(row.k ?? '');
  if (!/^(group|private):\d+$/.test(key)) return null;
  const refs = Array.isArray(row.refs) ? row.refs.map((r) => String(r)).filter(Boolean) : [];
  if (!refs.length) return null;
  const media = normalizeMediaList(row.media);
  if (!media.length) return null;
  const at = Number(row.t);
  return { key, refs, media, at: Number.isFinite(at) ? at : 0 };
}

export class MediaIndex {
  constructor({ file, maxBytes = DEFAULT_MAX_BYTES, maxRefs = DEFAULT_MAX_REFS } = {}) {
    if (!file) throw new Error('MediaIndex 需要 file');
    this.file = file;
    this.maxBytes = Math.max(16 * 1024, Number(maxBytes) || DEFAULT_MAX_BYTES);
    this.maxRefs = Math.max(50, Number(maxRefs) || DEFAULT_MAX_REFS);
    /** @type {Map<string, Map<string, {media: any[], at: number}>>} key → (ref → 记录) */
    this.byKey = new Map();
    /** @type {Map<string, number>} 全局插入序，用于按上限淘汰最旧 */
    this.order = new Map();
    this.seq = 0;
    this.writes = 0;
  }

  /** 内存里已有的句柄数（用于日志/自检）。 */
  get size() {
    let n = 0;
    for (const refs of this.byKey.values()) n += refs.size;
    return n;
  }

  /**
   * 回读索引。文件不存在/为空都算正常（首次启动）。返回 {loaded, refs, error, rewritten}。
   * 错误只记录不抛：索引坏了应该退化成「取不到旧图」，而不是让 bridge 起不来。
   */
  load() {
    const info = { loaded: 0, refs: 0, error: null, rewritten: false };
    let raw = '';
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') info.error = `读取失败：${error?.message ?? error}`;
      return info;
    }
    const lines = raw.split(/\r?\n/);
    let bad = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const row = parseLine(line);
      if (!row) {
        bad += 1;
        continue;
      }
      this._remember(row.key, row.refs, row.media, row.at);
      info.loaded += 1;
    }
    info.refs = this.size;
    // 文件超过上限（比如停机期间积了很多）或坏行过多：重写一份干净的。
    if (raw.length > this.maxBytes || bad > 0) {
      try {
        this._rewriteFromMemory();
        info.rewritten = true;
      } catch (error) {
        info.error = `压缩索引失败：${error?.message ?? error}`;
      }
    }
    return info;
  }

  /**
   * 记录一条消息的媒体元数据。同一个 key+ref 已有同样记录时不再重复追加
   * （消息重投/断线补拉会重复触发 handleIncoming）。
   * 返回 true 表示写了盘。
   */
  record(key, refs, mediaList, atMs = Date.now()) {
    const list = normalizeMediaList(mediaList);
    const cleanRefs = [...new Set((Array.isArray(refs) ? refs : []).map((r) => String(r)).filter(Boolean))];
    if (!list.length || !cleanRefs.length) return false;
    if (!/^(group|private):\d+$/.test(String(key))) return false;
    const prev = this.find(key, cleanRefs[0]);
    if (prev && prev.length === list.length && JSON.stringify(prev) === JSON.stringify(list)) return false;
    this._remember(key, cleanRefs, list, atMs);
    const line = `${JSON.stringify({ t: atMs, k: key, refs: cleanRefs, media: list })}\n`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, line, 'utf8');
      this.writes += 1;
      let size = 0;
      try { size = fs.statSync(this.file).size; } catch {}
      if (size > this.maxBytes) this._rewriteFromMemory();
      return true;
    } catch {
      // 写盘失败不影响本次会话可用：内存里已经记下了。
      return false;
    }
  }

  /** 查一条消息的媒体元数据（messageId 或本地 seq 都可以）。 */
  find(key, ref) {
    const refStr = String(ref ?? '');
    if (!refStr) return null;
    const refs = this.byKey.get(String(key));
    if (!refs) return null;
    const hit = refs.get(refStr);
    return hit ? hit.media : null;
  }

  /** 记入内存并维护上限。 */
  _remember(key, refs, media, at) {
    let bucket = this.byKey.get(key);
    if (!bucket) {
      bucket = new Map();
      this.byKey.set(key, bucket);
    }
    for (const ref of refs) {
      bucket.set(ref, { media, at });
      this.seq += 1;
      this.order.set(`${key}\u0000${ref}`, this.seq);
    }
    // 超上限时按插入序淘汰最旧的句柄；空 bucket 顺手删掉，防止 key 无限增长。
    while (this.size > this.maxRefs) {
      let oldestKey = null;
      let oldestSeq = Infinity;
      for (const [id, seq] of this.order) {
        if (seq < oldestSeq) {
          oldestSeq = seq;
          oldestKey = id;
        }
      }
      if (!oldestKey) break;
      const [k, r] = oldestKey.split('\u0000');
      this.order.delete(oldestKey);
      const b = this.byKey.get(k);
      if (b) {
        b.delete(r);
        if (!b.size) this.byKey.delete(k);
      }
    }
  }

  /** 用内存里的内容整体重写索引文件（原子写）。 */
  _rewriteFromMemory() {
    const rows = [];
    for (const [key, refs] of this.byKey) {
      for (const [ref, hit] of refs) rows.push({ t: hit.at, k: key, refs: [ref], media: hit.media });
    }
    rows.sort((a, b) => Number(a.t) - Number(b.t));
    // 从最新往回取，直到字节数不超过上限的一半。
    const budget = Math.floor(this.maxBytes * KEEP_RATIO);
    const kept = [];
    let bytes = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const line = `${JSON.stringify(rows[i])}\n`;
      if (bytes + line.length > budget) break;
      bytes += line.length;
      kept.push(line);
    }
    kept.reverse();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, kept.join(''), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}
