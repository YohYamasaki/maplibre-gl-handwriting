// The smallest use of the package: a map, a store, the layer and its toolbar. Install it with
// `npm install maplibre-gl maplibre-gl-handwriting` (see the README)
import 'maplibre-gl/dist/maplibre-gl.css'
import 'maplibre-gl-handwriting/style.css'
import { Map, MercatorCoordinate, setWorkerUrl } from 'maplibre-gl'
// MapLibre's own worker, bundled by Vite
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { createHandwriting, HandwritingToolbar, StrokeStore } from 'maplibre-gl-handwriting'

setWorkerUrl(mapLibreWorkerUrl)
const map = new Map({
  container: 'map',
  style: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f2f2f2' } }] },
  center: [141.3545, 43.0618],
  zoom: 12,
})

// The store holds the strokes; without a server, it gives each finished stroke its drawing order
const store = new StrokeStore()
// A saved stroke comes back with a load op, and is tessellated on the layer's worker
const line = Array.from({ length: 11 }, (_, i) => MercatorCoordinate.fromLngLat([141.32 + 0.007 * i, 43.07]))
store.apply({
  type: 'load',
  strokes: [{ id: 'loaded', author: 'example', color: '#0000ff', width: 6, zoom: 12, points: line.map(({ x, y }) => [x, y]) }],
}, 'remote')

// What the browser check (tests/tools/e2e-example.mjs) looks at: the map's errors, the layer's among them, and ready
const example = { map, store, errors: [] as string[], ready: null as boolean | null }
map.on('error', (e) => example.errors.push(String(e.error)))
const handwriting = createHandwriting(map, { store })
handwriting.ready.then(() => (example.ready = true), () => (example.ready = false))
handwriting.setTool('pen')
map.addControl(new HandwritingToolbar(handwriting))
;(window as unknown as { example: unknown }).example = example
