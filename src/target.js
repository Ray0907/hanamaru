import { HanamaruConfigError, HanamaruTargetError } from './errors.js';

function invalid(field, value) {
  return new HanamaruConfigError(
    'HANA_CONFIG_INVALID',
    `Invalid ${field}`,
    { field, value },
  );
}

function normalizeText(value) {
  return value.trim().replace(/\s+/gu, ' ');
}

export function normalizeLocatorText(value) {
  if (typeof value !== 'string') {
    throw invalid('text', value);
  }

  const normalized = normalizeText(value);
  if (normalized.length === 0) {
    throw invalid('text', value);
  }

  return normalized;
}

export function findMatchOffsets(source, needle) {
  if (typeof source !== 'string') {
    throw invalid('source', source);
  }

  const normalizedSource = normalizeText(source);
  const normalizedNeedle = normalizeLocatorText(needle);
  const matches = [];
  let cursor = 0;

  while (cursor < normalizedSource.length) {
    const start = normalizedSource.indexOf(normalizedNeedle, cursor);
    if (start === -1) {
      break;
    }

    const end = start + normalizedNeedle.length;
    matches.push([start, end]);
    cursor = end;
  }

  return matches;
}

export function validateOccurrence(value) {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw invalid('occurrence', value);
  }

  return value;
}

function targetError(code, message, details) {
  return new HanamaruTargetError(code, message, details);
}

function isElement(value, doc) {
  return value instanceof doc.defaultView.Element;
}

function isRange(value, doc) {
  return value instanceof doc.defaultView.Range;
}

function assertConnectedElement(element, doc) {
  if (!isElement(element, doc) || element.ownerDocument !== doc || !element.isConnected) {
    throw targetError('HANA_TARGET_INVALID', 'Target Element must belong to and be connected to the document', {
      target: element,
    });
  }
}

function findSelectorTarget(selector, doc) {
  let matches;
  try {
    matches = doc.querySelectorAll(selector);
  } catch (error) {
    throw targetError('HANA_TARGET_INVALID', 'Target selector is invalid', { selector, cause: error.message });
  }

  if (matches.length === 0) {
    throw targetError('HANA_TARGET_MISSING', 'Target selector did not match an Element', { selector });
  }
  if (matches.length > 1) {
    throw targetError('HANA_TARGET_AMBIGUOUS', 'Target selector matched multiple Elements', {
      selector,
      count: matches.length,
    });
  }

  const element = matches[0];
  assertConnectedElement(element, doc);
  return element;
}

function elementRecord(element, doc) {
  const record = {
    kind: 'element',
    source: element,
    element,
    range: null,
    ownerElement: element,
    refresh: null,
  };
  record.refresh = () => {
    assertConnectedElement(element, doc);
    return record;
  };
  return record;
}

function selectorRecord(selector, doc) {
  const record = {
    kind: 'selector',
    source: selector,
    element: null,
    range: null,
    ownerElement: null,
    refresh: null,
  };
  record.refresh = () => {
    const element = findSelectorTarget(selector, doc);
    record.element = element;
    record.ownerElement = element;
    return record;
  };
  return record.refresh();
}

function isConnectedBoundary(node, doc) {
  return node === doc || (node.ownerDocument === doc && node.isConnected);
}

function assertConnectedRange(range, doc) {
  if (!isRange(range, doc)
    || !isConnectedBoundary(range.startContainer, doc)
    || !isConnectedBoundary(range.endContainer, doc)) {
    throw targetError('HANA_TARGET_INVALID', 'Target Range boundaries must belong to and be connected to the document', {
      target: range,
    });
  }
}

function rangeOwnerElement(range, doc) {
  const ancestor = range.commonAncestorContainer;
  return isElement(ancestor, doc) ? ancestor : ancestor.parentElement;
}

function rangeRecord(source, doc) {
  assertConnectedRange(source, doc);
  const range = source.cloneRange();
  const boundaryNodes = [range.startContainer, range.endContainer];
  const record = {
    kind: 'range',
    source,
    element: null,
    range,
    ownerElement: rangeOwnerElement(range, doc),
    refresh: null,
  };
  record.refresh = () => {
    if (!boundaryNodes.every((node) => isConnectedBoundary(node, doc))) {
      throw targetError('HANA_TARGET_INVALID', 'Target Range boundaries are no longer connected to the document', {
        target: range,
      });
    }
    return record;
  };
  return record;
}

export function resolveTarget(target, doc = document) {
  if (typeof target === 'string') {
    return selectorRecord(target, doc);
  }
  if (isElement(target, doc)) {
    assertConnectedElement(target, doc);
    return elementRecord(target, doc);
  }
  if (isRange(target, doc)) {
    return rangeRecord(target, doc);
  }
  throw targetError('HANA_TARGET_INVALID', 'Target must be an Element, selector, or Range', { target });
}
