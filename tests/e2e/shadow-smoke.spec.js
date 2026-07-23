import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/shadow.html');
  await page.addStyleTag({ url: '/src/hanamaru.css' });
});

const NOTE_TEXT = 'Meaningful cross-browser note';

function expectRendered(snapshot) {
  expect(snapshot).toMatchObject({
    state: 'visible',
    overlayPosition: 'fixed',
    mark: 'circle',
    groupHidden: false,
    groupDisplay: expect.not.stringMatching(/^none$/u),
    pathD: expect.stringMatching(/\S/u),
    pathGeometry: true,
    note: NOTE_TEXT,
    noteDisplay: expect.not.stringMatching(/^none$/u),
    noteVisibility: 'visible',
    noteHidden: false,
    visualAriaHidden: 'true',
    visualOutsideRoot: true,
    mirrorText: NOTE_TEXT,
    mirrorInRoot: true,
    token: expect.stringMatching(/^hana-shadow-root-\d+-mirror-\d+$/u),
    tokenResolvesInRoot: true,
  });
  expect(snapshot.pathLength).toBeGreaterThan(0);
  expect(snapshot.pathStroke).not.toMatch(/^(?:none|transparent|rgba\(0,\s*0,\s*0,\s*0\))$/u);
}

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

    const currentNodes = () => {
      const overlay = document.querySelector('[data-hana-shadow-overlay]');
      const group = overlay?.querySelector('.hana-annotation') ?? null;
      return {
        overlay,
        group,
        path: group?.querySelector('path') ?? null,
        note: overlay?.querySelector('[data-hana-note]') ?? null,
        mirror: root.querySelector('[data-hana-shadow-mirror]'),
      };
    };
    const visibleSnapshot = () => {
      const nodes = currentNodes();
      const token = target.getAttribute('aria-describedby');
      const pathBox = nodes.path?.getBBox();
      const pathRect = nodes.path?.getBoundingClientRect();
      return {
        state: controller.state,
        overlayPosition: nodes.overlay === null
          ? null
          : getComputedStyle(nodes.overlay).position,
        mark: nodes.group?.getAttribute('data-hana-mark'),
        groupHidden: nodes.group?.hasAttribute('hidden'),
        groupDisplay: nodes.group === null ? null : getComputedStyle(nodes.group).display,
        pathD: nodes.path?.getAttribute('d'),
        pathLength: nodes.path?.getTotalLength(),
        pathStroke: nodes.path === null ? null : getComputedStyle(nodes.path).stroke,
        pathGeometry: pathBox !== undefined
          && pathRect !== undefined
          && pathBox.width > 0
          && pathBox.height > 0
          && pathRect.width > 0
          && pathRect.height > 0,
        note: nodes.note?.textContent,
        noteDisplay: nodes.note === null ? null : getComputedStyle(nodes.note).display,
        noteVisibility: nodes.note === null ? null : getComputedStyle(nodes.note).visibility,
        noteHidden: nodes.note?.classList.contains('hana-is-hidden'),
        visualAriaHidden: nodes.note?.getAttribute('aria-hidden'),
        visualOutsideRoot: nodes.note?.getRootNode() === document,
        mirrorText: nodes.mirror?.textContent,
        mirrorInRoot: nodes.mirror?.getRootNode() === root,
        token,
        tokenResolvesInRoot: token !== null
          && root.getElementById(token) === nodes.mirror,
      };
    };

    controller.show();
    await controller.finished;
    const firstNodes = currentNodes();
    const firstVisible = visibleSnapshot();

    controller.hide();
    const hiddenNodes = currentNodes();
    const hidden = {
      state: controller.state,
      groupHidden: hiddenNodes.group?.hasAttribute('hidden'),
      groupDisplay: hiddenNodes.group === null
        ? null
        : getComputedStyle(hiddenNodes.group).display,
      noteHidden: hiddenNodes.note?.classList.contains('hana-is-hidden'),
      noteDisplay: hiddenNodes.note === null
        ? null
        : getComputedStyle(hiddenNodes.note).display,
      noteVisibility: hiddenNodes.note === null
        ? null
        : getComputedStyle(hiddenNodes.note).visibility,
      mirrors: root.querySelectorAll('[data-hana-shadow-mirror]').length,
      describedBy: target.getAttribute('aria-describedby'),
    };

    controller.replay();
    await controller.finished;
    const replayNodes = currentNodes();
    const replayed = {
      ...visibleSnapshot(),
      currentOutput: {
        overlay: replayNodes.overlay !== null,
        group: replayNodes.group !== null,
        path: replayNodes.path !== null,
        note: replayNodes.note !== null,
        mirror: replayNodes.mirror !== null,
      },
      nodeLifecycle: {
        overlay: replayNodes.overlay === firstNodes.overlay,
        group: replayNodes.group === firstNodes.group,
        pathRecreated: replayNodes.path !== firstNodes.path,
        note: replayNodes.note === firstNodes.note,
        mirrorRecreated: replayNodes.mirror !== firstNodes.mirror,
      },
    };

    const finalNodes = currentNodes();
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
        disconnected: {
          overlay: finalNodes.overlay?.isConnected,
          group: finalNodes.group?.isConnected,
          path: finalNodes.path?.isConnected,
          note: finalNodes.note?.isConnected,
          mirror: finalNodes.mirror?.isConnected,
        },
      },
    };
  });

  expectRendered(result.firstVisible);
  expect(result.hidden).toEqual({
    state: 'hidden',
    groupHidden: true,
    groupDisplay: 'none',
    noteHidden: true,
    noteDisplay: 'block',
    noteVisibility: 'hidden',
    mirrors: 0,
    describedBy: null,
  });
  expectRendered(result.replayed);
  expect(result.replayed).toMatchObject({
    currentOutput: {
      overlay: true,
      group: true,
      path: true,
      note: true,
      mirror: true,
    },
    nodeLifecycle: {
      overlay: true,
      group: true,
      pathRecreated: true,
      note: true,
      mirrorRecreated: true,
    },
  });
  expect(result.cleanup).toEqual({
    state: 'destroyed',
    portals: 0,
    groups: 0,
    notes: 0,
    mirrors: 0,
    describedBy: null,
    disconnected: {
      overlay: false,
      group: false,
      path: false,
      note: false,
      mirror: false,
    },
  });
});
