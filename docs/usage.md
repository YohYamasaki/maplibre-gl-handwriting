# Using maplibre-gl-handwriting

## Setup

```sh
npm install maplibre-gl maplibre-gl-handwriting
```

Load the toolbar's styles once, next to MapLibre's:

```ts
import 'maplibre-gl/dist/maplibre-gl.css'
import 'maplibre-gl-handwriting/style.css'
```

### Bundlers

The package starts a tessellation worker and fetches a WebAssembly module, both found next to its own script
(`new URL(..., import.meta.url)`). A bundler that copies such assets keeps this working; one that rewrites the
package into another file can lose them.

With Vite, exclude the package from dependency pre-bundling:

```ts
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  optimizeDeps: { exclude: ['maplibre-gl-handwriting'] },
})
```

Without this, the dev server serves the package from its pre-bundle cache, where the worker and the module are not.
`vite build` does not need it.

MapLibre GL JS 6 also needs its own worker's URL under Vite:

```ts
import { setWorkerUrl } from 'maplibre-gl'
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

setWorkerUrl(mapLibreWorkerUrl)
```

When the assets are served from somewhere else, pass `wasmUrl` and `workerUrl` (below).

## createHandwriting(map, options)

Adds a layer that draws the strokes of `options.store` and turns pointer input on the map into edits of that store
with the selected tool. It returns a handle. The layer is added once the WebAssembly module is loaded and the
style has loaded; `handle.ready` resolves when the module is loaded.

```ts
const store = new StrokeStore()
const handwriting = createHandwriting(map, { store, author: 'alice', keyboard: true })
await handwriting.ready
handwriting.setTool('pen')
```

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `store` | (required) | The `StrokeStore` to draw and edit. The handle loads nothing itself |
| `startStroke` | random UUIDs | Called on every pointerdown with a drawing tool; returns `{ id, author }` for the new stroke, or `null` to ignore the input. Also called for the ID of each piece the partial eraser leaves |
| `author` | | Author of new strokes when `startStroke` is omitted |
| `layerId` | `'handwriting'` | ID of the map layer |
| `beforeId` | on top | The layer is inserted before this layer |
| `defaults` | see below | Initial pens, palette, eraser, pressure curve, toolbar placement, laser color, pen-only input |
| `keyboard` | `false` | Keyboard shortcuts on the page (below) |
| `experimental` | all off | Features being worked on (below) |
| `laser` | own channel | The `LaserChannel` the laser pointer's lines go to and come from |
| `wasmUrl` | next to the script | Where to fetch the WebAssembly module |
| `workerUrl` | next to the script | Where to load the tessellation worker |
| `onExport` | downloads `strokes.geojson` | What Export in the selection's bar does with the selected strokes' GeoJSON; `null` hides Export |

A map made with `canvasContextAttributes: { desynchronized: true }` shows the tip of a stroke being drawn sooner,
where the browser supports it.

### Tools

`setTool(tool)` and `getTool()` take `'pen'`, `'highlighter'`, `'eraser'`, `'lasso'`, `'laser'` or `null`
(move the map). The lasso selects strokes; the selection's bar moves, scales, rotates, duplicates, deletes and
exports them.

### Pens and settings

- `setPen(tool, { color, opacity, width, pressure })` changes the pen or the highlighter. Colors are `#rrggbb`;
  numbers are clamped to their ranges. `getPen(tool)` returns it.
- `setPalette(colors)` replaces the 5 palette colors.
- `setEraser({ radius, mode })` changes the eraser. The mode `'partial'` needs `experimental.partialEraser`.
- `setToolbar({ edge, offset, collapsed })` is called by the toolbar when it is moved or collapsed.
- `setPenOnly(enabled)`: while on, touch moves the map and only a pen or a mouse draws.
- `getSettings()` returns all of these. To keep them, save the `settingschange` event's settings and pass them back
  as `defaults`, checked with `parseDefaults`:

```ts
let defaults
try {
  defaults = parseDefaults(JSON.parse(localStorage.getItem('handwriting') ?? 'null'))
} catch {
  defaults = undefined
}
const handwriting = createHandwriting(map, { store, defaults })
handwriting.on('settingschange', ({ settings }) => localStorage.setItem('handwriting', JSON.stringify(settings)))
```

`parseDefaults` throws a `TypeError` when the value is not an object and a `RangeError` for a field out of shape.

The defaults are: pen black, 4 px, with pressure; highlighter yellow, 50% opacity, 16 px; eraser 6 px, mode
`'stroke'`; toolbar at the bottom center; laser `#ff3b30`; pen-only input off.

### History, export and lifetime

- `undo()`, `redo()`, `canUndo()`, `canRedo()`; `clearHistory()` forgets the history, e.g. after a reconnect.
- `exportGeoJSON(ids?)` returns the given strokes, or the selected ones, as a GeoJSON FeatureCollection string in
  WGS84, in drawing order. `strokesToGeoJSON(strokes)` does the same for any strokes.
- `setKeyboard(enabled)`, `isKeyboardEnabled()`. The shortcuts listen on the window: with two handles on a page,
  turn them on for one only.
- `destroy()` removes the layer and every listener, and gives the map its gestures back.

### Events

`on(type, listener)` and `off(type, listener)`:

| Event | Payload |
| --- | --- |
| `history` | `{ canUndo, canRedo }` |
| `toolchange` | `{ tool }` |
| `penchange` | `{ tool, pen }` |
| `settingschange` | `{ settings }` |

### Keyboard shortcuts

With `keyboard: true`: H or 1 move map, P or 2 pen, M or 3 highlighter, E or 4 eraser, L or 5 lasso, K laser
pointer, Space held to move the map, Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z or Ctrl+Y redo, Delete or Backspace and
Cmd/Ctrl+D delete and duplicate the selection, Esc clears it, `[` and `]` change the pen's width or the eraser's
radius, `?` lists them. They are ignored while typing in a form field.

## HandwritingToolbar

A MapLibre control with the tools, the pens' color and width, the eraser, undo and redo:

```ts
map.addControl(new HandwritingToolbar(handwriting))
```

It can be dragged to any edge of the map and collapsed; where it sits is part of the settings.

## The store

`StrokeStore` holds the strokes. Every change is an op given to `store.apply(op, origin)`, where `origin` is
`'local'` (drawn here), `'remote'` (received from elsewhere) or `'preview'` (shown here only). `store.subscribe`
gets every op applied, `store.get(id)` and `store.values()` read the strokes.

Points are normalized Web Mercator coordinates, from 0 to 1. A stroke is drawn over the strokes with a lower
`order`. Who gives the order is the store's order mode:

- `new StrokeStore()` (mode `'default'`): the store gives each finished stroke the next order itself. Use it when
  the strokes stay on this page, or are saved and loaded by your code.
- `new StrokeStore({ order: 'custom' })`: the store gives no order; your code applies `order` ops, e.g. from a
  server that decides one order for all clients. A stroke without an order is drawn but cannot be selected,
  transformed, cut or exported.

To show saved strokes, apply a `load` op (adds strokes) or a `reset` op (replaces all of them):

```ts
store.apply({ type: 'load', strokes: savedStrokes }, 'remote')
```

To share drawing between clients, subscribe to the store, send the ops whose origin is `'local'`, and apply the
ops received with the origin `'remote'`. The laser pointer works the same way with `LaserChannel`
(`emit`, `subscribe`), given as the `laser` option.

## maplibre-gl-handwriting/core

The store, its op types, the laser channel, and the split and transform rules, with no DOM and no maplibre-gl, for
code that keeps or relays strokes away from the map, such as a server:

```ts
import { StrokeStore, type StrokeOp } from 'maplibre-gl-handwriting/core'
```

## Experimental features

The `experimental` option turns on features that are still being worked on. They are outside semantic versioning
and may change or be removed in any release.

- `partialEraser`: the eraser mode `'partial'`, which cuts strokes instead of removing them whole.
