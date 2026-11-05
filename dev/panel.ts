// The dev page's panel (decision 0096), in plain DOM: what the app's debug panel had (decision 0089), the time ahead
// the predicted points are drawn (decision 0021) and their counts, and the scene's stats
import type { Map as MapLibreMap } from 'maplibre-gl'
import {
  debugPredictionCounts,
  debugPredictionMs,
  debugSceneOf,
  setDebugPredictionMs,
  setDebugWireframe,
} from '../src/debug'
import type { Handwriting, StrokeStore } from '../src/index'
import { MAX_PREDICTION_MS } from '../src/Prediction'
import { BENCH_LAYER_ID, BenchLayer, MAIN_LAYER_ID } from './BenchLayer'
import { Canvas2DStrokes } from './Canvas2DStrokes'
import { FrameMeter } from './FrameMeter'
import { StrokeTimer } from './StrokeTimer'

const COUNTS = [1000, 4000, 10000, 50000]

/** A labelled checkbox calling `onChange` with its state */
function checkbox(text: string, onChange: (checked: boolean) => void, checked = false): HTMLLabelElement {
  const label = document.createElement('label')
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = checked
  input.addEventListener('change', () => onChange(input.checked))
  label.append(input, ` ${text}`)
  return label
}

/**
 * A slider of the time ahead the handle's predicted points are drawn, from 0 to MAX_PREDICTION_MS ms by 1 ms, with
 * its value; `sync` shows the handle's value again
 */
function predictionSlider(handle: Handwriting): { label: HTMLLabelElement; sync: () => void } {
  const label = document.createElement('label')
  const input = document.createElement('input')
  input.type = 'range'
  input.min = '0'
  input.max = String(MAX_PREDICTION_MS)
  input.step = '1'
  input.setAttribute('aria-label', 'time ahead of the predicted points, in ms')
  const text = document.createElement('span')
  const sync = (): void => {
    const value = debugPredictionMs(handle)
    if (value !== null && input.valueAsNumber !== value) input.value = String(value)
    text.textContent = ` prediction ${value ?? '-'} ms`
  }
  input.addEventListener('input', () => {
    setDebugPredictionMs(handle, input.valueAsNumber)
    sync()
  })
  label.append(input, text)
  sync()
  return { label, sync }
}

function ms(value: number | null): string {
  return value === null ? '-' : value.toFixed(2)
}

/** Adds the panel to `parent`, for the handle's layer on `map` drawing `store` */
export function mountPanel(parent: HTMLElement, handle: Handwriting, map: MapLibreMap, store: StrokeStore): void {
  const panel = document.createElement('div')
  panel.className = 'dev-panel'
  const controls = document.createElement('div')
  controls.className = 'controls'
  const frames = document.createElement('p')
  const scene = document.createElement('p')
  const prediction = document.createElement('p')
  panel.append(controls, frames, scene, prediction)
  parent.append(panel)

  let wireframe = false
  let generated = false
  let count = COUNTS[0]
  let canvas: Canvas2DStrokes | null = null
  let bench: BenchLayer | null = null
  let canvas2d = false

  const meter = new FrameMeter((stats) => {
    frames.textContent = `${stats.fps} fps / CPU ${ms(stats.cpu)} ms / GPU ${canvas2d ? '-' : ms(stats.gpu)} ms`
  })
  const timer = new StrokeTimer(
    map,
    (value) => meter.addCpu(value),
    (value) => meter.addGpu(value),
  )

  const slider = predictionSlider(handle)

  // A bench layer made while Canvas2D is on is hidden before its first frame
  const benchLayer = (): BenchLayer => (bench ??= new BenchLayer(map, () => canvas?.hideLayers()))

  const select = document.createElement('select')
  select.setAttribute('aria-label', 'number of load test strokes')
  for (const n of COUNTS) select.add(new Option(n.toLocaleString('en'), String(n)))
  select.addEventListener('change', () => {
    count = Number(select.value)
    if (generated) benchLayer().show(count)
  })
  const load = document.createElement('span')
  load.append(
    checkbox('load test strokes', (checked) => {
      generated = checked
      if (generated) benchLayer().show(count)
      else bench?.hide()
    }),
    ' ',
    select,
  )

  controls.append(
    checkbox('wireframe', (checked) => {
      wireframe = checked
      setDebugWireframe(handle, wireframe)
      benchLayer().setWireframe(wireframe)
    }),
    checkbox('repaint every frame', (checked) => {
      map.repaint = checked
    }),
    load,
    checkbox('Canvas2D', (checked) => {
      canvas2d = checked
      meter.clear()
      timer.setPaused(canvas2d)
      if (canvas2d) {
        canvas = new Canvas2DStrokes(map, [benchLayer().store, store], [BENCH_LAYER_ID, MAIN_LAYER_ID], (value) =>
          meter.addCpu(value),
        )
      } else {
        canvas?.destroy()
        canvas = null
      }
    }),
    slider.label,
  )

  // The scene's stats, the time ahead (window.__handwriting may change it) and the predicted points' counts, read twice
  // a second
  const update = (): void => {
    const stats = debugSceneOf(handle)?.stats()
    scene.textContent = stats
      ? `strokes ${stats.strokes} / buckets ${stats.buckets} / meshes ${stats.meshes} / draw calls ${stats.drawCalls} / builds ${stats.builds} / main-thread vertices ${stats.mainThreadVertices} / mesh ${(stats.meshBytesUsed / 1e6).toFixed(1)} MB`
      : 'scene: -'
    slider.sync()
    const debug = debugPredictionCounts(handle)
    if (debug) {
      const { offered, kept, droppedByTime, droppedByDistance } = debug.counts
      const ahead = debug.aheadMs.map((value) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}`).join(' ')
      prediction.textContent = `predicted points offered ${offered} / kept ${kept} / dropped by time ${droppedByTime} / by distance ${droppedByDistance} / ahead ${ahead || '-'} ms`
    } else prediction.textContent = 'predicted points: -'
  }
  update()
  setInterval(update, 500)
}
