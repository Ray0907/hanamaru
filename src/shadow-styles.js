import {
  HanamaruConfigError,
  HanamaruStateError,
} from './errors.js';
import {
  claimShadowRootSlot,
  releaseShadowRootSlot,
  runtimeState,
} from './runtime-state.js';

const SHADOW_CSS = `.hana-shadow-mirror {
  --hana-shadow-style: 1;
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  padding: 0 !important;
  margin: -1px !important;
  overflow: hidden !important;
  clip: rect(0 0 0 0) !important;
  clip-path: inset(50%) !important;
  white-space: nowrap !important;
  border: 0 !important;
}
`;
const INTERNAL_CONFIG_ERRORS = new WeakSet();

function configError(message, details) {
  const error = new HanamaruConfigError(
    'HANA_CONFIG_SHADOW_STYLES',
    message,
    details,
  );
  INTERNAL_CONFIG_ERRORS.add(error);
  return error;
}

function invalid(field, value) {
  throw configError(
    `Invalid Shadow styles ${field}`,
    { field, value },
  );
}

function reflectStyles(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
      invalid('configuration', value);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) {
      invalid('configuration', value);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys) {
      if (!Object.hasOwn(descriptors[key], 'value')) invalid(key, value);
    }
    return { keys, descriptors };
  } catch (cause) {
    if (INTERNAL_CONFIG_ERRORS.has(cause)) throw cause;
    throw configError(
      'Invalid Shadow styles configuration',
      { field: 'configuration', value, cause },
    );
  }
}

function exactKeys(keys, allowed) {
  return keys.every((key) => allowed.includes(key));
}

export function normalizeShadowStyles(value = undefined) {
  if (value === undefined) {
    return { mode: 'auto', nonce: undefined };
  }

  const { keys, descriptors } = reflectStyles(value);
  const mode = descriptors.mode === undefined
    ? 'auto'
    : descriptors.mode.value;
  if (mode === 'auto') {
    if (!exactKeys(keys, ['mode', 'nonce'])) invalid('configuration', value);
    const nonce = descriptors.nonce?.value;
    if (nonce !== undefined
      && (typeof nonce !== 'string' || nonce.length === 0)) {
      invalid('nonce', nonce);
    }
    return { mode: 'auto', nonce };
  }

  if (mode === 'sheet') {
    if (!exactKeys(keys, ['mode', 'sheet'])
      || descriptors.sheet === undefined) invalid('configuration', value);
    const sheet = descriptors.sheet.value;
    if (sheet === null || typeof sheet !== 'object' || Array.isArray(sheet)) {
      invalid('sheet', sheet);
    }
    return { mode: 'sheet', sheet };
  }

  if (mode === 'preinstalled') {
    if (keys.length !== 1 || keys[0] !== 'mode') invalid('configuration', value);
    return { mode: 'preinstalled' };
  }

  invalid('mode', mode);
}

function compatible(current, incoming) {
  if (current.mode !== incoming.mode) return false;
  if (current.mode === 'auto') return current.nonce === incoming.nonce;
  if (current.mode === 'sheet') return current.sheet === incoming.sheet;
  return true;
}

function assertBrowserSheet(root, config) {
  if (config.mode !== 'sheet') return;
  const Sheet = root?.ownerDocument?.defaultView?.CSSStyleSheet;
  try {
    if (typeof Sheet === 'function' && !(config.sheet instanceof Sheet)) {
      throw new TypeError('sheet is not a CSSStyleSheet from the ShadowRoot realm');
    }
  } catch (cause) {
    throw configError(
      'Invalid Shadow styles sheet',
      { field: 'sheet', value: config.sheet, cause },
    );
  }
}

function stateError(cause, details = {}) {
  return new HanamaruStateError(
    'HANA_STATE_SHADOW_STYLES',
    'Shadow root styles could not be installed',
    { ...details, cause },
  );
}

function realmFor(root) {
  const realm = root?.ownerDocument?.defaultView;
  if (realm === null || typeof realm !== 'object') {
    throw new TypeError('ShadowRoot has no browsing realm');
  }
  return realm;
}

function adoptedSheets(root) {
  const sheets = root.adoptedStyleSheets;
  if (!Array.isArray(sheets)) {
    throw new TypeError('ShadowRoot adoptedStyleSheets is unavailable');
  }
  return sheets;
}

function removeAdoption(root, sheet) {
  const current = adoptedSheets(root);
  if (!current.includes(sheet)) return;
  root.adoptedStyleSheets = current.filter((candidate) => candidate !== sheet);
}

function browserAdapter() {
  return {
    installAuto(root, config, css) {
      const realm = realmFor(root);
      if (typeof realm.CSSStyleSheet === 'function'
        && typeof realm.CSSStyleSheet.prototype?.replaceSync === 'function'
        && 'adoptedStyleSheets' in root) {
        const sheet = new realm.CSSStyleSheet();
        sheet.replaceSync(css);
        root.adoptedStyleSheets = [...adoptedSheets(root), sheet];
        let released = false;
        return {
          owned: true,
          release() {
            if (released) return;
            released = true;
            removeAdoption(root, sheet);
          },
        };
      }

      const style = root.ownerDocument.createElement('style');
      style.setAttribute('data-hana-shadow-style', '');
      style.textContent = css;
      if (config.nonce !== undefined) style.setAttribute('nonce', config.nonce);
      root.append(style);
      let released = false;
      return {
        owned: true,
        release() {
          if (released) return;
          released = true;
          style.remove();
        },
      };
    },

    adoptSheet(root, config) {
      const realm = realmFor(root);
      const { sheet } = config;
      if (typeof realm.CSSStyleSheet !== 'function'
        || !(sheet instanceof realm.CSSStyleSheet)) {
        throw new TypeError('sheet must be a CSSStyleSheet from the ShadowRoot realm');
      }
      const current = adoptedSheets(root);
      const added = !current.includes(sheet);
      if (added) root.adoptedStyleSheets = [...current, sheet];
      let released = false;
      return {
        owned: added,
        release() {
          if (released) return;
          released = true;
          if (added) removeAdoption(root, sheet);
        },
      };
    },

    verifyMarker(root) {
      const probe = root.ownerDocument.createElement('span');
      probe.className = 'hana-shadow-mirror';
      probe.setAttribute('aria-hidden', 'true');
      try {
        root.append(probe);
        const marker = realmFor(root)
          .getComputedStyle(probe)
          .getPropertyValue('--hana-shadow-style')
          .trim();
        if (marker !== '1') {
          throw new TypeError('Hanamaru Shadow style marker is missing');
        }
      } finally {
        probe.remove();
      }
    },

    rollback(root, install) {
      install?.release();
    },
  };
}

function validateInstall(install, mode) {
  if (install === null || typeof install !== 'object'
    || typeof install.owned !== 'boolean'
    || typeof install.release !== 'function') {
    throw new TypeError(`${mode} style installation returned an invalid record`);
  }
  return install;
}

function leaseFor(root, record) {
  let released = false;
  return Object.freeze({
    config: record.config,
    owned: record.install.owned,
    release() {
      if (released) return;
      released = true;
      record.count -= 1;
      if (record.count !== 0) return;
      let cause;
      try {
        record.install.release();
      } catch (error) {
        cause = error;
      } finally {
        releaseShadowRootSlot(root, 'styles', record);
      }
      if (cause !== undefined) {
        throw stateError(cause, { operation: 'release' });
      }
    },
  });
}

export function acquireShadowStyles(root, value = undefined, adapter = undefined) {
  const config = normalizeShadowStyles(value);
  if (adapter === undefined) assertBrowserSheet(root, config);
  const existing = runtimeState.shadows.get(root)?.styles ?? null;
  if (existing !== null) {
    if (!compatible(existing.config, config)) {
      throw configError(
        'Shadow root already uses an incompatible style configuration',
        { current: existing.config, incoming: config },
      );
    }
    existing.count += 1;
    return leaseFor(root, existing);
  }

  const activeAdapter = adapter ?? browserAdapter();
  let install = null;
  try {
    if (config.mode === 'auto') {
      install = validateInstall(
        activeAdapter.installAuto(root, config, SHADOW_CSS),
        config.mode,
      );
    } else if (config.mode === 'sheet') {
      install = validateInstall(
        activeAdapter.adoptSheet(root, config, SHADOW_CSS),
        config.mode,
      );
    } else {
      install = {
        owned: false,
        release() {},
      };
    }
    activeAdapter.verifyMarker(root, config, install);
    const record = { config, count: 1, install };
    claimShadowRootSlot(root, 'styles', record);
    return leaseFor(root, record);
  } catch (cause) {
    let rollbackCause;
    try {
      activeAdapter.rollback(root, install);
    } catch (error) {
      rollbackCause = error;
    }
    throw stateError(cause, rollbackCause === undefined
      ? { operation: 'acquire' }
      : { operation: 'acquire', rollbackCause });
  }
}
