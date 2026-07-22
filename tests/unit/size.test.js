import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkDistribution, npmInvocationFor } from '../../scripts/check-size.mjs';

async function createDistribution(pkg = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-size-'));
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
  await writeFile(path.join(root, 'dist', 'hanamaru.esm.js'), 'export{}');
  await writeFile(path.join(root, 'dist', 'hanamaru.iife.js'), 'var Hanamaru={};');
  await writeFile(path.join(root, 'dist', 'hanamaru.css'), '');
  return root;
}

test('checkDistribution rejects a dependencies key even when empty', async (t) => {
  const root = await createDistribution({ dependencies: {} });
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(checkDistribution(root, { checkNpmTree: false }), /dependencies key/);
});

test('checkDistribution rejects deterministic incompressible output over the hard budget', async (t) => {
  const root = await createDistribution({});
  t.after(() => rm(root, { recursive: true, force: true }));

  const bytes = new Uint8Array(20_000);
  let state = 0x12345678;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state >>> 0;
  }
  await writeFile(path.join(root, 'dist', 'hanamaru.esm.js'), bytes);

  await assert.rejects(checkDistribution(root, { checkNpmTree: false }), /exceeds 8192/);
});

test('checkDistribution returns ESM then IIFE metric rows', async (t) => {
  const root = await createDistribution({});
  t.after(() => rm(root, { recursive: true, force: true }));

  const rows = await checkDistribution(root, { checkNpmTree: false });

  assert.deepEqual(rows.map((row) => row.file), ['hanamaru.esm.js', 'hanamaru.iife.js']);
});

test('checkDistribution runs npm through cmd.exe on Windows', async (t) => {
  const root = await createDistribution({});
  t.after(() => rm(root, { recursive: true, force: true }));
  let invocation;

  const rows = await checkDistribution(root, {
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    execFileImpl(file, args, options, callback) {
      invocation = { file, args, options };
      callback(null, JSON.stringify({}), '');
    },
  });

  assert.deepEqual(invocation, {
    file: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', 'npm.cmd ls --omit=dev --json'],
    options: { cwd: root },
  });
  assert.equal(rows.length, 2);
});

test('npmInvocationFor uses a static command on each platform', () => {
  assert.deepEqual(npmInvocationFor('linux'), {
    file: 'npm',
    args: ['ls', '--omit=dev', '--json'],
  });
  assert.deepEqual(npmInvocationFor('win32', {}), {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npm.cmd ls --omit=dev --json'],
  });
});

test('checkDistribution validates the actual production npm tree by default', async (t) => {
  const root = await createDistribution({});
  t.after(() => rm(root, { recursive: true, force: true }));

  const rows = await checkDistribution(root);

  assert.equal(rows.length, 2);
});
