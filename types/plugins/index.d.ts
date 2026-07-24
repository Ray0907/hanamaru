import type {
  MarkName,
  Seed,
} from '../index.d.ts'

export interface Point {
  readonly x: number
  readonly y: number
}

export interface MarkRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

export interface MarkPathOptions {
  readonly label?: string
  readonly wobble?: number
}

export interface MarkHelpers {
  jitter(label: string, amplitude: number): number
  line(
    start: Point,
    end: Point,
    options?: MarkPathOptions,
  ): string
  closedPath(
    points: readonly Point[],
    options?: MarkPathOptions,
  ): string
}

export interface MarkFactoryInput {
  readonly rects: readonly Readonly<MarkRect>[]
  readonly unionRect: Readonly<MarkRect>
  readonly seed: Seed
  readonly padding: number
  readonly helpers: Readonly<MarkHelpers>
}

export interface MarkFactoryResult {
  readonly paths: readonly string[]
}

export type MarkFactory = (
  input: Readonly<MarkFactoryInput>,
) => MarkFactoryResult

export function registerMark<Name extends MarkName>(
  name: Name,
  factory: MarkFactory,
): () => void
