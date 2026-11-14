/**
 * Bridge 侧 project-read 协调控制器：
 * 将 Host Token 生命周期、HTTP 边界读写、HMAC-before-Nonce 验证、审计 Fail-Closed 与只读操作串接为统一入口，
 * 使 `src/bridge.js` 保持最小侵入，且所有组件均可脱离完整 DSH/QQ 环境独立集成测试。
 */
import path from 'node:path';
import {
  MAX_PROJECT_READ_BODY_BYTES,
  PROJECT_READ_ENDPOINT,
  ProjectReadAuthEngine,
  ProjectReadAuthError,
  normalizeProjectReadConfig,
  validateProjectReadAuthHeaders,
} from './project-read-auth.mjs';
import {
  ProjectReadAuditLogger,
  hashSessionForAudit,
} from './project-read-audit.mjs';
import { executeProjectReadAction } from './project-read-ops.mjs';
import { SafeFsError } from './project-read-win32-fs.mjs';

export const MAX_PROJECT_READ_HEADER_COUNT = 32;
export const MAX_PROJECT_READ_HEADER_TOTAL_BYTES = 8192;

export function assertBoundedRawHeaders(
  req,
  maxCount = MAX_PROJECT_READ_HEADER_COUNT,
  maxTotalBytes = MAX_PROJECT_READ_HEADER_TOTAL_BYTES,
) {
  let count = 0;
  let totalBytes = 0;
  if (Array.isArray(req?.rawHeaders)) {
    const raw = req.rawHeaders;
    count = Math.floor(raw.length / 2);
    if (count > maxCount) {
      throw new ProjectReadAuthError(431, 'TOO_MANY_HEADERS', `Header count (${count}) exceeds limit (${maxCount})`);
    }
    for (let i = 0; i < raw.length; i += 2) {
      totalBytes += Buffer.byteLength(String(raw[i] ?? ''), 'utf8');
      totalBytes += Buffer.byteLength(String(raw[i + 1] ?? ''), 'utf8') + 4;
      if (totalBytes > maxTotalBytes) {
        throw new ProjectReadAuthError(431, 'HEADER_TOO_LARGE', `Total header size exceeds limit (${maxTotalBytes} bytes)`);
      }
    }
    return { count, totalBytes };
  }

  const hdrs = req?.headers ?? {};
  for (const [k, v] of Object.entries(hdrs)) {
    const vals = Array.isArray(v) ? v : [v];
    for (const item of vals) {
      count++;
      if (count > maxCount) {
        throw new ProjectReadAuthError(431, 'TOO_MANY_HEADERS', `Header count (${count}) exceeds limit (${maxCount})`);
      }
      totalBytes += Buffer.byteLength(String(k), 'utf8') + Buffer.byteLength(String(item ?? ''), 'utf8') + 4;
      if (totalBytes > maxTotalBytes) {
        throw new ProjectReadAuthError(431, 'HEADER_TOO_LARGE', `Total header size exceeds limit (${maxTotalBytes} bytes)`);
      }
    }
  }
  return { count, totalBytes };
}

export function readBoundedRawBody(req, maxBytes = MAX_PROJECT_READ_BODY_BYTES, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const ctype = String(req.headers?.['content-type'] ?? '').toLowerCase();
    if (!ctype.includes('application/json')) {
      req.pause?.();
      reject(new ProjectReadAuthError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
      return;
    }
    const declaredHeader = req.headers?.['content-length'];
    if (declaredHeader !== undefined) {
      const declared = Number(declaredHeader);
      if (!Number.isFinite(declared) || declared < 0) {
        req.pause?.();
        reject(new ProjectReadAuthError(400, 'INVALID_CONTENT_LENGTH', 'Invalid Content-Length header'));
        return;
      }
      if (declared > maxBytes) {
        req.pause?.();
        reject(new ProjectReadAuthError(413, 'BODY_TOO_LARGE', `Declared body exceeds limit (${maxBytes} bytes)`));
        return;
      }
    }

    const chunks = [];
    let total = 0;
    let settled = false;

    const cleanupListeners = () => {
      req.removeListener?.('data', onData);
      req.removeListener?.('end', onEnd);
      req.removeListener?.('error', onError);
      req.removeListener?.('aborted', onAborted);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.pause?.();
      cleanupListeners();
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(new ProjectReadAuthError(408, 'BODY_TIMEOUT', 'Timed out reading request body'));
    }, timeoutMs);
    timer.unref?.();

    const onData = (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        fail(new ProjectReadAuthError(413, 'BODY_TOO_LARGE', `Body exceeds limit (${maxBytes} bytes)`));
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupListeners();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = () => fail(new ProjectReadAuthError(400, 'BODY_READ_ERROR', 'Failed to read request body'));
    const onAborted = () => fail(new ProjectReadAuthError(400, 'BODY_ABORTED', 'Request aborted'));

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

export class ProjectReadController {
  constructor({
    stateDir,
    rawConfig,
    getBridgeRuntimeState,
    getKnownSecrets = () => [],
    applyAcl = true,
    log = () => {},
  }) {
    this.stateDir = stateDir;
    this.tokenFile = path.join(stateDir, 'project-read-host-token.json');
    this.auditLogFile = path.join(stateDir, 'project-read-audit.jsonl');
    this.getBridgeRuntimeState = getBridgeRuntimeState;
    this.getKnownSecrets = getKnownSecrets;
    this.applyAcl = applyAcl;
    this.log = log;

    this.config = normalizeProjectReadConfig(rawConfig);
    this.auditLogger = new ProjectReadAuditLogger({
      logPath: this.auditLogFile,
      applyAcl,
    });
    if (this.auditLogger.recoveredIssues.length > 0) {
      this.log(`[project-read] 审计日志启动恢复: ${this.auditLogger.recoveredIssues.join('; ')}`);
    }

    this.authEngine = new ProjectReadAuthEngine({
      tokenFile: this.tokenFile,
      getRuntimeState: () => ({
        ...this.getBridgeRuntimeState(),
        enabled: this.config.enabled,
      }),
      timestampSkewMs: this.config.timestampSkewMs,
      nonceTtlMs: this.config.nonceTtlMs,
      maxNonces: this.config.maxNonces,
      maxBodyBytes: this.config.maxBodyBytes,
      applyAcl,
      active: this.config.enabled,
    });
  }

  /**
   * 运行中绑定实际回环监听端口写入 tokenFile（仅当功能启用时有效，供宿主插件定位回环 Bridge）。
   */
  bindListeningPort(port) {
    this.listeningPort = port;
    if (this.config.enabled && this.authEngine.current) {
      this.authEngine.persistTokenFile({
        baseUrl: `http://127.0.0.1:${port}`,
      });
    }
  }

  statusSummary() {
    return {
      enabled: this.config.enabled,
      configuredProjects: Object.keys(this.config.projects),
      tokenActive: Boolean(this.config.enabled && this.authEngine.current),
      auditLogFile: this.auditLogFile,
      recoveredIssues: this.auditLogger.recoveredIssues.slice(),
    };
  }

  async handleHttpRequest(req, res, securityHeaders = {}) {
    const sendJson = (status, payload) => {
      const closeAfterSend = status >= 400;
      const headers = {
        'content-type': 'application/json; charset=utf-8',
        ...securityHeaders,
        ...(closeAfterSend ? { Connection: 'close' } : {}),
      };
      if (closeAfterSend) {
        req.pause?.();
        let closed = false;
        const closeSocketAfterFlush = () => {
          if (closed) return;
          closed = true;
          const sock = req.socket;
          if (!sock || sock.destroyed) return;
          try {
            sock.end();
          } catch {}
          const forceTimer = setTimeout(() => {
            if (!sock.destroyed) sock.destroy();
          }, 25);
          forceTimer.unref?.();
        };
        res.once('finish', closeSocketAfterFlush);
        res.writeHead(status, headers);
        res.end(JSON.stringify(payload), closeSocketAfterFlush);
        return;
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(payload));
    };

    try {
      // 若总开关关闭：即便是合法形态请求也先走快速拒绝，且不读取/不创建任何 Token
      if (!this.config.enabled) {
        sendJson(403, {
          ok: false,
          code: 'FEATURE_DISABLED',
          error: 'projectRead feature is disabled (default closed)',
        });
        return;
      }

      if (req.method !== 'POST') {
        throw new ProjectReadAuthError(400, 'INVALID_ENDPOINT', 'Invalid method or path');
      }

      // 在读取请求体之前先严格约束原始 Header 数量与总字节数，并检查必要认证 Header
      assertBoundedRawHeaders(req);
      validateProjectReadAuthHeaders(req.headers);

      // 若请求意外携带控制台全权令牌或普通 agent 令牌，绝不复用它们作为降级认证
      const rawBody = await readBoundedRawBody(req, this.config.maxBodyBytes);
      const data = await this.authEngine.verifyAndExecute(
        {
          method: req.method,
          urlPath: PROJECT_READ_ENDPOINT,
          headers: req.headers,
          rawBody,
        },
        async (validatedBody, ctx) => {
          const secrets = [
            ...(this.getKnownSecrets() ?? []),
            this.authEngine.current?.secret,
            this.authEngine.prev?.secret,
          ].filter(Boolean);

          return await this.auditLogger.withAuditFailClosed(
            {
              action: validatedBody.action,
              project: validatedBody.project,
              path: validatedBody.path,
              query: validatedBody.query,
              adminKey: ctx.adminKey,
              sessionHash: hashSessionForAudit(ctx.sessionId),
            },
            async () => executeProjectReadAction(this.config, validatedBody, { knownSecrets: secrets }),
          );
        },
      );

      sendJson(200, { ok: true, result: data });
    } catch (err) {
      if (err instanceof ProjectReadAuthError) {
        // 对已解析场景外（认证前失败）尽力记录简洁拒绝日志，但不泄漏签名或令牌值
        const sessionHash = hashSessionForAudit(req.headers?.['x-project-read-session']);
        await this.auditLogger.writeEntry({
          event: 'project_read_auth_denied',
          status: 'denied',
          code: err.code,
          sessionHash,
          detail: err.message,
        }).catch(() => {});
        sendJson(err.status, {
          ok: false,
          code: err.code,
          error: err.message,
        });
        return;
      }
      if (err instanceof SafeFsError) {
        const statusMap = {
          ACCESS_DENIED: 403,
          REPARSE_POINT_DENIED: 403,
          HARDLINK_DENIED: 403,
          UNC_DENIED: 403,
          PATH_ESCAPED: 403,
          VOLUME_MISMATCH: 403,
          ROOT_PATH_MISMATCH: 403,
          ROOT_NOT_CONFIGURED: 500,
          PROJECT_NOT_ALLOWED: 403,
          BINARY_FILE_DENIED: 415,
          INVALID_PATH: 400,
          RESERVED_DEVICE: 400,
          INVALID_ACTION: 400,
          FILE_ID_INFO_FAILED: 500,
          ENUM_CORRUPT_BUFFER: 500,
        };
        sendJson(statusMap[err.code] ?? 400, {
          ok: false,
          code: err.code,
          error: err.message,
        });
        return;
      }
      sendJson(500, {
        ok: false,
        code: err?.code ?? 'INTERNAL_ERROR',
        error: err?.message ?? 'Internal project-read failure',
      });
    }
  }
}
