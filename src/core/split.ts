// Cutting strokes with the partial eraser.
// A cut is a position along a stroke's center line: s = i + t lies on the segment from points[i] to points[i + 1],
// a fraction t of the way. A piece is the part of a stroke between two such positions. The client that erases
// finds the pieces; every store the split op reaches (other clients, a sync layer's own copy) then builds each piece's
// points from the stroke with piecePoints, so all of them end up with the same numbers
import type { Point, StrokeData } from './stroke'

/** Pieces one cut may leave of a stroke; the eraser leaves a stroke that would break into more alone */
export const MAX_PIECES_PER_SPLIT = 64

/**
 * The part of a stroke from position `from` to position `to` along its center line, where a position s = i + t lies
 * on the segment from points[i] to points[i + 1], a fraction t of the way
 */
export type PieceRange = { from: number; to: number }

/** A piece of a stroke with the ID it is saved under */
export type StrokePiece = PieceRange & { id: string }

/** A segment of the eraser's path and how far around it the eraser reaches (normalized Web Mercator units) */
export type EraserSweep = { from: Point; to: Point; radius: number }

/**
 * Whether `pieces` can be cut from a stroke of `pointCount` points: at least one, each longer than nothing,
 * in order along the stroke and not overlapping, all within it
 */
export function validPieces(pieces: readonly PieceRange[], pointCount: number): boolean {
  if (pieces.length === 0 || pointCount < 2) return false
  let end = 0
  for (const { from, to } of pieces) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < end || to <= from || to > pointCount - 1) return false
    end = to
  }
  return true
}

/** The point at position `s` along `points` */
function pointAt(points: readonly Point[], s: number): Point {
  const i = Math.floor(s)
  const t = s - i
  if (t === 0 || i >= points.length - 1) return points[Math.min(i, points.length - 1)]
  const a = points[i]
  const b = points[i + 1]
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/** The width coefficient at position `s` along a stroke, interpolated like the point */
function pressureAt(pressure: readonly number[], s: number): number {
  const i = Math.floor(s)
  const t = s - i
  if (t === 0 || i >= pressure.length - 1) return pressure[Math.min(i, pressure.length - 1)]
  return pressure[i] + (pressure[i + 1] - pressure[i]) * t
}

/**
 * The points of one piece of a stroke, and their width coefficients when the stroke has pressure: the cut at
 * `from`, the stroke's own points strictly between the cuts, and the cut at `to`
 */
export function piecePoints(stroke: StrokeData, { from, to }: PieceRange): { points: Point[]; pressure?: number[] } {
  const indices: number[] = []
  for (let i = Math.floor(from) + 1; i < to; i++) indices.push(i)
  const points = [pointAt(stroke.points, from), ...indices.map((i) => stroke.points[i]), pointAt(stroke.points, to)]
  if (!stroke.pressure) return { points }
  const pressure = stroke.pressure
  return {
    points,
    pressure: [pressureAt(pressure, from), ...indices.map((i) => pressure[i]), pressureAt(pressure, to)],
  }
}

/** A piece as a stroke of its own: it keeps the original's author, style, zoom and place in the drawing order */
export function pieceStroke(stroke: StrokeData, piece: StrokePiece): StrokeData {
  const { points, pressure } = piecePoints(stroke, piece)
  const result: StrokeData = {
    id: piece.id,
    author: stroke.author,
    color: stroke.color,
    width: stroke.width,
    zoom: stroke.zoom,
    points,
  }
  if (pressure) result.pressure = pressure
  if (stroke.order !== undefined) result.order = stroke.order
  return result
}

/**
 * Where the eraser cuts a stroke: the parts of its center line that stay, after removing every part within
 * `sweep.radius` of the sweep's segment, and dropping the parts shorter than `minLength`.
 * Returns null when the eraser does not reach the stroke, and an empty list when nothing of it stays.
 * All lengths are in normalized Web Mercator units
 */
export function cutStroke(
  points: readonly Point[],
  sweeps: readonly EraserSweep[],
  minLength: number,
): PieceRange[] | null {
  const erased = erasedIntervals(points, sweeps)
  return erased === null ? null : keptRanges(points, erased, minLength)
}

/**
 * The parts of a stroke's center line within reach of the sweeps, as [start, end] positions in order and apart,
 * or null when the eraser does not reach the stroke. A dot is erased whole or not at all
 */
export function erasedIntervals(points: readonly Point[], sweeps: readonly EraserSweep[]): [number, number][] | null {
  if (points.length === 0) return null
  if (points.length === 1) {
    return sweeps.some((sweep) => distanceToSegment(points[0], sweep.from, sweep.to) <= sweep.radius) ? [[0, 0]] : null
  }
  const hits: [number, number][] = []
  for (let i = 0; i < points.length - 1; i++) {
    for (const sweep of sweeps) {
      const hit = segmentInCapsule(points[i], points[i + 1], sweep)
      if (hit) hits.push([i + hit[0], i + hit[1]])
    }
  }
  return hits.length === 0 ? null : mergeIntervals(hits, [])
}

/** The union of two sets of [start, end] intervals, in order and apart */
export function mergeIntervals(a: readonly [number, number][], b: readonly [number, number][]): [number, number][] {
  const all = [...a, ...b].sort((x, y) => x[0] - y[0])
  const merged: [number, number][] = []
  for (const [start, end] of all) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/**
 * The parts of a stroke that stay once the `erased` intervals (in order and apart) are gone, dropping the parts
 * shorter than `minLength`. Nothing stays of a dot
 */
export function keptRanges(
  points: readonly Point[],
  erased: readonly [number, number][],
  minLength: number,
): PieceRange[] {
  if (points.length < 2) return []
  const pieces: PieceRange[] = []
  const keep = (from: number, to: number): void => {
    if (to > from && pathLength(points, from, to) >= minLength) pieces.push({ from, to })
  }
  let from = 0
  for (const [start, end] of erased) {
    keep(from, start)
    from = Math.max(from, end)
  }
  keep(from, points.length - 1)
  return pieces
}

/** How many points the piece of a stroke from `from` to `to` has (see piecePoints) */
export function piecePointCount({ from, to }: PieceRange): number {
  return Math.max(0, Math.ceil(to) - Math.floor(from) - 1) + 2
}

/** Length of the center line between positions `from` and `to` */
function pathLength(points: readonly Point[], from: number, to: number): number {
  const along = [pointAt(points, from)]
  for (let i = Math.floor(from) + 1; i < to; i++) along.push(points[i])
  along.push(pointAt(points, to))
  let length = 0
  for (let i = 1; i < along.length; i++)
    length += Math.hypot(along[i][0] - along[i - 1][0], along[i][1] - along[i - 1][1])
  return length
}

/**
 * The fractions [t0, t1] of the segment from a to b that lie within `radius` of the sweep's segment, or null.
 * The points within the radius of a segment form a convex shape (a capsule): its two end discs and the band
 * between them. Each meets the line in an interval, and together they make one, so it is their hull
 */
function segmentInCapsule(a: Point, b: Point, { from: p, to: q, radius }: EraserSweep): [number, number] | null {
  const intervals = [inDisc(a, b, p, radius), inDisc(a, b, q, radius), inBand(a, b, p, q, radius)]
  let t0 = Infinity
  let t1 = -Infinity
  for (const interval of intervals) {
    if (!interval) continue
    t0 = Math.min(t0, interval[0])
    t1 = Math.max(t1, interval[1])
  }
  t0 = Math.max(0, t0)
  t1 = Math.min(1, t1)
  return t0 <= t1 ? [t0, t1] : null
}

/** The fractions of the line through a and b within `radius` of c, or null */
function inDisc(a: Point, b: Point, c: Point, radius: number): [number, number] | null {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const fx = a[0] - c[0]
  const fy = a[1] - c[1]
  const qa = dx * dx + dy * dy
  const qb = 2 * (fx * dx + fy * dy)
  const qc = fx * fx + fy * fy - radius * radius
  if (qa === 0) return qc <= 0 ? [0, 1] : null
  const discriminant = qb * qb - 4 * qa * qc
  if (discriminant < 0) return null
  const root = Math.sqrt(discriminant)
  return [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)]
}

/** The fractions of the line through a and b in the band of half width `radius` around the segment p q, or null */
function inBand(a: Point, b: Point, p: Point, q: Point, radius: number): [number, number] | null {
  const length = Math.hypot(q[0] - p[0], q[1] - p[1])
  if (length === 0) return null
  const ux = (q[0] - p[0]) / length
  const uy = (q[1] - p[1]) / length
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const rx = a[0] - p[0]
  const ry = a[1] - p[1]
  // Along the sweep: 0 to length. Across it: -radius to radius. Both are linear in t
  let t0 = -Infinity
  let t1 = Infinity
  const clip = (start: number, rate: number, min: number, max: number): boolean => {
    if (rate === 0) return start >= min && start <= max
    let lo = (min - start) / rate
    let hi = (max - start) / rate
    if (lo > hi) [lo, hi] = [hi, lo]
    t0 = Math.max(t0, lo)
    t1 = Math.min(t1, hi)
    return t0 <= t1
  }
  if (!clip(rx * ux + ry * uy, dx * ux + dy * uy, 0, length)) return null
  if (!clip(-rx * uy + ry * ux, -dx * uy + dy * ux, -radius, radius)) return null
  return [t0, t1]
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}
