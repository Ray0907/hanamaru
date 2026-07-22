import assert from 'node:assert/strict';
import test from 'node:test';

import * as declarativeModule from '../../src/declarative.js';
import * as Hanamaru from '../../src/index.js';

const { parseDeclarative } = declarativeModule;

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

test('scanDeclarative rolls successful controllers back in reverse after a dataset getter error', () => {
  assert.equal(typeof declarativeModule.scanDeclarative, 'function');
  const programmerError = new TypeError('broken dataset getter');
  const first = element({ hana: 'underline' });
  const second = element({ hana: 'circle' });
  const broken = {};
  Object.defineProperty(broken, 'dataset', {
    get() { throw programmerError; },
  });
  const calls = [];
  const createAnnotation = (target, options) => {
    calls.push(['create', target, options]);
    return {
      destroy() { calls.push(['destroy', target]); },
    };
  };

  assert.throws(
    () => declarativeModule.scanDeclarative({
      querySelectorAll() { return [first, second, broken]; },
    }, createAnnotation),
    (error) => error === programmerError,
  );
  assert.deepEqual(calls, [
    ['create', first, { mark: 'underline' }],
    ['create', second, { mark: 'circle' }],
    ['destroy', second],
    ['destroy', first],
  ]);
});

test('scanDeclarative rolls back after an iterator error and preserves it through teardown errors', () => {
  const programmerError = new SyntaxError('iterator failed');
  const destroyError = new Error('destroy failed');
  const first = element({ hana: 'box' });
  const second = element({ hana: 'strike' });
  let index = 0;
  const root = {
    querySelectorAll() {
      return {
        [Symbol.iterator]() {
          return {
            next() {
              index += 1;
              if (index === 1) return { done: false, value: first };
              if (index === 2) return { done: false, value: second };
              throw programmerError;
            },
          };
        },
      };
    },
  };
  const destroyed = [];
  const createAnnotation = (target) => ({
    destroy() {
      destroyed.push(target);
      if (target === second) throw destroyError;
    },
  });

  assert.throws(
    () => declarativeModule.scanDeclarative(root, createAnnotation),
    (error) => error === programmerError,
  );
  assert.deepEqual(destroyed, [second, first]);
});
