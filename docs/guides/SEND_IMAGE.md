# 发送普通图片（`qq_send_image`）

> 状态：✅ 2026-10-19 落地并端到端验证（QQ 桌面命令 #14）。
> 相关代码：`src/send-image-lib.js`（取图与安全校验）、`src/bridge.js`（两条通道）、`src/mcp-snowluma-safe.js`（AI 工具）。
> 自测：`node scripts/test-send-image.mjs`（39 项，离线，不需要 SnowLuma/QQ/网络）。

## 一句话

机器人现在可以发**普通图片**（截图、梗图、下载的图、本地生成的图），而不再只有文字和收藏表情包；
图片来源支持 **http(s) 直链** 与 **受限本地目录**，发送目标照旧走白名单和频率限制。

## 为什么不是「随便传个文件过去」

发送的实现是 OneBot `send_private_msg` / `send_group_msg` 里的 `image` 段（`base64://`）。
**取图这一步必须由桥自己做**：如果让网关去抓 URL 或读本地路径，等于把 SSRF 防护和目录白名单一起作废
——一句 `http://127.0.0.1:3000/api/...` 或 `%USERPROFILE%\.ssh\id_rsa` 就能把内网接口和私钥当成"图片"发出去。
所以 `sendImageV2` 只接受已经过 `prepareImage` 校验的 Buffer，**不接受任何字符串来源**。

## 配置（`config.json` 的 `socialV2.image`）

```json
"socialV2": {
  "tools": { "sendImage": true },
  "image": {
    "enabled": true,
    "dirs": ["C:\\example\\qq-outbox"],
    "maxBytes": 4194304
  }
}
```

| 键 | 说明 |
| --- | --- |
| `tools.sendImage` | 是否把 `qq_send_image` 暴露给 AI（默认 `true`） |
| `image.enabled` | 总开关；`false` 时两条通道都拒绝 |
| `image.dirs` | **允许发图的本地目录白名单**（绝对路径）。留空 = 完全不允许发本地文件，只允许直链 |
| `image.maxBytes` | 单张体积上限，缺省 4 MB（与 `MAX_MEDIA_BYTES` 一致：再大 base64 后单条 JSON 太重） |

放图目录建议就用 `C:\example\qq-outbox`（本机已建），要发别的目录必须显式加进 `dirs`。
改完 `config.json` 需要重启桥接（`node qqbot.mjs down && node qqbot.mjs up`）。

## 通道一：AI 工具 `qq_send_image`

参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `key` | ✅ | `group:群号` 或 `private:QQ号` |
| `token` | ✅ | 会话令牌（唤醒提示里的【会话令牌】） |
| `url` | 二选一 | http/https 图片直链 |
| `path` | 二选一 | 允许目录内的本机图片绝对路径 |
| `note` | | 只写进本地记忆（记录发过什么），**不会随图片发出去** |
| `replyToMessageId` | | 引用某条消息（非零整数，可为负） |
| `atUserId` | | 群聊 @ 某人（私聊传了会直接报错） |

返回形如：`已发送一张图片（本地文件，png 1616KB）；已回读确认消息里确实有图片段`。

## 通道二：操作者 HTTP 接口（控制台 / CLI）

```bash
TOKEN=$(cat state/console-token)
# 本地文件
curl -X POST http://127.0.0.1:3100/api/image/send \
  -H "x-console-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"target":"private:100000001","path":"C:\\example\\qq-outbox\\test-fox.png"}'
# 直链
curl -X POST http://127.0.0.1:3100/api/image/send \
  -H "x-console-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"target":"private:100000001","url":"https://picsum.photos/id/237/400/300"}'
# 只看校验结果不真发
curl -X POST http://127.0.0.1:3100/api/image/send \
  -H "x-console-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"target":"private:100000001","path":"C:\\example\\qq-outbox\\test-fox.png","dryRun":true}'
```

- `target` 与 AI 工具的 `key` 同格式；别名 `/api/send/image`。
- 操作者通道**不套会话/模式闸门**（操作者可能不在任何 QQ 会话里），但白名单、限流、取图校验一样不少。
- 带 `x-agent-token` 打这个接口会被 403 拒绝（防止 AI 借操作者通道绕过"只能发自己会话"）。
- `dryRun: true` 只跑校验并返回格式/体积，不真发。

## 拒绝矩阵（已逐条实测）

| 输入 | 结果 |
| --- | --- |
| `..\..\Windows\win.ini` | 拒绝（realpath 后不在白名单） |
| 白名单外的绝对路径（如 `C:\Windows\win.ini`） | 拒绝 |
| junction/符号链接跳出白名单 | 拒绝（比较永远在 realpath 上做） |
| UNC / `\\?\` / `\\.\` 设备路径 | 拒绝 |
| 路径含 NUL 等控制字符 | 拒绝 |
| `.txt` 等非图片扩展名 | 拒绝 |
| 文本改名为 `.png` | 拒绝（魔数校验） |
| 空文件 / 超过 `maxBytes` | 拒绝 |
| `http://127.0.0.1`、`localhost`、`10.x`、`172.16.x`、`192.168.x`、`169.254.169.254`、`[::1]` | 拒绝（禁止内网/本机/云元数据） |
| `file://`、`ftp://` | 拒绝（只允许 http/https） |
| URL 带 `user:pass@` | 拒绝 |
| 图片 + 文字同一条 | 拒绝（400，要求分两条气泡发） |
| 白名单外的群/私聊 | 拒绝（403，并列出当前白名单） |
| 无 console token 打操作者接口 | 401 |
| 带 agent token 打操作者接口 | 403 |

频率限制：AI 通道复用 `socialV2.send` 的 `maxSendPerMinute` / `maxSendPerHour`（与文字、表情共用一个 `sendTimes` 桶）；
操作者通道同样读这两个值，但桶是按 `cli` 单独统计。

## 已知限制

- **一条消息只能是图片**，不能带文字。想说的话先单独发一条文字，再单独发图。
- 图片走后端 `base64://`，单张实际可用上限约 4 MB（再大会被拒）。
- 不读任意文件；不放白名单目录、就不发本地图。
- `edit_image` 那种"上传图 + 返回图"的双向能力不在本功能范围内。
- 回读校验只确认消息里**有** image 段，不校验图像内容。

## 自测

```bash
node scripts/test-send-image.mjs        # 39 项：魔数/白名单/穿越/UNC/SSRF/体积/组合规则
```

另可用操作者接口的 `dryRun` 做真实环境冒烟：

```bash
curl ... -d '{"target":"private:100000001","path":"C:\\example\\qq-outbox\\test-fox.png","dryRun":true}'
# → {"ok":true,"source":"path","image":{"format":"png","bytes":1654725},...}
```
