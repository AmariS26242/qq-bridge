// 零依赖 zip 写入/读取 —— 只为实现「代码保险箱」的打包与恢复演练。
//
// 为什么不 shell 出去打 zip（2026-10-24 实测）：
//   * `tar -a -cf x.zip 中文目录` 能打成功，但 bsdtar 写 zip 时**没置 UTF-8 文件名标志位**，
//     中文路径会被 Expand-Archive 按 GBK 解成乱码（实测 `项目计划` → `��Ŀ�ƻ�`）。
//     restore 脚本如果依赖解包工具，就等于把恢复能力押在编码碰巧对得上。
//   * `Compress-Archive` 走命令行传参，文件一多就撞 Windows 32k 命令行上限，且同样有编码坑。
//   * `fflate` 虽然在 node_modules 里（transitive），但没写进 package.json —— 保险箱不能依赖
//     一个随时可能被 pnpm 严格模式或重装清掉的隐式依赖。
//
// 所以这里直接按 APPNOTE.TXT 写最小实现：local header + central directory + EOCD，
// 压缩用 node:zlib 的 deflateRawSync（无效时自动退回 STORE）。文件名一律 UTF-8 且置
// flag bit 11，Expand-Archive / tar / 7z / Windows 资源管理器都能正确还原中文。

import zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** 通用位：bit 11 = 文件名是 UTF-8。少了这一位，中文名在 Windows 上必乱码。 */
const FLAG_UTF8 = 0x0800;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** 标准 CRC-32（IEEE 802.3），与 zip 要求的算法一致。 */
export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Date → DOS 时间戳（2 秒精度，1980 起算）。zip 格式的硬要求。 */
export function dosDateTime(input) {
  const d = input instanceof Date ? input : new Date(input);
  const t = Number.isFinite(d.getTime()) ? d : new Date();
  const year = Math.min(2107, Math.max(1980, t.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate(),
    time: (t.getHours() << 11) | (t.getMinutes() << 5) | Math.floor(t.getSeconds() / 2),
  };
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  throw new TypeError('zip 条目数据必须是 Buffer / Uint8Array / string');
}

/**
 * @param {Array<{name: string, data: Buffer|Uint8Array|string, mtime?: Date|number, store?: boolean}>} entries
 * @param {{level?: number}} [options]
 * @returns {Buffer} 完整 zip 字节
 */
export function zipCreate(entries, options = {}) {
  const level = Number.isFinite(options.level) ? options.level : 6;
  const body = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = String(entry.name ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name) throw new Error('zip 条目的 name 不能为空');
    const nameBuf = Buffer.from(name, 'utf8');
    if (nameBuf.length > 0xffff) throw new Error(`zip 条目名过长：${name.slice(0, 80)}`);
    const raw = toBuffer(entry.data);
    const { date, time } = dosDateTime(entry.mtime ?? Date.now());

    let method = entry.store ? 0 : 8;
    let payload = raw;
    if (method === 8) {
      payload = zlib.deflateRawSync(raw, { level });
      // 已压缩的媒体（webp/png/mp3）deflate 后反而变大：退回 STORE 省 CPU 也省体积。
      if (payload.length >= raw.length) {
        method = 0;
        payload = raw;
      }
    }

    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra field length
    body.push(local, nameBuf, payload);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CENTRAL, 0);
    cen.writeUInt16LE(20, 4);            // version made by
    cen.writeUInt16LE(20, 6);            // version needed
    cen.writeUInt16LE(FLAG_UTF8, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);            // extra
    cen.writeUInt16LE(0, 32);            // comment
    cen.writeUInt16LE(0, 34);            // disk number start
    cen.writeUInt16LE(0, 36);            // internal attrs
    cen.writeUInt32LE(0, 38);            // external attrs
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  if (entries.length > 0xffff) throw new Error(`zip 条目过多（${entries.length}），超出单盘上限`);
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...body, cd, eocd]);
}

/**
 * 读回 zip（只支持本模块写出的 STORE / DEFLATE 两种方法）。
 * 恢复演练靠它：不 shell 出去，免得再被外部工具的中文编码坑一次。
 * @param {Buffer} buf
 * @returns {Array<{name: string, data: Buffer, size: number}>}
 */
export function zipRead(buf) {
  const zip = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // EOCD 从尾部往前找（注释长度可能非 0，但本模块写的都是 0；仍按规范搜索）。
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到 EOCD');

  const count = zip.readUInt16LE(eocd + 10);
  let pos = zip.readUInt32LE(eocd + 16);
  const out = [];

  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(pos) !== SIG_CENTRAL) throw new Error(`zip 中央目录损坏（第 ${i} 项）`);
    const flags = zip.readUInt16LE(pos + 8);
    const method = zip.readUInt16LE(pos + 10);
    const crcExpected = zip.readUInt32LE(pos + 16);
    const compSize = zip.readUInt32LE(pos + 20);
    const size = zip.readUInt32LE(pos + 24);
    const nameLen = zip.readUInt16LE(pos + 28);
    const extraLen = zip.readUInt16LE(pos + 30);
    const commentLen = zip.readUInt16LE(pos + 32);
    const localOffset = zip.readUInt32LE(pos + 42);
    const name = zip.slice(pos + 46, pos + 46 + nameLen).toString('utf8');

    if (zip.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error(`zip 本地头损坏：${name}`);
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const payload = zip.slice(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = payload;
    else if (method === 8) data = zlib.inflateRawSync(payload);
    else throw new Error(`不支持的压缩方法 ${method}：${name}`);

    if (data.length !== size) throw new Error(`zip 条目长度不符：${name}（${data.length} != ${size}）`);
    if (crc32(data) !== crcExpected) throw new Error(`zip 条目 CRC 校验失败：${name}`);
    if (!(flags & FLAG_UTF8)) { /* 作者写的包一定是 UTF-8；读到别人的包不强制 */ }

    out.push({ name, data, size });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
