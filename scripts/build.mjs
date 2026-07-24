import { build } from 'esbuild';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { minify } from 'terser';
import { measureDistribution, writeSizeReport } from './check-size.mjs';

async function javascriptFiles(directory) {
  const output = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name.endsWith('.js')) output.push(target);
    }
  }
  await visit(directory);
  return output.sort();
}

async function settleStartedTasks(taskFactories) {
  let firstFailure;
  let failed = false;
  const tasks = taskFactories.map((start) => {
    let task;
    try {
      task = start();
    } catch (error) {
      task = Promise.reject(error);
    }
    return Promise.resolve(task).catch((error) => {
      if (!failed) {
        failed = true;
        firstFailure = error;
      }
      throw error;
    });
  });
  await Promise.allSettled(tasks);
  if (failed) throw firstFailure;
}

function removeDistribution(distributionDirectory) {
  return rm(distributionDirectory, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 25,
  });
}

export async function compressJavaScript(filePath, source) {
  const iife = path.basename(filePath) === 'hanamaru.iife.js';
  const result = await minify(source, {
    compress: {
      passes: 3,
      toplevel: !iife,
    },
    ecma: 2020,
    format: {
      comments: false,
      ecma: 2020,
    },
    mangle: iife ? true : { module: true },
    module: !iife,
  });
  if (typeof result.code !== 'string') {
    throw new Error(`build: Terser did not emit JavaScript for ${path.basename(filePath)}`);
  }
  return `${result.code}\n`;
}

export async function buildDistribution(root = process.cwd(), options = {}) {
  const projectRoot = path.resolve(root);
  const sourceDirectory = path.join(projectRoot, 'src');
  const typesDirectory = path.join(projectRoot, 'types');
  const distributionDirectory = path.join(projectRoot, 'dist');
  const buildImpl = options.buildImpl ?? build;
  const entryPoint = path.join(sourceDirectory, 'index.js');
  const esmEntryPoints = [
    { in: entryPoint, out: 'hanamaru.esm' },
    { in: path.join(sourceDirectory, 'entries', 'selection.js'), out: 'selection/index' },
    { in: path.join(sourceDirectory, 'entries', 'serialize.js'), out: 'serialize/index' },
    { in: path.join(sourceDirectory, 'entries', 'group.js'), out: 'group/index' },
    { in: path.join(sourceDirectory, 'entries', 'plugins.js'), out: 'plugins/index' },
    { in: path.join(sourceDirectory, 'entries', 'shadow.js'), out: 'shadow/index' },
    { in: path.join(sourceDirectory, 'entries', 'react.js'), out: 'react/index' },
    { in: path.join(sourceDirectory, 'entries', 'vue.js'), out: 'vue/index' },
    { in: path.join(sourceDirectory, 'entries', 'svelte.js'), out: 'svelte/index' },
  ];

  await removeDistribution(distributionDirectory);
  await mkdir(distributionDirectory, { recursive: true });

  try {
    await buildImpl({
      entryPoints: esmEntryPoints,
      outdir: distributionDirectory,
      bundle: true,
      chunkNames: '_chunks/[name]-[hash]',
      entryNames: '[dir]/[name]',
      external: ['react', 'svelte', 'vue'],
      format: 'esm',
      legalComments: 'none',
      minify: true,
      splitting: true,
      target: 'es2020',
    });

    await settleStartedTasks([
      () => buildImpl({
        entryPoints: [entryPoint],
        outfile: path.join(distributionDirectory, 'hanamaru.iife.js'),
        bundle: true,
        format: 'iife',
        globalName: 'Hanamaru',
        legalComments: 'none',
        minify: true,
        target: 'es2020',
      }),
      () => buildImpl({
        entryPoints: [path.join(sourceDirectory, 'hanamaru.css')],
        outfile: path.join(distributionDirectory, 'hanamaru.css'),
        bundle: true,
        legalComments: 'none',
        minify: true,
      }),
      () => buildImpl({
        entryPoints: [path.join(sourceDirectory, 'hanamaru-shadow.css')],
        outfile: path.join(distributionDirectory, 'shadow', 'hanamaru-shadow.css'),
        bundle: true,
        legalComments: 'none',
        minify: true,
      }),
      () => cp(typesDirectory, distributionDirectory, { recursive: true }),
    ]);

    const transformJavaScript = options.transformJavaScript ?? compressJavaScript;
    for (const filePath of await javascriptFiles(distributionDirectory)) {
      const source = await readFile(filePath, 'utf8');
      await writeFile(filePath, await transformJavaScript(filePath, source));
    }

    const metrics = await measureDistribution(projectRoot);
    await writeSizeReport(projectRoot, metrics);
  } catch (error) {
    try {
      await removeDistribution(distributionDirectory);
    } catch {
      // Preserve the causative build failure after every writer has settled.
    }
    throw error;
  }
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedPath === import.meta.url) {
  await buildDistribution(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  console.log('build: wrote modular ESM graph, core IIFE, CSS, declarations, and size report');
}
