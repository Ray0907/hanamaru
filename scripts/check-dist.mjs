import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkBuiltExports } from './check-exports.mjs';
import {
  assertNoProductionDependencies,
  checkDistributionSize,
} from './check-size.mjs';
import { projectRootFromModuleUrl } from './module-url.mjs';

export { projectRootFromModuleUrl };

function packInvocationFor(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return {
      file: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd pack --dry-run --json'],
    };
  }
  return { file: 'npm', args: ['pack', '--dry-run', '--json'] };
}

function executePack(invocation, root, execFileImpl) {
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

function normalizedPackPath(file) {
  return file.startsWith('package/') ? file.slice('package/'.length) : file;
}

export async function checkDryPackShape(root = process.cwd(), options = {}) {
  const projectRoot = path.resolve(root);
  const expectedDistFiles = options.expectedDistFiles
    ?? (await checkBuiltExports(projectRoot)).distFiles;
  let stdout;
  try {
    stdout = await executePack(
      packInvocationFor(options.platform, options.env),
      projectRoot,
      options.execFileImpl ?? execFile,
    );
  } catch {
    throw new Error('dist-check: npm pack --dry-run failed');
  }
  const result = JSON.parse(stdout);
  const files = result?.[0]?.files?.map(({ path: file }) => file);
  if (!Array.isArray(files)) throw new Error('dist-check: invalid npm pack dry-run output');

  const normalized = files.map(normalizedPackPath).sort();
  const expected = [
    'package.json',
    'README.md',
    'LICENSE',
    ...expectedDistFiles.map((file) => `dist/${file}`),
  ].sort();
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    const actualSet = new Set(normalized);
    const expectedSet = new Set(expected);
    const missing = expected.filter((file) => !actualSet.has(file));
    const unexpected = normalized.filter((file) => !expectedSet.has(file));
    const details = [
      missing.length > 0 ? `missing packed file ${missing.join(', ')}` : '',
      unexpected.length > 0 ? `unexpected packed file ${unexpected.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(
      `dist-check: packed file set does not match validated distribution (${details})`,
    );
  }
  return files;
}

export async function checkDist(root = process.cwd(), dependencies = {}) {
  const gates = {
    assertNoProductionDependencies:
      dependencies.assertNoProductionDependencies ?? assertNoProductionDependencies,
    checkBuiltExports: dependencies.checkBuiltExports ?? checkBuiltExports,
    checkDryPackShape: dependencies.checkDryPackShape ?? checkDryPackShape,
    checkDistributionSize: dependencies.checkDistributionSize ?? checkDistributionSize,
  };
  const output = {};
  output.dependencies = await gates.assertNoProductionDependencies(root);
  output.exports = await gates.checkBuiltExports(root);
  output.pack = await gates.checkDryPackShape(root, {
    expectedDistFiles: output.exports.distFiles,
  });
  output.size = await gates.checkDistributionSize(root, { checkNpmTree: false });
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await checkDist(projectRootFromModuleUrl(import.meta.url));
  console.log(`dist-check: pass (${result.size.length} size budgets)`);
}
