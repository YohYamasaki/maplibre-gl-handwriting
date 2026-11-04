import type { Point, StrokeData } from './core/stroke'
import { mercatorPerPixelAt } from './mercator'
import type { MeshBuffer } from './MeshBuffer'
import init, { Tessellator } from '../tessellator/pkg/handwriting_tessellator'

/**
 * A mesh made for zoom z is used until the view is this many levels away from z,
 * and is re-tessellated for the new zoom after that
 */
export const RETESSELLATE_ZOOMS = 3

/**
 * Curves are flattened, and samples thinned, to this many px at the zoom a mesh is made for.
 * After zooming in RETESSELLATE_ZOOMS levels the error has grown to 1 px, when the mesh is replaced
 */
const TOLERANCE_PX = 2 ** -RETESSELLATE_ZOOMS

// How many zoom levels past its drawing zoom a stroke is ever tessellated for. Beyond that its curves
// stay as fine as at this limit, which caps the vertex count and the size of lyon's f32 coordinates
const MAX_DETAIL_ZOOMS = 8

/**
 * A sample closer to the last one than the tolerance is still kept when its width coefficient differs from the last
 * one's by this much or more, so a quick change of pressure is not thinned away
 */
const PRESSURE_STEP = 0.1

/**
 * Such a point is kept only this far from the last sample, as a share of the tolerance. lyon merges a point closer to
 * the previous one than tolerance / sqrt(2) (about 0.71 of it, or less for a thin line), and could merge every point
 * of a piece of a stroke being drawn into one. Above that distance lyon keeps every sample, as it does without
 * pressure
 */
const PRESSURE_MIN_DISTANCE = 0.75

/**
 * The WebAssembly module next to this script: what load() fetches when given no module, and what the main thread
 * sends each worker (TessellationInit). The literal URL lets a bundler find the file and give it its own URL
 */
export const WASM_URL = new URL('../tessellator/pkg/handwriting_tessellator_bg.wasm', import.meta.url)

/** A stroke's points thinned for one zoom (see appendSamples), and their width coefficients when it has pressure */
export type Samples = { points: Point[]; pressure?: number[] }

/** The zoom to tessellate a stroke for when its mesh is made for `meshZoom` */
export function detailZoom(stroke: StrokeData, meshZoom: number): number {
  return Math.min(meshZoom, stroke.zoom + MAX_DETAIL_ZOOMS)
}

/** What writes stroke meshes into MeshBuffers: a StrokeTessellator, or a stand-in in tests */
export type MeshWriter = Pick<StrokeTessellator, 'appendStroke' | 'appendPiece'>

/**
 * Tessellates strokes with lyon into MeshBuffers.
 * The WebAssembly module writes each mesh straight into the MeshBuffer's arrays
 */
export class StrokeTessellator {
  // Reused across calls so passing samples allocates nothing in the common case
  private flat = new Float64Array(2 * 256)
  private flatPressure = new Float32Array(256)

  private constructor(private wasm: Tessellator) {}

  /**
   * Loads and instantiates the WebAssembly module, then returns a tessellator backed by it.
   * In a browser the module is fetched from WASM_URL, or from `wasm` when it is a URL;
   * outside one (tests, benchmarks) pass its bytes. The module is instantiated once per thread: later calls reuse it
   */
  static async load(wasm?: BufferSource | string | URL): Promise<StrokeTessellator> {
    await init({ module_or_path: wasm || WASM_URL })
    // One instance reused for every stroke, so lyon's internal buffers are allocated only once
    return new StrokeTessellator(new Tessellator())
  }

  /** Appends the whole stroke, tessellated for `zoom`, with round caps at both ends */
  appendStroke(mesh: MeshBuffer, stroke: StrokeData, zoom: number): void {
    const samples: Samples = { points: [] }
    appendSamples(samples, stroke, 0, zoom)
    this.appendPiece(mesh, stroke, samples, 0, samples.points.length - 1, zoom)
  }

  /**
   * Appends the curve through `samples[from..=to]` of a stroke (see appendSamples).
   * The samples just outside the range shape its ends, so pieces of one stroke appended separately join smoothly.
   * Both ends get round caps, which overlap the neighboring pieces; a translucent stroke is still painted once
   * there, since all of a stroke's vertices share one depth.
   * Each vertex carries its width over the stroke's, from the samples' width coefficients (1 without them); the
   * pieces on either side of a seam both end in a cap of the seam sample's coefficient
   */
  appendPiece(mesh: MeshBuffer, stroke: StrokeData, samples: Samples, from: number, to: number, zoom: number): void {
    // Only the range and one neighbor on each side affect the result, so only those are passed
    const { points, pressure } = samples
    const start = Math.max(0, from - 1)
    const end = Math.min(points.length, to + 2)
    if (this.flat.length < (end - start) * 2) this.flat = new Float64Array((end - start) * 4)
    for (let i = start; i < end; i++) this.flat.set(points[i], (i - start) * 2)
    if (pressure && this.flatPressure.length < end - start) this.flatPressure = new Float32Array((end - start) * 2)
    if (pressure) for (let i = start; i < end; i++) this.flatPressure[i - start] = pressure[i]
    const { tile } = mesh
    // The width is a map scale: lyon shapes round caps and joins from the width on screen at `zoom`,
    // so that their arcs stay within the tolerance there as the centerline does. Never below the drawing
    // width: lyon drops a dot narrower than about 0.25 px, and a mesh made far out is kept while zooming
    // back in
    const width = Math.max(stroke.width * 2 ** (zoom - stroke.zoom), stroke.width)
    mesh.appendStroke(stroke.id, stroke, (target) => {
      this.wasm.tessellate_into(
        this.flat.subarray(0, (end - start) * 2),
        pressure ? this.flatPressure.subarray(0, end - start) : null,
        from - start,
        to - start,
        width,
        TOLERANCE_PX,
        zoom,
        tile.z,
        tile.x,
        tile.y,
        target,
      )
    })
  }
}

/**
 * Appends to `samples` the stroke's points from `points[start]` on that are far enough from the last sample to matter
 * at `zoom` (TOLERANCE_PX), or, at PRESSURE_MIN_DISTANCE of that, whose width coefficient differs enough from the last
 * sample's (PRESSURE_STEP), with their coefficients. The spline also needs neighbors at distinct positions.
 * Points are only ever appended to a stroke, so its earlier samples never change as it grows
 */
export function appendSamples(
  samples: Samples,
  stroke: Pick<StrokeData, 'points' | 'pressure'>,
  start: number,
  zoom: number,
): void {
  const minDistance = TOLERANCE_PX * mercatorPerPixelAt(zoom)
  const { points, pressure } = stroke
  if (pressure) samples.pressure ??= []
  for (let i = start; i < points.length; i++) {
    const last = samples.points.at(-1)
    const p = points[i]
    const distance = last ? Math.hypot(p[0] - last[0], p[1] - last[1]) : Infinity
    const lastPressure = samples.pressure?.at(-1)
    const pressureChanged =
      pressure !== undefined && lastPressure !== undefined && Math.abs(pressure[i] - lastPressure) >= PRESSURE_STEP
    if (distance >= minDistance || (pressureChanged && distance >= PRESSURE_MIN_DISTANCE * minDistance)) {
      samples.points.push(p)
      if (pressure) samples.pressure!.push(pressure[i])
    }
  }
}
