import type { Point, StrokeData, StrokeStore } from './core/stroke'
import { grow } from './bounds'
import type { StrokeIndex } from './StrokeIndex'

/**
 * IDs of the strokes whose center line comes within radiusOf(stroke) of p.
 * The index narrows the strokes down to those near p; `maxRadius` must be at least radiusOf of any stroke.
 * All coordinates and distances are in normalized Web Mercator units
 */
export function findStrokesNear(
  index: StrokeIndex,
  store: StrokeStore,
  p: Point,
  radiusOf: (stroke: StrokeData) => number,
  maxRadius: number,
): string[] {
  const near = index.search(grow({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] }, maxRadius))
  return near.filter((id) => {
    const stroke = store.get(id)
    return stroke !== undefined && distanceToPolyline(p, stroke.points) <= radiusOf(stroke)
  })
}

/** The distance from p to the line through `points` (x and y in turn) */
function distanceToPolyline(p: Point, points: Float64Array): number {
  let min = Infinity
  // Starting at i = 0 makes the first segment zero-length, which also covers single-point strokes (dots)
  for (let i = 0; 2 * i + 1 < points.length; i++) {
    const a = 2 * Math.max(0, i - 1)
    min = Math.min(min, distanceToSegment(p, points[a], points[a + 1], points[2 * i], points[2 * i + 1]))
  }
  return min
}

/** The distance from p to the segment from (ax, ay) to (bx, by) */
function distanceToSegment(p: Point, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  // Position of the closest point on the segment: 0 at a, 1 at b
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / lengthSq))
  return Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy))
}
