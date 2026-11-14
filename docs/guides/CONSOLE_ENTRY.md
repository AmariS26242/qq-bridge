# 控制台入口（常驻、免手抄 token）

控制台本身是 `http://127.0.0.1:3100`，但裸地址会返回 **401**：桥接启动时会把一个随机 token
写进 `state/console-token`，页面必须带 `?token=...` 才能进。**token 每次重启都可能变**，所以
"把带 token 的链接存成书签"这条路会隔几天就失效，且失效时页面只会显示登录失败，很难查。

本入口解决的就是这件事：**每次打开都现读 token、现拼 URL**，所以永久有效。

## 三种用法（任选，等价）

| 方式 | 操作 | 适用 |
| --- | --- | --- |
| 桌面快捷方式 | 双击桌面「QQ 控制台」图标（也可 `Ctrl+Alt+Q`） | **日常首选** |
| 开始菜单 | 开始菜单搜「QQ 控制台」 | 桌面图标被埋住时 |
| 命令行 | `node qqbot.mjs console`（在 `qqbot/` 下） | 远程 / 脚本里 |

> 桌面快捷方式指向的是 **`state/console-open.html`** —— 一个由桥接自动生成的跳转页
> （`meta refresh` 到带 token 的地址）。双击后由资源管理器直接交给默认浏览器打开，
> 不经过任何自建进程，所以不会出现「点了没反应」。token 变化时桥接会自动重写它。

## 组成

| 文件 | 作用 |
| --- | --- |
| `state/console-open.html` | **主入口**：桥接启动 / 重置令牌时自动生成，双击即跳到带 token 的控制台 |
| `scripts/open-console.mjs` | 命令行入口：探活 3100 → 读 `state/console-token` → 拼 URL → 拉起默认浏览器；同时顺手刷新入口页 |
| `open-console.vbs` | 备用无窗口启动器（`wscript //B`）。主入口失效时的第二条路：`& open-console.vbs` |
| `assets/console-v9.ico` | 快捷方式图标（仓库里的母版）：青绿渐变底 + 白色气泡内的终端提示符 `>_`，7 个尺寸（16/24/32/48/64/128/256），16–128 为 32bpp DIB + AND 掩码、256 为 PNG，透明圆角。源图 `assets/console-icon.png`，由 `scripts/build-console-icon.ps1 -Install` 生成。**注意：这个文件不能直接给快捷方式用**——`default-workspace` 目录带显式 Deny ACL（Everyone: DeleteSubdirectoriesAndFiles），Shell 会拒绝渲染该目录树下的任何 `.ico`（连系统 `OneDrive.ico` 拷进去也是白纸）。`-Install` 会把它复制到 `%LOCALAPPDATA%\QQConsole\`，快捷方式只指向那一份；换图后输出换新文件名（v10…）再 `-Install`，可绕开图标缓存 |
| `state/open-console.log` | 命令行/VBS 入口每次启动追加一行足迹，排障时先看这里 |

## 参数

| 参数 | 作用 |
| --- | --- |
| （无） | 打开浏览器 |
| `--print` / `--no-open` | 只打印带 token 的 URL，不开浏览器（可配合 `curl`、手机扫码） |
| `--check` | 只探活：在线打印「控制台在线」，退出码 0；不在线退出码 3 |

```powershell
# 只想拿到链接（例如贴到手机上打开）
node scripts\open-console.mjs --print

# 桥接到底在不在
node scripts\open-console.mjs --check
```

退出码：`0` 成功、`2` 找不到 token、`3` 3100 没在监听（说明桥接没起来）。

## 失效时怎么查

1. 看 `state/open-console.log` 最后一行：
   - `open url` —— 入口跑通了（VBS→Node→浏览器都已执行）。若屏幕上仍没窗口，问题在浏览器关联，
     用 `node scripts\open-console.mjs --print` 拿到链接手动粘进浏览器；
   - `abort: port closed` —— 桥接没启动，先 `node qqbot.mjs up`；
   - `abort: token missing` —— 桥接启动过但从没生成过 token，同样先 `up`；
   - **没有任何新行** —— 快捷方式没跑到脚本：确认 `open-console.vbs` 还在、`.vbs` 关联没被安全软件拦掉，
     临时改用 `node qqbot.mjs console`。
2. 直接跑一次前台版看真实报错（会显示中文错误信息）：
   ```powershell
   cd <repo>
   node scripts\open-console.mjs --check
   ```

> 已知坑（2026-10-19 修）：早先版本用 `cmd /c start "" <url>` 拉浏览器，空标题参数被吞后
> `start` 把 URL 当窗口标题，表现是"点了没反应、日志却有 `open url`"；换成
> `rundll32 url.dll,FileProtocolHandler` 后从脚本里仍偶发不弹窗。最终方案是**不再自己拉浏览器**：
> 快捷方式直接指向 `state/console-open.html`，由资源管理器交给默认浏览器。
> `open-console.mjs` 保留「注册表查默认浏览器 exe → rundll32 → explorer」三级兜底，只服务命令行用法。

## 和「桥接自启动」的关系

入口只负责**打开控制台**，不负责**启动桥接**。桥接由计划任务
`DSH QQ Bot Watchdog` / `DSH QQ Bot Start` 常驻（见 `windows-daemon-ops` 技能与
`docs/guides/RELIABILITY.md`）。所以 3100 没监听时正确动作是 `node qqbot.mjs up`，
而不是反复点图标。
