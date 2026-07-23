import { HanamaruTargetError } from './errors.js';
import {
  createElementTargetRecord,
  createLocatorRange,
  createLocatorTargetRecord,
  createRangeTargetRecord,
  createSelectorTargetRecord,
  queryUniqueTarget,
  readLocatorConfig,
} from './target.js';

function targetError(message, details) {
  return new HanamaruTargetError('HANA_TARGET_INVALID', message, details);
}

function prototypeDescriptor(start, key) {
  let prototype = start;
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (descriptor !== undefined) return descriptor;
    prototype = Object.getPrototypeOf(prototype);
  }
  return undefined;
}

function propertyReader(prototype, key) {
  const getter = prototypeDescriptor(prototype, key)?.get;
  if (typeof getter !== 'function') {
    throw new TypeError(`Missing DOM property getter: ${key}`);
  }
  return (value) => Reflect.apply(getter, value, []);
}

function methodReader(prototype, key) {
  const method = prototypeDescriptor(prototype, key)?.value;
  if (typeof method !== 'function') {
    throw new TypeError(`Missing DOM method: ${key}`);
  }
  return (value, ...args) => Reflect.apply(method, value, args);
}

function captureGetter(constructor, key) {
  if (typeof constructor !== 'function') return null;
  const getter = Object.getOwnPropertyDescriptor(constructor.prototype, key)?.get;
  return typeof getter === 'function' ? getter : null;
}

function captureMethod(constructor, key) {
  if (typeof constructor !== 'function') return null;
  const method = Object.getOwnPropertyDescriptor(constructor.prototype, key)?.value;
  return typeof method === 'function' ? method : null;
}

function serverHarnessDataProperty(value, key) {
  if (typeof globalThis.window !== 'undefined'
    || value === null
    || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  try {
    let current = value;
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined) {
        return Object.hasOwn(descriptor, 'value')
          ? descriptor.value
          : undefined;
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

let ownerDocumentGetter = null;
let defaultViewGetter = null;
let shadowHostGetter = null;
let nodeTypeGetter = null;
let getRootNodeMethod = null;

function captureMissingDomIntrinsics() {
  ownerDocumentGetter ??= captureGetter(globalThis.Node, 'ownerDocument');
  defaultViewGetter ??= captureGetter(globalThis.Document, 'defaultView');
  shadowHostGetter ??= captureGetter(globalThis.ShadowRoot, 'host');
  nodeTypeGetter ??= captureGetter(globalThis.Node, 'nodeType');
  getRootNodeMethod ??= captureMethod(globalThis.Node, 'getRootNode');
}

captureMissingDomIntrinsics();

function initialOwnerDocument(value) {
  captureMissingDomIntrinsics();
  if (ownerDocumentGetter === null) {
    throw new TypeError('Native Node ownerDocument getter is unavailable');
  }
  return Reflect.apply(ownerDocumentGetter, value, []);
}

function initialDefaultView(document) {
  captureMissingDomIntrinsics();
  if (defaultViewGetter === null) {
    throw new TypeError('Native Document defaultView getter is unavailable');
  }
  return Reflect.apply(defaultViewGetter, document, []);
}

function initialShadowHost(root) {
  captureMissingDomIntrinsics();
  if (shadowHostGetter === null) {
    throw new TypeError('Native ShadowRoot host getter is unavailable');
  }
  return Reflect.apply(shadowHostGetter, root, []);
}

export function intrinsicOwnerDocumentOf(value) {
  captureMissingDomIntrinsics();
  if (ownerDocumentGetter === null) {
    return serverHarnessDataProperty(value, 'ownerDocument') ?? null;
  }
  try {
    return initialOwnerDocument(value);
  } catch {
    return null;
  }
}

export function intrinsicDocumentView(document) {
  captureMissingDomIntrinsics();
  if (defaultViewGetter === null) {
    return serverHarnessDataProperty(document, 'defaultView') ?? null;
  }
  try {
    return initialDefaultView(document);
  } catch {
    return null;
  }
}

export function intrinsicRootForNode(value) {
  captureMissingDomIntrinsics();
  if (getRootNodeMethod === null) {
    const fallback = serverHarnessDataProperty(value, 'getRootNode');
    if (typeof fallback !== 'function') return null;
    try {
      return Reflect.apply(fallback, value, []);
    } catch {
      return null;
    }
  }
  try {
    return Reflect.apply(getRootNodeMethod, value, []);
  } catch {
    return null;
  }
}

export function intrinsicRootKind(root) {
  captureMissingDomIntrinsics();
  if (shadowHostGetter !== null) {
    try {
      initialShadowHost(root);
      return 'shadow-root';
    } catch { /* Continue with other native root brands. */ }
  }
  if (defaultViewGetter !== null) {
    try {
      Reflect.apply(defaultViewGetter, root, []);
      return 'document';
    } catch { /* Continue with generic Node classification. */ }
  }
  if (nodeTypeGetter !== null) {
    try {
      if (Reflect.apply(nodeTypeGetter, root, []) === 11) {
        return 'document-fragment';
      }
    } catch { /* Non-Node values are unknown. */ }
  }
  if (shadowHostGetter === null
    && defaultViewGetter === null
    && nodeTypeGetter === null
    && typeof globalThis.window === 'undefined') {
    const nodeType = root?.nodeType;
    if (nodeType === 9) return 'document';
    if (nodeType === 11) {
      return root?.host === undefined
        ? 'document-fragment'
        : 'shadow-root';
    }
  }
  return 'unknown';
}

export function isNativeShadowRoot(root) {
  return intrinsicRootKind(root) === 'shadow-root';
}

function shadowContext(root) {
  try {
    const document = initialOwnerDocument(root);
    const realm = initialDefaultView(document);
    if (typeof realm?.ShadowRoot !== 'function'
      || typeof realm.Element !== 'function'
      || typeof realm.Range !== 'function'
      || !(root instanceof realm.ShadowRoot)) {
      throw new TypeError('Root is not a native ShadowRoot');
    }

    const nodePrototype = realm.Node.prototype;
    const shadowPrototype = realm.ShadowRoot.prototype;
    const readers = {
      ownerDocument: propertyReader(nodePrototype, 'ownerDocument'),
      isConnected: propertyReader(nodePrototype, 'isConnected'),
      getRootNode: methodReader(nodePrototype, 'getRootNode'),
      parentElement: propertyReader(nodePrototype, 'parentElement'),
      host: propertyReader(shadowPrototype, 'host'),
    };
    const host = readers.host(root);
    if (!(host instanceof realm.Element)
      || readers.ownerDocument(root) !== document
      || readers.ownerDocument(host) !== document
      || !readers.isConnected(host)
      || readers.getRootNode(root) !== root) {
      throw new TypeError('ShadowRoot host is not connected');
    }

    const rangePrototype = realm.Range.prototype;
    return {
      root,
      document,
      realm,
      readers,
      rangeReaders: {
        startContainer: propertyReader(rangePrototype, 'startContainer'),
        endContainer: propertyReader(rangePrototype, 'endContainer'),
        commonAncestorContainer: propertyReader(rangePrototype, 'commonAncestorContainer'),
        cloneRange: methodReader(rangePrototype, 'cloneRange'),
      },
    };
  } catch (cause) {
    if (cause instanceof HanamaruTargetError) throw cause;
    throw targetError('Root must be a connected native ShadowRoot', { root, cause });
  }
}

export function assertShadowRoot(root) {
  shadowContext(root);
  return root;
}

export function shadowDomIntrinsics(root) {
  const context = shadowContext(root);
  const elementPrototype = context.realm.Element.prototype;
  const eventTargetPrototype = context.realm.EventTarget.prototype;
  const getAttribute = methodReader(elementPrototype, 'getAttribute');
  const setAttribute = methodReader(elementPrototype, 'setAttribute');
  const removeAttribute = methodReader(elementPrototype, 'removeAttribute');
  const dispatchEvent = methodReader(eventTargetPrototype, 'dispatchEvent');
  return Object.freeze({
    document: context.document,
    view: context.realm,
    assertElement(element) {
      assertExactElement(element, context);
      return element;
    },
    getAttribute(element, name) {
      return getAttribute(element, name);
    },
    setAttribute(element, name, value) {
      return setAttribute(element, name, value);
    },
    removeAttribute(element, name) {
      return removeAttribute(element, name);
    },
    dispatch(element, type, detail) {
      assertExactElement(element, context);
      return dispatchEvent(element, new context.realm.CustomEvent(type, {
        detail,
        bubbles: true,
        composed: true,
      }));
    },
    dispatchFromHost(type, detail) {
      return dispatchEvent(
        context.readers.host(context.root),
        new context.realm.CustomEvent(type, {
          detail,
          bubbles: true,
          composed: true,
        }),
      );
    },
  });
}

function assertExactElement(element, context) {
  const { document, realm, readers, root } = context;
  try {
    if (!(element instanceof realm.Element)
      || readers.ownerDocument(element) !== document
      || !readers.isConnected(element)
      || readers.getRootNode(element) !== root) {
      throw new TypeError('Element does not belong to the exact ShadowRoot');
    }
  } catch (cause) {
    if (cause instanceof HanamaruTargetError) throw cause;
    throw targetError(
      'Target Element must belong to and be connected to the exact ShadowRoot',
      { target: element, root, cause },
    );
  }
}

function assertExactBoundary(node, context) {
  const { document, readers, root } = context;
  return readers.ownerDocument(node) === document
    && readers.isConnected(node)
    && readers.getRootNode(node) === root;
}

function rangeBoundaries(range, context) {
  return [
    context.rangeReaders.startContainer(range),
    context.rangeReaders.endContainer(range),
  ];
}

function assertExactRange(range, context) {
  const { realm, root } = context;
  try {
    if (!(range instanceof realm.Range)
      || !rangeBoundaries(range, context)
        .every((node) => assertExactBoundary(node, context))) {
      throw new TypeError('Range boundaries do not belong to the exact ShadowRoot');
    }
  } catch (cause) {
    if (cause instanceof HanamaruTargetError) throw cause;
    throw targetError(
      'Target Range boundaries must belong to and be connected to the exact ShadowRoot',
      { target: range, root, cause },
    );
  }
}

function rangeOwnerElement(range, context) {
  const { realm, readers, root } = context;
  try {
    const ancestor = context.rangeReaders.commonAncestorContainer(range);
    const owner = ancestor instanceof realm.Element
      ? ancestor
      : readers.parentElement(ancestor);
    if (!(owner instanceof realm.Element)) {
      throw new TypeError('Range has no Element owner inside the ShadowRoot');
    }
    assertExactElement(owner, context);
    return owner;
  } catch (cause) {
    if (cause instanceof HanamaruTargetError) throw cause;
    throw targetError(
      'Target Range must have an Element owner in the exact ShadowRoot',
      { target: range, root, cause },
    );
  }
}

function inspectTarget(target, context) {
  try {
    if (target instanceof context.realm.Element) {
      return { kind: 'element' };
    }
    if (target instanceof context.realm.Range) {
      return { kind: 'range' };
    }
    const config = readLocatorConfig(target, context.realm);
    return config === null
      ? { kind: 'invalid' }
      : { kind: 'locator', config };
  } catch (cause) {
    throw targetError(
      'Shadow target inspection failed',
      { target, root: context.root, cause },
    );
  }
}

export function resolveShadowTarget(target, root) {
  const context = shadowContext(root);
  const findElement = (selector) => queryUniqueTarget(
    selector,
    context.root,
    (element) => assertExactElement(element, context),
  );
  if (typeof target === 'string') {
    return createSelectorTargetRecord(target, findElement);
  }
  const inspected = inspectTarget(target, context);
  if (inspected.kind === 'element') {
    assertExactElement(target, context);
    return createElementTargetRecord(
      target,
      (value) => assertExactElement(value, context),
    );
  }
  if (inspected.kind === 'range') {
    return createRangeTargetRecord(target, {
      assertRange: (range) => assertExactRange(range, context),
      cloneRange: (range) => context.rangeReaders.cloneRange(range),
      getOwnerElement: (range) => rangeOwnerElement(range, context),
      getBoundaryNodes: (range) => rangeBoundaries(range, context),
      assertBoundaryNodes(boundaryNodes, range) {
        try {
          if (!boundaryNodes.every((node) => assertExactBoundary(node, context))) {
            throw new TypeError('Range boundaries left the exact ShadowRoot');
          }
        } catch (cause) {
          if (cause instanceof HanamaruTargetError) throw cause;
          throw targetError(
            'Target Range boundaries are no longer connected to the exact ShadowRoot',
            { target: range, root, cause },
          );
        }
      },
    });
  }
  if (inspected.kind === 'locator') {
    return createLocatorTargetRecord(inspected.config, {
      resolveWithin(within) {
        if (typeof within === 'string') return findElement(within);
        if (within instanceof context.realm.Element) {
          assertExactElement(within, context);
          return within;
        }
        throw targetError(
          'Text locator within must be an exact-root Element or selector',
          { within, root },
        );
      },
      assertWithin: (within) => assertExactElement(within, context),
      createRange(within, text, occurrence) {
        const range = createLocatorRange(
          within,
          text,
          occurrence,
          context.document,
        );
        assertExactRange(range, context);
        rangeOwnerElement(range, context);
        return range;
      },
    });
  }
  throw targetError(
    'Shadow target must be an Element, selector, locator, or Range',
    { target, root },
  );
}
