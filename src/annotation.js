import {
  HanamaruConfigError,
  HanamaruStateError,
  HanamaruTargetError,
} from './errors.js';
import { buildConnector, buildMarkPaths, choosePlacement, unionRects } from './geometry.js';
import {
  createRenderer as createDomRenderer,
  readThemeMetrics,
  removeDescriptionToken,
} from './renderer.js';
import { acquireDocumentResources } from './scheduler.js';
import { resolveTarget } from './target.js';

const MARKS = new Set(['underline', 'highlight', 'circle', 'box', 'strike', 'bracket']);
const PLACEMENTS = new Set(['auto', 'top', 'right', 'bottom', 'left']);
const TRIGGERS = new Set(['manual', 'load', 'viewport']);
const MOTIONS = new Set(['system', 'never']);
const KEYS = new Set(['mark', 'note', 'placement', 'trigger', 'accessible', 'seed', 'duration', 'motion']);
const activeRenderers = new WeakMap();
const pendingRendererMounts = new WeakMap();
let nextAnnotationId = 0;

function stateError(cause) {
  if (cause instanceof HanamaruStateError) return cause;
  return new HanamaruStateError(
    'HANA_STATE_RUNTIME',
    'Annotation rendering or scheduling failed',
    { cause },
  );
}

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

function createOwnedRenderer(env, args) {
  const layers = [args.lease.shared.svgLayer, args.lease.shared.noteLayer]
    .filter((layer) => layer?.children !== undefined)
    .map((layer) => ({ layer, previous: new Set(layer.children) }));
  try {
    const renderer = env.createRenderer(args);
    pendingRendererMounts.set(renderer, layers);
    return renderer;
  } catch (error) {
    for (const { layer, previous } of layers) {
      for (const child of [...layer.children]) {
        if (!previous.has(child)) child.remove();
      }
    }
    throw error;
  }
}

function commitRenderer(renderer) {
  pendingRendererMounts.delete(renderer);
}

function cleanupUncommittedRenderer(renderer) {
  const layers = pendingRendererMounts.get(renderer) ?? [];
  pendingRendererMounts.delete(renderer);
  try { renderer.destroy(); } catch { /* The overlay snapshot remains authoritative. */ }
  for (const { layer, previous } of layers) {
    for (const child of [...layer.children]) {
      if (!previous.has(child)) child.remove();
    }
  }
}

function cancelNodeAnimations(node) {
  if (typeof node?.getAnimations !== 'function') return;
  let animations = [];
  try {
    animations = node.getAnimations({ subtree: true });
  } catch {
    try { animations = node.getAnimations(); } catch { return; }
  }
  for (const animation of animations) {
    try { animation.cancel(); } catch { /* Continue forcing the remaining visual state. */ }
  }
}

function removeOwnedDescription(renderer, owners) {
  const noteId = renderer?.noteElement?.id;
  if (!noteId) return;
  for (const owner of owners) {
    if (typeof owner?.getAttribute !== 'function') continue;
    try {
      const next = removeDescriptionToken(owner.getAttribute('aria-describedby'), noteId);
      if (next === null) owner.removeAttribute('aria-describedby');
      else owner.setAttribute('aria-describedby', next);
    } catch {
      // Continue cleaning the renderer even if an author node rejects an ARIA write.
    }
  }
}

function forceHideRenderer(renderer, owners) {
  const group = renderer?.group;
  const note = renderer?.noteElement;
  cancelNodeAnimations(group);
  cancelNodeAnimations(note);
  try { group?.setAttribute?.('hidden', ''); } catch {}
  try {
    group?.classList?.remove('hana-is-visible', 'hana-is-animating', 'hana-is-paused');
  } catch {}
  if (note !== null && note !== undefined) {
    try { note.hidden = true; } catch {}
    try { note.classList?.add('hana-is-hidden'); } catch {}
    try {
      note.classList?.remove('hana-is-visible', 'hana-is-animating', 'hana-is-paused');
    } catch {}
    try { note.removeAttribute?.('tabindex'); } catch {}
  }
  removeOwnedDescription(renderer, owners);
}

function forceRemoveRenderer(renderer, owners) {
  forceHideRenderer(renderer, owners);
  try { renderer?.group?.remove?.(); } catch {}
  try { renderer?.noteElement?.remove?.(); } catch {}
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

function hiddenTargetError(record) {
  return new HanamaruTargetError(
    'HANA_TARGET_INVALID',
    'Target is hidden or has no renderable client rectangles',
    { target: record.source },
  );
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
      let ancestor = record.ownerElement;
      while (ancestor !== null) {
        const style = win.getComputedStyle(ancestor);
        if (ancestor.hidden || style.display === 'none'
          || style.visibility === 'hidden' || style.visibility === 'collapse') {
          throw hiddenTargetError(record);
        }
        ancestor = ancestor.parentElement;
      }
      const rects = (record.range === null
        ? [record.element.getBoundingClientRect()]
        : [...record.range.getClientRects()])
        .map(copyClientRect)
        .filter((item) => item.width > 0 && item.height > 0);
      if (rects.length === 0) throw hiddenTargetError(record);
      return rects;
    },
  };
}

export function annotate(target, options) {
  return createAnnotation(target, options, defaultEnvironment(target));
}

export function pauseAnnotationRun(controller) {
  const active = activeRenderers.get(controller);
  if (active === undefined) return;
  try { active.renderer.pause(); } catch (error) { active.onFailure(error); }
}

export function resumeAnnotationRun(controller) {
  const active = activeRenderers.get(controller);
  if (active === undefined) return;
  try { active.renderer.resume(); } catch (error) { active.onFailure(error); }
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
    try { lease.release(); } catch { /* Preserve registration failure. */ }
    throw stateError(error);
  }
  try {
    renderer = createOwnedRenderer(env, { id, record, options, lease });
  } catch (error) {
    try { shared.releaseController(id); } catch { /* Preserve renderer failure. */ }
    try { lease.release(); } catch { /* Preserve renderer failure. */ }
    throw stateError(error);
  }

  let state = 'idle';
  let run = null;
  let requestedVisible = false;
  let destroyed = false;
  let operationEpoch = 0;
  let activeCancelDispatchDepth = 0;
  let disconnectedEpisode = false;
  let renderabilityEpisode = false;
  const resolutionFailures = new WeakSet();
  const knownOwners = new Set([record.ownerElement]);

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
  setActiveRenderer();

  function acceptOperation() {
    operationEpoch += 1;
    return operationEpoch;
  }

  function isCurrentOperation(candidate) {
    return !destroyed && candidate === operationEpoch;
  }

  function setActiveRenderer() {
    activeRenderers.set(controller, { renderer, onFailure: handleRuntimeFailure });
  }

  function settleVisible(activeRun = run, operation = operationEpoch) {
    if (!isCurrentOperation(operation)
      || activeRun === null || activeRun !== run || activeRun.settled) return;
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

  function handleRuntimeFailure(cause) {
    const error = stateError(cause);
    if (destroyed) return error;
    requestedVisible ||= state === 'showing' || state === 'visible';
    try { renderer.hide(); } catch { /* Preserve the originating runtime failure. */ }
    forceHideRenderer(renderer, knownOwners);
    rejectRun(error);
    state = 'suspended';
    dispatch(env, record.ownerElement, 'hana:error', { controller, error });
    return error;
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
        const owner = record.ownerElement;
        const layout = requestedVisible
          ? layoutFor(record, renderer, options, env)
          : (env.targetRects(record), null);
        renderabilityEpisode = false;
        return {
          layout,
          owner,
          ownerChanged: previousOwner !== owner,
        };
      },
      write: (result) => {
        knownOwners.add(result.owner);
        renderer.updateOwner(result.owner);
        if (result.layout !== null) {
          renderer.draw(result.layout);
          if (state === 'suspended' && requestedVisible) {
            renderer.finish();
            state = 'visible';
          }
        } else if (state === 'suspended' && !requestedVisible) {
          state = 'hidden';
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

  function schedule(
    { animate = false, finish = false, restore = false, validate = false } = {},
    operation = operationEpoch,
  ) {
    const activeRun = run;
    const read = () => {
      if (!isCurrentOperation(operation)) return null;
      resolveCurrentTarget();
      const owner = record.ownerElement;
      const layout = validate ? (env.targetRects(record), null) : layoutFor(record, renderer, options, env);
      renderabilityEpisode = false;
      return {
        layout,
        owner,
      };
    };
    const write = (result, synchronous = false) => {
      if (!isCurrentOperation(operation) || result === null) return;
      knownOwners.add(result.owner);
      renderer.updateOwner(result.owner);
      if (result.layout === null) {
        if (state === 'suspended' && !requestedVisible) state = 'hidden';
        return;
      }
      renderer.draw(result.layout);
      if (finish) {
        renderer.finish();
        if (restore) state = 'visible';
        else settleVisible(activeRun, operation);
        return;
      }
      if (!animate) return;
      const reduced = env.reducedMotion(options);
      const motion = renderer.animate(reduced ? 0 : options.duration);
      if (reduced && synchronous) {
        motion.finished.catch((error) => {
          if (isCurrentOperation(operation) && error?.name !== 'AbortError') {
            handleRuntimeFailure(error);
          }
        });
        settleVisible(activeRun, operation);
        return;
      }
      motion.finished.then(
        () => settleVisible(activeRun, operation),
        (error) => {
          if (isCurrentOperation(operation) && error?.name !== 'AbortError') {
            handleRuntimeFailure(error);
          }
        },
      );
    };
    if (animate && env.reducedMotion(options)) {
      try {
        write(read(), true);
      } catch (error) {
        if (isCurrentOperation(operation)) handleScheduledFailure(error);
      }
      return;
    }
    try {
      shared.enqueue({
        id,
        generation,
        read,
        write,
        onError(error) {
          if (isCurrentOperation(operation)) handleScheduledFailure(error);
        },
      });
    } catch (error) {
      if (isCurrentOperation(operation)) handleRuntimeFailure(error);
    }
  }

  function startDeferredRun() {
    run = createDeferred();
    requestedVisible = true;
  }

  function reportTargetFailure(error) {
    requestedVisible ||= state === 'showing' || state === 'visible';
    state = 'suspended';
    try {
      renderer.hide();
    } catch (rendererError) {
      handleRuntimeFailure(rendererError);
      return;
    }
    forceHideRenderer(renderer, knownOwners);
    rejectRun(error);
    const resolutionFailure = error !== null
      && (typeof error === 'object' || typeof error === 'function')
      && resolutionFailures.has(error);
    const alreadyReported = resolutionFailure ? disconnectedEpisode : renderabilityEpisode;
    if (resolutionFailure) disconnectedEpisode = true;
    else renderabilityEpisode = true;
    if (!alreadyReported) {
      dispatch(env, record.ownerElement, 'hana:error', { controller, error });
    }
  }

  function resolveCurrentTarget() {
    try {
      const resolved = record.refresh();
      disconnectedEpisode = false;
      return resolved;
    } catch (error) {
      if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        resolutionFailures.add(error);
      }
      throw error;
    }
  }

  function startResolvedRun(operation) {
    state = 'showing';
    dispatch(env, record.ownerElement, 'hana:start', { controller, state });
    if (!isCurrentOperation(operation)) return;
    schedule({ animate: true }, operation);
  }

  function show() {
    if (destroyed || state === 'showing' || state === 'visible') return controller;
    const operation = acceptOperation();
    startDeferredRun();
    try {
      resolveCurrentTarget();
    } catch (error) {
      reportTargetFailure(error);
      return controller;
    }
    startResolvedRun(operation);
    return controller;
  }

  function cancelPending(reason, notify = false) {
    if (run !== null && !run.settled) {
      rejectRun(abortError());
    }
    if (notify) {
      activeCancelDispatchDepth += 1;
      try {
        dispatch(env, record.ownerElement, 'hana:cancel', { controller, reason });
      } finally {
        activeCancelDispatchDepth -= 1;
      }
    }
  }

  function hide() {
    if (destroyed) return controller;
    const operation = acceptOperation();
    const wasActive = state === 'showing' || state === 'visible';
    requestedVisible = false;
    state = 'hidden';
    forceHideRenderer(renderer, knownOwners);
    cancelPending('hide', wasActive);
    if (!isCurrentOperation(operation)) return controller;
    try {
      renderer.hide();
    } catch (error) {
      handleRuntimeFailure(error);
      if (!isCurrentOperation(operation)) return controller;
    }
    if (wasActive && !rebindOrSuspend()) return controller;
    return controller;
  }

  function replay() {
    if (destroyed) return controller;
    const operation = acceptOperation();
    const wasActive = state === 'showing' || state === 'visible';
    requestedVisible = false;
    state = 'hidden';
    forceHideRenderer(renderer, knownOwners);
    cancelPending('replay', wasActive);
    if (!isCurrentOperation(operation)) return controller;
    startDeferredRun();
    try {
      renderer.hide();
    } catch (error) {
      handleRuntimeFailure(error);
      if (!isCurrentOperation(operation)) return controller;
      rebindOrSuspend();
      return controller;
    }
    if (!rebindOrSuspend()) return controller;
    try {
      resolveCurrentTarget();
    } catch (error) {
      reportTargetFailure(error);
      return controller;
    }
    startResolvedRun(operation);
    return controller;
  }

  function refresh() {
    if (destroyed) return controller;
    const operation = acceptOperation();
    const priorState = state;
    try {
      resolveCurrentTarget();
    } catch (error) {
      reportTargetFailure(error);
      return controller;
    }
    if (!rebindOrSuspend()) return controller;
    if (priorState === 'showing') schedule({ finish: true }, operation);
    else if (priorState === 'visible') schedule({ finish: true, restore: true }, operation);
    else if (priorState === 'suspended') {
      if (requestedVisible) schedule({ finish: true, restore: true }, operation);
      else schedule({ validate: true }, operation);
    } else schedule({ validate: true }, operation);
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
    const operation = acceptOperation();
    let nextRenderer;
    try {
      nextRenderer = createOwnedRenderer(env, {
        id, record: nextRecord, options: nextOptions, lease,
      });
    } catch (error) {
      handleRuntimeFailure(error);
      return controller;
    }
    const oldRenderer = renderer;
    const oldTarget = currentTarget;
    const oldOptions = options;
    const oldRecord = record;
    const priorState = state;
    currentTarget = nextTarget;
    options = nextOptions;
    record = nextRecord;
    renderer = nextRenderer;
    setActiveRenderer();
    try {
      rebindLayout();
    } catch (error) {
      cleanupUncommittedRenderer(renderer);
      renderer = oldRenderer;
      currentTarget = oldTarget;
      options = oldOptions;
      record = oldRecord;
      setActiveRenderer();
      handleRuntimeFailure(error);
      return controller;
    }
    commitRenderer(renderer);
    knownOwners.add(nextRecord.ownerElement);
    let cleanupFailure = null;
    try { oldRenderer.hide(); } catch (error) { cleanupFailure = error; }
    forceHideRenderer(oldRenderer, knownOwners);
    try { oldRenderer.destroy(); } catch (error) { cleanupFailure ??= error; }
    forceRemoveRenderer(oldRenderer, knownOwners);
    if (cleanupFailure !== null) {
      handleRuntimeFailure(cleanupFailure);
      return controller;
    }
    if (priorState === 'showing') schedule({ finish: true }, operation);
    else if (priorState === 'visible') schedule({ finish: true, restore: true }, operation);
    else if (priorState === 'suspended' && requestedVisible) {
      schedule({ finish: true, restore: true }, operation);
    } else if (priorState === 'suspended') schedule({ validate: true }, operation);
    return controller;
  }

  function destroy() {
    if (destroyed) return controller;
    acceptOperation();
    const wasActive = state === 'showing' || state === 'visible'
      || activeCancelDispatchDepth > 0;
    destroyed = true;
    let failure = null;
    const cleanup = (operation) => {
      try { operation(); } catch (error) { failure ??= error; }
    };
    cleanup(() => stopLayout?.());
    cleanup(() => renderer.destroy());
    forceRemoveRenderer(renderer, knownOwners);
    activeRenderers.delete(controller);
    cleanup(() => shared.releaseController(id));
    cleanup(() => lease.release());
    state = 'destroyed';
    if (failure === null) {
      cancelPending('destroy', wasActive);
    } else {
      const error = stateError(failure);
      rejectRun(error);
      try { dispatch(env, record.ownerElement, 'hana:error', { controller, error }); } catch {}
    }
    return controller;
  }

  try {
    bindLayout();
    commitRenderer(renderer);
  } catch (error) {
    activeRenderers.delete(controller);
    cleanupUncommittedRenderer(renderer);
    try { shared.releaseController(id); } catch { /* Preserve binding failure. */ }
    try { lease.release(); } catch { /* Preserve binding failure. */ }
    throw stateError(error);
  }
  return controller;
}
