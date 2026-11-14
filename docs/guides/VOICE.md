# QQ 语音功能与优化方案

本文是语音功能的运行说明和后续优化计划。语音发送有两条入口：

- 独立工具：仓库上一级 `../voice-tool/`，包含 `voice-cli.mjs` 和 `voice-gui.mjs`；图形界面可通过上一级的 `发语音-图形界面.cmd` 打开。
- 桥接入口：`qq-bridge` 控制台、CLI 端点，以及 reserved2 的 `qq_send_voice` / `qq_list_voices` 工具。

## 当前链路

共享规则集中在 `src/voice-core.js` 和 `src/voice-tts.mjs`，独立工具与桥接共用这两份实现。发送前会检查文件存在性、扩展名、大小、时长和语音库路径；AI 通道还会检查会话 token、模式、白名单、静默状态、频率额度和发送后回读结果。

AI 发语音默认是关的（即关闭）：`socialV2.voice.enabled=false` 且 `socialV2.tools.sendVoice=false`。开启前先把音频放进 `socialV2.voice.dir`（默认 `audio/`），再在控制台打开对应开关。操作者通道可以在 AI 开关关闭时手动试发。

文本合成由 `voiceTts.engine` 选择 Edge TTS 或 MiniMax。情绪档位为 `calm`、`happy`、`shy`、`annoyed`、`sad`；MiniMax 支持停顿、情绪和降调后处理，Edge TTS 使用 rate/pitch 参数。合成结果会落到临时目录，发送完成后应清理临时文件。

## 已知边界

1. 当前主要优化发送链路，收到 QQ 语音仍以占位信息进入上下文，尚未形成稳定的语音转写链路。
2. 合成服务的限流、网络超时和 ffmpeg/ffprobe 缺失需要在启动检查中提前暴露，不能等到模型调用后才发现。
3. QQ 侧会再次转码，源文件的高频和过度降调不会原样保留；音质判断必须以 QQ 回读文件为准。
4. 独立工具的配置优先级应保持为：环境变量 → `voice-tool/config.json` → `qq-bridge/config.json` → 默认值。

## 优化路线

### A. 先建立可比较的基线

每次合成和发送记录以下聚合字段：引擎、音色、情绪、文本字数、合成耗时、发送耗时、总时长、文件大小、重试次数、错误码、回读是否确认。不要记录 API key 或完整语音文本。

验收至少覆盖：合成成功率、首成功延迟 p50/p95、QQ 回读确认率、2–60 秒时长命中率、每条语音平均字节数、1002/RPM 限流率。

### B. 可靠性

1. MiniMax 的 1002/RPM/网络错误使用有限次数重试，并采用指数退避和随机抖动；鉴权失败、参数错误不重试。
2. 合成请求带幂等键，重试不会重复写入语音库或重复发送。
3. 临时文件统一走“写临时文件 → 校验 → 重命名 → 发送后清理”；清理失败写入告警，不影响下一条语音。
4. 桥接启动时检查 ffmpeg、ffprobe、Edge TTS 可执行文件和 MiniMax key 文件，并在控制台显示可用性。
5. 语音库建立稳定索引，列表接口只返回相对路径、时长、大小、音频格式和可选备注，禁止把本机绝对路径交给模型。

### C. 真人感与音质

1. 普通闲聊优先 1–15 字一条；超过长度按标点切分，避免把一句话切成残句。
2. 先用停顿和轻微语速变化改善念稿感，再调 pitch；MiniMax 的降调后处理限制在小范围，避免电子感和音色漂移。
3. 每个情绪只保留一套默认音色和参数，其他参数通过 A/B 样本确认后再进入配置。
4. 对最终 QQ 回读音频做响度、时长、编码和采样率检查；源文件通过不等于 QQ 端体验通过。
5. 自动语音继续使用场景白名单、每日上限和冷却时间；不因“模型觉得适合”就绕过这些限制。

### D. 交互与观测

1. 控制台显示语音库可用性、最近一次合成、最近一次发送、回读结果和失败原因。
2. `voice-cli.mjs status` 增加 SnowLuma HTTP、token 来源、ffmpeg/ffprobe 和 TTS 引擎检查。
3. `qq_send_voice` 返回明确的 `filePath` 脱敏结果、duration、bytes、mood、attempts 和 warnings，失败时区分“未合成”“未发送”“回读未确认”。
4. 后续再做接收语音转写：先在操作者私聊灰度，验证准确率和隐私边界后再考虑群聊。

## 建议的验收顺序

```text
1. 语音库扫描与 ffprobe 预检
2. Edge / MiniMax 各情绪合成
3. 2–60 秒时长夹逼与超长文本切分
4. 发送白名单、静默、频控和重复调用
5. QQ 回读确认与临时文件清理
6. 断网、401、1002、ffmpeg 缺失、重启恢复
```

相关回归入口：`scripts/test-voice.mjs`、`scripts/test-voice-system.mjs`、`scripts/test-voice-volume.mjs`、`scripts/test-voice-edge.mjs`、`scripts/test-voice-tts.mjs`。独立工具不在本仓库时，相关检查应明确显示“跳过”，不能把缺少上级目录误报成桥接代码失败。
