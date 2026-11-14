# QQ 端 · 可复现交付包

这个包是「SnowLuma + qq-bridge + DSH profile + qqbot 编排」这套 QQ 端的**完整代码与配置模板**，配合 `docs/guides/QQ_CHANGES_VS_UPSTREAM.md`（相对上游的全部改动说明）使用。

包里的所有本机专属信息（用户名、绝对路径、两个 QQ 号、OneBot token、WebUI 口令）都已替换成 `__占位符__`，由 `bootstrap.ps1` 在目标机器上一次替换掉。**所以这个包可以直接进版本库、可以直接发给别人。**

---

## 一、包里有什么

```text
qq-bridge-repro/
├─ bootstrap.ps1              ← 一键落地脚本（校验 → 替换占位符 → 铺目录 → 装依赖 → 建 Junction）
├─ MANIFEST.sha256            ← 648 个文件的 SHA256，bootstrap 第一步就校验它
├─ BASELINE.json              ← 版本锁定：qq-bridge 0.2.0-r3 / SnowLuma 1.14.22 / node 22.13.0 / DSH 0.2.1-rc.3
├─ config.template.json       ← 运行配置全量模板（387 键，含 171 个只在运行配置里的功能开关）
├─ qq-bridge/                 ← 代码主体（上游全量 + 39 个新模块 + 7 个改动模块 + scripts/docs/eval/android 等）
├─ qqbot/                     ← 编排层（qqbot.mjs、启停脚本、看门狗、qqbot.local.example.json）
├─ dsh-profile/               ← DSH profile 三件套模板（package.json / cordis.yml / cordis.patch.yml）
└─ snowluma-config/           ← SnowLuma 配置模板（runtime/ui/notifications + 两个账号的 OneBot 配置，token 已脱敏）
```

不含：`node_modules`、`state/`（运行时数据）、`*.bak*`、`config.json` 真实值、Android 签名密钥、日志。

---

## 二、三条命令落地

```powershell
# 0. 前置：Node >= 22.13；DeepSeek Harness 已装好（dsh 在 PATH）；SnowLuma 1.14.22 已解压到某处
Expand-Archive .\qq-bridge-repro-YYYYMMDD-HHMM.zip -DestinationPath D:\tmp

cd C:\example\qq-bridge-repro
pwsh -File bootstrap.ps1 -Workspace C:\example\bots -OwnerQQ <主人QQ> -BotQQ <小号QQ> -SnowLumaDir C:\example\bots\SnowLuma
```

跑完会得到：

```text
C:\example\bots\
├─ qq-bridge\        （+ config.json 已按模板生成、依赖已装）
├─ qqbot\            （+ qqbot.local.json 已按模板生成）
└─ SnowLuma\config\  （四个配置 + 两个 OneBot 账号配置已铺好）
%USERPROFILE%\.dsh\
├─ plugins\{qq-mode-console,qq-agent-presets}   ← 指向 C:\example\bots\qq-bridge\plugins 的 Junction
└─ profiles\qqbridge\{package.json,cordis.yml,cordis.patch.yml}
```

常用开关：

| 参数 | 作用 |
|---|---|
| `-VerifyOnly` | 只校验包完整性，不落盘 |
| `-SkipInstall` | 跳过依赖安装（离线/已装） |
| `-SkipVerify` | 跳过清单校验（仅调试用） |
| `-Force` | 覆盖已存在的 SnowLuma 配置 / 非联接的插件目录 |
| `-Profile <名>` | 换 profile 名（默认 `qqbridge`） |
| `-DshHome <路径>` | DSH 主目录（默认 `~/.dsh`） |

---

## 三、占位符对照

| 占位符 | bootstrap 填入 | 出现在哪 |
|---|---|---|
| `__USERNAME__` | `$env:USERNAME` | 路径片段、测试脚本 |
| `__USERPROFILE__` / `__USERPROFILE_ESC__` / `__USERPROFILE_FWD__` | `$env:USERPROFILE` 三种写法 | 配置、profile、JS 字面量 |
| `__WORKSPACE__` / `__WORKSPACE_ESC__` / `__WORKSPACE_FWD__` | `-Workspace` 三种写法 | 同上 |
| `__DSH_RUNTIME_NODE__` | DSH 自带 `node.exe` 绝对路径（自动探测 4 级父目录） | `cordis.patch.yml` 的 4 个 MCP 条目 |
| `__OWNER_QQ__` | `-OwnerQQ` | 主人判定、默认会话 key、测试 |
| `__BOT_QQ__` | `-BotQQ` | 账号配置名、自检 |
| `__ONEBOT_TOKEN__` | 读 `<SnowLumaDir>\config\onebot_<BotQQ>.json`；读不到就留占位 | `config.json`、OneBot 模板 |
| `__SNOWLUMA_WEBUI_PASSWORD__` | 环境变量 `SNOWLUMA_WEBUI_PASSWORD`，否则留占位 | `qqbot.local.json` |

`__SNOWLUMA_PASSWORD_HASH__` / `__SNOWLUMA_PASSWORD_SALT__` 是 SnowLuma 自己生成的散列，**不要手工填**——首次启动后在 SnowLuma WebUI 里设口令即可。

---

## 四、落地后还剩 3 件手工事

1. **SnowLuma 账号与口令**：首次启动 SnowLuma，WebUI（默认 `127.0.0.1:5099`）里设口令、建 `<BotQQ>` 的 OneBot 账号（HTTP 3000 / WS 3001），然后：
   - 把该账号的 **HTTP token** 填进 `<WS>\qq-bridge\config.json` → `snowluma.accessToken`
   - 把 WebUI 口令填进 `<WS>\qqbot\qqbot.local.json` → `snowluma.password`
2. **语音（可选）**：
   ```powershell
   cd <WS>\qq-bridge
   python -m venv .venv-tts
   .\.venv-tts\Scripts\pip install edge-tts
   # ffmpeg/ffprobe 放进 PATH，或写进 config.json 的 voiceTts.exe
   ```
3. **自检**：
   ```powershell
   cd <WS>\qq-bridge
   pnpm run self-test       # DSH 侧链路（没 pnpm 就用 npm run self-test）：连 API → 建会话 → 发 prompt → 收 turn/end
   node scripts\doctor.mjs  # 全链路体检（QQ桥 / bot / 手机桥 / 校园网 / 配置 / 备份）
   ```

---

## 五、验收（缺一不可）

| 检查 | 期望 |
|---|---|
| `pnpm run self-test` | 能连 DSH、建会话、收到 `turn/end` |
| 控制台 `http://127.0.0.1:3100/` | 能打开，运行模式显示 `reserved2`（二代仿真） |
| QQ 里发一句给机器人 | 30 秒内回一条；控制台「活动日志」有记录 |
| `node scripts\doctor.mjs` | CORE_TESTS 全绿（「历史红」不计） |
| DSH `~/.dsh/profiles/qqbridge` 加载 | 启动日志里 4 个 MCP server 都 registered（`snowluma` / `snowluma-host` / `web-search-safe` / `memory`） |

---

## 六、常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| MCP 工具「一个都没注册」 | 依赖目录布局是符号链接，受限上下文解析失败 | 确认 `.npmrc` 里 `node-linker=hoisted` 还在（别删）；pnpm 11 的默认 symlink 布局会踩这个坑，本包的 `.npmrc` + `pnpm-lock.yaml` 已按 hoisted 装好 |
| DSH 启动报 unknown prompt variable `{{cwd}}` | 用了上游旧版提示词 | 本包已删掉该行；别把上游 `agent.cordis.yml` 覆盖回来 |
| 回合直接判死：「tool input is invalid JSON」 | DSH 默认不重试 MALFORMED_RESPONSE | 本包 `cordis.patch.yml` 已补 retryPolicy，确认整段被加载 |
| 任务计划查询失败 `0x80070003` | qq-bridge 跑在 Low 完整性 node 下 | `qqbot.local.json` 的 `node` 必须指向 **SnowLuma 自带** `node.exe`（Medium 完整性） |
| 一用工具就说执行环境坏了 | 受限上下文 TEMP 不可写 | 用 `qqbot.mjs up` 启动（内部会兜底 TEMP 到 `qqbot\tmp`），别直接 `npm start` |

---

## 七、版本与升级

- 锁在 `BASELINE.json`：qq-bridge `0.2.0-r3`、SnowLuma `1.14.22`、Node `22.13.0`、DSH `0.2.1-rc.3`。
- DSH 升级后必跑 `pnpm run self-test`；`dsh-client` 的适配面（requestId、slash-RPC、Cookie 鉴权、`$events`）随版本变化，这是最容易被静默破坏的地方。
- 升级 SnowLuma 只影响 `snowluma-config/`，代码零依赖；上游 qq-bridge 升级则需要重新 diff（见主文档 0.3 章的三条命令）。

---

## 八、重新生成这个包

包由 `qq-bridge\scripts\build-repro.ps1` 生成。包里也带了一份（`qq-bridge/scripts/build-repro.ps1`）仅供看实现，**它只能在本机原始工作区跑**（要读 SnowLuma 源码目录、当前 `config.json` 与 `~/.dsh` 里的真 profile）；在别的机器上重打包没意义——改代码就在原始工作区重跑：

```powershell
cd <WS>\qq-bridge
pwsh -File scripts\build-repro.ps1 -KeepStage   # 产物在 repro-out\，-KeepStage 保留中间目录供检查
```

脚本会重新扫一遍白名单、重新参数化、重新算清单，所以**改完代码重新打包即可**，不需要手工维护任何清单。

---

## 九、实测记录（生成这份包时在空目录跑过一遍）

不是「应该能装」，是装过：

| 步骤 | 结果 |
| --- | --- |
| 解开 zip → `bootstrap.ps1 -VerifyOnly` | 648 个文件，缺失 0，损坏 0 |
| `bootstrap.ps1 -Workspace <临时目录> -DshHome <临时目录> -SkipInstall` | 占位符全部替换；`qqbot.local.json` 的 `dsh.cmd` 自动回填为本机真实 `dsh`；两个 Junction 建立；`config.template.json` 铺成 `config.json`（387 键） |
| 同上，带依赖安装（pnpm 11.28.5） | 13.2 秒装完 8 个依赖，`postinstall` 修补 `@snowluma/sdk` 13 个文件 |
| 语法检查 | 包内 234 个 `.js/.mjs` 逐个 `node --check`，0 失败 |
| 单测 | `test-md`、`test-wait`、`test:ai-tone`、`test-reminders`、`test-stickers`、`test:preset-prompt`、`test:role-card`、`test-profiles`、`test:fewshot`、`test-forward`、`test-slang`、`test:sticker-index` 共 12 套全绿 |

`test-console` / `test-voice*` / `self-test` / `doctor` 这类要求**活着的 bridge 或活着的 DSH** 的用例，在空目录里必然红——它们验的是运行中链路，不是代码正确性，落地后在真机上跑（见第五节）。
