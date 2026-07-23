import assert from 'node:assert/strict';
import test from 'node:test';

import { HanamaruStateError } from '../../src/errors.js';
import {
  getShadowRootState,
  releaseShadowRootSlot,
  runtimeState,
} from '../../src/runtime-state.js';
import { acquireShadowResources } from '../../src/shadow-resources.js';

function owner(root, describedBy = null) {
  return {
    root,
    attributes: new Map(
      describedBy === null ? [] : [['aria-describedby', describedBy]],
    ),
  };
}

function resourceHarness(options = {}) {
  const calls = [];
  const documents = new WeakMap();
  let nextNode = 0;

  function documentEntry(document) {
    let entry = documents.get(document);
    if (entry === undefined) {
      entry = {
        refs: 0,
        shared: {
          document,
          nextId: 0,
          scheduler: Symbol('frame-scheduler'),
          windowListeners: Symbol('window-listeners'),
          viewportListeners: Symbol('viewport-listeners'),
        },
      };
      documents.set(document, entry);
    }
    return entry;
  }

  const adapter = {
    assertRoot(root) {
      calls.push(['assertRoot', root]);
      if (options.rootError !== undefined) throw options.rootError;
    },
    allocateId(shared, root, prefix) {
      shared.nextId += 1;
      const id = `${prefix}-${shared.nextId}`;
      calls.push(['allocateId', shared, root, prefix, id]);
      return id;
    },
    acquireDocumentResources(document) {
      calls.push(['acquireDocumentResources', document]);
      if (options.documentAcquireError !== undefined) {
        throw options.documentAcquireError;
      }
      const entry = documentEntry(document);
      entry.refs += 1;
      let released = false;
      return {
        shared: entry.shared,
        release() {
          if (released) return;
          released = true;
          calls.push(['releaseDocumentResources', document]);
          entry.refs -= 1;
          if (options.documentReleaseError !== undefined) {
            throw options.documentReleaseError;
          }
        },
      };
    },
    createPortal(document, root, rootId) {
      calls.push(['createPortal', document, root, rootId]);
      if (options.portalError !== undefined) throw options.portalError;
      const overlay = {
        id: ++nextNode,
        kind: 'overlay',
        ownerDocument: document,
        parent: document,
        root,
        rootId,
        removed: false,
      };
      const svgLayer = {
        id: ++nextNode,
        kind: 'svg',
        ownerDocument: document,
        parent: overlay,
      };
      const noteLayer = {
        id: ++nextNode,
        kind: 'notes',
        ownerDocument: document,
        parent: overlay,
      };
      return {
        overlay,
        svgLayer,
        noteLayer,
        release() {
          calls.push(['releasePortal', overlay]);
          overlay.removed = true;
          if (options.portalReleaseError !== undefined) {
            throw options.portalReleaseError;
          }
        },
      };
    },
    createMutationObserver(root, notify) {
      calls.push(['createMutationObserver', root]);
      if (options.observerError !== undefined) throw options.observerError;
      const observer = {
        disconnected: false,
        notify,
        root,
      };
      return {
        observer,
        release() {
          calls.push(['releaseMutationObserver', observer]);
          observer.disconnected = true;
          if (options.observerReleaseError !== undefined) {
            throw options.observerReleaseError;
          }
        },
      };
    },
    createMirror(root, id, text) {
      calls.push(['createMirror', root, id, text]);
      if (options.mirrorError !== undefined) throw options.mirrorError;
      return {
        id,
        kind: 'mirror',
        removed: false,
        root,
        text,
      };
    },
    updateMirror(mirror, text) {
      calls.push(['updateMirror', mirror, text]);
      mirror.text = text;
    },
    removeMirror(mirror) {
      calls.push(['removeMirror', mirror]);
      mirror.removed = true;
      if (options.mirrorReleaseError !== undefined) {
        throw options.mirrorReleaseError;
      }
    },
    getDescription(ownerElement) {
      return ownerElement.attributes.get('aria-describedby') ?? null;
    },
    setDescription(ownerElement, value) {
      calls.push(['setDescription', ownerElement, value]);
      ownerElement.attributes.set('aria-describedby', value);
      if (options.setDescriptionError !== undefined) {
        throw options.setDescriptionError;
      }
    },
    removeDescription(ownerElement) {
      calls.push(['removeDescription', ownerElement]);
      ownerElement.attributes.delete('aria-describedby');
    },
    ownerBelongsToRoot(ownerElement, root) {
      return ownerElement.root === root;
    },
    dispatch(ownerElement, type, detail) {
      calls.push(['dispatch', ownerElement, type, detail]);
      return { bubbles: true, composed: true, detail, target: ownerElement, type };
    },
    signalMutations(shared, records, root, overlay) {
      calls.push(['signalMutations', shared, records, root, overlay]);
    },
  };

  return {
    adapter,
    calls,
    entry(document) {
      return documentEntry(document);
    },
  };
}

function root(document, name) {
  return { name, ownerDocument: document };
}

function styleLease(name = 'styles') {
  return Object.freeze({ name, release() {} });
}

function acquire(rootValue, styles, harness) {
  return acquireShadowResources(rootValue, styles, harness.adapter);
}

function expectStateError(action, cause, operation) {
  assert.throws(
    action,
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_SHADOW_RESOURCES'
      && error.details.cause === cause
      && error.details.operation === operation,
  );
}

test('resource lease creates one portal, observer, mirror registry, and environment per root', () => {
  const document = {};
  const shadow = root(document, 'one');
  const harness = resourceHarness();
  const styles = styleLease();
  const first = acquire(shadow, styles, harness);
  const second = acquire(shadow, styles, harness);

  assert.strictEqual(first.environment, second.environment);
  assert.strictEqual(first.environment.root, shadow);
  assert.strictEqual(first.environment.document, document);
  assert.strictEqual(first.environment.observerTarget, shadow);
  assert.strictEqual(first.environment.portal.ownerDocument, document);
  assert.notStrictEqual(first.environment.portal.parent, shadow);
  assert.strictEqual(first.environment.svgLayer.parent, first.environment.portal);
  assert.strictEqual(first.environment.noteLayer.parent, first.environment.portal);
  assert.strictEqual(first.environment.shared.overlay, first.environment.portal);
  assert.strictEqual(first.environment.shared.svgLayer, first.environment.svgLayer);
  assert.strictEqual(first.environment.shared.noteLayer, first.environment.noteLayer);
  assert.strictEqual(
    first.environment.documentShared,
    harness.entry(document).shared,
  );
  assert.equal(
    harness.calls.filter(([name]) => name === 'createPortal').length,
    1,
  );
  assert.equal(
    harness.calls.filter(([name]) => name === 'createMutationObserver').length,
    1,
  );
  assert.equal(getShadowRootState(shadow).resources.count, 2);

  first.release();
  assert.equal(first.environment.portal.removed, false);
  second.release();
  assert.equal(first.environment.portal.removed, true);
  assert.equal(runtimeState.shadows.has(shadow), false);
});

test('two roots share Document scheduler/listeners but own distinct portals and observers', () => {
  const document = {};
  const firstRoot = root(document, 'first');
  const secondRoot = root(document, 'second');
  const harness = resourceHarness();
  const first = acquire(firstRoot, styleLease('first'), harness);
  const second = acquire(secondRoot, styleLease('second'), harness);

  assert.strictEqual(first.environment.documentShared, second.environment.documentShared);
  assert.strictEqual(first.environment.shared.scheduler, second.environment.shared.scheduler);
  assert.strictEqual(
    first.environment.shared.windowListeners,
    second.environment.shared.windowListeners,
  );
  assert.strictEqual(
    first.environment.shared.viewportListeners,
    second.environment.shared.viewportListeners,
  );
  assert.notStrictEqual(first.environment.portal, second.environment.portal);
  assert.notStrictEqual(first.environment.observer, second.environment.observer);
  assert.strictEqual(first.environment.observer.root, firstRoot);
  assert.strictEqual(second.environment.observer.root, secondRoot);
  assert.equal(
    harness.calls.filter(([name]) => name === 'acquireDocumentResources').length,
    2,
  );
  assert.equal(harness.entry(document).refs, 2);

  first.release();
  assert.equal(harness.entry(document).refs, 1);
  assert.equal(second.environment.portal.removed, false);
  second.release();
  assert.equal(harness.entry(document).refs, 0);
});

test('root MutationObserver notifications enter the shared Document scheduler with exact ownership', () => {
  const document = {};
  const shadow = root(document, 'notifications');
  const harness = resourceHarness();
  const lease = acquire(shadow, styleLease(), harness);
  const records = [{ target: { root: shadow } }];

  lease.environment.observer.notify(records);

  const signal = harness.calls.find(([name]) => name === 'signalMutations');
  assert.deepEqual(signal, [
    'signalMutations',
    harness.entry(document).shared,
    records,
    shadow,
    lease.environment.portal,
  ]);
  lease.release();
  const signalsBeforeStaleDelivery = harness.calls.filter(
    ([name]) => name === 'signalMutations',
  ).length;
  lease.environment.observer.notify([{ target: { root: shadow } }]);
  assert.equal(
    harness.calls.filter(([name]) => name === 'signalMutations').length,
    signalsBeforeStaleDelivery,
  );
});

test('mirror IDs are unique across roots and only owned aria tokens are removed', () => {
  const document = {};
  const firstRoot = root(document, 'first');
  const secondRoot = root(document, 'second');
  const harness = resourceHarness();
  const first = acquire(firstRoot, styleLease('first'), harness);
  const second = acquire(secondRoot, styleLease('second'), harness);
  const firstOwner = owner(firstRoot, 'author-before author-after');
  const secondOwner = owner(secondRoot, 'author-second');

  const mirrorA = first.environment.createMirror(firstOwner, 'First note');
  const mirrorB = first.environment.createMirror(firstOwner, 'Second note');
  const mirrorC = second.environment.createMirror(secondOwner, 'Third note');
  assert.equal(new Set([mirrorA.id, mirrorB.id, mirrorC.id]).size, 3);
  assert.match(mirrorA.id, /^hana-shadow-/u);
  assert.deepEqual(
    firstOwner.attributes.get('aria-describedby').split(/\s+/u),
    ['author-before', 'author-after', mirrorA.id, mirrorB.id],
  );
  assert.deepEqual(
    secondOwner.attributes.get('aria-describedby').split(/\s+/u),
    ['author-second', mirrorC.id],
  );

  first.environment.updateMirror(mirrorA, 'Updated');
  assert.equal(mirrorA.text, 'Updated');
  first.environment.removeMirror(mirrorA);
  first.environment.removeMirror(mirrorA);
  assert.equal(mirrorA.removed, true);
  assert.deepEqual(
    firstOwner.attributes.get('aria-describedby').split(/\s+/u),
    ['author-before', 'author-after', mirrorB.id],
  );

  first.release();
  assert.equal(mirrorB.removed, true);
  assert.equal(
    firstOwner.attributes.get('aria-describedby'),
    'author-before author-after',
  );
  assert.equal(mirrorC.removed, false);
  second.release();
  assert.equal(mirrorC.removed, true);
  assert.equal(secondOwner.attributes.get('aria-describedby'), 'author-second');
});

test('mirror registry rejects cross-root owners and foreign mirror updates without residue', () => {
  const document = {};
  const shadow = root(document, 'scope');
  const other = root(document, 'other');
  const harness = resourceHarness();
  const lease = acquire(shadow, styleLease(), harness);

  assert.throws(
    () => lease.environment.createMirror(owner(other), 'Wrong root'),
    /exact ShadowRoot/u,
  );
  assert.throws(
    () => lease.environment.updateMirror({}, 'Foreign'),
    /owned mirror/u,
  );
  assert.throws(
    () => lease.environment.removeMirror({}),
    /owned mirror/u,
  );
  assert.equal(
    harness.calls.filter(([name]) => name === 'createMirror').length,
    0,
  );
  lease.release();
});

test('mirror association failure rolls back both the node and a partially written owned token', () => {
  const document = {};
  const shadow = root(document, 'mirror-rollback');
  const cause = new Error('attribute writer failed after mutation');
  const harness = resourceHarness({ setDescriptionError: cause });
  const lease = acquire(shadow, styleLease(), harness);
  const target = owner(shadow, 'author-token');

  assert.throws(
    () => lease.environment.createMirror(target, 'Rollback note'),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_SHADOW_RESOURCES'
      && error.details.cause === cause,
  );
  assert.equal(target.attributes.get('aria-describedby'), 'author-token');
  assert.equal(
    harness.calls.filter(([name]) => name === 'removeMirror').length,
    1,
  );
  lease.release();
});

test('resource release is idempotent and keeps the independent styles slot alive', () => {
  const document = {};
  const shadow = root(document, 'independent');
  const harness = resourceHarness();
  const styles = {};
  getShadowRootState(shadow).styles = styles;
  const first = acquire(shadow, styleLease(), harness);
  const second = acquire(shadow, styleLease(), harness);

  first.release();
  first.release();
  assert.equal(getShadowRootState(shadow).resources.count, 1);
  second.release();
  second.release();
  const state = getShadowRootState(shadow);
  assert.strictEqual(state.styles, styles);
  assert.equal(state.resources, null);
  assert.equal(runtimeState.shadows.has(shadow), true);
  assert.equal(releaseShadowRootSlot(shadow, 'styles', styles), true);
  assert.equal(runtimeState.shadows.has(shadow), false);
});

test('portal creation failure rolls back the Document lease and leaves no resources slot', () => {
  const document = {};
  const shadow = root(document, 'portal-failure');
  const cause = new Error('portal creation failed');
  const harness = resourceHarness({ portalError: cause });

  expectStateError(
    () => acquire(shadow, styleLease(), harness),
    cause,
    'acquire',
  );
  assert.equal(harness.entry(document).refs, 0);
  assert.equal(runtimeState.shadows.has(shadow), false);
  assert.equal(
    harness.calls.filter(([name]) => name === 'releaseDocumentResources').length,
    1,
  );
});

test('observer creation failure removes the portal, releases Document resources, and keeps styles', () => {
  const document = {};
  const shadow = root(document, 'observer-failure');
  const styles = {};
  getShadowRootState(shadow).styles = styles;
  const cause = new Error('observer creation failed');
  const harness = resourceHarness({ observerError: cause });

  expectStateError(
    () => acquire(shadow, styleLease(), harness),
    cause,
    'acquire',
  );
  assert.equal(harness.entry(document).refs, 0);
  const portal = harness.calls.find(([name]) => name === 'createPortal')[4];
  assert.equal(portal, undefined);
  assert.equal(
    harness.calls.filter(([name]) => name === 'releasePortal').length,
    1,
  );
  assert.strictEqual(getShadowRootState(shadow).styles, styles);
  assert.equal(getShadowRootState(shadow).resources, null);
  releaseShadowRootSlot(shadow, 'styles', styles);
});

test('final release contains every cleanup error, clears the exact slot, and removes mirrors', () => {
  const document = {};
  const shadow = root(document, 'release-failures');
  const observerCause = new Error('observer disconnect failed');
  const harness = resourceHarness({
    observerReleaseError: observerCause,
    portalReleaseError: new Error('portal removal failed'),
    documentReleaseError: new Error('document release failed'),
    mirrorReleaseError: new Error('mirror removal failed'),
  });
  const lease = acquire(shadow, styleLease(), harness);
  const target = owner(shadow, 'author');
  const mirror = lease.environment.createMirror(target, 'Note');

  expectStateError(lease.release, observerCause, 'release');
  assert.equal(mirror.removed, true);
  assert.equal(target.attributes.get('aria-describedby'), 'author');
  assert.equal(lease.environment.observer.disconnected, true);
  assert.equal(lease.environment.portal.removed, true);
  assert.equal(harness.entry(document).refs, 0);
  assert.equal(runtimeState.shadows.has(shadow), false);
  assert.doesNotThrow(lease.release);
});

test('final release rejects reentrant acquire and still permits a clean later replacement', () => {
  const document = {};
  const shadow = root(document, 'reentrant');
  let reentrantError;
  let harness;
  harness = resourceHarness({
    observerReleaseError: undefined,
  });
  const originalRelease = harness.adapter.createMutationObserver;
  harness.adapter.createMutationObserver = (rootValue, notify) => {
    const install = originalRelease(rootValue, notify);
    const release = install.release;
    install.release = () => {
      try {
        acquire(rootValue, styleLease('reentrant'), harness);
      } catch (error) {
        reentrantError = error;
      }
      release();
    };
    return install;
  };
  const lease = acquire(shadow, styleLease(), harness);

  lease.release();

  assert.ok(reentrantError instanceof HanamaruStateError);
  assert.equal(reentrantError.code, 'HANA_STATE_SHADOW_RESOURCES');
  assert.equal(reentrantError.details.operation, 'acquire');
  assert.equal(runtimeState.shadows.has(shadow), false);
  const replacement = acquire(shadow, styleLease('replacement'), harness);
  replacement.release();
});

test('create failure caused by a reentrant winner cleans only the losing portal and lease', () => {
  const document = {};
  const shadow = root(document, 'claim-race');
  const harness = resourceHarness();
  const createPortal = harness.adapter.createPortal;
  let winner;
  let depth = 0;
  harness.adapter.createPortal = (...args) => {
    const portal = createPortal(...args);
    if (depth === 0) {
      depth += 1;
      winner = acquire(shadow, styleLease('winner'), harness);
      depth -= 1;
    }
    return portal;
  };

  assert.throws(
    () => acquire(shadow, styleLease('loser'), harness),
    (error) => error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_SHADOW_RESOURCES'
      && error.details.operation === 'acquire',
  );
  assert.strictEqual(getShadowRootState(shadow).resources.environment, winner.environment);
  assert.equal(harness.entry(document).refs, 1);
  const portals = harness.calls
    .filter(([name]) => name === 'createPortal')
    .map(([, , , , portal]) => portal)
    .filter(Boolean);
  assert.equal(portals.length, 0);
  assert.equal(
    harness.calls.filter(([name]) => name === 'releasePortal').length,
    1,
  );
  winner.release();
  assert.equal(harness.entry(document).refs, 0);
});

test('composed dispatch primitive preserves exact owner, type, and detail', () => {
  const document = {};
  const shadow = root(document, 'events');
  const harness = resourceHarness();
  const lease = acquire(shadow, styleLease(), harness);
  const target = owner(shadow);
  const detail = { state: 'shown' };

  assert.deepEqual(
    lease.environment.createEvent('hana:show', detail, target),
    {
      bubbles: true,
      composed: true,
      detail,
      target,
      type: 'hana:show',
    },
  );
  lease.release();
});
