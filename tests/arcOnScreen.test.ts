// A stroke drawn at one zoom and tessellated for a closer one: its round caps and joins must be as smooth on screen as
// its centerline. The width is a map scale, so lyon has to shape the arcs for the width on screen at the
// zoom the mesh is made for, not the width at the drawing zoom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import type { Point, StrokeData } from '../src/core/stroke'
import { MeshBuffer } from '../src/MeshBuffer'
import { mercatorPerPixelAt } from '../src/mercator'
import { StrokeTessellator } from '../src/StrokeTessellator'
import { xy } from './support'

const root = join(import.meta.dirname, '..')
let tessellator: StrokeTessellator

beforeAll(async () => {
  tessellator = await StrokeTessellator.load(
    readFileSync(join(root, 'tessellator/pkg/handwriting_tessellator_bg.wasm')),
  )
})

const center: Point = [0.5003, 0.5003]

function stroke(points: Point[], width: number, zoom: number): StrokeData {
  return { id: 'me:1', author: 'me', color: '#336699', width, zoom, points: xy(points) }
}

function tessellate(s: StrokeData, zoom: number): MeshBuffer {
  const mesh = new MeshBuffer({ z: 14, x: Math.floor(center[0] * 2 ** 14), y: Math.floor(center[1] * 2 ** 14) })
  tessellator.appendStroke(mesh, s, zoom)
  return mesh
}

/**
 * The largest gap, in px on screen, between an arc of radius `half` and the chords between its neighboring vertices.
 * The arc vertices of a round cap or join share one position and differ by their unit normals, so the vertices are
 * grouped by position and each group's normals sorted by angle; gaps of half a turn or more are not arc chords
 */
function largestSagitta(mesh: MeshBuffer, half: number): number {
  const g = mesh.geometry
  const groups = new Map<string, number[]>()
  for (let v = 0; v < mesh.vertexCount; v++) {
    const [nx, ny] = [g[4 * v + 2], g[4 * v + 3]]
    if (Math.abs(Math.hypot(nx, ny) - 1) > 1e-3) continue
    const key = `${g[4 * v].toFixed(2)},${g[4 * v + 1].toFixed(2)}`
    const angles = groups.get(key) ?? []
    angles.push(Math.atan2(ny, nx))
    groups.set(key, angles)
  }
  let largest = 0
  for (const angles of groups.values()) {
    angles.sort((a, b) => a - b)
    for (let i = 1; i < angles.length; i++) {
      const gap = angles[i] - angles[i - 1]
      if (gap < Math.PI * 0.9) largest = Math.max(largest, half * (1 - Math.cos(gap / 2)))
    }
  }
  return largest
}

it('a dot drawn at z5 and tessellated for z10 is a smooth circle on screen', () => {
  const width = 4
  const mesh = tessellate(stroke([center], width, 5), 10)
  const half = (width * 2 ** 5) / 2
  expect(mesh.vertexCount).toBeGreaterThan(0)
  expect(largestSagitta(mesh, half)).toBeLessThanOrEqual(0.2)
})

it('a bent stroke drawn at z5 and tessellated for z10 has smooth caps and joins on screen', () => {
  const width = 4
  const px = mercatorPerPixelAt(5)
  // An L: 6 px right, then 6 px down, at the drawing zoom
  const points: Point[] = [center, [center[0] + 6 * px, center[1]], [center[0] + 6 * px, center[1] + 6 * px]]
  const mesh = tessellate(stroke(points, width, 5), 10)
  const half = (width * 2 ** 5) / 2
  expect(largestSagitta(mesh, half)).toBeLessThanOrEqual(0.2)
})

it('a stroke tessellated for its drawing zoom keeps the vertex count of its drawing width', () => {
  const width = 4
  const px = mercatorPerPixelAt(10)
  const points: Point[] = [center, [center[0] + 30 * px, center[1]], [center[0] + 30 * px, center[1] + 30 * px]]
  const atDrawingZoom = tessellate(stroke(points, width, 10), 10)
  // The same stroke drawn 5 zoom levels further out with a width 2^5 times smaller has the same width on screen at z10
  const fromFurtherOut = tessellate(stroke(points, width / 2 ** 5, 5), 10)
  expect(atDrawingZoom.vertexCount).toBe(fromFurtherOut.vertexCount)
  expect(largestSagitta(atDrawingZoom, width / 2)).toBeLessThanOrEqual(0.2)
})
