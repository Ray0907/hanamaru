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
    helpers.line(
      { x: rects[0].left, y: rects[0].bottom },
      { x: rects[0].right, y: rects[0].bottom },
      { label: 'first-line', wobble: 1.5 },
    ),
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

The exported helper signatures are:

```ts
type Point = Readonly<{ x: number; y: number }>

interface MarkHelpers {
  jitter(label: string, amplitude: number): number
  line(
    start: Point,
    end: Point,
    options?: Readonly<{ label?: string; wobble?: number }>,
  ): string
  closedPath(
    points: readonly Point[],
    options?: Readonly<{ label?: string; wobble?: number }>,
  ): string
}
```

`jitter()` returns a deterministic finite offset in the inclusive range `[-amplitude, amplitude]`; `amplitude` must be finite and non-negative. Its seed is the factory input seed and its semantic label is caller-supplied. `line()` requires finite points, defaults to label `line` and wobble `1`, and returns one open `M…Q…` path whose control-point offset is derived from `jitter()`. `closedPath()` requires at least three finite points, defaults to label `closed` and wobble `1`, jitters each indexed point independently, connects them in input order, and closes with `Z`. For identical seed, coordinates, labels, and options, helper output is byte-identical. Helpers never mutate input.

The factory returns `{ paths }`, where `paths` is a non-empty array of SVG path-data strings. Path count is capped at 32 and each string at 16,384 code units. Empty, non-finite, or syntactically invalid path data is rejected before DOM write.

## Registry Rules

Names use lowercase ASCII letters, digits, and single hyphens, start with a letter, and are at most 48 characters. Built-in names cannot be replaced. Duplicate registration throws `HanamaruConfigError`.

Annotation option validation consults the shared registry after checking built-ins. Declarative `data-hana` values use the same validation. A controller captures its factory at successful construction or update; later unregister does not break refresh, replay, or teardown of that controller. New controllers reject the unregistered name.

An `annotation.update()` whose normalized next mark equals its current custom mark retains the captured factory even after unregister, whether or not the patch explicitly repeats the same name. An update that changes away from that mark releases the capture after commit. A later change back performs a fresh registry lookup and rejects if unregistered.

The registry is shared by all source-built entry points in one JavaScript realm. It is not persisted, serialized as executable code, or copied across iframes. Serialization preserves the mark name; restore requires that name to be registered first.

The main declaration exports the augmentable map:

```ts
export interface HanamaruMarkMap {
  underline: true
  highlight: true
  circle: true
  box: true
  strike: true
  bracket: true
}

export type MarkName = Extract<keyof HanamaruMarkMap, string>
```

Consumers add literal names through the named public interface:

```ts
declare module 'hanamaru-annotations' {
  interface HanamaruMarkMap {
    'double-underline': true
  }
}
```

`registerMark()` is generic over `MarkName`; runtime registration is still required and type augmentation alone never installs executable code.

## Failure Containment

Factory exceptions and invalid return values become `HanamaruStateError` with code `HANA_STATE_MARK_PLUGIN`, mark name, and original cause. No partial SVG is committed. Repeated failure follows the existing suspended-controller recovery model.

Plugins cannot create DOM, notes, connectors, CSS, timers, observers, events, or custom animation handles. This v0.1 boundary is deliberate.

## Verification

Tests cover every helper's numeric bounds and golden bytes, valid deterministic paths, declarative use, duplicate and built-in names, unregister idempotence, captured-factory lifetime, same-mark updates after unregister, changes away and back, factory throw, invalid/cost-bounded output, serialization prerequisites, multiple documents in one realm, CSP-safe rendering, and zero partial DOM after failure. Size and type tests ensure the named augmentation interface works without weakening built-in literal completions.
