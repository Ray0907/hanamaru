import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const seriousOrCritical = (results) => results.violations.filter(
  ({ impact }) => impact === 'serious' || impact === 'critical',
);

async function scanPage(page, label) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(seriousOrCritical(results), `${label} axe violations`).toEqual([]);
}

async function contrast(locator, property = 'color', backgroundLocator = null) {
  return locator.evaluate((node, { propertyName, backgroundSelector }) => {
    const parse = (value) => {
      const channels = value.match(/[\d.]+/gu)?.map(Number) ?? [];
      return {
        r: channels[0] ?? 0,
        g: channels[1] ?? 0,
        b: channels[2] ?? 0,
        a: channels[3] ?? 1,
      };
    };
    const composite = (foreground, background) => {
      const alpha = foreground.a + (background.a * (1 - foreground.a));
      if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: ((foreground.r * foreground.a)
          + (background.r * background.a * (1 - foreground.a))) / alpha,
        g: ((foreground.g * foreground.a)
          + (background.g * background.a * (1 - foreground.a))) / alpha,
        b: ((foreground.b * foreground.a)
          + (background.b * background.a * (1 - foreground.a))) / alpha,
        a: alpha,
      };
    };
    const backgroundFor = (element) => {
      const ancestry = [];
      for (let current = element; current instanceof Element; current = current.parentElement) {
        ancestry.push(parse(getComputedStyle(current).backgroundColor));
      }
      let resolved = { r: 255, g: 255, b: 255, a: 1 };
      for (const layer of ancestry.reverse()) resolved = composite(layer, resolved);
      return resolved;
    };
    const linear = (channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (value) => (0.2126 * linear(value.r))
      + (0.7152 * linear(value.g))
      + (0.0722 * linear(value.b));
    const ratio = (first, second) => {
      const high = Math.max(luminance(first), luminance(second));
      const low = Math.min(luminance(first), luminance(second));
      return (high + 0.05) / (low + 0.05);
    };

    const backgroundNode = backgroundSelector
      ? document.querySelector(backgroundSelector)
      : node;
    const background = backgroundFor(backgroundNode);
    const rawForeground = parse(getComputedStyle(node)[propertyName]);
    const foreground = composite(rawForeground, background);
    return {
      background,
      foreground,
      raw: getComputedStyle(node)[propertyName],
      ratio: ratio(foreground, background),
    };
  }, {
    propertyName: property,
    backgroundSelector: backgroundLocator,
  });
}

async function expectContrast(locator, threshold, label, options = {}) {
  const result = await contrast(
    locator,
    options.property ?? 'color',
    options.backgroundSelector ?? null,
  );
  expect(result.ratio, `${label}: ${result.raw}`).toBeGreaterThanOrEqual(threshold);
}

async function forceClipboardFailure(page) {
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('forced clipboard failure')) },
    });
  });
}

test('WCAG A/AA scans stay clear through story, playground, error, fallback, and mobile states', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await scanPage(page, 'default');

  const liveRegions = page.locator('[aria-live="polite"]');
  await expect(liveRegions).toHaveCount(1);
  await expect(liveRegions).toHaveAttribute('role', 'status');

  await page.getByRole('button', { name: 'Play story', exact: true }).click();
  await expect(page.locator('[data-demo-story-state]')).toHaveText('playing');
  await scanPage(page, 'playing');
  await expect(page.locator('[data-demo-story-state]')).toHaveText('complete', { timeout: 8_000 });
  await scanPage(page, 'complete');

  const playground = page.locator('#playground');
  await playground.scrollIntoViewIfNeeded();
  await playground.getByLabel('Optional note').fill('A visible, associated playground note.');
  await playground.getByRole('button', { name: 'Run definition' }).click();
  await expect(playground.locator('[data-playground-state]')).toHaveText('visible');
  await scanPage(page, 'playground run');

  await playground.getByLabel('Existing phrase').selectOption('');
  await playground.getByRole('button', { name: 'Run definition' }).click();
  await expect(playground.getByLabel('Existing phrase')).toHaveAttribute('aria-invalid', 'true');
  await scanPage(page, 'validation error');

  await forceClipboardFailure(page);
  await playground.getByRole('button', { name: 'Copy definition' }).click();
  await expect(playground.getByLabel('Clipboard fallback definition')).toBeVisible();
  await scanPage(page, 'copy fallback');

  await page.setViewportSize({ width: 390, height: 844 });
  await playground.getByLabel('Existing phrase').selectOption('#playground-target-proof');
  await playground.getByRole('button', { name: 'Run definition' }).click();
  await expect(playground.locator('[data-playground-state]')).toHaveText('visible');
  await scanPage(page, 'mobile run');
  await expect(liveRegions).toHaveCount(1);
});

test('computed text, state, boundary, and focus contrast resolves real composited backgrounds', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  await expectContrast(page.locator('.demo-proof-lede'), 4.5, 'supporting text on paper');
  await expectContrast(page.locator('.demo-code-tray__heading').first(), 4.5, 'supporting text on indigo');
  await expectContrast(page.locator('.demo-status'), 4.5, 'success status');
  await expectContrast(page.locator('.demo-stamp--primary'), 4.5, 'primary action text');

  const secondary = page.getByRole('button', { name: 'Copy local starter' });
  await secondary.hover();
  await expectContrast(secondary, 4.5, 'hover action text');
  await expectContrast(secondary, 3, 'hover action boundary', { property: 'borderTopColor' });

  const selectedTab = page.getByRole('tab', { name: 'Story' });
  await expectContrast(selectedTab, 4.5, 'selected tab text');
  const pressedMark = page.getByRole('button', { name: 'underline', exact: true });
  await pressedMark.scrollIntoViewIfNeeded();
  await expectContrast(pressedMark, 4.5, 'pressed mark text');

  const disabledPause = page.getByRole('button', { name: 'Pause story' });
  await expect(disabledPause).toBeDisabled();
  await expectContrast(disabledPause, 4.5, 'disabled story control');

  const playground = page.locator('#playground');
  await playground.scrollIntoViewIfNeeded();
  const target = playground.getByLabel('Existing phrase');
  await expectContrast(target, 3, 'select boundary', { property: 'borderTopColor' });
  await target.selectOption('');
  await playground.getByRole('button', { name: 'Run definition' }).click();
  const error = playground.locator('.demo-field-error:not([hidden])');
  await expectContrast(error, 4.5, 'validation error text');
  await expectContrast(playground.locator('[data-playground-result]'), 4.5, 'error docket state');

  await target.selectOption('#playground-target-reflow');
  await playground.getByRole('button', { name: 'Run definition' }).click();
  await expectContrast(playground.locator('[data-playground-result]'), 4.5, 'success docket state');

  await page.locator('.demo-playground__output pre').focus();
  await expectContrast(page.locator('.demo-playground__output pre'), 3, 'code focus ring', {
    property: 'outlineColor',
    backgroundSelector: '.demo-playground__output',
  });
  await target.focus();
  await expectContrast(target, 3, 'form focus ring', {
    property: 'outlineColor',
    backgroundSelector: '.demo-playground__form',
  });
});

test.describe('reduced motion', () => {
  test('real story preserves lifecycle and final output without interpolated motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.evaluate(() => {
      const owner = document.querySelector('#locator-proof');
      window.__reducedEvents = [];
      for (const type of ['start', 'step', 'complete']) {
        owner.addEventListener(`hana:${type}`, (event) => {
          const kind = typeof event.detail.controller?.play === 'function'
            ? 'story'
            : 'annotation';
          window.__reducedEvents.push(`${kind}:${type}:${event.detail.controller.state}`);
          if (kind === 'story' && type === 'start') {
            window.__reducedStory = event.detail.controller;
            window.__reducedPromise = event.detail.controller.finished;
          }
        });
      }
    });

    await page.getByRole('button', { name: 'Play story', exact: true }).click();
    await expect(page.locator('[data-demo-story-state]')).toHaveText('complete');
    await expect(page.locator('.hana-annotation:not([hidden])')).toHaveCount(2);
    await expect(page.locator('.hana-connector-path')).toHaveCount(4);
    await expect(page.locator('.hana-note:not(.hana-is-hidden)')).toHaveCount(2);

    const reduced = await page.evaluate(async () => {
      await window.__reducedPromise;
      return {
        animations: document.getAnimations().map(({ playState }) => playState),
        classes: document.querySelectorAll('.hana-is-animating, .hana-is-paused').length,
        events: window.__reducedEvents,
        matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        promiseStable: window.__reducedPromise === window.__reducedStory.finished,
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
        state: window.__reducedStory.state,
        styles: [...document.querySelectorAll('.hana-mark-path')].map((path) => ({
          clipPath: path.style.clipPath,
          dashoffset: getComputedStyle(path).strokeDashoffset,
        })),
      };
    });
    expect(reduced.matches).toBe(true);
    expect(reduced.state).toBe('complete');
    expect(reduced.promiseStable).toBe(true);
    expect(reduced.scrollBehavior).toBe('auto');
    expect(reduced.animations).toEqual([]);
    expect(reduced.classes).toBe(0);
    expect(
      reduced.styles.every(({ dashoffset }) => dashoffset === '0px'),
      JSON.stringify(reduced.styles),
    ).toBe(true);
    expect(reduced.events.filter((value) => value.startsWith('story:'))).toEqual([
      'story:start:playing',
      'story:step:playing',
      'story:step:playing',
      'story:complete:complete',
    ]);

    const replay = page.getByRole('button', { name: 'Replay story' });
    await expect(replay).toBeEnabled();
    await replay.click();
    await expect(page.locator('[data-demo-story-run]')).toHaveText('2');
    await expect(page.locator('[data-demo-story-state]')).toHaveText('complete');
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });
});

test('keyboard order and visible focus cover skip, story, reflow, ledger, API, and playground controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to proof' });
  await expect(skip).toBeFocused();
  await expectContrast(skip, 3, 'skip focus ring', {
    property: 'outlineColor',
    backgroundSelector: '.demo-page',
  });
  await skip.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await expect(page.locator('#main-content')).toBeInViewport();

  const storyTab = page.getByRole('tab', { name: 'Story' });
  await storyTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'JSON' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'HTML' })).toBeFocused();

  const focusStoryControl = async (name) => {
    const control = page.getByRole('button', { name, exact: true });
    await control.focus();
    await expect(control).toBeFocused();
    await expectContrast(control, 3, `${name} focus ring`, {
      property: 'outlineColor',
      backgroundSelector: '.demo-code-tray',
    });
    return control;
  };
  const play = await focusStoryControl('Play story');
  await focusStoryControl('Copy active code');
  await focusStoryControl('Apply active mode');
  await play.click();
  const pause = await focusStoryControl('Pause story');
  await pause.click();
  const resume = await focusStoryControl('Resume story');
  await resume.click();
  await expect(page.locator('[data-demo-story-state]')).toHaveText('complete', { timeout: 8_000 });
  await focusStoryControl('Replay story');

  const activeCode = page.locator('[role="tabpanel"]:not([hidden]) [data-demo-code-region]');
  await activeCode.focus();
  await expect(activeCode).toBeFocused();

  const ruler = page.getByLabel('Proof width');
  await ruler.scrollIntoViewIfNeeded();
  const stage = page.getByRole('region', { name: 'Responsive proof preview' });
  await expect(stage).toHaveAttribute('tabindex', '0');
  await ruler.focus();
  await expect(ruler).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(stage).toBeFocused();

  const marks = ['underline', 'highlight', 'circle', 'box', 'strike', 'bracket'];
  for (const name of marks) {
    const button = page.getByRole('button', { name, exact: true });
    await button.focus();
    await expect(button).toBeFocused();
  }
  const replayMark = page.getByRole('button', { name: 'Replay selected mark' });
  await replayMark.focus();
  await expect(replayMark).toBeFocused();

  await page.getByRole('tab', { name: 'Story' }).click();
  const apply = page.getByRole('button', { name: 'Apply active mode' });
  await apply.click();
  await expect(page.locator('[data-demo-mode-state]')).toBeFocused();
  await expect(page.locator('[data-demo-mode-state]')).toBeInViewport();

  await forceClipboardFailure(page);
  const copy = page.getByRole('button', { name: 'Copy active code' });
  await copy.click();
  const codeFallback = page.locator('[data-demo-code-fallback]');
  await expect(codeFallback).toBeFocused();
  await expect(codeFallback).toBeInViewport();

  const playground = page.locator('#playground');
  await playground.scrollIntoViewIfNeeded();
  const order = [
    playground.getByLabel('Existing phrase'),
    playground.getByLabel('Mark'),
    playground.getByLabel('Optional note'),
    playground.getByLabel('Placement'),
    playground.getByRole('radio', { name: 'Manual' }),
    playground.getByRole('radio', { name: 'Imperative JavaScript' }),
    playground.getByRole('button', { name: 'Run definition' }),
    playground.getByRole('button', { name: 'Copy definition' }),
    playground.locator('.demo-playground__output pre'),
  ];
  await order[0].focus();
  for (let index = 0; index < order.length; index += 1) {
    await expect(order[index]).toBeFocused();
    if (index < order.length - 1) await page.keyboard.press('Tab');
  }

  await playground.getByLabel('Existing phrase').selectOption('');
  await playground.getByRole('button', { name: 'Run definition' }).click();
  await expect(playground.getByLabel('Existing phrase')).toBeFocused();
  await expect(playground.getByLabel('Existing phrase')).toBeInViewport();
});
