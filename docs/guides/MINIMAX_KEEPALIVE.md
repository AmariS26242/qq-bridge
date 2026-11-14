# MiniMax 音色每日保活

MiniMax 音色保活由 `scripts/minimax-keepalive.mjs` 执行。它每天按 Asia/Shanghai 日期最多成功一次：现场合成一条短语音，经 OneBot 发到 `minimaxKeepalive.targetKey`，随后用 `get_msg` 回读 `record` 段。当天已成功过就跳过，失败会重试 3 次并把错误写进 `state/minimax-keepalive.json` 与 `.log`。

当前配置使用 `YOUR_CLONED_VOICE_ID`、`private:100000001`、每日 23:30。Windows 计划任务名为 `DSH MiniMax Voice Keepalive`，启动器是隐藏窗口的 `scripts/minimax-keepalive.vbs`。手工检查使用：

```text
node scripts/minimax-keepalive.mjs --dry
node scripts/minimax-keepalive.mjs --force
```

`--force` 会忽略当天幂等标记并实际合成/发送，只有在需要补测时使用。
