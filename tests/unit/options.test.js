import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeOptions } from '../../src/annotation.js';
import {
  HanamaruConfigError,
  HanamaruError,
} from '../../src/errors.js';

const defaults = {
  mark: 'circle',
  note: null,
  placement: 'auto',
  trigger: 'manual',
  accessible: false,
  seed: 'id-1',
  duration: 650,
  motion: 'system',
};

function assertInvalid(input, field, value, options) {
  assert.throws(
    () => normalizeOptions(input, 'id-1', options),
    (error) => {
      assert.ok(error instanceof HanamaruConfigError);
      assert.equal(error.code, 'HANA_CONFIG_INVALID');
      assert.equal(error.details.field, field);
      assert.equal(error.details.value, value);
      return true;
    },
  );
}

test('HanamaruConfigError preserves its typed error contract', () => {
  const details = { field: 'mark', value: 'scribble' };
  const error = new HanamaruConfigError('HANA_CONFIG_INVALID', 'Invalid mark', details);

  assert.equal(error.name, 'HanamaruConfigError');
  assert.equal(error.code, 'HANA_CONFIG_INVALID');
  assert.equal(error.message, 'Invalid mark');
  assert.equal(error.details, details);
  assert.ok(error instanceof HanamaruError);
  assert.ok(error instanceof Error);
  assert.match(error.stack, /HanamaruConfigError: Invalid mark/);
});

test('normalizes canonical defaults in canonical key order', () => {
  assert.deepEqual(normalizeOptions({ mark: 'circle' }, 'id-1'), defaults);
  assert.deepEqual(Object.keys(normalizeOptions({ mark: 'circle' }, 'id-1')), Object.keys(defaults));
});

test('accepts each mark', () => {
  for (const mark of ['underline', 'highlight', 'circle', 'box', 'strike', 'bracket']) {
    assert.equal(normalizeOptions({ mark }, 'id-1').mark, mark);
  }
});

test('normalizes note values and counts Unicode code points', () => {
  assert.equal(normalizeOptions({ mark: 'circle', note: '' }, 'id-1').note, null);
  assert.equal(normalizeOptions({ mark: 'circle', note: '花'.repeat(280) }, 'id-1').note, '花'.repeat(280));
  assert.equal(normalizeOptions({ mark: 'circle', note: '😀'.repeat(280) }, 'id-1').note, '😀'.repeat(280));
  assertInvalid({ mark: 'circle', note: '花'.repeat(281) }, 'note', '花'.repeat(281));
  assertInvalid({ mark: 'circle', note: 1 }, 'note', 1);
});

test('accepts valid seed types', () => {
  assert.equal(normalizeOptions({ mark: 'circle', seed: 'seed' }, 'id-1').seed, 'seed');
  assert.equal(normalizeOptions({ mark: 'circle', seed: 12.5 }, 'id-1').seed, 12.5);
  assert.equal(normalizeOptions({ mark: 'circle' }, 'fallback').seed, 'fallback');
  assert.equal(normalizeOptions({ mark: 'circle' }, 12.5).seed, 12.5);
});

test('validates the fallback seed when input omits seed', () => {
  for (const fallbackSeed of [Infinity, {}, undefined]) {
    assert.throws(
      () => normalizeOptions({ mark: 'circle' }, fallbackSeed),
      (error) => {
        assert.ok(error instanceof HanamaruConfigError);
        assert.equal(error.code, 'HANA_CONFIG_INVALID');
        assert.equal(error.details.field, 'seed');
        assert.equal(error.details.value, fallbackSeed);
        return true;
      },
    );
  }
});

test('uses an explicit valid seed without validating an unused fallback', () => {
  assert.equal(normalizeOptions({ mark: 'circle', seed: 'explicit' }, Infinity).seed, 'explicit');
});

test('accepts valid enum and scalar boundaries', () => {
  assert.deepEqual(normalizeOptions({
    mark: 'underline',
    note: null,
    placement: 'left',
    trigger: 'viewport',
    accessible: true,
    seed: 0,
    duration: 0,
    motion: 'never',
  }, 'id-1'), {
    mark: 'underline', note: null, placement: 'left', trigger: 'viewport',
    accessible: true, seed: 0, duration: 0, motion: 'never',
  });
});

test('rejects missing and invalid known values with preserved details', () => {
  assertInvalid({}, 'mark', undefined);
  assertInvalid(Object.create({ mark: 'circle' }), 'mark', undefined);
  assertInvalid({ __proto__: { mark: 'circle' } }, 'mark', undefined);
  assertInvalid(Object.create({
    get mark() {
      throw new Error('inherited mark must not be read');
    },
  }), 'mark', undefined);
  assertInvalid({ mark: 'scribble' }, 'mark', 'scribble');
  assertInvalid({ mark: 'circle', placement: 'near' }, 'placement', 'near');
  assertInvalid({ mark: 'circle', trigger: 'hover' }, 'trigger', 'hover');
  assertInvalid({ mark: 'circle', accessible: 'yes' }, 'accessible', 'yes');
  assertInvalid({ mark: 'circle', seed: Infinity }, 'seed', Infinity);
  assertInvalid({ mark: 'circle', duration: -1 }, 'duration', -1);
  assertInvalid({ mark: 'circle', duration: 1.5 }, 'duration', 1.5);
  assertInvalid({ mark: 'circle', motion: 'always' }, 'motion', 'always');
});

test('strictly rejects unknown properties and drops them when allowed', () => {
  const extra = { x: 1 };
  assertInvalid({ mark: 'circle', extra }, 'extra', extra);
  assert.deepEqual(normalizeOptions({ mark: 'circle', extra: true }, 'id-1', { allowUnknown: true }), defaults);
  assertInvalid({ mark: 'scribble', extra: true }, 'mark', 'scribble', { allowUnknown: true });
});

test('rejects non-object input without native type errors', () => {
  for (const input of [null, [], 'circle', 1]) {
    assertInvalid(input, 'input', input);
  }
});

test('does not mutate the input', () => {
  const input = { mark: 'circle', note: '', extra: true };
  const before = { ...input };

  normalizeOptions(input, 'id-1', { allowUnknown: true });

  assert.deepEqual(input, before);
});
