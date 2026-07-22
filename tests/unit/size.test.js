import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkDistribution,
  measureDistribution,
  npmInvocationFor,
  writeSizeReport,
} from '../../scripts/check-size.mjs';

async function createDistribution(pkg = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-size-'));
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
  await writeFile(path.join(root, 'dist', 'hanamaru.esm.js'), 'export{}');
  await writeFile(path.join(root, 'dist', 'hanamaru.iife.js'), 'var Hanamaru={};');
  await writeFile(path.join(root, 'dist', 'hanamaru.css'), '');
  return root;
}

function deterministicNoise(length) {
  const bytes = new Uint8Array(length);
  let state = 0x12345678;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state >>> 0;
  }
  return bytes;
}

test('checkDistribution rejects a dependencies key even when empty', async (t) => {
  const root = await createDistribution({ dependencies: {} });
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(checkDistribution(root, { checkNpmTree: false }), /dependencies key/);
});

test('checkDistribution rejects deterministic incompressible output over the hard budget', async (t) => {
  const root = await createDistribution({});
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(path.join(root, 'dist', 'hanamaru.esm.js'), deterministicNoise(30_000));

  await assert.rejects(
    checkDistribution(root, { checkNpmTree: false }),
    /exceeds 20480 combined gzip bytes/,
  );
});

test('checkDistribution accepts 20480 combined gzip bytes and rejects 20481', async (t) => {
  const atLimit = await createDistribution({});
  const overLimit = await createDistribution({});
  t.after(() => rm(atLimit, { recursive: true, force: true }));
  t.after(() => rm(overLimit, { recursive: true, force: true }));

  await writeFile(
    path.join(atLimit, 'dist', 'hanamaru.esm.js'),
    deterministicNoise(20_432),
  );
  await writeFile(
    path.join(overLimit, 'dist', 'hanamaru.esm.js'),
    deterministicNoise(20_433),
  );

  const rows = await checkDistribution(atLimit, { checkNpmTree: false });

  assert.equal(rows[0].combined, 20_480);
  await assert.rejects(
    checkDistribution(overLimit, { checkNpmTree: false }),
    {
      message:
        'dist-check: hanamaru.esm.js exceeds 20480 combined gzip bytes (20481)',
    },
  );
});

test('checkDistribution reports combined stretch status for both formats', async (t) => {
  const root = await createDistribution({});
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'dist', 'hanamaru.esm.js'),
    deterministicNoise(18_384),
  );
  await writeFile(
    path.join(root, 'dist', 'hanamaru.iife.js'),
    deterministicNoise(18_385),
  );

  const rows = await checkDistribution(root, { checkNpmTree: false });

  assert.deepEqual(rows.map((row) => row.file), ['hanamaru.esm.js', 'hanamaru.iife.js']);
  assert.deepEqual(
    rows.map(({ combined, stretch }) => ({ combined, stretch })),
    [
      { combined: 18_432, stretch: true },
      { combined: 18_433, stretch: false },
    ],
  );
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

test('size report uses one deterministic schema for measure, write, and check', async (t) => {
  const root = await createDistribution({});
  t.after(() => rm(root, { recursive: true, force: true }));

  const measured = await measureDistribution(root);
  const written = await writeSizeReport(root, measured);
  const expected = `${JSON.stringify({
    budgets: {
      hardCombinedGzip: 20_480,
      stretchCombinedGzip: 18_432,
    },
    css: measured.css,
    formats: measured.formats,
    schemaVersion: 1,
  }, null, 2)}\n`;

  assert.equal(written, expected);
  assert.equal(await readFile(path.join(root, 'dist', 'size-report.json'), 'utf8'), expected);
  assert.deepEqual(Object.keys(JSON.parse(written).formats[0]), [
    'combined',
    'cssGzip',
    'file',
    'gzip',
    'raw',
    'stretch',
  ]);
  const rows = await checkDistribution(root, { checkNpmTree: false });
  assert.deepEqual(rows, measured.formats);
  assert.equal(await readFile(path.join(root, 'dist', 'size-report.json'), 'utf8'), expected);
});

test('size report excludes its own bytes and check rewrites stale metadata', async (t) => {
  const root = await createDistribution({});
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'dist', 'size-report.json'), '{"stale":true}\n');

  const before = await measureDistribution(root);
  await writeFile(path.join(root, 'dist', 'size-report.json'), 'x'.repeat(100_000));
  const after = await measureDistribution(root);
  assert.deepEqual(after, before);

  await checkDistribution(root, { checkNpmTree: false });
  const rewritten = JSON.parse(await readFile(path.join(root, 'dist', 'size-report.json'), 'utf8'));
  assert.deepEqual(rewritten.formats, before.formats);
  assert.deepEqual(rewritten.css, before.css);
});
