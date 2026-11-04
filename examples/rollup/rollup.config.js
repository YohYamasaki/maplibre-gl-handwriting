// Rollup finds the packages with @rollup/plugin-node-resolve, and @web/rollup-plugin-import-meta-assets copies the
// files of `new URL('./…', import.meta.url)` into the build: the package's tessellation worker as it is, and its
// WebAssembly module, whose URL in the build the main thread sends the worker. MapLibre's worker, which no bundler
// finds, the stylesheets and the page are copied next to the bundle
import { readFileSync } from 'node:fs'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import { importMetaAssets } from '@web/rollup-plugin-import-meta-assets'

const COPIED = {
  'index.html': new URL('./index.html', import.meta.url),
  'maplibre-gl-worker.mjs': new URL(import.meta.resolve('maplibre-gl/dist/maplibre-gl-worker.mjs')),
  'maplibre-gl.css': new URL(import.meta.resolve('maplibre-gl/dist/maplibre-gl.css')),
  'style.css': new URL(import.meta.resolve('maplibre-gl-handwriting/style.css')),
}

function copyFiles() {
  return {
    name: 'copy-files',
    generateBundle() {
      for (const [fileName, from] of Object.entries(COPIED))
        this.emitFile({ type: 'asset', fileName, source: readFileSync(from) })
    },
  }
}

export default {
  input: 'main.js',
  output: { dir: 'dist', format: 'es' },
  plugins: [nodeResolve(), importMetaAssets(), copyFiles()],
}
