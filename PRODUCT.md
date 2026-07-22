# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

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

Developers evaluate Hanamaru in a repository README and proof-led demo, then consume the locally built ESM or browser-ready assets. A later publication may add npm/CDN distribution, but V1 makes no registry-availability claim. Developers use it on ordinary framework-free HTML as well as framework-rendered DOM, while the runtime itself has no framework dependency.

Annotations appear on responsive prose, headings, controls, and inline content. Authors may trigger them manually, on load, or when content enters the viewport.

## Capabilities and Constraints

- V1 targets DOM elements, CSS selectors, `Range` objects, and scoped exact-text locators.
- V1 marks are underline, highlight, circle, box, strike, and bracket.
- Notes connect to targets with an arrow and automatic top/right/bottom/left placement.
- Stories support ordered playback, pause, resume, replay, cancellation, and completion state.
- Public entry points are data attributes, JavaScript functions, and JSON-compatible story definitions.
- The runtime redraws after relevant resize, scroll, and scoped content changes.
- The runtime ships with zero production dependencies as ESM plus browser-ready JavaScript and CSS.
- The local package name is `hanamaru-annotations`; package publication is outside V1.
- The stretch target is 5 KB gzipped JavaScript; 8 KB gzipped for JavaScript plus base CSS is the hard ceiling.
- V1 excludes browser extensions, arbitrary-site persistence, accounts, cloud sync, collaboration, framework wrappers, image/canvas annotation, and AI or QA rule engines.
- `Hanamaru` is the working brand. Package publication and registry naming are outside the local implementation scope.

## Brand Commitments

The name references the Japanese *hanamaru*, a teacher's flower-circle mark for excellent work. The product should feel precise enough for developer tooling and human enough to resemble a thoughtful red-pen correction. Reliability leads the message; warmth and wit make it memorable.

The approved primary call to action is **Open Live Playground**.

## Evidence on Hand

- The user referenced Neat Annotations and Rough Notation as neighboring open-source projects.
- Product-direction, ecosystem, first-principles, and runtime-experience mockups exist in the ignored `.superpowers/brainstorm/` workspace.
- An Impeccable critique snapshot exists in the ignored `.impeccable/critique/` workspace and scored the concept 22/36, with four P1 findings accepted into V1.
- There are no production users, testimonials, benchmarks, published package metrics, or customer claims. Future surfaces must not fabricate them.

## Product Principles

1. Prove reliability interactively instead of describing it.
2. Keep the easy path one line long while preserving a composable runtime underneath.
3. Treat annotation definitions as portable data and rendering as replaceable presentation.
4. Preserve the host page: missing targets, reduced motion, and teardown must never leave damaged content.
5. Ship personality through authored motion and marks, not through framework weight or ornamental chrome.

## Accessibility & Inclusion

All controls must use native semantics, visible focus, and keyboard operation. Motion must respect `prefers-reduced-motion` while retaining a clear final state. Notes cannot be the sole source of essential information; authors can connect meaningful notes through `aria-describedby`. The demo must remain usable at 200% zoom and a 390-pixel viewport without hiding the product's core proof.
