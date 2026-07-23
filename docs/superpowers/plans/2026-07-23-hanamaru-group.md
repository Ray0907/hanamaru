# Hanamaru Group API Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an atomic parallel Group controller whose members show, refresh, replay, hide, and fail as one unit.

**Architecture:** Group preflights every member before controller creation, owns normal Annotation controllers, and coordinates their lifecycle without a second renderer. A compact state machine and generation token make each operation atomic and suppress stale Promise settlements.

**Tech Stack:** Vanilla ES2020 JavaScript, existing Annotation controller, `node:test`, Playwright.

**Required skills during execution:** `@superpowers:test-driven-development`, `@codex-loop-engineering`.

**Design authority:** `docs/superpowers/specs/2026-07-23-hanamaru-group-design.md`.

**Execution dependencies:** The Shadow plan adds `scope.group()`; the Serialization plan adds private metadata; the Release plan adds declarations/exports. This plan fully verifies standalone top/iframe Document behavior.

---

## File Map

| Path | Responsibility |
|---|---|
| `src/group.js` | Group normalization, preflight, state machine, events, and ownership. |
| `tests/unit/group.test.js` | Complete transition/event table and failure atomicity with fake members. |
| `tests/fixtures/group.html` | Deterministic multi-target browser fixture. |
| `tests/e2e/group.spec.js` | Simultaneous rendering, reflow, failure cleanup, and accessibility. |

## Chunk 1: Atomic Parallel Controller

### Task 1: Implement the Group state machine with fakes

**Files:**
- Create: `src/group.js`
- Create: `tests/unit/group.test.js`

- [ ] **Step 1: Write failing construction/preflight tests**

Test empty/non-array/nested controller/Story/Group rejection; member-owned `trigger` or `motion` rejection; aggregate `trigger` and `motion` domains plus unknown aggregate keys; exact third `{ root?: Document }` context; iframe root acceptance; every mixed/cross-root rejection; and that all targets/options resolve before the first lease/controller is created. After successful preflight, inject member-controller construction failure at every index and assert already-created members are destroyed in reverse order, no lease/output remains, and the original typed error rethrows.

- [ ] **Step 2: Run the focused test and verify RED**

Run `node --test tests/unit/group.test.js`.

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/group.js`.

- [ ] **Step 3: Implement normalization and all-member preflight**

Export `group(members, options = {}, context = {})` plus internal `createGroup(members, options, env)`. `context.root` defaults to `document` and must be a native Document. Members are definition objects only and reject any own `trigger` or `motion`. Aggregate options accept `trigger: manual|load|viewport` and `motion: system|never`. Resolve every target against the exact root and normalize every member before creating the first Annotation; standalone Shadow targets throw `HANA_TARGET_SHADOW_UNSCOPED`. Wrap member construction in a transaction: on failure, reverse-destroy all controllers created by that transaction, release acquired resources, contain cleanup errors, and rethrow the original construction error.

- [ ] **Step 4: Run construction tests and verify GREEN**

Run `node --test --test-name-pattern="construction|preflight|root|option" tests/unit/group.test.js`.

Expected: all construction and root tests pass.

- [ ] **Step 5: Write failing manual transition and event tests**

Using fake members, cover every row/no-op state for show/hide/replay/refresh/destroy; start input order in one task; all-member completion; per-run Promise identity; pending supersede/hide/destroy AbortError; replay preflight preserving state/output/finished identity; suspended recovery; reverse teardown; synchronous reentrant start/complete/cancel/error listeners; and exact event payloads with no step/pause.

- [ ] **Step 6: Run manual-state tests and verify RED**

Run `node --test --test-name-pattern="transition|finished|event|reentrant|replay" tests/unit/group.test.js`.

Expected: FAIL because controller methods/state coordination are absent.

- [ ] **Step 7: Implement the exact manual state machine**

Expose only `state`, `finished`, read-only `size`, `show`, `hide`, `replay`, `refresh`, and `destroy`; there is no Group `update()`. Create all member Annotation controllers after preflight. Use one generation token and observed member Promises. Replay preflights before invalidating a run or clearing output. Dispatch exact events from the first owner.

- [ ] **Step 8: Run manual-state tests and verify GREEN**

Run `node --test --test-name-pattern="transition|finished|event|reentrant|replay" tests/unit/group.test.js`.

Expected: all manual lifecycle tests pass.

- [ ] **Step 9: Write failing member/cleanup failure tests**

For each member index, test synchronous show failure, rejected `finished`, remaining Promise observation with no `unhandledRejection`, all-member hide, `suspended`, and normalized `HanamaruStateError` code `HANA_STATE_GROUP_MEMBER` with `{ index, error }`. Cover refresh failures during pending and settled runs, lowest-index reporting after attempting all, requested-visible recovery, reverse destroy cleanup errors, and trigger cleanup errors.

- [ ] **Step 10: Implement failure containment**

Normalize member failures to `HANA_STATE_GROUP_MEMBER`, preserve typed member error in details, cancel/observe every pending Promise, and dispatch one aggregate error. Refresh never creates a Promise; preserve settled `finished` identity. Destroy reaches destroyed and reports the first normalized cleanup error.

- [ ] **Step 11: Run failure tests and verify GREEN**

Run `node --test --test-name-pattern="member failure|refresh failure|cleanup|unhandled" tests/unit/group.test.js`.

Expected: all member-index, pending/settled refresh, cleanup, and rejection-containment tests pass.

- [ ] **Step 12: Write RED tests for automatic triggers**

Cover load listener install/removal/acceptance, viewport observer rooted to the exact Document, first-member trigger target, start-once and remain-visible-after-exit, trigger failure, destroy-before-entry, and idempotent cleanup.

- [ ] **Step 13: Run automatic-trigger tests and verify RED**

Run `node --test --test-name-pattern="load trigger|viewport trigger|trigger cleanup" tests/unit/group.test.js`.

Expected: the load-start assertion fails because automatic trigger installation is absent.

- [ ] **Step 14: Implement load and viewport triggers**

Use the existing Annotation/Story resource patterns.

- [ ] **Step 15: Run all unit tests and verify GREEN**

Run `node --test tests/unit/group.test.js`.

Expected: all construction, lifecycle, failure, cleanup, and automatic-trigger tests pass.

### Task 2: Prove real rendering and cleanup

**Files:**
- Create: `tests/fixtures/group.html`
- Create: `tests/e2e/group.spec.js`

- [ ] **Step 1: Write failing browser tests**

Cover three unequal marks starting in one frame, visible completion only after all animations, hide/replay/refresh, layout suspension, failure at every member index removing all output, target replacement before replay, load/viewport start-once behavior, iframe root, standalone Shadow and mixed-root rejection, zero duplicate overlays/ARIA tokens, reduced motion, reentrant listeners, cleanup failure, and unhandled-rejection tracking.

- [ ] **Step 2: Run the browser test and verify RED**

Run `npx playwright test tests/e2e/group.spec.js --project=chromium`.

Expected: the first parallel-show test fails because the default Group environment has not yet delegated to real Annotation controllers.

- [ ] **Step 3: Wire the default Document environment**

Use `documentForTarget`, `createAnnotationEnvironment`, and `createAnnotation`. Dispatch composed bubbling events from the first member owner. Refresh existing member controllers; Group has no update API.

- [ ] **Step 4: Run focused regression tests**

Run:

```bash
node --test tests/unit/group.test.js tests/unit/annotation-state.test.js tests/unit/story.test.js
npx playwright test tests/e2e/group.spec.js tests/e2e/story.spec.js tests/e2e/resources.spec.js --project=chromium
```

Expected: all tests pass with no lifecycle or resource regression.

- [ ] **Step 5: Commit**

```bash
git add src/group.js tests/unit/group.test.js tests/fixtures/group.html tests/e2e/group.spec.js
git commit -m "feat: coordinate annotations in atomic groups"
```
