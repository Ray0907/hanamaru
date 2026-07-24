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
  platform = process.platform,
  environment = process.env,
) {
  if (platform === 'win32') {
    return {
      file: environment.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd', ...args],
    };
  }
  return { file: 'npm', args: [...args] };
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

function parsePaxPath(contents) {
  let offset = 0;
  let result;
  while (offset < contents.length) {
    const space = contents.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(contents.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > contents.length) {
      throw new Error('pack-verify: tarball has invalid extended metadata');
    }
    const record = contents.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0 && record.slice(0, equals) === 'path') result = record.slice(equals + 1);
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
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '');
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
      pendingPath = parsePaxPath(contents) ?? pendingPath;
    } else if (type === 'L') {
      pendingPath = contents.toString('utf8').replace(/\0.*$/u, '');
    } else if (type === '\0' || type === '0') {
      files.push(pendingPath ?? name);
      pendingPath = undefined;
    } else if (type !== 'g') {
      pendingPath = undefined;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
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

async function runInstalledVerification(artifact, installRoot, options = {}) {
  const execFileImpl = options.execFileImpl ?? execFile;
  const invocationOptions = [options.platform, options.env];
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
  const artifactDirectory = await canonicalDirectory(outputDirectory, 'output');
  if (isInside(projectRoot, artifactDirectory)) {
    throw new Error('pack-verify: output directory must be outside the project root');
  }
  if ((await readdir(artifactDirectory)).length > 0) {
    throw new Error('pack-verify: output directory must be empty');
  }

  const manifest = await readManifest(projectRoot);
  const expectedFilename = cleanFilename(manifest.name, manifest.version);
  const built = await (options.checkBuiltExportsImpl ?? checkBuiltExports)(projectRoot);
  const invocation = npmInvocation(
    ['pack', '--json', '--pack-destination', artifactDirectory],
    options.platform,
    options.env,
  );
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

  const result = parsePackResult(stdout);
  if (result.filename !== expectedFilename) {
    throw new Error(`pack-verify: unexpected tarball filename ${String(result.filename)}`);
  }
  const metadataFiles = validatePackFileList(
    result.files?.map(({ path: file }) => file),
    built.distFiles,
  );
  const artifact = path.join(artifactDirectory, expectedFilename);
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
  await writeFile(digestPath, digestText, { flag: 'wx' });
  if (await readFile(digestPath, 'utf8') !== digestText) {
    throw new Error('pack-verify: generated SHA-512 digest could not be verified');
  }

  const mkdtempImpl = options.mkdtempImpl ?? mkdtemp;
  const rmImpl = options.rmImpl ?? rm;
  const installRoot = await mkdtempImpl(path.join(os.tmpdir(), 'hanamaru-pack-install-'));
  let verification;
  try {
    verification = await (options.verifyInstallImpl ?? runInstalledVerification)(
      artifact,
      installRoot,
      {
        env: options.env,
        execFileImpl: options.execFileImpl ?? execFile,
        platform: options.platform,
      },
    );
  } finally {
    await rmImpl(installRoot, { recursive: true, force: true });
  }

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
