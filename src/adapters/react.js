import {
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';

import { annotate } from '../annotation.js';
import { createAdapterOwner } from './lifecycle.js';

const useBrowserLayoutEffect = typeof window === 'undefined'
  ? useEffect
  : useLayoutEffect;

function createControllerSlot() {
  let current = null;
  return {
    expose(controller) {
      current = controller;
    },
    owner: null,
    ref: Object.freeze({
      get current() {
        return current;
      },
    }),
  };
}

export function useAnnotation(targetRef, options, config = {}) {
  const slotRef = useRef(null);
  const optionsRef = useRef(options);
  const configRef = useRef(config);
  optionsRef.current = options;
  configRef.current = config;

  if (slotRef.current === null) {
    slotRef.current = createControllerSlot();
  }
  const slot = slotRef.current;

  useBrowserLayoutEffect(() => {
    const owner = createAdapterOwner({
      create: annotate,
      expose(controller) {
        slot.expose(controller);
      },
    });
    slot.owner = owner;
    owner.mount(targetRef.current, optionsRef.current, configRef.current);

    return () => {
      if (slot.owner === owner) slot.owner = null;
      owner.destroy();
    };
  }, []);

  useBrowserLayoutEffect(() => {
    slot.owner?.update(targetRef.current, options, config);
  });

  return slot.ref;
}
