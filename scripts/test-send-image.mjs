// 发图能力（src/send-image-lib.js）的离线自测：不需要 SnowLuma / QQ / 网络。
//
// 覆盖的拒绝矩阵就是安全边界本身：
//   - 本地：目录白名单、../ 穿越、软链/junction 跳出、UNC/设备路径、控制字符、
//           扩展名白名单、魔数校验、空文件、体积上限
//   - 远程：只认 http/https、禁账号密码、禁内网/环回/链路本地/CGNAT、魔数校验
// 断言方式：每个用例只接受「抛错且错误信息命中关键词」，避免以后把错误放宽成静默成功。
//
// 用法：node scripts/test-send-image.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLocalImage, readRemoteImage, prepareImage, sniffImageFormat, describeImage } from '../src/send-image-lib.js';

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: String(detail ?? '').slice(0, 200) });

// 最小合法图片字节：只有魔数/头部，够 sniffImageFormat 用
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 ', 'ascii'),
  Buffer.alloc(16),
]);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-image-'));
const allowedDir = path.join(root, 'allowed');
const outsideDir = path.join(root, 'outside');
fs.mkdirSync(allowedDir, { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });

const w = (p, buf) => {
  fs.writeFileSync(p, buf);
  return p;
};
const okPng = w(path.join(allowedDir, 'ok.png'), PNG);
const okGif = w(path.join(allowedDir, 'ok.gif'), GIF);
const okJpeg = w(path.join(allowedDir, 'ok.jpg'), JPEG);
const okWebp = w(path.join(allowedDir, 'ok.webp'), WEBP);
const spoofed = w(path.join(allowedDir, 'fake.png'), Buffer.from('definitely not an image'));
const textFile = w(path.join(allowedDir, 'note.txt'), Buffer.from('hello'));
const emptyPng = w(path.join(allowedDir, 'empty.png'), Buffer.alloc(0));
const outsidePng = w(path.join(outsideDir, 'secret.png'), PNG);
const dirs = [allowedDir];

const expectThrow = async (fn, keyword, name) => {
  try {
    await fn();
    check(name, false, '本应拒绝，但成功了');
  } catch (error) {
    const msg = String(error?.message ?? error);
    check(name, msg.includes(keyword), msg);
  }
};

const expectOk = async (fn, name, assert) => {
  try {
    const got = await fn();
    check(name, assert(got), JSON.stringify({ format: got.format, bytes: got.bytes, source: got.source }));
  } catch (error) {
    check(name, false, `本应成功：${error?.message ?? error}`);
  }
};

// ── 魔数识别 ──────────────────────────────────────────────────────────────
check('魔数 png', sniffImageFormat(PNG) === 'png', sniffImageFormat(PNG));
check('魔数 jpeg', sniffImageFormat(JPEG) === 'jpeg', sniffImageFormat(JPEG));
check('魔数 gif', sniffImageFormat(GIF) === 'gif', sniffImageFormat(GIF));
check('魔数 webp', sniffImageFormat(WEBP) === 'webp', sniffImageFormat(WEBP));
check('魔数 文本→null', sniffImageFormat(Buffer.from('hello world')) === null, sniffImageFormat(Buffer.from('hello world')));
check('describeImage 格式化', describeImage({ format: 'png', bytes: 2048 }) === 'png 2KB', describeImage({ format: 'png', bytes: 2048 }));

// ── 本地白名单路径 ────────────────────────────────────────────────────────
await expectOk(() => readLocalImage(okPng, dirs, 4 * 1024 * 1024), '允许目录内 png 可读', (g) => g.format === 'png' && g.bytes > 0);
await expectOk(() => readLocalImage(okGif, dirs, 4 * 1024 * 1024), '允许目录内 gif 可读', (g) => g.format === 'gif');
await expectOk(() => readLocalImage(okJpeg, dirs, 4 * 1024 * 1024), '允许目录内 jpg 可读', (g) => g.format === 'jpeg');
await expectOk(() => readLocalImage(okWebp, dirs, 4 * 1024 * 1024), '允许目录内 webp 可读', (g) => g.format === 'webp');

// ── 本地拒绝矩阵 ──────────────────────────────────────────────────────────
await expectThrow(() => readLocalImage(okPng, [], 1024), '未配置本地图片目录', '未配 dirs 直接拒绝');
await expectThrow(() => readLocalImage('ok.png', dirs, 1024), '绝对路径', '相对路径被拒');
await expectThrow(() => readLocalImage(`\\\\server\\share\\a.png`, dirs, 1024), 'UNC', 'UNC 路径被拒');
await expectThrow(() => readLocalImage(`\\\\?\\${okPng}`, dirs, 1024), 'UNC', '设备命名空间 \\\\?\\ 被拒');
await expectThrow(() => readLocalImage(`${okPng}\u0000.txt`, dirs, 1024), '控制字符', 'NUL 截断被拒');
await expectThrow(() => readLocalImage(path.join(allowedDir, '..', 'outside', 'secret.png'), dirs, 1024), '不在允许的目录内', '../ 穿越被拒');
await expectThrow(() => readLocalImage(path.join(allowedDir, '..', 'nope', 'x.png'), dirs, 1024), '不存在', '../ 到不存在路径被拒');
await expectThrow(() => readLocalImage(outsidePng, dirs, 1024), '不在允许的目录内', '允许目录外的文件被拒');
await expectThrow(() => readLocalImage(textFile, dirs, 1024), '只允许发送图片文件', '.txt 扩展名被拒');
await expectThrow(() => readLocalImage(spoofed, dirs, 1024), '不是有效图片', '文本改名为 .png 被拒');
await expectThrow(() => readLocalImage(emptyPng, dirs, 1024), '空文件', '空文件被拒');
await expectThrow(() => readLocalImage(okPng, dirs, 10), '超过大小限制', '超体积被拒');
await expectThrow(() => readLocalImage(allowedDir, dirs, 1024), '不在允许的目录内', '目录本身被拒');

// 软链接/junction 逃逸：Windows 上普通用户可能建不了符号链接，建不了就跳过（不算失败）
const linkPath = path.join(allowedDir, 'escape');
let linkMade = false;
try {
  fs.symlinkSync(outsideDir, linkPath, 'junction');
  linkMade = true;
} catch {
  try {
    fs.symlinkSync(outsideDir, linkPath, 'dir');
    linkMade = true;
  } catch { /* 没有权限，跳过 */ }
}
if (linkMade) {
  await expectThrow(() => readLocalImage(path.join(linkPath, 'secret.png'), dirs, 1024), '不在允许的目录内', 'junction 跳出目录被拒');
} else {
  check('junction 跳出目录被拒', true, '跳过（当前账号无建链权限）');
}

// ── 远程拒绝矩阵（全部在发起网络请求前就该拒绝）─────────────────────────────
await expectThrow(() => readRemoteImage('http://127.0.0.1/a.png', 1024), '内网', '回环 127.0.0.1 被拒');
await expectThrow(() => readRemoteImage('http://localhost:3100/a.png', 1024), '内网', 'localhost 被拒');
await expectThrow(() => readRemoteImage('http://10.0.0.5/a.png', 1024), '内网', '10.x 被拒');
await expectThrow(() => readRemoteImage('http://192.168.1.1/a.png', 1024), '内网', '192.168.x 被拒');
await expectThrow(() => readRemoteImage('http://172.16.0.1/a.png', 1024), '内网', '172.16.x 被拒');
await expectThrow(() => readRemoteImage('http://169.254.169.254/latest/meta-data', 1024), '内网', '云元数据 169.254 被拒');
await expectThrow(() => readRemoteImage('http://[::1]/a.png', 1024), '内网', 'IPv6 回环被拒');
await expectThrow(() => readRemoteImage('file:///etc/passwd', 1024), '只允许 http/https', 'file:// 被拒');
await expectThrow(() => readRemoteImage('ftp://example.com/a.png', 1024), '只允许 http/https', 'ftp:// 被拒');
await expectThrow(() => readRemoteImage('http://user:pass@example.com/a.png', 1024), '账号密码', 'URL 带账号密码被拒');
await expectThrow(() => readRemoteImage('', 1024), '不能为空', '空 URL 被拒');

// ── prepareImage 组合规则 ─────────────────────────────────────────────────
const cfg = { socialV2: { image: { enabled: true, dirs, maxBytes: 4 * 1024 * 1024 } } };
await expectThrow(() => prepareImage({}, cfg), '必须提供图片来源', 'url/path 都没给被拒');
await expectThrow(() => prepareImage({ url: 'https://example.com/a.png', path: okPng }, cfg), '二选一', 'url 与 path 同时给被拒');
await expectOk(() => prepareImage({ path: okPng }, cfg), 'prepareImage 走本地', (g) => g.source === 'path' && g.format === 'png');
await expectOk(() => prepareImage({ path: okPng }, { socialV2: { image: { enabled: true, dirs } } }), 'maxBytes 缺省回落到 4MB', (g) => g.maxBytes === 4 * 1024 * 1024);

// ── 汇总 ──────────────────────────────────────────────────────────────────
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.error(`\n失败 ${failed.length} 项：${failed.map((r) => r.name).join('、')}`);
  process.exit(1);
}
