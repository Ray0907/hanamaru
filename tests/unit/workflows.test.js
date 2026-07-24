import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const WORKFLOW_DIRECTORY = path.join(ROOT, '.github', 'workflows');
const EXPECTED_WORKFLOWS = Object.freeze(['ci.yml', 'release.yml']);

async function workflow(name) {
  return readFile(path.join(WORKFLOW_DIRECTORY, name), 'utf8');
}

function occurrences(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function indexOfRequired(text, snippet) {
  const index = text.indexOf(snippet);
  assert.notEqual(index, -1, `missing workflow contract: ${snippet}`);
  return index;
}

function assertInOrder(text, snippets) {
  let previous = -1;
  for (const snippet of snippets) {
    const current = indexOfRequired(text, snippet);
    assert.ok(
      current > previous,
      `workflow step must occur after its predecessor: ${snippet}`,
    );
    previous = current;
  }
}

function assertSharedSecurityContract(text) {
  assert.match(text, /^permissions:\n  contents: read$/mu);
  assert.equal(occurrences(text, /uses: actions\/checkout@v4$/gmu), 1);
  assert.equal(occurrences(text, /uses: actions\/setup-node@v4$/gmu), 1);
  assert.equal(occurrences(text, /uses: actions\/upload-artifact@v4$/gmu), 1);
  assert.equal(occurrences(text, /persist-credentials: false$/gmu), 1);
  assert.equal(occurrences(text, /node-version: 24\.13\.0$/gmu), 1);
  assert.equal(occurrences(text, /run: npm ci$/gmu), 1);

  assert.doesNotMatch(text, /\bpull_request_target\b/u);
  assert.doesNotMatch(text, /\bid-token\s*:/u);
  assert.doesNotMatch(text, /\bpackages\s*:/u);
  assert.doesNotMatch(text, /\bsecrets\s*:/u);
  assert.doesNotMatch(text, /(?:NODE_AUTH_TOKEN|NPM_TOKEN|npm-token|registry-url|always-auth)/iu);
  assert.doesNotMatch(text, /(?:\$\{\{\s*secrets\.|\.npmrc|\bpublish\b|gh\s+release)/iu);
  assert.doesNotMatch(text, /^\s+[a-z][a-z-]*:\s*write$/gmu);
  assert.doesNotMatch(text, /(?:git\s+config|credential\.helper|git-credentials)/iu);
  assert.equal(occurrences(text, /uses: actions\/[^@\s]+@v4$/gmu), 3);
  assert.equal(occurrences(text, /uses: /gmu), 3);
}

function assertFreshPackDirectory(text) {
  assertInOrder(text, [
    'rm -rf -- "$RUNNER_TEMP/hanamaru-pack"',
    'mkdir -- "$RUNNER_TEMP/hanamaru-pack"',
    'node scripts/verify-pack.mjs "$RUNNER_TEMP/hanamaru-pack"',
  ]);
  assert.equal(
    occurrences(
      text,
      /node scripts\/verify-pack\.mjs "\$RUNNER_TEMP\/hanamaru-pack"/gu,
    ),
    1,
  );
  assert.doesNotMatch(
    text,
    /verify-pack\.mjs\s+(?:"|')?(?:\.|dist|artifacts?|package)(?:\/|\s|"|')/u,
  );
}

test('workflow discovery is exact and cannot pass with zero matching workflows', async () => {
  const discovered = (await readdir(WORKFLOW_DIRECTORY))
    .filter((file) => /\.ya?ml$/u.test(file))
    .sort();
  assert.equal(EXPECTED_WORKFLOWS.length, 2);
  assert.deepEqual(discovered, EXPECTED_WORKFLOWS);
});

test('CI is read-only, verifies once, and packs only an exact main push', async () => {
  const text = await workflow('ci.yml');
  let assertions = 0;
  const prove = (condition, message) => {
    assertions += 1;
    assert.ok(condition, message);
  };

  assertSharedSecurityContract(text);
  assert.match(text, /^on:\n  push:\n  pull_request:$/mu);
  assert.equal(occurrences(text, /^  [a-z][a-z-]*:\n    runs-on: ubuntu-latest$/gmu), 1);
  assertInOrder(text, [
    'uses: actions/checkout@v4',
    'uses: actions/setup-node@v4',
    'run: npm ci',
    'run: npx --no-install playwright install --with-deps chromium firefox webkit',
    'run: npm run verify',
    'node scripts/verify-pack.mjs "$RUNNER_TEMP/hanamaru-pack"',
    'uses: actions/upload-artifact@v4',
  ]);
  assert.equal(occurrences(text, /run: npm run verify$/gmu), 1);
  assert.equal(
    occurrences(
      text,
      /if: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}$/gmu,
    ),
    2,
  );
  assertFreshPackDirectory(text);
  assert.match(text, /name: hanamaru-main-\$\{\{ github\.sha \}\}/u);
  assert.match(text, /path: \$\{\{ runner\.temp \}\}\/hanamaru-pack/u);
  assert.match(text, /if-no-files-found: error/u);
  assert.match(text, /retention-days: (?:[1-9]|[12]\d|30)$/mu);
  assert.doesNotMatch(text, /github\.event_name == 'pull_request'/u);

  prove(occurrences(text, /^      - name: /gmu) >= 7, 'CI must discover its expected steps');
  prove(text.includes("github.event_name == 'push'"), 'CI artifact must require a push event');
  prove(text.includes("github.ref == 'refs/heads/main'"), 'CI artifact must require main');
  assert.equal(assertions, 3, 'zero-test guard: all CI condition proofs ran');
});

test('release validates the tag before installs and produces one read-only tag artifact', async () => {
  const text = await workflow('release.yml');
  let assertions = 0;
  const prove = (condition, message) => {
    assertions += 1;
    assert.ok(condition, message);
  };

  assertSharedSecurityContract(text);
  assert.match(text, /^on:\n  push:\n    tags:\n      - 'v\*'$/mu);
  assert.doesNotMatch(text, /\bworkflow_dispatch\b/u);
  assert.equal(occurrences(text, /^  [a-z][a-z-]*:\n    runs-on: ubuntu-latest$/gmu), 1);
  assertInOrder(text, [
    'uses: actions/checkout@v4',
    'uses: actions/setup-node@v4',
    'run: node scripts/check-release-tag.mjs',
    'run: npm ci',
    'run: npx --no-install playwright install --with-deps chromium firefox webkit',
    'run: npm run verify',
    'node scripts/verify-pack.mjs "$RUNNER_TEMP/hanamaru-pack"',
    'uses: actions/upload-artifact@v4',
  ]);
  assert.equal(occurrences(text, /run: node scripts\/check-release-tag\.mjs$/gmu), 1);
  assert.equal(occurrences(text, /run: npm run verify$/gmu), 1);
  assertFreshPackDirectory(text);
  assert.match(text, /name: hanamaru-\$\{\{ github\.ref_name \}\}/u);
  assert.match(text, /path: \$\{\{ runner\.temp \}\}\/hanamaru-pack/u);
  assert.match(text, /if-no-files-found: error/u);
  assert.match(text, /retention-days: (?:[1-9]|[12]\d|30)$/mu);
  assert.doesNotMatch(text, /\bif:/u);

  prove(occurrences(text, /^      - name: /gmu) >= 8, 'release must discover its expected steps');
  prove(text.includes("      - 'v*'"), 'release must discover the v-prefixed tag filter');
  prove(!text.includes('branches:'), 'release must not run on branch pushes');
  assert.equal(assertions, 3, 'zero-test guard: all release trigger proofs ran');
});
