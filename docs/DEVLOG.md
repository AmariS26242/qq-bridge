# 开发与验收日志（DEVLOG.md）

> 按里程碑记录已验证的工程变更、验收证据与后续设计入口。历史早期的审计修复详单见 `docs/README.md` 所列各专题文档。

---

## 2026-11-14 — P6：Project Intelligence 方案设计启动（纯方案阶段）

- **范围约束**：严格保持第一阶段冻结状态，**不修改任何源码、不扩大 `projectRead` 权限、不创建新生产工具、不执行 Git commit / push**。
- **完成内容**：
  - 基于逐文件读取 `src/bridge.js`、`src/project-read-*.mjs`、`src/dsh-client.js`、`src/mcp-snowluma-safe.js`、`src/ea2-shadow.mjs`、`plugins/qq-agent-presets/*`、`scripts/test-*.mjs` 的实际行号与调用关系，建立当前源码级架构地图与消息调用链（覆盖入站 WebSocket → `handleIncoming` → `reserved2`/`chat` 分发 → `ensureSession` → `deliverPrompt` → DSH mux 事件流 → MCP/HTTP 发送与 `auditAndSend`/`onebotSend` 出站，以及 `qq_project_read` 旁路调用链）。
  - 完成 **P6: Project Intelligence 技术方案**（见 [docs/plans/2026-11-14-project-intelligence-design.md](plans/2026-11-14-project-intelligence-design.md)），覆盖目录结构分析、核心模块识别、入口与调用链追踪、模块依赖关系、`README`/`STATUS`/`DEVLOG` 联合分析、测试与源码对应关系、技术债务定位（如 `src/ea2-shadow.mjs` `node:sqlite` `backup` 导出缺失错误），以及基于 `qq_project_read` 的增量新鲜度校验机制（严禁把旧索引当现行源码、严禁无证据补全调用链）。
- **状态**：方案提交完毕，暂停开发，等待进一步授权。

---

## 2026-11-14 — P5-03.1：`qq_project_read` 第一阶段最终功能验收通过并冻结

- **验收范围**：受限只读项目访问（`qq_project_read`）第一阶段工程交付。
- **冻结决策**：
  1. 维持 `projectRead.enabled = true`（仅本机当前已验收配置；`config.example.json` 模板保持 `false`）。
  2. 维持 `owner-private`（仅 `reserved2` + 管理员本人 `ownerQQ` 私聊）。
  3. 维持仅 `qq-bridge` 单项目白名单。
  4. 维持仅 `qq-chat-v2` preset 注册（`qq-chat` 隔离不加载）。
  5. 不增加文件写入、Shell、Git 或任何执行权限，不重构已验证安全架构。
- **实测证据摘要**（来源：`state/project-read-audit.jsonl`、`state/qq-activity.log` 与离线回归脚本）：
  - **真实 QQ 端到端**：在 `20:47–21:02 CST`（`12:47:12Z–13:02:45Z`）执行 `tree`（根目录与 `src` / `scripts` 子目录）、`read`（`README.md` 分段与 `src/project-read-ops.mjs` 连续 4 页及 3 页分页读取，均正确拼接/标记 `truncated`）、`search`（`src` 下字面搜索 `ProjectReadController`）。
  - **后端安全拦截实证**：
    - `config.json`、`state`、`state/project-read-host-token.json` → `ACCESS_DENIED`；
    - `state/`、`../`、`../config.json`、`..` → `INVALID_PATH`；
    - 两个非管理员 / 未授权会话 → `UNAUTHORIZED_SESSION`（`project_read_auth_denied`）。
  - **专项离线回归**：`node scripts/test-project-read.mjs` 实测 **14 passed / 1 skipped / 0 failed**（非提权 Win32 文件 symlink 因 OS `EPERM` 诚实记 `SKIPPED`；NTFS Junction 拦截通过）。
  - **全量离线审计**：`node scripts/test-audit.mjs` **34/34 脚本执行退出码 0**（含条件性 `SKIPPED` 子测项，具体口径见 [docs/STATUS.md](STATUS.md)）。
- **交付文档同步**：更新 `README.md`、`docs/guides/PROJECT_READ.md`、`docs/guides/SECURITY_BASELINE.md`、`docs/guides/TOOL_SURFACE.md`、`docs/README.md`，并新建 `docs/STATUS.md` 与 `docs/DEVLOG.md`。

---

## 历史里程碑索引（见专题文档）

- **DSH 0.2.0-rc.2 适配与会话队列/工具守卫对账**：详见 [docs/guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md)（`v0.2.0`）。
- **表达层与记忆/成本优化（O1–O7 / B1 离线盲评 / 工具面裁剪）**：详见 [docs/OPTIMIZATION-MASTER.md](OPTIMIZATION-MASTER.md)、[docs/ACTION-CHECKLIST.md](ACTION-CHECKLIST.md) 与 [docs/guides/TOOL_SURFACE.md](guides/TOOL_SURFACE.md)。
- **早期安全基线与多轮代码审计**：详见 [docs/guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) 与 [docs/README.md](README.md)。
