import { normalizeOptions } from './annotation.js';
import {
  HanamaruConfigError,
  HanamaruStateError,
  HanamaruTargetError,
} from './errors.js';

const STORY_KEYS = new Set(['trigger', 'gap', 'once', 'motion']);
const STEP_KEYS = new Set([
  'target', 'mark', 'note', 'placement', 'accessible', 'seed', 'duration',
]);
const STORY_TRIGGERS = new Set(['manual', 'load', 'viewport']);
const STORY_MOTIONS = new Set(['system', 'never']);

function has(input, key) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function invalid(field, value) {
  throw new HanamaruConfigError(
    'HANA_CONFIG_INVALID',
    `Invalid story option: ${field}`,
    { field, value },
  );
}

function normalizeStoryOptions(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalid('input', input);
  }
  for (const key of Object.keys(input)) {
    if (!STORY_KEYS.has(key)) invalid(key, input[key]);
  }

  const trigger = has(input, 'trigger') ? input.trigger : 'manual';
  if (!STORY_TRIGGERS.has(trigger)) invalid('trigger', trigger);

  const gap = has(input, 'gap') ? input.gap : 180;
  if (!Number.isInteger(gap) || gap < 0) invalid('gap', gap);

  const motion = has(input, 'motion') ? input.motion : 'system';
  if (!STORY_MOTIONS.has(motion)) invalid('motion', motion);

  if (has(input, 'once') && trigger !== 'viewport') invalid('once', input.once);
  const once = trigger === 'viewport'
    ? (has(input, 'once') ? input.once : true)
    : undefined;
  if (trigger === 'viewport' && typeof once !== 'boolean') invalid('once', once);

  return trigger === 'viewport'
    ? { trigger, gap, motion, once }
    : { trigger, gap, motion };
}

function prepareSteps(steps, storyOptions, env) {
  if (!Array.isArray(steps) || steps.length === 0) invalid('steps', steps);

  return steps.map((step, index) => {
    if (step === null || typeof step !== 'object' || Array.isArray(step)) {
      invalid(`steps[${index}]`, step);
    }
    for (const key of Object.keys(step)) {
      if (!STEP_KEYS.has(key)) invalid(`steps[${index}].${key}`, step[key]);
    }
    if (!has(step, 'target')) invalid(`steps[${index}].target`, undefined);

    const { target, ...annotationInput } = step;
    const annotationOptions = normalizeOptions({
      ...annotationInput,
      trigger: 'manual',
      motion: storyOptions.motion,
    }, 0);
    if (!has(annotationInput, 'seed')) delete annotationOptions.seed;
    const record = env.resolveTarget(target);
    return { target, annotationOptions, record };
  });
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => {});
  return { promise, reject, resolve, settled: false };
}

function runtimeError(cause) {
  if (cause instanceof HanamaruTargetError || cause instanceof HanamaruStateError) {
    return cause;
  }
  return new HanamaruStateError(
    'HANA_STATE_RUNTIME',
    'Story annotation rendering failed',
    { cause },
  );
}

export function createStory(steps, rawOptions = {}, env) {
  if (env === null || typeof env !== 'object') {
    throw new TypeError('story environment must be an object');
  }
  const options = normalizeStoryOptions(rawOptions);
  const prepared = prepareSteps(steps, options, env);
  const annotations = [];
  try {
    for (const step of prepared) {
      annotations.push(env.createAnnotation(step.target, step.annotationOptions));
    }
  } catch (error) {
    for (const annotation of annotations) {
      try { annotation.destroy(); } catch { /* Preserve the construction failure. */ }
    }
    throw error;
  }

  let state = 'idle';
  let run = null;
  let operationEpoch = 0;
  let phase = null;

  const controller = {
    get state() { return state; },
    get finished() { return run?.promise ?? null; },
    play,
    pause,
    resume,
    cancel,
    replay,
    destroy,
  };

  function isCurrent(operation) {
    return state !== 'destroyed' && operation === operationEpoch;
  }

  function dispatch(type, detail) {
    env.createEvent(type, detail, prepared[0].record.ownerElement);
  }

  function finishRun(operation) {
    if (!isCurrent(operation) || state !== 'playing') return;
    phase = null;
    state = 'complete';
    if (run !== null && !run.settled) {
      run.settled = true;
      run.resolve();
    }
    dispatch('hana:complete', { controller, state });
  }

  function startGap(operation, index) {
    if (!isCurrent(operation)) return;
    const remaining = env.reducedMotion(options) ? 0 : options.gap;
    phase = { kind: 'gap', index, remaining, startedAt: null, timerId: null };
    if (state === 'playing') resumeGap(operation);
  }

  function resumeGap(operation) {
    if (!isCurrent(operation) || state !== 'playing' || phase?.kind !== 'gap') return;
    if (phase.remaining === 0) {
      const nextIndex = phase.index + 1;
      phase = null;
      startStep(operation, nextIndex);
      return;
    }
    phase.startedAt = env.now();
    const gapIndex = phase.index;
    phase.timerId = env.setTimeout(() => {
      if (!isCurrent(operation) || state !== 'playing'
        || phase?.kind !== 'gap' || phase.index !== gapIndex) return;
      phase.timerId = null;
      phase.remaining = 0;
      startStep(operation, gapIndex + 1);
    }, phase.remaining);
  }

  function annotationFinished(operation, index, annotationRun) {
    if (!isCurrent(operation)
      || phase?.kind !== 'annotation'
      || phase.index !== index
      || phase.finished !== annotationRun) return;
    if (index === annotations.length - 1) {
      if (state === 'playing') finishRun(operation);
      else phase = { kind: 'complete-pending', index };
      return;
    }
    startGap(operation, index);
  }

  function annotationFailed(operation, index, annotationRun, error) {
    if (!isCurrent(operation)
      || phase?.kind !== 'annotation'
      || phase.index !== index
      || phase.finished !== annotationRun) return;
    failRun(operation, index, error, true);
  }

  function failRun(operation, index, cause, hideFailedStep = false) {
    if (!isCurrent(operation)) return runtimeError(cause);
    const error = runtimeError(cause);
    operationEpoch += 1;
    const failureOperation = operationEpoch;
    clearPendingTimer();
    phase = null;
    state = 'cancelled';
    rejectPending(error);
    dispatch('hana:error', { controller, error, index });
    if (!isCurrent(failureOperation)) return error;
    if (hideFailedStep) {
      try { annotations[index].hide(); } catch { /* Preserve the originating failure. */ }
    }
    return error;
  }

  function startStep(operation, index, alreadyRefreshed = false) {
    if (!isCurrent(operation) || state !== 'playing') return;
    phase = { kind: 'before-step', index, refreshed: alreadyRefreshed };
    if (!alreadyRefreshed) {
      try {
        prepared[index].record.refresh();
        phase.refreshed = true;
      } catch (error) {
        failRun(operation, index, error);
        return;
      }
    }
    if (!isCurrent(operation) || state !== 'playing'
      || phase?.kind !== 'before-step' || phase.index !== index) return;
    const annotation = annotations[index];
    phase = { kind: 'before-annotation', index };
    dispatch('hana:step', { controller, index, total: annotations.length, annotation });
    if (!isCurrent(operation) || state !== 'playing'
      || phase?.kind !== 'before-annotation' || phase.index !== index) return;
    startAnnotation(operation, index);
  }

  function startAnnotation(operation, index) {
    if (!isCurrent(operation) || state !== 'playing'
      || phase?.kind !== 'before-annotation' || phase.index !== index) return;
    const annotation = annotations[index];
    phase = { kind: 'annotation', index, finished: null, mounting: true };
    try {
      annotation.show();
    } catch (error) {
      failRun(operation, index, error, true);
      return;
    }
    const annotationRun = annotation.finished;
    if (!isCurrent(operation)
      || phase?.kind !== 'annotation' || phase.index !== index) return;
    phase.finished = annotationRun;
    phase.mounting = false;
    if (annotationRun === null || typeof annotationRun?.then !== 'function') {
      failRun(operation, index, new TypeError('Annotation run did not provide a Promise'), true);
      return;
    }
    annotationRun.then(
      () => annotationFinished(operation, index, annotationRun),
      (error) => annotationFailed(operation, index, annotationRun, error),
    );
    if (state === 'paused') {
      try {
        env.pauseAnnotationRun(annotation);
      } catch (error) {
        failRun(operation, index, error, true);
      }
    }
  }

  function beginRun({ firstAlreadyRefreshed = false } = {}) {
    operationEpoch += 1;
    const operation = operationEpoch;
    run = createDeferred();
    state = 'playing';
    phase = { kind: 'before-step', index: 0, refreshed: firstAlreadyRefreshed };
    if (!firstAlreadyRefreshed) {
      try {
        prepared[0].record.refresh();
        phase.refreshed = true;
      } catch (error) {
        failRun(operation, 0, error);
        return;
      }
    }
    dispatch('hana:start', { controller, state });
    if (isCurrent(operation) && state === 'playing'
      && phase?.kind === 'before-step' && phase.index === 0) {
      startStep(operation, 0, true);
    }
  }

  function play() {
    if (state !== 'idle') return controller;
    beginRun();
    return controller;
  }

  function pause() {
    if (state !== 'playing') return controller;
    const operation = operationEpoch;
    state = 'paused';
    if (phase?.kind === 'annotation' && !phase.mounting) {
      const index = phase.index;
      try {
        env.pauseAnnotationRun(annotations[index]);
      } catch (error) {
        failRun(operation, index, error, true);
        return controller;
      }
      if (!isCurrent(operation) || state !== 'paused') return controller;
    } else if (phase?.kind === 'gap' && phase.timerId !== null) {
      env.clearTimeout(phase.timerId);
      phase.timerId = null;
      phase.remaining = Math.max(0, phase.remaining - (env.now() - phase.startedAt));
      phase.startedAt = null;
    }
    dispatch('hana:pause', { controller, index: phase?.index ?? 0 });
    return controller;
  }

  function resume() {
    if (state !== 'paused') return controller;
    state = 'playing';
    const operation = operationEpoch;
    if (phase?.kind === 'before-step') {
      startStep(operation, phase.index, phase.refreshed);
    }
    else if (phase?.kind === 'before-annotation') startAnnotation(operation, phase.index);
    else if (phase?.kind === 'annotation' && !phase.mounting) {
      const index = phase.index;
      try {
        env.resumeAnnotationRun(annotations[index]);
      } catch (error) {
        failRun(operation, index, error, true);
      }
    }
    else if (phase?.kind === 'gap') resumeGap(operation);
    else if (phase?.kind === 'complete-pending') finishRun(operation);
    return controller;
  }

  function clearPendingTimer() {
    if (phase?.kind === 'gap' && phase.timerId !== null) {
      env.clearTimeout(phase.timerId);
      phase.timerId = null;
    }
  }

  function rejectPending(error) {
    if (run === null || run.settled) return false;
    run.settled = true;
    run.reject(error);
    return true;
  }

  function abortError(reason) {
    return new DOMException(`Story run ${reason}`, 'AbortError');
  }

  function cancel() {
    if (state !== 'playing' && state !== 'paused') return controller;
    operationEpoch += 1;
    const operation = operationEpoch;
    clearPendingTimer();
    const activeIndex = phase?.kind === 'annotation' ? phase.index : -1;
    rejectPending(abortError('cancelled'));
    phase = null;
    state = 'cancelled';
    if (activeIndex >= 0 && annotations[activeIndex].state !== 'visible') {
      try { annotations[activeIndex].hide(); } catch { /* Cancellation remains authoritative. */ }
    }
    if (!isCurrent(operation)) return controller;
    dispatch('hana:cancel', { controller, reason: 'cancel' });
    return controller;
  }

  function replay() {
    if (state === 'destroyed') return controller;
    operationEpoch += 1;
    const operation = operationEpoch;
    const notifyCancel = (state === 'playing' || state === 'paused')
      && run !== null && !run.settled;
    clearPendingTimer();
    rejectPending(abortError('replayed'));
    phase = null;
    state = 'cancelled';
    let hideFailure = null;
    let hideFailureIndex = -1;
    for (let index = 0; index < annotations.length; index += 1) {
      try {
        annotations[index].hide();
      } catch (error) {
        hideFailure ??= error;
        if (hideFailureIndex === -1) hideFailureIndex = index;
      }
      if (!isCurrent(operation)) return controller;
    }
    if (notifyCancel) dispatch('hana:cancel', { controller, reason: 'replay' });
    if (!isCurrent(operation)) return controller;
    if (hideFailure !== null) {
      const error = runtimeError(hideFailure);
      dispatch('hana:error', { controller, error, index: hideFailureIndex });
      throw error;
    }
    for (let index = 0; index < prepared.length; index += 1) {
      try {
        prepared[index].record.refresh();
      } catch (cause) {
        const error = runtimeError(cause);
        dispatch('hana:error', { controller, error, index });
        throw error;
      }
      if (!isCurrent(operation)) return controller;
    }
    if (!isCurrent(operation)) return controller;
    beginRun({ firstAlreadyRefreshed: true });
    return controller;
  }

  function destroy() {
    if (state === 'destroyed') return controller;
    operationEpoch += 1;
    const notifyCancel = (state === 'playing' || state === 'paused')
      && run !== null && !run.settled;
    clearPendingTimer();
    rejectPending(abortError('destroyed'));
    phase = null;
    state = 'destroyed';
    let destroyFailure = null;
    let destroyFailureIndex = -1;
    for (let index = 0; index < annotations.length; index += 1) {
      try {
        annotations[index].destroy();
      } catch (error) {
        destroyFailure ??= error;
        if (destroyFailureIndex === -1) destroyFailureIndex = index;
      }
    }
    if (notifyCancel) dispatch('hana:cancel', { controller, reason: 'destroy' });
    if (destroyFailure !== null) {
      const error = runtimeError(destroyFailure);
      dispatch('hana:error', { controller, error, index: destroyFailureIndex });
    }
    return controller;
  }
  return controller;
}
