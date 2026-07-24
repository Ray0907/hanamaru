import { annotate, type MarkName } from 'hanamaru-annotations'
import {
  registerMark,
  type MarkFactoryInput,
} from 'hanamaru-annotations/plugins'

declare module 'hanamaru-annotations' {
  interface HanamaruMarkMap {
    'double-underline': true
  }
}

const customName: MarkName = 'double-underline'
const unregister = registerMark(customName, ({ rects, seed, padding, helpers }) => ({
  paths: [
    helpers.line(
      { x: rects[0].left, y: rects[0].bottom + padding },
      { x: rects[0].right, y: rects[0].bottom + padding },
      { label: String(seed), wobble: helpers.jitter('wobble', 1) },
    ),
    helpers.closedPath([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ]),
  ],
}))
const factoryInput = null as unknown as MarkFactoryInput
annotate('#claim', { mark: customName })
unregister()

// @ts-expect-error unaugmented names cannot be registered
registerMark('paint-splash', () => ({ paths: ['M 0 0'] }))
// @ts-expect-error paths must be strings
registerMark('double-underline', () => ({ paths: [42] }))

void factoryInput
