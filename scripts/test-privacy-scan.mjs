import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-publication-privacy-'));
try {
  fs.mkdirSync(path.join(fixture, 'scripts'));
  fs.copyFileSync(new URL('./privacy-scan.mjs', import.meta.url), path.join(fixture, 'scripts/privacy-scan.mjs'));
  fs.writeFileSync(path.join(fixture, 'scripts/privacy-rules.json'), JSON.stringify({
    deny: [{ name: 'custom numeric identity', pattern: '424242424', flags: '' }],
  }));
  fs.writeFileSync(path.join(fixture, 'fixture.txt'), [
    'f'.repeat(40), // Noise must not pin a non-global regex at its first match.
    'secret: "PUBLIC_FIXTURE_NOT_A_REAL_SECRET_12345"',
    '424242424',
    'C:\\Users\\fixture-private-user\\project',
  ].join('\n'));
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts/privacy-scan.mjs'), '--json'], {
    cwd: fixture, encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const findings = JSON.parse(result.stdout).findings;
  assert.ok(findings.some((f) => f.rule === 'custom numeric identity' && f.line === 3));
  assert.ok(findings.some((f) => f.line === 2));
  assert.ok(findings.some((f) => f.line === 4));
  assert.equal(new Set(findings.map((f) => `${f.file}:${f.rule}:${f.line}`)).size, findings.length);
  assert.ok(!result.stdout.includes('PUBLIC_FIXTURE_NOT_A_REAL_SECRET_12345'));
  console.log('PASS privacy scan advances past noise, detects numeric rules and masks findings');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
