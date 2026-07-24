import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { checkBuiltExports } from './check-exports.mjs';
import { isValidSemver } from './check-release-tag.mjs';

const EXPECTED_PACKAGE_NAME = 'hanamaru-annotations';
const FORBIDDEN_PRODUCTION_FIELDS = Object.freeze([
  'dependencies',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies',
]);

const PACKAGE_ENTRY_EXPORTS = Object.freeze({
  'hanamaru-annotations': Object.freeze([
    'HanamaruConfigError',
    'HanamaruError',
    'HanamaruStateError',
    'HanamaruTargetError',
    'VERSION',
    'annotate',
    'scan',
    'story',
  ]),
  'hanamaru-annotations/selection': Object.freeze(['annotateSelection']),
  'hanamaru-annotations/serialize': Object.freeze([
    'resolveSerializedTarget',
    'restore',
    'serialize',
  ]),
  'hanamaru-annotations/group': Object.freeze(['group']),
  'hanamaru-annotations/plugins': Object.freeze(['registerMark']),
  'hanamaru-annotations/shadow': Object.freeze(['createShadowScope']),
  'hanamaru-annotations/react': Object.freeze(['useAnnotation']),
  'hanamaru-annotations/vue': Object.freeze(['useAnnotation']),
  'hanamaru-annotations/svelte': Object.freeze(['annotation']),
});

const CSS_EXPORTS = Object.freeze([
  'hanamaru-annotations/style.css',
  'hanamaru-annotations/shadow/style.css',
]);

function normalizePackedPath(file) {
  if (typeof file !== 'string' || file.length === 0 || file.includes('\0')) {
    throw new Error('pack-verify: packed file set contains an invalid path');
  }
  const posixPath = file.replaceAll('\\', '/');
  const normalized = posixPath.startsWith('package/')
    ? posixPath.slice('package/'.length)
    : posixPath;
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.includes('/../')
  ) {
    throw new Error('pack-verify: packed file set contains an invalid path');
  }
  return normalized;
}

function sortedUniqueFiles(files) {
  const normalized = files.map(normalizePackedPath).sort();
  const duplicate = normalized.find((file, index) => file === normalized[index - 1]);
  if (duplicate) {
    throw new Error(`pack-verify: packed file set mismatch (duplicate ${duplicate})`);
  }
  return normalized;
}

export function expectedPackFiles(distFiles) {
  return [
    'LICENSE',
    'README.md',
    ...distFiles.map((file) => `dist/${normalizePackedPath(file)}`),
    'package.json',
  ].sort();
}

export function validatePackFileList(files, distFiles) {
  if (!Array.isArray(files)) {
    throw new Error('pack-verify: packed file set is missing');
  }
  const actual = sortedUniqueFiles(files);
  const expected = expectedPackFiles(distFiles);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((file) => !actualSet.has(file));
  const unexpected = actual.filter((file) => !expectedSet.has(file));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      missing.length > 0 ? `missing ${missing.join(', ')}` : '',
      unexpected.length > 0 ? `unexpected ${unexpected.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(`pack-verify: packed file set mismatch (${details})`);
  }
  return actual;
}

export function npmInvocation(
  args,
  npmCliPath,
  nodePath = process.execPath,
) {
  if (typeof npmCliPath !== 'string' || !path.isAbsolute(npmCliPath)) {
    throw new Error('pack-verify: npm CLI path must be absolute');
  }
  if (typeof nodePath !== 'string' || !path.isAbsolute(nodePath)) {
    throw new Error('pack-verify: Node executable path must be absolute');
  }
  return { file: nodePath, args: [npmCliPath, ...args] };
}

async function usableNpmCli(candidate, dependencies) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return;
  try {
    const resolved = await dependencies.realpathImpl(candidate);
    const stats = await dependencies.lstatImpl(resolved);
    if (stats.isFile() && path.basename(resolved) === 'npm-cli.js') return resolved;
  } catch {
    // Try the next deterministic candidate.
  }
}

export async function resolveNpmCli(options = {}) {
  const dependencies = {
    lstatImpl: options.lstatImpl ?? lstat,
    realpathImpl: options.realpathImpl ?? realpath,
  };
  if (options.npmCliPath !== undefined) {
    const explicit = await usableNpmCli(options.npmCliPath, dependencies);
    if (!explicit) throw new Error('pack-verify: configured npm CLI could not be resolved');
    return explicit;
  }

  const environment = options.env ?? process.env;
  const fromEnvironment = await usableNpmCli(environment.npm_execpath, dependencies);
  if (fromEnvironment) return fromEnvironment;

  const nodePath = path.resolve(options.execPath ?? process.execPath);
  const nodeDirectory = path.dirname(nodePath);
  const candidates = [
    path.resolve(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDirectory, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const directory of (environment.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    candidates.push(
      path.resolve(directory, 'npm'),
      path.resolve(directory, 'npm-cli.js'),
      path.resolve(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.resolve(directory, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.resolve(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
  }
  for (const candidate of new Set(candidates)) {
    const resolved = await usableNpmCli(candidate, dependencies);
    if (resolved) return resolved;
  }
  throw new Error('pack-verify: npm CLI could not be resolved');
}

function execute(invocation, cwd, execFileImpl) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      invocation.file,
      invocation.args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function canonicalDirectory(directory, label) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new Error(`pack-verify: ${label} directory is required`);
  }
  let resolved;
  let stats;
  try {
    resolved = await realpath(path.resolve(directory));
    stats = await lstat(resolved);
  } catch {
    throw new Error(`pack-verify: ${label} directory does not exist`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`pack-verify: ${label} directory is not a directory`);
  }
  return resolved;
}

async function captureOutputDirectory(directory) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new Error('pack-verify: output directory is required');
  }
  const requested = path.resolve(directory);
  let requestedStats;
  let resolved;
  let resolvedStats;
  try {
    requestedStats = await lstat(requested);
    resolved = await realpath(requested);
    resolvedStats = await lstat(resolved);
  } catch {
    throw new Error('pack-verify: output directory does not exist');
  }
  if (requestedStats.isSymbolicLink()) {
    throw new Error('pack-verify: output directory must not be a symbolic link');
  }
  if (!requestedStats.isDirectory() || !resolvedStats.isDirectory()) {
    throw new Error('pack-verify: output directory is not a directory');
  }
  return Object.freeze({
    dev: resolvedStats.dev,
    finalPath: resolved,
    ino: resolvedStats.ino,
    path: resolved,
  });
}

export async function assertOutputDirectoryIdentity(identity) {
  try {
    const [resolved, stats] = await Promise.all([
      realpath(identity.path),
      lstat(identity.path),
    ]);
    if (
      resolved !== identity.path
      || stats.isSymbolicLink()
      || !stats.isDirectory()
      || stats.dev !== identity.dev
      || stats.ino !== identity.ino
    ) {
      throw new Error('changed');
    }
  } catch {
    throw new Error('pack-verify: output directory identity changed');
  }
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function pinOutputDirectory(identity, randomUUIDImpl = randomUUID) {
  const token = randomUUIDImpl();
  if (typeof token !== 'string' || !/^[A-Za-z0-9-]+$/u.test(token)) {
    throw new Error('pack-verify: could not reserve a pinned output directory');
  }
  const pinnedPath = path.join(
    path.dirname(identity.finalPath),
    `.${path.basename(identity.finalPath)}.hanamaru-${token}`,
  );
  if (await pathExists(pinnedPath)) {
    throw new Error('pack-verify: could not reserve a pinned output directory');
  }
  await assertOutputDirectoryIdentity(identity);
  try {
    await rename(identity.finalPath, pinnedPath);
  } catch {
    throw new Error('pack-verify: output directory identity changed');
  }
  const pinnedIdentity = Object.freeze({
    dev: identity.dev,
    finalPath: identity.finalPath,
    ino: identity.ino,
    path: pinnedPath,
  });
  return pinnedIdentity;
}

async function restoreOutputDirectory(identity) {
  try {
    await assertOutputDirectoryIdentity(identity);
    if (await pathExists(identity.finalPath)) {
      throw new Error('original path is occupied');
    }
    await rename(identity.path, identity.finalPath);
    await assertOutputDirectoryIdentity({
      ...identity,
      path: identity.finalPath,
    });
  } catch (cause) {
    throw new Error(
      `pack-verify: output directory could not be restored safely; `
      + `verified artifacts may remain at ${identity.path}`,
      { cause },
    );
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (
      relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}

function parseOctal(buffer) {
  const value = buffer.toString('ascii').replaceAll('\0', '').trim();
  if (value === '') return 0;
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error('pack-verify: tarball has an invalid header');
  }
  return Number.parseInt(value, 8);
}

function tarHeaderFormat(header) {
  const checksum = parseOctal(header.subarray(148, 156));
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(0x20, 148, 156);
  const actual = checksumHeader.reduce((sum, byte) => sum + byte, 0);
  if (checksum !== actual) {
    throw new Error('pack-verify: tarball header checksum mismatch');
  }
  const magic = header.subarray(257, 263).toString('latin1');
  const version = header.subarray(263, 265).toString('latin1');
  if (magic === 'ustar\0' && version === '00') return 'ustar';
  if (magic === 'ustar ' && version === ' \0') return 'gnu';
  throw new Error('pack-verify: tarball has an unsupported header format');
}

function assertSafeTarPath(value, label, options = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`pack-verify: tarball ${label} is unsafe`);
  }
  if (value.includes('\\')) {
    throw new Error(`pack-verify: tarball ${label} is unsafe`);
  }
  const candidate = options.directory && value.endsWith('/')
    ? value.slice(0, -1)
    : value;
  if (
    candidate.length === 0
    || candidate.startsWith('/')
    || /^[A-Za-z]:\//u.test(candidate)
    || candidate.split('/').some((segment) => (
      segment === '' || segment === '.' || segment === '..'
    ))
  ) {
    throw new Error(`pack-verify: tarball ${label} is unsafe`);
  }
  return value;
}

function tarText(buffer, label) {
  const nul = buffer.indexOf(0);
  if (nul === -1) return buffer.toString('utf8');
  if (buffer.subarray(nul + 1).some((byte) => byte !== 0)) {
    throw new Error(`pack-verify: tarball ${label} is unsafe`);
  }
  return buffer.subarray(0, nul).toString('utf8');
}

function parsePaxMetadata(contents) {
  let offset = 0;
  const result = {};
  while (offset < contents.length) {
    const space = contents.indexOf(0x20, offset);
    if (space === -1) {
      throw new Error('pack-verify: tarball has invalid extended metadata');
    }
    const lengthToken = contents.subarray(offset, space).toString('ascii');
    if (!/^[1-9]\d*$/u.test(lengthToken)) {
      throw new Error('pack-verify: tarball has invalid extended metadata');
    }
    const length = Number(lengthToken);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > contents.length) {
      throw new Error('pack-verify: tarball has invalid extended metadata');
    }
    if (contents[offset + length - 1] !== 0x0a) {
      throw new Error('pack-verify: tarball has invalid extended metadata');
    }
    const record = contents.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) {
      throw new Error('pack-verify: tarball has invalid extended metadata');
    }
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === 'path') result.path = assertSafeTarPath(value, 'entry path');
    if (key === 'linkpath') result.linkpath = assertSafeTarPath(value, 'link target');
    offset += length;
  }
  return result;
}

export function inspectTarball(buffer) {
  let archive;
  try {
    archive = gunzipSync(buffer);
  } catch {
    throw new Error('pack-verify: tarball is not valid gzip');
  }
  const files = [];
  let offset = 0;
  let pendingPath;
  let pendingLink;
  let terminated = false;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > archive.length) {
        throw new Error('pack-verify: tarball is truncated');
      }
      if (archive.subarray(offset, offset + 1024).some((byte) => byte !== 0)) {
        throw new Error('pack-verify: tarball has trailing data');
      }
      if (archive.subarray(offset + 1024).some((byte) => byte !== 0)) {
        throw new Error('pack-verify: tarball has trailing data');
      }
      terminated = true;
      break;
    }
    const format = tarHeaderFormat(header);
    const rawName = tarText(header.subarray(0, 100), 'entry path');
    const prefix = format === 'ustar'
      ? tarText(header.subarray(345, 500), 'entry path')
      : '';
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const size = parseOctal(header.subarray(124, 136));
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) {
      throw new Error('pack-verify: tarball is truncated');
    }
    const type = String.fromCharCode(header[156] || 0);
    const contents = archive.subarray(dataStart, dataEnd);
    if (type === 'x') {
      const metadata = parsePaxMetadata(contents);
      pendingPath = metadata.path ?? pendingPath;
      pendingLink = metadata.linkpath ?? pendingLink;
    } else if (type === 'g') {
      throw new Error('pack-verify: tarball contains unsupported entry type g');
    } else if (type === 'L') {
      pendingPath = assertSafeTarPath(tarText(contents, 'entry path'), 'entry path');
    } else if (type === 'K') {
      pendingLink = assertSafeTarPath(tarText(contents, 'link target'), 'link target');
    } else if (type === '\0' || type === '0') {
      files.push(assertSafeTarPath(pendingPath ?? name, 'entry path'));
      pendingPath = undefined;
      pendingLink = undefined;
    } else if (type === '5') {
      assertSafeTarPath(pendingPath ?? name, 'entry path', { directory: true });
      pendingPath = undefined;
      pendingLink = undefined;
    } else if (type === '1' || type === '2') {
      assertSafeTarPath(pendingPath ?? name, 'entry path');
      assertSafeTarPath(
        pendingLink ?? tarText(header.subarray(157, 257), 'link target'),
        'link target',
      );
      throw new Error(`pack-verify: tarball contains unsupported entry type ${type}`);
    } else {
      throw new Error(`pack-verify: tarball contains unsupported entry type ${type}`);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!terminated) throw new Error('pack-verify: tarball is truncated');
  return sortedUniqueFiles(files);
}

function parsePackResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('pack-verify: npm pack returned invalid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error('pack-verify: npm pack must return exactly one result');
  }
  return parsed[0];
}

async function readManifest(root) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  } catch {
    throw new Error('pack-verify: cannot read package.json');
  }
  if (manifest.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`pack-verify: package name must be ${EXPECTED_PACKAGE_NAME}`);
  }
  if (!isValidSemver(manifest.version)) {
    throw new Error('pack-verify: package version is not valid SemVer 2.0.0');
  }
  return manifest;
}

function cleanFilename(name, version) {
  return `${name.replace(/^@/u, '').replaceAll('/', '-')}-${version}.tgz`;
}

function safeArtifactPath(directory, filename) {
  if (
    typeof filename !== 'string'
    || filename.length === 0
    || filename.includes('\0')
    || filename.includes('/')
    || filename.includes('\\')
    || path.basename(filename) !== filename
  ) {
    throw new Error('pack-verify: npm pack returned an unsafe tarball filename');
  }
  const candidate = path.resolve(directory, filename);
  if (path.dirname(candidate) !== directory) {
    throw new Error('pack-verify: npm pack returned an unsafe tarball filename');
  }
  return candidate;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function combineFailures(primary, cleanup) {
  return new AggregateError(
    [primary, cleanup],
    `${errorMessage(primary)}; ${errorMessage(cleanup)}`,
  );
}

function fileIdentity(stats) {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
  });
}

async function readRegularFileBound(candidate, label, options = {}) {
  const openImpl = options.openImpl ?? open;
  let before;
  try {
    before = await lstat(candidate);
  } catch {
    throw new Error(`pack-verify: ${label} identity changed`);
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`pack-verify: ${label} identity changed`);
  }

  let handle;
  try {
    handle = await openImpl(
      candidate,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new Error(`pack-verify: ${label} identity changed`);
  }

  let hasPrimary = false;
  let primary;
  let result;
  try {
    const opened = await handle.stat();
    const expected = options.expectedIdentity;
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || (
        expected
        && (opened.dev !== expected.dev || opened.ino !== expected.ino)
      )
    ) {
      throw new Error(`pack-verify: ${label} identity changed`);
    }
    await options.afterOpen?.();
    const bytes = await handle.readFile();
    await options.afterRead?.();
    const after = await lstat(candidate);
    if (
      !after.isFile()
      || after.isSymbolicLink()
      || after.dev !== opened.dev
      || after.ino !== opened.ino
    ) {
      throw new Error(`pack-verify: ${label} identity changed`);
    }
    result = {
      bytes,
      identity: fileIdentity(opened),
    };
  } catch (error) {
    hasPrimary = true;
    primary = error;
  }

  let hasCleanup = false;
  let cleanup;
  try {
    await handle.close();
  } catch (error) {
    hasCleanup = true;
    cleanup = error;
  }
  if (hasPrimary && hasCleanup) throw combineFailures(primary, cleanup);
  if (hasPrimary) throw primary;
  if (hasCleanup) throw cleanup;
  return result;
}

async function verifyBoundOutputFiles(directory, binding, options = {}) {
  let entries;
  try {
    entries = (await readdir(directory)).sort();
  } catch {
    throw new Error('pack-verify: output directory entries changed');
  }
  const expectedEntries = [binding.filename, 'sha512.txt'].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
    throw new Error('pack-verify: output directory entries changed');
  }
  const artifact = await readRegularFileBound(
    path.join(directory, binding.filename),
    'artifact',
    {
      expectedIdentity: binding.artifactIdentity,
      openImpl: options.openImpl,
    },
  );
  const artifactHash = createHash('sha512').update(artifact.bytes).digest('hex');
  if (artifactHash !== binding.digestHex) {
    throw new Error('pack-verify: artifact content changed');
  }
  const digest = await readRegularFileBound(
    path.join(directory, 'sha512.txt'),
    'digest',
    {
      expectedIdentity: binding.digestIdentity,
      openImpl: options.openImpl,
    },
  );
  if (digest.bytes.toString('utf8') !== binding.digestText) {
    throw new Error('pack-verify: digest content changed');
  }
}

function assertNoProductionFields(manifest) {
  for (const field of FORBIDDEN_PRODUCTION_FIELDS) {
    if (Object.hasOwn(manifest, field)) {
      throw new Error(
        `pack-verify: installed package declares forbidden production field ${field}`,
      );
    }
  }
}

function assertProductionTree(dependencyTree, expectedIdentity) {
  const dependencies = dependencyTree?.dependencies;
  const rootNames = dependencies && typeof dependencies === 'object'
    ? Object.keys(dependencies)
    : [];
  const hanamaru = dependencies?.[EXPECTED_PACKAGE_NAME];
  const childNames = hanamaru?.dependencies
    && typeof hanamaru.dependencies === 'object'
    ? Object.keys(hanamaru.dependencies)
    : [];
  if (
    rootNames.length !== 1
    || rootNames[0] !== EXPECTED_PACKAGE_NAME
    || !hanamaru
    || childNames.length !== 0
  ) {
    throw new Error(
      'pack-verify: production dependency tree must contain only '
      + `dependency-free ${EXPECTED_PACKAGE_NAME}`,
    );
  }
  if (hanamaru.version !== expectedIdentity.version) {
    throw new Error('pack-verify: production dependency tree does not match source identity');
  }
}

export async function verifyInstalledPackage(artifact, installRoot, options = {}) {
  const execFileImpl = options.execFileImpl ?? execFile;
  const runtimePath = options.execPath ?? process.execPath;
  const invocationOptions = [options.npmCliPath, runtimePath];
  const expectedIdentity = options.expectedIdentity;
  if (
    expectedIdentity?.name !== EXPECTED_PACKAGE_NAME
    || !isValidSemver(expectedIdentity?.version)
  ) {
    throw new Error('pack-verify: expected source package identity is invalid');
  }
  await writeFile(path.join(installRoot, 'package.json'), JSON.stringify({
    name: 'hanamaru-pack-verification',
    private: true,
    type: 'module',
  }));
  try {
    await execute(
      npmInvocation([
        'install',
        '--save-prod',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        artifact,
      ], ...invocationOptions),
      installRoot,
      execFileImpl,
    );
    await execute(
      npmInvocation([
        'install',
        '--save-dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        'react@19.2.8',
        'vue@3.5.40',
        'svelte@5.56.7',
      ], ...invocationOptions),
      installRoot,
      execFileImpl,
    );
  } catch {
    throw new Error('pack-verify: clean-room install failed');
  }

  let installedPackageManifest;
  try {
    installedPackageManifest = JSON.parse(await readFile(
      path.join(
        installRoot,
        'node_modules',
        'hanamaru-annotations',
        'package.json',
      ),
      'utf8',
    ));
  } catch {
    throw new Error('pack-verify: installed package manifest could not be read');
  }
  if (
    installedPackageManifest.name !== expectedIdentity.name
    || installedPackageManifest.version !== expectedIdentity.version
  ) {
    throw new Error('pack-verify: installed package identity does not match source');
  }
  assertNoProductionFields(installedPackageManifest);

  const verificationScript = `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { fileURLToPath } from 'node:url';
    const entries = ${JSON.stringify(PACKAGE_ENTRY_EXPORTS)};
    for (const [specifier, expected] of Object.entries(entries)) {
      const module = await import(specifier);
      assert.deepEqual(Object.keys(module).sort(), [...expected].sort(), specifier);
    }
    for (const specifier of ${JSON.stringify(CSS_EXPORTS)}) {
      const resolved = import.meta.resolve(specifier);
      assert.ok((await readFile(fileURLToPath(resolved))).byteLength > 0, specifier);
    }
    const packagePath = fileURLToPath(import.meta.resolve('hanamaru-annotations/package.json'));
    const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
    assert.equal(manifest.name, ${JSON.stringify(expectedIdentity.name)});
    assert.equal(manifest.version, ${JSON.stringify(expectedIdentity.version)});
    for (const field of ${JSON.stringify(FORBIDDEN_PRODUCTION_FIELDS)}) {
      assert.equal(Object.hasOwn(manifest, field), false, field);
    }
  `;
  const verificationPath = path.join(installRoot, 'verify-imports.mjs');
  await writeFile(verificationPath, verificationScript);
  try {
    await execute(
      { file: runtimePath, args: [verificationPath] },
      installRoot,
      execFileImpl,
    );
  } catch {
    throw new Error('pack-verify: clean-room package imports failed');
  }

  let dependencyTree;
  try {
    const stdout = await execute(
      npmInvocation(['ls', '--omit=dev', '--json'], ...invocationOptions),
      installRoot,
      execFileImpl,
    );
    dependencyTree = JSON.parse(stdout);
  } catch {
    throw new Error('pack-verify: production dependency check failed');
  }
  assertProductionTree(dependencyTree, expectedIdentity);
  const installedManifest = JSON.parse(
    await readFile(path.join(installRoot, 'package.json'), 'utf8'),
  );
  if (
    Object.keys(installedManifest.dependencies ?? {}).length !== 1
    || !Object.hasOwn(installedManifest.dependencies ?? {}, EXPECTED_PACKAGE_NAME)
  ) {
    throw new Error(
      `pack-verify: clean-room manifest must depend only on ${EXPECTED_PACKAGE_NAME}`,
    );
  }
  return {
    entries: Object.keys(PACKAGE_ENTRY_EXPORTS).length,
    css: CSS_EXPORTS.length,
    productionDependencies: 0,
  };
}

export async function verifyPack(root, outputDirectory, options = {}) {
  const projectRoot = await canonicalDirectory(root, 'project');
  const initialOutputIdentity = await captureOutputDirectory(outputDirectory);
  const assertOutputIdentityImpl = options.assertOutputIdentityImpl
    ?? assertOutputDirectoryIdentity;
  if (isInside(projectRoot, initialOutputIdentity.path)) {
    throw new Error('pack-verify: output directory must be outside the project root');
  }
  await assertOutputDirectoryIdentity(initialOutputIdentity);
  if ((await readdir(initialOutputIdentity.path)).length > 0) {
    throw new Error('pack-verify: output directory must be empty');
  }
  await assertOutputDirectoryIdentity(initialOutputIdentity);

  const manifest = await readManifest(projectRoot);
  const sourceIdentity = Object.freeze({
    name: manifest.name,
    version: manifest.version,
  });
  const expectedFilename = cleanFilename(manifest.name, manifest.version);
  safeArtifactPath(initialOutputIdentity.finalPath, expectedFilename);
  const built = await (options.checkBuiltExportsImpl ?? checkBuiltExports)(projectRoot);
  const npmCliPath = await (options.resolveNpmCliImpl ?? resolveNpmCli)({
    env: options.env,
    execPath: options.execPath ?? process.execPath,
    npmCliPath: options.npmCliPath,
  });
  let outputIdentity;
  let digestHandle;
  let hasOperationError = false;
  let operationError;
  let hasRestorationError = false;
  let restorationError;
  let completed;
  let binding;
  const openImpl = options.openImpl ?? open;
  try {
    outputIdentity = await pinOutputDirectory(
      initialOutputIdentity,
      options.randomUUIDImpl ?? randomUUID,
    );
    await assertOutputIdentityImpl(outputIdentity, 'after-pin');
    const artifactDirectory = outputIdentity.path;
    const pinnedDigestPath = path.join(artifactDirectory, 'sha512.txt');
    digestHandle = await openImpl(
      pinnedDigestPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const digestStats = await digestHandle.stat();
    if (!digestStats.isFile()) {
      throw new Error('pack-verify: SHA-512 digest target is not a regular file');
    }
    await assertOutputIdentityImpl(outputIdentity, 'after-digest-open');

    const invocation = npmInvocation(
      ['pack', '--ignore-scripts', '--json', '--pack-destination', artifactDirectory],
      npmCliPath,
      options.execPath ?? process.execPath,
    );
    await assertOutputIdentityImpl(outputIdentity, 'before-pack');
    let stdout;
    try {
      stdout = await execute(
        invocation,
        projectRoot,
        options.execFileImpl ?? execFile,
      );
    } catch {
      throw new Error('pack-verify: npm pack failed');
    }
    await assertOutputIdentityImpl(outputIdentity, 'after-pack');

    const result = parsePackResult(stdout);
    safeArtifactPath(artifactDirectory, result.filename);
    if (
      result.name !== sourceIdentity.name
      || result.version !== sourceIdentity.version
    ) {
      throw new Error('pack-verify: npm pack package identity mismatch');
    }
    if (result.filename !== expectedFilename) {
      throw new Error(`pack-verify: unexpected tarball filename ${String(result.filename)}`);
    }
    const metadataFiles = validatePackFileList(
      result.files?.map(({ path: file }) => file),
      built.distFiles,
    );
    const artifact = safeArtifactPath(artifactDirectory, expectedFilename);
    await assertOutputIdentityImpl(outputIdentity, 'before-artifact-read');
    const artifactRead = await readRegularFileBound(artifact, 'artifact', {
      afterOpen: () => assertOutputIdentityImpl(outputIdentity, 'after-artifact-open'),
      afterRead: () => assertOutputIdentityImpl(outputIdentity, 'after-artifact-read'),
      openImpl,
    });
    const artifactBytes = artifactRead.bytes;

    const digestBuffer = createHash('sha512').update(artifactBytes).digest();
    const integrity = `sha512-${digestBuffer.toString('base64')}`;
    if (result.integrity !== integrity) {
      throw new Error('pack-verify: tarball integrity mismatch');
    }

    const inspectTarballImpl = options.inspectTarballImpl ?? inspectTarball;
    const actualFiles = sortedUniqueFiles(await inspectTarballImpl(artifactBytes));
    if (JSON.stringify(actualFiles) !== JSON.stringify(metadataFiles)) {
      throw new Error('pack-verify: tarball contents differ from npm pack metadata');
    }
    validatePackFileList(actualFiles, built.distFiles);

    const digestText = `${digestBuffer.toString('hex')}  ${expectedFilename}\n`;
    await assertOutputIdentityImpl(outputIdentity, 'before-digest-write');
    await digestHandle.writeFile(digestText, 'utf8');
    await digestHandle.sync();
    const verifiedDigest = Buffer.alloc(Buffer.byteLength(digestText));
    const { bytesRead } = await digestHandle.read(
      verifiedDigest,
      0,
      verifiedDigest.length,
      0,
    );
    if (
      bytesRead !== verifiedDigest.length
      || (await digestHandle.stat()).size !== verifiedDigest.length
      || verifiedDigest.toString('utf8') !== digestText
    ) {
      throw new Error('pack-verify: generated SHA-512 digest could not be verified');
    }
    await assertOutputIdentityImpl(outputIdentity, 'after-digest-write');
    const digestIdentity = fileIdentity(await digestHandle.stat());
    binding = Object.freeze({
      artifactIdentity: artifactRead.identity,
      digestHex: digestBuffer.toString('hex'),
      digestIdentity,
      digestText,
      filename: expectedFilename,
    });

    const mkdtempImpl = options.mkdtempImpl ?? mkdtemp;
    const rmImpl = options.rmImpl ?? rm;
    const installRoot = await mkdtempImpl(path.join(os.tmpdir(), 'hanamaru-pack-install-'));
    let verification;
    let hasVerificationError = false;
    let verificationError;
    try {
      await assertOutputIdentityImpl(outputIdentity, 'before-install');
      await verifyBoundOutputFiles(artifactDirectory, binding, { openImpl });
      const privateArtifact = path.join(installRoot, expectedFilename);
      await writeFile(privateArtifact, artifactBytes, {
        flag: 'wx',
        mode: 0o600,
      });
      verification = await (options.verifyInstallImpl ?? verifyInstalledPackage)(
        privateArtifact,
        installRoot,
        {
          env: options.env,
          execFileImpl: options.execFileImpl ?? execFile,
          execPath: options.execPath ?? process.execPath,
          expectedIdentity: sourceIdentity,
          npmCliPath,
        },
      );
      if (
        !verification
        || typeof verification !== 'object'
        || verification.entries !== Object.keys(PACKAGE_ENTRY_EXPORTS).length
        || verification.css !== CSS_EXPORTS.length
        || verification.productionDependencies !== 0
      ) {
        throw new Error('pack-verify: install verification returned an invalid result');
      }
      await assertOutputIdentityImpl(outputIdentity, 'after-install');
    } catch (error) {
      hasVerificationError = true;
      verificationError = error;
    } finally {
      let hasCleanupError = false;
      let cleanupError;
      try {
        await rmImpl(installRoot, { recursive: true, force: true });
      } catch (error) {
        hasCleanupError = true;
        cleanupError = error;
      }
      if (hasVerificationError && hasCleanupError) {
        throw combineFailures(verificationError, cleanupError);
      }
      if (hasVerificationError) throw verificationError;
      if (hasCleanupError) throw cleanupError;
    }
    await assertOutputIdentityImpl(outputIdentity, 'before-return');
    await verifyBoundOutputFiles(artifactDirectory, binding, { openImpl });

    completed = {
      artifact: path.join(initialOutputIdentity.finalPath, expectedFilename),
      digest: digestBuffer.toString('hex'),
      digestPath: path.join(initialOutputIdentity.finalPath, 'sha512.txt'),
      fileCount: metadataFiles.length,
      integrity,
      verification,
    };
  } catch (error) {
    hasOperationError = true;
    operationError = error;
  } finally {
    try {
      await digestHandle?.close();
    } catch (error) {
      operationError = hasOperationError
        ? combineFailures(operationError, error)
        : error;
      hasOperationError = true;
    }
    if (outputIdentity) {
      if (!hasOperationError && binding) {
        try {
          await assertOutputIdentityImpl(outputIdentity, 'before-restore');
          await verifyBoundOutputFiles(outputIdentity.path, binding, { openImpl });
        } catch (error) {
          hasOperationError = true;
          operationError = error;
        }
      }
      try {
        await (options.restoreOutputImpl ?? restoreOutputDirectory)(outputIdentity);
      } catch (error) {
        hasRestorationError = true;
        restorationError = error;
      }
      if (!hasOperationError && !hasRestorationError && binding) {
        const restoredIdentity = Object.freeze({
          ...outputIdentity,
          path: outputIdentity.finalPath,
        });
        try {
          await assertOutputIdentityImpl(restoredIdentity, 'after-restore');
          await verifyBoundOutputFiles(restoredIdentity.path, binding, { openImpl });
        } catch (error) {
          hasOperationError = true;
          operationError = error;
        }
      }
    }
  }

  if (hasOperationError && hasRestorationError) {
    throw combineFailures(operationError, restorationError);
  }
  if (hasOperationError) throw operationError;
  if (hasRestorationError) throw restorationError;
  return completed;
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    const projectRoot = path.resolve(path.dirname(modulePath), '..');
    const result = await verifyPack(projectRoot, process.argv[2]);
    console.log(
      `pack-verify: pass ${path.basename(result.artifact)} `
      + `(${result.fileCount} files, ${result.integrity})`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'pack-verify: verification failed');
    process.exitCode = 1;
  }
}
