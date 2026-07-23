import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const localStarter = `<link rel="stylesheet" href="./dist/hanamaru.css">
<script type="module">
  import { scan } from './dist/hanamaru.esm.js'
  scan()
</script>`;

async function seriousOrCritical(page, include) {
  const builder = new AxeBuilder({ page });
  if (include) builder.include(include);
  const results = await builder.analyze();
  return results.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
}

test('proves a selector-scoped text story without touching the authored prose', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const sheet = page.locator('[data-demo-proof-sheet]');
  const tray = page.locator('[data-demo-story-tray]');
  await expect(sheet).toBeVisible();
  await expect(tray).toBeVisible();
  const [sheetBox, trayBox, trayStyle] = await Promise.all([
    sheet.boundingBox(),
    tray.boundingBox(),
    tray.evaluate((node) => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, shadow: style.boxShadow };
    }),
  ]);
  expect(sheetBox.width).toBeGreaterThan(trayBox.width);
  expect(trayBox.y + trayBox.height).toBeLessThanOrEqual(900);
  expect(trayStyle.background).toBe('rgb(38, 62, 112)');
  expect(trayStyle.shadow).toContain('inset');

  const source = page.locator('#locator-proof');
  const before = await source.innerHTML();
  await expect(source).toContainText('follow the phrase it explains');
  await expect(page.locator('[data-demo-story-config]')).toContainText("within: '#locator-proof'");
  await expect(page.locator('[data-demo-story-config]')).toContainText("text: 'follow the phrase it explains'");
  await expect(page.locator('[data-demo-story-state]')).toHaveText('idle');
  await expect(page.locator('.hana-annotation:not([hidden])')).toHaveCount(0);

  const phases = await page.evaluate(() => {
    window.__demoPhases = [];
    const observer = new MutationObserver(() => {
      const current = document.querySelector('[data-demo-sequence-stage][aria-current="step"]');
      if (current && window.__demoPhases.at(-1) !== current.dataset.demoSequenceStage) {
        window.__demoPhases.push(current.dataset.demoSequenceStage);
      }
    });
    observer.observe(document.querySelector('[data-demo-sequence]'), {
      attributes: true,
      attributeFilter: ['aria-current'],
      subtree: true,
    });
    window.__demoPhaseObserver = observer;
    return window.__demoPhases;
  });
  expect(phases).toEqual([]);

  await page.getByRole('button', { name: 'Play story', exact: true }).click();
  await expect(page.locator('[data-demo-story-state]')).toHaveText('playing');
  const currentStep = page.locator('[role="tabpanel"]:not([hidden]) [data-demo-code-step][aria-current="step"]');
  await expect(currentStep).toHaveCount(1);
  await expect(currentStep.locator('[data-demo-step-marker]')).toContainText('→');
  expect(await currentStep.evaluate((node) => getComputedStyle(node).backgroundColor))
    .toBe('rgb(244, 207, 63)');

  await expect(page.locator('.hana-annotation:not([hidden])')).not.toHaveCount(0);
  await expect(page.locator('.hana-note:not(.hana-is-hidden)')).not.toHaveCount(0);
  await expect(page.locator('.hana-connector-path')).not.toHaveCount(0);
  expect(await seriousOrCritical(page, '#proof')).toEqual([]);
  await expect(page.locator('[data-demo-story-state]')).toHaveText('complete', { timeout: 8_000 });
  await expect(page.locator('[data-demo-completion]')).toContainText('2 of 2 accepted');
  await expect(page.locator('[data-demo-completion]')).toContainText('complete');
  expect(await source.innerHTML()).toBe(before);
  await expect(source.locator('.hana-note, .hana-annotation, [data-hana-id]')).toHaveCount(0);

  const sequence = await page.evaluate(() => {
    window.__demoPhaseObserver.disconnect();
    return window.__demoPhases;
  });
  expect(sequence).toEqual(expect.arrayContaining(['code', 'mark', 'connector', 'note', 'advance']));
  expect(await seriousOrCritical(page, '#proof')).toEqual([]);
});

test('mobile story suppresses offscreen target output without changing its completed run', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.evaluate(() => {
    window.__demoStoryStarts = 0;
    document.querySelector('#locator-proof').addEventListener('hana:start', (event) => {
      if (typeof event.detail.controller?.play === 'function') window.__demoStoryStarts += 1;
    });
  });
  const proof = page.locator('#locator-proof');
  const tray = page.locator('[data-demo-story-tray]');
  const play = page.getByRole('button', { name: 'Play story', exact: true });
  const state = page.locator('[data-demo-story-state]');
  const run = page.locator('[data-demo-story-run]');
  const storyNotes = page.locator('.hana-note:not(.hana-is-hidden)', {
    hasText: /Still attached|Measured again/,
  });

  await play.scrollIntoViewIfNeeded();
  await expect.poll(() => proof.evaluate((node) => node.getBoundingClientRect().bottom <= 0)).toBe(true);
  await expect(tray).toBeInViewport();
  await play.click();
  await expect(state).toHaveText('complete', { timeout: 8_000 });
  const completedRun = await run.textContent();
  expect(await page.evaluate(() => window.__demoStoryStarts)).toBe(1);
  await expect(storyNotes).toHaveCount(0);
  await expect(page.locator('.hana-annotation:not([hidden])')).toHaveCount(0);

  await proof.scrollIntoViewIfNeeded();
  await expect(state).toHaveText('complete');
  await expect(run).toHaveText(completedRun);
  expect(await page.evaluate(() => window.__demoStoryStarts)).toBe(1);
  await expect(storyNotes).toHaveCount(2);
  await expect(page.locator('.hana-annotation:not([hidden])')).toHaveCount(2);

  const mobileProofLayout = await page.evaluate(() => {
    const prose = document.querySelector('#locator-proof');
    const lineRects = [];
    const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0) {
          lineRects.push({
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            top: rect.top,
          });
        }
      }
    }
    const notes = [...document.querySelectorAll('.hana-note:not(.hana-is-hidden)')]
      .filter((node) => /Still attached|Measured again/.test(node.textContent))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          text: node.textContent.trim(),
          top: rect.top,
        };
      });
    const intersects = (a, b) => a.left < b.right && a.right > b.left
      && a.top < b.bottom && a.bottom > b.top;
    return {
      collisions: notes.flatMap((note) => lineRects
        .filter((line) => intersects(note, line))
        .map((line) => ({ line, note }))),
      notes,
      overflowingStages: [...document.querySelectorAll('[data-demo-sequence-stage]')]
        .filter((node) => node.scrollWidth > node.clientWidth + 1)
        .map((node) => node.dataset.demoSequenceStage),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(mobileProofLayout.notes).toHaveLength(2);
  expect(mobileProofLayout.collisions).toEqual([]);
  expect(mobileProofLayout.overflowingStages).toEqual([]);
  expect(mobileProofLayout.pageOverflow).toBeLessThanOrEqual(0);

  await play.scrollIntoViewIfNeeded();
  await expect(storyNotes).toHaveCount(0);
  await expect(state).toHaveText('complete');
  await expect(run).toHaveText(completedRun);
});

test('playback controls pause, resume, complete, and replay the same real story', async ({ page }) => {
  await page.goto('/');
  const play = page.getByRole('button', { name: 'Play story', exact: true });
  const pause = page.getByRole('button', { name: 'Pause story' });
  const resume = page.getByRole('button', { name: 'Resume story' });
  const replay = page.getByRole('button', { name: 'Replay story' });

  await expect(play).toBeEnabled();
  await expect(pause).toBeDisabled();
  await expect(resume).toBeDisabled();
  await expect(replay).toBeDisabled();
  await play.click();
  await expect(page.locator('[data-demo-story-state]')).toHaveText('playing');
  await expect(play).toBeDisabled();
  await expect(pause).toBeEnabled();
  await pause.click();
  await expect(page.locator('[data-demo-story-state]')).toHaveText('paused');
  await expect(resume).toBeEnabled();
  expect(await seriousOrCritical(page, '#proof')).toEqual([]);
  await page.waitForTimeout(250);
  await expect(page.locator('[data-demo-story-state]')).toHaveText('paused');
  await resume.click();
  await expect(page.locator('[data-demo-story-state]')).toHaveText('playing');
  await expect(page.locator('[data-demo-story-state]')).toHaveText('complete', { timeout: 8_000 });
  await expect(replay).toBeEnabled();

  const firstRun = await page.locator('[data-demo-story-run]').textContent();
  await replay.click();
  await expect(page.locator('[data-demo-story-state]')).toHaveText('playing');
  await expect(page.locator('[data-demo-story-run]')).not.toHaveText(firstRun);
  await expect(page.locator('[data-demo-story-step]')).toContainText('1 / 2');
  await expect(page.locator('[data-demo-story-state]')).toHaveText('complete', { timeout: 8_000 });
  await expect(page.locator('.hana-annotation:not([hidden])')).toHaveCount(2);
});

test('phase sampling stops while paused and restarts only when the story resumes', async ({ page }) => {
  await page.addInitScript(() => {
    window.__demoAnimationReads = 0;
    const getAnimations = document.getAnimations.bind(document);
    Object.defineProperty(document, 'getAnimations', {
      configurable: true,
      value() {
        window.__demoAnimationReads += 1;
        return getAnimations();
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Play story', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__demoAnimationReads))
    .toBeGreaterThan(2);

  await page.getByRole('button', { name: 'Pause story' }).click();
  await expect(page.locator('[data-demo-story-state]')).toHaveText('paused');
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const readsAtPause = await page.evaluate(() => window.__demoAnimationReads);
  await page.waitForTimeout(180);
  expect(await page.evaluate(() => window.__demoAnimationReads)).toBe(readsAtPause);

  await page.getByRole('button', { name: 'Resume story' }).click();
  await expect.poll(() => page.evaluate(() => window.__demoAnimationReads))
    .toBeGreaterThan(readsAtPause);
  await expect(page.locator('[data-demo-story-state]')).toHaveText('complete', { timeout: 8_000 });
});

test('persisted page lifecycle keeps controllers live while final pagehide cleans resources', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-hana-overlay]')).toHaveCount(1);

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(page.locator('[data-hana-overlay]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Play story', exact: true }).click();
  await expect(page.locator('[data-demo-story-state]')).toHaveText('complete', { timeout: 8_000 });
  await expect(page.locator('.hana-annotation:not([hidden])')).toHaveCount(2);

  await page.getByRole('button', { name: 'Show native Range proof' }).click();
  await expect(page.locator('.hana-annotation[data-hana-mark="box"]:not([hidden])')).toHaveCount(1);

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
  });
  await expect(page.locator('[data-hana-overlay]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Replay story' }).click();
  await expect(page.locator('[data-demo-story-state]')).toHaveText('destroyed');
});

test('native tabs select, wrap, and move focus with the standard keyboard model', async ({ page }) => {
  await page.goto('/');
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(3);
  await expect(page.getByRole('tab', { name: 'Story' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Story' })).toHaveAttribute('tabindex', '0');
  await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await expect(page.getByRole('tabpanel', { name: 'Story' })).toBeVisible();

  const json = page.getByRole('tab', { name: 'JSON' });
  await json.click();
  await expect(json).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'JSON' })).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'Story' })).toBeHidden();

  await json.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'HTML' })).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'HTML' })).toBeVisible();
  await page.getByRole('tab', { name: 'HTML' }).press('ArrowLeft');
  await expect(json).toBeFocused();
  await json.press('Home');
  await expect(page.getByRole('tab', { name: 'HTML' })).toBeFocused();
  await page.getByRole('tab', { name: 'HTML' }).press('End');
  await expect(json).toBeFocused();
  await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
});

test('copies the active source and exact local starter through the Clipboard API', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value) {
          window.__demoCopies ??= [];
          window.__demoCopies.push(value);
          return Promise.resolve();
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'JSON' }).click();
  const activeCode = await page.getByRole('tabpanel', { name: 'JSON' })
    .locator('[data-demo-code-fragment]')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent).join('\n'));
  await page.getByRole('button', { name: 'Copy active code' }).click();
  await expect(page.getByRole('status')).toHaveText('JSON code copied.');
  await page.getByRole('button', { name: 'Copy local starter' }).click();
  await expect(page.getByRole('status')).toHaveText('Local starter copied.');
  expect(await page.evaluate(() => window.__demoCopies)).toEqual([activeCode, localStarter]);
});

test('clipboard rejection retains context and selects exact readonly fallbacks', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException('blocked', 'NotAllowedError')) },
    });
  });
  await page.goto('/');
  const storyPanel = page.getByRole('tabpanel', { name: 'Story' });
  const activeCode = await storyPanel.locator('[data-demo-code-fragment]')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent).join('\n'));

  await page.getByRole('button', { name: 'Copy active code' }).click();
  const codeFallback = page.locator('[data-demo-code-fallback]');
  await expect(page.locator('[data-demo-code-fallback-wrap]')).toContainText('Clipboard blocked');
  await expect(codeFallback).toBeVisible();
  await expect(codeFallback).toBeFocused();
  await expect(codeFallback).toHaveValue(activeCode);
  expect(await codeFallback.evaluate((field) => [field.readOnly, field.selectionStart, field.selectionEnd]))
    .toEqual([true, 0, activeCode.length]);
  await expect(page.getByRole('status')).toHaveText('Copy blocked. Story code selected.');

  await page.getByRole('button', { name: 'Copy local starter' }).click();
  const starterFallback = page.locator('[data-demo-copy-fallback]');
  await expect(page.locator('[data-demo-starter-fallback-wrap]')).toContainText('Clipboard blocked');
  await expect(starterFallback).toBeFocused();
  await expect(starterFallback).toHaveValue(localStarter);
  expect(await starterFallback.evaluate((field) => [field.readOnly, field.selectionStart, field.selectionEnd]))
    .toEqual([true, 0, localStarter.length]);
  await expect(page.getByRole('status')).toHaveText('Copy blocked. Local starter selected.');
  expect(await seriousOrCritical(page)).toEqual([]);
});

test('the primary correction stamp scrolls and moves focus to the playground', async ({ page }) => {
  await page.goto('/');
  const primary = page.getByRole('link', { name: 'Open Live Playground' });
  await primary.click();
  await expect(page).toHaveURL(/#playground$/);
  await expect(page.locator('#playground')).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test('constructs a native Range and atomically replaces its visible target', async ({ page, request }) => {
  await page.goto('/');
  const source = await (await request.get('/demo/demo.js')).text();
  expect(source).toContain('document.createRange()');
  expect(source).toContain('update({ target: nextRange })');

  const control = page.locator('[data-demo-range-action]');
  await expect(control).toHaveAccessibleName('Show native Range proof');
  await control.click();
  const path = page.locator('.hana-annotation[data-hana-mark="box"] .hana-mark-path').first();
  await expect(path).toBeVisible();
  const firstPath = await path.getAttribute('d');
  await expect(page.locator('[data-demo-range-state]')).toContainText('first phrase');
  await expect(control).toHaveAccessibleName('Move native Range target');

  await control.click();
  await expect(page.locator('[data-demo-range-state]')).toContainText('second phrase');
  await expect(path).not.toHaveAttribute('d', firstPath);
  await expect(control).toHaveAccessibleName('Reset native Range target');
  await expect(page.locator('.hana-annotation[data-hana-mark="box"]:not([hidden])')).toHaveCount(1);
});

test('keeps Task 21 controls contained and accessible on a 390px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('[data-demo-story-tray]')).toBeVisible();
  expect(await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
  }))).toEqual({ viewport: 390, page: 390 });
  for (const control of await page.locator('[data-demo-story-controls] button, [role="tab"]').all()) {
    const box = await control.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(await seriousOrCritical(page, '#proof')).toEqual([]);
});
