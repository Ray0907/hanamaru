import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInspectorEffectContext,
  reduceInspector,
} from '../../demo/inspector-state.js';

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
  const previous = { state: 'idle', transient: null };
  const event = { type: 'valid-selection', range };
  const result = reduceInspector(previous, event);

  assert.equal(result.model.state, 'selected');
  assert.equal(result.model.transient, null);
  assert.ok(!Object.hasOwn(result.model, 'range'));
  assert.deepEqual(result.effects, ['clone-selection', 'show-toolbar']);
  assert.ok(result.effects.every((effect) => !effect.includes('native-selection')));
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
  const result = reduceInspector(
    { state: 'applied', transient: null, mark: 'underline', options: {} },
    { type: 'new-valid-selection', range: { id: 'next-range' } },
  );

  assert.equal(result.model.state, 'selected');
  assert.deepEqual(result.effects, [
    'clone-selection',
    'validate-clone',
    'destroy-owned',
    'replace-range',
    'show-toolbar',
  ]);
  assert.ok(
    result.effects.indexOf('clone-selection') < result.effects.indexOf('destroy-owned'),
  );
  assert.ok(
    result.effects.indexOf('validate-clone') < result.effects.indexOf('destroy-owned'),
  );
  assert.equal(result.model.mark, 'underline');
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

const OPEN_STATES = ['idle', 'selected', 'editing', 'applied'];
const UNDERLYING_EVENTS = [
  { type: 'open', invoker: 'open-button' },
  { type: 'valid-selection', range: { id: 'range' } },
  { type: 'invalid-selection' },
  { type: 'choose-mark', mark: 'circle' },
  { type: 'change-mark', mark: 'circle' },
  { type: 'valid-option', name: 'placement', value: 'right' },
  { type: 'add-note', opener: 'add-note-button' },
  { type: 'open-palette', opener: 'shortcut' },
  { type: 'apply' },
  { type: 'cancel' },
  { type: 'edit' },
  { type: 'new-valid-selection', range: { id: 'new-range' } },
];

for (const kind of ['note', 'palette']) {
  for (const state of OPEN_STATES) {
    for (const event of UNDERLYING_EVENTS) {
      test(`${kind} transient gates ${event.type} while Inspector is ${state}`, () => {
        const model = {
          state,
          transient: { kind, opener: `${kind}-button` },
          mark: 'underline',
          options: { placement: 'auto' },
        };
        const result = reduceInspector(model, event);

        assert.equal(result.model, model);
        assert.deepEqual(result.effects, []);
      });
    }
  }
}

for (const kind of ['note', 'palette']) {
  for (const state of OPEN_STATES) {
    for (const type of ['close', 'navigation']) {
      test(`${type} tears down ${state} Inspector with a ${kind} transient`, () => {
        const previous = {
          state,
          transient: { kind, opener: `${kind}-button` },
          mark: 'underline',
          options: {},
        };
        const result = reduceInspector(previous, { type });

        assert.equal(result.model.state, 'closed');
        assert.equal(result.model.transient, null);
        assert.deepEqual(result.effects, [
          'destroy-owned',
          'close-layers',
          'remove-listeners',
          'unmount',
          'focus-connected-invoker',
        ]);
      });
    }
  }
}

test('effect context keeps open invoker payload beside the exact reducer result', () => {
  const previous = CLOSED;
  const event = { type: 'open', invoker: 'open-button' };
  const result = reduceInspector(previous, event);
  const context = createInspectorEffectContext(previous, event, result);

  assert.equal(context.previous, previous);
  assert.equal(context.event, event);
  assert.equal(context.event.invoker, 'open-button');
  assert.equal(context.next, result.model);
  assert.deepEqual(context.effects, [
    'capture-invoker',
    'mount',
    'attach-listeners',
    'focus-exit',
  ]);
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.effects));
});

test('effect context keeps the valid Range token in the event, not the next model', () => {
  const previous = { state: 'idle', transient: null };
  const range = { id: 'range-token' };
  const event = { type: 'valid-selection', range };
  const result = reduceInspector(previous, event);
  const context = createInspectorEffectContext(previous, event, result);

  assert.equal(context.event.range, range);
  assert.ok(!Object.hasOwn(context.next, 'range'));
  assert.deepEqual(context.effects, ['clone-selection', 'show-toolbar']);
});

test('effect context keeps the transient opener in previous during Escape', () => {
  const previous = {
    state: 'editing',
    transient: { kind: 'note', opener: 'add-note-button' },
    mark: 'underline',
    options: {},
  };
  const event = { type: 'escape' };
  const result = reduceInspector(previous, event);
  const context = createInspectorEffectContext(previous, event, result);

  assert.equal(context.previous.transient.opener, 'add-note-button');
  assert.equal(context.next.transient, null);
  assert.deepEqual(context.effects, ['close-transient', 'focus-transient-opener']);
});

test('effect context rejects malformed reducer inputs and results', () => {
  const previous = { state: 'idle', transient: null };
  const event = { type: 'escape' };
  const result = reduceInspector(previous, event);

  for (const args of [
    [null, event, result],
    [previous, null, result],
    [previous, event, null],
    [previous, event, { model: null, effects: [] }],
    [previous, event, { model: previous, effects: 'mount' }],
    [previous, event, { model: previous, effects: [''] }],
  ]) {
    assert.throws(() => createInspectorEffectContext(...args), TypeError);
  }
});

function assertRejected(model, event) {
  const result = reduceInspector(model, event);
  assert.equal(result.model, model);
  assert.deepEqual(result.effects, []);
}

test('open and transient events reject missing or malformed string tokens', () => {
  for (const token of [undefined, null, '', '   ', 0, {}, Symbol('token')]) {
    assertRejected(CLOSED, { type: 'open', invoker: token });
    assertRejected(
      { state: 'selected', transient: null },
      { type: 'open-palette', opener: token },
    );
    assertRejected(
      { state: 'editing', transient: null },
      { type: 'add-note', opener: token },
    );
  }
});

test('selection transitions reject missing or null Range tokens', () => {
  for (const range of [undefined, null]) {
    assertRejected(
      { state: 'idle', transient: null },
      { type: 'valid-selection', range },
    );
    assertRejected(
      { state: 'applied', transient: null },
      { type: 'new-valid-selection', range },
    );
  }
});

test('mark transitions accept plugin names but reject malformed mark values', () => {
  const selected = { state: 'selected', transient: null, mark: null, options: {} };
  const plugin = reduceInspector(selected, {
    type: 'choose-mark',
    mark: 'hanamaru-flower',
  });
  assert.equal(plugin.model.mark, 'hanamaru-flower');

  for (const mark of [undefined, null, '', '  ', 0, {}, Symbol('mark')]) {
    assertRejected(selected, { type: 'choose-mark', mark });
    assertRejected(
      { state: 'editing', transient: null, mark: 'underline', options: {} },
      { type: 'change-mark', mark },
    );
  }
});

test('advanced options accept only their exact public domains', () => {
  const model = {
    state: 'editing',
    transient: null,
    mark: 'underline',
    options: {},
  };
  const accepted = [
    ['placement', 'auto'],
    ['placement', 'top'],
    ['placement', 'right'],
    ['placement', 'bottom'],
    ['placement', 'left'],
    ['accessible', true],
    ['accessible', false],
    ['duration', 0],
    ['duration', 650],
    ['motion', 'system'],
    ['motion', 'never'],
    ['seed', ''],
    ['seed', 'stable-seed'],
  ];

  for (const [name, value] of accepted) {
    const result = reduceInspector(model, { type: 'valid-option', name, value });
    assert.deepEqual(result.effects, ['update-preview', 'refresh-output']);
    assert.equal(result.model.options[name], value);
  }

  const rejected = [
    ['placement', 'start'],
    ['accessible', 1],
    ['duration', -1],
    ['duration', 1.5],
    ['duration', '650'],
    ['motion', 'always'],
    ['seed', 1],
    ['unknown', 'value'],
    [undefined, 'value'],
  ];
  for (const [name, value] of rejected) {
    assertRejected(model, { type: 'valid-option', name, value });
  }
});

test('hostile event payload access is contained as an idempotent rejection', () => {
  const hostile = new Proxy({}, {
    get() {
      throw new Error('payload trap');
    },
  });

  assert.doesNotThrow(() => assertRejected(CLOSED, hostile));
  assert.doesNotThrow(() => assertRejected(
    { state: 'editing', transient: null, mark: 'underline', options: {} },
    {
      type: 'valid-option',
      name: 'duration',
      get value() {
        throw new Error('value getter');
      },
    },
  ));
});
