import type {
  AnnotationController,
  MarkName,
  Motion,
  Placement,
  Seed,
  StoryController,
  Trigger,
} from '../index.d.ts'
import type {
  GroupController,
} from '../group/index.d.ts'

export interface SerializedSelectorTarget {
  type: 'selector'
  selector: string
}

export interface SerializedElementKeyTarget {
  type: 'key'
  key: string
  targetKind: 'element'
}

export interface SerializedRangeKeyTarget {
  type: 'key'
  key: string
  targetKind: 'range'
}

export type SerializedKeyTarget =
  | SerializedElementKeyTarget
  | SerializedRangeKeyTarget

export interface SerializedLocatorTarget {
  type: 'locator'
  within: SerializedSelectorTarget | SerializedElementKeyTarget
  text: string
  occurrence?: number
}

export type SerializedTarget =
  | SerializedSelectorTarget
  | SerializedKeyTarget
  | SerializedLocatorTarget

export interface SerializedAnnotationOptions {
  mark: MarkName
  note: string | null
  placement: Placement
  trigger: Trigger
  accessible: boolean
  seed: Seed
  duration: number
  motion: Motion
}

export interface SerializedMemberOptions {
  mark: MarkName
  note: string | null
  placement: Placement
  accessible: boolean
  seed: Seed
  duration: number
}

export type SerializedStoryOptions =
  | {
      trigger: 'manual' | 'load'
      gap: number
      motion: Motion
      once?: never
    }
  | {
      trigger: 'viewport'
      gap: number
      motion: Motion
      once: boolean
    }

export interface SerializedGroupOptions {
  trigger: Trigger
  motion: Motion
}

export interface SerializedMember {
  target: SerializedTarget
  options: SerializedMemberOptions
}

export interface SerializedAnnotation {
  schema: 'hanamaru/v1'
  kind: 'annotation'
  target: SerializedTarget
  options: SerializedAnnotationOptions
}

export interface SerializedStory {
  schema: 'hanamaru/v1'
  kind: 'story'
  options: SerializedStoryOptions
  steps: SerializedMember[]
}

export interface SerializedGroup {
  schema: 'hanamaru/v1'
  kind: 'group'
  options: SerializedGroupOptions
  members: SerializedMember[]
}

export type SerializedDefinition =
  | SerializedAnnotation
  | SerializedStory
  | SerializedGroup

export interface SerializationTargetContext {
  role: 'target' | 'within'
  controllerKind: 'annotation' | 'story' | 'group'
  ownerElement: Element
  index: number | null
}

export interface SerializeOptions {
  keyForTarget?: (
    target: Element | Range,
    context: SerializationTargetContext,
  ) => string
}

export interface SerializedResolverContext {
  targetKind: 'element' | 'range'
  role: 'target' | 'within'
  controllerKind: 'annotation' | 'story' | 'group' | null
  index: number | null
}

export type SerializedTargetResolver = (
  key: string,
  context: SerializedResolverContext,
) => Element | Range

export interface RestoreContext {
  root?: Document
  resolveTarget?: SerializedTargetResolver
}

export interface ResolveSerializedTargetContext {
  root?: Document
  resolveTarget?: SerializedTargetResolver
}

export function serialize(
  controller: AnnotationController,
  options?: SerializeOptions,
): SerializedAnnotation
export function serialize(
  controller: StoryController,
  options?: SerializeOptions,
): SerializedStory
export function serialize(
  controller: GroupController,
  options?: SerializeOptions,
): SerializedGroup
export function serialize(
  controller: AnnotationController | StoryController | GroupController,
  options?: SerializeOptions,
): SerializedDefinition

export function restore(
  definition: SerializedAnnotation,
  context?: RestoreContext,
): AnnotationController
export function restore(
  definition: SerializedStory,
  context?: RestoreContext,
): StoryController
export function restore(
  definition: SerializedGroup,
  context?: RestoreContext,
): GroupController
export function restore(
  definition: SerializedDefinition,
  context?: RestoreContext,
): AnnotationController | StoryController | GroupController

export function resolveSerializedTarget(
  target: SerializedTarget,
  context?: ResolveSerializedTargetContext,
): Element | Range
