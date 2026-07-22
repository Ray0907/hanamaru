import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function buildDistribution(root = process.cwd()) {
  const projectRoot = path.resolve(root);
  const sourceDirectory = path.join(projectRoot, 'src');
  const distributionDirectory = path.join(projectRoot, 'dist');
  const entryPoint = path.join(sourceDirectory, 'index.js');

  await rm(distributionDirectory, { recursive: true, force: true });
  await mkdir(distributionDirectory, { recursive: true });

  await Promise.all([
    build({
      entryPoints: [entryPoint],
      outfile: path.join(distributionDirectory, 'hanamaru.esm.js'),
      bundle: true,
      format: 'esm',
      minify: true,
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
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedPath === import.meta.url) {
  await buildDistribution(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  console.log('build: wrote ESM, IIFE, and CSS');
}
