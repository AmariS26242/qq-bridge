import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(HERE, '..');
const DEFAULT_EA2_ROOT = path.resolve(BRIDGE_ROOT, '../../../ChatGPT/QQ');
const HASH = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function dateKey(at = Date.now()) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function resolvePath(value, fallback) {
  const text = String(value ?? '').trim();
  return text ? (path.isAbsolute(text) ? text : path.resolve(BRIDGE_ROOT, text)) : fallback;
}

function emptyMetrics() {
  return {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    totals: { events: 0, duplicates: 0, failures: 0, platformActions: 0, rawTextPersisted: false },
    latencyMs: [],
    strategyCounts: {},
    affectLabelCounts: {},
    contextHashCounts: {},
    failuresByCode: {},
    retrieval: { comparisons: 0, jaccardSum: 0, overlapCount: 0, addedCount: 0, removedCount: 0 },
    daily: {}
  };
}

function loadMetrics(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.totals) return emptyMetrics();
    return {
      ...emptyMetrics(),
      ...parsed,
      totals: { ...emptyMetrics().totals, ...(parsed.totals ?? {}) },
      strategyCounts: { ...(parsed.strategyCounts ?? {}) },
      affectLabelCounts: { ...(parsed.affectLabelCounts ?? {}) },
      contextHashCounts: { ...(parsed.contextHashCounts ?? {}) },
      failuresByCode: { ...(parsed.failuresByCode ?? {}) },
      retrieval: { ...emptyMetrics().retrieval, ...(parsed.retrieval ?? {}) },
      daily: { ...(parsed.daily ?? {}) },
      latencyMs: Array.isArray(parsed.latencyMs) ? parsed.latencyMs.filter((n) => Number.isFinite(n)).slice(-10000) : []
    };
  } catch {
    return emptyMetrics();
  }
}

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(3));
}

function safeErrorCode(error) {
  const raw = String(error?.code ?? error?.message ?? error ?? 'EA2_SHADOW_FAILED');
  return raw.replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 120) || 'EA2_SHADOW_FAILED';
}

function increment(map, key, amount = 1) {
  const k = String(key || 'unknown');
  map[k] = (map[k] ?? 0) + amount;
}

export class Ea2ShadowBridge {
  constructor(config = {}, { log = () => {} } = {}) {
    this.config = config && typeof config === 'object' ? config : {};
    const configuredDays = Number(this.config.observationDays);
    this.observationDays = Number.isFinite(configuredDays) ? Math.min(31, Math.max(1, Math.trunc(configuredDays))) : 3;
    this.log = log;
    this.store = null;
    this.adapter = null;
    this.initPromise = null;
    this.initErrorLogged = false;
    this.lastInitError = null;
    this.metricsFile = resolvePath(this.config.metricsFile, path.join(BRIDGE_ROOT, 'state', 'ea2-shadow-metrics.json'));
    this.metrics = loadMetrics(this.metricsFile);
  }

  enabled() {
    const mode = String(this.config.mode ?? 'off');
    return this.config.enabled === true && (mode === 'shadow' || mode === 'advisory');
  }

  mode() {
    return this.enabled() ? String(this.config.mode) : 'off';
  }

  async ensure() {
    if (this.adapter) return this.adapter;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const projectDir = resolvePath(this.config.projectDir, DEFAULT_EA2_ROOT);
      const entry = path.join(projectDir, 'dist', 'src', 'index.js');
      if (!fs.existsSync(entry)) throw new Error(`EA2_CORE_NOT_BUILT:${entry}`);
      const core = await import(pathToFileURL(entry).href);
      const dbPath = resolvePath(this.config.dbPath, path.join(BRIDGE_ROOT, 'state', 'ea2-shadow.sqlite'));
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      this.store = new core.SqliteStore(dbPath);
      const runtime = new core.AgentRuntime(this.store, new core.SystemClock(), new core.LocalPolicy());
      this.adapter = new core.QQShadowAdapter(runtime, this.store, this.mode());
      this.lastInitError = null;
      this.initErrorLogged = false;
      this.log(`[ea2-shadow] 已启用 mode=${this.mode()} db=${path.basename(dbPath)}`);
      return this.adapter;
    })().catch((error) => {
      this.initPromise = null;
      this.lastInitError = safeErrorCode(error);
      if (!this.initErrorLogged) {
        this.initErrorLogged = true;
        this.log(`[ea2-shadow] 初始化失败（旁路已停用）：${error?.message ?? error}`);
      }
      throw error;
    });
    return this.initPromise;
  }

  async observe(input, { kind, id, sessionId } = {}) {
    if (!this.enabled()) return { skipped: true, mode: 'off' };
    const started = performance.now();
    const now = Date.now();
    const day = dateKey(now);
    const daily = this.metrics.daily[day] ?? { events: 0, duplicates: 0, failures: 0 };
    this.metrics.daily[day] = daily;
    try {
      const adapter = await this.ensure();
      const contextHash = HASH(`qq:${kind}:${id}`).slice(0, 20);
      const scopeId = String(this.config.scopeId || 'qq-shadow');
      const agentId = String(this.config.agentId || 'ea2');
      const address = { scopeId, agentId, contextId: `qq:${contextHash}` };
      const result = await adapter.observe(input, address, sessionId || `qq-shadow:${contextHash}`);
      const elapsed = performance.now() - started;
      this.metrics.totals.events += 1;
      daily.events += 1;
      this.metrics.latencyMs.push(elapsed);
      if (this.metrics.latencyMs.length > 10000) this.metrics.latencyMs.splice(0, this.metrics.latencyMs.length - 10000);
      increment(this.metrics.contextHashCounts, contextHash);
      increment(this.metrics.strategyCounts, result.observation.strategy);
      increment(this.metrics.affectLabelCounts, result.observation.affectLabel);
      if (result.observation.duplicate) { this.metrics.totals.duplicates += 1; daily.duplicates += 1; }
      this.persist();
      return { skipped: false, result, latencyMs: elapsed };
    } catch (error) {
      this.metrics.totals.failures += 1;
      daily.failures += 1;
      increment(this.metrics.failuresByCode, safeErrorCode(error));
      this.persist();
      this.log(`[ea2-shadow] 事件旁路失败 kind=${kind ?? '?'}：${error?.message ?? error}`);
      return { skipped: false, error: safeErrorCode(error) };
    }
  }

  async compare(input, { kind, id, legacyIds = [], sessionId } = {}) {
    if (!this.enabled()) return { skipped: true, mode: 'off' };
    try {
      const adapter = await this.ensure();
      const contextHash = HASH(`qq:${kind}:${id}`).slice(0, 20);
      const address = { scopeId: String(this.config.scopeId || 'qq-shadow'), agentId: String(this.config.agentId || 'ea2'), contextId: `qq:${contextHash}` };
      const comparison = await adapter.compare(input, address, legacyIds, sessionId || `qq-shadow:${contextHash}`);
      const r = this.metrics.retrieval;
      r.comparisons += 1;
      r.jaccardSum += Number(comparison.jaccard) || 0;
      r.overlapCount += comparison.overlapIds.length;
      r.addedCount += comparison.addedIds.length;
      r.removedCount += comparison.removedIds.length;
      this.persist();
      return { skipped: false, comparison };
    } catch (error) {
      this.log(`[ea2-shadow] 检索比较失败 kind=${kind ?? '?'}：${error?.message ?? error}`);
      return { skipped: false, error: safeErrorCode(error) };
    }
  }

  persist() {
    this.metrics.updatedAt = new Date().toISOString();
    try {
      fs.mkdirSync(path.dirname(this.metricsFile), { recursive: true });
      const tmp = `${this.metricsFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.metrics, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.metricsFile);
    } catch (error) {
      this.log(`[ea2-shadow] 指标落盘失败：${error?.message ?? error}`);
    }
  }

  snapshot() {
    const totals = this.metrics.totals;
    const latencies = this.metrics.latencyMs;
    const retrieval = this.metrics.retrieval;
    const startedMs = Date.parse(this.metrics.startedAt);
    const windowEndsAt = Number.isFinite(startedMs) ? new Date(startedMs + this.observationDays * 86400000).toISOString() : null;
    return {
      enabled: this.enabled(),
      mode: this.mode(),
      ready: Boolean(this.adapter),
      initializationError: this.lastInitError,
      observationDays: this.observationDays,
      startedAt: this.metrics.startedAt,
      updatedAt: this.metrics.updatedAt,
      windowEndsAt,
      windowComplete: Boolean(windowEndsAt && Date.now() >= Date.parse(windowEndsAt)),
      events: totals.events,
      duplicates: totals.duplicates,
      duplicateRate: totals.events ? Number((totals.duplicates / totals.events).toFixed(6)) : 0,
      failures: totals.failures,
      failureRate: totals.events + totals.failures ? Number((totals.failures / (totals.events + totals.failures)).toFixed(6)) : 0,
      latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: percentile(latencies, 0.999) },
      strategyCounts: { ...this.metrics.strategyCounts },
      affectLabelCounts: { ...this.metrics.affectLabelCounts },
      contextCount: Object.keys(this.metrics.contextHashCounts).length,
      retrieval: {
        comparisons: retrieval.comparisons,
        jaccard: retrieval.comparisons ? Number((retrieval.jaccardSum / retrieval.comparisons).toFixed(6)) : 0,
        overlapCount: retrieval.overlapCount,
        addedCount: retrieval.addedCount,
        removedCount: retrieval.removedCount
      },
      platformActions: 0,
      rawTextPersisted: false,
      failuresByCode: { ...this.metrics.failuresByCode }
    };
  }

  close() {
    try { this.store?.close(); } catch {}
    this.store = null;
    this.adapter = null;
    this.initPromise = null;
  }
}
