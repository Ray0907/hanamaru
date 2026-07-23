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
import { assertShadowStyleLease } from './shadow-styles.js';
import { shadowDomIntrinsics } from './shadow-target.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function stateError(cause, details = {}) {
  return new HanamaruStateError(
    'HANA_STATE_SHADOW_RESOURCES',
    'Shadow root resources could not be managed',
    { ...details, cause },
  );
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

function createMutationObserver(root, host, notify, roots = [root]) {
  const Observer = root.ownerDocument.defaultView.MutationObserver;
  if (typeof Observer !== 'function') {
    throw new TypeError('Shadow resources require MutationObserver');
  }
  const observer = new Observer(notify);
  try {
    for (const observedRoot of roots) {
      observer.observe(observedRoot, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-describedby'],
      });
    }
    observer.observe(host, {
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-describedby'],
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

function releaseRawRecord(raw) {
  if (raw === null || (typeof raw !== 'object' && typeof raw !== 'function')) {
    return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(raw, 'release');
  if (descriptor !== undefined
    && Object.hasOwn(descriptor, 'value')
    && typeof descriptor.value === 'function') {
    Reflect.apply(descriptor.value, raw, []);
  }
}

function browserAdapter() {
  const roots = new WeakMap();
  const contextFor = (root) => {
    const context = roots.get(root);
    if (context === undefined) {
      throw new TypeError('Shadow root was not validated');
    }
    return context;
  };
  return {
    assertRoot(root) {
      const context = shadowDomIntrinsics(root);
      roots.set(root, context);
    },
    documentForRoot(root) {
      return contextFor(root).document;
    },
    hostForRoot(root) {
      return contextFor(root).host;
    },
    layoutDependenciesForRoot(root) {
      return contextFor(root).layoutDependencies;
    },
    viewForRoot(root) {
      return contextFor(root).view;
    },
    acquireDocumentResources: acquireDocumentScheduler,
    rollbackDocumentResources(_document, raw) {
      releaseRawRecord(raw);
    },
    allocateId: allocateDocumentResourceId,
    createPortal,
    rollbackPortal(_root, raw) {
      releaseRawRecord(raw);
    },
    createMutationObserver(root, notify, layoutDependencies) {
      return createMutationObserver(
        root,
        contextFor(root).host,
        notify,
        layoutDependencies.roots,
      );
    },
    rollbackObserver(_root, raw) {
      releaseRawRecord(raw);
    },
    createMirror,
    updateMirror(mirror, text) {
      mirror.textContent = text;
    },
    ensureMirror(root, mirror, id, text) {
      if (mirror.getRootNode() !== root) root.append(mirror);
      if (mirror.className !== 'hana-shadow-mirror') {
        mirror.className = 'hana-shadow-mirror';
      }
      if (!mirror.hasAttribute('data-hana-shadow-mirror')) {
        mirror.setAttribute('data-hana-shadow-mirror', '');
      }
      if (mirror.id !== id) mirror.id = id;
      if (mirror.textContent !== text) mirror.textContent = text;
    },
    removeMirror(mirror) {
      mirror.remove();
    },
    getDescription(owner, root) {
      return contextFor(root).getAttribute(owner, 'aria-describedby');
    },
    setDescription(owner, value, root) {
      contextFor(root).setAttribute(owner, 'aria-describedby', value);
    },
    removeDescription(owner, root) {
      contextFor(root).removeAttribute(owner, 'aria-describedby');
    },
    ownerBelongsToRoot(owner, root) {
      try {
        contextFor(root).assertElement(owner);
        return true;
      } catch {
        return false;
      }
    },
    dispatch(owner, type, detail, root) {
      return contextFor(root).dispatch(owner, type, detail);
    },
    dispatchFromHost(type, detail, root) {
      return contextFor(root).dispatchFromHost(type, detail);
    },
    registerPortal: registerDocumentResourcePortal,
    signalMutations(shared, records, root, _portal, host) {
      signalDocumentResourceMutations(shared, records, root, host);
    },
  };
}

function ownDataValue(raw, key, kind, validate) {
  const descriptor = Object.getOwnPropertyDescriptor(raw, key);
  if (descriptor === undefined
    || !Object.hasOwn(descriptor, 'value')
    || !validate(descriptor.value)) {
    throw new TypeError(`${kind} installation returned an invalid record`);
  }
  return descriptor.value;
}

function objectValue(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function validateDocumentLease(raw) {
  const kind = 'Document resource';
  if (!objectValue(raw)) {
    throw new TypeError(`${kind} installation returned an invalid record`);
  }
  const shared = ownDataValue(raw, 'shared', kind, objectValue);
  const releaseMethod = ownDataValue(raw, 'release', kind, (value) => (
    typeof value === 'function'
  ));
  let released = false;
  return Object.freeze({
    shared,
    release() {
      if (released) return;
      released = true;
      return Reflect.apply(releaseMethod, raw, []);
    },
  });
}

function validateInstall(raw, kind, fields) {
  if (!objectValue(raw)) {
    throw new TypeError(`${kind} installation returned an invalid record`);
  }
  const snapshot = {};
  for (const field of fields) {
    snapshot[field] = ownDataValue(raw, field, kind, objectValue);
  }
  const releaseMethod = ownDataValue(raw, 'release', kind, (value) => (
    typeof value === 'function'
  ));
  let released = false;
  return Object.freeze({
    ...snapshot,
    release() {
      if (released) return;
      released = true;
      return Reflect.apply(releaseMethod, raw, []);
    },
  });
}

function rollbackRaw(activeAdapter, method, context, raw, install) {
  if (typeof activeAdapter[method] === 'function') {
    return Reflect.apply(activeAdapter[method], activeAdapter, [context, raw]);
  }
  if (install !== undefined) return install.release();
  return releaseRawRecord(raw);
}

function createScopedShared(documentShared, root, host, portal, layoutDependencies) {
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
            layoutDependencies,
            mutationHost: host,
            mutationRoot: root,
          }));
        }
        return methodCache.get(key);
      }
      if (key === 'rebindLayout') {
        if (!methodCache.has(key)) {
          methodCache.set(key, (id, options) => documentShared.rebindLayout(id, {
            ...options,
            layoutDependencies,
            mutationHost: host,
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

function writeDescription(adapter, root, owner, id, add) {
  const current = adapter.getDescription(owner, root);
  const next = add
    ? addDescriptionToken(current, id)
    : removeDescriptionToken(current, id);
  if (next === null) adapter.removeDescription(owner, root);
  else adapter.setDescription(owner, next, root);
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
    styleConfig,
    host,
    view,
  } = record;
  const mirrors = record.mirrors;
  const knownMirrors = record.knownMirrors;
  const pendingMirrors = record.pendingMirrors;
  const passiveLease = Object.freeze({
    shared: scopedShared,
    release() {},
  });

  function requireActive(operation) {
    if (record.phase !== 'active'
      || runtimeState.shadows.get(root)?.resources !== record) {
      throw stateError(
        new TypeError(`Shadow root resources cannot ${operation} after release`),
        { operation },
      );
    }
  }

  function beginOperation(operation) {
    requireActive(operation);
    if (record.operation !== null) {
      throw stateError(
        new TypeError(`Shadow root resources cannot reenter ${operation}`),
        { operation },
      );
    }
    const token = {};
    record.operation = token;
    return token;
  }

  function operationIsCurrent(token) {
    return record.phase === 'active'
      && record.operation === token
      && runtimeState.shadows.get(root)?.resources === record;
  }

  function assertOperation(token, operation) {
    if (!operationIsCurrent(token)) {
      throw stateError(
        new TypeError(`Shadow root resources changed during ${operation}`),
        { operation },
      );
    }
  }

  function endOperation(token) {
    if (record.operation === token) record.operation = null;
  }

  function operationError(error, operation) {
    return error instanceof HanamaruStateError
      && error.code === 'HANA_STATE_SHADOW_RESOURCES'
      ? error
      : stateError(error, { operation });
  }

  function allocateId(prefix = `${rootId}-mirror`) {
    const operation = 'allocate ID';
    const token = beginOperation(operation);
    try {
      const id = adapter.allocateId(documentLease.shared, root, prefix);
      assertOperation(token, operation);
      return id;
    } catch (error) {
      throw operationError(error, operation);
    } finally {
      endOperation(token);
    }
  }

  function writeDescriptionDuringOperation(owner, id, add, token, operation) {
    const current = adapter.getDescription(owner, root);
    assertOperation(token, operation);
    const next = add
      ? addDescriptionToken(current, id)
      : removeDescriptionToken(current, id);
    if (next !== current) {
      if (next === null) adapter.removeDescription(owner, root);
      else adapter.setDescription(owner, next, root);
    }
    assertOperation(token, operation);
  }

  function createOwnedMirror(owner, text) {
    const operation = 'create mirror';
    const token = beginOperation(operation);
    let belongs;
    try {
      belongs = adapter.ownerBelongsToRoot(owner, root);
      assertOperation(token, operation);
    } catch (error) {
      endOperation(token);
      throw operationError(error, operation);
    }
    if (!belongs) {
      endOperation(token);
      throw new TypeError('mirror owner must belong to the exact ShadowRoot');
    }
    if (typeof text !== 'string') {
      endOperation(token);
      throw new TypeError('mirror text must be a string');
    }
    const entry = {
      descriptionCleaned: false,
      id: null,
      mirror: null,
      mirrorCleaned: false,
      owner,
    };
    pendingMirrors.add(entry);
    try {
      entry.id = adapter.allocateId(
        documentLease.shared,
        root,
        `${rootId}-mirror`,
      );
      assertOperation(token, operation);
      entry.mirror = adapter.createMirror(root, entry.id, text);
      if (entry.mirror === null
        || (typeof entry.mirror !== 'object' && typeof entry.mirror !== 'function')) {
        throw new TypeError('mirror creation returned an invalid node');
      }
      assertOperation(token, operation);
      writeDescriptionDuringOperation(
        owner,
        entry.id,
        true,
        token,
        operation,
      );
      mirrors.set(entry.mirror, entry);
      knownMirrors.add(entry.mirror);
      pendingMirrors.delete(entry);
      return entry.mirror;
    } catch (error) {
      try { removeEntry(entry); } catch {}
      throw operationError(error, operation);
    } finally {
      pendingMirrors.delete(entry);
      endOperation(token);
    }
  }

  function updateOwnedMirror(mirror, text) {
    const operation = 'update mirror';
    const token = beginOperation(operation);
    if (!mirrors.has(mirror)) {
      endOperation(token);
      throw new TypeError('mirror must be an active owned mirror');
    }
    if (typeof text !== 'string') {
      endOperation(token);
      throw new TypeError('mirror text must be a string');
    }
    try {
      adapter.updateMirror(mirror, text);
      assertOperation(token, operation);
    } catch (error) {
      throw operationError(error, operation);
    } finally {
      endOperation(token);
    }
  }

  function ensureOwnedMirror(mirror, text) {
    const operation = 'ensure mirror';
    const token = beginOperation(operation);
    const entry = mirrors.get(mirror);
    if (entry === undefined) {
      endOperation(token);
      throw new TypeError('mirror must be an active owned mirror');
    }
    if (typeof text !== 'string') {
      endOperation(token);
      throw new TypeError('mirror text must be a string');
    }
    try {
      if (typeof adapter.ensureMirror === 'function') {
        adapter.ensureMirror(root, entry.mirror, entry.id, text);
      } else {
        adapter.updateMirror(entry.mirror, text);
      }
      assertOperation(token, operation);
      writeDescriptionDuringOperation(
        entry.owner,
        entry.id,
        true,
        token,
        operation,
      );
      return entry.mirror;
    } catch (error) {
      try { removeEntry(entry); } catch {}
      throw operationError(error, operation);
    } finally {
      endOperation(token);
    }
  }

  function removeEntry(entry) {
    mirrors.delete(entry.mirror);
    pendingMirrors.delete(entry);
    let failure;
    if (entry.id !== null && !entry.descriptionCleaned) {
      entry.descriptionCleaned = true;
      try {
        writeDescription(adapter, root, entry.owner, entry.id, false);
      } catch (error) {
        failure = error;
      }
    }
    if (entry.mirror !== null && !entry.mirrorCleaned) {
      entry.mirrorCleaned = true;
      try {
        adapter.removeMirror(entry.mirror);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  function removeOwnedMirror(mirror) {
    const operation = 'remove mirror';
    const token = beginOperation(operation);
    const entry = mirrors.get(mirror);
    if (entry === undefined) {
      endOperation(token);
      if (knownMirrors.has(mirror)) return;
      throw new TypeError('mirror must be an owned mirror');
    }
    mirrors.delete(mirror);
    pendingMirrors.add(entry);
    try {
      writeDescriptionDuringOperation(
        entry.owner,
        entry.id,
        false,
        token,
        operation,
      );
      entry.descriptionCleaned = true;
      adapter.removeMirror(entry.mirror);
      assertOperation(token, operation);
      entry.mirrorCleaned = true;
      pendingMirrors.delete(entry);
    } catch (error) {
      try { removeEntry(entry); } catch {}
      throw operationError(error, operation);
    } finally {
      pendingMirrors.delete(entry);
      endOperation(token);
    }
  }

  record.removeMirrorEntry = removeEntry;

  return Object.freeze({
    root,
    host,
    document,
    view,
    styleConfig,
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
    ensureMirror: ensureOwnedMirror,
    updateMirror: updateOwnedMirror,
    removeMirror: removeOwnedMirror,
    createEvent(type, detail, owner) {
      requireActive('dispatch event');
      return adapter.dispatch(owner, type, detail, root);
    },
    createErrorEvent(type, detail, owner) {
      try {
        requireActive('dispatch error event');
      } catch {
        return false;
      }
      try {
        return adapter.dispatch(owner, type, detail, root);
      } catch {
        try {
          return adapter.dispatchFromHost?.(type, detail, root) ?? false;
        } catch {
          // Lifecycle error reporting must never replace the original failure.
          return false;
        }
      }
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
      for (const entry of [...record.pendingMirrors]) {
        cleanup(() => record.removeMirrorEntry(entry));
      }
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
  const activeAdapter = adapter ?? browserAdapter();
  try {
    activeAdapter.assertRoot(root);
  } catch (cause) {
    if (adapter === undefined) throw cause;
    throw stateError(cause, { operation: 'acquire' });
  }
  const styleConfig = assertShadowStyleLease(root, styleLease);

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

  const document = typeof activeAdapter.documentForRoot === 'function'
    ? activeAdapter.documentForRoot(root)
    : root.ownerDocument;
  const view = typeof activeAdapter.viewForRoot === 'function'
    ? activeAdapter.viewForRoot(root)
    : document?.defaultView;
  const host = typeof activeAdapter.hostForRoot === 'function'
    ? activeAdapter.hostForRoot(root)
    : null;
  const layoutDependencies = typeof activeAdapter.layoutDependenciesForRoot === 'function'
    ? activeAdapter.layoutDependenciesForRoot(root)
    : Object.freeze({
      ancestors: Object.freeze(host === null ? [] : [host]),
      hosts: Object.freeze(host === null ? [] : [host]),
      preceding: Object.freeze([]),
      roots: Object.freeze([root]),
    });
  let rawDocumentLease;
  let rawPortalInstall;
  let rawObserverInstall;
  let hasRawDocumentLease = false;
  let hasRawPortalInstall = false;
  let hasRawObserverInstall = false;
  let documentLease;
  let portalInstall;
  let observerInstall;
  let record;
  let unregisterPortal = () => {};
  try {
    rawDocumentLease = activeAdapter.acquireDocumentResources(document);
    hasRawDocumentLease = true;
    documentLease = validateDocumentLease(rawDocumentLease);
    const rootId = activeAdapter.allocateId(
      documentLease.shared,
      root,
      'hana-shadow-root',
    );
    rawPortalInstall = activeAdapter.createPortal(document, root, rootId);
    hasRawPortalInstall = true;
    portalInstall = validateInstall(
      rawPortalInstall,
      'portal',
      ['overlay', 'svgLayer', 'noteLayer'],
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
    rawObserverInstall = activeAdapter.createMutationObserver(root, (records) => {
      if (record?.phase !== 'active') return;
      activeAdapter.signalMutations(
        documentLease.shared,
        records,
        root,
        portalInstall.overlay,
        ...(host === null ? [] : [host]),
      );
    }, layoutDependencies);
    hasRawObserverInstall = true;
    observerInstall = validateInstall(
      rawObserverInstall,
      'MutationObserver',
      ['observer'],
    );
    const scopedShared = createScopedShared(
      documentLease.shared,
      root,
      host,
      portalInstall,
      layoutDependencies,
    );
    record = {
      adapter: activeAdapter,
      count: 1,
      document,
      documentLease,
      environment: null,
      host,
      knownMirrors: new WeakSet(),
      layoutDependencies,
      mirrors: new Map(),
      observerInstall,
      operation: null,
      pendingMirrors: new Set(),
      phase: 'active',
      portalInstall,
      removeMirrorEntry: null,
      root,
      rootId,
      scopedShared,
      styleConfig,
      unregisterPortal,
      view,
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
    cleanup(!hasRawObserverInstall ? null : () => rollbackRaw(
      activeAdapter,
      'rollbackObserver',
      root,
      rawObserverInstall,
      observerInstall,
    ));
    cleanup(() => unregisterPortal());
    cleanup(!hasRawPortalInstall ? null : () => rollbackRaw(
      activeAdapter,
      'rollbackPortal',
      root,
      rawPortalInstall,
      portalInstall,
    ));
    cleanup(!hasRawDocumentLease ? null : () => rollbackRaw(
      activeAdapter,
      'rollbackDocumentResources',
      document,
      rawDocumentLease,
      documentLease,
    ));
    throw stateError(cause, rollbackCause === undefined
      ? { operation: 'acquire' }
      : { operation: 'acquire', rollbackCause });
  }
}
