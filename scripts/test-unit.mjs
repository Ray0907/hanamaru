import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDirectory = fileURLToPath(new URL('../tests/unit/', import.meta.url));

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        return findTests(entryPath);
      }

      return entry.isFile() && entry.name.endsWith('.test.js') ? [entryPath] : [];
    }),
  );

  return names.flat();
}

const testFiles = (await findTests(testsDirectory)).sort();

if (testFiles.length === 0) {
  console.error('unit-tests: no test files found');
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
