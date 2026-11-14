// 发送普通图片的「读图」安全库：只负责把「来源」变成可信的图片字节，不负责发送。
//
// 两类来源：
// 1. http(s) 直链 —— 复用 safe-fetch.js（禁止内网/环回/链路本地/CGNAT、DNS 固定、
//    逐跳校验重定向、限量读取、魔数校验），这里只做参数收敛。
// 2. 本地文件 —— **只允许 config.socialV2.image.dirs 里列出的目录**：
//    - 必须绝对路径，拒绝 UNC / 设备路径（\\?\、\\.\）
//    - realpath 后再做包含判断，挡住 ../ 穿越、软链接、junction 跳出目录
//    - 扩展名白名单 + 魔数校验（改扩展名骗不过去）
//    - 体积上限，且以「真正读到的字节数」为准
//
// 设计原则：任何一条不满足就**拒绝并说清原因**，不做「尽量发出去」的兜底。
import fs from 'node:fs';
import path from 'node:path';
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** 读取 image 配置段（默认值写死在这里，避免 bridge 与 MCP 两边各猜一套）。 */
export function imageCfg(cfg) {
  const c = cfg?.socialV2?.image ?? {};
  const dirs = Array.isArray(c.dirs) ? c.dirs.map((d) => String(d ?? '').trim()).filter(Boolean) : [];
  const maxBytesRaw = Number(c.maxBytes);
  return {
    enabled: c.enabled !== false,
    dirs,
    // 与 MAX_MEDIA_BYTES（4MB）保持一致：再大 base64 之后单条 JSON 会明显变重。
    maxBytes: Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? maxBytesRaw : 4 * 1024 * 1024,
  };
}

/** 按魔数判断图片格式；不认识返回 null。 */
export function sniffImageFormat(buf) {
  if (!looksLikeImageBuffer(buf)) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  return 'webp';
}

export function describeImage({ format, bytes }) {
  const kb = bytes / 1024;
  return `${format} ${kb >= 1024 ? (kb / 1024).toFixed(2) + 'MB' : Math.round(kb) + 'KB'}`;
}

/** 判定 child 是否真的在 dir 里面（两者都必须是 realpath 之后的绝对路径）。 */
function isInside(dir, child) {
  const rel = path.relative(dir, child);
  if (!rel) return false; // 就是目录本身，不是文件
  if (path.isAbsolute(rel)) return false; // 换盘符
  const first = rel.split(/[\\/]/)[0];
  return first !== '..';
}

/**
 * 解析并读取本地图片。dirs 为空 ⇒ 直接拒绝（默认不开放任何本地目录）。
 * 返回 { path, bytes, buffer, format, dir }；不满足任何一条约束就抛错。
 */
export function readLocalImage(input, dirs, maxBytes) {
  if (!dirs || !dirs.length) {
    throw new Error('未配置本地图片目录：如需发送本地图片，请在 config.socialV2.image.dirs 里显式列出允许的目录');
  }
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('本地图片路径不能为空');
  // 控制字符 / NUL 截断攻击；UNC 与 Windows 设备命名空间一律拒绝。
  if (/[\u0000-\u001f]/.test(raw)) throw new Error('本地图片路径包含控制字符，已拒绝');
  if (raw.startsWith('\\\\') || raw.startsWith('//')) throw new Error('不支持 UNC/网络路径，只允许本机目录内的文件');
  if (!path.isAbsolute(raw)) throw new Error('本地图片必须传绝对路径');

  let real;
  try {
    real = fs.realpathSync(path.resolve(raw));
  } catch {
    throw new Error('本地图片不存在或无法访问');
  }

  // 目录也要 realpath：允许把「允许目录」写成软链接，但比较永远在真实路径上进行。
  const allowed = [];
  for (const dir of dirs) {
    try {
      allowed.push(fs.realpathSync(dir));
    } catch {
      // 配置里的目录不存在就跳过，不因此放开别的目录
    }
  }
  if (!allowed.length) throw new Error('配置的本地图片目录都不存在或不可访问');
  const matched = allowed.find((dir) => isInside(dir, real));
  if (!matched) throw new Error('本地图片不在允许的目录内（config.socialV2.image.dirs）');

  const ext = path.extname(real).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) throw new Error(`只允许发送图片文件（${[...IMAGE_EXTS].join(' ')}），当前扩展名 ${ext || '无'}`);

  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new Error('本地图片不存在或无法访问');
  }
  if (!stat.isFile()) throw new Error('目标不是普通文件');

  // 先看 stat 体积再读：避免为了报错去读一个几个 GB 的文件。
  if (stat.size <= 0) throw new Error('图片是空文件');
  if (stat.size > maxBytes) throw new Error(`图片超过大小限制（${stat.size} > ${maxBytes} 字节）`);

  let buffer;
  try {
    buffer = fs.readFileSync(real);
  } catch {
    throw new Error('读取本地图片失败');
  }
  // TOCTOU：以实际读到的字节数为准再判一次。
  if (buffer.length > maxBytes) throw new Error(`图片超过大小限制（${buffer.length} > ${maxBytes} 字节）`);
  const format = sniffImageFormat(buffer);
  if (!format) throw new Error('文件内容不是有效图片（PNG/JPEG/GIF/WebP）');

  return { path: real, bytes: buffer.length, buffer, format, dir: matched };
}

/** 抓取远程图片（复用 safe-fetch 的 SSRF 防护与魔数校验）。 */
export async function readRemoteImage(url, maxBytes) {
  const raw = String(url ?? '').trim();
  if (!raw) throw new Error('图片 URL 不能为空');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('图片 URL 无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只允许 http/https 图片直链');
  if (parsed.username || parsed.password) throw new Error('URL 不能包含账号密码');
  const { url: finalUrl, buffer } = await safeFetchBuffer(raw, maxBytes);
  const format = sniffImageFormat(buffer);
  if (!format) throw new Error('远程内容不是有效图片（PNG/JPEG/GIF/WebP）');
  return { url: finalUrl, bytes: buffer.length, buffer, format };
}

/**
 * 统一入口：body 里 { url } 或 { path }（二选一，同时给就报错）。
 * 返回 { source: 'url'|'path', label, bytes, buffer, format, ... }。
 */
export async function prepareImage(body, cfg) {
  const image = imageCfg(cfg);
  const hasUrl = typeof body?.url === 'string' && body.url.trim() !== '';
  const hasPath = typeof body?.path === 'string' && body.path.trim() !== '';
  if (hasUrl && hasPath) throw new Error('url 和 path 只能二选一');
  if (!hasUrl && !hasPath) throw new Error('必须提供图片来源：url（http/https 直链）或 path（允许目录内的本地绝对路径）');

  if (hasUrl) {
    const got = await readRemoteImage(body.url, image.maxBytes);
    return { source: 'url', label: got.url, ...got, maxBytes: image.maxBytes };
  }
  const got = readLocalImage(body.path, image.dirs, image.maxBytes);
  return { source: 'path', label: got.path, ...got, maxBytes: image.maxBytes };
}
