import type {
  AnnotationController,
  AnnotationOptions,
} from 'hanamaru-annotations'
import type {
  Ref,
  ShallowRef,
} from 'vue'

export type VueAnnotationOptions = Omit<AnnotationOptions, 'trigger'>

export interface VueAnnotationConfig {
  enabled?: boolean
  onError?: (
    error: unknown,
    controller: AnnotationController,
  ) => void
}

export type VueMaybeRef<T> = T | Ref<T>

export function useAnnotation<T extends Element>(
  target: Ref<T | null | undefined>,
  options: VueMaybeRef<VueAnnotationOptions>,
  config?: VueMaybeRef<VueAnnotationConfig>,
): ShallowRef<AnnotationController | null>
