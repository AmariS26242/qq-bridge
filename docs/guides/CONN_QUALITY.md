# 连接质量看板

SnowLuma 的 OneBot WebSocket 会静默断开又静默重连（常见 `code=1006`，间隔 3–10 分钟）。
以前只有翻 `state/bridge.log` 才知道；现在断线/重连被记成事件，控制台「运行总览」有一张
**连接质量**卡片，`/api/conn-quality` 可随时查询。

## 解决什么问题

- 控制台直接看到：近 24 小时断了几次、最长断了多久、平均多久连回来、最近一次是什么时候。
- 按来源拆分：`snowluma`（QQ 网关 WebSocket）与 `dsh`（DSH 事件流）互不干扰。
- 首次接入时从现有 `state/bridge.log` **回填**历史（否则要等一天才有数据）。
- 阈值告警：1 小时内断 ≥5 次，或单次中断 >10 分钟，返回一条中文文案（由调用方决定发到哪）。

## 指标口径

| 指标 | 口径 |
| --- | --- |
| 一次中断 | 同一来源的一次 `down` → 之后第一次 `up`。没有 `up` 的是**进行中**。 |
| `disconnects` | 窗口内发生的中断次数（含进行中）。 |
| `reconnects` | 窗口内**已闭合且结束时间可知**的中断数；日志回填的中断（结束时间不可知）不计入。 |
| `longestOutageMs` | 窗口内最长一次中断时长；进行中的按「到现在」计算。 |
| `avgReconnectMs` | 已闭合中断的平均重连耗时；`ongoing` / `inferred` 不计入，除零时返回 0。 |
| `lastOutageAt` | 窗口内最近一次中断的**开始**时间（ISO）。 |
| 人工来源 | 同来源同类型事件 2 秒内去重（重连抖动、回填与实时撞车）。 |

- 窗口默认 24 小时，`hours` 夹取到 `1..168`（保留 7 天）。
- 事件落盘 `state/conn-quality.json`（环形缓冲：7 天 / 最多 5000 条，原子写 tmp+rename）。
  文件损坏会改名成 `conn-quality.json.corrupt-<ts>` 隔离后重建；磁盘满、无权限等异常全部吞掉，
  **不会**抛给 `bridge.js`。
- 进行中的中断即使开始于窗口之前也会上报（「此刻还在断」比窗口边界重要）。

## API

`GET /api/conn-quality?hours=24`（无需鉴权时与其它控制台 API 一致；handler 自己写响应头）

```json
{
  "ok": true,
  "stats": {
    "hours": 24,
    "generatedAt": "2026-10-19T14:00:00.000Z",
    "disconnects": 5,
    "reconnects": 4,
    "longestOutageMs": 660000,
    "avgReconnectMs": 97500,
    "lastOutageAt": "2026-10-19T13:18:00.000Z",
    "ongoing": { "source": "dsh", "since": "2026-10-19T13:56:00.000Z", "downMs": 240000 },
    "bySource": {
      "snowluma": { "disconnects": 3, "reconnects": 3, "longestOutageMs": 660000, "avgReconnectMs": 95000, "lastOutageAt": "...", "lastCode": 1006 },
      "dsh":       { "disconnects": 2, "reconnects": 1, "longestOutageMs": 240000, "avgReconnectMs": 105000, "lastOutageAt": "...", "lastCode": null }
    },
    "series": [
      { "at": "2026-10-19T13:18:00.000Z", "source": "snowluma", "downMs": 90000, "endAt": "...", "code": 1006 },
      { "at": "2026-10-19T13:56:00.000Z", "source": "dsh", "downMs": 240000, "ongoing": true }
    ]
  }
}
```

- 出错：HTTP 500 `{ "ok": false, "error": "..." }`；非 GET：405（同样 `ok:false`）。
- `series` 每项 = 一次中断，按 `at` 升序；`ongoing:true` / `inferred:true`（日志回填）是可选项。

## 接入（`src/bridge.js`，共 6 处，逐行位置以当前文件为准）

> 本节是给接线者的说明；本模块与 `console.html` 已完成，`src/bridge.js` 未改动。

1. **import**（第 28 行 `safe-fetch.js` 之后）：

```js
import { backfillFromLog, buildAlertText, createConnQualityHandler, getStats, recordDisconnect, recordReconnect, shouldAlert } from './conn-quality.mjs';
```

2. **handler 常驻**（第 1183 行 `appendBridgeLog` 之后）：

```js
const connQualityHandler = createConnQualityHandler({ getStats });
```

3. **HTTP 路由**（第 3493 行 `/api/presets` 块结束的 `}` 之后，`POST /api/mode` 之前）：

```js
if (req.method === 'GET' && url.pathname === '/api/conn-quality') return connQualityHandler(req, res);
```

4. **SnowLuma 断线 / 重连**（`bot.on('open')` 内第 12295 行 `log(...)` 之后；`bot.on('close')` 内第 12407 行之后）：

```js
recordReconnect({ source: 'snowluma' });
recordDisconnect({ source: 'snowluma', code: info?.code });
```

5. **DSH 断线 / 重连**（第 2971 行 `DSH 已就绪` 的 `log` 之后；第 3008 行 `DSH 不可用` 的 `log` 之后）：

```js
recordReconnect({ source: 'dsh' });
recordDisconnect({ source: 'dsh' });
```

6. **启动回填**（第 12431 行 `startDshWatch();` 之前，同步、永不抛错）：

```js
backfillFromLog(); // 首次启动从 state/bridge.log 补历史，重复调用幂等
```

可选：在 `recordDisconnect` 后立刻判断告警（默认 5 次/小时、单次 >10 分钟）：

```js
const stats = getStats({ hours: 1 });
if (shouldAlert(stats)) log(`⚠️ 连接质量：${buildAlertText(stats)}`);
```

## 告警默认阈值

`DEFAULT_ALERT = { count: 5, windowMinutes: 60, outageMinutes: 10 }`

- 近 60 分钟断线 ≥5 次 → 告警；
- 或单次中断 >10 分钟 → 告警；
- `shouldAlert(stats, cfg)` 支持 `{ count, windowMinutes, outageMinutes }` 覆盖；
- `buildAlertText(stats, cfg)` 不需要告警时返回 `''`，否则返回中文一句话（含来源拆分与进行中状态）。

## 如何验证

```powershell
# 单测（20 条，纯逻辑 + 临时目录，不碰真实 state/）
& "<node.exe>" scripts\test-conn-quality.mjs

# 语法
& "<node.exe>" --check src\conn-quality.mjs
& "<node.exe>" --check scripts\test-conn-quality.mjs

# 接入后看接口（桥接运行中）
curl.exe -s "http://127.0.0.1:3100/api/conn-quality?hours=24"

# UI 契约（需要 Playwright；仓库文档见 docs/guides/CONSOLE-UI-TESTING.md）
& "<node.exe>" scripts\test-console-ui.mjs
```

控制台验证点：总览页出现「连接质量」卡片；断网后 15 秒内数字变化；接口不可用时显示
「数据不可用（/api/conn-quality）」而不是白屏。

## 回滚

1. 撤掉 `bridge.js` 的 6 处接线（import / handler / 路由 / 两个来源的 hook / 回填）——控制台卡片会自动显示「数据不可用」，不影响其它功能。
2. 删除 `state/conn-quality.json`（以及可能存在的 `.corrupt-*`、`.tmp-*`）。
3. `src/conn-quality.mjs`、`scripts/test-conn-quality.mjs`、`console.html` 面板都可独立保留：不接线时没有任何副作用。
