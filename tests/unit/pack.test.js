import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  expectedPackFiles,
  npmInvocation,
  validatePackFileList,
  verifyPack,
} from '../../scripts/verify-pack.mjs';

const DIST_FILES = Object.freeze([
  '_chunks/runtime-ABC123.js',
  'hanamaru.css',
  'hanamaru.esm.js',
  'hanamaru.iife.js',
  'index.d.ts',
  'size-report.json',
]);
const PACK_FILES = Object.freeze([
  'LICENSE',
  'README.md',
  ...DIST_FILES.map((file) => `dist/${file}`),
  'package.json',
].sort());
const ARTIFACT_BYTES = Buffer.from('fixture tarball bytes');
const ARTIFACT_INTEGRITY = `sha512-${
  createHash('sha512').update(ARTIFACT_BYTES).digest('base64')
}`;

async function fixture(t) {
  const container = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-pack-test-'));
  const root = path.join(container, 'root');
  const output = path.join(container, 'artifacts');
  await mkdir(root);
  await mkdir(output);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'hanamaru-annotations',
    version: '0.1.0',
  }));
  t.after(() => rm(container, { recursive: true, force: true }));
  return { container, output, root };
}

function packJson(overrides = {}) {
  return JSON.stringify([
    {
      filename: 'hanamaru-annotations-0.1.0.tgz',
      files: PACK_FILES.map((file) => ({ path: file })),
      integrity: ARTIFACT_INTEGRITY,
      ...overrides,
    },
  ]);
}

function successfulOptions(output, calls, overrides = {}) {
  return {
    checkBuiltExportsImpl: async () => ({ distFiles: [...DIST_FILES] }),
    execFileImpl(file, args, options, callback) {
      calls.push({ args, file, options });
      void writeFile(
        path.join(output, 'hanamaru-annotations-0.1.0.tgz'),
        ARTIFACT_BYTES,
      ).then(
        () => callback(null, overrides.stdout ?? packJson(), ''),
        callback,
      );
    },
    inspectTarballImpl: async () => [...PACK_FILES],
    verifyInstallImpl: async (_artifact, installRoot) => {
      assert.equal(path.dirname(installRoot), os.tmpdir());
      await access(installRoot);
      return { entries: 9, css: 2, productionDependencies: 0 };
    },
    ...overrides,
  };
}

test('expected pack allowlist is mandatory files plus the validated dist closure', () => {
  assert.deepEqual(expectedPackFiles(DIST_FILES), PACK_FILES);
  assert.deepEqual(validatePackFileList(PACK_FILES, DIST_FILES), PACK_FILES);
});

test('pack allowlist rejects missing mandatory files and every root extra class', () => {
  assert.throws(
    () => validatePackFileList(PACK_FILES.filter((file) => file !== 'package.json'), DIST_FILES),
    /pack-verify: packed file set mismatch \(missing package\.json\)/u,
  );
  for (const extra of [
    'src/index.js',
    'tests/unit/pack.test.js',
    '.env',
    '.npmrc',
    'secret.pem',
    'CHANGELOG.md',
    'demo/index.html',
  ]) {
    assert.throws(
      () => validatePackFileList([...PACK_FILES, extra], DIST_FILES),
      new RegExp(`unexpected ${extra.replaceAll('.', '\\.')}`, 'u'),
      extra,
    );
  }
  assert.throws(
    () => validatePackFileList(PACK_FILES.filter(
      (file) => file !== 'dist/hanamaru.esm.js',
    ), DIST_FILES),
    /missing dist\/hanamaru\.esm\.js/u,
  );
});

test('npm invocation keeps commands and output paths as separate arguments', () => {
  const output = path.resolve('/tmp/hanamaru pack & artifacts');
  assert.deepEqual(npmInvocation(
    ['pack', '--json', '--pack-destination', output],
    'linux',
    {},
  ), {
    args: ['pack', '--json', '--pack-destination', output],
    file: 'npm',
  });
  assert.deepEqual(npmInvocation(
    ['pack', '--json', '--pack-destination', output],
    'win32',
    { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  ), {
    args: [
      '/d',
      '/s',
      '/c',
      'npm.cmd',
      'pack',
      '--json',
      '--pack-destination',
      output,
    ],
    file: 'C:\\Windows\\System32\\cmd.exe',
  });
});

test('verifyPack packs exactly once to the canonical external directory', async (t) => {
  const { output, root } = await fixture(t);
  const calls = [];
  const result = await verifyPack(root, output, successfulOptions(output, calls));
  const canonicalOutput = await import('node:fs/promises').then(({ realpath }) => realpath(output));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'pack',
    '--json',
    '--pack-destination',
    canonicalOutput,
  ]);
  assert.equal(calls[0].file, 'npm');
  assert.equal(calls[0].options.cwd, await import('node:fs/promises').then(
    ({ realpath }) => realpath(root),
  ));
  assert.equal(result.artifact, path.join(canonicalOutput, 'hanamaru-annotations-0.1.0.tgz'));
  assert.equal(result.integrity, ARTIFACT_INTEGRITY);
  assert.equal(result.fileCount, PACK_FILES.length);
  assert.deepEqual(result.verification, {
    css: 2,
    entries: 9,
    productionDependencies: 0,
  });
  const hex = createHash('sha512').update(ARTIFACT_BYTES).digest('hex');
  assert.equal(
    await readFile(path.join(output, 'sha512.txt'), 'utf8'),
    `${hex}  hanamaru-annotations-0.1.0.tgz\n`,
  );
});

test('verifyPack rejects unsafe output paths before invoking npm', async (t) => {
  const { container, root } = await fixture(t);
  const calls = [];
  const options = successfulOptions(path.join(container, 'unused'), calls);
  const child = path.join(root, 'artifacts');
  await mkdir(child);
  const alias = path.join(container, 'root-alias');
  await symlink(child, alias, 'dir');
  const missing = path.join(container, 'missing');
  const file = path.join(container, 'not-a-directory');
  await writeFile(file, 'fixture');

  for (const output of [undefined, root, child, alias, missing, file]) {
    await assert.rejects(
      verifyPack(root, output, options),
      /pack-verify: output directory/u,
      String(output),
    );
  }
  assert.equal(calls.length, 0);
});

test('verifyPack rejects non-empty output directories before invoking npm', async (t) => {
  const { output, root } = await fixture(t);
  await writeFile(path.join(output, 'stale.txt'), 'stale');
  const calls = [];
  await assert.rejects(
    verifyPack(root, output, successfulOptions(output, calls)),
    /pack-verify: output directory must be empty/u,
  );
  assert.equal(calls.length, 0);
});

test('verifyPack rejects wrong filenames and multiple npm pack results', async (t) => {
  for (const [name, stdout, pattern] of [
    [
      'wrong filename',
      packJson({ filename: 'other-0.1.0.tgz' }),
      /pack-verify: unexpected tarball filename other-0\.1\.0\.tgz/u,
    ],
    [
      'multiple results',
      JSON.stringify([JSON.parse(packJson())[0], JSON.parse(packJson())[0]]),
      /pack-verify: npm pack must return exactly one result/u,
    ],
  ]) {
    await t.test(name, async (child) => {
      const { output, root } = await fixture(child);
      const calls = [];
      await assert.rejects(
        verifyPack(root, output, successfulOptions(output, calls, { stdout })),
        pattern,
      );
      assert.equal(calls.length, 1);
      assert.equal(
        await access(path.join(output, 'hanamaru-annotations-0.1.0.tgz')).then(
          () => true,
          () => false,
        ),
        true,
        'caller artifact is retained after validation failure',
      );
    });
  }
});

test('verifyPack rejects metadata integrity and actual tar file-list mismatches', async (t) => {
  await t.test('integrity', async (child) => {
    const { output, root } = await fixture(child);
    const calls = [];
    await assert.rejects(
      verifyPack(
        root,
        output,
        successfulOptions(output, calls, {
          stdout: packJson({ integrity: 'sha512-not-the-artifact' }),
        }),
      ),
      /pack-verify: tarball integrity mismatch/u,
    );
    assert.equal(calls.length, 1);
  });
  await t.test('actual archive file list', async (child) => {
    const { output, root } = await fixture(child);
    const calls = [];
    await assert.rejects(
      verifyPack(
        root,
        output,
        successfulOptions(output, calls, {
          inspectTarballImpl: async () => [...PACK_FILES, 'src/index.js'],
        }),
      ),
      /pack-verify: tarball contents differ from npm pack metadata/u,
    );
    assert.equal(calls.length, 1);
  });
});

test('verifyPack always cleans internal install roots and retains caller artifacts', async (t) => {
  for (const fail of [false, true]) {
    await t.test(fail ? 'install failure' : 'success', async (child) => {
      const { output, root } = await fixture(child);
      const calls = [];
      let installRoot;
      const options = successfulOptions(output, calls, {
        verifyInstallImpl: async (_artifact, directory) => {
          installRoot = directory;
          await writeFile(path.join(directory, 'probe'), 'fixture');
          if (fail) throw new Error('fixture install failure');
          return { entries: 9, css: 2, productionDependencies: 0 };
        },
      });
      if (fail) {
        await assert.rejects(verifyPack(root, output, options), /fixture install failure/u);
      } else {
        await verifyPack(root, output, options);
      }
      assert.equal(await access(installRoot).then(() => true, () => false), false);
      assert.equal(
        await access(path.join(output, 'hanamaru-annotations-0.1.0.tgz')).then(
          () => true,
          () => false,
        ),
        true,
      );
      assert.equal(
        await access(path.join(output, 'sha512.txt')).then(() => true, () => false),
        true,
      );
      assert.deepEqual(
        (await readdir(root)).filter((file) => file.endsWith('.tgz') || file === 'sha512.txt'),
        [],
      );
      assert.equal(calls.length, 1);
    });
  }
});

test('pack verification leaves the fixed verify stages and production tree unchanged', async () => {
  const packageJson = JSON.parse(await readFile(
    new URL('../../package.json', import.meta.url),
    'utf8',
  ));
  assert.equal(
    packageJson.scripts.verify,
    'npm run test:unit && npm run test:types && npm run build && npm run check:dist && npm run test:e2e:chromium && npm run test:e2e:smoke && npm run test:adapters',
  );
  assert.equal(Object.hasOwn(packageJson, 'dependencies'), false);
});
