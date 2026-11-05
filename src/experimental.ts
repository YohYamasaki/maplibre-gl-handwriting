// The experimental features and values a handle was created with, for the package's own toolbar. Kept off
// the handle's public functions, so that turning a feature on stays an option of createHandwriting only
import { DEFAULT_PREDICTION_MS, MAX_PREDICTION_MS } from './Prediction'

/** Features still being worked on, off unless HandwritingOptions.experimental turns them on, and values still being tuned */
export type ExperimentalFeatures = {
  /** The partial eraser (EraserMode 'partial'), whose behavior is to be reworked. Default false */
  partialEraser?: boolean
  /**
   * How far ahead of each pointer input the browser's predicted points are drawn after the tip of the stroke being
   * drawn, in ms; 0 draws none. Fixed when the handle is created. Default 20; createHandwriting throws a RangeError
   * for a value that is not a number from 0 to 25
   */
  predictionMs?: number
}

const features = new WeakMap<object, Required<ExperimentalFeatures>>()

/** The time ahead `experimental` gives, or the default. Throws a RangeError for a value that is not a number from 0 to 25 */
export function predictionMsOf(experimental: ExperimentalFeatures = {}): number {
  const ms = experimental.predictionMs
  if (ms === undefined) return DEFAULT_PREDICTION_MS
  if (typeof ms !== 'number' || !(ms >= 0 && ms <= MAX_PREDICTION_MS))
    throw new RangeError(`experimental.predictionMs must be a number from 0 to ${MAX_PREDICTION_MS}, not ${String(ms)}`)
  return ms
}

/**
 * Called by createHandwriting with the features its handle was created with, and the time ahead predictionMsOf gave
 * for them
 */
export function registerExperimental(handle: object, experimental: ExperimentalFeatures, predictionMs: number): void {
  features.set(handle, { partialEraser: experimental.partialEraser === true, predictionMs })
}

/** The features `handle` was created with; all off and the default values for a handle createHandwriting did not make */
export function experimentalOf(handle: object): Required<ExperimentalFeatures> {
  return features.get(handle) ?? { partialEraser: false, predictionMs: DEFAULT_PREDICTION_MS }
}
