export const REQUIRED_TYPE_FIXTURES = Object.freeze([
  'main.ts',
  'selection.ts',
  'group.ts',
  'plugins.ts',
  'serialize.ts',
  'shadow.ts',
  'adapters.tsx',
]);

export function orderTypeFixtures(discoveredNames) {
  const discovered = new Set(discoveredNames);
  if (discovered.size === 0) {
    throw new Error('type contract runner requires at least one fixture');
  }

  const missing = REQUIRED_TYPE_FIXTURES.filter((name) => !discovered.has(name));
  if (missing.length > 0) {
    throw new Error(
      `type contract runner missing required fixture(s): ${missing.join(', ')}`,
    );
  }

  for (const name of REQUIRED_TYPE_FIXTURES) discovered.delete(name);
  return [...REQUIRED_TYPE_FIXTURES, ...[...discovered].sort()];
}
