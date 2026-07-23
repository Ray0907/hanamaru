import { runtimeState } from './runtime-state.js';

function isWeakKey(value) {
  return (typeof value === 'object' && value !== null)
    || typeof value === 'function';
}

function assertController(controller) {
  if (!isWeakKey(controller)) {
    throw new TypeError('controller metadata key must be an object');
  }
}

function annotationOptions(options) {
  return Object.freeze({
    mark: options.mark,
    note: options.note,
    placement: options.placement,
    trigger: options.trigger,
    accessible: options.accessible,
    seed: options.seed,
    duration: options.duration,
    motion: options.motion,
  });
}

export function snapshotAnnotationTarget(target) {
  if (target === null || typeof target !== 'object' || Array.isArray(target)) return target;
  const ElementConstructor = target.ownerDocument?.defaultView?.Element;
  if (typeof ElementConstructor === 'function' && target instanceof ElementConstructor) {
    return target;
  }
  const boundary = target.startContainer;
  const rangeDocument = boundary?.nodeType === 9 ? boundary : boundary?.ownerDocument;
  const RangeConstructor = rangeDocument?.defaultView?.Range;
  if (typeof RangeConstructor === 'function' && target instanceof RangeConstructor) {
    return target;
  }
  const keys = Reflect.ownKeys(target);
  if (keys.length < 2 || keys.length > 3
    || keys.some((key) => typeof key !== 'string'
      || !['within', 'text', 'occurrence'].includes(key))
    || !keys.includes('within')
    || !keys.includes('text')) return target;
  const descriptors = Object.getOwnPropertyDescriptors(target);
  if (keys.some((key) => !Object.hasOwn(descriptors[key], 'value'))) return target;
  const snapshot = {
    within: descriptors.within.value,
    text: descriptors.text.value,
  };
  if (descriptors.occurrence !== undefined) {
    snapshot.occurrence = descriptors.occurrence.value;
  }
  return Object.freeze(snapshot);
}

export function readControllerMetadata(controller) {
  if (!isWeakKey(controller)) return undefined;
  return runtimeState.metadata.get(controller);
}

export function recordAnnotationMetadata(controller, target, options) {
  assertController(controller);
  const metadata = Object.freeze({
    kind: 'annotation',
    target: snapshotAnnotationTarget(target),
    options: annotationOptions(options),
  });
  runtimeState.metadata.set(controller, metadata);
  return metadata;
}

function annotationMetadataFor(controllers) {
  const records = controllers.map((controller) => readControllerMetadata(controller));
  if (records.some((record) => record === undefined)) {
    throw new TypeError('aggregate member metadata is missing');
  }
  if (records.some((record) => record?.kind !== 'annotation')) {
    throw new TypeError('aggregate members must be Annotation controllers');
  }
  return Object.freeze(records);
}

export function recordStoryMetadata(controller, options, annotations) {
  assertController(controller);
  if (!Array.isArray(annotations)) {
    throw new TypeError('story annotations must be an array');
  }
  const steps = annotationMetadataFor(annotations);
  const canonicalOptions = options.trigger === 'viewport'
    ? Object.freeze({
      trigger: options.trigger,
      gap: options.gap,
      motion: options.motion,
      once: options.once,
    })
    : Object.freeze({
      trigger: options.trigger,
      gap: options.gap,
      motion: options.motion,
    });
  const metadata = Object.freeze({
    kind: 'story',
    options: canonicalOptions,
    steps,
  });
  runtimeState.metadata.set(controller, metadata);
  return metadata;
}

export function recordGroupMetadata(controller, options, annotations) {
  assertController(controller);
  if (!Array.isArray(annotations)) {
    throw new TypeError('group annotations must be an array');
  }
  const members = annotationMetadataFor(annotations);
  const metadata = Object.freeze({
    kind: 'group',
    options: Object.freeze({
      trigger: options.trigger,
      motion: options.motion,
    }),
    members,
  });
  runtimeState.metadata.set(controller, metadata);
  return metadata;
}

export function deleteControllerMetadata(controller) {
  if (!isWeakKey(controller)) return false;
  return runtimeState.metadata.delete(controller);
}
