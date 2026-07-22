import { VERSION, annotate, story } from '/dist/hanamaru.esm.js';

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
const codeFallbackWrap = document.querySelector('[data-demo-code-fallback-wrap]');
const codeFallback = document.querySelector('[data-demo-code-fallback]');
const starterButton = document.querySelector('[data-demo-copy]');
const starterFallbackWrap = document.querySelector('[data-demo-starter-fallback-wrap]');
const starterFallback = document.querySelector('[data-demo-copy-fallback]');
const playgroundLink = document.querySelector('a[href="#playground"].demo-stamp--primary');
const playground = document.querySelector('#playground');

version.textContent = `v${VERSION}`;
starterFallback.value = localStarter;

let activeFormat = 'story';
let activeIndex = -1;
let activeAnnotation = null;
let acceptedSteps = 0;
let runCount = 0;
let phaseEpoch = 0;

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
      || (proofStory.state !== 'playing' && proofStory.state !== 'paused')) return;
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
  renderStoryState();
  status.textContent = `Story resumed at step ${activeIndex + 1}.`;
});
storyButtons.replay.addEventListener('click', () => {
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

window.addEventListener('pagehide', () => {
  proofStory.destroy();
  rangeProof.destroy();
}, { once: true });

selectTab(document.querySelector('[data-demo-tab="story"]'));
renderStoryState();
