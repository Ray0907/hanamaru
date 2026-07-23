import { expect, test } from '@playwright/test';

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'";

function watchBrowserFailures(page) {
  const failures = [];
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  return failures;
}

async function openPluginFixture(page) {
  const failures = watchBrowserFailures(page);
  const response = await page.goto('/tests/fixtures/plugins.html');
  expect(response?.headers()['content-security-policy']).toBeUndefined();
  await page.evaluate(() => {
    window.__pluginUnhandledRejections = [];
    window.addEventListener('unhandledrejection', (event) => {
      window.__pluginUnhandledRejections.push(String(event.reason?.message ?? event.reason));
    });
  });
  return failures;
}

async function expectNoBrowserFailures(page, failures) {
  await page.evaluate(() => Promise.resolve());
  expect(await page.evaluate(() => window.__pluginUnhandledRejections)).toEqual([]);
  expect(failures).toEqual([]);
}

test('renders deterministic flower paths for Element and Range targets through the owned renderer', async ({ page }) => {
  const failures = await openPluginFixture(page);
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const { registerMark } = await import('/src/plugins.js');
    const controllers = [];
    let unregister = () => {};
    let unregisterReplacement = () => {};
    let contextProof;
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const pathsFor = (id) => {
      const group = document.querySelector(`.hana-annotation[data-hana-id="${id}"]`);
      return group === null
        ? []
        : [...group.querySelectorAll('.hana-mark-path')].map((path) => path.getAttribute('d'));
    };
    try {
      unregister = registerMark('hanamaru', (context) => {
        contextProof = {
          context: Object.isFrozen(context),
          helpers: Object.isFrozen(context.helpers),
          rect: Object.isFrozen(context.rects[0]),
          rects: Object.isFrozen(context.rects),
          unionRect: Object.isFrozen(context.unionRect),
        };
        const { unionRect, helpers } = context;
        const center = {
          x: unionRect.left + (unionRect.width / 2),
          y: unionRect.top + (unionRect.height / 2),
        };
        const radiusX = Math.max(4, unionRect.width / 5);
        const radiusY = Math.max(4, unionRect.height / 2);
        const petals = [
          [
            center,
            { x: center.x - radiusX, y: center.y - radiusY },
            { x: center.x, y: center.y - radiusY },
          ],
          [
            center,
            { x: center.x + radiusX, y: center.y - radiusY },
            { x: center.x + radiusX, y: center.y },
          ],
          [
            center,
            { x: center.x + radiusX, y: center.y + radiusY },
            { x: center.x, y: center.y + radiusY },
          ],
          [
            center,
            { x: center.x - radiusX, y: center.y + radiusY },
            { x: center.x - radiusX, y: center.y },
          ],
        ];
        return {
          paths: petals.map((points, index) => (
            helpers.closedPath(points, { label: `petal-${index}`, wobble: 0.35 })
          )),
        };
      });

      const element = document.querySelector('#element-target');
      const rangeOwner = document.querySelector('#range-target');
      const range = document.createRange();
      range.selectNodeContents(rangeOwner);
      const elementController = annotate(element, {
        mark: 'hanamaru', seed: 'flower-seed', duration: 120,
      });
      const rangeController = annotate(range, {
        mark: 'hanamaru', seed: 'range-seed', motion: 'never',
      });
      controllers.push(elementController, rangeController);
      elementController.show();
      rangeController.show();
      await nextFrame();
      const groups = [...document.querySelectorAll('.hana-annotation')];
      const elementId = groups[0].getAttribute('data-hana-id');
      const rangeId = groups[1].getAttribute('data-hana-id');
      const immediate = {
        animationCount: groups[0].getAnimations({ subtree: true }).length,
        customClassTokens: [
          ...document.querySelectorAll(
            '[data-hana-svg-layer], [data-hana-svg-layer] .hana-annotation,'
            + ' [data-hana-svg-layer] .hana-annotation *',
          ),
        ].flatMap((node) => [...node.classList])
          .filter((token) => token.includes('hanamaru') || token.includes('plugin')),
        elementClasses: [...groups[0].querySelectorAll('path')]
          .map((path) => path.getAttribute('class')),
        elementPaths: pathsFor(elementId),
        frozenContext: contextProof,
        groupClasses: groups.map((group) => group.getAttribute('class')),
        groups: groups.length,
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
        rangeClasses: [...groups[1].querySelectorAll('path')]
          .map((path) => path.getAttribute('class')),
        rangePaths: pathsFor(rangeId),
        svgLayers: document.querySelectorAll('[data-hana-svg-layer]').length,
      };
      await Promise.all([elementController.finished, rangeController.finished]);

      const stable = pathsFor(elementId);
      elementController.replay();
      await elementController.finished;
      const replayed = pathsFor(elementId);
      elementController.refresh();
      await nextFrame();
      const refreshed = pathsFor(elementId);

      const originalText = element.textContent;
      element.textContent = `${originalText} with actual wider reflow`;
      element.getBoundingClientRect();
      elementController.refresh();
      await nextFrame();
      const changed = pathsFor(elementId);
      element.textContent = originalText;
      element.getBoundingClientRect();
      elementController.refresh();
      await nextFrame();
      const restored = pathsFor(elementId);

      unregister();
      elementController.update({ duration: 0 });
      await nextFrame();
      const implicitSameMark = pathsFor(elementId);
      elementController.update({ mark: 'hanamaru', duration: 0 });
      await nextFrame();
      const explicitSameMark = pathsFor(elementId);
      elementController.update({ mark: 'box' });
      await nextFrame();
      const builtInGroup = document.querySelector(
        `.hana-annotation[data-hana-id="${elementId}"]`,
      );
      const builtIn = {
        mark: builtInGroup.getAttribute('data-hana-mark'),
        paths: pathsFor(elementId).length,
        state: elementController.state,
      };
      let changeBack;
      try {
        elementController.update({ mark: 'hanamaru' });
      } catch (error) {
        changeBack = {
          code: error.code,
          field: error.details?.field,
          state: elementController.state,
        };
      }
      let replacementCalls = 0;
      unregisterReplacement = registerMark('hanamaru', () => {
        replacementCalls += 1;
        return { paths: ['M 3 4 L 50 60'] };
      });
      elementController.update({ mark: 'hanamaru' });
      await nextFrame();
      const replacementGroup = document.querySelector(
        `.hana-annotation[data-hana-id="${elementId}"]`,
      );
      const reRegistered = {
        calls: replacementCalls,
        mark: replacementGroup.getAttribute('data-hana-mark'),
        paths: pathsFor(elementId),
        state: elementController.state,
      };
      unregisterReplacement();

      return {
        changeBack,
        changed,
        builtIn,
        explicitSameMark,
        immediate,
        implicitSameMark,
        replayed,
        reRegistered,
        refreshed,
        restored,
        stable,
      };
    } finally {
      controllers.reverse().forEach((controller) => controller.destroy());
      unregisterReplacement();
      unregister();
    }
  });

  expect(result.immediate.overlays).toBe(1);
  expect(result.immediate.svgLayers).toBe(1);
  expect(result.immediate.groups).toBe(2);
  expect(result.immediate.elementPaths).toHaveLength(4);
  expect(result.immediate.rangePaths).toHaveLength(4);
  expect(result.immediate.elementPaths.every(Boolean)).toBe(true);
  expect(result.immediate.rangePaths.every(Boolean)).toBe(true);
  expect(result.immediate.elementClasses).toEqual(Array(4).fill('hana-path hana-mark-path'));
  expect(result.immediate.rangeClasses).toEqual(Array(4).fill('hana-path hana-mark-path'));
  expect(result.immediate.groupClasses).toEqual([
    'hana-annotation hana-is-visible',
    'hana-annotation hana-is-visible',
  ]);
  expect(result.immediate.customClassTokens).toEqual([]);
  expect(result.immediate.animationCount).toBeGreaterThan(0);
  expect(result.immediate.frozenContext).toEqual({
    context: true, helpers: true, rect: true, rects: true, unionRect: true,
  });
  expect(result.replayed).toEqual(result.stable);
  expect(result.refreshed).toEqual(result.stable);
  expect(result.changed).not.toEqual(result.stable);
  expect(result.restored).toEqual(result.stable);
  expect(result.implicitSameMark).toEqual(result.stable);
  expect(result.explicitSameMark).toEqual(result.stable);
  expect(result.builtIn).toEqual({ mark: 'box', paths: 2, state: 'visible' });
  expect(result.changeBack).toEqual({
    code: 'HANA_CONFIG_INVALID', field: 'mark', state: 'visible',
  });
  expect(result.reRegistered).toEqual({
    calls: 1,
    mark: 'hanamaru',
    paths: ['M 3 4 L 50 60'],
    state: 'visible',
  });
  await expect(page.locator('[data-hana-overlay]')).toHaveCount(0);
  await expect(page.locator('[data-hana-id]')).toHaveCount(0);
  await expectNoBrowserFailures(page, failures);
});

test('declarative scans capture a registered mark and reject new scans after unregister', async ({ page }) => {
  const failures = await openPluginFixture(page);
  const result = await page.evaluate(async () => {
    const { scan } = await import('/src/index.js');
    const { registerMark } = await import('/src/plugins.js');
    const controllers = [];
    let unregister = () => {};
    const inventory = (fresh) => ({
      annotationIds: [...document.querySelectorAll('.hana-annotation')]
        .map((group) => group.getAttribute('data-hana-id')),
      annotationOuterHTML: [...document.querySelectorAll('.hana-annotation')]
        .map((group) => group.outerHTML),
      connectorPaths: [...document.querySelectorAll('.hana-connector-path')]
        .map((path) => path.getAttribute('d')),
      freshAria: fresh.getAttribute('aria-describedby'),
      markPaths: [...document.querySelectorAll('.hana-mark-path')]
        .map((path) => path.getAttribute('d')),
      noteOuterHTML: [...document.querySelectorAll('.hana-note')]
        .map((note) => note.outerHTML),
      overlayCount: document.querySelectorAll('[data-hana-overlay]').length,
      overlayOuterHTML: [...document.querySelectorAll('[data-hana-overlay]')]
        .map((overlay) => overlay.outerHTML),
      priorAria: document.querySelector('#declarative-target')
        .getAttribute('aria-describedby'),
    });
    try {
      unregister = registerMark('hanamaru', ({ rects, helpers }) => ({
        paths: rects.map((rect, index) => helpers.line(
          { x: rect.left, y: rect.bottom },
          { x: rect.right, y: rect.bottom },
          { label: `declarative-${index}`, wobble: 0 },
        )),
      }));
      const first = scan(document);
      controllers.push(...first.annotations);
      first.annotations[0].show();
      await first.annotations[0].finished;
      const captured = {
        errors: first.errors.length,
        paths: document.querySelectorAll('.hana-mark-path').length,
        state: first.annotations[0].state,
      };

      unregister();
      first.annotations[0].replay();
      await first.annotations[0].finished;
      const afterUnregister = {
        paths: document.querySelectorAll('.hana-mark-path').length,
        state: first.annotations[0].state,
      };
      document.querySelector('#declarative-target').removeAttribute('data-hana');
      const fresh = document.createElement('span');
      fresh.dataset.hana = 'hanamaru';
      fresh.textContent = 'Fresh declarative target';
      document.querySelector('#declarative-scan-root').append(fresh);
      const beforeFreshScan = inventory(fresh);
      const second = scan(document.querySelector('#declarative-scan-root'));
      controllers.push(...second.annotations);
      const afterFreshScan = inventory(fresh);
      return {
        afterUnregister,
        captured,
        fresh: {
          annotations: second.annotations.length,
          code: second.errors[0]?.code,
          errorCount: second.errors.length,
          field: second.errors[0]?.details?.field,
          freshAria: fresh.getAttribute('aria-describedby'),
          inventoryAfter: afterFreshScan,
          inventoryBefore: beforeFreshScan,
        },
      };
    } finally {
      controllers.reverse().forEach((controller) => controller.destroy());
      unregister();
    }
  });

  expect(result.fresh.inventoryAfter).toEqual(result.fresh.inventoryBefore);
  expect(result).toMatchObject({
    afterUnregister: { paths: 1, state: 'visible' },
    captured: { errors: 0, paths: 1, state: 'visible' },
    fresh: {
      annotations: 0,
      code: 'HANA_CONFIG_INVALID',
      errorCount: 1,
      field: 'mark',
      freshAria: null,
    },
  });
  await expect(page.locator('[data-hana-overlay]')).toHaveCount(0);
  await expect(page.locator('[data-hana-id]')).toHaveCount(0);
  await expectNoBrowserFailures(page, failures);
});

test('one realm registry renders into two Documents without sharing document resources', async ({ page }) => {
  const failures = await openPluginFixture(page);
  const result = await page.evaluate(async () => {
    const {
      createAnnotation,
      createAnnotationEnvironment,
    } = await import('/src/annotation.js');
    const { registerMark } = await import('/src/plugins.js');
    const controllers = [];
    let unregister = () => {};
    let frame;
    try {
      unregister = registerMark('hanamaru', ({ unionRect }) => ({
        paths: [
          `M ${unionRect.left} ${unionRect.top} L ${unionRect.right} ${unionRect.bottom}`,
          `M ${unionRect.right} ${unionRect.top} L ${unionRect.left} ${unionRect.bottom}`,
        ],
      }));
      frame = document.createElement('iframe');
      document.body.append(frame);
      const frameDocument = frame.contentDocument;
      const frameTarget = frameDocument.createElement('p');
      frameTarget.textContent = 'Same-origin iframe plugin target';
      frameDocument.body.append(frameTarget);
      const topTarget = document.querySelector('#element-target');
      const events = [];
      frameTarget.addEventListener('hana:complete', (event) => events.push({
        frameRealmEvent: event instanceof frame.contentWindow.CustomEvent,
        ownerDocument: event.target.ownerDocument === frameDocument,
      }));

      const topController = createAnnotation(
        topTarget,
        { mark: 'hanamaru', motion: 'never' },
        createAnnotationEnvironment(topTarget, document),
      );
      const frameController = createAnnotation(
        frameTarget,
        { mark: 'hanamaru', motion: 'never' },
        createAnnotationEnvironment(frameTarget, frameDocument),
      );
      controllers.push(topController, frameController);
      topController.show();
      frameController.show();
      await Promise.all([topController.finished, frameController.finished]);
      const visible = {
        events,
        frameOverlays: frameDocument.querySelectorAll('[data-hana-overlay]').length,
        framePaths: frameDocument.querySelectorAll('.hana-mark-path').length,
        topOverlays: document.querySelectorAll('[data-hana-overlay]').length,
        topPaths: document.querySelectorAll('.hana-mark-path').length,
      };
      topController.destroy();
      controllers.splice(controllers.indexOf(topController), 1);
      const independent = {
        frameOverlays: frameDocument.querySelectorAll('[data-hana-overlay]').length,
        framePaths: frameDocument.querySelectorAll('.hana-mark-path').length,
        topOverlays: document.querySelectorAll('[data-hana-overlay]').length,
        topPaths: document.querySelectorAll('.hana-mark-path').length,
      };
      frameController.destroy();
      controllers.splice(controllers.indexOf(frameController), 1);
      return {
        independent,
        tornDown: {
          frameOverlays: frameDocument.querySelectorAll('[data-hana-overlay]').length,
          frameOwned: frameDocument.querySelectorAll('[data-hana-id]').length,
          topOverlays: document.querySelectorAll('[data-hana-overlay]').length,
          topOwned: document.querySelectorAll('[data-hana-id]').length,
        },
        visible,
      };
    } finally {
      controllers.reverse().forEach((controller) => controller.destroy());
      unregister();
      frame?.remove();
    }
  });

  expect(result.visible).toEqual({
    events: [{ frameRealmEvent: true, ownerDocument: true }],
    frameOverlays: 1,
    framePaths: 2,
    topOverlays: 1,
    topPaths: 2,
  });
  expect(result.independent).toEqual({
    frameOverlays: 1, framePaths: 2, topOverlays: 0, topPaths: 0,
  });
  expect(result.tornDown).toEqual({
    frameOverlays: 0, frameOwned: 0, topOverlays: 0, topOwned: 0,
  });
  await expect(page.locator('iframe')).toHaveCount(0);
  await expectNoBrowserFailures(page, failures);
});

test('strict CSP permits source-module registration and rendering without forbidden injection', async ({ page }) => {
  const failures = watchBrowserFailures(page);
  const response = await page.goto('/tests/fixtures/plugins-csp.html');
  expect(response?.headers()['content-security-policy']).toBe(CSP);
  const runnerLoaded = await page.evaluate(() => (
    typeof window.__pluginCsp?.run === 'function'
  ));
  expect(runnerLoaded).toBe(true);

  const result = await page.evaluate(() => window.__pluginCsp.run());
  const expectedInventory = {
    scripts: [{
      inline: '',
      src: '/tests/fixtures/plugins-csp.js',
      type: 'module',
    }],
    styleElements: [],
    stylesheetLinks: [{
      href: '/src/hanamaru.css',
      rel: 'stylesheet',
    }],
  };
  expect(result).toEqual({
    after: expectedInventory,
    before: expectedInventory,
    cleanup: { overlays: 0, owned: 0 },
    visible: {
      overlays: 1,
      paths: [expect.stringMatching(/^M .+ L .+$/)],
      state: 'visible',
    },
  });
  expect(await page.evaluate(() => window.__pluginCsp.inventory())).toEqual(expectedInventory);
  expect(await page.evaluate(() => window.__pluginCsp.unhandledRejections)).toEqual([]);
  expect(failures.filter((message) => /content security policy|refused/i.test(message))).toEqual([]);
  expect(failures).toEqual([]);
  await expect(page.locator('[data-hana-overlay]')).toHaveCount(0);
});

test('contains factory throws and invalid or cost-bounded output without partial renderer state', async ({ page }) => {
  const failures = await openPluginFixture(page);
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const { registerMark } = await import('/src/plugins.js');
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const throwCause = new Error('browser factory boom');
    const cases = [
      ['throw-case', () => { throw throwCause; }],
      ['accessor-case', () => Object.defineProperty({}, 'paths', {
        enumerable: true,
        get() { throw new Error('paths getter must not run'); },
      })],
      ['syntax-case', () => ({ paths: ['definitely-not-svg'] })],
      ['nonfinite-case', () => ({ paths: ['M NaN 0 L 1 1'] })],
      ['count-case', () => ({ paths: Array(33).fill('M 0 0 L 1 1') })],
      ['budget-case', () => ({ paths: [`M 0 0 L 1 1${' '.repeat(16384)}`] })],
    ];
    const outputs = [];
    for (const [name, factory] of cases) {
      const unregister = registerMark(name, factory);
      const target = document.querySelector('#element-target');
      const controller = annotate(target, {
        mark: name,
        note: 'Must not leak',
        accessible: true,
        motion: 'never',
      });
      const events = [];
      const onError = (event) => {
        if (event.detail.controller === controller) events.push(event.detail.error);
      };
      target.addEventListener('hana:error', onError);
      try {
        controller.show();
        const finished = controller.finished?.catch((error) => error);
        const rejected = await finished;
        await Promise.resolve();
        await nextFrame();
        const eventError = events[0];
        outputs.push({
          code: eventError?.code,
          causeCode: eventError?.details?.cause?.code ?? null,
          causeField: eventError?.details?.cause?.details?.field ?? null,
          causeMessage: eventError?.details?.cause?.message,
          causeSame: name === 'throw-case'
            ? eventError?.details?.cause === throwCause
            : null,
          connectors: document.querySelectorAll('.hana-connector-path').length,
          describedBy: target.getAttribute('aria-describedby'),
          eventCount: events.length,
          mark: eventError?.details?.mark,
          markPaths: document.querySelectorAll('.hana-mark-path').length,
          rejectedSame: rejected === eventError,
          state: controller.state,
          visibleNotes: document.querySelectorAll('.hana-note:not(.hana-is-hidden)').length,
        });
        controller.hide();
      } finally {
        target.removeEventListener('hana:error', onError);
        controller.destroy();
        unregister();
      }
      outputs.at(-1).afterDestroy = {
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
        owned: document.querySelectorAll('[data-hana-id]').length,
        token: target.getAttribute('aria-describedby'),
      };
    }

    const unregisterStable = registerMark('stable-browser-mark', () => ({
      paths: ['M 1 1 L 10 10'],
    }));
    const updateCause = new Error('update factory boom');
    const unregisterBroken = registerMark('broken-browser-mark', () => { throw updateCause; });
    const target = document.querySelector('#element-target');
    const stable = annotate(target, {
      mark: 'stable-browser-mark',
      note: 'Retained accessible note',
      accessible: true,
      motion: 'never',
    });
    const transactionEvents = [];
    const onTransactionError = (event) => {
      if (event.detail.controller === stable) transactionEvents.push(event.detail.error);
    };
    target.addEventListener('hana:error', onTransactionError);
    let transaction;
    try {
      stable.show();
      await stable.finished;
      const id = document.querySelector('.hana-annotation').getAttribute('data-hana-id');
      const snapshot = () => {
        const group = document.querySelector(`.hana-annotation[data-hana-id="${id}"]`);
        return {
          aria: target.getAttribute('aria-describedby'),
          html: group.innerHTML,
          owned: document.querySelectorAll('[data-hana-id]').length,
          overlays: document.querySelectorAll('[data-hana-overlay]').length,
          paths: [...group.querySelectorAll('.hana-mark-path')]
            .map((path) => path.getAttribute('d')),
          state: stable.state,
        };
      };
      const before = snapshot();
      unregisterStable();
      let error;
      try {
        stable.update({ mark: 'broken-browser-mark' });
      } catch (caught) {
        error = caught;
      }
      const afterFailureSynchronous = snapshot();
      await Promise.resolve();
      await nextFrame();
      const afterFailure = snapshot();
      stable.replay();
      await stable.finished;
      const afterReplay = snapshot();
      stable.refresh();
      await nextFrame();
      const afterRefresh = snapshot();
      stable.update({ duration: 0 });
      await nextFrame();
      const afterImplicitUpdate = snapshot();
      stable.update({ mark: 'stable-browser-mark', duration: 0 });
      await nextFrame();
      const afterExplicitUpdate = snapshot();
      transaction = {
        afterExplicitUpdate,
        afterFailure,
        afterFailureSynchronous,
        afterImplicitUpdate,
        afterRefresh,
        afterReplay,
        before,
        error: {
          causeSame: error?.details?.cause === updateCause,
          code: error?.code,
          mark: error?.details?.mark,
        },
        eventCount: transactionEvents.length,
      };
    } finally {
      target.removeEventListener('hana:error', onTransactionError);
      stable.destroy();
      unregisterStable();
      unregisterBroken();
    }
    transaction.afterDestroy = {
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      owned: document.querySelectorAll('[data-hana-id]').length,
      token: target.getAttribute('aria-describedby'),
    };
    return { outputs, transaction };
  });

  expect(result.outputs).toHaveLength(6);
  for (const [index, output] of result.outputs.entries()) {
    expect(output.code).toBe('HANA_STATE_MARK_PLUGIN');
    expect(output.eventCount).toBe(1);
    expect(output.mark).toBe([
      'throw-case', 'accessor-case', 'syntax-case', 'nonfinite-case', 'count-case', 'budget-case',
    ][index]);
    expect(output.markPaths).toBe(0);
    expect(output.connectors).toBe(0);
    expect(output.visibleNotes).toBe(0);
    expect(output.describedBy).toBeNull();
    expect(output.rejectedSame).toBe(true);
    expect(output.state).toBe('suspended');
    expect(output.afterDestroy).toEqual({ overlays: 0, owned: 0, token: null });
  }
  expect(result.outputs[0]).toMatchObject({
    causeCode: null,
    causeField: null,
    causeMessage: 'browser factory boom',
    causeSame: true,
  });
  for (const output of result.outputs.slice(1)) {
    expect(output.causeCode).toBe('HANA_CONFIG_INVALID');
  }
  expect(result.outputs.slice(1).map((output) => output.causeField)).toEqual([
    'result', 'paths[0]', 'paths[0]', 'paths', 'paths[0]',
  ]);
  expect(result.transaction.error).toEqual({
    causeSame: true, code: 'HANA_STATE_MARK_PLUGIN', mark: 'broken-browser-mark',
  });
  expect(result.transaction.eventCount).toBe(0);
  expect(result.transaction.afterFailureSynchronous).toEqual(result.transaction.before);
  const stableOutput = {
    aria: result.transaction.before.aria,
    overlays: result.transaction.before.overlays,
    owned: result.transaction.before.owned,
    paths: result.transaction.before.paths,
    state: result.transaction.before.state,
  };
  for (const phase of [
    'afterFailure',
    'afterReplay',
    'afterRefresh',
    'afterImplicitUpdate',
    'afterExplicitUpdate',
  ]) {
    expect({
      aria: result.transaction[phase].aria,
      overlays: result.transaction[phase].overlays,
      owned: result.transaction[phase].owned,
      paths: result.transaction[phase].paths,
      state: result.transaction[phase].state,
    }).toEqual(stableOutput);
  }
  expect(result.transaction.afterDestroy).toEqual({ overlays: 0, owned: 0, token: null });
  await expectNoBrowserFailures(page, failures);
});
