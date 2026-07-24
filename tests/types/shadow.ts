import type {
  AnnotationController,
  ScanResult,
  StoryController,
} from 'hanamaru-annotations'
import type { GroupController } from 'hanamaru-annotations/group'
import type { SerializedAnnotation } from 'hanamaru-annotations/serialize'
import {
  createShadowScope,
  type ShadowScope,
} from 'hanamaru-annotations/shadow'

const root = document.body.attachShadow({ mode: 'open' })
const scope: ShadowScope = createShadowScope(root, {
  styles: { mode: 'auto', nonce: 'test' },
})
const annotation: AnnotationController = scope.annotate('.claim', {
  mark: 'circle',
})
const selected: AnnotationController = scope.annotateSelection({
  mark: 'underline',
}, window.getSelection() ?? undefined)
const scanned: ScanResult = scope.scan()
const walkthrough: StoryController = scope.story([
  { target: '.claim', mark: 'highlight' },
])
const simultaneous: GroupController = scope.group([
  { target: '.claim', mark: 'box' },
])
declare const definition: SerializedAnnotation
const restored: AnnotationController = scope.restore(definition)
const resolved: Element | Range = scope.resolveSerializedTarget(definition.target)
const destroyed: ShadowScope = scope.destroy()

createShadowScope(root, {
  styles: { mode: 'sheet', sheet: new CSSStyleSheet() },
})
createShadowScope(root, { styles: { mode: 'preinstalled' } })

// @ts-expect-error createShadowScope requires a native ShadowRoot
createShadowScope(document)
// @ts-expect-error scoped Group does not accept a standalone Document context
scope.group([{ target: '.claim', mark: 'circle' }], {}, { root: document })
// @ts-expect-error style modes are a closed union
createShadowScope(root, { styles: { mode: 'inline' } })

void annotation
void selected
void scanned
void walkthrough
void simultaneous
void restored
void resolved
void destroyed
