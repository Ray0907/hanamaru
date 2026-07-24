export interface HanamaruMarkMap {
  underline: true
  highlight: true
  circle: true
  box: true
  strike: true
  bracket: true
}

export type MarkName = Extract<keyof HanamaruMarkMap, string>
export type Placement = 'auto' | 'top' | 'right' | 'bottom' | 'left'
export type Trigger = 'manual' | 'load' | 'viewport'
export type Motion = 'system' | 'never'
export type Seed = string | number

export interface TextTarget {
  within: string | Element
  text: string
  occurrence?: number
}

export type AnnotationTarget = string | Element | Range | TextTarget

export interface AnnotationOptions {
  mark: MarkName
  note?: string | null
  placement?: Placement
  trigger?: Trigger
  accessible?: boolean
  seed?: Seed
  duration?: number
  motion?: Motion
}

export type AnnotationUpdate =
  Partial<AnnotationOptions> & { target?: AnnotationTarget }

export type AnnotationState =
  | 'idle'
  | 'showing'
  | 'visible'
  | 'hidden'
  | 'suspended'
  | 'destroyed'

export interface AnnotationController {
  readonly state: AnnotationState
  readonly finished: Promise<void> | null
  show(): AnnotationController
  hide(): AnnotationController
  replay(): AnnotationController
  refresh(): AnnotationController
  update(patch?: AnnotationUpdate | null): AnnotationController
  destroy(): AnnotationController
}

export type StoryStepDefinition =
  { target: AnnotationTarget }
  & Omit<AnnotationOptions, 'trigger' | 'motion'>

export type StoryOptions =
  | {
      trigger?: 'manual' | 'load'
      gap?: number
      motion?: Motion
      once?: never
    }
  | {
      trigger: 'viewport'
      gap?: number
      motion?: Motion
      once?: boolean
    }

export type StoryState =
  | 'idle'
  | 'playing'
  | 'paused'
  | 'complete'
  | 'cancelled'
  | 'destroyed'

export interface StoryController {
  readonly state: StoryState
  readonly finished: Promise<void> | null
  play(): StoryController
  pause(): StoryController
  resume(): StoryController
  cancel(): StoryController
  replay(): StoryController
  destroy(): StoryController
}

export interface ScanResult {
  annotations: AnnotationController[]
  errors: HanamaruError[]
}

export class HanamaruError extends Error {
  readonly code: string
  readonly details?: unknown
  constructor(code: string, message: string, details?: unknown)
}

export class HanamaruTargetError extends HanamaruError {}
export class HanamaruConfigError extends HanamaruError {}
export class HanamaruStateError extends HanamaruError {}

export const VERSION: '0.1.0'

export function annotate(
  target: AnnotationTarget,
  options: AnnotationOptions,
): AnnotationController

export function story(
  steps: readonly StoryStepDefinition[],
  options?: StoryOptions,
): StoryController

export function scan(root?: Document | Element): ScanResult
