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

    async function failCurrentTarget() {
      const first = document.querySelector('#story-first');
      const errors = [];
      let controller;
      first.addEventListener('hana:error', (event) => {
        if (event.detail.controller === controller) {
          errors.push([event.detail.error.code, event.detail.index]);
        }
      });
      controller = story([
        { target: first, mark: 'underline' },
        { target: '#story-second', mark: 'circle' },
      ], { gap: 0, motion: 'never' });
      first.remove();
      controller.play();
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
      replacement.id = 'story-first';
      replacement.className = 'target';
      replacement.textContent = 'First story target';
      document.querySelector('#story-arena').prepend(replacement);
      return result;
    }

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

    const currentTarget = await failCurrentTarget();
    const target = await fail('target');
    const renderer = await fail('renderer');
    return {
      currentTarget,
      target,
      renderer,
      finalOwned: document.querySelectorAll('[data-hana-id]').length,
      finalOverlays: document.querySelectorAll('[data-hana-overlay]').length,
    };
  });

  expect(output).toEqual({
    currentTarget: {
      state: 'cancelled', rejected: 'HANA_TARGET_INVALID',
      errors: [['HANA_TARGET_INVALID', 0]], visible: 0,
    },
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

test('load story starts once before and after DOMContentLoaded and destroy guards queued work', async ({ page }) => {
  const output = await page.evaluate(async () => {
    const { story } = await import('/src/story.js');
    const readyEvents = [];
    const ready = story([
      { target: '#story-first', mark: 'underline' },
      { target: '#story-second', mark: 'box' },
    ], { trigger: 'load', gap: 0, motion: 'never' });
    document.querySelector('#story-first').addEventListener('hana:start', (event) => {
      if (event.detail.controller === ready) readyEvents.push('start');
    });
    const readyImmediate = ready.state;
    await Promise.resolve();
    await ready.finished;
    const readyAfter = ready.state;
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await Promise.resolve();

    const staleEvents = [];
    const stale = story([
      { target: '#story-first', mark: 'strike' },
    ], { trigger: 'load', gap: 0, motion: 'never' });
    document.querySelector('#story-first').addEventListener('hana:start', (event) => {
      if (event.detail.controller === stale) staleEvents.push('start');
    });
    stale.destroy();
    await Promise.resolve();

    const frame = document.createElement('iframe');
    document.body.append(frame);
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    doc.open();
    doc.write('<!doctype html><html><body><span id="first" style="display:inline-block">Frame first</span><span id="second" style="display:inline-block">Frame second</span></body></html>');
    const api = await win.eval("import('/src/story.js')");
    const frameEvents = [];
    let loading;
    doc.body.addEventListener('hana:start', (event) => {
      if (event.detail.controller === loading) frameEvents.push(event.target.id);
    });
    loading = api.story([
      { target: doc.querySelector('#first'), mark: 'highlight' },
      { target: doc.querySelector('#second'), mark: 'circle' },
    ], { trigger: 'load', gap: 0, motion: 'never' });
    const loadingBefore = { state: loading.state, events: [...frameEvents] };
    const loaded = new Promise((resolve) => {
      doc.addEventListener('DOMContentLoaded', () => win.queueMicrotask(resolve), { once: true });
    });
    doc.close();
    await loaded;
    await loading.finished;
    doc.dispatchEvent(new win.Event('DOMContentLoaded'));
    await Promise.resolve();
    const loadingAfter = { state: loading.state, events: [...frameEvents] };

    ready.destroy();
    loading.destroy();
    frame.remove();
    return {
      readyImmediate,
      readyAfter,
      readyEvents,
      stale: { state: stale.state, events: staleEvents },
      loadingBefore,
      loadingAfter,
      finalOwned: document.querySelectorAll('[data-hana-id]').length,
      finalOverlays: document.querySelectorAll('[data-hana-overlay]').length,
    };
  });

  expect(output).toEqual({
    readyImmediate: 'idle',
    readyAfter: 'complete',
    readyEvents: ['start'],
    stale: { state: 'destroyed', events: [] },
    loadingBefore: { state: 'idle', events: [] },
    loadingAfter: { state: 'complete', events: ['first'] },
    finalOwned: 0,
    finalOverlays: 0,
  });
});

test('viewport once story uses shared threshold and permanently unsubscribes after start', async ({ page }) => {
  const output = await page.evaluate(async () => {
    class FakeIntersectionObserver {
      static instances = [];
      constructor(callback, options) {
        Object.assign(this, {
          callback, options, target: null, unobserved: [], disconnects: 0,
        });
        FakeIntersectionObserver.instances.push(this);
      }
      observe(target) { this.target = target; }
      unobserve(target) { this.unobserved.push(target.id); }
      disconnect() { this.disconnects += 1; }
      emit(ratio, isIntersecting = ratio > 0) {
        this.callback([{
          target: this.target, intersectionRatio: ratio, isIntersecting,
        }], this);
      }
    }
    window.IntersectionObserver = FakeIntersectionObserver;
    const { story } = await import('/src/story.js');
    const first = document.querySelector('#story-first');
    const events = [];
    let controller;
    first.addEventListener('hana:start', (event) => {
      if (event.detail.controller === controller) events.push('start');
    });
    controller = story([
      { target: '#story-first', mark: 'underline' },
      { target: '#story-second', mark: 'circle' },
    ], { trigger: 'viewport', gap: 0, motion: 'never' });
    const observer = FakeIntersectionObserver.instances[0];
    const initial = {
      state: controller.state,
      count: FakeIntersectionObserver.instances.length,
      threshold: observer?.options.threshold,
      target: observer?.target?.id,
    };
    observer?.emit(0.24, true);
    const below = { state: controller.state, events: [...events] };
    observer?.emit(0.25, true);
    await controller.finished;
    const entered = {
      state: controller.state,
      events: [...events],
      unobserved: observer?.unobserved,
      disconnects: observer?.disconnects,
    };
    observer?.emit(0, false);
    observer?.emit(1, true);
    const afterReentry = { state: controller.state, events: [...events] };
    controller.destroy();
    return {
      initial,
      below,
      entered,
      afterReentry,
      finalOwned: document.querySelectorAll('[data-hana-id]').length,
      finalOverlays: document.querySelectorAll('[data-hana-overlay]').length,
    };
  });

  expect(output).toEqual({
    initial: { state: 'idle', count: 1, threshold: 0.25, target: 'story-first' },
    below: { state: 'idle', events: [] },
    entered: { state: 'complete', events: ['start'], unobserved: ['story-first'], disconnects: 1 },
    afterReentry: { state: 'complete', events: ['start'] },
    finalOwned: 0,
    finalOverlays: 0,
  });
});

test('repeating viewport story cancels only on full exit and replays every re-entry', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const output = await page.evaluate(async () => {
    class FakeIntersectionObserver {
      static instance;
      constructor(callback, options) {
        Object.assign(this, {
          callback, options, target: null, unobserved: 0, disconnects: 0,
        });
        FakeIntersectionObserver.instance = this;
      }
      observe(target) { this.target = target; }
      unobserve() { this.unobserved += 1; }
      disconnect() { this.disconnects += 1; }
      emit(ratio, isIntersecting = ratio > 0) {
        this.callback([{
          target: this.target, intersectionRatio: ratio, isIntersecting,
        }], this);
      }
    }
    window.IntersectionObserver = FakeIntersectionObserver;
    const { story } = await import('/src/story.js');
    const first = document.querySelector('#story-first');
    const events = [];
    let controller;
    for (const type of ['hana:start', 'hana:cancel', 'hana:complete']) {
      first.addEventListener(type, (event) => {
        if (event.detail.controller === controller) {
          events.push([type, event.detail.reason ?? event.detail.state]);
        }
      });
    }
    controller = story([
      { target: '#story-first', mark: 'underline', duration: 80 },
      { target: '#story-second', mark: 'box', duration: 80 },
    ], { trigger: 'viewport', once: false, gap: 0 });
    const observer = FakeIntersectionObserver.instance;
    observer.emit(1, true);
    const entered = controller.state;
    observer.emit(0.1, true);
    const partial = controller.state;
    observer.emit(0, false);
    const exited = controller.state;
    observer.emit(1, true);
    await controller.finished;
    const firstReplay = { state: controller.state, events: [...events] };
    observer.emit(0.1, true);
    observer.emit(1, true);
    await Promise.resolve();
    const noPartialReplay = { state: controller.state, starts: events.filter(([type]) => type === 'hana:start').length };
    observer.emit(0, false);
    const completedExit = controller.state;
    observer.emit(1, true);
    await controller.finished;
    const secondReplay = { state: controller.state, events: [...events] };
    controller.destroy();
    return {
      threshold: observer.options.threshold,
      entered,
      partial,
      exited,
      firstReplay,
      noPartialReplay,
      completedExit,
      secondReplay,
      cleanup: [observer.unobserved, observer.disconnects],
      finalOverlays: document.querySelectorAll('[data-hana-overlay]').length,
    };
  });

  expect(output).toEqual({
    threshold: 0.25,
    entered: 'playing',
    partial: 'playing',
    exited: 'cancelled',
    firstReplay: {
      state: 'complete',
      events: [
        ['hana:start', 'playing'], ['hana:cancel', 'cancel'],
        ['hana:start', 'playing'], ['hana:complete', 'complete'],
      ],
    },
    noPartialReplay: { state: 'complete', starts: 2 },
    completedExit: 'complete',
    secondReplay: {
      state: 'complete',
      events: [
        ['hana:start', 'playing'], ['hana:cancel', 'cancel'],
        ['hana:start', 'playing'], ['hana:complete', 'complete'],
        ['hana:start', 'playing'], ['hana:complete', 'complete'],
      ],
    },
    cleanup: [1, 1],
    finalOverlays: 0,
  });
});

test('viewport trigger follows a pending selector owner replacement', async ({ page }) => {
  const output = await page.evaluate(async () => {
    class FakeIntersectionObserver {
      static instances = [];
      constructor(callback, options) {
        Object.assign(this, {
          callback, options, target: null, unobserved: [], disconnects: 0,
        });
        FakeIntersectionObserver.instances.push(this);
      }
      observe(target) { this.target = target; }
      unobserve(target) { this.unobserved.push(target.textContent); }
      disconnect() { this.disconnects += 1; }
      enter() {
        this.callback([{
          target: this.target, intersectionRatio: 1, isIntersecting: true,
        }], this);
      }
    }
    window.IntersectionObserver = FakeIntersectionObserver;
    const { story } = await import('/src/story.js');
    const events = [];
    document.body.addEventListener('hana:start', (event) => {
      if (event.detail.controller === window.pendingStory) events.push(event.target.textContent);
    });
    const controller = story([
      { target: '#story-first', mark: 'circle' },
      { target: '#story-second', mark: 'underline' },
    ], { trigger: 'viewport', gap: 0, motion: 'never' });
    window.pendingStory = controller;
    const oldObserver = FakeIntersectionObserver.instances[0];
    const old = document.querySelector('#story-first');
    const replacement = document.createElement('p');
    replacement.id = 'story-first';
    replacement.className = 'target';
    replacement.textContent = 'Replacement first owner';
    old.replaceWith(replacement);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const nextObserver = FakeIntersectionObserver.instances[1];
    oldObserver.enter();
    const afterOld = { state: controller.state, events: [...events] };
    nextObserver?.enter();
    await controller.finished;
    const afterNext = { state: controller.state, events: [...events] };
    const result = {
      count: FakeIntersectionObserver.instances.length,
      oldTarget: oldObserver.target.textContent,
      oldCleanup: [oldObserver.unobserved, oldObserver.disconnects],
      nextTarget: nextObserver?.target.textContent,
      nextCleanup: [nextObserver?.unobserved, nextObserver?.disconnects],
      afterOld,
      afterNext,
    };
    controller.destroy();
    return result;
  });

  expect(output).toEqual({
    count: 2,
    oldTarget: 'First story target',
    oldCleanup: [['First story target'], 1],
    nextTarget: 'Replacement first owner',
    nextCleanup: [['Replacement first owner'], 1],
    afterOld: { state: 'idle', events: [] },
    afterNext: { state: 'complete', events: ['Replacement first owner'] },
  });
});

test('viewport fallback runs once with load semantics and trigger cleanup is reentrancy safe', async ({ page }) => {
  const output = await page.evaluate(async () => {
    const first = document.querySelector('#story-first');
    window.IntersectionObserver = undefined;
    const { story } = await import('/src/story.js');
    const fallbackEvents = [];
    let fallback;
    first.addEventListener('hana:start', (event) => {
      if (event.detail.controller === fallback) fallbackEvents.push('start');
    });
    fallback = story([
      { target: '#story-first', mark: 'highlight' },
    ], { trigger: 'viewport', once: false, gap: 0, motion: 'never' });
    const fallbackImmediate = fallback.state;
    await Promise.resolve();
    await fallback.finished;
    const fallbackAfter = fallback.state;
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await Promise.resolve();

    class ReentrantIntersectionObserver {
      static instance;
      constructor(callback) {
        Object.assign(this, { callback, target: null, unobserved: 0, disconnects: 0 });
        ReentrantIntersectionObserver.instance = this;
      }
      observe(target) { this.target = target; }
      unobserve() {
        this.unobserved += 1;
        reentrant.destroy();
        throw new Error('intersection cleanup failed');
      }
      disconnect() { this.disconnects += 1; }
      enter() {
        this.callback([{
          target: this.target, intersectionRatio: 1, isIntersecting: true,
        }], this);
      }
    }
    window.IntersectionObserver = ReentrantIntersectionObserver;
    const reentrantEvents = [];
    let reentrant;
    first.addEventListener('hana:start', (event) => {
      if (event.detail.controller === reentrant) reentrantEvents.push('start');
    });
    reentrant = story([
      { target: '#story-first', mark: 'box' },
    ], { trigger: 'viewport', gap: 0, motion: 'never' });
    ReentrantIntersectionObserver.instance.enter();
    await Promise.resolve();

    const result = {
      fallbackImmediate,
      fallbackAfter,
      fallbackEvents,
      reentrant: {
        state: reentrant.state,
        events: reentrantEvents,
        unobserved: ReentrantIntersectionObserver.instance.unobserved,
        disconnects: ReentrantIntersectionObserver.instance.disconnects,
      },
    };
    fallback.destroy();
    result.finalOwned = document.querySelectorAll('[data-hana-id]').length;
    result.finalOverlays = document.querySelectorAll('[data-hana-overlay]').length;
    return result;
  });

  expect(output).toEqual({
    fallbackImmediate: 'idle',
    fallbackAfter: 'complete',
    fallbackEvents: ['start'],
    reentrant: { state: 'destroyed', events: [], unobserved: 1, disconnects: 1 },
    finalOwned: 0,
    finalOverlays: 0,
  });
});
