// Invariants of the render state, checked by the op-sequence test after every step.
// Each one is stated from what the store holds, not from how StrokeScene computes things,
// so a change to the scene's internals cannot make a check pass by agreeing with itself
import { expect } from 'vitest'
import { bucketOf, tileKey } from '../src/core/bucket'
import type { StrokeData, StrokeStore } from '../src/core/stroke'
import { boundsOf, grow, intersects, type Bounds } from '../src/bounds'
import { isTranslucent, type MeshBuffer } from '../src/MeshBuffer'
import { mercatorPerPixelAt } from '../src/mercator'
import {
  ORDER_DEPTH_BITS,
  type BucketMesh,
  type DrawRange,
  type FrameDraws,
  type StrokeScene,
} from '../src/StrokeScene'

/** Ranges tile the mesh in order with no gaps, and every index points into its own stroke's vertices */
export function expectValidMesh(mesh: MeshBuffer): void {
  let vertex = 0
  let index = 0
  for (const range of mesh.ranges) {
    expect(range.firstVertex).toBe(vertex)
    expect(range.firstIndex).toBe(index)
    for (let i = range.firstIndex; i < range.firstIndex + range.indexCount; i++) {
      expect(mesh.indices[i]).toBeGreaterThanOrEqual(range.firstVertex)
      expect(mesh.indices[i]).toBeLessThan(range.firstVertex + range.vertexCount)
    }
    vertex += range.vertexCount
    index += range.indexCount
  }
  expect(vertex).toBe(mesh.vertexCount)
  expect(index).toBe(mesh.indexCount)
  expect(mesh.indexCount % 3).toBe(0)
}

/** `drawing`: the IDs of the strokes begun and neither ended nor removed */
export function expectConsistentScene(store: StrokeStore, scene: StrokeScene, drawing: ReadonlySet<string>): void {
  const { buckets, strokeBuckets, active } = scene.inspect()
  expect(new Set(active.keys())).toEqual(drawing)

  // Every finished stroke is in exactly the bucket its first point and drawing zoom give
  for (const stroke of store.values()) {
    if (drawing.has(stroke.id)) {
      expect(strokeBuckets.has(stroke.id)).toBe(false)
      continue
    }
    const key = tileKey(bucketOf(stroke.points[0], stroke.zoom))
    expect(strokeBuckets.get(stroke.id)).toBe(key)
    expect(buckets.get(key)?.strokes.get(stroke.id)).toBe(stroke)
  }
  expect(strokeBuckets.size).toBe([...store.values()].filter((stroke) => !drawing.has(stroke.id)).length)

  for (const [key, bucket] of buckets) {
    expect(bucket.strokes.size).toBeGreaterThan(0)
    for (const id of bucket.strokes.keys()) expect(strokeBuckets.get(id)).toBe(key)
    if (!bucket.mesh) continue
    for (const [kind, mesh] of Object.entries(bucket.mesh) as [keyof BucketMesh, MeshBuffer][]) {
      expectValidMesh(mesh)
      for (const range of mesh.ranges) {
        const stroke = bucket.strokes.get(range.id)
        // An erased stroke never lingers in a mesh, even one that is behind
        expect(stroke).toBeDefined()
        // Opaque and translucent strokes are kept apart
        expect(isTranslucent(stroke!.color) ? 'translucent' : 'opaque').toBe(kind)
        // Every vertex holds the stroke's place in the drawing order as the store has it, which becomes its depth
        const order = store.get(range.id)!.order ?? 0
        expect(range.order, `${range.id} holds order ${range.order}, the store ${order}`).toBe(order)
        for (let v = range.firstVertex; v < range.firstVertex + range.vertexCount; v++)
          expect(mesh.orders[v]).toBe(order)
      }
    }
    // An up-to-date mesh holds every stroke of the area it was made for
    if (bucket.meshVersion === bucket.version && bucket.meshArea) {
      const inMesh = new Set([...bucket.mesh.opaque.ranges, ...bucket.mesh.translucent.ranges].map((range) => range.id))
      for (const [id, bounds] of bucket.strokeBounds) {
        if (intersects(bounds, bucket.meshArea)) {
          expect(
            inMesh.has(id),
            `bucket ${key} v${bucket.version}: ${id} is in the mesh's area but not in the mesh`,
          ).toBe(true)
        }
      }
    }
  }
}

/**
 * The draw calls of one frame: inside the meshes, never the same stroke twice, opaque and translucent strokes
 * each in their own list, whole opaque meshes for the buckets that are drawn, strokes being drawn last in each
 * list, overlapping translucent strokes in the server's order, and a depth of its own for every saved stroke
 */
export function expectValidDraws(
  store: StrokeStore,
  scene: StrokeScene,
  frame: FrameDraws,
  view: Bounds,
  zoom: number,
): void {
  const { buckets, active } = scene.inspect()
  const hotMeshes = new Set([...active.values()].flatMap((hot) => (hot ? [hot.frozen, hot.tail] : [])))
  const drawnIds = new Set<string>()
  // Position of each finished translucent stroke in drawing order: (draw call, place within the call)
  const position = new Map<string, number>()
  // The depth each finished translucent stroke's vertices get, or null when they do not all get the same one
  const depths = new Map<string, number | null>()
  const lists: [kind: 'opaque' | 'translucent', draws: DrawRange[]][] = [
    ['opaque', frame.opaque],
    ['translucent', frame.translucent],
  ]
  for (const [kind, draws] of lists) {
    let lastFinished = -1
    draws.forEach((draw, d) => {
      expect(draw.firstIndex + draw.indexCount).toBeLessThanOrEqual(draw.mesh.indexCount)
      if (hotMeshes.has(draw.mesh)) return
      lastFinished = d
      const ranges = draw.mesh.ranges.filter(
        (range) => range.firstIndex >= draw.firstIndex && range.firstIndex < draw.firstIndex + draw.indexCount,
      )
      // A draw call covers whole strokes
      expect(ranges.reduce((sum, range) => sum + range.indexCount, 0)).toBe(draw.indexCount)
      ranges.forEach((range, r) => {
        // Each stroke is in one bucket, so a stroke drawn twice is a duplicated draw
        expect(drawnIds.has(range.id)).toBe(false)
        drawnIds.add(range.id)
        expect(isTranslucent(store.get(range.id)!.color) ? 'translucent' : 'opaque').toBe(kind)
        if (kind === 'translucent') {
          position.set(range.id, d * 1e6 + r)
          const vertices = draw.mesh.orders.subarray(range.firstVertex, range.firstVertex + range.vertexCount)
          const found = new Set([...vertices].map((order) => depthOf(order, frame.orderBase)))
          depths.set(range.id, found.size === 1 ? [...found][0] : null)
        }
      })
    })
    // Strokes being drawn come after every finished one
    draws.forEach((draw, d) => {
      if (hotMeshes.has(draw.mesh)) expect(d).toBeGreaterThan(lastFinished)
    })
  }
  // Strokes being drawn are in the list their color calls for
  for (const hot of active.values()) {
    if (!hot) continue
    for (const draw of frame.opaque)
      if (draw.mesh === hot.frozen || draw.mesh === hot.tail) expect(hot.translucent).toBe(false)
    for (const draw of frame.translucent)
      if (draw.mesh === hot.frozen || draw.mesh === hot.tail) expect(hot.translucent).toBe(true)
  }
  // An opaque mesh is drawn whole in one call, and a translucent one whole or not at all
  const opaqueDraws = new Map(frame.opaque.map((draw) => [draw.mesh, draw]))
  for (const bucket of buckets.values()) {
    if (!bucket.mesh) continue
    const draw = opaqueDraws.get(bucket.mesh.opaque)
    if (draw) expect([draw.firstIndex, draw.indexCount]).toEqual([0, bucket.mesh.opaque.indexCount])
    const translucent = bucket.mesh.translucent.ranges
    expect([0, translucent.length]).toContain(translucent.filter((range) => drawnIds.has(range.id)).length)
  }
  // Every saved stroke drawn gets a depth of its own: the tests never use more orders than there are depths
  for (const id of drawnIds) {
    const order = store.get(id)!.order
    if (order !== undefined) expect(order).toBeGreaterThanOrEqual(frame.orderBase)
  }
  // Overlapping saved translucent strokes are drawn in order. Overlap is judged from the strokes themselves, with
  // their width on the map, the same margin the scene must cover.
  // Overlapping strokes of the same order (the pieces of a cut stroke) are instead drawn at one and the same depth:
  // the translucent pass's strictly-less depth test then paints their overlap once, whichever is drawn first
  const drawn: { stroke: StrokeData; area: Bounds; at: number }[] = []
  for (const [id, at] of position) {
    const stroke = store.get(id)!
    if (stroke.order === undefined) continue
    const half = (stroke.width * mercatorPerPixelAt(stroke.zoom)) / 2
    const bounds = buckets.get(tileKey(bucketOf(stroke.points[0], stroke.zoom)))!.strokeBounds.get(id)!
    drawn.push({ stroke, area: grow(bounds, half), at })
  }
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      const [a, b] = [drawn[i], drawn[j]]
      if (!intersects(a.area, b.area)) continue
      if (a.stroke.order === b.stroke.order) {
        const depth = depths.get(a.stroke.id)
        expect(depth).not.toBeNull()
        expect(depths.get(b.stroke.id)).toBe(depth)
        continue
      }
      expect(Math.sign(a.at - b.at)).toBe(Math.sign(a.stroke.order! - b.stroke.order!))
    }
  }
  // Meshes are kept only near the view (two screens), counted from the edge of the lines
  const width = view.maxX - view.minX
  const height = view.maxY - view.minY
  const far = grow(view, 2 * width, 2 * height)
  for (const bucket of buckets.values()) {
    if (!bucket.mesh) continue
    // The center lines and the widest line of the strokes still in the bucket, from the strokes themselves,
    // so a mesh kept for an erased stroke's place or width is caught
    const strokes = [...bucket.strokes.values()]
    const widest = Math.max(...strokes.map((stroke) => stroke.width * mercatorPerPixelAt(stroke.zoom)))
    const centerLines = boundsOf(strokes.flatMap((stroke) => stroke.points))
    expect(intersects(grow(centerLines, widest / 2), far)).toBe(true)
  }
}

/** The depth the vertex shader gives a vertex of `order` (see shaders.ts), in steps of 2^-ORDER_DEPTH_BITS */
function depthOf(order: number, orderBase: number): number {
  const steps = order === 0 ? 2 ** ORDER_DEPTH_BITS : Math.max(order - orderBase, 0) + 1
  return 2 ** ORDER_DEPTH_BITS - steps
}
