import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkReleaseTag,
  isValidSemver,
  resolveReleaseTag,
  validateReleaseTag,
} from '../../scripts/check-release-tag.mjs';

const validVersions = Object.freeze([
  '0.1.0',
  '1.0.0-alpha',
  '1.0.0-alpha.1',
  '1.0.0-0.3.7',
  '1.0.0-x.7.z.92',
  '1.0.0+build.1',
  '1.0.0-beta+exp.sha.5114f85',
]);

const invalidVersions = Object.freeze([
  '',
  '1',
  '1.2',
  '01.2.3',
  '1.02.3',
  '1.2.03',
  '1.2.3-01',
  '1.2.3-',
  '1.2.3+',
  '1.2.3+build..1',
  'v1.2.3',
  ' 1.2.3',
  '1.2.3 ',
]);

test('SemVer validator accepts the full release grammar', () => {
  for (const version of validVersions) {
    assert.equal(isValidSemver(version), true, version);
  }
});

test('SemVer validator rejects malformed and leading-zero versions', () => {
  for (const version of invalidVersions) {
    assert.equal(isValidSemver(version), false, version);
  }
});

test('release tag validation requires exact v plus package version bytes', () => {
  for (const version of validVersions) {
    assert.deepEqual(validateReleaseTag(version, `v${version}`), {
      tag: `v${version}`,
      version,
    });
  }
  assert.throws(
    () => validateReleaseTag('0.1.0', 'v0.1.00'),
    /release-tag: tag is not valid v-prefixed SemVer 2\.0\.0/u,
  );
  assert.throws(
    () => validateReleaseTag('0.1.0', 'v0.1.0+build'),
    /release-tag: tag v0\.1\.0\+build does not match package version 0\.1\.0/u,
  );
  assert.throws(
    () => validateReleaseTag('0.1.0+build.1', 'v0.1.0+build.01'),
    /does not match package version/u,
  );
});

test('release tag validation reports missing and malformed values concisely', () => {
  assert.throws(
    () => validateReleaseTag('0.1.0', undefined),
    /release-tag: tag is required/u,
  );
  assert.throws(
    () => validateReleaseTag('01.0.0', 'v01.0.0'),
    /release-tag: package version is not valid SemVer 2\.0\.0/u,
  );
  assert.throws(
    () => validateReleaseTag('0.1.0', '0.1.0'),
    /release-tag: tag is not valid v-prefixed SemVer 2\.0\.0/u,
  );
});

test('explicit CLI tag wins and environment is used only when no argument exists', () => {
  assert.equal(resolveReleaseTag(['v0.1.0'], { GITHUB_REF_NAME: 'v9.9.9' }), 'v0.1.0');
  assert.equal(resolveReleaseTag([], { GITHUB_REF_NAME: 'v0.1.0' }), 'v0.1.0');
  assert.equal(resolveReleaseTag([''], { GITHUB_REF_NAME: 'v0.1.0' }), '');
  assert.equal(resolveReleaseTag([], {}), undefined);
});

test('checkReleaseTag reads package.json from the explicit project root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-release-tag-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'nested'));
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '2.3.4-rc.1+build.5' }),
  );

  assert.deepEqual(await checkReleaseTag(root, 'v2.3.4-rc.1+build.5'), {
    tag: 'v2.3.4-rc.1+build.5',
    version: '2.3.4-rc.1+build.5',
  });
  await assert.rejects(
    checkReleaseTag(path.join(root, 'nested'), 'v2.3.4-rc.1+build.5'),
    /release-tag: cannot read package\.json/u,
  );
});
