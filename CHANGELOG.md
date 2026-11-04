# Changelog

The package follows semantic versioning for 0.x versions: a release that changes the public API (the exports of
`maplibre-gl-handwriting` and `maplibre-gl-handwriting/core`, recorded in `tests/snapshots/public-api.txt`) raises
the minor version; any other release raises the patch version. The options under `experimental` are not part of
the versioned API and may change in any release.

## 0.1.0

- First version: `createHandwriting` (pen, highlighter, eraser, lasso and laser pointer tools, undo and redo,
  keyboard shortcuts, GeoJSON export), `HandwritingToolbar(handle)`, `HandwritingLayer` (a custom layer that only
  draws a store's strokes, added with `map.addLayer`), `StrokeStore` with the `default` and `custom` order modes,
  `LaserChannel`, `parseDefaults`, `strokesToGeoJSON`, and the DOM-free `maplibre-gl-handwriting/core` entry.
- The handle adds its layer again after a `setStyle` that rebuilds the style, waits for its `beforeId` layer instead
  of going on top, and frees the layer's worker and GPU resources on `destroy()`, also after `map.remove()`.
- `tools` (`createHandwriting`'s option) chooses the tools a handle offers, and `getTools()` returns them: `setTool`
  throws a `RangeError` for the others, and the toolbar, the keyboard shortcuts and their list leave them out.
- A WebAssembly module or tessellation worker that fails to load, or a worker that cannot be made, is the map's
  `error` event `{ error, layerId }` (on the console when nothing listens for it) and rejects `ready`, which resolves
  once the module has loaded on the main thread and in the layer's first worker.
- Experimental: the partial eraser (`experimental.partialEraser`).
