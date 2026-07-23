import { expect, test } from '@playwright/test';

async function openFixture(page, path = '/tests/fixtures/annotation.html') {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__serializationRoundTripUnhandled = [];
    window.addEventListener('unhandledrejection', (event) => {
      window.__serializationRoundTripUnhandled.push(
        String(event.reason?.message ?? event.reason),
      );
    });
  });
  await page.goto(path);
  return pageErrors;
}

async function expectNoBrowserFailures(page, pageErrors) {
  await page.evaluate(async () => {
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  });
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => window.__serializationRoundTripUnhandled)).toEqual([]);
}

test('target preserves native Element and Range identity only in private metadata', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__serializationUnhandled = [];
    window.__serializationUnhandledHandler = (event) => {
      window.__serializationUnhandled.push(String(event.reason?.message ?? event.reason));
    };
    window.addEventListener('unhandledrejection', window.__serializationUnhandledHandler);
  });
  await page.goto('/tests/fixtures/annotation.html');

  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const { readControllerMetadata } = await import('/src/controller-metadata.js');
    const element = document.querySelector('#direct-target');
    const rangeHost = document.querySelector('#range-target');
    const range = document.createRange();
    range.selectNodeContents(rangeHost);
    const controllers = [];
    let proof;
    const publicSurfaceIsPrivate = (controller, target, metadata) => {
      const ownDescriptors = Object.values(Object.getOwnPropertyDescriptors(controller));
      const prototypeDescriptors = Object.values(Object.getOwnPropertyDescriptors(
        Object.getPrototypeOf(controller),
      ));
      return !Object.hasOwn(controller, 'target')
        && !Object.hasOwn(controller, 'metadata')
        && Reflect.ownKeys(controller).every((key) => typeof key !== 'symbol')
        && !ownDescriptors.some(({ value }) => value === target || value === metadata)
        && !prototypeDescriptors.some(({ value }) => value === target || value === metadata);
    };

    try {
      const elementController = annotate(element, {
        mark: 'underline',
        note: 'Element metadata proof',
        motion: 'never',
      });
      controllers.push(elementController);
      const rangeController = annotate(range, {
        mark: 'highlight',
        motion: 'never',
      });
      controllers.push(rangeController);
      const elementMetadata = readControllerMetadata(elementController);
      const rangeMetadata = readControllerMetadata(rangeController);

      proof = {
        native: element instanceof Element
          && range instanceof Range
          && rangeHost instanceof Element,
        exactIdentity: elementMetadata.target === element
          && rangeMetadata.target === range,
        frozenMetadata: Object.isFrozen(elementMetadata)
          && Object.isFrozen(elementMetadata.options)
          && Object.isFrozen(rangeMetadata)
          && Object.isFrozen(rangeMetadata.options),
        unfrozenTargets: !Object.isFrozen(element) && !Object.isFrozen(range),
        privateSurface: publicSurfaceIsPrivate(
          elementController,
          element,
          elementMetadata,
        ) && publicSurfaceIsPrivate(rangeController, range, rangeMetadata),
        jsonPrivate: !JSON.stringify(elementController).includes('Element metadata proof')
          && !JSON.stringify(rangeController).includes('Native range target text'),
        ownedBeforeDestroy: document.querySelectorAll('[data-hana-id]').length,
      };
    } finally {
      for (let index = controllers.length - 1; index >= 0; index -= 1) {
        controllers[index].destroy();
      }
      range.detach();
    }

    return {
      ...proof,
      metadataAbsent: controllers.every(
        (controller) => readControllerMetadata(controller) === undefined,
      ),
      ownedAfterDestroy: document.querySelectorAll('[data-hana-id]').length,
    };
  });

  await page.evaluate(async () => {
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  });
  const unhandled = await page.evaluate(() => {
    window.removeEventListener(
      'unhandledrejection',
      window.__serializationUnhandledHandler,
    );
    return window.__serializationUnhandled;
  });

  expect(result).toEqual({
    native: true,
    exactIdentity: true,
    frozenMetadata: true,
    unfrozenTargets: true,
    privateSurface: true,
    jsonPrivate: true,
    ownedBeforeDestroy: 3,
    metadataAbsent: true,
    ownedAfterDestroy: 0,
  });
  expect(pageErrors).toEqual([]);
  expect(unhandled).toEqual([]);
});

test('serialized Range keys reject invalid native shapes and clone side effects', async ({ page }) => {
  await page.goto('/tests/fixtures/annotation.html');

  const result = await page.evaluate(async () => {
    const { resolveSerializedTarget } = await import('/src/serialize.js');
    const wire = {
      type: 'key',
      key: 'selection',
      targetKind: 'range',
    };
    const resolve = (range, root = document) => {
      try {
        const value = resolveSerializedTarget(wire, {
          root,
          resolveTarget() { return range; },
        });
        return {
          returned: true,
          isRange: value instanceof Range,
          value,
        };
      } catch (error) {
        return {
          returned: false,
          code: error.code,
          hasCause: error.details?.cause !== undefined,
        };
      }
    };

    const host = document.querySelector('#range-target');
    const valid = document.createRange();
    valid.selectNodeContents(host);
    const validResult = resolve(valid);
    const validProof = {
      returned: validResult.returned,
      isRange: validResult.isRange,
      distinct: validResult.value !== valid,
      sameStartContainer: validResult.value?.startContainer === valid.startContainer,
      sameEndContainer: validResult.value?.endContainer === valid.endContainer,
      sameStartOffset: validResult.value?.startOffset === valid.startOffset,
      sameEndOffset: validResult.value?.endOffset === valid.endOffset,
    };

    const comment = document.createComment('document-level range');
    document.append(comment);
    const commentRange = document.createRange();
    commentRange.setStart(comment, 0);
    commentRange.setEnd(comment, comment.data.length);
    const commentResult = resolve(commentRange);

    const overridden = document.createRange();
    overridden.selectNodeContents(host);
    Object.defineProperty(overridden, 'cloneRange', {
      configurable: true,
      value() { return 'not a Range'; },
    });
    const overrideResult = resolve(overridden);

    const detachedHost = document.createElement('span');
    const detachedText = document.createTextNode('detached text');
    detachedHost.append(detachedText);
    const disconnecting = document.createRange();
    disconnecting.selectNodeContents(host);
    Object.defineProperty(disconnecting, 'cloneRange', {
      configurable: true,
      value() {
        disconnecting.setStart(detachedText, 0);
        disconnecting.setEnd(detachedText, detachedText.data.length);
        return Range.prototype.cloneRange.call(disconnecting);
      },
    });
    const disconnectResult = resolve(disconnecting);

    const nextHost = document.querySelector('#next-range-target');
    const nextText = nextHost.firstChild;
    const retargeting = document.createRange();
    retargeting.selectNodeContents(host);
    Object.defineProperty(retargeting, 'cloneRange', {
      configurable: true,
      value() {
        retargeting.setStart(nextText, 0);
        retargeting.setEnd(nextText, nextText.data.length);
        return Range.prototype.cloneRange.call(retargeting);
      },
    });
    const retargetResult = resolve(retargeting);

    const originalText = host.firstChild;
    const originalSnapshot = {
      startContainer: originalText,
      endContainer: originalText,
      startOffset: 0,
      endOffset: originalText.data.length,
      commonAncestorContainer: originalText,
    };
    const maskRange = (range) => {
      Object.defineProperties(range, Object.fromEntries(
        Object.entries(originalSnapshot).map(([key, value]) => ([
          key,
          { configurable: true, value },
        ])),
      ));
      return range;
    };
    const masked = document.createRange();
    masked.setStart(originalText, originalSnapshot.startOffset);
    masked.setEnd(originalText, originalSnapshot.endOffset);
    maskRange(masked);
    Object.defineProperty(masked, 'cloneRange', {
      configurable: true,
      value() {
        masked.setStart(nextText, 0);
        masked.setEnd(nextText, nextText.data.length);
        return maskRange(Range.prototype.cloneRange.call(masked));
      },
    });
    const maskedResult = resolve(masked);

    const frame = document.createElement('iframe');
    frame.srcdoc = '<p id="frame-range">Iframe range text</p>';
    const loaded = new Promise((complete) => {
      frame.addEventListener('load', complete, { once: true });
    });
    document.body.append(frame);
    await loaded;
    const frameDocument = frame.contentDocument;
    const frameWindow = frame.contentWindow;
    const frameHost = frameDocument.querySelector('#frame-range');
    const frameRange = frameDocument.createRange();
    frameRange.selectNodeContents(frameHost);
    const frameResult = resolve(frameRange, frameDocument);
    const iframeProof = {
      returned: frameResult.returned,
      isFrameRange: frameResult.value instanceof frameWindow.Range,
      distinct: frameResult.value !== frameRange,
      sameStartContainer:
        frameResult.value?.startContainer === frameRange.startContainer,
      sameEndContainer: frameResult.value?.endContainer === frameRange.endContainer,
      sameStartOffset: frameResult.value?.startOffset === frameRange.startOffset,
      sameEndOffset: frameResult.value?.endOffset === frameRange.endOffset,
    };

    const nodeDescriptor = Object.getOwnPropertyDescriptor(window, 'Node');
    Object.defineProperty(window, 'Node', {
      ...nodeDescriptor,
      value: undefined,
    });
    let missingNodeRangeResult;
    let missingNodeElementResult;
    try {
      const detachedMaskHost = document.createElement('span');
      const detachedMaskText = document.createTextNode('masked detached text');
      detachedMaskHost.append(detachedMaskText);
      Object.defineProperties(detachedMaskText, {
        ownerDocument: { configurable: true, value: document },
        isConnected: { configurable: true, value: true },
        getRootNode: {
          configurable: true,
          value() { return document; },
        },
        parentElement: { configurable: true, value: host },
      });
      const detachedMaskedRange = document.createRange();
      detachedMaskedRange.selectNodeContents(detachedMaskText);
      missingNodeRangeResult = resolve(detachedMaskedRange);
      detachedMaskedRange.detach();

      const detachedElement = document.createElement('div');
      Object.defineProperties(detachedElement, {
        ownerDocument: { configurable: true, value: document },
        isConnected: { configurable: true, value: true },
        getRootNode: {
          configurable: true,
          value() { return document; },
        },
      });
      try {
        const value = resolveSerializedTarget({
          type: 'key',
          key: 'masked-element',
          targetKind: 'element',
        }, {
          root: document,
          resolveTarget() { return detachedElement; },
        });
        missingNodeElementResult = {
          returned: true,
          isElement: value instanceof Element,
        };
      } catch (error) {
        missingNodeElementResult = {
          returned: false,
          code: error.code,
          hasCause: error.details?.cause !== undefined,
        };
      }
    } finally {
      Object.defineProperty(window, 'Node', nodeDescriptor);
    }

    valid.detach();
    commentRange.detach();
    overridden.detach();
    disconnecting.detach();
    retargeting.detach();
    masked.detach();
    frameRange.detach();
    frame.remove();
    comment.remove();

    return {
      validProof,
      commentResult,
      overrideResult,
      disconnectResult,
      retargetResult,
      maskedResult,
      iframeProof,
      missingNodeRangeResult,
      missingNodeElementResult,
    };
  });

  expect(result).toEqual({
    validProof: {
      returned: true,
      isRange: true,
      distinct: true,
      sameStartContainer: true,
      sameEndContainer: true,
      sameStartOffset: true,
      sameEndOffset: true,
    },
    commentResult: {
      returned: false,
      code: 'HANA_TARGET_INVALID',
      hasCause: true,
    },
    overrideResult: {
      returned: false,
      code: 'HANA_TARGET_INVALID',
      hasCause: true,
    },
    disconnectResult: {
      returned: false,
      code: 'HANA_TARGET_INVALID',
      hasCause: true,
    },
    retargetResult: {
      returned: false,
      code: 'HANA_TARGET_INVALID',
      hasCause: true,
    },
    maskedResult: {
      returned: false,
      code: 'HANA_TARGET_INVALID',
      hasCause: true,
    },
    iframeProof: {
      returned: true,
      isFrameRange: true,
      distinct: true,
      sameStartContainer: true,
      sameEndContainer: true,
      sameStartOffset: true,
      sameEndOffset: true,
    },
    missingNodeRangeResult: {
      returned: false,
      code: 'HANA_TARGET_INVALID',
      hasCause: false,
    },
    missingNodeElementResult: {
      returned: false,
      code: 'HANA_TARGET_INVALID',
      hasCause: false,
    },
  });
});

test('Annotation selector round trip preserves updates, generated seed, plugin output, lifecycle, and cancellation', async ({ page }) => {
  const pageErrors = await openFixture(page);
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const { registerMark } = await import('/src/plugins.js');
    const { restore, serialize } = await import('/src/serialize.js');
    const target = document.querySelector('#selector-target');
    const plugin = () => ({ paths: ['M 1 2 Q 8 3 16 4'] });
    const run = async (controller) => {
      const events = [];
      const listener = (event) => {
        if (event.detail.controller === controller) {
          events.push(event.type.replace('hana:', ''));
        }
      };
      for (const type of ['hana:start', 'hana:complete', 'hana:cancel']) {
        target.addEventListener(type, listener);
      }
      const states = [controller.state];
      controller.show();
      await controller.finished;
      states.push(controller.state);
      const successfulEvents = [...events];
      const paths = [...document.querySelectorAll('.hana-mark-path')]
        .map((path) => path.getAttribute('d'));
      controller.hide();
      states.push(controller.state);
      const cancelEvents = events.filter((event) => event === 'cancel');
      for (const type of ['hana:start', 'hana:complete', 'hana:cancel']) {
        target.removeEventListener(type, listener);
      }
      return { states, successfulEvents, cancelEvents, paths };
    };

    let unregister = registerMark('serialize-wave', plugin);
    const original = annotate('#selector-target', {
      mark: 'serialize-wave',
      note: 'Before update',
      motion: 'never',
      duration: 0,
    });
    original.update({
      note: 'After update',
      placement: 'left',
      accessible: true,
    });
    const definition = serialize(original);
    const bytes = JSON.stringify(definition);
    const originalRun = await run(original);
    original.destroy();
    unregister();

    let missingPlugin;
    try {
      restore(definition);
    } catch (error) {
      missingPlugin = {
        name: error.name,
        code: error.code,
        field: error.details?.field,
      };
    }
    const missingPluginResidue = document.querySelectorAll('[data-hana-id]').length;

    unregister = registerMark('serialize-wave', plugin);
    const restored = restore(definition);
    const restoredBytes = JSON.stringify(serialize(restored));
    const restoredRun = await run(restored);
    restored.destroy();
    unregister();

    return {
      bytes,
      definition,
      restoredBytes,
      originalRun,
      restoredRun,
      missingPlugin,
      missingPluginResidue,
      ownedAfterDestroy: document.querySelectorAll('[data-hana-id]').length,
      overlaysAfterDestroy: document.querySelectorAll('[data-hana-overlay]').length,
    };
  });

  expect(result.restoredBytes).toBe(result.bytes);
  expect(result.definition).toMatchObject({
    schema: 'hanamaru/v1',
    kind: 'annotation',
    target: { type: 'selector', selector: '#selector-target' },
    options: {
      mark: 'serialize-wave',
      note: 'After update',
      placement: 'left',
      trigger: 'manual',
      accessible: true,
      duration: 0,
      motion: 'never',
    },
  });
  expect(result.definition.options.seed).toMatch(/^hana-\d+$/);
  expect(Object.keys(result.definition)).toEqual(['schema', 'kind', 'target', 'options']);
  expect(Object.keys(result.definition.options)).toEqual([
    'mark', 'note', 'placement', 'trigger',
    'accessible', 'seed', 'duration', 'motion',
  ]);
  expect(result.originalRun).toEqual(result.restoredRun);
  expect(result.restoredRun).toEqual({
    states: ['idle', 'visible', 'hidden'],
    successfulEvents: ['start', 'complete'],
    cancelEvents: ['cancel'],
    paths: ['M 1 2 Q 8 3 16 4'],
  });
  expect(result.missingPlugin).toEqual({
    name: 'HanamaruConfigError',
    code: 'HANA_CONFIG_INVALID',
    field: 'mark',
  });
  expect(result).toMatchObject({
    missingPluginResidue: 0,
    ownedAfterDestroy: 0,
    overlaysAfterDestroy: 0,
  });
  await expectNoBrowserFailures(page, pageErrors);
});

test('Annotation native Element and Range keys preserve exact contexts and visual round trips', async ({ page }) => {
  const pageErrors = await openFixture(page);
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const { restore, serialize } = await import('/src/serialize.js');
    const element = document.querySelector('#direct-target');
    const rangeHost = document.querySelector('#range-target');
    const range = document.createRange();
    range.setStart(rangeHost.firstChild, 1);
    range.setEnd(rangeHost.firstChild, rangeHost.firstChild.data.length - 1);
    const targets = new Map([
      ['element-key', element],
      ['range-key', range],
    ]);
    const cases = [
      { key: 'element-key', target: element, owner: element, mark: 'box', targetKind: 'element' },
      { key: 'range-key', target: range, owner: rangeHost, mark: 'underline', targetKind: 'range' },
    ];

    const execute = async (controller, owner) => {
      const events = [];
      const listener = (event) => {
        if (event.detail.controller === controller) {
          events.push(event.type.replace('hana:', ''));
        }
      };
      for (const type of ['hana:start', 'hana:complete', 'hana:cancel']) {
        owner.addEventListener(type, listener);
      }
      const states = [controller.state];
      controller.show();
      await controller.finished;
      states.push(controller.state);
      const successfulEvents = [...events];
      const paths = [...document.querySelectorAll('.hana-mark-path')]
        .map((path) => path.getAttribute('d'));
      controller.hide();
      states.push(controller.state);
      const cancels = events.filter((event) => event === 'cancel');
      for (const type of ['hana:start', 'hana:complete', 'hana:cancel']) {
        owner.removeEventListener(type, listener);
      }
      return { states, successfulEvents, cancels, paths };
    };

    const output = [];
    for (const item of cases) {
      const original = annotate(item.target, {
        mark: item.mark,
        motion: 'never',
        duration: 0,
        seed: `stable-${item.key}`,
      });
      const originalKeyCalls = [];
      const definition = serialize(original, {
        keyForTarget(target, context) {
          originalKeyCalls.push({
            sameTarget: target === item.target,
            keys: Object.keys(context),
            role: context.role,
            controllerKind: context.controllerKind,
            owner: context.ownerElement.id,
            index: context.index,
          });
          return item.key;
        },
      });
      const bytes = JSON.stringify(definition);
      const originalRun = await execute(original, item.owner);
      original.destroy();

      const resolverCalls = [];
      const restored = restore(definition, {
        root: document,
        resolveTarget(key, context) {
          resolverCalls.push({ key, keys: Object.keys(context), ...context });
          return targets.get(key);
        },
      });
      const restoredKeyCalls = [];
      const restoredBytes = JSON.stringify(serialize(restored, {
        keyForTarget(target, context) {
          restoredKeyCalls.push({
            native: item.targetKind === 'element'
              ? target instanceof Element
              : target instanceof Range,
            keys: Object.keys(context),
            role: context.role,
            controllerKind: context.controllerKind,
            owner: context.ownerElement.id,
            index: context.index,
          });
          return item.key;
        },
      }));
      const restoredRun = await execute(restored, item.owner);
      restored.destroy();

      output.push({
        key: item.key,
        targetKind: item.targetKind,
        bytes,
        definition,
        restoredBytes,
        originalKeyCalls,
        restoredKeyCalls,
        resolverCalls,
        originalRun,
        restoredRun,
      });
    }
    range.detach();
    return {
      output,
      owned: document.querySelectorAll('[data-hana-id]').length,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    };
  });

  expect(result.owned).toBe(0);
  expect(result.overlays).toBe(0);
  for (const item of result.output) {
    const expected = {
      schema: 'hanamaru/v1',
      kind: 'annotation',
      target: { type: 'key', key: item.key, targetKind: item.targetKind },
      options: {
        mark: item.targetKind === 'element' ? 'box' : 'underline',
        note: null,
        placement: 'auto',
        trigger: 'manual',
        accessible: false,
        seed: `stable-${item.key}`,
        duration: 0,
        motion: 'never',
      },
    };
    expect(item.definition).toEqual(expected);
    expect(item.bytes).toBe(JSON.stringify(expected));
    expect(Object.keys(item.definition)).toEqual(['schema', 'kind', 'target', 'options']);
    expect(Object.keys(item.definition.target)).toEqual(['type', 'key', 'targetKind']);
    expect(Object.keys(item.definition.options)).toEqual([
      'mark', 'note', 'placement', 'trigger',
      'accessible', 'seed', 'duration', 'motion',
    ]);
    expect(item.restoredBytes).toBe(item.bytes);
    expect(item.restoredRun).toEqual(item.originalRun);
    expect(item.restoredRun.states).toEqual(['idle', 'visible', 'hidden']);
    expect(item.restoredRun.successfulEvents).toEqual(['start', 'complete']);
    expect(item.restoredRun.cancels).toEqual(['cancel']);
    expect(item.restoredRun.paths.length).toBeGreaterThan(0);
    expect(item.originalRun.paths.every(
      (path) => typeof path === 'string' && path.length > 0,
    )).toBe(true);
    expect(item.restoredRun.paths.every(
      (path) => typeof path === 'string' && path.length > 0,
    )).toBe(true);
    expect(item.originalKeyCalls).toEqual([{
      sameTarget: true,
      keys: ['role', 'controllerKind', 'ownerElement', 'index'],
      role: 'target',
      controllerKind: 'annotation',
      owner: item.targetKind === 'element' ? 'direct-target' : 'range-target',
      index: null,
    }]);
    expect(item.restoredKeyCalls).toEqual([{
      native: true,
      keys: ['role', 'controllerKind', 'ownerElement', 'index'],
      role: 'target',
      controllerKind: 'annotation',
      owner: item.targetKind === 'element' ? 'direct-target' : 'range-target',
      index: null,
    }]);
    expect(item.resolverCalls).toEqual([{
      key: item.key,
      keys: ['targetKind', 'role', 'controllerKind', 'index'],
      targetKind: item.targetKind,
      role: 'target',
      controllerKind: 'annotation',
      index: null,
    }]);
  }
  await expectNoBrowserFailures(page, pageErrors);
});

test('Annotation exact-text locators round trip with selector and Element within sources', async ({ page }) => {
  const pageErrors = await openFixture(page);
  const result = await page.evaluate(async () => {
    const { annotate } = await import('/src/index.js');
    const { restore, serialize } = await import('/src/serialize.js');
    const selectorScope = document.body.appendChild(document.createElement('section'));
    selectorScope.id = 'locator-selector-scope';
    selectorScope.innerHTML = '<span>Selector exact phrase</span>';
    const elementScope = document.body.appendChild(document.createElement('section'));
    elementScope.id = 'locator-element-scope';
    elementScope.innerHTML = '<span>Element exact phrase</span>';
    const cases = [
      {
        key: null,
        source: { within: '#locator-selector-scope', text: 'Selector exact phrase' },
        owner: selectorScope,
      },
      {
        key: 'locator-scope',
        source: { within: elementScope, text: 'Element exact phrase' },
        owner: elementScope,
      },
    ];
    const output = [];

    for (const item of cases) {
      const keyCalls = [];
      const resolverCalls = [];
      const original = annotate(item.source, {
        mark: 'highlight',
        motion: 'never',
        duration: 0,
        seed: `locator-${item.key ?? 'selector'}`,
      });
      const keyForTarget = (target, context) => {
        keyCalls.push({
          sameWithin: target === elementScope,
          role: context.role,
          controllerKind: context.controllerKind,
          owner: context.ownerElement.id,
          index: context.index,
          keys: Object.keys(context),
        });
        return 'locator-scope';
      };
      const definition = serialize(
        original,
        item.key === null ? undefined : { keyForTarget },
      );
      const bytes = JSON.stringify(definition);
      const originalEvents = [];
      const originalStates = [original.state];
      const originalListener = (event) => {
        if (event.detail.controller === original) originalEvents.push(event.type);
      };
      item.owner.addEventListener('hana:start', originalListener);
      item.owner.addEventListener('hana:complete', originalListener);
      original.show();
      await original.finished;
      originalStates.push(original.state);
      const originalPathElements = [...document.querySelectorAll('.hana-mark-path')];
      const originalPaths = originalPathElements.map((path) => path.getAttribute('d'));
      const originalPathsValid = originalPathElements.every((path) => {
        const d = path.getAttribute('d');
        try {
          return typeof d === 'string' && d.length > 0
            && Number.isFinite(path.getTotalLength());
        } catch {
          return false;
        }
      });
      original.destroy();
      item.owner.removeEventListener('hana:start', originalListener);
      item.owner.removeEventListener('hana:complete', originalListener);

      const restored = restore(definition, item.key === null ? undefined : {
        root: document,
        resolveTarget(key, context) {
          resolverCalls.push({ key, keys: Object.keys(context), ...context });
          return elementScope;
        },
      });
      const restoredBytes = JSON.stringify(serialize(
        restored,
        item.key === null ? undefined : { keyForTarget },
      ));
      const restoredEvents = [];
      const restoredStates = [restored.state];
      const restoredListener = (event) => {
        if (event.detail.controller === restored) restoredEvents.push(event.type);
      };
      item.owner.addEventListener('hana:start', restoredListener);
      item.owner.addEventListener('hana:complete', restoredListener);
      restored.show();
      await restored.finished;
      restoredStates.push(restored.state);
      const restoredPathElements = [...document.querySelectorAll('.hana-mark-path')];
      const restoredPaths = restoredPathElements.map((path) => path.getAttribute('d'));
      const restoredPathsValid = restoredPathElements.every((path) => {
        const d = path.getAttribute('d');
        try {
          return typeof d === 'string' && d.length > 0
            && Number.isFinite(path.getTotalLength());
        } catch {
          return false;
        }
      });
      restored.destroy();
      item.owner.removeEventListener('hana:start', restoredListener);
      item.owner.removeEventListener('hana:complete', restoredListener);
      output.push({
        key: item.key,
        bytes,
        restoredBytes,
        definition,
        keyCalls,
        resolverCalls,
        originalEvents,
        restoredEvents,
        originalStates,
        restoredStates,
        originalPaths,
        originalPathsValid,
        restoredPaths,
        restoredPathsValid,
      });
    }
    selectorScope.remove();
    elementScope.remove();
    return {
      output,
      owned: document.querySelectorAll('[data-hana-id]').length,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    };
  });

  expect(result.owned).toBe(0);
  expect(result.overlays).toBe(0);
  for (const item of result.output) {
    const expected = {
      schema: 'hanamaru/v1',
      kind: 'annotation',
      target: item.key === null
        ? {
          type: 'locator',
          within: { type: 'selector', selector: '#locator-selector-scope' },
          text: 'Selector exact phrase',
        }
        : {
          type: 'locator',
          within: { type: 'key', key: 'locator-scope', targetKind: 'element' },
          text: 'Element exact phrase',
        },
      options: {
        mark: 'highlight',
        note: null,
        placement: 'auto',
        trigger: 'manual',
        accessible: false,
        seed: `locator-${item.key ?? 'selector'}`,
        duration: 0,
        motion: 'never',
      },
    };
    expect(item.definition).toEqual(expected);
    expect(item.bytes).toBe(JSON.stringify(expected));
    expect(Object.keys(item.definition)).toEqual(['schema', 'kind', 'target', 'options']);
    expect(Object.keys(item.definition.target)).toEqual(['type', 'within', 'text']);
    expect(Object.hasOwn(item.definition.target, 'occurrence')).toBe(false);
    expect(Object.keys(item.definition.target.within)).toEqual(
      item.key === null
        ? ['type', 'selector']
        : ['type', 'key', 'targetKind'],
    );
    expect(Object.keys(item.definition.options)).toEqual([
      'mark', 'note', 'placement', 'trigger',
      'accessible', 'seed', 'duration', 'motion',
    ]);
    expect(item.restoredBytes).toBe(item.bytes);
    expect(item.originalPaths.length).toBeGreaterThan(0);
    expect(item.originalPaths.every(
      (path) => typeof path === 'string' && path.length > 0,
    )).toBe(true);
    expect(item.originalPathsValid).toBe(true);
    expect(item.restoredPaths.length).toBeGreaterThan(0);
    expect(item.restoredPaths.every(
      (path) => typeof path === 'string' && path.length > 0,
    )).toBe(true);
    expect(item.restoredPathsValid).toBe(true);
    expect(item.restoredPaths).toEqual(item.originalPaths);
    expect(item.restoredEvents).toEqual(['hana:start', 'hana:complete']);
    expect(item.restoredEvents).toEqual(item.originalEvents);
    expect(item.restoredStates).toEqual(['idle', 'visible']);
    expect(item.restoredStates).toEqual(item.originalStates);
    expect(item.definition.target.type).toBe('locator');
    if (item.key === null) {
      expect(item.definition.target.within).toEqual({
        type: 'selector',
        selector: '#locator-selector-scope',
      });
      expect(item.keyCalls).toEqual([]);
      expect(item.resolverCalls).toEqual([]);
    } else {
      expect(item.definition.target.within).toEqual({
        type: 'key',
        key: 'locator-scope',
        targetKind: 'element',
      });
      expect(item.keyCalls).toEqual([
        {
          sameWithin: true,
          role: 'within',
          controllerKind: 'annotation',
          owner: 'locator-element-scope',
          index: null,
          keys: ['role', 'controllerKind', 'ownerElement', 'index'],
        },
        {
          sameWithin: true,
          role: 'within',
          controllerKind: 'annotation',
          owner: 'locator-element-scope',
          index: null,
          keys: ['role', 'controllerKind', 'ownerElement', 'index'],
        },
      ]);
      expect(item.resolverCalls).toEqual([{
        key: 'locator-scope',
        keys: ['targetKind', 'role', 'controllerKind', 'index'],
        targetKind: 'element',
        role: 'within',
        controllerKind: 'annotation',
        index: null,
      }]);
    }
  }
  await expectNoBrowserFailures(page, pageErrors);
});

test('Annotation iframe Document root preserves realm, bytes, paths, state, and events', async ({ page }) => {
  const pageErrors = await openFixture(page);
  const result = await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    frame.srcdoc = `<!doctype html><html><body style="margin:30px">
      <p id="frame-target" style="display:inline-block">Iframe serialized target</p>
    </body></html>`;
    document.body.append(frame);
    await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    const target = doc.querySelector('#frame-target');
    const { annotate } = await import('/src/index.js');
    const { restore, serialize } = await import('/src/serialize.js');

    const run = async (controller) => {
      const events = [];
      const parentEvents = [];
      const listener = (event) => {
        if (event.detail.controller === controller) {
          events.push({
            type: event.type,
            frameRealm: event instanceof win.CustomEvent,
            target: event.target.id,
          });
        }
      };
      const parentListener = (event) => parentEvents.push(event.type);
      doc.body.addEventListener('hana:start', listener);
      doc.body.addEventListener('hana:complete', listener);
      document.body.addEventListener('hana:start', parentListener);
      document.body.addEventListener('hana:complete', parentListener);
      const states = [controller.state];
      controller.show();
      await controller.finished;
      states.push(controller.state);
      const paths = [...doc.querySelectorAll('.hana-mark-path')]
        .map((path) => path.getAttribute('d'));
      doc.body.removeEventListener('hana:start', listener);
      doc.body.removeEventListener('hana:complete', listener);
      document.body.removeEventListener('hana:start', parentListener);
      document.body.removeEventListener('hana:complete', parentListener);
      return { states, events, parentEvents, paths };
    };

    const keyCalls = [];
    const keyForTarget = (value, context) => {
      keyCalls.push({
        native: value instanceof win.Element,
        owner: context.ownerElement.id,
        role: context.role,
        controllerKind: context.controllerKind,
        index: context.index,
      });
      return 'iframe-target';
    };
    const original = annotate(target, {
      mark: 'circle',
      motion: 'never',
      duration: 0,
      seed: 'iframe-stable',
    });
    const definition = serialize(original, { keyForTarget });
    const bytes = JSON.stringify(definition);
    const originalRun = await run(original);
    original.destroy();
    const resolverCalls = [];
    const restored = restore(definition, {
      root: doc,
      resolveTarget(key, context) {
        resolverCalls.push({ key, keys: Object.keys(context), ...context });
        return target;
      },
    });
    const restoredBytes = JSON.stringify(serialize(restored, { keyForTarget }));
    const restoredRun = await run(restored);
    restored.destroy();
    const cleanup = {
      frameOwned: doc.querySelectorAll('[data-hana-id]').length,
      frameOverlays: doc.querySelectorAll('[data-hana-overlay]').length,
      parentOwned: document.querySelectorAll('[data-hana-id]').length,
      parentOverlays: document.querySelectorAll('[data-hana-overlay]').length,
    };
    frame.remove();
    return {
      bytes,
      definition,
      restoredBytes,
      originalRun,
      restoredRun,
      cleanup,
      keyCalls,
      resolverCalls,
    };
  });

  const expected = {
    schema: 'hanamaru/v1',
    kind: 'annotation',
    target: { type: 'key', key: 'iframe-target', targetKind: 'element' },
    options: {
      mark: 'circle',
      note: null,
      placement: 'auto',
      trigger: 'manual',
      accessible: false,
      seed: 'iframe-stable',
      duration: 0,
      motion: 'never',
    },
  };
  expect(result.definition).toEqual(expected);
  expect(result.bytes).toBe(JSON.stringify(expected));
  expect(Object.keys(result.definition)).toEqual(['schema', 'kind', 'target', 'options']);
  expect(Object.keys(result.definition.target)).toEqual(['type', 'key', 'targetKind']);
  expect(Object.keys(result.definition.options)).toEqual([
    'mark', 'note', 'placement', 'trigger',
    'accessible', 'seed', 'duration', 'motion',
  ]);
  expect(result.restoredBytes).toBe(result.bytes);
  expect(result.restoredRun).toEqual(result.originalRun);
  expect(result.restoredRun).toEqual({
    states: ['idle', 'visible'],
    events: [
      { type: 'hana:start', frameRealm: true, target: 'frame-target' },
      { type: 'hana:complete', frameRealm: true, target: 'frame-target' },
    ],
    parentEvents: [],
    paths: result.originalRun.paths,
  });
  expect(result.originalRun.paths.length).toBeGreaterThan(0);
  expect(result.originalRun.paths.every(
    (path) => typeof path === 'string' && path.length > 0,
  )).toBe(true);
  expect(result.restoredRun.paths.every(
    (path) => typeof path === 'string' && path.length > 0,
  )).toBe(true);
  expect(result.keyCalls).toEqual([
    {
      native: true,
      owner: 'frame-target',
      role: 'target',
      controllerKind: 'annotation',
      index: null,
    },
    {
      native: true,
      owner: 'frame-target',
      role: 'target',
      controllerKind: 'annotation',
      index: null,
    },
  ]);
  expect(result.resolverCalls).toEqual([{
    key: 'iframe-target',
    keys: ['targetKind', 'role', 'controllerKind', 'index'],
    targetKind: 'element',
    role: 'target',
    controllerKind: 'annotation',
    index: null,
  }]);
  expect(result.cleanup).toEqual({
    frameOwned: 0,
    frameOverlays: 0,
    parentOwned: 0,
    parentOverlays: 0,
  });
  await expectNoBrowserFailures(page, pageErrors);
});

test('target isolated Range resolution clones exact boundaries and standalone ShadowRoot APIs reject', async ({ page }) => {
  const pageErrors = await openFixture(page);
  const result = await page.evaluate(async () => {
    const { resolveSerializedTarget, restore } = await import('/src/serialize.js');
    const host = document.querySelector('#range-target');
    const range = document.createRange();
    range.setStart(host.firstChild, 2);
    range.setEnd(host.firstChild, 9);
    const calls = [];
    const clone = resolveSerializedTarget({
      type: 'key',
      key: 'isolated-range',
      targetKind: 'range',
    }, {
      root: document,
      resolveTarget(key, context) {
        calls.push({ key, keys: Object.keys(context), ...context });
        return range;
      },
    });

    const shadowHost = document.body.appendChild(document.createElement('div'));
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    const shadowTarget = shadow.appendChild(document.createElement('span'));
    shadowTarget.id = 'shadow-target';
    const outcomes = [];
    for (const action of [
      () => resolveSerializedTarget(
        { type: 'selector', selector: '#shadow-target' },
        { root: shadow },
      ),
      () => restore({
        schema: 'hanamaru/v1',
        kind: 'annotation',
        target: { type: 'selector', selector: '#shadow-target' },
        options: {
          mark: 'underline',
          note: null,
          placement: 'auto',
          trigger: 'manual',
          accessible: false,
          seed: 'shadow-standalone',
          duration: 0,
          motion: 'never',
        },
      }, { root: shadow }),
    ]) {
      try {
        action();
        outcomes.push({ returned: true });
      } catch (error) {
        outcomes.push({ returned: false, name: error.name, code: error.code });
      }
    }
    const proof = {
      distinct: clone !== range,
      native: clone instanceof Range,
      startContainer: clone.startContainer === range.startContainer,
      endContainer: clone.endContainer === range.endContainer,
      startOffset: clone.startOffset,
      endOffset: clone.endOffset,
      calls,
      outcomes,
      shadowOwned: shadow.querySelectorAll('[data-hana-id]').length,
      documentOwned: document.querySelectorAll('[data-hana-id]').length,
    };
    clone.detach();
    range.detach();
    shadowHost.remove();
    return proof;
  });

  expect(result).toEqual({
    distinct: true,
    native: true,
    startContainer: true,
    endContainer: true,
    startOffset: 2,
    endOffset: 9,
    calls: [{
      key: 'isolated-range',
      keys: ['targetKind', 'role', 'controllerKind', 'index'],
      targetKind: 'range',
      role: 'target',
      controllerKind: null,
      index: null,
    }],
    outcomes: [
      {
        returned: false,
        name: 'HanamaruTargetError',
        code: 'HANA_TARGET_SHADOW_UNSCOPED',
      },
      {
        returned: false,
        name: 'HanamaruTargetError',
        code: 'HANA_TARGET_SHADOW_UNSCOPED',
      },
    ],
    shadowOwned: 0,
    documentOwned: 0,
  });
  await expectNoBrowserFailures(page, pageErrors);
});

test('Story round trip preserves every member source form, generated seeds, plugin paths, and lifecycle', async ({ page }) => {
  const pageErrors = await openFixture(page, '/tests/fixtures/story.html');
  const result = await page.evaluate(async () => {
    const { registerMark } = await import('/src/plugins.js');
    const { restore, serialize } = await import('/src/serialize.js');
    const { story } = await import('/src/story.js');
    const arena = document.querySelector('#story-arena');
    const direct = arena.appendChild(document.createElement('p'));
    direct.id = 'story-direct-key';
    direct.className = 'target';
    direct.textContent = 'Story direct key';
    const rangeHost = arena.appendChild(document.createElement('p'));
    rangeHost.id = 'story-range-key';
    rangeHost.className = 'target';
    rangeHost.textContent = 'Story native range selection';
    const range = document.createRange();
    range.setStart(rangeHost.firstChild, 6);
    range.setEnd(rangeHost.firstChild, 18);
    const selectorScope = arena.appendChild(document.createElement('p'));
    selectorScope.id = 'story-selector-scope';
    selectorScope.className = 'target';
    selectorScope.textContent = 'A selector scoped exact phrase lives here';
    const elementScope = arena.appendChild(document.createElement('p'));
    elementScope.id = 'story-element-scope';
    elementScope.className = 'target';
    elementScope.textContent = 'An element scoped exact phrase lives here';

    const pluginFactory = () => ({ paths: ['M 2 3 L 22 13'] });
    let unregister = registerMark('story-proof', pluginFactory);
    const steps = [
      { target: '#story-first', mark: 'underline', duration: 0 },
      { target: direct, mark: 'box', duration: 0 },
      { target: range, mark: 'highlight', duration: 0 },
      {
        target: { within: '#story-selector-scope', text: 'selector scoped exact phrase' },
        mark: 'circle',
        duration: 0,
      },
      {
        target: { within: elementScope, text: 'element scoped exact phrase' },
        mark: 'story-proof',
        duration: 0,
      },
    ];
    const targetByKey = new Map([
      ['story-target-1', direct],
      ['story-target-2', range],
      ['story-within-4', elementScope],
    ]);
    const contextSnapshot = (context) => ({
      keys: Object.keys(context),
      role: context.role,
      controllerKind: context.controllerKind,
      owner: context.ownerElement?.id,
      index: context.index,
    });
    const keyForTarget = (target, context) => (
      `story-${context.role}-${context.index}`
    );
    const memberIndexByOwner = new Map([
      ['story-first', 0],
      ['story-direct-key', 1],
      ['story-range-key', 2],
      ['story-selector-scope', 3],
      ['story-element-scope', 4],
    ]);
    const pathInventory = () => [...document.querySelectorAll('.hana-annotation')]
      .map((group, index) => {
        const elements = [...group.querySelectorAll('.hana-mark-path')];
        return {
          index,
          mark: group.getAttribute('data-hana-mark'),
          paths: elements.map((path) => path.getAttribute('d')),
          valid: elements.every((path) => {
            const d = path.getAttribute('d');
            try {
              return typeof d === 'string' && d.length > 0
                && Number.isFinite(path.getTotalLength());
            } catch {
              return false;
            }
          }),
        };
      });
    const execute = async (controller) => {
      const events = [];
      const memberControllers = new Map();
      const listener = (event) => {
        const aggregate = event.detail.controller === controller;
        const memberIndex = aggregate
          ? null
          : memberIndexByOwner.get(event.target.id);
        if (!aggregate && memberIndex !== undefined) {
          memberControllers.set(event.detail.controller, memberIndex);
        }
        events.push({
          type: event.type,
          scope: aggregate ? 'story' : 'member',
          memberIndex: memberIndex ?? null,
          target: event.target.id,
          index: event.detail.index ?? null,
          state: event.detail.state ?? null,
        });
      };
      for (const type of ['hana:start', 'hana:step', 'hana:complete', 'hana:cancel']) {
        document.body.addEventListener(type, listener);
      }
      const states = [controller.state];
      controller.play();
      states.push(controller.state);
      await controller.finished;
      states.push(controller.state);
      const successfulEvents = [...events];
      const paths = pathInventory();
      events.length = 0;
      controller.replay();
      controller.cancel();
      const cancellation = {
        state: controller.state,
        events: [...events],
        cancelEvents: events.filter((event) => event.type === 'hana:cancel'),
        memberStates: [...memberControllers]
          .map(([member, index]) => ({ index, state: member.state }))
          .sort((left, right) => left.index - right.index),
      };
      for (const type of ['hana:start', 'hana:step', 'hana:complete', 'hana:cancel']) {
        document.body.removeEventListener(type, listener);
      }
      return { states, successfulEvents, paths, cancellation };
    };

    const original = story(steps, { gap: 0, motion: 'never' });
    const originalKeyCalls = [];
    const definition = serialize(original, {
      keyForTarget(target, context) {
        originalKeyCalls.push({
          ...contextSnapshot(context),
          nativeElement: target instanceof Element,
          nativeRange: target instanceof Range,
        });
        return keyForTarget(target, context);
      },
    });
    const bytes = JSON.stringify(definition);
    const originalRun = await execute(original);
    original.destroy();
    unregister();

    let missingPlugin;
    let missingResolverCalls = 0;
    const missingEvents = [];
    const missingListener = (event) => missingEvents.push(event.type);
    for (const type of ['hana:start', 'hana:step', 'hana:complete']) {
      document.body.addEventListener(type, missingListener);
    }
    try {
      restore(definition, {
        root: document,
        resolveTarget() {
          missingResolverCalls += 1;
          return direct;
        },
      });
    } catch (error) {
      missingPlugin = { name: error.name, code: error.code, field: error.details?.field };
    }
    for (const type of ['hana:start', 'hana:step', 'hana:complete']) {
      document.body.removeEventListener(type, missingListener);
    }
    const missingResidue = {
      owned: document.querySelectorAll('[data-hana-id]').length,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      events: missingEvents,
      resolverCalls: missingResolverCalls,
    };

    unregister = registerMark('story-proof', pluginFactory);
    const resolverCalls = [];
    const restored = restore(definition, {
      root: document,
      resolveTarget(key, context) {
        resolverCalls.push({
          key,
          keys: Object.keys(context),
          targetKind: context.targetKind,
          role: context.role,
          controllerKind: context.controllerKind,
          index: context.index,
        });
        return targetByKey.get(key);
      },
    });
    const restoredKeyCalls = [];
    const restoredBytes = JSON.stringify(serialize(restored, {
      keyForTarget(target, context) {
        restoredKeyCalls.push({
          ...contextSnapshot(context),
          nativeElement: target instanceof Element,
          nativeRange: target instanceof Range,
        });
        return keyForTarget(target, context);
      },
    }));
    const restoredRun = await execute(restored);
    restored.destroy();
    unregister();

    const cleanup = {
      owned: document.querySelectorAll('[data-hana-id]').length,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    };
    range.detach();
    direct.remove();
    rangeHost.remove();
    selectorScope.remove();
    elementScope.remove();
    return {
      bytes,
      restoredBytes,
      definition,
      originalKeyCalls,
      restoredKeyCalls,
      resolverCalls,
      originalRun,
      restoredRun,
      missingPlugin,
      missingResidue,
      cleanup,
    };
  });

  expect(result.restoredBytes).toBe(result.bytes);
  expect(Object.keys(result.definition)).toEqual(['schema', 'kind', 'options', 'steps']);
  expect(Object.keys(result.definition.options)).toEqual(['trigger', 'gap', 'motion']);
  expect(result.definition.steps).toHaveLength(5);
  expect(result.definition.steps.every(
    (step) => Object.keys(step).join(',') === 'target,options',
  )).toBe(true);
  expect(result.definition.steps.every(
    ({ options }) => Object.keys(options).join(',')
      === 'mark,note,placement,accessible,seed,duration',
  )).toBe(true);
  expect(result.definition.steps.every(
    ({ options }) => /^hana-\d+$/.test(options.seed),
  )).toBe(true);
  const seeds = result.definition.steps.map(({ options }) => options.seed);
  expect(new Set(seeds).size).toBe(5);
  const memberOptions = (mark, seed) => ({
    mark,
    note: null,
    placement: 'auto',
    accessible: false,
    seed,
    duration: 0,
  });
  const expected = {
    schema: 'hanamaru/v1',
    kind: 'story',
    options: { trigger: 'manual', gap: 0, motion: 'never' },
    steps: [
      {
        target: { type: 'selector', selector: '#story-first' },
        options: memberOptions('underline', seeds[0]),
      },
      {
        target: { type: 'key', key: 'story-target-1', targetKind: 'element' },
        options: memberOptions('box', seeds[1]),
      },
      {
        target: { type: 'key', key: 'story-target-2', targetKind: 'range' },
        options: memberOptions('highlight', seeds[2]),
      },
      {
        target: {
          type: 'locator',
          within: { type: 'selector', selector: '#story-selector-scope' },
          text: 'selector scoped exact phrase',
        },
        options: memberOptions('circle', seeds[3]),
      },
      {
        target: {
          type: 'locator',
          within: { type: 'key', key: 'story-within-4', targetKind: 'element' },
          text: 'element scoped exact phrase',
        },
        options: memberOptions('story-proof', seeds[4]),
      },
    ],
  };
  expect(result.definition).toEqual(expected);
  expect(result.bytes).toBe(JSON.stringify(expected));
  expect(result.originalRun).toEqual(result.restoredRun);
  expect(result.restoredRun.states).toEqual(['idle', 'playing', 'complete']);
  expect(result.restoredRun.paths).toHaveLength(5);
  expect(result.restoredRun.paths.map(({ index, mark }) => ({ index, mark }))).toEqual([
    { index: 0, mark: 'underline' },
    { index: 1, mark: 'box' },
    { index: 2, mark: 'highlight' },
    { index: 3, mark: 'circle' },
    { index: 4, mark: 'story-proof' },
  ]);
  for (const member of result.restoredRun.paths) {
    expect(member.valid).toBe(true);
    expect(member.paths.length).toBeGreaterThan(0);
    expect(member.paths.every(
      (path) => typeof path === 'string' && path.length > 0,
    )).toBe(true);
  }
  for (const member of result.originalRun.paths) {
    expect(member.valid).toBe(true);
    expect(member.paths.length).toBeGreaterThan(0);
    expect(member.paths.every(
      (path) => typeof path === 'string' && path.length > 0,
    )).toBe(true);
  }
  expect(result.restoredRun.paths[4].paths).toEqual(['M 2 3 L 22 13']);
  expect(result.restoredRun.successfulEvents
    .filter(({ scope }) => scope === 'story')
    .map(({ type }) => type)).toEqual([
    'hana:start',
    'hana:step',
    'hana:step',
    'hana:step',
    'hana:step',
    'hana:step',
    'hana:complete',
  ]);
  expect({
    state: result.restoredRun.cancellation.state,
    cancelEvents: result.restoredRun.cancellation.cancelEvents,
    memberStates: result.restoredRun.cancellation.memberStates,
  }).toEqual({
    state: 'cancelled',
    cancelEvents: [
      {
        type: 'hana:cancel', scope: 'member', memberIndex: 0,
        target: 'story-first', index: null, state: null,
      },
      {
        type: 'hana:cancel', scope: 'member', memberIndex: 1,
        target: 'story-direct-key', index: null, state: null,
      },
      {
        type: 'hana:cancel', scope: 'member', memberIndex: 2,
        target: 'story-range-key', index: null, state: null,
      },
      {
        type: 'hana:cancel', scope: 'member', memberIndex: 3,
        target: 'story-selector-scope', index: null, state: null,
      },
      {
        type: 'hana:cancel', scope: 'member', memberIndex: 4,
        target: 'story-element-scope', index: null, state: null,
      },
      {
        type: 'hana:cancel', scope: 'story', memberIndex: null,
        target: 'story-first', index: null, state: null,
      },
    ],
    memberStates: [
      { index: 0, state: 'visible' },
      { index: 1, state: 'hidden' },
      { index: 2, state: 'hidden' },
      { index: 3, state: 'hidden' },
      { index: 4, state: 'hidden' },
    ],
  });
  expect(result.restoredRun.cancellation.events.map(
    ({ type, scope, memberIndex }) => ({ type, scope, memberIndex }),
  )).toEqual([
    { type: 'hana:cancel', scope: 'member', memberIndex: 0 },
    { type: 'hana:cancel', scope: 'member', memberIndex: 1 },
    { type: 'hana:cancel', scope: 'member', memberIndex: 2 },
    { type: 'hana:cancel', scope: 'member', memberIndex: 3 },
    { type: 'hana:cancel', scope: 'member', memberIndex: 4 },
    { type: 'hana:start', scope: 'story', memberIndex: null },
    { type: 'hana:step', scope: 'story', memberIndex: null },
    { type: 'hana:start', scope: 'member', memberIndex: 0 },
    { type: 'hana:complete', scope: 'member', memberIndex: 0 },
    { type: 'hana:cancel', scope: 'story', memberIndex: null },
  ]);
  expect(result.originalKeyCalls).toEqual([
    {
      keys: ['role', 'controllerKind', 'ownerElement', 'index'],
      role: 'target',
      controllerKind: 'story',
      owner: 'story-direct-key',
      index: 1,
      nativeElement: true,
      nativeRange: false,
    },
    {
      keys: ['role', 'controllerKind', 'ownerElement', 'index'],
      role: 'target',
      controllerKind: 'story',
      owner: 'story-range-key',
      index: 2,
      nativeElement: false,
      nativeRange: true,
    },
    {
      keys: ['role', 'controllerKind', 'ownerElement', 'index'],
      role: 'within',
      controllerKind: 'story',
      owner: 'story-element-scope',
      index: 4,
      nativeElement: true,
      nativeRange: false,
    },
  ]);
  expect(result.restoredKeyCalls).toEqual(result.originalKeyCalls);
  expect(result.resolverCalls).toEqual([
    {
      key: 'story-target-1',
      keys: ['targetKind', 'role', 'controllerKind', 'index'],
      targetKind: 'element',
      role: 'target',
      controllerKind: 'story',
      index: 1,
    },
    {
      key: 'story-target-2',
      keys: ['targetKind', 'role', 'controllerKind', 'index'],
      targetKind: 'range',
      role: 'target',
      controllerKind: 'story',
      index: 2,
    },
    {
      key: 'story-within-4',
      keys: ['targetKind', 'role', 'controllerKind', 'index'],
      targetKind: 'element',
      role: 'within',
      controllerKind: 'story',
      index: 4,
    },
  ]);
  expect(result.missingPlugin).toEqual({
    name: 'HanamaruConfigError',
    code: 'HANA_CONFIG_INVALID',
    field: 'mark',
  });
  expect(result.missingResidue).toEqual({
    owned: 0,
    overlays: 0,
    events: [],
    resolverCalls: 0,
  });
  expect(result.cleanup).toEqual({ owned: 0, overlays: 0 });
  await expectNoBrowserFailures(page, pageErrors);
});

test('Group round trip preserves every member source form, generated seeds, plugin paths, and lifecycle', async ({ page }) => {
  const pageErrors = await openFixture(page, '/tests/fixtures/group.html');
  const result = await page.evaluate(async () => {
    const { group } = await import('/src/group.js');
    const { registerMark } = await import('/src/plugins.js');
    const { runtimeState } = await import('/src/runtime-state.js');
    const { restore, serialize } = await import('/src/serialize.js');
    const root = document.querySelector('main');
    const direct = root.appendChild(document.createElement('p'));
    direct.id = 'group-direct-key';
    direct.className = 'target';
    direct.textContent = 'Group direct key';
    const rangeHost = root.appendChild(document.createElement('p'));
    rangeHost.id = 'group-range-key';
    rangeHost.className = 'target';
    rangeHost.textContent = 'Group native range selection';
    const range = document.createRange();
    range.setStart(rangeHost.firstChild, 6);
    range.setEnd(rangeHost.firstChild, 18);
    const selectorScope = root.appendChild(document.createElement('p'));
    selectorScope.id = 'group-selector-scope';
    selectorScope.className = 'target';
    selectorScope.textContent = 'Repeated selector exact phrase and selector exact phrase';
    const elementScope = root.appendChild(document.createElement('p'));
    elementScope.id = 'group-element-scope';
    elementScope.className = 'target';
    elementScope.textContent = 'An element scoped exact phrase lives here';

    const pluginFactory = () => ({ paths: ['M 4 5 Q 14 7 24 15'] });
    let unregister = registerMark('group-proof', pluginFactory);
    const members = [
      { target: '#group-first', mark: 'underline', duration: 0 },
      { target: direct, mark: 'box', duration: 0 },
      { target: range, mark: 'highlight', duration: 0 },
      {
        target: {
          within: '#group-selector-scope',
          text: 'selector exact phrase',
          occurrence: 1,
        },
        mark: 'circle',
        duration: 0,
      },
      {
        target: { within: elementScope, text: 'element scoped exact phrase' },
        mark: 'group-proof',
        duration: 0,
      },
    ];
    const targetByKey = new Map([
      ['group-target-1', direct],
      ['group-target-2', range],
      ['group-within-4', elementScope],
    ]);
    const contextSnapshot = (context) => ({
      keys: Object.keys(context),
      role: context.role,
      controllerKind: context.controllerKind,
      owner: context.ownerElement?.id,
      index: context.index,
    });
    const keyForTarget = (target, context) => (
      `group-${context.role}-${context.index}`
    );
    const memberIndexByOwner = new Map([
      ['group-first', 0],
      ['group-direct-key', 1],
      ['group-range-key', 2],
      ['group-selector-scope', 3],
      ['group-element-scope', 4],
    ]);
    const pathInventory = () => [...document.querySelectorAll('.hana-annotation')]
      .map((annotation, index) => {
        const elements = [...annotation.querySelectorAll('.hana-mark-path')];
        return {
          index,
          mark: annotation.getAttribute('data-hana-mark'),
          paths: elements.map((path) => path.getAttribute('d')),
          valid: elements.every((path) => {
            const d = path.getAttribute('d');
            try {
              return typeof d === 'string' && d.length > 0
                && Number.isFinite(path.getTotalLength());
            } catch {
              return false;
            }
          }),
        };
      });
    const captureMemberControllers = (create) => {
      const metadata = runtimeState.metadata;
      const priorDescriptor = Object.getOwnPropertyDescriptor(metadata, 'set');
      const set = metadata.set;
      const members = [];
      Object.defineProperty(metadata, 'set', {
        configurable: true,
        value(controller, value) {
          const result = Reflect.apply(set, this, [controller, value]);
          if (value?.kind === 'annotation') members.push(controller);
          return result;
        },
        writable: true,
      });
      let controller;
      try {
        controller = create();
      } finally {
        if (priorDescriptor === undefined) delete metadata.set;
        else Object.defineProperty(metadata, 'set', priorDescriptor);
      }
      return {
        controller,
        members,
        instrumentationRestored: priorDescriptor === undefined
          ? !Object.hasOwn(metadata, 'set') && metadata.set === set
          : Object.getOwnPropertyDescriptor(metadata, 'set').value
            === priorDescriptor.value,
      };
    };
    const execute = async (controller, capturedMembers) => {
      const events = [];
      const memberControllers = new Map(
        capturedMembers.map((member, index) => [member, index]),
      );
      const listener = (event) => {
        const aggregate = event.detail.controller === controller;
        const memberIndex = aggregate
          ? null
          : memberIndexByOwner.get(event.target.id);
        if (!aggregate && memberIndex !== undefined) {
          memberControllers.set(event.detail.controller, memberIndex);
        }
        events.push({
          type: event.type,
          scope: aggregate ? 'group' : 'member',
          memberIndex: memberIndex ?? null,
          target: event.target.id,
          index: event.detail.index ?? null,
          state: event.detail.state ?? null,
        });
      };
      for (const type of ['hana:start', 'hana:complete', 'hana:cancel']) {
        document.body.addEventListener(type, listener);
      }
      const states = [controller.state];
      controller.show();
      states.push(controller.state);
      await controller.finished;
      states.push(controller.state);
      const successfulEvents = [...events];
      const paths = pathInventory();
      events.length = 0;
      controller.hide();
      const cancellation = {
        state: controller.state,
        events: [...events],
        cancelEvents: events.filter((event) => event.type === 'hana:cancel'),
        memberStates: [...memberControllers]
          .map(([member, index]) => ({ index, state: member.state }))
          .sort((left, right) => left.index - right.index),
      };
      for (const type of ['hana:start', 'hana:complete', 'hana:cancel']) {
        document.body.removeEventListener(type, listener);
      }
      return { states, successfulEvents, paths, cancellation };
    };

    const originalCapture = captureMemberControllers(
      () => group(members, { trigger: 'manual', motion: 'never' }),
    );
    const original = originalCapture.controller;
    const originalKeyCalls = [];
    const definition = serialize(original, {
      keyForTarget(target, context) {
        originalKeyCalls.push({
          ...contextSnapshot(context),
          nativeElement: target instanceof Element,
          nativeRange: target instanceof Range,
        });
        return keyForTarget(target, context);
      },
    });
    const bytes = JSON.stringify(definition);
    const originalRun = await execute(original, originalCapture.members);
    original.destroy();
    unregister();

    let missingPlugin;
    let missingResolverCalls = 0;
    const missingEvents = [];
    const missingListener = (event) => missingEvents.push(event.type);
    for (const type of ['hana:start', 'hana:complete']) {
      document.body.addEventListener(type, missingListener);
    }
    try {
      restore(definition, {
        root: document,
        resolveTarget() {
          missingResolverCalls += 1;
          return direct;
        },
      });
    } catch (error) {
      missingPlugin = { name: error.name, code: error.code, field: error.details?.field };
    }
    for (const type of ['hana:start', 'hana:complete']) {
      document.body.removeEventListener(type, missingListener);
    }
    const missingResidue = {
      owned: document.querySelectorAll('[data-hana-id]').length,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      events: missingEvents,
      resolverCalls: missingResolverCalls,
    };

    unregister = registerMark('group-proof', pluginFactory);
    const resolverCalls = [];
    const restoredCapture = captureMemberControllers(() => restore(definition, {
      root: document,
      resolveTarget(key, context) {
        resolverCalls.push({
          key,
          keys: Object.keys(context),
          targetKind: context.targetKind,
          role: context.role,
          controllerKind: context.controllerKind,
          index: context.index,
        });
        return targetByKey.get(key);
      },
    }));
    const restored = restoredCapture.controller;
    const restoredKeyCalls = [];
    const restoredBytes = JSON.stringify(serialize(restored, {
      keyForTarget(target, context) {
        restoredKeyCalls.push({
          ...contextSnapshot(context),
          nativeElement: target instanceof Element,
          nativeRange: target instanceof Range,
        });
        return keyForTarget(target, context);
      },
    }));
    const restoredRun = await execute(restored, restoredCapture.members);
    restored.destroy();
    unregister();

    const cleanup = {
      owned: document.querySelectorAll('[data-hana-id]').length,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    };
    range.detach();
    direct.remove();
    rangeHost.remove();
    selectorScope.remove();
    elementScope.remove();
    return {
      bytes,
      restoredBytes,
      definition,
      originalKeyCalls,
      restoredKeyCalls,
      resolverCalls,
      originalRun,
      restoredRun,
      missingPlugin,
      missingResidue,
      cleanup,
      instrumentation: {
        originalCount: originalCapture.members.length,
        originalRestored: originalCapture.instrumentationRestored,
        restoredCount: restoredCapture.members.length,
        restoredRestored: restoredCapture.instrumentationRestored,
      },
    };
  });

  expect(result.restoredBytes).toBe(result.bytes);
  expect(Object.keys(result.definition)).toEqual(['schema', 'kind', 'options', 'members']);
  expect(Object.keys(result.definition.options)).toEqual(['trigger', 'motion']);
  expect(result.definition.members).toHaveLength(5);
  expect(result.definition.members.every(
    (member) => Object.keys(member).join(',') === 'target,options',
  )).toBe(true);
  expect(result.definition.members.every(
    ({ options }) => Object.keys(options).join(',')
      === 'mark,note,placement,accessible,seed,duration',
  )).toBe(true);
  expect(result.definition.members.every(
    ({ options }) => /^hana-\d+$/.test(options.seed),
  )).toBe(true);
  const seeds = result.definition.members.map(({ options }) => options.seed);
  expect(new Set(seeds).size).toBe(5);
  const memberOptions = (mark, seed) => ({
    mark,
    note: null,
    placement: 'auto',
    accessible: false,
    seed,
    duration: 0,
  });
  const expected = {
    schema: 'hanamaru/v1',
    kind: 'group',
    options: { trigger: 'manual', motion: 'never' },
    members: [
      {
        target: { type: 'selector', selector: '#group-first' },
        options: memberOptions('underline', seeds[0]),
      },
      {
        target: { type: 'key', key: 'group-target-1', targetKind: 'element' },
        options: memberOptions('box', seeds[1]),
      },
      {
        target: { type: 'key', key: 'group-target-2', targetKind: 'range' },
        options: memberOptions('highlight', seeds[2]),
      },
      {
        target: {
          type: 'locator',
          within: { type: 'selector', selector: '#group-selector-scope' },
          text: 'selector exact phrase',
          occurrence: 1,
        },
        options: memberOptions('circle', seeds[3]),
      },
      {
        target: {
          type: 'locator',
          within: { type: 'key', key: 'group-within-4', targetKind: 'element' },
          text: 'element scoped exact phrase',
        },
        options: memberOptions('group-proof', seeds[4]),
      },
    ],
  };
  expect(result.definition).toEqual(expected);
  expect(result.bytes).toBe(JSON.stringify(expected));
  expect(result.originalRun).toEqual(result.restoredRun);
  expect(result.restoredRun.states).toEqual(['idle', 'showing', 'visible']);
  expect(result.restoredRun.paths).toHaveLength(5);
  expect(result.restoredRun.paths.map(({ index, mark }) => ({ index, mark }))).toEqual([
    { index: 0, mark: 'underline' },
    { index: 1, mark: 'box' },
    { index: 2, mark: 'highlight' },
    { index: 3, mark: 'circle' },
    { index: 4, mark: 'group-proof' },
  ]);
  for (const member of result.restoredRun.paths) {
    expect(member.valid).toBe(true);
    expect(member.paths.length).toBeGreaterThan(0);
    expect(member.paths.every(
      (path) => typeof path === 'string' && path.length > 0,
    )).toBe(true);
  }
  for (const member of result.originalRun.paths) {
    expect(member.valid).toBe(true);
    expect(member.paths.length).toBeGreaterThan(0);
    expect(member.paths.every(
      (path) => typeof path === 'string' && path.length > 0,
    )).toBe(true);
  }
  expect(result.restoredRun.paths[4].paths).toEqual(['M 4 5 Q 14 7 24 15']);
  expect(result.restoredRun.successfulEvents
    .filter(({ scope }) => scope === 'group')
    .map(({ type }) => type)).toEqual(['hana:start', 'hana:complete']);
  expect({
    state: result.restoredRun.cancellation.state,
    cancelEvents: result.restoredRun.cancellation.cancelEvents,
    memberStates: result.restoredRun.cancellation.memberStates,
  }).toEqual({
    state: 'hidden',
    cancelEvents: [
      {
        type: 'hana:cancel', scope: 'group', memberIndex: null,
        target: 'group-first', index: null, state: null,
      },
    ],
    memberStates: [
      { index: 0, state: 'hidden' },
      { index: 1, state: 'hidden' },
      { index: 2, state: 'hidden' },
      { index: 3, state: 'hidden' },
      { index: 4, state: 'hidden' },
    ],
  });
  expect(result.restoredRun.cancellation.events.map(
    ({ type, scope, memberIndex }) => ({ type, scope, memberIndex }),
  )).toEqual([
    { type: 'hana:cancel', scope: 'group', memberIndex: null },
  ]);
  expect(result.restoredRun.cancellation.events.filter(
    ({ scope }) => scope === 'member',
  )).toHaveLength(0);
  expect(result.instrumentation).toEqual({
    originalCount: 5,
    originalRestored: true,
    restoredCount: 5,
    restoredRestored: true,
  });
  expect(result.originalKeyCalls).toEqual([
    {
      keys: ['role', 'controllerKind', 'ownerElement', 'index'],
      role: 'target',
      controllerKind: 'group',
      owner: 'group-direct-key',
      index: 1,
      nativeElement: true,
      nativeRange: false,
    },
    {
      keys: ['role', 'controllerKind', 'ownerElement', 'index'],
      role: 'target',
      controllerKind: 'group',
      owner: 'group-range-key',
      index: 2,
      nativeElement: false,
      nativeRange: true,
    },
    {
      keys: ['role', 'controllerKind', 'ownerElement', 'index'],
      role: 'within',
      controllerKind: 'group',
      owner: 'group-element-scope',
      index: 4,
      nativeElement: true,
      nativeRange: false,
    },
  ]);
  expect(result.restoredKeyCalls).toEqual(result.originalKeyCalls);
  expect(result.resolverCalls).toEqual([
    {
      key: 'group-target-1',
      keys: ['targetKind', 'role', 'controllerKind', 'index'],
      targetKind: 'element',
      role: 'target',
      controllerKind: 'group',
      index: 1,
    },
    {
      key: 'group-target-2',
      keys: ['targetKind', 'role', 'controllerKind', 'index'],
      targetKind: 'range',
      role: 'target',
      controllerKind: 'group',
      index: 2,
    },
    {
      key: 'group-within-4',
      keys: ['targetKind', 'role', 'controllerKind', 'index'],
      targetKind: 'element',
      role: 'within',
      controllerKind: 'group',
      index: 4,
    },
  ]);
  expect(result.missingPlugin).toEqual({
    name: 'HanamaruConfigError',
    code: 'HANA_CONFIG_INVALID',
    field: 'mark',
  });
  expect(result.missingResidue).toEqual({
    owned: 0,
    overlays: 0,
    events: [],
    resolverCalls: 0,
  });
  expect(result.cleanup).toEqual({ owned: 0, overlays: 0 });
  await expectNoBrowserFailures(page, pageErrors);
});

test('atomic Story and Group restore failures leave no controller, DOM, event, or resolver residue', async ({ page }) => {
  const pageErrors = await openFixture(page, '/tests/fixtures/group.html');
  const result = await page.evaluate(async () => {
    const { runtimeState } = await import('/src/runtime-state.js');
    const { restore } = await import('/src/serialize.js');
    const first = document.querySelector('#group-first');
    const second = document.querySelector('#group-second');
    const annotationOptions = (seed, mark = 'underline', duration = 0) => ({
      mark,
      note: null,
      placement: 'auto',
      accessible: false,
      seed,
      duration,
    });
    const aggregate = (kind, members) => ({
      schema: 'hanamaru/v1',
      kind,
      options: kind === 'story'
        ? { trigger: 'manual', gap: 0, motion: 'never' }
        : { trigger: 'manual', motion: 'never' },
      [kind === 'story' ? 'steps' : 'members']: members,
    });
    const cases = [
      {
        name: 'Story later resolver',
        definition: aggregate('story', [
          {
            target: { type: 'key', key: 'first', targetKind: 'element' },
            options: annotationOptions('story-first'),
          },
          {
            target: { type: 'key', key: 'late-failure', targetKind: 'element' },
            options: annotationOptions('story-late'),
          },
        ]),
        resolve(key) {
          if (key === 'first') return first;
          throw new Error('late story resolver failure');
        },
      },
      {
        name: 'Group later resolver',
        definition: aggregate('group', [
          {
            target: { type: 'key', key: 'first', targetKind: 'element' },
            options: annotationOptions('group-first'),
          },
          {
            target: { type: 'key', key: 'late-failure', targetKind: 'element' },
            options: annotationOptions('group-late'),
          },
        ]),
        resolve(key) {
          if (key === 'first') return first;
          throw new Error('late group resolver failure');
        },
      },
      {
        name: 'Story later plugin preflight',
        definition: aggregate('story', [
          {
            target: { type: 'key', key: 'first', targetKind: 'element' },
            options: annotationOptions('story-plugin-first'),
          },
          {
            target: { type: 'key', key: 'second', targetKind: 'element' },
            options: annotationOptions('story-plugin-late', 'not-registered'),
          },
        ]),
        resolve(key) { return key === 'first' ? first : second; },
      },
      {
        name: 'Group later options preflight',
        definition: aggregate('group', [
          {
            target: { type: 'key', key: 'first', targetKind: 'element' },
            options: annotationOptions('group-options-first'),
          },
          {
            target: { type: 'key', key: 'second', targetKind: 'element' },
            options: annotationOptions('group-options-late', 'underline', -1),
          },
        ]),
        resolve(key) { return key === 'first' ? first : second; },
      },
    ];
    const output = [];

    for (const item of cases) {
      let resolverCalls = 0;
      const events = [];
      const listener = (event) => events.push(event.type);
      for (const type of [
        'hana:start', 'hana:step', 'hana:complete', 'hana:cancel', 'hana:error',
      ]) {
        document.body.addEventListener(type, listener);
      }
      let failure;
      const originalMetadata = runtimeState.metadata;
      class TrackingMetadata extends WeakMap {
        setCalls = 0;

        set(key, value) {
          this.setCalls += 1;
          return super.set(key, value);
        }
      }
      const trackingMetadata = new TrackingMetadata();
      runtimeState.metadata = trackingMetadata;
      try {
        try {
          restore(item.definition, {
            root: document,
            resolveTarget(key, context) {
              resolverCalls += 1;
              return item.resolve(key, context);
            },
          });
        } catch (error) {
          failure = {
            name: error.name,
            code: error.code,
            cause: error.details?.cause?.message ?? null,
          };
        }
      } finally {
        runtimeState.metadata = originalMetadata;
      }
      for (const type of [
        'hana:start', 'hana:step', 'hana:complete', 'hana:cancel', 'hana:error',
      ]) {
        document.body.removeEventListener(type, listener);
      }
      output.push({
        name: item.name,
        failure,
        resolverCalls,
        metadataSetCalls: trackingMetadata.setCalls,
        metadataRestored: runtimeState.metadata === originalMetadata,
        memberCount: item.definition[
          item.definition.kind === 'story' ? 'steps' : 'members'
        ].length,
        events,
        owned: document.querySelectorAll('[data-hana-id]').length,
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
        annotations: document.querySelectorAll('.hana-annotation').length,
        notes: document.querySelectorAll('.hana-note').length,
      });
    }
    return output;
  });

  expect(result).toEqual([
    {
      name: 'Story later resolver',
      failure: {
        name: 'HanamaruTargetError',
        code: 'HANA_TARGET_RESOLVER',
        cause: 'late story resolver failure',
      },
      resolverCalls: 2,
      metadataSetCalls: 0,
      metadataRestored: true,
      memberCount: 2,
      events: [],
      owned: 0,
      overlays: 0,
      annotations: 0,
      notes: 0,
    },
    {
      name: 'Group later resolver',
      failure: {
        name: 'HanamaruTargetError',
        code: 'HANA_TARGET_RESOLVER',
        cause: 'late group resolver failure',
      },
      resolverCalls: 2,
      metadataSetCalls: 0,
      metadataRestored: true,
      memberCount: 2,
      events: [],
      owned: 0,
      overlays: 0,
      annotations: 0,
      notes: 0,
    },
    {
      name: 'Story later plugin preflight',
      failure: {
        name: 'HanamaruConfigError',
        code: 'HANA_CONFIG_INVALID',
        cause: null,
      },
      resolverCalls: 0,
      metadataSetCalls: 0,
      metadataRestored: true,
      memberCount: 2,
      events: [],
      owned: 0,
      overlays: 0,
      annotations: 0,
      notes: 0,
    },
    {
      name: 'Group later options preflight',
      failure: {
        name: 'HanamaruConfigError',
        code: 'HANA_CONFIG_SERIALIZED_DEFINITION',
        cause: null,
      },
      resolverCalls: 0,
      metadataSetCalls: 0,
      metadataRestored: true,
      memberCount: 2,
      events: [],
      owned: 0,
      overlays: 0,
      annotations: 0,
      notes: 0,
    },
  ]);
  await expectNoBrowserFailures(page, pageErrors);
});
