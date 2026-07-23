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
const adapterSourceRoot = path.join(sourceRoot, 'adapters');
const entries = Object.freeze({
  main: path.join(sourceRoot, 'index.js'),
  react: path.join(sourceRoot, 'adapters', 'react.js'),
  vue: path.join(sourceRoot, 'adapters', 'vue.js'),
  svelte: path.join(sourceRoot, 'adapters', 'svelte.js'),
});
const adapterContract = Object.freeze({
  react: Object.freeze({
    peer: 'react',
    externalImports: Object.freeze(['react']),
    exports: Object.freeze(['useAnnotation']),
  }),
  vue: Object.freeze({
    peer: 'vue',
    externalImports: Object.freeze(['vue']),
    exports: Object.freeze(['useAnnotation']),
  }),
  svelte: Object.freeze({
    peer: 'svelte',
    externalImports: Object.freeze([]),
    exports: Object.freeze(['annotation']),
  }),
});
const frameworkPeerUniverse = Object.freeze([
  'react',
  'react-dom',
  'vue',
  'svelte',
]);
const domGlobalNames = Object.freeze(['document', 'window']);
const adapterBudget = 4_096;
let nextSsrImport = 0;

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

function allSourceInputs(outputs, closure) {
  const inputs = new Set();
  for (const output of closure) {
    for (const input of Object.keys(outputs.get(output).inputs)) {
      inputs.add(absoluteMetafilePath(input));
    }
  }
  return inputs;
}

function externalImports(outputs, closure) {
  const imports = new Set();
  for (const output of closure) {
    for (const imported of outputs.get(output).imports) {
      if (imported.external) imports.add(imported.path);
    }
  }
  return imports;
}

function frameworkPeerRoot(imported) {
  return frameworkPeerUniverse.find((peer) => (
    imported === peer || imported.startsWith(`${peer}/`)
  ));
}

function assertExternalContract(label, imports, expectedImports) {
  const actual = [...imports].sort();
  const expected = [...expectedImports].sort();
  assert.deepEqual(actual, expected, `${label} external imports changed`);
  assert.deepEqual(
    [...new Set(actual.map(frameworkPeerRoot).filter(Boolean))].sort(),
    [...new Set(expected.map(frameworkPeerRoot).filter(Boolean))].sort(),
    `${label} framework peer external set changed`,
  );
}

function insideDirectory(file, directory) {
  const relative = path.relative(directory, file);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function adapterSourceLabel(file) {
  return path.relative(adapterSourceRoot, file).split(path.sep).join('/');
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

function appendSourcePlugin(entryPoint, suffix, name) {
  const expected = path.normalize(entryPoint);
  return {
    name,
    setup(buildApi) {
      buildApi.onLoad({ filter: /.*/ }, async (arguments_) => {
        if (path.normalize(arguments_.path) !== expected) return undefined;
        const source = await readFile(arguments_.path, 'utf8');
        return { contents: `${source}\n${suffix}\n`, loader: 'js' };
      });
    },
  };
}

function restoreGlobalDescriptor(name, descriptor) {
  if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
  else Reflect.defineProperty(globalThis, name, descriptor);
}

function readDomGlobalDescriptors() {
  return new Map(
    domGlobalNames.map((name) => [
      name,
      Reflect.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
}

function assertDomGlobalsUnavailable(descriptors, label) {
  for (const [name, descriptor] of descriptors) {
    assert.ok(
      descriptor === undefined
        || (Object.hasOwn(descriptor, 'value') && descriptor.value === undefined),
      `${label} ${name} must be absent or undefined`,
    );
  }
}

function restoreDomGlobalDescriptors(descriptors) {
  for (const [name, descriptor] of descriptors) {
    restoreGlobalDescriptor(name, descriptor);
  }
}

async function importServerSafe(adapter, entryOutput) {
  const before = readDomGlobalDescriptors();
  assertDomGlobalsUnavailable(before, `${adapter} SSR import before`);
  let module;
  try {
    nextSsrImport += 1;
    module = await import(
      `${pathToFileURL(entryOutput).href}?adapter-isolation=${adapter}-${nextSsrImport}`
    );
    const after = readDomGlobalDescriptors();
    assert.deepEqual(
      [...after],
      [...before],
      `${adapter} SSR import changed DOM globals`,
    );
    assertDomGlobalsUnavailable(after, `${adapter} SSR import after`);
  } finally {
    restoreDomGlobalDescriptors(before);
  }
  return module;
}

async function verifyAdapterBuild({
  plugins = [],
  extraExternal = [],
} = {}) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hanamaru-adapters-'));
  const outputDirectory = path.join(temporaryRoot, 'out');

  try {
    const result = await build({
      absWorkingDir: projectRoot,
      bundle: true,
      entryNames: '[name]',
      entryPoints: entries,
      external: [
        ...frameworkPeerUniverse,
        ...extraExternal,
      ],
      format: 'esm',
      metafile: true,
      minify: true,
      outdir: outputDirectory,
      platform: 'neutral',
      plugins,
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
    const mainAdapterInputs = [...allSourceInputs(outputs, mainClosure)].filter((input) => (
      insideDirectory(input, path.join(sourceRoot, 'adapters'))
    ));
    assert.deepEqual(
      mainAdapterInputs.map((file) => path.relative(projectRoot, file)).sort(),
      [],
      'main closure contains adapter source',
    );
    assertExternalContract('main', externalImports(outputs, mainClosure), []);

    const stubbedExternals = new Set([
      ...frameworkPeerUniverse,
      ...extraExternal,
    ]);
    for (const peer of stubbedExternals) {
      await installPeerStub(temporaryRoot, peer);
    }

    const report = {};
    for (const [adapter, contract] of Object.entries(adapterContract)) {
      const entryOutput = findEntryOutput(outputs, entries[adapter]);
      const completeClosure = outputClosure(outputs, entryOutput);
      const localAdapterSources = [...allSourceInputs(outputs, completeClosure)]
        .filter((input) => insideDirectory(input, adapterSourceRoot))
        .map(adapterSourceLabel)
        .sort();
      assert.deepEqual(
        localAdapterSources,
        [`${adapter}.js`, 'lifecycle.js'].sort(),
        `${adapter} local adapter sources changed`,
      );
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
      assert.deepEqual(
        bundledPeerInputs,
        [],
        `${adapter} bundled its ${contract.peer} peer`,
      );

      assertExternalContract(
        adapter,
        externalImports(outputs, completeClosure),
        contract.externalImports,
      );

      const metrics = await gzipClosure(optionalClosure);
      assert.ok(metrics.members.length > 0, `${adapter} optional closure is empty`);
      assert.ok(
        metrics.gzip <= adapterBudget,
        `${adapter} optional closure is ${metrics.gzip} gzip bytes (cap ${adapterBudget})`,
      );

      const module = await importServerSafe(adapter, entryOutput);
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

    return report;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test('framework adapter bundles remain isolated, peer-external, server-safe, and within budget', async (t) => {
  const report = await verifyAdapterBuild();
  t.diagnostic(`adapter closure bytes ${JSON.stringify(report)}`);
});

test('mutation: a side-effect adapter import cannot enter the main closure', async () => {
  await assert.rejects(
    verifyAdapterBuild({
      plugins: [
        appendSourcePlugin(
          entries.main,
          'import "./adapters/svelte.js";',
          'mutate-main-adapter-import',
        ),
      ],
    }),
    /main closure contains adapter source/,
  );
});

test('mutation: an adapter cannot add an undeclared framework external', async () => {
  await assert.rejects(
    verifyAdapterBuild({
      extraExternal: ['react-dom'],
      plugins: [
        appendSourcePlugin(
          entries.react,
          'import "react-dom";',
          'mutate-react-peer-import',
        ),
      ],
    }),
    /react external imports changed/,
  );
});

test('mutation: a framework adapter cannot retain another adapter entry', async () => {
  await assert.rejects(
    verifyAdapterBuild({
      plugins: [
        appendSourcePlugin(
          entries.react,
          [
            'import { annotation as leakedSvelteAnnotation } from "./svelte.js";',
            'if (globalThis.__hana_adapter_mutation__) {',
            '  globalThis.__hana_adapter_mutation_sink__ = leakedSvelteAnnotation;',
            '}',
          ].join('\n'),
          'mutate-react-local-adapter-import',
        ),
      ],
    }),
    /react local adapter sources changed/,
  );
});

test('mutation: an SSR adapter import cannot poison DOM globals', async () => {
  const descriptors = new Map(
    ['document', 'window'].map((name) => [
      name,
      Reflect.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  try {
    await assert.rejects(
      verifyAdapterBuild({
        plugins: [
          appendSourcePlugin(
            entries.svelte,
            'globalThis.document = {}; globalThis.window = {};',
            'mutate-svelte-dom-globals',
          ),
        ],
      }),
      /svelte SSR import changed DOM globals/,
    );
  } finally {
    for (const [name, descriptor] of descriptors) {
      restoreGlobalDescriptor(name, descriptor);
    }
  }
});
