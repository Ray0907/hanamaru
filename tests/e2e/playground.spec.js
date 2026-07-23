import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const marks = ['underline', 'highlight', 'circle', 'box', 'strike', 'bracket'];

function overlaps(first, second, inset = 0) {
  return first.x < second.x + second.width - inset
    && first.x + first.width > second.x + inset
    && first.y < second.y + second.height - inset
    && first.y + first.height > second.y + inset;
}

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
    await expect(form.getByRole('group', { name, exact: true })).toHaveCount(1);
  }
  await expect(form.getByRole('group', { name: 'Trigger', exact: true })).toHaveCount(1);
  await expect(form.getByRole('group', {
    name: 'Output and execution mode',
    exact: true,
  })).toHaveCount(1);

  await expect(form.getByLabel('Existing phrase')).toHaveValue('#playground-target-reflow');
  await expect(form.getByLabel('Mark')).toHaveValue('underline');
  await expect(form.getByLabel('Optional note')).toHaveAttribute('maxlength', '280');
  await expect(form.getByLabel('Placement')).toHaveValue('auto');
  await expect(form.getByLabel('Placement')).toHaveAccessibleDescription(
    'Placement is a preference. Hanamaru safely falls back when that side would clip or collide.',
  );
  await expect(form.locator('#playground-placement-help')).toBeVisible();
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
  await expect(playground.locator('[data-playground-code]'))
    .toContainText('Choose one existing specimen phrase');
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

test('malformed and unknown injected target values stay inside validation without selector evaluation', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const playground = await openPlayground(page);
  const target = playground.getByLabel('Existing phrase');
  const code = playground.locator('[data-playground-code]');

  await playground.getByRole('radio', { name: 'Declarative HTML' }).check();
  await target.evaluate((control) => {
    control.add(new Option('Injected malformed selector', '['));
    control.value = '[';
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(code).toContainText('Choose one existing specimen phrase');
  await expect(code).not.toContainText("querySelector('[')");
  await playground.getByRole('radio', { name: 'Imperative JavaScript' }).check();
  await expect(code).toContainText('Choose one existing specimen phrase');
  await expect(code).not.toContainText("annotate('['");
  await playground.getByRole('radio', { name: 'Declarative HTML' }).check();
  await playground.getByRole('button', { name: 'Run definition' }).click();
  await expect(target).toBeFocused();
  await expect(target).toHaveAttribute('aria-invalid', 'true');
  await expect(playground.locator('[data-playground-result]')).toContainText('Needs correction');
  await expect(playground.locator('[data-playground-owner]')).toContainText('No output');
  expect(pageErrors).toEqual([]);

  await target.evaluate((control) => {
    control.options[control.selectedIndex].value = '#locator-proof';
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(code).toContainText('Choose one existing specimen phrase');
  await playground.getByRole('button', { name: 'Run definition' }).click();
  await expect(target).toBeFocused();
  await expect(page.locator('#locator-proof')).not.toHaveAttribute('data-hana');

  await target.selectOption('#playground-target-proof');
  await runDefinition(playground);
  await expect(target).not.toHaveAttribute('aria-invalid');
  expect(pageErrors).toEqual([]);
});

test('an allowed target moved outside its specimen is rejected without authored-attribute leakage', async ({ page }) => {
  const playground = await openPlayground(page);
  const control = playground.getByLabel('Existing phrase');
  const target = page.locator('#playground-target-reflow');

  await playground.getByRole('radio', { name: 'Declarative HTML' }).check();
  await target.evaluate((node) => {
    window.__playgroundOriginalParent = node.parentNode;
    window.__playgroundOriginalNext = node.nextSibling;
    document.querySelector('#limitations').append(node);
  });
  await playground.getByRole('button', { name: 'Run definition' }).click();
  await expect(control).toBeFocused();
  await expect(control).toHaveAttribute('aria-invalid', 'true');
  await expect(target).not.toHaveAttribute('data-hana');
  await expect(target).not.toHaveAttribute('data-playground-output-owner');
  await expect(playground.locator('[data-playground-result]')).toContainText('Needs correction');

  await target.evaluate((node) => {
    window.__playgroundOriginalParent.insertBefore(node, window.__playgroundOriginalNext);
  });
  await runDefinition(playground);
  await expect(control).not.toHaveAttribute('aria-invalid');
});

test('invalid rerun retires the prior declarative controller and owned attributes before validation', async ({ page }) => {
  const playground = await openPlayground(page);
  const control = playground.getByLabel('Existing phrase');
  const target = playground.locator('#playground-target-reflow');

  await playground.getByRole('radio', { name: 'Declarative HTML' }).check();
  await runDefinition(playground);
  await target.scrollIntoViewIfNeeded();
  const prior = page.locator('.hana-annotation[data-hana-mark="underline"]:not([hidden])');
  await expect(prior).toHaveCount(1);
  const priorId = await prior.getAttribute('data-hana-id');
  await expect(target).toHaveAttribute('data-hana', 'underline');

  await control.evaluate((select) => {
    select.add(new Option('Injected malformed selector', '['));
    select.value = '[';
    select.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await playground.getByRole('button', { name: 'Run definition' }).click();
  await expect(page.locator(`.hana-annotation[data-hana-id="${priorId}"]`)).toHaveCount(0);
  await expect(target).not.toHaveAttribute('data-hana');
  await expect(target).not.toHaveAttribute('data-playground-output-owner');
  await expect(playground.locator('[data-playground-owner]')).toContainText('No output');
  await expect(control).toBeFocused();

  await control.selectOption('#playground-target-reflow');
  await runDefinition(playground);
  await expect(target).toHaveAttribute('data-hana', 'underline');
});

test('declarative zero and thrown scans roll back the exact authored element and recover', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const playground = await openPlayground(page);
  const specimen = playground.locator('[data-playground-specimen]');
  const target = playground.locator('#playground-target-reflow');
  const run = playground.locator('[data-playground-run]');

  await playground.getByRole('radio', { name: 'Declarative HTML' }).check();
  await specimen.evaluate((root) => {
    window.__playgroundQuerySelectorAll = root.querySelectorAll;
    root.querySelectorAll = () => {
      const authored = document.querySelector('#playground-target-reflow');
      window.__playgroundDetachedTarget = authored;
      window.__playgroundDetachedParent = authored.parentNode;
      window.__playgroundDetachedNext = authored.nextSibling;
      authored.remove();
      return [];
    };
  });
  await run.click();
  await expect(playground.locator('[data-playground-result]')).toContainText('HANA_TARGET_MISSING');
  await expect(playground.getByLabel('Existing phrase')).toBeFocused();
  const detachedState = await page.evaluate(() => ({
    hana: window.__playgroundDetachedTarget.hasAttribute('data-hana'),
    owner: window.__playgroundDetachedTarget.hasAttribute('data-playground-output-owner'),
  }));
  expect(detachedState).toEqual({ hana: false, owner: false });

  await specimen.evaluate((root) => {
    root.querySelectorAll = window.__playgroundQuerySelectorAll;
    window.__playgroundDetachedParent.insertBefore(
      window.__playgroundDetachedTarget,
      window.__playgroundDetachedNext,
    );
    root.querySelectorAll = () => { throw new TypeError('forced scan failure'); };
  });
  await run.click();
  await expect(playground.locator('[data-playground-result]')).toContainText('HANA_TARGET_MISSING');
  await expect(target).not.toHaveAttribute('data-hana');
  await expect(target).not.toHaveAttribute('data-playground-output-owner');
  expect(pageErrors).toEqual([]);

  await specimen.evaluate((root) => { root.querySelectorAll = window.__playgroundQuerySelectorAll; });
  await runDefinition(playground);
  await expect(target).toHaveAttribute('data-hana', 'underline');
});

test('a disconnected allowed target is validation-focused and leaves the constrained form recoverable', async ({ page }) => {
  const playground = await openPlayground(page);
  const target = playground.locator('#playground-target-reflow');
  const control = playground.getByLabel('Existing phrase');

  await target.evaluate((node) => {
    window.__detachedPlaygroundTarget = node;
    window.__detachedPlaygroundParent = node.parentNode;
    window.__detachedPlaygroundNext = node.nextSibling;
    node.remove();
  });
  await playground.getByRole('button', { name: 'Run definition' }).click();
  await expect(playground.locator('[data-playground-state]')).toHaveText('error');
  await expect(playground.locator('[data-playground-result]')).toContainText('Needs correction');
  await expect(control).toBeFocused();
  await expect(control).toHaveAttribute('aria-invalid', 'true');

  await page.evaluate(() => {
    window.__detachedPlaygroundParent.insertBefore(
      window.__detachedPlaygroundTarget,
      window.__detachedPlaygroundNext,
    );
  });
  await runDefinition(playground);
  await expect(playground.locator('[data-playground-result]')).toContainText('Rendered');
  await expect(control).not.toHaveAttribute('aria-invalid');
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

test('390px auto note keeps a proof lane clear of adjacent specimen copy', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const playground = await openPlayground(page);
  await playground.getByLabel('Existing phrase').selectOption('#playground-target-proof');
  await playground.getByLabel('Mark').selectOption('circle');
  await playground.getByLabel('Optional note').fill('Recovered through the constrained target map.');
  await runDefinition(playground);
  await playground.locator('#playground-target-proof').scrollIntoViewIfNeeded();

  const note = page.locator('.hana-note:not(.hana-is-hidden)', {
    hasText: 'Recovered through the constrained target map.',
  });
  await expect(note).toBeVisible();
  const paragraphs = playground.locator('.demo-playground__specimen p:not(.demo-playground__folio)');
  const [noteBox, previousBox, nextBox] = await Promise.all([
    note.boundingBox(),
    paragraphs.nth(0).boundingBox(),
    paragraphs.nth(2).boundingBox(),
  ]);
  expect(overlaps(noteBox, previousBox, 2)).toBe(false);
  expect(overlaps(noteBox, nextBox, 2)).toBe(false);
});

test('390px preferred side stays truthful while safe placement keeps the note contained', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const playground = await openPlayground(page);
  const placement = playground.getByLabel('Placement');
  await playground.getByLabel('Existing phrase').selectOption('#playground-target-proof');
  await playground.getByLabel('Mark').selectOption('circle');
  await playground.getByLabel('Optional note').fill('A preferred side can yield to safe placement.');
  await placement.selectOption('right');
  await expect(placement).toHaveAccessibleDescription(/safely falls back/);
  await expect(playground.locator('[data-playground-code]')).toContainText("placement: 'right'");
  await runDefinition(playground);
  await playground.locator('#playground-target-proof').scrollIntoViewIfNeeded();

  const note = page.locator('.hana-note:not(.hana-is-hidden)', {
    hasText: 'A preferred side can yield to safe placement.',
  });
  await expect(note).toBeVisible();
  const box = await note.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
});

test('declarative playground controller survives persisted lifecycle and tears down once on final pagehide', async ({ page }) => {
  await page.addInitScript(() => {
    const records = [];
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function patchedAdd(type, listener, options) {
      if (this instanceof Element
        && this.id === 'playground-target-reflow'
        && type.startsWith('hana:')) {
        records.push({ type, listener, removed: false });
      }
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function patchedRemove(type, listener, options) {
      const record = records.find((item) => (
        !item.removed && item.type === type && item.listener === listener
      ));
      if (record) record.removed = true;
      return remove.call(this, type, listener, options);
    };
    window.__playgroundListenerDiagnostics = () => ({
      active: records.filter(({ removed }) => !removed).map(({ type }) => type).sort(),
      added: records.map(({ type }) => type).sort(),
      removed: records.filter(({ removed }) => removed).map(({ type }) => type).sort(),
    });
  });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const playground = await openPlayground(page);
  const target = playground.locator('#playground-target-reflow');
  await playground.getByRole('radio', { name: 'Declarative HTML' }).check();
  await playground.getByLabel('Optional note').fill('Lifecycle-owned output.');
  await runDefinition(playground);

  const firstOutput = page.locator('.hana-note', {
    hasText: 'Lifecycle-owned output.',
  });
  const firstId = await firstOutput.getAttribute('data-hana-id');
  expect(firstId).not.toBeNull();
  const authoredBeforePersist = await target.evaluate((node) => Object.fromEntries([
    'data-hana', 'data-hana-note', 'data-hana-accessible', 'data-hana-placement',
    'data-hana-trigger', 'data-hana-duration', 'data-hana-motion',
    'data-playground-output-owner',
  ].map((attribute) => [attribute, node.getAttribute(attribute)])));
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  expect(await target.evaluate((node, attributes) => Object.fromEntries(
    attributes.map((attribute) => [attribute, node.getAttribute(attribute)]),
  ), Object.keys(authoredBeforePersist)))
    .toEqual(authoredBeforePersist);
  await expect(page.locator(`.hana-annotation[data-hana-id="${firstId}"]`)).toHaveCount(1);
  await expect(firstOutput).toHaveAttribute('data-hana-id', firstId);
  await expect(playground.locator('[data-playground-state]')).toHaveText('visible');
  expect(await page.evaluate(() => window.__playgroundListenerDiagnostics())).toEqual({
    active: ['hana:cancel', 'hana:complete', 'hana:error', 'hana:start'],
    added: ['hana:cancel', 'hana:complete', 'hana:error', 'hana:start'],
    removed: [],
  });

  await runDefinition(playground);
  const secondId = await page.locator('.hana-note', {
    hasText: 'Lifecycle-owned output.',
  }).getAttribute('data-hana-id');
  expect(secondId).not.toBeNull();
  expect(secondId).not.toBe(firstId);
  await expect(page.locator(`.hana-annotation[data-hana-id="${firstId}"]`)).toHaveCount(0);
  await expect(page.locator(`.hana-annotation[data-hana-id="${secondId}"]`)).toHaveCount(1);
  expect(await page.evaluate(() => window.__playgroundListenerDiagnostics())).toEqual({
    active: ['hana:cancel', 'hana:complete', 'hana:error', 'hana:start'],
    added: [
      'hana:cancel', 'hana:cancel', 'hana:complete', 'hana:complete',
      'hana:error', 'hana:error', 'hana:start', 'hana:start',
    ],
    removed: ['hana:cancel', 'hana:complete', 'hana:error', 'hana:start'],
  });

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
  });
  await expect(page.locator('[data-hana-overlay]')).toHaveCount(0);
  for (const attribute of [
    'data-hana', 'data-hana-note', 'data-hana-accessible',
    'data-hana-placement', 'data-hana-trigger', 'data-hana-duration', 'data-hana-motion',
    'data-playground-output-owner',
  ]) {
    await expect(target).not.toHaveAttribute(attribute);
  }
  const finalDiagnostics = await page.evaluate(() => window.__playgroundListenerDiagnostics());
  expect(finalDiagnostics.active).toEqual([]);
  expect(finalDiagnostics.removed).toEqual(finalDiagnostics.added);

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
  });
  expect(await page.evaluate(() => window.__playgroundListenerDiagnostics()))
    .toEqual(finalDiagnostics);
  expect(pageErrors).toEqual([]);
});
