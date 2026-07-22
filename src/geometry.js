export function rect(x, y, width, height) {
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
  };
}

export function unionRects(rects) {
  if (rects.length === 0) {
    return rect(0, 0, 0, 0);
  }

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const item of rects) {
    left = Math.min(left, item.left);
    top = Math.min(top, item.top);
    right = Math.max(right, item.right);
    bottom = Math.max(bottom, item.bottom);
  }

  return rect(left, top, right - left, bottom - top);
}

export function intersectionArea(a, b) {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return width * height;
}

export function overflowPixels(note, viewport, inset = 12) {
  const right = viewport.width - inset;
  const bottom = viewport.height - inset;

  return Math.max(0, inset - note.left)
    + Math.max(0, inset - note.top)
    + Math.max(0, note.right - right)
    + Math.max(0, note.bottom - bottom);
}

export function connectorDistance(target, note) {
  const centerX = target.x + (target.width / 2);
  const centerY = target.y + (target.height / 2);
  const nearestX = Math.max(note.left, Math.min(centerX, note.right));
  const nearestY = Math.max(note.top, Math.min(centerY, note.bottom));

  return Math.hypot(centerX - nearestX, centerY - nearestY);
}

export function scoreCandidate(candidate, {
  target,
  viewport,
  otherNotes = [],
  inset = 12,
  preferencePenalty = 0,
}) {
  const noteOverlap = otherNotes.reduce(
    (total, note) => total + intersectionArea(candidate, note),
    0,
  );

  return (overflowPixels(candidate, viewport, inset) * 1000)
    + (intersectionArea(candidate, target) * 100)
    + (noteOverlap * 10)
    + Math.max(0, connectorDistance(target, candidate) - 240)
    + preferencePenalty;
}

export function clampNoteRect(input, viewport, inset = 12) {
  const horizontalInset = Math.min(inset, viewport.width / 2);
  const verticalInset = Math.min(inset, viewport.height / 2);
  const width = Math.max(0, Math.min(input.width, viewport.width - (2 * horizontalInset)));
  const height = Math.max(0, Math.min(input.height, viewport.height - (2 * verticalInset)));
  const minX = horizontalInset;
  const minY = verticalInset;
  const maxX = viewport.width - horizontalInset - width;
  const maxY = viewport.height - verticalInset - height;
  const x = Math.max(minX, Math.min(input.x, maxX));
  const y = Math.max(minY, Math.min(input.y, maxY));

  return rect(x, y, width, height);
}

export function noteCandidates(target, noteSize, gap = 16) {
  const x = target.x + ((target.width - noteSize.width) / 2);
  const y = target.y + ((target.height - noteSize.height) / 2);

  return {
    top: rect(x, target.y - gap - noteSize.height, noteSize.width, noteSize.height),
    right: rect(target.right + gap, y, noteSize.width, noteSize.height),
    bottom: rect(x, target.bottom + gap, noteSize.width, noteSize.height),
    left: rect(target.x - gap - noteSize.width, y, noteSize.width, noteSize.height),
  };
}

export function choosePlacement({
  target,
  noteSize,
  viewport,
  placement = 'auto',
  dir = 'ltr',
  otherNotes = [],
  gap = 16,
  inset = 12,
}) {
  const autoOrder = dir === 'rtl'
    ? ['left', 'top', 'bottom', 'right']
    : ['right', 'top', 'bottom', 'left'];
  const opposites = { top: 'bottom', right: 'left', bottom: 'top', left: 'right' };
  let order;

  if (placement === 'auto') {
    order = autoOrder;
  } else if (opposites[placement]) {
    const opposite = opposites[placement];
    order = [placement, opposite, ...autoOrder.filter((side) => side !== placement && side !== opposite)];
  } else {
    throw new RangeError(`Unknown placement: ${placement}`);
  }

  const candidates = noteCandidates(target, noteSize, gap);
  let winner;

  for (let index = 0; index < order.length; index += 1) {
    const side = order[index];
    const score = scoreCandidate(candidates[side], {
      target,
      viewport,
      otherNotes,
      inset,
      preferencePenalty: placement === 'auto' ? 0 : index * 25,
    });

    if (!winner || score < winner.score) {
      winner = { side, score, candidate: candidates[side] };
    }
  }

  return {
    side: winner.side,
    score: winner.score,
    rect: clampNoteRect(winner.candidate, viewport, inset),
  };
}
