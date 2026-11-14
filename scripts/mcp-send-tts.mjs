#!/usr/bin/env node
// 02b 真机验收：用 MCP stdio 直连 src/mcp-snowluma-safe.js，调 send_tts_voice 发一条真语音。
// 用法：node scripts/mcp-send-tts.mjs <mood> <文本> [target]
// 会话 key/token 从 state/social-v2.json 读（bridge 重启后 token 会变，所以每次现读）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NODE = process.execPath;

const mood = process.argv[2] || 'calm';
const text = process.argv[3] || '小鲸鱼换声音啦，听得出来吗';
const target = process.argv[4] || '';

const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
const conv = state.conversations || {};
const key = Object.keys(conv).find((k) => k.startsWith('private:')) || Object.keys(conv)[0];
const token = conv[key]?.agentToken;
if (!key || !token) {
  console.error('没在 state/social-v2.json 里找到会话 key/token');
  process.exit(2);
}
console.log(`会话 ${key}  token ${token.slice(0, 8)}…  mood ${mood}  ${target ? `target ${target}` : ''}`);

const transport = new StdioClientTransport({
  command: NODE,
  args: [path.join(ROOT, 'src', 'mcp-snowluma-safe.js')],
  cwd: ROOT,
  stderr: 'inherit'
});
const client = new Client({ name: 'tts-check', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
const has = tools.tools.some((t) => t.name === 'send_tts_voice');
console.log(`工具清单 ${tools.tools.length} 个 · send_tts_voice ${has ? '已注册' : '缺失'}`);
if (!has) {
  await client.close();
  process.exit(3);
}

const t0 = Date.now();
const res = await client.callTool({
  name: 'send_tts_voice',
  arguments: { key, token, text, mood, ...(target ? { target } : {}) }
});
const elapsed = Date.now() - t0;
const body = res.content?.[0]?.text ?? '';
console.log(`耗时 ${elapsed} ms · isError=${Boolean(res.isError)}`);
console.log(body);
await client.close();
process.exit(res.isError ? 1 : 0);
