import type {
  AnnotationController,
  AnnotationOptions,
} from 'hanamaru-annotations'
import type { RefObject } from 'react'

export type ReactAnnotationOptions = Omit<AnnotationOptions, 'trigger'>

export interface ReactAnnotationConfig {
  enabled?: boolean
  onError?: (
    error: unknown,
    controller: AnnotationController,
  ) => void
}

export function useAnnotation<T extends Element>(
  target: RefObject<T | null>,
  options: ReactAnnotationOptions,
  config?: ReactAnnotationConfig,
): Readonly<RefObject<AnnotationController | null>>
