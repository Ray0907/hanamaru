import type {
  AnnotationController,
  AnnotationOptions,
  AnnotationTarget,
  ScanResult,
  StoryController,
  StoryOptions,
  StoryStepDefinition,
} from '../index.d.ts'
import type {
  GroupController,
  GroupMemberDefinition,
  GroupOptions,
} from '../group/index.d.ts'
import type {
  ResolveSerializedTargetContext,
  RestoreContext,
  SerializedAnnotation,
  SerializedDefinition,
  SerializedGroup,
  SerializedStory,
  SerializedTarget,
} from '../serialize/index.d.ts'

export type ShadowStyles =
  | { mode?: 'auto'; nonce?: string }
  | { mode: 'sheet'; sheet: CSSStyleSheet }
  | { mode: 'preinstalled' }

export interface ShadowScopeOptions {
  styles?: ShadowStyles
}

export type ShadowRestoreContext = Omit<RestoreContext, 'root'>
export type ShadowResolveSerializedTargetContext =
  Omit<ResolveSerializedTargetContext, 'root'>

export interface ShadowScope {
  annotate(
    target: AnnotationTarget,
    options: AnnotationOptions,
  ): AnnotationController
  annotateSelection(
    options: AnnotationOptions,
    selection?: Selection,
  ): AnnotationController
  scan(): ScanResult
  story(
    steps: readonly StoryStepDefinition[],
    options?: StoryOptions,
  ): StoryController
  group(
    members: readonly GroupMemberDefinition[],
    options?: GroupOptions,
  ): GroupController
  restore(
    definition: SerializedAnnotation,
    context?: ShadowRestoreContext,
  ): AnnotationController
  restore(
    definition: SerializedStory,
    context?: ShadowRestoreContext,
  ): StoryController
  restore(
    definition: SerializedGroup,
    context?: ShadowRestoreContext,
  ): GroupController
  restore(
    definition: SerializedDefinition,
    context?: ShadowRestoreContext,
  ): AnnotationController | StoryController | GroupController
  resolveSerializedTarget(
    target: SerializedTarget,
    context?: ShadowResolveSerializedTargetContext,
  ): Element | Range
  destroy(): ShadowScope
}

export function createShadowScope(
  root: ShadowRoot,
  options?: ShadowScopeOptions,
): ShadowScope
