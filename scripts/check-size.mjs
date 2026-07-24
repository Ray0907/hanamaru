import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { constants, gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HARD_BUDGETS = Object.freeze({
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

export const STRETCH_BUDGETS = Object.freeze({
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

const ENTRIES = Object.freeze([
  ['main', 'hanamaru.esm.js'],
  ['iife', 'hanamaru.iife.js'],
  ['selection', 'selection/index.js'],
  ['serialize', 'serialize/index.js'],
  ['group', 'group/index.js'],
  ['plugins', 'plugins/index.js'],
  ['shadow', 'shadow/index.js'],
  ['react', 'react/index.js'],
  ['vue', 'vue/index.js'],
  ['svelte', 'svelte/index.js'],
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

async function readEsmGraph(entryPath, distributionDirectory) {
  const members = [];
  const seen = new Set();
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
    if (seen.has(resolvedPath)) return;
    seen.add(resolvedPath);

    const source = await readFile(resolvedPath);
    members.push({ file: relativeFile(resolvedDistributionDirectory, resolvedPath), source });
    for (const specifier of localEsmSpecifiers(source.toString('utf8'))) {
      const cleanSpecifier = specifier.split(/[?#]/u, 1)[0];
      await visit(path.resolve(path.dirname(resolvedPath), cleanSpecifier));
    }
  }

  await visit(entryPath);
  return members;
}

function measuredMember(file, source) {
  return {
    file,
    rawBytes: source.length,
    gzipBytes: gzipSync(source, { level: constants.Z_BEST_COMPRESSION }).length,
  };
}

function createEntryReport(entry, entryFile, members) {
  const measured = members.map(({ file, source }) => measuredMember(file, source));
  const rawBytes = measured.reduce((total, member) => total + member.rawBytes, 0);
  const gzipBytes = measured.reduce((total, member) => total + member.gzipBytes, 0);
  return {
    entry,
    entryFile,
    chargedFiles: measured.map(({ file }) => file),
    members: measured,
    rawBytes,
    gzipBytes,
    budgetBytes: HARD_BUDGETS[entry],
    stretchBytes: STRETCH_BUDGETS[entry],
    stretch: gzipBytes <= STRETCH_BUDGETS[entry],
  };
}

export async function measureDistribution(root = process.cwd()) {
  const distributionDirectory = path.join(path.resolve(root), 'dist');
  const mainGraph = await readEsmGraph(
    path.join(distributionDirectory, 'hanamaru.esm.js'),
    distributionDirectory,
  );
  const mainFiles = new Set(mainGraph.map(({ file }) => file));
  const css = await readFile(path.join(distributionDirectory, 'hanamaru.css'));
  const entries = [
    createEntryReport('main', 'hanamaru.esm.js', [
      ...mainGraph,
      { file: 'hanamaru.css', source: css },
    ]),
    createEntryReport('iife', 'hanamaru.iife.js', [
      {
        file: 'hanamaru.iife.js',
        source: await readFile(path.join(distributionDirectory, 'hanamaru.iife.js')),
      },
      { file: 'hanamaru.css', source: css },
    ]),
  ];

  for (const [entry, entryFile] of ENTRIES.slice(2)) {
    const graph = await readEsmGraph(
      path.join(distributionDirectory, entryFile),
      distributionDirectory,
    );
    const charged = graph.filter(({ file }) => !mainFiles.has(file));
    if (entry === 'shadow') {
      charged.push({
        file: 'shadow/hanamaru-shadow.css',
        source: await readFile(
          path.join(distributionDirectory, 'shadow', 'hanamaru-shadow.css'),
        ),
      });
    }
    entries.push(createEntryReport(entry, entryFile, charged));
  }

  return {
    schemaVersion: 2,
    budgets: {
      hard: HARD_BUDGETS,
      stretch: STRETCH_BUDGETS,
    },
    entries,
  };
}

export async function writeSizeReport(root = process.cwd(), metrics) {
  const source = `${JSON.stringify(metrics, null, 2)}\n`;
  await writeFile(path.join(path.resolve(root), 'dist', 'size-report.json'), source);
  return source;
}

export function npmInvocationFor(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return {
      file: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd ls --omit=dev --json'],
    };
  }
  return { file: 'npm', args: ['ls', '--omit=dev', '--json'] };
}

function executeNpm(invocation, root, execFileImpl) {
  return new Promise((resolve, reject) => {
    execFileImpl(invocation.file, invocation.args, { cwd: root }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

export async function assertNoProductionDependencies(root = process.cwd(), options = {}) {
  const projectRoot = path.resolve(root);
  const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  if ('dependencies' in pkg) {
    throw new Error('dist-check: dependencies key must be absent');
  }
  if (options.checkNpmTree === false) return;

  let result;
  try {
    result = await executeNpm(
      npmInvocationFor(options.platform, options.env),
      projectRoot,
      options.execFileImpl ?? execFile,
    );
  } catch {
    throw new Error('dist-check: npm ls --omit=dev failed');
  }

  const tree = JSON.parse(result);
  if (Object.keys(tree.dependencies ?? {}).length > 0) {
    throw new Error('dist-check: production dependency tree must be empty');
  }
}

export async function checkDistributionSize(root = process.cwd(), options = {}) {
  const projectRoot = path.resolve(root);
  await assertNoProductionDependencies(projectRoot, options);
  const metrics = await measureDistribution(projectRoot);
  for (const row of metrics.entries) {
    if (row.gzipBytes > row.budgetBytes) {
      throw new Error(
        `dist-check: ${row.entry} exceeds ${row.budgetBytes} gzip bytes (${row.gzipBytes})`,
      );
    }
  }
  await writeSizeReport(projectRoot, metrics);
  return metrics.entries;
}

export const checkDistribution = checkDistributionSize;

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedPath === import.meta.url) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const rows = await checkDistributionSize(root);
  for (const row of rows) console.log(JSON.stringify(row));
  console.log('dist-check: pass');
}
