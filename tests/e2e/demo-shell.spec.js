import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const directionContract = `<!--
THESIS: Hanamaru makes reliable DOM annotation visible as a living proof sheet.
OWN-WORLD: Living Redline — mineral paper, vermilion correction ink, indigo code tray.
STORY: See the mechanism → stress reflow → inspect every mark → operate the playground.
FIRST VIEWPORT: A real annotated proof and synchronized source, followed by one primary stamp.
FORM: Full-width editorial sheet; never browser chrome, floating cards, glass, or a SaaS grid.
-->`;

const localStarter = `<link rel="stylesheet" href="./dist/hanamaru.css">
<script type="module">
  import { scan } from './dist/hanamaru.esm.js'
  scan()
</script>`;

function channelToLinear(channel) {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(cssColor) {
  const channels = cssColor.match(/[\d.]+/g).slice(0, 3).map(Number).map(channelToLinear);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const [bright, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
}

test('serves one contracted demo document at the root and demo routes', async ({ request }) => {
  for (const route of ['/', '/demo/', '/demo/index.html']) {
    const response = await request.get(route);
    expect(response.status(), `${route} should serve the Living Redline demo`).toBe(200);
    expect(await response.text()).toContain('<title>Hanamaru');
  }

  const source = await (await request.get('/demo/index.html')).text();
  expect(source.startsWith(`${directionContract}\n<!doctype html>`)).toBe(true);
});

test('exposes the proof as an ordered, linked semantic document', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('body > header, body > main, body > footer')).toHaveCount(3);
  expect(await page.locator('body > header, body > main, body > footer')
    .evaluateAll((nodes) => nodes.map(({ tagName }) => tagName))).toEqual(['HEADER', 'MAIN', 'FOOTER']);

  const skipLink = page.getByRole('link', { name: 'Skip to proof' });
  await expect(skipLink).toHaveAttribute('href', '#main-content');
  await expect(page.locator('main#main-content')).toHaveCount(1);

  for (const id of ['quick-start', 'api', 'playground', 'limitations']) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
    await expect(page.locator(`a[href="#${id}"]`).first()).toBeVisible();
  }

  const ids = await page.locator('[id]').evaluateAll((nodes) => nodes.map(({ id }) => id));
  expect(new Set(ids).size).toBe(ids.length);
});

test('uses honest working actions and reports copy state', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value) {
          window.__hanamaruCopied = value;
          return Promise.resolve();
        },
      },
    });
  });
  await page.goto('/');

  const primary = page.getByRole('link', { name: 'Open Live Playground' });
  await expect(primary).toHaveAttribute('href', '#playground');
  await primary.click();
  await expect(page).toHaveURL(/#playground$/);

  const copy = page.getByRole('button', { name: 'Copy local starter' });
  await expect(copy).toHaveAttribute('type', 'button');
  const disclaimer = copy.locator('+ p');
  await expect(disclaimer).toContainText('Registry publication is not part of this local build');

  await copy.click();
  expect(await page.evaluate(() => window.__hanamaruCopied)).toBe(localStarter);
  await expect(page.getByRole('status')).toHaveText('Local starter copied.');
  await expect(page.getByRole('status')).toHaveAttribute('aria-live', 'polite');

  const controls = page.locator('a, button');
  await expect(controls).not.toHaveCount(0);
  for (const control of await controls.all()) {
    const tag = await control.evaluate((node) => node.tagName);
    if (tag === 'A') await expect(control).not.toHaveAttribute('href', /^#?$/);
    if (tag === 'BUTTON') await expect(control).toHaveAttribute('type', 'button');
    await expect(control).toHaveAccessibleName(/\S/);
  }
});

test('loads the runtime only from public distribution files', async ({ page, request }) => {
  await page.goto('/');

  await expect(page.locator('link[rel="stylesheet"][href="/dist/hanamaru.css"]')).toHaveCount(1);
  await expect(page.locator('link[rel="stylesheet"][href="/demo/demo.css"]')).toHaveCount(1);
  await expect(page.locator('script[type="module"][src="/demo/demo.js"]')).toHaveCount(1);
  await expect(page.locator('[src*="/src/"], [href*="/src/"], [src*="internal"], [href*="internal"]')).toHaveCount(0);

  const source = await (await request.get('/demo/demo.js')).text();
  const imports = [...source.matchAll(/^import\s+.+?from\s+['"]([^'"]+)['"];?$/gm)]
    .map((match) => match[1]);
  expect(imports).toEqual(['/dist/hanamaru.esm.js']);
  expect(source).not.toMatch(/(?:^|\/)src\//);
  expect(source).not.toContain('internal');
});

test('keeps the narrow page contained while code remains locally scrollable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const containment = await page.evaluate(() => ({
    pageWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    codeOverflow: getComputedStyle(document.querySelector('[data-demo-code-region]')).overflowX,
  }));
  expect(containment.pageWidth).toBeLessThanOrEqual(containment.viewportWidth);
  expect(containment.codeOverflow).toBe('auto');
});

test('exposes valid named proof, source, and action semantics with no serious axe findings', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('figure', { name: 'Annotation proof specimen' })).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Source proof' })).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Try Hanamaru locally' })).toHaveCount(1);

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical'))
    .toEqual([]);
});

test('keeps the primary correction stamp inside the 1440 by 900 first viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const primary = page.getByRole('link', { name: 'Open Live Playground' });
  await expect(primary).toBeVisible();
  const box = await primary.boundingBox();
  expect(box).not.toBeNull();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(900);
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`renders readable correction stamps with no action contrast violations on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');

    const primary = page.getByRole('link', { name: 'Open Live Playground' });
    const styles = await primary.evaluate((node) => {
      const computed = getComputedStyle(node);
      return {
        background: computed.backgroundColor,
        color: computed.color,
        fontWeight: Number(computed.fontWeight),
      };
    });
    expect(styles.background).toBe('rgb(201, 47, 42)');
    expect(styles.color).toBe('rgb(255, 254, 249)');
    expect(styles.fontWeight).toBeGreaterThanOrEqual(800);
    expect(contrastRatio(styles.color, styles.background)).toBeGreaterThanOrEqual(4.5);

    const results = await new AxeBuilder({ page })
      .include('.demo-actions')
      .withRules(['color-contrast'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
