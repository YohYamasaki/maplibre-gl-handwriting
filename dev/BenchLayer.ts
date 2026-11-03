// Generated strokes for load tests (decision 0089): a store of their own, drawn by a second handle without tools, so
// sync, selection, the eraser and undo never touch them
import type { Map as MapLibreMap } from 'maplibre-gl'
import { setDebugWireframe } from '../src/debug'
import { createHandwriting, StrokeStore, type Handwriting } from '../src/index'
import { benchBounds, generateBenchStrokes } from './benchStrokes'

export const BENCH_LAYER_ID = 'handwriting-bench'
/** The app's handle's layer, which the generated strokes go under */
export const MAIN_LAYER_ID = 'handwriting'

export class BenchLayer {
  readonly store = new StrokeStore()
  private handle: Handwriting | null = null
  private wireframe = false

  /**
   * `onLayer` is called once the second handle has made its layer, which it adds to a loaded style at once, before the
   * layer is first drawn (e.g. for Canvas2D to hide it). `create` makes the handle; the tests pass one that needs no WebGL
   */
  constructor(
    private readonly map: MapLibreMap,
    private readonly onLayer: () => void = () => {},
    private readonly create: typeof createHandwriting = createHandwriting,
  ) {}

  /**
   * Draws the generated strokes as wireframes or filled, now and once the handle a later show makes has its layer
   * (the layer is made after the WebAssembly module loads, and setDebugWireframe reaches only a layer that exists)
   */
  setWireframe(wireframe: boolean): void {
    this.wireframe = wireframe
    if (this.handle) setDebugWireframe(this.handle, wireframe)
  }

  /** Replaces the generated strokes with `count` new ones around the current view */
  show(count: number): void {
    if (!this.handle) {
      const handle = this.create(this.map, { store: this.store, layerId: BENCH_LAYER_ID, beforeId: MAIN_LAYER_ID })
      this.handle = handle
      // ready resolves once the layer is made, before it is drawn; a destroyed handle has no layer to set
      void handle.ready.then(() => {
        if (this.handle !== handle) return
        setDebugWireframe(handle, this.wireframe)
        this.onLayer()
      })
    }
    const strokes = generateBenchStrokes(count, benchBounds(this.map), this.map.getZoom(), Math.random)
    // Saved strokes reach the app by load, which puts them in buckets tessellated by the worker (decision 0090);
    // the reset first drops the last show's strokes, whose IDs load would skip
    this.store.apply({ type: 'reset', strokes: [] }, 'remote')
    this.store.apply({ type: 'load', strokes }, 'remote')
  }

  hide(): void {
    this.store.apply({ type: 'reset', strokes: [] }, 'remote')
  }

  destroy(): void {
    this.hide()
    this.handle?.destroy()
    this.handle = null
  }
}
