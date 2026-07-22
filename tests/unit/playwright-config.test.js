import assert from 'node:assert/strict';
import test from 'node:test';
import config from '../../playwright.config.js';

function matches(pattern, filename) {
  return pattern instanceof RegExp ? pattern.test(filename) : new RegExp(pattern).test(filename);
}

test('Playwright projects route full and smoke suites to the intended browsers', () => {
  assert.deepEqual(config.projects.map(({ name }) => name), ['chromium', 'firefox', 'webkit']);

  const projects = Object.fromEntries(config.projects.map((project) => [project.name, project]));
  assert.equal(matches(projects.chromium.testMatch, 'full.spec.js'), true);
  assert.equal(matches(projects.chromium.testMatch, 'smoke.spec.js'), true);
  assert.equal(matches(projects.firefox.testMatch, 'full.spec.js'), false);
  assert.equal(matches(projects.firefox.testMatch, 'smoke.spec.js'), true);
  assert.equal(matches(projects.webkit.testMatch, 'full.spec.js'), false);
  assert.equal(matches(projects.webkit.testMatch, 'smoke.spec.js'), true);
});

test('Playwright starts the Living Redline demo server before tests', () => {
  assert.equal(config.testDir, './tests/e2e');
  assert.equal(config.timeout, 15_000);
  assert.equal(config.use.baseURL, 'http://127.0.0.1:4173');
  assert.equal(config.use.trace, 'retain-on-failure');
  assert.equal(config.webServer.command, 'npm run build && npm run dev');
  assert.equal(config.webServer.url, 'http://127.0.0.1:4173/demo/index.html');
  assert.equal(config.webServer.reuseExistingServer, true);
});
