import { VERSION } from 'hanamaru-annotations';
import { registerMark } from 'hanamaru-annotations/plugins';
import { annotateSelection } from 'hanamaru-annotations/selection';
import {
  resolveSerializedTarget,
  serialize,
} from 'hanamaru-annotations/serialize';

import {
  createInspectorEffectContext,
  reduceInspector,
} from './inspector-state.js';
import {
  createRangeOutput,
  proveRangeLocator,
} from './inspector-output.js';

const INITIAL_MODEL = Object.freeze({
  state: 'closed',
  transient: null,
  mark: undefined,
  options: Object.freeze({}),
});
const BUILT_IN_MARKS = Object.freeze([
  'underline',
  'highlight',
  'circle',
  'box',
  'strike',
  'bracket',
]);
const DEFAULT_OPTIONS = Object.freeze({
  note: null,
  placement: 'auto',
  trigger: 'manual',
  accessible: true,
  seed: 'inspector-proof',
  duration: 420,
  motion: 'system',
});
const OUTPUT_FORMATS = Object.freeze(['html', 'javascript', 'json']);
const OUTPUT_LABELS = Object.freeze({
  html: 'HTML',
  javascript: 'JavaScript',
  json: 'JSON',
});
const COMPACT_VISUAL_WIDTH = 720;
const NARROW_VISUAL_WIDTH = 320;

function sameRange(first, second) {
  return first !== null
    && second !== null
    && first.startContainer === second.startContainer
    && first.startOffset === second.startOffset
    && first.endContainer === second.endContainer
    && first.endOffset === second.endOffset;
}

function ownerNode(boundary) {
  return boundary?.nodeType === Node.TEXT_NODE ? boundary.parentElement : boundary;
}

function rangeInside(range, scope) {
  if (range === null || range.collapsed || range.toString().trim().length === 0) return false;
  const start = ownerNode(range.startContainer);
  const end = ownerNode(range.endContainer);
  return start !== null
    && end !== null
    && scope.contains(start)
    && scope.contains(end);
}

function currentRange(scope) {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  return rangeInside(range, scope) ? range : null;
}

function flowerMark({ unionRect, helpers }) {
  const center = {
    x: unionRect.left + (unionRect.width / 2),
    y: unionRect.top + (unionRect.height / 2),
  };
  const radiusX = Math.max(4, unionRect.width / 5);
  const radiusY = Math.max(4, unionRect.height / 2);
  const petals = [
    [center, { x: center.x - radiusX, y: center.y - radiusY },
      { x: center.x, y: center.y - radiusY }],
    [center, { x: center.x + radiusX, y: center.y - radiusY },
      { x: center.x + radiusX, y: center.y }],
    [center, { x: center.x + radiusX, y: center.y + radiusY },
      { x: center.x, y: center.y + radiusY }],
    [center, { x: center.x - radiusX, y: center.y + radiusY },
      { x: center.x - radiusX, y: center.y }],
  ];
  return {
    paths: petals.map((points, index) => (
      helpers.closedPath(points, { label: `inspector-petal-${index}`, wobble: 0.35 })
    )),
  };
}

function durationValue(control) {
  if (!/^(?:0|[1-9]\d*)$/u.test(control.value)) return null;
  const value = Number(control.value);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Mount the demo-only direct-canvas Inspector.
 *
 * Runtime work crosses only documented package entry points. The reducer and
 * output modules are demo-local orchestration, never runtime internals.
 */
export function createAnnotationInspector(root = document) {
  const open = root.querySelector('[data-inspector-open]');
  const scope = root.querySelector('#inspector-document');
  const canvas = root.querySelector('[data-inspector-canvas]');
  const template = root.querySelector('[data-inspector-template]');
  const playground = root.querySelector('#playground');
  if (
    open === null
    || scope === null
    || canvas === null
    || playground === null
    || !(template instanceof HTMLTemplateElement)
  ) {
    throw new Error('Annotation Inspector host markup is incomplete');
  }
  playground.before(canvas, template);
  const fragment = template.content.cloneNode(true);
  const inspector = fragment.querySelector('[data-inspector-root]');
  const exit = inspector?.querySelector('[data-inspector-exit]');
  const toolbar = inspector?.querySelector('[data-inspector-toolbar]');
  const markButtons = [...(inspector?.querySelectorAll('[data-inspector-mark]') ?? [])];
  const addNote = inspector?.querySelector('[data-inspector-add-note]');
  const apply = inspector?.querySelector('[data-inspector-apply]');
  const cancel = inspector?.querySelector('[data-inspector-cancel]');
  const edit = inspector?.querySelector('[data-inspector-edit]');
  const noteEditor = inspector?.querySelector('[data-inspector-note-editor]');
  const note = inspector?.querySelector('[data-inspector-note]');
  const noteError = inspector?.querySelector('#inspector-note-error');
  const noteDone = inspector?.querySelector('[data-inspector-note-done]');
  const output = inspector?.querySelector('[data-inspector-output]');
  const outputToggle = inspector?.querySelector('[data-inspector-output-toggle]');
  const outputBody = inspector?.querySelector('[data-inspector-output-body]');
  const outputTabs = [...(inspector?.querySelectorAll(
    '[data-inspector-output] [role="tab"]',
  ) ?? [])];
  const outputPanels = [...(inspector?.querySelectorAll(
    '[data-inspector-output] [role="tabpanel"]',
  ) ?? [])];
  const outputValues = Object.fromEntries(OUTPUT_FORMATS.map((format) => [
    format,
    inspector?.querySelector(`[data-inspector-output-value="${format}"]`),
  ]));
  const copy = inspector?.querySelector('[data-inspector-copy]');
  const copyFallbackWrap = inspector?.querySelector('[data-inspector-copy-fallback-wrap]');
  const copyFallback = inspector?.querySelector('[data-inspector-copy-fallback]');
  const optionsControls = [...(inspector?.querySelectorAll('[data-inspector-option]') ?? [])];
  const placement = inspector?.querySelector('[data-inspector-option="placement"]');
  const accessible = inspector?.querySelector('[data-inspector-option="accessible"]');
  const duration = inspector?.querySelector('[data-inspector-option="duration"]');
  const durationError = inspector?.querySelector('#inspector-duration-error');
  const motion = inspector?.querySelector('[data-inspector-option="motion"]');
  const seed = inspector?.querySelector('[data-inspector-option="seed"]');
  const status = inspector?.querySelector('[data-inspector-status]');
  const version = inspector?.querySelector('[data-inspector-runtime-version]');
  const palette = inspector?.querySelector('[data-inspector-palette]');
  const paletteFilter = inspector?.querySelector('[data-inspector-command-filter]');
  const paletteCommands = [...(inspector?.querySelectorAll('[data-inspector-command]') ?? [])];
  const paletteClose = inspector?.querySelector('[data-inspector-palette-close]');

  const required = [
    open,
    inspector,
    exit,
    scope,
    toolbar,
    addNote,
    apply,
    cancel,
    edit,
    noteEditor,
    note,
    noteError,
    noteDone,
    output,
    outputToggle,
    outputBody,
    copy,
    copyFallbackWrap,
    copyFallback,
    placement,
    accessible,
    duration,
    durationError,
    motion,
    seed,
    status,
    version,
    palette,
    paletteFilter,
    paletteClose,
    ...markButtons,
    ...outputTabs,
    ...outputPanels,
    ...Object.values(outputValues),
  ];
  if (required.some((node) => node === null)) {
    throw new Error('Annotation Inspector markup is incomplete');
  }

  version.textContent = `v${VERSION}`;

  let model = INITIAL_MODEL;
  let invoker = null;
  let activeRange = null;
  let pendingRange = null;
  let controller = null;
  let currentOutput = null;
  let selectedFormat = 'javascript';
  let openSessionEpoch = 0;
  let clipboardOperationEpoch = 0;
  let listenersAttached = false;
  let selectionFrame = 0;
  let positionFrame = 0;
  let visualViewportSignature = '';
  let activeMarkIndex = 0;
  let outputExpanded = false;
  let unregisterFlower = null;
  let disposed = false;
  const uiAbort = new AbortController();
  const draft = { ...DEFAULT_OPTIONS };

  function announce(message) {
    status.textContent = message;
  }

  function annotationOptions(mark = model.mark ?? 'underline') {
    return {
      mark,
      note: draft.note,
      placement: draft.placement,
      trigger: 'manual',
      accessible: draft.accessible,
      seed: draft.seed,
      duration: draft.duration,
      motion: draft.motion,
    };
  }

  function resetDraft() {
    Object.assign(draft, DEFAULT_OPTIONS);
    note.value = '';
    note.removeAttribute('aria-invalid');
    noteError.hidden = true;
    placement.value = draft.placement;
    accessible.checked = draft.accessible;
    duration.value = String(draft.duration);
    duration.removeAttribute('aria-invalid');
    durationError.hidden = true;
    motion.value = draft.motion;
    seed.value = draft.seed;
    addNote.textContent = 'Add note';
    setActiveMark(0);
  }

  function setActiveMark(index, { focus = false } = {}) {
    activeMarkIndex = (index + markButtons.length) % markButtons.length;
    for (const [buttonIndex, button] of markButtons.entries()) {
      button.tabIndex = buttonIndex === activeMarkIndex ? 0 : -1;
    }
    if (focus) markButtons[activeMarkIndex].focus();
  }

  function visualViewportSnapshot() {
    const visual = window.visualViewport;
    const height = visual?.height ?? window.innerHeight;
    const left = visual?.offsetLeft ?? 0;
    const scale = visual?.scale ?? 1;
    const top = visual?.offsetTop ?? 0;
    const width = visual?.width ?? window.innerWidth;
    return {
      bottom: top + height,
      bottomInset: Math.max(0, window.innerHeight - top - height),
      height,
      left,
      right: left + width,
      rightInset: Math.max(0, window.innerWidth - left - width),
      scale,
      top,
      width,
    };
  }

  function isCompactVisualViewport(viewport = visualViewportSnapshot()) {
    return viewport.width <= COMPACT_VISUAL_WIDTH;
  }

  function syncOutputDisclosure(viewport = visualViewportSnapshot()) {
    const compact = isCompactVisualViewport(viewport);
    const expanded = !compact || outputExpanded;
    outputToggle.hidden = !compact;
    outputToggle.setAttribute('aria-expanded', String(expanded));
    outputToggle.textContent = expanded ? 'Collapse output' : 'Expand output';
    outputBody.hidden = !expanded;
    output.dataset.expanded = String(expanded);
  }

  function setOutputExpanded(expanded) {
    outputExpanded = expanded;
    syncOutputDisclosure();
    syncInspectorLayout();
  }

  function ensureActiveRangeVisible() {
    if (
      inspector.dataset.inspectorCompact !== 'true'
      || activeRange === null
      || toolbar.hidden
    ) return;
    const selection = activeRange.getBoundingClientRect();
    const header = inspector.querySelector(':scope > header').getBoundingClientRect();
    const statusRect = status.getBoundingClientRect();
    const lowerLayers = [
      toolbar.getBoundingClientRect(),
      ...(output.hidden ? [] : [output.getBoundingClientRect()]),
      ...(noteEditor.hidden ? [] : [noteEditor.getBoundingClientRect()]),
    ];
    const upper = Math.max(header.bottom, statusRect.bottom) + 12;
    const lower = Math.min(...lowerLayers.map((layer) => layer.top)) - 12;
    if (selection.bottom > lower) {
      window.scrollBy({ behavior: 'instant', top: selection.bottom - lower });
    } else if (selection.top < upper) {
      window.scrollBy({ behavior: 'instant', top: selection.top - upper });
    }
  }

  function scheduleInspectorLayout() {
    if (positionFrame !== 0) cancelAnimationFrame(positionFrame);
    positionFrame = requestAnimationFrame(syncInspectorLayout);
  }

  function settleChangedVisualViewport(changed) {
    if (
      changed
      && positionFrame === 0
      && inspector.isConnected
      && model.state !== 'closed'
    ) {
      positionFrame = requestAnimationFrame(syncInspectorLayout);
    }
  }

  function syncInspectorLayout() {
    if (positionFrame !== 0) cancelAnimationFrame(positionFrame);
    positionFrame = 0;
    const viewport = visualViewportSnapshot();
    const nextViewportSignature = [
      viewport.bottomInset,
      viewport.height,
      viewport.left,
      viewport.rightInset,
      viewport.scale,
      viewport.top,
      viewport.width,
    ].join(':');
    const viewportChanged = visualViewportSignature !== ''
      && visualViewportSignature !== nextViewportSignature;
    visualViewportSignature = nextViewportSignature;
    const compact = isCompactVisualViewport(viewport);
    inspector.style.setProperty('--inspector-vv-bottom', `${viewport.bottomInset}px`);
    inspector.style.setProperty(
      '--inspector-vv-center-x',
      `${viewport.left + (viewport.width / 2)}px`,
    );
    inspector.style.setProperty(
      '--inspector-vv-center-y',
      `${viewport.top + (viewport.height / 2)}px`,
    );
    inspector.style.setProperty('--inspector-vv-height', `${viewport.height}px`);
    inspector.style.setProperty('--inspector-vv-left', `${viewport.left}px`);
    inspector.style.setProperty('--inspector-vv-right', `${viewport.rightInset}px`);
    inspector.style.setProperty('--inspector-vv-scale', String(viewport.scale));
    inspector.style.setProperty('--inspector-vv-top', `${viewport.top}px`);
    inspector.style.setProperty('--inspector-vv-width', `${viewport.width}px`);
    inspector.dataset.inspectorCompact = String(compact);
    inspector.dataset.inspectorNarrow = String(viewport.width <= NARROW_VISUAL_WIDTH);
    syncOutputDisclosure(viewport);

    let outputSide = 'none';
    if (!output.hidden && activeRange !== null) {
      const rangeRect = activeRange.getBoundingClientRect();
      outputSide = compact
        ? 'sheet'
        : rangeRect.left + (rangeRect.width / 2)
          > viewport.left + (viewport.width / 2)
          ? 'left'
          : 'right';
    }
    inspector.dataset.inspectorOutputSide = outputSide;
    if (outputSide === 'left' || outputSide === 'right') {
      output.dataset.inspectorSide = outputSide;
    } else {
      output.removeAttribute('data-inspector-side');
    }

    const inspectorHeader = inspector.querySelector(':scope > header');
    if (inspector.isConnected && inspectorHeader !== null) {
      status.style.top = `${Math.ceil(inspectorHeader.getBoundingClientRect().bottom + 6)}px`;
    }
    if (toolbar.hidden || activeRange === null || model.state === 'closed') {
      settleChangedVisualViewport(viewportChanged);
      return;
    }
    if (compact) {
      toolbar.style.removeProperty('left');
      toolbar.style.removeProperty('top');
      toolbar.style.removeProperty('max-width');
      inspector.style.setProperty(
        '--inspector-toolbar-height',
        `${Math.ceil(toolbar.getBoundingClientRect().height)}px`,
      );
      inspector.style.setProperty(
        '--inspector-output-height',
        output.hidden ? '0px' : `${Math.ceil(output.getBoundingClientRect().height)}px`,
      );
      ensureActiveRangeVisible();
      settleChangedVisualViewport(viewportChanged);
      return;
    }
    inspector.style.setProperty('--inspector-toolbar-height', '0px');
    inspector.style.setProperty('--inspector-output-height', '0px');
    const margin = 12;
    const gap = 12;
    const selection = activeRange.getBoundingClientRect();
    const rail = output.hidden ? null : output.getBoundingClientRect();
    const availableLeft = rail !== null && outputSide === 'left'
      ? rail.right + gap
      : viewport.left + margin;
    const availableRight = rail !== null && outputSide === 'right'
      ? rail.left - gap
      : viewport.right - margin;
    const availableWidth = Math.max(0, availableRight - availableLeft);
    toolbar.style.maxWidth = `${availableWidth}px`;
    const rect = toolbar.getBoundingClientRect();
    const headerBottom = Math.max(
      inspectorHeader.getBoundingClientRect().bottom,
      status.getBoundingClientRect().bottom,
    );
    const minimumTop = Math.max(viewport.top + margin, headerBottom + gap);
    const left = Math.min(
      Math.max(availableLeft, selection.left),
      Math.max(availableLeft, availableRight - rect.width),
    );
    const above = selection.top - rect.height - gap;
    const below = selection.bottom + gap;
    const top = above >= minimumTop
      ? above
      : Math.min(below, viewport.bottom - rect.height - margin);
    toolbar.style.left = `${Math.round(left)}px`;
    toolbar.style.top = `${Math.round(Math.max(minimumTop, top))}px`;
    settleChangedVisualViewport(viewportChanged);
  }

  function ensureFlowerPlugin() {
    if (unregisterFlower !== null) return;
    unregisterFlower = registerMark('hanamaru', flowerMark);
  }

  function removeFlowerPlugin() {
    unregisterFlower?.();
    unregisterFlower = null;
  }

  function renderOutput() {
    if (currentOutput === null) return;
    for (const format of OUTPUT_FORMATS) {
      const entry = currentOutput[format];
      outputValues[format].value = entry.available ? entry.code : entry.reason;
    }
  }

  function refreshOutput({ prove = false, mark = model.mark ?? 'underline' } = {}) {
    clipboardOperationEpoch += 1;
    const base = createRangeOutput(annotationOptions(mark));
    currentOutput = base;
    if (prove && activeRange !== null && controller !== null) {
      currentOutput = proveRangeLocator({
        range: activeRange,
        selectedText: activeRange.toString(),
        controller,
        previousOutput: base,
        resolveSerializedTarget,
        serialize,
      });
    }
    renderOutput();
  }

  function selectOutput(format, { focus = false, announceChange = true } = {}) {
    if (selectedFormat !== format) clipboardOperationEpoch += 1;
    selectedFormat = format;
    for (const tab of outputTabs) {
      const selected = tab.getAttribute('aria-controls') === `inspector-panel-${format}`;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    }
    for (const panel of outputPanels) {
      panel.hidden = panel.id !== `inspector-panel-${format}`;
    }
    if (announceChange) {
      const entry = currentOutput?.[format];
      const availability = entry?.available === false ? ` ${entry.reason}` : '';
      announce(`${OUTPUT_LABELS[format]} output selected.${availability}`);
    }
  }

  function updateState() {
    inspector.dataset.inspectorState = model.state;
    const editing = model.state === 'editing';
    const applied = model.state === 'applied';
    apply.disabled = !editing;
    cancel.disabled = !editing;
    addNote.disabled = !editing && !applied;
    edit.hidden = !applied;
    for (const button of markButtons) {
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.inspectorMark === model.mark),
      );
    }
    if (model.state === 'selected') output.hidden = true;
  }

  function settleSelection() {
    selectionFrame = 0;
    if (
      model.state === 'closed'
      || model.state === 'editing'
      || model.transient !== null
    ) return;
    const range = currentRange(scope);
    if (model.state === 'idle') {
      if (range !== null) dispatch({ type: 'valid-selection', range });
      return;
    }
    if (model.state === 'selected') {
      if (range === null && !inspector.contains(root.activeElement)) {
        dispatch({ type: 'invalid-selection' });
      }
      return;
    }
    if (model.state === 'applied' && range !== null && !sameRange(range, activeRange)) {
      dispatch({ type: 'new-valid-selection', range });
    }
  }

  function scheduleSelection() {
    if (selectionFrame !== 0) cancelAnimationFrame(selectionFrame);
    selectionFrame = requestAnimationFrame(settleSelection);
  }

  function paletteOpener() {
    const active = root.activeElement;
    return active instanceof HTMLElement ? active : exit;
  }

  function onInspectorKeydown(event) {
    if (model.state === 'closed') return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (model.transient?.kind !== 'palette') {
        dispatch({ type: 'open-palette', opener: paletteOpener() });
      }
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    dispatch({ type: 'escape' });
  }

  function closeForNavigation() {
    if (model.state !== 'closed') dispatch({ type: 'navigation' });
  }

  function attachListeners() {
    if (listenersAttached) return;
    listenersAttached = true;
    root.addEventListener('pointerup', scheduleSelection);
    root.addEventListener('selectionchange', scheduleSelection);
    root.addEventListener('keyup', scheduleSelection);
    root.addEventListener('keydown', onInspectorKeydown);
    window.addEventListener('hashchange', closeForNavigation);
    window.addEventListener('resize', scheduleInspectorLayout);
    window.addEventListener('scroll', scheduleInspectorLayout, true);
    window.visualViewport?.addEventListener('resize', scheduleInspectorLayout);
    window.visualViewport?.addEventListener('scroll', scheduleInspectorLayout);
  }

  function removeListeners() {
    if (!listenersAttached) return;
    listenersAttached = false;
    root.removeEventListener('pointerup', scheduleSelection);
    root.removeEventListener('selectionchange', scheduleSelection);
    root.removeEventListener('keyup', scheduleSelection);
    root.removeEventListener('keydown', onInspectorKeydown);
    window.removeEventListener('hashchange', closeForNavigation);
    window.removeEventListener('resize', scheduleInspectorLayout);
    window.removeEventListener('scroll', scheduleInspectorLayout, true);
    window.visualViewport?.removeEventListener('resize', scheduleInspectorLayout);
    window.visualViewport?.removeEventListener('scroll', scheduleInspectorLayout);
    if (selectionFrame !== 0) cancelAnimationFrame(selectionFrame);
    if (positionFrame !== 0) cancelAnimationFrame(positionFrame);
    selectionFrame = 0;
    positionFrame = 0;
  }

  function destroyOwned() {
    controller?.destroy();
    controller = null;
  }

  function closeTransient(kind) {
    if (kind === 'note') {
      noteEditor.hidden = true;
      addNote.setAttribute('aria-expanded', 'false');
    } else if (kind === 'palette' && palette.open) {
      palette.close();
    }
  }

  function interpret(effect, context) {
    switch (effect) {
      case 'capture-invoker':
        invoker = context.event.invoker;
        break;
      case 'mount':
        openSessionEpoch += 1;
        clipboardOperationEpoch += 1;
        resetDraft();
        outputExpanded = false;
        syncOutputDisclosure();
        ensureFlowerPlugin();
        canvas.after(inspector);
        inspector.hidden = false;
        open.setAttribute('aria-expanded', 'true');
        announce('Inspector open. Select text in the authorable proof.');
        break;
      case 'attach-listeners':
        attachListeners();
        break;
      case 'focus-exit':
        exit.focus();
        break;
      case 'clone-selection':
        pendingRange = context.event.range.cloneRange();
        if (context.previous.state !== 'applied') activeRange = pendingRange;
        break;
      case 'validate-clone':
        if (!rangeInside(pendingRange, scope)) {
          pendingRange = null;
          throw new Error('Inspector rejected a disconnected replacement Range');
        }
        break;
      case 'replace-range':
        activeRange = pendingRange;
        pendingRange = null;
        currentOutput = null;
        break;
      case 'show-toolbar':
        toolbar.hidden = false;
        scheduleInspectorLayout();
        announce('Selection ready. Choose an annotation mark.');
        break;
      case 'clear-selection':
        activeRange = null;
        pendingRange = null;
        break;
      case 'hide-toolbar':
        toolbar.hidden = true;
        announce('Selection cleared. Select text in the authorable proof.');
        break;
      case 'create-preview': {
        if (activeRange === null) throw new Error('Inspector preview requires a cloned Range');
        const selection = window.getSelection();
        if (selection === null) throw new Error('Inspector selection is unavailable');
        if (selection.rangeCount !== 1 || !sameRange(selection.getRangeAt(0), activeRange)) {
          throw new Error('Inspector selection changed before preview');
        }
        const created = annotateSelection(annotationOptions(context.next.mark), selection);
        try {
          created.show();
        } catch (error) {
          created.destroy();
          throw error;
        }
        controller = created;
        refreshOutput({ mark: context.next.mark });
        announce(`${context.next.mark} preview ready.`);
        break;
      }
      case 'update-preview':
        if (controller === null) throw new Error('Inspector update requires an owned controller');
        controller.update(annotationOptions(context.next.mark));
        break;
      case 'show-output':
        output.hidden = false;
        syncOutputDisclosure();
        scheduleInspectorLayout();
        break;
      case 'hide-output':
        output.hidden = true;
        break;
      case 'open-note':
        if (isCompactVisualViewport()) {
          outputExpanded = false;
          syncOutputDisclosure();
        }
        noteEditor.hidden = false;
        addNote.setAttribute('aria-expanded', 'true');
        break;
      case 'focus-note':
        note.focus();
        break;
      case 'open-palette':
        paletteFilter.value = '';
        for (const command of paletteCommands) command.hidden = false;
        palette.showModal();
        break;
      case 'focus-palette':
        paletteFilter.focus();
        break;
      case 'close-transient':
        closeTransient(context.previous.transient?.kind);
        break;
      case 'focus-transient-opener':
        if (context.previous.transient?.opener?.isConnected) {
          context.previous.transient.opener.focus();
        }
        break;
      case 'commit-preview':
        announce('Annotation applied. Stable output is being verified.');
        break;
      case 'refresh-output':
        refreshOutput({
          mark: context.next.mark,
          prove: context.next.state === 'applied',
        });
        if (context.next.state === 'applied') {
          announce('Annotation applied. Output is current.');
        }
        break;
      case 'retain-range':
        pendingRange = null;
        break;
      case 'reuse-controller':
        output.hidden = false;
        syncOutputDisclosure();
        announce('Editing the applied annotation.');
        break;
      case 'focus-first-editor':
        markButtons.find(
          (button) => button.dataset.inspectorMark === context.next.mark,
        )?.focus();
        break;
      case 'destroy-owned':
        destroyOwned();
        break;
      case 'close-layers':
        closeTransient('note');
        closeTransient('palette');
        outputExpanded = false;
        syncOutputDisclosure();
        output.hidden = true;
        toolbar.hidden = true;
        copyFallbackWrap.hidden = true;
        break;
      case 'remove-listeners':
        removeListeners();
        break;
      case 'unmount':
        removeFlowerPlugin();
        announce('Inspector closed.');
        inspector.hidden = true;
        inspector.remove();
        open.setAttribute('aria-expanded', 'false');
        activeRange = null;
        pendingRange = null;
        currentOutput = null;
        break;
      case 'focus-connected-invoker':
        if (invoker?.isConnected) invoker.focus();
        invoker = null;
        break;
      default:
        throw new Error(`Unhandled Inspector effect: ${effect}`);
    }
  }

  function dispatch(event) {
    if (disposed) return;
    const previous = model;
    const result = reduceInspector(previous, event);
    const context = createInspectorEffectContext(previous, event, result);
    for (const effect of result.effects) interpret(effect, context);
    model = result.model;
    updateState();
    syncInspectorLayout();
  }

  function chooseMark(mark) {
    if (model.state === 'selected') {
      if (!sameRange(currentRange(scope), activeRange)) {
        dispatch({ type: 'invalid-selection' });
        return;
      }
      dispatch({ type: 'choose-mark', mark });
      return;
    }
    if (model.state === 'applied') {
      dispatch({ type: 'change-mark', mark });
      return;
    }
    if (model.state === 'editing' && model.mark !== mark) {
      dispatch({ type: 'change-mark', mark });
    }
  }

  function openNoteEditor(opener = addNote) {
    if (model.state === 'applied') dispatch({ type: 'edit' });
    if (model.state === 'editing' && model.transient === null) {
      dispatch({ type: 'add-note', opener });
    }
  }

  function updateNote() {
    const count = [...note.value].length;
    const valid = count <= 280;
    noteError.hidden = valid;
    note.toggleAttribute('aria-invalid', !valid);
    if (!valid || model.state !== 'editing' || controller === null) return;
    draft.note = note.value.length === 0 ? null : note.value;
    controller.update({ note: draft.note });
    addNote.textContent = draft.note === null ? 'Add note' : 'Edit note';
    refreshOutput();
    announce(draft.note === null ? 'Note removed.' : 'Note preview updated.');
  }

  function optionValue(control) {
    switch (control.dataset.inspectorOption) {
      case 'accessible':
        return control.checked;
      case 'duration':
        return durationValue(control);
      default:
        return control.value;
    }
  }

  function updateOption(control) {
    const name = control.dataset.inspectorOption;
    const value = optionValue(control);
    if (name === 'duration') {
      const valid = value !== null;
      durationError.hidden = valid;
      duration.toggleAttribute('aria-invalid', !valid);
      if (!valid) return;
    }
    if (model.state !== 'applied' && model.state !== 'editing') return;
    draft[name] = value;
    dispatch({ type: 'valid-option', name, value });
  }

  async function copyCurrentOutput() {
    const format = selectedFormat;
    const entry = currentOutput?.[format];
    if (entry === undefined) return;
    const text = entry.available ? entry.code : entry.reason;
    const label = OUTPUT_LABELS[format];
    const session = openSessionEpoch;
    const operation = clipboardOperationEpoch + 1;
    clipboardOperationEpoch = operation;
    const isCurrent = () => (
      model.state !== 'closed'
      && inspector.isConnected
      && openSessionEpoch === session
      && clipboardOperationEpoch === operation
    );
    try {
      if (navigator.clipboard?.writeText === undefined) {
        throw new Error('Clipboard unavailable');
      }
      await navigator.clipboard.writeText(text);
      if (!isCurrent()) return;
      copyFallbackWrap.hidden = true;
      announce(`${label} output copied.`);
    } catch {
      if (!isCurrent()) return;
      copyFallback.value = text;
      copyFallbackWrap.hidden = false;
      copyFallback.focus();
      copyFallback.select();
      announce(`Copy blocked. ${label} output selected.`);
    }
  }

  function visibleCommands() {
    return paletteCommands.filter((command) => !command.hidden);
  }

  function filterCommands() {
    const query = paletteFilter.value.trim().toLocaleLowerCase();
    for (const command of paletteCommands) {
      command.hidden = query.length > 0
        && !command.textContent.trim().toLocaleLowerCase().includes(query);
    }
  }

  function executeCommand(name) {
    const opener = model.transient?.opener ?? exit;
    if (model.transient?.kind === 'palette') dispatch({ type: 'escape' });
    if (name.startsWith('mark:')) {
      chooseMark(name.slice(5));
    } else if (name === 'note') {
      openNoteEditor(opener);
    } else if (name === 'apply' && model.state === 'editing') {
      dispatch({ type: 'apply' });
    } else if (name === 'cancel' && model.state === 'editing') {
      dispatch({ type: 'cancel' });
    } else if (name === 'copy') {
      void copyCurrentOutput();
    } else if (name === 'close') {
      dispatch({ type: 'close' });
    }
  }

  const listenerOptions = { signal: uiAbort.signal };
  open.addEventListener(
    'click',
    () => dispatch({ type: 'open', invoker: open }),
    listenerOptions,
  );
  exit.addEventListener('click', () => dispatch({ type: 'close' }), listenerOptions);
  for (const [index, button] of markButtons.entries()) {
    button.addEventListener(
      'click',
      () => {
        setActiveMark(index);
        chooseMark(button.dataset.inspectorMark);
      },
      listenerOptions,
    );
    button.addEventListener('keydown', (event) => {
      let next = null;
      if (event.key === 'ArrowRight') next = activeMarkIndex + 1;
      else if (event.key === 'ArrowLeft') next = activeMarkIndex - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = markButtons.length - 1;
      if (next === null) return;
      event.preventDefault();
      setActiveMark(next, { focus: true });
    }, listenerOptions);
  }
  addNote.addEventListener('click', () => openNoteEditor(addNote), listenerOptions);
  note.addEventListener('input', updateNote, listenerOptions);
  noteDone.addEventListener('click', () => {
    if (model.transient?.kind === 'note') dispatch({ type: 'escape' });
  }, listenerOptions);
  apply.addEventListener('click', () => {
    if (model.state === 'editing') dispatch({ type: 'apply' });
  }, listenerOptions);
  cancel.addEventListener('click', () => {
    if (model.state === 'editing') dispatch({ type: 'cancel' });
  }, listenerOptions);
  edit.addEventListener('click', () => {
    if (model.state === 'applied') dispatch({ type: 'edit' });
  }, listenerOptions);

  for (const control of optionsControls) {
    control.addEventListener('input', () => updateOption(control), listenerOptions);
  }

  for (const tab of outputTabs) {
    tab.addEventListener('click', () => {
      const format = tab.getAttribute('aria-controls').replace('inspector-panel-', '');
      selectOutput(format);
    }, listenerOptions);
    tab.addEventListener('keydown', (event) => {
      const current = outputTabs.indexOf(tab);
      let next = null;
      if (event.key === 'ArrowRight') next = (current + 1) % outputTabs.length;
      else if (event.key === 'ArrowLeft') {
        next = (current - 1 + outputTabs.length) % outputTabs.length;
      } else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = outputTabs.length - 1;
      if (next === null) return;
      event.preventDefault();
      const format = outputTabs[next].getAttribute('aria-controls')
        .replace('inspector-panel-', '');
      selectOutput(format, { focus: true });
    }, listenerOptions);
  }
  copy.addEventListener('click', () => void copyCurrentOutput(), listenerOptions);
  outputToggle.addEventListener('click', () => {
    setOutputExpanded(!outputExpanded);
  }, listenerOptions);

  palette.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (model.transient?.kind === 'palette') dispatch({ type: 'escape' });
  }, listenerOptions);
  paletteClose.addEventListener('click', () => {
    if (model.transient?.kind === 'palette') dispatch({ type: 'escape' });
  }, listenerOptions);
  paletteFilter.addEventListener('input', filterCommands, listenerOptions);
  paletteFilter.addEventListener('keydown', (event) => {
    const commands = visibleCommands();
    if (commands.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      (event.key === 'ArrowDown' ? commands[0] : commands.at(-1)).focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      executeCommand(commands[0].dataset.inspectorCommand);
    }
  }, listenerOptions);
  for (const command of paletteCommands) {
    command.addEventListener(
      'click',
      () => executeCommand(command.dataset.inspectorCommand),
      listenerOptions,
    );
    command.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const commands = visibleCommands();
      const current = commands.indexOf(command);
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      commands[(current + direction + commands.length) % commands.length].focus();
    }, listenerOptions);
  }

  resetDraft();
  syncOutputDisclosure();
  selectOutput('javascript', { announceChange: false });
  updateState();
  syncInspectorLayout();

  return function destroyInspector() {
    if (disposed) return;
    if (model.state !== 'closed') dispatch({ type: 'navigation' });
    disposed = true;
    uiAbort.abort();
    removeListeners();
    destroyOwned();
    removeFlowerPlugin();
  };
}
