import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { HanamaruConfigError, HanamaruStateError } from '../../src/errors.js';
import {
  getShadowRootState,
  claimShadowRootSlot,
  releaseShadowRootSlot,
  runtimeState,
} from '../../src/runtime-state.js';
import {
  acquireShadowStyles,
  assertShadowStyleLease,
  normalizeShadowStyles,
} from '../../src/shadow-styles.js';

const shadowCss = readFileSync(
  new URL('../../src/hanamaru-shadow.css', import.meta.url),
  'utf8',
);

class FakeSheet {}

function fakeAdapter(options = {}) {
  const calls = [];
  const installs = [];

  function install(kind, root, config, css) {
    calls.push([kind, root, config, css]);
    if (options.installError !== undefined) throw options.installError;
    const node = kind === 'auto'
      ? {
        tagName: 'STYLE',
        textContent: css,
        nonce: config.nonce,
      }
      : null;
    const record = {
      owned: options.owned ?? true,
      node,
      releases: 0,
      release() {
        record.releases += 1;
        options.onRelease?.(record);
        if (options.releaseError !== undefined) throw options.releaseError;
      },
    };
    installs.push(record);
    return record;
  }

  return {
    calls,
    installs,
    installAuto(root, config, css) {
      return install('auto', root, config, css);
    },
    adoptSheet(root, config, css) {
      return install('sheet', root, config, css);
    },
    verifyMarker(root, config, installRecord) {
      calls.push(['verify', root, config, installRecord]);
      if (options.verifyError !== undefined) throw options.verifyError;
    },
    rollback(root, installRecord) {
      calls.push(['rollback', root, installRecord]);
      installRecord?.release();
    },
  };
}

function expectConfigError(action) {
  assert.throws(
    action,
    (error) => error instanceof HanamaruConfigError
      && error.code === 'HANA_CONFIG_SHADOW_STYLES',
  );
}

test('normalizeShadowStyles returns canonical auto, sheet, and preinstalled records', () => {
  const sheet = new FakeSheet();

  assert.deepEqual(normalizeShadowStyles(), {
    mode: 'auto',
    nonce: undefined,
  });
  assert.deepEqual(normalizeShadowStyles({}), {
    mode: 'auto',
    nonce: undefined,
  });
  assert.deepEqual(normalizeShadowStyles({ mode: 'auto', nonce: 'request-42' }), {
    mode: 'auto',
    nonce: 'request-42',
  });
  assert.deepEqual(normalizeShadowStyles({ mode: 'auto', nonce: '' }), {
    mode: 'auto',
    nonce: '',
  });
  assert.deepEqual(normalizeShadowStyles({ mode: 'sheet', sheet }), {
    mode: 'sheet',
    sheet,
  });
  assert.deepEqual(normalizeShadowStyles({ mode: 'preinstalled' }), {
    mode: 'preinstalled',
  });
});

test('normalized and exposed canonical configs are frozen without mutable registry aliases', () => {
  const sheet = new FakeSheet();
  const otherSheet = new FakeSheet();
  const canonical = [
    normalizeShadowStyles(),
    normalizeShadowStyles({ mode: 'auto', nonce: '' }),
    normalizeShadowStyles({ mode: 'sheet', sheet }),
    normalizeShadowStyles({ mode: 'preinstalled' }),
  ];
  assert.ok(canonical.every(Object.isFrozen));
  assert.throws(() => {
    canonical[0].mode = 'preinstalled';
  }, TypeError);
  assert.throws(() => {
    canonical[1].nonce = 'mutated';
  }, TypeError);
  assert.throws(() => {
    canonical[2].sheet = otherSheet;
  }, TypeError);

  const root = {};
  const adapter = fakeAdapter();
  const first = acquireShadowStyles(root, { mode: 'auto', nonce: 'stable' }, adapter);
  assert.ok(Object.isFrozen(first.config));
  assert.throws(() => {
    first.config.nonce = 'mutated';
  }, TypeError);
  const second = acquireShadowStyles(
    root,
    { mode: 'auto', nonce: 'stable' },
    adapter,
  );
  let conflict;
  try {
    acquireShadowStyles(root, { mode: 'preinstalled' }, adapter);
  } catch (error) {
    conflict = error;
  }
  assert.ok(conflict instanceof HanamaruConfigError);
  assert.ok(Object.isFrozen(conflict.details.current));
  assert.ok(Object.isFrozen(conflict.details.incoming));
  assert.throws(() => {
    conflict.details.current.mode = 'preinstalled';
  }, TypeError);
  assert.equal(getShadowRootState(root).styles.config.mode, 'auto');
  assert.equal(getShadowRootState(root).styles.config.nonce, 'stable');
  assert.equal(getShadowRootState(root).styles.count, 2);
  assert.equal(adapter.installs.length, 1);

  first.release();
  second.release();
});

test('normalizeShadowStyles rejects behavior-bearing, unknown, and invalid inputs without invoking accessors', () => {
  let accessorCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'mode', {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return 'auto';
    },
  });
  const symbol = { mode: 'auto' };
  symbol[Symbol('extra')] = true;

  const invalid = [
    null,
    [],
    Object.create(null),
    Object.create({ mode: 'auto' }),
    accessor,
    symbol,
    { unknown: true },
    { mode: undefined },
    { mode: 'nope' },
    { mode: 'auto', nonce: 42 },
    { mode: 'auto', sheet: new FakeSheet() },
    { mode: 'sheet' },
    { mode: 'sheet', sheet: null },
    { mode: 'sheet', sheet: new FakeSheet(), nonce: 'x' },
    { mode: 'preinstalled', nonce: 'x' },
    { mode: 'preinstalled', sheet: new FakeSheet() },
  ];

  for (const value of invalid) expectConfigError(() => normalizeShadowStyles(value));
  assert.equal(accessorCalls, 0);
});

test('ShadowRoot state exposes stable independent identity slots', () => {
  const root = {};
  const styles = {};
  const resources = {};
  const wrong = {};

  const first = getShadowRootState(root);
  assert.strictEqual(getShadowRootState(root), first);
  assert.deepEqual(first, { styles: null, resources: null });

  assert.strictEqual(claimShadowRootSlot(root, 'styles', styles), first);
  assert.strictEqual(claimShadowRootSlot(root, 'resources', resources), first);
  assert.strictEqual(first.styles, styles);
  assert.strictEqual(first.resources, resources);
  assert.throws(
    () => claimShadowRootSlot(root, 'styles', {}),
    /styles/u,
  );

  assert.equal(releaseShadowRootSlot(root, 'styles', wrong), false);
  assert.strictEqual(first.styles, styles);
  assert.equal(releaseShadowRootSlot(root, 'styles', styles), true);
  assert.equal(first.styles, null);
  assert.strictEqual(runtimeState.shadows.get(root), first);
  assert.equal(releaseShadowRootSlot(root, 'resources', resources), true);
  assert.equal(runtimeState.shadows.has(root), false);
  assert.equal(releaseShadowRootSlot(root, 'resources', resources), false);
  assert.throws(() => claimShadowRootSlot(root, 'other', {}), /slot/u);
});

test('compatible auto leases share one exact fallback installation until final release', () => {
  const root = {};
  const adapter = fakeAdapter();
  const first = acquireShadowStyles(root, { nonce: 'request-42' }, adapter);
  const second = acquireShadowStyles(
    root,
    { mode: 'auto', nonce: 'request-42' },
    adapter,
  );
  const state = getShadowRootState(root).styles;

  assert.equal(state.count, 2);
  assert.equal(adapter.installs.length, 1);
  assert.equal(adapter.calls.filter(([kind]) => kind === 'verify').length, 1);
  assert.deepEqual(adapter.installs[0].node, {
    tagName: 'STYLE',
    textContent: shadowCss,
    nonce: 'request-42',
  });
  assert.equal(first.owned, true);
  assert.equal(second.owned, true);

  first.release();
  first.release();
  assert.equal(state.count, 1);
  assert.equal(adapter.installs[0].releases, 0);
  second.release();
  assert.equal(adapter.installs[0].releases, 1);
  assert.equal(runtimeState.shadows.has(root), false);
});

test('style lease brand is live, exact-root, per-lease, and rejects duck identities', () => {
  const root = {};
  const otherRoot = {};
  const adapter = fakeAdapter();
  const first = acquireShadowStyles(root, undefined, adapter);
  const second = acquireShadowStyles(root, undefined, adapter);

  assert.deepEqual(assertShadowStyleLease(root, first), {
    mode: 'auto',
    nonce: undefined,
  });
  assert.strictEqual(assertShadowStyleLease(root, first), first.config);
  assert.throws(
    () => assertShadowStyleLease(otherRoot, first),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_SHADOW_STYLES',
  );
  assert.throws(
    () => assertShadowStyleLease(root, {
      config: first.config,
      release() {},
    }),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_SHADOW_STYLES',
  );

  first.release();
  assert.throws(
    () => assertShadowStyleLease(root, first),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_SHADOW_STYLES',
  );
  assert.strictEqual(assertShadowStyleLease(root, second), second.config);
  second.release();
  assert.throws(
    () => assertShadowStyleLease(root, second),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_SHADOW_STYLES',
  );
});

test('empty nonce is propagated exactly and compatible only with the same empty nonce', () => {
  const root = {};
  const adapter = fakeAdapter();
  const first = acquireShadowStyles(root, { mode: 'auto', nonce: '' }, adapter);
  const second = acquireShadowStyles(root, { nonce: '' }, adapter);

  assert.equal(adapter.installs.length, 1);
  assert.equal(adapter.installs[0].node.nonce, '');
  assert.equal(adapter.installs[0].node.textContent, shadowCss);
  assert.equal(getShadowRootState(root).styles.count, 2);
  expectConfigError(() => acquireShadowStyles(root, undefined, adapter));
  expectConfigError(() => acquireShadowStyles(
    root,
    { mode: 'auto', nonce: 'nonempty' },
    adapter,
  ));
  assert.equal(getShadowRootState(root).styles.count, 2);

  first.release();
  second.release();
  assert.equal(runtimeState.shadows.has(root), false);
});

test('same sheet identity and preinstalled modes share while different sheet identity conflicts', () => {
  const sheet = new FakeSheet();
  const otherSheet = new FakeSheet();
  const sheetRoot = {};
  const sheetAdapter = fakeAdapter({ owned: false });
  const sheetA = acquireShadowStyles(sheetRoot, { mode: 'sheet', sheet }, sheetAdapter);
  const sheetB = acquireShadowStyles(sheetRoot, { mode: 'sheet', sheet }, sheetAdapter);

  assert.equal(getShadowRootState(sheetRoot).styles.count, 2);
  assert.equal(sheetAdapter.installs.length, 1);
  expectConfigError(() => acquireShadowStyles(
    sheetRoot,
    { mode: 'sheet', sheet: otherSheet },
    sheetAdapter,
  ));
  assert.equal(getShadowRootState(sheetRoot).styles.count, 2);
  sheetA.release();
  sheetB.release();

  const preinstalledRoot = {};
  const preinstalledAdapter = fakeAdapter();
  const preinstalledA = acquireShadowStyles(
    preinstalledRoot,
    { mode: 'preinstalled' },
    preinstalledAdapter,
  );
  const preinstalledB = acquireShadowStyles(
    preinstalledRoot,
    { mode: 'preinstalled' },
    preinstalledAdapter,
  );
  assert.equal(preinstalledAdapter.installs.length, 0);
  assert.equal(
    preinstalledAdapter.calls.filter(([kind]) => kind === 'verify').length,
    1,
  );
  assert.equal(getShadowRootState(preinstalledRoot).styles.count, 2);
  preinstalledA.release();
  preinstalledB.release();
  assert.equal(runtimeState.shadows.has(preinstalledRoot), false);
});

test('every incompatible style configuration fails before changing the live count', () => {
  const sheet = new FakeSheet();
  const otherSheet = new FakeSheet();
  const configurations = [
    { name: 'auto', value: { mode: 'auto' } },
    { name: 'auto nonce', value: { mode: 'auto', nonce: 'one' } },
    { name: 'sheet', value: { mode: 'sheet', sheet } },
    { name: 'other sheet', value: { mode: 'sheet', sheet: otherSheet } },
    { name: 'preinstalled', value: { mode: 'preinstalled' } },
  ];

  for (const current of configurations) {
    for (const incoming of configurations) {
      const compatible = (
        current.name === 'auto' && incoming.name === 'auto'
      ) || (
        current.name === 'auto nonce' && incoming.name === 'auto nonce'
      ) || (
        current.name === 'sheet' && incoming.name === 'sheet'
      ) || (
        current.name === 'other sheet' && incoming.name === 'other sheet'
      ) || (
        current.name === 'preinstalled' && incoming.name === 'preinstalled'
      );
      if (compatible) continue;

      const root = {};
      const adapter = fakeAdapter();
      const lease = acquireShadowStyles(root, current.value, adapter);
      const state = getShadowRootState(root).styles;
      expectConfigError(() => acquireShadowStyles(root, incoming.value, adapter));
      assert.equal(state.count, 1, `${current.name} -> ${incoming.name}`);
      assert.equal(adapter.installs.length, current.value.mode === 'preinstalled' ? 0 : 1);
      lease.release();
    }
  }
});

test('failed first acquire rolls back owned work and leaves no empty root state', () => {
  const root = {};
  const cause = new Error('marker unavailable');
  const adapter = fakeAdapter({ verifyError: cause });

  assert.throws(
    () => acquireShadowStyles(root, { mode: 'auto' }, adapter),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_SHADOW_STYLES'
      && error.details.cause === cause,
  );
  assert.equal(adapter.installs.length, 1);
  assert.equal(adapter.installs[0].releases, 1);
  assert.equal(
    adapter.calls.filter(([kind]) => kind === 'rollback').length,
    1,
  );
  assert.equal(runtimeState.shadows.has(root), false);
});

test('failed installation still invokes rollback and preserves an independent resources slot', () => {
  const root = {};
  const resources = {};
  claimShadowRootSlot(root, 'resources', resources);
  const cause = new Error('style insertion blocked');
  const adapter = fakeAdapter({ installError: cause });

  assert.throws(
    () => acquireShadowStyles(root, { mode: 'auto' }, adapter),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_SHADOW_STYLES'
      && error.details.cause === cause,
  );
  assert.equal(
    adapter.calls.filter(([kind]) => kind === 'rollback').length,
    1,
  );
  const state = getShadowRootState(root);
  assert.equal(state.styles, null);
  assert.strictEqual(state.resources, resources);
  releaseShadowRootSlot(root, 'resources', resources);
});

test('malformed install records roll back with the exact raw adapter identity', () => {
  const cases = [
    {
      raw: {
        owned: 'yes',
        release() {},
      },
    },
    {
      raw: {
        owned: true,
      },
    },
  ];

  for (const entry of cases) {
    const root = {};
    let work = 1;
    let rollbackRaw;
    const adapter = {
      installAuto() {
        return entry.raw;
      },
      adoptSheet() {
        throw new Error('unused');
      },
      verifyMarker() {
        throw new Error('verify must not run');
      },
      rollback(_root, raw) {
        rollbackRaw = raw;
        work = 0;
      },
    };

    assert.throws(
      () => acquireShadowStyles(root, undefined, adapter),
      (error) => error instanceof HanamaruStateError
        && error.code === 'HANA_STATE_SHADOW_STYLES'
        && error.details.cause instanceof TypeError,
    );
    assert.strictEqual(rollbackRaw, entry.raw);
    assert.equal(work, 0);
    assert.equal(runtimeState.shadows.has(root), false);
  }
});

test('successful install snapshots owned and release with the raw method receiver', () => {
  const root = {};
  let originalCalls = 0;
  let replacementCalls = 0;
  let receiver;
  const raw = {
    owned: true,
    release() {
      originalCalls += 1;
      receiver = this;
    },
  };
  const adapter = {
    installAuto() {
      return raw;
    },
    adoptSheet() {
      throw new Error('unused');
    },
    verifyMarker() {},
    rollback(_root, install) {
      install?.release();
    },
  };
  const first = acquireShadowStyles(root, undefined, adapter);

  raw.owned = false;
  raw.release = function replacementRelease() {
    replacementCalls += 1;
  };
  const second = acquireShadowStyles(root, undefined, adapter);

  assert.equal(first.owned, true);
  assert.equal(second.owned, true);
  first.release();
  second.release();
  assert.equal(originalCalls, 1);
  assert.equal(replacementCalls, 0);
  assert.strictEqual(receiver, raw);
  assert.equal(runtimeState.shadows.has(root), false);
});

test('final style release preserves resources and release cleanup is failure-contained', () => {
  const root = {};
  const resources = {};
  claimShadowRootSlot(root, 'resources', resources);
  const releaseCause = new Error('release failed after cleanup');
  const adapter = fakeAdapter({ releaseError: releaseCause });
  const lease = acquireShadowStyles(root, undefined, adapter);

  assert.throws(
    () => lease.release(),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_SHADOW_STYLES'
      && error.details.cause === releaseCause,
  );
  const state = getShadowRootState(root);
  assert.equal(state.styles, null);
  assert.strictEqual(state.resources, resources);
  lease.release();
  assert.equal(adapter.installs[0].releases, 1);
  releaseShadowRootSlot(root, 'resources', resources);
});

test('final release rejects caught reentrant acquire without returning an orphan lease', () => {
  const root = {};
  let adapter;
  let reentrantError;
  let reentrantLease;
  adapter = fakeAdapter({
    onRelease() {
      try {
        reentrantLease = acquireShadowStyles(root, undefined, adapter);
      } catch (error) {
        reentrantError = error;
      }
    },
  });
  const lease = acquireShadowStyles(root, undefined, adapter);

  lease.release();

  assert.equal(reentrantLease, undefined);
  assert.ok(reentrantError instanceof HanamaruStateError);
  assert.equal(reentrantError.code, 'HANA_STATE_SHADOW_STYLES');
  assert.equal(adapter.installs.length, 1);
  assert.equal(adapter.installs[0].releases, 1);
  assert.equal(runtimeState.shadows.has(root), false);

  adapter = fakeAdapter();
  const replacement = acquireShadowStyles(root, undefined, adapter);
  assert.equal(adapter.installs.length, 1);
  replacement.release();
  assert.equal(runtimeState.shadows.has(root), false);
});

test('final release contains uncaught reentrant acquire and still clears the exact slot', () => {
  const root = {};
  let adapter;
  adapter = fakeAdapter({
    onRelease() {
      acquireShadowStyles(root, undefined, adapter);
    },
  });
  const lease = acquireShadowStyles(root, undefined, adapter);

  assert.throws(
    () => lease.release(),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_SHADOW_STYLES'
      && error.details.operation === 'release'
      && error.details.cause instanceof HanamaruStateError
      && error.details.cause.code === 'HANA_STATE_SHADOW_STYLES',
  );
  assert.equal(adapter.installs.length, 1);
  assert.equal(adapter.installs[0].releases, 1);
  assert.equal(runtimeState.shadows.has(root), false);
  lease.release();
  assert.equal(adapter.installs[0].releases, 1);
});
