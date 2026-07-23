import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { constants, gzipSync } from 'node:zlib';
import { buildDistribution } from '../../scripts/build.mjs';

test('buildDistribution writes minified ESM, IIFE, and namespaced CSS', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(path.join(root, 'src'));
  await writeFile(
    path.join(root, 'src', 'shared.js'),
    `export const shared = '${'shared-runtime-'.repeat(64)}';\n`,
  );
  await writeFile(
    path.join(root, 'src', 'index.js'),
    "export { shared as VERSION } from './shared.js';\n",
  );
  await writeFile(
    path.join(root, 'src', 'selection.js'),
    "export { shared as annotateSelection } from './shared.js';\n",
  );
  await writeFile(
    path.join(root, 'src', 'serialize.js'),
    "export { shared as serialize } from './shared.js';\n",
  );
  await writeFile(
    path.join(root, 'src', 'plugins.js'),
    "export { shared as registerMark } from './shared.js';\n",
  );
  await writeFile(
    path.join(root, 'src', 'hanamaru.css'),
    '/* fixture */\n.hana-fixture { color: red; }\n',
  );

  await buildDistribution(root);

  assert.match(await readFile(path.join(root, 'dist', 'hanamaru.esm.js'), 'utf8'), /VERSION/);
  assert.match(
    await readFile(path.join(root, 'dist', 'hanamaru.selection.esm.js'), 'utf8'),
    /annotateSelection/,
  );
  assert.match(
    await readFile(path.join(root, 'dist', 'hanamaru.serialize.esm.js'), 'utf8'),
    /serialize/,
  );
  assert.match(
    await readFile(path.join(root, 'dist', 'hanamaru.plugins.esm.js'), 'utf8'),
    /registerMark/,
  );
  assert.match(await readFile(path.join(root, 'dist', 'hanamaru.iife.js'), 'utf8'), /Hanamaru/);
  assert.equal(
    await readFile(path.join(root, 'dist', 'hanamaru.css'), 'utf8'),
    '.hana-fixture{color:red}\n',
  );
});

test('size report survives two consecutive injected-root builds', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-build-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(path.join(root, 'src'));
  await writeFile(
    path.join(root, 'src', 'shared.js'),
    `export const shared = '${'shared-runtime-'.repeat(64)}';\n`,
  );
  await writeFile(
    path.join(root, 'src', 'index.js'),
    "export { shared as VERSION } from './shared.js';\n",
  );
  await writeFile(
    path.join(root, 'src', 'selection.js'),
    "export { shared as annotateSelection } from './shared.js';\n",
  );
  await writeFile(
    path.join(root, 'src', 'serialize.js'),
    "export { shared as serialize } from './shared.js';\n",
  );
  await writeFile(
    path.join(root, 'src', 'plugins.js'),
    "export { shared as registerMark } from './shared.js';\n",
  );
  await writeFile(path.join(root, 'src', 'hanamaru.css'), '.hana-fixture { color: red; }\n');

  await buildDistribution(root);
  const first = await readFile(path.join(root, 'dist', 'size-report.json'), 'utf8');
  await buildDistribution(root);
  const second = await readFile(path.join(root, 'dist', 'size-report.json'), 'utf8');

  assert.equal(second, first);
  assert.equal(first.endsWith('\n'), true);
  const report = JSON.parse(first);
  assert.deepEqual(report.formats.map(({ file }) => file), [
    'hanamaru.esm.js',
    'hanamaru.iife.js',
  ]);
  assert.equal(report.css.file, 'hanamaru.css');
  assert.equal(Number.isInteger(report.css.gzip), true);
  const esmEntry = await readFile(path.join(root, 'dist', 'hanamaru.esm.js'));
  const esmRow = report.formats.find(({ file }) => file === 'hanamaru.esm.js');
  assert.ok(
    esmRow.raw > esmEntry.length,
    'ESM size must include shared chunks reachable from the root entry',
  );
  assert.ok(
    esmRow.gzip > gzipSync(esmEntry, { level: constants.Z_BEST_COMPRESSION }).length,
    'ESM gzip must include each reachable shared chunk',
  );
});

test('package exports route the four public ESM entry points to built artifacts', async () => {
  const pkg = JSON.parse(await readFile(
    new URL('../../package.json', import.meta.url),
    'utf8',
  ));

  assert.equal(pkg.exports['.'], './dist/hanamaru.esm.js');
  assert.equal(pkg.exports['./selection'], './dist/hanamaru.selection.esm.js');
  assert.equal(pkg.exports['./serialize'], './dist/hanamaru.serialize.esm.js');
  assert.equal(pkg.exports['./plugins'], './dist/hanamaru.plugins.esm.js');
  assert.equal(Object.values(pkg.exports).some((target) => target.includes('/src/')), false);
});
