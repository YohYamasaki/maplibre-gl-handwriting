import type { Point } from './core/stroke'

/** At most this many of the browser's predicted points are drawn after a stroke's tip */
export const MAX_PREDICTED_POINTS = 2

/** Predicted points are kept within this distance of the last real point, in CSS px */
export const MAX_PREDICTED_PX = 24

/**
 * The points the browser predicts after the real input of each stroke being drawn (PointerEvent.getPredictedEvents).
 * They are never applied to the store, so they are never sent or kept: DrawController sets them on every
 * pointermove, replacing the previous ones, and StrokeScene draws them after the stroke's tail only
 */
/** How many of the browser's 1st and 2nd predicted points were kept and dropped by the limit */
export type PredictionCounts = { kept: [number, number]; dropped: [number, number] }

/** The development tools' state of a Prediction (debug.ts): the switch for the latency comparison, and the counts */
export type PredictionDebug = { on: boolean; counts: PredictionCounts }

export class Prediction {
  private byStroke = new Map<string, Point[]>()
  private listeners = new Set<() => void>()
  /** Only in a build with __HANDWRITING_DEBUG__; null in the package */
  readonly debug: PredictionDebug | null = __HANDWRITING_DEBUG__
    ? { on: true, counts: { kept: [0, 0], dropped: [0, 0] } }
    : null

  /** The predicted points after stroke `id`'s tip; a new array whenever they change */
  get(id: string): Point[] | undefined {
    return this.byStroke.get(id)
  }

  /** Replaces the predicted points of stroke `id`; none drops them */
  set(id: string, points: Point[]): void {
    const next = this.debug?.on !== false && points.length > 0 ? points : undefined
    if (next === undefined && !this.byStroke.has(id)) return
    if (next) this.byStroke.set(id, next)
    else this.byStroke.delete(id)
    for (const listener of [...this.listeners]) listener()
  }

  /** Drops the predicted points of every stroke */
  clear(): void {
    for (const id of [...this.byStroke.keys()]) this.set(id, [])
  }

  /** Strokes holding predicted points now */
  get size(): number {
    return this.byStroke.size
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/** Predicted points are dropped when no pointermove comes for this long, in ms */
export const PREDICTION_TIMEOUT_MS = 32

/**
 * The client positions of the predicted events to draw after the real position `from`: at most MAX_PREDICTED_POINTS.
 * A point farther from `from` than `limit` (capped at MAX_PREDICTED_PX) is dropped with every point after it.
 * `limit` is how far the pointer moved since the previous pointermove
 */
export function predictedPositions(
  from: [number, number],
  events: readonly { clientX: number; clientY: number }[],
  limit: number,
): [number, number][] {
  const max = Math.min(limit, MAX_PREDICTED_PX)
  const positions: [number, number][] = []
  for (const e of events.slice(0, MAX_PREDICTED_POINTS)) {
    const distance = Math.hypot(e.clientX - from[0], e.clientY - from[1])
    if (!(distance <= max)) break
    positions.push([e.clientX, e.clientY])
  }
  return positions
}
