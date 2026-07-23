import { annotate } from '../annotation.js';
import { HanamaruConfigError } from '../errors.js';
import {
  createAdapterOwner,
  prepareAdapterRequest,
} from './lifecycle.js';

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
const ADAPTER_KEYS = new Set([
  ...OPTION_KEYS,
  ...CONFIG_KEYS,
  'onController',
]);

function invalid(field, value) {
  throw new HanamaruConfigError(
    'HANA_CONFIG_INVALID',
    `Invalid adapter option: ${String(field)}`,
    { field, value },
  );
}

function descriptorValue(input, descriptor) {
  if (Object.hasOwn(descriptor, 'value')) return descriptor.value;
  if (descriptor.get === undefined) return undefined;
  return Reflect.apply(descriptor.get, input, []);
}

function prepareSvelteRequest(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalid('input', input);
  }

  const options = {};
  const config = {};
  let onController;
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined) continue;
    const value = descriptorValue(input, descriptor);
    if (typeof key !== 'string' || !ADAPTER_KEYS.has(key)) {
      invalid(key, value);
    }
    if (OPTION_KEYS.has(key)) {
      Object.defineProperty(options, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    } else if (CONFIG_KEYS.has(key)) {
      Object.defineProperty(config, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    } else {
      onController = value;
    }
  }

  if (onController !== undefined && typeof onController !== 'function') {
    invalid('onController', onController);
  }

  return Object.freeze({
    onController,
    prepared: prepareAdapterRequest(options, config),
  });
}

function sameRequest(previous, prepared) {
  return previous !== null
    && previous.enabled === prepared.config.enabled
    && previous.canonical.length === prepared.canonical.length
    && previous.canonical.every(
      (value, index) => Object.is(value, prepared.canonical[index]),
    );
}

export function annotation(node, input) {
  let destroyed = false;
  let operationEpoch = 0;
  const slot = {
    onController: undefined,
    onError: undefined,
    owner: null,
    request: null,
  };

  function expose(controller) {
    slot.onController?.(controller);
  }

  function handleError(error, controller) {
    return slot.onError?.(error, controller);
  }

  function operationIsCurrent(operation) {
    return !destroyed && operation === operationEpoch;
  }

  function apply(nextInput, initial) {
    const operation = ++operationEpoch;
    if (destroyed) return;
    const request = prepareSvelteRequest(nextInput);
    if (!operationIsCurrent(operation)) return;
    const { prepared } = request;
    slot.onController = request.onController;
    slot.onError = prepared.config.onError;
    if (sameRequest(slot.request, prepared)) return;
    slot.request = Object.freeze({
      canonical: prepared.canonical,
      enabled: prepared.config.enabled,
    });

    const owner = slot.owner ?? createAdapterOwner({
      create: annotate,
      expose,
    });
    slot.owner = owner;
    const config = {
      enabled: prepared.config.enabled,
      onError: handleError,
    };
    if (!operationIsCurrent(operation)) return;
    if (initial) owner.mount(node, prepared.options, config);
    else owner.update(node, prepared.options, config);
    if (!operationIsCurrent(operation)) return;
  }

  function update(nextInput) {
    apply(nextInput, false);
  }

  function destroy() {
    operationEpoch += 1;
    if (destroyed) return;
    destroyed = true;
    const owner = slot.owner;
    slot.owner = null;
    slot.request = null;
    try {
      owner?.destroy();
    } finally {
      slot.onController = undefined;
      slot.onError = undefined;
    }
  }

  apply(input, true);
  return { update, destroy };
}
