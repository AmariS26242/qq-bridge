import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveBridgeNode } from './bridge-node.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-node-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = path.join(dir, 'node22.exe');
  const current = path.join(dir, 'node24.exe');
  fs.writeFileSync(old, 'fixture'); fs.writeFileSync(current, 'fixture');
  return { old, current };
}

test('a Node 22 candidate cannot shadow a compatible runtime', t => {
  const { old, current } = fixture(t);
  const visited = [];
  const selected = resolveBridgeNode({ override: '', candidates: [old, current], probe: candidate => {
    visited.push(candidate); return candidate === current;
  } });
  assert.equal(selected, current);
  assert.deepEqual(visited, [old, current]);
});

test('an incompatible explicit override fails instead of silently using another runtime', t => {
  const { old, current } = fixture(t);
  assert.throws(() => resolveBridgeNode({ override: old, candidates: [current], probe: candidate => candidate === current }), /QQ_BRIDGE_NODE24_REQUIRED/);
});

test('no compatible candidate fails before a bridge can be spawned', t => {
  const { old } = fixture(t);
  assert.throws(() => resolveBridgeNode({ override: '', candidates: [old], probe: () => false }), /QQ_BRIDGE_NODE24_REQUIRED/);
});

test('the selected local runtime really supports the EA2 SQLite API', () => {
  const executable = resolveBridgeNode();
  const result = execFileSync(executable, ['--input-type=module', '-e', `
    import { DatabaseSync, backup } from 'node:sqlite';
    if (Number(process.versions.node.split('.')[0]) !== 24) process.exit(1);
    const db = new DatabaseSync(':memory:'); db.close();
    console.log(typeof backup);
  `], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.trim(), 'function');
});
