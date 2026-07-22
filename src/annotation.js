import {
  HanamaruConfigError,
  HanamaruStateError,
  HanamaruTargetError,
} from './errors.js';
import { buildConnector, buildMarkPaths, choosePlacement, unionRects } from './geometry.js';
import { createRenderer as createDomRenderer, readThemeMetrics } from './renderer.js';
import { acquireDocumentResources } from './scheduler.js';
import { resolveTarget } from './target.js';

const MARKS = new Set(['underline', 'highlight', 'circle', 'box', 'strike', 'bracket']);
const PLACEMENTS = new Set(['auto', 'top', 'right', 'bottom', 'left']);
const TRIGGERS = new Set(['manual', 'load', 'viewport']);
const MOTIONS = new Set(['system', 'never']);
const KEYS = new Set(['mark', 'note', 'placement', 'trigger', 'accessible', 'seed', 'duration', 'motion']);
const activeRenderers = new WeakMap();
let nextAnnotationId = 0;

function invalid(field, value) {
  throw new HanamaruConfigError(
    'HANA_CONFIG_INVALID',
    `Invalid annotation option: ${field}`,
    { field, value },
  );
}

function has(input, key) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function optional(input, key, fallback) {
  return has(input, key) ? input[key] : fallback;
}

export function normalizeOptions(input, fallbackSeed, { allowUnknown = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalid('input', input);
  }

  if (!allowUnknown) {
    for (const key of Object.keys(input)) {
      if (!KEYS.has(key)) invalid(key, input[key]);
    }
  }

  const mark = optional(input, 'mark', undefined);
  if (!MARKS.has(mark)) invalid('mark', mark);

  const note = optional(input, 'note', null);
  if (note !== null && typeof note !== 'string') invalid('note', note);
  if (typeof note === 'string' && [...note].length > 280) invalid('note', note);

  const placement = optional(input, 'placement', 'auto');
  if (!PLACEMENTS.has(placement)) invalid('placement', placement);

  const trigger = optional(input, 'trigger', 'manual');
  if (!TRIGGERS.has(trigger)) invalid('trigger', trigger);

  const accessible = optional(input, 'accessible', false);
  if (typeof accessible !== 'boolean') invalid('accessible', accessible);

  const seed = optional(input, 'seed', fallbackSeed);
  if (typeof seed !== 'string' && !(typeof seed === 'number' && Number.isFinite(seed))) {
    invalid('seed', seed);
  }

  const duration = optional(input, 'duration', 650);
  if (!Number.isInteger(duration) || duration < 0) invalid('duration', duration);

  const motion = optional(input, 'motion', 'system');
  if (!MOTIONS.has(motion)) invalid('motion', motion);

  return {
    mark,
    note: note === '' ? null : note,
    placement,
    trigger,
    accessible,
    seed,
    duration,
    motion,
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => {});
  return { promise, reject, resolve, settled: false };
}

export function abortError(reason = 'Annotation run cancelled') {
  return new DOMException(reason, 'AbortError');
}

function layoutFor(record, renderer, options, env) {
  const targetRects = env.targetRects(record);
  const targetRect = unionRects(targetRects);
  const measured = renderer.measure();
  const metrics = env.readThemeMetrics(renderer.group);
  const markPaths = buildMarkPaths(options.mark, targetRects, options.seed);

  if (measured.noteRect === null) {
    return {
      targetRects,
      unionRect: targetRect,
      markPaths,
      side: 'right',
      noteRect: null,
      connector: { shaft: '', head: '' },
      viewport: measured.viewport,
    };
  }

  const placement = choosePlacement({
    target: targetRect,
    noteSize: measured.noteRect,
    viewport: measured.viewport,
    placement: options.placement,
    dir: env.direction?.(record.ownerElement) ?? 'ltr',
    otherNotes: measured.peerNoteRects,
    gap: metrics.noteGap,
  });
  return {
    targetRects,
    unionRect: targetRect,
    markPaths,
    side: placement.side,
    noteRect: placement.rect,
    connector: buildConnector(targetRect, placement.rect, placement.side),
    viewport: measured.viewport,
  };
}

function dispatch(env, owner, type, detail) {
  env.createEvent(type, detail, owner);
}

function copyClientRect(input) {
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

function documentForTarget(target) {
  if (target?.nodeType === 1) return target.ownerDocument;
  if (target?.startContainer) {
    return target.startContainer.nodeType === 9
      ? target.startContainer
      : target.startContainer.ownerDocument;
  }
  if (target?.within?.nodeType === 1) return target.within.ownerDocument;
  if (typeof document !== 'undefined') return document;
  throw new TypeError('annotate() requires a target Document');
}

function defaultEnvironment(target) {
  const doc = documentForTarget(target);
  const win = doc.defaultView;
  const id = `hana-${++nextAnnotationId}`;
  let lease;

  return {
    id,
    get lease() {
      lease ??= acquireDocumentResources(doc);
      return lease;
    },
    createEvent(type, detail, owner) {
      owner.dispatchEvent(new win.CustomEvent(type, {
        detail,
        bubbles: true,
        composed: true,
      }));
    },
    createRenderer: createDomRenderer,
    direction(owner) { return win.getComputedStyle(owner).direction; },
    microtask(callback) { win.queueMicrotask(callback); },
    readThemeMetrics,
    reducedMotion(options) {
      return options.motion === 'never'
        || win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    },
    resolveTarget(candidate) { return resolveTarget(candidate, doc); },
    targetRects(record) {
      const rects = record.range === null
        ? [record.element.getBoundingClientRect()]
        : [...record.range.getClientRects()];
      return rects.map(copyClientRect);
    },
  };
}

export function annotate(target, options) {
  return createAnnotation(target, options, defaultEnvironment(target));
}

export function pauseAnnotationRun(controller) {
  activeRenderers.get(controller)?.pause();
}

export function resumeAnnotationRun(controller) {
  activeRenderers.get(controller)?.resume();
}

export function createAnnotation(target, rawOptions, env) {
  if (env === null || typeof env !== 'object') {
    throw new TypeError('annotation environment must be an object');
  }

  const id = env.id;
  let options = normalizeOptions(rawOptions, id);
  let currentTarget = target;
  let record = env.resolveTarget(target);
  const lease = env.lease;
  const { shared } = lease;
  let generation;
  let renderer;
  let stopLayout = null;

  try {
    generation = shared.registerController(id);
  } catch (error) {
    lease.release();
    throw error;
  }
  try {
    renderer = env.createRenderer({ id, record, options, lease });
  } catch (error) {
    shared.releaseController(id);
    lease.release();
    throw error;
  }

  let state = 'idle';
  let run = null;
  let requestedVisible = false;
  let destroyed = false;
  let disconnectedEpisode = false;

  const controller = {
    get state() { return state; },
    get finished() { return run?.promise ?? null; },
    show,
    hide,
    replay,
    refresh,
    update,
    destroy,
  };
  activeRenderers.set(controller, renderer);

  function settleVisible(activeRun = run) {
    if (destroyed || activeRun === null || activeRun !== run || activeRun.settled) return;
    activeRun.settled = true;
    state = 'visible';
    activeRun.resolve();
    dispatch(env, record.ownerElement, 'hana:complete', { controller, state });
  }

  function rejectRun(error, activeRun = run) {
    if (activeRun === null || activeRun.settled) return;
    activeRun.settled = true;
    activeRun.reject(error);
  }

  function runtimeError(cause) {
    if (cause instanceof HanamaruStateError) return cause;
    return new HanamaruStateError(
      'HANA_STATE_RUNTIME',
      'Annotation rendering or scheduling failed',
      { cause },
    );
  }

  function handleRuntimeFailure(cause) {
    const error = runtimeError(cause);
    requestedVisible ||= state === 'showing' || state === 'visible';
    try { renderer.hide(); } catch { /* Preserve the originating runtime failure. */ }
    rejectRun(error);
    state = 'suspended';
    if (!disconnectedEpisode) {
      disconnectedEpisode = true;
      dispatch(env, record.ownerElement, 'hana:error', { controller, error });
    }
  }

  function handleScheduledFailure(error) {
    if (error instanceof HanamaruTargetError) reportTargetFailure(error);
    else handleRuntimeFailure(error);
  }

  function layoutBinding() {
    return {
      id,
      generation,
      record,
      note: renderer.noteElement,
      read: () => {
        const previousOwner = record.ownerElement;
        resolveCurrentTarget();
        renderer.updateOwner(record.ownerElement);
        return {
          layout: !requestedVisible && (state === 'idle' || state === 'hidden')
            ? null
            : layoutFor(record, renderer, options, env),
          ownerChanged: previousOwner !== record.ownerElement,
        };
      },
      write: (result) => {
        if (result.layout !== null) {
          renderer.draw(result.layout);
          if (state === 'suspended' && requestedVisible) {
            renderer.finish();
            state = 'visible';
          }
        }
        if (result.ownerChanged) rebindOrSuspend();
      },
      onError: handleScheduledFailure,
    };
  }

  function bindLayout() {
    stopLayout = shared.observeLayout(layoutBinding());
  }

  function rebindLayout() {
    generation = shared.bumpGeneration(id);
    stopLayout?.();
    stopLayout = shared.rebindLayout(id, layoutBinding());
  }

  function rebindOrSuspend() {
    try {
      rebindLayout();
      return true;
    } catch (error) {
      handleRuntimeFailure(error);
      return false;
    }
  }

  function schedule({ animate = false, finish = false, restore = false } = {}) {
    const activeRun = run;
    try {
      shared.enqueue({
        id,
        generation,
        read: () => {
          resolveCurrentTarget();
          renderer.updateOwner(record.ownerElement);
          return layoutFor(record, renderer, options, env);
        },
        write(layout) {
          renderer.draw(layout);
          if (finish) {
            renderer.finish();
            if (restore) {
              state = 'visible';
            } else {
              settleVisible(activeRun);
            }
            return;
          }
          if (!animate) return;
          const duration = env.reducedMotion(options) ? 0 : options.duration;
          const motion = renderer.animate(duration);
          motion.finished.then(
            () => settleVisible(activeRun),
            (error) => {
              if (error?.name !== 'AbortError') handleRuntimeFailure(error);
            },
          );
        },
        onError: handleScheduledFailure,
      });
    } catch (error) {
      handleRuntimeFailure(error);
    }
  }

  function startDeferredRun() {
    run = createDeferred();
    requestedVisible = true;
  }

  function reportTargetFailure(error) {
    requestedVisible ||= state === 'showing' || state === 'visible';
    renderer.hide();
    rejectRun(error);
    state = 'suspended';
    if (!disconnectedEpisode) {
      disconnectedEpisode = true;
      dispatch(env, record.ownerElement, 'hana:error', { controller, error });
    }
  }

  function resolveCurrentTarget() {
    const resolved = record.refresh();
    disconnectedEpisode = false;
    return resolved;
  }

  function startResolvedRun() {
    state = 'showing';
    dispatch(env, record.ownerElement, 'hana:start', { controller, state });
    schedule({ animate: true });
  }

  function show() {
    if (destroyed || state === 'showing' || state === 'visible') return controller;
    startDeferredRun();
    try {
      resolveCurrentTarget();
    } catch (error) {
      reportTargetFailure(error);
      return controller;
    }
    startResolvedRun();
    return controller;
  }

  function cancelPending(reason, notify = false) {
    if (run !== null && !run.settled) {
      rejectRun(abortError());
    }
    if (notify) {
      dispatch(env, record.ownerElement, 'hana:cancel', { controller, reason });
    }
  }

  function hide() {
    if (destroyed) return controller;
    const wasActive = state === 'showing' || state === 'visible';
    requestedVisible = false;
    cancelPending('hide', wasActive);
    if (wasActive || state === 'idle' || state === 'hidden' || state === 'suspended') renderer.hide();
    if (wasActive && !rebindOrSuspend()) return controller;
    state = 'hidden';
    return controller;
  }

  function replay() {
    if (destroyed) return controller;
    const wasActive = state === 'showing' || state === 'visible';
    cancelPending('replay', wasActive);
    renderer.hide();
    startDeferredRun();
    if (!rebindOrSuspend()) return controller;
    try {
      resolveCurrentTarget();
    } catch (error) {
      reportTargetFailure(error);
      return controller;
    }
    startResolvedRun();
    return controller;
  }

  function refresh() {
    if (destroyed) return controller;
    const priorState = state;
    try {
      resolveCurrentTarget();
    } catch (error) {
      reportTargetFailure(error);
      return controller;
    }
    renderer.updateOwner(record.ownerElement);
    if (!rebindOrSuspend()) return controller;
    if (priorState === 'showing') schedule({ finish: true });
    else if (priorState === 'visible') schedule({ finish: true, restore: true });
    else if (priorState === 'suspended') {
      if (requestedVisible) schedule({ finish: true, restore: true });
      else state = 'hidden';
    }
    return controller;
  }

  function update(patch) {
    if (destroyed) return controller;
    const next = patch ?? {};
    const nextTarget = Object.prototype.hasOwnProperty.call(next, 'target') ? next.target : currentTarget;
    const optionPatch = { ...next };
    delete optionPatch.target;
    const nextOptions = normalizeOptions({ ...options, ...optionPatch }, options.seed);
    const nextRecord = env.resolveTarget(nextTarget);
    const nextRenderer = env.createRenderer({ id, record: nextRecord, options: nextOptions, lease });
    const oldRenderer = renderer;
    const oldTarget = currentTarget;
    const oldOptions = options;
    const oldRecord = record;
    const priorState = state;
    currentTarget = nextTarget;
    options = nextOptions;
    record = nextRecord;
    renderer = nextRenderer;
    activeRenderers.set(controller, renderer);
    try {
      rebindLayout();
    } catch (error) {
      renderer.destroy();
      renderer = oldRenderer;
      currentTarget = oldTarget;
      options = oldOptions;
      record = oldRecord;
      activeRenderers.set(controller, renderer);
      handleRuntimeFailure(error);
      return controller;
    }
    oldRenderer.destroy();
    if (priorState === 'showing') schedule({ finish: true });
    else if (priorState === 'visible') schedule({ finish: true, restore: true });
    else if (priorState === 'suspended' && requestedVisible) schedule({ finish: true, restore: true });
    else if (priorState === 'suspended') state = 'hidden';
    return controller;
  }

  function destroy() {
    if (destroyed) return controller;
    const wasActive = state === 'showing' || state === 'visible';
    cancelPending('destroy', wasActive);
    destroyed = true;
    stopLayout?.();
    renderer.destroy();
    activeRenderers.delete(controller);
    shared.releaseController(id);
    lease.release();
    state = 'destroyed';
    return controller;
  }

  try {
    bindLayout();
  } catch (error) {
    activeRenderers.delete(controller);
    renderer.destroy();
    shared.releaseController(id);
    lease.release();
    throw error;
  }
  return controller;
}
