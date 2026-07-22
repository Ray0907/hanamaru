import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMarkPaths,
  fnv1a,
  jitter,
  rect,
} from '../../src/geometry.js';

function pathNumbers(path) {
  return path.match(/-?\d+(?:\.\d+)?/g).map(Number);
}

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

test('enclosure support preserves all existing line-mark golden bytes', () => {
  const line = [rect(10, 20, 100, 40)];

  assert.deepEqual(buildMarkPaths('underline', line, 'golden'), [
    'M 10.42 62.49 Q 61.25 63.23 110.44 62.48',
  ]);
  assert.deepEqual(buildMarkPaths('highlight', line, 'golden'), [
    'M 11.16 39.17 L 111.11 39.12 L 110.15 60.16 L 10.1 60.12 Z',
  ]);
  assert.deepEqual(buildMarkPaths('strike', line, 'golden'), [
    'M 11.46 37.53 Q 59.27 38.26 111.47 37.51',
    'M 9.87 40.8 Q 60.55 41.56 109.86 40.81',
  ]);
});

test('supported marks return no paths for no rectangles', () => {
  assert.deepEqual(buildMarkPaths('underline', [], 'seed'), []);
  assert.deepEqual(buildMarkPaths('highlight', [], 'seed'), []);
  assert.deepEqual(buildMarkPaths('strike', [], 'seed'), []);
  assert.deepEqual(buildMarkPaths('circle', [], 'seed'), []);
  assert.deepEqual(buildMarkPaths('box', [], 'seed'), []);
  assert.deepEqual(buildMarkPaths('bracket', [], 'seed'), []);
});

test('unsupported marks are rejected clearly before path generation', () => {
  assert.throws(
    () => buildMarkPaths('unknown', [], 'seed'),
    { name: 'RangeError', message: 'Unsupported mark: unknown' },
  );
});

test('circle emits two closed four-cubic paths with exact golden bytes', () => {
  const paths = buildMarkPaths('circle', [rect(10, 20, 100, 40)], 'golden');

  assert.deepEqual(paths, [
    'M 114.97 39.98 C 113.55 52.35 91.22 65.85 60.5 65.51 C 30.51 65.88 4.02 52.84 5.77 40.78 C 4.59 25.76 28.31 13.7 59.66 14.67 C 91.74 16.35 114.67 25.87 115.98 40.99 Z',
    'M 117.18 41.16 C 116.83 54.37 90.47 64.02 60.57 65.06 C 28.47 63.91 4.11 53.63 4.62 40.61 C 5.49 24.97 29.26 15.68 58.56 14.05 C 89.46 14.05 115.25 25.71 116.72 40.71 Z',
  ]);
  assert.equal(paths.length, 2);

  for (const path of paths) {
    assert.match(path, /^M(?: -?\d+(?:\.\d+)?){2}(?: C(?: -?\d+(?:\.\d+)?){6}){4} Z$/);
    assert.equal((path.match(/\bM\b/g) ?? []).length, 1);
    assert.equal((path.match(/\bC\b/g) ?? []).length, 4);
    assert.equal((path.match(/\bZ\b/g) ?? []).length, 1);
  }
});

test('circle encloses the union once, respects padding, and does not mutate rectangles', () => {
  const rects = [rect(10, 20, 40, 10), rect(200, 50, 40, 10)];
  const before = structuredClone(rects);
  const paths = buildMarkPaths('circle', rects, 'bounds', 5);

  assert.equal(paths.length, 2);
  assert.deepEqual(rects, before);

  const first = pathNumbers(paths[0]);
  assert.ok(first[0] >= 243.5 && first[0] <= 246.5, 'right anchor uses union right + padding');
  assert.ok(first[7] >= 63.5 && first[7] <= 66.5, 'bottom anchor uses union bottom + padding');
  assert.ok(first[12] >= 3.5 && first[12] <= 6.5, 'left anchor uses union left - padding');
  assert.ok(first[19] >= 13.5 && first[19] <= 16.5, 'top anchor uses union top - padding');

  const second = pathNumbers(paths[1]);
  assert.ok(second[0] >= 244.5 && second[0] <= 247.5, 'pass one expands horizontal radius by one');
  assert.ok(second[7] >= 63 && second[7] <= 66, 'pass one contracts vertical radius by half');
  assert.ok(second[12] >= 2.5 && second[12] <= 5.5, 'pass one expands leftward by one');
  assert.ok(second[19] >= 14 && second[19] <= 17, 'pass one contracts upward by half');
});

test('circle is byte-stable per seed and changes every pass with a different seed', () => {
  const rects = [rect(1.25, 2.5, 30.75, 4.5)];
  const stable = buildMarkPaths('circle', rects, 'same');
  const changed = buildMarkPaths('circle', rects, 'changed');

  assert.deepEqual(stable, buildMarkPaths('circle', rects, 'same'));
  assert.notEqual(stable[0], changed[0]);
  assert.notEqual(stable[1], changed[1]);
});

test('box emits two closed four-corner paths with exact golden bytes', () => {
  const paths = buildMarkPaths('box', [rect(10, 20, 100, 40)], 'golden');

  assert.deepEqual(paths, [
    'M 6.21 16.2 L 115.13 15.12 L 113.6 63.59 L 4.27 64.25 Z',
    'M 4.93 14.94 L 114.82 12.83 L 114.81 64.82 L 4.52 66.53 Z',
  ]);
  assert.equal(paths.length, 2);

  for (const path of paths) {
    assert.match(path, /^M(?: -?\d+(?:\.\d+)?){2}(?: L(?: -?\d+(?:\.\d+)?){2}){3} Z$/);
    assert.equal((path.match(/\bM\b/g) ?? []).length, 1);
    assert.equal((path.match(/\bL\b/g) ?? []).length, 3);
    assert.equal((path.match(/\bZ\b/g) ?? []).length, 1);
  }
});

test('box encloses the union once and pass one expands every ideal edge by one pixel', () => {
  const rects = [rect(10, 20, 40, 10), rect(200, 50, 40, 10)];
  const before = structuredClone(rects);
  const seed = 'expansion';
  const paths = buildMarkPaths('box', rects, seed, 5);
  const segments = ['tl', 'tr', 'br', 'bl'];
  const idealPasses = [
    [5, 15, 245, 15, 245, 65, 5, 65],
    [4, 14, 246, 14, 246, 66, 4, 66],
  ];

  assert.equal(paths.length, 2);
  assert.deepEqual(rects, before);

  paths.forEach((path, pass) => {
    const coordinates = pathNumbers(path);

    coordinates.forEach((coordinate, index) => {
      const segment = segments[Math.floor(index / 2)];
      const axis = index % 2 === 0 ? 'x' : 'y';
      const ideal = coordinate - jitter(seed, `box:${pass}:${segment}:${axis}`);

      assert.ok(Math.abs(ideal - idealPasses[pass][index]) < 0.001);
    });
  });
});

test('box is byte-stable per seed and changes every pass with a different seed', () => {
  const rects = [rect(1.25, 2.5, 30.75, 4.5)];
  const stable = buildMarkPaths('box', rects, 'same');
  const changed = buildMarkPaths('box', rects, 'changed');

  assert.deepEqual(stable, buildMarkPaths('box', rects, 'same'));
  assert.notEqual(stable[0], changed[0]);
  assert.notEqual(stable[1], changed[1]);
});

test('bracket emits two open four-point paths with exact golden bytes', () => {
  const paths = buildMarkPaths('bracket', [rect(10, 20, 100, 40)], 'golden');

  assert.deepEqual(paths, [
    'M 105.99 16 L 114.25 14.24 L 116.47 66.46 L 103.58 63.59',
    'M 105.11 14.1 L 116.96 15.97 L 114.92 63.93 L 106.55 65.54',
  ]);
  assert.equal(paths.length, 2);

  for (const path of paths) {
    assert.match(path, /^M(?: -?\d+(?:\.\d+)?){2}(?: L(?: -?\d+(?:\.\d+)?){2}){3}$/);
    assert.equal((path.match(/\bM\b/g) ?? []).length, 1);
    assert.equal((path.match(/\bL\b/g) ?? []).length, 3);
    assert.equal((path.match(/\bZ\b/g) ?? []).length, 0);
  }
});

test('bracket follows the padded right side of the union with ten-pixel inward hooks', () => {
  const rects = [rect(10, 20, 40, 10), rect(200, 50, 40, 10)];
  const before = structuredClone(rects);
  const seed = 'bracket-bounds';
  const paths = buildMarkPaths('bracket', rects, seed, 5);
  const segments = ['hookTop', 'top', 'bottom', 'hookBottom'];

  assert.equal(paths.length, 2);
  assert.deepEqual(rects, before);

  paths.forEach((path, pass) => {
    const coordinates = pathNumbers(path);
    const x = 245 + pass;
    const ideal = [x - 10, 15, x, 15, x, 65, x - 10, 65];

    assert.ok(coordinates[2] >= x - 1.5 && coordinates[2] <= x + 1.5);
    assert.ok(coordinates[0] >= x - 11.5 && coordinates[0] <= x - 8.5);
    assert.ok(coordinates[1] >= 13.5 && coordinates[1] <= 16.5);
    assert.ok(coordinates[5] >= 63.5 && coordinates[5] <= 66.5);

    coordinates.forEach((coordinate, index) => {
      const segment = segments[Math.floor(index / 2)];
      const axis = index % 2 === 0 ? 'x' : 'y';
      const deJittered = coordinate - jitter(seed, `bracket:${pass}:${segment}:${axis}`);

      assert.ok(Math.abs(deJittered - ideal[index]) < 0.001);
    });
  });
});

test('bracket is byte-stable per seed and changes every pass with a different seed', () => {
  const rects = [rect(1.25, 2.5, 30.75, 4.5)];
  const stable = buildMarkPaths('bracket', rects, 'same');
  const changed = buildMarkPaths('bracket', rects, 'changed');

  assert.deepEqual(stable, buildMarkPaths('bracket', rects, 'same'));
  assert.notEqual(stable[0], changed[0]);
  assert.notEqual(stable[1], changed[1]);
});
