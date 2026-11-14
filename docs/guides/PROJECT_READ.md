# 受限只读项目访问（`qq_project_read`）架构与运维指南

> **第一阶段交付状态（P5-03.1 验收通过并冻结）**：
> - **本机当前运行态（已冻结基线）**：`config.json` 中 `projectRead.enabled = true`，仅开放给 **`owner-private`（管理员私聊）**、**`reserved2` 模式**、**`qq-chat-v2` preset**、**仅 `qq-bridge` 单项目白名单**，零文件写入/Shell/Git/执行权限。
> - **默认发布模板**：`config.example.json` 仍保持 `projectRead.enabled = false`（fail-closed 默认值）；全新部署须管理员显式配置 `expectedRootPath` 后启用。

---

## 一、设计目标与严格安全边界

`qq_project_read` 允许 QQ 端在严格受限的前提下只读浏览、读取与字面检索指定的本机项目目录（如 `qq-bridge` 自身），**而不必开启 DSH 的通用本地文件/命令执行工具**。

### 硬边界约束
1. **默认关闭（Fail-Closed）**：未显式配置 `projectRead.enabled: true` 与项目 `expectedRootPath` 时，Controller 与 DSH 插件均直接拒绝请求，且不在 `state/` 写入 `project-read-host-token.json`。
2. **严格适用范围**：仅限 `reserved2` 模式 + `qq-chat-v2` preset + **管理员本人（`ownerQQ`）私聊会话**。`qq-chat` preset 不挂载该插件；群聊、非管理员私聊及非 `reserved2` 会话全部被 Bridge 拒绝。
3. **禁止子代理（Subagent）调用**：DSH 插件通过 `exec.agent.session.header.origin`、`delegationDepth`、`options.subagentDepth`、`parentSessionId` 实时拦截任何子代理上下文。
4. **模型侧 Schema 零凭据与零高危能力**：工具 Schema 仅开放 `action`（`tree`/`read`/`search`）、`project`、`path`、`startLine`、`endLine`、`query`、`caseSensitive`，不接受 `key`、`token`、`sessionId`、`regex` 或任何身份参数；不缓存 `sessionId`。
5. **纯只读与无正则检索**：所有读取均基于 Win32 原生句柄；`search` 仅做字面子串匹配，禁止编译正则，杜绝 ReDoS。

---

## 二、模块架构

| 模块 | 路径 | 职责 |
|---|---|---|
| Bridge 认证与配置规整 | `src/project-read-auth.mjs` | 规整 `config.projectRead`（拒绝空/相对/UNC `expectedRootPath`）；Host Token 生成与重启轮换；Step 1~6 校验链 |
| Win32 原生安全 FS | `src/project-read-win32-fs.mjs` | 基于 `koffi` 调用 `NtCreateFile` / `GetFileInformationByHandleEx` / `GetFinalPathNameByHandleW` / `ReadFile`；相对目录逐级防重解析点、祖先链护持、同句柄校验与读取 |
| 只读操作与封装 | `src/project-read-ops.mjs` | `tree` / `read` / `search` 业务执行、敏感路径过滤、二进制拦截、配额裁剪、随机定界符不可信数据封装与运行期秘密脱敏 |
| Fail-Closed 审计日志 | `src/project-read-audit.mjs` | 单条 4096B 硬上限、`withAuditFailClosed` 先落盘后放行、`.1`~`.5` 轮转、损坏日志完整保全为 `.evidence` 并记录 `audit_corruption_recovered` |
| HTTP 协调控制器 | `src/project-read-controller.mjs` | 串联 16KB rawBody 读取、Auth 校验、Audit Fail-Closed 与只读业务，供 `src/bridge.js` `/api/project-read` 调用 |
| DSH 宿主工具插件 | `plugins/qq-agent-presets/qq-project-read.mjs` | 逐调用从 `exec.agent.session.id` 提取身份、拦子代理、实时读取 `state/project-read-host-token.json` 并用 HMAC-SHA256 签名发往本机回环 Bridge |
| 预设与守卫集成 | `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`、`plugins/qq-agent-presets/qq-tool-restrict.mjs` | 仅向 `qq-chat-v2` 注入 `qq-project-read` 行（`config: {}` 零凭据），并在 `SAFE_EXACT` 放行 `qq_project_read` |

---

## 三、第三轮安全加固落地点

1. **目录枚举缓冲边界与对齐校验**（`parseFileIdBothDirBuffer`）：校验 `FILE_ID_BOTH_DIR_INFO` 每条记录的 `FileNameLength`（`>= 2`、偶数、`<= 510`、不越界）及 `NextEntryOffset`（8 字节对齐、`>= 104 + FileNameLength`、不越出缓冲区），异常即抛出 `ENUM_CORRUPT_BUFFER`。
2. **HTTP 边界与校验顺序**（`assertBoundedRawHeaders`、`readBoundedRawBody` & `verifyAndExecute`）：在读取请求体前先行限制原始 Header 数量（最多 32 个）与总长度（最大 8192 字节，超限返回 431）并验证必要认证 Header；对 `Content-Length` 与 `Chunked` 请求统一执行 16KB 请求体上限（413），强制 `application/json`（415）；所有错误响应均设置 `Connection: close` 并在响应刷出后关闭底层 Socket；先完成**常量时间 HMAC-SHA256 验证与同步原子 Nonce 查重**，**严格在此之后**再执行 `JSON.parse` 与白名单 Schema 校验（失败 HMAC 绝不写入 Nonce 缓存）。
3. **显式可信根目录约束**：`expectedRootPath` 必须由可信配置文件明确给出本机绝对路径，拒绝空值、相对路径与 UNC 路径，禁止静默回退 `process.cwd()` 或仓库根目录。
4. **`FILE_ID_INFO` 强 Fail-Closed 与祖先链持有**：`GetFileInformationByHandleEx(FileIdInfo)` 返回 `0` 立即抛 `FILE_ID_INFO_FAILED`；使用 64 位 `VolumeSerialNumber` 与 16 字节 `FileId` 在读前/读后双重比对，并在 `openRootSafely` / `traverseToParentDir` / `safeReadFileRelative` 持有必要目录句柄至操作完成。
5. **审计单条上限与损坏证据保全**：单条日志上限 `MAX_AUDIT_ENTRY_BYTES = 4096`；遇到中间损坏行或尾部截断时，先将完整原始文件保存为 `.corrupt-<stamp>-<rand>.evidence`，并在恢复日志末写入 `audit_corruption_recovered` 标记指向该证据文件，禁止静默删改中间记录。

---

## 四、P5-03.1 验收实测结果与安全证据（2026-11-14）

> 严格区分**已实测通过（PASS）**、**条件跳过（SKIPPED）**与**已知未实测风险**；绝不将 `SKIPPED` 记为 `PASS`。

### 4.1 真实 QQ 端到端测试与分页完整性（`state/project-read-audit.jsonl`）

在 2026-11-14 20:47–21:02 CST（UTC `12:47:12Z`–`13:02:45Z`）期间，实测共产生 23 条审计事件：

| 测项类别 | 实测动作 / 路径 | 实测结果 | 证据摘要 |
| --- | --- | --- | --- |
| **目录浏览与子目录分页** | `tree` 根与 `src` / `scripts` | `status: "ok"` | 根目录 `tree` 正常截断（`truncated: true`, `33ms`）；子目录 `src` 与 `scripts` 均完整返回（`truncated: false`, `7ms` / `10ms`） |
| **文件分段与连续分页读取** | `read` `README.md` 与 `src/project-read-ops.mjs` | `status: "ok"` | `README.md` 分两段读取（`3598 B` + `3599 B`, `truncated: false`）；`src/project-read-ops.mjs` 完成 1-30 行及连续 4 页读取（`5841 B` / `6210 B` / `6311 B` / `2071 B`, 均 `truncated: false`）与另一次 3 页分页读取（`7766 B truncated: true` → `8222 B truncated: true` → `4140 B truncated: false`），分页拼接完整 |
| **字面检索** | `search` `path: "src"`, `query: "ProjectReadController"` | `status: "ok"` | 字面子串检索成功返回（`truncated: false`, `957ms`） |
| **敏感文件名 / 目录拒绝** | `read config.json`、`read state/project-read-host-token.json`、`tree state` | 后端拒绝（`ACCESS_DENIED`） | 审计精确记录 `Access denied to restricted project path` / `Restricted path denied: state` |
| **路径语法与越界拒绝** | `tree state/`、`tree ../`、`read ../config.json`、`tree ..` | 后端拒绝（`INVALID_PATH`） | 首尾斜杠及 `..` 段被参数校验拒绝（`Leading or trailing slash is not allowed` / `Invalid path segment (dot_segment): ..`） |
| **会话身份边界拒绝** | 两个非管理员 / 未授权会话发起调用 | 后端拒绝（`UNAUTHORIZED_SESSION`） | 审计记录 `project_read_auth_denied`（`Session does not belong to active admin private chat`） |

### 4.2 Preset 隔离验证

- `dsh/agent-presets/qq-chat/agent.cordis.yml` 与 `plugins/qq-agent-presets/presets/qq-chat.patch.yml` **未包含** `qq-project-read` 插件。
- 仅 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 与 `plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml` 注册 `id: qq-project-read`（`config: {}`）。
- 尽管 `plugins/qq-agent-presets/qq-tool-restrict.mjs` 为两套预设共用且将 `'qq_project_read'` 列入 `SAFE_EXACT`，DSH 仅在 `qq-chat-v2` 加载该插件，且 Bridge `ProjectReadAuthEngine` Step 6 再次强制校验 `currentMode === 'reserved2'`、`sessionPolicies` 为 `qq-chat-v2` 及管理员私聊（`private:<ownerQQ>`）。

### 4.3 离线回归与专项测试实测口径

- `node scripts/test-project-read.mjs`：**14 passed, 1 skipped, 0 failed**。
  - 唯一 `SKIPPED` 用例：`SKIPPED Win32: Ordinary file/dir symlink denial (or honest SKIPPED if EPERM)`——在未提权且未开启开发者模式的 Windows 环境下，OS 禁止非提权进程创建普通文件 symlink（`EPERM`）；同一套测试中的 **NTFS Junction（目录重解析点）拒绝测项已实跑并通过（`REPARSE_POINT_DENIED`）**。该 `SKIPPED` 用例不得计作 `PASS`。
- `node scripts/test-audit.mjs`：**34/34 脚本执行退出码 0（PASS）**。说明：合集内个别脚本（如 `test-project-read.mjs`、`test-preset-local-tools.mjs`、`test-console-encoding.mjs`）存在按环境条件明确标注的 `SKIPPED` 子测项，具体见各脚本输出与 [docs/STATUS.md](../STATUS.md)。

---

## 五、已知风险与限制清单

| 风险/限制 | 现状说明与缓解 |
| --- | --- |
| **普通用户无权创建文件级符号链接测试（未实测边）** | 在非提权 Windows 环境中普通 file symlink 测项为 `SKIPPED`（Junction 拦截已实测通过）；若在开启开发者模式或管理员会话下部署，建议人工补跑验证一次。 |
| **宿主 Token 文件 ACL 依赖管理员权限** | `state/project-read-host-token.json` 通过 `state-acl.mjs` 的 `hardenFile` 收紧 DACL；若运行账号无权修改 DACL 且 `state/` 未收紧，本机其他同权进程仍存在读取窗口（建议确保通过 `start.bat` / 提权执行过 `harden-state-acl.mjs`）。 |
| **文件内容仍可能含未知格式的高熵/业务敏感字段** | 已屏蔽 `.git`、`state`、`config.json*`、`.env*`、`*.key` 等高危路径并对 `SENSITIVE_RE` 与已知运行期密钥脱敏；仍建议配合各项目的 `denyPaths` 列表限制不必要目录。 |
| **内容级提示注入防御属纵深防御** | 返回文本采用单次随机定界符 `<untrusted-project-file boundary=...>` 包裹并转义伪造标签，模型仍需遵守 `qq-chat-v2` 核心安全指令，不可将项目注释视为指令执行。 |
| **`SAFE_EXACT` 跨预设共用守卫依赖插件未加载假设** | `qq-tool-restrict.mjs` 在 `qq-chat` 与 `qq-chat-v2` 共用且放行 `qq_project_read`；当前靠 `qq-chat` 不注册插件 + Bridge Step 6 校验实现双保险，后续修改 preset 配置时必须运行 `test-agent-preset-patches.mjs` 与 `test-qq-preset-contract.mjs`。 |

---

## 六、启用指南与生产配置（模板默认关闭 / 本机第一阶段已启用冻结）

> 新装模板 `config.example.json` 保持 `projectRead.enabled: false`；以下为生产启用方法：

1. **确认 ACL 基线**：在普通提权终端运行 `node scripts/harden-state-acl.mjs` 确认 `state/` 访问收紧生效。
2. **更新 DSH preset 与插件**：
   - 运行 `node scripts/build-agent-preset-patches.mjs` 确认 `plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml` 最新。
   - 运行 `node scripts/setup-dsh.mjs`（按需同步 preset）并重启 DSH 使 `qq-chat-v2` 加载 `qq-project-read` 插件。
3. **显式开启本地 `config.json`**：
   ```json
   "projectRead": {
     "enabled": true,
     "projects": {
       "qq-bridge": {
         "expectedRootPath": "D:\\path\\to\\qq-bridge",
         "denyPaths": ["custom-secrets/**"]
       }
     }
   }
   ```
   > `expectedRootPath` 必须填写真实绝对路径，不能留空。第一阶段冻结配置只允许保留 `qq-bridge` 单项目且仅开放给管理员私聊。
4. **重启 `qq-bridge` 并验证**：观察启动日志与 `/api/security` 输出中 `projectRead.enabled === true` 且 `tokenActive === true`，使用管理员私聊测试只读 `tree` / `read` / `search`，检查 `state/project-read-audit.jsonl` 有对应审计记录。

---

## 七、回滚方案

### 方案 A：即时软关闭（推荐，无需改代码，10 秒内生效）
1. 将本地 `config.json` 中 `projectRead.enabled` 改为 `false`（或直接删除 `projectRead` 节）。
2. 重启 `qq-bridge`（Bridge 启动时 `ProjectReadAuthEngine` 会自动清理 `state/project-read-host-token.json`）。
3. 生效后 `/api/project-read` 立即返回 `403 FEATURE_DISABLED`，DSH 侧 `qq_project_read` 也会立即报未初始化拒绝执行。

### 方案 B：从 `qq-chat-v2` 彻底摘除插件
1. 在 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 删除 `id: qq-project-read` 行，并从 `plugins/qq-agent-presets/qq-tool-restrict.mjs` `SAFE_EXACT` 移除 `'qq_project_read'`。
2. 运行 `node scripts/build-agent-preset-patches.mjs` 与 `node scripts/setup-dsh.mjs`，随后重启 DSH 与 `qq-bridge`。
