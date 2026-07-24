import {
  HanamaruConfigError,
  HanamaruError,
  HanamaruStateError,
  HanamaruTargetError,
  VERSION,
  annotate,
  scan,
  story,
  type AnnotationController,
  type AnnotationState,
  type MarkName,
  type StoryController,
} from 'hanamaru-annotations'

const annotation = annotate('#claim', {
  mark: 'underline',
  note: 'Typed note',
  placement: 'auto',
  trigger: 'manual',
  accessible: true,
  seed: 17,
  duration: 0,
  motion: 'never',
})
const annotationState: AnnotationState = annotation.state
const annotationFinished: Promise<void> | null = annotation.finished
const annotationChain: AnnotationController = annotation
  .show()
  .refresh()
  .update({ mark: 'circle', target: document.body })
  .hide()
  .replay()
  .destroy()

const walkthrough = story([
  { target: '#claim', mark: 'highlight' },
], { trigger: 'viewport', once: false, gap: 100, motion: 'system' })
const storyChain: StoryController = walkthrough
  .play()
  .pause()
  .resume()
  .cancel()
  .replay()
  .destroy()

const scanned = scan(document)
const firstAnnotation: AnnotationController | undefined = scanned.annotations[0]
const firstError: HanamaruError | undefined = scanned.errors[0]
const builtInMark: MarkName = 'bracket'
const version: string = VERSION
const errors: readonly HanamaruError[] = [
  new HanamaruError('HANA_TEST', 'test'),
  new HanamaruConfigError('HANA_TEST', 'test', {}),
  new HanamaruTargetError('HANA_TEST', 'test'),
  new HanamaruStateError('HANA_TEST', 'test'),
]

// @ts-expect-error annotation state is a closed string-literal union
const impossibleState: AnnotationState = 'playing'
// @ts-expect-error mark names are literal and augmentable, not arbitrary strings
annotate('#claim', { mark: 'scribble' })
// @ts-expect-error placement is a closed enum
annotate('#claim', { mark: 'box', placement: 'center' })
// @ts-expect-error story members cannot own trigger
story([{ target: '#claim', mark: 'box', trigger: 'manual' }])
// @ts-expect-error once is only valid for viewport stories
story([{ target: '#claim', mark: 'box' }], { trigger: 'manual', once: true })
// @ts-expect-error controllers are distinct contracts
const wrongController: StoryController = annotation

void annotationState
void annotationFinished
void annotationChain
void storyChain
void firstAnnotation
void firstError
void builtInMark
void version
void errors
void impossibleState
void wrongController
