import { createRef } from 'react'
import { ref, type ShallowRef } from 'vue'
import type { AnnotationController } from 'hanamaru-annotations'
import { useAnnotation as useReactAnnotation } from 'hanamaru-annotations/react'
import { annotation as svelteAnnotation } from 'hanamaru-annotations/svelte'
import { useAnnotation as useVueAnnotation } from 'hanamaru-annotations/vue'

const reactTarget = createRef<HTMLSpanElement>()
const reactController = useReactAnnotation(reactTarget, {
  mark: 'underline',
  note: 'React',
})
const reactCurrent: AnnotationController | null = reactController.current
const reactElement = <span ref={reactTarget}>Claim</span>

const vueTarget = ref<HTMLSpanElement>()
const vueController: ShallowRef<AnnotationController | null> =
  useVueAnnotation(vueTarget, ref({ mark: 'circle' }), ref({ enabled: true }))

const node = document.createElement('span')
const svelteController = svelteAnnotation(node, {
  mark: 'highlight',
  enabled: true,
  onController(controller) {
    const current: AnnotationController | null = controller
    void current
  },
})
svelteController.update({ mark: 'box', enabled: false })
svelteController.destroy()

// @ts-expect-error adapters own manual triggering and omit trigger
useReactAnnotation(reactTarget, { mark: 'underline', trigger: 'load' })
// @ts-expect-error Vue target refs must contain Elements
useVueAnnotation(ref(17), { mark: 'circle' })
// @ts-expect-error Svelte action options require a mark
svelteAnnotation(node, { enabled: true })

void reactCurrent
void reactElement
void vueController
