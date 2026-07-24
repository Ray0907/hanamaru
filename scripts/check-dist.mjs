import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkBuiltExports } from './check-exports.mjs';
import {
  assertNoProductionDependencies,
  checkDistributionSize,
} from './check-size.mjs';

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

  const normalized = files.map(normalizedPackPath);
  for (const mandatory of ['package.json', 'README.md', 'LICENSE']) {
    if (!normalized.includes(mandatory)) {
      throw new Error(`dist-check: packed files missing ${mandatory}`);
    }
  }
  if (!normalized.some((file) => file.startsWith('dist/'))) {
    throw new Error('dist-check: packed files missing dist/**');
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const file = normalized[index];
    if (
      file !== 'package.json'
      && file !== 'README.md'
      && file !== 'LICENSE'
      && !file.startsWith('dist/')
    ) {
      throw new Error(`dist-check: unexpected packed file ${files[index]}`);
    }
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
  output.pack = await gates.checkDryPackShape(root);
  output.size = await gates.checkDistributionSize(root, { checkNpmTree: false });
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await checkDist(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'));
  console.log(`dist-check: pass (${result.size.length} size budgets)`);
}
