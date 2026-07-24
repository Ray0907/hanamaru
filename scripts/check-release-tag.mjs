import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER_SOURCE = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?`;
const SEMVER = new RegExp(`^${SEMVER_SOURCE}$`, 'u');
const RELEASE_TAG = new RegExp(`^v${SEMVER_SOURCE}$`, 'u');

export function isValidSemver(version) {
  return typeof version === 'string' && SEMVER.test(version);
}

export function validateReleaseTag(version, tag) {
  if (!isValidSemver(version)) {
    throw new Error('release-tag: package version is not valid SemVer 2.0.0');
  }
  if (tag === undefined || tag === null || tag === '') {
    throw new Error('release-tag: tag is required');
  }
  if (typeof tag !== 'string' || !RELEASE_TAG.test(tag)) {
    throw new Error('release-tag: tag is not valid v-prefixed SemVer 2.0.0');
  }
  if (tag !== `v${version}`) {
    throw new Error(
      `release-tag: tag ${tag} does not match package version ${version}`,
    );
  }
  return { tag, version };
}

export function resolveReleaseTag(cliArguments = [], environment = process.env) {
  return cliArguments.length > 0
    ? cliArguments[0]
    : environment.GITHUB_REF_NAME;
}

export async function checkReleaseTag(root, tag) {
  const projectRoot = path.resolve(root);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  } catch {
    throw new Error('release-tag: cannot read package.json');
  }
  return validateReleaseTag(manifest.version, tag);
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    const root = path.resolve(path.dirname(modulePath), '..');
    const result = await checkReleaseTag(
      root,
      resolveReleaseTag(process.argv.slice(2), process.env),
    );
    console.log(`release-tag: pass ${result.tag}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'release-tag: validation failed');
    process.exitCode = 1;
  }
}
