import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/renderer.html');
});

test('renderer structure owns namespaced nodes and consumes fixed layout bytes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { createRenderer } = await import('/src/renderer.js');
    const lease = acquireDocumentResources(document);
    lease.shared.registerController('proof-1');
    const owner = document.querySelector('#target');
    const record = { kind: 'element', element: owner, ownerElement: owner };
    const renderer = createRenderer({
      id: 'proof-1',
      record,
      options: {
        mark: 'underline', note: 'Check this claim.', accessible: true,
      },
      lease,
    });
    renderer.draw({
      targetRects: [{ x: 10, y: 10, width: 40, height: 12 }],
      unionRect: { x: 10, y: 10, width: 40, height: 12 },
      markPaths: ['M 10 22 Q 30 23 50 22', 'M 10 24 Q 30 25 50 24'],
      side: 'right',
      noteRect: { x: 100, y: 32, width: 160, height: 48 },
      connector: { shaft: 'M 50 16 L 92 42', head: 'M 91 36 L 100 42 L 92 49' },
      viewport: { width: innerWidth, height: innerHeight },
    });

    let targetReads = 0;
    owner.getBoundingClientRect = () => { targetReads += 1; throw new Error('renderer measured target'); };
    const measurement = renderer.measure();
    const output = {
      api: ['group', 'noteElement', 'measure', 'draw', 'animate', 'updateOwner', 'pause', 'resume', 'finish', 'hide', 'destroy']
        .every((key) => key in renderer),
      annotationGroups: document.querySelectorAll('.hana-annotation[data-hana-id="proof-1"]').length,
      paths: [...renderer.group.querySelectorAll('.hana-path')].map((path) => [path.className.baseVal, path.getAttribute('d')]),
      svgHidden: lease.shared.svgLayer.getAttribute('aria-hidden'),
      groupAria: renderer.group.getAttribute('aria-hidden'),
      note: renderer.noteElement.textContent,
      noteId: renderer.noteElement.id,
      notePosition: [renderer.noteElement.style.left, renderer.noteElement.style.top],
      ownerDescription: owner.getAttribute('aria-describedby'),
      targetReads,
      measurementKeys: Object.keys(measurement),
      peerCount: measurement.peerNoteRects.length,
    };
    renderer.destroy();
    lease.shared.releaseController('proof-1');
    lease.release();
    return output;
  });

  expect(result).toEqual({
    api: true,
    annotationGroups: 1,
    paths: [
      ['hana-path hana-mark-path', 'M 10 22 Q 30 23 50 22'],
      ['hana-path hana-mark-path', 'M 10 24 Q 30 25 50 24'],
      ['hana-path hana-connector-path hana-connector-shaft', 'M 50 16 L 92 42'],
      ['hana-path hana-connector-path hana-connector-head', 'M 91 36 L 100 42 L 92 49'],
    ],
    svgHidden: 'true',
    groupAria: null,
    note: 'Check this claim.',
    noteId: 'hana-note-proof-1',
    notePosition: ['100px', '32px'],
    ownerDescription: 'author-token hana-note-proof-1',
    targetReads: 0,
    measurementKeys: ['noteRect', 'peerNoteRects', 'viewport'],
    peerCount: 0,
  });
});

test('renderer structure keeps an undrawn note measurable without revealing it', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { createRenderer } = await import('/src/renderer.js');
    const lease = acquireDocumentResources(document);
    lease.shared.registerController('measurable');
    const owner = document.querySelector('#target');
    const renderer = createRenderer({
      id: 'measurable', record: { kind: 'element', element: owner, ownerElement: owner },
      options: { mark: 'circle', note: 'A measurable note', accessible: true }, lease,
    });
    const beforeClass = renderer.noteElement.className;
    const measurement = renderer.measure();
    const output = {
      measurable: measurement.noteRect.width > 0 && measurement.noteRect.height > 0,
      hiddenAttribute: renderer.noteElement.hidden,
      ownerDescription: owner.getAttribute('aria-describedby'),
      visibility: getComputedStyle(renderer.noteElement).visibility,
      readOnly: renderer.noteElement.className === beforeClass,
    };
    renderer.destroy();
    lease.shared.releaseController('measurable');
    lease.release();
    return output;
  });

  expect(result).toEqual({
    measurable: true, hiddenAttribute: false, ownerDescription: 'author-token',
    visibility: 'hidden', readOnly: true,
  });
});

test('renderer structure fails before owned DOM or ARIA mutation for an unregistered id', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { createRenderer } = await import('/src/renderer.js');
    const lease = acquireDocumentResources(document);
    const owner = document.querySelector('#target');
    const before = {
      descriptions: owner.getAttribute('aria-describedby'),
      groups: lease.shared.svgLayer.childElementCount,
      notes: lease.shared.noteLayer.childElementCount,
    };
    let error;
    try {
      createRenderer({
        id: 'not-registered', record: { kind: 'element', element: owner, ownerElement: owner },
        options: { mark: 'circle', note: 'Must not mount', accessible: true }, lease,
      });
    } catch (caught) {
      error = caught.message;
    }
    const after = {
      descriptions: owner.getAttribute('aria-describedby'),
      groups: lease.shared.svgLayer.childElementCount,
      notes: lease.shared.noteLayer.childElementCount,
    };
    lease.release();
    return { before, after, error };
  });

  expect(result).toEqual({
    before: { descriptions: 'author-token', groups: 0, notes: 0 },
    after: { descriptions: 'author-token', groups: 0, notes: 0 },
    error: 'controller is not registered: not-registered',
  });
});

test('renderer structure uses a real SVG hidden state and draw restores visibility', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { createRenderer } = await import('/src/renderer.js');
    const lease = acquireDocumentResources(document);
    lease.shared.registerController('svg-hidden');
    const owner = document.querySelector('#target');
    const renderer = createRenderer({
      id: 'svg-hidden', record: { kind: 'element', element: owner, ownerElement: owner },
      options: { mark: 'underline', note: null, accessible: false }, lease,
    });
    const layout = {
      targetRects: [], unionRect: null, markPaths: ['M 10 10 L 40 10'], side: 'right',
      noteRect: null, connector: { shaft: '', head: '' },
      viewport: { width: innerWidth, height: innerHeight },
    };
    const initial = [renderer.group.hasAttribute('hidden'), getComputedStyle(renderer.group).display];
    renderer.draw(layout);
    const drawn = [renderer.group.hasAttribute('hidden'), getComputedStyle(renderer.group).display];
    renderer.hide();
    const hidden = [renderer.group.hasAttribute('hidden'), getComputedStyle(renderer.group).display];
    renderer.draw(layout);
    const redrawn = [renderer.group.hasAttribute('hidden'), getComputedStyle(renderer.group).display];
    renderer.destroy();
    lease.shared.releaseController('svg-hidden');
    lease.release();
    return { initial, drawn, hidden, redrawn };
  });

  expect(result).toEqual({
    initial: [true, 'none'], drawn: [false, 'inline'],
    hidden: [true, 'none'], redrawn: [false, 'inline'],
  });
});

test('renderer structure transfers and tears down accessible owner tokens safely', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { createRenderer } = await import('/src/renderer.js');
    const lease = acquireDocumentResources(document);
    lease.shared.registerController('proof-transfer');
    const first = document.querySelector('#target');
    const second = document.querySelector('#next-owner');
    const renderer = createRenderer({
      id: 'proof-transfer',
      record: { kind: 'element', element: first, ownerElement: first },
      options: { mark: 'circle', note: 'Meaningful note', accessible: true },
      lease,
    });
    const idle = [first.getAttribute('aria-describedby'), second.getAttribute('aria-describedby')];
    renderer.updateOwner(second);
    const hiddenTransfer = [first.getAttribute('aria-describedby'), second.getAttribute('aria-describedby')];
    const layout = {
      targetRects: [], unionRect: null, markPaths: [], side: 'right',
      noteRect: { x: 10, y: 10, width: 100, height: 30 },
      connector: { shaft: '', head: '' }, viewport: { width: innerWidth, height: innerHeight },
    };
    renderer.draw(layout);
    const visible = [first.getAttribute('aria-describedby'), second.getAttribute('aria-describedby')];
    first.setAttribute('aria-describedby', `${first.getAttribute('aria-describedby')} author-after`);
    renderer.updateOwner(first);
    const transferred = [first.getAttribute('aria-describedby'), second.getAttribute('aria-describedby')];
    renderer.hide();
    const hidden = [first.getAttribute('aria-describedby'), second.getAttribute('aria-describedby')];
    renderer.updateOwner(second);
    renderer.draw(layout);
    const reshown = [first.getAttribute('aria-describedby'), second.getAttribute('aria-describedby')];
    second.setAttribute('aria-describedby', `${second.getAttribute('aria-describedby')} concurrent-note`);
    renderer.destroy();
    renderer.destroy();
    const result = {
      idle, hiddenTransfer, visible, transferred, hidden, reshown,
      afterDestroy: [first.getAttribute('aria-describedby'), second.getAttribute('aria-describedby')],
      ownedNodes: document.querySelectorAll('[data-hana-id="proof-transfer"]').length,
    };
    lease.shared.releaseController('proof-transfer');
    lease.release();
    return result;
  });

  expect(result).toEqual({
    idle: ['author-token', 'next-author'],
    hiddenTransfer: ['author-token', 'next-author'],
    visible: ['author-token', 'next-author hana-note-proof-transfer'],
    transferred: ['author-token author-after hana-note-proof-transfer', 'next-author'],
    hidden: ['author-token author-after', 'next-author'],
    reshown: ['author-token author-after', 'next-author hana-note-proof-transfer'],
    afterDestroy: ['author-token author-after', 'next-author concurrent-note'],
    ownedNodes: 0,
  });
});

test('renderer structure preserves the generated path counts for all six marks', async ({ page }) => {
  const counts = await page.evaluate(async () => {
    const { buildMarkPaths, rect } = await import('/src/geometry.js');
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { createRenderer } = await import('/src/renderer.js');
    const lease = acquireDocumentResources(document);
    const owner = document.querySelector('#target');
    const targetRects = [rect(20, 20, 30, 10), rect(20, 35, 45, 10)];
    const result = {};
    for (const mark of ['underline', 'highlight', 'strike', 'circle', 'box', 'bracket']) {
      lease.shared.registerController(`mark-${mark}`);
      const renderer = createRenderer({
        id: `mark-${mark}`, record: { kind: 'element', element: owner, ownerElement: owner },
        options: { mark, note: null, accessible: false }, lease,
      });
      const markPaths = buildMarkPaths(mark, targetRects, 'renderer-counts');
      renderer.draw({
        targetRects, unionRect: rect(20, 20, 45, 25), markPaths, side: 'right', noteRect: null,
        connector: { shaft: '', head: '' }, viewport: { width: innerWidth, height: innerHeight },
      });
      result[mark] = renderer.group.querySelectorAll('.hana-mark-path').length;
      renderer.destroy();
      lease.shared.releaseController(`mark-${mark}`);
    }
    lease.release();
    return result;
  });

  expect(counts).toEqual({
    underline: 2, highlight: 2, strike: 4, circle: 2, box: 2, bracket: 2,
  });
});

test('renderer structure keeps decorative notes hidden and schedules overflow focusability', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { createRenderer } = await import('/src/renderer.js');
    const lease = acquireDocumentResources(document);
    lease.shared.registerController('decorative');
    lease.shared.registerController('overflow');
    const owner = document.querySelector('#target');
    const layout = {
      targetRects: [], unionRect: null, markPaths: [], side: 'top',
      noteRect: { x: 12, y: 12, width: 100, height: 30 },
      connector: { shaft: '', head: '' },
      viewport: { width: innerWidth, height: innerHeight },
    };
    const decorative = createRenderer({
      id: 'decorative', record: { kind: 'element', element: owner, ownerElement: owner },
      options: { mark: 'box', note: 'Decoration', accessible: false }, lease,
    });
    const accessible = createRenderer({
      id: 'overflow', record: { kind: 'element', element: owner, ownerElement: owner },
      options: { mark: 'box', note: 'Scrollable explanation', accessible: true }, lease,
    });
    Object.defineProperties(accessible.noteElement, {
      scrollHeight: { configurable: true, get: () => 80 },
      clientHeight: { configurable: true, get: () => 30 },
    });
    decorative.draw(layout);
    accessible.draw(layout);
    const immediate = accessible.noteElement.getAttribute('tabindex');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const delayed = accessible.noteElement.getAttribute('tabindex');
    const result = {
      decorativeAria: decorative.noteElement.getAttribute('aria-hidden'),
      decorativeOwner: owner.getAttribute('aria-describedby').includes('hana-note-decorative'),
      decorativeTabindex: decorative.noteElement.getAttribute('tabindex'),
      immediate,
      delayed,
    };
    decorative.destroy();
    accessible.destroy();
    lease.shared.releaseController('decorative');
    lease.shared.releaseController('overflow');
    lease.release();
    return result;
  });

  expect(result).toEqual({
    decorativeAria: 'true', decorativeOwner: false, decorativeTabindex: null,
    immediate: null, delayed: '0',
  });
});

test('renderer structure suppresses stale overflow writes after generation, ABA, and destroy', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { createRenderer } = await import('/src/renderer.js');
    const lease = acquireDocumentResources(document);
    const { shared } = lease;
    shared.registerController('overflow-stale');
    const owner = document.querySelector('#target');
    const renderer = createRenderer({
      id: 'overflow-stale', record: { kind: 'element', element: owner, ownerElement: owner },
      options: { mark: 'box', note: 'Overflowing note', accessible: true }, lease,
    });
    const note = renderer.noteElement;
    Object.defineProperties(note, {
      scrollHeight: { configurable: true, get: () => 80 },
      clientHeight: { configurable: true, get: () => 30 },
    });
    const layout = {
      targetRects: [], unionRect: null, markPaths: [], side: 'right',
      noteRect: { x: 20, y: 20, width: 100, height: 30 },
      connector: { shaft: '', head: '' }, viewport: { width: innerWidth, height: innerHeight },
    };
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    renderer.draw(layout);
    const immediate = note.getAttribute('tabindex');
    shared.bumpGeneration('overflow-stale');
    await frames();
    const afterGeneration = note.getAttribute('tabindex');

    note.removeAttribute('tabindex');
    renderer.draw(layout);
    shared.releaseController('overflow-stale');
    shared.registerController('overflow-stale');
    await frames();
    const afterAba = note.getAttribute('tabindex');

    note.removeAttribute('tabindex');
    renderer.draw(layout);
    shared.registerController('overflow-destroyer');
    shared.enqueue({
      id: 'overflow-destroyer', generation: 0,
      read() { renderer.destroy(); },
      write() {},
    });
    await frames();
    const afterDestroy = note.getAttribute('tabindex');
    shared.releaseController('overflow-stale');
    shared.releaseController('overflow-destroyer');
    lease.release();
    return { immediate, afterGeneration, afterAba, afterDestroy };
  });

  expect(result).toEqual({
    immediate: null, afterGeneration: null, afterAba: null, afterDestroy: null,
  });
});

test('motion allocates WAAPI phases and controls every active handle', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { createRenderer } = await import('/src/renderer.js');
    const lease = acquireDocumentResources(document);
    lease.shared.registerController('motion-waapi');
    const owner = document.querySelector('#target');
    const calls = [];
    const originalAnimate = Element.prototype.animate;
    Element.prototype.animate = function animate(keyframes, timing) {
      const call = {
        className: this.getAttribute('class'), keyframes, timing,
        paused: 0, played: 0, finishedCalls: 0, cancelled: 0,
      };
      calls.push(call);
      return {
        finished: Promise.resolve(),
        pause() { call.paused += 1; },
        play() { call.played += 1; },
        finish() { call.finishedCalls += 1; },
        cancel() { call.cancelled += 1; },
      };
    };
    const renderer = createRenderer({
      id: 'motion-waapi', record: { kind: 'element', element: owner, ownerElement: owner },
      options: { mark: 'underline', note: 'Animated note', accessible: true }, lease,
    });
    renderer.draw({
      targetRects: [], unionRect: null,
      markPaths: ['M 10 10 L 50 10', 'M 10 12 L 50 12'], side: 'right',
      noteRect: { x: 100, y: 20, width: 120, height: 40 },
      connector: { shaft: 'M 50 10 L 92 30', head: 'M 90 25 L 100 30 L 92 36' },
      viewport: { width: innerWidth, height: innerHeight },
    });
    const run = renderer.animate(1000);
    renderer.pause();
    renderer.resume();
    renderer.finish();
    await run.finished;
    const output = {
      animations: run.animations.length,
      calls: calls.map(({ className, timing, paused, played, finishedCalls }) => ({
        className, timing, paused, played, finishedCalls,
      })),
      final: {
        pathOffsets: [...renderer.group.querySelectorAll('.hana-path')].map((path) => path.style.strokeDashoffset),
        noteOpacity: renderer.noteElement.style.opacity,
      },
    };
    const retained = [renderer.group.isConnected, renderer.noteElement.isConnected];
    renderer.hide();
    output.hidden = [renderer.group.hasAttribute('hidden'), renderer.noteElement.classList.contains('hana-is-hidden')];
    output.cancelled = calls.map((call) => call.cancelled);
    output.retained = retained;
    renderer.destroy();
    lease.shared.releaseController('motion-waapi');
    lease.release();
    Element.prototype.animate = originalAnimate;
    return output;
  });

  expect(result).toEqual({
    animations: 5,
    calls: [
      { className: 'hana-path hana-mark-path', timing: { duration: 550, delay: 0, fill: 'both', easing: 'ease-out' }, paused: 1, played: 1, finishedCalls: 1 },
      { className: 'hana-path hana-mark-path', timing: { duration: 550, delay: 0, fill: 'both', easing: 'ease-out' }, paused: 1, played: 1, finishedCalls: 1 },
      { className: 'hana-path hana-connector-path hana-connector-shaft', timing: { duration: 250, delay: 550, fill: 'both', easing: 'ease-out' }, paused: 1, played: 1, finishedCalls: 1 },
      { className: 'hana-path hana-connector-path hana-connector-head', timing: { duration: 250, delay: 550, fill: 'both', easing: 'ease-out' }, paused: 1, played: 1, finishedCalls: 1 },
      { className: 'hana-note hana-is-visible', timing: { duration: 200, delay: 800, fill: 'both', easing: 'ease-out' }, paused: 1, played: 1, finishedCalls: 1 },
    ],
    final: { pathOffsets: ['0', '0', '0', '0'], noteOpacity: '1' },
    hidden: [true, true], cancelled: [0, 0, 0, 0, 0], retained: [true, true],
  });
});

test('motion keeps mark-only WAAPI and fallback finished on the full-duration clock', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { createRenderer } = await import('/src/renderer.js');
    const lease = acquireDocumentResources(document);
    const owner = document.querySelector('#target');
    const originalAnimate = Element.prototype.animate;
    const layout = {
      targetRects: [], unionRect: null, markPaths: ['M 0 0 L 30 0'], side: 'right',
      noteRect: null, connector: { shaft: '', head: '' },
      viewport: { width: innerWidth, height: innerHeight },
    };
    const runMode = async (id, fallback) => {
      lease.shared.registerController(id);
      Element.prototype.animate = fallback ? undefined : originalAnimate;
      const renderer = createRenderer({
        id, record: { kind: 'element', element: owner, ownerElement: owner },
        options: { mark: 'underline', note: null, accessible: false }, lease,
      });
      renderer.draw(layout);
      const startedAt = performance.now();
      await renderer.animate(100).finished;
      const elapsed = performance.now() - startedAt;
      renderer.destroy();
      lease.shared.releaseController(id);
      return elapsed;
    };
    const waapi = await runMode('clock-waapi', false);
    const fallback = await runMode('clock-fallback', true);
    Element.prototype.animate = originalAnimate;
    lease.release();
    return { waapi, fallback };
  });

  expect(result.waapi).toBeGreaterThanOrEqual(85);
  expect(result.fallback).toBeGreaterThanOrEqual(85);
  expect(Math.abs(result.waapi - result.fallback)).toBeLessThan(50);
});

test('motion rejects intentional hide and replay consistently without native rejection leaks', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { createRenderer } = await import('/src/renderer.js');
    const lease = acquireDocumentResources(document);
    const owner = document.querySelector('#target');
    const originalAnimate = Element.prototype.animate;
    let unhandled = 0;
    addEventListener('unhandledrejection', (event) => { unhandled += 1; event.preventDefault(); });
    const layout = {
      targetRects: [], unionRect: null, markPaths: ['M 0 0 L 30 0'], side: 'right',
      noteRect: null, connector: { shaft: '', head: '' },
      viewport: { width: innerWidth, height: innerHeight },
    };
    const runMode = async (id, fallback) => {
      lease.shared.registerController(id);
      Element.prototype.animate = fallback ? undefined : originalAnimate;
      const renderer = createRenderer({
        id, record: { kind: 'element', element: owner, ownerElement: owner },
        options: { mark: 'underline', note: null, accessible: false }, lease,
      });
      renderer.draw(layout);
      const hiddenRun = renderer.animate(1000);
      const hiddenOutcome = hiddenRun.finished.then(() => 'resolved', (error) => error.name);
      renderer.hide();
      renderer.draw(layout);
      const replayedRun = renderer.animate(1000);
      const replayedOutcome = replayedRun.finished.then(() => 'resolved', (error) => error.name);
      const replacement = renderer.animate(0);
      const outcomes = [await hiddenOutcome, await replayedOutcome, await replacement.finished.then(() => 'resolved')];
      renderer.destroy();
      lease.shared.releaseController(id);
      return outcomes;
    };
    const waapi = await runMode('cancel-waapi', false);
    const fallback = await runMode('cancel-fallback', true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    Element.prototype.animate = originalAnimate;
    lease.release();
    return { waapi, fallback, unhandled };
  });

  expect(result).toEqual({
    waapi: ['AbortError', 'AbortError', 'resolved'],
    fallback: ['AbortError', 'AbortError', 'resolved'],
    unhandled: 0,
  });
});

test('motion reveals highlight fill in WAAPI and fallback paths', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { createRenderer } = await import('/src/renderer.js');
    const lease = acquireDocumentResources(document);
    const owner = document.querySelector('#target');
    const originalAnimate = Element.prototype.animate;
    const layout = {
      targetRects: [], unionRect: null, markPaths: ['M 0 0 L 80 0 L 80 20 L 0 20 Z'], side: 'right',
      noteRect: null, connector: { shaft: '', head: '' },
      viewport: { width: innerWidth, height: innerHeight },
    };

    lease.shared.registerController('highlight-waapi');
    const waapiRenderer = createRenderer({
      id: 'highlight-waapi', record: { kind: 'element', element: owner, ownerElement: owner },
      options: { mark: 'highlight', note: null, accessible: false }, lease,
    });
    waapiRenderer.draw(layout);
    const waapiRun = waapiRenderer.animate(200);
    const animation = waapiRun.animations[0];
    waapiRenderer.pause();
    animation.currentTime = 0;
    const start = getComputedStyle(waapiRenderer.group.firstElementChild).clipPath;
    animation.currentTime = 55;
    const middle = getComputedStyle(waapiRenderer.group.firstElementChild).clipPath;
    animation.currentTime = 110;
    const end = getComputedStyle(waapiRenderer.group.firstElementChild).clipPath;
    const keyframeValues = animation.effect.getKeyframes().map((frame) => frame.clipPath ?? null);
    waapiRenderer.finish();
    await waapiRun.finished;
    const waapiFinal = waapiRenderer.group.firstElementChild.style.clipPath;
    waapiRenderer.destroy();
    lease.shared.releaseController('highlight-waapi');

    Element.prototype.animate = undefined;
    lease.shared.registerController('highlight-fallback');
    const fallbackRenderer = createRenderer({
      id: 'highlight-fallback', record: { kind: 'element', element: owner, ownerElement: owner },
      options: { mark: 'highlight', note: null, accessible: false }, lease,
    });
    fallbackRenderer.draw(layout);
    const fallbackRun = fallbackRenderer.animate(200);
    const fallbackName = getComputedStyle(fallbackRenderer.group.firstElementChild).animationName;
    fallbackRenderer.finish();
    await fallbackRun.finished;
    const fallbackFinal = fallbackRenderer.group.firstElementChild.style.clipPath;
    fallbackRenderer.destroy();
    lease.shared.releaseController('highlight-fallback');
    Element.prototype.animate = originalAnimate;
    lease.release();
    return {
      waapiUsesClip: keyframeValues.every((value) => typeof value === 'string')
        && keyframeValues[0].includes('100%') && keyframeValues.at(-1).includes('0%'),
      waapiProgresses: start !== middle && middle !== end,
      waapiFinal,
      fallbackName,
      fallbackFinal,
    };
  });

  expect(result).toEqual({
    waapiUsesClip: true,
    waapiProgresses: true,
    waapiFinal: 'inset(0px 0% 0px 0px)',
    fallbackName: 'hana-highlight-reveal',
    fallbackFinal: 'inset(0px 0% 0px 0px)',
  });
});

test('motion reads author duration and note-gap theme metrics without changing renderer shapes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { createRenderer, readThemeMetrics } = await import('/src/renderer.js');
    const lease = acquireDocumentResources(document);
    lease.shared.overlay.style.setProperty('--hana-duration', '90ms');
    lease.shared.overlay.style.setProperty('--hana-note-gap', '24px');
    lease.shared.registerController('theme-motion');
    const owner = document.querySelector('#target');
    const renderer = createRenderer({
      id: 'theme-motion', record: { kind: 'element', element: owner, ownerElement: owner },
      options: { mark: 'underline', note: null, accessible: false }, lease,
    });
    renderer.draw({
      targetRects: [], unionRect: null, markPaths: ['M 0 0 L 20 0'], side: 'right',
      noteRect: null, connector: { shaft: '', head: '' },
      viewport: { width: innerWidth, height: innerHeight },
    });
    const metrics = readThemeMetrics(renderer.group);
    const startedAt = performance.now();
    await renderer.animate().finished;
    const elapsed = performance.now() - startedAt;
    const measureKeys = Object.keys(renderer.measure());
    const rendererKeys = Object.keys(renderer);
    renderer.destroy();
    lease.shared.releaseController('theme-motion');
    lease.release();
    return { metrics, elapsed, measureKeys, rendererKeys };
  });

  expect(result.metrics).toEqual({ duration: 90, noteGap: 24 });
  expect(result.elapsed).toBeGreaterThanOrEqual(75);
  expect(result.measureKeys).toEqual(['noteRect', 'peerNoteRects', 'viewport']);
  expect(result.rendererKeys).toEqual([
    'group', 'noteElement', 'measure', 'draw', 'animate',
    'updateOwner', 'pause', 'resume', 'finish', 'hide', 'destroy',
  ]);
});

test('motion observes theme duration changes between runs without freezing the canonical variable', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { createRenderer, readThemeMetrics } = await import('/src/renderer.js');
    const lease = acquireDocumentResources(document);
    lease.shared.registerController('theme-switch');
    const owner = document.querySelector('#target');
    const renderer = createRenderer({
      id: 'theme-switch', record: { kind: 'element', element: owner, ownerElement: owner },
      options: { mark: 'underline', note: null, accessible: false }, lease,
    });
    renderer.draw({
      targetRects: [], unionRect: null, markPaths: ['M 0 0 L 20 0'], side: 'right',
      noteRect: null, connector: { shaft: '', head: '' },
      viewport: { width: innerWidth, height: innerHeight },
    });

    lease.shared.overlay.style.setProperty('--hana-duration', '30ms');
    let startedAt = performance.now();
    await renderer.animate().finished;
    const firstElapsed = performance.now() - startedAt;

    lease.shared.overlay.style.setProperty('--hana-duration', '120ms');
    const secondMetrics = readThemeMetrics(renderer.group);
    startedAt = performance.now();
    await renderer.animate().finished;
    const secondElapsed = performance.now() - startedAt;

    await renderer.animate(10).finished;
    const inlineCanonical = renderer.group.style.getPropertyValue('--hana-duration');
    const inheritedCanonical = getComputedStyle(renderer.group).getPropertyValue('--hana-duration').trim();
    renderer.destroy();
    lease.shared.releaseController('theme-switch');
    lease.release();
    return { firstElapsed, secondElapsed, secondMetrics, inlineCanonical, inheritedCanonical };
  });

  expect(result.firstElapsed).toBeGreaterThanOrEqual(20);
  expect(result.secondElapsed).toBeGreaterThanOrEqual(100);
  expect(result.secondMetrics.duration).toBe(120);
  expect(result.inlineCanonical).toBe('');
  expect(result.inheritedCanonical).toBe('120ms');
});

test('motion fallback preserves elapsed time across pause and supports finish and zero duration', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { createRenderer } = await import('/src/renderer.js');
    const lease = acquireDocumentResources(document);
    lease.shared.registerController('motion-fallback');
    const owner = document.querySelector('#target');
    const originalAnimate = Element.prototype.animate;
    Element.prototype.animate = undefined;
    const renderer = createRenderer({
      id: 'motion-fallback', record: { kind: 'element', element: owner, ownerElement: owner },
      options: { mark: 'box', note: 'Fallback note', accessible: true }, lease,
    });
    renderer.draw({
      targetRects: [], unionRect: null, markPaths: ['M 0 0 L 10 10'], side: 'bottom',
      noteRect: { x: 40, y: 40, width: 100, height: 40 },
      connector: { shaft: 'M 10 10 L 30 30', head: '' },
      viewport: { width: innerWidth, height: innerHeight },
    });
    const run = renderer.animate(120);
    let resolved = false;
    run.finished.then(() => { resolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    renderer.pause();
    const pausedClass = renderer.group.classList.contains('hana-is-paused');
    await new Promise((resolve) => setTimeout(resolve, 140));
    const stayedPending = !resolved;
    renderer.resume();
    await run.finished;
    const completed = resolved;
    const variables = {
      canonicalInline: renderer.group.style.getPropertyValue('--hana-duration'),
      markDuration: renderer.group.style.getPropertyValue('--hana-mark-duration'),
      connectorDuration: renderer.group.style.getPropertyValue('--hana-connector-duration'),
      connectorDelay: renderer.group.style.getPropertyValue('--hana-connector-delay'),
      noteDuration: renderer.noteElement.style.getPropertyValue('--hana-note-duration'),
      noteDelay: renderer.noteElement.style.getPropertyValue('--hana-note-delay'),
    };
    const finishedRun = renderer.animate(1000);
    renderer.finish();
    await finishedRun.finished;
    const zero = renderer.animate(0);
    let zeroResolved = false;
    zero.finished.then(() => { zeroResolved = true; });
    await Promise.resolve();
    const output = {
      animations: run.animations.length,
      pausedClass,
      stayedPending,
      completed,
      variables,
      finishFinal: [renderer.group.classList.contains('hana-is-animating'), renderer.noteElement.style.opacity],
      zeroResolved,
    };
    renderer.destroy();
    lease.shared.releaseController('motion-fallback');
    lease.release();
    Element.prototype.animate = originalAnimate;
    return output;
  });

  expect(result).toEqual({
    animations: 0,
    pausedClass: true,
    stayedPending: true,
    completed: true,
    variables: {
      canonicalInline: '', markDuration: '66ms', connectorDuration: '30ms',
      connectorDelay: '66ms', noteDuration: '24ms', noteDelay: '96ms',
    },
    finishFinal: [false, '1'],
    zeroResolved: true,
  });
});
