import { VERSION, annotate, scan, story } from '/dist/hanamaru.esm.js';

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
    placement: 'auto',
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
const reflowControl = document.querySelector('[data-demo-reflow-control]');
const reflowValue = document.querySelector('[data-demo-reflow-value]');
const reflowSpecimen = document.querySelector('[data-demo-reflow-specimen]');
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
      || proofStory.state !== 'playing') return;
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
  destroyModeProof();
  proofStory.play();
  renderStoryState();
});
storyButtons.pause.addEventListener('click', () => {
  proofStory.pause();
  renderStoryState();
  status.textContent = `Story paused at step ${activeIndex + 1}.`;
});
storyButtons.resume.addEventListener('click', () => {
  proofStory.resume();
  if (proofStory.state === 'playing' && activeAnnotation !== null) {
    followRuntimeMotion(activeAnnotation);
  }
  renderStoryState();
  status.textContent = `Story resumed at step ${activeIndex + 1}.`;
});
storyButtons.replay.addEventListener('click', () => {
  suspendSectionProofs();
  destroyModeProof();
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
  if (proofStory.state !== 'playing') return;
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

function createReflowProof() {
  reflowController?.destroy();
  reflowController = annotate({
    within: '#reflow-copy',
    text: 'this note stays attached',
  }, {
    mark: 'underline',
    note: 'Placed again after reflow.',
    placement: 'auto',
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

reflowControl.addEventListener('input', () => {
  const width = Number(reflowControl.value);
  reflowSpecimen.style.width = `${width}px`;
  reflowValue.textContent = `${width}px`;
  reflowRegister.textContent = `${width} / responsive copy measure`;
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

function destroyModeProof() {
  modeController?.destroy();
  modeController = null;
  delete modeTarget.dataset.hana;
  delete modeTarget.dataset.hanaNote;
  delete modeTarget.dataset.hanaDuration;
  delete modeTarget.dataset.hanaMotion;
}

function runHtmlMode() {
  modeTarget.dataset.hana = 'highlight';
  modeTarget.dataset.hanaNote = 'Scanned from authored HTML.';
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
    "note": "Parsed locally, rendered through annotate()."
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

modeApplyButton.addEventListener('click', () => {
  destroyModeProof();
  let result;
  if (activeFormat === 'html') result = runHtmlMode();
  else if (activeFormat === 'story') result = runStoryMode();
  else result = runJsonMode();
  modeTarget.dataset.demoModeApplied = activeFormat;
  const label = tabs.find((tab) => tab.dataset.demoTab === activeFormat).textContent.trim();
  modeState.textContent = `${label} · ${result.method} · ${result.mark} applied.`;
  status.textContent = `${label} mode rendered the ${result.mark} proof.`;
  modeTarget.scrollIntoView({ block: 'center', behavior: 'auto' });
});

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
    const esm = report.formats.find(({ file }) => file === 'hanamaru.esm.js');
    const iife = report.formats.find(({ file }) => file === 'hanamaru.iife.js');
    if (!esm || !iife || !Number.isInteger(report.css?.gzip)) {
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

window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  proofStory.destroy();
  rangeProof.destroy();
  suspendSectionProofs();
  destroyModeProof();
});

selectTab(document.querySelector('[data-demo-tab="story"]'));
renderStoryState();
loadSizeReport();
