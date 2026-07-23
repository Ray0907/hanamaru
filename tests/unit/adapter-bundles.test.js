import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { constants, gzipSync } from 'node:zlib';

import { build } from 'esbuild';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const sourceRoot = path.join(projectRoot, 'src');
const entries = Object.freeze({
  main: path.join(sourceRoot, 'index.js'),
  react: path.join(sourceRoot, 'adapters', 'react.js'),
  vue: path.join(sourceRoot, 'adapters', 'vue.js'),
  svelte: path.join(sourceRoot, 'adapters', 'svelte.js'),
});
const adapterContract = Object.freeze({
  react: Object.freeze({
    peer: 'react',
    exports: Object.freeze(['useAnnotation']),
  }),
  vue: Object.freeze({
    peer: 'vue',
    exports: Object.freeze(['useAnnotation']),
  }),
  svelte: Object.freeze({
    peer: 'svelte',
    exports: Object.freeze(['annotation']),
  }),
});
const adapterBudget = 4_096;

function absoluteMetafilePath(file) {
  return path.normalize(path.isAbsolute(file) ? file : path.resolve(projectRoot, file));
}

function findEntryOutput(outputs, entryPoint) {
  const expected = path.normalize(entryPoint);
  const match = [...outputs].find(([, metadata]) => (
    metadata.entryPoint !== undefined
    && absoluteMetafilePath(metadata.entryPoint) === expected
  ));
  assert.ok(match, `missing emitted entry for ${path.relative(projectRoot, entryPoint)}`);
  return match[0];
}

function resolveLocalImport(outputs, importer, imported) {
  if (imported.external) return null;
  const candidates = [
    path.resolve(path.dirname(importer), imported.path),
    absoluteMetafilePath(imported.path),
  ].map(path.normalize);
  const resolved = candidates.find((candidate) => outputs.has(candidate));
  assert.ok(
    resolved,
    `metafile import ${imported.path} from ${path.relative(projectRoot, importer)} has no output`,
  );
  return resolved;
}

function outputClosure(outputs, entryOutput) {
  const closure = new Set();
  const pending = [entryOutput];
  while (pending.length > 0) {
    const output = pending.pop();
    if (closure.has(output)) continue;
    closure.add(output);
    for (const imported of outputs.get(output).imports) {
      const local = resolveLocalImport(outputs, output, imported);
      if (local !== null) pending.push(local);
    }
  }
  return closure;
}

function sourceInputs(outputs, closure) {
  const inputs = new Set();
  for (const output of closure) {
    for (const [input, contribution] of Object.entries(outputs.get(output).inputs)) {
      if (contribution.bytesInOutput > 0) inputs.add(absoluteMetafilePath(input));
    }
  }
  return inputs;
}

async function gzipClosure(closure) {
  const members = [];
  for (const file of [...closure].sort()) {
    const bytes = await readFile(file);
    members.push({
      file,
      raw: bytes.length,
      gzip: gzipSync(bytes, { level: constants.Z_BEST_COMPRESSION }).length,
    });
  }
  return {
    members,
    raw: members.reduce((total, member) => total + member.raw, 0),
    gzip: members.reduce((total, member) => total + member.gzip, 0),
  };
}

async function installPeerStub(temporaryRoot, peer) {
  const packageDirectory = path.join(temporaryRoot, 'node_modules', peer);
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(packageDirectory, 'package.json'),
    `${JSON.stringify({
      name: peer,
      private: true,
      type: 'module',
      exports: './index.js',
    })}\n`,
  );

  let source = 'export {};\n';
  if (peer === 'react') {
    source = [
      'export function useEffect() {}',
      'export function useLayoutEffect() {}',
      'export function useRef(value) { return { current: value }; }',
      '',
    ].join('\n');
  } else if (peer === 'vue') {
    source = [
      'export function onBeforeUnmount() {}',
      'export function onMounted() {}',
      'export function shallowRef(value) { return { value }; }',
      'export function unref(value) { return value?.value ?? value; }',
      'export function watch() { return () => {}; }',
      '',
    ].join('\n');
  }
  await writeFile(path.join(packageDirectory, 'index.js'), source);
}

test('framework adapter bundles remain isolated, peer-external, server-safe, and within budget', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hanamaru-adapters-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const outputDirectory = path.join(temporaryRoot, 'out');

  const result = await build({
    absWorkingDir: projectRoot,
    bundle: true,
    entryNames: '[name]',
    entryPoints: entries,
    external: Object.values(adapterContract).map(({ peer }) => peer),
    format: 'esm',
    metafile: true,
    minify: true,
    outdir: outputDirectory,
    platform: 'neutral',
    splitting: true,
    target: 'es2020',
    write: true,
  });

  const outputs = new Map(
    Object.entries(result.metafile.outputs).map(([file, metadata]) => [
      absoluteMetafilePath(file),
      metadata,
    ]),
  );
  const mainOutput = findEntryOutput(outputs, entries.main);
  const mainClosure = outputClosure(outputs, mainOutput);
  const mainInputs = sourceInputs(outputs, mainClosure);

  for (const peer of Object.values(adapterContract).map(({ peer }) => peer)) {
    await installPeerStub(temporaryRoot, peer);
  }

  const report = {};
  for (const [adapter, contract] of Object.entries(adapterContract)) {
    const entryOutput = findEntryOutput(outputs, entries[adapter]);
    const completeClosure = outputClosure(outputs, entryOutput);
    assert.ok(
      [...completeClosure].some((file) => mainClosure.has(file)),
      `${adapter} does not share its core runtime with the main entry`,
    );
    const optionalClosure = new Set(
      [...completeClosure].filter((file) => !mainClosure.has(file)),
    );
    const optionalInputs = sourceInputs(outputs, optionalClosure);
    const duplicateInputs = [...optionalInputs].filter((input) => mainInputs.has(input));
    assert.deepEqual(
      duplicateInputs.map((file) => path.relative(projectRoot, file)),
      [],
      `${adapter} duplicates source already charged to the main runtime`,
    );

    const bundledPeerInputs = [...optionalInputs].filter((input) => (
      input.includes(`${path.sep}node_modules${path.sep}${contract.peer}${path.sep}`)
    ));
    assert.deepEqual(bundledPeerInputs, [], `${adapter} bundled its ${contract.peer} peer`);

    const externalImports = new Set();
    for (const output of completeClosure) {
      for (const imported of outputs.get(output).imports) {
        if (imported.external) externalImports.add(imported.path);
      }
    }
    if (adapter !== 'svelte') {
      assert.equal(
        externalImports.has(contract.peer),
        true,
        `${adapter} did not preserve its peer as an external import`,
      );
    }

    const metrics = await gzipClosure(optionalClosure);
    assert.ok(metrics.members.length > 0, `${adapter} optional closure is empty`);
    assert.ok(
      metrics.gzip <= adapterBudget,
      `${adapter} optional closure is ${metrics.gzip} gzip bytes (cap ${adapterBudget})`,
    );

    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.window, 'undefined');
    const module = await import(
      `${pathToFileURL(entryOutput).href}?adapter-isolation=${adapter}`
    );
    assert.deepEqual(
      Object.keys(module).sort(),
      [...contract.exports],
      `${adapter} adapter export surface changed`,
    );

    report[adapter] = {
      gzip: metrics.gzip,
      raw: metrics.raw,
      members: metrics.members.map((member) => ({
        file: path.relative(outputDirectory, member.file),
        gzip: member.gzip,
        raw: member.raw,
      })),
    };
  }

  t.diagnostic(`adapter closure bytes ${JSON.stringify(report)}`);
});
