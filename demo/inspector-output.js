const HTML_RANGE_REASON =
  'Unavailable for this Range: HTML cannot represent a Range without changing the document.';
const JSON_RANGE_REASON =
  'Unavailable for this Range: an exact stable text locator has not been proven.';

const ESCAPED_CODE_POINTS = Object.freeze({
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
});

function invalidJson() {
  throw new TypeError('Inspector output must contain exact JSON-compatible data');
}

function isArrayIndex(name, length) {
  if (!/^(?:0|[1-9]\d*)$/u.test(name)) return false;
  const index = Number(name);
  return Number.isSafeInteger(index) && index < length;
}

function assertUncoercedJsonValue(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) invalidJson();
  if (value === undefined
    || typeof value === 'bigint'
    || typeof value === 'function'
    || typeof value === 'symbol') {
    invalidJson();
  }
}

function assertExactJsonContainer(value) {
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const name of Reflect.ownKeys(descriptors)) {
      if (typeof name !== 'string'
        || (name !== 'length' && !isArrayIndex(name, value.length))) {
        invalidJson();
      }
      if (name !== 'length' && Object.hasOwn(descriptors[name], 'value')) {
        assertUncoercedJsonValue(descriptors[name].value);
      }
    }
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidJson();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const name of Reflect.ownKeys(descriptors)) {
    if (typeof name !== 'string' || descriptors[name].enumerable !== true) {
      invalidJson();
    }
    if (Object.hasOwn(descriptors[name], 'value')) {
      assertUncoercedJsonValue(descriptors[name].value);
    }
  }
}

function exactJsonReplacer(_key, value) {
  assertUncoercedJsonValue(value);
  if (typeof value === 'object' && value !== null) assertExactJsonContainer(value);
  return value;
}

function safeSerialized(value, spacing = 2) {
  let serialized;
  try {
    assertUncoercedJsonValue(value);
    serialized = JSON.stringify(value, exactJsonReplacer, spacing);
  } catch (cause) {
    throw new TypeError('Inspector output must be JSON-serializable', { cause });
  }
  if (typeof serialized !== 'string') {
    throw new TypeError('Inspector output must be JSON-serializable');
  }
  return serialized.replace(/[<>&\u2028\u2029]/gu, (character) => ESCAPED_CODE_POINTS[character]);
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
  const javascript = [
    "import { annotateSelection } from 'hanamaru-annotations/selection';",
    '',
    `const annotation = annotateSelection(${safeSerialized(options)});`,
    'annotation.show();',
  ].join('\n');

  return Object.freeze({
    html: unavailable(HTML_RANGE_REASON),
    javascript: available(javascript),
    json: unavailable(JSON_RANGE_REASON),
  });
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

function matchesProvenDefinition(definition, text, occurrence) {
  if (!isRecord(definition)
    || definition.schema !== 'hanamaru/v1'
    || definition.kind !== 'annotation'
    || !hasExactKeys(definition.target, ['type', 'within', 'text', 'occurrence'])
    || !hasExactKeys(definition.target.within, ['type', 'selector'])) {
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
      const serializedDefinition = safeSerialized(definition);
      const stableDefinition = JSON.parse(serializedDefinition);
      if (!matchesProvenDefinition(stableDefinition, selectedText, occurrence)) {
        return previousOutput;
      }
      return persistentOutput(previousOutput, serializedDefinition);
    } catch {
      return previousOutput;
    }
  }
}
