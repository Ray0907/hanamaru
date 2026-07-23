import assert from 'node:assert/strict';
import test from 'node:test';

import { reduceInspector } from '../../demo/inspector-state.js';

const CLOSED = Object.freeze({ state: 'closed', transient: null });

function transition(model, event, state, effects) {
  const result = reduceInspector(model, event);
  assert.equal(result.model.state, state);
  assert.deepEqual(result.effects, effects);
  return result.model;
}

test('open enters idle and schedules the exact entry effects', () => {
  const model = transition(CLOSED, { type: 'open', invoker: 'open-button' }, 'idle', [
    'capture-invoker',
    'mount',
    'attach-listeners',
    'focus-exit',
  ]);

  assert.equal(model.transient, null);
});

test('valid selection enters selected without mutating native Selection', () => {
  const range = { id: 'plain-range-token' };
  const model = transition(
    { state: 'idle', transient: null },
    { type: 'valid-selection', range },
    'selected',
    ['clone-selection', 'show-toolbar'],
  );

  assert.equal(model.transient, null);
  assert.ok(!['clone-selection', 'show-toolbar'].includes('mutate-native-selection'));
});

test('invalid selection returns selected Inspector to idle', () => {
  transition(
    { state: 'selected', transient: null },
    { type: 'invalid-selection' },
    'idle',
    ['clear-selection', 'hide-toolbar'],
  );
});

for (const state of ['idle', 'selected', 'editing', 'applied']) {
  test(`close leaves ${state} in the exact teardown order`, () => {
    transition({ state, transient: null }, { type: 'close' }, 'closed', [
      'destroy-owned',
      'close-layers',
      'remove-listeners',
      'unmount',
      'focus-connected-invoker',
    ]);
  });

  test(`navigation leaves ${state} in the exact teardown order`, () => {
    transition({ state, transient: null }, { type: 'navigation' }, 'closed', [
      'destroy-owned',
      'close-layers',
      'remove-listeners',
      'unmount',
      'focus-connected-invoker',
    ]);
  });

  test(`Escape without a transient leaves ${state} in the exact teardown order`, () => {
    transition({ state, transient: null }, { type: 'escape' }, 'closed', [
      'destroy-owned',
      'close-layers',
      'remove-listeners',
      'unmount',
      'focus-connected-invoker',
    ]);
  });
}

test('repeated open and close inputs are reference-idempotent', () => {
  const idle = { state: 'idle', transient: null };
  const repeatedOpen = reduceInspector(idle, { type: 'open', invoker: 'other-button' });
  assert.equal(repeatedOpen.model, idle);
  assert.deepEqual(repeatedOpen.effects, []);

  const repeatedClose = reduceInspector(CLOSED, { type: 'close' });
  assert.equal(repeatedClose.model, CLOSED);
  assert.deepEqual(repeatedClose.effects, []);
});

test('unknown state events preserve the same model reference', () => {
  const model = { state: 'selected', transient: null };
  const result = reduceInspector(model, { type: 'not-an-inspector-event' });

  assert.equal(result.model, model);
  assert.deepEqual(result.effects, []);
});

test('choosing a mark enters editing and creates one preview', () => {
  const model = transition(
    { state: 'selected', transient: null, mark: null, options: {} },
    { type: 'choose-mark', mark: 'circle' },
    'editing',
    ['create-preview', 'show-output'],
  );

  assert.equal(model.mark, 'circle');
});

test('editing can change mark and atomically refresh its output', () => {
  const model = transition(
    { state: 'editing', transient: null, mark: 'circle', options: {} },
    { type: 'change-mark', mark: 'highlight' },
    'editing',
    ['update-preview', 'refresh-output'],
  );

  assert.equal(model.mark, 'highlight');
});

test('editing can apply a valid advanced option and refresh its output', () => {
  const options = { placement: 'auto' };
  const model = transition(
    { state: 'editing', transient: null, mark: 'underline', options },
    { type: 'valid-option', name: 'duration', value: 420 },
    'editing',
    ['update-preview', 'refresh-output'],
  );

  assert.deepEqual(model.options, { placement: 'auto', duration: 420 });
  assert.notEqual(model.options, options);
});

test('editing Add Note opens one note transient and focuses it', () => {
  const model = transition(
    { state: 'editing', transient: null, mark: 'underline', options: {} },
    { type: 'add-note', opener: 'add-note-button' },
    'editing',
    ['open-note', 'focus-note'],
  );

  assert.deepEqual(model.transient, { kind: 'note', opener: 'add-note-button' });
});

test('editing Apply commits the preview as the applied controller', () => {
  transition(
    { state: 'editing', transient: null, mark: 'underline', options: {} },
    { type: 'apply' },
    'applied',
    ['commit-preview', 'refresh-output'],
  );
});

test('editing Cancel destroys only the preview and retains the cloned Range', () => {
  transition(
    { state: 'editing', transient: null, mark: 'underline', options: {} },
    { type: 'cancel' },
    'selected',
    ['destroy-owned', 'retain-range', 'hide-output'],
  );
});

test('applied Edit reuses the same controller', () => {
  transition(
    { state: 'applied', transient: null, mark: 'underline', options: {} },
    { type: 'edit' },
    'editing',
    ['reuse-controller', 'focus-first-editor'],
  );
});

test('applied new selection validates its clone before destroying the controller', () => {
  const effects = [
    'clone-selection',
    'validate-clone',
    'destroy-owned',
    'replace-range',
    'show-toolbar',
  ];
  const model = transition(
    { state: 'applied', transient: null, mark: 'underline', options: {} },
    { type: 'new-valid-selection', range: { id: 'next-range' } },
    'selected',
    effects,
  );

  assert.ok(effects.indexOf('clone-selection') < effects.indexOf('destroy-owned'));
  assert.ok(effects.indexOf('validate-clone') < effects.indexOf('destroy-owned'));
  assert.equal(model.mark, 'underline');
});

test('repeated self-transition editing inputs are reference-idempotent', () => {
  const model = {
    state: 'editing',
    transient: { kind: 'note', opener: 'add-note-button' },
    mark: 'highlight',
    options: { duration: 420 },
  };

  for (const event of [
    { type: 'change-mark', mark: 'highlight' },
    { type: 'valid-option', name: 'duration', value: 420 },
    { type: 'add-note', opener: 'another-button' },
  ]) {
    const result = reduceInspector(model, event);
    assert.equal(result.model, model);
    assert.deepEqual(result.effects, []);
  }
});

for (const kind of ['note', 'palette']) {
  test(`Escape closes only the topmost ${kind} transient and focuses its opener`, () => {
    const open = {
      state: 'editing',
      transient: { kind, opener: `${kind}-button` },
      mark: 'highlight',
      options: {},
    };
    const firstEscape = reduceInspector(open, { type: 'escape' });

    assert.notEqual(firstEscape.model, open);
    assert.equal(firstEscape.model.state, 'editing');
    assert.equal(firstEscape.model.transient, null);
    assert.deepEqual(firstEscape.effects, ['close-transient', 'focus-transient-opener']);

    const secondEscape = reduceInspector(firstEscape.model, { type: 'escape' });
    assert.equal(secondEscape.model.state, 'closed');
    assert.deepEqual(secondEscape.effects, [
      'destroy-owned',
      'close-layers',
      'remove-listeners',
      'unmount',
      'focus-connected-invoker',
    ]);
  });
}

test('open palette tracks its plain opener without changing the Inspector state', () => {
  const selected = { state: 'selected', transient: null, mark: null, options: {} };
  const opened = reduceInspector(selected, { type: 'open-palette', opener: 'shortcut' });

  assert.equal(opened.model.state, 'selected');
  assert.deepEqual(opened.model.transient, { kind: 'palette', opener: 'shortcut' });
  assert.deepEqual(opened.effects, ['open-palette', 'focus-palette']);

  const repeated = reduceInspector(opened.model, {
    type: 'open-palette',
    opener: 'other-opener',
  });
  assert.equal(repeated.model, opened.model);
  assert.deepEqual(repeated.effects, []);
});

test('a second transient cannot replace the topmost transient', () => {
  const model = {
    state: 'editing',
    transient: { kind: 'palette', opener: 'shortcut' },
    mark: 'underline',
    options: {},
  };
  const result = reduceInspector(model, { type: 'add-note', opener: 'add-note-button' });

  assert.equal(result.model, model);
  assert.deepEqual(result.effects, []);
});
