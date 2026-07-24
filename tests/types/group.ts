import type { AnnotationTarget } from 'hanamaru-annotations'
import {
  group,
  type GroupController,
  type GroupState,
} from 'hanamaru-annotations/group'

const target: AnnotationTarget = { within: '#proof', text: 'exact phrase' }
const controller = group([
  { target, mark: 'underline', note: 'Parallel' },
  { target: '#result', mark: 'circle', accessible: true },
], { trigger: 'load', motion: 'never' }, { root: document })
const chain: GroupController = controller
  .show()
  .hide()
  .replay()
  .refresh()
  .destroy()
const state: GroupState = controller.state
const size: number = controller.size

// @ts-expect-error Group members cannot own trigger
group([{ target: '#claim', mark: 'box', trigger: 'load' }])
// @ts-expect-error Group members cannot own motion
group([{ target: '#claim', mark: 'box', motion: 'never' }])
// @ts-expect-error Group context accepts a Document, not a ShadowRoot
group([{ target: '#claim', mark: 'box' }], {}, { root: document.body.attachShadow({ mode: 'open' }) })
// @ts-expect-error Group state is a closed union
const invalidState: GroupState = 'paused'

void chain
void state
void size
void invalidState
