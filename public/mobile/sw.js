/* QQ 后台手机版 Service Worker
 *
 * 只做两件事：让页面达到「可安装 PWA」的条件，以及断网时给一个离线提示。
 * 刻意**不缓存任何接口或页面**：这个后台看的是实时状态，缓存一秒钟都是错的。
 */
'use strict';

const OFFLINE_HTML = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>离线</title><body style="background:#0b1013;color:#e6eef2;font:16px -apple-system,sans-serif;padding:24px">'
  + '<h3>连不上 QQ 桥</h3><p style="color:#8fa3ae">手机没网，或者电脑那头桥没在跑。恢复后点重试。</p>'
  + '<button onclick="location.reload()" style="font:inherit;padding:10px 16px;border-radius:12px;border:1px solid #24313a;background:#1a242a;color:#e6eef2">重试</button></body>';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    fetch(req).catch(() => {
      if (req.mode === 'navigate') {
        return new Response(OFFLINE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return new Response('', { status: 503, statusText: 'offline' });
    })
  );
});
