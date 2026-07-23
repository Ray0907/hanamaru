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
    errors: [],
    renders: 0,
  }

  const errorHandlers = {
    record(error, controller) {
      state.errors.push({ error, controller })
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
    configMode,
    enabled,
    hidden,
    mark,
    note,
    patchListen,
    present,
    targetKey,
    trigger,
  }) {
    const target = useRef(null)
    const annotation = useAnnotation(
      target,
      {
        mark,
        note,
        accessible,
        duration: 0,
        motion: 'system',
        ...(trigger === undefined ? {} : { trigger }),
      },
      {
        enabled,
        onError: configMode === 'none' ? undefined : errorHandlers[configMode],
      },
    )
    state.annotationRef = annotation
    state.renders += 1

    useLayoutEffect(() => {
      state.annotationRef = annotation
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
        configMode: input.configMode ?? 'record',
        enabled: input.enabled ?? true,
        hidden: input.hidden ?? false,
        mark: input.mark ?? 'underline',
        note: input.note ?? 'React adapter',
        patchListen: input.patchListen ?? false,
        present: input.present ?? true,
        targetKey: input.targetKey ?? 'first',
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

test('inherits reduced motion and reaches visible without an animation delay', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const started = Date.now()
  await render(page)
  await waitVisible(page)
  expect(Date.now() - started).toBeLessThan(500)
})
