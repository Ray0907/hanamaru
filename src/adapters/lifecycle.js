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

  const manual = { ...input, trigger: 'manual' };
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

function sameCanonical(left, right) {
  return left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
}

function defaultQueueThrow(error) {
  queueMicrotask(() => {
    throw error;
  });
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

  function cleanup(
    record,
    notify,
    primaryFailure = null,
    queueExposureFailure = false,
  ) {
    if (record === null || !record.active) return primaryFailure;
    record.active = false;
    let failure = primaryFailure;
    try {
      record.target.removeEventListener('hana:error', record.listener);
    } catch (error) {
      failure ??= error;
    }
    try {
      record.controller.destroy();
    } catch (error) {
      failure ??= error;
    }
    if (notify && record.exposed) {
      record.exposed = false;
      if (current !== null) return failure;
      try {
        expose(null);
      } catch (error) {
        if (queueExposureFailure) queueThrow(error);
        else failure ??= error;
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

    current = null;
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
    if (record.phase === 'candidate') {
      if (record.pendingFailure !== null) return;
      if (seenFailure(record, error, failureGeneration)) return;
      record.pendingFailure = { error, generation: failureGeneration };
      return;
    }
    handleFailure(record, error, failureGeneration);
  }

  function eventFailure(record, event) {
    let detail;
    try {
      detail = event?.detail;
      if (detail?.controller !== record.controller) return;
    } catch {
      return;
    }
    routeFailure(record, detail.error, detail.generation);
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

  function createRecord(target, prepared, config) {
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
      onError: config.onError,
      pendingFailure: null,
      phase: 'candidate',
      target,
    };
    record.listener = (event) => eventFailure(record, event);

    try {
      target.addEventListener('hana:error', record.listener);
      controller.show();
      record.finished = controller.finished;
      observeFinished(record);
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
      if (failure !== null) throw failure;
      return owner;
    }

    if (target === null || target === undefined) {
      if (current !== null) current.onError = config.onError;
      return owner;
    }

    if (current !== null && current.target === target) {
      const active = current;
      active.onError = config.onError;
      if (sameCanonical(active.canonical, prepared.canonical)) return owner;
      try {
        active.controller.update(completeManual(prepared, active.defaultSeed));
        if (!destroyed
          && operation === operationEpoch
          && current === active
          && active.active) {
          active.canonical = prepared.canonical;
        }
      } catch (error) {
        if (current === active) current = null;
        cleanup(active, true, error);
        throw error;
      }
      return owner;
    }

    const previous = current;
    const candidate = createRecord(target, prepared, config);
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
      if (teardownFailure !== null) {
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
    if (failure !== null) throw failure;
    return owner;
  }

  const owner = { mount, update, destroy };
  return owner;
}
