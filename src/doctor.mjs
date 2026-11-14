// 一键自检的**纯逻辑**：判定口径 + 简报行 + 历史裁剪。所有 I/O 都在 scripts/doctor.mjs。
//
// 为什么单独一个模块：简报要在「bridge 停了」的时候说出「自检 5/8 通过」，所以渲染必须能
// 脱离任何服务单独跑、单独测（scripts/test-doctor.mjs）。这里刻意不碰 fs/net/child_process。
//
// 判定口径（重要，见 项目计划/07-候选项目清单.md ③）：
//   1. 一项 check 只有 ok === true 才算绿；undefined/null 一律算红 —— 自检宁可误报，不可漏报。
//      （与每日简报的 services 行相反：简报怕烦，自检怕骗。）
//   2. 「历史红」不算红：本仓库有 20 个测试是历史遗留的红的（需要活的 SnowLuma / 已删模块），
//      把它们算进 check 会让自检永远红、进而没人看。核心集（CORE_TESTS）必须全绿，
//      其余只在 detail 里报数，`--strict` 时才升格为红。
//   3. 失败点名只点名「最外层」的东西（哪项 check、哪个配置键），细节放 JSON 里。

export const DOCTOR_DEFAULTS = Object.freeze({
  historyLimit: 10,
});

/** check key → 中文名。简报行只有一行，名字必须短。 */
export const CHECK_LABELS = Object.freeze({
  tests: '单测',
  qqbridge: 'QQ桥',
  qqbot: 'bot',
  phoneBridge: '手机桥',
  campusNet: '校园网',
  config: '配置',
  backup: '备份',
  health: '健康',
  memory: '记忆',
  link: 'QQ链路',
  tasks: '任务',
});

/**
 * 核心单测：离线、确定性、秒级、且覆盖「这次真的在改的东西」。
 * 新增功能时把对应 test-*.mjs 加进来（加完跑一次 scripts/doctor.mjs 确认没变红）。
 */
export const CORE_TESTS = Object.freeze([
  'test-backup.mjs',
  'test-daily-brief.mjs',
  'test-doctor.mjs',
  'test-clean-state.mjs',
  'test-weekly-report.mjs',
  'test-auto-voice.mjs',
  'test-auto-sticker.mjs',
  'test-voice-minimax.mjs',
  'test-stickers.mjs',
  'test-preset-local-tools.mjs',
  'test-hardening.mjs',
  'test-send-image.mjs',
  'test-media-index.mjs',
  'test-inline-media.mjs',
  'test-reminder-nudge.mjs',
  'test-cost-guard.mjs',
  'test-health.mjs',
]);

/** 要盯的计划任务。名字必须与 Get-ScheduledTask 里的完全一致。 */
export const EXPECTED_TASKS = Object.freeze([
  'DSH QQ Bot Start',
  'DSH Mobile Bridge',
  'DSH Daily Brief',
  'DSH Daily Backup',
  'DSH Weekly Report',
  'DSH Health Probe',
  'DSH Nightly Memory',
]);

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 配置容错：手改坏值回落默认，绝不抛错（doctor 自己不能因为配置写错而崩）。 */
export function normalizeDoctorConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DOCTOR_DEFAULTS };
  const limit = Number(src.historyLimit);
  if (Number.isFinite(limit) && limit >= 1 && limit <= 100) out.historyLimit = Math.round(limit);
  return out;
}

/**
 * 组装一项 check。ok 只认 true（见文件头第 1 条）。
 * @param {string} key
 * @param {boolean} ok
 * @param {{detail?: string|null, extra?: object|null, name?: string}} [opts]
 */
export function makeCheck(key, ok, opts = {}) {
  const name = opts.name || CHECK_LABELS[key] || String(key);
  const check = { key: String(key), name, ok: ok === true, detail: opts.detail == null ? null : String(opts.detail) };
  if (opts.extra && typeof opts.extra === 'object') check.extra = opts.extra;
  return check;
}

/**
 * checks → 报告（可直接写 state/doctor-report.json）。
 * 字段与 daily-brief 的自检行对齐：lastRunAt / lastOk / total / passed / failed[].name。
 */
export function summarizeChecks(checks, now = Date.now()) {
  const list = (Array.isArray(checks) ? checks : []).map((c) =>
    makeCheck(c?.key ?? '?', c?.ok === true, {
      name: c?.name,
      detail: c?.detail == null ? null : c.detail,
      extra: c?.extra ?? null,
    }),
  );
  const failed = list.filter((c) => !c.ok);
  return {
    lastRunAt: new Date(now).toISOString(),
    lastOk: list.length > 0 && failed.length === 0,
    total: list.length,
    passed: list.length - failed.length,
    failed: failed.map((c) => ({ key: c.key, name: c.name, detail: c.detail })),
    checks: list,
  };
}

/**
 * 自检行（每日简报里的一行）：
 *   全绿 → `🩺 自检：8/8 通过`
 *   有红 → `🩺 自检：6/8 通过 14:20（配置 voiceTts.enabled=false、手机桥 8899 无响应）`
 *
 * 没有报告（还没跑过）返回 null —— 简报少一行，不占行数也不撒谎。
 */
export function renderDoctorBriefLine(report, { maxNames = 2, detailChars = 24 } = {}) {
  if (!report || !report.lastRunAt) return null;
  const total = Number(report.total) || 0;
  const passed = Number(report.passed) || 0;
  if (!total) return null;
  if (report.lastOk !== false && passed >= total) return `🩺 自检：${total}/${total} 通过`;

  const d = new Date(report.lastRunAt);
  const stamp = Number.isFinite(d.getTime()) ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '--:--';
  const names = (Array.isArray(report.failed) ? report.failed : [])
    .map((c) => {
      if (typeof c === 'string') return c;
      const name = c?.name ?? c?.key;
      if (!name) return null;
      const detail = String(c?.detail ?? '').replace(/\s+/g, ' ').trim();
      return detail ? `${name} ${detail.slice(0, detailChars)}` : String(name);
    })
    .filter(Boolean)
    .slice(0, maxNames);
  const tail = names.length ? `（${names.join('、')}）` : '';
  return `🩺 自检：${passed}/${total} 通过 ${stamp}${tail}`;
}

/** 历史只留最近 limit 条（新的在后）。坏数据直接丢掉，不抛错。 */
export function pruneHistory(history, limit = DOCTOR_DEFAULTS.historyLimit) {
  const max = Number.isFinite(Number(limit)) && Number(limit) >= 1 ? Math.round(Number(limit)) : DOCTOR_DEFAULTS.historyLimit;
  const list = (Array.isArray(history) ? history : []).filter((h) => h && typeof h === 'object' && h.at);
  return list.slice(Math.max(0, list.length - max));
}

/** 控制台输出：一行标题 + 每项一行（✓/✗），失败项带 detail。 */
export function formatReportLines(report) {
  if (!report || !report.checks?.length) return ['自检：没有可跑的项目'];
  const d = new Date(report.lastRunAt);
  const stamp = Number.isFinite(d.getTime())
    ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    : String(report.lastRunAt);
  const head = `自检 ${stamp} · ${report.passed}/${report.total} 通过${report.lastOk ? '' : ' ❌'}`;
  const rows = report.checks.map((c) => {
    const mark = c.ok ? '✓' : '✗';
    return `  ${mark} ${c.name}${c.detail ? `  ${c.detail}` : ''}`;
  });
  return [head, ...rows];
}
