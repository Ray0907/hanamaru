import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
  const parent = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-server-'));
  const root = path.join(parent, 'root');
  const outside = path.join(parent, 'package.json');
  await mkdir(root);
  await mkdir(path.join(root, 'demo'));
  await Promise.all([
    writeFile(path.join(root, 'index.html'), '<h1>root fixture</h1>'),
    writeFile(path.join(root, 'demo', 'index.html'), '<h1>demo fixture</h1>'),
    writeFile(path.join(root, 'app.js'), 'console.log("fixture");'),
    writeFile(path.join(root, 'style.css'), 'body{color:green}'),
    writeFile(path.join(root, 'data.json'), '{"fixture":true}'),
    writeFile(outside, '{"outside":true}'),
  ]);
  t.after(() => rm(parent, { recursive: true, force: true }));

  const { server, url } = await createStaticServer({ root, port: 0 });
  let closed = false;
  t.after(() => !closed && new Promise((resolve) => server.close(resolve)));
  const port = new URL(url).port;

  for (const [urlPath, expectedBody, contentType] of [
    ['/', '<h1>demo fixture</h1>', /^text\/html; charset=utf-8/],
    ['/demo/', '<h1>demo fixture</h1>', /^text\/html; charset=utf-8/],
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

test('createStaticServer applies strict CSP only to the plugin browser fixture', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-server-csp-'));
  const fixtureDirectory = path.join(root, 'tests', 'fixtures');
  await mkdir(fixtureDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(fixtureDirectory, 'plugins-csp.html'), '<h1>CSP plugin fixture</h1>'),
    writeFile(path.join(fixtureDirectory, 'plugins.html'), '<h1>ordinary plugin fixture</h1>'),
    writeFile(path.join(fixtureDirectory, 'ordinary.html'), '<h1>ordinary fixture</h1>'),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const { server, url } = await createStaticServer({ root, port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = new URL(url).port;
  const pluginAliases = [
    '/tests/fixtures/plugins-csp.html',
    '/tests/fixtures/plugins-csp.html?cache=proof',
    '/tests//fixtures/plugins-csp.html',
    '/tests/fixtures/./plugins-csp.html',
    '/tests/fixtures/x%2f..%2fplugins-csp.html',
    '/tests/fixtures/x/%2e%2e/plugins-csp.html',
    '/tests/%66ixtures/%70lugins-csp.html',
  ];
  const ordinaryPlugin = await request('/tests/fixtures/plugins.html', port);
  const ordinary = await request('/tests/fixtures/ordinary.html', port);

  for (const alias of pluginAliases) {
    const plugin = await request(alias, port);
    assert.equal(plugin.statusCode, 200, alias);
    assert.equal(plugin.body, '<h1>CSP plugin fixture</h1>', alias);
    assert.equal(
      plugin.headers['content-security-policy'],
      "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'",
      alias,
    );
  }
  assert.equal(ordinaryPlugin.statusCode, 200);
  assert.equal(ordinaryPlugin.body, '<h1>ordinary plugin fixture</h1>');
  assert.equal(ordinaryPlugin.headers['content-security-policy'], undefined);
  assert.equal(ordinary.statusCode, 200);
  assert.equal(ordinary.body, '<h1>ordinary fixture</h1>');
  assert.equal(ordinary.headers['content-security-policy'], undefined);
});

test('createStaticServer does not serve files through symlinks that escape root', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'hanamaru-server-symlink-'));
  const root = path.join(parent, 'root');
  const outsideDirectory = path.join(parent, 'outside');
  const outsideFile = path.join(parent, 'secret.txt');
  await Promise.all([mkdir(root), mkdir(outsideDirectory)]);
  await Promise.all([
    writeFile(outsideFile, 'outside file secret'),
    writeFile(path.join(outsideDirectory, 'secret.txt'), 'outside directory secret'),
  ]);
  t.after(() => rm(parent, { recursive: true, force: true }));

  try {
    await Promise.all([
      symlink(outsideFile, path.join(root, 'file-link.txt')),
      symlink(outsideDirectory, path.join(root, 'directory-link')),
    ]);
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Windows symlink creation requires elevated privileges');
      return;
    }
    throw error;
  }

  const { server, url } = await createStaticServer({ root, port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = new URL(url).port;

  for (const urlPath of ['/file-link.txt', '/directory-link/secret.txt']) {
    const response = await request(urlPath, port);
    assert.equal(response.statusCode, 404);
    assert.equal(response.body, 'Not found');
  }
});
