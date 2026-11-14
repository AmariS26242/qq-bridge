# 生活仪表盘 · 接口字段对照表（P1 实测产出）

> 实测时间：2026-10-23 20:41（本机 3100 端口，console token）
> 结论：**计划里列的六个接口全部可用（6/6 返回 JSON）**，但有两处与计划假设不符（见 §4），
> 且**手机桥 / 校园网没有任何接口能反映存活**，P2 需要补 1 条只读路由。

## 1. 接入方式

| 项 | 值 |
|---|---|
| 服务端口 | `3100`（`config.json` 的 `consolePort`） |
| 令牌文件 | `qq-bridge/state/console-token`（只读一行，`trim()` 后使用） |
| 请求头 | `x-console-token: <token>` |
| 静态页令牌 | `GET /` 由服务端注入/校验 console token；新增页面必须复用同一关卡 |
| 时间格式 | 接口里 `generatedAt` / `time` / `lastAt` 基本上是**毫秒时间戳**；`conn-quality` 用 ISO 字符串 |

## 2. 要展示的数字 ← 接口字段

### 2.1 四个常驻服务

| 卡片 | 存活判定（实测结论） | 附带信息 |
|---|---|---|
| **qq-bridge** | 本次请求本身返回 200 即存活；另可看 `GET /api/status` 是否报错 | 端口 3100；进程 uptime 需服务端给（新增只读路由 `process.uptime()`） |
| **qqbot（SnowLuma）** | `GET /api/status` → `snowluma.connected` && `snowluma.accountOnline` | `snowluma.good` / `goodSource` / `lastPacketAgoMs` / `lastPacketKind` / `silent` / `degraded` / `hint`；端口 3000(HTTP)+3001(WS) |
| **手机桥** | ❌ 无接口。`8899` / `8443` 直连要配对令牌（无令牌返回 **401**，可当"端口在听"的探测信号） | `bridge/.upstream`=`127.0.0.1:19388`、`bridge/.watchdog-fails`=`0\|<时间>`、**`bridge/.serve.pid` 已失效**（写的 9232，实际监听 PID 36080）→ 不可信 |
| **校园网 campus-net** | ❌ 无接口。计划任务 `CampusNet-Guard` 每 **5 分钟**跑一次 | `campus-net/log/net-guard.log` 的 mtime（>7 分钟没更新即异常）+ 末行 `[OK] 可访问外网`；任务上次运行 20:37:32、`Last Result: 0` |

### 2.2 今日用量

| 指标 | 来源 |
|---|---|
| 今日输入 token | `/api/tokens/series?hours=24` → `buckets[]` 里筛选**本地今天**，求和 `cacheMiss + cacheHit` |
| 今日输出 token | 同上求和 `output` |
| 今日缓存命中率 | `cacheHit / (cacheHit + cacheMiss)`（自己算；`summary.totals.cacheHitRate` 是**全量**） |
| 今日花费 | 同上求和 `cost`（单位 CNY，`symbol`=`¥`） |
| 累计/会话级 | `/api/tokens/summary` → `totals.{inputTokens,outputTokens?*}`（实测只有 `inputTokens`/`totalTokens`）、`totals.buckets{...}`、`totals.cacheHitRate`、`totals.cost`、`totals.turns`、`conversations[]` |
| 最近调用 | `/api/tokens/recent?limit=N` → `entries[{time,key,turn,step,model,tokens,cacheMiss,cacheHit,output,cost,tier}]` |
| 单会话轮次 | `/api/tokens/turns?key=private:100000001&limit=N`（**不带 `key` 会 404**） |

> ⚠️ `/api/tokens/series` 的参数是 `hours`（1~2160）和 `buckets`（6~120），**不是 `days`**；
> 实测 `hours=24&buckets=48` → `bucketMs=1800000`（30 分钟一格）。

### 2.3 QQ 今日活跃（消息 / 表情 / 语音）

| 指标 | 来源 |
|---|---|
| QQ 今日消息数 | `state/qq-activity.log` 里 `消息已入未读` 行数（实测今日 74 行） |
| 已发送条数 | 同文件 `工具统一发送：成功 x/y 条` 行数（70 行） |
| 表情数 | 同文件含 `[sticker]` 的行数（17 行） |
| 语音数 | 同文件含 `[voice]` / 语音 的行数（今日 0） |
| 现成的另一种拿法 | `/api/status` → `activity` 只给**最后 100 行**（`readActivityTail(100)`），跨午夜会丢，只适合做"最近动态"文本，**不能用来数今日** |

> `qq-activity.log` 会轮转（存在 `qq-activity.log.1`），且时间戳只有 `[HH:MM:SS]` 没有日期；
> 数「今日」时以文件现有行为准，跨天误差可接受（页面只做概览）。

### 2.4 待办 / 告警

| 内容 | 来源 |
|---|---|
| 待触发提醒 | **`state/reminders.json`**（`reminders[]`，取 `status === 'pending'` 按 `nextRunAt` 升序） |
| 提醒条数/上限 | `reminders.json` 自己数；上限在 `config.json` → `socialV2.reminder.maxActiveTotal`（50）/ `maxActivePerTarget`（10） |
| 连接质量（告警源） | `/api/conn-quality` → `stats.{disconnects,reconnects,longestOutageMs,avgReconnectMs,lastOutageAt,ongoing,bySource}` |
| 发送限流 | `/api/rate-limit` → `stats.{totalEnqueued,totalSent,totalDropped,depth}`（`depth>0` 表示有积压） |
| 待处理会话 | `/api/pending` → `{pending: []}`；`/api/sessions` → `sessions[{key,sessionId,owner}]` |
| 安全状态 | `/api/security` → `security.interceptNotify`、`stateDir.hardened` |

## 3. 实测样本（2026-10-23 20:41）

| 接口 | 状态 | 关键返回 |
|---|---|---|
| `/api/status` | 200 | `mode=reserved2`、`role=小鲸鱼`、`dshReady=true`、`snowluma.connected=true`、`lastPacketAgoMs=7941`、`degraded=false` |
| `/api/conn-quality` | 200 | `disconnects=17`、`reconnects=17`、`longestOutageMs=16712`、`avgReconnectMs=1013` |
| `/api/tokens/summary` | 200 | `totals.inputTokens=100000001`、`cacheHitRate=0.993`、`cost=¥15.56`、`turns=190`、`ledger.journalLines=1546` |
| `/api/tokens/series?hours=24` | 200 | `bucketMs=1800000`，48 格 |
| `/api/sessions` | 200 | 1 个会话 `private:100000001` |
| `/api/pending` | 200 | `[]` |
| `/api/rate-limit` | 200 | `depth=0`、`totalSent=0` |
| `/api/security` | 200 | `stateDir.hardened=true` |

## 4. 与计划不符 / 踩到的坑

1. **`/api/socialV2/reminder-list` 不能直接复用**：它是 `POST`，且第 6512 行强制
   `if (!req.headers['x-agent-token']) → 403 "reserved2 模式必须携带 agent token"`。
   带 console token 打过去是 **403**。→ 改为服务端读 `state/reminders.json`。
2. **`/api/tokens/turns`** 不带 `?key=` 返回 `404 未找到该会话的用量记录`（不是参数错误）。
3. **`/api/tokens/series` 参数是 `hours` 不是 `days`**（传 `days=1` 会被忽略，按默认 24h 返回）。
4. 手机桥的 `.serve.pid` 与实际监听进程不一致 → 存活判定**必须用 TCP/HTTP 探测**（8899 返回 401 即视为在听）。

## 5. P2 需要补的只读路由（唯一一处服务端改动）

`GET /api/dashboard/services`（console token 关卡内，纯只读、无副作用、结果缓存 15s）：

```jsonc
{
  "ok": true, "at": 1792760400000,
  "services": {
    "qqbridge":    { "alive": true, "pid": 33028, "port": 3100, "uptimeMs": 3400000 },
    "qqbot":       { "alive": true, "connected": true, "accountOnline": true, "good": true, "lastPacketAgoMs": 7941 },
    "phoneBridge": { "alive": true, "upstream": "127.0.0.1:19388", "watchdogFails": 0 },
    "campusNet":   { "alive": true, "logAgeMs": 180000, "lastLine": "[OK] 可访问外网…", "taskLastResult": 0 }
  },
  "today":  { "qqMessages": 74, "qqStickers": 17, "qqVoices": 0, "qqSent": 70 },
  "reminders": { "pending": 0, "items": [] }
}
```

理由：手机桥 / 校园网在浏览器侧拿不到（401 + 无接口 + 跨端口 CORS），且计划明确
「只有在拿不到存活状态时才补一个只读路由」。路由体量控制在一个小模块里（`src/dashboard.js`），
`bridge.js` 只加一处 `if` 分派。

### 5.1 实际落地（比上面的草案多几项，都是页面直接用到的）

```jsonc
{
  "ok": true, "at": 1792763389000,
  "services": {
    "qqbridge": { "alive": true, "pid": 3872, "port": 3100, "uptimeMs": 84000, "rssMb": 85, "node": "24.21.0" },
    "qqbot":    { "alive": true, "connected": true, "accountOnline": true, "good": true,
                  "lastPacketAgoMs": 3000, "hint": null, "httpPort": 3000, "wsPort": 3001 },
    "phoneBridge": { "alive": true, "port": 8899, "upstream": "127.0.0.1:65338",
                     "watchdogFails": 0, "watchdogAt": "2026-10-23T18:15:39.0299201+08:00" },
    "campusNet": { "alive": true, "logAgeMs": 126000, "staleMs": 480000, "lastLine": "[OK] …",
                   "task": { "ok": true, "via": "direct", "state": "就绪", "taskState": "已启用",
                             "lastRun": "2026/10/23 20:52:32", "nextRun": "2026/10/23 20:57:31",
                             "lastResult": "0" } }
  },
  "today": {
    "tokens": { "input": 75689392, "cacheHit": 75296000, "cacheMiss": 393392, "output": 35100,
                "cacheHitRate": 0.995, "cost": 2.37, "turns": 34, "steps": 41, "buckets": 2, "since": 1792732800000 },
    "qq": { "available": true, "messages": 74, "sent": 70, "sentOk": 114, "sentTotal": 114,
            "stickers": 17, "voices": 2, "lines": 172, "bytes": 15258, "lastLine": "[20:50:33] …" },
    "reminders": { "available": true, "pending": 0, "total": 17, "items": [] }
  }
}
```

要点：

- `services.campusNet.alive` = **日志新鲜（≤ `staleMs`）且计划任务没被禁用**。只看日志会在
  任务被禁用后还绿 5 分钟，所以两个条件都要。
- `services.campusNet.task.ok === false` 时页面显示「计划任务查询失败：<原因>」，不显示一串「—」
  （避免被当成「正常但没数据」）。`task.via` 记录三种起法中哪一种生效（`direct` / `cwd` / `cmd`），
  `task.attempts` 保留失败原因。
- `today.tokens` 是**今日（本地零点起）**，不是 `/api/tokens/summary` 的累计值：把
  `hours:24` 的 30 分钟桶按 `b.t >= 本地零点` 过滤后求和。
- `today.qq` 从 `state/qq-activity.log` 里按行前缀数出来；该文件会轮转、且时间戳只有 `[HH:MM:SS]`
  没有日期，所以只能算「本文件内的今日量」，跨零点轮转时会偏低（页面标注「今日」即可）。
- 结果缓存 5 秒（`CACHE_MS`），并发请求合并成一次探测。

## 6. P2 落地记录（2026-10-23 20:55 验收）

改动清单：

| 文件 | 改动 |
| --- | --- |
| `src/bridge.js` | 新增 `GET /dashboard`、`GET /api/dashboard/services`；401 分支把 `/dashboard` 也纳入「弹令牌框」；`import { dashboardSnapshot } from './dashboard.js'` |
| `src/dashboard.js` | 新增只读聚合模块（无写操作、无新端口） |
| `public/dashboard.html` | 新增自包含页面（2×2 四宫格，10 秒轮询，明暗双主题，令牌只存 sessionStorage） |
| `public/console.html` | 顶栏加「▦ 仪表盘」入口（自动带上 localStorage 里的令牌） |
| `public/mobile.html` | 快捷操作里加「仪表盘」按钮（同样带令牌） |

验收结果（四个条件全过）：

1. **页面能打开**：`GET /dashboard?token=…` → 200，四张卡都渲染出来；不带令牌 → 401 弹令牌框。
2. **数字对**：今日 input 75.7M / 命中 99.5% / ¥2.37 / 34 轮（与 `/api/tokens/series` 逐桶求和一致）；
   QQ 74 收 / 70 发 / 114-114 成功 / 17 表情 / 2 语音（与 `state/qq-activity.log` 逐行 grep 完全一致）；提醒 pending 0 / 共 17。
3. **断网 30 秒内变红**：`bridge/stop-bridge.ps1` 停手机桥 → **2.1 秒**后 `phoneBridge.alive=false`，
   红色告警条「1 项服务异常 · 手机桥端口 8899 无响应」；`Disable-ScheduledTask -TaskName CampusNet-Guard`
   → **6.1 秒**后校园网变红「计划任务已被禁用」（含 5 秒缓存），Enable 后恢复绿色。
4. **恢复变绿**：`Start-ScheduledTask -TaskName 'DSH Mobile Bridge'` 后 ≤3 秒回到「一切正常」。

### 6.1 两个坑（都跟仪表盘无关，但会让人以为仪表盘坏了）

- **`start.bat` 缺 `call`**：本机 `node` 指向 `%USERPROFILE%\.dsh\runtimes\bin\node.cmd`，
  批处理里 `node xxx` 不带 `call` 会移交控制权，导致 `start.bat` 执行完第一行就静默退出
  （exit 0、无输出、3100 没人听）。已改成 `call node …`（两处）。见 `start.bat` 内注释。
- **`schtasks` 在某些宿主进程里会退化成「系统找不到指定的路径」**：由 `start.bat` 守护拉起的
  桥接进程查询正常；被 DSH 应用直接 spawn 起来的进程（父进程已退出）会失败。`queryCampusTask()`
  因此按 `直接绝对路径 → 显式 cwd → cmd.exe` 三种方式依次重试，并记录 `via`。

## 7. 2026-10-23 21:0x 的第二轮修补

这一轮全是「用起来才发现的」，不改数据契约，只改外壳与两处统计口径。

### 7.1 页面外壳改成公开，数据接口照旧要令牌

以前 `GET /` 和 `GET /dashboard` 本身也在令牌关卡后面：不带令牌就返回一个
`prompt()` 小页，**从仪表盘点「控制台」回去也得再贴一次令牌**。现在按 `/m` 早就采用的
方式处理——外壳公开、页面自己去取令牌：

- `bridge.js` 新增 `pageShell`（`GET /` 与 `GET /dashboard`），关卡条件变成
  `!publicAsset && !mobileShell && !pageShell`；原来那段 401 的 prompt HTML 一并删掉。
- 外壳里没有凭据：令牌由页面从 `localStorage.consoleToken`（控制台）、
  `sessionStorage['qq-dashboard-token']`（仪表盘）或 `GET /api/local-token`（仅 127.0.0.1 回环）里取。
- **所有 `/api/*` 仍然要令牌**（`/api/status` 不带令牌实测 401），`/welcome` 之类未定义路径也仍是 401。
- `console.html` 的 `api()`：遇到 401 且本地没有令牌时，先试一次 `/api/local-token`，
  拿得到就自动继续（桌面免贴令牌）；经手机桥反代时该接口返回 403，退回原来的手动输入。
- `dashboard.html` 的「控制台」按钮改为 `id="to-console"`，`syncConsoleLink()` 在有令牌时
  把地址拼成 `/?token=…`，回控制台不用再贴。

### 7.2 `today.qq` 改成「合并已轮转日志 + 按跨零点切分」

`state/qq-activity.log` 由 `createCappedLogger(ACTIVITY_LOG, 500)` 维护：超过 500 行就把当前
文件改名成 `.1`、新文件从零写，而每行时间戳只有 `[HH:MM:SS]`、没有日期。两个后果：

1. 一天里轮转过一次，当天较早的记录跑到 `.1` 里 —— 只读主文件会漏；
2. `.1` 常常横跨昨天和今天（例：昨天 20:10 → 今天 00:04）—— 整份算进来会把昨天的记录算到今天。

现在的做法：`.1` 与主文件各按「时钟回拨（23:59 → 00:00，容 60 秒回拨）」切成段，**只取最后一段**；
`.1` 的 mtime 是今天才参与合并。返回里多了 `merged`（是否合并了 `.1`）与 `firstClock`（第一条的时钟）。
页面在 `firstClock > 01:00:00` 时多显示一行「统计起点 04:xx:xx（含已轮转日志）」，
避免把这几个数当成完整一天。

实测（21:06）：合并前 172 行 / 74 收；合并后 186 行 / 81 收 / 75 发 / 124 成功 / 19 表情 / 2 语音，
`firstClock=00:00:21`（当天完整覆盖）。

### 7.3 `start.bat` 遇到锁冲突不再退出

`bridge` 以 exit code 2 表示「`state/bridge.lock` 被别的实例持有」。这台机器上存在两套监督者
（`start.bat` 守护 + DSH 应用自己 spawn 的桥接），以前守护撞锁就直接退出，那个实例一死就没人再拉起来。
现在改成：打一行日志、`ping` 等 120 秒、重新尝试启动；对方还在跑就再次快速返回，对方没了就接管。

### 7.4 经手机桥反代时接口路径必须跟着前缀走

手机桥（`bridge/dsh-mobile-bridge.cjs:515 proxyQQ`）只把 `/__qq/<rest>`（短别名 `/qq/<rest>`）转发给
qq-bridge，并在服务端**注入** `x-console-token`（`:518-519`，手机只持配对 cookie）。用绝对路径
`/api/...` 发请求会掉出前缀，被当成手机桥自己的路由（实测 `GET http://127.0.0.1:8899/api/status` → 404），
仪表盘就会一张卡都拿不到数、看起来像「要令牌」。

`public/dashboard.html` 现在和 `public/mobile.html:184` 用同一套做法：

```js
var BASE = location.pathname.replace(/\/dashboard\/?$/, '');  // '' | '/__qq' | '/qq'
fetch(BASE + '/api/dashboard/services', ...)
```

`BASE` 非空时（手机入口）「控制台」按钮改标「手机版」并指回 `BASE + '/'`（即 `/__qq/` → 反代把空 rest
兜底成 `/m`），不会再把手机用户丢到需要令牌的根页面。

实测（21:26，配对后无令牌，390×844 移动仿真）：

| 入口 | 结果 |
|---|---|
| `/__qq/dashboard` | 200，四卡有数（81/75/19/2，日志 186 行），`#auth` 隐藏，返回链接 `/__qq/` |
| `/qq/dashboard` | 同上，返回链接 `/qq/` |
| `/dashboard`（3100 直连） | 同上，返回链接 `/?token=…` |
| `/__qq/m` 的「仪表盘」入口 | `href=/__qq/dashboard`；`/qq/m` → `/qq/dashboard`；直连 `/m` → `/dashboard?token=…` |

反代侧的页面外壳（`/__qq/dashboard` 200、`/__qq/api/local-token` 403）也一并验证过。
