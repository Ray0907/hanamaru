import {
  createAnnotation,
  createAnnotationEnvironment,
  createAnnotationEnvironmentWithResources,
  normalizeOptions,
} from './annotation.js';
import {
  HanamaruConfigError,
  HanamaruStateError,
  HanamaruTargetError,
} from './errors.js';
import {
  deleteControllerMetadata,
  recordGroupMetadata,
} from './controller-metadata.js';
import { acquireDocumentResources } from './scheduler.js';
import {
  intrinsicDocumentView,
  intrinsicOwnerDocumentOf,
  intrinsicRootForNode,
  intrinsicRootKind,
} from './shadow-target.js';
import { resolveTarget } from './target.js';

const GROUP_KEYS = new Set(['trigger', 'motion']);
const GROUP_TRIGGERS = new Set(['manual', 'load', 'viewport']);
const GROUP_MOTIONS = new Set(['system', 'never']);
let nextGroupId = 0;

function has(input, key) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function invalid(field, value) {
  throw new HanamaruConfigError(
    'HANA_CONFIG_INVALID',
    `Invalid group option: ${field}`,
    { field, value },
  );
}

function normalizeGroupOptions(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalid('input', input);
  }
  for (const key of Object.keys(input)) {
    if (!GROUP_KEYS.has(key)) invalid(key, input[key]);
  }

  const trigger = has(input, 'trigger') ? input.trigger : 'manual';
  if (!GROUP_TRIGGERS.has(trigger)) invalid('trigger', trigger);
  const motion = has(input, 'motion') ? input.motion : 'system';
  if (!GROUP_MOTIONS.has(motion)) invalid('motion', motion);
  return { trigger, motion };
}

function validateRecordRoot(record, target, env) {
  if (env.root === undefined) return;
  const actualRoot = intrinsicRootForNode(record?.ownerElement);
  if (actualRoot === env.root) return;
  const details = {
    target,
    expectedRoot: intrinsicRootKind(env.root),
    actualRoot: intrinsicRootKind(actualRoot),
  };
  if (intrinsicRootKind(env.root) === 'document'
    && intrinsicRootKind(actualRoot) === 'shadow-root') {
    throw new HanamaruTargetError(
      'HANA_TARGET_SHADOW_UNSCOPED',
      'ShadowRoot Group members require a Shadow scope',
      details,
    );
  }
  throw new HanamaruTargetError(
    'HANA_TARGET_INVALID',
    'Group members must belong to the injected root',
    details,
  );
}

function targetRoots(target) {
  const directRoot = intrinsicRootForNode(target);
  if (directRoot !== null) return [directRoot];
  if (target?.startContainer !== undefined || target?.endContainer !== undefined) {
    return [
      intrinsicRootForNode(target.startContainer),
      intrinsicRootForNode(target.endContainer),
    ];
  }
  const withinRoot = intrinsicRootForNode(target?.within);
  if (withinRoot !== null) return [withinRoot];
  return [];
}

function validateTargetRoot(target, env) {
  if (env.root === undefined) return;
  const roots = targetRoots(target).filter((root) => root !== null);
  if (roots.length === 0 || roots.every((root) => root === env.root)) return;
  const actualRoot = roots[0];
  const details = {
    target,
    expectedRoot: intrinsicRootKind(env.root),
    actualRoot: roots.every((root) => root === actualRoot)
      ? intrinsicRootKind(actualRoot)
      : 'mixed',
  };
  if (intrinsicRootKind(env.root) === 'document'
    && roots.every((root) => intrinsicRootKind(root) === 'shadow-root')) {
    throw new HanamaruTargetError(
      'HANA_TARGET_SHADOW_UNSCOPED',
      'ShadowRoot Group members require a Shadow scope',
      details,
    );
  }
  throw new HanamaruTargetError(
    'HANA_TARGET_INVALID',
    'Group members must belong to the injected root',
    details,
  );
}

function prepareMembers(members, options, env) {
  if (!Array.isArray(members) || members.length === 0) invalid('members', members);

  const normalized = members.map((member, index) => {
    if (member === null || typeof member !== 'object' || Array.isArray(member)) {
      invalid(`members[${index}]`, member);
    }
    if (!has(member, 'target')) invalid(`members[${index}].target`, undefined);
    if (has(member, 'trigger')) invalid(`members[${index}].trigger`, member.trigger);
    if (has(member, 'motion')) invalid(`members[${index}].motion`, member.motion);

    const { target, ...annotationInput } = member;
    const annotationOptions = normalizeOptions({
      ...annotationInput,
      trigger: 'manual',
      motion: options.motion,
    }, 0);
    if (!has(annotationInput, 'seed')) delete annotationOptions.seed;
    return { target, annotationOptions };
  });

  return normalized.map(({ target, annotationOptions }) => {
    validateTargetRoot(target, env);
    const record = env.resolveTarget(target);
    validateRecordRoot(record, target, env);
    return { target, annotationOptions, record };
  });
}

function documentContext(context) {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    invalid('context', context);
  }
  for (const key of Object.keys(context)) {
    if (key !== 'root') invalid(`context.${key}`, context[key]);
  }
  const root = has(context, 'root') ? context.root : globalThis.document;
  const DocumentConstructor = root?.defaultView?.Document;
  if (typeof DocumentConstructor !== 'function'
    || !(root instanceof DocumentConstructor)
    || root.nodeType !== 9
    || root.defaultView === null) {
    invalid('context.root', root);
  }
  return root;
}

export function createGroupEnvironment(root) {
  const view = root.defaultView;
  const memberErrors = new WeakMap();
  let memberErrorObserver = null;
  return {
    root,
    document: root,
    triggerId: `hana-group-trigger-${++nextGroupId}`,
    acquireDocumentResources,
    createAnnotation(target, options) {
      const annotationEnvironment = createAnnotationEnvironment(target, root);
      annotationEnvironment.createEvent = (type, detail) => {
        if (type === 'hana:error') {
          memberErrors.set(detail.controller, detail.error);
          memberErrorObserver?.(detail.controller, detail.error);
        }
      };
      annotationEnvironment.createErrorEvent = annotationEnvironment.createEvent;
      return createAnnotation(target, options, annotationEnvironment);
    },
    createEvent(type, detail, owner) {
      owner.dispatchEvent(new view.CustomEvent(type, {
        detail,
        bubbles: true,
        composed: true,
      }));
    },
    eventOwner(record) {
      try { record.refresh(); } catch { /* Retain the last valid owner for error delivery. */ }
      return record.ownerElement;
    },
    afterRefresh(callback) {
      const id = view.requestAnimationFrame(callback);
      return () => view.cancelAnimationFrame(id);
    },
    clearMemberError(annotation) { memberErrors.delete(annotation); },
    memberError(annotation) { return memberErrors.get(annotation); },
    observeMemberErrors(observer) {
      memberErrorObserver = observer;
      return () => {
        if (memberErrorObserver === observer) memberErrorObserver = null;
      };
    },
    microtask(callback) { view.queueMicrotask(callback); },
    resolveTarget(target) { return resolveTarget(target, root); },
  };
}

export function createGroupEnvironmentWithResources({
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
    throw new TypeError('group resources must belong to the exact injected root');
  }
  if (typeof resolveCandidate !== 'function') {
    throw new TypeError('group target resolver must be a function');
  }
  const doc = resources.document;
  const view = resources.view ?? intrinsicDocumentView(doc);
  const memberErrors = new WeakMap();
  let memberErrorObserver = null;
  return {
    root,
    document: doc,
    triggerId: resources.allocateId('hana-group-trigger'),
    acquireDocumentResources() { return resources.lease; },
    createAnnotation(target, options) {
      const annotationEnvironment = createAnnotationEnvironmentWithResources({
        root,
        resources,
        resolveTarget: resolveCandidate,
      });
      annotationEnvironment.createEvent = (type, detail) => {
        if (type === 'hana:error') {
          memberErrors.set(detail.controller, detail.error);
          memberErrorObserver?.(detail.controller, detail.error);
        }
      };
      annotationEnvironment.createErrorEvent = annotationEnvironment.createEvent;
      return createAnnotation(target, options, annotationEnvironment);
    },
    createEvent(type, detail, owner) {
      return resources.createEvent(type, detail, owner);
    },
    createErrorEvent(type, detail, owner) {
      return typeof resources.createErrorEvent === 'function'
        ? resources.createErrorEvent(type, detail, owner)
        : resources.createEvent(type, detail, owner);
    },
    eventOwner(record) {
      try { record.refresh(); } catch { /* Retain the last valid owner for error delivery. */ }
      return record.ownerElement;
    },
    afterRefresh(callback) {
      const id = view.requestAnimationFrame(callback);
      return () => view.cancelAnimationFrame(id);
    },
    clearMemberError(annotation) { memberErrors.delete(annotation); },
    memberError(annotation) { return memberErrors.get(annotation); },
    observeMemberErrors(observer) {
      memberErrorObserver = observer;
      return () => {
        if (memberErrorObserver === observer) memberErrorObserver = null;
      };
    },
    microtask(callback) { view.queueMicrotask(callback); },
    resolveTarget: resolveCandidate,
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

function typedMemberError(cause) {
  if (cause instanceof HanamaruTargetError || cause instanceof HanamaruStateError) {
    return cause;
  }
  return new HanamaruStateError(
    'HANA_STATE_RUNTIME',
    'Group member annotation failed',
    { cause },
  );
}

function groupMemberError(index, cause) {
  const error = typedMemberError(cause);
  return new HanamaruStateError(
    'HANA_STATE_GROUP_MEMBER',
    `Group member ${index} failed`,
    { index, error },
  );
}

function runtimeError(cause) {
  if (cause instanceof HanamaruStateError) return cause;
  return new HanamaruStateError(
    'HANA_STATE_RUNTIME',
    'Group lifecycle cleanup failed',
    { cause },
  );
}

export function group(members, options = {}, context = {}) {
  const root = documentContext(context);
  return createGroup(members, options, createGroupEnvironment(root));
}

export function createGroup(members, rawOptions = {}, env) {
  if (env === null || typeof env !== 'object') {
    throw new TypeError('group environment must be an object');
  }
  const options = normalizeGroupOptions(rawOptions);
  const prepared = prepareMembers(members, options, env);
  const annotations = [];
  try {
    for (const member of prepared) {
      annotations.push(env.createAnnotation(member.target, member.annotationOptions));
    }
  } catch (error) {
    for (let index = annotations.length - 1; index >= 0; index -= 1) {
      try { annotations[index].destroy(); } catch { /* Preserve the construction failure. */ }
    }
    throw error;
  }

  let state = 'idle';
  let run = null;
  let operationEpoch = 0;
  let refreshEpoch = 0;
  let requestedVisible = false;
  let activeRefresh = null;
  let stopRefresh = null;
  let stopMemberErrors = null;
  let containingMemberError = false;
  const annotationIndices = new Map(
    annotations.map((annotation, index) => [annotation, index]),
  );
  const automatic = {
    active: false,
    epoch: 0,
    generation: null,
    lease: null,
    owner: null,
    registered: false,
    shared: null,
    stopIntersection: null,
    stopLayout: null,
    stopLoad: null,
  };
  const controller = {
    get state() { return state; },
    get finished() { return run?.promise ?? null; },
    get size() { return annotations.length; },
    show,
    hide,
    replay,
    refresh,
    destroy,
  };

  function isCurrent(operation, activeRun = run) {
    return state !== 'destroyed'
      && operation === operationEpoch
      && activeRun === run;
  }

  function dispatch(type, detail) {
    const owner = typeof env.eventOwner === 'function'
      ? env.eventOwner(prepared[0].record)
      : prepared[0].record.ownerElement;
    if (type === 'hana:error' && typeof env.createErrorEvent === 'function') {
      env.createErrorEvent(type, detail, owner);
      return;
    }
    env.createEvent(type, detail, owner);
  }

  function cleanupOperation(operation, failures) {
    if (operation === null) return;
    try {
      operation();
    } catch (error) {
      failures.push(error);
    }
  }

  function cancelRefreshObservation() {
    refreshEpoch += 1;
    activeRefresh = null;
    const cleanup = stopRefresh;
    stopRefresh = null;
    if (cleanup === null) return null;
    try {
      cleanup();
      return null;
    } catch (error) {
      return error;
    }
  }

  function refreshIsCurrent(refreshOperation) {
    return state !== 'destroyed'
      && activeRefresh === refreshOperation
      && refreshOperation.id === refreshEpoch
      && refreshOperation.operation === operationEpoch;
  }

  function stopAutomaticTrigger() {
    automatic.active = false;
    automatic.epoch += 1;
    const stopLoad = automatic.stopLoad;
    const stopIntersection = automatic.stopIntersection;
    const stopLayout = automatic.stopLayout;
    const shared = automatic.shared;
    const lease = automatic.lease;
    const registered = automatic.registered;
    automatic.stopLoad = null;
    automatic.stopIntersection = null;
    automatic.stopLayout = null;
    automatic.shared = null;
    automatic.lease = null;
    automatic.generation = null;
    automatic.owner = null;
    automatic.registered = false;
    const failures = [];
    cleanupOperation(stopLoad, failures);
    cleanupOperation(stopIntersection, failures);
    cleanupOperation(stopLayout, failures);
    if (registered && shared !== null) {
      cleanupOperation(
        () => shared.releaseController(env.triggerId),
        failures,
      );
    }
    cleanupOperation(lease === null ? null : () => lease.release(), failures);
    return failures[0] ?? null;
  }

  function automaticCanRun(epoch) {
    return state !== 'destroyed'
      && automatic.active
      && automatic.epoch === epoch;
  }

  function failTrigger(cause) {
    cancelRefreshObservation();
    const cleanupFailure = stopAutomaticTrigger();
    const error = runtimeError(cause ?? cleanupFailure);
    operationEpoch += 1;
    requestedVisible ||= state === 'showing' || state === 'visible';
    settleRejected(run, error);
    state = 'suspended';
    hideAll();
    dispatch('hana:error', { controller, error });
    return error;
  }

  function acceptAutomaticStart(epoch) {
    if (!automaticCanRun(epoch)) return;
    const cleanupFailure = stopAutomaticTrigger();
    if (cleanupFailure !== null) {
      failTrigger(cleanupFailure);
      return;
    }
    if (state === 'idle') show();
  }

  function installLoadTrigger(epoch) {
    if (!automaticCanRun(epoch)) return;
    const start = () => acceptAutomaticStart(epoch);
    if (env.document.readyState === 'loading') {
      env.document.addEventListener('DOMContentLoaded', start, { once: true });
      if (automaticCanRun(epoch)) {
        automatic.stopLoad = () => {
          env.document.removeEventListener('DOMContentLoaded', start);
        };
      } else {
        env.document.removeEventListener('DOMContentLoaded', start);
      }
      return;
    }
    env.microtask(start);
  }

  function installViewportIntersection(epoch) {
    if (!automaticCanRun(epoch) || automatic.shared === null) return;
    let unavailable = false;
    const cleanup = automatic.shared.observeIntersection({
      id: env.triggerId,
      target: automatic.owner,
      threshold: 0.25,
      onEnter() { acceptAutomaticStart(epoch); },
      onExit() {},
      onUnavailable() { unavailable = true; },
    });
    if (!automaticCanRun(epoch)) {
      const failures = [];
      cleanupOperation(cleanup, failures);
      return;
    }
    if (!unavailable) {
      automatic.stopIntersection = cleanup;
      return;
    }
    const failures = [];
    cleanupOperation(cleanup, failures);
    const releaseFailure = stopAutomaticTrigger();
    const failure = failures[0] ?? releaseFailure;
    if (failure !== null) throw failure;
    automatic.active = true;
    automatic.epoch += 1;
    installLoadTrigger(automatic.epoch);
  }

  function viewportLayoutBinding(epoch, generation) {
    return {
      id: env.triggerId,
      generation,
      record: prepared[0].record,
      read() {
        if (!automaticCanRun(epoch) || automatic.generation !== generation) {
          return automatic.owner;
        }
        prepared[0].record.refresh();
        validateRecordRoot(prepared[0].record, prepared[0].target, env);
        return prepared[0].record.ownerElement;
      },
      write(owner) {
        if (!automaticCanRun(epoch)
          || automatic.generation !== generation
          || owner === automatic.owner) return;
        rearmViewportOwner(owner);
      },
      onError(error) {
        if (!automaticCanRun(epoch) || automatic.generation !== generation) return;
        if (error instanceof HanamaruTargetError) return;
        failTrigger(error);
      },
    };
  }

  function rearmViewportOwner(owner) {
    if (!automatic.active || state === 'destroyed' || automatic.shared === null) return;
    automatic.epoch += 1;
    const epoch = automatic.epoch;
    const stopIntersection = automatic.stopIntersection;
    automatic.stopIntersection = null;
    const failures = [];
    cleanupOperation(stopIntersection, failures);
    if (failures.length > 0) {
      failTrigger(failures[0]);
      return;
    }
    if (!automaticCanRun(epoch) || automatic.shared === null) return;
    const priorLayout = automatic.stopLayout;
    try {
      automatic.generation = automatic.shared.bumpGeneration(env.triggerId);
      automatic.owner = owner;
      automatic.stopLayout = automatic.shared.rebindLayout(
        env.triggerId,
        viewportLayoutBinding(epoch, automatic.generation),
      );
    } catch (error) {
      failTrigger(error);
      return;
    }
    cleanupOperation(priorLayout, failures);
    if (failures.length > 0) {
      failTrigger(failures[0]);
      return;
    }
    if (automaticCanRun(epoch)) {
      try {
        installViewportIntersection(epoch);
      } catch (error) {
        failTrigger(error);
      }
    }
  }

  function installViewportTrigger(epoch) {
    automatic.lease = env.acquireDocumentResources(env.document);
    automatic.shared = automatic.lease.shared;
    automatic.generation = automatic.shared.registerController(env.triggerId);
    automatic.registered = true;
    automatic.owner = prepared[0].record.ownerElement;
    automatic.stopLayout = automatic.shared.observeLayout(
      viewportLayoutBinding(epoch, automatic.generation),
    );
    installViewportIntersection(epoch);
  }

  function installAutomaticTrigger() {
    if (options.trigger === 'manual'
      || env.document === undefined
      || typeof env.microtask !== 'function') return;
    automatic.active = true;
    automatic.epoch += 1;
    const epoch = automatic.epoch;
    if (options.trigger === 'load') installLoadTrigger(epoch);
    else installViewportTrigger(epoch);
  }

  function preflightAll() {
    const failures = [];
    for (let index = 0; index < prepared.length; index += 1) {
      try {
        prepared[index].record.refresh();
        validateRecordRoot(prepared[index].record, prepared[index].target, env);
      } catch (error) {
        failures.push({ index, error });
      }
    }
    return failures;
  }

  function settleRejected(activeRun, error) {
    if (activeRun === null || activeRun.settled) return false;
    activeRun.settled = true;
    activeRun.reject(error);
    return true;
  }

  function settleResolved(activeRun) {
    if (activeRun === null || activeRun.settled) return false;
    activeRun.settled = true;
    activeRun.resolve();
    return true;
  }

  function abortPending(reason) {
    return settleRejected(
      run,
      new DOMException(`Group run ${reason}`, 'AbortError'),
    );
  }

  function hideAll(indices = annotations.keys()) {
    let firstFailure = null;
    let firstIndex = -1;
    for (const index of indices) {
      try {
        annotations[index].hide();
      } catch (error) {
        firstFailure ??= error;
        if (firstIndex === -1) firstIndex = index;
      }
    }
    return firstFailure === null ? null : { index: firstIndex, error: firstFailure };
  }

  function failRun(operation, activeRun, index, cause) {
    if (!isCurrent(operation, activeRun) || activeRun.settled) return;
    if (activeRefresh !== null
      && activeRefresh.groupRun === activeRun
      && refreshIsCurrent(activeRefresh)) {
      recordRefreshFailure(activeRefresh, index, cause);
      return;
    }
    cancelRefreshObservation();
    const error = groupMemberError(index, cause);
    operationEpoch += 1;
    requestedVisible = true;
    state = 'suspended';
    settleRejected(activeRun, error);
    hideAll(activeRun.started);
    dispatch('hana:error', { controller, error, index });
  }

  function handleMemberError(annotation, cause) {
    const index = annotationIndices.get(annotation);
    if (index === undefined
      || containingMemberError
      || state === 'destroyed'
      || annotations[index].state !== 'suspended') return;
    if (activeRefresh !== null && refreshIsCurrent(activeRefresh)) {
      recordRefreshFailure(activeRefresh, index, cause);
      return;
    }
    if (state !== 'showing' && state !== 'visible') return;

    cancelRefreshObservation();
    const error = groupMemberError(index, cause);
    operationEpoch += 1;
    requestedVisible = true;
    state = 'suspended';
    settleRejected(run, error);
    containingMemberError = true;
    try {
      hideAll();
    } finally {
      containingMemberError = false;
    }
    dispatch('hana:error', { controller, error, index });
  }

  function memberResolved(operation, activeRun, index, memberRun) {
    if (!isCurrent(operation, activeRun)
      || activeRun.settled
      || activeRun.memberRuns[index] !== memberRun) return;
    activeRun.completed += 1;
    if (activeRun.completed !== annotations.length) return;
    state = 'visible';
    settleResolved(activeRun);
    dispatch('hana:complete', { controller, state });
  }

  function observeMemberRun(operation, activeRun, index, memberRun) {
    memberRun.then(
      () => memberResolved(operation, activeRun, index, memberRun),
      (error) => failRun(operation, activeRun, index, error),
    ).catch(() => {});
  }

  function beginRun() {
    cancelRefreshObservation();
    operationEpoch += 1;
    const operation = operationEpoch;
    const deferredRun = createDeferred();
    Object.assign(deferredRun, {
      completed: 0,
      memberRuns: Array(annotations.length).fill(null),
      started: new Set(),
    });
    run = deferredRun;
    requestedVisible = true;
    state = 'showing';
    dispatch('hana:start', { controller, state });
    if (!isCurrent(operation, deferredRun) || state !== 'showing') return;

    for (let index = 0; index < annotations.length; index += 1) {
      if (!isCurrent(operation, deferredRun) || state !== 'showing') return;
      deferredRun.started.add(index);
      try {
        annotations[index].show();
        const memberRun = annotations[index].finished;
        if (memberRun === null || typeof memberRun?.then !== 'function') {
          throw new TypeError('Group member run did not provide a Promise');
        }
        deferredRun.memberRuns[index] = memberRun;
        observeMemberRun(operation, deferredRun, index, memberRun);
      } catch (error) {
        failRun(operation, deferredRun, index, error);
        return;
      }
    }
  }

  function reportPreflightFailure(failure, preserveState) {
    const error = groupMemberError(failure.index, failure.error);
    if (!preserveState) {
      operationEpoch += 1;
      requestedVisible = true;
      state = 'suspended';
      const failedRun = createDeferred();
      run = failedRun;
      settleRejected(failedRun, error);
    }
    dispatch('hana:error', { controller, error, index: failure.index });
    return error;
  }

  function show() {
    if (state !== 'idle' && state !== 'hidden' && state !== 'suspended') {
      return controller;
    }
    cancelRefreshObservation();
    const triggerFailure = stopAutomaticTrigger();
    if (triggerFailure !== null) {
      failTrigger(triggerFailure);
      return controller;
    }
    const failures = preflightAll();
    if (failures.length > 0) {
      reportPreflightFailure(failures[0], false);
      return controller;
    }
    beginRun();
    return controller;
  }

  function hide() {
    if (state !== 'showing' && state !== 'visible' && state !== 'suspended') {
      return controller;
    }
    cancelRefreshObservation();
    operationEpoch += 1;
    requestedVisible = false;
    state = 'hidden';
    abortPending('hidden');
    hideAll();
    dispatch('hana:cancel', { controller, reason: 'hide' });
    return controller;
  }

  function replay() {
    if (state === 'destroyed') return controller;
    const failures = preflightAll();
    if (failures.length > 0) {
      throw reportPreflightFailure(failures[0], true);
    }

    const triggerFailure = stopAutomaticTrigger();
    if (triggerFailure !== null) {
      throw failTrigger(triggerFailure);
    }
    cancelRefreshObservation();
    operationEpoch += 1;
    const operation = operationEpoch;
    const previousState = state;
    abortPending('replayed');
    requestedVisible = false;
    state = 'hidden';
    hideAll();
    if (previousState === 'showing'
      || previousState === 'visible'
      || previousState === 'suspended') {
      dispatch('hana:cancel', { controller, reason: 'replay' });
    }
    if (state === 'destroyed' || operation !== operationEpoch) return controller;
    beginRun();
    return controller;
  }

  function refreshFailures() {
    const failures = [];
    for (let index = 0; index < annotations.length; index += 1) {
      const captured = typeof env.memberError === 'function'
        ? env.memberError(annotations[index])
        : undefined;
      if (captured !== undefined) {
        failures.push({ index, error: captured });
      } else if (annotations[index].state === 'suspended') {
        failures.push({
          index,
          error: new HanamaruStateError(
            'HANA_STATE_RUNTIME',
            'Group member refresh failed',
          ),
        });
      }
    }
    return failures;
  }

  function combinedRefreshFailures(refreshOperation) {
    return [
      ...refreshOperation.failures,
      ...refreshFailures(),
    ];
  }

  function scheduleRefreshCoordinator(refreshOperation) {
    if (!refreshIsCurrent(refreshOperation)
      || refreshOperation.coordinatorQueued) return;
    refreshOperation.coordinatorQueued = true;
    const coordinate = () => {
      if (!refreshIsCurrent(refreshOperation)) return;
      refreshOperation.coordinatorQueued = false;
      const failures = combinedRefreshFailures(refreshOperation);
      if (failures.length > 0) {
        failRefresh(refreshOperation, failures);
        return;
      }
      if (refreshOperation.recovery) {
        finishRefreshRecovery(refreshOperation);
      } else {
        activeRefresh = null;
      }
    };
    if (typeof env.microtask === 'function') env.microtask(coordinate);
    else Promise.resolve().then(coordinate);
  }

  function recordRefreshFailure(refreshOperation, index, error) {
    if (!refreshIsCurrent(refreshOperation)) return;
    refreshOperation.failures.push({ index, error });
    if (refreshOperation.frameChecked) {
      scheduleRefreshCoordinator(refreshOperation);
    }
  }

  function failRefresh(refreshOperation, failures) {
    if (!refreshIsCurrent(refreshOperation) || failures.length === 0) return;
    const failure = failures.reduce((lowest, candidate) => (
      candidate.index < lowest.index ? candidate : lowest
    ));
    const error = groupMemberError(failure.index, failure.error);
    cancelRefreshObservation();
    operationEpoch += 1;
    requestedVisible = refreshOperation.priorState === 'showing'
      || refreshOperation.priorState === 'visible'
      ? true
      : refreshOperation.requestedVisible;
    state = 'suspended';
    settleRejected(run, error);
    hideAll();
    dispatch('hana:error', {
      controller,
      error,
      index: failure.index,
    });
  }

  function finishRefreshRecovery(refreshOperation) {
    if (!refreshIsCurrent(refreshOperation)
      || !refreshOperation.recovery
      || !refreshOperation.frameChecked
      || refreshOperation.remaining !== 0) return;
    const failures = combinedRefreshFailures(refreshOperation);
    if (failures.length > 0) {
      failRefresh(refreshOperation, failures);
      return;
    }
    if (annotations.every((annotation) => annotation.state === 'visible')) {
      state = 'visible';
      activeRefresh = null;
    }
  }

  function observeRefreshRun(refreshOperation, index, memberRun) {
    refreshOperation.remaining += 1;
    memberRun.then(
      () => {
        if (!refreshIsCurrent(refreshOperation)) return;
        refreshOperation.remaining -= 1;
        finishRefreshRecovery(refreshOperation);
      },
      (error) => {
        if (!refreshIsCurrent(refreshOperation)) return;
        recordRefreshFailure(refreshOperation, index, error);
      },
    ).catch(() => {});
  }

  function checkRefreshFrame(refreshOperation) {
    if (!refreshIsCurrent(refreshOperation)) return;
    stopRefresh = null;
    const failures = combinedRefreshFailures(refreshOperation);
    if (failures.length > 0) {
      failRefresh(refreshOperation, failures);
      return;
    }
    refreshOperation.frameChecked = true;
    scheduleRefreshCoordinator(refreshOperation);
  }

  function scheduleRefreshCheck(refreshOperation) {
    if (typeof env.afterRefresh === 'function') {
      stopRefresh = env.afterRefresh(() => checkRefreshFrame(refreshOperation));
      return;
    }
    let active = true;
    const callback = () => {
      if (active) checkRefreshFrame(refreshOperation);
    };
    if (typeof env.microtask === 'function') env.microtask(callback);
    else Promise.resolve().then(callback);
    stopRefresh = () => { active = false; };
  }

  function refresh() {
    if (state !== 'showing' && state !== 'visible' && state !== 'suspended') {
      return controller;
    }
    cancelRefreshObservation();
    const priorState = state;
    const priorRequestedVisible = requestedVisible;
    const refreshOperation = {
      coordinatorQueued: false,
      failures: [],
      frameChecked: false,
      groupRun: run,
      id: refreshEpoch,
      operation: operationEpoch,
      priorState,
      recovery: priorState === 'suspended' && priorRequestedVisible,
      remaining: 0,
      requestedVisible: priorRequestedVisible,
    };
    activeRefresh = refreshOperation;
    const failures = [];
    for (const annotation of annotations) {
      env.clearMemberError?.(annotation);
    }
    for (let index = 0; index < annotations.length; index += 1) {
      try {
        prepared[index].record.refresh();
        validateRecordRoot(prepared[index].record, prepared[index].target, env);
      } catch (error) {
        failures.push({ index, error });
      }
    }
    if (refreshOperation.recovery && failures.length === 0) {
      for (let index = 0; index < annotations.length; index += 1) {
        if (annotations[index].state === 'showing'
          || annotations[index].state === 'visible') continue;
        try {
          annotations[index].show();
          const memberRun = annotations[index].finished;
          if (memberRun === null || typeof memberRun?.then !== 'function') {
            throw new TypeError('Group member refresh did not provide a Promise');
          }
          observeRefreshRun(refreshOperation, index, memberRun);
        } catch (error) {
          failures.push({ index, error });
        }
      }
    }
    for (let index = 0; index < annotations.length; index += 1) {
      try {
        annotations[index].refresh();
      } catch (error) {
        failures.push({ index, error });
      }
    }
    if (failures.length > 0) {
      failRefresh(refreshOperation, failures);
      return controller;
    }
    const immediateFailures = refreshFailures();
    if (immediateFailures.length > 0) {
      failRefresh(refreshOperation, immediateFailures);
      return controller;
    }
    if (refreshOperation.recovery
      && refreshOperation.remaining === 0
      && annotations.every((annotation) => annotation.state === 'visible')) {
      state = 'visible';
    }
    try {
      scheduleRefreshCheck(refreshOperation);
    } catch (error) {
      failRefresh(refreshOperation, [{ index: 0, error }]);
    }
    return controller;
  }

  function destroy() {
    if (state === 'destroyed') return controller;
    deleteControllerMetadata(controller);
    operationEpoch += 1;
    const notifyCancel = run !== null && !run.settled;
    abortPending('destroyed');
    requestedVisible = false;
    state = 'destroyed';
    let failure = cancelRefreshObservation();
    const triggerFailure = stopAutomaticTrigger();
    failure ??= triggerFailure;
    const memberErrorCleanup = stopMemberErrors;
    stopMemberErrors = null;
    if (memberErrorCleanup !== null) {
      try {
        memberErrorCleanup();
      } catch (error) {
        failure ??= error;
      }
    }
    for (let index = annotations.length - 1; index >= 0; index -= 1) {
      try {
        annotations[index].destroy();
      } catch (error) {
        failure ??= error;
      }
    }
    if (notifyCancel) dispatch('hana:cancel', { controller, reason: 'destroy' });
    if (failure !== null) {
      const error = runtimeError(failure);
      try {
        dispatch('hana:error', { controller, error });
      } catch { /* Cleanup failure remains contained. */ }
    }
    return controller;
  }

  try {
    if (typeof env.observeMemberErrors === 'function') {
      stopMemberErrors = env.observeMemberErrors(handleMemberError);
    }
    installAutomaticTrigger();
    if (state !== 'destroyed' && env.recordMetadata !== false) {
      recordGroupMetadata(controller, options, annotations);
      if (state === 'destroyed') deleteControllerMetadata(controller);
    }
  } catch (error) {
    if (state !== 'destroyed') {
      operationEpoch += 1;
      abortPending('destroyed');
      requestedVisible = false;
      state = 'destroyed';
      cancelRefreshObservation();
      stopAutomaticTrigger();
      try { stopMemberErrors?.(); } catch { /* Preserve setup failure. */ }
      stopMemberErrors = null;
      for (let index = annotations.length - 1; index >= 0; index -= 1) {
        try { annotations[index].destroy(); } catch { /* Preserve setup or metadata failure. */ }
      }
    }
    deleteControllerMetadata(controller);
    throw runtimeError(error);
  }
  return controller;
}
