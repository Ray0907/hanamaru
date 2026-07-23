import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquireDocumentResources,
  acquireDocumentScheduler,
  FrameQueue,
} from '../../src/scheduler.js';
import { runtimeState } from '../../src/runtime-state.js';

function createHarness(callbackOverrides = {}) {
  const generations = new Map();
  const requested = [];
  const canceled = [];
  let nextFrameId = 1;

  const queue = new FrameQueue({
    requestFrame(callback) {
      const frame = { id: nextFrameId, callback };
      nextFrameId += 1;
      requested.push(frame);
      return frame.id;
    },
    cancelFrame(frameId) {
      canceled.push(frameId);
    },
    generationFor(key) {
      return generations.get(key);
    },
    ...callbackOverrides,
  });

  function runFrame(index = requested.length - 1) {
    requested[index].callback();
  }

  return { canceled, generations, queue, requested, runFrame };
}

function job(key, generation, events, label = key, overrides = {}) {
  return {
    key,
    generation,
    read() {
      events.push(`read:${label}`);
      return `value:${label}`;
    },
    write(value) {
      events.push(`write:${label}:${value}`);
    },
    onError(error) {
      events.push(`error:${label}:${error.message}`);
    },
    ...overrides,
  };
}

test('Document setup rolls back created observers when mutation observation mutates then throws', () => {
  const cause = new Error('observe failed after its side effect');
  const events = [];
  class FakeResizeObserver {
    disconnect() {
      events.push('resize:disconnect');
    }
  }
  class FakeMutationObserver {
    observe() {
      events.push('mutation:observe');
      throw cause;
    }

    disconnect() {
      events.push('mutation:disconnect');
    }
  }
  const visualViewport = {
    addEventListener() {
      events.push('viewport:add');
    },
    removeEventListener() {
      events.push('viewport:remove');
    },
  };
  const view = {
    MutationObserver: FakeMutationObserver,
    ResizeObserver: FakeResizeObserver,
    visualViewport,
    requestAnimationFrame() {},
    cancelAnimationFrame() {},
    addEventListener() {
      events.push('window:add');
    },
    removeEventListener() {
      events.push('window:remove');
    },
  };
  const document = {
    body: {
      append() {},
    },
    createElement(name) {
      const element = {
        append() {},
        className: '',
        remove() {
          if (element === overlay) events.push('portal:remove');
        },
        setAttribute() {},
      };
      if (name === 'div' && overlay === undefined) overlay = element;
      return element;
    },
    createElementNS() {
      return {
        setAttribute() {},
      };
    },
    defaultView: view,
    nodeType: 9,
  };
  let overlay;

  assert.throws(
    () => acquireDocumentResources(document),
    (error) => error === cause,
  );
  assert.deepEqual(events, [
    'mutation:observe',
    'resize:disconnect',
    'mutation:disconnect',
    'portal:remove',
  ]);
  assert.equal(runtimeState.documents.has(document), false);
});

test('Document setup preserves its original failure and attaches the first rollback failure', () => {
  const setupCause = new Error('setup failed');
  const rollbackCause = new Error('resize disconnect failed');
  const events = [];
  class FakeResizeObserver {
    disconnect() {
      events.push('resize:disconnect');
      throw rollbackCause;
    }
  }
  class FakeMutationObserver {
    observe() {
      throw setupCause;
    }

    disconnect() {
      events.push('mutation:disconnect');
    }
  }
  const view = {
    MutationObserver: FakeMutationObserver,
    ResizeObserver: FakeResizeObserver,
    visualViewport: null,
    requestAnimationFrame() {},
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
  };
  const document = {
    defaultView: view,
    nodeType: 9,
  };
  let delivered;

  assert.throws(
    () => acquireDocumentScheduler(document),
    (error) => {
      delivered = error;
      return error === setupCause;
    },
  );
  assert.strictEqual(delivered.rollbackCause, rollbackCause);
  assert.deepEqual(events, ['resize:disconnect', 'mutation:disconnect']);
  assert.equal(runtimeState.documents.has(document), false);
});

test('Document setup removes every listener reserved before a visual viewport add throws', () => {
  const cause = new Error('viewport scroll listener failed after side effect');
  const events = [];
  class FakeResizeObserver {
    disconnect() {
      events.push('resize:disconnect');
    }
  }
  class FakeMutationObserver {
    observe() {
      events.push('mutation:observe');
    }

    disconnect() {
      events.push('mutation:disconnect');
    }
  }
  const visualViewport = {
    addEventListener(type) {
      events.push(`viewport:add:${type}`);
      if (type === 'scroll') throw cause;
    },
    removeEventListener(type) {
      events.push(`viewport:remove:${type}`);
    },
  };
  const view = {
    MutationObserver: FakeMutationObserver,
    ResizeObserver: FakeResizeObserver,
    visualViewport,
    requestAnimationFrame() {},
    cancelAnimationFrame() {},
    addEventListener(type) {
      events.push(`window:add:${type}`);
    },
    removeEventListener(type) {
      events.push(`window:remove:${type}`);
    },
  };
  const document = {
    defaultView: view,
    nodeType: 9,
  };

  assert.throws(
    () => acquireDocumentScheduler(document),
    (error) => error === cause,
  );
  assert.deepEqual(events, [
    'mutation:observe',
    'window:add:resize',
    'viewport:add:resize',
    'viewport:add:scroll',
    'resize:disconnect',
    'mutation:disconnect',
    'window:remove:resize',
    'viewport:remove:resize',
    'viewport:remove:scroll',
  ]);
  assert.equal(runtimeState.documents.has(document), false);
});

test('coalesces one frame and moves a same-key replacement to the latest position', () => {
  const { generations, queue, requested, runFrame } = createHarness();
  const events = [];
  generations.set('a', 1);
  generations.set('b', 1);

  queue.enqueue(job('a', 1, events, 'a-old'));
  queue.enqueue(job('b', 1, events));
  queue.enqueue(job('a', 1, events, 'a-new'));

  assert.equal(requested.length, 1);
  runFrame();
  assert.deepEqual(events, [
    'read:b',
    'read:a-new',
    'write:b:value:b',
    'write:a-new:value:a-new',
  ]);
});

test('runs every surviving read before any write', () => {
  const { generations, queue, runFrame } = createHarness();
  const events = [];
  generations.set('a', 4);
  generations.set('b', 7);

  queue.enqueue(job('a', 4, events));
  queue.enqueue(job('b', 7, events));
  runFrame();

  assert.deepEqual(events, [
    'read:a',
    'read:b',
    'write:a:value:a',
    'write:b:value:b',
  ]);
});

test('stages every prepare read and apply write before geometry reads and final writes', () => {
  const { generations, queue, runFrame } = createHarness();
  const events = [];
  generations.set('a', 1);
  generations.set('b', 1);

  for (const key of ['a', 'b']) {
    queue.enqueue(job(key, 1, events, key, {
      prepare() {
        events.push(`prepare:${key}`);
        return `theme:${key}`;
      },
      apply(value) {
        events.push(`apply:${key}:${value}`);
      },
    }));
  }
  runFrame();

  assert.deepEqual(events, [
    'prepare:a',
    'prepare:b',
    'apply:a:theme:a',
    'apply:b:theme:b',
    'read:a',
    'read:b',
    'write:a:value:a',
    'write:b:value:b',
  ]);
});

test('brackets the complete read-all write-all batch with one pair of frame hooks', () => {
  const events = [];
  const { generations, queue, runFrame } = createHarness({
    beforeFlush() { events.push('before'); },
    afterFlush() { events.push('after'); },
  });
  generations.set('a', 1);
  generations.set('b', 1);

  queue.enqueue(job('a', 1, events));
  queue.enqueue(job('b', 1, events));
  runFrame();

  assert.deepEqual(events, [
    'before',
    'read:a',
    'read:b',
    'write:a:value:a',
    'write:b:value:b',
    'after',
  ]);
});

test('runs the afterFlush hook when error reporting destroys the queue mid-flush', () => {
  const events = [];
  const { generations, queue, runFrame } = createHarness({
    beforeFlush() { events.push('before'); },
    afterFlush() { events.push('after'); },
  });
  generations.set('broken', 1);
  generations.set('peer', 1);

  queue.enqueue(job('broken', 1, events, 'broken', {
    read() {
      events.push('read:broken');
      throw new Error('stop this frame');
    },
    onError(error) {
      events.push(`error:broken:${error.message}`);
      queue.destroy();
    },
  }));
  queue.enqueue(job('peer', 1, events));
  runFrame();

  assert.deepEqual(events, [
    'before',
    'read:broken',
    'read:peer',
    'error:broken:stop this frame',
    'after',
  ]);
});

test('skips jobs that are stale before their read', () => {
  const { generations, queue, runFrame } = createHarness();
  const events = [];
  generations.set('stale', 2);

  queue.enqueue(job('stale', 1, events));
  runFrame();

  assert.deepEqual(events, []);
});

test('rechecks generation before write and skips a value made stale by a later read', () => {
  const { generations, queue, runFrame } = createHarness();
  const events = [];
  generations.set('first', 1);
  generations.set('second', 1);

  queue.enqueue(job('first', 1, events));
  queue.enqueue(job('second', 1, events, 'second', {
    read() {
      events.push('read:second');
      generations.set('first', 2);
      return 'value:second';
    },
  }));
  runFrame();

  assert.deepEqual(events, [
    'read:first',
    'read:second',
    'write:second:value:second',
  ]);
});

test('isolates a read failure, skips its write, and reports it once', () => {
  const { generations, queue, runFrame } = createHarness();
  const events = [];
  generations.set('broken', 1);
  generations.set('peer', 1);

  queue.enqueue(job('broken', 1, events, 'broken', {
    read() {
      events.push('read:broken');
      throw new Error('read failed');
    },
  }));
  queue.enqueue(job('peer', 1, events));
  runFrame();

  assert.deepEqual(events, [
    'read:broken',
    'read:peer',
    'error:broken:read failed',
    'write:peer:value:peer',
  ]);
});

test('defers read error reporting until every candidate read has completed', () => {
  const { generations, queue, runFrame } = createHarness();
  const events = [];
  let reportMutatedState = false;
  generations.set('broken', 1);
  generations.set('peer', 1);

  queue.enqueue(job('broken', 1, events, 'broken', {
    read() {
      events.push('read:broken');
      throw new Error('read failed');
    },
    onError(error) {
      reportMutatedState = true;
      events.push(`error:broken:${error.message}`);
    },
  }));
  queue.enqueue(job('peer', 1, events, 'peer', {
    read() {
      events.push(`read:peer:mutated=${reportMutatedState}`);
      return 'value:peer';
    },
  }));
  runFrame();

  assert.deepEqual(events, [
    'read:broken',
    'read:peer:mutated=false',
    'error:broken:read failed',
    'write:peer:value:peer',
  ]);
});

test('drops a deferred read error made stale and rechecks liveness after reporting', () => {
  const { generations, queue, runFrame } = createHarness();
  const events = [];
  generations.set('stale-error', 1);
  generations.set('fatal-error', 1);
  generations.set('peer', 1);

  queue.enqueue(job('stale-error', 1, events, 'stale-error', {
    read() {
      events.push('read:stale-error');
      throw new Error('stale failure');
    },
  }));
  queue.enqueue(job('fatal-error', 1, events, 'fatal-error', {
    read() {
      events.push('read:fatal-error');
      generations.set('stale-error', 2);
      throw new Error('fatal failure');
    },
    onError(error) {
      events.push(`error:fatal-error:${error.message}`);
      queue.destroy();
    },
  }));
  queue.enqueue(job('peer', 1, events));
  runFrame();

  assert.deepEqual(events, [
    'read:stale-error',
    'read:fatal-error',
    'read:peer',
    'error:fatal-error:fatal failure',
  ]);
});

test('isolates a write failure and reports it once', () => {
  const { generations, queue, runFrame } = createHarness();
  const events = [];
  generations.set('broken', 1);
  generations.set('peer', 1);

  queue.enqueue(job('broken', 1, events, 'broken', {
    write() {
      events.push('write:broken');
      throw new Error('write failed');
    },
  }));
  queue.enqueue(job('peer', 1, events));
  runFrame();

  assert.deepEqual(events, [
    'read:broken',
    'read:peer',
    'write:broken',
    'error:broken:write failed',
    'write:peer:value:peer',
  ]);
});

test('does not let a throwing onError block peer jobs', () => {
  const { generations, queue, runFrame } = createHarness();
  const events = [];
  generations.set('broken', 1);
  generations.set('peer', 1);

  queue.enqueue(job('broken', 1, events, 'broken', {
    read() {
      events.push('read:broken');
      throw new Error('read failed');
    },
    onError(error) {
      events.push(`error:broken:${error.message}`);
      throw new Error('report failed');
    },
  }));
  queue.enqueue(job('peer', 1, events));

  assert.doesNotThrow(() => runFrame());
  assert.deepEqual(events, [
    'read:broken',
    'read:peer',
    'error:broken:read failed',
    'write:peer:value:peer',
  ]);
});

test('cancel removes pending jobs and cancels the scheduled frame only when empty', () => {
  const { canceled, generations, queue, requested, runFrame } = createHarness();
  const events = [];
  generations.set('a', 1);
  generations.set('b', 1);

  queue.enqueue(job('a', 1, events));
  queue.enqueue(job('b', 1, events));
  queue.cancel('unknown');
  queue.cancel('a');
  assert.deepEqual(canceled, []);

  queue.cancel('b');
  queue.cancel('b');
  assert.deepEqual(canceled, [1]);

  queue.enqueue(job('a', 1, events, 'new'));
  assert.equal(requested.length, 2);
  runFrame(1);
  assert.deepEqual(events, ['read:new', 'write:new:value:new']);
});

test('preserves a new frame scheduled reentrantly by cancelFrame', () => {
  const generations = new Map([
    ['old', 1],
    ['new', 1],
  ]);
  const requested = [];
  const events = [];
  let nextFrameId = 1;
  let queue;

  queue = new FrameQueue({
    requestFrame(callback) {
      const frame = { id: nextFrameId, callback };
      nextFrameId += 1;
      requested.push(frame);
      return frame.id;
    },
    cancelFrame() {
      queue.enqueue(job('new', 1, events));
    },
    generationFor(key) {
      return generations.get(key);
    },
  });

  queue.enqueue(job('old', 1, events));
  queue.cancel('old');

  assert.equal(requested.length, 2);
  requested[1].callback();
  assert.deepEqual(events, ['read:new', 'write:new:value:new']);
});

test('defers jobs enqueued during a read to exactly one later frame', () => {
  const { generations, queue, requested, runFrame } = createHarness();
  const events = [];
  generations.set('active', 1);
  generations.set('later-a', 1);
  generations.set('later-b', 1);

  queue.enqueue(job('active', 1, events, 'active', {
    read() {
      events.push('read:active');
      queue.enqueue(job('later-a', 1, events));
      queue.enqueue(job('later-b', 1, events));
      return 'value:active';
    },
  }));

  runFrame(0);
  assert.equal(requested.length, 2);
  assert.deepEqual(events, ['read:active', 'write:active:value:active']);

  runFrame(1);
  assert.deepEqual(events, [
    'read:active',
    'write:active:value:active',
    'read:later-a',
    'read:later-b',
    'write:later-a:value:later-a',
    'write:later-b:value:later-b',
  ]);
});

test('destroy cancels once, clears work, ignores an already-captured frame, and rejects enqueue', () => {
  const { canceled, generations, queue, requested } = createHarness();
  const events = [];
  generations.set('a', 1);
  queue.enqueue(job('a', 1, events));
  const alreadyCapturedCallback = requested[0].callback;

  queue.destroy();
  queue.destroy();

  assert.deepEqual(canceled, [1]);
  assert.doesNotThrow(() => alreadyCapturedCallback());
  assert.deepEqual(events, []);
  assert.throws(
    () => queue.enqueue(job('a', 1, events)),
    /destroyed/i,
  );
});

test('validates required injected callbacks and job callbacks clearly', () => {
  const noop = () => {};

  assert.throws(
    () => new FrameQueue({ requestFrame: null, cancelFrame: noop, generationFor: noop }),
    /requestFrame.*function/i,
  );
  assert.throws(
    () => new FrameQueue({
      requestFrame: noop, cancelFrame: noop, generationFor: noop, beforeFlush: null,
    }),
    /beforeFlush.*function/i,
  );
  assert.throws(
    () => new FrameQueue({
      requestFrame: noop, cancelFrame: noop, generationFor: noop, afterFlush: null,
    }),
    /afterFlush.*function/i,
  );

  const { queue } = createHarness();
  assert.throws(
    () => queue.enqueue({ key: 'a', generation: 1, read: null, write: noop }),
    /read.*function/i,
  );
  assert.throws(
    () => queue.enqueue({ key: 'a', generation: 1, read: noop, write: null }),
    /write.*function/i,
  );
  assert.throws(
    () => queue.enqueue({ key: 'a', generation: 1, read: noop, write: noop, onError: null }),
    /onError.*function/i,
  );
});

function createDependencyRegistrationHarness(mode) {
  const cause = new Error(`${mode} registration failed after its side effect`);
  const resizeEvents = [];
  const observeCallbacks = new Map();
  const removeFailures = new Map();
  const scrollAddCallbacks = new Map();
  const scrollRemoveCallbacks = new Map();
  const terminalEvents = [];
  const unobserveCallbacks = new Map();
  const unobserveFailures = new Map();
  let fail = false;
  let resizeObserver;
  let document;

  const element = (name, overflow = false) => {
    const listeners = new Set();
    const events = [];
    const value = {
      name,
      nodeType: 1,
      ownerDocument: null,
      parentElement: null,
      listeners,
      events,
      overflow,
      addEventListener(type, listener) {
        if (type !== 'scroll') return;
        events.push('add');
        listeners.add(listener);
        scrollAddCallbacks.get(value)?.();
        if (fail && mode === 'scroll' && value === nextScrollB) throw cause;
      },
      removeEventListener(type, listener) {
        if (type !== 'scroll') return;
        events.push('remove');
        terminalEvents.push(`remove:${name}`);
        listeners.delete(listener);
        scrollRemoveCallbacks.get(value)?.();
        const error = removeFailures.get(value);
        if (error !== undefined) throw error;
      },
      contains(candidate) {
        let current = candidate;
        while (current !== null && current !== undefined) {
          if (current === value) return true;
          current = current.parentElement;
        }
        return false;
      },
    };
    return value;
  };

  const target = element('target');
  const oldScroll = element('old-scroll', true);
  const oldScrollB = element('old-scroll-b', true);
  const oldResize = element('old-resize');
  const oldResizeB = element('old-resize-b');
  const nextScrollA = element('next-scroll-a', true);
  const nextScrollB = element('next-scroll-b', true);
  const nextResizeA = element('next-resize-a');
  const nextResizeB = element('next-resize-b');
  const allElements = [
    target,
    oldScroll,
    oldScrollB,
    oldResize,
    oldResizeB,
    nextScrollA,
    nextScrollB,
    nextResizeA,
    nextResizeB,
  ];

  class FakeResizeObserver {
    observed = new Set();

    constructor() {
      resizeObserver = this;
    }

    observe(candidate) {
      resizeEvents.push(`observe:${candidate.name}`);
      this.observed.add(candidate);
      observeCallbacks.get(candidate)?.();
      if (fail && mode === 'resize' && candidate === nextResizeB) throw cause;
    }

    unobserve(candidate) {
      resizeEvents.push(`unobserve:${candidate.name}`);
      terminalEvents.push(`unobserve:${candidate.name}`);
      this.observed.delete(candidate);
      unobserveCallbacks.get(candidate)?.();
      const error = unobserveFailures.get(candidate);
      if (error !== undefined) throw error;
    }

    disconnect() {
      this.observed.clear();
    }
  }

  class FakeMutationObserver {
    observe() {}

    disconnect() {}
  }

  const viewListeners = new Set();
  const view = {
    MutationObserver: FakeMutationObserver,
    ResizeObserver: FakeResizeObserver,
    visualViewport: null,
    getComputedStyle(candidate) {
      const overflow = candidate.overflow ? 'auto' : 'visible';
      return { overflowX: overflow, overflowY: overflow };
    },
    requestAnimationFrame() {
      return 1;
    },
    cancelAnimationFrame() {},
    addEventListener(type, listener) {
      if (type === 'scroll') viewListeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'scroll') viewListeners.delete(listener);
    },
  };
  document = {
    defaultView: view,
    nodeType: 9,
    body: element('body'),
    documentElement: element('document-element'),
    scrollingElement: null,
  };
  document.scrollingElement = document.documentElement;
  for (const candidate of [...allElements, document.body, document.documentElement]) {
    candidate.ownerDocument = document;
  }

  const dependencies = (scrollTargets, resizeTargets) => ({
    ancestors: scrollTargets,
    hosts: [],
    preceding: resizeTargets,
    roots: [],
  });
  const oldDependencies = dependencies([oldScroll, oldScrollB], [oldResize, oldResizeB]);
  const nextDependencies = dependencies(
    mode === 'scroll' ? [nextScrollA, nextScrollB] : [nextScrollA],
    mode === 'resize' ? [nextResizeA, nextResizeB] : [],
  );
  const record = {
    element: target,
    kind: 'element',
    ownerElement: target,
  };

  return {
    cause,
    document,
    nextResizeA,
    nextResizeB,
    nextScrollA,
    nextScrollB,
    oldDependencies,
    oldResize,
    oldResizeB,
    oldScroll,
    oldScrollB,
    observeCallbacks,
    nextDependencies,
    record,
    removeFailures,
    resizeObserver() {
      return resizeObserver;
    },
    resizeEvents,
    scrollAddCallbacks,
    scrollRemoveCallbacks,
    setFailure(value) {
      fail = value;
    },
    terminalEvents,
    unobserveCallbacks,
    unobserveFailures,
  };
}

for (const mode of ['scroll', 'resize']) {
  test(`dynamic ${mode} registration rolls back partial dependency replacement and retries`, () => {
    const harness = createDependencyRegistrationHarness(mode);
    const lease = acquireDocumentScheduler(harness.document);
    const id = `transaction-${mode}`;
    lease.shared.registerController(id);
    const options = {
      generation: 0,
      layoutDependencies: harness.oldDependencies,
      onError() {},
      read() {},
      record: harness.record,
      write() {},
    };
    lease.shared.observeLayout({ id, ...options });

    assert.equal(harness.oldScroll.listeners.size, 1);
    assert.match(harness.resizeEvents.join(','), /observe:old-resize/u);

    lease.shared.bumpGeneration(id);
    harness.setFailure(true);
    assert.throws(
      () => lease.shared.rebindLayout(id, {
        ...options,
        generation: 1,
        layoutDependencies: () => harness.nextDependencies,
      }),
      (error) => error === harness.cause,
    );

    assert.equal(harness.oldScroll.listeners.size, 1);
    assert.equal(
      harness.resizeEvents.filter((event) => event === 'unobserve:old-resize').length,
      0,
    );
    assert.equal(harness.nextScrollA.listeners.size, 0);
    if (mode === 'scroll') assert.equal(harness.nextScrollB.listeners.size, 0);
    if (mode === 'resize') {
      assert.equal(
        harness.resizeEvents.filter((event) => event === 'unobserve:next-resize-a').length,
        1,
      );
      assert.equal(
        harness.resizeEvents.filter((event) => event === 'unobserve:next-resize-b').length,
        1,
      );
    }

    harness.setFailure(false);
    lease.shared.rebindLayout(id, {
      ...options,
      generation: 1,
      layoutDependencies: () => harness.nextDependencies,
    });

    assert.equal(harness.oldScroll.listeners.size, 0);
    assert.equal(harness.nextScrollA.events.filter((event) => event === 'add').length, 2);
    assert.equal(harness.nextScrollA.listeners.size, 1);
    if (mode === 'scroll') {
      assert.equal(harness.nextScrollB.events.filter((event) => event === 'add').length, 2);
      assert.equal(harness.nextScrollB.listeners.size, 1);
    } else {
      assert.equal(
        harness.resizeEvents.filter((event) => event === 'observe:next-resize-a').length,
        2,
      );
      assert.equal(
        harness.resizeEvents.filter((event) => event === 'observe:next-resize-b').length,
        2,
      );
    }

    lease.shared.releaseController(id);
    lease.release();
    assert.equal(harness.nextScrollA.listeners.size, 0);
    assert.equal(
      harness.nextScrollA.events.filter((event) => event === 'remove').length,
      2,
    );
    if (mode === 'scroll') {
      assert.equal(harness.nextScrollB.listeners.size, 0);
      assert.equal(
        harness.nextScrollB.events.filter((event) => event === 'remove').length,
        2,
      );
    } else {
      assert.equal(
        harness.resizeEvents.filter((event) => event === 'unobserve:next-resize-a').length,
        2,
      );
      assert.equal(
        harness.resizeEvents.filter((event) => event === 'unobserve:next-resize-b').length,
        2,
      );
    }
  });
}

for (const terminalMode of ['scroll', 'resize', 'both']) {
  test(`terminal ${terminalMode} cleanup never restores dead layout registrations`, () => {
    const harness = createDependencyRegistrationHarness('none');
    const lease = acquireDocumentScheduler(harness.document);
    const id = `terminal-${terminalMode}`;
    const scrollCause = new Error('terminal scroll removal failed after side effect');
    const resizeCause = new Error('terminal resize removal failed after side effect');
    lease.shared.registerController(id);
    const binding = {
      generation: 0,
      id,
      layoutDependencies: harness.oldDependencies,
      onError() {},
      read() {},
      record: harness.record,
      write() {},
    };
    lease.shared.observeLayout(binding);
    if (terminalMode !== 'resize') {
      harness.removeFailures.set(harness.oldScroll, scrollCause);
    }
    if (terminalMode !== 'scroll') {
      harness.unobserveFailures.set(harness.oldResize, resizeCause);
    }

    let delivered;
    assert.throws(
      () => lease.shared.releaseController(id),
      (error) => {
        delivered = error;
        return error === (terminalMode === 'resize' ? resizeCause : scrollCause);
      },
    );
    if (terminalMode === 'both') {
      assert.strictEqual(delivered.cleanupCause, resizeCause);
    }

    assert.throws(() => lease.shared.generationFor(id), /not registered/u);
    assert.equal(harness.oldScroll.listeners.size, 0);
    assert.equal(harness.oldScrollB.listeners.size, 0);
    assert.equal(
      harness.oldScroll.events.filter((event) => event === 'remove').length,
      1,
    );
    assert.equal(
      harness.oldScrollB.events.filter((event) => event === 'remove').length,
      1,
    );
    for (const candidate of [
      harness.record.element,
      harness.oldScroll,
      harness.oldScrollB,
      harness.oldResize,
      harness.oldResizeB,
    ]) {
      assert.equal(harness.resizeObserver().observed.has(candidate), false);
      assert.equal(
        harness.resizeEvents.filter((event) => event === `unobserve:${candidate.name}`).length,
        1,
      );
    }

    harness.removeFailures.clear();
    harness.unobserveFailures.clear();
    assert.equal(lease.shared.registerController(id), 0);
    lease.shared.observeLayout(binding);
    assert.equal(
      harness.oldScroll.events.filter((event) => event === 'add').length,
      2,
    );
    assert.equal(
      harness.resizeEvents.filter((event) => event === 'observe:old-resize').length,
      2,
    );
    lease.shared.releaseController(id);
    lease.release();
    assert.equal(
      harness.oldScroll.events.filter((event) => event === 'remove').length,
      2,
    );
    assert.equal(
      harness.resizeEvents.filter((event) => event === 'unobserve:old-resize').length,
      2,
    );
  });
}

for (const reentryPoint of ['first-scroll', 'middle-resize']) {
  test(`terminal cleanup stages every mixed dependency before ${reentryPoint} final-release reentry`, () => {
    const harness = createDependencyRegistrationHarness('none');
    const lease = acquireDocumentScheduler(harness.document);
    const shared = lease.shared;
    const id = `terminal-staged-${reentryPoint}`;
    const cause = new Error(`${reentryPoint} cleanup failed after final release`);
    const callbackTarget = reentryPoint === 'first-scroll'
      ? harness.oldScroll
      : harness.oldResize;
    const callbacks = reentryPoint === 'first-scroll'
      ? harness.scrollRemoveCallbacks
      : harness.unobserveCallbacks;
    const failures = reentryPoint === 'first-scroll'
      ? harness.removeFailures
      : harness.unobserveFailures;
    let releases = 0;

    shared.registerController(id);
    shared.observeLayout({
      generation: 0,
      id,
      layoutDependencies: harness.oldDependencies,
      onError() {},
      read() {},
      record: harness.record,
      write() {},
    });
    callbacks.set(callbackTarget, () => {
      releases += 1;
      lease.release();
      lease.release();
    });
    failures.set(callbackTarget, cause);

    assert.throws(
      () => shared.releaseController(id),
      (error) => error === cause,
    );
    assert.equal(releases, 1);
    assert.deepEqual(harness.terminalEvents, [
      'remove:old-scroll',
      'remove:old-scroll-b',
      'unobserve:target',
      'unobserve:old-scroll',
      'unobserve:old-scroll-b',
      'unobserve:old-resize',
      'unobserve:old-resize-b',
    ]);
    assert.equal(harness.oldScroll.listeners.size, 0);
    assert.equal(harness.oldScrollB.listeners.size, 0);
    assert.equal(harness.resizeObserver().observed.size, 0);
    assert.throws(() => shared.generationFor(id), /not registered|released/u);
  });
}

test('terminal cleanup preserves a same-ID replacement registered by its first native callback', () => {
  const harness = createDependencyRegistrationHarness('none');
  const lease = acquireDocumentScheduler(harness.document);
  const shared = lease.shared;
  const id = 'terminal-replacement';
  const binding = {
    generation: 0,
    id,
    layoutDependencies: harness.oldDependencies,
    onError() {},
    read() {},
    record: harness.record,
    write() {},
  };
  let replacements = 0;

  shared.registerController(id);
  const unsubscribe = shared.observeLayout(binding);
  harness.scrollRemoveCallbacks.set(harness.oldScroll, () => {
    harness.scrollRemoveCallbacks.delete(harness.oldScroll);
    replacements += 1;
    shared.observeLayout(binding);
  });

  unsubscribe();

  assert.equal(replacements, 1);
  assert.equal(harness.oldScroll.listeners.size, 1);
  assert.equal(harness.oldScrollB.listeners.size, 1);
  for (const candidate of [
    harness.record.element,
    harness.oldScroll,
    harness.oldScrollB,
    harness.oldResize,
    harness.oldResizeB,
  ]) {
    assert.equal(harness.resizeObserver().observed.has(candidate), true);
  }
  assert.deepEqual(harness.terminalEvents, [
    'remove:old-scroll',
    'remove:old-scroll-b',
  ]);

  shared.releaseController(id);
  lease.release();
  assert.equal(harness.oldScroll.listeners.size, 0);
  assert.equal(harness.oldScrollB.listeners.size, 0);
  assert.equal(harness.resizeObserver().observed.size, 0);
});

test('releaseController terminalizes its ID before a native callback registers its replacement', () => {
  const harness = createDependencyRegistrationHarness('none');
  const lease = acquireDocumentScheduler(harness.document);
  const shared = lease.shared;
  const id = 'terminal-controller-replacement';
  const binding = {
    generation: 0,
    id,
    layoutDependencies: harness.oldDependencies,
    onError() {},
    read() {},
    record: harness.record,
    write() {},
  };
  let replacements = 0;

  shared.registerController(id);
  shared.observeLayout(binding);
  harness.scrollRemoveCallbacks.set(harness.oldScroll, () => {
    harness.scrollRemoveCallbacks.delete(harness.oldScroll);
    replacements += 1;
    assert.equal(shared.registerController(id), 0);
    shared.observeLayout(binding);
  });

  shared.releaseController(id);

  assert.equal(replacements, 1);
  assert.equal(shared.generationFor(id), 0);
  assert.equal(harness.oldScroll.listeners.size, 1);
  assert.equal(harness.oldScrollB.listeners.size, 1);
  for (const candidate of [
    harness.record.element,
    harness.oldScroll,
    harness.oldScrollB,
    harness.oldResize,
    harness.oldResizeB,
  ]) {
    assert.equal(harness.resizeObserver().observed.has(candidate), true);
  }
  assert.deepEqual(harness.terminalEvents, [
    'remove:old-scroll',
    'remove:old-scroll-b',
  ]);

  shared.releaseController(id);
  lease.release();
  assert.equal(harness.oldScroll.listeners.size, 0);
  assert.equal(harness.oldScrollB.listeners.size, 0);
  assert.equal(harness.resizeObserver().observed.size, 0);
});

for (const registrationMode of ['scroll', 'resize']) {
  test(`reentrant ${registrationMode} registration cannot publish a destroyed layout`, () => {
    const harness = createDependencyRegistrationHarness('none');
    const lease = acquireDocumentScheduler(harness.document);
    const shared = lease.shared;
    const peerId = `reentrant-${registrationMode}-peer`;
    const victimId = `reentrant-${registrationMode}-victim`;
    const dependencies = registrationMode === 'scroll'
      ? {
        ancestors: [harness.nextScrollA],
        hosts: [],
        preceding: [],
        roots: [],
      }
      : {
        ancestors: [harness.oldScroll],
        hosts: [],
        preceding: [harness.nextResizeA],
        roots: [],
      };
    const binding = (id, layoutDependencies) => ({
      generation: 0,
      id,
      layoutDependencies,
      onError() {},
      read() {},
      record: harness.record,
      write() {},
    });

    shared.registerController(peerId);
    shared.observeLayout(binding(peerId, harness.oldDependencies));
    shared.registerController(victimId);
    const callbacks = registrationMode === 'scroll'
      ? harness.scrollAddCallbacks
      : harness.observeCallbacks;
    const reentrantTarget = registrationMode === 'scroll'
      ? harness.nextScrollA
      : harness.nextResizeA;
    let destroys = 0;
    callbacks.set(reentrantTarget, () => {
      destroys += 1;
      shared.releaseController(victimId);
      shared.releaseController(victimId);
    });

    assert.throws(
      () => shared.observeLayout(binding(victimId, dependencies)),
      /controller|layout|registration|changed|released|stale/i,
    );
    assert.equal(destroys, 1);
    assert.throws(() => shared.generationFor(victimId), /not registered/u);
    assert.equal(shared.generationFor(peerId), 0);
    if (registrationMode === 'scroll') {
      assert.equal(harness.nextScrollA.listeners.size, 0);
      assert.deepEqual(harness.nextScrollA.events, ['add', 'remove']);
    } else {
      assert.equal(harness.resizeObserver().observed.has(harness.nextResizeA), false);
      assert.equal(
        harness.resizeEvents.filter((event) => event === 'observe:next-resize-a').length,
        1,
      );
      assert.equal(
        harness.resizeEvents.filter((event) => event === 'unobserve:next-resize-a').length,
        1,
      );
    }
    assert.equal(harness.oldScroll.listeners.size, 1);

    callbacks.clear();
    assert.equal(shared.registerController(victimId), 0);
    shared.observeLayout(binding(victimId, dependencies));
    if (registrationMode === 'scroll') {
      assert.equal(harness.nextScrollA.events.filter((event) => event === 'add').length, 2);
      assert.equal(harness.nextScrollA.listeners.size, 1);
    } else {
      assert.equal(
        harness.resizeEvents.filter((event) => event === 'observe:next-resize-a').length,
        2,
      );
      assert.equal(harness.resizeObserver().observed.has(harness.nextResizeA), true);
    }
    shared.releaseController(victimId);
    shared.releaseController(peerId);
    lease.release();
  });
}

test('reentrant layout dependency provider cannot publish after releasing its controller', () => {
  const harness = createDependencyRegistrationHarness('none');
  const lease = acquireDocumentScheduler(harness.document);
  const id = 'reentrant-provider';
  let reads = 0;
  lease.shared.registerController(id);

  assert.throws(
    () => lease.shared.observeLayout({
      generation: 0,
      id,
      layoutDependencies() {
        reads += 1;
        lease.shared.releaseController(id);
        return harness.oldDependencies;
      },
      onError() {},
      read() {},
      record: harness.record,
      write() {},
    }),
    /controller|layout|registration|changed|released|stale/i,
  );
  assert.equal(reads, 1);
  assert.throws(() => lease.shared.generationFor(id), /not registered/u);
  assert.equal(harness.oldScroll.listeners.size, 0);
  assert.equal(harness.resizeObserver().observed.size, 0);

  assert.equal(lease.shared.registerController(id), 0);
  lease.shared.observeLayout({
    generation: 0,
    id,
    layoutDependencies: harness.oldDependencies,
    onError() {},
    read() {},
    record: harness.record,
    write() {},
  });
  assert.equal(harness.oldScroll.listeners.size, 1);
  lease.shared.releaseController(id);
  lease.release();
});
