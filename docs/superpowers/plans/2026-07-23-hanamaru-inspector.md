# Hanamaru Direct Canvas Inspector Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a demo-only direct-canvas Inspector that turns a real text selection into a live mark and honest HTML/JS/JSON output.

**Architecture:** A finite UI state machine owns at most one public Annotation controller and imports only shipped public subpaths. Desktop uses a near-selection toolbar plus output rail; 390px uses a bottom dock/sheet. Output comes from one canonical definition and only claims persistence after exact locator round-trip.

**Tech Stack:** Semantic HTML, namespaced CSS, vanilla JavaScript, public Hanamaru APIs, Playwright, axe, Computer Use.

**Required skills during execution:** `@superpowers:test-driven-development`, `@impeccable`, `@codex-loop-engineering`, `@computer-use:computer-use`.

**Design authority:** `docs/superpowers/specs/2026-07-23-hanamaru-inspector-design.md` plus the approved companion screens in `.superpowers/brainstorm/77933-1784778928`.

---

## File Map

| Path | Responsibility |
|---|---|
| `demo/inspector-state.js` | Closed/idle/selected/editing/applied transition reducer. |
| `demo/inspector-output.js` | Locator proof and HTML/JS/JSON generation. |
| `demo/inspector.js` | DOM bindings, public runtime ownership, focus, clipboard. |
| `demo/index.html` | Inspector trigger, semantic layers, authorable article. |
| `demo/demo.css` | Desktop toolbar/rail and mobile dock/sheet styling. |
| `demo/demo.js` | Initialize/teardown Inspector alongside the existing demo. |
| `tests/unit/inspector-state.test.js` | Complete transition table and idempotence. |
| `tests/unit/inspector-output.test.js` | Honest output/locator decision logic. |
| `tests/e2e/inspector.spec.js` | Pointer, keyboard, mobile, a11y, cleanup, output equivalence. |

## Chunk 1: State and Output

### Task 1: Implement the complete UI reducer

**Files:**
- Create: `demo/inspector-state.js`
- Create: `tests/unit/inspector-state.test.js`

- [ ] **Step 1: Write RED tests for entry, selection, and close transitions**

Use this exact first table:

| From/Input | To | Ordered effects |
|---|---|---|
| closed/open(invoker) | idle | capture-invoker, mount, attach-listeners, focus-exit |
| idle/valid-selection(range) | selected | clone-selection, show-toolbar |
| selected/invalid-selection | idle | clear-selection, hide-toolbar |
| any-open/close or navigation | closed | destroy-owned, close-layers, remove-listeners, unmount, focus-connected-invoker |
| any-open/Escape without transient | closed | same close order |

Assert repeated open/close input is idempotent and native Selection is not an effect.

- [ ] **Step 2: Run entry tests and verify RED**

Run `node --test --test-name-pattern="open|selection|close|navigation" tests/unit/inspector-state.test.js`.

Expected: FAIL for missing reducer.

- [ ] **Step 3: Implement the entry/close reducer**

Export `reduceInspector(model, event)` returning `{ model, effects }`. Use exhaustive state/event switches and the exact ordered effect tokens in Step 1; unknown/repeated transitions return the identical model and `[]`.

- [ ] **Step 4: Run entry tests and verify GREEN**

Run the Step 2 command.

Expected: entry/selection/close rows pass.

- [ ] **Step 5: Write RED tests for editing/applied transitions**

Use this exact second table:

| From/Input | To | Ordered effects |
|---|---|---|
| selected/choose-mark | editing | create-preview, show-output |
| editing/change-mark or valid-option | editing | update-preview, refresh-output |
| editing/add-note | editing | open-note, focus-note |
| editing/apply | applied | commit-preview, refresh-output |
| editing/cancel | selected | destroy-owned, retain-range, hide-output |
| applied/edit | editing | reuse-controller, focus-first-editor |
| applied/new-valid-selection | selected | clone-selection, validate-clone, destroy-owned, replace-range, show-toolbar |

Assert clone/validation precede destroy so a failed new selection leaves the applied controller unchanged.

- [ ] **Step 6: Run editing/applied tests and verify RED**

Run `node --test --test-name-pattern="editing|applied|mark|note|cancel|new selection" tests/unit/inspector-state.test.js`.

Expected: choosing a mark returns no `create-preview` effect.

- [ ] **Step 7: Implement editing/applied transitions**

Add the exact second-table transitions and effect ordering.

- [ ] **Step 8: Run editing/applied tests and verify GREEN**

Run `node --test --test-name-pattern="editing|applied|mark|note|cancel|new selection" tests/unit/inspector-state.test.js`.

Expected: all editing/applied effect sequences pass.

- [ ] **Step 9: Write transient Escape tests**

Model at most one topmost `note` or `palette` transient with its opener. Escape closes only that transient and emits `close-transient, focus-transient-opener`; the next Escape closes Inspector.

- [ ] **Step 10: Run transient tests and verify RED**

Run `node --test --test-name-pattern="transient|Escape|opener" tests/unit/inspector-state.test.js`.

Expected: Escape closes Inspector instead of only the top transient.

- [ ] **Step 11: Implement transient Escape transitions**

Track transient kind/opener in the model and emit the exact close/focus effect pair without changing the underlying Inspector state.

- [ ] **Step 12: Run the complete reducer tests**

Run `node --test tests/unit/inspector-state.test.js`.

Expected: the complete reducer table and idempotence pass.

- [ ] **Step 13: Commit the reducer**

```bash
git add demo/inspector-state.js tests/unit/inspector-state.test.js
git commit -m "feat: define Inspector interaction state"
```

### Task 2: Implement honest output generation

**Files:**
- Create: `demo/inspector-output.js`
- Create: `tests/unit/inspector-output.test.js`

- [ ] **Step 1: Write failing output tests**

Assert Range HTML is unavailable, JavaScript uses `annotateSelection()` before locator proof, stable locator probing calls public `resolveSerializedTarget` only, successful update then serialize yields canonical JSON/restore code, failed update keeps prior output, and note/number escaping is safe. Clipboard DOM fallback is intentionally tested in Chunk 2, not this pure module.

- [ ] **Step 2: Run output tests and verify RED**

Run `node --test tests/unit/inspector-output.test.js`.

Expected: FAIL for missing output module.

- [ ] **Step 3: Implement public-resolver occurrence probing**

Never implement locator normalization/tree exclusion locally. Given selected text and `#inspector-document`, probe occurrence values from zero upward by calling injected public `resolveSerializedTarget({ type:'locator', within:{ type:'selector', selector:'#inspector-document' }, text, occurrence })`. Compare startContainer/startOffset/endContainer/endOffset with the cloned Range. Continue until exact match or the first `HANA_TARGET_MISSING`; each successful probe strictly advances occurrence, so the public resolver itself supplies termination without an incorrect local text-node bound. Only an exact match may call controller `update({ target: locator })`, then public `serialize`.

- [ ] **Step 4: Implement exact format results**

Return one model `{ html, javascript, json }`, where unavailable entries contain an explicit accessible reason string. Range HTML never injects a wrapper/key. Before proof, JavaScript is an explicit Selection/Range recipe; after proof it uses `restore()`. Escape all emitted JS/HTML strings with JSON/string-literal serializers.

- [ ] **Step 5: Run GREEN and commit**

```bash
node --test tests/unit/inspector-output.test.js
git add demo/inspector-output.js tests/unit/inspector-output.test.js
git commit -m "feat: generate honest Inspector output"
```

Expected: all honesty and escaping tests pass.

## Chunk 2: Rendered Inspector

### Task 3: Build semantic markup and controller binding

**Files:**
- Create: `demo/inspector.js`
- Modify: `demo/index.html`
- Modify: `demo/demo.js`
- Create: `tests/e2e/inspector.spec.js`

- [ ] **Step 1: Write RED integration test for the five-second path**

Create `tests/e2e/inspector.spec.js` asserting Open moves closed→idle and focuses Exit; real text selection shows toolbar; underline creates preview; Apply shows current output; Close destroys only Inspector output, removes listeners/UI, preserves native selection/existing stories, and returns focus.

- [ ] **Step 2: Run the five-second test and verify RED**

Run `npx playwright test tests/e2e/inspector.spec.js --project=chromium --grep="five-second"`.

Expected: FAIL because Open Annotation Inspector markup is absent.

- [ ] **Step 3: Add the minimal semantic surface**

Add explicit Open, Exit, `#inspector-document`, six built-in plus one plugin mark buttons, status region, Apply/Cancel, output tabs/readonly values, and Close. Keep existing demo IDs/stories.

- [ ] **Step 4: Bind the five-second path with public specifiers**

Use an import map that maps `hanamaru-annotations`, `hanamaru-annotations/selection`, `/serialize`, and `/plugins` to local built files; source code imports only those documented bare specifiers. Register one flower plugin, settle pointer/keyboard selection, interpret reducer effects, own one controller, and remove every listener on close/navigation.

- [ ] **Step 5: Run the five-second path and verify GREEN**

Run the Step 2 command.

Expected: the complete path passes before layout polish.

- [ ] **Step 6: Write RED tests for note/options/output controls**

Assert labeled 280-code-point note field, validation association, placement/accessibility/duration/motion/seed domains, HTML unavailable reason, successful/unavailable locator JSON, readonly copy, clipboard rejection reveals/selects fallback text, and tabs/status announcements.

- [ ] **Step 7: Run note/options/output tests and verify RED**

Run `npx playwright test tests/e2e/inspector.spec.js --project=chromium --grep="note|options|output|clipboard"`.

Expected: the note control assertion fails because the field is absent.

- [ ] **Step 8: Add remaining semantic controls and binding**

Add note sheet, bounded Options disclosure, command dialog, output rail/sheet, copy fallback. Invalid input stays editing and never calls controller update.

- [ ] **Step 9: Run note/options/output tests and verify GREEN**

Run the Step 7 command.

Expected: all note/options/output/clipboard tests pass.

### Task 4: Implement desktop/mobile styling and full accessibility

**Files:**
- Modify: `demo/demo.css`
- Modify: `demo/inspector.js`
- Modify: `demo/index.html`
- Modify: `tests/e2e/inspector.spec.js`

- [ ] **Step 1: Write RED desktop geometry and keyboard tests**

At 1280×900 assert toolbar never intersects selected Range and is clamped/docked inside visual viewport, right rail bounds, no horizontal overflow, roving arrows, Enter and Space activation, Tab order `exit → marks → note → output tabs → copy → options`, note/palette Escape returning focus to opener, second Escape closing Inspector, and visible focus/disabled states.

- [ ] **Step 2: Run desktop/keyboard tests and verify RED**

Run `npx playwright test tests/e2e/inspector.spec.js --project=chromium --grep="desktop|roving|Tab order|Escape focus"`.

Expected: toolbar bounds intersect the selected Range and ArrowRight does not move the roving tab stop.

- [ ] **Step 3: Implement desktop CSS/keyboard behavior**

Implement desktop near-selection toolbar/edge dock, fixed rail, roving tabindex, exact Tab order, and transient focus restoration.

- [ ] **Step 4: Run desktop/keyboard tests and verify GREEN**

Run the Step 2 command.

Expected: all desktop geometry and exact keyboard assertions pass.

- [ ] **Step 5: Write RED mobile geometry tests**

At exactly 390 CSS px assert toolbar docks above safe-area bottom, selected Range remains above dock, output starts collapsed and expands within viewport, note field is bounded, page `scrollWidth === clientWidth`, and close/navigation removes sticky layers.

- [ ] **Step 6: Run mobile tests and verify RED**

Run `npx playwright test tests/e2e/inspector.spec.js --project=chromium --grep="390px|mobile|bottom sheet|overflow"`.

Expected: output rail exceeds the 390px viewport before mobile layout exists.

- [ ] **Step 7: Implement mobile dock/sheet**

Add the mobile media/container rules and matching expand/collapse binding.

- [ ] **Step 8: Run mobile tests and verify GREEN**

Run the Step 6 command.

Expected: dock/sheet/bounds/overflow tests pass.

- [ ] **Step 9: Write RED completeness/a11y/motion tests**

Cover exactly six built-ins plus one plugin (seven total), command palette bounded commands/filter/arrows/Enter/Escape, applied edit/new selection clone-before-destroy, repeated entry/exit, story coexistence, reduced motion final-state/no interpolation, targeted axe, contrast, live status, and all validation associations.

- [ ] **Step 10: Run completeness tests and verify RED**

Run `npx playwright test tests/e2e/inspector.spec.js --project=chromium --grep="seven marks|command palette|new selection|reduced motion|axe|validation"`.

Expected: the command palette filter assertion fails before bounded-command behavior is complete.

- [ ] **Step 11: Complete command/a11y/motion behavior**

Implement only the missing bounded command, applied-new-selection, validation, status, and reduced-motion behaviors exposed by Step 10.

- [ ] **Step 12: Run automated verification**

```bash
node --test tests/unit/inspector-state.test.js tests/unit/inspector-output.test.js
npx playwright test tests/e2e/inspector.spec.js tests/e2e/demo-story.spec.js tests/e2e/responsive.spec.js --project=chromium
```

Expected: all tests pass with zero horizontal overflow.

- [ ] **Step 13: Run authoritative Computer Use acceptance**

Capture desktop closed/idle/selected/editing/applied; 390px selected/editing/applied; keyboard-only; reduced-motion; toolbar/note bounds; accessibility-tree excerpts. Save evidence under `outputs/acceptance/inspector/` and record any Correct/Incorrect loop finding before fixes.

- [ ] **Step 14: Commit rendered Inspector**

```bash
git add demo/inspector-state.js demo/inspector-output.js demo/inspector.js demo/index.html demo/demo.js demo/demo.css tests/unit/inspector-state.test.js tests/unit/inspector-output.test.js tests/e2e/inspector.spec.js
git commit -m "feat: add direct canvas annotation inspector"
```
