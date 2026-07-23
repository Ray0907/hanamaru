import { createAnnotation, createAnnotationEnvironment } from './annotation.js';
import { HanamaruTargetError } from './errors.js';
import {
  intrinsicDocumentView,
  intrinsicRootForNode,
  intrinsicRootKind,
} from './shadow-target.js';

function targetError(code, message, details) {
  return new HanamaruTargetError(code, message, details);
}

function boundaryDocument(boundary) {
  return boundary?.nodeType === 9 ? boundary : boundary?.ownerDocument;
}

function isConnectedBoundary(boundary, doc) {
  return boundary === doc || (boundary?.ownerDocument === doc && boundary.isConnected);
}

function selectionRangeCount(selection, view) {
  const prototype = view?.Selection?.prototype;
  const getter = prototype === undefined
    ? undefined
    : Object.getOwnPropertyDescriptor(prototype, 'rangeCount')?.get;
  if (typeof getter !== 'function') {
    throw targetError(
      'HANA_TARGET_SELECTION_UNAVAILABLE',
      'Selection is unavailable in this browsing context',
      {},
    );
  }
  try {
    return Reflect.apply(getter, selection, []);
  } catch {
    throw targetError(
      'HANA_TARGET_SELECTION_UNAVAILABLE',
      'Selection must be a native Selection',
      {},
    );
  }
}

function selectionRange(selection, view) {
  const method = view?.Selection?.prototype?.getRangeAt;
  if (typeof method !== 'function') {
    throw targetError(
      'HANA_TARGET_SELECTION_UNAVAILABLE',
      'Selection is unavailable in this browsing context',
      {},
    );
  }
  try {
    return Reflect.apply(method, selection, [0]);
  } catch {
    throw targetError(
      'HANA_TARGET_SELECTION_UNAVAILABLE',
      'Selection must be a native Selection',
      {},
    );
  }
}

function validateSelection(options, selection, env) {
  let current = selection;
  if (current === undefined) {
    try {
      current = env.view?.getSelection?.();
    } catch {
      throw targetError(
        'HANA_TARGET_SELECTION_UNAVAILABLE',
        'Selection is unavailable in this browsing context',
        {},
      );
    }
  }
  const rangeCount = selectionRangeCount(current, env.view);
  if (rangeCount === 0) {
    throw targetError(
      'HANA_TARGET_SELECTION_EMPTY',
      'Selection has no ranges',
      { rangeCount },
    );
  }
  if (rangeCount !== 1) {
    throw targetError(
      'HANA_TARGET_SELECTION_AMBIGUOUS',
      'Selection must contain exactly one range',
      { rangeCount },
    );
  }

  const range = selectionRange(current, env.view);
  if (range.collapsed) {
    throw targetError(
      'HANA_TARGET_SELECTION_EMPTY',
      'Selection range must not be collapsed',
      { collapsed: true },
    );
  }

  const startDocument = boundaryDocument(range.startContainer);
  const endDocument = boundaryDocument(range.endContainer);
  const startRoot = intrinsicRootForNode(range.startContainer);
  const endRoot = intrinsicRootForNode(range.endContainer);
  const details = {
    startRoot: intrinsicRootKind(startRoot),
    endRoot: intrinsicRootKind(endRoot),
  };
  if (startDocument === undefined || startDocument === null
    || endDocument === undefined || endDocument === null
    || startDocument !== endDocument
    || !isConnectedBoundary(range.startContainer, startDocument)
    || !isConnectedBoundary(range.endContainer, endDocument)
    || startRoot !== endRoot
    || (intrinsicRootKind(startRoot) !== 'document'
      && intrinsicRootKind(startRoot) !== 'shadow-root')) {
    throw targetError(
      'HANA_TARGET_INVALID',
      'Selection range boundaries must be connected in one DOM root',
      details,
    );
  }

  const documentView = intrinsicDocumentView(startDocument);
  if (documentView !== null && documentView !== undefined) {
    selectionRangeCount(current, documentView);
  }
  if (env.root !== undefined && env.root !== startRoot) {
    throw targetError(
      'HANA_TARGET_INVALID',
      'Selection range must belong to the injected root',
      details,
    );
  }
  if (intrinsicRootKind(startRoot) === 'shadow-root' && env.root === undefined) {
    throw targetError(
      'HANA_TARGET_SHADOW_UNSCOPED',
      'ShadowRoot selections require a Shadow scope',
      details,
    );
  }

  return { options, range };
}

export function annotateSelectionWithEnvironment(options, selection, env) {
  if (env === null || typeof env !== 'object') {
    throw new TypeError('selection environment must be an object');
  }
  const { range } = validateSelection(options, selection, env);
  const clone = range.cloneRange();
  return env.createAnnotation(clone, options);
}

export function annotateSelection(options, selection = undefined) {
  const view = globalThis.window;
  return annotateSelectionWithEnvironment(options, selection, {
    createAnnotation(range, rawOptions) {
      return createAnnotation(range, rawOptions, createAnnotationEnvironment(range));
    },
    view,
  });
}
