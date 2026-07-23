import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const marks = ['underline', 'highlight', 'circle', 'box', 'strike', 'bracket'];

async function openPlayground(page) {
  await page.goto('/');
  const playground = page.getByRole('region', { name: 'Live playground' });
  await playground.scrollIntoViewIfNeeded();
  return playground;
}

async function runDefinition(playground) {
  await playground.getByRole('button', { name: 'Run definition' }).click();
  await expect(playground.locator('[data-playground-state]')).toHaveText('visible');
}

test('playground is a constrained semantic workbench with one generated definition', async ({ page }) => {
  const playground = await openPlayground(page);
  const form = playground.locator('form[data-playground-form]');

  await expect(form).toHaveCount(1);
  await expect(form.locator('fieldset')).toHaveCount(3);
  for (const name of ['Specimen target', 'Annotation', 'Execution']) {
    await expect(form.getByRole('group', { name })).toHaveCount(1);
  }

  await expect(form.getByLabel('Existing phrase')).toHaveValue('#playground-target-reflow');
  await expect(form.getByLabel('Mark')).toHaveValue('underline');
  await expect(form.getByLabel('Optional note')).toHaveAttribute('maxlength', '280');
  await expect(form.getByLabel('Placement')).toHaveValue('auto');
  await expect(form.getByRole('radio', { name: 'Manual' })).toBeChecked();
  await expect(form.getByRole('radio', { name: 'Imperative JavaScript' })).toBeChecked();

  const code = playground.locator('[data-playground-code]');
  await expect(code).toContainText("annotate('#playground-target-reflow'");
  await expect(code).toContainText("mark: 'underline'");
  await expect(code).toContainText("trigger: 'manual'");
  await expect(code).toContainText('annotation.show()');
  await expect(playground.locator('[data-playground-state]')).toHaveText('ready');
  await expect(playground.locator('[data-playground-method]')).toHaveText('annotate()');
  await expect(playground.locator('[data-playground-owner]')).toContainText('No output');
  await expect(page.locator('[role="status"], [aria-live]')).toHaveCount(1);
});

test('every authored option changes the exact code and the real public-runtime output', async ({ page }) => {
  const playground = await openPlayground(page);
  const target = playground.getByLabel('Existing phrase');
  const mark = playground.getByLabel('Mark');
  const note = playground.getByLabel('Optional note');
  const placement = playground.getByLabel('Placement');
  const code = playground.locator('[data-playground-code]');

  await target.selectOption('#playground-target-proof');
  await expect(code).toContainText("annotate('#playground-target-proof'");
  await note.fill('A measured playground note.');
  await expect(code).toContainText("note: 'A measured playground note.'");
  await expect(code).toContainText('accessible: true');
  await placement.selectOption('bottom');
  await expect(code).toContainText("placement: 'bottom'");

  for (const value of marks) {
    await mark.selectOption(value);
    await expect(code).toContainText(`mark: '${value}'`);
    await runDefinition(playground);
    await playground.locator('#playground-target-proof').scrollIntoViewIfNeeded();
    const group = page.locator(`.hana-annotation[data-hana-mark="${value}"]:not([hidden])`);
    await expect(group).toHaveCount(1);
    await expect(group.locator('.hana-mark-path')).not.toHaveCount(0);
    await expect(page.locator('.hana-annotation:not([hidden])')).toHaveCount(1);
    await expect(playground.locator('[data-playground-owner]')).toContainText('Proof follows text');
  }

  const owner = playground.locator('#playground-target-proof');
  const noteOutput = page.locator('.hana-note:not(.hana-is-hidden)', {
    hasText: 'A measured playground note.',
  });
  await expect(noteOutput).toBeVisible();
  await expect(owner).toHaveAttribute('aria-describedby', /hana-note-/);
  await expect(noteOutput).toHaveAttribute('data-hana-side', 'bottom');
  const [noteBox, nextLineBox] = await Promise.all([
    noteOutput.boundingBox(),
    playground.locator('#playground-target-data').locator('xpath=..').boundingBox(),
  ]);
  expect(noteBox.y + noteBox.height).toBeLessThanOrEqual(nextLineBox.y - 4);

  const firstPath = await page.locator('.hana-mark-path').first().getAttribute('d');
  await target.selectOption('#playground-target-data');
  await note.fill('');
  await expect(code).not.toContainText('note:');
  await runDefinition(playground);
  await playground.locator('#playground-target-data').scrollIntoViewIfNeeded();
  await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(0);
  await expect(playground.locator('[data-playground-owner]')).toContainText('Definitions remain data');
  expect(await page.locator('.hana-mark-path').first().getAttribute('d')).not.toBe(firstPath);
});

test('imperative annotate and declarative scan execute matching definitions without duplicate ownership', async ({ page }) => {
  const playground = await openPlayground(page);
  const code = playground.locator('[data-playground-code]');
  const target = playground.locator('#playground-target-reflow');

  await runDefinition(playground);
  await expect(playground.locator('[data-playground-method]')).toHaveText('annotate()');
  await expect(target).not.toHaveAttribute('data-hana');

  await playground.getByRole('radio', { name: 'Declarative HTML' }).check();
  await expect(code).toContainText('data-hana="underline"');
  await expect(code).toContainText('scan(root)');
  await expect(code).toContainText('annotation.show()');
  await runDefinition(playground);
  await expect(playground.locator('[data-playground-method]')).toHaveText('scan()');
  await expect(target).toHaveAttribute('data-hana', 'underline');
  await expect(target).toHaveAttribute('data-hana-trigger', 'manual');
  await target.scrollIntoViewIfNeeded();
  const firstOutput = page.locator('.hana-annotation[data-hana-mark="underline"]:not([hidden])');
  await expect(firstOutput).toHaveCount(1);
  const firstId = await firstOutput.getAttribute('data-hana-id');

  await playground.getByLabel('Mark').selectOption('box');
  await runDefinition(playground);
  await target.scrollIntoViewIfNeeded();
  await expect(target).toHaveAttribute('data-hana', 'box');
  await expect(page.locator(`.hana-annotation[data-hana-id="${firstId}"]`)).toHaveCount(0);
  await expect(page.locator('.hana-annotation[data-hana-mark="box"]:not([hidden])')).toHaveCount(1);
});

test('manual, load, and viewport triggers report truthful controller transitions', async ({ page }) => {
  const playground = await openPlayground(page);
  const manual = playground.getByRole('radio', { name: 'Manual' });
  const load = playground.getByRole('radio', { name: 'Load' });
  const viewport = playground.getByRole('radio', { name: 'Viewport' });
  const code = playground.locator('[data-playground-code]');

  await manual.check();
  await expect(code).toContainText('annotation.show()');
  await runDefinition(playground);
  await expect(playground.locator('[data-playground-trigger]')).toContainText('manual · explicit show');

  await load.check();
  await expect(code).not.toContainText('annotation.show()');
  await playground.getByRole('button', { name: 'Run definition' }).click();
  await expect(playground.locator('[data-playground-trigger]')).toContainText('load · automatic');
  await expect(playground.locator('[data-playground-state]')).toHaveText('visible');

  await viewport.check();
  await expect(code).not.toContainText('annotation.show()');
  await playground.getByRole('button', { name: 'Run definition' }).click();
  await expect(playground.locator('[data-playground-trigger]')).toContainText('viewport · automatic');
  await expect(playground.locator('[data-playground-state]')).toHaveText('idle');
  await playground.locator('#playground-target-reflow').scrollIntoViewIfNeeded();
  await expect(playground.locator('[data-playground-state]')).toHaveText('visible');

  const starts = await playground.locator('[data-playground-run-count]').textContent();
  await page.locator('#limitations').scrollIntoViewIfNeeded();
  await expect(page.locator('.hana-annotation:not([hidden])')).toHaveCount(0);
  await playground.locator('#playground-target-reflow').scrollIntoViewIfNeeded();
  await expect(playground.locator('[data-playground-run-count]')).toHaveText(starts);
  await expect(page.locator('.hana-annotation:not([hidden])')).toHaveCount(1);
});

test('copy writes the current exact definition and exposes a full selected fallback on rejection', async ({ page }) => {
  await page.addInitScript(() => {
    window.__playgroundCopies = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value) {
          window.__playgroundCopies.push(value);
          return Promise.resolve();
        },
      },
    });
  });
  const playground = await openPlayground(page);
  const code = playground.locator('[data-playground-code]');
  const copy = playground.getByRole('button', { name: 'Copy definition' });

  await playground.getByLabel('Mark').selectOption('highlight');
  await copy.click();
  expect(await page.evaluate(() => window.__playgroundCopies.at(-1)))
    .toBe(await code.textContent());
  await expect(playground.locator('[data-playground-result]')).toContainText('Copied');
  await expect(copy).toBeFocused();

  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error('blocked'));
  });
  await playground.getByRole('radio', { name: 'Declarative HTML' }).check();
  await copy.click();
  const fallback = playground.getByLabel('Clipboard fallback definition');
  await expect(fallback).toBeVisible();
  await expect(fallback).toBeFocused();
  await expect(fallback).toHaveValue(await code.textContent());
  expect(await fallback.evaluate((node) => [node.selectionStart, node.selectionEnd]))
    .toEqual([0, (await code.textContent()).length]);
  await expect(playground.locator('[data-playground-result]')).toContainText('Copy blocked');
});

test('validation associates a visible non-color error, focuses it, and then recovers', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const playground = await openPlayground(page);
  const target = playground.getByLabel('Existing phrase');
  const error = playground.locator('#playground-target-error');

  await playground.getByRole('radio', { name: 'Declarative HTML' }).check();
  await target.selectOption('');
  await expect(playground.locator('[data-playground-code]')).toContainText('<span id=""');
  await playground.getByRole('button', { name: 'Run definition' }).click();
  await expect(target).toBeFocused();
  await expect(target).toHaveAttribute('aria-invalid', 'true');
  await expect(target).toHaveAttribute('aria-describedby', /playground-target-error/);
  await expect(error).toBeVisible();
  await expect(error).toContainText('Choose one existing phrase');
  await expect.poll(() => error.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight;
  })).toBe(true);
  await expect(playground.locator('[data-playground-state]')).toHaveText('error');
  await expect(playground.locator('[data-playground-result]')).toContainText('Needs correction');

  await target.selectOption('#playground-target-proof');
  await runDefinition(playground);
  await expect(target).not.toHaveAttribute('aria-invalid');
  await expect(error).toBeHidden();
  await expect(playground.locator('[data-playground-result]')).toContainText('Rendered');
  expect(pageErrors).toEqual([]);
});

test('typed runtime target failures use the docket and leave the constrained form recoverable', async ({ page }) => {
  const playground = await openPlayground(page);
  const target = playground.locator('#playground-target-reflow');

  await target.evaluate((node) => {
    window.__detachedPlaygroundTarget = node;
    window.__detachedPlaygroundParent = node.parentNode;
    window.__detachedPlaygroundNext = node.nextSibling;
    node.remove();
  });
  await playground.getByRole('button', { name: 'Run definition' }).click();
  await expect(playground.locator('[data-playground-state]')).toHaveText('error');
  await expect(playground.locator('[data-playground-result]')).toContainText('HANA_TARGET_MISSING');
  await expect(playground.locator('[data-playground-docket]')).toBeFocused();

  await page.evaluate(() => {
    window.__detachedPlaygroundParent.insertBefore(
      window.__detachedPlaygroundTarget,
      window.__detachedPlaygroundNext,
    );
  });
  await runDefinition(playground);
  await expect(playground.locator('[data-playground-result]')).toContainText('Rendered');
});

test('controls follow logical keyboard order, show focus, and pass a targeted axe scan', async ({ page }) => {
  const playground = await openPlayground(page);
  const order = [
    playground.getByLabel('Existing phrase'),
    playground.getByLabel('Mark'),
    playground.getByLabel('Optional note'),
    playground.getByLabel('Placement'),
    playground.getByRole('radio', { name: 'Manual' }),
    playground.getByRole('radio', { name: 'Imperative JavaScript' }),
    playground.getByRole('button', { name: 'Run definition' }),
    playground.getByRole('button', { name: 'Copy definition' }),
  ];

  await order[0].focus();
  for (let index = 0; index < order.length; index += 1) {
    await expect(order[index]).toBeFocused();
    const outline = await order[index].evaluate((node) => {
      const style = getComputedStyle(node);
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThanOrEqual(3);
    if (index < order.length - 1) await page.keyboard.press('Tab');
  }

  await order[4].focus();
  await page.keyboard.press('ArrowRight');
  await expect(playground.getByRole('radio', { name: 'Load' })).toBeChecked();
  await order[5].focus();
  await page.keyboard.press('ArrowRight');
  await expect(playground.getByRole('radio', { name: 'Declarative HTML' })).toBeChecked();
  await order[6].focus();
  await page.keyboard.press('Enter');
  await expect(playground.locator('[data-playground-state]')).toHaveText('visible');
  await expect(order[6]).toBeFocused();

  const result = await new AxeBuilder({ page }).include('#playground').analyze();
  expect(result.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical'))
    .toEqual([]);
});

test('390px playground is contained and leaves no sticky output after scrolling away', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const playground = await openPlayground(page);
  await runDefinition(playground);

  const layout = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
    section: document.querySelector('#playground').getBoundingClientRect(),
  }));
  expect(layout.page).toBeLessThanOrEqual(layout.viewport);
  expect(layout.section.left).toBeGreaterThanOrEqual(0);
  expect(layout.section.right).toBeLessThanOrEqual(layout.viewport);

  await page.locator('#limitations').scrollIntoViewIfNeeded();
  await expect(page.locator('.hana-annotation:not([hidden])')).toHaveCount(0);
  await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(0);
});
