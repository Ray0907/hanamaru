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

const PRIVATE_IDENTIFIER = /^#[A-Za-z_$][\w$]*/u;

export function transformSchedulerPrivateSyntax(source) {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      output += character;
      index += 1;
      let escaped = false;
      while (index < source.length) {
        const current = source[index];
        output += current;
        index += 1;
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === quote) break;
      }
      continue;
    }
    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      if (end === -1) return output + source.slice(index);
      output += source.slice(index, end);
      index = end;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) return output + source.slice(index);
      output += source.slice(index, end + 2);
      index = end + 2;
      continue;
    }
    if (character === '#') {
      const match = PRIVATE_IDENTIFIER.exec(source.slice(index));
      if (match !== null) {
        output += `$${match[0].slice(1)}`;
        index += match[0].length;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return output;
}

const schedulerPrivatePlugin = {
  name: 'hanamaru-internal-scheduler-properties',
  setup(buildApi) {
    buildApi.onLoad({ filter: /[/\\]scheduler\.js$/ }, async ({ path: filePath }) => ({
      contents: transformSchedulerPrivateSyntax(await readFile(filePath, 'utf8')),
      loader: 'js',
    }));
  },
};

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

  await rm(distributionDirectory, { recursive: true, force: true });
  await mkdir(distributionDirectory, { recursive: true });

  try {
    await build({
      entryPoints: esmEntryPoints,
      outdir: distributionDirectory,
      bundle: true,
      chunkNames: '_chunks/[name]-[hash]',
      entryNames: '[dir]/[name]',
      external: ['react', 'svelte', 'vue'],
      format: 'esm',
      legalComments: 'none',
      mangleProps: /^\$/,
      minify: true,
      plugins: [schedulerPrivatePlugin],
      splitting: true,
      target: 'es2020',
    });

    await Promise.all([
      build({
        entryPoints: [entryPoint],
        outfile: path.join(distributionDirectory, 'hanamaru.iife.js'),
        bundle: true,
        format: 'iife',
        globalName: 'Hanamaru',
        legalComments: 'none',
        mangleProps: /^\$/,
        minify: true,
        plugins: [schedulerPrivatePlugin],
        target: 'es2020',
      }),
      build({
        entryPoints: [path.join(sourceDirectory, 'hanamaru.css')],
        outfile: path.join(distributionDirectory, 'hanamaru.css'),
        bundle: true,
        legalComments: 'none',
        minify: true,
      }),
      build({
        entryPoints: [path.join(sourceDirectory, 'hanamaru-shadow.css')],
        outfile: path.join(distributionDirectory, 'shadow', 'hanamaru-shadow.css'),
        bundle: true,
        legalComments: 'none',
        minify: true,
      }),
      cp(typesDirectory, distributionDirectory, { recursive: true }),
    ]);

    const transformJavaScript = options.transformJavaScript ?? compressJavaScript;
    for (const filePath of await javascriptFiles(distributionDirectory)) {
      const source = await readFile(filePath, 'utf8');
      await writeFile(filePath, await transformJavaScript(filePath, source));
    }

    const metrics = await measureDistribution(projectRoot);
    await writeSizeReport(projectRoot, metrics);
  } catch (error) {
    await rm(distributionDirectory, { recursive: true, force: true });
    throw error;
  }
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedPath === import.meta.url) {
  await buildDistribution(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  console.log('build: wrote modular ESM graph, core IIFE, CSS, declarations, and size report');
}
