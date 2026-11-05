import type { Point, StrokeData, StrokeStore } from './core/stroke'
import { boundsOf } from './bounds'
import { findStrokesNear } from './hitTest'
import type { StrokeIndex } from './StrokeIndex'

// Selection by lasso and by tap. Only strokes with an order can be selected.
// All coordinates and distances are in normalized Web Mercator units

/** Whether p is inside the polygon (closed from its last point back to its first), by the even-odd rule */
export function insidePolygon(p: Point, polygon: Point[]): boolean {
  return insideAt(p[0], p[1], polygon)
}

/** Whether (x, y) is inside the polygon, as insidePolygon */
function insideAt(x: number, y: number, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** IDs of the strokes with an order and at least half of their points inside the lasso */
export function strokesInLasso(index: StrokeIndex, store: StrokeStore, polygon: Point[]): string[] {
  if (polygon.length < 3) return []
  return index.search(boundsOf(polygon)).filter((id) => {
    const stroke = store.get(id)
    if (!stroke || stroke.order === undefined) return false
    const { points } = stroke
    let inside = 0
    for (let i = 0; i + 1 < points.length; i += 2) if (insideAt(points[i], points[i + 1], polygon)) inside++
    return 2 * inside >= points.length / 2
  })
}

/**
 * The ID of the topmost stroke with an order (latest in the drawing order) whose center line comes within radiusOf(stroke)
 * of p, or null. `maxRadius` must be at least radiusOf of any stroke
 */
export function topmostStrokeAt(
  index: StrokeIndex,
  store: StrokeStore,
  p: Point,
  radiusOf: (stroke: StrokeData) => number,
  maxRadius: number,
): string | null {
  let top: StrokeData | null = null
  for (const id of findStrokesNear(index, store, p, radiusOf, maxRadius)) {
    const stroke = store.get(id)!
    if (stroke.order === undefined) continue
    if (!top || stroke.order > top.order! || (stroke.order === top.order && stroke.id > top.id)) top = stroke
  }
  return top?.id ?? null
}
