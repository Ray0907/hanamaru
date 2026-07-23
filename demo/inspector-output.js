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

function safeSerialized(value, spacing = 2) {
  const serialized = JSON.stringify(value, null, spacing);
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

function persistentOutput(previousOutput, definition) {
  const serializedDefinition = safeSerialized(definition);
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
    } catch {
      return previousOutput;
    }
    const definition = serialize(controller);
    return persistentOutput(previousOutput, definition);
  }
}
