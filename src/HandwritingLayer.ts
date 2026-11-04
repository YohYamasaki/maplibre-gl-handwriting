import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl'
import type { StrokeStore } from './core/stroke'
import { asError, reportError } from './reportError'
import { holdsLayer, StrokeLayer } from './StrokeLayer'
import { StrokeTessellator } from './StrokeTessellator'

export type HandwritingLayerOptions = {
  /** The strokes to draw. The layer only reads the store: put the strokes in it with ops, e.g. a load op */
  store: StrokeStore
  /** The layer's ID in the map style. Required, so that it never takes createHandwriting's default 'handwriting' */
  id: string
  /** Where to fetch the WebAssembly module from, instead of next to this script */
  wasmUrl?: string | URL
  /** Where to load the tessellation worker script from, instead of next to this script */
  workerUrl?: string | URL
}

/**
 * A MapLibre custom layer that only draws the strokes of a store: no tools, no pointer input and no DOM. For a map
 * that shows strokes without editing them, or to place the strokes among the style's layers yourself:
 * `map.addLayer(new HandwritingLayer({ store, id: 'strokes' }), beforeId)`.
 *
 * The WebAssembly module starts loading on the first onAdd; nothing is drawn until it has loaded, and then the map is
 * repainted. A module or a tessellation worker that fails to load is the map's error event, `{ error, layerId }` (on
 * the console when nothing listens for it), and the layer then draws nothing, also when added again. MapLibre calls no
 * onRemove when it rebuilds the style (setStyle without a diff) or when the map is removed: add the layer again after
 * such a setStyle (e.g. on style.load), and call destroy once it is no longer wanted, which frees its worker and GPU
 * resources whether or not it is still on the map.
 *
 * A store given to both a HandwritingLayer and createHandwriting is drawn, and tessellated, twice
 */
export class HandwritingLayer implements CustomLayerInterface {
  readonly id: string
  readonly type = 'custom'
  readonly renderingMode = '2d'
  /**
   * Resolves once the WebAssembly module has loaded on the main thread and in the first of the layer's tessellation
   * workers to answer; the loading starts on the first onAdd and the worker is made by an onAdd, so it never resolves
   * for a layer never added to a map. Rejects when either fails to load, and the layer then draws nothing. A worker
   * that fails after it has settled (one made after a style was rebuilt) is only the map's error event. Resolves on
   * destroy when it has not settled yet
   */
  readonly ready: Promise<void>

  private resolveReady!: () => void
  private rejectReady!: (error: unknown) => void
  // The layer that draws, made once the module has loaded and reused by every onAdd after that
  private inner: StrokeLayer | null = null
  // The map and context of the latest onAdd, until onRemove
  private added: { map: MapLibreMap; gl: WebGL2RenderingContext } | null = null
  // Bumped by every onAdd and onRemove, so the load, which resolves later, sees whether either came meanwhile
  private generation = 0
  private loadStarted = false
  private destroyed = false

  constructor(private readonly options: HandwritingLayerOptions) {
    this.id = options.id
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // No one has to wait for it: a module that fails to load is not an unhandled rejection
    this.ready.catch(() => {})
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    if (this.destroyed) return
    this.generation++
    const added = { map, gl }
    this.added = added
    if (this.inner) {
      // Also after a style rebuilt without onRemove: the inner layer frees what its last onAdd made first
      this.inner.onAdd(map, gl)
      return
    }
    // Once only, also when it failed: then the layer stays empty
    if (this.loadStarted) return
    this.loadStarted = true
    const generation = this.generation
    StrokeTessellator.load(this.options.wasmUrl).then(
      (tessellator) => {
        if (this.destroyed) return
        const { store, id, wasmUrl, workerUrl } = this.options
        // Nothing here throws: the inner layer's onAdd gives a worker that cannot be made to onLoad
        this.inner = new StrokeLayer(store, tessellator, {
          id,
          wasmUrl,
          workerUrl,
          onLoad: (error, on) => this.loaded(error, on),
        })
        // Unless onAdds and onRemoves came while loading, the onAdd that began the load still holds the layer; else the
        // latest decides, and a layer removed then is only made here, for its next onAdd to add
        const target = generation === this.generation ? added : this.added
        if (!target) return
        this.inner.onAdd(target.map, target.gl)
        target.map.triggerRepaint()
      },
      // Told on the map the layer is on, or else on the one whose onAdd began the load
      (error: unknown) => this.loaded(asError(error), this.added?.map ?? map),
    )
  }

  /** A load on the main thread or in a worker: settles ready unless it has settled, and reports a failure */
  private loaded(error: Error | null, map: MapLibreMap): void {
    if (this.destroyed) return
    if (!error) {
      this.resolveReady()
      return
    }
    reportError(map, error, this.id)
    this.rejectReady(error)
  }

  onRemove(): void {
    this.generation++
    this.added = null
    this.inner?.onRemove()
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    // Nothing until the module has loaded, nor when it failed to
    this.inner?.render(gl, options)
  }

  /**
   * Removes the layer from the map when it is on the map's style, and frees its worker, its store subscription and its
   * GPU resources also when it is not (the style was rebuilt without it, or the map removed). The layer draws nothing
   * after this, even when added again
   */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    // Nothing is told after this; a ready still waiting resolves
    this.resolveReady()
    const map = this.added?.map
    // removeLayer calls onRemove, which frees the inner layer with the map's context. A layer of another with this ID
    // (added after a style rebuilt without this one) stays
    if (map && holdsLayer(map, this)) map.removeLayer(this.id)
    this.inner?.dispose()
    this.inner = null
    this.added = null
  }
}
