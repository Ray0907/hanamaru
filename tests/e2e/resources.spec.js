import { expect, test } from '@playwright/test';

async function installInstrumentation(page, { resize = true, intersection = true } = {}) {
  await page.evaluate(({ hasResize, hasIntersection }) => {
    const state = {
      listeners: [],
      removals: [],
      resizeObservers: [],
      mutationObservers: [],
      intersectionObservers: [],
      frames: new Map(),
      canceledFrames: [],
    };

    const label = (target) => {
      if (target === window) return 'window';
      if (target === document) return 'document';
      if (target instanceof Element) return target.id || target.tagName.toLowerCase();
      return target?.constructor?.name ?? 'unknown';
    };
    const originalAdd = EventTarget.prototype.addEventListener;
    const originalRemove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
      state.listeners.push({ target: label(this), type, options });
      return originalAdd.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function removeEventListener(type, listener, options) {
      state.removals.push({ target: label(this), type, options });
      return originalRemove.call(this, type, listener, options);
    };

    let nextFrameId = 1;
    window.requestAnimationFrame = (callback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      state.frames.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      state.canceledFrames.push(id);
      state.frames.delete(id);
    };
    state.runFrame = () => {
      const entry = state.frames.entries().next().value;
      if (entry === undefined) return false;
      const [id, callback] = entry;
      state.frames.delete(id);
      callback(performance.now());
      return true;
    };

    class FakeResizeObserver {
      constructor(callback) {
        this.callback = callback;
        this.observed = new Set();
        this.unobserved = [];
        this.disconnected = false;
        state.resizeObservers.push(this);
      }
      observe(target) { this.observed.add(target); }
      unobserve(target) { this.observed.delete(target); this.unobserved.push(target); }
      disconnect() { this.disconnected = true; this.observed.clear(); }
      deliver(targets) { this.callback(targets.map((target) => ({ target })), this); }
    }

    class FakeMutationObserver {
      constructor(callback) {
        this.callback = callback;
        this.observations = [];
        this.disconnected = false;
        state.mutationObservers.push(this);
      }
      observe(target, options) { this.observations.push({ target, options }); }
      disconnect() { this.disconnected = true; }
      deliver(records) { this.callback(records, this); }
    }

    class FakeIntersectionObserver {
      constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        this.observed = new Set();
        this.disconnected = false;
        state.intersectionObservers.push(this);
      }
      observe(target) { this.observed.add(target); }
      unobserve(target) { this.observed.delete(target); }
      disconnect() { this.disconnected = true; this.observed.clear(); }
      deliver(entries) { this.callback(entries, this); }
    }

    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: hasResize ? FakeResizeObserver : undefined,
    });
    Object.defineProperty(window, 'MutationObserver', {
      configurable: true,
      writable: true,
      value: FakeMutationObserver,
    });
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      writable: true,
      value: hasIntersection ? FakeIntersectionObserver : undefined,
    });
    window.__resources = state;
  }, { hasResize: resize, hasIntersection: intersection });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/resources.html');
});

test('shared ownership keeps one document root and observer set until the final lease releases', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const first = acquireDocumentResources(document);
    const second = acquireDocumentResources(document);
    const state = window.__resources;
    const overlay = first.shared.overlay;
    const svg = first.shared.svgLayer;
    const note = first.shared.noteLayer;
    const before = {
      sameShared: first.shared === second.shared,
      sameRoot: overlay === second.shared.overlay,
      ownInterface: Object.keys(first.shared).sort(),
      methodInterface: Object.getOwnPropertyNames(Object.getPrototypeOf(first.shared))
        .filter((name) => name !== 'constructor').sort(),
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      svgs: document.querySelectorAll('[data-hana-svg-layer]').length,
      notes: document.querySelectorAll('[data-hana-note-layer]').length,
      hierarchy: overlay.contains(svg) && overlay.contains(note),
      svgAriaHidden: svg.getAttribute('aria-hidden'),
      rootAriaHidden: overlay.hasAttribute('aria-hidden'),
      noteAriaHidden: note.hasAttribute('aria-hidden'),
      namespaced: [overlay, svg, note].every((node) => [...node.classList].every((name) => name.startsWith('hana-')))
        && [overlay, svg, note].every((node) => [...node.attributes].filter((attribute) => attribute.name.startsWith('data-')).every((attribute) => attribute.name.startsWith('data-hana-'))),
      resizeObservers: state.resizeObservers.length,
      mutationObservers: state.mutationObservers.length,
      windowResizeAdds: state.listeners.filter(({ target, type }) => target === 'window' && type === 'resize').length,
    };

    first.release();
    first.release();
    const afterFirst = {
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      resizeDisconnected: state.resizeObservers[0].disconnected,
      mutationDisconnected: state.mutationObservers[0].disconnected,
      windowResizeRemoves: state.removals.filter(({ target, type }) => target === 'window' && type === 'resize').length,
    };

    second.release();
    second.release();
    const afterSecond = {
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      resizeDisconnected: state.resizeObservers[0].disconnected,
      mutationDisconnected: state.mutationObservers[0].disconnected,
      windowResizeRemoves: state.removals.filter(({ target, type }) => target === 'window' && type === 'resize').length,
    };

    const third = acquireDocumentResources(document);
    const afterThird = {
      freshShared: third.shared !== first.shared,
      freshRoot: third.shared.overlay !== overlay,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      resizeObservers: state.resizeObservers.length,
      mutationObservers: state.mutationObservers.length,
      windowResizeAdds: state.listeners.filter(({ target, type }) => target === 'window' && type === 'resize').length,
    };
    third.release();

    return { before, afterFirst, afterSecond, afterThird };
  });

  expect(result.before).toEqual({
    sameShared: true,
    sameRoot: true,
    ownInterface: ['noteLayer', 'overlay', 'svgLayer'],
    methodInterface: [
      'bumpGeneration',
      'enqueue',
      'generationFor',
      'notePlacementReservations',
      'observeIntersection',
      'observeLayout',
      'rebindLayout',
      'registerController',
      'releaseController',
      'reserveNotePlacement',
    ],
    overlays: 1,
    svgs: 1,
    notes: 1,
    hierarchy: true,
    svgAriaHidden: 'true',
    rootAriaHidden: false,
    noteAriaHidden: false,
    namespaced: true,
    resizeObservers: 1,
    mutationObservers: 1,
    windowResizeAdds: 1,
  });
  expect(result.afterFirst).toEqual({
    overlays: 1,
    resizeDisconnected: false,
    mutationDisconnected: false,
    windowResizeRemoves: 0,
  });
  expect(result.afterSecond).toEqual({
    overlays: 0,
    resizeDisconnected: true,
    mutationDisconnected: true,
    windowResizeRemoves: 1,
  });
  expect(result.afterThird).toEqual({
    freshShared: true,
    freshRoot: true,
    overlays: 1,
    resizeObservers: 2,
    mutationObservers: 2,
    windowResizeAdds: 2,
  });
});

test('visual viewport resize and scroll share layout refresh and final cleanup', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    const state = window.__resources;
    const target = document.querySelector('#direct-target');
    let writes = 0;
    shared.registerController('visual-viewport');
    shared.observeLayout({
      id: 'visual-viewport',
      generation: 0,
      record: { kind: 'element', element: target, ownerElement: target },
      note: null,
      read() { return ++writes; },
      write() {},
    });
    state.runFrame();

    const listeners = state.listeners
      .filter(({ target: label, type }) => label === 'VisualViewport'
        && (type === 'resize' || type === 'scroll'))
      .map(({ type }) => type)
      .sort();
    visualViewport.dispatchEvent(new Event('resize'));
    state.runFrame();
    visualViewport.dispatchEvent(new Event('scroll'));
    state.runFrame();
    shared.releaseController('visual-viewport');
    lease.release();
    const removals = state.removals
      .filter(({ target: label, type }) => label === 'VisualViewport'
        && (type === 'resize' || type === 'scroll'))
      .map(({ type }) => type)
      .sort();

    return { listeners, removals, writes };
  });

  expect(result).toEqual({
    listeners: ['resize', 'scroll'],
    removals: ['resize', 'scroll'],
    writes: 2,
  });
});

test('public queue keeps shared read/write ordering and rejects stale controller tokens', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    const state = window.__resources;
    const events = [];
    for (const id of ['alpha', 'beta', 'aba']) shared.registerController(id);

    for (const id of ['alpha', 'beta']) {
      shared.enqueue({
        id,
        generation: 0,
        read() { events.push(`read:${id}`); return id; },
        write(value) { events.push(`write:${value}`); },
      });
    }
    const immediate = [...events];
    state.runFrame();
    const ordered = [...events];

    shared.enqueue({
      id: 'alpha', generation: 0,
      read() { events.push('stale-read'); },
      write() { events.push('stale-write'); },
    });
    shared.bumpGeneration('alpha');
    state.runFrame();

    shared.enqueue({
      id: 'aba', generation: 0,
      read() {
        events.push('aba-read');
        shared.releaseController('aba');
        shared.registerController('aba');
        return 'old';
      },
      write() { events.push('aba-write'); },
    });
    state.runFrame();

    let staleError;
    try {
      shared.enqueue({ id: 'alpha', generation: 0, read() {}, write() {} });
    } catch (error) {
      staleError = error.message;
    }
    const finalEvents = [...events];
    for (const id of ['alpha', 'beta', 'aba']) shared.releaseController(id);
    lease.release();
    return { immediate, ordered, finalEvents, staleError };
  });

  expect(result).toEqual({
    immediate: [],
    ordered: ['read:alpha', 'read:beta', 'write:alpha', 'write:beta'],
    finalEvents: ['read:alpha', 'read:beta', 'write:alpha', 'write:beta', 'aba-read'],
    staleError: 'stale controller generation: alpha',
  });
});

test('frame placement reservations are ordered, controller-scoped, generation-safe, and ephemeral', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    const state = window.__resources;
    const rect = (x) => ({
      x, y: 20, width: 80, height: 30,
      top: 20, right: x + 80, bottom: 50, left: x,
    });
    const events = [];
    for (const id of ['alpha', 'beta', 'stale', 'cancelled']) shared.registerController(id);

    const outsideBefore = {
      accepted: shared.reserveNotePlacement('alpha', rect(10)),
      peers: shared.notePlacementReservations('beta'),
    };
    shared.enqueue({
      id: 'alpha', generation: 0,
      read() {
        events.push(`alpha-before:${shared.notePlacementReservations('alpha').length}`);
        events.push(`alpha-reserved:${shared.reserveNotePlacement('alpha', rect(10))}`);
        events.push(`alpha-after:${shared.notePlacementReservations('alpha').length}`);
        return 'alpha';
      },
      write(value) { events.push(`write:${value}`); },
    });
    shared.enqueue({
      id: 'beta', generation: 0,
      read() {
        const peers = shared.notePlacementReservations('beta');
        events.push(`beta-sees:${peers.map((entry) => entry.left).join(',')}`);
        events.push(`beta-reserved:${shared.reserveNotePlacement('beta', rect(120))}`);
        return 'beta';
      },
      write(value) { events.push(`write:${value}`); },
    });
    shared.enqueue({
      id: 'stale', generation: 0,
      read() {
        events.push('stale-read');
        shared.reserveNotePlacement('stale', rect(230));
      },
      write() { events.push('stale-write'); },
    });
    shared.bumpGeneration('stale');
    shared.enqueue({
      id: 'cancelled', generation: 0,
      read() {
        events.push('cancelled-read');
        shared.reserveNotePlacement('cancelled', rect(340));
      },
      write() { events.push('cancelled-write'); },
    });
    shared.releaseController('cancelled');
    state.runFrame();

    const outsideAfter = {
      accepted: shared.reserveNotePlacement('alpha', rect(450)),
      peers: shared.notePlacementReservations('beta'),
    };
    for (const id of ['alpha', 'beta', 'stale']) shared.releaseController(id);
    lease.release();
    return { events, outsideBefore, outsideAfter };
  });

  expect(result).toEqual({
    outsideBefore: { accepted: false, peers: [] },
    events: [
      'alpha-before:0',
      'alpha-reserved:true',
      'alpha-after:0',
      'beta-sees:10',
      'beta-reserved:true',
      'write:alpha',
      'write:beta',
    ],
    outsideAfter: { accepted: false, peers: [] },
  });
});

test('frame placement reservations stay isolated between documents', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const topLease = acquireDocumentResources(document);
    const frameLease = acquireDocumentResources(frame.contentDocument);
    const rectangle = (x) => ({
      x, y: 10, width: 60, height: 20,
      top: 10, right: x + 60, bottom: 30, left: x,
    });
    for (const shared of [topLease.shared, frameLease.shared]) {
      shared.registerController('first');
      shared.registerController('reader');
    }
    const observations = {};
    topLease.shared.enqueue({
      id: 'first', generation: 0,
      read() { topLease.shared.reserveNotePlacement('first', rectangle(10)); },
      write() {},
    });
    topLease.shared.enqueue({
      id: 'reader', generation: 0,
      read() {
        observations.top = topLease.shared.notePlacementReservations('reader').map(({ left }) => left);
        observations.frameDuringTop = frameLease.shared.notePlacementReservations('reader').length;
      },
      write() {},
    });
    frameLease.shared.enqueue({
      id: 'first', generation: 0,
      read() { frameLease.shared.reserveNotePlacement('first', rectangle(210)); },
      write() {},
    });
    frameLease.shared.enqueue({
      id: 'reader', generation: 0,
      read() {
        observations.frame = frameLease.shared.notePlacementReservations('reader').map(({ left }) => left);
      },
      write() {},
    });
    await Promise.all([
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      new Promise((resolve) => frame.contentWindow.requestAnimationFrame(
        () => frame.contentWindow.requestAnimationFrame(resolve),
      )),
    ]);
    observations.topAfter = topLease.shared.notePlacementReservations('reader').length;
    observations.frameAfter = frameLease.shared.notePlacementReservations('reader').length;
    for (const shared of [topLease.shared, frameLease.shared]) {
      shared.releaseController('first');
      shared.releaseController('reader');
    }
    topLease.release();
    frameLease.release();
    frame.remove();
    return observations;
  });

  expect(result).toEqual({
    top: [10],
    frameDuringTop: 0,
    frame: [210],
    topAfter: 0,
    frameAfter: 0,
  });
});

test('public queue keeps lifecycle and default channels independent for one controller', async ({ page }) => {
  await installInstrumentation(page);

  const events = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    const state = window.__resources;
    const output = [];
    shared.registerController('channel-owner');
    shared.enqueue({
      id: 'channel-owner', generation: 0,
      read() { output.push('read:default'); return 'default'; },
      write(value) { output.push(`write:${value}`); },
    });
    shared.enqueue({
      id: 'channel-owner', generation: 0, channel: 'lifecycle',
      read() { output.push('read:lifecycle'); return 'lifecycle'; },
      write(value) { output.push(`write:${value}`); },
    });
    state.runFrame();
    shared.releaseController('channel-owner');
    lease.release();
    return output;
  });

  expect(events).toEqual([
    'read:default',
    'read:lifecycle',
    'write:default',
    'write:lifecycle',
  ]);
});

test('registers controller generations and rejects invalid or duplicate IDs', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    const outcomes = [];
    for (const id of ['', null, {}, 'valid']) {
      try {
        outcomes.push(['ok', shared.registerController(id)]);
      } catch (error) {
        outcomes.push([error.name, error.message]);
      }
    }
    try {
      shared.registerController('valid');
    } catch (error) {
      outcomes.push([error.name, error.message]);
    }
    const before = shared.generationFor('valid');
    const bumped = shared.bumpGeneration('valid');
    const after = shared.generationFor('valid');
    shared.releaseController('valid');
    let missing;
    try { shared.generationFor('valid'); } catch (error) { missing = error.name; }
    lease.release();
    return { after, before, bumped, missing, outcomes };
  });

  expect(result.before).toBe(0);
  expect(result.bumped).toBe(1);
  expect(result.after).toBe(1);
  expect(result.missing).toBe('Error');
  expect(result.outcomes.map(([kind]) => kind)).toEqual(['TypeError', 'TypeError', 'TypeError', 'ok', 'Error']);
});

test('shares scroll and resize resources while routing signals by controller', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { resolveTarget } = await import('/src/target.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    const state = window.__resources;
    const note = document.querySelector('#rendered-note');
    const nativeRange = document.createRange();
    nativeRange.selectNodeContents(document.querySelector('#range-owner span'));
    const records = new Map([
      ['direct', resolveTarget(document.querySelector('#direct-target'))],
      ['selector', resolveTarget('#selector-target')],
      ['element-locator', resolveTarget({ within: document.querySelector('#element-locator'), text: 'element locator phrase' })],
      ['selector-locator', resolveTarget({ within: '#selector-locator', text: 'selector locator phrase' })],
      ['range', resolveTarget(nativeRange)],
    ]);
    const events = [];
    const unsubscribes = [];
    for (const [id, record] of records) {
      const generation = shared.registerController(id);
      unsubscribes.push(shared.observeLayout({
        id,
        generation,
        record,
        note,
        read() { events.push(`read:${id}`); return id; },
        write(value) { events.push(`write:${value}`); },
        onError(error) { events.push(`error:${id}:${error.message}`); },
      }));
    }

    const scrollAdds = state.listeners.filter(({ target: listenerTarget, type }) => (
      type === 'scroll' && listenerTarget !== 'VisualViewport'
    ));
    const observed = [...state.resizeObservers[0].observed].map((target) => target.id).sort();

    state.resizeObservers[0].deliver([document.querySelector('#direct-target')]);
    state.runFrame();
    const directEvents = events.splice(0);

    state.resizeObservers[0].deliver([note]);
    state.runFrame();
    const noteEvents = events.splice(0);

    document.querySelector('#inner-scroll').dispatchEvent(new Event('scroll'));
    state.runFrame();
    const scrollEvents = events.splice(0);

    unsubscribes[0]();
    unsubscribes[0]();
    const directUnobserved = state.resizeObservers[0].unobserved.filter((target) => target.id === 'direct-target').length;
    const noteStillObserved = state.resizeObservers[0].observed.has(note);
    for (const unsubscribe of unsubscribes.slice(1)) unsubscribe();
    const scrollRemovals = state.removals.filter(({ type }) => type === 'scroll');
    const observedAfter = [...state.resizeObservers[0].observed].map((target) => target.id).sort();
    for (const id of records.keys()) shared.releaseController(id);
    lease.release();

    return {
      directEvents,
      directUnobserved,
      noteEvents,
      noteStillObserved,
      observed,
      observedAfter,
      scrollAdds: scrollAdds.map(({ target, options }) => ({ target, passive: options?.passive === true })),
      scrollEvents,
      scrollRemovals: scrollRemovals.map(({ target }) => target),
    };
  });

  expect(result.scrollAdds).toEqual([
    { target: 'inner-scroll', passive: true },
    { target: 'outer-scroll', passive: true },
    { target: 'window', passive: true },
  ]);
  expect(result.observed).toEqual([
    'direct-target',
    'element-locator',
    'range-text',
    'rendered-note',
    'selector-locator',
    'selector-target',
  ]);
  expect(result.directEvents).toEqual(['read:direct', 'write:direct']);
  expect(result.noteEvents).toEqual([
    'read:direct', 'read:selector', 'read:element-locator', 'read:selector-locator', 'read:range',
    'write:direct', 'write:selector', 'write:element-locator', 'write:selector-locator', 'write:range',
  ]);
  expect(result.scrollEvents).toEqual(result.noteEvents);
  expect(result.directUnobserved).toBe(1);
  expect(result.noteStillObserved).toBe(true);
  expect(result.observedAfter).toEqual([]);
  expect(result.scrollRemovals.sort()).toEqual(['inner-scroll', 'outer-scroll', 'window']);
});

test('rebinds scroll ancestors and invalidates queued work when generation changes', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { resolveTarget } = await import('/src/target.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    const state = window.__resources;
    const target = document.querySelector('#direct-target');
    const record = resolveTarget(target);
    const events = [];
    const callbacks = (generation) => ({
      generation,
      record,
      note: null,
      read() { events.push(`read:${generation}`); return generation; },
      write(value) { events.push(`write:${value}`); },
      onError(error) { events.push(`error:${error.message}`); },
    });

    shared.registerController('moving');
    const oldUnsubscribe = shared.observeLayout({ id: 'moving', ...callbacks(0) });
    document.querySelector('#inner-scroll').dispatchEvent(new Event('scroll'));
    const pendingBeforeBump = state.frames.size;
    const generation = shared.bumpGeneration('moving');
    const pendingAfterBump = state.frames.size;
    target.remove();
    document.querySelector('#move-destination').append(target);
    record.refresh();
    const unsubscribe = shared.rebindLayout('moving', callbacks(generation));
    const addsAfterMove = state.listeners.filter(({ target: listenerTarget, type }) => (
      type === 'scroll' && listenerTarget !== 'VisualViewport'
    )).map(({ target: listenerTarget }) => listenerTarget);
    const removalsAfterMove = state.removals.filter(({ type }) => type === 'scroll').map(({ target: listenerTarget }) => listenerTarget);

    document.querySelector('#inner-scroll').dispatchEvent(new Event('scroll'));
    const oldAncestorQueued = state.frames.size;
    document.querySelector('#move-scroll').dispatchEvent(new Event('scroll'));
    state.runFrame();
    const movedEvents = events.splice(0);
    state.mutationObservers[0].deliver([{ target: document.querySelector('#direct-container') }]);
    state.runFrame();
    const oldMutationEvents = events.splice(0);
    state.mutationObservers[0].deliver([{ target }]);
    state.runFrame();
    const newMutationEvents = events.splice(0);
    oldUnsubscribe();
    document.querySelector('#move-scroll').dispatchEvent(new Event('scroll'));
    state.runFrame();
    const afterOldUnsubscribe = events.splice(0);
    unsubscribe();
    unsubscribe();
    shared.releaseController('moving');
    lease.release();
    return {
      addsAfterMove,
      afterOldUnsubscribe,
      canceledFrames: state.canceledFrames.length,
      movedEvents,
      newMutationEvents,
      oldAncestorQueued,
      oldMutationEvents,
      pendingAfterBump,
      pendingBeforeBump,
      removalsAfterMove,
    };
  });

  expect(result.pendingBeforeBump).toBe(1);
  expect(result.pendingAfterBump).toBe(0);
  expect(result.canceledFrames).toBe(1);
  expect(result.removalsAfterMove).toEqual(['inner-scroll', 'outer-scroll']);
  expect(result.addsAfterMove).toEqual(['inner-scroll', 'outer-scroll', 'window', 'move-scroll']);
  expect(result.oldAncestorQueued).toBe(0);
  expect(result.movedEvents).toEqual(['read:1', 'write:1']);
  expect(result.oldMutationEvents).toEqual([]);
  expect(result.newMutationEvents).toEqual(['read:1', 'write:1']);
  expect(result.afterOldUnsubscribe).toEqual(['read:1', 'write:1']);
});

test('rebinds a refreshed selector from its old resize target to its replacement', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { resolveTarget } = await import('/src/target.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    const state = window.__resources;
    const record = resolveTarget('#selector-target');
    const oldTarget = record.element;
    const events = [];
    shared.registerController('replacement');
    const oldUnsubscribe = shared.observeLayout({
      id: 'replacement',
      generation: 0,
      record,
      read() { events.push('read'); return 'replacement'; },
      write(value) { events.push(`write:${value}`); },
    });
    const newTarget = Object.assign(document.createElement('p'), {
      id: 'selector-target',
      textContent: 'Replacement selector target',
    });
    oldTarget.replaceWith(newTarget);
    record.refresh();
    const generation = shared.bumpGeneration('replacement');
    const unsubscribe = shared.rebindLayout('replacement', {
      generation,
      record,
      read() { events.push('read'); return 'replacement'; },
      write(value) { events.push(`write:${value}`); },
    });

    const resizeObserver = state.resizeObservers[0];
    resizeObserver.deliver([oldTarget]);
    const oldTargetQueued = state.frames.size;
    resizeObserver.deliver([newTarget]);
    state.runFrame();
    const resultValue = {
      events,
      newTargetObserved: resizeObserver.observed.has(newTarget),
      oldTargetObserved: resizeObserver.observed.has(oldTarget),
      oldTargetQueued,
      oldTargetUnobserved: resizeObserver.unobserved.filter((target) => target === oldTarget).length,
    };
    oldUnsubscribe();
    unsubscribe();
    shared.releaseController('replacement');
    lease.release();
    return resultValue;
  });

  expect(result).toEqual({
    events: ['read', 'write:replacement'],
    newTargetObserved: true,
    oldTargetObserved: false,
    oldTargetQueued: 0,
    oldTargetUnobserved: 1,
  });
});

test('routes mutation records through stable target scopes and excludes only overlay targets', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { resolveTarget } = await import('/src/target.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    const state = window.__resources;
    const nativeRange = document.createRange();
    nativeRange.selectNodeContents(document.querySelector('#range-text'));
    const records = new Map([
      ['direct', resolveTarget(document.querySelector('#direct-target'))],
      ['selector', resolveTarget('#selector-target')],
      ['element-locator', resolveTarget({ within: document.querySelector('#element-locator'), text: 'element locator phrase' })],
      ['selector-locator', resolveTarget({ within: '#selector-locator', text: 'selector locator phrase' })],
      ['range', resolveTarget(nativeRange)],
    ]);
    const events = [];
    const unsubscribes = [];
    for (const [id, record] of records) {
      shared.registerController(id);
      unsubscribes.push(shared.observeLayout({
        id,
        generation: 0,
        record,
        read() { events.push(`read:${id}`); return id; },
        write(value) { events.push(`write:${value}`); },
      }));
    }

    const mutationObserver = state.mutationObservers[0];
    const deliver = (target) => {
      mutationObserver.deliver([{ target }]);
      state.runFrame();
      return events.splice(0).filter((event) => event.startsWith('read:')).map((event) => event.slice(5));
    };
    const direct = deliver(document.querySelector('#direct-target'));
    const elementLocator = deliver(document.querySelector('#element-locator'));
    const range = deliver(document.querySelector('#range-owner'));
    const unrelated = deliver(document.querySelector('#unrelated-target'));

    const overlaySelf = deliver(shared.overlay);
    const overlayChild = shared.noteLayer.appendChild(document.createElement('span'));
    const overlayDescendant = deliver(overlayChild);
    const overlayAncestor = deliver(document.body);
    const observation = mutationObserver.observations[0];

    for (const unsubscribe of unsubscribes) unsubscribe();
    for (const id of records.keys()) shared.releaseController(id);
    lease.release();
    return {
      direct,
      elementLocator,
      observedDocument: observation.target === document,
      observerOptions: observation.options,
      overlayAncestor,
      overlayDescendant,
      overlaySelf,
      range,
      unrelated,
    };
  });

  expect(result.observedDocument).toBe(true);
  expect(result.observerOptions).toEqual({
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden'],
  });
  expect(result.direct).toEqual(['direct', 'selector', 'selector-locator']);
  expect(result.elementLocator).toEqual(['selector', 'element-locator', 'selector-locator']);
  expect(result.range).toEqual(['selector', 'selector-locator', 'range']);
  expect(result.unrelated).toEqual(['selector', 'selector-locator']);
  expect(result.overlaySelf).toEqual([]);
  expect(result.overlayDescendant).toEqual([]);
  expect(result.overlayAncestor).toEqual(['selector', 'selector-locator']);
});

test('coalesces mutation bursts, runs every read before writes, and isolates callback errors', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { resolveTarget } = await import('/src/target.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    const state = window.__resources;
    const record = resolveTarget('#selector-target');
    const events = [];
    document.documentElement.removeAttribute('data-scheduler-error-reported');
    const subscriptions = [
      {
        id: 'ok',
        read() { events.push('read:ok'); return 'ok-value'; },
        write(value) { events.push(`write:ok:${value}`); },
      },
      {
        id: 'read-error',
        read() { events.push('read:read-error'); throw new Error('read failed'); },
        write() { events.push('write:read-error'); },
        onError(error) {
          document.documentElement.setAttribute('data-scheduler-error-reported', '');
          events.push(`error:read-error:${error.message}`);
        },
      },
      {
        id: 'write-error',
        read() {
          events.push(`read:write-error:mutated=${document.documentElement.hasAttribute('data-scheduler-error-reported')}`);
          return 'write-value';
        },
        write() { events.push('write:write-error'); throw new Error('write failed'); },
        onError(error) { events.push(`error:write-error:${error.message}`); },
      },
    ];
    const unsubscribes = subscriptions.map((subscription) => {
      shared.registerController(subscription.id);
      return shared.observeLayout({ generation: 0, record, ...subscription });
    });

    state.mutationObservers[0].deliver([
      { target: document.querySelector('#selector-target') },
      { target: document.querySelector('#selector-container') },
      { target: document.querySelector('#unrelated-target') },
    ]);
    const scheduledFrames = state.frames.size;
    state.runFrame();
    const remainingFrames = state.frames.size;
    for (const unsubscribe of unsubscribes) unsubscribe();
    for (const { id } of subscriptions) shared.releaseController(id);
    lease.release();
    document.documentElement.removeAttribute('data-scheduler-error-reported');
    return { events, remainingFrames, scheduledFrames };
  });

  expect(result.scheduledFrames).toBe(1);
  expect(result.remainingFrames).toBe(0);
  expect(result.events).toEqual([
    'read:ok',
    'read:read-error',
    'read:write-error:mutated=false',
    'error:read-error:read failed',
    'write:ok:ok-value',
    'write:write-error',
    'error:write-error:write failed',
  ]);
});

test('does not write stale work after a controller ID is released and registered again', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { resolveTarget } = await import('/src/target.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    const state = window.__resources;
    const record = resolveTarget('#selector-target');
    const events = [];

    const firstGeneration = shared.registerController('same');
    shared.observeLayout({
      id: 'same',
      generation: firstGeneration,
      record,
      read() {
        events.push('old-read');
        shared.releaseController('same');
        const nextGeneration = shared.registerController('same');
        events.push(`new-generation:${nextGeneration}`);
        shared.observeLayout({
          id: 'same',
          generation: nextGeneration,
          record,
          read() { events.push('new-read'); return 'new-value'; },
          write(value) { events.push(`new-write:${value}`); },
        });
        return 'old-value';
      },
      write(value) { events.push(`old-write:${value}`); },
    });

    state.mutationObservers[0].deliver([{ target: record.element }]);
    state.runFrame();
    const afterReplacement = events.splice(0);
    state.resizeObservers[0].deliver([record.element]);
    state.runFrame();
    const afterNewSignal = events.splice(0);
    const publicGeneration = shared.generationFor('same');
    shared.releaseController('same');
    lease.release();
    return { afterNewSignal, afterReplacement, firstGeneration, publicGeneration };
  });

  expect(result).toEqual({
    afterNewSignal: ['new-read', 'new-write:new-value'],
    afterReplacement: ['old-read', 'new-generation:0'],
    firstGeneration: 0,
    publicGeneration: 0,
  });
});

test('falls back to shared window resize without ResizeObserver and reports unavailable intersection once', async ({ page }) => {
  await installInstrumentation(page, { resize: false, intersection: false });

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { resolveTarget } = await import('/src/target.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    const state = window.__resources;
    const events = [];
    shared.registerController('fallback');
    const unsubscribeLayout = shared.observeLayout({
      id: 'fallback',
      generation: 0,
      record: resolveTarget('#selector-target'),
      read() { events.push('read'); return 'layout'; },
      write(value) { events.push(`write:${value}`); },
    });
    let unavailable = 0;
    const unsubscribeIntersection = shared.observeIntersection({
      id: 'fallback',
      target: document.querySelector('#selector-target'),
      threshold: 0.5,
      onEnter() { events.push('enter'); },
      onExit() { events.push('exit'); },
      onUnavailable() { unavailable += 1; },
    });

    window.dispatchEvent(new Event('resize'));
    state.runFrame();
    unsubscribeIntersection();
    unsubscribeIntersection();
    unsubscribeLayout();
    shared.releaseController('fallback');
    lease.release();
    return {
      events,
      intersectionObservers: state.intersectionObservers.length,
      resizeObservers: state.resizeObservers.length,
      unavailable,
      windowResizeAdds: state.listeners.filter(({ target, type }) => target === 'window' && type === 'resize').length,
    };
  });

  expect(result).toEqual({
    events: ['read', 'write:layout'],
    intersectionObservers: 0,
    resizeObservers: 0,
    unavailable: 1,
    windowResizeAdds: 1,
  });
});

test('owns intersection observers with exact thresholds and deterministic controller cleanup', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    const state = window.__resources;
    const targetA = document.querySelector('#direct-target');
    const targetB = document.querySelector('#selector-target');
    const events = [];
    shared.registerController('a');
    shared.registerController('b');
    const unsubscribeA = shared.observeIntersection({
      id: 'a',
      target: targetA,
      threshold: 0.25,
      onEnter(entry) { events.push(`enter:a:${entry.intersectionRatio}`); },
      onExit(entry) { events.push(`exit:a:${entry.intersectionRatio}`); },
      onUnavailable() { events.push('unavailable:a'); },
    });
    shared.observeIntersection({
      id: 'b',
      target: targetB,
      threshold: 0.75,
      onEnter(entry) { events.push(`enter:b:${entry.intersectionRatio}`); },
      onExit(entry) { events.push(`exit:b:${entry.intersectionRatio}`); },
      onUnavailable() { events.push('unavailable:b'); },
    });

    const [observerA, observerB] = state.intersectionObservers;
    observerA.deliver([
      { target: targetA, isIntersecting: true, intersectionRatio: 0.25 },
      { target: targetA, isIntersecting: true, intersectionRatio: 0.1 },
      { target: targetA, isIntersecting: false, intersectionRatio: 0.9 },
    ]);
    observerB.deliver([{ target: targetB, isIntersecting: true, intersectionRatio: 0.75 }]);
    unsubscribeA();
    unsubscribeA();
    observerA.deliver([{ target: targetA, isIntersecting: true, intersectionRatio: 1 }]);
    const afterA = {
      aDisconnected: observerA.disconnected,
      bDisconnected: observerB.disconnected,
      events: [...events],
    };
    shared.releaseController('b');
    const afterB = { bDisconnected: observerB.disconnected, events: [...events] };
    shared.releaseController('a');
    lease.release();
    return {
      afterA,
      afterB,
      count: state.intersectionObservers.length,
      observed: [observerA.observed.has(targetA), observerB.observed.has(targetB)],
      thresholds: [observerA.options.threshold, observerB.options.threshold],
    };
  });

  expect(result.count).toBe(2);
  expect(result.thresholds).toEqual([0.25, 0.75]);
  expect(result.observed).toEqual([false, false]);
  expect(result.afterA).toEqual({
    aDisconnected: true,
    bDisconnected: false,
    events: ['enter:a:0.25', 'exit:a:0.1', 'exit:a:0.9', 'enter:b:0.75'],
  });
  expect(result.afterB).toEqual({
    bDisconnected: true,
    events: ['enter:a:0.25', 'exit:a:0.1', 'exit:a:0.9', 'enter:b:0.75'],
  });
});

test('intersection cleanup failure still releases its controller jobs and preserves a peer lease', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const lease = acquireDocumentResources(document);
    const peerLease = acquireDocumentResources(document);
    const { shared } = lease;
    const state = window.__resources;
    const target = document.querySelector('#direct-target');
    const events = [];
    shared.registerController('failing');
    shared.registerController('peer');
    shared.observeIntersection({
      id: 'failing',
      target,
      threshold: 0.25,
      onEnter() { events.push('stale-enter'); },
      onExit() {},
      onUnavailable() {},
    });
    shared.enqueue({
      id: 'failing',
      generation: 0,
      read() { events.push('stale-read'); },
      write() { events.push('stale-write'); },
    });
    const observer = state.intersectionObservers[0];
    let unobserved = 0;
    let disconnected = 0;
    observer.unobserve = () => {
      unobserved += 1;
      throw new Error('unobserve failed first');
    };
    observer.disconnect = () => {
      disconnected += 1;
      observer.observed.clear();
    };

    let releaseError = null;
    try { shared.releaseController('failing'); } catch (error) { releaseError = error.message; }
    let controllerMissing = false;
    try { shared.generationFor('failing'); } catch { controllerMissing = true; }
    const afterFailure = {
      canceledFrames: state.canceledFrames.length,
      controllerMissing,
      disconnected,
      frames: state.frames.size,
      overlayCount: document.querySelectorAll('[data-hana-overlay]').length,
      peerGeneration: shared.generationFor('peer'),
      releaseError,
      unobserved,
    };
    observer.deliver([{ target, isIntersecting: true, intersectionRatio: 1 }]);

    if (!controllerMissing) {
      observer.unobserve = () => {};
      shared.releaseController('failing');
    }
    const reusedGeneration = shared.registerController('failing');
    shared.releaseController('failing');
    shared.releaseController('peer');
    lease.release();
    const whilePeerHeld = document.querySelectorAll('[data-hana-overlay]').length;
    peerLease.release();
    return {
      afterFailure,
      events,
      reusedGeneration,
      whilePeerHeld,
      afterPeerRelease: document.querySelectorAll('[data-hana-overlay]').length,
    };
  });

  expect(result).toEqual({
    afterFailure: {
      canceledFrames: 1,
      controllerMissing: true,
      disconnected: 1,
      frames: 0,
      overlayCount: 1,
      peerGeneration: 0,
      releaseError: 'unobserve failed first',
      unobserved: 1,
    },
    events: [],
    reusedGeneration: 0,
    whilePeerHeld: 1,
    afterPeerRelease: 0,
  });
});

test('final resource teardown completes after intersection cleanup throws and permits a fresh lease', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const lease = acquireDocumentResources(document);
    const failedShared = lease.shared;
    const state = window.__resources;
    const firstTarget = document.querySelector('#direct-target');
    const secondTarget = document.querySelector('#selector-target');
    failedShared.registerController('first');
    failedShared.registerController('second');
    for (const [id, target] of [['first', firstTarget], ['second', secondTarget]]) {
      failedShared.observeIntersection({
        id, target, threshold: 0.25, onEnter() {}, onExit() {}, onUnavailable() {},
      });
      failedShared.enqueue({ id, generation: 0, read() {}, write() {} });
    }
    const [firstObserver, secondObserver] = state.intersectionObservers;
    let firstDisconnects = 0;
    firstObserver.unobserve = () => { throw new Error('final unobserve failed'); };
    firstObserver.disconnect = () => { firstDisconnects += 1; };

    let releaseError = null;
    try { lease.release(); } catch (error) { releaseError = error.message; }
    const afterFailedRelease = {
      canceledFrames: state.canceledFrames.length,
      firstDisconnects,
      frames: state.frames.size,
      mutationDisconnected: state.mutationObservers[0].disconnected,
      overlayCount: document.querySelectorAll('[data-hana-overlay]').length,
      releaseError,
      resizeDisconnected: state.resizeObservers[0].disconnected,
      secondDisconnected: secondObserver.disconnected,
    };

    const fresh = acquireDocumentResources(document);
    let freshUsable = false;
    try {
      fresh.shared.registerController('fresh');
      freshUsable = true;
      fresh.shared.releaseController('fresh');
    } catch {}
    const freshShared = fresh.shared !== failedShared;
    fresh.release();
    return {
      afterFailedRelease,
      freshShared,
      freshUsable,
      finalOverlayCount: document.querySelectorAll('[data-hana-overlay]').length,
    };
  });

  expect(result).toEqual({
    afterFailedRelease: {
      canceledFrames: 1,
      firstDisconnects: 1,
      frames: 0,
      mutationDisconnected: true,
      overlayCount: 0,
      releaseError: 'final unobserve failed',
      resizeDisconnected: true,
      secondDisconnected: true,
    },
    freshShared: true,
    freshUsable: true,
    finalOverlayCount: 0,
  });
});

test('stops an intersection delivery when its callback releases the final lease', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    const target = document.querySelector('#direct-target');
    const events = [];
    shared.registerController('self-release');
    shared.observeIntersection({
      id: 'self-release',
      target,
      threshold: 0,
      onEnter() {
        events.push('enter');
        lease.release();
      },
      onExit() { events.push('exit'); },
      onUnavailable() { events.push('unavailable'); },
    });
    const observer = window.__resources.intersectionObservers[0];
    observer.deliver([
      { target, isIntersecting: true, intersectionRatio: 1 },
      { target, isIntersecting: true, intersectionRatio: 1 },
    ]);
    return { disconnected: observer.disconnected, events };
  });

  expect(result).toEqual({ disconnected: true, events: ['enter'] });
});

test('releaseController and final lease teardown cancel every registration and stale callback', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { resolveTarget } = await import('/src/target.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    const state = window.__resources;
    const events = [];
    const target = document.querySelector('#direct-target');
    shared.registerController('cleanup');
    shared.observeLayout({
      id: 'cleanup',
      generation: 0,
      record: resolveTarget(target),
      note: document.querySelector('#rendered-note'),
      read() { events.push('read'); return 'value'; },
      write() { events.push('write'); },
    });
    shared.observeIntersection({
      id: 'cleanup',
      target,
      threshold: 0,
      onEnter() { events.push('enter'); },
      onExit() { events.push('exit'); },
      onUnavailable() { events.push('unavailable'); },
    });
    const resizeObserver = state.resizeObservers[0];
    const mutationObserver = state.mutationObservers[0];
    const intersectionObserver = state.intersectionObservers[0];
    resizeObserver.deliver([target]);
    const pendingBeforeRelease = state.frames.size;
    lease.release();
    const afterRelease = {
      frames: state.frames.size,
      intersectionDisconnected: intersectionObserver.disconnected,
      mutationDisconnected: mutationObserver.disconnected,
      overlayCount: document.querySelectorAll('[data-hana-overlay]').length,
      resizeDisconnected: resizeObserver.disconnected,
      scrollRemovals: state.removals.filter(({ type }) => type === 'scroll').map(({ target: listenerTarget }) => listenerTarget),
      windowResizeRemovals: state.removals.filter(({ target: listenerTarget, type }) => listenerTarget === 'window' && type === 'resize').length,
    };

    resizeObserver.deliver([target]);
    mutationObserver.deliver([{ target }]);
    intersectionObserver.deliver([{ target, isIntersecting: true, intersectionRatio: 1 }]);
    window.dispatchEvent(new Event('resize'));
    document.querySelector('#inner-scroll').dispatchEvent(new Event('scroll'));
    while (state.runFrame()) {}
    return {
      afterRelease,
      canceledFrames: state.canceledFrames.length,
      events,
      pendingBeforeRelease,
    };
  });

  expect(result.pendingBeforeRelease).toBe(1);
  expect(result.canceledFrames).toBe(1);
  expect(result.events).toEqual([]);
  expect(result.afterRelease).toEqual({
    frames: 0,
    intersectionDisconnected: true,
    mutationDisconnected: true,
    overlayCount: 0,
    resizeDisconnected: true,
    scrollRemovals: ['inner-scroll', 'outer-scroll', 'window', 'VisualViewport'],
    windowResizeRemovals: 1,
  });
});

test('releaseController removes only its jobs and shared target ownership', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { resolveTarget } = await import('/src/target.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    const state = window.__resources;
    const target = document.querySelector('#direct-target');
    const note = document.querySelector('#rendered-note');
    const record = resolveTarget(target);
    const events = [];
    for (const id of ['released', 'peer']) {
      shared.registerController(id);
      shared.observeLayout({
        id,
        generation: 0,
        record,
        note,
        read() { events.push(`read:${id}`); return id; },
        write(value) { events.push(`write:${value}`); },
      });
      shared.observeIntersection({
        id,
        target,
        threshold: 0,
        onEnter() { events.push(`enter:${id}`); },
        onExit() { events.push(`exit:${id}`); },
        onUnavailable() { events.push(`unavailable:${id}`); },
      });
    }

    state.resizeObservers[0].deliver([target]);
    shared.releaseController('released');
    let releasedGenerationError;
    try { shared.generationFor('released'); } catch (error) { releasedGenerationError = error.name; }
    const afterReleased = {
      firstIntersectionDisconnected: state.intersectionObservers[0].disconnected,
      noteObserved: state.resizeObservers[0].observed.has(note),
      scrollRemovals: state.removals.filter(({ type }) => type === 'scroll').length,
      targetObserved: state.resizeObservers[0].observed.has(target),
    };
    state.intersectionObservers[0].deliver([{ target, isIntersecting: true, intersectionRatio: 1 }]);
    state.runFrame();
    const peerEvents = events.splice(0);

    shared.releaseController('peer');
    const afterPeer = {
      noteObserved: state.resizeObservers[0].observed.has(note),
      secondIntersectionDisconnected: state.intersectionObservers[1].disconnected,
      scrollRemovals: state.removals.filter(({ type }) => type === 'scroll').map(({ target: listenerTarget }) => listenerTarget),
      targetObserved: state.resizeObservers[0].observed.has(target),
    };
    lease.release();
    return { afterPeer, afterReleased, peerEvents, releasedGenerationError };
  });

  expect(result.releasedGenerationError).toBe('Error');
  expect(result.afterReleased).toEqual({
    firstIntersectionDisconnected: true,
    noteObserved: true,
    scrollRemovals: 0,
    targetObserved: true,
  });
  expect(result.peerEvents).toEqual(['read:peer', 'write:peer']);
  expect(result.afterPeer).toEqual({
    noteObserved: false,
    secondIntersectionDisconnected: true,
    scrollRemovals: ['inner-scroll', 'outer-scroll', 'window'],
    targetObserved: false,
  });
});

test('mounts the shared root on documentElement when body is not ready without assigning host IDs', async ({ page }) => {
  await installInstrumentation(page);

  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    document.body.remove();
    const originalHtmlId = document.documentElement.id;
    const lease = acquireDocumentResources(document);
    const mountedOnHtml = lease.shared.overlay.parentElement === document.documentElement;
    const htmlId = document.documentElement.id;
    const overlayId = lease.shared.overlay.id;
    lease.release();
    return { htmlId, mountedOnHtml, originalHtmlId, overlayId };
  });

  expect(result).toEqual({ htmlId: '', mountedOnHtml: true, originalHtmlId: '', overlayId: '' });
});
