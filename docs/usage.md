# Using maplibre-gl-handwriting

What the package does, task by task. Each name links to the [API reference](api.md), which has every option, function
and type.

## Setup

```sh
npm install maplibre-gl maplibre-gl-handwriting
```

Load the package's `dist/style.css` (exported as `maplibre-gl-handwriting/style.css`), the toolbar's styles, the same
way as `maplibre-gl/dist/maplibre-gl.css`.

The package starts its tessellation worker from `dist/assets/tessellation.worker.js` and fetches its WebAssembly
module from `dist/assets/handwriting_tessellator_bg.wasm`, found with `new URL('./assets/…', import.meta.url)` next to
its own script. When those files are served from somewhere else, copy `dist/assets` (and `dist/style.css`) there and
pass their URLs:

```js
const handwriting = createHandwriting(map, {
  store,
  workerUrl: '/static/handwriting/tessellation.worker.js',
  wasmUrl: '/static/handwriting/handwriting_tessellator_bg.wasm',
})
```

The worker must come from the page's origin: a browser starts no worker script from another one.
[`HandwritingLayer`](api.md#handwritinglayer) takes the same two options. MapLibre loads its own worker in a similar
way; where it cannot, give its URL with MapLibre's
[`setWorkerUrl`](https://maplibre.org/maplibre-gl-js/docs/API/functions/setWorkerUrl/).

## Drawing

[`createHandwriting`](api.md#createhandwriting) adds a layer that draws the strokes of a store, and turns pointer input
on the map into strokes with the selected tool: `'pen'`, `'highlighter'`, `'eraser'`, `'lasso'`, `'laser'`, or `null`
to move the map. The lasso selects strokes; the selection's bar moves, scales, rotates, duplicates, deletes and exports
them. `tools` chooses the tools offered, and `keyboard: true` turns on the shortcuts
([`HandwritingOptions`](api.md#handwritingoptions)). [`HandwritingToolbar`](api.md#handwritingtoolbar) is a control
with the handle's tools, the pens and undo and redo:

```js
import { createHandwriting, HandwritingToolbar, StrokeStore } from 'maplibre-gl-handwriting'

const store = new StrokeStore()
const handwriting = createHandwriting(map, { store, tools: ['pen', 'eraser', 'lasso'], keyboard: true })
handwriting.setTool('pen')
map.addControl(new HandwritingToolbar(handwriting))
```

The toolbar floats along an edge of the map, where its settings say, not in the corner given to `addControl`.

`handwriting.ready` resolves once the WebAssembly module has loaded on the main thread and in the layer's worker. The
layer, and its worker, are added once the style has loaded and, with `beforeId`, once the style has that layer, so
`ready` waits for the `beforeId` layer too: an app that waits for `ready` before it adds that layer waits for good.

## Saving and sharing strokes

The strokes are those of your [`StrokeStore`](api.md#strokestore). Every change is an op given to
`store.apply(op, origin)`, and `store.subscribe` gets each op applied with its origin: `'local'` for strokes drawn
here, `'remote'` for ops received from elsewhere. Points are in normalized Web Mercator coordinates, kept as a
`Float64Array` of x and y in turn (`x0, y0, x1, y1, …`), and the width coefficients of a stroke drawn with pressure as
a `Float32Array`; the store does not take other arrays. `JSON.stringify` writes a typed array as an object, so an app
that sends or saves strokes as JSON turns the points and coefficients of the ops that carry them into arrays of numbers
and back, op by op. To show saved strokes, apply a `load` op; to share drawing, send the local ops and apply the ones
received as remote:

```js
// The points and width coefficients of a stroke op, given to `points` and `coefficients`; other messages as they are
function convertOp(op, points, coefficients) {
  const stroke = (s) => ({ ...s, points: points(s.points), ...(s.pressure && { pressure: coefficients(s.pressure) }) })
  switch (op.type) {
    case 'points':
      return { ...op, pts: points(op.pts), ...(op.ps && { ps: coefficients(op.ps) }) }
    case 'load':
    case 'reset':
    case 'replace':
      return { ...op, strokes: op.strokes.map(stroke) }
    case 'restore':
      return { ...op, stroke: stroke(op.stroke) }
    default:
      return op
  }
}
const plain = (a) => Array.from(a)
const float64 = (a) => new Float64Array(a)
const float32 = (a) => new Float32Array(a)
const toJSON = (op) => JSON.stringify(convertOp(op, plain, plain))
const fromJSON = (text) => convertOp(JSON.parse(text), float64, float32)

// Strokes saved as toJSON({ type: 'load', strokes: [...store.values()] })
store.apply(fromJSON(saved), 'remote')

const socket = new WebSocket('wss://example.com/strokes')
store.subscribe((op, origin) => {
  if (origin === 'local') socket.send(toJSON(op))
})
socket.addEventListener('message', ({ data }) => store.apply(fromJSON(data), 'remote'))
```

`new StrokeStore()` gives each finished stroke its place in the drawing order. When several clients draw together, use
`new StrokeStore({ order: 'custom' })` and have a server send `order` ops, so that every client draws the strokes in
the same order ([`StrokeOrderMode`](api.md#strokeordermode)). The laser pointer is shared the same way through a
[`LaserChannel`](api.md#laserchannel), given as the `laser` option. `handwriting.exportGeoJSON()` and
[`strokesToGeoJSON`](api.md#strokestogeojson) give strokes as GeoJSON.

## Settings

The pens, the palette, the eraser, the toolbar's place and pen-only input change with `setPen`, `setPalette`,
`setEraser`, `setToolbar` and `setPenOnly` ([`Handwriting`](api.md#handwriting)). To keep them, save the settings of
the `settingschange` event and pass them back as `defaults`, checked with [`parseDefaults`](api.md#parsedefaults):

```js
let defaults
try {
  defaults = parseDefaults(JSON.parse(localStorage.getItem('handwriting') ?? 'null'))
} catch {
  defaults = undefined
}
const handwriting = createHandwriting(map, { store, defaults })
handwriting.on('settingschange', ({ settings }) => localStorage.setItem('handwriting', JSON.stringify(settings)))
```

## Showing strokes only

[`HandwritingLayer`](api.md#handwritinglayer) only draws the strokes of a store: no tools, no pointer input and no
toolbar. Add it yourself, anywhere among the style's layers:

```js
import { HandwritingLayer, StrokeStore } from 'maplibre-gl-handwriting'

const store = new StrokeStore()
const strokes = new HandwritingLayer({ store, id: 'strokes' })
// Under the style's layer 'labels'; without a second argument, on top
map.on('load', () => map.addLayer(strokes, 'labels'))
```

After a `setStyle` that rebuilds the style, add it again; `createHandwriting` adds its own layer again by itself. A
store given to both a `HandwritingLayer` and `createHandwriting` is drawn twice.

## Errors and cleanup

When the WebAssembly module or the worker fails to load, or the worker cannot be made, `ready` rejects and the map fires
an `error` event with the layer's ID as `layerId` (on the console when nothing listens for it). The layer then draws
nothing. The map's other errors, from its sources and tiles, have no such `layerId`:

```js
map.on('error', ({ error, layerId }) => {
  if (layerId === 'handwriting') showMessage(`Drawing is not available: ${error.message}`)
})
```

`handwriting.destroy()` and `layer.destroy()` remove the layer and free its worker and GPU resources. Call them also
after `map.remove()`, which does not free them. Remove the toolbar with `map.removeControl` before destroying the
handle.

## maplibre-gl-handwriting/core

The store, its ops, the laser channel, and the split and transform rules, with no DOM and no maplibre-gl, for code
that keeps or relays strokes away from the map, such as a server ([API](api.md#maplibre-gl-handwritingcore)):

```js
import { StrokeStore } from 'maplibre-gl-handwriting/core'
```

## Experimental

The `experimental` option turns on features still being worked on and sets values still being tuned, which are
outside semantic versioning and may change or go in any release ([`ExperimentalFeatures`](api.md#experimentalfeatures)):

- `partialEraser` gives the eraser the mode `'partial'`, which cuts strokes instead of removing them whole.
- `predictionMs` is how far ahead of each pointer input, in ms, the points the browser predicts are drawn after the tip
  of the stroke being drawn: 20 by default, 0 for none, at most 25. They are drawn only, never kept or sent.
