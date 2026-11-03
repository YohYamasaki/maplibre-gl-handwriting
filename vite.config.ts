import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

/**
 * Library mode inlines every `new URL(file, import.meta.url)` asset as base64. The WebAssembly module is meant to be
 * a file of its own (fetched and compiled by streaming, and replaceable with the wasmUrl option), so the URL in the
 * generated bindings is marked `?no-inline` for this build only
 */
function keepWasmAFile(): Plugin {
  return {
    name: 'keep-wasm-a-file',
    enforce: 'pre',
    apply: 'build',
    transform(code, id) {
      if (!id.endsWith('/tessellator/pkg/handwriting_tessellator.js')) return null
      const marked = code.replace("new URL('handwriting_tessellator_bg.wasm', import.meta.url)", "new URL('handwriting_tessellator_bg.wasm?no-inline', import.meta.url)")
      if (marked === code) this.error('the WebAssembly URL in the generated bindings has changed; update keepWasmAFile')
      return { code: marked, map: null }
    },
  }
}

/**
 * The toolbar's stylesheet, copied as is to dist/style.css (the package's ./style.css export). The code does not
 * import it, so the user loads it like maplibre-gl.css, and the declarations do not point at a file not shipped
 */
function emitToolbarStyles(): Plugin {
  const source = fileURLToPath(new URL('./src/ui/toolbar.css', import.meta.url))
  return {
    name: 'emit-toolbar-styles',
    apply: 'build',
    buildStart() {
      this.addWatchFile(source)
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'style.css', source: readFileSync(source, 'utf8') })
    },
  }
}

// `vite` serves the dev page (dev/) from the source with the debug code in; `vite build` is the package: ESM with
// src/core bundled in and also its own entry (./core), maplibre-gl left to the user as a peer dependency, the
// tessellation worker and the WebAssembly module as files next to it. HANDWRITING_DEBUG=1 builds it with the debug
// code in, for the pack check only (decision 0096). The .d.ts files come from tsconfig.build.json (npm run build)
export default defineConfig(({ command }) => {
  const debug = command === 'serve' || process.env.HANDWRITING_DEBUG === '1'
  // HANDWRITING_OUT_DIR puts that build elsewhere (an absolute path, or relative to this directory)
  const outDir = resolve(fileURLToPath(new URL('.', import.meta.url)), process.env.HANDWRITING_OUT_DIR ?? 'dist')
  return {
    plugins: [keepWasmAFile(), emitToolbarStyles()],
    define: { __HANDWRITING_DEBUG__: JSON.stringify(debug) },
    root: command === 'serve' ? fileURLToPath(new URL('./dev', import.meta.url)) : undefined,
    publicDir: false,
    // Asset URLs relative to the importing module, so the files are found wherever the package is installed
    base: './',
    server: { fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] } },
    build: {
      outDir,
      emptyOutDir: true,
      lib: {
        entry: {
          index: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
          core: fileURLToPath(new URL('./src/core/index.ts', import.meta.url)),
        },
        formats: ['es'],
        fileName: (_format, name) => `${name}.js`,
      },
      rollupOptions: {
        external: ['maplibre-gl'],
        // The main thread and the worker load the same module: one unhashed file serves both
        output: { assetFileNames: 'assets/[name][extname]', chunkFileNames: 'chunks/[name]-[hash].js' },
      },
    },
    worker: {
      format: 'es',
      plugins: () => [keepWasmAFile()],
      rollupOptions: { output: { assetFileNames: 'assets/[name][extname]' } },
    },
  }
})
