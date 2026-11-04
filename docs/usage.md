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

The package starts its tessellation worker with
`new Worker(new URL('./assets/tessellation.worker.js', import.meta.url), { type: 'module' })` and fetches its
WebAssembly module from `new URL('./assets/handwriting_tessellator_bg.wasm', import.meta.url)`, the forms bundlers
look for. The main thread sends the worker the URL of the module it loads itself, so a worker copied without its
module still finds it.

- Vite and webpack 5 need nothing for the package: webpack bundles the worker and gives the module a URL in the
  build.
- Rollup: `@rollup/plugin-node-resolve` and `@web/rollup-plugin-import-meta-assets`, which copies the worker and the
  module into the build.
- esbuild leaves these URLs as they are: copy the package's `dist/assets` next to the bundle, or pass `workerUrl` and
  `wasmUrl`.

[examples/basic](../examples/basic) (Vite), [examples/webpack](../examples/webpack),
[examples/rollup](../examples/rollup) and [examples/esbuild](../examples/esbuild) are complete projects.

With Vite, also exclude the package from dependency pre-bundling:

```ts
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  optimizeDeps: { exclude: ['maplibre-gl-handwriting'] },
})
```

Without this, the dev server serves the package from its pre-bundle cache, where the worker and the module are not.
`vite build` does not need it.

MapLibre GL JS 6 makes its own worker's URL at run time, which no bundler finds, so give it with `setWorkerUrl`. Under
Vite:

```ts
import { setWorkerUrl } from 'maplibre-gl'
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

setWorkerUrl(mapLibreWorkerUrl)
```

With the other bundlers, copy `maplibre-gl/dist/maplibre-gl-worker.mjs` next to the bundle and pass its URL, as the
examples do.

When the assets are served from somewhere else, pass `wasmUrl` and `workerUrl` (below).

## createHandwriting(map, options)

Adds a layer that draws the strokes of `options.store` and turns pointer input on the map into edits of that store
with the selected tool. It returns a handle. The layer is added once the WebAssembly module is loaded and the
style has loaded, and, with `beforeId`, once the style has that layer; the layer starts its tessellation worker
then. `handle.ready` resolves once the module has loaded on the main thread and in that worker, so it also waits for
the style and the `beforeId` layer: an app that waits for `ready` before it adds the `beforeId` layer waits for good.
After a `setStyle` that rebuilds the style (`{ diff: false }`, or a style the diff cannot be applied to), the handle
adds its layer again on `style.load`.

```ts
const store = new StrokeStore()
const handwriting = createHandwriting(map, { store, author: 'alice', keyboard: true })
await handwriting.ready
handwriting.setTool('pen')
```

Options:

| Option         | Default                     | Meaning                                                                                                                                                                                     |
| -------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store`        | (required)                  | The `StrokeStore` to draw and edit. The handle loads nothing itself                                                                                                                         |
| `startStroke`  | random UUIDs                | Called on every pointerdown with a drawing tool; returns `{ id, author }` for the new stroke, or `null` to ignore the input. Also called for the ID of each piece the partial eraser leaves |
| `author`       |                             | Author of new strokes when `startStroke` is omitted                                                                                                                                         |
| `layerId`      | `'handwriting'`             | ID of the map layer                                                                                                                                                                         |
| `beforeId`     | on top                      | The layer is inserted before this layer. While the style has no such layer, the handle waits for it and does not put its layer on top                                                       |
| `defaults`     | see below                   | Initial pens, palette, eraser, pressure curve, toolbar placement, laser color, pen-only input                                                                                               |
| `keyboard`     | `false`                     | Keyboard shortcuts on the page (below)                                                                                                                                                      |
| `tools`        | all five                    | The tools the handle offers (below)                                                                                                                                                         |
| `experimental` | all off                     | Features being worked on (below)                                                                                                                                                            |
| `laser`        | own channel                 | The `LaserChannel` the laser pointer's lines go to and come from                                                                                                                            |
| `wasmUrl`      | next to the script          | Where to fetch the WebAssembly module                                                                                                                                                       |
| `workerUrl`    | next to the script          | Where to load the tessellation worker                                                                                                                                                       |
| `onExport`     | downloads `strokes.geojson` | What Export in the selection's bar does with the selected strokes' GeoJSON; `null` hides Export                                                                                             |

A map made with `canvasContextAttributes: { desynchronized: true }` shows the tip of a stroke being drawn sooner,
where the browser supports it.

### Tools

`setTool(tool)` and `getTool()` take `'pen'`, `'highlighter'`, `'eraser'`, `'lasso'`, `'laser'` or `null`
(move the map). The lasso selects strokes; the selection's bar moves, scales, rotates, duplicates, deletes and
exports them.

`tools` chooses which of them the handle offers, e.g. `tools: ['pen', 'eraser']`; it is fixed when the handle is
created. `setTool` throws a `RangeError` for a tool left out, the toolbar and the shortcut list leave it out, and its
keys do nothing (they are left to the page). Moving the map (`null`) is always there. The order changes nothing: the
toolbar's buttons and the keys 1 to 5 stay as with every tool. `getTools()` returns the tools offered.
`createHandwriting` throws a `RangeError` for an unknown tool.

### Load failures

When the WebAssembly module, the tessellation worker's script or the module in the worker fails to load, or the
worker cannot be made (a worker script of another origin, or a Content Security Policy that forbids it), the map
fires an `error` event `{ error, layerId }` with the layer's ID, and `ready` rejects with that error. With no `error`
listener on the map, the error goes to the console instead. The layer then draws nothing and makes no worker again,
also after the style is rebuilt. Once `ready` has resolved, a worker made after a rebuilt style that fails is only the
`error` event. The map's `error` events also come from its sources and tiles: tell the layer's apart by `layerId`.

```ts
map.on('error', ({ error, layerId }) => {
  if (layerId === 'handwriting') showMessage(`Drawing is not available: ${error.message}`)
})
```

After `destroy()`, nothing is reported, and a `ready` still waiting resolves.

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
- `destroy()` removes the layer and every listener, and gives the map its gestures back. It also frees the layer's
  worker and GPU resources after `map.remove()`, so call it then too.

### Events

`on(type, listener)` and `off(type, listener)`:

| Event            | Payload                |
| ---------------- | ---------------------- |
| `history`        | `{ canUndo, canRedo }` |
| `toolchange`     | `{ tool }`             |
| `penchange`      | `{ tool, pen }`        |
| `settingschange` | `{ settings }`         |

### Keyboard shortcuts

With `keyboard: true`: H or 1 move map, P or 2 pen, M or 3 highlighter, E or 4 eraser, L or 5 lasso, K laser
pointer, Space held to move the map, Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z or Ctrl+Y redo, Delete or Backspace and
Cmd/Ctrl+D delete and duplicate the selection, Esc clears it, `[` and `]` change the pen's width or the eraser's
radius, `?` lists them. They are ignored while typing in a form field. The keys of a tool left out of `tools` do
nothing; the others keep their keys.

## HandwritingToolbar

A MapLibre control with the handle's tools (`getTools()`) and moving the map, the pens' color and width, the eraser,
undo and redo:

```ts
map.addControl(new HandwritingToolbar(handwriting))
```

It does not sit in the corner `addControl` is given: it floats over the map along one of its edges, where the
settings' `toolbar` placement says. It can be dragged to any edge and collapsed; where it sits is part of the
settings. Remove it with `map.removeControl` before destroying the handle.

## HandwritingLayer

A custom layer that only draws the strokes of a store: no tools, no pointer input and no toolbar. Use it for a map
that shows strokes without editing them, or to place the strokes among the style's layers yourself:

```ts
import { HandwritingLayer, StrokeStore } from 'maplibre-gl-handwriting'

const store = new StrokeStore()
const strokes = new HandwritingLayer({ store, id: 'strokes' })
// Under the style's layer 'labels'; without a second argument, on top
map.on('load', () => map.addLayer(strokes, 'labels'))
store.apply({ type: 'load', strokes: savedStrokes }, 'remote')
```

Options: `store` (required), `id` (required: the layer's ID in the style, other than the `layerId` of a
handle on the same map, `'handwriting'` by default), `wasmUrl` and `workerUrl` (as for `createHandwriting`).

- The WebAssembly module starts loading when the layer is first added, and the layer starts its tessellation worker
  when it is added; nothing is drawn until the module has loaded, and then the map is repainted. `layer.ready`
  resolves once the module has loaded on the main thread and in the worker, and rejects when either fails to load or
  the worker cannot be made, which is also the map's `error` event with the layer's `id` as `layerId` (see
  [Load failures](#load-failures)); the layer then draws nothing. It does not resolve for a layer that is never
  added, and resolves on `destroy()` when it is still waiting.
- MapLibre does not call a custom layer's `onRemove` when `setStyle` rebuilds the style or when the map is removed.
  After such a `setStyle`, add the layer again yourself, e.g. on `style.load`. A style changed by a diff keeps it.
- `layer.destroy()` removes the layer from the map when it is there, and frees its worker and GPU resources also when
  it is not, e.g. after `map.remove()`. A destroyed layer draws nothing.
- A store given to both a `HandwritingLayer` and `createHandwriting` is drawn twice.

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
