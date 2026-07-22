import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/story.html');
});

async function installManualStory(page, overrides = {}) {
  await page.evaluate(async (options) => {
    const { story } = await import('/src/story.js');
    const first = document.querySelector('#story-first');
    const events = [];
    let controller;
    for (const type of ['hana:start', 'hana:step', 'hana:pause', 'hana:complete', 'hana:cancel', 'hana:error']) {
      document.body.addEventListener(type, (event) => {
        if (event.detail.controller !== controller) return;
        events.push({
          type,
          target: event.target.id,
          bubbles: event.bubbles,
          composed: event.composed,
          state: event.detail.state,
          index: event.detail.index,
          total: event.detail.total,
          annotation: event.detail.annotation ? true : undefined,
          reason: event.detail.reason,
          error: event.detail.error?.code,
        });
      });
    }
    controller = story([
      { target: first, mark: 'underline' },
      { target: '#story-second', mark: 'circle', note: 'Second note' },
    ], {
      gap: options.gap ?? 20,
      motion: options.motion ?? 'system',
    });
    window.storyController = controller;
    window.storyEvents = events;
    for (const method of ['play', 'pause', 'resume', 'cancel', 'replay', 'destroy']) {
      document.querySelector(`#${method}`).addEventListener('click', () => controller[method]());
    }
  }, overrides);
}

test('manual story uses real controls, exact events, sequential marks, and final cleanup', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installManualStory(page, { gap: 20 });

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.waitForTimeout(750);
  expect(await page.evaluate(() => ({
    state: window.storyController.state,
    groups: document.querySelectorAll('.hana-annotation:not([hidden])').length,
    notes: document.querySelectorAll('.hana-note:not(.hana-is-hidden)').length,
  }))).toEqual({ state: 'paused', groups: 1, notes: 0 });

  await page.getByRole('button', { name: 'Resume' }).click();
  await page.waitForFunction(() => window.storyController.state === 'complete');
  expect(await page.evaluate(() => ({
    groups: document.querySelectorAll('.hana-annotation:not([hidden])').length,
    notes: document.querySelectorAll('.hana-note:not(.hana-is-hidden)').length,
  }))).toEqual({ groups: 2, notes: 1 });

  await page.getByRole('button', { name: 'Replay' }).click();
  await page.waitForFunction(() => window.storyController.state === 'playing');
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate(() => window.storyController.state)).toBe('cancelled');

  await page.getByRole('button', { name: 'Replay' }).click();
  await page.waitForFunction(() => window.storyController.state === 'complete');
  const output = await page.evaluate(() => ({
    events: window.storyEvents,
    state: window.storyController.state,
    groups: document.querySelectorAll('.hana-annotation:not([hidden])').length,
    owned: document.querySelectorAll('[data-hana-id]').length,
    overlays: document.querySelectorAll('[data-hana-overlay]').length,
  }));

  expect(output.events.map(({ type }) => type)).toEqual([
    'hana:start', 'hana:step', 'hana:pause', 'hana:step', 'hana:complete',
    'hana:start', 'hana:step', 'hana:cancel',
    'hana:start', 'hana:step', 'hana:step', 'hana:complete',
  ]);
  for (const event of output.events) {
    expect(event).toMatchObject({ target: 'story-first', bubbles: true, composed: true });
  }
  expect(output.events.filter(({ type }) => type === 'hana:start')
    .map(({ state }) => state)).toEqual(['playing', 'playing', 'playing']);
  expect(output.events.filter(({ type }) => type === 'hana:step')
    .map(({ index, total, annotation }) => ({ index, total, annotation }))).toEqual([
      { index: 0, total: 2, annotation: true },
      { index: 1, total: 2, annotation: true },
      { index: 0, total: 2, annotation: true },
      { index: 0, total: 2, annotation: true },
      { index: 1, total: 2, annotation: true },
    ]);
  expect(output.events.filter(({ type }) => type === 'hana:pause')
    .map(({ index }) => index)).toEqual([0]);
  expect(output.events.filter(({ type }) => type === 'hana:complete')
    .map(({ state }) => state)).toEqual(['complete', 'complete']);
  expect(output.events.filter(({ type }) => type === 'hana:cancel')
    .map(({ reason }) => reason)).toEqual(['cancel']);
  expect(output).toMatchObject({ state: 'complete', groups: 2, overlays: 1 });
  expect(output.owned).toBeGreaterThanOrEqual(3);

  await page.getByRole('button', { name: 'Destroy' }).click();
  expect(await page.evaluate(() => ({
    state: window.storyController.state,
    owned: document.querySelectorAll('[data-hana-id]').length,
    overlays: document.querySelectorAll('[data-hana-overlay]').length,
  }))).toEqual({ state: 'destroyed', owned: 0, overlays: 0 });
});

test('story preflights all browser targets before mounting', async ({ page }) => {
  const output = await page.evaluate(async () => {
    const { story } = await import('/src/story.js');
    let code;
    try {
      story([
        { target: '#story-first', mark: 'underline' },
        { target: '#missing-story-target', mark: 'box' },
      ]);
    } catch (error) {
      code = error.code;
    }
    return {
      code,
      owned: document.querySelectorAll('[data-hana-id]').length,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    };
  });
  expect(output).toEqual({ code: 'HANA_TARGET_MISSING', owned: 0, overlays: 0 });
});

test('story target and renderer failures retain completed marks and remove pending marks', async ({ page }) => {
  const output = await page.evaluate(async () => {
    const { story } = await import('/src/story.js');

    async function fail(kind) {
      const first = document.querySelector('#story-first');
      const second = document.querySelector('#story-second');
      const errors = [];
      let controller;
      first.addEventListener('hana:error', (event) => {
        if (event.detail.controller === controller) {
          errors.push([event.detail.error.code, event.detail.index]);
        }
      });
      controller = story([
        { target: first, mark: 'underline' },
        { target: second, mark: 'circle' },
      ], { gap: 25, motion: 'never' });
      controller.play();
      if (kind === 'target') second.remove();
      else second.getBoundingClientRect = () => { throw new Error('renderer read failed'); };
      await new Promise((resolve) => setTimeout(resolve, 50));
      const rejected = await controller.finished.then(
        () => null,
        (error) => error.code,
      );
      const result = {
        state: controller.state,
        rejected,
        errors,
        visible: document.querySelectorAll('.hana-annotation:not([hidden])').length,
      };
      controller.destroy();
      const replacement = document.createElement('p');
      replacement.id = 'story-second';
      replacement.className = 'target';
      replacement.textContent = 'Second story target';
      document.querySelector('#story-arena').append(replacement);
      return result;
    }

    const target = await fail('target');
    const renderer = await fail('renderer');
    return {
      target,
      renderer,
      finalOwned: document.querySelectorAll('[data-hana-id]').length,
      finalOverlays: document.querySelectorAll('[data-hana-overlay]').length,
    };
  });

  expect(output).toEqual({
    target: {
      state: 'cancelled', rejected: 'HANA_TARGET_INVALID',
      errors: [['HANA_TARGET_INVALID', 1]], visible: 1,
    },
    renderer: {
      state: 'cancelled', rejected: 'HANA_STATE_RUNTIME',
      errors: [['HANA_STATE_RUNTIME', 1]], visible: 1,
    },
    finalOwned: 0,
    finalOverlays: 0,
  });
});
