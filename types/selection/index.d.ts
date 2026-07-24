import type {
  AnnotationController,
  AnnotationOptions,
} from '../index.d.ts'

export function annotateSelection(
  options: AnnotationOptions,
  selection?: Selection,
): AnnotationController
