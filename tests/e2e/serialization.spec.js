import { expect, test } from '@playwright/test';

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
  });
});
