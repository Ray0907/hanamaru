import { expect, test } from '@playwright/test';

test('built root and optional subpaths share real plugins, metadata, and resources', async ({ page }) => {
  await page.goto('/tests/fixtures/harness.html');
  await page.addStyleTag({ url: '/dist/hanamaru.css' });

  const result = await page.evaluate(async () => {
    const [core, plugins, serialization, groups, shadow] = await Promise.all([
      import('/dist/hanamaru.esm.js'),
      import('/dist/plugins/index.js'),
      import('/dist/serialize/index.js'),
      import('/dist/group/index.js'),
      import('/dist/shadow/index.js'),
    ]);
    const controllers = [];
    const scopes = [];
    const elements = [];
    let unregister = () => {};
    let output;

    try {
      const rootTarget = document.body.appendChild(document.createElement('span'));
      rootTarget.id = 'dist-root-target';
      rootTarget.textContent = 'Built root plugin target';
      rootTarget.style.display = 'inline-block';
      elements.push(rootTarget);

      const firstGroupTarget = document.body.appendChild(document.createElement('span'));
      firstGroupTarget.id = 'dist-group-first';
      firstGroupTarget.textContent = 'Built group first';
      firstGroupTarget.style.display = 'inline-block';
      elements.push(firstGroupTarget);

      const secondGroupTarget = document.body.appendChild(document.createElement('span'));
      secondGroupTarget.id = 'dist-group-second';
      secondGroupTarget.textContent = 'Built group second';
      secondGroupTarget.style.display = 'inline-block';
      elements.push(secondGroupTarget);

      unregister = plugins.registerMark(
        'dist-singleton-mark',
        () => ({ paths: ['M 1 2 Q 8 3 16 4'] }),
      );

      const rootController = core.annotate('#dist-root-target', {
        mark: 'dist-singleton-mark',
        seed: 'dist-root',
        duration: 0,
        motion: 'never',
      });
      controllers.push(rootController);
      const rootDefinition = serialization.serialize(rootController);
      rootController.show();
      await rootController.finished;

      const originalGroup = groups.group([
        {
          target: '#dist-group-first',
          mark: 'box',
          seed: 'dist-group-first',
          duration: 0,
        },
        {
          target: '#dist-group-second',
          mark: 'underline',
          seed: 'dist-group-second',
          duration: 0,
        },
      ], { trigger: 'manual', motion: 'never' });
      const groupDefinition = serialization.serialize(originalGroup);
      originalGroup.destroy();

      const restoredGroup = serialization.restore(groupDefinition);
      controllers.push(restoredGroup);
      restoredGroup.show();
      await restoredGroup.finished;
      const restoredGroupDefinition = serialization.serialize(restoredGroup);

      const host = document.body.appendChild(document.createElement('div'));
      elements.push(host);
      const shadowRoot = host.attachShadow({ mode: 'open' });
      const shadowPluginTarget = shadowRoot.appendChild(document.createElement('span'));
      shadowPluginTarget.id = 'dist-shadow-plugin';
      shadowPluginTarget.textContent = 'Built shadow plugin';
      shadowPluginTarget.style.display = 'inline-block';
      const shadowPeerTarget = shadowRoot.appendChild(document.createElement('span'));
      shadowPeerTarget.id = 'dist-shadow-peer';
      shadowPeerTarget.textContent = 'Built shadow peer';
      shadowPeerTarget.style.display = 'inline-block';

      const firstScope = shadow.createShadowScope(shadowRoot);
      const secondScope = shadow.createShadowScope(shadowRoot);
      scopes.push(firstScope, secondScope);
      const scopedPlugin = firstScope.annotate('#dist-shadow-plugin', {
        mark: 'dist-singleton-mark',
        seed: 'dist-shadow-plugin',
        duration: 0,
        motion: 'never',
      });
      const scopedPeer = secondScope.annotate('#dist-shadow-peer', {
        mark: 'circle',
        seed: 'dist-shadow-peer',
        duration: 0,
        motion: 'never',
      });
      const shadowDefinition = serialization.serialize(scopedPlugin);
      scopedPlugin.show();
      scopedPeer.show();
      await Promise.all([scopedPlugin.finished, scopedPeer.finished]);

      const resourcesBeforeRelease = document.querySelectorAll(
        '[data-hana-shadow-overlay]',
      ).length;
      const shadowPluginPath = document.querySelector(
        '[data-hana-shadow-overlay] '
          + '.hana-annotation[data-hana-mark="dist-singleton-mark"] .hana-mark-path',
      )?.getAttribute('d');
      firstScope.destroy();
      const resourcesAfterFirstRelease = document.querySelectorAll(
        '[data-hana-shadow-overlay]',
      ).length;
      const peerAfterFirstRelease = scopedPeer.state;
      secondScope.destroy();
      const resourcesAfterFinalRelease = document.querySelectorAll(
        '[data-hana-shadow-overlay]',
      ).length;

      output = {
        root: {
          definition: rootDefinition,
          path: document.querySelector(
            '[data-hana-overlay]:not([data-hana-shadow-overlay]) '
              + '.hana-annotation[data-hana-mark="dist-singleton-mark"] .hana-mark-path',
          )?.getAttribute('d'),
          state: rootController.state,
        },
        group: {
          definition: groupDefinition,
          restoredDefinition: restoredGroupDefinition,
          size: restoredGroup.size,
          state: restoredGroup.state,
        },
        shadow: {
          definition: shadowDefinition,
          path: shadowPluginPath,
          peerAfterFirstRelease,
          resources: [
            resourcesBeforeRelease,
            resourcesAfterFirstRelease,
            resourcesAfterFinalRelease,
          ],
        },
      };
    } finally {
      for (let index = scopes.length - 1; index >= 0; index -= 1) {
        try { scopes[index].destroy(); } catch { /* Preserve the test failure. */ }
      }
      for (let index = controllers.length - 1; index >= 0; index -= 1) {
        try { controllers[index].destroy(); } catch { /* Preserve the test failure. */ }
      }
      try { unregister(); } catch { /* Preserve the test failure. */ }
      for (const element of elements) element.remove();
    }

    output.cleanup = {
      annotations: document.querySelectorAll('.hana-annotation').length,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      shadowOverlays: document.querySelectorAll('[data-hana-shadow-overlay]').length,
    };
    return output;
  });

  expect(result.root).toMatchObject({
    definition: {
      schema: 'hanamaru/v1',
      kind: 'annotation',
      target: { type: 'selector', selector: '#dist-root-target' },
      options: { mark: 'dist-singleton-mark', seed: 'dist-root' },
    },
    path: 'M 1 2 Q 8 3 16 4',
    state: 'visible',
  });
  expect(result.group.definition).toMatchObject({
    schema: 'hanamaru/v1',
    kind: 'group',
    members: [
      {
        target: { type: 'selector', selector: '#dist-group-first' },
        options: { mark: 'box', seed: 'dist-group-first' },
      },
      {
        target: { type: 'selector', selector: '#dist-group-second' },
        options: { mark: 'underline', seed: 'dist-group-second' },
      },
    ],
  });
  expect(result.group.restoredDefinition).toEqual(result.group.definition);
  expect(result.group).toMatchObject({ size: 2, state: 'visible' });
  expect(result.shadow).toEqual({
    definition: {
      schema: 'hanamaru/v1',
      kind: 'annotation',
      target: { type: 'selector', selector: '#dist-shadow-plugin' },
      options: {
        mark: 'dist-singleton-mark',
        note: null,
        placement: 'auto',
        trigger: 'manual',
        accessible: false,
        seed: 'dist-shadow-plugin',
        duration: 0,
        motion: 'never',
      },
    },
    path: 'M 1 2 Q 8 3 16 4',
    peerAfterFirstRelease: 'visible',
    resources: [1, 1, 0],
  });
  expect(result.cleanup).toEqual({ annotations: 0, overlays: 0, shadowOverlays: 0 });
});
