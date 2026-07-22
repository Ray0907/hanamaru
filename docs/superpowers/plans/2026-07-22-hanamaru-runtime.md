# Hanamaru Annotation Runtime Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and objectively verify a zero-production-dependency DOM annotation runtime plus a proof-led, accessible live playground that implements every approved Impeccable finding.

**Architecture:** The public API resolves targets into stable records, pure geometry computes marks and note placement, a per-document resource manager coalesces observation, and isolated Annotation/Story controllers own lifecycle. The demo imports only the public distribution and proves locator/native-Range targeting, reflow, playback, accessibility, and adoption paths.

**Tech Stack:** Vanilla ES2020 JavaScript and CSS, Node.js 24.13.0, `node:test`, esbuild, Playwright, `@axe-core/playwright`, native SVG/DOM/Observer APIs.

**Required skills during execution:** `@superpowers:test-driven-development` for every behavior change, `@impeccable` plus its craft-floor before UI edits, `@codex-loop-engineering` for fixed verification rounds, and `@computer-use:computer-use` for authoritative rendered acceptance.

**Design authority:** `PRODUCT.md`, `DESIGN.md`, and `docs/superpowers/specs/2026-07-22-hanamaru-runtime-design.md`.

---

## File Map

| Path | Responsibility |
|---|---|
| `.nvmrc` | Exact Node version for repeatable tests and gzip output. |
| `package.json` | Public package metadata, zero runtime dependencies, fixed scripts. |
| `scripts/test-unit.mjs` | Discover unit files, reject zero tests, invoke Node test runner. |
| `scripts/build.mjs` | Generate minified ESM/IIFE and copy base CSS. |
| `scripts/check-size.mjs` | Assert dependency and gzip budgets for both JS formats. |
| `scripts/serve.mjs` | Dependency-free static server for demo/E2E. |
| `src/errors.js` | Typed public errors and stable codes. |
| `src/target.js` | Resolve Element, selector, Range, and exact-text targets. |
| `src/geometry.js` | Pure rect normalization, candidate scoring, clamping, and paths. |
| `src/scheduler.js` | Shared document resources, observations, scroll ancestors, rAF queue. |
| `src/renderer.js` | Overlay root, SVG marks/connectors, note DOM, ARIA token registry. |
| `src/annotation.js` | Option normalization and single-annotation state controller. |
| `src/story.js` | Story validation, state machine, timers, triggers, and events. |
| `src/index.js` | Public exports and declarative `scan()`. |
| `src/hanamaru.css` | Namespaced runtime styles and theme variables only. |
| `demo/index.html` | Living Redline landing page and semantic playground structure. |
| `demo/demo.css` | Demo-only proof-sheet composition and responsive surface. |
| `demo/demo.js` | Real playback, tabs, reflow, specimens, code copy, playground. |
| `tests/unit/*.test.js` | Pure logic, identity, transitions, token ownership, and size fixtures. |
| `tests/e2e/*.spec.js` | Browser behavior, a11y, responsive, and integration acceptance. |
| `tests/fixtures/*.html` | Minimal deterministic DOM fixtures for browser RED/GREEN tests. |
| `playwright.config.js` | Chromium full suite; Firefox/WebKit smoke projects. |
| `README.md` | Accurate local quick start, API, limits, and accessibility guidance. |
| `LICENSE` | MIT license. |

## Chunk 1: Toolchain and Pure Core

### Task 1: Reproducible package and non-zero test harness

**Files:**
- Create: `.nvmrc`
- Create: `package.json`
- Create: `scripts/test-unit.mjs`
- Create: `tests/unit/scaffold.test.js`
- Create: `LICENSE`

- [ ] **Step 1: Pin Node and declare package scripts**

Create `.nvmrc` containing `24.13.0`. Create `package.json` exactly as follows; do not add a `dependencies` key:

```json
{
  "name": "hanamaru-annotations",
  "version": "0.1.0",
  "description": "A reliable, human annotation runtime for the DOM",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=24.13.0 <25" },
  "exports": { ".": "./dist/hanamaru.esm.js", "./style.css": "./dist/hanamaru.css" },
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "dev": "node scripts/serve.mjs",
    "build": "node scripts/build.mjs",
    "check:dist": "node scripts/check-size.mjs",
    "test:unit": "node scripts/test-unit.mjs",
    "test:e2e": "playwright test",
    "verify": "npm run test:unit && npm run build && npm run check:dist && npm run test:e2e"
  },
  "devDependencies": {
    "@axe-core/playwright": "^4.10.2",
    "@playwright/test": "^1.55.0",
    "esbuild": "^0.25.0"
  }
}
```

- [ ] **Step 2: Implement the zero-test guard**

Create `scripts/test-unit.mjs`:

```js
import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const root = new URL('../tests/unit/', import.meta.url)
const names = await readdir(root, { recursive: true })
const files = names.filter(name => name.endsWith('.test.js')).sort()
if (files.length === 0) {
  console.error('unit-tests: no test files found')
  process.exit(1)
}
const paths = files.map(name => new URL(name, root).pathname)
const result = spawnSync(process.execPath, ['--test', ...paths], { stdio: 'inherit' })
process.exit(result.status ?? 1)
```

Create `tests/unit/scaffold.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
test('unit harness executes at least one test', () => assert.equal(true, true))
```

- [ ] **Step 3: Add the MIT license text**

Create `LICENSE` with the standard MIT License, year `2026`, and copyright holder `Hanamaru contributors`.

- [ ] **Step 4: Install development dependencies and browser binaries**

Run:

```bash
npm install
npx playwright install chromium firefox webkit
```

Expected: both commands exit 0 and `package-lock.json` is created.

- [ ] **Step 5: Verify unit discovery and production dependency state**

Run:

```bash
npm run test:unit
npm ls --omit=dev --json
```

Expected: one unit test passes; the JSON has no `dependencies` entries.

- [ ] **Step 6: Commit the package harness**

```bash
git add .nvmrc package.json package-lock.json scripts/test-unit.mjs tests/unit/scaffold.test.js LICENSE
git commit -m "chore: scaffold Hanamaru test harness"
```

### Task 2: Deterministic build and size enforcement

**Files:**
- Create: `src/index.js`
- Create: `src/hanamaru.css`
- Create: `scripts/build.mjs`
- Create: `scripts/check-size.mjs`
- Create: `tests/unit/build.test.js`
- Create: `tests/unit/size.test.js`

- [ ] **Step 1: Write a failing build contract test**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDistribution } from '../../scripts/build.mjs'

test('build writes importable ESM, IIFE global, and exact CSS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hana-build-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/index.js'), "export const VERSION='fixture'\n")
  await writeFile(join(root, 'src/hanamaru.css'), '.hana-fixture{}\n')
  await buildDistribution(root)
  assert.match(await readFile(join(root, 'dist/hanamaru.esm.js'), 'utf8'), /VERSION/)
  assert.match(await readFile(join(root, 'dist/hanamaru.iife.js'), 'utf8'), /Hanamaru/)
  assert.equal(await readFile(join(root, 'dist/hanamaru.css'), 'utf8'), '.hana-fixture{}\n')
})
```

- [ ] **Step 2: Run the build test and verify RED**

Run `node --test tests/unit/build.test.js`.

Expected: FAIL because `scripts/build.mjs` is missing.

- [ ] **Step 3: Implement injectable `buildDistribution(root)`**

Create `scripts/build.mjs` with `root = resolve(root)` and all entry/output paths joined to that root. Export `buildDistribution(root = process.cwd())`; run it only when `pathToFileURL(process.argv[1]).href === import.meta.url`. It must remove only `join(root, 'dist')`, build ES2020 minified ESM and IIFE (`globalName:'Hanamaru'`), copy CSS, and print `build: wrote ESM, IIFE, and CSS` only in CLI mode.

- [ ] **Step 4: Run the build test and verify GREEN**

Run `node --test tests/unit/build.test.js`.

Expected: one build contract test passes.

- [ ] **Step 5: Add minimal repository source and verify the real build**

Create `src/index.js` with `export const VERSION = '0.1.0'`. Create `src/hanamaru.css` with only:

```css
.hana-overlay{position:fixed;inset:0;overflow:visible;pointer-events:none;z-index:var(--hana-z-index,2147483000)}
```

Run `npm run build`.

Expected: the exact build message and all three `dist` files.

- [ ] **Step 6: Write failing size/dependency contract tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDistribution } from '../../scripts/check-size.mjs'

async function fixture(pkg, js = 'export{}', css = '.x{}') {
  const root = await mkdtemp(join(tmpdir(), 'hana-size-'))
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg))
  await writeFile(join(root, 'dist/hanamaru.esm.js'), js)
  await writeFile(join(root, 'dist/hanamaru.iife.js'), js)
  await writeFile(join(root, 'dist/hanamaru.css'), css)
  return root
}

test('rejects even an empty dependencies key', async () => {
  const root = await fixture({ dependencies:{} })
  await assert.rejects(() => checkDistribution(root, { checkNpmTree:false }), /dependencies key/)
})
test('rejects an incompressible bundle above 8192 combined bytes', async () => {
  let state = 0x12345678
  const noisy = new Uint8Array(20_000)
  for (let i = 0; i < noisy.length; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    noisy[i] = state & 255
  }
  const root = await fixture({}, noisy)
  await assert.rejects(() => checkDistribution(root, { checkNpmTree:false }), /exceeds 8192/)
})
test('returns metrics for both small formats', async () => {
  const result = await checkDistribution(await fixture({}), { checkNpmTree:false })
  assert.deepEqual(result.map(row => row.file), ['hanamaru.esm.js','hanamaru.iife.js'])
})
```

- [ ] **Step 7: Run size tests and verify RED**

Run `node --test tests/unit/size.test.js`.

Expected: FAIL because `scripts/check-size.mjs` is missing.

- [ ] **Step 8: Implement injectable `checkDistribution(root, options)`**

Use `if ('dependencies' in pkg) throw new Error('dist-check: dependencies key must be absent')`. With `checkNpmTree !== false`, run `npm ls --omit=dev --json` with `cwd: root`. Read both JS files plus CSS, gzip each at level 9, return `[{file,raw,gzip,cssGzip,combined,stretch}]`, and throw above 8192. CLI mode prints both rows and `dist-check: pass`.

- [ ] **Step 9: Run size tests and real distribution checks**

```bash
node --test tests/unit/size.test.js
npm run build
npm run check:dist
```

Expected: three size cases pass; real checker prints both rows and `dist-check: pass`.

- [ ] **Step 10: Commit the distribution skeleton**

```bash
git add src/index.js src/hanamaru.css scripts/build.mjs scripts/check-size.mjs tests/unit/build.test.js tests/unit/size.test.js
git commit -m "build: enforce Hanamaru distribution budget"
```

### Task 3: Static server and browser harness

**Files:**
- Create: `scripts/serve.mjs`
- Create: `playwright.config.js`
- Create: `tests/unit/server.test.js`
- Create: `tests/unit/playwright-config.test.js`
- Create: `tests/fixtures/harness.html`
- Create: `tests/e2e/harness.spec.js`

- [ ] **Step 1: Write failing static-server contract tests**

Import `createStaticServer` from the missing script. In a temporary root containing `index.html`, `app.js`, and `style.css`, start on port `0` and assert: each file returns 200 with the exact HTML/JS/CSS MIME prefix; `/missing` returns 404; `/../../package.json` and its percent-encoded equivalent never return content outside the temporary root; closing the returned server releases the port.

- [ ] **Step 2: Run server tests and verify RED**

Run `node --test tests/unit/server.test.js`.

Expected: FAIL because `createStaticServer` is missing.

- [ ] **Step 3: Implement a dependency-free server with explicit safety**

Export `createStaticServer({ root = process.cwd(), port = 4173 } = {})`, resolving only paths beneath `root`. It returns a Promise resolving `{ server, url }` after listening. CLI mode prints the URL and installs the `SIGTERM` close handler. Use the following response contract:

```js
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' }
export async function createStaticServer({ root = process.cwd(), port = 4173 } = {}) {
 root = resolve(root)
 const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname)
    const relative = pathname === '/' ? 'demo/index.html' : pathname.replace(/^\/+/, '')
    const file = resolve(root, relative)
    if (file !== root && !file.startsWith(root + sep)) throw new Error('outside root')
    if (!(await stat(file)).isFile()) throw new Error('not file')
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' })
    res.end(await readFile(file))
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not found')
  }
 })
 await new Promise(resolveListen => server.listen(port, '127.0.0.1', resolveListen))
 const address = server.address()
 return { server, url: `http://127.0.0.1:${address.port}` }
}
```

- [ ] **Step 4: Run server tests and verify GREEN**

Run `node --test tests/unit/server.test.js`.

Expected: all success, MIME, 404, traversal, and close cases pass.

- [ ] **Step 5: Write a failing Playwright-project contract test**

Import the default config and assert project names equal `['chromium','firefox','webkit']`, Chromium `testMatch` accepts `full.spec.js` and `smoke.spec.js`, and Firefox/WebKit accept only `smoke.spec.js`. Assert `webServer.url` targets the harness fixture.

- [ ] **Step 6: Run config test and verify RED**

Run `node --test tests/unit/playwright-config.test.js`.

Expected: FAIL because `playwright.config.js` is missing.

- [ ] **Step 7: Create exact Playwright project matching**

Create `playwright.config.js`:

```js
import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 15_000,
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: { command: 'npm run build && npm run dev', url: 'http://127.0.0.1:4173/tests/fixtures/harness.html', reuseExistingServer: true },
  projects: [
    { name: 'chromium', testMatch: /.*\.spec\.js/, use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', testMatch: /smoke\.spec\.js/, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', testMatch: /smoke\.spec\.js/, use: { ...devices['Desktop Safari'] } }
  ]
})
```

- [ ] **Step 8: Run config test and verify GREEN**

Run `node --test tests/unit/playwright-config.test.js`.

Expected: all project-match assertions pass.

- [ ] **Step 9: Write and run the browser harness test**

Create `tests/fixtures/harness.html` as a valid HTML document with `<h1>Hanamaru harness</h1>`. Create `tests/e2e/harness.spec.js`:

```js
import { test, expect } from '@playwright/test'
test('static browser harness responds', async ({ page }) => {
  await page.goto('/tests/fixtures/harness.html')
  await expect(page.getByRole('heading', { name: 'Hanamaru harness' })).toBeVisible()
})
```

Run `npx playwright test tests/e2e/harness.spec.js --project=chromium`.

Expected: one Chromium test passes and the server exits after Playwright completes.

- [ ] **Step 10: Commit the browser harness**

```bash
git add scripts/serve.mjs playwright.config.js tests/unit/server.test.js tests/unit/playwright-config.test.js tests/fixtures/harness.html tests/e2e/harness.spec.js
git commit -m "test: add Hanamaru browser harness"
```

### Task 4: Typed errors and canonical option validation

**Files:**
- Create: `src/errors.js`
- Create: `src/annotation.js`
- Create: `tests/unit/options.test.js`

- [ ] **Step 1: Write complete failing option/error tests**

Create table-driven cases for the eight fields. Assert the exact `HANA_CONFIG_INVALID` code, `details.field`, and `details.value` for each invalid case:

```js
const invalid = [
  [{}, 'mark'], [{ mark: 'scribble' }, 'mark'],
  [{ mark: 'circle', placement: 'near' }, 'placement'],
  [{ mark: 'circle', trigger: 'hover' }, 'trigger'],
  [{ mark: 'circle', accessible: 'yes' }, 'accessible'],
  [{ mark: 'circle', seed: Infinity }, 'seed'],
  [{ mark: 'circle', duration: -1 }, 'duration'],
  [{ mark: 'circle', motion: 'always' }, 'motion'],
  [{ mark: 'circle', note: '花'.repeat(281) }, 'note']
]
```

Also assert defaults equal:

```js
{ mark:'circle', note:null, placement:'auto', trigger:'manual', accessible:false, seed:'id-1', duration:650, motion:'system' }
```

Assert `new HanamaruConfigError(code, message, details)` exposes `name`, `code`, `message`, and `details` unchanged.

- [ ] **Step 2: Run focused tests and verify RED**

Run `node --test tests/unit/options.test.js`.

Expected: FAIL because error and option exports are missing.

- [ ] **Step 3: Implement typed errors and strict/scan normalization modes**

`src/errors.js` exports the four typed classes. In `src/annotation.js`, export `normalizeOptions(input, fallbackSeed, { allowUnknown = false } = {})`. Unknown object keys throw when `allowUnknown` is false and are dropped when true; known invalid values always throw. Use `[...note].length`, normalize `''` to `null`, and return only canonical keys.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run `node --test tests/unit/options.test.js`.

Expected: all default, invalid, unknown-key, Unicode-length, and public-error tests pass.

- [ ] **Step 5: Commit option contracts**

```bash
git add src/errors.js src/annotation.js tests/unit/options.test.js
git commit -m "feat: validate annotation options"
```

### Task 5: Exact-text matching helpers

**Files:**
- Create: `src/target.js`
- Create: `tests/unit/target.test.js`

- [ ] **Step 1: Write failing pure matching tests**

Test `normalizeLocatorText`, `findMatchOffsets`, and `validateOccurrence` with exact fixtures: collapsed Unicode whitespace, trimmed locator input, non-overlapping left-to-right matches, zero-based selection, empty normalized input, and negative/fractional occurrence. `findMatchOffsets('a  a a', 'a')` must return `[[0,1],[2,3],[4,5]]` in normalized coordinates.

- [ ] **Step 2: Run pure tests and verify RED**

Run `node --test tests/unit/target.test.js`.

Expected: FAIL with missing target exports.

- [ ] **Step 3: Implement only the pure matching helpers**

Normalize with `value.trim().replace(/\s+/gu, ' ')`. Find matches with an index advanced by `needle.length`, never by one, so overlaps are excluded. Validate occurrence as an integer `>= 0`; throw `HanamaruConfigError('HANA_CONFIG_INVALID', ..., { field:'occurrence', value })` for invalid values.

- [ ] **Step 4: Run pure tests and verify GREEN**

Run `node --test tests/unit/target.test.js`.

Expected: every pure matching fixture passes.

- [ ] **Step 5: Commit matching helpers**

```bash
git add src/target.js tests/unit/target.test.js
git commit -m "feat: match normalized target text"
```

### Task 6: Element, selector, and native Range resolution

**Files:**
- Create: `tests/fixtures/targets.html`
- Create: `tests/e2e/target.spec.js`
- Modify: `src/target.js`

- [ ] **Step 1: Create Element/selector/Range fixtures and failing tests**

The fixture contains unique and duplicate selectors. Browser tests dynamically import `/src/target.js` and assert Element/unique-selector records, exact missing/ambiguous/invalid-selector codes, cloned native Range boundaries and nearest `ownerElement`, acceptance of a connected collapsed Range, rejection of disconnected and cross-document targets, and in-place `refresh()` identity.

- [ ] **Step 2: Run browser tests and verify RED**

Run `npx playwright test tests/e2e/target.spec.js --project=chromium`.

Expected: FAIL because `resolveTarget` is missing.

- [ ] **Step 3: Implement Element and selector records**

Implement `resolveTarget(Element|string, doc)` first. A record is `{kind,source,element,range:null,ownerElement,refresh}`. Direct Elements retain object identity and require connection/ownerDocument; selectors are stored as text, must resolve uniquely on construction/refresh, and update the same record object.

- [ ] **Step 4: Run only Element/selector tests and verify GREEN**

Tag those tests `@element` and run `npx playwright test tests/e2e/target.spec.js --project=chromium --grep @element`.

Expected: Element/selector tests pass while Range tests remain failing.

- [ ] **Step 5: Implement native Range records**

Clone the Range, reject cross-document/disconnected boundaries, set `ownerElement` to the common ancestor when it is an Element or its parent Element otherwise, accept zero-area/collapsed identity, and make refresh validate the same cloned boundary nodes. It never adopts replacement nodes.

- [ ] **Step 6: Run all Element/selector/Range tests**

Run `npx playwright test tests/e2e/target.spec.js --project=chromium --grep-invert @locator`.

Expected: every non-locator target test passes.

- [ ] **Step 7: Commit base target records**

```bash
git add src/target.js tests/fixtures/targets.html tests/e2e/target.spec.js
git commit -m "feat: resolve element and range targets"
```

### Task 7: Exact-text locator DOM resolution

**Files:**
- Modify: `tests/fixtures/targets.html`
- Modify: `tests/e2e/target.spec.js`
- Modify: `src/target.js`

- [ ] **Step 1: Add failing `@locator` browser cases**

Add split-node text, forbidden script/template/hidden text, duplicate occurrences, element-based `within`, and replaceable selector-based `within`. Assert wrapper count stays unchanged; zero/multiple/out-of-range codes; forbidden text exclusion; selector container replacement; element container non-adoption; same-element text mutation rebuilding its Range; and refresh returning the same record.

- [ ] **Step 2: Run locator tests and verify RED**

Run `npx playwright test tests/e2e/target.spec.js --project=chromium --grep @locator`.

Expected: locator cases fail because object targets are unsupported.

- [ ] **Step 3: Implement text-node collection and offset mapping**

Use `TreeWalker(SHOW_TEXT)` and reject ancestors matching `script,style,noscript,template,[hidden],[inert]`. Build a normalized string and a parallel array mapping each normalized character boundary to `{node,offset}`. Reuse the already-tested pure matcher.

- [ ] **Step 4: Run split-node/forbidden cases**

Run the `@locator-map` subset.

Expected: split-node and exclusion cases pass; replacement cases may still fail.

- [ ] **Step 5: Implement locator record refresh identity**

For string `within`, store the selector and re-query before every rebuilt match. For Element `within`, store the exact object and reject a replacement. Every successful refresh rebuilds `range`, updates `ownerElement`, mutates the same record, and returns it.

- [ ] **Step 6: Run all target tests**

```bash
node --test tests/unit/target.test.js
npx playwright test tests/e2e/target.spec.js --project=chromium
```

Expected: every pure and DOM target fixture passes.

- [ ] **Step 7: Commit locators**

```bash
git add src/target.js tests/fixtures/targets.html tests/e2e/target.spec.js
git commit -m "feat: resolve unwrapped text locators"
```

### Task 8: Rects, intersections, candidates, and clamping

**Files:**
- Create: `src/geometry.js`
- Create: `tests/unit/geometry.test.js`

- [ ] **Step 1: Write failing eight-field rect tests**

`rect(x,y,width,height)` derives `top=y`, `right=x+width`, `bottom=y+height`, `left=x`. Test `unionRects`, `intersectionArea`, and `clampNoteRect(rect(360,-20,180,120), {width:390,height:844}, 12) === rect(198,12,180,120)`.

- [ ] **Step 2: Run rect tests and verify RED**

Run the `rect` test-name subset; expect missing exports.

- [ ] **Step 3: Implement rect, union, intersection, and clamp**

Keep every helper DOM-free and return all eight fields. Clamping first caps width/height to the safe viewport, then clamps x/y and reconstructs derived edges.

- [ ] **Step 4: Run rect tests and verify GREEN**

Expected: exact eight-field fixtures pass.

- [ ] **Step 5: Write failing note-candidate tests**

`noteCandidates(target,noteSize,gap=16)` returns `{top,right,bottom,left}`. For target `rect(50,100,100,40)` and note `{width:120,height:60}`, expected origins are top `(40,24)`, right `(166,90)`, bottom `(40,156)`, left `(-86,90)`.

- [ ] **Step 6: Implement and pass candidate tests**

Place note centers on target centers and apply the exact 16px edge gap. Run `node --test tests/unit/geometry.test.js`; expect all rect/candidate cases pass.

- [ ] **Step 7: Commit geometry primitives**

```bash
git add src/geometry.js tests/unit/geometry.test.js
git commit -m "feat: compute annotation rectangles"
```

### Task 9: Reproducible placement scoring

**Files:**
- Modify: `src/geometry.js`
- Modify: `tests/unit/geometry.test.js`

- [ ] **Step 1: Write failing overflow and distance helper tests**

Define `overflowPixels(note,viewport,inset)` as the sum of left/top/right/bottom edge excess beyond `{left:inset,top:inset,right:viewport.width-inset,bottom:viewport.height-inset}`. Define `connectorDistance(target,note)` as Euclidean distance from target center to the nearest point in note rect (each coordinate clamped to note bounds). Assert exact integer fixtures.

- [ ] **Step 2: Implement helpers and verify GREEN**

Export both helpers, use `Math.hypot`, and run their focused tests.

- [ ] **Step 3: Write failing score/choice tests**

`scoreCandidate(candidate,{target,viewport,otherNotes=[],inset=12,preferencePenalty=0})` uses:

```text
overflowPixels * 1000 + intersectionArea(candidate,target) * 100
+ sum(intersectionArea(candidate, otherNote)) * 10
+ max(0, connectorDistance(target,candidate) - 240) + preferencePenalty
```

For auto, candidate order is `[right,top,bottom,left]` in LTR and `[left,top,bottom,right]` in RTL, all penalties zero. For explicit side S, order is `[S,opposite(S),...autoOrderWithoutThose]` with penalties `[0,25,50,75]` assigned by that named order. Equal scores preserve order. `choosePlacement({target,noteSize,viewport,placement='auto',dir='ltr',otherNotes=[],gap=16,inset=12})` returns `{side,score,rect}` and clamps only the winning rect.

- [ ] **Step 4: Implement score and choice in two commits of behavior**

First implement `scoreCandidate` and pass exact arithmetic fixtures. Then implement `choosePlacement` and pass overflow-dominance, explicit opposite, LTR/RTL tie, other-note overlap, and post-score clamp fixtures.

- [ ] **Step 5: Run all geometry tests**

Run `node --test tests/unit/geometry.test.js`.

Expected: every rect, candidate, helper, score, ordering, and clamp case passes.

- [ ] **Step 6: Commit placement**

```bash
git add src/geometry.js tests/unit/geometry.test.js
git commit -m "feat: score responsive note placement"
```

### Task 10: Stateless jitter and line-mark paths

**Files:**
- Modify: `src/geometry.js`
- Create: `tests/unit/paths.test.js`

- [ ] **Step 1: Write failing hash/jitter golden tests**

FNV-1a uses offset `2166136261` and `Math.imul(hash ^ charCode, 16777619)` for each UTF-16 code unit. `jitter(seed,label,amplitude=1.5)` maps unsigned hash of ```${seed}:${label}``` linearly to `[-amplitude,+amplitude]`, rounded to two decimals. Golden: `jitter('golden','underline:0:x0') === 0.42` and `jitter('golden','strike:0:mx') === -1.07`.

- [ ] **Step 2: Implement and pass stateless jitter**

Run only jitter tests; expect both golden values and seed differentiation to pass. Stateless labeled jitter removes random-consumption-order ambiguity.

- [ ] **Step 3: Write failing underline/highlight/strike paths**

For each line rect index `i`, use labels `${mark}:${i}:${coordinate}`. Underline base is `bottom+2` and exact form `M left+j(x0) base+j(y0) Q centerX+j(mx) base+j(my) right+j(x1) base+j(y1)`. Golden for seed `golden`, `rect(10,20,100,40)`: `M 10.42 62.49 Q 61.25 63.23 110.44 62.48`.

Highlight is the closed polygon covering `y+height*0.45` to `bottom`, with independently labeled `tlx,tly,trx,try,brx,bry,blx,bly`. Strike uses two quadratic paths at `centerY-1` and `centerY+1`, each with its own pass labels.

- [ ] **Step 4: Implement each line mark and run after each**

Implement underline, run its golden test; implement highlight, run per-line/count/bounds tests; implement strike, run two-pass/golden-stability tests.

- [ ] **Step 5: Commit line marks**

```bash
git add src/geometry.js tests/unit/paths.test.js
git commit -m "feat: draw deterministic line marks"
```

### Task 11: Enclosure and bracket paths

**Files:**
- Modify: `src/geometry.js`
- Modify: `tests/unit/paths.test.js`

- [ ] **Step 1: Write failing circle, box, and bracket tests**

All use the union rect and `padding=5`. Circle has two passes. For pass `p`, center is union center, `rx=width/2+padding+p`, `ry=height/2+padding-p*0.5`, kappa `0.5522848`, start at right, then bottom/left/top/right cubic segments, with every anchor/control coordinate labeled `circle:${p}:${segment}:${axis}` before two-decimal rounding.

Box has two closed passes through padded `tl,tr,br,bl`, with pass 1 expanding every edge by 1px; label each corner/axis. Bracket has two right-side open paths at `right+padding+p`, `top-padding`, `bottom+padding`, with 10px inward hooks and labels for all six points.

- [ ] **Step 2: Implement circle and verify exact structure**

Run the circle subset after implementation. Expect two `M...C...C...C...C...Z` paths, deterministic bytes, padded bounds, and changed bytes for a different seed.

- [ ] **Step 3: Implement box and bracket with focused GREEN checks**

Run after each mark. Expect two closed box paths and two open four-point bracket paths; assert union rather than per-line behavior.

- [ ] **Step 4: Run every Chunk 1 check**

```bash
npm run test:unit
npx playwright test tests/e2e/harness.spec.js tests/e2e/target.spec.js --project=chromium
npm run build
npm run check:dist
```

Expected: non-zero unit count passes, both Chromium browser files pass, and distribution check prints `dist-check: pass`.

- [ ] **Step 5: Commit enclosure marks**

```bash
git add src/geometry.js tests/unit/paths.test.js
git commit -m "feat: draw deterministic enclosure marks"
```

## Chunk 2: Runtime, Lifecycle, and Public API

### Task 12: Coalesced frame scheduler

**Files:**
- Create: `src/scheduler.js`
- Create: `tests/unit/scheduler.test.js`

- [ ] **Step 1: Write failing FrameQueue tests**

Test an injected fake `requestFrame` and `cancelFrame`. `enqueue({key,generation,read,write,onError})` must replace earlier work for the same key, run every surviving read before any write, and skip a job whose current generation no longer equals the captured generation. A read or write error calls that job's `onError(error)` exactly once and does not block peers. `cancel(key)` removes pending work. `destroy()` cancels the scheduled frame and rejects further enqueue calls.

- [ ] **Step 2: Run scheduler tests and verify RED**

Run `node --test tests/unit/scheduler.test.js`.

Expected: FAIL because `FrameQueue` is missing.

- [ ] **Step 3: Implement FrameQueue only**

The constructor accepts `{ requestFrame, cancelFrame, generationFor }`. Store job objects in a `Map` by `key`. The frame callback copies and clears jobs, collects `{job,value:job.read()}` for matching generations, then calls writes in the same insertion order. A failed read skips that job's write. Track a per-job failure flag so read or write failure calls `onError` at most once.

- [ ] **Step 4: Run scheduler tests and verify GREEN**

Run `node --test tests/unit/scheduler.test.js`. Expected: deduplication, read-before-write, stale generation, cancel, destroy, and isolated-error cases pass.

- [ ] **Step 5: Commit scheduler**

```bash
git add src/scheduler.js tests/unit/scheduler.test.js
git commit -m "feat: coalesce annotation layout work"
```

### Task 13: Shared document resources and observation ownership

**Files:**
- Modify: `src/scheduler.js`
- Create: `tests/fixtures/resources.html`
- Create: `tests/e2e/resources.spec.js`

- [ ] **Step 1: Write failing shared-root ownership tests**

In Chromium import `acquireDocumentResources(document)` twice. Assert both leases reference one `[data-hana-overlay]`, one SVG layer, one note layer, one `ResizeObserver`, one `MutationObserver`, one window-resize listener, and one `FrameQueue`. Releasing one keeps every shared resource; releasing the second disconnects observers/listeners and removes the root. A third acquire creates fresh resources. Assert root classes are namespaced and `aria-hidden="true"` exists only on the SVG.

- [ ] **Step 2: Run ownership tests and verify RED**

Run:

```bash
npx playwright test tests/e2e/resources.spec.js --project=chromium --grep "shared ownership"
```

Expected: FAIL because `acquireDocumentResources` is missing.

- [ ] **Step 3: Implement lease/ref-count ownership**

Use a module `WeakMap<Document, SharedResources>`. `acquireDocumentResources(doc)` increments refs and returns an idempotent `{shared,release}` lease. Implement this internal interface exactly:

```js
shared.registerController(id)
shared.bumpGeneration(id)
shared.generationFor(id)
shared.observeLayout({ id, generation, record, note, read, write, onError })
shared.rebindLayout(id, { generation, record, note, read, write, onError })
shared.observeIntersection({ id, target, threshold, onEnter, onExit, onUnavailable })
shared.releaseController(id)
```

`SharedResources` owns the overlay layers, one frame queue, one document-wide resize observer, one document-wide mutation observer, one window-resize listener, scroll-listener and intersection-observer registries, and controller generations. `registerController` starts at generation zero; `bumpGeneration` invalidates queued work; `releaseController` removes that controller's layout/trigger subscriptions. Remove shared resources only at lease ref count zero.

- [ ] **Step 4: Run ownership tests and verify GREEN**

Run the Step 2 command. Expected: shared instance/ref-count/idempotent-release cases pass.

- [ ] **Step 5: Write failing scroll and resize subscription tests**

Add nested scroll containers, direct Element, selector target, selector-based locator, Element-based locator, native Range, and note node. Assert `observeLayout(...)`:

- shares passive listeners on identical scroll ancestors and removes them by ref count;
- observes resolved target/container/note sizes with the single shared resize observer;
- observes the native Range's nearest stable owner parent for mutation/resize signals;
- listens to `window.resize` once for the document;
- re-discovers and rebinds changed scroll ancestors on `rebindLayout`;
- falls back to window resize plus explicit `refresh()` when `ResizeObserver` is unavailable;
- returns an idempotent unsubscribe and never writes after a generation bump or release.

- [ ] **Step 6: Implement scroll ancestor discovery**

Walk parents to `document.scrollingElement`; include an ancestor when computed `overflowX` or `overflowY` matches `auto|scroll|overlay`, then include `window`. Store passive listener records `{count,listener,ids}` keyed by `EventTarget`. On `refresh()`/`update()`, `rebindLayout` diffs old/new ancestors and subscriptions. Without `ResizeObserver`, do not synthesize polling: window resize and public explicit refresh are the documented fallback.

- [ ] **Step 7: Run scroll/resize tests RED, implement, then verify GREEN**

Run:

```bash
npx playwright test tests/e2e/resources.spec.js --project=chromium --grep "scroll and resize"
```

Expected RED before implementation and GREEN after implementing Step 6 plus shared resize/window subscription routing.

- [ ] **Step 8: Write failing mutation-scope and scheduling tests**

Assert the single mutation observer uses `{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden']}` and routes only records in each controller's stable scope: direct Element parent, selector target/document, selector locator/document, Element locator/container, and native Range owner parent. Ignore a record exactly when `record.target === overlay || overlay.contains(record.target)`. A signal burst must enqueue one controller job whose `read()` runs before every surviving job's `write()`. An exception reaches only that controller's `onError` once.

- [ ] **Step 9: Implement scoped mutation routing and read/write jobs**

Maintain controller subscription records under the one shared observer. Each accepted signal calls:

```js
frameQueue.enqueue({ key:id, generation, read, write, onError })
```

Observation code must never measure or render directly. `read` performs the controller-provided measure/geometry computation; `write` draws its returned immutable layout. The frame queue enforces all reads before writes.

- [ ] **Step 10: Verify resource contract and commit**

Run:

```bash
npx playwright test tests/e2e/resources.spec.js --project=chromium
```

Expected: ownership, single-observer, scope, scroll, resize fallback, generation, read/write ordering, failure isolation, and cleanup cases pass.

```bash
git add src/scheduler.js tests/fixtures/resources.html tests/e2e/resources.spec.js
git commit -m "feat: share document observation resources"
```

### Task 14: ARIA token registry and overlay renderer

**Files:**
- Create: `src/renderer.js`
- Modify: `src/hanamaru.css`
- Create: `tests/unit/aria.test.js`
- Create: `tests/fixtures/renderer.html`
- Create: `tests/e2e/renderer.spec.js`

- [ ] **Step 1: Write failing token-registry unit tests**

Test pure `addDescriptionToken(current,id)` and `removeDescriptionToken(current,id)` helpers. They split on whitespace, deduplicate, preserve author tokens/order, remove only the requested Hanamaru ID, and return `null` when no tokens remain. Cover two Hanamaru notes destroyed out of order and an author token added between mount and teardown.

- [ ] **Step 2: Implement and pass token helpers**

Run `node --test tests/unit/aria.test.js`; first verify RED, implement the two pure helpers, then verify GREEN.

- [ ] **Step 3: Write failing renderer structure tests**

Define internal `createRenderer({id,record,options,lease})` returning:

```js
{ group, noteElement, measure(), draw(layout), animate(duration), updateOwner(owner), pause(), resume(), finish(), hide(), destroy() }
```

`measure()` is read-only and returns `{noteRect,peerNoteRects,viewport}`. In the shared scheduler's read phase, the controller measures the resolved target record, combines it with this renderer measurement, and calls pure geometry. It then passes `draw(layout)` this fixed object:

```js
{
  targetRects, unionRect, markPaths, side, noteRect,
  connector: { shaft, head }, viewport
}
```

Browser tests assert one namespaced SVG group per annotation, exact generated `<path>` counts/values, SVG `aria-hidden`, note text/max length, accessible-note association on `ownerElement`, decorative notes with `aria-hidden="true"` and no association, and token-safe owner transfer/teardown.

- [ ] **Step 4: Run renderer structure tests and verify RED**

Run:

```bash
npx playwright test tests/e2e/renderer.spec.js --project=chromium --grep "renderer structure"
```

Expected: FAIL because `createRenderer` is missing.

- [ ] **Step 5: Add connector and final-layout geometry tests**

Extend `tests/unit/geometry.test.js` with exact connector fixtures. `buildConnector(targetRect,noteRect,side)` starts at the target edge center facing `side`, ends at the nearest point on the clamped note edge, shortens the shaft by 8px, and builds a two-segment 7px arrowhead at ±28°. Zero-distance input returns empty shaft/head paths. Run:

```bash
node --test --test-name-pattern="connector" tests/unit/geometry.test.js
```

Expected: RED before `buildConnector`. Implement the exact shaft/head calculation in `src/geometry.js`, rerun the same command, then expect GREEN.

- [ ] **Step 6: Implement renderer mount/draw/owner transfer**

The renderer only creates owned nodes, measures its note/peer overlay nodes, and writes the supplied layout; it does not resolve or measure targets and does not call geometry helpers. `updateOwner(nextOwner)` removes the Hanamaru description token from the former owner and adds it to the next owner without disturbing author/concurrent tokens. Accessible notes receive a stable ID; after the first draw, enqueue a new-generation scheduler job whose read phase returns `scrollHeight > clientHeight` and whose write phase alone adds/removes `tabindex="0"`. Decorative notes are hidden from accessibility and never focusable. `destroy()` removes only owned nodes/tokens and is idempotent.

- [ ] **Step 7: Run renderer structure tests and verify GREEN**

Run:

```bash
npx playwright test tests/e2e/renderer.spec.js --project=chromium --grep "renderer structure"
```

Expected: structure, six mark path counts, note placement, scheduled overflow focusability, ARIA, and teardown cases pass.

- [ ] **Step 8: Write failing phase and motion-control tests**

Assert `animate(duration)` returns `{animations,finished}`. Phase allocation is mark 55%, connector 25%, note 20%, with phase start offsets 0%, 55%, and 80%. `pause()`/`resume()` affect every active handle, `finish()` applies final styles, `hide()` cancels and hides without removing, and duration zero completes in the same task.

- [ ] **Step 9: Implement WAAPI and elapsed-time fallback**

When WAAPI exists, animate path dash offset and note opacity/translate using explicit phase offsets. Without WAAPI, set namespaced CSS classes/custom properties and drive `finished`, `pause()`, and `resume()` with an internal elapsed-time clock that records `startedAt`, `elapsed`, and remaining timeout. Runtime CSS defines only `.hana-*`/`[data-hana-*]`, note sizing/overflow, phase keyframes, theme variables, visible classes, and no bare element selectors.

Run:

```bash
npx playwright test tests/e2e/renderer.spec.js --project=chromium --grep "motion"
```

Expected: WAAPI and forced-no-WAAPI timing, pause/resume, finish, hide, and zero-duration cases pass.

- [ ] **Step 10: Commit renderer**

```bash
git add src/renderer.js src/hanamaru.css tests/unit/aria.test.js tests/fixtures/renderer.html tests/e2e/renderer.spec.js
git commit -m "feat: render accessible annotation overlays"
```

### Task 15: Annotation state controller

**Files:**
- Modify: `src/annotation.js`
- Create: `tests/unit/annotation-state.test.js`
- Create: `tests/fixtures/annotation.html`
- Create: `tests/e2e/annotation.spec.js`

- [ ] **Step 1: Write failing pure transition tests with fake environment**

Export internal `createAnnotation(target,rawOptions,env)`. The fake env supplies resolver, lease, renderer, event factory, reduced-motion match, and microtask. Table-test every non-suspended row in spec Section 5.4: initial `idle`/`finished:null`; accepted `show()` from idle/hidden creates one new Promise; duplicate show from showing/visible is a no-op retaining the Promise; hide from showing rejects with a DOMException whose `name === 'AbortError'`, hide from visible enters hidden, replay from every non-destroyed state aborts pending work and creates a new Promise, refresh from idle/hidden stays in the same state, and destroy is idempotent. Every control method returns the identical controller for chaining.

- [ ] **Step 2: Run state tests and verify RED**

Run `node --test tests/unit/annotation-state.test.js`; expect missing controller.

- [ ] **Step 3: Implement idle/showing/visible/hidden/destroyed transitions**

Implement only manual trigger, an exact `abortError()` helper, renderer calls, per-run deferred, generation increments, and `hana:start|complete|cancel` dispatch. Verify with:

```bash
node --test --test-name-pattern="non-suspended transitions|AbortError|chaining" tests/unit/annotation-state.test.js
```

- [ ] **Step 4: Add failing suspended-transition table**

Fake resolver failures/recoveries and assert every suspended rule: failed refresh from any non-destroyed state remembers requested visibility, hides, rejects pending run, emits one error per disconnected episode, and enters suspended; successful refresh restores visible without animation only if visibility was requested, otherwise hidden; `show()` from suspended succeeds by re-resolving and creates a run, while failure remains suspended with a newly rejected `finished`; `hide()` from suspended clears requested visibility and enters hidden.

- [ ] **Step 5: Implement and verify suspended transitions**

Run:

```bash
node --test --test-name-pattern="suspended transitions|disconnected episode" tests/unit/annotation-state.test.js
```

Expected: RED; implement the rules without DOM branches; rerun to GREEN.

- [ ] **Step 6: Add failing refresh/update/failure atomicity cases**

Assert refresh during showing completes into visible; successful refresh preserves idle/hidden; atomic update rolls back on validation failure; target/option update while showing retains and completes the existing run Promise with recomputed geometry; update while visible redraws final state without a new Promise; update while suspended preserves requested visibility and attempts recovery; native Range update accepts a new Range; renderer failure becomes `HanamaruStateError`, rejects pending work, hides, and suspends.

- [ ] **Step 7: Implement refresh/update/failure behavior**

Validate replacement options/target before mutating. On successful visible update draw final state without creating `finished`. On failure hide renderer, reject pending run, preserve requested visibility, and dispatch exact error detail.

- [ ] **Step 8: Run complete unit state suite**

Run `node --test tests/unit/annotation-state.test.js`. Expected: every normative transition row, owner transfer, error, exact AbortError, and chaining case passes.

- [ ] **Step 9: Write failing browser integration tests**

Assert real `annotate()` show/hide/replay/update/destroy; bubbling/composed event details; accessible note ownership; reduced-motion immediate final state; direct disconnected target suspension and same-node reconnection; selector replacement recovery; no overlay after final destroy.

- [ ] **Step 10: Wire browser environment and observers**

Create the default environment from `document`, target resolver, resources, renderer, and geometry. The controller registers with the shared manager; each scheduled job uses renderer `measure()` plus pure layout computation in `read`, then renderer `draw(layout)` in `write`. `refresh()`/`update()` call `rebindLayout`. Implement module-private `pauseAnnotationRun(controller)` and `resumeAnnotationRun(controller)` backed by a `WeakMap`; do not export them from `src/index.js`.

- [ ] **Step 11: Run browser integration and commit**

Run unit state suite plus `npx playwright test tests/e2e/annotation.spec.js --project=chromium`; expect all cases pass.

```bash
git add src/annotation.js tests/unit/annotation-state.test.js tests/fixtures/annotation.html tests/e2e/annotation.spec.js
git commit -m "feat: control annotation lifecycle"
```

### Task 16: Annotation load and viewport triggers

**Files:**
- Modify: `src/annotation.js`
- Modify: `tests/e2e/annotation.spec.js`

- [ ] **Step 1: Write failing load-trigger browser cases**

Construct before and after DOMContentLoaded. Assert one-shot listener before, microtask after, exactly one show, and destroy-before-load removes listener.

- [ ] **Step 2: Implement load trigger and verify GREEN**

Use `doc.readyState === 'loading'` to choose listener vs microtask. Guard every callback by generation/destroyed state. Run:

```bash
npx playwright test tests/e2e/annotation.spec.js --project=chromium --grep "load trigger"
```

Expected: before/after DOMContentLoaded, exactly-once, and destroy-before-load cases pass.

- [ ] **Step 3: Write failing viewport-trigger and fallback cases**

Assert resource-managed `shared.observeIntersection` uses threshold `0.25`, first qualifying entry shows once, exit keeps annotation visible, observer subscription disconnects after start, and destroy before entry disconnects without show. Force `IntersectionObserver` unavailable and assert `onUnavailable` follows exact load-trigger semantics.

- [ ] **Step 4: Implement viewport trigger through shared resources**

Do not construct an observer in the annotation controller. Use the shared manager and guard callbacks by controller generation/state. If unavailable, call the same load-trigger installer. Run:

```bash
npx playwright test tests/e2e/annotation.spec.js --project=chromium --grep "load trigger|viewport trigger|IntersectionObserver fallback"
```

Expected: manual, load, viewport, fallback, destroy, and reduced-motion cases pass.

- [ ] **Step 5: Commit triggers**

```bash
git add src/annotation.js tests/e2e/annotation.spec.js
git commit -m "feat: trigger annotations on load and viewport"
```

### Task 17: Story validation and state machine

**Files:**
- Create: `src/story.js`
- Create: `tests/unit/story.test.js`

- [ ] **Step 1: Write failing story construction tests**

With fake `resolveTarget` and `createAnnotation`, assert every step resolves/validates before any annotation mount; malformed step, `once` outside viewport, or one bad target throws before mutation. Step trigger/motion fields are rejected. Defaults are `{trigger:'manual',gap:180,motion:'system'}` with the `once` key omitted unless `trigger === 'viewport'` (where it defaults to `true`).

- [ ] **Step 2: Implement validation/preparation and verify GREEN**

Export internal `createStory(steps,options,env)`. Prepare target records/options first, then create manual annotations only after the complete array succeeds. Run:

```bash
node --test --test-name-pattern="story construction" tests/unit/story.test.js
```

- [ ] **Step 3: Write failing play/complete/gap tests**

Use fake annotations with controllable `finished` Promises and fake timers. Assert idle→playing→complete, step ordering, configured gaps, code-step event payload, one new per-run Promise, and zero gaps under reduced motion.

- [ ] **Step 4: Implement play/complete and verify GREEN**

Run `node --test --test-name-pattern="play sequence|gaps|reduced motion" tests/unit/story.test.js`; implement until GREEN.

- [ ] **Step 5: Write failing pause/resume/cancel/replay tests**

Assert pause calls module-private `pauseAnnotationRun` for the active step and freezes elapsed gap time; resume calls `resumeAnnotationRun` and continues the remainder. Assert cancel/replay/destroy abort exact pending Promises with `AbortError`, replay works from every non-destroyed state, clears marks, revalidates atomically, starts at zero, and every method returns the controller.

- [ ] **Step 6: Implement state controls and verify GREEN**

Inject the two private annotation run controls through `env`. Implement elapsed gap accounting with the same fake clock. Run:

```bash
node --test --test-name-pattern="pause|resume|cancel|replay|destroy|chaining" tests/unit/story.test.js
```

- [ ] **Step 7: Add failing target/renderer loss tests**

Reject a current and future annotation run with `HanamaruTargetError`/`HanamaruStateError`. Assert story error detail index, cancelled state, completed marks retained, future marks not shown, `finished` rejection, and atomic replay revalidation.

- [ ] **Step 8: Implement failure propagation and run all story tests**

Run `node --test tests/unit/story.test.js`. Expected: construction, state, timing, pause/resume, reduced-motion, loss, replay, AbortError, chaining, and teardown cases pass.

- [ ] **Step 9: Commit story controller**

```bash
git add src/story.js tests/unit/story.test.js
git commit -m "feat: play ordered annotation stories"
```

### Task 18: Story triggers and browser integration

**Files:**
- Modify: `src/story.js`
- Create: `tests/fixtures/story.html`
- Create: `tests/e2e/story.spec.js`

- [ ] **Step 1: Write failing browser story controls/events**

Assert real sequential marks, `hana:start|step|pause|complete|cancel|error` detail, pause/resume/replay buttons calling methods, completed mark retention on target loss, and final shared-resource cleanup.

- [ ] **Step 2: Wire browser annotations and verify manual story GREEN**

Use the internal annotation factory plus private pause/resume controls with manual triggers and story-wide motion. Run:

```bash
npx playwright test tests/e2e/story.spec.js --project=chromium --grep "manual story|story events|story failure"
```

- [ ] **Step 3: Write failing load/viewport/fallback trigger cases**

Assert load semantics match annotation. The shared resource manager observes the first target at `0.25`; `once:true` unsubscribes after first start; `once:false` cancels on full exit and replays on re-entry; destroy unsubscribes. With no `IntersectionObserver`, viewport degrades to load and `once:false` does not invent exit/re-entry behavior.

- [ ] **Step 4: Implement resource-managed triggers and run story E2E**

Run:

```bash
npx playwright test tests/e2e/story.spec.js --project=chromium
```

Expected: all manual/load/viewport/fallback/state/event/cleanup cases pass with no controller-owned observer.

- [ ] **Step 5: Commit browser story integration**

```bash
git add src/story.js tests/fixtures/story.html tests/e2e/story.spec.js
git commit -m "feat: run stories in the browser"
```

### Task 19: Public exports and declarative scan

**Files:**
- Modify: `src/index.js`
- Modify: `playwright.config.js`
- Modify: `tests/unit/playwright-config.test.js`
- Create: `tests/unit/scan.test.js`
- Create: `tests/fixtures/scan.html`
- Create: `tests/e2e/smoke.spec.js`
- Delete: `tests/e2e/harness.spec.js`

- [ ] **Step 1: Write failing attribute parser tests**

Export internal `parseDeclarative(element)` and test every canonical attribute, boolean presence, integer duration conversion, unknown attribute ignore, and `data-hana` required mark. Use a minimal dataset-shaped fake object so Node tests remain DOM-free. The parser returns only raw converted values; it does not allocate an ID, normalize options, or validate enum membership.

- [ ] **Step 2: Implement parser and verify GREEN**

Map known attributes to a raw option object. Conversion failures such as a non-integer duration throw `HanamaruConfigError`; enum validity remains the single responsibility of `annotate()`/`normalizeOptions`. Run `node --test tests/unit/scan.test.js` and verify parser cases GREEN.

- [ ] **Step 3: Write failing browser scan tests**

In fixture mix valid/invalid `[data-hana]` siblings. Assert `scan(root)` returns `{annotations,errors}`, mounts valid nodes, skips invalid nodes, never blocks siblings, does not auto-scan on module/IIFE load, and explicit IIFE `Hanamaru.scan()` works.

- [ ] **Step 4: Implement public API exports and scan**

Export only `VERSION`, `annotate`, `story`, `scan`, and public error classes. `scan` performs `parseDeclarative(element)` then `annotate(element,raw)`, so controller creation alone allocates IDs and normalizes/validates. Catch typed per-node parse/construction errors and push the `HanamaruError` instance itself into `errors`; never catch unexpected programmer errors or wrap errors in source-element objects.

- [ ] **Step 5: Replace harness with cross-engine smoke suite**

`smoke.spec.js` verifies ESM bootstrap, one Element annotation, one text locator, lifecycle completion, and teardown. Change the Playwright web-server health URL and its unit-test expectation from the removed harness to `/demo/index.html`. Run the smoke suite in Chromium, Firefox, and WebKit.

```bash
npx playwright test tests/e2e/smoke.spec.js
```

Expected: all three configured engine projects pass the same smoke cases.

- [ ] **Step 6: Run complete Chunk 2 verification**

```bash
npm run test:unit
npm run build
npm run check:dist
npx playwright test tests/e2e/target.spec.js tests/e2e/resources.spec.js tests/e2e/renderer.spec.js tests/e2e/annotation.spec.js tests/e2e/story.spec.js --project=chromium
npx playwright test tests/e2e/smoke.spec.js
```

Expected: non-zero unit suite passes, core Chromium integration passes, all three smoke projects pass, and distribution remains under the hard budget.

- [ ] **Step 7: Commit public API**

```bash
git add src tests/unit tests/fixtures tests/e2e package.json playwright.config.js
git commit -m "feat: expose Hanamaru browser API"
```

## Chunk 3: Living Redline Demo, Adoption, and Acceptance

### Task 20: Demo foundation and design constraints

**Files:**
- Create: `demo/index.html`
- Create: `demo/demo.css`
- Create: `demo/demo.js`
- Create: `tests/e2e/demo-shell.spec.js`
- Modify: `scripts/serve.mjs`

- [ ] **Step 1: Load the Impeccable craft floor before UI edits**

The Impeccable context command already ran once in this session; do **not** rerun it. Read `/Users/ray/.agents/skills/impeccable/reference/new-work.md` and `/Users/ray/.agents/skills/impeccable/reference/craft-floor.md` completely, then inspect `DESIGN.md`, `src/hanamaru.css`, and the approved spec immediately before the first UI edit. Do not run a concept seed: the user-approved Living Redline world and first-viewport structure are already pinned in `DESIGN.md`.

- [ ] **Step 2: Write the required design-direction contract**

Begin `demo/index.html` with this five-block comment before any markup:

```html
<!--
THESIS: Hanamaru makes reliable DOM annotation visible as a living proof sheet.
OWN-WORLD: Living Redline — mineral paper, vermilion correction ink, indigo code tray.
STORY: See the mechanism → stress reflow → inspect every mark → operate the playground.
FIRST VIEWPORT: A real annotated proof and synchronized source, followed by one primary stamp.
FORM: Full-width editorial sheet; never browser chrome, floating cards, glass, or a SaaS grid.
-->
```

- [ ] **Step 3: Write failing semantic shell tests**

Test one `h1`, landmark order, skip link, real `button`/`a` controls, unique IDs, primary **Open Live Playground** link target, secondary **Copy local starter** button, public-distribution-only imports, no inert `href="#"`, and the five-block comment. Assert the local-registry disclaimer is adjacent to the starter control.

- [ ] **Step 4: Run shell tests and verify RED**

```bash
npm run build
npx playwright test tests/e2e/demo-shell.spec.js --project=chromium
```

Expected: FAIL because the demo does not exist.

- [ ] **Step 5: Implement semantic Living Redline shell**

Serve built `dist/` plus `demo/`; the demo must import only `/dist/hanamaru.esm.js` and `/dist/hanamaru.css`. Add skip link, header, proof main, section landmarks, playground target, docs footer, and live status region. Implement the approved palette/type/composition using demo-scoped classes. Do not add external fonts/assets, generic cards, fake browser chrome, gradients, glass, pills, or inert controls.

- [ ] **Step 6: Pass shell tests and commit**

Run the Step 4 commands; expect GREEN.

```bash
git add demo scripts/serve.mjs tests/e2e/demo-shell.spec.js
git commit -m "feat: establish Living Redline demo"
```

### Task 21: First-viewport proof and synchronized story

**Files:**
- Modify: `demo/index.html`
- Modify: `demo/demo.css`
- Modify: `demo/demo.js`
- Create: `tests/e2e/demo-story.spec.js`

- [ ] **Step 1: Write failing proof-mechanism tests**

Assert the first viewport contains a dominant proof sheet and recessed indigo code tray; the live story uses a selector-scoped exact-text locator without wrapper injection; a separate API specimen constructs a caller-supplied native `Range`; active story step updates `aria-current="step"` and yellow synchronization; the visible completion docket reflects controller state.

- [ ] **Step 2: Write failing real-control tests**

Exercise Play, Pause, Resume, Replay, HTML/Story/JSON tab selection, ArrowLeft/ArrowRight/Home/End tab keyboard behavior, copy success, forced Clipboard API failure, selectable fallback field, primary CTA focus/scroll to playground, and local-starter copy. Assert every visible control changes real state.

- [ ] **Step 3: Run proof/story tests and verify RED**

```bash
npx playwright test tests/e2e/demo-story.spec.js --project=chromium
```

Expected: proof mechanism and control cases fail.

- [ ] **Step 4: Implement the authored proof sequence**

Build the sequence `activate code → draw mark → draw connector → settle note → advance` using the public `story()` API and lifecycle events. Keep Play as explicit activation; do not autoplay. Tabs are an ARIA tablist of native buttons with one focusable tab, associated tabpanels, and keyboard navigation. Status changes are concise and announced only in the dedicated polite live region.

- [ ] **Step 5: Implement copy and Range proof paths**

Copy the exact local ESM starter from the spec. On copy failure reveal/focus a readonly selectable field without replacing the error context. The separate native Range action must demonstrate replacement via `update({target:nextRange})`; the locator proof must leave source prose unwrapped.

- [ ] **Step 6: Pass story tests and commit**

Run the Step 3 command; expect every real interaction GREEN.

```bash
git add demo tests/e2e/demo-story.spec.js
git commit -m "feat: prove Hanamaru in the first viewport"
```

### Task 22: Reflow challenge, specimen ledger, and reliability docket

**Files:**
- Modify: `demo/index.html`
- Modify: `demo/demo.css`
- Modify: `demo/demo.js`
- Modify: `scripts/build.mjs`
- Modify: `scripts/check-size.mjs`
- Modify: `tests/unit/build.test.js`
- Modify: `tests/unit/size.test.js`
- Create: `tests/e2e/demo-proof.spec.js`

- [ ] **Step 1: Write failing reflow and six-mark tests**

Assert the labeled range control has min 320/max 760, changes the specimen's actual width, calls refresh through the public controller, and keeps the note fully visible/connected at both extremes. Select and replay underline, highlight, circle, box, strike, and bracket; assert the selected button state and corresponding real SVG path output.

- [ ] **Step 2: Write failing API-mode and docket tests**

HTML, Story API, and JSON tabs must change real runnable definitions and update the proof result. Assert the reliability docket reads measured local gzip values from generated build metadata, states zero production dependencies, ES2020 ESM/IIFE, theming variables, triggers, fallbacks, tested engines, and explicit V1 limitations. Reject fabricated registry/install/user claims.

- [ ] **Step 3: Run proof-section tests and verify RED**

```bash
npx playwright test tests/e2e/demo-proof.spec.js --project=chromium
```

- [ ] **Step 4: Write failing persistent size-report tests**

Extend the injected temporary-root tests: `buildDistribution(root)` must leave `dist/size-report.json` containing both JS formats and CSS gzip; `checkDistribution(root)` must validate and rewrite the same deterministic schema. Then simulate two consecutive builds and assert the report still exists. Run:

```bash
node --test --test-name-pattern="size report" tests/unit/build.test.js tests/unit/size.test.js
```

Expected: FAIL because build currently produces no report.

- [ ] **Step 5: Emit size metadata from every build**

Export a pure `measureDistribution(root)` and `writeSizeReport(root,metrics)` from `scripts/check-size.mjs`. `buildDistribution` calls both after writing ESM/IIFE/CSS, so Playwright's automatic pre-server rebuild cannot delete the report. `checkDistribution` independently recomputes, enforces budgets/dependencies, and rewrites the same deterministic JSON. `size-report.json` is excluded from the public JS/CSS byte budget.

Run the Step 4 command; expected GREEN.

- [ ] **Step 6: Implement proof sections with public APIs**

The demo fetches `/dist/size-report.json` and renders measured values; failure displays **size unavailable in this local build**, never a guess. Wire the reflow ruler, six-mark ledger, and all three runnable modes to real controllers. Destroy superseded annotations/stories before replacements. Docket values and limitations must match `README.md` and the approved spec.

- [ ] **Step 7: Pass proof-section tests and commit**

```bash
npm run build
npm run check:dist
npx playwright test tests/e2e/demo-proof.spec.js --project=chromium
git add demo scripts/build.mjs scripts/check-size.mjs tests/unit/build.test.js tests/unit/size.test.js tests/e2e/demo-proof.spec.js
git commit -m "feat: expose Hanamaru reliability proofs"
```

### Task 23: Operable live playground

**Files:**
- Modify: `demo/index.html`
- Modify: `demo/demo.css`
- Modify: `demo/demo.js`
- Create: `tests/e2e/playground.spec.js`

- [ ] **Step 1: Write failing playground behavior tests**

From existing specimen text, select target, mark, optional note, placement, and trigger; run an annotation; assert the public runtime creates the requested result. Change each control and verify output/code changes. Re-running destroys the prior controller. Copy emits the corresponding declarative HTML or imperative JavaScript. Manual/load/viewport definitions are truthful and executable.

- [ ] **Step 2: Write failing keyboard and status tests**

Tab through every control in visual order, operate native selects/radios/buttons from keyboard, verify a visible `:focus-visible` indicator, confirm validation errors are associated and focused, and assert run/copied/error states appear in the status docket without color-only meaning.

- [ ] **Step 3: Run playground tests and verify RED**

```bash
npx playwright test tests/e2e/playground.spec.js --project=chromium
```

- [ ] **Step 4: Implement the constrained playground**

Use semantic `fieldset`, `legend`, `label`, native form controls, real specimen targets, and public `annotate()`/`scan()` only. Keep touch targets at least 44px where practical. V1 must not add arbitrary editing, drag positioning, cloud persistence, framework wrappers, or fake publish actions.

- [ ] **Step 5: Pass playground tests and commit**

Run the Step 3 command; expect behavior, code, cleanup, keyboard, focus, and status cases GREEN.

```bash
git add demo tests/e2e/playground.spec.js
git commit -m "feat: add the Hanamaru live playground"
```

### Task 24: Responsive, accessibility, and motion acceptance

**Files:**
- Modify: `demo/demo.css`
- Modify: `demo/demo.js`
- Create: `tests/e2e/accessibility.spec.js`
- Create: `tests/e2e/responsive.spec.js`

- [ ] **Step 1: Write failing axe and contrast tests**

Use `@axe-core/playwright` to scan default, playing, complete, playground, and mobile states for WCAG 2 A/AA with zero serious or critical violations. Add explicit computed-color contrast assertions of at least 4.5:1 for body/supporting text and 3:1 for large text/control boundaries in normal, hover, focus, selected, disabled, and status states.

- [ ] **Step 2: Write failing 390px and browser page-scale tests**

At 390x844 assert `document.documentElement.scrollWidth <= clientWidth`, proof/code stack, code scrolls inside its labeled region, all controls remain reachable, and every note remains fully visible rather than hidden. For the automated 200% case, open a Chromium CDP session and call exactly:

```js
await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 })
```

Assert `visualViewport.scale === 2`, no essential control/content loss, a wrapped note remains clamped inside the visual viewport, and code/controls remain usable. Reset with `Emulation.resetPageScaleFactor`. This uses the browser's page-scale mechanism, never CSS `zoom` or a transformed fixture. Task 25 separately verifies Chrome's visible 200% browser-zoom UI with Computer Use.

- [ ] **Step 3: Write failing reduced-motion and focus tests**

With `reducedMotion:'reduce'`, assert final marks/connector/note appear without interpolated animation, lifecycle events/state remain identical, and controls remain useful. Assert skip link, tablist, story controls, ruler, ledger, playground, copy fallback, and error recovery have visible focus and logical order.

- [ ] **Step 4: Run acceptance tests and verify RED**

```bash
npx playwright test tests/e2e/accessibility.spec.js tests/e2e/responsive.spec.js --project=chromium
```

- [ ] **Step 5: Implement responsive and accessible polish**

At 900px stack proof/code; at 390px remove page overflow without hiding notes. Provide logical properties, robust wrapping, internal code scrolling, 44px practical targets, `:focus-visible`, non-color state labels, and reduced-motion rules. Preserve the approved paper/ink/indigo hierarchy; do not solve layout by shrinking text below the design minimums.

- [ ] **Step 6: Pass acceptance tests and commit**

Run the Step 4 command; expect all axe, contrast, mobile, zoom, reduced-motion, focus, and note-visibility assertions GREEN.

```bash
git add demo tests/e2e/accessibility.spec.js tests/e2e/responsive.spec.js
git commit -m "fix: harden demo accessibility and reflow"
```

### Task 25: Documentation, fixed verification loop, and visual sign-off

**Files:**
- Create: `README.md`
- Create: `docs/assets/hanamaru-demo.png`
- Modify: `package.json`
- Modify: `playwright.config.js`
- Create: `tests/e2e/docs.spec.js`
- Create: `outputs/acceptance/` screenshots and state excerpts

- [ ] **Step 1: Write failing documentation/adoption tests**

Assert README anchors for Quick Start, API, Accessibility, Browser Support, Fallbacks, and Limitations; validate copied local bootstrap against the public ESM build; verify all README API names exist; and ensure support copy names only Chromium, Firefox, and WebKit projects actually exercised by the suite.

- [ ] **Step 2: Write accurate OSS documentation**

Document the two-layer declarative/imperative API, Element/selector/Range/text-locator targets, lifecycle/events, Story API, CSS variables, accessibility semantics, fallbacks, explicit refresh caveat for CSS-only movement, native Range replacement contract, size methodology, and V1 exclusions. Say **local build** wherever registry publication would otherwise be implied. Add MIT license and contribution/test commands, but do not add a screenshot reference yet.

- [ ] **Step 3: Pass docs and full fixed verification**

Run:

```bash
npx playwright test tests/e2e/docs.spec.js --project=chromium
npm run verify
```

Expected: documentation assertions pass and the fixed command completes unit tests, build, size enforcement, full Chromium E2E, and three-engine smoke with no zero-test stage.

- [ ] **Step 4: Run one exact Impeccable detector and independent review**

Start a persistent server with `npm run build && npm run check:dist && npm run dev` using `exec_command` in a PTY and retain its `session_id`. After the URL answers, run the detector exactly once:

```bash
node /Users/ray/.agents/skills/impeccable/scripts/detect.mjs --viewport 1440x900 http://127.0.0.1:4173/demo/index.html
```

Then spawn one separate design-review agent with the original request, chosen 1A/2A/3A decisions, `PRODUCT.md`, `DESIGN.md`, the five-block contract, demo URL, and detector output. Ask only for a short evidence-backed list of promise gaps; do not run a second detector. Apply valid fixes, run affected tests, then stop the server with `write_stdin(session_id,"\u0003")`.

- [ ] **Step 5: Run the mixed functional/visual Codex Loop**

Use the declared maximum of five rounds. Every round performs this unchanged acceptance sequence:

1. Run `npm run verify`; any nonzero exit makes the round `Incorrect`.
2. Start `npm run build && npm run check:dist && npm run dev` in a PTY, retain its `session_id`, and wait until `http://127.0.0.1:4173/demo/index.html` responds.
3. With Computer Use in Google Chrome, execute the complete matrix in Step 6 and update the exact evidence files.
4. Stop the server with `write_stdin(session_id,"\u0003")`.
5. Verdict is `Correct` only when both the fixed command exits zero **and** every visual state passes. A visual failure is `Incorrect`: apply the smallest root-cause fix, then rerun the entire sequence, including Computer Use. Never weaken/skip/quarantine/rename tests.

- [ ] **Step 6: Verify appearance with Computer Use**

Following the `computer-use:computer-use` skill, open the local built demo in Google Chrome and inspect these exact states:

- 1440x900 light/default motion: first viewport, playing and complete story, synchronized code, primary CTA, ruler at 760 and 320, six-mark ledger;
- 390x844 light: stacked proof/code, no page overflow, fully visible re-placed note, internal code scroll, readable controls/focus;
- desktop at real Chrome 200% zoom: focus Chrome, press `Command+0`, then `Command++` until Chrome's visible zoom indicator reads `200%`; inspect reachable controls, wrapping/clamping, and missing content; reset with `Command+0` afterward;
- reduced motion: immediate final mark/connector/note and usable lifecycle controls.

Save these exact screenshots under `outputs/acceptance/`: `desktop-default.png`, `desktop-playing.png`, `desktop-complete.png`, `desktop-reflow-760.png`, `desktop-reflow-320.png`, `mobile-390.png`, `zoom-200.png`, and `reduced-motion.png`. Write the inspected control names/states, focus target, note bounds, overflow result, zoom indicator, and relevant accessibility-tree excerpt to `outputs/acceptance/state-excerpts.md`. If Computer Use is unavailable, the round is `Incorrect` and final status is blocked rather than visually complete.

- [ ] **Step 7: Add the accepted README image, then final verification**

After a `Correct` round, copy `outputs/acceptance/desktop-default.png` to `docs/assets/hanamaru-demo.png`. Add exactly this image immediately below the README title:

```md
![Hanamaru Living Redline demo](docs/assets/hanamaru-demo.png)
```

Extend `tests/e2e/docs.spec.js` to fail if the image/reference is absent, then run the docs test and `npm run verify` once more. Inspect `git status --short` and confirm evidence contains no secrets or transient absolute URLs. README/image changes do not alter the rendered demo; if any code/CSS/demo file changed after the last `Correct` round, rerun the full mixed loop instead of relying on this final functional pass.

```bash
git add README.md docs/assets/hanamaru-demo.png package.json playwright.config.js tests/e2e/docs.spec.js demo src scripts
git commit -m "docs: ship the Hanamaru OSS showcase"
```

Expected final evidence: unchanged `npm run verify` exit 0; hard bundle budget pass; three-engine smoke pass; axe/contrast/responsive/reduced-motion pass; independent Impeccable review resolved; Computer Use desktop/mobile/zoom/reduced-motion captures present.
