# Hanamaru Shadow DOM Design

**Date:** 2026-07-23  
**Status:** User-approved design; pending independent spec review

## Objective

Support explicit ShadowRoot annotation without implicit deep traversal, cross-root ARIA references, duplicate runtime singletons, or ambiguous resource ownership. Visual output intentionally uses root-scoped document portals to preserve viewport geometry and escape host clipping.

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
const restored = scope.restore(definition)

scope.destroy()
```

`createShadowScope(root, options?)` accepts a native connected `ShadowRoot`. It returns scoped `annotate`, `annotateSelection`, `scan`, `story`, `group`, `restore`, `resolveSerializedTarget`, and `destroy`. These facade methods call the same shared implementations with the exact scope root and register every returned controller for scope-owned teardown.

The root-support matrix is normative:

| Operation | Standalone Document or iframe Document | Standalone ShadowRoot | Active Shadow scope |
| --- | --- | --- | --- |
| Annotation, Story, scan | supported | rejected as `HANA_TARGET_SHADOW_UNSCOPED` | scoped facade |
| Selection | supported | rejected as `HANA_TARGET_SHADOW_UNSCOPED` | `scope.annotateSelection()` |
| Group | supported with Document context | rejected as `HANA_TARGET_SHADOW_UNSCOPED` | `scope.group()` |
| restore/serialized target resolution | supported with Document context | rejected as `HANA_TARGET_SHADOW_UNSCOPED` | scoped facade |

Direct Element and Range targets inside a ShadowRoot follow the same scope-only rule even though their owner Document is discoverable.

## Root and Target Rules

Selectors and locator `within` selectors resolve only through the supplied root. Direct Element and native Range targets must belong to that same root. A target in a nested ShadowRoot is cross-root and rejected unless a separate scope is created for the nested root.

Hanamaru never enumerates or automatically enters open roots. Closed roots work only when their creator passes the retained `ShadowRoot`, or when the caller passes a direct Element/Range and creates the scope while retaining that root. A closed root cannot be rediscovered.

## Visual and Accessible Output

Visual SVG marks, connectors, and visible notes use a root-scoped portal appended to the owner Document outside the shadow host. One portal exists per active ShadowRoot and contains its SVG and note layers. This is required because `getBoundingClientRect()` and visual-viewport placement are viewport coordinates, while a fixed descendant of a transformed, contained, or clipped shadow host may use a different containing block or be clipped by host overflow.

For `accessible: true`, the visible document-overlay note is normally `aria-hidden="true"` and an owned visually-hidden description mirror with the same text is created inside the target ShadowRoot. The owner element's `aria-describedby` references only that in-root mirror. If the visible note overflows its bounded area, Hanamaru removes `aria-hidden`, applies `role="note"` and `tabindex="0"`, and preserves keyboard focus and scrolling so none of its visible content becomes unreachable. The mirror remains the target description. When overflow clears and the visible note is not focused, Hanamaru restores `aria-hidden` and removes the role and tab stop. If the note itself is focused, that restoration is deferred until blur; on blur Hanamaru remeasures and restores the ordinary hidden state only if overflow is still absent. It never applies `aria-hidden` to the focused note. Decorative notes never receive a role or tab stop. Generated IDs are unique per Document and root. Teardown removes the visual note, mirror, and only the token Hanamaru owns.

The scoped renderer reads the canonical theme custom properties from the target owner or shadow host during its scheduler read. Mark, note, stroke, padding, note gap, font, duration, and color values are written onto the annotation group and note. `--hana-z-index` is reconciled at the root portal: the current computed value of the scope root's host sets that portal's concrete `z-index`, so different ShadowRoots may use different stacking values without changing the Document runtime portal or each other.

Document-portal output prevents transformed-containing-block drift and host clipping while keeping accessible relationships inside the root. Geometry remains in visual-viewport coordinates and needs no host-local conversion.

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

Hanamaru never removes an author sheet or style. It removes its owned sheet or adoption after the final scope and controller release. In both `sheet` and `preinstalled` modes, scope creation mounts a temporary mirror probe and verifies the required marker custom property after the supplied/adopted styles can apply. This proves that a caller-supplied sheet actually contains the Hanamaru mirror rules rather than merely being a valid or already-adopted sheet. A missing marker, empty or unrelated sheet, or stylesheet install failure rolls back registration, any Hanamaru-added adoption, and owned nodes before throwing `HanamaruStateError`; an author-owned pre-existing adoption remains untouched.

The first live scope for a root records one normalized style configuration. Later scopes on the same root are compatible only when:

- both use `auto` with the same nonce value;
- both use `sheet` with the same `CSSStyleSheet` object; or
- both use `preinstalled`.

Any mismatch throws `HanamaruConfigError` before incrementing the reference count or creating controllers. In `sheet` mode, the registry records whether Hanamaru added the sheet to `adoptedStyleSheets`; final release removes only an adoption it added. A sheet already adopted by the author remains adopted. In `auto`, the one owned sheet/style is shared until the final compatible scope releases it.

## Resource Isolation

Document resource management gains an explicit target-root channel. Window and visual-viewport listeners, note reservations, IDs, and frame scheduler remain shared at the Document level. Each ShadowRoot owns one root-scoped Document portal, MutationObserver target scope, selector resolver, mirror registry, style record, and controller ownership set. The single shared ESM singleton owns both Document and ShadowRoot maps. Events remain bubbling and composed, so host applications may observe them outside the root.

`scope.destroy()` destroys all Annotation, Story, Group, and Selection controllers created by that scope in reverse order, releases its mirror-style reference, and rejects further creation. Controllers are not transferable between scopes. Standalone helpers never borrow an active scope implicitly.

## Verification

Tests cover every row in the root-support matrix, open and retained closed roots, scoped selector and locator resolution, declarative scan, Group, Selection, and restore facade ownership, nested-root rejection, Range targets, accessible in-root mirrors, ordinary visual-note `aria-hidden`, overflow-note keyboard focus and scrolling without an `aria-hidden` focus target, deferred hidden-state restoration while the note remains focused, decorative-note exclusion, theme-value copying, per-root z-index, transformed hosts, `contain`, clipped host overflow, style auto/sheet/preinstalled modes, rejection of empty and unrelated caller sheets, same and conflicting style configurations, author-preinstalled sheet retention, nonce propagation, strict-CSP preinstallation, two scopes sharing one root, two roots in one document with distinct portals, teardown order, stylesheet failure rollback, mutation/reflow observation, visual viewport placement, and reduced motion. Firefox and WebKit smoke include one open-root annotation.
