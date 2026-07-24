import type { AnnotationController } from 'hanamaru-annotations'
import { annotateSelection } from 'hanamaru-annotations/selection'

const selection = window.getSelection() ?? undefined
const controller: AnnotationController = annotateSelection(
  { mark: 'circle', note: 'Review this' },
  selection,
)

// @ts-expect-error selection options require a mark
annotateSelection({ note: 'Missing mark' })
// @ts-expect-error the optional second argument is a native Selection
annotateSelection({ mark: 'circle' }, document.createRange())

void controller
