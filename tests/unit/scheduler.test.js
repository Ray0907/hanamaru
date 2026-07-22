import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameQueue } from '../../src/scheduler.js';

function createHarness() {
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
    'error:broken:read failed',
    'read:peer',
    'write:peer:value:peer',
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
    'error:broken:read failed',
    'read:peer',
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
