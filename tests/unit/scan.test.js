import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDeclarative } from '../../src/declarative.js';
import * as Hanamaru from '../../src/index.js';

function element(dataset) {
  return { dataset };
}

test('the source entry point exposes only the supported public API', () => {
  assert.deepEqual(Object.keys(Hanamaru).sort(), [
    'HanamaruConfigError',
    'HanamaruError',
    'HanamaruStateError',
    'HanamaruTargetError',
    'VERSION',
    'annotate',
    'scan',
    'story',
  ]);
});

test('parseDeclarative maps every canonical attribute to raw annotation options', () => {
  assert.deepEqual(parseDeclarative(element({
    hana: 'highlight',
    hanaNote: 'Keep this claim concrete',
    hanaPlacement: 'left',
    hanaTrigger: 'viewport',
    hanaAccessible: '',
    hanaSeed: 'proof-1',
    hanaDuration: '720',
    hanaMotion: 'never',
  })), {
    mark: 'highlight',
    note: 'Keep this claim concrete',
    placement: 'left',
    trigger: 'viewport',
    accessible: true,
    seed: 'proof-1',
    duration: 720,
    motion: 'never',
  });
});

test('parseDeclarative treats accessible as a presence boolean and omits absent options', () => {
  assert.deepEqual(parseDeclarative(element({
    hana: 'box',
    hanaAccessible: 'false',
  })), {
    mark: 'box',
    accessible: true,
  });
  assert.deepEqual(parseDeclarative(element({ hana: 'underline' })), {
    mark: 'underline',
  });
});

test('parseDeclarative ignores unknown data-hana attributes', () => {
  assert.deepEqual(parseDeclarative(element({
    hana: 'circle',
    hanaFutureOption: 'ignored',
    unrelated: 'also ignored',
  })), { mark: 'circle' });
});

test('parseDeclarative leaves enum validation to normalizeOptions', () => {
  assert.deepEqual(parseDeclarative(element({
    hana: 'sparkle',
    hanaPlacement: 'nearby',
    hanaTrigger: 'eventually',
    hanaMotion: 'sometimes',
  })), {
    mark: 'sparkle',
    placement: 'nearby',
    trigger: 'eventually',
    motion: 'sometimes',
  });
});

test('parseDeclarative requires data-hana', () => {
  assert.throws(
    () => parseDeclarative(element({ hanaNote: 'Missing mark' })),
    (error) => (
      error instanceof Hanamaru.HanamaruConfigError
      && error.code === 'HANA_CONFIG_INVALID'
      && error.details.field === 'mark'
      && error.details.value === undefined
    ),
  );
});

for (const duration of ['', '1.5', '-1', '10ms', ' 10', '1e2']) {
  test(`parseDeclarative rejects non-integer duration ${JSON.stringify(duration)}`, () => {
    assert.throws(
      () => parseDeclarative(element({ hana: 'strike', hanaDuration: duration })),
      (error) => (
        error instanceof Hanamaru.HanamaruConfigError
        && error.code === 'HANA_CONFIG_INVALID'
        && error.details.field === 'duration'
        && error.details.value === duration
      ),
    );
  });
}

test('parseDeclarative accepts zero duration', () => {
  assert.deepEqual(parseDeclarative(element({
    hana: 'bracket',
    hanaDuration: '0',
  })), { mark: 'bracket', duration: 0 });
});

test('scan propagates unexpected programmer errors unchanged', () => {
  const programmerError = new TypeError('broken dataset getter');
  const broken = {};
  Object.defineProperty(broken, 'dataset', {
    get() { throw programmerError; },
  });
  const root = { querySelectorAll() { return [broken]; } };

  assert.throws(() => Hanamaru.scan(root), (error) => error === programmerError);
});
