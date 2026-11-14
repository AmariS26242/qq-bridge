# 语音生成与优化措施（TTS 全解）

> 整理时间：2026-10-26。目标：把「机器人怎么把一句话变成 QQ 语音条」和「怎么让它更好听」两件事讲清，并且**只写本机实测过的结论**。
> 配置以 `qq-bridge/config.json` 的 `voiceTts` 段为准；实测数字来自 `work/tts-research/`（研究报告与 samples/metrics.json）。
> 相关文档：`项目计划/02-QQ语音情绪化.md`（立项与阶段）、`项目计划/02b-MiniMax语音引擎方案.md`（引擎接入与验收）、`work/tts-research/合成语音更自然更柔和-研究报告.md` §9（本机实测全部过程与数据）。

---

## 0. 一页结论

**链路**：模型决定「说这一句」→ 调 `send_tts_voice(text, mood)` → 归一化/拆条/插气口 → MiniMax `speech-2.8-hd` 合成 mp3（失败可回退 edge-tts）→ 2–60 s 夹逼 → 暂存 `audio/.tts/` → `/api/socialV2/send-voice` 校验时长/体积/频控 → SnowLuma 转 SILK → QQ 语音条 → 回读 `verified` → 删中间文件。

**三个真正有效的主战场**（按性价比排序）：

1. **文本层**：一句话 1–10 字、不写句号、留语气词、把长句拆成两条短句。
2. **音色层**：换 `voice_id` 是唯一能「一次性定型柔和」的动作；当前定档 `female-tianmei-jingpin`（频谱最暗、几乎无齿音）。
3. **引擎参数层**：`emotion`（表达力最大，F0 差约 100 Hz）+ `pauses` 气口（时长第一杠杆，关掉停顿标记时长从 3.6 s 掉到 2.26 s）+ `speed`（0.88–1.12 内微调）。

**五个不要做**（都试过，无效或有害）：

| 不做 | 原因（实测） |
|---|---|
| 调 `voice_setting.pitch` | 在 `speech-2.8-hd` + 本机音色上**无效**：pitch 0 与 −4 的 F0 中位没有单调关系，逐次差异（±1.8 半音）大于参数差异 |
| 在 4 kHz 以上做后处理 | QQ 转码把 6 kHz 以上基本丢光：6–8 kHz 掉 1/4、8–12 kHz 掉一半以上；de-ess、空气感 EQ 全白做 |
| 靠堆语速「活泼」 | 语速上限 1.12，超过就出电子感；现网曾长期跑 1.08–1.10 贴上限，是「像播报」的首要嫌疑 |
| 用单条样音判优劣 | 同参数连跑四次，F0 中位在 274–304 Hz 摆动、时长 3.02–4.01 s；任何对比每档 ≥3 条再盲听 |
| 自己写 SILK/AMR 转码 | SnowLuma 自动转；落盘 `.amr` 内容其实是 SILK_V3，24 kHz 单声道，约 19.5–19.9 kbps |

**当前定档**：`female-tianmei-jingpin` + 五档 mood（speed 0.94/1.00/0.90/1.02/0.88，emotion neutral/happy/neutral/angry/sad）+ 气口 `comma 300 ms / stop 400 ms` + 后处理降调**关闭**（`pitchShift.enabled=false`）。

---

## 1. 链路：从一句话到一条语音条

| # | 环节 | 实现位置 | 失败时 |
|---|---|---|---|
| 1 | AI 决定发语音 | `src/mcp-snowluma-safe.js:1486` `send_tts_voice`（`text` 必填、`mood` 默认 calm） | 模型自己选时机；描述里要求「一天几条足够」 |
| 2 | 总闸门 | `voiceTtsConfig()` 读 `voiceTts.enabled`，**每次调用重读**（改完免重启） | 返回 error「语音合成未启用」，要求改用文字 |
| 3 | 文本归一化 | `normalizeSpeechText()` `src/voice-tts.mjs:568`：去控制字符、压空白、超 400 字在标点处截断 | 空文本 → error |
| 4 | 拆条 | `splitForTts(text, 15, 2)` `src/voice-tts.mjs:657`：单条 ≤15 字、最多 2 条，优先在标点断开 | 需要 >2 条时不截断，返回 error 让模型压短或改文字 |
| 5 | 气口 | `applyVoicePauses()` `src/voice-tts.mjs:613`：在逗号/句号后插 `<#0.30#>` 类标记，单条最多 3 个 | `pauses.enabled=false` 时原样返回 |
| 6 | mood 归一化 | `normalizeMinimaxMood()` `src/voice-tts.mjs:97`：speed 夹 0.88–1.12、pitch 夹 ±12、emotion 落五档之一 | 音色 id 与引擎不匹配时自动回落默认音色，避免把 `qiaopi_mengmei` 递给 edge-tts |
| 7 | 合成 | `synthMinimax()` `src/voice-tts.mjs:758` → `POST {baseUrl}/v1/t2a_v2` | 见 §2.9（重试、key 失效、超时、断网） |
| 8 | 后处理（可选） | `pitchShiftWav()` `src/voice-tts.mjs:352`（重采样降调 + 保共振峰） | 现网关闭 |
| 9 | 时长夹逼 | `synthesize()` 内部循环 `src/voice-tts.mjs:884-925`：<2 s 先降速、到下限再垫「，嗯」；>60 s 截断文本重合成 | 垫完仍 <2 s → error「文字太短，补停顿也没救」 |
| 10 | 暂存 | `stageIntoLibrary()` `src/voice-tts.mjs:966` → `audio/.tts/<hash>.mp3`（隐藏目录，不进 `qq_list_voices`） | — |
| 11 | 发送 | `POST http://127.0.0.1:3100/api/socialV2/send-voice`（带 key + agent token） | 返回 error，工具要求改用文字；不假装已发 |
| 12 | 发送层校验 | `voice-core.js` `probeAudio()`：`maxSeconds 300`、`maxBytes 20 MB`；`bridge.js:1944` 频控 | 超限直接拒绝并给中文原因 |
| 13 | 转码成语音条 | SnowLuma `encodeSilk` → QQ | — |
| 14 | 回读 | `get_msg` 看 `record` 段，`verified=true` 才算发出 | `verified=false` 时工具如实说没落地 |
| 15 | 清理 | `finally` 删暂存文件 | 每次成功/失败后 `state/tmp/voice/` 与 `audio/.tts/` 都应为空 |

**两道独立开关**：`socialV2.voice.enabled` 与 `socialV2.tools.sendVoice`（桥接 `/api/socialV2/send-voice` 的硬门槛，改完**要重启桥接**）；`voiceTts.enabled`（TTS 自己的闸门，**免重启**）。

---

## 2. 生成语音的措施（把链路跑通、不出事）

### 2.1 两种触发方式

| 方式 | 谁决定 | 约束 |
|---|---|---|
| **显式工具** | 模型自己判断「这句话值得用声音说」 | `mood` 五档；一天几条即可；合成失败必须改文字 |
| **自动触发** | 规则引擎 `src/auto-voice.mjs` 的 `decideAutoVoice` | 只在**场景白名单**命中时发：happy（生日快乐/恭喜/太好了/好开心/成功啦）、shy（想你/喜欢你/么么/抱抱）、annoyed（哼/讨厌/不理你）、sad（再见/拜拜/舍不得/保重）、calm（晚安/好梦/早安/起床啦） |

自动触发的额度与冷却（`config.json` 的 `socialV2.autoVoice`，当前值与代码默认值一致）：

- `maxPerDay: 30`：一天最多 30 条自动语音，超了**自动降级文字**，但**手动调用不受限**（`state/voice-usage.json` 分别记 `auto` 与 `manual`）；
- `cooldownMinutes: 20`：两次自动语音至少隔 20 分钟；
- `minChars: 2` / `maxChars: 20`：太短不念、太长不念；
- **不随机**：早期方案里的「3% 随机」没采用，只走白名单——随机发语音最容易被嫌吵；
- 语音成功后联动表情：`socialV2.autoVoice.sticker`（`minScore 6`、最近 10 张不重复、`limit 8`），失败全吞不影响语音。

### 2.2 文案规则（写进工具描述，也是调用期真规则）

1. **1–10 字最自然**，超过 15 字必然被拆；
2. **不写句号**，语气词（嗯、啊、啦、嘛）可以留——它们是「气声感」的载体；
3. **别塞** URL、代码、列表、颜文字：念出来没人听得懂；
4. 长句优先按标点断成两小句（「这个语速差不多了吧，」「再快就要赶人了」），而不是一口气念完。

### 2.3 拆条（`splitForTts`）

- 单条上限 **15 字**、一次最多 **2 条**（`DEFAULT_MAX_CHARS_PER_VOICE=15`、`DEFAULT_MAX_CHUNKS=2`）；
- 有标点优先在标点处断，没有标点按 15 字硬切；
- 需要第 3 条时**报错不截断**：`这段话 N 字，拆成语音条要 M 条（一次最多 2 条）`——截断的语音比没发更糟；
- **拆条吃频控额度**：一次调用发 2 条，恰好等于 `maxPerMinute: 2`，所以拆条后 1 分钟内不要再发第三条。

实测：17 字句拆成 2 条（messageId `100000001` / `-100000001`，2.088 s / 2.328 s，均 verified）；26 字句 4 ms 内报错，不截断。

### 2.4 文本归一化与气口

- `normalizeSpeechText`：去控制字符、`\r\n` 归一、压连续空白；超 `maxChars: 400` 时只在 `。！？\n` 处截断（切点须 > 240 字，否则硬截 400）；
- 气口标记是 MiniMax 的**真停顿** `<#x#>`，不是 SSML：实测逗号后 0.8 s → 音频时长 **+1.15 s**，`<#2.0#>` → **+2.18 s**；
- 三条硬约束：结尾标点后不插（后面没字，标记被忽略）、两个标记之间必须有字（连续标记会被丢）、单条最多 `maxTags: 3` 个；
- 权限范围：`commaMs`/`stopMs` 夹到 0–3000 ms，`maxTags` 夹到 0–10，写错值不会让语音碎成一字一顿。

### 2.5 mood → 合成参数（当前生效）

| mood | label | voice | speed | emotion | 使用场景 |
|---|---|---|---|---|---|
| calm | 平静 | female-tianmei-jingpin | 0.94 | neutral | 默认、日常 |
| happy | 开心 | female-tianmei-jingpin | 1.00 | happy | 被夸、好消息 |
| shy | 害羞 | female-tianmei-jingpin | 0.90 | neutral | 被撩、撒娇 |
| annoyed | 嫌弃 | female-tianmei-jingpin | 1.02 | angry | 吐槽、假装生气 |
| sad | 难过 | female-tianmei-jingpin | 0.88 | sad | 失落、告别 |

设计约束（听感逼出来的，别临时改）：

- **五档必须同一音色**——「同一个人」是人设底层，不能为单档情绪换声音；
- **pitch 一律 0**：QQ 落 SILK 窄带会把抬高的音高放大成一耳朵的尖（pitch +2 就被吐槽过）；
- `emotion` 只给真正需要的档：happy=happy、annoyed=angry、sad=sad、calm/shy=neutral。`speech-2.8-hd` 自带情绪推理，不传反而更自然；但**嫌弃档传 angry 是例外**——实测 F0 357 Hz、1–4k 3.4%，比不传更「有态度」。

### 2.6 合成请求（MiniMax）

```jsonc
// POST {baseUrl}/v1/t2a_v2   Authorization: Bearer <state/minimax-key>
{
  "model": "speech-2.8-hd",
  "text": "嗯，我在呢<#0.30#>你慢慢说",
  "voice_setting": { "voice_id": "female-tianmei-jingpin", "speed": 0.94, "pitch": 0, "vol": 1, "emotion": "neutral" },
  "audio_setting": { "sample_rate": 24000, "bitrate": 128000, "format": "mp3", "channel": 1 }
}
```

- `sampleRate 24000` 是横评出来的：16k/24k/32k 三条真发，用户判 **24k 最顺耳**（三份 mp3 帧头实测与请求一致，码率均 128 kbps）；
- 超时：单次请求 `minimax.timeoutMs: 30000`，整条合成 `voiceTts.timeoutMs: 90000`（含重试与夹逼循环）；
- 重试：`MINIMAX_RETRY_ATTEMPTS=3`，只对 `1002` 与 `rate limit|rpm|tpm|too many` 退避重试（`sleep(1000*attempt)`），其他错误立刻抛；
- key 放 `state/minimax-key`（文件，不写进 config）；401 会附加「API Key 无效」提示；
- 返回 hex **优先**、兼容 base64；空音频抛「MiniMax 返回空音频（检查文本长度/字符）」。

### 2.7 时长夹逼（2–60 s）

- `minSeconds: 2`：太短的语音条在 QQ 里像误触。补偿顺序——**先降速**（到 0.88 下限）→ 还不够就**垫「，嗯」**再合成 → 仍不够才报错；
- `maxSeconds: 60`：超长**截文本不截音频**——按 `keep = 原长 × 60 × 0.92 / 实际秒数` 的比例砍字重合成，最多 3 次（`src/voice-tts.mjs:916-928`），仍超才报错；
- 时长靠自研 MP3 帧头解析（`mp3Duration()` `src/voice-tts.mjs:237`，兼容 MPEG1/2/2.5 与 ID3v2），不依赖 ffprobe；
- 夹逼会改写 `speed` 与 `spokenText`，返回体里 `attempts`/`warnings` 会如实记录，排查「听起来变拖」先看这里。

### 2.8 存储与发送

- 合成产物先落 `state/tmp/voice/`，再 `stageIntoLibrary()` 复制到 `audio/.tts/`（点目录：`listAudioFiles` 跳过它，不污染 `qq_list_voices`）；
- 发送层校验：`probeAudio()` 解析编码/时长/体积，超 `maxSeconds 300` 或 `maxBytes 20 MB` 拒绝；
- 频控：`maxPerMinute 2`、`maxPerHour 10`（`bridge.js:1944`），按「单人闲聊」定的；密集试音临时放宽后必须改回；
- 回读：`verified=true` 表示 `get_msg` 回读到 `record` 段；只有它为真才能对用户说「我发了语音」；
- 清理：`finally` 里删库内那份，`state/tmp/voice` 与 `audio/.tts` 每次结束都应为空（P1 验收④）。

### 2.9 失败与降级

| 失败 | 表现 | 处理 |
|---|---|---|
| 未配置 key | 「未配置 MiniMax API Key」 | 工具层统一附「请改用文字把这句话说出来」 |
| key 无效 | `MiniMax 合成失败 1004: login fail（API Key 无效）` | 同上，不重试 |
| 网络/超时 | 「MiniMax 请求失败（网络或超时）」 | 重试 3 次后抛；可切 `engine: "edge"` |
| 限流 1002 | 退避重试 1 s/2 s | 3 次后失败 |
| 文本太短 | 「合成只有 x 秒，达不到最短 2 秒」 | 让模型加语气词，或改文字 |
| 拆不下 | 「要 3 条（一次最多 2 条）」 | 压到 15 字内 / 分两次调用 |
| mood 拼错 | 回落 `calm`，`warnings` 记「未知情绪「x」，已回落 calm」 | 用五档之一；不会静默变形 |

**铁律**：任何失败都回落成文字，**不假装发过语音、不重复硬试**。

---

## 3. 优化语音的措施（让它好听）

### 3.0 措施总表

| 层 | 措施 | 实测效果 | 现状 |
|---|---|---|---|
| L1 文本 | 短句、语气词、标点断句 | 「缓」的观感主要来自这里；改一句话的成本最低 | ✅ 在用（工具描述 + 拆条） |
| L2 参数 | `pauses` 气口 | 关掉停顿标记时长 3.6→2.256 s，是第一杠杆 | ✅ 在用 300/400 |
| L2 参数 | `speed` | 1.08→0.94 只差 0.14 s，但观感「播报感」明显下降 | ✅ 在用（贴上限是病根） |
| L2 参数 | `emotion` | 同音色 F0 差约 100 Hz、时长差 0.9 s，**最有效的表达力旋钮** | ✅ 在用（happy/angry/sad） |
| L2 参数 | `pitch` | 0 与 −4 无单调关系 → 无效 | ❌ 一律 0，不再试 |
| L3 音色 | 换 `voice_id` | 频谱性格差异远大于任何参数（滚降 586–4234 Hz） | ✅ 定档 `female-tianmei-jingpin` |
| L3 音色 | `voice_modify` | `pitch:-30` → −2.8 半音、相似度 0.931、4–6k 2.11→0.76 | ⏸ 实测可用，**未接线**（代码里没有 `voice_modify`） |
| L3 音色 | Voice Clone | 唯一能「一次定型、零后处理」的路 | ⏸ 需要一段好样本，未做 |
| L3 音色 | 换本地开源引擎 | 0.5B 可跑（RTX 5060 Laptop 8 GB），但 QQ 只保 ≤6 kHz，收益被链路吃掉 | ⏸ 后备 |
| L4 后处理 | 重采样降调 + 保共振峰 | 纯重采样包络相似度 0.720 → 保共振峰 0.967 相关；但仍有电子感 | ❌ 已关闭（换音色更直接） |
| 链路 | 认清 QQ 丢高频 | 6–8k 掉 1/4、8–12k 掉一半以上 | ✅ 决定了「别在 4 kHz 以上花力气」 |
| 音量 | loudnorm 响度归一 | 通道存在但 `normalize` 默认 false → 一直「原始音量」 | ⚠️ 未启用 |

### 3.1 L1 文本层（最便宜、收益最大）

- **一句一口气**：1–10 字最自然；超过 15 字拆两条，长句会明显「念稿」。
- **语气词是气声的载体**：嗯、啊、啦、嘛、呢——1–4 kHz 的送气噪声正好能穿过 QQ 转码（见 §3.5）。
- **标点不是装饰**：逗号/顿号/句号会被插成真停顿；不写句号反而更口语。
- **别让模型写书面语**：`建议您`、`此外`、`综上` 这类词念出来最假；工具描述里已明确禁止 URL/代码/列表/颜文字。

### 3.2 L2 参数层（speed / emotion / pauses）

**语速**：`clampSpeed` 上限 1.12，注释写明「超过就出电子感」。历史教训：calm 1.08、happy/annoyed 1.10 长期贴着上限，是「像播报」的首要嫌疑；现网已整体下移到 0.88–1.02。

**气口**：`pauses` 是时长与节奏的第一杠杆——同一句话只关掉停顿标记，时长从 3.600 s 掉到 2.256 s（−1.35 s），远大于 speed 1.08→0.94 的 0.14 s。想「缓」先加停顿，再慢语速。

**情绪**：同音色五种 emotion 实测（文本「嗯，我在呢，你慢慢说」，pauses 300/400，pitchShift 关闭）：

| 档 | emotion | 时长 s | F0 中位 Hz | F0 跨度 半音 | 95% 滚降 Hz | 4–6k % |
|---|---|---|---|---|---|---|
| 平静 | neutral | 4.13 | 266.6 | 4.86 | 893 | 0.07 |
| 开心 | happy | 3.83 | 301.0 | 9.52 | 910 | 0.06 |
| 害羞 | neutral | 4.14 | 254.2 | 6.18 | 902 | 0.06 |
| 嫌弃 | angry | 4.00 | 357.4 | 7.18 | 996 | 0.13 |
| 难过 | sad | 4.75 | 271.0 | 6.08 | 928 | 0.11 |

`angry` 明显更亮更急、`sad` 最慢、`neutral` 最轻最平。**情绪带来的差异远大于调语速**，是当前性价比最高的旋钮。

**音高**：不要再花时间。`voice_setting.pitch` 在 `speech-2.8-hd` + 本机音色上实测无效（pitch 0/−4 各两遍，F0 中位 292–326 Hz 无单调性）；真正的降调只有两条路——换更低的音色，或外挂重采样（已因电子感放弃）。

### 3.3 L3 音色层（换声音是唯一「一次性」手段）

**11 个中文女声实跑**（同一句、speed 0.94、pauses 300/400、不含后处理）：

| 音色 | voice_id | 时长 s | F0 Hz | 滚降 Hz | 4–6k % | 1–4k % |
|---|---|---|---|---|---|---|
| 少女·精品 | female-shaonv-jingpin | 3.49 | 229.2 | 586 | 0.11 | 0.5 |
| 少女 | female-shaonv | 3.40 | 241.0 | 673 | 0.12 | 0.7 |
| **甜美·精品（现网）** | **female-tianmei-jingpin** | 3.40 | 245.7 | **823** | 0.06 | 0.5 |
| 甜美 | female-tianmei | 3.40 | 262.9 | 896 | 0.07 | 0.8 |
| 成熟女性·精品 | female-chengshu-jingpin | 3.71 | 197.0 | 987 | 0.28 | 3.8 |
| 清脆女声 | Chinese (Mandarin)_Crisp_Girl | 3.44 | 373.5 | 1690 | 1.34 | 11.0 |
| 空姐腔 | Chinese (Mandarin)_HK_Flight_Attendant | 3.46 | 356.0 | 2297 | 2.48 | 16.9 |
| 俏皮萌妹（旧现网） | qiaopi_mengmei | 3.57 | 345.3 | 2506 | 3.14 | 25.9 |
| 抒情女声 | Chinese (Mandarin)_Lyrical_Voice | 3.80 | 347.2 | 3806 | 4.69 | 17.0 |
| 萌灵 | Chinese (Mandarin)_Cute_Spirit | 3.17 | 373.5 | 3918 | 4.37 | 37.7 |
| 知性女声 | Chinese (Mandarin)_Wise_Women | 3.35 | 366.9 | 4234 | 7.22 | 20.7 |

两条读数决定了选型：

1. `female-*` 家族滚降只有 586–987 Hz、1–4 kHz 仅占 0.5–3.8%，这不是「柔和」而是**窄带**，听感像电话或旧录音；
2. 旧现网 `qiaopi_mengmei` 的 4–6 kHz 占 3.14%，11 个里第 3 高——「尖、往上顶」在数据上就是这 3% 的高频摩擦音。

**为什么最终是 `female-tianmei-jingpin`**：79% 能量在 300 Hz 以下、滚降 893 Hz、1–4 kHz 只占 0.6–3.4%，是天生「贴耳、暗、几乎没有齿音」的音色。这是**用音色换柔和**，不是用参数换柔和；试过 `voice_modify.timbre` 提亮（`timbre:60` 滚降仍 853 Hz）**提不亮**，暗是音色自带属性。若要更亮，只能换 `Crisp_Girl`（滚降 1690）或 `HK_Flight_Attendant`（2297）。

**`voice_modify`（官方原生旋钮，已实测但未接线）**

| 参数 | 音高位移 | 包络相似度 | 滚降 Hz | 4–6k % |
|---|---|---|---|---|
| 基线 | — | — | 3018 | 2.11 |
| `pitch:-30` | −2.8 半音 | 0.931 | 1877 | 0.76 |
| `pitch:-100` | −3.5 半音 | 0.718 | 1781 | 0.18 |
| `timbre:-50` | +0.5 半音 | — | 1985 | 1.64 |
| `intensity:-50` | +0.5 半音 | — | 2590 | 2.95 |

`pitch:-30` 是唯一「既降调又不毁音色」的档（相似度 0.931，远好于纯重采样的 0.720）；`intensity` 负值反而增高频摩擦且加速，不要用。**要用它得改 `synthMinimax` 的请求体**（现在代码里没有任何 `voice_modify` 字段）。

**Voice Clone**：`POST /v1/files/upload`（10 s–5 min、≤20 MB）拿 `file_id` → `POST /v1/voice_clone` → 直接用新 `voice_id`。手里有一段「听感就是目标」的干净人声时，这是唯一零后处理的路。

**换本地引擎**：CosyVoice3 / IndexTTS2 / VoxCPM / F5-TTS 在 RTX 5060 Laptop（8 GB）上 0.5B 级可跑、1.5B 偏紧；但要下数 GB 模型、装 torch、写适配层替换 `synthMinimax`，且 QQ 链路只保 ≤6 kHz，收益被吃掉——只在 A/B/C 都不满意时再上。

### 3.4 L4 后处理层（做过、已关闭）

**做法**：`pitchShiftWav()`——整段重采样降 `semitones`（默认 −3），再用 STFT 相位声码器 + 倒谱包络做 `formantPreserve`，把共振峰拉回原位（`formantAlpha 0–1.5`）。

**为什么做**：`female-*` 音色偏高偏薄，直接降调会「闷」，于是「降调 + 保共振峰」同时要低音高与原音色。

**结果与结论**：

- 纯重采样包络相似度 0.720，保共振峰后相关系数 0.967——指标上看是成功的；
- 但用户听感仍有「电子感」，且这条路对每一条语音都要过一遍 FFT（几十毫秒级 CPU），换音色能一次解决；
- 2026-10-24 定档 `female-tianmei-jingpin` + emotion 后**关闭**（`pitchShift.enabled=false`，`semitones`/`formantAlpha` 字段保留，回滚只改一个布尔）。

**已知限制**（万一回滚要用）：相位声码器在强噪声/气声段会有「金属尾巴」；`semitones` 超过 ±6 会明显不像本人，代码已夹到 ±6。

### 3.5 链路层：QQ 转码是硬天花板

同一段音频发送前后（`work/tts-research/` 实测，回读 `nt_data\Ptt\<年-月>\Ori\*.amr`）：

| 频段/指标 | 本地 mp3 | 经 QQ 回读 | 结论 |
|---|---|---|---|
| 时长 | 3.506 s | 3.52 s | 不变 |
| RMS / 峰值 | −25.77 / −6.79 dB | −25.82 / −6.74 dB | 不变 |
| 0.3–4 kHz | 96% 合计 | 96.2% | 基本保留 |
| 4–6 kHz | 3.12% | 3.06% | 基本保留 |
| 6–8 kHz | 0.21% | 0.16% | 掉 1/4 |
| 8–12 kHz | 0.09% | 0.04% | 掉一半以上 |

补充事实：落盘扩展名是 `.amr`，**内容其实是 SILK_V3**（头 `\x02!SILK_V3`），24 kHz 单声道、约 19.5–19.9 kbps；`bridge.js:1582` 注释里「AMR 窄带」的说法不成立。

**推论**（直接决定优化优先级）：

- 能穿过链路的只有 **1–4 kHz 的送气噪声与谱倾斜**（气声感的载体）和**时域信息**（时长/语速/停顿几乎无损）；
- 所以主战场是文本（L1）+ 音色（L3）+ 引擎参数（L2），音频后处理（L4）只保留 2–4 kHz 轻降与响度对齐；
- 别指望在 QQ 端听出 1 dB 级差别——测参数变化必须看频谱/时长，不能只靠耳朵。

**当前音色的链路验证**：平静档实发 messageId `100000001`（落盘 10446 B），回读时长 4.13→4.14 s、F0 266.6→265.5 Hz、滚降 893→892 Hz、4–6k 0.07%→0.06%——对这个音色 QQ 的 SILK 链路基本无损（它本来就没多少 4 kHz 以上能量可丢）。

### 3.6 音量与响度

- `voice-core.js` 有两条通道：`volume`（倍数，或 dB）与 `loudnorm`（EBU R128，`-40 ~ -5 LUFS`，档位 quiet/normal/loud）；
- **响度归一默认没生效**：`processAudioVolume()` 只在 `normalize === true` 时走 loudnorm，而 `bridge.js:1986` 与 `:6632` 写的是 `normalize: audio?.normalize === true`，`send_tts_voice` 不传 `audio` → 一直「原始音量」；
- 目前靠 `female-tianmei-jingpin` 本身电平稳定（RMS −25.8 dBFS）蒙过去；若要统一响度，需在发送时显式传 `normalize:true` 或 `loudness:"loud"`（代价：ffmpeg 转码一遍，且 QQ 端仍可能听不出差别）。

---

## 4. 评测与验证

| 手段 | 位置/命令 | 用途 |
|---|---|---|
| 离线断言 | `node scripts/test-voice-minimax.mjs`（2026-10-26 实跑 **44 项全过**，覆盖 `splitForTts`、`applyVoicePauses`、时长夹逼、失败后无残留） | 改代码后必跑，全过才算没破坏规则 |
| 五档真合成 | `node scripts/try-voice-minimax.mjs` | 落 `samples/`，不进 QQ，先看参数是否生效 |
| 五档批量留样 | `node scripts/verify-moods.mjs "<文本>" <遍数> [前缀]` | 每档多遍，抗抖动 |
| 改配置 | `node scripts/set-voice.mjs` | 安全改 `moods`，**不要用 PowerShell 正则改 config.json**（踩过静默失败） |
| 频谱 | `analyze-spectrum.py`（分频段能量、95% 滚降、dBFS） | 判断暗/亮/齿音，别靠耳朵 |
| 韵律 | `analyze-prosody.py`（自相关 F0 中位/p10/p90/半音跨度） | 判断情绪与语速差异 |
| 真机发送 | `node scripts/mcp-send-tts.mjs` 或 `/api/voice/send` | 拿 messageId + `verified` |
| 回读对比 | `decode-ptt.cjs` → `analyze-prosody.py` | 只信「经 QQ 回读」的数字，本地文件不算 |
| 盲听 | `work/tts-research/试听与ABX.html`、`情绪音色试听.html` | 一次只改一个变量，A/B 盲听 |

**方法论三条**（血的教训）：

1. 每档 **≥3 条**重复再比较：同参数连跑四次 F0 中位可差 1.8 半音、时长差 1 s；
2. 对比只信**回读**：4 kHz 以上能量若「变化明显」，说明你测的是本地文件、没走 QQ；
3. 时长抖动的对齐是**评测工具**的事（`probe-samplerate.mjs` 对 >6% 离群项重合成），产品链路不需要对齐——语音条长短本来就随内容变。

---

## 5. 当前生效配置（2026-10-26 快照）

```jsonc
"voiceTts": {
  "enabled": true,
  "engine": "minimax",            // 回退："edge"
  "minSeconds": 2, "maxSeconds": 60, "maxChars": 400,
  "pauses": { "enabled": true, "commaMs": 300, "stopMs": 400, "maxTags": 3 },
  "timeoutMs": 90000,
  "minimax": {
    "baseUrl": "https://api.minimax.chat",
    "model": "speech-2.8-hd",
    "keyFile": "state/minimax-key",
    "sampleRate": 24000,
    "bitrate": 128000,
    "timeoutMs": 30000
  },
  "moods": {
    "calm":    { "voice": "female-tianmei-jingpin", "speed": 0.94, "pitch": 0, "emotion": "neutral", "label": "平静" },
    "happy":   { "voice": "female-tianmei-jingpin", "speed": 1.00, "pitch": 0, "emotion": "happy",   "label": "开心" },
    "shy":     { "voice": "female-tianmei-jingpin", "speed": 0.90, "pitch": 0, "emotion": "neutral", "label": "害羞" },
    "annoyed": { "voice": "female-tianmei-jingpin", "speed": 1.02, "pitch": 0, "emotion": "angry",   "label": "嫌弃" },
    "sad":     { "voice": "female-tianmei-jingpin", "speed": 0.88, "pitch": 0, "emotion": "sad",     "label": "难过" }
  },
  "pitchShift": { "enabled": false, "semitones": -3, "formantAlpha": 1 }
}
```

配套：`socialV2.voice`（`enabled:true`、`maxSeconds:300`、`maxBytes:20 MB`、`maxPerMinute:2`、`maxPerHour:10`、`defaultVolume:1`、`loudness:"normal"`、`autoReadback:true`）、`socialV2.tools.sendVoice:true`、`socialV2.autoVoice`（30/天、20 分钟冷却、2–20 字、五场景白名单、表情联动）。

---

## 6. 调参手册

| 想要 | 改哪里 | 幅度建议 | 要重启？ | 怎么验 |
|---|---|---|---|---|
| 更缓/更像换气 | `voiceTts.pauses.commaMs` / `stopMs` | 300→350、400→450 | 否 | 时长 +0.2~0.5 s |
| 更慢一点 | `moods.*.speed` | 每次 ±0.04，别出 0.88–1.12 | 否 | 时长与 F0 |
| 更开心/更不耐烦 | `moods.*.emotion` | `happy`/`angry`/`sad`/`neutral` | 否 | F0 中位、1–4k 占比 |
| 换音色 | `moods.*.voice`（五档一起换） | 见 §3.3 表 | 否 | 滚降与 1–4k，再盲听 |
| 更亮 | 换 `Crisp_Girl`/`HK_Flight_Attendant` 或接线 `voice_modify.pitch:-30` | 后者要先改代码 | 改代码需重启 | 滚降 3018→1877 |
| 降调/更沉 | ~~`pitchShift.enabled=true`~~（已弃用）或换更低音色 | — | 否 | 听感 + 包络相似度 |
| 更少语音 | `socialV2.autoVoice.maxPerDay` 或 `enabled:false` | 30→10 | 否（热读） | `state/voice-usage.json` |
| 临时密集试音 | `socialV2.voice.maxPerHour` | 10→30，**测完改回** | 是（`socialV2.*`） | 日志不再报频率超限 |
| 一键关掉 TTS | `voiceTts.enabled=false` | — | 否 | 工具返回「语音合成未启用」 |
| 引擎回退 | `voiceTts.engine="edge"` | 需 `.venv-tts` 装好 edge-tts | 否 | 真发返回 `voiceName: zh-CN-XiaoxiaoNeural` |

**回滚**：改 `moods` 前 `Copy-Item config.json config.json.bak-voice-<时间戳>`；后处理回滚只改 `pitchShift.enabled`；音色回滚用 `config.json.bak-voice-*`。改完必须 `ConvertFrom-Json` 回读确认（PowerShell 正则改 config 踩过静默失败）。

**重启纪律**：只改 `voiceTts.*` → **免重启**（每次调用重读）；改 `socialV2.voice.enabled` / `socialV2.tools.sendVoice` → **必须重启桥接**；重启只杀 bridge（端口 3100 的 PID，`taskkill /PID <pid> /T /F`），**不要 `qqbot.mjs down`**（会连 DSH qqbridge 一起杀）。

---

## 7. 坑与边界

1. **改 `config.json` 别用正则**：一次静默失败导致「改完还是旧音色」；用 `scripts/set-voice.mjs` 或改完回读。
2. **拆条占满频控**：一次调用发 2 条 = 每分钟上限 2 条，拆条后 1 分钟内再发必被拒。
3. **`socialV2.*` 与 `voiceTts.*` 的重启语义不同**，改错一个会出现「配置改了没反应」。
4. **音色 id 跨引擎不兼容**：把 MiniMax 的 `qiaopi_mengmei` 递给 edge-tts 会 traceback；代码已用 `isEdgeVoice()`/`isMinimaxVoice()` 自动回落，但手改配置时别混。
5. **时长抖动是模型特性**：同一句差 5–15%，别以为是 bug；评测时才对齐。
6. **短文本会拖**：触发 `minSeconds` 补偿时自动降速 + 垫「，嗯」，听感变拖是正常的；文案太短就多加几个字。
7. **QQ 转码不是 AMR**：`.amr` 里是 SILK_V3，24 kHz；用 ffmpeg 按 AMR 解析会失败，用 `decode-ptt.cjs`。
8. **8 GB 显存跑不了 1.5B 级 TTS**（IndexTTS2 FP16 约 7.8 GB），本地引擎只考虑 0.5B 级。
9. **`emotion` 不是万能**：calm/shy 传 emotion 反而更假，靠 speed + pauses 就够。
10. **气口标记有上限**：单条最多 3 个、结尾不插、连续标记会被丢；写多了不生效而不是报错。
11. **响度归一没开**（`normalize` 默认 false），觉得音量不齐要显式传 `normalize:true`。
12. **不要用 `qq_list_voices` 发合成产物**：暂存在 `audio/.tts/`（隐藏目录）就是为了不污染语音库；发完即删。

---

## 8. 未做 / 待办

| 项 | 判断 | 备注 |
|---|---|---|
| 接线 `voice_modify.pitch:-30` | 值得做，成本低 | 已在请求体层验证，改 `synthMinimax` 加一个对象即可；预期降 2.8 半音且不毁音色 |
| Voice Clone 自建音色 | 想做但要样本 | 需要 10 s 以上干净人声；一次投入长期零后处理 |
| 响度归一 | 可选 | 显式 `normalize:true`；QQ 端可能听不出 |
| 本地开源引擎 | 后备 | 收益被 ≤6 kHz 链路吃掉，优先级最低 |
| 更亮的音色试听 | 可选 | `Crisp_Girl`/`HK_Flight_Attendant` 已量过，未真发盲听 |

---

## 9. 证据索引

| 内容 | 位置 |
|---|---|
| 合成/拆条/气口/后处理代码 | `src/voice-tts.mjs`（`:568` 归一化、`:613` 气口、`:657` 拆条、`:758` MiniMax、`:884` 夹逼、`:352` 降调） |
| 工具入口与调用期规则 | `src/mcp-snowluma-safe.js:1486`（`send_tts_voice`）、`:1508`（拆条）、`:1518`（超条数报错） |
| 发送层校验/音量/频控 | `src/voice-core.js`（`probeAudio`、`processAudioVolume`）、`src/bridge.js:1944`（频控）、`:1986`/`:6632`（normalize 传参） |
| 自动触发 | `src/auto-voice.mjs`、`state/voice-usage.json`、`scripts/test-auto-voice.mjs` |
| 实测数据 | `work/tts-research/合成语音更自然更柔和-研究报告.md` §9、`samples/metrics.json` |
| 盲听页 | `work/tts-research/情绪音色试听.html`、`预设音色试听.html`、`试听与ABX.html` |
| 关键 messageId | `100000001`（天美平静档 QQ 验证）、`100000001`/`-100000001`（17 字拆两条）、`-100000001`（旧音色 1.08 基准）、`100000001`（edge 回退） |
| 立项/接入 | `项目计划/02-QQ语音情绪化.md`、`项目计划/02b-MiniMax语音引擎方案.md` |

---


> 本机专用音色及试听记录不随公开版本分发。
