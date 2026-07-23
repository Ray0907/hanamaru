import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/shadow.html');
  await page.addStyleTag({ url: '/src/hanamaru.css' });
});

test('open-root circle note completes, replays, and cleans up in every engine', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createShadowScope } = await import('/src/shadow.js');
    const host = document.querySelector('#open-host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="target">Cross-browser target</button>';
    const target = root.querySelector('#target');
    const scope = createShadowScope(root);
    const controller = scope.annotate(target, {
      mark: 'circle',
      note: 'Meaningful cross-browser note',
      accessible: true,
      duration: 0,
      motion: 'never',
    });

    controller.show();
    await controller.finished;
    const group = document.querySelector(
      '[data-hana-shadow-overlay] .hana-annotation',
    );
    const visualNote = document.querySelector(
      '[data-hana-shadow-overlay] [data-hana-note]',
    );
    const mirror = root.querySelector('[data-hana-shadow-mirror]');
    const token = target.getAttribute('aria-describedby');
    const firstVisible = {
      state: controller.state,
      mark: group?.getAttribute('data-hana-mark'),
      groupHidden: group?.hasAttribute('hidden'),
      pathCount: group?.querySelectorAll('path').length,
      note: visualNote?.textContent,
      visualAriaHidden: visualNote?.getAttribute('aria-hidden'),
      visualOutsideRoot: visualNote?.getRootNode() === document,
      mirrorText: mirror?.textContent,
      mirrorInRoot: mirror?.getRootNode() === root,
      token,
      tokenResolvesInRoot: token !== null && root.getElementById(token) === mirror,
    };

    controller.hide();
    const hidden = {
      state: controller.state,
      groupHidden: group?.hasAttribute('hidden'),
      noteHidden: visualNote?.classList.contains('hana-is-hidden'),
      mirrors: root.querySelectorAll('[data-hana-shadow-mirror]').length,
      describedBy: target.getAttribute('aria-describedby'),
    };

    controller.replay();
    await controller.finished;
    const replayMirror = root.querySelector('[data-hana-shadow-mirror]');
    const replayToken = target.getAttribute('aria-describedby');
    const replayed = {
      state: controller.state,
      groupHidden: group?.hasAttribute('hidden'),
      noteHidden: visualNote?.classList.contains('hana-is-hidden'),
      mirrorInRoot: replayMirror?.getRootNode() === root,
      recreatedMirror: replayMirror !== mirror,
      token: replayToken,
      tokenResolvesInRoot: replayToken !== null
        && root.getElementById(replayToken) === replayMirror,
    };

    scope.destroy();
    return {
      firstVisible,
      hidden,
      replayed,
      cleanup: {
        state: controller.state,
        portals: document.querySelectorAll('[data-hana-shadow-overlay]').length,
        groups: document.querySelectorAll('.hana-annotation').length,
        notes: document.querySelectorAll('[data-hana-note]').length,
        mirrors: root.querySelectorAll('[data-hana-shadow-mirror]').length,
        describedBy: target.getAttribute('aria-describedby'),
      },
    };
  });

  expect(result.firstVisible).toMatchObject({
    state: 'visible',
    mark: 'circle',
    groupHidden: false,
    note: 'Meaningful cross-browser note',
    visualAriaHidden: 'true',
    visualOutsideRoot: true,
    mirrorText: 'Meaningful cross-browser note',
    mirrorInRoot: true,
    token: expect.stringMatching(/^hana-shadow-root-\d+-mirror-\d+$/u),
    tokenResolvesInRoot: true,
  });
  expect(result.firstVisible.pathCount).toBeGreaterThan(0);
  expect(result.hidden).toEqual({
    state: 'hidden',
    groupHidden: true,
    noteHidden: true,
    mirrors: 0,
    describedBy: null,
  });
  expect(result.replayed).toMatchObject({
    state: 'visible',
    groupHidden: false,
    noteHidden: false,
    mirrorInRoot: true,
    recreatedMirror: true,
    token: expect.stringMatching(/^hana-shadow-root-\d+-mirror-\d+$/u),
    tokenResolvesInRoot: true,
  });
  expect(result.cleanup).toEqual({
    state: 'destroyed',
    portals: 0,
    groups: 0,
    notes: 0,
    mirrors: 0,
    describedBy: null,
  });
});
