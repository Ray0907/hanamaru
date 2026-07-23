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

Every definition begins with:

```json
{
  "schema": "hanamaru/v1",
  "kind": "annotation"
}
```

`kind` is `annotation`, `story`, or `group`. Object keys are emitted in canonical order so repeated serialization produces byte-stable `JSON.stringify()` output for the same canonical options.

Serializable targets are:

```json
{ "type": "selector", "selector": "#claim" }
{ "type": "locator", "within": "#proof", "text": "exact phrase", "occurrence": 0 }
{ "type": "key", "key": "review-17" }
```

String selectors and selector-scoped text locators serialize directly. A locator whose `within` is an Element, a direct Element target, and a native Range target require `keyForTarget`. The callback receives the original accepted target plus `{ kind, ownerElement, index? }` and must return a non-empty string. Hanamaru does not generate CSS paths.

Annotation definitions contain canonical annotation options. Story definitions contain canonical story options and ordered step definitions. Group definitions contain canonical group options and member definitions. Generated fallback seeds are serialized so restored geometry is deterministic.

## Controller Metadata

Core construction records an immutable, package-private canonical source definition for each controller. It must not expose live DOM nodes through a public field and must update atomically after a successful annotation `update()`. Story and Group metadata own frozen copies of their input definitions. Serialization reads this metadata through an internal symbol shared at source-build time; the symbol is not exported by the package.

## Restore Rules

`restore(definition, { root = document, resolveTarget } = {})`:

- validates plain own-data objects and rejects accessors, unexpected prototypes, unknown keys, and cyclic input;
- rejects unknown schema versions and kinds;
- resolves selectors and locators only inside `root`;
- requires `resolveTarget` for `key` targets;
- validates the resolver result through normal target resolution;
- preflights every Story or Group member before mounting any output;
- never partially restores an aggregate.

Resolver exceptions become `HanamaruTargetError` with the original cause in details. No callback is invoked before structural schema validation succeeds.

## Errors

Malformed data, unsupported versions, unknown keys, non-finite numbers, and a missing `keyForTarget` callback are `HanamaruConfigError`. Missing, ambiguous, disconnected, or invalid restored targets are `HanamaruTargetError`. Serialization of a destroyed or foreign controller is `HanamaruStateError`.

## Verification

Tests cover canonical byte stability, all target forms, callback failures, update metadata, generated seeds, nested Story and Group definitions, schema pollution attempts, accessors, cyclic objects, unknown versions, atomic aggregate restore, cross-root restoration, destroyed controllers, and round trips that reproduce final SVG paths and lifecycle behavior. Type tests prove the definition union narrows by `kind` and target `type`.
