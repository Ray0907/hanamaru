import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnnotation } from '../../src/annotation.js';
import { readControllerMetadata } from '../../src/controller-metadata.js';
import { HanamaruConfigError } from '../../src/errors.js';
import {
  createAdapterOwner,
  prepareAdapterRequest,
} from '../../src/adapters/lifecycle.js';

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
  let updateEvent = null;
  let destroyFailure = null;
  let exposeFailure = null;
  let onDestroy = null;
  let onShow = null;
  let onUpdate = null;
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
        updateDepth: 0,
        updateReturned: false,
        update(optionsPatch) {
          controller.updateReturned = false;
          controller.updateDepth += 1;
          try {
            calls.push(['update', target.name, optionsPatch]);
            onUpdate?.(controller, optionsPatch);
            if (updateEvent !== null) {
              target.fail(controller, updateEvent.error, updateEvent.generation);
            }
            if (updateFailure !== null) throw updateFailure;
            controller.updateReturned = true;
            return controller;
          } finally {
            controller.updateDepth -= 1;
          }
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
    setOnUpdate(callback) { onUpdate = callback; },
    setShowEvent(error, generation = undefined) {
      showEvent = error === null ? null : { error, generation };
    },
    setShowFinishedFailure(error) { showFinishedFailure = error; },
    setShowFailure(error) { showFailure = error; },
    setUpdateEvent(error, generation = undefined) {
      updateEvent = error === null ? null : { error, generation };
    },
    setUpdateFailure(error) { updateFailure = error; },
  };
}

const box = Object.freeze({ mark: 'box' });
const circle = Object.freeze({ mark: 'circle' });

test('prepared requests preserve non-enumerable seed semantics from one frozen snapshot', () => {
  const options = { mark: 'box' };
  Object.defineProperty(options, 'seed', {
    configurable: true,
    value: 'quiet-seed',
  });

  const prepared = prepareAdapterRequest(options);
  const replayed = prepareAdapterRequest(prepared.options, prepared.config);

  assert.equal(prepared.options.seed, 'quiet-seed');
  assert.equal(Object.hasOwn(prepared.options, 'seed'), true);
  assert.equal(prepared.canonical[4], true);
  assert.equal(prepared.canonical[5], 'quiet-seed');
  assert.deepEqual(replayed.canonical, prepared.canonical);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.options), true);
  assert.equal(Object.isFrozen(prepared.config), true);
  assert.equal(Object.isFrozen(prepared.canonical), true);

  const harness = createHarness();
  const target = new FakeTarget('prepared', harness.calls);
  harness.owner.mount(target, prepared.options, prepared.config);
  assert.equal(harness.calls[0][2].seed, 'quiet-seed');
});

test('prepared requests cannot diverge through changing proxy descriptors', () => {
  const descriptorReads = new Map();
  const options = new Proxy({}, {
    ownKeys() {
      return ['mark', 'seed'];
    },
    getOwnPropertyDescriptor(_target, field) {
      if (field !== 'mark' && field !== 'seed') return undefined;
      const count = (descriptorReads.get(field) ?? 0) + 1;
      descriptorReads.set(field, count);
      return {
        configurable: true,
        enumerable: field === 'mark',
        value: field === 'mark' ? 'box' : `seed-${count}`,
        writable: true,
      };
    },
  });

  const prepared = prepareAdapterRequest(options);
  const replayed = prepareAdapterRequest(prepared.options, prepared.config);

  assert.deepEqual([...descriptorReads], [['mark', 1], ['seed', 1]]);
  assert.equal(prepared.options.seed, 'seed-1');
  assert.equal(prepared.canonical[5], 'seed-1');
  assert.deepEqual(replayed.canonical, prepared.canonical);
});

test('prepared requests read each option and config accessor exactly once', () => {
  const reads = new Map();
  const accessor = (target, field, value, prefix) => {
    Object.defineProperty(target, field, {
      configurable: true,
      get() {
        const key = `${prefix}.${field}`;
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return value;
      },
    });
  };
  const options = {};
  accessor(options, 'mark', 'box', 'options');
  accessor(options, 'note', 'Counted', 'options');
  accessor(options, 'placement', 'left', 'options');
  accessor(options, 'accessible', true, 'options');
  accessor(options, 'seed', 'once', 'options');
  accessor(options, 'duration', 10, 'options');
  accessor(options, 'motion', 'never', 'options');
  const onError = () => {};
  const config = {};
  accessor(config, 'enabled', true, 'config');
  accessor(config, 'onError', onError, 'config');

  const prepared = prepareAdapterRequest(options, config);
  const replayed = prepareAdapterRequest(prepared.options, prepared.config);

  assert.deepEqual([...reads], [
    ['options.mark', 1],
    ['options.note', 1],
    ['options.placement', 1],
    ['options.accessible', 1],
    ['options.seed', 1],
    ['options.duration', 1],
    ['options.motion', 1],
    ['config.enabled', 1],
    ['config.onError', 1],
  ]);
  assert.deepEqual(replayed.canonical, prepared.canonical);
  assert.deepEqual(prepared.config, { enabled: true, onError });
});

test('prepared request validation rejects unknown, symbol, and trigger fields once', () => {
  const invalidInputs = [
    { input: { mark: 'box', unknown: 1 }, field: 'unknown' },
    { input: { mark: 'box', trigger: 'manual' }, field: 'trigger' },
  ];
  const hiddenUnknown = { mark: 'box' };
  Object.defineProperty(hiddenUnknown, 'unknown', { value: 1 });
  invalidInputs.push({ input: hiddenUnknown, field: 'unknown' });
  const hiddenTrigger = { mark: 'box' };
  Object.defineProperty(hiddenTrigger, 'trigger', { value: 'manual' });
  invalidInputs.push({ input: hiddenTrigger, field: 'trigger' });
  const symbol = Symbol('unknown');
  invalidInputs.push({ input: { mark: 'box', [symbol]: 1 }, field: symbol });

  for (const { input, field } of invalidInputs) {
    assert.throws(
      () => prepareAdapterRequest(input),
      (error) => error instanceof HanamaruConfigError
        && error.code === 'HANA_CONFIG_INVALID'
        && error.details.field === field,
    );
  }

  assert.throws(
    () => prepareAdapterRequest({ mark: 'box' }, { unknown: true }),
    (error) => error instanceof HanamaruConfigError
      && error.code === 'HANA_CONFIG_INVALID'
      && error.details.field === 'config.unknown',
  );
  const configSymbol = Symbol('unknown');
  assert.throws(
    () => prepareAdapterRequest({ mark: 'box' }, { [configSymbol]: true }),
    (error) => error instanceof HanamaruConfigError
      && error.code === 'HANA_CONFIG_INVALID'
      && error.details.field === `config.${String(configSymbol)}`,
  );
});

test('prepared request reflection and accessor failures preserve their exact causes', () => {
  for (const stage of ['ownKeys', 'descriptor', 'accessor']) {
    const failure = new Error(`${stage} failed`);
    let options;
    if (stage === 'ownKeys') {
      options = new Proxy({}, {
        ownKeys() { throw failure; },
      });
    } else if (stage === 'descriptor') {
      options = new Proxy({}, {
        ownKeys() { return ['mark']; },
        getOwnPropertyDescriptor() { throw failure; },
      });
    } else {
      options = {};
      Object.defineProperty(options, 'mark', {
        get() { throw failure; },
      });
    }
    assert.throws(
      () => prepareAdapterRequest(options),
      (error) => error === failure,
      stage,
    );
  }
});

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

test('hana:error emitted synchronously during successful update is delivered after update returns', () => {
  const harness = createHarness();
  const target = new FakeTarget('current', harness.calls);
  const failure = new Error('update event');
  const observed = [];
  harness.owner.mount(target, box);
  harness.setUpdateEvent(failure, 31);
  harness.calls.length = 0;

  harness.owner.update(target, circle, {
    onError(error, controller) {
      observed.push({
        controller,
        error,
        exposed: harness.exposed.at(-1),
        listeners: target.listenerCount,
        updateReturned: controller.updateReturned,
      });
    },
  });

  assert.deepEqual(observed, [{
    controller: harness.controllers[0],
    error: failure,
    exposed: null,
    listeners: 0,
    updateReturned: true,
  }]);
  assert.equal(harness.calls.filter((call) => call === 'destroy:current').length, 1);
  assert.equal(harness.exposed.filter((value) => value === null).length, 1);
});

test('update event followed by synchronous throw discards buffered failure and directly rethrows', () => {
  const harness = createHarness();
  const target = new FakeTarget('current', harness.calls);
  const eventFailure = new Error('buffered update event');
  const updateFailure = new Error('update threw');
  const observed = [];
  harness.owner.mount(target, box);
  harness.setUpdateEvent(eventFailure, 32);
  harness.setUpdateFailure(updateFailure);
  harness.calls.length = 0;

  assert.throws(
    () => harness.owner.update(target, circle, {
      onError(error) { observed.push(error); },
    }),
    (error) => error === updateFailure,
  );

  assert.deepEqual(observed, []);
  assert.deepEqual(harness.queued, []);
  assert.equal(harness.calls.filter((call) => call === 'destroy:current').length, 1);
  assert.equal(harness.exposed.filter((value) => value === null).length, 1);
});

test('reentrant winner during buffered update failure owns the final state', () => {
  for (const listenerOrder of ['before-adapter', 'after-adapter']) {
    const harness = createHarness();
    const target = new FakeTarget(`current-${listenerOrder}`, harness.calls);
    const winner = new FakeTarget(`winner-${listenerOrder}`, harness.calls);
    const listener = () => {
      target.removeEventListener('hana:error', listener);
      harness.setUpdateEvent(null);
      harness.owner.update(winner, circle);
    };
    if (listenerOrder === 'before-adapter') {
      target.addEventListener('hana:error', listener);
    }
    harness.owner.mount(target, box);
    if (listenerOrder === 'after-adapter') {
      target.addEventListener('hana:error', listener);
    }
    harness.setUpdateEvent(new Error(`stale ${listenerOrder}`), 33);
    harness.calls.length = 0;

    harness.owner.update(target, { mark: 'underline' }, {
      onError() { throw new Error('stale update onError must not run'); },
    });

    assert.equal(harness.exposed.at(-1).target, winner, listenerOrder);
    assert.equal(harness.exposed.filter((value) => value === null).length, 1, listenerOrder);
    assert.deepEqual(harness.queued, [], listenerOrder);
    assert.equal(target.listenerCount, 0, listenerOrder);
    assert.equal(winner.listenerCount, 1, listenerOrder);
  }
});

test('same-record null or no-op reentry preserves buffered update failure until the outer update returns', () => {
  for (const listenerOrder of ['before-adapter', 'after-adapter']) {
    for (const reentry of ['null-target', 'same-canonical']) {
      const harness = createHarness();
      const target = new FakeTarget(`${listenerOrder}-${reentry}`, harness.calls);
      const failure = new Error(`buffered ${listenerOrder} ${reentry}`);
      const observed = [];
      const listener = () => {
        target.removeEventListener('hana:error', listener);
        harness.owner.update(
          reentry === 'null-target' ? null : target,
          box,
          {
            onError(error, controller) {
              observed.push({
                controller,
                error,
                updateDepth: controller.updateDepth,
                updateReturned: controller.updateReturned,
              });
            },
          },
        );
      };
      if (listenerOrder === 'before-adapter') {
        target.addEventListener('hana:error', listener);
      }
      harness.owner.mount(target, box);
      if (listenerOrder === 'after-adapter') {
        target.addEventListener('hana:error', listener);
      }
      harness.setUpdateEvent(failure, 41);
      harness.calls.length = 0;

      harness.owner.update(target, circle, {
        onError() { throw new Error('superseded outer callback must not run'); },
      });

      assert.deepEqual(observed, [{
        controller: harness.controllers[0],
        error: failure,
        updateDepth: 0,
        updateReturned: true,
      }], `${listenerOrder} / ${reentry}`);
      assert.equal(
        harness.calls.filter((call) => call === `destroy:${target.name}`).length,
        1,
        `${listenerOrder} / ${reentry}`,
      );
      assert.equal(
        harness.exposed.filter((value) => value === null).length,
        1,
        `${listenerOrder} / ${reentry}`,
      );
      assert.equal(target.listenerCount, 0, `${listenerOrder} / ${reentry}`);
    }
  }
});

test('update throw after same-record null or no-op reentry still terminalizes the active record', () => {
  for (const listenerOrder of ['before-adapter', 'after-adapter']) {
    for (const reentry of ['null-target', 'same-canonical']) {
      const harness = createHarness();
      const target = new FakeTarget(`${listenerOrder}-${reentry}`, harness.calls);
      const eventFailure = new Error(`event ${listenerOrder} ${reentry}`);
      const updateFailure = new Error(`throw ${listenerOrder} ${reentry}`);
      const observed = [];
      const listener = () => {
        target.removeEventListener('hana:error', listener);
        harness.owner.update(
          reentry === 'null-target' ? null : target,
          box,
          { onError(error) { observed.push(error); } },
        );
      };
      if (listenerOrder === 'before-adapter') {
        target.addEventListener('hana:error', listener);
      }
      harness.owner.mount(target, box);
      if (listenerOrder === 'after-adapter') {
        target.addEventListener('hana:error', listener);
      }
      harness.setUpdateEvent(eventFailure, 42);
      harness.setUpdateFailure(updateFailure);
      harness.calls.length = 0;

      assert.equal(
        captureThrown(() => harness.owner.update(target, circle)),
        updateFailure,
        `${listenerOrder} / ${reentry}`,
      );

      assert.deepEqual(observed, [], `${listenerOrder} / ${reentry}`);
      assert.deepEqual(harness.queued, [], `${listenerOrder} / ${reentry}`);
      assert.equal(
        harness.calls.filter((call) => call === `destroy:${target.name}`).length,
        1,
        `${listenerOrder} / ${reentry}`,
      );
      assert.equal(
        harness.exposed.filter((value) => value === null).length,
        1,
        `${listenerOrder} / ${reentry}`,
      );
      assert.equal(target.listenerCount, 0, `${listenerOrder} / ${reentry}`);
    }
  }
});

test('outer update throw cannot tear down a reentrant replacement winner', () => {
  for (const listenerOrder of ['before-adapter', 'after-adapter']) {
    const harness = createHarness();
    const target = new FakeTarget(`stale-${listenerOrder}`, harness.calls);
    const winner = new FakeTarget(`winner-${listenerOrder}`, harness.calls);
    const updateFailure = new Error(`outer throw ${listenerOrder}`);
    const listener = () => {
      target.removeEventListener('hana:error', listener);
      harness.owner.update(winner, circle);
    };
    if (listenerOrder === 'before-adapter') {
      target.addEventListener('hana:error', listener);
    }
    harness.owner.mount(target, box);
    if (listenerOrder === 'after-adapter') {
      target.addEventListener('hana:error', listener);
    }
    harness.setUpdateEvent(new Error(`stale event ${listenerOrder}`), 43);
    harness.setUpdateFailure(updateFailure);
    harness.calls.length = 0;

    assert.equal(
      captureThrown(() => harness.owner.update(target, { mark: 'underline' })),
      updateFailure,
      listenerOrder,
    );

    assert.equal(harness.exposed.at(-1).target, winner, listenerOrder);
    assert.equal(
      harness.calls.filter((call) => call === `destroy:${target.name}`).length,
      1,
      listenerOrder,
    );
    assert.equal(
      harness.calls.filter((call) => call === `destroy:${winner.name}`).length,
      0,
      listenerOrder,
    );
    assert.equal(winner.listenerCount, 1, listenerOrder);
  }
});

test('reentrant disable or destroy terminalizes an updating record exactly once', () => {
  for (const listenerOrder of ['before-adapter', 'after-adapter']) {
    for (const action of ['disable', 'destroy']) {
      for (const outcome of ['success', 'throw']) {
        const harness = createHarness();
        const target = new FakeTarget(
          `${listenerOrder}-${action}-${outcome}`,
          harness.calls,
        );
        const updateFailure = new Error(`outer ${outcome}`);
        const listener = () => {
          target.removeEventListener('hana:error', listener);
          if (action === 'destroy') harness.owner.destroy();
          else harness.owner.update(target, box, { enabled: false });
        };
        if (listenerOrder === 'before-adapter') {
          target.addEventListener('hana:error', listener);
        }
        harness.owner.mount(target, box);
        if (listenerOrder === 'after-adapter') {
          target.addEventListener('hana:error', listener);
        }
        harness.setUpdateEvent(new Error(`terminal ${action}`), 44);
        if (outcome === 'throw') harness.setUpdateFailure(updateFailure);
        harness.calls.length = 0;

        if (outcome === 'throw') {
          assert.equal(
            captureThrown(() => harness.owner.update(target, circle)),
            updateFailure,
            `${listenerOrder} / ${action}`,
          );
        } else {
          assert.equal(harness.owner.update(target, circle), harness.owner);
        }

        assert.equal(
          harness.calls.filter((call) => call === `destroy:${target.name}`).length,
          1,
          `${listenerOrder} / ${action} / ${outcome}`,
        );
        assert.equal(
          harness.exposed.filter((value) => value === null).length,
          1,
          `${listenerOrder} / ${action} / ${outcome}`,
        );
        assert.equal(target.listenerCount, 0);
      }
    }
  }
});

test('nested same-record updates retain the latest real update owner without stranding phase', () => {
  const harness = createHarness();
  const target = new FakeTarget('nested-owner', harness.calls);
  let depth = 0;
  harness.owner.mount(target, box);
  harness.calls.length = 0;
  harness.setOnUpdate(() => {
    depth += 1;
    if (depth === 1) {
      harness.owner.update(null, box);
      harness.owner.update(target, { mark: 'underline' });
    } else if (depth === 2) {
      harness.owner.update(null, circle);
      harness.owner.update(target, box);
    }
  });

  harness.owner.update(target, circle);
  harness.setOnUpdate(null);
  harness.owner.update(target, { mark: 'underline' });

  assert.equal(depth, 2);
  assert.equal(
    harness.calls.filter((call) => Array.isArray(call) && call[0] === 'update').length,
    2,
  );
  assert.equal(harness.controllers[0].updateReturned, true);
  assert.equal(target.listenerCount, 1);
  assert.equal(harness.exposed.at(-1), harness.controllers[0]);
});

test('nested real update buffers failure until every same-record update frame returns', () => {
  for (const listenerOrder of ['before-adapter', 'after-adapter']) {
    const harness = createHarness();
    const target = new FakeTarget(`nested-${listenerOrder}`, harness.calls);
    const failure = new Error(`nested failure ${listenerOrder}`);
    const observed = [];
    const listener = () => {
      target.removeEventListener('hana:error', listener);
      harness.owner.update(target, { mark: 'underline' }, {
        onError(error, controller) {
          observed.push({
            error,
            updateDepth: controller.updateDepth,
          });
        },
      });
    };
    if (listenerOrder === 'before-adapter') {
      target.addEventListener('hana:error', listener);
    }
    harness.owner.mount(target, box);
    if (listenerOrder === 'after-adapter') {
      target.addEventListener('hana:error', listener);
    }
    harness.setUpdateEvent(failure, 45);

    harness.owner.update(target, circle);

    assert.deepEqual(observed, [{
      error: failure,
      updateDepth: 0,
    }], listenerOrder);
    assert.equal(
      harness.calls.filter((call) => Array.isArray(call) && call[0] === 'update').length,
      2,
      listenerOrder,
    );
    assert.equal(
      harness.calls.filter((call) => call === `destroy:${target.name}`).length,
      1,
      listenerOrder,
    );
  }
});

function captureThrown(operation) {
  let thrown = false;
  let value;
  try {
    operation();
  } catch (error) {
    thrown = true;
    value = error;
  }
  assert.equal(thrown, true);
  return value;
}

function cleanupFailureHarness(settings = {}) {
  const removeThrows = Object.hasOwn(settings, 'removeFailure');
  const destroyThrows = Object.hasOwn(settings, 'destroyFailure');
  const exposeThrows = Object.hasOwn(settings, 'exposeFailure');
  const updateThrows = Object.hasOwn(settings, 'updateFailure');
  const {
    removeFailure,
    destroyFailure,
    exposeFailure,
    updateFailure,
  } = settings;
  const listeners = new Set();
  const exposed = [];
  let destroyCount = 0;
  const target = {
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
      if (removeThrows) throw removeFailure;
    },
  };
  const controller = {
    finished: null,
    show() {
      controller.finished = Promise.resolve();
      return controller;
    },
    update() {
      if (updateThrows) throw updateFailure;
      return controller;
    },
    destroy() {
      destroyCount += 1;
      if (destroyThrows) throw destroyFailure;
      return controller;
    },
  };
  const owner = createAdapterOwner({
    create() { return controller; },
    expose(value) {
      exposed.push(value);
      if (value === null && exposeThrows) throw exposeFailure;
    },
  });
  owner.mount(target, box);
  return {
    controller,
    exposed,
    get destroyCount() { return destroyCount; },
    get listenerCount() { return listeners.size; },
    owner,
    target,
  };
}

test('cleanup preserves arbitrary first thrown values from remove, destroy, and expose', () => {
  for (const first of [null, undefined, 0, false]) {
    const remove = cleanupFailureHarness({
      removeFailure: first,
      destroyFailure: new Error('later destroy'),
      exposeFailure: new Error('later expose'),
    });
    assert.ok(Object.is(captureThrown(() => remove.owner.destroy()), first));
    assert.equal(remove.destroyCount, 1);
    assert.equal(remove.listenerCount, 0);

    const destroy = cleanupFailureHarness({
      destroyFailure: first,
      exposeFailure: new Error('later expose'),
    });
    assert.ok(Object.is(captureThrown(() => destroy.owner.destroy()), first));
    assert.equal(destroy.destroyCount, 1);
    assert.equal(destroy.listenerCount, 0);

    const expose = cleanupFailureHarness({ exposeFailure: first });
    assert.ok(Object.is(captureThrown(() => expose.owner.destroy()), first));
    assert.equal(expose.destroyCount, 1);
    assert.equal(expose.listenerCount, 0);
  }
});

test('cleanup attaches later thrown values only to a safe first object failure', () => {
  const first = new Error('remove first');
  const harness = cleanupFailureHarness({
    removeFailure: first,
    destroyFailure: null,
    exposeFailure: undefined,
  });

  assert.equal(captureThrown(() => harness.owner.destroy()), first);
  assert.equal(first.cleanupCause, null);
  assert.deepEqual(first.cleanupCauses, [null, undefined]);

  const sealed = Object.preventExtensions(new Error('sealed first'));
  const sealedHarness = cleanupFailureHarness({
    removeFailure: sealed,
    destroyFailure: new Error('cannot attach'),
  });
  assert.equal(captureThrown(() => sealedHarness.owner.destroy()), sealed);
});

test('synchronous update throw of undefined remains authoritative over cleanup errors', () => {
  const harness = cleanupFailureHarness({
    updateFailure: undefined,
    removeFailure: new Error('later remove'),
    destroyFailure: new Error('later destroy'),
    exposeFailure: new Error('later expose'),
  });

  const thrown = captureThrown(() => harness.owner.update(harness.target, circle));

  assert.equal(thrown, undefined);
  assert.equal(harness.destroyCount, 1);
  assert.equal(harness.listenerCount, 0);
});

function manualEventHarness() {
  let listener = null;
  let destroyCount = 0;
  const observed = [];
  const target = {
    addEventListener(_type, nextListener) { listener = nextListener; },
    removeEventListener(_type, nextListener) {
      if (listener === nextListener) listener = null;
    },
  };
  const controller = {
    finished: null,
    show() {
      controller.finished = Promise.resolve();
      return controller;
    },
    update() { return controller; },
    destroy() {
      destroyCount += 1;
      return controller;
    },
  };
  const owner = createAdapterOwner({
    create() { return controller; },
    expose() {},
  });
  owner.mount(target, box, {
    onError(error) { observed.push(error); },
  });
  return {
    controller,
    fire(event) { listener?.(event); },
    get destroyCount() { return destroyCount; },
    get listening() { return listener !== null; },
    observed,
    owner,
  };
}

test('hostile hana:error detail fields are read once and never escape the host listener', () => {
  for (const trappedField of ['detail', 'controller', 'error', 'generation']) {
    const harness = manualEventHarness();
    const counts = {
      detail: 0,
      controller: 0,
      error: 0,
      generation: 0,
    };
    const trap = new Error(`${trappedField} getter trapped`);
    const detail = {};
    for (const field of ['controller', 'error', 'generation']) {
      Object.defineProperty(detail, field, {
        get() {
          counts[field] += 1;
          if (field === trappedField) throw trap;
          if (field === 'controller') return harness.controller;
          if (field === 'error') return new Error('controller failed');
          return 41;
        },
      });
    }
    const event = {};
    Object.defineProperty(event, 'detail', {
      get() {
        counts.detail += 1;
        if (trappedField === 'detail') throw trap;
        return detail;
      },
    });

    assert.doesNotThrow(() => harness.fire(event), trappedField);
    assert.deepEqual(harness.observed, [], trappedField);
    assert.equal(harness.destroyCount, 0, trappedField);
    assert.equal(harness.listening, true, trappedField);
    assert.ok(Object.values(counts).every((count) => count <= 1), trappedField);
    harness.owner.destroy();
  }
});

test('proxy hana:error detail is snapshotted once before failure delivery', () => {
  const harness = manualEventHarness();
  const failure = new Error('proxy failure');
  const reads = new Map();
  const detail = new Proxy({}, {
    get(_target, property) {
      reads.set(property, (reads.get(property) ?? 0) + 1);
      if (property === 'controller') return harness.controller;
      if (property === 'error') return failure;
      if (property === 'generation') return 42;
      return undefined;
    },
  });

  assert.doesNotThrow(() => harness.fire({ detail }));

  assert.deepEqual(harness.observed, [failure]);
  assert.equal(harness.destroyCount, 1);
  assert.equal(harness.listening, false);
  assert.equal(reads.get('controller'), 1);
  assert.equal(reads.get('error'), 1);
  assert.equal(reads.get('generation'), 1);
});

function attachReentryHarness() {
  const controllers = [];
  const exposed = [];
  let createHook = null;
  const owner = createAdapterOwner({
    create(target) {
      createHook?.(target);
      const controller = {
        target,
        finished: null,
        showCount: 0,
        destroyCount: 0,
        show() {
          controller.showCount += 1;
          controller.finished = Promise.resolve();
          return controller;
        },
        update() { return controller; },
        destroy() {
          controller.destroyCount += 1;
          return controller;
        },
      };
      controllers.push(controller);
      return controller;
    },
    expose(controller) { exposed.push(controller); },
  });
  return {
    controllers,
    exposed,
    owner,
    setCreateHook(hook) { createHook = hook; },
  };
}

const NO_THROW = Symbol('no throw');

function attachTarget(name) {
  let addHook = null;
  let addFailure = NO_THROW;
  let listener = null;
  let removeCount = 0;
  return {
    name,
    addEventListener(_type, nextListener) {
      listener = nextListener;
      addHook?.();
      if (addFailure !== NO_THROW) throw addFailure;
    },
    removeEventListener(_type, nextListener) {
      removeCount += 1;
      if (listener === nextListener) listener = null;
    },
    setAddFailure(error) { addFailure = error; },
    setAddHook(hook) { addHook = hook; },
    get listening() { return listener !== null; },
    get removeCount() { return removeCount; },
  };
}

test('listener attachment reentrant destroy, disable, or winner prevents stale show', () => {
  for (const action of ['destroy', 'disable', 'winner']) {
    const harness = attachReentryHarness();
    const stale = attachTarget(`stale-${action}`);
    const winner = attachTarget(`winner-${action}`);
    stale.setAddHook(() => {
      stale.setAddHook(null);
      if (action === 'destroy') harness.owner.destroy();
      else if (action === 'disable') {
        harness.owner.update(stale, box, { enabled: false });
      } else {
        harness.owner.mount(winner, circle);
      }
    });

    harness.owner.mount(stale, box);

    const staleController = harness.controllers.find((item) => item.target === stale);
    assert.equal(staleController.showCount, 0, action);
    assert.equal(staleController.destroyCount, 1, action);
    assert.equal(stale.listening, false, action);
    assert.equal(stale.removeCount, 1, action);
    if (action === 'winner') {
      assert.equal(harness.exposed.at(-1).target, winner);
      assert.equal(harness.exposed.filter((value) => value === null).length, 0);
    } else {
      assert.deepEqual(harness.exposed, [], action);
    }
  }
});

test('create callback reentrant winner prevents every later stale candidate external call', () => {
  const harness = attachReentryHarness();
  const stale = attachTarget('stale-create');
  const winner = attachTarget('winner-create');
  harness.setCreateHook((target) => {
    if (target !== stale) return;
    harness.setCreateHook(null);
    harness.owner.mount(winner, circle);
  });

  harness.owner.mount(stale, box);

  const staleController = harness.controllers.find((item) => item.target === stale);
  assert.equal(staleController.showCount, 0);
  assert.equal(staleController.destroyCount, 1);
  assert.equal(stale.listening, false);
  assert.equal(stale.removeCount, 0);
  assert.equal(harness.exposed.at(-1).target, winner);
});

test('listener attachment throw after side effect cleans stale controller and rethrows exactly', () => {
  for (const reentry of ['none', 'winner']) {
    const harness = attachReentryHarness();
    const stale = attachTarget(`stale-throw-${reentry}`);
    const winner = attachTarget(`winner-throw-${reentry}`);
    const failure = new Error(`add failed ${reentry}`);
    if (reentry === 'winner') {
      stale.setAddHook(() => {
        stale.setAddHook(null);
        harness.owner.mount(winner, circle);
      });
    }
    stale.setAddFailure(failure);

    assert.equal(
      captureThrown(() => harness.owner.mount(stale, box)),
      failure,
      reentry,
    );

    const staleController = harness.controllers.find((item) => item.target === stale);
    assert.equal(staleController.showCount, 0, reentry);
    assert.equal(staleController.destroyCount, 1, reentry);
    assert.equal(stale.listening, false, reentry);
    assert.equal(stale.removeCount, 1, reentry);
    if (reentry === 'winner') {
      assert.equal(harness.exposed.at(-1).target, winner);
    } else {
      assert.deepEqual(harness.exposed, []);
    }
  }
});
