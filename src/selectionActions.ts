import { strokesToGeoJSON } from './core/geojson'
import type { StrokeData, StrokeStore } from './core/stroke'
import type { Selection } from './Selection'

// The actions of the selection's bar. Like the controllers, they only apply ops to the store
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
    // The selection holds its strokes, so their points are in memory
    const points = stroke.points
    if (!points) continue
    const identity = newIdentity()
    if (!identity) continue
    const { id, author } = identity
    const dx = shiftOf(points, 0, offset)
    const dy = shiftOf(points, 1, offset)
    const pts = new Float64Array(points.length)
    for (let i = 0; i + 1 < pts.length; i += 2) {
      pts[i] = points[i] + dx
      pts[i + 1] = points[i + 1] + dy
    }
    store.apply({ type: 'begin', id, author, color: stroke.color, width: stroke.width, zoom: stroke.zoom }, 'local')
    store.apply({ type: 'points', id, pts, ...(stroke.pressure ? { ps: stroke.pressure.slice() } : {}) }, 'local')
    if (!store.apply({ type: 'end', id }, 'local')) continue
    const copy = store.get(id)
    if (copy) copies.push(copy)
  }
  return copies
}

/**
 * The strokes with these IDs as a GeoJSON FeatureCollection string, once their spilled points are read back. IDs not
 * in the store, strokes without an order yet and strokes whose points could not be read back are skipped
 */
export async function exportGeoJSON(store: StrokeStore, ids: Iterable<string>): Promise<string> {
  const strokes = await store.read(ids)
  return strokesToGeoJSON(strokes.filter((stroke) => stroke.order !== undefined))
}

function selectedInOrder(store: StrokeStore, selection: Selection): StrokeData[] {
  return [...selection.ids]
    .map((id) => store.get(id))
    .filter((stroke): stroke is StrokeData => stroke !== undefined)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * offset, or -offset when offset would take one of the points (x and y in turn) past 1 on this axis (and -offset keeps
 * them on the map)
 */
function shiftOf(points: Float64Array, axis: 0 | 1, offset: number): number {
  let min = Infinity
  let max = -Infinity
  for (let i = axis; i < points.length; i += 2) {
    min = Math.min(min, points[i])
    max = Math.max(max, points[i])
  }
  if (max + offset <= 1) return offset
  return min - offset >= 0 ? -offset : 0
}
