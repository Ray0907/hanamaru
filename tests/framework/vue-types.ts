import { ref, shallowRef } from 'vue'
import type { AnnotationController } from 'hanamaru-annotations'
import {
  useAnnotation,
  type VueAnnotationConfig,
  type VueAnnotationOptions,
} from 'hanamaru-annotations/vue'

const target = ref<HTMLSpanElement | null>(null)
const options = ref<VueAnnotationOptions>({
  mark: 'circle',
  note: 'Typed',
  duration: 0,
  motion: 'never',
})
const config = shallowRef<VueAnnotationConfig>({
  enabled: true,
  onError(error, controller) {
    error satisfies unknown
    controller satisfies AnnotationController
  },
})
const controller = useAnnotation(target, options, config)
controller.value?.refresh()
controller satisfies ReturnType<typeof shallowRef<AnnotationController | null>>

useAnnotation(target, {
  mark: 'box',
  // @ts-expect-error Adapters always own a manual annotation.
  trigger: 'viewport',
})

// @ts-expect-error The target ref must resolve to a DOM Element.
useAnnotation(ref(42), { mark: 'underline' })
