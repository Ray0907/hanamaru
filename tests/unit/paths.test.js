import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMarkPaths,
  fnv1a,
  jitter,
  rect,
} from '../../src/geometry.js';

test('fnv1a hashes UTF-16 code units with unsigned 32-bit FNV-1a', () => {
  assert.equal(fnv1a(''), 2166136261);
  assert.equal(fnv1a('hello'), 1335831723);
  assert.equal(fnv1a('😀'), 3409036472);
});

test('jitter produces exact deterministic golden values', () => {
  assert.equal(jitter('golden', 'underline:0:x0'), 0.42);
  assert.equal(jitter('golden', 'strike:0:mx'), -1.07);
  assert.equal(jitter('golden', 'underline:0:x0'), jitter('golden', 'underline:0:x0'));
});

test('jitter changes when the seed or semantic label changes', () => {
  const value = jitter('golden', 'underline:0:x0');

  assert.notEqual(jitter('different', 'underline:0:x0'), value);
  assert.notEqual(jitter('golden', 'underline:0:y0'), value);
});

test('jitter with zero amplitude returns normalized positive zero', () => {
  const value = jitter('golden', 'underline:0:x0', 0);

  assert.equal(value, 0);
  assert.equal(Object.is(value, -0), false);
});

test('underline builds the exact golden quadratic path', () => {
  assert.deepEqual(
    buildMarkPaths('underline', [rect(10, 20, 100, 40)], 'golden'),
    ['M 10.42 62.49 Q 61.25 63.23 110.44 62.48'],
  );
});

test('underline emits one path per line in input order without mutating rectangles', () => {
  const rects = [rect(200, 50, 40, 10), rect(-30, 5, 20, 6)];
  const before = structuredClone(rects);
  const paths = buildMarkPaths('underline', rects, 'stable');

  assert.equal(paths.length, 2);
  assert.ok(Number(paths[0].split(' ')[1]) >= 198.5);
  assert.ok(Number(paths[0].split(' ')[1]) <= 201.5);
  assert.ok(Number(paths[1].split(' ')[1]) >= -31.5);
  assert.ok(Number(paths[1].split(' ')[1]) <= -28.5);
  assert.deepEqual(rects, before);
});

test('underline is deterministic for the same seed and changes with a new seed', () => {
  const rects = [rect(1.25, 2.5, 30.75, 4.5)];

  assert.deepEqual(
    buildMarkPaths('underline', rects, 'same'),
    buildMarkPaths('underline', rects, 'same'),
  );
  assert.notDeepEqual(
    buildMarkPaths('underline', rects, 'same'),
    buildMarkPaths('underline', rects, 'changed'),
  );
});

test('highlight builds closed polygons with the exact semantic corner jitter', () => {
  const paths = buildMarkPaths(
    'highlight',
    [rect(10, 20, 100, 40), rect(200, 80, 20, 10)],
    'golden',
  );

  assert.deepEqual(paths, [
    'M 11.16 39.17 L 111.11 39.12 L 110.15 60.16 L 10.1 60.12 Z',
    'M 200.42 84.91 L 220.28 84.77 L 219.4 89.39 L 199.26 89.25 Z',
  ]);
});

test('highlight preserves line count and order within the allowed jitter bounds', () => {
  const paths = buildMarkPaths(
    'highlight',
    [rect(-20, 10, 8, 20), rect(300, 100, 50, 10)],
    'bounds',
  );
  const firstCoordinates = paths[0].match(/-?\d+(?:\.\d+)?/g).map(Number);
  const secondCoordinates = paths[1].match(/-?\d+(?:\.\d+)?/g).map(Number);

  assert.equal(paths.length, 2);
  assert.match(paths[0], / Z$/);
  assert.match(paths[1], / Z$/);
  assert.ok(firstCoordinates[0] >= -21.5 && firstCoordinates[0] <= -18.5);
  assert.ok(firstCoordinates[1] >= 17.5 && firstCoordinates[1] <= 20.5);
  assert.ok(firstCoordinates[5] >= 28.5 && firstCoordinates[5] <= 31.5);
  assert.ok(secondCoordinates[0] >= 298.5 && secondCoordinates[0] <= 301.5);
  assert.ok(secondCoordinates[1] >= 103 && secondCoordinates[1] <= 106);
  assert.ok(secondCoordinates[5] >= 108.5 && secondCoordinates[5] <= 111.5);
});

test('highlight returns identical bytes for one seed and different bytes for another', () => {
  const rects = [rect(10, 20, 100, 40)];

  assert.deepEqual(
    buildMarkPaths('highlight', rects, 'same'),
    buildMarkPaths('highlight', rects, 'same'),
  );
  assert.notDeepEqual(
    buildMarkPaths('highlight', rects, 'same'),
    buildMarkPaths('highlight', rects, 'changed'),
  );
});

test('strike emits two indexed quadratic passes per line using p0 and p1 labels', () => {
  const paths = buildMarkPaths(
    'strike',
    [rect(10, 20, 100, 40), rect(200, 80, 20, 10)],
    'golden',
  );

  assert.deepEqual(paths, [
    'M 11.46 37.53 Q 59.27 38.26 111.47 37.51',
    'M 9.87 40.8 Q 60.55 41.56 109.86 40.81',
    'M 201.09 85.02 Q 208.77 82.78 221.08 85.03',
    'M 198.68 86.25 Q 209.51 85.49 218.7 86.24',
  ]);
  assert.equal(paths.length, 4);
  assert.notEqual(paths[0], paths[1]);
  assert.notEqual(paths[2], paths[3]);
});

test('strike is byte-stable per seed and changes with a different seed', () => {
  const rects = [rect(1.25, 2.5, 30.75, 4.5)];

  assert.deepEqual(
    buildMarkPaths('strike', rects, 'same'),
    buildMarkPaths('strike', rects, 'same'),
  );
  assert.notDeepEqual(
    buildMarkPaths('strike', rects, 'same'),
    buildMarkPaths('strike', rects, 'changed'),
  );
});

test('supported marks return no paths for no rectangles', () => {
  assert.deepEqual(buildMarkPaths('underline', [], 'seed'), []);
  assert.deepEqual(buildMarkPaths('highlight', [], 'seed'), []);
  assert.deepEqual(buildMarkPaths('strike', [], 'seed'), []);
});

test('unsupported marks are rejected clearly before path generation', () => {
  assert.throws(
    () => buildMarkPaths('circle', [], 'seed'),
    { name: 'RangeError', message: 'Unsupported mark: circle' },
  );
});
