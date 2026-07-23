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

function initialOwnerDocument(value) {
  const NodeConstructor = globalThis.Node;
  if (typeof NodeConstructor !== 'function') throw new TypeError('DOM Node is unavailable');
  return propertyReader(NodeConstructor.prototype, 'ownerDocument')(value);
}

function shadowContext(root) {
  try {
    const document = initialOwnerDocument(root);
    const realm = document?.defaultView;
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
  if (target instanceof context.realm.Element) {
    assertExactElement(target, context);
    return createElementTargetRecord(
      target,
      (value) => assertExactElement(value, context),
    );
  }
  if (target instanceof context.realm.Range) {
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
  const config = readLocatorConfig(target, context.realm);
  if (config !== null) {
    return createLocatorTargetRecord(config, {
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
