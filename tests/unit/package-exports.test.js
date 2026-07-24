import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const sourceContracts = Object.freeze({
  'src/index.js': Object.freeze([
    'HanamaruConfigError',
    'HanamaruError',
    'HanamaruStateError',
    'HanamaruTargetError',
    'VERSION',
    'annotate',
    'scan',
    'story',
  ]),
  'src/entries/selection.js': Object.freeze(['annotateSelection']),
  'src/entries/group.js': Object.freeze(['group']),
  'src/entries/plugins.js': Object.freeze(['registerMark']),
  'src/entries/serialize.js': Object.freeze([
    'resolveSerializedTarget',
    'restore',
    'serialize',
  ]),
  'src/entries/shadow.js': Object.freeze(['createShadowScope']),
  'src/entries/react.js': Object.freeze(['useAnnotation']),
  'src/entries/vue.js': Object.freeze(['useAnnotation']),
  'src/entries/svelte.js': Object.freeze(['annotation']),
});

const expectedExports = Object.freeze({
  '.': {
    types: './dist/index.d.ts',
    import: './dist/hanamaru.esm.js',
  },
  './style.css': './dist/hanamaru.css',
  './selection': {
    types: './dist/selection/index.d.ts',
    import: './dist/selection/index.js',
  },
  './serialize': {
    types: './dist/serialize/index.d.ts',
    import: './dist/serialize/index.js',
  },
  './group': {
    types: './dist/group/index.d.ts',
    import: './dist/group/index.js',
  },
  './plugins': {
    types: './dist/plugins/index.d.ts',
    import: './dist/plugins/index.js',
  },
  './shadow': {
    types: './dist/shadow/index.d.ts',
    import: './dist/shadow/index.js',
  },
  './shadow/style.css': './dist/shadow/hanamaru-shadow.css',
  './react': {
    types: './dist/react/index.d.ts',
    import: './dist/react/index.js',
  },
  './vue': {
    types: './dist/vue/index.d.ts',
    import: './dist/vue/index.js',
  },
  './svelte': {
    types: './dist/svelte/index.d.ts',
    import: './dist/svelte/index.js',
  },
  './package.json': './package.json',
});

async function packageJson() {
  return JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
}

for (const [relativePath, names] of Object.entries(sourceContracts)) {
  test(`source entry ${relativePath} exports only its public contract`, async () => {
    const module = await import(pathToFileURL(path.join(projectRoot, relativePath)));
    assert.deepEqual(Object.keys(module).sort(), [...names].sort());
  });
}

test('metadata declares the normative release identity and export targets', async () => {
  const manifest = await packageJson();
  assert.equal(manifest.name, 'hanamaru-annotations');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(
    manifest.description,
    'A reliable, human annotation runtime for the DOM',
  );
  assert.equal(manifest.author, 'Ray Tien');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.repository, {
    type: 'git',
    url: 'https://github.com/Ray0907/hanamaru.git',
  });
  assert.equal(manifest.homepage, 'https://github.com/Ray0907/hanamaru#readme');
  assert.deepEqual(manifest.bugs, {
    url: 'https://github.com/Ray0907/hanamaru/issues',
  });
  assert.equal(manifest.types, './dist/index.d.ts');
  assert.deepEqual(manifest.exports, expectedExports);
  assert.deepEqual(manifest.files, ['dist', 'README.md', 'LICENSE']);
  assert.deepEqual(manifest.sideEffects, [
    './dist/hanamaru.css',
    './dist/shadow/hanamaru-shadow.css',
  ]);
  assert.ok(manifest.keywords.includes('annotation'));
  assert.ok(manifest.keywords.includes('svg'));
  assert.ok(manifest.keywords.includes('accessibility'));
  assert.equal(Object.hasOwn(manifest, 'dependencies'), false);
});

test('peer metadata keeps framework runtimes optional and out of production dependencies', async () => {
  const manifest = await packageJson();
  assert.deepEqual(manifest.peerDependencies, {
    react: '>=18.2.0 <20',
    svelte: '>=5.0.0 <6',
    vue: '>=3.5.0 <4',
  });
  assert.deepEqual(manifest.peerDependenciesMeta, {
    react: { optional: true },
    svelte: { optional: true },
    vue: { optional: true },
  });
  assert.equal(manifest.devDependencies.react, '19.2.8');
  assert.equal(manifest.devDependencies['react-dom'], '19.2.8');
  assert.equal(manifest.devDependencies['@types/react'], '19.2.17');
  assert.equal(manifest.devDependencies['@types/react-dom'], '19.2.3');
  assert.equal(manifest.devDependencies.vue, '3.5.40');
  assert.equal(manifest.devDependencies.svelte, '5.56.7');
  assert.equal(manifest.devDependencies.typescript, '5.9.2');
});

test('metadata defines the fixed ordered verification stages', async () => {
  const { scripts } = await packageJson();
  assert.equal(scripts['test:types'], 'node tests/types/check.mjs');
  assert.equal(
    scripts['test:e2e:chromium'],
    'playwright test --project=chromium',
  );
  assert.equal(
    scripts['test:e2e:smoke'],
    'playwright test tests/e2e/smoke.spec.js tests/e2e/shadow-smoke.spec.js --project=firefox --project=webkit',
  );
  assert.equal(
    scripts['test:adapters'],
    'node tests/framework/run-endpoints.mjs all',
  );
  assert.equal(scripts['check:dist'], 'node scripts/check-dist.mjs');
  assert.equal(
    scripts.verify,
    'npm run test:unit && npm run test:types && npm run build && npm run check:dist && npm run test:e2e:chromium && npm run test:e2e:smoke && npm run test:adapters',
  );
});
