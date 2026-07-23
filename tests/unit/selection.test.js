import assert from 'node:assert/strict';
import test from 'node:test';

import { HanamaruTargetError } from '../../src/errors.js';
import { annotateSelection, annotateSelectionWithEnvironment } from '../../src/selection.js';

class FakeSelection {
  constructor(ranges = []) {
    this.ranges = ranges;
  }

  get rangeCount() {
    return this.ranges.length;
  }

  getRangeAt(index) {
    return this.ranges[index];
  }
}

function documentRoot(name) {
  return { name, nodeType: 9 };
}

function boundary(root, { connected = true, document = root } = {}) {
  return {
    isConnected: connected,
    ownerDocument: document,
    getRootNode() { return root; },
  };
}

function range({
  collapsed = false,
  startRoot = documentRoot('start'),
  endRoot = startRoot,
  startConnected = true,
  endConnected = true,
  startDocument = startRoot,
  endDocument = endRoot,
} = {}) {
  return {
    collapsed,
    startContainer: boundary(startRoot, { connected: startConnected, document: startDocument }),
    endContainer: boundary(endRoot, { connected: endConnected, document: endDocument }),
  };
}

function environment({ selection = null, root = documentRoot('expected') } = {}) {
  const view = {
    Selection: FakeSelection,
    getSelection() { return selection; },
  };
  return {
    createAnnotation() { throw new Error('createAnnotation must not run during validation'); },
    root,
    view,
  };
}

function assertTargetError(action, code, details) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof HanamaruTargetError);
    assert.equal(error.code, code);
    assert.deepEqual(error.details, details);
    assert.ok(Object.values(error.details ?? {}).every((value) => (
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    )));
    return true;
  });
}

test('reads only the injected view selection and rejects an unavailable default selection', () => {
  const env = environment({ selection: null });

  assertTargetError(
    () => annotateSelectionWithEnvironment({ mark: 'underline' }, undefined, env),
    'HANA_TARGET_SELECTION_UNAVAILABLE',
    {},
  );
});

test('reports unavailable Selection in a non-browser realm without a native reference failure', () => {
  assertTargetError(
    () => annotateSelection({ mark: 'underline' }),
    'HANA_TARGET_SELECTION_UNAVAILABLE',
    {},
  );
});

test('rejects a genuine Selection with no ranges as empty', () => {
  const env = environment();

  assertTargetError(
    () => annotateSelectionWithEnvironment({ mark: 'underline' }, new FakeSelection(), env),
    'HANA_TARGET_SELECTION_EMPTY',
    { rangeCount: 0 },
  );
});

test('rejects a collapsed Selection range as empty', () => {
  const root = documentRoot('expected');
  const env = environment({ root });

  assertTargetError(
    () => annotateSelectionWithEnvironment(
      { mark: 'underline' },
      new FakeSelection([range({ collapsed: true, startRoot: root })]),
      env,
    ),
    'HANA_TARGET_SELECTION_EMPTY',
    { collapsed: true },
  );
});

test('rejects multiple Selection ranges as ambiguous', () => {
  const root = documentRoot('expected');
  const env = environment({ root });

  assertTargetError(
    () => annotateSelectionWithEnvironment(
      { mark: 'underline' },
      new FakeSelection([range({ startRoot: root }), range({ startRoot: root })]),
      env,
    ),
    'HANA_TARGET_SELECTION_AMBIGUOUS',
    { rangeCount: 2 },
  );
});

test('rejects disconnected Selection boundaries', () => {
  const root = documentRoot('expected');
  const env = environment({ root });

  assertTargetError(
    () => annotateSelectionWithEnvironment(
      { mark: 'underline' },
      new FakeSelection([range({ startRoot: root, endConnected: false })]),
      env,
    ),
    'HANA_TARGET_INVALID',
    { startRoot: 'document', endRoot: 'document' },
  );
});

test('rejects Selection boundaries from different Documents', () => {
  const root = documentRoot('expected');
  const other = documentRoot('other');
  const env = environment({ root });

  assertTargetError(
    () => annotateSelectionWithEnvironment(
      { mark: 'underline' },
      new FakeSelection([range({ startRoot: root, endRoot: other, endDocument: other })]),
      env,
    ),
    'HANA_TARGET_INVALID',
    { startRoot: 'document', endRoot: 'document' },
  );
});

test('rejects Selection boundaries in different DOM roots', () => {
  const root = documentRoot('expected');
  const shadow = { host: {}, nodeType: 11 };
  const env = environment({ root });

  assertTargetError(
    () => annotateSelectionWithEnvironment(
      { mark: 'underline' },
      new FakeSelection([range({ startRoot: root, endRoot: shadow, endDocument: root })]),
      env,
    ),
    'HANA_TARGET_INVALID',
    { startRoot: 'document', endRoot: 'shadow-root' },
  );
});

test('clones one accepted range once before delegating the exact options', () => {
  const root = documentRoot('expected');
  const source = range({ startRoot: root });
  const clone = range({ startRoot: root });
  const calls = [];
  const options = { mark: 'underline', note: 'Keep this exact object' };
  const controller = { state: 'idle' };
  source.cloneRange = () => {
    calls.push('clone');
    return clone;
  };
  const env = {
    createAnnotation(target, suppliedOptions) {
      calls.push('create');
      assert.equal(target, clone);
      assert.equal(suppliedOptions, options);
      return controller;
    },
    root,
    view: { Selection: FakeSelection, getSelection() { return null; } },
  };

  const result = annotateSelectionWithEnvironment(options, new FakeSelection([source]), env);

  assert.equal(result, controller);
  assert.deepEqual(calls, ['clone', 'create']);
});

test('delegates a stable clone without retaining or changing the host Selection or source Range', () => {
  const root = documentRoot('expected');
  const source = range({ startRoot: root });
  const clone = range({ startRoot: root });
  const selection = new FakeSelection([source]);
  let delegated;
  source.cloneRange = () => clone;
  const env = {
    createAnnotation(target) {
      delegated = target;
      return { state: 'idle' };
    },
    root,
    view: { Selection: FakeSelection, getSelection() { return selection; } },
  };
  const before = {
    end: source.endContainer,
    range: selection.ranges[0],
    start: source.startContainer,
  };

  annotateSelectionWithEnvironment({ mark: 'underline' }, undefined, env);
  const replacement = range({ startRoot: root });
  selection.ranges[0] = replacement;
  source.startContainer = replacement.startContainer;

  assert.equal(selection.ranges[0], replacement);
  assert.equal(source.endContainer, before.end);
  assert.equal(source.startContainer, replacement.startContainer);
  assert.equal(before.range, source);
  assert.equal(delegated, clone);
  assert.notEqual(delegated, source);
  assert.notEqual(delegated.startContainer, source.startContainer);
});

test('rejects an accepted standalone ShadowRoot selection before delegation', () => {
  const document = documentRoot('document');
  const shadow = { host: {}, nodeType: 11 };
  const source = range({ startRoot: shadow, endRoot: shadow, startDocument: document, endDocument: document });
  source.cloneRange = () => { throw new Error('must not clone an unscoped Shadow selection'); };
  const env = {
    createAnnotation() { throw new Error('must not delegate an unscoped Shadow selection'); },
    view: { Selection: FakeSelection, getSelection() { return null; } },
  };

  assertTargetError(
    () => annotateSelectionWithEnvironment({ mark: 'underline' }, new FakeSelection([source]), env),
    'HANA_TARGET_SHADOW_UNSCOPED',
    { startRoot: 'shadow-root', endRoot: 'shadow-root' },
  );
});
