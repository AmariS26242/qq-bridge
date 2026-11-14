/**
 * project-read 独立审计日志模块（P2-06）。
 *
 * 第三轮加固落地点：
 * 1. 限制单条审计日志大小（默认 MAX_AUDIT_ENTRY_BYTES = 4096 字节），构造与写入前双向约束。
 * 2. 审计日志损坏时保留原始证据，禁止静默删除中间损坏记录：
 *    发现任意损坏（中间损坏行或尾部半行）时，先将完整原始文件保全为 `.corrupt-<stamp>-<rand>.evidence`，
 *    并在恢复后写入不可隐瞒的 `corruption_detected` 标记事件指向该证据文件；仅对结尾合法记录追加后续日志。
 * 3. Fail-Closed：日志写入/轮转任一步失败，withAuditFailClosed() 必须抛错并阻止向调用方返回项目数据。
 * 4. 绝不记录密钥、Token、sessionId 明文或文件正文。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hardenFile } from './state-acl.mjs';

export const DEFAULT_MAX_AUDIT_ENTRY_BYTES = 4096;
export const DEFAULT_MAX_AUDIT_FILE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_AUDIT_ARCHIVES = 5;
export const MAX_CORRUPT_EVIDENCE_FILES = 10;

function truncateUtf8(str, maxBytes) {
  if (typeof str !== 'string') return str;
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let cut = maxBytes;
  // 避免切在 UTF-8 多字节字符中间
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString('utf8') + '…';
}

function sanitizeField(val, maxChars = 256) {
  if (val === undefined || val === null) return undefined;
  const clean = String(val).replace(/[\r\n\0]/g, ' ');
  return clean.length > maxChars ? clean.slice(0, maxChars) + '…' : clean;
}

export function buildBoundedAuditLine(entry, maxEntryBytes = DEFAULT_MAX_AUDIT_ENTRY_BYTES) {
  const base = {
    ts: entry.ts ?? new Date().toISOString(),
    event: sanitizeField(entry.event ?? 'project_read', 48),
    action: sanitizeField(entry.action, 32),
    project: sanitizeField(entry.project, 64),
    path: sanitizeField(entry.path, 260),
    query: sanitizeField(entry.query, 128),
    adminKey: sanitizeField(entry.adminKey, 48),
    sessionHash: sanitizeField(entry.sessionHash, 24),
    status: sanitizeField(entry.status, 32),
    code: sanitizeField(entry.code, 64),
    truncated: typeof entry.truncated === 'boolean' ? entry.truncated : undefined,
    bytes: Number.isFinite(entry.bytes) ? entry.bytes : undefined,
    durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : undefined,
    detail: sanitizeField(entry.detail, 512),
    evidenceFile: sanitizeField(entry.evidenceFile, 160),
    corruptLines: Array.isArray(entry.corruptLines) ? entry.corruptLines.slice(0, 20) : undefined,
  };
  for (const k of Object.keys(base)) {
    if (base[k] === undefined) delete base[k];
  }

  let line = JSON.stringify(base) + '\n';
  if (Buffer.byteLength(line, 'utf8') <= maxEntryBytes) return line;

  // 逐步收缩长字符串字段直到满足单条大小硬上限
  base.entryTruncated = true;
  for (const [field, limit] of [
    ['detail', 160],
    ['path', 120],
    ['query', 64],
    ['evidenceFile', 80],
  ]) {
    if (typeof base[field] === 'string') {
      base[field] = truncateUtf8(base[field], limit);
    }
    line = JSON.stringify(base) + '\n';
    if (Buffer.byteLength(line, 'utf8') <= maxEntryBytes) return line;
  }

  // 最坏情况只保留核心审计骨架，确保绝不突破单行上限
  const minimal = {
    ts: base.ts,
    event: base.event,
    action: base.action,
    project: base.project ? truncateUtf8(base.project, 32) : undefined,
    status: base.status,
    code: base.code,
    entryTruncated: true,
  };
  for (const k of Object.keys(minimal)) if (minimal[k] === undefined) delete minimal[k];
  const minLine = JSON.stringify(minimal) + '\n';
  if (Buffer.byteLength(minLine, 'utf8') > maxEntryBytes) {
    throw new Error(`Audit entry exceeds maxEntryBytes (${maxEntryBytes}) even after minimization`);
  }
  return minLine;
}

export class ProjectReadAuditLogger {
  constructor({
    logPath,
    maxBytes = DEFAULT_MAX_AUDIT_FILE_BYTES,
    maxArchives = DEFAULT_MAX_AUDIT_ARCHIVES,
    maxEntryBytes = DEFAULT_MAX_AUDIT_ENTRY_BYTES,
    applyAcl = true,
  }) {
    this.logPath = logPath;
    this.maxBytes = maxBytes;
    this.maxArchives = maxArchives;
    this.maxEntryBytes = Math.max(512, maxEntryBytes);
    this.applyAcl = applyAcl;
    this.chain = Promise.resolve();
    this.recoveredIssues = [];
    this.evidenceFiles = [];
    this.recoverOnStartupSync();
  }

  pruneOldEvidenceFiles(dir, baseName) {
    try {
      const prefix = `${baseName}.corrupt-`;
      const files = fs.readdirSync(dir)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.evidence'))
        .sort();
      for (const f of files.slice(0, Math.max(0, files.length - MAX_CORRUPT_EVIDENCE_FILES))) {
        try { fs.rmSync(path.join(dir, f), { force: true }); } catch {}
      }
    } catch {}
  }

  /**
   * 崩溃/损坏恢复（保留原始证据，禁止静默删除中间损坏记录）：
   * - 清理残留超过 maxArchives 的归档（.6+）。
   * - 若活动日志包含任何损坏行或未以换行结尾：
   *   1. 将完整原始文件原子保全为 `<logPath>.corrupt-<stamp>-<rand>.evidence`；
   *   2. 区分「仅末尾半行」还是「存在中间损坏记录」；
   *   3. 重建日志只写入可解析完好记录（若为中间损坏则额外附加一条显式 `corruption_detected` 审计记录，
   *      永久指向 `.evidence` 原始证据路径与损坏行号），绝不静默删掉损坏痕迹。
   */
  recoverOnStartupSync() {
    const dir = path.dirname(this.logPath);
    const baseName = path.basename(this.logPath);
    fs.mkdirSync(dir, { recursive: true });

    for (let i = this.maxArchives + 1; i <= this.maxArchives + 5; i++) {
      const extra = `${this.logPath}.${i}`;
      if (fs.existsSync(extra)) {
        try {
          fs.unlinkSync(extra);
          this.recoveredIssues.push(`removed_extra:${i}`);
        } catch {}
      }
    }

    if (!fs.existsSync(this.logPath)) return;
    const raw = fs.readFileSync(this.logPath, 'utf8');
    if (raw.length === 0) return;

    const lines = raw.split('\n');
    const trailingIncomplete = !raw.endsWith('\n');
    const lastContentIdx = trailingIncomplete ? lines.length - 1 : lines.length - 2;
    const validLines = [];
    const corruptMiddleIndices = [];
    let corruptTrailing = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === '' && i === lines.length - 1) continue;
      if (line.trim() === '') {
        corruptMiddleIndices.push(i + 1);
        continue;
      }
      try {
        JSON.parse(line);
        validLines.push(line);
      } catch {
        if (i === lastContentIdx && trailingIncomplete) {
          corruptTrailing = true;
        } else {
          corruptMiddleIndices.push(i + 1);
        }
      }
    }

    if (corruptMiddleIndices.length > 0 || corruptTrailing || trailingIncomplete) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const evidenceName = `${baseName}.corrupt-${stamp}-${crypto.randomBytes(3).toString('hex')}.evidence`;
      const evidencePath = path.join(dir, evidenceName);
      // 先保存完整原始损坏文件作为不可磨灭的取证副本
      fs.writeFileSync(evidencePath, raw, { encoding: 'utf8', mode: 0o600 });
      if (this.applyAcl) hardenFile(evidencePath);
      this.evidenceFiles.push(evidencePath);
      this.pruneOldEvidenceFiles(dir, baseName);

      const marker = buildBoundedAuditLine({
        event: 'audit_corruption_recovered',
        status: 'warning',
        code: corruptMiddleIndices.length > 0 ? 'CORRUPT_MIDDLE_RECORDS' : 'CORRUPT_TRAILING_RECORD',
        evidenceFile: evidenceName,
        corruptLines: corruptMiddleIndices,
        detail: `Preserved raw corrupt log in ${evidenceName}; valid=${validLines.length}, middleCorrupt=${corruptMiddleIndices.length}, trailingCorrupt=${corruptTrailing}`,
      }, this.maxEntryBytes);

      const restoredBody = (validLines.length > 0 ? validLines.join('\n') + '\n' : '') + marker;
      const tmp = `${this.logPath}.recover-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
      try {
        fs.writeFileSync(tmp, restoredBody, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, this.logPath);
        if (this.applyAcl) hardenFile(this.logPath);
      } finally {
        try { fs.rmSync(tmp, { force: true }); } catch {}
      }

      this.recoveredIssues.push(
        `evidence:${evidenceName}|salvaged:${validLines.length}|middleCorrupt:${corruptMiddleIndices.length}|trailing:${corruptTrailing}`,
      );
    }
  }

  rotateSyncIfNeeded(incomingBytes) {
    if (!fs.existsSync(this.logPath)) return;
    const st = fs.statSync(this.logPath);
    if (st.size + incomingBytes <= this.maxBytes) return;

    const oldest = `${this.logPath}.${this.maxArchives}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

    for (let i = this.maxArchives - 1; i >= 1; i--) {
      const src = `${this.logPath}.${i}`;
      const dst = `${this.logPath}.${i + 1}`;
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }
    fs.renameSync(this.logPath, `${this.logPath}.1`);
  }

  writeEntry(entry) {
    const line = buildBoundedAuditLine(entry, this.maxEntryBytes);
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const run = async () => {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      this.rotateSyncIfNeeded(lineBytes);
      fs.appendFileSync(this.logPath, line, { encoding: 'utf8', mode: 0o600 });
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  /**
   * Fail-Closed 执行包装：业务只读动作完成后，必须先把审计条目成功写入磁盘，
   * 写盘失败则抛错拒绝返回敏感数据给调用方。
   */
  async withAuditFailClosed(metaEntry, fn) {
    const started = Date.now();
    try {
      const result = await fn();
      await this.writeEntry({
        ...metaEntry,
        status: 'ok',
        truncated: result?.truncated ?? false,
        bytes: result?.bytesReturned ?? result?.bytesRead ?? undefined,
        durationMs: Date.now() - started,
      });
      return result;
    } catch (err) {
      // 失败事件也尝试记录审计（忽略二次日志异常，保留原始失败向外抛出）
      await this.writeEntry({
        ...metaEntry,
        status: 'denied_or_error',
        code: err?.code ?? 'INTERNAL_ERROR',
        detail: err?.message,
        durationMs: Date.now() - started,
      }).catch(() => {});
      throw err;
    }
  }
}

export function hashSessionForAudit(sessionId) {
  if (!sessionId) return undefined;
  return crypto.createHash('sha256').update(String(sessionId), 'utf8').digest('hex').slice(0, 16);
}
