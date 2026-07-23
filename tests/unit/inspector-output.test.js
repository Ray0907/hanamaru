import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRangeOutput,
  proveRangeLocator,
} from '../../demo/inspector-output.js';

function canonicalDefinition(text = 'exact', occurrence = 0) {
  return {
    schema: 'hanamaru/v1',
    kind: 'annotation',
    target: {
      type: 'locator',
      within: { type: 'selector', selector: '#inspector-document' },
      text,
      occurrence,
    },
    options: {
      mark: 'underline',
      note: null,
      placement: 'auto',
      trigger: 'manual',
      accessible: true,
      seed: 'proof',
      duration: 420,
      motion: 'system',
    },
  };
}

test('Range output is honest before a stable locator is proven', () => {
  const output = createRangeOutput({
    mark: 'underline',
    note: 'Review this',
    duration: 420,
  });

  assert.deepEqual(output.html, {
    available: false,
    code: '',
    reason: 'Unavailable for this Range: HTML cannot represent a Range without changing the document.',
  });
  assert.equal(output.javascript.available, true);
  assert.match(output.javascript.code, /annotateSelection\(/);
  assert.doesNotMatch(output.javascript.code, /\brestore\(/);
  assert.equal(output.javascript.reason, '');
  assert.deepEqual(output.json, {
    available: false,
    code: '',
    reason: 'Unavailable for this Range: an exact stable text locator has not been proven.',
  });
});

test('locator proof probes public resolver occurrences in order before update and serialize', () => {
  const start = { id: 'start' };
  const end = { id: 'end' };
  let cloneCalls = 0;
  const range = {
    cloneRange() {
      cloneCalls += 1;
      return {
        startContainer: start,
        startOffset: 2,
        endContainer: end,
        endOffset: 7,
      };
    },
  };
  const calls = [];
  const resolved = [
    {
      startContainer: { id: 'wrong' },
      startOffset: 2,
      endContainer: end,
      endOffset: 7,
    },
    {
      startContainer: start,
      startOffset: 2,
      endContainer: end,
      endOffset: 7,
    },
  ];
  const resolveSerializedTarget = (target) => {
    calls.push(['resolve', target]);
    return resolved[target.occurrence];
  };
  const controller = {
    update(patch) {
      calls.push(['update', patch]);
    },
  };
  const definition = {
    schema: 'hanamaru/v1',
    kind: 'annotation',
    target: {
      type: 'locator',
      within: { type: 'selector', selector: '#inspector-document' },
      text: 'same words',
      occurrence: 1,
    },
    options: {
      mark: 'underline',
      note: null,
      placement: 'auto',
      trigger: 'manual',
      accessible: true,
      seed: 'proof',
      duration: 420,
      motion: 'system',
    },
  };
  const serialize = (value) => {
    calls.push(['serialize', value]);
    return definition;
  };
  const previousOutput = createRangeOutput({ mark: 'underline' });

  const output = proveRangeLocator({
    range,
    selectedText: 'same words',
    controller,
    previousOutput,
    resolveSerializedTarget,
    serialize,
  });

  assert.equal(cloneCalls, 1);
  assert.deepEqual(calls, [
    ['resolve', {
      type: 'locator',
      within: { type: 'selector', selector: '#inspector-document' },
      text: 'same words',
      occurrence: 0,
    }],
    ['resolve', {
      type: 'locator',
      within: { type: 'selector', selector: '#inspector-document' },
      text: 'same words',
      occurrence: 1,
    }],
    ['update', {
      target: {
        within: '#inspector-document',
        text: 'same words',
        occurrence: 1,
      },
    }],
    ['serialize', controller],
  ]);
  assert.equal(output.html, previousOutput.html);
  assert.equal(output.javascript.available, true);
  assert.match(output.javascript.code, /\brestore\(/);
  assert.doesNotMatch(output.javascript.code, /annotateSelection\(/);
  assert.equal(output.json.available, true);
  assert.deepEqual(JSON.parse(output.json.code), definition);
});

test('first typed missing target stops probing without claiming persistence', () => {
  const node = { id: 'selected' };
  const range = {
    cloneRange() {
      return {
        startContainer: node,
        startOffset: 1,
        endContainer: node,
        endOffset: 4,
      };
    },
  };
  const occurrences = [];
  const previousOutput = createRangeOutput({ mark: 'circle' });
  const controller = {
    update() {
      assert.fail('missing proof must not update the controller');
    },
  };

  const output = proveRangeLocator({
    range,
    selectedText: 'word',
    controller,
    previousOutput,
    resolveSerializedTarget(target) {
      occurrences.push(target.occurrence);
      if (target.occurrence === 2) {
        throw Object.assign(new Error('not found'), { code: 'HANA_TARGET_MISSING' });
      }
      return {
        startContainer: node,
        startOffset: target.occurrence + 10,
        endContainer: node,
        endOffset: 20,
      };
    },
    serialize() {
      assert.fail('missing proof must not serialize the controller');
    },
  });

  assert.equal(output, previousOutput);
  assert.deepEqual(occurrences, [0, 1, 2]);
  assert.equal(output.json.available, false);
  assert.match(output.json.reason, /^Unavailable for this Range:/);
  assert.match(output.javascript.code, /annotateSelection\(/);
});

test('resolver errors other than typed missing targets are not swallowed', () => {
  const expected = new Error('resolver is unavailable');
  const range = {
    cloneRange() {
      return {
        startContainer: {},
        startOffset: 0,
        endContainer: {},
        endOffset: 1,
      };
    },
  };

  assert.throws(
    () => proveRangeLocator({
      range,
      selectedText: 'word',
      controller: { update() {} },
      previousOutput: createRangeOutput(),
      resolveSerializedTarget() {
        throw expected;
      },
      serialize() {},
    }),
    (error) => error === expected,
  );
});

test('failed controller update preserves the exact prior output model', () => {
  const node = { id: 'boundary' };
  const boundary = {
    startContainer: node,
    startOffset: 0,
    endContainer: node,
    endOffset: 5,
  };
  const range = {
    cloneRange() {
      return { ...boundary };
    },
  };
  const previousOutput = createRangeOutput({ mark: 'box' });
  let serializeCalls = 0;

  const output = proveRangeLocator({
    range,
    selectedText: 'exact',
    controller: {
      update() {
        throw new Error('target update rejected');
      },
    },
    previousOutput,
    resolveSerializedTarget() {
      return { ...boundary };
    },
    serialize() {
      serializeCalls += 1;
      return {};
    },
  });

  assert.equal(output, previousOutput);
  assert.equal(serializeCalls, 0);
  assert.equal(output.json.available, false);
  assert.doesNotMatch(output.javascript.code, /\brestore\(/);
});

test('serialize failure after an exact match preserves the exact prior output', () => {
  const node = { id: 'serialize-boundary' };
  const boundary = {
    startContainer: node,
    startOffset: 0,
    endContainer: node,
    endOffset: 5,
  };
  const previousOutput = createRangeOutput({ mark: 'bracket' });

  const output = proveRangeLocator({
    range: { cloneRange: () => ({ ...boundary }) },
    selectedText: 'exact',
    controller: { update() {} },
    previousOutput,
    resolveSerializedTarget: () => ({ ...boundary }),
    serialize() {
      throw new Error('controller cannot be serialized');
    },
  });

  assert.equal(output, previousOutput);
});

test('throwing toJSON during the stable snapshot preserves the exact prior output', () => {
  const node = { id: 'stringify-boundary' };
  const boundary = {
    startContainer: node,
    startOffset: 0,
    endContainer: node,
    endOffset: 5,
  };
  const previousOutput = createRangeOutput({ mark: 'strike' });

  const output = proveRangeLocator({
    range: { cloneRange: () => ({ ...boundary }) },
    selectedText: 'exact',
    controller: { update() {} },
    previousOutput,
    resolveSerializedTarget: () => ({ ...boundary }),
    serialize: () => ({
      toJSON() {
        throw new Error('snapshot failed');
      },
    }),
  });

  assert.equal(output, previousOutput);
});

test('output construction failure after serialization preserves the exact prior output', () => {
  const node = { id: 'format-boundary' };
  const boundary = {
    startContainer: node,
    startOffset: 0,
    endContainer: node,
    endOffset: 5,
  };
  const previousOutput = {
    get html() {
      throw new Error('output model is unavailable');
    },
    javascript: { available: true, code: 'prior', reason: '' },
    json: { available: false, code: '', reason: 'prior' },
  };

  const output = proveRangeLocator({
    range: { cloneRange: () => ({ ...boundary }) },
    selectedText: 'exact',
    controller: { update() {} },
    previousOutput,
    resolveSerializedTarget: () => ({ ...boundary }),
    serialize: () => ({
      schema: 'hanamaru/v1',
      kind: 'annotation',
      target: {
        type: 'locator',
        within: { type: 'selector', selector: '#inspector-document' },
        text: 'exact',
        occurrence: 0,
      },
      options: {},
    }),
  });

  assert.equal(output, previousOutput);
});

test('destroyed or silent controller update cannot claim persistence from an old target', () => {
  const node = { id: 'silent-update-boundary' };
  const boundary = {
    startContainer: node,
    startOffset: 0,
    endContainer: node,
    endOffset: 5,
  };
  const previousOutput = createRangeOutput({ mark: 'circle' });
  let serializeCalls = 0;
  const controller = {
    update() {
      return controller;
    },
  };

  const output = proveRangeLocator({
    range: { cloneRange: () => ({ ...boundary }) },
    selectedText: 'new selection',
    controller,
    previousOutput,
    resolveSerializedTarget: () => ({ ...boundary }),
    serialize() {
      serializeCalls += 1;
      return canonicalDefinition('old selection', 0);
    },
  });

  assert.equal(output, previousOutput);
  assert.equal(serializeCalls, 1);
});

test('forged schema, kind, or locator shapes preserve the exact prior output', () => {
  const variants = [
    {
      name: 'schema',
      mutate(definition) {
        definition.schema = 'hanamaru/v2';
      },
    },
    {
      name: 'kind',
      mutate(definition) {
        definition.kind = 'group';
      },
    },
    {
      name: 'text',
      mutate(definition) {
        definition.target.text = 'normalized alias';
      },
    },
    {
      name: 'occurrence',
      mutate(definition) {
        definition.target.occurrence = 1;
      },
    },
    {
      name: 'target extra key',
      mutate(definition) {
        definition.target.key = 'ephemeral';
      },
    },
    {
      name: 'within extra key',
      mutate(definition) {
        definition.target.within.key = 'alias';
      },
    },
  ];
  const node = { id: 'forged-boundary' };
  const boundary = {
    startContainer: node,
    startOffset: 0,
    endContainer: node,
    endOffset: 5,
  };

  for (const { name, mutate } of variants) {
    const previousOutput = createRangeOutput({ seed: name });
    const definition = canonicalDefinition();
    mutate(definition);
    const output = proveRangeLocator({
      range: { cloneRange: () => ({ ...boundary }) },
      selectedText: 'exact',
      controller: { update() {} },
      previousOutput,
      resolveSerializedTarget: () => ({ ...boundary }),
      serialize: () => definition,
    });

    assert.equal(output, previousOutput, name);
  }
});

test('one mutating target getter is snapshotted once and drives both stable outputs', () => {
  const node = { id: 'getter-boundary' };
  const boundary = {
    startContainer: node,
    startOffset: 0,
    endContainer: node,
    endOffset: 5,
  };
  const previousOutput = createRangeOutput({ mark: 'underline' });
  const stable = canonicalDefinition();
  let targetReads = 0;
  let serializeCalls = 0;
  const definition = {
    schema: stable.schema,
    kind: stable.kind,
    get target() {
      targetReads += 1;
      return targetReads === 1
        ? stable.target
        : { ...stable.target, text: 'changed after snapshot' };
    },
    options: stable.options,
  };

  const output = proveRangeLocator({
    range: { cloneRange: () => ({ ...boundary }) },
    selectedText: 'exact',
    controller: { update() {} },
    previousOutput,
    resolveSerializedTarget: () => ({ ...boundary }),
    serialize() {
      serializeCalls += 1;
      return definition;
    },
  });

  assert.notEqual(output, previousOutput);
  assert.equal(serializeCalls, 1);
  assert.equal(targetReads, 1);
  assert.ok(output.javascript.code.includes(`const definition = ${output.json.code};`));
  assert.deepEqual(JSON.parse(output.json.code).target, stable.target);
});

test('one mutating toJSON result is the sole stable persistence snapshot', () => {
  const node = { id: 'to-json-boundary' };
  const boundary = {
    startContainer: node,
    startOffset: 0,
    endContainer: node,
    endOffset: 5,
  };
  const previousOutput = createRangeOutput({ mark: 'box' });
  let toJSONCalls = 0;
  const definition = {
    toJSON() {
      toJSONCalls += 1;
      return toJSONCalls === 1
        ? canonicalDefinition()
        : canonicalDefinition('changed after snapshot', 9);
    },
  };

  const output = proveRangeLocator({
    range: { cloneRange: () => ({ ...boundary }) },
    selectedText: 'exact',
    controller: { update() {} },
    previousOutput,
    resolveSerializedTarget: () => ({ ...boundary }),
    serialize: () => definition,
  });

  assert.notEqual(output, previousOutput);
  assert.equal(toJSONCalls, 1);
  assert.ok(output.javascript.code.includes(`const definition = ${output.json.code};`));
  assert.deepEqual(JSON.parse(output.json.code), canonicalDefinition());
});

test('pre-proof output rejects values JSON would omit or coerce', () => {
  const cycle = {};
  cycle.self = cycle;
  const symbolKey = { mark: 'underline' };
  symbolKey[Symbol('hidden')] = 'omitted';
  const sparse = [];
  sparse.length = 1;
  const disguisedFunction = () => {};
  disguisedFunction.toJSON = () => 'coerced function';
  const cases = [
    ['NaN', { duration: Number.NaN }],
    ['positive Infinity', { duration: Number.POSITIVE_INFINITY }],
    ['negative Infinity', { duration: Number.NEGATIVE_INFINITY }],
    ['BigInt', { seed: 1n }],
    ['undefined', { note: undefined }],
    ['function', { note() {} }],
    ['function with toJSON', { note: disguisedFunction }],
    ['symbol value', { note: Symbol('note') }],
    ['symbol key', symbolKey],
    ['cycle', cycle],
    ['sparse array', { values: sparse }],
  ];

  for (const [name, options] of cases) {
    assert.throws(
      () => createRangeOutput(options),
      TypeError,
      name,
    );
  }
});

test('invalid serialized JSON data fails closed after exact locator proof', () => {
  const node = { id: 'invalid-json-boundary' };
  const boundary = {
    startContainer: node,
    startOffset: 0,
    endContainer: node,
    endOffset: 5,
  };
  const variants = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['BigInt', 1n],
    ['undefined', undefined],
    ['function', () => {}],
    ['function with toJSON', Object.assign(
      () => {},
      { toJSON: () => 'coerced function' },
    )],
    ['symbol', Symbol('invalid')],
  ];

  for (const [name, value] of variants) {
    const previousOutput = createRangeOutput({ seed: name });
    const definition = canonicalDefinition();
    definition.options.invalid = value;
    const output = proveRangeLocator({
      range: { cloneRange: () => ({ ...boundary }) },
      selectedText: 'exact',
      controller: { update() {} },
      previousOutput,
      resolveSerializedTarget: () => ({ ...boundary }),
      serialize: () => definition,
    });

    assert.equal(output, previousOutput, name);
  }

  const previousOutput = createRangeOutput({ seed: 'cycle' });
  const cyclicDefinition = canonicalDefinition();
  cyclicDefinition.options.self = cyclicDefinition;
  const output = proveRangeLocator({
    range: { cloneRange: () => ({ ...boundary }) },
    selectedText: 'exact',
    controller: { update() {} },
    previousOutput,
    resolveSerializedTarget: () => ({ ...boundary }),
    serialize: () => cyclicDefinition,
  });
  assert.equal(output, previousOutput, 'cycle');
});

test('JavaScript and JSON serializers neutralize hostile text while preserving values', () => {
  const hostileNote = '</script><img src=x onerror="globalThis.pwned=true">\u2028&';
  const options = {
    mark: 'highlight',
    note: hostileNote,
    seed: 1e21,
    duration: 0,
  };
  const initial = createRangeOutput(options);

  assert.doesNotMatch(initial.javascript.code, /<\/script>|<img|[\u2028\u2029]/u);
  assert.match(initial.javascript.code, /\\u003c\/script\\u003e/);
  assert.match(initial.javascript.code, /"seed": 1e\+21/);
  assert.match(initial.javascript.code, /"duration": 0/);

  const node = { id: 'same' };
  const boundary = {
    startContainer: node,
    startOffset: 0,
    endContainer: node,
    endOffset: 1,
  };
  const definition = {
    schema: 'hanamaru/v1',
    kind: 'annotation',
    target: {
      type: 'locator',
      within: { type: 'selector', selector: '#inspector-document' },
      text: '<',
      occurrence: 0,
    },
    options: {
      mark: 'highlight',
      note: hostileNote,
      placement: 'auto',
      trigger: 'manual',
      accessible: true,
      seed: 1e21,
      duration: 0,
      motion: 'never',
    },
  };
  const output = proveRangeLocator({
    range: { cloneRange: () => ({ ...boundary }) },
    selectedText: '<',
    controller: { update() {} },
    previousOutput: initial,
    resolveSerializedTarget: () => ({ ...boundary }),
    serialize: () => definition,
  });

  assert.doesNotMatch(output.javascript.code, /<\/script>|<img|[\u2028\u2029]/u);
  assert.doesNotMatch(output.json.code, /<\/script>|<img|[\u2028\u2029]/u);
  assert.deepEqual(JSON.parse(output.json.code), definition);
});
