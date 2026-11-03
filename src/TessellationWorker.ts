import type { TileID } from './core/bucket'
import type { StrokeData } from './core/stroke'
import { MeshBuffer, isTranslucent, type MeshData } from './MeshBuffer'
import { detailZoom, type MeshWriter } from './StrokeTessellator'

/** Tessellate all `strokes` of a bucket into its two meshes, made for `zoom` */
export type BuildJob = { key: string; version: number; tile: TileID; zoom: number; strokes: StrokeData[] }

/** The meshes of a BuildJob (opaque and translucent strokes apart), with the job's key, version and zoom */
export type BuildResult = { key: string; version: number; zoom: number; opaque: MeshData; translucent: MeshData }

/** Builds a job's meshes. Runs on the worker; tests and benchmarks call it directly */
export function buildBucketMesh(writer: MeshWriter, job: BuildJob): { result: BuildResult; transfer: ArrayBuffer[] } {
  const opaque = new MeshBuffer(job.tile)
  const translucent = new MeshBuffer(job.tile)
  for (const stroke of job.strokes) {
    writer.appendStroke(isTranslucent(stroke.color) ? translucent : opaque, stroke, detailZoom(stroke, job.zoom))
  }
  const [a, b] = [opaque.toData(), translucent.toData()]
  return {
    result: { key: job.key, version: job.version, zoom: job.zoom, opaque: a.data, translucent: b.data },
    transfer: [...a.transfer, ...b.transfer],
  }
}

/**
 * The first message to the worker when the WebAssembly module is not next to the worker script.
 * An absolute URL, since a relative one would resolve against the worker script
 */
export type TessellationInit = { wasmUrl: string }

/** Where the worker script and the WebAssembly module are loaded from, when not next to this script */
export type WorkerLocation = { workerUrl?: string | URL; wasmUrl?: string | URL }

/**
 * Runs bucket tessellation on a Web Worker (tessellation.worker.ts), so rebuilding many meshes
 * never stalls drawing. The finished mesh's arrays are transferred back, not copied
 */
export class TessellationWorker {
  private worker: Worker

  constructor(onBuilt: (result: BuildResult) => void, location: WorkerLocation = {}) {
    // The literal URL lets the bundler find the worker script and bundle it
    this.worker = location.workerUrl
      ? new Worker(location.workerUrl, { type: 'module' })
      : new Worker(new URL('./tessellation.worker.ts', import.meta.url), { type: 'module' })
    if (location.wasmUrl) {
      const init: TessellationInit = { wasmUrl: new URL(location.wasmUrl, document.baseURI).href }
      this.worker.postMessage(init)
    }
    this.worker.addEventListener('message', (e: MessageEvent<BuildResult>) => onBuilt(e.data))
    this.worker.addEventListener('error', (e) => console.error('Tessellation worker failed:', e.message))
  }

  build(job: BuildJob): void {
    this.worker.postMessage(job)
  }

  terminate(): void {
    this.worker.terminate()
  }
}
