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

function connectedRange(value, root) {
  const message = 'Resolved key must be a connected Range in the target Document';
  return reflectionBoundary(() => {
    const RangeConstructor = root.defaultView.Range;
    if (!(value instanceof RangeConstructor)) {
      targetError(message, { target: value });
    }
    const boundaries = [value.startContainer, value.endContainer];
    if (!boundaries.every((node) => (
      node === root
        || (node?.ownerDocument === root
          && node.isConnected
          && node.getRootNode?.() === root)
    ))) {
      targetError(message, { target: value });
    }
    const clone = resolveTarget(value, root).range;
    if (!(clone instanceof RangeConstructor)
      || clone === value
      || clone.startContainer !== value.startContainer
      || clone.endContainer !== value.endContainer
      || clone.startOffset !== value.startOffset
      || clone.endOffset !== value.endOffset) {
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
