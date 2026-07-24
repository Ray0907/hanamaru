import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const WORKFLOW_DIRECTORY = path.join(ROOT, '.github', 'workflows');
const EXPECTED_WORKFLOWS = Object.freeze(['ci.yml', 'release.yml']);
const MAIN_CONDITION =
  "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}";
const PACK_SCRIPT = [
  'pack_dir="${RUNNER_TEMP:?}/hanamaru-pack"',
  'rm -rf -- "$pack_dir"',
  'mkdir -p -- "$pack_dir"',
  'node scripts/verify-pack.mjs "$pack_dir"',
].join('\n');
const PLAYWRIGHT_INSTALL =
  'npx --no-install playwright install --with-deps chromium firefox webkit';
const APPROVED_ACTIONS = new Set([
  'actions/checkout@v4',
  'actions/setup-node@v4',
  'actions/upload-artifact@v4',
]);
const FORBIDDEN_TEXT =
  /(?:pull_request_target|(?:un)?publish|gh\s+release|npm\s+config|\.npmrc|registry-url|always-auth|auth|token|secret|write)/iu;

const map = (entries) => new Map(entries);
const step = (entries) => map(entries);

const CHECKOUT_STEP = step([
  ['name', 'Check out the exact commit'],
  ['uses', 'actions/checkout@v4'],
  ['with', map([['persist-credentials', false]])],
]);
const TAG_CHECKOUT_STEP = step([
  ['name', 'Check out the exact tag commit'],
  ['uses', 'actions/checkout@v4'],
  ['with', map([['persist-credentials', false]])],
]);
const SETUP_STEP = step([
  ['name', 'Use the release Node runtime'],
  ['uses', 'actions/setup-node@v4'],
  ['with', map([
    ['node-version', '24.13.0'],
    ['cache', 'npm'],
  ])],
]);
const INSTALL_STEP = step([
  ['name', 'Install locked dependencies'],
  ['run', 'npm ci'],
]);
const BROWSER_STEP = step([
  ['name', 'Install locked browser engines'],
  ['run', PLAYWRIGHT_INSTALL],
]);
const VERIFY_STEP = step([
  ['name', 'Run the complete verification gate'],
  ['run', 'npm run verify'],
]);

const EXPECTED = Object.freeze({
  'ci.yml': map([
    ['name', 'CI'],
    ['on', map([
      ['push', null],
      ['pull_request', null],
    ])],
    ['permissions', map([['contents', 'read']])],
    ['jobs', map([
      ['verify', map([
        ['runs-on', 'ubuntu-latest'],
        ['steps', [
          CHECKOUT_STEP,
          SETUP_STEP,
          INSTALL_STEP,
          BROWSER_STEP,
          VERIFY_STEP,
          step([
            ['name', 'Create and verify the main release candidate'],
            ['if', MAIN_CONDITION],
            ['run', PACK_SCRIPT],
          ]),
          step([
            ['name', 'Upload the main release candidate'],
            ['if', MAIN_CONDITION],
            ['uses', 'actions/upload-artifact@v4'],
            ['with', map([
              ['name', 'hanamaru-main-${{ github.sha }}'],
              ['path', '${{ runner.temp }}/hanamaru-pack'],
              ['if-no-files-found', 'error'],
              ['retention-days', 14],
            ])],
          ]),
        ]],
      ])],
    ])],
  ]),
  'release.yml': map([
    ['name', 'Release artifact'],
    ['on', map([
      ['push', map([
        ['tags', ['v*']],
      ])],
    ])],
    ['permissions', map([['contents', 'read']])],
    ['jobs', map([
      ['verify', map([
        ['runs-on', 'ubuntu-latest'],
        ['steps', [
          TAG_CHECKOUT_STEP,
          SETUP_STEP,
          step([
            ['name', 'Validate the tag against package metadata'],
            ['run', 'node scripts/check-release-tag.mjs'],
          ]),
          INSTALL_STEP,
          BROWSER_STEP,
          VERIFY_STEP,
          step([
            ['name', 'Create and verify the tagged release candidate'],
            ['run', PACK_SCRIPT],
          ]),
          step([
            ['name', 'Upload the tagged release candidate'],
            ['uses', 'actions/upload-artifact@v4'],
            ['with', map([
              ['name', 'hanamaru-${{ github.ref_name }}'],
              ['path', '${{ runner.temp }}/hanamaru-pack'],
              ['if-no-files-found', 'error'],
              ['retention-days', 30],
            ])],
          ]),
        ]],
      ])],
    ])],
  ]),
});

async function workflow(name) {
  return readFile(path.join(WORKFLOW_DIRECTORY, name), 'utf8');
}

function assertExactTree(actual, expected, location = 'workflow') {
  if (expected instanceof Map) {
    assert.equal(actual instanceof Map, true, `${location} must be a map`);
    assert.deepEqual(
      [...actual.keys()],
      [...expected.keys()],
      `${location} keys must match the exact allowlist and order`,
    );
    for (const [key, value] of expected) {
      assertExactTree(actual.get(key), value, `${location}.${String(key)}`);
    }
    return;
  }
  if (Array.isArray(expected)) {
    assert.equal(Array.isArray(actual), true, `${location} must be a sequence`);
    assert.equal(actual.length, expected.length, `${location} length must be exact`);
    expected.forEach((value, index) => {
      assertExactTree(actual[index], value, `${location}[${index}]`);
    });
    return;
  }
  assert.equal(actual, expected, `${location} must match exactly`);
}

function scanForbidden(value, location = 'workflow') {
  if (value instanceof Map) {
    for (const [key, child] of value) {
      assert.equal(
        FORBIDDEN_TEXT.test(String(key)),
        false,
        `${location} contains forbidden key ${String(key)}`,
      );
      if (key === 'uses') {
        assert.equal(
          APPROVED_ACTIONS.has(child),
          true,
          `${location}.uses must be an approved pinned action`,
        );
      }
      scanForbidden(child, `${location}.${String(key)}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => scanForbidden(child, `${location}[${index}]`));
    return;
  }
  if (typeof value === 'string') {
    assert.equal(
      FORBIDDEN_TEXT.test(value),
      false,
      `${location} contains forbidden workflow capability`,
    );
  }
}

export function validateWorkflowContract(name, text) {
  assert.equal(
    Object.hasOwn(EXPECTED, name),
    true,
    `workflow contract is not defined for ${name}`,
  );
  const document = parseDocument(text, {
    maxAliasCount: 0,
    uniqueKeys: true,
    version: '1.2',
  });
  assert.deepEqual(
    document.errors.map((error) => error.message),
    [],
    `${name} must be valid duplicate-free YAML 1.2`,
  );
  const parsed = document.toJS({
    mapAsMap: true,
    maxAliasCount: 0,
  });
  assert.equal(parsed instanceof Map, true, `${name} root must be a map`);
  assert.equal(
    [...text.matchAll(/^"on":$/gmu)].length,
    1,
    `${name} must quote the root "on" key exactly once`,
  );
  assert.equal(parsed.has('on'), true, `${name} must retain on as a string key`);
  assert.equal(parsed.has(true), false, `${name} must never coerce on to boolean true`);
  scanForbidden(parsed, name);
  assertExactTree(parsed, EXPECTED[name], name);

  const steps = parsed.get('jobs').get('verify').get('steps');
  const verifierSteps = steps.filter(
    (candidate) => candidate.get('run')?.includes('scripts/verify-pack.mjs'),
  );
  assert.equal(verifierSteps.length, 1, `${name} must invoke verify-pack exactly once`);
  const packLines = verifierSteps[0].get('run').split('\n');
  assert.equal(
    packLines.at(-1),
    'node scripts/verify-pack.mjs "$pack_dir"',
    `${name} verifier must be the final pack command`,
  );
  assert.equal(
    packLines.filter((line) => line.includes('scripts/verify-pack.mjs')).length,
    1,
    `${name} pack body must invoke verify-pack exactly once`,
  );
  return parsed;
}

function replaceOnce(text, before, after) {
  const first = text.indexOf(before);
  assert.notEqual(first, -1, `mutation source missing: ${before}`);
  assert.equal(text.indexOf(before, first + before.length), -1, `mutation source not unique: ${before}`);
  return `${text.slice(0, first)}${after}${text.slice(first + before.length)}`;
}

test('workflow discovery is exact and cannot pass with zero matching workflows', async () => {
  const discovered = (await readdir(WORKFLOW_DIRECTORY))
    .filter((file) => /\.ya?ml$/u.test(file))
    .sort();
  assert.equal(EXPECTED_WORKFLOWS.length, 2);
  assert.deepEqual(discovered, EXPECTED_WORKFLOWS);
});

for (const name of EXPECTED_WORKFLOWS) {
  test(`${name} parses as its exact least-privilege workflow contract`, async () => {
    validateWorkflowContract(name, await workflow(name));
  });
}

test('workflow parser rejects syntax errors, duplicate keys, and on coercion', async () => {
  const source = await workflow('ci.yml');
  assert.throws(
    () => validateWorkflowContract('ci.yml', `${source}\njobs: {}\n`),
    /duplicate-free YAML 1\.2/u,
  );
  assert.throws(
    () => validateWorkflowContract('ci.yml', replaceOnce(source, 'jobs:', 'jobs: [')),
    /duplicate-free YAML 1\.2/u,
  );
  assert.throws(
    () => validateWorkflowContract('ci.yml', replaceOnce(source, '"on":', 'true:')),
    /quote the root "on" key|string key|keys must match/u,
  );
  assert.throws(
    () => validateWorkflowContract('ci.yml', replaceOnce(source, '"on":', 'on:')),
    /quote the root "on" key/u,
  );
});

test('exact workflow allowlists reject every release-safety mutation', async () => {
  const ci = await workflow('ci.yml');
  const release = await workflow('release.yml');
  const mutations = [
    [
      'post-pack command',
      'ci.yml',
      replaceOnce(
        ci,
        'node scripts/verify-pack.mjs "$pack_dir"',
        'node scripts/verify-pack.mjs "$pack_dir"\nprintf unsafe > "$pack_dir/extra"',
      ),
    ],
    [
      'extra step',
      'ci.yml',
      replaceOnce(
        ci,
        '      - name: Install locked dependencies',
        '      - name: Unexpected step\n        run: node --version\n      - name: Install locked dependencies',
      ),
    ],
    [
      'duplicate action',
      'ci.yml',
      replaceOnce(ci, 'actions/setup-node@v4', 'actions/checkout@v4'),
    ],
    [
      'changed action',
      'ci.yml',
      replaceOnce(ci, 'actions/upload-artifact@v4', 'actions/upload-artifact@v3'),
    ],
    [
      'npm unpublish',
      'release.yml',
      replaceOnce(release, 'npm run verify', 'npm unpublish hanamaru-annotations'),
    ],
    [
      'wrong condition',
      'ci.yml',
      replaceOnce(
        ci,
        `      - name: Create and verify the main release candidate
        if: ${MAIN_CONDITION}`,
        `      - name: Create and verify the main release candidate
        if: \${{ github.event_name == 'push' && github.ref == 'refs/heads/dev' }}`,
      ),
    ],
    [
      'wrong path',
      'release.yml',
      replaceOnce(
        release,
        '${{ runner.temp }}/hanamaru-pack',
        './hanamaru-pack',
      ),
    ],
    [
      'wrong order',
      'release.yml',
      replaceOnce(
        release,
        '      - name: Install locked dependencies\n        run: npm ci\n      - name: Install locked browser engines\n        run: npx --no-install playwright install --with-deps chromium firefox webkit',
        '      - name: Install locked browser engines\n        run: npx --no-install playwright install --with-deps chromium firefox webkit\n      - name: Install locked dependencies\n        run: npm ci',
      ),
    ],
  ];

  assert.equal(mutations.length, 8, 'zero-test guard: all safety mutations exist');
  for (const [label, name, mutation] of mutations) {
    assert.throws(
      () => validateWorkflowContract(name, mutation),
      undefined,
      label,
    );
  }
});

test('recursive security scan rejects forbidden triggers, permissions, env, and commands', async () => {
  const ci = await workflow('ci.yml');
  const mutations = [
    replaceOnce(ci, 'pull_request:', 'pull_request_target:'),
    replaceOnce(ci, 'contents: read', 'contents: write'),
    replaceOnce(
      ci,
      '    runs-on: ubuntu-latest',
      `    runs-on: ubuntu-latest
    env:
      NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}`,
    ),
    replaceOnce(ci, 'npm run verify', 'gh release create v0.1.0'),
  ];

  assert.equal(mutations.length, 4, 'zero-test guard: all forbidden scans exist');
  for (const mutation of mutations) {
    assert.throws(
      () => validateWorkflowContract('ci.yml', mutation),
      /forbidden workflow|forbidden key/u,
    );
  }
});

test('workflow parser dependency is exact and remains development-only', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.devDependencies.yaml, '2.9.0');
  assert.equal(Object.hasOwn(manifest, 'dependencies'), false);
});
