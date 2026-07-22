import assert from 'node:assert/strict';
import test from 'node:test';

import * as Renderer from '../../src/renderer.js';

const MAX_TIMEOUT = 2_147_483_647;

function fakeTimers() {
  let nextId = 0;
  let now = 0;
  const callbacks = new Map();
  const delays = [];
  const cleared = [];
  return {
    callbacks,
    cleared,
    delays,
    now() { return now; },
    setNow(value) { now = value; },
    setTimeout(callback, delay) {
      const id = ++nextId;
      callbacks.set(id, callback);
      delays.push(delay);
      return id;
    },
    clearTimeout(id) {
      callbacks.delete(id);
      cleared.push(id);
    },
    fire(id) {
      const callback = callbacks.get(id);
      callbacks.delete(id);
      callback();
    },
  };
}

test('duration clock chunks beyond 2^31 and uses actual elapsed time before rescheduling', () => {
  assert.equal(typeof Renderer.createDurationClock, 'function');
  const timers = fakeTimers();
  let completions = 0;
  const clock = Renderer.createDurationClock({
    duration: MAX_TIMEOUT + 1,
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    complete() { completions += 1; },
  });

  clock.resume();
  assert.deepEqual(timers.delays, [MAX_TIMEOUT]);
  timers.setNow(MAX_TIMEOUT - 47);
  timers.fire(1);
  assert.equal(completions, 0);
  assert.deepEqual(timers.delays, [MAX_TIMEOUT, 48]);
  timers.setNow(MAX_TIMEOUT + 1);
  timers.fire(2);
  assert.equal(completions, 1);
});

test('duration clock preserves a huge remaining duration through pause, resume, and cancel', () => {
  const timers = fakeTimers();
  let completions = 0;
  const clock = Renderer.createDurationClock({
    duration: MAX_TIMEOUT + 1,
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    complete() { completions += 1; },
  });

  clock.resume();
  timers.setNow(100);
  clock.pause();
  assert.deepEqual(timers.cleared, [1]);
  clock.resume();
  assert.deepEqual(timers.delays, [MAX_TIMEOUT, MAX_TIMEOUT - 99]);
  clock.cancel();
  assert.deepEqual(timers.cleared, [1, 2]);
  assert.equal(completions, 0);
});
