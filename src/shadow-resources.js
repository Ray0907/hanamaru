import { HanamaruStateError } from './errors.js';
import {
  addDescriptionToken,
  removeDescriptionToken,
} from './renderer.js';
import {
  claimShadowRootSlot,
  releaseShadowRootSlot,
  runtimeState,
} from './runtime-state.js';
import {
  acquireDocumentScheduler,
  allocateDocumentResourceId,
  registerDocumentResourcePortal,
  signalDocumentResourceMutations,
} from './scheduler.js';
import { assertShadowRoot } from './shadow-target.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function stateError(cause, details = {}) {
  return new HanamaruStateError(
    'HANA_STATE_SHADOW_RESOURCES',
    'Shadow root resources could not be managed',
    { ...details, cause },
  );
}

function validateStyleLease(styleLease) {
  if (styleLease === null || typeof styleLease !== 'object'
    || typeof styleLease.release !== 'function') {
    throw new TypeError('styleLease must be an active Shadow style lease');
  }
}

function createPortal(document, root, rootId) {
  const overlay = document.createElement('div');
  overlay.className = 'hana-overlay hana-shadow-overlay';
  overlay.setAttribute('data-hana-overlay', '');
  overlay.setAttribute('data-hana-shadow-overlay', '');
  overlay.setAttribute('data-hana-shadow-root', rootId);

  const svgLayer = document.createElementNS(SVG_NAMESPACE, 'svg');
  svgLayer.setAttribute('class', 'hana-svg-layer');
  svgLayer.setAttribute('data-hana-svg-layer', '');
  svgLayer.setAttribute('aria-hidden', 'true');

  const noteLayer = document.createElement('div');
  noteLayer.className = 'hana-note-layer';
  noteLayer.setAttribute('data-hana-note-layer', '');

  overlay.append(svgLayer, noteLayer);
  const parent = document.body ?? document.documentElement;
  if (parent === null) {
    throw new TypeError('Shadow resource portal requires a connected Document');
  }
  parent.append(overlay);

  let released = false;
  return {
    noteLayer,
    overlay,
    svgLayer,
    release() {
      if (released) return;
      released = true;
      overlay.remove();
    },
  };
}

function createMutationObserver(root, notify) {
  const Observer = root.ownerDocument.defaultView.MutationObserver;
  if (typeof Observer !== 'function') {
    throw new TypeError('Shadow resources require MutationObserver');
  }
  const observer = new Observer(notify);
  try {
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });
  } catch (error) {
    try { observer.disconnect(); } catch {}
    throw error;
  }
  let released = false;
  return {
    observer,
    release() {
      if (released) return;
      released = true;
      observer.disconnect();
    },
  };
}

function createMirror(root, id, text) {
  const mirror = root.ownerDocument.createElement('span');
  mirror.className = 'hana-shadow-mirror';
  mirror.setAttribute('data-hana-shadow-mirror', '');
  mirror.id = id;
  mirror.textContent = text;
  root.append(mirror);
  return mirror;
}

function browserAdapter() {
  return {
    assertRoot: assertShadowRoot,
    acquireDocumentResources: acquireDocumentScheduler,
    allocateId: allocateDocumentResourceId,
    createPortal,
    createMutationObserver,
    createMirror,
    updateMirror(mirror, text) {
      mirror.textContent = text;
    },
    removeMirror(mirror) {
      mirror.remove();
    },
    getDescription(owner) {
      return owner.getAttribute('aria-describedby');
    },
    setDescription(owner, value) {
      owner.setAttribute('aria-describedby', value);
    },
    removeDescription(owner) {
      owner.removeAttribute('aria-describedby');
    },
    ownerBelongsToRoot(owner, root) {
      const Element = root.ownerDocument.defaultView.Element;
      return owner instanceof Element
        && owner.isConnected
        && owner.getRootNode() === root;
    },
    dispatch(owner, type, detail) {
      const view = rootView(owner);
      return owner.dispatchEvent(new view.CustomEvent(type, {
        detail,
        bubbles: true,
        composed: true,
      }));
    },
    registerPortal: registerDocumentResourcePortal,
    signalMutations: signalDocumentResourceMutations,
  };
}

function rootView(owner) {
  return owner.ownerDocument.defaultView;
}

function validateDocumentLease(raw) {
  if (raw === null || typeof raw !== 'object'
    || raw.shared === null || typeof raw.shared !== 'object'
    || typeof raw.release !== 'function') {
    throw new TypeError('Document resource acquisition returned an invalid lease');
  }
  let released = false;
  return {
    shared: raw.shared,
    release() {
      if (released) return;
      released = true;
      return Reflect.apply(raw.release, raw, []);
    },
  };
}

function validateInstall(raw, kind) {
  if (raw === null || typeof raw !== 'object'
    || typeof raw.release !== 'function') {
    throw new TypeError(`${kind} installation returned an invalid record`);
  }
  let released = false;
  return {
    ...raw,
    release() {
      if (released) return;
      released = true;
      return Reflect.apply(raw.release, raw, []);
    },
  };
}

function createScopedShared(documentShared, root, portal) {
  const methodCache = new Map();
  const local = {
    noteLayer: portal.noteLayer,
    overlay: portal.overlay,
    svgLayer: portal.svgLayer,
  };
  return new Proxy(local, {
    get(target, key, receiver) {
      if (Reflect.has(target, key)) {
        return Reflect.get(target, key, receiver);
      }
      if (key === 'observeLayout') {
        if (!methodCache.has(key)) {
          methodCache.set(key, (options) => documentShared.observeLayout({
            ...options,
            mutationRoot: root,
          }));
        }
        return methodCache.get(key);
      }
      if (key === 'rebindLayout') {
        if (!methodCache.has(key)) {
          methodCache.set(key, (id, options) => documentShared.rebindLayout(id, {
            ...options,
            mutationRoot: root,
          }));
        }
        return methodCache.get(key);
      }
      const value = Reflect.get(documentShared, key, documentShared);
      if (typeof value !== 'function') return value;
      if (!methodCache.has(key)) methodCache.set(key, value.bind(documentShared));
      return methodCache.get(key);
    },
    set() {
      return false;
    },
  });
}

function writeDescription(adapter, owner, id, add) {
  const current = adapter.getDescription(owner);
  const next = add
    ? addDescriptionToken(current, id)
    : removeDescriptionToken(current, id);
  if (next === null) adapter.removeDescription(owner);
  else adapter.setDescription(owner, next);
}

function environmentFor(record) {
  const {
    adapter,
    document,
    documentLease,
    observerInstall,
    portalInstall,
    root,
    rootId,
    scopedShared,
    styleLease,
  } = record;
  const mirrors = record.mirrors;
  const knownMirrors = record.knownMirrors;
  const passiveLease = Object.freeze({
    shared: scopedShared,
    release() {},
  });

  function requireActive(operation) {
    if (record.phase !== 'active') {
      throw stateError(
        new TypeError(`Shadow root resources cannot ${operation} after release`),
        { operation },
      );
    }
  }

  function allocateId(prefix = `${rootId}-mirror`) {
    requireActive('allocate ID');
    return adapter.allocateId(documentLease.shared, root, prefix);
  }

  function createOwnedMirror(owner, text) {
    requireActive('create mirror');
    if (!adapter.ownerBelongsToRoot(owner, root)) {
      throw new TypeError('mirror owner must belong to the exact ShadowRoot');
    }
    if (typeof text !== 'string') {
      throw new TypeError('mirror text must be a string');
    }
    const id = allocateId();
    let mirror;
    try {
      mirror = adapter.createMirror(root, id, text);
      if (mirror === null || (typeof mirror !== 'object' && typeof mirror !== 'function')) {
        throw new TypeError('mirror creation returned an invalid node');
      }
      writeDescription(adapter, owner, id, true);
    } catch (error) {
      if (mirror !== undefined) {
        try { writeDescription(adapter, owner, id, false); } catch {}
        try { adapter.removeMirror(mirror); } catch {}
      }
      throw stateError(error, { operation: 'create mirror' });
    }
    const entry = { id, mirror, owner };
    mirrors.set(mirror, entry);
    knownMirrors.add(mirror);
    return mirror;
  }

  function updateOwnedMirror(mirror, text) {
    requireActive('update mirror');
    if (!mirrors.has(mirror)) {
      throw new TypeError('mirror must be an active owned mirror');
    }
    if (typeof text !== 'string') {
      throw new TypeError('mirror text must be a string');
    }
    adapter.updateMirror(mirror, text);
  }

  function removeEntry(entry) {
    mirrors.delete(entry.mirror);
    let failure;
    try {
      writeDescription(adapter, entry.owner, entry.id, false);
    } catch (error) {
      failure = error;
    }
    try {
      adapter.removeMirror(entry.mirror);
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }

  function removeOwnedMirror(mirror) {
    requireActive('remove mirror');
    const entry = mirrors.get(mirror);
    if (entry === undefined) {
      if (knownMirrors.has(mirror)) return;
      throw new TypeError('mirror must be an owned mirror');
    }
    try {
      removeEntry(entry);
    } catch (error) {
      throw stateError(error, { operation: 'remove mirror' });
    }
  }

  record.removeMirrorEntry = removeEntry;

  return Object.freeze({
    root,
    document,
    styleLease,
    rootId,
    lease: passiveLease,
    shared: scopedShared,
    documentShared: documentLease.shared,
    portal: portalInstall.overlay,
    svgLayer: portalInstall.svgLayer,
    noteLayer: portalInstall.noteLayer,
    observer: observerInstall.observer,
    observerTarget: root,
    allocateId,
    createMirror: createOwnedMirror,
    updateMirror: updateOwnedMirror,
    removeMirror: removeOwnedMirror,
    createEvent(type, detail, owner) {
      requireActive('dispatch event');
      return adapter.dispatch(owner, type, detail);
    },
  });
}

function leaseFor(root, record) {
  let released = false;
  return Object.freeze({
    environment: record.environment,
    release() {
      if (released) return;
      released = true;
      record.count -= 1;
      if (record.count !== 0) return;
      record.phase = 'releasing';

      let failure;
      const cleanup = (operation) => {
        try { operation(); } catch (error) { failure ??= error; }
      };
      cleanup(() => record.observerInstall.release());
      for (const entry of [...record.mirrors.values()]) {
        cleanup(() => record.removeMirrorEntry(entry));
      }
      cleanup(() => record.unregisterPortal());
      cleanup(() => record.portalInstall.release());
      cleanup(() => record.documentLease.release());
      record.phase = 'released';
      releaseShadowRootSlot(root, 'resources', record);
      if (failure !== undefined) {
        throw stateError(failure, { operation: 'release' });
      }
    },
  });
}

export function acquireShadowResources(root, styleLease, adapter = undefined) {
  validateStyleLease(styleLease);
  const activeAdapter = adapter ?? browserAdapter();
  try {
    activeAdapter.assertRoot(root);
  } catch (cause) {
    if (adapter === undefined) throw cause;
    throw stateError(cause, { operation: 'acquire' });
  }

  const existing = runtimeState.shadows.get(root)?.resources ?? null;
  if (existing !== null) {
    if (existing.phase !== 'active') {
      throw stateError(
        new TypeError('Shadow root resources are being released'),
        { operation: 'acquire', phase: existing.phase },
      );
    }
    existing.count += 1;
    return leaseFor(root, existing);
  }

  const document = root.ownerDocument;
  let documentLease;
  let portalInstall;
  let observerInstall;
  let record;
  let unregisterPortal = () => {};
  try {
    documentLease = validateDocumentLease(
      activeAdapter.acquireDocumentResources(document),
    );
    const rootId = activeAdapter.allocateId(
      documentLease.shared,
      root,
      'hana-shadow-root',
    );
    portalInstall = validateInstall(
      activeAdapter.createPortal(document, root, rootId),
      'portal',
    );
    if (typeof activeAdapter.registerPortal === 'function') {
      unregisterPortal = activeAdapter.registerPortal(
        documentLease.shared,
        portalInstall.overlay,
      );
      if (typeof unregisterPortal !== 'function') {
        throw new TypeError('portal registration returned an invalid release function');
      }
    }
    observerInstall = validateInstall(
      activeAdapter.createMutationObserver(root, (records) => {
        if (record?.phase !== 'active') return;
        activeAdapter.signalMutations(
          documentLease.shared,
          records,
          root,
          portalInstall.overlay,
        );
      }),
      'MutationObserver',
    );
    const scopedShared = createScopedShared(
      documentLease.shared,
      root,
      portalInstall,
    );
    record = {
      adapter: activeAdapter,
      count: 1,
      document,
      documentLease,
      environment: null,
      knownMirrors: new WeakSet(),
      mirrors: new Map(),
      observerInstall,
      phase: 'active',
      portalInstall,
      removeMirrorEntry: null,
      root,
      rootId,
      scopedShared,
      styleLease,
      unregisterPortal,
    };
    record.environment = environmentFor(record);
    claimShadowRootSlot(root, 'resources', record);
    return leaseFor(root, record);
  } catch (cause) {
    let rollbackCause;
    const cleanup = (operation) => {
      if (operation === null) return;
      try { operation(); } catch (error) { rollbackCause ??= error; }
    };
    cleanup(observerInstall === undefined ? null : () => observerInstall.release());
    cleanup(() => unregisterPortal());
    cleanup(portalInstall === undefined ? null : () => portalInstall.release());
    cleanup(documentLease === undefined ? null : () => documentLease.release());
    throw stateError(cause, rollbackCause === undefined
      ? { operation: 'acquire' }
      : { operation: 'acquire', rollbackCause });
  }
}
