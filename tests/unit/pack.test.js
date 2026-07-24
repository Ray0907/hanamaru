import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { buildDistribution } from '../../scripts/build.mjs';
import {
  expectedPackFiles,
  inspectTarball,
  npmInvocation,
  resolveNpmCli,
  validatePackFileList,
  verifyInstalledPackage,
  verifyPack,
} from '../../scripts/verify-pack.mjs';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
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

function tarString(header, offset, length, value) {
  Buffer.from(value).copy(header, offset, 0, length);
}

function tarOctal(header, offset, length, value) {
  tarString(header, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function tarArchive(entries, { trailingZeroBlocks = true } = {}) {
  const blocks = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
    const header = Buffer.alloc(512);
    tarString(header, 0, 100, entry.name);
    tarOctal(header, 100, 8, 0o644);
    tarOctal(header, 108, 8, 0);
    tarOctal(header, 116, 8, 0);
    tarOctal(header, 124, 12, entry.size ?? body.length);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    if (entry.linkname) tarString(header, 157, 100, entry.linkname);
    tarString(header, 257, 6, 'ustar\0');
    tarString(header, 263, 2, '00');
    blocks.push(header);
    if (body.length > 0) {
      blocks.push(body);
      const padding = (512 - (body.length % 512)) % 512;
      if (padding > 0) blocks.push(Buffer.alloc(padding));
    }
  }
  if (trailingZeroBlocks) blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function paxRecord(key, value) {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 2;
  while (Buffer.byteLength(`${length} ${payload}`) !== length) {
    length = Buffer.byteLength(`${length} ${payload}`);
  }
  return `${length} ${payload}`;
}

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
    resolveNpmCliImpl: async () => path.resolve('/verified/npm-cli.js'),
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
  const npmCli = path.resolve('/opt/node/lib/node_modules/npm/bin/npm-cli.js');
  const node = path.resolve('/opt/node/bin/node');
  assert.deepEqual(npmInvocation(
    ['pack', '--json', '--pack-destination', output, '%NAME%', '&', '^', '花丸'],
    npmCli,
    node,
  ), {
    args: [
      npmCli,
      'pack',
      '--json',
      '--pack-destination',
      output,
      '%NAME%',
      '&',
      '^',
      '花丸',
    ],
    file: node,
  });
});

test('npm CLI resolution prefers valid environment and Node-install candidates', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-npm-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environmentCli = path.join(root, 'environment', 'npm-cli.js');
  await mkdir(path.dirname(environmentCli), { recursive: true });
  await writeFile(environmentCli, '# fixture');
  assert.equal(
    await resolveNpmCli({
      env: { npm_execpath: environmentCli, PATH: '' },
      execPath: path.join(root, 'node', 'bin', 'node'),
    }),
    await realpath(environmentCli),
  );

  const nodePath = path.join(root, 'runtime', 'bin', 'node');
  const installedCli = path.join(
    root,
    'runtime',
    'lib',
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  await mkdir(path.dirname(installedCli), { recursive: true });
  await writeFile(installedCli, '# fixture');
  assert.equal(
    await resolveNpmCli({ env: { PATH: '' }, execPath: nodePath }),
    await realpath(installedCli),
  );
});

test('npm CLI resolution follows PATH aliases and rejects unresolved configuration', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-npm-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'npm-runtime', 'npm-cli.js');
  const bin = path.join(root, 'bin');
  await mkdir(path.dirname(cli), { recursive: true });
  await mkdir(bin);
  await writeFile(cli, '# fixture');
  await symlink(cli, path.join(bin, 'npm'));
  assert.equal(
    await resolveNpmCli({
      env: { PATH: bin },
      execPath: path.join(root, 'missing-runtime', 'node'),
    }),
    await realpath(cli),
  );
  await assert.rejects(
    resolveNpmCli({
      env: { PATH: '' },
      execPath: path.join(root, 'missing-runtime', 'node'),
      realpathImpl: async () => {
        throw new Error('missing');
      },
    }),
    /pack-verify: npm CLI could not be resolved/u,
  );
});

test('tar inspection accepts only the exact regular file list', () => {
  const tarball = tarArchive(PACK_FILES.map((file) => ({
    body: file,
    name: `package/${file}`,
  })));
  assert.deepEqual(inspectTarball(tarball), PACK_FILES);
});

test('tar inspection accepts safe directories and path metadata for regular files', () => {
  const tarball = tarArchive([
    { name: 'package/', type: '5' },
    {
      name: 'package/pax',
      type: 'x',
      body: paxRecord('path', 'package/LICENSE'),
    },
    { name: 'package/placeholder', body: 'license' },
    { name: 'package/long', type: 'L', body: 'package/README.md\0' },
    { name: 'package/placeholder', body: 'readme' },
  ]);
  assert.deepEqual(inspectTarball(tarball), ['LICENSE', 'README.md']);
});

test('tar inspection rejects links even when their entry names look safe', () => {
  for (const entry of [
    { name: 'package/link', type: '2', linkname: '../../etc/passwd' },
    { name: 'package/hard', type: '1', linkname: '/etc/passwd' },
    { name: 'package/link', type: '2', linkname: 'package/LICENSE' },
    { name: 'package/hard', type: '1', linkname: 'package/LICENSE' },
  ]) {
    assert.throws(
      () => inspectTarball(tarArchive([entry])),
      /pack-verify: tarball (?:link target is unsafe|contains unsupported entry type [12])/u,
    );
  }
});

test('tar inspection rejects unsafe direct, PAX, and GNU paths', () => {
  const attacks = [
    tarArchive([{ name: '/etc/passwd', body: 'x' }]),
    tarArchive([{ name: 'package/../../secret', body: 'x' }]),
    tarArchive([
      {
        name: 'package/pax',
        type: 'x',
        body: paxRecord('path', 'package/../../secret'),
      },
      { name: 'package/safe', body: 'x' },
    ]),
    tarArchive([
      { name: 'package/long', type: 'L', body: 'package/../../secret\0' },
      { name: 'package/safe', body: 'x' },
    ]),
    tarArchive([
      {
        name: 'package/pax-link',
        type: 'x',
        body: paxRecord('linkpath', '/etc/passwd'),
      },
      { name: 'package/safe', type: '2', linkname: 'package/LICENSE' },
    ]),
  ];
  for (const tarball of attacks) {
    assert.throws(
      () => inspectTarball(tarball),
      /pack-verify: tarball (?:entry path|link target) is unsafe/u,
    );
  }
});

test('tar inspection rejects NUL-smuggled header and extended paths', () => {
  for (const tarball of [
    tarArchive([{ name: 'package/safe\0../secret', body: 'x' }]),
    tarArchive([
      {
        name: 'package/pax',
        type: 'x',
        body: paxRecord('path', 'package/safe\0../secret'),
      },
      { name: 'package/safe', body: 'x' },
    ]),
    tarArchive([
      { name: 'package/long', type: 'L', body: 'package/safe\0../secret' },
      { name: 'package/safe', body: 'x' },
    ]),
  ]) {
    assert.throws(
      () => inspectTarball(tarball),
      /pack-verify: tarball entry path is unsafe/u,
    );
  }
});

test('tar inspection rejects devices, FIFO, sparse, and unknown entries', () => {
  for (const type of ['3', '4', '6', 'S', '9']) {
    assert.throws(
      () => inspectTarball(tarArchive([{ name: 'package/unsafe', type }])),
      new RegExp(`pack-verify: tarball contains unsupported entry type ${type}`, 'u'),
    );
  }
});

test('tar inspection rejects duplicate files and truncated bodies', () => {
  assert.throws(
    () => inspectTarball(tarArchive([
      { name: 'package/LICENSE', body: 'first' },
      { name: 'package/LICENSE', body: 'second' },
    ])),
    /duplicate LICENSE/u,
  );
  assert.throws(
    () => inspectTarball(tarArchive(
      [{ name: 'package/LICENSE', size: 10 }],
      { trailingZeroBlocks: false },
    )),
    /pack-verify: tarball is truncated/u,
  );
  assert.throws(
    () => inspectTarball(tarArchive(
      [{ name: 'package/LICENSE', body: 'complete' }],
      { trailingZeroBlocks: false },
    )),
    /pack-verify: tarball is truncated/u,
  );
});

test('verifyPack packs exactly once to the canonical external directory', async (t) => {
  const { output, root } = await fixture(t);
  const calls = [];
  const result = await verifyPack(root, output, successfulOptions(output, calls));
  const canonicalOutput = await import('node:fs/promises').then(({ realpath }) => realpath(output));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, process.execPath);
  assert.equal(path.basename(calls[0].args[0]), 'npm-cli.js');
  assert.deepEqual(calls[0].args.slice(1), [
    'pack',
    '--json',
    '--pack-destination',
    canonicalOutput,
  ]);
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
  const safeExternal = path.join(container, 'safe-external');
  const safeAlias = path.join(container, 'safe-alias');
  await mkdir(safeExternal);
  await symlink(safeExternal, safeAlias, 'dir');
  await writeFile(file, 'fixture');

  for (const output of [undefined, root, child, alias, safeAlias, missing, file]) {
    await assert.rejects(
      verifyPack(root, output, options),
      /pack-verify: output directory/u,
      String(output),
    );
  }
  assert.equal(calls.length, 0);
});

test('verifyPack detects an output directory swapped during npm pack', async (t) => {
  const { output, root } = await fixture(t);
  const trap = path.join(root, 'trap');
  const preserved = `${output}-preserved`;
  await mkdir(trap);
  const calls = [];
  const options = successfulOptions(output, calls, {
    execFileImpl(file, args, execOptions, callback) {
      calls.push({ args, file, options: execOptions });
      void (async () => {
        await rename(output, preserved);
        await symlink(trap, output, 'dir');
        await writeFile(
          path.join(preserved, 'hanamaru-annotations-0.1.0.tgz'),
          ARTIFACT_BYTES,
        );
        callback(null, packJson(), '');
      })().catch(callback);
    },
  });

  await assert.rejects(
    verifyPack(root, output, options),
    /pack-verify: output directory identity changed/u,
  );
  assert.equal(calls.length, 1);
  assert.equal(await stat(output).then((value) => value.isDirectory()), true);
  assert.equal(
    await access(path.join(trap, 'sha512.txt')).then(() => true, () => false),
    false,
  );
  assert.equal(
    await access(path.join(preserved, 'hanamaru-annotations-0.1.0.tgz')).then(
      () => true,
      () => false,
    ),
    true,
  );
});

test('verifyPack detects an output swap between validation stages', async (t) => {
  const { output, root } = await fixture(t);
  const trap = path.join(root, 'trap');
  const preserved = `${output}-preserved`;
  await mkdir(trap);
  const calls = [];
  let swapped = false;
  const assertOutputIdentityImpl = async (identity, phase) => {
    const currentPath = await realpath(identity.path);
    const current = await stat(identity.path);
    if (
      currentPath !== identity.path
      || current.dev !== identity.dev
      || current.ino !== identity.ino
    ) {
      throw new Error('pack-verify: output directory identity changed');
    }
    if (phase === 'after-pack' && !swapped) {
      swapped = true;
      await rename(output, preserved);
      await symlink(trap, output, 'dir');
    }
  };
  const options = successfulOptions(output, calls, { assertOutputIdentityImpl });

  await assert.rejects(
    verifyPack(root, output, options),
    /pack-verify: output directory identity changed/u,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    await access(path.join(trap, 'sha512.txt')).then(() => true, () => false),
    false,
  );
  assert.equal(
    await access(path.join(preserved, 'hanamaru-annotations-0.1.0.tgz')).then(
      () => true,
      () => false,
    ),
    true,
  );
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

test('installed verifier rejects a dependency key before importing the package', async (t) => {
  const installRoot = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-install-check-'));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  const calls = [];
  await assert.rejects(
    verifyInstalledPackage('/artifacts/hanamaru-annotations-0.1.0.tgz', installRoot, {
      execFileImpl(file, args, options, callback) {
        calls.push({ args, file, options });
        void (async () => {
          const packageDirectory = path.join(
            installRoot,
            'node_modules',
            'hanamaru-annotations',
          );
          await mkdir(packageDirectory, { recursive: true });
          await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
            name: 'hanamaru-annotations',
            version: '0.1.0',
            dependencies: {},
          }));
          callback(null, '', '');
        })().catch(callback);
      },
      execPath: process.execPath,
      npmCliPath: '/verified/npm-cli.js',
    }),
    /pack-verify: installed package declares production dependencies/u,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, process.execPath);
  assert.deepEqual(calls[0].args.slice(0, 4), [
    '/verified/npm-cli.js',
    'install',
    '--save-dev',
    '--ignore-scripts',
  ]);
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

test('real pack integration builds, packs, installs, resolves, and verifies externally', {
  timeout: 120_000,
}, async () => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-real-pack-test-'));
  const fixtureRoot = path.join(testRoot, 'project');
  const output = path.join(testRoot, 'artifacts');
  const statusBefore = (await execFileAsync('git', ['status', '--porcelain'], {
    cwd: PROJECT_ROOT,
  })).stdout;
  const residueBefore = (await readdir(PROJECT_ROOT))
    .filter((file) => file.endsWith('.tgz') || file === 'sha512.txt')
    .sort();
  try {
    await mkdir(fixtureRoot);
    await mkdir(output);
    for (const file of ['package.json', 'README.md', 'LICENSE']) {
      await cp(path.join(PROJECT_ROOT, file), path.join(fixtureRoot, file));
    }
    for (const directory of ['src', 'types']) {
      await cp(
        path.join(PROJECT_ROOT, directory),
        path.join(fixtureRoot, directory),
        { recursive: true },
      );
    }
    await symlink(path.join(PROJECT_ROOT, 'node_modules'), path.join(fixtureRoot, 'node_modules'));
    await buildDistribution(fixtureRoot);

    const result = await verifyPack(fixtureRoot, output);
    assert.equal(path.basename(result.artifact), 'hanamaru-annotations-0.1.0.tgz');
    assert.equal(result.fileCount, 33);
    assert.deepEqual(result.verification, {
      css: 2,
      entries: 9,
      productionDependencies: 0,
    });
    assert.equal(
      result.integrity,
      `sha512-${createHash('sha512').update(await readFile(result.artifact)).digest('base64')}`,
    );
    const digestText = await readFile(path.join(output, 'sha512.txt'), 'utf8');
    assert.equal(
      digestText,
      `${createHash('sha512').update(await readFile(result.artifact)).digest('hex')}  ${
        path.basename(result.artifact)
      }\n`,
    );
    if (process.platform === 'darwin') {
      await execFileAsync('shasum', ['-a', '512', '-c', 'sha512.txt'], { cwd: output });
    } else if (process.platform !== 'win32') {
      await execFileAsync('sha512sum', ['-c', 'sha512.txt'], { cwd: output });
    }

  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
  assert.equal(
    (await execFileAsync('git', ['status', '--porcelain'], { cwd: PROJECT_ROOT })).stdout,
    statusBefore,
  );
  assert.deepEqual(
    (await readdir(PROJECT_ROOT))
      .filter((file) => file.endsWith('.tgz') || file === 'sha512.txt')
      .sort(),
    residueBefore,
  );
});
