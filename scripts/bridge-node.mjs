// Select a compatible runtime for qq-bridge and EA2 without changing SnowLuma's runtime.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const probeSource = `
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 14) process.exit(1);
  const sqlite = await import('node:sqlite');
  if (typeof sqlite.DatabaseSync !== 'function' || typeof sqlite.backup !== 'function') process.exit(1);
`;

function supportsBridge(executable) {
  try {
    execFileSync(executable, ['--input-type=module', '-e', probeSource], {
      timeout: 10000, windowsHide: true, stdio: 'ignore'
    });
    return true;
  } catch { return false; }
}

function defaultCandidates() {
  const userDir = os.homedir();
  const localDir = process.env.LOCALAPPDATA || path.join(userDir, 'AppData', 'Local');
  return [
    path.join(localDir, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    path.join(userDir, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    process.execPath
  ];
}

export function resolveBridgeNode({ override = process.env.QQBRIDGE_NODE_EXE, candidates = defaultCandidates(), probe = supportsBridge } = {}) {
  const explicit = String(override ?? '').trim();
  const choices = [...new Set(explicit ? [explicit] : candidates)];
  for (const executable of choices) {
    if (fs.existsSync(executable) && probe(executable)) return executable;
  }
  throw new Error('QQ_BRIDGE_NODE24_REQUIRED: Node 24.14+ (major 24) with node:sqlite.backup is required; set QQBRIDGE_NODE_EXE to a compatible node.exe');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(resolveBridgeNode()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
