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

export function createRenderer({ id, record, options, lease }) {
  const { shared } = lease;
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
  let destroyed = false;
  let activeAnimations = [];
  let fallbackClock = null;
  let overflowSequence = 0;
  if (noteElement !== null && options.accessible) {
    writeDescription(owner, noteId, true);
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

  function measure() {
    const noteRect = noteElement === null ? null : copyRect(noteElement.getBoundingClientRect());
    const peerNoteRects = [...shared.noteLayer.children]
      .filter((candidate) => (
        candidate !== noteElement
        && !candidate.hidden
        && !candidate.classList.contains('hana-is-hidden')
      ))
      .map((candidate) => copyRect(candidate.getBoundingClientRect()));
    return {
      noteRect,
      peerNoteRects,
      viewport: { width: win.innerWidth, height: win.innerHeight },
    };
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
    group.replaceChildren(fragment);
    group.removeAttribute('hidden');
    group.classList.add('hana-is-visible');

    if (noteElement !== null) {
      noteElement.style.left = `${layout.noteRect.x}px`;
      noteElement.style.top = `${layout.noteRect.y}px`;
      noteElement.setAttribute('data-hana-side', layout.side);
      noteElement.hidden = false;
      noteElement.classList.remove('hana-is-hidden');
      noteElement.classList.add('hana-is-visible');
      scheduleOverflowCheck();
    }
  }

  function updateOwner(nextOwner) {
    if (destroyed || nextOwner === owner) {
      return;
    }
    if (noteElement !== null && options.accessible) {
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
    if (noteElement !== null) {
      noteElement.style.opacity = '1';
      noteElement.style.transform = 'translateY(0px)';
    }
    setMotionClass('hana-is-animating', false);
    setMotionClass('hana-is-paused', false);
  }

  function settleFallback(clock) {
    if (clock.settled) {
      return;
    }
    clock.settled = true;
    if (clock.timeout !== null) {
      win.clearTimeout(clock.timeout);
    }
    applyFinalStyles();
    if (fallbackClock === clock) {
      fallbackClock = null;
    }
    clock.resolve();
  }

  function scheduleFallback(clock) {
    const remaining = Math.max(0, clock.duration - clock.elapsed);
    clock.startedAt = win.performance.now();
    clock.timeout = win.setTimeout(() => settleFallback(clock), remaining);
  }

  function cancelMotion() {
    for (const animation of activeAnimations) {
      animation.cancel();
    }
    activeAnimations = [];
    if (fallbackClock !== null) {
      settleFallback(fallbackClock);
    }
  }

  function animate(duration) {
    if (destroyed) {
      return { animations: [], finished: Promise.resolve() };
    }
    cancelMotion();
    group.removeAttribute('hidden');
    if (noteElement !== null) {
      noteElement.hidden = false;
      noteElement.classList.remove('hana-is-hidden');
    }

    const markDuration = duration * 0.55;
    const connectorDuration = duration * 0.25;
    const connectorDelay = duration * 0.55;
    const noteDuration = duration * 0.2;
    const noteDelay = duration * 0.8;
    if (duration === 0) {
      applyFinalStyles();
      return { animations: [], finished: Promise.resolve() };
    }

    const markPaths = [...group.querySelectorAll('.hana-mark-path')];
    const connectorPaths = [...group.querySelectorAll('.hana-connector-path')];
    if (typeof group.animate === 'function') {
      const animations = [];
      const animatePath = (path, phaseDuration, delay) => {
        path.style.strokeDasharray = '1';
        path.style.strokeDashoffset = '1';
        animations.push(path.animate(
          [
            { strokeDasharray: '1', strokeDashoffset: '1' },
            { strokeDasharray: '1', strokeDashoffset: '0' },
          ],
          { duration: phaseDuration, delay, fill: 'both', easing: 'ease-out' },
        ));
      };
      for (const path of markPaths) {
        animatePath(path, markDuration, 0);
      }
      for (const path of connectorPaths) {
        animatePath(path, connectorDuration, connectorDelay);
      }
      if (noteElement !== null) {
        animations.push(noteElement.animate(
          [
            { opacity: 0, transform: 'translateY(6px)' },
            { opacity: 1, transform: 'translateY(0px)' },
          ],
          { duration: noteDuration, delay: noteDelay, fill: 'both', easing: 'ease-out' },
        ));
      }
      activeAnimations = animations;
      const finished = Promise.all(animations.map((animation) => animation.finished))
        .then(() => applyFinalStyles());
      return { animations, finished };
    }

    group.style.setProperty('--hana-duration', `${duration}ms`);
    group.style.setProperty('--hana-mark-duration', `${markDuration}ms`);
    group.style.setProperty('--hana-mark-delay', '0ms');
    group.style.setProperty('--hana-connector-duration', `${connectorDuration}ms`);
    group.style.setProperty('--hana-connector-delay', `${connectorDelay}ms`);
    if (noteElement !== null) {
      noteElement.style.setProperty('--hana-duration', `${duration}ms`);
      noteElement.style.setProperty('--hana-note-duration', `${noteDuration}ms`);
      noteElement.style.setProperty('--hana-note-delay', `${noteDelay}ms`);
    }
    setMotionClass('hana-is-animating', true);
    let resolveFinished;
    const finished = new Promise((resolve) => {
      resolveFinished = resolve;
    });
    const clock = {
      duration,
      elapsed: 0,
      paused: false,
      resolve: resolveFinished,
      settled: false,
      startedAt: win.performance.now(),
      timeout: null,
    };
    fallbackClock = clock;
    scheduleFallback(clock);
    return { animations: [], finished };
  }

  function pause() {
    for (const animation of activeAnimations) {
      animation.pause();
    }
    const clock = fallbackClock;
    if (clock === null || clock.paused || clock.settled) {
      return;
    }
    clock.elapsed = Math.min(
      clock.duration,
      clock.elapsed + (win.performance.now() - clock.startedAt),
    );
    win.clearTimeout(clock.timeout);
    clock.timeout = null;
    clock.paused = true;
    setMotionClass('hana-is-paused', true);
  }

  function resume() {
    for (const animation of activeAnimations) {
      animation.play();
    }
    const clock = fallbackClock;
    if (clock === null || !clock.paused || clock.settled) {
      return;
    }
    clock.paused = false;
    setMotionClass('hana-is-paused', false);
    scheduleFallback(clock);
  }

  function finish() {
    for (const animation of activeAnimations) {
      animation.finish();
    }
    if (fallbackClock !== null) {
      settleFallback(fallbackClock);
    } else {
      applyFinalStyles();
    }
  }

  function hide() {
    if (destroyed) {
      return;
    }
    cancelMotion();
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
    overflowSequence += 1;
    if (noteElement !== null && options.accessible) {
      writeDescription(owner, noteId, false);
    }
    group.remove();
    noteElement?.remove();
  }

  return {
    group,
    noteElement,
    measure,
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
