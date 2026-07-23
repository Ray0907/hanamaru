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
    const { acquireShadowStyles } = await import('/src/shadow-styles.js');
    const state = window.__shadowRuntime;
    const openStyles = acquireShadowStyles(state.openRoot);
    const closedStyles = acquireShadowStyles(state.closedRoot);
    const open = acquireShadowResources(state.openRoot, openStyles);
    const closed = acquireShadowResources(state.closedRoot, closedStyles);
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
    openStyles.release();
    closedStyles.release();
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
    const { acquireShadowStyles } = await import('/src/shadow-styles.js');
    const state = window.__shadowRuntime;
    const firstStyles = acquireShadowStyles(state.openRoot);
    const secondStyles = acquireShadowStyles(state.otherRoot);
    const first = acquireShadowResources(state.openRoot, firstStyles);
    const second = acquireShadowResources(state.otherRoot, secondStyles);
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
    firstStyles.release();
    secondStyles.release();
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
    const { acquireShadowStyles } = await import('/src/shadow-styles.js');
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const state = window.__shadowRuntime;
    const styles = acquireShadowStyles(state.openRoot);
    const shadow = acquireShadowResources(state.openRoot, styles);
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
    styles.release();
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
    const { acquireShadowStyles } = await import('/src/shadow-styles.js');
    const state = window.__shadowRuntime;
    const firstStyles = acquireShadowStyles(state.openRoot);
    const secondStyles = acquireShadowStyles(state.otherRoot);
    const first = acquireShadowResources(state.openRoot, firstStyles);
    const second = acquireShadowResources(state.otherRoot, secondStyles);
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
    firstStyles.release();
    secondStyles.release();
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
    const { acquireShadowStyles } = await import('/src/shadow-styles.js');
    const state = window.__shadowRuntime;
    const firstStyles = acquireShadowStyles(state.openRoot);
    const secondStyles = acquireShadowStyles(state.otherRoot);
    const first = acquireShadowResources(state.openRoot, firstStyles);
    const second = acquireShadowResources(state.otherRoot, secondStyles);
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
    firstStyles.release();
    secondStyles.release();
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

test('resource mirror ownership and aria/event writes ignore masked Element instance methods', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireShadowResources } = await import('/src/shadow-resources.js');
    const { acquireShadowStyles } = await import('/src/shadow-styles.js');
    const state = window.__shadowRuntime;
    const styles = acquireShadowStyles(state.openRoot);
    const resources = acquireShadowResources(state.openRoot, styles);
    const owner = state.openRoot.querySelector('#open-target');
    const foreign = state.otherRoot.querySelector('#other-target');
    const masked = (element, root) => {
      Object.defineProperties(element, {
        isConnected: { configurable: true, value: false },
        getRootNode: { configurable: true, value: () => root },
        getAttribute: {
          configurable: true,
          value: () => { throw new Error('masked getAttribute invoked'); },
        },
        setAttribute: {
          configurable: true,
          value: () => { throw new Error('masked setAttribute invoked'); },
        },
        removeAttribute: {
          configurable: true,
          value: () => { throw new Error('masked removeAttribute invoked'); },
        },
        dispatchEvent: {
          configurable: true,
          value: () => { throw new Error('masked dispatchEvent invoked'); },
        },
      });
    };
    masked(owner, state.otherRoot);
    masked(foreign, state.openRoot);

    let observed = null;
    document.addEventListener('hana:masked-proof', (event) => {
      observed = {
        composed: event.composed,
        detail: event.detail,
        targetIsHost: event.target === state.openHost,
      };
    }, { once: true });
    const mirror = resources.environment.createMirror(owner, 'Native ownership');
    const token = Element.prototype.getAttribute.call(owner, 'aria-describedby');
    resources.environment.createEvent('hana:masked-proof', { native: true }, owner);
    let foreignError;
    try {
      resources.environment.createMirror(foreign, 'Must reject');
    } catch (error) {
      foreignError = {
        name: error.name,
        message: error.message,
      };
    }
    const foreignToken = Element.prototype.getAttribute.call(
      foreign,
      'aria-describedby',
    );
    resources.environment.removeMirror(mirror);
    const after = Element.prototype.getAttribute.call(owner, 'aria-describedby');
    const mirrors = state.openRoot.querySelectorAll(
      '[data-hana-shadow-mirror]',
    ).length;
    resources.release();
    styles.release();
    return {
      token,
      observed,
      foreignError,
      foreignToken,
      after,
      mirrors,
    };
  });

  expect(result).toEqual({
    token: expect.stringMatching(/^hana-shadow-/),
    observed: {
      composed: true,
      detail: { native: true },
      targetIsHost: true,
    },
    foreignError: {
      name: 'TypeError',
      message: 'mirror owner must belong to the exact ShadowRoot',
    },
    foreignToken: null,
    after: null,
    mirrors: 0,
  });
});

test('resource composed event dispatch crosses the Shadow boundary with exact detail', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireShadowResources } = await import('/src/shadow-resources.js');
    const { acquireShadowStyles } = await import('/src/shadow-styles.js');
    const state = window.__shadowRuntime;
    const styles = acquireShadowStyles(state.openRoot);
    const lease = acquireShadowResources(state.openRoot, styles);
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
    styles.release();
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
    const { acquireShadowStyles } = await import('/src/shadow-styles.js');
    const state = window.__shadowRuntime;
    const mainStyles = acquireShadowStyles(state.openRoot);
    const frameStyles = acquireShadowStyles(state.frameRoot);
    const main = acquireShadowResources(state.openRoot, mainStyles);
    const frame = acquireShadowResources(state.frameRoot, frameStyles);
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
    mainStyles.release();
    frameStyles.release();
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
    const { acquireShadowStyles } = await import('/src/shadow-styles.js');
    const { runtimeState } = await import('/src/runtime-state.js');
    const state = window.__shadowRuntime;
    state.failShadowObserve();
    const styles = acquireShadowStyles(state.openRoot);
    let error;
    try {
      acquireShadowResources(state.openRoot, styles);
    } catch (cause) {
      error = {
        name: cause.name,
        code: cause.code,
        message: cause.details?.cause?.message,
      };
    }
    styles.release();
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

test('scope annotate owns the exact Shadow root while standalone annotate stays unscoped', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/annotation.js');
    const { group } = await import('/src/group.js');
    const { createShadowScope } = await import('/src/shadow.js');
    const state = window.__shadowRuntime;
    const target = state.openRoot.querySelector('#open-target');
    Object.defineProperty(target, 'getRootNode', {
      configurable: true,
      value: () => document,
    });
    const scope = createShadowScope(state.openRoot);
    const controller = scope.annotate(target, {
      mark: 'underline',
      trigger: 'manual',
      motion: 'never',
    });
    let standalone;
    try {
      annotate(target, {
        mark: 'underline',
        trigger: 'manual',
        motion: 'never',
      });
    } catch (error) {
      standalone = { name: error.name, code: error.code };
    }
    let standaloneGroup;
    try {
      const leaked = group([{
        target,
        mark: 'underline',
      }], { motion: 'never' });
      standaloneGroup = { returned: true };
      leaked.destroy();
    } catch (error) {
      standaloneGroup = { name: error.name, code: error.code };
    }
    const before = {
      rootPortalCount: document.querySelectorAll('[data-hana-shadow-overlay]').length,
      documentPortalCount: document.querySelectorAll(
        '[data-hana-overlay]:not([data-hana-shadow-overlay])',
      ).length,
      groupCount: document.querySelectorAll(
        '[data-hana-shadow-overlay] [data-hana-id]',
      ).length,
      controllerState: controller.state,
    };
    scope.destroy();
    let afterDestroy;
    try {
      scope.annotate(target, {
        mark: 'underline',
        trigger: 'manual',
        motion: 'never',
      });
    } catch (error) {
      afterDestroy = { name: error.name, code: error.code };
    }
    return {
      before,
      standalone,
      standaloneGroup,
      afterDestroy,
      controllerState: controller.state,
      portals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
    };
  });

  expect(result).toEqual({
    before: {
      rootPortalCount: 1,
      documentPortalCount: 0,
      groupCount: 1,
      controllerState: 'idle',
    },
    standalone: {
      name: 'HanamaruTargetError',
      code: 'HANA_TARGET_SHADOW_UNSCOPED',
    },
    standaloneGroup: {
      name: 'HanamaruTargetError',
      code: 'HANA_TARGET_SHADOW_UNSCOPED',
    },
    afterDestroy: {
      name: 'HanamaruStateError',
      code: 'HANA_STATE_SHADOW_SCOPE',
    },
    controllerState: 'destroyed',
    portals: 0,
  });
});

test('scope destroy is terminal, reverse ordered, idempotent, and releases after cleanup failures', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const state = window.__shadowRuntime;
    const target = state.openRoot.querySelector('#open-target');
    const scope = createShadowScope(state.openRoot);
    const calls = [];
    const first = scope.annotate(target, {
      mark: 'underline',
      trigger: 'manual',
      motion: 'never',
    });
    const second = scope.annotate(target, {
      mark: 'box',
      trigger: 'manual',
      motion: 'never',
    });
    const firstDestroy = first.destroy;
    const secondDestroy = second.destroy;
    first.destroy = () => {
      calls.push('first');
      return firstDestroy();
    };
    second.destroy = () => {
      calls.push('second');
      secondDestroy();
      throw new Error('second cleanup failed');
    };
    let failure;
    try {
      scope.destroy();
    } catch (error) {
      failure = {
        name: error.name,
        code: error.code,
        cause: error.details?.cause?.message,
      };
    }
    const afterFirstDestroy = {
      calls: [...calls],
      states: [first.state, second.state],
      portals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
      styles: state.openRoot.querySelectorAll('[data-hana-shadow-style]').length,
    };
    const returned = scope.destroy();
    return {
      failure,
      afterFirstDestroy,
      sameScope: returned === scope,
      calls,
    };
  });

  expect(result).toEqual({
    failure: {
      name: 'HanamaruStateError',
      code: 'HANA_STATE_SHADOW_SCOPE',
      cause: 'second cleanup failed',
    },
    afterFirstDestroy: {
      calls: ['second', 'first'],
      states: ['destroyed', 'destroyed'],
      portals: 0,
      styles: 0,
    },
    sameScope: true,
    calls: ['second', 'first'],
  });
});

test('scope scan stays in the exact root and owns every returned annotation once', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const state = window.__shadowRuntime;
    const target = state.openRoot.querySelector('#open-target');
    target.dataset.hana = 'underline';
    target.dataset.hanaMotion = 'never';
    const nestedHost = state.openRoot.appendChild(document.createElement('div'));
    const nestedRoot = nestedHost.attachShadow({ mode: 'open' });
    nestedRoot.innerHTML = '<button data-hana="box">Nested must not scan</button>';
    const scope = createShadowScope(state.openRoot);
    const scanned = scope.scan();
    const before = {
      annotations: scanned.annotations.length,
      errors: scanned.errors.length,
      groups: document.querySelectorAll(
        '[data-hana-shadow-overlay] .hana-annotation',
      ).length,
    };
    scanned.annotations[0].destroy();
    scope.destroy();
    return {
      before,
      state: scanned.annotations[0].state,
      portals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
    };
  });

  expect(result).toEqual({
    before: { annotations: 1, errors: 0, groups: 1 },
    state: 'destroyed',
    portals: 0,
  });
});

test('standalone scan rejects empty open and retained closed ShadowRoots upfront', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { scan } = await import('/src/declarative.js');
    const { createShadowScope } = await import('/src/shadow.js');
    const { runtimeState } = await import('/src/runtime-state.js');
    const state = window.__shadowRuntime;
    const failures = [];
    for (const root of [state.openRoot, state.closedRoot]) {
      try {
        scan(root);
      } catch (error) {
        failures.push({
          name: error.name,
          code: error.code,
        });
      }
    }
    const resourcesAfterStandalone = [
      runtimeState.shadows.has(state.openRoot),
      runtimeState.shadows.has(state.closedRoot),
    ];
    const openScope = createShadowScope(state.openRoot);
    const closedScope = createShadowScope(state.closedRoot);
    const scoped = [openScope.scan(), closedScope.scan()].map((value) => ({
      annotations: value.annotations.length,
      errors: value.errors.length,
    }));
    closedScope.destroy();
    openScope.destroy();
    return {
      failures,
      resourcesAfterStandalone,
      scoped,
      portals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
    };
  });

  expect(result).toEqual({
    failures: [
      {
        name: 'HanamaruTargetError',
        code: 'HANA_TARGET_SHADOW_UNSCOPED',
      },
      {
        name: 'HanamaruTargetError',
        code: 'HANA_TARGET_SHADOW_UNSCOPED',
      },
    ],
    resourcesAfterStandalone: [false, false],
    scoped: [
      { annotations: 0, errors: 0 },
      { annotations: 0, errors: 0 },
    ],
    portals: 0,
  });
});

test('scope Story and Group preflight exact roots and dispatch composed events outside the host', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { story: standaloneStory } = await import('/src/story.js');
    const { createShadowScope } = await import('/src/shadow.js');
    const state = window.__shadowRuntime;
    const target = state.openRoot.querySelector('#open-target');
    const foreign = state.otherRoot.querySelector('#other-target');
    const scope = createShadowScope(state.openRoot);
    const observed = [];
    for (const type of ['hana:start', 'hana:complete']) {
      document.addEventListener(type, (event) => {
        observed.push({
          type,
          composed: event.composed,
          bubbles: event.bubbles,
          targetIsHost: event.target === state.openHost,
        });
      });
    }
    const walkthrough = scope.story([{
      target,
      mark: 'underline',
      duration: 0,
    }], { motion: 'never', gap: 0 });
    walkthrough.play();
    await walkthrough.finished;
    const simultaneous = scope.group([{
      target,
      mark: 'box',
      duration: 0,
    }], { motion: 'never' });
    simultaneous.show();
    await simultaneous.finished;
    let foreignFailure;
    try {
      scope.story([
        { target, mark: 'underline' },
        { target: foreign, mark: 'box' },
      ], { motion: 'never' });
    } catch (error) {
      foreignFailure = { name: error.name, code: error.code };
    }
    let standalone;
    try {
      standaloneStory([{
        target,
        mark: 'underline',
      }], { motion: 'never' });
    } catch (error) {
      standalone = { name: error.name, code: error.code };
    }
    const before = {
      storyState: walkthrough.state,
      groupState: simultaneous.state,
      groupSize: simultaneous.size,
      groups: document.querySelectorAll(
        '[data-hana-shadow-overlay] .hana-annotation',
      ).length,
    };
    scope.destroy();
    return {
      before,
      after: {
        storyState: walkthrough.state,
        groupState: simultaneous.state,
        portals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
      },
      foreignFailure,
      standalone,
      observed,
    };
  });

  expect(result.before).toEqual({
    storyState: 'complete',
    groupState: 'visible',
    groupSize: 1,
    groups: 2,
  });
  expect(result.after).toEqual({
    storyState: 'destroyed',
    groupState: 'destroyed',
    portals: 0,
  });
  expect(result.foreignFailure).toEqual({
    name: 'HanamaruTargetError',
    code: 'HANA_TARGET_INVALID',
  });
  expect(result.standalone).toEqual({
    name: 'HanamaruTargetError',
    code: 'HANA_TARGET_SHADOW_UNSCOPED',
  });
  expect(result.observed).toEqual(expect.arrayContaining([
    {
      type: 'hana:start',
      composed: true,
      bubbles: true,
      targetIsHost: true,
    },
    {
      type: 'hana:complete',
      composed: true,
      bubbles: true,
      targetIsHost: true,
    },
  ]));
});

test('scope Selection uses the owner view, enforces the exact root, and owns its cloned Range controller', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const state = window.__shadowRuntime;
    const target = state.openRoot.querySelector('#open-target');
    const text = target.firstChild;
    const source = document.createRange();
    source.setStart(text, 0);
    source.setEnd(text, text.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(source);
    const scope = createShadowScope(state.openRoot);
    const controller = scope.annotateSelection({
      mark: 'highlight',
      motion: 'never',
    });
    const retainedText = source.toString();
    selection.removeAllRanges();
    const foreign = state.otherRoot.querySelector('#other-target');
    const foreignRange = document.createRange();
    foreignRange.selectNodeContents(foreign);
    selection.addRange(foreignRange);
    let wrongRoot;
    try {
      scope.annotateSelection({
        mark: 'underline',
        motion: 'never',
      }, selection);
    } catch (error) {
      wrongRoot = { name: error.name, code: error.code };
    }
    const before = {
      controllerState: controller.state,
      retainedText,
      selectionText: selection.toString(),
      groups: document.querySelectorAll(
        '[data-hana-shadow-overlay] .hana-annotation',
      ).length,
    };
    scope.destroy();
    selection.removeAllRanges();
    return {
      before,
      wrongRoot,
      after: {
        state: controller.state,
        portals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
      },
    };
  });

  expect(result).toEqual({
    before: {
      controllerState: 'idle',
      retainedText: 'Open target',
      selectionText: 'Other target',
      groups: 1,
    },
    wrongRoot: {
      name: 'HanamaruTargetError',
      code: 'HANA_TARGET_INVALID',
    },
    after: { state: 'destroyed', portals: 0 },
  });
});

test('scope serialized resolution clones Ranges and restore preflights atomically in the exact root', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { serialize } = await import('/src/serialize.js');
    const { createShadowScope } = await import('/src/shadow.js');
    const state = window.__shadowRuntime;
    const target = state.openRoot.querySelector('#open-target');
    const source = document.createRange();
    source.selectNodeContents(target);
    const calls = [];
    const scope = createShadowScope(state.openRoot);
    const selected = scope.resolveSerializedTarget({
      type: 'selector',
      selector: '#open-target',
    });
    const clone = scope.resolveSerializedTarget({
      type: 'key',
      key: 'open-range',
      targetKind: 'range',
    }, {
      resolveTarget(key, context) {
        calls.push({ key, keys: Object.keys(context), ...context });
        return source;
      },
    });
    const restored = scope.restore({
      schema: 'hanamaru/v1',
      kind: 'annotation',
      target: { type: 'selector', selector: '#open-target' },
      options: {
        mark: 'circle',
        note: null,
        placement: 'auto',
        trigger: 'manual',
        accessible: false,
        seed: 'shadow-restore',
        duration: 0,
        motion: 'never',
      },
    });
    const restoredDefinition = serialize(restored);
    const restoreCalls = [];
    scope.restore({
      schema: 'hanamaru/v1',
      kind: 'group',
      options: { trigger: 'manual', motion: 'never' },
      members: [
        {
          target: { type: 'key', key: 'direct', targetKind: 'element' },
          options: {
            mark: 'underline',
            note: null,
            placement: 'auto',
            accessible: false,
            seed: 'direct-member',
            duration: 0,
          },
        },
        {
          target: {
            type: 'locator',
            within: { type: 'key', key: 'within', targetKind: 'element' },
            text: 'Open target',
          },
          options: {
            mark: 'box',
            note: null,
            placement: 'auto',
            accessible: false,
            seed: 'locator-member',
            duration: 0,
          },
        },
      ],
    }, {
      resolveTarget(key, context) {
        restoreCalls.push({ key, keys: Object.keys(context), ...context });
        return target;
      },
    });
    const beforeFailure = document.querySelectorAll(
      '[data-hana-shadow-overlay] .hana-annotation',
    ).length;
    let atomicFailure;
    try {
      scope.restore({
        schema: 'hanamaru/v1',
        kind: 'group',
        options: { trigger: 'manual', motion: 'never' },
        members: [
          {
            target: { type: 'selector', selector: '#open-target' },
            options: {
              mark: 'underline',
              note: null,
              placement: 'auto',
              accessible: false,
              seed: 'first',
              duration: 0,
            },
          },
          {
            target: { type: 'key', key: 'foreign', targetKind: 'element' },
            options: {
              mark: 'box',
              note: null,
              placement: 'auto',
              accessible: false,
              seed: 'second',
              duration: 0,
            },
          },
        ],
      }, {
        resolveTarget(key) {
          if (key === 'foreign') {
            return state.otherRoot.querySelector('#other-target');
          }
          return null;
        },
      });
    } catch (error) {
      atomicFailure = { name: error.name, code: error.code };
    }
    const afterFailure = document.querySelectorAll(
      '[data-hana-shadow-overlay] .hana-annotation',
    ).length;
    scope.destroy();
    return {
      selectorExact: selected === target,
      range: {
        distinct: clone !== source,
        text: clone.toString(),
        root: clone.startContainer.getRootNode() === state.openRoot,
      },
      calls,
      restoreCalls,
      restored: {
        target: restoredDefinition.target,
        state: restored.state,
      },
      atomic: { beforeFailure, afterFailure, failure: atomicFailure },
      cleanup: document.querySelectorAll('[data-hana-shadow-overlay]').length,
    };
  });

  expect(result).toEqual({
    selectorExact: true,
    range: { distinct: true, text: 'Open target', root: true },
    calls: [{
      key: 'open-range',
      keys: ['targetKind', 'role', 'controllerKind', 'index'],
      targetKind: 'range',
      role: 'target',
      controllerKind: null,
      index: null,
    }],
    restoreCalls: [
      {
        key: 'direct',
        keys: ['targetKind', 'role', 'controllerKind', 'index'],
        targetKind: 'element',
        role: 'target',
        controllerKind: 'group',
        index: 0,
      },
      {
        key: 'within',
        keys: ['targetKind', 'role', 'controllerKind', 'index'],
        targetKind: 'element',
        role: 'within',
        controllerKind: 'group',
        index: 1,
      },
    ],
    restored: {
      target: { type: 'selector', selector: '#open-target' },
      state: 'destroyed',
    },
    atomic: {
      beforeFailure: 3,
      afterFailure: 3,
      failure: {
        name: 'HanamaruTargetError',
        code: 'HANA_TARGET_INVALID',
      },
    },
    cleanup: 0,
  });
});

test('scope exposes exactly eight enumerable functions and compatible scopes own controllers independently', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const { runtimeState } = await import('/src/runtime-state.js');
    const state = window.__shadowRuntime;
    const target = state.openRoot.querySelector('#open-target');
    const first = createShadowScope(state.openRoot);
    const second = createShadowScope(state.openRoot);
    const firstController = first.annotate(target, {
      mark: 'underline',
      motion: 'never',
    });
    const secondController = second.annotate(target, {
      mark: 'box',
      motion: 'never',
    });
    const surface = {
      keys: Object.keys(first).sort(),
      functions: Object.values(first).every((value) => typeof value === 'function'),
    };
    const shared = {
      styleRefs: runtimeState.shadows.get(state.openRoot)?.styles.count,
      resourceRefs: runtimeState.shadows.get(state.openRoot)?.resources.count,
      portals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
    };
    first.destroy();
    const afterFirst = {
      first: firstController.state,
      second: secondController.state,
      portalConnected: document.querySelector(
        '[data-hana-shadow-overlay]',
      )?.isConnected ?? false,
      groups: document.querySelectorAll(
        '[data-hana-shadow-overlay] .hana-annotation',
      ).length,
    };
    secondController.destroy();
    second.destroy();
    return {
      surface,
      shared,
      afterFirst,
      afterFinal: {
        second: secondController.state,
        portals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
        rootState: runtimeState.shadows.has(state.openRoot),
      },
    };
  });

  expect(result).toEqual({
    surface: {
      keys: [
        'annotate',
        'annotateSelection',
        'destroy',
        'group',
        'resolveSerializedTarget',
        'restore',
        'scan',
        'story',
      ],
      functions: true,
    },
    shared: { styleRefs: 2, resourceRefs: 2, portals: 1 },
    afterFirst: {
      first: 'destroyed',
      second: 'idle',
      portalConnected: true,
      groups: 1,
    },
    afterFinal: {
      second: 'destroyed',
      portals: 0,
      rootState: false,
    },
  });
});

test('scope confines open, retained closed, nested, and iframe roots without borrowing ownership', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const state = window.__shadowRuntime;
    const nestedHost = state.openRoot.appendChild(document.createElement('div'));
    const nestedRoot = nestedHost.attachShadow({ mode: 'open' });
    nestedRoot.innerHTML = '<button id="nested-target">Nested target</button>';
    const roots = [
      ['closed', state.closedRoot, '#closed-target'],
      ['nested', nestedRoot, '#nested-target'],
      ['iframe', state.frameRoot, '#frame-target'],
    ];
    const controllers = [];
    const scopes = [];
    for (const [, root, selector] of roots) {
      const scope = createShadowScope(root);
      scopes.push(scope);
      controllers.push(scope.annotate(selector, {
        mark: 'circle',
        motion: 'never',
      }));
    }
    const outer = createShadowScope(state.openRoot);
    let nestedFailure;
    try {
      outer.annotate(nestedRoot.querySelector('#nested-target'), {
        mark: 'underline',
        motion: 'never',
      });
    } catch (error) {
      nestedFailure = { name: error.name, code: error.code };
    }
    const frameDocument = state.frameRoot.ownerDocument;
    const before = {
      states: controllers.map((controller) => controller.state),
      mainPortals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
      framePortals: frameDocument.querySelectorAll(
        '[data-hana-shadow-overlay]',
      ).length,
      mainGroups: document.querySelectorAll(
        '[data-hana-shadow-overlay] .hana-annotation',
      ).length,
      frameGroups: frameDocument.querySelectorAll(
        '[data-hana-shadow-overlay] .hana-annotation',
      ).length,
    };
    outer.destroy();
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      scopes[index].destroy();
    }
    return {
      before,
      nestedFailure,
      after: {
        states: controllers.map((controller) => controller.state),
        mainPortals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
        framePortals: frameDocument.querySelectorAll(
          '[data-hana-shadow-overlay]',
        ).length,
      },
    };
  });

  expect(result).toEqual({
    before: {
      states: ['idle', 'idle', 'idle'],
      mainPortals: 3,
      framePortals: 1,
      mainGroups: 2,
      frameGroups: 1,
    },
    nestedFailure: {
      name: 'HanamaruTargetError',
      code: 'HANA_TARGET_INVALID',
    },
    after: {
      states: ['destroyed', 'destroyed', 'destroyed'],
      mainPortals: 0,
      framePortals: 0,
    },
  });
});

test('scope acquisition failure rolls back styles, resources, portals, and root slots', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const { runtimeState } = await import('/src/runtime-state.js');
    const state = window.__shadowRuntime;
    const beforeSheets = state.openRoot.adoptedStyleSheets.length;
    state.failShadowObserve();
    let failure;
    try {
      createShadowScope(state.openRoot);
    } catch (error) {
      failure = {
        name: error.name,
        code: error.code,
        cause: error.details?.cause?.message,
      };
    }
    return {
      failure,
      rootState: runtimeState.shadows.has(state.openRoot),
      documentState: runtimeState.documents.has(document),
      portals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
      styleNodes: state.openRoot.querySelectorAll(
        '[data-hana-shadow-style]',
      ).length,
      sheetDelta: state.openRoot.adoptedStyleSheets.length - beforeSheets,
    };
  });

  expect(result).toEqual({
    failure: {
      name: 'HanamaruStateError',
      code: 'HANA_STATE_SHADOW_RESOURCES',
      cause: 'forced ShadowRoot observe failure',
    },
    rootState: false,
    documentState: false,
    portals: 0,
    styleNodes: 0,
    sheetDelta: 0,
  });
});

test('scope serialized resolver cannot return after its callback destroys the scope', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const state = window.__shadowRuntime;
    const target = state.openRoot.querySelector('#open-target');
    const scope = createShadowScope(state.openRoot);
    let failure;
    try {
      scope.resolveSerializedTarget({
        type: 'key',
        key: 'destroy-during-resolve',
        targetKind: 'element',
      }, {
        resolveTarget() {
          scope.destroy();
          return target;
        },
      });
    } catch (error) {
      failure = { name: error.name, code: error.code };
    }
    return {
      failure,
      portals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
    };
  });

  expect(result).toEqual({
    failure: {
      name: 'HanamaruStateError',
      code: 'HANA_STATE_SHADOW_SCOPE',
    },
    portals: 0,
  });
});

test('scope option reflection failures stay typed and allocate no root resources', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const { runtimeState } = await import('/src/runtime-state.js');
    const state = window.__shadowRuntime;
    const cause = new Error('scope ownKeys failed');
    let failure;
    try {
      createShadowScope(state.openRoot, new Proxy({}, {
        ownKeys() { throw cause; },
      }));
    } catch (error) {
      failure = {
        name: error.name,
        code: error.code,
        cause: error.details?.cause?.message,
      };
    }
    return {
      failure,
      rootState: runtimeState.shadows.has(state.openRoot),
      portals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
    };
  });

  expect(result).toEqual({
    failure: {
      name: 'HanamaruConfigError',
      code: 'HANA_CONFIG_INVALID',
      cause: 'scope ownKeys failed',
    },
    rootState: false,
    portals: 0,
  });
});

test('standalone Element Range and locator refresh reject targets moved into a ShadowRoot', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/annotation.js');
    const state = window.__shadowRuntime;
    const element = document.body.appendChild(document.createElement('button'));
    element.textContent = 'Direct document target';
    const rangeOwner = document.body.appendChild(document.createElement('p'));
    rangeOwner.textContent = 'Range document target';
    const locatorOwner = document.body.appendChild(document.createElement('p'));
    locatorOwner.textContent = 'Locator document target';
    const selector = document.body.appendChild(document.createElement('button'));
    selector.id = 'selector-root-guard';
    selector.textContent = 'Initial selector target';
    const range = document.createRange();
    range.selectNodeContents(rangeOwner);
    const controllers = [
      annotate(element, { mark: 'underline', duration: 0, motion: 'never' }),
      annotate(range, { mark: 'highlight', duration: 0, motion: 'never' }),
      annotate({
        within: locatorOwner,
        text: 'Locator document target',
      }, { mark: 'box', duration: 0, motion: 'never' }),
    ];
    const selectorController = annotate('#selector-root-guard', {
      mark: 'circle',
      duration: 0,
      motion: 'never',
    });
    state.openRoot.append(element, rangeOwner, locatorOwner, selector);
    const selectorReplacement = document.body.appendChild(document.createElement('button'));
    selectorReplacement.id = 'selector-root-guard';
    selectorReplacement.textContent = 'Replacement selector target';

    const moved = [];
    for (const controller of controllers) {
      let threw = false;
      try { controller.show(); } catch { threw = true; }
      const error = await controller.finished.catch((cause) => cause);
      moved.push({
        threw,
        state: controller.state,
        code: error?.code,
      });
    }
    selectorController.show();
    await selectorController.finished;
    const visibleGroups = [...document.querySelectorAll(
      '[data-hana-overlay]:not([data-hana-shadow-overlay]) .hana-annotation',
    )].filter((group) => !group.hasAttribute('hidden')).length;
    const selectorState = selectorController.state;
    for (const controller of [...controllers, selectorController]) {
      controller.destroy();
    }
    element.remove();
    rangeOwner.remove();
    locatorOwner.remove();
    selector.remove();
    selectorReplacement.remove();
    return {
      moved,
      selectorState,
      visibleGroups,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    };
  });

  expect(result).toEqual({
    moved: [
      { threw: false, state: 'suspended', code: 'HANA_TARGET_SHADOW_UNSCOPED' },
      { threw: false, state: 'suspended', code: 'HANA_TARGET_SHADOW_UNSCOPED' },
      { threw: false, state: 'suspended', code: 'HANA_TARGET_SHADOW_UNSCOPED' },
    ],
    selectorState: 'visible',
    visibleGroups: 1,
    overlays: 0,
  });
});

test('standalone Story and restored controllers keep the live ShadowRoot refresh guard', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/annotation.js');
    const { story } = await import('/src/story.js');
    const { restore, serialize } = await import('/src/serialize.js');
    const state = window.__shadowRuntime;
    const storyTarget = document.body.appendChild(document.createElement('button'));
    storyTarget.textContent = 'Story document target';
    const restoreTarget = document.body.appendChild(document.createElement('button'));
    restoreTarget.textContent = 'Restored document target';
    const walkthrough = story([{
      target: storyTarget,
      mark: 'underline',
      duration: 0,
    }], { gap: 0, motion: 'never' });
    const source = annotate(restoreTarget, {
      mark: 'box',
      duration: 0,
      motion: 'never',
    });
    const definition = serialize(source, {
      keyForTarget() { return 'restored-target'; },
    });
    source.destroy();
    const restored = restore(definition, {
      root: document,
      resolveTarget(key) {
        return key === 'restored-target' ? restoreTarget : null;
      },
    });
    state.openRoot.append(storyTarget, restoreTarget);

    let storyThrew = false;
    try { walkthrough.play(); } catch { storyThrew = true; }
    const storyError = await walkthrough.finished.catch((error) => error);
    let restoredThrew = false;
    try { restored.show(); } catch { restoredThrew = true; }
    const restoredError = await restored.finished.catch((error) => error);
    const beforeDestroy = {
      story: {
        threw: storyThrew,
        state: walkthrough.state,
        code: storyError?.code,
      },
      restored: {
        threw: restoredThrew,
        state: restored.state,
        code: restoredError?.code,
      },
    };
    restored.destroy();
    walkthrough.destroy();
    storyTarget.remove();
    restoreTarget.remove();
    return {
      beforeDestroy,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    };
  });

  expect(result).toEqual({
    beforeDestroy: {
      story: {
        threw: false,
        state: 'cancelled',
        code: 'HANA_TARGET_SHADOW_UNSCOPED',
      },
      restored: {
        threw: false,
        state: 'suspended',
        code: 'HANA_TARGET_SHADOW_UNSCOPED',
      },
    },
    overlays: 0,
  });
});

test('scoped lifecycle errors escape through the host after targets leave their root', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const state = window.__shadowRuntime;
    const scope = createShadowScope(state.openRoot);
    const observed = [];
    const onError = (event) => {
      observed.push({
        bubbles: event.bubbles,
        composed: event.composed,
        targetIsHost: event.target === state.openHost,
        controller: event.detail.controller,
        code: event.detail.error?.code,
      });
    };
    document.addEventListener('hana:error', onError);

    const cases = [];
    for (const mode of ['remove', 'move']) {
      const target = state.openRoot.appendChild(document.createElement('button'));
      target.textContent = `${mode} scoped target`;
      const controller = scope.annotate(target, {
        mark: 'underline',
        duration: 0,
        motion: 'never',
      });
      if (mode === 'remove') target.remove();
      else document.body.append(target);
      let threw = false;
      try { controller.show(); } catch { threw = true; }
      const firstError = await controller.finished.catch((error) => error);
      try { controller.show(); } catch { threw = true; }
      const secondError = await controller.finished.catch((error) => error);
      cases.push({
        mode,
        threw,
        state: controller.state,
        firstCode: firstError?.code,
        secondCode: secondError?.code,
        matchingEvents: observed.filter(
          (event) => event.controller === controller,
        ).length,
      });
      controller.destroy();
      target.remove();
    }
    document.removeEventListener('hana:error', onError);
    scope.destroy();
    return {
      cases,
      observed: observed.map(({ controller, ...event }) => event),
      portals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
    };
  });

  expect(result).toEqual({
    cases: [
      {
        mode: 'remove',
        threw: false,
        state: 'suspended',
        firstCode: 'HANA_TARGET_INVALID',
        secondCode: 'HANA_TARGET_INVALID',
        matchingEvents: 1,
      },
      {
        mode: 'move',
        threw: false,
        state: 'suspended',
        firstCode: 'HANA_TARGET_INVALID',
        secondCode: 'HANA_TARGET_INVALID',
        matchingEvents: 1,
      },
    ],
    observed: [
      {
        bubbles: true,
        composed: true,
        targetIsHost: true,
        code: 'HANA_TARGET_INVALID',
      },
      {
        bubbles: true,
        composed: true,
        targetIsHost: true,
        code: 'HANA_TARGET_INVALID',
      },
    ],
    portals: 0,
  });
});
