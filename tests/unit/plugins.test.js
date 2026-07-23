import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnnotation, normalizeOptions } from '../../src/annotation.js';
import { scanDeclarative } from '../../src/declarative.js';
import { HanamaruConfigError, HanamaruStateError } from '../../src/errors.js';
import { buildMarkPaths, rect } from '../../src/geometry.js';
import * as Plugins from '../../src/plugins.js';
import { runtimeState } from '../../src/runtime-state.js';
import { acquireDocumentResources } from '../../src/scheduler.js';

const BUILT_INS = ['underline', 'highlight', 'circle', 'box', 'strike', 'bracket'];
const { registerMark } = Plugins;
let nextHarnessId = 0;

function assertConfigError(callback) {
  assert.throws(callback, (error) => (
    error instanceof HanamaruConfigError
    && error.code === 'HANA_CONFIG_INVALID'
  ));
}

function captured(name) {
  return runtimeState.plugins.get(name);
}

function render(name, factory, {
  rects = [rect(10, 20, 30, 8)],
  seed = 'seed',
  padding = 5,
} = {}) {
  const unregister = registerMark(name, factory);
  try {
    return buildMarkPaths(name, rects, seed, padding, captured(name));
  } finally {
    unregister();
  }
}

test('runtime state is one exact module-local singleton with the scheduler document store', () => {
  assert.deepEqual(Object.keys(Plugins), ['registerMark']);
  assert.deepEqual(Object.keys(runtimeState), ['plugins', 'metadata', 'documents', 'shadows']);
  assert.ok(runtimeState.plugins instanceof Map);
  assert.ok(runtimeState.metadata instanceof WeakMap);
  assert.ok(runtimeState.documents instanceof WeakMap);
  assert.ok(runtimeState.shadows instanceof WeakMap);
  assert.equal(globalThis.runtimeState, undefined);
});

test('scheduler acquisition stores and reference-counts resources in runtimeState.documents', () => {
  function node() {
    return {
      children: [],
      parent: null,
      append(...children) {
        for (const child of children) {
          child.parent = this;
          this.children.push(child);
        }
      },
      contains(candidate) {
        return this === candidate || this.children.some((child) => child.contains(candidate));
      },
      remove() {
        const index = this.parent?.children.indexOf(this) ?? -1;
        if (index !== -1) this.parent.children.splice(index, 1);
        this.parent = null;
      },
      setAttribute() {},
    };
  }
  const body = node();
  const doc = {
    nodeType: 9,
    body,
    createElement() { return node(); },
    createElementNS() { return node(); },
    defaultView: {
      requestAnimationFrame() { return 1; },
      cancelAnimationFrame() {},
      addEventListener() {},
      removeEventListener() {},
    },
  };

  const first = acquireDocumentResources(doc);
  const second = acquireDocumentResources(doc);
  assert.equal(runtimeState.documents.get(doc).shared, first.shared);
  assert.equal(first.shared, second.shared);
  first.release();
  assert.equal(runtimeState.documents.has(doc), true);
  second.release();
  assert.equal(runtimeState.documents.has(doc), false);
  assert.equal(body.children.length, 0);
});

test('registerMark enforces the exact name grammar, cap, built-ins, and factory type', () => {
  for (const name of [
    '', '1mark', '-mark', 'mark-', 'two--marks', 'Upper', 'under_score',
    'with space', 'éclair', 'a'.repeat(49), null, undefined, 3,
  ]) {
    assertConfigError(() => registerMark(name, () => ({ paths: ['M 0 0'] })));
  }
  for (const name of BUILT_INS) {
    assertConfigError(() => registerMark(name, () => ({ paths: ['M 0 0'] })));
  }
  for (const factory of [null, {}, 'factory']) {
    assertConfigError(() => registerMark('valid-name', factory));
  }

  for (const name of ['a', 'a1', 'a-b', 'a'.repeat(48)]) {
    const unregister = registerMark(name, () => ({ paths: ['M 0 0'] }));
    unregister();
  }
});

test('duplicates reject and unregister is idempotent and identity-capturing', () => {
  const first = () => ({ paths: ['M 0 0'] });
  const second = () => ({ paths: ['M 1 1'] });
  const stale = registerMark('identity-mark', first);

  assertConfigError(() => registerMark('identity-mark', second));
  stale();
  const current = registerMark('identity-mark', second);
  stale();
  assert.equal(captured('identity-mark').factory, second);
  current();
  current();
  assert.equal(captured('identity-mark'), undefined);
});

test('factory receives only deeply frozen copied numeric geometry and deterministic helpers', () => {
  const inputRects = [rect(1, 2, 3, 4), rect(10, 12, 5, 6)];
  let context;
  const paths = render('context-mark', (value) => {
    context = value;
    return { paths: [value.helpers.line(
      { x: value.rects[0].left, y: value.rects[0].bottom },
      { x: value.rects[0].right, y: value.rects[0].bottom },
    )] };
  }, { rects: inputRects, seed: 'seed', padding: 7 });

  assert.deepEqual(Object.keys(context), ['rects', 'unionRect', 'seed', 'padding', 'helpers']);
  assert.deepEqual(Object.keys(context.helpers), ['jitter', 'line', 'closedPath']);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.rects), true);
  assert.equal(Object.isFrozen(context.rects[0]), true);
  assert.equal(Object.isFrozen(context.unionRect), true);
  assert.equal(Object.isFrozen(context.helpers), true);
  assert.notEqual(context.rects, inputRects);
  assert.notEqual(context.rects[0], inputRects[0]);
  assert.deepEqual(context.rects, inputRects);
  assert.deepEqual(context.unionRect, rect(1, 2, 14, 16));
  assert.equal(context.seed, 'seed');
  assert.equal(context.padding, 7);
  assert.equal('document' in context, false);
  assert.equal('renderer' in context, false);
  assert.equal('registry' in context, false);
  assert.deepEqual(paths, ['M 0.39 5.4 Q 2.09 5.58 3.29 5.28']);
});

test('helpers have exact FNV, rounding, line, and closed-path golden bytes and bounds', () => {
  let helpers;
  render('helper-golden', ({ helpers: value }) => {
    helpers = value;
    return { paths: ['M 0 0'] };
  }, { seed: 'seed' });

  assert.equal(helpers.jitter('line:start:x', 1), -0.61);
  assert.equal(helpers.jitter('line:start:y', 1), -0.6);
  assert.equal(helpers.jitter('zero', 0), 0);
  assert.equal(Object.is(helpers.jitter('zero', 0), -0), false);
  for (let index = 0; index < 100; index += 1) {
    const value = helpers.jitter(`bound:${index}`, 2.25);
    assert.ok(value >= -2.25 && value <= 2.25);
    assert.ok(Number.isFinite(value));
  }
  assert.equal(
    helpers.line({ x: 1.25, y: -0.25 }, { x: 10.75, y: 5.5 }),
    'M 0.64 -0.85 Q 5.59 2.21 10.04 4.78',
  );
  assert.equal(
    helpers.closedPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }]),
    'M 0.79 0.8 L 9.72 -0.29 L 5.46 8.47 Z',
  );
});

test('line keeps extreme finite midpoints finite and hashes surrogate-pair labels by UTF-16 code unit', () => {
  let helpers;
  render('surrogate-jitter-golden', ({ helpers: value }) => {
    helpers = value;
    return { paths: ['M 0 0'] };
  }, { seed: 'seed' });
  assert.equal(helpers.jitter('😀', 2), 1.87);

  const maximum = Number.MAX_VALUE;
  const encoded = String(maximum);
  const paths = render('finite-extreme-lines', ({ helpers: value }) => ({
    paths: [
      value.line(
        { x: maximum, y: maximum },
        { x: maximum, y: maximum },
        { label: 'max', wobble: 0 },
      ),
      value.line(
        { x: -maximum, y: -maximum },
        { x: -maximum, y: -maximum },
        { label: 'min', wobble: 0 },
      ),
      value.line(
        { x: maximum, y: maximum },
        { x: -maximum, y: -maximum },
        { label: 'mixed', wobble: 0 },
      ),
    ],
  }));
  assert.deepEqual(paths, [
    `M ${encoded} ${encoded} Q ${encoded} ${encoded} ${encoded} ${encoded}`,
    `M -${encoded} -${encoded} Q -${encoded} -${encoded} -${encoded} -${encoded}`,
    `M ${encoded} ${encoded} Q 0 0 -${encoded} -${encoded}`,
  ]);
});

test('helpers validate finite points/options and never mutate their inputs', () => {
  let helpers;
  render('helper-validation', ({ helpers: value }) => {
    helpers = value;
    return { paths: ['M 0 0'] };
  });
  const start = { x: 1, y: 2 };
  const end = { x: 3, y: 4 };
  const options = { label: 'stable', wobble: 1.5 };
  const points = [start, end, { x: 5, y: 6 }];
  const before = structuredClone({ start, end, options, points });

  helpers.line(start, end, options);
  helpers.closedPath(points, options);
  assert.deepEqual({ start, end, options, points }, before);

  for (const callback of [
    () => helpers.jitter('x', -1),
    () => helpers.jitter('x', Infinity),
    () => helpers.jitter(1, 1),
    () => helpers.line({ x: Infinity, y: 0 }, end),
    () => helpers.line(start, { x: 0, y: NaN }),
    () => helpers.line(start, end, { wobble: -1 }),
    () => helpers.line(start, end, { wobble: Infinity }),
    () => helpers.line(start, end, { label: 1 }),
    () => helpers.closedPath([start, end]),
    () => helpers.closedPath([start, end, { x: 0, y: Infinity }]),
  ]) {
    assertConfigError(callback);
  }
});

test('helper options distinguish absent properties from explicit nullish values', () => {
  let helpers;
  render('helper-nullish-options', ({ helpers: value }) => {
    helpers = value;
    return { paths: ['M 0 0'] };
  });
  const start = { x: 0, y: 0 };
  const end = { x: 1, y: 1 };
  for (const options of [
    { label: null },
    { label: undefined },
    { wobble: null },
    { wobble: undefined },
  ]) {
    assertConfigError(() => helpers.line(start, end, options));
  }
  assert.doesNotThrow(() => helpers.line(start, end, {}));
});

test('closedPath rejects sparse point arrays without filling or mutating holes', () => {
  let helpers;
  render('closed-sparse-points', ({ helpers: value }) => {
    helpers = value;
    return { paths: ['M 0 0'] };
  });
  const points = [{ x: 0, y: 0 }, , { x: 2, y: 2 }];
  const keys = Reflect.ownKeys(points);

  assertConfigError(() => helpers.closedPath(points));
  assert.deepEqual(Reflect.ownKeys(points), keys);
  assert.equal(Object.hasOwn(points, 1), false);
});

test('closedPath rejects accessor point indices without invoking their getters', () => {
  let helpers;
  render('closed-accessor-points', ({ helpers: value }) => {
    helpers = value;
    return { paths: ['M 0 0'] };
  });
  let getterCalls = 0;
  const points = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }];
  Object.defineProperty(points, 1, {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { x: 1, y: 1 };
    },
  });

  assertConfigError(() => helpers.closedPath(points));
  assert.equal(getterCalls, 0);
});

test('factory results require one own data paths property on a plain object', () => {
  const hostile = [];
  hostile.push(null, [], { paths: ['M 0 0'], extra: true }, { paths: [] });
  hostile.push(Object.assign(Object.create({ inherited: true }), { paths: ['M 0 0'] }));
  const accessor = {};
  Object.defineProperty(accessor, 'paths', { enumerable: true, get() { return ['M 0 0']; } });
  hostile.push(accessor);
  const hiddenExtra = { paths: ['M 0 0'] };
  Object.defineProperty(hiddenExtra, 'extra', { value: true });
  hostile.push(hiddenExtra);
  hostile.push({ paths: ['M 0 0'], [Symbol('extra')]: true });

  for (const [index, result] of hostile.entries()) {
    assert.throws(
      () => render(`hostile-${index}`, () => result),
      (error) => error instanceof HanamaruStateError
        && error.code === 'HANA_STATE_MARK_PLUGIN'
        && error.details.mark === `hostile-${index}`
        && error.details.cause instanceof HanamaruConfigError,
    );
  }
});

test('hostile result and helper accessors are rejected without invoking getters', () => {
  let resultGetterCalls = 0;
  const result = {};
  Object.defineProperty(result, 'paths', {
    enumerable: true,
    get() {
      resultGetterCalls += 1;
      throw new Error('result getter must not run');
    },
  });
  assert.throws(
    () => render('accessor-result', () => result),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_MARK_PLUGIN'
      && error.details.mark === 'accessor-result'
      && error.details.cause instanceof HanamaruConfigError,
  );
  assert.equal(resultGetterCalls, 0);

  let helperGetterCalls = 0;
  let helpers;
  render('accessor-helpers', ({ helpers: value }) => {
    helpers = value;
    return { paths: ['M 0 0'] };
  });
  const accessorPoint = { y: 0 };
  Object.defineProperty(accessorPoint, 'x', {
    enumerable: true,
    get() {
      helperGetterCalls += 1;
      return 0;
    },
  });
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, 'label', {
    enumerable: true,
    get() {
      helperGetterCalls += 1;
      return 'unsafe';
    },
  });
  assertConfigError(() => helpers.line(accessorPoint, { x: 1, y: 1 }));
  assertConfigError(() => helpers.line({ x: 0, y: 0 }, { x: 1, y: 1 }, accessorOptions));
  assert.equal(helperGetterCalls, 0);
});

test('factory path output is syntax checked and cost bounded before return', () => {
  const invalidPaths = [
    [''],
    ['   '],
    Array(33).fill('M 0 0'),
    ['M 0 0 '.repeat(3000)],
    ['M NaN 0'],
    ['M Infinity 0'],
    ['M 0 0 nope'],
    ['L 0 0'],
    ['M 0'],
    ['M 0 0 Z 1'],
    ['M 0 0 A 1 1 0 2 0 4 4'],
  ];
  for (const [index, paths] of invalidPaths.entries()) {
    assert.throws(
      () => render(`invalid-path-${index}`, () => ({ paths })),
      (error) => error instanceof HanamaruStateError
        && error.code === 'HANA_STATE_MARK_PLUGIN'
        && error.details.mark === `invalid-path-${index}`,
    );
  }

  assert.deepEqual(render('valid-svg-grammar', () => ({
    paths: [
      'M0,0h10v10z',
      'M 1e1 -2.5 C 1 2 3 4 5 6 S 7 8 9 10 Q 1 2 3 4 T 5 6 A 2 3 45 0 1 9 9',
    ],
  })), [
    'M0,0h10v10z',
    'M 1e1 -2.5 C 1 2 3 4 5 6 S 7 8 9 10 Q 1 2 3 4 T 5 6 A 2 3 45 0 1 9 9',
  ]);
});

test('SVG arc parser accepts compact lexical flags and preserves numeric grammar', () => {
  const paths = [
    'M0 0 A10 10 0 0 110 10',
    'M0,0A10,10,0,0,1,10,10',
    'M1e1-2a3 4 45 1 0-5.5 6.25 3 4 0 0 1 8 9',
    'M 0 0 a 4 5 0 01-6-7',
  ];
  assert.deepEqual(render('valid-arc-grammar', () => ({ paths })), paths);
});

test('SVG arc parser rejects flags that are numerically valid but lexically invalid', () => {
  for (const [index, flag] of ['1.0', '+1', '1e0', '-0'].entries()) {
    for (const [position, flags] of [[0, `${flag} 0`], [1, `0 ${flag}`]]) {
      assert.throws(
        () => render(`invalid-arc-flag-${index}-${position}`, () => ({
          paths: [`M0 0 A10 10 0 ${flags} 10 10`],
        })),
        (error) => error instanceof HanamaruStateError
          && error.code === 'HANA_STATE_MARK_PLUGIN'
          && error.details.cause instanceof HanamaruConfigError,
      );
    }
  }
});

test('SVG arc parser accepts non-negative absolute and relative radii in repeated groups', () => {
  const paths = [
    'M0 0 A0 +1e2 0 0 1 10 10',
    'M0 0 a1 2 0 0 1 3 4 0 5e1 0 1 0 6 7',
  ];
  assert.deepEqual(render('valid-arc-radii', () => ({ paths })), paths);
});

test('SVG arc parser rejects negative and lexical negative-zero radii in every group', () => {
  const paths = [
    'M0 0 A-1 2 0 0 1 3 4',
    'M0 0 A1 -0 0 0 1 3 4',
    'M0 0 a1 2 0 0 1 3 4 -2 5 0 1 0 6 7',
    'M0 0 a1 2 0 0 1 3 4 2 -0e0 0 1 0 6 7',
  ];
  for (const [index, path] of paths.entries()) {
    assert.throws(
      () => render(`invalid-arc-radius-${index}`, () => ({ paths: [path] })),
      (error) => error instanceof HanamaruStateError
        && error.code === 'HANA_STATE_MARK_PLUGIN'
        && error.details.cause instanceof HanamaruConfigError,
    );
  }
});

test('factory throws and invalid results preserve cause under the plugin state error', () => {
  const cause = new RangeError('factory exploded');
  assert.throws(
    () => render('throwing-mark', () => { throw cause; }),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_MARK_PLUGIN'
      && error.details.mark === 'throwing-mark'
      && error.details.cause === cause,
  );
});

function annotationHarness({ deferEnqueue = false, trackRendererHide = false } = {}) {
  const calls = [];
  const events = [];
  const jobs = [];
  const owner = { ownerDocument: { readyState: 'complete' } };
  const record = {
    element: owner,
    ownerElement: owner,
    range: null,
    rects: [rect(10, 20, 30, 8)],
    refresh() { return this; },
  };
  let generation = 0;
  let layoutBinding = null;
  let targetRectReads = 0;
  function execute(entries) {
    const reads = [];
    const readErrors = [];
    for (const entry of entries) {
      try {
        reads.push({ entry, value: entry.read() });
      } catch (error) {
        readErrors.push({ entry, error });
      }
    }
    for (const { entry, error } of readErrors) entry.onError?.(error);
    for (const { entry, value } of reads) {
      try {
        entry.write(value);
      } catch (error) {
        entry.onError?.(error);
      }
    }
  }
  const shared = {
    registerController() { return generation; },
    releaseController() {},
    bumpGeneration() { generation += 1; return generation; },
    observeLayout(binding) {
      layoutBinding = binding;
      return () => { if (layoutBinding === binding) layoutBinding = null; };
    },
    rebindLayout(_id, binding) {
      layoutBinding = binding;
      return () => { if (layoutBinding === binding) layoutBinding = null; };
    },
    enqueue(entry) {
      if (deferEnqueue) jobs.push(entry);
      else execute([entry]);
    },
  };
  const env = {
    id: `plugin-annotation-${++nextHarnessId}`,
    lease: { shared, release() {} },
    resolveTarget(target) { return target?.record ?? record; },
    targetRects(targetRecord) {
      targetRectReads += 1;
      return targetRecord.rects;
    },
    readThemeMetrics() { return { noteGap: 16 }; },
    reducedMotion() { return true; },
    createEvent(type, detail, eventOwner) { events.push({ type, detail, owner: eventOwner }); },
    createRenderer({ options }) {
      calls.push(['create', options.mark]);
      return {
        group: {},
        noteElement: null,
        measure() {
          return { noteRect: null, peerNoteRects: [], viewport: { width: 800, height: 600 } };
        },
        updateOwner() {},
        draw(layout) {
          calls.push(['draw', options.mark, layout.markPaths, layout.targetRects]);
        },
        animate() { return { finished: Promise.resolve() }; },
        finish() {},
        hide() {
          if (trackRendererHide) calls.push(['hide', options.mark]);
        },
        destroy() {},
      };
    },
  };
  return {
    calls,
    env,
    events,
    flush({ includeLayout = false } = {}) {
      const entries = jobs.splice(0);
      if (includeLayout && layoutBinding !== null) entries.push(layoutBinding);
      execute(entries);
    },
    owner,
    record,
    get targetRectReads() { return targetRectReads; },
  };
}

test('annotations capture custom factories across unregister, refresh, replay, and same-mark update', () => {
  let factoryCalls = 0;
  const unregister = registerMark('captured-mark', ({ helpers }) => {
    factoryCalls += 1;
    return { paths: [helpers.line({ x: 0, y: 0 }, { x: 5, y: 5 })] };
  });
  const harness = annotationHarness();
  const controller = createAnnotation(harness.owner, { mark: 'captured-mark' }, harness.env);
  unregister();

  assert.equal(factoryCalls, 0);
  controller.show();
  assert.equal(factoryCalls, 1);
  controller.refresh();
  assert.equal(factoryCalls, 2);
  controller.replay();
  assert.equal(factoryCalls, 3);
  controller.update({ mark: 'captured-mark' });
  assert.equal(factoryCalls, 4);
  controller.refresh();
  assert.equal(factoryCalls, 5);
  assert.equal(controller.state, 'visible');
  controller.destroy();
  assertConfigError(() => createAnnotation(
    harness.owner,
    { mark: 'captured-mark' },
    annotationHarness().env,
  ));
});

test('visible custom update redraws its validated snapshot once before later refresh invokes again', () => {
  let factoryCalls = 0;
  const laterCause = new Error('only a later refresh may fail');
  const unregister = registerMark('single-update-snapshot', () => {
    factoryCalls += 1;
    if (factoryCalls === 3) throw laterCause;
    return { paths: [`M ${factoryCalls} 0 L ${factoryCalls} 1`] };
  });
  const harness = annotationHarness();
  const controller = createAnnotation(
    harness.owner,
    { mark: 'single-update-snapshot', seed: 'before' },
    harness.env,
  );
  controller.show();
  const finished = controller.finished;
  assert.equal(factoryCalls, 1);
  assert.deepEqual(harness.calls.at(-1)[2], ['M 1 0 L 1 1']);

  controller.update({ seed: 'after' });

  assert.equal(factoryCalls, 2);
  assert.equal(controller.state, 'visible');
  assert.equal(controller.finished, finished);
  assert.deepEqual(harness.calls.at(-1)[2], ['M 2 0 L 2 1']);
  assert.equal(Object.isFrozen(harness.calls.at(-1)[2]), true);

  controller.refresh();

  assert.equal(factoryCalls, 3);
  assert.equal(controller.state, 'suspended');
  assert.equal(harness.events.at(-1).type, 'hana:error');
  assert.equal(harness.events.at(-1).detail.error.code, 'HANA_STATE_MARK_PLUGIN');
  assert.equal(harness.events.at(-1).detail.error.details.cause, laterCause);
  controller.destroy();
  unregister();
});

test('update lifecycle and layout reads in one frame share one validated snapshot', () => {
  let factoryCalls = 0;
  const unregister = registerMark('shared-frame-snapshot', () => {
    factoryCalls += 1;
    return { paths: [`M ${factoryCalls} 0 L ${factoryCalls} 1`] };
  });
  const harness = annotationHarness({ deferEnqueue: true });
  const controller = createAnnotation(
    harness.owner,
    { mark: 'shared-frame-snapshot', seed: 'before' },
    harness.env,
  );
  controller.show();
  harness.flush();
  assert.equal(factoryCalls, 1);

  controller.update({ seed: 'after' });
  assert.equal(factoryCalls, 2);
  harness.flush({ includeLayout: true });

  assert.equal(factoryCalls, 2);
  assert.equal(controller.state, 'visible');
  assert.deepEqual(harness.calls.at(-1)[2], ['M 2 0 L 2 1']);
  controller.destroy();
  unregister();
});

test('update rebuilds custom paths once when geometry changes before the deferred frame', () => {
  let factoryCalls = 0;
  const unregister = registerMark('update-reflow-snapshot', ({ rects }) => {
    factoryCalls += 1;
    return { paths: [`M ${rects[0].left} 0 L ${rects[0].right} 1`] };
  });
  const harness = annotationHarness({ deferEnqueue: true });
  const controller = createAnnotation(
    harness.owner,
    { mark: 'update-reflow-snapshot', seed: 'before' },
    harness.env,
  );
  controller.show();
  harness.flush();
  assert.equal(factoryCalls, 1);

  controller.update({ seed: 'after' });
  assert.equal(factoryCalls, 2);
  const updateDrawStart = harness.calls.length;
  const mutableRect = harness.record.rects[0];
  mutableRect.x = 100;
  mutableRect.left = 100;
  mutableRect.right = 130;
  harness.flush({ includeLayout: true });

  assert.equal(factoryCalls, 3);
  const updateDraws = harness.calls
    .slice(updateDrawStart)
    .filter(([name]) => name === 'draw');
  assert.ok(updateDraws.length > 0);
  for (const draw of updateDraws) {
    assert.equal(Object.isFrozen(draw[3]), true);
    assert.equal(Object.isFrozen(draw[3][0]), true);
    assert.equal(draw[3][0].left, 100);
    assert.deepEqual(draw[2], ['M 100 0 L 130 1']);
  }

  controller.refresh();
  harness.flush();
  assert.equal(factoryCalls, 4);
  assert.equal(harness.calls.at(-1)[3][0].left, 100);
  assert.deepEqual(harness.calls.at(-1)[2], ['M 100 0 L 130 1']);
  controller.destroy();
  unregister();
});

test('same-frame sibling reads do not retry or report a failed update reflow', async () => {
  let factoryCalls = 0;
  const reflowCause = new Error('reflow rejected');
  const unregister = registerMark('failed-update-reflow', ({ rects }) => {
    factoryCalls += 1;
    if (rects[0].left === 100) throw reflowCause;
    return { paths: [`M ${rects[0].left} 0 L ${rects[0].right} 1`] };
  });
  const harness = annotationHarness({
    deferEnqueue: true,
    trackRendererHide: true,
  });
  const controller = createAnnotation(
    harness.owner,
    { mark: 'failed-update-reflow', seed: 'before' },
    harness.env,
  );
  controller.show();
  harness.flush();
  await controller.finished;
  assert.equal(factoryCalls, 1);

  controller.update({ seed: 'after' });
  assert.equal(factoryCalls, 2);
  assert.equal(harness.targetRectReads, 2);
  const drawCount = harness.calls.filter(([name]) => name === 'draw').length;
  const hideCount = harness.calls.filter(([name]) => name === 'hide').length;
  harness.record.rects = [rect(100, 20, 30, 8)];
  harness.flush({ includeLayout: true });

  assert.equal(factoryCalls, 3);
  assert.equal(harness.targetRectReads, 3);
  assert.equal(controller.state, 'suspended');
  assert.equal(
    harness.calls.filter(([name]) => name === 'draw').length,
    drawCount,
  );
  assert.equal(
    harness.calls.filter(([name]) => name === 'hide').length,
    hideCount + 1,
  );
  assert.equal(harness.events.filter(({ type }) => type === 'hana:error').length, 1);
  const error = harness.events.find(({ type }) => type === 'hana:error').detail.error;
  assert.equal(error.code, 'HANA_STATE_MARK_PLUGIN');
  assert.equal(error.details.cause, reflowCause);
  controller.destroy();
  unregister();
});

test('update geometry snapshots detect multiple rect order and length changes', () => {
  let factoryCalls = 0;
  const unregister = registerMark('update-range-snapshot', ({ rects }) => {
    factoryCalls += 1;
    return {
      paths: rects.map((item) => `M ${item.left} 0 L ${item.right} 1`),
    };
  });
  const harness = annotationHarness({ deferEnqueue: true });
  harness.record.rects = [rect(10, 20, 30, 8), rect(60, 20, 20, 8)];
  const controller = createAnnotation(
    harness.owner,
    { mark: 'update-range-snapshot', seed: 'before' },
    harness.env,
  );
  controller.show();
  harness.flush();
  assert.equal(factoryCalls, 1);

  controller.update({ seed: 'order' });
  assert.equal(factoryCalls, 2);
  harness.record.rects.reverse();
  harness.flush({ includeLayout: true });
  assert.equal(factoryCalls, 3);
  assert.deepEqual(
    harness.calls.at(-1)[2],
    ['M 60 0 L 80 1', 'M 10 0 L 40 1'],
  );

  controller.update({ seed: 'length' });
  assert.equal(factoryCalls, 4);
  harness.record.rects.push(rect(100, 20, 10, 8));
  harness.flush({ includeLayout: true });
  assert.equal(factoryCalls, 5);
  assert.deepEqual(
    harness.calls.at(-1)[2],
    ['M 60 0 L 80 1', 'M 10 0 L 40 1', 'M 100 0 L 110 1'],
  );
  controller.destroy();
  unregister();
});

test('idle custom update validates once but discards its snapshot before a later show', () => {
  let factoryCalls = 0;
  const unregister = registerMark('idle-update-snapshot', () => {
    factoryCalls += 1;
    return { paths: [`M ${factoryCalls} 0 L ${factoryCalls} 1`] };
  });
  const harness = annotationHarness();
  const controller = createAnnotation(
    harness.owner,
    { mark: 'idle-update-snapshot', seed: 'before' },
    harness.env,
  );

  controller.update({ seed: 'after' });
  assert.equal(factoryCalls, 1);
  assert.equal(controller.state, 'idle');

  controller.show();
  assert.equal(factoryCalls, 2);
  assert.deepEqual(harness.calls.at(-1)[2], ['M 2 0 L 2 1']);
  controller.destroy();
  unregister();
});

test('visible change from built-in to custom draws the one validated factory snapshot', () => {
  let factoryCalls = 0;
  const duplicateCause = new Error('factory invoked twice for one update');
  const unregister = registerMark('change-update-snapshot', () => {
    factoryCalls += 1;
    if (factoryCalls > 1) throw duplicateCause;
    return { paths: ['M 7 0 L 7 1'] };
  });
  const harness = annotationHarness();
  const controller = createAnnotation(harness.owner, { mark: 'box' }, harness.env);
  controller.show();

  controller.update({ mark: 'change-update-snapshot' });

  assert.equal(factoryCalls, 1);
  assert.equal(controller.state, 'visible');
  assert.deepEqual(harness.calls.at(-1)[2], ['M 7 0 L 7 1']);
  controller.destroy();
  unregister();
});

test('changing away releases capture and changing back requires a fresh registration', () => {
  const unregister = registerMark('released-mark', () => ({ paths: ['M 0 0 L 1 1'] }));
  const harness = annotationHarness();
  const controller = createAnnotation(harness.owner, { mark: 'released-mark' }, harness.env);
  unregister();
  controller.update({ mark: 'box' });

  assertConfigError(() => controller.update({ mark: 'released-mark' }));
  controller.show();
  assert.deepEqual(harness.calls.at(-1)[2], buildMarkPaths('box', [rect(10, 20, 30, 8)], harness.env.id));
  controller.destroy();
});

test('mark-changing update preflights plugin output transactionally', () => {
  const unregisterStable = registerMark('stable-mark', () => ({ paths: ['M 0 0 L 1 1'] }));
  const originalCause = new Error('bad next mark');
  const unregisterBroken = registerMark('broken-mark', () => { throw originalCause; });
  const harness = annotationHarness();
  const controller = createAnnotation(harness.owner, { mark: 'stable-mark' }, harness.env);
  controller.show();
  const previousDraw = harness.calls.at(-1);
  const previousState = controller.state;

  assert.throws(
    () => controller.update({ mark: 'broken-mark' }),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_MARK_PLUGIN'
      && error.details.mark === 'broken-mark'
      && error.details.cause === originalCause,
  );
  assert.equal(controller.state, previousState);
  controller.refresh();
  assert.deepEqual(harness.calls.at(-1), previousDraw);

  controller.destroy();
  unregisterStable();
  unregisterBroken();
});

test('same custom mark updates preflight seed and target changes without corrupting visible state', () => {
  const seedCause = new Error('seed rejected');
  const targetCause = new Error('target rejected');
  const unregister = registerMark('same-mark-transaction', ({ rects, seed }) => {
    if (seed === 'bad-seed') throw seedCause;
    if (rects[0].left === 99) throw targetCause;
    return { paths: [`M ${rects[0].left} 0 L ${rects[0].right} 1`] };
  });
  const harness = annotationHarness();
  const controller = createAnnotation(
    harness.owner,
    { mark: 'same-mark-transaction', seed: 'good-seed' },
    harness.env,
  );
  controller.show();
  const priorFinished = controller.finished;
  const priorDraw = harness.calls.at(-1);
  let priorDrawCount = harness.calls.filter(([name]) => name === 'draw').length;
  const priorCreateCount = harness.calls.filter(([name]) => name === 'create').length;
  const priorEventCount = harness.events.length;
  unregister();

  assert.throws(
    () => controller.update({ mark: 'same-mark-transaction', seed: 'bad-seed' }),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_MARK_PLUGIN'
      && error.details.cause === seedCause,
  );
  assert.equal(controller.state, 'visible');
  assert.equal(controller.finished, priorFinished);
  assert.equal(harness.calls.filter(([name]) => name === 'create').length, priorCreateCount);
  assert.equal(harness.calls.filter(([name]) => name === 'draw').length, priorDrawCount);
  assert.equal(harness.events.length, priorEventCount);
  controller.refresh();
  priorDrawCount += 1;
  assert.deepEqual(harness.calls.at(-1), priorDraw);

  const replacementOwner = { ownerDocument: harness.owner.ownerDocument };
  const replacement = {
    record: {
      element: replacementOwner,
      ownerElement: replacementOwner,
      range: null,
      rects: [rect(99, 20, 30, 8)],
      refresh() { return this; },
    },
  };
  assert.throws(
    () => controller.update({ target: replacement }),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_MARK_PLUGIN'
      && error.details.cause === targetCause,
  );
  assert.equal(controller.state, 'visible');
  assert.equal(controller.finished, priorFinished);
  assert.equal(harness.calls.filter(([name]) => name === 'create').length, priorCreateCount);
  assert.equal(harness.calls.filter(([name]) => name === 'draw').length, priorDrawCount);
  assert.equal(harness.events.length, priorEventCount);
  controller.refresh();
  assert.deepEqual(harness.calls.at(-1), priorDraw);
  controller.destroy();
});

test('declarative custom marks validate and capture through Annotation construction', () => {
  const unregister = registerMark('declarative-mark', () => ({ paths: ['M 0 0 L 2 2'] }));
  const harness = annotationHarness();
  const element = { ...harness.owner, dataset: { hana: 'declarative-mark' } };
  const result = scanDeclarative(
    { querySelectorAll() { return [element]; } },
    (target, options) => createAnnotation(target, options, harness.env),
  );
  unregister();

  assert.equal(result.errors.length, 0);
  result.annotations[0].show();
  assert.deepEqual(harness.calls.at(-1)[2], ['M 0 0 L 2 2']);
  result.annotations[0].destroy();
  assertConfigError(() => normalizeOptions({ mark: 'declarative-mark' }, 'seed'));
});
