import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PUBLIC_ENTRIES = Object.freeze({
  'hanamaru.esm.js': Object.freeze([
    'HanamaruConfigError',
    'HanamaruError',
    'HanamaruStateError',
    'HanamaruTargetError',
    'VERSION',
    'annotate',
    'scan',
    'story',
  ]),
  'selection/index.js': Object.freeze(['annotateSelection']),
  'serialize/index.js': Object.freeze([
    'resolveSerializedTarget',
    'restore',
    'serialize',
  ]),
  'group/index.js': Object.freeze(['group']),
  'plugins/index.js': Object.freeze(['registerMark']),
  'shadow/index.js': Object.freeze(['createShadowScope']),
  'react/index.js': Object.freeze(['useAnnotation']),
  'vue/index.js': Object.freeze(['useAnnotation']),
  'svelte/index.js': Object.freeze(['annotation']),
});

const DECLARATIONS = Object.freeze([
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

function localEsmSpecifiers(source) {
  const specifiers = [];
  const staticPattern = /\b(?:import|export)\s*(?:[^;"']*?\bfrom\s*)?["'](\.[^"']+)["']/gu;
  const dynamicPattern = /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/gu;
  for (const pattern of [staticPattern, dynamicPattern]) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push({ index: match.index, specifier: match[1] });
    }
  }
  return specifiers
    .sort((left, right) => left.index - right.index)
    .map(({ specifier }) => specifier);
}

function relativeFile(distributionDirectory, filePath) {
  return path.relative(distributionDirectory, filePath).split(path.sep).join('/');
}

async function validateGraph(entryPath, distributionDirectory) {
  const files = new Set();
  const resolvedDistributionDirectory = path.resolve(distributionDirectory);

  async function visit(filePath) {
    const resolvedPath = path.resolve(filePath);
    const relativePath = path.relative(resolvedDistributionDirectory, resolvedPath);
    if (
      relativePath === '..'
      || relativePath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativePath)
    ) {
      throw new Error(`dist-check: ESM import leaves dist (${relativePath})`);
    }
    if (files.has(resolvedPath)) return;
    files.add(resolvedPath);
    const source = await readFile(resolvedPath, 'utf8');
    for (const specifier of localEsmSpecifiers(source)) {
      await visit(path.resolve(
        path.dirname(resolvedPath),
        specifier.split(/[?#]/u, 1)[0],
      ));
    }
  }

  await visit(entryPath);
  return files;
}

function packageTargets(exportsMap) {
  const targets = [];
  function collect(value) {
    if (typeof value === 'string') targets.push(value);
    else if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) collect(child);
    }
  }
  collect(exportsMap);
  return targets;
}

async function assertPackageTargets(projectRoot) {
  const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  for (const target of packageTargets(pkg.exports)) {
    if (!target.startsWith('./')) {
      throw new Error(`dist-check: package export must be relative (${target})`);
    }
    const resolved = path.resolve(projectRoot, target);
    const relative = path.relative(projectRoot, resolved);
    if (
      relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      throw new Error(`dist-check: package export leaves project (${target})`);
    }
    await access(resolved);
  }
}

async function assertChunkTree(distributionDirectory) {
  const chunkDirectory = path.join(distributionDirectory, '_chunks');
  for (const entry of await readdir(chunkDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[^/\\]+\.js$/u.test(entry.name)) {
      throw new Error(`dist-check: invalid _chunks artifact _chunks/${entry.name}`);
    }
  }
}

async function assertSharedSingleton(distributionDirectory, graphs) {
  const graphList = [...graphs.values()];
  const commonChunks = [...graphList[0]].filter((file) => (
    file.includes(`${path.sep}_chunks${path.sep}`)
    && graphList.every((graph) => graph.has(file))
  ));
  if (commonChunks.length === 0) {
    throw new Error('dist-check: ESM entries do not share a runtime singleton chunk');
  }

  const pluginPath = path.join(distributionDirectory, 'plugins', 'index.js');
  const [first, second] = await Promise.all([
    import(`${pathToFileURL(pluginPath).href}?singleton-probe=first`),
    import(`${pathToFileURL(pluginPath).href}?singleton-probe=second`),
  ]);
  const name = `dist-check-${process.pid}-${Date.now()}`;
  const factory = () => ({ paths: ['M 0 0'] });
  const unregister = first.registerMark(name, factory);
  let shared = false;
  try {
    try {
      second.registerMark(name, factory);
    } catch {
      shared = true;
    }
  } finally {
    unregister();
  }
  if (!shared) {
    throw new Error('dist-check: plugin registration did not share singleton state');
  }
  const cleanup = second.registerMark(name, factory);
  cleanup();

  return relativeFile(distributionDirectory, commonChunks.sort()[0]);
}

export async function checkBuiltExports(root = process.cwd()) {
  const projectRoot = path.resolve(root);
  const distributionDirectory = path.join(projectRoot, 'dist');
  const graphs = new Map();

  await assertChunkTree(distributionDirectory);
  for (const [entry, expectedNames] of Object.entries(PUBLIC_ENTRIES)) {
    const entryPath = path.join(distributionDirectory, entry);
    const graph = await validateGraph(entryPath, distributionDirectory);
    graphs.set(entry, graph);
    const module = await import(
      `${pathToFileURL(entryPath).href}?check-exports=${encodeURIComponent(entry)}`
    );
    const actualNames = Object.keys(module).sort();
    const expected = [...expectedNames].sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expected)) {
      throw new Error(
        `dist-check: ${entry} exports ${actualNames.join(',')} (expected ${expected.join(',')})`,
      );
    }
  }

  for (const declaration of DECLARATIONS) {
    await access(path.join(distributionDirectory, declaration));
  }
  await access(path.join(distributionDirectory, 'hanamaru.css'));
  await access(path.join(distributionDirectory, 'shadow', 'hanamaru-shadow.css'));
  await assertPackageTargets(projectRoot);
  const singletonChunk = await assertSharedSingleton(distributionDirectory, graphs);

  return {
    entries: Object.keys(PUBLIC_ENTRIES),
    singletonChunk,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await checkBuiltExports(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
  );
  console.log(`dist-check: exports pass (${result.entries.length} entries)`);
}
