import {
  HanamaruConfigError,
  HanamaruTargetError,
} from './errors.js';
import { validateSerializedTarget } from './serialize-schema.js';
import { resolveTarget } from './target.js';

function configError(field, value) {
  throw new HanamaruConfigError(
    'HANA_CONFIG_SERIALIZE_TARGET',
    `Invalid serialization target configuration: ${field}`,
    { field, value },
  );
}

function targetError(message, details) {
  throw new HanamaruTargetError('HANA_TARGET_INVALID', message, details);
}

function activeDocument(root) {
  if (root?.nodeType === 11 && root?.host !== undefined) {
    throw new HanamaruTargetError(
      'HANA_TARGET_SHADOW_UNSCOPED',
      'Serialized targets require an explicit Shadow scope',
      { root },
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
}

function executionContext(input, allowed) {
  if (input === undefined) return {};
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
}

function connectedElement(value, root) {
  const ElementConstructor = root.defaultView.Element;
  if (!(value instanceof ElementConstructor)
    || value.ownerDocument !== root
    || !value.isConnected
    || value.getRootNode() !== root) {
    targetError('Resolved key must be a connected Element in the target Document', { target: value });
  }
  return value;
}

function connectedRange(value, root) {
  const RangeConstructor = root.defaultView.Range;
  if (!(value instanceof RangeConstructor)) {
    targetError('Resolved key must be a connected Range in the target Document', { target: value });
  }
  const boundaries = [value.startContainer, value.endContainer];
  if (!boundaries.every((node) => (
    node === root
      || (node?.ownerDocument === root
        && node.isConnected
        && node.getRootNode?.() === root)
  ))) {
    targetError('Resolved key must be a connected Range in the target Document', { target: value });
  }
  let record;
  try {
    record = resolveTarget(value, root);
  } catch (cause) {
    if (cause instanceof HanamaruTargetError) throw cause;
    targetError('Resolved key must be a connected Range in the target Document', {
      target: value,
      cause,
    });
  }
  return record.range.cloneRange();
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
