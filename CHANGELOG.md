# Changelog

A release that changes the public API (the exports of `maplibre-gl-handwriting` and `maplibre-gl-handwriting/core`)
raises the minor version while the package is at 0.x, any other release the patch version. The options under
`experimental` are outside this and may change in any release.

## Unreleased

- A stroke's points are a `Float64Array` of x and y in turn (`x0, y0, x1, y1, …`) in `StrokeData.points` and in the
  `pts` of a `points` op, and its width coefficients a `Float32Array` in `StrokeData.pressure` and `ps`: a stroke of 40
  points keeps about 21 bytes a point instead of about 74. `appendPoints`, `cutStroke`, `erasedIntervals`,
  `keptRanges`, `piecePoints` and `transformStroke` of `maplibre-gl-handwriting/core` take and give points the same
  way. `store.apply` does not take points of another type or of an odd length, nor width coefficients that are not a
  `Float32Array` of one per point: a `points` op or a `restore` with them returns false, and a `load`, `reset` or
  `replace` leaves those strokes out. While a stroke is drawn its arrays grow 32 points at a time; its end copies them
  to their exact length.
- Migrating: `JSON.stringify` writes a typed array as an object (`{"0": …}`), so an app that sends ops or saves strokes
  as JSON turns the points and coefficients of the stroke ops that carry them (`pts` and `ps` of a `points` op, the
  `points` and `pressure` of the strokes of a `load`, `reset`, `replace` or `restore`) into arrays with `Array.from`
  before, and back with `new Float64Array` and `new Float32Array` after, op by op (the sync example in docs/usage.md
  does both); the `pts` of a laser op stay `[x, y]` pairs. Points saved as `[x, y]` pairs by an earlier version are
  `new Float64Array(points.flat())`, and their coefficients `new Float32Array(pressure)`. A client of an earlier
  version and one of this version cannot share strokes.
- A slowly drawn stroke keeps fewer points: the input is recorded once the pointer has moved min(pen width, 4 px) on
  screen, at corners and turns (no skipped input farther than 0.5 px from the recorded line), and when the pen's
  pressure changes, so its mesh and the ops sent and kept are a fraction of what they were.
- The browser's predicted points are drawn up to 20 ms ahead of each pointer input, however many there are, and within
  how far the pointer goes in that time at its speed (at most 24 px), instead of the first two within how far it moved.
- Experimental: `experimental.predictionMs`, how far ahead the predicted points are drawn (0 to 25 ms, 0 for none).

## 0.1.0

- `createHandwriting` with a pen, a highlighter, an eraser, a lasso and a laser pointer, undo and redo, keyboard
  shortcuts and GeoJSON export; `tools` chooses the tools offered, and `HandwritingToolbar` is their toolbar.
- `HandwritingLayer` only draws a store's strokes; `StrokeStore` (orders given by the store or by your code),
  `LaserChannel`, `parseDefaults`, `strokesToGeoJSON`, and the DOM-free `maplibre-gl-handwriting/core` entry.
- A worker or WebAssembly module that fails to load is the map's `error` event `{ error, layerId }` and rejects `ready`.
- Draws also on a page that is not a secure context.
- Experimental: the partial eraser (`experimental.partialEraser`).
