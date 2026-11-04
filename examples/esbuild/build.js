// esbuild leaves `new URL('./assets/…', import.meta.url)` as it is, so the package's assets (the tessellation worker
// and the WebAssembly module) are copied next to the bundle, where those URLs point. Elsewhere, pass workerUrl and
// wasmUrl instead. MapLibre's worker, which no bundler finds, the stylesheets and the page are copied too
import { cpSync, rmSync } from 'node:fs'
import { build } from 'esbuild'

const COPIED = {
  'index.html': new URL('./index.html', import.meta.url),
  'maplibre-gl-worker.mjs': new URL(import.meta.resolve('maplibre-gl/dist/maplibre-gl-worker.mjs')),
  'maplibre-gl.css': new URL(import.meta.resolve('maplibre-gl/dist/maplibre-gl.css')),
  'style.css': new URL(import.meta.resolve('maplibre-gl-handwriting/style.css')),
  // Next to the package's entry, dist/index.js
  assets: new URL('./assets', import.meta.resolve('maplibre-gl-handwriting')),
}

const out = new URL('./dist/', import.meta.url)
rmSync(out, { recursive: true, force: true })
await build({ entryPoints: ['main.js'], bundle: true, format: 'esm', outfile: 'dist/main.js' })
for (const [name, from] of Object.entries(COPIED)) cpSync(from, new URL(name, out), { recursive: true })
