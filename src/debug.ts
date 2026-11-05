// The development tools (the dev page, dev/) reach the layer behind a handle through here. Every call to this file is
// inside `if (__HANDWRITING_DEBUG__)`, which the package's build sets to false, so none of it is in the package.
// Not exported from the package: the dev page imports this file from the source
import type { DropReason, PredictedEvent, Prediction, PredictionDebug } from './Prediction'
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

/**
 * Sets how far ahead of a pointermove a handle's predicted points are drawn, in ms, to compare the latency and tune
 * it on a real pen; 0 drops the predicted points drawn now and draws none
 */
export function setDebugPredictionMs(handle: object, ms: number): void {
  const prediction = predictions.get(handle)
  if (!prediction) return
  prediction.ms = ms
  if (ms === 0) prediction.clear()
}

/** How far ahead of a pointermove a handle's predicted points are drawn now, in ms */
export function debugPredictionMs(handle: object): number | null {
  return predictions.get(handle)?.ms ?? null
}

/**
 * How many of a handle's predicted points were offered, kept and dropped by time and by distance so far, and the time
 * from the latest pointermove to each of its predicted points, to tune the time ahead on a real pen
 */
export function debugPredictionCounts(handle: object): PredictionDebug | null {
  const debug = predictions.get(handle)?.debug
  return debug ? { counts: { ...debug.counts }, aheadMs: [...debug.aheadMs] } : null
}

/**
 * Counts the predicted events `offered` of one pointermove at `timeStamp`: the first `kept` of them were drawn, and the
 * rest were dropped with the first one's reason `dropped`. Keeps the time from the pointermove to each of them
 */
export function countPrediction(
  prediction: Prediction,
  timeStamp: number,
  offered: readonly PredictedEvent[],
  kept: number,
  dropped: DropReason | null,
): void {
  const debug = prediction.debug
  if (!debug) return
  const { counts } = debug
  counts.offered += offered.length
  counts.kept += kept
  if (dropped === 'time') counts.droppedByTime += offered.length - kept
  else if (dropped === 'distance') counts.droppedByDistance += offered.length - kept
  debug.aheadMs = offered.map((e) => e.timeStamp - timeStamp)
}
