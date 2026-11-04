// The package's entry (maplibre-gl-handwriting): the input and render layers on a MapLibre map.
// May depend only on src/core, maplibre-gl (a peer dependency) and its own WebAssembly module
export {
  createHandwriting,
  type Handwriting,
  type HandwritingEventMap,
  type HandwritingListener,
  type HandwritingOptions,
  type StrokeIdentity,
  type Tool,
} from './createHandwriting'
export type {
  EraserMode,
  EraserSettings,
  HandwritingDefaults,
  HandwritingSettings,
  LaserSettings,
  Pen,
  PenTool,
  PressureCurve,
  ToolbarEdge,
  ToolbarSettings,
} from './pens'
// Checks saved settings before they are passed back as defaults
export { parseDefaults } from './pens'
// The features still being tried out, each off unless turned on
export type { ExperimentalFeatures } from './experimental'
// The store is the caller's: it is created by the caller and may be shared with its own sync code
export {
  StrokeStore,
  type StrokeOrderMode,
  type StrokeStoreOptions,
  type Origin,
  type Point,
  type StrokeData,
  type StrokeListener,
  type StrokeOp,
} from './core/stroke'
// The laser pointer's channel is the caller's, like the store
export { LaserChannel, type LaserListener, type LaserOp, type LaserOrigin } from './core/laser'
export type { PieceRange, StrokePiece } from './core/split'
// The transform op's matrix
export type { Matrix } from './core/transform'
// Strokes as GeoJSON, for strokes the caller chooses
export { strokesToGeoJSON } from './core/geojson'
// The toolbar control; its styles are the package's style.css (ui/toolbar.css), which the user loads
export { HandwritingToolbar } from './ui/Toolbar'
// The layer that only draws a store's strokes, for maps without the tools or to order it among the style's layers
export { HandwritingLayer, type HandwritingLayerOptions } from './HandwritingLayer'
