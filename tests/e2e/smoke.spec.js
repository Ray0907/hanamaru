import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/scan.html');
});

test('standalone scan rejects a native ShadowRoot in every browser engine', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = await import('/dist/hanamaru.esm.js');
    const host = document.body.appendChild(document.createElement('div'));
    const closedHost = document.body.appendChild(document.createElement('div'));
    const frame = document.body.appendChild(document.createElement('iframe'));
    const frameHost = frame.contentDocument.body.appendChild(
      frame.contentDocument.createElement('div'),
    );
    const roots = [
      host.attachShadow({ mode: 'open' }),
      closedHost.attachShadow({ mode: 'closed' }),
      frameHost.attachShadow({ mode: 'open' }),
    ];
    const failures = [];
    for (const root of roots) {
      try {
        api.scan(root);
      } catch (error) {
        failures.push({
          typed: error instanceof api.HanamaruTargetError,
          code: error.code,
        });
      }
    }
    const output = {
      failures,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      owned: document.querySelectorAll('[data-hana-id]').length,
    };
    frame.remove();
    closedHost.remove();
    host.remove();
    return output;
  });

  expect(result).toEqual({
    failures: [
      {
        typed: true,
        code: 'HANA_TARGET_SHADOW_UNSCOPED',
      },
      {
        typed: true,
        code: 'HANA_TARGET_SHADOW_UNSCOPED',
      },
      {
        typed: true,
        code: 'HANA_TARGET_SHADOW_UNSCOPED',
      },
    ],
    overlays: 0,
    owned: 0,
  });
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

test('scan rolls real DOM resources back when later user code throws', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = await import('/dist/hanamaru.esm.js');
    const activeListeners = [];
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function patchedAdd(type, listener, options) {
      if (type === 'resize' || type === 'scroll') {
        activeListeners.push({ target: this, type, listener, removed: false });
      }
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function patchedRemove(type, listener, options) {
      const record = activeListeners.find((item) => (
        !item.removed && item.target === this && item.type === type && item.listener === listener
      ));
      if (record) record.removed = true;
      return remove.call(this, type, listener, options);
    };

    const target = document.createElement('span');
    target.id = 'rollback-target';
    target.textContent = 'Rollback target';
    target.setAttribute('aria-describedby', 'author-token');
    target.setAttribute('data-hana', 'circle');
    target.setAttribute('data-hana-note', 'Must be removed');
    target.setAttribute('data-hana-accessible', '');
    document.body.append(target);
    const programmerError = new TypeError('later dataset failed');
    const broken = {};
    Object.defineProperty(broken, 'dataset', {
      get() { throw programmerError; },
    });
    let sameError = false;
    try {
      api.scan({ querySelectorAll() { return [target, broken]; } });
    } catch (error) {
      sameError = error === programmerError;
    }
    const output = {
      sameError,
      overlayCount: document.querySelectorAll('[data-hana-overlay]').length,
      ownedCount: document.querySelectorAll('[data-hana-id]').length,
      describedBy: target.getAttribute('aria-describedby'),
      liveListeners: activeListeners.filter((item) => !item.removed)
        .map((item) => item.type),
    };
    EventTarget.prototype.addEventListener = add;
    EventTarget.prototype.removeEventListener = remove;
    target.remove();
    return output;
  });

  expect(result).toEqual({
    sameError: true,
    overlayCount: 0,
    ownedCount: 0,
    describedBy: 'author-token',
    liveListeners: [],
  });
});

test('duration above the signed timeout limit stays pending and hide aborts cleanly', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/dist/hanamaru.esm.js');
    const target = document.querySelector('#element-target');
    const controller = annotate(target, {
      mark: 'underline',
      duration: 2_147_483_648,
      motion: 'system',
    });
    controller.show();
    const finished = controller.finished;
    let settlement = 'pending';
    finished.then(
      () => { settlement = 'resolved'; },
      (error) => { settlement = error.name; },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const beforeHide = { state: controller.state, settlement };
    controller.hide();
    try { await finished; } catch { /* The assertion reads the preserved AbortError name. */ }
    const afterHide = { state: controller.state, settlement };
    controller.destroy();
    return {
      beforeHide,
      afterHide,
      afterDestroy: {
        state: controller.state,
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
        owned: document.querySelectorAll('[data-hana-id]').length,
      },
    };
  });

  expect(result).toEqual({
    beforeHide: { state: 'showing', settlement: 'pending' },
    afterHide: { state: 'hidden', settlement: 'AbortError' },
    afterDestroy: { state: 'destroyed', overlays: 0, owned: 0 },
  });
});
