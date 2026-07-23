export const runtimeState = {
  plugins: new Map(),
  metadata: new WeakMap(),
  documents: new WeakMap(),
  shadows: new WeakMap(),
};

const SHADOW_SLOTS = new Set(['styles', 'resources']);

function assertWeakKey(root) {
  if ((typeof root !== 'object' || root === null) && typeof root !== 'function') {
    throw new TypeError('Shadow root state key must be an object');
  }
}

function assertSlot(slot) {
  if (!SHADOW_SLOTS.has(slot)) {
    throw new TypeError('Unknown Shadow root state slot');
  }
}

export function getShadowRootState(root) {
  assertWeakKey(root);
  let state = runtimeState.shadows.get(root);
  if (state === undefined) {
    state = { styles: null, resources: null };
    runtimeState.shadows.set(root, state);
  }
  return state;
}

export function claimShadowRootSlot(root, slot, record) {
  assertSlot(slot);
  if ((typeof record !== 'object' || record === null) && typeof record !== 'function') {
    throw new TypeError(`Shadow root ${slot} record must be an object`);
  }
  const state = getShadowRootState(root);
  if (state[slot] !== null) {
    throw new TypeError(`Shadow root ${slot} slot is already claimed`);
  }
  state[slot] = record;
  return state;
}

export function releaseShadowRootSlot(root, slot, record) {
  assertSlot(slot);
  const state = runtimeState.shadows.get(root);
  if (state === undefined || state[slot] !== record || record === null) {
    return false;
  }
  state[slot] = null;
  if (state.styles === null && state.resources === null) {
    runtimeState.shadows.delete(root);
  }
  return true;
}
