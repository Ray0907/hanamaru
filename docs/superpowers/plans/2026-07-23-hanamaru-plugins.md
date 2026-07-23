# Hanamaru SVG Mark Plugins Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let applications register deterministic SVG-path-only marks without exposing renderer DOM or weakening built-in mark validation.

**Architecture:** One package-private module-local singleton owns the mark registry and controller metadata channel. Geometry dispatches built-ins directly and invokes registered builders with frozen numeric primitives, then validates returned path strings before renderer use.

**Tech Stack:** Vanilla ES2020 JavaScript, SVG path data, FNV-1a deterministic jitter, `node:test`, Playwright.

**Required skills during execution:** `@superpowers:test-driven-development`, `@codex-loop-engineering`.

**Design authority:** `docs/superpowers/specs/2026-07-23-hanamaru-plugins-design.md` and the singleton contract in `docs/superpowers/specs/2026-07-23-hanamaru-release-program-design.md`.

---

## File Map

| Path | Responsibility |
|---|---|
| `src/runtime-state.js` | Shared ESM singleton: plugin registry, controller metadata WeakMap, root resource maps. |
| `src/plugins.js` | Public register/unregister APIs, builder context, descriptor validation. |
| `src/geometry.js` | Dispatch custom marks after built-ins and preserve deterministic formatting. |
| `src/annotation.js` | Validate marks through the shared registry at create/update time. |
| `src/scheduler.js` | Move the existing Document resource WeakMap into the shared singleton. |
| `src/declarative.js` | Validate declarative custom marks through the same captured registry path. |
| `tests/unit/plugins.test.js` | Registry lifecycle, exact primitives, golden paths, hostile outputs. |
| `tests/e2e/plugins.spec.js` | Real SVG rendering, updates, errors, and coexistence. |

## Chunk 1: Registry and Deterministic Geometry

### Task 1: Establish the shared singleton and plugin contract

**Files:**
- Create: `src/runtime-state.js`
- Create: `src/plugins.js`
- Modify: `src/geometry.js`
- Modify: `src/annotation.js`
- Modify: `src/scheduler.js`
- Modify: `src/declarative.js`
- Create: `tests/unit/plugins.test.js`

- [ ] **Step 1: Write failing registry and golden-output tests**

Assert built-in names cannot be replaced, duplicate custom names fail, the returned unregister closure is idempotent, and names follow the exact grammar/48-character cap. Assert the factory receives exactly frozen `{ rects, unionRect, seed, padding, helpers }`, with frozen helpers implementing the exact `jitter`, `line(start,end,options)`, and `closedPath(points,options)` signatures and golden FNV/rounding bytes. Assert invalid registry arguments are `HanamaruConfigError`; factory throws and invalid factory results are `HanamaruStateError` code `HANA_STATE_MARK_PLUGIN` with mark/cause.

- [ ] **Step 2: Run the test and verify RED**

Run `node --test tests/unit/plugins.test.js`.

Expected: FAIL because the plugin API is absent.

- [ ] **Step 3: Implement the singleton and registry**

Export one module-local `runtimeState = { plugins: Map, metadata: WeakMap, documents: WeakMap, shadows: WeakMap }` from `src/runtime-state.js`. Do not attach it to `globalThis` or use `Symbol.for`; the split ESM graph shares the module while the separately bundled IIFE receives its own instance. Move `src/scheduler.js`'s existing `resourcesByDocument` storage to `runtimeState.documents`. In `src/plugins.js`, export only `registerMark(name, factory)`, returning an identity-capturing idempotent unregister closure.

- [ ] **Step 4: Implement safe builder primitives and return validation**

Copy and freeze all rect inputs and `unionRect`. Format all helper numbers with the exact two-decimal/negative-zero/trailing-zero rules. Accept only an own-data object with exactly `{ paths }`, where `paths` is a non-empty array of strings, at most 32 paths and 16,384 UTF-16 code units per path. Validate SVG path syntax/non-finite values before DOM write. Builders never receive DOM, document, renderer, mutable registry objects, CSS classes, notes, connectors, timers, or animation handles.

- [ ] **Step 5: Dispatch plugins from geometry and validate annotation options**

Keep built-in branches unchanged. At successful construction or mark-changing update, capture the current factory on the Annotation. Refresh, replay, teardown, and same-mark update reuse the capture after unregister. A committed change away releases it; a later change back performs a fresh lookup. Creating or changing to an unregistered mark fails synchronously. Declarative parsing accepts the same registered names and captures through Annotation creation.

- [ ] **Step 6: Run unit and path regressions**

Run `node --test tests/unit/plugins.test.js tests/unit/paths.test.js tests/unit/options.test.js tests/unit/scheduler.test.js tests/unit/scan.test.js`.

Expected: all tests pass and every existing built-in golden path remains byte-identical.

### Task 2: Prove plugin rendering in browsers

**Files:**
- Create: `tests/e2e/plugins.spec.js`

- [ ] **Step 1: Write browser integration tests**

Register a `hanamaru` flower mark, show it on Element and Range targets, assert stable `d` across replay/refresh/reflow, same-mark update after unregister, change away/back failure, declarative custom mark use, multiple Documents sharing the realm registry, CSP with no injected script/style/eval, and zero owned path/note/ARIA residue after factory throw or invalid/cost-bounded output. Registered-plugin restore is owned by the later Serialization plan.

Run `npx playwright test tests/e2e/plugins.spec.js --project=chromium`.

Expected: GREEN because Chunk 1 already integrates path strings into the existing `layout.markPaths` renderer path; any failure is an `Incorrect` verification finding, not permission for a second renderer.

- [ ] **Step 2: Verify renderer ownership is unchanged**

Inspect the existing `layout.markPaths` mapping and assert through the browser test that it creates normal owned `<path>` nodes with the existing runtime class and animation/cleanup. No renderer source modification is planned; plugins cannot provide classes.

- [ ] **Step 3: Run focused verification and commit**

```bash
node --test tests/unit/plugins.test.js tests/unit/paths.test.js
npx playwright test tests/e2e/plugins.spec.js tests/e2e/renderer.spec.js --project=chromium
git add src/runtime-state.js src/plugins.js src/geometry.js src/annotation.js src/scheduler.js src/declarative.js tests/unit/plugins.test.js tests/e2e/plugins.spec.js
git commit -m "feat: register deterministic SVG mark plugins"
```

Expected: tests pass and the commit contains no demo-only plugin code.
