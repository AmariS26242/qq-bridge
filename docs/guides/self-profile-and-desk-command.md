# 机器人自助改资料 + 给桌面端投递命令

这份文档对应两组新能力（2026-10-18 加）：

1. **QQ 端的机器人能改自己的头像 / 昵称 / 签名**，不用人跑脚本。
2. **QQ 端的机器人能把一条命令投递给桌面 DSH 会话**，投递前自动过一遍确定性审核。

两组能力都只对「管理员私聊」开放，非管理员调用一律 403。

---

## 1. 自助改资料

### MCP 工具（QQ 端 agent 直接调）

| 工具 | 参数 | 说明 |
|---|---|---|
| `qq_set_avatar` | `file?` `messageId?` `key?` | 头像。`file` 支持本机绝对路径、`http(s)://` URL、`base64://...`（建议正方形 ≥ 640px）；或给 `messageId`（需同时给 `key`）直接取那条 QQ 消息里的原图，桥接取字节转 base64 再交给 OneBot，>3MB 会被拒绝 |
| `qq_set_profile` | `nickname?` `personal_note?` | 改昵称/个性签名资料；两者至少给一个。`nickname` ≤ 36 字，`personal_note` ≤ 200 字 |
| `qq_set_signature` | `text` | 改签名；传空字符串即清空。≤ 300 字 |

`messageId` 这条路的用处：群友/主人在 QQ 里发一张图说“换这个”，agent 手上只有 messageId（拿不到本机路径），用它就能直接设头像。

⚠️ 这三个工具属于 `admin` 工具组，**必须在 `config.json` 的 `mcp.toolGroups` 里显式写 `"admin"`**，否则注册期就被静默裁掉（`tools/list` 里根本没有，模型只会说“我没有这个工具”）。

三个工具都做两件事：把图片/文本规整成 OneBot 能吃的输入，然后 `POST /api/socialV2/manage`（`action=avatar|profile|signature`）。

### 桥接端点

```
POST http://127.0.0.1:3100/api/socialV2/manage
header: x-console-token: <state/console-token>   # 控制台/CLI 调用
        x-agent-token:   <该会话 agentToken>      # QQ 端调用时额外带
body:   { action, key, file?/nickname?/personal_note?/text? }
```

鉴权矩阵：

| 调用方 | 结果 |
|---|---|
| 控制台/CLI（仅 `x-console-token`） | 允许，`via: "operator"` |
| 管理员私聊（`x-agent-token` + 匹配的 `key`） | 允许，`via: "agent"` |
| token 伪造 | 403 `agent token 无效` |
| 真 token 但 `key` 指向别人的会话 | 403 |
| 非管理员私聊带自己的 token | 403 `只有管理员私聊（<ownerQQ>）可以改机器人资料` |

`action=whoami` 可探活并回显 `{ key, owner, mode, via }`，不产生副作用。

### CLI（人工/排障用）

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File whale-qq-compose\set-qq-avatar.ps1 -Action get_login_info
powershell.exe -NoProfile -ExecutionPolicy Bypass -File whale-qq-compose\set-qq-avatar.ps1 -Path <图片> -Size 1024 -Quality 92
```

> 必须用 `-ExecutionPolicy Bypass -File`，直接 `powershell -Command "<多行脚本>"` 会被 Windows 吃掉引号，脚本静默不执行。

---

## 2. 给桌面端投递命令

### 用法

QQ 端 agent 调 `qq_desk_command`：

| 参数 | 说明 |
|---|---|
| `command` | 要桌面端执行的自然语言命令 |
| `reason` | 为什么发（会写进投递消息和队列） |
| `sessionId` | 可选，指定桌面会话；默认按 `desk.sessionId` → 会话标题/cwd 匹配 → 最近活跃 |
| `deliver` | 默认 `true`。`false` 时只入队+审核，不投递 |

CLI：

```powershell
node scripts\desk-command.mjs send --command "看看 C:\example\output 今天生成了几张图" --reason "手工测试"
node scripts\desk-command.mjs list
node scripts\desk-command.mjs show --id 5
node scripts\desk-command.mjs retry --id 5
node scripts\desk-command.mjs audit --command "Remove-Item -Recurse -Force D:\tmp"
node scripts\desk-command.mjs endpoint            # 当前桌面端点与会话
node scripts\desk-command.mjs endpoint --refresh  # 重新扫描
```

### 审核：确定性规则引擎（无模型、可复现）

`scripts/audit-desk-command.mjs` 导出 `auditCommand(text)` → `{ verdict, score, hits[], readonly, advice, summary }`。
纯正则匹配，同一输入永远同一结论（不联网、不调模型，审核本身不可能被提示注入带偏）。

| 档 | 触发 | 处置 |
|---|---|---|
| `high` | 风险分 ≥ 85 | **先找用户确认**，不自动执行 |
| `review` | 风险分 ≥ 40 | 可执行，但需在回执里说明风险点 |
| `low` | 其余 | 直接执行 |

主要规则（分值叠加）：

| id | 分值 | 匹配 |
|---|---|---|
| `self-kill` | 95 | `Stop-Process` / `taskkill` / `sc stop` / `shutdown` |
| `dsh-home` | 90 | 触碰 `.dsh` / `profiles` / `sessions` / `credentials` / `cordis` / `state` |
| `remote-exec` | 88 | 下载后直接执行（`iex`、`curl ... \| sh` 等） |
| `secret-read` | 85 | 读凭据/密钥文件 |
| `system-path` | 75 | `C:\Windows`、`Program Files`、注册表写入等 |
| `rm-rf` | 70 | `Remove-Item -Recurse -Force`、`rm -rf`、`format` |
| `autostart` | 60 | 计划任务、启动项、服务注册 |
| `pkg-install` | 55 | 装包/改全局依赖 |
| `net-egress` | 45 | 对外上传/回传 |
| `firewall` | 40 | 防火墙/网络配置改动 |
| `qq-send` | 30 | 会触发对外发消息 |
| `gpu-model` | 20 | 占显存的重活（会和本地 ComfyUI 抢卡） |
| `write-workspace` | 15 | 在工作区内写文件 |

实测：`Remove-Item -Recurse -Force %USERPROFILE%\.dsh\profiles\qqbridge` → `high / 175`；`看看 C:\example\output 里今天生成了几张图` → `low / 0`。

### 队列与投递

- 队列文件：`state/desk-commands.json`（`nextId` + `items`，保留最近 300 条）。
- 状态机：`queued` → `delivered` / `failed`；**投递失败留在队列里**，可用 `retry` 重投，不丢。
- 投递走桌面 DSH 的 JSON-RPC：

```jsonc
POST <deskBaseUrl>/api
{"type":"client-request","rpcId":1,"method":"session/prompt",
 "payload":{"args":{"request":{"sessionId":"...","mode":"queue",
 "content":[{"type":"text","text":"..."}],"requestId":"..."}}}}
```

> 信封细节是踩坑换来的：`payload` 顶层只能有一个 `args` 字段，且 `session/prompt` 的参数必须包在 `request`（不是 `_request`）里，否则分别报 `Remote payload must contain exactly one plain-object args field` 和 `gateway/arguments-invalid ... missing "_request"`。

### 端点自动发现

`desk.baseUrl` 留空时自动发现：

1. `netstat -ano` 扫本机处于 LISTENING 的回环端口（跳过 `cfg.dsh.baseUrl` 自己的端口）；
2. 对每个端口发一次 DSH 握手（`session/list`，超时 1.2s），能通的就是 DSH；
3. 结果缓存进 `state/desk-endpoint.json`，`--refresh` 强制重扫。

> 为什么不按进程名找：从 DSH 的沙箱容器里看不到宿主进程（`Get-Process -Id <桌面PID>` 直接「找不到进程」，`Win32_Process.CommandLine` 也是空的），但 `netstat` 和 `Get-NetTCPConnection` 仍能看到全部监听端口。所以只认端口+握手，不认进程。

### 会话选择

优先级：`desk.sessionId` 钉死的 > 标题/cwd 匹配的 > 最近活跃的根会话（会话标题写进投递消息前缀，便于事后对账）。

---

## 3. 配置项（`qq-bridge\config.json`）

```jsonc
{
  "ownerQQ": 100000001,          // 管理员，只有它的私聊能动资料/发命令
  "manage": {
    "enabled": true,
    "avatar": true,               // 三个资料工具的分开关
    "profile": true,
    "signature": true,
    "deskCommand": true           // qq_desk_command 开关
  },
  "desk": {
    "enabled": true,
    "baseUrl": "",                // 留空 = 自动发现；也可钉死 http://127.0.0.1:63096
    "sessionId": "",              // 留空 = 自动选会话
    "blockHighRisk": false        // true = high 风险直接拒收，连队都不入
  }
}
```

工具注册期即按开关裁剪：开关关掉的工具**不会出现在工具表里**（省 token，也避免模型去调一个注定被拒的工具）。

---

## 4. 安全边界（明确写下来）

- 资料修改与命令投递**都只认管理员私聊**；群聊、陌生人私聊即使拿到工具也调不动。
- 审核是规则引擎，不是模型——不会被「忽略之前的指令」这类话术绕过。
- `high` 风险默认不自动执行，先回头问人。
- 命令投递的是**自然语言**，最终执行者在桌面会话里；桌面端仍然按自己的权限与确认流程走。
- 凭据不进日志：`x-agent-token`、consoleToken 只在内存与 `state/` 下，日志只记来源（agent/operator）与改动字段。

---

## 5. 排错

| 现象 | 原因 / 处理 |
|---|---|
| 403 `agent token 无效` | ① token 过期（重启桥接后旧 token 失效）② 请求没带 `key`——桥接无法判断「你要动谁」，按无效处理 |
| 403 `只有管理员私聊…` | 调用方不是 `ownerQQ`，属预期拒绝 |
| `未授权：当前模式（xxx）下改机器人资料必须带 key 和 token` | 非封闭 agent 模式下必须显式带凭据 |
| 投递 `failed` | 看 `show --id N` 的 `error`；常见是桌面 DSH 换了端口（`endpoint --refresh`）或该会话已归档 |
| 审核结论与预期不符 | 跑 `audit --command "..."` 看 `hits[]`，每条命中都有 id/分值/说明，改规则在 `scripts/audit-desk-command.mjs` |

自测（不碰真账号，只校验规则表与工具表）：

```powershell
node scripts\test-audit-desk-command.mjs
node scripts\test-mcp-manage.mjs
```
