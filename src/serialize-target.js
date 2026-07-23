import {
  HanamaruConfigError,
  HanamaruTargetError,
} from './errors.js';
import { validateSerializedTarget } from './serialize-schema.js';
import { resolveTarget } from './target.js';

const INTERNAL_ERRORS = new WeakMap();
let activeReflectionToken = null;

function reflectionBoundary(action, normalize) {
  const previousToken = activeReflectionToken;
  const token = {};
  activeReflectionToken = token;
  try {
    return action();
  } catch (cause) {
    if (INTERNAL_ERRORS.get(cause) === token) throw cause;
    return normalize(cause);
  } finally {
    activeReflectionToken = previousToken;
  }
}

function configError(field, value, cause = undefined) {
  const details = cause === undefined ? { field, value } : { field, value, cause };
  const error = new HanamaruConfigError(
    'HANA_CONFIG_SERIALIZE_TARGET',
    `Invalid serialization target configuration: ${field}`,
    details,
  );
  if (activeReflectionToken !== null) {
    INTERNAL_ERRORS.set(error, activeReflectionToken);
  }
  throw error;
}

function targetError(message, details, code = 'HANA_TARGET_INVALID') {
  const error = new HanamaruTargetError(code, message, details);
  if (activeReflectionToken !== null) {
    INTERNAL_ERRORS.set(error, activeReflectionToken);
  }
  throw error;
}

function activeDocument(root) {
  return reflectionBoundary(() => {
    if (root?.nodeType === 11 && root?.host !== undefined) {
      targetError(
        'Serialized targets require an explicit Shadow scope',
        { root },
        'HANA_TARGET_SHADOW_UNSCOPED',
      );
    }
    const DocumentConstructor = root?.defaultView?.Document;
    if (typeof DocumentConstructor !== 'function'
      || !(root instanceof DocumentConstructor)
      || root.nodeType !== 9
      || root.defaultView === null) {
      configError('root', root);
    }
    return root;
  }, (cause) => configError('root', root, cause));
}

function executionContext(input, allowed) {
  if (input === undefined) return {};
  return reflectionBoundary(() => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) configError('context', input);
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) {
      configError('context', input);
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const output = {};
    for (const key of keys) {
      if (!Object.hasOwn(descriptors[key], 'value')) configError(`context.${key}`, input);
      output[key] = descriptors[key].value;
    }
    return output;
  }, (cause) => configError('context', input, cause));
}

function connectedElement(value, root) {
  const message = 'Resolved key must be a connected Element in the target Document';
  return reflectionBoundary(() => {
    const ElementConstructor = root.defaultView.Element;
    if (!(value instanceof ElementConstructor)
      || value.ownerDocument !== root
      || !value.isConnected
      || value.getRootNode() !== root) {
      targetError(message, { target: value });
    }
    return value;
  }, (cause) => targetError(message, { target: value, cause }));
}

function prototypeDescriptor(Constructor, key) {
  let prototype = typeof Constructor === 'function' ? Constructor.prototype : null;
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (descriptor !== undefined) return descriptor;
    prototype = Object.getPrototypeOf(prototype);
  }
  return undefined;
}

function propertyReader(Constructor, key) {
  const getter = prototypeDescriptor(Constructor, key)?.get;
  return typeof getter === 'function'
    ? (value) => Reflect.apply(getter, value, [])
    : (value) => value?.[key];
}

function methodReader(Constructor, key) {
  const method = prototypeDescriptor(Constructor, key)?.value;
  return typeof method === 'function'
    ? (value) => Reflect.apply(method, value, [])
    : (value) => value?.[key]?.();
}

function connectedBoundary(node, root, readers) {
  return node === root
    || (readers.ownerDocument(node) === root
      && readers.isConnected(node)
      && readers.getRootNode(node) === root);
}

function rangeSnapshot(range, readers) {
  return {
    startContainer: readers.startContainer(range),
    endContainer: readers.endContainer(range),
    startOffset: readers.startOffset(range),
    endOffset: readers.endOffset(range),
    commonAncestorContainer: readers.commonAncestorContainer(range),
  };
}

function rangeOwner(ancestor, root, ElementConstructor, readers) {
  if (ancestor instanceof ElementConstructor) return ancestor;
  if (ancestor === root) return readers.documentElement(root);
  return readers.parentElement(ancestor);
}

function connectedRange(value, root) {
  const message = 'Resolved key must be a connected Range in the target Document';
  return reflectionBoundary(() => {
    const realm = root.defaultView;
    const RangeConstructor = realm.Range;
    const ElementConstructor = realm.Element;
    const rangeReaders = {
      startContainer: propertyReader(RangeConstructor, 'startContainer'),
      endContainer: propertyReader(RangeConstructor, 'endContainer'),
      startOffset: propertyReader(RangeConstructor, 'startOffset'),
      endOffset: propertyReader(RangeConstructor, 'endOffset'),
      commonAncestorContainer:
        propertyReader(RangeConstructor, 'commonAncestorContainer'),
    };
    const nodeReaders = {
      ownerDocument: propertyReader(realm.Node, 'ownerDocument'),
      isConnected: propertyReader(realm.Node, 'isConnected'),
      getRootNode: methodReader(realm.Node, 'getRootNode'),
      parentElement: propertyReader(realm.Node, 'parentElement'),
      documentElement: propertyReader(realm.Document, 'documentElement'),
    };
    if (!(value instanceof RangeConstructor)) {
      targetError(message, { target: value });
    }
    const original = rangeSnapshot(value, rangeReaders);
    if (![original.startContainer, original.endContainer]
      .every((node) => connectedBoundary(node, root, nodeReaders))) {
      targetError(message, { target: value });
    }
    const clone = resolveTarget(value, root).range;
    if (!(clone instanceof RangeConstructor)
      || clone === value) {
      throw new TypeError('Resolved Range clone must be a distinct equivalent Range');
    }
    const cloneSnapshot = rangeSnapshot(clone, rangeReaders);
    const cloneBoundaries = [
      cloneSnapshot.startContainer,
      cloneSnapshot.endContainer,
    ];
    const owner = rangeOwner(
      cloneSnapshot.commonAncestorContainer,
      root,
      ElementConstructor,
      nodeReaders,
    );
    if (!cloneBoundaries.every((node) => connectedBoundary(node, root, nodeReaders))
      || !(owner instanceof ElementConstructor)
      || nodeReaders.ownerDocument(owner) !== root
      || !nodeReaders.isConnected(owner)
      || nodeReaders.getRootNode(owner) !== root
      || cloneSnapshot.startContainer !== original.startContainer
      || cloneSnapshot.endContainer !== original.endContainer
      || cloneSnapshot.startOffset !== original.startOffset
      || cloneSnapshot.endOffset !== original.endOffset) {
      throw new TypeError('Resolved Range clone must be a distinct equivalent Range');
    }
    return clone;
  }, (cause) => targetError(message, { target: value, cause }));
}

function resolverContext(targetKind, role, controllerKind, index) {
  return { targetKind, role, controllerKind, index };
}

function resolveKey(target, root, resolveTargetCallback, context) {
  const protectedContext = resolverContext(
    context.targetKind,
    context.role,
    context.controllerKind,
    context.index,
  );
  if (typeof resolveTargetCallback !== 'function') {
    throw new HanamaruConfigError(
      'HANA_CONFIG_SERIALIZE_TARGET',
      'resolveTarget is required for serialized keys',
      { key: target.key, context: protectedContext },
    );
  }
  let resolved;
  try {
    resolved = resolveTargetCallback(
      target.key,
      resolverContext(
        protectedContext.targetKind,
        protectedContext.role,
        protectedContext.controllerKind,
        protectedContext.index,
      ),
    );
  } catch (cause) {
    throw new HanamaruTargetError(
      'HANA_TARGET_RESOLVER',
      `Serialized target resolver failed for key: ${target.key}`,
      { key: target.key, context: protectedContext, cause },
    );
  }
  return target.targetKind === 'element'
    ? connectedElement(resolved, root)
    : connectedRange(resolved, root);
}

export function resolveTargetSource(
  targetInput,
  {
    root,
    resolveTarget: resolveTargetCallback,
    role = 'target',
    controllerKind = null,
    index = null,
  },
) {
  const target = validateSerializedTarget(targetInput);
  const doc = activeDocument(root);
  if (target.type === 'selector') {
    const record = resolveTarget(target.selector, doc);
    return { resolved: record.element, source: target.selector };
  }
  if (target.type === 'key') {
    const context = resolverContext(target.targetKind, role, controllerKind, index);
    const resolved = resolveKey(target, doc, resolveTargetCallback, context);
    return { resolved, source: resolved };
  }

  let withinSource;
  if (target.within.type === 'selector') {
    withinSource = target.within.selector;
  } else {
    const context = resolverContext('element', 'within', controllerKind, index);
    withinSource = resolveKey(target.within, doc, resolveTargetCallback, context);
  }
  const source = { within: withinSource, text: target.text };
  if (Object.hasOwn(target, 'occurrence')) source.occurrence = target.occurrence;
  const record = resolveTarget(source, doc);
  return { resolved: record.range.cloneRange(), source };
}

export function resolveSerializedTarget(targetInput, contextInput = undefined) {
  const target = validateSerializedTarget(targetInput);
  const context = executionContext(contextInput, ['root', 'resolveTarget']);
  const root = Object.hasOwn(context, 'root') ? context.root : globalThis.document;
  return resolveTargetSource(target, {
    root,
    resolveTarget: context.resolveTarget,
  }).resolved;
}

export { activeDocument, executionContext };
