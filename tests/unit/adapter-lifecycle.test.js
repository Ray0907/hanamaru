import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnnotation } from '../../src/annotation.js';
import { readControllerMetadata } from '../../src/controller-metadata.js';
import { HanamaruConfigError } from '../../src/errors.js';
import { createAdapterOwner } from '../../src/adapters/lifecycle.js';

class FakeTarget extends EventTarget {
  constructor(name, calls) {
    super();
    this.name = name;
    this.calls = calls;
    this.listenerCount = 0;
  }

  addEventListener(type, listener, options) {
    if (type === 'hana:error') {
      this.listenerCount += 1;
      this.calls.push(`listen:${this.name}`);
    }
    super.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    if (type === 'hana:error') {
      this.listenerCount -= 1;
      this.calls.push(`unlisten:${this.name}`);
    }
    super.removeEventListener(type, listener, options);
  }

  fail(controller, error, generation = undefined) {
    const event = new Event('hana:error');
    Object.defineProperty(event, 'detail', {
      value: {
        controller,
        error,
        ...(generation === undefined ? {} : { generation }),
      },
    });
    this.dispatchEvent(event);
  }
}

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  promise.catch(() => {});
  return { promise, reject, resolve };
}

function createHarness() {
  const calls = [];
  const exposed = [];
  const queued = [];
  const controllers = [];
  let createFailure = null;
  let showFailure = null;
  let updateFailure = null;
  let destroyFailure = null;
  let exposeFailure = null;
  let onDestroy = null;
  let onShow = null;
  let showEvent = null;
  let showFinishedFailure = null;

  const owner = createAdapterOwner({
    create(target, options) {
      calls.push(['create', target.name, options]);
      if (createFailure !== null) throw createFailure;
      const run = deferred();
      const controller = {
        target,
        run,
        update(optionsPatch) {
          calls.push(['update', target.name, optionsPatch]);
          if (updateFailure !== null) throw updateFailure;
          return controller;
        },
        show() {
          calls.push(`show:${target.name}`);
          onShow?.(controller);
          if (showEvent !== null) {
            target.fail(controller, showEvent.error, showEvent.generation);
          }
          if (showFailure !== null) throw showFailure;
          controller.finished = showFinishedFailure === null
            ? run.promise
            : Promise.reject(showFinishedFailure);
          controller.finished.catch(() => {});
          return controller;
        },
        finished: null,
        destroy() {
          calls.push(`destroy:${target.name}`);
          onDestroy?.(controller);
          if (destroyFailure !== null) throw destroyFailure;
          return controller;
        },
      };
      controllers.push(controller);
      return controller;
    },
    expose(controller) {
      calls.push(`expose:${controller?.target?.name ?? 'null'}`);
      exposed.push(controller);
      if (exposeFailure !== null) throw exposeFailure;
    },
    queueThrow(error) {
      queued.push(error);
    },
  });

  return {
    calls,
    controllers,
    exposed,
    owner,
    queued,
    setCreateFailure(error) { createFailure = error; },
    setDestroyFailure(error) { destroyFailure = error; },
    setExposeFailure(error) { exposeFailure = error; },
    setOnDestroy(callback) { onDestroy = callback; },
    setOnShow(callback) { onShow = callback; },
    setShowEvent(error, generation = undefined) {
      showEvent = error === null ? null : { error, generation };
    },
    setShowFinishedFailure(error) { showFinishedFailure = error; },
    setShowFailure(error) { showFailure = error; },
    setUpdateFailure(error) { updateFailure = error; },
  };
}

const box = Object.freeze({ mark: 'box' });
const circle = Object.freeze({ mark: 'circle' });

function manualOptions(mark, seed, overrides = {}) {
  return {
    mark,
    note: null,
    placement: 'auto',
    trigger: 'manual',
    accessible: false,
    seed,
    duration: 650,
    motion: 'system',
    ...overrides,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test('mount defaults enabled, forces manual trigger, listens before show, and exposes accepted show', () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);

  assert.deepEqual(Object.keys(harness.owner), ['mount', 'update', 'destroy']);
  assert.equal(harness.owner.mount(target, box), harness.owner);
  const seed = harness.calls[0][2].seed;

  assert.deepEqual(harness.calls, [
    ['create', 'first', manualOptions('box', seed)],
    'listen:first',
    'show:first',
    'expose:first',
  ]);
  assert.equal(target.listenerCount, 1);
  assert.equal(harness.exposed.at(-1), harness.controllers[0]);
});

test('mount rejects adapter trigger synchronously with a typed config error', () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);

  assert.throws(
    () => harness.owner.mount(target, { mark: 'box', trigger: undefined }),
    (error) => error instanceof HanamaruConfigError
      && error.code === 'HANA_CONFIG_INVALID'
      && error.details.field === 'trigger',
  );
  assert.deepEqual(harness.calls, []);
});

test('update compares canonical values and retains the same controller', () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);
  harness.owner.mount(target, {
    mark: 'box',
    note: '',
    placement: 'auto',
    accessible: false,
    duration: 650,
    motion: 'system',
  });
  const seed = harness.calls[0][2].seed;
  harness.calls.length = 0;

  harness.owner.update(target, { mark: 'box' });
  assert.deepEqual(harness.calls, []);

  harness.owner.update(target, circle);
  assert.deepEqual(harness.calls, [
    ['update', 'first', manualOptions('circle', seed)],
  ]);
  assert.equal(harness.controllers.length, 1);
  assert.equal(target.listenerCount, 1);
});

test('replacement accepts and shows new ownership before old teardown', () => {
  const harness = createHarness();
  const first = new FakeTarget('first', harness.calls);
  const second = new FakeTarget('second', harness.calls);
  harness.owner.mount(first, box);
  harness.calls.length = 0;

  harness.owner.update(second, circle);
  const seed = harness.calls[0][2].seed;

  assert.deepEqual(harness.calls, [
    ['create', 'second', manualOptions('circle', seed)],
    'listen:second',
    'show:second',
    'unlisten:first',
    'destroy:first',
    'expose:null',
    'expose:second',
  ]);
  assert.equal(first.listenerCount, 0);
  assert.equal(second.listenerCount, 1);
});

test('disable, repeated disable, and re-enable own cleanup exactly once', () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);
  harness.owner.mount(target, box);
  harness.calls.length = 0;

  harness.owner.update(target, box, { enabled: false });
  harness.owner.update(target, box, { enabled: false });
  harness.owner.update(target, box, { enabled: true });
  const seed = harness.calls[3][2].seed;

  assert.deepEqual(harness.calls, [
    'unlisten:first',
    'destroy:first',
    'expose:null',
    ['create', 'first', manualOptions('box', seed)],
    'listen:first',
    'show:first',
    'expose:first',
  ]);
});

test('destroy is terminal and destroys the current controller exactly once', () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);
  harness.owner.mount(target, box);
  harness.calls.length = 0;

  assert.equal(harness.owner.destroy(), harness.owner);
  assert.equal(harness.owner.destroy(), harness.owner);
  assert.equal(harness.owner.mount(target, box), harness.owner);

  assert.deepEqual(harness.calls, [
    'unlisten:first',
    'destroy:first',
    'expose:null',
  ]);
});

test('mount construction failure leaves no ownership and rethrows directly', () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);
  const failure = new Error('create failed');
  harness.setCreateFailure(failure);

  assert.throws(() => harness.owner.mount(target, box), (error) => error === failure);
  assert.equal(target.listenerCount, 0);
  assert.deepEqual(harness.exposed, []);
});

test('mount show failure removes its listener, destroys the candidate, and rethrows directly', () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);
  const failure = new Error('show failed');
  harness.setShowFailure(failure);

  assert.throws(() => harness.owner.mount(target, box), (error) => error === failure);
  const seed = harness.calls[0][2].seed;
  assert.deepEqual(harness.calls, [
    ['create', 'first', manualOptions('box', seed)],
    'listen:first',
    'show:first',
    'unlisten:first',
    'destroy:first',
  ]);
  assert.equal(target.listenerCount, 0);
  assert.deepEqual(harness.exposed, []);
});

test('same-target update failure cleans exposed ownership and rethrows directly', () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);
  harness.owner.mount(target, box);
  const seed = harness.calls[0][2].seed;
  harness.calls.length = 0;
  const failure = new Error('update failed');
  harness.setUpdateFailure(failure);

  assert.throws(() => harness.owner.update(target, circle), (error) => error === failure);
  assert.deepEqual(harness.calls, [
    ['update', 'first', manualOptions('circle', seed)],
    'unlisten:first',
    'destroy:first',
    'expose:null',
  ]);
  assert.equal(target.listenerCount, 0);
});

test('replacement rollback preserves prior ownership when candidate creation or show fails', () => {
  for (const phase of ['create', 'show']) {
    const harness = createHarness();
    const first = new FakeTarget('first', harness.calls);
    const second = new FakeTarget('second', harness.calls);
    harness.owner.mount(first, box);
    harness.calls.length = 0;
    const failure = new Error(`${phase} failed`);
    if (phase === 'create') harness.setCreateFailure(failure);
    else harness.setShowFailure(failure);

    assert.throws(() => harness.owner.update(second, circle), (error) => error === failure);
    assert.equal(first.listenerCount, 1);
    assert.equal(second.listenerCount, 0);
    assert.equal(harness.exposed.at(-1), harness.controllers[0]);
    assert.ok(!harness.calls.includes('destroy:first'));
    assert.ok(!harness.calls.includes('expose:null'));
  }
});

test('a synchronous exposure callback failure contains the candidate and rethrows directly', () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);
  const failure = new Error('expose failed');
  harness.setExposeFailure(failure);

  assert.throws(() => harness.owner.mount(target, box), (error) => error === failure);
  assert.equal(target.listenerCount, 0);
  assert.equal(harness.calls.filter((call) => call === 'destroy:first').length, 1);
});

test('accepted finished rejection cleans ownership before onError and exposes null once', async () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);
  const observed = [];
  harness.owner.mount(target, box, {
    onError(error, controller) {
      observed.push({
        controller,
        error,
        exposed: harness.exposed.at(-1),
        listeners: target.listenerCount,
      });
    },
  });
  harness.calls.length = 0;
  const controller = harness.controllers[0];
  const failure = new Error('finished failed');

  controller.run.reject(failure);
  await flushMicrotasks();

  assert.deepEqual(harness.calls, [
    'unlisten:first',
    'destroy:first',
    'expose:null',
  ]);
  assert.deepEqual(observed, [{
    controller,
    error: failure,
    exposed: null,
    listeners: 0,
  }]);
  assert.equal(harness.exposed.filter((value) => value === null).length, 1);
});

test('hana:error remains observed after finished resolves and filters the exact controller', async () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);
  const observed = [];
  harness.owner.mount(target, box, {
    onError(error, controller) {
      observed.push([error, controller]);
    },
  });
  const controller = harness.controllers[0];
  controller.run.resolve();
  await flushMicrotasks();
  harness.calls.length = 0;

  target.fail({}, new Error('foreign controller'));
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(observed, []);
  assert.equal(target.listenerCount, 1);

  const failure = new Error('refresh failed');
  target.fail(controller, failure);
  assert.deepEqual(harness.calls, [
    'unlisten:first',
    'destroy:first',
    'expose:null',
  ]);
  assert.deepEqual(observed, [[failure, controller]]);
});

test('failure channels observe only the exact finished promise accepted by show', async () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);
  const observed = [];
  harness.owner.mount(target, box, {
    onError(error) { observed.push(error); },
  });
  const controller = harness.controllers[0];
  const later = deferred();
  controller.finished = later.promise;

  later.reject(new Error('not accepted'));
  await flushMicrotasks();
  assert.deepEqual(observed, []);
  assert.equal(target.listenerCount, 1);

  const acceptedFailure = new Error('accepted');
  controller.run.reject(acceptedFailure);
  await flushMicrotasks();
  assert.deepEqual(observed, [acceptedFailure]);
});

test('Promise and hana:error reports deduplicate the same error or failure generation', async () => {
  for (const report of ['same-error', 'same-generation']) {
    const harness = createHarness();
    const target = new FakeTarget('first', harness.calls);
    const observed = [];
    harness.owner.mount(target, box, {
      onError(error) { observed.push(error); },
    });
    const controller = harness.controllers[0];
    const promised = new Error(`${report}:promise`);
    const eventError = report === 'same-error'
      ? promised
      : new Error(`${report}:event`);

    controller.run.reject(promised);
    target.fail(controller, eventError, report === 'same-generation' ? 17 : undefined);
    await flushMicrotasks();

    assert.equal(observed.length, 1, report);
    assert.equal(harness.exposed.filter((value) => value === null).length, 1, report);
    assert.equal(target.listenerCount, 0, report);
  }
});

test('stale finished rejection and stale events are suppressed after replacement', async () => {
  const harness = createHarness();
  const first = new FakeTarget('first', harness.calls);
  const second = new FakeTarget('second', harness.calls);
  const observed = [];
  harness.owner.mount(first, box, {
    onError(error) { observed.push(error); },
  });
  const stale = harness.controllers[0];
  harness.owner.update(second, circle, {
    onError(error) { observed.push(error); },
  });
  harness.calls.length = 0;

  stale.run.reject(new Error('stale promise'));
  first.fail(stale, new Error('stale event'));
  await flushMicrotasks();

  assert.deepEqual(observed, []);
  assert.deepEqual(harness.calls, []);
  assert.equal(second.listenerCount, 1);
  assert.equal(harness.exposed.at(-1), harness.controllers[1]);
});

test('current AbortError is expected cleanup and is not delivered to onError', async () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);
  const observed = [];
  harness.owner.mount(target, box, {
    onError(error) { observed.push(error); },
  });
  harness.calls.length = 0;

  harness.controllers[0].run.reject(new DOMException('cancelled', 'AbortError'));
  await flushMicrotasks();

  assert.deepEqual(observed, []);
  assert.deepEqual(harness.calls, [
    'unlisten:first',
    'destroy:first',
    'expose:null',
  ]);
});

test('asynchronous failure without onError still cleans ownership', async () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);
  harness.owner.mount(target, box);
  harness.calls.length = 0;

  harness.controllers[0].run.reject(new Error('unhandled by consumer'));
  await flushMicrotasks();

  assert.deepEqual(harness.calls, [
    'unlisten:first',
    'destroy:first',
    'expose:null',
  ]);
  assert.deepEqual(harness.queued, []);
});

test('throwing onError is queued only after failed ownership is cleaned', async () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);
  const callbackFailure = new Error('onError failed');
  const cleanupSnapshots = [];
  harness.owner.mount(target, box, {
    onError() {
      cleanupSnapshots.push({
        exposed: harness.exposed.at(-1),
        listeners: target.listenerCount,
      });
      throw callbackFailure;
    },
  });
  harness.calls.length = 0;

  harness.controllers[0].run.reject(new Error('controller failed'));
  await flushMicrotasks();

  assert.deepEqual(cleanupSnapshots, [{ exposed: null, listeners: 0 }]);
  assert.deepEqual(harness.queued, [callbackFailure]);
  assert.equal(harness.calls.filter((call) => call === 'destroy:first').length, 1);
});

test('listener removal suppresses failures during disable and destroy cleanup', async () => {
  for (const operation of ['disable', 'destroy']) {
    const harness = createHarness();
    const target = new FakeTarget('first', harness.calls);
    const observed = [];
    harness.owner.mount(target, box, {
      onError(error) { observed.push(error); },
    });
    const controller = harness.controllers[0];

    if (operation === 'disable') {
      harness.owner.update(target, box, { enabled: false });
    } else {
      harness.owner.destroy();
    }
    controller.run.reject(new Error(`late after ${operation}`));
    target.fail(controller, new Error(`event after ${operation}`));
    await flushMicrotasks();

    assert.deepEqual(observed, [], operation);
    assert.equal(target.listenerCount, 0, operation);
    assert.equal(harness.exposed.filter((value) => value === null).length, 1, operation);
  }
});

test('a replacement superseded during old cleanup cannot overwrite or leak the reentrant winner', () => {
  const harness = createHarness();
  const first = new FakeTarget('first', harness.calls);
  const second = new FakeTarget('second', harness.calls);
  const third = new FakeTarget('third', harness.calls);
  harness.owner.mount(first, box);
  let reentered = false;
  harness.setOnDestroy((controller) => {
    if (controller.target !== first || reentered) return;
    reentered = true;
    harness.owner.update(third, { mark: 'underline' });
  });
  harness.calls.length = 0;

  harness.owner.update(second, circle);

  assert.equal(harness.exposed.at(-1).target, third);
  assert.equal(first.listenerCount, 0);
  assert.equal(second.listenerCount, 0);
  assert.equal(third.listenerCount, 1);
  assert.equal(harness.calls.filter((call) => call === 'destroy:second').length, 1);
  assert.ok(!harness.calls.includes('expose:second'));
});

test('show must publish one observable finished Promise before exposure', () => {
  const calls = [];
  const target = new FakeTarget('first', calls);
  const controller = {
    show() { calls.push('show:first'); },
    finished: null,
    update() {},
    destroy() { calls.push('destroy:first'); },
  };
  const owner = createAdapterOwner({
    create() { return controller; },
    expose(value) { calls.push(`expose:${value === null ? 'null' : 'first'}`); },
  });

  assert.throws(
    () => owner.mount(target, box),
    (error) => error instanceof TypeError
      && error.message === 'controller.finished must be a Promise',
  );
  assert.deepEqual(calls, [
    'listen:first',
    'show:first',
    'unlisten:first',
    'destroy:first',
  ]);
});

function realCoreEnvironment() {
  let generation = 0;
  const shared = {
    registerController() { generation += 1; return generation; },
    releaseController() {},
    bumpGeneration() { generation += 1; return generation; },
    observeLayout() { return () => {}; },
    rebindLayout() { return () => {}; },
    enqueue({ read, write, onError }) {
      try { write(read()); } catch (error) { onError(error); }
    },
  };
  const lease = { shared, release() {} };
  return {
    id: 'adapter-real-core',
    lease,
    resolveTarget(target) {
      return {
        kind: 'element',
        element: target,
        ownerElement: target,
        refresh() { return this; },
      };
    },
    targetRects() {
      return [{
        x: 0,
        y: 0,
        width: 80,
        height: 20,
        top: 0,
        right: 80,
        bottom: 20,
        left: 0,
      }];
    },
    createRenderer() {
      return {
        group: {},
        noteElement: null,
        measure() {
          return {
            noteRect: null,
            peerNoteRects: [],
            viewport: { width: 800, height: 600 },
          };
        },
        draw() {},
        animate() { return { finished: Promise.resolve() }; },
        finish() {},
        hide() {},
        destroy() {},
        updateOwner() {},
      };
    },
    readThemeMetrics() { return { duration: 650, noteGap: 16 }; },
    reducedMotion() { return true; },
    createEvent(type, detail, target) {
      const event = new Event(type);
      Object.defineProperty(event, 'detail', { value: detail });
      target.dispatchEvent(event);
    },
    microtask(callback) { queueMicrotask(callback); },
  };
}

test('same-target sparse update restores canonical defaults on the real core controller', () => {
  const calls = [];
  const target = new FakeTarget('real', calls);
  const environment = realCoreEnvironment();
  const exposed = [];
  const owner = createAdapterOwner({
    create(nextTarget, options) {
      return createAnnotation(nextTarget, options, environment);
    },
    expose(controller) { exposed.push(controller); },
  });

  owner.mount(target, {
    mark: 'box',
    note: 'explicit',
    placement: 'left',
    accessible: true,
    seed: 'explicit-seed',
    duration: 42,
    motion: 'never',
  });
  const controller = exposed[0];
  assert.equal(readControllerMetadata(controller).options.note, 'explicit');

  owner.update(target, { mark: 'box' });

  assert.equal(exposed.at(-1), controller);
  assert.deepEqual(readControllerMetadata(controller).options, {
    mark: 'box',
    note: null,
    placement: 'auto',
    trigger: 'manual',
    accessible: false,
    seed: readControllerMetadata(controller).options.seed,
    duration: 650,
    motion: 'system',
  });
  assert.notEqual(readControllerMetadata(controller).options.seed, 'explicit-seed');
  owner.destroy();
});

test('hana:error emitted synchronously by candidate show is cleaned before initial null exposure and onError', () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);
  const failure = new Error('show event failed');
  const observed = [];
  harness.setShowEvent(failure, 11);

  harness.owner.mount(target, box, {
    onError(error, controller) {
      observed.push({
        controller,
        error,
        exposed: harness.exposed.at(-1),
        listenerCount: target.listenerCount,
      });
    },
  });

  assert.equal(harness.exposed.at(-1), null);
  assert.deepEqual(observed, [{
    controller: harness.controllers[0],
    error: failure,
    exposed: null,
    listenerCount: 0,
  }]);
  assert.equal(harness.calls.filter((call) => call === 'destroy:first').length, 1);
  assert.ok(!harness.calls.includes('expose:first'));
});

test('candidate show hana:error retains prior replacement ownership', () => {
  const harness = createHarness();
  const first = new FakeTarget('first', harness.calls);
  const second = new FakeTarget('second', harness.calls);
  const observed = [];
  harness.owner.mount(first, box);
  const previous = harness.controllers[0];
  const failure = new Error('replacement show event failed');
  harness.setShowEvent(failure, 12);
  harness.calls.length = 0;

  harness.owner.update(second, circle, {
    onError(error, controller) { observed.push([error, controller]); },
  });

  assert.equal(harness.exposed.at(-1), previous);
  assert.equal(first.listenerCount, 1);
  assert.equal(second.listenerCount, 0);
  assert.deepEqual(observed, [[failure, harness.controllers[1]]]);
  assert.ok(!harness.calls.includes('destroy:first'));
  assert.ok(!harness.calls.includes('expose:null'));
  assert.ok(!harness.calls.includes('expose:second'));
});

test('show event followed by synchronous throw preserves direct throw without onError delivery', () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);
  const eventFailure = new Error('event first');
  const showFailure = new Error('show threw');
  const observed = [];
  harness.setShowEvent(eventFailure, 13);
  harness.setShowFailure(showFailure);

  assert.throws(
    () => harness.owner.mount(target, box, {
      onError(error) { observed.push(error); },
    }),
    (error) => error === showFailure,
  );
  assert.deepEqual(observed, []);
  assert.deepEqual(harness.exposed, []);
  assert.equal(target.listenerCount, 0);
  assert.equal(harness.calls.filter((call) => call === 'destroy:first').length, 1);
});

test('candidate event and exact finished rejection deduplicate before exposure', async () => {
  const harness = createHarness();
  const target = new FakeTarget('first', harness.calls);
  const failure = new Error('dual candidate failure');
  const observed = [];
  harness.setShowEvent(failure, 14);
  harness.setShowFinishedFailure(failure);

  harness.owner.mount(target, box, {
    onError(error) { observed.push(error); },
  });
  await flushMicrotasks();

  assert.deepEqual(observed, [failure]);
  assert.equal(harness.exposed.filter((value) => value === null).length, 1);
  assert.equal(harness.calls.filter((call) => call === 'destroy:first').length, 1);
  assert.ok(!harness.calls.includes('expose:first'));
});

test('candidate onError reentrancy wins over the stale outer mount', () => {
  const harness = createHarness();
  const failed = new FakeTarget('failed', harness.calls);
  const winner = new FakeTarget('winner', harness.calls);
  const failure = new Error('candidate failed');
  harness.setShowEvent(failure);

  harness.owner.mount(failed, box, {
    onError() {
      harness.setShowEvent(null);
      harness.owner.mount(winner, circle);
    },
  });

  assert.equal(harness.exposed.at(-1).target, winner);
  assert.equal(failed.listenerCount, 0);
  assert.equal(winner.listenerCount, 1);
  assert.ok(!harness.calls.includes('expose:failed'));
});

test('pre-existing target listener reentrant destroy or disable makes candidate failure stale', () => {
  for (const action of ['destroy', 'disable']) {
    const harness = createHarness();
    const target = new FakeTarget(action, harness.calls);
    const failure = new Error(`${action} event`);
    const observed = [];
    const listener = () => {
      target.removeEventListener('hana:error', listener);
      if (action === 'destroy') harness.owner.destroy();
      else harness.owner.update(target, box, { enabled: false });
    };
    target.addEventListener('hana:error', listener);
    harness.calls.length = 0;
    harness.setShowEvent(failure, 21);

    harness.owner.mount(target, box, {
      onError(error) { observed.push(error); },
    });

    assert.deepEqual(observed, [], action);
    assert.deepEqual(harness.exposed, [], action);
    assert.deepEqual(harness.queued, [], action);
    assert.equal(target.listenerCount, 0, action);
    assert.equal(
      harness.calls.filter((call) => call === `destroy:${action}`).length,
      1,
      action,
    );
  }
});

test('pre-existing target listener winner remains authoritative over stale candidate failure', () => {
  const harness = createHarness();
  const failed = new FakeTarget('failed', harness.calls);
  const winner = new FakeTarget('winner', harness.calls);
  const staleFailure = new Error('stale candidate');
  const listener = () => {
    failed.removeEventListener('hana:error', listener);
    harness.setShowEvent(null);
    harness.owner.mount(winner, circle);
  };
  failed.addEventListener('hana:error', listener);
  harness.calls.length = 0;
  harness.setShowEvent(staleFailure, 22);

  harness.owner.mount(failed, box, {
    onError() { throw new Error('stale onError must not run'); },
  });

  assert.equal(harness.exposed.at(-1).target, winner);
  assert.equal(harness.exposed.filter((value) => value === null).length, 0);
  assert.deepEqual(harness.queued, []);
  assert.equal(failed.listenerCount, 0);
  assert.equal(winner.listenerCount, 1);
  assert.equal(harness.calls.filter((call) => call === 'destroy:failed').length, 1);
});

test('listener added during show can install winner after adapter buffers the event', () => {
  const harness = createHarness();
  const failed = new FakeTarget('failed', harness.calls);
  const winner = new FakeTarget('winner', harness.calls);
  const staleFailure = new Error('adapter heard first');
  harness.setShowEvent(staleFailure, 23);
  harness.setOnShow(() => {
    harness.setOnShow(null);
    const listener = () => {
      failed.removeEventListener('hana:error', listener);
      harness.setShowEvent(null);
      harness.owner.mount(winner, circle);
    };
    failed.addEventListener('hana:error', listener);
  });

  harness.owner.mount(failed, box, {
    onError() { throw new Error('stale onError must not run'); },
  });

  assert.equal(harness.exposed.at(-1).target, winner);
  assert.equal(harness.exposed.filter((value) => value === null).length, 0);
  assert.deepEqual(harness.queued, []);
  assert.equal(failed.listenerCount, 0);
  assert.equal(winner.listenerCount, 1);
  assert.equal(harness.calls.filter((call) => call === 'destroy:failed').length, 1);
});

test('reentrant replacement winner is not cleared by stale candidate failure', () => {
  const harness = createHarness();
  const current = new FakeTarget('current', harness.calls);
  const failed = new FakeTarget('failed', harness.calls);
  const winner = new FakeTarget('winner', harness.calls);
  harness.owner.mount(current, box);
  const listener = () => {
    failed.removeEventListener('hana:error', listener);
    harness.setShowEvent(null);
    harness.owner.update(winner, { mark: 'underline' });
  };
  failed.addEventListener('hana:error', listener);
  harness.setShowEvent(new Error('stale replacement'), 24);
  harness.calls.length = 0;

  harness.owner.update(failed, circle, {
    onError() { throw new Error('stale replacement onError must not run'); },
  });

  assert.equal(harness.exposed.at(-1).target, winner);
  assert.equal(harness.exposed.filter((value) => value === null).length, 1);
  assert.deepEqual(harness.queued, []);
  assert.equal(current.listenerCount, 0);
  assert.equal(failed.listenerCount, 0);
  assert.equal(winner.listenerCount, 1);
  assert.equal(harness.calls.filter((call) => call === 'destroy:current').length, 1);
  assert.equal(harness.calls.filter((call) => call === 'destroy:failed').length, 1);
});

test('throwing reentrant winner callback does not revive stale candidate reporting', () => {
  const harness = createHarness();
  const failed = new FakeTarget('failed', harness.calls);
  const winner = new FakeTarget('winner', harness.calls);
  const winnerFailure = new Error('winner expose failed');
  let caught = null;
  const listener = () => {
    failed.removeEventListener('hana:error', listener);
    harness.setShowEvent(null);
    harness.setExposeFailure(winnerFailure);
    try {
      harness.owner.mount(winner, circle);
    } catch (error) {
      caught = error;
    }
    harness.setExposeFailure(null);
  };
  failed.addEventListener('hana:error', listener);
  harness.calls.length = 0;
  harness.setShowEvent(new Error('stale failed'), 25);

  harness.owner.mount(failed, box, {
    onError() { throw new Error('stale onError must not queue'); },
  });

  assert.equal(caught, winnerFailure);
  assert.equal(harness.exposed.filter((value) => value === null).length, 1);
  assert.deepEqual(harness.queued, []);
  assert.equal(failed.listenerCount, 0);
  assert.equal(winner.listenerCount, 0);
  assert.equal(harness.calls.filter((call) => call === 'destroy:failed').length, 1);
  assert.equal(harness.calls.filter((call) => call === 'destroy:winner').length, 1);
});

test('stale candidate event and finished rejection never report after reentrant destroy', async () => {
  const harness = createHarness();
  const target = new FakeTarget('failed', harness.calls);
  const failure = new Error('event and promise');
  const observed = [];
  const listener = () => {
    target.removeEventListener('hana:error', listener);
    harness.owner.destroy();
  };
  target.addEventListener('hana:error', listener);
  harness.calls.length = 0;
  harness.setShowEvent(failure, 26);
  harness.setShowFinishedFailure(failure);

  harness.owner.mount(target, box, {
    onError(error) { observed.push(error); },
  });
  await flushMicrotasks();

  assert.deepEqual(observed, []);
  assert.deepEqual(harness.exposed, []);
  assert.deepEqual(harness.queued, []);
  assert.equal(target.listenerCount, 0);
  assert.equal(harness.calls.filter((call) => call === 'destroy:failed').length, 1);
});
