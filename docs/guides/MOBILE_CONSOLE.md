# 手机版后台（/m）

单页、触控优先的 QQ 机器人后台。同一个 `qq-bridge` 进程同时服务桌面版（`/`）和手机版（`/m`），
数据来自同一批 `/api/*`，所以状态永远一致；手机版只是**重新排版 + 只放高频操作**。

## 两个入口

| 场景 | 地址 | 说明 |
|---|---|---|
| 手机 · 任意网络（推荐） | `https://console.example.com:8443/__qq/m` | 走手机桥（Tailscale + 设备配对 + HTTPS），可在浏览器里「添加到主屏幕」 |
| 本机浏览器 | `http://127.0.0.1:3100/m` | **不用带令牌**：页面 401 时会向回环专供的 `GET /api/local-token` 自取一次令牌并存入 localStorage |
| 本机 · 经桥 | `http://127.0.0.1:8899/__qq/m` | 与手机同一条反代路径，调试用 |

### 令牌是怎么省掉的（2026-10-20 追加）

- 桌面版 `/` 仍然要 `?token=`（它是全权管理端，一条链接就能改人格、重启进程）。
- 手机版页面壳 `/m` 免令牌：它只是 UI，无状态、无凭据。
- 页面里的 fetch 拿到 401 时，调 `GET /api/local-token`。该端点只接受**真正的回环连接**
  （`req.socket.remoteAddress` 为 `127.0.0.1`/`::1`/`::ffff:127.0.0.1`），并且拒绝任何带了
  `x-console-token` 或 `x-forwarded-for` 的请求——手机桥反代总会注入 `x-console-token`，
  所以远程手机拿不到令牌文件内容（实测 `/qq/api/local-token` → 403）。
- 所有 `/api/*` 依旧要令牌；`/`、`/api/status` 裸访问仍是 401（实测）。
- 并发 401 只取一次令牌（页面里 `tokenPromise` 去重），否则首屏会连打四五次。

手机第一次访问会先落到桥的配对页：用 `bridge.cmd status` 里那条带 `?pair=` 的地址配一次，
之后 7 天内直接开 `/__qq/m` 即可（HTTP 8899 与 HTTPS 8443 是两套独立配对状态）。

`/__qq`（不带 `/m`）会 302 到 `/__qq/m`，少敲一段。

`/qq/...` 是同一个反代的**短别名**（`/qq/m`、`/qq/api/status` 等价于 `/__qq/...`）。
别名是服务端原地重写路径，不是 302 跳转——否则所有 POST（发送、标记已读）会退化成 GET。
`/qq` 本身仍会 302 到 `/__qq/m`。规范形态保持 `/__qq`，与桥里既有的 `/__bili` 命名一致。

## 页面上有什么

- **运行状态**：DSH 是否就绪、SnowLuma 是否在线、心跳多久前、自动发消息是否暂停、角色名、白名单人数
- **快捷操作**：给 ownerQQ 发测试消息、标记已读、刷新、重启桥接（带二次确认）
- **连接质量**：24h 断线次数 / 最长中断 / 平均重连 + 分源（SnowLuma code 1006、DSH）明细
- **限流队列**：当前积压条数、已补发、已丢弃；最多 5 条待补发的「等多久重试 / 已试几次 /
  上次错误」，外加最早一条的入队时间。队列为空时显示「队列空闲」。
  数据来自 `GET /api/rate-limit`（`src/rate-limit.mjs` 的 `stats()` + `list()`）。
  `list()` **故意不返回 payload**——那是待发消息正文，控制台只该看到调度元信息。
- **未读**：未读条数与前 10 条
- **最近消息**：最近 20 条，自己/对方左右分栏
- **用量**：累计花费、回合数、缓存命中率

自动刷新 15 秒一次；页面切到后台时不刷新（省电）。手动下拉刷新不实现，点「刷新」即可。

## PWA

`/m/manifest.webmanifest` + `/m/sw.js` + 192/512 图标，`display: standalone`。
Service Worker **故意不缓存任何页面和接口**（只给断网时一张离线提示），因为这里看的全是实时状态。

manifest 在两端都免令牌/免配对：浏览器取 manifest 时可能不带 cookie，401 会让「可安装」失效。
它只是名称和图标，不含任何状态。

## 谁在做什么（排查时看这里）

| 环节 | 代码 |
|---|---|
| 页面与接口前缀推导 | `qq-bridge/public/mobile.html`，`BASE = location.pathname.replace(/\/m\/?$/, '')` |
| 限流队列数据 | `qq-bridge/src/bridge.js` 的 `GET /api/rate-limit`（`stats` + `list(limit)` + 生效配置），源头 `src/rate-limit.mjs` |
| 静态路由（`/m`、manifest、sw、图标、favicon） | `qq-bridge/src/bridge.js` 里 `MOBILE_FILES` 与 `MOBILE_PUBLIC_ASSETS` |
| 反代 `/__qq/*` → `127.0.0.1:3100` | `bridge/dsh-mobile-bridge.cjs` 的 `proxyQQ()` / `qqConsoleToken()` |
| 令牌注入 | 桥读 `qq-bridge/state/console-token`（按 mtime 热加载），请求加 `x-console-token`；**手机永远拿不到这个令牌** |
| Host 重写 | `proxyHeaders()` 把 Host 改成 `127.0.0.1:3100`，满足控制台的反 DNS-rebinding 白名单；同时丢掉 Origin/Cookie |

想换端口：`BRIDGE_QQ_UPSTREAM=127.0.0.1:3100` 环境变量改桥的上游。

## 已验证（2026-10-20）

- 直连：`GET /m?token=…` → 200；`/m` 不带令牌 → 401；`/m/sw.js`、`/m/icon-192.png` → 200（免令牌）
- 经桥 HTTP 8899：`/__qq/m` 200、`/__qq/api/status` 200（真实 role=小鲸鱼）、`/__qq/api/conn-quality` 200
- 经桥 HTTPS 8443：同上全部 200；`POST /__qq/api/socialV2/mark-read` → `ok:true`
，`depth=0` 时卡片显示「队列空闲」；
  用 Playwright 拦截接口注入 2 条假数据，卡片正确画出「2 条待补发 / 等 44.6s / 已试 2 次 /
  发送频率超限」，且不含 payload 正文；`scripts/test-rate-limit.mjs` 23/23（新增 1 条 `list()` 用例）
- 安全回归：不带配对 cookie 访问 `/__qq/m` 与 `/__qq/api/status` 均 401；只有 manifest 放行
- 手机视口（390×844，deviceScaleFactor 2）用 Playwright + Edge 截图：`scrollWidth == clientWidth == 390`，无横向溢出，控制台无报错

## 已知限制

- 手机版是**只读优先**：改人格、改提示词、清记忆、看完整日志仍走桌面版（页脚有链接）
- 「重启桥接」调用 `/api/restart`，会中断正在跑的模型回合
- 桥的 HTTP（8899）与 HTTPS（8443）配对状态互相独立；换协议要重新配一次
- 竖屏优化，横屏也能用但没有专门布局

### /qq 别名（2026-10-20 追加验证）

- `GET /qq` → 302 `/__qq/m`；`GET /qq/m` → 200；`GET /qq/api/status` → 200
- `POST /qq/api/socialV2/mark-read` → 命中真实接口（返回业务提示而不是 404），证明别名是
  服务端原地重写，请求体与 method 都保留
- 别名实现：`bridge/dsh-mobile-bridge.cjs` 里 `if (url.pathname === '/qq' || url.pathname.startsWith('/qq/')) url.pathname = QQ_PREFIX + url.pathname.slice(3);`
