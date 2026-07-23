# Hanamaru Selection API Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a zero-mutation `annotateSelection()` helper for Document and explicitly scoped ShadowRoot selections.

**Architecture:** A small selection validator clones exactly one native Range, delegates all rendering to the existing annotation environment, and never retains or changes the browser Selection. The standalone entry accepts Document roots; the same internal function accepts an injected Shadow scope environment later.

**Tech Stack:** Vanilla ES2020 JavaScript, native Selection/Range APIs, `node:test`, Playwright.

**Required skills during execution:** `@superpowers:test-driven-development`, `@codex-loop-engineering`.

**Design authority:** `docs/superpowers/specs/2026-07-23-hanamaru-selection-design.md`.

**Execution dependencies:** This plan implements and verifies standalone Document/iframe behavior first. `docs/superpowers/plans/2026-07-23-hanamaru-shadow.md` consumes the exact injected environment below and adds scoped open/closed/iframe Shadow tests. Package exports and declarations are owned by the release plan.

---

## File Map

| Path | Responsibility |
|---|---|
| `src/selection.js` | Validate/clone a Selection and create a standalone or injected-scope Annotation. |
| `tests/unit/selection.test.js` | Pure validation using explicit native-brand fixture objects where possible. |
| `tests/fixtures/selection.html` | Browser fixture for Document, iframe, and ShadowRoot selections. |
| `tests/e2e/selection.spec.js` | Native Selection integration, host-selection preservation, and lifecycle. |

## Chunk 1: Selection Validation and Delegation

### Task 1: Add the standalone Selection helper

**Files:**
- Create: `src/selection.js`
- Create: `tests/unit/selection.test.js`
- Create: `tests/fixtures/selection.html`
- Create: `tests/e2e/selection.spec.js`

- [ ] **Step 1: Write failing unit tests for the stable error contract**

Import `annotateSelectionWithEnvironment` from `src/selection.js`. Its exact internal signature is:

```js
annotateSelectionWithEnvironment(options, selection, {
  view,
  root,
  createAnnotation,
})
```

`view` is the expected browsing realm and supplies `Selection`, `Range`, and `getSelection()`. Use explicit fakes for unavailable default selection, zero ranges, collapsed range, two ranges, disconnected boundaries, cross-document roots, and cross-root boundaries. Assert exact error codes and that details contain only `rangeCount`, `collapsed`, and root-kind strings.

- [ ] **Step 2: Run the focused test and verify RED**

Run `node --test tests/unit/selection.test.js`.

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/selection.js`.

- [ ] **Step 3: Implement default-selection and empty/ambiguous validation**

When omitted, read only `env.view?.getSelection()`. Initially validate with `selection instanceof env.view.Selection`; this intentionally leaves an explicit empty iframe Selection RED for the later real-browser cross-realm step. Read zero ranges as `HANA_TARGET_SELECTION_EMPTY`, two-plus as ambiguous, and never inspect `anchorNode` for the zero-range case.

- [ ] **Step 4: Run the error tests and verify GREEN**

Run `node --test tests/unit/selection.test.js`.

Expected: unavailable, empty, collapsed, ambiguous, realm, and safe-detail tests pass.

- [ ] **Step 5: Write failing clone/delegation tests**

Add injected tests asserting `cloneRange()` runs exactly once before `createAnnotation`, the original Selection and Range are never retained or mutated, later selection changes do not alter the passed clone, a Shadow root produces `HANA_TARGET_SHADOW_UNSCOPED`, and `createAnnotation` receives the exact options object plus clone.

- [ ] **Step 6: Run clone/delegation tests and verify RED**

Run `node --test --test-name-pattern="clone|delegate|Shadow" tests/unit/selection.test.js`.

Expected: FAIL because successful selection delegation is not implemented.

- [ ] **Step 7: Implement connected-root validation and delegation**

Require exactly one non-collapsed range, connected boundaries, one owner Document, and one `getRootNode()` identity. Clone immediately. Reject standalone Shadow roots. Call `env.createAnnotation(clone, options)` only after every check. Public `annotateSelection(options, selection)` uses the global Document view and delegates to `createAnnotation(clone, options, createAnnotationEnvironment(clone))`.

- [ ] **Step 8: Run all unit tests and verify GREEN**

Run `node --test tests/unit/selection.test.js`.

Expected: every validation, clone, mutation, and delegation test passes.

- [ ] **Step 9: Write browser tests for real native objects**

In `tests/e2e/selection.spec.js`, cover omitted and explicit Document Selection, unchanged anchor/focus after creation, post-call native selection changes, whitespace-only Range, iframe omitted/explicit selection, disconnected/cross-document/cross-root boundaries, multiple ranges when supported, standalone open-Shadow rejection, reduced motion, `finished`, hide/replay/destroy, and no wrapper DOM mutation.

- [ ] **Step 10: Run the browser test and verify a precise RED**

Run `npx playwright test tests/e2e/selection.spec.js --project=chromium`.

Expected: the explicit empty iframe Selection case fails with the wrong error code or brand result before cross-realm selection handling is complete; all source imports resolve.

- [ ] **Step 11: Complete cross-realm browser validation**

Replace `instanceof` with an exact WebIDL brand operation: obtain the native `rangeCount` getter from `Object.getOwnPropertyDescriptor(env.view.Selection.prototype, 'rangeCount').get` and invoke it with `Reflect.apply(getter, selection, [])`. WebIDL checks the Selection internal slot and accepts genuine cross-realm Selection objects; a spoof throws `TypeError`. For non-empty selections, additionally derive the boundary Document view and invoke its native getter. A genuine explicit empty iframe Selection now returns `HANA_TARGET_SELECTION_EMPTY`; spoofed objects return `HANA_TARGET_SELECTION_UNAVAILABLE`. Do not call `removeAllRanges`, `collapse`, or `addRange`.

- [ ] **Step 12: Run focused and regression tests**

Run:

```bash
node --test tests/unit/selection.test.js tests/unit/target.test.js tests/unit/annotation-state.test.js
npx playwright test tests/e2e/selection.spec.js tests/e2e/annotation.spec.js --project=chromium
```

Expected: all focused and regression tests pass.

- [ ] **Step 13: Commit**

```bash
git add src/selection.js tests/unit/selection.test.js tests/fixtures/selection.html tests/e2e/selection.spec.js
git commit -m "feat: annotate native text selections"
```
