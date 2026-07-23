# Hanamaru Serialization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize and restore Annotation, Story, and Group controllers through a canonical, versioned, JSON-safe wire format.

**Architecture:** Controllers store immutable canonical metadata in the shared private WeakMap. Serialization walks that metadata into fixed-key-order plain objects; restoration validates the entire untrusted object graph, resolves every target atomically, and delegates creation to normal runtime controllers.

**Tech Stack:** Vanilla ES2020 JavaScript, DOM selector/Range resolution, `node:test`, Playwright.

**Required skills during execution:** `@superpowers:test-driven-development`, `@codex-loop-engineering`.

**Design authority:** `docs/superpowers/specs/2026-07-23-hanamaru-serialization-design.md`.

**Execution dependencies:** Run the Group and Plugins plans first so `src/group.js`, `runtimeState.metadata`, and their tests exist. Shadow-scoped restore is completed by the Shadow plan; declarations/exports are completed by the Release plan.

---

## File Map

| Path | Responsibility |
|---|---|
| `src/controller-metadata.js` | Freeze/read/update private canonical controller metadata in the shared singleton. |
| `src/serialize-schema.js` | Strict own-data validation and canonical v1 object construction. |
| `src/serialize-target.js` | Element/Range key conversion and selector/locator/key restoration. |
| `src/serialize.js` | Public `serialize`, `restore`, and `resolveSerializedTarget` orchestration. |
| `src/annotation.js` | Commit metadata only after successful create/update. |
| `src/story.js` | Store aggregate options and ordered member metadata. |
| `src/group.js` | Store aggregate options and ordered member metadata. |
| `tests/unit/serialization.test.js` | Wire shapes, hostile input, resolver contexts, atomicity. |
| `tests/e2e/serialization.spec.js` | DOM round trips and equivalent SVG/lifecycle behavior. |

## Chunk 1: Canonical Metadata and Schema

### Task 1: Record controller metadata without public DOM leakage

**Files:**
- Create: `src/controller-metadata.js`
- Modify: `src/annotation.js`
- Modify: `src/story.js`
- Modify: `src/group.js`
- Create: `tests/unit/serialization.test.js`

- [ ] **Step 1: Write failing metadata lifecycle tests**

Assert Annotation metadata includes accepted target source and all eight normalized option fields, failed updates leave prior metadata unchanged, successful updates swap metadata atomically, Story/Group metadata references ordered member metadata and normalized aggregate options, generated seeds are present, destroy deletes metadata, and no public controller property exposes metadata or DOM. Public foreign-controller serialization guards are tested in Task 2 after `src/serialize.js` exists.

- [ ] **Step 2: Run the test and verify RED**

Run `node --test tests/unit/serialization.test.js`.

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/controller-metadata.js`; Task 1 does not import public serialization.

- [ ] **Step 3: Implement private metadata helpers and controller hooks**

Use `runtimeState.metadata` only. Freeze metadata wrapper records and canonical option objects, but retain accepted Element/Range identity as opaque unfrozen values so `keyForTarget` receives the original target. Set Annotation metadata after successful construction, replace it only after successful `update()`, and delete it on destroy. Assemble Story/Group metadata from member metadata after all member controllers exist; delete aggregate metadata on destroy.

- [ ] **Step 4: Run metadata tests and regressions**

Run `node --test tests/unit/serialization.test.js tests/unit/annotation-state.test.js tests/unit/story.test.js tests/unit/group.test.js`.

Expected: metadata tests and prior lifecycle tests pass.

### Task 2: Implement strict canonical schema serialization

**Files:**
- Create: `src/serialize-schema.js`
- Create: `src/serialize-target.js`
- Create: `src/serialize.js`
- Modify: `tests/unit/serialization.test.js`

- [ ] **Step 1: Add exact-shape and hostile-object tests**

Assert byte-identical `JSON.stringify()` output and exact recursive key order for all examples in the spec; omission rules for `occurrence` and Story `once`; selector/locator/key forms; cyclic input, accessors, unexpected prototypes, symbols, unknown keys, non-finite numbers, invalid schema/kind, and pollution keys. Assert foreign and destroyed controllers throw `HanamaruStateError` before any callback. Golden `keyForTarget` fixtures require exactly `{ role, controllerKind, ownerElement, index }`; golden `resolveTarget` fixtures require exactly `{ targetKind, role, controllerKind, index }`. Cover Annotation, Story, Group, isolated direct targets, and locator `within`.

- [ ] **Step 2: Run and confirm RED**

Run `node --test tests/unit/serialization.test.js`.

Expected: schema and target tests fail at missing exports.

- [ ] **Step 3: Implement canonical writers and recursive own-data validator**

Build every result object by explicit property assignment in spec order. Never spread caller data. Reject non-plain prototypes, accessors, cycles, unknown/missing keys, wrong primitive domains, and all unsafe property names before resolving a target or invoking callbacks.

- [ ] **Step 4: Implement target encoding and isolated resolution**

Serialize selector/locator sources directly; require `keyForTarget(original, context)` for direct Element/Range and Element locator containers. `resolveSerializedTarget(target, { root = document, resolveTarget } = {})` returns a connected Element or cloned Range and always supplies all four resolver fields, including `null` controller/index for isolated resolution.

- [ ] **Step 5: Implement atomic restore**

For `restore()`, validate the complete untrusted definition graph before invoking `resolveTarget`; a resolver spy remains untouched on late structural failure. For `serialize()`, validate the private controller metadata kind/target before invoking `keyForTarget`; foreign/destroyed controllers fail first. Require missing callbacks to be `HanamaruConfigError`; wrap serialization callback failures/non-string/empty keys as `HANA_CONFIG_SERIALIZE_TARGET`; wrap resolver throws as `HANA_TARGET_RESOLVER` preserving cause/key/full context. Resolve all aggregate targets and normalize all options before creating a controller.

- [ ] **Step 6: Run unit verification**

Run `node --test tests/unit/serialization.test.js tests/unit/options.test.js tests/unit/target.test.js`.

Expected: all canonical schema, resolver, and hostile-input tests pass.

## Chunk 2: DOM Round-Trip Proof

### Task 3: Prove restored output and lifecycle equivalence

**Files:**
- Create: `tests/e2e/serialization.spec.js`

- [ ] **Step 1: Write Annotation/target integration proof**

Prefix every test title in this slice with `Annotation` or `target`. Cover selector Annotation, native Element key, native Range key, exact-text locator, iframe Document, generated seeds, post-update metadata, registered plugin prerequisite, isolated Range clone identity/boundaries, and standalone Shadow rejection. For every restored Annotation assert exact serialized bytes, final SVG `d`, state transitions, and exact `hana:start` then `hana:complete` order; abort cases assert one `hana:cancel`.

- [ ] **Step 2: Run Annotation/target integration proof**

Run `npx playwright test tests/e2e/serialization.spec.js --project=chromium --grep="Annotation|target"`.

Expected: GREEN because Chunk 1 already owns target integration; any failure is recorded as an `Incorrect` loop finding and fixed in the owning source module before continuing.

- [ ] **Step 3: Write Story/Group atomic round-trip tests**

Add named tests for complete Story and Group shapes, every member target form, generated member seeds, plugin mark restore after registration, no controller/DOM output when a later member fails, byte-identical member SVG paths, and lifecycle/event equivalence.

- [ ] **Step 4: Run aggregate integration proof**

Run `npx playwright test tests/e2e/serialization.spec.js --project=chromium --grep="Story|Group|atomic"`.

Expected: GREEN because Chunk 1 already owns aggregate preflight; any failure is an `Incorrect` loop finding.

- [ ] **Step 5: Run full browser serialization suite**

Run `npx playwright test tests/e2e/serialization.spec.js --project=chromium`.

Expected: all Annotation, Story, Group, target, atomicity, path, and lifecycle round trips pass.

- [ ] **Step 6: Run focused verification and commit**

```bash
node --test tests/unit/serialization.test.js tests/unit/annotation-state.test.js tests/unit/story.test.js tests/unit/group.test.js
npx playwright test tests/e2e/serialization.spec.js tests/e2e/target.spec.js --project=chromium
git add src/controller-metadata.js src/serialize-schema.js src/serialize-target.js src/serialize.js src/annotation.js src/story.js src/group.js tests/unit/serialization.test.js tests/e2e/serialization.spec.js
git commit -m "feat: serialize and restore annotation controllers"
```

Expected: all tests pass and serialized output contains no live node references.
