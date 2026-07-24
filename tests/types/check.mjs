import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { orderTypeFixtures } from './fixtures.mjs';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testsDirectory, '..', '..');
const discoveredFixtures = (await readdir(testsDirectory))
  .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
;
const fixtureNames = orderTypeFixtures(discoveredFixtures);

const declarationPaths = {
  'hanamaru-annotations': ['types/index.d.ts'],
  'hanamaru-annotations/*': ['types/*/index.d.ts'],
};
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hanamaru-types-'));

try {
  for (const fixtureName of fixtureNames) {
    const configPath = path.join(
      temporaryDirectory,
      `${fixtureName.replaceAll('.', '-')}.json`,
    );
    const compilerOptions = {
      strict: true,
      noEmit: true,
      moduleResolution: 'bundler',
      module: 'esnext',
      target: 'es2020',
      lib: ['es2020', 'dom', 'dom.iterable'],
      baseUrl: projectRoot,
      paths: declarationPaths,
      skipLibCheck: false,
    };
    if (fixtureName.endsWith('.tsx')) compilerOptions.jsx = 'react-jsx';
    await writeFile(configPath, `${JSON.stringify({
      compilerOptions,
      files: [path.join(testsDirectory, fixtureName)],
    }, null, 2)}\n`);

    const result = spawnSync(
      path.join(projectRoot, 'node_modules', '.bin', 'tsc'),
      ['--project', configPath],
      {
        cwd: projectRoot,
        encoding: 'utf8',
      },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(`type fixture failed: ${fixtureName}`);
    }
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log(`types: ${fixtureNames.length} fixture${fixtureNames.length === 1 ? '' : 's'} passed`);
