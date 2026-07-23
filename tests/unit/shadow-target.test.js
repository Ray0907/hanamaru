import assert from 'node:assert/strict';
import test from 'node:test';

import {
  intrinsicDocumentView,
  intrinsicOwnerDocumentOf,
  intrinsicRootKind,
} from '../../src/shadow-target.js';

test('server intrinsic root fallback accepts only own data descriptors', () => {
  const view = {};
  const document = { nodeType: 9, defaultView: view };
  const host = {};
  const shadow = { nodeType: 11, host };
  const fragment = { nodeType: 11 };

  assert.equal(intrinsicRootKind(document), 'document');
  assert.equal(intrinsicDocumentView(document), view);
  assert.equal(intrinsicRootKind(shadow), 'shadow-root');
  assert.equal(intrinsicRootKind(fragment), 'document-fragment');
  assert.equal(intrinsicRootKind(Object.create({ nodeType: 9 })), 'unknown');
  assert.equal(intrinsicRootKind(Object.create({
    nodeType: 11,
    host,
  })), 'unknown');
});

test('server intrinsic fallbacks never invoke accessors or leak their raw errors', () => {
  const cause = new Error('server root accessor must not run');
  let nodeTypeReads = 0;
  let hostReads = 0;
  let ownerDocumentReads = 0;
  let defaultViewReads = 0;
  const forged = {};
  for (const [key, increment] of [
    ['nodeType', () => { nodeTypeReads += 1; }],
    ['host', () => { hostReads += 1; }],
    ['ownerDocument', () => { ownerDocumentReads += 1; }],
    ['defaultView', () => { defaultViewReads += 1; }],
  ]) {
    Object.defineProperty(forged, key, {
      get() {
        increment();
        throw cause;
      },
    });
  }
  const throwingProxy = new Proxy({}, {
    get() { throw cause; },
  });

  assert.equal(intrinsicRootKind(forged), 'unknown');
  assert.equal(intrinsicOwnerDocumentOf(forged), null);
  assert.equal(intrinsicDocumentView(forged), null);
  assert.equal(intrinsicRootKind(throwingProxy), 'unknown');
  assert.deepEqual({
    nodeTypeReads,
    hostReads,
    ownerDocumentReads,
    defaultViewReads,
  }, {
    nodeTypeReads: 0,
    hostReads: 0,
    ownerDocumentReads: 0,
    defaultViewReads: 0,
  });
});
