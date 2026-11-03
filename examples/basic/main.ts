// The smallest use of the package: a map, a store, the layer and its toolbar. Install it with
// `npm install maplibre-gl maplibre-gl-handwriting` (see the README)
import 'maplibre-gl/dist/maplibre-gl.css'
import 'maplibre-gl-handwriting/style.css'
import { Map, setWorkerUrl } from 'maplibre-gl'
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
const handwriting = createHandwriting(map, { store })
handwriting.setTool('pen')
map.addControl(new HandwritingToolbar(handwriting))

// For the browser check (tests/tools/e2e-example.mjs)
;(window as unknown as { example: unknown }).example = { map, store }
