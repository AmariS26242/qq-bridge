/**
 * Win32 原生安全只读文件系统原语（P2-03）。
 *
 * 第三轮安全加固落地点：
 * 1. FILE_ID_INFO Fail-Closed：GetFileInformationByHandleEx(FileIdInfo) 返回 0 立即抛出 FILE_ID_INFO_FAILED；
 *    强制核验 64 位 VolumeSerialNumber 与 16 字节 FileId 读写前后一致。
 * 2. 完整目录祖先链保护：openRootSafely() 遍历根祖先并保留全部祖先句柄至目标根目录开启且终路径匹配；
 *    traverseToParentDir() + safeReadFileRelative() 保留全部中间及父目录句柄（heldHandles）直到 ReadFile
 *    及读后复核完成，并在 finally 中逆序释放，绝不泄漏句柄。
 * 3. 明确根目录 expectedRootPath 硬要求：必须由可信配置显式提供本机绝对路径，拒绝空值或静默回退（ROOT_NOT_CONFIGURED）。
 * 4. 完整目录枚举边界检查：严格校验 FILE_ID_BOTH_DIR_INFO 条目的 NextEntryOffset、FileNameLength、
 *    缓冲区剩余长度以及 8 字节结构对齐（ENUM_CORRUPT_BUFFER）。
 */
import koffi from 'koffi';
import path from 'node:path';

// --- Win32 / NT Constants ---
const FILE_LIST_DIRECTORY = 0x00000001;
const FILE_READ_DATA = 0x00000001;
const FILE_READ_ATTRIBUTES = 0x00000080;
const SYNCHRONIZE = 0x00100000;
const ACCESS_DIR_READ = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
const ACCESS_FILE_READ = FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE;

export const FILE_SHARE_READ = 0x00000001;
export const FILE_SHARE_WRITE = 0x00000002;
export const FILE_SHARE_DELETE = 0x00000004;

const FILE_OPEN = 0x00000001;
const FILE_DIRECTORY_FILE = 0x00000001;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
const FILE_NON_DIRECTORY_FILE = 0x00000040;
const FILE_OPEN_REPARSE_POINT = 0x00200000;

const OBJ_CASE_INSENSITIVE = 0x00000040;

const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
const FILE_TYPE_DISK = 0x0001;
const FILE_NAME_NORMALIZED = 0x0;
const VOLUME_NAME_DOS = 0x0;
const FileIdBothDirectoryInfo = 10;
const FileIdBothDirectoryRestartInfo = 11;
const FileIdInfoClass = 18;

const ERROR_NO_MORE_FILES = 18;
// FILE_ID_BOTH_DIR_INFO 到 FileName[1] 前共 104 字节；结构体 8 字节对齐
const FILE_ID_BOTH_DIR_FIXED_HEADER_SIZE = 104;
const MAX_WIN32_FILENAME_BYTES = 255 * 2;

// --- Koffi Structs & Bindings ---
const UNICODE_STRING = koffi.struct('UNICODE_STRING', {
  Length: 'uint16_t',
  MaximumLength: 'uint16_t',
  Buffer: 'uint8_t *',
});

const OBJECT_ATTRIBUTES = koffi.struct('OBJECT_ATTRIBUTES', {
  Length: 'uint32_t',
  RootDirectory: 'void *',
  ObjectName: 'UNICODE_STRING *',
  Attributes: 'uint32_t',
  SecurityDescriptor: 'void *',
  SecurityQualityOfService: 'void *',
});

const IO_STATUS_BLOCK = koffi.struct('IO_STATUS_BLOCK', {
  Status: 'intptr_t',
  Information: 'uintptr_t',
});

const FILETIME = koffi.struct('FILETIME', {
  dwLowDateTime: 'uint32_t',
  dwHighDateTime: 'uint32_t',
});

const BY_HANDLE_FILE_INFORMATION = koffi.struct('BY_HANDLE_FILE_INFORMATION', {
  dwFileAttributes: 'uint32_t',
  ftCreationTime: FILETIME,
  ftLastAccessTime: FILETIME,
  ftLastWriteTime: FILETIME,
  dwVolumeSerialNumber: 'uint32_t',
  nFileSizeHigh: 'uint32_t',
  nFileSizeLow: 'uint32_t',
  nNumberOfLinks: 'uint32_t',
  nFileIndexHigh: 'uint32_t',
  nFileIndexLow: 'uint32_t',
});

const FILE_ID_INFO = koffi.struct('FILE_ID_INFO', {
  VolumeSerialNumber: 'uint64_t',
  FileId: koffi.array('uint8_t', 16),
});

const ntdll = koffi.load('ntdll.dll');
const kernel32 = koffi.load('kernel32.dll');

const NtCreateFile = ntdll.func(
  'int32_t __stdcall NtCreateFile('
  + '_Out_ void **FileHandle, '
  + 'uint32_t DesiredAccess, '
  + 'OBJECT_ATTRIBUTES *ObjectAttributes, '
  + '_Out_ IO_STATUS_BLOCK *IoStatusBlock, '
  + 'int64_t *AllocationSize, '
  + 'uint32_t FileAttributes, '
  + 'uint32_t ShareAccess, '
  + 'uint32_t CreateDisposition, '
  + 'uint32_t CreateOptions, '
  + 'void *EaBuffer, '
  + 'uint32_t EaLength)',
);

const CloseHandle = kernel32.func('int __stdcall CloseHandle(void *hObject)');
const GetFileType = kernel32.func('uint32_t __stdcall GetFileType(void *hFile)');
const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()');
const GetFileInformationByHandle = kernel32.func(
  'int __stdcall GetFileInformationByHandle(void *hFile, _Out_ BY_HANDLE_FILE_INFORMATION *lpFileInformation)',
);
const GetFileInformationByHandleEx = kernel32.func(
  'int __stdcall GetFileInformationByHandleEx(void *hFile, int FileInformationClass, void *lpFileInformation, uint32_t dwBufferSize)',
);
const GetFinalPathNameByHandleW = kernel32.func(
  'uint32_t __stdcall GetFinalPathNameByHandleW(void *hFile, void *lpszFilePath, uint32_t cchFilePath, uint32_t dwFlags)',
);
const ReadFile = kernel32.func(
  'int __stdcall ReadFile(void *hFile, void *lpBuffer, uint32_t nNumberOfBytesToRead, _Out_ uint32_t *lpNumberOfBytesRead, void *lpOverlapped)',
);

export const STRUCT_SIZES = {
  UNICODE_STRING: koffi.sizeof(UNICODE_STRING),
  OBJECT_ATTRIBUTES: koffi.sizeof(OBJECT_ATTRIBUTES),
  IO_STATUS_BLOCK: koffi.sizeof(IO_STATUS_BLOCK),
  BY_HANDLE_FILE_INFORMATION: koffi.sizeof(BY_HANDLE_FILE_INFORMATION),
  FILE_ID_INFO: koffi.sizeof(FILE_ID_INFO),
};

export class HandleTracker {
  constructor() {
    this.openCount = 0;
    this.closeCount = 0;
    this.active = new Set();
  }
  trackOpen(h, label = '') {
    this.openCount++;
    const key = `${koffi.address(h)}:${this.openCount}:${label}`;
    this.active.add(key);
    return key;
  }
  close(h, key) {
    if (!h) return;
    CloseHandle(h);
    this.closeCount++;
    if (key) this.active.delete(key);
  }
  closeAllReverse(handles) {
    for (let i = handles.length - 1; i >= 0; i--) {
      const item = handles[i];
      if (item && item.h) {
        this.close(item.h, item.key);
        item.h = null;
      }
    }
  }
  get leaked() {
    return this.active.size;
  }
}

export class SafeFsError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SafeFsError';
    this.code = code;
    this.detail = detail;
  }
}

function makeUnicodeString(str) {
  const buf = Buffer.from(str + '\0', 'utf16le');
  return {
    buf,
    struct: {
      Length: buf.length - 2,
      MaximumLength: buf.length,
      Buffer: buf,
    },
  };
}

function ntStatusHex(status) {
  return '0x' + (status >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

function ntOpenRelative(tracker, rootHandle, objectNameStr, desiredAccess, shareAccess, createOptions, label) {
  const u = makeUnicodeString(objectNameStr);
  const objAttr = {
    Length: STRUCT_SIZES.OBJECT_ATTRIBUTES,
    RootDirectory: rootHandle,
    ObjectName: u.struct,
    Attributes: OBJ_CASE_INSENSITIVE,
    SecurityDescriptor: null,
    SecurityQualityOfService: null,
  };
  const outHandle = [null];
  const ioStatus = {};
  const status = NtCreateFile(
    outHandle,
    desiredAccess,
    objAttr,
    ioStatus,
    null,
    0,
    shareAccess,
    FILE_OPEN,
    createOptions,
    null,
    0,
  );
  if (status < 0 || !outHandle[0]) {
    throw new SafeFsError('NT_OPEN_FAILED', `NtCreateFile failed for ${label}: ${ntStatusHex(status)}`, {
      ntStatus: status,
      ntStatusHex: ntStatusHex(status),
      label,
    });
  }
  const h = outHandle[0];
  const key = tracker.trackOpen(h, label);
  return { h, key };
}

/**
 * 强 Fail-Closed 句柄身份检验。
 */
function inspectHandle(h, label, options = {}) {
  const getFileIdInfo = options.getFileIdInfoFn ?? GetFileInformationByHandleEx;

  const fileType = GetFileType(h);
  if (fileType !== FILE_TYPE_DISK) {
    throw new SafeFsError('NOT_DISK_FILE', `Non-disk file type (${fileType}) at ${label}`, { fileType, label });
  }
  const info = {};
  if (GetFileInformationByHandle(h, info) === 0) {
    const err = GetLastError();
    throw new SafeFsError('HANDLE_STAT_FAILED', `GetFileInformationByHandle failed (${err}) at ${label}`, { err, label });
  }
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
    throw new SafeFsError('REPARSE_POINT_DENIED', `Reparse point rejected at ${label}`, {
      dwFileAttributes: info.dwFileAttributes,
      label,
    });
  }
  const idBuf = Buffer.alloc(STRUCT_SIZES.FILE_ID_INFO);
  const okId = getFileIdInfo(h, FileIdInfoClass, idBuf, idBuf.length);
  if (okId === 0) {
    const err = GetLastError();
    throw new SafeFsError('FILE_ID_INFO_FAILED', `GetFileInformationByHandleEx(FileIdInfo) failed (${err}) at ${label}`, {
      err,
      label,
    });
  }
  const volumeSerial64 = idBuf.readBigUInt64LE(0);
  const fileIdHex = idBuf.subarray(8, 24).toString('hex');

  return {
    dwFileAttributes: info.dwFileAttributes,
    isDir: (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) !== 0,
    dwVolumeSerialNumber: info.dwVolumeSerialNumber,
    nNumberOfLinks: info.nNumberOfLinks,
    size: Number((BigInt(info.nFileSizeHigh) << 32n) | BigInt(info.nFileSizeLow)),
    fileIndex: `${info.nFileIndexHigh.toString(16)}:${info.nFileIndexLow.toString(16)}`,
    volumeSerial64,
    volumeSerial64Hex: volumeSerial64.toString(16),
    fileIdHex,
  };
}

function getFinalPathByHandle(h) {
  const neededChars = GetFinalPathNameByHandleW(h, null, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (neededChars === 0) {
    const err = GetLastError();
    throw new SafeFsError('FINAL_PATH_FAILED', `GetFinalPathNameByHandleW sizing failed (${err})`, { err });
  }
  const buf = Buffer.alloc((neededChars + 1) * 2);
  const written = GetFinalPathNameByHandleW(h, buf, neededChars + 1, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (written === 0 || written > neededChars) {
    const err = GetLastError();
    throw new SafeFsError('FINAL_PATH_FAILED', `GetFinalPathNameByHandleW failed (${err})`, { err });
  }
  return buf.toString('utf16le', 0, written * 2);
}

export function normalizeWinDosPath(p) {
  let out = p;
  if (out.startsWith('\\\\?\\')) out = out.slice(4);
  if (out.toUpperCase().startsWith('UNC\\')) {
    throw new SafeFsError('UNC_DENIED', 'UNC final path is not permitted', { path: p });
  }
  return path.win32.normalize(out).toLowerCase();
}

export function assertPathContainment(normRoot, normTarget, allowEqual = false) {
  const rel = path.win32.relative(normRoot, normTarget);
  if (!allowEqual && rel === '') {
    throw new SafeFsError('PATH_ESCAPED', 'Target resolves to root directory itself', { normRoot, normTarget });
  }
  if (rel === '..' || rel.startsWith('..' + path.win32.sep) || path.win32.isAbsolute(rel)) {
    throw new SafeFsError('PATH_ESCAPED', 'Final path escaped root containment', { normRoot, normTarget, rel });
  }
  return rel;
}

const RESERVED_DEVICE_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

export function validateEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) return { valid: false, reason: 'empty_name' };
  if (name === '.' || name === '..') return { valid: false, reason: 'dot_segment' };
  if (/[\x00-\x1f]/.test(name) || name.includes('/') || name.includes('\\') || name.includes(':')) {
    return { valid: false, reason: 'illegal_char' };
  }
  if (name.endsWith('.') || name.endsWith(' ')) return { valid: false, reason: 'trailing_dot_or_space' };
  if (RESERVED_DEVICE_RE.test(name)) return { valid: false, reason: 'reserved_device_name' };
  return { valid: true };
}

export function splitAndValidateRelSegments(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new SafeFsError('INVALID_PATH', 'Empty relative path');
  }
  if (relPath.includes('\0') || relPath.includes('\\') || relPath.includes(':')) {
    throw new SafeFsError('INVALID_PATH', 'Illegal character (NUL, backslash, or colon/ADS) in virtual path');
  }
  if (relPath.startsWith('/') || relPath.endsWith('/')) {
    throw new SafeFsError('INVALID_PATH', 'Leading or trailing slash is not allowed');
  }
  const segs = relPath.split('/');
  for (const s of segs) {
    const chk = validateEntryName(s);
    if (!chk.valid) {
      throw new SafeFsError(
        chk.reason === 'reserved_device_name' ? 'RESERVED_DEVICE' : 'INVALID_PATH',
        `Invalid path segment (${chk.reason}): ${s}`,
      );
    }
  }
  return segs;
}

/**
 * 显式根目录安全打开：
 * 要求 options.expectedRootPath 必须显式传入（禁止静默回退到 rootDir 本身），确保配置根与真实挂载根严格一致。
 */
export function openRootSafely(tracker, rootDir, options = {}) {
  const dirShare = options.dirShare ?? (FILE_SHARE_READ | FILE_SHARE_WRITE);
  const ancestorShare = options.ancestorShare ?? (FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);

  if (typeof rootDir !== 'string' || rootDir.trim() === '') {
    throw new SafeFsError('INVALID_ROOT', 'rootDir must be a non-empty string');
  }
  if (typeof options.expectedRootPath !== 'string' || options.expectedRootPath.trim() === '') {
    throw new SafeFsError('ROOT_NOT_CONFIGURED', 'options.expectedRootPath must be explicitly provided without fallback');
  }

  const absRoot = path.win32.resolve(rootDir);
  const absExpected = path.win32.resolve(options.expectedRootPath);
  if (absRoot.startsWith('\\\\') || absExpected.startsWith('\\\\')) {
    throw new SafeFsError('UNC_DENIED', 'UNC root directory is not permitted');
  }
  const expectedRootNorm = normalizeWinDosPath(absExpected);

  const parsed = path.win32.parse(absRoot);
  if (!/^[A-Za-z]:\\$/.test(parsed.root)) {
    throw new SafeFsError('INVALID_ROOT', `Unsupported root format: ${parsed.root}`);
  }
  const ntDriveRoot = `\\??\\${parsed.root}`;
  const rest = absRoot.slice(parsed.root.length);
  const segs = rest ? rest.split('\\').filter(Boolean) : [];

  const ancestorHandles = [];
  let rootHandleObj = null;

  try {
    const driveObj = ntOpenRelative(
      tracker,
      null,
      ntDriveRoot,
      ACCESS_DIR_READ,
      segs.length === 0 ? dirShare : ancestorShare,
      FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
      `driveRoot(${parsed.root})`,
    );
    if (segs.length === 0) {
      rootHandleObj = driveObj;
    } else {
      ancestorHandles.push(driveObj);
    }

    const driveMeta = inspectHandle(driveObj.h, `driveRoot(${parsed.root})`, options);
    if (!driveMeta.isDir) {
      throw new SafeFsError('NOT_A_DIRECTORY', 'Drive root is not a directory');
    }

    let curH = driveObj.h;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const isTargetRoot = i === segs.length - 1;
      const share = isTargetRoot ? dirShare : ancestorShare;
      const nextObj = ntOpenRelative(
        tracker,
        curH,
        seg,
        ACCESS_DIR_READ,
        share,
        FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
        `rootSeg(${seg})`,
      );
      if (isTargetRoot) {
        rootHandleObj = nextObj;
      } else {
        ancestorHandles.push(nextObj);
      }
      const meta = inspectHandle(nextObj.h, `rootSeg(${seg})`, options);
      if (!meta.isDir) {
        throw new SafeFsError('NOT_A_DIRECTORY', `Root ancestor is not a directory: ${seg}`);
      }
      curH = nextObj.h;
    }

    const finalPath = normalizeWinDosPath(getFinalPathByHandle(rootHandleObj.h));
    if (finalPath !== expectedRootNorm) {
      throw new SafeFsError('ROOT_PATH_MISMATCH', 'Resolved root path does not match configured expected root', {
        finalPath,
        expectedRootNorm,
      });
    }
    const rootMeta = inspectHandle(rootHandleObj.h, 'rootFinal', options);

    if (options.keepAncestorsOpen) {
      return {
        h: rootHandleObj.h,
        key: rootHandleObj.key,
        ancestorHandles,
        normFinalPath: finalPath,
        expectedRootNorm,
        volumeSerial: rootMeta.dwVolumeSerialNumber,
        volumeSerial64: rootMeta.volumeSerial64,
        volumeSerial64Hex: rootMeta.volumeSerial64Hex,
      };
    }

    tracker.closeAllReverse(ancestorHandles);
    return {
      h: rootHandleObj.h,
      key: rootHandleObj.key,
      ancestorHandles: [],
      normFinalPath: finalPath,
      expectedRootNorm,
      volumeSerial: rootMeta.dwVolumeSerialNumber,
      volumeSerial64: rootMeta.volumeSerial64,
      volumeSerial64Hex: rootMeta.volumeSerial64Hex,
    };
  } catch (err) {
    if (rootHandleObj) tracker.close(rootHandleObj.h, rootHandleObj.key);
    tracker.closeAllReverse(ancestorHandles);
    throw err;
  }
}

export function closeRootCtx(tracker, rootCtx) {
  if (!rootCtx) return;
  if (rootCtx.h) {
    tracker.close(rootCtx.h, rootCtx.key);
    rootCtx.h = null;
  }
  if (rootCtx.ancestorHandles?.length) {
    tracker.closeAllReverse(rootCtx.ancestorHandles);
  }
}

function traverseToParentDir(tracker, rootCtx, dirSegs, dirShare, options = {}) {
  const heldHandles = [];
  let curH = rootCtx.h;
  try {
    const currentRootFinal = normalizeWinDosPath(getFinalPathByHandle(rootCtx.h));
    if (currentRootFinal !== rootCtx.expectedRootNorm) {
      throw new SafeFsError('ROOT_PATH_MISMATCH', 'Root directory final path changed before traversal', {
        currentRootFinal,
        expectedRootNorm: rootCtx.expectedRootNorm,
      });
    }

    for (let i = 0; i < dirSegs.length; i++) {
      const seg = dirSegs[i];
      const nextObj = ntOpenRelative(
        tracker,
        curH,
        seg,
        ACCESS_DIR_READ,
        dirShare,
        FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
        `dirSeg(${seg})`,
      );
      heldHandles.push(nextObj);
      const meta = inspectHandle(nextObj.h, `dirSeg(${seg})`, options);
      if (!meta.isDir) {
        throw new SafeFsError('NOT_A_DIRECTORY', `Intermediate component is not a directory: ${seg}`);
      }
      if (meta.volumeSerial64 !== rootCtx.volumeSerial64 || meta.dwVolumeSerialNumber !== rootCtx.volumeSerial) {
        throw new SafeFsError('VOLUME_MISMATCH', `Volume changed at directory segment ${seg}`);
      }
      if (options.onDirHandleOpen) options.onDirHandleOpen(seg, i, nextObj.h, heldHandles);
      curH = nextObj.h;
    }
    return { parentH: curH, heldHandles };
  } catch (err) {
    tracker.closeAllReverse(heldHandles);
    throw err;
  }
}

export function safeReadFileRelative(tracker, rootCtx, relPath, options = {}) {
  const maxBytes = options.maxBytes ?? 65536;
  const maxLinks = options.maxLinks ?? 1;
  const fileShare = options.fileShare ?? FILE_SHARE_READ;
  const dirShare = options.dirShare ?? (FILE_SHARE_READ | FILE_SHARE_WRITE);

  const segs = splitAndValidateRelSegments(relPath);
  const dirSegs = segs.slice(0, -1);
  const fileName = segs[segs.length - 1];

  const { parentH, heldHandles } = traverseToParentDir(tracker, rootCtx, dirSegs, dirShare, options);
  let fileOpened = null;

  try {
    fileOpened = ntOpenRelative(
      tracker,
      parentH,
      fileName,
      ACCESS_FILE_READ,
      fileShare,
      FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
      `file(${relPath})`,
    );

    const meta = inspectHandle(fileOpened.h, `file(${relPath})`, options);
    if (meta.isDir) {
      throw new SafeFsError('IS_DIRECTORY', 'Target is a directory');
    }
    if (meta.volumeSerial64 !== rootCtx.volumeSerial64 || meta.dwVolumeSerialNumber !== rootCtx.volumeSerial) {
      throw new SafeFsError('VOLUME_MISMATCH', 'Target volume does not match root volume');
    }
    if (meta.nNumberOfLinks > maxLinks) {
      throw new SafeFsError('HARDLINK_DENIED', `Hardlink count ${meta.nNumberOfLinks} exceeds limit ${maxLinks}`, {
        nNumberOfLinks: meta.nNumberOfLinks,
        maxLinks,
      });
    }

    const finalNorm = normalizeWinDosPath(getFinalPathByHandle(fileOpened.h));
    const relFromFinal = assertPathContainment(rootCtx.expectedRootNorm, finalNorm, false);

    const rootFinalNow = normalizeWinDosPath(getFinalPathByHandle(rootCtx.h));
    if (rootFinalNow !== rootCtx.expectedRootNorm) {
      throw new SafeFsError('ROOT_PATH_MISMATCH', 'Root directory path changed before ReadFile', {
        rootFinalNow,
        expectedRootNorm: rootCtx.expectedRootNorm,
      });
    }

    if (options.onFileHandleOpen) {
      options.onFileHandleOpen(fileOpened.h, meta, finalNorm, heldHandles);
    }

    const toRead = Math.min(meta.size, maxBytes);
    const outBuf = Buffer.alloc(toRead);
    let totalRead = 0;
    const chunkBytes = [0];
    while (totalRead < toRead) {
      const slice = outBuf.subarray(totalRead);
      const ok = ReadFile(fileOpened.h, slice, slice.length, chunkBytes, null);
      if (ok === 0) {
        const err = GetLastError();
        throw new SafeFsError('READ_FAILED', `ReadFile failed (${err})`, { err });
      }
      if (chunkBytes[0] === 0) break;
      totalRead += chunkBytes[0];
    }

    const postMeta = inspectHandle(fileOpened.h, `filePostRead(${relPath})`, options);
    if (postMeta.fileIdHex !== meta.fileIdHex || postMeta.volumeSerial64 !== rootCtx.volumeSerial64) {
      throw new SafeFsError('FILE_IDENTITY_CHANGED', 'File identity changed during read');
    }
    const postFinalNorm = normalizeWinDosPath(getFinalPathByHandle(fileOpened.h));
    assertPathContainment(rootCtx.expectedRootNorm, postFinalNorm, false);

    return {
      data: outBuf.subarray(0, totalRead),
      meta: postMeta,
      finalNorm: postFinalNorm,
      relFromFinal,
      truncatedByReadLimit: meta.size > totalRead,
    };
  } finally {
    if (fileOpened) tracker.close(fileOpened.h, fileOpened.key);
    tracker.closeAllReverse(heldHandles);
  }
}

export function withSafeRoot(tracker, configuredRoot, options, fn) {
  if (typeof options === 'function') {
    fn = options;
    options = {};
  }
  const opts = options ?? {};
  const rootCtx = openRootSafely(tracker, configuredRoot, opts);
  try {
    return fn(rootCtx);
  } finally {
    closeRootCtx(tracker, rootCtx);
  }
}

/**
 * 解析并严格校验单个 FILE_ID_BOTH_DIR_INFO 缓冲区页（供真实枚举与畸形缓冲区单元测试共享）：
 * - 对齐检查：offset 必须 8 字节对齐
 * - 头部边界检查：offset + 104 <= bufLen
 * - 文件名长度边界：2 <= fileNameLength <= MAX_WIN32_FILENAME_BYTES，偶数长度，且不越过当前条目边界与总缓冲区
 * - NextEntryOffset 检查：0 或 >= 104 + fileNameLength，8 字节对齐，且不越出总缓冲区（防止越界读、奇数 UTF-16LE 切片或偏移倒退死循环）
 */
export function parseFileIdBothDirBuffer(buf, options = {}) {
  const maxEntries = options.maxEntries ?? 500;
  const entries = [];
  const rejectedNames = [];
  let truncated = false;
  let offset = 0;

  while (true) {
    if (offset < 0 || offset % 8 !== 0 || offset + FILE_ID_BOTH_DIR_FIXED_HEADER_SIZE > buf.length) {
      throw new SafeFsError('ENUM_CORRUPT_BUFFER', 'Directory enumeration buffer offset out of bounds or unaligned', {
        offset,
        bufLength: buf.length,
      });
    }
    const nextOffset = buf.readUInt32LE(offset);
    const fileAttributes = buf.readUInt32LE(offset + 56);
    const fileNameLength = buf.readUInt32LE(offset + 60);
    const fileId = buf.readBigInt64LE(offset + 96);

    if (
      fileNameLength < 2
      || fileNameLength > MAX_WIN32_FILENAME_BYTES
      || fileNameLength % 2 !== 0
      || offset + FILE_ID_BOTH_DIR_FIXED_HEADER_SIZE + fileNameLength > buf.length
    ) {
      throw new SafeFsError('ENUM_CORRUPT_BUFFER', 'Directory entry FileNameLength out of bounds or unaligned', {
        offset,
        fileNameLength,
        bufLength: buf.length,
      });
    }

    if (nextOffset !== 0) {
      if (
        nextOffset < FILE_ID_BOTH_DIR_FIXED_HEADER_SIZE + fileNameLength
        || nextOffset % 8 !== 0
        || offset + nextOffset > buf.length
      ) {
        throw new SafeFsError('ENUM_CORRUPT_BUFFER', 'Directory entry NextEntryOffset invalid, unaligned, or overflows buffer', {
          offset,
          nextOffset,
          minRequired: FILE_ID_BOTH_DIR_FIXED_HEADER_SIZE + fileNameLength,
          bufLength: buf.length,
        });
      }
    }

    const nameStart = offset + FILE_ID_BOTH_DIR_FIXED_HEADER_SIZE;
    const name = buf.toString('utf16le', nameStart, nameStart + fileNameLength);

    if (name !== '.' && name !== '..') {
      const chk = validateEntryName(name);
      if (!chk.valid) {
        rejectedNames.push({ name, reason: chk.reason });
      } else {
        entries.push({
          name,
          isDir: (fileAttributes & FILE_ATTRIBUTE_DIRECTORY) !== 0,
          isReparsePoint: (fileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
          fileAttributes,
          fileId: fileId.toString(),
        });
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
      }
    }
    if (nextOffset === 0) break;
    offset += nextOffset;
  }

  return { entries, rejectedNames, truncated };
}

export function safeListDirRelative(tracker, rootCtx, relDir = '', options = {}) {
  const dirShare = options.dirShare ?? (FILE_SHARE_READ | FILE_SHARE_WRITE);
  const enumBufBytes = Math.max(4096, Math.min(options.enumBufBytes ?? 32768, 262144));
  const maxEntries = options.maxEntries ?? 500;
  const segs = relDir === '' ? [] : splitAndValidateRelSegments(relDir);
  const { parentH, heldHandles } = traverseToParentDir(tracker, rootCtx, segs, dirShare, options);

  try {
    const finalNorm = normalizeWinDosPath(getFinalPathByHandle(parentH));
    assertPathContainment(rootCtx.expectedRootNorm, finalNorm, segs.length === 0);

    const buf = Buffer.alloc(enumBufBytes);
    const entries = [];
    const rejectedNames = [];
    let truncated = false;
    let infoClass = FileIdBothDirectoryRestartInfo;
    let batches = 0;

    while (!truncated) {
      const ok = GetFileInformationByHandleEx(parentH, infoClass, buf, buf.length);
      if (ok === 0) {
        const err = GetLastError();
        if (err === ERROR_NO_MORE_FILES) break;
        throw new SafeFsError('ENUM_FAILED', `GetFileInformationByHandleEx failed (${err})`, { err });
      }
      batches++;
      infoClass = FileIdBothDirectoryInfo;

      const parsed = parseFileIdBothDirBuffer(buf, { maxEntries: maxEntries - entries.length });
      entries.push(...parsed.entries);
      if (parsed.rejectedNames.length > 0) rejectedNames.push(...parsed.rejectedNames);
      if (parsed.truncated || entries.length >= maxEntries) {
        truncated = true;
        break;
      }
    }
    return { entries, rejectedNames, truncated, finalNorm, batches };
  } finally {
    tracker.closeAllReverse(heldHandles);
  }
}
