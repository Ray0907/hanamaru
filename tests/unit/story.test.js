import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HanamaruConfigError,
  HanamaruStateError,
  HanamaruTargetError,
} from '../../src/errors.js';
import { createStory } from '../../src/story.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => {});
  return { promise, reject, resolve, settled: false };
}

function fakeEnvironment({ reducedMotion = false } = {}) {
  const calls = [];
  const events = [];
  const annotations = [];
  const failures = new Map();
  const destroyFailures = new Map();
  const refreshedOwners = new Map();
  let clock = 0;
  let nextTimer = 0;
  const timers = new Map();
  let eventHandler = null;
  let annotationHandler = null;
  let createFailure = null;

  function makeAnnotation(target, options) {
    calls.push(['createAnnotation', target]);
    if (createFailure?.index === annotations.length) throw createFailure.error;
    let state = 'idle';
    let run = null;
    const annotation = {
      target,
      options,
      get state() { return state; },
      get finished() { return run?.promise ?? null; },
      show() {
        calls.push(['annotation:show', target]);
        if (state === 'showing' || state === 'visible') return annotation;
        run = deferred();
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
        if (run !== null && !run.settled) {
          run.settled = true;
          run.reject(new DOMException('Annotation hidden', 'AbortError'));
        }
        state = 'hidden';
        annotationHandler?.('hide', annotation);
        return annotation;
      },
      destroy() {
        calls.push(['annotation:destroy', target]);
        annotation.hide();
        state = 'destroyed';
        if (destroyFailures.has(target)) throw destroyFailures.get(target);
        return annotation;
      },
    };
    annotations.push(annotation);
    return annotation;
  }

  const environment = {
    calls,
    events,
    annotations,
    setAnnotationHandler(handler) { annotationHandler = handler; },
    setEventHandler(handler) { eventHandler = handler; },
    failCreate(index, error) { createFailure = { index, error }; },
    failDestroy(target, error) { destroyFailures.set(target, error); },
    failTarget(target, error) { failures.set(target, error); },
    refreshOwner(target, owner) { refreshedOwners.set(target, owner); },
    clearTargetFailure(target) { failures.delete(target); },
    advance(milliseconds) {
      const end = clock + milliseconds;
      while (true) {
        const pending = [...timers.entries()]
          .filter(([, timer]) => timer.due <= end)
          .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
        if (pending === undefined) break;
        const [id, timer] = pending;
        timers.delete(id);
        clock = timer.due;
        timer.callback();
      }
      clock = end;
    },
    get timerCount() { return timers.size; },
    env: {
      recordMetadata: false,
      clearTimeout(id) { timers.delete(id); },
      createAnnotation: makeAnnotation,
      createEvent(type, detail, owner) {
        const event = { type, detail, owner };
        events.push(event);
        eventHandler?.(event);
      },
      now() { return clock; },
      pauseAnnotationRun(annotation) { calls.push(['annotation:pause', annotation.target]); },
      reducedMotion() { return reducedMotion; },
      resolveTarget(target) {
        calls.push(['resolveTarget', target]);
        if (failures.has(target)) throw failures.get(target);
        return {
          ownerElement: { target },
          refresh() {
            calls.push(['record:refresh', target]);
            if (failures.has(target)) throw failures.get(target);
            if (refreshedOwners.has(target)) this.ownerElement = refreshedOwners.get(target);
            return this;
          },
        };
      },
      resumeAnnotationRun(annotation) { calls.push(['annotation:resume', annotation.target]); },
      setTimeout(callback, milliseconds) {
        const id = ++nextTimer;
        timers.set(id, { callback, due: clock + milliseconds });
        return id;
      },
    },
  };
  return environment;
}

function steps() {
  return [
    { target: 'first', mark: 'circle' },
    { target: 'second', mark: 'highlight', note: 'Next' },
  ];
}

async function flushMicrotasks(turns = 4) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

test('story construction validates every target before mounting annotations', () => {
  const environment = fakeEnvironment();

  createStory(steps(), {}, environment.env);

  assert.deepEqual(environment.calls.slice(0, 2), [
    ['resolveTarget', 'first'],
    ['resolveTarget', 'second'],
  ]);
  assert.equal(environment.annotations.length, 2);
  assert.deepEqual(environment.calls.slice(2), [
    ['createAnnotation', 'first'],
    ['createAnnotation', 'second'],
  ]);
  assert.deepEqual(environment.annotations.map(({ options }) => options), [
    {
      mark: 'circle', note: null, placement: 'auto', trigger: 'manual',
      accessible: false, duration: 650, motion: 'system',
    },
    {
      mark: 'highlight', note: 'Next', placement: 'auto', trigger: 'manual',
      accessible: false, duration: 650, motion: 'system',
    },
  ]);
});

test('story construction rejects a bad final target without mounting a partial story', () => {
  const environment = fakeEnvironment();
  const error = new HanamaruTargetError('HANA_TARGET_MISSING', 'Missing target');
  environment.failTarget('second', error);

  assert.throws(() => createStory(steps(), {}, environment.env), (thrown) => thrown === error);
  assert.equal(environment.annotations.length, 0);
});

test('story construction failure rolls created annotations back in input order', () => {
  const environment = fakeEnvironment();
  const cause = new Error('third annotation failed');
  environment.failCreate(2, cause);
  const definitions = [
    { target: 'first', mark: 'underline' },
    { target: 'second', mark: 'circle' },
    { target: 'third', mark: 'box' },
  ];

  assert.throws(
    () => createStory(definitions, {}, environment.env),
    (error) => error === cause,
  );
  assert.deepEqual(
    environment.calls
      .filter(([name]) => name === 'annotation:destroy')
      .map(([, target]) => target),
    ['first', 'second'],
  );
});

test('story trigger setup failure tears annotations down in input order', () => {
  const environment = fakeEnvironment();
  const cause = new Error('trigger setup failed');
  environment.env.document = {
    readyState: 'loading',
    addEventListener() { throw cause; },
  };
  environment.env.microtask = (callback) => queueMicrotask(callback);
  const definitions = [
    { target: 'first', mark: 'underline' },
    { target: 'second', mark: 'circle' },
    { target: 'third', mark: 'box' },
  ];

  assert.throws(
    () => createStory(definitions, { trigger: 'load' }, environment.env),
    (error) => error instanceof HanamaruStateError
      && error.details.cause === cause,
  );
  assert.deepEqual(
    environment.calls
      .filter(([name]) => name === 'annotation:destroy')
      .map(([, target]) => target),
    ['first', 'second', 'third'],
  );
});

test('story construction rejects malformed and unknown story input', () => {
  const invalidInputs = [
    [null, {}],
    [[], {}],
    [[null], {}],
    [[{ target: 'first', mark: 'circle', surprise: true }], {}],
    [steps(), null],
    [steps(), { surprise: true }],
    [steps(), { trigger: 'later' }],
    [steps(), { gap: -1 }],
    [steps(), { gap: 1.5 }],
    [steps(), { motion: 'always' }],
  ];

  for (const [storySteps, options] of invalidInputs) {
    const environment = fakeEnvironment();
    assert.throws(
      () => createStory(storySteps, options, environment.env),
      HanamaruConfigError,
      JSON.stringify([storySteps, options]),
    );
    assert.equal(environment.annotations.length, 0);
  }
});

test('story construction rejects step trigger and motion ownership', () => {
  for (const forbidden of [{ trigger: 'manual' }, { motion: 'never' }]) {
    const environment = fakeEnvironment();
    assert.throws(
      () => createStory([{ target: 'first', mark: 'circle', ...forbidden }], {}, environment.env),
      HanamaruConfigError,
    );
    assert.equal(environment.annotations.length, 0);
  }
});

test('story construction only accepts once for viewport and defaults it to true', () => {
  for (const trigger of ['manual', 'load']) {
    const environment = fakeEnvironment();
    assert.throws(() => createStory(steps(), { trigger, once: true }, environment.env), HanamaruConfigError);
    assert.equal(environment.annotations.length, 0);
  }

  const defaultViewport = fakeEnvironment();
  createStory(steps(), { trigger: 'viewport' }, defaultViewport.env);
  assert.equal(defaultViewport.annotations.length, 2);

  const repeatingViewport = fakeEnvironment();
  createStory(steps(), { trigger: 'viewport', once: false }, repeatingViewport.env);
  assert.equal(repeatingViewport.annotations.length, 2);
});

test('story construction applies one motion policy while keeping every annotation manual', () => {
  const environment = fakeEnvironment();
  createStory(steps(), {
    trigger: 'viewport', once: false, gap: 0, motion: 'never',
  }, environment.env);

  assert.deepEqual(
    environment.annotations.map(({ options }) => [options.trigger, options.motion]),
    [['manual', 'never'], ['manual', 'never']],
  );
});

test('play sequence advances in order and resolves at complete', async () => {
  const environment = fakeEnvironment();
  const story = createStory(steps(), {}, environment.env);

  assert.equal(story.state, 'idle');
  assert.equal(story.finished, null);
  assert.equal(story.play(), story);
  const run = story.finished;
  assert.ok(run instanceof Promise);
  assert.equal(story.state, 'playing');
  assert.equal(story.play(), story);
  assert.equal(story.finished, run);
  assert.deepEqual(environment.annotations.map(({ state }) => state), ['showing', 'idle']);

  const [start, firstStep] = environment.events;
  assert.equal(start.type, 'hana:start');
  assert.deepEqual(start.detail, { controller: story, state: 'playing' });
  assert.equal(start.owner.target, 'first');
  assert.equal(firstStep.type, 'hana:step');
  assert.deepEqual(firstStep.detail, {
    controller: story,
    index: 0,
    total: 2,
    annotation: environment.annotations[0],
  });

  environment.annotations[0].finish();
  await flushMicrotasks();
  assert.equal(environment.timerCount, 1);
  assert.deepEqual(environment.annotations.map(({ state }) => state), ['visible', 'idle']);
  environment.advance(179);
  assert.equal(environment.annotations[1].state, 'idle');
  environment.advance(1);
  assert.equal(environment.annotations[1].state, 'showing');

  environment.annotations[1].finish();
  await run;
  assert.equal(story.state, 'complete');
  assert.deepEqual(environment.events.map(({ type }) => type), [
    'hana:start', 'hana:step', 'hana:step', 'hana:complete',
  ]);
  assert.deepEqual(environment.events.at(-1).detail, { controller: story, state: 'complete' });
});

test('play refreshes the first target once before start and dispatches from its current owner', () => {
  const environment = fakeEnvironment();
  const currentOwner = { target: 'replacement-first' };
  const story = createStory(steps(), {}, environment.env);
  environment.refreshOwner('first', currentOwner);
  environment.calls.length = 0;

  story.play();

  assert.deepEqual(environment.events.slice(0, 2).map(({ type, owner }) => [type, owner]), [
    ['hana:start', currentOwner],
    ['hana:step', currentOwner],
  ]);
  assert.equal(
    environment.calls.filter(([name, target]) => name === 'record:refresh' && target === 'first').length,
    1,
  );
  assert.deepEqual(environment.calls.slice(0, 2), [
    ['record:refresh', 'first'],
    ['annotation:show', 'first'],
  ]);

  story.cancel();
  const replayOwner = { target: 'replay-first' };
  environment.refreshOwner('first', replayOwner);
  environment.calls.length = 0;
  environment.events.length = 0;
  story.replay();
  assert.deepEqual(environment.events.slice(0, 2).map(({ type, owner }) => [type, owner]), [
    ['hana:start', replayOwner],
    ['hana:step', replayOwner],
  ]);
  assert.equal(
    environment.calls.filter(([name, target]) => name === 'record:refresh' && target === 'first').length,
    1,
  );
});

test('gaps use the configured non-negative duration', async () => {
  const environment = fakeEnvironment();
  const story = createStory(steps(), { gap: 42 }, environment.env);
  story.play();
  environment.annotations[0].finish();
  await flushMicrotasks();

  environment.advance(41);
  assert.equal(environment.annotations[1].state, 'idle');
  environment.advance(1);
  assert.equal(environment.annotations[1].state, 'showing');
});

test('reduced motion removes story gaps while preserving event order', async () => {
  const environment = fakeEnvironment({ reducedMotion: true });
  const story = createStory(steps(), { gap: 999 }, environment.env);
  story.play();

  environment.annotations[0].finish();
  await flushMicrotasks();

  assert.equal(environment.timerCount, 0);
  assert.equal(environment.annotations[1].state, 'showing');
  assert.deepEqual(environment.events.map(({ type }) => type), [
    'hana:start', 'hana:step', 'hana:step',
  ]);
});

test('pause and resume suspend the active annotation and chain as no-ops elsewhere', () => {
  const environment = fakeEnvironment();
  const story = createStory(steps(), {}, environment.env);

  assert.equal(story.pause(), story);
  assert.equal(story.resume(), story);
  assert.equal(story.cancel(), story);
  assert.equal(story.state, 'idle');
  story.play();
  const run = story.finished;

  assert.equal(story.pause(), story);
  assert.equal(story.state, 'paused');
  assert.equal(story.finished, run);
  assert.deepEqual(environment.calls.at(-1), ['annotation:pause', 'first']);
  assert.deepEqual(environment.events.at(-1), {
    type: 'hana:pause',
    detail: { controller: story, index: 0 },
    owner: environment.events[0].owner,
  });
  const pauseCalls = environment.calls.length;
  story.pause();
  assert.equal(environment.calls.length, pauseCalls);

  assert.equal(story.resume(), story);
  assert.equal(story.state, 'playing');
  assert.deepEqual(environment.calls.at(-1), ['annotation:resume', 'first']);
  const resumeCalls = environment.calls.length;
  story.resume();
  assert.equal(environment.calls.length, resumeCalls);
});

test('pause freezes an elapsed gap and resume schedules only the remainder', async () => {
  const environment = fakeEnvironment();
  const story = createStory(steps(), { gap: 180 }, environment.env);
  story.play();
  environment.annotations[0].finish();
  await flushMicrotasks();

  environment.advance(50);
  story.pause();
  assert.equal(story.state, 'paused');
  assert.equal(environment.timerCount, 0);
  assert.equal(environment.events.at(-1).detail.index, 0);
  assert.equal(environment.calls.some(([name]) => name === 'annotation:pause'), false);
  environment.advance(1_000);
  assert.equal(environment.annotations[1].state, 'idle');

  story.resume();
  assert.equal(environment.timerCount, 1);
  environment.advance(129);
  assert.equal(environment.annotations[1].state, 'idle');
  environment.advance(1);
  assert.equal(environment.annotations[1].state, 'showing');
});

test('an annotation that completes while paused continues from the gap on resume', async () => {
  const environment = fakeEnvironment();
  const story = createStory(steps(), { gap: 25 }, environment.env);
  story.play().pause();
  environment.annotations[0].finish();
  await flushMicrotasks();

  assert.equal(story.state, 'paused');
  assert.equal(environment.timerCount, 0);
  story.resume();
  assert.equal(environment.timerCount, 1);
  environment.advance(25);
  assert.equal(environment.annotations[1].state, 'showing');
});

test('cancel aborts an active run, hides only the incomplete mark, and retains completed marks', async () => {
  const activeEnvironment = fakeEnvironment();
  const activeStory = createStory(steps(), {}, activeEnvironment.env);
  activeStory.play();
  const activeRun = activeStory.finished;
  assert.equal(activeStory.cancel(), activeStory);
  await assert.rejects(activeRun, (error) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(activeStory.state, 'cancelled');
  assert.deepEqual(activeEnvironment.annotations.map(({ state }) => state), ['hidden', 'idle']);
  assert.equal(activeEnvironment.events.at(-1).type, 'hana:cancel');
  assert.equal(activeEnvironment.events.at(-1).detail.reason, 'cancel');

  const gapEnvironment = fakeEnvironment();
  const gapStory = createStory(steps(), {}, gapEnvironment.env);
  gapStory.play();
  gapEnvironment.annotations[0].finish();
  await flushMicrotasks();
  const gapRun = gapStory.finished;
  gapStory.cancel();
  await assert.rejects(gapRun, (error) => error?.name === 'AbortError');
  assert.deepEqual(gapEnvironment.annotations.map(({ state }) => state), ['visible', 'idle']);
});

test('replay aborts a pending run, clears all marks, preflights every target, and starts at zero', async () => {
  const environment = fakeEnvironment();
  const story = createStory(steps(), {}, environment.env);
  story.play();
  const firstRun = story.finished;
  environment.calls.length = 0;

  assert.equal(story.replay(), story);
  await assert.rejects(firstRun, (error) => error instanceof DOMException && error.name === 'AbortError');
  const replayRun = story.finished;
  assert.notEqual(replayRun, firstRun);
  assert.equal(story.state, 'playing');
  assert.deepEqual(environment.calls.slice(0, 5), [
    ['annotation:hide', 'first'],
    ['annotation:hide', 'second'],
    ['record:refresh', 'first'],
    ['record:refresh', 'second'],
    ['annotation:show', 'first'],
  ]);
  assert.deepEqual(environment.annotations.map(({ state }) => state), ['showing', 'hidden']);
  assert.equal(environment.events.filter(({ type }) => type === 'hana:cancel').at(-1).detail.reason, 'replay');
});

test('replay is accepted from every non-destroyed story state', async () => {
  for (const desiredState of ['idle', 'playing', 'paused', 'complete', 'cancelled']) {
    const environment = fakeEnvironment({ reducedMotion: true });
    const story = createStory(steps(), {}, environment.env);
    if (desiredState !== 'idle') story.play();
    if (desiredState === 'paused') story.pause();
    if (desiredState === 'complete') {
      environment.annotations[0].finish();
      await flushMicrotasks();
      environment.annotations[1].finish();
      await story.finished;
    }
    if (desiredState === 'cancelled') story.cancel();
    assert.equal(story.state, desiredState);
    const previous = story.finished;

    assert.equal(story.replay(), story);
    assert.equal(story.state, 'playing');
    assert.ok(story.finished instanceof Promise);
    assert.notEqual(story.finished, previous, desiredState);
  }
});

test('destroy aborts once, clears timers, destroys annotations, and makes controls no-ops', async () => {
  const environment = fakeEnvironment();
  const story = createStory(steps(), {}, environment.env);
  story.play();
  const run = story.finished;

  assert.equal(story.destroy(), story);
  await assert.rejects(run, (error) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(story.state, 'destroyed');
  assert.equal(environment.timerCount, 0);
  assert.deepEqual(environment.annotations.map(({ state }) => state), ['destroyed', 'destroyed']);
  const calls = environment.calls.length;
  const finished = story.finished;
  for (const method of ['play', 'pause', 'resume', 'cancel', 'replay', 'destroy']) {
    assert.equal(story[method](), story);
  }
  assert.equal(environment.calls.length, calls);
  assert.equal(story.finished, finished);
});

test('destroy reports the lowest failing input index and still tears down forward', () => {
  const environment = fakeEnvironment();
  const definitions = [
    { target: 'first', mark: 'underline' },
    { target: 'second', mark: 'circle' },
    { target: 'third', mark: 'box' },
  ];
  const firstCause = new Error('first destroy failed');
  const thirdCause = new Error('third destroy failed');
  const story = createStory(definitions, {}, environment.env);
  environment.failDestroy('first', firstCause);
  environment.failDestroy('third', thirdCause);
  environment.calls.length = 0;

  assert.equal(story.destroy(), story);

  assert.deepEqual(
    environment.calls
      .filter(([name]) => name === 'annotation:destroy')
      .map(([, target]) => target),
    ['first', 'second', 'third'],
  );
  assert.deepEqual(environment.annotations.map(({ state }) => state), [
    'destroyed', 'destroyed', 'destroyed',
  ]);
  const event = environment.events.at(-1);
  assert.equal(event.type, 'hana:error');
  assert.equal(event.detail.index, 0);
  assert.ok(event.detail.error instanceof HanamaruStateError);
  assert.equal(event.detail.error.details.cause, firstCause);
});

test('current target loss cancels with its typed error and leaves every mark untouched', async () => {
  const environment = fakeEnvironment();
  const story = createStory(steps(), {}, environment.env);
  const error = new HanamaruTargetError('HANA_TARGET_MISSING', 'Gone');
  environment.failTarget('first', error);

  story.play();
  const run = story.finished;
  assert.equal(story.state, 'cancelled');
  await assert.rejects(run, (thrown) => thrown === error);
  assert.deepEqual(environment.annotations.map(({ state }) => state), ['idle', 'idle']);
  assert.equal(environment.timerCount, 0);
  assert.deepEqual(environment.events.map(({ type }) => type), ['hana:error']);
  assert.deepEqual(environment.events.at(-1).detail, { controller: story, error, index: 0 });
});

test('future target loss retains completed marks and never shows the failed step', async () => {
  const environment = fakeEnvironment();
  const story = createStory(steps(), { gap: 20 }, environment.env);
  const error = new HanamaruTargetError('HANA_TARGET_INVALID', 'Disconnected');
  story.play();
  const run = story.finished;
  environment.annotations[0].finish();
  await flushMicrotasks();
  environment.failTarget('second', error);
  environment.advance(20);

  assert.equal(story.state, 'cancelled');
  await assert.rejects(run, (thrown) => thrown === error);
  assert.deepEqual(environment.annotations.map(({ state }) => state), ['visible', 'idle']);
  assert.deepEqual(environment.events.at(-1).detail, { controller: story, error, index: 1 });
});

test('renderer loss is normalized to HanamaruStateError and retains earlier marks', async () => {
  const environment = fakeEnvironment({ reducedMotion: true });
  const story = createStory(steps(), {}, environment.env);
  const cause = new Error('renderer exploded');
  story.play();
  const run = story.finished;
  environment.annotations[0].finish();
  await flushMicrotasks();
  environment.annotations[1].fail(cause);

  await assert.rejects(run, (error) => {
    assert.ok(error instanceof HanamaruStateError);
    assert.equal(error.code, 'HANA_STATE_RUNTIME');
    assert.equal(error.details.cause, cause);
    return true;
  });
  assert.equal(story.state, 'cancelled');
  assert.deepEqual(environment.annotations.map(({ state }) => state), ['visible', 'hidden']);
  assert.equal(environment.events.at(-1).detail.index, 1);
  assert.ok(environment.events.at(-1).detail.error instanceof HanamaruStateError);
});

test('replay clears marks but atomically rejects target loss before creating a run', async () => {
  const environment = fakeEnvironment({ reducedMotion: true });
  const story = createStory(steps(), {}, environment.env);
  story.play();
  environment.annotations[0].finish();
  await flushMicrotasks();
  environment.annotations[1].finish();
  await story.finished;
  const completedRun = story.finished;
  const starts = environment.events.filter(({ type }) => type === 'hana:start').length;
  const error = new HanamaruTargetError('HANA_TARGET_MISSING', 'Gone on replay');
  environment.failTarget('second', error);

  assert.throws(() => story.replay(), (thrown) => thrown === error);
  assert.equal(story.state, 'cancelled');
  assert.equal(story.finished, completedRun);
  assert.deepEqual(environment.annotations.map(({ state }) => state), ['hidden', 'hidden']);
  assert.equal(environment.events.filter(({ type }) => type === 'hana:start').length, starts);
  assert.deepEqual(environment.events.at(-1).detail, { controller: story, error, index: 1 });
});

test('a synchronous start listener can cancel without a stale step starting', async () => {
  const environment = fakeEnvironment();
  const story = createStory(steps(), {}, environment.env);
  environment.setEventHandler((event) => {
    if (event.type === 'hana:start') story.cancel();
  });

  story.play();
  await assert.rejects(story.finished, (error) => error?.name === 'AbortError');
  assert.equal(story.state, 'cancelled');
  assert.equal(environment.calls.some(([name]) => name === 'annotation:show'), false);
  assert.equal(environment.timerCount, 0);
});

test('a synchronous step listener can replay without the superseded step mounting', async () => {
  const environment = fakeEnvironment();
  const story = createStory(steps(), {}, environment.env);
  let replayed = false;
  environment.setEventHandler((event) => {
    if (event.type === 'hana:step' && !replayed) {
      replayed = true;
      story.replay();
    }
  });

  story.play();
  await flushMicrotasks();
  assert.equal(story.state, 'playing');
  assert.equal(environment.calls.filter(([name]) => name === 'annotation:show').length, 1);
  assert.equal(environment.annotations[0].state, 'showing');
  assert.equal(environment.timerCount, 0);
});

test('a synchronous step listener can pause before mount and resume that same step once', () => {
  const environment = fakeEnvironment();
  const story = createStory(steps(), {}, environment.env);
  let paused = false;
  environment.setEventHandler((event) => {
    if (event.type === 'hana:step' && !paused) {
      paused = true;
      story.pause();
    }
  });

  story.play();
  assert.equal(story.state, 'paused');
  assert.equal(environment.annotations[0].state, 'idle');
  assert.equal(environment.calls.some(([name]) => name === 'annotation:pause'), false);
  story.resume();
  assert.equal(story.state, 'playing');
  assert.equal(environment.annotations[0].state, 'showing');
  assert.equal(environment.events.filter(({ type }) => type === 'hana:step').length, 1);
  assert.equal(environment.calls.filter(([name]) => name === 'annotation:show').length, 1);
});

test('a gap timer step listener can cancel without showing the superseded annotation', async () => {
  const environment = fakeEnvironment();
  const story = createStory(steps(), { gap: 10 }, environment.env);
  environment.setEventHandler((event) => {
    if (event.type === 'hana:step' && event.detail.index === 1) story.cancel();
  });
  story.play();
  const run = story.finished;
  environment.annotations[0].finish();
  await flushMicrotasks();
  environment.advance(10);

  await assert.rejects(run, (error) => error?.name === 'AbortError');
  assert.equal(story.state, 'cancelled');
  assert.equal(environment.annotations[0].state, 'visible');
  assert.equal(environment.annotations[1].state, 'idle');
  assert.equal(environment.timerCount, 0);
});

test('a completion listener can replay without the completed run overwriting the new run', async () => {
  const environment = fakeEnvironment({ reducedMotion: true });
  const story = createStory(steps(), {}, environment.env);
  let replayed = false;
  environment.setEventHandler((event) => {
    if (event.type === 'hana:complete' && !replayed) {
      replayed = true;
      story.replay();
    }
  });
  story.play();
  const firstRun = story.finished;
  environment.annotations[0].finish();
  await flushMicrotasks();
  environment.annotations[1].finish();
  await firstRun;
  await flushMicrotasks();

  assert.equal(story.state, 'playing');
  assert.notEqual(story.finished, firstRun);
  assert.equal(environment.annotations[0].state, 'showing');
  assert.equal(environment.annotations[1].state, 'hidden');
});

test('a failed annotation hide listener can replay without stale failure cleanup winning', async () => {
  const environment = fakeEnvironment();
  const story = createStory(steps(), {}, environment.env);
  let replayed = false;
  environment.setAnnotationHandler((action, annotation) => {
    if (action === 'hide' && annotation.target === 'first' && !replayed) {
      replayed = true;
      story.replay();
    }
  });
  story.play();
  const failedRun = story.finished;
  environment.annotations[0].fail(new Error('renderer failed'));
  await assert.rejects(failedRun, HanamaruStateError);
  await flushMicrotasks();

  assert.equal(story.state, 'playing');
  assert.notEqual(story.finished, failedRun);
  assert.equal(environment.annotations[0].state, 'showing');
  assert.equal(environment.annotations[1].state, 'hidden');
  assert.equal(environment.timerCount, 0);
});
