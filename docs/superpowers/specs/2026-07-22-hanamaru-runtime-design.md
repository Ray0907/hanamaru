# Hanamaru Annotation Runtime Design

**Date:** 2026-07-22  
**Status:** Approved direction, ready for implementation planning after spec review  
**Product:** Hanamaru, a reliable and expressive DOM annotation runtime

## 1. Objective

Build a framework-free open-source annotation runtime and proof-led demo. A developer must be able to attach hand-drawn marks and notes to DOM elements or unwrapped text, keep them positioned as layout changes, and play ordered annotation stories through a declarative or programmatic API.

The first viewport must prove the mechanism. Reliability is the product claim; the Japanese red-pen personality makes it memorable. The primary action is **Open Live Playground**.

## 2. Success Criteria

V1 is successful when all of the following are true:

1. A developer can create an annotation with one data attribute or one JavaScript call.
2. An exact-text target can be annotated without adding a wrapper element.
3. Notes and connectors automatically choose a legible side and remain attached after viewport or specimen-width changes.
4. A story can play, pause, resume, cancel, replay, and report its state.
5. Missing and ambiguous targets fail predictably without corrupting host content or partially playing a story.
6. Reduced-motion users receive the complete final state without animated interpolation.
7. The live demo proves Range targeting, responsive placement, all six marks, lifecycle controls, and the three API levels.
8. Shipped JavaScript has zero production dependencies. JavaScript aims for 5 KB gzipped; JavaScript plus base CSS must not exceed 8 KB gzipped.
9. The fixed `npm run verify` command passes, followed by Computer Use inspection at desktop and mobile acceptance states.

## 3. Scope

### Included

- Targets: `Element`, CSS selector, native `Range`, and scoped exact-text locator.
- Marks: `underline`, `highlight`, `circle`, `box`, `strike`, and `bracket`.
- Callouts: text note, connector arrow, and `auto | top | right | bottom | left` placement.
- Triggers: `manual`, `load`, and `viewport`.
- Lifecycle: show, hide, update, play, pause, resume, cancel, replay, refresh, destroy.
- Entry points: declarative data attributes, imperative JavaScript, and JSON-compatible story definitions.
- Responsive remeasurement after relevant scroll, resize, and scoped content changes.
- CSS custom-property theming; gallery-style recipes remain demo examples rather than V1 runtime API.
- Proof-led landing page and interactive playground.
- ESM, browser-ready JavaScript, and base CSS distributions.

### Excluded

- Browser extensions and arbitrary-site persistence.
- Accounts, cloud storage, collaboration, or shared review links.
- React, Vue, or other framework wrappers.
- AI generation, QA rules, or lint engines.
- Image, canvas, or freehand annotation.
- Drag-and-drop layout editing.
- Shadow-root and cross-iframe targeting in V1.
- Package publication and production deployment.

## 4. Repository Shape

```text
src/
  index.js               public exports
  annotation.js          single-annotation lifecycle
  story.js               ordered story state machine
  target.js              target resolution and text matching
  geometry.js            pure rect and placement calculations
  renderer.js            SVG/DOM overlay rendering
  scheduler.js           observation and frame coalescing
  errors.js              typed public errors
  hanamaru.css           base styles and theme variables
demo/
  index.html              proof-led landing and playground
  demo.css                Living Redline surface styles
  demo.js                 demo controls and examples
tests/
  unit/                   node:test coverage for pure logic and validation
  e2e/                    Playwright browser and accessibility behavior
scripts/
  build.mjs               zero-runtime-dependency bundle generation
  check-size.mjs          gzip budget enforcement
package.json
playwright.config.js
README.md
LICENSE
```

Each runtime module has one purpose and depends only inward on lower-level pure helpers. Demo code consumes the public `src/index.js` API and cannot import internals.

## 5. Public API

### 5.0 Distribution and Bootstrap

The local package name is `hanamaru-annotations`. Publication is not part of this implementation, so no surface claims registry availability. `npm install` installs repository development dependencies; `npm run build` creates:

- `dist/hanamaru.esm.js` — ES2020 module;
- `dist/hanamaru.iife.js` — ES2020 browser script exposing `window.Hanamaru`;
- `dist/hanamaru.css` — required base styles.

The exact local quick start is:

```html
<link rel="stylesheet" href="./dist/hanamaru.css">
<script type="module">
  import { scan } from './dist/hanamaru.esm.js'
  scan()
</script>
```

The IIFE equivalent is:

```html
<link rel="stylesheet" href="./dist/hanamaru.css">
<script src="./dist/hanamaru.iife.js"></script>
<script>Hanamaru.scan()</script>
```

Neither build auto-scans. Explicit bootstrap prevents hidden work and lets applications choose timing. README and demo links target real local sections: `#quick-start`, `#api`, and `#limitations`.

### 5.1 Declarative HTML

```html
<span
  data-hana="highlight"
  data-hana-note="No wrapper logic required"
  data-hana-placement="auto"
>
  responsive annotation
</span>
```

`hana.scan(root = document)` finds `[data-hana]` elements and returns:

```js
{
  annotations: Annotation[],
  errors: HanamaruError[]
}
```

Invalid declarative nodes are skipped and reported without blocking valid siblings.

Supported declarative attributes are canonical equivalents of the annotation option matrix:

| Attribute | Parsed value |
|---|---|
| `data-hana` | required `mark` enum |
| `data-hana-note` | `note` string |
| `data-hana-placement` | placement enum |
| `data-hana-trigger` | trigger enum |
| `data-hana-accessible` | boolean; present means `true`, absent means `false` |
| `data-hana-seed` | string seed |
| `data-hana-duration` | non-negative integer milliseconds |
| `data-hana-motion` | motion enum |

Unknown `data-hana-*` attributes are ignored. Known attributes with invalid values produce a collected `HanamaruConfigError`.

### 5.2 Imperative Annotation

```js
const annotation = hana.annotate(
  { within: '#hero', text: 'responsive annotation' },
  {
    mark: 'highlight',
    note: 'Still attached after reflow',
    placement: 'auto',
    trigger: 'manual'
  }
)

annotation.show()
annotation.refresh()
annotation.update({ note: 'Updated note', target: nextRange })
annotation.hide()
annotation.destroy()
```

`annotate(target, options)` resolves and validates synchronously. It throws a typed error before mutating the page when resolution or configuration fails. `update(patch)` resolves and validates a replacement target/options atomically, then swaps them; a failed update leaves the previous annotation untouched.

### 5.3 Story

```js
const story = hana.story([
  {
    target: { within: '#hero', text: 'reliable runtime' },
    mark: 'circle'
  },
  {
    target: '#reflow-proof',
    mark: 'highlight',
    note: 'Resize me',
    placement: 'auto'
  }
], {
  trigger: 'manual',
  gap: 180
})

story.play()
story.pause()
story.resume()
story.cancel()
story.replay()
story.destroy()
```

Stories validate every step and resolve every initial target before creating overlays. Any invalid step rejects construction with a `HanamaruConfigError` or `HanamaruTargetError`; no partial story is mounted.

Each story step uses the annotation option matrix except `trigger` and `motion`; the story owns both triggering and its run-wide motion policy. Story options are:

| Option | Type | Default | Meaning |
|---|---|---:|---|
| `trigger` | `manual \| load \| viewport` | `manual` | starts the story |
| `gap` | non-negative integer milliseconds | `180` | delay between completed steps |
| `once` | boolean | `true` for viewport; not applicable otherwise | viewport stories play only on first entry |
| `motion` | `system \| always \| never` | `system` | story-wide motion policy inherited by steps unless a step is `never` |

An explicitly supplied `once` is rejected unless `trigger` is `viewport`.

### 5.4 Lifecycle Events and State

Annotations and stories expose `state` and a per-run `finished` Promise. Control methods return the controller for chaining. `finished` resolves on `visible` for an annotation or `complete` for a story; it rejects with `AbortError` after hide/cancel/destroy and with the typed runtime error after target loss.

Every resolved target has an `ownerElement`: the target element for `Element`/selector targets, the nearest element containing a native Range's common ancestor, and the resolved `within` element for a text locator. Events dispatch from `ownerElement` as bubbling, composed `CustomEvent`s. Story-level events dispatch from the first step's owner element. Event payloads are:

| Event | Controllers | `detail` |
|---|---|---|
| `hana:start` | annotation, story | `{ controller, state }` |
| `hana:step` | story | `{ controller, index, total, annotation }` |
| `hana:pause` | story | `{ controller, index }` |
| `hana:complete` | annotation, story | `{ controller, state }` |
| `hana:cancel` | annotation, story | `{ controller, reason }` |
| `hana:error` | annotation, story | `{ controller, error, index? }` |

Annotation states and valid transitions are:

```text
idle --show/replay--> showing --finish--> visible
visible --hide--> hidden
showing --hide--> hidden
idle/hidden/visible --refresh failure--> suspended
suspended --successful refresh/update--> hidden or visible (preserve requested visibility)
any non-destroyed state --destroy--> destroyed
replay from any non-destroyed state cancels the current run, resets, then enters showing
```

Story states and valid transitions are:

```text
idle --play/replay--> playing --finish--> complete
playing --pause--> paused --resume--> playing
playing/paused --cancel--> cancelled
idle/playing/paused/complete/cancelled --replay--> playing
any non-destroyed state --destroy--> destroyed
```

`play()` is valid only from `idle`; later runs use `replay()`. An invalid transition is a no-op returning the controller. `destroy()` is idempotent. A replay first cancels any pending animation and gap timer, hides every story annotation, revalidates all targets, creates a new `finished` Promise, then starts at index zero.

Trigger semantics are fixed:

- `manual`: never starts automatically.
- `load`: if `DOMContentLoaded` has not fired, attach a one-shot listener; otherwise start in a microtask.
- `viewport`: observe the first target at threshold `0.25`; `once: true` disconnects after the first start, while `once: false` cancels on full exit and replays on the next qualifying entry.

### 5.5 Annotation Option Matrix

| Option | Type | Default | Validation and behavior |
|---|---|---:|---|
| `mark` | six-mark enum | required | invalid/missing throws configuration error |
| `note` | string or `null` | `null` | empty string normalizes to `null` |
| `placement` | `auto \| top \| right \| bottom \| left` | `auto` | a preference; viewport visibility always wins |
| `trigger` | `manual \| load \| viewport` | `manual` | controls annotation `show()` timing |
| `accessible` | boolean | `false` | associates a meaningful note with `ownerElement` |
| `seed` | string or finite number | generated instance ID | stable for that controller's lifetime and replays |
| `duration` | non-negative integer milliseconds | `650` | total mark/connector/note animation duration |
| `motion` | `system \| always \| never` | `system` | `system` follows the media query |

Connector maximum distance, multiline rendering policy, safe insets, and note width are internal constants in V1, not public options. `underline` and `highlight` render per line; the other four marks use the union rectangle.

## 6. Target Resolution

Supported target forms:

1. `Element`: measured directly.
2. CSS selector string: queried from `document`; zero or multiple matches throw a target error.
3. Native `Range`: cloned and measured while its boundary nodes remain connected. `refresh()` only remeasures the same nodes. After node replacement, the annotation suspends and requires `update({ target: nextRange })`.
4. Text locator: `{ within, text, occurrence? }`, where `within` is an `Element` or unique selector.

Text matching walks descendant text nodes in document order, excluding `script`, `style`, `noscript`, `template`, `[hidden]`, and `[inert]` subtrees. Both source text and locator text are trimmed and normalize consecutive Unicode whitespace to one ASCII space while preserving a mapping back to text-node offsets. Matching is case-sensitive and exact in V1. Matches are non-overlapping and ordered left to right. `occurrence` is zero-based.

The `within` element or selector must resolve uniquely and be connected. If `within` is a selector, refresh re-queries it and can recover after the container is replaced with a new unique match. If `within` is an `Element`, identity is by object; disconnection suspends the target and a different replacement element is not adopted implicitly.

- Zero matches: `HANA_TARGET_MISSING`.
- Multiple matches without `occurrence`: `HANA_TARGET_AMBIGUOUS`.
- Out-of-range `occurrence`: `HANA_TARGET_MISSING`.
- Invalid selector or disconnected Range: `HANA_TARGET_INVALID`.
- Disconnected or non-unique `within`: `HANA_TARGET_INVALID` or `HANA_TARGET_AMBIGUOUS` respectively.

The resolver never injects wrappers or changes source text. A locator retains enough information to re-resolve after scoped mutation.

## 7. Geometry and Placement

The runtime creates one shared document-level overlay root with `position: fixed; inset: 0; overflow: visible; pointer-events: none`. All geometry is expressed in viewport coordinates from client rects. Marks and connectors render in SVG; notes render as fixed semantic DOM inside the overlay. The browser viewport clips marks naturally, while note boxes are clamped inside the defined safe inset. Overlay nodes carry stable annotation IDs and no host-global element IDs.

Measurement uses `getBoundingClientRect()` and `Range.getClientRects()`. Multiline highlights and underlines receive per-line paths; circle, box, strike, and bracket use the union rectangle.

Automatic placement evaluates top, right, bottom, and left candidates. Each candidate receives penalties for:

- viewport overflow;
- overlap with the target;
- overlap with already placed visible notes;
- connector distance beyond the internal 240px preference.

The viewport safe inset is 12px. Notes use `max-width: min(18rem, calc(100vw - 24px))` and `overflow-wrap: anywhere`. The lowest-penalty candidate wins. Ties prefer right, top, bottom, then left in left-to-right documents; the order mirrors for RTL documents. An explicit placement is tried first, then its opposite, then automatic candidates. The final note rectangle is clamped fully inside the safe inset even when every candidate overflows; the connector redraws to the clamped edge. No placement may intentionally hide part of a note.

Placement is deterministic for identical rectangles and viewport size, enabling pure unit tests.

## 8. Observation and Scheduling

`ResizeObserver` watches target elements, text-locator containers, and rendered notes. Scroll listeners are registered passively on every scrollable ancestor plus `window`. A shared `MutationObserver` watches the smallest stable scope that can change identity or position: the target parent for direct Elements, `document` for selector targets, and the resolved `within` container for text locators. It observes `childList`, `subtree`, `characterData`, and the `class`, `style`, and `hidden` attributes. Window resize and every observer/listener enqueue refresh through one `requestAnimationFrame` scheduler. Pure CSS animation or transform movement that produces none of these signals requires the documented `refresh()` call in V1.

The scheduler deduplicates annotation IDs and performs all reads before writes to avoid layout thrashing. Shared overlay, scheduler, scroll listeners, and observers are owned by a per-document resource manager with reference counts. Destroying one annotation removes only its subscriptions. The overlay and global listeners are removed when the final controller is destroyed. Every queued job captures a controller generation token and exits before render if the controller was destroyed or superseded.

Hidden or disconnected targets enter `suspended`, hide their overlay nodes, retain configuration and requested visibility, and dispatch one error per disconnected episode. Selector and locator targets re-resolve after scoped mutations and automatically recover; direct Elements and native Ranges recover only if the same nodes reconnect or `update()` supplies a new target.

Before each story step begins, its target is re-resolved and measured. If the active or any future target becomes invalid after construction, the story dispatches `hana:error` with the step index, transitions to `cancelled`, rejects `finished`, and retains already completed marks for diagnosis. `replay()` clears them and revalidates every target atomically; if validation still fails, it throws before a new run starts and remains `cancelled`.

## 9. Rendering and Theming

Paths are generated from deterministic seeded control points so a replay preserves the same hand. The canonical `seed` option or controller instance ID controls the variation. No canvas is used.

Base CSS exposes:

```css
--hana-color
--hana-mark-color
--hana-note-color
--hana-stroke-width
--hana-padding
--hana-note-gap
--hana-font
--hana-duration
--hana-z-index
```

The runtime owns only `.hana-*` selectors and `data-hana-*` attributes. It never styles bare elements or generic classes. Gallery-like combinations appear as copyable demo recipes built from public options and CSS variables; they do not add runtime API or base bundle code.

## 10. Motion and Reduced Motion

The authored sequence is: activate corresponding code step, draw mark, draw connector, settle note, advance. JavaScript coordinates the state machine while CSS animations perform stroke and note transitions.

Replay removes active classes, forces no synchronous layout read beyond the scheduler boundary, restores the initial state, and restarts on the next animation frame. Pause and resume use the Web Animations API when available and a time-accounting fallback when unavailable.

The canonical `motion` option controls animation. `system` follows `prefers-reduced-motion`, `never` always skips interpolation, and `always` animates even when the system requests reduction; documentation warns against overriding user preference without a specific user-controlled setting. When motion is reduced, durations become zero, all content appears in its complete state, and lifecycle events fire in the same logical order.

## 11. Accessibility Contract

- Runtime marks are decorative and `aria-hidden="true"`.
- Notes default to decorative. With `accessible: true`, the runtime gives the note a stable ID and associates it with `ownerElement`. A per-element token registry tracks only Hanamaru-owned IDs. Destroy removes that annotation's token while preserving author tokens, concurrent Hanamaru notes, and author changes made after mount; out-of-order teardown is safe.
- Notes never replace essential visible instructions or status.
- Demo tabs use the ARIA tabs pattern with native buttons and arrow-key navigation.
- Replay, pause, copy, mark selection, and the reflow ruler are native controls with visible focus.
- Playback state is exposed through visible text and a polite live region; drawing motion itself is not narrated step by step.
- The demo remains usable at 200% zoom and 390px viewport width.

## 12. Error Handling

Public typed errors extend `Error` and contain `code`, `message`, and optional `details`:

- `HanamaruTargetError`: missing, ambiguous, invalid, or disconnected target.
- `HanamaruConfigError`: unsupported mark, placement, trigger, timing, or malformed story.
- `HanamaruStateError`: unexpected asynchronous renderer or scheduler failure; invalid public lifecycle transitions remain no-ops.

Imperative construction throws before DOM mutation. Declarative scanning collects errors. Runtime disconnection suspends an annotation rather than throwing repeatedly. Unexpected refresh failures dispatch one `hana:error`, hide only the affected annotation, and leave other annotations running.

Copy-to-clipboard failure in the demo reveals a selectable fallback code field. Unsupported optional browser APIs degrade as follows:

- No `ResizeObserver`: window resize plus explicit `refresh()`.
- No `IntersectionObserver`: viewport trigger degrades to load.
- No Web Animations API: CSS animation and internal elapsed-time fallback.
- No CSS Highlight API: irrelevant to correctness because V1 Range rendering uses SVG geometry.

## 13. Demo and Playground

The landing surface follows `DESIGN.md`'s Living Redline system.

### First viewport

- A proof sheet demonstrates scoped exact-text locator targeting without wrapper injection. A separate API example demonstrates a native `Range` and its `update({ target })` replacement contract.
- A synchronized code tray highlights the active story object.
- Replay, pause/resume, completion state, accessible API tabs, and code copy are real.
- The primary correction-stamp CTA opens or scrolls to the live playground.
- A secondary **Copy local starter** action copies the exact ESM bootstrap from Section 5.0. The adjacent text states that registry publication is not part of this local build.

### Proof sections

1. **Reflow challenge:** a labeled range input changes the proof width from 320 to 760px while a note remains placed.
2. **Specimen ledger:** all six marks can be selected and replayed.
3. **API modes:** HTML, Story API, and JSON tabs alter real runnable definitions.
4. **Reliability docket:** zero runtime dependencies, measured local gzip size, CSS-variable theming, ES2020 ESM/IIFE outputs, supported triggers, graceful fallbacks, and explicit V1 limitations.

### Playground controls

The user selects existing specimen text, mark, note, placement, and trigger, then runs the annotation and copies the corresponding HTML or JavaScript. V1 does not permit arbitrary page editing or drag positioning.

## 14. Testing and Verification

### Automated verification

`npm run verify` is the fixed authoritative functional command across Codex Loop rounds. It runs, in order:

1. `node --test tests/unit/**/*.test.js` for target validation, geometry, candidate scoring, state transitions, and configuration validation.
2. Production build for `hanamaru.esm.js`, `hanamaru.iife.js`, and `hanamaru.css`, targeting ES2020 evergreen browsers.
3. Distribution check that asserts `package.json` has no `dependencies`, `npm ls --omit=dev --json` reports no production packages, and both `gzip(ESM, level 9) + gzip(CSS, level 9)` and `gzip(IIFE, level 9) + gzip(CSS, level 9)` are at most 8192 bytes. It reports, but does not fail, the 5120-byte JavaScript stretch target for each format.
4. Playwright E2E tests against the built demo.

E2E coverage must include:

- one-line declarative scan;
- exact-text Range without wrapper injection;
- missing and ambiguous target behavior;
- story play, pause, resume, cancel, replay, and completion;
- code-step synchronization;
- real API tabs and copy fallback;
- keyboard operation and visible focus;
- reduced-motion final state;
- 390px layout without page overflow or hidden callouts;
- 200% browser zoom with usable controls and visible callouts;
- reflow ruler retaining note attachment;
- nested scroll, target/container replacement, note wrapping, and concurrent accessible-note teardown;
- cleanup after destroy.

A zero-test run is a failure.

### Computer Use verification

After `npm run verify` passes, Computer Use is authoritative for rendered appearance.

- **Target:** local built Hanamaru demo in Google Chrome.
- **Desktop:** 1440x900, light theme, default motion. Inspect first viewport, story playback states, synchronized code, primary CTA, reflow at wide and narrow ruler positions, and all six marks.
- **Mobile:** 390x844, light theme. Inspect stacked proof/code, no page overflow, readable controls, fully visible/re-placed note, code-region scrolling, and keyboard/focus where the environment permits.
- **Zoom:** desktop viewport at 200% browser zoom. Inspect control access, note wrapping/clamping, and absence of lost essential content.
- **Reduced motion:** operating-system or browser-emulated reduced motion. Confirm immediate final marks, no drawing interpolation, and usable lifecycle controls.

Capture a screenshot and relevant accessibility/UI-state excerpt for each acceptance-critical state. If Computer Use is unavailable, the loop verdict is `Incorrect` and the final status is blocked rather than visually complete.

## 15. Impeccable Findings Traceability

| Finding | V1 response | Acceptance evidence |
|---|---|---|
| No adoption action | Live Playground primary CTA, Copy local starter secondary action, Quick Start/API/Limitations anchors. | E2E opens playground, copies runnable local ESM starter, and resolves each docs anchor. |
| Interactive theater | Real playback controls, synchronized code, native API tabs, visible states. | E2E exercises every lifecycle control and keyboard tab behavior; desktop Computer Use captures playing and complete states. |
| Responsive contradiction | Reflow challenge, scroll-ancestor tracking, clamped note placement, mobile notes never hidden. | Geometry unit fixtures plus E2E at 390px, nested scroll, wide/narrow ruler; Computer Use captures mobile and reflow states. |
| Accessibility baseline | Semantic controls, keyboard behavior, reduced motion, token-safe ARIA notes, contrast rules. | E2E keyboard/reduced-motion/concurrent-note tests plus Computer Use AX excerpts and 200% zoom inspection. |
| V1 under-proved | Six-mark ledger, locator and native Range proofs, measured size/dependency docket, CSS-variable theming, triggers, outputs, fallbacks, and limitations. | Unit/E2E fixtures, generated size report, zero-dependency assertion, and Computer Use specimen inspection. |

## 16. Implementation Boundaries

The runtime and demo may share public examples, but the runtime cannot import demo code or surface styles. Demo recipes cannot affect the base bundle. Pure geometry and validation modules cannot touch the DOM. Observation code cannot render directly; it schedules annotation refreshes. The renderer cannot resolve targets; it receives measured geometry. The document resource manager owns all shared listeners, observers, overlay nodes, and scheduled work; controllers own only subscriptions and their rendered children.

These boundaries let each unit be tested and replaced independently while keeping the public API small.
