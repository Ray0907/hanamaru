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

async function prepareDeferredOverflow(page) {
  await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const fixture = window.__shadowAccessibility.first;
    const scope = createShadowScope(fixture.root);
    const controller = scope.annotate(fixture.target, {
      mark: 'box',
      note: 'Deferred overflow focus state. '.repeat(8),
      accessible: true,
      duration: 0,
    });
    controller.show();
    await controller.finished;
    const note = document.querySelector('[data-hana-shadow-overlay] [data-hana-note]');
    note.style.cssText += ';width:150px;max-height:44px';
    controller.refresh();
    window.__deferredOverflow = {
      controller,
      fixture,
      note,
      scope,
    };
  });
  await settle(page);
  await page.locator('[data-hana-shadow-overlay] [data-hana-note]').focus();
  await page.evaluate(() => {
    const { controller, note } = window.__deferredOverflow;
    note.style.maxHeight = '600px';
    controller.refresh();
  });
  await settle(page);
  await page.evaluate(() => {
    const { controller, note } = window.__deferredOverflow;
    note.style.maxHeight = '44px';
    controller.refresh();
  });
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

test('owned scoped descriptions self-heal author token replacement and removed mirrors', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const fixture = window.__shadowAccessibility.first;
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
      note: 'Self-healing accessible description',
      accessible: true,
      duration: 0,
    });
    controller.show();
    await controller.finished;

    fixture.target.setAttribute('aria-describedby', 'author-alpha author-beta');
    await frames(4);
    const afterTokenReplacement = {
      mirrors: fixture.root.querySelectorAll('[data-hana-shadow-mirror]').length,
      tokens: fixture.target.getAttribute('aria-describedby')?.split(/\s+/u),
    };

    const removedMirror = fixture.root.querySelector('[data-hana-shadow-mirror]');
    removedMirror.textContent = 'author-tampered text';
    removedMirror.remove();
    fixture.target.style.marginLeft = '1px';
    await frames(4);
    const currentMirror = fixture.root.querySelector('[data-hana-shadow-mirror]');
    const afterMirrorRemoval = {
      connected: currentMirror?.isConnected,
      inRoot: currentMirror?.getRootNode() === fixture.root,
      mirrors: fixture.root.querySelectorAll('[data-hana-shadow-mirror]').length,
      text: currentMirror?.textContent,
      tokens: fixture.target.getAttribute('aria-describedby')?.split(/\s+/u),
    };

    const settledMutations = mutations;
    await frames(4);
    const laterMutations = mutations;
    controller.destroy();
    const afterDestroy = {
      mirrors: fixture.root.querySelectorAll('[data-hana-shadow-mirror]').length,
      tokens: fixture.target.getAttribute('aria-describedby'),
    };
    observer.disconnect();
    scope.destroy();
    return {
      afterDestroy,
      afterMirrorRemoval,
      afterTokenReplacement,
      laterMutations,
      settledMutations,
    };
  });

  expect(result.afterTokenReplacement).toMatchObject({
    mirrors: 1,
    tokens: [
      'author-alpha',
      'author-beta',
      expect.stringMatching(/^hana-shadow-root-\d+-mirror-\d+$/u),
    ],
  });
  expect(result.afterMirrorRemoval).toMatchObject({
    connected: true,
    inRoot: true,
    mirrors: 1,
    text: 'Self-healing accessible description',
    tokens: [
      'author-alpha',
      'author-beta',
      expect.stringMatching(/^hana-shadow-root-\d+-mirror-\d+$/u),
    ],
  });
  expect(result.laterMutations).toBe(result.settledMutations);
  expect(result.afterDestroy).toEqual({
    mirrors: 0,
    tokens: 'author-alpha author-beta',
  });
});

test('owned scoped descriptions reconcile connected tampering and clone duplicates without layout reads', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const fixture = window.__shadowAccessibility.first;
    const frames = (count = 4) => new Promise((resolve) => {
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
    const authorContent = document.createElement('span');
    authorContent.id = 'author-content';
    authorContent.textContent = 'Author content must survive';
    fixture.root.append(authorContent);
    const scope = createShadowScope(fixture.root);
    const controller = scope.annotate(fixture.target, {
      mark: 'circle',
      note: 'Canonical owned description',
      accessible: true,
      duration: 0,
    });
    controller.show();
    await controller.finished;
    await frames();

    const initial = fixture.root.querySelector('[data-hana-shadow-mirror]');
    const ownedId = initial.id;
    const nativeRect = fixture.target.getBoundingClientRect.bind(fixture.target);
    let layoutReads = 0;
    fixture.target.getBoundingClientRect = () => {
      layoutReads += 1;
      return nativeRect();
    };
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
    const snapshot = () => {
      const mirrors = [...fixture.root.querySelectorAll('[data-hana-shadow-mirror]')];
      const canonical = mirrors.find((mirror) => mirror.id === ownedId);
      return {
        canonicalClass: canonical?.className,
        canonicalMarker: canonical?.hasAttribute('data-hana-shadow-mirror'),
        canonicalText: canonical?.textContent,
        canonicalCount: mirrors.filter((mirror) => mirror.id === ownedId).length,
        markerCount: mirrors.length,
        tokens: fixture.target.getAttribute('aria-describedby')?.split(/\s+/u),
      };
    };

    let current = initial;
    current.id = 'author-id-only-tamper';
    await frames();
    const afterId = snapshot();

    current.textContent = 'text-only tamper';
    await frames();
    const afterText = snapshot();

    current.className = 'author-class-tamper';
    current.removeAttribute('data-hana-shadow-mirror');
    await frames();
    const afterClassMarker = snapshot();

    let replacement = current.cloneNode(true);
    current.replaceWith(replacement);
    current = replacement;
    await frames();
    const afterSameIdClone = snapshot();

    const differentIdClone = current.cloneNode(true);
    differentIdClone.id = 'author-different-replacement';
    current.replaceWith(differentIdClone);
    current = differentIdClone;
    await frames();
    const afterDifferentIdClone = snapshot();

    const duplicates = document.createDocumentFragment();
    const duplicateNodes = [
      current.cloneNode(true),
      current.cloneNode(true),
      current.cloneNode(true),
    ];
    duplicates.append(...duplicateNodes);
    current.replaceWith(duplicates);
    [current] = duplicateNodes;
    await frames();
    const afterDuplicates = snapshot();

    fixture.target.setAttribute('aria-describedby', 'author-final');
    await frames();
    const afterToken = snapshot();
    const settledMutations = mutations;
    await frames();
    const laterMutations = mutations;

    controller.destroy();
    const afterDestroy = {
      authorContent: fixture.root.querySelector('#author-content')?.textContent,
      markerCount: fixture.root.querySelectorAll('[data-hana-shadow-mirror]').length,
      ownedIdCount: fixture.root.querySelectorAll(`[id="${ownedId}"]`).length,
      tokens: fixture.target.getAttribute('aria-describedby'),
    };
    observer.disconnect();
    scope.destroy();
    return {
      afterClassMarker,
      afterDestroy,
      afterDifferentIdClone,
      afterDuplicates,
      afterId,
      afterSameIdClone,
      afterText,
      afterToken,
      laterMutations,
      layoutReads,
      ownedId,
      settledMutations,
    };
  });

  const canonical = {
    canonicalClass: 'hana-shadow-mirror',
    canonicalMarker: true,
    canonicalText: 'Canonical owned description',
    canonicalCount: 1,
    markerCount: 1,
    tokens: [
      'author-first-target',
      expect.stringMatching(/^hana-shadow-root-\d+-mirror-\d+$/u),
    ],
  };
  expect(result.afterId).toEqual(canonical);
  expect(result.afterText).toEqual(canonical);
  expect(result.afterClassMarker).toEqual(canonical);
  expect(result.afterSameIdClone).toEqual(canonical);
  expect(result.afterDifferentIdClone).toEqual(canonical);
  expect(result.afterDuplicates).toEqual(canonical);
  expect(result.afterToken).toEqual({
    ...canonical,
    tokens: ['author-final', result.ownedId],
  });
  expect(result.layoutReads).toBe(0);
  expect(result.laterMutations).toBe(result.settledMutations);
  expect(result.afterDestroy).toEqual({
    authorContent: 'Author content must survive',
    markerCount: 0,
    ownedIdCount: 0,
    tokens: 'author-final',
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

test('viewport-hidden focused overflow cannot regain deferred accessibility state', async ({
  page,
}) => {
  await prepareDeferredOverflow(page);
  const note = page.locator('[data-hana-shadow-overlay] [data-hana-note]');
  await expect(note).toBeFocused();
  await page.evaluate(() => {
    const { controller, fixture } = window.__deferredOverflow;
    fixture.target.style.transform = 'translateX(2000px)';
    controller.refresh();
  });
  await settle(page);

  await expect(note).toHaveClass(/hana-is-hidden/u);
  await expect(note).toHaveAttribute('aria-hidden', 'true');
  await expect(note).not.toHaveAttribute('role', 'note');
  await expect(note).not.toHaveAttribute('tabindex', '0');
  expect(await note.evaluate((node) => node.ownerDocument.activeElement === node)).toBe(false);
  await page.evaluate(() => window.__deferredOverflow.scope.destroy());
});

test('hide cancels deferred focused-overflow blur and queued restoration', async ({
  page,
}) => {
  await prepareDeferredOverflow(page);
  const note = page.locator('[data-hana-shadow-overlay] [data-hana-note]');
  await page.evaluate(() => window.__deferredOverflow.controller.hide());
  await settle(page);

  await expect(note).toHaveClass(/hana-is-hidden/u);
  await expect(note).toHaveAttribute('aria-hidden', 'true');
  await expect(note).not.toHaveAttribute('role', 'note');
  await expect(note).not.toHaveAttribute('tabindex', '0');
  expect(await note.evaluate((node) => node.ownerDocument.activeElement === node)).toBe(false);
  await page.evaluate(() => window.__deferredOverflow.scope.destroy());
});

test('destroy cancels deferred focused-overflow work before removing its note', async ({
  page,
}) => {
  await prepareDeferredOverflow(page);
  const result = await page.evaluate(async () => {
    const { controller, fixture, note, scope } = window.__deferredOverflow;
    controller.destroy();
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const output = {
      active: document.activeElement === note,
      connected: note.isConnected,
      mirrors: fixture.root.querySelectorAll('[data-hana-shadow-mirror]').length,
      notes: document.querySelectorAll('[data-hana-shadow-overlay] [data-hana-note]').length,
      describedBy: fixture.target.getAttribute('aria-describedby'),
    };
    scope.destroy();
    return output;
  });

  expect(result).toEqual({
    active: false,
    connected: false,
    mirrors: 0,
    notes: 0,
    describedBy: 'author-first-target',
  });
});

test('renderer invalidates deferred overflow restoration before offscreen, hide, and destroy resets', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { acquireDocumentResources } = await import('/src/scheduler.js');
    const { createRenderer } = await import('/src/renderer.js');
    const fixture = window.__shadowAccessibility.first;
    const lease = acquireDocumentResources(document);
    const frames = () => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const visibleLayout = {
      targetRects: [],
      unionRect: null,
      markPaths: [],
      side: 'right',
      noteRect: {
        x: 20, y: 20, width: 150, height: 44,
      },
      connector: { shaft: '', head: '' },
      viewport: { width: innerWidth, height: innerHeight },
      targetVisible: true,
    };
    const description = {
      host: fixture.host,
      portal: lease.shared.overlay,
      create() { return {}; },
      remove() {},
    };

    const run = async (mode) => {
      const id = `deferred-${mode}`;
      lease.shared.registerController(id);
      const renderer = createRenderer({
        id,
        record: {
          kind: 'element',
          element: fixture.target,
          ownerElement: fixture.target,
        },
        options: {
          mark: 'box',
          note: `Deferred ${mode}`,
          accessible: true,
        },
        lease,
        description,
      });
      const note = renderer.noteElement;
      let overflowing = true;
      Object.defineProperties(note, {
        clientHeight: { configurable: true, get: () => 30 },
        clientWidth: { configurable: true, get: () => 100 },
        scrollHeight: { configurable: true, get: () => (overflowing ? 80 : 30) },
        scrollWidth: { configurable: true, get: () => 100 },
      });
      renderer.applyTheme(renderer.prepareTheme());
      renderer.draw(visibleLayout);
      await frames();
      note.focus();
      overflowing = false;
      renderer.draw(visibleLayout);
      await frames();
      overflowing = true;
      if (mode === 'offscreen') {
        renderer.draw({ ...visibleLayout, targetVisible: false });
      } else if (mode === 'hide') {
        renderer.hide();
      } else {
        renderer.destroy();
      }
      await frames();
      const output = {
        active: document.activeElement === note,
        ariaHidden: note.getAttribute('aria-hidden'),
        connected: note.isConnected,
        role: note.getAttribute('role'),
        tabindex: note.getAttribute('tabindex'),
      };
      renderer.destroy();
      lease.shared.releaseController(id);
      return output;
    };

    const output = {
      offscreen: await run('offscreen'),
      hide: await run('hide'),
      destroy: await run('destroy'),
    };
    lease.release();
    return output;
  });

  expect(result.offscreen).toEqual({
    active: false,
    ariaHidden: 'true',
    connected: true,
    role: null,
    tabindex: null,
  });
  expect(result.hide).toEqual({
    active: false,
    ariaHidden: 'true',
    connected: true,
    role: null,
    tabindex: null,
  });
  expect(result.destroy).toMatchObject({
    active: false,
    connected: false,
  });
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

test('large bridged font and padding use final note geometry before finished without a later jump', async ({
  page,
}) => {
  await page.setViewportSize({ width: 520, height: 360 });
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const fixture = window.__shadowAccessibility.first;
    fixture.host.style.cssText = [
      'position:absolute',
      'left:420px',
      'top:150px',
      '--hana-font:700 30px/1.35 monospace',
      '--hana-padding:36px 44px',
      '--hana-note-gap:24px',
    ].join(';');
    const scope = createShadowScope(fixture.root);
    const controller = scope.annotate(fixture.target, {
      mark: 'circle',
      note: 'Large themed note geometry must settle once',
      placement: 'auto',
      accessible: true,
      duration: 0,
    });
    controller.show();
    await controller.finished;
    const note = document.querySelector('[data-hana-shadow-overlay] .hana-note');
    const snapshot = () => {
      const rect = note.getBoundingClientRect();
      const style = getComputedStyle(note);
      return {
        rect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
        fontSize: style.fontSize,
        paddingTop: style.paddingTop,
        side: note.getAttribute('data-hana-side'),
      };
    };
    const atFinished = snapshot();
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const afterFrames = snapshot();
    scope.destroy();
    return { atFinished, afterFrames };
  });

  expect(result.atFinished.fontSize).toBe('30px');
  expect(result.atFinished.paddingTop).toBe('36px');
  expect(result.atFinished.side).toBe(result.afterFrames.side);
  expect(result.atFinished.rect.left).toBeGreaterThanOrEqual(12);
  expect(result.atFinished.rect.top).toBeGreaterThanOrEqual(12);
  expect(result.atFinished.rect.right).toBeLessThanOrEqual(508);
  expect(result.atFinished.rect.bottom).toBeLessThanOrEqual(348);
  for (const field of ['left', 'top', 'right', 'bottom', 'width', 'height']) {
    expect(result.atFinished.rect[field]).toBeCloseTo(result.afterFrames.rect[field], 1);
  }
});

test('pinch-zoom visual viewport sizes the wrapping note before finished without a stale first frame', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 4 });
  try {
    const result = await page.evaluate(async () => {
      const { createShadowScope } = await import('/src/shadow.js');
      const fixture = window.__shadowAccessibility.first;
      fixture.host.style.cssText = 'position:absolute;left:200px;top:150px';
      const scope = createShadowScope(fixture.root);
      const controller = scope.annotate(fixture.target, {
        mark: 'box',
        note: 'Pinch viewport wrapping geometry '.repeat(4),
        placement: 'left',
        accessible: true,
        duration: 0,
      });
      controller.show();
      await controller.finished;
      const note = document.querySelector('[data-hana-shadow-overlay] .hana-note');
      const snapshot = () => {
        const rect = note.getBoundingClientRect();
        return {
          rect: {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          },
          viewport: {
            left: visualViewport.offsetLeft,
            top: visualViewport.offsetTop,
            width: visualViewport.width,
            height: visualViewport.height,
          },
        };
      };
      const atFinished = snapshot();
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
      });
      const afterFrames = snapshot();
      window.__pinchZoomFixture = { scope, snapshot };
      return { atFinished, afterFrames };
    });

    const expectBoundedAndStable = (first, settled) => {
      const { rect, viewport } = first;
      expect(rect.left).toBeGreaterThanOrEqual(viewport.left + 12);
      expect(rect.top).toBeGreaterThanOrEqual(viewport.top + 12);
      expect(rect.right).toBeLessThanOrEqual(viewport.left + viewport.width - 12);
      expect(rect.bottom).toBeLessThanOrEqual(viewport.top + viewport.height - 12);
      for (const field of ['left', 'top', 'right', 'bottom', 'width', 'height']) {
        expect(rect[field]).toBeCloseTo(settled.rect[field], 1);
      }
    };
    expect(result.atFinished.viewport.width).toBeCloseTo(266.67, 1);
    expect(result.atFinished.viewport.height).toBeCloseTo(200, 1);
    expectBoundedAndStable(result.atFinished, result.afterFrames);

    await page.evaluate(() => {
      const fixture = window.__pinchZoomFixture;
      fixture.firstResizeFrame = new Promise((resolve) => {
        visualViewport.addEventListener('resize', () => {
          requestAnimationFrame(() => resolve(fixture.snapshot()));
        }, { once: true });
      });
    });
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
    const firstResizeFrame = await page.evaluate(
      () => window.__pinchZoomFixture.firstResizeFrame,
    );
    const settledResize = await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => requestAnimationFrame(
          () => resolve(window.__pinchZoomFixture.snapshot()),
        ));
      });
    }));
    expect(firstResizeFrame.viewport.width).toBeGreaterThan(result.atFinished.viewport.width);
    expect(firstResizeFrame.viewport.height).toBeGreaterThan(result.atFinished.viewport.height);
    expectBoundedAndStable(firstResizeFrame, settledResize);
  } finally {
    await page.evaluate(() => window.__pinchZoomFixture?.scope.destroy());
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await cdp.detach();
  }
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

test('Document-side host dependencies reflow one root for preceding flow and inherited theme changes', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const { first, second } = window.__shadowAccessibility;
    const wrapper = document.createElement('div');
    const preceding = document.createElement('div');
    preceding.style.height = '20px';
    first.host.before(wrapper);
    wrapper.append(preceding, first.host);
    first.host.style.display = 'block';
    wrapper.before(second.host);
    second.host.style.cssText = 'position:absolute;left:620px;top:80px';
    document.body.style.setProperty('--hana-color', 'rgb(18 52 86)');

    const firstScope = createShadowScope(first.root);
    const secondScope = createShadowScope(second.root);
    const firstController = firstScope.annotate(first.target, {
      mark: 'box', note: 'Document dependency', accessible: true, duration: 0,
    });
    const secondController = secondScope.annotate(second.target, {
      mark: 'box', note: null, duration: 0,
    });
    firstController.show();
    secondController.show();
    await Promise.all([firstController.finished, secondController.finished]);
    const frames = () => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await frames();
    const [firstPortal, secondPortal] = [
      ...document.querySelectorAll('[data-hana-shadow-overlay]'),
    ];
    const firstGroup = firstPortal.querySelector('.hana-annotation');
    const secondGroup = secondPortal.querySelector('.hana-annotation');
    const nativeSecondRect = second.target.getBoundingClientRect.bind(second.target);
    let unrelatedReads = 0;
    second.target.getBoundingClientRect = () => {
      unrelatedReads += 1;
      return nativeSecondRect();
    };
    const before = {
      firstY: firstGroup.getBBox().y,
      secondY: secondGroup.getBBox().y,
      color: firstGroup.style.getPropertyValue('--hana-color'),
    };

    preceding.style.height = '120px';
    await frames();
    const afterFlow = {
      firstY: firstGroup.getBBox().y,
      secondY: secondGroup.getBBox().y,
      unrelatedReads,
    };

    document.body.style.setProperty('--hana-color', 'rgb(120 40 90)');
    await frames();
    const afterTheme = firstGroup.style.getPropertyValue('--hana-color');
    firstScope.destroy();
    secondScope.destroy();
    return { afterFlow, afterTheme, before };
  });

  expect(result.before.color).toBe('rgb(18 52 86)');
  expect(result.afterFlow.firstY).toBeCloseTo(result.before.firstY + 100, 1);
  expect(result.afterFlow.secondY).toBeCloseTo(result.before.secondY, 4);
  expect(result.afterFlow.unrelatedReads).toBe(0);
  expect(result.afterTheme).toBe('rgb(120 40 90)');
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

test('direct Element reflows for a Shadow-root grandparent style mutation without waking another root', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const { first, second } = window.__shadowAccessibility;
    first.root.innerHTML = `
      <div id="element-grandparent">
        <section><button id="element-direct">Element target</button></section>
      </div>
    `;
    const target = first.root.querySelector('#element-direct');
    const grandparent = first.root.querySelector('#element-grandparent');
    const firstScope = createShadowScope(first.root);
    const secondScope = createShadowScope(second.root);
    const firstController = firstScope.annotate(target, {
      mark: 'box', note: null, duration: 0,
    });
    const secondController = secondScope.annotate(second.target, {
      mark: 'box', note: null, duration: 0,
    });
    firstController.show();
    secondController.show();
    await Promise.all([firstController.finished, secondController.finished]);
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const [firstGroup, secondGroup] = [
      ...document.querySelectorAll('[data-hana-shadow-overlay] .hana-annotation'),
    ];
    const before = {
      first: firstGroup.getBBox().x,
      second: secondGroup.getBBox().x,
    };
    const nativeSecondRect = second.target.getBoundingClientRect.bind(second.target);
    let unrelatedReads = 0;
    second.target.getBoundingClientRect = () => {
      unrelatedReads += 1;
      return nativeSecondRect();
    };

    grandparent.style.marginLeft = '96px';
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const after = {
      first: firstGroup.getBBox().x,
      second: secondGroup.getBBox().x,
      unrelatedReads,
    };
    firstScope.destroy();
    secondScope.destroy();
    return { before, after };
  });

  expect(result.after.first).toBeGreaterThan(result.before.first + 80);
  expect(result.after.second).toBeCloseTo(result.before.second, 4);
  expect(result.after.unrelatedReads).toBe(0);
});

test('direct Range reflows for a Shadow-root grandparent attribute mutation without waking another root', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const { first, second } = window.__shadowAccessibility;
    first.root.innerHTML = `
      <style>.range-shifted { margin-left: 110px; }</style>
      <div id="range-grandparent">
        <section><p><span id="range-direct">Range target text</span></p></section>
      </div>
    `;
    const rangeText = first.root.querySelector('#range-direct').firstChild;
    const range = document.createRange();
    range.selectNodeContents(rangeText);
    const grandparent = first.root.querySelector('#range-grandparent');
    const firstScope = createShadowScope(first.root);
    const secondScope = createShadowScope(second.root);
    const firstController = firstScope.annotate(range, {
      mark: 'underline', note: null, duration: 0,
    });
    const secondController = secondScope.annotate(second.target, {
      mark: 'box', note: null, duration: 0,
    });
    firstController.show();
    secondController.show();
    await Promise.all([firstController.finished, secondController.finished]);
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const [firstGroup, secondGroup] = [
      ...document.querySelectorAll('[data-hana-shadow-overlay] .hana-annotation'),
    ];
    const before = {
      first: firstGroup.getBBox().x,
      second: secondGroup.getBBox().x,
    };
    const nativeSecondRect = second.target.getBoundingClientRect.bind(second.target);
    let unrelatedReads = 0;
    second.target.getBoundingClientRect = () => {
      unrelatedReads += 1;
      return nativeSecondRect();
    };

    grandparent.classList.add('range-shifted');
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const after = {
      first: firstGroup.getBBox().x,
      second: secondGroup.getBBox().x,
      unrelatedReads,
    };
    firstScope.destroy();
    secondScope.destroy();
    return { before, after };
  });

  expect(result.after.first).toBeGreaterThan(result.before.first + 90);
  expect(result.after.second).toBeCloseTo(result.before.second, 4);
  expect(result.after.unrelatedReads).toBe(0);
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

test('deep nested scopes follow every composed scroll resize and mutation dependency', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { second } = window.__shadowAccessibility;
    second.host.style.cssText = 'position:absolute;left:700px;top:80px';
    const outerScroller = document.createElement('div');
    outerScroller.style.cssText = [
      'position:absolute',
      'left:80px',
      'top:160px',
      'width:420px',
      'height:140px',
      'overflow:auto',
      'overflow-anchor:none',
    ].join(';');
    const documentSibling = document.createElement('div');
    documentSibling.style.height = '20px';
    const outerHost = document.createElement('div');
    outerHost.style.height = '360px';
    outerScroller.append(documentSibling, outerHost);
    document.body.append(outerScroller);

    const outerRoot = outerHost.attachShadow({ mode: 'open' });
    outerRoot.innerHTML = `
      <div id="outer-sibling" style="height:18px"></div>
      <div id="middle-host"></div>
    `;
    const outerSibling = outerRoot.querySelector('#outer-sibling');
    const middleHost = outerRoot.querySelector('#middle-host');
    const middleRoot = middleHost.attachShadow({ mode: 'open' });
    middleRoot.innerHTML = `
      <div style="height:12px"></div>
      <div id="inner-host"></div>
    `;
    const innerHost = middleRoot.querySelector('#inner-host');
    const innerRoot = innerHost.attachShadow({ mode: 'open' });
    innerRoot.innerHTML = '<button id="nested-target">Nested target</button>';
    const nestedTarget = innerRoot.querySelector('#nested-target');

    const nativeAdd = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    const NativeResizeObserver = ResizeObserver;
    let scrollAdds = 0;
    let scrollRemoves = 0;
    const resizeObserved = [];
    const resizeUnobserved = [];
    EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
      if (this === outerScroller && type === 'scroll') scrollAdds += 1;
      return nativeAdd.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function removeEventListener(
      type,
      listener,
      options,
    ) {
      if (this === outerScroller && type === 'scroll') scrollRemoves += 1;
      return nativeRemove.call(this, type, listener, options);
    };
    window.ResizeObserver = class TrackingResizeObserver {
      constructor(callback) {
        this.native = new NativeResizeObserver(callback);
      }

      observe(target) {
        resizeObserved.push(target);
        this.native.observe(target);
      }

      unobserve(target) {
        resizeUnobserved.push(target);
        this.native.unobserve(target);
      }

      disconnect() {
        this.native.disconnect();
      }
    };

    let nestedScope;
    let secondScope;
    try {
      const { createShadowScope } = await import('/src/shadow.js');
      nestedScope = createShadowScope(innerRoot);
      secondScope = createShadowScope(second.root);
      const nestedController = nestedScope.annotate(nestedTarget, {
        mark: 'box',
        note: 'Deep composed dependency',
        placement: 'right',
        accessible: true,
        duration: 0,
      });
      const secondController = secondScope.annotate(second.target, {
        mark: 'box', note: null, duration: 0,
      });
      nestedController.show();
      secondController.show();
      await Promise.all([nestedController.finished, secondController.finished]);
      const frames = () => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await frames();
      const [nestedPortal, secondPortal] = [
        ...document.querySelectorAll('[data-hana-shadow-overlay]'),
      ];
      const nestedGroup = nestedPortal.querySelector('.hana-annotation');
      const nestedNote = nestedPortal.querySelector('.hana-note');
      const secondGroup = secondPortal.querySelector('.hana-annotation');
      const nativeSecondRect = second.target.getBoundingClientRect.bind(second.target);
      let unrelatedReads = 0;
      second.target.getBoundingClientRect = () => {
        unrelatedReads += 1;
        return nativeSecondRect();
      };
      const snapshot = () => ({
        groupY: nestedGroup.getBBox().y,
        middleY: middleHost.getBoundingClientRect().top,
        noteY: nestedNote.getBoundingClientRect().top,
        outerSiblingHeight: outerSibling.getBoundingClientRect().height,
        secondY: secondGroup.getBBox().y,
        targetY: nestedTarget.getBoundingClientRect().top,
      });
      const before = snapshot();

      outerScroller.scrollTop = 40;
      outerScroller.dispatchEvent(new Event('scroll'));
      await frames();
      const afterScroll = snapshot();

      outerSibling.style.height = '48px';
      await frames();
      const afterOuterSibling = snapshot();

      documentSibling.style.height = '40px';
      await frames();
      const afterDocumentSibling = snapshot();

      outerHost.style.setProperty('--hana-color', 'rgb(24 96 72)');
      await frames();
      const afterTheme = nestedGroup.style.getPropertyValue('--hana-color');
      const dependencies = {
        outerScrollerResize: resizeObserved.includes(outerScroller),
        outerHostResize: resizeObserved.includes(outerHost),
        middleHostResize: resizeObserved.includes(middleHost),
        innerHostResize: resizeObserved.includes(innerHost),
        scrollAdds,
      };

      nestedController.destroy();
      const cleanup = {
        outerScrollerResize: resizeUnobserved.includes(outerScroller),
        outerHostResize: resizeUnobserved.includes(outerHost),
        middleHostResize: resizeUnobserved.includes(middleHost),
        innerHostResize: resizeUnobserved.includes(innerHost),
        scrollRemoves,
      };
      secondController.destroy();
      nestedScope.destroy();
      secondScope.destroy();
      nestedScope = null;
      secondScope = null;
      return {
        afterDocumentSibling,
        afterOuterSibling,
        afterScroll,
        afterTheme,
        before,
        cleanup,
        dependencies,
        unrelatedReads,
      };
    } finally {
      nestedScope?.destroy();
      secondScope?.destroy();
      EventTarget.prototype.addEventListener = nativeAdd;
      EventTarget.prototype.removeEventListener = nativeRemove;
      window.ResizeObserver = NativeResizeObserver;
    }
  });

  expect(result.dependencies).toEqual({
    outerScrollerResize: true,
    outerHostResize: true,
    middleHostResize: true,
    innerHostResize: true,
    scrollAdds: 1,
  });
  expect(result.afterScroll.groupY).toBeCloseTo(result.before.groupY - 40, 1);
  expect(result.afterScroll.noteY).toBeCloseTo(result.before.noteY - 40, 1);
  expect(result.afterScroll.targetY).toBeCloseTo(result.before.targetY - 40, 1);
  expect(result.afterOuterSibling.outerSiblingHeight).toBeCloseTo(
    result.afterScroll.outerSiblingHeight + 30,
    1,
  );
  expect(result.afterOuterSibling.middleY).toBeCloseTo(result.afterScroll.middleY + 30, 1);
  expect(result.afterOuterSibling.targetY).toBeCloseTo(result.afterScroll.targetY + 30, 1);
  expect(result.afterOuterSibling.groupY).toBeCloseTo(result.afterScroll.groupY + 30, 1);
  expect(result.afterOuterSibling.noteY).toBeCloseTo(result.afterScroll.noteY + 30, 1);
  expect(result.afterDocumentSibling.groupY).toBeCloseTo(
    result.afterOuterSibling.groupY + 20,
    1,
  );
  expect(result.afterDocumentSibling.noteY).toBeCloseTo(
    result.afterOuterSibling.noteY + 20,
    1,
  );
  expect(result.afterDocumentSibling.secondY).toBeCloseTo(result.before.secondY, 4);
  expect(result.afterTheme).toBe('rgb(24 96 72)');
  expect(result.unrelatedReads).toBe(0);
  expect(result.cleanup).toEqual({
    outerScrollerResize: true,
    outerHostResize: true,
    middleHostResize: true,
    innerHostResize: true,
    scrollRemoves: 1,
  });
});

test('dynamic composed topology diffs inserted siblings reparented closed hosts and scroll ancestors', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { second } = window.__shadowAccessibility;
    second.host.style.cssText = 'position:absolute;left:900px;top:40px';
    const stage = document.createElement('div');
    stage.style.cssText = 'position:absolute;left:40px;top:120px;width:700px;height:180px';
    const oldScroller = document.createElement('div');
    const newScroller = document.createElement('div');
    const refreshScroller = document.createElement('div');
    for (const scroller of [oldScroller, newScroller, refreshScroller]) {
      scroller.style.cssText = [
        'width:220px',
        'height:150px',
        'overflow:auto',
        'overflow-anchor:none',
        'position:absolute',
        'top:0',
      ].join(';');
    }
    oldScroller.style.left = '0px';
    newScroller.style.left = '240px';
    refreshScroller.style.left = '480px';
    const outerHost = document.createElement('div');
    outerHost.style.height = '320px';
    oldScroller.append(outerHost);
    const outerRoot = outerHost.attachShadow({ mode: 'closed' });
    const originalBefore = document.createElement('div');
    originalBefore.style.height = '12px';
    const innerHost = document.createElement('div');
    outerRoot.append(originalBefore, innerHost);
    const innerRoot = innerHost.attachShadow({ mode: 'closed' });
    const target = document.createElement('button');
    target.textContent = 'Dynamic nested target';
    innerRoot.append(target);

    const replacementOuterHost = document.createElement('div');
    replacementOuterHost.style.height = '320px';
    refreshScroller.append(replacementOuterHost);
    const replacementOuterRoot = replacementOuterHost.attachShadow({ mode: 'closed' });
    const replacementBefore = document.createElement('div');
    replacementBefore.style.height = '10px';
    replacementOuterRoot.append(replacementBefore);
    stage.append(refreshScroller, newScroller, oldScroller);
    document.body.append(stage);

    const nativeAdd = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    const NativeResizeObserver = ResizeObserver;
    const NativeMutationObserver = MutationObserver;
    const scrollAdds = new Map();
    const scrollRemoves = new Map();
    const resizeObserved = [];
    const resizeUnobserved = [];
    const mutationObserved = [];
    const increment = (map, targetValue) => {
      map.set(targetValue, (map.get(targetValue) ?? 0) + 1);
    };
    EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
      if (type === 'scroll') increment(scrollAdds, this);
      return nativeAdd.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function removeEventListener(
      type,
      listener,
      options,
    ) {
      if (type === 'scroll') increment(scrollRemoves, this);
      return nativeRemove.call(this, type, listener, options);
    };
    window.ResizeObserver = class TrackingResizeObserver {
      constructor(callback) {
        this.native = new NativeResizeObserver(callback);
      }

      observe(observedTarget) {
        resizeObserved.push(observedTarget);
        this.native.observe(observedTarget);
      }

      unobserve(observedTarget) {
        resizeUnobserved.push(observedTarget);
        this.native.unobserve(observedTarget);
      }

      disconnect() {
        this.native.disconnect();
      }
    };
    window.MutationObserver = class TrackingMutationObserver {
      constructor(callback) {
        this.native = new NativeMutationObserver(callback);
      }

      observe(observedTarget, options) {
        mutationObserved.push(observedTarget);
        this.native.observe(observedTarget, options);
      }

      disconnect() {
        this.native.disconnect();
      }

      takeRecords() {
        return this.native.takeRecords();
      }
    };

    let nestedScope;
    let secondScope;
    try {
      const { createShadowScope } = await import('/src/shadow.js');
      nestedScope = createShadowScope(innerRoot);
      secondScope = createShadowScope(second.root);
      const controller = nestedScope.annotate(target, {
        mark: 'box', note: null, duration: 0,
      });
      const secondController = secondScope.annotate(second.target, {
        mark: 'box', note: null, duration: 0,
      });
      controller.show();
      secondController.show();
      await Promise.all([controller.finished, secondController.finished]);
      const frames = (count = 4) => new Promise((resolve) => {
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
      await frames();
      const [nestedPortal] = [...document.querySelectorAll('[data-hana-shadow-overlay]')];
      const group = nestedPortal.querySelector('.hana-annotation');
      const nativeSecondRect = second.target.getBoundingClientRect.bind(second.target);
      let unrelatedReads = 0;
      second.target.getBoundingClientRect = () => {
        unrelatedReads += 1;
        return nativeSecondRect();
      };
      const snapshot = () => ({
        groupY: group.getBBox().y,
        targetY: target.getBoundingClientRect().top,
      });

      const insertedBefore = document.createElement('div');
      insertedBefore.style.height = '15px';
      outerRoot.insertBefore(insertedBefore, innerHost);
      await frames();
      const beforeInsertedGrowth = snapshot();
      insertedBefore.style.height = '55px';
      await frames();
      const afterInsertedGrowth = snapshot();
      const insertedObserved = resizeObserved.includes(insertedBefore);

      newScroller.append(outerHost);
      await frames();
      const afterDocumentReparent = {
        newAdd: scrollAdds.get(newScroller) ?? 0,
        newObserved: resizeObserved.includes(newScroller),
        oldRemove: scrollRemoves.get(oldScroller) ?? 0,
        oldUnobserved: resizeUnobserved.includes(oldScroller),
      };
      const beforeNewScroll = snapshot();
      newScroller.scrollTop = 25;
      newScroller.dispatchEvent(new Event('scroll'));
      await frames();
      const afterNewScroll = snapshot();

      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'height:130px;overflow:auto;overflow-anchor:none';
      newScroller.append(wrapper);
      wrapper.append(outerHost);
      await frames();
      const afterWrapperAdded = {
        add: scrollAdds.get(wrapper) ?? 0,
        observed: resizeObserved.includes(wrapper),
      };
      newScroller.append(outerHost);
      wrapper.remove();
      await frames();
      const afterWrapperRemoved = {
        remove: scrollRemoves.get(wrapper) ?? 0,
        unobserved: resizeUnobserved.includes(wrapper),
      };

      refreshScroller.append(outerHost);
      controller.refresh();
      await frames();
      const afterExplicitRefresh = {
        newRemove: scrollRemoves.get(newScroller) ?? 0,
        refreshAdd: scrollAdds.get(refreshScroller) ?? 0,
        refreshObserved: resizeObserved.includes(refreshScroller),
      };

      replacementOuterRoot.append(innerHost);
      await frames();
      const afterClosedRootReparent = {
        oldHostUnobserved: resizeUnobserved.includes(outerHost),
        oldSiblingUnobserved: resizeUnobserved.includes(insertedBefore),
        replacementHostObserved: resizeObserved.includes(replacementOuterHost),
        replacementRootObserved: mutationObserved.includes(replacementOuterRoot),
        replacementSiblingObserved: resizeObserved.includes(replacementBefore),
      };
      const beforeReplacementGrowth = snapshot();
      replacementBefore.style.height = '40px';
      await frames();
      const afterReplacementGrowth = snapshot();

      controller.destroy();
      const firstCleanup = {
        refreshRemove: scrollRemoves.get(refreshScroller) ?? 0,
        replacementHostUnobserved: resizeUnobserved.includes(replacementOuterHost),
        replacementSiblingUnobserved: resizeUnobserved.includes(replacementBefore),
      };
      secondController.destroy();
      nestedScope.destroy();
      secondScope.destroy();
      nestedScope = null;
      secondScope = null;
      return {
        afterClosedRootReparent,
        afterDocumentReparent,
        afterExplicitRefresh,
        afterInsertedGrowth,
        afterNewScroll,
        afterReplacementGrowth,
        afterWrapperAdded,
        afterWrapperRemoved,
        beforeInsertedGrowth,
        beforeNewScroll,
        beforeReplacementGrowth,
        firstCleanup,
        insertedObserved,
        overlays: document.querySelectorAll('[data-hana-shadow-overlay]').length,
        unrelatedReads,
      };
    } finally {
      nestedScope?.destroy();
      secondScope?.destroy();
      EventTarget.prototype.addEventListener = nativeAdd;
      EventTarget.prototype.removeEventListener = nativeRemove;
      window.ResizeObserver = NativeResizeObserver;
      window.MutationObserver = NativeMutationObserver;
    }
  });

  expect(result.afterInsertedGrowth.targetY).toBeCloseTo(
    result.beforeInsertedGrowth.targetY + 40,
    1,
  );
  expect(result.afterInsertedGrowth.groupY).toBeCloseTo(
    result.beforeInsertedGrowth.groupY + 40,
    1,
  );
  expect(result.insertedObserved).toBe(true);
  expect(result.afterDocumentReparent).toEqual({
    newAdd: 1,
    newObserved: true,
    oldRemove: 1,
    oldUnobserved: true,
  });
  expect(result.afterNewScroll.targetY).toBeCloseTo(result.beforeNewScroll.targetY - 25, 1);
  expect(result.afterNewScroll.groupY).toBeCloseTo(result.beforeNewScroll.groupY - 25, 1);
  expect(result.afterWrapperAdded).toEqual({ add: 1, observed: true });
  expect(result.afterWrapperRemoved).toEqual({ remove: 1, unobserved: true });
  expect(result.afterExplicitRefresh).toEqual({
    newRemove: 1,
    refreshAdd: 1,
    refreshObserved: true,
  });
  expect(result.afterClosedRootReparent).toEqual({
    oldHostUnobserved: true,
    oldSiblingUnobserved: true,
    replacementHostObserved: true,
    replacementRootObserved: true,
    replacementSiblingObserved: true,
  });
  expect(result.afterReplacementGrowth.targetY).toBeCloseTo(
    result.beforeReplacementGrowth.targetY + 30,
    1,
  );
  expect(result.afterReplacementGrowth.groupY).toBeCloseTo(
    result.beforeReplacementGrowth.groupY + 30,
    1,
  );
  expect(result.firstCleanup).toEqual({
    refreshRemove: 1,
    replacementHostUnobserved: true,
    replacementSiblingUnobserved: true,
  });
  expect(result.unrelatedReads).toBe(0);
  expect(result.overlays).toBe(0);
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
