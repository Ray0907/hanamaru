import { expect, test } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import playwrightConfig from '../../playwright.config.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const publicExports = [
  'HanamaruConfigError',
  'HanamaruError',
  'HanamaruStateError',
  'HanamaruTargetError',
  'VERSION',
  'annotate',
  'scan',
  'story',
];
const esmBootstrap = `<link rel="stylesheet" href="./dist/hanamaru.css">
<script type="module">
  import { scan } from './dist/hanamaru.esm.js'
  scan()
</script>`;
const iifeBootstrap = `<link rel="stylesheet" href="./dist/hanamaru.css">
<script src="./dist/hanamaru.iife.js"></script>
<script>Hanamaru.scan()</script>`;

let readme = '';
let pkg;
let sizeReport;
let demoSource;
let designSpec;

function section(title) {
  const match = readme.match(new RegExp(`^## ${title}\\s*$([\\s\\S]*?)(?=^## |\\Z)`, 'm'));
  return match?.[1] ?? '';
}

function matches(pattern, filename) {
  return pattern instanceof RegExp ? pattern.test(filename) : new RegExp(pattern).test(filename);
}

test.beforeAll(async () => {
  readme = await readFile(path.join(root, 'README.md'), 'utf8').catch(() => '');
  pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  sizeReport = JSON.parse(await readFile(path.join(root, 'dist/size-report.json'), 'utf8'));
  demoSource = await readFile(path.join(root, 'demo/demo.js'), 'utf8');
  designSpec = await readFile(
    path.join(root, 'docs/superpowers/specs/2026-07-22-hanamaru-runtime-design.md'),
    'utf8',
  );
});

test('offers stable adoption anchors without a pre-acceptance screenshot', () => {
  expect(readme).toMatch(/^# Hanamaru\s*$/m);
  for (const title of [
    'Quick Start',
    'API',
    'Accessibility',
    'Browser Support',
    'Fallbacks',
    'Limitations',
  ]) {
    expect(readme).toMatch(new RegExp(`^## ${title}\\s*$`, 'm'));
    expect(readme).toContain(`(#${title.toLowerCase().replaceAll(' ', '-')})`);
  }
  expect(readme).not.toMatch(/!\[[^\]]*\]\([^)]+\)/);
  expect(readme).not.toMatch(/https?:\/\//);
});

test('copies the exact explicit local ESM and IIFE bootstraps', () => {
  expect(designSpec).toContain(esmBootstrap);
  expect(designSpec).toContain(iifeBootstrap);
  expect(demoSource).toContain(esmBootstrap);
  expect(readme).toContain(esmBootstrap);
  expect(readme).toContain(iifeBootstrap);
  expect(section('Quick Start')).toMatch(/Neither (?:local )?build auto-scans/i);
  expect(section('Quick Start')).toMatch(/registry publication is not part of this local (?:build|implementation)/i);
  expect(section('Quick Start')).not.toMatch(/npm (?:i|install)\s+hanamaru-annotations/i);
});

test('documents exactly the public names exported by the built ESM', async ({ page }) => {
  await page.goto('/');
  const actual = await page.evaluate(async () => (
    Object.keys(await import('/dist/hanamaru.esm.js')).sort()
  ));
  const importBlock = readme.match(
    /### Public exports \(exactly eight\)[\s\S]*?```js\s*import\s*\{([\s\S]*?)\}\s*from '\.\/dist\/hanamaru\.esm\.js'\s*```/,
  );
  const documented = (importBlock?.[1] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();

  expect(actual).toEqual(publicExports);
  expect(documented).toEqual(actual);
});

test('covers both API layers, targets, options, lifecycle, events, and scan errors', () => {
  const api = section('API');
  for (const attribute of [
    'data-hana',
    'data-hana-note',
    'data-hana-placement',
    'data-hana-trigger',
    'data-hana-accessible',
    'data-hana-seed',
    'data-hana-duration',
    'data-hana-motion',
  ]) expect(api).toContain(`\`${attribute}\``);
  for (const option of [
    'mark', 'note', 'placement', 'trigger', 'accessible', 'seed', 'duration', 'motion',
  ]) expect(api).toContain(`\`${option}\``);
  for (const target of ['Element', 'CSS selector', 'native `Range`', 'scoped exact-text locator']) {
    expect(api).toContain(target);
  }
  expect(api).toContain('update({ target: nextRange })');
  expect(api).toMatch(/atomic(?:ally)?/i);
  expect(api).toMatch(/CSS-only (?:animation|movement|transform)[\s\S]*?refresh\(\)/i);
  for (const method of ['show()', 'hide()', 'update()', 'replay()', 'refresh()', 'destroy()']) {
    expect(api).toContain(method);
  }
  for (const state of ['idle', 'showing', 'visible', 'hidden', 'suspended', 'destroyed']) {
    expect(api).toContain(`\`${state}\``);
  }
  expect(api).toMatch(/finished[\s\S]*?Promise/);
  expect(api).toContain('AbortError');
  for (const event of [
    'hana:start', 'hana:step', 'hana:pause', 'hana:complete', 'hana:cancel', 'hana:error',
  ]) expect(api).toContain(`\`${event}\``);
  expect(api).toMatch(/scan\(root = document\)[\s\S]*?annotations[\s\S]*?errors/);
  expect(api).toMatch(/invalid declarative[\s\S]*?skip/i);
});

test('documents Story control, trigger, and motion contracts', () => {
  const api = section('API');
  expect(api).toContain('story(steps, options)');
  for (const option of ['trigger', 'gap', 'once', 'motion']) {
    expect(api).toContain(`\`${option}\``);
  }
  for (const method of ['play()', 'pause()', 'resume()', 'cancel()', 'replay()', 'destroy()']) {
    expect(api).toContain(method);
  }
  for (const state of ['idle', 'playing', 'paused', 'complete', 'cancelled', 'destroyed']) {
    expect(api).toContain(`\`${state}\``);
  }
  for (const trigger of ['manual', 'load', 'viewport']) {
    expect(api).toContain(`\`${trigger}\``);
  }
  expect(api).toMatch(/threshold `0\.25`/);
  expect(api).toMatch(/prefers-reduced-motion/);
  expect(api).toMatch(/same logical order/);
});

test('states the theming, accessibility, fallback, and viewport behavior honestly', () => {
  const accessibility = section('Accessibility');
  expect(accessibility).toContain('aria-hidden="true"');
  expect(accessibility).toContain('aria-describedby');
  expect(accessibility).toMatch(/meaningful note/i);
  expect(accessibility).toMatch(/overflowing accessible notes[\s\S]*?focus/i);
  expect(accessibility).toMatch(/prefers-reduced-motion/);
  expect(accessibility).toMatch(/visual viewport/i);
  expect(accessibility).toMatch(/offscreen[\s\S]*?(?:suppressed|hidden)/i);

  for (const variable of [
    '--hana-color',
    '--hana-mark-color',
    '--hana-note-color',
    '--hana-stroke-width',
    '--hana-padding',
    '--hana-note-gap',
    '--hana-font',
    '--hana-duration',
    '--hana-z-index',
  ]) expect(readme).toContain(`\`${variable}\``);

  const fallbacks = section('Fallbacks');
  expect(fallbacks).toMatch(/No `ResizeObserver`:[\s\S]*?window resize[\s\S]*?refresh\(\)/);
  expect(fallbacks).toMatch(/No `IntersectionObserver`:[\s\S]*?viewport[\s\S]*?load/);
  expect(fallbacks).toMatch(/No Web Animations API:[\s\S]*?CSS animation[\s\S]*?elapsed-time/);
  expect(fallbacks).toMatch(/CSS Highlight API[\s\S]*?irrelevant[\s\S]*?SVG/);
  expect(fallbacks).toMatch(/clipboard[\s\S]*?selectable fallback/i);
});

test('limits support claims to exercised projects and reports current distribution evidence', () => {
  const browserSupport = section('Browser Support');
  const mentioned = [...browserSupport.matchAll(/\b(Chromium|Firefox|WebKit|Chrome|Safari|Edge)\b/g)]
    .map((match) => match[1].toLowerCase());
  expect([...new Set(mentioned)]).toEqual(playwrightConfig.projects.map(({ name }) => name));
  expect(browserSupport).toContain('ES2020');

  const size = section('Size and Distribution');
  expect(size).toMatch(/zero production dependencies/i);
  expect(size).toMatch(/gzip level 9/i);
  expect(size).toMatch(/JavaScript \+ CSS/i);
  expect(size).toContain(sizeReport.budgets.hardCombinedGzip.toLocaleString('en-US'));
  expect(size).toContain(sizeReport.budgets.stretchCombinedGzip.toLocaleString('en-US'));
  for (const format of sizeReport.formats) {
    expect(size).toContain(`\`${format.file}\``);
    expect(size).toContain(format.combined.toLocaleString('en-US'));
  }
  expect(size).toMatch(/hard (?:budget|cap)[\s\S]*?pass/i);
  expect(size).toMatch(/stretch[\s\S]*?miss/i);
});

test('keeps local positioning, V1 exclusions, and the fixed verification sequence explicit', async () => {
  expect(readme).toMatch(/package name is `hanamaru-annotations`/i);
  expect(readme).toMatch(/registry publication is not part of this local (?:build|implementation)/i);
  expect(readme).not.toMatch(/(?:available|published|install it) (?:on|from) npm/i);
  expect(readme).not.toMatch(/npm (?:i|install)\s+hanamaru-annotations/i);
  expect(readme).not.toMatch(/downloads|stars|users|customers/i);

  const limits = section('Limitations');
  for (const exclusion of [
    'browser extensions',
    'arbitrary-site persistence',
    'accounts',
    'cloud storage',
    'collaboration',
    'shared review links',
    'framework wrappers',
    'AI generation',
    'QA rules',
    'lint engines',
    'image',
    'canvas',
    'freehand annotation',
    'drag-and-drop',
    'Shadow DOM',
    'cross-iframe',
    'package publication',
    'production deployment',
  ]) expect(limits.toLowerCase()).toContain(exclusion.toLowerCase());

  expect(pkg.scripts.verify).toBe(
    'npm run test:unit && npm run build && npm run check:dist && npm run test:e2e',
  );
  for (const stage of ['test:unit', 'build', 'check:dist', 'test:e2e']) {
    expect(pkg.scripts[stage]).toMatch(/\S/);
  }
  expect(readme).toContain('`npm run verify`');
  expect(readme).toMatch(/unit[\s\S]*?build[\s\S]*?check:dist[\s\S]*?Chromium[\s\S]*?Firefox[\s\S]*?WebKit/i);

  const unitFiles = (await readdir(path.join(root, 'tests/unit')))
    .filter((name) => name.endsWith('.test.js'));
  const e2eFiles = (await readdir(path.join(root, 'tests/e2e')))
    .filter((name) => name.endsWith('.spec.js'));
  expect(unitFiles.length).toBeGreaterThan(0);
  expect(e2eFiles.length).toBeGreaterThan(0);

  const projects = Object.fromEntries(
    playwrightConfig.projects.map((project) => [project.name, project]),
  );
  expect(matches(projects.chromium.testMatch, 'docs.spec.js')).toBe(true);
  expect(matches(projects.chromium.testMatch, 'annotation.spec.js')).toBe(true);
  expect(matches(projects.chromium.testMatch, 'smoke.spec.js')).toBe(true);
  expect(matches(projects.firefox.testMatch, 'docs.spec.js')).toBe(false);
  expect(matches(projects.firefox.testMatch, 'smoke.spec.js')).toBe(true);
  expect(matches(projects.webkit.testMatch, 'docs.spec.js')).toBe(false);
  expect(matches(projects.webkit.testMatch, 'smoke.spec.js')).toBe(true);

  expect(readme).toContain('[MIT](LICENSE)');
});
