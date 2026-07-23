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

scope.destroy()
```

`createShadowScope(root, options?)` accepts a native connected `ShadowRoot`. It returns scoped `annotate`, `scan`, `story`, and `destroy`. Group is imported separately and is not duplicated on the scope.

## Root and Target Rules

Selectors and locator `within` selectors resolve only through the supplied root. Direct Element and native Range targets must belong to that same root. A target in a nested ShadowRoot is cross-root and rejected unless a separate scope is created for the nested root.

Hanamaru never enumerates or automatically enters open roots. Closed roots work only when their creator passes the retained `ShadowRoot`, or when the caller passes a direct Element/Range and creates the scope while retaining that root. A closed root cannot be rediscovered.

The overlay, SVG layer, note layer, notes, and generated IDs live in the same ShadowRoot. Accessible notes therefore remain valid `aria-describedby` targets inside that tree. Geometry stays in visual-viewport coordinates, matching `getBoundingClientRect()`.

## Styles

Scope creation installs the canonical runtime stylesheet once per root and reference-counts scopes:

1. use a constructable `CSSStyleSheet` and `adoptedStyleSheets` when supported;
2. otherwise append one owned `<style data-hana-shadow-style>`;
3. never remove an author sheet or style;
4. remove the Hanamaru sheet after the final scope and controller release.

`options.cssText` may replace the canonical stylesheet for strict CSP or preprocessed themes, but it must be a string. A stylesheet install failure rolls back registration and owned nodes before throwing `HanamaruStateError`.

## Resource Isolation

Document resource management is generalized to a root-scoped resource host. Window and visual-viewport listeners may be shared at the document level; MutationObserver, overlay ownership, note reservations, and controller registries are isolated per Document or ShadowRoot. Events remain bubbling and composed, so host applications may observe them outside the root.

`scope.destroy()` destroys all controllers created by that scope in reverse order, releases its style reference, and rejects further creation. Controllers are not transferable between scopes.

## Verification

Tests cover open and retained closed roots, scoped selector and locator resolution, declarative scan, nested-root rejection, Range targets, accessible note association, style adoption and fallback, two scopes sharing one root, two roots in one document, teardown order, stylesheet failure rollback, mutation/reflow observation, visual viewport placement, reduced motion, and no document-level overlay leakage. Firefox and WebKit smoke include one open-root annotation.
