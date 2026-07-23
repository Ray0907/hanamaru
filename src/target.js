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

export function queryUniqueTarget(selector, queryRoot, assertElement) {
  let matches;
  try {
    matches = queryRoot.querySelectorAll(selector);
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
  assertElement(element);
  return element;
}

function findSelectorTarget(selector, doc, realm) {
  return queryUniqueTarget(
    selector,
    doc,
    (element) => assertConnectedElement(element, doc, realm),
  );
}

const LOCATOR_KEYS = new Set(['within', 'text', 'occurrence']);
const EXCLUDED_TEXT_ANCESTORS = 'script,style,noscript,template,[hidden],[inert]';

export function readLocatorConfig(target, realm) {
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    return null;
  }

  const prototype = Object.getPrototypeOf(target);
  if (prototype !== null
    && prototype !== Object.prototype
    && prototype !== realm.Object.prototype) {
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

function isExcludedTextNode(node) {
  let ancestor = node.parentElement;
  while (ancestor !== null) {
    if (ancestor.matches(EXCLUDED_TEXT_ANCESTORS)) {
      return true;
    }
    ancestor = ancestor.parentElement;
  }
  return false;
}

function collectLocatorTextSegments(within, doc) {
  const walker = doc.createTreeWalker(within, 5);
  const segments = [];
  let map = [];
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

  function finishSegment() {
    if (normalized.length > 0) {
      segments.push({ text: normalized, map });
    }
    map = [];
    normalized = '';
    pendingWhitespace = null;
  }

  let node = walker.nextNode();
  while (node !== null) {
    if (node.nodeType === 1 && node.matches(EXCLUDED_TEXT_ANCESTORS)) {
      finishSegment();
    } else if (node.nodeType === 3 && isExcludedTextNode(node)) {
      finishSegment();
    } else if (node.nodeType === 3) {
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
  finishSegment();

  return segments;
}

export function createLocatorRange(within, text, occurrence, doc) {
  const matches = collectLocatorTextSegments(within, doc).flatMap((segment) => (
    findMatchOffsets(segment.text, text)
      .filter(([start, end]) => segment.map[start]?.start !== null && segment.map[end - 1]?.end !== null)
      .map(([start, end]) => ({ segment, start, end }))
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

  const { segment, start, end } = matches[occurrence ?? 0];
  const [startNode, startOffset] = segment.map[start].start;
  const [endNode, endOffset] = segment.map[end - 1].end;
  const range = doc.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

export function createLocatorTargetRecord(
  config,
  {
    resolveWithin,
    assertWithin,
    createRange,
  },
) {
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
    const element = directWithin ?? resolveWithin(config.within);
    if (directWithin !== null) {
      assertWithin(directWithin);
    }
    const range = createRange(element, text, occurrence);
    record.element = element;
    record.range = range;
    record.ownerElement = element;
    return record;
  };
  return record.refresh();
}

function locatorRecord(config, doc, realm) {
  return createLocatorTargetRecord(config, {
    resolveWithin: (within) => resolveLocatorWithin(within, doc, realm),
    assertWithin: (within) => assertLocatorWithin(within, doc, realm),
    createRange: (within, text, occurrence) => (
      createLocatorRange(within, text, occurrence, doc)
    ),
  });
}

export function createElementTargetRecord(element, assertElement) {
  const record = {
    kind: 'element',
    source: element,
    element,
    range: null,
    ownerElement: element,
    refresh: null,
  };
  record.refresh = () => {
    assertElement(element);
    return record;
  };
  return record;
}

function elementRecord(element, doc, realm) {
  return createElementTargetRecord(
    element,
    (value) => assertConnectedElement(value, doc, realm),
  );
}

export function createSelectorTargetRecord(selector, findElement) {
  const record = {
    kind: 'selector',
    source: selector,
    element: null,
    range: null,
    ownerElement: null,
    refresh: null,
  };
  record.refresh = () => {
    const element = findElement(selector);
    record.element = element;
    record.ownerElement = element;
    return record;
  };
  return record.refresh();
}

function selectorRecord(selector, doc, realm) {
  return createSelectorTargetRecord(
    selector,
    (value) => findSelectorTarget(value, doc, realm),
  );
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

export function createRangeTargetRecord(
  source,
  {
    cloneRange,
    getOwnerElement,
    assertRange,
    getBoundaryNodes,
    assertBoundaryNodes,
  },
) {
  assertRange(source);
  const range = cloneRange(source);
  const boundaryNodes = getBoundaryNodes(range);
  const ownerElement = getOwnerElement(range);
  const record = {
    kind: 'range',
    source,
    element: null,
    range,
    ownerElement,
    refresh: null,
  };
  record.refresh = () => {
    assertBoundaryNodes(boundaryNodes, range);
    return record;
  };
  return record;
}

function rangeRecord(source, doc, realm) {
  return createRangeTargetRecord(source, {
    cloneRange: (range) => range.cloneRange(),
    getOwnerElement(range) {
      const ownerElement = rangeOwnerElement(range, doc, realm);
      if (ownerElement === null) {
        throw targetError('HANA_TARGET_INVALID', 'Target Range must have an Element owner in the document tree', {
          target: source,
        });
      }
      return ownerElement;
    },
    assertRange: (range) => assertConnectedRange(range, doc, realm),
    getBoundaryNodes: (range) => [range.startContainer, range.endContainer],
    assertBoundaryNodes(boundaryNodes, range) {
      if (!boundaryNodes.every((node) => isConnectedBoundary(node, doc))) {
        throw targetError('HANA_TARGET_INVALID', 'Target Range boundaries are no longer connected to the document', {
          target: range,
        });
      }
    },
  });
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
  const config = readLocatorConfig(target, realm);
  if (config !== null) {
    return locatorRecord(config, doc, realm);
  }
  throw targetError('HANA_TARGET_INVALID', 'Target must be an Element, selector, or Range', { target });
}
