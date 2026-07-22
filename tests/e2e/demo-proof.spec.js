import { expect, test } from '@playwright/test';

function capturePageFailures(page) {
  const failures = [];
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => failures.push(`page: ${error.message}`));
  return failures;
}

async function noteAndConnector(page, mark) {
  const note = page.locator('.hana-note:not(.hana-is-hidden)', {
    hasText: 'Placed again after reflow.',
  });
  await expect(note).toBeVisible();
  const id = await note.getAttribute('data-hana-id');
  const group = page.locator(`.hana-annotation[data-hana-id="${id}"]:not([hidden])`);
  await expect(group).toHaveAttribute('data-hana-mark', mark);
  await expect(group.locator('.hana-mark-path')).not.toHaveCount(0);
  await expect(group.locator('.hana-connector-path')).not.toHaveCount(0);
  return {
    connector: group.locator('.hana-connector-path').first(),
    note,
  };
}

test('reflow ruler refreshes one real annotation and keeps its note connected at both limits', async ({ page }) => {
  const failures = capturePageFailures(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const ruler = page.locator('[data-demo-reflow-control]');
  await expect(ruler).toHaveRole('slider');
  await expect(ruler).toHaveAccessibleName(/Proof width/);
  await expect(ruler).toHaveAttribute('min', '320');
  await expect(ruler).toHaveAttribute('max', '760');
  const specimen = page.locator('[data-demo-reflow-specimen]');
  await specimen.scrollIntoViewIfNeeded();

  let priorPath = null;
  for (const width of [320, 760]) {
    await ruler.fill(String(width));
    await expect(page.locator('[data-demo-reflow-value]')).toHaveText(`${width}px`);
    await expect.poll(async () => Math.round((await specimen.boundingBox()).width)).toBe(width);

    const { connector, note } = await noteAndConnector(page, 'underline');
    await expect(note).toBeVisible();
    const [noteBox, viewport, path] = await Promise.all([
      note.boundingBox(),
      page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      connector.getAttribute('d'),
    ]);
    expect(noteBox.x).toBeGreaterThanOrEqual(12);
    expect(noteBox.y).toBeGreaterThanOrEqual(12);
    expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(viewport.width - 12 + 1);
    expect(noteBox.y + noteBox.height).toBeLessThanOrEqual(viewport.height - 12 + 1);
    expect(path).toMatch(/\S/);
    if (priorPath !== null) expect(path).not.toBe(priorPath);
    priorPath = path;
  }

  const source = await (await page.request.get('/demo/demo.js')).text();
  expect(source).toContain('reflowController.refresh()');
  await expect(page.locator('[data-demo-reflow-specimen] .hana-annotation')).toHaveCount(0);
  expect(failures).toEqual([]);
});

test('six-mark ledger selects and replays only one real public annotation', async ({ page }) => {
  const failures = capturePageFailures(page);
  await page.goto('/');
  const ledger = page.locator('[data-demo-mark-ledger]');
  await ledger.scrollIntoViewIfNeeded();
  const replay = page.getByRole('button', { name: 'Replay selected mark' });
  const marks = ['underline', 'highlight', 'circle', 'box', 'strike', 'bracket'];

  for (const mark of marks) {
    const control = page.getByRole('button', { name: new RegExp(`^${mark}$`, 'i') });
    await control.click();
    await expect(control).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-demo-mark-state]')).toContainText(mark);
    const visibleGroups = page.locator('.hana-annotation:not([hidden])');
    await expect(visibleGroups).toHaveCount(1);
    const group = visibleGroups.last();
    await expect(group).toHaveAttribute('data-hana-mark', mark);
    await expect(group.locator('.hana-mark-path')).not.toHaveCount(0);
    const before = await group.locator('.hana-mark-path').first().getAttribute('d');
    await replay.click();
    await expect(group.locator('.hana-mark-path').first()).toHaveAttribute('d', before);
    await expect(page.locator('[data-demo-mark-ledger] [aria-pressed="true"]')).toHaveCount(1);
  }

  await expect(page.locator('.hana-annotation:not([hidden])')).toHaveCount(1);
  expect(failures).toEqual([]);
});

test('HTML, Story, and JSON tabs apply distinct runnable definitions to a real proof target', async ({ page }) => {
  const failures = capturePageFailures(page);
  await page.goto('/');
  const apply = page.getByRole('button', { name: 'Apply active mode' });
  const target = page.locator('[data-demo-mode-target]');
  const cases = [
    { tab: 'HTML', mark: 'highlight', method: 'scan()' },
    { tab: 'Story', mark: 'circle', method: 'story()' },
    { tab: 'JSON', mark: 'box', method: 'JSON → annotate()' },
  ];

  for (const entry of cases) {
    await page.getByRole('tab', { name: entry.tab, exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: entry.tab, exact: true }))
      .toContainText(entry.mark);
    await apply.click();
    await expect(page.locator('[data-demo-mode-state]')).toContainText(entry.method);
    await expect(page.locator('[data-demo-mode-state]')).toContainText(entry.mark);
    await expect(page.locator(`.hana-annotation[data-hana-mark="${entry.mark}"]:not([hidden])`))
      .toHaveCount(1);
    await expect(target).toHaveAttribute('data-demo-mode-applied', entry.tab.toLowerCase());
  }

  await expect(page.locator('[data-demo-mode-proof] .hana-annotation')).toHaveCount(0);
  await expect(page.locator('.hana-annotation:not([hidden])')).toHaveCount(1);
  expect(failures).toEqual([]);
});

test('reliability docket renders the deterministic local size report and explicit V1 truth', async ({ page, request }) => {
  const failures = capturePageFailures(page);
  const report = await (await request.get('/dist/size-report.json')).json();
  await page.goto('/');
  const docket = page.getByRole('region', { name: 'Reliability docket' });
  await docket.scrollIntoViewIfNeeded();

  for (const format of report.formats) {
    const name = format.file.includes('.esm.') ? 'ESM' : 'IIFE';
    await expect(docket.getByTestId(`size-${name.toLowerCase()}`))
      .toHaveText(`${format.combined.toLocaleString('en-US')} B gzip incl. CSS`);
  }
  await expect(docket.getByTestId('size-css'))
    .toHaveText(`${report.css.gzip.toLocaleString('en-US')} B gzip`);

  const copy = (await docket.innerText()).replace(/\s+/g, ' ');
  for (const claim of [
    'Zero production dependencies',
    'ES2020 ESM + IIFE',
    'CSS-variable theming',
    'manual · load · viewport',
    'ResizeObserver',
    'IntersectionObserver',
    'Web Animations API',
    'CSS Highlight API',
    'Chromium · Firefox · WebKit',
    'cross-document',
    'cross-shadow-root',
    'editable-document authoring',
    'persistence',
    'collaboration',
    'image annotation',
    'arbitrary drag positioning',
  ]) expect(copy).toContain(claim);
  expect(copy).not.toMatch(/npm install|downloads|weekly users|used by|stars/i);
  expect(failures).toEqual([]);
});

test('reliability docket reports the exact local-build fallback when metadata is unavailable', async ({ page }) => {
  const failures = capturePageFailures(page);
  await page.route('**/dist/size-report.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));
  await page.goto('/');
  await expect(page.locator('[data-demo-size-state]'))
    .toHaveText('size unavailable in this local build');
  await expect(page.getByTestId('size-esm')).toHaveText('size unavailable in this local build');
  await expect(page.getByTestId('size-iife')).toHaveText('size unavailable in this local build');
  await expect(page.getByTestId('size-css')).toHaveText('size unavailable in this local build');
  expect(failures).toEqual([]);
});

test('Task 22 controls stay contained and practical at 390px', async ({ page }) => {
  const failures = capturePageFailures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.locator('[data-demo-mark-ledger]').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }))).toEqual({ page: 390, viewport: 390 });
  for (const control of await page.locator('[data-demo-proof-sections] button, [data-demo-proof-sections] input').all()) {
    const box = await control.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(failures).toEqual([]);
});
