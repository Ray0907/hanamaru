import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { measureDistribution, writeSizeReport } from './check-size.mjs';

export async function buildDistribution(root = process.cwd()) {
  const projectRoot = path.resolve(root);
  const sourceDirectory = path.join(projectRoot, 'src');
  const distributionDirectory = path.join(projectRoot, 'dist');
  const entryPoint = path.join(sourceDirectory, 'index.js');
  const esmEntryPoints = {
    'hanamaru.esm': entryPoint,
    'hanamaru.plugins.esm': path.join(sourceDirectory, 'plugins.js'),
    'hanamaru.selection.esm': path.join(sourceDirectory, 'selection.js'),
    'hanamaru.serialize.esm': path.join(sourceDirectory, 'serialize.js'),
  };

  await rm(distributionDirectory, { recursive: true, force: true });
  await mkdir(distributionDirectory, { recursive: true });

  await Promise.all([
    build({
      entryPoints: esmEntryPoints,
      outdir: distributionDirectory,
      bundle: true,
      chunkNames: 'chunks/[name]-[hash]',
      entryNames: '[name]',
      format: 'esm',
      minify: true,
      splitting: true,
      target: 'es2020',
    }),
    build({
      entryPoints: [entryPoint],
      outfile: path.join(distributionDirectory, 'hanamaru.iife.js'),
      bundle: true,
      format: 'iife',
      globalName: 'Hanamaru',
      minify: true,
      target: 'es2020',
    }),
    build({
      entryPoints: [path.join(sourceDirectory, 'hanamaru.css')],
      outfile: path.join(distributionDirectory, 'hanamaru.css'),
      bundle: true,
      minify: true,
    }),
  ]);

  const metrics = await measureDistribution(projectRoot);
  await writeSizeReport(projectRoot, metrics);
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedPath === import.meta.url) {
  await buildDistribution(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  console.log('build: wrote ESM entry points, shared chunks, IIFE, CSS, and size report');
}
