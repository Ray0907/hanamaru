import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { constants, gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const distributionFiles = ['hanamaru.esm.js', 'hanamaru.iife.js'];

async function assertNoProductionPackages(root) {
  let result;
  try {
    result = await executeFile('npm', ['ls', '--omit=dev', '--json'], { cwd: root });
  } catch {
    throw new Error('dist-check: npm ls --omit=dev failed');
  }

  const tree = JSON.parse(result.stdout);
  if (Object.keys(tree.dependencies ?? {}).length > 0) {
    throw new Error('dist-check: production dependency tree must be empty');
  }
}

export async function checkDistribution(root = process.cwd(), options = {}) {
  const projectRoot = path.resolve(root);
  const packagePath = path.join(projectRoot, 'package.json');
  const distributionDirectory = path.join(projectRoot, 'dist');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));

  if ('dependencies' in pkg) {
    throw new Error('dist-check: dependencies key must be absent');
  }

  if (options.checkNpmTree !== false) {
    await assertNoProductionPackages(projectRoot);
  }

  const css = await readFile(path.join(distributionDirectory, 'hanamaru.css'));
  const cssGzip = gzipSync(css, { level: constants.Z_BEST_COMPRESSION }).length;
  const rows = [];

  for (const file of distributionFiles) {
    const source = await readFile(path.join(distributionDirectory, file));
    const raw = source.length;
    const gzip = gzipSync(source, { level: constants.Z_BEST_COMPRESSION }).length;
    const combined = gzip + cssGzip;
    if (combined > 8192) {
      throw new Error(`dist-check: ${file} exceeds 8192 bytes (${combined})`);
    }
    rows.push({ file, raw, gzip, cssGzip, combined, stretch: gzip <= 5120 });
  }

  return rows;
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
