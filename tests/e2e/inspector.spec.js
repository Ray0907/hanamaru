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

async function selectInspectorWord(page) {
  const word = page.locator('[data-inspector-selection-word]');
  await word.dblclick();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('Portable');
}

async function openInspector(page) {
  const inspector = page.locator('[data-inspector-root]');
  await page.getByRole('button', { name: 'Open Annotation Inspector' }).click();
  await expect(inspector).toHaveAttribute('data-inspector-state', 'idle');
  return inspector;
}

async function beginUnderlinePreview(page) {
  const inspector = await openInspector(page);
  await selectInspectorWord(page);
  await inspector.getByRole('button', { name: 'Underline', exact: true }).click();
  await expect(inspector).toHaveAttribute('data-inspector-state', 'editing');
  return inspector;
}

test('five-second path authors one real annotation and closes without disturbing the demo', async ({
  page,
}) => {
  const failures = capturePageFailures(page);
  await page.goto('/');

  const existingStory = page.locator('[data-demo-story-tray]');
  const existingStoryControls = existingStory.locator('[data-demo-story-controls]');
  const initialAnnotations = await page.locator('.hana-annotation').count();
  const open = page.getByRole('button', { name: 'Open Annotation Inspector' });
  const inspector = page.locator('[data-inspector-root]');

  await expect(inspector).toBeHidden();
  await open.click();
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveAttribute('data-inspector-state', 'idle');
  await expect(page.getByRole('button', { name: 'Exit Inspector' })).toBeFocused();

  await selectInspectorWord(page);
  await expect(inspector).toHaveAttribute('data-inspector-state', 'selected');
  await expect(page.getByRole('toolbar', { name: 'Annotation marks' })).toBeVisible();

  await page.getByRole('button', { name: 'Underline', exact: true }).click();
  await expect(inspector).toHaveAttribute('data-inspector-state', 'editing');
  await expect.poll(() => page.locator('.hana-annotation').count()).toBe(initialAnnotations + 1);
  await expect(page.locator('.hana-annotation[data-hana-mark="underline"]:not([hidden])'))
    .not.toHaveCount(0);

  await page.getByRole('button', { name: 'Apply annotation' }).click();
  await expect(inspector).toHaveAttribute('data-inspector-state', 'applied');
  await expect(page.locator('[data-inspector-output]')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'JavaScript' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('[data-inspector-output-value="javascript"]'))
    .toHaveValue(/restore/);
  await expect(page.locator('[data-inspector-output-value="json"]'))
    .toHaveValue(/"schema": "hanamaru\/v1"/);

  const selectedText = await page.evaluate(() => getSelection()?.toString());
  await page.getByRole('button', { name: 'Exit Inspector' }).click();
  await expect(inspector).toBeHidden();
  await expect(open).toBeFocused();
  await expect.poll(() => page.locator('.hana-annotation').count()).toBe(initialAnnotations);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(selectedText);
  await expect(existingStoryControls).toBeVisible();
  await expect(existingStory.getByRole('button', { name: 'Play story', exact: true })).toBeEnabled();
  expect(failures).toEqual([]);
});

test('seven semantic mark controls include and render the example flower plugin', async ({
  page,
}) => {
  const failures = capturePageFailures(page);
  await page.goto('/');
  const inspector = await openInspector(page);
  await selectInspectorWord(page);

  const marks = inspector.locator('[data-inspector-mark]');
  await expect(marks).toHaveCount(7);
  expect(await marks.evaluateAll((buttons) => buttons.map((button) => button.dataset.inspectorMark)))
    .toEqual(['underline', 'highlight', 'circle', 'box', 'strike', 'bracket', 'hanamaru']);
  const plugin = inspector.getByRole('button', {
    name: 'Hanamaru flower (example plugin)',
  });
  await expect(plugin).toBeVisible();
  await plugin.click();
  await expect(page.locator('.hana-annotation[data-hana-mark="hanamaru"]:not([hidden])'))
    .toHaveCount(1);

  const results = await new AxeBuilder({ page })
    .include('[data-inspector-root]')
    .analyze();
  expect(results.violations).toEqual([]);
  expect(failures).toEqual([]);
});

test('note editor validates 280 Unicode code points and Escape restores its opener', async ({
  page,
}) => {
  const failures = capturePageFailures(page);
  await page.goto('/');
  const inspector = await beginUnderlinePreview(page);
  const addNote = inspector.getByRole('button', { name: 'Add note' });

  await addNote.click();
  const note = inspector.getByRole('textbox', { name: 'Annotation note' });
  await expect(note).toBeVisible();
  await expect(note).toBeFocused();
  await expect(note).toHaveAttribute('data-max-code-points', '280');
  await expect(note).toHaveAttribute('maxlength', '560');
  await expect(note).toHaveAttribute(
    'aria-describedby',
    /inspector-note-help.*inspector-note-error/,
  );

  await note.fill('a'.repeat(281));
  await expect(page.locator('#inspector-note-error')).toBeVisible();
  await expect(page.locator('#inspector-note-error')).toContainText('280 Unicode code points');
  await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(0);
  await expect(inspector).toHaveAttribute('data-inspector-state', 'editing');

  await note.fill('Meaningful note');
  await expect(page.locator('#inspector-note-error')).toBeHidden();
  await expect(page.locator('.hana-note:not(.hana-is-hidden)', { hasText: 'Meaningful note' }))
    .toHaveCount(1);

  await note.press('Escape');
  await expect(page.locator('[data-inspector-note-editor]')).toBeHidden();
  await expect(inspector.locator('[data-inspector-add-note]')).toBeFocused();
  await expect(inspector).toHaveAttribute('data-inspector-state', 'editing');
  expect(failures).toEqual([]);
});

test('advanced options reject invalid input and serialize the exact public domains', async ({
  page,
}) => {
  const failures = capturePageFailures(page);
  await page.goto('/');
  const inspector = await beginUnderlinePreview(page);

  await inspector.getByText('Options', { exact: true }).click();
  const placement = inspector.getByLabel('Placement');
  const accessible = inspector.getByLabel('Meaningful note accessibility');
  const duration = inspector.getByLabel('Duration');
  const motion = inspector.getByLabel('Motion');
  const seed = inspector.getByLabel('Seed');

  await expect(placement.locator('option')).toHaveCount(5);
  expect(await placement.locator('option').evaluateAll((options) => (
    options.map((option) => option.value)
  ))).toEqual(['auto', 'top', 'right', 'bottom', 'left']);
  await expect(motion.locator('option')).toHaveCount(2);
  expect(await motion.locator('option').evaluateAll((options) => (
    options.map((option) => option.value)
  ))).toEqual(['system', 'never']);
  await expect(inspector.getByText('Trigger: manual', { exact: true })).toBeVisible();

  await duration.fill('-1');
  await expect(page.locator('#inspector-duration-error')).toBeVisible();
  await expect(inspector).toHaveAttribute('data-inspector-state', 'editing');
  await expect(page.locator('[data-inspector-output-value="javascript"]'))
    .toHaveValue(/"duration": 420/);

  await placement.selectOption('left');
  await accessible.uncheck();
  await duration.fill('0');
  await motion.selectOption('never');
  await seed.fill('option-seed');
  await expect(page.locator('#inspector-duration-error')).toBeHidden();

  await inspector.getByRole('tab', { name: 'HTML' }).click();
  await expect(inspector.getByRole('tab', { name: 'HTML' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('[data-inspector-output-value="html"]'))
    .toHaveValue(/Unavailable for this Range/);
  await expect(page.locator('[data-inspector-status]')).toContainText('HTML output selected');

  await inspector.getByRole('tab', { name: 'JavaScript' }).click();
  await expect(page.locator('[data-inspector-output-value="javascript"]'))
    .toHaveValue(/annotateSelection/);
  await expect(page.locator('[data-inspector-output-value="json"]'))
    .toHaveValue(/exact stable text locator has not been proven/);

  await inspector.getByRole('button', { name: 'Apply annotation' }).click();
  const definition = JSON.parse(
    await page.locator('[data-inspector-output-value="json"]').inputValue(),
  );
  expect(definition.options).toMatchObject({
    accessible: false,
    duration: 0,
    motion: 'never',
    placement: 'left',
    seed: 'option-seed',
    trigger: 'manual',
  });
  expect(failures).toEqual([]);
});

test('unprovable Range keeps HTML and JSON explicitly unavailable', async ({ page }) => {
  const failures = capturePageFailures(page);
  await page.goto('/');
  const inspector = await openInspector(page);
  await page.evaluate(() => {
    const text = document.querySelector('[data-inspector-unroundtrip]').firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 10);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await expect(inspector).toHaveAttribute('data-inspector-state', 'selected');
  await inspector.getByRole('button', { name: 'Underline', exact: true }).click();
  await inspector.getByRole('button', { name: 'Apply annotation' }).click();

  await expect(page.locator('[data-inspector-output-value="html"]'))
    .toHaveValue(/HTML cannot represent a Range/);
  await expect(page.locator('[data-inspector-output-value="json"]'))
    .toHaveValue(/Unavailable for this Range/);
  await expect(page.locator('[data-inspector-output-value="javascript"]'))
    .toHaveValue(/annotateSelection/);
  expect(failures).toEqual([]);
});

test('copy announces success and selects a readonly fallback after rejection', async ({ page }) => {
  const failures = capturePageFailures(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value) {
          window.__inspectorCopied = value;
          return Promise.resolve();
        },
      },
    });
  });
  await page.goto('/');
  const inspector = await beginUnderlinePreview(page);
  await inspector.getByRole('button', { name: 'Apply annotation' }).click();
  await inspector.getByRole('tab', { name: 'JSON' }).click();
  const copy = inspector.getByRole('button', { name: 'Copy current output' });

  await copy.click();
  expect(await page.evaluate(() => window.__inspectorCopied)).toContain('"schema": "hanamaru/v1"');
  await expect(page.locator('[data-inspector-status]')).toContainText('JSON output copied');

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('forced rejection')) },
    });
  });
  await copy.click();
  const fallback = inspector.getByLabel('Clipboard fallback');
  await expect(fallback).toBeVisible();
  await expect(fallback).toHaveAttribute('readonly', '');
  await expect(fallback).toBeFocused();
  expect(await fallback.evaluate((field) => ({
    end: field.selectionEnd,
    length: field.value.length,
    start: field.selectionStart,
  }))).toEqual({
    end: await fallback.evaluate((field) => field.value.length),
    length: await fallback.evaluate((field) => field.value.length),
    start: 0,
  });
  await expect(page.locator('[data-inspector-status]')).toContainText(
    'Copy blocked. JSON output selected',
  );
  expect(failures).toEqual([]);
});

test('bounded command palette filters and executes through the current Inspector state', async ({
  page,
}) => {
  const failures = capturePageFailures(page);
  await page.goto('/');
  const inspector = await beginUnderlinePreview(page);

  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Inspector commands' });
  await expect(palette).toBeVisible();
  const filter = palette.getByLabel('Filter commands');
  await expect(filter).toBeFocused();
  await expect(palette.locator('[data-inspector-command]')).toHaveCount(12);

  await filter.fill('flower');
  await expect(palette.locator('[data-inspector-command]:visible')).toHaveCount(1);
  await filter.press('Enter');
  await expect(palette).toBeHidden();
  await expect(inspector).toHaveAttribute('data-inspector-state', 'editing');
  await expect(page.locator('.hana-annotation[data-hana-mark="hanamaru"]:not([hidden])'))
    .toHaveCount(1);

  await page.keyboard.press('Control+K');
  await expect(palette).toBeVisible();
  await filter.press('Escape');
  await expect(palette).toBeHidden();
  await expect(inspector).toHaveAttribute('data-inspector-state', 'editing');
  expect(failures).toEqual([]);
});

test('repeated entry exit and hash navigation leave no Inspector listener or owned output', async ({
  page,
}) => {
  const failures = capturePageFailures(page);
  await page.goto('/');
  const inspector = page.locator('[data-inspector-root]');
  const open = page.getByRole('button', { name: 'Open Annotation Inspector' });

  for (let index = 0; index < 2; index += 1) {
    await open.click();
    await expect(inspector).toHaveAttribute('data-inspector-state', 'idle');
    await page.getByRole('button', { name: 'Exit Inspector' }).click();
    await expect(inspector).toBeHidden();
    await expect(open).toBeFocused();
  }

  await selectInspectorWord(page);
  await expect(inspector).toBeHidden();
  await expect(inspector).toHaveCount(0);

  await open.click();
  await page.getByLabel('Demo sections').getByRole('link', { name: 'Quick start' }).click();
  await expect(page).toHaveURL(/#quick-start$/);
  await expect(inspector).toBeHidden();
  await expect(inspector).toHaveCount(0);
  await expect(page.locator('[data-inspector-output]')).toBeHidden();
  expect(failures).toEqual([]);
});

test('keyboard settlement accepts a native Range and Cancel keeps that Range', async ({
  page,
}) => {
  const failures = capturePageFailures(page);
  await page.goto('/');
  const inspector = await openInspector(page);
  const document = page.locator('#inspector-document');
  const initialAnnotations = await page.locator('.hana-annotation').count();

  await document.focus();
  await expect(document).toBeFocused();
  await page.evaluate(() => {
    const text = document.querySelector('[data-inspector-selection-word]').firstChild;
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press('Shift');
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('Portable');
  await expect(inspector).toHaveAttribute('data-inspector-state', 'selected');

  await inspector.getByRole('button', { name: 'Circle', exact: true }).click();
  await expect(inspector).toHaveAttribute('data-inspector-state', 'editing');
  await expect.poll(() => page.locator('.hana-annotation').count()).toBe(initialAnnotations + 1);
  await inspector.getByRole('button', { name: 'Cancel preview' }).click();
  await expect(inspector).toHaveAttribute('data-inspector-state', 'selected');
  await expect(page.locator('[data-inspector-output]')).toBeHidden();
  await expect.poll(() => page.locator('.hana-annotation').count()).toBe(initialAnnotations);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('Portable');
  expect(failures).toEqual([]);
});

test('mark activation never reconstructs a native selection that the host cleared', async ({
  page,
}) => {
  const failures = capturePageFailures(page);
  await page.goto('/');
  const inspector = await openInspector(page);
  await selectInspectorWord(page);
  const initialAnnotations = await page.locator('.hana-annotation').count();

  await page.evaluate(() => {
    getSelection().removeAllRanges();
    document.querySelector(
      '[data-inspector-root] [data-inspector-mark="underline"]',
    ).click();
  });

  await expect(inspector).toHaveAttribute('data-inspector-state', 'idle');
  await expect.poll(() => page.locator('.hana-annotation').count()).toBe(initialAnnotations);
  expect(await page.evaluate(() => ({
    rangeCount: getSelection().rangeCount,
    text: getSelection().toString(),
  }))).toEqual({ rangeCount: 0, text: '' });
  expect(failures).toEqual([]);
});

test('a detached replacement Range leaves the applied controller and output unchanged', async ({
  page,
}) => {
  const failures = capturePageFailures(page);
  await page.goto('/');
  const inspector = await beginUnderlinePreview(page);
  await inspector.getByRole('button', { name: 'Apply annotation' }).click();
  const before = {
    groups: await page.locator('.hana-annotation').count(),
    json: await page.locator('[data-inspector-output-value="json"]').inputValue(),
  };

  await page.evaluate(() => {
    const detached = document.createElement('span');
    detached.textContent = 'detached Inspector replacement';
    const range = document.createRange();
    range.selectNodeContents(detached);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(
    () => requestAnimationFrame(resolve),
  )));

  await expect(inspector).toHaveAttribute('data-inspector-state', 'applied');
  await expect(page.locator('.hana-annotation')).toHaveCount(before.groups);
  await expect(page.locator('[data-inspector-output-value="json"]')).toHaveValue(before.json);
  expect(failures).toEqual([]);
});

test('Inspector runtime imports use only documented bare public package specifiers', async ({
  request,
}) => {
  const [documentSource, inspectorSource, demoSource] = await Promise.all([
    request.get('/demo/index.html').then((response) => response.text()),
    request.get('/demo/inspector.js').then((response) => response.text()),
    request.get('/demo/demo.js').then((response) => response.text()),
  ]);
  const mapSource = documentSource.match(
    /<script type="importmap">([\s\S]*?)<\/script>/u,
  )?.[1];
  expect(mapSource).toBeTruthy();
  expect(JSON.parse(mapSource).imports).toEqual({
    'hanamaru-annotations': '/src/index.js',
    'hanamaru-annotations/plugins': '/src/plugins.js',
    'hanamaru-annotations/selection': '/src/selection.js',
    'hanamaru-annotations/serialize': '/src/serialize.js',
  });

  const publicImports = [...inspectorSource.matchAll(
    /^import(?:[\s\S]*?)from\s+['"](hanamaru-annotations(?:\/[^'"]+)?)['"];$/gmu,
  )].map((match) => match[1]);
  expect(publicImports).toEqual([
    'hanamaru-annotations',
    'hanamaru-annotations/plugins',
    'hanamaru-annotations/selection',
    'hanamaru-annotations/serialize',
  ]);
  expect(inspectorSource).not.toMatch(/from\s+['"](?:\.\.\/)*src\//u);
  expect(inspectorSource).not.toMatch(/\.(?:removeAllRanges|addRange)\s*\(/u);
  expect(demoSource).toContain("await import('/demo/inspector.js')");
});
