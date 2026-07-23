import {
  HanamaruConfigError,
  HanamaruStateError,
  HanamaruTargetError,
} from './errors.js';
import {
  buildConnector,
  buildMarkPaths,
  choosePlacement,
  intersectsViewport,
  unionRects,
} from './geometry.js';
import {
  createRenderer as createDomRenderer,
  readThemeMetrics,
  removeDescriptionToken,
} from './renderer.js';
import {
  deleteControllerMetadata,
  recordAnnotationMetadata,
  snapshotAnnotationTarget,
} from './controller-metadata.js';
import { runtimeState } from './runtime-state.js';
import { acquireDocumentResources } from './scheduler.js';
import {
  intrinsicDocumentView,
  intrinsicOwnerDocumentOf,
  intrinsicRootForNode,
  intrinsicRootKind,
} from './shadow-target.js';
import { resolveTarget } from './target.js';

const MARKS = new Set(['underline', 'highlight', 'circle', 'box', 'strike', 'bracket']);
const PLACEMENTS = new Set(['auto', 'top', 'right', 'bottom', 'left']);
const TRIGGERS = new Set(['manual', 'load', 'viewport']);
const MOTIONS = new Set(['system', 'never']);
const KEYS = new Set(['mark', 'note', 'placement', 'trigger', 'accessible', 'seed', 'duration', 'motion']);
const RECT_GEOMETRY_FIELDS = Object.freeze([
  'x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left',
]);
const activeRenderers = new WeakMap();
const pausedControllers = new WeakSet();
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

function supersededMetadataError() {
  return stateError(new Error('Annotation operation changed during metadata storage'));
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

export function normalizeOptions(
  input,
  fallbackSeed,
  { allowUnknown = false, acceptedCustomMark = null } = {},
) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalid('input', input);
  }

  if (!allowUnknown) {
    for (const key of Object.keys(input)) {
      if (!KEYS.has(key)) invalid(key, input[key]);
    }
  }

  const mark = optional(input, 'mark', undefined);
  if (!MARKS.has(mark)
    && !(acceptedCustomMark !== null && mark === acceptedCustomMark)
    && !runtimeState.plugins.has(mark)) invalid('mark', mark);

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

function layoutFor(
  record,
  renderer,
  options,
  markPlugin,
  env,
  markPathsSnapshot = null,
  targetRectsSnapshot = null,
) {
  const targetRects = targetRectsSnapshot ?? env.targetRects(record);
  const targetRect = unionRects(targetRects);
  const measured = renderer.measure();
  const metrics = env.readThemeMetrics(renderer.group);
  const markPaths = markPathsSnapshot
    ?? buildMarkPaths(options.mark, targetRects, options.seed, 5, markPlugin);
  const targetVisible = targetRects.some((item) => intersectsViewport(item, measured.viewport));

  if (measured.noteRect === null) {
    return {
      targetRects,
      unionRect: targetRect,
      markPaths,
      side: 'right',
      noteRect: null,
      connector: { shaft: '', head: '' },
      viewport: measured.viewport,
      targetVisible,
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
  const layout = {
    targetRects,
    unionRect: targetRect,
    markPaths,
    side: placement.side,
    noteRect: placement.rect,
    connector: buildConnector(targetRect, placement.rect, placement.side),
    viewport: measured.viewport,
    targetVisible,
  };
  if (targetVisible) renderer.reserveNote?.(layout.noteRect);
  return layout;
}

function dispatch(env, owner, type, detail) {
  if (type === 'hana:error' && typeof env.createErrorEvent === 'function') {
    env.createErrorEvent(type, detail, owner);
    return;
  }
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

function discardUncommittedRendererMount(renderer) {
  const layers = pendingRendererMounts.get(renderer) ?? [];
  pendingRendererMounts.delete(renderer);
  for (const { layer, previous } of layers) {
    for (const child of [...layer.children]) {
      if (!previous.has(child)) child.remove();
    }
  }
}

function cleanupUncommittedRenderer(renderer) {
  try { renderer.destroy(); } catch { /* The overlay snapshot remains authoritative. */ }
  discardUncommittedRendererMount(renderer);
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

function snapshotRectGeometry(rects) {
  return Object.freeze(rects.map((item) => Object.freeze(copyClientRect(item))));
}

function rectGeometryMatches(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    for (const field of RECT_GEOMETRY_FIELDS) {
      if (!Object.is(left[index][field], right[index][field])) return false;
    }
  }
  return true;
}

function hiddenTargetError(record) {
  return new HanamaruTargetError(
    'HANA_TARGET_INVALID',
    'Target is hidden or has no renderable client rectangles',
    { target: record.source },
  );
}

export function resolveStandaloneTarget(target, doc) {
  const record = resolveTarget(target, doc);
  const assertStandaloneRoot = () => {
    const actualRoot = intrinsicRootForNode(record.ownerElement);
    if (intrinsicRootKind(actualRoot) !== 'shadow-root') return;
    throw new HanamaruTargetError(
      'HANA_TARGET_SHADOW_UNSCOPED',
      'ShadowRoot targets require an explicit Shadow scope',
      { target, root: actualRoot },
    );
  };
  const refresh = record.refresh;
  record.refresh = () => {
    // Selector records must be allowed to re-resolve to a replacement in the
    // Document. Direct records retain their identity, so guard their current
    // owner before their resolver can collapse a root change into INVALID.
    if (record.kind !== 'selector') assertStandaloneRoot();
    const resolved = refresh();
    assertStandaloneRoot();
    return resolved;
  };
  assertStandaloneRoot();
  return record;
}

export function documentForTarget(target) {
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

function createDomAnnotationEnvironment({
  doc,
  view = undefined,
  id,
  lease,
  createEvent,
  createErrorEvent,
  resolveCandidate,
}) {
  const win = view ?? intrinsicDocumentView(doc);
  if (doc === null || typeof doc !== 'object'
    || intrinsicRootKind(doc) !== 'document'
    || win === null || typeof win !== 'object') {
    throw new TypeError('annotation document must be a Document with a browsing context');
  }

  return {
    id,
    get lease() { return lease(); },
    createEvent,
    createErrorEvent,
    createRenderer(args) {
      return createDomRenderer({ ...args, view: win });
    },
    direction(owner) { return win.getComputedStyle(owner).direction; },
    microtask(callback) { win.queueMicrotask(callback); },
    readThemeMetrics(element) { return readThemeMetrics(element, win); },
    reducedMotion(options) {
      return options.motion === 'never'
        || win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    },
    resolveTarget: resolveCandidate,
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

export function createAnnotationEnvironment(target, documentOverride = undefined) {
  const doc = documentOverride === undefined
    ? documentForTarget(target)
    : documentOverride;
  let documentLease;
  return createDomAnnotationEnvironment({
    doc,
    id: `hana-${++nextAnnotationId}`,
    lease() {
      documentLease ??= acquireDocumentResources(doc);
      return documentLease;
    },
    createEvent(type, detail, owner) {
      owner.dispatchEvent(new doc.defaultView.CustomEvent(type, {
        detail,
        bubbles: true,
        composed: true,
      }));
    },
    resolveCandidate(candidate) {
      return resolveStandaloneTarget(candidate, doc);
    },
  });
}

export function createAnnotationEnvironmentWithResources({
  root,
  resources,
  resolveTarget: resolveCandidate,
}) {
  if (resources === null || typeof resources !== 'object'
    || resources.root !== root
    || resources.document !== intrinsicOwnerDocumentOf(root)
    || typeof resources.allocateId !== 'function'
    || typeof resources.createEvent !== 'function'
    || resources.lease === null
    || typeof resources.lease !== 'object') {
    throw new TypeError('annotation resources must belong to the exact injected root');
  }
  if (typeof resolveCandidate !== 'function') {
    throw new TypeError('annotation target resolver must be a function');
  }
  return createDomAnnotationEnvironment({
    doc: resources.document,
    view: resources.view,
    id: resources.allocateId('hana'),
    lease() { return resources.lease; },
    createEvent(type, detail, owner) {
      return resources.createEvent(type, detail, owner);
    },
    createErrorEvent(type, detail, owner) {
      return typeof resources.createErrorEvent === 'function'
        ? resources.createErrorEvent(type, detail, owner)
        : resources.createEvent(type, detail, owner);
    },
    resolveCandidate,
  });
}

export function annotate(target, options) {
  return createAnnotation(target, options, createAnnotationEnvironment(target));
}

export function pauseAnnotationRun(controller) {
  const active = activeRenderers.get(controller);
  if (active === undefined) return;
  pausedControllers.add(controller);
  try { active.renderer.pause(); } catch (error) { active.onFailure(error); }
}

export function resumeAnnotationRun(controller) {
  pausedControllers.delete(controller);
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
  let markPlugin = MARKS.has(options.mark) ? null : runtimeState.plugins.get(options.mark);
  if (!MARKS.has(options.mark) && markPlugin === undefined) invalid('mark', options.mark);
  let currentTarget = target;
  let record = env.resolveTarget(target);
  let currentMetadataTarget = snapshotAnnotationTarget(target);
  currentTarget = currentMetadataTarget;
  const lease = env.lease;
  const { shared } = lease;
  let generation;
  let renderer;
  let pendingMarkPathsSnapshot = null;
  let stopLayout = null;
  let stopTrigger = null;

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
  let triggerActive = false;
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

  function acceptOperation(cleanupTrigger = true) {
    if (cleanupTrigger) stopAutomaticTrigger(true);
    pendingMarkPathsSnapshot = null;
    operationEpoch += 1;
    return operationEpoch;
  }

  function isCurrentOperation(candidate) {
    return !destroyed && candidate === operationEpoch;
  }

  function stopAutomaticTrigger(suppressFailure = false) {
    triggerActive = false;
    const cleanup = stopTrigger;
    stopTrigger = null;
    if (cleanup === null) return;
    if (!suppressFailure) {
      cleanup();
      return;
    }
    try { cleanup(); } catch { /* Controller teardown will still release shared resources. */ }
  }

  function ownTriggerCleanup(cleanup) {
    if (triggerActive && !destroyed) {
      stopTrigger = cleanup;
      return;
    }
    try { cleanup(); } catch { /* The trigger is already logically inactive. */ }
  }

  function acceptTriggeredShow(operation, triggerGeneration) {
    if (!triggerActive
      || !isCurrentOperation(operation)
      || triggerGeneration !== generation) return;
    stopAutomaticTrigger(true);
    if (!isCurrentOperation(operation) || triggerGeneration !== generation) return;
    show();
  }

  function installLoadTrigger(operation, triggerGeneration) {
    const doc = record.ownerElement.ownerDocument;
    const start = () => acceptTriggeredShow(operation, triggerGeneration);
    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', start, { once: true });
      ownTriggerCleanup(() => doc.removeEventListener('DOMContentLoaded', start));
      return;
    }
    env.microtask(start);
  }

  function installViewportTrigger(operation, triggerGeneration) {
    let unavailable = false;
    const cleanup = shared.observeIntersection({
      id,
      target: record.ownerElement,
      threshold: 0.25,
      onEnter() { acceptTriggeredShow(operation, triggerGeneration); },
      onExit() {},
      onUnavailable() {
        unavailable = true;
        installLoadTrigger(operation, triggerGeneration);
      },
    });
    if (unavailable) {
      try { cleanup(); } catch { /* The fallback trigger remains authoritative. */ }
    } else {
      ownTriggerCleanup(cleanup);
    }
  }

  function installAutomaticTrigger() {
    if (options.trigger === 'manual') return;
    triggerActive = true;
    const operation = operationEpoch;
    const triggerGeneration = generation;
    if (options.trigger === 'load') installLoadTrigger(operation, triggerGeneration);
    else installViewportTrigger(operation, triggerGeneration);
  }

  function setActiveRenderer() {
    activeRenderers.set(controller, { renderer, onFailure: handleRuntimeFailure });
  }

  function settleVisible(activeRun = run, operation = operationEpoch) {
    if (!isCurrentOperation(operation)
      || activeRun === null || activeRun !== run || activeRun.settled) return;
    activeRun.settled = true;
    pausedControllers.delete(controller);
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
    pendingMarkPathsSnapshot = null;
    requestedVisible ||= state === 'showing' || state === 'visible';
    pausedControllers.delete(controller);
    try { renderer.hide(); } catch { /* Preserve the originating runtime failure. */ }
    forceHideRenderer(renderer, knownOwners);
    rejectRun(error);
    state = 'suspended';
    dispatch(env, record.ownerElement, 'hana:error', { controller, error });
    return error;
  }

  function reportSupersededRuntimeFailure(cause) {
    const error = stateError(cause);
    dispatch(env, record.ownerElement, 'hana:error', { controller, error });
    return error;
  }

  function handleScheduledFailure(error) {
    pendingMarkPathsSnapshot = null;
    if (error instanceof HanamaruTargetError) reportTargetFailure(error);
    else handleRuntimeFailure(error);
  }

  function currentMarkPathsSnapshot(operation = operationEpoch) {
    if (pendingMarkPathsSnapshot?.operation !== operation
      || pendingMarkPathsSnapshot.generation !== generation) return null;
    return pendingMarkPathsSnapshot;
  }

  function consumeMarkPathsSnapshot(snapshot) {
    if (pendingMarkPathsSnapshot === snapshot) pendingMarkPathsSnapshot = null;
  }

  function resolveMarkPathsSnapshot(snapshot, targetRects) {
    if (snapshot === null) {
      return { paths: null, snapshot: null, targetRects };
    }
    if (snapshot.status === 'rebuilding' || snapshot.status === 'failed') return null;
    const geometry = snapshotRectGeometry(targetRects);
    if (rectGeometryMatches(snapshot.geometry, geometry)) {
      return { paths: snapshot.paths, snapshot, targetRects: geometry };
    }
    const rebuildingSnapshot = Object.freeze({
      generation: snapshot.generation,
      operation: snapshot.operation,
      status: 'rebuilding',
      geometry,
      paths: null,
    });
    if (pendingMarkPathsSnapshot === snapshot) {
      pendingMarkPathsSnapshot = rebuildingSnapshot;
    }
    let paths;
    try {
      paths = Object.freeze([
        ...buildMarkPaths(options.mark, geometry, options.seed, 5, markPlugin),
      ]);
    } catch (error) {
      if (pendingMarkPathsSnapshot === rebuildingSnapshot) {
        pendingMarkPathsSnapshot = Object.freeze({
          generation: snapshot.generation,
          operation: snapshot.operation,
          status: 'failed',
          geometry,
          paths: null,
          error,
        });
      }
      throw error;
    }
    const replacement = Object.freeze({
      generation: snapshot.generation,
      operation: snapshot.operation,
      status: 'ready',
      geometry,
      paths,
    });
    if (pendingMarkPathsSnapshot === rebuildingSnapshot) {
      pendingMarkPathsSnapshot = replacement;
    }
    return { paths, snapshot: replacement, targetRects: geometry };
  }

  function layoutBinding() {
    return {
      id,
      generation,
      record,
      note: renderer.noteElement,
      read: () => {
        const snapshot = currentMarkPathsSnapshot();
        if (snapshot?.status === 'rebuilding' || snapshot?.status === 'failed') return null;
        const previousOwner = record.ownerElement;
        resolveCurrentTarget();
        const owner = record.ownerElement;
        let resolvedSnapshot = { paths: null, snapshot: null, targetRects: null };
        let layout;
        if (requestedVisible) {
          resolvedSnapshot = resolveMarkPathsSnapshot(snapshot, env.targetRects(record));
          if (resolvedSnapshot === null) return null;
          layout = layoutFor(
            record,
            renderer,
            options,
            markPlugin,
            env,
            resolvedSnapshot.paths,
            resolvedSnapshot.targetRects,
          );
        } else {
          env.targetRects(record);
          layout = null;
        }
        renderabilityEpisode = false;
        return {
          layout,
          owner,
          ownerChanged: previousOwner !== owner,
          snapshot: resolvedSnapshot.snapshot,
        };
      },
      write: (result) => {
        if (result === null) return;
        consumeMarkPathsSnapshot(result.snapshot);
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
    const triggerWasPending = triggerActive;
    const triggerOperation = operationEpoch;
    let triggerCleanup = null;
    if (triggerWasPending) {
      triggerActive = false;
      triggerCleanup = stopTrigger;
      stopTrigger = null;
    }
    let reboundGeneration;
    try {
      generation = shared.bumpGeneration(id);
      stopLayout?.();
      stopLayout = shared.rebindLayout(id, layoutBinding());
      reboundGeneration = generation;
    } catch (error) {
      if (triggerCleanup !== null) {
        try { triggerCleanup(); } catch { /* Preserve the rebind failure. */ }
      }
      throw error;
    }
    if (triggerCleanup !== null) {
      try { triggerCleanup(); } catch { /* The rebound controller remains authoritative. */ }
    }
    if (triggerWasPending
      && isCurrentOperation(triggerOperation)
      && generation === reboundGeneration) {
      installAutomaticTrigger();
    }
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
    {
      animate = false,
      finish = false,
      restore = false,
      validate = false,
    } = {},
    operation = operationEpoch,
  ) {
    const activeRun = run;
    const read = () => {
      if (!isCurrentOperation(operation)) return null;
      const snapshot = currentMarkPathsSnapshot(operation);
      if (snapshot?.status === 'rebuilding' || snapshot?.status === 'failed') return null;
      resolveCurrentTarget();
      const owner = record.ownerElement;
      let resolvedSnapshot = { paths: null, snapshot: null, targetRects: null };
      let layout;
      if (validate) {
        env.targetRects(record);
        layout = null;
      } else {
        resolvedSnapshot = resolveMarkPathsSnapshot(snapshot, env.targetRects(record));
        if (resolvedSnapshot === null) return null;
        layout = layoutFor(
          record,
          renderer,
          options,
          markPlugin,
          env,
          resolvedSnapshot.paths,
          resolvedSnapshot.targetRects,
        );
      }
      renderabilityEpisode = false;
      return {
        layout,
        owner,
        snapshot: resolvedSnapshot.snapshot,
      };
    };
    const write = (result, synchronous = false) => {
      if (!isCurrentOperation(operation) || result === null) return;
      consumeMarkPathsSnapshot(result.snapshot);
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
      if (pausedControllers.has(controller)) {
        try {
          renderer.pause();
        } catch (error) {
          if (isCurrentOperation(operation)) handleRuntimeFailure(error);
          return;
        }
        if (!isCurrentOperation(operation)) return;
      }
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
        channel: 'lifecycle',
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
    pausedControllers.delete(controller);
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
    pausedControllers.delete(controller);
    const operation = acceptOperation();
    const wasActive = state === 'showing' || state === 'visible';
    requestedVisible = false;
    state = 'hidden';
    let hideFailure = null;
    try {
      renderer.hide();
    } catch (error) {
      hideFailure = error;
      forceHideRenderer(renderer, knownOwners);
    }
    cancelPending('hide', wasActive);
    if (!isCurrentOperation(operation)) {
      if (hideFailure !== null) reportSupersededRuntimeFailure(hideFailure);
      return controller;
    }
    if (hideFailure !== null) {
      handleRuntimeFailure(hideFailure);
      if (!isCurrentOperation(operation)) return controller;
    }
    if (wasActive && !rebindOrSuspend()) return controller;
    return controller;
  }

  function replay() {
    if (destroyed) return controller;
    pausedControllers.delete(controller);
    const operation = acceptOperation();
    const wasActive = state === 'showing' || state === 'visible';
    requestedVisible = false;
    state = 'hidden';
    let hideFailure = null;
    try {
      renderer.hide();
    } catch (error) {
      hideFailure = error;
      forceHideRenderer(renderer, knownOwners);
    }
    cancelPending('replay', wasActive);
    if (!isCurrentOperation(operation)) {
      if (hideFailure !== null) reportSupersededRuntimeFailure(hideFailure);
      return controller;
    }
    startDeferredRun();
    if (hideFailure !== null) {
      handleRuntimeFailure(hideFailure);
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
    const replacesTarget = Object.prototype.hasOwnProperty.call(next, 'target');
    const nextTarget = replacesTarget ? next.target : currentTarget;
    const optionPatch = { ...next };
    delete optionPatch.target;
    const nextOptions = normalizeOptions(
      { ...options, ...optionPatch },
      options.seed,
      { acceptedCustomMark: markPlugin === null ? null : options.mark },
    );
    const nextMarkPlugin = MARKS.has(nextOptions.mark)
      ? null
      : (nextOptions.mark === options.mark && markPlugin !== null
        ? markPlugin
        : runtimeState.plugins.get(nextOptions.mark));
    if (!MARKS.has(nextOptions.mark) && nextMarkPlugin === undefined) {
      invalid('mark', nextOptions.mark);
    }
    const nextRecord = env.resolveTarget(nextTarget);
    const nextMetadataTarget = replacesTarget
      ? snapshotAnnotationTarget(nextTarget)
      : currentMetadataTarget;
    let nextMarkPathsSnapshot = null;
    if (nextMarkPlugin !== null) {
      const geometry = snapshotRectGeometry(env.targetRects(nextRecord));
      nextMarkPathsSnapshot = Object.freeze({
        geometry,
        paths: Object.freeze([
          ...buildMarkPaths(nextOptions.mark, geometry, nextOptions.seed, 5, nextMarkPlugin),
        ]),
      });
    }
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
    const oldMetadataTarget = currentMetadataTarget;
    const oldOptions = options;
    const oldMarkPlugin = markPlugin;
    const oldRecord = record;
    const priorState = state;
    currentTarget = nextMetadataTarget;
    currentMetadataTarget = nextMetadataTarget;
    options = nextOptions;
    markPlugin = nextMarkPlugin;
    record = nextRecord;
    renderer = nextRenderer;
    setActiveRenderer();
    try {
      rebindLayout();
    } catch (error) {
      if (destroyed) {
        discardUncommittedRendererMount(nextRenderer);
        try { oldRenderer.destroy(); } catch { /* Destroy already owns the lifecycle outcome. */ }
        forceRemoveRenderer(oldRenderer, knownOwners);
        return controller;
      }
      cleanupUncommittedRenderer(nextRenderer);
      renderer = oldRenderer;
      currentTarget = oldTarget;
      currentMetadataTarget = oldMetadataTarget;
      options = oldOptions;
      markPlugin = oldMarkPlugin;
      record = oldRecord;
      setActiveRenderer();
      handleRuntimeFailure(error);
      return controller;
    }
    if (destroyed) {
      discardUncommittedRendererMount(nextRenderer);
      try { oldRenderer.destroy(); } catch { /* Destroy already owns the lifecycle outcome. */ }
      forceRemoveRenderer(oldRenderer, knownOwners);
      return controller;
    }
    try {
      recordAnnotationMetadata(controller, currentMetadataTarget, options);
    } catch (error) {
      destroy();
      discardUncommittedRendererMount(nextRenderer);
      try { oldRenderer.destroy(); } catch { /* The metadata failure remains authoritative. */ }
      forceRemoveRenderer(oldRenderer, knownOwners);
      deleteControllerMetadata(controller);
      throw stateError(error);
    }
    if (destroyed) {
      deleteControllerMetadata(controller);
      discardUncommittedRendererMount(nextRenderer);
      try { oldRenderer.destroy(); } catch { /* Destroy already owns the lifecycle outcome. */ }
      forceRemoveRenderer(oldRenderer, knownOwners);
      return controller;
    }
    if (!isCurrentOperation(operation)) {
      const error = supersededMetadataError();
      destroy();
      discardUncommittedRendererMount(nextRenderer);
      try { oldRenderer.destroy(); } catch { /* The stale metadata failure remains authoritative. */ }
      forceRemoveRenderer(oldRenderer, knownOwners);
      deleteControllerMetadata(controller);
      throw error;
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
    if (!isCurrentOperation(operation)) return controller;
    if (nextMarkPathsSnapshot !== null
      && (priorState === 'showing'
        || priorState === 'visible'
        || (priorState === 'suspended' && requestedVisible))) {
      pendingMarkPathsSnapshot = Object.freeze({
        generation,
        operation,
        status: 'ready',
        geometry: nextMarkPathsSnapshot.geometry,
        paths: nextMarkPathsSnapshot.paths,
      });
    }
    if (priorState === 'showing') {
      schedule({ finish: true }, operation);
    } else if (priorState === 'visible') {
      schedule({ finish: true, restore: true }, operation);
    } else if (priorState === 'suspended' && requestedVisible) {
      schedule({ finish: true, restore: true }, operation);
    } else if (priorState === 'suspended') schedule({ validate: true }, operation);
    return controller;
  }

  function destroy() {
    if (destroyed) return controller;
    deleteControllerMetadata(controller);
    pausedControllers.delete(controller);
    acceptOperation(false);
    const wasActive = state === 'showing' || state === 'visible'
      || activeCancelDispatchDepth > 0;
    destroyed = true;
    let failure = null;
    const cleanup = (operation) => {
      try { operation(); } catch (error) { failure ??= error; }
    };
    cleanup(() => stopAutomaticTrigger());
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
    installAutomaticTrigger();
    if (destroyed) {
      discardUncommittedRendererMount(renderer);
      return controller;
    }
    const metadataOperation = operationEpoch;
    const metadataRenderer = renderer;
    recordAnnotationMetadata(controller, currentMetadataTarget, options);
    if (destroyed) {
      deleteControllerMetadata(controller);
      discardUncommittedRendererMount(renderer);
      return controller;
    }
    if (!isCurrentOperation(metadataOperation)) {
      const error = supersededMetadataError();
      destroy();
      discardUncommittedRendererMount(metadataRenderer);
      deleteControllerMetadata(controller);
      throw error;
    }
    commitRenderer(renderer);
  } catch (error) {
    deleteControllerMetadata(controller);
    if (destroyed) {
      discardUncommittedRendererMount(renderer);
    } else {
      destroy();
      discardUncommittedRendererMount(renderer);
    }
    throw stateError(error);
  }
  return controller;
}
