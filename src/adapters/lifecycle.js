import { normalizeOptions } from '../annotation.js';
import { HanamaruConfigError } from '../errors.js';

const OPTION_KEYS = new Set([
  'mark',
  'note',
  'placement',
  'accessible',
  'seed',
  'duration',
  'motion',
]);
const CONFIG_KEYS = new Set(['enabled', 'onError']);
const DEFAULT_SEED = '__hanamaru_adapter_default_seed__';
const NO_FAILURE = Symbol('no failure');
let nextAdapterSeed = 0;

function invalid(field, value) {
  throw new HanamaruConfigError(
    'HANA_CONFIG_INVALID',
    `Invalid adapter option: ${field}`,
    { field, value },
  );
}

function own(input, key) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function normalizeAdapterOptions(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalid('input', input);
  }
  for (const key of Object.keys(input)) {
    if (key === 'trigger' || !OPTION_KEYS.has(key)) invalid(key, input[key]);
  }
  if (own(input, 'trigger')) invalid('trigger', input.trigger);

  const source = { ...input };
  const manual = { ...source, trigger: 'manual' };
  const normalized = normalizeOptions(manual, DEFAULT_SEED);
  return {
    canonical: [
      normalized.mark,
      normalized.note,
      normalized.placement,
      normalized.accessible,
      own(input, 'seed'),
      normalized.seed,
      normalized.duration,
      normalized.motion,
    ],
    normalized,
    seedExplicit: own(input, 'seed'),
    source,
  };
}

function allocateDefaultSeed() {
  nextAdapterSeed += 1;
  return `hana-adapter-${nextAdapterSeed}`;
}

function completeManual(prepared, defaultSeed) {
  return {
    mark: prepared.normalized.mark,
    note: prepared.normalized.note,
    placement: prepared.normalized.placement,
    trigger: 'manual',
    accessible: prepared.normalized.accessible,
    seed: prepared.seedExplicit ? prepared.normalized.seed : defaultSeed,
    duration: prepared.normalized.duration,
    motion: prepared.normalized.motion,
  };
}

function normalizeConfig(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalid('config', input);
  }
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) invalid(`config.${key}`, input[key]);
  }
  const enabled = own(input, 'enabled') ? input.enabled : true;
  if (typeof enabled !== 'boolean') invalid('enabled', enabled);
  const onError = own(input, 'onError') ? input.onError : undefined;
  if (onError !== undefined && typeof onError !== 'function') {
    invalid('onError', onError);
  }
  return { enabled, onError };
}

export function prepareAdapterRequest(optionsInput, configInput = {}) {
  const prepared = normalizeAdapterOptions(optionsInput);
  const config = normalizeConfig(configInput);
  return Object.freeze({
    canonical: Object.freeze([...prepared.canonical]),
    config: Object.freeze(config),
    options: Object.freeze(prepared.source),
  });
}

function sameCanonical(left, right) {
  return left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
}

function defaultQueueThrow(error) {
  queueMicrotask(() => {
    throw error;
  });
}

function attachCleanupCause(cause, cleanupCause) {
  if (cause === null
    || (typeof cause !== 'object' && typeof cause !== 'function')) {
    return;
  }
  try {
    if (!Object.hasOwn(cause, 'cleanupCause')) {
      Object.defineProperty(cause, 'cleanupCause', {
        configurable: true,
        value: cleanupCause,
      });
    }
    const descriptor = Object.getOwnPropertyDescriptor(cause, 'cleanupCauses');
    const previous = descriptor !== undefined
      && Object.hasOwn(descriptor, 'value')
      && Array.isArray(descriptor.value)
      ? descriptor.value
      : [];
    Object.defineProperty(cause, 'cleanupCauses', {
      configurable: true,
      value: Object.freeze([...previous, cleanupCause]),
    });
  } catch {
    // The exact first failure remains authoritative when it cannot carry metadata.
  }
}

export function createAdapterOwner({
  create,
  expose = () => {},
  queueThrow = defaultQueueThrow,
}) {
  if (typeof create !== 'function') throw new TypeError('create must be a function');
  if (typeof expose !== 'function') throw new TypeError('expose must be a function');
  if (typeof queueThrow !== 'function') throw new TypeError('queueThrow must be a function');

  let current = null;
  let destroyed = false;
  let nextGeneration = 0;
  let operationEpoch = 0;

  function cleanup(record, notify, ...failureOptions) {
    let failure = failureOptions.length === 0 ? NO_FAILURE : failureOptions[0];
    const queueExposureFailure = failureOptions[1] === true;
    if (record === null || !record.active) return failure;
    record.active = false;
    const recordFailure = (error) => {
      if (failure === NO_FAILURE) failure = error;
      else attachCleanupCause(failure, error);
    };
    if (record.listening) {
      record.listening = false;
      try {
        record.target.removeEventListener('hana:error', record.listener);
      } catch (error) {
        recordFailure(error);
      }
    }
    try {
      record.controller.destroy();
    } catch (error) {
      recordFailure(error);
    }
    if (notify && record.exposed) {
      record.exposed = false;
      if (current !== null) return failure;
      try {
        expose(null);
      } catch (error) {
        if (queueExposureFailure) queueThrow(error);
        else recordFailure(error);
      }
    }
    return failure;
  }

  function seenFailure(record, error, failureGeneration) {
    if (failureGeneration !== undefined && failureGeneration !== null) {
      if (record.failureGenerations.has(failureGeneration)) return true;
      record.failureGenerations.add(failureGeneration);
    }
    if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
      if (record.failureObjects.has(error)) return true;
      record.failureObjects.add(error);
    } else {
      if (record.failurePrimitives.has(error)) return true;
      record.failurePrimitives.add(error);
    }
    return false;
  }

  function abortFailure(error) {
    try {
      return error?.name === 'AbortError';
    } catch {
      return false;
    }
  }

  function handleFailure(record, error, failureGeneration) {
    if (destroyed || current !== record || !record.active) return;
    if (seenFailure(record, error, failureGeneration)) return;

    deliverFailure(record, error);
  }

  function deliverFailure(record, error) {
    if (current === record) current = null;
    record.phase = 'failed';
    record.pendingFailure = null;
    cleanup(record, true, error, true);
    if (abortFailure(error) || record.onError === undefined) return;
    try {
      record.onError(error, record.controller);
    } catch (callbackError) {
      queueThrow(callbackError);
    }
  }

  function routeFailure(record, error, failureGeneration) {
    if (!record.active) return;
    if (record.phase === 'candidate' || record.phase === 'updating') {
      if (record.pendingFailure !== null) return;
      if (seenFailure(record, error, failureGeneration)) return;
      record.pendingFailure = { error, generation: failureGeneration };
      return;
    }
    handleFailure(record, error, failureGeneration);
  }

  function eventFailure(record, event) {
    let controller;
    let error;
    let failureGeneration;
    try {
      const detail = event?.detail;
      controller = detail?.controller;
      if (controller !== record.controller) return;
      error = detail.error;
      failureGeneration = detail.generation;
    } catch {
      return;
    }
    routeFailure(record, error, failureGeneration);
  }

  function observeFinished(record) {
    const finished = record.finished;
    if (finished === null || finished === undefined) {
      throw new TypeError('controller.finished must be a Promise');
    }
    const then = finished.then;
    if (typeof then !== 'function') {
      throw new TypeError('controller.finished must be a Promise');
    }
    Reflect.apply(then, finished, [
      undefined,
      (error) => routeFailure(record, error, undefined),
    ]);
  }

  function operationIsCurrent(operation) {
    return !destroyed && operation === operationEpoch;
  }

  function createRecord(target, prepared, config, operation) {
    const defaultSeed = allocateDefaultSeed();
    const controller = create(target, completeManual(prepared, defaultSeed));
    if (controller === null
      || (typeof controller !== 'object' && typeof controller !== 'function')) {
      throw new TypeError('create must return an annotation controller');
    }

    const record = {
      active: true,
      canonical: prepared.canonical,
      controller,
      defaultSeed,
      exposed: false,
      failureGenerations: new Set(),
      failureObjects: new WeakSet(),
      failurePrimitives: new Set(),
      finished: null,
      generation: ++nextGeneration,
      listener: null,
      listening: false,
      onError: config.onError,
      pendingFailure: null,
      phase: 'candidate',
      target,
      updateDepth: 0,
      updateOwner: null,
    };
    record.listener = (event) => eventFailure(record, event);
    if (!operationIsCurrent(operation)) {
      cleanup(record, false);
      return record;
    }

    try {
      record.listening = true;
      target.addEventListener('hana:error', record.listener);
      if (!operationIsCurrent(operation)) {
        cleanup(record, false);
        return record;
      }
      controller.show();
      if (!operationIsCurrent(operation)) {
        cleanup(record, false);
        return record;
      }
      record.finished = controller.finished;
      if (!operationIsCurrent(operation)) {
        cleanup(record, false);
        return record;
      }
      observeFinished(record);
      if (!operationIsCurrent(operation)) cleanup(record, false);
    } catch (error) {
      cleanup(record, false, error);
      throw error;
    }
    return record;
  }

  function rejectCandidate(record, previous) {
    const failure = record.pendingFailure;
    record.phase = 'failed';
    cleanup(record, false, failure.error, true);
    if (previous === null && current === null) {
      try {
        expose(null);
      } catch (error) {
        queueThrow(error);
      }
    }
    if (abortFailure(failure.error) || record.onError === undefined) return;
    try {
      record.onError(failure.error, record.controller);
    } catch (error) {
      queueThrow(error);
    }
  }

  function exposeRecord(record) {
    record.exposed = true;
    try {
      expose(record.controller);
    } catch (error) {
      if (current === record) current = null;
      cleanup(record, true, error);
      throw error;
    }
  }

  function transition(target, rawOptions, rawConfig) {
    if (destroyed) return owner;
    const operation = ++operationEpoch;
    const prepared = normalizeAdapterOptions(rawOptions);
    const config = normalizeConfig(rawConfig);
    if (destroyed || operation !== operationEpoch) return owner;

    if (!config.enabled) {
      const previous = current;
      current = null;
      const failure = cleanup(previous, true);
      if (failure !== NO_FAILURE) throw failure;
      return owner;
    }

    if (target === null || target === undefined) {
      if (current !== null) current.onError = config.onError;
      return owner;
    }

    if (current !== null && current.target === target) {
      const active = current;
      active.onError = config.onError;
      if (sameCanonical(active.canonical, prepared.canonical)) {
        return owner;
      }
      if (active.updateDepth === 0) active.pendingFailure = null;
      active.phase = 'updating';
      active.updateDepth += 1;
      active.updateOwner = operation;
      try {
        active.controller.update(completeManual(prepared, active.defaultSeed));
      } catch (error) {
        active.updateDepth -= 1;
        const authoritative = current === active && active.active;
        if (authoritative) {
          current = null;
          active.phase = 'failed';
          active.pendingFailure = null;
          active.updateOwner = null;
          cleanup(active, true, error);
        }
        throw error;
      }
      active.updateDepth -= 1;
      if (current !== active || !active.active) return owner;
      if (active.updateOwner === operation) {
        active.canonical = prepared.canonical;
      }
      if (active.updateDepth !== 0) return owner;
      active.updateOwner = null;
      const pendingFailure = active.pendingFailure;
      active.pendingFailure = null;
      active.phase = 'current';
      if (pendingFailure !== null) deliverFailure(active, pendingFailure.error);
      return owner;
    }

    const previous = current;
    const candidate = createRecord(target, prepared, config, operation);
    if (destroyed || operation !== operationEpoch) {
      cleanup(candidate, false);
      return owner;
    }
    if (candidate.pendingFailure !== null) {
      rejectCandidate(candidate, previous);
      return owner;
    }
    if (previous !== null) {
      current = null;
      const teardownFailure = cleanup(previous, true);
      if (teardownFailure !== NO_FAILURE) {
        cleanup(candidate, false, teardownFailure);
        throw teardownFailure;
      }
      if (destroyed || operation !== operationEpoch) {
        cleanup(candidate, false);
        return owner;
      }
    }
    candidate.phase = 'current';
    current = candidate;
    try {
      exposeRecord(candidate);
    } catch (error) {
      throw error;
    }
    return owner;
  }

  function mount(target, options, config = {}) {
    return transition(target, options, config);
  }

  function update(target, options, config = {}) {
    return transition(target, options, config);
  }

  function destroy() {
    if (destroyed) return owner;
    destroyed = true;
    operationEpoch += 1;
    const previous = current;
    current = null;
    const failure = cleanup(previous, true);
    if (failure !== NO_FAILURE) throw failure;
    return owner;
  }

  const owner = { mount, update, destroy };
  return owner;
}
