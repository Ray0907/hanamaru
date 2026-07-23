# Hanamaru Selection API Design

**Date:** 2026-07-23  
**Status:** User-approved design; pending independent spec review

## Objective

Let a developer turn the user's current native text selection into a normal Hanamaru annotation without manually constructing a `Range`. The helper must preserve existing target correctness: one connected, non-collapsed range in one DOM root, cloned at acceptance time, with no host DOM mutation.

## Public API

```js
import { annotateSelection } from 'hanamaru-annotations/selection'

const annotation = annotateSelection({
  mark: 'circle',
  note: 'Review this',
})
```

The complete signature is:

```ts
function annotateSelection(
  options: AnnotationOptions,
  selection?: Selection,
): AnnotationController
```

When `selection` is omitted, the helper reads `globalThis.window?.getSelection()`. A non-browser realm without an explicit native `Selection` produces a typed target error rather than a native reference failure.

## Acceptance Rules

The helper validates synchronously before calling `annotate()`:

1. the value is a genuine `Selection` from a usable browsing realm;
2. `rangeCount` is exactly one;
3. the range is not collapsed;
4. both boundaries are connected and belong to the same document;
5. both boundaries have the same `Document` or `ShadowRoot` root;
6. the range is cloned immediately.

The user selection is never cleared, collapsed, rewritten, or retained. Once cloned, later selection changes do not change the annotation. The returned controller is the same controller contract as `annotate(range, options)`.

Multiple ranges are rejected as ambiguous rather than silently choosing the first. Whitespace-only text is accepted when the native range is non-collapsed because Range annotation is geometric; serialization remains subject to its separate target-key rules.

A standalone `annotateSelection()` accepts Document-rooted selections, including an explicit Selection from an iframe document. A ShadowRoot-rooted selection must use `scope.annotateSelection(options, selection?)` from an active `createShadowScope(root)` facade. When the scoped `selection` argument is omitted, the facade reads `root.ownerDocument.defaultView?.getSelection()`, never `globalThis.window`, so a scope in an iframe uses its own browsing context. An unavailable owner window produces `HANA_TARGET_SELECTION_UNAVAILABLE`; an explicit Selection still must resolve to the exact scope root. Standalone Shadow selection throws `HANA_TARGET_SHADOW_UNSCOPED`; it never guesses style or resource ownership.

## Errors

All validation failures throw `HanamaruTargetError`:

- `HANA_TARGET_SELECTION_UNAVAILABLE` for no usable selection;
- `HANA_TARGET_SELECTION_EMPTY` for zero ranges or a collapsed range;
- `HANA_TARGET_SELECTION_AMBIGUOUS` for more than one range;
- `HANA_TARGET_SHADOW_UNSCOPED` for a ShadowRoot selection passed to the standalone helper;
- existing `HANA_TARGET_INVALID` semantics for disconnected, cross-document, or cross-root boundaries.

Details include only safe diagnostic primitives such as `rangeCount`, `collapsed`, and root kinds; no live Selection is retained in error details.

## Integration

The helper delegates range ownership, observation, layout, animation, events, and teardown to the existing annotation runtime. It contains no renderer or scheduler fork.

`scope.annotateSelection()` resolves its omitted Selection from `root.ownerDocument.defaultView`, verifies that the cloned Range belongs to that exact scope root, creates the controller through the root-scoped environment, and adds it to the scope's ownership set. Destroying the scope destroys that controller. A Selection controller cannot outlive or transfer away from its creating Shadow scope.

## Verification

Unit and browser tests cover omitted and explicit Selection, one valid range, post-call selection changes, collapsed ranges, multiple ranges, disconnected boundaries, cross-document boundaries, iframe Document selection, iframe Shadow scope omitted-selection lookup, unavailable scope owner window, explicit wrong-root scoped Selection, standalone Shadow rejection, scoped open and retained-closed Shadow selection, scope destruction, reduced motion, abort semantics, and unchanged host selection. Package tests prove the subpath declaration and export resolve without adding the helper to the main entry or IIFE.
