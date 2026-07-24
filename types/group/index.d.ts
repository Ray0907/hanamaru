import type {
  AnnotationOptions,
  AnnotationTarget,
  Motion,
  Trigger,
} from '../index.d.ts'

export type GroupMemberDefinition =
  { target: AnnotationTarget }
  & Omit<AnnotationOptions, 'trigger' | 'motion'>

export interface GroupOptions {
  trigger?: Trigger
  motion?: Motion
}

export interface GroupContext {
  root?: Document
}

export type GroupState =
  | 'idle'
  | 'showing'
  | 'visible'
  | 'hidden'
  | 'suspended'
  | 'destroyed'

export interface GroupController {
  readonly state: GroupState
  readonly finished: Promise<void> | null
  readonly size: number
  show(): GroupController
  hide(): GroupController
  replay(): GroupController
  refresh(): GroupController
  destroy(): GroupController
}

export function group(
  members: readonly GroupMemberDefinition[],
  options?: GroupOptions,
  context?: GroupContext,
): GroupController
