import { readFile } from 'node:fs/promises'

import { expect, test } from '@playwright/test'
import { build } from 'esbuild'

const application = String.raw`
  import React, {
    StrictMode,
    useLayoutEffect,
    useRef,
  } from 'react'
  import { flushSync } from 'react-dom'
  import { createRoot } from 'react-dom/client'
  import { useAnnotation } from 'hanamaru-annotations/react'

  const state = window.__reactAnnotation = {
    annotationRef: null,
    boundaryError: null,
    callbackSnapshots: [],
    controllers: [],
    errors: [],
    getterReads: {},
    renders: 0,
    secondErrors: [],
  }

  const errorHandlers = {
    record(error, controller) {
      state.errors.push({ error, controller })
    },
    recordSecond(error, controller) {
      state.secondErrors.push({ error, controller })
    },
    throw(error, controller) {
      state.callbackSnapshots.push({
        controller,
        current: state.annotationRef?.current ?? null,
        overlays: document.querySelectorAll('[data-hana-overlay]').length,
        tokens: document.querySelector('[data-target]')?.getAttribute('aria-describedby') ?? null,
      })
      throw new Error('onError callback failed')
    },
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

  class Boundary extends React.Component {
    constructor(props) {
      super(props)
      this.state = { error: null }
    }
    static getDerivedStateFromError(error) {
      return { error }
    }
    componentDidCatch(error) {
      state.boundaryError = error
    }
    render() {
      return this.state.error === null ? this.props.children : null
    }
  }

  function Claim({
    accessible,
    counted,
    configMode,
    duration,
    enabled,
    hidden,
    mark,
    note,
    motion,
    patchListen,
    present,
    targetKey,
    throwOnRepeat,
    trigger,
  }) {
    const target = useRef(null)
    const [, setRevision] = React.useState(0)
    const rerenderOnError = React.useCallback((error, controller) => {
      state.errors.push({ error, controller })
      if (state.errors.length === 1) {
        setRevision((revision) => revision + 1)
      }
    }, [])
    const selectedOnError = configMode === 'none'
      ? undefined
      : (configMode === 'rerender'
        ? rerenderOnError
        : errorHandlers[configMode])
    const rawOptions = {
      mark,
      note,
      placement: 'auto',
      accessible,
      ...(counted ? { seed: 'counted-seed' } : {}),
      duration,
      motion,
      ...(trigger === undefined ? {} : { trigger }),
    }
    const rawConfig = {
      enabled,
      onError: selectedOnError,
    }
    const annotationOptions = counted
      ? countedInput(
        rawOptions,
        ['mark', 'note', 'placement', 'accessible', 'seed', 'duration', 'motion'],
        'options',
        throwOnRepeat,
      )
      : rawOptions
    const annotationConfig = counted
      ? countedInput(
        rawConfig,
        ['enabled', 'onError'],
        'config',
        throwOnRepeat,
      )
      : rawConfig
    const annotation = useAnnotation(
      target,
      annotationOptions,
      annotationConfig,
    )
    state.annotationRef = annotation
    state.renders += 1

    useLayoutEffect(() => {
      state.annotationRef = annotation
      if (
        annotation.current !== null
        && !state.controllers.includes(annotation.current)
      ) {
        state.controllers.push(annotation.current)
      }
    })

    if (!present) return null
    return (
      <span
        className="target"
        data-target=""
        key={targetKey}
        ref={(node) => {
          target.current = node
          if (node && patchListen) {
            node.addEventListener = function (type, listener, options) {
              if (type === 'hana:error') throw new Error('listen failed')
              return EventTarget.prototype.addEventListener.call(this, type, listener, options)
            }
          }
        }}
        style={{ display: hidden ? 'none' : 'inline-block' }}
      >
        Claim
      </span>
    )
  }

  let root = createRoot(document.querySelector('#root'))

  window.fixture = {
    render(input = {}) {
      state.boundaryError = null
      const props = {
        accessible: input.accessible ?? true,
        counted: input.counted ?? false,
        configMode: input.configMode ?? 'record',
        duration: input.duration ?? 0,
        enabled: input.enabled ?? true,
        hidden: input.hidden ?? false,
        mark: input.mark ?? 'underline',
        note: input.note ?? 'React adapter',
        motion: input.motion ?? 'system',
        patchListen: input.patchListen ?? false,
        present: input.present ?? true,
        targetKey: input.targetKey ?? 'first',
        throwOnRepeat: input.throwOnRepeat ?? false,
        trigger: input.trigger,
      }
      const claim = <Claim {...props} />
      flushSync(() => {
        root.render(
          <Boundary key={input.boundaryKey ?? 'boundary'}>
            {input.strict ? <StrictMode>{claim}</StrictMode> : claim}
          </Boundary>,
        )
      })
      return {
        controller: state.annotationRef?.current ?? null,
        state: state.annotationRef?.current?.state ?? null,
      }
    },
    dispatch(controller, error, generation) {
      const target = document.querySelector('[data-target]')
      target?.dispatchEvent(new CustomEvent('hana:error', {
        bubbles: true,
        detail: { controller, error, generation },
      }))
    },
    unmount() {
      flushSync(() => root.unmount())
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
      loader: 'jsx',
      resolveDir: process.cwd(),
      sourcefile: 'react-fixture.jsx',
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
    () => window.__reactAnnotation.annotationRef?.current?.state === 'visible',
  )
}

test('mounts and shows in layout phase, then updates canonical options without remounting', async ({ page }) => {
  const mounted = await render(page)
  expect(mounted.state).toMatch(/showing|visible/)
  await waitVisible(page)

  const result = await page.evaluate(() => {
    const first = window.__reactAnnotation.annotationRef.current
    window.fixture.render({ mark: 'underline', note: 'React adapter' })
    const sameCanonical = window.__reactAnnotation.annotationRef.current
    window.fixture.render({ mark: 'circle', note: 'Changed' })
    const changed = window.__reactAnnotation.annotationRef.current
    return {
      frozenRef: Object.isFrozen(window.__reactAnnotation.annotationRef),
      readonlyCurrent:
        Object.getOwnPropertyDescriptor(
          window.__reactAnnotation.annotationRef,
          'current',
        )?.set === undefined,
      sameCanonical: first === sameCanonical,
      sameAfterUpdate: first === changed,
      mark: document.querySelector('.hana-annotation')?.getAttribute('data-hana-mark'),
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    }
  })

  expect(result).toEqual({
    frozenRef: true,
    readonlyCurrent: true,
    sameCanonical: true,
    sameAfterUpdate: true,
    mark: 'circle',
    overlays: 1,
  })
})

test('waits for a target, replaces it only after availability, and toggles enabled', async ({ page }) => {
  expect((await render(page, { present: false })).controller).toBeNull()
  expect((await render(page, { present: true })).controller).not.toBeNull()
  await waitVisible(page)

  const result = await page.evaluate(() => {
    const first = window.__reactAnnotation.annotationRef.current
    window.fixture.render({ targetKey: 'second' })
    const second = window.__reactAnnotation.annotationRef.current
    const afterReplace = {
      replaced: first !== second,
      oldState: first.state,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    }
    window.fixture.render({ targetKey: 'second', enabled: false })
    const disabled = {
      current: window.__reactAnnotation.annotationRef.current,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
    }
    window.fixture.render({ targetKey: 'second', enabled: true })
    return {
      afterReplace,
      disabled,
      reenabled: window.__reactAnnotation.annotationRef.current !== null,
    }
  })

  expect(result).toEqual({
    afterReplace: { replaced: true, oldState: 'destroyed', overlays: 1 },
    disabled: { current: null, overlays: 0 },
    reenabled: true,
  })
})

test('is Strict Mode idempotent and does not duplicate overlays or ARIA tokens', async ({ page }) => {
  await render(page, { strict: true, note: 'Strict note' })
  await waitVisible(page)

  const result = await page.evaluate(() => {
    window.fixture.render({ strict: true, note: 'Strict note' })
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
  })

  expect(result).toEqual({
    overlays: 1,
    annotations: 1,
    tokenCount: 1,
    uniqueTokens: 1,
  })
})

test('destroys the mounted controller exactly once on unmount and removes its listener', async ({ page }) => {
  await render(page)
  await waitVisible(page)

  const result = await page.evaluate(() => {
    const controller = window.__reactAnnotation.annotationRef.current
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
      errors: window.__reactAnnotation.errors.length,
      overlays: document.querySelectorAll('[data-hana-overlay]').length,
      token: target.getAttribute('aria-describedby'),
    }
  })

  expect(result).toEqual({
    destroys: 1,
    errors: 0,
    overlays: 0,
    token: null,
  })
})

test('rejects trigger with a typed lifecycle error before creating output', async ({ page }) => {
  await render(page, { trigger: 'viewport' })
  await page.waitForFunction(() => window.__reactAnnotation.boundaryError !== null)

  expect(await page.evaluate(() => ({
    code: window.__reactAnnotation.boundaryError.code,
    field: window.__reactAnnotation.boundaryError.details?.field,
    current: window.__reactAnnotation.annotationRef.current,
    overlays: document.querySelectorAll('[data-hana-overlay]').length,
  }))).toEqual({
    code: 'HANA_CONFIG_INVALID',
    field: 'trigger',
    current: null,
    overlays: 0,
  })
})

test('contains synchronous show construction and update failures for React boundaries', async ({ page }) => {
  await render(page, { patchListen: true })
  await page.waitForFunction(() => window.__reactAnnotation.boundaryError !== null)
  const construction = await page.evaluate(() => ({
    message: window.__reactAnnotation.boundaryError.message,
    overlays: document.querySelectorAll('[data-hana-overlay]').length,
    current: window.__reactAnnotation.annotationRef?.current ?? null,
  }))
  expect(construction).toEqual({
    message: 'listen failed',
    overlays: 0,
    current: null,
  })

  await render(page, { boundaryKey: 'recovered' })
  await waitVisible(page)
  await page.evaluate(() => {
    const controller = window.__reactAnnotation.annotationRef.current
    controller.update = () => {
      throw new Error('update failed')
    }
    window.fixture.render({ boundaryKey: 'recovered', mark: 'circle' })
  })
  await page.waitForFunction(
    () => window.__reactAnnotation.boundaryError?.message === 'update failed',
  )
  expect(await page.evaluate(() => ({
    current: window.__reactAnnotation.annotationRef.current,
    overlays: document.querySelectorAll('[data-hana-overlay]').length,
  }))).toEqual({ current: null, overlays: 0 })
})

test('routes accepted finished plus hana:error once and cleans failed ownership', async ({ page }) => {
  await render(page, { hidden: true })
  await page.waitForFunction(() => window.__reactAnnotation.errors.length === 1)

  const result = await page.evaluate(() => ({
    errors: window.__reactAnnotation.errors.length,
    current: window.__reactAnnotation.annotationRef.current,
    overlays: document.querySelectorAll('[data-hana-overlay]').length,
    token: document.querySelector('[data-target]')?.getAttribute('aria-describedby') ?? null,
  }))
  expect(result).toEqual({
    errors: 1,
    current: null,
    overlays: 0,
    token: null,
  })
})

test('contains a post-visible hana:error and suppresses stale replacement events', async ({ page }) => {
  await render(page)
  await waitVisible(page)

  const stale = await page.evaluate(() => {
    const oldController = window.__reactAnnotation.annotationRef.current
    const oldTarget = document.querySelector('[data-target]')
    window.fixture.render({ targetKey: 'second' })
    oldTarget.dispatchEvent(new CustomEvent('hana:error', {
      detail: { controller: oldController, error: new Error('stale') },
    }))
    return {
      errors: window.__reactAnnotation.errors.length,
      oldState: oldController.state,
    }
  })
  expect(stale).toEqual({ errors: 0, oldState: 'destroyed' })

  await page.evaluate(() => {
    const controller = window.__reactAnnotation.annotationRef.current
    const target = document.querySelector('[data-target]')
    target.style.display = 'none'
    controller.refresh()
  })
  await page.waitForFunction(() => window.__reactAnnotation.errors.length === 1)
  expect(await page.evaluate(() => ({
    current: window.__reactAnnotation.annotationRef.current,
    overlays: document.querySelectorAll('[data-hana-overlay]').length,
  }))).toEqual({ current: null, overlays: 0 })
})

test('ignores a stale pending finished rejection after target replacement', async ({ page }) => {
  const mounted = await render(page)
  expect(mounted.state).toBe('showing')

  const result = await page.evaluate(() => {
    const oldController = window.__reactAnnotation.annotationRef.current
    window.fixture.render({ targetKey: 'second' })
    return {
      currentChanged: oldController !== window.__reactAnnotation.annotationRef.current,
      oldState: oldController.state,
    }
  })
  await waitVisible(page)
  await page.evaluate(() => Promise.resolve())

  expect(result).toEqual({ currentChanged: true, oldState: 'destroyed' })
  expect(await page.evaluate(() => window.__reactAnnotation.errors.length)).toBe(0)
})

test('cleans before a throwing onError callback is surfaced from a microtask', async ({ page }) => {
  const pageError = page.waitForEvent('pageerror')
  await render(page, { configMode: 'throw', hidden: true })
  expect((await pageError).message).toBe('onError callback failed')

  const snapshot = await page.evaluate(
    () => window.__reactAnnotation.callbackSnapshots[0],
  )
  expect(snapshot.current).toBeNull()
  expect(snapshot.overlays).toBe(0)
  expect(snapshot.tokens).toBeNull()
})

test('latches an asynchronously failed request until target, options, or enabled changes', async ({ page }) => {
  const failing = {
    configMode: 'rerender',
    hidden: true,
    mark: 'underline',
    targetKey: 'first',
  }
  await render(page, failing)
  await page.waitForFunction(() => window.__reactAnnotation.errors.length >= 1)
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })

  const snapshot = () => page.evaluate(() => ({
    controllers: window.__reactAnnotation.controllers.length,
    errors: window.__reactAnnotation.errors.length,
    current: window.__reactAnnotation.annotationRef.current,
    overlays: document.querySelectorAll('[data-hana-overlay]').length,
  }))
  expect(await snapshot()).toEqual({
    controllers: 1,
    errors: 1,
    current: null,
    overlays: 0,
  })

  await render(page, failing)
  await render(page, failing)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
  expect(await snapshot()).toEqual({
    controllers: 1,
    errors: 1,
    current: null,
    overlays: 0,
  })

  await render(page, { ...failing, mark: 'circle' })
  await page.waitForFunction(() => window.__reactAnnotation.errors.length === 2)
  expect(await snapshot()).toEqual({
    controllers: 2,
    errors: 2,
    current: null,
    overlays: 0,
  })

  await render(page, { ...failing, mark: 'circle', targetKey: 'second' })
  await page.waitForFunction(() => window.__reactAnnotation.errors.length === 3)
  expect(await snapshot()).toEqual({
    controllers: 3,
    errors: 3,
    current: null,
    overlays: 0,
  })

  await render(page, {
    ...failing,
    enabled: false,
    mark: 'circle',
    targetKey: 'second',
  })
  expect(await snapshot()).toEqual({
    controllers: 3,
    errors: 3,
    current: null,
    overlays: 0,
  })
  await render(page, {
    ...failing,
    enabled: true,
    mark: 'circle',
    targetKey: 'second',
  })
  await page.waitForFunction(() => window.__reactAnnotation.errors.length === 4)
  expect(await snapshot()).toEqual({
    controllers: 4,
    errors: 4,
    current: null,
    overlays: 0,
  })
})

test('uses a fresh onError callback without retrying or remounting the request', async ({ page }) => {
  await render(page, { configMode: 'record' })
  await waitVisible(page)
  const result = await page.evaluate(() => {
    const controller = window.__reactAnnotation.annotationRef.current
    window.fixture.render({ configMode: 'recordSecond' })
    const retained = window.__reactAnnotation.annotationRef.current
    window.fixture.dispatch(controller, new Error('fresh callback'))
    return {
      controllerRetained: controller === retained,
      controllers: window.__reactAnnotation.controllers.length,
    }
  })
  await page.waitForFunction(() => window.__reactAnnotation.secondErrors.length === 1)

  expect(result).toEqual({ controllerRetained: true, controllers: 1 })
  expect(await page.evaluate(() => ({
    current: window.__reactAnnotation.annotationRef.current,
    firstErrors: window.__reactAnnotation.errors.length,
    secondErrors: window.__reactAnnotation.secondErrors.length,
  }))).toEqual({
    current: null,
    firstErrors: 0,
    secondErrors: 1,
  })
})

test('reads accessor options and config once in one committed lifecycle transition', async ({ page }) => {
  const mounted = await render(page, {
    counted: true,
    throwOnRepeat: true,
  })
  expect(mounted.state).toMatch(/showing|visible/)

  expect(await page.evaluate(() => ({
    boundaryError: window.__reactAnnotation.boundaryError?.message ?? null,
    reads: window.__reactAnnotation.getterReads,
  }))).toEqual({
    boundaryError: null,
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
})

test('inherits reduced motion and settles a long system animation synchronously', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const mounted = await render(page, { duration: 900, motion: 'system' })

  expect(mounted.state).toBe('visible')
  expect(await page.evaluate(async () => {
    const controller = window.__reactAnnotation.annotationRef.current
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
      strokeDashoffset: getComputedStyle(path).strokeDashoffset,
    }
  })).toEqual({
    activeAnimations: 0,
    animatingClass: false,
    settlement: 'resolved',
    state: 'visible',
    strokeDashoffset: '0px',
  })
})

test('keeps the same long system animation active without reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const mounted = await render(page, { duration: 900, motion: 'system' })

  expect(mounted.state).toBe('showing')
  expect(await page.evaluate(async () => {
    const controller = window.__reactAnnotation.annotationRef.current
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
