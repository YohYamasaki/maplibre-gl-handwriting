// Measures the stroke layers (decision 0089): two custom layers that draw nothing, one under the generated strokes'
// layer and one over the app's, time what MapLibre does between them, on the CPU with performance.now() and on the
// GPU with EXT_disjoint_timer_query_webgl2 where the browser has it
import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl'
import { BENCH_LAYER_ID, MAIN_LAYER_ID } from './BenchLayer'

const START_ID = 'handwriting-timer-start'
const END_ID = 'handwriting-timer-end'

type TimerQueryExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

export class StrokeTimer {
  private extension: TimerQueryExtension | null = null
  private startedAt: number | null = null
  /** The query begun under the layers, ended over them */
  private active: WebGLQuery | null = null
  /** Ended queries whose results the GPU has not given yet, oldest first */
  private pending: WebGLQuery[] = []
  private gl: WebGL2RenderingContext | null = null
  private paused = false
  private added = false

  /**
   * `onCpu` and `onGpu` get each frame's time between the two layers, in ms; the GPU's arrives a few frames late.
   * The layers are added once the app's layer is on the map
   */
  constructor(
    private readonly map: MapLibreMap,
    private readonly onCpu: (ms: number) => void,
    private readonly onGpu: (ms: number) => void,
  ) {
    map.on('render', this.tryAdd)
    this.tryAdd()
  }

  /** Whether the browser can time the GPU; known once the layers were added */
  get measuresGpu(): boolean {
    return this.extension !== null
  }

  /** Stops measuring while nothing is drawn between the layers (Canvas2D) */
  setPaused(paused: boolean): void {
    this.paused = paused
  }

  destroy(): void {
    this.map.off('render', this.tryAdd)
    for (const id of [START_ID, END_ID]) if (this.map.getLayer(id)) this.map.removeLayer(id)
  }

  /**
   * Adds the start layer under the generated strokes' layer, or right under the app's layer when there is none yet
   * (the generated strokes' layer then goes in between), and the end layer right over the app's layer
   */
  private readonly tryAdd = (): void => {
    if (this.added || !this.map.getLayer(MAIN_LAYER_ID)) return
    this.added = true
    this.map.off('render', this.tryAdd)
    const order = this.map.getLayersOrder()
    const above = order[order.indexOf(MAIN_LAYER_ID) + 1]
    this.map.addLayer(this.startLayer(), this.map.getLayer(BENCH_LAYER_ID) ? BENCH_LAYER_ID : MAIN_LAYER_ID)
    this.map.addLayer(this.endLayer(), above)
  }

  private startLayer(): CustomLayerInterface {
    return {
      id: START_ID,
      type: 'custom',
      onAdd: (_map, gl) => {
        this.gl = gl
        this.extension = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExtension | null
      },
      onRemove: (_map, gl) => {
        if (this.active) gl.deleteQuery(this.active)
        for (const query of this.pending) gl.deleteQuery(query)
        this.active = null
        this.pending = []
      },
      render: (gl) => {
        if (this.paused) return
        this.startedAt = performance.now()
        if (this.extension && !this.active) {
          const query = gl.createQuery()
          if (query) {
            gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query)
            this.active = query
          }
        }
      },
    }
  }

  private endLayer(): CustomLayerInterface {
    return {
      id: END_ID,
      type: 'custom',
      render: (gl) => {
        if (this.startedAt !== null) this.onCpu(performance.now() - this.startedAt)
        this.startedAt = null
        if (this.extension && this.active) {
          gl.endQuery(this.extension.TIME_ELAPSED_EXT)
          this.pending.push(this.active)
          this.active = null
        }
        this.readResults()
      },
    }
  }

  /** Reads the queries the GPU has finished; drops them all when the GPU's timing was disjoint (e.g. a clock change) */
  private readResults(): void {
    const { gl, extension } = this
    if (!gl || !extension) return
    const disjoint = gl.getParameter(extension.GPU_DISJOINT_EXT) as boolean
    while (this.pending.length > 0) {
      const query = this.pending[0]
      if (!disjoint && !(gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) as boolean)) break
      this.pending.shift()
      if (!disjoint) this.onGpu((gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6)
      gl.deleteQuery(query)
    }
  }
}
