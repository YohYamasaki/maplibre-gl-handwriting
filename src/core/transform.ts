// Moving, scaling and rotating saved strokes.
// A transform is a similarity in normalized Web Mercator coordinates. Every store the transform op reaches (other
// clients, a sync layer's own copy) applies it with transformStroke, so all of them end up with the same numbers
import type { Point, StrokeData } from './stroke'

/**
 * [a, b, c, d, e, f]: a point (x, y) goes to (a x + c y + e, b x + d y + f), as in DOMMatrix and canvas.
 * Only similarities are used: a = d and c = -b, so the scale is the same in every direction
 */
export type Matrix = [a: number, b: number, c: number, d: number, e: number, f: number]

/** Strokes are kept between these zooms, the range a stroke can be drawn at */
export const MIN_STROKE_ZOOM = 0
export const MAX_STROKE_ZOOM = 24

/** The largest scale a transform may have, and the smallest is its inverse; beyond it no stroke stays in range */
export const MAX_TRANSFORM_SCALE = 2 ** (MAX_STROKE_ZOOM - MIN_STROKE_ZOOM)

/** Tolerance on a = d and c = -b, and on the scale's bounds, relative to the scale, for matrices built from rounded numbers */
const SIMILARITY_TOLERANCE = 1e-9

/**
 * How far past the zoom range, and past the map's edges (normalized units, about 1/4000 px at zoom 24), a
 * transformed stroke may land from rounding and still be kept, clamped to the range. Without it, a transform and
 * its inverse can fail to bring a stroke at the edge of the range back
 */
const ZOOM_TOLERANCE = 1e-9
const EDGE_TOLERANCE = 1e-12

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** Whether `m` is a similarity with finite entries and a scale within MAX_TRANSFORM_SCALE either way */
export function isSimilarity(m: readonly number[]): m is Matrix {
  if (m.length !== 6 || !m.every((v) => typeof v === 'number' && Number.isFinite(v))) return false
  const [a, b, c, d] = m
  const scale = Math.hypot(a, b)
  const slack = 1 + SIMILARITY_TOLERANCE
  if (!(scale >= 1 / MAX_TRANSFORM_SCALE / slack && scale <= MAX_TRANSFORM_SCALE * slack)) return false
  return Math.abs(a - d) <= SIMILARITY_TOLERANCE * scale && Math.abs(b + c) <= SIMILARITY_TOLERANCE * scale
}

/** How much `m` scales lengths */
export function scaleOf(m: Matrix): number {
  return Math.hypot(m[0], m[1])
}

/** The transform that applies `first` and then `second` */
export function compose(second: Matrix, first: Matrix): Matrix {
  const [a2, b2, c2, d2, e2, f2] = second
  const [a1, b1, c1, d1, e1, f1] = first
  return [
    a2 * a1 + c2 * b1,
    b2 * a1 + d2 * b1,
    a2 * c1 + c2 * d1,
    b2 * c1 + d2 * d1,
    a2 * e1 + c2 * f1 + e2,
    b2 * e1 + d2 * f1 + f2,
  ]
}

/** The transform that undoes `m` */
export function inverse(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  const ia = d / det
  const ib = -b / det
  const ic = -c / det
  const id = a / det
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)]
}

export function applyToPoint(m: Matrix, [x, y]: Point): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/** A scaling by `scale` and a rotation by `angle` (radians) about `center`, then a move by `offset` */
export function similarityAbout(center: Point, scale: number, angle: number, offset: Point = [0, 0]): Matrix {
  const a = scale * Math.cos(angle)
  const b = scale * Math.sin(angle)
  const [cx, cy] = center
  return [a, b, -b, a, cx - a * cx + b * cy + offset[0], cy - b * cx - a * cy + offset[1]]
}

/**
 * The points and zoom a stroke has after `m`. Its width in pixels stays the same, so the zoom it was drawn at
 * changes by the scale: a stroke twice as large is the size it was at one zoom level further out.
 * Returns null when a point would leave the map (0 to 1) or the zoom would leave MIN/MAX_STROKE_ZOOM, by more than
 * rounding (EDGE_TOLERANCE, ZOOM_TOLERANCE; within it, the value is clamped); such a stroke is left as it is
 */
export function transformStroke(
  stroke: Pick<StrokeData, 'points' | 'zoom'>,
  m: Matrix,
): { points: Point[]; zoom: number } | null {
  const zoom = clampWithin(stroke.zoom - Math.log2(scaleOf(m)), MIN_STROKE_ZOOM, MAX_STROKE_ZOOM, ZOOM_TOLERANCE)
  if (zoom === null) return null
  const points: Point[] = []
  for (const p of stroke.points) {
    const [x, y] = applyToPoint(m, p)
    const qx = clampWithin(x, 0, 1, EDGE_TOLERANCE)
    const qy = clampWithin(y, 0, 1, EDGE_TOLERANCE)
    if (qx === null || qy === null) return null
    points.push([qx, qy])
  }
  return { points, zoom }
}

/** `value` clamped to [min, max] when it is at most `tolerance` outside it, and null when it is further out (or NaN) */
function clampWithin(value: number, min: number, max: number, tolerance: number): number | null {
  if (!(value >= min - tolerance && value <= max + tolerance)) return null
  return Math.min(max, Math.max(min, value))
}
