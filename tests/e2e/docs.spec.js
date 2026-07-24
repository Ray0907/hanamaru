import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const mainExports = [
  'HanamaruConfigError',
  'HanamaruError',
  'HanamaruStateError',
  'HanamaruTargetError',
  'VERSION',
  'annotate',
  'scan',
  'story',
];
const optionalExports = new Map([
  ['selection', ['annotateSelection']],
  ['group', ['group']],
  ['plugins', ['registerMark']],
  ['serialize', ['serialize', 'restore', 'resolveSerializedTarget']],
  ['shadow', ['createShadowScope']],
  ['react', ['useAnnotation']],
  ['vue', ['useAnnotation']],
  ['svelte', ['annotation']],
]);
const browserBuilds = [
  ['Chromium', '149.0.7827.55'],
  ['Firefox', '151.0'],
  ['WebKit', '26.5'],
];

let readme = '';
let changelog = '';
let releaseNotes = '';
let design = '';
let product = '';
let pkg;
let sizeReport;

async function readText(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8').catch(() => '');
}

function section(document, title) {
  const match = document.match(
    new RegExp(`^## ${title}\\s*$([\\s\\S]*?)(?=^## |\\Z)`, 'm'),
  );
  return match?.[1] ?? '';
}

function formattedBytes(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

test.beforeAll(async () => {
  [
    readme,
    changelog,
    releaseNotes,
    design,
    product,
  ] = await Promise.all([
    readText('README.md'),
    readText('CHANGELOG.md'),
    readText('docs/releases/v0.1.0.md'),
    readText('DESIGN.md'),
    readText('PRODUCT.md'),
  ]);
  pkg = JSON.parse(await readText('package.json'));
  sizeReport = JSON.parse(await readText('dist/size-report.json'));
});

test('keeps every public documentation artifact and contract group non-empty', () => {
  const artifacts = { readme, changelog, releaseNotes, design, product };
  const contractGroups = [
    mainExports,
    [...optionalExports.keys()],
    sizeReport.entries,
    browserBuilds,
  ];
  expect(Object.keys(artifacts)).not.toHaveLength(0);
  for (const [name, contents] of Object.entries(artifacts)) {
    expect(contents, `${name} must exist and be non-empty`).not.toHaveLength(0);
  }
  for (const group of contractGroups) expect(group.length).toBeGreaterThan(0);
});

test('leads with the Inspector hero and five-second package adoption', async () => {
  expect(readme).toMatch(
    /^# Hanamaru\n\n!\[Hanamaru Annotation Inspector\]\(docs\/assets\/hanamaru-inspector\.png\)/,
  );
  const quickStartEnd = readme.indexOf('\n## Core API');
  expect(quickStartEnd).toBeGreaterThan(0);
  const aboveFold = readme.slice(0, quickStartEnd);
  expect(aboveFold).toContain('npm install hanamaru-annotations@0.1.0');
  expect(aboveFold).toContain("import 'hanamaru-annotations/style.css'");
  expect(aboveFold).toContain("import { annotate } from 'hanamaru-annotations'");
  expect(aboveFold).toMatch(/zero production dependencies/i);

  const hero = await readFile(
    path.join(root, 'docs/assets/hanamaru-inspector.png'),
  ).catch(() => Buffer.alloc(0));
  expect([...hero.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(hero.readUInt32BE(16)).toBe(1280);
  expect(hero.readUInt32BE(20)).toBe(900);
  expect(hero.length).toBeGreaterThan(100_000);
  expect(readme).not.toContain('docs/assets/hanamaru-demo.png');
});

test('documents the exact package ESM and version-pinned CDN paths', () => {
  const cdnCss = 'https://cdn.jsdelivr.net/npm/hanamaru-annotations@0.1.0/dist/hanamaru.css';
  const cdnEsm = 'https://cdn.jsdelivr.net/npm/hanamaru-annotations@0.1.0/dist/hanamaru.esm.js';
  expect(readme).toContain(cdnCss);
  expect(readme).toContain(cdnEsm);
  expect(readme).toMatch(/CDN[\s\S]*?type="module"/i);
  expect(readme).toMatch(/CDN[\s\S]*?Content-Security-Policy|CSP[\s\S]*?cdn\.jsdelivr\.net/i);
  expect(readme).not.toMatch(/hanamaru(?:\.umd|\.min)\.js/i);
});

test('documents exactly the eight main exports from the built package', async ({ page }) => {
  await page.goto('/');
  const actual = await page.evaluate(async () => (
    Object.keys(await import('/dist/hanamaru.esm.js')).sort()
  ));
  expect(actual).toEqual(mainExports);

  const core = section(readme, 'Core API');
  const block = core.match(
    /```js\s*import\s*\{([\s\S]*?)\}\s*from 'hanamaru-annotations'\s*```/,
  );
  const documented = (block?.[1] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
  expect(documented).toEqual(actual);
});

test('covers declarative attributes, targets, options, controllers, stories, and failures', () => {
  for (const attribute of [
    'data-hana',
    'data-hana-note',
    'data-hana-placement',
    'data-hana-trigger',
    'data-hana-accessible',
    'data-hana-seed',
    'data-hana-duration',
    'data-hana-motion',
  ]) expect(readme).toContain(`\`${attribute}\``);
  for (const target of ['Element', 'selector', 'Range', 'exact-text locator']) {
    expect(readme).toMatch(new RegExp(target, 'i'));
  }
  for (const mark of ['underline', 'highlight', 'circle', 'box', 'strike', 'bracket']) {
    expect(readme).toContain(`\`${mark}\``);
  }
  for (const option of ['note', 'placement', 'trigger', 'accessible', 'seed', 'duration', 'motion']) {
    expect(readme).toContain(`\`${option}\``);
  }
  for (const method of ['show()', 'hide()', 'update()', 'replay()', 'refresh()', 'destroy()']) {
    expect(readme).toContain(method);
  }
  for (const method of ['play()', 'pause()', 'resume()', 'cancel()']) {
    expect(readme).toContain(method);
  }
  for (const trigger of ['manual', 'load', 'viewport']) {
    expect(readme).toContain(`\`${trigger}\``);
  }
  expect(readme).toContain('threshold `0.25`');
  expect(readme).toMatch(/`finished`[\s\S]*?Promise/);
  expect(readme).toContain('AbortError');
  for (const errorName of [
    'HanamaruError',
    'HanamaruConfigError',
    'HanamaruTargetError',
    'HanamaruStateError',
  ]) expect(readme).toContain(`\`${errorName}\``);
  expect(readme).toMatch(/no silent fallback/i);
});

test('documents every optional subpath and its exact public names', () => {
  const optional = section(readme, 'Optional modules');
  for (const [subpath, exports] of optionalExports) {
    expect(optional).toContain(`hanamaru-annotations/${subpath}`);
    for (const name of exports) expect(optional).toContain(`\`${name}\``);
  }
  expect(optional).toMatch(/thin[\s\S]*?no duplicate runtime/i);
  for (const range of ['>=18.2.0 <20', '>=3.5.0 <4', '>=5.0.0 <6']) {
    expect(optional).toContain(`\`${range}\``);
  }
});

test('includes grounded Selection, Group, plugin, and serialization recipes', () => {
  const optional = section(readme, 'Optional modules');
  expect(optional).toMatch(/annotateSelection\(\{[\s\S]*?mark: 'circle'/);
  expect(optional).toMatch(/const corrections = group\(\[[\s\S]*?corrections\.show\(\)/);
  expect(optional).toMatch(
    /registerMark\('hanamaru',[\s\S]*?helpers\.closedPath\(/,
  );
  expect(optional).toMatch(/const unregister = registerMark[\s\S]*?unregister\(\)/);
  for (const name of ['serialize', 'restore', 'resolveSerializedTarget']) {
    expect(optional).toContain(name);
  }
  expect(optional).toContain('"schema": "hanamaru/v1"');
  expect(optional).toMatch(/keyForTarget[\s\S]*?resolveTarget/);
  expect(optional).toMatch(/does not generate CSS (?:paths|selectors)/i);
});

test('documents exact Shadow modes, scope boundaries, and framework lifecycles', () => {
  const optional = section(readme, 'Optional modules');
  expect(optional).toContain("import 'hanamaru-annotations/shadow/style.css'");
  expect(optional).toContain('createShadowScope');
  for (const mode of ['auto', 'sheet', 'preinstalled']) {
    expect(optional).toContain(`'${mode}'`);
  }
  expect(optional).toMatch(/nonce/);
  expect(optional).toMatch(/retained closed/i);
  expect(optional).toMatch(/does not (?:discover|traverse)[\s\S]*?(?:nested|deep|cross-root)/i);

  expect(optional).toMatch(/React[\s\S]*?useAnnotation/);
  expect(optional).toMatch(/Vue 3\.5[\s\S]*?useAnnotation/);
  expect(optional).toMatch(/Svelte 5[\s\S]*?use:annotation/);
  expect(optional).toMatch(/manual annotation/i);
  expect(optional).toMatch(/unmount[\s\S]*?destroy/i);
});

test('states accessibility, Inspector keyboard, reduced-motion, and CSP behavior exactly', () => {
  const safety = section(readme, 'Accessibility and security');
  expect(safety).toContain('aria-hidden="true"');
  expect(safety).toMatch(/notes are decorative by default/i);
  expect(safety).toContain('accessible: true');
  expect(safety).toContain('aria-describedby');
  expect(safety).toMatch(/owns[\s\S]*?token/i);
  expect(safety).toContain('prefers-reduced-motion');
  expect(safety).toMatch(/same (?:states|lifecycle|logical order)/i);
  expect(safety).toMatch(/roving tab stop/i);
  expect(safety).toMatch(/Arrow[\s\S]*?(?:Enter|Space)[\s\S]*?Escape/);
  expect(safety).toMatch(/strict CSP/i);
  expect(safety).toMatch(/nonce/);
  expect(safety).toMatch(/preinstalled/);
  expect(safety).not.toMatch(/injects? inline script/i);
  expect(safety).toMatch(/custom mark factories are trusted executable JavaScript/i);
  expect(safety).toMatch(/validates and bounds only[\s\S]*?returned SVG path data/i);
  expect(safety).toMatch(/does not sandbox/i);
  expect(safety).not.toMatch(
    /plugins?[\s\S]{0,120}cannot create (?:DOM|CSS|scripts?|timers?|observers?|events?)/i,
  );
});

test('names only the exact browser builds verified by this repository', () => {
  const support = section(readme, 'Browser support');
  expect(support).toContain('Playwright 1.61.1');
  for (const [engine, version] of browserBuilds) {
    expect(support).toContain(engine);
    expect(support).toContain(version);
  }
  expect(support).toContain('ES2020');
  expect(support).toMatch(/not minimum-version claims/i);
  expect(support).not.toMatch(/\bevergreen\b/i);
});

test('reports every schema-v2 closure measurement and hard cap', () => {
  expect(sizeReport.schemaVersion).toBe(2);
  const size = section(readme, 'Size and distribution');
  expect(size).toMatch(/closure accounting/i);
  expect(size).toMatch(/gzip level 9/i);
  expect(size).toMatch(/zero production dependencies/i);
  expect(size).not.toMatch(/\b5\s*KB\b|\b20\s*KB\b/i);
  expect(sizeReport.entries.length).toBe(Object.keys(sizeReport.budgets.hard).length);

  for (const entry of sizeReport.entries) {
    expect(size).toContain(`\`${entry.entry}\``);
    expect(size).toContain(formattedBytes(entry.gzipBytes));
    expect(size).toContain(formattedBytes(entry.budgetBytes));
    expect(releaseNotes).toContain(`\`${entry.entry}\``);
    expect(releaseNotes).toContain(formattedBytes(entry.gzipBytes));
    expect(releaseNotes).toContain(formattedBytes(entry.budgetBytes));
  }
  expect(size).toMatch(/main[\s\S]*?stretch[\s\S]*?miss/i);
  expect(size).toMatch(/iife[\s\S]*?stretch[\s\S]*?miss/i);
});

test('documents target, serialization, Shadow, and cross-frame limits without overclaiming', () => {
  const limits = section(readme, 'Limits and failure behavior');
  expect(limits).toMatch(/selector[\s\S]*?Element[\s\S]*?Range[\s\S]*?exact-text locator/i);
  expect(limits).toMatch(/no implicit[\s\S]*?(?:deep|cross-root)[\s\S]*?Shadow/i);
  expect(limits).toMatch(/open[\s\S]*?retained closed/i);
  expect(limits).toMatch(/resolver[\s\S]*?(?:Element|Range)/i);
  expect(limits).toMatch(/cross-iframe/i);
  expect(limits).toMatch(/CSS-only[\s\S]*?refresh\(\)/i);
  expect(limits).not.toMatch(/CSS Anchor Positioning/i);
});

test('prepares the changelog and release notes with exact links and sections', () => {
  expect(changelog).toContain('## [0.1.0] - 2026-07-24');
  for (const feature of [
    'six built-in marks',
    'Selection',
    'Group',
    'custom marks',
    'serialization',
    'Shadow DOM',
    'React',
    'Vue',
    'Svelte',
    'Annotation Inspector',
    'zero production dependencies',
    'least-privilege',
  ]) expect(changelog).toMatch(new RegExp(feature, 'i'));

  for (const title of ['Install', 'Features', 'Size', 'Verification']) {
    expect(releaseNotes).toMatch(new RegExp(`^## ${title}\\s*$`, 'm'));
  }
  expect(releaseNotes).toContain('npm install hanamaru-annotations@0.1.0');
  expect(releaseNotes).toContain(
    '[Changelog](https://github.com/Ray0907/hanamaru/blob/v0.1.0/CHANGELOG.md)',
  );
  expect(releaseNotes).toContain(
    '[MIT License](https://github.com/Ray0907/hanamaru/blob/v0.1.0/LICENSE)',
  );
  expect(releaseNotes).not.toMatch(/\]\(\.\.\/\.\.\//);
  expect(releaseNotes).not.toMatch(/sha(?:384|512)[-:][A-Za-z0-9+/=]{20,}/i);

  expect(readme).toContain('[Repository](https://github.com/Ray0907/hanamaru)');
  expect(readme).toContain('[local demo source](demo/index.html)');
  expect(readme).toContain('[Changelog](CHANGELOG.md)');
  expect(readme).toContain('[MIT License](LICENSE)');
  expect(readme).not.toMatch(/github\.io\/hanamaru/i);
});

test('separates the browser package consumer contract from contributor tooling', () => {
  const development = section(readme, 'Development');
  expect(Object.hasOwn(pkg, 'engines')).toBe(false);
  expect(pkg.devEngines).toEqual({
    runtime: {
      name: 'node',
      version: '>=24.13.0 <25',
      onFail: 'error',
    },
  });
  expect(development).toMatch(/browser package[\s\S]*?no consumer-facing `engines` gate/i);
  expect(development).toMatch(/contributors?[\s\S]*?`devEngines`[\s\S]*?Node `>=24\.13\.0 <25`/i);
  expect(development).toMatch(/CI[\s\S]*?24\.13\.0/i);
  expect(development).not.toMatch(/Hanamaru requires Node `24\.13\.x`/i);
});

test('records the exact real-Chrome release capture without unsupported publication claims', () => {
  expect(releaseNotes).toContain('1280×900');
  expect(releaseNotes).toContain('Portable');
  expect(releaseNotes).toContain('Hanamaru flower');
  expect(releaseNotes).toContain('Annotation applied. Output is current.');
  expect(releaseNotes).toContain('register it with hanamaru-annotations/plugins');
  expect(releaseNotes).toMatch(/no (?:debug UI|personal data)/i);
  expect(releaseNotes).toMatch(/local prepared\/verified evidence/i);
  expect(releaseNotes).not.toMatch(/(?:npm|GitHub release) is (?:live|public|published)/i);
});

test('resolves every local Markdown link used by public release documents', async () => {
  const documents = [
    ['README.md', readme],
    ['CHANGELOG.md', changelog],
    ['docs/releases/v0.1.0.md', releaseNotes],
  ];
  let checked = 0;
  for (const [filename, contents] of documents) {
    for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^(?:https?:|#)/u.test(target)) continue;
      const relative = target.split('#', 1)[0];
      const resolved = path.resolve(root, path.dirname(filename), relative);
      const file = await readFile(resolved).catch(() => Buffer.alloc(0));
      expect(file.length, `${filename} -> ${target}`).toBeGreaterThan(0);
      checked += 1;
    }
  }
  expect(checked).toBeGreaterThan(0);
});

test('updates product and design status to the implemented release', () => {
  expect(product).toMatch(/0\.1\.0[\s\S]*?(?:release|implemented)/i);
  expect(product).toMatch(/Selection[\s\S]*?Group[\s\S]*?plugins[\s\S]*?serialization/i);
  expect(product).toMatch(/Shadow DOM[\s\S]*?React[\s\S]*?Vue[\s\S]*?Svelte/i);
  expect(product).toMatch(/Annotation Inspector/i);
  expect(product).not.toMatch(/package publication is outside V1/i);
  expect(product).not.toMatch(/V1 excludes[\s\S]*?framework wrappers/i);
  expect(product).not.toMatch(/V1 excludes[\s\S]*?Shadow DOM/i);
  expect(product).not.toMatch(/20,480 bytes under gzip/i);

  expect(design).toMatch(/Annotation Inspector/i);
  expect(design).toMatch(/selected[\s\S]*?editing[\s\S]*?applied/i);
  expect(design).toMatch(/1280×900/);
  expect(design).toMatch(/390px/);
});
