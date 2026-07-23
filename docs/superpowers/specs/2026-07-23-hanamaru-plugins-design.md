# Hanamaru Custom Mark Plugin Design

**Date:** 2026-07-23  
**Status:** User-approved design; pending independent spec review

## Objective

Let users add deterministic SVG mark shapes while keeping note placement, connectors, animation, accessibility, lifecycle, and teardown under Hanamaru control.

## Public API

```js
import { registerMark } from 'hanamaru-annotations/plugins'

const unregister = registerMark('double-underline', ({ rects, seed, helpers }) => ({
  paths: [
    helpers.line(rects[0].left, rects[0].bottom, rects[0].right, rects[0].bottom, seed),
  ],
}))
```

`registerMark(name, factory)` validates and registers one process-local mark name and returns an idempotent `unregister()` function.

The factory input is a frozen snapshot:

- `rects`: copied target line rectangles;
- `unionRect`: copied union rectangle;
- `seed`: canonical annotation seed;
- `padding`: canonical mark padding;
- `helpers`: frozen deterministic geometry helpers, including seeded `jitter`, `line`, and `closedPath`.

The factory returns `{ paths }`, where `paths` is a non-empty array of SVG path-data strings. Path count is capped at 32 and each string at 16,384 code units. Empty, non-finite, or syntactically invalid path data is rejected before DOM write.

## Registry Rules

Names use lowercase ASCII letters, digits, and single hyphens, start with a letter, and are at most 48 characters. Built-in names cannot be replaced. Duplicate registration throws `HanamaruConfigError`.

Annotation option validation consults the shared registry after checking built-ins. Declarative `data-hana` values use the same validation. A controller captures its factory at successful construction or update; later unregister does not break refresh, replay, or teardown of that controller. New controllers reject the unregistered name.

The registry is shared by all source-built entry points in one JavaScript realm. It is not persisted, serialized as executable code, or copied across iframes. Serialization preserves the mark name; restore requires that name to be registered first.

## Failure Containment

Factory exceptions and invalid return values become `HanamaruStateError` with code `HANA_STATE_MARK_PLUGIN`, mark name, and original cause. No partial SVG is committed. Repeated failure follows the existing suspended-controller recovery model.

Plugins cannot create DOM, notes, connectors, CSS, timers, observers, events, or custom animation handles. This v0.1 boundary is deliberate.

## Verification

Tests cover valid deterministic paths, declarative use, duplicate and built-in names, unregister idempotence, captured-factory lifetime, update between custom marks, factory throw, invalid/cost-bounded output, serialization prerequisites, multiple documents in one realm, CSP-safe rendering, and zero partial DOM after failure. Size and type tests ensure helpers are documented and custom names can be augmented without weakening built-in literal completions.
