import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { checkBuiltExports } from './check-exports.mjs';

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
    const length = Number.parseInt(contents.subarray(offset, space).toString('ascii'), 10);
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
      if (archive.subarray(offset).some((byte) => byte !== 0)) {
        throw new Error('pack-verify: tarball has trailing data');
      }
      terminated = true;
      break;
    }
    const rawName = tarText(header.subarray(0, 100), 'entry path');
    const prefix = tarText(header.subarray(345, 500), 'entry path');
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const size = parseOctal(header.subarray(124, 136));
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) {
      throw new Error('pack-verify: tarball is truncated');
    }
    const type = String.fromCharCode(header[156] || 0);
    const contents = archive.subarray(dataStart, dataEnd);
    if (type === 'x' || type === 'g') {
      const metadata = parsePaxMetadata(contents);
      pendingPath = metadata.path ?? pendingPath;
      pendingLink = metadata.linkpath ?? pendingLink;
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
  if (
    typeof manifest.name !== 'string'
    || manifest.name.length === 0
    || typeof manifest.version !== 'string'
    || manifest.version.length === 0
  ) {
    throw new Error('pack-verify: package identity is incomplete');
  }
  return manifest;
}

function cleanFilename(name, version) {
  return `${name.replace(/^@/u, '').replaceAll('/', '-')}-${version}.tgz`;
}

export async function verifyInstalledPackage(artifact, installRoot, options = {}) {
  const execFileImpl = options.execFileImpl ?? execFile;
  const invocationOptions = [options.npmCliPath, options.execPath ?? process.execPath];
  await writeFile(path.join(installRoot, 'package.json'), JSON.stringify({
    name: 'hanamaru-pack-verification',
    private: true,
    type: 'module',
  }));
  try {
    await execute(
      npmInvocation([
        'install',
        '--save-dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        artifact,
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
    Object.hasOwn(installedPackageManifest, 'dependencies')
    || Object.keys(installedPackageManifest.dependencies ?? {}).length > 0
  ) {
    throw new Error('pack-verify: installed package declares production dependencies');
  }

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
    assert.equal(manifest.name, 'hanamaru-annotations');
    assert.equal(typeof manifest.version, 'string');
    assert.equal(Object.hasOwn(manifest, 'dependencies'), false);
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  `;
  const verificationPath = path.join(installRoot, 'verify-imports.mjs');
  await writeFile(verificationPath, verificationScript);
  try {
    await execute(
      { file: process.execPath, args: [verificationPath] },
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
  const productionDependencies = Object.keys(dependencyTree.dependencies ?? {});
  if (productionDependencies.length > 0) {
    throw new Error(
      `pack-verify: production dependency tree is not empty (${productionDependencies.join(', ')})`,
    );
  }
  const installedManifest = JSON.parse(
    await readFile(path.join(installRoot, 'package.json'), 'utf8'),
  );
  if (Object.keys(installedManifest.dependencies ?? {}).length > 0) {
    throw new Error('pack-verify: clean-room manifest has production dependencies');
  }
  return {
    entries: Object.keys(PACKAGE_ENTRY_EXPORTS).length,
    css: CSS_EXPORTS.length,
    productionDependencies: 0,
  };
}

export async function verifyPack(root, outputDirectory, options = {}) {
  const projectRoot = await canonicalDirectory(root, 'project');
  const outputIdentity = await captureOutputDirectory(outputDirectory);
  const artifactDirectory = outputIdentity.path;
  const assertOutputIdentityImpl = options.assertOutputIdentityImpl
    ?? assertOutputDirectoryIdentity;
  if (isInside(projectRoot, artifactDirectory)) {
    throw new Error('pack-verify: output directory must be outside the project root');
  }
  if ((await readdir(artifactDirectory)).length > 0) {
    throw new Error('pack-verify: output directory must be empty');
  }

  const manifest = await readManifest(projectRoot);
  const expectedFilename = cleanFilename(manifest.name, manifest.version);
  const built = await (options.checkBuiltExportsImpl ?? checkBuiltExports)(projectRoot);
  const npmCliPath = await (options.resolveNpmCliImpl ?? resolveNpmCli)({
    env: options.env,
    execPath: options.execPath ?? process.execPath,
    npmCliPath: options.npmCliPath,
  });
  const invocation = npmInvocation(
    ['pack', '--json', '--pack-destination', artifactDirectory],
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
  if (result.filename !== expectedFilename) {
    throw new Error(`pack-verify: unexpected tarball filename ${String(result.filename)}`);
  }
  const metadataFiles = validatePackFileList(
    result.files?.map(({ path: file }) => file),
    built.distFiles,
  );
  const artifact = path.join(artifactDirectory, expectedFilename);
  await assertOutputIdentityImpl(outputIdentity, 'before-artifact-read');
  let artifactStats;
  try {
    artifactStats = await lstat(artifact);
  } catch {
    throw new Error('pack-verify: npm pack did not create the reported tarball');
  }
  if (!artifactStats.isFile() || artifactStats.isSymbolicLink()) {
    throw new Error('pack-verify: reported tarball is not a regular file');
  }
  const artifactBytes = await readFile(artifact);
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
  const digestPath = path.join(artifactDirectory, 'sha512.txt');
  await assertOutputIdentityImpl(outputIdentity, 'before-digest-write');
  await writeFile(digestPath, digestText, { flag: 'wx' });
  if (await readFile(digestPath, 'utf8') !== digestText) {
    throw new Error('pack-verify: generated SHA-512 digest could not be verified');
  }

  const mkdtempImpl = options.mkdtempImpl ?? mkdtemp;
  const rmImpl = options.rmImpl ?? rm;
  const installRoot = await mkdtempImpl(path.join(os.tmpdir(), 'hanamaru-pack-install-'));
  let verification;
  try {
    verification = await (options.verifyInstallImpl ?? verifyInstalledPackage)(
      artifact,
      installRoot,
      {
        env: options.env,
        execFileImpl: options.execFileImpl ?? execFile,
        execPath: options.execPath ?? process.execPath,
        npmCliPath,
      },
    );
  } finally {
    await rmImpl(installRoot, { recursive: true, force: true });
  }
  await assertOutputIdentityImpl(outputIdentity, 'before-return');

  return {
    artifact,
    digest: digestBuffer.toString('hex'),
    digestPath,
    fileCount: metadataFiles.length,
    integrity,
    verification,
  };
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
