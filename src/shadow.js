import {
  createAnnotation,
  createAnnotationEnvironmentWithResources,
} from './annotation.js';
import {
  HanamaruConfigError,
  HanamaruStateError,
  HanamaruTargetError,
} from './errors.js';
import { scanDeclarative } from './declarative.js';
import {
  createGroup,
  createGroupEnvironmentWithResources,
} from './group.js';
import { annotateSelectionWithEnvironment } from './selection.js';
import {
  resolveSerializedTargetWithEnvironment,
  restoreWithEnvironment,
} from './serialize.js';
import { acquireShadowResources } from './shadow-resources.js';
import { acquireShadowStyles } from './shadow-styles.js';
import {
  assertShadowRoot,
  resolveShadowTarget,
} from './shadow-target.js';
import {
  createStory,
  createStoryEnvironmentWithResources,
} from './story.js';

const SCOPE_CONFIG_ERRORS = new WeakSet();

function invalid(field, value) {
  const error = new HanamaruConfigError(
    'HANA_CONFIG_INVALID',
    `Invalid Shadow scope option: ${field}`,
    { field, value },
  );
  SCOPE_CONFIG_ERRORS.add(error);
  throw error;
}

function normalizeScopeOptions(input) {
  if (input === undefined) return { styles: undefined };
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) {
      invalid('input', input);
    }
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => key !== 'styles')) invalid('input', input);
    const descriptor = Object.getOwnPropertyDescriptor(input, 'styles');
    if (descriptor !== undefined && !Object.hasOwn(descriptor, 'value')) {
      invalid('styles', input);
    }
    return { styles: descriptor?.value };
  } catch (cause) {
    if (SCOPE_CONFIG_ERRORS.has(cause)) throw cause;
    throw new HanamaruConfigError(
      'HANA_CONFIG_INVALID',
      'Invalid Shadow scope options',
      { field: 'input', value: input, cause },
    );
  }
}

function scopeStateError(cause, operation) {
  if (cause instanceof HanamaruStateError
    && cause.code === 'HANA_STATE_SHADOW_SCOPE') return cause;
  return new HanamaruStateError(
    'HANA_STATE_SHADOW_SCOPE',
    `Shadow scope could not ${operation}`,
    { operation, cause },
  );
}

function acquireScopeLeases(root, styles) {
  const styleLease = acquireShadowStyles(root, styles);
  try {
    const resourceLease = acquireShadowResources(root, styleLease);
    return { resourceLease, styleLease };
  } catch (error) {
    try { styleLease.release(); } catch { /* Preserve resource acquisition failure. */ }
    throw error;
  }
}

function resolverContext(targetKind, role, controllerKind, index) {
  return { targetKind, role, controllerKind, index };
}

export function createShadowScope(root, optionsInput = undefined) {
  assertShadowRoot(root);
  const options = normalizeScopeOptions(optionsInput);
  const { resourceLease, styleLease } = acquireScopeLeases(root, options.styles);
  const resources = resourceLease.environment;
  const controllers = [];
  const owned = new Set();
  let phase = 'active';

  function requireActive(operation) {
    if (phase === 'active') return;
    throw scopeStateError(
      new TypeError('Shadow scope has been destroyed'),
      operation,
    );
  }

  function annotationEnvironment() {
    return createAnnotationEnvironmentWithResources({
      root,
      resources,
      resolveTarget(candidate) {
        return resolveShadowTarget(candidate, root);
      },
    });
  }

  function targetResolver(candidate) {
    return resolveShadowTarget(candidate, root);
  }

  function resolveKey(target, resolveTargetCallback, context, operation) {
    const protectedContext = resolverContext(
      target.targetKind,
      context.role,
      context.controllerKind,
      context.index,
    );
    if (typeof resolveTargetCallback !== 'function') {
      throw new HanamaruConfigError(
        'HANA_CONFIG_SERIALIZE_TARGET',
        'resolveTarget is required for serialized keys',
        { key: target.key, context: protectedContext },
      );
    }
    let resolved;
    try {
      resolved = resolveTargetCallback(target.key, resolverContext(
        protectedContext.targetKind,
        protectedContext.role,
        protectedContext.controllerKind,
        protectedContext.index,
      ));
    } catch (cause) {
      throw new HanamaruTargetError(
        'HANA_TARGET_RESOLVER',
        `Serialized target resolver failed for key: ${target.key}`,
        { key: target.key, context: protectedContext, cause },
      );
    }
    requireActive(operation);
    const record = targetResolver(resolved);
    if (target.targetKind === 'element' && record.kind !== 'element') {
      throw new HanamaruTargetError(
        'HANA_TARGET_INVALID',
        'Resolved key must be an Element in the exact ShadowRoot',
        { target: resolved },
      );
    }
    if (target.targetKind === 'range' && record.kind !== 'range') {
      throw new HanamaruTargetError(
        'HANA_TARGET_INVALID',
        'Resolved key must be a Range in the exact ShadowRoot',
        { target: resolved },
      );
    }
    return record;
  }

  function resolveTargetSource(target, {
    resolveTarget: resolveTargetCallback,
    role = 'target',
    controllerKind = null,
    index = null,
  }, operation) {
    const context = {
      resolveTarget: resolveTargetCallback,
      role,
      controllerKind,
      index,
    };
    if (target.type === 'selector') {
      const record = targetResolver(target.selector);
      return { resolved: record.element, source: target.selector };
    }
    if (target.type === 'key') {
      const record = resolveKey(
        target,
        context.resolveTarget,
        context,
        operation,
      );
      return {
        resolved: target.targetKind === 'element' ? record.element : record.range,
        source: target.targetKind === 'element' ? record.element : record.range,
      };
    }

    let withinSource;
    if (target.within.type === 'selector') {
      withinSource = target.within.selector;
    } else {
      const withinRecord = resolveKey(
        target.within,
        context.resolveTarget,
        {
          role: 'within',
          controllerKind: context.controllerKind,
          index: context.index,
        },
        operation,
      );
      withinSource = withinRecord.element;
    }
    const source = { within: withinSource, text: target.text };
    if (Object.hasOwn(target, 'occurrence')) source.occurrence = target.occurrence;
    const record = targetResolver(source);
    return { resolved: record.range, source };
  }

  function serializationEnvironment(operation) {
    return {
      resolveTargetSource(target, context) {
        return resolveTargetSource(target, context, operation);
      },
      createAnnotation(target, rawOptions) {
        return createAnnotation(target, rawOptions, annotationEnvironment());
      },
      createStory(steps, rawOptions) {
        return createStory(steps, rawOptions, createStoryEnvironmentWithResources({
          root,
          resources,
          resolveTarget: targetResolver,
        }));
      },
      createGroup(members, rawOptions) {
        return createGroup(members, rawOptions, createGroupEnvironmentWithResources({
          root,
          resources,
          resolveTarget: targetResolver,
        }));
      },
    };
  }

  function register(controller, operation) {
    if (phase !== 'active') {
      try { controller?.destroy?.(); } catch { /* Scope state remains authoritative. */ }
      requireActive(operation);
    }
    if (controller === null || typeof controller !== 'object'
      || typeof controller.destroy !== 'function') {
      throw scopeStateError(
        new TypeError('Scoped operation did not return a controller'),
        operation,
      );
    }
    if (!owned.has(controller)) {
      owned.add(controller);
      controllers.push(controller);
    }
    return controller;
  }

  function annotate(target, rawOptions) {
    requireActive('annotate');
    return register(
      createAnnotation(target, rawOptions, annotationEnvironment()),
      'annotate',
    );
  }

  function scan() {
    requireActive('scan');
    const result = scanDeclarative(root, (target, rawOptions) => (
      annotate(target, rawOptions)
    ));
    requireActive('scan');
    return result;
  }

  function story(steps, rawOptions = {}) {
    requireActive('create Story');
    return register(
      createStory(steps, rawOptions, createStoryEnvironmentWithResources({
        root,
        resources,
        resolveTarget: targetResolver,
      })),
      'create Story',
    );
  }

  function group(members, rawOptions = {}) {
    requireActive('create Group');
    return register(
      createGroup(members, rawOptions, createGroupEnvironmentWithResources({
        root,
        resources,
        resolveTarget: targetResolver,
      })),
      'create Group',
    );
  }

  function annotateSelection(rawOptions, selection = undefined) {
    requireActive('annotate Selection');
    return register(
      annotateSelectionWithEnvironment(rawOptions, selection, {
        root,
        view: resources.view ?? resources.document.defaultView,
        createAnnotation(range, options) {
          return createAnnotation(range, options, annotationEnvironment());
        },
      }),
      'annotate Selection',
    );
  }

  function restore(definition, context = undefined) {
    requireActive('restore');
    return register(
      restoreWithEnvironment(
        definition,
        context,
        serializationEnvironment('restore'),
      ),
      'restore',
    );
  }

  function resolveSerializedTarget(target, context = undefined) {
    requireActive('resolve serialized target');
    const resolved = resolveSerializedTargetWithEnvironment(
      target,
      context,
      serializationEnvironment('resolve serialized target'),
    );
    requireActive('resolve serialized target');
    return resolved;
  }

  function destroy() {
    if (phase !== 'active') return scope;
    phase = 'destroyed';
    let failure;
    for (let index = controllers.length - 1; index >= 0; index -= 1) {
      try { controllers[index].destroy(); } catch (error) { failure ??= error; }
    }
    try { resourceLease.release(); } catch (error) { failure ??= error; }
    try { styleLease.release(); } catch (error) { failure ??= error; }
    if (failure !== undefined) throw scopeStateError(failure, 'destroy');
    return scope;
  }

  const scope = {
    annotate,
    annotateSelection,
    destroy,
    group,
    resolveSerializedTarget,
    restore,
    scan,
    story,
  };
  return scope;
}
