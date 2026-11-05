import { describe, expect, it } from 'vitest'
import type { StrokeData } from '../src/core/stroke'
import { MeshBuffer, isTranslucent } from '../src/MeshBuffer'
import { fakeWriter, xy } from './support'
import { expectValidMesh } from './invariants'

function stroke(id: string, points: number, extra: Partial<StrokeData> = {}): StrokeData {
  const pts = Array.from({ length: points }, (_, i): [number, number] => [0.5 + i * 1e-5, 0.5])
  return { id, author: 'a', color: '#102030', width: 8, zoom: 12, points: xy(pts), ...extra }
}

/** The order every vertex of a stroke holds, or the distinct values when they differ */
function ordersOf(mesh: MeshBuffer, id: string): number[] {
  const range = mesh.ranges.find((r) => r.id === id)!
  return [...new Set(mesh.orders.subarray(range.firstVertex, range.firstVertex + range.vertexCount))]
}

describe('MeshBuffer', () => {
  it('appends meshes with their indices offset and their style filled in', () => {
    const mesh = new MeshBuffer({ z: 12, x: 2048, y: 2048 })
    fakeWriter.appendStroke(mesh, stroke('a', 3), 12)
    fakeWriter.appendStroke(mesh, stroke('b', 1), 12)
    expectValidMesh(mesh)
    expect(mesh.ranges.map((range) => range.id)).toEqual(['a', 'b'])
    // #102030 as RGBA bytes, little-endian
    expect(mesh.colors[0]).toBe(0xff302010)
    expect(mesh.widths[mesh.vertexCount - 1]).toBe(8)
  })

  it('removes a stroke from the middle and keeps the rest valid', () => {
    const mesh = new MeshBuffer({ z: 12, x: 2048, y: 2048 })
    for (const [id, n] of [
      ['a', 4],
      ['b', 2],
      ['c', 5],
    ] as const)
      fakeWriter.appendStroke(mesh, stroke(id, n), 12)
    const revision = mesh.revision
    expect(mesh.removeStroke('b')).toBe(true)
    expect(mesh.removeStroke('b')).toBe(false)
    expectValidMesh(mesh)
    expect(mesh.ranges.map((range) => range.id)).toEqual(['a', 'c'])
    expect(mesh.revision).toBeGreaterThan(revision)
  })

  it('grows its arrays as needed and reports allocated and used bytes', () => {
    const mesh = new MeshBuffer({ z: 12, x: 2048, y: 2048 })
    for (let i = 0; i < 50; i++) fakeWriter.appendStroke(mesh, stroke(`s${i}`, 40), 12)
    expectValidMesh(mesh)
    expect(mesh.usedBytes()).toBeLessThanOrEqual(mesh.allocatedBytes())
  })

  it('survives a round trip through MeshData', () => {
    const mesh = new MeshBuffer({ z: 12, x: 2048, y: 2048 })
    fakeWriter.appendStroke(mesh, stroke('a', 3), 12)
    const copy = MeshBuffer.fromData(structuredClone(mesh.toData().data))
    expectValidMesh(copy)
    expect(copy.ranges).toEqual(mesh.ranges)
  })

  it('packs an alpha byte and tells translucent colors apart', () => {
    const mesh = new MeshBuffer({ z: 12, x: 2048, y: 2048 })
    fakeWriter.appendStroke(mesh, stroke('a', 2, { color: '#10203080' }), 12)
    expect(mesh.colors[0]).toBe(0x80302010)
    expect([isTranslucent('#10203080'), isTranslucent('#102030ff'), isTranslucent('#102030')]).toEqual([
      true,
      false,
      false,
    ])
  })

  it("writes each stroke's order to its vertices and changes only that stroke's", () => {
    const mesh = new MeshBuffer({ z: 12, x: 2048, y: 2048 })
    for (const id of ['a', 'b', 'c']) fakeWriter.appendStroke(mesh, stroke(id, 3, id === 'a' ? { order: 5 } : {}), 12)
    expect(ordersOf(mesh, 'a')).toEqual([5])
    expect(ordersOf(mesh, 'b')).toEqual([0])
    mesh.dirtyVertexFrom = mesh.vertexCount
    expect(mesh.setOrder('b', 9)).toBe(true)
    expect(mesh.setOrder('x', 9)).toBe(false)
    const b = mesh.ranges[1]
    expect([mesh.dirtyOrderFrom, mesh.dirtyOrderTo]).toEqual([b.firstVertex, b.firstVertex + b.vertexCount])
    expect([ordersOf(mesh, 'a'), ordersOf(mesh, 'b'), ordersOf(mesh, 'c')]).toEqual([[5], [9], [0]])
    mesh.syncOrders((id) => ({ a: 5, b: 9, c: 11 })[id]!)
    expect(ordersOf(mesh, 'c')).toEqual([11])
    // Removing a stroke moves the orders with the vertices
    mesh.removeStroke('a')
    expect([ordersOf(mesh, 'b'), ordersOf(mesh, 'c')]).toEqual([[9], [11]])
  })
})
