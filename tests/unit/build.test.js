import assert from 'node:assert/strict';
import { build as esbuildBuild } from 'esbuild';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { constants, gzipSync } from 'node:zlib';
import { buildDistribution } from '../../scripts/build.mjs';
import { checkBuiltExports } from '../../scripts/check-exports.mjs';

const ENTRY_EXPORTS = Object.freeze({
  'hanamaru.esm.js': [
    'HanamaruConfigError',
    'HanamaruError',
    'HanamaruStateError',
    'HanamaruTargetError',
    'VERSION',
    'annotate',
    'scan',
    'story',
  ],
  'selection/index.js': ['annotateSelection'],
  'serialize/index.js': ['resolveSerializedTarget', 'restore', 'serialize'],
  'group/index.js': ['group'],
  'plugins/index.js': ['registerMark'],
  'shadow/index.js': ['createShadowScope'],
  'react/index.js': ['useAnnotation'],
  'vue/index.js': ['useAnnotation'],
  'svelte/index.js': ['annotation'],
});

const TYPE_PATHS = Object.freeze([
  'index.d.ts',
  'selection/index.d.ts',
  'serialize/index.d.ts',
  'group/index.d.ts',
  'plugins/index.d.ts',
  'shadow/index.d.ts',
  'react/index.d.ts',
  'vue/index.d.ts',
  'svelte/index.d.ts',
]);

const SOURCE_BY_ENTRY = Object.freeze({
  'index.js': `
    import { state } from './runtime-state.js';
    const reflected = { $token: 'fixture' };
    export const VERSION = reflected['$token'];
    export class HanamaruError extends Error {}
    export class HanamaruConfigError extends HanamaruError {}
    export class HanamaruStateError extends HanamaruError {}
    export class HanamaruTargetError extends HanamaruError {}
    export function annotate() { return state; }
    export function scan() { return state; }
    export function story() { return state; }
  `,
  'entries/selection.js': `
    import { state } from '../runtime-state.js';
    export function annotateSelection() { return state; }
  `,
  'entries/serialize.js': `
    import { state } from '../runtime-state.js';
    export function resolveSerializedTarget() { return state; }
    export function restore() { return state; }
    export function serialize() { return state; }
  `,
  'entries/group.js': `
    import { state } from '../runtime-state.js';
    export function group() { return state; }
  `,
  'entries/plugins.js': `
    import { state } from '../runtime-state.js';
    export function registerMark(name, factory) {
      if (state.plugins.has(name)) throw new Error("duplicate");
      state.plugins.set(name, factory);
      return () => state.plugins.delete(name);
    }
  `,
  'entries/shadow.js': `
    import { state } from '../runtime-state.js';
    export function createShadowScope() { return state; }
  `,
  'entries/react.js': `
    import React from 'react';
    import { state } from '../runtime-state.js';
    export function useAnnotation() { return [React, state]; }
  `,
  'entries/vue.js': `
    import { ref } from 'vue';
    import { state } from '../runtime-state.js';
    export function useAnnotation() { return [ref, state]; }
  `,
  'entries/svelte.js': `
    import { untrack } from 'svelte';
    import { state } from '../runtime-state.js';
    export function annotation() { return [untrack, state]; }
  `,
});

test('build uses semantics-preserving minification without property or private-syntax rewriting', async () => {
  const source = await readFile(new URL('../../scripts/build.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /transformSchedulerPrivateSyntax|schedulerPrivatePlugin|mangleProps/u,
  );
});

async function writeFixture(root) {
  await symlink(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'node_modules'),
    path.join(root, 'node_modules'),
    'dir',
  );
  for (const [relativePath, source] of Object.entries({
    ...SOURCE_BY_ENTRY,
    'runtime-state.js': `
      export const state = {
        documents: new WeakMap(),
        metadata: new WeakMap(),
        plugins: new Map(),
        shadows: new WeakMap(),
      };
    `,
    'hanamaru.css': '/* fixture */\n.hana-fixture { color: red; }\n',
    'hanamaru-shadow.css': '.hana-shadow-fixture { color: blue; }\n',
  })) {
    const target = path.join(root, 'src', relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  for (const relativePath of TYPE_PATHS) {
    const target = path.join(root, 'types', relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `// ${relativePath}\nexport {};\n`);
  }
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    type: 'module',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/hanamaru.esm.js' },
      './style.css': './dist/hanamaru.css',
      './selection': {
        types: './dist/selection/index.d.ts',
        import: './dist/selection/index.js',
      },
      './serialize': {
        types: './dist/serialize/index.d.ts',
        import: './dist/serialize/index.js',
      },
      './group': { types: './dist/group/index.d.ts', import: './dist/group/index.js' },
      './plugins': {
        types: './dist/plugins/index.d.ts',
        import: './dist/plugins/index.js',
      },
      './shadow': {
        types: './dist/shadow/index.d.ts',
        import: './dist/shadow/index.js',
      },
      './shadow/style.css': './dist/shadow/hanamaru-shadow.css',
      './react': { types: './dist/react/index.d.ts', import: './dist/react/index.js' },
      './vue': { types: './dist/vue/index.d.ts', import: './dist/vue/index.js' },
      './svelte': { types: './dist/svelte/index.d.ts', import: './dist/svelte/index.js' },
      './package.json': './package.json',
    },
  }));
}

async function listFiles(directory) {
  const output = [];
  async function visit(current, prefix = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) await visit(path.join(current, entry.name), relative);
      else output.push(relative);
    }
  }
  await visit(directory);
  return output.sort();
}

function localSpecifiers(source) {
  return [...source.matchAll(
    /\b(?:import|export)\s*(?:[^;"']*?\bfrom\s*)?["'](\.[^"']+)["']/gu,
  )].map((match) => match[1]);
}

async function assertRelativeGraphResolves(entry, dist) {
  const seen = new Set();
  async function visit(file) {
    const resolved = path.resolve(file);
    assert.equal(
      path.relative(dist, resolved).startsWith(`..${path.sep}`),
      false,
      `${resolved} must stay inside dist`,
    );
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const source = await readFile(resolved, 'utf8');
    for (const specifier of localSpecifiers(source)) {
      await visit(path.resolve(path.dirname(resolved), specifier.split(/[?#]/u, 1)[0]));
    }
  }
  await visit(path.join(dist, entry));
}

test('buildDistribution emits the exact modular distribution tree and public names', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFixture(root);

  await buildDistribution(root);

  const files = await listFiles(path.join(root, 'dist'));
  const chunkArtifacts = files.filter((file) => file.startsWith('_chunks/'));
  const chunks = files.filter((file) => /^_chunks\/[^/]+\.js$/u.test(file));
  assert.ok(chunks.length >= 1, 'the shared graph must emit deterministic chunks');
  assert.deepEqual(chunkArtifacts, chunks, '_chunks may contain only single-level JavaScript');
  assert.deepEqual(
    files.filter((file) => !file.startsWith('_chunks/')),
    [
      'group/index.d.ts',
      'group/index.js',
      'hanamaru.css',
      'hanamaru.esm.js',
      'hanamaru.iife.js',
      'index.d.ts',
      'plugins/index.d.ts',
      'plugins/index.js',
      'react/index.d.ts',
      'react/index.js',
      'selection/index.d.ts',
      'selection/index.js',
      'serialize/index.d.ts',
      'serialize/index.js',
      'shadow/hanamaru-shadow.css',
      'shadow/index.d.ts',
      'shadow/index.js',
      'size-report.json',
      'svelte/index.d.ts',
      'svelte/index.js',
      'vue/index.d.ts',
      'vue/index.js',
    ],
  );
  assert.equal(files.some((file) => /^hanamaru\.(?:selection|serialize|plugins)/u.test(file)), false);

  for (const [entry, names] of Object.entries(ENTRY_EXPORTS)) {
    const module = await import(`${pathToFileURL(path.join(root, 'dist', entry)).href}?build-test`);
    assert.deepEqual(Object.keys(module).sort(), [...names].sort(), entry);
    if (entry === 'hanamaru.esm.js') assert.equal(module.VERSION, 'fixture');
    await assertRelativeGraphResolves(entry, path.join(root, 'dist'));
  }

  const iife = await readFile(path.join(root, 'dist', 'hanamaru.iife.js'), 'utf8');
  assert.match(iife, /Hanamaru/);
  assert.doesNotMatch(iife, /\b(?:import|export)\b/u);
  assert.doesNotMatch(iife, /annotateSelection|registerMark|createShadowScope|useAnnotation/u);
  assert.equal(
    await readFile(path.join(root, 'dist', 'hanamaru.css'), 'utf8'),
    '.hana-fixture{color:red}\n',
  );
  assert.equal(
    await readFile(path.join(root, 'dist', 'shadow', 'hanamaru-shadow.css'), 'utf8'),
    '.hana-shadow-fixture{color:#00f}\n',
  );
  for (const relativePath of TYPE_PATHS) {
    assert.equal(
      await readFile(path.join(root, 'dist', relativePath), 'utf8'),
      `// ${relativePath}\nexport {};\n`,
    );
  }
});

test('size report survives two consecutive injected-root builds deterministically', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-build-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFixture(root);

  await buildDistribution(root);
  const firstFiles = await listFiles(path.join(root, 'dist'));
  const firstJavaScript = Object.fromEntries(await Promise.all(
    firstFiles
      .filter((file) => file.endsWith('.js'))
      .map(async (file) => [file, await readFile(path.join(root, 'dist', file), 'utf8')]),
  ));
  const first = await readFile(path.join(root, 'dist', 'size-report.json'), 'utf8');
  await buildDistribution(root);
  const secondFiles = await listFiles(path.join(root, 'dist'));
  const secondJavaScript = Object.fromEntries(await Promise.all(
    secondFiles
      .filter((file) => file.endsWith('.js'))
      .map(async (file) => [file, await readFile(path.join(root, 'dist', file), 'utf8')]),
  ));
  const second = await readFile(path.join(root, 'dist', 'size-report.json'), 'utf8');

  assert.deepEqual(secondFiles, firstFiles);
  assert.deepEqual(secondJavaScript, firstJavaScript);
  assert.equal(second, first);
  assert.equal(first.endsWith('\n'), true);
  const report = JSON.parse(first);
  const rootEntry = await readFile(path.join(root, 'dist', 'hanamaru.esm.js'));
  const rootRow = report.entries?.find(({ entry }) => entry === 'main')
    ?? report.formats?.find(({ file }) => file === 'hanamaru.esm.js');
  assert.ok((rootRow.rawBytes ?? rootRow.raw) > rootEntry.length);
  assert.ok(
    (rootRow.gzipBytes ?? rootRow.gzip)
      > gzipSync(rootEntry, { level: constants.Z_BEST_COMPRESSION }).length,
  );
});

test('a JavaScript compression failure removes the incomplete distribution', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-build-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFixture(root);

  await assert.rejects(
    buildDistribution(root, {
      async transformJavaScript() {
        throw new Error('fixture compressor failed');
      },
    }),
    /fixture compressor failed/,
  );
  await assert.rejects(
    readFile(path.join(root, 'dist', 'hanamaru.esm.js')),
    { code: 'ENOENT' },
  );
});

test('a parallel-stage failure awaits delayed peers, preserves its cause, and leaves no dist', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-build-parallel-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFixture(root);
  const failure = new Error('fixture parallel stage failed');
  let delayedPeerFinished = false;

  await assert.rejects(
    buildDistribution(root, {
      async buildImpl(configuration) {
        if (configuration.outdir !== undefined) return esbuildBuild(configuration);
        if (path.basename(configuration.outfile) === 'hanamaru.iife.js') throw failure;
        if (path.basename(configuration.outfile) === 'hanamaru.css') {
          await new Promise((resolve) => setTimeout(resolve, 50));
          await mkdir(path.dirname(configuration.outfile), { recursive: true });
          await writeFile(configuration.outfile, '.late-peer{}');
          delayedPeerFinished = true;
          return {};
        }
        return esbuildBuild(configuration);
      },
    }),
    (error) => error === failure,
  );

  assert.equal(delayedPeerFinished, true, 'rejection must wait for every started peer');
  await new Promise((resolve) => setTimeout(resolve, 75));
  await assert.rejects(readFile(path.join(root, 'dist', 'hanamaru.css')), { code: 'ENOENT' });
});

test('checkBuiltExports rejects every non-single-level JavaScript chunk artifact', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-chunk-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFixture(root);
  await buildDistribution(root);

  for (const unexpected of [
    '_chunks/nested/extra.js',
    '_chunks/extra.js.map',
    '_chunks/README',
  ]) {
    const target = path.join(root, 'dist', unexpected);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'unexpected');
    await assert.rejects(
      checkBuiltExports(root),
      /dist-check: invalid _chunks artifact/u,
      unexpected,
    );
    await rm(
      unexpected.includes('/nested/') ? path.dirname(target) : target,
      { recursive: unexpected.includes('/nested/'), force: true },
    );
  }
});

test('package exports route every public entry and stylesheet to the normative tree', async () => {
  const pkg = JSON.parse(await readFile(
    new URL('../../package.json', import.meta.url),
    'utf8',
  ));

  for (const [subpath, target] of Object.entries({
    '.': './dist/hanamaru.esm.js',
    './selection': './dist/selection/index.js',
    './serialize': './dist/serialize/index.js',
    './group': './dist/group/index.js',
    './plugins': './dist/plugins/index.js',
    './shadow': './dist/shadow/index.js',
    './react': './dist/react/index.js',
    './vue': './dist/vue/index.js',
    './svelte': './dist/svelte/index.js',
  })) {
    assert.equal(pkg.exports[subpath].import, target);
  }
  assert.equal(pkg.exports['./style.css'], './dist/hanamaru.css');
  assert.equal(pkg.exports['./shadow/style.css'], './dist/shadow/hanamaru-shadow.css');
  assert.equal(JSON.stringify(pkg.exports).includes('/src/'), false);
});

test('checkBuiltExports validates public names, targets, safe imports, and singleton behavior', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-exports-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFixture(root);
  await buildDistribution(root);

  const result = await checkBuiltExports(root);

  assert.deepEqual(result.entries, Object.keys(ENTRY_EXPORTS));
  assert.match(result.singletonChunk, /^_chunks\/.+\.js$/u);
});
