const CLOSE_EFFECTS = Object.freeze([
  'destroy-owned',
  'close-layers',
  'remove-listeners',
  'unmount',
  'focus-connected-invoker',
]);

const PLACEMENTS = Object.freeze(new Set(['auto', 'top', 'right', 'bottom', 'left']));
const MOTIONS = Object.freeze(new Set(['system', 'never']));
const OPTION_NAMES = Object.freeze([
  'placement',
  'accessible',
  'duration',
  'motion',
  'seed',
]);

function unchanged(model) {
  return { model, effects: [] };
}

function changed(model, state, effects, changes = {}) {
  return {
    model: { ...model, ...changes, state },
    effects: [...effects],
  };
}

function recordStatus(value) {
  try {
    return {
      ok: true,
      isRecord: typeof value === 'object' && value !== null && !Array.isArray(value),
    };
  } catch {
    return { ok: false, isRecord: false };
  }
}

function isRecord(value) {
  return recordStatus(value).isRecord;
}

function readField(record, name) {
  try {
    return { ok: true, value: record?.[name] };
  } catch {
    return { ok: false, value: undefined };
  }
}

function isOpaqueControlToken(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function isTransientOpen(model) {
  return model?.transient?.kind === 'note' || model?.transient?.kind === 'palette';
}

function snapshotOptions(options) {
  if (options == null) return { ok: true, value: {} };
  const status = recordStatus(options);
  if (!status.ok || !status.isRecord) return { ok: false, value: {} };

  const value = {};
  for (const name of OPTION_NAMES) {
    const field = readField(options, name);
    if (!field.ok) return { ok: false, value: {} };
    if (field.value !== undefined) value[name] = field.value;
  }
  return { ok: true, value };
}

function snapshotTransient(transient) {
  if (transient == null) return { ok: true, value: null };
  const status = recordStatus(transient);
  if (!status.ok) return { ok: false, value: null };
  if (!status.isRecord) return { ok: true, value: null };

  const kind = readField(transient, 'kind');
  if (!kind.ok) return { ok: false, value: null };
  if (kind.value !== 'note' && kind.value !== 'palette') {
    return { ok: true, value: null };
  }

  const opener = readField(transient, 'opener');
  if (!opener.ok) return { ok: false, value: null };
  if (!isOpaqueControlToken(opener.value)) return { ok: true, value: null };

  return {
    ok: true,
    value: { kind: kind.value, opener: opener.value },
  };
}

function snapshotModel(model) {
  const state = readField(model, 'state');
  if (!state.ok) {
    return {
      ok: false,
      stateOk: false,
      value: { state: undefined, transient: null, mark: undefined, options: {} },
    };
  }

  const transient = readField(model, 'transient');
  const mark = readField(model, 'mark');
  const options = readField(model, 'options');
  const transientSnapshot = transient.ok
    ? snapshotTransient(transient.value)
    : { ok: false, value: null };
  const optionsSnapshot = options.ok
    ? snapshotOptions(options.value)
    : { ok: false, value: {} };

  return {
    ok: transient.ok
      && mark.ok
      && options.ok
      && transientSnapshot.ok
      && optionsSnapshot.ok,
    stateOk: true,
    value: {
      state: state.value,
      transient: transientSnapshot.value,
      mark: mark.value,
      options: optionsSnapshot.value,
    },
  };
}

function isValidOption(name, value) {
  switch (name) {
    case 'placement':
      return PLACEMENTS.has(value);
    case 'accessible':
      return typeof value === 'boolean';
    case 'duration':
      return Number.isInteger(value) && value >= 0;
    case 'motion':
      return MOTIONS.has(value);
    case 'seed':
      return typeof value === 'string';
    default:
      return false;
  }
}

/**
 * Build the immutable input available to an Inspector effect interpreter.
 *
 * Transition payloads such as invoker and Range tokens live on `event`; a
 * transient opener needed during teardown lives on `previous`. Reducer-owned
 * state after the transition is exposed as `next`.
 */
export function createInspectorEffectContext(previous, event, result) {
  if (!isRecord(previous) || !isRecord(event) || !isRecord(result)) {
    throw new TypeError('Inspector effect context requires model, event, and result records');
  }

  let next;
  let effects;
  try {
    next = result.model;
    effects = result.effects;
    if (
      !isRecord(next)
      || !Array.isArray(effects)
      || !effects.every((effect) => typeof effect === 'string' && effect.length > 0)
    ) {
      throw new TypeError('Inspector reducer result must contain a model and effect tokens');
    }
    effects = Object.freeze([...effects]);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Inspector reducer result cannot be inspected', { cause: error });
  }

  return Object.freeze({ previous, event, next, effects });
}

export function reduceInspector(model, event) {
  const typeField = readField(event, 'type');
  if (!typeField.ok || typeof typeField.value !== 'string') return unchanged(model);
  const type = typeField.value;
  const snapshot = snapshotModel(model);
  if (!snapshot.stateOk) return unchanged(model);
  const current = snapshot.value;
  const isOpen = (
    current.state === 'idle'
    || current.state === 'selected'
    || current.state === 'editing'
    || current.state === 'applied'
  );

  if (!snapshot.ok) {
    if (
      isOpen
      && (type === 'escape' || type === 'close' || type === 'navigation')
    ) {
      return {
        model: { ...current, state: 'closed', transient: null },
        effects: [...CLOSE_EFFECTS],
      };
    }
    return unchanged(model);
  }

  if (
    isTransientOpen(current)
    && type !== 'escape'
    && type !== 'close'
    && type !== 'navigation'
  ) {
    return unchanged(model);
  }

  switch (current.state) {
    case 'closed':
      if (type === 'open') {
        const invoker = readField(event, 'invoker');
        if (!invoker.ok || !isOpaqueControlToken(invoker.value)) return unchanged(model);
        return changed(current, 'idle', [
          'capture-invoker',
          'mount',
          'attach-listeners',
          'focus-exit',
        ]);
      }
      return unchanged(model);

    case 'idle':
      if (type === 'valid-selection') {
        const range = readField(event, 'range');
        if (!range.ok || range.value == null) return unchanged(model);
        return changed(current, 'selected', ['clone-selection', 'show-toolbar']);
      }
      break;

    case 'selected':
      if (type === 'invalid-selection') {
        return changed(current, 'idle', ['clear-selection', 'hide-toolbar']);
      }
      if (type === 'choose-mark') {
        const mark = readField(event, 'mark');
        if (!mark.ok || typeof mark.value !== 'string' || mark.value.trim().length === 0) {
          return unchanged(model);
        }
        return changed(
          current,
          'editing',
          ['create-preview', 'show-output'],
          { mark: mark.value },
        );
      }
      break;

    case 'editing': {
      if (type === 'change-mark') {
        const mark = readField(event, 'mark');
        if (
          !mark.ok
          || typeof mark.value !== 'string'
          || mark.value.trim().length === 0
          || Object.is(current.mark, mark.value)
        ) {
          return unchanged(model);
        }
        return changed(
          current,
          'editing',
          ['update-preview', 'refresh-output'],
          { mark: mark.value },
        );
      }

      if (type === 'valid-option') {
        const name = readField(event, 'name');
        const value = readField(event, 'value');
        if (
          !name.ok
          || !value.ok
          || !isValidOption(name.value, value.value)
          || Object.is(current.options[name.value], value.value)
        ) {
          return unchanged(model);
        }
        return changed(
          current,
          'editing',
          ['update-preview', 'refresh-output'],
          { options: { ...current.options, [name.value]: value.value } },
        );
      }

      if (type === 'add-note') {
        if (current.transient != null) return unchanged(model);
        const opener = readField(event, 'opener');
        if (!opener.ok || !isOpaqueControlToken(opener.value)) return unchanged(model);
        return changed(
          current,
          'editing',
          ['open-note', 'focus-note'],
          { transient: { kind: 'note', opener: opener.value } },
        );
      }

      if (type === 'apply') {
        return changed(current, 'applied', ['commit-preview', 'refresh-output']);
      }

      if (type === 'cancel') {
        return changed(current, 'selected', ['destroy-owned', 'retain-range', 'hide-output']);
      }
      break;
    }

    case 'applied':
      if (type === 'edit') {
        return changed(current, 'editing', ['reuse-controller', 'focus-first-editor']);
      }

      if (type === 'new-valid-selection') {
        const range = readField(event, 'range');
        if (!range.ok || range.value == null) return unchanged(model);
        return changed(current, 'selected', [
          'clone-selection',
          'validate-clone',
          'destroy-owned',
          'replace-range',
          'show-toolbar',
        ]);
      }
      break;

    default:
      return unchanged(model);
  }

  if (type === 'open-palette') {
    if (current.transient != null) return unchanged(model);
    const opener = readField(event, 'opener');
    if (!opener.ok || !isOpaqueControlToken(opener.value)) return unchanged(model);
    return changed(
      current,
      current.state,
      ['open-palette', 'focus-palette'],
      { transient: { kind: 'palette', opener: opener.value } },
    );
  }

  if (
    type === 'escape'
    && isTransientOpen(current)
  ) {
    return changed(
      current,
      current.state,
      ['close-transient', 'focus-transient-opener'],
      { transient: null },
    );
  }

  if (type === 'close' || type === 'navigation' || (type === 'escape' && current.transient == null)) {
    return {
      model: { ...current, state: 'closed', transient: null },
      effects: [...CLOSE_EFFECTS],
    };
  }

  return unchanged(model);
}
