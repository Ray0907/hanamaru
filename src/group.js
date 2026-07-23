import {
  createAnnotation,
  createAnnotationEnvironment,
  normalizeOptions,
} from './annotation.js';
import {
  HanamaruConfigError,
  HanamaruStateError,
  HanamaruTargetError,
} from './errors.js';
import { acquireDocumentResources } from './scheduler.js';
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

function rootKind(root) {
  if (root?.nodeType === 9) return 'document';
  if (root?.nodeType === 11 && root.host !== undefined) return 'shadow-root';
  if (root?.nodeType === 11) return 'document-fragment';
  return 'unknown';
}

function validateRecordRoot(record, target, env) {
  if (env.root === undefined) return;
  const actualRoot = record?.ownerElement?.getRootNode?.();
  if (actualRoot === env.root) return;
  const details = {
    target,
    expectedRoot: rootKind(env.root),
    actualRoot: rootKind(actualRoot),
  };
  if (rootKind(env.root) === 'document' && rootKind(actualRoot) === 'shadow-root') {
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
  if (target?.nodeType === 1) {
    return [target.getRootNode?.()];
  }
  if (target?.startContainer !== undefined || target?.endContainer !== undefined) {
    return [
      target.startContainer?.getRootNode?.(),
      target.endContainer?.getRootNode?.(),
    ];
  }
  if (target?.within?.nodeType === 1) {
    return [target.within.getRootNode?.()];
  }
  return [];
}

function validateTargetRoot(target, env) {
  if (env.root === undefined) return;
  const roots = targetRoots(target).filter((root) => root !== undefined);
  if (roots.length === 0 || roots.every((root) => root === env.root)) return;
  const actualRoot = roots[0];
  const details = {
    target,
    expectedRoot: rootKind(env.root),
    actualRoot: roots.every((root) => root === actualRoot)
      ? rootKind(actualRoot)
      : 'mixed',
  };
  if (rootKind(env.root) === 'document'
    && roots.every((root) => rootKind(root) === 'shadow-root')) {
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

function defaultGroupEnvironment(root) {
  const view = root.defaultView;
  return {
    root,
    document: root,
    triggerId: `hana-group-trigger-${++nextGroupId}`,
    acquireDocumentResources,
    createAnnotation(target, options) {
      const annotationEnvironment = createAnnotationEnvironment(target, root);
      annotationEnvironment.createEvent = () => {};
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
    microtask(callback) { view.queueMicrotask(callback); },
    resolveTarget(target) { return resolveTarget(target, root); },
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
  return createGroup(members, options, defaultGroupEnvironment(root));
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
  let requestedVisible = false;
  const automatic = {
    active: false,
    epoch: 0,
    lease: null,
    registered: false,
    shared: null,
    stopIntersection: null,
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

  function stopAutomaticTrigger() {
    automatic.active = false;
    automatic.epoch += 1;
    const stopLoad = automatic.stopLoad;
    const stopIntersection = automatic.stopIntersection;
    const shared = automatic.shared;
    const lease = automatic.lease;
    const registered = automatic.registered;
    automatic.stopLoad = null;
    automatic.stopIntersection = null;
    automatic.shared = null;
    automatic.lease = null;
    automatic.registered = false;
    const failures = [];
    cleanupOperation(stopLoad, failures);
    cleanupOperation(stopIntersection, failures);
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

  function installViewportTrigger(epoch) {
    automatic.lease = env.acquireDocumentResources(env.document);
    automatic.shared = automatic.lease.shared;
    automatic.shared.registerController(env.triggerId);
    automatic.registered = true;
    let unavailable = false;
    const cleanup = automatic.shared.observeIntersection({
      id: env.triggerId,
      target: prepared[0].record.ownerElement,
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
    const error = groupMemberError(index, cause);
    operationEpoch += 1;
    requestedVisible = true;
    state = 'suspended';
    settleRejected(activeRun, error);
    hideAll(activeRun.started);
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

  function refresh() {
    if (state !== 'showing' && state !== 'visible' && state !== 'suspended') {
      return controller;
    }
    const priorState = state;
    const priorRequestedVisible = requestedVisible;
    const failures = [];
    for (let index = 0; index < annotations.length; index += 1) {
      try {
        prepared[index].record.refresh();
        validateRecordRoot(prepared[index].record, prepared[index].target, env);
      } catch (error) {
        failures.push({ index, error });
      }
      try {
        annotations[index].refresh();
      } catch (error) {
        failures.push({ index, error });
      }
    }
    if (failures.length > 0) {
      const failure = failures[0];
      const error = groupMemberError(failure.index, failure.error);
      operationEpoch += 1;
      requestedVisible = priorState === 'showing' || priorState === 'visible'
        ? true
        : priorRequestedVisible;
      state = 'suspended';
      settleRejected(run, error);
      hideAll();
      dispatch('hana:error', {
        controller,
        error,
        index: failure.index,
      });
      return controller;
    }
    if (state === 'suspended'
      && requestedVisible
      && annotations.every((annotation) => annotation.state === 'visible')) {
      state = 'visible';
    }
    return controller;
  }

  function destroy() {
    if (state === 'destroyed') return controller;
    operationEpoch += 1;
    const notifyCancel = run !== null && !run.settled;
    abortPending('destroyed');
    requestedVisible = false;
    state = 'destroyed';
    let failure = stopAutomaticTrigger();
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
    installAutomaticTrigger();
  } catch (error) {
    stopAutomaticTrigger();
    for (let index = annotations.length - 1; index >= 0; index -= 1) {
      try { annotations[index].destroy(); } catch { /* Preserve trigger setup failure. */ }
    }
    throw runtimeError(error);
  }
  return controller;
}
