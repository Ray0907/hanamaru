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

function targetRealm(doc) {
  const realm = doc?.defaultView;
  if (!realm || typeof realm.Element !== 'function' || typeof realm.Range !== 'function') {
    throw targetError('HANA_TARGET_INVALID', 'Target document must have a usable browsing realm', { document: doc });
  }
  return realm;
}

function isElement(value, realm) {
  return value instanceof realm.Element;
}

function isRange(value, realm) {
  return value instanceof realm.Range;
}

function assertConnectedElement(element, doc, realm) {
  if (!isElement(element, realm) || element.ownerDocument !== doc || !element.isConnected) {
    throw targetError('HANA_TARGET_INVALID', 'Target Element must belong to and be connected to the document', {
      target: element,
    });
  }
}

function findSelectorTarget(selector, doc, realm) {
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
  assertConnectedElement(element, doc, realm);
  return element;
}

const LOCATOR_KEYS = new Set(['within', 'text', 'occurrence']);
const EXCLUDED_TEXT_ANCESTORS = 'script,style,noscript,template,[hidden],[inert]';

function locatorConfig(target, realm) {
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    return null;
  }

  const prototype = Object.getPrototypeOf(target);
  if (prototype !== null && prototype !== realm.Object.prototype) {
    return null;
  }

  const keys = Reflect.ownKeys(target);
  if (!keys.includes('within') || !keys.includes('text')
    || keys.some((key) => typeof key !== 'string' || !LOCATOR_KEYS.has(key))) {
    return null;
  }

  const descriptors = Object.getOwnPropertyDescriptors(target);
  if (keys.some((key) => !Object.hasOwn(descriptors[key], 'value'))) {
    return null;
  }

  return {
    within: descriptors.within.value,
    text: descriptors.text.value,
    occurrence: descriptors.occurrence?.value,
    hasOccurrence: Object.hasOwn(descriptors, 'occurrence'),
  };
}

function assertLocatorWithin(element, doc, realm) {
  assertConnectedElement(element, doc, realm);
  if (element.getRootNode() !== doc) {
    throw targetError('HANA_TARGET_INVALID', 'Text locator within Element must be in the document tree', {
      within: element,
    });
  }
}

function resolveLocatorWithin(within, doc, realm) {
  if (typeof within === 'string') {
    return findSelectorTarget(within, doc, realm);
  }
  if (isElement(within, realm)) {
    assertLocatorWithin(within, doc, realm);
    return within;
  }
  throw targetError('HANA_TARGET_INVALID', 'Text locator within must be an Element or selector', { within });
}

function isExcludedTextNode(node, within) {
  let ancestor = node.parentElement;
  while (ancestor !== null) {
    if (ancestor.matches(EXCLUDED_TEXT_ANCESTORS)) {
      return true;
    }
    if (ancestor === within) {
      break;
    }
    ancestor = ancestor.parentElement;
  }
  return false;
}

function collectLocatorText(within, doc) {
  const walker = doc.createTreeWalker(within, 4);
  const map = [];
  let normalized = '';
  let pendingWhitespace = null;

  function append(value, start, end) {
    normalized += value;
    for (let index = 0; index < value.length; index += 1) {
      map.push({
        start: index === 0 ? start : null,
        end: index === value.length - 1 ? end : null,
      });
    }
  }

  let node = walker.nextNode();
  while (node !== null) {
    if (!isExcludedTextNode(node, within)) {
      let offset = 0;
      for (const character of node.data) {
        const nextOffset = offset + character.length;
        if (/\s/u.test(character)) {
          if (normalized.length > 0) {
            pendingWhitespace ??= { start: [node, offset], end: [node, nextOffset] };
            pendingWhitespace.end = [node, nextOffset];
          }
        } else {
          if (pendingWhitespace !== null) {
            append(' ', pendingWhitespace.start, pendingWhitespace.end);
            pendingWhitespace = null;
          }
          append(character, [node, offset], [node, nextOffset]);
        }
        offset = nextOffset;
      }
    }
    node = walker.nextNode();
  }

  return { text: normalized, map };
}

function locatorRange(within, text, occurrence, doc) {
  const collected = collectLocatorText(within, doc);
  const matches = findMatchOffsets(collected.text, text).filter(([start, end]) => (
    collected.map[start]?.start !== null && collected.map[end - 1]?.end !== null
  ));

  if (matches.length === 0 || (occurrence !== undefined && occurrence >= matches.length)) {
    throw targetError('HANA_TARGET_MISSING', 'Text locator did not match visible text', {
      within,
      text,
      occurrence,
    });
  }
  if (occurrence === undefined && matches.length > 1) {
    throw targetError('HANA_TARGET_AMBIGUOUS', 'Text locator matched multiple visible occurrences', {
      within,
      text,
      count: matches.length,
    });
  }

  const [start, end] = matches[occurrence ?? 0];
  const [startNode, startOffset] = collected.map[start].start;
  const [endNode, endOffset] = collected.map[end - 1].end;
  const range = doc.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

function locatorRecord(config, doc, realm) {
  const text = normalizeLocatorText(config.text);
  const occurrence = validateOccurrence(config.occurrence);
  const source = { within: config.within, text: config.text };
  if (config.hasOccurrence) {
    source.occurrence = config.occurrence;
  }
  const directWithin = typeof config.within === 'string' ? null : config.within;
  const record = {
    kind: 'locator',
    source,
    element: null,
    range: null,
    ownerElement: null,
    refresh: null,
  };
  record.refresh = () => {
    const element = directWithin ?? resolveLocatorWithin(config.within, doc, realm);
    if (directWithin !== null) {
      assertLocatorWithin(directWithin, doc, realm);
    }
    const range = locatorRange(element, text, occurrence, doc);
    record.element = element;
    record.range = range;
    record.ownerElement = element;
    return record;
  };
  return record.refresh();
}

function elementRecord(element, doc, realm) {
  const record = {
    kind: 'element',
    source: element,
    element,
    range: null,
    ownerElement: element,
    refresh: null,
  };
  record.refresh = () => {
    assertConnectedElement(element, doc, realm);
    return record;
  };
  return record;
}

function selectorRecord(selector, doc, realm) {
  const record = {
    kind: 'selector',
    source: selector,
    element: null,
    range: null,
    ownerElement: null,
    refresh: null,
  };
  record.refresh = () => {
    const element = findSelectorTarget(selector, doc, realm);
    record.element = element;
    record.ownerElement = element;
    return record;
  };
  return record.refresh();
}

function isConnectedBoundary(node, doc) {
  return node === doc || (node.ownerDocument === doc && node.isConnected);
}

function assertConnectedRange(range, doc, realm) {
  if (!isRange(range, realm)
    || !isConnectedBoundary(range.startContainer, doc)
    || !isConnectedBoundary(range.endContainer, doc)) {
    throw targetError('HANA_TARGET_INVALID', 'Target Range boundaries must belong to and be connected to the document', {
      target: range,
    });
  }
}

function rangeOwnerElement(range, doc, realm) {
  const ancestor = range.commonAncestorContainer;
  if (isElement(ancestor, realm)) {
    return ancestor;
  }
  if (ancestor === doc) {
    return doc.documentElement;
  }
  return ancestor.parentElement ?? null;
}

function rangeRecord(source, doc, realm) {
  assertConnectedRange(source, doc, realm);
  const range = source.cloneRange();
  const boundaryNodes = [range.startContainer, range.endContainer];
  const ownerElement = rangeOwnerElement(range, doc, realm);
  if (ownerElement === null) {
    throw targetError('HANA_TARGET_INVALID', 'Target Range must have an Element owner in the document tree', {
      target: source,
    });
  }
  const record = {
    kind: 'range',
    source,
    element: null,
    range,
    ownerElement,
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
  const realm = targetRealm(doc);
  if (typeof target === 'string') {
    return selectorRecord(target, doc, realm);
  }
  if (isElement(target, realm)) {
    assertConnectedElement(target, doc, realm);
    return elementRecord(target, doc, realm);
  }
  if (isRange(target, realm)) {
    return rangeRecord(target, doc, realm);
  }
  const config = locatorConfig(target, realm);
  if (config !== null) {
    return locatorRecord(config, doc, realm);
  }
  throw targetError('HANA_TARGET_INVALID', 'Target must be an Element, selector, or Range', { target });
}
