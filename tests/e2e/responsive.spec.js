import { expect, test } from '@playwright/test';

function contained(rect, viewport, tolerance = 1) {
  return rect !== null
    && rect.x >= -tolerance
    && rect.x + rect.width <= viewport + tolerance;
}

async function expectPageContained(page) {
  const dimensions = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
}

async function forceClipboardFailure(page) {
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('forced clipboard failure')) },
    });
  });
}

test('390px interaction states stay stacked, reachable, internally scrollable, and page-contained', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expectPageContained(page);

  const sheet = page.locator('[data-demo-proof-sheet]');
  const tray = page.locator('[data-demo-story-tray]');
  const [sheetBox, trayBox] = await Promise.all([sheet.boundingBox(), tray.boundingBox()]);
  expect(trayBox.y).toBeGreaterThanOrEqual(sheetBox.y + sheetBox.height - 1);
  expect(contained(sheetBox, 390)).toBe(true);
  expect(contained(trayBox, 390)).toBe(true);

  const codeRegion = page.locator('[role="tabpanel"]:not([hidden]) [data-demo-code-region]');
  await expect(codeRegion).toHaveAttribute('tabindex', '0');
  const codeOverflow = await codeRegion.evaluate((node) => ({
    client: node.clientWidth,
    overflow: getComputedStyle(node).overflowX,
    scroll: node.scrollWidth,
  }));
  expect(codeOverflow.scroll).toBeGreaterThan(codeOverflow.client);
  expect(codeOverflow.overflow).toBe('auto');
  await expect(tray).toHaveAccessibleName('Source proof');

  const interactive = page.locator('button, a[href], select, textarea, input:not([type="hidden"]), [tabindex="0"]');
  for (let index = 0; index < await interactive.count(); index += 1) {
    const control = interactive.nth(index);
    if (!await control.isVisible()) continue;
    const box = await control.boundingBox();
    expect(contained(box, 390, 2), `control ${index} stays within 390px`).toBe(true);
  }

  const ruler = page.getByLabel('Proof width');
  const stage = page.getByRole('region', { name: 'Responsive proof preview' });
  for (const width of ['320', '760']) {
    await ruler.fill(width);
    await expect(page.locator('[data-demo-reflow-value]')).toHaveText(`${width}px`);
    await expect(page.locator('[data-demo-reflow-specimen]')).toHaveCSS('width', `${width}px`);
    await expectPageContained(page);
    expect(contained(await stage.boundingBox(), 390)).toBe(true);
    const reflowNote = page.locator('.hana-note:not(.hana-is-hidden)', {
      hasText: 'Placed again after reflow.',
    });
    await expect(reflowNote).toBeVisible();
    expect(contained(await reflowNote.boundingBox(), 390)).toBe(true);
  }

  const markButtons = ['underline', 'highlight', 'circle', 'box', 'strike', 'bracket'];
  for (const name of markButtons) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('[data-demo-mark-state]')).toHaveText(`Selected · ${name}`);
    await expect.poll(() => page.locator(
      `.hana-annotation[data-hana-mark="${name}"]:not([hidden])`,
    ).count()).toBeGreaterThan(0);
    await expectPageContained(page);
  }

  for (const mode of ['HTML', 'Story', 'JSON']) {
    await page.getByRole('tab', { name: mode }).click();
    await page.getByRole('button', { name: 'Apply active mode' }).click();
    await expect(page.locator('[data-demo-mode-state]')).toContainText(`${mode} ·`);
    const note = page.locator('.hana-note:not(.hana-is-hidden)');
    await expect(note).toHaveCount(1);
    expect(contained(await note.boundingBox(), 390)).toBe(true);
    await expectPageContained(page);
  }

  const playground = page.locator('#playground');
  await playground.scrollIntoViewIfNeeded();
  await playground.getByLabel('Existing phrase').selectOption('#playground-target-proof');
  await playground.getByLabel('Optional note').fill('The mobile note remains inside the visible proof lane.');
  await playground.getByRole('button', { name: 'Run definition' }).click();
  await expect(playground.locator('[data-playground-state]')).toHaveText('visible');
  const playgroundNote = page.locator('.hana-note:not(.hana-is-hidden)', {
    hasText: 'The mobile note remains inside the visible proof lane.',
  });
  await expect(playgroundNote).toBeVisible();
  expect(contained(await playgroundNote.boundingBox(), 390)).toBe(true);
  await expectPageContained(page);

  await forceClipboardFailure(page);
  await playground.getByRole('button', { name: 'Copy definition' }).click();
  const fallback = playground.getByLabel('Clipboard fallback definition');
  await expect(fallback).toBeVisible();
  expect(contained(await fallback.boundingBox(), 390)).toBe(true);
  await expectPageContained(page);

  await page.locator('#limitations').scrollIntoViewIfNeeded();
  await expect(playgroundNote).toHaveCount(0);
  await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(0);
});

test('Chromium page scale 2 keeps a wrapped runtime note and essential controls inside the visual viewport', async ({ page, context }) => {
  await page.setViewportSize({ width: 600, height: 720 });
  await page.goto('/');
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
    await expect.poll(() => page.evaluate(() => visualViewport.scale)).toBe(2);

    await page.locator('#locator-proof').scrollIntoViewIfNeeded();
    await page.evaluate(async () => {
      const { annotate } = await import('/dist/hanamaru.esm.js');
      window.__zoomAnnotation = annotate({
        within: '#locator-proof',
        text: 'follow the phrase it explains',
      }, {
        mark: 'underline',
        note: 'This deliberately wrapped correction stays fully inside the visual viewport at two hundred percent page scale.',
        accessible: true,
        placement: 'right',
        motion: 'never',
        duration: 0,
      });
      window.__zoomAnnotation.show();
      await window.__zoomAnnotation.finished;
    });

    const note = page.locator('.hana-note:not(.hana-is-hidden)', {
      hasText: 'deliberately wrapped correction',
    });
    await expect(note).toBeVisible();
    const geometry = await note.evaluate((node) => {
      const noteRect = node.getBoundingClientRect();
      const target = document.querySelector('#locator-proof').getBoundingClientRect();
      const visual = visualViewport;
      return {
        note: {
          bottom: noteRect.bottom,
          left: noteRect.left,
          right: noteRect.right,
          top: noteRect.top,
          width: noteRect.width,
        },
        target: {
          bottom: target.bottom,
          left: target.left,
          right: target.right,
          top: target.top,
        },
        visual: {
          bottom: visual.offsetTop + visual.height,
          height: visual.height,
          left: visual.offsetLeft,
          right: visual.offsetLeft + visual.width,
          scale: visual.scale,
          top: visual.offsetTop,
          width: visual.width,
        },
      };
    });
    expect(geometry.visual.scale).toBe(2);
    expect(geometry.note.width).toBeLessThan(geometry.visual.width - 20);
    expect(geometry.note.left).toBeGreaterThanOrEqual(geometry.visual.left + 10);
    expect(geometry.note.right).toBeLessThanOrEqual(geometry.visual.right - 10);
    expect(geometry.note.top).toBeGreaterThanOrEqual(geometry.visual.top + 10);
    expect(geometry.note.bottom).toBeLessThanOrEqual(geometry.visual.bottom - 10);
    expect(geometry.target.right).toBeGreaterThan(geometry.visual.left);
    expect(geometry.target.left).toBeLessThan(geometry.visual.right);

    const essential = [
      page.getByRole('tab', { name: 'Story' }),
      page.getByRole('button', { name: 'Play story', exact: true }),
      page.getByRole('button', { name: 'Copy active code' }),
    ];
    for (const control of essential) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeVisible();
      await control.focus();
      await expect(control).toBeFocused();
    }
    const code = page.locator('[role="tabpanel"]:not([hidden]) [data-demo-code-region]');
    await code.focus();
    await expect(code).toBeFocused();
    expect(await code.evaluate((node) => getComputedStyle(node).overflowX)).toBe('auto');

    await page.locator('#locator-proof').scrollIntoViewIfNeeded();
    await expect(note).toBeVisible();
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 3 });
    await expect.poll(() => page.evaluate(() => visualViewport.scale)).toBe(3);
    await page.evaluate(() => window.__zoomAnnotation.refresh());
    await expect.poll(() => note.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width <= visualViewport.width - 24
        && rect.left >= visualViewport.offsetLeft + 12
        && rect.right <= visualViewport.offsetLeft + visualViewport.width - 12;
    })).toBe(true);
    const narrowWidth = await note.evaluate((node) => node.getBoundingClientRect().width);

    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await cdp.send('Emulation.resetPageScaleFactor');
    await expect.poll(() => page.evaluate(() => visualViewport.scale)).toBe(1);
    await page.evaluate(() => window.__zoomAnnotation.refresh());
    await expect.poll(() => note.evaluate(
      (node, previous) => node.getBoundingClientRect().width > previous,
      narrowWidth,
    )).toBe(true);
    const expanded = await note.evaluate((node) => ({
      inlineMaxWidth: node.style.maxWidth,
      maxWidth: getComputedStyle(node).maxWidth,
      width: node.getBoundingClientRect().width,
    }));
    expect(expanded.inlineMaxWidth).toBe('');
    expect(expanded.maxWidth).toBe('288px');
    expect(expanded.width).toBeLessThanOrEqual(288);
  } finally {
    await cdp.send('Emulation.resetPageScaleFactor');
  }
  await expect.poll(() => page.evaluate(() => visualViewport.scale)).toBe(1);
});
