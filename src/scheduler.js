function requireFunction(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
}

export class FrameQueue {
  #requestFrame;

  #cancelFrame;

  #generationFor;

  #pending = new Map();

  #scheduled = null;

  #alive = true;

  constructor(callbacks) {
    if (callbacks === null || typeof callbacks !== 'object') {
      throw new TypeError('FrameQueue callbacks must be an object');
    }

    const { requestFrame, cancelFrame, generationFor } = callbacks;
    requireFunction('requestFrame', requestFrame);
    requireFunction('cancelFrame', cancelFrame);
    requireFunction('generationFor', generationFor);

    this.#requestFrame = requestFrame;
    this.#cancelFrame = cancelFrame;
    this.#generationFor = generationFor;
  }

  enqueue(candidate) {
    if (!this.#alive) {
      throw new Error('Cannot enqueue into a destroyed FrameQueue');
    }
    if (candidate === null || typeof candidate !== 'object') {
      throw new TypeError('FrameQueue job must be an object');
    }

    const {
      key,
      generation,
      read,
      write,
      onError,
    } = candidate;
    requireFunction('read', read);
    requireFunction('write', write);
    if (onError !== undefined) {
      requireFunction('onError', onError);
    }

    this.#pending.delete(key);
    this.#pending.set(key, {
      key,
      generation,
      read,
      write,
      onError,
    });
    this.#schedule();
  }

  cancel(key) {
    if (!this.#pending.delete(key) || this.#pending.size !== 0 || this.#scheduled === null) {
      return;
    }

    const scheduled = this.#scheduled;
    this.#scheduled = null;
    this.#cancelFrame(scheduled.id);
  }

  destroy() {
    if (!this.#alive) {
      return;
    }

    this.#alive = false;
    this.#pending.clear();
    if (this.#scheduled !== null) {
      this.#cancelFrame(this.#scheduled.id);
      this.#scheduled = null;
    }
  }

  #schedule() {
    if (this.#scheduled !== null) {
      return;
    }

    const token = { id: undefined };
    this.#scheduled = token;
    try {
      token.id = this.#requestFrame(() => this.#flush(token));
    } catch (error) {
      if (this.#scheduled === token) {
        this.#scheduled = null;
      }
      throw error;
    }
  }

  #flush(token) {
    if (!this.#alive || this.#scheduled !== token) {
      return;
    }

    this.#scheduled = null;
    const jobs = this.#pending;
    this.#pending = new Map();
    const reads = [];
    const readErrors = [];

    for (const job of jobs.values()) {
      if (!this.#alive) {
        return;
      }

      let currentGeneration;
      try {
        currentGeneration = this.#generationFor(job.key);
      } catch (error) {
        readErrors.push({ job, error });
        continue;
      }
      if (currentGeneration !== job.generation) {
        continue;
      }

      try {
        reads.push({ job, value: job.read() });
      } catch (error) {
        readErrors.push({ job, error });
      }
    }

    for (const entry of readErrors) {
      if (!this.#alive) {
        return;
      }

      let currentGeneration;
      try {
        currentGeneration = this.#generationFor(entry.job.key);
      } catch (error) {
        this.#report(entry.job, error);
        continue;
      }
      if (currentGeneration !== entry.job.generation) {
        continue;
      }

      this.#report(entry.job, entry.error);
    }

    for (const entry of reads) {
      if (!this.#alive) {
        return;
      }

      let currentGeneration;
      try {
        currentGeneration = this.#generationFor(entry.job.key);
      } catch (error) {
        this.#report(entry.job, error);
        continue;
      }
      if (currentGeneration !== entry.job.generation) {
        continue;
      }

      try {
        entry.job.write(entry.value);
      } catch (error) {
        this.#report(entry.job, error);
      }
    }
  }

  #report(job, error) {
    if (job.onError === undefined) {
      return;
    }

    try {
      job.onError(error);
    } catch {
      // Error reporting is isolated from the rest of the frame.
    }
  }
}

const resourcesByDocument = new WeakMap();

function createOverlay(doc) {
  const overlay = doc.createElement('div');
  overlay.className = 'hana-overlay';
  overlay.setAttribute('data-hana-overlay', '');

  const svgLayer = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgLayer.setAttribute('class', 'hana-svg-layer');
  svgLayer.setAttribute('data-hana-svg-layer', '');
  svgLayer.setAttribute('aria-hidden', 'true');

  const noteLayer = doc.createElement('div');
  noteLayer.className = 'hana-note-layer';
  noteLayer.setAttribute('data-hana-note-layer', '');

  overlay.append(svgLayer, noteLayer);
  (doc.body ?? doc.documentElement).append(overlay);
  return { noteLayer, overlay, svgLayer };
}

class SharedDocumentResources {
  #alive = true;

  #doc;

  #frameQueue;

  #controllers = new Map();

  #intersections = new Map();

  #layouts = new Map();

  #mutationObserver;

  #resizeObserver;

  #resizeTargets = new Map();

  #scrollTargets = new Map();

  #window;

  #windowResize = () => {
    for (const id of this.#layouts.keys()) {
      this.#signal(id);
    }
  };

  constructor(doc) {
    this.#doc = doc;
    this.#window = doc.defaultView;
    const { noteLayer, overlay, svgLayer } = createOverlay(doc);
    this.overlay = overlay;
    this.svgLayer = svgLayer;
    this.noteLayer = noteLayer;

    const requestFrame = this.#window.requestAnimationFrame.bind(this.#window);
    const cancelFrame = this.#window.cancelAnimationFrame.bind(this.#window);
    this.#frameQueue = new FrameQueue({
      requestFrame,
      cancelFrame,
      generationFor: (key) => this.#controllers.get(key.id)?.token,
    });

    const ResizeObserverConstructor = this.#window.ResizeObserver;
    this.#resizeObserver = typeof ResizeObserverConstructor === 'function'
      ? new ResizeObserverConstructor((entries) => {
        if (!this.#alive) {
          return;
        }

        const ids = new Set();
        for (const entry of entries) {
          for (const id of this.#resizeTargets.get(entry.target) ?? []) {
            ids.add(id);
          }
        }
        for (const id of ids) {
          this.#signal(id);
        }
      })
      : null;

    const MutationObserverConstructor = this.#window.MutationObserver;
    this.#mutationObserver = typeof MutationObserverConstructor === 'function'
      ? new MutationObserverConstructor((records) => {
        if (!this.#alive) {
          return;
        }

        const ids = new Set();
        for (const record of records) {
          if (record.target === this.overlay || this.overlay.contains(record.target)) {
            continue;
          }
          for (const binding of this.#layouts.values()) {
            if (binding.mutationScope === this.#doc
              || record.target === binding.mutationScope
              || binding.mutationScope.contains(record.target)) {
              ids.add(binding.id);
            }
          }
        }
        for (const id of ids) {
          this.#signal(id);
        }
      })
      : null;
    this.#mutationObserver?.observe(doc, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });

    this.#window.addEventListener('resize', this.#windowResize);
  }

  registerController(id) {
    this.#requireAlive();
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('controller id must be a non-empty string');
    }
    if (this.#controllers.has(id)) {
      throw new Error(`controller already registered: ${id}`);
    }

    this.#controllers.set(id, { generation: 0, queueKeys: new Map(), token: {} });
    return 0;
  }

  bumpGeneration(id) {
    const controller = this.#requireController(id);
    controller.generation += 1;
    controller.token = {};
    this.#cancelControllerJobs(controller);
    return controller.generation;
  }

  generationFor(id) {
    return this.#requireController(id).generation;
  }

  enqueue(options) {
    this.#requireAlive();
    if (options === null || typeof options !== 'object') {
      throw new TypeError('queued controller work must be an object');
    }
    const {
      id,
      generation,
      channel = 'default',
      read,
      write,
      onError,
    } = options;
    const controller = this.#requireController(id);
    if (generation !== controller.generation) {
      throw new Error(`stale controller generation: ${id}`);
    }
    if (typeof channel !== 'string' || channel.length === 0) {
      throw new TypeError('queue channel must be a non-empty string');
    }
    requireFunction('read', read);
    requireFunction('write', write);
    if (onError !== undefined) {
      requireFunction('onError', onError);
    }
    this.#frameQueue.enqueue({
      key: this.#queueKey(controller, id, `public:${channel}`),
      generation: controller.token,
      read,
      write,
      onError,
    });
  }

  observeLayout(options) {
    this.#requireAlive();
    if (options === null || typeof options !== 'object') {
      throw new TypeError('layout observation must be an object');
    }
    if (this.#layouts.has(options.id)) {
      throw new Error(`controller already observes layout: ${options.id}`);
    }
    return this.#bindLayout(options.id, options, false);
  }

  rebindLayout(id, options) {
    this.#requireAlive();
    if (options === null || typeof options !== 'object') {
      throw new TypeError('layout observation must be an object');
    }
    return this.#bindLayout(id, { ...options, id }, true);
  }

  observeIntersection(options) {
    this.#requireAlive();
    if (options === null || typeof options !== 'object') {
      throw new TypeError('intersection observation must be an object');
    }
    const {
      id,
      target,
      threshold,
      onEnter,
      onExit,
      onUnavailable,
    } = options;
    this.#requireController(id);
    if (!this.#isElement(target)) {
      throw new TypeError('intersection target must be an Element');
    }
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new TypeError('intersection threshold must be a number from 0 to 1');
    }
    requireFunction('onEnter', onEnter);
    requireFunction('onExit', onExit);
    requireFunction('onUnavailable', onUnavailable);

    const IntersectionObserverConstructor = this.#window.IntersectionObserver;
    if (typeof IntersectionObserverConstructor !== 'function') {
      onUnavailable();
      return () => {};
    }

    const registration = {
      active: true,
      id,
      observer: null,
      target,
    };
    registration.observer = new IntersectionObserverConstructor((entries) => {
      if (!this.#alive || !registration.active || !this.#controllers.has(id)) {
        return;
      }
      for (const entry of entries) {
        if (!this.#alive || !registration.active || !this.#controllers.has(id)) {
          return;
        }
        if (entry.target !== target) {
          continue;
        }
        if (entry.isIntersecting && entry.intersectionRatio >= threshold) {
          onEnter(entry);
        } else {
          onExit(entry);
        }
      }
    }, { threshold });
    registration.observer.observe(target);

    let registrations = this.#intersections.get(id);
    if (registrations === undefined) {
      registrations = new Set();
      this.#intersections.set(id, registrations);
    }
    registrations.add(registration);

    return () => this.#removeIntersection(registration);
  }

  releaseController(id) {
    const controller = this.#controllers.get(id);
    if (controller === undefined) {
      return;
    }

    let failure = null;
    const cleanup = (operation) => {
      try { operation(); } catch (error) { failure ??= error; }
    };
    cleanup(() => this.#removeLayout(id));
    for (const registration of [...this.#intersections.get(id) ?? []]) {
      cleanup(() => this.#removeIntersection(registration));
    }
    cleanup(() => this.#cancelControllerJobs(controller));
    this.#controllers.delete(id);
    if (failure !== null) throw failure;
  }

  #removeIntersection(registration) {
    if (!registration.active) {
      return;
    }
    registration.active = false;
    let failure = null;
    try {
      registration.observer.unobserve(registration.target);
    } catch (error) {
      failure = error;
    }
    try {
      registration.observer.disconnect();
    } catch (error) {
      failure ??= error;
    }
    const registrations = this.#intersections.get(registration.id);
    registrations?.delete(registration);
    if (registrations?.size === 0) {
      this.#intersections.delete(registration.id);
    }
    if (failure !== null) throw failure;
  }

  #bindLayout(id, options, renewToken) {
    const controller = this.#requireController(id);
    const {
      generation,
      record,
      note = null,
      read,
      write,
      onError,
    } = options;
    if (generation !== controller.generation) {
      throw new Error(`stale controller generation: ${id}`);
    }
    if (record === null || typeof record !== 'object') {
      throw new TypeError('record must be an object');
    }
    requireFunction('read', read);
    requireFunction('write', write);
    if (onError !== undefined) {
      requireFunction('onError', onError);
    }
    if (note !== null && !this.#isElement(note)) {
      throw new TypeError('note must be an Element or null');
    }

    const prior = this.#layouts.get(id);
    const token = renewToken ? {} : controller.token;
    const binding = {
      generation,
      id,
      mutationScope: this.#discoverMutationScope(record),
      note,
      onError,
      read,
      record,
      resizeTargets: this.#discoverResizeTargets(record, note),
      scrollTargets: this.#discoverScrollTargets(record),
      token,
      write,
    };
    if (renewToken) {
      controller.token = token;
      this.#cancelControllerJobs(controller);
    }
    this.#layouts.set(id, binding);
    this.#diffScrollTargets(id, prior?.scrollTargets ?? new Set(), binding.scrollTargets);
    this.#diffResizeTargets(id, prior?.resizeTargets ?? new Set(), binding.resizeTargets);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) {
        return;
      }
      unsubscribed = true;
      if (this.#layouts.get(id)?.token === binding.token) {
        this.#removeLayout(id);
      }
    };
  }

  #discoverScrollTargets(record) {
    const targets = new Set();
    let current = this.#isElement(record.ownerElement)
      ? record.ownerElement
      : this.#isElement(record.element) ? record.element : null;
    const scrollingElement = this.#doc.scrollingElement;

    while (current !== null) {
      const style = this.#window.getComputedStyle(current);
      if (/^(auto|scroll|overlay)$/u.test(style.overflowX)
        || /^(auto|scroll|overlay)$/u.test(style.overflowY)) {
        targets.add(current);
      }
      if (current === scrollingElement) {
        break;
      }
      current = current.parentElement;
    }
    targets.add(this.#window);
    return targets;
  }

  #discoverResizeTargets(record, note) {
    const targets = new Set();
    if (this.#isElement(record.element)) {
      targets.add(record.element);
    } else if (this.#isElement(record.ownerElement)) {
      targets.add(record.ownerElement);
    }
    if (this.#isElement(note)) {
      targets.add(note);
    }
    return targets;
  }

  #discoverMutationScope(record) {
    if (record.kind === 'selector') {
      return this.#doc;
    }
    if (record.kind === 'locator') {
      return this.#isElement(record.source?.within) ? record.source.within : this.#doc;
    }
    if (record.kind === 'element' || record.kind === 'range') {
      return this.#isElement(record.ownerElement?.parentElement)
        ? record.ownerElement.parentElement
        : this.#doc;
    }
    return this.#doc;
  }

  #diffScrollTargets(id, previous, next) {
    for (const target of previous) {
      if (next.has(target)) {
        continue;
      }
      const registration = this.#scrollTargets.get(target);
      registration?.ids.delete(id);
      if (registration?.ids.size === 0) {
        target.removeEventListener('scroll', registration.listener, { passive: true });
        this.#scrollTargets.delete(target);
      }
    }

    for (const target of next) {
      if (previous.has(target)) {
        continue;
      }
      let registration = this.#scrollTargets.get(target);
      if (registration === undefined) {
        registration = {
          ids: new Set(),
          listener: () => {
            for (const controllerId of registration.ids) {
              this.#signal(controllerId);
            }
          },
        };
        this.#scrollTargets.set(target, registration);
        target.addEventListener('scroll', registration.listener, { passive: true });
      }
      registration.ids.add(id);
    }
  }

  #diffResizeTargets(id, previous, next) {
    for (const target of previous) {
      if (next.has(target)) {
        continue;
      }
      const ids = this.#resizeTargets.get(target);
      ids?.delete(id);
      if (ids?.size === 0) {
        this.#resizeTargets.delete(target);
        this.#resizeObserver?.unobserve(target);
      }
    }

    for (const target of next) {
      if (previous.has(target)) {
        continue;
      }
      let ids = this.#resizeTargets.get(target);
      if (ids === undefined) {
        ids = new Set();
        this.#resizeTargets.set(target, ids);
        this.#resizeObserver?.observe(target);
      }
      ids.add(id);
    }
  }

  #removeLayout(id) {
    const binding = this.#layouts.get(id);
    if (binding === undefined) {
      return;
    }
    this.#layouts.delete(id);
    this.#diffScrollTargets(id, binding.scrollTargets, new Set());
    this.#diffResizeTargets(id, binding.resizeTargets, new Set());
    const layoutKey = this.#controllers.get(id)?.queueKeys.get('internal:layout');
    if (layoutKey !== undefined) this.#frameQueue.cancel(layoutKey);
  }

  #signal(id) {
    if (!this.#alive) {
      return;
    }
    const binding = this.#layouts.get(id);
    const controller = this.#controllers.get(id);
    if (binding === undefined
      || controller === undefined
      || controller.generation !== binding.generation
      || controller.token !== binding.token) {
      return;
    }
    this.#frameQueue.enqueue({
      key: this.#queueKey(controller, id, 'internal:layout'),
      generation: binding.token,
      read: binding.read,
      write: binding.write,
      onError: binding.onError,
    });
  }

  #queueKey(controller, id, channel) {
    let key = controller.queueKeys.get(channel);
    if (key === undefined) {
      key = { channel, id };
      controller.queueKeys.set(channel, key);
    }
    return key;
  }

  #cancelControllerJobs(controller) {
    for (const key of controller.queueKeys.values()) {
      this.#frameQueue.cancel(key);
    }
  }

  #isElement(value) {
    return value !== null
      && typeof value === 'object'
      && value.nodeType === 1
      && value.ownerDocument === this.#doc;
  }

  #requireAlive() {
    if (!this.#alive) {
      throw new Error('document resources have been released');
    }
  }

  #requireController(id) {
    this.#requireAlive();
    const controller = this.#controllers.get(id);
    if (controller === undefined) {
      throw new Error(`controller is not registered: ${String(id)}`);
    }
    return controller;
  }

  static destroy(shared) {
    shared.#destroy();
  }

  #destroy() {
    if (!this.#alive) {
      return;
    }

    this.#alive = false;
    let failure = null;
    const cleanup = (operation) => {
      try { operation(); } catch (error) { failure ??= error; }
    };
    for (const id of [...this.#layouts.keys()]) {
      cleanup(() => this.#removeLayout(id));
    }
    for (const registrations of [...this.#intersections.values()]) {
      for (const registration of [...registrations]) {
        cleanup(() => this.#removeIntersection(registration));
      }
    }
    this.#layouts.clear();
    this.#controllers.clear();
    this.#intersections.clear();
    this.#resizeTargets.clear();
    this.#scrollTargets.clear();
    cleanup(() => this.#resizeObserver?.disconnect());
    cleanup(() => this.#mutationObserver?.disconnect());
    cleanup(() => this.#window.removeEventListener('resize', this.#windowResize));
    cleanup(() => this.#frameQueue.destroy());
    cleanup(() => this.overlay.remove());
    if (failure !== null) throw failure;
  }
}

export function acquireDocumentResources(doc) {
  if (doc === null || typeof doc !== 'object' || doc.nodeType !== 9 || doc.defaultView === null) {
    throw new TypeError('doc must be a Document with a browsing context');
  }

  let entry = resourcesByDocument.get(doc);
  if (entry === undefined) {
    entry = {
      refs: 0,
      shared: new SharedDocumentResources(doc),
    };
    resourcesByDocument.set(doc, entry);
  }
  entry.refs += 1;

  let released = false;
  return {
    shared: entry.shared,
    release() {
      if (released) {
        return;
      }
      released = true;
      entry.refs -= 1;
      if (entry.refs !== 0) {
        return;
      }
      try {
        SharedDocumentResources.destroy(entry.shared);
      } finally {
        resourcesByDocument.delete(doc);
      }
    },
  };
}
