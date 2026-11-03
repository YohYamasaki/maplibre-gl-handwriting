import { strokesToGeoJSON } from './core/geojson'
import type { Point, StrokeData, StrokeStore } from './core/stroke'
import type { Selection } from './Selection'

// The actions of the selection's bar (decision 0037 P5-5). Like the controllers, they only apply ops to the store
// as local; the sync layer does the sending

/** Removes the selected strokes. Returns the ones removed, in drawing order, to record them as an erase */
export function deleteSelected(store: StrokeStore, selection: Selection): StrokeData[] {
  const removed: StrokeData[] = []
  for (const stroke of selectedInOrder(store, selection)) {
    if (store.apply({ type: 'remove', id: stroke.id }, 'local')) removed.push(stroke)
  }
  return removed
}

/**
 * Draws a copy of each selected stroke, moved by `offset` (normalized Web Mercator units), under a new identity,
 * in drawing order, so the copies are drawn on top in the same order. A copy that would leave the map is moved the
 * other way; one without an identity (newIdentity returns null) is not made. Returns the copies, to record them as
 * a draw
 */
export function duplicateSelected(
  store: StrokeStore,
  selection: Selection,
  newIdentity: () => { id: string; author: string } | null,
  offset: number,
): StrokeData[] {
  const copies: StrokeData[] = []
  for (const stroke of selectedInOrder(store, selection)) {
    const identity = newIdentity()
    if (!identity) continue
    const { id, author } = identity
    const dx = shiftOf(stroke.points, 0, offset)
    const dy = shiftOf(stroke.points, 1, offset)
    const pts = stroke.points.map(([x, y]): Point => [x + dx, y + dy])
    store.apply({ type: 'begin', id, author, color: stroke.color, width: stroke.width, zoom: stroke.zoom }, 'local')
    store.apply({ type: 'points', id, pts, ...(stroke.pressure ? { ps: [...stroke.pressure] } : {}) }, 'local')
    if (!store.apply({ type: 'end', id }, 'local')) continue
    const copy = store.get(id)
    if (copy) copies.push(copy)
  }
  return copies
}

/**
 * The strokes with these IDs as a GeoJSON FeatureCollection string (decision 0077). IDs not in the store and
 * strokes without an order yet are skipped
 */
export function exportGeoJSON(store: StrokeStore, ids: Iterable<string>): string {
  const strokes: StrokeData[] = []
  for (const id of ids) {
    const stroke = store.get(id)
    if (stroke && stroke.order !== undefined) strokes.push(stroke)
  }
  return strokesToGeoJSON(strokes)
}

function selectedInOrder(store: StrokeStore, selection: Selection): StrokeData[] {
  return [...selection.ids]
    .map((id) => store.get(id))
    .filter((stroke): stroke is StrokeData => stroke !== undefined)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** offset, or -offset when offset would take one of the points past 1 on this axis (and -offset keeps them on the map) */
function shiftOf(points: Point[], axis: 0 | 1, offset: number): number {
  let min = Infinity
  let max = -Infinity
  for (const p of points) {
    min = Math.min(min, p[axis])
    max = Math.max(max, p[axis])
  }
  if (max + offset <= 1) return offset
  return min - offset >= 0 ? -offset : 0
}
