import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { constants, gzipSync } from 'node:zlib';
import {
  checkDistribution,
  measureDistribution,
  npmInvocationFor,
  writeSizeReport,
} from '../../scripts/check-size.mjs';
import {
  checkDist,
  checkDryPackShape,
} from '../../scripts/check-dist.mjs';
import * as checkDistModule from '../../scripts/check-dist.mjs';

const ENTRY_FILES = Object.freeze({
  main: 'hanamaru.esm.js',
  iife: 'hanamaru.iife.js',
  selection: 'selection/index.js',
  serialize: 'serialize/index.js',
  group: 'group/index.js',
  plugins: 'plugins/index.js',
  shadow: 'shadow/index.js',
  react: 'react/index.js',
  vue: 'vue/index.js',
  svelte: 'svelte/index.js',
});

const BUDGETS = Object.freeze({
  main: 28_672,
  iife: 24_576,
  selection: 3_072,
  serialize: 11_264,
  group: 8_192,
  plugins: 6_144,
  shadow: 21_504,
  react: 4_096,
  vue: 4_096,
  svelte: 4_096,
});

const STRETCHES = Object.freeze({
  main: 27_648,
  iife: 23_552,
  selection: 2_560,
  serialize: 10_752,
  group: 7_680,
  plugins: 5_632,
  shadow: 20_480,
  react: 3_584,
  vue: 3_584,
  svelte: 3_584,
});

async function createDistribution(pkg = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-size-'));
  const files = {
    'hanamaru.esm.js': `
      import "./_chunks/main.js?static#entry";
      export { reexported } from "./_chunks/reexport.js#export";
      export const lazy = () => import("./_chunks/dynamic.js?lazy#entry");
      const nonliteral = "./_chunks/missing-nonliteral.js";
      export const ignoredDynamic = () => import(nonliteral);
      export const importText = 'import("./_chunks/missing-string.js")';
      export const templateText = \`export * from "./_chunks/missing-template.js"\`;
      export const importPattern = /import\\(".\\/_chunks\\/missing-regex\\.js"\\)/;
      // import "./_chunks/missing-line-comment.js";
      /* export { missing } from "./_chunks/missing-block-comment.js"; */
      export const VERSION = "fixture";
    `,
    'hanamaru.iife.js': 'var Hanamaru={};',
    'hanamaru.css': '.hana{}',
    '_chunks/main.js': `
      import "./cycle.js?cycle";
      export const singleton = {};
    `,
    '_chunks/cycle.js': `
      import "./main.js#cycle";
      export const cycle = 1;
    `,
    '_chunks/dynamic.js': 'export const dynamic = 1;',
    '_chunks/reexport.js': 'export const reexported = 1;',
    '_chunks/selection.js': 'export const selection = 1;',
    '_chunks/optional-shared.js': 'export const sharedOptional = 1;',
    'selection/index.js': `
      import "../_chunks/main.js";
      import "../_chunks/selection.js";
      import "../_chunks/optional-shared.js";
      export const annotateSelection = 1;
    `,
    'serialize/index.js': `
      import "../_chunks/main.js";
      import "../_chunks/optional-shared.js";
      export const serialize = 1;
    `,
    'group/index.js': 'import "../_chunks/main.js"; export const group = 1;',
    'plugins/index.js': 'import "../_chunks/main.js"; export const registerMark = 1;',
    'shadow/index.js': 'import "../_chunks/main.js"; export const createShadowScope = 1;',
    'shadow/hanamaru-shadow.css': '.hana-shadow{}',
    'react/index.js': 'import "react"; import "../_chunks/main.js"; export const useAnnotation = 1;',
    'vue/index.js': 'import "vue"; import "../_chunks/main.js"; export const useAnnotation = 1;',
    'svelte/index.js': 'import "svelte"; import "../_chunks/main.js"; export const annotation = 1;',
  };
  await writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
  for (const [relativePath, source] of Object.entries(files)) {
    const target = path.join(root, 'dist', relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return root;
}

function deterministicNoise(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let state = 0x12345678;
  let output = '';
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    output += alphabet[(state >>> 0) % alphabet.length];
  }
  return output;
}

function bytesWithExactGzipLength(target) {
  for (let length = target; length <= target * 3; length += 1) {
    const source = `export const fixture="${deterministicNoise(length)}";`;
    if (gzipSync(source, { level: constants.Z_BEST_COMPRESSION }).length === target) {
      return source;
    }
  }
  throw new Error(`fixture could not produce ${target} gzip bytes of valid JavaScript`);
}

test('measureDistribution applies exact graph-closure charging rules', async (t) => {
  const root = await createDistribution({});
  t.after(() => rm(root, { recursive: true, force: true }));

  const report = await measureDistribution(root);
  const byName = Object.fromEntries(report.entries.map((entry) => [entry.entry, entry]));

  assert.deepEqual(report.entries.map(({ entry }) => entry), Object.keys(ENTRY_FILES));
  assert.deepEqual(
    byName.main.chargedFiles,
    [
      'hanamaru.esm.js',
      '_chunks/main.js',
      '_chunks/cycle.js',
      '_chunks/reexport.js',
      '_chunks/dynamic.js',
      'hanamaru.css',
    ],
  );
  assert.equal(byName.main.chargedFiles.filter((file) => file === '_chunks/main.js').length, 1);
  assert.deepEqual(
    byName.selection.chargedFiles,
    ['selection/index.js', '_chunks/selection.js', '_chunks/optional-shared.js'],
  );
  assert.deepEqual(
    byName.serialize.chargedFiles,
    ['serialize/index.js', '_chunks/optional-shared.js'],
  );
  assert.ok(byName.selection.chargedFiles.includes('_chunks/optional-shared.js'));
  assert.ok(byName.serialize.chargedFiles.includes('_chunks/optional-shared.js'));
  assert.equal(byName.selection.chargedFiles.includes('_chunks/main.js'), false);
  assert.deepEqual(byName.react.chargedFiles, ['react/index.js']);
  assert.equal(byName.react.chargedFiles.includes('react'), false);
  assert.deepEqual(
    byName.shadow.chargedFiles,
    ['shadow/index.js', 'shadow/hanamaru-shadow.css'],
  );

  for (const row of report.entries) {
    assert.equal(row.budgetBytes, BUDGETS[row.entry]);
    assert.equal(row.stretchBytes, STRETCHES[row.entry]);
    assert.equal(
      row.rawBytes,
      row.members.reduce((total, member) => total + member.rawBytes, 0),
    );
    assert.equal(
      row.gzipBytes,
      row.members.reduce((total, member) => total + member.gzipBytes, 0),
    );
    assert.equal(row.stretch, row.gzipBytes <= STRETCHES[row.entry]);
  }
});

test('checkDistribution accepts exact hard boundaries and rejects one byte over', async (t) => {
  const atLimit = await createDistribution({});
  const overLimit = await createDistribution({});
  t.after(() => rm(atLimit, { recursive: true, force: true }));
  t.after(() => rm(overLimit, { recursive: true, force: true }));

  const selectionEntryGzip = gzipSync(
    await readFile(path.join(atLimit, 'dist', 'selection', 'index.js')),
    { level: constants.Z_BEST_COMPRESSION },
  ).length;
  const optionalSharedGzip = gzipSync(
    await readFile(path.join(atLimit, 'dist', '_chunks', 'optional-shared.js')),
    { level: constants.Z_BEST_COMPRESSION },
  ).length;
  await writeFile(
    path.join(atLimit, 'dist', '_chunks', 'selection.js'),
    bytesWithExactGzipLength(BUDGETS.selection - selectionEntryGzip - optionalSharedGzip),
  );
  await writeFile(
    path.join(overLimit, 'dist', '_chunks', 'selection.js'),
    bytesWithExactGzipLength(BUDGETS.selection + 1 - selectionEntryGzip - optionalSharedGzip),
  );

  const accepted = await checkDistribution(atLimit, { checkNpmTree: false });
  assert.equal(accepted.find(({ entry }) => entry === 'selection').gzipBytes, 3_072);
  await assert.rejects(
    checkDistribution(overLimit, { checkNpmTree: false }),
    {
      message: 'dist-check: selection exceeds 3072 gzip bytes (3073)',
    },
  );
});

test('main and IIFE use independent-member gzip and exact main hard caps', async (t) => {
  const root = await createDistribution({});
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await measureDistribution(root);
  const main = report.entries.find(({ entry }) => entry === 'main');
  const iife = report.entries.find(({ entry }) => entry === 'iife');

  assert.equal(
    main.gzipBytes,
    main.members.reduce((total, member) => total + member.gzipBytes, 0),
  );
  assert.deepEqual(iife.chargedFiles, ['hanamaru.iife.js', 'hanamaru.css']);
  assert.equal(main.budgetBytes, 28_672);
  assert.equal(iife.budgetBytes, 24_576);
});

test('size report is deterministic, schema-versioned, and excludes itself', async (t) => {
  const root = await createDistribution({});
  t.after(() => rm(root, { recursive: true, force: true }));

  const measured = await measureDistribution(root);
  const first = await writeSizeReport(root, measured);
  await writeFile(path.join(root, 'dist', 'size-report.json'), 'x'.repeat(100_000));
  const afterStaleReport = await measureDistribution(root);
  const second = await writeSizeReport(root, afterStaleReport);

  assert.deepEqual(afterStaleReport, measured);
  assert.equal(second, first);
  assert.equal(first.endsWith('\n'), true);
  const report = JSON.parse(first);
  assert.equal(report.schemaVersion, 2);
  assert.deepEqual(report.budgets, {
    hard: BUDGETS,
    stretch: STRETCHES,
  });
  assert.deepEqual(report.entries, measured.entries);
  for (const row of report.entries) {
    assert.deepEqual(Object.keys(row), [
      'entry',
      'entryFile',
      'chargedFiles',
      'members',
      'rawBytes',
      'gzipBytes',
      'budgetBytes',
      'stretchBytes',
      'stretch',
    ]);
  }
});

test('checkDistribution rejects a dependencies key even when empty', async (t) => {
  const root = await createDistribution({ dependencies: {} });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(checkDistribution(root, { checkNpmTree: false }), /dependencies key/);
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
  assert.equal(rows.length, 10);
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
  assert.equal(rows.length, 10);
});

test('checkDist invokes the four release gates in the exact required order', async () => {
  const calls = [];
  const value = await checkDist('/fixture', {
    assertNoProductionDependencies: async () => calls.push('dependencies'),
    checkBuiltExports: async () => {
      calls.push('exports');
      return { distFiles: ['hanamaru.esm.js', 'index.d.ts'] };
    },
    checkDryPackShape: async (root, options) => {
      calls.push('pack');
      assert.equal(root, '/fixture');
      assert.deepEqual(options, {
        expectedDistFiles: ['hanamaru.esm.js', 'index.d.ts'],
      });
      return 3;
    },
    checkDistributionSize: async () => calls.push('size'),
  });
  assert.deepEqual(calls, ['dependencies', 'exports', 'pack', 'size']);
  assert.deepEqual(value, {
    dependencies: 1,
    exports: { distFiles: ['hanamaru.esm.js', 'index.d.ts'] },
    pack: 3,
    size: 4,
  });
});

test('checkDryPackShape accepts the exact validated dist tree plus package metadata', async () => {
  const files = [
    { path: 'package/package.json' },
    { path: 'package/README.md' },
    { path: 'package/LICENSE' },
    { path: 'package/dist/hanamaru.esm.js' },
    { path: 'package/dist/index.d.ts' },
  ];
  const accepted = await checkDryPackShape('/fixture', {
    expectedDistFiles: ['hanamaru.esm.js', 'index.d.ts'],
    execFileImpl(file, args, options, callback) {
      assert.equal(file, 'npm');
      assert.deepEqual(args, ['pack', '--dry-run', '--json']);
      assert.deepEqual(options, { cwd: '/fixture' });
      callback(null, JSON.stringify([{ files }]), '');
    },
    platform: 'linux',
  });
  assert.deepEqual(accepted, files.map(({ path: file }) => file));
});

test('checkDryPackShape rejects source, secrets, changelog, and root tarballs', async () => {
  for (const unexpected of [
    'package/src/index.js',
    'package/tests/unit/build.test.js',
    'package/.env',
    'package/CHANGELOG.md',
    'package/hanamaru-annotations-0.1.0.tgz',
  ]) {
    await assert.rejects(
      checkDryPackShape('/fixture', {
        expectedDistFiles: ['index.d.ts'],
        execFileImpl(file, args, options, callback) {
          callback(null, JSON.stringify([{
            files: [
              { path: 'package/package.json' },
              { path: 'package/README.md' },
              { path: 'package/LICENSE' },
              { path: 'package/dist/index.d.ts' },
              { path: unexpected },
            ],
          }]), '');
        },
        platform: 'linux',
      }),
      /unexpected packed file/,
      unexpected,
    );
  }
});

test('checkDryPackShape rejects packed dist omissions and additions', async () => {
  const expectedDistFiles = ['hanamaru.esm.js', 'index.d.ts'];
  for (const [name, packedDistFiles] of [
    ['omission', ['hanamaru.esm.js']],
    ['addition', ['hanamaru.esm.js', 'index.d.ts', 'secret.txt']],
  ]) {
    await assert.rejects(
      checkDryPackShape('/fixture', {
        expectedDistFiles,
        execFileImpl(file, args, options, callback) {
          callback(null, JSON.stringify([{
            files: [
              { path: 'package/package.json' },
              { path: 'package/README.md' },
              { path: 'package/LICENSE' },
              ...packedDistFiles.map((distFile) => ({ path: `package/dist/${distFile}` })),
            ],
          }]), '');
        },
        platform: 'linux',
      }),
      /dist-check: packed file set does not match validated distribution/u,
      name,
    );
  }
});

test('CLI project roots decode spaces and Unicode through fileURLToPath', async () => {
  assert.equal(typeof checkDistModule.projectRootFromModuleUrl, 'function');
  const scriptPath = path.join(
    os.tmpdir(),
    'hanamaru encoded path',
    '日本語',
    'scripts',
    'check-dist.mjs',
  );
  const scriptUrl = pathToFileURL(scriptPath);
  assert.match(scriptUrl.pathname, /%20/u);
  assert.equal(
    checkDistModule.projectRootFromModuleUrl(scriptUrl.href),
    path.resolve(path.dirname(scriptPath), '..'),
  );
  assert.equal(
    checkDistModule.projectRootFromModuleUrl(
      'file:///C:/Program%20Files/%E6%97%A5%E6%9C%AC/scripts/check-dist.mjs',
      { windows: true },
    ),
    'C:\\Program Files\\日本',
  );
  assert.equal(
    checkDistModule.projectRootFromModuleUrl(
      'file:///opt/encoded%20path/%E6%97%A5%E6%9C%AC/scripts/check-dist.mjs',
      { windows: false },
    ),
    '/opt/encoded path/日本',
  );
  for (const relativePath of ['../../scripts/check-dist.mjs', '../../scripts/check-exports.mjs']) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /new URL\(import\.meta\.url\)\.pathname/u);
    assert.match(source, /from '\.\/module-url\.mjs'/u);
  }
});
