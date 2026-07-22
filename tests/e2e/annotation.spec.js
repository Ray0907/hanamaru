import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/annotation.html');
});

test('load trigger listens once before DOMContentLoaded and destroy removes the listener', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');

    async function createLoadingFrame({ destroy = false } = {}) {
      const frame = document.createElement('iframe');
      document.body.append(frame);
      const doc = frame.contentDocument;
      doc.open();
      doc.write('<!doctype html><html><body><span id="target" style="display:inline-block">Loading target</span></body></html>');
      const target = doc.querySelector('#target');
      const events = [];
      target.addEventListener('hana:start', () => events.push('start'));
      target.addEventListener('hana:complete', () => events.push('complete'));
      const controller = annotate(target, {
        mark: 'underline', trigger: 'load', motion: 'never',
      });
      const before = { state: controller.state, events: [...events] };
      if (destroy) controller.destroy();
      const loaded = new Promise((resolve) => {
        doc.addEventListener('DOMContentLoaded', () => queueMicrotask(resolve), { once: true });
      });
      doc.close();
      await loaded;
      doc.dispatchEvent(new frame.contentWindow.Event('DOMContentLoaded'));
      await Promise.resolve();
      const after = {
        state: controller.state,
        events: [...events],
        owned: doc.querySelectorAll('[data-hana-id]').length,
      };
      controller.destroy();
      frame.remove();
      return { before, after };
    }

    return {
      loaded: await createLoadingFrame(),
      destroyed: await createLoadingFrame({ destroy: true }),
    };
  });

  expect(result).toEqual({
    loaded: {
      before: { state: 'idle', events: [] },
      after: { state: 'visible', events: ['start', 'complete'], owned: 1 },
    },
    destroyed: {
      before: { state: 'idle', events: [] },
      after: { state: 'destroyed', events: [], owned: 0 },
    },
  });
});

test('load trigger schedules one guarded microtask after DOMContentLoaded', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const first = document.querySelector('#direct-target');
    const second = document.querySelector('#selector-target');
    const firstEvents = [];
    const secondEvents = [];
    first.addEventListener('hana:start', () => firstEvents.push('start'));
    first.addEventListener('hana:complete', () => firstEvents.push('complete'));
    second.addEventListener('hana:start', () => secondEvents.push('start'));

    const controller = annotate(first, {
      mark: 'highlight', trigger: 'load', motion: 'never',
    });
    const stale = annotate(second, {
      mark: 'box', trigger: 'load', motion: 'never',
    });
    const immediate = {
      state: controller.state,
      staleState: stale.state,
      events: [...firstEvents],
    };
    stale.update({ note: 'Invalidate the queued load operation' });
    await Promise.resolve();
    const after = {
      state: controller.state,
      staleState: stale.state,
      events: [...firstEvents],
      staleEvents: [...secondEvents],
    };
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await Promise.resolve();
    const finalEvents = [...firstEvents];
    controller.destroy();
    stale.destroy();
    return { immediate, after, finalEvents };
  });

  expect(result).toEqual({
    immediate: { state: 'idle', staleState: 'idle', events: [] },
    after: {
      state: 'visible', staleState: 'idle', events: ['start', 'complete'], staleEvents: [],
    },
    finalEvents: ['start', 'complete'],
  });
});

test('viewport trigger uses the shared threshold, shows once, and stays visible on exit', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const result = await page.evaluate(async () => {
    class FakeIntersectionObserver {
      static instances = [];

      constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        this.targets = new Set();
        this.unobserved = [];
        this.disconnects = 0;
        FakeIntersectionObserver.instances.push(this);
      }

      observe(target) { this.targets.add(target); }

      unobserve(target) {
        this.targets.delete(target);
        this.unobserved.push(target.id);
      }

      disconnect() {
        this.targets.clear();
        this.disconnects += 1;
      }

      emit(target, intersectionRatio, isIntersecting = intersectionRatio > 0) {
        this.callback([{ target, intersectionRatio, isIntersecting }], this);
      }
    }
    window.IntersectionObserver = FakeIntersectionObserver;

    const { annotate } = await import('/src/index.js');
    const target = document.querySelector('#direct-target');
    const events = [];
    target.addEventListener('hana:start', () => events.push('start'));
    target.addEventListener('hana:complete', () => events.push('complete'));
    const controller = annotate(target, {
      mark: 'circle', trigger: 'viewport', duration: 900,
    });
    const observer = FakeIntersectionObserver.instances[0];
    if (observer === undefined) {
      controller.destroy();
      return { observerCount: 0 };
    }
    const initial = {
      state: controller.state,
      threshold: observer?.options.threshold,
      observed: observer?.targets.has(target),
    };
    observer.emit(target, 0.24, true);
    const below = { state: controller.state, events: [...events] };
    observer.emit(target, 0.25, true);
    const entered = {
      state: controller.state,
      events: [...events],
      unobserved: observer.unobserved,
      disconnects: observer.disconnects,
    };
    observer.emit(target, 0, false);
    observer.emit(target, 1, true);
    const afterExitAndReentry = { state: controller.state, events: [...events] };
    controller.destroy();
    return { initial, below, entered, afterExitAndReentry };
  });

  expect(result).toEqual({
    initial: { state: 'idle', threshold: 0.25, observed: true },
    below: { state: 'idle', events: [] },
    entered: {
      state: 'visible', events: ['start', 'complete'],
      unobserved: ['direct-target'], disconnects: 1,
    },
    afterExitAndReentry: { state: 'visible', events: ['start', 'complete'] },
  });
});

test('viewport trigger destroy and generation guards unsubscribe without showing', async ({ page }) => {
  const result = await page.evaluate(async () => {
    class FakeIntersectionObserver {
      static instances = [];

      constructor(callback, options) {
        Object.assign(this, { callback, options, target: null, unobserved: 0, disconnects: 0 });
        FakeIntersectionObserver.instances.push(this);
      }

      observe(target) { this.target = target; }

      unobserve() { this.unobserved += 1; }

      disconnect() { this.disconnects += 1; }

      emit(ratio = 1) {
        this.callback([{
          target: this.target, intersectionRatio: ratio, isIntersecting: ratio > 0,
        }], this);
      }
    }
    window.IntersectionObserver = FakeIntersectionObserver;

    const { annotate } = await import('/src/index.js');
    const first = document.querySelector('#direct-target');
    const second = document.querySelector('#selector-target');
    const events = [];
    document.body.addEventListener('hana:start', (event) => events.push(event.target.id));
    const destroyed = annotate(first, {
      mark: 'underline', trigger: 'viewport', motion: 'never',
    });
    const stale = annotate(second, {
      mark: 'box', trigger: 'viewport', motion: 'never',
    });
    const [destroyedObserver, staleObserver] = FakeIntersectionObserver.instances;
    if (destroyedObserver === undefined || staleObserver === undefined) {
      destroyed.destroy();
      stale.destroy();
      return { observerCount: FakeIntersectionObserver.instances.length };
    }
    destroyed.destroy();
    stale.refresh();
    destroyedObserver.emit();
    staleObserver.emit();
    await Promise.resolve();
    const output = {
      destroyedState: destroyed.state,
      staleState: stale.state,
      events,
      destroyedCleanup: [destroyedObserver.unobserved, destroyedObserver.disconnects],
      staleCleanupBeforeDestroy: [staleObserver.unobserved, staleObserver.disconnects],
    };
    stale.destroy();
    output.staleCleanupAfterDestroy = [staleObserver.unobserved, staleObserver.disconnects];
    return output;
  });

  expect(result).toEqual({
    destroyedState: 'destroyed',
    staleState: 'idle',
    events: [],
    destroyedCleanup: [1, 1],
    staleCleanupBeforeDestroy: [1, 1],
    staleCleanupAfterDestroy: [1, 1],
  });
});

test('viewport trigger cleanup survives release failure and hana:start destroy reentrancy', async ({ page }) => {
  const result = await page.evaluate(async () => {
    class FakeIntersectionObserver {
      static instances = [];

      constructor(callback) {
        Object.assign(this, {
          callback, target: null, failUnobserve: false, unobserved: 0, disconnects: 0,
        });
        FakeIntersectionObserver.instances.push(this);
      }

      observe(target) { this.target = target; }

      unobserve() {
        this.unobserved += 1;
        if (this.failUnobserve) throw new Error('observer cleanup failed');
      }

      disconnect() { this.disconnects += 1; }

      enter() {
        this.callback([{
          target: this.target, intersectionRatio: 1, isIntersecting: true,
        }], this);
      }
    }
    window.IntersectionObserver = FakeIntersectionObserver;
    const { annotate } = await import('/src/index.js');

    const cleanupTarget = document.querySelector('#direct-target');
    const cleanupErrors = [];
    cleanupTarget.addEventListener('hana:error', (event) => {
      cleanupErrors.push(event.detail.error.code);
    });
    const cleanupController = annotate(cleanupTarget, {
      mark: 'underline', trigger: 'viewport', motion: 'never',
    });
    const cleanupObserver = FakeIntersectionObserver.instances[0];
    cleanupObserver.failUnobserve = true;
    cleanupController.destroy();
    cleanupObserver.enter();
    const failedCleanup = {
      state: cleanupController.state,
      errors: cleanupErrors,
      unobserved: cleanupObserver.unobserved,
      owned: document.querySelectorAll('[data-hana-id]').length,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    };

    const reentrantTarget = document.querySelector('#selector-target');
    const reentrantEvents = [];
    let reentrantController;
    reentrantTarget.addEventListener('hana:start', () => {
      reentrantEvents.push('start');
      reentrantController.destroy();
    });
    reentrantTarget.addEventListener('hana:complete', () => reentrantEvents.push('complete'));
    reentrantController = annotate(reentrantTarget, {
      mark: 'circle', trigger: 'viewport', motion: 'never',
    });
    const reentrantObserver = FakeIntersectionObserver.instances[1];
    reentrantObserver.enter();
    reentrantObserver.enter();
    await Promise.resolve();
    const reentrant = {
      state: reentrantController.state,
      events: reentrantEvents,
      unobserved: reentrantObserver.unobserved,
      disconnects: reentrantObserver.disconnects,
      owned: document.querySelectorAll('[data-hana-id]').length,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    };
    return { failedCleanup, reentrant };
  });

  expect(result).toEqual({
    failedCleanup: {
      state: 'destroyed', errors: ['HANA_STATE_RUNTIME'], unobserved: 1, owned: 0, overlays: 0,
    },
    reentrant: {
      state: 'destroyed', events: ['start'], unobserved: 1, disconnects: 1, owned: 0, overlays: 0,
    },
  });
});

test('IntersectionObserver fallback uses load semantics before and after DOMContentLoaded', async ({ page }) => {
  const result = await page.evaluate(async () => {
    window.IntersectionObserver = undefined;
    const { annotate } = await import('/src/index.js');
    const loadedTarget = document.querySelector('#direct-target');
    const loadedController = annotate(loadedTarget, {
      mark: 'highlight', trigger: 'viewport', motion: 'never',
    });
    const afterReadyImmediate = loadedController.state;
    await Promise.resolve();
    const afterReadyMicrotask = loadedController.state;
    loadedController.destroy();

    const frame = document.createElement('iframe');
    document.body.append(frame);
    const doc = frame.contentDocument;
    doc.open();
    doc.write('<!doctype html><html><body><span id="target" style="display:inline-block">Fallback target</span></body></html>');
    frame.contentWindow.IntersectionObserver = undefined;
    const loadingController = annotate(doc.querySelector('#target'), {
      mark: 'strike', trigger: 'viewport', motion: 'never',
    });
    const beforeReady = loadingController.state;
    const loaded = new Promise((resolve) => {
      doc.addEventListener('DOMContentLoaded', () => queueMicrotask(resolve), { once: true });
    });
    doc.close();
    await loaded;
    const afterFrameReady = loadingController.state;
    loadingController.destroy();
    frame.remove();
    return { afterReadyImmediate, afterReadyMicrotask, beforeReady, afterFrameReady };
  });

  expect(result).toEqual({
    afterReadyImmediate: 'idle',
    afterReadyMicrotask: 'visible',
    beforeReady: 'idle',
    afterFrameReady: 'visible',
  });
});

test('annotation lifecycle renders, dispatches exact events, transfers ARIA, and cleans resources', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const owner = document.querySelector('#direct-target');
    const events = [];
    let controller;
    document.body.addEventListener('hana:start', (event) => events.push({
      type: event.type,
      bubbles: event.bubbles,
      composed: event.composed,
      controller: event.detail.controller === controller,
      state: event.detail.state,
    }));
    document.body.addEventListener('hana:complete', (event) => events.push({
      type: event.type,
      bubbles: event.bubbles,
      composed: event.composed,
      controller: event.detail.controller === controller,
      state: event.detail.state,
    }));
    document.body.addEventListener('hana:cancel', (event) => events.push({
      type: event.type,
      bubbles: event.bubbles,
      composed: event.composed,
      controller: event.detail.controller === controller,
      reason: event.detail.reason,
    }));
    controller = annotate(owner, {
      mark: 'underline', note: 'Review this line', accessible: true, duration: 1,
    });
    const initial = { state: controller.state, finished: controller.finished };
    const chained = controller.show() === controller;
    const firstRun = controller.finished;
    await firstRun;
    const visible = {
      state: controller.state,
      description: owner.getAttribute('aria-describedby'),
      paths: document.querySelectorAll('.hana-mark-path').length,
      notes: document.querySelectorAll('.hana-note').length,
    };
    controller.hide();
    const hidden = { state: controller.state, runRetained: controller.finished === firstRun };
    controller.replay();
    const replayRun = controller.finished;
    await replayRun;
    const replayed = { state: controller.state, fresh: replayRun !== firstRun };
    controller.update({ mark: 'circle', note: 'Updated note' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const updated = {
      state: controller.state,
      sameRun: controller.finished === replayRun,
      mark: document.querySelector('.hana-annotation')?.getAttribute('data-hana-mark'),
      note: document.querySelector('.hana-note')?.textContent,
      hidden: document.querySelector('.hana-annotation')?.hasAttribute('hidden'),
    };
    controller.destroy().destroy();
    return {
      initial,
      chained,
      visible,
      hidden,
      replayed,
      updated,
      events,
      final: {
        state: controller.state,
        owned: document.querySelectorAll('[data-hana-id]').length,
        overlay: document.querySelectorAll('[data-hana-overlay]').length,
        description: owner.getAttribute('aria-describedby'),
      },
    };
  });

  expect(result.initial).toEqual({ state: 'idle', finished: null });
  expect(result.chained).toBe(true);
  expect(result.visible.state).toBe('visible');
  expect(result.visible.description).toMatch(/^author-token hana-note-/);
  expect(result.visible.paths).toBeGreaterThan(0);
  expect(result.visible.notes).toBe(1);
  expect(result.hidden).toEqual({ state: 'hidden', runRetained: true });
  expect(result.replayed).toEqual({ state: 'visible', fresh: true });
  expect(result.updated).toEqual({
    state: 'visible', sameRun: true, mark: 'circle', note: 'Updated note', hidden: false,
  });
  expect(result.events).toEqual([
    { type: 'hana:start', bubbles: true, composed: true, controller: true, state: 'showing' },
    { type: 'hana:complete', bubbles: true, composed: true, controller: true, state: 'visible' },
    { type: 'hana:cancel', bubbles: true, composed: true, controller: true, reason: 'hide' },
    { type: 'hana:start', bubbles: true, composed: true, controller: true, state: 'showing' },
    { type: 'hana:complete', bubbles: true, composed: true, controller: true, state: 'visible' },
    { type: 'hana:cancel', bubbles: true, composed: true, controller: true, reason: 'destroy' },
  ]);
  expect(result.final).toEqual({ state: 'destroyed', owned: 0, overlay: 0, description: 'author-token' });
});

test('reduced motion reaches final styles and no-note layout stays connector-free', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const controller = annotate('#direct-target', { mark: 'highlight', duration: 500 });
    const events = [];
    document.querySelector('#direct-target').addEventListener('hana:complete', () => events.push('complete'));
    controller.show();
    const immediate = {
      state: controller.state,
      markPaths: document.querySelectorAll('.hana-mark-path').length,
      events: [...events],
    };
    await Promise.resolve();
    const microtask = { state: controller.state, events: [...events] };
    await controller.finished;
    const group = document.querySelector('.hana-annotation');
    const output = {
      state: controller.state,
      note: document.querySelector('.hana-note'),
      connectors: group.querySelectorAll('.hana-connector-path').length,
      markPaths: group.querySelectorAll('.hana-mark-path').length,
      animating: group.classList.contains('hana-is-animating'),
      immediate,
      microtask,
    };
    controller.destroy();
    return output;
  });

  expect(result).toEqual({
    state: 'visible', note: null, connectors: 0, markPaths: 1, animating: false,
    immediate: { state: 'visible', markPaths: 1, events: ['complete'] },
    microtask: { state: 'visible', events: ['complete'] },
  });
});

test('motion never reaches visible synchronously without waiting for a frame', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const controller = annotate('#direct-target', {
      mark: 'box', note: 'Immediate', motion: 'never', duration: 900,
    });
    controller.show();
    const immediate = {
      state: controller.state,
      paths: document.querySelectorAll('.hana-mark-path').length,
      noteVisible: !document.querySelector('.hana-note').classList.contains('hana-is-hidden'),
    };
    controller.destroy();
    return immediate;
  });
  expect(result).toEqual({ state: 'visible', paths: 2, noteVisible: true });
});

test('hana:start reentrancy cannot revive a show hidden by its listener', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const target = document.querySelector('#direct-target');
    const events = [];
    let controller;
    target.addEventListener('hana:start', () => {
      events.push('start');
      controller.hide();
    });
    target.addEventListener('hana:cancel', (event) => events.push(`cancel:${event.detail.reason}`));
    target.addEventListener('hana:complete', () => events.push('complete'));
    controller = annotate(target, {
      mark: 'circle', note: 'Stay hidden', accessible: true, motion: 'never',
    });

    controller.show();
    const rejection = await controller.finished.then(
      () => null,
      (error) => ({ name: error.name, message: error.message }),
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const group = document.querySelector('.hana-annotation');
    const note = document.querySelector('.hana-note');
    const output = {
      state: controller.state,
      rejection,
      events,
      groupHidden: group.hasAttribute('hidden'),
      groupDisplay: getComputedStyle(group).display,
      noteHidden: note.hidden || getComputedStyle(note).visibility === 'hidden',
      paths: group.querySelectorAll('.hana-path').length,
      description: target.getAttribute('aria-describedby'),
    };
    controller.destroy();
    return output;
  });

  expect(result).toEqual({
    state: 'hidden',
    rejection: { name: 'AbortError', message: 'Annotation run cancelled' },
    events: ['start', 'cancel:hide'],
    groupHidden: true,
    groupDisplay: 'none',
    noteHidden: true,
    paths: 0,
    description: 'author-token',
  });
});

test('hana:cancel destroy stops outer hide and replay continuations', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');

    async function run(reason, target) {
      const events = [];
      const controller = annotate(target, {
        mark: 'box', note: `${reason} teardown`, accessible: true, motion: 'never',
      });
      controller.show();
      const settledRun = controller.finished;
      await settledRun;
      target.addEventListener('hana:cancel', (event) => {
        events.push(event.detail.reason);
        if (event.detail.reason === reason) controller.destroy();
      });

      controller[reason]();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        state: controller.state,
        sameRun: controller.finished === settledRun,
        events,
        owned: document.querySelectorAll('[data-hana-id]').length,
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
      };
    }

    const hidden = await run('hide', document.querySelector('#direct-target'));
    const replayed = await run('replay', document.querySelector('#selector-target'));
    return { hidden, replayed };
  });

  expect(result).toEqual({
    hidden: {
      state: 'destroyed', sameRun: true, events: ['hide', 'destroy'], owned: 0, overlays: 0,
    },
    replayed: {
      state: 'destroyed', sameRun: true, events: ['replay', 'destroy'], owned: 0, overlays: 0,
    },
  });
});

test('hana:cancel refresh and update take over from a coherent hidden state', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const output = [];

    for (const action of ['hide', 'replay']) {
      for (const listenerAction of ['refresh', 'update']) {
        const target = document.createElement('span');
        target.textContent = `${action} ${listenerAction} target`;
        target.style.display = 'inline-block';
        document.querySelector('#arena').append(target);
        const controller = annotate(target, {
          mark: 'circle', note: 'Pending note', accessible: true, duration: 800,
        });
        controller.show();
        const cancelledRun = controller.finished;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        let listenerState = null;
        let listenerSameRun = null;
        target.addEventListener('hana:cancel', (event) => {
          if (event.detail.reason !== action) return;
          listenerState = controller.state;
          listenerSameRun = controller.finished === cancelledRun;
          if (listenerAction === 'refresh') controller.refresh();
          else controller.update({ note: 'Listener update' });
        });

        controller[action]();
        const rejection = await cancelledRun.then(() => null, (error) => error.name);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const group = document.querySelector('.hana-annotation');
        const note = document.querySelector('.hana-note');
        output.push({
          action,
          listenerAction,
          listenerState,
          listenerSameRun,
          sameRun: controller.finished === cancelledRun,
          rejection,
          state: controller.state,
          groupHidden: group.hasAttribute('hidden'),
          groupDisplay: getComputedStyle(group).display,
          noteHidden: note.hidden || getComputedStyle(note).visibility === 'hidden',
          description: target.getAttribute('aria-describedby'),
          owned: document.querySelectorAll('[data-hana-id]').length,
        });
        controller.destroy();
        target.remove();
      }
    }
    return output;
  });

  expect(results).toEqual([
    ['hide', 'refresh'],
    ['hide', 'update'],
    ['replay', 'refresh'],
    ['replay', 'update'],
  ].map(([action, listenerAction]) => ({
    action,
    listenerAction,
    listenerState: 'hidden',
    listenerSameRun: true,
    sameRun: true,
    rejection: 'AbortError',
    state: 'hidden',
    groupHidden: true,
    groupDisplay: 'none',
    noteHidden: true,
    description: null,
    owned: 2,
  })));
});

test('hana:cancel show restores real renderer visibility and its stable ARIA note', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const output = [];

    for (const action of ['hide', 'replay']) {
      const target = document.createElement('span');
      target.textContent = `${action} replacement show`;
      target.style.display = 'inline-block';
      document.querySelector('#arena').append(target);
      const controller = annotate(target, {
        mark: 'box', note: 'Stable accessible note', accessible: true, duration: 0,
      });
      let completes = 0;
      target.addEventListener('hana:complete', () => { completes += 1; });
      controller.show();
      const initialRun = controller.finished;
      await initialRun;
      const noteId = document.querySelector('.hana-note').id;
      let replacementRun = null;
      target.addEventListener('hana:cancel', (event) => {
        if (event.detail.reason !== action) return;
        controller.show();
        replacementRun = controller.finished;
      });

      controller[action]();
      const outcome = await Promise.race([
        replacementRun.then(() => 'resolved', () => 'rejected'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000)),
      ]);
      const group = document.querySelector('.hana-annotation');
      const note = document.querySelector('.hana-note');
      output.push({
        action,
        outcome,
        freshRun: replacementRun !== initialRun,
        sameFinished: controller.finished === replacementRun,
        state: controller.state,
        completes,
        groupHidden: group.hasAttribute('hidden'),
        groupDisplay: getComputedStyle(group).display,
        noteIdStable: note.id === noteId,
        noteHidden: note.hidden || getComputedStyle(note).visibility === 'hidden',
        descriptionHasStableNote: (target.getAttribute('aria-describedby') ?? '')
          .split(/\s+/u).includes(noteId),
      });
      controller.destroy();
      target.remove();
    }
    return output;
  });

  expect(results).toEqual(['hide', 'replay'].map((action) => ({
    action,
    outcome: 'resolved',
    freshRun: true,
    sameFinished: true,
    state: 'visible',
    completes: 2,
    groupHidden: false,
    groupDisplay: 'inline',
    noteIdStable: true,
    noteHidden: false,
    descriptionHasStableNote: true,
  })));
});

test('hana:cancel show survives a hide failure while reporting it exactly once', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const output = [];

    for (const action of ['hide', 'replay']) {
      const target = document.createElement('span');
      target.textContent = `${action} failed hide replacement`;
      target.style.display = 'inline-block';
      target.setAttribute('aria-describedby', 'author-token');
      document.querySelector('#arena').append(target);
      const controller = annotate(target, {
        mark: 'circle', note: 'Recoverable note', accessible: true, duration: 0,
      });
      const errors = [];
      let completes = 0;
      target.addEventListener('hana:error', (event) => errors.push({
        name: event.detail.error.name,
        code: event.detail.error.code,
        cause: event.detail.error.details.cause.message,
      }));
      target.addEventListener('hana:complete', () => { completes += 1; });
      controller.show();
      const initialRun = controller.finished;
      await initialRun;
      const noteId = document.querySelector('.hana-note').id;
      const nativeGetAttribute = target.getAttribute;
      let hideReadFailed = false;
      target.getAttribute = function getAttribute(name) {
        if (name === 'aria-describedby' && !hideReadFailed) {
          hideReadFailed = true;
          this.setAttribute('aria-describedby', 'author-token');
          throw new Error('forced hide failure');
        }
        return nativeGetAttribute.call(this, name);
      };
      let replacementRun = null;
      target.addEventListener('hana:cancel', (event) => {
        if (event.detail.reason !== action) return;
        target.getAttribute = nativeGetAttribute;
        controller.show();
        replacementRun = controller.finished;
      });

      controller[action]();
      const outcome = await Promise.race([
        replacementRun.then(() => 'resolved', () => 'rejected'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000)),
      ]);
      const group = document.querySelector('.hana-annotation');
      const note = document.querySelector('.hana-note');
      output.push({
        action,
        outcome,
        freshRun: replacementRun !== initialRun,
        sameFinished: controller.finished === replacementRun,
        state: controller.state,
        completes,
        errors,
        groupHidden: group.hasAttribute('hidden'),
        noteHidden: note.hidden || getComputedStyle(note).visibility === 'hidden',
        descriptionHasStableNote: (target.getAttribute('aria-describedby') ?? '')
          .split(/\s+/u).includes(noteId),
      });
      controller.destroy();
      target.remove();
    }
    return output;
  });

  expect(results).toEqual(['hide', 'replay'].map((action) => ({
    action,
    outcome: 'resolved',
    freshRun: true,
    sameFinished: true,
    state: 'visible',
    completes: 2,
    errors: [{
      name: 'HanamaruStateError', code: 'HANA_STATE_RUNTIME', cause: 'forced hide failure',
    }],
    groupHidden: false,
    noteHidden: false,
    descriptionHasStableNote: true,
  })));
});

test('selector replacement while visibility is not requested recovers hidden without drawing', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const arena = document.querySelector('#arena');
    const original = document.querySelector('#selector-target');
    const controller = annotate('#selector-target', { mark: 'circle', duration: 0 });
    original.remove();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const suspended = controller.state;
    const replacement = document.createElement('p');
    replacement.id = 'selector-target';
    replacement.textContent = 'Hidden-intent replacement';
    arena.append(replacement);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const group = document.querySelector('.hana-annotation');
    const output = {
      suspended,
      recovered: controller.state,
      hidden: group.hasAttribute('hidden'),
      paths: group.querySelectorAll('.hana-mark-path').length,
    };
    controller.destroy();
    return output;
  });
  expect(result).toEqual({ suspended: 'suspended', recovered: 'hidden', hidden: true, paths: 0 });
});

test('hidden and non-renderable targets suspend on show and refresh, then recover', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const target = document.querySelector('#direct-target');
    target.hidden = true;
    const controller = annotate(target, { mark: 'underline', duration: 0 });
    const errors = [];
    target.addEventListener('hana:error', (event) => errors.push(event.detail.error.code));
    controller.show();
    const showError = await controller.finished.then(() => null, (error) => error.code);
    const afterShow = {
      state: controller.state,
      hidden: document.querySelector('.hana-annotation').hasAttribute('hidden'),
      paths: document.querySelectorAll('.hana-mark-path').length,
    };
    controller.refresh();
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.refresh();
    await new Promise((resolve) => setTimeout(resolve, 30));
    target.hidden = false;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const recovered = controller.state;
    target.style.visibility = 'hidden';
    controller.refresh();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterRefresh = controller.state;
    target.style.visibility = 'visible';
    controller.refresh();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const final = controller.state;
    controller.destroy();
    return { showError, afterShow, recovered, afterRefresh, final, errors };
  });
  expect(result).toEqual({
    showError: 'HANA_TARGET_INVALID',
    afterShow: { state: 'suspended', hidden: true, paths: 0 },
    recovered: 'visible',
    afterRefresh: 'suspended',
    final: 'visible',
    errors: ['HANA_TARGET_INVALID', 'HANA_TARGET_INVALID'],
  });
});

test('invalid construction leaves no overlay or owned DOM behind', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const errors = [];
    for (const [target, options] of [
      ['#missing-target', { mark: 'circle' }],
      ['#direct-target', { mark: 'invalid' }],
    ]) {
      try { annotate(target, options); } catch (error) { errors.push(error.code); }
    }
    return {
      errors,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      owned: document.querySelectorAll('[data-hana-id]').length,
    };
  });
  expect(result).toEqual({
    errors: ['HANA_TARGET_MISSING', 'HANA_CONFIG_INVALID'], overlays: 0, owned: 0,
  });
});

test('failure fallbacks hide and remove only the failing renderer DOM', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createAnnotation } = await import('/src/annotation.js');
    const { annotate } = await import('/src/index.js');
    const { createRenderer, readThemeMetrics } = await import('/src/renderer.js');
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { resolveTarget } = await import('/src/target.js');

    function createEnvironment(id, rendererFactory) {
      const lease = acquireDocumentResources(document);
      return {
        id,
        lease,
        createEvent(type, detail, owner) {
          owner.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
        },
        createRenderer(args) { return rendererFactory(args); },
        direction(owner) { return getComputedStyle(owner).direction; },
        readThemeMetrics,
        reducedMotion(options) { return options.motion === 'never'; },
        resolveTarget(target) { return resolveTarget(target, document); },
        targetRects(record) {
          const rects = record.range === null
            ? [record.element.getBoundingClientRect()]
            : [...record.range.getClientRects()];
          return rects.map((rect) => ({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
          }));
        },
      };
    }

    const direct = document.querySelector('#direct-target');
    const hideErrors = [];
    direct.addEventListener('hana:error', (event) => hideErrors.push(event.detail.error.code));
    const hideController = createAnnotation(direct, {
      mark: 'circle', note: 'Must disappear', accessible: true, duration: 800,
    }, createEnvironment('hide-failure', (args) => {
      const real = createRenderer(args);
      return { ...real, hide() { throw new Error('hide failed'); } };
    }));
    hideController.show();
    hideController.finished.catch(() => {});
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const hideGroup = document.querySelector('[data-hana-id="hide-failure"].hana-annotation');
    const hideNote = document.querySelector('[data-hana-id="hide-failure"].hana-note');
    hideController.hide();
    const hideAnimations = [
      ...hideGroup.getAnimations({ subtree: true }),
      ...hideNote.getAnimations({ subtree: true }),
    ];
    const hideFailure = {
      state: hideController.state,
      groupHidden: hideGroup.hidden || hideGroup.hasAttribute('hidden'),
      groupDisplay: getComputedStyle(hideGroup).display,
      noteHidden: hideNote.hidden,
      noteDisplay: getComputedStyle(hideNote).display,
      noteVisibility: getComputedStyle(hideNote).visibility,
      groupClasses: hideGroup.className.baseVal,
      noteClasses: hideNote.className,
      tabindex: hideNote.getAttribute('tabindex'),
      description: direct.getAttribute('aria-describedby'),
      activeAnimations: hideAnimations.filter((animation) => animation.playState !== 'idle').length,
      errors: [...hideErrors],
    };
    hideController.refresh();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    hideFailure.recoveredState = hideController.state;
    hideFailure.recoveredGroupHidden = hideGroup.hasAttribute('hidden');
    hideFailure.recoveredNoteHidden = hideNote.hidden;
    hideController.destroy();

    const currentDestroy = createAnnotation(direct, {
      mark: 'box', note: 'Throwing teardown', accessible: true, motion: 'never',
    }, createEnvironment('current-destroy-failure', (args) => {
      const real = createRenderer(args);
      return { ...real, destroy() { throw new Error('destroy failed'); } };
    }));
    const peer = document.querySelector('#selector-target');
    const peerController = annotate(peer, {
      mark: 'underline', note: 'Peer stays mounted', accessible: true, motion: 'never',
    });
    currentDestroy.show();
    peerController.show();
    await peerController.finished;
    currentDestroy.destroy();
    const concurrentDestroy = {
      state: currentDestroy.state,
      failedOwned: document.querySelectorAll('[data-hana-id="current-destroy-failure"]').length,
      peerOwned: document.querySelectorAll(`[data-hana-id="${document.querySelector('.hana-note:not([data-hana-id="current-destroy-failure"])')?.dataset.hanaId}"]`).length,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      directDescription: direct.getAttribute('aria-describedby'),
      peerDescription: peer.getAttribute('aria-describedby'),
    };
    peerController.destroy();
    concurrentDestroy.afterPeerDestroy = document.querySelectorAll('[data-hana-overlay]').length;

    let updateCreation = 0;
    const updateController = createAnnotation(direct, {
      mark: 'circle', note: 'Old renderer', accessible: true, motion: 'never',
    }, createEnvironment('update-destroy-failure', (args) => {
      updateCreation += 1;
      const real = createRenderer(args);
      return updateCreation === 1
        ? { ...real, destroy() { throw new Error('old destroy failed'); } }
        : real;
    }));
    const updateErrors = [];
    direct.addEventListener('hana:error', (event) => updateErrors.push(event.detail.error.code));
    updateController.show();
    const oldGroup = document.querySelector('[data-hana-id="update-destroy-failure"].hana-annotation');
    const oldNote = document.querySelector('[data-hana-id="update-destroy-failure"].hana-note');
    updateController.update({ mark: 'strike', note: 'New renderer' });
    const currentGroup = document.querySelector('[data-hana-id="update-destroy-failure"].hana-annotation');
    const currentNote = document.querySelector('[data-hana-id="update-destroy-failure"].hana-note');
    const updateDestroy = {
      state: updateController.state,
      owned: document.querySelectorAll('[data-hana-id="update-destroy-failure"]').length,
      oldGroupConnected: oldGroup.isConnected,
      oldNoteConnected: oldNote.isConnected,
      currentGroupHidden: currentGroup.hasAttribute('hidden'),
      currentNoteHidden: currentNote.hidden,
      currentNoteDisplay: getComputedStyle(currentNote).display,
      description: direct.getAttribute('aria-describedby'),
      errors: updateErrors,
    };
    updateController.destroy();
    updateDestroy.afterDestroy = document.querySelectorAll('[data-hana-id="update-destroy-failure"]').length;

    return { hideFailure, concurrentDestroy, updateDestroy };
  });

  expect(result.hideFailure).toEqual({
    state: 'suspended',
    groupHidden: true,
    groupDisplay: 'none',
    noteHidden: true,
    noteDisplay: 'none',
    noteVisibility: 'hidden',
    groupClasses: 'hana-annotation',
    noteClasses: 'hana-note hana-is-hidden',
    tabindex: null,
    description: 'author-token',
    activeAnimations: 0,
    errors: ['HANA_STATE_RUNTIME'],
    recoveredState: 'hidden',
    recoveredGroupHidden: true,
    recoveredNoteHidden: true,
  });
  expect(result.concurrentDestroy).toEqual({
    state: 'destroyed',
    failedOwned: 0,
    peerOwned: 2,
    overlays: 1,
    directDescription: 'author-token',
    peerDescription: expect.stringMatching(/^hana-note-/),
    afterPeerDestroy: 0,
  });
  expect(result.updateDestroy).toEqual({
    state: 'suspended',
    owned: 2,
    oldGroupConnected: false,
    oldNoteConnected: false,
    currentGroupHidden: true,
    currentNoteHidden: true,
    currentNoteDisplay: 'none',
    description: 'author-token',
    errors: ['HANA_STATE_RUNTIME'],
    afterDestroy: 0,
  });
});

test('direct target suspends once and recovers only when the same node reconnects', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const arena = document.querySelector('#arena');
    const target = document.querySelector('#direct-target');
    const controller = annotate(target, { mark: 'box', duration: 0 });
    const errors = [];
    target.addEventListener('hana:error', (event) => errors.push(event.detail.error.code));
    controller.show();
    await controller.finished;
    target.remove();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const suspended = controller.state;
    arena.append(target);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const recovered = controller.state;
    const visible = !document.querySelector('.hana-annotation').hasAttribute('hidden');
    controller.destroy();
    return { suspended, recovered, visible, errors };
  });

  expect(result.suspended).toBe('suspended');
  expect(result.recovered).toBe('visible');
  expect(result.visible).toBe(true);
  expect(result.errors).toHaveLength(1);
});

test('selector replacement recovers visibility and accessible ownership', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const arena = document.querySelector('#arena');
    const controller = annotate('#selector-target', {
      mark: 'circle', note: 'Selector note', accessible: true, duration: 0,
    });
    controller.show();
    await controller.finished;
    const original = document.querySelector('#selector-target');
    original.remove();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const suspended = controller.state;
    const replacement = document.createElement('p');
    replacement.id = 'selector-target';
    replacement.className = 'target';
    replacement.textContent = 'Replacement selector target';
    arena.append(replacement);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const output = {
      suspended,
      recovered: controller.state,
      oldDescription: original.getAttribute('aria-describedby'),
      newDescription: replacement.getAttribute('aria-describedby'),
    };
    controller.destroy();
    return output;
  });

  expect(result.suspended).toBe('suspended');
  expect(result.recovered).toBe('visible');
  expect(result.oldDescription).toBe(null);
  expect(result.newDescription).toMatch(/^hana-note-/);
});

test('native Range remains suspended after replacement until update supplies the next Range', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const first = document.querySelector('#range-target');
    const makeRange = (element) => {
      const range = document.createRange();
      range.setStart(element.firstChild, 0);
      range.setEnd(element.firstChild, element.firstChild.data.length);
      return range;
    };
    const controller = annotate(makeRange(first), { mark: 'strike', duration: 0 });
    controller.show();
    await controller.finished;
    first.replaceChildren('Changed native range text');
    controller.refresh();
    const suspended = controller.state;
    const next = document.querySelector('#next-range-target');
    const run = controller.finished;
    controller.update({ target: makeRange(next) });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const output = {
      suspended,
      recovered: controller.state,
      sameRun: controller.finished === run,
      paths: document.querySelectorAll('.hana-mark-path').length,
    };
    controller.destroy();
    return output;
  });

  expect(result).toEqual({ suspended: 'suspended', recovered: 'visible', sameRun: true, paths: 2 });
});

test('expected hide and replay AbortErrors stay owned without stale writes or unhandled rejection', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const unhandled = [];
    window.addEventListener('unhandledrejection', (event) => unhandled.push(event.reason?.name ?? String(event.reason)));
    const controller = annotate('#direct-target', {
      mark: 'underline', note: 'No stale write', duration: 80,
    });
    controller.show();
    const first = controller.finished;
    controller.hide();
    const firstError = await first.then(() => null, (error) => error.name);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const afterHide = {
      state: controller.state,
      hidden: document.querySelector('.hana-annotation').hasAttribute('hidden'),
      noteHidden: document.querySelector('.hana-note').classList.contains('hana-is-hidden'),
    };
    controller.replay();
    const replayed = controller.finished;
    controller.replay();
    const replayError = await replayed.then(() => null, (error) => error.name);
    await controller.finished;
    controller.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { firstError, replayError, afterHide, unhandled };
  });

  expect(result).toEqual({
    firstError: 'AbortError',
    replayError: 'AbortError',
    afterHide: { state: 'hidden', hidden: true, noteHidden: true },
    unhandled: [],
  });
});

test('selector owner replacement rebinds scrolling ancestors for later geometry updates', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const original = document.querySelector('#selector-target');
    const controller = annotate('#selector-target', { mark: 'underline', duration: 0 });
    controller.show();
    await controller.finished;
    const scrollbox = document.createElement('div');
    scrollbox.style.cssText = 'height:80px;overflow:auto;position:absolute;left:300px;top:30px;width:260px';
    const spacer = document.createElement('div');
    spacer.style.height = '180px';
    const replacement = document.createElement('p');
    replacement.id = 'selector-target';
    replacement.textContent = 'Scrolled replacement target';
    scrollbox.append(spacer, replacement);
    original.remove();
    document.querySelector('#arena').append(scrollbox);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const before = document.querySelector('.hana-mark-path').getAttribute('d');
    scrollbox.scrollTop = 140;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = document.querySelector('.hana-mark-path').getAttribute('d');
    controller.destroy();
    return { state: controller.state, moved: before !== after };
  });

  expect(result).toEqual({ state: 'destroyed', moved: true });
});
