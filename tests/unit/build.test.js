import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildDistribution } from '../../scripts/build.mjs';

test('buildDistribution writes minified ESM, IIFE, and namespaced CSS', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'index.js'), "export const VERSION = 'fixture';\n");
  await writeFile(
    path.join(root, 'src', 'hanamaru.css'),
    '/* fixture */\n.hana-fixture { color: red; }\n',
  );

  await buildDistribution(root);

  assert.match(await readFile(path.join(root, 'dist', 'hanamaru.esm.js'), 'utf8'), /VERSION/);
  assert.match(await readFile(path.join(root, 'dist', 'hanamaru.iife.js'), 'utf8'), /Hanamaru/);
  assert.equal(
    await readFile(path.join(root, 'dist', 'hanamaru.css'), 'utf8'),
    '.hana-fixture{color:red}\n',
  );
});
