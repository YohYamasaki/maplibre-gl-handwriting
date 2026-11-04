// Stand-ins for the tests: a mesh writer that needs no WebAssembly, a build queue the test drives by hand,
// a seeded random source so a failing op sequence can be replayed, and the shape of a UUID v4
import type { StrokeData } from '../src/core/stroke'
import type { MeshBuffer } from '../src/MeshBuffer'
import type { BuildQueue } from '../src/StrokeScene'
import { appendSamples, type MeshWriter, type Samples } from '../src/StrokeTessellator'
import { buildBucketMesh, type BuildJob, type BuildResult } from '../src/TessellationWorker'

/**
 * Writes a small, valid mesh for a stroke without tessellating: two vertices per sample and two triangles
 * per segment (one degenerate triangle for a dot). Enough for everything that does not look at the shape
 */
export const fakeWriter: MeshWriter = {
  appendStroke(mesh: MeshBuffer, stroke: StrokeData, zoom: number): void {
    const samples: Samples = { points: [] }
    appendSamples(samples, stroke, 0, zoom)
    this.appendPiece(mesh, stroke, samples, 0, samples.points.length - 1, zoom)
  },
  appendPiece(
    mesh: MeshBuffer,
    stroke: StrokeData,
    _samples: Samples,
    from: number,
    to: number,
    _zoom: number,
  ): void {
    const segments = to - from
    mesh.appendStroke(stroke.id, stroke, (target) => {
      const vertexCount = 2 * (segments + 1)
      const indexCount = segments === 0 ? 3 : 6 * segments
      const slot = target.reserve(vertexCount, indexCount)
      const b = slot.baseVertex
      if (segments === 0) slot.indices.set([b, b + 1, b + 1])
      for (let s = 0; s < segments; s++) {
        const v = b + 2 * s
        slot.indices.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], 6 * s)
      }
    })
  },
}

/** A build queue that keeps jobs until the test delivers them, in any order, possibly after the bucket changed */
export class DeferredBuilds implements BuildQueue {
  pending: BuildJob[] = []

  build(job: BuildJob): void {
    // The worker gets a copy; later changes to the strokes must not leak into the job
    this.pending.push(structuredClone(job))
  }

  /** Builds and returns the job at `index` (default: the oldest) */
  deliver(index = 0, writer: MeshWriter = fakeWriter): BuildResult {
    const [job] = this.pending.splice(index, 1)
    return buildBucketMesh(writer, job).result
  }
}

/** mulberry32: a small seeded PRNG */
export function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A UUID v4 as crypto.randomUUID gives it: lowercase 8-4-4-4-12, version 4, variant 10xx */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
