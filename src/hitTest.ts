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

function distanceToPolyline(p: Point, points: Point[]): number {
  let min = Infinity
  // Starting at i = 0 makes the first segment zero-length, which also covers single-point strokes (dots)
  for (let i = 0; i < points.length; i++) {
    min = Math.min(min, distanceToSegment(p, points[Math.max(0, i - 1)], points[i]))
  }
  return min
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSq = dx * dx + dy * dy
  // Position of the closest point on the segment: 0 at a, 1 at b
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}
