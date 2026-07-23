import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HanamaruConfigError,
  HanamaruStateError,
  HanamaruTargetError,
} from '../../src/errors.js';
import { createGroup, group } from '../../src/group.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve, settled: false };
}

function definitions() {
  return [
    { target: 'first', mark: 'circle' },
    { target: 'second', mark: 'highlight', note: 'Together' },
    { target: 'third', mark: 'underline', duration: 25 },
  ];
}

function minimalDocumentRealm(name) {
  class RealmDocument {}
  class RealmElement {
    constructor(ownerDocument) {
      this.isConnected = true;
      this.ownerDocument = ownerDocument;
    }

    getRootNode() {
      return this.ownerDocument;
    }
  }
  class RealmRange {}

  const document = new RealmDocument();
  const leaseFailure = new Error(`${name} document resources reached`);
  document.name = name;
  document.nodeType = 9;
  document.defaultView = {
    Document: RealmDocument,
    Element: RealmElement,
    Object,
    Range: RealmRange,
  };
  document.createElement = () => { throw leaseFailure; };
  return {
    document,
    leaseFailure,
    target: new RealmElement(document),
  };
}

function fakeEnvironment({ readyState = 'loading' } = {}) {
  const listeners = new Map();
  const root = {
    nodeType: 9,
    name: 'root',
    readyState,
    addEventListener(type, callback, options) {
      calls.push(['document:addEventListener', type]);
      let entries = listeners.get(type);
      if (entries === undefined) {
        entries = new Set();
        listeners.set(type, entries);
      }
      entries.add({ callback, once: options?.once === true });
    },
    removeEventListener(type, callback) {
      calls.push(['document:removeEventListener', type]);
      const entries = listeners.get(type);
      if (entries === undefined) return;
      for (const entry of entries) {
        if (entry.callback === callback) entries.delete(entry);
      }
    },
  };
  const calls = [];
  const events = [];
  const annotations = [];
  const outputs = new Set();
  const roots = new Map();
  const resolveFailures = new Map();
  const showFailures = new Map();
  const finishedFailures = new Map();
  const hideFailures = new Map();
  const refreshFailures = new Map();
  const asyncRefreshFailures = new Map();
  const destroyFailures = new Map();
  let createFailure = null;
  let eventHandler = null;
  let liveLeases = 0;
  let triggerLeases = 0;
  let triggerInstallFailure = null;
  let triggerCleanupFailure = null;
  const intersections = [];
  const registeredTriggers = new Set();
  const memberRefreshErrors = new Map();
  const pendingRefreshWrites = [];
  const pendingRefreshChecks = [];
  let asyncRefresh = false;

  function createAnnotation(target, options) {
    const index = annotations.length;
    calls.push(['createAnnotation', target]);
    if (createFailure?.index === index) throw createFailure.error;

    let state = 'idle';
    let run = null;
    let operation = 0;
    liveLeases += 1;
    outputs.add(target);
    const annotation = {
      target,
      options,
      get state() { return state; },
      get finished() {
        if (finishedFailures.has(target)) throw finishedFailures.get(target);
        return run?.promise ?? null;
      },
      show() {
        calls.push(['annotation:show', target]);
        if (showFailures.has(target)) throw showFailures.get(target);
        if (state === 'showing' || state === 'visible') return annotation;
        operation += 1;
        run = deferred();
        if (finishedFailures.has(target)) run.promise.catch(() => {});
        state = 'showing';
        return annotation;
      },
      finish() {
        if (run === null || run.settled) return;
        run.settled = true;
        state = 'visible';
        run.resolve();
      },
      fail(error) {
        if (run === null || run.settled) return;
        run.settled = true;
        state = 'suspended';
        run.reject(error);
      },
      hide() {
        calls.push(['annotation:hide', target]);
        operation += 1;
        if (run !== null && !run.settled) {
          run.settled = true;
          run.reject(new DOMException('Annotation hidden', 'AbortError'));
        }
        state = 'hidden';
        if (hideFailures.has(target)) throw hideFailures.get(target);
        return annotation;
      },
      replay() {
        annotation.hide();
        return annotation.show();
      },
      refresh() {
        calls.push(['annotation:refresh', target]);
        if (refreshFailures.has(target)) throw refreshFailures.get(target);
        if (asyncRefresh) {
          operation += 1;
          const refreshOperation = operation;
          const activeRun = run;
          pendingRefreshWrites.push({
            target,
            write() {
              if (refreshOperation !== operation) return;
              const error = asyncRefreshFailures.get(target);
              if (error !== undefined) {
                memberRefreshErrors.set(annotation, error);
                if (activeRun !== null && !activeRun.settled) annotation.fail(error);
                else state = 'suspended';
                return;
              }
              annotation.finish();
              state = 'visible';
            },
          });
          return annotation;
        }
        if (state === 'showing') annotation.finish();
        else if (state === 'suspended' || state === 'hidden') state = 'visible';
        return annotation;
      },
      destroy() {
        calls.push(['annotation:destroy', target]);
        if (state === 'destroyed') return annotation;
        operation += 1;
        state = 'destroyed';
        outputs.delete(target);
        liveLeases -= 1;
        if (destroyFailures.has(target)) throw destroyFailures.get(target);
        return annotation;
      },
    };
    annotations.push(annotation);
    return annotation;
  }

  return {
    annotations,
    calls,
    events,
    outputs,
    root,
    get liveLeases() { return liveLeases; },
    get triggerLeases() { return triggerLeases; },
    get listenerCount() {
      return [...listeners.values()].reduce((total, entries) => total + entries.size, 0);
    },
    intersections,
    failTriggerCleanup(error) { triggerCleanupFailure = error; },
    failTriggerInstall(error) { triggerInstallFailure = error; },
    fireDocument(type) {
      for (const entry of [...listeners.get(type) ?? []]) {
        if (entry.once) listeners.get(type).delete(entry);
        entry.callback();
      }
    },
    failCreate(index, error) { createFailure = { index, error }; },
    failDestroy(target, error) { destroyFailures.set(target, error); },
    failFinished(target, error) { finishedFailures.set(target, error); },
    failHide(target, error) { hideFailures.set(target, error); },
    failRefresh(target, error) { refreshFailures.set(target, error); },
    failRefreshAsync(target, error) { asyncRefreshFailures.set(target, error); },
    failResolve(target, error) { resolveFailures.set(target, error); },
    failShow(target, error) { showFailures.set(target, error); },
    clearRefreshFailure(target) { refreshFailures.delete(target); },
    clearRefreshFailureAsync(target) { asyncRefreshFailures.delete(target); },
    clearShowFailure(target) { showFailures.delete(target); },
    setEventHandler(handler) { eventHandler = handler; },
    setRoot(target, targetRoot) { roots.set(target, targetRoot); },
    useAsyncRefresh() { asyncRefresh = true; },
    async flushRefreshFrame() {
      const writes = pendingRefreshWrites.splice(0);
      for (const entry of writes) entry.write();
      const checks = pendingRefreshChecks.splice(0);
      for (const check of checks) check();
      await flushMicrotasks();
    },
    async flushRefreshWrite(target) {
      const index = pendingRefreshWrites.findIndex((entry) => entry.target === target);
      assert.notEqual(index, -1, `pending refresh write for ${target}`);
      const [entry] = pendingRefreshWrites.splice(index, 1);
      entry.write();
      await flushMicrotasks();
    },
    env: {
      root,
      document: root,
      triggerId: 'fake-group-trigger',
      acquireDocumentResources(doc) {
        calls.push(['acquireDocumentResources', doc]);
        triggerLeases += 1;
        let released = false;
        return {
          shared: {
            registerController(id) {
              calls.push(['trigger:register', id]);
              registeredTriggers.add(id);
              return 1;
            },
            observeIntersection(options) {
              calls.push(['trigger:observe', options.target.target]);
              if (triggerInstallFailure !== null) throw triggerInstallFailure;
              const registration = {
                ...options,
                active: true,
                disconnects: 0,
              };
              intersections.push(registration);
              return () => {
                if (!registration.active) return;
                registration.active = false;
                registration.disconnects += 1;
                calls.push(['trigger:disconnect', options.target.target]);
                if (triggerCleanupFailure !== null) throw triggerCleanupFailure;
              };
            },
            releaseController(id) {
              calls.push(['trigger:releaseController', id]);
              registeredTriggers.delete(id);
            },
          },
          release() {
            if (released) return;
            released = true;
            calls.push(['trigger:releaseLease']);
            triggerLeases -= 1;
          },
        };
      },
      createAnnotation,
      createEvent(type, detail, owner) {
        const event = { type, detail, owner };
        events.push(event);
        eventHandler?.(event);
      },
      eventOwner(record) { return record.ownerElement; },
      afterRefresh(callback) {
        let active = true;
        pendingRefreshChecks.push(() => {
          if (active) callback();
        });
        return () => { active = false; };
      },
      clearMemberError(annotation) { memberRefreshErrors.delete(annotation); },
      memberError(annotation) { return memberRefreshErrors.get(annotation); },
      microtask(callback) { queueMicrotask(callback); },
      resolveTarget(target) {
        calls.push(['resolveTarget', target]);
        if (resolveFailures.has(target)) throw resolveFailures.get(target);
        const targetRoot = roots.get(target) ?? root;
        return {
          ownerElement: {
            target,
            getRootNode() { return targetRoot; },
          },
          refresh() {
            calls.push(['record:refresh', target]);
            if (resolveFailures.has(target)) throw resolveFailures.get(target);
            return this;
          },
        };
      },
    },
  };
}

async function flushMicrotasks(turns = 6) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

test('group construction validates and resolves every member before creating annotations', () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), {}, environment.env);

  assert.deepEqual(environment.calls.slice(0, 3), [
    ['resolveTarget', 'first'],
    ['resolveTarget', 'second'],
    ['resolveTarget', 'third'],
  ]);
  assert.deepEqual(environment.calls.slice(3), [
    ['createAnnotation', 'first'],
    ['createAnnotation', 'second'],
    ['createAnnotation', 'third'],
  ]);
  assert.equal(controller.size, 3);
});

test('public group uses the current native Document realm by default', () => {
  const realm = minimalDocumentRealm('top');
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const previousDocument = globalThis.document;
  globalThis.document = realm.document;
  try {
    assert.throws(
      () => group([{ target: realm.target, mark: 'circle' }]),
      (error) => error === realm.leaseFailure,
    );
  } finally {
    if (hadDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
  }
});

test('public group accepts and uses the exact iframe Document realm', () => {
  const top = minimalDocumentRealm('top');
  const iframe = minimalDocumentRealm('iframe');
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const previousDocument = globalThis.document;
  globalThis.document = top.document;
  try {
    assert.throws(
      () => group(
        [{ target: iframe.target, mark: 'underline' }],
        {},
        { root: iframe.document },
      ),
      (error) => error === iframe.leaseFailure,
    );
  } finally {
    if (hadDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
  }
});

test('public group rejects invalid context shapes, roots, and unknown context keys', () => {
  const invalidContexts = [
    null,
    [],
    { root: null },
    { root: { nodeType: 9, defaultView: null } },
    { root: { nodeType: 11, host: {} } },
    { extra: true },
  ];
  for (const context of invalidContexts) {
    assert.throws(
      () => group(definitions(), {}, context),
      (error) => error instanceof HanamaruConfigError
        && error.code === 'HANA_CONFIG_INVALID',
    );
  }
});

test('group construction validates every definition before resolving the first target', () => {
  const environment = fakeEnvironment();
  const members = definitions();
  members[2] = { ...members[2], unknown: true };

  assert.throws(
    () => createGroup(members, {}, environment.env),
    HanamaruConfigError,
  );
  assert.equal(
    environment.calls.some(([name]) => name === 'resolveTarget'),
    false,
  );
  assert.equal(environment.annotations.length, 0);
});

test('group construction rejects non-array, empty, and non-definition members without output', () => {
  const invalidMembers = [
    null,
    {},
    [],
    [null],
    ['first'],
    [{ mark: 'circle' }],
    [{ target: 'first', mark: 'circle', update() {} }],
  ];
  for (const members of invalidMembers) {
    const environment = fakeEnvironment();
    assert.throws(
      () => createGroup(members, {}, environment.env),
      HanamaruConfigError,
    );
    assert.equal(environment.annotations.length, 0);
    assert.equal(environment.outputs.size, 0);
  }
});

test('group construction rejects annotation, Story, and Group controllers as members', () => {
  const candidates = [
    { state: 'idle', show() {}, hide() {}, destroy() {} },
    { state: 'idle', play() {}, cancel() {}, destroy() {} },
    { state: 'idle', size: 2, show() {}, replay() {}, destroy() {} },
  ];
  for (const member of candidates) {
    const environment = fakeEnvironment();
    assert.throws(
      () => createGroup([member], {}, environment.env),
      HanamaruConfigError,
    );
    assert.equal(environment.annotations.length, 0);
  }
});

test('group construction rejects any member-owned trigger or motion', () => {
  for (const forbidden of [
    { trigger: 'manual' },
    { trigger: undefined },
    { motion: 'system' },
    { motion: undefined },
  ]) {
    const environment = fakeEnvironment();
    assert.throws(
      () => createGroup([
        { target: 'first', mark: 'circle', ...forbidden },
      ], {}, environment.env),
      HanamaruConfigError,
    );
    assert.equal(environment.annotations.length, 0);
  }
});

test('group construction accepts only aggregate trigger and motion options', () => {
  for (const options of [
    null,
    [],
    { trigger: 'click' },
    { motion: 'always' },
    { gap: 10 },
    { once: true },
  ]) {
    const environment = fakeEnvironment();
    assert.throws(
      () => createGroup(definitions(), options, environment.env),
      HanamaruConfigError,
    );
    assert.equal(environment.annotations.length, 0);
  }

  for (const trigger of ['manual', 'load', 'viewport']) {
    for (const motion of ['system', 'never']) {
      const environment = fakeEnvironment();
      createGroup(definitions(), { trigger, motion }, environment.env);
      assert.deepEqual(
        environment.annotations.map((annotation) => [
          annotation.options.trigger,
          annotation.options.motion,
        ]),
        definitions().map(() => ['manual', motion]),
      );
    }
  }
});

test('group preflight contains a later target failure before any controller or lease exists', () => {
  for (let index = 0; index < definitions().length; index += 1) {
    const environment = fakeEnvironment();
    const expected = new HanamaruTargetError('HANA_TARGET_MISSING', 'Missing');
    environment.failResolve(definitions()[index].target, expected);

    assert.throws(
      () => createGroup(definitions(), {}, environment.env),
      (error) => error === expected,
    );
    assert.equal(environment.annotations.length, 0);
    assert.equal(environment.liveLeases, 0);
    assert.equal(environment.outputs.size, 0);
  }
});

test('group preflight rejects standalone Shadow and cross-root members before creation', () => {
  const shadowEnvironment = fakeEnvironment();
  const shadow = { nodeType: 11, host: {} };
  shadowEnvironment.setRoot('second', shadow);
  assert.throws(
    () => createGroup(definitions(), {}, shadowEnvironment.env),
    (error) => error instanceof HanamaruTargetError
      && error.code === 'HANA_TARGET_SHADOW_UNSCOPED',
  );
  assert.equal(shadowEnvironment.annotations.length, 0);

  const crossEnvironment = fakeEnvironment();
  crossEnvironment.setRoot('third', { nodeType: 9, name: 'iframe' });
  assert.throws(
    () => createGroup(definitions(), {}, crossEnvironment.env),
    HanamaruTargetError,
  );
  assert.equal(crossEnvironment.annotations.length, 0);
});

test('group preflight identifies direct and locator Shadow targets before resolution', () => {
  for (const makeTarget of [
    (shadow) => ({
      nodeType: 1,
      getRootNode() { return shadow; },
    }),
    (shadow) => ({
      within: {
        nodeType: 1,
        getRootNode() { return shadow; },
      },
      text: 'inside',
    }),
  ]) {
    const environment = fakeEnvironment();
    const shadow = { nodeType: 11, host: {} };
    const target = makeTarget(shadow);

    assert.throws(
      () => createGroup([{ target, mark: 'circle' }], {}, environment.env),
      (error) => error instanceof HanamaruTargetError
        && error.code === 'HANA_TARGET_SHADOW_UNSCOPED',
    );
    assert.equal(
      environment.calls.some(([name]) => name === 'resolveTarget'),
      false,
    );
  }
});

test('group construction failure reverses created controllers and preserves the original typed error', () => {
  for (let index = 0; index < definitions().length; index += 1) {
    const environment = fakeEnvironment();
    const expected = new HanamaruStateError(
      'HANA_STATE_RUNTIME',
      `create failed at ${index}`,
    );
    environment.failCreate(index, expected);

    assert.throws(
      () => createGroup(definitions(), {}, environment.env),
      (error) => error === expected,
    );
    assert.deepEqual(
      environment.calls
        .filter(([name]) => name === 'annotation:destroy')
        .map(([, target]) => target),
      definitions().slice(0, index).map(({ target }) => target).reverse(),
    );
    assert.equal(environment.liveLeases, 0);
    assert.equal(environment.outputs.size, 0);
  }
});

test('group exposes only the exact controller surface with a read-only size', () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), {}, environment.env);

  assert.deepEqual(Object.keys(controller), [
    'state',
    'finished',
    'size',
    'show',
    'hide',
    'replay',
    'refresh',
    'destroy',
  ]);
  assert.equal(controller.update, undefined);
  assert.throws(() => { controller.size = 99; }, TypeError);
  assert.equal(controller.size, definitions().length);
});

test('show transition starts every member in input order and completes atomically', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), {}, environment.env);
  environment.calls.length = 0;

  assert.equal(controller.state, 'idle');
  assert.equal(controller.finished, null);
  assert.equal(controller.show(), controller);
  const run = controller.finished;
  assert.ok(run instanceof Promise);
  assert.equal(controller.state, 'showing');
  assert.equal(controller.show(), controller);
  assert.equal(controller.finished, run);
  assert.deepEqual(
    environment.calls.filter(([name]) => name === 'record:refresh'),
    definitions().map(({ target }) => ['record:refresh', target]),
  );
  assert.deepEqual(
    environment.calls.filter(([name]) => name === 'annotation:show'),
    definitions().map(({ target }) => ['annotation:show', target]),
  );
  assert.deepEqual(environment.events[0], {
    type: 'hana:start',
    detail: { controller, state: 'showing' },
    owner: environment.events[0].owner,
  });
  assert.equal(environment.events[0].owner.target, 'first');

  environment.annotations[2].finish();
  environment.annotations[0].finish();
  await flushMicrotasks();
  assert.equal(controller.state, 'showing');
  environment.annotations[1].finish();
  await run;
  assert.equal(controller.state, 'visible');
  assert.deepEqual(environment.events.map(({ type }) => type), [
    'hana:start',
    'hana:complete',
  ]);
  assert.deepEqual(environment.events[1].detail, {
    controller,
    state: 'visible',
  });
  assert.equal(controller.show(), controller);
  assert.equal(controller.finished, run);
});

test('show from suspended creates a fresh recoverable run and preserves finished on failed preflight', async () => {
  const successEnvironment = fakeEnvironment();
  const recoverable = createGroup(definitions(), {}, successEnvironment.env);
  recoverable.show();
  successEnvironment.annotations[1].fail(new Error('temporary member failure'));
  const rejectedRun = recoverable.finished;
  await assert.rejects(rejectedRun, HanamaruStateError);
  assert.equal(recoverable.state, 'suspended');

  assert.equal(recoverable.show(), recoverable);
  const recoveryRun = recoverable.finished;
  assert.notEqual(recoveryRun, rejectedRun);
  assert.equal(recoverable.state, 'showing');
  assert.deepEqual(successEnvironment.annotations.map(({ state }) => state), [
    'showing', 'showing', 'showing',
  ]);
  for (const annotation of successEnvironment.annotations) annotation.finish();
  await recoveryRun;
  assert.equal(recoverable.state, 'visible');

  const failureEnvironment = fakeEnvironment();
  const stillSuspended = createGroup(definitions(), {}, failureEnvironment.env);
  stillSuspended.show();
  failureEnvironment.annotations[0].fail(new Error('initial failure'));
  const previousFinished = stillSuspended.finished;
  await assert.rejects(previousFinished, HanamaruStateError);
  failureEnvironment.failResolve(
    'second',
    new HanamaruTargetError('HANA_TARGET_MISSING', 'still missing'),
  );
  const showCalls = failureEnvironment.calls
    .filter(([name]) => name === 'annotation:show').length;

  assert.equal(stillSuspended.show(), stillSuspended);
  assert.equal(stillSuspended.state, 'suspended');
  assert.equal(stillSuspended.finished, previousFinished);
  assert.equal(
    failureEnvironment.calls.filter(([name]) => name === 'annotation:show').length,
    showCalls,
  );
  assert.equal(failureEnvironment.events.at(-1).type, 'hana:error');
  assert.equal(failureEnvironment.events.at(-1).detail.index, 1);
});

test('hide transition aborts a pending run, hides all members, and is a no-op elsewhere', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), {}, environment.env);

  assert.equal(controller.hide(), controller);
  assert.equal(controller.state, 'idle');
  assert.equal(environment.calls.some(([name]) => name === 'annotation:hide'), false);

  controller.show();
  const run = controller.finished;
  environment.calls.length = 0;
  assert.equal(controller.hide(), controller);
  await assert.rejects(
    run,
    (error) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(controller.state, 'hidden');
  assert.deepEqual(
    environment.calls.filter(([name]) => name === 'annotation:hide'),
    definitions().map(({ target }) => ['annotation:hide', target]),
  );
  assert.deepEqual(environment.events.at(-1).detail, {
    controller,
    reason: 'hide',
  });

  const callCount = environment.calls.length;
  assert.equal(controller.hide(), controller);
  assert.equal(environment.calls.length, callCount);
});

test('hide accepts visible and suspended states and dispatches cancel from the first owner', async () => {
  const visibleEnvironment = fakeEnvironment();
  const visible = createGroup(definitions(), {}, visibleEnvironment.env);
  visible.show();
  for (const annotation of visibleEnvironment.annotations) annotation.finish();
  await visible.finished;
  visibleEnvironment.events.length = 0;
  visible.hide();
  assert.equal(visible.state, 'hidden');
  assert.equal(visibleEnvironment.events.at(-1).type, 'hana:cancel');
  assert.equal(visibleEnvironment.events.at(-1).owner.target, 'first');

  const suspendedEnvironment = fakeEnvironment();
  const suspended = createGroup(definitions(), {}, suspendedEnvironment.env);
  suspended.show();
  suspendedEnvironment.annotations[1].fail(new Error('suspend'));
  await assert.rejects(suspended.finished, HanamaruStateError);
  suspendedEnvironment.events.length = 0;
  suspended.hide();
  assert.equal(suspended.state, 'hidden');
  assert.equal(suspendedEnvironment.events.at(-1).type, 'hana:cancel');
  assert.equal(suspendedEnvironment.events.at(-1).owner.target, 'first');
});

test('replay preflights all members before superseding and starts a fresh run', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), {}, environment.env);
  controller.show();
  const firstRun = controller.finished;
  environment.calls.length = 0;

  assert.equal(controller.replay(), controller);
  await assert.rejects(firstRun, (error) => error?.name === 'AbortError');
  assert.equal(controller.state, 'showing');
  assert.notEqual(controller.finished, firstRun);
  assert.deepEqual(environment.calls.slice(0, 9), [
    ['record:refresh', 'first'],
    ['record:refresh', 'second'],
    ['record:refresh', 'third'],
    ['annotation:hide', 'first'],
    ['annotation:hide', 'second'],
    ['annotation:hide', 'third'],
    ['annotation:show', 'first'],
    ['annotation:show', 'second'],
    ['annotation:show', 'third'],
  ]);
  assert.equal(
    environment.events.filter(({ type }) => type === 'hana:cancel').at(-1).detail.reason,
    'replay',
  );
});

test('replay is accepted from idle, hidden, visible, and suspended states', async () => {
  for (const desiredState of ['idle', 'hidden', 'visible', 'suspended']) {
    const environment = fakeEnvironment();
    const controller = createGroup(definitions(), {}, environment.env);
    if (desiredState !== 'idle') controller.show();
    if (desiredState === 'hidden') {
      const pending = controller.finished;
      controller.hide();
      await assert.rejects(pending, (error) => error?.name === 'AbortError');
    }
    if (desiredState === 'visible') {
      for (const annotation of environment.annotations) annotation.finish();
      await controller.finished;
    }
    if (desiredState === 'suspended') {
      environment.annotations[0].fail(new Error('suspended'));
      await assert.rejects(controller.finished, HanamaruStateError);
    }
    assert.equal(controller.state, desiredState);
    const previous = controller.finished;
    environment.events.length = 0;

    assert.equal(controller.replay(), controller);
    assert.equal(controller.state, 'showing');
    assert.ok(controller.finished instanceof Promise);
    assert.notEqual(controller.finished, previous);
    assert.equal(environment.events.at(-1).type, 'hana:start');
    assert.equal(environment.events.at(-1).owner.target, 'first');
    if (desiredState !== 'idle') {
      const cancel = environment.events.find(({ type }) => type === 'hana:cancel');
      if (desiredState === 'hidden') assert.equal(cancel, undefined);
      else assert.equal(cancel.owner.target, 'first');
    }
    controller.destroy();
  }
});

test('replay preflight failure preserves state, output, and finished identity', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), {}, environment.env);
  controller.show();
  for (const annotation of environment.annotations) annotation.finish();
  await controller.finished;
  const settledRun = controller.finished;
  const expected = new HanamaruTargetError('HANA_TARGET_MISSING', 'Replacement missing');
  environment.failResolve('second', expected);
  environment.calls.length = 0;

  assert.throws(
    () => controller.replay(),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_GROUP_MEMBER'
      && error.details.index === 1
      && error.details.error === expected,
  );
  assert.equal(controller.state, 'visible');
  assert.equal(controller.finished, settledRun);
  assert.deepEqual(environment.annotations.map(({ state }) => state), [
    'visible', 'visible', 'visible',
  ]);
  assert.deepEqual(
    environment.calls.filter(([name]) => name === 'record:refresh'),
    definitions().map(({ target }) => ['record:refresh', target]),
  );
  assert.equal(environment.calls.some(([name]) => name === 'annotation:hide'), false);
  assert.equal(environment.events.at(-1).type, 'hana:error');
  assert.equal(environment.events.at(-1).detail.index, 1);
});

test('refresh transition redraws every active member without replacing finished', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), {}, environment.env);
  controller.show();
  const run = controller.finished;
  environment.calls.length = 0;

  assert.equal(controller.refresh(), controller);
  assert.equal(controller.state, 'showing');
  assert.equal(controller.finished, run);
  assert.deepEqual(
    environment.calls.filter(([name]) => name === 'annotation:refresh'),
    definitions().map(({ target }) => ['annotation:refresh', target]),
  );
  for (const annotation of environment.annotations) annotation.finish();
  await run;

  environment.calls.length = 0;
  assert.equal(controller.refresh(), controller);
  assert.equal(controller.state, 'visible');
  assert.equal(controller.finished, run);
  assert.deepEqual(
    environment.calls.filter(([name]) => name === 'annotation:refresh'),
    definitions().map(({ target }) => ['annotation:refresh', target]),
  );
});

test('refresh is a strict no-op from idle and hidden', async () => {
  const idleEnvironment = fakeEnvironment();
  const idle = createGroup(definitions(), {}, idleEnvironment.env);
  idleEnvironment.calls.length = 0;
  assert.equal(idle.refresh(), idle);
  assert.equal(idle.state, 'idle');
  assert.equal(idle.finished, null);
  assert.equal(idleEnvironment.calls.length, 0);

  const hiddenEnvironment = fakeEnvironment();
  const hidden = createGroup(definitions(), {}, hiddenEnvironment.env);
  hidden.show();
  const run = hidden.finished;
  hidden.hide();
  await assert.rejects(run, (error) => error?.name === 'AbortError');
  hiddenEnvironment.calls.length = 0;
  assert.equal(hidden.refresh(), hidden);
  assert.equal(hidden.state, 'hidden');
  assert.equal(hiddenEnvironment.calls.length, 0);
});

test('destroy aborts once, tears down in reverse, and makes every control a no-op', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), {}, environment.env);
  controller.show();
  const run = controller.finished;
  environment.calls.length = 0;

  assert.equal(controller.destroy(), controller);
  await assert.rejects(run, (error) => error?.name === 'AbortError');
  assert.equal(controller.state, 'destroyed');
  assert.deepEqual(
    environment.calls.filter(([name]) => name === 'annotation:destroy'),
    definitions().map(({ target }) => target).reverse().map((target) => [
      'annotation:destroy',
      target,
    ]),
  );
  const calls = environment.calls.length;
  const finished = controller.finished;
  for (const method of ['show', 'hide', 'replay', 'refresh', 'destroy']) {
    assert.equal(controller[method](), controller);
  }
  assert.equal(controller.finished, finished);
  assert.equal(environment.calls.length, calls);
});

test('destroy accepts idle, hidden, visible, and suspended with reverse teardown', async () => {
  for (const desiredState of ['idle', 'hidden', 'visible', 'suspended']) {
    const environment = fakeEnvironment();
    const controller = createGroup(definitions(), {}, environment.env);
    if (desiredState !== 'idle') controller.show();
    if (desiredState === 'hidden') {
      const pending = controller.finished;
      controller.hide();
      await assert.rejects(pending, (error) => error?.name === 'AbortError');
    }
    if (desiredState === 'visible') {
      for (const annotation of environment.annotations) annotation.finish();
      await controller.finished;
    }
    if (desiredState === 'suspended') {
      environment.annotations[2].fail(new Error('suspended'));
      await assert.rejects(controller.finished, HanamaruStateError);
    }
    environment.calls.length = 0;

    assert.equal(controller.destroy(), controller);
    assert.equal(controller.state, 'destroyed');
    assert.deepEqual(
      environment.calls
        .filter(([name]) => name === 'annotation:destroy')
        .map(([, target]) => target),
      ['third', 'second', 'first'],
    );
  }
});

test('complete, cancel, and error always dispatch from the exact first member owner', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), {}, environment.env);
  controller.show();
  for (const annotation of environment.annotations) annotation.finish();
  await controller.finished;
  controller.hide();
  controller.show();
  environment.annotations[1].fail(new Error('owner check'));
  await assert.rejects(controller.finished, HanamaruStateError);

  for (const type of ['hana:complete', 'hana:cancel', 'hana:error']) {
    const matching = environment.events.filter((event) => event.type === type);
    assert.ok(matching.length > 0, type);
    assert.ok(matching.every(({ owner }) => owner.target === 'first'), type);
  }
});

test('synchronous start and cancel listeners can reenter without stale member starts', async () => {
  const startEnvironment = fakeEnvironment();
  const startController = createGroup(definitions(), {}, startEnvironment.env);
  startEnvironment.setEventHandler((event) => {
    if (event.type === 'hana:start') startController.hide();
  });

  startController.show();
  await assert.rejects(startController.finished, (error) => error?.name === 'AbortError');
  assert.equal(startController.state, 'hidden');
  assert.equal(
    startEnvironment.calls.some(([name]) => name === 'annotation:show'),
    false,
  );

  const cancelEnvironment = fakeEnvironment();
  const cancelController = createGroup(definitions(), {}, cancelEnvironment.env);
  let replayed = false;
  cancelEnvironment.setEventHandler((event) => {
    if (event.type === 'hana:cancel' && !replayed) {
      replayed = true;
      cancelController.replay();
    }
  });
  cancelController.show();
  const firstRun = cancelController.finished;
  cancelController.hide();
  await assert.rejects(firstRun, (error) => error?.name === 'AbortError');
  assert.equal(cancelController.state, 'showing');
  assert.notEqual(cancelController.finished, firstRun);
  assert.equal(
    cancelEnvironment.calls.filter(([name]) => name === 'annotation:show').length,
    definitions().length * 2,
  );
});

test('a synchronous complete listener can replay without stale completion winning', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), {}, environment.env);
  let replayed = false;
  environment.setEventHandler((event) => {
    if (event.type === 'hana:complete' && !replayed) {
      replayed = true;
      controller.replay();
    }
  });
  controller.show();
  const firstRun = controller.finished;
  for (const annotation of environment.annotations) annotation.finish();
  await firstRun;
  await flushMicrotasks();

  assert.equal(controller.state, 'showing');
  assert.notEqual(controller.finished, firstRun);
  assert.deepEqual(environment.annotations.map(({ state }) => state), [
    'showing', 'showing', 'showing',
  ]);
  assert.equal(
    environment.events.filter(({ type }) => type === 'hana:step' || type === 'hana:pause').length,
    0,
  );
});

test('synchronous member failure at every index suspends atomically with a typed aggregate', async () => {
  for (let index = 0; index < definitions().length; index += 1) {
    const environment = fakeEnvironment();
    const cause = new Error(`sync failure ${index}`);
    environment.failShow(definitions()[index].target, cause);
    const controller = createGroup(definitions(), {}, environment.env);

    controller.show();
    const run = controller.finished;
    await assert.rejects(run, (error) => {
      assert.ok(error instanceof HanamaruStateError);
      assert.equal(error.code, 'HANA_STATE_GROUP_MEMBER');
      assert.equal(error.details.index, index);
      assert.ok(error.details.error instanceof HanamaruStateError);
      assert.equal(error.details.error.code, 'HANA_STATE_RUNTIME');
      assert.equal(error.details.error.details.cause, cause);
      return true;
    });
    assert.equal(controller.state, 'suspended');
    assert.deepEqual(
      environment.calls
        .filter(([name]) => name === 'annotation:hide')
        .map(([, target]) => target),
      definitions().slice(0, index + 1).map(({ target }) => target),
    );
    assert.equal(environment.events.filter(({ type }) => type === 'hana:error').length, 1);
    assert.equal(environment.events.at(-1).detail.index, index);
  }
});

test('rejected member failure at every index hides all started members and preserves typed causes', async () => {
  for (let index = 0; index < definitions().length; index += 1) {
    const environment = fakeEnvironment();
    const controller = createGroup(definitions(), {}, environment.env);
    controller.show();
    const run = controller.finished;
    const cause = new HanamaruTargetError(
      'HANA_TARGET_INVALID',
      `member failure ${index}`,
    );

    environment.annotations[index].fail(cause);
    await assert.rejects(run, (error) => {
      assert.ok(error instanceof HanamaruStateError);
      assert.equal(error.code, 'HANA_STATE_GROUP_MEMBER');
      assert.equal(error.details.index, index);
      assert.equal(error.details.error, cause);
      return true;
    });
    await flushMicrotasks();
    assert.equal(controller.state, 'suspended');
    assert.deepEqual(environment.annotations.map(({ state }) => state), [
      'hidden', 'hidden', 'hidden',
    ]);
    assert.equal(environment.events.filter(({ type }) => type === 'hana:error').length, 1);
  }
});

test('a throwing member finished getter is contained as a synchronous member failure', async () => {
  const environment = fakeEnvironment();
  const cause = new Error('finished getter failed');
  environment.failFinished('second', cause);
  const controller = createGroup(definitions(), {}, environment.env);

  assert.doesNotThrow(() => controller.show());
  await assert.rejects(controller.finished, (error) => {
    assert.equal(error.code, 'HANA_STATE_GROUP_MEMBER');
    assert.equal(error.details.index, 1);
    assert.equal(error.details.error.details.cause, cause);
    return true;
  });
  assert.equal(controller.state, 'suspended');
  assert.deepEqual(
    environment.calls
      .filter(([name]) => name === 'annotation:hide')
      .map(([, target]) => target),
    ['first', 'second'],
  );
});

test('member failure observes every remaining Promise without unhandled rejection', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), {}, environment.env);
  const unhandled = [];
  const onUnhandled = (error) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    controller.show();
    const run = controller.finished;
    environment.annotations[1].fail(new Error('primary'));
    await assert.rejects(run, HanamaruStateError);
    await flushMicrotasks();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('refresh failure during a pending run attempts all members and rejects that same run', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), {}, environment.env);
  controller.show();
  const run = controller.finished;
  const low = new HanamaruTargetError('HANA_TARGET_MISSING', 'first gone');
  environment.failRefresh('first', low);
  environment.failRefresh('third', new Error('third failed too'));
  environment.calls.length = 0;

  assert.equal(controller.refresh(), controller);
  await assert.rejects(run, (error) => {
    assert.equal(error.code, 'HANA_STATE_GROUP_MEMBER');
    assert.equal(error.details.index, 0);
    assert.equal(error.details.error, low);
    return true;
  });
  assert.equal(controller.finished, run);
  assert.equal(controller.state, 'suspended');
  assert.deepEqual(
    environment.calls.filter(([name]) => name === 'annotation:refresh'),
    definitions().map(({ target }) => ['annotation:refresh', target]),
  );
  assert.deepEqual(environment.annotations.map(({ state }) => state), [
    'hidden', 'hidden', 'hidden',
  ]);
  assert.equal(environment.events.filter(({ type }) => type === 'hana:error').length, 1);
  assert.equal(environment.events.at(-1).detail.index, 0);
});

test('refresh re-resolves every target and reports the lowest target failure after all attempts', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), {}, environment.env);
  controller.show();
  const run = controller.finished;
  environment.calls.length = 0;
  const firstFailure = new HanamaruTargetError('HANA_TARGET_MISSING', 'first missing');
  environment.failResolve('first', firstFailure);
  environment.failResolve('third', new Error('third missing'));

  controller.refresh();
  await assert.rejects(run, (error) => {
    assert.equal(error.code, 'HANA_STATE_GROUP_MEMBER');
    assert.equal(error.details.index, 0);
    assert.equal(error.details.error, firstFailure);
    return true;
  });
  assert.deepEqual(
    environment.calls.filter(([name]) => name === 'record:refresh'),
    definitions().map(({ target }) => ['record:refresh', target]),
  );
  assert.deepEqual(
    environment.calls.filter(([name]) => name === 'annotation:refresh'),
    definitions().map(({ target }) => ['annotation:refresh', target]),
  );
});

test('refresh failure after settlement preserves finished identity and supports recovery', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), {}, environment.env);
  controller.show();
  for (const annotation of environment.annotations) annotation.finish();
  const settledRun = controller.finished;
  await settledRun;
  environment.failRefresh('second', new Error('refresh exploded'));

  assert.equal(controller.refresh(), controller);
  assert.equal(controller.state, 'suspended');
  assert.equal(controller.finished, settledRun);
  await settledRun;
  assert.deepEqual(environment.annotations.map(({ state }) => state), [
    'hidden', 'hidden', 'hidden',
  ]);

  environment.clearRefreshFailure('second');
  assert.equal(controller.refresh(), controller);
  await environment.flushRefreshFrame();
  assert.equal(controller.state, 'visible');
  assert.equal(controller.finished, settledRun);

  controller.hide();
  controller.show();
  assert.notEqual(controller.finished, settledRun);
  assert.equal(controller.state, 'showing');
});

test('post-settlement async refresh failure suspends after the later frame without replacing finished', async () => {
  const environment = fakeEnvironment();
  environment.useAsyncRefresh();
  const controller = createGroup(definitions(), {}, environment.env);
  controller.show();
  for (const annotation of environment.annotations) annotation.finish();
  const settledRun = controller.finished;
  await settledRun;
  const cause = new HanamaruTargetError('HANA_TARGET_MISSING', 'async target loss');
  environment.failRefreshAsync('second', cause);

  controller.refresh();
  assert.equal(controller.state, 'visible');
  assert.equal(controller.finished, settledRun);
  await environment.flushRefreshFrame();

  assert.equal(controller.state, 'suspended');
  assert.equal(controller.finished, settledRun);
  await settledRun;
  assert.deepEqual(environment.annotations.map(({ state }) => state), [
    'hidden', 'hidden', 'hidden',
  ]);
  const errorEvent = environment.events.filter(({ type }) => type === 'hana:error').at(-1);
  assert.equal(errorEvent.detail.index, 1);
  assert.equal(errorEvent.detail.error.code, 'HANA_STATE_GROUP_MEMBER');
  assert.equal(errorEvent.detail.error.details.error, cause);
});

test('pending async refresh failure rejects the existing run after every member refresh was attempted', async () => {
  const environment = fakeEnvironment();
  environment.useAsyncRefresh();
  const controller = createGroup(definitions(), {}, environment.env);
  controller.show();
  const run = controller.finished;
  environment.failRefreshAsync('third', new Error('async draw failed'));
  environment.calls.length = 0;

  controller.refresh();
  assert.equal(controller.finished, run);
  assert.equal(controller.state, 'showing');
  assert.deepEqual(
    environment.calls.filter(([name]) => name === 'annotation:refresh'),
    definitions().map(({ target }) => ['annotation:refresh', target]),
  );
  await environment.flushRefreshFrame();

  await assert.rejects(run, (error) => {
    assert.equal(error.code, 'HANA_STATE_GROUP_MEMBER');
    assert.equal(error.details.index, 2);
    return true;
  });
  assert.equal(controller.state, 'suspended');
  assert.equal(controller.finished, run);
});

test('async refresh failure ordering selects the lowest index after the observation window', async () => {
  const unhandled = [];
  const onUnhandled = (error) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const settled of [false, true]) {
      const environment = fakeEnvironment();
      environment.useAsyncRefresh();
      const controller = createGroup(definitions(), {}, environment.env);
      controller.show();
      const finished = controller.finished;
      if (settled) {
        for (const annotation of environment.annotations) annotation.finish();
        await finished;
      }
      const lateLow = new HanamaruTargetError('HANA_TARGET_MISSING', 'index zero');
      environment.failRefreshAsync('third', new Error('index two rejects first'));
      environment.failRefreshAsync('first', lateLow);

      controller.refresh();
      await environment.flushRefreshWrite('third');
      assert.equal(controller.state, settled ? 'visible' : 'showing');
      assert.equal(environment.events.filter(({ type }) => type === 'hana:error').length, 0);
      await environment.flushRefreshWrite('first');
      await environment.flushRefreshFrame();

      assert.equal(controller.state, 'suspended');
      assert.equal(controller.finished, finished);
      if (settled) await finished;
      else {
        await assert.rejects(finished, (error) => {
          assert.equal(error.code, 'HANA_STATE_GROUP_MEMBER');
          assert.equal(error.details.index, 0);
          assert.equal(error.details.error, lateLow);
          return true;
        });
      }
      const errors = environment.events.filter(({ type }) => type === 'hana:error');
      assert.equal(errors.length, 1);
      assert.equal(errors[0].detail.index, 0);
      assert.equal(errors[0].detail.error.details.error, lateLow);
      assert.deepEqual(environment.annotations.map(({ state }) => state), [
        'hidden', 'hidden', 'hidden',
      ]);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('requested-visible suspended refresh recovers only after every async member recovers', async () => {
  const environment = fakeEnvironment();
  environment.useAsyncRefresh();
  const controller = createGroup(definitions(), {}, environment.env);
  controller.show();
  for (const annotation of environment.annotations) annotation.finish();
  const settledRun = controller.finished;
  await settledRun;
  environment.failRefreshAsync('first', new Error('temporary loss'));
  controller.refresh();
  await environment.flushRefreshFrame();
  assert.equal(controller.state, 'suspended');

  environment.clearRefreshFailureAsync('first');
  const finishedIdentity = controller.finished;
  controller.refresh();
  assert.equal(controller.state, 'suspended');
  assert.equal(controller.finished, finishedIdentity);
  await environment.flushRefreshFrame();

  assert.equal(controller.state, 'visible');
  assert.equal(controller.finished, finishedIdentity);
  assert.equal(controller.finished, settledRun);
  assert.deepEqual(environment.annotations.map(({ state }) => state), [
    'visible', 'visible', 'visible',
  ]);
});

test('a superseded async refresh cannot overwrite a later hide or replay', async () => {
  const hideEnvironment = fakeEnvironment();
  hideEnvironment.useAsyncRefresh();
  const hideController = createGroup(definitions(), {}, hideEnvironment.env);
  hideController.show();
  for (const annotation of hideEnvironment.annotations) annotation.finish();
  await hideController.finished;
  hideEnvironment.failRefreshAsync('first', new Error('stale failure'));
  hideController.refresh();
  hideController.hide();
  await hideEnvironment.flushRefreshFrame();
  assert.equal(hideController.state, 'hidden');

  const replayEnvironment = fakeEnvironment();
  replayEnvironment.useAsyncRefresh();
  const replayController = createGroup(definitions(), {}, replayEnvironment.env);
  replayController.show();
  for (const annotation of replayEnvironment.annotations) annotation.finish();
  await replayController.finished;
  replayEnvironment.failRefreshAsync('second', new Error('stale replay failure'));
  replayController.refresh();
  replayEnvironment.clearRefreshFailureAsync('second');
  replayController.replay();
  const replayRun = replayController.finished;
  await replayEnvironment.flushRefreshFrame();
  assert.equal(replayController.state, 'showing');
  assert.equal(replayController.finished, replayRun);
});

test('an error listener can replay without stale member-failure cleanup winning', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), {}, environment.env);
  let replayed = false;
  environment.setEventHandler((event) => {
    if (event.type === 'hana:error' && !replayed) {
      replayed = true;
      controller.replay();
    }
  });
  controller.show();
  const failedRun = controller.finished;
  environment.annotations[2].fail(new Error('failed'));
  await assert.rejects(failedRun, HanamaruStateError);
  await flushMicrotasks();

  assert.equal(controller.state, 'showing');
  assert.notEqual(controller.finished, failedRun);
  assert.deepEqual(environment.annotations.map(({ state }) => state), [
    'showing', 'showing', 'showing',
  ]);
});

test('construction cleanup errors are contained behind the original failure', () => {
  const environment = fakeEnvironment();
  const original = new HanamaruTargetError('HANA_TARGET_INVALID', 'create failed');
  environment.failCreate(2, original);
  environment.failDestroy('second', new Error('cleanup failed'));
  environment.failDestroy('first', new Error('cleanup also failed'));

  assert.throws(
    () => createGroup(definitions(), {}, environment.env),
    (error) => error === original,
  );
  assert.equal(environment.liveLeases, 0);
  assert.equal(environment.outputs.size, 0);
  assert.deepEqual(
    environment.calls
      .filter(([name]) => name === 'annotation:destroy')
      .map(([, target]) => target),
    ['second', 'first'],
  );
});

test('destroy cleanup reports the first reverse-order failure and still destroys everything', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), {}, environment.env);
  environment.failDestroy('third', new Error('third cleanup'));
  environment.failDestroy('first', new Error('first cleanup'));
  controller.show();
  const run = controller.finished;

  assert.equal(controller.destroy(), controller);
  await assert.rejects(run, (error) => error?.name === 'AbortError');
  assert.equal(controller.state, 'destroyed');
  assert.deepEqual(environment.annotations.map(({ state }) => state), [
    'destroyed', 'destroyed', 'destroyed',
  ]);
  assert.equal(environment.outputs.size, 0);
  const errorEvent = environment.events.filter(({ type }) => type === 'hana:error').at(-1);
  assert.ok(errorEvent.detail.error instanceof HanamaruStateError);
  assert.equal(errorEvent.detail.error.code, 'HANA_STATE_RUNTIME');
  assert.equal(errorEvent.detail.error.details.cause.message, 'third cleanup');
  assert.equal(Object.hasOwn(errorEvent.detail, 'index'), false);
});

test('load trigger installs once, removes on acceptance, and starts only once', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), { trigger: 'load' }, environment.env);

  assert.equal(controller.state, 'idle');
  assert.equal(environment.listenerCount, 1);
  environment.fireDocument('DOMContentLoaded');
  assert.equal(environment.listenerCount, 0);
  assert.equal(controller.state, 'showing');
  assert.equal(
    environment.calls.filter(([name]) => name === 'annotation:show').length,
    definitions().length,
  );
  environment.fireDocument('DOMContentLoaded');
  assert.equal(
    environment.calls.filter(([name]) => name === 'annotation:show').length,
    definitions().length,
  );
  for (const annotation of environment.annotations) annotation.finish();
  await controller.finished;
  assert.equal(controller.state, 'visible');
});

test('load trigger is removed by manual acceptance, failure, and idempotent destroy', async () => {
  const manualEnvironment = fakeEnvironment();
  const manual = createGroup(definitions(), { trigger: 'load' }, manualEnvironment.env);
  manual.show();
  assert.equal(manualEnvironment.listenerCount, 0);

  const failureEnvironment = fakeEnvironment();
  const failed = createGroup(definitions(), { trigger: 'load' }, failureEnvironment.env);
  failureEnvironment.failResolve(
    'second',
    new HanamaruTargetError('HANA_TARGET_MISSING', 'gone before load'),
  );
  failureEnvironment.fireDocument('DOMContentLoaded');
  await assert.rejects(failed.finished, HanamaruStateError);
  assert.equal(failureEnvironment.listenerCount, 0);
  assert.equal(failed.state, 'suspended');

  const destroyEnvironment = fakeEnvironment();
  const destroyed = createGroup(definitions(), { trigger: 'load' }, destroyEnvironment.env);
  destroyed.destroy();
  destroyed.destroy();
  assert.equal(destroyEnvironment.listenerCount, 0);
  assert.equal(
    destroyEnvironment.calls.filter(([name]) => name === 'document:removeEventListener').length,
    1,
  );
  destroyEnvironment.fireDocument('DOMContentLoaded');
  await flushMicrotasks();
  assert.equal(
    destroyEnvironment.calls.some(([name]) => name === 'annotation:show'),
    false,
  );
});

test('load trigger microtask cannot start after destroy', async () => {
  const environment = fakeEnvironment({ readyState: 'complete' });
  const controller = createGroup(definitions(), { trigger: 'load' }, environment.env);
  controller.destroy();
  await flushMicrotasks();

  assert.equal(controller.state, 'destroyed');
  assert.equal(
    environment.calls.some(([name]) => name === 'annotation:show'),
    false,
  );
});

test('viewport trigger uses the first owner, exact root resources, and remains visible after exit', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), { trigger: 'viewport' }, environment.env);

  assert.equal(controller.state, 'idle');
  assert.equal(environment.triggerLeases, 1);
  assert.equal(environment.intersections.length, 1);
  const observer = environment.intersections[0];
  assert.equal(observer.target.target, 'first');
  assert.deepEqual(
    environment.calls.find(([name]) => name === 'acquireDocumentResources'),
    ['acquireDocumentResources', environment.root],
  );

  observer.onExit({ isIntersecting: false, intersectionRatio: 0 });
  assert.equal(controller.state, 'idle');
  observer.onEnter({ isIntersecting: true, intersectionRatio: 1 });
  assert.equal(observer.disconnects, 1);
  assert.equal(environment.triggerLeases, 0);
  assert.equal(controller.state, 'showing');
  observer.onEnter({ isIntersecting: true, intersectionRatio: 1 });
  assert.equal(
    environment.calls.filter(([name]) => name === 'annotation:show').length,
    definitions().length,
  );

  for (const annotation of environment.annotations) annotation.finish();
  await controller.finished;
  observer.onExit({ isIntersecting: false, intersectionRatio: 0 });
  assert.equal(controller.state, 'visible');
  assert.deepEqual(environment.annotations.map(({ state }) => state), [
    'visible', 'visible', 'visible',
  ]);
});

test('viewport trigger destroy-before-entry disconnects and releases idempotently', async () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), { trigger: 'viewport' }, environment.env);
  const observer = environment.intersections[0];

  controller.destroy();
  controller.destroy();
  assert.equal(observer.disconnects, 1);
  assert.equal(environment.triggerLeases, 0);
  observer.onEnter({ isIntersecting: true, intersectionRatio: 1 });
  await flushMicrotasks();
  assert.equal(controller.state, 'destroyed');
  assert.equal(
    environment.calls.some(([name]) => name === 'annotation:show'),
    false,
  );
});

test('viewport trigger installation failure rolls back annotations and resources', () => {
  const environment = fakeEnvironment();
  const cause = new Error('observer install failed');
  environment.failTriggerInstall(cause);

  assert.throws(
    () => createGroup(definitions(), { trigger: 'viewport' }, environment.env),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_RUNTIME'
      && error.details.cause === cause,
  );
  assert.equal(environment.triggerLeases, 0);
  assert.equal(environment.liveLeases, 0);
  assert.equal(environment.outputs.size, 0);
  assert.deepEqual(
    environment.calls
      .filter(([name]) => name === 'annotation:destroy')
      .map(([, target]) => target),
    ['third', 'second', 'first'],
  );
});

test('trigger cleanup failure is contained, fully releases, and reports one aggregate error', () => {
  const environment = fakeEnvironment();
  const controller = createGroup(definitions(), { trigger: 'viewport' }, environment.env);
  environment.failTriggerCleanup(new Error('disconnect failed'));

  controller.destroy();
  assert.equal(controller.state, 'destroyed');
  assert.equal(environment.triggerLeases, 0);
  assert.equal(environment.intersections[0].disconnects, 1);
  const errors = environment.events.filter(({ type }) => type === 'hana:error');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].detail.error instanceof HanamaruStateError);
  assert.equal(errors[0].detail.error.code, 'HANA_STATE_RUNTIME');
  assert.equal(Object.hasOwn(errors[0].detail, 'index'), false);
});
