import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConnector,
  clampNoteRect,
  choosePlacement,
  connectorDistance,
  intersectionArea,
  noteCandidates,
  overflowPixels,
  rect,
  scoreCandidate,
  unionRects,
} from '../../src/geometry.js';

test('connector runs from the facing target edge to a shortened right-side arrow', () => {
  assert.deepEqual(
    buildConnector(rect(10, 20, 30, 40), rect(100, 30, 50, 20), 'right'),
    {
      shaft: 'M 40 40 L 92 40',
      head: 'M 93.82 43.29 L 100 40 L 93.82 36.71',
    },
  );
});

test('connector clamps its note endpoint along each facing edge', () => {
  assert.deepEqual(
    buildConnector(rect(40, 60, 20, 20), rect(10, 0, 20, 20), 'top'),
    {
      shaft: 'M 50 60 L 33.58 27.16',
      head: 'M 35.7 24.06 L 30 20 L 29.82 27',
    },
  );
  assert.deepEqual(
    buildConnector(rect(40, 60, 20, 20), rect(80, 100, 20, 20), 'bottom'),
    {
      shaft: 'M 50 80 L 73.34 95.56',
      head: 'M 73.03 99.31 L 80 100 L 76.68 93.84',
    },
  );
  assert.deepEqual(
    buildConnector(rect(40, 60, 20, 20), rect(0, 100, 20, 20), 'left'),
    {
      shaft: 'M 40 70 L 24.44 93.34',
      head: 'M 20.69 93.03 L 20 100 L 26.16 96.68',
    },
  );
});

test('connector returns empty paths when its facing edge already touches the note', () => {
  assert.deepEqual(
    buildConnector(rect(10, 10, 20, 20), rect(30, 15, 20, 10), 'right'),
    { shaft: '', head: '' },
  );
});

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

test('overflowPixels sums every edge excess outside the inset viewport', () => {
  const viewport = { width: 100, height: 80 };

  assert.equal(overflowPixels(rect(-5, -8, 120, 100), viewport), 88);
  assert.equal(overflowPixels(rect(20, 20, 20, 20), viewport), 0);
  assert.equal(overflowPixels(rect(12, 12, 76, 56), viewport, 0), 0);
});

test('overflowPixels treats notes touching inset edges as contained', () => {
  assert.equal(
    overflowPixels(rect(12, 12, 76, 56), { width: 100, height: 80 }),
    0,
  );
});

test('connectorDistance measures the target center to the nearest note point', () => {
  const target = rect(40, 40, 20, 20);

  assert.equal(connectorDistance(target, rect(70, 45, 20, 10)), 20);
  assert.equal(connectorDistance(target, rect(45, 70, 10, 20)), 20);
  assert.equal(connectorDistance(target, rect(70, 70, 10, 10)), Math.sqrt(800));
  assert.equal(connectorDistance(target, rect(45, 45, 10, 10)), 0);
});

test('scoreCandidate combines overflow, target, note, connector, and preference costs', () => {
  const candidate = rect(-10, -10, 320, 320);
  const target = rect(300, 300, 1000, 1000);
  const score = scoreCandidate(candidate, {
    target,
    viewport: { width: 800, height: 800 },
    otherNotes: [rect(0, 0, 10, 10)],
    preferencePenalty: 7,
  });

  assert.equal(score, (44 * 1000) + (100 * 100) + (100 * 10)
    + (Math.hypot(490, 490) - 240) + 7);
  assert.deepEqual(candidate, rect(-10, -10, 320, 320));
  assert.equal(Number.isFinite(score), true);
});

test('scoreCandidate defaults its inset, preference penalty, and other notes', () => {
  assert.equal(
    scoreCandidate(rect(0, 0, 10, 10), {
      target: rect(500, 500, 10, 10),
      viewport: { width: 100, height: 100 },
    }),
    24_000 + (Math.hypot(495, 495) - 240),
  );
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

test('choosePlacement preserves named auto order for equal LTR and RTL scores', () => {
  const common = {
    target: rect(400, 400, 100, 100),
    noteSize: { width: 100, height: 100 },
    viewport: { width: 1000, height: 1000 },
  };

  assert.equal(choosePlacement(common).side, 'right');
  assert.equal(choosePlacement({ ...common, dir: 'rtl' }).side, 'left');
});

test('choosePlacement lets overflow dominate an earlier auto candidate', () => {
  const result = choosePlacement({
    target: rect(950, 400, 20, 20),
    noteSize: { width: 100, height: 100 },
    viewport: { width: 1000, height: 1000 },
  });

  assert.equal(result.side, 'left');
});

test('choosePlacement gives an explicit side its first tie-breaking preference', () => {
  const result = choosePlacement({
    target: rect(400, 400, 100, 100),
    noteSize: { width: 100, height: 100 },
    viewport: { width: 1000, height: 1000 },
    placement: 'left',
  });

  assert.equal(result.side, 'left');
});

test('choosePlacement allows an explicit opposite side to beat serious preferred overflow', () => {
  const result = choosePlacement({
    target: rect(950, 400, 20, 20),
    noteSize: { width: 100, height: 100 },
    viewport: { width: 1000, height: 1000 },
    placement: 'right',
  });

  assert.equal(result.side, 'left');
});

test('choosePlacement avoids overlap with existing notes', () => {
  const target = rect(400, 400, 100, 100);
  const noteSize = { width: 100, height: 100 };
  const candidates = noteCandidates(target, noteSize);
  const result = choosePlacement({
    target,
    noteSize,
    viewport: { width: 1000, height: 1000 },
    otherNotes: [candidates.right],
  });

  assert.equal(result.side, 'top');
});

test('choosePlacement passes custom gap and inset through placement and final clamping', () => {
  const result = choosePlacement({
    target: rect(100, 100, 20, 20),
    noteSize: { width: 30, height: 10 },
    viewport: { width: 300, height: 300 },
    placement: 'top',
    gap: 7,
    inset: 20,
  });

  assert.deepEqual(result.rect, rect(95, 83, 30, 10));
});

test('choosePlacement scores un-clamped candidates before clamping its winner', () => {
  const target = rect(400, 120, 100, 100);
  const noteSize = { width: 100, height: 100 };
  const viewport = { width: 1000, height: 1000 };
  const candidates = noteCandidates(target, noteSize);
  const result = choosePlacement({
    target,
    noteSize,
    viewport,
    placement: 'top',
    otherNotes: [candidates.right, candidates.bottom, candidates.left],
  });

  assert.equal(result.side, 'top');
  assert.equal(result.score, scoreCandidate(candidates.top, {
    target,
    viewport,
    otherNotes: [candidates.right, candidates.bottom, candidates.left],
  }));
  assert.deepEqual(result.rect, rect(400, 12, 100, 100));
});

test('choosePlacement rejects unknown placement values clearly', () => {
  assert.throws(
    () => choosePlacement({
      target: rect(0, 0, 10, 10),
      noteSize: { width: 10, height: 10 },
      viewport: { width: 100, height: 100 },
      placement: 'diagonal',
    }),
    RangeError,
  );
});
