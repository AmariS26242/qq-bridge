// 备份（代码保险箱）的纯逻辑：配置归一、路径匹配、保留策略、简报行渲染。
// 这里不碰文件系统 —— 所有 I/O 在 scripts/backup.mjs，本模块可以离线单测。

/** 默认策略。config.json 的 backup 段只是覆盖这里的字段。 */
export const BACKUP_DEFAULTS = Object.freeze({
  enabled: true,
  at: '03:10',
  // 每个源：root 目录 + 该目录下要收的路径（'.' = 整个目录）。
  // label 会成为 zip 里的顶层目录名，恢复时一眼看得出文件本来在哪。
  sources: Object.freeze([
    Object.freeze({ root: 'qq-bridge', label: 'qq-bridge', paths: Object.freeze(['src', 'scripts', 'config.json', 'public', 'docs']) }),
    Object.freeze({ root: '~/.dsh/profiles/desktop', label: 'dsh-profile-desktop', paths: Object.freeze(['cordis.patch.yml']) }),
    Object.freeze({ root: '~/.dsh/profiles/qqbridge', label: 'dsh-profile-qqbridge', paths: Object.freeze(['cordis.patch.yml']) }),
    Object.freeze({ root: 'memory-index', label: 'memory-index', paths: Object.freeze(['*.py']) }),
    Object.freeze({ root: '项目计划', label: '项目计划', paths: Object.freeze(['.']) }),
  ]),
  // 相对各源 root 的排除项；不含 '/' 的模式匹配任意一段路径名。
  exclude: Object.freeze([
    'node_modules', '.git', '.snapshots', 'state', 'tmp', 'dist', '__pycache__',
    '*.log',
    '*.bak', '*.bak-*', 'config.json.bak*',
    '*.zip', '*.tmp', 'tmp-*.mjs', 'tmp_*.mjs', '.venv', '.venv-*',
  ]),
  targets: Object.freeze(['C:\\.snapshots', 'E:\\DSH-Backup', '%USERPROFILE%\\OneDrive\\DSH-Backup']),
  retention: Object.freeze({ daily: 7, weekly: 4 }),
  drill: Object.freeze({ enabled: true, everyDays: 30, sampleFiles: 40 }),
});

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function posInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** 保留份数下限 1：写 0 等于「每次备份后把历史全清掉」，这种配置按笔误处理。 */
function keepAtLeastOne(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.max(1, Math.floor(n));
}

/**
 * 把 config.json 里可能写了一半/写错的 backup 段补成完整策略。
 * 坏字段回退默认值而不是抛错：备份任务宁可跑默认策略，也不能因为配置笔误整夜不备份。
 */
export function normalizeBackupConfig(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const d = BACKUP_DEFAULTS;

  const sources = (Array.isArray(input.sources) ? input.sources : d.sources)
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const root = str(s.root);
      if (!root) return null;
      const paths = (Array.isArray(s.paths) && s.paths.length ? s.paths : ['.'])
        .map((p) => str(p, '.'))
        .filter(Boolean);
      return { root, label: str(s.label, root.split(/[\\/]/).pop() || 'root'), paths };
    })
    .filter(Boolean);

  const targets = (Array.isArray(input.targets) ? input.targets : d.targets)
    .map((t) => str(t))
    .filter(Boolean);
  // 去重，但保留顺序（C: 快盘 → E: 同机异盘 → OneDrive 异地）。
  const seen = new Set();
  const uniqueTargets = targets.filter((t) => {
    const key = t.toLowerCase().replace(/[\\/]+$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const retention = input.retention && typeof input.retention === 'object' ? input.retention : {};
  const drill = input.drill && typeof input.drill === 'object' ? input.drill : {};

  return {
    enabled: input.enabled !== false,
    at: str(input.at, d.at),
    sources: sources.length ? sources : d.sources.map((s) => ({ ...s, paths: [...s.paths] })),
    exclude: (Array.isArray(input.exclude) ? input.exclude : d.exclude).map((p) => str(p)).filter(Boolean),
    targets: uniqueTargets.length ? uniqueTargets : [...d.targets],
    retention: {
      daily: keepAtLeastOne(retention.daily, d.retention.daily),
      weekly: keepAtLeastOne(retention.weekly, d.retention.weekly),
    },
    drill: {
      enabled: drill.enabled !== false,
      everyDays: Math.max(1, posInt(drill.everyDays, d.drill.everyDays)),
      sampleFiles: Math.max(1, posInt(drill.sampleFiles, d.drill.sampleFiles)),
    },
  };
}

// ── 路径匹配 ────────────────────────────────────────────────────────────────
const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/** glob → 正则源码。`**` 跨目录，`*` 不跨 `/`，`?` 单字符。 */
export function globSource(pattern) {
  const p = String(pattern ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  let out = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i += 1;
        if (p[i + 1] === '/') i += 1; // `**/x` 也要匹配顶层的 `x`
        out += '.*';
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(REGEX_SPECIALS, '\\$&');
    }
  }
  return out;
}

function compilePattern(pattern) {
  const p = String(pattern ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!p) return null;
  return {
    // 含 '/' 的模式整体锚定；不含的按「任意一段路径名」匹配（`node_modules`、`*.log`）。
    anchored: p.includes('/'),
    re: new RegExp(`^${globSource(p)}$`),
  };
}

/**
 * 造一个排除器：入参是相对源 root 的 posix 路径。
 * @returns {(relPath: string) => boolean}
 */
export function makeExcluder(patterns = []) {
  const compiled = patterns.map(compilePattern).filter(Boolean);
  return (relPath) => {
    const p = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!p) return false;
    const segments = p.split('/');
    return compiled.some(({ anchored, re }) => {
      if (anchored) return re.test(p);
      return segments.some((s) => re.test(s));
    });
  };
}

/**
 * 造一个包含判定器：源配置里 paths 的语义（'.' = 全部）。
 *
 * 三种模式分开处理，否则「`cordis.patch.yml`」会把 `~/.dsh/profiles/desktop/.backup-20261015/`
 * 里同名的历史副本也捞进来（实测过）：
 *   * 无通配、无 '/'（`src` / `config.json`）：按路径前缀匹配，`src/a/b.mjs` 命中 `src`；
 *   * 有通配、无 '/'（`*.py`）：只匹配顶层名字，不跨目录；
 *   * 含 '/'（`docs/*.md`）：整体 glob。
 * @returns {(relPath: string) => boolean}
 */
export function makeIncluder(paths = ['.']) {
  const list = (Array.isArray(paths) ? paths : ['.']).map((p) => str(p, '.'));
  if (!list.length || list.includes('.')) {
    // `.` 与其它模式混写时，`.` 让其它模式失去意义 —— 按「全收」处理，排除项仍然生效。
    return () => true;
  }
  const rules = list.map((raw) => {
    const clean = String(raw).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return {
      raw: clean,
      hasGlob: /[*?]/.test(clean),
      anchored: clean.includes('/'),
      re: new RegExp(`^${globSource(clean)}$`),
    };
  });
  return (relPath) => {
    const p = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!p) return false;
    return rules.some(({ raw, hasGlob, anchored, re }) => {
      if (!hasGlob) return p === raw || p.startsWith(`${raw}/`);
      if (anchored) return re.test(p);
      if (p.includes('/')) return false;
      return re.test(p);
    });
  };
}

// ── 快照文件名与保留策略 ────────────────────────────────────────────────────
const NAME_RE = /^qbbridge_(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:_.*)?\.zip$/i;

/** `qbbridge_20261024-031000.zip` → Date；不合规的名字返回 null（手动放的包不会被自动删）。 */
export function parseSnapshotName(name) {
  const m = NAME_RE.exec(String(name ?? ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(date.getTime()) ? date : null;
}

export function snapshotName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `qbbridge_${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.zip`;
}

/** ISO 周键 `2026-W43`：跨年的第 1 周按 ISO 规则算到上一年的最后一周，避免 12/31 与 1/1 被拆成两周。 */
export function isoWeekKey(input) {
  const d = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  if (!Number.isFinite(d.getTime())) return '';
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (t.getDay() + 6) % 7;          // 周一 = 0
  t.setDate(t.getDate() - day + 3);          // 挪到该周周四
  const firstThursday = new Date(t.getFullYear(), 0, 4);
  const fday = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - fday + 3);
  const week = 1 + Math.round((t - firstThursday) / (7 * 24 * 3600 * 1000));
  return `${t.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * 保留策略：最新的 daily 份全留；再往前每个「周」只留最新的一份，最多留 weekly 个周。
 * 返回需要删除的文件名（不含路径）。
 * @param {string[]} names
 * @param {{daily?: number, weekly?: number}} retention
 */
export function planPrune(names = [], retention = {}) {
  const daily = posInt(retention.daily, BACKUP_DEFAULTS.retention.daily);
  const weekly = posInt(retention.weekly, BACKUP_DEFAULTS.retention.weekly);

  const items = (Array.isArray(names) ? names : [])
    .map((name) => ({ name, date: parseSnapshotName(name) }))
    .filter((it) => it.date)
    .sort((a, b) => b.date - a.date);

  const keep = new Set(items.slice(0, daily).map((it) => it.name));
  const weeks = [];
  for (const it of items.slice(daily)) {
    const key = isoWeekKey(it.date);
    if (weeks.includes(key)) continue;
    if (weeks.length >= weekly) break;
    weeks.push(key);
    keep.add(it.name);
  }
  return items.filter((it) => !keep.has(it.name)).map((it) => it.name);
}

// ── 展示 ────────────────────────────────────────────────────────────────────
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[idx]}`;
}

const pad2 = (n) => String(n).padStart(2, '0');

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 简报里的备份行。要求格式：`💾 备份：今天 03:10 成功（24 份 / 1.2 GB）`
 * 「份」= 本次快照收录的文件数，「/ 1.2 GB」= 三处目标合计占用。
 */
export function renderBackupBriefLine(state, { now = new Date() } = {}) {
  if (!state || !state.lastRunAt) return null;
  const at = new Date(state.lastRunAt);
  if (!Number.isFinite(at.getTime())) return null;
  const stamp = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const dayLabel = sameLocalDay(at, now) ? '今天' : `${pad2(at.getMonth() + 1)}/${pad2(at.getDate())}`;

  if (state.lastOk === false) {
    return `💾 备份：${dayLabel} ${stamp} 失败（${clip(state.lastError || '原因未知', 48)}）`;
  }
  const files = Number(state.fileCount) || 0;
  const size = Number(state.totalBytes) || 0;
  const stale = (now.getTime() - at.getTime()) / 36e5 > 36;
  if (stale) {
    const days = Math.floor((now.getTime() - at.getTime()) / 864e5);
    return `💾 备份：上次 ${days} 天前（${stamp}）· 已超时未跑`;
  }
  return `💾 备份：${dayLabel} ${stamp} 成功（${files} 份 / ${formatBytes(size)}）`;
}
