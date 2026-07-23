# Hanamaru Direct Canvas Inspector Design

**Date:** 2026-07-23  
**Status:** User-approved design; pending independent spec review

## Objective

Create a demo-only authoring surface that proves the public Selection and serialization APIs in one five-second interaction: select real text, choose a mark, optionally add a note, see the live annotation, and copy HTML, JavaScript, or versioned JSON.

Inspector is not shipped in the runtime bundle. It imports only documented package entry points and doubles as an integration fixture.

## Entry and State

The existing Living Redline demo gains an explicit **Open Annotation Inspector** action. Inspector mode never activates on page load.

States are:

1. `idle` — normal document behavior;
2. `selected` — exactly one valid cloned Range and visible mark controls;
3. `editing` — live mark preview and optional note editing;
4. `applied` — owned controller visible and generated outputs current.

Leaving Inspector mode destroys its owned preview/controller, clears Inspector UI, and leaves document content and the user's current native selection untouched. Existing demo annotations are not adopted or destroyed.

Inspector owns at most one controller. The complete transition table is:

| From | Input | To | Action |
| --- | --- | --- | --- |
| `idle` | valid settled selection | `selected` | clone Range and enable toolbar |
| `selected` | choose a mark | `editing` | create/show preview controller with current mark |
| `selected` | Escape or invalidated selection | `idle` | clear Inspector selection state |
| `editing` | change mark or advanced option | `editing` | atomic controller update and output refresh |
| `editing` | Add Note | `editing` | open and focus the note field |
| `editing` | Apply | `applied` | commit preview as the owned applied controller |
| `editing` | Cancel | `selected` | destroy preview, retain cloned Range |
| `applied` | edit current annotation | `editing` | reuse the same controller |
| `applied` | new valid selection | `selected` | validate and clone new Range, then destroy prior owned controller |
| any | close Inspector | `idle` | destroy owned controller, close layers, return focus |

Selection invalidation before a preview returns to `idle`. Once cloned into a preview or applied controller, native selection changes do not invalidate it. Repeated input for the current state is idempotent.

## Desktop Layout

At wide viewports:

- selection ends by pointer or keyboard;
- a compact mark toolbar is placed beside the Range and clamped to the visual viewport;
- controls are underline, highlight, circle, box, strike, bracket, registered demo plugin mark, and Add Note;
- a fixed right output rail shows HTML, JavaScript, and JSON tabs;
- an **Options** disclosure in the rail exposes placement, meaningful-note accessibility, duration, motion, and seed; trigger is fixed to manual;
- the selected output is readonly, selectable, and copyable.

The toolbar does not cover the selection. If no adjacent placement fits, it docks to the nearest safe viewport edge.

## Mobile Layout

At 390 CSS pixels:

- the mark toolbar docks above the safe-area bottom edge;
- generated output becomes a collapsed bottom sheet;
- activating the sheet expands it without horizontally overflowing the page;
- the selected text stays visible above the dock;
- note editing uses a labeled sheet field capped at 280 Unicode code points.

The output sheet is not sticky after Inspector mode ends or the user navigates to another demo section.

## Interaction and Accessibility

- Selection is accepted after `pointerup` or keyboard `selectionchange` settles.
- Toolbar uses a roving tab stop; arrow keys move between marks.
- Enter or Space applies a mark.
- `Cmd/Ctrl+K` opens the command palette.
- Escape closes the note editor, then command palette, then Inspector mode in that order.
- Tab order reaches exit, mark toolbar, note editor, output tabs, copy, and advanced options.
- Focus is returned to the invoking control when Inspector closes.
- Status changes use an existing polite live-region pattern.
- Toolbar, rail, sheets, focus rings, and disabled states meet tested contrast.
- Reduced motion applies the final mark and output without interpolated drawing.

The command palette is bounded to: the seven available demo marks, Add/Edit Note, Apply, Cancel Preview, Copy Current Output, and Close Inspector. It has one text filter, arrow-key navigation, Enter activation, Escape dismissal, and no arbitrary command registration.

The advanced Options disclosure uses the public option domains: placement (`auto`, `top`, `right`, `bottom`, `left`), accessible boolean, non-negative integer duration, motion (`system`, `never`), and string seed. Invalid numeric or note input remains in `editing`, associates a visible error with its field, and does not update the controller.

## Output

The rail is derived from one canonical definition:

- HTML emits declarative markup only when the target can be represented by an existing element; Range selections explain why HTML output is unavailable instead of injecting a wrapper;
- JavaScript emits `annotateSelection()` while editing. After Apply, it emits `restore()` only when a stable locator definition is proven; otherwise it retains an explicit Range/Selection recipe;
- JSON emits `hanamaru/v1` only after the selected Range is converted to and verified against a scoped exact-text locator;
- copy failure reveals a selected readonly fallback.

The demo's authorable article has one stable scope selector, `#inspector-document`. To produce stable JSON without wrappers or DOM mutation, Inspector:

1. reads the selected text and normalized occurrence inside that scope;
2. constructs a locator `{ within: '#inspector-document', text, occurrence }`;
3. calls public `resolveSerializedTarget()` on the serialized locator target;
4. compares the returned cloned Range boundaries with the Inspector's active cloned Range;
5. when they match, atomically calls the owned annotation's public `update({ target: locator })`;
6. calls public `serialize(controller)` and enables JSON plus the `restore()` recipe only after that update succeeds.

If the selection cannot round-trip exactly—for example, a partial boundary that normalization cannot reproduce—the JSON tab remains present but shows an accessible “Unavailable for this Range” explanation. It never emits an ephemeral target key or claims persistence. HTML follows the same honesty rule and is available only for an existing element target.

The Inspector registers one `hanamaru` flower-style custom mark through the public plugin API and visibly labels it as an example plugin.

## Verification

Playwright covers every row in the transition table, pointer and keyboard selection, all marks, the bounded command palette, every advanced option, note and numeric validation, successful locator boundary round-trip, unavailable JSON/HTML explanations, output equivalence, copy fallback, repeated entry/exit, cleanup, existing-story coexistence, mobile dock/sheet containment, focus return, reduced motion, and targeted axe checks.

Computer Use is authoritative for desktop Idle/Selected/Editing/Applied, 390px selected/editing/applied, keyboard-only use, reduced motion, toolbar and note bounds, and page overflow. Evidence includes screenshots and accessibility-tree state excerpts.
