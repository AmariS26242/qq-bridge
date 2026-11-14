# QQ 端改动方案（相对 SnowLuma 1.14.22 + qq-bridge 0.2.0 上游）

> 目的：把本机 QQ 机器人这一套**相对两个上游原版**的全部改动，写成第三人可以照着重做的实施方案。
> 原则：只写「改什么、为什么改、怎么验证」，不出现任何本机路径、用户名、口令、令牌、QQ 号、机器专属阈值。

---

## 0. 阅读约定

### 0.1 占位符

下文所有尖括号都是待填参数，落地时换成自己的值；换机器只需改这张表，正文不用改。

| 占位符 | 含义 | 取值建议 |
|---|---|---|
| `<WS>` | 工作区根目录（下面并列放 `qq-bridge/`、`SnowLuma/`、`qqbot/`、`bridge/`） | 任意无空格、无单引号的路径 |
| `<QQ_BOT_UIN>` | 机器人小号 QQ 号 | 单独一个小号，不要用主号 |
| `<OWNER_QQ>` | 主人（唯一被允许改资料/私聊唤醒）的 QQ 号 | 你的主号 |
| `<SNOWLUMA_DIR>` | SnowLuma 解压目录 | `<WS>/SnowLuma` |
| `<BRIDGE_DIR>` | qq-bridge 目录 | `<WS>/qq-bridge` |
| `<QYBOT_DIR>` | 编排脚本目录 | `<WS>/qqbot` |
| `<MOBILE_DIR>` | 手机桥目录 | `<WS>/bridge` |
| `<MEMORY_INDEX_DIR>` | 长期记忆 MCP 目录（可选组件） | `<WS>/memory-index` |
| `<DSH_HOME>` | DSH 配置根 | `%USERPROFILE%\.dsh` |
| `<DSH_RUNTIME_NODE>` | DSH 运行时自带的 `node.exe` 绝对路径 | 见 5.4 |
| `<DSH_CMD>` | DSH 启动命令 | `dsh.cmd` 或等价 |
| `<PROFILE>` | 给 QQ 端单独开的 DSH profile 名 | `qqbridge` |
| `<PORT_CONSOLE>` | 桥控制台端口 | `3100` |
| `<PORT_ONEBOT_HTTP>` / `<PORT_ONEBOT_WS>` | OneBot 正向 HTTP / 反向 WS 端口 | `3000` / `3001` |
| `<PORT_SNOWLUMA_UI>` | SnowLuma WebUI 端口 | `5099` |
| `<PORT_DSH>` | QQ 端 DSH 实例端口 | `19388` |
| `<PORT_SAMPLING>` | 采样代理端口 | `8790` |
| `<PORT_MOBILE>` / `<PORT_MOBILE_TLS>` | 手机桥 HTTP / HTTPS | `8899` / `8443` |
| `<UPSTREAM_BRIDGE>` | 原版 qq-bridge 源码目录 | 解压 `v0.2.0` tag |
| `<TAILSCALE_HOST>` | 手机桥对外域名 | Tailscale MagicDNS 名或局域网 IP |
| `<TTS_VENV>` | edge-tts 的 Python 虚拟环境 | `<BRIDGE_DIR>/.venv-tts` |
| `<FFMPEG_DIR>` | ffmpeg/ffprobe 所在目录 | 任一本机目录 |

端口是**设计默认值**，可以改；但 `qqbot/qqbot.local.json`、`SnowLuma/config/onebot_<QQ_BOT_UIN>.json`、`qq-bridge/config.json`、DSH profile 的 MCP 配置四处必须同步，否则会出现「桥在听但 bot 不连」的死链。

### 0.2 基线版本

| 组件 | 基线 | 识别方式 |
|---|---|---|
| SnowLuma | 1.14.22 win-x64（官方 zip） | 目录内 `package.json` 的 version |
| qq-bridge | GitHub `Derpyu520/qq-bridge` tag `v0.2.0` | `package.json` version 为 `0.2.0`；本机分支标为 `0.2.0-r3` |
| Node.js | ≥ 22.13.0 | `node -v`；SnowLuma 用其自带 `node.exe` |
| DSH | 支持 Cookie 鉴权 + slash-RPC + `remote.mux` 的版本（≈0.1.2-alpha.1 起，0.1.5-rc.1 复核） | 见 5 章 |

### 0.3 怎么复现「差在哪里」

三份对照命令（PowerShell，参数化），任何一次改动后重跑即可得到当前差异面：

```powershell
# 1) 文件级差异（排除运行时目录）
$ex = @('node_modules','state','.snapshots','tmp','work','dist','.git')
$a = Get-ChildItem '<UPSTREAM_BRIDGE>' -Recurse -File |
     Where-Object { $p=$_.FullName; -not ($ex | Where-Object { $p -match "\\$_\\" }) }
$b = Get-ChildItem '<BRIDGE_DIR>' -Recurse -File |
     Where-Object { $p=$_.FullName; -not ($ex | Where-Object { $p -match "\\$_\\" }) }
Compare-Object $a.FullName $b.FullName | Group-Object SideIndicator |
  Select-Object Name,Count

# 2) 行级差异（只看关键文件）
Compare-Object (Get-Content '<UPSTREAM_BRIDGE>\src\bridge.js') `
               (Get-Content '<BRIDGE_DIR>\src\bridge.js') | Measure-Object -Line

# 3) MCP 工具面差异
Select-String -Path '<BRIDGE_DIR>\src\mcp-snowluma-safe.js' -Pattern "name:\s*'([a-z_0-9]+)'" -AllMatches |
  ForEach-Object { $_.Matches.Groups[1].Value } | Sort-Object -Unique
```

本机当前差异面（作为验收基线，见附录 A）：**新增 497 文件 / 改动 47 文件 / 删除 1 文件**；`src/bridge.js` 10783 → 15370 行。

### 0.4 改动分层总览

原版只有「SnowLuma + qq-bridge 两个进程」，本方案把它扩成**五层**，每层都是相对原版的新增物，互不侵入：

| 层 | 实体 | 相对原版 | 规模 |
|---|---|---|---|
| L1 宿主 | SnowLuma 1.14.22 | **零代码改动**，只加 `config/*.json`（含两个账号的 OneBot 配置） | 6 个配置 + 数据目录 |
| L2 桥 | qq-bridge `0.2.0-r3` | fork 上游，代码级大改 | +497 文件、47 改动、1 删除 |
| L3 运行时 | DSH `qqbridge` profile | 新开的独立实例（不碰 desktop profile） | 1 个 profile + 2 个插件 junction |
| L4 编排 | `qqbot/`（全新） | 原版没有「谁先起谁后起」的编排 | 1 个 25KB 编排脚本 + 开机自启/看门狗 |
| L5 访问 | 控制台 / 手机桥 / PWA / APK | 原版只有控制台网页；手机访问与 APK 全新增 | 手机桥 81KB + APK 流水线 |

一句话概括本方案要解决的问题：**原版是「能收发消息的桥」，本方案是「一个有作息、有记忆、有语音表情、能自愈、能用手机看住的 QQ 人格」**。所有改动都是从这一点长出来的，不是零散修补。

### 0.5 改动速查矩阵（能力 → 位置 → 开关 → 验收）

落地时按这张表逐行推进，每行都是独立可交付的一片。

| 能力 | 主要落点 | 开关 | 验收 |
|---|---|---|---|
| 去 AI 味 | `src/ai-tone.js` + `src/ai-tone-stats.js` | `aiTone.enabled` | 回复无「作为一个 AI」类开场 |
| 长消息拆条 | `src/length-gate.js` | `lengthGate.*` | 长回复拆成 ≤2 条，不是一大段 |
| 语音 | `src/voice-tts.mjs` + `src/auto-voice.mjs` | `voiceTts.*`、`socialV2.autoVoice.*` | 命中场景收到语音（非链接） |
| 表情 | `src/sticker-index.js` + `src/auto-sticker.mjs` | `socialV2.sticker.*` | 收到一张表情，不是文字描述 |
| 发图/读图 | `src/send-image-lib.js`、`src/inline-media.js` | `socialV2.image.*` | 能发图；越界路径被拒且说明原因 |
| 主动联系 | `src/proactive-contact.js` | `socialV2.proactiveContact.*` | 沉默超阈值后在窗口内主动开口 |
| 定时提醒 | `src/reminders.js` | `socialV2.reminder.*` | 到点收到；重启不重发 |
| 提醒铺垫 | `src/reminder-nudge.js` | `socialV2.reminder.nudge.*` | 到点前先有一句铺垫 |
| 失联安抚 | `src/turn-visibility.mjs` | 默认开 | 长任务 8 分钟内先安抚 |
| 断线补拉 | `src/catch-up.mjs` | 默认开 | 断网恢复后旧消息被补记 |
| 唤醒历史 | `src/wake-history.mjs` | `socialV2.context.wakeHistory.*` | 唤醒后不把历史当新未读逐条回 |
| 群友档案 | `src/profiles.js` + `src/profile-slice.mjs` | `socialV2.profile.*` | 能说出具体事例，不是标签 |
| 日记 | `src/diary.js` | `socialV2.diary.*` | 当天有页，控制台可导出 |
| few-shot 风格 | `src/fewshot-lib.js` + `persona-lib/` | `style.fewshot.*` | 回复口吻贴近样本 |
| 交接摘要 | `src/handoff.mjs` | `contextBudget.*` | 长会话压缩后不失忆 |
| 出站限流 | `src/rate-limit.mjs` | 默认开 | 配额打满时排队而非全丢 |
| 成本守门 | `src/cost-guard.mjs` | `costGuard.*` | 面板有日输入/缓存率/水位 |
| 观测面板 | `src/ops-panel.js`、`src/conn-quality.mjs`、`src/health.mjs`、`src/dashboard.js` | 默认开 | `/dashboard`、`/ops` 有数 |
| 一键自检 | `src/doctor.mjs` | 默认开 | `CORE_TESTS` 全绿 |
| 备份 | `src/backup.mjs` + `scripts/backup.mjs` | `backup.*` | 03:10 出产物，保留策略生效 |
| 磁盘卫生 | `src/clean-state.mjs` | `cleanState.*` | 三档判定有「为什么没删」 |
| 每日简报 | `src/daily-brief.mjs` | `dailyBrief.*` | 08:00 收到纯文本 ≤9 行 |
| 周报 | `src/weekly-report.mjs` | `weeklyReport.*` | 周日 20:00 收到 |
| 采样调参 | `src/sampling-proxy.js` | `sampling.*` | `check:sampling` 通过、温度生效 |
| 桌面通道 | `scripts/desk-command.mjs` | `desk.*` + `manage.deskCommand` | 入队成功、风险分级正确 |
| 人格与场景 | `roles/小鲸鱼.md`、`dsh/agent-presets/*`、`persona-lib/style/` | `role.*` | 8 个场景名与 `scene-router` 一致 |
| 编排与自愈 | `qqbot/qqbot.mjs` | `qqbot.local.json` | 一条命令起全链；杀进程能自愈 |
| 手机/APK | `public/mobile/`、`bridge/`、`android/` | `<MOBILE_DIR>` 配置 | `/__qq/m` 可用；APK 能打开 |

---

## 1. 目标形态（落地后应该看到什么）

1. 双击一个入口（或开机自启）→ 五个进程按依赖顺序起来：SnowLuma → QQ 小号 → hook 注入 → DSH → bridge。
2. 任一层挂掉，看门狗或编排脚本能把它拉回来；桥在运行时被 DSH 自杀式重启牵连，也能自己恢复。
3. QQ 里收到消息后：文本按人格与时序规则回复；必要时补语音、补表情、拆条；长任务会先安抚「我这边卡住了」再继续。
4. 主人可以私聊让它写日记、设提醒、发表情、发图、改自己资料；群里只在被 @ 或命中主动联系窗口时说话。
5. 浏览器打开 `http://127.0.0.1:<PORT_CONSOLE>/` 能看到运行模式、会话映射、挂起审批、活动日志、人格、日记、二代仿真参数；手机走手机桥 `/__qq/m` 看同一套。
6. 每天 08:00 有简报、23:30 自动写日记、03:10 自动备份、每周一次周报、每 30 天一次备份演练。
7. 出问题时有 `doctor` 一键自检 + 连接质量时序 + token 账本可查，不用靠猜。

---

## 2. 基线准备（从零开始）

### 2.1 取上游

```text
SnowLuma 1.14.22 win-x64  →  解压到 <SNOWLUMA_DIR>
Derpyu520/qq-bridge v0.2.0 →  git clone 后 checkout v0.2.0，作为 <UPSTREAM_BRIDGE>
```

**必须保留 `<UPSTREAM_BRIDGE>`**：本方案所有改动都以它为参照物，后面每次升级都要重新 diff。

### 2.2 目录布局

```text
<WS>/
├─ SnowLuma/                 # L1：原版未改代码 + 我们加的 config/data
├─ qq-bridge/                # L2：本方案主体（fork 后大改）
│  ├─ src/ scripts/ public/ plugins/ docs/ roles/ persona-lib/ eval/ android/
│  └─ config.json            # 运行配置（含口令，禁止入库）
├─ qqbot/                    # L4：编排、开机自启、看门狗
├─ bridge/                   # L5：手机桥（含 QQ 控制台反代）
└─ memory-index/             # 可选：长期记忆 MCP
```

### 2.3 运行时

- Node.js ≥ 22.13.0。**SnowLuma 必须用它自带的 `node.exe` 启动**（自带运行时是它的一部分，换系统 node 会因 native 依赖不匹配而崩）。
- 包管理器用 pnpm。**只装了 DSH 的机器上没有 npm**：DSH 运行时目录（`~/.dsh/runtimes/bin`）里只有 `node.exe` 和 `pnpm.cmd`，`npm` 不存在；所以落地/CI 一律 `pnpm install --frozen-lockfile`，`pnpm run <script>`。`package-lock.json` 只是兼容留档。
- qq-bridge 在 `<BRIDGE_DIR>/.npmrc` 里写 `node-linker=hoisted`。原因：pnpm 默认的符号链接目录布局，在受限完整性上下文里启动 MCP 子进程时路径解析会失败（表现为 MCP 工具「一个都没注册」）。
- Python 仅语音需要：edge-tts 装在 `<TTS_VENV>`；ffmpeg/ffprobe 放 `<FFMPEG_DIR>` 并加入子进程 PATH。

### 2.4 先确认「原版能跑」

不要跳过这一步。原版跑不通就往上加东西，后面所有故障都无法归因。

```powershell
# 原版基线自检（应全绿）
cd <BRIDGE_DIR>; pnpm install --frozen-lockfile   # 没有 pnpm 就用 npm ci
node src/self-test.js          # 只测 DSH 侧链路
```

验收：`self-test` 能连上 DSH、建会话、发 prompt、收到 `turn/end`。

### 2.5 想跳过手工搬运：用可复现交付包

纯看文档复刻环境（L1/L3/L4/L5 的接线）没问题，但**代码本体无法从散文重建**——39 个新模块、`bridge.js` 净增 4709 行、258 KB 控制台、26 KB 二代预设、`persona-lib/` 语料、`eval/` 盲评集，都是制品不是说明。所以另做了一个包：

| 项 | 值 |
| --- | --- |
| 生成脚本 | `<BRIDGE_DIR>/scripts/build-repro.ps1`（白名单拷贝 → 参数化 → 模板 → `BASELINE.json` → `MANIFEST.sha256` → zip） |
| 产物 | `<BRIDGE_DIR>/repro-out/qq-bridge-repro-<时间戳>.zip`（约 4 MB，648 文件） |
| 包内入口 | `bootstrap.ps1` + `REPRODUCE.md`（包根） |
| 校验 | 解开后先跑 `bootstrap.ps1 -VerifyOnly`：逐文件比 `MANIFEST.sha256`，缺一个或改一个都报错 |

一键落地：

```powershell
Expand-Archive .\qq-bridge-repro-<时间戳>.zip -DestinationPath C:\qqrepro
cd C:\qqrepro\qq-bridge-repro
.\bootstrap.ps1 -Workspace C:\bots -OwnerQQ <OWNER_QQ> -BotQQ <QQ_BOT_UIN>
```

`bootstrap.ps1` 做的事，按顺序：校验清单 → 替换全部占位符 → 铺 `qq-bridge/`、`qqbot/`、`dsh-profile/`（到 `$env:USERPROFILE\.dsh\profiles\<PROFILE>`）、`config.json`（来自 `config.template.json`，全量 387 键，不是上游那份 216 键的 example）→ 回填 `qqbot.local.json` 的 `dsh.cmd` 为本机真实路径 → 装依赖 → 在 `~/.dsh/plugins` 建两个 Junction → 打印剩余手工事。

参数：`-Workspace`（落地目录）、`-OwnerQQ`、`-BotQQ`、`-SnowLumaDir`（给了就读它的 OneBot token，省一次手填）、`-DshHome`（默认 `$env:USERPROFILE\.dsh`，测试时指别处可避免污染真 profile）、`-Profile`（默认 `qqbridge`）、`-VerifyOnly`、`-SkipInstall`、`-SkipVerify`、`-Force`。

包里**不含**：`node_modules/`、`state/`（含会话/令牌）、`config.json` 真身（给模板）、`qqbot.local.json`（给 example）、`android/console.keystore` 与 `android/out/`、全部 `*.bak*`、以及任何机器名/用户名/QQ 号/口令（一律占位符：`__WORKSPACE__`、`__USERPROFILE__`、`__USERNAME__`、`__OWNER_QQ__`、`__BOT_QQ__`、`__DSH_RUNTIME_NODE__`、`__ONEBOT_TOKEN__`、`__SNOWLUMA_WEBUI_PASSWORD__`；对照表在 `BASELINE.json`）。

落地后仍要人工做的三件事，`bootstrap.ps1` 收尾会打印出来：① 在 SnowLuma WebUI 设口令、建小号 OneBot 账号，把 token 填进 `config.json` 与 `qqbot.local.json`；② 语音可选链（venv + edge-tts + ffmpeg）；③ 自检 `pnpm run self-test`、`node scripts/doctor.mjs`。

包只是**搬运代码**，行为说明仍以本文档为准——两者的基线版本写在同一处：`BASELINE.json` 记录 `qq-bridge` 版本、SnowLuma 版本、验证过的 DSH 版本，`bootstrap.ps1` 发现 DSH 版本不一致会直接报警。


---

## 3. L1：SnowLuma 侧改动（纯配置，零代码）

**结论先行：SnowLuma 一个代码文件都没改。** 比对结果：`0 改动 / 0 删除 / 仅新增文件`。所有差异都在 `config/`（6 个新 JSON）与 `data/`（运行时自动生成）。

这意味着：**升级 SnowLuma 只需换二进制，配置照搬**。这是本方案最重要的一条设计约束——不要为了省事去 patch SnowLuma 的 JS，否则每次升级都要重新移植。

### 3.1 新增配置文件清单

| 文件 | 作用 | 是否含机密 |
|---|---|---|
| `config/runtime.json` | 端口、日志、hook 自动加载开关 | 否 |
| `config/webui.json` | WebUI 登录口令散列 | **是**（只提交键名，值不入库） |
| `config/ui.json` | 界面外观/布局/轮询间隔 | 否 |
| `config/notifications.json` | 通知渠道与去抖 | 否 |
| `config/onebot_<QQ_BOT_UIN>.json` | 小号的 OneBot 服务配置 | **是**（含 OneBot token） |
| `config/onebot_<OWNER_QQ>.json` | 主号的 OneBot 服务配置 | **是**（含 OneBot token） |

**为什么是两个账号文件**：SnowLuma 的 OneBot 配置按账号分文件（`onebot_<uin>.json`），不是全局单文件。新机器上只建小号那一个，主号那条会在别处用到时静默 401——这是最常见的「配好了却连不上」原因。两份除 token 外结构完全一致。

### 3.2 `runtime.json` 落地字段

| 字段 | 值 | 为什么 |
|---|---|---|
| `webuiPort` | `<PORT_SNOWLUMA_UI>` | 固定端口，编排脚本要探它 |
| `webuiHost` | `127.0.0.1` | 只给本机，不暴露到网卡 |
| `webuiTls` | `disabled` | 本机 loopback，TLS 只会让自签证书报警 |
| `trustProxy` | `""` | 没有反代，留空避免取错客户端 IP |
| `hookAutoLoad` | **`false`** | **关键**：不在启动时自动注 hook，改由 `qqbot.mjs` 按小号显式注入。原版自动加载会注到「先启动的那个 QQ 进程」上，多开时必然注错号 |
| `logMaxTotalMb` | `1024` | 日志上限，避免长期运行吃满盘 |
| `logRetainDays` | `7` | 同上 |
| `logPerUin` | `false` | 不分账号切日志，排障时一份日志看全链 |

### 3.3 `onebot_<uin>.json` 落地字段

两个账号文件结构相同，只换 token：

```jsonc
{
  "mode": "snapshot",
  "httpServers": [{
    "name": "http-default",
    "host": "127.0.0.1",
    "port": 3000,               // <PORT_ONEBOT_HTTP>
    "path": "/",
    "messageFormat": "array",   // 消息段数组，非 CQ 码字符串
    "reportSelfMessage": false, // 不下发自己发的消息，否则桥会自问自答
    "enableWebSocket": false
  }],
  "wsServers": [{
    "name": "ws-default",
    "host": "127.0.0.1",
    "port": 3001,               // <PORT_ONEBOT_WS>
    "path": "/",
    "role": "Universal",
    "messageFormat": "array",
    "reportSelfMessage": false
  }],
  "statusCommand": { "enabled": true, "swallow": false, "cooldownSeconds": 5, "trigger": "#sl" },
  "historySync": { "enabled": false },
  "notifications": { "channelIds": [] }
}
```

三个必须照抄的坑：

1. `messageFormat: "array"`：桥按消息段解析。写成 CQ 码字符串会让所有带图/表情的消息变成纯文本 `[CQ:...]`。
2. `reportSelfMessage: false`：桥自己发出去的消息若被回灌，会被当成「用户说了话」，触发自问自答死循环。
3. `historySync.enabled: false`：SnowLuma 自带的离线历史同步与桥的补拉（`catch-up.mjs`）会重复记账。**只留一条历史来源**。

### 3.4 `ui.json` / `notifications.json`

`ui.json` 只是把 WebUI 收敛成固定布局，便于截图和远程操作：`layout` 块顺序 `[stats, connections, alerts, host, sessions]`、`navItems` 固定五项、`pages.defaultRoute: "/"`、`logs.maxLines: 1000`、`pollInterval: 3000`。`notifications.json`：`debounceSeconds: 30` + `channels: []`（通知走桥的简报，不走 SnowLuma 通知）。

这两份没有任何行为耦合，照抄或留默认都不影响链路。

### 3.5 `webui.json`（机密）

存 `passwordHash` / `passwordSalt`，`mustChangePassword: false`。**只把键名写进文档/仓库，值单独保存**。落地时用 SnowLuma 首启页设一遍口令，它会自己生成这两个字段。

---

## 4. L2：qq-bridge 代码层（本方案主体）

### 4.1 规模与构成

| 项 | 上游 v0.2.0 | 本方案 | 差异 |
|---|---|---|---|
| 仓库文件（排除 `node_modules/state/.snapshots/tmp/work/dist/.git`） | 138 | 634 | **+497 / 改 47 / 删 1** |
| `src/` 文件 | 22 | 71 | 22 上游全部保留，其中 **7 个改**、**39 个新增**（另 10 个 `*.bak-*` 是开发残留，应清理并入 `.gitignore`） |
| `src/bridge.js` | 10783 行 | 15370 行 | +4709 / −122 |
| MCP 工具（`'qq_*'` 字面量统计） | 39 | 55 | **+18 / −2** |
| HTTP exact-path 端点 | 100 | 149 | **+49 / −0** |
| npm scripts | 1 | ~60 | 全部为自检/回归/运维入口 |

删除的唯一文件：`scripts/probe-events.mjs`（探针并入 `scripts/probe-*.mjs` 家族）。

**一条重要的认知修正**：`src/dsh-client.js`、`src/forward.js`、`src/voice-core.js`、`src/v2-wait.js`、`src/model-prices.js`、`src/state-acl.mjs`、`src/preset-prompt.js`、`src/qq-model-view.js`、`src/md-to-plain.js`、`src/safe-fetch.js`、`src/sensitive.js`、`src/slang-learner.js`、`src/snowluma-conn.js`、`src/self-test.js`、`src/send-voice-lib.js` **与上游逐字节相同**（SHA256 一致）。它们的头注释里写了「兼容 DSH 0.1.5-rc.1」「security hardened」等字样，容易误读成我们的改动；**它们是上游自带的既有能力，本方案一律不改**。复刻时这些文件照抄上游即可，只有下面 7 个需要改。

### 4.2 依赖与工程配置

`package.json` 变更（`+21/−5`）：

```jsonc
{
  "version": "0.2.0-r3",
  "type": "module",
  "engines": { "node": ">=22.13.0" },
  "dependencies": {
    "@deepseek-ai/dsh-host-apiproxy": "0.1.1-rc.2",   // 上游已有
    "@snowluma/mcp": "^1.14.20",                      // 上游已有
    "@snowluma/sdk": "^1.14.20",                      // 上游已有
    "@deepseek-ai/schemastery": "^3.18.1",            // 新增
    "@modelcontextprotocol/sdk": "^1.30.0",           // 新增
    "js-yaml": "^4.3.2",                              // 新增（读写 cordis.patch.yml）
    "zod": "^4.6.7",                                  // 新增（MCP 入参校验）
    "zod-to-json-schema": "^3.25.2"                   // 新增（zod → MCP JSON Schema）
  },
  "scripts": { "start": "node src/bridge.js", "postinstall": "node scripts/patch-snowluma-sdk.mjs" /* + 约 60 条，见 4.9 */ }
}
```

`.npmrc`（新增 1 行）：`node-linker=hoisted`——见 2.3 的理由。

`postinstall` 必须保留：`scripts/patch-snowluma-sdk.mjs` 在安装后修补 `@snowluma/sdk`（上游要求），漏掉会出现「OneBot 消息字段缺失」。

### 4.3 新增的 39 个模块（按能力域分组）

这张表是本方案的「功能清单」，每个模块都是独立可关的开关，落地时可以先只开一半。

#### A. 语气与出站整形

| 模块 | 做什么 | 关键默认 / 开关 |
|---|---|---|
| `src/ai-tone.js` | 出站文本「去 AI 味」确定性后处理：**只删除或 1:1 替换，不重写句子**；每条规则带 `id` + `why` | `config.aiTone.enabled=false` 短路；`stripAgreeOpener` / `stripTrailingPeriod` / `keepPhrases` / `extraPhrases` / `fallbackPolicy` |
| `src/ai-tone-stats.js` | 规则命中度量，只落「规则 id + 字符数」，**绝不落原文** | `{enabled:true, keepDays:30}`；落 `state/ai-tone-stats.json` |
| `src/length-gate.js` | 长消息拆条判定（纯函数，不改写正文） | `{enabled:true, splitAbove:40, warnAbove:60, minPartChars:6, maxParts:2}`；长度按**码点**算 |
| `src/scene-router.js` | 场景路由：文本规则 > 时间规则 > 兜底 | 场景名 8 个，必须与 `roles/小鲸鱼.md` 的 `## 场景：xxx` 完全一致 |
| `src/fewshot-lib.js` | few-shot 正例库（从 `persona-lib/fewshot/*.jsonl` 取样本注入） | `{enabled:true, maxExamples:4, maxChars:900, avoidRecent:12, negativeEnabled:false}` |

#### B. 语音 / 表情 / 图片

| 模块 | 做什么 | 关键默认 / 开关 |
|---|---|---|
| `src/voice-tts.mjs` | TTS 双引擎：edge-tts（默认，24kHz/48kbps）/ MiniMax `speech-2.8-hd`（32kHz/128kbps，按字符计费） | 时长夹逼 2–60 秒；**不依赖 ffprobe**（自解析 MP3 帧头，兼容 ID3v2/MPEG1/2/2.5）；mood 声线表 + `config.voiceTts.moods` 覆盖 |
| `src/auto-voice.mjs` | 语音自动触发：**只走场景白名单，不随机** | `{enabled:true, maxPerDay:30, cooldownMinutes:20, minChars:2, maxChars:20}`；场景顺序即优先级 |
| `src/auto-sticker.mjs` | 语音后按 mood 补一张表情 | `{enabled:true, minScore:6, recentWindow:10, limit:8}`；检索/去重在 `bridge.js` 的 `tryAutoStickerV2` |
| `src/sticker-index.js` | 表情语义检索（BM25） | `FIELD_WEIGHTS {tags:2.6, localNote:1.6, desc:1.2, usage:1.0}`、`K1=1.2`、`b=0.6`；CJK bigram + 单字兜底 |
| `src/send-image-lib.js` | 发图安全库：http(s) 走 `safe-fetch`；本地文件只允许 `config.socialV2.image.dirs`、必须绝对路径、拒 UNC/设备路径、`realpath` 后判目录包含、扩展名+魔数、体积上限 | 不满足就拒绝并说明原因，不静默降级 |
| `src/media-index.js` | 媒体元数据索引（只存句柄不存字节） | `state/media-index.jsonl`；`MAX_BYTES=2MB`、`MAX_REFS=6000`、单消息 ≤20 |
| `src/media-note.js` | 取不到图时「说实话」的统一文案 | `mediaFailNote` / `MEDIA_TOO_LARGE_SHORT` 等 |
| `src/inline-media.js` | 主人私聊唤醒时自动内联最近图片 | 只对 `private:<OWNER_QQ>`；`maxMedia=5`、`INLINE_MEDIA_MAX_MESSAGES=2` |

#### C. 社交节奏与「像人」的时序

| 模块 | 做什么 | 关键默认 / 开关 |
|---|---|---|
| `src/proactive-contact.js` | 周期性主动联系：**只递提示不递正文** | 窗口 10:00–23:00、`quietAfterTalkMs` 2 小时、`maxPerDay`、`jitterMs`、`dryRun`；停机错过不补发（`GRACE_MS=30min`） |
| `src/reminders.js` | 定时提醒存储与调度 | `state/reminders.json`；`TZ=Asia/Shanghai`；**先写 `status=firing` 再发**，重启见 `firing` 不重发；超 `graceMs` 记 `missed` |
| `src/reminder-nudge.js` | 提醒到点前提前铺垫 | `{enabled:true, leadMs:10min, maxPerDay:3, window:'09:00'-'23:00'}`；软提示失败绝不影响硬提醒 |
| `src/turn-visibility.mjs` | 失联安抚：忙碌超时先自己说一句「卡住了」 | `{afterMinutes:8, cooldownMinutes:30, requireBusy:true, maxMessageChars:60}`；`state/stuck-notice.json` |
| `src/catch-up.mjs` | 断线补拉：重连后用 `get_group_msg_history` / `get_friend_msg_history` 补齐 | `{maxCount:50, maxConversations:5, totalTimeoutMs:10000, cooldownMs:60000}`；OneBot time 秒/毫秒归一 |
| `src/wake-history.mjs` | 唤醒前历史预取（不改未读状态） | `{enabled:true, count:12, timeoutMs:2500, maxChars:1600, cooldownMs:60000}` |
| `src/rate-limit.mjs` | 出站限流排队账本（每小时配额打满时按优先级排队，而不是全丢） | 优先级 `owner:100 > directReply:90 > groupReply:60 > sticker:40 > proactive:30 > reminder:20`；`{ttlMs:30min, maxAttempts:8, maxSize:200, baseBackoffMs:1000}` |

#### D. 记忆、人物、日记

| 模块 | 做什么 | 关键默认 / 开关 |
|---|---|---|
| `src/profiles.js` | 群友档案 / 群文化存储 | 记录种类 `[event, care, avoid, topic, style, nickname, note, legacy]`；只记具体事例、拦空泛标签、写入前 `scrubSensitive`、过期按半衰期降权 |
| `src/profile-slice.mjs` | 档案分片推进（持久化游标 + 分片 + gap/overflow 报告） | `{maxMessages:40, minMessages:6, maxBacklog:400}`；**只有写成功才 commit** |
| `src/memory-decay.mjs` | 轻量记忆按半衰期降权折叠（取代上游的「手动删」） | `{halfLifeDays:7, pendingFloor:0.35, foldThreshold:0.15, foldMinCount:3, maxChars:1200}` |
| `src/diary.js` | 日记本：一会话一文件、一天一页、重复写入追加 | `state/diary/<safeKey>.json`；按 `Asia/Shanghai` 切页；`autoWrite.clock=23:30` |
| `src/handoff.mjs` | 交接摘要（长会话压缩前的上下文交接） | `HANDOFF_SCHEMA_VERSION=1`、`HANDOFF_MAX_CHARS=400`；字段 `topics/openLoops/peopleChange/insideJokes/mood`，单条 ≤40 码点 |

#### E. 成本、观测、自检

| 模块 | 做什么 | 关键默认 / 开关 |
|---|---|---|
| `src/cost-guard.mjs` | 成本守门：单日输入、缓存命中率、上下文水位 | **只认 `token-usage.jsonl` 里 `k==='turn'`**（`k:'base'` 是累计基线，混入即翻倍）；阈值必须按本机分布校准，40M 只作代码默认 |
| `src/ops-panel.js` | 优化面板聚合（纯函数无 IO） | 会话键脱敏 `private:1000***001` 式；`OPS_PANEL_VERSION=1` |
| `src/ops-wait-store.mjs` | 每轮 wait 次数分布长期存档 | `turnBins {1,2,3,4}`，只存聚合计数 |
| `src/conn-quality.mjs` | 连接质量时序（SnowLuma / DSH 各自 up/down） | 环形缓冲 7 天 / 5000 条；告警：1 小时内 ≥5 次断线或单次 >10 分钟 |
| `src/health.mjs` | 服务健康时序（四个端口探活结果） | 每 5 分钟一行、288 行/天；`q/b/p/c` 四通道，`-1` 表示没探到 |
| `src/dashboard.js` | `/api/dashboard/services` 的只读快照 | 只 TCP 连一下 + 看 mtime + `schtasks`；**不写文件、不新增端口**、缓存 12 秒、拿不到给 `alive:null` |
| `src/doctor.mjs` | 一键自检纯逻辑 | `ok===true` 才算绿（`undefined/null` 算红）；`CORE_TESTS` 必绿；`--strict` 才升格 |
| `src/sampling-proxy.js` | 采样参数注入代理（见本节末） | 读 `config.sampling`，按 mtime 生效 |

#### F. 运维自动化

| 模块 | 做什么 | 关键默认 |
|---|---|---|
| `src/backup.mjs` | 代码保险箱（纯逻辑，I/O 在 `scripts/backup.mjs`） | `at:'03:10'`；源含 `qq-bridge/{src,scripts,config.json,public,docs}`、`<DSH_HOME>/profiles/*/cordis.patch.yml`、`memory-index/*.py`；目标 3 处（本地快照/外置盘/云盘）；`retention{daily:7, weekly:4}`；`drill{enabled:true, everyDays:30}` |
| `src/clean-state.mjs` | 磁盘卫生三档 `keep/cache/junk` | `{junkDays:3, cacheDays:7}`；判定顺序 keep→junk→cache；未到天数也列出「为什么没删」 |
| `src/daily-brief.mjs` | 每日简报渲染（桥停掉也能单独跑） | `at:'08:00'`、`windowHours:24`、`maxChars:560`、`maxLines:9`；**纯文本，不含 `** # ```** |
| `src/weekly-report.mjs` | 周报 | `{at:'20:00', dayOfWeek:0, windowDays:7, maxLines:14}`；数据源 token/tool-calls/doctor/计划复选框 |
| `src/zip.mjs` | 零依赖 zip（UTF-8 flag bit 11） | 为什么不用系统工具：`bsdtar` 打中文名不带 UTF-8 标志、`Expand-Archive` 按 GBK 解出乱码、`Compress-Archive` 撞 32k 命令行上限 |
| `src/context-budget.mjs` | 上下文水位守门 | **默认 `enabled:false`（总回滚开关）**；`mode:'shadow'`、`softAt:60000`、`hardAt:120000` |

#### 采样代理（单独说，因为它改的是模型侧）

`src/sampling-proxy.js` 存在的唯一理由：**DSH 的 `GenerateOptions` 只有 `temperature/maxTokens/stop`，没有 `top_p` / 频率·存在惩罚，provider 配置里也没有 temperature**。要调这些参数，只能把 `DEEPSEEK_BASE_URL` 指到本地代理，由代理在转发时补进请求体。

两条实测约束（2026-10-22）：

1. **thinking 开启时 DeepSeek 会忽略 temperature**，所以必须 `disableThinking: true`，否则温度怎么调都不生效。
2. `DEEPSEEK_BASE_URL=http://127.0.0.1:<PORT_SAMPLING>` **不能再拼 `/anthropic`**，代理自己补上游路径；多拼一段会 404。

### 4.4 改动的 7 个既有模块

| 文件 | 行数 | 改了什么 | 为什么 |
|---|---|---|---|
| `src/bridge.js` | 10783→15370 | 主体：新增二代仿真（reserved2）处理链、静音/睡眠定时、主动联系、提醒、语音/表情/图、拆条、去 AI 味、档案、日记、限流、成本、控制台路由与外链页面 | 全部新能力都要落在这条「消息进 → DSH → 出站」的主干上 |
| `src/mcp-snowluma-safe.js` | 1249→1963 | 工具面从 39 扩到 55（+18/−2）；发送类强制 `allow.groups/allow.private` 白名单；敏感信息不再在 MCP 侧重复拦（统一由 `bridge.js` 的 `SENSITIVE_RE` 负责） | 让模型能写日记/档案/提醒/发图，但**不能**往白名单外的会话发消息 |
| `src/mcp-host-server.js` | — | **删掉 start/stop SnowLuma，只留 `snowluma_status`（只读）** | SnowLuma EULA §5.4 禁止用自动化脚本部署；设计不变量「只探测、不部署」 |
| `src/mcp-web-search-safe.js` | — | 只读 `web_search`/`web_fetch`；禁内网、DNS rebinding、逐跳校验重定向、限量读；查询去 CQ 码并截断 120 字 | 桥有公网可达面，搜索工具是 SSRF 入口 |
| `src/role-card.js` | 108→207 | 人格卡按模式取小节：`v1` / `v2` 两套，标题标记 `〔二代〕/[v2]` 与 `〔一代〕/[v1]` 在注入前剥掉 | 一代/二代两套人格不能互相串味 |
| `src/sticker-lib.js` | 295→437 | 表情知识库归一化（QQ 收藏为源、本地库为 AI 认知层）；`desc/localNote/tags` 注入前必须单行化 | 多行文本会破坏提示词的分节结构 |
| `src/token-ledger.js` | 932→1026 | 权威总量改从 `session/follow` 快照的 `projections.values.tokenUsage` 取（含启动前历史，只补增量）；逐轮明细按 `(session,turn,step,retry)` 后到覆盖先到 | 原来只记自己看到的轮次，重启后总量会「倒退」 |

### 4.5 MCP 工具面（39 → 55）

新增 18：

```text
日记/风格   qq_diary_write  qq_diary_read  qq_diary_list  qq_style_guide
表情/图片   qq_find_sticker  qq_send_image
提醒        qq_set_reminder  qq_list_reminders  qq_cancel_reminder
档案        qq_profile_query  qq_profile_write  qq_profile_remove  qq_profile_clear
语音        send_tts_voice
自我管理    qq_set_avatar  qq_set_profile  qq_set_signature   （仅 <OWNER_QQ> 私聊，>3MB 拒绝）
本机命令    qq_desk_command
```

删除 2：`qq_memory_remove`、`qq_memory_clear` —— 改为「按时间衰减折叠」（4.3-D）；**彻底清除只能由人在控制台做**，不给模型删除长期记忆的能力。

### 4.6 HTTP 端点面（100 → 149）

新增 49 条，按域分组（`exact path` 统计，重跑 0.3 的脚本即可复现）：

| 域 | 端点 |
|---|---|
| 页面 | `/m`、`/m/`、`/dashboard`、`/ops`、`/stickers-debug`（+尾斜杠） |
| 面板/观测 | `/api/dashboard/services`、`/api/ops/panel`、`/api/conn-quality`、`/api/ai-tone/stats`、`/api/rate-limit`、`/api/local-token` |
| 日记 | `/api/diary`、`/api/diary/book`、`/api/diary/export`、`/api/diary/remove`、`/api/socialV2/diary`、`/api/socialV2/diary-write` |
| 提醒 | `/api/reminder/{create,list,cancel}`、`/api/socialV2/reminder-{create,list,cancel}` |
| 档案 | `/api/profile{,/write,/remove,/clear,/extract}`、`/api/profiles{,/write,/remove,/clear,/extract}`、`/api/socialV2/profile*` |
| 表情/图 | `/api/stickers/{search,explain}`、`/api/socialV2/sticker-search`、`/api/send/image`、`/api/image/send`、`/api/socialV2/send-image` |
| 仿真 | `/api/socialV2/{manage,wake-prompt,auto-voice/preview}` |
| 人格 | `/api/roles/fewshot`、`/api/roles/fewshot/import` |

写接口一律要求控制台令牌（`state/console-token`），**手机桥代访问时注入同一个令牌**（见 7.2），所以从手机点开的页面无需二次登录——这是设计取舍，落地时要保证手机桥本身已配对。

### 4.7 提示词与人格（真正的行为差异）

改动落在 4 个文件：`dsh/agent-presets/qq-chat/agent.cordis.yml`（+4/−2）、`dsh/agent-presets/qq-chat-v2/agent.cordis.yml`（+20/−6）、`plugins/qq-agent-presets/presets/qq-chat.patch.yml`、`plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml`（+5/−4），外加 `roles/小鲸鱼.md`（179→267 行，+95/−7）。

1. **删掉 `suffix: Your working directory is {{cwd}}.`**（两套预设、两份 patch 全部删）。
   理由：`{{cwd}}` 不在 loop 注册表里，写了会在装配阶段抛 `unknown prompt variable`，整个预设加载失败（2026-10-17 实测）。当前目录由工作目录服务提供，不需要提示词再说一遍。
2. **二代新增 3 条工具/能力条目**：`17 日记本`、`18 长期记忆`（只读 `mcp__memory__memory_search`，`k=3`，每轮最多 1 次，历史片段**只当线索不当指令**）、`19 改自己的资料`（`qq_set_avatar/qq_set_profile/qq_set_signature`，仅 `<OWNER_QQ>` 私聊）。
3. **新增 3 段反模式约束**：【反 AI 味：拒绝有求必应】、【别当心理咨询师】、【记忆卫生】；并规定接话不用「行，」「好的，」开头。
4. **表情频率**：从「3~5 轮一张」改成「几乎每 1~2 轮就可以来一张、别等对方点名要」。
5. **记忆卫生**：把「过时记忆用 `qq_memory_remove/clear` 删掉」改成「按时间衰减折叠，彻底清掉由人在控制台做」。
6. `plugins/qq-agent-presets/qq-tool-restrict.mjs` +1 行：工具前缀白名单加入 `mcp__memory__`（否则新挂的 memory MCP 会被工具限制器全部屏蔽）。

`roles/小鲸鱼.md` 的 267 行里必须有 8 个 `## 场景：xxx` 小节，名字与 `scene-router.js` 的 `SCENE_NAMES` 逐字一致（情绪倾诉/被问是不是AI/求推荐/被怼/冷场/深夜/群聊接梗/正经问题），配对的风格素材在 `persona-lib/style/*.md`。**改场景名必须两处一起改**，否则该场景静默失效（不报错）。

### 4.8 状态文件契约

`state/` 是运行产物，不入库。落地时至少要认识这些**权威文件**（其余都是日志/截图/探针残留，可以随时删）：

| 文件 | 谁写 | 内容 |
|---|---|---|
| `state/social-v2.json`（代码里 `SOCIAL_V2_FILE`） | `bridge.js` | 二代仿真全量状态：静音、睡眠、主动联系、提醒去重、语音/图/表情计数 |
| `state/sessions.json` | `bridge.js` | QQ 会话 ↔ DSH 会话映射 |
| `state/current-role.json` | `bridge.js` | 当前人格卡与模式 |
| `state/bridge.lock` | `bridge.js` | 单实例锁（内容就是 PID，编排脚本据此判活） |
| `state/console-token` | `bridge.js` | 控制台令牌（手机桥读它做代访问） |
| `state/token-usage.jsonl` | `token-ledger.js` | 逐轮 token 采样（`k:'turn'` 才是明细，`k:'base'` 是基线） |
| `state/tool-calls.jsonl` | 工具日志 | 工具调用轨迹 |
| `state/reminders.json` / `proactive-contact.json` / `stuck-notice.json` / `profile-session.json` | 各自模块 | 独立小状态，坏文件隔离重建 |
| `state/diary/<safeKey>.json` | `diary.js` | 日记，一天一页 |
| `state/profiles.json` / `stickers.json` / `slang.json` | 档案/表情/黑话 | 可重建的认知层，丢了不致命 |
| `state/media-index.jsonl` | `media-index.js` | 媒体句柄索引（**不存字节**） |
| `state/health.jsonl` / `conn-quality.json` | 观测 | 健康与连接质量时序 |
| `state/console-open.html`、`state/guard.log`、`state/bridge.log*` | 运维 | 打开控制台的跳板页 / 守卫日志 |

**keep 白名单**（`clean-state` 判据）：`state/*.json`、`*.jsonl`、`*.token`、`console-token`。其余按 `junkDays:3` / `cacheDays:7` 清理。

注意：本机 `state/` 里混有大量**一次性排查残留**（截图 `*.png`、`asar-*.py`、`sampling-probe*.mjs`、`tmp-*.json`、`_badargs.txt`、`_boot.js` 等）。这些不属于方案，复刻时一个都不要带。

### 4.9 脚本与回归

`scripts/` 共 183 个文件（上游 77 → 新增 106），其中 108 个是 `test-*`。按用途分四类：

| 类别 | 代表入口 | 用途 |
|---|---|---|
| 部署/配置 | `setup-dsh.mjs`、`patch-snowluma-sdk.mjs`、`open-console.mjs`、`harden-state-acl.mjs`、`diagnose-acl.mjs` | 装 DSH profile（**幂等**，重跑只替换 MCP 托管区块）、修 SDK、开控制台、收紧 state ACL |
| 运维定时 | `backup.mjs`、`clean-state.mjs`、`daily-brief.mjs`、`weekly-report.mjs`、`doctor.mjs`、`health-probe.mjs`（各带一个 `.vbs` 无窗口启动） | 计划任务调这些 |
| 探针 | `probe-events/tools/protocol/settings/heartbeat`、`scan-dsh-tool-names`、`check-sampling-proxy`、`privacy-scan` | 升级前先跑，避免黑盒 |
| 回归 | `test-*.mjs` 家族 + `eval/`（盲评：RUBRIC + 30 条上下文 + A/B 两套采样 + review.html 打分页） | 改提示词/工具后的回归底座 |

`pnpm run`（或 `npm run`）里最值得先接进 CI 的 8 条（都快、都不依赖活 SnowLuma）：

```text
npm run test-md           # Markdown → QQ 纯文本
npm run test-wait         # 「话说一半」判定
npm run test:ai-tone      # 去 AI 味规则
npm run test-stickers     # 表情库归一化
npm run test-reminders    # 提醒状态机
npm run test:scene-router # 场景名与角色卡一致性
npm run test:preset-prompt# 预设提示词标记完整性
npm run harden-acl        # state 目录 ACL（幂等）
```

**关于「历史红」**：`doctor.mjs` 会跑一遍 `CORE_TESTS`，其中约 20 条历史用例依赖活的 SnowLuma 或已删模块，常年红。所以 `doctor` 的规则是「`ok===true` 才算绿，`CORE_TESTS` 必绿，其余只记历史」。不要为了让报告全绿去改这些用例。

### 4.10 启动与守护脚本（`start.bat` / `restart.bat` / `run-hidden.vbs`）

上游这两个 bat 在真实机器上**根本跑不起来**，我们踩了 5 个坑，每个都是可复现的：

| # | 坑 | 现象 | 修法 |
|---|---|---|---|
| 1 | `node` 解析到 `node.cmd`，批处理里不加 `call` 会转移控制权 | `start.bat` 第一行 node 之后静默结束（exit 0、无输出、没有桥） | 所有 node 调用改 `call node ...` |
| 2 | PATH 里没有 node（隐藏启动时时序不同） | 报错只写进日志，永远看不见 | 先 `where node`，失败则回退到 DSH 运行时 node 目录（`<DSH_RUNTIME_NODE>` 所在 `bin`） |
| 3 | 退出码 2 = 已有桥持锁 | 原版直接退出；若那个实例随后死掉，就再没人拉起 | 改为 `ping -n 121` 等 120 秒后重试循环（持有者可能是 DSH 自己 spawn 的 supervisor） |
| 4 | `timeout /t` 在 stdin 被重定向时报错 | 被 `cmd /c restart.bat > log` 调用时「Input redirection is not supported」，等于没等 | 一律用 `ping -n <n> 127.0.0.1 >nul` 当 sleep |
| 5 | 路径里的**单引号**会提前闭合 PowerShell 单引号字符串（用户名含 `'` 时） | restart 的 kill 段落被整段静默跳过——「restart 从来没重启过任何东西」 | 目录经环境变量传进去（`set "QQBRIDGE_DIR=%~dp0"`），命令里只引用 `$env:QQBRIDGE_DIR` |

另有两处结构性改动：

- `restart.bat` 用 `wscript.exe //B //Nologo run-hidden.vbs start.bat` 起守卫，输出进 `state/guard.log`。原来是 `start "" cmd /c start.bat`，每次重启都在桌面留一个黑框。
- `start.bat` 在 `bridge.js` 之前先跑 `harden-state-acl --quiet`，保证状态目录权限收敛（受限上下文下不预收紧会写不进去）。

`run-hidden.vbs` 只有一件事：`WScript.Shell.Run` 时把窗口样式设成 `SW_HIDE`（0）。所有「无窗口」都靠它，不要用 `start /min`（那只是最小化）。

### 4.11 桌面命令通道（`scripts/desk-command.mjs`，可选）

原版没有「QQ 端指挥桌面端」这条通道。本方案加了一条，入口是 MCP 工具 `qq_desk_command`：

```text
QQ 消息 → 工具 qq_desk_command
        → 入队落盘 state/desk-commands.json（保留最近 300 条）
        → 静态审核（scripts/audit-desk-command.mjs）
        → 作为一条排队消息投递进桌面端 DSH 会话
        → 桌面端 agent 按审核结论执行；风险等级 high 的先找用户确认
```

设计要点：

1. **投递失败不丢**：留在队列里，下次 `send` / `retry` 重投。
2. **不用 `src/dsh-client.js` 的 `NodeApiClient`**：这个脚本要同时在「bridge 进程内」和「沙箱里的 node 子进程」两种环境跑；后者枚举不到桌面端进程的 `CommandLine`（`Get-CimInstance` 只回同容器进程），但 `netstat -ano` 仍能列出全部监听端口。所以**端口发现走 `netstat` + DSH 握手探测**，RPC 走原始 `fetch` + 现签浏览器 cookie——两条路都不依赖进程枚举权限。
3. **端点缓存**在 `state/desk-endpoint.json`（`{baseUrl, at}`），`config.desk.baseUrl` 可手工覆盖。
4. **三层开关**：`config.manage.deskCommand`（工具是否注册）、`config.desk.enabled`（是否投递）、`config.desk.blockHighRisk`（high 风险是否直接拒）。
5. CLI 自带 `send / list / show / retry / audit / endpoint`，可脱离 QQ 手工排障。
6. 回归：`scripts/test-mcp-manage.mjs` 覆盖「入队成功 + 风险分」两条断言。

不是必选项：不配 `desk.*` 就只是一条不可用的工具；删掉工具注册也不影响其他功能。

### 4.12 插件侧改动（`plugins/`）

| 插件 | 改动 | 说明 |
|---|---|---|
| `plugins/qq-mode-console` | **只改 `package.json`**（`lib/index.js` 7238B 与上游逐字节相同） | 宿主加载逻辑没动，改的是版本号与依赖声明 |
| `plugins/qq-agent-presets` | `qq-tool-restrict.mjs`（12195→12283B，+1 行工具前缀白名单）、`presets/qq-chat-v2.patch.yml`（21910→26598B）、`presets/qq-chat.patch.yml`（6816→6759B）、`package.json` | 见 4.7 |

两条注意：`qq-mode-console` 一旦动了 `lib/index.js`，就等于改宿主加载路径，升级时要重新核对；两个插件是以 Junction 方式被引用的（5.2），**不要**在 `<DSH_HOME>/plugins/` 下就地改文件——改的是同一份物理文件，容易误以为在改副本。

---

## 5. L3：DSH 侧（`<PROFILE>` 实例）

### 5.1 为什么要单独一个 profile

QQ 端的模型、人格、MCP 工具集与桌面版完全不同（不同的默认模型配置、不同的工具白名单、不同的提示词预设），混在 `desktop` profile 里会互相污染。所以新开一个 `<PROFILE>`，跑独立端口 `<PORT_DSH>`，两边的 `cordis.patch.yml` 互不影响。

### 5.2 `<DSH_HOME>/profiles/<PROFILE>/package.json`

```jsonc
{
  "name": "dsh-profile-<PROFILE>",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "qq-mode-console",
        "qq-agent-presets"
      ]
    }
  },
  "dependencies": {
    "qq-mode-console": "link:<DSH_HOME>/plugins/qq-mode-console",
    "qq-agent-presets": "link:<DSH_HOME>/plugins/qq-agent-presets"
  }
}
```

两个插件用 `link:` 指向 `<DSH_HOME>/plugins/`，而 `<DSH_HOME>/plugins/<name>` 本身是指向 `<BRIDGE_DIR>/plugins/<name>` 的 **Junction（目录联接）**——不是拷贝。这样「改工作区即生效」，不需要每次重新安装。

### 5.3 `cordis.yml` 与 `cordis.patch.yml`

`cordis.yml` 内容就一行 `[]`：整棵树由 patch 组装，避免手写树与 patch 冲突。

`cordis.patch.yml` 分四段，顺序不能乱：

**① 模式开关**

```yaml
- id: qq-mode
  config:
    mode: reserved2      # 二代仿真；一代是 reserved
```

**② 默认模型**

```yaml
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: high
```

**③ MCP 托管区块**（`# === qq-bridge MCP BEGIN ===` … `END`，由 `scripts/setup-dsh.mjs` **整体替换**，手改会被覆盖）

```yaml
# === qq-bridge MCP BEGIN ===
- insert:
    - id: mcp-snowluma
      type: dsh-mcp-client
      config:
        serverName: snowluma
        command: <DSH_RUNTIME_NODE>
        args: ['<BRIDGE_DIR>/src/mcp-snowluma-safe.js']
        toolCallTimeoutMs: 725000        # 单次工具最长 ~12 分钟（等语音/图/长任务）
    - id: mcp-snowluma-host
      type: dsh-mcp-client
      config:
        serverName: snowluma-host
        command: <DSH_RUNTIME_NODE>
        args: ['<BRIDGE_DIR>/src/mcp-host-server.js']
    - id: mcp-web-search-safe
      type: dsh-mcp-client
      config:
        serverName: web-search-safe
        command: <DSH_RUNTIME_NODE>
        args: ['<BRIDGE_DIR>/src/mcp-web-search-safe.js']
    - id: mcp-memory
      type: dsh-mcp-client
      config:
        serverName: memory
        command: <DSH_RUNTIME_NODE>
        args: ['<MEMORY_INDEX_DIR>/mcp-server.mjs']
        toolCallTimeoutMs: 240000
# === qq-bridge MCP END ===
```

三条落地规则：

1. `command` 必须是**绝对路径**的 node（DSH 子进程的 PATH 不可靠）。用 DSH 运行时自带的那个，别用系统 node。
2. `toolCallTimeoutMs` 不加的话，默认超时会在长任务（发语音、下载图、等 DSH 回合）中途掐断。
3. memory 是**可选组件**：没有 `<MEMORY_INDEX_DIR>` 就删掉 `mcp-memory` 这一段，同时把 4.7 的第 6 条（工具前缀白名单）保留即可（白名单里多一个不存在的前缀无害）。

**④ 重试策略补丁**（`retryPolicy` 在 patch 里是**整段替换**，默认 5 个码必须一并写出，少写一个就等于删掉）

```yaml
- id: llm-deepseek
  config:
    retryPolicy:
      mode: normal
      retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE]
- id: llm-deepseek-account
  config:
    retryPolicy:
      mode: normal
      retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE]
```

**为什么加 `MALFORMED_RESPONSE`**：模型偶尔会生成坏 JSON 工具参数，默认策略下这一判定为致命错误，整个回合死掉，QQ 那边只看到「⚠️ agent 处理出错：… tool input is invalid JSON」。加进重试码后变成一次自动重试，用户只感觉「慢了一点」。

### 5.4 `<DSH_RUNTIME_NODE>` 怎么取

不要写死。两条路：

1. `<DSH_HOME>/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`（DSH 自带的运行时依赖，随 DSH 升级目录名可能变）——所以先探测再写；
2. `scripts/setup-dsh.mjs` 内部用 `process.execPath` 写入（DSH 拉起 setup 时的进程就是运行时 node）。

**判据**：写进 patch 的路径本身不存在时，DSH 启动会报 MCP 客户端启动失败，但桥照常跑——症状是「模型说它没有工具」。所以 5.5 的验收步骤必须先看工具列表。

### 5.5 验收

```powershell
# 1) DSH 实例在听
Test-NetConnection 127.0.0.1 -Port <PORT_DSH>

# 2) patch 幂等：连跑两次 setup，第二次不应产生 diff
node <BRIDGE_DIR>/scripts/setup-dsh.mjs --profile <PROFILE>
node <BRIDGE_DIR>/scripts/setup-dsh.mjs --profile <PROFILE>

# 3) 工具面真的注册了（应看到 qq_diary_write / qq_find_sticker 等）
node <BRIDGE_DIR>/scripts/test-mcp-servers-stdio.mjs
```

`npm run test:setup-idempotent` 与 `npm run test:mcp-servers` 覆盖了这两条。

---

## 6. L4：编排层 `qqbot/`（上游完全没有）

上游假设「人自己按顺序启动 SnowLuma、QQ、桥」。真实机器上这不可行：五个进程有严格依赖、有时序陷阱、有身份认错。所以有了 `<QYBOT_DIR>`。

### 6.1 目录与职责

| 文件 | 职责 |
|---|---|
| `qqbot.mjs` | 五层编排器（唯一需要懂代码的文件） |
| `qqbot.local.json` | **本机专有配置**（口令、路径、端口）。机密：只提交一个 `qqbot.local.example.json`，键名照抄、值留空 |
| `start-qqbot.bat` / `start-qqbot-diag.bat` | 前台启动 / 带诊断输出启动 |
| `stop-qqbot.bat` | 全链停止（含子进程树） |
| `autostart.cmd` + `autostart-hidden.vbs` + `autostart-wait.vbs` | 开机自启（隐藏 + 等待网络就绪） |
| `watchdog.ps1` + `install-watchdog.ps1` | 看门狗注册（计划任务，每 N 分钟核对端口/进程） |
| `run-hidden.vbs` | 无窗口启动的公共组件 |
| `logs/`、`tmp/` | 日志 / 兜底 TEMP |

### 6.2 配置键（`qqbot.local.json`，只写键名）

```jsonc
{
  "BOT_UIN": "<QQ_BOT_UIN>",
  "ownerQQ": "<OWNER_QQ>",
  "snowluma": { "url": "http://127.0.0.1:<PORT_SNOWLUMA_UI>", "dir": "<SNOWLUMA_DIR>",
                "user": "admin", "password": "<SNOWLUMA_WEBUI_PASSWORD>" },
  "qqExe": "<QQ_INSTALL_DIR>/QQ.exe",
  "onebot": { "httpPort": <PORT_ONEBOT_HTTP>, "wsPort": <PORT_ONEBOT_WS> },
  "dsh":    { "port": <PORT_DSH>, "profile": "<PROFILE>", "cmd": "<DSH_CMD>" },
  "bridgeDir": "<BRIDGE_DIR>",
  "bridgeConsolePort": <PORT_CONSOLE>,
  "node": "<NODE_EXE>"
}
```

### 6.3 四段辅助逻辑（每一段都对应一个真实事故）

| 逻辑 | 做什么 | 不这么做会怎样 |
|---|---|---|
| `integrityLevel()` | `whoami /groups` 里匹配 `S-1-16-{0,4096,8192,12288,16384}` → Untrusted/Low/Medium/High/System | 不知道当前进程完整性时，可能以 Low 拉 SnowLuma，它会因无法写自己的 data 目录而半死 |
| `tempUsable()` | `mkdtempSync(os.tmpdir())` 探针；不可用就把子进程 `TEMP/TMP` 指到 `<QYBOT_DIR>/tmp` | 受限上下文里 `%TEMP%` 不可写 → 子进程一用工具就报「执行环境坏了」 |
| `childEnv()` | 在上一条基础上，若 `sampling.enabled` 则注入 `DEEPSEEK_BASE_URL=http://127.0.0.1:<PORT_SAMPLING>` | 采样参数不生效（4.3 末）；或误拼 `/anthropic` 导致 404 |
| `killTree()` | `taskkill /T /F` 执行后再用 `Stop-Process` 兜底核对 | `taskkill` 对某些子进程会误报「没有找到进程」，导致「停了但没停」 |

### 6.4 `up` 的八步（顺序即依赖，缺一步就断链）

| # | 步骤 | 判定成功 | 超时 |
|---|---|---|---|
| 1 | `ensureSnowLuma` | `GET /api/ui/public` 有响应 | 90s |
| 2 | `slLogin` | `POST /api/login` 拿到 token | 10s |
| 3 | `ensureQQRunning` | `/api/processes` 里存在名字匹配 `^qq(\.exe)?$` 的进程 | 120s |
| 4 | `ensureHook` | 每个未注入 PID 都 `injected===true` 且 `uin===<QQ_BOT_UIN>` | 30s/个 |
| 5 | `ensureOneBot` | `/api/config/<uin>` 的 http/ws 端口与期望一致（不一致只 warn） | — |
| 6 | `ensureSamplingProxy` | `<PORT_SAMPLING>` 在听 | 20s |
| 7 | `ensureDsh` | `<PORT_DSH>` 在听 | 150s |
| 8 | `ensureBridge` | `state/bridge.lock` 的 PID 存活 **且** `<PORT_CONSOLE>` 在听 | 60s |

关键细节：

- **第 1 步**：进程已是 Low/Untrusted 时，不能直接 spawn SnowLuma（会继承低完整性），改为通过 `explorer.exe` 代理拉起 `start-snowluma.bat` 以拿到 Medium 完整性。SnowLuma 需要 Medium（`S-1-16-8192`）才能正常读写自己的数据目录。
- **第 2 步**：登录拿不到 token，直接报「WebUI 口令被改」，不要重试——重试只会把账号锁死。
- **第 3 步**：先等 30 秒再判断，防止 QQ 自己的守护进程正在拉起时误判「没在跑」而重复 spawn（双开 QQ 必炸 hook）。
- **第 4 步是整套编排的核心**：
  1. 对每个**未注入**的 QQ 进程，先 `POST /api/processes/<pid>/probe-login` 认身份；
  2. 认出来的 `uin` ≠ `<QQ_BOT_UIN>` → **直接跳过**（主号绝不能注 hook）；
  3. `POST /api/processes/<pid>/load` 注入；
  4. 30 秒内复核 `injected===true` 且 `uin===<QQ_BOT_UIN>`；
  5. 复核失败 → `POST /api/processes/<pid>/unload` 卸载并继续下一个，最后仍无可用进程就 fail-fast。
- **第 8 步**：判断「桥活着」必须是**锁 PID 存活 + 端口在听**两个条件都满足。只看锁文件会出现「僵死进程占锁」；只看端口会出现「端口被别的进程占」。都不满足就删锁、重启桥。

### 6.5 `console` 子命令

`qqbot.mjs console` → 调 `<BRIDGE_DIR>/scripts/open-console.mjs`：读 `state/console-token`，拼出带令牌的 URL 并用默认浏览器打开。这样人不用记令牌，也不用把它贴在聊天里。

### 6.6 开机自启与看门狗

- 自启链路：计划任务 → `wscript //B autostart-hidden.vbs` → `autostart.cmd` → `start-qqbot.bat`（隐藏、无黑框）。
- `autostart-wait.vbs` 负责等网络/Tailscale 就绪再放行（手机桥依赖它，先起会 502）。
- `watchdog.ps1` 每 N 分钟核对 `<PORT_CONSOLE>` / `<PORT_DSH>` / `<PORT_SNOWLUMA_UI>`，缺哪个补哪个；`install-watchdog.ps1` 负责注册计划任务（需要一次提权）。
- 计划任务的三个已知坑（通用）：`StopOnIdleEnd` 必须关（否则空闲即杀）；任务要在用户登录后运行而不是「不管用户是否登录」；`lastResult` 为 `0xC000013A` 表示是被 Ctrl-C 终止的，不是崩溃。

---

## 7. L5：访问层（控制台 / 手机 / APK）

### 7.1 桌面控制台（`<PORT_CONSOLE>`）

`public/console.html`：4885 → 5380 行（258KB，单文件含样式与脚本）。新增区块（按页面顺序）：

1. **运行模式**：一代/二代仿真切换与当前状态
2. **会话映射**：QQ 会话 ↔ DSH 会话（可点进去看）
3. **挂起审批 / 提问**：DSH 的提问与审批在这里回（手机也能回）
4. **活动日志**（最近 100 条）
5. **人格与角色**：编辑、新建、另存副本、删除、清空表单；`保存并同步到 DSH`、`还原上次备份`
6. **日记本**：列表、看当天、`导出 Markdown`
7. **一代仿真（reserved）**：保存社交配置、立刻投喂摘要、设为活跃/观望
8. **二代仿真（reserved2）控制台**：暂停/恢复二代 AI、重置二代状态、保存参数、刷新语音库、试发语音、AI 反馈（加载/清空）、工具日志（加载/清空）、记忆（加载/清空全部）、唤醒状态（查看/刷新）

另有三张独立页面：`dashboard.html`（服务总览，39KB）、`ops.html`（优化面板，15KB）、`stickers-debug.html`（表情检索调试，7.7KB），以及 `/favicon.ico`。

### 7.2 手机访问（PWA + 手机桥反代）

`public/mobile.html`（21.5KB）+ `public/mobile/manifest.webmanifest`（632B）+ `public/mobile/sw.js`（1.4KB）+ 两档图标（192/512）。这是一个**独立的窄屏页面**，不是把桌面控制台缩窄——因为桌面那套 20 多个区块在手机上没法用。

手机桥（`<MOBILE_DIR>/dsh-mobile-bridge.cjs`，81KB）把 QQ 控制台当成**第三个被反代服务**：

```text
QQ_UPSTREAM = env BRIDGE_QQ_UPSTREAM，默认 '127.0.0.1:<PORT_CONSOLE>'
QQ_PREFIX   = '/__qq'
proxyQQ(req,res,restPath) → 读 <BRIDGE_DIR>/state/console-token 注入 → 转发，默认 rest = '/m'
```

三个设计点：

1. **令牌由桥注入**，手机端不存令牌：访问 `/__qq/m` 时手机桥自动带上 `console-token`。前提是手机桥**已完成配对**（配对是手机桥自己的机制），所以安全边界落在配对而不是 QQ 控制台。
2. **两个前缀**：`/__qq/...` 是规范形式，`/qq/...` 是手输的短别名（人真的会手打短的那个）。
3. **配对后 `/__qq` 直接 302 到手机页**，少一次点击。

手机桥自身的基础设施（不属于本方案的核心改动，但复刻需要）：8899 HTTP + 8443 HTTPS（Tailscale 证书）、配对令牌、`watchdog.ps1`、`install-autostart.ps1`、`rotate-pair-token.ps1`、`serve.cjs` 静态兜底。

### 7.3 APK（可选的「原生入口」）

`android/` 是一条**不依赖 Android Studio/Gradle** 的手工打包流水线，用 SDK 里的 `aapt2` + `d8` + `apksigner`：

| 文件 | 作用 |
|---|---|
| `build-apk.ps1` | 主流水线：编译资源 → 编译 java → dex → 打包 → 对齐 → 签名 |
| `generate-icons.ps1` | 从一张源图生成 5 档 mipmap |
| `app/AndroidManifest.xml` | 单 Activity、网络权限、无第三方依赖 |
| `app/java/.../MainActivity.java` | WebView 壳：指向 `<TAILSCALE_HOST>:<PORT_MOBILE_TLS>/__qq/m`，处理返回键、下拉刷新、证书错误 |
| `console.keystore` | 自签证书（**含私钥口令，禁止入库**；落地时自己 `keytool -genkeypair` 生成） |
| `out/qq-console.apk` | 产物（70KB 级别） |

落地顺序：先确认手机浏览器能打开 `/__qq/m`（Tailscale 通、配对完成），再打 APK——否则装上去只会白屏，且无法区分是 APK 还是网络问题。

---

## 8. 从零落地步骤（0 → 10）

按顺序做，每步都有可验收结果。**任何一步没通过就停下**，不要叠加。

| # | 做什么 | 验收 |
|---|---|---|
| 0 | 装 Node ≥22.13.0；解压 SnowLuma 1.14.22；clone qq-bridge `v0.2.0` 到 `<UPSTREAM_BRIDGE>` | `node -v`；两目录可读 |
| 1 | `<BRIDGE_DIR>` 用上游代码建仓，写 `.npmrc`（`node-linker=hoisted`）；`pnpm install --frozen-lockfile`（无 pnpm 用 `npm ci`） | `node src/bridge.js --help` 不报错 |
| 2 | 建 `<DSH_HOME>/profiles/<PROFILE>`：`package.json` + `cordis.yml`(`[]`)；两个插件 Junction 到 `<BRIDGE_DIR>/plugins/` | `ls <DSH_HOME>/plugins` 显示 Junction |
| 3 | 跑 `setup-dsh.mjs` 生成 `cordis.patch.yml` 的 MCP 区块；手工补 ① ② ④ 三段 | 连跑两次 setup 无 diff；`test-mcp-servers-stdio` 通过 |
| 4 | SnowLuma 首启设 WebUI 口令；写 6 个 `config/*.json`（3.2–3.5） | `/api/ui/public` 可达；两个 `onebot_*.json` 里端口正确 |
| 5 | 按 4.1–4.4 移植代码：先 `src/` 39 个新模块 + 7 个改动模块，再 `public/` 四个页面 + `mobile/`，再 `plugins/`、`roles/`、`persona-lib/`、`eval/` | `npm run test-md`、`test-wait`、`test:ai-tone` 绿 |
| 6 | 写 `config.json`（从 `config.example.json` 起，按附录 B 补 `aiTone/voiceTts/socialV2/costGuard/backup/...` 各段） | 桥启动日志无「未知配置段」 |
| 7 | 写 `<QYBOT_DIR>`：`qqbot.mjs` + `qqbot.local.json` + 4 个 bat + 3 个 vbs + `watchdog.ps1` | `node qqbot.mjs status` 能列出五层状态 |
| 8 | `node qqbot.mjs up` 一条命令拉起全链 | 五个端口都在听；QQ 里发一句能收到回复 |
| 9 | 注册开机自启 + 看门狗（提权一次） | 重启机器后 `status` 全绿；手动 kill 一个进程 5 分钟内自愈 |
| 10 | （可选）手机桥 + PWA + APK；`memory-index` 挂上长期记忆 | 手机 `/__qq/m` 可操作；`npm run test:dsh-auth`、`npm run test:dsh-inbox` 绿 |

---

## 9. 验收清单（可直接勾）

### 链路

- [ ] `<PORT_ONEBOT_WS>` 有桥连上（SnowLuma 侧连接数为 1）
- [ ] `state/bridge.lock` 的 PID 存活且 `<PORT_CONSOLE>` 在听
- [ ] QQ 私聊发「在吗」→ 30 秒内有回复
- [ ] 群里 @ 它 → 有回复；不 @ 且不在主动联系窗口 → 不说话
- [ ] 长任务（改文件类）→ 8 分钟内先收到「卡住了」安抚，任务完成后有结果

### 人格与工具

- [ ] 问「你是谁」→ 回答里**没有** AI 味开场白（「作为一个 AI」「很高兴为你」）
- [ ] 让它「写今天日记」→ `state/diary/` 下出现当天文件，控制台日记本可见
- [ ] 让它「设个 5 分钟后的提醒」→ `state/reminders.json` 出现 active 项，到点收到消息
- [ ] 让它「发个表情」→ 收到的是一张表情图，不是文字描述
- [ ] 让它「把头像换成…」→ 只在 `<OWNER_QQ>` 私聊生效，群里被拒
- [ ] 公开群聊里让它「删掉记忆」→ 被拒（只能衰减，不能删）

### 成本与观测

- [ ] `state/token-usage.jsonl` 有 `k:'turn'` 行在增长
- [ ] 控制台「优化面板」能显示上下文水位（无采样时显示「无数据」而不是 0）
- [ ] `state/health.jsonl` 每 5 分钟一行
- [ ] `doctor` 的 `CORE_TESTS` 全绿

### 运维

- [ ] 杀 `<PORT_CONSOLE>` 进程 → 看门狗把它拉回
- [ ] 断网 30 秒再恢复 → 桥自动重连，期间群消息在恢复后补记（`catch-up`）
- [ ] `restart.bat` 跑完后**没有**黑框，`state/guard.log` 有新内容
- [ ] 03:10 备份产物存在且 `retention` 生效（daily=7 / weekly=4）

---

## 10. 回滚与风险

### 10.1 分层回滚（每层都能单独退，不用全拆）

| 想退掉 | 怎么做 |
|---|---|
| 某个新能力（语音/表情/主动联系/提醒/日记/去 AI 味） | 只关 `config.json` 里对应段（见附录 B 的开关项），**不用改代码** |
| 全部社交增强 | 控制台「暂停二代 AI」（`qq-mode` 回 `reserved`，一代接管） |
| 采样参数调整 | `config.sampling.enabled=false`，删 `DEEPSEEK_BASE_URL` 注入 |
| DSH 侧改动 | 删除 `cordis.patch.yml` 的 MCP 区块与 retryPolicy 段，回到裸 profile |
| 整个方案 | 用 `<UPSTREAM_BRIDGE>` 重建；SnowLuma 只删 `config/onebot_*.json` 即可回到原版行为 |

### 10.2 已知风险（都是踩过的）

1. **EULA**：SnowLuma EULA §5.4 禁止「通过自动化脚本部署」。本方案的编排只做**探测 + 登录 + 注入 hook**，不做安装/部署，`mcp-host-server` 也只留只读 `snowluma_status`。**不要**为了方便加「自动下载/自动安装 SnowLuma」——那是踩线。
2. **hook 注错号**：静默灾难级。`hookAutoLoad` 必须 `false`，注入必须按 `probe-login` 认出的 uin 逐个确认（6.4 第 4 步）。注错号的表现是「主号开始自动回复朋友」。
3. **每小时发送配额**：QQ 单号每小时有消息上限。打满后所有出站都失败，包括提醒。`rate-limit.mjs` 的排队是按这个场景设计的——**不要给它调高优先级或去掉退避**，配额恢复前硬发只会让整段被限流更久。
4. **成本**：单日输入可达 10^8 量级（缓存命中 99%+）。`cost-guard` 的阈值必须按 **token-usage 的实际分布**设，照抄别人的 40M 会天天报红。
5. **机密散落**：`SnowLuma/config/webui.json`、`config/onebot_*.json`、`<BRIDGE_DIR>/config.json`、`qqbot.local.json`、`android/console.keystore`、`state/console-token`、`state/minimax-key` 全是机密。本方案要求：只提交 `*.example`，真文件进 `.gitignore`，`npm run privacy-scan` 接进提交前检查。
6. **受限上下文**：`TEMP` 不可写、`spawn` 用 pipe 会 `EPERM`、`icacls /T` 配 `(OI)(CI)` 会失败。这是 `tempUsable`、`voice-core` 用临时文件收 ffprobe 输出、`state-acl` 四步法的由来。**不要**把它们改回「常规写法」，会在这类环境下静默坏掉。
7. **单片大文件**：`bridge.js` 15370 行、`console.html` 5380 行。这是有意的（单文件部署、无构建步骤），代价是改一次要重跑回归。落地时**不要**顺手拆包——拆了就得配构建，而构建会在受限上下文里引入新故障面。

---

## 附录 A：文件清单（相对上游）

### A.1 新增目录

```text
qq-bridge/persona-lib/{fewshot/{raw,inbox},style}/   # 人格素材：正例库 + 8 个场景风格稿
qq-bridge/eval/                                      # 盲评：RUBRIC + 30 条上下文 + A/B 采样 + 打分页
qq-bridge/android/                                   # APK 手工流水线
qq-bridge/public/mobile/                             # PWA：manifest + sw + 图标
qqbot/                                               # 编排 + 自启 + 看门狗
```

### A.2 新增根目录文件

`open-console.vbs`（双击开控制台）、`run-hidden.vbs`（无窗口启动）、`d4.ico`（图标）。

### A.3 `src/` 39 个新模块

`ai-tone.js`、`ai-tone-stats.js`、`auto-sticker.mjs`、`auto-voice.mjs`、`backup.mjs`、`catch-up.mjs`、`clean-state.mjs`、`conn-quality.mjs`、`context-budget.mjs`、`cost-guard.mjs`、`daily-brief.mjs`、`dashboard.js`、`diary.js`、`doctor.mjs`、`fewshot-lib.js`、`handoff.mjs`、`health.mjs`、`inline-media.js`、`length-gate.js`、`media-index.js`、`media-note.js`、`memory-decay.mjs`、`ops-panel.js`、`ops-wait-store.mjs`、`proactive-contact.js`、`profile-slice.mjs`、`profiles.js`、`rate-limit.mjs`、`reminder-nudge.js`、`reminders.js`、`sampling-proxy.js`、`scene-router.js`、`send-image-lib.js`、`sticker-index.js`、`turn-visibility.mjs`、`voice-tts.mjs`、`wake-history.mjs`、`weekly-report.mjs`、`zip.mjs`

### A.4 `src/` 7 个改动模块

`bridge.js`、`mcp-snowluma-safe.js`、`mcp-host-server.js`、`mcp-web-search-safe.js`、`role-card.js`、`sticker-lib.js`、`token-ledger.js`

### A.5 `scripts/` 新增 106 个（按族）

```text
部署/自检    setup-dsh, patch-snowluma-sdk, open-console, harden-state-acl, diagnose-acl, verify-dsh-020-adaptation, verify-persona-config, check-sampling-proxy
定时任务     backup, clean-state, daily-brief, weekly-report, doctor, health-probe（各带 .vbs）
探针         probe-events/tools/protocol/settings/heartbeat, scan-dsh-tool-names, privacy-scan
回归         test-*（108 个）+ console-ui-fixture + console-ui-contracts.json
评测         sticker-eval, sticker-search, send-voice
```

### A.6 `docs/` 新增 35 篇（上游 7 → 42）

注意：`docs/README.md` 的索引**已部分过时**，引用了不存在的文件（`PROJECT_GUIDE.md` 等）。落地时以磁盘实际文件为准，不要照抄索引。

### A.7 删除

`scripts/probe-events.mjs`（并入 `scripts/probe-*.mjs` 家族）。

---

## 附录 B：新增配置键全表（`config.json`）

`config.example.json` 相对上游新增 40 个深层路径（252→304 行），但它们**只覆盖 `snowluma.*` 与 `socialV2.{context,image,proactiveContact,profile,reminder,tools}` 这几段**；实际运行配置 `config.json` 有 387 个叶子键，其中 **171 个只在运行配置里**（功能开关面）。按域列出：

> ⚠️ **复刻时最容易漏的一步**：照抄 `config.example.json` 只能跑起来「默认篇」，`aiTone` / `lengthGate` / `voiceTts` / `backup` / `cleanState` / `dailyBrief` / `weeklyReport` / `costGuard` / `desk` / `manage` / `role` / `sampling` / `style.fewshot` / `contextBudget` **十几段都不在 example 里**。落地时把本附录当作第二份清单，或者先把 example 按本表补齐（这一步本身就该作为交付物的一部分，不要靠读代码猜）。

| 域 | 键 | 说明 |
|---|---|---|
| 去 AI 味 | `aiTone.{enabled,keepPhrases,extraPhrases,stripAgreeOpener,stripTrailingPeriod,logHits}`、`aiTone.fallbackPolicy.*`、`aiTone.stats.*` | 关掉就完全跳过 |
| 备份 | `backup.{enabled,at,sources,targets,exclude,retention.daily,retention.weekly}`、`backup.drill.*` | 目标 3 处可只留 1 处 |
| 磁盘卫生 | `cleanState.{enabled,stateDir,junkDays,cacheDays}` | |
| 上下文水位 | `contextBudget.{enabled,mode,softAt,hardAt,handoffTokenBudget}` | **默认 `enabled:false`** |
| 成本 | `costGuard.contextWatermarkMax` + `costGuard` 阈值段 | 阈值必须按本机分布校准 |
| 每日简报 | `dailyBrief.{enabled,at,key,to,windowHours,maxChars,maxLines}`、`dailyBrief.weather.*`、`dailyBrief.costGuard.*` | |
| 桌面 | `desk.{enabled,baseUrl,sessionId,blockHighRisk}` | `qq_desk_command` 的后端 |
| 拆条 | `lengthGate.*` | |
| 自我管理 | `manage.{enabled,avatar,profile,signature,deskCommand}` | `qq_set_*` 的总开关 |
| 工具分组 | `mcp.toolGroups` | 控制台按组显隐 |
| 人格 | `role.{logInject,maxScenes,overrideFile,wakeInject,wakeInjectMaxChars}` | |
| 采样 | `sampling.{enabled,port,upstream,temperature,topP,frequencyPenalty,presencePenalty,disableThinking,listen}` | `disableThinking` 必须 true（4.3 末） |
| 社交媒体 | `socialV2.context.wakeHistory.*`、`socialV2.image.{enabled,dirs,maxBytes}`、`socialV2.proactiveContact.*`、`socialV2.profile.*`、`socialV2.reminder.*`、`socialV2.reminder.nudge.*`、`socialV2.tools.{profile,reminder,sendImage}`、`socialV2.autoVoice.*`、`socialV2.diary.*`、`socialV2.sticker.*`、`socialV2.markRead.requireThroughSeq`、`socialV2.wake.staleReplyGuardMin` | 全部新能力都在这一段 |
| 风格 | `style.fewshot.*` | few-shot 注入 |
| 语音 | `voiceTts.{engine,exe,minimax.*,pauses.*,pitchShift.*,maxSeconds,minSeconds,timeoutMs}`、`voiceTts.moods.{calm,happy,shy,annoyed,sad}.{voice,speed,pitch,label,emotion}` | mood 五个，按需覆盖 |
| 周报 | `weeklyReport.*` | |
| SnowLuma 连接 | `snowluma.followDiscoveredEndpoint`、`snowluma.silenceWarnMs` | 前者连上了就跟随实际端点，后者是静默告警阈值 |

**示例配置里没有、只在运行配置里的键不要盲抄**：它们多数带本机阈值（如 `costGuard`），照抄会让告警失真。

---

## 附录 C：本方案**不**包含的东西

写清楚边界，避免误以为漏了：

1. **SnowLuma 自身的代码/二进制修改** —— 一处都没有，也不建议有。
2. **DSH 主体（`apps/web`、`packages/*`）改造** —— QQ 端所有 DSH 侧改动都通过 profile + 插件 + patch 完成。
3. **手机桥的配对/证书机制细节** —— 属手机桥项目自身，本方案只说明「QQ 控制台如何被它反代」。
4. **本机一次性排查残留** —— `state/` 里的截图、`asar-*.py`、`sampling-probe*.mjs`、`tmp-*.json`、`_boot.js` 等，都不属于方案，复刻时不要带。
5. **口令/令牌/QQ 号/机器路径** —— 全文只出现占位符；真实值一律不进仓库。
