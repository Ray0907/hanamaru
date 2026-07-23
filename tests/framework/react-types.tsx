import { useRef } from 'react'
import type { AnnotationController } from 'hanamaru-annotations'
import {
  useAnnotation,
  type ReactAnnotationConfig,
  type ReactAnnotationOptions,
} from 'hanamaru-annotations/react'

function Example() {
  const target = useRef<HTMLSpanElement>(null)
  const options: ReactAnnotationOptions = {
    mark: 'underline',
    note: 'Typed',
    duration: 0,
    motion: 'never',
  }
  const config: ReactAnnotationConfig = {
    enabled: true,
    onError(error, controller) {
      error satisfies unknown
      controller satisfies AnnotationController
    },
  }
  const controller = useAnnotation(target, options, config)
  controller.current?.refresh()

  // @ts-expect-error The exposed controller ref is read-only.
  controller.current = null

  return <span ref={target}>Claim</span>
}

function TriggerIsNotAnAdapterOption() {
  const target = useRef<HTMLSpanElement>(null)
  useAnnotation(target, {
    mark: 'box',
    // @ts-expect-error Adapters always own a manual annotation.
    trigger: 'viewport',
  })
  return <span ref={target}>Claim</span>
}

void Example
void TriggerIsNotAnAdapterOption
