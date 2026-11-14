# 每日简报（Daily Brief）

每天早上 08:00 给主人 QQ 发一条纯文本简报：天气 / 服务红绿灯 / 今日提醒 / 近 24h 动静 / token 用量。
整个功能**跑在 bridge 之外**（独立 node 进程 + 计划任务），bridge 挂了它照发。

```
早，10/24 13:47
🌤 天气：洛阳 阴 · 10.3~17.6°C · 现在 17.1°C · 降水 24%
✅ 服务：全部正常
📅 提醒：今天没有
💬 近 24h：消息 36 条 · 语音 0 · 表情 10 · 失败 15
🔤 token：输入 22.6M（缓存 99.4%） · 输出 21.5k
```

## 文件

| 路径 | 作用 |
| --- | --- |
| `scripts/daily-brief.mjs` | 入口：探测 + 取数（含天气）+ 幂等 + 发送 + 记日志（所有 I/O 都在这里） |
| `src/daily-brief.mjs` | 纯函数：`normalizeDailyBriefConfig` / `serviceState` / `formatWeather` / `renderBrief` / `sanitizeBriefText` |
| `scripts/test-daily-brief.mjs` | 16 项断言，`PASS：16 项通过，0 项失败` 才算通过 |
| `scripts/daily-brief.vbs` | 计划任务的启动器：隐藏窗口起 node，转发退出码 |
| `state/daily-brief.json` | 幂等记录：`lastSentDate` / `lastSentAt` / `prevRed` / `lastSendError` |
| `state/weather-place.json` | 位置缓存（30 天）：只在 `weather` 没配坐标时用，记 IP 定位结果 |
| `state/daily-brief.log` | 脚本自己的审计日志（sent / skip / send attempt failed / dry / weather fail） |
| `state/daily-brief.out.log` | node 的 stdout（sent 行、skip 行） |
| `state/daily-brief.err.log` | node 的 stderr（schtasks 的 GBK 噪音，低完整性下才会出现） |

三者都在 1 MB 时自动轮转（删掉重来），不会无限长。

## 配置（`config.json` 的 `dailyBrief` 段）

```json
"dailyBrief": {
  "enabled": true,
  "at": "08:00",
  "key": "private:100000001",
  "windowHours": 24,
  "maxChars": 560,
  "maxLines": 9,
  "weather": { "enabled": true, "label": "洛阳", "latitude": 34.61994, "longitude": 112.46699 },
  "costGuard": { "enabled": true, "cacheRateMin": 0.95, "dailyInputMax": 100000001, "topShareMin": 0.5 }
}
```

- `enabled`：`false` / `0` / `no` / `off` 都算关；关了就是 `skip: disabled` + exit 0。
- `at`：只影响计划任务的触发时间（改完记得同步改任务触发器），正则 `^([01]\d|2[0-3]):([0-5]\d)$`，写坏回落 `08:00`。
- `key`：发送目标，只认 `private:<uin>`；写坏则回落到 `ownerQQ`。
- `windowHours`：1–168；`maxChars`：120–2000；`maxLines`：2–10（默认 7：问候/天气/服务/提醒/活动/token/恢复）。**坏值一律回落默认，不报错**。
- `weather.enabled`：同上认 `false/0/no/off`；关了就不取天气、也不出现天气行。
- `weather.label`：行首地名，最多 12 字（默认空 = 用定位到的城市名）。
- `weather.latitude` / `longitude`：**两个都给且合法**（|lat|≤90、|lon|≤180）才生效；任何一个坏掉就当没配。
  不配坐标时依次退：`state/weather-place.json` 缓存（30 天）→ IP 定位（ip-api → ipapi.co 兜底）。
- 所有失败都降级：配置读不到 / 写坏 / 缺字段，照样出简报。

### 天气为什么写死坐标

IP 定位按公网出口推，本机实测被推成「河南 郑州 管城」（`34.7657,113.753`），离洛阳洛龙区约 100 km，
温度和降水概率都会跟着偏。所以 `config.json` 里固定写「洛阳洛龙」的坐标：

```
洛龙 / 河南 / 洛阳市 → lat=34.61994, lon=112.46699（Open-Meteo geocoding，name=洛龙）
```

注意 geocoding 搜 `name=洛阳` 会先命中福建泉州、江苏常州等 5 个同名地，**必须用「洛龙」**才拿到河南这个。

## 计划任务

```
名称：DSH Daily Brief
动作：C:\Windows\System32\wscript.exe //B //Nologo "<repo>\scripts\daily-brief.vbs"
触发：每天 08:00（Daily）
主体：当前用户 / Interactive / Limited（与 DSH QQ Bot Start 同规格）
设置：StartWhenAvailable、允许电池、ExecutionTimeLimit PT10M、MultipleInstances IgnoreNew
```

手工重注册（PowerShell）：

```powershell
$b = "<repo>\qq-bridge"
$action   = New-ScheduledTaskAction -Execute 'C:\Windows\System32\wscript.exe' `
            -Argument "//B //Nologo `"$b\scripts\daily-brief.vbs`"" -WorkingDirectory "$b\scripts"
$trigger  = New-ScheduledTaskTrigger -Daily -At '08:00'
$principal= New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'DSH Daily Brief' -Action $action -Trigger $trigger `
            -Principal $principal -Settings $settings -Force
```

`StartWhenAvailable` = 关机/睡眠错过 08:00 后，开机补跑（补跑时表头写**真实发送时间**，不会谎称 08:00）。

## 命令

```powershell
# 只想看看现在会发什么（不会被"今天已发过"挡住）
node scripts\daily-brief.mjs --dry

# 忽略幂等，立刻再发一条（调试用，会真的发到 QQ）
node scripts\daily-brief.mjs --force --verbose

# 指定探测端口 / 展示时间
node scripts\daily-brief.mjs --dry --port 3999 --at 08:00

# 跑单测
node scripts\test-daily-brief.mjs
```

退出码：`0` 发出或按规则跳过，`2` 发送失败（3 次重试后，`state/daily-brief.json` 有 `lastSendError`），`3` VBS 找不到脚本。
计划任务的 `LastTaskResult` 直接反映这个退出码。

## 设计要点（踩过的坑）

1. **红绿灯只看 `alive`，不看 `task.ok`。** DSH 拉起的 node 是 Low 完整性（`S-1-16-4096`），`schtasks` 查询校园网守护必然报「系统找不到指定的路径」→ `task.ok=false`；从计划任务/wscript 跑又是 `true`。以 `task.ok` 判定会天天误报。
2. **`services.qqbridge.alive` 在 dashboard 里是硬编码 `true`**（因为它本来跑在 bridge 进程内）。独立进程必须自己 `probeTcp(3100)` 覆盖，否则永远说不出「QQ桥 挂了」。
3. **token 只累 `k === "turn"` 行。** `token-usage.jsonl` 里的 `base` 行是「整条会话的累计投影基线」（见 `src/token-ledger.js` 的 `ingestBaseline`），把它加进 24h 求和会重复计费。
4. **只读文件尾部 2 MB。** 24h 的量远小于这个数，不随日志增长变慢。
5. **语音没有工具名可数**（`tool-calls.jsonl` 里没有 voice/tts 工具），只能回落到快照的 `qq.voices`。
6. **发送不依赖 bridge**：直连 OneBot HTTP（`config.snowluma.httpUrl`，走 `send_private_msg`）；对 3100 只做一次探测，探不到就标红继续发。
7. **状态写失败不炸**：`writeJson` 包了 try/catch —— 沙箱/只读介质下丢幂等记录，也比把已发出的简报变 crash 好。
8. **天气只取一次、失败只少一行。** Open-Meteo 免密钥（无 key 可轮换、无额度举报），8 s 超时；`fetchJson` 或解析任何一步失败 → `appendLog('weather fail: ... @ api.open-meteo.com')` 并返回 `null`，简报照发。
9. **天气行最后才砍。** 超长裁剪顺序 `token 行 → 恢复行 → 天气行 → 硬截断`：token 是给人看的统计，天气是当天要用的信息。
10. **天气行的每段都可缺。** 没有今日最低/最高就只写「现在 x°C」；一个数都没有就整行不出现（不发「天气：洛阳」这种废话）。WMO 未知码同样整段省略，不写「未知(1234)」。

11. **成本行是替换、不是新增。** `renderBrief` 有 cost 结果就用 `renderCostBriefLine(cost)`，否则回落 `tokenLine(usage)`；所以 `maxLines=9` 的预算没变，旧单测里 `token：输入 …` 的断言也没破。
12. **抖动后缀只在有采样时出现。** `servicesLine(snapshot, health)` 里 health 为 null 就什么都不拼 —— 新机器第一次跑、`health.jsonl` 还没生成时，简报不该写「0 次抖动」冒充有数据。

## 验收记录（2026-10-24）

- 单测 16/16；`--dry` 真实数据 6 行（含天气）。
- token 三项与 `GET /api/tokens/series?hours=24` 完全一致（cacheHit 22355840 / cacheMiss 126693 / output 21196），鉴权头是 `x-console-token`（不是 Bearer）。
- 计划任务真发：`LastTaskResult=0`，`sent retcode=0 message_id=-100000001`，`get_msg` 回查正文一致。
- 故障注入 `--port 3999`：仍发出，正文首行变 `❌ 服务：QQ桥 挂了（3999 无响应）`。
- 失败路径：onebot 指死端口 → 3 次重试 10.5 s、exit 2、`lastSendError: exception: fetch failed ECONNREFUSED @ 127.0.0.1:3099`。
- 幂等：同日第二次 `skip: already sent` exit 0；`enabled:false` → `skip: disabled` exit 0。
- 天气（同日 13:47）：`🌤 天气：洛阳 阴 · 10.3~17.6°C · 现在 17.1°C · 降水 24%`，与 Open-Meteo 原始 payload 逐字段一致
  （`current.temperature_2m=17.1`、`weather_code=3`、`daily.min=10.3`、`max=17.6`、`precip=24`、`timezone=Asia/Shanghai`、`elevation=142`）。
- 天气降级：坐标缺失 → 自动 IP 定位（日志 `weather place: 管城 (...) via ip-api` + 写 `state/weather-place.json`）；
  天气接口指死端口 → `weather fail: fetch failed @ api.open-meteo.com`，正文少一行仍 5 行、exit 0；
  定位与天气同时挂 → `weather fail: no place (ip lookup failed)`，仍出简报、exit 0。

## 排障

| 现象 | 查 |
| --- | --- |
| 早上没收到 | `Get-ScheduledTaskInfo -TaskName 'DSH Daily Brief'` 看 `LastTaskResult`；再看 `state/daily-brief.log` 末尾 |
| 收到但内容不对 | `node scripts\daily-brief.mjs --dry` 立刻复现当前正文 |
| `LastTaskResult=2` | `state/daily-brief.json` 的 `lastSendError`；一般是 OneBot（3000）没起，或 `accessToken` 变了 |
| 想改时间 | 改 `dailyBrief.at` **和**任务触发器，两处都要 |
| 一天想发两次 | `--force`，或删 `state/daily-brief.json` |
| 天气行没了 / 地名不对 | `state/daily-brief.log` 里搜 `weather fail` / `weather place`；地名不对就是坐标没配（退回了 IP 定位），改 `weather.label` + `latitude/longitude` 后删 `state/weather-place.json` |
| 成本行没了 / 一直是旧的 `token：` 行 | `config.dailyBrief.costGuard.enabled`；`--dry --verbose` 看 `cost` 是否为 null（null = 窗口内没有 `k:"turn"` 行） |
| 服务行后面没有「抖动 N 次」 | `state/health.jsonl` 是否存在且覆盖到窗口内；生成方是 `DSH Health Probe`（每 5 分钟） |
