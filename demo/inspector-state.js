const CLOSE_EFFECTS = Object.freeze([
  'destroy-owned',
  'close-layers',
  'remove-listeners',
  'unmount',
  'focus-connected-invoker',
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

export function reduceInspector(model, event) {
  const type = event?.type;

  switch (model?.state) {
    case 'closed':
      if (type === 'open') {
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
        return changed(model, 'selected', ['clone-selection', 'show-toolbar']);
      }
      break;

    case 'selected':
      if (type === 'invalid-selection') {
        return changed(model, 'idle', ['clear-selection', 'hide-toolbar']);
      }
      if (type === 'choose-mark') {
        return changed(
          model,
          'editing',
          ['create-preview', 'show-output'],
          { mark: event.mark },
        );
      }
      break;

    case 'editing': {
      if (type === 'change-mark') {
        if (Object.is(model.mark, event.mark)) return unchanged(model);
        return changed(
          model,
          'editing',
          ['update-preview', 'refresh-output'],
          { mark: event.mark },
        );
      }

      if (type === 'valid-option') {
        if (Object.is(model.options?.[event.name], event.value)) return unchanged(model);
        return changed(
          model,
          'editing',
          ['update-preview', 'refresh-output'],
          { options: { ...model.options, [event.name]: event.value } },
        );
      }

      if (type === 'add-note') {
        if (model.transient != null) return unchanged(model);
        return changed(
          model,
          'editing',
          ['open-note', 'focus-note'],
          { transient: { kind: 'note', opener: event.opener } },
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
    return changed(
      model,
      model.state,
      ['open-palette', 'focus-palette'],
      { transient: { kind: 'palette', opener: event.opener } },
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
