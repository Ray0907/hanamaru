import { expect, test } from '@playwright/test';

const browserErrors = new WeakMap();

async function evaluateShadow(page, expression) {
  return page.evaluate(async (source) => {
    const {
      assertShadowRoot,
      resolveShadowTarget,
    } = await import('/src/shadow-target.js');
    const { HanamaruTargetError } = await import('/src/errors.js');
    return Function(
      'assertShadowRoot',
      'resolveShadowTarget',
      'HanamaruTargetError',
      `return (${source});`,
    )(assertShadowRoot, resolveShadowTarget, HanamaruTargetError);
  }, expression);
}

async function evaluateStyles(page, expression) {
  return page.evaluate(async (source) => {
    const {
      acquireShadowStyles,
      normalizeShadowStyles,
    } = await import('/src/shadow-styles.js');
    const {
      HanamaruConfigError,
      HanamaruStateError,
    } = await import('/src/errors.js');
    const { runtimeState } = await import('/src/runtime-state.js');
    return Function(
      'acquireShadowStyles',
      'normalizeShadowStyles',
      'HanamaruConfigError',
      'HanamaruStateError',
      'runtimeState',
      `return (${source});`,
    )(
      acquireShadowStyles,
      normalizeShadowStyles,
      HanamaruConfigError,
      HanamaruStateError,
      runtimeState,
    );
  }, expression);
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/tests/fixtures/shadow.html');
  await page.evaluate(() => {
    window.__shadowUnhandledRejections = [];
    window.addEventListener('unhandledrejection', (event) => {
      window.__shadowUnhandledRejections.push(String(event.reason));
    });
    const openHost = document.querySelector('#open-host');
    const openRoot = openHost.attachShadow({ mode: 'open' });
    openRoot.innerHTML = `
      <section id="scope">
        <p id="unique" class="shared-selector">Unique shadow target</p>
        <p class="duplicate">Duplicate one</p>
        <p class="duplicate">Duplicate two</p>
        <article id="range-owner"><span>Range </span><strong>inside</strong></article>
        <section id="locator-root">
          <p id="split"><span data-start>Before 😀A</span><strong>lpha</strong>&nbsp;
            <em data-end>beta</em> after</p>
          <p data-repeat="first">Repeated exact phrase</p>
          <p data-repeat="second">Repeated exact phrase</p>
          <p id="replaceable">Replaceable exact phrase</p>
          <span hidden>Nested-only hidden phrase</span>
        </section>
        <div id="nested-host"></div>
      </section>
    `;
    const nestedRoot = openRoot.querySelector('#nested-host').attachShadow({ mode: 'open' });
    nestedRoot.innerHTML = `
      <p id="nested-only" class="nested-only">Nested-only exact phrase</p>
    `;

    const closedHost = document.querySelector('#closed-host');
    const closedRoot = closedHost.attachShadow({ mode: 'closed' });
    closedRoot.innerHTML = '<p id="closed-target">Retained closed root phrase</p>';

    const otherHost = document.querySelector('#other-host');
    const otherRoot = otherHost.attachShadow({ mode: 'open' });
    otherRoot.innerHTML = '<p id="other-target">Other root phrase</p>';

    const disconnectedHost = document.createElement('div');
    document.body.append(disconnectedHost);
    const disconnectedRoot = disconnectedHost.attachShadow({ mode: 'open' });
    disconnectedRoot.innerHTML = '<p>Disconnected root phrase</p>';
    disconnectedHost.remove();

    const frame = document.querySelector('#foreign-frame');
    const frameHost = frame.contentDocument.body.appendChild(
      frame.contentDocument.createElement('div'),
    );
    const frameRoot = frameHost.attachShadow({ mode: 'open' });
    frameRoot.innerHTML = '<p id="frame-target">Iframe root phrase</p>';

    window.__shadowFixture = {
      openRoot,
      closedRoot,
      otherRoot,
      nestedRoot,
      disconnectedRoot,
      frameRoot,
    };
  });
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
  expect(await page.evaluate(() => window.__shadowUnhandledRejections)).toEqual([]);
});

test('root validates connected native open, retained closed, nested, and iframe ShadowRoots', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    return {
      open: assertShadowRoot(fixture.openRoot) === fixture.openRoot,
      closed: assertShadowRoot(fixture.closedRoot) === fixture.closedRoot,
      nested: assertShadowRoot(fixture.nestedRoot) === fixture.nestedRoot,
      iframe: assertShadowRoot(fixture.frameRoot) === fixture.frameRoot,
    };
  })()`);

  expect(result).toEqual({
    open: true,
    closed: true,
    nested: true,
    iframe: true,
  });
});

test('root iframe scope resolves selector, Element, Range, and parent-realm locator records', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    const root = fixture.frameRoot;
    const target = root.querySelector('#frame-target');
    const frame = document.querySelector('#foreign-frame');
    const source = frame.contentDocument.createRange();
    source.setStart(target.firstChild, 0);
    source.setEnd(target.firstChild, 11);

    const selector = resolveShadowTarget('#frame-target', root);
    const element = resolveShadowTarget(target, root);
    const range = resolveShadowTarget(source, root);
    const parentLiteral = {
      within: '#frame-target',
      text: 'root phrase',
    };
    const locator = resolveShadowTarget(parentLiteral, root);
    const clonedRange = range.range;
    const locatorRange = locator.range;
    source.selectNodeContents(target);

    return {
      selector: selector.kind === 'selector'
        && selector.element === target
        && selector.ownerElement === target
        && selector.refresh() === selector,
      element: element.kind === 'element'
        && element.element === target
        && element.ownerElement === target
        && element.refresh() === element,
      range: range.kind === 'range'
        && clonedRange !== source
        && clonedRange instanceof frame.contentWindow.Range
        && clonedRange.startOffset === 0
        && clonedRange.endOffset === 11
        && range.ownerElement === target
        && range.refresh() === range
        && range.range === clonedRange,
      locator: locator.kind === 'locator'
        && locator.source !== parentLiteral
        && locator.source.within === '#frame-target'
        && locator.range.toString() === 'root phrase'
        && locator.ownerElement === target
        && locator.refresh() === locator
        && locator.range !== locatorRange,
      exactRoots: [
        selector.element,
        element.element,
        clonedRange.startContainer,
        clonedRange.endContainer,
        locator.range.startContainer,
        locator.range.endContainer,
        locator.ownerElement,
      ].every((node) => node.getRootNode() === root),
    };
  })()`);

  expect(result).toEqual({
    selector: true,
    element: true,
    range: true,
    locator: true,
    exactRoots: true,
  });
});

test('direct nested-root targets resolve only when that exact nested root is supplied', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    const target = fixture.nestedRoot.querySelector('#nested-only');
    const element = resolveShadowTarget(target, fixture.nestedRoot);
    const source = document.createRange();
    source.selectNodeContents(target);
    const range = resolveShadowTarget(source, fixture.nestedRoot);
    return {
      element: element.element === target
        && element.ownerElement === target
        && target.getRootNode() === fixture.nestedRoot,
      range: range.ownerElement === target
        && range.range.startContainer.getRootNode() === fixture.nestedRoot
        && range.range.endContainer.getRootNode() === fixture.nestedRoot,
    };
  })()`);

  expect(result).toEqual({ element: true, range: true });
});

test('root rejects disconnected, non-ShadowRoot, foreign, and forged objects without behavior', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    let calls = 0;
    const spoof = Object.create(ShadowRoot.prototype);
    for (const key of ['ownerDocument', 'host', 'isConnected', 'getRootNode']) {
      Object.defineProperty(spoof, key, {
        configurable: true,
        get() {
          calls += 1;
          throw new Error('spoof behavior invoked');
        },
      });
    }
    const targets = [
      fixture.disconnectedRoot,
      document,
      document.createDocumentFragment(),
      document.querySelector('#foreign-frame').contentDocument.body,
      spoof,
      null,
    ];
    const outcomes = targets.map((root) => {
      try {
        assertShadowRoot(root);
        return 'ok';
      } catch (error) {
        return [error.name, error.code, Boolean(error.details)];
      }
    });
    return { outcomes, calls };
  })()`);

  expect(result).toEqual({
    outcomes: Array(6).fill(['HanamaruTargetError', 'HANA_TARGET_INVALID', true]),
    calls: 0,
  });
});

test('direct target classification contains raw and typed Proxy prototype traps', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const root = window.__shadowFixture.openRoot;
    const rawCause = new Error('raw prototype trap');
    const typedCause = new HanamaruTargetError(
      'HANA_TARGET_MISSING',
      'typed prototype trap',
      { forged: false },
    );
    let calls = 0;
    const cases = [rawCause, typedCause].map((cause) => {
      const target = new Proxy({}, {
        getPrototypeOf() {
          calls += 1;
          throw cause;
        },
      });
      try {
        resolveShadowTarget(target, root);
        return 'ok';
      } catch (error) {
        const details = error !== null && typeof error.details === 'object'
          ? error.details
          : {};
        return {
          typed: error instanceof HanamaruTargetError,
          code: error.code,
          target: details.target === target,
          root: details.root === root,
          cause: details.cause === cause,
          wrapped: error !== cause,
        };
      }
    });
    return { cases, calls };
  })()`);

  expect(result).toEqual({
    cases: [
      {
        typed: true,
        code: 'HANA_TARGET_INVALID',
        target: true,
        root: true,
        cause: true,
        wrapped: true,
      },
      {
        typed: true,
        code: 'HANA_TARGET_INVALID',
        target: true,
        root: true,
        cause: true,
        wrapped: true,
      },
    ],
    calls: 2,
  });
});

test('direct Element targets require the exact root and preserve target records', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    const target = fixture.openRoot.querySelector('#unique');
    const record = resolveShadowTarget(target, fixture.openRoot);
    const refreshed = record.refresh();
    const closedTarget = fixture.closedRoot.querySelector('#closed-target');
    const closedRecord = resolveShadowTarget(closedTarget, fixture.closedRoot);
    return {
      kind: record.kind,
      keys: Object.keys(record).sort(),
      sameRecord: refreshed === record,
      sameSource: record.source === target,
      sameElement: record.element === target && record.ownerElement === target,
      exactRoot: record.element.getRootNode() === fixture.openRoot,
      range: record.range,
      closed: closedRecord.element === closedTarget
        && closedRecord.element.getRootNode() === fixture.closedRoot,
    };
  })()`);

  expect(result).toEqual({
    kind: 'element',
    keys: ['element', 'kind', 'ownerElement', 'range', 'refresh', 'source'],
    sameRecord: true,
    sameSource: true,
    sameElement: true,
    exactRoot: true,
    range: null,
    closed: true,
  });
});

test('direct Element targets reject nested, other-root, document, iframe, detached, and forged values', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    let calls = 0;
    const spoof = {
      get isConnected() {
        calls += 1;
        throw new Error('spoof behavior invoked');
      },
      getRootNode() {
        calls += 1;
        throw new Error('spoof behavior invoked');
      },
    };
    const detached = fixture.openRoot.querySelector('#unique').cloneNode(true);
    const targets = [
      fixture.nestedRoot.querySelector('#nested-only'),
      fixture.otherRoot.querySelector('#other-target'),
      document.querySelector('#document-only'),
      fixture.frameRoot.querySelector('#frame-target'),
      detached,
      spoof,
    ];
    const outcomes = targets.map((target) => {
      try {
        resolveShadowTarget(target, fixture.openRoot);
        return 'ok';
      } catch (error) {
        return [error.name, error.code, Boolean(error.details)];
      }
    });
    return { outcomes, calls };
  })()`);

  expect(result).toEqual({
    outcomes: Array(6).fill(['HanamaruTargetError', 'HANA_TARGET_INVALID', true]),
    calls: 0,
  });
});

test('direct retained closed-root Range and locator records refresh and clean up exactly', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    const root = fixture.closedRoot;
    const host = document.querySelector('#closed-host');
    const target = root.querySelector('#closed-target');
    const source = document.createRange();
    source.setStart(target.firstChild, 0);
    source.setEnd(target.firstChild, 8);

    const range = resolveShadowTarget(source, root);
    const selectorLocator = resolveShadowTarget({
      within: '#closed-target',
      text: 'closed root',
    }, root);
    const elementLocator = resolveShadowTarget({
      within: target,
      text: 'root phrase',
    }, root);
    const rangeClone = range.range;
    const initial = {
      retained: host.shadowRoot === null && assertShadowRoot(root) === root,
      range: rangeClone !== source
        && rangeClone.toString() === 'Retained'
        && range.ownerElement === target
        && range.refresh() === range,
      selectorLocator: selectorLocator.range.toString() === 'closed root'
        && selectorLocator.ownerElement === target
        && selectorLocator.refresh() === selectorLocator,
      elementLocator: elementLocator.range.toString() === 'root phrase'
        && elementLocator.ownerElement === target
        && elementLocator.refresh() === elementLocator,
      exactRoots: [
        rangeClone.startContainer,
        rangeClone.endContainer,
        range.ownerElement,
        selectorLocator.range.startContainer,
        selectorLocator.range.endContainer,
        elementLocator.range.startContainer,
        elementLocator.range.endContainer,
      ].every((node) => node.getRootNode() === root),
    };

    host.remove();
    const outcomes = [
      () => assertShadowRoot(root),
      () => range.refresh(),
      () => selectorLocator.refresh(),
      () => elementLocator.refresh(),
    ].map((action) => {
      try {
        action();
        return 'ok';
      } catch (error) {
        return [error.name, error.code];
      }
    });
    root.replaceChildren();

    return {
      initial,
      outcomes,
      cleanup: !target.isConnected && root.childNodes.length === 0,
    };
  })()`);

  expect(result).toEqual({
    initial: {
      retained: true,
      range: true,
      selectorLocator: true,
      elementLocator: true,
      exactRoots: true,
    },
    outcomes: Array(4).fill(['HanamaruTargetError', 'HANA_TARGET_INVALID']),
    cleanup: true,
  });
});

test('direct Element refresh rejects removal without adopting replacements', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    const target = fixture.openRoot.querySelector('#unique');
    const record = resolveShadowTarget(target, fixture.openRoot);
    const replacement = target.cloneNode(true);
    target.replaceWith(replacement);
    let outcome = 'ok';
    try {
      record.refresh();
    } catch (error) {
      outcome = [error.name, error.code];
    }
    return {
      outcome,
      source: record.source === target,
      oldElement: record.element === target && record.ownerElement === target,
      notReplacement: record.element !== replacement,
    };
  })()`);

  expect(result).toEqual({
    outcome: ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
    source: true,
    oldElement: true,
    notReplacement: true,
  });
});

test('direct Range targets clone exact connected boundaries and retain refresh identity', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    const owner = fixture.openRoot.querySelector('#range-owner');
    const start = owner.firstElementChild.firstChild;
    const end = owner.lastElementChild.firstChild;
    const source = document.createRange();
    source.setStart(start, 1);
    source.setEnd(end, 4);
    const record = resolveShadowTarget(source, fixture.openRoot);
    const clone = record.range;
    source.selectNodeContents(owner);
    return {
      kind: record.kind,
      keys: Object.keys(record).sort(),
      source: record.source === source,
      clone: clone !== source && clone instanceof Range,
      owner: record.ownerElement === owner,
      exactRoots: [clone.startContainer, clone.endContainer, record.ownerElement]
        .every((node) => node.getRootNode() === fixture.openRoot),
      boundaries: [
        clone.startContainer === start,
        clone.startOffset,
        clone.endContainer === end,
        clone.endOffset,
      ],
      isolated: clone.startOffset === 1 && clone.endOffset === 4,
      refresh: record.refresh() === record && record.range === clone,
      element: record.element,
    };
  })()`);

  expect(result).toEqual({
    kind: 'range',
    keys: ['element', 'kind', 'ownerElement', 'range', 'refresh', 'source'],
    source: true,
    clone: true,
    owner: true,
    exactRoots: true,
    boundaries: [true, 1, true, 4],
    isolated: true,
    refresh: true,
    element: null,
  });
});

test('direct Range targets reject nested, other-root, document, cross-document, and ownerless roots', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    const rangeFor = (node) => {
      const range = node.ownerDocument.createRange();
      range.selectNodeContents(node);
      return range;
    };
    const rootSpanning = document.createRange();
    rootSpanning.setStartBefore(fixture.openRoot.querySelector('#scope'));
    rootSpanning.setEndAfter(fixture.openRoot.querySelector('#scope'));
    const targets = [
      rangeFor(fixture.nestedRoot.querySelector('#nested-only')),
      rangeFor(fixture.otherRoot.querySelector('#other-target')),
      rangeFor(document.querySelector('#document-only')),
      rangeFor(fixture.frameRoot.querySelector('#frame-target')),
      rootSpanning,
    ];
    return targets.map((target) => {
      try {
        resolveShadowTarget(target, fixture.openRoot);
        return 'ok';
      } catch (error) {
        return [error.name, error.code, Boolean(error.details)];
      }
    });
  })()`);

  expect(result).toEqual(
    Array(5).fill(['HanamaruTargetError', 'HANA_TARGET_INVALID', true]),
  );
});

test('direct Range refresh rejects disconnected cloned boundaries', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    const owner = fixture.openRoot.querySelector('#range-owner');
    const source = document.createRange();
    source.selectNodeContents(owner.firstElementChild);
    const record = resolveShadowTarget(source, fixture.openRoot);
    const clone = record.range;
    owner.remove();
    let outcome = 'ok';
    try {
      record.refresh();
    } catch (error) {
      outcome = [error.name, error.code];
    }
    return {
      outcome,
      sameRange: record.range === clone,
      source: record.source === source,
    };
  })()`);

  expect(result).toEqual({
    outcome: ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
    sameRange: true,
    source: true,
  });
});

test('selector resolves one exact-root Element and adopts only an exact-root replacement', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    const record = resolveShadowTarget('#unique', fixture.openRoot);
    const first = record.element;
    const replacement = first.cloneNode(true);
    first.replaceWith(replacement);
    const refreshed = record.refresh();
    return {
      kind: record.kind,
      source: record.source,
      keys: Object.keys(record).sort(),
      sameRecord: refreshed === record,
      replaced: record.element === replacement && record.ownerElement === replacement,
      exactRoot: record.element.getRootNode() === fixture.openRoot,
      range: record.range,
    };
  })()`);

  expect(result).toEqual({
    kind: 'selector',
    source: '#unique',
    keys: ['element', 'kind', 'ownerElement', 'range', 'refresh', 'source'],
    sameRecord: true,
    replaced: true,
    exactRoot: true,
    range: null,
  });
});

test('selector confines invalid, missing, ambiguous, owner-Document, and nested-root queries', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    return ['[', '#not-here', '.duplicate', '#document-only', '#nested-only']
      .map((target) => {
        try {
          resolveShadowTarget(target, fixture.openRoot);
          return 'ok';
        } catch (error) {
          return [error.name, error.code, Boolean(error.details)];
        }
      });
  })()`);

  expect(result).toEqual([
    ['HanamaruTargetError', 'HANA_TARGET_INVALID', true],
    ['HanamaruTargetError', 'HANA_TARGET_MISSING', true],
    ['HanamaruTargetError', 'HANA_TARGET_AMBIGUOUS', true],
    ['HanamaruTargetError', 'HANA_TARGET_MISSING', true],
    ['HanamaruTargetError', 'HANA_TARGET_MISSING', true],
  ]);
});

test('locator maps normalized split text to exact-root native Range boundaries', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    const within = fixture.openRoot.querySelector('#split');
    const start = within.querySelector('[data-start]').firstChild;
    const end = within.querySelector('[data-end]').firstChild;
    const markup = within.innerHTML;
    const target = { within, text: '  😀Alpha\\t beta  ' };
    const record = resolveShadowTarget(target, fixture.openRoot);
    target.text = 'caller mutation';
    return {
      kind: record.kind,
      keys: Object.keys(record).sort(),
      sourceCopy: record.source !== target
        && record.source.within === within
        && record.source.text === '  😀Alpha\\t beta  '
        && !('occurrence' in record.source),
      owner: record.element === within && record.ownerElement === within,
      native: record.range instanceof Range,
      exactRoots: [record.element, record.ownerElement,
        record.range.startContainer, record.range.endContainer]
        .every((node) => node.getRootNode() === fixture.openRoot),
      start: record.range.startContainer === start && record.range.startOffset === 7,
      end: record.range.endContainer === end && record.range.endOffset === 4,
      selected: record.range.toString().trim().replace(/\\s+/gu, ' '),
      unchanged: within.innerHTML === markup,
    };
  })()`);

  expect(result).toEqual({
    kind: 'locator',
    keys: ['element', 'kind', 'ownerElement', 'range', 'refresh', 'source'],
    sourceCopy: true,
    owner: true,
    native: true,
    exactRoots: true,
    start: true,
    end: true,
    selected: '😀Alpha beta',
    unchanged: true,
  });
});

test('locator supports root-confined selector within and zero-based occurrence', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    return [0, 1].map((occurrence) => {
      const record = resolveShadowTarget({
        within: '#locator-root',
        text: 'Repeated exact phrase',
        occurrence,
      }, fixture.openRoot);
      const expected = fixture.openRoot.querySelector(
        '[data-repeat="' + (occurrence === 0 ? 'first' : 'second') + '"]',
      ).firstChild;
      return {
        selected: record.range.toString(),
        expected: record.range.startContainer === expected
          && record.range.endContainer === expected,
        exactRoot: record.element.getRootNode() === fixture.openRoot
          && record.range.startContainer.getRootNode() === fixture.openRoot
          && record.range.endContainer.getRootNode() === fixture.openRoot,
      };
    });
  })()`);

  expect(result).toEqual([
    { selected: 'Repeated exact phrase', expected: true, exactRoot: true },
    { selected: 'Repeated exact phrase', expected: true, exactRoot: true },
  ]);
});

test('locator reports missing, ambiguous, and out-of-range matches with exact codes', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    const targets = [
      { within: '#locator-root', text: 'Not present' },
      { within: '#locator-root', text: 'Repeated exact phrase' },
      { within: '#locator-root', text: 'Repeated exact phrase', occurrence: 2 },
    ];
    return targets.map((target) => {
      try {
        resolveShadowTarget(target, fixture.openRoot);
        return 'ok';
      } catch (error) {
        return [error.name, error.code, Boolean(error.details)];
      }
    });
  })()`);

  expect(result).toEqual([
    ['HanamaruTargetError', 'HANA_TARGET_MISSING', true],
    ['HanamaruTargetError', 'HANA_TARGET_AMBIGUOUS', true],
    ['HanamaruTargetError', 'HANA_TARGET_MISSING', true],
  ]);
});

test('locator excludes owner-Document and nested-root selector or text matches', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    const targets = [
      { within: '#document-only', text: 'Owner Document only phrase' },
      { within: '#nested-only', text: 'Nested-only exact phrase' },
      { within: '#scope', text: 'Nested-only exact phrase' },
      {
        within: fixture.nestedRoot.querySelector('#nested-only'),
        text: 'Nested-only exact phrase',
      },
      {
        within: document.querySelector('#document-only'),
        text: 'Owner Document only phrase',
      },
      {
        within: fixture.otherRoot.querySelector('#other-target'),
        text: 'Other root phrase',
      },
    ];
    return targets.map((target) => {
      try {
        resolveShadowTarget(target, fixture.openRoot);
        return 'ok';
      } catch (error) {
        return [error.name, error.code];
      }
    });
  })()`);

  expect(result).toEqual([
    ['HanamaruTargetError', 'HANA_TARGET_MISSING'],
    ['HanamaruTargetError', 'HANA_TARGET_MISSING'],
    ['HanamaruTargetError', 'HANA_TARGET_MISSING'],
    ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
    ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
    ['HanamaruTargetError', 'HANA_TARGET_INVALID'],
  ]);
});

test('locator refresh is atomic for selector failure and never adopts direct replacements', async ({ page }) => {
  const result = await evaluateShadow(page, `(() => {
    const fixture = window.__shadowFixture;
    const selectorRecord = resolveShadowTarget({
      within: '#replaceable',
      text: 'Replaceable exact phrase',
    }, fixture.openRoot);
    const selectorElement = selectorRecord.element;
    const selectorRange = selectorRecord.range;
    selectorElement.after(selectorElement.cloneNode(true));
    let selectorCode;
    try {
      selectorRecord.refresh();
    } catch (error) {
      selectorCode = error.code;
    }

    const directWithin = fixture.openRoot.querySelector('#split');
    const directRecord = resolveShadowTarget({
      within: directWithin,
      text: 'Before',
    }, fixture.openRoot);
    const directRange = directRecord.range;
    const replacement = directWithin.cloneNode(true);
    directWithin.replaceWith(replacement);
    let directCode;
    try {
      directRecord.refresh();
    } catch (error) {
      directCode = error.code;
    }
    return {
      selectorCode,
      selectorAtomic: selectorRecord.element === selectorElement
        && selectorRecord.ownerElement === selectorElement
        && selectorRecord.range === selectorRange,
      directCode,
      directAtomic: directRecord.element === directWithin
        && directRecord.ownerElement === directWithin
        && directRecord.range === directRange
        && directRecord.element !== replacement,
    };
  })()`);

  expect(result).toEqual({
    selectorCode: 'HANA_TARGET_AMBIGUOUS',
    selectorAtomic: true,
    directCode: 'HANA_TARGET_INVALID',
    directAtomic: true,
  });
});

test('style auto shares one constructable sheet across two leases in open, closed, and iframe roots', async ({ page }) => {
  const result = await evaluateStyles(page, `(async () => {
    const fixture = window.__shadowFixture;
    const roots = [fixture.openRoot, fixture.closedRoot, fixture.frameRoot];
    const initialCounts = roots.map((root) => root.adoptedStyleSheets.length);
    const first = roots.map((root) => acquireShadowStyles(root));
    const secondOpen = acquireShadowStyles(fixture.openRoot, { mode: 'auto' });
    const markerFor = (root) => {
      const probe = root.ownerDocument.createElement('span');
      probe.className = 'hana-shadow-mirror';
      root.append(probe);
      try {
        return root.ownerDocument.defaultView
          .getComputedStyle(probe)
          .getPropertyValue('--hana-shadow-style')
          .trim();
      } finally {
        probe.remove();
      }
    };
    const installed = roots.map((root, index) => ({
      count: root.adoptedStyleSheets.length - initialCounts[index],
      marker: markerFor(root),
      probes: root.querySelectorAll('.hana-shadow-mirror').length,
      ownedNodes: root.querySelectorAll('style[data-hana-shadow-style]').length,
    }));
    let conflict;
    try {
      acquireShadowStyles(fixture.openRoot, {
        mode: 'auto',
        nonce: 'different',
      });
    } catch (error) {
      conflict = {
        typed: error instanceof HanamaruConfigError,
        code: error.code,
      };
    }
    first[0].release();
    const afterFirstOpenRelease = fixture.openRoot.adoptedStyleSheets.length
      - initialCounts[0];
    secondOpen.release();
    first[1].release();
    first[2].release();
    return {
      installed,
      conflict,
      afterFirstOpenRelease,
      finalCounts: roots.map((root, index) => (
        root.adoptedStyleSheets.length - initialCounts[index]
      )),
      states: roots.map((root) => runtimeState.shadows.has(root)),
    };
  })()`);

  expect(result).toEqual({
    installed: Array(3).fill({
      count: 1,
      marker: '1',
      probes: 0,
      ownedNodes: 0,
    }),
    conflict: {
      typed: true,
      code: 'HANA_CONFIG_SHADOW_STYLES',
    },
    afterFirstOpenRelease: 1,
    finalCounts: [0, 0, 0],
    states: [false, false, false],
  });
});

test('sheet mode verifies marker, shares exact identity, and retains author pre-adoption', async ({ page }) => {
  const result = await evaluateStyles(page, `(async () => {
    const root = window.__shadowFixture.openRoot;
    const css = await (await fetch('/src/hanamaru-shadow.css')).text();
    const addedSheet = new CSSStyleSheet();
    addedSheet.replaceSync(css);
    const addedFirst = acquireShadowStyles(root, {
      mode: 'sheet',
      sheet: addedSheet,
    });
    const addedSecond = acquireShadowStyles(root, {
      mode: 'sheet',
      sheet: addedSheet,
    });
    const duringAdded = {
      copies: root.adoptedStyleSheets.filter((sheet) => sheet === addedSheet).length,
      firstOwned: addedFirst.owned,
      secondOwned: addedSecond.owned,
      count: runtimeState.shadows.get(root).styles.count,
    };
    addedFirst.release();
    addedSecond.release();
    const removedAdded = !root.adoptedStyleSheets.includes(addedSheet);

    const authorSheet = new CSSStyleSheet();
    authorSheet.replaceSync(css);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, authorSheet];
    const authorLease = acquireShadowStyles(root, {
      mode: 'sheet',
      sheet: authorSheet,
    });
    const authorOwned = authorLease.owned;
    authorLease.release();
    const retainedAuthor = root.adoptedStyleSheets.includes(authorSheet);
    root.adoptedStyleSheets = root.adoptedStyleSheets
      .filter((sheet) => sheet !== authorSheet);

    return {
      duringAdded,
      removedAdded,
      authorOwned,
      retainedAuthor,
      state: runtimeState.shadows.has(root),
    };
  })()`);

  expect(result).toEqual({
    duringAdded: {
      copies: 1,
      firstOwned: true,
      secondOwned: true,
      count: 2,
    },
    removedAdded: true,
    authorOwned: false,
    retainedAuthor: true,
    state: false,
  });
});

test('sheet release removes at most one Hanamaru adoption when the author adds a duplicate', async ({ page }) => {
  const result = await evaluateStyles(page, `(async () => {
    const root = window.__shadowFixture.openRoot;
    const css = await (await fetch('/src/hanamaru-shadow.css')).text();
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    const initial = [...root.adoptedStyleSheets];
    const lease = acquireShadowStyles(root, { mode: 'sheet', sheet });
    const afterAcquire = root.adoptedStyleSheets
      .filter((candidate) => candidate === sheet).length;
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    const afterAuthorDuplicate = root.adoptedStyleSheets
      .filter((candidate) => candidate === sheet).length;
    lease.release();
    const afterRelease = root.adoptedStyleSheets
      .filter((candidate) => candidate === sheet).length;
    const retained = root.adoptedStyleSheets.includes(sheet);
    const state = runtimeState.shadows.has(root);
    root.adoptedStyleSheets = initial;
    return {
      afterAcquire,
      afterAuthorDuplicate,
      afterRelease,
      retained,
      state,
    };
  })()`);

  expect(result).toEqual({
    afterAcquire: 1,
    afterAuthorDuplicate: 2,
    afterRelease: 1,
    retained: true,
    state: false,
  });
});

test('empty and unrelated sheets fail marker verification and roll back only Hanamaru adoption', async ({ page }) => {
  const result = await evaluateStyles(page, `(() => {
    const root = window.__shadowFixture.openRoot;
    const empty = new CSSStyleSheet();
    const unrelated = new CSSStyleSheet();
    unrelated.replaceSync('.other { color: red }');
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, unrelated];

    let invalidResult;
    try {
      acquireShadowStyles(root, { mode: 'sheet', sheet: {} });
      invalidResult = { outcome: 'ok' };
    } catch (error) {
      invalidResult = {
        typed: error instanceof HanamaruConfigError,
        code: error.code,
      };
    }
    const attempt = (sheet) => {
      try {
        acquireShadowStyles(root, { mode: 'sheet', sheet });
        return { outcome: 'ok' };
      } catch (error) {
        return {
          typed: error instanceof HanamaruStateError,
          code: error.code,
          cause: error.details.cause instanceof TypeError,
        };
      }
    };
    const emptyResult = attempt(empty);
    const emptyRolledBack = !root.adoptedStyleSheets.includes(empty);
    const unrelatedResult = attempt(unrelated);
    const authorRetained = root.adoptedStyleSheets.includes(unrelated);
    root.adoptedStyleSheets = root.adoptedStyleSheets
      .filter((sheet) => sheet !== unrelated);
    return {
      invalidResult,
      emptyResult,
      emptyRolledBack,
      unrelatedResult,
      authorRetained,
      state: runtimeState.shadows.has(root),
      probes: root.querySelectorAll('.hana-shadow-mirror').length,
    };
  })()`);

  expect(result).toEqual({
    invalidResult: {
      typed: true,
      code: 'HANA_CONFIG_SHADOW_STYLES',
    },
    emptyResult: {
      typed: true,
      code: 'HANA_STATE_SHADOW_STYLES',
      cause: true,
    },
    emptyRolledBack: true,
    unrelatedResult: {
      typed: true,
      code: 'HANA_STATE_SHADOW_STYLES',
      cause: true,
    },
    authorRetained: true,
    state: false,
    probes: 0,
  });
});

test('sheet marker verification isolates each candidate from compatible root CSS', async ({ page }) => {
  const result = await evaluateStyles(page, `(async () => {
    const root = window.__shadowFixture.openRoot;
    const css = await (await fetch('/src/hanamaru-shadow.css')).text();
    const authorSheet = new CSSStyleSheet();
    authorSheet.replaceSync(css);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, authorSheet];
    const empty = new CSSStyleSheet();
    const unrelated = new CSSStyleSheet();
    unrelated.replaceSync('.unrelated { --hana-shadow-style: 1 }');
    const valid = new CSSStyleSheet();
    valid.replaceSync(css);
    const attempt = (sheet) => {
      try {
        const lease = acquireShadowStyles(root, { mode: 'sheet', sheet });
        lease.release();
        return 'ok';
      } catch (error) {
        return {
          typed: error instanceof HanamaruStateError,
          code: error.code,
        };
      }
    };
    const outcomes = {
      empty: attempt(empty),
      unrelated: attempt(unrelated),
      valid: attempt(valid),
    };
    const retainedOnlyAuthor = root.adoptedStyleSheets.length === 1
      && root.adoptedStyleSheets[0] === authorSheet;
    const cleanup = {
      temporaryHosts: document.querySelectorAll('[data-hana-shadow-probe-host]').length,
      probes: root.querySelectorAll('.hana-shadow-mirror').length,
      states: runtimeState.shadows.has(root),
    };
    root.adoptedStyleSheets = [];
    return { outcomes, retainedOnlyAuthor, cleanup };
  })()`);

  expect(result).toEqual({
    outcomes: {
      empty: {
        typed: true,
        code: 'HANA_STATE_SHADOW_STYLES',
      },
      unrelated: {
        typed: true,
        code: 'HANA_STATE_SHADOW_STYLES',
      },
      valid: 'ok',
    },
    retainedOnlyAuthor: true,
    cleanup: {
      temporaryHosts: 0,
      probes: 0,
      states: false,
    },
  });
});

test('preinstalled marker verification rejects inherited host marker but accepts root mirror CSS', async ({ page }) => {
  const result = await evaluateStyles(page, `(async () => {
    const root = window.__shadowFixture.openRoot;
    const host = root.host;
    host.style.setProperty('--hana-shadow-style', '1');
    let inherited;
    try {
      const lease = acquireShadowStyles(root, { mode: 'preinstalled' });
      lease.release();
      inherited = 'ok';
    } catch (error) {
      inherited = {
        typed: error instanceof HanamaruStateError,
        code: error.code,
      };
    }

    const css = await (await fetch('/src/hanamaru-shadow.css')).text();
    const authorSheet = new CSSStyleSheet();
    authorSheet.replaceSync(css);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, authorSheet];
    const validLease = acquireShadowStyles(root, { mode: 'preinstalled' });
    const valid = {
      owned: validLease.owned,
      marker: (() => {
        const probe = document.createElement('span');
        probe.className = 'hana-shadow-mirror';
        root.append(probe);
        const marker = getComputedStyle(probe)
          .getPropertyValue('--hana-shadow-style')
          .trim();
        probe.remove();
        return marker;
      })(),
    };
    validLease.release();
    const cleanup = {
      temporaryHosts: document.querySelectorAll('[data-hana-shadow-probe-host]').length,
      probes: root.querySelectorAll('.hana-shadow-mirror').length,
      state: runtimeState.shadows.has(root),
      authorRetained: root.adoptedStyleSheets.includes(authorSheet),
    };
    root.adoptedStyleSheets = [];
    host.style.removeProperty('--hana-shadow-style');
    return { inherited, valid, cleanup };
  })()`);

  expect(result).toEqual({
    inherited: {
      typed: true,
      code: 'HANA_STATE_SHADOW_STYLES',
    },
    valid: {
      owned: false,
      marker: '1',
    },
    cleanup: {
      temporaryHosts: 0,
      probes: 0,
      state: false,
      authorRetained: true,
    },
  });
});

test('sheet configuration rejects forged and wrong-realm identities before adoption', async ({ page }) => {
  const result = await evaluateStyles(page, `(() => {
    const fixture = window.__shadowFixture;
    const root = fixture.openRoot;
    let accessorCalls = 0;
    const forged = Object.create(CSSStyleSheet.prototype);
    Object.defineProperty(forged, 'cssRules', {
      configurable: true,
      get() {
        accessorCalls += 1;
        throw new Error('forged accessor invoked');
      },
    });
    const parentSheet = new CSSStyleSheet();
    const beforeMain = [...root.adoptedStyleSheets];
    const beforeFrame = [...fixture.frameRoot.adoptedStyleSheets];
    const attempt = (candidate, targetRoot) => {
      try {
        acquireShadowStyles(targetRoot, {
          mode: 'sheet',
          sheet: candidate,
        });
        return { outcome: 'ok' };
      } catch (error) {
        return {
          typed: error instanceof HanamaruConfigError,
          code: error.code,
          cause: error.details.cause instanceof TypeError,
        };
      }
    };
    return {
      forged: attempt(forged, root),
      wrongRealm: attempt(parentSheet, fixture.frameRoot),
      accessorCalls,
      mainUnchanged: root.adoptedStyleSheets.length === beforeMain.length
        && root.adoptedStyleSheets.every((sheet, index) => sheet === beforeMain[index]),
      frameUnchanged: fixture.frameRoot.adoptedStyleSheets.length === beforeFrame.length
        && fixture.frameRoot.adoptedStyleSheets
          .every((sheet, index) => sheet === beforeFrame[index]),
      states: [
        runtimeState.shadows.has(root),
        runtimeState.shadows.has(fixture.frameRoot),
      ],
    };
  })()`);

  expect(result).toEqual({
    forged: {
      typed: true,
      code: 'HANA_CONFIG_SHADOW_STYLES',
      cause: true,
    },
    wrongRealm: {
      typed: true,
      code: 'HANA_CONFIG_SHADOW_STYLES',
      cause: true,
    },
    accessorCalls: 0,
    mainUnchanged: true,
    frameUnchanged: true,
    states: [false, false],
  });
});

test('preinstalled mode creates no styles, verifies author CSS, and rejects a missing marker', async ({ page }) => {
  const result = await evaluateStyles(page, `(async () => {
    const root = window.__shadowFixture.openRoot;
    const missing = (() => {
      try {
        acquireShadowStyles(root, { mode: 'preinstalled' });
        return 'ok';
      } catch (error) {
        return [error.name, error.code];
      }
    })();
    const css = await (await fetch('/src/hanamaru-shadow.css')).text();
    const authorStyle = document.createElement('style');
    authorStyle.setAttribute('data-author-shadow-style', '');
    authorStyle.textContent = css;
    root.append(authorStyle);
    const before = {
      styles: root.querySelectorAll('style').length,
      sheets: root.adoptedStyleSheets.length,
    };
    const first = acquireShadowStyles(root, { mode: 'preinstalled' });
    const second = acquireShadowStyles(root, { mode: 'preinstalled' });
    const during = {
      styles: root.querySelectorAll('style').length,
      sheets: root.adoptedStyleSheets.length,
      owned: [first.owned, second.owned],
      probes: root.querySelectorAll('.hana-shadow-mirror').length,
    };
    first.release();
    second.release();
    const retained = authorStyle.isConnected;
    authorStyle.remove();
    return {
      missing,
      before,
      during,
      retained,
      state: runtimeState.shadows.has(root),
    };
  })()`);

  expect(result).toEqual({
    missing: ['HanamaruStateError', 'HANA_STATE_SHADOW_STYLES'],
    before: { styles: 1, sheets: 0 },
    during: {
      styles: 1,
      sheets: 0,
      owned: [false, false],
      probes: 0,
    },
    retained: true,
    state: false,
  });
});

test('style auto install failure rolls back without a sheet, node, probe, or root record', async ({ page }) => {
  const result = await evaluateStyles(page, `(() => {
    const root = window.__shadowFixture.openRoot;
    const before = root.adoptedStyleSheets.length;
    const descriptor = Object.getOwnPropertyDescriptor(
      CSSStyleSheet.prototype,
      'replaceSync',
    );
    Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', {
      ...descriptor,
      value() {
        throw new Error('forced replaceSync failure');
      },
    });
    let outcome;
    try {
      acquireShadowStyles(root);
      outcome = 'ok';
    } catch (error) {
      outcome = {
        typed: error instanceof HanamaruStateError,
        code: error.code,
        cause: error.details.cause.message,
      };
    } finally {
      Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', descriptor);
    }
    return {
      outcome,
      sheets: root.adoptedStyleSheets.length - before,
      nodes: root.querySelectorAll('style[data-hana-shadow-style]').length,
      probes: root.querySelectorAll('.hana-shadow-mirror').length,
      state: runtimeState.shadows.has(root),
    };
  })()`);

  expect(result).toEqual({
    outcome: {
      typed: true,
      code: 'HANA_STATE_SHADOW_STYLES',
      cause: 'forced replaceSync failure',
    },
    sheets: 0,
    nodes: 0,
    probes: 0,
    state: false,
  });
});

test('CSP preinstalled external shadow stylesheet needs no dynamic style node', async ({ page }) => {
  await page.goto('/tests/fixtures/plugins-csp.html');
  await page.evaluate(() => {
    window.__shadowUnhandledRejections = [];
    window.addEventListener('unhandledrejection', (event) => {
      window.__shadowUnhandledRejections.push(String(event.reason));
    });
  });
  const result = await page.evaluate(async () => {
    const { acquireShadowStyles } = await import('/src/shadow-styles.js');
    const { runtimeState } = await import('/src/runtime-state.js');
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/src/hanamaru-shadow.css';
    const loaded = new Promise((resolve, reject) => {
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', reject, { once: true });
    });
    root.append(link);
    await loaded;
    const before = {
      styleNodes: root.querySelectorAll('style').length,
      links: root.querySelectorAll('link[rel="stylesheet"]').length,
    };
    const lease = acquireShadowStyles(root, { mode: 'preinstalled' });
    const during = {
      styleNodes: root.querySelectorAll('style').length,
      links: root.querySelectorAll('link[rel="stylesheet"]').length,
      probes: root.querySelectorAll('.hana-shadow-mirror').length,
      owned: lease.owned,
    };
    lease.release();
    const after = {
      linkRetained: link.isConnected,
      styleNodes: root.querySelectorAll('style').length,
      state: runtimeState.shadows.has(root),
    };
    host.remove();
    return { before, during, after };
  });

  expect(result).toEqual({
    before: { styleNodes: 0, links: 1 },
    during: {
      styleNodes: 0,
      links: 1,
      probes: 0,
      owned: false,
    },
    after: {
      linkRetained: true,
      styleNodes: 0,
      state: false,
    },
  });
});
