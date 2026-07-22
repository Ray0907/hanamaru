import assert from 'node:assert/strict';
import test from 'node:test';

import * as annotationModule from '../../src/annotation.js';
import { HanamaruConfigError, HanamaruStateError } from '../../src/errors.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => {});
  return { promise, reject, resolve };
}

function fakeEnvironment({
  enqueueFailure = null,
  observeFailure = null,
  registerFailure = null,
  rebindFailure = null,
  resolveFailure = null,
  reducedMotion = false,
} = {}) {
  const calls = [];
  const events = [];
  const owner = { name: 'owner' };
  let currentResolveFailure = resolveFailure;
  let currentRebindFailure = rebindFailure;
  const record = {
    kind: 'element',
    element: owner,
    ownerElement: owner,
    refresh() {
      calls.push('resolve:refresh');
      if (currentResolveFailure !== null) throw currentResolveFailure;
      return this;
    },
  };
  let animation = null;
  let rendererFailure = null;
  const renderer = {
    group: {},
    noteElement: null,
    animate(duration) {
      calls.push(['animate', duration]);
      animation = deferred();
      if (duration === 0) animation.resolve();
      return { animations: [], finished: animation.promise };
    },
    destroy() { calls.push('renderer:destroy'); },
    draw(layout) {
      calls.push(['draw', layout]);
      if (rendererFailure !== null) throw rendererFailure;
    },
    finish() { calls.push('renderer:finish'); animation?.resolve(); },
    hide() { calls.push('renderer:hide'); animation?.reject(new DOMException('Animation cancelled', 'AbortError')); },
    measure() {
      return {
        noteRect: null,
        peerNoteRects: [],
        viewport: { width: 800, height: 600 },
      };
    },
    pause() { calls.push('renderer:pause'); },
    resume() { calls.push('renderer:resume'); },
    updateOwner(nextOwner) { calls.push(['renderer:updateOwner', nextOwner]); },
  };
  let generation = 0;
  let registered = false;
  let layout = null;
  const shared = {
    bumpGeneration() { generation += 1; return generation; },
    enqueue({ generation: candidate, read, write, onError }) {
      calls.push(['enqueue', candidate]);
      if (enqueueFailure !== null) throw enqueueFailure;
      try { write(read()); } catch (error) { onError?.(error); }
    },
    generationFor() { return generation; },
    observeLayout(binding) {
      layout = binding;
      calls.push('observeLayout');
      if (observeFailure !== null) throw observeFailure;
      return () => { layout = null; };
    },
    rebindLayout(_id, binding) {
      layout = binding;
      calls.push('rebindLayout');
      if (currentRebindFailure !== null) throw currentRebindFailure;
      return () => { layout = null; };
    },
    registerController() {
      calls.push('registerController');
      if (registerFailure !== null) throw registerFailure;
      registered = true;
      return generation;
    },
    releaseController() { registered = false; calls.push('releaseController'); },
  };
  const lease = { shared, release() { calls.push('lease:release'); } };

  return {
    calls,
    events,
    owner,
    record,
    renderer,
    lease,
    get animation() { return animation; },
    get layout() { return layout; },
    get registered() { return registered; },
    setResolveFailure(error) { currentResolveFailure = error; },
    setRendererFailure(error) { rendererFailure = error; },
    setRebindFailure(error) { currentRebindFailure = error; },
    env: {
      id: 'unit-annotation',
      createEvent(type, detail, eventOwner) { events.push({ type, detail, owner: eventOwner }); },
      createRenderer(args) { calls.push(['createRenderer', args]); return renderer; },
      lease,
      microtask(callback) { queueMicrotask(callback); },
      readThemeMetrics() { return { duration: 650, noteGap: 16 }; },
      resolveTarget(target) {
        calls.push('resolveTarget');
        if (currentResolveFailure !== null) throw currentResolveFailure;
        return target?.record ?? record;
      },
      reducedMotion() { return reducedMotion; },
      targetRects() {
        return [{ x: 10, y: 10, width: 100, height: 20, top: 10, right: 110, bottom: 30, left: 10 }];
      },
    },
  };
}

function create(options = {}, target = {}, environment = fakeEnvironment()) {
  const controller = annotationModule.createAnnotation(
    target,
    { mark: 'underline', duration: 650, ...options },
    environment.env,
  );
  return { controller, environment };
}

test('non-suspended transitions start idle with no finished promise and chain controls', () => {
  const { controller } = create();

  assert.equal(controller.state, 'idle');
  assert.equal(controller.finished, null);
  assert.equal(controller.hide(), controller);
  assert.equal(controller.show(), controller);
  assert.equal(controller.refresh(), controller);
  assert.equal(controller.update({ placement: 'left' }), controller);
  assert.equal(controller.replay(), controller);
  assert.equal(controller.destroy(), controller);
});

test('non-suspended transitions accept one show run and ignore duplicate show', async () => {
  const { controller, environment } = create();

  controller.show();
  const run = controller.finished;
  assert.ok(run instanceof Promise);
  controller.show();
  assert.equal(controller.finished, run);
  environment.animation.resolve();
  await run;
  assert.equal(controller.state, 'visible');
  controller.show();
  assert.equal(controller.finished, run);
});

test('AbortError rejects a showing run when hidden', async () => {
  const { controller } = create();
  controller.show();
  const run = controller.finished;

  controller.hide();

  await assert.rejects(run, (error) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(controller.state, 'hidden');
});

test('non-suspended transitions replay every live state with a fresh run', async () => {
  for (const startingState of ['idle', 'showing', 'visible', 'hidden']) {
    const { controller, environment } = create();
    if (startingState === 'showing' || startingState === 'visible') {
      controller.show();
      if (startingState === 'visible') {
        environment.animation.resolve();
        await controller.finished;
      }
    } else if (startingState === 'hidden') {
      controller.hide();
    }
    const previous = controller.finished;

    controller.replay();

    assert.notEqual(controller.finished, previous, startingState);
    assert.equal(controller.state, 'showing', startingState);
    controller.finished.catch(() => {});
    controller.destroy();
  }
});

test('non-suspended transitions preserve idle/hidden refresh and destroy idempotently', () => {
  for (const startingState of ['idle', 'hidden']) {
    const { controller, environment } = create();
    if (startingState === 'hidden') controller.hide();

    controller.refresh();

    assert.equal(controller.state, startingState);
    assert.equal(controller.finished, null);
    controller.destroy();
    controller.destroy();
    assert.equal(controller.state, 'destroyed');
    assert.equal(environment.calls.filter((call) => call === 'renderer:destroy').length, 1);
    assert.equal(environment.calls.filter((call) => call === 'releaseController').length, 1);
    assert.equal(environment.calls.filter((call) => call === 'lease:release').length, 1);
  }
});

test('suspended transitions remember requested visibility and recover without animation', async () => {
  for (const requested of [false, true]) {
    const { controller, environment } = create();
    if (requested) {
      controller.show();
      environment.animation.resolve();
      await controller.finished;
    }
    const failure = new Error('target disconnected');
    environment.setResolveFailure(failure);

    controller.refresh();

    assert.equal(controller.state, 'suspended');
    assert.ok(environment.calls.includes('renderer:hide'));
    environment.setResolveFailure(null);
    const animateCount = environment.calls.filter((call) => Array.isArray(call) && call[0] === 'animate').length;

    controller.refresh();

    assert.equal(controller.state, requested ? 'visible' : 'hidden');
    assert.equal(
      environment.calls.filter((call) => Array.isArray(call) && call[0] === 'animate').length,
      animateCount,
    );
    controller.destroy();
  }
});

test('suspended transitions reject a showing run and emit one error per disconnected episode', async () => {
  const { controller, environment } = create();
  controller.show();
  const run = controller.finished;
  const failure = new Error('target disconnected');
  environment.setResolveFailure(failure);

  controller.refresh();
  controller.refresh();

  await assert.rejects(run, (error) => error === failure);
  assert.equal(controller.state, 'suspended');
  assert.equal(environment.events.filter((event) => event.type === 'hana:error').length, 1);

  environment.setResolveFailure(null);
  controller.refresh();
  environment.setResolveFailure(new Error('disconnected again'));
  controller.refresh();
  assert.equal(environment.events.filter((event) => event.type === 'hana:error').length, 2);
  controller.destroy();
});

test('suspended transitions show retries resolution with a newly rejected or successful run', async () => {
  const failure = new Error('missing target');
  const environment = fakeEnvironment({ resolveFailure: failure });
  assert.throws(
    () => create({}, {}, environment),
    (error) => error === failure,
    'construction still resolves before mounting',
  );

  const created = create();
  created.environment.setResolveFailure(failure);
  created.controller.refresh();
  assert.equal(created.controller.state, 'suspended');

  created.controller.show();
  const rejected = created.controller.finished;
  assert.ok(rejected instanceof Promise);
  await assert.rejects(rejected, (error) => error === failure);
  assert.equal(created.controller.state, 'suspended');

  created.environment.setResolveFailure(null);
  created.controller.show();
  const successful = created.controller.finished;
  assert.notEqual(successful, rejected);
  assert.equal(created.controller.state, 'showing');
  created.environment.animation.resolve();
  await successful;
  assert.equal(created.controller.state, 'visible');
  created.controller.destroy();
});

test('suspended transitions hide clears requested visibility', async () => {
  const { controller, environment } = create();
  controller.show();
  environment.animation.resolve();
  await controller.finished;
  environment.setResolveFailure(new Error('disconnected'));
  controller.refresh();
  assert.equal(controller.state, 'suspended');

  controller.hide();

  assert.equal(controller.state, 'hidden');
  environment.setResolveFailure(null);
  controller.refresh();
  assert.equal(controller.state, 'hidden');
  controller.destroy();
});

test('suspended transitions replay creates a fresh rejected or recoverable run', async () => {
  const { controller, environment } = create();
  const failure = new Error('still disconnected');
  environment.setResolveFailure(failure);
  controller.refresh();
  const previous = controller.finished;

  controller.replay();

  const rejected = controller.finished;
  assert.notEqual(rejected, previous);
  await assert.rejects(rejected, (error) => error === failure);
  assert.equal(controller.state, 'suspended');
  environment.setResolveFailure(null);
  controller.replay();
  const recovered = controller.finished;
  assert.notEqual(recovered, rejected);
  environment.animation.resolve();
  await recovered;
  assert.equal(controller.state, 'visible');
  controller.destroy();
});

test('refresh during showing finishes the same run while idle and hidden remain unchanged', async () => {
  const { controller } = create();
  controller.show();
  const run = controller.finished;

  controller.refresh();

  assert.equal(controller.finished, run);
  await run;
  assert.equal(controller.state, 'visible');

  const hidden = create();
  hidden.controller.hide().refresh();
  assert.equal(hidden.controller.state, 'hidden');
  assert.equal(hidden.controller.finished, null);
  hidden.controller.destroy();
  controller.destroy();
});

test('update validates target and options atomically before changing a visible annotation', async () => {
  const { controller, environment } = create();
  controller.show();
  environment.animation.resolve();
  await controller.finished;
  const run = controller.finished;
  const callsBefore = environment.calls.length;

  assert.throws(
    () => controller.update({ mark: 'not-a-mark', target: { record: { ownerElement: { name: 'wrong' } } } }),
    HanamaruConfigError,
  );

  assert.equal(controller.state, 'visible');
  assert.equal(controller.finished, run);
  assert.equal(environment.calls.length, callsBefore);
  controller.refresh();
  assert.equal(controller.state, 'visible');
  controller.destroy();
});

test('update while showing preserves and completes the run with a new owner and options', async () => {
  const { controller, environment } = create();
  controller.show();
  const run = controller.finished;
  const nextOwner = { name: 'next-owner' };
  const nextRecord = {
    kind: 'range', element: null, range: {}, ownerElement: nextOwner, refresh() { return this; },
  };

  controller.update({ target: { record: nextRecord }, mark: 'circle', note: 'new note' });

  assert.equal(controller.finished, run);
  await run;
  assert.equal(controller.state, 'visible');
  const rendererCreations = environment.calls.filter((call) => Array.isArray(call) && call[0] === 'createRenderer');
  assert.equal(rendererCreations.length, 2);
  assert.equal(rendererCreations[1][1].record, nextRecord);
  assert.equal(rendererCreations[1][1].options.mark, 'circle');
  assert.equal(rendererCreations[1][1].options.note, 'new note');
  assert.equal(rendererCreations[1][1].record.ownerElement, nextOwner);
  controller.destroy();
});

test('update while visible redraws final state without creating a run promise', async () => {
  const { controller, environment } = create();
  controller.show();
  environment.animation.resolve();
  await controller.finished;
  const run = controller.finished;
  const animateCount = environment.calls.filter((call) => Array.isArray(call) && call[0] === 'animate').length;

  controller.update({ placement: 'bottom' });

  assert.equal(controller.finished, run);
  assert.equal(controller.state, 'visible');
  assert.equal(
    environment.calls.filter((call) => Array.isArray(call) && call[0] === 'animate').length,
    animateCount,
  );
  controller.destroy();
});

test('update while suspended preserves requested visibility and recovers with a replacement Range', async () => {
  const { controller, environment } = create();
  controller.show();
  environment.animation.resolve();
  await controller.finished;
  environment.setResolveFailure(new Error('old target gone'));
  controller.refresh();
  assert.equal(controller.state, 'suspended');
  const owner = { name: 'range-owner' };
  const rangeRecord = {
    kind: 'range', element: null, range: { native: true }, ownerElement: owner, refresh() { return this; },
  };
  environment.setResolveFailure(null);

  controller.update({ target: { record: rangeRecord } });

  assert.equal(controller.state, 'visible');
  const rendererCreations = environment.calls.filter((call) => Array.isArray(call) && call[0] === 'createRenderer');
  assert.equal(rendererCreations.at(-1)[1].record.ownerElement, owner);
  controller.destroy();
});

test('unexpected renderer failure becomes HanamaruStateError and suspends', async () => {
  const { controller, environment } = create();
  const cause = new Error('renderer exploded');
  environment.setRendererFailure(cause);

  controller.show();

  await assert.rejects(controller.finished, (error) => (
    error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_RUNTIME'
      && error.details.cause === cause
  ));
  assert.equal(controller.state, 'suspended');
  const errors = environment.events.filter((event) => event.type === 'hana:error');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].detail.error instanceof HanamaruStateError);
  controller.destroy();
});

test('unexpected asynchronous motion failure becomes HanamaruStateError and suspends', async () => {
  const { controller, environment } = create();
  const cause = new Error('motion exploded');
  controller.show();

  environment.animation.reject(cause);

  await assert.rejects(controller.finished, (error) => (
    error instanceof HanamaruStateError && error.details.cause === cause
  ));
  assert.equal(controller.state, 'suspended');
  assert.equal(environment.events.filter((event) => event.type === 'hana:error').length, 1);
  controller.destroy();
});

test('construction releases registered resources and mounted renderer if layout binding fails', () => {
  const failure = new Error('observer failed');
  const environment = fakeEnvironment({ observeFailure: failure });

  assert.throws(() => create({}, {}, environment), (error) => error === failure);

  assert.equal(environment.calls.filter((call) => call === 'renderer:destroy').length, 1);
  assert.equal(environment.calls.filter((call) => call === 'releaseController').length, 1);
  assert.equal(environment.calls.filter((call) => call === 'lease:release').length, 1);
  assert.equal(environment.registered, false);
});

test('private pause and resume helpers control only the active renderer', () => {
  const { controller, environment } = create();
  controller.show();

  annotationModule.pauseAnnotationRun(controller);
  annotationModule.resumeAnnotationRun(controller);
  controller.destroy();
  annotationModule.pauseAnnotationRun(controller);
  annotationModule.resumeAnnotationRun(controller);

  assert.equal(environment.calls.filter((call) => call === 'renderer:pause').length, 1);
  assert.equal(environment.calls.filter((call) => call === 'renderer:resume').length, 1);
});

test('unexpected scheduler enqueue failure rejects the run as HanamaruStateError without throwing', async () => {
  const cause = new Error('scheduler enqueue failed');
  const environment = fakeEnvironment({ enqueueFailure: cause });
  const { controller } = create({}, {}, environment);

  assert.doesNotThrow(() => controller.show());

  await assert.rejects(controller.finished, (error) => (
    error instanceof HanamaruStateError && error.details.cause === cause
  ));
  assert.equal(controller.state, 'suspended');
  assert.equal(environment.events.filter((event) => event.type === 'hana:error').length, 1);
  controller.destroy();
});

test('controller registration failure releases the lazily acquired document lease', () => {
  const failure = new Error('registration failed');
  const environment = fakeEnvironment({ registerFailure: failure });

  assert.throws(() => create({}, {}, environment), (error) => error === failure);

  assert.equal(environment.calls.filter((call) => call === 'lease:release').length, 1);
  assert.equal(environment.calls.filter((call) => Array.isArray(call) && call[0] === 'createRenderer').length, 0);
});

test('failed update rebind rolls target and options back before suspending', async () => {
  const { controller, environment } = create();
  controller.show();
  environment.animation.resolve();
  await controller.finished;
  const nextRecord = {
    kind: 'element',
    element: { name: 'next' },
    ownerElement: { name: 'next' },
    refresh() { return this; },
  };
  const failure = new Error('rebind failed');
  environment.setRebindFailure(failure);

  controller.update({ target: { record: nextRecord }, mark: 'circle' });

  assert.equal(controller.state, 'suspended');
  assert.ok(environment.events.at(-1).detail.error instanceof HanamaruStateError);
  environment.setRebindFailure(null);
  controller.refresh();
  assert.equal(controller.state, 'visible');
  const lastDraw = environment.calls.filter((call) => Array.isArray(call) && call[0] === 'draw').at(-1);
  assert.equal(lastDraw[1].markPaths.length, 1, 'the original underline options are retained');
  controller.destroy();
});

test('unexpected refresh rebind failure is contained as HanamaruStateError', async () => {
  const { controller, environment } = create();
  controller.show();
  environment.animation.resolve();
  await controller.finished;
  const failure = new Error('refresh rebind failed');
  environment.setRebindFailure(failure);

  assert.doesNotThrow(() => controller.refresh());

  assert.equal(controller.state, 'suspended');
  const error = environment.events.at(-1).detail.error;
  assert.ok(error instanceof HanamaruStateError);
  assert.equal(error.details.cause, failure);
  environment.setRebindFailure(null);
  controller.destroy();
});

test('unexpected replay rebind failure creates and rejects the new run without throwing', async () => {
  const { controller, environment } = create();
  const failure = new Error('replay rebind failed');
  environment.setRebindFailure(failure);

  assert.doesNotThrow(() => controller.replay());

  assert.ok(controller.finished instanceof Promise);
  await assert.rejects(controller.finished, (error) => (
    error instanceof HanamaruStateError && error.details.cause === failure
  ));
  assert.equal(controller.state, 'suspended');
  environment.setRebindFailure(null);
  controller.destroy();
});
