# Changelog

A release that changes the public API (the exports of `maplibre-gl-handwriting` and `maplibre-gl-handwriting/core`)
raises the minor version while the package is at 0.x, any other release the patch version. The options under
`experimental` are outside this and may change in any release.

## Unreleased

- A slowly drawn stroke keeps fewer points: the input is recorded once the pointer has moved min(pen width, 4 px) on
  screen, at corners and turns (no skipped input farther than 0.5 px from the recorded line), and when the pen's
  pressure changes, so its mesh and the ops sent and kept are a fraction of what they were.

## 0.1.0

- `createHandwriting` with a pen, a highlighter, an eraser, a lasso and a laser pointer, undo and redo, keyboard
  shortcuts and GeoJSON export; `tools` chooses the tools offered, and `HandwritingToolbar` is their toolbar.
- `HandwritingLayer` only draws a store's strokes; `StrokeStore` (orders given by the store or by your code),
  `LaserChannel`, `parseDefaults`, `strokesToGeoJSON`, and the DOM-free `maplibre-gl-handwriting/core` entry.
- A worker or WebAssembly module that fails to load is the map's `error` event `{ error, layerId }` and rejects `ready`.
- Draws also on a page that is not a secure context.
- Experimental: the partial eraser (`experimental.partialEraser`).
