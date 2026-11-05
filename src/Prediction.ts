import type { Point } from './core/stroke'

/** At most this many of the browser's predicted points are drawn after a stroke's tip */
export const MAX_PREDICTED_POINTS = 2

/** Predicted points are kept within this distance of the last real point, in CSS px */
export const MAX_PREDICTED_PX = 24

/** How many of the browser's 1st and 2nd predicted points were kept and dropped by the limit */
export type PredictionCounts = { kept: [number, number]; dropped: [number, number] }

/** The development tools' state of a Prediction (debug.ts): the switch for the latency comparison, and the counts */
export type PredictionDebug = { on: boolean; counts: PredictionCounts }

/** What is drawn after the recorded points of one stroke being drawn, and the array `get` returns for it */
type Tip = { pending: Point | null; predicted: Point[]; points: Point[] }

/**
 * The points drawn after the tip of each stroke being drawn that are not in the store, so they are never sent or kept:
 * the latest input DrawController has not recorded yet (the pending point), then the points the browser predicts
 * after the input (PointerEvent.getPredictedEvents). DrawController replaces both on every pointermove, and
 * StrokeScene draws them after the stroke's tail only
 */
export class Prediction {
  private tips = new Map<string, Tip>()
  private listeners = new Set<() => void>()
  /** Only in a build with __HANDWRITING_DEBUG__; null in the package */
  readonly debug: PredictionDebug | null = __HANDWRITING_DEBUG__
    ? { on: true, counts: { kept: [0, 0], dropped: [0, 0] } }
    : null

  /** The pending point, then the predicted points, after stroke `id`'s tip; a new array whenever either changes */
  get(id: string): Point[] | undefined {
    return this.tips.get(id)?.points
  }

  /**
   * Replaces the predicted points of stroke `id`; none drops them. While the debug switch is off it only drops them.
   * The pending point stays
   */
  set(id: string, points: Point[]): void {
    const predicted = this.debug?.on !== false ? points : []
    const tip = this.tips.get(id)
    if (predicted.length === 0 && !tip?.predicted.length) return
    this.update(id, tip?.pending ?? null, predicted)
  }

  /** Replaces the pending point of stroke `id`, the latest input not recorded yet; null drops it */
  setPending(id: string, point: Point | null): void {
    const tip = this.tips.get(id)
    const pending = tip?.pending ?? null
    if (point === pending || (point && pending && point[0] === pending[0] && point[1] === pending[1])) return
    this.update(id, point, tip?.predicted ?? [])
  }

  /** Drops the predicted points of every stroke; their pending points stay */
  clear(): void {
    for (const id of [...this.tips.keys()]) this.set(id, [])
  }

  /** Strokes holding a pending point or predicted points now */
  get size(): number {
    return this.tips.size
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(id: string, pending: Point | null, predicted: Point[]): void {
    if (pending === null && predicted.length === 0) this.tips.delete(id)
    else this.tips.set(id, { pending, predicted, points: pending ? [pending, ...predicted] : predicted })
    for (const listener of [...this.listeners]) listener()
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
