import { annotate } from './annotation.js';
import { HanamaruConfigError, HanamaruError } from './errors.js';

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

export function scan(root = document) {
  const annotations = [];
  const errors = [];
  for (const element of root.querySelectorAll('[data-hana]')) {
    try {
      annotations.push(annotate(element, parseDeclarative(element)));
    } catch (error) {
      if (!(error instanceof HanamaruError)) throw error;
      errors.push(error);
    }
  }
  return { annotations, errors };
}
