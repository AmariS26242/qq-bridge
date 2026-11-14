/**
 * project-read 独立 Host Token 生命周期、HTTP 边界校验与 HMAC-before-Nonce 防重放引擎。
 *
 * 安全设计要点：
 * 1. Step 1 只做传输格式、Header 长度/字符集、原始 Body 字节上限、时间戳窗口预检（不做 JSON.parse / Schema 解析）。
 * 2. Step 2 常量时间 HMAC-SHA256 验证（失败绝不触碰 Nonce 缓存，防 2000+ 洪泛占满防重放窗口）。
 * 3. Step 3 & 4 同步原子 Nonce 查重并占用（消除并发重复请求竞态）。
 * 4. Step 5 在 HMAC + Nonce 全部验过之后，再执行 JSON.parse、原型污染防御、Strict Schema 与字段长度校验。
 * 5. Step 6 结合 Bridge 实时态核验：feature enabled、ownerQQ 已设置、仅管理员私聊、仅 reserved2 + qq-chat-v2。
 * 6. Bridge 每次启动无条件生成全新 keyId + 256-bit secret，从不沿用重启前旧密钥。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hardenFile, verifyRestrictedAcl } from './state-acl.mjs';

export const PROJECT_READ_ENDPOINT = '/api/project-read';
export const MAX_PROJECT_READ_BODY_BYTES = 16 * 1024; // 16 KB
export const MAX_HEADER_VALUE_LEN = 256;
export const MAX_PROJECT_NAME_LEN = 64;
export const MAX_VIRTUAL_PATH_LEN = 260;
export const MAX_QUERY_LEN = 128;
export const MAX_LINE_NUMBER = 1_000_000;

export const ALLOWED_BODY_KEYS = new Set([
  'action',
  'project',
  'path',
  'startLine',
  'endLine',
  'query',
  'caseSensitive',
]);

export const FORBIDDEN_IDENTITY_KEYS = new Set([
  'key',
  'token',
  'sessionId',
  'session',
  'hostToken',
  'secret',
  'adminKey',
  'ownerQQ',
  'regex',
  '__proto__',
  'constructor',
  'prototype',
]);

export const ALLOWED_ACTIONS = new Set(['tree', 'read', 'search']);

export class ProjectReadAuthError extends Error {
  constructor(status, code, message, detail = undefined) {
    super(message);
    this.name = 'ProjectReadAuthError';
    this.status = status;
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

export function buildCanonicalString({ method, urlPath, ts, nonce, sessionId, rawBody }) {
  return `${method}\n${urlPath}\n${ts}\n${nonce}\n${sessionId}\n${sha256Hex(rawBody)}`;
}

/**
 * 宿主插件侧签名 helper（仅使用实时读取到的 Host Token 凭据构造请求，绝不缓存在静态配置中）。
 */
export function signProjectReadRequest({
  tokenCreds,
  sessionId,
  bodyObj,
  ts = Date.now(),
  nonce = crypto.randomBytes(16).toString('hex'),
  urlPath = PROJECT_READ_ENDPOINT,
}) {
  if (!tokenCreds?.keyId || !tokenCreds?.secret) {
    throw new ProjectReadAuthError(503, 'TOKEN_UNAVAILABLE', 'Host token credentials are unavailable');
  }
  const rawBody = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  const canonical = buildCanonicalString({
    method: 'POST',
    urlPath,
    ts: String(ts),
    nonce,
    sessionId,
    rawBody,
  });
  const sig = crypto.createHmac('sha256', tokenCreds.secret).update(canonical, 'utf8').digest('hex');
  return {
    method: 'POST',
    urlPath,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-project-read-session': sessionId,
      'x-project-read-key-id': tokenCreds.keyId,
      'x-project-read-timestamp': String(ts),
      'x-project-read-nonce': nonce,
      'x-project-read-signature': sig,
    },
    rawBody,
  };
}

function isStrictAbsoluteWinOrPosixPath(p) {
  if (typeof p !== 'string' || p.trim() === '') return false;
  if (p.includes('\0')) return false;
  if (process.platform === 'win32') {
    if (p.startsWith('\\\\')) return false; // 拒绝 UNC
    return /^[A-Za-z]:\\/.test(path.win32.normalize(p));
  }
  return path.isAbsolute(p);
}

/**
 * 规范化 `config.json` 中的 `projectRead` 段。
 * 默认关闭（enabled: false）。
 * 严禁静默回退根目录：每个允许的项目必须显式声明 `expectedRootPath`，
 * 否则在启用校验时直接抛出显式配置错误。
 */
export function normalizeProjectReadConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const enabled = src.enabled === true;
  const maxBodyBytes = clampInt(src.maxBodyBytes, 1024, 65536, MAX_PROJECT_READ_BODY_BYTES);
  const timestampSkewMs = clampInt(src.timestampSkewMs, 5000, 120000, 30_000);
  const nonceTtlMs = clampInt(src.nonceTtlMs, 10000, 300000, 60_000);
  const maxNonces = clampInt(src.maxNonces, 50, 20000, 2000);

  const projects = {};
  const rawProjects = src.projects && typeof src.projects === 'object' && !Array.isArray(src.projects)
    ? src.projects
    : {};

  for (const [name, entry] of Object.entries(rawProjects)) {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
      throw new Error(`projectRead.projects.${name}: 非法项目名`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`projectRead.projects.${name}: 项目配置必须是对象`);
    }
    const explicitExpected = typeof entry.expectedRootPath === 'string' ? entry.expectedRootPath.trim() : '';
    // 安全硬约束：统一配置字段名为 expectedRootPath，禁止缺省时静默回退到 cwd / 仓库目录
    if (!explicitExpected) {
      throw new Error(`projectRead.projects.${name}: 必须显式配置 expectedRootPath，禁止静默回退`);
    }
    if (!isStrictAbsoluteWinOrPosixPath(explicitExpected)) {
      throw new Error(`projectRead.projects.${name}: expectedRootPath 必须是本机绝对路径（禁止相对路径与 UNC）`);
    }
    const resolvedExpected = path.resolve(explicitExpected);
    projects[name] = {
      name,
      enabled: entry.enabled !== false,
      rootPath: resolvedExpected,
      expectedRootPath: resolvedExpected,
      denyGlobs: Array.isArray(entry.denyPaths) ? entry.denyPaths.map(String) : [],
      limits: {
        maxTreeEntries: clampInt(entry.maxTreeEntries, 10, 500, 200),
        maxTreeDepth: clampInt(entry.maxTreeDepth, 1, 8, 5),
        maxReadBytes: clampInt(entry.maxReadBytes, 1024, 131072, 65536),
        maxOutputBytes: clampInt(entry.maxOutputBytes, 1024, 24576, 12288),
        maxReadLines: clampInt(entry.maxReadLines, 10, 400, 200),
        maxSearchFiles: clampInt(entry.maxSearchFiles, 10, 500, 150),
        maxSearchTotalBytes: clampInt(entry.maxSearchTotalBytes, 16384, 5 * 1024 * 1024, 1536 * 1024),
        maxSearchMatches: clampInt(entry.maxSearchMatches, 5, 100, 30),
      },
    };
  }

  return {
    enabled,
    maxBodyBytes,
    timestampSkewMs,
    nonceTtlMs,
    maxNonces,
    projects,
  };
}

function clampInt(val, min, max, fallback) {
  if (typeof val !== 'number' || !Number.isInteger(val)) return fallback;
  return Math.max(min, Math.min(max, val));
}

function assertBoundedHeader(raw, name, pattern, maxLen = MAX_HEADER_VALUE_LEN) {
  if (typeof raw !== 'string') {
    throw new ProjectReadAuthError(400, 'MISSING_HEADERS', `Missing required auth header: ${name}`);
  }
  const val = raw.trim();
  if (!val || val.length > maxLen) {
    throw new ProjectReadAuthError(400, 'INVALID_HEADER_LENGTH', `Header ${name} empty or exceeds limit ${maxLen}`);
  }
  if (/[\r\n\0]/.test(val)) {
    throw new ProjectReadAuthError(400, 'INVALID_HEADER_CHARS', `Header ${name} contains control characters`);
  }
  if (pattern && !pattern.test(val)) {
    throw new ProjectReadAuthError(400, 'INVALID_HEADER_FORMAT', `Header ${name} format invalid`);
  }
  return val;
}

/**
 * 在读取请求体及解析任何 JSON 前校验必须携带的认证 Header 集合与格式上界。
 */
export function validateProjectReadAuthHeaders(headers = {}) {
  const h = headers ?? {};
  const sessionId = assertBoundedHeader(h['x-project-read-session'], 'x-project-read-session', /^[A-Za-z0-9._:-]+$/, 128);
  const keyId = assertBoundedHeader(h['x-project-read-key-id'], 'x-project-read-key-id', /^[0-9a-f]{16}$/i, 16);
  const tsRaw = assertBoundedHeader(h['x-project-read-timestamp'], 'x-project-read-timestamp', /^[0-9]{10,16}$/, 16);
  const nonce = assertBoundedHeader(h['x-project-read-nonce'], 'x-project-read-nonce', /^[0-9a-f]{32,64}$/i, 64);
  const sigHex = assertBoundedHeader(h['x-project-read-signature'], 'x-project-read-signature', /^[0-9a-f]{64}$/i, 64);
  return { sessionId, keyId, tsRaw, nonce, sigHex };
}

/**
 * 严格 JSON + Schema 验证（仅允许在 HMAC 与 Nonce 验证全部通过后调用！）
 */
export function parseAndValidateRequestBody(rawBodyUtf8) {
  let parsed;
  try {
    parsed = JSON.parse(rawBodyUtf8);
  } catch {
    throw new ProjectReadAuthError(400, 'INVALID_JSON', 'Malformed JSON body');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectReadAuthError(400, 'INVALID_BODY', 'Body must be a plain JSON object');
  }
  const keys = Object.keys(parsed);
  if (keys.length === 0 || keys.length > ALLOWED_BODY_KEYS.size) {
    throw new ProjectReadAuthError(400, 'INVALID_BODY_SHAPE', 'Body key count out of bounds');
  }
  for (const k of keys) {
    if (FORBIDDEN_IDENTITY_KEYS.has(k) || !ALLOWED_BODY_KEYS.has(k)) {
      throw new ProjectReadAuthError(400, 'FORBIDDEN_PARAM', `Forbidden or unsupported parameter: ${k}`);
    }
  }
  if (typeof parsed.action !== 'string' || !ALLOWED_ACTIONS.has(parsed.action)) {
    throw new ProjectReadAuthError(400, 'INVALID_ACTION', 'action must be one of tree, read, search');
  }
  if (typeof parsed.project !== 'string' || parsed.project.length === 0 || parsed.project.length > MAX_PROJECT_NAME_LEN) {
    throw new ProjectReadAuthError(400, 'INVALID_PROJECT', `project must be a non-empty string <= ${MAX_PROJECT_NAME_LEN} chars`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(parsed.project)) {
    throw new ProjectReadAuthError(400, 'INVALID_PROJECT', 'project name contains disallowed characters');
  }

  const normalized = {
    action: parsed.action,
    project: parsed.project,
  };

  if (parsed.path !== undefined) {
    if (typeof parsed.path !== 'string' || parsed.path.length > MAX_VIRTUAL_PATH_LEN) {
      throw new ProjectReadAuthError(400, 'INVALID_PATH', `path must be a string <= ${MAX_VIRTUAL_PATH_LEN} chars`);
    }
    if (parsed.path.includes('\0') || /[\x00-\x1f]/.test(parsed.path)) {
      throw new ProjectReadAuthError(400, 'INVALID_PATH', 'path contains control characters');
    }
    normalized.path = parsed.path;
  }

  if (parsed.startLine !== undefined) {
    if (!Number.isInteger(parsed.startLine) || parsed.startLine < 1 || parsed.startLine > MAX_LINE_NUMBER) {
      throw new ProjectReadAuthError(400, 'INVALID_LINE_RANGE', 'startLine must be integer in [1, 1000000]');
    }
    normalized.startLine = parsed.startLine;
  }
  if (parsed.endLine !== undefined) {
    if (!Number.isInteger(parsed.endLine) || parsed.endLine < 1 || parsed.endLine > MAX_LINE_NUMBER) {
      throw new ProjectReadAuthError(400, 'INVALID_LINE_RANGE', 'endLine must be integer in [1, 1000000]');
    }
    if (normalized.startLine !== undefined && parsed.endLine < normalized.startLine) {
      throw new ProjectReadAuthError(400, 'INVALID_LINE_RANGE', 'endLine must be >= startLine');
    }
    normalized.endLine = parsed.endLine;
  }

  if (parsed.action === 'read' && (!normalized.path || normalized.path.length === 0)) {
    throw new ProjectReadAuthError(400, 'MISSING_PATH', 'read action requires non-empty path');
  }

  if (parsed.query !== undefined) {
    if (typeof parsed.query !== 'string' || parsed.query.length === 0 || parsed.query.length > MAX_QUERY_LEN) {
      throw new ProjectReadAuthError(400, 'INVALID_QUERY', `query must be a non-empty string <= ${MAX_QUERY_LEN} chars`);
    }
    if (/[\0\r\n]/.test(parsed.query)) {
      throw new ProjectReadAuthError(400, 'INVALID_QUERY', 'query contains forbidden control characters');
    }
    normalized.query = parsed.query;
  }
  if (parsed.action === 'search' && !normalized.query) {
    throw new ProjectReadAuthError(400, 'MISSING_QUERY', 'search action requires non-empty query');
  }

  if (parsed.caseSensitive !== undefined) {
    if (typeof parsed.caseSensitive !== 'boolean') {
      throw new ProjectReadAuthError(400, 'INVALID_PARAM', 'caseSensitive must be boolean');
    }
    normalized.caseSensitive = parsed.caseSensitive;
  }

  return normalized;
}

export class ProjectReadAuthEngine {
  constructor({
    tokenFile,
    getRuntimeState,
    timestampSkewMs = 30_000,
    nonceTtlMs = 60_000,
    maxNonces = 2000,
    maxBodyBytes = MAX_PROJECT_READ_BODY_BYTES,
    applyAcl = true,
    active = true,
    hardenFileFn = hardenFile,
    verifyAclFn = verifyRestrictedAcl,
  }) {
    this.tokenFile = tokenFile;
    this.getRuntimeState = getRuntimeState;
    this.timestampSkewMs = timestampSkewMs;
    this.nonceTtlMs = nonceTtlMs;
    this.maxNonces = maxNonces;
    this.maxBodyBytes = maxBodyBytes;
    this.applyAcl = applyAcl;
    this.hardenFileFn = hardenFileFn;
    this.verifyAclFn = verifyAclFn;
    this.lastAclWarning = null;
    this.lastAclStatus = null;
    this.nonceCache = new Map();
    this.current = null;
    this.prev = null;
    if (active) {
      this.initOnStartup();
    } else {
      this.clearTokensFromDisk();
    }
  }

  /**
   * 功能关闭时撤销内存态并清理磁盘上的 Host Token 文件，避免休眠状态保留凭据。
   */
  clearTokensFromDisk() {
    this.current = null;
    this.prev = null;
    this.nonceCache.clear();
    if (this.tokenFile && fs.existsSync(this.tokenFile)) {
      try { fs.rmSync(this.tokenFile, { force: true }); } catch {}
    }
  }

  /**
   * 每次 Bridge 启动强制铸造全新 Host Token：
   * 绝不读取磁盘旧密钥，旧签发的 Token / HMAC / Nonce 在重启后立即全部作废。
   */
  initOnStartup(extraMeta = {}) {
    this.current = {
      keyId: crypto.randomBytes(8).toString('hex'),
      secret: crypto.randomBytes(32).toString('hex'),
      createdAt: Date.now(),
    };
    this.prev = null;
    this.nonceCache.clear();
    this.persistTokenFile(extraMeta);
  }

  rotateLive(graceMs = 60_000, extraMeta = {}) {
    if (!this.current) {
      this.initOnStartup(extraMeta);
      return;
    }
    this.prev = {
      ...this.current,
      expiresAt: Date.now() + graceMs,
    };
    this.current = {
      keyId: crypto.randomBytes(8).toString('hex'),
      secret: crypto.randomBytes(32).toString('hex'),
      createdAt: Date.now(),
    };
    this.persistTokenFile(extraMeta);
  }

  persistTokenFile(extraMeta = {}) {
    const dir = path.dirname(this.tokenFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.tokenFile}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const payload = JSON.stringify({
      keyId: this.current.keyId,
      secret: this.current.secret,
      createdAt: this.current.createdAt,
      pid: process.pid,
      ...extraMeta,
    }, null, 2);
    try {
      fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.tokenFile);
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
    this.lastAclWarning = null;
    if (this.applyAcl) {
      const acl = this.hardenFileFn(this.tokenFile);
      const tokenAcl = acl?.ok
        ? this.verifyAclFn(this.tokenFile, { allowInherited: false })
        : { ok: false, reason: 'harden_failed', detail: acl?.detail ?? 'hardenFile failed' };

      if (tokenAcl?.ok) {
        this.lastAclStatus = { mode: 'token-self', tokenOk: true, parentOk: null };
        return;
      }

      // Token 自身 ACL 未达标时，实际验证父目录 state/ 是否已收紧（且 Token 自身无意外主体）作为兜底
      const parentAcl = this.verifyAclFn(dir, { allowInherited: false });
      const tokenEffectiveAcl = this.verifyAclFn(this.tokenFile, { allowInherited: true });
      if (parentAcl?.ok && tokenEffectiveAcl?.ok) {
        const detail = tokenAcl?.detail || acl?.detail || 'token ACL fell back to hardened parent directory';
        this.lastAclWarning = detail;
        this.lastAclStatus = { mode: 'parent-fallback', tokenOk: false, parentOk: true, detail };
        return;
      }

      // 两者均不满足时 Fail-Closed：删除磁盘文件并撤销内存密钥
      this.clearTokensFromDisk();
      const failDetail = [
        `tokenAcl=${tokenAcl?.reason ?? 'failed'}(${tokenAcl?.detail ?? ''})`,
        `parentAcl=${parentAcl?.reason ?? 'failed'}(${parentAcl?.detail ?? ''})`,
        `effectiveAcl=${tokenEffectiveAcl?.reason ?? 'failed'}(${tokenEffectiveAcl?.detail ?? ''})`,
      ].join('; ');
      this.lastAclStatus = {
        mode: 'fail-closed',
        tokenOk: false,
        parentOk: Boolean(parentAcl?.ok),
        detail: failDetail,
      };
      throw new ProjectReadAuthError(500, 'TOKEN_ACL_UNSAFE', `Host token ACL protection failed closed: ${failDetail}`);
    } else {
      this.lastAclStatus = { mode: 'disabled', tokenOk: null, parentOk: null };
    }
  }

  resolveSecret(keyId) {
    if (this.current && keyId === this.current.keyId) return this.current.secret;
    if (this.prev && keyId === this.prev.keyId && Date.now() <= this.prev.expiresAt) {
      return this.prev.secret;
    }
    return null;
  }

  pruneNonces(now) {
    for (const [k, exp] of this.nonceCache) {
      if (exp <= now) this.nonceCache.delete(k);
    }
  }

  async verifyAndExecute(req, executeReadFn) {
    // === Step 1: 传输格式、Header 长度、Body 字节上限、时间戳窗口（绝对不做 JSON.parse！）===
    if (!req || req.method !== 'POST' || req.urlPath !== PROJECT_READ_ENDPOINT) {
      throw new ProjectReadAuthError(400, 'INVALID_ENDPOINT', 'Invalid method or path');
    }
    if (typeof req.rawBody !== 'string') {
      throw new ProjectReadAuthError(400, 'INVALID_RAW_BODY', 'Raw request body string is required');
    }
    const rawBodyBytes = Buffer.byteLength(req.rawBody, 'utf8');
    if (rawBodyBytes === 0 || rawBodyBytes > this.maxBodyBytes) {
      throw new ProjectReadAuthError(
        rawBodyBytes === 0 ? 400 : 413,
        rawBodyBytes === 0 ? 'EMPTY_BODY' : 'BODY_TOO_LARGE',
        `Request body size (${rawBodyBytes}) violates allowed bounds (1..${this.maxBodyBytes})`,
      );
    }

    const headers = req.headers ?? {};
    const { sessionId, keyId, tsRaw, nonce, sigHex } = validateProjectReadAuthHeaders(headers);

    const ts = Number(tsRaw);
    const now = Date.now();
    if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > this.timestampSkewMs) {
      throw new ProjectReadAuthError(401, 'TIMESTAMP_EXPIRED', 'Request timestamp outside allowed window');
    }

    // === Step 2: 常量时间 HMAC-SHA256 验签（未通过前不触碰 Nonce 缓存，不解析 JSON）===
    const secret = this.resolveSecret(keyId);
    if (!secret) {
      throw new ProjectReadAuthError(401, 'UNKNOWN_KEY_ID', 'Host token keyId unknown or expired');
    }
    const canonical = buildCanonicalString({
      method: req.method,
      urlPath: req.urlPath,
      ts: tsRaw,
      nonce,
      sessionId,
      rawBody: req.rawBody,
    });
    const expectedBuf = crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest();
    const providedBuf = Buffer.from(sigHex, 'hex');
    if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
      throw new ProjectReadAuthError(401, 'INVALID_HMAC', 'HMAC verification failed');
    }

    // === Step 3 & Step 4: 同步原子 Nonce 查重并占位 ===
    const normNonce = nonce.toLowerCase();
    this.pruneNonces(now);
    if (this.nonceCache.has(normNonce)) {
      throw new ProjectReadAuthError(403, 'REPLAY_DETECTED', 'Nonce already used');
    }
    if (this.nonceCache.size >= this.maxNonces) {
      throw new ProjectReadAuthError(429, 'NONCE_CACHE_FULL', 'Nonce cache capacity reached');
    }
    this.nonceCache.set(normNonce, now + this.nonceTtlMs);

    // === Step 5: 完整 JSON 解析与 Strict Schema / 字段长度校验（已认证之后）===
    const validatedBody = parseAndValidateRequestBody(req.rawBody);

    // === Step 6: 核验 QQ 会话身份与持久化 sessionPolicies ===
    const rt = this.getRuntimeState();
    if (!rt?.enabled) {
      throw new ProjectReadAuthError(403, 'FEATURE_DISABLED', 'projectRead feature is disabled');
    }
    if (rt.paused) {
      throw new ProjectReadAuthError(403, 'AI_PAUSED', 'Bridge AI execution is currently paused');
    }
    if (rt.currentMode && rt.currentMode !== 'reserved2') {
      throw new ProjectReadAuthError(403, 'MODE_DENIED', 'projectRead is only permitted in reserved2 mode');
    }
    const ownerQQ = String(rt.ownerQQ ?? '').trim();
    if (!/^\d+$/.test(ownerQQ)) {
      throw new ProjectReadAuthError(403, 'NO_OWNER_CONFIGURED', 'ownerQQ is not configured');
    }
    const adminKey = `private:${ownerQQ}`;
    if (rt.sessions?.[adminKey] !== sessionId) {
      throw new ProjectReadAuthError(403, 'UNAUTHORIZED_SESSION', 'Session does not belong to active admin private chat');
    }
    let policyArr;
    try {
      policyArr = JSON.parse(rt.sessionPolicies?.[adminKey] ?? 'null');
    } catch {
      policyArr = null;
    }
    if (!Array.isArray(policyArr) || policyArr[0] !== 'reserved2' || policyArr[1] !== 'qq-chat-v2') {
      throw new ProjectReadAuthError(403, 'POLICY_MISMATCH', 'Persisted session policy does not authorize qq-chat-v2 reserved2');
    }

    // === Step 7: 执行受控只读业务 ===
    return await executeReadFn(validatedBody, {
      sessionId,
      adminKey,
      ownerQQ,
      keyId,
    });
  }
}
