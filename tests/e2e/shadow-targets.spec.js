import { expect, test } from '@playwright/test';

const browserErrors = new WeakMap();

async function evaluateShadow(page, expression) {
  return page.evaluate(async (source) => {
    const {
      assertShadowRoot,
      resolveShadowTarget,
    } = await import('/src/shadow-target.js');
    return Function(
      'assertShadowRoot',
      'resolveShadowTarget',
      `return (${source});`,
    )(assertShadowRoot, resolveShadowTarget);
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
