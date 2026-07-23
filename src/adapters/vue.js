import {
  onBeforeUnmount,
  onMounted,
  shallowRef,
  unref,
  watch,
} from 'vue';

import { annotate } from '../annotation.js';
import {
  createAdapterOwner,
  prepareAdapterRequest,
} from './lifecycle.js';

function snapshotReactiveInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }

  const snapshot = {};
  for (const key of Reflect.ownKeys(input)) {
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: Reflect.get(input, key, input),
      writable: true,
    });
  }
  return snapshot;
}

function readRequest(targetRef, optionsOrRef, configOrRef, mounted) {
  const target = unref(targetRef);
  if (!mounted && (target === null || target === undefined)) {
    return Object.freeze({ prepared: null, target });
  }
  return Object.freeze({
    prepared: prepareAdapterRequest(
      snapshotReactiveInput(unref(optionsOrRef)),
      snapshotReactiveInput(unref(configOrRef)),
    ),
    target,
  });
}

function sameRequest(previous, request) {
  const { canonical, config } = request.prepared;
  return previous !== null
    && previous.target === request.target
    && previous.enabled === config.enabled
    && previous.canonical.length === canonical.length
    && previous.canonical.every(
      (value, index) => Object.is(value, canonical[index]),
    );
}

export function useAnnotation(targetRef, optionsOrRef, configOrRef = {}) {
  const controller = shallowRef(null);
  const readiness = shallowRef(0);
  const slot = {
    mounted: false,
    onError: undefined,
    owner: null,
    request: null,
  };

  function handleError(error, activeController) {
    return slot.onError?.(error, activeController);
  }

  function applyRequest(request) {
    const { prepared, target } = request;
    slot.onError = prepared.config.onError;
    if (sameRequest(slot.request, request)) return;
    slot.request = Object.freeze({
      canonical: prepared.canonical,
      enabled: prepared.config.enabled,
      target,
    });

    const owner = slot.owner ?? createAdapterOwner({
      create: annotate,
      expose(value) {
        controller.value = value;
      },
    });
    const initial = slot.owner === null;
    slot.owner = owner;
    const config = {
      enabled: prepared.config.enabled,
      onError: handleError,
    };
    if (initial) owner.mount(target, prepared.options, config);
    else owner.update(target, prepared.options, config);
  }

  let latest = null;
  const stop = watch(
    () => {
      const mounted = slot.mounted || readiness.value > 0;
      latest = readRequest(
        targetRef,
        optionsOrRef,
        configOrRef,
        mounted,
      );
      return latest;
    },
    (request) => {
      latest = request;
      if (slot.mounted) applyRequest(request);
    },
    { flush: 'post' },
  );

  onMounted(() => {
    slot.mounted = true;
    if (latest === null) return;
    if (latest.prepared === null) readiness.value += 1;
    else applyRequest(latest);
  });

  onBeforeUnmount(() => {
    slot.mounted = false;
    stop();
    const owner = slot.owner;
    slot.owner = null;
    slot.onError = undefined;
    slot.request = null;
    owner?.destroy();
  });

  return controller;
}
