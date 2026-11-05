# Changelog

A release that changes the public API (the exports of `maplibre-gl-handwriting` and `maplibre-gl-handwriting/core`)
raises the minor version while the package is at 0.x, any other release the patch version. The options under
`experimental` are outside this and may change in any release.

## 0.1.0

- `createHandwriting` with a pen, a highlighter, an eraser, a lasso and a laser pointer, undo and redo, keyboard
  shortcuts and GeoJSON export; `tools` chooses the tools offered, and `HandwritingToolbar` is their toolbar.
  `handwriting.exportGeoJSON()` returns a `Promise<string>`, once the points are read back; Export in the selection's
  bar waits for them too.
- `HandwritingLayer` only draws a store's strokes; `StrokeStore` (orders given by the store or by your code),
  `LaserChannel`, `parseDefaults`, `strokesToGeoJSON`, and the DOM-free `maplibre-gl-handwriting/core` entry.
- A stroke's points are a `Float64Array` of x and y in turn (`x0, y0, x1, y1, …`) in `StrokeData.points` and in the
  `pts` of a `points` op, and its width coefficients a `Float32Array` in `StrokeData.pressure` and `ps`.
  `appendPoints`, `cutStroke`, `erasedIntervals`, `keptRanges`, `piecePoints` and `transformStroke` of
  `maplibre-gl-handwriting/core` take and give points the same way. `store.apply` does not take points of another type
  or of an odd length, nor width coefficients that are not a `Float32Array` of one per point: a `points` op or a
  `restore` with them returns false, and a `load`, `reset` or `replace` leaves those strokes out. An app that sends or
  saves ops as JSON turns these arrays into arrays of numbers and back (docs/usage.md). While a stroke is drawn its
  arrays grow 32 points at a time; its end copies them to their exact length.
- A layer that draws a store (`createHandwriting`, `HandwritingLayer`) writes the points of the finished strokes far
  from its view to IndexedDB, in a browser with IndexedDB and Web Locks, and reads them back as the view comes near
  (see docs/usage.md). The strokes of a `load`, `reset` or `restore` count as finished; a stroke of more than 2^17
  (131,072) points stays in memory. While they are out, a stroke's `points`, and `pressure` for one drawn with
  pressure, are `null` (`StrokeData`), so an app that saves or sends the strokes of `store.values()` or `store.get()`
  reads them with `store.read` first (docs/usage.md). In `StrokeStore`, `read(ids)` gives strokes with their points
  read back, `hold(ids)` and `release(ids)` keep points in memory, `extent(id)` gives where a stroke is, and
  `new StrokeStore({ spill: false })` keeps every point in memory. Ops that need spilled points (`points`, `split`,
  `transform`, `replace`) wait for them stroke by stroke, as do the later ops on the same strokes: `apply` returns true
  for them, the part of a `load`, `transform` or `replace` on the other strokes applies at once, and each stroke that
  waits comes to the subscribers later as an op of its own. `strokesToGeoJSON` leaves out strokes without their points,
  and `transformStroke` gives null for them.
- A worker or WebAssembly module that fails to load is the map's `error` event `{ error, layerId }` and rejects
  `ready`; a database for the spilled points that cannot be opened or written is the same `error` event, and the
  points then stay in memory.
- A stroke's pointer input is recorded once the pointer has moved min(pen width, 4 px) on screen, at corners and turns
  (no skipped input farther than 0.5 px from the recorded line), and when the pen's pressure changes.
- The browser's predicted points are drawn after the tip of the stroke being drawn, up to 20 ms ahead of each pointer
  input and within how far the pointer goes in that time at its speed (at most 24 px).
- Draws also on a page that is not a secure context.
- Experimental: the partial eraser (`experimental.partialEraser`), and how far ahead the predicted points are drawn
  (`experimental.predictionMs`, 0 to 25 ms, 0 for none).
