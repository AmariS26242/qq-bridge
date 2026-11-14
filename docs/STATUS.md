# 项目当前状态（STATUS.md）

> 公开版说明：下文的生产启用状态和历史实测数据来自原部署记录。公开示例默认关闭 projectRead / ea2Shadow；发布副本的独立验证见 [PUBLICATION.md](PUBLICATION.md)。

> 更新日期：2026-11-14
> 当前版本：`v0.2.0`（适配 DSH `0.2.0-rc.2` / `0.1.5+` 与 SnowLuma OneBot v11）
> 状态口径：本文只记录通过本地配置文件、运行日志、审计日志与实跑脚本核验的事实；**不将 `SKIPPED` 测项记作 `PASS`**。

---

## 一、`qq_project_read` 第一阶段交付与冻结基线（P5-03.1 验收通过）

### 1.1 冻结配置快照（已验证于本机 `config.json` 与 `plugins/`、`dsh/`）

| 维度 | 冻结配置 | 验证依据 |
| --- | --- | --- |
| 总开关 | `projectRead.enabled = true`（新装模板 `config.example.json` 仍保持 `false`） | `config.json` / `config.example.json` |
| 会话模式限制 | 仅 `reserved2` + 管理员本人（`ownerQQ`）私聊（`owner-private`） | `src/project-read-auth.mjs` Step 6 |
| 项目白名单 | 仅 `qq-bridge` 单项目（显式配置绝对 `expectedRootPath`） | `config.json` / `src/project-read-auth.mjs` |
| Preset 注册范围 | 仅 `qq-chat-v2` 注册 `qq-project-read`；`qq-chat` 未注册 | `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` / `qq-chat/agent.cordis.yml` |
| 模型配置 | `dsh.model = "deepseek-flash"`，`mcp.toolGroups = ["core","group","media","stickers","memory","admin"]` | `config.json` |
| 权限边界 | 只读 `tree` / `read` / `search`；**零文件写入、零 Shell、零 Git、零执行权限** | `src/project-read-ops.mjs` / `plugins/qq-agent-presets/qq-project-read.mjs` |

### 1.2 已完成功能

1. **三类只读原语**（`src/project-read-ops.mjs`）：
   - `tree`：深度（`maxDepth=5`）与条目数（`maxEntries=200`）受限的目录树枚举。
   - `read`：按行区间分段读取（单次字节与输出上限保护，`maxReadBytes=65536`、`maxOutputBytes=12288`、`maxReadLines=200`），拦截二进制文件（`isProbablyBinaryBuffer`）。
   - `search`：纯字面子串检索（`maxSearchFiles=150`、`maxSearchTotalBytes=1572864`、`maxSearchMatches=30`），禁止正则以防 ReDoS。
2. **Win32 原生防穿透与防 TOCTOU**（`src/project-read-win32-fs.mjs`）：基于 `koffi` + `NtCreateFile` + `FILE_OPEN_REPARSE_POINT` 逐级防重解析点，强制 `expectedRootPath`，`FILE_ID_INFO` 强 Fail-Closed + 祖先句柄护持 + 读后双重比对，并校验 `FILE_ID_BOTH_DIR_INFO` 对齐与边界（`parseFileIdBothDirBuffer`）。
3. **隔离鉴权与校验顺序**（`src/project-read-auth.mjs`、`src/project-read-controller.mjs`）：独立轮换 `projectReadHostToken`（`state/project-read-host-token.json`）、HMAC-SHA256 + Timestamp + 同步原子 Nonce 防重放；Header 32 个 / 8192B 上限、16KB Body 上限、错误 `Connection: close`；`JSON.parse` 与白名单 Schema 严格位于 HMAC + Nonce 之后。
4. **Fail-Closed 审计与不可信内容封装**（`src/project-read-audit.mjs`、`src/project-read-ops.mjs`）：单条 4096B 上限、`withAuditFailClosed` 先落盘后返回数据、`.1`~`.5` 轮转、损坏日志 `.evidence` 保全与 `audit_corruption_recovered`；随机 12-hex 定界符 `<untrusted-project-file boundary=...>` 包裹与 `SENSITIVE_RE` / 已知密钥脱敏。

---

## 二、P5-03.1 真实 QQ 测试与后端拦截证据

依据 `state/project-read-audit.jsonl`（2026-11-14T12:47:12Z–13:02:45Z，即 20:47–21:02 CST，共 23 条审计记录）与 `state/qq-activity.log`：

1. **真实 QQ 端到端链路**：
   - `tree` 根目录（`status: "ok"`, `truncated: true`, `33ms`）及子目录 `src` / `scripts`（均 `status: "ok"`, `truncated: false`, `7ms` / `10ms`）。
   - `read` `src/project-read-ops.mjs` 1–30 行（`ok`, `1637 B`, `truncated: false`, `9ms`）。
   - `search` `path: "src"`, `query: "ProjectReadController"`（`ok`, `truncated: false`, `957ms`）。
2. **分页完整性验证**：
   - `README.md` 两段范围读取（1–40 行 `3598 B` + 370–407 行 `3599 B`，均 `truncated: false`）。
   - `src/project-read-ops.mjs` 连续 4 页分页读取（`5841 B` / `6210 B` / `6311 B` / `2071 B`，均 `truncated: false`），以及另一轮 3 页分段读取（`7766 B truncated: true` → `8222 B truncated: true` → `4140 B truncated: false`），完整拼合无缺漏。
3. **后端敏感路径 / 越界路径 / 非授权会话拒绝证据**：
   - 敏感文件名/目录：`read config.json`、`read state/project-read-host-token.json`、`tree state` 均被后端拒绝并返回 `ACCESS_DENIED`。
   - 非法路径/越界段：`tree state/`、`tree ../`、`read ../config.json`、`tree ..` 均被后端参数层拒绝并返回 `INVALID_PATH`（`Leading or trailing slash is not allowed` / `Invalid path segment (dot_segment): ..`）。
   - 未授权会话：两个非管理员/未绑定管理员私聊的会话（含 `sessionHash: "a01f0feb47008f48"` 等）均被拒绝并记录 `project_read_auth_denied`（`UNAUTHORIZED_SESSION`: `"Session does not belong to active admin private chat"`）。

---

## 三、Preset 隔离状态

- `qq-chat`（`dsh/agent-presets/qq-chat/agent.cordis.yml`、`plugins/qq-agent-presets/presets/qq-chat.patch.yml`）：**未注册** `qq-project-read`。
- `qq-chat-v2`（`dsh/agent-presets/qq-chat-v2/agent.cordis.yml`、`plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml`）：已注册 `id: qq-project-read`（`config: {}`）。
- 共享工具守卫 `plugins/qq-agent-presets/qq-tool-restrict.mjs` 在 `SAFE_EXACT` 允许 `qq_project_read` 名称（含对非目标预设的冗余放行条目），实际隔离由 **`qq-chat` 不加载插件** + **Bridge Step 6 运行时反查（`reserved2` + `qq-chat-v2` + `ownerQQ` 私聊）** 双重保障。

---

## 四、测试与回归状态（精确口径）

| 检查命令 | 实测结果 | 跳过（SKIPPED）与说明 |
| --- | --- | --- |
| `node scripts/test-project-read.mjs` | **14 passed / 1 skipped / 0 failed** | `SKIPPED`: `Win32: Ordinary file/dir symlink denial (or honest SKIPPED if EPERM)`（当前非提权 Windows 环境 OS 返回 `EPERM` 禁止非提权进程建立普通文件 symlink；NTFS Junction 拦截测项已实跑并通过 `REPARSE_POINT_DENIED`）。**不可将该 `SKIPPED` 算作 `PASS`**。 |
| `node scripts/test-audit.mjs` | **34/34 脚本退出码 0** | 套件内个别脚本按条件跳过部分断言：除 `test-project-read.mjs` 的 1 项 `SKIPPED` 外，`test-preset-local-tools.mjs` 因静态扫描缺完整 DSH 运行时内置列表而跳过 `dshNames` 差集、且因 `qsh-closed` preset 尚未创建而跳过对应断言；`test-console-encoding.mjs` 跳过仓库外部的 `voice-tool` 检查。 |
| `node scripts/test-docs-status.mjs` | PASS | 校验 `docs/ACTION-CHECKLIST.md` §7 状态总表与脚本一致性（`test-opt-suite.mjs`）。 |
| `node scripts/privacy-scan.mjs` | PASS（详见最终核验） | 扫描文档/示例中的真实 QQ 号、本机用户路径与凭据泄漏风险。 |

---

## 五、已知运行期问题与未实测风险

1. **已知运行期故障（技术债）——`ea2-shadow` 旁路持续报错**：
   - 在 `state/bridge.log` 观察到重复告警：`[ea2-shadow] 事件旁路失败 kind=private：The requested module 'node:sqlite' does not provide an export named 'backup'`。
   - 相关代码位于 `src/ea2-shadow.mjs:104-161`（动态导入外部目录 `../../../ChatGPT/QQ/dist/src/index.js`）。因第一阶段冻结及 P6 只做设计要求，本阶段未改动其源码。
2. **已知未实测风险**：
   - **非提权 Windows 普通文件 symlink**：离线测试因 `EPERM` 跳过，管理员/开发者模式终端下的真实文件 symlink 仍属未实测边缘。
   - **真实 `icacls` / UAC 下的 `state/` ACL**：沙箱/离线审计仅做结构级断言（`scripts/test-audit.mjs`）；真实 ACL 收紧需管理员在无沙箱普通终端复跑 `node scripts/harden-state-acl.mjs`。
   - **独立静态仓库与文档漂移**：当前本地工作目录并非 Git 仓库（无 `.git`），且 `docs/FOLDER_MAP.md` / `docs/MASTER.md` 为 2026-11-07 快照，未覆盖 2026-11-14 新增的 `project-read-*` 与新状态文档（详见 P6 设计方案）。
   - **已知运行边界**：`docs/guides/SECURITY_BASELINE.md` §3 中的 R1–R11（如启发式出站敏感词审计、`state/` 明文凭据、非原子远程停止等）持续有效。

---

## 六、生产启用与回滚方法

- **当前生产态**：已按第一阶段基线启用并冻结（`projectRead.enabled = true`，仅 `owner-private` + `qq-bridge` + `qq-chat-v2`）。
- **紧急软回滚（推荐，无需改代码）**：将本地 `config.json` 中 `projectRead.enabled` 改为 `false` 并重启 `qq-bridge`（启动时自动清除 `state/project-read-host-token.json`，`/api/project-read` 立即返回 `403 FEATURE_DISABLED`）。
- **彻底摘除插件**：从 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 删除 `id: qq-project-read` 及 `plugins/qq-agent-presets/qq-tool-restrict.mjs` `SAFE_EXACT` 中的 `'qq_project_read'`，执行 `node scripts/build-agent-preset-patches.mjs` 与 `node scripts/setup-dsh.mjs` 后重启 DSH 与 `qq-bridge`。
- 完整操作步骤参见 [docs/guides/PROJECT_READ.md](guides/PROJECT_READ.md) 第六、七节。
