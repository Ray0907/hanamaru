import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function projectRootFromModuleUrl(moduleUrl, options) {
  const platformPath = options?.windows === true
    ? path.win32
    : options?.windows === false
      ? path.posix
      : path;
  return platformPath.resolve(
    platformPath.dirname(fileURLToPath(moduleUrl, options)),
    '..',
  );
}
