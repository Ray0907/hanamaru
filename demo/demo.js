import { VERSION } from '/dist/hanamaru.esm.js';

const localStarter = `<link rel="stylesheet" href="./dist/hanamaru.css">
<script type="module">
  import { scan } from './dist/hanamaru.esm.js'
  scan()
</script>`;

const copyButton = document.querySelector('[data-demo-copy]');
const fallbackLabel = document.querySelector('.demo-copy-fallback');
const fallbackField = document.querySelector('[data-demo-copy-fallback]');
const status = document.querySelector('.demo-status');
const version = document.querySelector('[data-demo-version]');

version.textContent = `v${VERSION}`;
fallbackField.value = localStarter;

copyButton.addEventListener('click', async () => {
  if (navigator.clipboard?.writeText === undefined) {
    fallbackLabel.hidden = false;
    fallbackField.focus();
    fallbackField.select();
    status.textContent = 'Clipboard unavailable. Local starter selected for manual copy.';
    return;
  }

  try {
    await navigator.clipboard.writeText(localStarter);
    fallbackLabel.hidden = true;
    status.textContent = 'Local starter copied.';
  } catch {
    fallbackLabel.hidden = false;
    fallbackField.focus();
    fallbackField.select();
    status.textContent = 'Copy was blocked. Local starter selected for manual copy.';
  }
});
