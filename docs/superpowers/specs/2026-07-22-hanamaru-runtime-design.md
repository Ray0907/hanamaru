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
- Lifecycle: show, hide, play, pause, resume, cancel, replay, refresh, destroy.
- Entry points: declarative data attributes, imperative JavaScript, and JSON-compatible story definitions.
- Responsive remeasurement after relevant scroll, resize, and scoped content changes.
- CSS custom-property theming plus twelve optional Living Redline/Rakugaki presets.
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
annotation.hide()
annotation.destroy()
```

`annotate(target, options)` resolves and validates synchronously. It throws a typed error before mutating the page when resolution or configuration fails.

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

### 5.4 Lifecycle Events and State

Annotations and stories expose `state` and dispatch `hana:start`, `hana:step`, `hana:pause`, `hana:complete`, `hana:cancel`, and `hana:error` events from their target or configured event root.

Story states are:

```text
idle -> playing -> paused -> playing -> complete
  |        |          |          |
  +------> cancelled <-+----------+
              |
           replay -> playing
any non-destroyed state -> destroyed
```

Calling an invalid transition is a no-op that returns the current state. `destroy()` is idempotent.

## 6. Target Resolution

Supported target forms:

1. `Element`: measured directly.
2. CSS selector string: queried from `document`; zero or multiple matches throw a target error.
3. Native `Range`: cloned and measured; automatic text re-resolution is not possible, so callers use `refresh()` after replacing its underlying nodes.
4. Text locator: `{ within, text, occurrence? }`, where `within` is an `Element` or unique selector.

Text matching normalizes consecutive whitespace to a single space while preserving a mapping back to text-node offsets. Matching is case-sensitive and exact in V1.

- Zero matches: `HANA_TARGET_MISSING`.
- Multiple matches without `occurrence`: `HANA_TARGET_AMBIGUOUS`.
- Out-of-range `occurrence`: `HANA_TARGET_MISSING`.
- Invalid selector or disconnected Range: `HANA_TARGET_INVALID`.

The resolver never injects wrappers or changes source text. A locator retains enough information to re-resolve after scoped mutation.

## 7. Geometry and Placement

The runtime creates one document-level overlay root with `pointer-events: none`. Marks and connectors render in SVG; notes render as semantic DOM inside the overlay. Overlay nodes carry stable annotation IDs and no host-global element IDs.

Measurement uses `getBoundingClientRect()` and `Range.getClientRects()`. Multiline highlights and underlines receive per-line paths; circle, box, strike, and bracket use the union rectangle unless an option explicitly requests line-by-line rendering.

Automatic placement evaluates top, right, bottom, and left candidates. Each candidate receives penalties for:

- viewport overflow;
- overlap with the target;
- overlap with already placed visible notes;
- distance beyond the configured connector range.

The lowest-penalty candidate wins. Ties prefer right, top, bottom, then left in left-to-right documents; the order mirrors for RTL documents. An explicit placement remains preferred but flips to its opposite if it would put more than 40% of the note outside the viewport.

Placement is deterministic for identical rectangles and viewport size, enabling pure unit tests.

## 8. Observation and Scheduling

`ResizeObserver` watches element targets and the scoped container for text locators. Text locators also use one narrowly scoped `MutationObserver` per observed container. Window scroll, resize, and observer notifications enqueue a refresh through one `requestAnimationFrame` scheduler.

The scheduler deduplicates annotation IDs and performs reads before writes to avoid layout thrashing. Hidden or disconnected targets suspend drawing but retain configuration. Reconnection schedules a refresh. `destroy()` unregisters every observer, event listener, animation, SVG node, and note node.

Viewport-triggered stories use `IntersectionObserver` on the first target and play once by default. `once: false` permits replay after leaving and re-entering.

## 9. Rendering and Theming

Paths are generated from deterministic seeded control points so a replay preserves the same hand. A user-supplied `seed` or stable annotation ID controls the variation. No canvas is used.

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

The runtime owns only `.hana-*` selectors and `data-hana-*` attributes. It never styles bare elements or generic classes. Optional presets are separate CSS classes and do not increase the base JavaScript bundle.

## 10. Motion and Reduced Motion

The authored sequence is: activate corresponding code step, draw mark, draw connector, settle note, advance. JavaScript coordinates the state machine while CSS animations perform stroke and note transitions.

Replay removes active classes, forces no synchronous layout read beyond the scheduler boundary, restores the initial state, and restarts on the next animation frame. Pause and resume use the Web Animations API when available and a time-accounting fallback when unavailable.

When `prefers-reduced-motion: reduce` matches, durations become zero, all content appears in its complete state, and lifecycle events fire in the same logical order. The user can override this only with an explicit runtime option.

## 11. Accessibility Contract

- Runtime marks are decorative and `aria-hidden="true"`.
- Notes default to decorative. With `accessible: true`, the runtime gives the note a stable ID and appends it to the target's existing `aria-describedby` tokens; teardown restores the exact prior value.
- Notes never replace essential visible instructions or status.
- Demo tabs use the ARIA tabs pattern with native buttons and arrow-key navigation.
- Replay, pause, copy, mark selection, and the reflow ruler are native controls with visible focus.
- Playback state is exposed through visible text and a polite live region; drawing motion itself is not narrated step by step.
- The demo remains usable at 200% zoom and 390px viewport width.

## 12. Error Handling

Public typed errors extend `Error` and contain `code`, `message`, and optional `details`:

- `HanamaruTargetError`: missing, ambiguous, invalid, or disconnected target.
- `HanamaruConfigError`: unsupported mark, placement, trigger, timing, or malformed story.
- `HanamaruStateError`: reserved for asynchronous renderer failures; invalid public lifecycle transitions remain no-ops.

Imperative construction throws before DOM mutation. Declarative scanning collects errors. Runtime disconnection suspends an annotation rather than throwing repeatedly. Unexpected refresh failures dispatch one `hana:error`, hide only the affected annotation, and leave other annotations running.

Copy-to-clipboard failure in the demo reveals a selectable fallback code field. Unsupported optional browser APIs degrade as follows:

- No `ResizeObserver`: window resize plus explicit `refresh()`.
- No `IntersectionObserver`: viewport trigger degrades to load and reports the fallback in development mode.
- No Web Animations API: CSS animation and internal elapsed-time fallback.
- No CSS Highlight API: irrelevant to correctness because V1 Range rendering uses SVG geometry.

## 13. Demo and Playground

The landing surface follows `DESIGN.md`'s Living Redline system.

### First viewport

- A proof sheet demonstrates exact-text Range targeting.
- A synchronized code tray highlights the active story object.
- Replay, pause/resume, completion state, accessible API tabs, and code copy are real.
- The primary correction-stamp CTA opens or scrolls to the live playground.
- A secondary install action copies the npm command; no publication claim is made.

### Proof sections

1. **Reflow challenge:** a labeled range input changes the proof width from 320 to 760px while a note remains placed.
2. **Specimen ledger:** all six marks can be selected and replayed.
3. **API modes:** HTML, Story API, and JSON tabs alter real runnable definitions.
4. **Reliability docket:** zero runtime dependencies, measured local gzip size, supported triggers, and explicit V1 limitations.

### Playground controls

The user selects existing specimen text, mark, note, placement, and trigger, then runs the annotation and copies the corresponding HTML or JavaScript. V1 does not permit arbitrary page editing or drag positioning.

## 14. Testing and Verification

### Automated verification

`npm run verify` is the fixed authoritative functional command across Codex Loop rounds. It runs, in order:

1. `node --test tests/unit/**/*.test.js` for target validation, geometry, candidate scoring, state transitions, and configuration validation.
2. Production build for ESM, browser-ready JavaScript, and CSS.
3. Gzip size check enforcing the 8 KB combined hard ceiling and reporting the 5 KB JavaScript stretch target.
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
- reflow ruler retaining note attachment;
- cleanup after destroy.

A zero-test run is a failure.

### Computer Use verification

After `npm run verify` passes, Computer Use is authoritative for rendered appearance.

- **Target:** local built Hanamaru demo in Google Chrome.
- **Desktop:** 1440x900, light theme, default motion. Inspect first viewport, story playback states, synchronized code, primary CTA, reflow at wide and narrow ruler positions, and all six marks.
- **Mobile:** 390x844, light theme. Inspect stacked proof/code, no page overflow, readable controls, visible/re-placed note, code-region scrolling, and keyboard/focus where the environment permits.
- **Reduced motion:** operating-system or browser-emulated reduced motion. Confirm immediate final marks, no drawing interpolation, and usable lifecycle controls.

Capture a screenshot and relevant accessibility/UI-state excerpt for each acceptance-critical state. If Computer Use is unavailable, the loop verdict is `Incorrect` and the final status is blocked rather than visually complete.

## 15. Impeccable Findings Traceability

| Finding | V1 response |
|---|---|
| No adoption action | Live Playground primary CTA, install copy secondary action, concrete API entry paths. |
| Interactive theater | Real playback controls, synchronized code, native API tabs, visible states. |
| Responsive contradiction | Reflow challenge, deterministic re-placement, mobile notes never hidden. |
| Accessibility baseline | Semantic controls, keyboard behavior, reduced motion, ARIA note contract, contrast rules. |
| V1 under-proved | Six-mark ledger, Range proof, size/dependency docket, explicit triggers and limitations. |

## 16. Implementation Boundaries

The runtime and demo may share public types and examples, but the runtime cannot import demo code or surface styles. Optional presets cannot affect the base bundle. Pure geometry and validation modules cannot touch the DOM. Observation code cannot render directly; it schedules annotation refreshes. The renderer cannot resolve targets; it receives measured geometry.

These boundaries let each unit be tested and replaced independently while keeping the public API small.

