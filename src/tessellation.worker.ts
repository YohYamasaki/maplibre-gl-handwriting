// Web Worker entry: tessellates whole buckets for TessellationWorker and transfers the meshes back
import { StrokeTessellator } from './StrokeTessellator'
import { buildBucketMesh, type BuildJob, type BuildResult, type TessellationInit } from './TessellationWorker'

// The DOM typings describe `self` as a Window; these are the two members of the worker scope used here
const scope = self as unknown as {
  addEventListener(type: 'message', listener: (e: MessageEvent<BuildJob | TessellationInit>) => void): void
  postMessage(message: BuildResult, transfer: Transferable[]): void
}

// Loaded on the first message: a TessellationInit names the module, and a job before any uses the default
let tessellatorReady: Promise<StrokeTessellator> | null = null

scope.addEventListener('message', async ({ data }) => {
  if ('wasmUrl' in data) {
    tessellatorReady ??= StrokeTessellator.load(data.wasmUrl)
    return
  }
  tessellatorReady ??= StrokeTessellator.load()
  const { result, transfer } = buildBucketMesh(await tessellatorReady, data)
  scope.postMessage(result, transfer)
})
