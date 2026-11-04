import { readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

/** The `new URL(<literal>, import.meta.url)` that load the WebAssembly module, by the file that has it */
const WASM_URLS: Record<string, string> = {
  '/tessellator/pkg/handwriting_tessellator.js': "new URL('handwriting_tessellator_bg.wasm', import.meta.url)",
  '/src/StrokeTessellator.ts': "new URL('../tessellator/pkg/handwriting_tessellator_bg.wasm', import.meta.url)",
}

/**
 * Library mode inlines every `new URL(file, import.meta.url)` asset as base64. The WebAssembly module is meant to be
 * a file of its own (fetched and compiled by streaming, and replaceable with the wasmUrl option), so its URLs, in the
 * generated bindings and in StrokeTessellator.ts, are marked `?no-inline` for this build only
 */
function keepWasmAFile(): Plugin {
  return {
    name: 'keep-wasm-a-file',
    enforce: 'pre',
    apply: 'build',
    transform(code, id) {
      const file = Object.keys(WASM_URLS).find((suffix) => id.endsWith(suffix))
      if (!file) return null
      const url = WASM_URLS[file]
      const marked = code.replace(url, url.replace(".wasm'", ".wasm?no-inline'"))
      if (marked === code) this.error(`the WebAssembly URL in ${file} has changed; update keepWasmAFile`)
      return { code: marked, map: null }
    },
  }
}

// What Vite writes for an asset of a library with a relative base: `new URL(new URL("assets/x", import.meta.url).href,
// "" + import.meta.url)`, the inner one maybe after a /* @vite-ignore */, with any of the three quotes
const VITE_ASSET_URL =
  /new URL\(\s*(?:\/\*\s*@vite-ignore\s*\*\/\s*)?new URL\(\s*(["'`])([^"'`]+)\1\s*,\s*import\.meta\.url\s*\)\.href\s*,\s*(["'`])\3\s*\+\s*import\.meta\.url\s*\)/g
// The generic form: a browser resolves it against the module's own URL, and tools that handle
// new URL('<relative path>', import.meta.url) find the file
const GENERIC_ASSET_URL = /new URL\("(\.\.?\/[^"]+)", import\.meta\.url\)/g

/**
 * Rewrites the asset URLs Vite writes into the generic form, `new URL("./<relative path>", import.meta.url)`, in
 * every JavaScript file of the build, the worker's included. The build fails when import.meta.url is anywhere else
 * than in that form, or when a path does not point at a file of the build
 */
function genericAssetUrls(): Plugin {
  return {
    name: 'generic-asset-urls',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (!file.fileName.endsWith('.js')) continue
        const code = file.type === 'chunk' ? file.code : String(file.source)
        const rewritten = code.replace(
          VITE_ASSET_URL,
          (_url, _quote, path: string) =>
            `new URL("${path.startsWith('./') || path.startsWith('../') ? path : `./${path}`}", import.meta.url)`,
        )
        const all = rewritten.split('import.meta.url').length - 1
        const generic = [...rewritten.matchAll(GENERIC_ASSET_URL)]
        if (generic.length !== all) {
          this.error(
            `${file.fileName}: import.meta.url is used ${all - generic.length} times outside new URL("./<path>", import.meta.url); update genericAssetUrls`,
          )
        }
        for (const [, path] of generic) {
          const target = posix.normalize(posix.join(posix.dirname(file.fileName), path))
          if (!(target in bundle))
            this.error(
              `${file.fileName}: new URL("${path}", import.meta.url) points at ${target}, which is not in the build`,
            )
        }
        if (file.type === 'chunk') file.code = rewritten
        else file.source = rewritten
      }
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
// tessellation worker (assets/tessellation.worker.js) and the WebAssembly module as files next to it, found through
// new URL("./<path>", import.meta.url) (genericAssetUrls). HANDWRITING_DEBUG=1 builds it with the debug
// code in, for the pack check only (decision 0096). The .d.ts files come from tsconfig.build.json (npm run build)
export default defineConfig(({ command }) => {
  const debug = command === 'serve' || process.env.HANDWRITING_DEBUG === '1'
  // HANDWRITING_OUT_DIR puts that build elsewhere (an absolute path, or relative to this directory)
  const outDir = resolve(fileURLToPath(new URL('.', import.meta.url)), process.env.HANDWRITING_OUT_DIR ?? 'dist')
  return {
    plugins: [keepWasmAFile(), emitToolbarStyles(), genericAssetUrls()],
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
      // Unhashed, as the WebAssembly module: a bundler that copies the files finds the same names in every version
      rollupOptions: { output: { entryFileNames: 'assets/[name].js', assetFileNames: 'assets/[name][extname]' } },
    },
  }
})
