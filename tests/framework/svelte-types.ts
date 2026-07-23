import type { Action } from 'svelte/action'
import type { AnnotationController } from 'hanamaru-annotations'
import {
  annotation,
  type SvelteAnnotationInput,
} from 'hanamaru-annotations/svelte'

const input: SvelteAnnotationInput = {
  mark: 'highlight',
  note: 'Typed',
  duration: 0,
  motion: 'never',
  enabled: true,
  onError(error, controller) {
    error satisfies unknown
    controller satisfies AnnotationController
  },
  onController(controller) {
    controller satisfies AnnotationController | null
  },
}

annotation satisfies Action<Element, SvelteAnnotationInput>

const action = annotation(document.createElement('span'), input)
action.update({ ...input, mark: 'circle' })
action.destroy()

annotation(document.createElementNS('http://www.w3.org/2000/svg', 'text'), {
  mark: 'box',
})

annotation(document.createElement('span'), {
  mark: 'box',
  // @ts-expect-error Adapters always own a manual annotation.
  trigger: 'viewport',
})

annotation(document.createElement('span'), {
  mark: 'underline',
  // @ts-expect-error enabled must be boolean.
  enabled: 'yes',
})

// @ts-expect-error Actions require a DOM Element.
annotation(42, { mark: 'underline' })
