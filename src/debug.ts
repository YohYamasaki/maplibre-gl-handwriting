// The development tools (the dev page, dev/) reach the layer behind a handle through here. Every call to this file is
// inside `if (__HANDWRITING_DEBUG__)`, which the package's build sets to false, so none of it is in the package
// (decision 0096). Not exported from the package: the dev page imports this file from the source
import { MAX_PREDICTED_POINTS, type Prediction, type PredictionCounts } from './Prediction'
import type { StrokeLayer } from './StrokeLayer'
import type { StrokeScene } from './StrokeScene'

/**
 * Logged once by the first handle of a build with the debug code in it. The pack check (tests/tools/pack.mjs) finds
 * this text in a build made with __HANDWRITING_DEBUG__ true and requires it absent from the package
 */
export const DEBUG_BUILD_NOTICE = 'maplibre-gl-handwriting: a debug build (__HANDWRITING_DEBUG__), not for release'

const layers = new WeakMap<object, StrokeLayer>()
const predictions = new WeakMap<object, Prediction>()
let noticed = false

/** Called by createHandwriting when it makes the handle's layer, and with null when the handle is destroyed */
export function registerDebugLayer(handle: object, layer: StrokeLayer | null): void {
  if (!noticed) {
    noticed = true
    console.info(DEBUG_BUILD_NOTICE)
  }
  if (layer) layers.set(handle, layer)
  else layers.delete(handle)
}

/** The scene a handle draws, once its layer is on the map */
export function debugSceneOf(handle: object): StrokeScene | null {
  return layers.get(handle)?.scene ?? null
}

/** Turns the wireframe view of a handle's layer on or off: the outlines of the tessellated triangles */
export function setDebugWireframe(handle: object, wireframe: boolean): void {
  layers.get(handle)?.setWireframe(wireframe)
}

/** Called by createHandwriting with the predicted points its strokes being drawn are drawn with */
export function registerDebugPrediction(handle: object, prediction: Prediction): void {
  predictions.set(handle, prediction)
}

/** Turns the drawing of the browser's predicted points of a handle off or back on, to compare the latency */
export function setDebugPrediction(handle: object, enabled: boolean): void {
  const prediction = predictions.get(handle)
  if (!prediction?.debug) return
  prediction.debug.on = enabled
  if (!enabled) prediction.clear()
}

/** How many of a handle's 1st and 2nd predicted points were kept and dropped so far, to tune the limit on a real pen */
export function debugPredictionCounts(handle: object): PredictionCounts | null {
  const counts = predictions.get(handle)?.debug?.counts
  return counts ? { kept: [...counts.kept], dropped: [...counts.dropped] } : null
}

/** Counts the predicted points of one pointermove: `offered` the browser gave (first MAX_PREDICTED_POINTS), `kept` of them */
export function countPrediction(prediction: Prediction, offered: number, kept: number): void {
  const counts = prediction.debug?.counts
  if (!counts) return
  for (let i = 0; i < Math.min(offered, MAX_PREDICTED_POINTS); i++) {
    if (i < kept) counts.kept[i]++
    else counts.dropped[i]++
  }
}
