import {
  createAnnotation,
  createAnnotationEnvironment,
  normalizeOptions,
} from './annotation.js';
import { readControllerMetadata } from './controller-metadata.js';
import {
  HanamaruConfigError,
  HanamaruStateError,
} from './errors.js';
import { createGroup, createGroupEnvironment } from './group.js';
import { SCHEMA, validateDefinition } from './serialize-schema.js';
import {
  activeDocument,
  executionContext,
  resolveSerializedTarget,
  resolveTargetSource,
} from './serialize-target.js';
import { createStory, createStoryEnvironment } from './story.js';

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isErrorType(cause, Constructor) {
  try {
    return cause instanceof Constructor;
  } catch {
    return false;
  }
}

function stateError(reason) {
  return new HanamaruStateError(
    'HANA_STATE_SERIALIZE_CONTROLLER',
    'Controller cannot be serialized',
    { reason },
  );
}

function privateObject(input, keys, field) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) throw stateError(field);
  const names = Reflect.ownKeys(input);
  if (names.length !== keys.length
    || names.some((key) => typeof key !== 'string'
      || UNSAFE_KEYS.has(key)
      || !keys.includes(key))
    || keys.some((key) => !names.includes(key))) throw stateError(field);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of keys) {
    if (!Object.hasOwn(descriptors[key], 'value')) throw stateError(field);
  }
  return descriptors;
}

function privateArray(input, field) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw stateError(field);
  }
  const names = Reflect.ownKeys(input);
  if (names.length !== input.length + 1 || names[names.length - 1] !== 'length') {
    throw stateError(field);
  }
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw stateError(field);
    }
    return descriptor.value;
  });
}

function nativeElement(value) {
  const ElementConstructor = value?.ownerDocument?.defaultView?.Element;
  return typeof ElementConstructor === 'function' && value instanceof ElementConstructor;
}

function rangeDocument(value) {
  const node = value?.startContainer;
  return node?.nodeType === 9 ? node : node?.ownerDocument;
}

function nativeRange(value) {
  const doc = rangeDocument(value);
  const RangeConstructor = doc?.defaultView?.Range;
  return typeof RangeConstructor === 'function' && value instanceof RangeConstructor;
}

function rangeOwner(value) {
  const doc = rangeDocument(value);
  const ancestor = value.commonAncestorContainer;
  if (nativeElement(ancestor)) return ancestor;
  if (ancestor === doc) return doc.documentElement;
  return ancestor?.parentElement ?? null;
}

function locatorData(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const names = Reflect.ownKeys(input);
  const required = ['within', 'text'];
  if (names.some((key) => typeof key !== 'string'
    || !['within', 'text', 'occurrence'].includes(key))
    || required.some((key) => !names.includes(key))
    || names.length < 2 || names.length > 3) return null;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (names.some((key) => !Object.hasOwn(descriptors[key], 'value'))) return null;
  const prototype = Object.getPrototypeOf(input);
  const within = descriptors.within.value;
  const realmObject = (within?.ownerDocument ?? globalThis.document)
    ?.defaultView?.Object?.prototype;
  if (prototype !== null && prototype !== Object.prototype && prototype !== realmObject) return null;
  return {
    within,
    text: descriptors.text.value,
    occurrence: descriptors.occurrence?.value,
    hasOccurrence: descriptors.occurrence !== undefined,
  };
}

function preparePrivateTarget(source, controllerKind, index) {
  if (typeof source === 'string') {
    if (source.length === 0) throw stateError('target');
    return { wire: { type: 'selector', selector: source }, pending: null };
  }
  if (nativeElement(source)) {
    return {
      wire: { type: 'key', key: '__pending__', targetKind: 'element' },
      pending: {
        original: source,
        context: {
          role: 'target',
          controllerKind,
          ownerElement: source,
          index,
        },
      },
    };
  }
  if (nativeRange(source)) {
    return {
      wire: { type: 'key', key: '__pending__', targetKind: 'range' },
      pending: {
        original: source,
        context: {
          role: 'target',
          controllerKind,
          ownerElement: rangeOwner(source),
          index,
        },
      },
    };
  }
  const locator = locatorData(source);
  if (locator === null || typeof locator.text !== 'string' || locator.text.length === 0
    || (locator.hasOccurrence
      && (!Number.isInteger(locator.occurrence) || locator.occurrence < 0))) {
    throw stateError('target');
  }
  if (typeof locator.within === 'string') {
    if (locator.within.length === 0) throw stateError('target');
    const wire = {
      type: 'locator',
      within: { type: 'selector', selector: locator.within },
      text: locator.text,
    };
    if (locator.hasOccurrence) wire.occurrence = locator.occurrence;
    return { wire, pending: null };
  }
  if (!nativeElement(locator.within)) throw stateError('target');
  const within = { type: 'key', key: '__pending__', targetKind: 'element' };
  const wire = { type: 'locator', within, text: locator.text };
  if (locator.hasOccurrence) wire.occurrence = locator.occurrence;
  return {
    wire,
    pending: {
      original: locator.within,
      wire: within,
      context: {
        role: 'within',
        controllerKind,
        ownerElement: locator.within,
        index,
      },
    },
  };
}

function annotationOptionValues(input, field) {
  const keys = [
    'mark', 'note', 'placement', 'trigger',
    'accessible', 'seed', 'duration', 'motion',
  ];
  const d = privateObject(input, keys, field);
  return {
    mark: d.mark.value,
    note: d.note.value,
    placement: d.placement.value,
    trigger: d.trigger.value,
    accessible: d.accessible.value,
    seed: d.seed.value,
    duration: d.duration.value,
    motion: d.motion.value,
  };
}

function memberOptionValues(input, field) {
  const options = annotationOptionValues(input, field);
  return {
    mark: options.mark,
    note: options.note,
    placement: options.placement,
    accessible: options.accessible,
    seed: options.seed,
    duration: options.duration,
  };
}

function prepareAnnotationMetadata(input, controllerKind, index, member = false) {
  const d = privateObject(input, ['kind', 'target', 'options'], 'metadata');
  if (d.kind.value !== 'annotation') throw stateError('metadata.kind');
  const target = preparePrivateTarget(d.target.value, controllerKind, index);
  return {
    target,
    options: member
      ? memberOptionValues(d.options.value, 'metadata.options')
      : annotationOptionValues(d.options.value, 'metadata.options'),
  };
}

function storyOptions(input) {
  const triggerDescriptor = Object.getOwnPropertyDescriptor(input, 'trigger');
  if (triggerDescriptor === undefined || !Object.hasOwn(triggerDescriptor, 'value')) {
    throw stateError('metadata.options');
  }
  const viewport = triggerDescriptor.value === 'viewport';
  const keys = viewport
    ? ['trigger', 'gap', 'motion', 'once']
    : ['trigger', 'gap', 'motion'];
  const d = privateObject(input, keys, 'metadata.options');
  const output = {
    trigger: d.trigger.value,
    gap: d.gap.value,
    motion: d.motion.value,
  };
  if (viewport) output.once = d.once.value;
  return output;
}

function prepareController(controller) {
  const metadata = readControllerMetadata(controller);
  if (metadata === undefined) throw stateError('missing');
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)
    || Object.getPrototypeOf(metadata) !== Object.prototype) {
    throw stateError('malformed');
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(metadata, 'kind');
  if (kindDescriptor === undefined || !Object.hasOwn(kindDescriptor, 'value')) {
    throw stateError('malformed');
  }
  const privateKind = kindDescriptor.value;
  let d;
  try {
    d = privateObject(
      metadata,
      privateKind === 'annotation'
        ? ['kind', 'target', 'options']
        : privateKind === 'story'
          ? ['kind', 'options', 'steps']
          : ['kind', 'options', 'members'],
      'metadata',
    );
  } catch {
    throw stateError('malformed');
  }

  if (d.kind.value === 'annotation') {
    const annotation = prepareAnnotationMetadata(metadata, 'annotation', null);
    return {
      definition: {
        schema: SCHEMA,
        kind: 'annotation',
        target: annotation.target.wire,
        options: annotation.options,
      },
      targets: [annotation.target],
    };
  }

  if (d.kind.value === 'story') {
    const records = privateArray(d.steps.value, 'metadata.steps');
    if (records.length === 0) throw stateError('metadata.steps');
    const steps = records.map((record, index) => (
      prepareAnnotationMetadata(record, 'story', index, true)
    ));
    return {
      definition: {
        schema: SCHEMA,
        kind: 'story',
        options: storyOptions(d.options.value),
        steps: steps.map((step) => ({ target: step.target.wire, options: step.options })),
      },
      targets: steps.map((step) => step.target),
    };
  }

  if (d.kind.value === 'group') {
    const records = privateArray(d.members.value, 'metadata.members');
    if (records.length === 0) throw stateError('metadata.members');
    const members = records.map((record, index) => (
      prepareAnnotationMetadata(record, 'group', index, true)
    ));
    const options = privateObject(d.options.value, ['trigger', 'motion'], 'metadata.options');
    return {
      definition: {
        schema: SCHEMA,
        kind: 'group',
        options: {
          trigger: options.trigger.value,
          motion: options.motion.value,
        },
        members: members.map((member) => (
          { target: member.target.wire, options: member.options }
        )),
      },
      targets: members.map((member) => member.target),
    };
  }

  throw stateError('metadata.kind');
}

function serializeOptions(input) {
  if (input === undefined) return {};
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) {
      throw new HanamaruConfigError(
        'HANA_CONFIG_SERIALIZE_TARGET',
        'serialize options must be an ordinary object',
        { options: input },
      );
    }
    const names = Reflect.ownKeys(input);
    if (names.some((key) => key !== 'keyForTarget')) {
      throw new HanamaruConfigError(
        'HANA_CONFIG_SERIALIZE_TARGET',
        'serialize options contain an unknown key',
        { options: input },
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, 'keyForTarget');
    if (descriptor !== undefined && !Object.hasOwn(descriptor, 'value')) {
      throw new HanamaruConfigError(
        'HANA_CONFIG_SERIALIZE_TARGET',
        'keyForTarget must be a data property',
        { options: input },
      );
    }
    return { keyForTarget: descriptor?.value };
  } catch (cause) {
    if (isErrorType(cause, HanamaruConfigError)) throw cause;
    throw new HanamaruConfigError(
      'HANA_CONFIG_SERIALIZE_TARGET',
      'serialize options could not be inspected',
      { options: input, cause },
    );
  }
}

function assignKey(target, keyForTarget) {
  const pending = target.pending;
  if (pending === null) return;
  const destination = pending.wire ?? target.wire;
  const protectedContext = {
    role: pending.context.role,
    controllerKind: pending.context.controllerKind,
    ownerElement: pending.context.ownerElement,
    index: pending.context.index,
  };
  if (typeof keyForTarget !== 'function') {
    throw new HanamaruConfigError(
      'HANA_CONFIG_SERIALIZE_TARGET',
      'keyForTarget is required for native targets',
      protectedContext,
    );
  }
  let key;
  try {
    key = keyForTarget(pending.original, {
      role: protectedContext.role,
      controllerKind: protectedContext.controllerKind,
      ownerElement: protectedContext.ownerElement,
      index: protectedContext.index,
    });
  } catch (cause) {
    throw new HanamaruConfigError(
      'HANA_CONFIG_SERIALIZE_TARGET',
      'keyForTarget failed',
      {
        role: protectedContext.role,
        controllerKind: protectedContext.controllerKind,
        ownerElement: protectedContext.ownerElement,
        index: protectedContext.index,
        cause,
      },
    );
  }
  if (typeof key !== 'string' || key.length === 0) {
    throw new HanamaruConfigError(
      'HANA_CONFIG_SERIALIZE_TARGET',
      'keyForTarget must return a non-empty string',
      protectedContext,
    );
  }
  destination.key = key;
}

export function serialize(controller, optionsInput = undefined) {
  let prepared;
  try {
    prepared = prepareController(controller);
    validateDefinition(prepared.definition);
  } catch (cause) {
    if (isErrorType(cause, HanamaruStateError)) throw cause;
    throw stateError('malformed');
  }
  const options = serializeOptions(optionsInput);
  for (const target of prepared.targets) assignKey(target, options.keyForTarget);
  return validateDefinition(prepared.definition);
}

function normalizeRestoreOptions(definition) {
  if (definition.kind === 'annotation') {
    return [normalizeOptions(definition.options, definition.options.seed)];
  }
  const members = definition.kind === 'story' ? definition.steps : definition.members;
  return members.map((member) => normalizeOptions({
    mark: member.options.mark,
    note: member.options.note,
    placement: member.options.placement,
    trigger: 'manual',
    accessible: member.options.accessible,
    seed: member.options.seed,
    duration: member.options.duration,
    motion: definition.options.motion,
  }, member.options.seed));
}

function preflightTargets(definition, root, resolveTargetCallback) {
  if (definition.kind === 'annotation') {
    return [resolveTargetSource(definition.target, {
      root,
      resolveTarget: resolveTargetCallback,
      controllerKind: 'annotation',
      index: null,
    })];
  }
  const members = definition.kind === 'story' ? definition.steps : definition.members;
  return members.map((member, index) => resolveTargetSource(member.target, {
    root,
    resolveTarget: resolveTargetCallback,
    controllerKind: definition.kind,
    index,
  }));
}

export function restore(definitionInput, contextInput = undefined) {
  const definition = validateDefinition(definitionInput);
  const context = executionContext(contextInput, ['root', 'resolveTarget']);
  const root = activeDocument(
    Object.hasOwn(context, 'root') ? context.root : globalThis.document,
  );
  const normalized = normalizeRestoreOptions(definition);
  const preparedTargets = preflightTargets(definition, root, context.resolveTarget);

  if (definition.kind === 'annotation') {
    return createAnnotation(
      preparedTargets[0].source,
      normalized[0],
      createAnnotationEnvironment(preparedTargets[0].source, root),
    );
  }

  const members = (definition.kind === 'story' ? definition.steps : definition.members)
    .map((member, index) => ({
      target: preparedTargets[index].source,
      mark: member.options.mark,
      note: member.options.note,
      placement: member.options.placement,
      accessible: member.options.accessible,
      seed: member.options.seed,
      duration: member.options.duration,
    }));
  if (definition.kind === 'story') {
    return createStory(
      members,
      definition.options,
      createStoryEnvironment(members, root),
    );
  }
  return createGroup(
    members,
    definition.options,
    createGroupEnvironment(root),
  );
}

export { resolveSerializedTarget };
