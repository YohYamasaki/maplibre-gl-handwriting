// The development page (decision 0096): the layer from the source, with the debug code in (__HANDWRITING_DEBUG__ is
// true under `vite`), and no server. The default store gives the strokes their order (decision 0091). The panel has
// the wireframe, the predicted points, the scene's stats, the load test strokes, the Canvas2D comparison and the frame
// times; window.__handwriting is what the browser checks (tests/tools/e2e-dev.mjs) look at
import 'maplibre-gl/dist/maplibre-gl.css'
import '../src/ui/toolbar.css'
import { Map as MapLibreMap, NavigationControl, setWorkerUrl, type StyleSpecification } from 'maplibre-gl'
// MapLibre finds its worker next to its own module, which Vite's pre-bundling moves: give it the worker's URL
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { debugPredictionCounts, debugSceneOf, setDebugPredictionMs } from '../src/debug'
import {
  createHandwriting,
  HandwritingLayer,
  HandwritingToolbar,
  LaserChannel,
  StrokeStore,
  type Tool,
} from '../src/index'
import { mountPanel } from './panel'

setWorkerUrl(mapLibreWorkerUrl)
// A plain background: the style under ?blank, for checks that compare pixels against it, and the one the page falls
// back to when the map's style cannot be loaded
const backgroundStyle: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f2f2f2' } }],
}
const blank = new URLSearchParams(location.search).has('blank')
const map = new MapLibreMap({
  container: 'map',
  // OpenFreeMap's Positron (decision 0017): OpenStreetMap vector tiles, no API key needed. Its sources carry their
  // attribution, which MapLibre shows; the tiles go up to zoom 14
  style: blank ? backgroundStyle : 'https://tiles.openfreemap.org/styles/positron',
  center: [141.3545, 43.0618],
  zoom: 12,
  minZoom: 2,
  canvasContextAttributes: { antialias: true, desynchronized: true },
})
if (!blank) {
  // The style not loaded, there is no style.load, and the handle adds no layer: an error before style.load puts the
  // plain background in its place, so the page still draws. Failures after style.load (tiles) only leave the map short
  const onError = (event: { error?: unknown }): void => {
    stopListening()
    console.warn('The map style could not be loaded; drawing on a plain background', event.error)
    map.setStyle(backgroundStyle, { diff: false })
  }
  const stopListening = (): void => {
    map.off('error', onError)
    map.off('style.load', stopListening)
  }
  map.on('error', onError)
  map.on('style.load', stopListening)
}
map.addControl(new NavigationControl())

const store = new StrokeStore()
const laser = new LaserChannel()
const partialEraser = new URLSearchParams(location.search).has('partialEraser')
// ?overlay: the page adds a layer of its own, 'overlay', on every style.load, as an app that adds its layers again
// after setStyle does, and the handle goes before it (beforeId). window.__handwriting.addOverlay = false stops that
const overlay = new URLSearchParams(location.search).has('overlay')
// ?tools=pen,eraser: the handle offers only these tools (HandwritingOptions.tools)
const tools = new URLSearchParams(location.search).get('tools')?.split(',') as NonNullable<Tool>[] | undefined
const handle = createHandwriting(map, {
  store,
  laser,
  author: 'dev',
  experimental: { partialEraser },
  beforeId: overlay ? 'overlay' : undefined,
  tools,
})
if (handle.getTools().includes('pen')) handle.setTool('pen')
handle.setKeyboard(true)
map.addControl(new HandwritingToolbar(handle))
mountPanel(document.body, handle, map, store)

const debug = {
  store,
  laser,
  map,
  handle,
  // The draw-only layer, for the checks that add one with a store of their own
  HandwritingLayer,
  addOverlay: overlay,
  scene: () => debugSceneOf(handle),
  // How far ahead the predicted points are drawn, in ms; 0 draws none (decision 0021)
  setPredictionMs: (ms: number): void => setDebugPredictionMs(handle, ms),
  // The predicted points offered, kept and dropped by time and by distance, and the time ahead of the latest ones, to
  // tune the time ahead on a real pen (decisions 0020, 0021)
  predictionCounts: () => debugPredictionCounts(handle),
}
;(window as unknown as { __handwriting?: unknown }).__handwriting = debug
if (overlay) {
  // Listens after the handle, which so finds no overlay on style.load and waits for it (styledata)
  map.on('style.load', () => {
    if (!debug.addOverlay || map.getLayer('overlay')) return
    map.addLayer({
      id: 'overlay',
      type: 'background',
      paint: { 'background-color': '#000000', 'background-opacity': 0 },
    })
  })
}
