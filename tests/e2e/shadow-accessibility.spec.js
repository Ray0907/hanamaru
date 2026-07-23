import { expect, test } from '@playwright/test';

const browserErrors = new WeakMap();

async function installFixture(page) {
  await page.addStyleTag({ url: '/src/hanamaru.css' });
  await page.evaluate(() => {
    window.__shadowAccessibilityUnhandled = [];
    window.addEventListener('unhandledrejection', (event) => {
      window.__shadowAccessibilityUnhandled.push(String(event.reason));
    });

    const createRoot = (hostId, targetId, label) => {
      const host = document.querySelector(hostId);
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <section class="component">
          <button id="${targetId}" aria-describedby="author-${targetId}">
            ${label}
          </button>
        </section>
      `;
      return { host, root, target: root.querySelector(`#${targetId}`) };
    };

    window.__shadowAccessibility = {
      first: createRoot('#open-host', 'first-target', 'First target'),
      second: createRoot('#other-host', 'second-target', 'Second target'),
    };
  });
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/tests/fixtures/shadow.html');
  await installFixture(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
  expect(await page.evaluate(() => window.__shadowAccessibilityUnhandled)).toEqual([]);
});

test('meaningful scoped notes own one in-root mirror and hide the ordinary visual note', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const fixture = window.__shadowAccessibility.first;
    const scope = createShadowScope(fixture.root);
    const controller = scope.annotate(fixture.target, {
      mark: 'circle',
      note: 'An in-root accessible description',
      accessible: true,
      duration: 0,
    });
    controller.show();
    await controller.finished;
    const mirror = fixture.root.querySelector('[data-hana-shadow-mirror]');
    const visual = document.querySelector('[data-hana-shadow-overlay] [data-hana-note]');
    const beforeDestroy = {
      mirrorCount: fixture.root.querySelectorAll('[data-hana-shadow-mirror]').length,
      mirrorText: mirror?.textContent,
      mirrorRoot: mirror?.getRootNode() === fixture.root,
      describedBy: fixture.target.getAttribute('aria-describedby'),
      visualAriaHidden: visual?.getAttribute('aria-hidden'),
      visualRole: visual?.getAttribute('role'),
      visualTabindex: visual?.getAttribute('tabindex'),
      visualOutsideRoot: visual?.getRootNode() === document,
    };
    controller.destroy();
    const afterController = {
      mirrorCount: fixture.root.querySelectorAll('[data-hana-shadow-mirror]').length,
      describedBy: fixture.target.getAttribute('aria-describedby'),
      visualCount: document.querySelectorAll(
        '[data-hana-shadow-overlay] [data-hana-note]',
      ).length,
    };
    scope.destroy();
    return { beforeDestroy, afterController };
  });

  expect(result.beforeDestroy).toMatchObject({
    mirrorCount: 1,
    mirrorText: 'An in-root accessible description',
    mirrorRoot: true,
    describedBy: expect.stringMatching(/^author-first-target hana-shadow-root-\d+-mirror-\d+$/u),
    visualAriaHidden: 'true',
    visualRole: null,
    visualTabindex: null,
    visualOutsideRoot: true,
  });
  expect(result.afterController).toEqual({
    mirrorCount: 0,
    describedBy: 'author-first-target',
    visualCount: 0,
  });
});

test('mirrors stay unique across roots and updates preserve author description tokens', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const { first, second } = window.__shadowAccessibility;
    const firstScope = createShadowScope(first.root);
    const secondScope = createShadowScope(second.root);
    const firstController = firstScope.annotate(first.target, {
      mark: 'underline',
      note: 'First description',
      accessible: true,
      duration: 0,
    });
    const secondController = secondScope.annotate(second.target, {
      mark: 'box',
      note: 'Second description',
      accessible: true,
      duration: 0,
    });
    firstController.show();
    secondController.show();
    await Promise.all([firstController.finished, secondController.finished]);
    const firstBefore = first.root.querySelector('[data-hana-shadow-mirror]');
    const secondMirror = second.root.querySelector('[data-hana-shadow-mirror]');
    first.target.setAttribute(
      'aria-describedby',
      `${first.target.getAttribute('aria-describedby')} author-late`,
    );
    firstController.update({ note: 'Updated first description' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const firstAfter = first.root.querySelector('[data-hana-shadow-mirror]');
    const beforeDestroy = {
      ids: [firstAfter?.id, secondMirror?.id],
      unique: firstAfter?.id !== secondMirror?.id,
      firstText: firstAfter?.textContent,
      firstCount: first.root.querySelectorAll('[data-hana-shadow-mirror]').length,
      firstTokens: first.target.getAttribute('aria-describedby'),
      noCrossRoot: first.root.getElementById(secondMirror?.id) === null
        && second.root.getElementById(firstAfter?.id) === null,
      replacedMirror: firstBefore !== firstAfter,
    };
    firstController.destroy();
    const afterFirst = {
      firstTokens: first.target.getAttribute('aria-describedby'),
      secondToken: second.target.getAttribute('aria-describedby'),
      secondConnected: secondMirror?.isConnected,
    };
    secondController.destroy();
    firstScope.destroy();
    secondScope.destroy();
    return {
      beforeDestroy,
      afterFirst,
      secondAfter: second.target.getAttribute('aria-describedby'),
    };
  });

  expect(result.beforeDestroy).toMatchObject({
    ids: [
      expect.stringMatching(/^hana-shadow-root-\d+-mirror-\d+$/u),
      expect.stringMatching(/^hana-shadow-root-\d+-mirror-\d+$/u),
    ],
    unique: true,
    firstText: 'Updated first description',
    firstCount: 1,
    firstTokens: expect.stringMatching(
      /^author-first-target author-late hana-shadow-root-\d+-mirror-\d+$/u,
    ),
    noCrossRoot: true,
    replacedMirror: true,
  });
  expect(result.afterFirst).toMatchObject({
    firstTokens: 'author-first-target author-late',
    secondToken: expect.stringMatching(
      /^author-second-target hana-shadow-root-\d+-mirror-\d+$/u,
    ),
    secondConnected: true,
  });
  expect(result.secondAfter).toBe('author-second-target');
});

test('stable mirror text does not create a self-sustaining mutation reflow loop', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const fixture = window.__shadowAccessibility.first;
    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(fixture.root, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    const scope = createShadowScope(fixture.root);
    const controller = scope.annotate(fixture.target, {
      mark: 'circle',
      note: 'Stable mirror description',
      accessible: true,
      duration: 0,
    });
    controller.show();
    await controller.finished;
    const frames = (count) => new Promise((resolve) => {
      const next = () => {
        if (count === 0) {
          resolve();
          return;
        }
        count -= 1;
        requestAnimationFrame(next);
      };
      next();
    });
    await frames(4);
    const settled = mutations;
    await frames(4);
    const later = mutations;
    observer.disconnect();
    scope.destroy();
    return { settled, later };
  });

  expect(result.settled).toBeGreaterThan(0);
  expect(result.later).toBe(result.settled);
});

test('decorative scoped notes create no mirror, role, tab stop, or owner token', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const fixture = window.__shadowAccessibility.first;
    const scope = createShadowScope(fixture.root);
    const controller = scope.annotate(fixture.target, {
      mark: 'bracket',
      note: 'Purely decorative',
      accessible: false,
      duration: 0,
    });
    controller.show();
    await controller.finished;
    const visual = document.querySelector('[data-hana-shadow-overlay] [data-hana-note]');
    const output = {
      mirrors: fixture.root.querySelectorAll('[data-hana-shadow-mirror]').length,
      describedBy: fixture.target.getAttribute('aria-describedby'),
      ariaHidden: visual?.getAttribute('aria-hidden'),
      role: visual?.getAttribute('role'),
      tabindex: visual?.getAttribute('tabindex'),
    };
    scope.destroy();
    return output;
  });

  expect(result).toEqual({
    mirrors: 0,
    describedBy: 'author-first-target',
    ariaHidden: 'true',
    role: null,
    tabindex: null,
  });
});

test('scoped lifecycle events bubble composed through the host', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const fixture = window.__shadowAccessibility.first;
    const observed = [];
    const listen = (event) => {
      observed.push({
        type: event.type,
        bubbles: event.bubbles,
        composed: event.composed,
        targetIsHost: event.target === fixture.host,
      });
    };
    for (const type of ['hana:start', 'hana:complete']) {
      document.addEventListener(type, listen);
    }
    const scope = createShadowScope(fixture.root);
    const controller = scope.annotate(fixture.target, {
      mark: 'underline',
      note: 'Composed event',
      accessible: true,
      duration: 0,
    });
    controller.show();
    await controller.finished;
    for (const type of ['hana:start', 'hana:complete']) {
      document.removeEventListener(type, listen);
    }
    scope.destroy();
    return observed;
  });

  expect(result).toEqual([
    { type: 'hana:start', bubbles: true, composed: true, targetIsHost: true },
    { type: 'hana:complete', bubbles: true, composed: true, targetIsHost: true },
  ]);
});

test('overflowing accessible note is keyboard focusable and defers hiding while focused', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const fixture = window.__shadowAccessibility.first;
    const scope = createShadowScope(fixture.root);
    const controller = scope.annotate(fixture.target, {
      mark: 'box',
      note: 'Reachable explanation. '.repeat(10),
      accessible: true,
      duration: 0,
    });
    controller.show();
    await controller.finished;
    const note = document.querySelector('[data-hana-shadow-overlay] [data-hana-note]');
    note.style.width = '150px';
    note.style.maxHeight = '48px';
    controller.refresh();
    window.__overflowFixture = { controller, note, scope };
  });
  await settle(page);

  const note = page.locator('[data-hana-shadow-overlay] [data-hana-note]');
  await expect(note).toHaveAttribute('role', 'note');
  await expect(note).toHaveAttribute('tabindex', '0');
  await expect(note).not.toHaveAttribute('aria-hidden', 'true');
  expect(await note.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);

  await note.focus();
  await expect(note).toBeFocused();
  await page.keyboard.press('PageDown');
  expect(await note.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);

  await page.evaluate(() => {
    const { controller, note: visual } = window.__overflowFixture;
    visual.style.maxHeight = '600px';
    controller.refresh();
  });
  await settle(page);
  await expect(note).toBeFocused();
  await expect(note).toHaveAttribute('role', 'note');
  await expect(note).toHaveAttribute('tabindex', '0');
  await expect(note).not.toHaveAttribute('aria-hidden', 'true');

  await page.evaluate(() => window.__overflowFixture.note.blur());
  await settle(page);
  await expect(note).toHaveAttribute('aria-hidden', 'true');
  await expect(note).not.toHaveAttribute('role', 'note');
  await expect(note).not.toHaveAttribute('tabindex', '0');

  await page.evaluate(() => window.__overflowFixture.scope.destroy());
});

test('overflow returning before focused note blur keeps it exposed and focusable', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const fixture = window.__shadowAccessibility.first;
    const scope = createShadowScope(fixture.root);
    const controller = scope.annotate(fixture.target, {
      mark: 'circle',
      note: 'Overflow state '.repeat(15),
      accessible: true,
      duration: 0,
    });
    controller.show();
    await controller.finished;
    const note = document.querySelector('[data-hana-shadow-overlay] [data-hana-note]');
    note.style.cssText += ';width:140px;max-height:44px';
    controller.refresh();
    window.__overflowReturn = { controller, note, scope };
  });
  await settle(page);
  const note = page.locator('[data-hana-shadow-overlay] [data-hana-note]');
  await note.focus();

  await page.evaluate(() => {
    const { controller, note: visual } = window.__overflowReturn;
    visual.style.maxHeight = '600px';
    controller.refresh();
  });
  await settle(page);
  await expect(note).toBeFocused();
  await expect(note).not.toHaveAttribute('aria-hidden', 'true');

  await page.evaluate(() => {
    const { controller, note: visual } = window.__overflowReturn;
    visual.style.maxHeight = '44px';
    controller.refresh();
  });
  await settle(page);
  await page.evaluate(() => window.__overflowReturn.note.blur());
  await settle(page);

  await expect(note).toHaveAttribute('role', 'note');
  await expect(note).toHaveAttribute('tabindex', '0');
  await expect(note).not.toHaveAttribute('aria-hidden', 'true');
  expect(await note.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await page.evaluate(() => window.__overflowReturn.controller.hide());
  await expect(note).toHaveAttribute('aria-hidden', 'true');
  await expect(note).not.toHaveAttribute('role', 'note');
  await expect(note).not.toHaveAttribute('tabindex', '0');
  expect(await page.evaluate(() => ({
    describedBy: window.__shadowAccessibility.first.target.getAttribute('aria-describedby'),
    mirrors: window.__shadowAccessibility.first.root.querySelectorAll(
      '[data-hana-shadow-mirror]',
    ).length,
  }))).toEqual({
    describedBy: 'author-first-target',
    mirrors: 0,
  });
  await page.evaluate(() => window.__overflowReturn.scope.destroy());
});

test('horizontal overflow also exposes the bounded note as a focus target', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const fixture = window.__shadowAccessibility.first;
    const scope = createShadowScope(fixture.root);
    const controller = scope.annotate(fixture.target, {
      mark: 'underline',
      note: 'Horizontal overflow remains keyboard reachable.',
      accessible: true,
      duration: 0,
    });
    controller.show();
    await controller.finished;
    const note = document.querySelector('[data-hana-shadow-overlay] [data-hana-note]');
    note.style.cssText += [
      'width:80px',
      'max-width:80px',
      'max-height:600px',
      'white-space:nowrap',
    ].join(';');
    controller.refresh();
    window.__horizontalOverflow = { note, scope };
  });
  await settle(page);
  const note = page.locator('[data-hana-shadow-overlay] [data-hana-note]');
  expect(await note.evaluate((node) => ({
    horizontal: node.scrollWidth > node.clientWidth,
    vertical: node.scrollHeight > node.clientHeight,
  }))).toEqual({
    horizontal: true,
    vertical: false,
  });
  await expect(note).toHaveAttribute('role', 'note');
  await expect(note).toHaveAttribute('tabindex', '0');
  await expect(note).not.toHaveAttribute('aria-hidden', 'true');
  await page.evaluate(() => window.__horizontalOverflow.scope.destroy());
});

test('target and host theme values bridge to owned output with per-root z-index', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const { first, second } = window.__shadowAccessibility;
    const theme = {
      '--hana-color': 'rgb(18 52 86)',
      '--hana-mark-color': 'rgb(98 76 54)',
      '--hana-highlight-color': 'rgb(210 180 40 / 45%)',
      '--hana-note-background': 'rgb(250 245 230)',
      '--hana-note-color': 'rgb(31 41 55)',
      '--hana-stroke-width': '6px',
      '--hana-padding': '9px 13px',
      '--hana-note-gap': '27px',
      '--hana-font': '700 17px/1.4 monospace',
      '--hana-duration': '123ms',
    };
    for (const [name, value] of Object.entries(theme)) {
      first.host.style.setProperty(name, value);
    }
    first.target.style.setProperty('--hana-color', 'rgb(12 120 90)');
    first.host.style.setProperty('--hana-z-index', '1401');
    second.host.style.setProperty('--hana-z-index', '2402');
    second.host.style.setProperty('--hana-color', 'rgb(150 40 80)');

    const firstScope = createShadowScope(first.root);
    const secondScope = createShadowScope(second.root);
    const firstController = firstScope.annotate(first.target, {
      mark: 'circle',
      note: 'First themed note',
      accessible: true,
      duration: 0,
    });
    const secondController = secondScope.annotate(second.target, {
      mark: 'underline',
      note: 'Second themed note',
      accessible: true,
      duration: 0,
    });
    firstController.show();
    secondController.show();
    await Promise.all([firstController.finished, secondController.finished]);
    const portals = [...document.querySelectorAll('[data-hana-shadow-overlay]')];
    const firstGroup = portals[0].querySelector('.hana-annotation');
    const firstNote = portals[0].querySelector('.hana-note');
    const secondGroup = portals[1].querySelector('.hana-annotation');
    const readInline = (node) => Object.fromEntries(
      [...Object.keys(theme)].map((name) => [name, node.style.getPropertyValue(name)]),
    );
    const output = {
      firstGroup: readInline(firstGroup),
      firstNote: readInline(firstNote),
      firstPathStroke: getComputedStyle(
        firstGroup.querySelector('.hana-mark-path'),
      ).stroke,
      firstPortalZ: portals[0].style.zIndex,
      secondColor: secondGroup.style.getPropertyValue('--hana-color'),
      secondPortalZ: portals[1].style.zIndex,
    };
    firstScope.destroy();
    secondScope.destroy();
    return { output, expected: { ...theme, '--hana-color': 'rgb(12 120 90)' } };
  });

  expect(result.output.firstGroup).toEqual(result.expected);
  expect(result.output.firstNote).toEqual(result.expected);
  expect(result.output.firstPathStroke).toBe('rgb(98, 76, 54)');
  expect(result.output.firstPortalZ).toBe('1401');
  expect(result.output.secondColor).toBe('rgb(150 40 80)');
  expect(result.output.secondPortalZ).toBe('2402');
});

test('transformed contained clipped host keeps viewport geometry outside its clip without page overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const fixture = window.__shadowAccessibility.first;
    fixture.host.style.cssText = [
      'position:absolute',
      'left:210px',
      'top:150px',
      'width:130px',
      'height:72px',
      'overflow:hidden',
      'contain:paint',
      'transform:translate(45px, 35px)',
    ].join(';');
    fixture.target.style.margin = '22px 0 0 28px';
    const scope = createShadowScope(fixture.root);
    const controller = scope.annotate(fixture.target, {
      mark: 'box',
      note: 'The note escapes the component clip',
      placement: 'right',
      accessible: true,
      duration: 0,
    });
    controller.show();
    await controller.finished;
    const portal = document.querySelector('[data-hana-shadow-overlay]');
    const group = portal.querySelector('.hana-annotation');
    const note = portal.querySelector('.hana-note');
    const copy = (rect) => ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    });
    const targetRect = copy(fixture.target.getBoundingClientRect());
    const hostRect = copy(fixture.host.getBoundingClientRect());
    const noteRect = copy(note.getBoundingClientRect());
    const markBox = group.getBBox();
    const markRect = {
      left: markBox.x,
      top: markBox.y,
      right: markBox.x + markBox.width,
      bottom: markBox.y + markBox.height,
      width: markBox.width,
      height: markBox.height,
    };
    const overlayRect = copy(portal.getBoundingClientRect());
    const output = {
      portalParent: portal.parentNode === document.body,
      hostContainsPortal: fixture.host.contains(portal),
      targetRect,
      hostRect,
      noteRect,
      markRect,
      overlayRect,
      noteEscapesHost: noteRect.right > hostRect.right || noteRect.bottom > hostRect.bottom,
      pageOverflow: {
        width: document.documentElement.scrollWidth - innerWidth,
        height: document.documentElement.scrollHeight - innerHeight,
      },
    };
    scope.destroy();
    return output;
  });

  expect(result.portalParent).toBe(true);
  expect(result.hostContainsPortal).toBe(false);
  expect(result.noteEscapesHost).toBe(true);
  expect(result.overlayRect).toMatchObject({
    left: 0,
    top: 0,
    width: 900,
    height: 700,
  });
  expect(Math.abs(result.markRect.left - result.targetRect.left)).toBeLessThan(12);
  expect(Math.abs(result.markRect.top - result.targetRect.top)).toBeLessThan(12);
  expect(result.noteRect.left).toBeGreaterThanOrEqual(12);
  expect(result.noteRect.top).toBeGreaterThanOrEqual(12);
  expect(result.noteRect.right).toBeLessThanOrEqual(888);
  expect(result.noteRect.bottom).toBeLessThanOrEqual(688);
  expect(result.pageOverflow.width).toBeLessThanOrEqual(0);
  expect(result.pageOverflow.height).toBeLessThanOrEqual(0);
});

test('root mutations, host scrolling, resize, and visual viewport signals reflow only affected roots', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const { first, second } = window.__shadowAccessibility;
    first.host.style.cssText = [
      'position:absolute',
      'left:30px',
      'top:80px',
      'width:240px',
      'height:100px',
      'overflow:auto',
    ].join(';');
    first.root.querySelector('.component').style.cssText = 'width:800px;height:180px';
    first.target.style.cssText = 'margin-left:420px;width:100px';
    second.host.style.cssText = 'position:absolute;left:650px;top:90px';

    const firstScope = createShadowScope(first.root);
    const secondScope = createShadowScope(second.root);
    const firstController = firstScope.annotate(first.target, {
      mark: 'box', note: null, duration: 0,
    });
    const secondController = secondScope.annotate(second.target, {
      mark: 'box', note: null, duration: 0,
    });
    firstController.show();
    secondController.show();
    await Promise.all([firstController.finished, secondController.finished]);
    const [firstPortal, secondPortal] = [
      ...document.querySelectorAll('[data-hana-shadow-overlay]'),
    ];
    const firstGroup = firstPortal.querySelector('.hana-annotation');
    const secondGroup = secondPortal.querySelector('.hana-annotation');
    const snapshot = () => ({
      first: firstGroup.getBBox().x,
      second: secondGroup.getBBox().x,
    });
    const frames = () => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const initial = snapshot();

    first.host.scrollLeft = 150;
    first.host.dispatchEvent(new Event('scroll'));
    await frames();
    const afterScroll = snapshot();

    first.target.style.marginTop = '34px';
    await frames();
    const afterMutation = {
      ...snapshot(),
      top: firstGroup.getBBox().y,
    };

    first.host.style.setProperty('--hana-color', 'rgb(20 110 70)');
    await frames();
    const afterHostTheme = {
      first: firstGroup.style.getPropertyValue('--hana-color'),
      second: secondGroup.style.getPropertyValue('--hana-color'),
    };

    const nativeRect = first.target.getBoundingClientRect.bind(first.target);
    let viewportShift = 0;
    first.target.getBoundingClientRect = () => {
      const rect = nativeRect();
      return new DOMRect(
        rect.x + viewportShift,
        rect.y,
        rect.width,
        rect.height,
      );
    };
    viewportShift = 35;
    visualViewport.dispatchEvent(new Event('resize'));
    await frames();
    const afterViewport = snapshot();

    first.target.style.width = '155px';
    await frames();
    const afterResize = {
      firstWidth: firstGroup.getBBox().width,
      secondWidth: secondGroup.getBBox().width,
    };
    firstScope.destroy();
    secondScope.destroy();
    return {
      initial,
      afterScroll,
      afterMutation,
      afterHostTheme,
      afterViewport,
      afterResize,
    };
  });

  expect(result.afterScroll.first).toBeLessThan(result.initial.first - 100);
  expect(result.afterScroll.second).toBeCloseTo(result.initial.second, 4);
  expect(result.afterMutation.top).toBeGreaterThan(100);
  expect(result.afterMutation.second).toBeCloseTo(result.initial.second, 4);
  expect(result.afterHostTheme).toEqual({
    first: 'rgb(20 110 70)',
    second: '',
  });
  expect(result.afterViewport.first).toBeGreaterThan(result.afterMutation.first + 25);
  expect(result.afterViewport.second).toBeCloseTo(result.initial.second, 4);
  expect(result.afterResize.firstWidth).toBeGreaterThan(145);
  expect(result.afterResize.secondWidth).toBeLessThan(140);
});

test('scoped layout observes the shadow host as a scroll and resize dependency', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const fixture = window.__shadowAccessibility.first;
    fixture.host.style.cssText = 'width:180px;height:80px;overflow:auto';
    fixture.root.querySelector('.component').style.width = '600px';
    const nativeAdd = EventTarget.prototype.addEventListener;
    const NativeResizeObserver = ResizeObserver;
    const scrollTargets = [];
    const resizeTargets = [];
    EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
      if (type === 'scroll') scrollTargets.push(this);
      return nativeAdd.call(this, type, listener, options);
    };
    window.ResizeObserver = class TrackingResizeObserver {
      constructor(callback) {
        this.native = new NativeResizeObserver(callback);
      }

      observe(target) {
        resizeTargets.push(target);
        this.native.observe(target);
      }

      unobserve(target) {
        this.native.unobserve(target);
      }

      disconnect() {
        this.native.disconnect();
      }
    };
    try {
      const { createShadowScope } = await import('/src/shadow.js');
      const scope = createShadowScope(fixture.root);
      const controller = scope.annotate(fixture.target, {
        mark: 'underline', note: null, duration: 0,
      });
      controller.show();
      await controller.finished;
      const output = {
        hostScroll: scrollTargets.includes(fixture.host),
        hostResize: resizeTargets.includes(fixture.host),
        targetResize: resizeTargets.includes(fixture.target),
      };
      scope.destroy();
      return output;
    } finally {
      EventTarget.prototype.addEventListener = nativeAdd;
      window.ResizeObserver = NativeResizeObserver;
    }
  });

  expect(result).toEqual({
    hostScroll: true,
    hostResize: true,
    targetResize: true,
  });
});

test('authenticated host snapshot survives a poisoned ShadowRoot host during reflow', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const fixture = window.__shadowAccessibility.first;
    const scope = createShadowScope(fixture.root);
    const controller = scope.annotate(fixture.target, {
      mark: 'circle', note: 'Authenticated host', accessible: true, duration: 0,
    });
    controller.show();
    await controller.finished;
    let hostReads = 0;
    Object.defineProperty(fixture.root, 'host', {
      configurable: true,
      get() {
        hostReads += 1;
        throw new Error('poisoned ShadowRoot.host');
      },
    });
    fixture.target.style.marginLeft = '24px';
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const output = {
      hostReads,
      state: controller.state,
      visible: !document.querySelector('.hana-annotation').hasAttribute('hidden'),
    };
    delete fixture.root.host;
    scope.destroy();
    return output;
  });

  expect(result).toEqual({
    hostReads: 0,
    state: 'visible',
    visible: true,
  });
});

test('reduced motion scoped output reaches final geometry without active animations', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const fixture = window.__shadowAccessibility.first;
    const scope = createShadowScope(fixture.root);
    const controller = scope.annotate(fixture.target, {
      mark: 'highlight',
      note: 'Reduced motion note',
      accessible: true,
      duration: 900,
    });
    controller.show();
    await controller.finished;
    const portal = document.querySelector('[data-hana-shadow-overlay]');
    const output = {
      media: matchMedia('(prefers-reduced-motion: reduce)').matches,
      state: controller.state,
      animations: portal.getAnimations({ subtree: true }).length,
      motionClasses: portal.querySelectorAll('.hana-is-animating, .hana-is-paused').length,
      visibleGroups: portal.querySelectorAll('.hana-annotation:not([hidden])').length,
      visibleNotes: portal.querySelectorAll('.hana-note:not(.hana-is-hidden)').length,
    };
    scope.destroy();
    return output;
  });

  expect(result).toEqual({
    media: true,
    state: 'visible',
    animations: 0,
    motionClasses: 0,
    visibleGroups: 1,
    visibleNotes: 1,
  });
});
