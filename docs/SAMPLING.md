# 采样参数（temperature / top_p / penalty）

DSH 里没有调这些参数的入口，所以 QQ 端 agent 的采样参数是通过一个本地反向代理注入的。

## 为什么需要代理

读 DSH 源码确认过：

- `@deepseek-ai/dsh-llm` 的 `GenerateOptions` 只有 `temperature` / `maxTokens` / `stop`；
- `dsh-llm-deepseek` 的 provider 配置（`deepSeekConfigFields`）里**没有** `temperature`；
- agent loop 从来不传 `temperature`；
- provider 的 baseURL 解析顺序是：显式配置 → 环境变量 `DEEPSEEK_BASE_URL` → `https://api.deepseek.com/anthropic`。

所以唯一不改 DSH 本体、又能改参数的办法，就是把 `DEEPSEEK_BASE_URL` 指到本地代理，由代理在请求体里补字段。

另一个实测结论（2026-10-22）：

- **thinking 开启时 DeepSeek 会忽略 temperature**（temperature=0 连跑三次仍是三条不同回复）；
- 关掉 thinking 后 temperature=0 才会稳定复现。

因此要让采样参数真正生效，必须同时把 thinking 关掉（`disableThinking`）。

## 结构

```
QQ 消息 → bridge → DSH(19388) → HTTP → 采样代理(8790) → api.deepseek.com/anthropic
```

- `src/sampling-proxy.js`：`http.createServer` 反向代理，流式（SSE）原样透传；
  按文件 mtime 读 `config.json` 的 `sampling` 段，改配置不用重启进程。
- `qqbot/qqbot.mjs`：
  - `samplingConfig()` 读 `qq-bridge/config.json`；
  - `childEnv()` 在 `sampling.enabled` 时把 `DEEPSEEK_BASE_URL` 设成 `http://127.0.0.1:<port>`；
  - `ensureSamplingProxy()` 在起 DSH 之前拉起代理（日志 `qqbot/logs/sampling-proxy.log`）；
  - `down()` 杀 8790；`status()` 显示代理状态。
- 只有 qqbridge profile 的 DSH 带这个环境变量；用户自己的 DSH Web（63712）不受影响。

## 配置

`qq-bridge/config.json`：

```json
"sampling": {
  "enabled": true,
  "listen": "127.0.0.1",
  "port": 8790,
  "upstream": "https://api.deepseek.com/anthropic",
  "disableThinking": true,
  "temperature": 1.15,
  "topP": 0.95,
  "presencePenalty": 0.4,
  "frequencyPenalty": 0.2
}
```

| 字段 | 含义 | 建议 |
| --- | --- | --- |
| `temperature` | 随机性。1.0 = 官方默认；越高越飘 | 1.0~1.3；超过 1.4 容易语无伦次 |
| `topP` | 核采样。与 temperature 二选一调，别同时大改 | 0.9~0.98 |
| `presencePenalty` | 惩罚已出现过的词，防止复读、防止反复用同一句式 | 0.3~0.6 |
| `frequencyPenalty` | 按出现次数惩罚，压重复短语 | 0~0.3，太高会开始胡说 |
| `disableThinking` | 关思考。**开 temperature 时必须为 true**，否则温度被忽略 | true |

改完 `config.json` 即时生效（代理每次请求前比对 mtime）；
改了 `enabled`、`port` 或 `upstream` 之后要重启栈：`node qqbot.mjs down && node qqbot.mjs up`。

## 验证

```powershell
# 代理自报参数
curl http://127.0.0.1:8790/healthz

# 端到端：建一个临时 DSH 会话发一句「只回好」，看代理日志有没有 200
cd qq-bridge
node scripts/check-sampling-proxy.mjs
```

成功的日志长这样（参数确实注入了）：

```
POST /v1/messages → 200 691ms [T=1.15 top_p=0.95 presence=0.4 frequency=0.2 thinking=off]
```

## 回滚

- 只想停参数、保持 DSH 直连：`"sampling": { "enabled": false }` → `node qqbot.mjs down && node qqbot.mjs up`。
- 代理进程挂了但配置还开着：DSH 连不上上游，QQ 会完全没反应。`node qqbot.mjs status` 会显示「采样代理 未运行（DSH 会连不上上游！）」。

## 代价

- 多一个单点：8790 挂了 QQ 就不回话（status 里能看出来）。
- `disableThinking: true` 之后，`config.json` 里的 `dsh.reasoningEffort: high` 不再起作用，回答的推理深度会下降。如果觉得变笨了，先把 `disableThinking` 关掉（代价是 temperature 失效）。
