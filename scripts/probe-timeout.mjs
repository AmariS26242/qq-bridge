#!/usr/bin/env node
// 超时路径探针：指向不可达地址 + 1.5s 超时，确认能在超时上限内抛可读错误（不拖到桥接 300s）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesize, removeQuietly } from '../src/voice-tts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
cfg.voiceTts.engine = 'minimax';
cfg.voiceTts.minimax.baseUrl = 'http://10.255.255.1:81';
cfg.voiceTts.minimax.timeoutMs = 1500;

const t0 = Date.now();
try {
  const r = await synthesize('超时测试', 'calm', cfg);
  console.log(`意外成功 ${JSON.stringify({ seconds: r.seconds })}`);
  removeQuietly(r.filePath);
  process.exit(1);
} catch (error) {
  const ms = Date.now() - t0;
  const msg = String(error?.message ?? error);
  console.log(`耗时 ${ms}ms`);
  console.log(`错误：${msg}`);
  const left = fs.existsSync(cfg.voiceTts.tmpDir ?? path.join(ROOT, 'state', 'tmp', 'voice'))
    ? fs.readdirSync(path.join(ROOT, 'state', 'tmp', 'voice')).filter((f) => f.startsWith('tts-'))
    : [];
  console.log(`残留临时文件：${left.length}`);
  process.exit(msg.includes('MiniMax 请求失败') && ms < 12000 && left.length === 0 ? 0 : 1);
}
