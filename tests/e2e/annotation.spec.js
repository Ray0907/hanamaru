import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/annotation.html');
});

test('annotation lifecycle renders, dispatches exact events, transfers ARIA, and cleans resources', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const owner = document.querySelector('#direct-target');
    const events = [];
    let controller;
    document.body.addEventListener('hana:start', (event) => events.push({
      type: event.type,
      bubbles: event.bubbles,
      composed: event.composed,
      controller: event.detail.controller === controller,
      state: event.detail.state,
    }));
    document.body.addEventListener('hana:complete', (event) => events.push({
      type: event.type,
      bubbles: event.bubbles,
      composed: event.composed,
      controller: event.detail.controller === controller,
      state: event.detail.state,
    }));
    document.body.addEventListener('hana:cancel', (event) => events.push({
      type: event.type,
      bubbles: event.bubbles,
      composed: event.composed,
      controller: event.detail.controller === controller,
      reason: event.detail.reason,
    }));
    controller = annotate(owner, {
      mark: 'underline', note: 'Review this line', accessible: true, duration: 1,
    });
    const initial = { state: controller.state, finished: controller.finished };
    const chained = controller.show() === controller;
    const firstRun = controller.finished;
    await firstRun;
    const visible = {
      state: controller.state,
      description: owner.getAttribute('aria-describedby'),
      paths: document.querySelectorAll('.hana-mark-path').length,
      notes: document.querySelectorAll('.hana-note').length,
    };
    controller.hide();
    const hidden = { state: controller.state, runRetained: controller.finished === firstRun };
    controller.replay();
    const replayRun = controller.finished;
    await replayRun;
    const replayed = { state: controller.state, fresh: replayRun !== firstRun };
    controller.update({ mark: 'circle', note: 'Updated note' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const updated = {
      state: controller.state,
      sameRun: controller.finished === replayRun,
      mark: document.querySelector('.hana-annotation')?.getAttribute('data-hana-mark'),
      note: document.querySelector('.hana-note')?.textContent,
      hidden: document.querySelector('.hana-annotation')?.hasAttribute('hidden'),
    };
    controller.destroy().destroy();
    return {
      initial,
      chained,
      visible,
      hidden,
      replayed,
      updated,
      events,
      final: {
        state: controller.state,
        owned: document.querySelectorAll('[data-hana-id]').length,
        overlay: document.querySelectorAll('[data-hana-overlay]').length,
        description: owner.getAttribute('aria-describedby'),
      },
    };
  });

  expect(result.initial).toEqual({ state: 'idle', finished: null });
  expect(result.chained).toBe(true);
  expect(result.visible.state).toBe('visible');
  expect(result.visible.description).toMatch(/^author-token hana-note-/);
  expect(result.visible.paths).toBeGreaterThan(0);
  expect(result.visible.notes).toBe(1);
  expect(result.hidden).toEqual({ state: 'hidden', runRetained: true });
  expect(result.replayed).toEqual({ state: 'visible', fresh: true });
  expect(result.updated).toEqual({
    state: 'visible', sameRun: true, mark: 'circle', note: 'Updated note', hidden: false,
  });
  expect(result.events).toEqual([
    { type: 'hana:start', bubbles: true, composed: true, controller: true, state: 'showing' },
    { type: 'hana:complete', bubbles: true, composed: true, controller: true, state: 'visible' },
    { type: 'hana:cancel', bubbles: true, composed: true, controller: true, reason: 'hide' },
    { type: 'hana:start', bubbles: true, composed: true, controller: true, state: 'showing' },
    { type: 'hana:complete', bubbles: true, composed: true, controller: true, state: 'visible' },
    { type: 'hana:cancel', bubbles: true, composed: true, controller: true, reason: 'destroy' },
  ]);
  expect(result.final).toEqual({ state: 'destroyed', owned: 0, overlay: 0, description: 'author-token' });
});

test('reduced motion reaches final styles and no-note layout stays connector-free', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const controller = annotate('#direct-target', { mark: 'highlight', duration: 500 });
    const events = [];
    document.querySelector('#direct-target').addEventListener('hana:complete', () => events.push('complete'));
    controller.show();
    const immediate = {
      state: controller.state,
      markPaths: document.querySelectorAll('.hana-mark-path').length,
      events: [...events],
    };
    await Promise.resolve();
    const microtask = { state: controller.state, events: [...events] };
    await controller.finished;
    const group = document.querySelector('.hana-annotation');
    const output = {
      state: controller.state,
      note: document.querySelector('.hana-note'),
      connectors: group.querySelectorAll('.hana-connector-path').length,
      markPaths: group.querySelectorAll('.hana-mark-path').length,
      animating: group.classList.contains('hana-is-animating'),
      immediate,
      microtask,
    };
    controller.destroy();
    return output;
  });

  expect(result).toEqual({
    state: 'visible', note: null, connectors: 0, markPaths: 1, animating: false,
    immediate: { state: 'visible', markPaths: 1, events: ['complete'] },
    microtask: { state: 'visible', events: ['complete'] },
  });
});

test('motion never reaches visible synchronously without waiting for a frame', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const controller = annotate('#direct-target', {
      mark: 'box', note: 'Immediate', motion: 'never', duration: 900,
    });
    controller.show();
    const immediate = {
      state: controller.state,
      paths: document.querySelectorAll('.hana-mark-path').length,
      noteVisible: !document.querySelector('.hana-note').classList.contains('hana-is-hidden'),
    };
    controller.destroy();
    return immediate;
  });
  expect(result).toEqual({ state: 'visible', paths: 2, noteVisible: true });
});

test('selector replacement while visibility is not requested recovers hidden without drawing', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const arena = document.querySelector('#arena');
    const original = document.querySelector('#selector-target');
    const controller = annotate('#selector-target', { mark: 'circle', duration: 0 });
    original.remove();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const suspended = controller.state;
    const replacement = document.createElement('p');
    replacement.id = 'selector-target';
    replacement.textContent = 'Hidden-intent replacement';
    arena.append(replacement);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const group = document.querySelector('.hana-annotation');
    const output = {
      suspended,
      recovered: controller.state,
      hidden: group.hasAttribute('hidden'),
      paths: group.querySelectorAll('.hana-mark-path').length,
    };
    controller.destroy();
    return output;
  });
  expect(result).toEqual({ suspended: 'suspended', recovered: 'hidden', hidden: true, paths: 0 });
});

test('hidden and non-renderable targets suspend on show and refresh, then recover', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const target = document.querySelector('#direct-target');
    target.hidden = true;
    const controller = annotate(target, { mark: 'underline', duration: 0 });
    const errors = [];
    target.addEventListener('hana:error', (event) => errors.push(event.detail.error.code));
    controller.show();
    const showError = await controller.finished.then(() => null, (error) => error.code);
    const afterShow = {
      state: controller.state,
      hidden: document.querySelector('.hana-annotation').hasAttribute('hidden'),
      paths: document.querySelectorAll('.hana-mark-path').length,
    };
    controller.refresh();
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.refresh();
    await new Promise((resolve) => setTimeout(resolve, 30));
    target.hidden = false;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const recovered = controller.state;
    target.style.visibility = 'hidden';
    controller.refresh();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterRefresh = controller.state;
    target.style.visibility = 'visible';
    controller.refresh();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const final = controller.state;
    controller.destroy();
    return { showError, afterShow, recovered, afterRefresh, final, errors };
  });
  expect(result).toEqual({
    showError: 'HANA_TARGET_INVALID',
    afterShow: { state: 'suspended', hidden: true, paths: 0 },
    recovered: 'visible',
    afterRefresh: 'suspended',
    final: 'visible',
    errors: ['HANA_TARGET_INVALID', 'HANA_TARGET_INVALID'],
  });
});

test('invalid construction leaves no overlay or owned DOM behind', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const errors = [];
    for (const [target, options] of [
      ['#missing-target', { mark: 'circle' }],
      ['#direct-target', { mark: 'invalid' }],
    ]) {
      try { annotate(target, options); } catch (error) { errors.push(error.code); }
    }
    return {
      errors,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      owned: document.querySelectorAll('[data-hana-id]').length,
    };
  });
  expect(result).toEqual({
    errors: ['HANA_TARGET_MISSING', 'HANA_CONFIG_INVALID'], overlays: 0, owned: 0,
  });
});

test('direct target suspends once and recovers only when the same node reconnects', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const arena = document.querySelector('#arena');
    const target = document.querySelector('#direct-target');
    const controller = annotate(target, { mark: 'box', duration: 0 });
    const errors = [];
    target.addEventListener('hana:error', (event) => errors.push(event.detail.error.code));
    controller.show();
    await controller.finished;
    target.remove();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const suspended = controller.state;
    arena.append(target);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const recovered = controller.state;
    const visible = !document.querySelector('.hana-annotation').hasAttribute('hidden');
    controller.destroy();
    return { suspended, recovered, visible, errors };
  });

  expect(result.suspended).toBe('suspended');
  expect(result.recovered).toBe('visible');
  expect(result.visible).toBe(true);
  expect(result.errors).toHaveLength(1);
});

test('selector replacement recovers visibility and accessible ownership', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const arena = document.querySelector('#arena');
    const controller = annotate('#selector-target', {
      mark: 'circle', note: 'Selector note', accessible: true, duration: 0,
    });
    controller.show();
    await controller.finished;
    const original = document.querySelector('#selector-target');
    original.remove();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const suspended = controller.state;
    const replacement = document.createElement('p');
    replacement.id = 'selector-target';
    replacement.className = 'target';
    replacement.textContent = 'Replacement selector target';
    arena.append(replacement);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const output = {
      suspended,
      recovered: controller.state,
      oldDescription: original.getAttribute('aria-describedby'),
      newDescription: replacement.getAttribute('aria-describedby'),
    };
    controller.destroy();
    return output;
  });

  expect(result.suspended).toBe('suspended');
  expect(result.recovered).toBe('visible');
  expect(result.oldDescription).toBe(null);
  expect(result.newDescription).toMatch(/^hana-note-/);
});

test('native Range remains suspended after replacement until update supplies the next Range', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const first = document.querySelector('#range-target');
    const makeRange = (element) => {
      const range = document.createRange();
      range.setStart(element.firstChild, 0);
      range.setEnd(element.firstChild, element.firstChild.data.length);
      return range;
    };
    const controller = annotate(makeRange(first), { mark: 'strike', duration: 0 });
    controller.show();
    await controller.finished;
    first.replaceChildren('Changed native range text');
    controller.refresh();
    const suspended = controller.state;
    const next = document.querySelector('#next-range-target');
    const run = controller.finished;
    controller.update({ target: makeRange(next) });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const output = {
      suspended,
      recovered: controller.state,
      sameRun: controller.finished === run,
      paths: document.querySelectorAll('.hana-mark-path').length,
    };
    controller.destroy();
    return output;
  });

  expect(result).toEqual({ suspended: 'suspended', recovered: 'visible', sameRun: true, paths: 2 });
});

test('expected hide and replay AbortErrors stay owned without stale writes or unhandled rejection', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const unhandled = [];
    window.addEventListener('unhandledrejection', (event) => unhandled.push(event.reason?.name ?? String(event.reason)));
    const controller = annotate('#direct-target', {
      mark: 'underline', note: 'No stale write', duration: 80,
    });
    controller.show();
    const first = controller.finished;
    controller.hide();
    const firstError = await first.then(() => null, (error) => error.name);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const afterHide = {
      state: controller.state,
      hidden: document.querySelector('.hana-annotation').hasAttribute('hidden'),
      noteHidden: document.querySelector('.hana-note').classList.contains('hana-is-hidden'),
    };
    controller.replay();
    const replayed = controller.finished;
    controller.replay();
    const replayError = await replayed.then(() => null, (error) => error.name);
    await controller.finished;
    controller.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { firstError, replayError, afterHide, unhandled };
  });

  expect(result).toEqual({
    firstError: 'AbortError',
    replayError: 'AbortError',
    afterHide: { state: 'hidden', hidden: true, noteHidden: true },
    unhandled: [],
  });
});

test('selector owner replacement rebinds scrolling ancestors for later geometry updates', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const original = document.querySelector('#selector-target');
    const controller = annotate('#selector-target', { mark: 'underline', duration: 0 });
    controller.show();
    await controller.finished;
    const scrollbox = document.createElement('div');
    scrollbox.style.cssText = 'height:80px;overflow:auto;position:absolute;left:300px;top:30px;width:260px';
    const spacer = document.createElement('div');
    spacer.style.height = '180px';
    const replacement = document.createElement('p');
    replacement.id = 'selector-target';
    replacement.textContent = 'Scrolled replacement target';
    scrollbox.append(spacer, replacement);
    original.remove();
    document.querySelector('#arena').append(scrollbox);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const before = document.querySelector('.hana-mark-path').getAttribute('d');
    scrollbox.scrollTop = 140;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = document.querySelector('.hana-mark-path').getAttribute('d');
    controller.destroy();
    return { state: controller.state, moved: before !== after };
  });

  expect(result).toEqual({ state: 'destroyed', moved: true });
});
