# Hanamaru Serialization Design

**Date:** 2026-07-23  
**Status:** User-approved design; pending independent spec review

## Objective

Provide a versioned, JSON-safe representation for Annotation, Story, and Group controllers without inventing brittle selectors for identity-based Element or Range targets.

## Public API

```js
import { serialize, restore } from 'hanamaru-annotations/serialize'

const definition = serialize(controller, {
  keyForTarget(target, context) {
    return context.ownerElement.dataset.annotationKey
  },
})

const restored = restore(definition, {
  root: document,
  resolveTarget(targetKey) {
    return document.querySelector(`[data-annotation-key="${CSS.escape(targetKey)}"]`)
  },
})
```

`serialize()` returns a fresh plain object. `restore()` accepts a parsed object, not a JSON string, validates it synchronously, and returns the controller kind encoded by the definition.

## Schema

The exported declaration types are `SerializedDefinition`, `SerializedAnnotation`, `SerializedStory`, `SerializedGroup`, and `SerializedTarget`. Every top-level definition begins with:

```json
{
  "schema": "hanamaru/v1",
  "kind": "annotation"
}
```

`kind` is `annotation`, `story`, or `group`. Object keys are emitted in the exact order shown below, recursively, so repeated serialization produces byte-stable `JSON.stringify()` output for the same canonical options.

Serializable targets are:

```json
{ "type": "selector", "selector": "#claim" }
{
  "type": "locator",
  "within": { "type": "selector", "selector": "#proof" },
  "text": "exact phrase",
  "occurrence": 0
}
{
  "type": "locator",
  "within": { "type": "key", "key": "proof-container", "targetKind": "element" },
  "text": "exact phrase"
}
{ "type": "key", "key": "review-17", "targetKind": "range" }
```

`targetKind` is `element` or `range`. A locator's `within` accepts only a serialized selector or an element key. String selectors and selector-scoped text locators serialize directly. A locator whose `within` is an Element, a direct Element target, and a native Range target require `keyForTarget`. The callback receives the original accepted target plus `{ role: 'target' | 'within', controllerKind, ownerElement, index? }` and must return a non-empty string. Direct keys preserve whether the resolver must return an Element or Range. Locator `within` keys always require an Element. Hanamaru does not generate CSS paths.

The complete canonical shapes are:

```json
{
  "schema": "hanamaru/v1",
  "kind": "annotation",
  "target": { "type": "selector", "selector": "#claim" },
  "options": {
    "mark": "underline",
    "note": null,
    "placement": "auto",
    "trigger": "manual",
    "accessible": false,
    "seed": "hana-annotation-1",
    "duration": 650,
    "motion": "system"
  }
}
```

```json
{
  "schema": "hanamaru/v1",
  "kind": "story",
  "options": {
    "trigger": "manual",
    "gap": 180,
    "motion": "system"
  },
  "steps": [
    {
      "target": { "type": "selector", "selector": "#claim" },
      "options": {
        "mark": "underline",
        "note": null,
        "placement": "auto",
        "accessible": false,
        "seed": "hana-annotation-2",
        "duration": 650
      }
    }
  ]
}
```

```json
{
  "schema": "hanamaru/v1",
  "kind": "group",
  "options": {
    "trigger": "manual",
    "motion": "system"
  },
  "members": [
    {
      "target": { "type": "selector", "selector": "#claim" },
      "options": {
        "mark": "underline",
        "note": null,
        "placement": "auto",
        "accessible": false,
        "seed": "hana-annotation-3",
        "duration": 650
      }
    }
  ]
}
```

`once` is emitted immediately after `motion` only for a viewport Story that defines it. `occurrence` is omitted when absent. Annotation options always emit all eight canonical keys. Story and Group member options omit the aggregate-owned `trigger` and `motion` keys and emit the remaining six in the shown order. Generated fallback seeds are always emitted.

## Controller Metadata

Core construction records immutable, package-private canonical metadata for each controller. It must not expose live DOM nodes through a public field and must update atomically after a successful annotation `update()`.

Story and Group metadata is assembled from the successfully constructed member Annotation metadata, not raw input copies. It therefore captures every member's generated seed and normalized option defaults. Aggregate metadata stores the ordered member metadata references plus frozen aggregate options. Serialization reads this metadata through the one emitted shared ESM singleton symbol; the symbol is not exported by the package.

## Restore Rules

`restore(definition, { root = document, resolveTarget } = {})`:

- validates plain own-data objects and rejects accessors, unexpected prototypes, unknown keys, and cyclic input;
- rejects unknown schema versions and kinds;
- resolves selectors and locators only inside `root`;
- calls `resolveTarget(key, { targetKind, role, controllerKind, index? })` for `key` targets;
- validates the resolver result through normal target resolution;
- requires an Element result for locator `within` keys and the declared Element or Range kind for direct keys;
- preflights every Story or Group member before mounting any output;
- never partially restores an aggregate.

Resolver exceptions become `HanamaruTargetError` code `HANA_TARGET_RESOLVER` with key, context, and original cause in details. A missing resolver is `HanamaruConfigError`. No callback is invoked before structural schema validation succeeds.

## Errors

Malformed data, unsupported versions, unknown keys, non-finite numbers, and a missing `keyForTarget` callback are `HanamaruConfigError`. A thrown `keyForTarget`, non-string key, or empty key becomes `HanamaruConfigError` code `HANA_CONFIG_SERIALIZE_TARGET` with role and index context. Missing, ambiguous, disconnected, or invalid restored targets are `HanamaruTargetError`. Serialization of a destroyed or foreign controller is `HanamaruStateError`.

## Verification

Tests cover canonical byte stability, all target forms, callback failures, update metadata, generated seeds, nested Story and Group definitions, schema pollution attempts, accessors, cyclic objects, unknown versions, atomic aggregate restore, cross-root restoration, destroyed controllers, and round trips that reproduce final SVG paths and lifecycle behavior. Type tests prove the definition union narrows by `kind` and target `type`.
