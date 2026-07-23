# Hanamaru Shadow DOM Design

**Date:** 2026-07-23  
**Status:** User-approved design; pending independent spec review

## Objective

Support explicit ShadowRoot annotation without implicit deep traversal, cross-root ARIA references, or document-global overlay leakage.

## Public API

```js
import { createShadowScope } from 'hanamaru-annotations/shadow'

const scope = createShadowScope(shadowRoot)

const annotation = scope.annotate('.claim', {
  mark: 'circle',
  note: 'Scoped to this component',
  accessible: true,
})

const scanned = scope.scan()
const walkthrough = scope.story(steps)
const simultaneous = scope.group(members)
const selected = scope.annotateSelection(options)

scope.destroy()
```

`createShadowScope(root, options?)` accepts a native connected `ShadowRoot`. It returns scoped `annotate`, `annotateSelection`, `scan`, `story`, `group`, and `destroy`. These facade methods call the same shared Selection and Group implementations with the exact scope root and register every returned controller for scope-owned teardown.

## Root and Target Rules

Selectors and locator `within` selectors resolve only through the supplied root. Direct Element and native Range targets must belong to that same root. A target in a nested ShadowRoot is cross-root and rejected unless a separate scope is created for the nested root.

Hanamaru never enumerates or automatically enters open roots. Closed roots work only when their creator passes the retained `ShadowRoot`, or when the caller passes a direct Element/Range and creates the scope while retaining that root. A closed root cannot be rediscovered.

## Visual and Accessible Output

Visual SVG marks, connectors, and visible notes use the owner Document's shared top-level overlay. This is required because `getBoundingClientRect()` and visual-viewport placement are viewport coordinates, while a fixed descendant of a transformed, contained, or clipped shadow host may use a different containing block or be clipped by host overflow.

For `accessible: true`, the visible document-overlay note remains `aria-hidden="true"` and an owned visually-hidden description mirror with the same text is created inside the target ShadowRoot. The owner element's `aria-describedby` references only that in-root mirror. Generated IDs are unique per Document and root. Teardown removes the visual note, mirror, and only the token Hanamaru owns.

The scoped renderer reads the canonical theme custom properties from the target owner or shadow host during its scheduler read and writes those resolved values onto the visual overlay group and note. Shadow styling therefore remains caller-controlled without relying on inheritance across the root boundary.

Document-overlay output prevents transformed-containing-block drift and host clipping while keeping accessible relationships inside the root. Geometry remains in visual-viewport coordinates and needs no host-local conversion.

## Styles

The regular `hanamaru.css` remains required in the owner Document for visual overlay output. Scope creation also installs or verifies the minimal `hanamaru-shadow.css` accessibility-mirror stylesheet once per root and reference-counts scopes.

`options.styles` is one of:

```ts
type ShadowStyles =
  | { mode?: 'auto'; nonce?: string }
  | { mode: 'sheet'; sheet: CSSStyleSheet }
  | { mode: 'preinstalled' }
```

- `auto` uses one constructable `CSSStyleSheet` when supported, otherwise appends one owned `<style data-hana-shadow-style>` and applies the optional nonce;
- `sheet` adopts the caller-supplied sheet without modifying or later removing the sheet itself; it only removes Hanamaru's adoption reference;
- `preinstalled` performs no dynamic style creation and requires the caller to have installed `hanamaru-shadow.css` in that root, which is the strict-CSP path.

Hanamaru never removes an author sheet or style. It removes its owned sheet or adoption after the final scope and controller release. In `preinstalled` mode, scope creation verifies the required marker custom property on a temporary mirror probe before registration. A missing marker or stylesheet install failure rolls back registration and owned nodes before throwing `HanamaruStateError`.

## Resource Isolation

Document resource management gains an explicit target-root channel. Window, visual-viewport listeners, visual overlay, note reservations, IDs, and frame scheduler remain shared at the Document level. MutationObserver target scopes, selector resolution, mirror ownership, and controller ownership are isolated per ShadowRoot. The single shared ESM singleton owns both maps. Events remain bubbling and composed, so host applications may observe them outside the root.

`scope.destroy()` destroys all Annotation, Story, Group, and Selection controllers created by that scope in reverse order, releases its mirror-style reference, and rejects further creation. Controllers are not transferable between scopes. Standalone helpers never borrow an active scope implicitly.

## Verification

Tests cover open and retained closed roots, scoped selector and locator resolution, declarative scan, Group and Selection facade ownership, nested-root rejection, Range targets, accessible in-root mirrors, visual-note `aria-hidden`, theme-value copying, transformed hosts, `contain`, clipped host overflow, style auto/sheet/preinstalled modes, nonce propagation, strict-CSP preinstallation, two scopes sharing one root, two roots in one document, teardown order, stylesheet failure rollback, mutation/reflow observation, visual viewport placement, reduced motion, and one shared Document visual overlay without ShadowRoot-owned visual layers. Firefox and WebKit smoke include one open-root annotation.
