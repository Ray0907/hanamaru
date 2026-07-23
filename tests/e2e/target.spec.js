import { expect, test } from '@playwright/test';

async function resolve(page, expression) {
  return page.evaluate(async (source) => {
    const { resolveTarget } = await import('/src/target.js');
    return Function('resolveTarget', `return (${source});`)(resolveTarget);
  }, expression);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/targets.html');
});

test('@element resolves one connected Element and refreshes its same record', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const target = document.querySelector('#unique-target');
    const markup = document.body.innerHTML;
    const record = resolveTarget(target);
    const refreshed = record.refresh();
    return {
      sameRecord: record === refreshed,
      sameSource: record.source === target,
      sameElement: record.element === target && record.ownerElement === target,
      shape: ['kind', 'source', 'element', 'range', 'ownerElement', 'refresh'].every((key) => key in record),
      kind: record.kind,
      range: record.range,
      unchanged: document.body.innerHTML === markup,
    };
  })()`);
  expect(result).toEqual({ sameRecord: true, sameSource: true, sameElement: true, shape: true, kind: 'element', range: null, unchanged: true });
});

test('@element rejects disconnected and cross-document Element objects on construction and refresh', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const { body } = document;
    const disconnected = document.createElement('i');
    const target = document.querySelector('#unique-target');
    const record = resolveTarget(target);
    target.remove();
    const outcomes = [];
    for (const action of [() => resolveTarget(disconnected), () => record.refresh(), () => resolveTarget(document.implementation.createHTMLDocument().body)]) {
      try { action(); } catch (error) { outcomes.push([error.name, error.code, Boolean(error.details)]); }
    }
    return outcomes;
  })()`);
  expect(result).toEqual([
    ['HanamaruTargetError', 'HANA_TARGET_INVALID', true],
    ['HanamaruTargetError', 'HANA_TARGET_INVALID', true],
    ['HanamaruTargetError', 'HANA_TARGET_INVALID', true],
  ]);
});

test('@element resolves a unique selector and recovers to its replacement on refresh', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const markup = document.body.innerHTML;
    const record = resolveTarget('#unique-target');
    const first = record.element;
    first.replaceWith(Object.assign(document.createElement('p'), { id: 'unique-target', textContent: 'Replacement' }));
    const refreshed = record.refresh();
    return {
      kind: record.kind, source: record.source, sameRecord: record === refreshed,
      replaced: record.element !== first, ownerMatches: record.ownerElement === record.element,
      range: record.range, unchangedAsideFromReplacement: !document.querySelector('#unique-target').querySelector('*'),
      wrappers: document.querySelectorAll('[data-hanamaru]').length,
      initialMarkupHadNoWrappers: !markup.includes('data-hanamaru'),
    };
  })()`);
  expect(result).toEqual({ kind: 'selector', source: '#unique-target', sameRecord: true, replaced: true, ownerMatches: true, range: null, unchangedAsideFromReplacement: true, wrappers: 0, initialMarkupHadNoWrappers: true });
});

test('@element reports invalid, missing, and ambiguous selectors with exact codes', async ({ page }) => {
  const result = await resolve(page, `(() => ['[', '#not-here', '.duplicate-target', { text: 'not yet' }, 42].map((target) => {
    try { resolveTarget(target); return 'ok'; } catch (error) { return [error.name, error.code, Boolean(error.details)]; }
  }))()`);
  expect(result).toEqual([
    ['HanamaruTargetError', 'HANA_TARGET_INVALID', true],
    ['HanamaruTargetError', 'HANA_TARGET_MISSING', true],
    ['HanamaruTargetError', 'HANA_TARGET_AMBIGUOUS', true],
    ['HanamaruTargetError', 'HANA_TARGET_INVALID', true],
    ['HanamaruTargetError', 'HANA_TARGET_INVALID', true],
  ]);
});

test('@element @range rejects spoofed Element and Range objects without invoking their behavior', async ({ page }) => {
  const result = await resolve(page, `(() => {
    let calls = 0;
    const elementLike = {
      nodeType: 1,
      get matches() { calls += 1; throw new Error('spoofed Element invoked'); },
    };
    const rangeLike = {
      [Symbol.toStringTag]: 'Range',
      get cloneRange() { calls += 1; throw new Error('spoofed Range invoked'); },
    };
    const outcomes = [elementLike, rangeLike].map((target) => {
      try { resolveTarget(target); return 'ok'; } catch (error) { return [error.name, error.code]; }
    });
    return { outcomes, calls };
  })()`);
  expect(result).toEqual({
    outcomes: [
      ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
      ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
    ],
    calls: 0,
  });
});

test('@element rejects documents without a usable browsing realm with typed errors', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const other = document.implementation.createHTMLDocument('other');
    return [other.body, 'body', other.createRange()].map((target) => {
      try { resolveTarget(target, other); return 'ok'; } catch (error) { return [error.name, error.code]; }
    });
  })()`);
  expect(result).toEqual([
    ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
    ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
    ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
  ]);
});

test('@range clones native Range with nested owner and preserves caller mutation isolation', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const host = document.querySelector('#range-host');
    const original = document.createRange();
    original.setStart(host.firstChild.firstChild, 1);
    original.setEnd(host.children[1].firstChild, 5);
    const markup = document.body.innerHTML;
    const record = resolveTarget(original);
    const before = [record.range.startContainer === original.startContainer, record.range.startOffset, record.range.endContainer === original.endContainer, record.range.endOffset];
    original.selectNodeContents(host);
    return {
      kind: record.kind, source: record.source === original, clone: record.range !== original,
      element: record.element, owner: record.ownerElement === host,
      boundaries: before, isolated: record.range.startOffset === 1 && record.range.endOffset === 5,
      unchanged: document.body.innerHTML === markup,
    };
  })()`);
  expect(result).toEqual({ kind: 'range', source: true, clone: true, element: null, owner: true, boundaries: [true, 1, true, 5], isolated: true, unchanged: true });
});

test('@range accepts a collapsed Range and refreshes only its cloned connected boundaries', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const text = document.querySelector('#range-host').firstChild.firstChild;
    const original = document.createRange();
    original.setStart(text, 2); original.collapse(true);
    const record = resolveTarget(original);
    const firstRange = record.range;
    original.setStart(text, 0); original.collapse(true);
    const same = record.refresh();
    const offsetBeforeDisconnect = firstRange.startOffset;
    text.parentElement.remove();
    let code;
    try { record.refresh(); } catch (error) { code = error.code; }
    return { collapsed: firstRange.collapsed, sameRecord: same === record, sameRange: record.range === firstRange, offsetBeforeDisconnect, code };
  })()`);
  expect(result).toEqual({ collapsed: true, sameRecord: true, sameRange: true, offsetBeforeDisconnect: 2, code: 'HANA_TARGET_INVALID' });
});

test('@range gives document-root Ranges an HTML owner and rejects ShadowRoot ancestors', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const documentRange = document.createRange();
    documentRange.setStart(document, 0);
    documentRange.setEnd(document, document.childNodes.length);
    const record = resolveTarget(documentRange);

    const host = document.body.appendChild(document.createElement('div'));
    const shadow = host.attachShadow({ mode: 'open' });
    const text = shadow.appendChild(document.createTextNode('shadow'));
    const shadowRange = document.createRange(); shadowRange.selectNode(text);
    let shadowCode;
    try { resolveTarget(shadowRange); } catch (error) { shadowCode = error.code; }
    host.remove();

    return { owner: record.ownerElement === document.documentElement, shadowCode };
  })()`);
  expect(result).toEqual({ owner: true, shadowCode: 'HANA_TARGET_INVALID' });
});

test('@range rejects disconnected and cross-document Range boundaries', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const detached = document.createElement('div').appendChild(document.createTextNode('x'));
    const disconnected = document.createRange(); disconnected.selectNode(detached);
    const other = document.implementation.createHTMLDocument('other');
    const otherText = other.body.appendChild(other.createTextNode('x'));
    const crossDocument = other.createRange(); crossDocument.selectNode(otherText);
    const iframe = document.body.appendChild(document.createElement('iframe'));
    const frameText = iframe.contentDocument.body.appendChild(iframe.contentDocument.createTextNode('x'));
    const frameRange = iframe.contentDocument.createRange(); frameRange.selectNode(frameText);
    const results = [disconnected, crossDocument, frameRange].map((target) => {
      try { resolveTarget(target); return 'ok'; } catch (error) { return [error.name, error.code, Boolean(error.details)]; }
    });
    iframe.remove();
    return results;
  })()`);
  expect(result).toEqual([
    ['HanamaruTargetError', 'HANA_TARGET_INVALID', true],
    ['HanamaruTargetError', 'HANA_TARGET_INVALID', true],
    ['HanamaruTargetError', 'HANA_TARGET_INVALID', true],
  ]);
});

test('@locator-map maps normalized split-node text to exact native Range boundaries without DOM mutation', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const within = document.querySelector('#split-locator');
    const start = within.querySelector('[data-locator-part="start"]').firstChild;
    const end = within.querySelector('[data-locator-part="end"]').firstChild;
    const markup = within.innerHTML;
    const childNodes = within.querySelectorAll('*').length;
    const record = resolveTarget({ within, text: '  😀Alpha\\t beta  ' });
    return {
      kind: record.kind,
      native: record.range instanceof Range,
      owner: record.ownerElement === within && record.element === within,
      startNode: record.range.startContainer === start,
      startOffset: record.range.startOffset,
      endNode: record.range.endContainer === end,
      endOffset: record.range.endOffset,
      normalizedSelection: record.range.toString().trim().replace(/\\s+/gu, ' '),
      markupUnchanged: within.innerHTML === markup,
      nodeCountUnchanged: within.querySelectorAll('*').length === childNodes,
      wrappers: document.querySelectorAll('[data-hanamaru]').length,
    };
  })()`);
  expect(result).toEqual({
    kind: 'locator', native: true, owner: true,
    startNode: true, startOffset: 7, endNode: true, endOffset: 4,
    normalizedSelection: '😀Alpha beta', markupUnchanged: true,
    nodeCountUnchanged: true, wrappers: 0,
  });
});

test('@locator-map excludes forbidden subtrees and selects visible duplicate occurrences in document order', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const within = document.querySelector('#locator-root');
    return [0, 1].map((occurrence) => {
      const record = resolveTarget({ within, text: 'Tempting duplicate phrase', occurrence });
      const expected = within.querySelector('[data-visible-duplicate="' + (occurrence === 0 ? 'first' : 'second') + '"]').firstChild;
      return {
        start: record.range.startContainer === expected && record.range.startOffset === 0,
        end: record.range.endContainer === expected && record.range.endOffset === expected.data.length,
        selected: record.range.toString(),
      };
    });
  })()`);
  expect(result).toEqual([
    { start: true, end: true, selected: 'Tempting duplicate phrase' },
    { start: true, end: true, selected: 'Tempting duplicate phrase' },
  ]);
});

test('@locator-map excludes text when direct and selector within containers have hidden or inert ancestors', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const cases = [
      [document.querySelector('#hidden-ancestor-locator'), 'Hidden ancestor unique phrase'],
      ['#hidden-ancestor-locator', 'Hidden ancestor unique phrase'],
      [document.querySelector('#inert-ancestor-locator'), 'Inert ancestor unique phrase'],
      ['#inert-ancestor-locator', 'Inert ancestor unique phrase'],
    ];
    return cases.map(([within, text]) => {
      try { resolveTarget({ within, text }); return 'ok'; } catch (error) { return [error.name, error.code]; }
    });
  })()`);
  expect(result).toEqual([
    ['HanamaruTargetError', 'HANA_TARGET_MISSING'],
    ['HanamaruTargetError', 'HANA_TARGET_MISSING'],
    ['HanamaruTargetError', 'HANA_TARGET_MISSING'],
    ['HanamaruTargetError', 'HANA_TARGET_MISSING'],
  ]);
});

test('@locator-map treats excluded subtrees as hard match barriers while preserving eligible segment order', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const within = document.querySelector('#locator-barrier-host');
    const markup = within.innerHTML;
    const bridgeCodes = ['ab', 'left right'].map((text) => {
      try { resolveTarget({ within, text }); return 'ok'; } catch (error) { return error.code; }
    });
    const singleNodes = ['a', 'b'].map((text) => {
      const record = resolveTarget({ within, text });
      return {
        start: record.range.startContainer === within.querySelector('[data-barrier-' + (text === 'a' ? 'before' : 'after') + ']').firstChild,
        selected: record.range.toString(),
      };
    });
    const duplicateNodes = [0, 1].map((occurrence) => {
      const record = resolveTarget({ within, text: 'echo', occurrence });
      const expected = within.querySelector('[data-segment-duplicate="' + (occurrence === 0 ? 'first' : 'second') + '"]').firstChild;
      return record.range.startContainer === expected && record.range.endContainer === expected;
    });
    return { bridgeCodes, singleNodes, duplicateNodes, unchanged: within.innerHTML === markup };
  })()`);
  expect(result).toEqual({
    bridgeCodes: ['HANA_TARGET_MISSING', 'HANA_TARGET_MISSING'],
    singleNodes: [{ start: true, selected: 'a' }, { start: true, selected: 'b' }],
    duplicateNodes: [true, true],
    unchanged: true,
  });
});

test('@locator reports missing, ambiguous, and out-of-range text matches with exact codes', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const within = '#locator-root';
    const targets = [
      { within, text: 'Not present' },
      { within, text: 'Tempting duplicate phrase' },
      { within, text: 'Tempting duplicate phrase', occurrence: 2 },
    ];
    return targets.map((target) => {
      try { resolveTarget(target); return 'ok'; } catch (error) { return [error.name, error.code, Boolean(error.details)]; }
    });
  })()`);
  expect(result).toEqual([
    ['HanamaruTargetError', 'HANA_TARGET_MISSING', true],
    ['HanamaruTargetError', 'HANA_TARGET_AMBIGUOUS', true],
    ['HanamaruTargetError', 'HANA_TARGET_MISSING', true],
  ]);
});

test('@locator exposes exact record shape and refreshes same-element text with a new Range', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const within = document.querySelector('#element-locator-host');
    const target = { within, text: 'Element locator phrase' };
    const record = resolveTarget(target);
    const firstRange = record.range;
    const source = record.source;
    target.text = 'caller mutation';
    within.innerHTML = 'Prefix <b>Element locator phrase</b> suffix';
    const refreshed = record.refresh();
    return {
      keys: Object.keys(record).sort(),
      sameRecord: refreshed === record,
      newRange: record.range !== firstRange,
      sameElement: record.element === within && record.ownerElement === within,
      selected: record.range.toString(),
      sourceCopy: source !== target && source.within === within && source.text === 'Element locator phrase' && !('occurrence' in source),
    };
  })()`);
  expect(result).toEqual({
    keys: ['element', 'kind', 'ownerElement', 'range', 'refresh', 'source'],
    sameRecord: true, newRange: true, sameElement: true,
    selected: 'Element locator phrase', sourceCopy: true,
  });
});

test('@locator selector refresh adopts a unique replacement and rebuilds its Range', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const record = resolveTarget({ within: '#replaceable-locator-host', text: 'Original selector phrase' });
    const firstElement = record.element;
    const firstRange = record.range;
    const replacement = document.createElement('section');
    replacement.id = 'replaceable-locator-host';
    replacement.innerHTML = '<i>Original</i> selector phrase';
    firstElement.replaceWith(replacement);
    const refreshed = record.refresh();
    return {
      sameRecord: refreshed === record,
      replacement: record.element === replacement && record.ownerElement === replacement,
      newRange: record.range !== firstRange,
      selected: record.range.toString(),
      source: record.source.within === '#replaceable-locator-host' && record.source.text === 'Original selector phrase',
    };
  })()`);
  expect(result).toEqual({ sameRecord: true, replacement: true, newRange: true, selected: 'Original selector phrase', source: true });
});

test('@locator direct Element refresh never adopts a lookalike replacement and fails atomically', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const within = document.querySelector('#element-locator-host');
    const record = resolveTarget({ within, text: 'Element locator phrase' });
    const range = record.range;
    const replacement = within.cloneNode(true);
    within.replaceWith(replacement);
    let code;
    try { record.refresh(); } catch (error) { code = error.code; }
    return {
      code,
      oldElement: record.element === within && record.ownerElement === within,
      notReplacement: record.element !== replacement,
      oldRange: record.range === range,
    };
  })()`);
  expect(result).toEqual({
    code: 'HANA_TARGET_INVALID', oldElement: true, notReplacement: true,
    oldRange: true,
  });
});

test('@locator selector refresh failures preserve the last successful element and Range atomically', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const record = resolveTarget({ within: '#replaceable-locator-host', text: 'Original selector phrase' });
    const element = record.element;
    const range = record.range;
    const duplicate = element.cloneNode(true);
    element.after(duplicate);
    let code;
    try { record.refresh(); } catch (error) { code = error.code; }
    return {
      code,
      sameElement: record.element === element && record.ownerElement === element,
      sameRange: record.range === range,
      preservedSelection: record.range.toString(),
    };
  })()`);
  expect(result).toEqual({
    code: 'HANA_TARGET_AMBIGUOUS', sameElement: true, sameRange: true,
    preservedSelection: 'Original selector phrase',
  });
});

test('@locator validates plain own-key locator objects without invoking inherited getters', async ({ page }) => {
  const result = await resolve(page, `(() => {
    let inheritedCalls = 0;
    const inherited = Object.create({
      get within() { inheritedCalls += 1; throw new Error('inherited within invoked'); },
      get text() { inheritedCalls += 1; throw new Error('inherited text invoked'); },
    });
    const array = [];
    array.within = '#locator-root'; array.text = 'Before';
    const targets = [
      { within: '#locator-root', text: 42 },
      { within: '#locator-root', text: 'Before', occurrence: -1 },
      { within: '#locator-root' },
      { text: 'Before' },
      { within: '#locator-root', text: 'Before', extra: true },
      array,
      inherited,
      Object.create(null, {
        within: { value: '#element-locator-host', enumerable: true },
        text: { value: 'Element locator phrase', enumerable: true },
      }),
    ];
    const outcomes = targets.map((target) => {
      try { return resolveTarget(target).kind; } catch (error) { return [error.name, error.code]; }
    });
    return { outcomes, inheritedCalls };
  })()`);
  expect(result).toEqual({
    outcomes: [
      ['HanamaruConfigError', 'HANA_CONFIG_INVALID'],
      ['HanamaruConfigError', 'HANA_CONFIG_INVALID'],
      ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
      ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
      ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
      ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
      ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
      'locator',
    ],
    inheritedCalls: 0,
  });
});

test('@locator rejects invalid, missing, ambiguous, cross-document, and Shadow DOM within values', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const detached = document.createElement('div'); detached.textContent = 'needle';
    const other = document.implementation.createHTMLDocument('other');
    const foreign = other.body.appendChild(other.createElement('div')); foreign.textContent = 'needle';
    const host = document.body.appendChild(document.createElement('div'));
    const shadowWithin = host.attachShadow({ mode: 'open' }).appendChild(document.createElement('div'));
    shadowWithin.textContent = 'needle';
    const targets = [
      { within: 42, text: 'needle' },
      { within: '[', text: 'needle' },
      { within: '#not-here', text: 'needle' },
      { within: '.duplicate-target', text: 'needle' },
      { within: detached, text: 'needle' },
      { within: foreign, text: 'needle' },
      { within: shadowWithin, text: 'needle' },
    ];
    const outcomes = targets.map((target) => {
      try { resolveTarget(target); return 'ok'; } catch (error) { return [error.name, error.code]; }
    });
    host.remove();
    return outcomes;
  })()`);
  expect(result).toEqual([
    ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
    ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
    ['HanamaruTargetError', 'HANA_TARGET_MISSING'],
    ['HanamaruTargetError', 'HANA_TARGET_AMBIGUOUS'],
    ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
    ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
    ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
  ]);
});

test('@locator accepts only module, active iframe, and null ordinary prototypes', async ({ page }) => {
  const result = await resolve(page, `(() => {
    const frame = document.body.appendChild(document.createElement('iframe'));
    const foreignFrame = document.body.appendChild(document.createElement('iframe'));
    const frameDocument = frame.contentDocument;
    const target = frameDocument.body.appendChild(frameDocument.createElement('p'));
    target.id = 'frame-locator';
    target.textContent = 'Parent literal iframe phrase';

    const parentLiteral = {
      within: '#frame-locator',
      text: 'literal iframe',
    };
    const activeRealmLiteral = new frame.contentWindow.Object();
    activeRealmLiteral.within = '#frame-locator';
    activeRealmLiteral.text = 'iframe phrase';
    const nullLiteral = Object.create(null);
    nullLiteral.within = '#frame-locator';
    nullLiteral.text = 'Parent literal';
    const customLiteral = Object.create({});
    customLiteral.within = '#frame-locator';
    customLiteral.text = 'Parent literal';
    const unexpectedRealmLiteral = new foreignFrame.contentWindow.Object();
    unexpectedRealmLiteral.within = '#frame-locator';
    unexpectedRealmLiteral.text = 'Parent literal';

    const outcomes = [
      parentLiteral,
      activeRealmLiteral,
      nullLiteral,
      customLiteral,
      unexpectedRealmLiteral,
    ].map((locator) => {
      try {
        const record = resolveTarget(locator, frameDocument);
        return {
          kind: record.kind,
          selected: record.range.toString(),
          owner: record.ownerElement === target,
          realm: record.range instanceof frame.contentWindow.Range,
          root: record.range.startContainer.getRootNode() === frameDocument
            && record.range.endContainer.getRootNode() === frameDocument,
        };
      } catch (error) {
        return [error.name, error.code];
      }
    });
    frame.remove();
    foreignFrame.remove();
    return outcomes;
  })()`);

  expect(result).toEqual([
    {
      kind: 'locator',
      selected: 'literal iframe',
      owner: true,
      realm: true,
      root: true,
    },
    {
      kind: 'locator',
      selected: 'iframe phrase',
      owner: true,
      realm: true,
      root: true,
    },
    {
      kind: 'locator',
      selected: 'Parent literal',
      owner: true,
      realm: true,
      root: true,
    },
    ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
    ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
  ]);
});
