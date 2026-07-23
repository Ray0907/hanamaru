import type {
  AnnotationController,
  AnnotationOptions,
} from 'hanamaru-annotations'

export type SvelteAnnotationOptions = Omit<AnnotationOptions, 'trigger'>

export interface SvelteAnnotationConfig {
  enabled?: boolean
  onError?: (
    error: unknown,
    controller: AnnotationController,
  ) => void
  onController?: (
    controller: AnnotationController | null,
  ) => void
}

export type SvelteAnnotationInput =
  SvelteAnnotationOptions & SvelteAnnotationConfig

export interface SvelteAnnotationAction {
  update(nextInput: SvelteAnnotationInput): void
  destroy(): void
}

export function annotation<T extends Element>(
  node: T,
  input: SvelteAnnotationInput,
): SvelteAnnotationAction
