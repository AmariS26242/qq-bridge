# 日记本（diary）

> 一个会话一本子，一天一页，AI 自己写给自己看。人设第 17 条要它，自动写唤醒每天到点递一次机会。

## 是什么、不是什么

- **是**：长记忆之外的「私人记录」。AI 被 `diary` 唤醒时把当天真正在意的片段写进本子；被问「你日记写了啥」时可以翻出来说，也可以藏着。
- **不是**：聊天摘要、记忆库、控制台操作日志。日记正文不自动发到 QQ，写进去只有本子里有。

## 文风：像人写日记（防 AI 腔）

第一版日记被用户评价「AI 感太重」（模板开场「今天最想记的一件事：」、结尾总结道理、「不是…是…」式议论、把自己当分析对象复盘、写进报错和桥接元信息）。现在同一套规则写进两处：

- `src/bridge.js` 的 `reason === 'diary'` 唤醒提示（每次自动写都会原样下发）。
- 人格卡第 17 条（`dsh/agent-presets/qq-chat-v2/agent.cordis.yml:41`）。

规则摘要：

- 禁模板开场（「今天最想记的一件事」「今天和群友聊了…」）；不总结、不升华、不下道理。
- 禁 AI 连接句：「不是…而是…」「更像…」「其实…」「突然觉得…」；别把自己当分析对象复盘。
- 要具体：几点、在哪、手上干什么、谁的原话；一句一行、句子可不完整、写两个字就停。
- 1~3 小段、≤300 字；没东西就不写，不硬凑。
- 不写工具/报错/程序/模拟/本体/令牌——日记是日子，不是运行日志。
- title 可省，别写文艺四字短语；mood/weather 可不填。

`state/diary/private_100000001.json` 的 2026-10-23 页已按此重写，可对照看差别。

## 数据落盘

```
state/diary/<kind>_<id>.json      # 一个会话一个文件，如 group_100000002.json
```

- 结构：`{ version, key, kind, targetId, createdAt, updatedAt, pages: [...] }`，每页 `{ id, date, title, text, mood, weather, tags, source, createdAt, updatedAt }`。
- 目录由 `cfg.socialV2.diary.dir` 决定（默认 `state/diary`，相对路径按仓库根解析）。
- 原子写（tmp + rename）；文件坏掉时**拒绝覆盖**（`loadNotebook` 抛错，读取端只报错不写），避免一处 JSON 损坏把整本历史冲掉。
- 一天一页：同一天再写默认追加（`\n\n` 分隔），`replace: true` 整页替换。每个本子上限 `maxPagesPerNotebook`（默认 2000）页，超了从头丢最旧的。

## 配置（`config.json` → `socialV2.diary`）

```json
"diary": {
  "enabled": true,
  "dir": "state/diary",
  "autoWrite": { "enabled": true, "clock": "23:30", "tickMs": 120000, "minMessages": 1, "maxPagesPerDay": 1 },
  "maxPagesPerNotebook": 2000,
  "maxPageChars": 4000,
  "maxTextChars": 1200
}
```

| 键 | 作用 |
| --- | --- |
| `enabled` | 功能总开关；关掉后自动写停、三个工具调用一律 403「日记功能已关闭」（工具**仍在**工具面里，要从工具面移除请用 `socialV2.tools.diary=false`） |
| `autoWrite.clock` | 每天几点递「写日记」唤醒（`HH:MM`，非法值回退 23:30） |
| `autoWrite.tickMs` | 调度轮询间隔，最小 30000 |
| `autoWrite.minMessages` | 当天至少有多少条来信才值得写（默认 1） |
| `autoWrite.maxPagesPerDay` | 预留：每天最多写几页（当前实现是一天一页，写不写只看当天是否已有页） |

自动写只在 `reserved2` 模式、未暂停、`socialV2.enabled` 时跑；对每个会话满足以下条件才递唤醒：

1. 当天有来信（`recentMessages` 里非自己、时间 ≥ 当天 00:00 的条数 ≥ `minMessages`）；
2. 当天**还没有页**（有了就跳过——这是幂等的关键，重启/多 tick 都不会写第二页）；
3. 每个会话每天最多尝试 2 次（失败也不刷屏，避免把模型拖进循环）。

被唤醒后写不写由 AI 自己决定（提示词明确写「不想写就一条都不写」）。写成功或放弃后照常 `qq_mark_read` / `qq_set_wake_config` 收尾。

## AI 侧工具（MCP，挂 `memory` 组）

| 工具 | 作用 |
| --- | --- |
| `qq_diary_write(key, token, text, date?, title?, mood?, weather?, tags?, replace?)` | 写/追加当天那页 |
| `qq_diary_read(key, token, date?, from?, to?, limit?)` | 读某天、某区间或最近若干页 |
| `qq_diary_list(key, token, limit?)` | 只看目录：有哪些天、标题、篇幅 |

> 三个工具**故意注册进 `memory` 组**：线上 `mcp.toolGroups` 只含 `core/group/media/stickers/memory`，单开 `diary` 组会被静默过滤，AI 就看不到工具了（见 `TOOL_SURFACE.md` 的踩坑记录）。

## HTTP 接口

AI（带 `x-agent-token`；四道闸门：令牌 → 模式准入 → `tools.diary` → 总开关）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/socialV2/diary-write` | `{ key, text, date?, title?, mood?, weather?, tags?, replace? }`，正文/标题过敏感令牌脱敏 |
| `GET` | `/api/socialV2/diary?key=&date=&from=&to=&limit=` | 读页；`mode=list` 只返回目录（`qq_diary_list` 走这个） |

操作者（控制台令牌；带 `x-agent-token` 会被 403 挡回 AI 端点）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/diary` | 所有本子 + 统计 + 自动写配置 |
| `GET` | `/api/diary/book?key=&limit=` | 单个本子的全部页 |
| `POST` | `/api/diary/remove` | `{ key, date }` 或 `{ key, id }` 删一页（不可恢复） |
| `GET` | `/api/diary/export?key=` | 返回 `{ markdown, filename }`，控制台用 Blob 下载 |

## 控制台

「日记本」页（导航第 10 项）：左侧本子列表（页数/字数/最近日期/「今天已写」），右侧读页、按日期前缀过滤、删单页、导出 Markdown。列表与本子刷新用 `skipBook` 参数拆开，避免「刷新列表 → 自动打开本子 → 再刷新列表」的循环。

## 测试

```powershell
node scripts/test-diary.mjs      # 纯逻辑 10 例：key 映射、时区切页、追加/替换、截断、原子写、坏文件、目录扫描
node scripts/test-mcp-safe.mjs   # MCP 工具面冒烟（含三个日记工具注册）
```

## 关掉它

- 只停工具（从 AI 工具面消失）：`socialV2.tools.diary = false`，重启 DSH。
- 停自动写：`socialV2.diary.autoWrite.enabled = false`，重启桥接。
- 全停：`socialV2.diary.enabled = false`（自动写停、工具调用被拒），再考虑 `tools.diary=false` 把工具也摘掉。
