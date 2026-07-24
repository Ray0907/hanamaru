import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { init, parse } from 'es-module-lexer';

function relativeFile(distributionDirectory, filePath) {
  return path.relative(distributionDirectory, filePath).split(path.sep).join('/');
}

function assertInsideDistribution(distributionDirectory, filePath) {
  const relativePath = path.relative(distributionDirectory, filePath);
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new Error(`dist-check: ESM import leaves dist (${relativePath})`);
  }
}

async function localEsmSpecifiers(source) {
  await init;
  const [imports] = parse(source);
  return imports
    .map(({ n: specifier }) => specifier)
    .filter((specifier) => typeof specifier === 'string' && specifier.startsWith('.'));
}

export async function readEsmGraph(entryPath, distributionDirectory) {
  const members = [];
  const seen = new Set();
  const resolvedDistributionDirectory = path.resolve(distributionDirectory);

  async function visit(filePath) {
    const resolvedPath = path.resolve(filePath);
    assertInsideDistribution(resolvedDistributionDirectory, resolvedPath);
    if (seen.has(resolvedPath)) return;
    seen.add(resolvedPath);

    let source;
    try {
      source = await readFile(resolvedPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(
          `dist-check: missing ESM graph artifact ${
            relativeFile(resolvedDistributionDirectory, resolvedPath)
          }`,
          { cause: error },
        );
      }
      throw error;
    }

    members.push({
      file: relativeFile(resolvedDistributionDirectory, resolvedPath),
      filePath: resolvedPath,
      source,
    });
    for (const specifier of await localEsmSpecifiers(source.toString('utf8'))) {
      const cleanSpecifier = specifier.split(/[?#]/u, 1)[0];
      await visit(path.resolve(path.dirname(resolvedPath), cleanSpecifier));
    }
  }

  await visit(entryPath);
  return members;
}
