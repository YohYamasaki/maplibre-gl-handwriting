// The smallest use of the package, as in examples/basic: a map, a store, the layer and its toolbar
import { Map, MercatorCoordinate, setWorkerUrl } from 'maplibre-gl'
import { createHandwriting, HandwritingToolbar, StrokeStore } from 'maplibre-gl-handwriting'

// MapLibre makes its worker's URL at run time, so no bundler finds it: the build copies it next to the bundle
setWorkerUrl(new URL('maplibre-gl-worker.mjs', document.baseURI).href)
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

// What the browser check (tests/tools/e2e-bundlers.mjs) looks at: the map's errors, the layer's among them, and ready
const example = { map, store, errors: [], ready: null }
map.on('error', (e) => example.errors.push(String(e.error)))
const handwriting = createHandwriting(map, { store })
handwriting.ready.then(() => (example.ready = true), () => (example.ready = false))
handwriting.setTool('pen')
map.addControl(new HandwritingToolbar(handwriting))
window.example = example
