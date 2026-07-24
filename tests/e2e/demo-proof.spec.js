import AxeBuilder from '@axe-core/playwright';
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

test('reliability docket renders the deterministic local size report and explicit V2 truth', async ({ page, request }) => {
  const failures = capturePageFailures(page);
  const report = await (await request.get('/dist/size-report.json')).json();
  await page.goto('/');
  const docket = page.getByRole('region', { name: 'Reliability docket' });
  await docket.scrollIntoViewIfNeeded();

  expect(report.schemaVersion).toBe(2);
  for (const name of ['main', 'iife']) {
    const entry = report.entries.find((candidate) => candidate.entry === name);
    expect(entry.budgetBytes).toBe(report.budgets.hard[name]);
    expect(entry.stretchBytes).toBe(report.budgets.stretch[name]);
    await expect(docket.getByTestId(`size-${name === 'main' ? 'esm' : 'iife'}`))
      .toHaveText(`${entry.gzipBytes.toLocaleString('en-US')} B gzip incl. CSS`);
  }
  const css = report.entries
    .find(({ entry }) => entry === 'main')
    .members.find(({ file }) => file === 'hanamaru.css');
  await expect(docket.getByTestId('size-css'))
    .toHaveText(`${css.gzipBytes.toLocaleString('en-US')} B gzip`);

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
  await expect.poll(async () => {
    const [noteRect, headingRect, targetRect] = await Promise.all([
      clientRect(note),
      clientRect(page.locator('#mode-proof-title')),
      clientRect(page.locator('[data-demo-mode-target]')),
    ]);
    return {
      heading: overlaps(noteRect, headingRect),
      target: overlaps(noteRect, targetRect),
    };
  }).toEqual({ heading: false, target: false });
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

for (const observerMode of ['native', 'fallback']) {
  test(`390px reflow note hides when horizontally clipped with ${observerMode} visibility`, async ({ page }) => {
    const failures = capturePageFailures(page);
    await page.setViewportSize({ width: 390, height: 844 });
    if (observerMode === 'fallback') {
      await page.addInitScript(() => { delete window.IntersectionObserver; });
    }
    await page.goto('/');
    const ruler = page.locator('[data-demo-reflow-control]');
    const stage = page.locator('.demo-reflow-stage');
    const target = page.locator('[data-demo-reflow-target]');
    const note = page.locator('.hana-note:not(.hana-is-hidden)', {
      hasText: 'Placed again after reflow.',
    });
    const intersectsStageAndViewport = () => target.evaluate((node) => {
      const stageRect = node.closest('.demo-reflow-stage').getBoundingClientRect();
      const left = Math.max(0, stageRect.left);
      const right = Math.min(innerWidth, stageRect.right);
      const top = Math.max(0, stageRect.top);
      const bottom = Math.min(innerHeight, stageRect.bottom);
      return [...node.getClientRects()].some((rect) => (
        rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom
      ));
    });

    await ruler.scrollIntoViewIfNeeded();
    await ruler.fill('760');
    await stage.evaluate((node) => node.scrollTo({ left: 0, behavior: 'auto' }));
    await expect.poll(intersectsStageAndViewport).toBe(true);
    await expect(note).toBeVisible();

    await stage.evaluate((node) => node.scrollTo({ left: node.scrollWidth, behavior: 'auto' }));
    await expect.poll(intersectsStageAndViewport).toBe(false);
    await expect(note).toHaveCount(0);

    await stage.evaluate((node) => node.scrollTo({ left: 0, behavior: 'auto' }));
    await expect.poll(intersectsStageAndViewport).toBe(true);
    await expect(note).toBeVisible();
    const id = await note.getAttribute('data-hana-id');
    await expect(page.locator(`.hana-annotation[data-hana-id="${id}"] .hana-connector-path`).first())
      .toHaveAttribute('d', /\S/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(failures).toEqual([]);
  });
}

test('390px horizontal proof region is named, instructed, keyboard-scrollable, and accessible', async ({ page }) => {
  const failures = capturePageFailures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const ruler = page.locator('[data-demo-reflow-control]');
  const stage = page.getByRole('region', { name: 'Responsive proof preview' });
  await ruler.scrollIntoViewIfNeeded();
  await ruler.fill('760');
  await expect(stage).toHaveAttribute('tabindex', '0');
  await expect(stage).toHaveAccessibleDescription(/scroll horizontally/i);
  await stage.focus();
  await expect(stage).toBeFocused();
  const focusStyle = await stage.evaluate((node) => {
    const style = getComputedStyle(node);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focusStyle.outlineStyle).not.toBe('none');
  expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(3);
  await stage.press('ArrowRight');
  await expect.poll(() => stage.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  const results = await new AxeBuilder({ page }).include('[data-demo-proof-sections]').analyze();
  expect(results.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical'))
    .toEqual([]);
  expect(failures).toEqual([]);
});

test('proof scroll affordance stays out of the wide desktop Tab order and follows responsive overflow', async ({ page }) => {
  const failures = capturePageFailures(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const stage = page.getByRole('region', { name: 'Responsive proof preview' });
  const instruction = page.locator('#reflow-scroll-instruction');
  await expect.poll(() => stage.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(instruction).toBeHidden();
  await expect(stage).not.toHaveAttribute('tabindex', /.+/);
  await expect(stage).not.toHaveAttribute('aria-describedby', /.+/);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => stage.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await expect(instruction).toBeVisible();
  await expect(stage).toHaveAttribute('tabindex', '0');
  await expect(stage).toHaveAttribute('aria-describedby', 'reflow-scroll-instruction');

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => stage.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(instruction).toBeHidden();
  await expect(stage).not.toHaveAttribute('tabindex', /.+/);
  await expect(stage).not.toHaveAttribute('aria-describedby', /.+/);
  expect(failures).toEqual([]);
});

test('390px proof width removes and restores its scroll affordance with actual overflow', async ({ page }) => {
  const failures = capturePageFailures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const ruler = page.locator('[data-demo-reflow-control]');
  const stage = page.getByRole('region', { name: 'Responsive proof preview' });
  const instruction = page.locator('#reflow-scroll-instruction');
  await ruler.scrollIntoViewIfNeeded();

  await ruler.fill('320');
  await expect.poll(() => stage.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(instruction).toBeHidden();
  await expect(stage).not.toHaveAttribute('tabindex', /.+/);
  await expect(stage).not.toHaveAttribute('aria-describedby', /.+/);

  await ruler.fill('760');
  await expect.poll(() => stage.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await expect(instruction).toBeVisible();
  await expect(stage).toHaveAttribute('tabindex', '0');
  await expect(stage).toHaveAccessibleDescription(/scroll horizontally/i);
  expect(failures).toEqual([]);
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  for (const priorState of ['paused', 'complete']) {
    test(`${priorState} main story preserves its run while visual output follows the viewport on ${viewport.name}`, async ({ page }) => {
      const failures = capturePageFailures(page);
      await page.setViewportSize(viewport);
      await page.goto('/');
      await page.evaluate(() => {
        window.__demoStoryStarts = 0;
        document.querySelector('#locator-proof').addEventListener('hana:start', (event) => {
          if (typeof event.detail.controller?.play === 'function') window.__demoStoryStarts += 1;
        });
      });

      const state = page.locator('[data-demo-story-state]');
      const run = page.locator('[data-demo-story-run]');
      const completionState = page.locator('[data-demo-completion]');
      const storyNotes = page.locator('.hana-note:not(.hana-is-hidden)', {
        hasText: /Still attached|Measured again/,
      });
      const visibleStoryGroups = page.locator([
        '.hana-annotation[data-hana-mark="underline"]:not([hidden])',
        '.hana-annotation[data-hana-mark="circle"]:not([hidden])',
      ].join(','));
      const replay = page.getByRole('button', { name: 'Replay story' });
      await expect(state).toHaveText('idle');
      await expect(replay).toBeDisabled();

      await page.getByRole('button', { name: 'Play story', exact: true }).click();
      if (priorState === 'paused') {
        await expect(state).toHaveText('playing');
        await page.getByRole('button', { name: 'Pause story' }).click();
        await expect(state).toHaveText('paused');
        await page.getByRole('region', { name: 'Reliability docket' }).scrollIntoViewIfNeeded();
      } else {
        await expect(state).toHaveText('complete', { timeout: 8_000 });
        await page.getByRole('tab', { name: 'JSON', exact: true }).click();
        await page.getByRole('button', { name: 'Apply active mode' }).click();
        await expect(page.locator('.hana-note:not(.hana-is-hidden)', {
          hasText: 'Parsed locally, rendered through annotate().',
        })).toBeVisible();
      }

      const runBeforeExit = await run.textContent();
      const startsBeforeExit = await page.evaluate(() => window.__demoStoryStarts);
      expect(startsBeforeExit).toBe(1);
      await expect(state).toHaveText(priorState);
      await expect(run).toHaveText(runBeforeExit);
      await expect(storyNotes).toHaveCount(0);
      await expect(visibleStoryGroups).toHaveCount(0);

      await page.locator('#locator-proof').scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      await expect(state).toHaveText(priorState);
      await expect(run).toHaveText(runBeforeExit);
      expect(await page.evaluate(() => window.__demoStoryStarts)).toBe(startsBeforeExit);
      await expect(completionState).toHaveText(
        priorState === 'complete' ? '2 of 2 accepted · complete' : '0 of 2 accepted · paused',
      );
      await expect(storyNotes).toHaveCount(priorState === 'complete' ? 2 : 1);
      const action = priorState === 'complete'
        ? replay
        : page.getByRole('button', { name: 'Resume story' });
      await action.scrollIntoViewIfNeeded();
      await expect(action).toBeVisible();
      await expect(action).toBeEnabled();

      await action.click();
      await expect(state).toHaveText('complete', { timeout: 8_000 });
      await expect(run).toHaveText(String(
        Number(runBeforeExit) + (priorState === 'complete' ? 1 : 0),
      ));
      expect(await page.evaluate(() => window.__demoStoryStarts))
        .toBe(startsBeforeExit + (priorState === 'complete' ? 1 : 0));
      await page.locator('#locator-proof').scrollIntoViewIfNeeded();
      await expect(storyNotes).toHaveCount(2);
      await expect(page.locator('.hana-annotation:not([hidden])')).toHaveCount(2);
      expect(failures).toEqual([]);
    });
  }
}

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
  budgets: {
    hard: { main: 28_672, iife: 24_576 },
    stretch: { main: 27_648, iife: 23_552 },
  },
  entries: [
    {
      entry: 'main',
      entryFile: 'hanamaru.esm.js',
      chargedFiles: ['hanamaru.esm.js', '_chunks/chunk-A.js', 'hanamaru.css'],
      members: [
        { file: 'hanamaru.esm.js', rawBytes: 1_000, gzipBytes: 400 },
        { file: '_chunks/chunk-A.js', rawBytes: 4_000, gzipBytes: 1_000 },
        { file: 'hanamaru.css', rawBytes: 2_575, gzipBytes: 881 },
      ],
      rawBytes: 7_575,
      gzipBytes: 2_281,
      budgetBytes: 28_672,
      stretchBytes: 27_648,
      stretch: true,
    },
    {
      entry: 'iife',
      entryFile: 'hanamaru.iife.js',
      chargedFiles: ['hanamaru.iife.js', 'hanamaru.css'],
      members: [
        { file: 'hanamaru.iife.js', rawBytes: 5_000, gzipBytes: 1_500 },
        { file: 'hanamaru.css', rawBytes: 2_575, gzipBytes: 881 },
      ],
      rawBytes: 7_575,
      gzipBytes: 2_381,
      budgetBytes: 24_576,
      stretchBytes: 23_552,
      stretch: true,
    },
  ],
  schemaVersion: 2,
};

for (const { name, mutate } of [
  { name: 'future schema', mutate: (report) => { report.schemaVersion = 3; } },
  { name: 'negative closure bytes', mutate: (report) => { report.entries[0].gzipBytes = -1; } },
  {
    name: 'fractional CSS bytes',
    mutate: (report) => {
      report.entries[0].members.find(({ file }) => file === 'hanamaru.css').gzipBytes = 880.5;
    },
  },
  { name: 'malformed entry metric', mutate: (report) => { report.entries[1].budgetBytes = null; } },
  { name: 'missing closure budget', mutate: (report) => { delete report.budgets.hard.main; } },
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
