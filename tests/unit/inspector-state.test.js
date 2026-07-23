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

  assert.notEqual(context.previous, previous);
  assert.notEqual(context.event, event);
  assert.equal(context.event.invoker, 'open-button');
  assert.notEqual(context.next, result.model);
  assert.equal(context.next.state, result.model.state);
  assert.deepEqual(context.effects, [
    'capture-invoker',
    'mount',
    'attach-listeners',
    'focus-exit',
  ]);
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.previous));
  assert.ok(Object.isFrozen(context.event));
  assert.ok(Object.isFrozen(context.next));
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

test('effect context retains the invoker from the reducer read when its getter changes', () => {
  const first = { id: 'first-invoker' };
  const second = { id: 'second-invoker' };
  let reads = 0;
  const event = {
    type: 'open',
    get invoker() {
      reads += 1;
      return reads === 1 ? first : second;
    },
  };
  const result = reduceInspector(CLOSED, event);
  const context = createInspectorEffectContext(CLOSED, event, result);

  assert.equal(reads, 1);
  assert.equal(context.event.invoker, first);
  assert.equal(event.invoker, second);
  assert.equal(context.event.invoker, first);
});

test('effect context retains a transient opener without rereading its getter', () => {
  const opener = { id: 'palette-opener' };
  let openerReads = 0;
  const transient = {
    kind: 'palette',
    get opener() {
      openerReads += 1;
      if (openerReads > 1) throw new Error('opener reread');
      return opener;
    },
  };
  const previous = {
    state: 'selected',
    transient,
    mark: null,
    options: {},
  };
  const event = { type: 'escape' };
  const result = reduceInspector(previous, event);
  const context = createInspectorEffectContext(previous, event, result);

  assert.equal(openerReads, 1);
  assert.equal(context.previous.transient.opener, opener);
  assert.deepEqual(context.effects, ['close-transient', 'focus-transient-opener']);
});

test('effect context is unchanged by later caller event and model mutations', () => {
  const previous = {
    state: 'editing',
    transient: null,
    mark: 'underline',
    options: { placement: 'auto' },
  };
  const event = { type: 'valid-option', name: 'duration', value: 320 };
  const result = reduceInspector(previous, event);
  const context = createInspectorEffectContext(previous, event, result);

  previous.state = 'closed';
  previous.options.placement = 'left';
  event.type = 'close';
  event.name = 'motion';
  event.value = 'never';

  assert.equal(context.previous.state, 'editing');
  assert.deepEqual(context.previous.options, { placement: 'auto' });
  assert.deepEqual(context.event, {
    type: 'valid-option',
    name: 'duration',
    value: 320,
  });
  assert.equal(context.next.state, 'editing');
  assert.deepEqual(context.next.options, { placement: 'auto', duration: 320 });
  assert.ok(Object.isFrozen(context.previous.options));
  assert.ok(Object.isFrozen(context.next.options));
});

test('only exact reducer results can create effect contexts without public metadata', () => {
  const previous = { state: 'idle', transient: null };
  const event = { type: 'valid-selection', range: { id: 'range' } };
  const result = reduceInspector(previous, event);

  assert.deepEqual(Object.keys(result).sort(), ['effects', 'model']);
  assert.throws(
    () => createInspectorEffectContext(
      previous,
      event,
      { model: result.model, effects: result.effects },
    ),
    TypeError,
  );
  assert.throws(
    () => createInspectorEffectContext({ ...previous }, event, result),
    TypeError,
  );
  assert.throws(
    () => createInspectorEffectContext(previous, { ...event }, result),
    TypeError,
  );
});

function assertRejected(model, event) {
  const result = reduceInspector(model, event);
  assert.equal(result.model, model);
  assert.deepEqual(result.effects, []);
}

test('open and transient events reject missing or malformed string tokens', () => {
  for (const token of [
    undefined,
    null,
    '',
    '   ',
    0,
    true,
    false,
    Symbol('token'),
  ]) {
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

test('DOM-like invoker and openers retain exact opaque identity', () => {
  const invoker = { isConnected: true, focus() {} };
  const openEvent = { type: 'open', invoker };
  const openResult = reduceInspector(CLOSED, openEvent);
  const openContext = createInspectorEffectContext(CLOSED, openEvent, openResult);
  assert.equal(openResult.model.state, 'idle');
  assert.equal(openContext.event.invoker, invoker);

  const noteOpener = { isConnected: true, focus() {} };
  const editing = {
    state: 'editing',
    transient: null,
    mark: 'underline',
    options: {},
  };
  const noteEvent = { type: 'add-note', opener: noteOpener };
  const noteResult = reduceInspector(editing, noteEvent);
  const noteContext = createInspectorEffectContext(editing, noteEvent, noteResult);
  assert.equal(noteResult.model.transient.opener, noteOpener);
  assert.equal(noteContext.event.opener, noteOpener);
  assert.equal(noteContext.next.transient.opener, noteOpener);

  const shortcutOpener = function shortcutOpener() {};
  const selected = { state: 'selected', transient: null, mark: null, options: {} };
  const paletteEvent = { type: 'open-palette', opener: shortcutOpener };
  const paletteResult = reduceInspector(selected, paletteEvent);
  const paletteContext = createInspectorEffectContext(selected, paletteEvent, paletteResult);
  assert.equal(paletteResult.model.transient.opener, shortcutOpener);
  assert.equal(paletteContext.event.opener, shortcutOpener);
  assert.equal(paletteContext.next.transient.opener, shortcutOpener);
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

test('existing malformed model options gate work but never block teardown', () => {
  const malformed = [
    ['placement', 'start'],
    ['accessible', 1],
    ['duration', -1],
    ['duration', 1.5],
    ['duration', undefined],
    ['motion', 'always'],
    ['seed', 10],
  ];

  for (const [name, value] of malformed) {
    const model = {
      state: 'editing',
      transient: null,
      mark: 'underline',
      options: { [name]: value },
    };
    assertRejected(model, { type: 'apply' });
    const closed = reduceInspector(model, { type: 'close' });
    assert.equal(closed.model.state, 'closed');
    assert.deepEqual(closed.effects, [
      'destroy-owned',
      'close-layers',
      'remove-listeners',
      'unmount',
      'focus-connected-invoker',
    ]);
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

test('hostile model state reads never escape and reject idempotently', () => {
  const hostile = new Proxy({}, {
    get() {
      throw new Error('model trap');
    },
  });

  assert.doesNotThrow(() => assertRejected(hostile, { type: 'valid-selection', range: {} }));
  assert.doesNotThrow(() => assertRejected(hostile, { type: 'close' }));
});

test('hostile transient and options reads gate work but allow safe close paths', () => {
  const model = {
    state: 'editing',
    get transient() {
      throw new Error('transient getter');
    },
    mark: 'underline',
    get options() {
      throw new Error('options getter');
    },
  };

  assert.doesNotThrow(() => assertRejected(model, { type: 'apply' }));

  for (const type of ['escape', 'close', 'navigation']) {
    let result;
    assert.doesNotThrow(() => {
      result = reduceInspector(model, { type });
    });
    assert.equal(result.model.state, 'closed');
    assert.equal(result.model.transient, null);
    assert.deepEqual(result.effects, [
      'destroy-owned',
      'close-layers',
      'remove-listeners',
      'unmount',
      'focus-connected-invoker',
    ]);
  }
});

test('hostile nested transient and options proxies never escape', () => {
  const hostileTransient = new Proxy({}, {
    get() {
      throw new Error('transient proxy');
    },
  });
  const transientModel = {
    state: 'selected',
    transient: hostileTransient,
    mark: null,
    options: {},
  };
  assert.doesNotThrow(() => assertRejected(
    transientModel,
    { type: 'choose-mark', mark: 'circle' },
  ));
  const escaped = reduceInspector(transientModel, { type: 'escape' });
  assert.equal(escaped.model.state, 'closed');
  assert.deepEqual(escaped.effects, [
    'destroy-owned',
    'close-layers',
    'remove-listeners',
    'unmount',
    'focus-connected-invoker',
  ]);

  const hostileOptions = new Proxy({}, {
    get() {
      throw new Error('options proxy');
    },
  });
  const optionsModel = {
    state: 'editing',
    transient: null,
    mark: 'underline',
    options: hostileOptions,
  };
  assert.doesNotThrow(() => assertRejected(
    optionsModel,
    { type: 'valid-option', name: 'duration', value: 10 },
  ));
});

test('revoked nested proxies are contained like other hostile model fields', () => {
  const transient = Proxy.revocable({}, {});
  const options = Proxy.revocable({}, {});
  transient.revoke();
  options.revoke();

  for (const [name, value] of [
    ['transient', transient.proxy],
    ['options', options.proxy],
  ]) {
    const model = {
      state: 'editing',
      transient: null,
      mark: 'underline',
      options: {},
      [name]: value,
    };
    assert.doesNotThrow(() => assertRejected(model, { type: 'apply' }));
    let closed;
    assert.doesNotThrow(() => {
      closed = reduceInspector(model, { type: 'close' });
    });
    assert.equal(closed.model.state, 'closed');
    assert.deepEqual(closed.effects, [
      'destroy-owned',
      'close-layers',
      'remove-listeners',
      'unmount',
      'focus-connected-invoker',
    ]);
  }
});

test('unknown and invalid transient kinds act as no active transient', () => {
  for (const transient of [
    { kind: 'dialog', opener: 'dialog-button' },
    { kind: '', opener: 'dialog-button' },
    { kind: 'note', opener: null },
    42,
  ]) {
    const model = {
      state: 'editing',
      transient,
      mark: 'underline',
      options: {},
    };
    const result = reduceInspector(model, { type: 'escape' });

    assert.equal(result.model.state, 'closed');
    assert.equal(result.model.transient, null);
    assert.deepEqual(result.effects, [
      'destroy-owned',
      'close-layers',
      'remove-listeners',
      'unmount',
      'focus-connected-invoker',
    ]);
  }
});

test('changed models copy only safely snapshotted reducer-owned fields', () => {
  const model = {
    state: 'selected',
    transient: null,
    mark: null,
    options: { placement: 'auto' },
    get unrelated() {
      throw new Error('unrelated getter must not run');
    },
  };
  let result;
  assert.doesNotThrow(() => {
    result = reduceInspector(model, { type: 'choose-mark', mark: 'circle' });
  });

  assert.equal(result.model.state, 'editing');
  assert.equal(result.model.mark, 'circle');
  assert.deepEqual(result.model.options, { placement: 'auto' });
  assert.ok(!Object.hasOwn(result.model, 'unrelated'));
  assert.deepEqual(Object.keys(result.model).sort(), [
    'mark',
    'options',
    'state',
    'transient',
  ]);
});

test('valid transient snapshot reads kind once and preserves opener identity', () => {
  const opener = { isConnected: true, focus() {} };
  let kindReads = 0;
  let openerReads = 0;
  const transient = {
    get kind() {
      kindReads += 1;
      return 'palette';
    },
    get opener() {
      openerReads += 1;
      return opener;
    },
  };
  const model = {
    state: 'selected',
    transient,
    mark: null,
    options: {},
  };
  const event = { type: 'escape' };
  const result = reduceInspector(model, event);

  assert.equal(kindReads, 1);
  assert.equal(openerReads, 1);
  assert.equal(result.model.transient, null);
  assert.deepEqual(result.effects, ['close-transient', 'focus-transient-opener']);
  const context = createInspectorEffectContext(model, event, result);
  assert.equal(context.previous.transient.opener, opener);
});

test('closed state normalizes a stale valid transient before opening', () => {
  const stale = {
    state: 'closed',
    transient: { kind: 'palette', opener: 'old-button' },
    mark: 'circle',
    options: { placement: 'left' },
  };
  const result = reduceInspector(stale, { type: 'open', invoker: 'open-button' });

  assert.equal(result.model.state, 'idle');
  assert.equal(result.model.transient, null);
  assert.equal(result.model.mark, undefined);
  assert.deepEqual(result.model.options, {});
  assert.deepEqual(result.effects, [
    'capture-invoker',
    'mount',
    'attach-listeners',
    'focus-exit',
  ]);
});

test('closed state opens without consulting hostile stale nonessential fields', () => {
  const reads = { transient: 0, mark: 0, options: 0 };
  const stale = {
    state: 'closed',
    get transient() {
      reads.transient += 1;
      throw new Error('stale transient');
    },
    get mark() {
      reads.mark += 1;
      throw new Error('stale mark');
    },
    get options() {
      reads.options += 1;
      throw new Error('stale options');
    },
  };
  let result;
  assert.doesNotThrow(() => {
    result = reduceInspector(stale, { type: 'open', invoker: { id: 'open' } });
  });

  assert.deepEqual(reads, { transient: 0, mark: 0, options: 0 });
  assert.equal(result.model.state, 'idle');
  assert.equal(result.model.transient, null);
  assert.deepEqual(result.model.options, {});
});

test('accepted transitions structurally sanitize and replace options identity', () => {
  const options = {
    placement: 'auto',
    unrelated: 'drop-me',
  };
  const previous = {
    state: 'selected',
    transient: null,
    mark: null,
    options,
  };
  const event = { type: 'choose-mark', mark: 'circle' };
  const result = reduceInspector(previous, event);
  const context = createInspectorEffectContext(previous, event, result);

  assert.notEqual(result.model.options, options);
  assert.deepEqual(result.model.options, { placement: 'auto' });
  assert.ok(!Object.hasOwn(result.model.options, 'unrelated'));
  assert.notEqual(context.previous.options, options);
  assert.notEqual(context.next.options, result.model.options);
  assert.deepEqual(context.previous.options, { placement: 'auto' });
  assert.deepEqual(context.next.options, { placement: 'auto' });
});
