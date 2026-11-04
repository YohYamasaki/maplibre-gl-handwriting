import type { TileID } from './core/bucket'
import type { StrokeData } from './core/stroke'
import { MeshBuffer, isTranslucent, type MeshData } from './MeshBuffer'
import { detailZoom, WASM_URL, type MeshWriter } from './StrokeTessellator'

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
 * The first message to each worker: where the WebAssembly module is, the one the main thread loads. An absolute URL,
 * since a relative one would resolve against the worker script
 */
export type TessellationInit = { wasmUrl: string }

/**
 * What the worker sends once, before any BuildResult: whether its WebAssembly module loaded. After a failure it
 * answers no job
 */
export type TessellationLoad = { loaded: true } | { loaded: false; error: string }

/** Where the worker script and the WebAssembly module are loaded from, when not next to this script */
export type WorkerLocation = { workerUrl?: string | URL; wasmUrl?: string | URL }

/**
 * Runs bucket tessellation on a Web Worker (tessellation.worker.ts), so rebuilding many meshes
 * never stalls drawing. The finished mesh's arrays are transferred back, not copied
 */
export class TessellationWorker {
  private worker: Worker
  // After terminate, what the worker had already sent is dropped
  private terminated = false
  private loadReported = false

  /**
   * Throws what new Worker throws, e.g. a SecurityError for a script of another origin. `onLoad` is called once: with
   * null when the worker has loaded its WebAssembly module, or with the error when the worker's script or its module
   * failed to load. Neither callback is called after terminate
   */
  constructor(
    onBuilt: (result: BuildResult) => void,
    onLoad: (error: Error | null) => void,
    location: WorkerLocation = {},
  ) {
    // The literal URL lets the bundler find the worker script and bundle it
    this.worker = location.workerUrl
      ? new Worker(location.workerUrl, { type: 'module' })
      : new Worker(new URL('./tessellation.worker.ts', import.meta.url), { type: 'module' })
    const wasmUrl = location.wasmUrl ? new URL(location.wasmUrl, document.baseURI) : WASM_URL
    const init: TessellationInit = { wasmUrl: wasmUrl.href }
    this.worker.postMessage(init)
    const loaded = (error: Error | null): void => {
      if (this.terminated || this.loadReported) return
      this.loadReported = true
      onLoad(error)
    }
    this.worker.addEventListener('message', (e: MessageEvent<BuildResult | TessellationLoad>) => {
      if (this.terminated) return
      const data = e.data
      if (!('loaded' in data)) onBuilt(data)
      else if (data.loaded) loaded(null)
      else loaded(new Error(`The tessellation worker could not load the WebAssembly module: ${data.error}`))
    })
    // The script failed to load or to run (an ErrorEvent has a message then). After the module has loaded, an error
    // of the worker's is left to the browser
    this.worker.addEventListener('error', (e) => {
      const message = (e as ErrorEvent).message
      loaded(new Error(`The tessellation worker script failed${message ? `: ${message}` : ' to load'}`))
    })
  }

  build(job: BuildJob): void {
    this.worker.postMessage(job)
  }

  terminate(): void {
    this.terminated = true
    this.worker.terminate()
  }
}
