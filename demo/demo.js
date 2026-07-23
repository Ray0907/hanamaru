import { VERSION, HanamaruTargetError, annotate, scan, story } from '/dist/hanamaru.esm.js';

const localStarter = `<link rel="stylesheet" href="./dist/hanamaru.css">
<script type="module">
  import { scan } from './dist/hanamaru.esm.js'
  scan()
</script>`;

const storySteps = [
  {
    target: { within: '#locator-proof', text: 'follow the phrase it explains' },
    mark: 'underline',
    note: 'Still attached.',
    placement: 'auto',
    duration: 700,
  },
  {
    target: {
      within: '#locator-proof',
      text: 'redraws the correction when the document changes',
    },
    mark: 'circle',
    note: 'Measured again.',
    placement: 'bottom',
    duration: 700,
  },
];

const status = document.querySelector('.demo-status');
const version = document.querySelector('[data-demo-version]');
const locatorProof = document.querySelector('#locator-proof');
const storyState = document.querySelector('[data-demo-story-state]');
const storyStep = document.querySelector('[data-demo-story-step]');
const storyRun = document.querySelector('[data-demo-story-run]');
const completion = document.querySelector('[data-demo-completion]');
const sequenceStages = [...document.querySelectorAll('[data-demo-sequence-stage]')];
const tabs = [...document.querySelectorAll('[role="tab"]')];
const panels = [...document.querySelectorAll('[role="tabpanel"]')];
const storyButtons = Object.fromEntries(
  [...document.querySelectorAll('[data-demo-story-action]')]
    .map((button) => [button.dataset.demoStoryAction, button]),
);
const copyCodeButton = document.querySelector('[data-demo-copy-code]');
const modeApplyButton = document.querySelector('[data-demo-mode-apply]');
const codeFallbackWrap = document.querySelector('[data-demo-code-fallback-wrap]');
const codeFallback = document.querySelector('[data-demo-code-fallback]');
const starterButton = document.querySelector('[data-demo-copy]');
const starterFallbackWrap = document.querySelector('[data-demo-starter-fallback-wrap]');
const starterFallback = document.querySelector('[data-demo-copy-fallback]');
const playgroundLink = document.querySelector('a[href="#playground"].demo-stamp--primary');
const playground = document.querySelector('#playground');
const skipLink = document.querySelector('.demo-skip-link');
const mainContent = document.querySelector('#main-content');
const reflowControl = document.querySelector('[data-demo-reflow-control]');
const reflowValue = document.querySelector('[data-demo-reflow-value]');
const reflowSpecimen = document.querySelector('[data-demo-reflow-specimen]');
const reflowStage = document.querySelector('.demo-reflow-stage');
const reflowInstruction = document.querySelector('#reflow-scroll-instruction');
const reflowTarget = document.querySelector('[data-demo-reflow-target]');
const reflowRegister = reflowSpecimen.querySelector('.demo-reflow-specimen__register');
const ledgerButtons = [...document.querySelectorAll('[data-demo-mark]')];
const ledgerTarget = document.querySelector('[data-demo-ledger-target]');
const ledgerState = document.querySelector('[data-demo-mark-state]');
const ledgerReplay = document.querySelector('[data-demo-mark-replay]');
const modeProof = document.querySelector('[data-demo-mode-proof]');
const modeTarget = document.querySelector('[data-demo-mode-target]');
const modeState = document.querySelector('[data-demo-mode-state]');
const sizeState = document.querySelector('[data-demo-size-state]');
const sizeFields = {
  esm: document.querySelector('[data-testid="size-esm"]'),
  iife: document.querySelector('[data-testid="size-iife"]'),
  css: document.querySelector('[data-testid="size-css"]'),
};
const playgroundForm = document.querySelector('[data-playground-form]');
const playgroundSpecimen = document.querySelector('[data-playground-specimen]');
const playgroundCode = document.querySelector('[data-playground-code]');
const playgroundDocket = document.querySelector('[data-playground-docket]');
const playgroundState = document.querySelector('[data-playground-state]');
const playgroundResult = document.querySelector('[data-playground-result]');
const playgroundOwner = document.querySelector('[data-playground-owner]');
const playgroundTrigger = document.querySelector('[data-playground-trigger]');
const playgroundMethod = document.querySelector('[data-playground-method]');
const playgroundRunCount = document.querySelector('[data-playground-run-count]');
const playgroundRunButton = document.querySelector('[data-playground-run]');
const playgroundCopyButton = document.querySelector('[data-playground-copy]');
const playgroundFallbackWrap = document.querySelector('[data-playground-fallback-wrap]');
const playgroundFallback = document.querySelector('[data-playground-fallback]');
const playgroundTargetControl = playgroundForm.elements.target;
const playgroundNoteControl = playgroundForm.elements.note;
const playgroundTargetError = document.querySelector('#playground-target-error');
const playgroundTargetErrorMessage = document.querySelector('[data-playground-target-error-message]');
const playgroundNoteError = document.querySelector('#playground-note-error');
const playgroundTargetRecords = [
  ['#playground-target-reflow', 'Proof survives reflow', 'the proof survives reflow'],
  ['#playground-target-proof', 'Proof follows text', 'the proof follows text'],
  ['#playground-target-data', 'Definitions remain data', 'definitions remain data'],
].map(([selector, label, text]) => ({
  element: document.getElementById(selector.slice(1)),
  label,
  selector,
  text,
}));
const playgroundTargets = new Map(
  playgroundTargetRecords.map((record) => [record.selector, record]),
);

version.textContent = `v${VERSION}`;
starterFallback.value = localStarter;

let activeFormat = 'story';
let activeIndex = -1;
let activeAnnotation = null;
let acceptedSteps = 0;
let runCount = 0;
let phaseEpoch = 0;
let reflowController = null;
let ledgerController = null;
let ledgerMark = 'underline';
let modeController = null;
let reflowRequested = false;
let appliedMode = null;
let playgroundController = null;
let playgroundControllerCleanup = null;
let playgroundRuns = 0;

const proofStory = story(storySteps, {
  trigger: 'manual',
  gap: 180,
  motion: 'system',
});

function setSequenceStage(name) {
  for (const stage of sequenceStages) {
    if (stage.dataset.demoSequenceStage === name) stage.setAttribute('aria-current', 'step');
    else stage.removeAttribute('aria-current');
  }
}

function followRuntimeMotion(annotation) {
  phaseEpoch += 1;
  const epoch = phaseEpoch;
  const readAnimations = () => {
    if (epoch !== phaseEpoch || activeAnnotation !== annotation
      || proofStory?.state !== 'playing') return;
    const animations = (document.getAnimations?.() ?? []).filter((animation) => {
      const target = animation.effect?.target;
      return animation.playState !== 'finished'
        && target instanceof Element
        && target.matches('.hana-note');
    });
    const animation = animations.at(-1);
    if (animation && typeof animation.currentTime === 'number') {
      const note = animation.effect.target;
      const group = document.querySelector(`.hana-annotation[data-hana-id="${note.dataset.hanaId}"]`);
      const connectorDelay = Number.parseFloat(group?.style.getPropertyValue('--hana-connector-delay')) || 0;
      const noteDelay = Number(animation.effect.getTiming().delay) || 0;
      if (animation.currentTime >= noteDelay) setSequenceStage('note');
      else if (animation.currentTime >= connectorDelay) setSequenceStage('connector');
      else setSequenceStage('mark');
    }
    requestAnimationFrame(readAnimations);
  };
  requestAnimationFrame(readAnimations);
}

function synchronizeCodeStep() {
  const activePanel = panels.find((panel) => panel.dataset.demoPanel === activeFormat);
  for (const panel of panels) {
    for (const step of panel.querySelectorAll('[data-demo-code-step]')) {
      const current = panel === activePanel && Number(step.dataset.demoCodeStep) === activeIndex;
      if (current) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
      const marker = step.querySelector('[data-demo-step-marker]');
      marker.textContent = `${current ? '→ ' : ''}${String(Number(step.dataset.demoCodeStep) + 1).padStart(2, '0')}`;
    }
  }
}

function renderStoryState() {
  const state = proofStory.state;
  storyState.textContent = state;
  storyStep.textContent = activeIndex < 0 ? `— / ${storySteps.length}` : `${activeIndex + 1} / ${storySteps.length}`;
  storyRun.textContent = String(runCount);
  completion.textContent = `${acceptedSteps} of ${storySteps.length} accepted · ${state}`;
  storyButtons.play.disabled = state !== 'idle';
  storyButtons.pause.disabled = state !== 'playing';
  storyButtons.resume.disabled = state !== 'paused';
  storyButtons.replay.disabled = state === 'idle' || state === 'destroyed';
  modeApplyButton.disabled = state === 'playing' || state === 'paused';
}

function selectTab(nextTab, { focus = false } = {}) {
  activeFormat = nextTab.dataset.demoTab;
  for (const tab of tabs) {
    const selected = tab === nextTab;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of panels) {
    panel.hidden = panel.dataset.demoPanel !== activeFormat;
  }
  synchronizeCodeStep();
  const label = nextTab.textContent.trim();
  modeState.textContent = `${label} selected · Apply active mode to run this definition.`;
  if (focus) nextTab.focus();
}

function activeCode() {
  const panel = panels.find((candidate) => candidate.dataset.demoPanel === activeFormat);
  return [...panel.querySelectorAll('[data-demo-code-fragment]')]
    .map((fragment) => fragment.textContent)
    .join('\n');
}

async function copyWithFallback({
  text, successMessage, failureMessage, fallbackWrap, fallback,
}) {
  try {
    if (navigator.clipboard?.writeText === undefined) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    fallbackWrap.hidden = true;
    status.textContent = successMessage;
  } catch {
    fallback.value = text;
    fallbackWrap.hidden = false;
    fallback.focus();
    fallback.select();
    status.textContent = failureMessage;
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    let index;
    if (event.key === 'ArrowRight') index = (tabs.indexOf(tab) + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') index = (tabs.indexOf(tab) - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault();
    selectTab(tabs[index], { focus: true });
  });
}

storyButtons.play.addEventListener('click', () => {
  suspendSectionProofs();
  destroyModeProof({ forget: true });
  proofStory.play();
  renderStoryState();
});
storyButtons.pause.addEventListener('click', () => {
  proofStory?.pause();
  renderStoryState();
  status.textContent = `Story paused at step ${activeIndex + 1}.`;
});
storyButtons.resume.addEventListener('click', () => {
  proofStory?.resume();
  if (proofStory?.state === 'playing' && activeAnnotation !== null) {
    followRuntimeMotion(activeAnnotation);
  }
  renderStoryState();
  status.textContent = `Story resumed at step ${activeIndex + 1}.`;
});
storyButtons.replay.addEventListener('click', () => {
  suspendSectionProofs();
  destroyModeProof({ forget: true });
  proofStory.replay();
  renderStoryState();
});

locatorProof.addEventListener('hana:start', (event) => {
  if (event.detail.controller !== proofStory) return;
  runCount += 1;
  activeIndex = -1;
  activeAnnotation = null;
  acceptedSteps = 0;
  renderStoryState();
  synchronizeCodeStep();
  status.textContent = `Story run ${runCount} started.`;
});

locatorProof.addEventListener('hana:step', (event) => {
  if (event.detail.controller !== proofStory) return;
  activeIndex = event.detail.index;
  activeAnnotation = event.detail.annotation;
  setSequenceStage('code');
  followRuntimeMotion(activeAnnotation);
  synchronizeCodeStep();
  renderStoryState();
});

locatorProof.addEventListener('hana:pause', (event) => {
  if (event.detail.controller === proofStory) renderStoryState();
});

locatorProof.addEventListener('hana:complete', (event) => {
  if (event.detail.controller === activeAnnotation) {
    acceptedSteps = Math.max(acceptedSteps, activeIndex + 1);
    setSequenceStage('advance');
    renderStoryState();
    return;
  }
  if (event.detail.controller !== proofStory) return;
  acceptedSteps = storySteps.length;
  renderStoryState();
  status.textContent = 'Story complete.';
});

locatorProof.addEventListener('hana:cancel', (event) => {
  if (event.detail.controller !== proofStory) return;
  renderStoryState();
  status.textContent = 'Story run replaced.';
});

locatorProof.addEventListener('hana:error', (event) => {
  if (event.detail.controller !== proofStory) return;
  renderStoryState();
  status.textContent = `Story stopped: ${event.detail.error.code}.`;
});

document.addEventListener('animationstart', (event) => {
  if (proofStory?.state !== 'playing') return;
  if (event.target.matches('.hana-note')) setSequenceStage('note');
  else if (event.target.matches('.hana-connector-path')) setSequenceStage('connector');
  else if (event.target.matches('.hana-mark-path')) setSequenceStage('mark');
});

copyCodeButton.addEventListener('click', () => {
  const label = tabs.find((tab) => tab.dataset.demoTab === activeFormat).textContent.trim();
  copyWithFallback({
    text: activeCode(),
    successMessage: `${label} code copied.`,
    failureMessage: `Copy blocked. ${label} code selected.`,
    fallbackWrap: codeFallbackWrap,
    fallback: codeFallback,
  });
});

starterButton.addEventListener('click', () => {
  copyWithFallback({
    text: localStarter,
    successMessage: 'Local starter copied.',
    failureMessage: 'Copy blocked. Local starter selected.',
    fallbackWrap: starterFallbackWrap,
    fallback: starterFallback,
  });
});

playgroundLink.addEventListener('click', () => {
  requestAnimationFrame(() => playground.focus({ preventScroll: true }));
});

skipLink.addEventListener('click', () => {
  requestAnimationFrame(() => {
    mainContent.tabIndex = -1;
    mainContent.focus({ preventScroll: true });
  });
});

function createReflowProof() {
  reflowController?.destroy();
  reflowController = annotate({
    within: '#reflow-target-line',
    text: 'this note stays attached',
  }, {
    mark: 'underline',
    note: 'Placed again after reflow.',
    placement: 'bottom',
    motion: 'never',
    duration: 0,
    seed: 'demo-reflow-proof',
  });
  reflowController.show();
  return reflowController;
}

function createLedgerProof(mark = ledgerMark) {
  ledgerController?.destroy();
  ledgerMark = mark;
  ledgerController = annotate(ledgerTarget, {
    mark,
    motion: 'never',
    duration: 0,
    seed: `demo-ledger-${mark}`,
  });
  ledgerController.show();
  for (const button of ledgerButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.demoMark === mark));
  }
  ledgerState.textContent = `Selected · ${mark}`;
  return ledgerController;
}

function suspendSectionProofs() {
  reflowController?.destroy();
  ledgerController?.destroy();
  reflowController = null;
  ledgerController = null;
}

function centerReflowTarget() {
  const targetRect = reflowTarget.getBoundingClientRect();
  const stageRect = reflowStage.getBoundingClientRect();
  const targetOffset = reflowStage.scrollLeft + targetRect.left - stageRect.left;
  const centered = targetOffset - (reflowStage.clientWidth - targetRect.width) / 2;
  reflowStage.scrollTo({ left: Math.max(0, centered), behavior: 'auto' });
}

function updateReflowScrollAffordance() {
  const overflows = reflowStage.scrollWidth > reflowStage.clientWidth;
  reflowInstruction.hidden = !overflows;
  if (overflows) {
    reflowStage.tabIndex = 0;
    reflowStage.setAttribute('aria-describedby', reflowInstruction.id);
    return;
  }
  reflowStage.removeAttribute('tabindex');
  reflowStage.removeAttribute('aria-describedby');
  reflowStage.scrollLeft = 0;
}

function observeReflowOverflow() {
  updateReflowScrollAffordance();
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(updateReflowScrollAffordance);
    observer.observe(reflowStage);
    observer.observe(reflowSpecimen);
    return () => observer.disconnect();
  }
  window.addEventListener('resize', updateReflowScrollAffordance, { passive: true });
  return () => window.removeEventListener('resize', updateReflowScrollAffordance);
}

reflowControl.addEventListener('input', () => {
  const width = Number(reflowControl.value);
  reflowRequested = true;
  reflowSpecimen.style.width = `${width}px`;
  reflowValue.textContent = `${width}px`;
  reflowRegister.textContent = `${width} / responsive copy measure`;
  updateReflowScrollAffordance();
  centerReflowTarget();
  if (reflowController === null) createReflowProof();
  reflowController.refresh();
  status.textContent = `Proof remeasured at ${width}px.`;
});

for (const button of ledgerButtons) {
  button.addEventListener('click', () => {
    createLedgerProof(button.dataset.demoMark);
    status.textContent = `${button.dataset.demoMark} specimen drawn.`;
  });
}

ledgerReplay.addEventListener('click', () => {
  if (ledgerController === null) createLedgerProof();
  else ledgerController.replay();
  status.textContent = `${ledgerMark} specimen replayed.`;
});

function destroyModeProof({ forget = false } = {}) {
  modeController?.destroy();
  modeController = null;
  delete modeTarget.dataset.hana;
  delete modeTarget.dataset.hanaNote;
  delete modeTarget.dataset.hanaDuration;
  delete modeTarget.dataset.hanaMotion;
  delete modeTarget.dataset.hanaPlacement;
  if (forget) {
    appliedMode = null;
    delete modeTarget.dataset.demoModeApplied;
  }
}

function runHtmlMode() {
  modeTarget.dataset.hana = 'highlight';
  modeTarget.dataset.hanaNote = 'Scanned from authored HTML.';
  modeTarget.dataset.hanaPlacement = 'bottom';
  modeTarget.dataset.hanaDuration = '0';
  modeTarget.dataset.hanaMotion = 'never';
  const result = scan(modeProof);
  if (result.errors.length > 0 || result.annotations.length !== 1) {
    throw result.errors[0] ?? new Error('HTML mode did not produce one annotation');
  }
  [modeController] = result.annotations;
  modeController.show();
  return { mark: 'highlight', method: 'scan()' };
}

function runStoryMode() {
  modeController = story([{
    target: modeTarget,
    mark: 'circle',
    note: 'Played through the Story API.',
    placement: 'bottom',
    duration: 0,
  }], {
    trigger: 'manual',
    gap: 0,
    motion: 'never',
  });
  modeController.play();
  return { mark: 'circle', method: 'story()' };
}

function runJsonMode() {
  const definition = JSON.parse(`{
    "target": "#api-mode-target",
    "mark": "box",
    "note": "Parsed locally, rendered through annotate().",
    "placement": "bottom"
  }`);
  const { target, ...options } = definition;
  modeController = annotate(target, {
    ...options,
    motion: 'never',
    duration: 0,
  });
  modeController.show();
  return { mark: definition.mark, method: 'JSON → annotate()' };
}

function runMode(format) {
  destroyModeProof();
  if (format === 'html') return runHtmlMode();
  if (format === 'story') return runStoryMode();
  return runJsonMode();
}

function modeLabel(format) {
  return tabs.find((tab) => tab.dataset.demoTab === format).textContent.trim();
}

modeApplyButton.addEventListener('click', () => {
  appliedMode = activeFormat;
  modeTarget.scrollIntoView({ block: 'center', behavior: 'auto' });
  const result = runMode(appliedMode);
  modeTarget.dataset.demoModeApplied = appliedMode;
  const label = modeLabel(appliedMode);
  modeState.textContent = `${label} · ${result.method} · ${result.mark} applied.`;
  status.textContent = `${label} mode rendered the ${result.mark} proof.`;
  modeState.focus({ preventScroll: true });
  modeState.scrollIntoView({ block: 'center', behavior: 'auto' });
});

function isInViewport(node, root = null) {
  const rect = node.getBoundingClientRect();
  const rootRect = root?.getBoundingClientRect();
  const left = Math.max(0, rootRect?.left ?? 0);
  const right = Math.min(innerWidth, rootRect?.right ?? innerWidth);
  const top = Math.max(0, rootRect?.top ?? 0);
  const bottom = Math.min(innerHeight, rootRect?.bottom ?? innerHeight);
  return rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right;
}

function observeViewport(node, onChange, { root = null } = {}) {
  let prior;
  const update = (visible) => {
    if (visible === prior) return;
    prior = visible;
    onChange(visible);
  };

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(([entry]) => {
      update(entry.isIntersecting && entry.intersectionRatio > 0);
    }, { root, threshold: [0, 0.01] });
    observer.observe(node);
    return () => observer.disconnect();
  }

  let frame = null;
  const check = () => {
    frame = null;
    update(isInViewport(node, root));
  };
  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(check);
  };
  document.addEventListener('scroll', schedule, { capture: true, passive: true });
  root?.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  schedule();
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    document.removeEventListener('scroll', schedule, true);
    root?.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
  };
}

const visibilityCleanups = [
  observeReflowOverflow(),
  observeViewport(reflowTarget, (visible) => {
    if (!reflowRequested) return;
    if (!visible) {
      reflowController?.hide();
      return;
    }
    if (reflowController === null) createReflowProof();
    else {
      reflowController.show();
      reflowController.refresh();
    }
  }, { root: reflowStage }),
  observeViewport(modeTarget, (visible) => {
    if (appliedMode === null) return;
    if (!visible) {
      if (modeController !== null) destroyModeProof();
      modeState.textContent = `${modeLabel(appliedMode)} result is offscreen · return to redraw.`;
      return;
    }
    if (modeController !== null) return;
    const result = runMode(appliedMode);
    modeTarget.dataset.demoModeApplied = appliedMode;
    modeState.textContent = `${modeLabel(appliedMode)} · ${result.method} · ${result.mark} redrawn.`;
  }),
];

function showUnavailableSize() {
  const message = 'size unavailable in this local build';
  sizeState.textContent = message;
  for (const field of Object.values(sizeFields)) field.textContent = message;
}

async function loadSizeReport() {
  try {
    const response = await fetch('/dist/size-report.json');
    if (!response.ok) throw new Error('Size report unavailable');
    const report = await response.json();
    const isByteMetric = (value) => Number.isInteger(value) && value >= 0;
    const hasValidBudgets = isByteMetric(report.budgets?.hardCombinedGzip)
      && isByteMetric(report.budgets?.stretchCombinedGzip);
    const hasValidCss = report.css?.file === 'hanamaru.css'
      && isByteMetric(report.css.gzip);
    if (report.schemaVersion !== 1 || !hasValidBudgets || !hasValidCss
      || !Array.isArray(report.formats) || report.formats.length !== 2) {
      throw new Error('Size report invalid');
    }
    const esm = report.formats.find(({ file }) => file === 'hanamaru.esm.js');
    const iife = report.formats.find(({ file }) => file === 'hanamaru.iife.js');
    const validFormat = (entry) => entry !== undefined
      && ['combined', 'cssGzip', 'gzip', 'raw'].every((key) => isByteMetric(entry[key]))
      && typeof entry.stretch === 'boolean'
      && entry.cssGzip === report.css.gzip
      && entry.combined === entry.gzip + entry.cssGzip;
    if (!validFormat(esm) || !validFormat(iife)) {
      throw new Error('Size report invalid');
    }
    const format = (value) => value.toLocaleString('en-US');
    sizeFields.esm.textContent = `${format(esm.combined)} B gzip incl. CSS`;
    sizeFields.iife.textContent = `${format(iife.combined)} B gzip incl. CSS`;
    sizeFields.css.textContent = `${format(report.css.gzip)} B gzip`;
    sizeState.textContent = 'Measured from dist/size-report.json.';
  } catch {
    showUnavailableSize();
  }
}

const firstRange = document.createRange();
firstRange.selectNodeContents(document.querySelector('[data-demo-range-first]'));
const nextRange = document.createRange();
nextRange.selectNodeContents(document.querySelector('[data-demo-range-second]'));
const rangeProof = annotate(firstRange, {
  mark: 'box',
  motion: 'never',
  duration: 0,
  seed: 'demo-native-range',
});
const rangeButton = document.querySelector('[data-demo-range-action]');
const rangeState = document.querySelector('[data-demo-range-state]');
let rangePosition = 'idle';

rangeButton.addEventListener('click', () => {
  if (rangePosition === 'idle') {
    rangeProof.show();
    rangePosition = 'first';
    rangeButton.textContent = 'Move native Range target';
    rangeState.textContent = 'Target · first phrase';
    status.textContent = 'Native Range drawn.';
    return;
  }
  if (rangePosition === 'first') {
    rangeProof.update({ target: nextRange });
    rangePosition = 'second';
    rangeButton.textContent = 'Reset native Range target';
    rangeState.textContent = 'Target · second phrase';
    status.textContent = 'Native Range target replaced.';
    return;
  }
  rangeProof.update({ target: firstRange });
  rangePosition = 'first';
  rangeButton.textContent = 'Move native Range target';
  rangeState.textContent = 'Target · first phrase';
  status.textContent = 'Native Range target reset.';
});

const playgroundOwnedAttributes = [
  'data-hana',
  'data-hana-note',
  'data-hana-placement',
  'data-hana-trigger',
  'data-hana-accessible',
  'data-hana-duration',
  'data-hana-motion',
];

function playgroundTargetRecord(selector) {
  const record = playgroundTargets.get(selector);
  if (record === undefined
    || !(record.element instanceof Element)
    || !record.element.isConnected
    || record.element.ownerDocument !== document
    || !playgroundSpecimen.contains(record.element)
    || record.element.id !== record.selector.slice(1)
    || record.element.textContent.trim() !== record.text) return null;
  return record;
}

function playgroundSelection() {
  const values = new FormData(playgroundForm);
  const target = String(values.get('target') ?? '');
  const targetRecord = playgroundTargets.get(target);
  return {
    target,
    targetLabel: targetRecord?.label ?? 'Unrecognized phrase',
    mark: String(values.get('mark') ?? ''),
    note: String(values.get('note') ?? '').trim(),
    placement: String(values.get('placement') ?? ''),
    trigger: String(values.get('trigger') ?? ''),
    mode: String(values.get('mode') ?? ''),
  };
}

function playgroundSingleQuote(value) {
  return `'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\n', '\\n')}'`;
}

function playgroundEscapeAttribute(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function invalidPlaygroundDefinition(mode) {
  const format = mode === 'declarative' ? 'HTML' : 'JavaScript';
  return `/* Choose one existing specimen phrase to generate ${format}. */`;
}

function imperativeDefinition(selection) {
  const targetRecord = playgroundTargetRecord(selection.target);
  if (targetRecord === null) return invalidPlaygroundDefinition(selection.mode);
  const optionLines = [
    `  mark: ${playgroundSingleQuote(selection.mark)},`,
  ];
  if (selection.note !== '') {
    optionLines.push(`  note: ${playgroundSingleQuote(selection.note)},`);
    optionLines.push('  accessible: true,');
  }
  optionLines.push(`  placement: ${playgroundSingleQuote(selection.placement)},`);
  optionLines.push(`  trigger: ${playgroundSingleQuote(selection.trigger)},`);
  optionLines.push("  motion: 'never',");
  optionLines.push('  duration: 0,');

  const showLine = selection.trigger === 'manual' ? '\nannotation.show()' : '';
  return `import { annotate } from '/dist/hanamaru.esm.js'\n\n`
    + `const annotation = annotate(${playgroundSingleQuote(targetRecord.selector)}, {\n`
    + `${optionLines.join('\n')}\n})${showLine}`;
}

function declarativeDefinition(selection) {
  const targetRecord = playgroundTargetRecord(selection.target);
  if (targetRecord === null) return invalidPlaygroundDefinition(selection.mode);
  const text = playgroundEscapeAttribute(targetRecord.text);
  const attributes = [
    `  data-hana="${playgroundEscapeAttribute(selection.mark)}"`,
  ];
  if (selection.note !== '') {
    attributes.push(`  data-hana-note="${playgroundEscapeAttribute(selection.note)}"`);
    attributes.push('  data-hana-accessible');
  }
  attributes.push(`  data-hana-placement="${playgroundEscapeAttribute(selection.placement)}"`);
  attributes.push(`  data-hana-trigger="${playgroundEscapeAttribute(selection.trigger)}"`);
  attributes.push('  data-hana-motion="never"');
  attributes.push('  data-hana-duration="0"');
  const showLine = selection.trigger === 'manual' ? '\nannotation.show()' : '';

  return `<span id="${targetRecord.selector.slice(1)}"\n${attributes.join('\n')}>`
    + `${text}</span>\n\n`
    + `<script type="module">\n`
    + `  import { scan } from '/dist/hanamaru.esm.js'\n\n`
    + `  const root = document.querySelector('[data-playground-specimen]')\n`
    + `  const { annotations, errors } = scan(root)\n`
    + `  if (errors.length) throw errors[0]\n`
    + `  const [annotation] = annotations${showLine}\n`
    + `</script>`;
}

function renderPlaygroundDefinition({ edited = false } = {}) {
  const selection = playgroundSelection();
  playgroundCode.textContent = selection.mode === 'declarative'
    ? declarativeDefinition(selection)
    : imperativeDefinition(selection);
  playgroundMethod.textContent = selection.mode === 'declarative' ? 'scan()' : 'annotate()';
  playgroundTrigger.textContent = selection.trigger === 'manual'
    ? 'manual · explicit show'
    : `${selection.trigger} · automatic`;
  playgroundFallbackWrap.hidden = true;
  if (edited && playgroundController !== null) {
    playgroundResult.textContent = 'Definition changed · run to apply';
  }
}

function clearPlaygroundElementAuthorship(target) {
  if (!(target instanceof Element)) return;
  for (const attribute of playgroundOwnedAttributes) target.removeAttribute(attribute);
  target.removeAttribute('data-playground-output-owner');
}

function clearPlaygroundAuthorship() {
  for (const { element } of playgroundTargetRecords) {
    clearPlaygroundElementAuthorship(element);
  }
}

function destroyPlaygroundController() {
  playgroundControllerCleanup?.();
  playgroundControllerCleanup = null;
  playgroundController?.destroy();
  playgroundController = null;
  clearPlaygroundAuthorship();
}

function setPlaygroundFieldError(control, error, message) {
  control.setCustomValidity(message);
  control.setAttribute('aria-invalid', 'true');
  error.hidden = false;
}

function setPlaygroundTargetError(message) {
  playgroundTargetErrorMessage.textContent = message;
  setPlaygroundFieldError(playgroundTargetControl, playgroundTargetError, message);
}

function clearPlaygroundErrors() {
  for (const [control, error] of [
    [playgroundTargetControl, playgroundTargetError],
    [playgroundNoteControl, playgroundNoteError],
  ]) {
    control.setCustomValidity('');
    control.removeAttribute('aria-invalid');
    error.hidden = true;
  }
}

function validatePlayground(selection) {
  clearPlaygroundErrors();
  if (!playgroundTargets.has(selection.target)) {
    setPlaygroundTargetError('Choose one existing phrase.');
    return playgroundTargetControl;
  }
  if (playgroundTargetRecord(selection.target) === null) {
    setPlaygroundTargetError('The selected phrase is unavailable. Choose another existing phrase.');
    return playgroundTargetControl;
  }
  if ([...selection.note].length > 280) {
    setPlaygroundFieldError(
      playgroundNoteControl,
      playgroundNoteError,
      'Keep the note to 280 characters.',
    );
    return playgroundNoteControl;
  }
  return null;
}

function authorPlaygroundAttributes(target, selection) {
  target.dataset.hana = selection.mark;
  target.dataset.hanaPlacement = selection.placement;
  target.dataset.hanaTrigger = selection.trigger;
  target.dataset.hanaMotion = 'never';
  target.dataset.hanaDuration = '0';
  if (selection.note !== '') {
    target.dataset.hanaNote = selection.note;
    target.setAttribute('data-hana-accessible', '');
  }
}

function playgroundTargetFailure(cause) {
  if (cause instanceof HanamaruTargetError) return cause;
  return new HanamaruTargetError(
    'HANA_TARGET_MISSING',
    'The selected playground target could not be scanned',
    { cause },
  );
}

function bindPlaygroundController(controller, target, selection) {
  const handles = {
    start(event) {
      if (event.detail.controller !== controller) return;
      playgroundRuns += 1;
      playgroundRunCount.textContent = String(playgroundRuns);
      playgroundState.textContent = controller.state;
      playgroundResult.textContent = `Drawing · ${selection.mark}`;
    },
    complete(event) {
      if (event.detail.controller !== controller) return;
      playgroundState.textContent = controller.state;
      playgroundResult.textContent = `Rendered · ${selection.mark}`;
      status.textContent = `Playground rendered ${selection.mark} on ${selection.targetLabel}.`;
    },
    cancel(event) {
      if (event.detail.controller !== controller) return;
      playgroundState.textContent = controller.state;
      playgroundResult.textContent = 'Replaced by the next run';
    },
    error(event) {
      if (event.detail.controller !== controller) return;
      const code = event.detail.error?.code ?? 'HANA_STATE_RUNTIME';
      playgroundState.textContent = 'error';
      playgroundResult.textContent = `Runtime error · ${code}`;
      status.textContent = `Playground stopped: ${code}.`;
      playgroundDocket.focus({ preventScroll: true });
    },
  };
  for (const [type, handle] of Object.entries(handles)) {
    target.addEventListener(`hana:${type}`, handle);
  }
  return () => {
    for (const [type, handle] of Object.entries(handles)) {
      target.removeEventListener(`hana:${type}`, handle);
    }
  };
}

function createPlaygroundController(targetRecord, selection) {
  const { element: target } = targetRecord;
  if (selection.mode === 'declarative') {
    authorPlaygroundAttributes(target, selection);
    let result;
    try {
      result = scan(playgroundSpecimen);
    } catch (cause) {
      throw playgroundTargetFailure(cause);
    }
    if (result.errors.length > 0 || result.annotations.length !== 1) {
      for (const annotation of result.annotations) annotation.destroy();
      throw playgroundTargetFailure(result.errors[0]);
    }
    return result.annotations[0];
  }
  const options = {
    mark: selection.mark,
    placement: selection.placement,
    trigger: selection.trigger,
    motion: 'never',
    duration: 0,
  };
  if (selection.note !== '') {
    options.note = selection.note;
    options.accessible = true;
  }
  return annotate(targetRecord.selector, options);
}

function runPlayground() {
  destroyPlaygroundController();
  playgroundOwner.textContent = 'No output yet';
  const selection = playgroundSelection();
  const invalidControl = validatePlayground(selection);
  if (invalidControl !== null) {
    playgroundState.textContent = 'error';
    playgroundResult.textContent = 'Needs correction · invalid input';
    playgroundOwner.textContent = 'No output · input invalid';
    status.textContent = 'Playground needs correction. Review the focused field.';
    invalidControl.focus();
    return;
  }

  const targetRecord = playgroundTargetRecord(selection.target);
  const target = targetRecord.element;
  try {
    playgroundController = createPlaygroundController(targetRecord, selection);
    playgroundControllerCleanup = bindPlaygroundController(
      playgroundController,
      target,
      selection,
    );
    target.setAttribute('data-playground-output-owner', '');
    playgroundOwner.textContent = selection.targetLabel;
    playgroundMethod.textContent = selection.mode === 'declarative' ? 'scan()' : 'annotate()';
    playgroundTrigger.textContent = selection.trigger === 'manual'
      ? 'manual · explicit show'
      : `${selection.trigger} · automatic`;
    playgroundState.textContent = playgroundController.state;
    playgroundResult.textContent = selection.trigger === 'manual'
      ? 'Running · explicit show'
      : `Waiting · ${selection.trigger} trigger armed`;
    if (selection.trigger === 'manual') playgroundController.show();
  } catch (error) {
    playgroundControllerCleanup?.();
    playgroundControllerCleanup = null;
    playgroundController?.destroy();
    playgroundController = null;
    clearPlaygroundElementAuthorship(target);
    const code = typeof error?.code === 'string' ? error.code : 'HANA_STATE_RUNTIME';
    playgroundState.textContent = 'error';
    playgroundResult.textContent = `Runtime error · ${code}`;
    playgroundOwner.textContent = 'No output · run failed';
    status.textContent = `Playground stopped: ${code}.`;
    if (error instanceof HanamaruTargetError) {
      setPlaygroundTargetError('The selected phrase became unavailable. Choose an existing phrase.');
      playgroundTargetControl.focus();
    } else {
      playgroundDocket.focus();
    }
  }
}

async function copyPlaygroundDefinition() {
  const definition = playgroundCode.textContent;
  try {
    if (navigator.clipboard?.writeText === undefined) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(definition);
    playgroundFallbackWrap.hidden = true;
    playgroundResult.textContent = 'Copied · exact current definition';
    status.textContent = 'Playground definition copied.';
  } catch {
    playgroundFallback.value = definition;
    playgroundFallbackWrap.hidden = false;
    playgroundFallback.focus();
    playgroundFallback.select();
    playgroundResult.textContent = 'Copy blocked · definition selected';
    status.textContent = 'Copy blocked. Playground definition selected.';
  }
}

playgroundForm.addEventListener('input', () => {
  clearPlaygroundErrors();
  renderPlaygroundDefinition({ edited: true });
});
playgroundRunButton.addEventListener('click', runPlayground);
playgroundCopyButton.addEventListener('click', copyPlaygroundDefinition);

window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  for (const cleanup of visibilityCleanups) cleanup();
  proofStory?.destroy();
  rangeProof.destroy();
  suspendSectionProofs();
  destroyModeProof({ forget: true });
  destroyPlaygroundController();
});

selectTab(document.querySelector('[data-demo-tab="story"]'));
renderStoryState();
renderPlaygroundDefinition();
loadSizeReport();
