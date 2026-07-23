import { runtimeState } from './runtime-state.js';

function requireFunction(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
}

function attachRollbackCause(cause, rollbackCause) {
  if (cause === null
    || (typeof cause !== 'object' && typeof cause !== 'function')) {
    return;
  }
  try {
    if (!Object.hasOwn(cause, 'rollbackCause')) {
      Object.defineProperty(cause, 'rollbackCause', {
        configurable: true,
        value: rollbackCause,
      });
    }
  } catch {
    // Preserve the original setup failure when it cannot carry metadata.
  }
}

function rollbackOperations(operations, cause) {
  const rethrow = arguments.length > 1;
  let failure = null;
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    try {
      operations[index]();
    } catch (error) {
      failure ??= error;
    }
  }
  if (rethrow) {
    if (failure !== null) attachRollbackCause(cause, failure);
    throw cause;
  }
  if (failure !== null) throw failure;
}

function runRegistrationTransaction(operations) {
  const rollbacks = [];
  try {
    for (const operation of operations) rollbacks.push(operation());
  } catch (cause) {
    rollbackOperations(rollbacks, cause);
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    rollbackOperations(rollbacks);
  };
}

function changeNativeRegistration(apply, rollback) {
  try {
    apply();
  } catch (cause) {
    try {
      rollback();
    } catch (error) {
      attachRollbackCause(cause, error);
    }
    throw cause;
  }
}

export class FrameQueue {
  #requestFrame;

  #cancelFrame;

  #generationFor;

  #beforeFlush;

  #afterFlush;

  #pending = new Map();

  #scheduled = null;

  #alive = true;

  constructor(callbacks) {
    if (callbacks === null || typeof callbacks !== 'object') {
      throw new TypeError('FrameQueue callbacks must be an object');
    }

    const {
      requestFrame,
      cancelFrame,
      generationFor,
      beforeFlush,
      afterFlush,
    } = callbacks;
    requireFunction('requestFrame', requestFrame);
    requireFunction('cancelFrame', cancelFrame);
    requireFunction('generationFor', generationFor);
    if (beforeFlush !== undefined) requireFunction('beforeFlush', beforeFlush);
    if (afterFlush !== undefined) requireFunction('afterFlush', afterFlush);

    this.#requestFrame = requestFrame;
    this.#cancelFrame = cancelFrame;
    this.#generationFor = generationFor;
    this.#beforeFlush = beforeFlush;
    this.#afterFlush = afterFlush;
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
      prepare,
      apply,
      read,
      write,
      onError,
    } = candidate;
    if (prepare !== undefined || apply !== undefined) {
      requireFunction('prepare', prepare);
      requireFunction('apply', apply);
    }
    requireFunction('read', read);
    requireFunction('write', write);
    if (onError !== undefined) {
      requireFunction('onError', onError);
    }

    this.#pending.delete(key);
    this.#pending.set(key, {
      key,
      generation,
      prepare,
      apply,
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
    try {
      this.#beforeFlush?.();
      const blockedJobs = new Set();
      const preparations = [];
      const prepareErrors = [];
      const reads = [];
      const readErrors = [];

      for (const job of jobs.values()) {
        if (!this.#alive) {
          return;
        }
        if (job.prepare === undefined) continue;

        let currentGeneration;
        try {
          currentGeneration = this.#generationFor(job.key);
        } catch (error) {
          prepareErrors.push({ job, error });
          blockedJobs.add(job);
          continue;
        }
        if (currentGeneration !== job.generation) {
          blockedJobs.add(job);
          continue;
        }

        try {
          preparations.push({ job, value: job.prepare() });
        } catch (error) {
          prepareErrors.push({ job, error });
          blockedJobs.add(job);
        }
      }

      for (const entry of prepareErrors) {
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
        if (currentGeneration !== entry.job.generation) continue;
        this.#report(entry.job, entry.error);
      }

      for (const entry of preparations) {
        if (!this.#alive) {
          return;
        }

        let currentGeneration;
        try {
          currentGeneration = this.#generationFor(entry.job.key);
        } catch (error) {
          blockedJobs.add(entry.job);
          this.#report(entry.job, error);
          continue;
        }
        if (currentGeneration !== entry.job.generation) {
          blockedJobs.add(entry.job);
          continue;
        }

        try {
          entry.job.apply(entry.value);
        } catch (error) {
          blockedJobs.add(entry.job);
          this.#report(entry.job, error);
        }
      }

      for (const job of jobs.values()) {
        if (!this.#alive) {
          return;
        }
        if (blockedJobs.has(job)) continue;

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
    } finally {
      this.#afterFlush?.();
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

const resourcesByDocument = runtimeState.documents;
const resourceInternals = new WeakMap();
const INSTALLING_PORTAL = Symbol('installing default Document portal');

function createOverlay(doc) {
  let overlay;
  try {
    overlay = doc.createElement('div');
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
  } catch (error) {
    try { overlay?.remove(); } catch {}
    throw error;
  }
}

class SharedDocumentResources {
  #alive = true;

  #doc;

  #frameQueue;

  #controllers = new Map();

  #intersections = new Map();

  #layouts = new Map();

  #notePlacementReservations = null;

  #mutationObserver;

  #resizeObserver;

  #resizeTargets = new Map();

  #scrollTargets = new Map();

  #window;

  #visualViewport;

  #windowResizeInstalled = false;

  #viewportResizeInstalled = false;

  #viewportScrollInstalled = false;

  #windowResize = () => {
    for (const id of this.#layouts.keys()) {
      this.#signal(id);
    }
  };

  constructor(doc, initialPortal = null) {
    this.#doc = doc;
    try {
      resourceInternals.set(this, {
        defaultPortal: initialPortal,
        ignoredPortals: new Set(
          initialPortal === null ? [] : [initialPortal.overlay],
        ),
        nextId: 0,
      });
      if (initialPortal !== null) {
        this.overlay = initialPortal.overlay;
        this.svgLayer = initialPortal.svgLayer;
        this.noteLayer = initialPortal.noteLayer;
      }
      this.#window = doc.defaultView;
      this.#visualViewport = this.#window.visualViewport;

      const requestFrame = this.#window.requestAnimationFrame.bind(this.#window);
      const cancelFrame = this.#window.cancelAnimationFrame.bind(this.#window);
      this.#frameQueue = new FrameQueue({
        requestFrame,
        cancelFrame,
        generationFor: (key) => this.#controllers.get(key.id)?.token,
        beforeFlush: () => {
          this.#notePlacementReservations = new Map();
        },
        afterFlush: () => {
          this.#notePlacementReservations = null;
        },
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
          this.#signalMutations(records, this.#doc);
        })
        : null;
      this.#mutationObserver?.observe(doc, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden'],
      });

      this.#windowResizeInstalled = true;
      this.#window.addEventListener('resize', this.#windowResize);
      if (this.#visualViewport !== null
        && this.#visualViewport !== undefined) {
        this.#viewportResizeInstalled = true;
        this.#visualViewport.addEventListener(
          'resize',
          this.#windowResize,
          { passive: true },
        );
        this.#viewportScrollInstalled = true;
        this.#visualViewport.addEventListener(
          'scroll',
          this.#windowResize,
          { passive: true },
        );
      }
    } catch (cause) {
      let rollbackCause;
      try {
        this.#destroy();
      } catch (error) {
        rollbackCause = error;
      }
      if (rollbackCause !== undefined) {
        attachRollbackCause(cause, rollbackCause);
      }
      throw cause;
    }
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

  reserveNotePlacement(id, input) {
    const controller = this.#controllers.get(id);
    if (this.#notePlacementReservations === null || controller === undefined) {
      return false;
    }
    this.#notePlacementReservations.set(id, {
      rect: {
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        top: input.top,
        right: input.right,
        bottom: input.bottom,
        left: input.left,
      },
      token: controller.token,
    });
    return true;
  }

  notePlacementReservations(id) {
    if (this.#notePlacementReservations === null) {
      return [];
    }
    const reservations = [];
    for (const [ownerId, reservation] of this.#notePlacementReservations) {
      if (ownerId === id || this.#controllers.get(ownerId)?.token !== reservation.token) {
        continue;
      }
      reservations.push(reservation.rect);
    }
    return reservations;
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
      prepare,
      apply,
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
    if (prepare !== undefined || apply !== undefined) {
      requireFunction('prepare', prepare);
      requireFunction('apply', apply);
    }
    requireFunction('read', read);
    requireFunction('write', write);
    if (onError !== undefined) {
      requireFunction('onError', onError);
    }
    this.#frameQueue.enqueue({
      key: this.#queueKey(controller, id, `public:${channel}`),
      generation: controller.token,
      prepare,
      apply,
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
      prepare,
      apply,
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
    if (prepare !== undefined || apply !== undefined) {
      requireFunction('prepare', prepare);
      requireFunction('apply', apply);
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
    const mutationRoot = options.mutationRoot ?? this.#doc;
    const mutationHost = options.mutationHost ?? null;
    const readLayoutDependencies = typeof options.layoutDependencies === 'function'
      ? options.layoutDependencies
      : null;
    const dependencyChange = this.#prepareLayoutDependencies(
      readLayoutDependencies ?? options.layoutDependencies,
    );
    let binding;
    let rollbackTargets = null;
    try {
      const layoutDependencies = dependencyChange.value;
      binding = {
        generation,
        id,
        layoutDependencies,
        mutationRoot,
        mutationHost,
        mutationScope: this.#discoverMutationScope(record, mutationRoot),
        note,
        onError,
        prepare,
        apply,
        read,
        readLayoutDependencies,
        record,
        resizeTargets: this.#discoverResizeTargets(record, note, layoutDependencies),
        scrollTargets: this.#discoverScrollTargets(record, layoutDependencies),
        token,
        write,
      };
      rollbackTargets = this.#replaceDependencyTargets(
        id,
        prior?.scrollTargets ?? new Set(),
        binding.scrollTargets,
        prior?.resizeTargets ?? new Set(),
        binding.resizeTargets,
      );
      dependencyChange.commit();
    } catch (cause) {
      rollbackOperations([
        dependencyChange.rollback,
        ...(rollbackTargets === null ? [] : [rollbackTargets]),
      ], cause);
    }
    if (renewToken) {
      controller.token = token;
      this.#cancelControllerJobs(controller);
    }
    this.#layouts.set(id, binding);

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

  #prepareLayoutDependencies(source) {
    const candidate = typeof source === 'function' ? source() : source;
    const transactional = candidate !== null
      && typeof candidate === 'object'
      && typeof candidate.commit === 'function'
      && typeof candidate.rollback === 'function';
    const commit = transactional ? () => candidate.commit() : () => {};
    const rollback = transactional ? () => candidate.rollback() : () => {};
    try {
      return {
        commit,
        rollback,
        value: this.#discoverLayoutDependencies(
          transactional ? candidate.dependencies : candidate,
        ),
      };
    } catch (cause) {
      rollbackOperations([rollback], cause);
    }
  }

  #discoverLayoutDependencies(input) {
    const elements = (key) => new Set(
      [...(input?.[key] ?? [])].filter((value) => this.#isElement(value)),
    );
    const ancestors = elements('ancestors');
    const hosts = elements('hosts');
    const preceding = elements('preceding');
    const outerRoots = new Set(
      [...(input?.roots ?? [])].slice(1).filter((value) => (
        value !== null
        && typeof value === 'object'
        && value.nodeType === 11
        && value.ownerDocument === this.#doc
      )),
    );
    return {
      ancestors,
      exactMutations: new Set([...ancestors, ...outerRoots]),
      hosts,
      preceding,
      subtreeMutations: new Set([...hosts, ...preceding]),
    };
  }

  #discoverScrollTargets(record, layoutDependencies) {
    const targets = new Set();
    let current = this.#isElement(record.ownerElement)
      ? record.ownerElement
      : this.#isElement(record.element) ? record.element : null;
    const scrollingElement = this.#doc.scrollingElement;
    const addTarget = (target) => {
      const style = this.#window.getComputedStyle(target);
      if (/^(auto|scroll|overlay)$/u.test(style.overflowX)
        || /^(auto|scroll|overlay)$/u.test(style.overflowY)) {
        targets.add(target);
      }
    };

    while (current !== null) {
      addTarget(current);
      if (current === scrollingElement) {
        break;
      }
      current = current.parentElement;
    }
    for (const ancestor of layoutDependencies.ancestors) addTarget(ancestor);
    targets.add(this.#window);
    return targets;
  }

  #discoverResizeTargets(record, note, layoutDependencies) {
    const targets = new Set();
    if (this.#isElement(record.element)) {
      targets.add(record.element);
    } else if (this.#isElement(record.ownerElement)) {
      targets.add(record.ownerElement);
    }
    if (this.#isElement(note)) {
      targets.add(note);
    }
    layoutDependencies.ancestors.forEach((target) => {
      if (target !== this.#doc.body && target !== this.#doc.documentElement) {
        targets.add(target);
      }
    });
    layoutDependencies.preceding.forEach((target) => targets.add(target));
    return targets;
  }

  #discoverMutationScope(record, mutationRoot) {
    if (record.kind === 'selector') {
      return mutationRoot;
    }
    if (record.kind === 'locator') {
      return this.#isElement(record.source?.within) ? record.source.within : mutationRoot;
    }
    if (record.kind === 'element' || record.kind === 'range') {
      return this.#isElement(record.ownerElement?.parentElement)
        ? record.ownerElement.parentElement
        : mutationRoot;
    }
    return mutationRoot;
  }

  #mutationMatches(binding, record, mutationRoot, mutationHost) {
    const internal = binding.mutationRoot === mutationRoot
      && (record.target === mutationHost
        || binding.mutationScope === mutationRoot
        || record.target === binding.mutationScope
        || binding.mutationScope.contains?.(record.target)
        || (mutationRoot !== this.#doc
          && record.target.contains?.(binding.mutationScope)));
    const external = binding.mutationRoot !== this.#doc
      && (binding.layoutDependencies.exactMutations.has(record.target)
        || [...binding.layoutDependencies.subtreeMutations].some((dependency) => (
          dependency === record.target || dependency.contains?.(record.target)
        )));
    return internal || external;
  }

  #refreshLayoutDependencies(binding) {
    if (binding.readLayoutDependencies === null) return;
    const dependencyChange = this.#prepareLayoutDependencies(
      binding.readLayoutDependencies,
    );
    let layoutDependencies;
    let mutationScope;
    let resizeTargets;
    let scrollTargets;
    let rollbackTargets = null;
    try {
      layoutDependencies = dependencyChange.value;
      mutationScope = this.#discoverMutationScope(
        binding.record,
        binding.mutationRoot,
      );
      resizeTargets = this.#discoverResizeTargets(
        binding.record,
        binding.note,
        layoutDependencies,
      );
      scrollTargets = this.#discoverScrollTargets(
        binding.record,
        layoutDependencies,
      );
      rollbackTargets = this.#replaceDependencyTargets(
        binding.id,
        binding.scrollTargets,
        scrollTargets,
        binding.resizeTargets,
        resizeTargets,
      );
      dependencyChange.commit();
    } catch (cause) {
      rollbackOperations([
        dependencyChange.rollback,
        ...(rollbackTargets === null ? [] : [rollbackTargets]),
      ], cause);
    }
    binding.layoutDependencies = layoutDependencies;
    binding.mutationScope = mutationScope;
    binding.resizeTargets = resizeTargets;
    binding.scrollTargets = scrollTargets;
  }

  #signalMutations(records, mutationRoot, mutationHost = null) {
    if (!this.#alive) {
      return;
    }

    const ignoredPortals = resourceInternals.get(this)?.ignoredPortals ?? new Set();
    const ids = new Set();
    const refreshed = new Set();
    for (const record of records) {
      let ignored = false;
      for (const portal of ignoredPortals) {
        if (record.target === portal || portal.contains?.(record.target)) {
          ignored = true;
          break;
        }
      }
      if (ignored) continue;

      for (const binding of this.#layouts.values()) {
        if (!this.#mutationMatches(binding, record, mutationRoot, mutationHost)) {
          continue;
        }
        if (!refreshed.has(binding.id)) {
          try {
            this.#refreshLayoutDependencies(binding);
          } catch (error) {
            binding.onError?.(error);
            continue;
          }
          refreshed.add(binding.id);
        }
        ids.add(binding.id);
      }
    }
    for (const id of ids) {
      this.#signal(id);
    }
  }

  #replaceDependencyTargets(
    id,
    previousScroll,
    nextScroll,
    previousResize,
    nextResize,
  ) {
    const operations = [];
    const scrollOptions = { passive: true };

    for (const target of nextScroll) {
      if (previousScroll.has(target)) continue;
      operations.push(() => {
        let registration = this.#scrollTargets.get(target);
        if (registration !== undefined) {
          registration.ids.add(id);
          return () => registration.ids.delete(id);
        }
        registration = {
          ids: new Set([id]),
          listener: () => {
            for (const controllerId of registration.ids) {
              this.#signal(controllerId);
            }
          },
        };
        changeNativeRegistration(
          () => target.addEventListener('scroll', registration.listener, scrollOptions),
          () => target.removeEventListener('scroll', registration.listener, scrollOptions),
        );
        this.#scrollTargets.set(target, registration);
        return () => {
          let failure = null;
          try {
            target.removeEventListener('scroll', registration.listener, scrollOptions);
          } catch (error) {
            failure = error;
          }
          registration.ids.delete(id);
          if (this.#scrollTargets.get(target) === registration) {
            this.#scrollTargets.delete(target);
          }
          if (failure !== null) throw failure;
        };
      });
    }

    for (const target of nextResize) {
      if (previousResize.has(target)) continue;
      operations.push(() => {
        let ids = this.#resizeTargets.get(target);
        if (ids !== undefined) {
          ids.add(id);
          return () => ids.delete(id);
        }
        ids = new Set([id]);
        changeNativeRegistration(
          () => this.#resizeObserver?.observe(target),
          () => this.#resizeObserver?.unobserve(target),
        );
        this.#resizeTargets.set(target, ids);
        return () => {
          let failure = null;
          try {
            this.#resizeObserver?.unobserve(target);
          } catch (error) {
            failure = error;
          }
          ids.delete(id);
          if (this.#resizeTargets.get(target) === ids) {
            this.#resizeTargets.delete(target);
          }
          if (failure !== null) throw failure;
        };
      });
    }

    for (const target of previousScroll) {
      if (nextScroll.has(target)) continue;
      operations.push(() => {
        const registration = this.#scrollTargets.get(target);
        if (registration === undefined || !registration.ids.has(id)) return () => {};
        if (registration.ids.size > 1) {
          registration.ids.delete(id);
          return () => registration.ids.add(id);
        }
        changeNativeRegistration(
          () => target.removeEventListener('scroll', registration.listener, scrollOptions),
          () => target.addEventListener('scroll', registration.listener, scrollOptions),
        );
        registration.ids.delete(id);
        this.#scrollTargets.delete(target);
        return () => {
          changeNativeRegistration(
            () => target.addEventListener('scroll', registration.listener, scrollOptions),
            () => target.removeEventListener('scroll', registration.listener, scrollOptions),
          );
          registration.ids.add(id);
          this.#scrollTargets.set(target, registration);
        };
      });
    }

    for (const target of previousResize) {
      if (nextResize.has(target)) continue;
      operations.push(() => {
        const ids = this.#resizeTargets.get(target);
        if (ids === undefined || !ids.has(id)) return () => {};
        if (ids.size > 1) {
          ids.delete(id);
          return () => ids.add(id);
        }
        changeNativeRegistration(
          () => this.#resizeObserver?.unobserve(target),
          () => this.#resizeObserver?.observe(target),
        );
        ids.delete(id);
        this.#resizeTargets.delete(target);
        return () => {
          changeNativeRegistration(
            () => this.#resizeObserver?.observe(target),
            () => this.#resizeObserver?.unobserve(target),
          );
          ids.add(id);
          this.#resizeTargets.set(target, ids);
        };
      });
    }

    return runRegistrationTransaction(operations);
  }

  #removeLayout(id) {
    const binding = this.#layouts.get(id);
    if (binding === undefined) {
      return;
    }
    this.#replaceDependencyTargets(
      id,
      binding.scrollTargets,
      new Set(),
      binding.resizeTargets,
      new Set(),
    );
    this.#layouts.delete(id);
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
      prepare: binding.prepare,
      apply: binding.apply,
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

  static attachDefaultPortal(shared) {
    const internal = resourceInternals.get(shared);
    if (internal === undefined) {
      throw new TypeError('Unknown Document resources');
    }
    if (internal.defaultPortal === INSTALLING_PORTAL) {
      throw new TypeError('Default Document resource portal is being installed');
    }
    if (internal.defaultPortal !== null) {
      return;
    }
    internal.defaultPortal = INSTALLING_PORTAL;
    let portal;
    try {
      portal = createOverlay(shared.#doc);
      if (resourceInternals.get(shared) !== internal
        || internal.defaultPortal !== INSTALLING_PORTAL) {
        throw new TypeError('Document resources changed while the portal was being installed');
      }
      internal.defaultPortal = portal;
      internal.ignoredPortals.add(portal.overlay);
      shared.overlay = portal.overlay;
      shared.svgLayer = portal.svgLayer;
      shared.noteLayer = portal.noteLayer;
    } catch (error) {
      if (resourceInternals.get(shared) === internal
        && internal.defaultPortal === INSTALLING_PORTAL) {
        internal.defaultPortal = null;
      }
      try { portal?.overlay.remove(); } catch {}
      throw error;
    }
  }

  static detachDefaultPortal(shared) {
    const internal = resourceInternals.get(shared);
    const portal = internal?.defaultPortal;
    if (portal === INSTALLING_PORTAL) {
      internal.defaultPortal = null;
      return;
    }
    if (portal === null || portal === undefined) {
      return;
    }
    internal.defaultPortal = null;
    internal.ignoredPortals.delete(portal.overlay);
    delete shared.overlay;
    delete shared.svgLayer;
    delete shared.noteLayer;
    portal.overlay.remove();
  }

  static registerPortal(shared, portal) {
    const internal = resourceInternals.get(shared);
    if (internal === undefined) {
      throw new TypeError('Unknown Document resources');
    }
    internal.ignoredPortals.add(portal);
  }

  static unregisterPortal(shared, portal) {
    resourceInternals.get(shared)?.ignoredPortals.delete(portal);
  }

  static allocateId(shared, root, prefix) {
    const internal = resourceInternals.get(shared);
    if (internal === undefined) {
      throw new TypeError('Unknown Document resources');
    }
    let id;
    do {
      internal.nextId += 1;
      id = `${prefix}-${internal.nextId}`;
    } while ((typeof shared.#doc.getElementById === 'function'
      && shared.#doc.getElementById(id) !== null)
      || (typeof root?.getElementById === 'function'
        && root.getElementById(id) !== null));
    return id;
  }

  static signalMutations(shared, records, root, host) {
    shared.#signalMutations(records, root, host);
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
    if (this.#windowResizeInstalled) {
      this.#windowResizeInstalled = false;
      cleanup(() => this.#window.removeEventListener('resize', this.#windowResize));
    }
    if (this.#viewportResizeInstalled) {
      this.#viewportResizeInstalled = false;
      cleanup(() => this.#visualViewport.removeEventListener(
        'resize',
        this.#windowResize,
        { passive: true },
      ));
    }
    if (this.#viewportScrollInstalled) {
      this.#viewportScrollInstalled = false;
      cleanup(() => this.#visualViewport.removeEventListener(
        'scroll',
        this.#windowResize,
        { passive: true },
      ));
    }
    cleanup(() => this.#frameQueue?.destroy());
    cleanup(() => SharedDocumentResources.detachDefaultPortal(this));
    resourceInternals.delete(this);
    if (failure !== null) throw failure;
  }
}

function assertDocument(doc) {
  if (doc === null || typeof doc !== 'object' || doc.nodeType !== 9 || doc.defaultView === null) {
    throw new TypeError('doc must be a Document with a browsing context');
  }
}

function documentEntry(doc, requireDefaultPortal = false) {
  assertDocument(doc);
  let entry = resourcesByDocument.get(doc);
  if (entry !== undefined) {
    if (entry.phase !== 'active') {
      throw new TypeError('Document resources are being installed');
    }
    return entry;
  }

  entry = {
    refs: 0,
    documentRefs: 0,
    phase: 'installing',
    shared: null,
  };
  resourcesByDocument.set(doc, entry);
  let initialPortal = null;
  try {
    if (requireDefaultPortal) initialPortal = createOverlay(doc);
    entry.shared = new SharedDocumentResources(doc, initialPortal);
    entry.phase = 'active';
  } catch (error) {
    entry.phase = 'failed';
    if (resourcesByDocument.get(doc) === entry) {
      resourcesByDocument.delete(doc);
    }
    throw error;
  }
  return entry;
}

function releaseEntry(doc, entry) {
  entry.refs -= 1;
  if (entry.refs !== 0) {
    return;
  }
  try {
    SharedDocumentResources.destroy(entry.shared);
  } finally {
    if (resourcesByDocument.get(doc) === entry) {
      resourcesByDocument.delete(doc);
    }
  }
}

export function acquireDocumentResources(doc) {
  const entry = documentEntry(doc, true);
  if (entry.documentRefs === 0) {
    try {
      SharedDocumentResources.attachDefaultPortal(entry.shared);
    } catch (error) {
      if (entry.refs === 0) {
        try {
          SharedDocumentResources.destroy(entry.shared);
        } finally {
          if (resourcesByDocument.get(doc) === entry) {
            resourcesByDocument.delete(doc);
          }
        }
      }
      throw error;
    }
  }
  entry.refs += 1;
  entry.documentRefs += 1;

  let released = false;
  return {
    shared: entry.shared,
    release() {
      if (released) {
        return;
      }
      released = true;
      entry.documentRefs -= 1;
      let failure;
      if (entry.documentRefs === 0) {
        try {
          SharedDocumentResources.detachDefaultPortal(entry.shared);
        } catch (error) {
          failure = error;
        }
      }
      try {
        releaseEntry(doc, entry);
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
    },
  };
}

export function acquireDocumentScheduler(doc) {
  const entry = documentEntry(doc);
  entry.refs += 1;
  let released = false;
  return {
    shared: entry.shared,
    release() {
      if (released) return;
      released = true;
      releaseEntry(doc, entry);
    },
  };
}

export function registerDocumentResourcePortal(shared, portal) {
  SharedDocumentResources.registerPortal(shared, portal);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    SharedDocumentResources.unregisterPortal(shared, portal);
  };
}

export function allocateDocumentResourceId(shared, root, prefix = 'hana-shadow') {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('resource ID prefix must be a non-empty string');
  }
  return SharedDocumentResources.allocateId(shared, root, prefix);
}

export function signalDocumentResourceMutations(shared, records, root, host = null) {
  SharedDocumentResources.signalMutations(shared, records, root, host);
}
