# 运维六件套：备份 / 自检 / 磁盘卫生 / 周报 / 成本守门 / 健康时序

第一、二梯队（见 `项目计划/07-候选项目清单.md`）落地的常驻动作。共同约定：

- **脚本在 `scripts/`，逻辑在 `src/`**：`src/*.mjs` 是纯函数（单测覆盖、不碰磁盘），`scripts/*.mjs` 才做 I/O。
- **计划任务用 `wscript //B //Nologo xxx.vbs` 启动**：无黑框、转发真实退出码（`sh.Run(cmd, 0, True)`）。
- **node 解析顺序固定**（四个 vbs 一致）：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe` → `%PROGRAMFILES%\nodejs\node.exe` → `C:\Program Files\nodejs\node.exe` → `C:\Program Files (x86)\nodejs\node.exe` → `%USERPROFILE%\.dsh\dsh-runtimes\…\node.exe`（兜底）。
  - **为什么这个顺序**：`.dsh\dsh-runtimes` 那份 node 在本机被限制成「只能写 workspace」，写 `C:\.snapshots` / `E:\DSH-Backup` / OneDrive 一律 `EPERM`；两份 node 的 SHA256 完全相同（`BA4E6D11…`，v24.21.0），所以是**路径级**限制，不是二进制差异。
- **状态都写 `state/` 下的 JSON + 追加式 `.log`**（日志 >512 KB 转 `.1`，vbs 的 out/err 日志 >1 MB 直接删）。

| 脚本 | 计划任务 | 时间 | 状态文件 | 退出码 |
|---|---|---|---|---|
| `scripts/backup.mjs` | `DSH Daily Backup` | 每天 03:10 | `state/backup.json`、`state/backup-drill.log` | 0 成功 / 2 有目标失败或演练失败 |
| `scripts/doctor.mjs` | `DSH Doctor` | 每天 07:50 | `state/doctor-report.json`（含最近 10 次 history） | 0 全绿 / 1 有红项 / 2 异常 |
| `scripts/clean-state.mjs` | `DSH Clean State` | 每周日 07:40（`--apply`） | `state/clean-state.json` | 0 / 1 |
| `scripts/weekly-report.mjs` | `DSH Weekly Report` | 每周日 20:00 | `state/weekly-report.json` | 0 成功或跳过 / 2 发送失败 |
| `scripts/health-probe.mjs` | `DSH Health Probe` | 每 5 分钟 | `state/health.jsonl`（43 B/行，超 2 MB 轮转 `.1`） | 0 正常 / 2 探测或写盘失败 |
| `memory-index/nightly.py` | `DSH Nightly Memory` | 每天 04:00 | `memory-index/data/summaries.jsonl`、`data/nightly.log` | 0 成功（含跳过）/ 2 失败 |

---

## 一、备份（`scripts/backup.mjs` + `src/backup.mjs` + `src/zip.mjs`）

```powershell
node scripts\backup.mjs              # 真跑：打包 + 写三处 + 按保留策略清理
node scripts\backup.mjs --dry        # 只统计，不写盘
node scripts\backup.mjs --drill      # 恢复演练：解压最新包，逐条比 CRC、抽 40 个文件比内容
node scripts\backup.mjs --list       # 列已有快照
node scripts\backup.mjs --targets C:\.snapshots --no-prune
```

- **范围**（`config.backup.sources`）：`qq-bridge/{src,scripts,config.json,public,docs}`、`~/.dsh/profiles/desktop/cordis.patch.yml`、`~/.dsh/profiles/qqbridge/cordis.patch.yml`、`memory-index/*.py`、`项目计划/`。实测 **237 个文件 / 3.5 MB → zip 1.5 MB**。
- **三处落盘**：`C:\.snapshots`（快）、`E:\DSH-Backup`、`%USERPROFILE%\OneDrive\DSH-Backup`。任一目标失败不影响其他目标，整体退出码 2。
- **保留**：日备 7 份、周备 4 份（`planPrune`；`keepAtLeastOne` 把 0/负数当笔误）。
- **不含**：`state/`、`work/`（贴纸/语音人工工作区，见 `work/README.md`）、`node_modules`、`*.log`、`*.zip`。
- **坑**：
  - `tar.exe -a -cf` 能打中文路径的 zip，但**不置 UTF-8 标志位（bit 11）**，`Expand-Archive` 解出来是乱码；`Compress-Archive` 还有 32k 命令行上限。所以自己写了零依赖 `src/zip.mjs`（`zipCreate`/`zipRead`，UTF-8 flag + CRC 校验）。
  - 写盘先写 `.part` 再 `rename`，半截 zip 不会冒充完整快照。
  - `makeIncluder` 的裸名是**前缀匹配**（`cordis.patch.yml` 只认顶层），否则 `.backup-2026…/` 这类隐藏副本会被一起打包。

## 二、自检（`scripts/doctor.mjs` + `src/doctor.mjs`）

```powershell
node scripts\doctor.mjs              # 11 项检查 + 一页报告 + 写 state/doctor-report.json
node scripts\doctor.mjs --json       # 机器可读
node scripts\doctor.mjs --no-tests   # 不跑单测（只想看服务/配置）
node scripts\doctor.mjs --all-tests  # 额外扫全仓 77 个 test-*.mjs（只报数，历史红不算红）
node scripts\doctor.mjs --strict     # 把历史红升格为红
```

11 项：`单测 / QQ桥 / bot / 手机桥 / 校园网 / 配置 / 备份 / 健康 / 记忆 / QQ链路 / 任务`。

- **单测只跑核心集**（`CORE_TESTS`，当前 17 个离线绿：backup、daily-brief、doctor、clean-state、weekly-report、auto-voice、auto-sticker、voice-minimax、stickers、preset-local-tools、hardening、send-image、media-index、inline-media、reminder-nudge、cost-guard、health）。全仓 77 个测试里有 20 个是历史红（要活的 SnowLuma、引已删模块），全算进去会让自检永远红、没人看。
- **健康项**：`state/health.jsonl` 最后一行距今 ≤ 20 分钟算绿（探针每 5 分钟一拍，漏 4 拍才算挂）。
- **QQ链路项**：读桥接自己的 `/api/status`，要求 `snowluma.connected === true` 且最近 120 秒内有上游事件（心跳 30 秒一次）。**为什么不能只看 3100 在听**：2026-10-24 15:01 的静默事故里进程活着、端口在听、`get_status` 还报账号在线，但 WS 没连上，收发全废一小时，而当时 10 项全绿。
- **记忆项**：`memory-index/data/nightly.log` 的 mtime 距今 ≤ 36 小时算绿（漏一整次夜跑就是红）；detail 顺带报 `summaries.jsonl` 的条数与最近覆盖到哪天。
- **口径和简报相反**：简报里「没探到」记 unknown 不算红（怕烦），自检里 unknown 就是红（怕骗）。
- **`consoleToken` 回落**：`config.json` 里那项是空的，真令牌在 `state/console-token`，`resolveConsoleToken()` 会回落。
- 历史红项只进 JSON 明细，不进 check 结论。

## 三、磁盘卫生（`scripts/clean-state.mjs` + `src/clean-state.mjs`）

```powershell
node scripts\clean-state.mjs --dry      # 默认：只出清单
node scripts\clean-state.mjs --apply    # 真删
node scripts\clean-state.mjs --apply --verbose
node scripts\clean-state.mjs --json
```

三档（策略在 `config.cleanState`）：

| 档 | 举例 | 期限 |
|---|---|---|
| 🔒 必需 | `state/*.json`、`state/*.jsonl`、`state/console-token`、`state/minimax-key`、`state/diary/**` | **永不删**（另有 `NEVER` 名单兜底） |
| ♻️ 可再生成 | `state/tmp/**`、`audio/*.{wav,mp3,ogg}` | 7 天 |
| 🗑 垃圾 | `state/*.png`、`state/*.log.[0-9]*`、`state/*.jsonl.[0-9]*`、`state/pw-tmp/**`、`state/tmp-sampling-check/**` | 3 天 |

- 删除前逐条 `path.resolve` + `startsWith(STATE_DIR)` 越界检查，再按现行规则二次判定（TOCTOU 兜底）；删完收空目录。
- 贴纸/语音的**原始素材不删**：`work/sticker-work`、`work/tts-research` 已在 2026-10-24 搬出 `state/`（307 MB + 20 MB），`src`/`scripts` 零引用，删了不可恢复。
- 实测：`--apply` 后 `state` 从 5.6 MB → 5.0 MB / 112 文件（清掉 10 个一次性截图与 `pw-tmp/cv_debug.log` / `mark-read.json`）。

## 四、周报（`scripts/weekly-report.mjs` + `src/weekly-report.mjs`）

```powershell
node scripts\weekly-report.mjs             # 真发（同一 ISO 周第二次会 skip）
node scripts\weekly-report.mjs --dry       # 只打印
node scripts\weekly-report.mjs --dry --json # 看统计明细（轮次/token/自检红项/清单 diff）
node scripts\weekly-report.mjs --send-test # 只发一条联调短句，不占本周额度
node scripts\weekly-report.mjs --force     # 忽略 lastSentWeek 再发
```

- 数据源全是**别的任务写好的流水**，周报自己不探测服务、不跑测试：`state/token-usage.jsonl`（每轮 token）、`state/tool-calls.jsonl`（消息/语音/表情/失败数）、`state/doctor-report.json` 的 history（服务抖过几次）、`state/backup.json`、`项目计划/*.md` 的 `- [x]` / `- [ ]`。
- 「本周收尾」= 相对上一条 `state/weekly-report.json` 里的 `checkedKeys` **新增**的已勾项；第一次跑没有基线，显示「清单首次建立基线」。
- 「下周待办」摘 `- [ ]` 未勾项（当前 6 条都在 `02b-MiniMax语音引擎方案.md` 的验收标准里）。模板里 `**`、反引号、链接会被剥掉再截断，QQ 里不显示 Markdown 噪音。
- 幂等键是 ISO 周（`2026-W43`），不是日期 —— 周日 20:00 跑一次，之后同周手滑再跑不会重复发。
- **不要 import `scripts/daily-brief.mjs`**：那个脚本没有 export、`main()` 在文件末尾直接执行，import 会把简报也发一遍。周报自带 30 行发送逻辑（同一套 OneBot 直发 + 3 次 5s 退避）。

## 五、成本守门（`src/cost-guard.mjs`，挂在简报里）

```powershell
node scripts\daily-brief.mjs --dry --verbose   # 看 cost 明细（ok / reds / cacheRate / input / top）
```

- 数据源：`state/token-usage.jsonl`（只认 `k:"turn"` 行；`k:"base"` 是累计基线，相加会重复计费）。
- 口径：`input = cacheHit + cacheMiss`、`cacheRate = cacheHit / input`、窗口 = `dailyBrief.windowHours`（24h）。
- 阈值（`config.costGuard`）：`cacheRateMin 0.95`、`dailyInputMax 100000001`、`topShareMin 0.5`、`enabled`。
  - **为什么不是清单里写的 40 M**：本机实测单日输入 6.4 M–137.5 M，40 M 会天天红、告警等于噪音；150 M 才对应「真跑飞了」。代码里 40 M 仍是默认值，只是配置覆盖了它。
- 简报固定一行（红时前缀变 ❌，越界段写成 `缓存 90.0%<95%` / `输入 320.2M>150.0M`）：
  `💰 成本：缓存 99.3% · 输入 24.1M · 输出 24.9k · 大头 私聊 f3ade17a 53%`
- 「大头」= 窗口内 input 最多的会话，占比 ≥ `topShareMin` 才点名；label 取自 key 前缀（`private:`→私聊、`group:`→群聊、`internal:`→内部），tag 是 session id 前 8 位。
- 这行是**替换**原来的 `🔤 token：…` 行而不是新增，所以 `maxLines=9` 的预算没破（`tokenLine()` 只在没有 cost 结果时兜底）。

## 六、健康时序（`scripts/health-probe.mjs` + `src/health.mjs` + `health-probe.vbs`）

```powershell
node scripts\health-probe.mjs --dry --verbose   # 只探不写
node scripts\health-probe.mjs --force --json    # 绕过 90 秒去抖并打印这一行
```

- 每 5 分钟一行、43 B：`{"t":1792824937902,"q":1,"b":1,"p":1,"c":1}`（`q` QQ桥 3100 / `b` bot 3000 / `p` 手机桥 8899 / `c` 校园网）。探不到写 `-1`（unknown），**不写 0** —— 否则「网络抖了探不到」会被记成「服务挂了」。
- **`q` 不再只等于「3100 在听」**：端口通时会再问一次 `/api/status`，`linkState()` 判定 WS 未连上/120 秒没事件/`good=false` 就把 `q` 记 0（并写 `health-probe.log` 的 `link down:` 原因）。读不到状态（令牌缺失/接口报错）时保持 TCP 结论，不伪造 down。
- 一天 288 行约 12 KB；超 2 MB 轮转 `health.jsonl.1`（只留一代）。90 秒内重复调用直接 skip。
- 统计口径（`summarizeHealth`）：`unknown` 不进分母；`flaps` 只数 up→down 下降沿；窗口末尾仍 down 则 `openNow=true`、区间截止最后一个 down 采样。
- 消费方：简报在 ✅/❌ 服务行尾拼 `（24h 抖动 1 次）`；周报加 `📈 可用率：QQ桥 62.5% · bot 100% …（抖动 1 次）`（在 ✅ 收尾之前，不会被 `maxLines` 截掉）；手动看区间用 `formatDownWindows` → `QQ桥 14:58 起 约 4 分钟`。
- 真实验收（2026-10-24）：14:58 `taskkill /T /F` 杀桥 → 采样 `q:0` → 15:00:57 重起、50 秒后 3100 在听 → 15:02 探到 `q:1`，区间闭合、`flaps=1`。

## 七、夜间记忆整理（`memory-index/nightly.py` + `nightly.vbs`）

每天 04:00 把「昨天」每个会话压成一条 200–400 字摘要入库（`role=summary`）。实现细节见 `memory-index/README.md`，运维只关心三件事：

```powershell
Get-Content ..\memory-index\data\nightly.log -Tail 5   # 最近一次跑了什么
node scripts\doctor.mjs --no-tests                     # 「✓ 记忆」是不是绿的
```

- 幂等键 `(session_id, day)` 记在 `data/summaries.jsonl`，重跑只 skip 不重复入库。
- 模型失败退回抽取式摘要（记录数 + 前 3 条用户问题 + 最后结论），**保证每天都有摘要**、不留空洞。
- `nightly.vbs` 必须纯 ASCII（wscript 按 ANSI 读文件，中文注释会让它解析失败，报 `缺少 'Next'`）。

---

## 排障速查

| 现象 | 先看 | 常见原因 |
|---|---|---|
| 任务 `LastTaskResult=2` 且日志三条 `EPERM` | `state/backup.out.log` | vbs 里的 node 顺序被改回 `.dsh\dsh-runtimes` 那份（只能写 workspace） |
| 任务 `0xC000013A` / 跑到一半没了 | `Export-ScheduledTask` 看 `StopOnIdleEnd` | 必须是 `false`；四个任务的 settings 都复用 `DSH Daily Backup` 的 |
| 自检红「配置 voiceTts.enabled=false」 | `config.json` | 确实是关掉了，或刚改完配置没恢复 |
| 简报没有 `💾` / `🩺` 行 | `state/backup.json` / `state/doctor-report.json` | 文件不存在 = 那个任务还没跑过；简报会整行省略而不是报错 |
| 简报没有 `🗑 已清理` 行 | 今天是不是周日 | 清理行**只在周日**出现（`when.getDay() === 0`） |
| 周报 `skip: already sent` | `state/weekly-report.json` 的 `lastSentWeek` | 同一 ISO 周已发过；要重发加 `--force` |
| `Expand-Archive` 解出来乱码 | 备份是不是用 `src/zip.mjs` 打的 | `tar.exe -a` 打的包没有 UTF-8 标志位，只能 `tar -xf` 解 |
| 简报没有 `💰` 行 | `config.costGuard.enabled`、`state/token-usage.jsonl` | 被关掉了，或窗口内没有 `k:"turn"` 行（无数据时整行省略，不报错） |
| 自检红「健康 超过 20 分钟没采样」 | `state/health-probe.err.log`、任务 `DSH Health Probe` | 任务被禁用，或 vbs 里的 node 路径失效 |
| 自检红「还没跑过夜间整理」 | `memory-index/data/nightly.err.log` | `DSH Nightly Memory` 从没跑过，或 `.venv-mem\Scripts\python.exe` 不在了 |
| 自检红「QQ链路 WS 未连接 / 上游已 Ns 没有事件」 | `Get-Content state\guard.log -Tail 30` | token 自愈没触发（只报 error 不报 close）→ 现由 `bot.on('error')` 的 3 秒兜底 + 15 秒看守重连；仍红就重启桥（见下条命令） |
| QQ 一小时内只发自检没收到任何消息 | `state\qq-activity.log` 最后一行时间 | 活动日志不动 = WS 没连上；`node scripts\health-probe.mjs --dry --verbose` 看 `link:` 字段 |
| 自检红「手机桥 8899 无响应」 | `bridge\logs\watchdog.log` | 看门狗每 5 分钟修一次，等一拍再跑自检；连续红看 `bridge\logs\bridge.log` 尾部 |
| 要手动重启 QQ 桥且不留黑框 | `run-hidden.vbs` **必须带参数** | `wscript //B //Nologo qq-bridge\run-hidden.vbs start.bat`；漏掉 `start.bat` 会因 `WScript.Arguments.Count = 0` 静默退出 2，看起来像"启动没反应" |
| `nightly.vbs` 报 `缺少 'Next'` | 文件编码 | 被存成含中文的 UTF-8 了；vbs 必须是纯 ASCII |
