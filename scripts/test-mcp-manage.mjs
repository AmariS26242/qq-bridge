// 测试新增的「账号管理」与「桌面命令」MCP 工具：注册情况 + 授权边界 + 真实调用。
//
// 关键断言：在非封闭 agent 模式下，不带 key/token 的调用必须被拒绝；
// 带管理员会话 token 才放行。这样任何群成员的话都改不了机器人资料。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function ownerToken() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
    const conv = s.conversations ?? {};
    const key = Object.keys(conv).find((k) => k.startsWith('private:'));
    if (!key) return null;
    return { key, token: conv[key]?.agentToken ?? '' };
  } catch {
    return null;
  }
}

const owner = ownerToken();
const entry = fileURLToPath(new URL('../src/mcp-snowluma-safe.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-manage-test', version: '0.1.0' });

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail: String(detail ?? '').slice(0, 220) });

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const name of ['qq_set_avatar', 'qq_set_profile', 'qq_set_signature', 'qq_desk_command']) {
    check(`注册 ${name}`, tools.includes(name), tools.includes(name) ? '在工具表里' : `缺失（现有 ${tools.length} 个）`);
  }

  const text = (r) => r?.content?.map((c) => c.text ?? '').join('\n') ?? '';

  // 1) 不带凭据：必须被拒绝（当前是 reserved2，不是封闭 agent）
  const noAuth = await client.callTool({ name: 'qq_set_signature', arguments: { text: '越权测试' } });
  check('无凭据改签名被拒', noAuth.isError === true && text(noAuth).includes('未授权'), text(noAuth));

  // 2) 假 token：必须被拒绝
  const badToken = await client.callTool({ name: 'qq_set_signature', arguments: { text: '越权测试', key: owner?.key ?? 'private:0', token: 'f'.repeat(48) } });
  check('假 token 被拒', badToken.isError === true && text(badToken).includes('未授权'), text(badToken));

  if (owner?.token) {
    // 3) 真 token + 不存在的头像文件：授权通过，但参数校验要给出清楚报错（不会真的改头像）
    const badPath = await client.callTool({ name: 'qq_set_avatar', arguments: { file: 'C:\\definitely-not-here\\x.png', key: owner.key, token: owner.token } });
    const badText = text(badPath);
    check('真 token 通过鉴权+路径校验', badText.includes('找不到') || badText.includes('不存在'), badText);

    // 4) 桌面命令：只入队不投递（不打扰桌面会话）
    const desk = await client.callTool({ name: 'qq_desk_command', arguments: { command: '列一下 D 盘根目录（只读）', reason: 'MCP 通道自测', deliver: false, key: owner.key, token: owner.token } });
    const deskText = text(desk);
    check('qq_desk_command 入队成功', /入队|投递/.test(deskText) && /风险分/.test(deskText), deskText);
  } else {
    check('找到管理员会话 token', false, 'state/social-v2.json 里没有 private:* 会话');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, results, tools: tools.length }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
} catch (error) {
  console.error('❌ 测试失败:', error?.message ?? error);
  process.exit(1);
}
