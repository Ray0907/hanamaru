import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnnotation } from '../../src/annotation.js';
import { readControllerMetadata } from '../../src/controller-metadata.js';
import { createGroup } from '../../src/group.js';
import { registerMark } from '../../src/plugins.js';
import { runtimeState } from '../../src/runtime-state.js';
import { createStory } from '../../src/story.js';

function annotationEnvironment({ id = 'generated-seed' } = {}) {
  const calls = [];
  const owner = { name: 'owner' };
  let createFailure = null;
  let destroyFailure = null;
  let eventHandler = null;
  let layoutCleanup = null;
  let observeFailure = null;
  let rebindFailure = null;
  let resolveFailure = null;
  let synchronousIntersection = false;
  let nextRendererId = 0;
  const shared = {
    bumpGeneration() { return 1; },
    enqueue({ read, write, onError }) {
      try { write(read()); } catch (error) { onError?.(error); }
    },
    observeIntersection(binding) {
      if (synchronousIntersection) binding.onEnter();
      return () => {};
    },
    observeLayout() {
      if (observeFailure !== null) throw observeFailure;
      return () => layoutCleanup?.();
    },
    rebindLayout() {
      if (rebindFailure !== null) throw rebindFailure;
      return () => {};
    },
    registerController() { return 0; },
    releaseController() { calls.push('releaseController'); },
  };
  const environment = {
    calls,
    setCreateFailure(error) { createFailure = error; },
    setDestroyFailure(error) { destroyFailure = error; },
    setEventHandler(handler) { eventHandler = handler; },
    setLayoutCleanup(handler) { layoutCleanup = handler; },
    setObserveFailure(error) { observeFailure = error; },
    setRebindFailure(error) { rebindFailure = error; },
    setResolveFailure(error) { resolveFailure = error; },
    setSynchronousIntersection(value) { synchronousIntersection = value; },
    env: {
      id,
      createEvent(type, detail) { eventHandler?.({ type, detail }); },
      createRenderer() {
        if (createFailure !== null) throw createFailure;
        const rendererId = ++nextRendererId;
        return {
          rendererId,
          group: {},
          noteElement: null,
          animate() {
            return { animations: [], finished: Promise.resolve() };
          },
          destroy() {
            calls.push(['renderer:destroy', rendererId]);
            if (destroyFailure !== null) throw destroyFailure;
          },
          draw() {},
          finish() {},
          hide() {},
          measure() {
            return {
              noteRect: null,
              peerNoteRects: [],
              viewport: { width: 800, height: 600 },
            };
          },
          pause() {},
          resume() {},
          updateOwner() {},
        };
      },
      lease: {
        shared,
        release() { calls.push('lease:release'); },
      },
      microtask(callback) { queueMicrotask(callback); },
      readThemeMetrics() { return { noteGap: 16 }; },
      reducedMotion() { return true; },
      resolveTarget(target) {
        if (resolveFailure !== null) throw resolveFailure;
        return target?.record ?? {
          element: owner,
          kind: 'element',
          ownerElement: owner,
          range: null,
          refresh() { return this; },
        };
      },
      targetRects() {
        return [{
          x: 10, y: 10, width: 100, height: 20,
          top: 10, right: 110, bottom: 30, left: 10,
        }];
      },
    },
  };
  return environment;
}

function aggregateEnvironment({ failCreateAt = -1 } = {}) {
  const annotations = [];
  const destroyOrder = [];
  const memberEnvironments = [];
  let createIndex = 0;
  return {
    annotations,
    destroyOrder,
    memberEnvironments,
    env: {
      createAnnotation(target, options) {
        const index = createIndex;
        createIndex += 1;
        if (index === failCreateAt) throw new Error(`member ${index} failed`);
        const environment = annotationEnvironment({ id: `member-seed-${index + 1}` });
        const annotation = createAnnotation(target, options, environment.env);
        const originalDestroy = annotation.destroy;
        annotation.destroy = function destroyTrackedAnnotation() {
          destroyOrder.push(index);
          return originalDestroy();
        };
        memberEnvironments.push(environment);
        annotations.push(annotation);
        return annotation;
      },
      createEvent() {},
      reducedMotion() { return true; },
      resolveTarget(target) { return target.record; },
    },
  };
}

function aggregateTargets() {
  return ['first', 'second', 'third'].map((name) => {
    const ownerElement = { name: `${name}-owner` };
    return {
      name,
      record: {
        element: ownerElement,
        kind: 'element',
        ownerElement,
        range: null,
        refresh() { return this; },
      },
    };
  });
}

test('foreign objects have no controller metadata', () => {
  assert.equal(readControllerMetadata({}), undefined);
});

test('annotation records its accepted target and canonical normalized options privately', () => {
  const environment = annotationEnvironment();
  const target = { locator: true };
  const controller = createAnnotation(target, { mark: 'underline' }, environment.env);

  const metadata = readControllerMetadata(controller);
  assert.deepEqual(metadata, {
    kind: 'annotation',
    target,
    options: {
      mark: 'underline',
      note: null,
      placement: 'auto',
      trigger: 'manual',
      accessible: false,
      seed: 'generated-seed',
      duration: 650,
      motion: 'system',
    },
  });
  assert.equal(metadata.target, target);
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(Object.isFrozen(metadata.options), true);
  assert.equal(Object.isFrozen(target), false);

  controller.destroy();
});

test('annotation retains selector, locator, Element, and Range sources without freezing them', () => {
  class Element {}
  class Range {}
  const sources = [
    '#accepted-selector',
    { within: '#scope', text: 'accepted locator' },
    new Element(),
    new Range(),
  ];

  for (const source of sources) {
    const environment = annotationEnvironment();
    const controller = createAnnotation(source, { mark: 'box' }, environment.env);
    const metadata = readControllerMetadata(controller);

    assert.equal(metadata.target, source);
    if (typeof source === 'object') assert.equal(Object.isFrozen(source), false);
    controller.destroy();
  }
});

test('successful updates atomically replace canonical metadata and preserve generated seed', () => {
  const environment = annotationEnvironment();
  const initialTarget = { name: 'initial' };
  const nextTarget = { name: 'next' };
  const controller = createAnnotation(
    initialTarget,
    { mark: 'underline', note: '' },
    environment.env,
  );
  const initial = readControllerMetadata(controller);

  controller.update({
    target: nextTarget,
    mark: 'circle',
    note: 'Updated',
    placement: 'left',
    accessible: true,
    duration: 25,
    motion: 'never',
  });

  const updated = readControllerMetadata(controller);
  assert.notEqual(updated, initial);
  assert.equal(updated.target, nextTarget);
  assert.deepEqual(updated.options, {
    mark: 'circle',
    note: 'Updated',
    placement: 'left',
    trigger: 'manual',
    accessible: true,
    seed: 'generated-seed',
    duration: 25,
    motion: 'never',
  });
  assert.equal(Object.isFrozen(updated), true);
  assert.equal(Object.isFrozen(updated.options), true);

  const beforeNoOp = updated;
  controller.update({});
  assert.notEqual(readControllerMetadata(controller), beforeNoOp);
  assert.deepEqual(readControllerMetadata(controller), beforeNoOp);
  controller.destroy();
});

test('failed update preflights preserve the exact prior metadata record', () => {
  const cases = [
    {
      name: 'invalid options',
      arrange() {},
      update: { duration: -1 },
    },
    {
      name: 'missing plugin',
      arrange() {},
      update: { mark: 'missing-plugin' },
    },
    {
      name: 'target resolution',
      arrange(environment) {
        environment.setResolveFailure(new Error('target resolution failed'));
      },
      update: { target: { name: 'missing target' } },
    },
    {
      name: 'renderer construction',
      arrange(environment) {
        environment.setCreateFailure(new Error('renderer construction failed'));
      },
      update: { note: 'replacement renderer' },
    },
    {
      name: 'layout rebind',
      arrange(environment) {
        environment.setRebindFailure(new Error('layout rebind failed'));
      },
      update: { placement: 'right' },
    },
  ];

  for (const scenario of cases) {
    const environment = annotationEnvironment();
    const controller = createAnnotation(
      { name: 'original target' },
      { mark: 'underline' },
      environment.env,
    );
    const prior = readControllerMetadata(controller);
    scenario.arrange(environment);

    try {
      controller.update(scenario.update);
    } catch {
      // Validation and lookup failures are synchronous; runtime failures are contained.
    }

    assert.equal(readControllerMetadata(controller), prior, scenario.name);
    environment.setCreateFailure(null);
    environment.setDestroyFailure(null);
    environment.setRebindFailure(null);
    environment.setResolveFailure(null);
    controller.destroy();
  }
});

test('a throwing mark factory preserves the exact prior metadata record', () => {
  const cause = new Error('mark factory failed');
  const unregister = registerMark('metadata-throw', () => {
    throw cause;
  });
  const environment = annotationEnvironment();
  const controller = createAnnotation(
    { name: 'original target' },
    { mark: 'underline' },
    environment.env,
  );
  const prior = readControllerMetadata(controller);

  assert.throws(() => controller.update({ mark: 'metadata-throw' }));
  assert.equal(readControllerMetadata(controller), prior);

  controller.destroy();
  unregister();
});

test('committed update metadata survives old-renderer cleanup suspension', () => {
  const environment = annotationEnvironment();
  const initialTarget = { name: 'initial' };
  const nextTarget = { name: 'committed' };
  const controller = createAnnotation(
    initialTarget,
    { mark: 'underline' },
    environment.env,
  );
  const prior = readControllerMetadata(controller);
  environment.setDestroyFailure(new Error('old renderer cleanup failed'));

  controller.update({ target: nextTarget, note: 'committed options' });

  const committed = readControllerMetadata(controller);
  assert.notEqual(committed, prior);
  assert.equal(committed.target, nextTarget);
  assert.equal(committed.options.note, 'committed options');
  assert.equal(controller.state, 'suspended');

  environment.setDestroyFailure(null);
  controller.destroy();
});

test('reentrant destroy during update rebind cannot resurrect annotation metadata', () => {
  const environment = annotationEnvironment();
  const controller = createAnnotation(
    { name: 'initial' },
    { mark: 'underline' },
    environment.env,
  );
  environment.setLayoutCleanup(() => controller.destroy());

  controller.update({ target: { name: 'replacement' } });

  assert.equal(controller.state, 'destroyed');
  assert.equal(readControllerMetadata(controller), undefined);
});

test('reentrant destroy during annotation trigger setup cannot create metadata', () => {
  const environment = annotationEnvironment();
  environment.setSynchronousIntersection(true);
  environment.setEventHandler(({ type, detail }) => {
    if (type === 'hana:start') detail.controller.destroy();
  });

  const controller = createAnnotation(
    { name: 'target' },
    { mark: 'underline', trigger: 'viewport' },
    environment.env,
  );

  assert.equal(controller.state, 'destroyed');
  assert.equal(readControllerMetadata(controller), undefined);
});

test('annotation construction failure never records metadata', () => {
  class TrackingWeakMap extends WeakMap {
    set(key, value) {
      this.setCalls += 1;
      return super.set(key, value);
    }

    setCalls = 0;
  }

  const originalMetadata = runtimeState.metadata;
  const trackingMetadata = new TrackingWeakMap();
  runtimeState.metadata = trackingMetadata;
  try {
    const environment = annotationEnvironment();
    environment.setObserveFailure(new Error('layout installation failed'));

    assert.throws(() => createAnnotation(
      { name: 'target' },
      { mark: 'underline' },
      environment.env,
    ));
    assert.equal(trackingMetadata.setCalls, 0);
  } finally {
    runtimeState.metadata = originalMetadata;
  }
});

test('controller keys, descriptors, symbols, and JSON do not expose private metadata', () => {
  const environment = annotationEnvironment();
  const target = { secretTarget: 'not-public' };
  const controller = createAnnotation(target, { mark: 'underline' }, environment.env);
  const metadata = readControllerMetadata(controller);
  const ownKeys = Reflect.ownKeys(controller);
  const ownDescriptors = Object.getOwnPropertyDescriptors(controller);
  const prototypeDescriptors = Object.getOwnPropertyDescriptors(
    Object.getPrototypeOf(controller),
  );

  assert.equal(Object.hasOwn(controller, 'target'), false);
  assert.equal(Object.hasOwn(controller, 'metadata'), false);
  assert.deepEqual(ownKeys.filter((key) => typeof key === 'symbol'), []);
  assert.equal(
    Object.values(ownDescriptors).some(({ value }) => value === target || value === metadata),
    false,
  );
  assert.equal(
    Object.values(prototypeDescriptors).some(({ value }) => value === target || value === metadata),
    false,
  );
  assert.equal(JSON.stringify(controller).includes('not-public'), false);

  controller.destroy();
});

test('destroy deletes metadata before cleanup errors and remains idempotent', () => {
  const environment = annotationEnvironment();
  const controller = createAnnotation(
    { name: 'target' },
    { mark: 'underline' },
    environment.env,
  );
  environment.setDestroyFailure(new Error('renderer cleanup failed'));

  assert.notEqual(readControllerMetadata(controller), undefined);
  assert.doesNotThrow(() => controller.destroy());
  assert.equal(readControllerMetadata(controller), undefined);
  assert.doesNotThrow(() => controller.destroy());
  assert.equal(readControllerMetadata(controller), undefined);
  assert.equal(
    environment.calls.filter((call) => call === 'releaseController').length,
    1,
  );
  assert.equal(
    environment.calls.filter((call) => call === 'lease:release').length,
    1,
  );
});

test('story records frozen aggregate options and ordered member metadata', () => {
  const [first, second] = aggregateTargets();
  const environment = aggregateEnvironment();
  const controller = createStory([
    { target: first, mark: 'circle' },
    { target: second, mark: 'highlight', note: 'Next' },
  ], {}, environment.env);

  const metadata = readControllerMetadata(controller);
  const members = environment.annotations.map(readControllerMetadata);
  assert.deepEqual(metadata, {
    kind: 'story',
    options: {
      trigger: 'manual',
      gap: 180,
      motion: 'system',
    },
    steps: members,
  });
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(Object.isFrozen(metadata.options), true);
  assert.equal(Object.isFrozen(metadata.steps), true);
  assert.equal(metadata.steps[0], members[0]);
  assert.equal(metadata.steps[1], members[1]);
  assert.deepEqual(
    members.map(({ options }) => options.seed),
    ['member-seed-1', 'member-seed-2'],
  );
  assert.equal(new Set(members.map(({ options }) => options.seed)).size, 2);

  controller.destroy();
});

test('story viewport metadata includes normalized once while non-viewport omits it', () => {
  const [target] = aggregateTargets();
  const environment = aggregateEnvironment();
  const controller = createStory([
    { target, mark: 'underline' },
  ], {
    trigger: 'viewport',
    gap: 25,
    motion: 'never',
  }, environment.env);

  assert.deepEqual(readControllerMetadata(controller).options, {
    trigger: 'viewport',
    gap: 25,
    motion: 'never',
    once: true,
  });

  controller.destroy();

  const [repeatingTarget] = aggregateTargets();
  const repeatingEnvironment = aggregateEnvironment();
  const repeating = createStory([
    { target: repeatingTarget, mark: 'underline' },
  ], {
    trigger: 'viewport',
    once: false,
  }, repeatingEnvironment.env);
  assert.equal(readControllerMetadata(repeating).options.once, false);
  repeating.destroy();
});

test('group records frozen aggregate options and ordered member metadata', () => {
  const [first, second, third] = aggregateTargets();
  const environment = aggregateEnvironment();
  const controller = createGroup([
    { target: first, mark: 'box' },
    { target: second, mark: 'strike', seed: 42 },
    { target: third, mark: 'bracket' },
  ], {
    trigger: 'viewport',
    motion: 'never',
  }, environment.env);

  const metadata = readControllerMetadata(controller);
  const members = environment.annotations.map(readControllerMetadata);
  assert.deepEqual(metadata, {
    kind: 'group',
    options: {
      trigger: 'viewport',
      motion: 'never',
    },
    members,
  });
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(Object.isFrozen(metadata.options), true);
  assert.equal(Object.isFrozen(metadata.members), true);
  assert.equal(metadata.members[0], members[0]);
  assert.equal(metadata.members[1], members[1]);
  assert.equal(metadata.members[2], members[2]);
  assert.deepEqual(
    members.map(({ options }) => options.seed),
    ['member-seed-1', 42, 'member-seed-3'],
  );

  controller.destroy();
});

test('story and group construction rollback removes every member metadata record', () => {
  for (const [kind, construct] of [
    ['story', (members, env) => createStory(members, {}, env)],
    ['group', (members, env) => createGroup(members, {}, env)],
  ]) {
    const [first, second, third] = aggregateTargets();
    const environment = aggregateEnvironment({ failCreateAt: 2 });
    const definitions = [
      { target: first, mark: 'underline' },
      { target: second, mark: 'circle' },
      { target: third, mark: 'box' },
    ];

    assert.throws(() => construct(definitions, environment.env), /member 2 failed/);
    assert.deepEqual(
      environment.annotations.map(readControllerMetadata),
      [undefined, undefined],
      kind,
    );
    assert.deepEqual(environment.destroyOrder, [1, 0], kind);
  }
});

test('aggregate setup failure leaves no aggregate or member metadata', () => {
  class TrackingWeakMap extends WeakMap {
    active = new Set();

    set(key, value) {
      this.active.add(key);
      return super.set(key, value);
    }

    delete(key) {
      this.active.delete(key);
      return super.delete(key);
    }
  }

  const originalMetadata = runtimeState.metadata;
  const trackingMetadata = new TrackingWeakMap();
  runtimeState.metadata = trackingMetadata;
  try {
    const [storyTarget] = aggregateTargets();
    const storyEnvironment = aggregateEnvironment();
    storyEnvironment.env.document = {
      readyState: 'loading',
      addEventListener() { throw new Error('story setup failed'); },
    };
    storyEnvironment.env.microtask = (callback) => queueMicrotask(callback);
    assert.throws(() => createStory([
      { target: storyTarget, mark: 'underline' },
    ], { trigger: 'load' }, storyEnvironment.env));
    assert.equal(trackingMetadata.active.size, 0);

    const [groupTarget] = aggregateTargets();
    const groupEnvironment = aggregateEnvironment();
    groupEnvironment.env.observeMemberErrors = () => {
      throw new Error('group setup failed');
    };
    assert.throws(() => createGroup([
      { target: groupTarget, mark: 'circle' },
    ], {}, groupEnvironment.env));
    assert.equal(trackingMetadata.active.size, 0);
  } finally {
    runtimeState.metadata = originalMetadata;
  }
});

test('reentrant destroy during aggregate trigger setup cannot create metadata', () => {
  for (const [kind, construct] of [
    ['story', (members, env) => createStory(members, { trigger: 'viewport' }, env)],
    ['group', (members, env) => createGroup(members, { trigger: 'viewport' }, env)],
  ]) {
    const [target] = aggregateTargets();
    const environment = aggregateEnvironment();
    const triggerShared = {
      observeIntersection(binding) {
        binding.onEnter();
        return () => {};
      },
      observeLayout() { return () => {}; },
      registerController() { return 0; },
      releaseController() {},
    };
    environment.env.document = {};
    environment.env.triggerId = `${kind}-trigger`;
    environment.env.microtask = (callback) => queueMicrotask(callback);
    environment.env.acquireDocumentResources = () => ({
      shared: triggerShared,
      release() {},
    });
    environment.env.createEvent = (type, detail) => {
      if (type === 'hana:start') detail.controller.destroy();
    };

    const controller = construct([
      { target, mark: 'underline' },
    ], environment.env);

    assert.equal(controller.state, 'destroyed', kind);
    assert.equal(readControllerMetadata(controller), undefined, kind);
    assert.equal(readControllerMetadata(environment.annotations[0]), undefined, kind);
  }
});

test('aggregate destroy removes its metadata and every member record in reverse order', () => {
  for (const [kind, construct] of [
    ['story', (members, env) => createStory(members, {}, env)],
    ['group', (members, env) => createGroup(members, {}, env)],
  ]) {
    const [first, second, third] = aggregateTargets();
    const environment = aggregateEnvironment();
    const controller = construct([
      { target: first, mark: 'underline' },
      { target: second, mark: 'circle' },
      { target: third, mark: 'box' },
    ], environment.env);

    assert.notEqual(readControllerMetadata(controller), undefined, kind);
    assert.doesNotThrow(() => controller.destroy());
    assert.equal(readControllerMetadata(controller), undefined, kind);
    assert.deepEqual(
      environment.annotations.map(readControllerMetadata),
      [undefined, undefined, undefined],
      kind,
    );
    assert.deepEqual(environment.destroyOrder, [2, 1, 0], kind);
    assert.doesNotThrow(() => controller.destroy());
    assert.deepEqual(environment.destroyOrder, [2, 1, 0], kind);
  }
});

test('aggregate destroy deletes all metadata through member cleanup errors', () => {
  const [first, second] = aggregateTargets();
  const environment = aggregateEnvironment();
  const controller = createGroup([
    { target: first, mark: 'underline' },
    { target: second, mark: 'circle' },
  ], {}, environment.env);
  environment.memberEnvironments[1].setDestroyFailure(
    new Error('member renderer cleanup failed'),
  );

  assert.doesNotThrow(() => controller.destroy());
  assert.equal(readControllerMetadata(controller), undefined);
  assert.deepEqual(
    environment.annotations.map(readControllerMetadata),
    [undefined, undefined],
  );
});
