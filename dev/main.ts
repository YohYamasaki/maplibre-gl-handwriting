// The development page (decision 0096): the layer from the source, with the debug code in (__HANDWRITING_DEBUG__ is
// true under `vite`), and no server. The default store gives the strokes their order (decision 0091). The panel has
// the wireframe, the predicted points, the scene's stats, the load test strokes, the Canvas2D comparison and the frame
// times; window.__handwriting is what the browser checks (tests/tools/e2e-dev.mjs) look at
import 'maplibre-gl/dist/maplibre-gl.css'
import '../src/ui/toolbar.css'
import { Map as MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl'
// MapLibre finds its worker next to its own module, which Vite's pre-bundling moves: give it the worker's URL
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { debugPredictionCounts, debugSceneOf, setDebugPrediction } from '../src/debug'
import { createHandwriting, HandwritingToolbar, LaserChannel, StrokeStore } from '../src/index'
import { mountPanel } from './panel'

setWorkerUrl(mapLibreWorkerUrl)
const map = new MapLibreMap({
  container: 'map',
  // GSI pale raster tiles: no API key needed, attribution required. Tiles exist from zoom 2 to 18
  style: {
    version: 8,
    sources: {
      gsi: {
        type: 'raster',
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
        tileSize: 256,
        minzoom: 2,
        maxzoom: 18,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>',
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#f2f2f2' } },
      // ?blank leaves the tiles out, for checks that compare pixels against a plain background
      ...(new URLSearchParams(location.search).has('blank') ? [] : [{ id: 'gsi', type: 'raster' as const, source: 'gsi' }]),
    ],
  },
  center: [141.3545, 43.0618],
  zoom: 12,
  minZoom: 2,
  canvasContextAttributes: { antialias: true, desynchronized: true },
})
map.addControl(new NavigationControl())

const store = new StrokeStore()
const laser = new LaserChannel()
const partialEraser = new URLSearchParams(location.search).has('partialEraser')
const handle = createHandwriting(map, { store, laser, author: 'dev', experimental: { partialEraser } })
handle.setTool('pen')
handle.setKeyboard(true)
map.addControl(new HandwritingToolbar(handle))
mountPanel(document.body, handle, map, store)

;(window as unknown as { __handwriting?: unknown }).__handwriting = {
  store,
  laser,
  map,
  handle,
  scene: () => debugSceneOf(handle),
  setPrediction: (enabled: boolean): void => setDebugPrediction(handle, enabled),
  // Kept and dropped counts of the 1st and 2nd predicted points, to check the limit on a real pen (decision 0080)
  predictionCounts: () => debugPredictionCounts(handle),
}
