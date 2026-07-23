import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/group.html');
});

test('group constructs and completes in the top document and an iframe document', async ({ page }) => {
  const output = await page.evaluate(async () => {
    const { group } = await import('/src/group.js');
    const top = group([
      { target: '#group-first', mark: 'underline' },
      { target: '#group-second', mark: 'circle' },
    ], { motion: 'never' });
    top.show();
    await top.finished;

    const frame = document.createElement('iframe');
    frame.srcdoc = `<!doctype html><html><body>
      <p id="frame-first" style="display:inline-block">Frame first</p>
      <p id="frame-second" style="display:inline-block">Frame second</p>
    </body></html>`;
    document.body.append(frame);
    await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    const frameDocument = frame.contentDocument;
    const inside = group([
      { target: '#frame-first', mark: 'highlight' },
      { target: '#frame-second', mark: 'box' },
    ], { motion: 'never' }, { root: frameDocument });
    inside.show();
    await inside.finished;

    const result = {
      topState: top.state,
      topMarks: document.querySelectorAll('.hana-annotation:not([hidden])').length,
      frameState: inside.state,
      frameMarks: frameDocument.querySelectorAll('.hana-annotation:not([hidden])').length,
      frameOverlays: frameDocument.querySelectorAll('[data-hana-overlay]').length,
    };
    top.destroy();
    inside.destroy();
    return result;
  });

  expect(output).toEqual({
    topState: 'visible',
    topMarks: 2,
    frameState: 'visible',
    frameMarks: 2,
    frameOverlays: 1,
  });
});

test('live target loss after completion suspends once and hides every member', async ({ page }) => {
  await page.evaluate(async () => {
    const { group } = await import('/src/group.js');
    const errors = [];
    let controller;
    document.body.addEventListener('hana:error', (event) => {
      if (event.detail.controller !== controller) return;
      errors.push({
        code: event.detail.error.code,
        index: event.detail.index,
        memberCode: event.detail.error.details?.error?.code,
      });
    });
    controller = group([
      { target: '#group-first', mark: 'underline' },
      { target: '#group-second', mark: 'circle' },
    ], { motion: 'never' });
    controller.show();
    await controller.finished;
    window.groupController = controller;
    window.groupErrors = errors;
    document.querySelector('#group-second').remove();
  });

  await page.waitForFunction(() => window.groupController.state === 'suspended');
  expect(await page.evaluate(() => ({
    state: window.groupController.state,
    errors: window.groupErrors,
    visibleMarks: document.querySelectorAll('.hana-annotation:not([hidden])').length,
  }))).toEqual({
    state: 'suspended',
    errors: [{
      code: 'HANA_STATE_GROUP_MEMBER',
      index: 1,
      memberCode: 'HANA_TARGET_MISSING',
    }],
    visibleMarks: 0,
  });
});

test('asynchronous member failure during refresh is captured by the refresh coordinator', async ({ page }) => {
  await page.evaluate(async () => {
    const { group } = await import('/src/group.js');
    const errors = [];
    let controller;
    document.body.addEventListener('hana:error', (event) => {
      if (event.detail.controller !== controller) return;
      errors.push({ code: event.detail.error.code, index: event.detail.index });
    });
    controller = group([
      { target: '#group-first', mark: 'underline' },
      { target: '#group-second', mark: 'circle' },
    ], { motion: 'never' });
    controller.show();
    await controller.finished;
    controller.refresh();
    document.querySelector('#group-second').remove();
    window.groupController = controller;
    window.groupErrors = errors;
  });

  await page.waitForFunction(() => window.groupController.state === 'suspended');
  expect(await page.evaluate(() => ({
    state: window.groupController.state,
    errors: window.groupErrors,
    visibleMarks: document.querySelectorAll('.hana-annotation:not([hidden])').length,
  }))).toEqual({
    state: 'suspended',
    errors: [{ code: 'HANA_STATE_GROUP_MEMBER', index: 1 }],
    visibleMarks: 0,
  });
});

test('viewport trigger follows a replacement first selector target before entry', async ({ page }) => {
  await page.evaluate(async () => {
    const { group } = await import('/src/group.js');
    const starts = [];
    let controller;
    document.body.addEventListener('hana:start', (event) => {
      if (event.detail.controller !== controller) return;
      starts.push(event.target.dataset.replacement === 'true');
    });
    controller = group([
      { target: '#viewport-first', mark: 'underline' },
      { target: '#group-second', mark: 'circle' },
    ], { trigger: 'viewport', motion: 'never' });
    const original = document.querySelector('#viewport-first');
    const replacement = document.createElement('p');
    replacement.id = 'viewport-first';
    replacement.className = 'target';
    replacement.dataset.replacement = 'true';
    replacement.textContent = 'Replacement viewport target';
    original.remove();
    document.querySelector('#replacement-slot').append(replacement);
    window.groupController = controller;
    window.groupStarts = starts;
  });

  await page.waitForFunction(() => window.groupController.state === 'visible');
  expect(await page.evaluate(() => ({
    state: window.groupController.state,
    starts: window.groupStarts,
    visibleMarks: document.querySelectorAll('.hana-annotation:not([hidden])').length,
  }))).toEqual({
    state: 'visible',
    starts: [true],
    visibleMarks: 2,
  });
});

test('viewport replacement observer install failure suspends once and cleans the old observer', async ({ page }) => {
  await page.evaluate(async () => {
    class FailingIntersectionObserver {
      static attempts = 0;

      static instances = [];

      constructor() {
        FailingIntersectionObserver.attempts += 1;
        if (FailingIntersectionObserver.attempts === 2) {
          throw new Error('replacement observer install failed');
        }
        this.active = false;
        FailingIntersectionObserver.instances.push(this);
      }

      observe(target) {
        this.target = target;
        this.active = true;
      }

      unobserve(target) {
        if (target === this.target) this.active = false;
      }

      disconnect() {
        this.active = false;
      }
    }

    window.IntersectionObserver = FailingIntersectionObserver;
    const { group } = await import('/src/group.js');
    const errors = [];
    let controller;
    document.body.addEventListener('hana:error', (event) => {
      if (event.detail.controller !== controller) return;
      errors.push({
        code: event.detail.error.code,
        index: event.detail.index,
        cause: event.detail.error.details?.cause?.message,
      });
    });
    controller = group([
      { target: '#viewport-first', mark: 'underline' },
      { target: '#group-second', mark: 'circle' },
    ], { trigger: 'viewport', motion: 'never' });
    const original = document.querySelector('#viewport-first');
    const replacement = document.createElement('p');
    replacement.id = 'viewport-first';
    replacement.className = 'target';
    replacement.textContent = 'Replacement viewport target';
    original.remove();
    document.querySelector('#replacement-slot').append(replacement);
    window.groupController = controller;
    window.groupErrors = errors;
    window.groupIntersectionObserver = FailingIntersectionObserver;
  });

  await page.waitForFunction(() => window.groupController.state === 'suspended');
  expect(await page.evaluate(() => ({
    state: window.groupController.state,
    errors: window.groupErrors,
    attempts: window.groupIntersectionObserver.attempts,
    activeObservers: window.groupIntersectionObserver.instances
      .filter(({ active }) => active).length,
  }))).toEqual({
    state: 'suspended',
    errors: [{
      code: 'HANA_STATE_RUNTIME',
      index: undefined,
      cause: 'replacement observer install failed',
    }],
    attempts: 2,
    activeObservers: 0,
  });
});
