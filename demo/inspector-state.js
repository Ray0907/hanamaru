const CLOSE_EFFECTS = Object.freeze([
  'destroy-owned',
  'close-layers',
  'remove-listeners',
  'unmount',
  'focus-connected-invoker',
]);

const PLACEMENTS = Object.freeze(new Set(['auto', 'top', 'right', 'bottom', 'left']));
const MOTIONS = Object.freeze(new Set(['system', 'never']));

function unchanged(model) {
  return { model, effects: [] };
}

function changed(model, state, effects, changes = {}) {
  return {
    model: { ...model, ...changes, state },
    effects: [...effects],
  };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readField(record, name) {
  try {
    return { ok: true, value: record?.[name] };
  } catch {
    return { ok: false, value: undefined };
  }
}

function isStringToken(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTransientOpen(model) {
  return model?.transient?.kind === 'note' || model?.transient?.kind === 'palette';
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

  if (
    isTransientOpen(model)
    && type !== 'escape'
    && type !== 'close'
    && type !== 'navigation'
  ) {
    return unchanged(model);
  }

  switch (model?.state) {
    case 'closed':
      if (type === 'open') {
        const invoker = readField(event, 'invoker');
        if (!invoker.ok || !isStringToken(invoker.value)) return unchanged(model);
        return changed(model, 'idle', [
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
        return changed(model, 'selected', ['clone-selection', 'show-toolbar']);
      }
      break;

    case 'selected':
      if (type === 'invalid-selection') {
        return changed(model, 'idle', ['clear-selection', 'hide-toolbar']);
      }
      if (type === 'choose-mark') {
        const mark = readField(event, 'mark');
        if (!mark.ok || !isStringToken(mark.value)) return unchanged(model);
        return changed(
          model,
          'editing',
          ['create-preview', 'show-output'],
          { mark: mark.value },
        );
      }
      break;

    case 'editing': {
      if (type === 'change-mark') {
        const mark = readField(event, 'mark');
        if (!mark.ok || !isStringToken(mark.value) || Object.is(model.mark, mark.value)) {
          return unchanged(model);
        }
        return changed(
          model,
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
          || Object.is(model.options?.[name.value], value.value)
        ) {
          return unchanged(model);
        }
        return changed(
          model,
          'editing',
          ['update-preview', 'refresh-output'],
          { options: { ...model.options, [name.value]: value.value } },
        );
      }

      if (type === 'add-note') {
        if (model.transient != null) return unchanged(model);
        const opener = readField(event, 'opener');
        if (!opener.ok || !isStringToken(opener.value)) return unchanged(model);
        return changed(
          model,
          'editing',
          ['open-note', 'focus-note'],
          { transient: { kind: 'note', opener: opener.value } },
        );
      }

      if (type === 'apply') {
        return changed(model, 'applied', ['commit-preview', 'refresh-output']);
      }

      if (type === 'cancel') {
        return changed(model, 'selected', ['destroy-owned', 'retain-range', 'hide-output']);
      }
      break;
    }

    case 'applied':
      if (type === 'edit') {
        return changed(model, 'editing', ['reuse-controller', 'focus-first-editor']);
      }

      if (type === 'new-valid-selection') {
        const range = readField(event, 'range');
        if (!range.ok || range.value == null) return unchanged(model);
        return changed(model, 'selected', [
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
    if (model.transient != null) return unchanged(model);
    const opener = readField(event, 'opener');
    if (!opener.ok || !isStringToken(opener.value)) return unchanged(model);
    return changed(
      model,
      model.state,
      ['open-palette', 'focus-palette'],
      { transient: { kind: 'palette', opener: opener.value } },
    );
  }

  if (
    type === 'escape'
    && (model.transient?.kind === 'note' || model.transient?.kind === 'palette')
  ) {
    return changed(
      model,
      model.state,
      ['close-transient', 'focus-transient-opener'],
      { transient: null },
    );
  }

  if (type === 'close' || type === 'navigation' || (type === 'escape' && model.transient == null)) {
    return {
      model: { ...model, state: 'closed', transient: null },
      effects: [...CLOSE_EFFECTS],
    };
  }

  return unchanged(model);
}
