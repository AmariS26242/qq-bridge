#!/usr/bin/env node
/**
 * 采样参数注入代理（LLM sampling shim）。
 *
 * 为什么需要它：
 *   DSH 这套栈里 `dsh-llm` 的 GenerateOptions 只有 temperature / maxTokens / stop，
 *   没有 top_p，更没有 presence/frequency penalty；`dsh-llm-deepseek` 的 provider 配置里
 *   也**没有** temperature 字段。也就是说 QQ 端的采样参数在 DSH 里根本没有入口。
 *   唯一能改的办法：把 provider 的 baseURL 指到本代理，由代理在请求体里补参数。
 *
 * 另一个关键事实（2026-10-22 实测）：
 *   thinking 开启时 DeepSeek 会**忽略 temperature**（temperature=0 连跑三次仍是三条不同回复），
 *   关掉 thinking 后 temperature=0 才会稳定复现。所以要让采样参数真正生效，
 *   必须同时把 thinking 关掉 —— 由 disableThinking 完成，不需要改 DSH 的 profile。
 *
 * 配置来自 qq-bridge/config.json 的 `sampling` 段，改动即时生效（按 mtime 缓存）。
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(HERE, '..', 'config.json');

const DEFAULTS = {
  enabled: true,
  listen: '127.0.0.1',
  port: 8790,
  upstream: 'https://api.deepseek.com/anthropic',
  // ⚠️ 2026-11-02 事故后固定为 false：上游新版 deepseek-flash 在 thinking=disabled 下
  // 不再返回 tool_use 块，模型改把工具调用写成纯文本 `<invoke name="...">` XML，
  // DSH 侧一个 tool/call 都不会产生 → QQ 端表现为「机器人完全不回消息」。
  // 关 thinking 原本是为了让 temperature/top_p/penalty 生效，但「能回话」优先于「采样参数」，
  // 所以 thinking 保持上游默认（开）。要复现/回滚见 state/desk-inbox/config.json.bak-20261102-1640。
  disableThinking: false,
  temperature: 1.15,
  topP: 0.95,
  presencePenalty: 0.4,
  frequencyPenalty: 0.2,
};

let cache = { mtime: 0, settings: { ...DEFAULTS } };

function stamp(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** 读 config.json 的 sampling 段；文件没变就复用上次结果。 */
function samplingSettings() {
  const fileStamp = stamp(CONFIG_FILE);
  if (fileStamp && fileStamp !== cache.mtime) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      cache = { mtime: fileStamp, settings: { ...DEFAULTS, ...(raw.sampling ?? {}) } };
    } catch (error) {
      log(`读 ${CONFIG_FILE} 失败，沿用旧配置：${error.message}`);
    }
  }
  return cache.settings;
}

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

/** 把采样参数写进请求体。 */
function inject(body, settings) {
  if (!body || typeof body !== 'object') return body;
  const patches = {};
  if (settings.disableThinking) {
    patches.thinking = { type: 'disabled' };
    delete body.output_config;
  }
  if (typeof settings.temperature === 'number') patches.temperature = settings.temperature;
  if (typeof settings.topP === 'number') patches.top_p = settings.topP;
  if (typeof settings.presencePenalty === 'number') patches.presence_penalty = settings.presencePenalty;
  if (typeof settings.frequencyPenalty === 'number') patches.frequency_penalty = settings.frequencyPenalty;
  return Object.assign(body, patches);
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const server = http.createServer((req, res) => {
  const settings = samplingSettings();
  if (!settings.enabled) {
    sendJson(res, 503, { error: 'sampling proxy disabled by config' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') {
    sendJson(res, 200, {
      ok: true,
      upstream: settings.upstream,
      params: {
        disableThinking: settings.disableThinking,
        temperature: settings.temperature,
        topP: settings.topP,
        presencePenalty: settings.presencePenalty,
        frequencyPenalty: settings.frequencyPenalty,
      },
    });
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let payload = Buffer.concat(chunks);
    const contentType = String(req.headers['content-type'] ?? '');
    if (payload.length && contentType.includes('application/json')) {
      try {
        const body = inject(JSON.parse(payload.toString('utf8')), settings);
        payload = Buffer.from(JSON.stringify(body), 'utf8');
      } catch {
        // 不是合法 JSON 就原样转发，别把请求弄坏
      }
    }

    const upstream = new URL(settings.upstream);
    const headers = { ...req.headers, host: upstream.host, 'content-length': String(payload.length) };
    delete headers['accept-encoding']; // 别让上游压缩，代理原样透传

    const target = {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: upstream.pathname.replace(/\/$/, '') + url.pathname + url.search,
      headers,
    };

    const started = Date.now();
    const mark = [
      typeof settings.temperature === 'number' ? `T=${settings.temperature}` : 'T=透传',
      typeof settings.topP === 'number' ? `top_p=${settings.topP}` : 'top_p=透传',
      settings.presencePenalty ? `presence=${settings.presencePenalty}` : '',
      settings.frequencyPenalty ? `frequency=${settings.frequencyPenalty}` : '',
      settings.disableThinking ? 'thinking=off' : '',
    ].filter(Boolean).join(' ');

    // 网络层抖动（DNS 解析失败、连接被掐）以前会立刻 502 回给 DSH；DSH 只重试 5 次、
    // 总窗口约 16s，而 2026-11-08 00:40 那次 `getaddrinfo ENOTFOUND api.deepseek.com`
    // 持续了 30s+，于是整个回合判死 —— QQ 端表现成「机器人突然不回消息」。
    // 这里在代理层补 2 次重试（间隔 5s），把容忍窗口拉到约 40s。
    // 只重试「还没拿到响应头」的网络错误：一旦上游开始回包就绝不能重发，否则重复计费/重复输出。
    const RETRYABLE = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|disconnected/i;
    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 5000;

    const attempt = (n) => {
      const proxyReq = (upstream.protocol === 'https:' ? https : http).request(target, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
        upRes.on('end', () => {
          log(`${req.method} ${url.pathname} → ${upRes.statusCode} ${Date.now() - started}ms [${mark}]${n ? `（第 ${n + 1} 次尝试）` : ''}`);
        });
      });
      proxyReq.on('error', (error) => {
        log(`${req.method} ${url.pathname} → 上游错误 ${error.message}`);
        const reason = String(error?.message ?? '') + ' ' + String(error?.code ?? '');
        if (!res.headersSent && n < MAX_RETRIES && RETRYABLE.test(reason)) {
          log(`  ↻ ${RETRY_DELAY_MS / 1000}s 后重试（${n + 1}/${MAX_RETRIES}）`);
          setTimeout(() => attempt(n + 1), RETRY_DELAY_MS);
          return;
        }
        if (!res.headersSent) sendJson(res, 502, { error: `sampling proxy upstream error: ${error.message}` });
        else res.end();
      });
      proxyReq.end(payload);
    };
    attempt(0);
  });
});

const boot = samplingSettings();
server.listen(boot.port, boot.listen, () => {
  log(`采样代理已监听 http://${boot.listen}:${boot.port}，上游 ${boot.upstream}`);
  log(`注入：thinking=${boot.disableThinking ? 'disabled' : '透传'} temperature=${boot.temperature} top_p=${boot.topP} presence=${boot.presencePenalty} frequency=${boot.frequencyPenalty}`);
});
