import assert from 'node:assert/strict';
import test from 'node:test';

import { HanamaruConfigError } from '../../src/errors.js';
import {
  findMatchOffsets,
  normalizeLocatorText,
  validateOccurrence,
} from '../../src/target.js';

function assertInvalid(action, details) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof HanamaruConfigError);
    assert.equal(error.code, 'HANA_CONFIG_INVALID');
    assert.deepEqual(error.details, details);
    return true;
  });
}

test('normalizes locator text by trimming and collapsing Unicode whitespace', () => {
  assert.equal(normalizeLocatorText('\t\u00a0 hello\n\nworld \u00a0'), 'hello world');
});

test('rejects empty and non-string locator text with the original value', () => {
  assertInvalid(() => normalizeLocatorText(' \t\u00a0\n'), {
    field: 'text',
    value: ' \t\u00a0\n',
  });
  assertInvalid(() => normalizeLocatorText(42), { field: 'text', value: 42 });
});

test('finds normalized source matches in source-coordinate order', () => {
  assert.deepEqual(findMatchOffsets('  red\n\u00a0blue  red ', 'red blue'), [[0, 8]]);
  assert.deepEqual(findMatchOffsets('a  a a', 'a'), [[0, 1], [2, 3], [4, 5]]);
});

test('finds exact case-sensitive non-overlapping matches', () => {
  assert.deepEqual(findMatchOffsets('aaaa', 'aa'), [[0, 2], [2, 4]]);
  assert.deepEqual(findMatchOffsets('Alpha alpha', 'alpha'), [[6, 11]]);
});

test('supports zero-based occurrence selection from returned matches', () => {
  const matches = findMatchOffsets('one two one', 'one');
  const occurrence = validateOccurrence(0);

  assert.deepEqual(matches[occurrence], [0, 3]);
});

test('returns no matches for an empty normalized source', () => {
  assert.deepEqual(findMatchOffsets(' \n\u00a0\t ', 'needle'), []);
});

test('rejects invalid source values', () => {
  assertInvalid(() => findMatchOffsets(null, 'needle'), {
    field: 'source',
    value: null,
  });
});

test('validates optional zero-based occurrence values', () => {
  assert.equal(validateOccurrence(undefined), undefined);
  assert.equal(validateOccurrence(0), 0);
  assert.equal(validateOccurrence(3), 3);
});

test('rejects invalid occurrence values with their original values', () => {
  for (const value of [-1, 1.5, Number.NaN, Infinity, '0', null]) {
    assertInvalid(() => validateOccurrence(value), {
      field: 'occurrence',
      value,
    });
  }
});
