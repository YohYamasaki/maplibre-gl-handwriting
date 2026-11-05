import type { Point } from './core/stroke'

/** How far ahead of a pointermove its predicted points are drawn by default, in ms (decision 0020) */
export const DEFAULT_PREDICTION_MS = 20

/** The largest time ahead a handle takes (ExperimentalFeatures.predictionMs), in ms: Chrome predicts no further */
export const MAX_PREDICTION_MS = 25

/** Predicted points are kept within this distance of the last real point, in CSS px */
export const MAX_PREDICTED_PX = 24

/**
 * The browser's predicted points so far: how many it offered, and how many of them were drawn, dropped for being more
 * than the time ahead after their pointermove and dropped for being farther than the distance limit. A point after a
 * dropped one is counted with the same reason, and every point while the time ahead is 0 as dropped by time
 */
export type PredictionCounts = { offered: number; kept: number; droppedByTime: number; droppedByDistance: number }

/**
 * The development tools' state of a Prediction (debug.ts): the counts, and the time from the latest pointermove to
 * each of its predicted points, in ms
 */
export type PredictionDebug = { counts: PredictionCounts; aheadMs: number[] }

/** Why the first of a pointermove's predicted points that is not drawn was dropped */
export type DropReason = 'time' | 'distance'

/** What is drawn after the recorded points of one stroke being drawn, and the array `get` returns for it */
type Tip = { pending: Point | null; predicted: Point[]; points: Point[] }

/**
 * The points drawn after the tip of each stroke being drawn that are not in the store, so they are never sent or kept:
 * the latest input DrawController has not recorded yet (the pending point), then the points the browser predicts
 * after the input (PointerEvent.getPredictedEvents) up to `ms` ahead. DrawController replaces both on every
 * pointermove, and StrokeScene draws them after the stroke's tail only
 */
export class Prediction {
  private tips = new Map<string, Tip>()
  private listeners = new Set<() => void>()
  /** Only in a build with __HANDWRITING_DEBUG__; null in the package */
  readonly debug: PredictionDebug | null = __HANDWRITING_DEBUG__
    ? { counts: { offered: 0, kept: 0, droppedByTime: 0, droppedByDistance: 0 }, aheadMs: [] }
    : null

  /**
   * @param ms How far ahead of a pointermove its predicted points are drawn, in ms; 0 draws none. The development
   *   tools change it (debug.ts)
   */
  constructor(public ms: number) {}

  /** The pending point, then the predicted points, after stroke `id`'s tip; a new array whenever either changes */
  get(id: string): Point[] | undefined {
    return this.tips.get(id)?.points
  }

  /** Replaces the predicted points of stroke `id`; none drops them. The pending point stays */
  set(id: string, points: Point[]): void {
    const tip = this.tips.get(id)
    if (points.length === 0 && !tip?.predicted.length) return
    this.update(id, tip?.pending ?? null, points)
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

/** A predicted event: its client position and its timeStamp */
export type PredictedEvent = { clientX: number; clientY: number; timeStamp: number }

/**
 * The client positions of the predicted events to draw after the real position `from` of a pointermove at `timeStamp`,
 * and why the first one left out was dropped (null when none was). An event whose timeStamp is not within `ms` after
 * `timeStamp` is dropped for the time, then one farther from `from` than `limit` for the distance, and every event
 * after a dropped one with it. With `ms` 0 every event is dropped for the time
 */
export function predictedPositions(
  from: [number, number],
  timeStamp: number,
  events: readonly PredictedEvent[],
  limit: number,
  ms: number,
): { positions: [number, number][]; dropped: DropReason | null } {
  const positions: [number, number][] = []
  if (events.length === 0) return { positions, dropped: null }
  if (!(ms > 0)) return { positions, dropped: 'time' }
  for (const e of events) {
    const ahead = e.timeStamp - timeStamp
    if (!(ahead >= 0 && ahead <= ms)) return { positions, dropped: 'time' }
    if (!(Math.hypot(e.clientX - from[0], e.clientY - from[1]) <= limit)) return { positions, dropped: 'distance' }
    positions.push([e.clientX, e.clientY])
  }
  return { positions, dropped: null }
}

/**
 * The distance limit of the predicted points of a pointermove, in CSS px: how far the pointer goes in `ms` at the speed
 * it moved `moved` px in `elapsed` ms since the previous pointermove, at most MAX_PREDICTED_PX; 0 when `elapsed` is not
 * above 0
 */
export function predictionLimit(moved: number, elapsed: number, ms: number): number {
  return elapsed > 0 ? Math.min((moved / elapsed) * ms, MAX_PREDICTED_PX) : 0
}
