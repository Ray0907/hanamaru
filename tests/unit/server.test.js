import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStaticServer } from '../../scripts/serve.mjs';

function request(urlPath, port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

test('createStaticServer serves approved files, blocks traversal, and releases its port', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-server-'));
  const outside = path.join(path.dirname(root), 'package.json');
  await mkdir(path.join(root, 'demo'));
  await Promise.all([
    writeFile(path.join(root, 'index.html'), '<h1>root fixture</h1>'),
    writeFile(path.join(root, 'demo', 'index.html'), '<h1>demo fixture</h1>'),
    writeFile(path.join(root, 'app.js'), 'console.log("fixture");'),
    writeFile(path.join(root, 'style.css'), 'body{color:green}'),
    writeFile(path.join(root, 'data.json'), '{"fixture":true}'),
    writeFile(outside, '{"outside":true}'),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { force: true }));

  const { server, url } = await createStaticServer({ root, port: 0 });
  let closed = false;
  t.after(() => !closed && new Promise((resolve) => server.close(resolve)));
  const port = new URL(url).port;

  for (const [urlPath, expectedBody, contentType] of [
    ['/', '<h1>demo fixture</h1>', /^text\/html; charset=utf-8/],
    ['/index.html', '<h1>root fixture</h1>', /^text\/html; charset=utf-8/],
    ['/app.js', 'console.log("fixture");', /^text\/javascript; charset=utf-8/],
    ['/style.css', 'body{color:green}', /^text\/css; charset=utf-8/],
    ['/data.json', '{"fixture":true}', /^application\/json$/],
  ]) {
    const response = await request(urlPath, port);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, expectedBody);
    assert.match(response.headers['content-type'], contentType);
  }

  for (const urlPath of ['/missing', '/../../package.json', '/%2e%2e/%2e%2e/package.json']) {
    const response = await request(urlPath, port);
    assert.equal(response.statusCode, 404);
    assert.notEqual(response.body, '{"outside":true}');
  }

  await new Promise((resolve) => server.close(resolve));
  closed = true;
  await assert.rejects(request('/', port));
});

test('createStaticServer returns 404 for / when demo/index.html is absent', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-server-no-demo-'));
  await writeFile(path.join(root, 'index.html'), '<h1>root fixture</h1>');
  t.after(() => rm(root, { recursive: true, force: true }));

  const { server, url } = await createStaticServer({ root, port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await request('/', new URL(url).port);

  assert.equal(response.statusCode, 404);
  assert.equal(response.body, 'Not found');
});
