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
const DEFAULT_SHADOW_Z_INDEX = '2147483000';
const SHADOW_THEME_PROPERTIES = Object.freeze([
  '--hana-color',
  '--hana-mark-color',
  '--hana-highlight-color',
  '--hana-note-background',
  '--hana-note-color',
  '--hana-stroke-width',
  '--hana-padding',
  '--hana-note-gap',
  '--hana-font',
  '--hana-duration',
]);

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

export function readThemeMetrics(element, view = undefined) {
  // Controllers consume noteGap during their scheduler read before calling pure placement geometry.
  const style = (view ?? element.ownerDocument.defaultView).getComputedStyle(element);
  return {
    duration: cssTime(style.getPropertyValue('--hana-duration'), 650),
    noteGap: cssPixels(style.getPropertyValue('--hana-note-gap'), 16),
  };
}

function readShadowTheme(description, owner, view) {
  if (description === null || description.host === null) return null;
  const ownerStyle = view.getComputedStyle(owner);
  const hostStyle = view.getComputedStyle(description.host);
  const values = {};
  for (const name of SHADOW_THEME_PROPERTIES) {
    const value = ownerStyle.getPropertyValue(name).trim()
      || hostStyle.getPropertyValue(name).trim();
    if (value !== '') values[name] = value;
  }
  return {
    duration: cssTime(values['--hana-duration'] ?? '', 650),
    noteGap: cssPixels(values['--hana-note-gap'] ?? '', 16),
    values,
    zIndex: hostStyle.getPropertyValue('--hana-z-index').trim()
      || DEFAULT_SHADOW_Z_INDEX,
  };
}

function sameShadowTheme(left, right) {
  if (left === null || right === null) return left === right;
  if (left.zIndex !== right.zIndex) return false;
  return SHADOW_THEME_PROPERTIES.every(
    (name) => left.values[name] === right.values[name],
  );
}

function visualViewportSnapshot(view) {
  const viewport = view.visualViewport;
  return {
    width: viewport?.width ?? view.innerWidth,
    height: viewport?.height ?? view.innerHeight,
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
  };
}

function sameViewport(left, right) {
  return left !== null
    && left.width === right.width
    && left.height === right.height
    && left.left === right.left
    && left.top === right.top;
}

export function createRenderer({
  id,
  record,
  options,
  lease,
  description = null,
  view = undefined,
}) {
  const { shared } = lease;
  shared.generationFor(id);
  const doc = shared.overlay.ownerDocument;
  const win = view ?? doc.defaultView;
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
    if (!options.accessible || description !== null) {
      noteElement.setAttribute('aria-hidden', 'true');
    }
    shared.noteLayer.append(noteElement);
  }

  let owner = record.ownerElement ?? null;
  let appliedTheme = null;
  let appliedViewport = null;
  let descriptionAssociated = false;
  let descriptionMirror = null;
  let destroyed = false;
  let activeAnimations = [];
  let blurCheckInstalled = false;
  let layoutVisible = true;
  let motionRun = null;
  let overflowSequence = 0;

  function onOverflowNoteKeydown(event) {
    if (noteElement?.getAttribute('role') !== 'note') return;
    const page = Math.max(1, noteElement.clientHeight);
    const commands = {
      ArrowDown: () => { noteElement.scrollTop += 24; },
      ArrowUp: () => { noteElement.scrollTop -= 24; },
      End: () => { noteElement.scrollTop = noteElement.scrollHeight; },
      Home: () => { noteElement.scrollTop = 0; },
      PageDown: () => { noteElement.scrollTop += page; },
      PageUp: () => { noteElement.scrollTop -= page; },
    };
    const command = commands[event.key];
    if (command === undefined) return;
    event.preventDefault();
    command();
  }

  if (noteElement !== null && description !== null && options.accessible) {
    noteElement.addEventListener('keydown', onOverflowNoteKeydown);
  }

  function noteIsFocused() {
    return noteElement !== null && doc.activeElement === noteElement;
  }

  function onOverflowNoteBlur() {
    blurCheckInstalled = false;
    if (!destroyed) scheduleOverflowCheck();
  }

  function removeDeferredBlurCheck() {
    if (!blurCheckInstalled) return;
    blurCheckInstalled = false;
    noteElement?.removeEventListener('blur', onOverflowNoteBlur);
  }

  function cancelOverflowChecks() {
    overflowSequence += 1;
    removeDeferredBlurCheck();
  }

  function deferOrdinaryNoteState() {
    if (noteElement === null) return;
    noteElement.removeAttribute('aria-hidden');
    noteElement.setAttribute('role', 'note');
    noteElement.setAttribute('tabindex', '0');
    if (blurCheckInstalled) return;
    blurCheckInstalled = true;
    noteElement.addEventListener('blur', onOverflowNoteBlur, { once: true });
  }

  function applyOverflowState(overflowing) {
    if (noteElement === null) return;
    if (description === null) {
      if (overflowing) noteElement.setAttribute('tabindex', '0');
      else noteElement.removeAttribute('tabindex');
      return;
    }
    if (overflowing) {
      removeDeferredBlurCheck();
      noteElement.removeAttribute('aria-hidden');
      noteElement.setAttribute('role', 'note');
      noteElement.setAttribute('tabindex', '0');
      return;
    }
    if (noteIsFocused()) {
      deferOrdinaryNoteState();
      return;
    }
    removeDeferredBlurCheck();
    noteElement.setAttribute('aria-hidden', 'true');
    noteElement.removeAttribute('role');
    noteElement.removeAttribute('tabindex');
  }

  function prepareTheme() {
    return {
      theme: readShadowTheme(description, owner, win),
      viewport: visualViewportSnapshot(win),
    };
  }

  function applyTheme(stage) {
    const { theme, viewport } = stage;
    if (!sameShadowTheme(appliedTheme, theme)) {
      for (const name of SHADOW_THEME_PROPERTIES) {
        const value = theme?.values[name];
        if (value === undefined) {
          group.style.removeProperty(name);
          noteElement?.style.removeProperty(name);
        } else {
          group.style.setProperty(name, value);
          noteElement?.style.setProperty(name, value);
        }
      }
      if (theme !== null) description.portal.style.zIndex = theme.zIndex;
      appliedTheme = theme;
    }
    if (!sameViewport(appliedViewport, viewport)) {
      noteElement?.style.setProperty('--hana-visual-viewport-width', `${viewport.width}px`);
      noteElement?.style.setProperty('--hana-visual-viewport-height', `${viewport.height}px`);
      appliedViewport = viewport;
    }
  }

  function resetScopedNoteAccessibility() {
    if (noteElement === null || description === null || !options.accessible) return;
    cancelOverflowChecks();
    if (noteIsFocused()) noteElement.blur();
    noteElement.setAttribute('aria-hidden', 'true');
    noteElement.removeAttribute('role');
    noteElement.removeAttribute('tabindex');
  }

  function associateDescription() {
    if (noteElement === null || !options.accessible) {
      return;
    }
    if (description !== null) {
      if (descriptionMirror === null) {
        descriptionMirror = description.create(owner, options.note);
      }
      descriptionAssociated = true;
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
    if (descriptionMirror !== null) {
      const mirror = descriptionMirror;
      descriptionMirror = null;
      description.remove(mirror);
    } else {
      writeDescription(owner, noteId, false);
    }
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
          overflowing: noteElement.scrollHeight > noteElement.clientHeight
            || noteElement.scrollWidth > noteElement.clientWidth,
          sequence,
        };
      },
      write(result) {
        if (destroyed || result.sequence !== overflowSequence) {
          return;
        }
        applyOverflowState(result.overflowing);
      },
    });
  }

  function applyLayoutVisibility() {
    if (noteElement !== null) {
      noteElement.hidden = false;
      associateDescription();
    }
    if (!layoutVisible) {
      group.setAttribute('hidden', '');
      group.classList.remove('hana-is-visible');
      if (noteElement !== null) {
        noteElement.classList.add('hana-is-hidden');
        noteElement.classList.remove('hana-is-visible');
        if (description === null) {
          overflowSequence += 1;
          noteElement.removeAttribute('tabindex');
        } else {
          resetScopedNoteAccessibility();
        }
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
    const theme = appliedTheme;
    const viewport = appliedViewport ?? visualViewportSnapshot(win);
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
      viewport,
      ...(theme === null ? {} : { theme }),
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
    if (descriptionAssociated && description !== null) {
      removeDescription();
      owner = nextOwner;
      associateDescription();
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
    group.setAttribute('hidden', '');
    group.classList.remove('hana-is-visible');
    if (noteElement !== null) {
      noteElement.classList.add('hana-is-hidden');
      noteElement.classList.remove('hana-is-visible');
      if (description === null) {
        overflowSequence += 1;
        noteElement.removeAttribute('tabindex');
      } else {
        resetScopedNoteAccessibility();
      }
    }
  }

  function destroy() {
    if (destroyed) {
      return;
    }
    destroyed = true;
    cancelOverflowChecks();
    noteElement?.removeEventListener('keydown', onOverflowNoteKeydown);
    cancelMotion();
    removeDescription();
    group.remove();
    noteElement?.remove();
  }

  const renderer = {
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
  Object.defineProperties(renderer, {
    prepareTheme: { value: prepareTheme },
    applyTheme: { value: applyTheme },
  });
  return renderer;
}
