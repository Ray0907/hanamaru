import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};
const PLUGIN_FIXTURE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'";

function notFound(response) {
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Not found');
}

export async function createStaticServer({ root = process.cwd(), port = 4173 } = {}) {
  const resolvedRoot = path.resolve(root);
  const rootPrefix = `${resolvedRoot}${path.sep}`;
  const realRoot = await realpath(resolvedRoot);
  const realRootPrefix = `${realRoot}${path.sep}`;

  const server = createServer(async (request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    } catch {
      notFound(response);
      return;
    }

    const relativePath = pathname === '/' || pathname === '/demo/'
      ? 'demo/index.html'
      : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(resolvedRoot, relativePath);

    if (filePath !== resolvedRoot && !filePath.startsWith(rootPrefix)) {
      notFound(response);
      return;
    }

    try {
      const realFilePath = await realpath(filePath);
      if (realFilePath !== realRoot && !realFilePath.startsWith(realRootPrefix)) {
        notFound(response);
        return;
      }
      const fileStat = await stat(realFilePath);
      if (!fileStat.isFile()) {
        notFound(response);
        return;
      }
      const type = MIME_TYPES[path.extname(realFilePath)] ?? 'application/octet-stream';
      const headers = { 'content-type': type };
      if (pathname === '/tests/fixtures/plugins-csp.html') {
        headers['content-security-policy'] = PLUGIN_FIXTURE_CSP;
      }
      response.writeHead(200, headers);
      response.end(await readFile(realFilePath));
    } catch {
      notFound(response);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

const isDirectExecution = typeof process.argv[1] === 'string'
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  const { server, url } = await createStaticServer();
  console.log(url);
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
}
