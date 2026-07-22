import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { constants, gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const distributionFiles = ['hanamaru.esm.js', 'hanamaru.iife.js'];
const HARD_COMBINED_GZIP_CAP = 20_480;
const STRETCH_COMBINED_GZIP_TARGET = 18_432;

export async function measureDistribution(root = process.cwd()) {
  const distributionDirectory = path.join(path.resolve(root), 'dist');
  const css = await readFile(path.join(distributionDirectory, 'hanamaru.css'));
  const cssGzip = gzipSync(css, { level: constants.Z_BEST_COMPRESSION }).length;
  const formats = [];

  for (const file of distributionFiles) {
    const source = await readFile(path.join(distributionDirectory, file));
    const raw = source.length;
    const gzip = gzipSync(source, { level: constants.Z_BEST_COMPRESSION }).length;
    const combined = gzip + cssGzip;
    formats.push({
      combined,
      cssGzip,
      file,
      gzip,
      raw,
      stretch: combined <= STRETCH_COMBINED_GZIP_TARGET,
    });
  }

  return {
    css: { file: 'hanamaru.css', gzip: cssGzip },
    formats,
  };
}

export async function writeSizeReport(root = process.cwd(), metrics) {
  const report = {
    budgets: {
      hardCombinedGzip: HARD_COMBINED_GZIP_CAP,
      stretchCombinedGzip: STRETCH_COMBINED_GZIP_TARGET,
    },
    css: metrics.css,
    formats: metrics.formats,
    schemaVersion: 1,
  };
  const source = `${JSON.stringify(report, null, 2)}\n`;
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

async function assertNoProductionPackages(root, options) {
  let result;
  try {
    result = await executeNpm(
      npmInvocationFor(options.platform, options.env),
      root,
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

export async function checkDistribution(root = process.cwd(), options = {}) {
  const projectRoot = path.resolve(root);
  const packagePath = path.join(projectRoot, 'package.json');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));

  if ('dependencies' in pkg) {
    throw new Error('dist-check: dependencies key must be absent');
  }

  if (options.checkNpmTree !== false) {
    await assertNoProductionPackages(projectRoot, options);
  }

  const metrics = await measureDistribution(projectRoot);
  for (const row of metrics.formats) {
    if (row.combined > HARD_COMBINED_GZIP_CAP) {
      throw new Error(
        `dist-check: ${row.file} exceeds ${HARD_COMBINED_GZIP_CAP} combined gzip bytes (${row.combined})`,
      );
    }
  }
  await writeSizeReport(projectRoot, metrics);
  return metrics.formats;
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedPath === import.meta.url) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const rows = await checkDistribution(root);
  for (const row of rows) {
    console.log(JSON.stringify(row));
  }
  console.log('dist-check: pass');
}
