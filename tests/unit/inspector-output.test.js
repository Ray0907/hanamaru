import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRangeOutput,
  proveRangeLocator,
} from '../../demo/inspector-output.js';

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
