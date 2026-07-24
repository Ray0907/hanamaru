import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  open,
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
import { gunzipSync, gzipSync } from 'node:zlib';
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
const SOURCE_IDENTITY = Object.freeze({
  name: 'hanamaru-annotations',
  version: '0.1.0',
});

function tarString(header, offset, length, value) {
  Buffer.from(value).copy(header, offset, 0, length);
}

function tarOctal(header, offset, length, value) {
  tarString(header, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function writeTarChecksum(header) {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  tarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
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
    if (entry.format === 'gnu') {
      tarString(header, 257, 6, 'ustar ');
      tarString(header, 263, 2, ' \0');
    } else if (entry.format === 'unknown') {
      tarString(header, 257, 6, 'weird!');
      tarString(header, 263, 2, '00');
    } else {
      tarString(header, 257, 6, 'ustar\0');
      tarString(header, 263, 2, '00');
    }
    if (entry.prefix) tarString(header, 345, 155, entry.prefix);
    writeTarChecksum(header);
    blocks.push(header);
    if (body.length > 0) {
      blocks.push(body);
      const padding = (512 - (body.length % 512)) % 512;
      if (padding > 0) blocks.push(Buffer.alloc(padding));
    }
  }
  const zeroBlockCount = trailingZeroBlocks === true ? 2 : (trailingZeroBlocks || 0);
  if (zeroBlockCount > 0) blocks.push(Buffer.alloc(512 * zeroBlockCount));
  return gzipSync(Buffer.concat(blocks));
}

function mutateTarHeader(tarball, mutate, headerOffset = 0) {
  const archive = gunzipSync(tarball);
  mutate(archive.subarray(headerOffset, headerOffset + 512));
  return gzipSync(archive);
}

function paxRecord(key, value) {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 2;
  while (Buffer.byteLength(`${length} ${payload}`) !== length) {
    length = Buffer.byteLength(`${length} ${payload}`);
  }
  return `${length} ${payload}`;
}

function malformedPaxLengthRecord(key, value) {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 3;
  while (Buffer.byteLength(`${length}x ${payload}`) !== length) {
    length = Buffer.byteLength(`${length}x ${payload}`);
  }
  return `${length}x ${payload}`;
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
      name: 'hanamaru-annotations',
      version: '0.1.0',
      ...overrides,
    },
  ]);
}

function successfulOptions(_output, calls, overrides = {}) {
  return {
    checkBuiltExportsImpl: async () => ({ distFiles: [...DIST_FILES] }),
    execFileImpl(file, args, options, callback) {
      calls.push({ args, file, options });
      void writeFile(
        path.join(args.at(-1), 'hanamaru-annotations-0.1.0.tgz'),
        ARTIFACT_BYTES,
      ).then(
        () => callback(null, overrides.stdout ?? packJson(), ''),
        callback,
      );
    },
    inspectTarballImpl: async () => [...PACK_FILES],
    resolveNpmCliImpl: async () => path.resolve('/verified/npm-cli.js'),
    verifyInstallImpl: async (artifact, installRoot) => {
      assert.equal(path.dirname(installRoot), os.tmpdir());
      assert.equal(path.dirname(artifact), installRoot);
      assert.deepEqual(await readFile(artifact), ARTIFACT_BYTES);
      await access(installRoot);
      return { entries: 9, css: 2, productionDependencies: 0 };
    },
    ...overrides,
  };
}

function installedVerifierExec(installRoot, calls, options = {}) {
  const packedManifest = {
    name: 'hanamaru-annotations',
    version: '0.1.0',
    ...(options.packedManifest ?? {}),
  };
  const productionTree = options.productionTree ?? {
    dependencies: {
      'hanamaru-annotations': {
        version: '0.1.0',
      },
    },
  };
  let installCalls = 0;
  return (file, args, execOptions, callback) => {
    calls.push({ args, file, options: execOptions });
    void (async () => {
      if (args[1] === 'install') {
        installCalls += 1;
        if (installCalls === 1) {
          const packageDirectory = path.join(
            installRoot,
            'node_modules',
            'hanamaru-annotations',
          );
          await mkdir(packageDirectory, { recursive: true });
          await writeFile(
            path.join(packageDirectory, 'package.json'),
            JSON.stringify(packedManifest),
          );
          await writeFile(path.join(installRoot, 'package.json'), JSON.stringify({
            name: 'hanamaru-pack-verification',
            private: true,
            type: 'module',
            dependencies: {
              'hanamaru-annotations': 'file:hanamaru-annotations-0.1.0.tgz',
            },
          }));
        }
        callback(null, '', '');
        return;
      }
      if (args[1] === 'ls') {
        callback(null, JSON.stringify(productionTree), '');
        return;
      }
      callback(null, '', '');
    })().catch(callback);
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

test('tar inspection validates checksums and recognized archive layouts', () => {
  assert.deepEqual(inspectTarball(tarArchive([
    {
      name: 'LICENSE',
      prefix: 'package',
      body: 'ustar-prefix',
    },
    {
      name: 'package/README.md',
      prefix: '../../ignored-for-gnu',
      format: 'gnu',
      body: 'gnu-name',
    },
  ])), ['LICENSE', 'README.md']);

  const checksumMutation = mutateTarHeader(
    tarArchive([{ name: 'package/LICENSE', body: 'license' }]),
    (header) => {
      header[0] ^= 1;
    },
  );
  assert.throws(
    () => inspectTarball(checksumMutation),
    /pack-verify: tarball header checksum mismatch/u,
  );
  assert.throws(
    () => inspectTarball(tarArchive([
      { name: 'package/LICENSE', format: 'unknown', body: 'license' },
    ])),
    /pack-verify: tarball has an unsupported header format/u,
  );
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

test('tar inspection rejects malformed PAX lengths and global headers', () => {
  for (const tarball of [
    tarArchive([
      {
        name: 'package/pax',
        type: 'x',
        body: malformedPaxLengthRecord('path', 'package/LICENSE'),
      },
      { name: 'package/placeholder', body: 'license' },
    ]),
    tarArchive([
      {
        name: 'package/global',
        type: 'g',
        body: paxRecord('path', 'package/LICENSE'),
      },
      { name: 'package/placeholder', body: 'license' },
    ]),
  ]) {
    assert.throws(
      () => inspectTarball(tarball),
      /pack-verify: tarball (?:has invalid extended metadata|contains unsupported entry type g)/u,
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
  assert.throws(
    () => inspectTarball(tarArchive(
      [{ name: 'package/LICENSE', body: 'complete' }],
      { trailingZeroBlocks: 1 },
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
  assert.deepEqual(calls[0].args.slice(1, -1), [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
  ]);
  const pinnedOutput = calls[0].args.at(-1);
  assert.equal(path.dirname(pinnedOutput), path.dirname(canonicalOutput));
  assert.match(
    path.basename(pinnedOutput),
    /^\.artifacts\.hanamaru-[A-Za-z0-9-]+$/u,
  );
  assert.notEqual(pinnedOutput, canonicalOutput);
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

test('verifyPack rejects unsafe release identities before invoking npm pack', async (t) => {
  const { output, root } = await fixture(t);
  const calls = [];
  const invalidManifests = [
    { name: '../../../hanamaru-annotations', version: '0.1.0' },
    { name: 'hanamaru/annotations', version: '0.1.0' },
    { name: 'hanamaru\\annotations', version: '0.1.0' },
    { name: 'other-package', version: '0.1.0' },
    { name: 'hanamaru-annotations', version: '../../../0.1.0' },
    { name: 'hanamaru-annotations', version: '0.1.0/../../escape' },
    { name: 'hanamaru-annotations', version: '0.1.0\\escape' },
    { name: 'hanamaru-annotations', version: '01.0.0' },
    { name: 'hanamaru-annotations', version: '0.1.0\0escape' },
  ];
  for (const manifest of invalidManifests) {
    await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(
      verifyPack(root, output, successfulOptions(output, calls)),
      /pack-verify: package (?:name must be hanamaru-annotations|version is not valid SemVer 2\.0\.0)/u,
      JSON.stringify(manifest),
    );
  }
  assert.equal(calls.length, 0);
});

test('verifyPack detects an output directory swapped during npm pack', async (t) => {
  const { output, root } = await fixture(t);
  const trap = path.join(root, 'trap');
  let preserved;
  await mkdir(trap);
  const calls = [];
  const options = successfulOptions(output, calls, {
    execFileImpl(file, args, execOptions, callback) {
      calls.push({ args, file, options: execOptions });
      void (async () => {
        const pinnedOutput = args.at(-1);
        preserved = `${pinnedOutput}-preserved`;
        await rename(pinnedOutput, preserved);
        await symlink(trap, pinnedOutput, 'dir');
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
  assert.equal(await access(output).then(() => true, () => false), false);
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
  let preserved;
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
      preserved = `${identity.path}-preserved`;
      await rename(identity.path, preserved);
      await symlink(trap, identity.path, 'dir');
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

test('verifyPack never reads a trap artifact swapped in after parent validation', async (t) => {
  const { output, root } = await fixture(t);
  const trap = path.join(root, 'trap');
  let preserved;
  await mkdir(trap);
  const calls = [];
  let inspectCalls = 0;
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
    if (phase === 'before-artifact-read' && !swapped) {
      swapped = true;
      preserved = `${identity.path}-preserved`;
      await rename(identity.path, preserved);
      await symlink(trap, identity.path, 'dir');
      await writeFile(
        path.join(trap, 'hanamaru-annotations-0.1.0.tgz'),
        ARTIFACT_BYTES,
      );
    }
  };
  const options = successfulOptions(output, calls, {
    assertOutputIdentityImpl,
    inspectTarballImpl: async () => {
      inspectCalls += 1;
      return [...PACK_FILES];
    },
  });

  await assert.rejects(
    verifyPack(root, output, options),
    /pack-verify: output directory identity changed/u,
  );
  assert.equal(calls.length, 1);
  assert.equal(inspectCalls, 0);
  assert.equal(
    await access(path.join(trap, 'sha512.txt')).then(() => true, () => false),
    false,
  );
  assert.equal(
    await access(path.join(preserved, 'sha512.txt')).then(() => true, () => false),
    true,
  );
});

test('verifyPack writes digest content only through its identity-bound handle', async (t) => {
  const { output, root } = await fixture(t);
  const trap = path.join(root, 'trap');
  let preserved;
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
    if (phase === 'before-digest-write' && !swapped) {
      swapped = true;
      preserved = `${identity.path}-preserved`;
      await rename(identity.path, preserved);
      await symlink(trap, identity.path, 'dir');
    }
  };

  await assert.rejects(
    verifyPack(
      root,
      output,
      successfulOptions(output, calls, { assertOutputIdentityImpl }),
    ),
    /pack-verify: output directory identity changed/u,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    await access(path.join(trap, 'sha512.txt')).then(() => true, () => false),
    false,
  );
  assert.match(
    await readFile(path.join(preserved, 'sha512.txt'), 'utf8'),
    /^[a-f0-9]{128} {2}hanamaru-annotations-0\.1\.0\.tgz\n$/u,
  );
});

test('verifyPack binds install and return verification to exact artifact identities and bytes', async (t) => {
  for (const mutation of [
    { phase: 'before-install', target: 'artifact', replacement: true },
    { phase: 'before-install', target: 'digest', replacement: true },
    { phase: 'before-install', target: 'artifact', replacement: false },
    { phase: 'before-return', target: 'digest', replacement: false },
    { phase: 'after-restore', target: 'artifact', replacement: false },
  ]) {
    await t.test(
      `${mutation.phase} ${mutation.target} ${
        mutation.replacement ? 'replacement' : 'in-place mutation'
      }`,
      async (child) => {
        const { output, root } = await fixture(child);
        const calls = [];
        let installCalls = 0;
        let mutated = false;
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
          if (phase !== mutation.phase || mutated) return;
          mutated = true;
          const filename = mutation.target === 'artifact'
            ? 'hanamaru-annotations-0.1.0.tgz'
            : 'sha512.txt';
          const target = path.join(identity.path, filename);
          if (mutation.replacement) {
            await rename(target, path.join(root, `${filename}.original`));
          }
          await writeFile(target, `mutated ${mutation.target}`);
        };
        const options = successfulOptions(output, calls, {
          assertOutputIdentityImpl,
          verifyInstallImpl: async (artifact, installRoot) => {
            installCalls += 1;
            assert.equal(path.dirname(artifact), installRoot);
            assert.deepEqual(await readFile(artifact), ARTIFACT_BYTES);
            return { entries: 9, css: 2, productionDependencies: 0 };
          },
        });

        await assert.rejects(
          verifyPack(root, output, options),
          /pack-verify: (?:artifact|digest) (?:identity|content) changed/u,
        );
        assert.equal(calls.length, 1);
        assert.equal(
          installCalls,
          mutation.phase === 'before-install' ? 0 : 1,
          'caller bytes are never installed after a pre-install mutation',
        );
      },
    );
  }
});

test('verifyPack seals every final output directory stage to two expected files', async (t) => {
  for (const scenario of [
    { phase: 'during-pack', type: 'regular' },
    { phase: 'before-install', type: 'tgz' },
    { phase: 'before-return', type: 'symlink' },
    { phase: 'before-return', type: 'nested-secret' },
    { phase: 'after-restore', type: 'secret' },
  ]) {
    await t.test(`${scenario.phase} ${scenario.type}`, async (child) => {
      const { output, root } = await fixture(child);
      const calls = [];
      let installCalls = 0;
      let added = false;
      const addExtra = async (directory) => {
        if (added) return;
        added = true;
        if (scenario.type === 'tgz') {
          await writeFile(path.join(directory, 'unexpected-1.0.0.tgz'), 'extra tarball');
        } else if (scenario.type === 'symlink') {
          await symlink(path.join(root, 'package.json'), path.join(directory, 'extra-link'));
        } else if (scenario.type === 'nested-secret') {
          await mkdir(path.join(directory, 'nested'));
          await writeFile(path.join(directory, 'nested', 'secret.pem'), 'secret');
        } else {
          await writeFile(
            path.join(directory, scenario.type === 'secret' ? '.env' : 'extra.txt'),
            'unexpected',
          );
        }
      };
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
        if (phase === scenario.phase) await addExtra(identity.path);
      };
      const overrides = {
        assertOutputIdentityImpl,
        verifyInstallImpl: async (artifact, installRoot) => {
          installCalls += 1;
          assert.equal(path.dirname(artifact), installRoot);
          assert.deepEqual(await readFile(artifact), ARTIFACT_BYTES);
          return { entries: 9, css: 2, productionDependencies: 0 };
        },
      };
      if (scenario.phase === 'during-pack') {
        overrides.execFileImpl = (file, args, execOptions, callback) => {
          calls.push({ args, file, options: execOptions });
          void (async () => {
            const destination = args.at(-1);
            await writeFile(
              path.join(destination, 'hanamaru-annotations-0.1.0.tgz'),
              ARTIFACT_BYTES,
            );
            await addExtra(destination);
            callback(null, packJson(), '');
          })().catch(callback);
        };
      }

      await assert.rejects(
        verifyPack(root, output, successfulOptions(output, calls, overrides)),
        /pack-verify: output directory entries changed/u,
      );
      assert.equal(calls.length, 1);
      assert.equal(
        installCalls,
        ['during-pack', 'before-install'].includes(scenario.phase) ? 0 : 1,
      );
    });
  }
});

test('verifyPack never overwrites an occupied caller path while restoring', async (t) => {
  const { output, root } = await fixture(t);
  const calls = [];
  let occupied = false;
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
    if (phase === 'before-return' && !occupied) {
      occupied = true;
      await mkdir(identity.finalPath);
      await writeFile(path.join(identity.finalPath, 'attacker.txt'), 'do not overwrite');
    }
  };

  await assert.rejects(
    verifyPack(
      root,
      output,
      successfulOptions(output, calls, { assertOutputIdentityImpl }),
    ),
    /pack-verify: output directory could not be restored safely/u,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    await readFile(path.join(output, 'attacker.txt'), 'utf8'),
    'do not overwrite',
  );
  const pinnedOutput = calls[0].args.at(-1);
  assert.equal(
    await access(path.join(pinnedOutput, 'hanamaru-annotations-0.1.0.tgz')).then(
      () => true,
      () => false,
    ),
    true,
  );
  assert.match(
    await readFile(path.join(pinnedOutput, 'sha512.txt'), 'utf8'),
    /^[a-f0-9]{128} {2}hanamaru-annotations-0\.1\.0\.tgz\n$/u,
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
      'traversal filename',
      packJson({ filename: '../../../hanamaru-annotations-0.1.0.tgz' }),
      /pack-verify: npm pack returned an unsafe tarball filename/u,
    ],
    [
      'slash filename',
      packJson({ filename: 'nested/hanamaru-annotations-0.1.0.tgz' }),
      /pack-verify: npm pack returned an unsafe tarball filename/u,
    ],
    [
      'backslash filename',
      packJson({ filename: 'nested\\hanamaru-annotations-0.1.0.tgz' }),
      /pack-verify: npm pack returned an unsafe tarball filename/u,
    ],
    [
      'NUL filename',
      packJson({ filename: 'hanamaru-annotations-0.1.0.tgz\0escape' }),
      /pack-verify: npm pack returned an unsafe tarball filename/u,
    ],
    [
      'missing name metadata',
      packJson({ name: undefined }),
      /pack-verify: npm pack package identity mismatch/u,
    ],
    [
      'wrong name metadata',
      packJson({ name: 'other-package' }),
      /pack-verify: npm pack package identity mismatch/u,
    ],
    [
      'missing version metadata',
      packJson({ version: undefined }),
      /pack-verify: npm pack package identity mismatch/u,
    ],
    [
      'wrong version metadata',
      packJson({ version: '0.1.1' }),
      /pack-verify: npm pack package identity mismatch/u,
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

test('verifyPack preserves primary failures when artifact close or install cleanup also fails', async (t) => {
  await t.test('artifact read plus close', async (child) => {
    const { output, root } = await fixture(child);
    const calls = [];
    const readError = new Error('fixture artifact read failure');
    const closeError = new Error('fixture artifact close failure');
    const openImpl = async (candidate, flags, mode) => {
      const handle = await open(candidate, flags, mode);
      if (!candidate.endsWith('.tgz')) return handle;
      return {
        close: async () => {
          await handle.close();
          throw closeError;
        },
        readFile: async () => {
          throw readError;
        },
        stat: (...args) => handle.stat(...args),
      };
    };
    await assert.rejects(
      verifyPack(
        root,
        output,
        successfulOptions(output, calls, { openImpl }),
      ),
      (error) => (
        error instanceof AggregateError
        && error.errors[0] === readError
        && error.errors[1] === closeError
      ),
    );
    assert.equal(calls.length, 1);
  });

  await t.test('install verification plus temp cleanup', async (child) => {
    const { container, output, root } = await fixture(child);
    const calls = [];
    const verifyError = new Error('fixture install verify failure');
    const cleanupError = new Error('fixture install cleanup failure');
    const installRoot = path.join(container, 'install-root');
    await mkdir(installRoot);
    await assert.rejects(
      verifyPack(
        root,
        output,
        successfulOptions(output, calls, {
          mkdtempImpl: async () => installRoot,
          rmImpl: async () => {
            throw cleanupError;
          },
          verifyInstallImpl: async () => {
            throw verifyError;
          },
        }),
      ),
      (error) => (
        error instanceof AggregateError
        && error.errors[0] === verifyError
        && error.errors[1] === cleanupError
      ),
    );
    assert.equal(calls.length, 1);
  });

  await t.test('falsy artifact read plus falsy close', async (child) => {
    const { output, root } = await fixture(child);
    const calls = [];
    const openImpl = async (candidate, flags, mode) => {
      const handle = await open(candidate, flags, mode);
      if (!candidate.endsWith('.tgz')) return handle;
      return {
        close: async () => {
          await handle.close();
          throw false;
        },
        readFile: async () => {
          throw undefined;
        },
        stat: (...args) => handle.stat(...args),
      };
    };
    await assert.rejects(
      verifyPack(root, output, successfulOptions(output, calls, { openImpl })),
      (error) => (
        error instanceof AggregateError
        && error.errors.length === 2
        && error.errors[0] === undefined
        && error.errors[1] === false
      ),
    );
  });

  await t.test('falsy install primary plus falsy cleanup', async (child) => {
    const { container, output, root } = await fixture(child);
    const calls = [];
    const installRoot = path.join(container, 'falsy-install-root');
    await mkdir(installRoot);
    await assert.rejects(
      verifyPack(
        root,
        output,
        successfulOptions(output, calls, {
          mkdtempImpl: async () => installRoot,
          rmImpl: async () => {
            throw false;
          },
          verifyInstallImpl: async () => {
            throw 0;
          },
        }),
      ),
      (error) => (
        error instanceof AggregateError
        && error.errors.length === 2
        && error.errors[0] === 0
        && error.errors[1] === false
      ),
    );
  });

  await t.test('falsy operation plus falsy restoration', async (child) => {
    const { output, root } = await fixture(child);
    const calls = [];
    await assert.rejects(
      verifyPack(
        root,
        output,
        successfulOptions(output, calls, {
          restoreOutputImpl: async () => {
            throw null;
          },
          verifyInstallImpl: async () => {
            throw undefined;
          },
        }),
      ),
      (error) => (
        error instanceof AggregateError
        && error.errors.length === 2
        && error.errors[0] === undefined
        && error.errors[1] === null
      ),
    );
  });

  await t.test('undefined verification result is not success', async (child) => {
    const { output, root } = await fixture(child);
    const calls = [];
    await assert.rejects(
      verifyPack(
        root,
        output,
        successfulOptions(output, calls, {
          verifyInstallImpl: async () => undefined,
        }),
      ),
      /pack-verify: install verification returned an invalid result/u,
    );
  });
});

test('installed verifier rejects every production dependency field even when empty', async (t) => {
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'bundleDependencies',
    'bundledDependencies',
  ]) {
    await t.test(field, async (child) => {
      const installRoot = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-install-check-'));
      child.after(() => rm(installRoot, { recursive: true, force: true }));
      const calls = [];
      await assert.rejects(
        verifyInstalledPackage('/artifacts/hanamaru-annotations-0.1.0.tgz', installRoot, {
          execFileImpl: installedVerifierExec(installRoot, calls, {
            packedManifest: { [field]: field.includes('bundle') ? [] : {} },
          }),
          execPath: '/verified/node',
          expectedIdentity: SOURCE_IDENTITY,
          npmCliPath: '/verified/npm-cli.js',
        }),
        new RegExp(
          `pack-verify: installed package declares forbidden production field ${field}`,
          'u',
        ),
      );
    });
  }
});

test('installed verifier binds installed manifest and production tree to source identity', async (t) => {
  for (const [name, options, pattern] of [
    [
      'manifest name',
      { packedManifest: { name: 'other-package' } },
      /pack-verify: installed package identity does not match source/u,
    ],
    [
      'manifest version',
      { packedManifest: { version: '0.1.1' } },
      /pack-verify: installed package identity does not match source/u,
    ],
    [
      'tree version',
      {
        productionTree: {
          dependencies: {
            'hanamaru-annotations': { version: '0.1.1' },
          },
        },
      },
      /pack-verify: production dependency tree does not match source identity/u,
    ],
  ]) {
    await t.test(name, async (child) => {
      const installRoot = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-identity-check-'));
      child.after(() => rm(installRoot, { recursive: true, force: true }));
      const calls = [];
      await assert.rejects(
        verifyInstalledPackage('/artifacts/hanamaru-annotations-0.1.0.tgz', installRoot, {
          execFileImpl: installedVerifierExec(installRoot, calls, options),
          execPath: '/verified/node',
          expectedIdentity: SOURCE_IDENTITY,
          npmCliPath: '/verified/npm-cli.js',
        }),
        pattern,
      );
    });
  }
});

test('installed verifier requires exactly one dependency-free Hanamaru production root', async (t) => {
  for (const [name, productionTree] of [
    ['missing root', { dependencies: {} }],
    [
      'extra root',
      {
        dependencies: {
          'hanamaru-annotations': { version: '0.1.0' },
          unexpected: { version: '1.0.0' },
        },
      },
    ],
    [
      'hidden child',
      {
        dependencies: {
          'hanamaru-annotations': {
            version: '0.1.0',
            dependencies: {
              hidden: { version: '1.0.0' },
            },
          },
        },
      },
    ],
  ]) {
    await t.test(name, async (child) => {
      const installRoot = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-tree-check-'));
      child.after(() => rm(installRoot, { recursive: true, force: true }));
      const calls = [];
      await assert.rejects(
        verifyInstalledPackage('/artifacts/hanamaru-annotations-0.1.0.tgz', installRoot, {
          execFileImpl: installedVerifierExec(installRoot, calls, { productionTree }),
          execPath: '/verified/node',
          expectedIdentity: SOURCE_IDENTITY,
          npmCliPath: '/verified/npm-cli.js',
        }),
        /pack-verify: production dependency tree must contain only dependency-free hanamaru-annotations/u,
      );
    });
  }
});

test('installed verifier uses one explicit runtime and separates prod package from dev peers', async (t) => {
  const installRoot = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-runtime-check-'));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  const calls = [];
  const artifact = '/artifacts/hanamaru-annotations-0.1.0.tgz';
  const result = await verifyInstalledPackage(artifact, installRoot, {
    execFileImpl: installedVerifierExec(installRoot, calls),
    execPath: '/verified/node',
    expectedIdentity: SOURCE_IDENTITY,
    npmCliPath: '/verified/npm-cli.js',
  });
  assert.deepEqual(result, {
    css: 2,
    entries: 9,
    productionDependencies: 0,
  });
  assert.equal(calls.length, 4);
  assert.equal(calls.every(({ file }) => file === '/verified/node'), true);
  assert.deepEqual(calls[0].args.slice(0, 4), [
    '/verified/npm-cli.js',
    'install',
    '--save-prod',
    '--ignore-scripts',
  ]);
  assert.equal(calls[0].args.includes(artifact), true);
  assert.deepEqual(calls[1].args.slice(0, 4), [
    '/verified/npm-cli.js',
    'install',
    '--save-dev',
    '--ignore-scripts',
  ]);
  assert.equal(calls[1].args.includes('react@19.2.8'), true);
  assert.equal(calls[1].args.includes('vue@3.5.40'), true);
  assert.equal(calls[1].args.includes('svelte@5.56.7'), true);
  assert.equal(calls[2].args.length, 1);
  assert.match(calls[2].args[0], /verify-imports\.mjs$/u);
  assert.deepEqual(calls[3].args, [
    '/verified/npm-cli.js',
    'ls',
    '--omit=dev',
    '--json',
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
    const fixtureManifestPath = path.join(fixtureRoot, 'package.json');
    const fixtureManifest = JSON.parse(await readFile(fixtureManifestPath, 'utf8'));
    fixtureManifest.scripts = {
      ...fixtureManifest.scripts,
      prepack: 'node prepack-mutation.cjs',
    };
    await writeFile(fixtureManifestPath, JSON.stringify(fixtureManifest, null, 2));
    await writeFile(path.join(fixtureRoot, 'prepack-mutation.cjs'), `
      const fs = require('node:fs');
      const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      manifest.version = '9.9.9';
      fs.writeFileSync('package.json', JSON.stringify(manifest, null, 2));
      fs.appendFileSync('dist/hanamaru.css', '\\n/* prepack mutation */\\n');
      fs.writeFileSync('prepack-sentinel', 'ran');
    `);
    for (const directory of ['src', 'types']) {
      await cp(
        path.join(PROJECT_ROOT, directory),
        path.join(fixtureRoot, directory),
        { recursive: true },
      );
    }
    await symlink(path.join(PROJECT_ROOT, 'node_modules'), path.join(fixtureRoot, 'node_modules'));
    await buildDistribution(fixtureRoot);
    const manifestBeforePack = await readFile(fixtureManifestPath, 'utf8');
    const cssPath = path.join(fixtureRoot, 'dist', 'hanamaru.css');
    const cssBeforePack = await readFile(cssPath);
    let realPackCalls = 0;

    const result = await verifyPack(fixtureRoot, output, {
      execFileImpl(file, args, options, callback) {
        if (args[1] === 'pack') realPackCalls += 1;
        execFile(file, args, options, callback);
      },
    });
    assert.equal(realPackCalls, 1);
    assert.equal(
      await access(path.join(fixtureRoot, 'prepack-sentinel')).then(() => true, () => false),
      false,
    );
    assert.equal(await readFile(fixtureManifestPath, 'utf8'), manifestBeforePack);
    assert.deepEqual(await readFile(cssPath), cssBeforePack);
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
