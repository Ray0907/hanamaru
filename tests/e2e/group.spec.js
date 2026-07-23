import { expect, test } from '@playwright/test';

const pageErrorsByPage = new WeakMap();

async function drainBrowserFailures(page) {
  await page.evaluate(async () => {
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  });
  return {
    pageErrors: [...pageErrorsByPage.get(page) ?? []],
    unhandled: await page.evaluate(() => [...window.__groupUnhandled]),
  };
}

test.beforeEach(async ({ page }) => {
  const pageErrors = [];
  pageErrorsByPage.set(page, pageErrors);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__groupUnhandled = [];
    window.addEventListener('unhandledrejection', (event) => {
      window.__groupUnhandled.push(event.reason?.name ?? String(event.reason));
    });
  });
  await page.goto('/tests/fixtures/group.html');
});

test.afterEach(async ({ page }) => {
  expect(await drainBrowserFailures(page)).toEqual({
    pageErrors: [],
    unhandled: [],
  });
});

test('three unequal members draw in one frame and complete only after every animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const output = await page.evaluate(async () => {
    const descriptors = {
      animate: Object.getOwnPropertyDescriptor(Element.prototype, 'animate'),
      cancelAnimationFrame: Object.getOwnPropertyDescriptor(window, 'cancelAnimationFrame'),
      clearTimeout: Object.getOwnPropertyDescriptor(window, 'clearTimeout'),
      now: Object.getOwnPropertyDescriptor(performance, 'now'),
      requestAnimationFrame: Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame'),
      setTimeout: Object.getOwnPropertyDescriptor(window, 'setTimeout'),
    };
    let clockNow = 0;
    let nextFrameId = 1;
    let nextTimerId = 1;
    let frameNumber = 0;
    const frames = new Map();
    const timers = new Map();
    let activeFrame = null;
    const animations = [];
    let controller = null;
    let result;
    const flushMicrotasks = async () => {
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    };
    const runFrame = async () => {
      const pending = [...frames.values()];
      frames.clear();
      frameNumber += 1;
      activeFrame = frameNumber;
      for (const callback of pending) callback(clockNow);
      activeFrame = null;
      await flushMicrotasks();
      return pending.length;
    };
    const completeMemberAt = async (mark, timestamp) => {
      const dueTimers = [...timers.entries()]
        .filter(([, timer]) => timer.due <= timestamp)
        .sort(([, first], [, second]) => first.due - second.due);
      if (dueTimers.length !== 1
        || dueTimers[0][1].due !== timestamp
        || dueTimers[0][1].mark !== mark) {
        throw new Error(
          `Expected only ${mark}@${timestamp}; got ${dueTimers
            .map(([, timer]) => `${timer.mark}@${timer.due}`).join(',')}`,
        );
      }
      const active = animations.filter((entry) => (
        entry.mark === mark && entry.animation.playState !== 'finished'
      ));
      if (active.length === 0) throw new Error(`No controlled animations for ${mark}`);
      for (const { animation } of active) animation.finish();
      const [id, timer] = dueTimers[0];
      timers.delete(id);
      clockNow = timestamp;
      timer.callback();
      await flushMicrotasks();
      return {
        allAnimationsFinished: active.every(({ animation }) => (
          animation.playState === 'finished'
        )),
        due: timestamp,
        hadAnimations: active.length > 0,
        mark,
        timerMark: timer.mark,
      };
    };
    const tokenState = (id) => {
      const tokens = (document.querySelector(`#${id}`).getAttribute('aria-describedby') ?? '')
        .split(/\s+/u).filter(Boolean);
      const hanaTokens = tokens.filter((token) => token.startsWith('hana-note-'));
      return {
        hana: hanaTokens.length,
        owned: hanaTokens.filter((token) => (
          document.getElementById(token)?.hasAttribute('data-hana-note')
        )).length,
        tokens,
        total: tokens.length,
        unique: new Set(tokens).size,
      };
    };
    const restore = (owner, key, descriptor) => {
      if (descriptor === undefined) delete owner[key];
      else Object.defineProperty(owner, key, descriptor);
    };

    try {
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: () => clockNow,
      });
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value(callback) {
          const id = nextFrameId;
          nextFrameId += 1;
          frames.set(id, callback);
          return id;
        },
      });
      Object.defineProperty(window, 'cancelAnimationFrame', {
        configurable: true,
        value(id) { frames.delete(id); },
      });
      Object.defineProperty(window, 'setTimeout', {
        configurable: true,
        value(callback, delay = 0) {
          const id = nextTimerId;
          nextTimerId += 1;
          timers.set(id, {
            callback,
            due: clockNow + Number(delay),
            mark: null,
          });
          return id;
        },
      });
      Object.defineProperty(window, 'clearTimeout', {
        configurable: true,
        value(id) { timers.delete(id); },
      });

      class ControlledAnimation {
        constructor(mark) {
          this.mark = mark;
          this.playState = 'running';
          this.finished = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
          });
        }

        cancel() {
          if (this.playState === 'idle' || this.playState === 'finished') return;
          this.playState = 'idle';
          this.reject(new DOMException('Animation cancelled', 'AbortError'));
        }

        finish() {
          if (this.playState === 'finished') return;
          this.playState = 'finished';
          this.resolve();
        }

        pause() { this.playState = 'paused'; }

        play() { this.playState = 'running'; }
      }

      Object.defineProperty(Element.prototype, 'animate', {
        configurable: true,
        value() {
          const ownerId = this.getAttribute('data-hana-id');
          const ownerGroup = ownerId === null
            ? this.closest('.hana-annotation')
            : document.querySelector(`.hana-annotation[data-hana-id="${ownerId}"]`);
          const mark = ownerGroup?.getAttribute('data-hana-mark')
            ?? this.getAttribute('data-hana-mark');
          const pendingTimers = [...timers.values()].filter(({ mark: owner }) => owner === null);
          if (pendingTimers.length > 1) {
            throw new Error(`Multiple unowned lifecycle timers before ${mark}`);
          }
          if (pendingTimers.length === 1) pendingTimers[0].mark = mark;
          const animation = new ControlledAnimation(mark);
          animations.push({ animation, frame: activeFrame, mark });
          return animation;
        },
      });

      const events = [];
      for (const type of ['hana:start', 'hana:complete', 'hana:cancel']) {
        document.body.addEventListener(type, (event) => {
          if (event.detail.controller === controller) {
            events.push({ type, state: event.detail.controller.state });
          }
        });
      }
      const { group } = await import('/src/group.js');
      controller = group([
        {
          target: '#group-first',
          mark: 'underline',
          note: 'First note',
          accessible: true,
          duration: 120,
        },
        {
          target: '#group-second',
          mark: 'circle',
          note: 'Second note',
          accessible: true,
          duration: 240,
        },
        { target: '#group-third', mark: 'highlight', duration: 480 },
      ]);
      const surface = Object.keys(controller).sort();
      controller.show();
      const firstRun = controller.finished;
      const immediateState = controller.state;
      const initialFrameCallbacks = await runFrame();
      const drawFrames = [...new Set(animations.map(({ frame }) => frame))];
      const startedMarks = [...new Set(animations.map(({ mark }) => mark))].sort();

      const completions = [];
      completions.push(await completeMemberAt('underline', 120));
      const stateAfterFirstAnimation = controller.state;
      completions.push(await completeMemberAt('circle', 240));
      const stateAfterSecondAnimation = controller.state;
      completions.push(await completeMemberAt('highlight', 480));
      await firstRun;
      const stateAfterFinalAnimation = controller.state;

      controller.refresh();
      await runFrame();
      const afterRefresh = {
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
        tokenSets: ['group-first', 'group-second', 'group-third'].map(tokenState),
        visible: document.querySelectorAll('.hana-annotation:not([hidden])').length,
      };
      controller.hide();
      const afterHide = {
        state: controller.state,
        descriptions: ['group-first', 'group-second', 'group-third'].map((id) => (
          document.querySelector(`#${id}`).getAttribute('aria-describedby')
        )),
        visible: document.querySelectorAll('.hana-annotation:not([hidden])').length,
      };
      controller.replay();
      const replayRun = controller.finished;
      await runFrame();
      await completeMemberAt('underline', 600);
      await completeMemberAt('circle', 720);
      await completeMemberAt('highlight', 960);
      await replayRun;
      const afterReplay = {
        freshRun: replayRun !== firstRun,
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
        state: controller.state,
        tokenSets: ['group-first', 'group-second', 'group-third'].map(tokenState),
        visible: document.querySelectorAll('.hana-annotation:not([hidden])').length,
      };
      controller.replay();
      const cancelledRun = controller.finished;
      await runFrame();
      const cancelledAnimations = animations.filter(({ animation }) => (
        animation.playState === 'running'
      ));
      controller.destroy();
      const cancellation = {
        allIdle: cancelledAnimations.every(({ animation }) => animation.playState === 'idle'),
        animations: cancelledAnimations.length,
        runOutcome: await cancelledRun.then(
          () => 'resolved',
          (error) => error.name,
        ),
      };
      await flushMicrotasks();
      const cleanup = {
        activeAnimations: animations.filter(({ animation }) => (
          animation.playState === 'running' || animation.playState === 'paused'
        )).length,
        frames: frames.size,
        timers: timers.size,
      };
      if (cleanup.activeAnimations !== 0 || cleanup.frames !== 0 || cleanup.timers !== 0) {
        throw new Error(`Controlled harness leaked ${JSON.stringify(cleanup)}`);
      }
      result = {
        afterDestroy: {
          descriptions: ['group-first', 'group-second', 'group-third'].map((id) => (
            document.querySelector(`#${id}`).getAttribute('aria-describedby')
          )),
          overlays: document.querySelectorAll('[data-hana-overlay]').length,
          owned: document.querySelectorAll('[data-hana-id]').length,
        },
        afterHide,
        afterRefresh,
        afterReplay,
        cancellation,
        cleanup,
        completions,
        drawFrames,
        events,
        immediateState,
        initialFrameCallbacks,
        startedMarks,
        stateAfterFinalAnimation,
        stateAfterFirstAnimation,
        stateAfterSecondAnimation,
        surface,
      };
    } finally {
      controller?.destroy();
      const cleanup = {
        activeAnimations: animations.filter(({ animation }) => (
          animation.playState === 'running' || animation.playState === 'paused'
        )).length,
        frames: frames.size,
        timers: timers.size,
      };
      restore(performance, 'now', descriptors.now);
      restore(window, 'requestAnimationFrame', descriptors.requestAnimationFrame);
      restore(window, 'cancelAnimationFrame', descriptors.cancelAnimationFrame);
      restore(window, 'setTimeout', descriptors.setTimeout);
      restore(window, 'clearTimeout', descriptors.clearTimeout);
      restore(Element.prototype, 'animate', descriptors.animate);
      if (cleanup.activeAnimations !== 0 || cleanup.frames !== 0 || cleanup.timers !== 0) {
        throw new Error(`Controlled harness leaked before restore ${JSON.stringify(cleanup)}`);
      }
    }
    return result;
  });

  expect(output.surface).toEqual([
    'destroy', 'finished', 'hide', 'refresh', 'replay', 'show', 'size', 'state',
  ]);
  expect(output.immediateState).toBe('showing');
  expect(output.drawFrames).toEqual([1]);
  expect(output.initialFrameCallbacks).toBe(1);
  expect(output.startedMarks).toEqual(['circle', 'highlight', 'underline']);
  expect(output.completions).toEqual([
    {
      allAnimationsFinished: true,
      due: 120,
      hadAnimations: true,
      mark: 'underline',
      timerMark: 'underline',
    },
    {
      allAnimationsFinished: true,
      due: 240,
      hadAnimations: true,
      mark: 'circle',
      timerMark: 'circle',
    },
    {
      allAnimationsFinished: true,
      due: 480,
      hadAnimations: true,
      mark: 'highlight',
      timerMark: 'highlight',
    },
  ]);
  expect([
    output.stateAfterFirstAnimation,
    output.stateAfterSecondAnimation,
    output.stateAfterFinalAnimation,
  ]).toEqual(['showing', 'showing', 'visible']);
  expect(output.events).toEqual([
    { type: 'hana:start', state: 'showing' },
    { type: 'hana:complete', state: 'visible' },
    { type: 'hana:cancel', state: 'hidden' },
    { type: 'hana:start', state: 'showing' },
    { type: 'hana:complete', state: 'visible' },
    { type: 'hana:cancel', state: 'hidden' },
    { type: 'hana:start', state: 'showing' },
    { type: 'hana:cancel', state: 'destroyed' },
  ]);
  expect(output.afterRefresh).toEqual({
    overlays: 1,
    tokenSets: [
      {
        hana: 1,
        owned: 1,
        tokens: ['author-first', expect.stringMatching(/^hana-note-/)],
        total: 2,
        unique: 2,
      },
      {
        hana: 1,
        owned: 1,
        tokens: [expect.stringMatching(/^hana-note-/)],
        total: 1,
        unique: 1,
      },
      { hana: 0, owned: 0, tokens: [], total: 0, unique: 0 },
    ],
    visible: 3,
  });
  expect(output.afterHide).toEqual({
    state: 'hidden',
    descriptions: ['author-first', null, null],
    visible: 0,
  });
  expect(output.afterReplay).toEqual({
    freshRun: true,
    overlays: 1,
    state: 'visible',
    tokenSets: [
      {
        hana: 1,
        owned: 1,
        tokens: ['author-first', expect.stringMatching(/^hana-note-/)],
        total: 2,
        unique: 2,
      },
      {
        hana: 1,
        owned: 1,
        tokens: [expect.stringMatching(/^hana-note-/)],
        total: 1,
        unique: 1,
      },
      { hana: 0, owned: 0, tokens: [], total: 0, unique: 0 },
    ],
    visible: 3,
  });
  expect(output.afterDestroy).toEqual({
    descriptions: ['author-first', null, null],
    overlays: 0,
    owned: 0,
  });
  expect(output.cancellation).toEqual({
    allIdle: true,
    animations: 10,
    runOutcome: 'AbortError',
  });
  expect(output.cleanup).toEqual({
    activeAnimations: 0,
    frames: 0,
    timers: 0,
  });
});

test('group constructs and completes in the top document and an iframe document', async ({ page }) => {
  const output = await page.evaluate(async () => {
    const { group } = await import('/src/group.js');
    const top = group([
      { target: '#group-first', mark: 'underline' },
      { target: '#group-second', mark: 'circle' },
    ], { motion: 'never' });
    top.show();
    await top.finished;

    const frame = document.createElement('iframe');
    frame.srcdoc = `<!doctype html><html><body>
      <p id="frame-first" style="display:inline-block">Frame first</p>
      <p id="frame-second" style="display:inline-block">Frame second</p>
    </body></html>`;
    document.body.append(frame);
    await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    const frameDocument = frame.contentDocument;
    const inside = group([
      { target: '#frame-first', mark: 'highlight' },
      { target: '#frame-second', mark: 'box' },
    ], { motion: 'never' }, { root: frameDocument });
    inside.show();
    await inside.finished;

    const result = {
      topState: top.state,
      topMarks: document.querySelectorAll('.hana-annotation:not([hidden])').length,
      frameState: inside.state,
      frameMarks: frameDocument.querySelectorAll('.hana-annotation:not([hidden])').length,
      frameOverlays: frameDocument.querySelectorAll('[data-hana-overlay]').length,
    };
    top.destroy();
    inside.destroy();
    return result;
  });

  expect(output).toEqual({
    topState: 'visible',
    topMarks: 2,
    frameState: 'visible',
    frameMarks: 2,
    frameOverlays: 1,
  });
});

test('direct iframe targets require their exact Document and mixed roots fail atomically', async ({ page }) => {
  const output = await page.evaluate(async () => {
    const { group } = await import('/src/group.js');
    const frame = document.createElement('iframe');
    frame.srcdoc = `<!doctype html><html><body>
      <p id="first" style="display:inline-block">Frame first</p>
      <p id="second" style="display:inline-block">Frame second</p>
    </body></html>`;
    document.body.append(frame);
    await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    const frameDocument = frame.contentDocument;
    const first = frameDocument.querySelector('#first');
    const second = frameDocument.querySelector('#second');
    const snapshot = () => ({
      frameOwned: frameDocument.querySelectorAll('[data-hana-id]').length,
      frameOverlays: frameDocument.querySelectorAll('[data-hana-overlay]').length,
      topOwned: document.querySelectorAll('[data-hana-id]').length,
      topOverlays: document.querySelectorAll('[data-hana-overlay]').length,
    });
    const events = [];
    first.addEventListener('hana:start', (event) => {
      events.push({
        bubbles: event.bubbles,
        composed: event.composed,
        owner: event.target.id,
      });
    });
    let omittedRootCode;
    try {
      group([
        { target: first, mark: 'underline' },
        { target: second, mark: 'circle' },
      ], { motion: 'never' });
    } catch (error) {
      omittedRootCode = error.code;
    }
    const afterOmittedRoot = snapshot();
    let wrongRootCode;
    try {
      group([
        { target: first, mark: 'underline' },
        { target: second, mark: 'circle' },
      ], { motion: 'never' }, { root: document });
    } catch (error) {
      wrongRootCode = error.code;
    }
    const afterWrongRoot = snapshot();
    let mixedCode;
    try {
      group([
        { target: document.querySelector('#group-first'), mark: 'underline' },
        { target: first, mark: 'circle' },
      ], { motion: 'never' });
    } catch (error) {
      mixedCode = error.code;
    }
    const afterMixedRoot = snapshot();
    const controller = group([
      { target: first, mark: 'underline' },
      { target: second, mark: 'circle' },
    ], { motion: 'never' }, { root: frameDocument });
    controller.show();
    await controller.finished;

    const result = {
      afterMixedRoot,
      afterOmittedRoot,
      afterWrongRoot,
      events,
      frameMarks: frameDocument.querySelectorAll('.hana-annotation:not([hidden])').length,
      frameOverlays: frameDocument.querySelectorAll('[data-hana-overlay]').length,
      mixedCode,
      omittedRootCode,
      state: controller.state,
      topOwned: document.querySelectorAll('[data-hana-id]').length,
      topOverlays: document.querySelectorAll('[data-hana-overlay]').length,
      wrongRootCode,
    };
    controller.destroy();
    result.afterDestroy = {
      frameOwned: frameDocument.querySelectorAll('[data-hana-id]').length,
      frameOverlays: frameDocument.querySelectorAll('[data-hana-overlay]').length,
    };
    return result;
  });

  expect(output).toEqual({
    afterDestroy: { frameOwned: 0, frameOverlays: 0 },
    afterMixedRoot: {
      frameOwned: 0,
      frameOverlays: 0,
      topOwned: 0,
      topOverlays: 0,
    },
    afterOmittedRoot: {
      frameOwned: 0,
      frameOverlays: 0,
      topOwned: 0,
      topOverlays: 0,
    },
    afterWrongRoot: {
      frameOwned: 0,
      frameOverlays: 0,
      topOwned: 0,
      topOverlays: 0,
    },
    events: [{ bubbles: true, composed: true, owner: 'first' }],
    frameMarks: 2,
    frameOverlays: 1,
    mixedCode: 'HANA_TARGET_INVALID',
    omittedRootCode: 'HANA_TARGET_INVALID',
    state: 'visible',
    topOwned: 0,
    topOverlays: 0,
    wrongRootCode: 'HANA_TARGET_INVALID',
  });
});

test('standalone Shadow members reject before mounting any Group output', async ({ page }) => {
  const output = await page.evaluate(async () => {
    const { group } = await import('/src/group.js');
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<span id="shadow-target" style="display:inline-block">Shadow target</span>';
    let code;
    try {
      group([
        { target: shadow.querySelector('#shadow-target'), mark: 'box' },
      ], { motion: 'never' });
    } catch (error) {
      code = error.code;
    }
    return {
      code,
      documentOwned: document.querySelectorAll('[data-hana-id]').length,
      documentOverlays: document.querySelectorAll('[data-hana-overlay]').length,
      shadowOwned: shadow.querySelectorAll('[data-hana-id]').length,
      shadowOverlays: shadow.querySelectorAll('[data-hana-overlay]').length,
    };
  });

  expect(output).toEqual({
    code: 'HANA_TARGET_SHADOW_UNSCOPED',
    documentOwned: 0,
    documentOverlays: 0,
    shadowOwned: 0,
    shadowOverlays: 0,
  });
});

test('layout loss suspends all members and refresh recovers the existing run', async ({ page }) => {
  await page.evaluate(async () => {
    const { group } = await import('/src/group.js');
    const errors = [];
    let controller;
    document.querySelector('#layout-first').addEventListener('hana:error', (event) => {
      if (event.detail.controller === controller) {
        errors.push({
          code: event.detail.error.code,
          index: event.detail.index,
          memberCode: event.detail.error.details?.error?.code,
        });
      }
    });
    controller = group([
      { target: '#layout-first', mark: 'underline' },
      { target: '#layout-second', mark: 'circle' },
      { target: '#layout-third', mark: 'highlight' },
    ], { motion: 'never' });
    controller.show();
    await controller.finished;
    window.layoutGroup = controller;
    window.layoutGroupRun = controller.finished;
    window.layoutGroupErrors = errors;
    document.querySelector('#layout-stage').style.display = 'none';
    controller.refresh();
  });

  await page.waitForFunction(() => window.layoutGroup.state === 'suspended');
  const suspended = await page.evaluate(() => ({
    errors: window.layoutGroupErrors,
    sameRun: window.layoutGroup.finished === window.layoutGroupRun,
    state: window.layoutGroup.state,
    visible: document.querySelectorAll('.hana-annotation:not([hidden])').length,
  }));
  expect(suspended).toEqual({
    errors: [{
      code: 'HANA_STATE_GROUP_MEMBER',
      index: 0,
      memberCode: 'HANA_TARGET_INVALID',
    }],
    sameRun: true,
    state: 'suspended',
    visible: 0,
  });

  await page.evaluate(() => {
    document.querySelector('#layout-stage').style.display = 'inline-block';
    window.layoutGroup.refresh();
  });
  await page.waitForFunction(() => window.layoutGroup.state === 'visible');
  expect(await page.evaluate(() => ({
    errors: window.layoutGroupErrors.length,
    overlays: document.querySelectorAll('[data-hana-overlay]').length,
    sameRun: window.layoutGroup.finished === window.layoutGroupRun,
    visible: document.querySelectorAll('.hana-annotation:not([hidden])').length,
  }))).toEqual({
    errors: 1,
    overlays: 1,
    sameRun: true,
    visible: 3,
  });
  await page.evaluate(() => window.layoutGroup.destroy());
  expect(await drainBrowserFailures(page)).toEqual({
    pageErrors: [],
    unhandled: [],
  });
});

test('failure at every member index removes all Group output', async ({ page }) => {
  const output = await page.evaluate(async () => {
    const { group } = await import('/src/group.js');
    const ids = ['group-first', 'group-second', 'group-third'];
    const results = [];
    for (let failureIndex = 0; failureIndex < ids.length; failureIndex += 1) {
      const first = document.querySelector('#group-first');
      const errors = [];
      let controller;
      first.addEventListener('hana:error', (event) => {
        if (event.detail.controller === controller) {
          errors.push({
            code: event.detail.error.code,
            index: event.detail.index,
            memberCode: event.detail.error.details?.error?.code,
          });
        }
      });
      controller = group(ids.map((id, index) => ({
        target: `#${id}`,
        mark: ['underline', 'circle', 'highlight'][index],
        note: `Member ${index}`,
      })), { motion: 'never' });
      controller.show();
      await controller.finished;
      const removed = document.querySelector(`#${ids[failureIndex]}`);
      const parent = removed.parentNode;
      const next = removed.nextSibling;
      removed.remove();
      controller.refresh();
      results.push({
        errors,
        index: failureIndex,
        state: controller.state,
        visible: document.querySelectorAll('.hana-annotation:not([hidden])').length,
      });
      controller.destroy();
      parent.insertBefore(removed, next);
      results.at(-1).afterDestroy = {
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
        owned: document.querySelectorAll('[data-hana-id]').length,
      };
    }
    return { results, unhandled: window.__groupUnhandled };
  });

  expect(output.results).toEqual([0, 1, 2].map((index) => ({
    afterDestroy: { overlays: 0, owned: 0 },
    errors: [{
      code: 'HANA_STATE_GROUP_MEMBER',
      index,
      memberCode: 'HANA_TARGET_MISSING',
    }],
    index,
    state: 'suspended',
    visible: 0,
  })));
  expect(output.unhandled).toEqual([]);
});

test('selector replacement before replay rebinds events, output, and ARIA ownership', async ({ page }) => {
  const output = await page.evaluate(async () => {
    const { group } = await import('/src/group.js');
    const original = document.querySelector('#group-first');
    let controller = group([
      {
        target: '#group-first',
        mark: 'underline',
        note: 'First note',
        accessible: true,
      },
      { target: '#group-second', mark: 'circle', note: 'Second note' },
      { target: '#group-third', mark: 'highlight', note: 'Third note' },
    ], { motion: 'never' });
    controller.show();
    await controller.finished;
    const firstRun = controller.finished;
    const replacement = document.createElement('p');
    replacement.id = 'group-first';
    replacement.className = 'target';
    replacement.setAttribute('aria-describedby', 'author-first');
    replacement.textContent = 'Replacement first target';
    const events = [];
    for (const type of ['hana:cancel', 'hana:start', 'hana:complete']) {
      replacement.addEventListener(type, (event) => {
        if (event.detail.controller === controller) events.push(type);
      });
    }
    original.replaceWith(replacement);
    controller.replay();
    const replayRun = controller.finished;
    await replayRun;
    controller.refresh();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const replacementTokens = replacement.getAttribute('aria-describedby').split(/\s+/u);
    const result = {
      events,
      freshRun: replayRun !== firstRun,
      oldDescription: original.getAttribute('aria-describedby'),
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      replacementTokens,
      state: controller.state,
      visible: document.querySelectorAll('.hana-annotation:not([hidden])').length,
    };
    controller.destroy();
    result.afterDestroy = {
      description: replacement.getAttribute('aria-describedby'),
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      owned: document.querySelectorAll('[data-hana-id]').length,
    };
    return result;
  });

  expect(output).toEqual({
    afterDestroy: { description: 'author-first', overlays: 0, owned: 0 },
    events: ['hana:cancel', 'hana:start', 'hana:complete'],
    freshRun: true,
    oldDescription: 'author-first',
    overlays: 1,
    replacementTokens: ['author-first', expect.stringMatching(/^hana-note-/)],
    state: 'visible',
    visible: 3,
  });
});

test('load and viewport triggers start once and release their trigger resources', async ({ page }) => {
  const output = await page.evaluate(async () => {
    const { group } = await import('/src/group.js');
    const loadEvents = [];
    let loadGroup;
    document.querySelector('#group-first').addEventListener('hana:start', (event) => {
      if (event.detail.controller === loadGroup) loadEvents.push('start');
    });
    loadGroup = group([
      { target: '#group-first', mark: 'underline' },
      { target: '#group-second', mark: 'circle' },
    ], { trigger: 'load', motion: 'never' });
    const loadImmediate = loadGroup.state;
    await Promise.resolve();
    await loadGroup.finished;
    document.dispatchEvent(new Event('DOMContentLoaded'));
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await Promise.resolve();
    const loadAfter = loadGroup.state;
    loadGroup.destroy();

    class FakeIntersectionObserver {
      static instances = [];

      constructor(callback, options) {
        Object.assign(this, {
          callback,
          disconnects: 0,
          options,
          target: null,
          unobserved: 0,
        });
        FakeIntersectionObserver.instances.push(this);
      }

      observe(target) { this.target = target; }

      unobserve(target) {
        if (target === this.target) this.unobserved += 1;
      }

      disconnect() { this.disconnects += 1; }

      enter() {
        this.callback([{
          intersectionRatio: 1,
          isIntersecting: true,
          target: this.target,
        }], this);
      }
    }
    window.IntersectionObserver = FakeIntersectionObserver;
    const viewportEvents = [];
    let viewportGroup;
    document.querySelector('#group-first').addEventListener('hana:start', (event) => {
      if (event.detail.controller === viewportGroup) viewportEvents.push('start');
    });
    viewportGroup = group([
      { target: '#group-first', mark: 'underline' },
      { target: '#group-second', mark: 'circle' },
    ], { trigger: 'viewport', motion: 'never' });
    const observer = FakeIntersectionObserver.instances[0];
    const viewportImmediate = viewportGroup.state;
    observer.enter();
    observer.enter();
    await viewportGroup.finished;
    const result = {
      loadAfter,
      loadEvents,
      loadImmediate,
      observer: {
        disconnects: observer.disconnects,
        threshold: observer.options.threshold,
        unobserved: observer.unobserved,
      },
      viewportEvents,
      viewportImmediate,
      viewportState: viewportGroup.state,
    };
    viewportGroup.destroy();
    result.afterDestroy = {
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      owned: document.querySelectorAll('[data-hana-id]').length,
    };
    return result;
  });

  expect(output).toEqual({
    afterDestroy: { overlays: 0, owned: 0 },
    loadAfter: 'visible',
    loadEvents: ['start'],
    loadImmediate: 'idle',
    observer: { disconnects: 1, threshold: 0.25, unobserved: 1 },
    viewportEvents: ['start'],
    viewportImmediate: 'idle',
    viewportState: 'visible',
  });
});

test('reduced motion keeps one run lifecycle without live animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const output = await page.evaluate(async () => {
    const { group } = await import('/src/group.js');
    const events = [];
    let controller;
    for (const type of ['hana:start', 'hana:complete']) {
      document.querySelector('#group-first').addEventListener(type, (event) => {
        if (event.detail.controller === controller) {
          events.push({ state: event.detail.controller.state, type });
        }
      });
    }
    controller = group([
      { target: '#group-first', mark: 'underline', duration: 1000 },
      { target: '#group-second', mark: 'circle', duration: 1200 },
      { target: '#group-third', mark: 'highlight', duration: 1400 },
    ]);
    controller.show();
    const run = controller.finished;
    const immediate = {
      animations: document.getAnimations().length,
      sameRun: controller.finished === run,
      state: controller.state,
    };
    await run;
    const markPaths = [...document.querySelectorAll('.hana-mark-path')];
    const pathsFor = (mark) => [
      ...document.querySelectorAll(
        `.hana-annotation[data-hana-mark="${mark}"] .hana-mark-path`,
      ),
    ];
    const result = {
      animations: document.getAnimations().length,
      events,
      immediate,
      markStyles: {
        circle: pathsFor('circle').map((path) => ({
          dasharray: path.style.strokeDasharray,
          dashoffset: path.style.strokeDashoffset,
        })),
        highlight: pathsFor('highlight').map((path) => ({
          clipPath: path.style.clipPath,
        })),
        underline: pathsFor('underline').map((path) => ({
          dasharray: path.style.strokeDasharray,
          dashoffset: path.style.strokeDashoffset,
        })),
      },
      pathCount: markPaths.length,
      sameRun: controller.finished === run,
      state: controller.state,
      visible: document.querySelectorAll('.hana-annotation:not([hidden])').length,
    };
    controller.destroy();
    return result;
  });

  expect(output).toEqual({
    animations: 0,
    events: [
      { state: 'showing', type: 'hana:start' },
      { state: 'visible', type: 'hana:complete' },
    ],
    immediate: { animations: 0, sameRun: true, state: 'showing' },
    markStyles: {
      circle: [
        { dasharray: '1', dashoffset: '0' },
        { dasharray: '1', dashoffset: '0' },
      ],
      highlight: [{ clipPath: 'inset(0px 0% 0px 0px)' }],
      underline: [{ dasharray: '1', dashoffset: '0' }],
    },
    pathCount: 4,
    sameRun: true,
    state: 'visible',
    visible: 3,
  });
});

test('synchronous reentrant listeners and trigger cleanup failure stay contained', async ({ page }) => {
  const output = await page.evaluate(async () => {
    class FailingIntersectionObserver {
      static instances = [];

      constructor(callback) {
        Object.assign(this, {
          callback,
          disconnects: 0,
          failCleanup: false,
          target: null,
          unobserved: 0,
        });
        FailingIntersectionObserver.instances.push(this);
      }

      observe(target) { this.target = target; }

      unobserve() {
        this.unobserved += 1;
        if (this.failCleanup) throw new Error('group observer cleanup failed');
      }

      disconnect() { this.disconnects += 1; }

      enter() {
        this.callback([{
          intersectionRatio: 1,
          isIntersecting: true,
          target: this.target,
        }], this);
      }
    }
    window.IntersectionObserver = FailingIntersectionObserver;
    const { group } = await import('/src/group.js');
    const first = document.querySelector('#group-first');

    const reentrantEvents = [];
    let reentrant;
    first.addEventListener('hana:start', (event) => {
      if (event.detail.controller !== reentrant) return;
      reentrantEvents.push('start');
      reentrant.destroy();
    });
    first.addEventListener('hana:complete', (event) => {
      if (event.detail.controller === reentrant) reentrantEvents.push('complete');
    });
    reentrant = group([
      { target: '#group-first', mark: 'underline' },
      { target: '#group-second', mark: 'circle' },
      { target: '#group-third', mark: 'highlight' },
    ], { trigger: 'viewport', motion: 'never' });
    const reentrantObserver = FailingIntersectionObserver.instances[0];
    reentrantObserver.enter();
    reentrantObserver.enter();
    await Promise.resolve();

    const completeEvents = [];
    let completeReentrant;
    first.addEventListener('hana:start', (event) => {
      if (event.detail.controller === completeReentrant) completeEvents.push('start');
    });
    first.addEventListener('hana:complete', (event) => {
      if (event.detail.controller !== completeReentrant) return;
      completeEvents.push('complete');
      if (completeEvents.filter((type) => type === 'complete').length === 1) {
        completeReentrant.replay();
      }
    });
    completeReentrant = group([
      { target: '#group-first', mark: 'underline' },
      { target: '#group-second', mark: 'circle' },
      { target: '#group-third', mark: 'highlight' },
    ], { motion: 'never' });
    completeReentrant.show();
    const initialCompleteRun = completeReentrant.finished;
    await initialCompleteRun;
    const replayedCompleteRun = completeReentrant.finished;
    await replayedCompleteRun;
    const completeReentry = {
      events: completeEvents,
      freshRun: replayedCompleteRun !== initialCompleteRun,
      state: completeReentrant.state,
    };
    completeReentrant.destroy();

    const cleanupErrors = [];
    let cleanup;
    first.addEventListener('hana:error', (event) => {
      if (event.detail.controller === cleanup) {
        cleanupErrors.push({
          cause: event.detail.error.details?.cause?.message,
          code: event.detail.error.code,
        });
      }
    });
    cleanup = group([
      { target: '#group-first', mark: 'underline' },
      { target: '#group-second', mark: 'circle' },
    ], { trigger: 'viewport', motion: 'never' });
    const cleanupObserver = FailingIntersectionObserver.instances[1];
    cleanupObserver.failCleanup = true;
    cleanup.destroy();
    cleanupObserver.enter();
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    return {
      cleanup: {
        disconnects: cleanupObserver.disconnects,
        errors: cleanupErrors,
        state: cleanup.state,
        unobserved: cleanupObserver.unobserved,
      },
      completeReentry,
      final: {
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
        owned: document.querySelectorAll('[data-hana-id]').length,
      },
      reentrant: {
        disconnects: reentrantObserver.disconnects,
        events: reentrantEvents,
        state: reentrant.state,
        unobserved: reentrantObserver.unobserved,
      },
      unhandled: window.__groupUnhandled,
    };
  });

  expect(output).toEqual({
    cleanup: {
      disconnects: 1,
      errors: [{
        cause: 'group observer cleanup failed',
        code: 'HANA_STATE_RUNTIME',
      }],
      state: 'destroyed',
      unobserved: 1,
    },
    completeReentry: {
      events: ['start', 'complete', 'start', 'complete'],
      freshRun: true,
      state: 'visible',
    },
    final: { overlays: 0, owned: 0 },
    reentrant: {
      disconnects: 1,
      events: ['start'],
      state: 'destroyed',
      unobserved: 1,
    },
    unhandled: [],
  });
  expect(await drainBrowserFailures(page)).toEqual({
    pageErrors: [],
    unhandled: [],
  });
});

test('live target loss after completion suspends once and hides every member', async ({ page }) => {
  await page.evaluate(async () => {
    const { group } = await import('/src/group.js');
    const errors = [];
    let controller;
    document.body.addEventListener('hana:error', (event) => {
      if (event.detail.controller !== controller) return;
      errors.push({
        code: event.detail.error.code,
        index: event.detail.index,
        memberCode: event.detail.error.details?.error?.code,
      });
    });
    controller = group([
      { target: '#group-first', mark: 'underline' },
      { target: '#group-second', mark: 'circle' },
    ], { motion: 'never' });
    controller.show();
    await controller.finished;
    window.groupController = controller;
    window.groupErrors = errors;
    document.querySelector('#group-second').remove();
  });

  await page.waitForFunction(() => window.groupController.state === 'suspended');
  expect(await page.evaluate(() => ({
    state: window.groupController.state,
    errors: window.groupErrors,
    visibleMarks: document.querySelectorAll('.hana-annotation:not([hidden])').length,
  }))).toEqual({
    state: 'suspended',
    errors: [{
      code: 'HANA_STATE_GROUP_MEMBER',
      index: 1,
      memberCode: 'HANA_TARGET_MISSING',
    }],
    visibleMarks: 0,
  });
  expect(await drainBrowserFailures(page)).toEqual({
    pageErrors: [],
    unhandled: [],
  });
  await page.evaluate(() => window.groupController.destroy());
});

test('asynchronous member failure during refresh is captured by the refresh coordinator', async ({ page }) => {
  await page.evaluate(async () => {
    const { group } = await import('/src/group.js');
    const errors = [];
    let controller;
    document.body.addEventListener('hana:error', (event) => {
      if (event.detail.controller !== controller) return;
      errors.push({ code: event.detail.error.code, index: event.detail.index });
    });
    controller = group([
      { target: '#group-first', mark: 'underline' },
      { target: '#group-second', mark: 'circle' },
    ], { motion: 'never' });
    controller.show();
    await controller.finished;
    controller.refresh();
    document.querySelector('#group-second').remove();
    window.groupController = controller;
    window.groupErrors = errors;
  });

  await page.waitForFunction(() => window.groupController.state === 'suspended');
  expect(await page.evaluate(() => ({
    state: window.groupController.state,
    errors: window.groupErrors,
    visibleMarks: document.querySelectorAll('.hana-annotation:not([hidden])').length,
  }))).toEqual({
    state: 'suspended',
    errors: [{ code: 'HANA_STATE_GROUP_MEMBER', index: 1 }],
    visibleMarks: 0,
  });
  expect(await drainBrowserFailures(page)).toEqual({
    pageErrors: [],
    unhandled: [],
  });
  await page.evaluate(() => window.groupController.destroy());
});

test('viewport trigger follows a replacement first selector target before entry', async ({ page }) => {
  await page.evaluate(async () => {
    const { group } = await import('/src/group.js');
    const starts = [];
    let controller;
    document.body.addEventListener('hana:start', (event) => {
      if (event.detail.controller !== controller) return;
      starts.push(event.target.dataset.replacement === 'true');
    });
    controller = group([
      { target: '#viewport-first', mark: 'underline' },
      { target: '#group-second', mark: 'circle' },
    ], { trigger: 'viewport', motion: 'never' });
    const original = document.querySelector('#viewport-first');
    const replacement = document.createElement('p');
    replacement.id = 'viewport-first';
    replacement.className = 'target';
    replacement.dataset.replacement = 'true';
    replacement.textContent = 'Replacement viewport target';
    original.remove();
    document.querySelector('#replacement-slot').append(replacement);
    window.groupController = controller;
    window.groupStarts = starts;
  });

  await page.waitForFunction(() => window.groupController.state === 'visible');
  expect(await page.evaluate(() => {
    const visible = {
      state: window.groupController.state,
      starts: window.groupStarts,
      visibleMarks: document.querySelectorAll('.hana-annotation:not([hidden])').length,
    };
    window.groupController.destroy();
    return {
      afterDestroy: {
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
        owned: document.querySelectorAll('[data-hana-id]').length,
        visibleMarks: document.querySelectorAll('.hana-annotation:not([hidden])').length,
      },
      visible,
    };
  })).toEqual({
    afterDestroy: { overlays: 0, owned: 0, visibleMarks: 0 },
    visible: {
      state: 'visible',
      starts: [true],
      visibleMarks: 2,
    },
  });
});

test('viewport replacement observer install failure suspends once and cleans the old observer', async ({ page }) => {
  await page.evaluate(async () => {
    class FailingIntersectionObserver {
      static attempts = 0;

      static instances = [];

      constructor() {
        FailingIntersectionObserver.attempts += 1;
        if (FailingIntersectionObserver.attempts === 2) {
          throw new Error('replacement observer install failed');
        }
        this.active = false;
        FailingIntersectionObserver.instances.push(this);
      }

      observe(target) {
        this.target = target;
        this.active = true;
      }

      unobserve(target) {
        if (target === this.target) this.active = false;
      }

      disconnect() {
        this.active = false;
      }
    }

    window.IntersectionObserver = FailingIntersectionObserver;
    const { group } = await import('/src/group.js');
    const errors = [];
    let controller;
    document.body.addEventListener('hana:error', (event) => {
      if (event.detail.controller !== controller) return;
      errors.push({
        code: event.detail.error.code,
        index: event.detail.index,
        cause: event.detail.error.details?.cause?.message,
      });
    });
    controller = group([
      { target: '#viewport-first', mark: 'underline' },
      { target: '#group-second', mark: 'circle' },
    ], { trigger: 'viewport', motion: 'never' });
    const original = document.querySelector('#viewport-first');
    const replacement = document.createElement('p');
    replacement.id = 'viewport-first';
    replacement.className = 'target';
    replacement.textContent = 'Replacement viewport target';
    original.remove();
    document.querySelector('#replacement-slot').append(replacement);
    window.groupController = controller;
    window.groupErrors = errors;
    window.groupIntersectionObserver = FailingIntersectionObserver;
  });

  await page.waitForFunction(() => window.groupController.state === 'suspended');
  expect(await page.evaluate(() => ({
    state: window.groupController.state,
    errors: window.groupErrors,
    attempts: window.groupIntersectionObserver.attempts,
    activeObservers: window.groupIntersectionObserver.instances
      .filter(({ active }) => active).length,
  }))).toEqual({
    state: 'suspended',
    errors: [{
      code: 'HANA_STATE_RUNTIME',
      index: undefined,
      cause: 'replacement observer install failed',
    }],
    attempts: 2,
    activeObservers: 0,
  });
  expect(await drainBrowserFailures(page)).toEqual({
    pageErrors: [],
    unhandled: [],
  });
  await page.evaluate(() => window.groupController.destroy());
});
