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
import { buildDistribution } from '../../scripts/build.mjs';

const entries = {
  'index.js': `
    import { state } from './runtime-state.js';
    export const VERSION = 'fixture';
    export class HanamaruError extends Error {}
    export class HanamaruConfigError extends HanamaruError {}
    export class HanamaruStateError extends HanamaruError {}
    export class HanamaruTargetError extends HanamaruError {}
    export function annotate(controller) {
      state.metadata.set(controller, { resources: state.documents });
      return state;
    }
    export function scan() { return state; }
    export function story() { return state; }
  `,
  'entries/selection.js': `
    import { state } from '../runtime-state.js';
    export function annotateSelection() { return state; }
  `,
  'entries/serialize.js': `
    import { state } from '../runtime-state.js';
    export function serialize(controller) { return state.metadata.get(controller); }
    export function restore() { return state; }
    export function resolveSerializedTarget() { return state; }
  `,
  'entries/group.js': `
    import { state } from '../runtime-state.js';
    export function group(controller) { return state.metadata.get(controller); }
  `,
  'entries/plugins.js': `
    import { state } from '../runtime-state.js';
    export function registerMark(name, value) { state.plugins.set(name, value); return state.plugins; }
  `,
  'entries/shadow.js': `
    import { state } from '../runtime-state.js';
    export function createShadowScope() { return { resources: state.documents, shadows: state.shadows }; }
  `,
  'entries/react.js': `
    import 'react';
    import { state } from '../runtime-state.js';
    export function useAnnotation() { return state; }
  `,
  'entries/vue.js': `
    import 'vue';
    import { state } from '../runtime-state.js';
    export function useAnnotation() { return state; }
  `,
  'entries/svelte.js': `
    import 'svelte';
    import { state } from '../runtime-state.js';
    export function annotation() { return state; }
  `,
  'runtime-state.js': `
    export const state = {
      documents: new WeakMap(),
      metadata: new WeakMap(),
      plugins: new Map(),
      shadows: new WeakMap(),
    };
  `,
  'hanamaru.css': '.hana{}',
  'hanamaru-shadow.css': '.hana-shadow{}',
};

async function makeFixture(root) {
  for (const [relativePath, source] of Object.entries(entries)) {
    const target = path.join(root, 'src', relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  for (const relativePath of [
    'index.d.ts',
    'selection/index.d.ts',
    'serialize/index.d.ts',
    'group/index.d.ts',
    'plugins/index.d.ts',
    'shadow/index.d.ts',
    'react/index.d.ts',
    'vue/index.d.ts',
    'svelte/index.d.ts',
  ]) {
    const target = path.join(root, 'types', relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'export {};\n');
  }
}

function localSpecifiers(source) {
  return [...source.matchAll(
    /\b(?:import|export)\s*(?:[^;"']*?\bfrom\s*)?["'](\.[^"']+)["']/gu,
  )].map((match) => match[1]);
}

async function graphFiles(entry, dist) {
  const files = new Set();
  async function visit(file) {
    const resolved = path.resolve(file);
    if (files.has(resolved)) return;
    files.add(resolved);
    const source = await readFile(resolved, 'utf8');
    for (const specifier of localSpecifiers(source)) {
      await visit(path.resolve(path.dirname(resolved), specifier));
    }
  }
  await visit(path.join(dist, entry));
  return files;
}

test('all ESM entries share one emitted runtime singleton and cross-subpath behavior', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-singleton-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeFixture(root);
  await buildDistribution(root);

  const dist = path.join(root, 'dist');
  const entryPaths = [
    'hanamaru.esm.js',
    'selection/index.js',
    'serialize/index.js',
    'group/index.js',
    'plugins/index.js',
    'shadow/index.js',
    'react/index.js',
    'vue/index.js',
    'svelte/index.js',
  ];
  const graphs = await Promise.all(entryPaths.map((entry) => graphFiles(entry, dist)));
  const sharedChunks = graphs
    .map((graph) => [...graph].filter((file) => file.includes(`${path.sep}_chunks${path.sep}`)))
    .reduce((shared, graph) => shared.filter((file) => graph.includes(file)));
  assert.equal(sharedChunks.length, 1, 'every entry must traverse one shared singleton chunk');

  const modules = await Promise.all([
    'hanamaru.esm.js',
    'plugins/index.js',
    'serialize/index.js',
    'group/index.js',
    'shadow/index.js',
  ].map((entry) => import(`${pathToFileURL(path.join(dist, entry)).href}?singleton`)));
  const [main, plugins, serialization, groups, shadow] = modules;
  const controller = {};
  const state = main.annotate(controller);
  const mark = {};
  assert.equal(plugins.registerMark('fixture', mark), state.plugins);
  assert.equal(state.plugins.get('fixture'), mark);
  assert.equal(serialization.serialize(controller).resources, state.documents);
  assert.equal(groups.group(controller).resources, state.documents);
  assert.equal(shadow.createShadowScope().resources, state.documents);
  assert.equal(shadow.createShadowScope().shadows, state.shadows);
});
