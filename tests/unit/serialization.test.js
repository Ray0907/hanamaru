import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnnotation } from '../../src/annotation.js';
import { readControllerMetadata } from '../../src/controller-metadata.js';
import {
  HanamaruConfigError,
  HanamaruStateError,
  HanamaruTargetError,
} from '../../src/errors.js';
import { createGroup } from '../../src/group.js';
import { registerMark } from '../../src/plugins.js';
import { runtimeState } from '../../src/runtime-state.js';
import { restore, resolveSerializedTarget, serialize } from '../../src/serialize.js';
import { validateDefinition } from '../../src/serialize-schema.js';
import { createStory } from '../../src/story.js';

function annotationEnvironment({ id = 'generated-seed' } = {}) {
  const calls = [];
  const owner = { name: 'owner' };
  const svgLayer = { children: [] };
  const noteLayer = { children: [] };
  let createFailure = null;
  let destroyFailure = null;
  let eventHandler = null;
  let layoutCleanup = null;
  let observeFailure = null;
  let pendingResidue = false;
  let rebindFailure = null;
  let resolveFailure = null;
  let synchronousIntersection = false;
  const createNode = (layer) => {
    const node = {
      remove() {
        const index = layer.children.indexOf(node);
        if (index !== -1) layer.children.splice(index, 1);
      },
    };
    layer.children.push(node);
    return node;
  };
  let nextRendererId = 0;
  const shared = {
    bumpGeneration() { return 1; },
    enqueue({ read, write, onError }) {
      try { write(read()); } catch (error) { onError?.(error); }
    },
    observeIntersection(binding) {
      calls.push('trigger:observe');
      if (synchronousIntersection) binding.onEnter();
      return () => { calls.push('trigger:cleanup'); };
    },
    observeLayout() {
      if (observeFailure !== null) throw observeFailure;
      return () => {
        calls.push('layout:cleanup');
        layoutCleanup?.();
      };
    },
    rebindLayout() {
      if (rebindFailure !== null) throw rebindFailure;
      return () => { calls.push('layout:cleanup'); };
    },
    registerController() { return 0; },
    releaseController() { calls.push('releaseController'); },
    svgLayer,
    noteLayer,
  };
  const environment = {
    calls,
    get ownedCount() { return svgLayer.children.length + noteLayer.children.length; },
    setCreateFailure(error) { createFailure = error; },
    setDestroyFailure(error) { destroyFailure = error; },
    setEventHandler(handler) { eventHandler = handler; },
    setLayoutCleanup(handler) { layoutCleanup = handler; },
    setObserveFailure(error) { observeFailure = error; },
    setPendingResidue(value) { pendingResidue = value; },
    setRebindFailure(error) { rebindFailure = error; },
    setResolveFailure(error) { resolveFailure = error; },
    setSynchronousIntersection(value) { synchronousIntersection = value; },
    env: {
      id,
      createEvent(type, detail) { eventHandler?.({ type, detail }); },
      createRenderer() {
        if (createFailure !== null) throw createFailure;
        const rendererId = ++nextRendererId;
        const group = createNode(svgLayer);
        if (pendingResidue) createNode(noteLayer);
        return {
          rendererId,
          group,
          noteElement: null,
          animate() {
            return { animations: [], finished: Promise.resolve() };
          },
          destroy() {
            calls.push(['renderer:destroy', rendererId]);
            if (destroyFailure !== null) throw destroyFailure;
            group.remove();
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
      resolveTarget(target) {
        const ownerElement = { target };
        return target?.record ?? {
          element: ownerElement,
          kind: 'element',
          ownerElement,
          range: null,
          refresh() { return this; },
        };
      },
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

function foreignAggregateEnvironment({ recordMetadata } = {}) {
  const annotations = [];
  const destroyed = [];
  const env = {
    createAnnotation(target) {
      let state = 'idle';
      const annotation = {
        get state() { return state; },
        get finished() { return null; },
        destroy() {
          if (state === 'destroyed') return annotation;
          state = 'destroyed';
          destroyed.push(target);
          return annotation;
        },
      };
      annotations.push(annotation);
      return annotation;
    },
    createEvent() {},
    reducedMotion() { return true; },
    resolveTarget(target) { return target.record; },
  };
  if (recordMetadata !== undefined) env.recordMetadata = recordMetadata;
  return { annotations, destroyed, env };
}

class ThrowingSetWeakMap extends WeakMap {
  constructor(failAt, cause) {
    super();
    this.cause = cause;
    this.failAt = failAt;
    this.setCalls = 0;
  }

  set(key, value) {
    this.setCalls += 1;
    if (this.setCalls === this.failAt) throw this.cause;
    return super.set(key, value);
  }
}

class DestroyingSetWeakMap extends WeakMap {
  constructor(destroyAt) {
    super();
    this.destroyAt = destroyAt;
    this.setCalls = 0;
  }

  set(key, value) {
    this.setCalls += 1;
    if (this.setCalls === this.destroyAt) key.destroy();
    return super.set(key, value);
  }
}

class RetainingThrowingSetWeakMap extends WeakMap {
  constructor(failAt, cause) {
    super();
    this.cause = cause;
    this.failAt = failAt;
    this.retainedKey = null;
    this.retainedValue = null;
    this.setCalls = 0;
  }

  set(key, value) {
    this.setCalls += 1;
    if (this.setCalls === this.failAt) {
      this.retainedKey = key;
      this.retainedValue = value;
      super.set(key, value);
      throw this.cause;
    }
    return super.set(key, value);
  }
}

class UpdatingSetWeakMap extends WeakMap {
  constructor(updateAt, patch) {
    super();
    this.patch = patch;
    this.retainedKey = null;
    this.setCalls = 0;
    this.updateAt = updateAt;
  }

  set(key, value) {
    this.setCalls += 1;
    if (this.setCalls === this.updateAt) {
      this.retainedKey = key;
      key.update(this.patch);
    }
    return super.set(key, value);
  }
}

function serializedMember(target, patch = {}) {
  return {
    target,
    options: {
      mark: 'underline',
      note: null,
      placement: 'auto',
      accessible: false,
      seed: 'member-seed',
      duration: 650,
      ...patch,
    },
  };
}

function serializedAnnotation(target, patch = {}) {
  return {
    schema: 'hanamaru/v1',
    kind: 'annotation',
    target,
    options: {
      mark: 'underline',
      note: null,
      placement: 'auto',
      trigger: 'manual',
      accessible: false,
      seed: 'annotation-seed',
      duration: 650,
      motion: 'system',
      ...patch,
    },
  };
}

function minimalNativeRealm(name = 'document') {
  class RealmDocument {}
  class RealmElement {
    constructor(ownerDocument) {
      this.ownerDocument = ownerDocument;
      this.isConnected = true;
      this.parentElement = null;
    }

    getRootNode() { return this.ownerDocument; }
  }
  class RealmRange {
    constructor(ownerDocument, startContainer, endContainer = startContainer) {
      this.ownerDocument = ownerDocument;
      this.startContainer = startContainer;
      this.endContainer = endContainer;
      this.commonAncestorContainer = startContainer;
      this.startOffset = 1;
      this.endOffset = 3;
    }

    cloneRange() {
      const clone = new RealmRange(
        this.ownerDocument,
        this.startContainer,
        this.endContainer,
      );
      clone.commonAncestorContainer = this.commonAncestorContainer;
      clone.startOffset = this.startOffset;
      clone.endOffset = this.endOffset;
      return clone;
    }
  }

  const document = new RealmDocument();
  document.name = name;
  document.nodeType = 9;
  document.defaultView = {
    Document: RealmDocument,
    Element: RealmElement,
    Range: RealmRange,
    Object,
  };
  document.documentElement = new RealmElement(document);
  const element = new RealmElement(document);
  document.querySelectorAll = (selector) => (
    selector === '#target' ? [element] : []
  );
  return { document, element, RealmElement, RealmRange };
}

test('serialize emits the exact canonical annotation v1 wire shape', () => {
  const environment = annotationEnvironment({ id: 'wire-seed' });
  const controller = createAnnotation('#accepted', {
    mark: 'underline',
    note: 'Remember',
    placement: 'left',
    trigger: 'manual',
    accessible: true,
    duration: 25,
    motion: 'never',
  }, environment.env);

  const definition = serialize(controller);

  assert.equal(
    JSON.stringify(definition),
    '{"schema":"hanamaru/v1","kind":"annotation","target":{"type":"selector","selector":"#accepted"},"options":{"mark":"underline","note":"Remember","placement":"left","trigger":"manual","accessible":true,"seed":"wire-seed","duration":25,"motion":"never"}}',
  );
  assert.deepEqual(Object.keys(definition), ['schema', 'kind', 'target', 'options']);
  assert.deepEqual(Object.keys(definition.target), ['type', 'selector']);
  assert.deepEqual(Object.keys(definition.options), [
    'mark', 'note', 'placement', 'trigger', 'accessible', 'seed', 'duration', 'motion',
  ]);

  controller.destroy();
});

test('serialize emits exact story and group aggregate key order and viewport once omission rules', () => {
  const storyEnvironment = aggregateEnvironment();
  const storyController = createStory([
    { target: '#first', mark: 'circle', note: 'One' },
    { target: { within: '#scope', text: 'Second', occurrence: 0 }, mark: 'box' },
  ], { trigger: 'viewport', gap: 25, motion: 'never', once: false }, storyEnvironment.env);
  const storyWire = serialize(storyController);

  assert.deepEqual(Object.keys(storyWire), ['schema', 'kind', 'options', 'steps']);
  assert.deepEqual(Object.keys(storyWire.options), ['trigger', 'gap', 'motion', 'once']);
  assert.deepEqual(Object.keys(storyWire.steps[0]), ['target', 'options']);
  assert.deepEqual(Object.keys(storyWire.steps[0].options), [
    'mark', 'note', 'placement', 'accessible', 'seed', 'duration',
  ]);
  assert.deepEqual(Object.keys(storyWire.steps[1].target), [
    'type', 'within', 'text', 'occurrence',
  ]);
  assert.equal(storyWire.steps[1].target.occurrence, 0);

  const groupEnvironment = aggregateEnvironment();
  const groupController = createGroup([
    { target: '#first', mark: 'highlight' },
  ], { trigger: 'manual', motion: 'system' }, groupEnvironment.env);
  const groupWire = serialize(groupController);

  assert.deepEqual(Object.keys(groupWire), ['schema', 'kind', 'options', 'members']);
  assert.deepEqual(Object.keys(groupWire.options), ['trigger', 'motion']);
  assert.equal('once' in groupWire.options, false);
  assert.equal('occurrence' in storyWire.steps[0].target, false);

  storyController.destroy();
  groupController.destroy();
});

test('serialize returns fresh deterministic trees without metadata or target aliases', () => {
  const environment = annotationEnvironment();
  const controller = createAnnotation('#stable', { mark: 'underline' }, environment.env);

  const first = serialize(controller);
  const second = serialize(controller);

  assert.notEqual(first, second);
  assert.notEqual(first.target, second.target);
  assert.notEqual(first.options, second.options);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.target === readControllerMetadata(controller).target, false);

  controller.destroy();
});

test('serialize reads controller metadata before rejecting unrelated options', () => {
  assert.throws(
    () => serialize({}, { unknown: true }),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_SERIALIZE_CONTROLLER',
  );
});

test('serialize passes exact original native targets and fixed-order contexts to keyForTarget', () => {
  const realm = minimalNativeRealm();
  const environment = annotationEnvironment();
  const controller = createAnnotation(realm.element, { mark: 'underline' }, environment.env);
  const calls = [];

  const wire = serialize(controller, {
    keyForTarget(target, context) {
      calls.push([target, context]);
      return 'hero';
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], realm.element);
  assert.deepEqual(Object.keys(calls[0][1]), [
    'role', 'controllerKind', 'ownerElement', 'index',
  ]);
  assert.deepEqual(calls[0][1], {
    role: 'target',
    controllerKind: 'annotation',
    ownerElement: realm.element,
    index: null,
  });
  assert.deepEqual(wire.target, {
    type: 'key',
    key: 'hero',
    targetKind: 'element',
  });

  controller.destroy();
});

test('serialize reports exact aggregate indexes and locator-within roles to keyForTarget', () => {
  const realm = minimalNativeRealm();
  const storyEnvironment = aggregateEnvironment();
  const storyController = createStory([
    { target: realm.element, mark: 'underline' },
    { target: { within: realm.element, text: 'Scoped text' }, mark: 'circle' },
  ], {}, storyEnvironment.env);
  const storyCalls = [];

  const storyWire = serialize(storyController, {
    keyForTarget(target, context) {
      storyCalls.push([target, context]);
      return context.role === 'within' ? 'scope' : `step-${context.index}`;
    },
  });

  assert.equal(storyCalls[0][0], realm.element);
  assert.deepEqual(storyCalls[0][1], {
    role: 'target',
    controllerKind: 'story',
    ownerElement: realm.element,
    index: 0,
  });
  assert.equal(storyCalls[1][0], realm.element);
  assert.deepEqual(storyCalls[1][1], {
    role: 'within',
    controllerKind: 'story',
    ownerElement: realm.element,
    index: 1,
  });
  assert.deepEqual(storyWire.steps[1].target.within, {
    type: 'key',
    key: 'scope',
    targetKind: 'element',
  });

  const groupEnvironment = aggregateEnvironment();
  const groupController = createGroup([
    { target: realm.element, mark: 'box' },
  ], {}, groupEnvironment.env);
  const groupCalls = [];
  serialize(groupController, {
    keyForTarget(target, context) {
      groupCalls.push([target, context]);
      return 'member-0';
    },
  });
  assert.deepEqual(groupCalls[0][1], {
    role: 'target',
    controllerKind: 'group',
    ownerElement: realm.element,
    index: 0,
  });

  storyController.destroy();
  groupController.destroy();
});

test('serialize contains keyForTarget failures with the stable config code and original cause', () => {
  const realm = minimalNativeRealm();
  const environment = annotationEnvironment();
  const controller = createAnnotation(realm.element, { mark: 'underline' }, environment.env);
  const cause = new Error('key storage failed');

  assert.throws(
    () => serialize(controller, {
      keyForTarget() { throw cause; },
    }),
    (error) => error instanceof HanamaruConfigError
      && error.code === 'HANA_CONFIG_SERIALIZE_TARGET'
      && error.details.role === 'target'
      && error.details.controllerKind === 'annotation'
      && error.details.index === null
      && error.details.cause === cause,
  );

  controller.destroy();
});

test('serialize protects error details from keyForTarget context mutation', () => {
  const realm = minimalNativeRealm();
  const environment = annotationEnvironment();
  const controller = createAnnotation(realm.element, { mark: 'underline' }, environment.env);
  let delivered;

  assert.throws(
    () => serialize(controller, {
      keyForTarget(target, context) {
        delivered = { target, keys: Object.keys(context), initial: { ...context } };
        context.role = 'corrupted';
        context.index = 99;
        context.extra = true;
        return '';
      },
    }),
    (error) => {
      assert.ok(error instanceof HanamaruConfigError);
      assert.equal(error.code, 'HANA_CONFIG_SERIALIZE_TARGET');
      assert.deepEqual(Object.keys(error.details), [
        'role', 'controllerKind', 'ownerElement', 'index',
      ]);
      assert.deepEqual(error.details, {
        role: 'target',
        controllerKind: 'annotation',
        ownerElement: realm.element,
        index: null,
      });
      return true;
    },
  );
  assert.equal(delivered.target, realm.element);
  assert.deepEqual(delivered.keys, [
    'role', 'controllerKind', 'ownerElement', 'index',
  ]);
  assert.deepEqual(delivered.initial, {
    role: 'target',
    controllerKind: 'annotation',
    ownerElement: realm.element,
    index: null,
  });

  controller.destroy();
});

test('late malformed private aggregate metadata prevents every key callback', () => {
  const realm = minimalNativeRealm();
  const controller = {};
  const options = Object.freeze({
    mark: 'underline',
    note: null,
    placement: 'auto',
    trigger: 'manual',
    accessible: false,
    seed: 'seed',
    duration: 650,
    motion: 'system',
  });
  runtimeState.metadata.set(controller, Object.freeze({
    kind: 'story',
    options: Object.freeze({ trigger: 'manual', gap: 180, motion: 'system' }),
    steps: Object.freeze([
      Object.freeze({ kind: 'annotation', target: realm.element, options }),
      Object.freeze({ kind: 'annotation', target: { bad: true }, options }),
    ]),
  }));
  let calls = 0;

  assert.throws(
    () => serialize(controller, { keyForTarget() { calls += 1; return 'key'; } }),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_SERIALIZE_CONTROLLER',
  );
  assert.equal(calls, 0);
  runtimeState.metadata.delete(controller);
});

test('hostile serialized graphs reject accessors, symbols, cycles, sparse arrays, and unknown keys', () => {
  const target = { type: 'selector', selector: '#target' };
  const base = serializedAnnotation(target);
  const cases = [];

  let getterCalls = 0;
  const accessor = serializedAnnotation(target);
  Object.defineProperty(accessor.options, 'note', {
    get() { getterCalls += 1; return null; },
    enumerable: true,
  });
  cases.push(accessor);

  const symbol = serializedAnnotation(target);
  symbol.options[Symbol('hidden')] = true;
  cases.push(symbol);

  const cycle = serializedAnnotation(target);
  cycle.target = cycle;
  cases.push(cycle);

  const story = {
    schema: 'hanamaru/v1',
    kind: 'story',
    options: { trigger: 'manual', gap: 180, motion: 'system' },
    steps: new Array(1),
  };
  cases.push(story);

  const unknown = serializedAnnotation({ type: 'selector', selector: '#target', extra: true });
  cases.push(unknown);

  for (const definition of cases) {
    assert.throws(
      () => restore(definition, { root: null }),
      (error) => error instanceof HanamaruConfigError
        && error.code === 'HANA_CONFIG_SERIALIZED_DEFINITION',
    );
  }
  assert.equal(getterCalls, 0);
});

test('serialized validation accepts benign shared aliases but still rejects active-path cycles', () => {
  const sharedTarget = { type: 'selector', selector: '#target' };
  const sharedOptions = serializedMember(sharedTarget).options;
  const sharedMember = { target: sharedTarget, options: sharedOptions };
  const aliased = {
    schema: 'hanamaru/v1',
    kind: 'story',
    options: { trigger: 'manual', gap: 180, motion: 'system' },
    steps: [sharedMember, sharedMember],
  };

  const canonical = validateDefinition(aliased);
  assert.deepEqual(canonical.steps[0], canonical.steps[1]);
  assert.notEqual(canonical.steps[0], canonical.steps[1]);
  assert.notEqual(canonical.steps[0].target, canonical.steps[1].target);
  assert.notEqual(canonical.steps[0].options, canonical.steps[1].options);

  const cyclicTarget = { type: 'locator', text: 'text' };
  cyclicTarget.within = cyclicTarget;
  assert.throws(
    () => restore(serializedAnnotation(cyclicTarget), { root: null }),
    (error) => error instanceof HanamaruConfigError
      && error.code === 'HANA_CONFIG_SERIALIZED_DEFINITION',
  );
});

test('locator within rejects deeply nested locator data without recursive overflow', () => {
  let within = { type: 'selector', selector: '#scope' };
  for (let depth = 0; depth < 5_000; depth += 1) {
    within = { type: 'locator', within, text: 'nested' };
  }
  const definition = serializedAnnotation({
    type: 'locator',
    within,
    text: 'outer',
  });

  assert.throws(
    () => validateDefinition(definition),
    (error) => error instanceof HanamaruConfigError
      && error.code === 'HANA_CONFIG_SERIALIZED_DEFINITION'
      && error.details.field === 'definition.target.within',
  );
});

test('serialized array validation uses its own length descriptor without reading length', () => {
  let lengthReads = 0;
  const steps = new Proxy([
    serializedMember({ type: 'selector', selector: '#target' }),
  ], {
    get(target, key, receiver) {
      if (key === 'length') {
        lengthReads += 1;
        throw new Error('length getter must not run');
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const definition = {
    schema: 'hanamaru/v1',
    kind: 'story',
    options: { trigger: 'manual', gap: 180, motion: 'system' },
    steps,
  };

  assert.throws(
    () => restore(definition, { root: null }),
    (error) => error instanceof HanamaruConfigError
      && error.code === 'HANA_CONFIG_SERIALIZE_TARGET',
  );
  assert.equal(lengthReads, 0);
});

test('public serialization validation normalizes reflection trap failures as config errors', () => {
  const definitionCause = new Error('definition prototype trap');
  const definition = new Proxy({}, {
    getPrototypeOf() { throw definitionCause; },
  });
  assert.throws(
    () => validateDefinition(definition),
    (error) => error instanceof HanamaruConfigError
      && error.code === 'HANA_CONFIG_SERIALIZED_DEFINITION'
      && error.details.field === 'definition'
      && error.details.cause === definitionCause,
  );

  const targetCause = new Error('target ownKeys trap');
  const target = new Proxy(
    { type: 'selector', selector: '#target' },
    { ownKeys() { throw targetCause; } },
  );
  assert.throws(
    () => resolveSerializedTarget(target, { root: null }),
    (error) => error instanceof HanamaruConfigError
      && error.code === 'HANA_CONFIG_SERIALIZED_DEFINITION'
      && error.details.field === 'target'
      && error.details.cause === targetCause,
  );
});

test('schema reflection boundaries do not trust trap-thrown Hanamaru error codes', () => {
  const forgedDefinition = new HanamaruConfigError(
    'FORGED_DEFINITION',
    'forged definition error',
  );
  const definition = new Proxy({}, {
    getPrototypeOf() { throw forgedDefinition; },
  });
  assert.throws(
    () => validateDefinition(definition),
    (error) => error instanceof HanamaruConfigError
      && error !== forgedDefinition
      && error.code === 'HANA_CONFIG_SERIALIZED_DEFINITION'
      && error.details.cause === forgedDefinition,
  );

  const forgedTarget = new HanamaruTargetError('FORGED_TARGET', 'forged target error');
  const target = new Proxy(
    { type: 'selector', selector: '#target' },
    { ownKeys() { throw forgedTarget; } },
  );
  assert.throws(
    () => resolveSerializedTarget(target, { root: null }),
    (error) => error instanceof HanamaruConfigError
      && error !== forgedTarget
      && error.code === 'HANA_CONFIG_SERIALIZED_DEFINITION'
      && error.details.cause === forgedTarget,
  );

  let replayed;
  assert.throws(() => validateDefinition({}), (error) => {
    replayed = error;
    return error instanceof HanamaruConfigError;
  });
  const replay = new Proxy({}, {
    getPrototypeOf() { throw replayed; },
  });
  assert.throws(
    () => validateDefinition(replay),
    (error) => error instanceof HanamaruConfigError
      && error !== replayed
      && error.code === 'HANA_CONFIG_SERIALIZED_DEFINITION'
      && error.details.cause === replayed,
  );
});

test('public serialization contexts normalize reflection and root trap failures', () => {
  const realm = minimalNativeRealm();
  const contextCause = new Error('context ownKeys trap');
  const context = new Proxy({}, {
    ownKeys() { throw contextCause; },
  });
  assert.throws(
    () => resolveSerializedTarget(
      { type: 'selector', selector: '#target' },
      context,
    ),
    (error) => error instanceof HanamaruConfigError
      && error.code === 'HANA_CONFIG_SERIALIZE_TARGET'
      && error.details.field === 'context'
      && error.details.cause === contextCause,
  );

  const restoreCause = new Error('restore context descriptor trap');
  const restoreContext = new Proxy({ root: realm.document }, {
    getOwnPropertyDescriptor() { throw restoreCause; },
  });
  assert.throws(
    () => restore(
      serializedAnnotation({ type: 'selector', selector: '#target' }),
      restoreContext,
    ),
    (error) => error instanceof HanamaruConfigError
      && error.code === 'HANA_CONFIG_SERIALIZE_TARGET'
      && error.details.field === 'context'
      && error.details.cause === restoreCause,
  );

  const rootCause = new Error('root nodeType trap');
  const root = new Proxy({}, {
    get(target, key) {
      if (key === 'nodeType') throw rootCause;
      return Reflect.get(target, key);
    },
  });
  assert.throws(
    () => resolveSerializedTarget(
      { type: 'selector', selector: '#target' },
      { root },
    ),
    (error) => error instanceof HanamaruConfigError
      && error.code === 'HANA_CONFIG_SERIALIZE_TARGET'
      && error.details.field === 'root'
      && error.details.cause === rootCause,
  );
});

test('context and root reflection boundaries normalize forged typed errors', () => {
  const forgedContext = new HanamaruConfigError('FORGED_CONTEXT', 'forged context error');
  const context = new Proxy({}, {
    ownKeys() { throw forgedContext; },
  });
  assert.throws(
    () => resolveSerializedTarget(
      { type: 'selector', selector: '#target' },
      context,
    ),
    (error) => error instanceof HanamaruConfigError
      && error !== forgedContext
      && error.code === 'HANA_CONFIG_SERIALIZE_TARGET'
      && error.details.cause === forgedContext,
  );

  const forgedRoot = new HanamaruTargetError('FORGED_ROOT', 'forged root error');
  const root = new Proxy({}, {
    get(target, key) {
      if (key === 'nodeType') throw forgedRoot;
      return Reflect.get(target, key);
    },
  });
  assert.throws(
    () => restore(
      serializedAnnotation({ type: 'selector', selector: '#target' }),
      { root },
    ),
    (error) => error instanceof HanamaruConfigError
      && error !== forgedRoot
      && error.code === 'HANA_CONFIG_SERIALIZE_TARGET'
      && error.details.cause === forgedRoot,
  );

  let replayed;
  assert.throws(
    () => resolveSerializedTarget(
      { type: 'selector', selector: '#target' },
      null,
    ),
    (error) => {
      replayed = error;
      return error instanceof HanamaruConfigError;
    },
  );
  const replayContext = new Proxy({}, {
    ownKeys() { throw replayed; },
  });
  assert.throws(
    () => resolveSerializedTarget(
      { type: 'selector', selector: '#target' },
      replayContext,
    ),
    (error) => error instanceof HanamaruConfigError
      && error !== replayed
      && error.code === 'HANA_CONFIG_SERIALIZE_TARGET'
      && error.details.cause === replayed,
  );
});

test('resolver return-value reflection traps become target errors without wrapping callbacks', () => {
  const realm = minimalNativeRealm();
  const resultCause = new Error('resolver result prototype trap');
  const result = new Proxy({}, {
    getPrototypeOf() { throw resultCause; },
  });

  assert.throws(
    () => resolveSerializedTarget({
      type: 'key',
      key: 'proxy-result',
      targetKind: 'element',
    }, {
      root: realm.document,
      resolveTarget() { return result; },
    }),
    (error) => error instanceof HanamaruTargetError
      && error.code === 'HANA_TARGET_INVALID'
      && error.details.cause === resultCause,
  );
});

test('resolver result inspection normalizes forged typed errors but callback throws remain resolver errors', () => {
  const realm = minimalNativeRealm();
  const forgedResult = new HanamaruTargetError(
    'HANA_TARGET_RESOLVER',
    'forged result error',
  );
  const result = new Proxy({}, {
    getPrototypeOf() { throw forgedResult; },
  });
  assert.throws(
    () => resolveSerializedTarget({
      type: 'key',
      key: 'forged-result',
      targetKind: 'element',
    }, {
      root: realm.document,
      resolveTarget() { return result; },
    }),
    (error) => error instanceof HanamaruTargetError
      && error !== forgedResult
      && error.code === 'HANA_TARGET_INVALID'
      && error.details.cause === forgedResult,
  );

  const callbackCause = new HanamaruConfigError(
    'CALLBACK_TYPED_CAUSE',
    'typed resolver callback cause',
  );
  assert.throws(
    () => resolveSerializedTarget({
      type: 'key',
      key: 'callback',
      targetKind: 'element',
    }, {
      root: realm.document,
      resolveTarget() { throw callbackCause; },
    }),
    (error) => error instanceof HanamaruTargetError
      && error.code === 'HANA_TARGET_RESOLVER'
      && error.details.cause === callbackCause,
  );
});

test('serialize options normalize reflection traps without changing callback error contracts', () => {
  const environment = annotationEnvironment();
  const controller = createAnnotation('#target', { mark: 'underline' }, environment.env);
  const optionsCause = new Error('serialize options prototype trap');
  const options = new Proxy({}, {
    getPrototypeOf() { throw optionsCause; },
  });

  assert.throws(
    () => serialize(controller, options),
    (error) => error instanceof HanamaruConfigError
      && error.code === 'HANA_CONFIG_SERIALIZE_TARGET'
      && error.details.cause === optionsCause,
  );

  controller.destroy();
});

test('serialize options normalize forged typed traps while key callbacks retain typed causes', () => {
  const selectorEnvironment = annotationEnvironment();
  const selectorController = createAnnotation(
    '#target',
    { mark: 'underline' },
    selectorEnvironment.env,
  );
  const forgedOptions = new HanamaruConfigError(
    'FORGED_OPTIONS',
    'forged serialize options error',
  );
  const options = new Proxy({}, {
    getPrototypeOf() { throw forgedOptions; },
  });
  assert.throws(
    () => serialize(selectorController, options),
    (error) => error instanceof HanamaruConfigError
      && error !== forgedOptions
      && error.code === 'HANA_CONFIG_SERIALIZE_TARGET'
      && error.details.cause === forgedOptions,
  );

  let replayed;
  assert.throws(
    () => serialize(selectorController, { unknown: true }),
    (error) => {
      replayed = error;
      return error instanceof HanamaruConfigError;
    },
  );
  const replayOptions = new Proxy({}, {
    getPrototypeOf() { throw replayed; },
  });
  assert.throws(
    () => serialize(selectorController, replayOptions),
    (error) => error instanceof HanamaruConfigError
      && error !== replayed
      && error.code === 'HANA_CONFIG_SERIALIZE_TARGET'
      && error.details.cause === replayed,
  );
  selectorController.destroy();

  const realm = minimalNativeRealm();
  const nativeEnvironment = annotationEnvironment();
  const nativeController = createAnnotation(
    realm.element,
    { mark: 'underline' },
    nativeEnvironment.env,
  );
  const callbackCause = new HanamaruTargetError(
    'CALLBACK_TYPED_CAUSE',
    'typed key callback cause',
  );
  assert.throws(
    () => serialize(nativeController, {
      keyForTarget() { throw callbackCause; },
    }),
    (error) => error instanceof HanamaruConfigError
      && error.code === 'HANA_CONFIG_SERIALIZE_TARGET'
      && error.details.cause === callbackCause,
  );
  nativeController.destroy();
});

test('late invalid locator text is rejected before a within-key resolver callback', () => {
  const realm = minimalNativeRealm();
  let calls = 0;
  const target = {
    type: 'locator',
    within: { type: 'key', key: 'scope', targetKind: 'element' },
    text: ' \t\u00a0 ',
  };

  assert.throws(
    () => resolveSerializedTarget(target, {
      root: realm.document,
      resolveTarget() { calls += 1; return realm.element; },
    }),
    (error) => error instanceof HanamaruConfigError,
  );
  assert.equal(calls, 0);
});

test('resolveSerializedTarget uses exact key contexts and clones resolved ranges', () => {
  const realm = minimalNativeRealm();
  const textNode = {
    nodeType: 3,
    ownerDocument: realm.document,
    isConnected: true,
    parentElement: realm.element,
    getRootNode() { return realm.document; },
  };
  const range = new realm.RealmRange(realm.document, textNode);
  const calls = [];

  const resolved = resolveSerializedTarget({
    type: 'key',
    key: 'selection',
    targetKind: 'range',
  }, {
    root: realm.document,
    resolveTarget(key, context) {
      calls.push([key, context]);
      return range;
    },
  });

  assert.notEqual(resolved, range);
  assert.ok(resolved instanceof realm.RealmRange);
  assert.equal(resolved.startContainer, range.startContainer);
  assert.equal(resolved.endContainer, range.endContainer);
  assert.equal(resolved.startOffset, range.startOffset);
  assert.equal(resolved.endOffset, range.endOffset);
  assert.deepEqual(calls, [[
    'selection',
    { targetKind: 'range', role: 'target', controllerKind: null, index: null },
  ]]);
});

test('resolveSerializedTarget rejects a connected Range without an Element owner', () => {
  const realm = minimalNativeRealm();
  const comment = {
    nodeType: 8,
    ownerDocument: realm.document,
    isConnected: true,
    parentElement: null,
    getRootNode() { return realm.document; },
  };
  const range = new realm.RealmRange(realm.document, comment);

  assert.throws(
    () => resolveSerializedTarget({
      type: 'key',
      key: 'document-comment',
      targetKind: 'range',
    }, {
      root: realm.document,
      resolveTarget() { return range; },
    }),
    (error) => error instanceof HanamaruTargetError
      && error.code === 'HANA_TARGET_INVALID'
      && error.details.cause instanceof HanamaruTargetError,
  );
});

test('resolveSerializedTarget rejects invalid Range clone results with their causes', () => {
  const realm = minimalNativeRealm();
  const textNode = {
    nodeType: 3,
    ownerDocument: realm.document,
    isConnected: true,
    parentElement: realm.element,
    getRootNode() { return realm.document; },
  };
  const wrongTextNode = {
    nodeType: 3,
    ownerDocument: realm.document,
    isConnected: true,
    parentElement: realm.element,
    getRootNode() { return realm.document; },
  };
  const invalidTextNode = {
    nodeType: 3,
    ownerDocument: realm.document,
    isConnected: false,
    parentElement: null,
    getRootNode() { return null; },
  };
  const cases = [
    ['a string', () => 'not a Range'],
    ['the source Range', (range) => range],
    ['a Range with different boundaries', () => (
      new realm.RealmRange(realm.document, wrongTextNode)
    )],
    ['a disconnected Range', () => (
      new realm.RealmRange(realm.document, invalidTextNode)
    )],
  ];

  for (const [label, cloneResult] of cases) {
    const range = new realm.RealmRange(realm.document, textNode);
    range.cloneRange = () => cloneResult(range);

    assert.throws(
      () => resolveSerializedTarget({
        type: 'key',
        key: `invalid-clone-${label}`,
        targetKind: 'range',
      }, {
        root: realm.document,
        resolveTarget() { return range; },
      }),
      (error) => error instanceof HanamaruTargetError
        && error.code === 'HANA_TARGET_INVALID'
        && error.details.cause !== undefined,
      label,
    );
  }

  const cloneCause = new HanamaruConfigError(
    'FORGED_CLONE',
    'cloneRange failed',
  );
  const throwingRange = new realm.RealmRange(realm.document, textNode);
  throwingRange.cloneRange = () => { throw cloneCause; };
  assert.throws(
    () => resolveSerializedTarget({
      type: 'key',
      key: 'throwing-clone',
      targetKind: 'range',
    }, {
      root: realm.document,
      resolveTarget() { return throwingRange; },
    }),
    (error) => error instanceof HanamaruTargetError
      && error.code === 'HANA_TARGET_INVALID'
      && error.details.cause === cloneCause,
  );
});

test('resolveSerializedTarget rejects a connected Range whose boundaries are in a ShadowRoot', () => {
  const realm = minimalNativeRealm();
  const shadow = { nodeType: 11, host: realm.element };
  const textNode = {
    nodeType: 3,
    ownerDocument: realm.document,
    isConnected: true,
    parentElement: realm.element,
    getRootNode() { return shadow; },
  };
  const range = new realm.RealmRange(realm.document, textNode);

  assert.throws(
    () => resolveSerializedTarget({
      type: 'key',
      key: 'shadow-selection',
      targetKind: 'range',
    }, {
      root: realm.document,
      resolveTarget() { return range; },
    }),
    (error) => error instanceof HanamaruTargetError
      && error.code === 'HANA_TARGET_INVALID',
  );
});

test('resolveSerializedTarget preserves resolver causes and rejects ShadowRoot scope', () => {
  const realm = minimalNativeRealm();
  const cause = new Error('lookup failed');

  assert.throws(
    () => resolveSerializedTarget({
      type: 'key',
      key: 'missing',
      targetKind: 'element',
    }, {
      root: realm.document,
      resolveTarget() { throw cause; },
    }),
    (error) => error instanceof HanamaruTargetError
      && error.code === 'HANA_TARGET_RESOLVER'
      && error.details.key === 'missing'
      && error.details.cause === cause
      && Object.keys(error.details.context).join(',') === 'targetKind,role,controllerKind,index',
  );

  assert.throws(
    () => resolveSerializedTarget(
      { type: 'selector', selector: '#target' },
      { root: { nodeType: 11, host: realm.element } },
    ),
    (error) => error instanceof HanamaruTargetError
      && error.code === 'HANA_TARGET_SHADOW_UNSCOPED',
  );
});

test('resolver errors preserve an exact protected context after callback mutation', () => {
  const realm = minimalNativeRealm();
  const cause = new Error('mutated resolver failed');
  let delivered;

  assert.throws(
    () => resolveSerializedTarget({
      type: 'key',
      key: 'hero',
      targetKind: 'element',
    }, {
      root: realm.document,
      resolveTarget(key, context) {
        delivered = { key, keys: Object.keys(context), initial: { ...context } };
        context.targetKind = 'range';
        context.role = 'corrupted';
        context.extra = true;
        throw cause;
      },
    }),
    (error) => {
      assert.ok(error instanceof HanamaruTargetError);
      assert.equal(error.code, 'HANA_TARGET_RESOLVER');
      assert.deepEqual(Object.keys(error.details.context), [
        'targetKind', 'role', 'controllerKind', 'index',
      ]);
      assert.deepEqual(error.details.context, {
        targetKind: 'element',
        role: 'target',
        controllerKind: null,
        index: null,
      });
      assert.equal(error.details.cause, cause);
      return true;
    },
  );
  assert.deepEqual(delivered, {
    key: 'hero',
    keys: ['targetKind', 'role', 'controllerKind', 'index'],
    initial: {
      targetKind: 'element',
      role: 'target',
      controllerKind: null,
      index: null,
    },
  });
});

test('restore rejects an unregistered mark before resolving any target', () => {
  const realm = minimalNativeRealm();
  let calls = 0;
  const definition = serializedAnnotation({
    type: 'key',
    key: 'target',
    targetKind: 'element',
  }, { mark: 'not-registered' });

  assert.throws(
    () => restore(definition, {
      root: realm.document,
      resolveTarget() { calls += 1; return realm.element; },
    }),
    (error) => error instanceof HanamaruConfigError,
  );
  assert.equal(calls, 0);
});

test('restore supplies exact aggregate and locator-within resolver contexts before creation', () => {
  const realm = minimalNativeRealm();
  const storyCalls = [];
  const story = {
    schema: 'hanamaru/v1',
    kind: 'story',
    options: { trigger: 'manual', gap: 180, motion: 'system' },
    steps: [
      serializedMember(
        { type: 'key', key: 'first', targetKind: 'element' },
        { seed: 'one' },
      ),
      serializedMember(
        { type: 'selector', selector: '#missing' },
        { seed: 'two' },
      ),
    ],
  };

  assert.throws(
    () => restore(story, {
      root: realm.document,
      resolveTarget(key, context) {
        storyCalls.push([key, context]);
        return realm.element;
      },
    }),
    (error) => error instanceof HanamaruTargetError
      && error.code === 'HANA_TARGET_MISSING',
  );
  assert.deepEqual(storyCalls, [[
    'first',
    { targetKind: 'element', role: 'target', controllerKind: 'story', index: 0 },
  ]]);

  const withinCalls = [];
  assert.throws(
    () => resolveSerializedTarget({
      type: 'locator',
      within: { type: 'key', key: 'scope', targetKind: 'element' },
      text: 'present',
    }, {
      root: realm.document,
      resolveTarget(key, context) {
        withinCalls.push([key, context]);
        return realm.element;
      },
    }),
  );
  assert.deepEqual(withinCalls, [[
    'scope',
    { targetKind: 'element', role: 'within', controllerKind: null, index: null },
  ]]);
});

test('late aggregate resolver failure leaves controller metadata untouched', () => {
  class TrackingWeakMap extends WeakMap {
    setCalls = 0;

    set(key, value) {
      this.setCalls += 1;
      return super.set(key, value);
    }
  }

  const realm = minimalNativeRealm();
  const disconnected = new realm.RealmElement(realm.document);
  disconnected.isConnected = false;
  const definition = {
    schema: 'hanamaru/v1',
    kind: 'story',
    options: { trigger: 'manual', gap: 180, motion: 'system' },
    steps: [
      serializedMember({ type: 'selector', selector: '#target' }, { seed: 'one' }),
      serializedMember(
        { type: 'key', key: 'late', targetKind: 'element' },
        { seed: 'two' },
      ),
    ],
  };
  const originalMetadata = runtimeState.metadata;
  const trackingMetadata = new TrackingWeakMap();
  runtimeState.metadata = trackingMetadata;
  try {
    assert.throws(
      () => restore(definition, {
        root: realm.document,
        resolveTarget() { return disconnected; },
      }),
      (error) => error instanceof HanamaruTargetError,
    );
    assert.equal(trackingMetadata.setCalls, 0);
  } finally {
    runtimeState.metadata = originalMetadata;
  }
});

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

test('annotation preserves native identities while snapshotting locators without freezing sources', () => {
  class MockElement {}
  class MockRange {}
  const sources = [
    '#accepted-selector',
    { within: '#scope', text: 'accepted locator' },
    new MockElement(),
    new MockRange(),
  ];

  for (const source of sources) {
    const environment = annotationEnvironment();
    const controller = createAnnotation(source, { mark: 'box' }, environment.env);
    const metadata = readControllerMetadata(controller);

    if (source !== null && typeof source === 'object' && Object.hasOwn(source, 'within')) {
      assert.notEqual(metadata.target, source);
      assert.deepEqual(metadata.target, source);
      assert.equal(Object.isFrozen(metadata.target), true);
    } else {
      assert.equal(metadata.target, source);
    }
    if (typeof source === 'object') assert.equal(Object.isFrozen(source), false);
    controller.destroy();
  }
});

test('annotation metadata snapshots accepted locator bytes without changing runtime source identity', () => {
  const source = {
    within: '#original-scope',
    text: 'Original text',
    occurrence: 1,
  };
  const environment = annotationEnvironment();
  const resolvedSources = [];
  const originalResolve = environment.env.resolveTarget;
  environment.env.resolveTarget = (target) => {
    resolvedSources.push(target);
    return originalResolve(target);
  };
  const controller = createAnnotation(source, { mark: 'underline' }, environment.env);
  const metadata = readControllerMetadata(controller);

  assert.equal(resolvedSources[0], source);
  assert.notEqual(metadata.target, source);
  assert.equal(Object.isFrozen(metadata.target), true);
  assert.deepEqual(metadata.target, {
    within: '#original-scope',
    text: 'Original text',
    occurrence: 1,
  });

  source.within = '#mutated-scope';
  source.text = 'Mutated text';
  source.occurrence = 9;
  controller.update({ note: 'Updated without replacing target' });
  assert.notEqual(resolvedSources[1], source);
  assert.equal(Object.isFrozen(resolvedSources[1]), true);
  assert.deepEqual(resolvedSources[1], {
    within: '#original-scope',
    text: 'Original text',
    occurrence: 1,
  });
  assert.deepEqual(serialize(controller).target, {
    type: 'locator',
    within: { type: 'selector', selector: '#original-scope' },
    text: 'Original text',
    occurrence: 1,
  });

  const replacement = {
    within: '#replacement-scope',
    text: 'Replacement text',
  };
  controller.update({ target: replacement });
  assert.equal(resolvedSources[2], replacement);
  replacement.within = '#replacement-mutated';
  replacement.text = 'Replacement mutated';
  controller.update({ duration: 20 });
  assert.notEqual(resolvedSources[3], replacement);
  assert.equal(Object.isFrozen(resolvedSources[3]), true);
  assert.deepEqual(resolvedSources[3], {
    within: '#replacement-scope',
    text: 'Replacement text',
  });
  assert.deepEqual(serialize(controller).target, {
    type: 'locator',
    within: { type: 'selector', selector: '#replacement-scope' },
    text: 'Replacement text',
  });

  controller.destroy();
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

test('annotation construction contains a throwing metadata store transactionally', () => {
  const cause = new Error('metadata set failed during construction');
  const originalMetadata = runtimeState.metadata;
  const throwingMetadata = new ThrowingSetWeakMap(1, cause);
  const environment = annotationEnvironment();
  environment.setPendingResidue(true);
  runtimeState.metadata = throwingMetadata;
  try {
    assert.throws(
      () => createAnnotation(
        { name: 'target' },
        { mark: 'underline', trigger: 'viewport' },
        environment.env,
      ),
      (error) => error instanceof HanamaruStateError
        && error.code === 'HANA_STATE_RUNTIME'
        && error.details.cause === cause,
    );

    assert.equal(throwingMetadata.setCalls, 1);
    assert.equal(environment.ownedCount, 0);
    assert.deepEqual(
      environment.calls.filter((call) => Array.isArray(call) && call[0] === 'renderer:destroy'),
      [['renderer:destroy', 1]],
    );
    assert.equal(environment.calls.filter((call) => call === 'layout:cleanup').length, 1);
    assert.equal(environment.calls.filter((call) => call === 'trigger:cleanup').length, 1);
    assert.equal(environment.calls.filter((call) => call === 'releaseController').length, 1);
    assert.equal(environment.calls.filter((call) => call === 'lease:release').length, 1);
  } finally {
    runtimeState.metadata = originalMetadata;
  }
});

test('annotation construction terminalizes a controller retained by a throwing metadata store', () => {
  const cause = new Error('metadata retained controller before throwing');
  const originalMetadata = runtimeState.metadata;
  const retainingMetadata = new RetainingThrowingSetWeakMap(1, cause);
  const environment = annotationEnvironment();
  runtimeState.metadata = retainingMetadata;
  try {
    assert.throws(
      () => createAnnotation(
        { name: 'target' },
        { mark: 'underline' },
        environment.env,
      ),
      (error) => error instanceof HanamaruStateError
        && error.code === 'HANA_STATE_RUNTIME'
        && error.details.cause === cause,
    );

    assert.equal(retainingMetadata.retainedKey.state, 'destroyed');
    assert.equal(readControllerMetadata(retainingMetadata.retainedKey), undefined);
    assert.equal(environment.ownedCount, 0);
    const callsAfterFailure = [...environment.calls];
    retainingMetadata.retainedKey.destroy();
    assert.deepEqual(environment.calls, callsAfterFailure);
  } finally {
    runtimeState.metadata = originalMetadata;
  }
});

test('annotation construction contains an update accepted during metadata storage', () => {
  const originalMetadata = runtimeState.metadata;
  const updatingMetadata = new UpdatingSetWeakMap(1, {
    target: { name: 'nested target' },
    note: 'nested update',
  });
  const environment = annotationEnvironment();
  environment.setPendingResidue(true);
  runtimeState.metadata = updatingMetadata;
  try {
    assert.throws(
      () => createAnnotation(
        { name: 'outer target' },
        { mark: 'underline', trigger: 'viewport' },
        environment.env,
      ),
      (error) => error instanceof HanamaruStateError
        && error.code === 'HANA_STATE_RUNTIME',
    );

    assert.equal(updatingMetadata.setCalls, 2);
    assert.equal(updatingMetadata.retainedKey.state, 'destroyed');
    assert.equal(readControllerMetadata(updatingMetadata.retainedKey), undefined);
    assert.equal(environment.ownedCount, 0);
    assert.deepEqual(
      environment.calls
        .filter((call) => Array.isArray(call) && call[0] === 'renderer:destroy')
        .map(([, rendererId]) => rendererId)
        .sort(),
      [1, 2],
    );
    assert.equal(environment.calls.filter((call) => call === 'trigger:cleanup').length, 1);
    assert.equal(environment.calls.filter((call) => call === 'layout:cleanup').length, 2);
    assert.equal(environment.calls.filter((call) => call === 'releaseController').length, 1);
    assert.equal(environment.calls.filter((call) => call === 'lease:release').length, 1);
    const callsAfterFailure = [...environment.calls];
    updatingMetadata.retainedKey.destroy();
    assert.deepEqual(environment.calls, callsAfterFailure);
  } finally {
    runtimeState.metadata = originalMetadata;
  }
});

test('annotation update destroys both renderers when metadata storage throws', () => {
  const cause = new Error('metadata set failed during update');
  const originalMetadata = runtimeState.metadata;
  const throwingMetadata = new ThrowingSetWeakMap(2, cause);
  const environment = annotationEnvironment();
  let controller;
  runtimeState.metadata = throwingMetadata;
  try {
    controller = createAnnotation(
      { name: 'initial' },
      { mark: 'underline' },
      environment.env,
    );
    environment.setPendingResidue(true);

    assert.throws(
      () => controller.update({ target: { name: 'replacement' } }),
      (error) => error instanceof HanamaruStateError
        && error.code === 'HANA_STATE_RUNTIME'
        && error.details.cause === cause,
    );

    assert.equal(controller.state, 'destroyed');
    assert.equal(readControllerMetadata(controller), undefined);
    assert.equal(environment.ownedCount, 0);
    assert.deepEqual(
      environment.calls
        .filter((call) => Array.isArray(call) && call[0] === 'renderer:destroy')
        .map(([, rendererId]) => rendererId)
        .sort(),
      [1, 2],
    );
    assert.equal(environment.calls.filter((call) => call === 'releaseController').length, 1);
    assert.equal(environment.calls.filter((call) => call === 'lease:release').length, 1);
  } finally {
    if (controller?.state !== 'destroyed') controller?.destroy();
    runtimeState.metadata = originalMetadata;
  }
});

test('annotation update contains a nested update accepted during metadata storage', () => {
  const originalMetadata = runtimeState.metadata;
  const updatingMetadata = new UpdatingSetWeakMap(2, {
    target: { name: 'nested target' },
    note: 'nested update',
  });
  const environment = annotationEnvironment();
  let controller;
  runtimeState.metadata = updatingMetadata;
  try {
    controller = createAnnotation(
      { name: 'initial target' },
      { mark: 'underline', trigger: 'viewport' },
      environment.env,
    );
    environment.setPendingResidue(true);

    assert.throws(
      () => controller.update({
        target: { name: 'outer target' },
        note: 'outer update',
      }),
      (error) => error instanceof HanamaruStateError
        && error.code === 'HANA_STATE_RUNTIME',
    );

    assert.equal(updatingMetadata.setCalls, 3);
    assert.equal(controller.state, 'destroyed');
    assert.equal(updatingMetadata.retainedKey, controller);
    assert.equal(readControllerMetadata(controller), undefined);
    assert.equal(environment.ownedCount, 0);
    assert.deepEqual(
      environment.calls
        .filter((call) => Array.isArray(call) && call[0] === 'renderer:destroy')
        .map(([, rendererId]) => rendererId)
        .sort(),
      [1, 2, 3],
    );
    assert.equal(environment.calls.filter((call) => call === 'trigger:cleanup').length, 1);
    assert.equal(environment.calls.filter((call) => call === 'layout:cleanup').length, 3);
    assert.equal(environment.calls.filter((call) => call === 'releaseController').length, 1);
    assert.equal(environment.calls.filter((call) => call === 'lease:release').length, 1);
    const callsAfterFailure = [...environment.calls];
    controller.destroy();
    assert.deepEqual(environment.calls, callsAfterFailure);
  } finally {
    if (controller?.state !== 'destroyed') controller?.destroy();
    runtimeState.metadata = originalMetadata;
  }
});

test('annotation construction deletes metadata written after reentrant destroy', () => {
  const originalMetadata = runtimeState.metadata;
  const destroyingMetadata = new DestroyingSetWeakMap(1);
  const environment = annotationEnvironment();
  environment.setPendingResidue(true);
  runtimeState.metadata = destroyingMetadata;
  try {
    const controller = createAnnotation(
      { name: 'target' },
      { mark: 'underline' },
      environment.env,
    );

    assert.equal(controller.state, 'destroyed');
    assert.equal(readControllerMetadata(controller), undefined);
    assert.equal(environment.ownedCount, 0);
    assert.deepEqual(
      environment.calls.filter((call) => Array.isArray(call) && call[0] === 'renderer:destroy'),
      [['renderer:destroy', 1]],
    );
    assert.equal(environment.calls.filter((call) => call === 'releaseController').length, 1);
    assert.equal(environment.calls.filter((call) => call === 'lease:release').length, 1);
  } finally {
    runtimeState.metadata = originalMetadata;
  }
});

test('annotation update deletes metadata written after reentrant destroy', () => {
  const originalMetadata = runtimeState.metadata;
  const destroyingMetadata = new DestroyingSetWeakMap(2);
  const environment = annotationEnvironment();
  runtimeState.metadata = destroyingMetadata;
  try {
    const controller = createAnnotation(
      { name: 'initial' },
      { mark: 'underline' },
      environment.env,
    );
    environment.setPendingResidue(true);

    controller.update({ target: { name: 'replacement' } });

    assert.equal(controller.state, 'destroyed');
    assert.equal(readControllerMetadata(controller), undefined);
    assert.equal(environment.ownedCount, 0);
    assert.deepEqual(
      environment.calls
        .filter((call) => Array.isArray(call) && call[0] === 'renderer:destroy')
        .map(([, rendererId]) => rendererId)
        .sort(),
      [1, 2],
    );
  } finally {
    runtimeState.metadata = originalMetadata;
  }
});

test('reentrant destroy during update rebind cannot resurrect annotation metadata', () => {
  const environment = annotationEnvironment();
  const controller = createAnnotation(
    { name: 'initial' },
    { mark: 'underline' },
    environment.env,
  );
  environment.setPendingResidue(true);
  environment.setLayoutCleanup(() => controller.destroy());

  controller.update({ target: { name: 'replacement' } });

  assert.equal(controller.state, 'destroyed');
  assert.equal(readControllerMetadata(controller), undefined);
  assert.equal(environment.ownedCount, 0);
  assert.deepEqual(
    environment.calls
      .filter((call) => Array.isArray(call) && call[0] === 'renderer:destroy')
      .map(([, rendererId]) => rendererId)
      .sort(),
    [1, 2],
  );
});

test('reentrant destroy followed by layout rebind failure cleans each renderer once', () => {
  const environment = annotationEnvironment();
  const controller = createAnnotation(
    { name: 'initial' },
    { mark: 'underline' },
    environment.env,
  );
  environment.setPendingResidue(true);
  environment.setLayoutCleanup(() => controller.destroy());
  environment.setRebindFailure(new Error('rebind failed after destroy'));

  controller.update({ target: { name: 'replacement' } });

  assert.equal(controller.state, 'destroyed');
  assert.equal(readControllerMetadata(controller), undefined);
  assert.equal(environment.ownedCount, 0);
  assert.deepEqual(
    environment.calls
      .filter((call) => Array.isArray(call) && call[0] === 'renderer:destroy')
      .map(([, rendererId]) => rendererId)
      .sort(),
    [1, 2],
  );
});

test('reentrant destroy during annotation trigger setup cannot create metadata', () => {
  const environment = annotationEnvironment();
  environment.setPendingResidue(true);
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
  assert.equal(environment.ownedCount, 0);
  assert.deepEqual(
    environment.calls.filter((call) => Array.isArray(call) && call[0] === 'renderer:destroy'),
    [['renderer:destroy', 1]],
  );
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

test('aggregates reject and roll back foreign members missing canonical metadata', () => {
  for (const [kind, construct] of [
    ['story', (members, env) => createStory(members, {}, env)],
    ['group', (members, env) => createGroup(members, {}, env)],
  ]) {
    const [first, second] = aggregateTargets();
    const environment = foreignAggregateEnvironment();

    assert.throws(
      () => construct([
        { target: first, mark: 'underline' },
        { target: second, mark: 'circle' },
      ], environment.env),
      (error) => error instanceof HanamaruStateError
        && error.code === 'HANA_STATE_RUNTIME'
        && error.details.cause instanceof TypeError,
      kind,
    );
    assert.equal(environment.annotations.length, 2, kind);
    assert.equal(environment.destroyed.length, 2, kind);
  }
});

test('explicit metadata opt-out supports only package-private lifecycle fakes', () => {
  for (const [kind, construct] of [
    ['story', (members, env) => createStory(members, {}, env)],
    ['group', (members, env) => createGroup(members, {}, env)],
  ]) {
    const [target] = aggregateTargets();
    const environment = foreignAggregateEnvironment({ recordMetadata: false });
    const controller = construct([
      { target, mark: 'underline' },
    ], environment.env);

    assert.equal(controller.state, 'idle', kind);
    assert.equal(readControllerMetadata(controller), undefined, kind);
    controller.destroy();
    assert.equal(environment.destroyed.length, 1, kind);
  }
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
    assert.deepEqual([...environment.destroyOrder].sort(), [0, 1], kind);
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

test('aggregate metadata written after reentrant destroy is deleted', () => {
  for (const [kind, construct] of [
    ['story', (members, env) => createStory(members, {}, env)],
    ['group', (members, env) => createGroup(members, {}, env)],
  ]) {
    const originalMetadata = runtimeState.metadata;
    const destroyingMetadata = new DestroyingSetWeakMap(3);
    const [first, second] = aggregateTargets();
    const environment = aggregateEnvironment();
    runtimeState.metadata = destroyingMetadata;
    try {
      const controller = construct([
        { target: first, mark: 'underline' },
        { target: second, mark: 'circle' },
      ], environment.env);

      assert.equal(controller.state, 'destroyed', kind);
      assert.equal(readControllerMetadata(controller), undefined, kind);
      assert.deepEqual(
        environment.annotations.map(readControllerMetadata),
        [undefined, undefined],
        kind,
      );
      assert.equal(
        environment.memberEnvironments.reduce(
          (count, member) => count + member.ownedCount,
          0,
        ),
        0,
        kind,
      );
    } finally {
      runtimeState.metadata = originalMetadata;
    }
  }
});

test('aggregate construction terminalizes controllers retained by throwing metadata stores', () => {
  for (const [kind, construct] of [
    ['story', (members, env) => createStory(members, {}, env)],
    ['group', (members, env) => createGroup(members, {}, env)],
  ]) {
    const cause = new Error(`${kind} metadata retained controller before throwing`);
    const originalMetadata = runtimeState.metadata;
    const retainingMetadata = new RetainingThrowingSetWeakMap(2, cause);
    const [target] = aggregateTargets();
    const environment = aggregateEnvironment();
    runtimeState.metadata = retainingMetadata;
    try {
      assert.throws(
        () => construct([
          { target, mark: 'underline' },
        ], environment.env),
        (error) => error instanceof HanamaruStateError
          && error.code === 'HANA_STATE_RUNTIME'
          && error.details.cause === cause,
        kind,
      );

      assert.equal(retainingMetadata.retainedKey.state, 'destroyed', kind);
      assert.equal(readControllerMetadata(retainingMetadata.retainedKey), undefined, kind);
      assert.equal(readControllerMetadata(environment.annotations[0]), undefined, kind);
      assert.equal(environment.memberEnvironments[0].ownedCount, 0, kind);
      const destroyOrderAfterFailure = [...environment.destroyOrder];
      retainingMetadata.retainedKey.destroy();
      assert.deepEqual(environment.destroyOrder, destroyOrderAfterFailure, kind);
    } finally {
      runtimeState.metadata = originalMetadata;
    }
  }
});

test('aggregate destroy removes its metadata and every member record', () => {
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
    assert.deepEqual([...environment.destroyOrder].sort(), [0, 1, 2], kind);
    assert.doesNotThrow(() => controller.destroy());
    assert.deepEqual([...environment.destroyOrder].sort(), [0, 1, 2], kind);
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
