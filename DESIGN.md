# Hanamaru Design System

## Thesis

Hanamaru turns a Japanese proofreader's correction sheet into an executable developer surface. The interface refuses the generic SaaS hero and floating feature-card grid: the first viewport is a live proof sheet where marked prose and synchronized source code demonstrate the runtime together.

## Release Surface

The implemented `0.1.0` release adds a direct Annotation Inspector to the proof-sheet demo. Its user-visible state sequence is `idle` → `selected` → `editing` → `applied`: the visitor selects real article text, chooses a built-in or plugin flower mark, edits an optional note/options, applies the owned annotation, and inspects generated HTML, JavaScript, or versioned JSON.

The README hero is a real 1280×900 Inspector capture from the selection → Hanamaru flower mark → Apply path. It must show selected text, the mark toolbar, visible applied annotation, and readable output rail without browser debug chrome or personal data. The proof-led landing composition remains the product narrative; Inspector is its concrete adoption proof, not a separate mockup or runtime.

## Own World

The durable visual world is **Living Redline**: mineral-white proof paper, vermilion correction ink, carbon-copy indigo, highlighter yellow, manuscript-grid lines, margin notes, stamps, and registration marks. Containers resemble sheets, trays, tabs, and rulers rather than generic rounded cards. Hand-drawn geometry comes from Hanamaru itself, not a decorative handwriting font.

## Surface Modes

- Landing and README hero: **Persuade**. A visitor understands the reliable runtime, sees an actual Inspector result, and opens the local playground.
- Playground and Annotation Inspector: **Operate**. Controls are compact, semantic, keyboard-safe, and visibly connected to the live result and generated code.
- Documentation: **Read**. The same proof-sheet grammar supports long-form comprehension without ornamental noise.

## Palette

- `--hana-paper: #f7f5ee` — primary proof paper.
- `--hana-paper-strong: #fffef9` — live content sheet.
- `--hana-ink: #1f2733` — primary text and carbon-copy structure.
- `--hana-muted: #626872` — secondary text at accessible contrast.
- `--hana-red: #c92f2a` — correction ink; never used for tiny low-contrast text.
- `--hana-yellow: #f4cf3f` — highlight and active-code synchronization.
- `--hana-indigo: #263e70` — code tray and technical proof.
- `--hana-green: #167a5a` — success and copied state.

Color is restrained but not timid: paper owns the page, indigo owns the code surface, and vermilion owns annotation action. Yellow appears only where a mark or currently executing line demands attention.

## Typography

- Display and UI: native system sans with `Arial Black`/heavy system weights for portability and immediate rendering.
- Editorial specimen: `Georgia`, `Yu Mincho`, or the host page's inherited reading face.
- Code and measurements: `ui-monospace`, `SFMono-Regular`, `Menlo`, monospace.
- Japanese-capable UI fallback: `Hiragino Sans`, `Yu Gothic`, sans-serif.

Minimum supporting text is 12px. Interactive labels are at least 14px. The hierarchy uses scale and weight before tracking; tiny all-caps metadata is not a substitute for structure.

## Composition

The first demo viewport is a full-width proof sheet, not browser-chrome cosplay. Marked prose occupies the dominant left field; a recessed indigo code tray occupies the right. The active story object illuminates in yellow as its corresponding mark draws. The primary **Open Live Playground** stamp sits immediately after the proof, with install/copy as the secondary action.

Below the first proof, a live reflow challenge is the centerpiece: an accessible width slider narrows the specimen while callouts remain attached. A compact specimen ledger proves all six marks. Technical proof—zero dependencies, size budget, triggers, and browser behavior—appears as registration data, not marketing badges.

Inspector overlays that world without replacing it. On desktop its toolbar stays next to and clear of the selection while a fixed right output rail holds tabs, copy, and advanced options. On narrow screens the code tray moves below the proof, the Inspector toolbar docks above the safe-area bottom edge, and output becomes an expandable bottom sheet. Notes re-place above or below targets; they never disappear to make the layout easier.

## Components

- **Proof sheet:** live annotated content with manuscript-grid or registration detail.
- **Code tray:** synchronized source, accessible tablist, copy control, playback state.
- **Correction stamp:** primary and secondary actions with rectangular, inked edges rather than pill styling.
- **Specimen ledger:** six marks presented as a compact, selectable set.
- **Reflow ruler:** labeled range control that changes the specimen width and exposes placement behavior.
- **Margin note:** real annotation output; never a separate decorative imitation.
- **Status docket:** playing, paused, complete, copied, warning, and target-error states.
- **Inspector toolbar:** roving mark choices, Add/Edit Note, Apply, and Cancel with one visible selected state.
- **Inspector output rail/sheet:** labeled HTML, JavaScript, and JSON tabs derived from one canonical selection; unavailable representations explain their limit instead of inventing a wrapper or key.

Interactive targets are at least 44 by 44 CSS pixels where practical, use native elements, and carry visible `:focus-visible` treatment in vermilion plus paper offset.

## Motion

One authored sequence owns the page: code step activates, mark draws, connector travels, note settles, then the next step begins. Motion communicates causality. Replay, pause, resume, and completion are explicit.

Default movement is quick and deliberate rather than bouncy: 180–700ms per stage with eased drawing and minimal positional overshoot. Reduced-motion mode skips interpolation, displays the final annotated state immediately, and emits the same lifecycle events.

## Responsive and Accessibility Rules

- At 900px and below, proof and code stack; controls remain near the result they affect.
- At 390px, no horizontal page overflow is permitted. Code may scroll inside its own labeled region.
- At 390px, the Inspector dock and collapsed/expanded output sheet leave selected text visible and remain inside the visual viewport.
- Annotation placement is recalculated, not hidden, on width changes.
- All tabs, playback, range, mark selectors, and copy actions work by keyboard.
- Inspector uses roving Arrow-key navigation, Enter/Space activation, layered Escape dismissal, a polite status region, and focus return to its connected opener.
- Text and control contrast meet WCAG AA; decorative registration detail may be lower contrast only when it carries no information.
- Notes that contain meaningful information support `aria-describedby`; decorative notes are hidden from assistive technology.

## Anti-patterns

- No generic browser-window mockup as the main composition.
- No inert controls, fake tabs, or autoplay without user control.
- No rounded-card grid used to carry every section.
- No gradient mesh, glass panel, decorative icon tiles, or ornamental developer chrome.
- No disappearing callouts at mobile breakpoints.
- No fabricated install counts, users, performance claims, or browser support.
