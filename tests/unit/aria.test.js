import assert from 'node:assert/strict';
import test from 'node:test';

import { addDescriptionToken, removeDescriptionToken } from '../../src/renderer.js';

test('addDescriptionToken preserves author order while deduplicating every token', () => {
  assert.equal(addDescriptionToken('author  hana-one author\thana-two', 'hana-one'), 'author hana-one hana-two');
  assert.equal(addDescriptionToken(null, 'hana-one'), 'hana-one');
});

test('removeDescriptionToken removes only its requested token and returns null when empty', () => {
  assert.equal(removeDescriptionToken('author hana-one hana-two', 'hana-one'), 'author hana-two');
  assert.equal(removeDescriptionToken('hana-one hana-one', 'hana-one'), null);
});

test('description tokens survive out-of-order teardown and author mutation', () => {
  let value = addDescriptionToken('author-before', 'hana-one');
  value = addDescriptionToken(value, 'hana-two');
  value = `${value} author-after`;
  value = removeDescriptionToken(value, 'hana-one');
  assert.equal(value, 'author-before hana-two author-after');
  assert.equal(removeDescriptionToken(value, 'hana-two'), 'author-before author-after');
});
