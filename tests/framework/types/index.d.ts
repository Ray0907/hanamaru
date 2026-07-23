export type AnnotationMark =
  | 'underline'
  | 'highlight'
  | 'circle'
  | 'box'
  | 'strike'
  | 'bracket'

export interface AnnotationOptions {
  mark: AnnotationMark
  note?: string | null
  placement?: 'auto' | 'top' | 'right' | 'bottom' | 'left'
  trigger?: 'manual' | 'load' | 'viewport'
  accessible?: boolean
  seed?: string | number
  duration?: number
  motion?: 'system' | 'never'
}

export interface AnnotationController {
  readonly state:
    | 'idle'
    | 'showing'
    | 'visible'
    | 'hidden'
    | 'suspended'
    | 'destroyed'
  readonly finished: Promise<void> | null
  show(): this
  hide(): this
  replay(): this
  refresh(): this
  update(options: Partial<AnnotationOptions> & { target?: unknown }): this
  destroy(): this
}

export function annotate(
  target: Element | Range | string,
  options: AnnotationOptions,
): AnnotationController
