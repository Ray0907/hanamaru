import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEsmGraph } from './esm-graph.mjs';
import { projectRootFromModuleUrl } from './module-url.mjs';

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

const FIXED_DISTRIBUTION_FILES = Object.freeze([
  ...Object.keys(PUBLIC_ENTRIES),
  'hanamaru.iife.js',
  'hanamaru.css',
  ...DECLARATIONS,
  'shadow/hanamaru-shadow.css',
  'size-report.json',
].sort());

async function listDistributionFiles(distributionDirectory) {
  const files = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }
  await visit(distributionDirectory);
  return files.sort();
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

async function assertSharedSingleton(distributionDirectory, graphs) {
  const graphList = [...graphs.values()]
    .map((members) => new Set(members.map(({ file }) => file)));
  const commonChunks = [...graphList[0]].filter((file) => (
    file.startsWith('_chunks/')
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

  return commonChunks.sort()[0];
}

export async function checkBuiltExports(root = process.cwd()) {
  const projectRoot = path.resolve(root);
  const distributionDirectory = path.join(projectRoot, 'dist');
  const graphs = new Map();
  const actualFiles = await listDistributionFiles(distributionDirectory);
  const actualFileSet = new Set(actualFiles);
  for (const file of FIXED_DISTRIBUTION_FILES) {
    if (!actualFileSet.has(file)) {
      throw new Error(`dist-check: missing dist artifact ${file}`);
    }
  }

  const reachableChunks = new Set();
  for (const [entry, expectedNames] of Object.entries(PUBLIC_ENTRIES)) {
    const entryPath = path.join(distributionDirectory, entry);
    const graph = await readEsmGraph(entryPath, distributionDirectory);
    graphs.set(entry, graph);
    for (const member of graph) {
      if (!member.file.startsWith('_chunks/')) continue;
      if (!/^_chunks\/[^/]+\.js$/u.test(member.file)) {
        throw new Error(`dist-check: invalid _chunks artifact ${member.file}`);
      }
      reachableChunks.add(member.file);
    }
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

  const expectedFiles = [...FIXED_DISTRIBUTION_FILES, ...reachableChunks].sort();
  const expectedFileSet = new Set(expectedFiles);
  for (const file of expectedFiles) {
    if (!actualFileSet.has(file)) {
      throw new Error(`dist-check: missing dist artifact ${file}`);
    }
  }
  for (const file of actualFiles) {
    if (!expectedFileSet.has(file)) {
      throw new Error(`dist-check: unexpected dist artifact ${file}`);
    }
  }

  await assertPackageTargets(projectRoot);
  const singletonChunk = await assertSharedSingleton(distributionDirectory, graphs);

  return {
    entries: Object.keys(PUBLIC_ENTRIES),
    singletonChunk,
    distFiles: expectedFiles,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await checkBuiltExports(projectRootFromModuleUrl(import.meta.url));
  console.log(`dist-check: exports pass (${result.entries.length} entries)`);
}
