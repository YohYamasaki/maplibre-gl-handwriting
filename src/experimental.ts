// The experimental features a handle was created with (decision 0085), for the package's own toolbar. Kept off
// the handle's public functions, so that turning a feature on stays an option of createHandwriting only

/** Features that are off unless HandwritingOptions.experimental turns them on */
export type ExperimentalFeatures = {
  /** The partial eraser (EraserMode 'partial'), whose behavior is to be reworked. Default false */
  partialEraser?: boolean
}

const features = new WeakMap<object, Required<ExperimentalFeatures>>()

/** Called by createHandwriting with the features its handle was created with */
export function registerExperimental(handle: object, experimental: ExperimentalFeatures = {}): void {
  features.set(handle, { partialEraser: experimental.partialEraser === true })
}

/** The features `handle` was created with; all off for a handle createHandwriting did not make */
export function experimentalOf(handle: object): Required<ExperimentalFeatures> {
  return features.get(handle) ?? { partialEraser: false }
}
