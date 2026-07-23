const HTML_RANGE_REASON =
  'Unavailable for this Range: HTML cannot represent a Range without changing the document.';
const JSON_RANGE_REASON =
  'Unavailable for this Range: an exact stable text locator has not been proven.';
const CUSTOM_MARK_REASON =
  'Unavailable for this custom mark: register it with hanamaru-annotations/plugins before running JavaScript or restoring JSON.';
const BUILT_IN_MARKS = new Set([
  'underline',
  'highlight',
  'circle',
  'box',
  'strike',
  'bracket',
]);
const CUSTOM_MARK_OUTPUTS = new WeakSet();

const ESCAPED_CODE_POINTS = Object.freeze({
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
});
const UNSAFE_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function invalidJson() {
  throw new TypeError('Inspector output must contain exact JSON-compatible data');
}

function snapshotJsonArray(value, context) {
  if (Object.getPrototypeOf(value) !== Array.prototype) invalidJson();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor?.value;
  if (lengthDescriptor === undefined
    || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(length)
    || length < 0
    || names.length !== length + 1
    || names.some((name) => typeof name !== 'string')) {
    invalidJson();
  }

  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')) {
      invalidJson();
    }
    snapshot.push(snapshotExactJson(descriptor.value, context));
  }
  if (names.some((name) => name !== 'length'
    && !/^(?:0|[1-9]\d*)$/u.test(name))) {
    invalidJson();
  }
  return snapshot;
}

function snapshotJsonObject(value, context) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidJson();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.some((name) => (
    typeof name !== 'string'
    || name === 'toJSON'
    || UNSAFE_JSON_KEYS.has(name)
  ))) {
    invalidJson();
  }

  const snapshot = Object.create(null);
  for (const name of names) {
    const descriptor = descriptors[name];
    if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      invalidJson();
    }
    snapshot[name] = snapshotExactJson(descriptor.value, context);
  }
  return snapshot;
}

function snapshotExactJson(value, context = {
  active: new Set(),
  completed: new WeakMap(),
}) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidJson();
    return value;
  }
  if (typeof value !== 'object' || context.active.has(value)) invalidJson();
  const completed = context.completed.get(value);
  if (completed !== undefined) return completed;

  context.active.add(value);
  try {
    const snapshot = Array.isArray(value)
      ? snapshotJsonArray(value, context)
      : snapshotJsonObject(value, context);
    context.completed.set(value, snapshot);
    return snapshot;
  } finally {
    context.active.delete(value);
  }
}

function safeStringToken(value) {
  return JSON.stringify(value)
    .replace(/[<>&\u2028\u2029]/gu, (character) => ESCAPED_CODE_POINTS[character]);
}

function writeJson(value, depth = 0) {
  if (value === null) return 'null';
  if (typeof value === 'string') return safeStringToken(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);

  const indent = '  '.repeat(depth);
  const childIndent = '  '.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => `${childIndent}${writeJson(item, depth + 1)}`);
    return `[\n${items.join(',\n')}\n${indent}]`;
  }

  const names = Object.keys(value);
  if (names.length === 0) return '{}';
  const entries = names.map((name) => (
    `${childIndent}${safeStringToken(name)}: ${writeJson(value[name], depth + 1)}`
  ));
  return `{\n${entries.join(',\n')}\n${indent}}`;
}

function stableJson(value) {
  try {
    const snapshot = snapshotExactJson(value);
    return { snapshot, serialized: writeJson(snapshot) };
  } catch (cause) {
    throw new TypeError('Inspector output must be JSON-serializable', { cause });
  }
}

function unavailable(reason) {
  return Object.freeze({ available: false, code: '', reason });
}

function available(code) {
  return Object.freeze({ available: true, code, reason: '' });
}

/**
 * Create honest copy output for a live Range-backed annotation.
 *
 * Range targets have no declarative HTML representation and are not persistent
 * until `proveRangeLocator()` has verified an exact public locator round-trip.
 */
export function createRangeOutput(options = {}) {
  const stableOptions = stableJson(options);
  const customMark = typeof stableOptions.snapshot.mark === 'string'
    && !BUILT_IN_MARKS.has(stableOptions.snapshot.mark);
  const javascript = [
    "import { annotateSelection } from 'hanamaru-annotations/selection';",
    '',
    `const annotation = annotateSelection(${stableOptions.serialized});`,
    'annotation.show();',
  ].join('\n');

  const output = Object.freeze({
    html: unavailable(HTML_RANGE_REASON),
    javascript: customMark ? unavailable(CUSTOM_MARK_REASON) : available(javascript),
    json: customMark ? unavailable(CUSTOM_MARK_REASON) : unavailable(JSON_RANGE_REASON),
  });
  if (customMark) CUSTOM_MARK_OUTPUTS.add(output);
  return output;
}

function serializedLocator(text, occurrence) {
  return {
    type: 'locator',
    within: { type: 'selector', selector: '#inspector-document' },
    text,
    occurrence,
  };
}

function hasExactBoundaries(candidate, expected) {
  return candidate.startContainer === expected.startContainer
    && candidate.startOffset === expected.startOffset
    && candidate.endContainer === expected.endContainer
    && candidate.endOffset === expected.endOffset;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

const V1_PLACEMENTS = Object.freeze(new Set(['auto', 'top', 'right', 'bottom', 'left']));
const V1_MOTIONS = Object.freeze(new Set(['system', 'never']));

function matchesInspectorOptions(options) {
  if (!hasExactKeys(options, [
    'mark',
    'note',
    'placement',
    'trigger',
    'accessible',
    'seed',
    'duration',
    'motion',
  ])) {
    return false;
  }

  const noteIsValid = options.note === null
    || (typeof options.note === 'string' && [...options.note].length <= 280);
  const seedIsValid = typeof options.seed === 'string'
    || (typeof options.seed === 'number' && Number.isFinite(options.seed));
  return typeof options.mark === 'string'
    && options.mark.length > 0
    && noteIsValid
    && V1_PLACEMENTS.has(options.placement)
    && options.trigger === 'manual'
    && typeof options.accessible === 'boolean'
    && seedIsValid
    && Number.isInteger(options.duration)
    && options.duration >= 0
    && V1_MOTIONS.has(options.motion);
}

/**
 * Narrow gate for the exact v1 annotation definition emitted by Inspector.
 *
 * Public `serialize()` remains the general schema authority. This check only
 * binds Inspector persistence to its proven locator and manual-trigger option
 * surface before the demo claims that JSON can be restored.
 */
function matchesProvenDefinition(definition, text, occurrence) {
  if (!isRecord(definition)
    || !hasExactKeys(definition, ['schema', 'kind', 'target', 'options'])
    || definition.schema !== 'hanamaru/v1'
    || definition.kind !== 'annotation'
    || !hasExactKeys(definition.target, ['type', 'within', 'text', 'occurrence'])
    || !hasExactKeys(definition.target.within, ['type', 'selector'])
    || !matchesInspectorOptions(definition.options)) {
    return false;
  }

  return definition.target.type === 'locator'
    && definition.target.within.type === 'selector'
    && definition.target.within.selector === '#inspector-document'
    && definition.target.text === text
    && definition.target.occurrence === occurrence;
}

function persistentOutput(previousOutput, serializedDefinition) {
  const javascript = [
    "import { restore } from 'hanamaru-annotations/serialize';",
    '',
    `const definition = ${serializedDefinition};`,
    'const annotation = restore(definition);',
    'annotation.show();',
  ].join('\n');

  return Object.freeze({
    html: previousOutput.html,
    javascript: available(javascript),
    json: available(serializedDefinition),
  });
}

/**
 * Prove a Range can be restored through the public serialized-target API.
 *
 * Dependencies are injected so the demo module imports only public package
 * entry points. Occurrences are supplied exclusively by repeated public
 * resolver calls; this module performs no DOM traversal or text normalization.
 */
export function proveRangeLocator({
  range,
  selectedText,
  controller,
  previousOutput,
  resolveSerializedTarget,
  serialize,
}) {
  if (CUSTOM_MARK_OUTPUTS.has(previousOutput)) return previousOutput;
  const expected = range.cloneRange();

  for (let occurrence = 0; ; occurrence += 1) {
    let candidate;
    try {
      candidate = resolveSerializedTarget(serializedLocator(selectedText, occurrence));
    } catch (error) {
      if (error?.code === 'HANA_TARGET_MISSING') return previousOutput;
      throw error;
    }
    if (!hasExactBoundaries(candidate, expected)) continue;

    try {
      controller.update({
        target: {
          within: '#inspector-document',
          text: selectedText,
          occurrence,
        },
      });
      const definition = serialize(controller);
      const stableDefinition = stableJson(definition);
      if (!matchesProvenDefinition(stableDefinition.snapshot, selectedText, occurrence)) {
        return previousOutput;
      }
      return persistentOutput(previousOutput, stableDefinition.serialized);
    } catch {
      return previousOutput;
    }
  }
}
