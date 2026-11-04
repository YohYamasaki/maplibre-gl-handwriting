import type { TileID } from './core/bucket'
import type { MeshSlot, MeshTarget } from '../tessellator/pkg/handwriting_tessellator'

/** Floats per vertex in `geometry`: x y nx ny. The normal's length carries the vertex's width over the stroke's (pen pressure) */
export const GEOMETRY_FLOATS = 4

/** What is written to every vertex of a stroke's mesh */
export type StrokeStyle = {
  /** "#rrggbb", or "#rrggbbaa" for a translucent stroke */
  color: string
  /** CSS px at the drawing zoom */
  width: number
  /** Drawing zoom */
  zoom: number
  /** Place in the drawing order; missing until an order op gives the stroke one */
  order?: number
}

/** Where one stroke's mesh is in a MeshBuffer, and the drawing order its vertices hold (0: no order yet) */
export type StrokeRange = {
  id: string
  firstVertex: number
  vertexCount: number
  firstIndex: number
  indexCount: number
  order: number
}

/** The contents of a MeshBuffer, in a form that can be posted between threads */
export type MeshData = {
  tile: TileID
  geometry: Float32Array<ArrayBuffer>
  colors: Uint32Array<ArrayBuffer>
  widths: Float32Array<ArrayBuffer>
  zooms: Float32Array<ArrayBuffer>
  orders: Uint32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
  vertexCount: number
  indexCount: number
  ranges: StrokeRange[]
}

/**
 * CPU-side copy of the GPU data of stroke meshes whose positions are in one tile's local coordinates.
 * Each vertex attribute has an array of its own, so a mesh from lyon is copied in as is
 * and a stroke's style is written with fill, with no work per vertex.
 * Meshes are appended at the end, so the GPU buffers can be updated with just the appended range.
 * The arrays start empty, so a mesh that never gets a stroke (e.g. a bucket's translucent mesh) costs nothing
 */
export class MeshBuffer {
  geometry = new Float32Array(0)
  /** RGBA, one byte each */
  colors = new Uint32Array(0)
  widths = new Float32Array(0)
  zooms = new Float32Array(0)
  /** Each vertex's stroke's place in the drawing order, which the vertex shader turns into depth (0: no order yet) */
  orders = new Uint32Array(0)
  indices = new Uint32Array(0)
  vertexCount = 0
  indexCount = 0
  /** In append order */
  ranges: StrokeRange[] = []
  /** Bumped on every change, so anything derived from the ranges can tell it is out of date */
  revision = 0
  /** First vertex / index not uploaded to the GPU yet */
  dirtyVertexFrom = 0
  dirtyIndexFrom = 0
  /** Vertices before dirtyVertexFrom whose order changed and is not uploaded yet (empty when from >= to) */
  dirtyOrderFrom = Infinity
  dirtyOrderTo = 0
  // The tessellator writes through this object only, so it can do nothing but reserve space at the end
  readonly target: MeshTarget = { reserve: (vertexCount, indexCount) => this.reserve(vertexCount, indexCount) }

  constructor(readonly tile: TileID) {}

  static fromData(data: MeshData): MeshBuffer {
    const mesh = new MeshBuffer(data.tile)
    mesh.geometry = data.geometry
    mesh.colors = data.colors
    mesh.widths = data.widths
    mesh.zooms = data.zooms
    mesh.orders = data.orders
    mesh.indices = data.indices
    mesh.vertexCount = data.vertexCount
    mesh.indexCount = data.indexCount
    mesh.ranges = data.ranges
    return mesh
  }

  /** The contents and the buffers to transfer with them. The arrays of this MeshBuffer are unusable afterwards */
  toData(): { data: MeshData; transfer: ArrayBuffer[] } {
    const { tile, geometry, colors, widths, zooms, orders, indices, vertexCount, indexCount, ranges } = this
    const data = { tile, geometry, colors, widths, zooms, orders, indices, vertexCount, indexCount, ranges }
    const transfer = [geometry, colors, widths, zooms, orders, indices].map((array) => array.buffer)
    return { data, transfer }
  }

  /** Appends one stroke's mesh, which `write` writes into `target`, and gives its vertices the stroke's style */
  appendStroke(id: string, style: StrokeStyle, write: (target: MeshTarget) => void): void {
    const firstVertex = this.vertexCount
    const firstIndex = this.indexCount
    write(this.target)
    this.revision++
    this.colors.fill(packColor(style.color), firstVertex, this.vertexCount)
    this.widths.fill(style.width, firstVertex, this.vertexCount)
    this.zooms.fill(style.zoom, firstVertex, this.vertexCount)
    const order = style.order ?? 0
    this.orders.fill(order, firstVertex, this.vertexCount)
    this.ranges.push({
      id,
      firstVertex,
      vertexCount: this.vertexCount - firstVertex,
      firstIndex,
      indexCount: this.indexCount - firstIndex,
      order,
    })
  }

  /**
   * Gives a stroke's vertices a new place in the drawing order, e.g. once an order op gave it one.
   * Touches only that stroke's vertices. Returns false if the stroke is not here
   */
  setOrder(id: string, order: number): boolean {
    const range = this.ranges.find((r) => r.id === id)
    if (!range) return false
    this.fillOrder(range, order)
    return true
  }

  /** Gives every stroke here the order `orderOf` returns for it, touching only the strokes whose order differs */
  syncOrders(orderOf: (id: string) => number): void {
    for (const range of this.ranges) this.fillOrder(range, orderOf(range.id))
  }

  private fillOrder(range: StrokeRange, order: number): void {
    if (range.order === order) return
    range.order = order
    const end = range.firstVertex + range.vertexCount
    this.orders.fill(order, range.firstVertex, end)
    this.dirtyOrderFrom = Math.min(this.dirtyOrderFrom, range.firstVertex)
    this.dirtyOrderTo = Math.max(this.dirtyOrderTo, end)
  }

  /** Removes a stroke's mesh by moving everything after it forward. Returns false if it is not here */
  removeStroke(id: string): boolean {
    const at = this.ranges.findIndex((range) => range.id === id)
    if (at < 0) return false
    const { firstVertex, vertexCount, firstIndex, indexCount } = this.ranges[at]
    const nextVertex = firstVertex + vertexCount
    this.geometry.copyWithin(
      firstVertex * GEOMETRY_FLOATS,
      nextVertex * GEOMETRY_FLOATS,
      this.vertexCount * GEOMETRY_FLOATS,
    )
    for (const array of [this.colors, this.widths, this.zooms, this.orders]) {
      array.copyWithin(firstVertex, nextVertex, this.vertexCount)
    }
    this.indices.copyWithin(firstIndex, firstIndex + indexCount, this.indexCount)
    this.vertexCount -= vertexCount
    this.indexCount -= indexCount
    // The moved indices still point at where their vertices were
    for (let i = firstIndex; i < this.indexCount; i++) this.indices[i] -= vertexCount
    this.ranges.splice(at, 1)
    this.revision++
    for (let i = at; i < this.ranges.length; i++) {
      this.ranges[i].firstVertex -= vertexCount
      this.ranges[i].firstIndex -= indexCount
    }
    this.dirtyVertexFrom = Math.min(this.dirtyVertexFrom, firstVertex)
    this.dirtyIndexFrom = Math.min(this.dirtyIndexFrom, firstIndex)
    return true
  }

  /** Bytes of the arrays as allocated, which is what a full GPU upload sends */
  allocatedBytes(): number {
    return [this.geometry, this.colors, this.widths, this.zooms, this.orders, this.indices].reduce(
      (sum, array) => sum + array.byteLength,
      0,
    )
  }

  /** Bytes of the arrays that hold data */
  usedBytes(): number {
    const perVertex = (GEOMETRY_FLOATS + 4) * 4
    return this.vertexCount * perVertex + this.indexCount * Uint32Array.BYTES_PER_ELEMENT
  }

  clear(): void {
    this.revision++
    this.vertexCount = 0
    this.indexCount = 0
    this.ranges = []
    this.dirtyVertexFrom = 0
    this.dirtyIndexFrom = 0
    this.dirtyOrderFrom = Infinity
    this.dirtyOrderTo = 0
  }

  private reserve(vertexCount: number, indexCount: number): MeshSlot {
    const vertexEnd = this.vertexCount + vertexCount
    const indexEnd = this.indexCount + indexCount
    this.geometry = ensureLength(this.geometry, vertexEnd * GEOMETRY_FLOATS)
    this.colors = ensureLength(this.colors, vertexEnd)
    this.widths = ensureLength(this.widths, vertexEnd)
    this.zooms = ensureLength(this.zooms, vertexEnd)
    this.orders = ensureLength(this.orders, vertexEnd)
    this.indices = ensureLength(this.indices, indexEnd)
    const slot = {
      vertices: this.geometry.subarray(this.vertexCount * GEOMETRY_FLOATS, vertexEnd * GEOMETRY_FLOATS),
      indices: this.indices.subarray(this.indexCount, indexEnd),
      baseVertex: this.vertexCount,
    }
    this.vertexCount = vertexEnd
    this.indexCount = indexEnd
    return slot
  }
}

/** Returns the array itself when it is long enough, otherwise a copy with at least double the length */
function ensureLength<T extends Float32Array | Uint32Array>(array: T, length: number): T {
  if (length <= array.length) return array
  const grown = new (array.constructor as new (length: number) => T)(Math.max(length, array.length * 2))
  grown.set(array)
  return grown
}

/** Whether a stroke of this color ("#rrggbb" or "#rrggbbaa") lets what is under it show through */
export function isTranslucent(color: string): boolean {
  return color.length === 9 && color.slice(7).toLowerCase() !== 'ff'
}

/**
 * "#rrggbb" or "#rrggbbaa" as RGBA bytes in one Uint32. Typed arrays use the platform's byte order, which is
 * little-endian on every platform browsers run on, so red comes first in memory as the shader expects
 */
function packColor(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))
  const a = hex.length === 9 ? parseInt(hex.slice(7, 9), 16) : 0xff
  return (r | (g << 8) | (b << 16) | (a << 24)) >>> 0
}
