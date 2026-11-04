// The dev page's panel (decision 0096), in plain DOM: what the app's debug panel had (decision 0089) and the
// predicted points and the scene's stats
import type { Map as MapLibreMap } from 'maplibre-gl'
import { debugPredictionCounts, debugSceneOf, setDebugPrediction, setDebugWireframe } from '../src/debug'
import type { Handwriting, StrokeStore } from '../src/index'
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
    checkbox('predicted points', (checked) => setDebugPrediction(handle, checked), true),
  )

  // The scene's stats and the predicted points' counts, read twice a second
  const update = (): void => {
    const stats = debugSceneOf(handle)?.stats()
    scene.textContent = stats
      ? `strokes ${stats.strokes} / buckets ${stats.buckets} / meshes ${stats.meshes} / draw calls ${stats.drawCalls} / builds ${stats.builds} / main-thread vertices ${stats.mainThreadVertices} / mesh ${(stats.meshBytesUsed / 1e6).toFixed(1)} MB`
      : 'scene: -'
    const counts = debugPredictionCounts(handle)
    prediction.textContent = counts
      ? `predicted points kept ${counts.kept.join(', ')} / dropped ${counts.dropped.join(', ')}`
      : 'predicted points: -'
  }
  update()
  setInterval(update, 500)
}
