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

## Desktop Layout

At wide viewports:

- selection ends by pointer or keyboard;
- a compact mark toolbar is placed beside the Range and clamped to the visual viewport;
- controls are underline, highlight, circle, box, strike, bracket, registered demo plugin mark, and Add Note;
- a fixed right output rail shows HTML, JavaScript, and JSON tabs;
- advanced options are progressively disclosed in the rail;
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

## Output

The rail is derived from one canonical definition:

- HTML emits declarative markup only when the target can be represented by an existing element; Range selections explain why HTML output is unavailable instead of injecting a wrapper;
- JavaScript emits `annotateSelection()` for the active native selection during editing and a stable `restore()` recipe after a serializable definition is applied;
- JSON emits `hanamaru/v1`;
- copy failure reveals a selected readonly fallback.

The Inspector registers one `hanamaru` flower-style custom mark through the public plugin API and visibly labels it as an example plugin.

## Verification

Playwright covers every state transition, pointer and keyboard selection, all marks, note validation, output equivalence, copy fallback, repeated entry/exit, cleanup, existing-story coexistence, mobile dock/sheet containment, focus return, reduced motion, and targeted axe checks.

Computer Use is authoritative for desktop Idle/Selected/Editing/Applied, 390px selected/editing/applied, keyboard-only use, reduced motion, toolbar and note bounds, and page overflow. Evidence includes screenshots and accessibility-tree state excerpts.
