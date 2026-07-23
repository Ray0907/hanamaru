# Hanamaru Shadow DOM Scope Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit, root-owned Shadow DOM annotation scopes with clipping-safe visual portals and root-valid accessibility mirrors.

**Architecture:** A scope injects a ShadowRoot-aware target resolver and resource environment into existing controllers. Visual output stays in one owner-Document portal per ShadowRoot; accessibility mirrors and minimal styles stay inside the root. Shared singleton maps make ownership, style references, and teardown deterministic.

**Tech Stack:** Vanilla ES2020 JavaScript/CSS, Shadow DOM, adoptedStyleSheets, native observers, `node:test`, Playwright.

**Required skills during execution:** `@superpowers:test-driven-development`, `@codex-loop-engineering`, `@computer-use:computer-use` for rendered acceptance.

**Design authority:** `docs/superpowers/specs/2026-07-23-hanamaru-shadow-design.md`.

**Execution dependencies:** Run Selection, Group, Plugins, and Serialization first. This plan consumes their internal constructors and completes every scoped integration. Release declarations/exports remain a later task.

---

## File Map

| Path | Responsibility |
|---|---|
| `src/runtime-state.js` | Add one shared per-ShadowRoot record accessor with independent style/resource slots. |
| `src/target.js` | Expose package-private query/text hooks so Shadow resolution reuses locator semantics. |
| `src/shadow-target.js` | Exact-root selector, locator, Element, and Range resolution. |
| `src/shadow-styles.js` | auto/sheet/preinstalled style records, marker probes, ref counting. |
| `src/shadow-resources.js` | Per-root Document portal, mirror registry, observer and theme bridge. |
| `src/shadow.js` | Public scope facade, ownership, creation routing, teardown. |
| `src/hanamaru-shadow.css` | Minimal mirror rules and verifiable marker property. |
| `src/annotation.js` | Accept injected root/resource environments without changing standalone policy. |
| `src/renderer.js` | Separate visual note from in-root accessible mirror and focus-safe overflow. |
| `src/scheduler.js` | Root-scoped portal/resource acquisition and observation. |
| `tests/unit/shadow-styles.test.js` | Injected style-registry compatibility, ref count, rollback, ownership. |
| `tests/unit/shadow-scope.test.js` | Facade ownership and integration routing with injected controllers. |
| `tests/fixtures/shadow.html` | Open/closed/nested/transformed/clipped/iframe roots. |
| `tests/e2e/shadow-targets.spec.js` | Real native root/target and browser stylesheet contracts. |
| `tests/e2e/shadow-runtime.spec.js` | Scoped facade lifecycle, events, ownership, and helper integration. |
| `tests/e2e/shadow-accessibility.spec.js` | Mirrors, overflow focus, theme, transforms, clipping, and viewport. |
| `tests/e2e/shadow-smoke.spec.js` | One open-root annotation for Chromium, Firefox, and WebKit. |

## Chunk 1: Root Scope and Styles

### Task 1: Implement exact-root target resolution in a real browser

**Files:**
- Create: `src/shadow-target.js`
- Modify: `src/target.js`
- Create: `tests/fixtures/shadow.html`
- Create: `tests/e2e/shadow-targets.spec.js`

- [ ] **Step 1: Write RED tests for root validation and direct targets**

Create named Playwright tests for a native connected ShadowRoot; disconnected/foreign objects; direct Element and Range with exact `getRootNode()` equality; nested-root, owner-Document-only, cross-document, and two-root rejection; and retained closed-root acceptance. Assert exact typed error/code for each.

- [ ] **Step 2: Run the direct-target slice and verify RED**

Run `npx playwright test tests/e2e/shadow-targets.spec.js --project=chromium --grep="root|direct"`.

Expected: FAIL with missing `resolveShadowTarget` export.

- [ ] **Step 3: Implement the direct-target contract**

Export:

```js
export function assertShadowRoot(root)
export function resolveShadowTarget(target, root)
```

Use `root.ownerDocument.defaultView.ShadowRoot/Element/Range` for native brands. Require a connected host and `getRootNode() === root` for both Range boundaries. Delegate record construction to package-private target helpers after exact-root checks; standalone policy is not changed.

- [ ] **Step 4: Run direct-target tests and verify GREEN**

Run the Step 2 command.

Expected: every direct/root case passes.

- [ ] **Step 5: Write RED tests for selector and locator confinement**

Cover unique/missing/ambiguous selector, exact-text locator, Element locator `within`, nested-root text exclusion, and a selector that exists only in the owner Document. Assert every resolved record belongs to the supplied root.

- [ ] **Step 6: Run the resolver slice and verify RED**

Run `npx playwright test tests/e2e/shadow-targets.spec.js --project=chromium --grep="selector|locator"`.

Expected: locator cases fail before the Shadow-root query/text collector is wired.

- [ ] **Step 7: Complete selector/locator resolution**

Export package-private root-aware query/text hooks from `src/target.js` instead of copying normalization or occurrence logic. Call those hooks with the ShadowRoot query scope and exact-root guard.

- [ ] **Step 8: Run selector/locator tests and verify GREEN**

Run the Step 6 command.

Expected: selector/locator tests pass, including nested-root exclusion.

### Task 2: Implement style configuration with injected unit seams and browser probes

**Files:**
- Create: `src/shadow-styles.js`
- Modify: `src/runtime-state.js`
- Create: `src/hanamaru-shadow.css`
- Create: `tests/unit/shadow-styles.test.js`
- Modify: `tests/e2e/shadow-targets.spec.js`

- [ ] **Step 1: Write RED unit tests for normalized configuration and leases**

Test exact `ShadowStyles` domains, same auto/nonce, same sheet identity, preinstalled compatibility, every conflict pair, first-acquire/last-release counts, failed first acquire leaves no empty root record, failed later acquire does not change count, and release idempotence. The injected fake adapter deterministically forces constructable support off and asserts fallback `<style>` content plus exact nonce propagation; no Node DOM primitive is assumed.

- [ ] **Step 2: Run lease tests and verify RED**

Run `node --test tests/unit/shadow-styles.test.js`.

Expected: FAIL with missing `acquireShadowStyles`.

- [ ] **Step 3: Implement the exact style lease API**

Export:

```js
export function normalizeShadowStyles(value)
export function acquireShadowStyles(root, value, adapter)
```

Add these exact internal APIs to `src/runtime-state.js`:

```js
getShadowRootState(root)
claimShadowRootSlot(root, 'styles' | 'resources', record)
releaseShadowRootSlot(root, 'styles' | 'resources', record)
```

The getter creates/returns one stable `{ styles: null, resources: null }` record. Claim requires a null slot and stores by identity. Release clears only the matching record identity and deletes the WeakMap entry only when both slots are null. The adapter contract is `{ installAuto, adoptSheet, verifyMarker, rollback }`; each install returns `{ owned, release }`. Store config/count/install only in the claimed styles record. Compatibility is exact, failures call rollback and do not claim, and final release calls `releaseShadowRootSlot` without touching resources.

- [ ] **Step 4: Run unit lease tests and verify GREEN**

Run `node --test tests/unit/shadow-styles.test.js`.

Expected: all fake-adapter ownership/conflict/rollback tests pass.

- [ ] **Step 5: Write RED browser tests for auto/sheet/preinstalled**

Add browser tests for constructable auto, exact `--hana-shadow-style: 1` temporary probe, valid and author-pre-adopted sheet, empty/unrelated sheet rejection, preinstalled success/failure, strict-CSP no dynamic node, install failure rollback, two `acquireShadowStyles()` leases with the same config, conflict, and final author-sheet retention. Fallback/nonce is already GREEN in the Node adapter tests; Chromium covers native constructable/probe behavior.

- [ ] **Step 6: Run style browser tests and verify RED**

Run `npx playwright test tests/e2e/shadow-targets.spec.js --project=chromium --grep="style|sheet|preinstalled|CSP"`.

Expected: auto installation fails before the real browser adapter exists.

- [ ] **Step 7: Implement the browser style adapter**

Define the mirror selector and marker in `src/hanamaru-shadow.css`. Implement constructable/fallback installation, temporary probe mount/measure/remove, caller-sheet adoption tracking, and strict preinstalled verification.

- [ ] **Step 8: Run style browser tests and verify GREEN**

Run the Step 6 command.

Expected: every style mode, rollback, conflict, and ownership test passes.

- [ ] **Step 9: Commit Chunk 1**

```bash
git add src/runtime-state.js src/shadow-target.js src/shadow-styles.js src/hanamaru-shadow.css src/target.js tests/unit/shadow-styles.test.js tests/fixtures/shadow.html tests/e2e/shadow-targets.spec.js
git commit -m "feat: validate Shadow roots targets and styles"
```

## Chunk 2: Scoped Runtime and Accessibility

### Task 3: Build per-root resource leases

**Files:**
- Create: `src/shadow-resources.js`
- Modify: `src/renderer.js`
- Modify: `src/scheduler.js`
- Create: `tests/unit/shadow-scope.test.js`
- Create: `tests/e2e/shadow-runtime.spec.js`

- [ ] **Step 1: Write RED unit tests for resource ownership**

With injected Document resources, assert one portal per root, one observer/mirror registry per root, shared Window/visualViewport/frame scheduler at Document level, distinct portals/observers for two roots, reference counts, unique Document+root IDs, owned-token removal, and final-release cleanup.

- [ ] **Step 2: Run resource tests and verify RED**

Run `node --test --test-name-pattern="resource|portal|observer|mirror|ID" tests/unit/shadow-scope.test.js`.

Expected: FAIL with missing `acquireShadowResources`.

- [ ] **Step 3: Implement the resource lease**

Export `acquireShadowResources(root, styleLease)` returning `{ environment, release }`. The environment supplies exact root, owner Document shared scheduler, root portal, root observer target, mirror create/update/remove, ID allocation, and composed event dispatch. The first resource record is installed with `claimShadowRootSlot(root, 'resources', record)`; final release calls `releaseShadowRootSlot(root, 'resources', record)`. The shared helper alone deletes the root record after both slots are null. Keep shared Document listeners in the existing Document lease.

- [ ] **Step 4: Run resource unit tests and verify GREEN**

Run the Step 2 command.

Expected: all ownership/ref-count/ID/token tests pass.

### Task 4: Implement the scope facade incrementally

**Files:**
- Create: `src/shadow.js`
- Modify: `src/annotation.js`
- Modify: `src/declarative.js`
- Modify: `src/story.js`
- Modify: `src/group.js`
- Modify: `src/selection.js`
- Modify: `src/serialize.js`
- Modify: `tests/unit/shadow-scope.test.js`
- Modify: `tests/e2e/shadow-runtime.spec.js`

- [ ] **Step 1: Write RED tests for annotate and scope ownership**

For the initial slice, assert `annotate()` and `destroy()` use the exact root environment, each controller is registered once, use-after-destroy throws, reverse destroy continues through cleanup errors, and standalone helpers reject unscoped Shadow targets even while a scope exists. The exact eight-method surface is deferred until all integration families are implemented.

- [ ] **Step 2: Run annotate ownership tests and verify RED**

Run `node --test --test-name-pattern="annotate|ownership|destroy|standalone" tests/unit/shadow-scope.test.js`.

Expected: FAIL with missing `createShadowScope`.

- [ ] **Step 3: Implement `createShadowScope`, `scope.annotate`, and destroy**

Acquire styles/resources before exposing the scope. Keep an ordered controller set. Route to `createAnnotation(target, options, environment)`. On destroy, tear down controllers in reverse, then resource/style leases; mark destroyed even if cleanup reports an error.

- [ ] **Step 4: Run annotate ownership tests and verify GREEN**

Run `node --test --test-name-pattern="annotate|ownership|destroy|standalone" tests/unit/shadow-scope.test.js`.

Expected: annotate/facade ownership tests pass.

- [ ] **Step 5: Write RED tests for scan/Story/Group routing**

For each method, assert exact root target resolution, returned controller registration, one shared environment, composed event observation outside the host, and no nested-root entry.

- [ ] **Step 6: Run scan/Story/Group tests and verify RED**

Run `node --test --test-name-pattern="scan|Story|Group|event" tests/unit/shadow-scope.test.js`.

Expected: `scope.scan is not a function`.

- [ ] **Step 7: Implement scan/Story/Group facade methods**

Call existing `scanDeclarative`, `createStory`, and `createGroup` with the root environment.

- [ ] **Step 8: Run scan/Story/Group tests and verify GREEN**

Run `node --test --test-name-pattern="scan|Story|Group|event" tests/unit/shadow-scope.test.js`.

Expected: all three integration families pass.

- [ ] **Step 9: Write RED tests for Selection/restore/resolver routing**

Assert omitted Selection comes from `root.ownerDocument.defaultView.getSelection()`, explicit wrong-root Selection rejects, restore preflights in the root, isolated resolution clones Ranges, and every controller is scope-owned.

- [ ] **Step 10: Run Selection/serialization tests and verify RED**

Run `node --test --test-name-pattern="Selection|restore|serialized" tests/unit/shadow-scope.test.js`.

Expected: `scope.annotateSelection is not a function`.

- [ ] **Step 11: Implement Selection/serialization facade methods**

Call `annotateSelectionWithEnvironment`, internal `restoreWithEnvironment`, and `resolveSerializedTargetWithEnvironment` with the exact root/view/resources.

- [ ] **Step 12: Run Selection/serialization tests and verify GREEN**

Run `node --test --test-name-pattern="Selection|restore|serialized" tests/unit/shadow-scope.test.js`.

Expected: all scoped optional APIs pass.

- [ ] **Step 13: Assert the final facade surface**

Add and run a test that `Object.keys(scope).sort()` is exactly `annotate,annotateSelection,destroy,group,resolveSerializedTarget,restore,scan,story` and that every value is a function. Run `node --test tests/unit/shadow-scope.test.js`.

Expected: the complete facade ownership, routing, use-after-destroy, and exact-eight-method tests pass.

### Task 5: Implement mirror accessibility and theme geometry

**Files:**
- Modify: `src/renderer.js`
- Modify: `src/scheduler.js`
- Create: `tests/e2e/shadow-accessibility.spec.js`

- [ ] **Step 1: Write RED tests for mirror ownership and events**

Test meaningful note creates one in-root mirror, owner `aria-describedby` references only that ID, visual portal note is normally `aria-hidden`, IDs are unique across roots, updates preserve only owned tokens, teardown removes owned token/mirror, decorative notes create neither mirror nor focus target, and `hana:*` events bubble composed outside the host.

- [ ] **Step 2: Run mirror tests and verify RED**

Run `npx playwright test tests/e2e/shadow-accessibility.spec.js --project=chromium --grep="mirror|describedby|decorative|event"`.

Expected: the first meaningful-note test fails because no in-root mirror exists.

- [ ] **Step 3: Implement mirror output**

Split renderer's visual note and description writer behind environment methods.

- [ ] **Step 4: Run mirror tests and verify GREEN**

Run the Step 2 command.

Expected: mirror/token/event tests pass.

- [ ] **Step 5: Write RED tests for focus-safe overflow**

Force a bounded note to overflow, keyboard-focus and scroll it, clear overflow while focused, assert no `aria-hidden`; blur and assert remeasure/restoration. Also test overflow returning before blur.

- [ ] **Step 6: Run overflow tests and verify RED**

Run `npx playwright test tests/e2e/shadow-accessibility.spec.js --project=chromium --grep="overflow|focused|blur"`.

Expected: the overflow note remains `aria-hidden` and cannot receive focus.

- [ ] **Step 7: Implement overflow state**

Use renderer overflow measurement; add/remove role/tabindex/aria-hidden atomically. Defer hidden restoration while `activeElement === note`, listen once for blur, remeasure, and restore only when overflow remains absent.

- [ ] **Step 8: Run overflow tests and verify GREEN**

Run the Step 6 command.

Expected: overflow/focus/blur tests pass with no focused aria-hidden element.

- [ ] **Step 9: Write RED tests for transform/clipping/theme/viewport**

Cover transformed/contained/clipped hosts, target/host theme values, per-root z-index, two roots, scroll/resize/mutation/visualViewport movement, root-scoped observer callbacks, reduced motion, and zero page overflow. Assert viewport-coordinate path/note bounds numerically.

- [ ] **Step 10: Run geometry/theme tests and verify RED**

Run `npx playwright test tests/e2e/shadow-accessibility.spec.js --project=chromium --grep="transform|contain|clipping|theme|z-index|viewport|motion"`.

Expected: the per-root z-index assertion fails before host theme bridging.

- [ ] **Step 11: Implement theme bridge**

During scheduler reads, copy only approved computed custom properties to owned group/note and concrete host z-index to the root portal. Keep viewport coordinates and shared Document frame batching.

- [ ] **Step 12: Run geometry/theme tests and verify GREEN**

Run the Step 10 command.

Expected: transform/contain/clipping bounds, theme values, per-root z-index, viewport/observer movement, reduced motion, and zero-overflow assertions all pass.

### Task 6: Complete the cross-browser matrix

**Files:**
- Modify: `tests/e2e/shadow-runtime.spec.js`
- Create: `tests/e2e/shadow-smoke.spec.js`

- [ ] **Step 1: Add the remaining normative runtime assertions**

Cover open and retained closed roots; every facade method; failure cleanup; two scopes sharing one root; two roots sharing Document listeners but distinct portals/observers; iframe scope; root-specific event payload; reverse teardown; root/style rollback; and no partial output.

- [ ] **Step 2: Run the regression matrix**

Run:

```bash
node --test tests/unit/shadow-styles.test.js tests/unit/shadow-scope.test.js tests/unit/aria.test.js tests/unit/scheduler.test.js tests/unit/serialization.test.js
npx playwright test tests/e2e/shadow-targets.spec.js tests/e2e/shadow-runtime.spec.js tests/e2e/shadow-accessibility.spec.js --project=chromium
```

Expected: all unit and Chromium matrix tests pass.

- [ ] **Step 3: Write real open-root smoke**

Create `shadow-smoke.spec.js` with one open-root circle+meaningful-note annotation, visible completion, in-root description token, hide/replay, and destroy cleanup.

- [ ] **Step 4: Run open-root smoke in all engines**

Run:

```bash
npx playwright test tests/e2e/shadow-smoke.spec.js --project=chromium --project=firefox --project=webkit
```

Expected: 3/3 engine cases pass.

- [ ] **Step 5: Commit Chunk 2**

```bash
git add src/shadow-resources.js src/shadow.js src/annotation.js src/renderer.js src/scheduler.js src/declarative.js src/story.js src/group.js src/selection.js src/serialize.js tests/unit/shadow-scope.test.js tests/e2e/shadow-runtime.spec.js tests/e2e/shadow-accessibility.spec.js tests/e2e/shadow-smoke.spec.js
git commit -m "feat: annotate explicit Shadow DOM scopes"
```

Expected: all tests pass; no cross-root `aria-describedby` token exists.
