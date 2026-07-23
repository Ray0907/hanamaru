import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/selection.html');
  await page.locator('#selection-frame').contentFrame();
});

test('annotates omitted and explicit Document selections without changing anchor, focus, or target markup', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotateSelection } = await import('/src/selection.js');
    const target = document.querySelector('#document-target');
    const text = target.firstChild;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 8);
    selection.removeAllRanges();
    selection.addRange(range);
    const before = [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset];
    const markup = target.innerHTML;
    const omitted = annotateSelection({ mark: 'underline', motion: 'never' });
    const afterOmitted = [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset];
    const explicit = annotateSelection({ mark: 'highlight', motion: 'never' }, selection);
    const afterExplicit = [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset];
    omitted.destroy();
    explicit.destroy();
    return {
      afterExplicit: afterExplicit.map((value, index) => (index % 2 === 0 ? value === before[index] : value)),
      afterOmitted: afterOmitted.map((value, index) => (index % 2 === 0 ? value === before[index] : value)),
      markupUnchanged: target.innerHTML === markup,
    };
  });

  expect(result).toEqual({
    afterExplicit: [true, 0, true, 8],
    afterOmitted: [true, 0, true, 8],
    markupUnchanged: true,
  });
});

test('rejects a proxy-shaped Selection before reading any spoofed selection property', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotateSelection } = await import('/src/selection.js');
    const reads = [];
    const spoof = new Proxy({
      anchorNode: document.querySelector('#document-target').firstChild,
      getRangeAt() { throw new Error('spoofed getRangeAt must not run'); },
      rangeCount: 1,
    }, {
      get(target, key, receiver) {
        reads.push(String(key));
        return Reflect.get(target, key, receiver);
      },
    });
    let code;
    try {
      annotateSelection({ mark: 'underline' }, spoof);
    } catch (error) {
      code = error.code;
    }
    return { code, reads };
  });

  expect(result).toEqual({ code: 'HANA_TARGET_SELECTION_UNAVAILABLE', reads: [] });
});

test('keeps the accepted range after the native Selection changes and accepts whitespace-only ranges', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotateSelection } = await import('/src/selection.js');
    const selection = window.getSelection();
    const target = document.querySelector('#document-target');
    const other = document.querySelector('#other-target');
    const first = document.createRange();
    first.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(first);
    const events = [];
    target.addEventListener('hana:start', () => events.push('document'));
    other.addEventListener('hana:start', () => events.push('other'));
    const controller = annotateSelection({ mark: 'underline', motion: 'never' });
    const second = document.createRange();
    second.selectNodeContents(other);
    selection.removeAllRanges();
    selection.addRange(second);
    controller.show();
    await controller.finished;

    const whitespace = document.querySelector('#whitespace-target').firstChild;
    const blank = document.createRange();
    blank.selectNodeContents(whitespace);
    selection.removeAllRanges();
    selection.addRange(blank);
    const whitespaceController = annotateSelection({ mark: 'underline', motion: 'never' });
    whitespaceController.show();
    await whitespaceController.finished;
    const output = {
      events,
      whitespaceState: whitespaceController.state,
    };
    controller.destroy();
    whitespaceController.destroy();
    return output;
  });

  expect(result).toEqual({ events: ['document'], whitespaceState: 'visible' });
});

test('uses system reduced-motion for a Selection annotation without interpolated animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const result = await page.evaluate(async () => {
    const { annotateSelection } = await import('/src/selection.js');
    const target = document.querySelector('#document-target');
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const events = [];
    target.addEventListener('hana:complete', () => events.push('complete'));
    const controller = annotateSelection({ mark: 'highlight', duration: 500 });
    controller.show();
    const immediate = {
      events: [...events],
      markPaths: document.querySelectorAll('.hana-mark-path').length,
      state: controller.state,
    };
    await Promise.resolve();
    const group = document.querySelector('.hana-annotation');
    const output = {
      animating: group.classList.contains('hana-is-animating'),
      immediate,
      markPaths: group.querySelectorAll('.hana-mark-path').length,
      microtask: { events: [...events], state: controller.state },
      state: controller.state,
    };
    controller.destroy();
    return output;
  });

  expect(result).toEqual({
    animating: false,
    immediate: { events: ['complete'], markPaths: 1, state: 'visible' },
    markPaths: 1,
    microtask: { events: ['complete'], state: 'visible' },
    state: 'visible',
  });
});

test('supports omitted and explicit iframe Document selections and reports a genuine empty iframe Selection', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotateSelection } = await import('/src/selection.js');
    const frame = document.querySelector('#selection-frame');
    const frameDocument = frame.contentDocument;
    const frameWindow = frame.contentWindow;
    const text = frameDocument.querySelector('#frame-target').firstChild;
    const range = frameDocument.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 6);
    const frameSelection = frameWindow.getSelection();
    frameSelection.removeAllRanges();
    frameSelection.addRange(range);
    const explicit = annotateSelection({ mark: 'underline', motion: 'never' }, frameSelection);
    explicit.show();
    await explicit.finished;
    explicit.destroy();
    frameSelection.removeAllRanges();
    let emptyCode;
    try {
      annotateSelection({ mark: 'underline' }, frameSelection);
    } catch (error) {
      emptyCode = error.code;
    }
    return { emptyCode, explicitState: explicit.state };
  });
  const omitted = await page.frames().find((frame) => frame.url().startsWith('about:srcdoc')).evaluate(async () => {
    const { annotateSelection } = await import('/src/selection.js');
    const text = document.querySelector('#frame-target').firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 6);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const controller = annotateSelection({ mark: 'highlight', motion: 'never' });
    controller.show();
    await controller.finished;
    const state = controller.state;
    controller.destroy();
    return state;
  });

  expect(result).toEqual({ emptyCode: 'HANA_TARGET_SELECTION_EMPTY', explicitState: 'destroyed' });
  expect(omitted).toBe('visible');
});

test('rejects disconnected, cross-root, and standalone Shadow selections without mutating them', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotateSelection, annotateSelectionWithEnvironment } = await import('/src/selection.js');
    const selection = window.getSelection();
    const target = document.querySelector('#document-target');
    const normalRange = document.createRange();
    normalRange.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(normalRange);
    const frame = document.querySelector('#selection-frame');
    const frameRange = frame.contentDocument.createRange();
    frameRange.selectNodeContents(frame.contentDocument.querySelector('#frame-target'));
    const outcomes = {};
    Object.defineProperty(selection, 'getRangeAt', {
      configurable: true,
      value() { return frameRange; },
    });
    try {
      annotateSelectionWithEnvironment({ mark: 'underline' }, selection, {
        createAnnotation() { throw new Error('must not delegate'); },
        root: document,
        view: window,
      });
    } catch (error) {
      outcomes.crossDocument = error.code;
    }
    delete selection.getRangeAt;
    const detached = document.createElement('p');
    detached.textContent = 'detached selection';
    const detachedRange = document.createRange();
    detachedRange.selectNodeContents(detached);
    Object.defineProperty(selection, 'getRangeAt', {
      configurable: true,
      value() { return detachedRange; },
    });
    try {
      annotateSelectionWithEnvironment({ mark: 'underline' }, selection, {
        createAnnotation() { throw new Error('must not delegate'); },
        root: document,
        view: window,
      });
    } catch (error) {
      outcomes.disconnected = error.code;
    }
    delete selection.getRangeAt;
    const host = document.querySelector('#shadow-host');
    const shadow = host.attachShadow({ mode: 'open' });
    const shadowText = shadow.appendChild(document.createTextNode('shadow selection'));
    const shadowRange = document.createRange();
    shadowRange.selectNodeContents(shadowText);
    selection.removeAllRanges();
    selection.addRange(shadowRange);
    try {
      annotateSelection({ mark: 'underline' });
    } catch (error) {
      outcomes.shadow = error.code;
    }
    return { outcomes, rangeCount: selection.rangeCount };
  });

  expect(result).toEqual({
    outcomes: {
      crossDocument: 'HANA_TARGET_INVALID',
      disconnected: 'HANA_TARGET_INVALID',
      shadow: 'HANA_TARGET_SHADOW_UNSCOPED',
    },
    rangeCount: 1,
  });
});

test('rejects multiple ranges when the browser exposes them and preserves normal controller lifecycle', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotateSelection } = await import('/src/selection.js');
    const selection = window.getSelection();
    const first = document.createRange();
    first.selectNodeContents(document.querySelector('#document-target'));
    const second = document.createRange();
    second.selectNodeContents(document.querySelector('#other-target'));
    selection.removeAllRanges();
    selection.addRange(first);
    selection.addRange(second);
    let multipleCode = null;
    if (selection.rangeCount > 1) {
      try { annotateSelection({ mark: 'underline' }); } catch (error) { multipleCode = error.code; }
    }
    selection.removeAllRanges();
    selection.addRange(first);
    const target = document.querySelector('#document-target');
    const markup = target.innerHTML;
    const controller = annotateSelection({ mark: 'box', motion: 'never' });
    controller.show();
    await controller.finished;
    const visible = controller.state;
    controller.hide();
    const hidden = controller.state;
    controller.replay();
    await controller.finished;
    const replayed = controller.state;
    controller.destroy();
    return {
      hidden,
      markupUnchanged: target.innerHTML === markup,
      multipleCode,
      replayed,
      visible,
    };
  });

  expect(result).toEqual({
    hidden: 'hidden',
    markupUnchanged: true,
    multipleCode: null,
    replayed: 'visible',
    visible: 'visible',
  });
});
