import {
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';

import { annotate } from '../annotation.js';
import {
  createAdapterOwner,
  prepareAdapterRequest,
} from './lifecycle.js';

const useBrowserLayoutEffect = typeof window === 'undefined'
  ? useEffect
  : useLayoutEffect;

function createControllerSlot() {
  let current = null;
  const slot = {
    expose(controller) {
      current = controller;
    },
    handleError(error, controller) {
      return slot.onError?.(error, controller);
    },
    onError: undefined,
    owner: null,
    ref: Object.freeze({
      get current() {
        return current;
      },
    }),
    request: null,
  };
  return slot;
}

function sameRequest(previous, target, canonical, enabled) {
  return previous !== null
    && previous.target === target
    && previous.enabled === enabled
    && previous.canonical.length === canonical.length
    && previous.canonical.every(
      (value, index) => Object.is(value, canonical[index]),
    );
}

export function useAnnotation(targetRef, options, config = {}) {
  const slotRef = useRef(null);
  if (slotRef.current === null) {
    slotRef.current = createControllerSlot();
  }
  const slot = slotRef.current;

  useBrowserLayoutEffect(() => {
    const prepared = prepareAdapterRequest(options, config);
    const target = targetRef.current;
    slot.onError = prepared.config.onError;
    if (sameRequest(
      slot.request,
      target,
      prepared.canonical,
      prepared.config.enabled,
    )) {
      return;
    }
    slot.request = Object.freeze({
      canonical: prepared.canonical,
      enabled: prepared.config.enabled,
      target,
    });

    const owner = slot.owner ?? createAdapterOwner({
      create: annotate,
      expose(controller) {
        slot.expose(controller);
      },
    });
    const initial = slot.owner === null;
    slot.owner = owner;
    const ownerConfig = {
      enabled: prepared.config.enabled,
      onError: slot.handleError,
    };
    if (initial) owner.mount(target, prepared.options, ownerConfig);
    else owner.update(target, prepared.options, ownerConfig);
  });

  useBrowserLayoutEffect(() => (
    () => {
      const owner = slot.owner;
      slot.owner = null;
      slot.onError = undefined;
      slot.request = null;
      owner?.destroy();
    }
  ), []);

  return slot.ref;
}
