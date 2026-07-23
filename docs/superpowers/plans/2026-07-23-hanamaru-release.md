# Hanamaru Public Release Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package, verify, document, and publicly release Hanamaru 0.1.0 to `Ray0907/hanamaru`, GitHub Releases, and npm as `hanamaru-annotations`.

**Architecture:** All optional ESM entries build in one splitting-enabled graph around the shared singleton; the existing main IIFE remains self-contained. CI creates a digest-pinned tarball, the tag workflow re-verifies the tagged commit without publish credentials, and the exact artifact is manually published only after GitHub verification succeeds.

**Tech Stack:** esbuild, Node.js 24.13.0, npm, GitHub Actions/CLI, TypeScript declaration fixtures, Playwright.

**Required skills during execution:** `@superpowers:test-driven-development`, `@codex-loop-engineering`, `@github:yeet` only if its reviewed publication workflow matches the approved direct-release sequence, and `@superpowers:verification-before-completion`.

**Design authority:** `docs/superpowers/specs/2026-07-23-hanamaru-release-program-design.md` and all seven linked subsystem specs.

---

## File Map

| Path | Responsibility |
|---|---|
| `src/entries/*.js` | Explicit optional ESM subpath entry points; main stays exactly eight exports. |
| `types/**/index.d.ts` | Main and optional declarations already mirroring emitted directory shape. |
| `scripts/build.mjs` | One split ESM graph, one IIFE, two CSS outputs, declarations copied. |
| `scripts/check-dist.mjs` | Ordered production-dependency, export, dry-pack, and size checks. |
| `scripts/check-size.mjs` | Main closure and each optional closure gzip budgets. |
| `scripts/check-exports.mjs` | Export/import/type/tarball closure and singleton checks. |
| `scripts/check-release-tag.mjs` | Dependency-free exact SemVer/tag/package validator. |
| `scripts/verify-pack.mjs` | Tarball allowlist, install/import, digest, zero-production-deps checks. |
| `package.json` | Complete metadata, exports, peers, files, side effects, scripts. |
| `.github/workflows/ci.yml` | Read-only push/PR verification and main artifact production. |
| `.github/workflows/release.yml` | Read-only tag verification and exact tarball artifact. |
| `README.md` | Install, five-second examples, APIs, limits, CSP/a11y, framework recipes. |
| `CHANGELOG.md` | 0.1.0 feature/reliability/release notes. |
| `docs/releases/v0.1.0.md` | Exact GitHub Release notes with install/features/size/verification sections. |
| `docs/assets/hanamaru-inspector.png` | Final five-second Inspector hero capture used by README. |

## Chunk 1: Distribution and Type Contracts

### Task 1: Add explicit entries, declarations, and package exports

**Files:**
- Create: `src/entries/selection.js`
- Create: `src/entries/group.js`
- Create: `src/entries/plugins.js`
- Create: `src/entries/serialize.js`
- Create: `src/entries/shadow.js`
- Create: `src/entries/react.js`
- Create: `src/entries/vue.js`
- Create: `src/entries/svelte.js`
- Create: `types/index.d.ts`
- Create: `types/selection/index.d.ts`
- Create: `types/group/index.d.ts`
- Create: `types/plugins/index.d.ts`
- Create: `types/serialize/index.d.ts`
- Create: `types/shadow/index.d.ts`
- Modify: `types/react/index.d.ts`
- Modify: `types/vue/index.d.ts`
- Modify: `types/svelte/index.d.ts`
- Modify: `src/index.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tests/unit/package-exports.test.js`
- Create: `tests/types/main.ts`
- Create: `tests/types/selection.ts`
- Create: `tests/types/group.ts`
- Create: `tests/types/plugins.ts`
- Create: `tests/types/serialize.ts`
- Create: `tests/types/shadow.ts`
- Create: `tests/types/adapters.tsx`
- Create: `tests/types/check.mjs`

- [ ] **Step 1: Write failing package/export/type tests**

Assert source entries expose exactly the approved names and package metadata declares the normative export targets; do not import absent `dist` files in this pre-build unit phase. The main source has exactly `VERSION`, `annotate`, `scan`, `story`, `HanamaruError`, `HanamaruConfigError`, `HanamaruTargetError`, and `HanamaruStateError`. Optional sources are selection=`annotateSelection`; group=`group`; plugins=`registerMark`; serialize=`serialize,restore,resolveSerializedTarget`; shadow=`createShadowScope`; frameworks=`useAnnotation` or `annotation`. Assert CSS/package JSON target strings, server-safe source imports, optional peers, and `HanamaruMarkMap` augmentation. Actual built-entry imports belong exclusively to Task 2 `scripts/check-exports.mjs`, after build.

- [ ] **Step 2: Run RED**

Run separately:

```bash
node --test tests/unit/package-exports.test.js
node tests/types/check.mjs
```

Expected: source-entry test fails for missing `src/entries/selection.js` and type runner fails for missing declarations; no test reads `dist`.

- [ ] **Step 3: Add thin source entries**

Each entry only re-exports the exact names in Step 1. Keep optional APIs out of `src/index.js` and IIFE. Run `node --test --test-name-pattern="source entry" tests/unit/package-exports.test.js`; source-entry assertions pass and there are no pre-build built-export assertions.

- [ ] **Step 4: Author exact runtime declarations**

`types/index.d.ts` declares the eight exports, literal controller states/options/targets, four error classes, and named augmentable `HanamaruMarkMap` with the six built-ins. Every optional declaration is already at `types/<subpath>/index.d.ts`, imports shared public types from `../index.d.ts`, and exactly models its approved signature/unions/context/facade. The build copies this tree without path rewriting.

- [ ] **Step 5: Install and run the declaration harness**

Add TypeScript `5.9.2`, React `19.2.8`, React DOM `19.2.8`, `@types/react@19.2.17`, `@types/react-dom@19.2.3`, Vue `3.5.40`, and Svelte `5.56.7` to devDependencies (peers remain optional production peers) and update the lockfile. `tests/types/check.mjs` invokes local `tsc --noEmit --strict --moduleResolution bundler --module esnext --target es2020` for each named fixture, adds `--jsx react-jsx` for `tests/types/adapters.tsx`, and rejects zero fixtures. Run `node tests/types/check.mjs`.

Expected: all documented imports and positive/`@ts-expect-error` negative cases pass.

- [ ] **Step 6: Update package metadata exactly**

Set `repository.url=https://github.com/Ray0907/hanamaru.git`, `homepage=https://github.com/Ray0907/hanamaru#readme`, `bugs.url=https://github.com/Ray0907/hanamaru/issues`, relevant annotation/SVG/accessibility keywords, `types=./dist/index.d.ts`, the exact conditional export map from the release spec, `files=["dist","README.md","LICENSE"]`, and exact `sideEffects=["./dist/hanamaru.css","./dist/shadow/hanamaru-shadow.css"]`. Add peer ranges React `>=18.2.0 <20`, Vue `>=3.5.0 <4`, Svelte `>=5.0.0 <6` and mark each optional in `peerDependenciesMeta`. Keep no `dependencies` key.

- [ ] **Step 7: Define the exact ordered verification scripts**

Add:

```json
{
  "test:types": "node tests/types/check.mjs",
  "test:e2e:chromium": "playwright test --project=chromium",
  "test:e2e:smoke": "playwright test tests/e2e/smoke.spec.js tests/e2e/shadow-smoke.spec.js --project=firefox --project=webkit",
  "test:adapters": "node tests/framework/run-endpoints.mjs all",
  "verify": "npm run test:unit && npm run test:types && npm run build && npm run check:dist && npm run test:e2e:chromium && npm run test:e2e:smoke && npm run test:adapters"
}
```

Set `"check:dist": "node scripts/check-dist.mjs"`. That script imports and awaits `assertNoProductionDependencies()`, `checkBuiltExports()`, `checkDryPackShape()`, and `checkDistributionSize()` in exactly that order. Framework peers are installed as devDependencies, so Node built-entry import checks resolve them without affecting `npm ls --omit=dev`. A zero-test guard exists in every test runner.

- [ ] **Step 8: Run export/type/script contract tests**

Run:

```bash
node --test --test-name-pattern="source entry|metadata|peer" tests/unit/package-exports.test.js
node tests/types/check.mjs
```

Expected: source entries, metadata/peer declarations, and all type fixtures pass; built-export assertions intentionally remain deferred until Task 2.

- [ ] **Step 9: Commit entries and type source**

```bash
git add src/entries src/index.js types package.json package-lock.json tests/unit/package-exports.test.js tests/types
git commit -m "feat: define modular package and type contracts"
```

### Task 2: Build one shared ESM graph and enforce closure budgets

**Files:**
- Modify: `scripts/build.mjs`
- Modify: `scripts/check-size.mjs`
- Create: `scripts/check-dist.mjs`
- Create: `scripts/check-exports.mjs`
- Modify: `tests/unit/build.test.js`
- Modify: `tests/unit/size.test.js`
- Create: `tests/unit/singleton.test.js`

- [ ] **Step 1: Write failing graph/closure tests**

Assert `dist` matches the normative tree, every ESM entry points to one emitted singleton chunk, importing main plus any subpath shares plugin registration/metadata/resources, IIFE is self-contained, main ESM+CSS and IIFE+CSS are each ≤20,480 gzip bytes, and each optional closure meets its exact spec budget.

- [ ] **Step 2: Run graph tests and verify RED**

Run `node --test tests/unit/build.test.js tests/unit/singleton.test.js`.

Expected: normative-tree and shared-singleton assertions fail against the current three-file build.

- [ ] **Step 3: Implement one splitting-enabled ESM build**

Call esbuild once with all ESM entry points, `bundle:true`, `splitting:true`, `format:"esm"`, deterministic entry/chunk names, and the shared `runtime-state.js`. Build IIFE from main only and both CSS files separately. Remove only the project `dist` path.

- [ ] **Step 4: Run graph/singleton tests and verify GREEN**

Run the Step 2 command.

Expected: all tree, import-resolution, IIFE-isolation, and cross-subpath singleton tests pass.

- [ ] **Step 5: Write failing exact closure-accounting tests**

For synthetic import graphs, assert main transitive chunks counted once; optional entry charges only chunks not in main; a shared optional chunk charged fully to both; framework bare imports charge zero; Shadow adds independent CSS gzip; and report records entry/charged files/raw/member gzip/sum.

- [ ] **Step 6: Run size tests and verify RED**

Run `node --test tests/unit/size.test.js`.

Expected: optional closure/report assertions fail against the current two-format calculator.

- [ ] **Step 7: Measure transitive closures, not individual files**

Parse emitted ESM imports recursively, deduplicate chunks within each entry closure, add the applicable CSS gzip bytes, enforce hard caps, and emit a deterministic schema-versioned size report.

- [ ] **Step 8: Integrate `check-exports` and run full distribution tests**

`scripts/check-exports.mjs` imports every built entry in Node with installed dev peers, validates exact names, checks every relative chunk exists, and checks declaration counterparts. `scripts/check-dist.mjs` runs production-dependency check, built export check, dry-pack JSON allowlist check, then size check.

Run `npm run build && node --test tests/unit/build.test.js tests/unit/size.test.js tests/unit/singleton.test.js && npm run check:dist`.

Expected: all artifacts and hard budgets pass; stretch misses may be reported but do not fail.

- [ ] **Step 9: Commit distribution graph/accounting**

```bash
git add scripts/build.mjs scripts/check-size.mjs scripts/check-exports.mjs scripts/check-dist.mjs tests/unit/build.test.js tests/unit/size.test.js tests/unit/singleton.test.js package.json package-lock.json
git commit -m "build: emit shared modular distribution"
```

## Chunk 2: Pack, CI, Documentation, and Publication

### Task 3: Make the tarball independently verifiable

**Files:**
- Create: `scripts/check-release-tag.mjs`
- Create: `scripts/verify-pack.mjs`
- Create: `tests/unit/release-tag.test.js`
- Create: `tests/unit/pack.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing tag and tarball tests**

Cover valid SemVer 2.0.0, malformed, normalized-but-different, mismatched package version, and exact tarball allowlist: mandatory `package.json`, any `dist/**` file in the normative build tree, `README.md`, and `LICENSE`; nothing else. Cover install in an empty temp project, all JS/CSS/package exports, no source/tests/secrets/CHANGELOG, zero production dependency tree, and SHA-512 output.

- [ ] **Step 2: Run release utility tests and verify RED**

Run `node --test tests/unit/release-tag.test.js tests/unit/pack.test.js`.

Expected: FAIL for missing scripts.

- [ ] **Step 3: Implement dependency-free tag validation**

Read `GITHUB_REF_NAME` or explicit CLI arg, parse package JSON, validate both strings using an in-script SemVer 2.0.0 regular expression, and require exact `v${version}` equality. Do not import npm packages.

- [ ] **Step 4: Implement pack verification**

`verifyPack(root, outputDirectory)` requires an explicit directory outside the worktree and runs `npm pack --json --pack-destination <outputDirectory>` exactly once. Parse filename/file list/integrity, verify allowlist/digest, write `sha512.txt` beside the tarball, install that `.tgz` into a second temporary project, import every entry with verification peers installed, read both CSS exports, and run `npm ls --omit=dev --json`. Cleanup removes only internally created install directories; the caller owns the artifact directory.

- [ ] **Step 5: Run pack verification**

Run:

```bash
npm run build
npm pack --dry-run --json
status_before_pack="$(git status --porcelain)"
pack_dir="$(mktemp -d)"
node scripts/verify-pack.mjs "$pack_dir"
test -f "$pack_dir/hanamaru-annotations-0.1.0.tgz"
test -f "$pack_dir/sha512.txt"
test "$(git status --porcelain)" = "$status_before_pack"
test -z "$(find . -maxdepth 1 -type f \\( -name '*.tgz' -o -name 'sha512.txt' \\) -print -quit)"
```

Expected: one verified `hanamaru-annotations-0.1.0.tgz` and printed SHA-512.

- [ ] **Step 6: Commit release utilities**

```bash
git add scripts/check-release-tag.mjs scripts/verify-pack.mjs tests/unit/release-tag.test.js tests/unit/pack.test.js package.json package-lock.json
git commit -m "build: verify release tags and tarballs"
```

### Task 4: Add least-privilege CI and release workflows

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `tests/unit/workflows.test.js`

- [ ] **Step 1: Write workflow contract tests**

Parse workflow text and assert pinned major action versions, `contents: read`, no write permission/token/id-token/npm config, checkout `persist-credentials:false`, tag validator before install, lockfile install, full verify, exactly one pack, digest plus `.tgz` artifact, and main-only CI artifact.

- [ ] **Step 2: Run workflow tests and verify RED**

Run `node --test tests/unit/workflows.test.js`.

Expected: FAIL because workflow files are absent.

- [ ] **Step 3: Implement workflows**

Use `actions/checkout@v4`, `actions/setup-node@v4`, and `actions/upload-artifact@v4`. CI runs on push/PR with `permissions: { contents: read }`, installs Node 24.13.0 and Playwright engines, runs `npm ci` then the exact seven-stage `npm run verify`; main additionally runs `node scripts/verify-pack.mjs "$RUNNER_TEMP/hanamaru-pack"` and uploads artifact `hanamaru-main-${{ github.sha }}` from that temp directory. Release runs on `v*`, checks out `persist-credentials:false`, runs `node scripts/check-release-tag.mjs` before `npm ci`, repeats verify, creates/verifies one tarball under `$RUNNER_TEMP/hanamaru-pack`, uploads `hanamaru-${{ github.ref_name }}` and digest, and has no publish/write token.

- [ ] **Step 4: Run workflow tests**

Run `node --test tests/unit/workflows.test.js tests/unit/release-tag.test.js tests/unit/pack.test.js`.

Expected: all least-privilege/order/artifact tests pass.

- [ ] **Step 5: Commit workflows**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml tests/unit/workflows.test.js
git commit -m "ci: verify exact Hanamaru release artifacts"
```

### Task 5: Finish public documentation and release evidence

**Files:**
- Modify: `README.md`
- Create: `CHANGELOG.md`
- Create: `docs/releases/v0.1.0.md`
- Create: `docs/assets/hanamaru-inspector.png`
- Modify: `DESIGN.md`
- Modify: `PRODUCT.md`
- Modify: `demo/index.html`
- Modify: `tests/e2e/docs.spec.js`

- [ ] **Step 1: Write failing docs-link/example tests**

Assert install name, CDN and ESM examples, all optional subpaths, main eight exports, Selection/Group/plugins/serialization/Shadow/framework recipes, trigger limits, exact browser support, CSP modes, accessibility semantics, reduced motion, bundle budgets, and links to demo/repository/license/changelog.

- [ ] **Step 2: Run docs tests and verify RED**

Run `npx playwright test tests/e2e/docs.spec.js --project=chromium`.

Expected: missing optional API/release-note assertions fail.

- [ ] **Step 3: Capture the final Inspector hero**

At 1280×900 in real Chrome, execute the five-second selection→flower-mark→Apply path and save the sharp PNG to `docs/assets/hanamaru-inspector.png`. Verify selected text, mark toolbar, visible annotation, and JSON/JS rail are readable with no debug UI or personal data.

- [ ] **Step 4: Update documentation without unsupported claims**

Lead README with `docs/assets/hanamaru-inspector.png` and the zero-dependency value proposition. Document exact failure behavior and unsupported cross-root/deep traversal constraints. Add complete 0.1.0 changelog.

- [ ] **Step 5: Prepare exact GitHub release notes**

Create `docs/releases/v0.1.0.md` with headings `Install`, `Features`, `Size`, and `Verification`; include `npm install hanamaru-annotations@0.1.0`, all six feature families/adapters/Inspector, measured closure bytes copied from final size report, local/CI/browser/Computer Use evidence summary, and links to changelog/license.

- [ ] **Step 6: Run docs tests and commit release readiness**

```bash
npx playwright test tests/e2e/docs.spec.js --project=chromium
git add README.md CHANGELOG.md DESIGN.md PRODUCT.md docs/releases/v0.1.0.md docs/assets/hanamaru-inspector.png demo/index.html tests/e2e/docs.spec.js
git commit -m "docs: prepare Hanamaru 0.1.0 release"
```

Expected: docs tests pass and the commit contains no package tarball.

- [ ] **Step 7: Run the final clean-commit release gate**

```bash
npm run verify
npm pack --dry-run --json
release_gate_pack_dir="$(mktemp -d)"
node scripts/verify-pack.mjs "$release_gate_pack_dir"
git diff --check
test -z "$(git status --porcelain)"
git rev-parse HEAD
```

Then run authoritative Computer Use against that exact HEAD for desktop closed/idle/selected/editing/applied, 390px states, keyboard, reduced motion, bounds, accessibility tree, and overflow. Save evidence and record loop verdict `Correct`.

Expected: all seven ordered verify stages, dry pack, exact pack verifier, diff/worktree checks, and Computer Use pass on one printed SHA with no post-verification edit.

### Task 6: Publish the verified 0.1.0 artifacts

**Files:**
- No source edits after the verified release commit.

- [ ] **Step 1: Create the public GitHub repository and push**

Capture `verified_sha="$(git rev-parse HEAD)"`, require a clean worktree, then run:

```bash
gh repo create Ray0907/hanamaru --public --description "Human, reliable annotations for the DOM"
git remote add origin https://github.com/Ray0907/hanamaru.git
git push origin "${verified_sha}:refs/heads/main"
gh repo edit Ray0907/hanamaru --default-branch main
test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$verified_sha"
```

Expected: public repository exists, default branch is main, and remote main equals the verified SHA.

- [ ] **Step 2: Verify main CI before tagging**

Recapture/revalidate the SHA and poll at most two minutes for the exact run:

```bash
verified_sha="$(git rev-parse HEAD)"
test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$verified_sha"
main_run_id=""
for attempt in {1..24}; do
  main_run_id="$(gh run list --repo Ray0907/hanamaru --workflow ci.yml --branch main --commit "$verified_sha" --json databaseId -q '.[0].databaseId')"
  test -n "$main_run_id" && break
  sleep 5
done
test -n "$main_run_id"
gh run watch "$main_run_id" --repo Ray0907/hanamaru --exit-status
test "$(gh run view "$main_run_id" --repo Ray0907/hanamaru --json headSha -q .headSha)" = "$verified_sha"
gh api "repos/Ray0907/hanamaru/actions/runs/$main_run_id/artifacts" --jq '.artifacts[].name' | grep -Fx "hanamaru-main-$verified_sha"
```

Expected: the main CI run succeeds and its tarball/digest artifact is present.

- [ ] **Step 3: Create and push the exact tag**

Recapture the SHA and verify remote main before tagging:

```bash
verified_sha="$(git rev-parse HEAD)"
test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$verified_sha"
git tag -a v0.1.0 "$verified_sha" -m "Hanamaru 0.1.0"
git push origin v0.1.0
test "$(git rev-list -n1 v0.1.0)" = "$verified_sha"
test "$(git ls-remote origin refs/tags/v0.1.0^{} | cut -f1)" = "$verified_sha"
```

Expected: the read-only release workflow succeeds and produces the exact verified `.tgz` plus digest.

- [ ] **Step 4: Publish the exact tag-workflow artifact to npm**

Recapture the SHA, poll at most two minutes for its tag workflow, and keep all paths absolute:

```bash
repo_dir="$(git rev-parse --show-toplevel)"
verified_sha="$(git rev-parse HEAD)"
test "$(git rev-list -n1 v0.1.0)" = "$verified_sha"
release_run_id=""
for attempt in {1..24}; do
  release_run_id="$(gh run list --repo Ray0907/hanamaru --workflow release.yml --commit "$verified_sha" --json databaseId -q '.[0].databaseId')"
  test -n "$release_run_id" && break
  sleep 5
done
test -n "$release_run_id"
gh run watch "$release_run_id" --repo Ray0907/hanamaru --exit-status
test "$(gh run view "$release_run_id" --repo Ray0907/hanamaru --json headSha -q .headSha)" = "$verified_sha"
artifact_dir="$(mktemp -d)"
gh run download "$release_run_id" --repo Ray0907/hanamaru --name hanamaru-v0.1.0 --dir "$artifact_dir"
test "$(find "$artifact_dir" -maxdepth 1 -type f -name '*.tgz' | wc -l | tr -d ' ')" = 1
test -f "$artifact_dir/hanamaru-annotations-0.1.0.tgz"
(cd "$artifact_dir" && shasum -a 512 -c sha512.txt)
npm publish "$artifact_dir/hanamaru-annotations-0.1.0.tgz" --access public
test "$(npm view hanamaru-annotations@0.1.0 version)" = "0.1.0"
published_integrity="$(npm view hanamaru-annotations@0.1.0 dist.integrity)"
artifact_integrity="sha512-$(openssl dgst -sha512 -binary "$artifact_dir/hanamaru-annotations-0.1.0.tgz" | openssl base64 -A)"
test "$published_integrity" = "$artifact_integrity"
```

If npm requires login or 2FA, pause only for that user credential interaction; never store credentials in repo/logs.

Expected: `npm view hanamaru-annotations@0.1.0 version dist.integrity` reports `0.1.0` and the matching integrity.

- [ ] **Step 5: Create the GitHub release from the same artifact**

Recapture the release run and download the verified artifact again, so this step does not depend on a prior shell:

```bash
repo_dir="$(git rev-parse --show-toplevel)"
verified_sha="$(git rev-parse HEAD)"
release_run_id="$(gh run list --repo Ray0907/hanamaru --workflow release.yml --commit "$verified_sha" --json databaseId -q '.[0].databaseId')"
release_asset_dir="$(mktemp -d)"
gh run download "$release_run_id" --repo Ray0907/hanamaru --name hanamaru-v0.1.0 --dir "$release_asset_dir"
(cd "$release_asset_dir" && shasum -a 512 -c sha512.txt)
published_integrity="$(npm view hanamaru-annotations@0.1.0 dist.integrity)"
release_asset_integrity="sha512-$(openssl dgst -sha512 -binary "$release_asset_dir/hanamaru-annotations-0.1.0.tgz" | openssl base64 -A)"
test "$published_integrity" = "$release_asset_integrity"
gh release create v0.1.0 "$release_asset_dir/hanamaru-annotations-0.1.0.tgz" "$release_asset_dir/sha512.txt" --repo Ray0907/hanamaru --title "Hanamaru 0.1.0" --notes-file "$repo_dir/docs/releases/v0.1.0.md" --verify-tag
```

Expected: the public release attaches the exact npm tarball and digest.

- [ ] **Step 6: Perform clean-room post-publication verification**

Create the temporary project first:

```bash
release_smoke_dir="$(mktemp -d)"
cd "$release_smoke_dir"
npm init -y
```

Then create these exact files with `apply_patch` inside that directory:

```js
// smoke-entry.js
import { annotate } from 'hanamaru-annotations'
import { registerMark } from 'hanamaru-annotations/plugins'

window.runHanamaruSmoke = async () => {
  const unregister = registerMark('smoke-mark', ({ rects, helpers }) => ({
    paths: [helpers.line(
      { x: rects[0].left, y: rects[0].bottom },
      { x: rects[0].right, y: rects[0].bottom },
    )],
  }))
  const core = annotate('#core', { mark: 'underline', motion: 'never' })
  const plugin = annotate('#plugin', { mark: 'smoke-mark', motion: 'never' })
  core.show()
  plugin.show()
  await Promise.all([core.finished, plugin.finished])
  window.cleanupHanamaruSmoke = () => {
    plugin.destroy()
    core.destroy()
    unregister()
  }
  return [core.state, plugin.state]
}
```

```js
// public-smoke.spec.js
import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import path from 'node:path'
const require = createRequire(import.meta.url)

test('published core and plugin render and clean up', async ({ page }) => {
  await page.setContent('<span id="core">Core</span><span id="plugin">Plugin</span>')
  await page.addStyleTag({ path: require.resolve('hanamaru-annotations/style.css') })
  await page.addScriptTag({ path: path.resolve('smoke-bundle.js') })
  expect(await page.evaluate(() => window.runHanamaruSmoke())).toEqual(['visible', 'visible'])
  await expect(page.locator('.hana-annotation')).toHaveCount(2)
  await expect(page.locator('.hana-mark-path')).toHaveCount(2)
  await page.evaluate(() => window.cleanupHanamaruSmoke())
  await expect(page.locator('.hana-annotation')).toHaveCount(0)
})
```

```js
// playwright.config.js
export default {
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
}
```

Then run the remaining installation and verification commands in that same directory:

```bash
npm install hanamaru-annotations@0.1.0 @playwright/test@1.55.0 esbuild@0.25.0 react@19.2.8 vue@3.5.40 svelte@5.56.7
npx playwright install chromium
node --input-type=module -e "await Promise.all(['hanamaru-annotations','hanamaru-annotations/selection','hanamaru-annotations/serialize','hanamaru-annotations/group','hanamaru-annotations/plugins','hanamaru-annotations/shadow','hanamaru-annotations/react','hanamaru-annotations/vue','hanamaru-annotations/svelte'].map(x=>import(x))); console.log('imports: pass')"
node --input-type=module -e "import {createRequire} from 'node:module'; const r=createRequire(import.meta.url); for (const x of ['hanamaru-annotations/style.css','hanamaru-annotations/shadow/style.css','hanamaru-annotations/package.json']) console.log(r.resolve(x))"
npx esbuild smoke-entry.js --bundle --format=iife --platform=browser --outfile=smoke-bundle.js
npx playwright test public-smoke.spec.js --project=chromium
npm_integrity="$(npm view hanamaru-annotations@0.1.0 dist.integrity)"
gh release download v0.1.0 --repo Ray0907/hanamaru --pattern 'hanamaru-annotations-0.1.0.tgz' --dir "$release_smoke_dir/github"
github_integrity="sha512-$(openssl dgst -sha512 -binary "$release_smoke_dir/github/hanamaru-annotations-0.1.0.tgz" | openssl base64 -A)"
test "$npm_integrity" = "$github_integrity"
cd /
node -e "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true})" "$release_smoke_dir"
```

Expected: all public endpoints work and all three digests match.
