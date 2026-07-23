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
const INSTALL_DETAILS = new WeakMap();

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
    return Object.freeze({ mode: 'auto', nonce: undefined });
  }

  const { keys, descriptors } = reflectStyles(value);
  const mode = descriptors.mode === undefined
    ? 'auto'
    : descriptors.mode.value;
  if (mode === 'auto') {
    if (!exactKeys(keys, ['mode', 'nonce'])) invalid('configuration', value);
    const nonce = descriptors.nonce?.value;
    if (nonce !== undefined && typeof nonce !== 'string') {
      invalid('nonce', nonce);
    }
    return Object.freeze({ mode: 'auto', nonce });
  }

  if (mode === 'sheet') {
    if (!exactKeys(keys, ['mode', 'sheet'])
      || descriptors.sheet === undefined) invalid('configuration', value);
    const sheet = descriptors.sheet.value;
    if (sheet === null || typeof sheet !== 'object' || Array.isArray(sheet)) {
      invalid('sheet', sheet);
    }
    return Object.freeze({ mode: 'sheet', sheet });
  }

  if (mode === 'preinstalled') {
    if (keys.length !== 1 || keys[0] !== 'mode') invalid('configuration', value);
    return Object.freeze({ mode: 'preinstalled' });
  }

  invalid('mode', mode);
}

function compatible(current, incoming) {
  if (current.mode !== incoming.mode) return false;
  if (current.mode === 'auto') return current.nonce === incoming.nonce;
  if (current.mode === 'sheet') return current.sheet === incoming.sheet;
  return true;
}

function sheetRulesGetter(Sheet) {
  let prototype = Sheet.prototype;
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'cssRules');
    if (typeof descriptor?.get === 'function') return descriptor.get;
    prototype = Object.getPrototypeOf(prototype);
  }
  return null;
}

function assertBrowserSheet(root, config) {
  if (config.mode !== 'sheet') return;
  const Sheet = root?.ownerDocument?.defaultView?.CSSStyleSheet;
  try {
    if (typeof Sheet === 'function' && !(config.sheet instanceof Sheet)) {
      throw new TypeError('sheet is not a CSSStyleSheet from the ShadowRoot realm');
    }
    if (typeof Sheet === 'function') {
      const getRules = sheetRulesGetter(Sheet);
      if (getRules === null) {
        throw new TypeError('CSSStyleSheet cssRules getter is unavailable');
      }
      Reflect.apply(getRules, config.sheet, []);
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
  const index = current.indexOf(sheet);
  if (index === -1) return;
  root.adoptedStyleSheets = [
    ...current.slice(0, index),
    ...current.slice(index + 1),
  ];
}

function allSides(style, prefix, suffix, expected) {
  return ['Top', 'Right', 'Bottom', 'Left']
    .every((side) => style[`${prefix}${side}${suffix}`] === expected);
}

function zeroClip(value) {
  const normalized = value
    .replaceAll(',', ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return /^rect\((?:0|0px)(?: (?:0|0px)){3}\)$/u.test(normalized);
}

function halfInset(value) {
  const match = /^inset\(([^)]+)\)$/u.exec(value.trim());
  if (match === null) return false;
  const values = match[1].trim().split(/\s+/u);
  return values.length >= 1
    && values.length <= 4
    && values.every((entry) => entry === '50%');
}

function mirrorSignature(style) {
  return style.position === 'absolute'
    && style.width === '1px'
    && style.height === '1px'
    && allSides(style, 'padding', '', '0px')
    && allSides(style, 'margin', '', '-1px')
    && style.overflowX === 'hidden'
    && style.overflowY === 'hidden'
    && zeroClip(style.clip)
    && halfInset(style.clipPath)
    && style.whiteSpace === 'nowrap'
    && allSides(style, 'border', 'Width', '0px');
}

function verifyRootMarker(root) {
  const document = root.ownerDocument;
  const wrapper = document.createElement('span');
  const sentinel = document.createElement('span');
  const probe = document.createElement('span');
  wrapper.setAttribute('data-hana-shadow-probe', '');
  wrapper.style.setProperty('--hana-shadow-style', '__hana-shadow-unset__');
  sentinel.setAttribute('data-hana-shadow-sentinel', '');
  probe.className = 'hana-shadow-mirror';
  probe.setAttribute('aria-hidden', 'true');
  wrapper.append(sentinel, probe);
  try {
    root.append(wrapper);
    const view = realmFor(root);
    const probeStyle = view.getComputedStyle(probe);
    const sentinelStyle = view.getComputedStyle(sentinel);
    const marker = probeStyle
      .getPropertyValue('--hana-shadow-style')
      .trim();
    if (marker !== '1'
      || !mirrorSignature(probeStyle)
      || mirrorSignature(sentinelStyle)) {
      throw new TypeError('Hanamaru Shadow style marker is missing');
    }
  } finally {
    wrapper.remove();
  }
}

function withIsolatedRoot(root, verify) {
  const document = root.ownerDocument;
  const parent = document.body ?? document.documentElement;
  if (parent === null) {
    throw new TypeError('Shadow style verification requires a connected document');
  }
  const host = document.createElement('div');
  host.setAttribute('data-hana-shadow-probe-host', '');
  let isolatedRoot;
  try {
    parent.append(host);
    isolatedRoot = host.attachShadow({ mode: 'open' });
    return verify(isolatedRoot);
  } finally {
    if (isolatedRoot !== undefined) {
      isolatedRoot.adoptedStyleSheets = [];
      isolatedRoot.replaceChildren();
    }
    host.remove();
  }
}

function verifyIsolatedSheet(root, sheet) {
  return withIsolatedRoot(root, (isolatedRoot) => {
    isolatedRoot.adoptedStyleSheets = [sheet];
    verifyRootMarker(isolatedRoot);
  });
}

function verifyIsolatedStyle(root, detail) {
  return withIsolatedRoot(root, (isolatedRoot) => {
    const style = isolatedRoot.ownerDocument.createElement('style');
    style.setAttribute('data-hana-shadow-style', '');
    style.textContent = detail.css;
    if (detail.nonce !== undefined) style.setAttribute('nonce', detail.nonce);
    isolatedRoot.append(style);
    verifyRootMarker(isolatedRoot);
  });
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
        const install = {
          owned: true,
          release() {
            if (released) return;
            released = true;
            removeAdoption(root, sheet);
          },
        };
        INSTALL_DETAILS.set(install, { kind: 'sheet', sheet });
        return install;
      }

      const style = root.ownerDocument.createElement('style');
      style.setAttribute('data-hana-shadow-style', '');
      style.textContent = css;
      if (config.nonce !== undefined) style.setAttribute('nonce', config.nonce);
      root.append(style);
      let released = false;
      const install = {
        owned: true,
        release() {
          if (released) return;
          released = true;
          style.remove();
        },
      };
      INSTALL_DETAILS.set(install, {
        kind: 'style',
        css,
        nonce: config.nonce,
      });
      return install;
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

    verifyMarker(root, config, install) {
      if (config.mode === 'sheet') {
        verifyIsolatedSheet(root, config.sheet);
        return;
      }
      if (config.mode === 'auto') {
        const detail = INSTALL_DETAILS.get(install);
        if (detail?.kind === 'sheet') {
          verifyIsolatedSheet(root, detail.sheet);
          return;
        }
        if (detail?.kind === 'style') {
          verifyIsolatedStyle(root, detail);
          return;
        }
        throw new TypeError('Shadow style installation details are missing');
      }
      verifyRootMarker(root);
    },

    rollback(root, install) {
      install?.release();
    },
  };
}

function validateInstall(raw, mode) {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError(`${mode} style installation returned an invalid record`);
  }
  const owned = Object.getOwnPropertyDescriptor(raw, 'owned');
  const release = Object.getOwnPropertyDescriptor(raw, 'release');
  if (owned === undefined
    || release === undefined
    || !Object.hasOwn(owned, 'value')
    || !Object.hasOwn(release, 'value')
    || typeof owned.value !== 'boolean'
    || typeof release.value !== 'function') {
    throw new TypeError(`${mode} style installation returned an invalid record`);
  }
  const releaseMethod = release.value;
  return Object.freeze({
    owned: owned.value,
    release() {
      return Reflect.apply(releaseMethod, raw, []);
    },
  });
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
      record.phase = 'releasing';
      let cause;
      try {
        record.install.release();
      } catch (error) {
        cause = error;
      } finally {
        record.phase = 'released';
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
    if (existing.phase !== 'active') {
      throw stateError(
        new TypeError('Shadow root styles are being released'),
        { operation: 'acquire', phase: existing.phase },
      );
    }
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
  let rawInstall = null;
  let install = null;
  try {
    if (config.mode === 'auto') {
      rawInstall = activeAdapter.installAuto(root, config, SHADOW_CSS);
      install = validateInstall(rawInstall, config.mode);
    } else if (config.mode === 'sheet') {
      rawInstall = activeAdapter.adoptSheet(root, config, SHADOW_CSS);
      install = validateInstall(rawInstall, config.mode);
    } else {
      rawInstall = {
        owned: false,
        release() {},
      };
      install = validateInstall(rawInstall, config.mode);
    }
    activeAdapter.verifyMarker(root, config, rawInstall);
    const record = {
      config,
      count: 1,
      install,
      phase: 'active',
    };
    claimShadowRootSlot(root, 'styles', record);
    return leaseFor(root, record);
  } catch (cause) {
    let rollbackCause;
    try {
      activeAdapter.rollback(root, rawInstall);
    } catch (error) {
      rollbackCause = error;
    }
    throw stateError(cause, rollbackCause === undefined
      ? { operation: 'acquire' }
      : { operation: 'acquire', rollbackCause });
  }
}
