function descriptionTokens(value) {
  return typeof value === 'string' ? value.trim().split(/\s+/u).filter(Boolean) : [];
}

export function addDescriptionToken(current, id) {
  return [...new Set([...descriptionTokens(current), id])].join(' ');
}

export function removeDescriptionToken(current, id) {
  const remaining = [...new Set(descriptionTokens(current))].filter((token) => token !== id);
  return remaining.length === 0 ? null : remaining.join(' ');
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const MAX_TIMEOUT_DELAY = 2_147_483_647;

export function createDurationClock({
  duration,
  now,
  setTimeout,
  clearTimeout,
  complete,
}) {
  let active = false;
  let elapsed = 0;
  let settled = false;
  let startedAt = 0;
  let timeout = null;

  function recordElapsed() {
    const current = now();
    elapsed = Math.min(duration, elapsed + Math.max(0, current - startedAt));
    startedAt = current;
  }

  function finish() {
    if (settled) return;
    active = false;
    settled = true;
    complete();
  }

  function schedule() {
    if (!active || settled || timeout !== null) return;
    const remaining = Math.max(0, duration - elapsed);
    startedAt = now();
    timeout = setTimeout(onTimeout, Math.min(MAX_TIMEOUT_DELAY, remaining));
  }

  function onTimeout() {
    timeout = null;
    if (!active || settled) return;
    recordElapsed();
    if (elapsed >= duration) finish();
    else schedule();
  }

  return {
    pause() {
      if (!active || settled) return;
      recordElapsed();
      active = false;
      if (timeout !== null) {
        clearTimeout(timeout);
        timeout = null;
      }
    },
    resume() {
      if (active || settled) return;
      active = true;
      schedule();
    },
    cancel() {
      if (settled) return;
      active = false;
      settled = true;
      if (timeout !== null) {
        clearTimeout(timeout);
        timeout = null;
      }
    },
  };
}

function copyRect(input) {
  return {
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    top: input.top,
    right: input.right,
    bottom: input.bottom,
    left: input.left,
  };
}

function sameRect(first, second) {
  return first.x === second.x
    && first.y === second.y
    && first.width === second.width
    && first.height === second.height;
}

function writeDescription(owner, noteId, add) {
  if (owner === null) {
    return;
  }
  const current = owner.getAttribute('aria-describedby');
  const next = add
    ? addDescriptionToken(current, noteId)
    : removeDescriptionToken(current, noteId);
  if (next === null) {
    owner.removeAttribute('aria-describedby');
  } else {
    owner.setAttribute('aria-describedby', next);
  }
}

function createPath(doc, classes, value) {
  const path = doc.createElementNS(SVG_NAMESPACE, 'path');
  path.setAttribute('class', `hana-path ${classes}`);
  path.setAttribute('d', value);
  path.setAttribute('pathLength', '1');
  return path;
}

function cssTime(value, fallback) {
  const input = value.trim();
  const amount = Number.parseFloat(input);
  if (!Number.isFinite(amount) || amount < 0) {
    return fallback;
  }
  if (input.endsWith('ms')) {
    return amount;
  }
  if (input.endsWith('s')) {
    return amount * 1000;
  }
  return fallback;
}

function cssPixels(value, fallback) {
  const input = value.trim();
  const amount = Number.parseFloat(input);
  return Number.isFinite(amount) && amount >= 0 && input.endsWith('px') ? amount : fallback;
}

export function readThemeMetrics(element) {
  // Controllers consume noteGap during their scheduler read before calling pure placement geometry.
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  return {
    duration: cssTime(style.getPropertyValue('--hana-duration'), 650),
    noteGap: cssPixels(style.getPropertyValue('--hana-note-gap'), 16),
  };
}

export function createRenderer({ id, record, options, lease }) {
  const { shared } = lease;
  shared.generationFor(id);
  const doc = shared.overlay.ownerDocument;
  const win = doc.defaultView;
  const noteId = `hana-note-${id}`;
  const group = doc.createElementNS(SVG_NAMESPACE, 'g');
  group.setAttribute('class', 'hana-annotation');
  group.setAttribute('data-hana-id', id);
  group.setAttribute('data-hana-mark', options.mark);
  group.setAttribute('hidden', '');
  shared.svgLayer.append(group);

  const noteElement = options.note === null ? null : doc.createElement('div');
  if (noteElement !== null) {
    noteElement.className = 'hana-note';
    noteElement.setAttribute('data-hana-id', id);
    noteElement.setAttribute('data-hana-note', '');
    noteElement.id = noteId;
    noteElement.textContent = options.note;
    noteElement.classList.add('hana-is-hidden');
    if (!options.accessible) {
      noteElement.setAttribute('aria-hidden', 'true');
    }
    shared.noteLayer.append(noteElement);
  }

  let owner = record.ownerElement ?? null;
  let descriptionAssociated = false;
  let destroyed = false;
  let activeAnimations = [];
  let layoutVisible = true;
  let motionRun = null;
  let overflowSequence = 0;

  function associateDescription() {
    if (noteElement === null || !options.accessible) {
      return;
    }
    const ownerHasToken = typeof owner?.getAttribute === 'function'
      && descriptionTokens(owner.getAttribute('aria-describedby')).includes(noteId);
    if (descriptionAssociated && ownerHasToken) return;
    writeDescription(owner, noteId, true);
    descriptionAssociated = true;
  }

  function removeDescription() {
    if (!descriptionAssociated) {
      return;
    }
    writeDescription(owner, noteId, false);
    descriptionAssociated = false;
  }

  function scheduleOverflowCheck() {
    if (noteElement === null || !options.accessible) {
      return;
    }
    const sequence = ++overflowSequence;
    const generation = shared.generationFor(id);
    shared.enqueue({
      id,
      generation,
      read() {
        return {
          overflowing: noteElement.scrollHeight > noteElement.clientHeight,
          sequence,
        };
      },
      write(result) {
        if (destroyed || result.sequence !== overflowSequence) {
          return;
        }
        if (result.overflowing) {
          noteElement.setAttribute('tabindex', '0');
        } else {
          noteElement.removeAttribute('tabindex');
        }
      },
    });
  }

  function applyLayoutVisibility() {
    if (noteElement !== null) {
      noteElement.hidden = false;
      associateDescription();
    }
    if (!layoutVisible) {
      overflowSequence += 1;
      group.setAttribute('hidden', '');
      group.classList.remove('hana-is-visible');
      if (noteElement !== null) {
        noteElement.classList.add('hana-is-hidden');
        noteElement.classList.remove('hana-is-visible');
        noteElement.removeAttribute('tabindex');
      }
      return;
    }
    group.removeAttribute('hidden');
    group.classList.add('hana-is-visible');
    if (noteElement !== null) {
      noteElement.classList.remove('hana-is-hidden');
      noteElement.classList.add('hana-is-visible');
      scheduleOverflowCheck();
    }
  }

  function measure() {
    const visualViewport = win.visualViewport;
    const noteRect = noteElement === null ? null : copyRect(noteElement.getBoundingClientRect());
    const peerNoteRects = [];
    const addPeerRect = (input) => {
      const candidate = copyRect(input);
      if (!peerNoteRects.some((peer) => sameRect(peer, candidate))) {
        peerNoteRects.push(candidate);
      }
    };
    [...shared.noteLayer.children]
      .filter((candidate) => (
        candidate !== noteElement
        && !candidate.hidden
        && !candidate.classList.contains('hana-is-hidden')
      ))
      .forEach((candidate) => addPeerRect(candidate.getBoundingClientRect()));
    shared.notePlacementReservations(id).forEach(addPeerRect);
    return {
      noteRect,
      peerNoteRects,
      viewport: {
        width: visualViewport?.width ?? win.innerWidth,
        height: visualViewport?.height ?? win.innerHeight,
        left: visualViewport?.offsetLeft ?? 0,
        top: visualViewport?.offsetTop ?? 0,
      },
    };
  }

  function reserveNote(rect) {
    return shared.reserveNotePlacement(id, rect);
  }

  function draw(layout) {
    if (destroyed) {
      return;
    }
    const fragment = doc.createDocumentFragment();
    for (const value of layout.markPaths) {
      fragment.append(createPath(doc, 'hana-mark-path', value));
    }
    if (layout.connector.shaft) {
      fragment.append(createPath(
        doc,
        'hana-connector-path hana-connector-shaft',
        layout.connector.shaft,
      ));
    }
    if (layout.connector.head) {
      fragment.append(createPath(
        doc,
        'hana-connector-path hana-connector-head',
        layout.connector.head,
      ));
    }
    layoutVisible = layout.targetVisible !== false;
    group.replaceChildren(fragment);

    if (noteElement !== null) {
      noteElement.style.setProperty('--hana-visual-viewport-width', `${layout.viewport.width}px`);
      noteElement.style.setProperty('--hana-visual-viewport-height', `${layout.viewport.height}px`);
      noteElement.style.left = `${layout.noteRect.x}px`;
      noteElement.style.top = `${layout.noteRect.y}px`;
      noteElement.setAttribute('data-hana-side', layout.side);
    }
    applyLayoutVisibility();
  }

  function updateOwner(nextOwner) {
    if (destroyed || nextOwner === owner) {
      return;
    }
    if (descriptionAssociated) {
      writeDescription(owner, noteId, false);
      writeDescription(nextOwner, noteId, true);
    }
    owner = nextOwner;
  }

  function setMotionClass(name, enabled) {
    group.classList.toggle(name, enabled);
    noteElement?.classList.toggle(name, enabled);
  }

  function applyFinalStyles() {
    for (const path of group.querySelectorAll('.hana-path')) {
      path.style.strokeDasharray = '1';
      path.style.strokeDashoffset = '0';
    }
    if (options.mark === 'highlight') {
      for (const path of group.querySelectorAll('.hana-mark-path')) {
        path.style.clipPath = 'inset(0px 0% 0px 0px)';
      }
    }
    if (noteElement !== null) {
      noteElement.style.opacity = '1';
      noteElement.style.transform = 'translateY(0px)';
    }
    setMotionClass('hana-is-animating', false);
    setMotionClass('hana-is-paused', false);
  }

  function settleMotion(run) {
    if (run.settled) {
      return;
    }
    run.settled = true;
    run.clock.cancel();
    activeAnimations = [];
    applyFinalStyles();
    if (motionRun === run) {
      motionRun = null;
    }
    run.resolve();
  }

  function rejectMotion(run) {
    if (run === null || run.settled) {
      return;
    }
    run.settled = true;
    run.clock.cancel();
    if (motionRun === run) {
      motionRun = null;
    }
    setMotionClass('hana-is-animating', false);
    setMotionClass('hana-is-paused', false);
    run.reject(new win.DOMException('Animation cancelled', 'AbortError'));
  }

  function createMotionRun(duration) {
    let resolve;
    let reject;
    const finished = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    finished.catch(() => {});
    const run = {
      clock: null,
      finished,
      paused: false,
      reject,
      resolve,
      settled: false,
    };
    run.clock = createDurationClock({
      duration,
      now: () => win.performance.now(),
      setTimeout: (callback, delay) => win.setTimeout(callback, delay),
      clearTimeout: (timeout) => win.clearTimeout(timeout),
      complete: () => settleMotion(run),
    });
    motionRun = run;
    run.clock.resume();
    return run;
  }

  function cancelMotion() {
    for (const animation of activeAnimations) {
      animation.cancel();
    }
    activeAnimations = [];
    rejectMotion(motionRun);
  }

  function animate(duration) {
    if (destroyed) {
      return { animations: [], finished: Promise.resolve() };
    }
    cancelMotion();
    applyLayoutVisibility();

    const resolvedDuration = duration ?? readThemeMetrics(group).duration;
    const markDuration = resolvedDuration * 0.55;
    const connectorDuration = resolvedDuration * 0.25;
    const connectorDelay = resolvedDuration * 0.55;
    const noteDuration = resolvedDuration * 0.2;
    const noteDelay = resolvedDuration * 0.8;
    group.style.setProperty('--hana-mark-duration', `${markDuration}ms`);
    group.style.setProperty('--hana-mark-delay', '0ms');
    group.style.setProperty('--hana-connector-duration', `${connectorDuration}ms`);
    group.style.setProperty('--hana-connector-delay', `${connectorDelay}ms`);
    if (noteElement !== null) {
      noteElement.style.setProperty('--hana-note-duration', `${noteDuration}ms`);
      noteElement.style.setProperty('--hana-note-delay', `${noteDelay}ms`);
    }
    if (resolvedDuration === 0) {
      applyFinalStyles();
      return { animations: [], finished: Promise.resolve() };
    }

    const markPaths = [...group.querySelectorAll('.hana-mark-path')];
    const connectorPaths = [...group.querySelectorAll('.hana-connector-path')];
    const run = createMotionRun(resolvedDuration);
    if (typeof group.animate === 'function') {
      const animations = [];
      const track = (animation) => {
        animation.finished.catch(() => {});
        animations.push(animation);
      };
      const animatePath = (path, phaseDuration, delay, highlight = false) => {
        if (highlight) {
          path.style.clipPath = 'inset(0px 100% 0px 0px)';
          track(path.animate(
            [
              { clipPath: 'inset(0px 100% 0px 0px)' },
              { clipPath: 'inset(0px 0% 0px 0px)' },
            ],
            { duration: phaseDuration, delay, fill: 'both', easing: 'ease-out' },
          ));
          return;
        }
        path.style.strokeDasharray = '1';
        path.style.strokeDashoffset = '1';
        track(path.animate(
          [
            { strokeDasharray: '1', strokeDashoffset: '1' },
            { strokeDasharray: '1', strokeDashoffset: '0' },
          ],
          { duration: phaseDuration, delay, fill: 'both', easing: 'ease-out' },
        ));
      };
      for (const path of markPaths) {
        animatePath(path, markDuration, 0, options.mark === 'highlight');
      }
      for (const path of connectorPaths) {
        animatePath(path, connectorDuration, connectorDelay);
      }
      if (noteElement !== null) {
        track(noteElement.animate(
          [
            { opacity: 0, transform: 'translateY(6px)' },
            { opacity: 1, transform: 'translateY(0px)' },
          ],
          { duration: noteDuration, delay: noteDelay, fill: 'both', easing: 'ease-out' },
        ));
      }
      activeAnimations = animations;
      return { animations, finished: run.finished };
    }

    setMotionClass('hana-is-animating', true);
    return { animations: [], finished: run.finished };
  }

  function pause() {
    for (const animation of activeAnimations) {
      animation.pause();
    }
    const run = motionRun;
    if (run === null || run.paused || run.settled) {
      return;
    }
    run.clock.pause();
    run.paused = true;
    setMotionClass('hana-is-paused', true);
  }

  function resume() {
    for (const animation of activeAnimations) {
      animation.play();
    }
    const run = motionRun;
    if (run === null || !run.paused || run.settled) {
      return;
    }
    run.paused = false;
    setMotionClass('hana-is-paused', false);
    run.clock.resume();
  }

  function finish() {
    for (const animation of activeAnimations) {
      animation.finish();
    }
    if (motionRun !== null) {
      settleMotion(motionRun);
    } else {
      applyFinalStyles();
    }
  }

  function hide() {
    if (destroyed) {
      return;
    }
    cancelMotion();
    removeDescription();
    overflowSequence += 1;
    group.setAttribute('hidden', '');
    group.classList.remove('hana-is-visible');
    if (noteElement !== null) {
      noteElement.classList.add('hana-is-hidden');
      noteElement.classList.remove('hana-is-visible');
      noteElement.removeAttribute('tabindex');
    }
  }

  function destroy() {
    if (destroyed) {
      return;
    }
    destroyed = true;
    cancelMotion();
    removeDescription();
    overflowSequence += 1;
    group.remove();
    noteElement?.remove();
  }

  return {
    group,
    noteElement,
    measure,
    reserveNote,
    draw,
    animate,
    updateOwner,
    pause,
    resume,
    finish,
    hide,
    destroy,
  };
}
