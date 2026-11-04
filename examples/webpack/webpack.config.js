// webpack bundles the package's tessellation worker, `new Worker(new URL('./assets/…', import.meta.url))`, and gives
// its WebAssembly module, `new URL('./assets/….wasm', import.meta.url)`, a URL of the build: no setting is needed for
// them. MapLibre's worker, which no bundler finds, the stylesheets and the page are copied next to the bundle
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const COPIED = {
  'index.html': new URL('./index.html', import.meta.url),
  'maplibre-gl-worker.mjs': new URL(import.meta.resolve('maplibre-gl/dist/maplibre-gl-worker.mjs')),
  'maplibre-gl.css': new URL(import.meta.resolve('maplibre-gl/dist/maplibre-gl.css')),
  'style.css': new URL(import.meta.resolve('maplibre-gl-handwriting/style.css')),
}

class CopyFiles {
  apply(compiler) {
    const { Compilation, sources } = compiler.webpack
    compiler.hooks.thisCompilation.tap('CopyFiles', (compilation) => {
      compilation.hooks.processAssets.tap({ name: 'CopyFiles', stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL }, () => {
        for (const [name, from] of Object.entries(COPIED)) compilation.emitAsset(name, new sources.RawSource(readFileSync(from)))
      })
    })
  }
}

export default {
  mode: 'production',
  entry: './main.js',
  output: { path: fileURLToPath(new URL('./dist', import.meta.url)), clean: true },
  // MapLibre alone is larger than webpack's hint
  performance: { hints: false },
  plugins: [new CopyFiles()],
}
