/**
 * 磁盘卫生的「纯逻辑」部分：把 state 里的文件分成三档，决定谁该删。
 *
 * 三档口径（跟 项目计划/07-候选项目清单.md ② 一致）：
 *   - keep  必需：删了 bot 会丢记忆/配置/令牌，或简报读不到数据 —— 永不删。
 *   - cache 可再生成：表情库缓存、合成语音、临时目录 —— 超过 cacheDays 天才删。
 *   - junk  垃圾：一次性截图、轮转出来的 *.log.1、pip 的临时落盘 —— 超过 junkDays 天才删。
 *
 * 判定顺序是 keep → junk → cache，越靠前越「不能碰」；命中但还没到天数的一律跳过，
 * 并照样列出来（dry 清单要能解释「为什么这个没删」）。
 *
 * 这里没有 fs / 时钟：调用方把 [{ path, mtime, size }] 递进来，自己传 now。
 * 这样 rules 能单测，删东西的那一侧（scripts/clean-state.mjs）才短到看得完。
 */

/** 必需清单之外，任何 *.json / *.jsonl 都算必需：state 根下的结构化文件都是运行态数据。 */
export const CLEAN_DEFAULTS = Object.freeze({
  enabled: true,
  stateDir: 'state',
  junkDays: 3,
  cacheDays: 7,
  keep: Object.freeze([
    'state/*.json',
    'state/*.jsonl',
    'state/*.token',
    'state/console-token',
    'state/minimax-key',
    'state/diary/**',
    'state/profile-agent/**',
  ]),
  junk: Object.freeze([
    // 一次性截图（dashboard/面板截图，人看完就没用了）
    'state/*.png',
    'state/*.jpg',
    // 轮转产物：bridge.log.1 / tool-calls.jsonl.1 / token-usage.jsonl.2 …
    'state/*.log.[0-9]*',
    'state/*.jsonl.[0-9]*',
    // pip 被错误地以 state 为临时目录时留下的空壳
    'state/desk-inbox/pip-*', 'state/desk-inbox/pip-*/**',
    'state/desk-inbox/tmp*', 'state/desk-inbox/tmp*/**',
    'state/pw-tmp/**',
    'state/tmp-sampling-check/**',
  ]),
  cache: Object.freeze([
    'state/tmp/**',
    // 发出去的语音：生成一次用一次，超期即可清（发的时候会重新合成）
    'audio/*.wav',
    'audio/*.mp3',
    'audio/*.ogg',
  ]),
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 简易段级 glob：`*` 不跨 `/`，`**` 跨段，`?` 单字符，`[0-9]` 字符类。
 * 故意不引第三方库：规则要能被复盘，而不是藏在 minimatch 的选项里。
 */
export function globToRegExp(glob) {
  const src = String(glob || '').replace(/\\/g, '/').trim();
  let out = '^';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '*') {
      if (src[i + 1] === '*') {
        // `**/` 吃掉任意层目录（含零层），`**` 结尾则匹配剩余全部
        if (src[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[') {
      const end = src.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
      } else {
        out += `[${src.slice(i + 1, end)}]`;
        i = end;
      }
    } else {
      out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

function matchesAny(relPath, globs) {
  for (const g of globs || []) {
    if (globToRegExp(g).test(relPath)) return g;
  }
  return null;
}

/** 配置容错：天数写坏就回默认，规则数组写坏就用默认数组，别让一个笔误让清理停摆。 */
export function normalizeCleanConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const days = (v, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return dflt;
    return Math.round(n);
  };
  const list = (v, dflt) =>
    Array.isArray(v) && v.length ? v.filter((x) => typeof x === 'string' && x.trim()) : [...dflt];
  return {
    enabled: cfg.enabled !== false,
    stateDir: typeof cfg.stateDir === 'string' && cfg.stateDir.trim() ? cfg.stateDir.trim() : CLEAN_DEFAULTS.stateDir,
    junkDays: days(cfg.junkDays, CLEAN_DEFAULTS.junkDays),
    cacheDays: days(cfg.cacheDays, CLEAN_DEFAULTS.cacheDays),
    keep: list(cfg.keep, CLEAN_DEFAULTS.keep),
    junk: list(cfg.junk, CLEAN_DEFAULTS.junk),
    cache: list(cfg.cache, CLEAN_DEFAULTS.cache),
  };
}

/**
 * 单个文件的归档判定。
 * 返回 { tier: 'keep'|'junk'|'cache'|'other', matched, ageDays, reason }。
 * `other` = 三档都没命中，不动（保守：没规则就不删）。
 */
export function classifyFile(relPath, policy, { now = Date.now(), mtime = 0 } = {}) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const p = policy || CLEAN_DEFAULTS;
  const at = Number(mtime) || 0;
  const ageDays = at ? Math.max(0, (Number(now) - at) / DAY_MS) : Infinity;
  const keepHit = matchesAny(rel, p.keep);
  if (keepHit) return { tier: 'keep', matched: keepHit, ageDays, reason: '必需文件，永不清理' };
  const junkHit = matchesAny(rel, p.junk);
  if (junkHit) return { tier: 'junk', matched: junkHit, ageDays, reason: `垃圾（${p.junkDays} 天前）` };
  const cacheHit = matchesAny(rel, p.cache);
  if (cacheHit) return { tier: 'cache', matched: cacheHit, ageDays, reason: `缓存（${p.cacheDays} 天前）` };
  return { tier: 'other', matched: null, ageDays, reason: '没有规则命中，保守不动' };
}

/** 到天数了才删；没到天数列进 skipped，dry 清单里也照样能看到。 */
export function isExpired(cls, policy) {
  const p = policy || CLEAN_DEFAULTS;
  if (cls.tier === 'junk') return cls.ageDays >= p.junkDays;
  if (cls.tier === 'cache') return cls.ageDays >= p.cacheDays;
  return false;
}

/**
 * 出计划，不删任何东西。
 * files: [{ path, mtime, size }]（path 相对 stateDir，正斜杠即可）
 * 返回 { actions, skipped, totals, freedBytes, keptBytes, stateBytes, fileCount, byTier }
 */
export function planClean(files, policy, { now = Date.now() } = {}) {
  const p = policy || CLEAN_DEFAULTS;
  const actions = [];
  const skipped = [];
  const byTier = {
    keep: { count: 0, bytes: 0 },
    junk: { count: 0, bytes: 0 },
    cache: { count: 0, bytes: 0 },
    other: { count: 0, bytes: 0 },
  };
  let stateBytes = 0;
  let keptBytes = 0;
  let fileCount = 0;

  for (const f of Array.isArray(files) ? files : []) {
    const size = Math.max(0, Number(f?.size) || 0);
    const rel = String(f?.path || '');
    if (!rel) continue;
    fileCount += 1;
    stateBytes += size;
    const cls = classifyFile(rel, p, { now, mtime: f.mtime });
    const bucket = byTier[cls.tier] || byTier.other;
    bucket.count += 1;
    bucket.bytes += size;
    if (isExpired(cls, p)) {
      actions.push({ path: rel, size, tier: cls.tier, ageDays: cls.ageDays, reason: cls.reason });
    } else {
      keptBytes += size;
      if (cls.tier !== 'keep') {
        skipped.push({
          path: rel,
          size,
          tier: cls.tier,
          ageDays: cls.ageDays,
          reason: cls.tier === 'other' ? cls.reason : `未满 ${cls.tier === 'junk' ? p.junkDays : p.cacheDays} 天`,
        });
      }
    }
  }

  actions.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  const freedBytes = actions.reduce((s, a) => s + a.size, 0);
  return {
    at: new Date(Number(now)).toISOString(),
    actions,
    skipped,
    byTier,
    freedBytes,
    keptBytes,
    stateBytes,
    fileCount,
    actionCount: actions.length,
  };
}

/** 1.5 MB / 940 KB / 512 B；负数与非数字统一 `—`。 */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10240 ? 1 : 0)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(v < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * dry 清单：按档分组，每组最多 maxPerTier 行（默认 8），其余折叠成 `… 还有 N 个`。
 * 不打印 keep（那个只是「确认没碰」），但保留合计。
 */
export function formatDryList(plan, { maxPerTier = 8 } = {}) {
  const p = plan || {};
  const lines = [];
  const head = `磁盘卫生 · state ${formatBytes(p.stateBytes)} / ${p.fileCount ?? 0} 个文件`;
  lines.push(head);
  const groups = [
    ['junk', '垃圾', '🗑'],
    ['cache', '缓存', '♻️'],
  ];
  for (const [tier, label, icon] of groups) {
    const items = (p.actions || []).filter((a) => a.tier === tier);
    if (!items.length) continue;
    const bytes = items.reduce((s, a) => s + a.size, 0);
    lines.push(`${icon} ${label}：${items.length} 个 / ${formatBytes(bytes)}`);
    for (const a of items.slice(0, maxPerTier)) {
      lines.push(`   ${formatBytes(a.size).padStart(9)}  ${a.path}`);
    }
    if (items.length > maxPerTier) lines.push(`   … 还有 ${items.length - maxPerTier} 个`);
  }
  if (!p.actions || !p.actions.length) lines.push('✓ 没有该清的东西');
  else lines.push(`合计可清 ${formatBytes(p.freedBytes)}（清完约 ${formatBytes(Math.max(0, (p.stateBytes || 0) - (p.freedBytes || 0)))}）`);
  const keepN = p.byTier?.keep?.count || 0;
  const keepB = p.byTier?.keep?.bytes || 0;
  if (keepN) lines.push(`🔒 必需 ${keepN} 个 / ${formatBytes(keepB)}（不动）`);
  const skippedN = (p.skipped || []).length;
  if (skippedN) lines.push(`⏳ 未到天数 ${skippedN} 个（dry 已跳过）`);
  return lines;
}

/**
 * 简报里那一行（项目计划 ②「每周由简报附带一行」）。
 * 显示 state 现值 + 上次真删释放了多少；从没 apply 过就说「未清理」，不编数字。
 */
export function renderCleanBriefLine(state, { now = Date.now() } = {}) {
  if (!state || typeof state !== 'object') return null;
  const size = Number(state.stateBytes);
  if (!Number.isFinite(size) || size < 0) return null;
  const lastAt = Number(new Date(state.lastApplyAt || 0));
  const lastFreed = Number(state.lastFreedBytes);
  if (!Number.isFinite(lastAt) || lastAt <= 0) {
    return `🗑 清理：state ${formatBytes(size)}（还没清理过）`;
  }
  const d = new Date(lastAt);
  const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  if (!Number.isFinite(lastFreed) || lastFreed <= 0) {
    return `🗑 清理：state ${formatBytes(size)}（${stamp} 清理过，没东西可删）`;
  }
  return `🗑 清理：state ${formatBytes(size)}（${stamp} 清出 ${formatBytes(lastFreed)}）`;
}
