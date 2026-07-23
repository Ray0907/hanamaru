import { readFile } from 'node:fs/promises'

import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { compile } from 'svelte/compiler'

const componentSource = String.raw`
<script>
  import { annotation } from 'hanamaru-annotations/svelte'

  export let initial

  const state = window.__svelteAnnotation
  const ids = new WeakMap()
  let nextId = 0
  let raw = normalize(initial)

  function id(controller) {
    if (controller === null) return null
    if (!ids.has(controller)) ids.set(controller, ++nextId)
    return ids.get(controller)
  }

  function remember(controller, bucket) {
    state.current = controller
    bucket.push(id(controller))
    if (controller !== null && !state.controllers.includes(controller)) {
      state.controllers.push(controller)
    }
  }

  const controllerHandlers = {
    none: undefined,
    record(controller) {
      remember(controller, state.transitions)
    },
    second(controller) {
      remember(controller, state.secondTransitions)
    },
    throw(controller) {
      remember(controller, state.transitions)
      state.callbackSnapshots.push({
        kind: 'controller',
        current: id(state.current),
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
        tokens: document.querySelector('[data-target]')?.getAttribute('aria-describedby') ?? null,
        value: id(controller),
      })
      throw new Error(controller === null
        ? 'onController null failed'
        : 'onController value failed')
    },
  }

  const errorHandlers = {
    none: undefined,
    record(error, controller) {
      state.errors.push({ error, controller })
    },
    second(error, controller) {
      state.secondErrors.push({ error, controller })
    },
    throw(error, controller) {
      state.callbackSnapshots.push({
        kind: 'error',
        controller: id(controller),
        current: id(state.current),
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
        tokens: document.querySelector('[data-target]')?.getAttribute('aria-describedby') ?? null,
      })
      throw new Error('onError callback failed')
    },
  }

  function normalize(input = {}) {
    return {
      accessible: input.accessible ?? true,
      controllerMode: input.controllerMode ?? 'record',
      counted: input.counted ?? false,
      duration: input.duration ?? 0,
      enabled: input.enabled ?? true,
      errorMode: input.errorMode ?? 'record',
      hidden: input.hidden ?? false,
      mark: input.mark ?? 'underline',
      motion: input.motion ?? 'system',
      note: input.note ?? 'Svelte adapter',
      patchListen: input.patchListen ?? false,
      present: input.present ?? true,
      targetKey: input.targetKey ?? 'first',
      throwOnRepeat: input.throwOnRepeat ?? false,
      trigger: input.trigger,
    }
  }

  function countedInput(source, fields, throwOnRepeat) {
    const input = {}
    for (const field of fields) {
      Object.defineProperty(input, field, {
        configurable: true,
        enumerable: true,
        get() {
          const count = (state.getterReads[field] ?? 0) + 1
          state.getterReads[field] = count
          if (throwOnRepeat && count > state.inputSnapshots) {
            throw new Error(field + ' read twice')
          }
          return source[field]
        },
      })
    }
    return new Proxy(input, {
      ownKeys(target) {
        state.inputSnapshots += 1
        return Reflect.ownKeys(target)
      },
    })
  }

  function actionInput(input) {
    const source = {
      mark: input.mark,
      note: input.note,
      placement: 'auto',
      accessible: input.accessible,
      ...(input.counted ? { seed: 'counted-seed' } : {}),
      duration: input.duration,
      motion: input.motion,
      enabled: input.enabled,
      onError: errorHandlers[input.errorMode],
      onController: controllerHandlers[input.controllerMode],
      ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
    }
    return input.counted
      ? countedInput(
          source,
          [
            'mark',
            'note',
            'placement',
            'accessible',
            'seed',
            'duration',
            'motion',
            'enabled',
            'onError',
            'onController',
          ],
          input.throwOnRepeat,
        )
      : source
  }

  function patchListener(node, enabled) {
    const original = node.addEventListener
    function apply(value) {
      node.addEventListener = value
        ? function (type, listener, options) {
            if (type === 'hana:error') throw new Error('listen failed')
            return original.call(this, type, listener, options)
          }
        : original
    }
    apply(enabled)
    return {
      update: apply,
      destroy() {
        node.addEventListener = original
      },
    }
  }

  let targetKey = raw.targetKey
  let present = raw.present
  let hidden = raw.hidden
  let patched = raw.patchListen
  let input = actionInput(raw)

  export function apply(next) {
    raw = normalize(next)
    targetKey = raw.targetKey
    present = raw.present
    hidden = raw.hidden
    patched = raw.patchListen
    input = actionInput(raw)
  }
</script>

{#key targetKey}
  {#if present}
    <span
      class="target"
      data-target=""
      style:display={hidden ? 'none' : 'inline-block'}
      use:patchListener={patched}
      use:annotation={input}
    >Claim</span>
  {/if}
{/key}
`

const applicationSource = String.raw`
  import {
    flushSync,
    mount,
    unmount,
  } from 'svelte'
  import Claim from './Claim.js'

  const state = window.__svelteAnnotation = {
    callbackSnapshots: [],
    controllers: [],
    current: null,
    errors: [],
    getterReads: {},
    inputSnapshots: 0,
    lifecycleErrors: [],
    queuedErrors: [],
    secondErrors: [],
    secondTransitions: [],
    transitions: [],
  }
  let component = null

  window.addEventListener('error', (event) => {
    state.queuedErrors.push(event.error ?? new Error(event.message))
    event.preventDefault()
  })

  function snapshot(error = null) {
    return {
      controller: state.current !== null,
      error: error === null
        ? null
        : {
            code: error.code ?? null,
            field: error.details?.field ?? null,
            message: error.message,
            name: error.name,
          },
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      state: state.current?.state ?? null,
    }
  }

  window.fixture = {
    render(input = {}) {
      let error = null
      try {
        flushSync(() => {
          if (component === null) {
            component = mount(Claim, {
              target: document.querySelector('#root'),
              props: { initial: input },
            })
          } else {
            component.apply(input)
          }
        })
      } catch (cause) {
        error = cause
        state.lifecycleErrors.push(cause)
      }
      return snapshot(error)
    },
    dispatch(controller, error, generation) {
      document.querySelector('[data-target]')?.dispatchEvent(
        new CustomEvent('hana:error', {
          bubbles: true,
          detail: { controller, error, generation },
        }),
      )
    },
    failUpdate() {
      const failure = new Error('update failed')
      state.updateFailure = failure
      state.current.update = () => {
        throw failure
      }
    },
    countDestroy() {
      const controller = state.current
      const original = controller.destroy.bind(controller)
      state.destroyCalls = 0
      controller.destroy = () => {
        state.destroyCalls += 1
        return original()
      }
    },
    refreshHidden() {
      const controller = state.current
      document.querySelector('[data-target]').style.display = 'none'
      controller.refresh()
    },
    unmount() {
      if (component === null) return
      flushSync(() => unmount(component))
      component = null
    },
  }
`

let bundledApplication
let hanamaruStyles

test.beforeAll(async () => {
  const compiled = compile(componentSource, {
    filename: 'Claim.svelte',
    generate: 'client',
  })
  const result = await build({
    bundle: true,
    format: 'iife',
    platform: 'browser',
    entryPoints: ['fixture:entry'],
    plugins: [{
      name: 'virtual-svelte-fixture',
      setup(builder) {
        builder.onResolve(
          { filter: /^fixture:entry$/ },
          () => ({ namespace: 'fixture', path: 'entry' }),
        )
        builder.onResolve(
          { filter: /^\.\/Claim\.js$/ },
          () => ({ namespace: 'fixture', path: 'component' }),
        )
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: args.path === 'entry'
            ? applicationSource
            : compiled.js.code,
          loader: 'js',
          resolveDir: process.cwd(),
        }))
      },
    }],
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
    () => window.__svelteAnnotation.current?.state === 'visible',
  )
}

test('mounts, exposes, updates silently, disables, reenables, and destroys with exact controller transitions', async ({ page }) => {
  const mounted = await render(page)
  expect(mounted.state).toMatch(/showing|visible/)
  await waitVisible(page)

  const result = await page.evaluate(() => {
    const first = window.__svelteAnnotation.current
    const same = window.fixture.render({ mark: 'circle', note: 'Changed' })
    const retained = window.__svelteAnnotation.current
    const disabled = window.fixture.render({
      enabled: false,
      mark: 'circle',
      note: 'Changed',
    })
    const reenabled = window.fixture.render({
      enabled: true,
      mark: 'circle',
      note: 'Changed',
    })
    const second = window.__svelteAnnotation.current
    window.fixture.countDestroy()
    window.fixture.unmount()
    window.fixture.unmount()
    return {
      disabled,
      firstDestroyed: first.state,
      reenabled,
      retained: retained === first,
      same,
      destroyCalls: window.__svelteAnnotation.destroyCalls,
      secondDestroyed: second.state,
      transitions: window.__svelteAnnotation.transitions,
    }
  })

  expect(result.retained).toBe(true)
  expect(result.same.controller).toBe(true)
  expect(result.disabled).toMatchObject({ controller: false, overlays: 0 })
  expect(result.reenabled.controller).toBe(true)
  expect(result.firstDestroyed).toBe('destroyed')
  expect(result.secondDestroyed).toBe('destroyed')
  expect(result.destroyCalls).toBe(1)
  expect(result.transitions).toEqual([1, null, 2, null])
  expect(await page.evaluate(
    () => window.__svelteAnnotation.errors.length,
  )).toBe(0)
})

test('keyed node replacement reports null before the fresh accepted controller and leaves no duplicates', async ({ page }) => {
  await render(page)
  await waitVisible(page)
  const replacement = await page.evaluate(() => {
    const first = window.__svelteAnnotation.current
    window.fixture.render({ targetKey: 'second' })
    const second = window.__svelteAnnotation.current
    return {
      firstState: first.state,
      replaced: first !== second,
    }
  })
  await waitVisible(page)
  const result = await page.evaluate(() => {
    const target = document.querySelector('[data-target]')
    const tokens = (target.getAttribute('aria-describedby') ?? '')
      .split(/\s+/u)
      .filter(Boolean)
    return {
      annotations: document.querySelectorAll('.hana-annotation').length,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      tokenCount: tokens.length,
      transitions: window.__svelteAnnotation.transitions,
      uniqueTokens: new Set(tokens).size,
    }
  })

  expect(replacement).toEqual({
    firstState: 'destroyed',
    replaced: true,
  })
  expect(result).toEqual({
    annotations: 1,
    overlays: 1,
    tokenCount: 1,
    transitions: [1, null, 2],
    uniqueTokens: 1,
  })
})

test('uses fresh callbacks without a controller transition or remount', async ({ page }) => {
  await render(page)
  await waitVisible(page)
  const result = await page.evaluate(() => {
    const controller = window.__svelteAnnotation.current
    window.fixture.render({
      controllerMode: 'second',
      errorMode: 'second',
    })
    const retained = window.__svelteAnnotation.current
    window.fixture.dispatch(controller, new Error('fresh callback'), 11)
    return {
      controllers: window.__svelteAnnotation.controllers.length,
      retained: controller === retained,
      transitions: window.__svelteAnnotation.transitions,
    }
  })
  await page.waitForFunction(
    () => window.__svelteAnnotation.secondErrors.length === 1,
  )
  expect(result).toEqual({
    controllers: 1,
    retained: true,
    transitions: [1],
  })
  expect(await page.evaluate(() => ({
    current: window.__svelteAnnotation.current,
    firstErrors: window.__svelteAnnotation.errors.length,
    secondErrors: window.__svelteAnnotation.secondErrors.length,
    secondTransitions: window.__svelteAnnotation.secondTransitions,
  }))).toEqual({
    current: null,
    firstErrors: 0,
    secondErrors: 1,
    secondTransitions: [null],
  })
})

test('reads each combined input accessor once and rejects trigger with a typed direct action error', async ({ page }) => {
  expect(await render(page, {
    counted: true,
    throwOnRepeat: true,
  })).toMatchObject({ controller: true, error: null })
  expect(await page.evaluate(() => {
    const state = window.__svelteAnnotation
    return {
      allOncePerSnapshot: Object.values(state.getterReads)
        .every((count) => count === state.inputSnapshots),
      fields: Object.keys(state.getterReads).sort(),
      snapshots: state.inputSnapshots,
    }
  })).toEqual({
    allOncePerSnapshot: true,
    fields: [
      'accessible',
      'duration',
      'enabled',
      'mark',
      'motion',
      'note',
      'onController',
      'onError',
      'placement',
      'seed',
    ],
    snapshots: 2,
  })

  await page.reload()
})

test('rejects trigger before output with HanamaruConfigError', async ({ page }) => {
  const result = await render(page, { trigger: 'viewport' })
  expect(result).toEqual({
    controller: false,
    error: {
      code: 'HANA_CONFIG_INVALID',
      field: 'trigger',
      message: 'Invalid adapter option: trigger',
      name: 'HanamaruConfigError',
    },
    overlays: 0,
    state: null,
  })
})

test('contains synchronous creation and update failures, reports null, and rethrows from the action call', async ({ page }) => {
  const construction = await render(page, { patchListen: true })
  expect(construction).toMatchObject({
    controller: false,
    error: { message: 'listen failed' },
    overlays: 0,
  })
  expect(await page.evaluate(
    () => window.__svelteAnnotation.transitions,
  )).toEqual([])

  await page.reload()
})

test('contains a synchronous controller update failure and reports null once', async ({ page }) => {
  await render(page)
  await waitVisible(page)
  const result = await page.evaluate(() => {
    window.fixture.failUpdate()
    return window.fixture.render({ mark: 'circle' })
  })
  expect(result).toMatchObject({
    controller: false,
    error: { message: 'update failed' },
    overlays: 0,
  })
  expect(await page.evaluate(() => ({
    exact: window.__svelteAnnotation.lifecycleErrors[0]
      === window.__svelteAnnotation.updateFailure,
    transitions: window.__svelteAnnotation.transitions,
  }))).toEqual({ exact: true, transitions: [1, null] })
})

test('deduplicates accepted-show failures, destroys first, and latches the failed request', async ({ page }) => {
  await render(page, { hidden: true })
  await page.waitForFunction(() => window.__svelteAnnotation.errors.length === 1)
  const result = await page.evaluate(async () => {
    await Promise.resolve()
    const before = window.__svelteAnnotation.controllers.length
    window.fixture.render({ hidden: true })
    window.fixture.render({
      controllerMode: 'second',
      errorMode: 'second',
      hidden: true,
    })
    await Promise.resolve()
    return {
      before,
      controllers: window.__svelteAnnotation.controllers.length,
      current: window.__svelteAnnotation.current,
      errors: window.__svelteAnnotation.errors.length,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      transitions: window.__svelteAnnotation.transitions,
    }
  })
  expect(result).toEqual({
    before: 1,
    controllers: 1,
    current: null,
    errors: 1,
    overlays: 0,
    transitions: [1, null],
  })

  await render(page, { hidden: true, mark: 'circle' })
  await page.waitForFunction(
    () => window.__svelteAnnotation.errors.length === 2,
  )
  expect(await page.evaluate(
    () => window.__svelteAnnotation.controllers.length,
  )).toBe(2)
})

test('contains current hana:error once and ignores stale events after keyed replacement', async ({ page }) => {
  await render(page)
  await waitVisible(page)
  const result = await page.evaluate(() => {
    const old = window.__svelteAnnotation.current
    const oldTarget = document.querySelector('[data-target]')
    window.fixture.render({ targetKey: 'second' })
    oldTarget.dispatchEvent(new CustomEvent('hana:error', {
      detail: { controller: old, error: new Error('stale'), generation: 17 },
    }))
    const current = window.__svelteAnnotation.current
    const failure = new Error('current')
    window.fixture.dispatch(current, failure, 18)
    window.fixture.dispatch(current, failure, 18)
    return { oldState: old.state }
  })
  await page.waitForFunction(() => window.__svelteAnnotation.errors.length === 1)
  expect(result.oldState).toBe('destroyed')
  expect(await page.evaluate(() => ({
    current: window.__svelteAnnotation.current,
    errors: window.__svelteAnnotation.errors.length,
    overlays: document.querySelectorAll('[data-hana-overlay]').length,
    transitions: window.__svelteAnnotation.transitions,
  }))).toEqual({
    current: null,
    errors: 1,
    overlays: 0,
    transitions: [1, null, 2, null],
  })
})

test('suppresses stale finished rejection and removes the old listener on keyed replacement', async ({ page }) => {
  expect(await render(page, {
    duration: 5_000,
    motion: 'system',
  })).toMatchObject({ state: 'showing' })

  const result = await page.evaluate(async () => {
    const old = window.__svelteAnnotation.current
    const oldTarget = document.querySelector('[data-target]')
    window.fixture.render({ targetKey: 'second' })
    oldTarget.dispatchEvent(new CustomEvent('hana:error', {
      detail: { controller: old, error: new Error('removed listener') },
    }))
    await Promise.resolve()
    await Promise.resolve()
    return {
      currentChanged: old !== window.__svelteAnnotation.current,
      errors: window.__svelteAnnotation.errors.length,
      oldState: old.state,
      transitions: window.__svelteAnnotation.transitions,
    }
  })

  expect(result).toEqual({
    currentChanged: true,
    errors: 0,
    oldState: 'destroyed',
    transitions: [1, null, 2],
  })
})

test('contains a throwing onController callback and directly rethrows after cleanup', async ({ page }) => {
  await render(page, {
    controllerMode: 'throw',
  })
  expect(await page.evaluate(() => ({
    errors: window.__svelteAnnotation.lifecycleErrors.map((error) => error.message),
    snapshots: window.__svelteAnnotation.callbackSnapshots,
  }))).toMatchObject({
    errors: ['onController value failed'],
    snapshots: [
      {
        current: 1,
        kind: 'controller',
        overlays: 1,
        value: 1,
      },
      {
        current: null,
        kind: 'controller',
        overlays: 0,
        value: null,
      },
    ],
  })

  await page.reload()
})

test('queues throwing onError and onController-null callbacks only after async cleanup', async ({ page }) => {
  await render(page)
  await waitVisible(page)
  await render(page, {
    controllerMode: 'throw',
    errorMode: 'throw',
  })
  await page.evaluate(() => {
    const controller = window.__svelteAnnotation.current
    window.fixture.dispatch(controller, new Error('async failed'), 41)
  })
  await page.waitForFunction(
    () => window.__svelteAnnotation.queuedErrors.length >= 1,
  )
  expect(await page.evaluate(() => ({
    current: window.__svelteAnnotation.current,
    overlays: document.querySelectorAll('[data-hana-overlay]').length,
    queued: window.__svelteAnnotation.queuedErrors.map((error) => error.message),
    snapshots: window.__svelteAnnotation.callbackSnapshots,
  }))).toMatchObject({
    current: null,
    overlays: 0,
    queued: [
      'onController null failed',
      'onError callback failed',
    ],
    snapshots: [
      {
        current: null,
        kind: 'controller',
        overlays: 0,
        value: null,
      },
      {
        controller: 1,
        current: null,
        kind: 'error',
        overlays: 0,
      },
    ],
  })
})

test('inherits reduced motion and preserves active motion without the preference', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await render(page, {
    duration: 5_000,
    motion: 'system',
  })).toMatchObject({ state: 'visible' })
  expect(await page.evaluate(() => ({
    animations: [...document.querySelectorAll('.hana-mark-path')]
      .reduce((count, path) => count + path.getAnimations().length, 0),
    state: window.__svelteAnnotation.current.state,
  }))).toEqual({ animations: 0, state: 'visible' })

  await page.reload()
})

test('runs a system animation when reduced motion is not requested', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(await render(page, {
    duration: 5_000,
    motion: 'system',
  })).toMatchObject({ state: 'showing' })
  await page.waitForFunction(() => {
    const controller = window.__svelteAnnotation.current
    const animations = [...document.querySelectorAll('.hana-mark-path')]
      .reduce((count, path) => count + path.getAnimations().length, 0)
    return controller?.state === 'showing' && animations > 0
  })
})
