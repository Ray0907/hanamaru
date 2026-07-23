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
const EFFECT_CONTEXTS = new WeakMap();

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

function hasOwnField(record, name) {
  try {
    return { ok: true, value: Object.hasOwn(record, name) };
  } catch {
    return { ok: false, value: false };
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
    const present = hasOwnField(options, name);
    if (!present.ok) return { ok: false, value: {} };
    if (!present.value) continue;
    if (!isValidOption(name, field.value)) return { ok: false, value: {} };
    value[name] = field.value;
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
  if (state.value === 'closed') {
    return {
      ok: true,
      stateOk: true,
      value: { state: 'closed', transient: null, mark: undefined, options: {} },
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

function freezeModelSnapshot(model) {
  const transient = model.transient == null
    ? null
    : Object.freeze({
      kind: model.transient.kind,
      opener: model.transient.opener,
    });
  const options = Object.freeze({ ...model.options });
  return Object.freeze({
    state: model.state,
    transient,
    mark: model.mark,
    options,
  });
}

function registerEffectContext({
  previousInput,
  eventInput,
  previous,
  event,
  next,
  result,
}) {
  const context = Object.freeze({
    previous: freezeModelSnapshot(previous),
    event: Object.freeze({ ...event }),
    next: freezeModelSnapshot(next),
    effects: Object.freeze([...result.effects]),
  });
  EFFECT_CONTEXTS.set(result, { previousInput, eventInput, context });
  return result;
}

/**
 * Build the immutable input available to an Inspector effect interpreter.
 *
 * The context is the semantic snapshot captured by the exact reducer call.
 * Opaque invoker, opener, and Range identities are retained without freezing
 * those host objects; every reducer-owned container is copied and frozen.
 */
export function createInspectorEffectContext(previous, event, result) {
  const stored = isRecord(result) ? EFFECT_CONTEXTS.get(result) : undefined;
  if (
    stored === undefined
    || stored.previousInput !== previous
    || stored.eventInput !== event
  ) {
    throw new TypeError('Inspector effect context requires the exact reducer inputs and result');
  }
  return stored.context;
}

export function reduceInspector(model, event) {
  const typeField = readField(event, 'type');
  const snapshot = snapshotModel(model);
  const current = snapshot.value;
  const eventSnapshot = typeField.ok && typeof typeField.value === 'string'
    ? { type: typeField.value }
    : {};
  const complete = (result, acceptedEvent = eventSnapshot, next = result.model) => (
    registerEffectContext({
      previousInput: model,
      eventInput: event,
      previous: current,
      event: acceptedEvent,
      next,
      result,
    })
  );
  const noChange = (acceptedEvent = eventSnapshot) => (
    complete(unchanged(model), acceptedEvent, current)
  );
  const change = (
    state,
    effects,
    changes = {},
    acceptedEvent = eventSnapshot,
  ) => {
    const result = changed(current, state, effects, changes);
    return complete(result, acceptedEvent, result.model);
  };

  if (!typeField.ok || typeof typeField.value !== 'string') return noChange();
  if (!snapshot.stateOk) return noChange();
  const type = typeField.value;
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
      return change('closed', CLOSE_EFFECTS, { transient: null });
    }
    return noChange();
  }

  if (
    isTransientOpen(current)
    && type !== 'escape'
    && type !== 'close'
    && type !== 'navigation'
  ) {
    return noChange();
  }

  switch (current.state) {
    case 'closed':
      if (type === 'open') {
        const invoker = readField(event, 'invoker');
        if (!invoker.ok || !isOpaqueControlToken(invoker.value)) return noChange();
        return change('idle', [
          'capture-invoker',
          'mount',
          'attach-listeners',
          'focus-exit',
        ], {}, { type, invoker: invoker.value });
      }
      return noChange();

    case 'idle':
      if (type === 'valid-selection') {
        const range = readField(event, 'range');
        if (!range.ok || range.value == null) return noChange();
        return change(
          'selected',
          ['clone-selection', 'show-toolbar'],
          {},
          { type, range: range.value },
        );
      }
      break;

    case 'selected':
      if (type === 'invalid-selection') {
        return change('idle', ['clear-selection', 'hide-toolbar']);
      }
      if (type === 'choose-mark') {
        const mark = readField(event, 'mark');
        if (!mark.ok || typeof mark.value !== 'string' || mark.value.trim().length === 0) {
          return noChange();
        }
        return change(
          'editing',
          ['create-preview', 'show-output'],
          { mark: mark.value },
          { type, mark: mark.value },
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
          return noChange();
        }
        return change(
          'editing',
          ['update-preview', 'refresh-output'],
          { mark: mark.value },
          { type, mark: mark.value },
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
          return noChange();
        }
        return change(
          'editing',
          ['update-preview', 'refresh-output'],
          { options: { ...current.options, [name.value]: value.value } },
          { type, name: name.value, value: value.value },
        );
      }

      if (type === 'add-note') {
        if (current.transient != null) return noChange();
        const opener = readField(event, 'opener');
        if (!opener.ok || !isOpaqueControlToken(opener.value)) return noChange();
        return change(
          'editing',
          ['open-note', 'focus-note'],
          { transient: { kind: 'note', opener: opener.value } },
          { type, opener: opener.value },
        );
      }

      if (type === 'apply') {
        return change('applied', ['commit-preview', 'refresh-output']);
      }

      if (type === 'cancel') {
        return change('selected', ['destroy-owned', 'retain-range', 'hide-output']);
      }
      break;
    }

    case 'applied':
      if (type === 'edit') {
        return change('editing', ['reuse-controller', 'focus-first-editor']);
      }

      if (type === 'new-valid-selection') {
        const range = readField(event, 'range');
        if (!range.ok || range.value == null) return noChange();
        return change(
          'selected',
          [
            'clone-selection',
            'validate-clone',
            'destroy-owned',
            'replace-range',
            'show-toolbar',
          ],
          {},
          { type, range: range.value },
        );
      }
      break;

    default:
      return noChange();
  }

  if (type === 'open-palette') {
    if (current.transient != null) return noChange();
    const opener = readField(event, 'opener');
    if (!opener.ok || !isOpaqueControlToken(opener.value)) return noChange();
    return change(
      current.state,
      ['open-palette', 'focus-palette'],
      { transient: { kind: 'palette', opener: opener.value } },
      { type, opener: opener.value },
    );
  }

  if (
    type === 'escape'
    && isTransientOpen(current)
  ) {
    return change(
      current.state,
      ['close-transient', 'focus-transient-opener'],
      { transient: null },
    );
  }

  if (type === 'close' || type === 'navigation' || (type === 'escape' && current.transient == null)) {
    return change('closed', CLOSE_EFFECTS, { transient: null });
  }

  return noChange();
}
