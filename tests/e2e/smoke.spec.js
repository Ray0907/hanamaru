import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/scan.html');
});

test('ESM and IIFE require explicit scan and isolate invalid siblings', async ({ page }) => {
  const esm = await page.evaluate(async () => {
    const api = await import('/dist/hanamaru.esm.js');
    const before = document.querySelectorAll('[data-hana-id]').length;
    const result = api.scan(document.querySelector('#esm-scan'));
    const snapshot = {
      exports: Object.keys(api).sort(),
      before,
      annotationCount: result.annotations.length,
      states: result.annotations.map((controller) => controller.state),
      errors: result.errors.map((error) => ({
        typed: error instanceof api.HanamaruError,
        config: error instanceof api.HanamaruConfigError,
        code: error.code,
        field: error.details?.field,
      })),
      ownedAfterScan: document.querySelectorAll('[data-hana-id]').length,
    };
    for (const controller of result.annotations) {
      controller.show();
      await controller.finished;
    }
    snapshot.visibleStates = result.annotations.map((controller) => controller.state);
    snapshot.afterAccessible = document.querySelector('#esm-after')
      .hasAttribute('aria-describedby');
    for (const controller of result.annotations) controller.destroy();
    snapshot.afterDestroy = {
      states: result.annotations.map((controller) => controller.state),
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      owned: document.querySelectorAll('[data-hana-id]').length,
    };
    return snapshot;
  });

  expect(esm).toEqual({
    exports: [
      'HanamaruConfigError',
      'HanamaruError',
      'HanamaruStateError',
      'HanamaruTargetError',
      'VERSION',
      'annotate',
      'scan',
      'story',
    ],
    before: 0,
    annotationCount: 2,
    states: ['idle', 'idle'],
    errors: [
      { typed: true, config: true, code: 'HANA_CONFIG_INVALID', field: 'mark' },
      { typed: true, config: true, code: 'HANA_CONFIG_INVALID', field: 'duration' },
    ],
    ownedAfterScan: 3,
    visibleStates: ['visible', 'visible'],
    afterAccessible: true,
    afterDestroy: { states: ['destroyed', 'destroyed'], overlays: 0, owned: 0 },
  });

  await page.addScriptTag({ url: '/dist/hanamaru.iife.js' });
  const iife = await page.evaluate(async () => {
    const before = document.querySelectorAll('[data-hana-id]').length;
    const result = window.Hanamaru.scan(document.querySelector('#iife-scan'));
    const controller = result.annotations[0];
    controller.show();
    await controller.finished;
    const output = {
      exports: Object.keys(window.Hanamaru).sort(),
      before,
      count: result.annotations.length,
      errors: result.errors.length,
      state: controller.state,
    };
    controller.destroy();
    output.afterDestroy = {
      state: controller.state,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    };
    return output;
  });

  expect(iife).toEqual({
    exports: [
      'HanamaruConfigError',
      'HanamaruError',
      'HanamaruStateError',
      'HanamaruTargetError',
      'VERSION',
      'annotate',
      'scan',
      'story',
    ],
    before: 0,
    count: 1,
    errors: 0,
    state: 'visible',
    afterDestroy: { state: 'destroyed', overlays: 0 },
  });
});

test('public ESM annotations complete for Element and text locator targets', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = await import('/dist/hanamaru.esm.js');
    const element = document.querySelector('#element-target');
    const events = [];
    document.body.addEventListener('hana:start', (event) => events.push([
      'start', event.target.id,
    ]));
    document.body.addEventListener('hana:complete', (event) => events.push([
      'complete', event.target.id,
    ]));
    const controllers = [
      api.annotate(element, { mark: 'box', motion: 'never' }),
      api.annotate({ within: '#locator-scope', text: 'exact locator phrase' }, {
        mark: 'highlight', note: 'Text locator', motion: 'never',
      }),
    ];
    for (const controller of controllers) {
      controller.show();
      await controller.finished;
    }
    const visible = {
      states: controllers.map((controller) => controller.state),
      events,
      marks: [...document.querySelectorAll('.hana-annotation')]
        .map((node) => node.getAttribute('data-hana-mark')),
      notes: [...document.querySelectorAll('.hana-note')]
        .map((node) => node.textContent),
    };
    for (const controller of controllers) controller.destroy();
    return {
      visible,
      destroyed: controllers.map((controller) => controller.state),
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      owned: document.querySelectorAll('[data-hana-id]').length,
    };
  });

  expect(result).toEqual({
    visible: {
      states: ['visible', 'visible'],
      events: [
        ['start', 'element-target'],
        ['complete', 'element-target'],
        ['start', 'locator-scope'],
        ['complete', 'locator-scope'],
      ],
      marks: ['box', 'highlight'],
      notes: ['Text locator'],
    },
    destroyed: ['destroyed', 'destroyed'],
    overlays: 0,
    owned: 0,
  });
});
