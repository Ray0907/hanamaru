import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampNoteRect,
  intersectionArea,
  noteCandidates,
  rect,
  unionRects,
} from '../../src/geometry.js';

test('rect returns an independent plain rectangle with stable fields', () => {
  const result = rect(1.5, -2.25, 30.75, 4.5);

  assert.deepEqual(result, {
    x: 1.5,
    y: -2.25,
    width: 30.75,
    height: 4.5,
    top: -2.25,
    right: 32.25,
    bottom: 2.25,
    left: 1.5,
  });
  assert.deepEqual(Object.keys(result), [
    'x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left',
  ]);
  assert.notStrictEqual(rect(1.5, -2.25, 30.75, 4.5), result);
});

test('unionRects returns the minimum rectangle without mutating its inputs', () => {
  const first = rect(5, 10, 20, 30);
  const second = rect(-10, 25, 40, 5);

  assert.deepEqual(unionRects([first, second]), rect(-10, 10, 40, 30));
  assert.deepEqual(first, rect(5, 10, 20, 30));
  assert.deepEqual(second, rect(-10, 25, 40, 5));
});

test('unionRects returns a zero rectangle for no input rectangles', () => {
  assert.deepEqual(unionRects([]), rect(0, 0, 0, 0));
});

test('intersectionArea returns positive overlap and zero for touching edges', () => {
  assert.equal(intersectionArea(rect(0, 0, 20, 20), rect(10, 5, 20, 10)), 100);
  assert.equal(intersectionArea(rect(0, 0, 10, 10), rect(10, 0, 10, 10)), 0);
  assert.equal(intersectionArea(rect(0, 0, 10, 10), rect(30, 0, 10, 10)), 0);
});

test('clampNoteRect caps size then positions a note inside the inset viewport', () => {
  assert.deepEqual(
    clampNoteRect(rect(360, -20, 180, 120), { width: 390, height: 844 }, 12),
    rect(198, 12, 180, 120),
  );
  assert.deepEqual(
    clampNoteRect(rect(20, 30, 500, 900), { width: 390, height: 844 }, 12),
    rect(12, 12, 366, 820),
  );
  assert.deepEqual(
    clampNoteRect(rect(50, 80, 100, 60), { width: 390, height: 844 }, 12),
    rect(50, 80, 100, 60),
  );
});

test('clampNoteRect keeps zero-sized notes inside tiny viewport axes', () => {
  assert.deepEqual(
    clampNoteRect(rect(-30, -40, 100, 100), { width: 10, height: 20 }, 12),
    rect(5, 10, 0, 0),
  );
  assert.deepEqual(
    clampNoteRect(rect(-30, 900, 100, 100), { width: 10, height: 100 }, 12),
    rect(5, 12, 0, 76),
  );
});

test('noteCandidates centers notes around every target edge with the default gap', () => {
  assert.deepEqual(
    noteCandidates(rect(50, 100, 100, 40), { width: 120, height: 60 }),
    {
      top: rect(40, 24, 120, 60),
      right: rect(166, 90, 120, 60),
      bottom: rect(40, 156, 120, 60),
      left: rect(-86, 90, 120, 60),
    },
  );
});

test('noteCandidates accepts a custom gap and preserves decimals', () => {
  assert.deepEqual(
    noteCandidates(rect(10.5, 20.25, 30.5, 40.75), { width: 20.5, height: 10.25 }, 2.5),
    {
      top: rect(15.5, 7.5, 20.5, 10.25),
      right: rect(43.5, 35.5, 20.5, 10.25),
      bottom: rect(15.5, 63.5, 20.5, 10.25),
      left: rect(-12.5, 35.5, 20.5, 10.25),
    },
  );
});
