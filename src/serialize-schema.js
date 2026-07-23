import { HanamaruConfigError } from './errors.js';

const SCHEMA = 'hanamaru/v1';
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PLACEMENTS = new Set(['auto', 'top', 'right', 'bottom', 'left']);
const TRIGGERS = new Set(['manual', 'load', 'viewport']);
const MOTIONS = new Set(['system', 'never']);

function invalid(field, value) {
  throw new HanamaruConfigError(
    'HANA_CONFIG_SERIALIZED_DEFINITION',
    `Invalid serialized definition: ${field}`,
    { field, value },
  );
}

function reflectionFailure(field, cause) {
  throw new HanamaruConfigError(
    'HANA_CONFIG_SERIALIZED_DEFINITION',
    `Invalid serialized definition: ${field}`,
    { field, cause },
  );
}

function isConfigError(cause) {
  try {
    return cause instanceof HanamaruConfigError;
  } catch {
    return false;
  }
}

function ordinary(input, field, keys, seen) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) {
    invalid(field, input);
  }
  if (seen.has(input)) invalid(field, input);
  seen.add(input);
  const names = Reflect.ownKeys(input);
  if (names.some((key) => typeof key !== 'string'
    || UNSAFE_KEYS.has(key)
    || !keys.includes(key))
    || names.length !== keys.length
    || keys.some((key) => !names.includes(key))) {
    invalid(field, input);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of keys) {
    if (!Object.hasOwn(descriptors[key], 'value')) invalid(`${field}.${key}`, input);
  }
  return descriptors;
}

function optionalOrdinary(input, field, required, optional, seen) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) {
    invalid(field, input);
  }
  if (seen.has(input)) invalid(field, input);
  seen.add(input);
  const names = Reflect.ownKeys(input);
  const allowed = [...required, ...optional];
  if (names.some((key) => typeof key !== 'string'
    || UNSAFE_KEYS.has(key)
    || !allowed.includes(key))
    || required.some((key) => !names.includes(key))) {
    invalid(field, input);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of names) {
    if (!Object.hasOwn(descriptors[key], 'value')) invalid(`${field}.${key}`, input);
  }
  return descriptors;
}

function denseArray(input, field, seen) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    invalid(field, input);
  }
  if (seen.has(input)) invalid(field, input);
  seen.add(input);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
  if (lengthDescriptor === undefined
    || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0) {
    invalid(`${field}.length`, input);
  }
  const length = lengthDescriptor.value;
  const names = Reflect.ownKeys(input);
  const expected = Array.from({ length }, (_, index) => String(index));
  if (names.some((key) => typeof key !== 'string')
    || names.length !== expected.length + 1
    || names[names.length - 1] !== 'length'
    || expected.some((key) => !names.includes(key))) {
    invalid(field, input);
  }
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      invalid(`${field}[${index}]`, input);
    }
    output.push(descriptor.value);
  }
  seen.delete(input);
  return output;
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) invalid(field, value);
  return value;
}

function note(value, field) {
  if (value !== null && typeof value !== 'string') invalid(field, value);
  if (typeof value === 'string' && [...value].length > 280) invalid(field, value);
  return value === '' ? null : value;
}

function seed(value, field) {
  if (typeof value !== 'string'
    && !(typeof value === 'number' && Number.isFinite(value))) invalid(field, value);
  return value;
}

function integer(value, field) {
  if (!Number.isInteger(value) || value < 0) invalid(field, value);
  return value;
}

function oneOf(value, field, values) {
  if (!values.has(value)) invalid(field, value);
  return value;
}

function annotationOptions(input, field, seen) {
  const keys = [
    'mark', 'note', 'placement', 'trigger',
    'accessible', 'seed', 'duration', 'motion',
  ];
  const d = ordinary(input, field, keys, seen);
  const mark = nonEmptyString(d.mark.value, `${field}.mark`);
  const output = {
    mark,
    note: note(d.note.value, `${field}.note`),
    placement: oneOf(d.placement.value, `${field}.placement`, PLACEMENTS),
    trigger: oneOf(d.trigger.value, `${field}.trigger`, TRIGGERS),
    accessible: d.accessible.value,
    seed: seed(d.seed.value, `${field}.seed`),
    duration: integer(d.duration.value, `${field}.duration`),
    motion: oneOf(d.motion.value, `${field}.motion`, MOTIONS),
  };
  if (typeof output.accessible !== 'boolean') invalid(`${field}.accessible`, output.accessible);
  seen.delete(input);
  return output;
}

function memberOptions(input, field, seen) {
  const keys = ['mark', 'note', 'placement', 'accessible', 'seed', 'duration'];
  const d = ordinary(input, field, keys, seen);
  const mark = nonEmptyString(d.mark.value, `${field}.mark`);
  const output = {
    mark,
    note: note(d.note.value, `${field}.note`),
    placement: oneOf(d.placement.value, `${field}.placement`, PLACEMENTS),
    accessible: d.accessible.value,
    seed: seed(d.seed.value, `${field}.seed`),
    duration: integer(d.duration.value, `${field}.duration`),
  };
  if (typeof output.accessible !== 'boolean') invalid(`${field}.accessible`, output.accessible);
  seen.delete(input);
  return output;
}

function selectorTarget(d, field) {
  return {
    type: 'selector',
    selector: nonEmptyString(d.selector.value, `${field}.selector`),
  };
}

function locatorText(value, field) {
  if (typeof value !== 'string' || value.trim().replace(/\s+/gu, ' ').length === 0) {
    invalid(field, value);
  }
  return value;
}

function keyTarget(d, field) {
  return {
    type: 'key',
    key: nonEmptyString(d.key.value, `${field}.key`),
    targetKind: oneOf(
      d.targetKind.value,
      `${field}.targetKind`,
      new Set(['element', 'range']),
    ),
  };
}

function validateSerializedWithin(input, field, seen) {
  const d = optionalOrdinary(
    input,
    field,
    ['type'],
    ['selector', 'key', 'targetKind'],
    seen,
  );
  const names = Reflect.ownKeys(input);
  if (d.type.value === 'selector') {
    if (names.length !== 2 || !names.includes('selector')) invalid(field, input);
    const output = selectorTarget(d, field);
    seen.delete(input);
    return output;
  }
  if (d.type.value === 'key') {
    if (names.length !== 3 || !names.includes('key') || !names.includes('targetKind')) {
      invalid(field, input);
    }
    const output = keyTarget(d, field);
    if (output.targetKind !== 'element') invalid(field, input);
    seen.delete(input);
    return output;
  }
  invalid(field, input);
}

function validateSerializedTargetUnsafe(input, field = 'target', state = undefined) {
  const seen = state?.seen ?? new WeakSet();
  const base = optionalOrdinary(
    input,
    field,
    ['type'],
    ['selector', 'within', 'text', 'occurrence', 'key', 'targetKind'],
    seen,
  );
  const type = base.type.value;
  if (type === 'selector') {
    if (Reflect.ownKeys(input).length !== 2
      || !Object.hasOwn(base, 'selector')) invalid(field, input);
    const output = selectorTarget(base, field);
    seen.delete(input);
    return output;
  }
  if (type === 'key') {
    if (Reflect.ownKeys(input).length !== 3
      || !Object.hasOwn(base, 'key')
      || !Object.hasOwn(base, 'targetKind')) invalid(field, input);
    const output = keyTarget(base, field);
    seen.delete(input);
    return output;
  }
  if (type !== 'locator') invalid(`${field}.type`, type);

  const required = ['type', 'within', 'text'];
  const optional = ['occurrence'];
  const d = optionalOrdinary(input, field, required, optional, new WeakSet());
  const within = validateSerializedWithin(d.within.value, `${field}.within`, seen);
  const output = {
    type: 'locator',
    within,
    text: locatorText(d.text.value, `${field}.text`),
  };
  if (d.occurrence !== undefined) {
    output.occurrence = integer(d.occurrence.value, `${field}.occurrence`);
  }
  seen.delete(input);
  return output;
}

export function validateSerializedTarget(input, field = 'target') {
  try {
    return validateSerializedTargetUnsafe(input, field);
  } catch (cause) {
    if (isConfigError(cause)) throw cause;
    reflectionFailure(field, cause);
  }
}

function validateTargetWithSeen(input, field, seen) {
  const d = optionalOrdinary(
    input,
    field,
    ['type'],
    ['selector', 'within', 'text', 'occurrence', 'key', 'targetKind'],
    seen,
  );
  if (d.type.value === 'selector') {
    const names = Reflect.ownKeys(input);
    if (names.length !== 2 || !names.includes('selector')) invalid(field, input);
    const output = selectorTarget(d, field);
    seen.delete(input);
    return output;
  }
  if (d.type.value === 'key') {
    const names = Reflect.ownKeys(input);
    if (names.length !== 3 || !names.includes('key') || !names.includes('targetKind')) {
      invalid(field, input);
    }
    const output = keyTarget(d, field);
    seen.delete(input);
    return output;
  }
  if (d.type.value !== 'locator') invalid(`${field}.type`, d.type.value);
  const names = Reflect.ownKeys(input);
  if (names.length < 3 || names.length > 4
    || !names.includes('within') || !names.includes('text')
    || (names.length === 4 && !names.includes('occurrence'))) invalid(field, input);
  const within = validateSerializedWithin(d.within.value, `${field}.within`, seen);
  const output = {
    type: 'locator',
    within,
    text: locatorText(d.text.value, `${field}.text`),
  };
  if (d.occurrence !== undefined) {
    output.occurrence = integer(d.occurrence.value, `${field}.occurrence`);
  }
  seen.delete(input);
  return output;
}

function aggregateMember(input, field, seen) {
  const d = ordinary(input, field, ['target', 'options'], seen);
  const output = {
    target: validateTargetWithSeen(d.target.value, `${field}.target`, seen),
    options: memberOptions(d.options.value, `${field}.options`, seen),
  };
  seen.delete(input);
  return output;
}

function storyOptions(input, field, seen) {
  const first = optionalOrdinary(input, field, ['trigger', 'gap', 'motion'], ['once'], seen);
  const trigger = oneOf(first.trigger.value, `${field}.trigger`, TRIGGERS);
  const hasOnce = first.once !== undefined;
  if ((trigger === 'viewport') !== hasOnce) invalid(`${field}.once`, first.once?.value);
  const output = {
    trigger,
    gap: integer(first.gap.value, `${field}.gap`),
    motion: oneOf(first.motion.value, `${field}.motion`, MOTIONS),
  };
  if (hasOnce) {
    if (typeof first.once.value !== 'boolean') invalid(`${field}.once`, first.once.value);
    output.once = first.once.value;
  }
  seen.delete(input);
  return output;
}

function groupOptions(input, field, seen) {
  const d = ordinary(input, field, ['trigger', 'motion'], seen);
  const output = {
    trigger: oneOf(d.trigger.value, `${field}.trigger`, TRIGGERS),
    motion: oneOf(d.motion.value, `${field}.motion`, MOTIONS),
  };
  seen.delete(input);
  return output;
}

function validateDefinitionUnsafe(input) {
  const seen = new WeakSet();
  const base = optionalOrdinary(
    input,
    'definition',
    ['schema', 'kind'],
    ['target', 'options', 'steps', 'members'],
    seen,
  );
  if (base.schema.value !== SCHEMA) invalid('definition.schema', base.schema.value);
  const kind = base.kind.value;

  if (kind === 'annotation') {
    const names = Reflect.ownKeys(input);
    if (names.length !== 4 || !names.includes('target') || !names.includes('options')) {
      invalid('definition', input);
    }
    const output = {
      schema: SCHEMA,
      kind: 'annotation',
      target: validateTargetWithSeen(base.target.value, 'definition.target', seen),
      options: annotationOptions(base.options.value, 'definition.options', seen),
    };
    seen.delete(input);
    return output;
  }

  if (kind === 'story') {
    const names = Reflect.ownKeys(input);
    if (names.length !== 4 || !names.includes('options') || !names.includes('steps')) {
      invalid('definition', input);
    }
    const steps = denseArray(base.steps.value, 'definition.steps', seen);
    if (steps.length === 0) invalid('definition.steps', steps);
    const output = {
      schema: SCHEMA,
      kind: 'story',
      options: storyOptions(base.options.value, 'definition.options', seen),
      steps: steps.map((step, index) => (
        aggregateMember(step, `definition.steps[${index}]`, seen)
      )),
    };
    seen.delete(input);
    return output;
  }

  if (kind === 'group') {
    const names = Reflect.ownKeys(input);
    if (names.length !== 4 || !names.includes('options') || !names.includes('members')) {
      invalid('definition', input);
    }
    const members = denseArray(base.members.value, 'definition.members', seen);
    if (members.length === 0) invalid('definition.members', members);
    const output = {
      schema: SCHEMA,
      kind: 'group',
      options: groupOptions(base.options.value, 'definition.options', seen),
      members: members.map((member, index) => (
        aggregateMember(member, `definition.members[${index}]`, seen)
      )),
    };
    seen.delete(input);
    return output;
  }

  invalid('definition.kind', kind);
}

export function validateDefinition(input) {
  try {
    return validateDefinitionUnsafe(input);
  } catch (cause) {
    if (isConfigError(cause)) throw cause;
    reflectionFailure('definition', cause);
  }
}

export { SCHEMA };
