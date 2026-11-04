// Web Worker entry: tessellates whole buckets for TessellationWorker and transfers the meshes back
import { StrokeTessellator } from './StrokeTessellator'
import {
  buildBucketMesh,
  type BuildJob,
  type BuildResult,
  type TessellationInit,
  type TessellationLoad,
} from './TessellationWorker'

// The DOM typings describe `self` as a Window; these are the two members of the worker scope used here
const scope = self as unknown as {
  addEventListener(type: 'message', listener: (e: MessageEvent<BuildJob | TessellationInit>) => void): void
  postMessage(message: BuildResult | TessellationLoad, transfer: Transferable[]): void
}

// Loaded on the first message: a TessellationInit names the module, and a job before any uses the default. null
// when the module failed to load: the jobs then get no answer
let tessellatorReady: Promise<StrokeTessellator | null> | null = null

/** Loads the module and says once whether it loaded, before any BuildResult */
function load(wasmUrl?: string): Promise<StrokeTessellator | null> {
  return StrokeTessellator.load(wasmUrl).then(
    (tessellator) => {
      scope.postMessage({ loaded: true } satisfies TessellationLoad, [])
      return tessellator
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      scope.postMessage({ loaded: false, error: message } satisfies TessellationLoad, [])
      return null
    },
  )
}

scope.addEventListener('message', async ({ data }) => {
  if ('wasmUrl' in data) {
    tessellatorReady ??= load(data.wasmUrl)
    return
  }
  tessellatorReady ??= load()
  const tessellator = await tessellatorReady
  if (!tessellator) return
  const { result, transfer } = buildBucketMesh(tessellator, data)
  scope.postMessage(result, transfer)
})
