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

test('@element rejects spoofed Element and Range objects without invoking their behavior', async ({ page }) => {
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
