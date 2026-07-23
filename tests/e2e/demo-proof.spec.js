import { expect, test } from '@playwright/test';

function capturePageFailures(page) {
  const failures = [];
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => failures.push(`page: ${error.message}`));
  return failures;
}

function overlaps(first, second, inset = 0) {
  return first.left < second.right - inset
    && first.right > second.left + inset
    && first.top < second.bottom - inset
    && first.bottom > second.top + inset;
}

async function clientRect(locator) {
  return locator.evaluate((node) => {
    const { left, right, top, bottom } = node.getBoundingClientRect();
    return { left, right, top, bottom };
  });
}

async function expectActiveElementInsideViewport(page, locator) {
  await expect(locator).toBeFocused();
  await expect.poll(() => locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight;
  })).toBe(true);
  const result = await locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      bottom: rect.bottom,
      height: innerHeight,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      top: rect.top,
    };
  });
  expect(result.top).toBeGreaterThanOrEqual(0);
  expect(result.bottom).toBeLessThanOrEqual(result.height);
  expect(result.outlineStyle).not.toBe('none');
  expect(Number.parseFloat(result.outlineWidth)).toBeGreaterThanOrEqual(3);
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

test('supporting notes leave with offscreen targets and redraw without collisions or leaks', async ({ page }) => {
  const failures = capturePageFailures(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const ruler = page.locator('[data-demo-reflow-control]');
  await ruler.scrollIntoViewIfNeeded();
  await ruler.fill('320');
  await expect(page.locator('.hana-note:not(.hana-is-hidden)', {
    hasText: 'Placed again after reflow.',
  })).toBeVisible();

  const reliability = page.getByRole('region', { name: 'Reliability docket' });
  await reliability.scrollIntoViewIfNeeded();
  await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(0);

  await page.getByRole('tab', { name: 'JSON', exact: true }).click();
  await page.getByRole('button', { name: 'Apply active mode' }).click();
  const note = page.locator('.hana-note:not(.hana-is-hidden)', {
    hasText: 'Parsed locally, rendered through annotate().',
  });
  await expect(note).toBeVisible();
  const [noteRect, headingRect, targetRect] = await Promise.all([
    clientRect(note),
    clientRect(page.locator('#mode-proof-title')),
    clientRect(page.locator('[data-demo-mode-target]')),
  ]);
  expect(overlaps(noteRect, headingRect)).toBe(false);
  expect(overlaps(noteRect, targetRect)).toBe(false);
  await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(1);

  await page.locator('#quick-start').scrollIntoViewIfNeeded();
  await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(0);
  await page.locator('[data-demo-mode-target]').scrollIntoViewIfNeeded();
  await expect(note).toBeVisible();
  await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(1);
  expect(failures).toEqual([]);
});

test('390px supporting notes stay with visible proof copy and never cover its heading', async ({ page }) => {
  const failures = capturePageFailures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('tab', { name: 'JSON', exact: true }).click();
  await page.getByRole('button', { name: 'Apply active mode' }).click();

  const note = page.locator('.hana-note:not(.hana-is-hidden)', {
    hasText: 'Parsed locally, rendered through annotate().',
  });
  await expect(note).toBeVisible();
  const [noteRect, headingRect, targetRect, stateRect] = await Promise.all([
    clientRect(note),
    clientRect(page.locator('#mode-proof-title')),
    clientRect(page.locator('[data-demo-mode-target]')),
    clientRect(page.locator('[data-demo-mode-state]')),
  ]);
  expect(overlaps(noteRect, headingRect)).toBe(false);
  expect(overlaps(noteRect, targetRect)).toBe(false);
  expect(overlaps(noteRect, stateRect)).toBe(false);

  await page.getByRole('region', { name: 'Reliability docket' }).scrollIntoViewIfNeeded();
  await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(failures).toEqual([]);
});

test('390px ruler preserves the exact 320 to 760 measure inside a contained preview', async ({ page }) => {
  const failures = capturePageFailures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const ruler = page.locator('[data-demo-reflow-control]');
  const specimen = page.locator('[data-demo-reflow-specimen]');
  const stage = page.locator('.demo-reflow-stage');
  const target = page.locator('[data-demo-reflow-target]');
  const targetLine = page.locator('[data-demo-reflow-target-line]');
  await ruler.scrollIntoViewIfNeeded();
  await expect(target).toHaveCount(1);
  await expect(targetLine).toHaveCount(1);

  for (const width of [320, 400, 540, 760]) {
    await ruler.fill(String(width));
    await expect.poll(async () => Math.round((await specimen.boundingBox()).width)).toBe(width);
    await expect(page.locator('[data-demo-reflow-value]')).toHaveText(`${width}px`);
    await expect(page.locator('.demo-reflow-specimen__register'))
      .toHaveText(`${width} / responsive copy measure`);
    await expect(page.getByRole('status')).toHaveText(`Proof remeasured at ${width}px.`);
    const containment = await stage.evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      overflowX: getComputedStyle(node).overflowX,
    }));
    expect(containment.scrollWidth).toBeGreaterThanOrEqual(width);
    expect(containment.clientWidth).toBeLessThanOrEqual(366);
    expect(containment.overflowX).toBe('auto');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await expect.poll(() => target.evaluate((node) => {
      const stageRect = node.closest('.demo-reflow-stage').getBoundingClientRect();
      return [...node.getClientRects()].some((rect) => (
        rect.left >= stageRect.left && rect.right <= stageRect.right
      ));
    })).toBe(true);
    const { connector, note } = await noteAndConnector(page, 'underline');
    const [noteRect, viewport, ...protectedRects] = await Promise.all([
      clientRect(note),
      page.evaluate(() => ({ height: innerHeight, width: innerWidth })),
      clientRect(page.locator('#reflow-title')),
      clientRect(page.locator('.demo-width-control')),
      clientRect(page.locator('.demo-reflow-specimen__register')),
      clientRect(page.locator('#reflow-copy')),
      clientRect(targetLine),
    ]);
    for (const protectedRect of protectedRects) {
      expect(overlaps(noteRect, protectedRect), `${width}px note collision`).toBe(false);
    }
    expect(noteRect.left).toBeGreaterThanOrEqual(12);
    expect(noteRect.top).toBeGreaterThanOrEqual(12);
    expect(noteRect.right).toBeLessThanOrEqual(viewport.width - 12 + 1);
    expect(noteRect.bottom).toBeLessThanOrEqual(viewport.height - 12 + 1);
    await expect(connector).toHaveAttribute('d', /\S/);
  }
  await expect(page.locator('.hana-note:not(.hana-is-hidden)', {
    hasText: 'Placed again after reflow.',
  })).toBeVisible();
  expect(failures).toEqual([]);
});

test('completed main story leaves with its proof and restores once without cross-flow leaks', async ({ page }) => {
  const failures = capturePageFailures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('[data-demo-story-state]')).toHaveText('idle');
  await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(0);

  await page.getByRole('button', { name: 'Play story', exact: true }).click();
  await expect(page.locator('[data-demo-story-state]')).toHaveText('complete', { timeout: 8_000 });
  await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(2);
  const firstRun = await page.locator('[data-demo-story-run]').textContent();

  const applyJson = async () => {
    await page.getByRole('tab', { name: 'JSON', exact: true }).click();
    await page.getByRole('button', { name: 'Apply active mode' }).click();
    await expect(page.locator('.hana-note:not(.hana-is-hidden)', {
      hasText: 'Parsed locally, rendered through annotate().',
    })).toBeVisible();
    await expect(page.locator('.hana-note:not(.hana-is-hidden)', {
      hasText: /Still attached|Measured again/,
    })).toHaveCount(0);
    await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(1);
  };

  await applyJson();
  await page.locator('#quick-start').scrollIntoViewIfNeeded();
  await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(0);

  const locatorProof = page.locator('#locator-proof');
  await locatorProof.scrollIntoViewIfNeeded();
  await expect(page.locator('[data-demo-story-state]')).toHaveText('complete', { timeout: 8_000 });
  await expect(page.locator('[data-demo-completion]')).toContainText('2 of 2 accepted · complete');
  await expect(page.getByRole('button', { name: 'Replay story' })).toBeEnabled();
  await expect(page.locator('[data-demo-story-run]')).not.toHaveText(firstRun);
  await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(2);
  await expect(page.locator('.hana-annotation:not([hidden])')).toHaveCount(2);
  const secondRun = await page.locator('[data-demo-story-run]').textContent();

  await applyJson();
  await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(1);
  await locatorProof.scrollIntoViewIfNeeded();
  await expect(page.locator('[data-demo-story-state]')).toHaveText('complete', { timeout: 8_000 });
  await expect(page.locator('[data-demo-story-run]')).not.toHaveText(secondRun);
  await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(2);
  await expect(page.locator('.hana-annotation:not([hidden])')).toHaveCount(2);
  expect(failures).toEqual([]);
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`keyboard mode apply leaves visible focus and a logical next Tab on ${viewport.name}`, async ({ page }) => {
    const failures = capturePageFailures(page);
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByRole('tab', { name: 'JSON', exact: true }).click();
    const apply = page.getByRole('button', { name: 'Apply active mode' });
    await apply.focus();
    await apply.press('Enter');
    const state = page.locator('[data-demo-mode-state]');
    await expectActiveElementInsideViewport(page, state);
    await state.press('Tab');
    await expect(page.locator('.demo-inline-code')).toBeFocused();
    expect(failures).toEqual([]);
  });
}

const validSizeReport = {
  budgets: { hardCombinedGzip: 20_480, stretchCombinedGzip: 18_432 },
  css: { file: 'hanamaru.css', gzip: 851 },
  formats: [
    {
      combined: 18_128,
      cssGzip: 851,
      file: 'hanamaru.esm.js',
      gzip: 17_277,
      raw: 54_114,
      stretch: true,
    },
    {
      combined: 18_322,
      cssGzip: 851,
      file: 'hanamaru.iife.js',
      gzip: 17_471,
      raw: 54_597,
      stretch: true,
    },
  ],
  schemaVersion: 1,
};

for (const { name, mutate } of [
  { name: 'future schema', mutate: (report) => { report.schemaVersion = 2; } },
  { name: 'negative combined bytes', mutate: (report) => { report.formats[0].combined = -1; } },
  { name: 'fractional CSS bytes', mutate: (report) => { report.css.gzip = 850.5; } },
  { name: 'malformed format metric', mutate: (report) => { report.formats[1].gzip = null; } },
]) {
  test(`size docket rejects ${name} with the exact local fallback`, async ({ page }) => {
    const failures = capturePageFailures(page);
    const report = structuredClone(validSizeReport);
    mutate(report);
    await page.route('**/dist/size-report.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(report),
    }));
    await page.goto('/');
    await expect(page.locator('[data-demo-size-state]'))
      .toHaveText('size unavailable in this local build');
    await expect(page.getByTestId('size-esm')).toHaveText('size unavailable in this local build');
    await expect(page.getByTestId('size-iife')).toHaveText('size unavailable in this local build');
    await expect(page.getByTestId('size-css')).toHaveText('size unavailable in this local build');
    expect(failures).toEqual([]);
  });
}
