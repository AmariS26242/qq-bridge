// 表情包体系自检：
// 1) sticker-lib 纯函数（合并/查找/格式化/笔记/使用统计）
// 2) 配置项与 MCP 工具描述存在性
// 3) 可选 live 模式：QQ_BRIDGE_TEST_LIVE=1 时调用 SnowLuma 拉取收藏表情并验证 safeFetchBuffer 可抓图
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeStickerEntry,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerContextDetailed,
  buildStickerStrategyHint,
  buildStickerNudge,
  applyStickerNote,
  markStickerUsed,
  markStickersShown
} from '../src/sticker-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

console.log('## sticker-lib 纯函数');
{
  const raw = normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'abc', desc: '笑死', localNote: '嘲讽', tags: ['怼人'] });
  ok(raw && raw.id === 'a' && raw.desc === '笑死' && raw.localNote === '嘲讽', 'normalizeStickerEntry 基本字段');
  ok(normalizeStickerEntry({}) === null, '空记录返回 null');
}

{
  const base = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '' }
  ]);
  ok(base.length === 2, 'merge 新增两条');
  const merged = mergeStickerLibrary(base, [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a2', md5: 'ABC', desc: '笑哭' }
  ]);
  ok(merged.length === 1, 'merge 会移除 QQ 端已删除的表情');
  ok(merged[0].id === 'a' && merged[0].url === 'https://x/a2' && merged[0].desc === '笑哭', 'merge 更新 QQ 字段');
  // 每 60s 一次的表情库同步会整表覆盖：本地字段（次数/时间戳/备注）必须活下来，
  // 否则 lastShownAt 每同步一次就归零，推荐轮转直接失效。
  const tracked = mergeStickerLibrary([], [{ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }])
    .map((e) => normalizeStickerEntry({ ...e, useCount: 4, lastUsedAt: 1234567890, lastShownAt: 1234567999, localNote: '嘲讽' }));
  const resynced = mergeStickerLibrary(tracked, [{ emoji_id: 'a', resId: 'a', url: 'https://x/a2', md5: 'ABC', desc: '笑哭' }]);
  ok(
    resynced[0].useCount === 4 && resynced[0].lastUsedAt === 1234567890
      && resynced[0].lastShownAt === 1234567999 && resynced[0].localNote === '嘲讽',
    'QQ 同步不清空本地使用/露脸记录'
  );
}

{
  const list = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' }
  ]);
  ok(findSticker(list, 'a')?.id === 'a', '按 emoji_id 查找');
  ok(findSticker(list, 'abc')?.id === 'a', '按 md5 大小写不敏感查找');
  ok(findSticker(list, 'https://x/b')?.id === 'b', '按 URL 查找');
  ok(findSticker(list, '不存在') === null, '找不到返回 null');
}

{
  const list = [
    normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }),
    normalizeStickerEntry({ emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' }),
    normalizeStickerEntry({ emoji_id: 'c', resId: 'c', url: 'https://x/c', md5: 'GHI', desc: '', localNote: '无语' })
  ];
  const all = formatStickerList(list, '', 10);
  ok(all.total === 3 && all.stickers.length === 3, 'formatStickerList 总数');
  const q = formatStickerList(list, '生气', 10);
  ok(q.matched === 1 && q.stickers[0].id === 'b', 'formatStickerList 按备注搜索');
  const q2 = formatStickerList(list, '无语', 10);
  ok(q2.matched === 1 && q2.stickers[0].id === 'c', 'formatStickerList 按本地笔记搜索');
  const ctx = buildStickerContext(list, 8);
  ok(ctx.includes('笑死') && ctx.includes('生气'), 'buildStickerContext 包含备注');
  ok(buildStickerStrategyHint().includes('qq_send_sticker'), '策略提示包含发送工具');
}

{
  const list = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }
  ]);
  const noted = applyStickerNote(list, 'a', { note: '嘲讽用', tags: ['怼人'], usage: '别人犯蠢时' });
  ok(noted.entry.localNote === '嘲讽用' && noted.entry.tags.includes('怼人'), 'applyStickerNote 写入本地认知');
  const used = markStickerUsed(noted.entries, 'a', '接梗');
  ok(used.entry.useCount === 1 && used.entry.lastContext === '接梗', 'markStickerUsed 记录使用');
}

console.log('## 配置文件');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const tools = cfg.socialV2?.tools ?? {};
  ok(tools.listStickers === true, 'config listStickers=true');
  ok(tools.getStickerImage === true, 'config getStickerImage=true');
  ok(tools.sendSticker === true, 'config sendSticker=true');
  ok(tools.stickerNote === true, 'config stickerNote=true');
  ok(tools.setStickerRemark === false, 'config setStickerRemark=false（默认禁用）');
  ok(cfg.socialV2?.sticker?.enabled === true, 'config sticker.enabled=true');
  ok(!('sendCaptionMaxChars' in (cfg.socialV2?.sticker ?? {})), 'config sticker 不再包含 sendCaptionMaxChars');
}

console.log('## 表情单气泡约束');
{
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  // 注意：'qq_send_sticker' 现在也出现在 core 工具清单里（前面的注册期白名单），
  // 所以必须取**最后一次**出现（真正的 registerTool 描述+参数块），否则切片会倒退成空串。
  const sendIdx = mcp.lastIndexOf("'qq_send_sticker',");
  const sendStickerBlock = sendIdx >= 0 ? mcp.slice(sendIdx, sendIdx + 1500) : '';
  ok(!sendStickerBlock.includes('message: z.string()'), 'qq_send_sticker MCP 不再接受 message 参数');
  ok(sendStickerBlock.includes('不能在同一气泡里附带文字'), 'qq_send_sticker 描述强调单气泡');
  const hint = buildStickerStrategyHint();
  ok(hint.includes('不能在同一气泡里附带文字'), '策略提示禁止同气泡混文字');
  ok(!hint.includes('先发一句话再发一张'), '策略提示不再引导“先发一句话再发一张”');
}

console.log('## 表情包频率提醒');
{
  ok(buildStickerNudge({ hasStickerLibrary: false }) === '', '没有表情库不提醒');
  ok(buildStickerNudge({ lastStickerAt: 0, aiTurnsSinceSticker: 1 }) === '', '只说了 1 次不催');
  const cold = buildStickerNudge({ lastStickerAt: 0, aiTurnsSinceSticker: 2 });
  ok(cold.includes('还没发过表情') && cold.includes('2 句'), '从未发表情且连说 2 次 → 提醒');
  const coldLong = buildStickerNudge({ lastStickerAt: 0, aiTurnsSinceSticker: 55 });
  ok(coldLong.includes('好几句'), '历史发言很多时不报巨大数字');
  const gap = buildStickerNudge({ lastStickerAt: Date.now() - 60000, aiTurnsSinceSticker: 3, minutesSinceSticker: 1 });
  ok(gap.includes('连着 3 次发言没配表情'), '连发未配表情 → 提醒');
  const longGap = buildStickerNudge({ lastStickerAt: Date.now() - 3600000, aiTurnsSinceSticker: 0, minutesSinceSticker: 60 });
  ok(longGap.includes('60 分钟'), '长时间没发表情 → 提醒');
  ok(buildStickerNudge({ lastStickerAt: Date.now() - 60000, aiTurnsSinceSticker: 0, minutesSinceSticker: 5 }) === '', '刚发过且间隔不长不催');
  ok(buildStickerNudge({ lastStickerAt: 0, aiTurnsSinceSticker: 3, everyAiTurns: 4 }) === '', '阈值可配置');
  const hintFreq = buildStickerStrategyHint();
  ok(hintFreq.includes('每 1~2 轮'), '策略提示频率已上调到 1~2 轮');
  ok(hintFreq.includes('别等点名'), '策略提示强调别等对方点名');
}

console.log('## 表情包多样化（反重复）');
{
  // 20 张库：前 3 张用过很多次（正反馈的典型受害者），其余 17 张从没用过。
  const makeList = () => {
    const arr = [];
    for (let i = 0; i < 20; i += 1) {
      arr.push(normalizeStickerEntry({
        emoji_id: `s${i}`,
        resId: `s${i}`,
        url: `https://x/s${i}`,
        md5: `M${i}`,
        desc: `表情${i}`,
        useCount: i < 3 ? 10 - i : 0,
        lastUsedAt: i < 3 ? Date.now() - 86400000 : 0
      }));
    }
    return arr;
  };
  const list = makeList();
  const ctx = buildStickerContext(list, 10);
  ok(ctx.includes('id='), 'buildStickerContext 每条带 id，可直接发送');
  ok((ctx.match(/^- /gm) || []).length === 10, '按 promptMaxStickers 数量列出');
  ok(/表情(?:[3-9]|1[0-9])/.test(ctx), '包含没用过的表情（不再只推常用的那几张）');
  const a = buildStickerContext(list, 10, { seed: 'x' });
  const b = buildStickerContext(list, 10, { seed: 'x' });
  ok(a === b, '同 seed 输出稳定');
  const c = buildStickerContext(list, 10, { seed: 'y' });
  ok(a !== c, '换 seed 会换一批推荐');
  const variety = new Set([1, 2, 3, 4, 5, 6].map((n) => buildStickerContext(list, 10, { seed: String(n) })));
  ok(variety.size >= 3, `多轮唤醒的推荐组合在变（${variety.size} 种）`);
  const excluded = buildStickerContext(list, 10, { seed: 'x', recentIds: ['s0', 's1', 's2'] });
  ok(!/- 表情[012]（/.test(excluded), '本会话最近用过的被排除');
  const allFresh = buildStickerContext(list, 10, { seed: 'x', freshRatio: 1 });
  ok(!/（用过\d+次）/.test(allFresh), 'freshRatio=1 只推新鲜表情');
  const smallCtx = buildStickerContext(makeList().slice(0, 3), 10);
  ok((smallCtx.match(/^- /gm) || []).length === 3, '小库时全部列出');
  const allRecent = buildStickerContext(list, 5, { seed: 'x', recentIds: list.map((e) => e.id) });
  ok(allRecent.length > 0 && (allRecent.match(/^- /gm) || []).length > 0, '全被排除时不返回空');
}

console.log('## 推荐轮转覆盖全库（治「123 张里 101 张从没被选中」）');
{
  // 用真实体量（123 张一次都没用过）模拟连续唤醒：每轮把推过的记进 lastShownAt。
  // 旧实现里「没被选中」不影响下一轮，覆盖率全靠运气；现在应该稳定地整库铺一遍。
  const big = [];
  for (let i = 0; i < 123; i += 1) {
    big.push(normalizeStickerEntry({
      emoji_id: `b${i}`, resId: `b${i}`, url: `https://x/b${i}`, md5: `B${i}`, desc: `表情${i}`
    }));
  }
  let lib = big;
  const rounds = [];
  const seen = new Set();
  for (let round = 1; round <= 20; round += 1) {
    const built = buildStickerContextDetailed(lib, 10, { seed: `wake:${round}` });
    rounds.push(built.pickedIds.map(String));
    built.pickedIds.forEach((id) => seen.add(String(id)));
    lib = markStickersShown(lib, built.pickedIds);
  }
  ok(seen.size === 123, `20 轮唤醒铺满全库（${seen.size}/123）`);
  ok(rounds.every((ids) => ids.length === new Set(ids).size), '同一轮内不重复推荐');
  ok(rounds[0].every((id) => !rounds[1].includes(id)), '相邻两轮不重复推荐');
  // 被推过但没被发的，useCount 必须还是 0：推荐不等于使用，否则又变成正反馈。
  const shownOnly = lib.find((e) => e.useCount > 0);
  ok(!shownOnly, 'markStickersShown 不污染 useCount');
  const shownIdle = lib.every((e) => !e.lastShownAt || e.lastShownAt > 0);
  ok(shownIdle, 'lastShownAt 已写入（可持久化轮转顺序）');
}

console.log('## MCP 工具描述存在性');
{
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  for (const name of ['qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker', 'qq_sticker_note', 'qq_set_sticker_remark']) {
    ok(mcp.includes(`'${name}'`) || mcp.includes(`"${name}"`), `MCP 工具 ${name} 已注册`);
  }
}

console.log('## bridge 路由/函数存在性');
{
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  for (const s of ['/api/socialV2/sticker-list', '/api/socialV2/sticker-image', '/api/socialV2/sticker-note', '/api/socialV2/send-sticker', '/api/socialV2/sticker-remark', '/api/stickers', 'syncStickerLibrary', 'sendStickerV2']) {
    ok(bridge.includes(s), `bridge 包含 ${s}`);
  }
}

if (process.env.QQ_BRIDGE_TEST_LIVE === '1') {
  console.log('## live：SnowLuma 收藏表情链路');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json', ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}) };
    const res = await fetch(`${base}/fetch_custom_face_detail`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ count: 5 }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json();
    ok(res.ok && body.status === 'ok' && body.retcode === 0, 'fetch_custom_face_detail 调用成功');
    const items = Array.isArray(body.data) ? body.data : [];
    ok(items.length > 0, `返回 ${items.length} 个收藏表情`);
    if (items.length > 0) {
      const { safeFetchBuffer } = await import('../src/safe-fetch.js');
      try {
        const img = await safeFetchBuffer(items[0].url, 4 * 1024 * 1024);
        ok(img.buffer.length > 0, `可抓取表情图片字节（${img.buffer.length} bytes）`);
      } catch (e) {
        ok(false, `safeFetchBuffer 抓取表情失败: ${e.message}`);
      }
    }
  } catch (e) {
    ok(false, `live 链路异常: ${e.message}`);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
