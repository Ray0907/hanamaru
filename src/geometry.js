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
