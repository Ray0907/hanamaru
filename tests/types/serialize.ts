import type {
  AnnotationController,
  StoryController,
} from 'hanamaru-annotations'
import type { GroupController } from 'hanamaru-annotations/group'
import {
  resolveSerializedTarget,
  restore,
  serialize,
  type SerializedAnnotation,
  type SerializedDefinition,
  type SerializedGroup,
  type SerializedStory,
  type SerializedTarget,
} from 'hanamaru-annotations/serialize'

declare const annotation: AnnotationController
declare const walkthrough: StoryController
declare const simultaneous: GroupController

const annotationWire: SerializedAnnotation = serialize(annotation)
const storyWire: SerializedStory = serialize(walkthrough, {
  keyForTarget(target, context) {
    const targetKind: Element | Range = target
    const owner: Element = context.ownerElement
    const targetToken = targetKind instanceof Element
      ? targetKind.nodeType
      : targetKind.startOffset
    return `${context.controllerKind}:${context.role}:${context.index ?? 'root'}:${owner.id}:${targetToken}`
  },
})
const groupWire: SerializedGroup = serialize(simultaneous)
const restoredAnnotation: AnnotationController = restore(annotationWire)
const restoredStory: StoryController = restore(storyWire)
const restoredGroup: GroupController = restore(groupWire)

const target: SerializedTarget = {
  type: 'locator',
  within: { type: 'key', key: 'proof', targetKind: 'element' },
  text: 'exact phrase',
  occurrence: 0,
}
const resolved: Element | Range = resolveSerializedTarget(target, {
  root: document,
  resolveTarget(key, context) {
    const exactKind: 'element' | 'range' = context.targetKind
    const exactRole: 'target' | 'within' = context.role
    const exactController: 'annotation' | 'story' | 'group' | null =
      context.controllerKind
    const exactIndex: number | null = context.index
    void exactKind
    void exactRole
    void exactController
    void exactIndex
    return document.querySelector(`[data-key="${key}"]`)!
  },
})

function narrow(definition: SerializedDefinition): string {
  if (definition.kind === 'annotation') return definition.target.type
  if (definition.kind === 'story') return String(definition.steps.length)
  return String(definition.members.length)
}

// @ts-expect-error serialized schema is versioned and literal
const wrongSchema: SerializedAnnotation = { ...annotationWire, schema: 'hanamaru/v2' }
const wrongWithin: SerializedTarget = {
  type: 'locator',
  // @ts-expect-error locator within keys must resolve to elements
  within: { type: 'key', key: 'proof', targetKind: 'range' },
  text: 'exact phrase',
}
resolveSerializedTarget({ type: 'key', key: 'claim', targetKind: 'element' }, {
  // @ts-expect-error resolver results are native Elements or Ranges
  resolveTarget: () => '#claim',
})

void storyWire
void groupWire
void restoredAnnotation
void restoredStory
void restoredGroup
void resolved
void narrow
void wrongSchema
void wrongWithin
