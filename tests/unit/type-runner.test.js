import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUIRED_TYPE_FIXTURES,
  orderTypeFixtures,
} from '../types/fixtures.mjs';

const required = [
  'main.ts',
  'selection.ts',
  'group.ts',
  'plugins.ts',
  'serialize.ts',
  'shadow.ts',
  'adapters.tsx',
];

test('type fixture gate keeps the seven required fixtures in fixed order', () => {
  assert.deepEqual(REQUIRED_TYPE_FIXTURES, required);
  assert.deepEqual(
    orderTypeFixtures(['z-extra.ts', ...required.toReversed(), 'a-extra.tsx']),
    [...required, 'a-extra.tsx', 'z-extra.ts'],
  );
});

test('type fixture gate fails with every missing required fixture name', () => {
  assert.throws(
    () => orderTypeFixtures(required.filter((name) => name !== 'selection.ts')),
    /missing required fixture\(s\): selection\.ts/,
  );
  assert.throws(
    () => orderTypeFixtures(required.filter(
      (name) => name !== 'main.ts' && name !== 'adapters.tsx',
    )),
    /missing required fixture\(s\): main\.ts, adapters\.tsx/,
  );
});

test('type fixture gate rejects a zero-fixture discovery', () => {
  assert.throws(
    () => orderTypeFixtures([]),
    /requires at least one fixture/,
  );
});
