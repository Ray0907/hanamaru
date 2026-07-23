import { annotate } from '/src/index.js';
import { registerMark } from '/src/plugins.js';

const unhandledRejections = [];
const onUnhandledRejection = (event) => {
  unhandledRejections.push(String(event.reason?.message ?? event.reason));
};
window.addEventListener('unhandledrejection', onUnhandledRejection);

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

function cleanupAll(cleanups) {
  const errors = [];
  for (let index = cleanups.length - 1; index >= 0; index -= 1) {
    try { cleanups[index](); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Plugin CSP cleanup failed');
}

const initialInventory = resourceInventory();

window.__pluginCsp = Object.freeze({
  initialInventory,
  unhandledRejections,
  async run() {
    const cleanups = [];
    let visible;
    try {
      cleanups.push(
        () => window.removeEventListener('unhandledrejection', onUnhandledRejection),
      );
      const unregister = registerMark('csp-hanamaru', ({ rects }) => ({
        paths: rects.map((rect) => (
          `M ${rect.left} ${rect.top} L ${rect.right} ${rect.bottom}`
        )),
      }));
      cleanups.push(unregister);
      const controller = annotate(document.querySelector('#csp-plugin-target'), {
        mark: 'csp-hanamaru',
        motion: 'never',
      });
      cleanups.push(() => controller.destroy());
      controller.show();
      await controller.finished;
      visible = {
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
        paths: [...document.querySelectorAll('.hana-mark-path')]
          .map((path) => path.getAttribute('d')),
        state: controller.state,
      };
      await Promise.resolve();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    } finally {
      cleanupAll(cleanups);
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
