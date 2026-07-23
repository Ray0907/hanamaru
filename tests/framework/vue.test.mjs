import { readFile } from 'node:fs/promises'

import { expect, test } from '@playwright/test'
import { build } from 'esbuild'

const application = String.raw`
  import {
    createApp,
    h,
    isRef,
    isShallow,
    nextTick,
    reactive,
    ref,
    shallowRef,
    watch,
  } from 'vue'
  import { useAnnotation } from 'hanamaru-annotations/vue'

  const state = window.__vueAnnotation = {
    annotationRef: null,
    app: null,
    callbackSnapshots: [],
    controllers: [],
    errors: [],
    getterReads: {},
    lifecycleErrors: [],
    pendingInput: null,
    secondErrors: [],
  }

  const errorHandlers = {
    record(error, controller) {
      state.errors.push({ error, controller })
    },
    recordSecond(error, controller) {
      state.secondErrors.push({ error, controller })
    },
    rerender(error, controller) {
      state.errors.push({ error, controller })
      state.bump()
    },
    throw(error, controller) {
      state.callbackSnapshots.push({
        controller,
        current: state.annotationRef?.value ?? null,
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
        tokens: document.querySelector('[data-target]')?.getAttribute('aria-describedby') ?? null,
      })
      throw new Error('onError callback failed')
    },
  }

  function normalizeInput(input = {}) {
    return {
      accessible: input.accessible ?? true,
      counted: input.counted ?? false,
      configMode: input.configMode ?? 'record',
      duration: input.duration ?? 0,
      enabled: input.enabled ?? true,
      hidden: input.hidden ?? false,
      mark: input.mark ?? 'underline',
      motion: input.motion ?? 'system',
      note: input.note ?? 'Vue adapter',
      patchListen: input.patchListen ?? false,
      present: input.present ?? true,
      targetKey: input.targetKey ?? 'first',
      throwOnRepeat: input.throwOnRepeat ?? false,
      trigger: input.trigger,
    }
  }

  function countedInput(source, fields, prefix, throwOnRepeat) {
    const input = {}
    for (const field of fields) {
      Object.defineProperty(input, field, {
        configurable: true,
        enumerable: true,
        get() {
          const key = prefix + '.' + field
          const count = (state.getterReads[key] ?? 0) + 1
          state.getterReads[key] = count
          if (throwOnRepeat && count > 1) {
            throw new Error(key + ' read twice')
          }
          return source[field]
        },
      })
    }
    return input
  }

  function optionsFrom(input) {
    return {
      mark: input.mark,
      note: input.note,
      placement: 'auto',
      accessible: input.accessible,
      ...(input.counted ? { seed: 'counted-seed' } : {}),
      duration: input.duration,
      motion: input.motion,
      ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
    }
  }

  function configFrom(input) {
    return {
      enabled: input.enabled,
      onError: input.configMode === 'none'
        ? undefined
        : errorHandlers[input.configMode],
    }
  }

  function replaceFields(target, source) {
    for (const key of Reflect.ownKeys(target)) {
      if (!Object.hasOwn(source, key)) Reflect.deleteProperty(target, key)
    }
    for (const key of Reflect.ownKeys(source)) {
      Reflect.set(target, key, source[key])
    }
  }

  const Claim = {
    name: 'Claim',
    setup() {
      const initial = state.pendingInput
      const target = ref(null)
      const revision = ref(0)
      const view = reactive({
        hidden: initial.hidden,
        patchListen: initial.patchListen,
        present: initial.present,
        targetKey: initial.targetKey,
      })
      const initialOptions = optionsFrom(initial)
      const initialConfig = configFrom(initial)
      const options = initial.counted
        ? shallowRef(countedInput(
          initialOptions,
          ['mark', 'note', 'placement', 'accessible', 'seed', 'duration', 'motion'],
          'options',
          initial.throwOnRepeat,
        ))
        : reactive(initialOptions)
      const config = initial.counted
        ? shallowRef(countedInput(
          initialConfig,
          ['enabled', 'onError'],
          'config',
          initial.throwOnRepeat,
        ))
        : reactive(initialConfig)
      const annotation = useAnnotation(target, options, config)

      state.annotationRef = annotation
      state.bump = () => {
        revision.value += 1
      }
      state.apply = (next) => {
        view.hidden = next.hidden
        view.patchListen = next.patchListen
        view.present = next.present
        view.targetKey = next.targetKey
        const nextOptions = optionsFrom(next)
        const nextConfig = configFrom(next)
        if (initial.counted) {
          options.value = countedInput(
            nextOptions,
            ['mark', 'note', 'placement', 'accessible', 'seed', 'duration', 'motion'],
            'options',
            next.throwOnRepeat,
          )
          config.value = countedInput(
            nextConfig,
            ['enabled', 'onError'],
            'config',
            next.throwOnRepeat,
          )
        } else {
          replaceFields(options, nextOptions)
          replaceFields(config, nextConfig)
        }
      }

      watch(annotation, (controller) => {
        if (controller !== null && !state.controllers.includes(controller)) {
          state.controllers.push(controller)
        }
      }, { flush: 'sync' })

      function setTarget(node) {
        if (node && view.patchListen) {
          node.addEventListener = function (type, listener, options_) {
            if (type === 'hana:error') throw new Error('listen failed')
            return EventTarget.prototype.addEventListener.call(
              this,
              type,
              listener,
              options_,
            )
          }
        }
        target.value = node
      }

      return () => {
        revision.value
        if (!view.present) return null
        return h('span', {
          class: 'target',
          'data-target': '',
          key: view.targetKey,
          ref: setTarget,
          style: { display: view.hidden ? 'none' : 'inline-block' },
        }, 'Claim')
      }
    },
  }

  window.fixture = {
    async render(input = {}) {
      const next = normalizeInput(input)
      if (state.app === null) {
        state.pendingInput = next
        const app = createApp(Claim)
        app.config.errorHandler = (error) => {
          state.lifecycleErrors.push(error)
        }
        state.app = app
        app.mount(document.querySelector('#root'))
      } else {
        state.apply(next)
      }
      await nextTick()
      await nextTick()
      return {
        controller: state.annotationRef?.value !== null,
        shallow: state.annotationRef
          ? isRef(state.annotationRef) && isShallow(state.annotationRef)
          : false,
        state: state.annotationRef?.value?.state ?? null,
      }
    },
    dispatch(controller, error, generation) {
      const target = document.querySelector('[data-target]')
      target?.dispatchEvent(new CustomEvent('hana:error', {
        bubbles: true,
        detail: { controller, error, generation },
      }))
    },
    async bump() {
      state.bump()
      await nextTick()
    },
    unmount() {
      state.app?.unmount()
      state.app = null
    },
  }
`

let bundledApplication
let hanamaruStyles

test.beforeAll(async () => {
  const result = await build({
    bundle: true,
    format: 'iife',
    platform: 'browser',
    stdin: {
      contents: application,
      loader: 'js',
      resolveDir: process.cwd(),
      sourcefile: 'vue-fixture.js',
    },
    write: false,
  })
  bundledApplication = result.outputFiles[0].text
  hanamaruStyles = await readFile(
    new URL('./node_modules/hanamaru-annotations/src/hanamaru.css', import.meta.url),
    'utf8',
  )
})

test.beforeEach(async ({ page }) => {
  await page.setContent(`
    <style>
      body { margin: 0; min-height: 480px; }
      .target { width: 140px; height: 28px; margin: 120px; }
      ${hanamaruStyles}
    </style>
    <div id="root"></div>
  `)
  await page.addScriptTag({ content: bundledApplication })
})

async function render(page, input = {}) {
  return page.evaluate((next) => window.fixture.render(next), input)
}

async function waitVisible(page) {
  await page.waitForFunction(
    () => window.__vueAnnotation.annotationRef?.value?.state === 'visible',
  )
}

test('mounts and shows through a ShallowRef, then watches canonical fields without remounting', async ({ page }) => {
  const mounted = await render(page)
  expect(mounted.shallow).toBe(true)
  expect(mounted.state).toMatch(/showing|visible/)
  await waitVisible(page)

  const result = await page.evaluate(async () => {
    const first = window.__vueAnnotation.annotationRef.value
    await window.fixture.render({ mark: 'underline', note: 'Vue adapter' })
    const sameCanonical = window.__vueAnnotation.annotationRef.value
    await window.fixture.render({ mark: 'circle', note: 'Changed' })
    const changed = window.__vueAnnotation.annotationRef.value
    return {
      sameCanonical: first === sameCanonical,
      sameAfterUpdate: first === changed,
      mark: document.querySelector('.hana-annotation')?.getAttribute('data-hana-mark'),
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    }
  })

  expect(result).toEqual({
    sameCanonical: true,
    sameAfterUpdate: true,
    mark: 'circle',
    overlays: 1,
  })
})

test('waits for the target ref, replaces after availability, and tracks enabled config', async ({ page }) => {
  expect((await render(page, { present: false })).controller).toBe(false)
  expect((await render(page, { present: true })).controller).toBe(true)
  await waitVisible(page)

  const result = await page.evaluate(async () => {
    const first = window.__vueAnnotation.annotationRef.value
    await window.fixture.render({ targetKey: 'second' })
    const second = window.__vueAnnotation.annotationRef.value
    const afterReplace = {
      replaced: first !== second,
      oldState: first.state,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    }
    await window.fixture.render({ targetKey: 'second', enabled: false })
    const disabled = {
      current: window.__vueAnnotation.annotationRef.value,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    }
    await window.fixture.render({ targetKey: 'second', enabled: true })
    return {
      afterReplace,
      disabled,
      reenabled: window.__vueAnnotation.annotationRef.value !== null,
    }
  })

  expect(result).toEqual({
    afterReplace: { replaced: true, oldState: 'destroyed', overlays: 1 },
    disabled: { current: null, overlays: 0 },
    reenabled: true,
  })
})

test('does not duplicate overlays or ARIA tokens across reactive rerenders', async ({ page }) => {
  await render(page, { note: 'Stable note' })
  await waitVisible(page)
  await page.evaluate(async () => {
    await window.fixture.bump()
    await window.fixture.render({ note: 'Stable note' })
    await window.fixture.bump()
  })

  expect(await page.evaluate(() => {
    const target = document.querySelector('[data-target]')
    const tokens = (target.getAttribute('aria-describedby') ?? '')
      .split(/\s+/u)
      .filter(Boolean)
    return {
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      annotations: document.querySelectorAll('.hana-annotation').length,
      tokenCount: tokens.length,
      uniqueTokens: new Set(tokens).size,
    }
  })).toEqual({
    overlays: 1,
    annotations: 1,
    tokenCount: 1,
    uniqueTokens: 1,
  })
})

test('destroys the mounted controller exactly once before unmount and removes its listener', async ({ page }) => {
  await render(page)
  await waitVisible(page)

  expect(await page.evaluate(() => {
    const controller = window.__vueAnnotation.annotationRef.value
    const target = document.querySelector('[data-target]')
    let destroys = 0
    const destroy = controller.destroy.bind(controller)
    controller.destroy = () => {
      destroys += 1
      return destroy()
    }
    window.fixture.unmount()
    target.dispatchEvent(new CustomEvent('hana:error', {
      detail: { controller, error: new Error('stale') },
    }))
    return {
      destroys,
      errors: window.__vueAnnotation.errors.length,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      token: target.getAttribute('aria-describedby'),
    }
  })).toEqual({
    destroys: 1,
    errors: 0,
    overlays: 0,
    token: null,
  })
})

test('rejects trigger with a typed Vue lifecycle error before creating output', async ({ page }) => {
  await render(page, { trigger: 'viewport' })
  await page.waitForFunction(() => window.__vueAnnotation.lifecycleErrors.length > 0)

  expect(await page.evaluate(() => {
    const error = window.__vueAnnotation.lifecycleErrors[0]
    return {
      code: error.code,
      field: error.details?.field,
      current: window.__vueAnnotation.annotationRef?.value ?? null,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    }
  })).toEqual({
    code: 'HANA_CONFIG_INVALID',
    field: 'trigger',
    current: null,
    overlays: 0,
  })
})

test('validates reactive adapter input even while the target ref is unavailable', async ({ page }) => {
  await render(page, { present: false, trigger: 'viewport' })
  await page.waitForFunction(() => window.__vueAnnotation.lifecycleErrors.length > 0)

  expect(await page.evaluate(() => {
    const error = window.__vueAnnotation.lifecycleErrors[0]
    return {
      code: error.code,
      field: error.details?.field,
      current: window.__vueAnnotation.annotationRef?.value ?? null,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    }
  })).toEqual({
    code: 'HANA_CONFIG_INVALID',
    field: 'trigger',
    current: null,
    overlays: 0,
  })
})

test('contains synchronous construction and update failures before Vue reports them', async ({ page }) => {
  await render(page, { patchListen: true })
  await page.waitForFunction(() => window.__vueAnnotation.lifecycleErrors.length > 0)
  expect(await page.evaluate(() => ({
    message: window.__vueAnnotation.lifecycleErrors[0].message,
    overlays: document.querySelectorAll('[data-hana-overlay]').length,
    current: window.__vueAnnotation.annotationRef?.value ?? null,
  }))).toEqual({
    message: 'listen failed',
    overlays: 0,
    current: null,
  })

  await page.reload()
})

test('contains a synchronous update failure, exposes null, and reports through Vue lifecycle', async ({ page }) => {
  await render(page)
  await waitVisible(page)
  await page.evaluate(async () => {
    const controller = window.__vueAnnotation.annotationRef.value
    controller.update = () => {
      throw new Error('update failed')
    }
    await window.fixture.render({ mark: 'circle' })
  })
  await page.waitForFunction(
    () => window.__vueAnnotation.lifecycleErrors.some(
      (error) => error.message === 'update failed',
    ),
  )
  expect(await page.evaluate(() => ({
    current: window.__vueAnnotation.annotationRef.value,
    overlays: document.querySelectorAll('[data-hana-overlay]').length,
  }))).toEqual({ current: null, overlays: 0 })
})

test('routes accepted finished plus hana:error once and cleans failed ownership', async ({ page }) => {
  await render(page, { hidden: true })
  await page.waitForFunction(() => window.__vueAnnotation.errors.length === 1)

  expect(await page.evaluate(() => ({
    errors: window.__vueAnnotation.errors.length,
    current: window.__vueAnnotation.annotationRef.value,
    overlays: document.querySelectorAll('[data-hana-overlay]').length,
    token: document.querySelector('[data-target]')?.getAttribute('aria-describedby') ?? null,
  }))).toEqual({
    errors: 1,
    current: null,
    overlays: 0,
    token: null,
  })
})

test('contains post-visible hana:error and suppresses stale replacement events', async ({ page }) => {
  await render(page)
  await waitVisible(page)

  const stale = await page.evaluate(async () => {
    const oldController = window.__vueAnnotation.annotationRef.value
    const oldTarget = document.querySelector('[data-target]')
    await window.fixture.render({ targetKey: 'second' })
    oldTarget.dispatchEvent(new CustomEvent('hana:error', {
      detail: { controller: oldController, error: new Error('stale') },
    }))
    return {
      errors: window.__vueAnnotation.errors.length,
      oldState: oldController.state,
    }
  })
  expect(stale).toEqual({ errors: 0, oldState: 'destroyed' })

  await page.evaluate(() => {
    const controller = window.__vueAnnotation.annotationRef.value
    const target = document.querySelector('[data-target]')
    target.style.display = 'none'
    controller.refresh()
  })
  await page.waitForFunction(() => window.__vueAnnotation.errors.length === 1)
  expect(await page.evaluate(() => ({
    current: window.__vueAnnotation.annotationRef.value,
    overlays: document.querySelectorAll('[data-hana-overlay]').length,
  }))).toEqual({ current: null, overlays: 0 })
})

test('ignores stale pending finished rejection and removes the old listener on replacement', async ({ page }) => {
  const mounted = await render(page)
  expect(mounted.state).toBe('showing')

  const result = await page.evaluate(async () => {
    const oldController = window.__vueAnnotation.annotationRef.value
    const oldTarget = document.querySelector('[data-target]')
    await window.fixture.render({ targetKey: 'second' })
    oldTarget.dispatchEvent(new CustomEvent('hana:error', {
      detail: { controller: oldController, error: new Error('removed listener') },
    }))
    return {
      currentChanged: oldController !== window.__vueAnnotation.annotationRef.value,
      oldState: oldController.state,
    }
  })
  await waitVisible(page)
  await page.evaluate(() => Promise.resolve())

  expect(result).toEqual({ currentChanged: true, oldState: 'destroyed' })
  expect(await page.evaluate(() => window.__vueAnnotation.errors.length)).toBe(0)
})

test('cleans before a throwing onError callback surfaces from a queued microtask', async ({ page }) => {
  const pageError = page.waitForEvent('pageerror')
  await render(page, { configMode: 'throw', hidden: true })
  expect((await pageError).message).toBe('onError callback failed')

  expect(await page.evaluate(
    () => window.__vueAnnotation.callbackSnapshots[0],
  )).toMatchObject({
    current: null,
    overlays: 0,
    tokens: null,
  })
})

test('latches failed requests across unrelated and onError changes, then retries meaningful changes', async ({ page }) => {
  const failing = {
    configMode: 'rerender',
    hidden: true,
    mark: 'underline',
    targetKey: 'first',
  }
  await render(page, failing)
  await page.waitForFunction(() => window.__vueAnnotation.errors.length === 1)

  const snapshot = () => page.evaluate(() => ({
    controllers: window.__vueAnnotation.controllers.length,
    errors: window.__vueAnnotation.errors.length,
    current: window.__vueAnnotation.annotationRef.value,
    overlays: document.querySelectorAll('[data-hana-overlay]').length,
  }))
  expect(await snapshot()).toEqual({
    controllers: 1,
    errors: 1,
    current: null,
    overlays: 0,
  })

  await page.evaluate(async () => {
    await window.fixture.bump()
    await window.fixture.render({
      configMode: 'recordSecond',
      hidden: true,
      mark: 'underline',
      targetKey: 'first',
    })
  })
  expect(await snapshot()).toEqual({
    controllers: 1,
    errors: 1,
    current: null,
    overlays: 0,
  })

  await render(page, { ...failing, mark: 'circle' })
  await page.waitForFunction(() => window.__vueAnnotation.errors.length === 2)
  expect((await snapshot()).controllers).toBe(2)

  await render(page, { ...failing, mark: 'circle', targetKey: 'second' })
  await page.waitForFunction(() => window.__vueAnnotation.errors.length === 3)
  expect((await snapshot()).controllers).toBe(3)

  await render(page, {
    ...failing,
    enabled: false,
    mark: 'circle',
    targetKey: 'second',
  })
  expect((await snapshot()).controllers).toBe(3)
  await render(page, {
    ...failing,
    enabled: true,
    mark: 'circle',
    targetKey: 'second',
  })
  await page.waitForFunction(() => window.__vueAnnotation.errors.length === 4)
  expect((await snapshot()).controllers).toBe(4)
})

test('uses the fresh onError callback without retrying or remounting', async ({ page }) => {
  await render(page, { configMode: 'record' })
  await waitVisible(page)
  const retained = await page.evaluate(async () => {
    const controller = window.__vueAnnotation.annotationRef.value
    await window.fixture.render({ configMode: 'recordSecond' })
    const same = controller === window.__vueAnnotation.annotationRef.value
    window.fixture.dispatch(controller, new Error('fresh callback'))
    return {
      same,
      controllers: window.__vueAnnotation.controllers.length,
    }
  })
  await page.waitForFunction(() => window.__vueAnnotation.secondErrors.length === 1)

  expect(retained).toEqual({ same: true, controllers: 1 })
  expect(await page.evaluate(() => ({
    current: window.__vueAnnotation.annotationRef.value,
    firstErrors: window.__vueAnnotation.errors.length,
    secondErrors: window.__vueAnnotation.secondErrors.length,
  }))).toEqual({
    current: null,
    firstErrors: 0,
    secondErrors: 1,
  })
})

test('reads each accessor field once and never deep-traverses unrelated render state', async ({ page }) => {
  const mounted = await render(page, {
    counted: true,
    throwOnRepeat: true,
  })
  expect(mounted.state).toMatch(/showing|visible/)

  expect(await page.evaluate(() => ({
    lifecycleError: window.__vueAnnotation.lifecycleErrors[0]?.message ?? null,
    reads: window.__vueAnnotation.getterReads,
  }))).toEqual({
    lifecycleError: null,
    reads: {
      'config.enabled': 1,
      'config.onError': 1,
      'options.accessible': 1,
      'options.duration': 1,
      'options.mark': 1,
      'options.motion': 1,
      'options.note': 1,
      'options.placement': 1,
      'options.seed': 1,
    },
  })

  await page.evaluate(() => window.fixture.bump())
  expect(await page.evaluate(() => window.__vueAnnotation.getterReads)).toEqual({
    'config.enabled': 1,
    'config.onError': 1,
    'options.accessible': 1,
    'options.duration': 1,
    'options.mark': 1,
    'options.motion': 1,
    'options.note': 1,
    'options.placement': 1,
    'options.seed': 1,
  })
})

test('inherits reduced motion and settles a long system animation synchronously', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const mounted = await render(page, { duration: 900, motion: 'system' })

  expect(mounted.state).toBe('visible')
  expect(await page.evaluate(async () => {
    const controller = window.__vueAnnotation.annotationRef.value
    let settlement = 'pending'
    controller.finished.then(
      () => { settlement = 'resolved' },
      () => { settlement = 'rejected' },
    )
    await Promise.resolve()
    const group = document.querySelector('.hana-annotation')
    const path = group.querySelector('.hana-mark-path')
    return {
      activeAnimations: path.getAnimations().length,
      animatingClass: group.classList.contains('hana-is-animating'),
      settlement,
      state: controller.state,
      strokeDashoffset: path.style.strokeDashoffset,
    }
  })).toEqual({
    activeAnimations: 0,
    animatingClass: false,
    settlement: 'resolved',
    state: 'visible',
    strokeDashoffset: '0',
  })
})

test('keeps the same long system animation active without reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const mounted = await render(page, { duration: 900, motion: 'system' })

  expect(mounted.state).toBe('showing')
  expect(await page.evaluate(async () => {
    const controller = window.__vueAnnotation.annotationRef.value
    let settlement = 'pending'
    controller.finished.then(
      () => { settlement = 'resolved' },
      () => { settlement = 'rejected' },
    )
    for (let frame = 0; frame < 20; frame += 1) {
      const path = document.querySelector('.hana-mark-path')
      const group = document.querySelector('.hana-annotation')
      const activeMotion = (path?.getAnimations().length ?? 0) > 0
        || group?.classList.contains('hana-is-animating')
      if (activeMotion) {
        const snapshot = {
          activeMotion,
          settlement,
          state: controller.state,
        }
        window.fixture.unmount()
        return snapshot
      }
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    window.fixture.unmount()
    return {
      activeMotion: false,
      settlement,
      state: controller.state,
    }
  })).toEqual({
    activeMotion: true,
    settlement: 'pending',
    state: 'showing',
  })
})
