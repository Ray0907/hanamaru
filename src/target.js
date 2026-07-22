import { HanamaruConfigError } from './errors.js';

function invalid(field, value) {
  return new HanamaruConfigError(
    'HANA_CONFIG_INVALID',
    `Invalid ${field}`,
    { field, value },
  );
}

function normalizeText(value) {
  return value.trim().replace(/\s+/gu, ' ');
}

export function normalizeLocatorText(value) {
  if (typeof value !== 'string') {
    throw invalid('text', value);
  }

  const normalized = normalizeText(value);
  if (normalized.length === 0) {
    throw invalid('text', value);
  }

  return normalized;
}

export function findMatchOffsets(source, needle) {
  if (typeof source !== 'string') {
    throw invalid('source', source);
  }

  const normalizedSource = normalizeText(source);
  const normalizedNeedle = normalizeLocatorText(needle);
  const matches = [];
  let cursor = 0;

  while (cursor < normalizedSource.length) {
    const start = normalizedSource.indexOf(normalizedNeedle, cursor);
    if (start === -1) {
      break;
    }

    const end = start + normalizedNeedle.length;
    matches.push([start, end]);
    cursor = end;
  }

  return matches;
}

export function validateOccurrence(value) {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw invalid('occurrence', value);
  }

  return value;
}
