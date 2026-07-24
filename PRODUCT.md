# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Release Status

Hanamaru `0.1.0` is implemented as a typed, modular release candidate. The repository includes the complete runtime, optional ESM subpaths, declarations, Inspector, documentation, independent package verification, and least-privilege CI/release workflows. Public GitHub/npm availability remains a publication step, not a claim made by the prepared source tree.

## Users

Hanamaru primarily serves frontend developers building landing pages, documentation, tutorials, product education, and editorial experiences. They want to emphasize or explain live DOM content without hand-positioning decorative SVGs or adopting a framework.

Secondary users are tool authors whose CMS, QA checker, linter, or AI system can emit annotation data for Hanamaru to render.

## Product Purpose

Hanamaru is a CSS and tiny-JavaScript annotation runtime. It attaches expressive marks, callouts, and ordered stories to DOM elements or text ranges, then keeps them legible through layout changes.

Success means a developer can understand the mechanism from the first viewport, try it in a live playground, adopt it through one line of HTML or a small JavaScript API, and trust its responsive and accessible behavior.

## Positioning

Hanamaru's hard promise is reliable, data-driven annotation: target an element or unwrapped text range, place a mark or note automatically, and replay it as a story while the page reflows. Its hand-drawn personality makes the mechanism memorable; it is not the mechanism itself.

Unlike a visual CSS snippet collection, Hanamaru owns target resolution, measurement, placement, lifecycle, and playback. Unlike imperative drawing-only libraries, it provides declarative HTML, programmatic JavaScript, and portable JSON-shaped story data.

## Operating Context

Developers evaluate Hanamaru in a repository README and proof-led demo, use the Annotation Inspector on real text, then consume the package through its core or optional ESM exports. The prepared npm package is `hanamaru-annotations@0.1.0`; a version-pinned CDN example points directly at published `dist` ESM/CSS files without inventing UMD behavior. Until the publication task succeeds, documentation describes these as release instructions rather than registry-availability evidence.

Annotations appear on responsive prose, headings, controls, inline content, native Ranges, and explicitly scoped Shadow DOM. Authors may trigger core annotations manually, on load, or when content enters the viewport. React, Vue, and Svelte adapters own manual Annotation lifecycle only.

## Capabilities and Constraints

- `0.1.0` targets DOM elements, CSS selectors, `Range` objects, and scoped exact-text locators.
- The six built-in marks are underline, highlight, circle, box, strike, and bracket.
- Notes connect to targets with an arrow and automatic top/right/bottom/left placement.
- Stories support ordered playback, pause, resume, replay, cancellation, and completion state.
- Public entry points are data attributes, JavaScript functions, and JSON-compatible story definitions.
- The runtime redraws after relevant resize, scroll, and scoped content changes.
- Selection, Group, plugins, and serialization are implemented as optional subpaths over one shared singleton.
- Custom mark factories are trusted executable JavaScript. Hanamaru bounds their returned SVG path data but does not sandbox application/plugin side effects.
- Shadow DOM support uses an explicit exact-root scope with open and retained-closed roots, no implicit deep traversal, and CSP-aware style ownership.
- React, Vue, and Svelte adapters are thin optional-peer lifecycle bindings with no duplicate renderer or runtime.
- The Annotation Inspector converts real selections into marks and honest HTML/JavaScript/versioned-JSON output without mutating article text.
- The runtime ships with zero production dependencies as split ESM, a self-contained core IIFE, base/Shadow CSS, and declarations for every public entry.
- Schema-v2 size checks enforce closure-specific hard caps: main ESM 28,672 bytes, IIFE 24,576 bytes, and separate 3,072–21,504-byte optional budgets under gzip level 9.
- Accounts, cloud sync, collaboration, arbitrary-site persistence, browser extensions, image/canvas/freehand annotation, drag-position editing, and AI/QA rule engines remain outside `0.1.0`.
- `Hanamaru` is the release brand and `hanamaru-annotations` is the package name.

## Brand Commitments

The name references the Japanese *hanamaru*, a teacher's flower-circle mark for excellent work. The product should feel precise enough for developer tooling and human enough to resemble a thoughtful red-pen correction. Reliability leads the message; warmth and wit make it memorable.

The approved primary call to action is **Open Live Playground**.

## Evidence on Hand

- The user referenced Neat Annotations and Rough Notation as neighboring open-source projects.
- Product-direction, ecosystem, first-principles, and runtime-experience mockups exist in the ignored `.superpowers/brainstorm/` workspace.
- An Impeccable critique snapshot exists in the ignored `.impeccable/critique/` workspace and scored the concept 22/36, with four P1 findings accepted into V1.
- The current schema-v2 report measures the complete main ESM closure at 28,156 gzip bytes and the core IIFE closure at 24,069; both pass their release hard caps. Every optional closure also passes its dedicated hard cap. This replaces historical estimates with reproducible graph-aware measurements.
- Automated suites cover unit/type/build/package contracts, full Chromium behavior, Firefox/WebKit smoke, and isolated framework endpoints. Real-Chrome Inspector evidence covers desktop and 390-pixel mobile states, keyboard operation, reduced motion, bounds, focus return, and horizontal overflow.
- There are no production users, testimonials, benchmarks, published package metrics, or customer claims. Future surfaces must not fabricate them.

## Product Principles

1. Prove reliability interactively instead of describing it.
2. Keep the easy path one line long while preserving a composable runtime underneath.
3. Treat annotation definitions as portable data and rendering as replaceable presentation.
4. Preserve the host page: missing targets, reduced motion, and teardown must never leave damaged content.
5. Ship personality through authored motion and marks, not through framework weight or ornamental chrome.

## Accessibility & Inclusion

All controls must use native semantics, visible focus, and keyboard operation. Motion must respect `prefers-reduced-motion` while retaining a clear final state. Notes cannot be the sole source of essential information; authors can connect meaningful notes through `aria-describedby`. The demo must remain usable at 200% zoom and a 390-pixel viewport without hiding the product's core proof.
