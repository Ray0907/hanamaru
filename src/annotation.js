import { HanamaruConfigError } from './errors.js';

const MARKS = new Set(['underline', 'highlight', 'circle', 'box', 'strike', 'bracket']);
const PLACEMENTS = new Set(['auto', 'top', 'right', 'bottom', 'left']);
const TRIGGERS = new Set(['manual', 'load', 'viewport']);
const MOTIONS = new Set(['system', 'never']);
const KEYS = new Set(['mark', 'note', 'placement', 'trigger', 'accessible', 'seed', 'duration', 'motion']);

function invalid(field, value) {
  throw new HanamaruConfigError(
    'HANA_CONFIG_INVALID',
    `Invalid annotation option: ${field}`,
    { field, value },
  );
}

function has(input, key) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function optional(input, key, fallback) {
  return has(input, key) ? input[key] : fallback;
}

export function normalizeOptions(input, fallbackSeed, { allowUnknown = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalid('input', input);
  }

  if (!allowUnknown) {
    for (const key of Object.keys(input)) {
      if (!KEYS.has(key)) invalid(key, input[key]);
    }
  }

  const mark = input.mark;
  if (!MARKS.has(mark)) invalid('mark', mark);

  const note = optional(input, 'note', null);
  if (note !== null && typeof note !== 'string') invalid('note', note);
  if (typeof note === 'string' && [...note].length > 280) invalid('note', note);

  const placement = optional(input, 'placement', 'auto');
  if (!PLACEMENTS.has(placement)) invalid('placement', placement);

  const trigger = optional(input, 'trigger', 'manual');
  if (!TRIGGERS.has(trigger)) invalid('trigger', trigger);

  const accessible = optional(input, 'accessible', false);
  if (typeof accessible !== 'boolean') invalid('accessible', accessible);

  const seed = optional(input, 'seed', fallbackSeed);
  if (typeof seed !== 'string' && !(typeof seed === 'number' && Number.isFinite(seed))) {
    invalid('seed', seed);
  }

  const duration = optional(input, 'duration', 650);
  if (!Number.isInteger(duration) || duration < 0) invalid('duration', duration);

  const motion = optional(input, 'motion', 'system');
  if (!MOTIONS.has(motion)) invalid('motion', motion);

  return {
    mark,
    note: note === '' ? null : note,
    placement,
    trigger,
    accessible,
    seed,
    duration,
    motion,
  };
}
