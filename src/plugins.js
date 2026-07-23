import { HanamaruConfigError, HanamaruStateError } from './errors.js';
import { runtimeState } from './runtime-state.js';

const BUILT_INS = new Set(['underline', 'highlight', 'circle', 'box', 'strike', 'bracket']);
const NAME = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,47}$/;
const RECT_KEYS = ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'];
const PATH_ARITY = {
  A: 7,
  C: 6,
  H: 1,
  L: 2,
  M: 2,
  Q: 4,
  S: 4,
  T: 2,
  V: 1,
  Z: 0,
};

function invalid(field, value) {
  throw new HanamaruConfigError(
    'HANA_CONFIG_INVALID',
    `Invalid mark plugin: ${field}`,
    { field, value },
  );
}

function ownData(input, keys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) return false;
  const names = Reflect.ownKeys(input);
  if (names.length !== keys.length || names.some((key) => !keys.includes(key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value');
  });
}

function finite(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(field, value);
  return value;
}

function format(value) {
  const rounded = Math.abs(value) >= Number.MAX_VALUE / 100
    ? value
    : Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function fnv1a(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

function helperOptions(input, defaults) {
  if (input === undefined) return defaults;
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) invalid('options', input);
  for (const key of Reflect.ownKeys(input)) {
    if (key !== 'label' && key !== 'wobble') invalid('options', input);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) invalid(key, input);
  }
  const labelProperty = Object.getOwnPropertyDescriptor(input, 'label');
  const wobbleProperty = Object.getOwnPropertyDescriptor(input, 'wobble');
  const label = labelProperty === undefined ? defaults.label : labelProperty.value;
  const wobble = wobbleProperty === undefined ? defaults.wobble : wobbleProperty.value;
  if (typeof label !== 'string') invalid('label', label);
  finite(wobble, 'wobble');
  if (wobble < 0) invalid('wobble', wobble);
  return { label, wobble };
}

function point(input, field) {
  if (input === null || typeof input !== 'object') invalid(field, input);
  const x = Object.getOwnPropertyDescriptor(input, 'x');
  const y = Object.getOwnPropertyDescriptor(input, 'y');
  if (x === undefined || y === undefined
    || !Object.hasOwn(x, 'value') || !Object.hasOwn(y, 'value')) invalid(field, input);
  return {
    x: finite(x.value, `${field}.x`),
    y: finite(y.value, `${field}.y`),
  };
}

function createHelpers(seed) {
  function jitter(label, amplitude) {
    if (typeof label !== 'string') invalid('label', label);
    finite(amplitude, 'amplitude');
    if (amplitude < 0) invalid('amplitude', amplitude);
    const hash = fnv1a(`${seed}:${label}`);
    return Number(format(((((hash / 0xffffffff) * 2) - 1) * amplitude)));
  }

  function line(startInput, endInput, optionsInput = undefined) {
    const start = point(startInput, 'start');
    const end = point(endInput, 'end');
    const { label, wobble } = helperOptions(optionsInput, { label: 'line', wobble: 1 });
    const sx = start.x + jitter(`${label}:start:x`, wobble);
    const sy = start.y + jitter(`${label}:start:y`, wobble);
    const ex = end.x + jitter(`${label}:end:x`, wobble);
    const ey = end.y + jitter(`${label}:end:y`, wobble);
    const cx = (sx / 2) + (ex / 2) + jitter(`${label}:control:x`, wobble);
    const cy = (sy / 2) + (ey / 2) + jitter(`${label}:control:y`, wobble);
    return `M ${format(sx)} ${format(sy)} Q ${format(cx)} ${format(cy)} ${format(ex)} ${format(ey)}`;
  }

  function closedPath(pointsInput, optionsInput = undefined) {
    if (!Array.isArray(pointsInput) || pointsInput.length < 3) invalid('points', pointsInput);
    const points = [];
    for (let index = 0; index < pointsInput.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(pointsInput, String(index));
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        invalid(`points[${index}]`, pointsInput);
      }
      points.push(point(descriptor.value, `points[${index}]`));
    }
    const { label, wobble } = helperOptions(
      optionsInput,
      { label: 'closed', wobble: 1 },
    );
    const output = points.map((value, index) => (
      `${format(value.x + jitter(`${label}:${index}:x`, wobble))}`
      + ` ${format(value.y + jitter(`${label}:${index}:y`, wobble))}`
    ));
    return `M ${output.join(' L ')} Z`;
  }

  return Object.freeze({ jitter, line, closedPath });
}

function canonicalSeed(value) {
  if (typeof value === 'string') return value;
  return finite(value, 'seed');
}

function copyRect(input, field) {
  const output = {};
  for (const key of RECT_KEYS) output[key] = finite(input[key], `${field}.${key}`);
  return Object.freeze(output);
}

function validPath(path) {
  let index = 0;
  let firstCommand = true;
  const whitespace = () => {
    while (index < path.length && /[\t\n\f\r ]/.test(path[index])) index += 1;
  };
  const value = (kind, mayFollowValue) => {
    whitespace();
    if (path[index] === ',') {
      if (!mayFollowValue) return false;
      index += 1;
      whitespace();
      if (index === path.length || path[index] === ','
        || /[A-Za-z]/.test(path[index])) return false;
    }
    if (kind === 'flag') {
      if (path[index] !== '0' && path[index] !== '1') return false;
      index += 1;
      return true;
    }
    const match = /^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?/.exec(
      path.slice(index),
    );
    if (match === null || !Number.isFinite(Number(match[0]))) return false;
    if (kind === 'radius' && match[0][0] === '-') return false;
    index += match[0].length;
    return true;
  };

  while (true) {
    whitespace();
    if (index === path.length) return !firstCommand;
    const command = path[index];
    if (!/[A-Za-z]/.test(command)
      || !Object.hasOwn(PATH_ARITY, command.toUpperCase())) return false;
    const upper = command.toUpperCase();
    if (firstCommand && upper !== 'M') return false;
    firstCommand = false;
    index += 1;
    const arity = PATH_ARITY[upper];
    if (arity === 0) {
      continue;
    }

    let groups = 0;
    while (true) {
      for (let parameter = 0; parameter < arity; parameter += 1) {
        let kind = 'number';
        if (upper === 'A' && (parameter === 0 || parameter === 1)) kind = 'radius';
        else if (upper === 'A' && (parameter === 3 || parameter === 4)) kind = 'flag';
        if (!value(kind, parameter > 0 || groups > 0)) return false;
      }
      groups += 1;
      const next = index;
      whitespace();
      if (index === path.length || /[A-Za-z]/.test(path[index])) break;
      index = next;
    }
  }
}

function validateResult(result) {
  if (!ownData(result, ['paths'])) invalid('result', result);
  const paths = Object.getOwnPropertyDescriptor(result, 'paths').value;
  if (!Array.isArray(paths) || Object.getPrototypeOf(paths) !== Array.prototype
    || paths.length === 0 || paths.length > 32) invalid('paths', paths);
  const output = [];
  for (let index = 0; index < paths.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(paths, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'string'
      || descriptor.value.length === 0 || descriptor.value.length > 16384
      || !validPath(descriptor.value)) invalid(`paths[${index}]`, descriptor?.value);
    output.push(descriptor.value);
  }
  return output;
}

function pluginError(mark, cause) {
  return new HanamaruStateError(
    'HANA_STATE_MARK_PLUGIN',
    `Custom mark plugin failed: ${mark}`,
    { mark, cause },
  );
}

function createRecord(name, factory) {
  return Object.freeze({
    factory,
    build(rectsInput, unionRectInput, seed, padding) {
      try {
        const rects = Object.freeze(rectsInput.map(
          (value, index) => copyRect(value, `rects[${index}]`),
        ));
        const unionRect = copyRect(unionRectInput, 'unionRect');
        const normalizedSeed = canonicalSeed(seed);
        const context = Object.freeze({
          rects,
          unionRect,
          seed: normalizedSeed,
          padding: finite(padding, 'padding'),
          helpers: createHelpers(normalizedSeed),
        });
        return validateResult(factory(context));
      } catch (cause) {
        throw pluginError(name, cause);
      }
    },
  });
}

export function registerMark(name, factory) {
  if (typeof name !== 'string' || !NAME.test(name)) invalid('name', name);
  if (BUILT_INS.has(name)) invalid('name', name);
  if (typeof factory !== 'function') invalid('factory', factory);
  if (runtimeState.plugins.has(name)) invalid('name', name);

  const record = createRecord(name, factory);
  runtimeState.plugins.set(name, record);
  let active = true;
  return function unregister() {
    if (!active) return;
    active = false;
    if (runtimeState.plugins.get(name) === record) runtimeState.plugins.delete(name);
  };
}
