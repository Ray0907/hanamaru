import { annotate } from '/src/index.js';
import { registerMark } from '/src/plugins.js';

const unhandledRejections = [];
window.addEventListener('unhandledrejection', (event) => {
  unhandledRejections.push(String(event.reason?.message ?? event.reason));
});

function resourceInventory() {
  return {
    scripts: [...document.scripts].map((script) => ({
      inline: script.textContent,
      src: script.getAttribute('src'),
      type: script.getAttribute('type'),
    })),
    styleElements: [...document.querySelectorAll('style')].map((style) => style.outerHTML),
    stylesheetLinks: [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => ({
      href: link.getAttribute('href'),
      rel: link.getAttribute('rel'),
    })),
  };
}

const initialInventory = resourceInventory();

window.__pluginCsp = Object.freeze({
  initialInventory,
  unhandledRejections,
  async run() {
    const unregister = registerMark('csp-hanamaru', ({ rects }) => ({
      paths: rects.map((rect) => (
        `M ${rect.left} ${rect.top} L ${rect.right} ${rect.bottom}`
      )),
    }));
    const controller = annotate(document.querySelector('#csp-plugin-target'), {
      mark: 'csp-hanamaru',
      motion: 'never',
    });
    let visible;
    try {
      controller.show();
      await controller.finished;
      visible = {
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
        paths: [...document.querySelectorAll('.hana-mark-path')]
          .map((path) => path.getAttribute('d')),
        state: controller.state,
      };
    } finally {
      controller.destroy();
      unregister();
    }
    return {
      after: resourceInventory(),
      before: initialInventory,
      cleanup: {
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
        owned: document.querySelectorAll('[data-hana-id]').length,
      },
      visible,
    };
  },
  inventory: resourceInventory,
});
window.dispatchEvent(new Event('plugin-csp-ready'));
