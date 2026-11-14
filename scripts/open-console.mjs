#!/usr/bin/env node
// open-console.mjs — 打开本地控制台（带 token），失败时给出可执行的下一步。
//
// 为什么需要它：控制台（127.0.0.1:3100）开了 token 鉴权，裸地址会 401；
// token 在 state/console-token 里，而且桥接重启后可能重新生成 —— 所以入口不能是
// 一个写死 token 的书签，必须是「每次现读 token 再拼 URL」的启动器。
//
// 用法：
//   node scripts/open-console.mjs            读取 token 并打开默认浏览器
//   node scripts/open-console.mjs --print    只打印 URL（脚本/快捷方式调试用）
//   node scripts/open-console.mjs --check    只检查控制台是否在线（0=在线，3=离线）
//
// 退出码：0 成功；2 token 缺失；3 控制台没在监听。

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOKEN_FILE = path.join(ROOT, 'state', 'console-token');
const HOST = '127.0.0.1';
const PORT = 3100;

const args = new Set(process.argv.slice(2).map((a) => a.toLowerCase()));
const printOnly = args.has('--print') || args.has('--no-open');
const checkOnly = args.has('--check');

// 每次启动留一行足迹：快捷方式走的是隐藏窗口，出错时用户看不到任何输出，
// 这行日志是唯一能回看「入口到底有没有跑到」的证据。
function note(message) {
  try {
    fs.appendFileSync(path.join(ROOT, 'state', 'open-console.log'),
      `${new Date().toLocaleString('zh-CN', { hour12: false })} [${process.argv.slice(2).join(' ') || 'open'}] ${message}\n`, 'utf8');
  } catch { /* 日志写不了不影响打开 */ }
}

function portOpen(port, host = HOST, timeout = 900) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

function readToken() {
  try {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

const online = await portOpen(PORT);
if (checkOnly) {
  note(online ? 'check: online' : 'check: offline');
  console.log(online ? `控制台在线：http://${HOST}:${PORT}` : `控制台未运行（${HOST}:${PORT} 没有监听）`);
  process.exit(online ? 0 : 3);
}

if (!online) {
  note('abort: port closed');
  console.error(`控制台没在运行（${HOST}:${PORT} 没有监听）。`);
  console.error('桥接可能停了，先启动它：');
  console.error('  node qqbot.mjs up        （或双击 qqbot\\start-qqbot.bat）');
  process.exit(3);
}

const token = readToken();
if (!token) {
  note('abort: token missing');
  console.error(`找不到控制台 token：${TOKEN_FILE}`);
  console.error('桥接启动时会自动生成；如果桥接从没启动过，先 node qqbot.mjs up。');
  process.exit(2);
}

const url = `http://${HOST}:${PORT}/?token=${encodeURIComponent(token)}`;

// 顺手刷新「双击即进」的入口页：桥接启动时也会写，这里再写一次是为了
// 「改了 token 但桥接还没重启」时入口页不会拿着旧 token 跳到 401。
function writeLauncherHtml() {
  try {
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>QQ 控制台</title>
<meta http-equiv="refresh" content="0;url=${url}">
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#141414;color:#e8e8e8;
       font:14px/1.7 "Segoe UI","Microsoft YaHei",sans-serif}
  a{color:#5ac8fa}
  .box{max-width:520px;padding:24px;text-align:center}
</style></head>
<body><div class="box">
<p>正在打开 QQ 控制台…</p>
<p>如果没有自动跳转，<a href="${url}">点这里</a>。</p>
<p style="opacity:.6">本文件由桥接在启动 / 重置令牌时自动生成，请勿手改。</p>
</div></body></html>`;
    fs.writeFileSync(path.join(ROOT, 'state', 'console-open.html'), html, 'utf8');
  } catch { /* 写不了不影响其他用法 */ }
}
writeLauncherHtml();

if (printOnly) {
  note('print url');
  console.log(url);
  process.exit(0);
}

// 走到这里就是真的在开浏览器：先记一行，隐藏窗口启动时这是唯一线索。
note('open url');

// Windows 开浏览器的现实：`cmd /c start "" <url>` 在这台机器上静默失效（空标题参数被吞，
// start 把 URL 当窗口标题），`rundll32 url.dll,FileProtocolHandler` 在 wscript 隐藏窗口下
// 也不总能拉起窗口。所以改成「先直接起默认浏览器的 exe，再依次兜底」：
//   1) 读注册表 UserChoice ProgId → HKCR\<ProgId>\shell\open\command 里的 exe，直启；
//   2) rundll32 url.dll,FileProtocolHandler；
//   3) explorer.exe <url>。
// 每一步的结果都写进 state/open-console.log，避免再出现「点了没反应但不知道卡在哪」。
function regValue(argv) {
  const r = spawnSync('reg.exe', argv, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout) return null;
  const m = /(?:REG_SZ|REG_EXPAND_SZ)\s+(.+?)\s*$/m.exec(r.stdout);
  return m ? m[1].trim() : null;
}

function defaultBrowserExe() {
  const progId = regValue(['query',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
    '/v', 'ProgId']);
  if (!progId) return null;
  const command = regValue(['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve']);
  if (!command) return null;
  const quoted = /^"([^"]+)"/.exec(command);
  if (quoted && fs.existsSync(quoted[1])) return quoted[1];
  const bare = command.split(/[\s,]+/)[0];
  return bare && fs.existsSync(bare) ? bare : null;
}

function spawnDetached(exe, argv) {
  return spawn(exe, argv, { detached: true, stdio: 'ignore', windowsHide: true });
}

// 返回是否成功；每次尝试等 700ms 捕捉 ENOENT 之类的异步 error。
async function tryOpen(exe, argv, label) {
  const child = spawnDetached(exe, argv);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      setTimeout(resolve, 700);
    });
  } catch (error) {
    note(`opener failed: ${label}: ${error?.message ?? error}`);
    return false;
  }
  child.unref();
  note(`opened via ${label}`);
  return true;
}

async function openBrowser(target) {
  if (process.platform === 'win32') {
    const exe = defaultBrowserExe();
    if (exe && await tryOpen(exe, [target], exe)) return true;
    if (await tryOpen('rundll32.exe', ['url.dll,FileProtocolHandler', target], 'rundll32')) return true;
    if (await tryOpen('explorer.exe', [target], 'explorer')) return true;
    note('opener failed: all');
    return false;
  }
  const opened = await tryOpen(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], 'shell-open');
  return opened;
}

if (await openBrowser(url)) {
  console.log(`已打开控制台：http://${HOST}:${PORT}`);
} else {
  console.error('没能自动打开浏览器（可能被安全软件拦了或默认浏览器关联异常）。');
  console.error('手动打开下面这个地址即可：');
  console.error(`  ${url}`);
  process.exit(1);
}
