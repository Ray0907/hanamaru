import { expect, test } from '@playwright/test';

const browserErrors = new WeakMap();

async function installRootFixture(page) {
  await page.evaluate(() => {
    window.__shadowRuntimeUnhandled = [];
    window.addEventListener('unhandledrejection', (event) => {
      window.__shadowRuntimeUnhandled.push(String(event.reason));
    });

    const nativeAdd = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    const listeners = [];
    const removals = [];
    EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
      if (this === window || this === window.visualViewport) {
        listeners.push({
          target: this === window ? 'window' : 'visualViewport',
          type,
        });
      }
      return nativeAdd.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function removeEventListener(
      type,
      listener,
      options,
    ) {
      if (this === window || this === window.visualViewport) {
        removals.push({
          target: this === window ? 'window' : 'visualViewport',
          type,
        });
      }
      return nativeRemove.call(this, type, listener, options);
    };

    const NativeMutationObserver = window.MutationObserver;
    const observers = [];
    let failShadowObserveAfterNative = false;
    window.MutationObserver = class InstrumentedMutationObserver {
      constructor(callback) {
        this.callback = callback;
        this.native = new NativeMutationObserver(callback);
        this.targets = [];
        this.disconnected = false;
        observers.push(this);
      }

      observe(target, options) {
        this.targets.push({ target, options });
        this.native.observe(target, options);
        if (failShadowObserveAfterNative && target instanceof ShadowRoot) {
          throw new Error('forced ShadowRoot observe failure');
        }
      }

      disconnect() {
        this.disconnected = true;
        this.native.disconnect();
      }

      takeRecords() {
        return this.native.takeRecords();
      }

      deliver(records) {
        this.callback(records, this);
      }
    };

    const openHost = document.querySelector('#open-host');
    openHost.style.cssText = [
      'position: relative',
      'width: 40px',
      'height: 40px',
      'overflow: hidden',
      'contain: paint',
      'transform: translateZ(0)',
    ].join(';');
    const openRoot = openHost.attachShadow({ mode: 'open' });
    openRoot.innerHTML = '<button id="open-target">Open target</button>';

    const closedHost = document.querySelector('#closed-host');
    const closedRoot = closedHost.attachShadow({ mode: 'closed' });
    closedRoot.innerHTML = '<button id="closed-target">Closed target</button>';

    const otherHost = document.querySelector('#other-host');
    const otherRoot = otherHost.attachShadow({ mode: 'open' });
    otherRoot.innerHTML = '<button id="other-target">Other target</button>';

    const frame = document.querySelector('#foreign-frame');
    const frameHost = frame.contentDocument.body.appendChild(
      frame.contentDocument.createElement('div'),
    );
    const frameRoot = frameHost.attachShadow({ mode: 'open' });
    frameRoot.innerHTML = '<button id="frame-target">Frame target</button>';

    window.__shadowRuntime = {
      listeners,
      removals,
      observers,
      openHost,
      openRoot,
      closedRoot,
      otherRoot,
      frameRoot,
      failShadowObserve() {
        failShadowObserveAfterNative = true;
      },
    };
  });
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/tests/fixtures/shadow.html');
  await installRootFixture(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
  expect(await page.evaluate(() => window.__shadowRuntimeUnhandled)).toEqual([]);
});

test('resource portals are one per open or retained closed root and escape clipped hosts', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireShadowResources } = await import('/src/shadow-resources.js');
    const state = window.__shadowRuntime;
    const styles = { release() {} };
    const open = acquireShadowResources(state.openRoot, styles);
    const closed = acquireShadowResources(state.closedRoot, styles);
    const openPortal = open.environment.portal;
    const closedPortal = closed.environment.portal;
    const before = {
      overlays: document.querySelectorAll('[data-hana-shadow-overlay]').length,
      genericOverlays: document.querySelectorAll(
        '[data-hana-overlay]:not([data-hana-shadow-overlay])',
      ).length,
      openOutsideHost: openPortal.parentNode === document.body
        && !state.openHost.contains(openPortal),
      closedOutsideHost: closedPortal.parentNode === document.body,
      distinct: openPortal !== closedPortal,
      hierarchy: openPortal.contains(open.environment.svgLayer)
        && openPortal.contains(open.environment.noteLayer),
      exactDocuments: openPortal.ownerDocument === document
        && closedPortal.ownerDocument === document,
      rootIds: [
        open.environment.rootId,
        closed.environment.rootId,
      ],
    };
    open.release();
    const afterOpen = {
      overlays: document.querySelectorAll('[data-hana-shadow-overlay]').length,
      closedConnected: closedPortal.isConnected,
    };
    closed.release();
    return {
      before,
      afterOpen,
      afterFinal: document.querySelectorAll('[data-hana-shadow-overlay]').length,
    };
  });

  expect(result.before).toMatchObject({
    overlays: 2,
    genericOverlays: 0,
    openOutsideHost: true,
    closedOutsideHost: true,
    distinct: true,
    hierarchy: true,
    exactDocuments: true,
  });
  expect(new Set(result.before.rootIds).size).toBe(2);
  expect(result.afterOpen).toEqual({ overlays: 1, closedConnected: true });
  expect(result.afterFinal).toBe(0);
});

test('resource roots share one Document scheduler and listeners but own exact observers', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireShadowResources } = await import('/src/shadow-resources.js');
    const state = window.__shadowRuntime;
    const styles = { release() {} };
    const first = acquireShadowResources(state.openRoot, styles);
    const second = acquireShadowResources(state.otherRoot, styles);
    first.environment.shared.registerController('shared-scheduler-proof');
    let sharedScheduler = false;
    try {
      second.environment.shared.registerController('shared-scheduler-proof');
    } catch (error) {
      sharedScheduler = /already registered/u.test(error.message);
    }
    first.environment.shared.releaseController('shared-scheduler-proof');
    const rootObservers = state.observers.filter(({ targets }) => (
      targets.some(({ target }) => target instanceof ShadowRoot)
    ));
    const before = {
      sameDocumentShared: first.environment.documentShared
        === second.environment.documentShared,
      sharedScheduler,
      rootObserverCount: rootObservers.length,
      exactTargets: rootObservers.map(({ targets }) => targets[0].target === state.openRoot
        ? 'open'
        : targets[0].target === state.otherRoot ? 'other' : 'wrong').sort(),
      windowResize: state.listeners.filter(
        ({ target, type }) => target === 'window' && type === 'resize',
      ).length,
      viewportResize: state.listeners.filter(
        ({ target, type }) => target === 'visualViewport' && type === 'resize',
      ).length,
      viewportScroll: state.listeners.filter(
        ({ target, type }) => target === 'visualViewport' && type === 'scroll',
      ).length,
    };
    first.release();
    second.release();
    return {
      before,
      rootDisconnected: rootObservers.every(({ disconnected }) => disconnected),
      windowResizeRemovals: state.removals.filter(
        ({ target, type }) => target === 'window' && type === 'resize',
      ).length,
      viewportResizeRemovals: state.removals.filter(
        ({ target, type }) => target === 'visualViewport' && type === 'resize',
      ).length,
      viewportScrollRemovals: state.removals.filter(
        ({ target, type }) => target === 'visualViewport' && type === 'scroll',
      ).length,
    };
  });

  expect(result.before).toEqual({
    sameDocumentShared: true,
    sharedScheduler: true,
    rootObserverCount: 2,
    exactTargets: ['open', 'other'],
    windowResize: 1,
    viewportResize: 1,
    viewportScroll: 1,
  });
  expect(result).toMatchObject({
    rootDisconnected: true,
    windowResizeRemovals: 1,
    viewportResizeRemovals: 1,
    viewportScrollRemovals: 1,
  });
});

test('resource root and standalone Document leases share one core with independent portals', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireShadowResources } = await import('/src/shadow-resources.js');
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const state = window.__shadowRuntime;
    const shadow = acquireShadowResources(state.openRoot, { release() {} });
    const standalone = acquireDocumentResources(document);
    const before = {
      sameCore: shadow.environment.documentShared === standalone.shared,
      shadowPortals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
      documentPortals: document.querySelectorAll(
        '[data-hana-overlay]:not([data-hana-shadow-overlay])',
      ).length,
    };
    standalone.release();
    const afterDocument = {
      shadowPortals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
      documentPortals: document.querySelectorAll(
        '[data-hana-overlay]:not([data-hana-shadow-overlay])',
      ).length,
      windowResizeRemovals: state.removals.filter(
        ({ target, type }) => target === 'window' && type === 'resize',
      ).length,
    };
    shadow.release();
    return {
      before,
      afterDocument,
      finalWindowResizeRemovals: state.removals.filter(
        ({ target, type }) => target === 'window' && type === 'resize',
      ).length,
    };
  });

  expect(result).toEqual({
    before: {
      sameCore: true,
      shadowPortals: 1,
      documentPortals: 1,
    },
    afterDocument: {
      shadowPortals: 1,
      documentPortals: 0,
      windowResizeRemovals: 0,
    },
    finalWindowResizeRemovals: 1,
  });
});

test('resource and style slots release independently and delete root state only after both clear', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireShadowResources } = await import('/src/shadow-resources.js');
    const { acquireShadowStyles } = await import('/src/shadow-styles.js');
    const { runtimeState } = await import('/src/runtime-state.js');
    const root = window.__shadowRuntime.openRoot;
    const styles = acquireShadowStyles(root);
    const resources = acquireShadowResources(root, styles);
    const initial = {
      styles: runtimeState.shadows.get(root)?.styles !== null,
      resources: runtimeState.shadows.get(root)?.resources !== null,
      portal: resources.environment.portal.isConnected,
    };
    styles.release();
    const afterStyles = {
      hasState: runtimeState.shadows.has(root),
      styles: runtimeState.shadows.get(root)?.styles ?? null,
      resources: runtimeState.shadows.get(root)?.resources !== null,
      portal: resources.environment.portal.isConnected,
    };
    resources.release();
    return {
      initial,
      afterStyles,
      afterResources: {
        hasState: runtimeState.shadows.has(root),
        portals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
      },
    };
  });

  expect(result).toEqual({
    initial: { styles: true, resources: true, portal: true },
    afterStyles: {
      hasState: true,
      styles: null,
      resources: true,
      portal: true,
    },
    afterResources: { hasState: false, portals: 0 },
  });
});

test('resource observers route mutation work only inside their exact ShadowRoot', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireShadowResources } = await import('/src/shadow-resources.js');
    const state = window.__shadowRuntime;
    const styles = { release() {} };
    const first = acquireShadowResources(state.openRoot, styles);
    const second = acquireShadowResources(state.otherRoot, styles);
    const firstTarget = state.openRoot.querySelector('#open-target');
    const secondTarget = state.otherRoot.querySelector('#other-target');
    const writes = { first: 0, second: 0 };
    const rect = {
      x: 0, y: 0, width: 1, height: 1,
      top: 0, right: 1, bottom: 1, left: 0,
    };
    const flushMutationFrame = async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    };
    for (const [lease, id, target] of [
      [first, 'root-mutation-first', firstTarget],
      [second, 'root-mutation-second', secondTarget],
    ]) {
      lease.environment.shared.registerController(id);
      lease.environment.shared.observeLayout({
        id,
        generation: 0,
        record: {
          kind: 'element',
          element: target,
          ownerElement: target,
        },
        read() {
          return rect;
        },
        write() {
          writes[id === 'root-mutation-first' ? 'first' : 'second'] += 1;
        },
      });
    }

    await flushMutationFrame();
    await flushMutationFrame();
    writes.first = 0;
    writes.second = 0;
    const rootObservers = state.observers.filter(({ targets }) => (
      targets.some(({ target }) => target instanceof ShadowRoot)
    ));
    const firstObserver = rootObservers.find(
      ({ targets }) => targets[0].target === state.openRoot,
    );
    const secondObserver = rootObservers.find(
      ({ targets }) => targets[0].target === state.otherRoot,
    );
    firstObserver.deliver([{ target: firstTarget }]);
    await flushMutationFrame();
    const afterFirst = { ...writes };
    secondObserver.deliver([{ target: secondTarget }]);
    await flushMutationFrame();
    const afterSecond = { ...writes };

    first.environment.shared.releaseController('root-mutation-first');
    second.environment.shared.releaseController('root-mutation-second');
    first.release();
    second.release();
    return { afterFirst, afterSecond };
  });

  expect(result).toEqual({
    afterFirst: { first: 1, second: 0 },
    afterSecond: { first: 1, second: 1 },
  });
});

test('resource mirror registries stay in-root and cleanup only their owned aria tokens', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireShadowResources } = await import('/src/shadow-resources.js');
    const state = window.__shadowRuntime;
    const styles = { release() {} };
    const first = acquireShadowResources(state.openRoot, styles);
    const second = acquireShadowResources(state.otherRoot, styles);
    const firstOwner = state.openRoot.querySelector('#open-target');
    const secondOwner = state.otherRoot.querySelector('#other-target');
    firstOwner.setAttribute('aria-describedby', 'author-owned');
    const firstMirror = first.environment.createMirror(firstOwner, 'Open description');
    const secondMirror = second.environment.createMirror(secondOwner, 'Other description');
    const before = {
      firstInRoot: firstMirror.getRootNode() === state.openRoot,
      secondInRoot: secondMirror.getRootNode() === state.otherRoot,
      noCrossRoot: state.openRoot.querySelector(`#${secondMirror.id}`) === null
        && state.otherRoot.querySelector(`#${firstMirror.id}`) === null,
      unique: firstMirror.id !== secondMirror.id,
      firstTokens: firstOwner.getAttribute('aria-describedby').split(/\s+/u),
      secondToken: secondOwner.getAttribute('aria-describedby'),
    };
    first.release();
    const afterFirst = {
      firstMirror: state.openRoot.querySelector('[data-hana-shadow-mirror]'),
      firstToken: firstOwner.getAttribute('aria-describedby'),
      secondConnected: secondMirror.isConnected,
      secondToken: secondOwner.getAttribute('aria-describedby'),
    };
    second.release();
    return {
      before,
      afterFirst,
      secondMirrorConnected: secondMirror.isConnected,
      secondToken: secondOwner.getAttribute('aria-describedby'),
    };
  });

  expect(result.before).toMatchObject({
    firstInRoot: true,
    secondInRoot: true,
    noCrossRoot: true,
    unique: true,
    secondToken: expect.stringMatching(/^hana-shadow-/),
  });
  expect(result.before.firstTokens[0]).toBe('author-owned');
  expect(result.before.firstTokens[1]).toMatch(/^hana-shadow-/);
  expect(result.afterFirst).toEqual({
    firstMirror: null,
    firstToken: 'author-owned',
    secondConnected: true,
    secondToken: result.before.secondToken,
  });
  expect(result.secondMirrorConnected).toBe(false);
  expect(result.secondToken).toBe(null);
});

test('resource composed event dispatch crosses the Shadow boundary with exact detail', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireShadowResources } = await import('/src/shadow-resources.js');
    const state = window.__shadowRuntime;
    const lease = acquireShadowResources(state.openRoot, { release() {} });
    const owner = state.openRoot.querySelector('#open-target');
    let observed = null;
    document.addEventListener('hana:resource-proof', (event) => {
      observed = {
        bubbles: event.bubbles,
        composed: event.composed,
        detail: event.detail,
        targetIsHost: event.target === state.openHost,
      };
    }, { once: true });
    const dispatched = lease.environment.createEvent(
      'hana:resource-proof',
      { root: 'open' },
      owner,
    );
    lease.release();
    return { dispatched, observed };
  });

  expect(result).toEqual({
    dispatched: true,
    observed: {
      bubbles: true,
      composed: true,
      detail: { root: 'open' },
      targetIsHost: true,
    },
  });
});

test('resource iframe root uses its owner Document portal and isolated scheduler', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireShadowResources } = await import('/src/shadow-resources.js');
    const state = window.__shadowRuntime;
    const main = acquireShadowResources(state.openRoot, { release() {} });
    const frame = acquireShadowResources(state.frameRoot, { release() {} });
    const frameDocument = state.frameRoot.ownerDocument;
    const before = {
      separateScheduler: main.environment.documentShared
        !== frame.environment.documentShared,
      mainParent: main.environment.portal.parentNode === document.body,
      frameParent: frame.environment.portal.parentNode === frameDocument.body,
      frameOwner: frame.environment.portal.ownerDocument === frameDocument,
      mainCount: document.querySelectorAll('[data-hana-shadow-overlay]').length,
      frameCount: frameDocument.querySelectorAll('[data-hana-shadow-overlay]').length,
    };
    main.release();
    frame.release();
    return {
      before,
      mainAfter: document.querySelectorAll('[data-hana-shadow-overlay]').length,
      frameAfter: frameDocument.querySelectorAll('[data-hana-shadow-overlay]').length,
    };
  });

  expect(result).toEqual({
    before: {
      separateScheduler: true,
      mainParent: true,
      frameParent: true,
      frameOwner: true,
      mainCount: 1,
      frameCount: 1,
    },
    mainAfter: 0,
    frameAfter: 0,
  });
});

test('resource observer install failure disconnects partial work and rolls back every slot and portal', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireShadowResources } = await import('/src/shadow-resources.js');
    const { runtimeState } = await import('/src/runtime-state.js');
    const state = window.__shadowRuntime;
    state.failShadowObserve();
    let error;
    try {
      acquireShadowResources(state.openRoot, { release() {} });
    } catch (cause) {
      error = {
        name: cause.name,
        code: cause.code,
        message: cause.details?.cause?.message,
      };
    }
    return {
      error,
      portals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
      rootState: runtimeState.shadows.has(state.openRoot),
      documentState: runtimeState.documents.has(document),
      observers: state.observers.map(({ disconnected, targets }) => ({
        disconnected,
        target: targets[0]?.target === document
          ? 'document'
          : targets[0]?.target === state.openRoot ? 'root' : 'other',
      })),
    };
  });

  expect(result).toEqual({
    error: {
      name: 'HanamaruStateError',
      code: 'HANA_STATE_SHADOW_RESOURCES',
      message: 'forced ShadowRoot observe failure',
    },
    portals: 0,
    rootState: false,
    documentState: false,
    observers: [
      { disconnected: true, target: 'document' },
      { disconnected: true, target: 'root' },
    ],
  });
});
