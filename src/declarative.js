import { annotate } from './annotation.js';
import {
  HanamaruConfigError,
  HanamaruError,
  HanamaruTargetError,
} from './errors.js';

const ATTRIBUTES = [
  ['hanaNote', 'note'],
  ['hanaPlacement', 'placement'],
  ['hanaTrigger', 'trigger'],
  ['hanaSeed', 'seed'],
  ['hanaMotion', 'motion'],
];

function has(dataset, key) {
  return Object.prototype.hasOwnProperty.call(dataset, key);
}

function invalid(field, value) {
  throw new HanamaruConfigError(
    'HANA_CONFIG_INVALID',
    `Invalid declarative annotation option: ${field}`,
    { field, value },
  );
}

export function parseDeclarative(element) {
  const { dataset } = element;
  if (!has(dataset, 'hana')) invalid('mark', undefined);

  const options = { mark: dataset.hana };
  for (const [attribute, option] of ATTRIBUTES) {
    if (has(dataset, attribute)) options[option] = dataset[attribute];
  }
  if (has(dataset, 'hanaAccessible')) options.accessible = true;
  if (has(dataset, 'hanaDuration')) {
    const value = dataset.hanaDuration;
    if (!/^\d+$/.test(value)) invalid('duration', value);
    const duration = Number(value);
    if (!Number.isInteger(duration)) invalid('duration', value);
    options.duration = duration;
  }
  return options;
}

export function scanDeclarative(root, createAnnotation = annotate) {
  const annotations = [];
  const errors = [];
  try {
    for (const element of root.querySelectorAll('[data-hana]')) {
      try {
        annotations.push(createAnnotation(element, parseDeclarative(element)));
      } catch (error) {
        if (!(error instanceof HanamaruError)) throw error;
        errors.push(error);
      }
    }
  } catch (error) {
    for (let index = annotations.length - 1; index >= 0; index -= 1) {
      try { annotations[index].destroy(); } catch { /* Preserve the programmer error. */ }
    }
    throw error;
  }
  return { annotations, errors };
}

export function scan(root = document) {
  const ShadowRootConstructor = root?.ownerDocument?.defaultView?.ShadowRoot;
  if (typeof ShadowRootConstructor === 'function'
    && root instanceof ShadowRootConstructor) {
    throw new HanamaruTargetError(
      'HANA_TARGET_SHADOW_UNSCOPED',
      'Scanning a ShadowRoot requires an explicit Shadow scope',
      { root },
    );
  }
  return scanDeclarative(root);
}
